package main

// Special services: a SIRI vehicle whose LineRef is not one of Mataró's
// regular lines L1-L8 (the "Bus Focs" lines 10, 11 and 12 on the night of the
// Castell de Focs of Les Santes, for example).
//
// Such a bus is a real GPS vehicle with no timetable in the repository, so it
// is exposed and nothing else: no schedule matching, no delay, no stop
// arrivals, no GPS-gap or stop-visit records, no vehicle_snapshots rows, and
// it is not counted when judging whether the regular fleet is missing. It is
// flagged `isSpecialService: true` (additive field); clients label it
// "Servei especial".

import (
	"log"
	"regexp"
	"strings"
)

var reSpecialNumeric = regexp.MustCompile(`^[0-9]{1,3}$`)

// specialServiceLineCode is the fleet line code ("L10") for a SIRI LineRef
// that is not a regular Mataró line, or "" when the vehicle must not be
// shown as a special service: no LineRef at all, a regular line in any of its
// spellings ("3", "L3", "mataro_3"), or a value that is not a short plain
// code.
func specialServiceLineCode(lineRef string) string {
	clean := strings.ToLower(jsTrim(lineRef))
	if clean == "" {
		return ""
	}
	if _, ok := mataroAgency.matchLine(clean); ok {
		return ""
	}
	clean = strings.TrimPrefix(clean, "l")
	if !reSpecialNumeric.MatchString(clean) {
		return ""
	}
	return "L" + clean
}

// isSpecialServiceVehicle reports the flag on a fleet or tracker vehicle.
func isSpecialServiceVehicle(v any) bool {
	o, _ := v.(*Obj)
	return o != nil && truthy(o.Get("isSpecialService"))
}

// pollSpecialServiceVehicles asks SIRI for the vehicles of every line (empty
// LineRef) and keeps the ones that belong to no regular line.
func (d *IngestionDaemon) pollSpecialServiceVehicles() {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[IngestionDaemon] special service poll error: %v", r)
		}
	}()
	list, err := d.w.siri.getLiveVehicles("")
	if d.stopping || err != nil || list == nil {
		return
	}
	for _, raw := range *list {
		if v, _ := raw.(*Obj); v != nil {
			d.ingestSpecialServiceVehicle(v)
		}
	}
}

// ingestSpecialServiceVehicle puts one SIRI vehicle of a special line in the
// flight recorder (memory only; the recorder does not persist these).
func (d *IngestionDaemon) ingestSpecialServiceVehicle(v *Obj) {
	code := specialServiceLineCode(v.Str("lineId"))
	if code == "" {
		return
	}
	vehID := v.Str("vehicleId")
	if vehID == "" || vehID == "Bus" {
		vehID = "special_" + code + "_bus"
	}
	var observedAt any
	if fr := v.ObjAt("freshness"); fr != nil {
		if n, ok := fr.Get("observedAt").(float64); ok && n > 0 {
			observedAt = n
		}
	}
	var speed any
	if truthy(v.Get("hasSpeed")) {
		speed = v.Get("speedKmh")
	}
	d.w.fr.ingestVehicle(O(
		"vehicleId", vehID,
		"lineId", code[1:],
		"lineCode", code,
		"agency", "Mataró Bus (Avanza)",
		"plateNumber", "",
		"lat", v.Get("lat"),
		"lon", v.Get("lon"),
		"latitude", v.Get("lat"),
		"longitude", v.Get("lon"),
		"speedKmh", speed,
		"hasSpeed", speed != nil,
		"bearing", or(v.Get("bearing"), 0.0),
		"delayMins", nil,
		"hasDelay", false,
		"destination", or(v.Get("destination"), ""),
		"isRealTime", true,
		"isEstimated", false,
		"observedAt", observedAt,
		"serviceableMs", 90.0*1000,
		"isSpecialService", true,
	))
}

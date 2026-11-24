package main

// Indicative ticket prices for planner itineraries (plan steps 4.2 & 4.3).
// The table is src/data/fares.json, imported from the ATM Area de Barcelona
// GTFS-Fares v2 feed (CGIM / NAP 2059) by scripts/import_atm_fares.js, plus
// the non-GTFS override layer (Mataró Bus own tickets, Aerobús, Airport Metro,
// and non-integrated route exclusions such as Cremallera de Núria).
// A price is given only where the data supports it: a journey whose zones or
// integration status are not known gets "fare": null, never a guess.

import (
	"encoding/json"
	"log"
	"math"
	"os"
	"strings"
)

type fareTable struct {
	ValidFrom string   `json:"validFrom"`
	Currency  string   `json:"currency"`
	Sources   []string `json:"sources"`
	ATM       struct {
		Single       []float64 `json:"single"`
		TCasual      []float64 `json:"tCasual"`
		TCasualTrips float64   `json:"tCasualTrips"`
		TUsual       []float64 `json:"tUsual"`
		TJove        float64   `json:"tJove"`
		Transfer     struct {
			WindowSeconds []float64 `json:"windowSeconds"`
		} `json:"transfer"`
	} `json:"atm"`
	MataroBus struct {
		Zone                  int     `json:"zone"`
		Sector                string  `json:"sector"`
		Single                float64 `json:"single"`
		SingleTransferSeconds float64 `json:"singleTransferSeconds"`
		T10                   float64 `json:"t10"`
		T10Trips              float64 `json:"t10Trips"`
	} `json:"mataroBus"`
	Overrides struct {
		Aerobus struct {
			Routes []string `json:"routes"`
			Single float64  `json:"single"`
			Return float64  `json:"return"`
			Note   string   `json:"note"`
		} `json:"aerobus"`
		AirportMetro struct {
			Lines     []string `json:"lines"`
			StopIDs   []string `json:"stopIds"`
			StopNames []string `json:"stopNames"`
			Single    float64  `json:"single"`
			Note      string   `json:"note"`
		} `json:"airportMetro"`
		NonIntegratedRoutes map[string][]string `json:"nonIntegratedRoutes"`
		STIRoutes           map[string][]string `json:"stiRoutes"`
	} `json:"overrides"`
	SectorZones       map[string]map[string]int `json:"sectorZones"`
	BoundaryPairs     [][2]string               `json:"boundaryPairs"`
	BoundaryNamePairs [][2]string               `json:"boundaryNamePairs"`
	StopSectors       map[string]string         `json:"stopSectors"`
	Stations          map[string]string         `json:"stations"`

	// Derived lookup maps populated in readFareTable.
	boundaryStopSet  map[string]bool
	boundaryNameSet  map[string]bool
	nonIntegratedSet map[string]bool // "agency:LINE" (uppercased line)
	aerobusRouteSet  map[string]bool
	airportStopIDs   map[string]bool
	airportStopNames map[string]bool
}

// fares is set once at start-up (or by a test) and only read afterwards.
var fares *fareTable

func loadFares(path string) {
	t, err := readFareTable(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("[Fares] Could not load fares.json: %v", err)
		}
		return
	}
	fares = t
}

func farePairKey(a, b string) string {
	if a < b {
		return a + "|" + b
	}
	return b + "|" + a
}

func readFareTable(path string) (*fareTable, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	t := &fareTable{}
	if err := json.Unmarshal(b, t); err != nil {
		return nil, err
	}
	if len(t.ATM.Single) != 7 || len(t.ATM.TCasual) != 7 || len(t.ATM.Transfer.WindowSeconds) != 7 {
		return nil, os.ErrInvalid
	}
	t.boundaryStopSet = make(map[string]bool, len(t.BoundaryPairs))
	for _, p := range t.BoundaryPairs {
		if p[0] != "" && p[1] != "" {
			t.boundaryStopSet[farePairKey(p[0], p[1])] = true
		}
	}
	t.boundaryNameSet = make(map[string]bool, len(t.BoundaryNamePairs))
	for _, p := range t.BoundaryNamePairs {
		if p[0] != "" && p[1] != "" {
			t.boundaryNameSet[farePairKey(p[0], p[1])] = true
		}
	}
	t.nonIntegratedSet = make(map[string]bool)
	for ag, lines := range t.Overrides.NonIntegratedRoutes {
		ag = strings.ToLower(strings.TrimSpace(ag))
		for _, l := range lines {
			t.nonIntegratedSet[ag+":"+strings.ToUpper(strings.TrimSpace(l))] = true
		}
	}
	t.aerobusRouteSet = make(map[string]bool, len(t.Overrides.Aerobus.Routes))
	for _, r := range t.Overrides.Aerobus.Routes {
		t.aerobusRouteSet[strings.ToUpper(strings.TrimSpace(r))] = true
	}
	t.airportStopIDs = make(map[string]bool, len(t.Overrides.AirportMetro.StopIDs))
	for _, id := range t.Overrides.AirportMetro.StopIDs {
		t.airportStopIDs[strings.TrimSpace(id)] = true
	}
	t.airportStopNames = make(map[string]bool, len(t.Overrides.AirportMetro.StopNames))
	for _, n := range t.Overrides.AirportMetro.StopNames {
		t.airportStopNames[foldStationName(n)] = true
	}
	return t, nil
}

func fareRound(x float64) float64 { return math.Round(x*1000) / 1000 }

// sectorZoneCount is the ATM zone count between two sectors, from the
// checked-in ATM GTFS-Fares v2 matrix (reverse direction only as fallback).
func (t *fareTable) sectorZoneCount(from, to string) (int, bool) {
	if n, ok := t.SectorZones[from][to]; ok {
		return n, true
	}
	if n, ok := t.SectorZones[to][from]; ok {
		return n, true
	}
	return 0, false
}

func normalizeFareAgency(agency string) string {
	ag := strings.ToLower(strings.TrimSpace(agency))
	switch ag {
	case "renfe_rodalies", "rodalies", "renfe":
		return "rodalies"
	case "tmb", "tmb_metro", "tmb_bus":
		return "tmb"
	default:
		return ag
	}
}

func canonicalFareStopKey(agency, stopID string) string {
	ag := normalizeFareAgency(agency)
	id := strings.TrimSpace(stopID)
	if ag == "" || id == "" {
		return ""
	}
	return ag + ":" + id
}

// stopSector resolves an ATM sector for a stop, preferring the exact
// agency:stopId entry from stop_areas.txt and falling back to folded station name.
func (t *fareTable) stopSector(agency, stopID, name string) (string, bool) {
	if key := canonicalFareStopKey(agency, stopID); key != "" {
		if sec, ok := t.StopSectors[key]; ok {
			return sec, true
		}
		// FGC platform stop IDs (e.g. "PC1") strip trailing digits to parent "PC".
		if strings.EqualFold(agency, "fgc") {
			trimmed := strings.TrimRight(stopID, "0123456789")
			if trimmed != "" && trimmed != stopID {
				if sec, ok := t.StopSectors["fgc:"+trimmed]; ok {
					return sec, true
				}
			}
		}
	}
	if sec, ok := t.Stations[foldStationName(name)]; ok {
		return sec, true
	}
	return "", false
}

// isBoundaryPair reports whether (from, to) has a priority-1 ROD_Z1/FGC_Z1
// 1-zone boundary override (applies to multi-trip products like T-casual only).
func (t *fareTable) isBoundaryPair(fromAg, fromID, fromName, toAg, toID, toName string) bool {
	if fk, tk := canonicalFareStopKey(fromAg, fromID), canonicalFareStopKey(toAg, toID); fk != "" && tk != "" {
		if t.boundaryStopSet[farePairKey(fk, tk)] {
			return true
		}
		// Also try stripping FGC platform digits.
		if strings.EqualFold(fromAg, "fgc") {
			if tr := strings.TrimRight(fromID, "0123456789"); tr != "" && tr != fromID {
				fk = "fgc:" + tr
			}
		}
		if strings.EqualFold(toAg, "fgc") {
			if tr := strings.TrimRight(toID, "0123456789"); tr != "" && tr != toID {
				tk = "fgc:" + tr
			}
		}
		if t.boundaryStopSet[farePairKey(fk, tk)] {
			return true
		}
	}
	fn, tn := foldStationName(fromName), foldStationName(toName)
	if fn != "" && tn != "" && t.boundaryNameSet[farePairKey(fn, tn)] {
		return true
	}
	return false
}

func (t *fareTable) legZones(fromAg, fromID, fromName, toAg, toID, toName string) (n int, fromSec, toSec string, boundary bool, ok bool) {
	fromSec, ok1 := t.stopSector(fromAg, fromID, fromName)
	toSec, ok2 := t.stopSector(toAg, toID, toName)
	if !ok1 || !ok2 {
		return 0, "", "", false, false
	}
	n, ok = t.sectorZoneCount(fromSec, toSec)
	if !ok {
		return 0, "", "", false, false
	}
	if n > 1 && t.isBoundaryPair(fromAg, fromID, fromName, toAg, toID, toName) {
		boundary = true
	}
	return n, fromSec, toSec, boundary, true
}

func (t *fareTable) isNonIntegratedLeg(l fareLeg) bool {
	if l.agency == "" || l.lineCode == "" {
		return false
	}
	return t.nonIntegratedSet[normalizeFareAgency(l.agency)+":"+strings.ToUpper(l.lineCode)]
}

func (t *fareTable) isAerobusLeg(l fareLeg) bool {
	if l.lineCode == "" {
		return false
	}
	code := strings.ToUpper(strings.TrimSpace(l.lineCode))
	if !t.aerobusRouteSet[code] {
		return false
	}
	return l.agency == "" || strings.EqualFold(l.agency, "amb") || strings.EqualFold(l.agency, "aerobus")
}

func (t *fareTable) isAirportMetroLeg(l fareLeg) bool {
	checkStop := func(id, name string) bool {
		if id != "" && t.airportStopIDs[strings.TrimSpace(id)] {
			return true
		}
		if name != "" && t.airportStopNames[foldStationName(name)] {
			return true
		}
		return false
	}
	if !checkStop(l.fromID, l.fromName) && !checkStop(l.toID, l.toName) {
		return false
	}
	if l.agency == "" || strings.EqualFold(l.agency, "tmb") || strings.EqualFold(l.agency, "tmb_metro") {
		return true
	}
	code := strings.ToUpper(strings.TrimSpace(l.lineCode))
	return code == "L9S" || code == "L9 SUD"
}

type fareLeg struct {
	rail              bool
	agency            string
	lineCode          string
	fromID, toID      string
	fromName, toName  string
	boardMs, alightMs int64
}

func fareLegsOf(itin *Obj) ([]fareLeg, bool) {
	raw := itin.Arr("legs")
	if len(raw) == 0 {
		return nil, false
	}
	out := make([]fareLeg, 0, len(raw))
	for _, r := range raw {
		l, _ := r.(*Obj)
		if l == nil {
			return nil, false
		}
		b, okb := parseDateJS(l.Str("boardAt"))
		a, oka := parseDateJS(l.Str("alightAt"))
		if !okb || !oka {
			return nil, false
		}
		lineCode := l.Str("lineCode")
		if lineCode == "" {
			lineCode = l.Str("lineId")
		}
		fl := fareLeg{
			rail:     l.Str("mode") == "rail",
			agency:   l.Str("agencyId"),
			lineCode: lineCode,
			boardMs:  int64(b),
			alightMs: int64(a),
		}
		if fs := l.ObjAt("fromStop"); fs != nil {
			fl.fromID = fs.Str("id")
			fl.fromName = fs.Str("name")
		}
		if ts := l.ObjAt("toStop"); ts != nil {
			fl.toID = ts.Str("id")
			fl.toName = ts.Str("name")
		}
		out = append(out, fl)
	}
	return out, true
}

func fareOpt(product, operator, kind string, price float64, tickets int, note string) *Obj {
	o := O("product", product, "operator", operator, "kind", kind, "price", fareRound(price), "tickets", float64(tickets))
	if note != "" {
		o.Set("note", note)
	}
	return o
}

// itineraryFare prices one planner itinerary: an *Obj, or nil when the
// price is not known or the route is not integrated.
func itineraryFare(itin *Obj) any {
	t := fares
	if t == nil {
		return nil
	}
	legs, ok := fareLegsOf(itin)
	if !ok {
		return nil
	}
	n := len(legs)

	// Override 1: Aerobús (not ATM-integrated).
	aerobusCount := 0
	for _, l := range legs {
		if t.isAerobusLeg(l) {
			aerobusCount++
		}
	}
	if aerobusCount > 0 {
		if aerobusCount != n || t.Overrides.Aerobus.Single <= 0 {
			return nil
		}
		s := fareOpt("aerobus_single", "aerobus", "single", t.Overrides.Aerobus.Single*float64(n), n, t.Overrides.Aerobus.Note)
		return O(
			"currency", t.Currency, "validFrom", t.ValidFrom, "note", "preu orientatiu",
			"zones", nil,
			"cheapestSingle", s, "perTripWithTen", nil,
			"options", []any{s},
			"transferWindowMinutes", 0.0,
			"needsRevalidation", false,
		)
	}

	// Override 2: Airport Metro L9 Sud (Bitllet Aeroport; T-casual not valid).
	for _, l := range legs {
		if t.isAirportMetroLeg(l) {
			if n != 1 || t.Overrides.AirportMetro.Single <= 0 {
				return nil
			}
			s := fareOpt("tmb_airport_single", "tmb", "single", t.Overrides.AirportMetro.Single, 1, t.Overrides.AirportMetro.Note)
			return O(
				"currency", t.Currency, "validFrom", t.ValidFrom, "note", "preu orientatiu",
				"zones", O("count", 1.0, "from", "1", "to", "1", "basis", "Bitllet Aeroport (L9 Sud)"),
				"cheapestSingle", s, "perTripWithTen", nil,
				"options", []any{s},
				"transferWindowMinutes", 0.0,
				"needsRevalidation", false,
			)
		}
	}

	// Override 3: Non-STI routes (Cremallera de Núria, Montserrat, FGC RL1/RL2, Rodalies RT1/RL3/RL4).
	for _, l := range legs {
		if t.isNonIntegratedLeg(l) {
			return nil
		}
	}

	rail := 0
	for _, l := range legs {
		if l.rail {
			rail++
		}
	}
	if rail != 0 && rail != len(legs) {
		return nil
	}
	spanSec := float64(legs[n-1].boardMs-legs[0].boardMs) / 1000
	var options []any
	var zonesObj *Obj
	var singles, tens []*Obj
	revalidate := false
	var windowSec float64

	if rail == 0 {
		// Mataro Bus: every stop is sector 3E, one ATM zone for a trip.
		zonesObj = O("count", 1.0, "from", t.MataroBus.Sector, "to", t.MataroBus.Sector,
			"basis", "Mataró Bus, tot dins el sector "+t.MataroBus.Sector)
		own := 1
		if spanSec > t.MataroBus.SingleTransferSeconds {
			own = n
			revalidate = true
		}
		windowSec = t.MataroBus.SingleTransferSeconds
		atmTen := 1
		if spanSec > t.ATM.Transfer.WindowSeconds[0] {
			atmTen = n
			revalidate = true
		}
		s1 := fareOpt("mataro_single", "mataro_bus", "single", t.MataroBus.Single*float64(own), own, "")
		t10 := fareOpt("mataro_t10", "mataro_bus", "ten", t.MataroBus.T10/t.MataroBus.T10Trips*float64(own), own, "")
		s2 := fareOpt("atm_single_1z", "atm", "single", t.ATM.Single[0]*float64(n), n, "")
		t2 := fareOpt("atm_t_casual_1z", "atm", "ten", t.ATM.TCasual[0]/t.ATM.TCasualTrips*float64(atmTen), atmTen, "")
		singles, tens = []*Obj{s1, s2}, []*Obj{t10, t2}
		options = []any{s1, t10, s2, t2}
	} else {
		first, last := legs[0], legs[n-1]
		total, fromSec, toSec, boundary, ok := t.legZones(first.agency, first.fromID, first.fromName, last.agency, last.toID, last.toName)
		if !ok || total < 1 || total > 7 {
			return nil
		}
		// Priority-1 ROD_Z1/FGC_Z1 boundary overrides reduce multi-trip (T-casual)
		// to 1 zone; single ticket stays at the sector-matrix zone count.
		tenZones := total
		tenNote := ""
		if boundary {
			tenZones = 1
			tenNote = "tarifa frontera 1 zona"
		}
		zonesObj = O("count", float64(total), "from", fromSec, "to", toSec,
			"basis", "sectors ATM "+fromSec+" → "+toSec)
		if boundary {
			zonesObj.Set("boundaryOneZoneMultiTrip", true)
		}
		windowSec = t.ATM.Transfer.WindowSeconds[tenZones-1]
		perLegSingle, perLegTen := 0.0, 0.0
		legsKnown := true
		for _, l := range legs {
			z, _, _, legBoundary, lok := t.legZones(l.agency, l.fromID, l.fromName, l.agency, l.toID, l.toName)
			if !lok || z < 1 || z > 7 {
				legsKnown = false
				break
			}
			perLegSingle += t.ATM.Single[z-1]
			lz := z
			if legBoundary {
				lz = 1
			}
			perLegTen += t.ATM.TCasual[lz-1] / t.ATM.TCasualTrips
		}
		// The single ticket has no transfers: one per leg.
		if n == 1 {
			s := fareOpt("atm_single", "atm", "single", t.ATM.Single[total-1], 1, "")
			singles = []*Obj{s}
			options = append(options, s)
		} else if legsKnown {
			s := fareOpt("atm_single", "atm", "single", perLegSingle, n, "un bitllet per tram")
			singles = []*Obj{s}
			options = append(options, s)
		}
		if n == 1 || spanSec <= windowSec {
			c := fareOpt("atm_t_casual", "atm", "ten", t.ATM.TCasual[tenZones-1]/t.ATM.TCasualTrips, 1, tenNote)
			tens = []*Obj{c}
			options = append(options, c)
		} else {
			revalidate = true
			if legsKnown {
				c := fareOpt("atm_t_casual", "atm", "ten", perLegTen, n, "cal validar de nou: fora de la finestra de transbord")
				tens = []*Obj{c}
				options = append(options, c)
			}
		}
	}
	if len(singles) == 0 && len(tens) == 0 {
		return nil
	}
	cheapest := func(list []*Obj) any {
		var best *Obj
		for _, o := range list {
			if best == nil || o.Num("price") < best.Num("price") {
				best = o
			}
		}
		if best == nil {
			return nil
		}
		return best
	}
	return O(
		"currency", t.Currency, "validFrom", t.ValidFrom, "note", "preu orientatiu",
		"zones", zonesObj,
		"cheapestSingle", cheapest(singles), "perTripWithTen", cheapest(tens),
		"options", options,
		"transferWindowMinutes", math.Round(windowSec/60),
		"needsRevalidation", revalidate,
	)
}

package main

// Live train positions for the GTFS-RT operators (Rodalies, FGC): GUI
// scalability phase 2, bit 2 of docs/catalonia-review/REPORT.md.
//
// GET /api/trains[?agency=<id>][&line=<code>] answers from the pollers'
// latest snapshots, which the server reads through rtLivePollers: no World
// lock is needed for the data, no SQLite and no upstream request is made.
// Every position is one the operator's feed reported; nothing is
// extrapolated or synthesised, and each train says how old its position
// is, where its delay comes from, and when the delay was dropped as
// impossible.

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// trainStaleSec is how old a reported position may be before the train is
// marked stale (not real time). Renfe's feed is polled every 30 s and its
// header runs about 30-40 s behind, so three minutes means the operator has
// stopped updating the train.
const trainStaleSec = 180

// trainStaleSecByAgency overrides it per operator, since freshness depends
// on how each one publishes. FGC writes a new positions file only about
// every 2 minutes, and each file is already 1.5-2 minutes old when it
// appears (measured 2026-11-21: ages 122-222 s at the source, about 209 s
// as served): with 180 s every FGC train was hidden for much of each
// cycle. Its trains carry their age (ageSec), so a 5-minute bound shows
// them without passing them off as fresher than they are.
var trainStaleSecByAgency = map[string]float64{"fgc": 300}

// trainStaleAfter is the stale bound for an operator's trains.
func trainStaleAfter(agencyID string) float64 {
	if v, ok := trainStaleSecByAgency[agencyID]; ok {
		return v
	}
	return trainStaleSec
}

// trainAttribution is the credit each operator's licence (CC BY 4.0)
// requires wherever its data is shown.
var trainAttribution = map[string]string{
	"renfe_rodalies": "Origen de los datos: Renfe Operadora",
	"fgc":            "Ferrocarrils de la Generalitat de Catalunya",
}

// trainFeed is one operator's snapshot as the response builder sees it.
type trainFeed struct {
	info operatorInfo
	snap *rtSnapshot // nil before the first poll
}

// liveTrainFeeds is the running pollers' snapshots, in reportOperators
// order (nil when the pollers are off).
func liveTrainFeeds() []trainFeed {
	pp := rtLivePollers.Load()
	if pp == nil {
		return nil
	}
	var feeds []trainFeed
	for _, info := range reportOperators {
		for _, p := range *pp {
			if p.src.AgencyID == info.ID {
				feeds = append(feeds, trainFeed{info: info, snap: p.snap.Load()})
			}
		}
	}
	return feeds
}

// trainsResponse builds the /api/trains body. agency and line filter the
// trains (line matches the code case-insensitively); operators are always
// listed with their feed state so the client can say why a list is empty.
// trainBox is the optional ?bbox= filter: only trains inside it are listed.
type trainBox struct{ minLat, minLon, maxLat, maxLon float64 }

func (b *trainBox) has(lat, lon float64) bool {
	return b == nil || (lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon)
}

// parseTrainBox reads "minLat,minLon,maxLat,maxLon"; anything else (wrong
// count, not finite, min above max, outside the globe) means no filter.
func parseTrainBox(s string) *trainBox {
	parts := strings.Split(s, ",")
	if len(parts) != 4 {
		return nil
	}
	var v [4]float64
	for i, p := range parts {
		f, err := strconv.ParseFloat(strings.TrimSpace(p), 64)
		if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
			return nil
		}
		v[i] = f
	}
	b := &trainBox{v[0], v[1], v[2], v[3]}
	if b.minLat > b.maxLat || b.minLon > b.maxLon || b.minLat < -90 || b.maxLat > 90 || b.minLon < -180 || b.maxLon > 180 {
		return nil
	}
	return b
}

func trainsResponse(feeds []trainFeed, now time.Time, agency, line string, box *trainBox) *Obj {
	nowMs := float64(now.UnixMilli())
	ops := []any{}
	trains := []any{}
	for _, f := range feeds {
		if agency != "" && f.info.ID != agency {
			continue
		}
		op := O(
			"id", f.info.ID, "name", f.info.Name, "mode", f.info.Mode,
			"attribution", trainAttribution[f.info.ID],
			"vehicles", 0.0, "fetchedAt", nil, "fetchAgeSec", nil, "feedTimestamp", nil,
			"vehiclesError", nil, "tripUpdatesError", nil, "staleAfterSec", trainStaleAfter(f.info.ID),
		)
		if s := f.snap; s != nil {
			op.Set("vehicles", float64(len(s.Vehicles)))
			op.Set("fetchedAt", float64(s.FetchedAt.UnixMilli()))
			op.Set("fetchAgeSec", math.Max(0, math.Round(now.Sub(s.FetchedAt).Seconds())))
			if s.FeedTimestamp > 0 {
				op.Set("feedTimestamp", float64(s.FeedTimestamp)*1000)
			}
			op.Set("vehiclesError", strOrNil(s.VehiclesErr))
			op.Set("tripUpdatesError", strOrNil(s.TripsErr))
			for i := range s.Vehicles {
				v := &s.Vehicles[i]
				if line != "" && !strings.EqualFold(v.LineCode, line) {
					continue
				}
				if !box.has(v.Lat, v.Lon) {
					continue
				}
				trains = append(trains, trainJSON(f.info, s, v, now))
			}
		}
		ops = append(ops, op)
	}
	return O(
		"success", true,
		"enabled", feeds != nil,
		"timestamp", nowMs,
		"staleAfterSec", float64(trainStaleSec),
		"count", float64(len(trains)),
		"bbox", boxJSON(box),
		"operators", ops,
		"trains", trains,
	)
}

// trainJSON is one train. The position time is the vehicle's own timestamp,
// else the feed header's (positionTimeSource says which); with neither the
// age is unknown and the train is not called real time.
func trainJSON(info operatorInfo, s *rtSnapshot, v *rtVehicle, now time.Time) *Obj {
	var observed int64
	timeSource := any(nil)
	switch {
	case v.ObservedAt > 0:
		observed, timeSource = v.ObservedAt, "vehicle"
	case s.FeedTimestamp > 0:
		observed, timeSource = int64(s.FeedTimestamp), "feed"
	}
	observedAt, ageSec := any(nil), any(nil)
	stale := true
	if observed > 0 {
		age := math.Max(0, float64(now.Unix()-observed))
		observedAt, ageSec = float64(observed)*1000, age
		stale = age > trainStaleAfter(info.ID)
	}

	delaySec, delayMins, delaySource := any(nil), any(nil), any(nil)
	discarded := false
	if v.HasDelayFromTripUpdate && v.DelaySec != nil {
		d := int(*v.DelaySec)
		if d < railMinDelaySec || d > railMaxDelaySec {
			discarded = true
		} else {
			delaySec, delayMins = float64(d), math.Round(float64(d)/60)
			if v.DelayComputed {
				delaySource = "timetable"
			} else {
				delaySource = "feed"
			}
		}
	}

	label, platform := labelPlatform(v.Label)
	id := v.VehicleID
	if id == "" {
		id = v.TripID
	}
	if id == "" {
		id = label
	}
	return O(
		"id", info.ID+":"+id,
		"agencyId", info.ID,
		"mode", info.Mode,
		"vehicleId", strOrNil(v.VehicleID),
		"label", strOrNil(label),
		// Renfe announces the platform at the next station in the label of a
		// train approaching it ("R2S-25547-PLATF.(11)"): it is the platform
		// at stopId, nothing further ahead.
		"platform", strOrNil(platform),
		"tripId", strOrNil(v.TripID),
		"routeId", strOrNil(v.RouteID),
		"lineCode", strOrNil(v.LineCode),
		"lat", v.Lat,
		"lon", v.Lon,
		"latitude", v.Lat,
		"longitude", v.Lon,
		"stopId", strOrNil(v.StopID),
		"stopName", strOrNil(v.StopName),
		"currentStatus", strOrNil(v.CurrentStatus),
		"observedAt", observedAt,
		"positionTimeSource", timeSource,
		"ageSec", ageSec,
		"stale", stale,
		"isRealTime", !stale,
		"isEstimated", false,
		"isTheoretical", false,
		"positionSource", "gtfsrt",
		"delaySec", delaySec,
		"delayMins", delayMins,
		"delaySource", delaySource,
		"delayDiscarded", discarded,
	)
}

// hTrains serves /api/trains. Not cached server-side (the snapshot is
// already in memory and changes every poll); /api/* responses carry
// Cache-Control: no-store and the service worker never caches them.
func (s *Server) hTrains(q *xreq, res *xres) error {
	param := func(k string) string {
		v := qv(q, k)
		if isUndef(v) {
			return ""
		}
		str := jsTrim(jsString(v))
		if len(str) > 32 {
			return "\x00" // matches nothing
		}
		return str
	}
	bbox := ""
	if v := qv(q, "bbox"); !isUndef(v) {
		if s := jsString(v); len(s) <= 120 {
			bbox = s
		}
	}
	res.json(trainsResponse(liveTrainFeeds(), time.Now(), param("agency"), param("line"), parseTrainBox(bbox)))
	return nil
}

// boxJSON echoes the applied ?bbox= (nil when none or invalid).
func boxJSON(b *trainBox) any {
	if b == nil {
		return nil
	}
	return []any{b.minLat, b.minLon, b.maxLat, b.maxLon}
}

var rePlatformLabel = regexp.MustCompile(`^(.*?)-PLATF\.\(([^)]+)\)$`)

// labelPlatform splits Renfe's "R2S-25547-PLATF.(11)" into the label
// ("R2S-25547") and the platform ("11"); other labels are returned as they
// are, with no platform.
func labelPlatform(label string) (string, string) {
	if m := rePlatformLabel.FindStringSubmatch(strings.TrimSpace(label)); m != nil {
		return m[1], strings.TrimSpace(m[2])
	}
	return label, ""
}

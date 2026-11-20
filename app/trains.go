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
	"strings"
	"time"
)

// trainStaleSec is how old a reported position may be before the train is
// marked stale (not real time). Both feeds are polled every 30 s and their
// headers run about 30-40 s behind, so three minutes means the operator
// has stopped updating the train.
const trainStaleSec = 180

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
func trainsResponse(feeds []trainFeed, now time.Time, agency, line string) *Obj {
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
			"vehiclesError", nil, "tripUpdatesError", nil,
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
		stale = age > trainStaleSec
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

	id := v.VehicleID
	if id == "" {
		id = v.TripID
	}
	if id == "" {
		id = v.Label
	}
	return O(
		"id", info.ID+":"+id,
		"agencyId", info.ID,
		"mode", info.Mode,
		"vehicleId", strOrNil(v.VehicleID),
		"label", strOrNil(v.Label),
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
	res.json(trainsResponse(liveTrainFeeds(), time.Now(), param("agency"), param("line")))
	return nil
}

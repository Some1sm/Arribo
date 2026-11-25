package main

// The single-line view for Rodalies and FGC lines (GUI scalability phase 2,
// bit 4 of docs/catalonia-review/REPORT.md). A rail line is addressed as
// "<agency>:<code>" ("fgc:L6", "renfe_rodalies:R2S"): FGC's L6, L7 and L8
// would otherwise collide with Mataró's lines 6, 7 and 8, which the
// registry also accepts as "L6".
//
// Everything is read from immutable snapshots the GTFS-RT pollers publish
// (rtCatalog for the line profiles, rtLivePollers for the trains): no World
// lock is needed for the data, no SQLite and no upstream request.

import (
	"context"
	"strings"
	"time"
)

// railLineRef resolves "<agency>:<code>" to the operator and the line's
// catalog code (matched case-insensitively). ok is false for anything else,
// including Mataró ids, which keep their own resolution.
func railLineRef(lineID any) (info operatorInfo, op *rtCatalogOp, code string, ok bool) {
	s, isStr := lineID.(string)
	if !isStr {
		return
	}
	i := strings.IndexByte(s, ':')
	if i <= 0 || i == len(s)-1 || len(s) > 64 {
		return
	}
	agency, want := strings.ToLower(s[:i]), s[i+1:]
	for _, o := range lineOperators() {
		if o.ID != agency {
			continue
		}
		v, found := rtCatalog.Load(o.ID)
		if !found {
			return
		}
		c := v.(*rtCatalogOp)
		for _, r := range c.Lines {
			if strings.EqualFold(r.Code, want) {
				return o, c, r.Code, true
			}
		}
		return
	}
	return
}

// railLineDetails is the /api/line/:lineId body for a rail line, in the
// shape the single-line view reads for a Mataró line (app/tracker.go,
// precompileStaticRoutes), plus what a rail line needs said about its data.
// direction is "0", "1" or "both" (anything else is "0").
func railLineDetails(info operatorInfo, op *rtCatalogOp, code, direction string, feeds []trainFeed, now time.Time) *Obj {
	var route rtRoute
	for _, r := range op.Lines {
		if r.Code == code {
			route = r
			break
		}
	}
	var prof *rtLineProfile
	if op.Profiles != nil {
		prof = op.Profiles[code]
	}
	ref := info.ID + ":" + code
	color := any(nil)
	if route.Color != "" {
		color = route.Color
	}
	ink := any(nil)
	if route.TextColor != "" {
		ink = route.TextColor
	}

	isBoth := direction == "both"
	if !isBoth && direction != "1" {
		direction = "0"
	}

	var dirs []rtLineDirection
	if prof != nil {
		dirs = prof.Directions
	}
	stopsJSON := func(d rtLineDirection) []any {
		out := make([]any, 0, len(d.Stops))
		for i, st := range d.Stops {
			out = append(out, O(
				"id", st.ID, "seq", float64(i+1), "name", st.Name,
				"lat", st.Lat, "lon", st.Lon, "code", st.ID, "zone", nil, "color", color,
			))
		}
		return out
	}
	geomJSON := func(d rtLineDirection) []any {
		out := make([]any, 0, len(d.Geometry))
		for _, p := range d.Geometry {
			out = append(out, []any{p[0], p[1]})
		}
		return out
	}
	dirName := func(d rtLineDirection) string {
		if d.Headsign == "" {
			return "Sentit " + numToString(float64(d.DirectionID))
		}
		return "Cap a " + d.Headsign
	}

	directions := []any{}
	allDirections := []any{}
	for _, d := range dirs {
		id := numToString(float64(d.DirectionID))
		directions = append(directions, O(
			"dirId", id, "routeId", nil, "name", dirName(d), "stopsCount", float64(len(d.Stops)),
		))
		allDirections = append(allDirections, O(
			"dirId", id, "name", dirName(d), "polyline", geomJSON(d), "stops", stopsJSON(d),
		))
	}

	// The selected direction: the one asked for, else the first there is.
	var sel *rtLineDirection
	for i := range dirs {
		if !isBoth && numToString(float64(dirs[i].DirectionID)) == direction {
			sel = &dirs[i]
		}
	}
	if sel == nil && len(dirs) > 0 {
		sel = &dirs[0]
		if !isBoth {
			direction = numToString(float64(sel.DirectionID))
		}
	}
	stops, coords := []any{}, []any{}
	directionName := any("Ambdós sentits")
	fromStops := false
	if sel != nil {
		stops, coords, fromStops = stopsJSON(*sel), geomJSON(*sel), sel.GeometryFromStops
		if !isBoth {
			directionName = dirName(*sel)
		}
	}
	var secCoords, secStops any = nil, nil
	if isBoth && len(dirs) > 1 {
		secCoords, secStops = geomJSON(dirs[1]), stopsJSON(dirs[1])
		fromStops = fromStops || dirs[1].GeometryFromStops
	}
	geometrySource := "gtfs_shape"
	if fromStops {
		geometrySource = "gtfs_stops"
	}

	headsign := map[int]string{}
	for _, d := range dirs {
		headsign[d.DirectionID] = d.Headsign
	}
	buses, stale := railLineTrains(info, code, ref, direction, headsign, feeds, now)
	source := "gtfsrt"
	switch info.ID {
	case movAgencyID:
		// Moventis: estimated from its stop predictions, or AMB real GPS for a
		// Casas line while AMB has it live (movLineBuses overlays it).
		buses, stale, source = movLineBuses(code, direction, now), 0, "moventis_predictions"
		if anyMeasured(buses) {
			source = "moventis_predictions+amb_gps"
		}
	case sagalesAgencyID:
		// Sagalés: real GPS vehicles from sagales.com (unofficial).
		buses, stale = sagalesLineBuses(code, direction, now)
		source = "sagales_gps_unofficial"
	}

	name := route.Name
	if name == "" {
		name = code
	}
	return O(
		"lineId", ref,
		"id", ref,
		"code", code,
		"name", name,
		"color", color,
		"textColor", ink,
		"agency", info.Name,
		"agencyId", info.ID,
		"group", info.ID,
		"mode", catalogModeLabel(info),
		"direction", direction,
		"directionName", directionName,
		"directions", directions,
		"totalStops", float64(len(stops)),
		"stops", stops,
		"coords", coords,
		"polyline", coords,
		// "gtfs_stops": straight segments between stations, because the
		// operator publishes no track shape for this line.
		"geometrySource", geometrySource,
		"geometryEstimated", fromStops,
		"secondaryCoords", secCoords,
		"secondaryStops", secStops,
		"secondaryColor", color,
		"allDirections", allDirections,
		"activeBuses", buses,
		"delayStats", nil,
		"railData", O(
			"source", source,
			"attribution", railAttribution(info.ID),
			"positionsEstimated", info.ID == movAgencyID && !anyMeasured(buses),
			"stopsFrom", "longest_trip",
			"staleAfterSec", trainStaleAfter(info.ID),
			"staleTrains", float64(stale),
			"liveFeed", feeds != nil,
			"profileAvailable", prof != nil,
		),
	)
}

// railLineTrains is the line's trains for the view, built on trainJSON so
// they carry the same honesty fields as /api/trains. Trains whose position
// has gone stale are left out of the map and only counted: a train the
// operator stopped reporting must not sit on the line as if it were live.
// A train of unknown direction is only shown with both directions.
func railLineTrains(info operatorInfo, code, ref, direction string, headsign map[int]string, feeds []trainFeed, now time.Time) (buses []any, stale int) {
	buses = []any{}
	for _, f := range feeds {
		if f.info.ID != info.ID || f.snap == nil {
			continue
		}
		for i := range f.snap.Vehicles {
			v := &f.snap.Vehicles[i]
			if !strings.EqualFold(v.LineCode, code) {
				continue
			}
			dir := ""
			if v.DirectionID >= 0 {
				dir = numToString(float64(v.DirectionID))
			}
			if direction != "both" && dir != direction {
				continue
			}
			t := trainJSON(info, f.snap, v, now)
			if t.Get("stale") == true {
				stale++
				continue
			}
			t.Set("lineId", ref)
			t.Set("direction", strOrNil(dir))
			t.Set("destination", strOrNil(headsign[v.DirectionID]))
			t.Set("toStop", strOrNil(v.StopName))
			t.Set("delayMinutes", t.Get("delayMins"))
			status, badge := railDelayLabel(t.Get("delayMins"), t.Get("delayDiscarded") == true)
			t.Set("delayStatus", status)
			t.Set("delayBadgeText", badge)
			t.Set("delayFormatted", badge)
			t.Set("isGhostVehicle", false)
			t.Set("agency", info.Name)
			t.Set("attribution", trainAttribution[info.ID])
			buses = append(buses, t)
		}
	}
	return buses, stale
}

// railDelayLabel is a train's delay status and label for the line view,
// with rail's punctuality rule (on time up to 5 min late). A missing delay
// is said to be missing, never shown as on time.
func railDelayLabel(mins any, discarded bool) (status, label string) {
	m, ok := mins.(float64)
	switch {
	case discarded:
		return "unknown", "Previsió no fiable"
	case !ok:
		return "unknown", "Sense dada de retard"
	case m > 5:
		return "delayed", "+" + numToString(m) + " min"
	case m < -1:
		return "early", "−" + numToString(-m) + " min"
	case m == 0:
		return "on_time", "A l'hora"
	case m > 0:
		return "on_time", "+" + numToString(m) + " min"
	default:
		return "on_time", "−" + numToString(-m) + " min"
	}
}

// railDepartures serves /api/line/<agency>:<code>/stop/:stopId/departures:
// the timetable's next departures from the worker, with live delays added
// here from the pollers' snapshot.
func (s *Server) railDepartures(q *xreq, res *xres, info operatorInfo, op *rtCatalogOp, code string) {
	stopID := jsString(q.params.Get("stopId"))
	stop, ok := lineStop(op, code, stopID)
	if !ok {
		res.status = 404
		res.json(O("success", false, "error", "Unknown station for this line"))
		return
	}
	direction := ""
	if v := qv(q, "direction"); !isUndef(v) {
		direction = jsTrim(jsString(v))
	}
	now := time.UnixMilli(nowMs())
	if info.ID == movAgencyID {
		// On-demand Moventis stop predictions + scheduled times (30 s TTL cache),
		// falling back to the background poller's snapshot and Gencat timetable.
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		out := movStopDepartures(ctx, stop, code, direction, now)
		cancel()
		res.json(O("success", true, "data", out))
		return
	}
	if info.ID == sagalesAgencyID {
		res.json(O("success", true, "data", sagalesStopDepartures(stop, code, direction, now)))
		return
	}
	if info.ID == tmbAgencyID {
		// TMB live iTransit predictions (Metro L1-L5/L11 from 30 s cache;
		// Bus on-demand with 20 s TTL cache). L9/L10/FM and misses fall back to GTFS.
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		live := tmbLiveDepartures(ctx, stop, code, direction, now)
		cancel()
		if live != nil {
			res.json(O("success", true, "data", live))
			return
		}
	}
	if info.ID == gironaAgencyID {
		// TMG Girona unofficial live appbus predictions (20 s TTL cache); falls back to GTFS.
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		live := gironaLiveDepartures(ctx, stop, code, direction, now)
		cancel()
		if live != nil {
			res.json(O("success", true, "data", live))
			return
		}
	}
	data, err := s.historyQuery("getRailDepartures", O("agencyId", info.ID, "code", code, "stopId", stopID, "direction", direction), 8000)
	if err != nil {
		s.sendInternalError(q, res, err, O("success", false))
		return
	}
	var snap *rtSnapshot
	for _, f := range liveLineFeeds() {
		if f.info.ID == info.ID {
			snap = f.snap
		}
	}
	sched, _ := field(data, "departures").([]any)
	platforms, _ := field(data, "platforms").(*Obj)
	usual, _ := field(data, "usualPlatforms").(*Obj)
	out := railDeparturesResponse(info, stop, sched, snap, platforms, usual, now)
	if info.ID == tmbAgencyID {
		out.Set("attribution", tmbAttributionWithDate(now))
		out.Set("dataUpdatedAt", now.In(madrid).Format("2006-01-02"))
	}
	res.json(O("success", true, "data", out))
}

// hRailLine answers the /api/line/:lineId family for a rail line. It
// returns false when lineId is not a rail line, so the caller continues
// with Mataró's resolution.
func (s *Server) hRailLine(q *xreq, res *xres, kind string) bool {
	info, op, code, ok := railLineRef(q.params.Get("lineId"))
	if !ok {
		return false
	}
	switch kind {
	case "line":
		direction := ""
		if v := qv(q, "direction"); !isUndef(v) {
			direction = jsTrim(jsString(v))
		}
		now := time.Now()
		data := railLineDetails(info, op, code, direction, liveLineFeeds(), now)
		// The operator's active service alerts for this line: those naming
		// it, and those naming only stations it stops at.
		lineStops := map[string]bool{}
		if prof := op.Profiles[code]; prof != nil {
			for _, d := range prof.Directions {
				for _, st := range d.Stops {
					lineStops[st.ID] = true
				}
			}
		}
		data.Set("railAlerts", railAlertsJSON(info.ID, code, lineStops, now))
		res.json(O("success", true, "data", data))
	case "stats":
		// The line header's 24 h summary, from the station visits the
		// operator's trip updates produced (the Dades train report's data),
		// with rail's on-time bound. null when nothing was recorded.
		var stats any
		if data, err := s.historyQuery("getRailLineStats", O("agencyId", info.ID, "line", code, "hours", 24.0), 8000); err == nil {
			stats = data
		}
		res.json(O("success", true, "lineId", info.ID+":"+code, "code", code, "hoursMonitored", 24.0, "stats", stats))
	case "departures":
		s.railDepartures(q, res, info, op, code)
	case "eta":
		// The view falls back to its own estimate when this is not a success.
		res.json(O("success", false, "error", "Not available for rail lines yet"))
	default:
		// vehicles: not built for rail yet.
		// Said plainly rather than answered with Mataró's empty shapes.
		res.status = 404
		res.json(O("success", false, "error", "Not available for rail lines yet"))
	}
	return true
}

// railAttribution is the attribution an operator's licence asks for.
func railAttribution(agencyID string) any {
	switch agencyID {
	case movAgencyID:
		return movAttributionText()
	case tmbAgencyID:
		at := time.Now()
		if s := tmbMetroLive.Load(); s != nil && !s.At.IsZero() {
			at = s.At
		}
		return tmbAttributionWithDate(at)
	case tramTbxAgencyID, tramTbsAgencyID:
		return tramAttribution + " · Actualitzat " + time.Now().In(madrid).Format("2006-01-02")
	}
	return trainAttribution[agencyID]
}

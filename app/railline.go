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
	for _, o := range reportOperators {
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
		"mode", "Tren",
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
			"source", "gtfsrt",
			"attribution", trainAttribution[info.ID],
			"stopsFrom", "longest_trip",
			"staleAfterSec", float64(trainStaleSec),
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
			t.Set("isGhostVehicle", false)
			buses = append(buses, t)
		}
	}
	return buses, stale
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
		res.json(O("success", true, "data", railLineDetails(info, op, code, direction, liveTrainFeeds(), time.Now())))
	case "stats":
		// No bus-style delay statistics for trains here: Dades has the
		// operators' punctuality (/api/analytics/operators).
		res.json(O("success", true, "stats", nil))
	default:
		// target-eta, vehicles, stop departures: not built for rail yet.
		// Said plainly rather than answered with Mataró's empty shapes.
		res.status = 404
		res.json(O("success", false, "error", "Not available for rail lines yet"))
	}
	return true
}

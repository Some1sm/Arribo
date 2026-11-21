package main

// Train journeys for the planner (/api/plan): Rodalies and FGC, direct or
// with one change, including a change between operators at nearby stations
// (Renfe's and FGC's Plaça de Catalunya). The bus planner (planner.go) is
// Mataró's own graph; this works on the operators' imported GTFS
// timetables and returns itineraries in the same response format, which
// hPlan merges with the bus ones.
//
// Method: from each end, one query per operator timetable. Leaving the
// origin stations: every trip in the next railPlanLeaveWindow with all its
// later stops. Reaching the destination stations: every trip arriving
// within railPlanArriveWindow with all its earlier stops. A trip found
// from both ends is a direct journey; a first trip's arrival at a station
// from which a second trip leaves after the change time is a journey with
// one change. Live delays count only for trips the operator reports a
// train for (as in the station departures); everything else is timetable.

import (
	"context"
	"database/sql"
	"math"
	"sort"
	"strings"
	"time"
)

const (
	railPlanLeaveWindow  = 3 * 3600 // seconds after the departure instant
	railPlanArriveWindow = 5 * 3600 // seconds after the departure instant
	railChangeSec        = 180      // minimum change between trains
	railChangeWalkMaxM   = 400      // a change may walk to another station this far
	railWalkDetour       = 1.25     // straight-line distance to walking distance
	railPlanMaxResults   = 5        // itineraries returned
	railEndpointNearM    = 1500.0   // stations considered around a point
	railEndpointPerOp    = 3        // nearest stations per operator around a point
	railPlanQueryTimeout = 6 * time.Second
)

// railEnd is a station at one end of the journey, with the walk to or from it.
type railEnd struct {
	Agency, StopID, Name string
	Lat, Lon             float64
	WalkM                float64 // walking metres from the origin point / to the destination point (0 for a named station)
}

// railLeg is one trip ridden between two stops (absolute unix seconds).
type railLeg struct {
	Agency, Trip, Line, Headsign string
	Dir                          int
	BoardStop, AlightStop        string
	BoardName, AlightName        string
	BoardKey, AlightKey          string // station identity: agency + parent station (or stop id)
	BoardLat, BoardLon           float64
	AlightLat, AlightLon         float64
	Board, Alight                int64 // scheduled
	Stops                        int   // stops ridden
	Delay                        int64 // live delay (seconds) when the train is running, else 0
	Live                         bool
}

func (l railLeg) boardAt() int64  { return l.Board + l.Delay }
func (l railLeg) alightAt() int64 { return l.Alight + l.Delay }

// railItin is a candidate journey.
type railItin struct {
	Legs            []railLeg
	From, To        railEnd
	ChangeWalkM     float64
	Leave, Arrive   int64 // leaving the origin point, arriving at the destination point
	WalkM, WalkSecs float64
}

func walkSecsFor(m, speed float64) float64 {
	if m <= 0 {
		return 0
	}
	return math.Round(m * railWalkDetour / speed * 60)
}

// combineRailLegs builds direct and one-change journeys from the legs that
// leave an origin station (first) and those that reach a destination
// station (second). speed is walking metres per minute.
func combineRailLegs(first, second []railLeg, origins, dests map[string]railEnd, depart int64, speed float64) []railItin {
	var out []railItin
	endOf := func(m map[string]railEnd, agency, stop string) (railEnd, bool) {
		e, ok := m[agency+"\x00"+stop]
		return e, ok
	}
	// Direct: a leg from an origin station that alights at a destination station.
	for _, l := range first {
		o, ok1 := endOf(origins, l.Agency, l.BoardStop)
		d, ok2 := endOf(dests, l.Agency, l.AlightStop)
		if !ok1 || !ok2 || l.BoardKey == l.AlightKey {
			continue
		}
		leave := l.boardAt() - int64(walkSecsFor(o.WalkM, speed)) - 60
		if leave < depart {
			continue
		}
		out = append(out, railItin{Legs: []railLeg{l}, From: o, To: d, Leave: leave,
			Arrive: l.alightAt() + int64(walkSecsFor(d.WalkM, speed)), WalkM: o.WalkM + d.WalkM})
	}
	// One change: index the second legs by boarding station.
	byKey := map[string][]railLeg{}
	for _, s := range second {
		if _, ok := endOf(dests, s.Agency, s.AlightStop); ok {
			byKey[s.BoardKey] = append(byKey[s.BoardKey], s)
		}
	}
	type spot struct {
		key      string
		lat, lon float64
	}
	var spots []spot
	for k, ls := range byKey {
		spots = append(spots, spot{k, ls[0].BoardLat, ls[0].BoardLon})
	}
	sort.Slice(spots, func(i, j int) bool { return spots[i].key < spots[j].key })
	for _, f := range first {
		o, ok := endOf(origins, f.Agency, f.BoardStop)
		if !ok {
			continue
		}
		leave := f.boardAt() - int64(walkSecsFor(o.WalkM, speed)) - 60
		if leave < depart {
			continue
		}
		best := -1
		var bestLeg railLeg
		var bestWalk float64
		var bestArrive int64
		for _, sp := range spots {
			walk := 0.0
			if sp.key != f.AlightKey {
				walk = distM(f.AlightLat, f.AlightLon, sp.lat, sp.lon)
				if walk > railChangeWalkMaxM {
					continue
				}
			}
			ready := f.alightAt() + railChangeSec + int64(walkSecsFor(walk, speed))
			for _, s := range byKey[sp.key] {
				if s.Trip == f.Trip || s.boardAt() < ready || s.BoardKey == f.BoardKey {
					continue
				}
				d, _ := endOf(dests, s.Agency, s.AlightStop)
				arrive := s.alightAt() + int64(walkSecsFor(d.WalkM, speed))
				if best < 0 || arrive < bestArrive || (arrive == bestArrive && walk < bestWalk) {
					best, bestLeg, bestWalk, bestArrive = 1, s, walk, arrive
				}
			}
		}
		if best < 0 {
			continue
		}
		d, _ := endOf(dests, bestLeg.Agency, bestLeg.AlightStop)
		out = append(out, railItin{Legs: []railLeg{f, bestLeg}, From: o, To: d, ChangeWalkM: bestWalk,
			Leave: leave, Arrive: bestArrive, WalkM: o.WalkM + d.WalkM + bestWalk})
	}
	for i := range out {
		out[i].WalkSecs = walkSecsFor(out[i].WalkM, speed)
	}
	return pickRailItins(out)
}

// pickRailItins sorts by arrival (then fewer changes, less walking, later
// departure) and drops journeys another one beats: leaving no earlier,
// arriving no later, with no more changes.
func pickRailItins(all []railItin) []railItin {
	sort.SliceStable(all, func(i, j int) bool {
		a, b := all[i], all[j]
		if a.Arrive != b.Arrive {
			return a.Arrive < b.Arrive
		}
		if len(a.Legs) != len(b.Legs) {
			return len(a.Legs) < len(b.Legs)
		}
		if a.WalkM != b.WalkM {
			return a.WalkM < b.WalkM
		}
		return a.Leave > b.Leave
	})
	var out []railItin
	for _, c := range all {
		dominated := false
		for _, k := range out {
			if k.Leave >= c.Leave && k.Arrive <= c.Arrive && len(k.Legs) <= len(c.Legs) {
				dominated = true
				break
			}
		}
		if !dominated {
			out = append(out, c)
		}
		if len(out) == railPlanMaxResults {
			break
		}
	}
	return out
}

// railLegsQuery reads the legs touching the given stops of one timetable,
// on the service days covering [from, to] (absolute unix seconds).
// leaving=true: legs boarding at stops (all later alightings); false: legs
// alighting at stops (all earlier boardings). Platforms of the same parent
// station count as the station.
func (t *rtTimetable) railLegsQuery(ctx context.Context, agency string, stops []string, leaving bool, from, to int64) ([]railLeg, error) {
	if len(stops) == 0 {
		return nil, nil
	}
	ids, err := t.stationPlatforms(ctx, stops)
	if err != nil || len(ids) == 0 {
		return nil, err
	}
	marks := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	var out []railLeg
	start := time.Unix(from, 0).In(madrid)
	for _, back := range []int{1, 0} {
		day := time.Date(start.Year(), start.Month(), start.Day()-back, 12, 0, 0, 0, madrid)
		date := day.Format("20060102")
		ref, err := gtfsServiceDayRef(date)
		if err != nil {
			return nil, err
		}
		lo, hi := from-ref.Unix(), to-ref.Unix()
		col := gtfsWeekdayColumn[day.Weekday()]
		anchor, other, timeCol, cmp := "a", "b", "COALESCE(a.departure_sec, a.arrival_sec)", "b.stop_sequence > a.stop_sequence"
		if !leaving {
			anchor, other, timeCol, cmp = "b", "a", "COALESCE(b.arrival_sec, b.departure_sec)", "a.stop_sequence < b.stop_sequence"
		}
		q := `WITH active(service_id) AS (
		    SELECT service_id FROM calendar WHERE start_date <= ? AND end_date >= ? AND ` + col + ` = 1
		    UNION SELECT service_id FROM calendar_dates WHERE date = ? AND exception_type = 1
		    EXCEPT SELECT service_id FROM calendar_dates WHERE date = ? AND exception_type = 2
		  )
		  SELECT ` + anchor + `.trip_id, COALESCE(NULLIF(r.short_name, ''), r.route_id), COALESCE(tr.headsign, ''), COALESCE(tr.direction_id, -1),
		      a.stop_id, COALESCE(sa.name, a.stop_id), COALESCE(NULLIF(sa.parent_station, ''), a.stop_id), COALESCE(sa.lat, 0), COALESCE(sa.lon, 0),
		      COALESCE(a.departure_sec, a.arrival_sec),
		      b.stop_id, COALESCE(sb.name, b.stop_id), COALESCE(NULLIF(sb.parent_station, ''), b.stop_id), COALESCE(sb.lat, 0), COALESCE(sb.lon, 0),
		      COALESCE(b.arrival_sec, b.departure_sec),
		      b.stop_sequence - a.stop_sequence
		    FROM stop_times ` + anchor + `
		    JOIN trips tr ON tr.trip_id = ` + anchor + `.trip_id
		    JOIN routes r ON r.route_id = tr.route_id
		    JOIN stop_times ` + other + ` ON ` + other + `.trip_id = ` + anchor + `.trip_id AND ` + cmp + `
		    LEFT JOIN stops sa ON sa.stop_id = a.stop_id
		    LEFT JOIN stops sb ON sb.stop_id = b.stop_id
		   WHERE ` + anchor + `.stop_id IN (` + marks + `)
		     AND tr.service_id IN (SELECT service_id FROM active)
		     AND ` + timeCol + ` BETWEEN ? AND ?
		   LIMIT 20000`
		args := []any{date, date, date, date}
		for _, id := range ids {
			args = append(args, id)
		}
		args = append(args, lo, hi)
		rows, err := t.db.QueryContext(ctx, q, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var l railLeg
			var bsec, asec sql.NullInt64
			if err := rows.Scan(&l.Trip, &l.Line, &l.Headsign, &l.Dir,
				&l.BoardStop, &l.BoardName, &l.BoardKey, &l.BoardLat, &l.BoardLon, &bsec,
				&l.AlightStop, &l.AlightName, &l.AlightKey, &l.AlightLat, &l.AlightLon, &asec, &l.Stops); err != nil {
				rows.Close()
				return nil, err
			}
			if !bsec.Valid || !asec.Valid {
				continue
			}
			l.Agency = agency
			l.BoardKey, l.AlightKey = agency+":"+l.BoardKey, agency+":"+l.AlightKey
			l.Board, l.Alight = ref.Unix()+bsec.Int64, ref.Unix()+asec.Int64
			out = append(out, l)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

// stationPlatforms expands stop ids to every platform of their parent station.
func (t *rtTimetable) stationPlatforms(ctx context.Context, stops []string) ([]string, error) {
	seen := map[string]bool{}
	var out []string
	for _, s := range stops {
		rows, err := t.db.QueryContext(ctx, `SELECT stop_id FROM stops WHERE stop_id = ?1
		  UNION SELECT s.stop_id FROM stops s JOIN stops p ON p.stop_id = ?1
		    WHERE COALESCE(p.parent_station, '') != '' AND s.parent_station = p.parent_station
		  UNION SELECT s.stop_id FROM stops s WHERE s.parent_station = ?1`, s)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id string
			if rows.Scan(&id) == nil && !seen[id] {
				seen[id] = true
				out = append(out, id)
			}
		}
		rows.Close()
	}
	sort.Strings(out)
	return out, nil
}

// railEndsFor resolves one end of the journey to stations: a named station
// (from the station search) when there is no point, else the nearest
// stations of each operator within railEndpointNearM of the point.
func railEndsFor(name string, lat, lon float64, hasPoint bool, maxWalk float64) map[string]railEnd {
	ends := map[string]railEnd{}
	if !hasPoint {
		hits := searchRailStations(name, 1)
		if len(hits) == 0 {
			return ends
		}
		h := hits[0].(*Obj)
		// Only a confident match: the station's name, not a fragment of it.
		if fn, fq := foldStationName(h.Str("stopName")), foldStationName(name); fn != fq && !strings.HasPrefix(fn, fq) && !strings.HasSuffix(fn, fq) {
			return ends
		}
		ag, id := h.Str("agencyId"), h.Str("stopId")
		ends[ag+"\x00"+id] = railEnd{Agency: ag, StopID: id, Name: h.Str("stopName"), Lat: h.Num("lat"), Lon: h.Num("lon")}
		return ends
	}
	limit := math.Min(railEndpointNearM, maxWalk)
	for _, info := range reportOperators {
		v, ok := rtCatalog.Load(info.ID)
		if !ok {
			continue
		}
		op := v.(*rtCatalogOp)
		seen := map[string]bool{}
		var near []railEnd
		for _, prof := range op.Profiles {
			for _, d := range prof.Directions {
				for _, st := range d.Stops {
					if seen[st.ID] {
						continue
					}
					seen[st.ID] = true
					if m := distM(lat, lon, st.Lat, st.Lon); m <= limit {
						near = append(near, railEnd{Agency: info.ID, StopID: st.ID, Name: st.Name, Lat: st.Lat, Lon: st.Lon, WalkM: math.Round(m)})
					}
				}
			}
		}
		sort.Slice(near, func(i, j int) bool {
			if near[i].WalkM != near[j].WalkM {
				return near[i].WalkM < near[j].WalkM
			}
			return near[i].StopID < near[j].StopID
		})
		for i, e := range near {
			if i == railEndpointPerOp {
				break
			}
			ends[e.Agency+"\x00"+e.StopID] = e
		}
	}
	return ends
}

// railPlanOp is the worker op behind the planner's train journeys. args:
// from / to (name, and lat/lon when a point), departUnix, walkingSpeed,
// maxWalkingDistance. It answers with the itineraries, ready to merge.
func (k *Worker) railPlanOp(args *Obj) (any, error) {
	speed := orF(jsNumber(args.Get("walkingSpeed")), 80)
	maxWalk := orF(jsNumber(args.Get("maxWalkingDistance")), 2000)
	depart := int64(jsNumber(args.Get("departUnix")))
	end := func(key string) map[string]railEnd {
		o := args.ObjAt(key)
		if o == nil {
			return nil
		}
		lat, lon := jsNumber(o.Get("lat")), jsNumber(o.Get("lon"))
		hasPoint := isFinite(lat) && isFinite(lon) && truthy(o.Get("hasPoint"))
		// Coordinates the visitor sent win; then the text as typed, when it
		// names a station; then the point the street geocoder found.
		if !truthy(o.Get("explicitPoint")) {
			if named := railEndsFor(o.Str("typed"), 0, 0, false, maxWalk); len(named) > 0 {
				return named
			}
		}
		if !hasPoint {
			return nil
		}
		return railEndsFor(o.Str("name"), lat, lon, true, maxWalk)
	}
	origins, dests := end("from"), end("to")
	if len(origins) == 0 || len(dests) == 0 {
		return O("itineraries", []any{}), nil
	}
	// Two points close together (both ends found by coordinates, not by a
	// station name) are a trip across one town: the bus planner's.
	byPoint := func(m map[string]railEnd) bool {
		for _, e := range m {
			if e.WalkM == 0 {
				return false // a named station
			}
		}
		return true
	}
	if byPoint(origins) && byPoint(dests) {
		f, t := args.ObjAt("from"), args.ObjAt("to")
		if distM(jsNumber(f.Get("lat")), jsNumber(f.Get("lon")), jsNumber(t.Get("lat")), jsNumber(t.Get("lon"))) < railPlanMinTripM {
			return O("itineraries", []any{}), nil
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), railPlanQueryTimeout)
	defer cancel()
	byAgency := func(m map[string]railEnd) map[string][]string {
		out := map[string][]string{}
		for _, e := range m {
			out[e.Agency] = append(out[e.Agency], e.StopID)
		}
		return out
	}
	var first, second []railLeg
	for agency, stops := range byAgency(origins) {
		tt, err := k.railTT.get(agency)
		if err != nil {
			continue
		}
		ls, err := tt.railLegsQuery(ctx, agency, stops, true, depart, depart+railPlanLeaveWindow)
		if err != nil {
			return nil, err
		}
		first = append(first, ls...)
	}
	for agency, stops := range byAgency(dests) {
		tt, err := k.railTT.get(agency)
		if err != nil {
			continue
		}
		ls, err := tt.railLegsQuery(ctx, agency, stops, false, depart, depart+railPlanArriveWindow)
		if err != nil {
			return nil, err
		}
		second = append(second, ls...)
	}
	applyLiveRailDelays(first)
	applyLiveRailDelays(second)
	itins := combineRailLegs(first, second, k.expandRailEnds(ctx, origins), k.expandRailEnds(ctx, dests), depart, speed)
	list := make([]any, 0, len(itins))
	for _, it := range itins {
		list = append(list, railItinJSON(it, depart))
	}
	return O("itineraries", list), nil
}

// expandRailEnds keys each end by every platform of its station, since the
// legs name the platform a train calls at.
func (k *Worker) expandRailEnds(ctx context.Context, m map[string]railEnd) map[string]railEnd {
	out := map[string]railEnd{}
	for key, e := range m {
		out[key] = e
		tt, err := k.railTT.get(e.Agency)
		if err != nil {
			continue
		}
		if ids, err := tt.stationPlatforms(ctx, []string{e.StopID}); err == nil {
			for _, id := range ids {
				out[e.Agency+"\x00"+id] = e
			}
		}
	}
	return out
}

// applyLiveRailDelays shifts the legs of trips the operator reports a
// train for by that trip's delay (when plausible); others stay timetable.
func applyLiveRailDelays(legs []railLeg) {
	pp := rtLivePollers.Load()
	if pp == nil {
		return
	}
	snaps := map[string]*rtSnapshot{}
	running := map[string]bool{}
	for _, p := range *pp {
		if s := p.snap.Load(); s != nil {
			snaps[p.src.AgencyID] = s
			for i := range s.Vehicles {
				running[p.src.AgencyID+"\x00"+s.Vehicles[i].TripID] = true
			}
		}
	}
	for i := range legs {
		l := &legs[i]
		s := snaps[l.Agency]
		if s == nil || !running[l.Agency+"\x00"+l.Trip] {
			continue
		}
		if d, ok := s.TripDelays[l.Trip]; ok && int(d) >= railMinDelaySec && int(d) <= railMaxDelaySec {
			l.Delay, l.Live = int64(d), true
		}
	}
}

// railItinJSON writes an itinerary in the planner's response format
// (OPERATIONS.md, "Planner contract"): legs with boardAt / alightAt, walks
// marked approximate (straight lines with a detour factor), timingSource.
func railItinJSON(it railItin, depart int64) *Obj {
	iso := func(u int64) string { return isoString(u * 1000) }
	clock := func(u int64) string { return time.Unix(u, 0).In(madrid).Format("15:04") }
	mins := func(s int64) float64 { return math.Max(0, math.Round(float64(s)/60)) }
	pt := func(lat, lon float64) []any { return []any{lat, lon} }
	stopObj := func(id, name string, lat, lon float64) *Obj {
		return O("id", id, "name", name, "lat", lat, "lon", lon)
	}
	walk := func(fromLat, fromLon, toLat, toLon float64, fromName, toName string, m float64) any {
		if m <= 0 {
			return nil
		}
		secs := math.Round(m * railWalkDetour / 80 * 60)
		return O("from", pt(fromLat, fromLon), "to", pt(toLat, toLon), "fromName", fromName, "toName", toName,
			"distanceMeters", math.Round(m*railWalkDetour), "walkingMinutes", math.Max(1, math.Round(secs/60)),
			"durationSeconds", secs, "polyline", []any{pt(fromLat, fromLon), pt(toLat, toLon)},
			"source", "approximate", "approximate", true)
	}
	legs := []any{}
	live := true
	ride := int64(0)
	stops := 0
	prevAlight := int64(0)
	for i, l := range it.Legs {
		ref := l.Agency + ":" + l.Line
		color := any(nil)
		if v, ok := rtCatalog.Load(l.Agency); ok {
			for _, r := range v.(*rtCatalogOp).Lines {
				if r.Code == l.Line && r.Color != "" {
					color = r.Color
				}
			}
		}
		wait := l.boardAt() - (it.Leave + int64(walkSecsFor(it.From.WalkM, 80)))
		if i > 0 {
			wait = l.boardAt() - prevAlight
		}
		timing := "timetable"
		if l.Live {
			timing = "live"
		} else {
			live = false
		}
		ride += l.alightAt() - l.boardAt()
		stops += l.Stops
		prevAlight = l.alightAt()
		var dir any = nil
		if l.Dir >= 0 {
			dir = numToString(float64(l.Dir))
		}
		legs = append(legs, O(
			"mode", "rail", "agencyId", l.Agency,
			"lineId", ref, "lineCode", l.Line, "lineColor", color, "color", color,
			"direction", dir, "destination", strOrNil(l.Headsign), "tripId", l.Trip,
			"fromStop", stopObj(l.BoardStop, l.BoardName, l.BoardLat, l.BoardLon),
			"toStop", stopObj(l.AlightStop, l.AlightName, l.AlightLat, l.AlightLon),
			"intermediateStops", []any{},
			"polyline", []any{pt(l.BoardLat, l.BoardLon), pt(l.AlightLat, l.AlightLon)},
			"geometryEstimated", true,
			"stopsCount", float64(l.Stops), "stopCount", float64(l.Stops),
			"durationMinutes", mins(l.alightAt()-l.boardAt()), "durationMins", mins(l.alightAt()-l.boardAt()),
			"travelTimeMins", mins(l.alightAt()-l.boardAt()),
			"boardAt", iso(l.boardAt()), "alightAt", iso(l.alightAt()),
			"departureTime", clock(l.boardAt()), "scheduledDepartureTime", clock(l.Board),
			"delayMinutes", mins(l.Delay), "isRealTime", l.Live, "timingSource", timing,
			"waitMinutes", mins(wait), "nextDepartureMinutes", mins(l.boardAt()-depart), "nextDepartureMins", mins(l.boardAt()-depart),
		))
	}
	first, last := it.Legs[0], it.Legs[len(it.Legs)-1]
	kind, transfers := "direct", 0.0
	var transferWalk any = nil
	if len(it.Legs) > 1 {
		kind, transfers = "transfer", 1
		transferWalk = walk(first.AlightLat, first.AlightLon, last.BoardLat, last.BoardLon, first.AlightName, last.BoardName, it.ChangeWalkM)
	}
	timingSource := "timetable"
	if live {
		timingSource = "live"
	}
	total := it.Arrive - depart
	idParts := []string{"rail"}
	for _, l := range it.Legs {
		idParts = append(idParts, l.Agency+":"+l.Line+":"+l.Trip+":"+l.BoardStop+":"+l.AlightStop)
	}
	return O(
		"type", kind, "mode", "rail", "transfersCount", transfers,
		"stopsCount", float64(stops), "stopCount", float64(stops),
		"rideMinutes", mins(ride), "totalDurationMinutes", mins(total), "totalDurationMins", mins(total),
		"originStop", stopObj(first.BoardStop, first.BoardName, first.BoardLat, first.BoardLon),
		"destStop", stopObj(last.AlightStop, last.AlightName, last.AlightLat, last.AlightLon),
		"walkToFirstStop", walk(it.From.Lat, it.From.Lon, first.BoardLat, first.BoardLon, "", first.BoardName, it.From.WalkM),
		"walkFromLastStop", walk(last.AlightLat, last.AlightLon, it.To.Lat, it.To.Lon, last.AlightName, "", it.To.WalkM),
		"legs", legs, "transferWalk", transferWalk,
		"initialWaitMinutes", mins(first.boardAt()-it.Leave-int64(walkSecsFor(it.From.WalkM, 80))),
		"id", strings.Join(idParts, "|"),
		"requestedDepartureAt", iso(depart), "arrivalAt", iso(it.Arrive),
		"notices", []any{},
		"walkingMinutes", mins(int64(it.WalkSecs)), "walkingDistanceMeters", math.Round(it.WalkM*railWalkDetour),
		"waitMinutes", mins(total-ride-int64(it.WalkSecs)),
		"departureTime", clock(first.boardAt()),
		"nextDepartureMinutes", mins(first.boardAt()-depart), "nextDepartureMins", mins(first.boardAt()-depart),
		"isRealTime", live, "isFutureSchedule", false, "timingSource", timingSource,
	)
}

// railPlanFor asks the worker for train journeys between the planner's two
// endpoints (a name, or an *Obj with lat/lon/name after geocoding). Nothing
// when the endpoints are points less than railPlanMinTripM apart: a trip
// across one town is the bus planner's.
func (s *Server) railPlanFor(typedFrom, typedTo, origin, destination any, explicitFrom, explicitTo bool, departMs float64, speed, maxWalk any) []any {
	end := func(typed, v any, explicit bool) *Obj {
		e := O("typed", jsString(or(typed, "")), "explicitPoint", explicit)
		if o, ok := v.(*Obj); ok {
			e.Set("name", jsString(or(o.Get("name"), "")))
			if lat, lon := jsNumber(o.Get("lat")), jsNumber(o.Get("lon")); isFinite(lat) && isFinite(lon) {
				e.Set("lat", lat)
				e.Set("lon", lon)
				e.Set("hasPoint", true)
			}
		} else {
			e.Set("name", jsString(or(v, "")))
		}
		return e
	}
	args := O("from", end(typedFrom, origin, explicitFrom), "to", end(typedTo, destination, explicitTo),
		"departUnix", math.Floor(departMs/1000),
		"walkingSpeed", parseFloatJS(or(speed, "80")), "maxWalkingDistance", parseFloatJS(or(maxWalk, "2000")))
	data, err := s.historyQuery("planRail", args, 10000)
	if err != nil {
		return nil
	}
	o, _ := data.(*Obj)
	if o == nil {
		return nil
	}
	list, _ := o.Get("itineraries").([]any)
	return list
}

const railPlanMinTripM = 3000.0

// mergeRailItineraries adds the train journeys to the bus planner's answer,
// ordered as the preference says (fastest: arrival; least_walking: walking
// then arrival; direct_only: no changes).
func mergeRailItineraries(plan *Obj, rail []any, preference string) {
	if plan == nil || len(rail) == 0 {
		return
	}
	if preference == "direct_only" {
		kept := rail[:0]
		for _, x := range rail {
			if o, _ := x.(*Obj); o != nil && o.Num("transfersCount") == 0 {
				kept = append(kept, x)
			}
		}
		rail = kept
		if len(rail) == 0 {
			return
		}
	}
	all, _ := plan.Get("itineraries").([]any)
	all = append(append([]any{}, all...), rail...)
	key := func(x any) (string, float64) {
		o, _ := x.(*Obj)
		if o == nil {
			return "", 0
		}
		return jsString(o.Get("arrivalAt")), o.Num("walkingDistanceMeters")
	}
	sort.SliceStable(all, func(i, j int) bool {
		ai, wi := key(all[i])
		aj, wj := key(all[j])
		if preference == "least_walking" && wi != wj {
			return wi < wj
		}
		return ai < aj
	})
	plan.Set("itineraries", all)
	plan.Set("count", float64(len(all)))
	if !truthy(plan.Get("success")) {
		plan.Set("success", true)
		plan.Delete("error")
	}
}

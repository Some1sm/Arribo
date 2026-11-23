package main

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

// railTestFeed: line L6 with a short and a long trip in direction 0 (the
// long one has a shape), one trip in direction 1 without a shape.
func railTestFeed() map[string]string {
	return map[string]string{
		"agency.txt": "agency_id,agency_name,agency_url,agency_timezone\n" +
			"FGC,FGC,http://example.com,Europe/Madrid\n",
		"routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_color\n" +
			"RL6,FGC,L6,Sarrià   -   Pl. Catalunya,1,7C7CBF,FFFFFF\n",
		"trips.txt": "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\n" +
			"RL6,S,short,Gràcia,0,\n" +
			"RL6,S,long,Pl. Catalunya,0,SH\n" +
			"RL6,S,back,,1,\n",
		"stops.txt": "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n" +
			"A,Sarrià,41.40,2.12,0,\n" +
			"B,Gràcia,41.39,2.15,0,\n" +
			"C,Pl. Catalunya,41.38,2.17,0,\n",
		"stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n" +
			"short,08:00:00,08:00:00,A,1\nshort,08:05:00,08:05:00,B,2\n" +
			"long,09:00:00,09:00:00,A,1\nlong,09:05:00,09:05:00,B,2\nlong,09:09:00,09:09:00,C,3\n" +
			"back,10:00:00,10:00:00,C,1\nback,10:09:00,10:09:00,A,2\n",
		"calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n" +
			"S,1,1,1,1,1,1,1,20260101,20271231\n",
		"shapes.txt": "shape_id,shape_pt_sequence,shape_pt_lat,shape_pt_lon\n" +
			"SH,1,41.40,2.12\nSH,2,41.395,2.135\nSH,3,41.39,2.15\nSH,4,41.38,2.17\n",
	}
}

func openRailTestTimetable(t *testing.T) *rtTimetable {
	t.Helper()
	dir := t.TempDir()
	zipPath, out := filepath.Join(dir, "fgc.zip"), filepath.Join(dir, "fgc.db")
	writeTestZip(t, zipPath, railTestFeed())
	if code := runGtfsImport([]string{"fgc", zipPath, out}); code != 0 {
		t.Fatalf("import exit %d", code)
	}
	tt, err := openRtTimetable(out)
	if err != nil || tt == nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = tt.db.Close() })
	return tt
}

func TestLineProfiles(t *testing.T) {
	tt := openRailTestTimetable(t)
	ctx := context.Background()
	profs, err := tt.lineProfiles(ctx)
	if err != nil || len(profs) != 1 || profs[0].Code != "L6" || len(profs[0].Directions) != 2 {
		t.Fatalf("profiles: %+v %v", profs, err)
	}
	d0, d1 := profs[0].Directions[0], profs[0].Directions[1]
	if len(d0.Stops) != 3 || d0.Stops[2].Name != "Pl. Catalunya" || d0.Headsign != "Pl. Catalunya" || d0.Trips != 2 {
		t.Errorf("direction 0 should be the longest trip: %+v", d0)
	}
	if d0.GeometryFromStops || len(d0.Geometry) != 4 {
		t.Errorf("direction 0 should use the shape: %+v", d0.Geometry)
	}
	if !d1.GeometryFromStops || len(d1.Geometry) != 2 || d1.Headsign != "Sarrià" {
		t.Errorf("direction 1: stop geometry and headsign from the last stop: %+v", d1)
	}
	if got := tt.tripDirection(ctx, "back"); got != 1 {
		t.Errorf("tripDirection(back) = %d", got)
	}
	if got := tt.tripDirection(ctx, "nope"); got != -1 {
		t.Errorf("tripDirection(unknown) = %d", got)
	}
}

func storeRailTestCatalog(t *testing.T) {
	t.Helper()
	tt := openRailTestTimetable(t)
	ctx := context.Background()
	routes, err := tt.catalogRoutes(ctx)
	if err != nil {
		t.Fatal(err)
	}
	profs, err := tt.lineProfiles(ctx)
	if err != nil {
		t.Fatal(err)
	}
	op := &rtCatalogOp{AgencyID: "fgc", Mode: "rail", Lines: routes, Profiles: map[string]*rtLineProfile{}}
	for i := range profs {
		op.Profiles[profs[i].Code] = &profs[i]
	}
	rtCatalog.Store("fgc", op)
	t.Cleanup(func() { rtCatalog.Delete("fgc") })
}

func TestRailLineRef(t *testing.T) {
	storeRailTestCatalog(t)
	for in, want := range map[any]string{"fgc:L6": "L6", "FGC:l6": "L6", "fgc:L7": "", "L6": "", "6": "", "mataro:6": "", "fgc:": "", ":L6": "", 6.0: ""} {
		_, _, code, ok := railLineRef(in)
		if code != want || ok != (want != "") {
			t.Errorf("railLineRef(%v) = %q %v, want %q", in, code, ok, want)
		}
	}
}

func TestRailLineDetails(t *testing.T) {
	storeRailTestCatalog(t)
	info, op, code, ok := railLineRef("fgc:L6")
	if !ok {
		t.Fatal("not resolved")
	}
	now := time.Unix(1_800_000_000, 0)
	snap := &rtSnapshot{AgencyID: "fgc", FetchedAt: now, Vehicles: []rtVehicle{
		{TripID: "long", LineCode: "L6", DirectionID: 0, Lat: 41.39, Lon: 2.15, StopName: "Gràcia", ObservedAt: now.Unix() - 10, DelaySec: i32(120), HasDelayFromTripUpdate: true, DelayComputed: true},
		{TripID: "back", LineCode: "L6", DirectionID: 1, Lat: 41.385, Lon: 2.16, ObservedAt: now.Unix() - 15},
		{TripID: "old", LineCode: "L6", DirectionID: 0, Lat: 41.4, Lon: 2.12, ObservedAt: now.Unix() - 900},
		{TripID: "nodir", LineCode: "L6", DirectionID: -1, Lat: 41.39, Lon: 2.14, ObservedAt: now.Unix() - 5},
		{TripID: "other", LineCode: "S1", DirectionID: 0, Lat: 41.5, Lon: 2.0, ObservedAt: now.Unix() - 5},
	}}
	feeds := []trainFeed{{info: info, snap: snap}}

	d := railLineDetails(info, op, code, "0", feeds, now)
	for k, v := range map[string]any{
		"lineId": "fgc:L6", "code": "L6", "name": "Sarrià - Pl. Catalunya", "color": "#7C7CBF", "agencyId": "fgc",
		"direction": "0", "directionName": "Cap a Pl. Catalunya", "totalStops": 3.0, "geometrySource": "gtfs_shape",
		"geometryEstimated": false, "secondaryCoords": nil,
	} {
		if got := d.Get(k); got != v {
			t.Errorf("%s = %v, want %v", k, got, v)
		}
	}
	buses := d.Get("activeBuses").([]any)
	if len(buses) != 1 {
		t.Fatalf("direction 0 trains: %s", string(toJSON(buses)))
	}
	b := buses[0].(*Obj)
	if b.Get("tripId") != "long" || b.Get("direction") != "0" || b.Get("destination") != "Pl. Catalunya" ||
		b.Get("delayMinutes") != 2.0 || b.Get("delaySource") != "timetable" || b.Get("isRealTime") != true || b.Get("lineId") != "fgc:L6" {
		t.Errorf("train: %s", string(toJSON(b)))
	}
	if rd := d.Get("railData").(*Obj); rd.Get("staleTrains") != 1.0 || rd.Get("profileAvailable") != true {
		t.Errorf("railData: %s", string(toJSON(rd)))
	}
	stop := d.Get("stops").([]any)[0].(*Obj)
	if stop.Get("id") != "A" || stop.Get("lat") != 41.40 || stop.Get("seq") != 1.0 {
		t.Errorf("stop: %s", string(toJSON(stop)))
	}

	both := railLineDetails(info, op, code, "both", feeds, now)
	if both.Get("direction") != "both" || both.Get("geometrySource") != "gtfs_stops" || both.Get("geometryEstimated") != true {
		t.Errorf("both: %v %v %v", both.Get("direction"), both.Get("geometrySource"), both.Get("geometryEstimated"))
	}
	if n := len(both.Get("activeBuses").([]any)); n != 3 { // long, back, nodir (not old: stale; not other: S1)
		t.Errorf("both trains: %d", n)
	}
	if n := len(both.Get("allDirections").([]any)); n != 2 {
		t.Errorf("allDirections: %d", n)
	}

	// An unknown direction falls back to the first one; no feeds is no trains.
	d9 := railLineDetails(info, op, code, "9", nil, now)
	if d9.Get("direction") != "0" || len(d9.Get("activeBuses").([]any)) != 0 || d9.Get("railData").(*Obj).Get("liveFeed") != false {
		t.Errorf("fallback: %v", string(toJSON(d9)))
	}
}

func TestRailDelayLabel(t *testing.T) {
	cases := []struct {
		mins      any
		discarded bool
		status    string
		label     string
	}{
		{nil, false, "unknown", "Sense dada de retard"},
		{3.0, true, "unknown", "Previsió no fiable"},
		{0.0, false, "on_time", "A l'hora"},
		{4.0, false, "on_time", "+4 min"},
		{-1.0, false, "on_time", "−1 min"},
		{6.0, false, "delayed", "+6 min"},
		{-3.0, false, "early", "−3 min"},
	}
	for _, c := range cases {
		if st, lb := railDelayLabel(c.mins, c.discarded); st != c.status || lb != c.label {
			t.Errorf("%v/%v -> %q %q, want %q %q", c.mins, c.discarded, st, lb, c.status, c.label)
		}
	}
}

func openRailTestTimetableWith(t *testing.T, feed map[string]string) *rtTimetable {
	t.Helper()
	dir := t.TempDir()
	zipPath, out := filepath.Join(dir, "fgc.zip"), filepath.Join(dir, "fgc.db")
	writeTestZip(t, zipPath, feed)
	if code := runGtfsImport([]string{"fgc", zipPath, out}); code != 0 {
		t.Fatalf("import exit %d", code)
	}
	tt, err := openRtTimetable(out)
	if err != nil || tt == nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = tt.db.Close() })
	return tt
}

func TestRailDepartures(t *testing.T) {
	feed := railTestFeed()
	feed["trips.txt"] += "RL6,S,late,Pl. Catalunya,0,\nRL6,X,holiday,Pl. Catalunya,0,\n"
	feed["stop_times.txt"] += "late,24:30:00,24:30:00,A,1\nlate,24:40:00,24:40:00,B,2\n" +
		"holiday,09:30:00,09:30:00,A,1\nholiday,09:40:00,09:40:00,B,2\n"
	// Service X runs every day but is removed on Monday 2026-11-23.
	feed["calendar.txt"] += "X,1,1,1,1,1,1,1,20260101,20271231\n"
	feed["calendar_dates.txt"] = "service_id,date,exception_type\nX,20261123,2\n"
	tt := openRailTestTimetableWith(t, feed)
	ctx := context.Background()
	at := func(s string) time.Time {
		v, err := time.ParseInLocation("2006-01-02 15:04", s, madrid)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	ids := func(d []railDeparture) []string {
		out := []string{}
		for _, x := range d {
			out = append(out, x.TripID+"@"+time.Unix(x.DepartUnix, 0).In(madrid).Format("15:04"))
		}
		return out
	}

	// Monday 08:50: "long" at 09:00 (the removed "holiday" is not listed;
	// "short" left at 08:00; "back" ends at A, which is not a departure).
	d, err := tt.departures(ctx, "L6", "A", -1, at("2026-11-23 08:50"))
	if err != nil || len(d) != 1 || ids(d)[0] != "long@09:00" {
		t.Errorf("monday: %v %v", ids(d), err)
	}
	// Tuesday the holiday service runs again.
	d, _ = tt.departures(ctx, "L6", "A", -1, at("2026-11-24 08:50"))
	if got := ids(d); len(got) != 2 || got[0] != "long@09:00" || got[1] != "holiday@09:30" {
		t.Errorf("tuesday: %v", got)
	}
	// Tuesday 00:20: Monday's 24:30 trip, found on the previous service day.
	d, _ = tt.departures(ctx, "L6", "A", -1, at("2026-11-24 00:20"))
	if got := ids(d); len(got) != 1 || got[0] != "late@00:30" {
		t.Errorf("after midnight: %v", got)
	}
	// Direction filter, and "back" leaving C in direction 1.
	if d, _ = tt.departures(ctx, "L6", "A", 1, at("2026-11-23 08:50")); len(d) != 0 {
		t.Errorf("direction 1 at A: %v", ids(d))
	}
	if d, _ = tt.departures(ctx, "L6", "C", 1, at("2026-11-23 09:55")); len(d) != 1 || d[0].TripID != "back" || d[0].DirectionID != 1 {
		t.Errorf("back at C: %v", ids(d))
	}
}

func TestRailDeparturesResponse(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	sched := []any{
		O("tripId", "live", "headsign", "Pl. Catalunya", "directionId", 0.0, "departUnix", float64(now.Unix()+300)),
		O("tripId", "plain", "headsign", "Pl. Catalunya", "directionId", 0.0, "departUnix", float64(now.Unix()+600)),
		O("tripId", "gone", "headsign", "Pl. Catalunya", "directionId", 0.0, "departUnix", float64(now.Unix()-600)),
		O("tripId", "weird", "headsign", "", "directionId", 1.0, "departUnix", float64(now.Unix()+900)),
		// In the trip updates with a delay of 0, but no train running yet.
		O("tripId", "notStarted", "headsign", "Pl. Catalunya", "directionId", 0.0, "departUnix", float64(now.Unix()+5400)),
	}
	snap := &rtSnapshot{
		Vehicles:      []rtVehicle{{TripID: "live"}, {TripID: "gone"}, {TripID: "weird"}},
		TripDelays:    map[string]int32{"live": 120, "gone": 60, "weird": -40 * 60, "notStarted": 0},
		ComputedTrips: map[string]bool{"live": true},
	}
	o := railDeparturesResponse(reportOperators[1], rtLineStop{ID: "A", Name: "Sarrià", Lat: 41.4, Lon: 2.12}, sched, snap, nil, now)
	deps := o.Get("departures").([]any)
	if ns := deps[len(deps)-1].(*Obj); ns.Get("tripId") != "notStarted" || ns.Get("isRealTime") != false || ns.Get("delayMins") != nil || ns.Get("delayStatus") != "scheduled" {
		t.Errorf("a trip with no train running is timetable only: %s", string(toJSON(ns)))
	}
	deps = deps[:len(deps)-1]
	if len(deps) != 3 {
		t.Fatalf("departures: %s", string(toJSON(o)))
	}
	live, plain, weird := deps[0].(*Obj), deps[1].(*Obj), deps[2].(*Obj)
	if live.Get("isRealTime") != true || live.Get("delayMins") != 2.0 || live.Get("minutesAway") != 7.0 || live.Get("delaySource") != "timetable" || live.Get("delayBadgeText") != "+2 min" {
		t.Errorf("live: %s", string(toJSON(live)))
	}
	if plain.Get("isRealTime") != false || plain.Get("isTheoretical") != true || plain.Get("delayMins") != nil || plain.Get("delayBadgeText") != "Horari" || plain.Get("delayStatus") != "scheduled" {
		t.Errorf("timetable only: %s", string(toJSON(plain)))
	}
	if weird.Get("delayDiscarded") != true || weird.Get("delayBadgeText") != "Previsió no fiable" || weird.Get("destination") != nil || weird.Get("direction") != "1" {
		t.Errorf("discarded: %s", string(toJSON(weird)))
	}
	if stop := o.Get("stop").(*Obj); stop.Get("name") != "Sarrià" {
		t.Errorf("stop: %s", string(toJSON(stop)))
	}
}

// TestRailDeparturesCancelled: a trip the operator cancelled is listed as
// cancelled, not live and not timetable.
func TestRailDeparturesCancelled(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	sched := []any{O("tripId", "gone", "headsign", "Pl. Catalunya", "directionId", 0.0, "departUnix", float64(now.Unix()+600))}
	snap := &rtSnapshot{Vehicles: []rtVehicle{{TripID: "gone"}}, TripDelays: map[string]int32{"gone": 120}, Canceled: map[string]bool{"gone": true}}
	o := railDeparturesResponse(reportOperators[1], rtLineStop{ID: "A", Name: "Sarrià"}, sched, snap, nil, now)
	d := o.Get("departures").([]any)[0].(*Obj)
	if d.Get("isCancelled") != true || d.Get("delayStatus") != "cancelled" || d.Get("isRealTime") != false || d.Get("delayMins") != nil || d.Get("isTheoretical") != false {
		t.Errorf("cancelled: %s", string(toJSON(d)))
	}
}

// TestRailDeparturesPlatform: the timetable's platform, replaced by the one
// the live trip update names (marked changed); none when the operator
// gives none.
func TestRailDeparturesPlatform(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	sched := []any{
		O("tripId", "same", "headsign", "X", "directionId", 0.0, "departUnix", float64(now.Unix()+300), "stopId", "GR1", "platform", "1"),
		O("tripId", "moved", "headsign", "X", "directionId", 0.0, "departUnix", float64(now.Unix()+600), "stopId", "GR1", "platform", "1"),
		O("tripId", "plain", "headsign", "X", "directionId", 0.0, "departUnix", float64(now.Unix()+900), "stopId", "GR2", "platform", "2"),
		O("tripId", "renfe", "headsign", "X", "directionId", 0.0, "departUnix", float64(now.Unix()+1200), "stopId", "79500", "platform", ""),
	}
	// Other stations' stops come first: they must not be taken for a platform here.
	snap := &rtSnapshot{TripStops: map[string][]string{"same": {"SR1", "GR1", "PC1"}, "moved": {"SR2", "GR3"}, "plain": {"PC2"}}}
	platforms := O("GR1", "1", "GR2", "2", "GR3", "3")
	deps := railDeparturesResponse(reportOperators[1], rtLineStop{ID: "GR1", Name: "Gràcia"}, sched, snap, platforms, now).Get("departures").([]any)
	get := func(i int, k string) any { return deps[i].(*Obj).Get(k) }
	if get(0, "platform") != "1" || get(0, "platformSource") != "live" || get(0, "platformChanged") != false {
		t.Errorf("confirmed: %s", toJSON(deps[0]))
	}
	if get(1, "platform") != "3" || get(1, "platformChanged") != true || get(1, "scheduledPlatform") != "1" {
		t.Errorf("moved: %s", toJSON(deps[1]))
	}
	if get(2, "platform") != "2" || get(2, "platformSource") != "timetable" {
		t.Errorf("timetable: %s", toJSON(deps[2]))
	}
	if get(3, "platform") != nil || get(3, "platformSource") != nil {
		t.Errorf("no platform: %s", toJSON(deps[3]))
	}
}

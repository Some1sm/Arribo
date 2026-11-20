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

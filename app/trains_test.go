package main

import (
	"strings"
	"testing"
	"time"
)

func i32(v int32) *int32 { return &v }

func testTrainFeeds(now time.Time) []trainFeed {
	renfe := &rtSnapshot{
		AgencyID: "renfe_rodalies", FetchedAt: now.Add(-10 * time.Second),
		FeedTimestamp: uint64(now.Unix() - 40),
		Vehicles: []rtVehicle{
			{ // fresh, delay sent by the feed
				AgencyID: "renfe_rodalies", Mode: "rail", VehicleID: "28385", Label: "R2S-28385",
				TripID: "t1", RouteID: "r1", LineCode: "R2S", StopID: "71802", StopName: "Sant Vicenç de Calders",
				CurrentStatus: "IN_TRANSIT_TO", Lat: 41.2, Lon: 0, ObservedAt: now.Unix() - 20,
				DelaySec: i32(150), HasDelayFromTripUpdate: true,
			},
			{ // stale, impossible early delay
				AgencyID: "renfe_rodalies", Mode: "rail", VehicleID: "99", Label: "R1-99",
				TripID: "t2", LineCode: "R1", Lat: 41.5, Lon: 2.4, ObservedAt: now.Unix() - 600,
				DelaySec: i32(-30 * 60), HasDelayFromTripUpdate: true,
			},
		},
	}
	fgc := &rtSnapshot{
		AgencyID: "fgc", FetchedAt: now.Add(-5 * time.Second), VehiclesErr: "HTTP 503",
		Vehicles: []rtVehicle{
			{ // no vehicle timestamp, no feed timestamp: age unknown; computed delay
				AgencyID: "fgc", Mode: "rail", TripID: "f1", LineCode: "S1", Lat: 41.4, Lon: 2.1,
				DelaySec: i32(61), HasDelayFromTripUpdate: true, DelayComputed: true,
			},
		},
	}
	return []trainFeed{
		{info: reportOperators[0], snap: renfe},
		{info: reportOperators[1], snap: fgc},
	}
}

func trainsOf(t *testing.T, o *Obj) []*Obj {
	t.Helper()
	raw, ok := o.Get("trains").([]any)
	if !ok {
		t.Fatalf("trains is %T", o.Get("trains"))
	}
	out := make([]*Obj, len(raw))
	for i, r := range raw {
		out[i] = r.(*Obj)
	}
	return out
}

func TestTrainsResponseFields(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	o := trainsResponse(testTrainFeeds(now), now, "", "", nil)
	if o.Get("enabled") != true || o.Get("count") != 3.0 {
		t.Fatalf("enabled/count: %v %v", o.Get("enabled"), o.Get("count"))
	}
	tr := trainsOf(t, o)

	fresh := tr[0]
	want := map[string]any{
		"id": "renfe_rodalies:28385", "lineCode": "R2S", "lat": 41.2, "lon": 0.0,
		"latitude": 41.2, "longitude": 0.0, // a zero coordinate survives
		"ageSec": 20.0, "stale": false, "isRealTime": true, "isEstimated": false, "isTheoretical": false,
		"positionTimeSource": "vehicle", "delaySec": 150.0, "delayMins": 3.0, "delaySource": "feed",
		"delayDiscarded": false, "stopName": "Sant Vicenç de Calders", "observedAt": float64(now.Unix()-20) * 1000,
	}
	for k, v := range want {
		if got := fresh.Get(k); got != v {
			t.Errorf("fresh %s = %v (%T), want %v", k, got, got, v)
		}
	}

	stale := tr[1]
	if stale.Get("stale") != true || stale.Get("isRealTime") != false || stale.Get("ageSec") != 600.0 {
		t.Errorf("stale train: stale=%v rt=%v age=%v", stale.Get("stale"), stale.Get("isRealTime"), stale.Get("ageSec"))
	}
	if stale.Get("delayDiscarded") != true || stale.Get("delaySec") != nil || stale.Get("delaySource") != nil {
		t.Errorf("impossible delay not dropped: %v %v %v", stale.Get("delayDiscarded"), stale.Get("delaySec"), stale.Get("delaySource"))
	}

	unknown := tr[2]
	if unknown.Get("id") != "fgc:f1" || unknown.Get("ageSec") != nil || unknown.Get("stale") != true ||
		unknown.Get("isRealTime") != false || unknown.Get("positionTimeSource") != nil {
		t.Errorf("unknown-age train: %v", string(toJSON(unknown)))
	}
	if unknown.Get("delaySource") != "timetable" || unknown.Get("delayMins") != 1.0 {
		t.Errorf("computed delay: %v %v", unknown.Get("delaySource"), unknown.Get("delayMins"))
	}

	ops := o.Get("operators").([]any)
	if len(ops) != 2 {
		t.Fatalf("operators: %d", len(ops))
	}
	r, f := ops[0].(*Obj), ops[1].(*Obj)
	if r.Get("vehicles") != 2.0 || r.Get("fetchAgeSec") != 10.0 || r.Get("feedTimestamp") != float64(now.Unix()-40)*1000 {
		t.Errorf("renfe op: %v", string(toJSON(r)))
	}
	if !strings.Contains(r.Get("attribution").(string), "Renfe") || f.Get("vehiclesError") != "HTTP 503" || f.Get("feedTimestamp") != nil {
		t.Errorf("fgc op: %v", string(toJSON(f)))
	}
}

func TestTrainsResponseFilters(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	feeds := testTrainFeeds(now)
	if o := trainsResponse(feeds, now, "fgc", "", nil); o.Get("count") != 1.0 || len(o.Get("operators").([]any)) != 1 {
		t.Errorf("agency filter: %v", string(toJSON(o)))
	}
	if o := trainsResponse(feeds, now, "", "r2s", nil); o.Get("count") != 1.0 || trainsOf(t, o)[0].Get("lineCode") != "R2S" {
		t.Errorf("line filter: %v", string(toJSON(o)))
	}
	if o := trainsResponse(feeds, now, "nope", "", nil); o.Get("count") != 0.0 || len(o.Get("operators").([]any)) != 0 {
		t.Errorf("unknown agency: %v", string(toJSON(o)))
	}
	off := trainsResponse(nil, now, "", "", nil)
	if off.Get("enabled") != false || off.Get("count") != 0.0 {
		t.Errorf("pollers off: %v", string(toJSON(off)))
	}
	if !strings.HasPrefix(string(toJSON(off)), `{"success":true,"enabled":false,`) {
		t.Errorf("key order: %s", string(toJSON(off)))
	}
	// Before the first poll an operator is listed with no data.
	o := trainsResponse([]trainFeed{{info: reportOperators[1]}}, now, "", "", nil)
	if op := o.Get("operators").([]any)[0].(*Obj); op.Get("vehicles") != 0.0 || op.Get("fetchedAt") != nil {
		t.Errorf("no snapshot yet: %v", string(toJSON(o)))
	}
}

func TestCatalogLineFromLabel(t *testing.T) {
	rtCatalog.Store("test_op", &rtCatalogOp{AgencyID: "test_op", Lines: []rtRoute{{Code: "R2S"}, {Code: "R1"}}})
	defer rtCatalog.Delete("test_op")
	cases := map[string]string{"R2S-28385": "R2S", "R1-7": "R1", "R9-1": "", "R2S": "", "-5": "", "": ""}
	for label, want := range cases {
		if got := catalogLineFromLabel("test_op", label); got != want {
			t.Errorf("%q -> %q, want %q", label, got, want)
		}
	}
	if got := catalogLineFromLabel("missing_op", "R1-7"); got != "" {
		t.Errorf("unknown operator -> %q", got)
	}
}

func TestTrainsBox(t *testing.T) {
	now := time.Unix(1795100000, 0)
	feeds := testTrainFeeds(now)
	all := trainsResponse(feeds, now, "", "", nil).Get("count")
	// Around Mataró (41.5, 2.4): only the R1 train; the operators keep their totals.
	o := trainsResponse(feeds, now, "", "", parseTrainBox("41.45,2.3,41.6,2.5"))
	if o.Get("count") != 1.0 || trainsOf(t, o)[0].Get("lineCode") != "R1" {
		t.Fatalf("box around Mataró: count=%v", o.Get("count"))
	}
	if ops := o.Get("operators").([]any); ops[0].(*Obj).Get("vehicles") == 0.0 {
		t.Fatal("an operator's vehicle total must not shrink with the box")
	}
	if b := o.Get("bbox").([]any); len(b) != 4 || b[0] != 41.45 {
		t.Fatalf("bbox echo: %v", o.Get("bbox"))
	}
	// The zero longitude of the first train is inside a box that spans it.
	if o := trainsResponse(feeds, now, "", "", parseTrainBox("41,-0.5,41.3,0.5")); o.Get("count") != 1.0 {
		t.Fatalf("box spanning lon 0: count=%v", o.Get("count"))
	}
	// Invalid boxes are no filter.
	for _, s := range []string{"", "1,2,3", "a,b,c,d", "41.6,2,41.4,3", "0,0,100,0", "NaN,0,1,1"} {
		if parseTrainBox(s) != nil {
			t.Fatalf("%q should not parse", s)
		}
		if o := trainsResponse(feeds, now, "", "", parseTrainBox(s)); o.Get("count") != all || o.Get("bbox") != nil {
			t.Fatalf("%q filtered: count=%v", s, o.Get("count"))
		}
	}
}

func TestTrainStaleAfter(t *testing.T) {
	if trainStaleAfter("fgc") != 300 || trainStaleAfter("renfe_rodalies") != 180 || trainStaleAfter("other") != trainStaleSec {
		t.Errorf("bounds: fgc %v renfe %v other %v", trainStaleAfter("fgc"), trainStaleAfter("renfe_rodalies"), trainStaleAfter("other"))
	}
}

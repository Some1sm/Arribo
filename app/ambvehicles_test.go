package main

import (
	"testing"
	"time"
)

func TestAmbDirFromRoute(t *testing.T) {
	for in, want := range map[string]int{"11940001": 1, "11950002": 2, "11920201": 1, "": 0} {
		if got := ambDirFromRoute(in); got != want {
			t.Errorf("ambDirFromRoute(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestAmbNormLine(t *testing.T) {
	for in, want := range map[string]string{"C-10": "c10", " e11.1 ": "e11.1", "865": "865"} {
		if got := ambNormLine(in); got != want {
			t.Errorf("ambNormLine(%q) = %q, want %q", in, got, want)
		}
	}
}

// movVehiclesWithAMB: a line AMB has live is shown as measured GPS (its
// estimated buses dropped); a line AMB lacks keeps its estimate.
func TestMovVehiclesWithAMBOverlay(t *testing.T) {
	// Static: two lines, C-10 (id 53) and C-30 (id 59), one route each.
	mk := func(id int, code string) movRoute {
		return movRoute{LineID: id, Trayecto: 1, Dest: "BCN", Stops: []movStop{
			{ID: 1, Name: "A", Lat: 41.50, Lon: 2.40, Km: 0},
			{ID: 2, Name: "B", Lat: 41.51, Lon: 2.41, Km: 1.2},
		}}
	}
	s := &movStatic{
		Lines:  map[int]movLine{53: {ID: 53, Code: "C-10"}, 59: {ID: 59, Code: "C-30"}},
		Routes: map[int][]movRoute{53: {mk(53, "C-10")}, 59: {mk(59, "C-30")}},
	}
	now := time.Now()
	// A prediction at stop 2 (1.2 km): the bus sits on the route, before it.
	preds := map[[3]int]movPrediction{
		{53, 1, 2}: {LineID: 53, Trayecto: 1, StopID: 2, EtaSec: []float64{60}, At: now},
		{59, 1, 2}: {LineID: 59, Trayecto: 1, StopID: 2, EtaSec: []float64{60}, At: now},
	}

	// No AMB snapshot: both lines estimated.
	ambVehLive.Store(nil)
	base := movVehiclesWithAMB(s, []int{53, 59}, preds, now)
	if n := countReal(base, true); n != 0 {
		t.Fatalf("no AMB: want 0 measured, got %d", n)
	}
	if len(base) == 0 {
		t.Fatal("no AMB: expected estimated buses")
	}

	// AMB has C-10 live, not C-30.
	p := &ambVehPoller{}
	p.snap.Store(&ambVehSnapshot{At: now, ByLine: map[string][]ambVeh{
		"c10": {{Line: "C-10", Dir: 1, Lat: 41.505, Lon: 2.405, VehID: "1102"}}},
	})
	ambVehLive.Store(p)
	t.Cleanup(func() { ambVehLive.Store(nil) })

	out := movVehiclesWithAMB(s, []int{53, 59}, preds, now)
	var c10meas, c10est, c30est int
	for _, v := range out {
		o := v.(*Obj)
		code := jsString(o.Get("lineCode"))
		real := truthy(o.Get("isRealTime"))
		switch {
		case code == "C-10" && real:
			c10meas++
			if jsString(o.Get("positionSource")) != "operator_gps" {
				t.Errorf("C-10 measured bus positionSource = %v", o.Get("positionSource"))
			}
			if o.Num("lat") != jsRound(41.505*1e6)/1e6 {
				t.Errorf("C-10 measured lat = %v", o.Get("lat"))
			}
		case code == "C-10" && !real:
			c10est++
		case code == "C-30" && !real:
			c30est++
		}
	}
	if c10meas != 1 {
		t.Errorf("want 1 measured C-10, got %d", c10meas)
	}
	if c10est != 0 {
		t.Errorf("estimated C-10 must be dropped while AMB is live, got %d", c10est)
	}
	if c30est == 0 {
		t.Error("C-30 (no AMB) must keep its estimate")
	}

	// A stale AMB snapshot is ignored.
	p.snap.Store(&ambVehSnapshot{At: now.Add(-5 * time.Minute), ByLine: map[string][]ambVeh{
		"c10": {{Line: "C-10", Dir: 1, Lat: 41.505, Lon: 2.405, VehID: "1102"}}},
	})
	if n := countReal(movVehiclesWithAMB(s, []int{53, 59}, preds, now), true); n != 0 {
		t.Errorf("stale AMB snapshot: want 0 measured, got %d", n)
	}
}

func countReal(vs []any, real bool) int {
	n := 0
	for _, v := range vs {
		if o, _ := v.(*Obj); o != nil && truthy(o.Get("isRealTime")) == real {
			n++
		}
	}
	return n
}

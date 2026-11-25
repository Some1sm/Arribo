package main

import (
	"path/filepath"
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

func TestAmbDeadReckoningAndPerDirectionCoverage(t *testing.T) {
	rt1 := movRoute{LineID: 53, Trayecto: 1, Dest: "BCN", Stops: []movStop{
		{ID: 1, Name: "A", Lat: 41.50, Lon: 2.40, Km: 0},
		{ID: 2, Name: "B", Lat: 41.45, Lon: 2.35, Km: 7.0},
	}}
	rt2 := movRoute{LineID: 53, Trayecto: 2, Dest: "MATARO", Stops: []movStop{
		{ID: 3, Name: "B", Lat: 41.45, Lon: 2.35, Km: 0},
		{ID: 4, Name: "A", Lat: 41.50, Lon: 2.40, Km: 7.0},
	}}
	s := &movStatic{
		Lines:  map[int]movLine{53: {ID: 53, Code: "C-10"}},
		Routes: map[int][]movRoute{53: {rt1, rt2}},
	}
	t0 := time.Now()
	p := &ambVehPoller{}
	// T+0: AMB sees bus 1104 on dir 1 near start of route.
	p.mergeAndSnapshot([]ambVeh{{Line: "C-10", Dir: 1, Lat: 41.495, Lon: 2.395, VehID: "1104", ObservedAt: t0}}, t0)
	// T+3m: AMB drops C-10 (empty poll), but poller keeps 1104 carried.
	t3 := t0.Add(3 * time.Minute)
	byLine := p.mergeAndSnapshot(nil, t3)
	p.snap.Store(&ambVehSnapshot{At: t3, ByLine: byLine})
	ambVehLive.Store(p)
	t.Cleanup(func() { ambVehLive.Store(nil) })

	// Opposite direction (Trayecto 2) has a moventis prediction at stop 4.
	preds := map[[3]int]movPrediction{
		{53, 2, 4}: {LineID: 53, Trayecto: 2, StopID: 4, EtaSec: []float64{120}, At: t3},
	}
	out := movVehiclesWithAMB(s, []int{53}, preds, t3)
	var gotExtrap, gotDir1Est bool
	for _, raw := range out {
		o := raw.(*Obj)
		src := jsString(o.Get("positionSource"))
		if src == "gps_extrapolated" {
			gotExtrap = true
			if truthy(o.Get("isRealTime")) || !truthy(o.Get("isEstimated")) {
				t.Errorf("extrapolated bus must have isRealTime=false, isEstimated=true")
			}
			// Must have advanced south-west from 41.495 toward 41.45.
			if o.Num("lat") >= 41.495 {
				t.Errorf("extrapolated bus did not advance along route: lat=%v", o.Num("lat"))
			}
		}
		if src == "stop_predictions" && jsString(o.Get("directionId")) == "1" {
			gotDir1Est = true
		}
	}
	if !gotExtrap {
		t.Fatalf("expected gps_extrapolated bus after 3m AMB dropout; got %s", toJSON(out))
	}
	if !gotDir1Est {
		t.Errorf("expected opposite-direction stop_predictions bus to survive; got %s", toJSON(out))
	}
}

func TestAmbTrackedPersistenceAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	cachePath := filepath.Join(dir, "amb_tracked.json")
	t0 := time.Now().Add(-3 * time.Minute)

	p1 := &ambVehPoller{cachePath: cachePath}
	p1.mergeAndSnapshot([]ambVeh{
		{Line: "C-10", Dir: 1, Lat: 41.50, Lon: 2.40, VehID: "1105", ObservedAt: t0},
		{Line: "C-10", Dir: 1, Lat: 41.45, Lon: 2.35, VehID: "expired", ObservedAt: t0.Add(-20 * time.Minute)},
	}, t0)
	p1.saveTracked(t0, true)

	// Simulate container restart: brand-new poller loads saved file.
	now := time.Now()
	p2 := &ambVehPoller{cachePath: cachePath}
	n := p2.loadTracked(now)
	if n != 1 {
		t.Fatalf("expected 1 unexpired vehicle restored after restart, got %d", n)
	}
	snap := p2.snap.Load()
	if snap == nil || len(snap.ByLine["c10"]) != 1 || snap.ByLine["c10"][0].VehID != "1105" {
		t.Fatalf("unexpected restored snapshot: %+v", snap)
	}
}

func TestAmbSpatialDedupKeepsDistantSecondBus(t *testing.T) {
	// Long corridor (~18 km) in direction 1: Mataró -> Badalona -> Barcelona.
	rt1 := movRoute{LineID: 53, Trayecto: 1, Dest: "BCN", Stops: []movStop{
		{ID: 1, Name: "Mataro", Lat: 41.54, Lon: 2.44, Km: 0},
		{ID: 2, Name: "Premia", Lat: 41.49, Lon: 2.36, Km: 8.5},
		{ID: 3, Name: "Badalona", Lat: 41.44, Lon: 2.25, Km: 18.0},
	}}
	s := &movStatic{
		Lines:  map[int]movLine{53: {ID: 53, Code: "C-10"}},
		Routes: map[int][]movRoute{53: {rt1}},
	}
	now := time.Now()
	// AMB only reports bus #1 near Mataró (km 0).
	p := &ambVehPoller{}
	p.snap.Store(&ambVehSnapshot{At: now, ByLine: map[string][]ambVeh{
		"c10": {{Line: "C-10", Dir: 1, Lat: 41.54, Lon: 2.44, VehID: "1102", ObservedAt: now}},
	}})
	ambVehLive.Store(p)
	t.Cleanup(func() { ambVehLive.Store(nil) })

	// Moventis predicts a 2nd bus arriving at Badalona (18 km away, same direction!).
	preds := map[[3]int]movPrediction{
		{53, 1, 3}: {LineID: 53, Trayecto: 1, StopID: 3, EtaSec: []float64{60}, At: now},
	}
	out := movVehiclesWithAMB(s, []int{53}, preds, now)
	var realN, estN int
	for _, raw := range out {
		o := raw.(*Obj)
		if truthy(o.Get("isRealTime")) {
			realN++
		} else {
			estN++
		}
	}
	if realN != 1 || estN != 1 {
		t.Fatalf("expected 1 real AMB bus + 1 distant Moventis estimate in same direction; got real=%d est=%d (%s)", realN, estN, toJSON(out))
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

func TestAmbCatalogVehiclesAndBBox(t *testing.T) {
	now := time.Now()
	prevAmb, hadAmb := rtCatalog.Load(ambAgencyID)
	rtCatalog.Store(ambAgencyID, &rtCatalogOp{
		Lines: []rtRoute{
			{Code: "B25", Name: "Badalona (Pomar) - Barcelona (Rda. St. Pere)", Color: "#FFE600", TextColor: "#000000"},
			{Code: "A1", Name: "Aerobús Terminal 1", Color: "#0099CC", TextColor: "#FFFFFF"},
		},
		Profiles: map[string]*rtLineProfile{
			"B25": {
				Directions: []rtLineDirection{
					{DirectionID: 0, Headsign: "Barcelona", Stops: []rtLineStop{{Lat: 41.45, Lon: 2.25}, {Lat: 41.39, Lon: 2.17}}},
					{DirectionID: 1, Headsign: "Badalona", Stops: []rtLineStop{{Lat: 41.39, Lon: 2.17}, {Lat: 41.45, Lon: 2.25}}},
				},
			},
		},
	})
	t.Cleanup(func() {
		if hadAmb {
			rtCatalog.Store(ambAgencyID, prevAmb)
		} else {
			rtCatalog.Delete(ambAgencyID)
		}
	})

	// Moventis follows C-10 so C-10 must be excluded from ambCatalogVehicles.
	mp := &movPoller{}
	mp.snap.Store(&movSnapshot{
		Lines:  []int{53},
		Static: &movStatic{Lines: map[int]movLine{53: {ID: 53, Code: "C-10"}}},
	})
	movLive.Store(mp)
	t.Cleanup(func() { movLive.Store(nil) })

	p := &ambVehPoller{}
	p.snap.Store(&ambVehSnapshot{At: now, ByLine: map[string][]ambVeh{
		"c10": {{Line: "C-10", Dir: 1, Lat: 41.45, Lon: 2.25, VehID: "1102", ObservedAt: now}},
		"b25": {
			{Line: "B25", Dir: 1, Lat: 41.448, Lon: 2.246, VehID: "4501", ObservedAt: now},
			{Line: "B25", Dir: 2, Lat: 41.391, Lon: 2.174, VehID: "4502", ObservedAt: now},
			{Line: "B25", Dir: 1, Lat: 41.440, Lon: 2.240, VehID: "stale", ObservedAt: now.Add(-5 * time.Minute)},
		},
		"a1": {{Line: "A1", Dir: 1, Lat: 41.297, Lon: 2.078, VehID: "7701", ObservedAt: now}}, // Airport (outside Badalona/BCN center box)
	}})
	ambVehLive.Store(p)
	t.Cleanup(func() { ambVehLive.Store(nil) })

	// Unfiltered: B25 (2 fresh) + A1 (1 fresh), C-10 excluded, stale B25 excluded.
	all := ambCatalogVehicles(now, nil)
	if len(all) != 3 {
		t.Fatalf("ambCatalogVehicles(nil) = %d, want 3 (%s)", len(all), toJSON(all))
	}
	for _, raw := range all {
		o := raw.(*Obj)
		if jsString(o.Get("agencyId")) != ambAgencyID {
			t.Errorf("expected agencyId=amb, got %v", o.Get("agencyId"))
		}
		if jsString(o.Get("lineCode")) == "C-10" {
			t.Errorf("C-10 should not be emitted by ambCatalogVehicles")
		}
		if !truthy(o.Get("isRealTime")) || truthy(o.Get("isEstimated")) {
			t.Errorf("AMB bus must be live GPS: %s", toJSON(o))
		}
		if jsString(o.Get("lineCode")) == "B25" {
			if jsString(o.Get("color")) != "#FFE600" || jsString(o.Get("lineRef")) != "amb:B25" {
				t.Errorf("B25 catalog metadata missing: %s", toJSON(o))
			}
		}
	}

	// BBox around Badalona & central Barcelona: includes both B25 buses, excludes A1 at Airport.
	bcnBox := &trainBox{minLat: 41.37, minLon: 2.14, maxLat: 41.47, maxLon: 2.28}
	inBox := ambCatalogVehicles(now, bcnBox)
	if len(inBox) != 2 {
		t.Fatalf("ambCatalogVehicles(bcnBox) = %d, want 2 (%s)", len(inBox), toJSON(inBox))
	}

	// Single-line view direction filtering for amb:B25.
	dir0, stale0 := ambLineBuses(ambAgencyID, "B25", "0", now)
	if len(dir0) != 1 || stale0 != 1 || jsString(dir0[0].(*Obj).Get("vehicleId")) != "4501" {
		t.Fatalf("ambLineBuses(amb, B25, 0) = %d (stale %d), want 1 live (4501) + 1 stale", len(dir0), stale0)
	}
	both, staleBoth := ambLineBuses(ambAgencyID, "B25", "both", now)
	if len(both) != 2 || staleBoth != 1 {
		t.Fatalf("ambLineBuses(amb, B25, both) = %d (stale %d), want 2 live + 1 stale", len(both), staleBoth)
	}
}

func TestAmbMultiCatalogMatchingAndGencatCodeParse(t *testing.T) {
	if c, n := parseGencatBusRouteCode("0221", "(221) Sabadell - Caldes - Bigues"); c != "221" || n != "Sabadell - Caldes - Bigues" {
		t.Fatalf("parseGencatBusRouteCode got (%q, %q)", c, n)
	}
	if c, n := parseGencatBusRouteCode("L1", "Urbà de Caldes"); c != "L1" || n != "Urbà de Caldes" {
		t.Fatalf("parseGencatBusRouteCode passthrough got (%q, %q)", c, n)
	}

	now := time.Now()
	rtCatalog.Store(ambAgencyID, &rtCatalogOp{
		Lines: []rtRoute{{Code: "A1", Name: "Aerobús T1", Color: "#0099CC"}},
		Profiles: map[string]*rtLineProfile{
			"A1": {Directions: []rtLineDirection{{DirectionID: 0, Stops: []rtLineStop{{Lat: 41.297, Lon: 2.078}}}}},
		},
	})
	rtCatalog.Store(movSarbusAgencyID, &rtCatalogOp{
		Lines: []rtRoute{{Code: "A1", Name: "Sabadell - Barcelona", Color: "#E30613"}},
		Profiles: map[string]*rtLineProfile{
			"A1": {Directions: []rtLineDirection{{DirectionID: 0, Stops: []rtLineStop{{Lat: 41.546, Lon: 2.108}}}}},
		},
	})
	rtCatalog.Store(gencatBusAgencyID, &rtCatalogOp{
		Lines: []rtRoute{{Code: "221", Name: "Sabadell - Caldes - Bigues", Color: "#0D9488"}},
		Profiles: map[string]*rtLineProfile{
			"221": {Directions: []rtLineDirection{{DirectionID: 0, Stops: []rtLineStop{{Lat: 41.634, Lon: 2.164}}}}},
		},
	})
	t.Cleanup(func() {
		rtCatalog.Delete(ambAgencyID)
		rtCatalog.Delete(movSarbusAgencyID)
		rtCatalog.Delete(gencatBusAgencyID)
	})

	p := &ambVehPoller{}
	p.snap.Store(&ambVehSnapshot{At: now, ByLine: map[string][]ambVeh{
		"a1": {
			{Line: "A1", Dir: 1, Lat: 41.298, Lon: 2.079, VehID: "aero1", ObservedAt: now},
			{Line: "A1", Dir: 1, Lat: 41.547, Lon: 2.109, VehID: "sarbus1", ObservedAt: now},
		},
		"221": {
			{Line: "221", Dir: 1, Lat: 41.635, Lon: 2.165, VehID: "caldes1", ObservedAt: now},
		},
	}})
	ambVehLive.Store(p)
	t.Cleanup(func() { ambVehLive.Store(nil) })

	all := ambCatalogVehicles(now, nil)
	if len(all) != 3 {
		t.Fatalf("want 3 matched buses, got %d (%s)", len(all), toJSON(all))
	}
	byVeh := map[string]*Obj{}
	for _, raw := range all {
		o := raw.(*Obj)
		byVeh[o.Str("vehicleId")] = o
	}
	if byVeh["aero1"].Str("agencyId") != ambAgencyID || byVeh["aero1"].Str("lineRef") != "amb:A1" {
		t.Errorf("aero1 wrong match: %s", toJSON(byVeh["aero1"]))
	}
	if byVeh["sarbus1"].Str("agencyId") != movSarbusAgencyID || byVeh["sarbus1"].Str("lineRef") != "moventis_sarbus:A1" || byVeh["sarbus1"].Str("color") != "#E30613" {
		t.Errorf("sarbus1 wrong match: %s", toJSON(byVeh["sarbus1"]))
	}
	if byVeh["caldes1"].Str("agencyId") != gencatBusAgencyID || byVeh["caldes1"].Str("lineRef") != "gencat_bus:221" {
		t.Errorf("caldes1 wrong match: %s", toJSON(byVeh["caldes1"]))
	}

	// Single-line spatial filter: amb:A1 only returns aero1, not Sabadell's sarbus1.
	ambA1, _ := ambLineBuses(ambAgencyID, "A1", "both", now)
	if len(ambA1) != 1 || ambA1[0].(*Obj).Str("vehicleId") != "aero1" {
		t.Fatalf("amb:A1 should only return aero1, got %s", toJSON(ambA1))
	}
	sarbusA1, _ := ambLineBuses(movSarbusAgencyID, "A1", "both", now)
	if len(sarbusA1) != 1 || sarbusA1[0].(*Obj).Str("vehicleId") != "sarbus1" {
		t.Fatalf("moventis_sarbus:A1 should only return sarbus1, got %s", toJSON(sarbusA1))
	}
}

package main

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestParseTmbMetroAndStopCodes(t *testing.T) {
	if got := tmbMetroStationCode("1.111"); got != "111" {
		t.Fatalf("metro code: %q", got)
	}
	if got := tmbMetroStationCode("2.108.680249"); got != "" {
		t.Fatalf("bus id must not match metro: %q", got)
	}
	if got := tmbBusStopCode("2.108.680249"); got != "108" {
		t.Fatalf("bus code: %q", got)
	}

	now := time.UnixMilli(1795554000000)
	body := []byte(`{
		"timestamp": 1795554000000,
		"linies": [{
			"nom_linia": "L1",
			"estacions": [{
				"codi_estacio": 111,
				"codi_via": 1,
				"id_sentit": 1,
				"linies_trajectes": [{
					"nom_linia": "L1",
					"desti_trajecte": "Fondo",
					"propers_trens": [
						{"temps_arribada": 1795554240000, "codi_servei": "104"},
						{"temps_arribada": 1795554120000, "codi_servei": "103"}
					]
				}]
			}]
		}]
	}`)
	snap, err := parseTmbMetro(body, now)
	if err != nil {
		t.Fatal(err)
	}
	arr := snap.ByLineStation["L1\x00111"]
	if len(arr) != 2 || arr[0].VehicleID != "103" || arr[1].VehicleID != "104" {
		t.Fatalf("expected sorted metro arrivals, got: %+v", arr)
	}

	old := tmbMetroLive.Swap(snap)
	t.Cleanup(func() { tmbMetroLive.Store(old) })

	res := tmbLiveDepartures(context.Background(), rtLineStop{ID: "1.111", Name: "Hospital de Bellvitge"}, "L1", "", now)
	if res == nil {
		t.Fatal("expected live metro departures")
	}
	if !strings.Contains(res.Str("attribution"), "Transports Metropolitans de Barcelona") ||
		!strings.Contains(res.Str("attribution"), "Actualitzat ") {
		t.Errorf("attribution must cite TMB and update date: %q", res.Str("attribution"))
	}
	deps := res.Arr("departures")
	if len(deps) != 2 {
		t.Fatalf("expected 2 departures, got %d", len(deps))
	}
	d0 := deps[0].(*Obj)
	if d0.Num("minutesAway") != 2 || d0.Get("isRealTime") != true || d0.Str("platform") != "1" {
		t.Errorf("unexpected first metro departure: %v", d0)
	}
	// L9S has no iTransit data -> nil so caller falls back to GTFS timetable.
	if fallback := tmbLiveDepartures(context.Background(), rtLineStop{ID: "1.901", Name: "Aeroport T1"}, "L9S", "", now); fallback != nil {
		t.Errorf("expected nil fallback for L9S, got: %v", fallback)
	}
}

func TestParseTmbBusStopFiltersAmbAndReadsRamp(t *testing.T) {
	body := []byte(`{
		"timestamp": 1795554000000,
		"parades": [{
			"codi_parada": "108",
			"linies_trajectes": [
				{
					"transit_namespace": "bus",
					"nom_linia": "109",
					"id_sentit": 1,
					"desti_trajecte": "Polígon Zona Franca",
					"propers_busos": [
						{"temps_arribada": 1795554180000, "id_bus": 1825, "info_bus": {"accessibilitat": {"estat_rampa": "SENSE_INCIDENCIA"}}}
					]
				},
				{
					"transit_namespace": "amb",
					"nom_linia": "L95",
					"id_sentit": 1,
					"desti_trajecte": "Castelldefels",
					"propers_busos": [
						{"temps_arribada": 1795554240000, "id_bus": 999}
					]
				}
			]
		}]
	}`)
	arr, _, err := parseTmbBusStop(body, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(arr) != 1 || arr[0].Line != "109" || arr[0].VehicleID != "1825" {
		t.Fatalf("expected AMB dropped and 109 kept, got: %+v", arr)
	}
	if arr[0].Wheelchair == nil || !*arr[0].Wheelchair {
		t.Errorf("expected wheelchair ramp true, got %v", arr[0].Wheelchair)
	}
}

func TestTmbSourceGateAndNoHistory(t *testing.T) {
	t.Setenv("ARRIBO_TMB", "0")
	t.Setenv("TMB_APP_ID", "id")
	t.Setenv("TMB_APP_KEY", "key")
	if _, ok := tmbSource(); ok {
		t.Fatal("expected disabled when ARRIBO_TMB=0")
	}
	t.Setenv("ARRIBO_TMB", "1")
	src, ok := tmbSource()
	if !ok {
		t.Fatal("expected enabled when ARRIBO_TMB=1 and keys set")
	}
	if !src.noHistory || src.tmbMetroURL == "" || src.staticURL == "" {
		t.Errorf("unexpected tmbSource: %+v", src)
	}
}

func TestRouteModeForDistinguishesRailMetroTramBus(t *testing.T) {
	cases := []struct {
		op   operatorInfo
		code string
		want string
	}{
		{reportOperators[0], "R1", "rail"},
		{reportOperators[1], "S2", "rail"},
		{tmbOperator, "L1", "metro"},
		{tmbOperator, "L9S", "metro"},
		{tmbOperator, "FM", "metro"},
		{tmbOperator, "109", "bus"},
		{tmbOperator, "H4", "bus"},
		{tramTbxOperator, "T1", "tram"},
		{movOperator, "C-10", "bus"},
		{ambOperator, "L95", "bus"},
		{sagalesOperator, "550", "bus"},
		{gironaOperator, "L1", "bus"},
	}
	for _, tc := range cases {
		if got := routeModeFor(tc.op, tc.code); got != tc.want {
			t.Errorf("routeModeFor(%s, %s) = %q, want %q", tc.op.ID, tc.code, got, tc.want)
		}
	}
}

func TestTmbMetroTrainFeed(t *testing.T) {
	now := time.UnixMilli(1795554000000)
	snap := &tmbMetroSnapshot{
		At:       now,
		ServerMs: now.UnixMilli(),
		ByLineStation: map[string][]tmbArrival{
			"L1\x00112": {
				{Line: "L1", Direction: "0", Dest: "Fondo", ArriveMs: now.Add(45 * time.Second).UnixMilli(), VehicleID: "103"},
			},
			"L1\x00113": {
				{Line: "L1", Direction: "0", Dest: "Fondo", ArriveMs: now.Add(135 * time.Second).UnixMilli(), VehicleID: "103"},
			},
		},
	}
	oldSnap := tmbMetroLive.Swap(snap)
	t.Cleanup(func() { tmbMetroLive.Store(oldSnap) })

	rtCatalog.Store(tmbAgencyID, &rtCatalogOp{
		AgencyID: tmbAgencyID,
		Mode:     "metro",
		Lines:    []rtRoute{{Code: "L1", Name: "Hospital de Bellvitge - Fondo", Color: "#E2001A"}},
		Profiles: map[string]*rtLineProfile{
			"L1": {
				Code: "L1",
				Directions: []rtLineDirection{{
					DirectionID: 0,
					Stops: []rtLineStop{
						{ID: "1.111", Name: "Hospital de Bellvitge", Lat: 41.344, Lon: 2.107},
						{ID: "1.112", Name: "Bellvitge", Lat: 41.351, Lon: 2.111},
						{ID: "1.113", Name: "Av. Carrilet", Lat: 41.358, Lon: 2.103},
					},
				}},
			},
		},
	})
	t.Cleanup(func() { rtCatalog.Delete(tmbAgencyID) })

	feed, ok := tmbMetroTrainFeed(now)
	if !ok || feed.snap == nil || len(feed.snap.Vehicles) != 1 {
		t.Fatalf("expected 1 live metro train, got ok=%v snap=%+v", ok, feed.snap)
	}
	v := feed.snap.Vehicles[0]
	if v.Mode != "metro" || v.LineCode != "L1" || v.StopName != "Bellvitge" || v.CurrentStatus != "IN_TRANSIT_TO" {
		t.Errorf("unexpected metro vehicle: %+v", v)
	}
	// 45s out of 90s -> halfway between 41.344 and 41.351 (~41.3475).
	if v.Lat < 41.346 || v.Lat > 41.349 {
		t.Errorf("expected interpolated lat near 41.3475, got %v", v.Lat)
	}
}

func TestTmbBusEstimateLinePositions(t *testing.T) {
	now := time.UnixMilli(1795554000000)
	route := rtRoute{Code: "H10", Name: "Pl. Sants - Olímpic de Badalona", Color: "#0072CE", TextColor: "#FFFFFF"}
	prof := &rtLineProfile{
		Code: "H10",
		Directions: []rtLineDirection{
			{
				DirectionID: 0,
				Headsign:    "Olímpic de Badalona",
				Stops: []rtLineStop{
					{ID: "2.100", Name: "Pl. Sants", Lat: 41.375, Lon: 2.135},
					{ID: "2.101", Name: "Mallorca - Viladomat", Lat: 41.385, Lon: 2.150},
					{ID: "2.102", Name: "València - Balmes", Lat: 41.392, Lon: 2.162},
					{ID: "2.103", Name: "Clot", Lat: 41.408, Lon: 2.187},
				},
			},
			{
				DirectionID: 1,
				Headsign:    "Pl. Sants",
				Stops: []rtLineStop{
					{ID: "2.200", Name: "Clot", Lat: 41.408, Lon: 2.187},
					{ID: "2.201", Name: "Pl. Sants", Lat: 41.375, Lon: 2.135},
				},
			},
		},
	}

	rampOK := true
	samples := map[string][]tmbArrival{
		// Bus 1825 is 3 min from stop 2.102 and 12 min from 2.103 -> deduplicated to earliest (2.102).
		"102": {
			{Line: "H10", Direction: "0", Dest: "Olímpic de Badalona", ArriveMs: now.Add(3 * time.Minute).UnixMilli(), VehicleID: "1825", Wheelchair: &rampOK},
			{Line: "V15", Direction: "0", Dest: "Barceloneta", ArriveMs: now.Add(2 * time.Minute).UnixMilli(), VehicleID: "9999"}, // other line ignored
		},
		"103": {
			{Line: "H10", Direction: "0", Dest: "Olímpic de Badalona", ArriveMs: now.Add(12 * time.Minute).UnixMilli(), VehicleID: "1825"},
			{Line: "H10", Direction: "0", Dest: "Olímpic de Badalona", ArriveMs: now.Add(10 * time.Second).UnixMilli(), VehicleID: "1840"},
		},
		"201": {
			{Line: "H10", Direction: "1", Dest: "Pl. Sants", ArriveMs: now.Add(4 * time.Minute).UnixMilli(), VehicleID: "1901"},
		},
	}

	// Direction 0: 2 unique buses (1825 back-projected before 2.102, 1840 STOPPED_AT 2.103).
	dir0 := tmbEstimateLineBusesFromSamples(route, prof, "0", samples, now)
	if len(dir0) != 2 {
		t.Fatalf("expected 2 estimated buses in dir 0, got %d (%s)", len(dir0), toJSON(dir0))
	}
	b1825 := dir0[0].(*Obj)
	b1840 := dir0[1].(*Obj)
	if b1825.Str("vehicleId") != "1825" || b1825.Get("isEstimated") != true || b1825.Get("isRealTime") != false {
		t.Errorf("unexpected 1825: %s", toJSON(b1825))
	}
	if b1825.Str("positionSource") != "tmb_stop_predictions" || b1825.Str("mode") != "bus" || b1825.Get("wheelchairAccessible") != true {
		t.Errorf("unexpected 1825 metadata: %s", toJSON(b1825))
	}
	if !strings.Contains(b1825.Str("attribution"), "Transports Metropolitans de Barcelona") {
		t.Errorf("missing TMB attribution: %q", b1825.Str("attribution"))
	}
	// Back-projected 3 min (~0.65 km) before 2.102 (41.392, 2.162) toward 2.101 (41.385, 2.150).
	if b1825.Num("lat") >= 41.392 || b1825.Num("lat") <= 41.385 {
		t.Errorf("expected 1825 lat between 2.101 and 2.102, got %v", b1825.Num("lat"))
	}
	if b1840.Str("vehicleId") != "1840" || b1840.Str("currentStatus") != "STOPPED_AT" || b1840.Str("stopName") != "Clot" {
		t.Errorf("expected 1840 STOPPED_AT Clot, got %s", toJSON(b1840))
	}

	// Both directions: 3 unique buses total.
	both := tmbEstimateLineBusesFromSamples(route, prof, "both", samples, now)
	if len(both) != 3 {
		t.Fatalf("expected 3 estimated buses in both dirs, got %d", len(both))
	}

	// Sample indices helper: 30 stops -> 6 evenly spaced indices in [1, 29].
	idxs := tmbSampleStopIndices(30, 6)
	if len(idxs) != 6 || idxs[0] < 1 || idxs[len(idxs)-1] != 29 {
		t.Fatalf("unexpected sample indices for 30 stops: %v", idxs)
	}
}

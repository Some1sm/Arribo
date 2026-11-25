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

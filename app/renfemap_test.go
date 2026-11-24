package main

import (
	"testing"
	"time"
)

func TestParseRenfeFlotaFiltersCataloniaNucleo50(t *testing.T) {
	raw := []byte(`{
		"fechaActualizacion": "2026-11-24T21:29:33",
		"trenes": [
			{"tripId": "3027M23573C1", "codTren": "23573", "nucleo": "30", "via": "1", "nextVia": "2", "accesible": false},
			{"tripId": "5127M25547R2S", "codTren": "25547", "nucleo": "50", "via": "3", "nextVia": "11", "codEstAct": "71801", "codEstSig": "71802", "accesible": true}
		]
	}`)
	m, err := parseRenfeFlota(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(m) != 1 {
		t.Fatalf("expected 1 Catalonia train, got %d: %+v", len(m), m)
	}
	tr, ok := m["25547"]
	if !ok {
		t.Fatal("missing train 25547")
	}
	if tr.NextVia != "11" || tr.Via != "3" || tr.Accessible == nil || !*tr.Accessible {
		t.Fatalf("unexpected train 25547: %+v", tr)
	}
}

func TestParseRenfeFlotaLDUnitsAndSeries(t *testing.T) {
	raw := []byte(`{
		"fechaActualizacion": "2026-11-24T21:29:35",
		"trenes": [
			{"codComercial": "15780", "codProduct": 19, "codEstSig": "79300", "p": "4", "mat": "449027,449034", "accesible": true},
			{"codComercial": "15021", "codProduct": 19, "codEstSig": "71801", "p": "3", "mat": "470095", "accesible": false}
		]
	}`)
	m, err := parseRenfeFlotaLD(raw)
	if err != nil {
		t.Fatal(err)
	}
	r11 := m["15780"]
	if r11.Series != "449" || len(r11.Units) != 2 || r11.Units[0] != "449027" || r11.Units[1] != "449034" {
		t.Fatalf("coupled 449 mismatch: %+v", r11)
	}
	r15 := m["15021"]
	if r15.Series != "470" || len(r15.Units) != 1 || r15.Platform != "3" {
		t.Fatalf("single 470 mismatch: %+v", r15)
	}
}

func TestTrainJSONRenfeMapEnrichmentAndPrecedence(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	yes := true
	no := false
	rm := &renfeMapSnapshot{
		At: now.Add(-15 * time.Second),
		Commuter: map[string]renfeFlotaTrain{
			"25547": {CodTren: "25547", NextVia: "11", CodEstSig: "71802", Accessible: &yes},
			"15780": {CodTren: "15780", NextVia: "6", CodEstSig: "79300", Accessible: &no},
		},
		LD: map[string]renfeLDTrain{
			"15780": {CodComercial: "15780", Units: []string{"449027", "449034"}, Series: "449", ProductCode: 19, Platform: "4", CodEstSig: "79300", Accessible: &yes},
		},
	}
	info := operatorInfo{ID: "renfe_rodalies", Name: "Rodalies", Mode: "rail"}
	snap := &rtSnapshot{AgencyID: "renfe_rodalies", FeedTimestamp: uint64(now.Unix() - 20), RenfeMap: rm}

	// 1. Official GTFS-RT label platform wins over flota.json, while wheelchair comes from flota.json.
	vOfficial := &rtVehicle{
		VehicleID: "v1", TripID: "5127M25547R2S", Label: "R2S-25547-PLATF.(9)",
		LineCode: "R2S", StopID: "71802", Lat: 41.38, Lon: 2.17, ObservedAt: now.Unix() - 10,
	}
	j1 := trainJSON(info, snap, vOfficial, now)
	if j1.Str("platform") != "9" || !j1.IsUndef("platformSource") {
		t.Fatalf("official label platform must win: platform=%q source=%v", j1.Str("platform"), j1.Get("platformSource"))
	}
	if j1.Get("wheelchairAccessible") != true || j1.Str("wheelchairSource") != renfeMapSourceTag {
		t.Fatalf("expected wheelchairAccessible=true from renfe visor, got %v / %v", j1.Get("wheelchairAccessible"), j1.Get("wheelchairSource"))
	}
	if !j1.IsUndef("unit") {
		t.Fatalf("commuter train without flotaLD entry must have no unit: %v", j1.Get("unit"))
	}

	// 2. Regional train with no official platform gets nextVia from flota.json and coupled unit from flotaLD.json.
	vRegional := &rtVehicle{
		VehicleID: "v2", TripID: "5127M15780R11", Label: "R11-15780",
		LineCode: "R11", StopID: "79300", Lat: 41.98, Lon: 2.82, ObservedAt: now.Unix() - 10,
	}
	j2 := trainJSON(info, snap, vRegional, now)
	if j2.Str("platform") != "6" || j2.Str("platformSource") != renfeMapSourceTag {
		t.Fatalf("expected unofficial platform 6, got %q (%v)", j2.Str("platform"), j2.Get("platformSource"))
	}
	unit := j2.ObjAt("unit")
	if unit == nil {
		t.Fatal("expected unit object for regional train in flotaLD")
	}
	if unit.Str("series") != "449" || unit.Num("coupledCount") != 2 || unit.Get("unofficial") != true || unit.Str("source") != renfeMapSourceTag {
		t.Fatalf("unexpected regional unit: %s", string(toJSON(unit)))
	}
	if unit.Str("manufacturer") == "" {
		t.Fatalf("expected static renfe_fleet.json manufacturer for 449: %s", string(toJSON(unit)))
	}

	// 3. Stale renfeMap (>3 min) must be ignored completely.
	staleSnap := &rtSnapshot{AgencyID: "renfe_rodalies", FeedTimestamp: uint64(now.Unix() - 20), RenfeMap: &renfeMapSnapshot{
		At: now.Add(-5 * time.Minute), Commuter: rm.Commuter, LD: rm.LD,
	}}
	j3 := trainJSON(info, staleSnap, vRegional, now)
	if !isNullish(j3.Get("platform")) || !j3.IsUndef("unit") || !j3.IsUndef("wheelchairAccessible") {
		t.Fatalf("stale renfeMap must not enrich train: %s", string(toJSON(j3)))
	}
}

func TestRailDeparturesUsesUnofficialPlatformBeforeUsual(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	info := operatorInfo{ID: "renfe_rodalies", Name: "Rodalies", Mode: "rail"}
	stop := rtLineStop{ID: "71802", Name: "Passeig de Gràcia", Lat: 41.39, Lon: 2.16}
	sched := []any{
		O("tripId", "5127M25547R2S", "headsign", "Aeroport", "directionId", 0.0, "departUnix", float64(now.Unix()+300), "stopId", "71802", "platform", ""),
	}
	snap := &rtSnapshot{
		AgencyID: "renfe_rodalies",
		Vehicles: []rtVehicle{{TripID: "5127M25547R2S", Label: "R2S-25547", StopID: "71802"}},
		RenfeMap: &renfeMapSnapshot{
			At:       now.Add(-10 * time.Second),
			Commuter: map[string]renfeFlotaTrain{"25547": {CodTren: "25547", NextVia: "11", CodEstSig: "71802"}},
		},
	}
	usual := O("0", "9")
	res := railDeparturesResponse(info, stop, sched, snap, nil, usual, now)
	deps := res.Arr("departures")
	if len(deps) != 1 {
		t.Fatalf("expected 1 departure, got %d", len(deps))
	}
	d := deps[0].(*Obj)
	if d.Str("platform") != "11" || d.Str("platformSource") != "unofficial" {
		t.Fatalf("expected unofficial platform 11 over usual 9, got platform=%q source=%q", d.Str("platform"), d.Str("platformSource"))
	}
}

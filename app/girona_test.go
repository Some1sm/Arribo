package main

import (
	"testing"
	"time"
)

func TestGironaLineNumberAndHTMLParser(t *testing.T) {
	if got := gironaLineNumber("L10"); got != "10" {
		t.Fatalf("L10 -> %q", got)
	}
	if got := gironaLineNumber("3"); got != "3" {
		t.Fatalf("3 -> %q", got)
	}
	if got := gironaLineNumber("R1"); got != "" {
		t.Fatalf("R1 should be empty, got %q", got)
	}

	now := time.Date(2026, 11, 24, 10, 0, 0, 0, madrid)

	// No info -> empty slice (falls back to GTFS).
	empty, err := parseGironaBusosJSON([]byte(`{"contingut":"<span style=\"color: red\">(sense informació)</span>"}`), "0", now)
	if err != nil || len(empty) != 0 {
		t.Fatalf("expected empty for sense informacio, got %+v err=%v", empty, err)
	}

	// Live minutes + imminent.
	live, err := parseGironaBusosJSON([]byte(`{"contingut":"<div class=\"temps\">Imminent</div><div class=\"temps\">6 min</div><div class=\"temps\">18 min</div>"}`), "0", now)
	if err != nil || len(live) != 3 {
		t.Fatalf("expected 3 live arrivals, got %+v err=%v", live, err)
	}
	if !live[0].RealTime || live[0].MinutesAway != 0 || live[1].MinutesAway != 6 || live[2].MinutesAway != 18 {
		t.Errorf("unexpected live arrivals: %+v", live)
	}

	// Timetable HH:MM only -> RealTime=false.
	sched, err := parseGironaBusosJSON([]byte(`{"contingut":"<p>Pròxim pas: 10:15 i 10:45</p>"}`), "1", now)
	if err != nil || len(sched) != 2 {
		t.Fatalf("expected 2 scheduled arrivals, got %+v err=%v", sched, err)
	}
	if sched[0].RealTime || sched[0].MinutesAway != 15 || sched[0].ClockHHMM != "10:15" || sched[0].Direction != "1" {
		t.Errorf("unexpected scheduled arrival: %+v", sched[0])
	}
}

func TestGironaSourceGateAndNoHistory(t *testing.T) {
	t.Setenv("ARRIBO_GIRONA", "0")
	t.Setenv("NAP_API_KEY", "test-key")
	if _, ok := gironaSource(); ok {
		t.Fatal("expected disabled when ARRIBO_GIRONA=0")
	}
	t.Setenv("ARRIBO_GIRONA", "1")
	t.Setenv("NAP_API_KEY", "")
	if _, ok := gironaSource(); ok {
		t.Fatal("expected disabled without NAP_API_KEY")
	}
	t.Setenv("NAP_API_KEY", "test-key")
	src, ok := gironaSource()
	if !ok {
		t.Fatal("expected enabled with ARRIBO_GIRONA=1 and NAP_API_KEY")
	}
	if !src.noHistory || src.staticHeaders["ApiKey"] != "test-key" {
		t.Errorf("unexpected gironaSource: %+v", src)
	}
}

func TestGironaBusEstimateLinePositions(t *testing.T) {
	now := time.Date(2026, 11, 25, 12, 0, 0, 0, madrid)
	route := rtRoute{Code: "L1", Name: "Montjuïc - Avellaneda", Color: "#E2001A", TextColor: "#FFFFFF"}
	prof := &rtLineProfile{
		Code: "L1",
		Directions: []rtLineDirection{{
			DirectionID: 0,
			Headsign:    "Avellaneda",
			Stops: []rtLineStop{
				{ID: "10", Name: "Montjuïc", Lat: 41.990, Lon: 2.835},
				{ID: "11", Name: "Plaça Independència", Lat: 41.984, Lon: 2.824},
				{ID: "12", Name: "Estació", Lat: 41.979, Lon: 2.817},
				{ID: "13", Name: "Avellaneda", Lat: 41.972, Lon: 2.808},
			},
		}},
	}
	samples := map[string][]gironaArrival{
		// Same bus seen 2 min from stop 11 and ~6 min from stop 12 -> deduplicates to 1 bus;
		// plus an imminent bus at stop 13 -> 2 buses total.
		"0\x0011": {{MinutesAway: 2, RealTime: true, Direction: "0"}},
		"0\x0012": {{MinutesAway: 6, RealTime: true, Direction: "0"}},
		"0\x0013": {{MinutesAway: 0, RealTime: true, Direction: "0"}, {MinutesAway: 12, RealTime: false, Direction: "0"}},
	}
	buses := gironaEstimateLineBusesFromSamples(route, prof, "0", samples, now)
	if len(buses) != 2 {
		t.Fatalf("expected 2 estimated Girona buses, got %d (%s)", len(buses), toJSON(buses))
	}
	b0 := buses[0].(*Obj)
	if b0.Str("agencyId") != gironaAgencyID || b0.Get("isEstimated") != true || b0.Get("isRealTime") != false || b0.Str("positionSource") != "girona_stop_predictions" {
		t.Errorf("unexpected Girona bus: %s", toJSON(b0))
	}
}

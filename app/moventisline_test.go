package main

import (
	"testing"
	"time"
)

func TestMovLateLiveSuppressesClaimedScheduledSlot(t *testing.T) {
	routes := []movRoute{
		{LineID: 53, Trayecto: 1, Dest: "BCN"},
		{LineID: 53, Trayecto: 2, Dest: "MATARÓ"},
	}
	now := time.Date(2026, 11, 25, 16, 27, 0, 0, madrid)
	// Reproduce exact Metro Gorg case:
	// Scheduled departures: 16:55 and 17:40; live bus running +9 min late at 17:04 (37 min away).
	// Put Sched BEFORE EtaSec to verify two-pass order independence.
	etas := []movStopETA{
		{LineID: 53, Dest: "(C10) BCN - MATARÓ (PER LA NII)", Sched: []string{"16:55", "17:40"}},
		{LineID: 53, Dest: "Mataró", EtaSec: []float64{37 * 60}},
	}
	deps, claimed := movBuildLiveAndSchedDeps(nil, 53, 999999, routes, etas, 0, now)
	if len(deps) != 2 {
		t.Fatalf("expected 2 departures (17:04 live + 17:40 sched, 16:55 suppressed), got %d: %s", len(deps), toJSON(deps))
	}
	live := deps[0].(*Obj)
	if !truthy(live.Get("isRealTime")) || jsString(live.Get("departureTime")) != "17:04" || jsString(live.Get("scheduledTime")) != "16:55" {
		t.Fatalf("unexpected live dep: %s", toJSON(live))
	}
	if live.Num("delayMins") != 9 {
		t.Fatalf("expected delayMins=9, got %v", live.Get("delayMins"))
	}
	sched := deps[1].(*Obj)
	if truthy(sched.Get("isRealTime")) || jsString(sched.Get("departureTime")) != "17:40" {
		t.Fatalf("unexpected sched dep: %s", toJSON(sched))
	}
	if jsString(sched.Get("destination")) != "Mataró" || jsString(sched.Get("direction")) != "1" {
		t.Fatalf("expected cleaned destination Mataró / dir 1, got dest=%v dir=%v", sched.Get("destination"), sched.Get("direction"))
	}
	// Verify 16:55 is claimed in dir 1 (so Step 3 won't re-add it), while dir 0 is unaffected.
	slot1655 := time.Date(2026, 11, 25, 16, 55, 0, 0, madrid)
	if !movTimeClaimed("1", slot1655, claimed) {
		t.Fatalf("expected 16:55 slot to be claimed in dir 1")
	}
	if movTimeClaimed("0", slot1655, claimed) {
		t.Fatalf("unexpected claim of 16:55 slot in opposite dir 0")
	}
}

func TestMovDirectionFilterAndSharedTerminus(t *testing.T) {
	// Metro La Pau (19946) is the last drop-off stop of dir 0 (BCN) and first
	// boarding stop of dir 1 (Mataró), matching the official C-10 timetable
	// (45-min headway per direction).
	routes := []movRoute{
		{LineID: 53, Trayecto: 1, Dest: "BCN", Stops: []movStop{{ID: 7340, Name: "Hospital"}, {ID: 19946, Name: "Metro La Pau"}}},
		{LineID: 53, Trayecto: 2, Dest: "MATARÓ", Stops: []movStop{{ID: 19946, Name: "Metro La Pau"}, {ID: 7340, Name: "Hospital"}}},
	}
	now := time.Date(2026, 11, 25, 16, 37, 0, 0, madrid)
	etas := []movStopETA{
		{LineID: 53, Dest: "(C10) MATARÓ - BCN (PER LA NII)", Sched: []string{"16:35", "17:20", "18:05"}},
		{LineID: 53, Dest: "(C10) BCN - MATARÓ (PER LA NII)", Sched: []string{"16:45", "17:30", "18:15"}},
		{LineID: 53, Dest: "Mataró", EtaSec: []float64{15 * 60}}, // 16:52 (+7 min for 16:45)
	}
	allDeps, _ := movBuildLiveAndSchedDeps(nil, 53, 19946, routes, etas, 0, now)

	// Explicit direction=1 (Cap a Mataró): only the 3 Mataró-bound departures (45 min apart).
	dir1 := movFilterDepsByDir(allDeps, "1", routes, 19946)
	if len(dir1) != 3 {
		t.Fatalf("direction=1: want 3 Mataró departures, got %d: %s", len(dir1), toJSON(dir1))
	}
	for _, raw := range dir1 {
		if jsString(raw.(*Obj).Get("direction")) != "1" {
			t.Fatalf("direction=1 leaked non-dir1 row: %s", toJSON(raw))
		}
	}

	// direction=both at shared terminus 19946: drops terminating dir 0 arrivals, keeps boardable dir 1 departures.
	both := movFilterDepsByDir(allDeps, "both", routes, 19946)
	if len(both) != 3 {
		t.Fatalf("direction=both at shared terminus: want 3 boardable departures, got %d: %s", len(both), toJSON(both))
	}

	// Explicit direction=0 (Cap a Barcelona): shows the 3 Barcelona-bound arrivals.
	dir0 := movFilterDepsByDir(allDeps, "0", routes, 19946)
	if len(dir0) != 3 {
		t.Fatalf("direction=0: want 3 Barcelona arrivals, got %d: %s", len(dir0), toJSON(dir0))
	}
}

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

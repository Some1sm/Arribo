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

func TestMovLateBusPastScheduledTimeInfersPriorSlot(t *testing.T) {
	// Stop 14351 (Montgat Nord) at 16:46: live bus predicted at 16:48 (2 min away),
	// while moventis.es has already dropped 16:28 from Sched and only returns 17:13 and 17:58.
	routes := []movRoute{
		{LineID: 53, Trayecto: 1, Dest: "BCN"},
		{LineID: 53, Trayecto: 2, Dest: "MATARÓ"},
	}
	now := time.Date(2026, 11, 25, 16, 46, 0, 0, madrid)
	etas := []movStopETA{
		{LineID: 53, Dest: "Mataró", EtaSec: []float64{2 * 60}},
		{LineID: 53, Dest: "(C10) BCN - MATARÓ (PER LA NII)", Sched: []string{"17:13", "17:58"}},
	}
	deps, _ := movBuildLiveAndSchedDeps(nil, 53, 999999, routes, etas, 0, now)
	if len(deps) != 3 {
		t.Fatalf("expected 3 departures (16:48 live + 17:13 + 17:58), got %d: %s", len(deps), toJSON(deps))
	}
	live := deps[0].(*Obj)
	if jsString(live.Get("scheduledTime")) != "16:28" || live.Num("delayMins") != 20 || jsString(live.Get("delayStatus")) != "delayed" {
		t.Fatalf("expected inferred 16:28 (+20 min, delayed), got: %s", toJSON(live))
	}
	if jsString(deps[1].(*Obj).Get("departureTime")) != "17:13" || jsString(deps[2].(*Obj).Get("departureTime")) != "17:58" {
		t.Fatalf("expected 17:13 and 17:58 theoretical slots, got: %s", toJSON(deps[1:]))
	}

	// Non-late bus (17:12 for 17:13 slot) matches 17:13 directly (-1 min) and does NOT infer 16:28.
	etasOnTime := []movStopETA{
		{LineID: 53, Dest: "Mataró", EtaSec: []float64{26 * 60}},
		{LineID: 53, Dest: "(C10) BCN - MATARÓ (PER LA NII)", Sched: []string{"17:13", "17:58"}},
	}
	onTimeDeps, _ := movBuildLiveAndSchedDeps(nil, 53, 999999, routes, etasOnTime, 0, now)
	if len(onTimeDeps) != 2 {
		t.Fatalf("expected 2 departures (17:12 live claiming 17:13, plus 17:58), got %d: %s", len(onTimeDeps), toJSON(onTimeDeps))
	}
	onTimeLive := onTimeDeps[0].(*Obj)
	if jsString(onTimeLive.Get("scheduledTime")) != "17:13" || onTimeLive.Num("delayMins") != -1 {
		t.Fatalf("expected direct 17:13 (-1 min) match, got: %s", toJSON(onTimeLive))
	}
}

func TestMovPropagateUpstreamDelay(t *testing.T) {
	routes := []movRoute{
		{LineID: 53, Trayecto: 2, Dest: "MATARÓ", Stops: []movStop{
			{ID: 7192, Name: "Francesc Macià/Maria Cristina", Km: 10.5},
			{ID: 7193, Name: "Francesc Layret/Sant Miquel", Km: 11.2},
			{ID: 7196, Name: "Ctra Mataró-Ptge Cussó", Km: 13.0},
		}},
	}
	now := time.Date(2026, 11, 25, 18, 52, 0, 0, madrid)
	dir := t.TempDir()
	sched := newMovSchedStore(dir)
	// Stop 7192 has official schedule 19:14 and 19:59.
	sched.record(7192, []movStopETA{
		{LineID: 53, Dest: "(C10) BCN - MATARÓ (PER LA NII)", Sched: []string{"19:14", "19:59"}},
	}, now)
	p := &movPoller{sched: sched}

	// Live bus at Stop 7192 is 40 min away (19:32 -> +18 min late).
	preds := map[[3]int]movPrediction{
		{53, 2, 7192}: {LineID: 53, Trayecto: 2, StopID: 7192, EtaSec: []float64{40 * 60}, At: now},
	}

	// Stop 7193 (next stop, beyond Moventis's ~40m real-time horizon) only has theoretical 19:16 and 20:01.
	t1916 := time.Date(2026, 11, 25, 19, 16, 0, 0, madrid)
	t2001 := time.Date(2026, 11, 25, 20, 1, 0, 0, madrid)
	deps := []any{
		movTheoDep("Mataró", "0", t1916, now),
		movTheoDep("Mataró", "0", t2001, now),
	}
	movPropagateUpstreamDelay(p, preds, 53, 7193, routes, deps, now)

	first := deps[0].(*Obj)
	if !truthy(first.Get("isEstimated")) || truthy(first.Get("isRealTime")) || truthy(first.Get("isTheoretical")) {
		t.Fatalf("expected first dep to be estimated (not live, not theoretical): %s", toJSON(first))
	}
	if jsString(first.Get("departureTime")) != "19:34" || jsString(first.Get("scheduledTime")) != "19:16" {
		t.Fatalf("expected 19:34 (sched 19:16), got dep=%v sched=%v", first.Get("departureTime"), first.Get("scheduledTime"))
	}
	if first.Num("delayMins") != 18 || jsString(first.Get("delaySource")) != "upstream_propagated" {
		t.Fatalf("expected delayMins=18 upstream_propagated, got %s", toJSON(first))
	}
	// Second departure (20:01) belongs to the next trip and must remain theoretical.
	second := deps[1].(*Obj)
	if !truthy(second.Get("isTheoretical")) || jsString(second.Get("departureTime")) != "20:01" {
		t.Fatalf("expected second dep 20:01 to stay theoretical, got %s", toJSON(second))
	}

	// Stop 7196 further downstream (19:21) also receives +18 min -> 19:39.
	t1921 := time.Date(2026, 11, 25, 19, 21, 0, 0, madrid)
	deps7196 := []any{movTheoDep("Mataró", "0", t1921, now)}
	movPropagateUpstreamDelay(p, preds, 53, 7196, routes, deps7196, now)
	d7196 := deps7196[0].(*Obj)
	if !truthy(d7196.Get("isEstimated")) || jsString(d7196.Get("departureTime")) != "19:39" || d7196.Num("delayMins") != 18 {
		t.Fatalf("stop 7196 expected 19:39 (+18 min estimated), got %s", toJSON(d7196))
	}
}

func TestMovArrivingNowInfersDelayFromCachedSchedule(t *testing.T) {
	// Reproduces C-10 stop 7205 at 08:38: two live buses (08:38 "Ahora" and 09:14),
	// live Sched only lists 09:51 (1 entry), while rolling cache p.sched also knows 09:06.
	// Combining extraSched + p.sched infers 08:21 (+17 min) for the 08:38 bus.
	routes := []movRoute{
		{LineID: 53, Trayecto: 1, Dest: "BCN"},
		{LineID: 53, Trayecto: 2, Dest: "MATARÓ"},
	}
	now := time.Date(2026, 11, 26, 8, 38, 0, 0, madrid)
	sched := newMovSchedStore(t.TempDir())
	sched.record(999998, []movStopETA{
		{LineID: 53, Dest: "(C10) BCN - MATARÓ (PER LA NII)", Sched: []string{"09:06", "09:51"}},
	}, now.Add(-15*time.Minute))
	p := &movPoller{sched: sched}

	etas := []movStopETA{
		{LineID: 53, Dest: "Mataró", EtaSec: []float64{0, 36 * 60}},
		{LineID: 53, Dest: "(C10) BCN - MATARÓ (PER LA NII)", Sched: []string{"09:51"}},
	}
	deps, _ := movBuildLiveAndSchedDeps(p, 53, 999998, routes, etas, 0, now)
	if len(deps) != 3 {
		t.Fatalf("expected 3 departures (08:38 live, 09:14 live, 09:51 sched), got %d: %s", len(deps), toJSON(deps))
	}
	first := deps[0].(*Obj)
	if first.Num("minutesAway") != 0 || jsString(first.Get("scheduledTime")) != "08:21" || first.Num("delayMins") != 17 || jsString(first.Get("delayStatus")) != "delayed" {
		t.Fatalf("arriving-now bus expected sched 08:21 (+17 min delayed), got: %s", toJSON(first))
	}
	second := deps[1].(*Obj)
	if jsString(second.Get("scheduledTime")) != "09:06" || second.Num("delayMins") != 8 || jsString(second.Get("delayStatus")) != "delayed" {
		t.Fatalf("second bus expected sched 09:06 (+8 min delayed), got: %s", toJSON(second))
	}
}

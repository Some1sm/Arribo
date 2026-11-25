package main

import (
	"testing"
	"time"
)

func TestMovDelayTrackerObservesDeduplicatesAndReports(t *testing.T) {
	dir := t.TempDir()
	tr := newMovDelayTracker(dir)

	// Base instant: 2026-11-24 10:00:00 Europe/Madrid
	base := time.Date(2026, 11, 24, 10, 0, 0, 0, madrid)

	// Bus scheduled at 10:05 arrives in 8 min from 10:00 -> expected 10:08 -> +180 s (+3.0 min, on time).
	tr.observe(53, "C-10", 7340, []float64{480}, []string{"10:05", "10:35"}, base, nil)
	// Same bus 4 min later (10:04): now ETA is 5 min -> expected 10:09 -> +240 s (+4.0 min, late).
	// Smaller ETA should update the same (line, stop, sched) observation rather than double-count!
	tr.observe(53, "C-10", 7340, []float64{300}, []string{"10:05", "10:35"}, base.Add(4*time.Minute), nil)

	// Second bus on e11.1 scheduled at 10:10, expected 10:11 -> +60 s (+1.0 min, on time).
	tr.observe(47, "e11.1", 7340, []float64{660}, []string{"10:10"}, base, nil)

	// Bus > 15 min away (20 min) must be ignored.
	tr.observe(57, "C-20", 7340, []float64{1200}, []string{"10:20"}, base, nil)

	rep := tr.report(24, base.Add(10*time.Minute))
	sum := rep.ObjAt("summary")
	if sum.Num("observations") != 2 {
		t.Fatalf("expected 2 deduplicated observations, got %v", sum.Num("observations"))
	}
	if sum.Num("onTimePct") != 50 {
		t.Errorf("expected 50%% onTime (1 of 2), got %v", sum.Num("onTimePct"))
	}
	if sum.Num("avgDelayMins") != 2.5 {
		t.Errorf("expected avgDelayMins 2.5 ((4+1)/2), got %v", sum.Num("avgDelayMins"))
	}
	if sum.Str("tier") != "predicted" || sum.Str("source") != "prediction_vs_timetable" {
		t.Errorf("honesty labels missing: %v", sum)
	}
	if len(rep.Arr("byLine")) != 2 {
		t.Errorf("expected 2 lines in byLine, got %d", len(rep.Arr("byLine")))
	}

	// Verify disk persistence across reload.
	tr.save(true)
	reloaded := newMovDelayTracker(dir)
	rep2 := reloaded.report(24, base.Add(10*time.Minute))
	if rep2.ObjAt("summary").Num("observations") != 2 {
		t.Errorf("expected 2 observations after reload, got %v", rep2.ObjAt("summary").Num("observations"))
	}
}

func TestMovPrimaryStopPriorityFiltering(t *testing.T) {
	primary := map[int]bool{53: true}
	// Shared stop (C-10 + C-13) is primary -> always polled.
	if !movStopIsPrimary([]int{53, 161}, primary) {
		t.Error("shared stop must be treated as primary")
	}
	// Secondary-only stop (C-13 only) -> secondary.
	if movStopIsPrimary([]int{161}, primary) {
		t.Error("secondary-only stop must not be treated as primary")
	}
	// Static cache missing newly added line IDs triggers refresh.
	st := &movStatic{Lines: map[int]movLine{53: {ID: 53, Code: "C-10"}}}
	if movStaticMissingLines(st, []int{53}) {
		t.Error("present line should not report missing")
	}
	if !movStaticMissingLines(st, []int{53, 161}) {
		t.Error("new line 161 absent from cache must trigger static refresh")
	}
}

func TestMovDelayReportWithStaticStopsBucketsAndRecordMergesSched(t *testing.T) {
	dir := t.TempDir()
	base := time.Date(2026, 11, 25, 18, 0, 0, 0, madrid)
	static := &movStatic{
		Lines: map[int]movLine{
			53: {ID: 53, Code: "C-10", Name: "MATARÓ - BARCELONA (PER N-II)"},
		},
		Routes: map[int][]movRoute{
			53: {{
				LineID: 53, Trayecto: 2, Dest: "MATARÓ",
				Stops: []movStop{{ID: 7192, Name: "Francesc Macià/Maria Cristina", Km: 10.5}},
			}},
		},
	}
	p := &movPoller{
		lineIDs: []int{53},
		dir:     dir,
		delays:  newMovDelayTracker(dir),
		sched:   newMovSchedStore(dir),
		preds:   map[[3]int]movPrediction{},
	}
	// Real Moventis split: real:"S" under "Mataró" has empty Sched, while
	// real:"N" under full route label carries the scheduled HH:MM list.
	p.record(static, 7192, []movStopETA{
		{LineID: 53, Dest: "Mataró", EtaSec: []float64{600}}, // 18:10 vs 18:04 -> +6 min (late15 & severe)
		{LineID: 53, Dest: "(C10) BCN - MATARÓ (PER LA NII)", Sched: []string{"18:04", "18:49"}},
	}, base)

	rep := p.delays.reportWithStatic(24, base.Add(5*time.Minute), static)
	sum := rep.ObjAt("summary")
	if sum.Num("observations") != 1 || sum.Num("avgDelayMins") != 6 || sum.Num("latePct") != 100 {
		t.Fatalf("expected C-10 observation (+6 min) from merged sibling Sched, got %s", toJSON(sum))
	}
	buckets := sum.ObjAt("buckets")
	if buckets.Num("late15") != 1 {
		t.Fatalf("expected late15=1, got %s", toJSON(buckets))
	}
	byStop := rep.Arr("byStop")
	if len(byStop) != 1 {
		t.Fatalf("expected 1 stop in byStop, got %d", len(byStop))
	}
	st := byStop[0].(*Obj)
	if jsString(st.Get("stopName")) != "Francesc Macià/Maria Cristina" || !truthy(st.Get("isBottleneck")) {
		t.Fatalf("unexpected stop row: %s", toJSON(st))
	}
	if len(st.Arr("hourly")) != 24 {
		t.Fatalf("expected 24 hourly heatmap cells, got %d", len(st.Arr("hourly")))
	}
	if len(rep.Arr("daily")) != 1 {
		t.Fatalf("expected 1 day in daily trend, got %d", len(rep.Arr("daily")))
	}
}

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
}

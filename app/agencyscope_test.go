package main

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// FGC's L6 shares Mataró's line code: its station visits must never reach
// Mataró's per-line stats or incidents.
func TestMataroLineReadsIgnoreOtherAgencies(t *testing.T) {
	// The history readers' anomaly filter consults Mataró's timetables.
	data := filepath.Join("..", "src", "data")
	if err := loadSchedules(filepath.Join(data, "mataro_schedules.seasons.json"), filepath.Join(data, "mataro_schedules.json")); err != nil {
		t.Fatalf("schedules: %v", err)
	}
	t.Setenv("DB_PATH", filepath.Join(t.TempDir(), "h.db"))
	h := newHistoryDB()
	if !h.init() {
		t.Fatal("init")
	}
	defer h.close()
	// The visits sit in the hour before an anchor inside L6's service hours:
	// now between 08:00 and 21:00 Madrid, else the latest 20:00 (late at
	// night "the last hour" is outside service, and the anomaly filter
	// rightly drops visits there). Either way inside the 24 h window.
	nowT := time.UnixMilli(nowMs()).In(madrid)
	anchor := nowT
	if h := nowT.Hour(); h < 8 || h >= 21 {
		anchor = time.Date(nowT.Year(), nowT.Month(), nowT.Day(), 20, 0, 0, 0, madrid)
		if anchor.After(nowT) {
			anchor = anchor.AddDate(0, 0, -1)
		}
	}
	now := float64(anchor.UnixMilli())
	for i := 0; i < 6; i++ {
		ts := now - float64(i+1)*600000
		h.recordStopVisit(O("vehicleId", "2601", "lineCode", "L6", "stopName", "Pl. Santa Anna", "firstTs", ts, "lastTs", ts,
			"delayMins", 1.0, "sampleCount", 3.0, "isRealTime", true, "source", "live"))
		h.recordStopVisit(O("vehicleId", "fgc-trip-"+numToString(float64(i)), "lineCode", "L6", "stopName", "Sarrià", "firstTs", ts, "lastTs", ts,
			"delayMins", 45.0, "sampleCount", 1.0, "isRealTime", true, "source", "live", "agencyId", "fgc", "mode", "rail",
			"measuredMethod", "gtfsrt_trip_update", "timesSource", "gtfsrt"))
	}
	stats := string(toJSON(h.getLineDelayStats("L6", 24.0, nil)))
	if strings.Contains(stats, `"maxDelayMins":45`) || strings.Contains(stats, "45") {
		t.Errorf("Mataró L6 stats include FGC L6 visits: %s", stats)
	}
	if !strings.Contains(stats, `"totalVisits":6`) {
		t.Errorf("Mataró L6 stats should count its 6 visits: %s", stats)
	}
	inc := string(toJSON(h.getDelayIncidents(O("lineCode", "L6", "hours", 24.0, "minDelay", 5.0))))
	if strings.Contains(inc, "Sarrià") || strings.Contains(inc, "fgc-trip") {
		t.Errorf("Mataró L6 incidents include FGC visits: %s", inc)
	}
}

// TestRailLineStats: the rail line header's summary counts only that
// operator's visits on that line, with rail's on-time bound (late is more
// than 5 min, early below -1), and is nil with nothing recorded.
func TestRailLineStats(t *testing.T) {
	data := filepath.Join("..", "src", "data")
	if err := loadSchedules(filepath.Join(data, "mataro_schedules.seasons.json"), filepath.Join(data, "mataro_schedules.json")); err != nil {
		t.Fatalf("schedules: %v", err)
	}
	t.Setenv("DB_PATH", filepath.Join(t.TempDir(), "h.db"))
	h := newHistoryDB()
	if !h.init() {
		t.Fatal("init")
	}
	defer h.close()
	now := float64(nowMs())
	rec := func(agency, line string, delay float64, i int) {
		ts := now - float64(i+1)*60000
		h.recordStopVisit(O("vehicleId", "trip"+numToString(float64(i)), "lineCode", line, "stopName", "S", "firstTs", ts, "lastTs", ts,
			"delayMins", delay, "sampleCount", 1.0, "isRealTime", true, "source", "live", "agencyId", agency, "mode", "rail",
			"measuredMethod", "gtfsrt_trip_update", "timesSource", "gtfsrt"))
	}
	// Rodalies R1: 10 visits: 6 on time (0..5), 3 late (>5), 1 early (< -1).
	for i, d := range []float64{0, 1, 2, 3, 5, -1, 6, 20, 45, -3} {
		rec("renfe_rodalies", "R1", d, i)
	}
	rec("fgc", "R1", 90, 20)             // another operator's code clash
	rec("renfe_rodalies", "R2S", 90, 21) // another line
	st, err := h.getRailLineStats("renfe_rodalies", "R1", 24)
	if err != nil || st == nil {
		t.Fatalf("stats %v %v", st, err)
	}
	got := string(toJSON(st))
	for _, want := range []string{`"totalVisits":10`, `"latePct":30`, `"earlyPct":10`, `"onTimePct":60`, `"maxDelayMins":45`, `"avgDelayMins":7.8`, `"onTimeMaxMins":5`} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %s in %s", want, got)
		}
	}
	if st, _ := h.getRailLineStats("renfe_rodalies", "R3", 24); st != nil {
		t.Errorf("R3 has no visits, got %s", toJSON(st))
	}
	if st, _ := h.getRailLineStats("nobody", "R1", 24); st != nil {
		t.Errorf("unknown operator, got %s", toJSON(st))
	}
}

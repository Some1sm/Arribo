package main

import (
	"path/filepath"
	"strings"
	"testing"
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
	now := float64(nowMs())
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

package main

import (
	"path/filepath"
	"testing"
)

// TestNetworkReport: the train blocks in the bus report's shapes, with the
// rail rules (on time up to 5 min, severe beyond 15), stations below the
// minimum left out, and the per-hour heatmap cells.
func TestNetworkReport(t *testing.T) {
	t.Setenv("DB_PATH", filepath.Join(t.TempDir(), "h.db"))
	h := newHistoryDB()
	if !h.init() {
		t.Fatal("init")
	}
	defer h.close()
	now := float64(nowMs())
	i := 0
	add := func(agency, line, stop string, delay float64) {
		i++
		h.recordStopVisit(O("vehicleId", "v"+numToString(float64(i)), "lineCode", line, "stopName", stop,
			"delayMins", delay, "firstTs", now-60000, "lastTs", now-60000, "agencyId", agency, "mode", "rail"))
	}
	for _, d := range []float64{0, 4, 6, 20} { // R1 at Mataró: one on time... one severe
		add("renfe_rodalies", "R1", "Mataró", d)
	}
	for _, d := range []float64{1, 2, 3} {
		add("renfe_rodalies", "R2", "Sants", d)
	}
	add("renfe_rodalies", "R2", "Clot", 30) // one visit: below the station minimum
	add("mataro", "L1", "Rambla", 9)        // another operator's: not counted

	rep, err := h.getNetworkReport(24, nil)
	if err != nil {
		t.Fatal(err)
	}
	var renfe *Obj
	for _, o := range rep.Get("operators").([]any) {
		if field(o, "agencyId") == "renfe_rodalies" {
			renfe = o.(*Obj)
		}
	}
	if renfe == nil {
		t.Fatal("no Rodalies block")
	}
	st := renfe.Get("agencyStats").(*Obj)
	// 8 visits: on time (-1..5) = 0,4,1,2,3 = 5; late (>5) = 6,20,30 = 3; severe (>15) = 20,30.
	if st.Get("totalVisits") != 8.0 || st.Get("onTimePct") != 62.5 || st.Get("latePct") != 37.5 || st.Get("severeLatePct") != 25.0 || st.Get("linesCount") != 2.0 {
		t.Errorf("stats: %s", toJSON(st))
	}
	lines := renfe.Get("rankingMostDelayed").([]any)
	if len(lines) != 2 || field(lines[0], "lineCode") != "R2" || field(lines[0], "avgDelay") != 9.0 {
		t.Errorf("lines (worst first): %s", toJSON(lines))
	}
	stops := renfe.Get("allStopDelays").([]any)
	if len(stops) != 2 {
		t.Fatalf("stops (Clot has one visit): %s", toJSON(stops))
	}
	mat := stops[0].(*Obj)
	if mat.Get("stopName") != "Mataró" || mat.Get("avgDelay") != 7.5 || mat.Get("severeLatePct") != 25.0 || mat.Get("isBottleneck") != true {
		t.Errorf("Mataró: %s", toJSON(mat))
	}
	if stops[1].(*Obj).Get("isBottleneck") != false {
		t.Errorf("Sants is no bottleneck: %s", toJSON(stops[1]))
	}
	cells := mat.Get("hourly").([]any)
	busy := 0
	for _, c := range cells {
		if jsNumber(field(c, "sampleCount")) > 0 {
			busy++
			if field(c, "sampleCount") != 4.0 {
				t.Errorf("cell: %s", toJSON(c))
			}
		}
	}
	if len(cells) != 24 || busy != 1 {
		t.Errorf("heatmap cells: %d, %d busy", len(cells), busy)
	}
	hrs := renfe.Get("hourlyDelays").([]any)
	total := 0.0
	for _, hr := range hrs {
		total += jsNumber(field(hr, "visitCount"))
	}
	if len(hrs) != 24 || total != 8 {
		t.Errorf("hourly: %d rows, %v visits", len(hrs), total)
	}
	if renfe.Get("onTimeMaxMins") != 5.0 || renfe.Get("severeLateMins") != 15.0 || renfe.Get("delayMeasurementComparison") != nil {
		t.Errorf("rules: %s", toJSON(renfe))
	}
}

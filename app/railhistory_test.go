package main

import (
	"path/filepath"
	"testing"
)

// TestRailHistoryMatchesReport: the folded train history gives the train
// report's numbers for the same rows, across incremental runs, and keeps
// Mataró out (Mataró's hourly rollup, in turn, keeps trains out).
func TestRailHistoryMatchesReport(t *testing.T) {
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
	visit := func(agency, line, stop string, delay, agoMin float64) {
		mode := "rail"
		if agency == "mataro" {
			mode = "bus"
		}
		h.recordStopVisit(O("vehicleId", agency+line+numToString(agoMin), "lineCode", line, "stopName", stop,
			"delayMins", delay, "firstTs", now-agoMin*60000, "lastTs", now-agoMin*60000, "agencyId", agency, "mode", mode))
	}
	delays := []float64{-3, -1, 0, 4, 5, 6, 14, 20, 45, 90}
	for i, d := range delays {
		visit("fgc", "S1", "Sarrià", d, float64(i*37))
		visit("renfe_rodalies", "R1", "Mataró", d+1, float64(i*53))
		visit("mataro", "L1", "Rambla", d, float64(i*11))
	}
	if _, err := h.aggregateRailHistory(); err != nil {
		t.Fatalf("fold: %v", err)
	}
	visit("fgc", "S1", "Gràcia", 7, 3) // after the first run: folded incrementally
	if n, err := h.aggregateRailHistory(); err != nil || n != 1 {
		t.Fatalf("second fold covered %v ids (%v)", n, err)
	}
	if n, _ := h.aggregateRailHistory(); n != 0 {
		t.Fatalf("idle fold covered %v ids", n)
	}

	rep, err := h.getOperatorReport(24, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, o := range rep.Get("operators").([]any) {
		op := o.(*Obj)
		id := jsString(op.Get("id"))
		for _, tbl := range []string{"rail_hourly_stats", "rail_daily_station_stats"} {
			r, err := h.get(`SELECT SUM(visits) AS visits, SUM(delay_sum) AS delay_sum, MAX(max_delay) AS max_delay,
			  SUM(early) AS early, SUM(on_time) AS on_time, SUM(late15) AS late15, SUM(late30) AS late30,
			  SUM(late60) AS late60, SUM(late_over60) AS late_over60 FROM `+tbl+` WHERE agency_id = ?`, id)
			if err != nil {
				t.Fatal(err)
			}
			raw, _ := h.get(`SELECT COUNT(*) AS visits, SUM(delay_mins) AS delay_sum, MAX(delay_mins) AS max_delay,
			  SUM(CASE WHEN delay_mins < -1 THEN 1 ELSE 0 END) AS early,
			  SUM(CASE WHEN delay_mins >= -1 AND delay_mins <= 5 THEN 1 ELSE 0 END) AS on_time,
			  SUM(CASE WHEN delay_mins > 5 AND delay_mins <= 15 THEN 1 ELSE 0 END) AS late15,
			  SUM(CASE WHEN delay_mins > 15 AND delay_mins <= 30 THEN 1 ELSE 0 END) AS late30,
			  SUM(CASE WHEN delay_mins > 30 AND delay_mins <= 60 THEN 1 ELSE 0 END) AS late60,
			  SUM(CASE WHEN delay_mins > 60 THEN 1 ELSE 0 END) AS late_over60 FROM stop_visits WHERE agency_id = ?`, id)
			if string(toJSON(r)) != string(toJSON(raw)) {
				t.Errorf("%s %s: folded %s, raw %s", id, tbl, toJSON(r), toJSON(raw))
			}
			if jsNumber(r.Get("visits")) != jsNumber(field(op, "visits")) {
				t.Errorf("%s %s: %v visits, report %v", id, tbl, r.Get("visits"), field(op, "visits"))
			}
		}
	}
	if r, _ := h.get(`SELECT COUNT(*) AS n FROM rail_daily_station_stats WHERE agency_id = 'mataro'`); r.Num("n") != 0 {
		t.Error("Mataró folded into the train history")
	}
	if _, err := h.aggregateHourlyVisitStats(); err != nil {
		t.Fatal(err)
	}
	if r, _ := h.get(`SELECT COUNT(*) AS n FROM hourly_line_visit_stats WHERE agency_id <> 'mataro'`); r.Num("n") != 0 {
		t.Error("trains folded into Mataró's hourly rollup")
	}
	if r, _ := h.get(`SELECT SUM(visit_count) AS n FROM hourly_line_visit_stats`); r.Num("n") != 10 {
		t.Errorf("Mataró hourly visits: %s", toJSON(r))
	}
}

// TestRailHistoryDaily: per-day figures from the folded history; days
// without visits are absent, today is partial, a line filter applies.
func TestRailHistoryDaily(t *testing.T) {
	t.Setenv("DB_PATH", filepath.Join(t.TempDir(), "h.db"))
	h := newHistoryDB()
	if !h.init() {
		t.Fatal("init")
	}
	defer h.close()
	now := float64(nowMs())
	add := func(line string, delay, daysAgo float64) {
		h.recordStopVisit(O("vehicleId", "v"+numToString(delay)+line, "lineCode", line, "stopName", "Sarrià",
			"delayMins", delay, "firstTs", now-daysAgo*86400000, "lastTs", now-daysAgo*86400000, "agencyId", "fgc", "mode", "rail"))
	}
	add("S1", 0, 0)
	add("S1", 10, 0)
	add("S2", 2, 0)
	add("S1", 4, 3) // three days ago; one and two days ago have nothing
	if _, err := h.aggregateRailHistory(); err != nil {
		t.Fatal(err)
	}
	all, err := h.getRailHistory("fgc", "", 30)
	if err != nil {
		t.Fatal(err)
	}
	daily := all.Get("daily").([]any)
	if len(daily) != 2 {
		t.Fatalf("days: %s", toJSON(all))
	}
	old, today := daily[0].(*Obj), daily[1].(*Obj)
	if old.Get("partial") != true || old.Get("partialReason") != "first_day" || old.Get("visits") != 1.0 || old.Get("onTimePct") != 100.0 {
		t.Errorf("old day: %s", toJSON(old))
	}
	if today.Get("partialReason") != "today" || today.Get("visits") != 3.0 || today.Get("avgDelay") != 4.0 || today.Get("onTimePct") != 66.7 || today.Get("late15Pct") != 33.3 {
		t.Errorf("today: %s", toJSON(today))
	}
	if all.Get("to") != today.Get("date") || all.Get("firstDate") != old.Get("date") {
		t.Errorf("range: %s", toJSON(all))
	}
	if tot := all.Get("total").(*Obj); tot.Get("visits") != 4.0 || tot.Get("onTimePct") != 75.0 || tot.Get("avgDelay") != 4.0 || tot.Get("daysWithData") != 2.0 {
		t.Errorf("total: %s", toJSON(tot))
	}
	s2, _ := h.getRailHistory("fgc", "S2", 30)
	if d := s2.Get("daily").([]any); len(d) != 1 || d[0].(*Obj).Get("avgDelay") != 2.0 {
		t.Errorf("S2: %s", toJSON(s2))
	}
	if _, err := h.getRailHistory("nope", "", 30); err == nil {
		t.Error("unknown operator accepted")
	}
}

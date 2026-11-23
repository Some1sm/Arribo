package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRailCancellationsStoredAndCounted(t *testing.T) {
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
	now := nowMs() / 1000
	c := railCancel{AgencyID: "renfe_rodalies", TripID: "t1", ServiceDate: "20261123", Line: "R1", Headsign: "Mataró", Start: now - 600, Seen: now - 900}
	h.recordRailCancel(c)
	c.Seen = now - 300 // seen again: same row, later last_seen
	h.recordRailCancel(c)
	h.recordRailCancel(railCancel{AgencyID: "renfe_rodalies", TripID: "t2", ServiceDate: "20261123", Line: "R4", Start: now - 1200, Seen: now})
	h.recordRailCancel(railCancel{AgencyID: "fgc", TripID: "f1", ServiceDate: "20261123", Line: "S1", Start: now - 60, Seen: now})
	h.recordRailCancel(railCancel{AgencyID: "renfe_rodalies", TripID: "old", ServiceDate: "20261101", Line: "R1", Start: now - 30*86400, Seen: now - 30*86400})

	total, byLine := h.railCancelCounts("renfe_rodalies", float64((now-86400)*1000), float64(now*1000))
	if total != 2 || byLine["R1"] != 1 || byLine["R4"] != 1 {
		t.Fatalf("counts: %v %v", total, byLine)
	}
	row, _ := h.get(`SELECT COUNT(*) AS n, MAX(last_seen) AS ls FROM rail_cancellations WHERE trip_id = 't1'`)
	if row.Num("n") != 1 || int64(row.Num("ls")) != (now-300)*1000 {
		t.Errorf("upsert: %s", toJSON(row))
	}
	// The report carries the totals, and a line with only cancellations.
	rep, err := h.getOperatorReport(24, nil)
	if err != nil {
		t.Fatal(err)
	}
	js := string(toJSON(rep))
	if !strings.Contains(js, `"cancelled":2`) || !strings.Contains(js, `"line":"R4","visits":0`) || !strings.Contains(js, `"cancelled":1`) {
		t.Errorf("report: %s", js)
	}
}

func TestCancelForServiceDay(t *testing.T) {
	tt := openRailTestTimetable(t) // trip "long" leaves A at 09:00, every day
	ctx := context.Background()
	at := func(s string) time.Time {
		v, _ := time.ParseInLocation("2006-01-02 15:04", s, madrid)
		return v
	}
	// Seen at 08:30: today's 09:00 departure.
	c, ok := cancelFor(ctx, tt, "fgc", TripDescriptor{TripID: "long"}, at("2026-11-23 08:30"))
	if !ok || c.ServiceDate != "20261123" || c.Line != "L6" || c.Headsign != "Pl. Catalunya" {
		t.Errorf("morning: %+v %v", c, ok)
	}
	// Seen at 23:50: tomorrow's 09:00 is nearer than today's.
	if c, ok := cancelFor(ctx, tt, "fgc", TripDescriptor{TripID: "long"}, at("2026-11-23 23:50")); !ok || c.ServiceDate != "20261124" {
		t.Errorf("late night: %+v %v", c, ok)
	}
	// A start_date in the feed wins.
	if c, ok := cancelFor(ctx, tt, "fgc", TripDescriptor{TripID: "long", StartDate: "20261125"}, at("2026-11-23 08:30")); !ok || c.ServiceDate != "20261125" {
		t.Errorf("start_date: %+v %v", c, ok)
	}
	if _, ok := cancelFor(ctx, tt, "fgc", TripDescriptor{TripID: "nowhere"}, at("2026-11-23 08:30")); ok {
		t.Error("a trip outside the timetable is not kept")
	}
}

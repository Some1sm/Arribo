package main

import "testing"

func madridMs(t *testing.T, s string) int64 {
	t.Helper()
	ms, ok := parseMadridMinute(s)
	if !ok {
		t.Fatalf("parse %q", s)
	}
	return ms
}

func TestMataroEventsFile(t *testing.T) {
	list, err := readMataroEvents("../src/data/mataro_events.json")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 5 {
		t.Fatalf("events: %d, want the 5 seeded 2026 Les Santes events", len(list))
	}
	mataroEventsOnce.Do(func() {})
	saved := mataroEventList
	mataroEventList = list
	defer func() { mataroEventList = saved }()

	in := madridMs(t, "2026-07-18 20:00")
	if n := calendarNotices("1", in); len(n) != 1 {
		t.Fatalf("L1 during Dissantes: %d notices", len(n))
	} else if o := n[0].(*Obj); o.Get("source") != "calendar" || o.Get("severity") != "warning" ||
		o.Get("affectedLines") != "L1, L2, L4, L6, L8" || o.Get("expiresAt") != "2026-07-19T06:00:00.000Z" {
		t.Errorf("notice: %s", toJSON(o))
	}
	if n := calendarNotices("3", in); len(n) != 0 {
		t.Errorf("L3 is not diverted on Dissantes: %d", len(n))
	}
	if n := calendarNotices("1", madridMs(t, "2026-07-19 08:00")); len(n) != 0 {
		t.Errorf("the end is exclusive: %d", len(n))
	}
	focs := madridMs(t, "2026-07-27 23:30")
	if n := calendarNotices("", focs); len(n) != 1 {
		t.Errorf("all notices during the fireworks: %d", len(n))
	}
	if n := calendarNotices("5", focs); len(n) != 0 {
		t.Errorf("a general notice is not a line's warning (as getDisruptions): %d", len(n))
	}
	if n := calendarNotices("", madridMs(t, "2026-11-24 12:00")); len(n) != 0 {
		t.Errorf("nothing open today: %d", len(n))
	}
}

func TestMataroEventsClosedStops(t *testing.T) {
	mataroEventsOnce.Do(func() {})
	saved := mataroEventList
	defer func() { mataroEventList = saved }()
	mk := func(id, start, end string, lines, stops []string) mataroEvent {
		e := mataroEvent{ID: id, Title: id, Lines: lines, Stops: stops}
		e.startMs, e.endMs = madridMs(t, start), madridMs(t, end)
		return e
	}
	mataroEventList = []mataroEvent{
		mk("a", "2026-07-24 19:30", "2026-07-24 21:30", []string{"3"}, []string{"1001", "1002"}),
		mk("b", "2026-07-24 19:00", "2026-07-24 22:00", nil, []string{"1002", "1003"}),
	}
	at := madridMs(t, "2026-07-24 20:00")
	got := calendarClosedStops("3", at)
	if len(got) != 3 || got["1001"] != "a" || got["1002"] != "a" || got["1003"] != "b" {
		t.Errorf("L3: %v", got)
	}
	if got := calendarClosedStops("1", at); len(got) != 2 || got["1003"] != "b" {
		t.Errorf("L1 only gets the all-lines event: %v", got)
	}
	if got := calendarClosedStops("3", madridMs(t, "2026-07-24 22:00")); got != nil {
		t.Errorf("after both windows: %v", got)
	}
}

func TestParseMadridMinute(t *testing.T) {
	if _, ok := parseMadridMinute("2026-03-29 02:30"); ok {
		t.Errorf("a time in the spring gap must be refused")
	}
	if _, ok := parseMadridMinute("2026-07-18T19:00"); ok {
		t.Errorf("only 'YYYY-MM-DD HH:MM' is read")
	}
	if ms, ok := parseMadridMinute("2026-07-18 19:00"); !ok || isoString(ms) != "2026-07-18T17:00:00.000Z" {
		t.Errorf("summer time: %v", isoString(ms))
	}
}

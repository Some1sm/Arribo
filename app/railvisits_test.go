package main

import (
	"context"
	"testing"
	"time"
)

// rvFeed builds a Renfe-style feed: each trip lists stops with predicted
// time and delay.
func rvFeed(trips map[string][][3]int64) *FeedMessage {
	fm := &FeedMessage{}
	for trip, stops := range trips {
		tu := &TripUpdate{Trip: TripDescriptor{TripID: trip}}
		for _, s := range stops { // {stop id number, predicted unix, delay s}
			t, d := s[1], int32(s[2])
			tu.StopTimeUpdates = append(tu.StopTimeUpdates, StopTimeUpdate{
				StopID: "S" + string(rune('0'+s[0])), Arrival: &StopTimeEvent{Time: &t, Delay: &d},
			})
		}
		fm.Entities = append(fm.Entities, Entity{ID: trip, TripUpdate: tu})
	}
	return fm
}

func TestRailVisitTracker(t *testing.T) {
	ctx := context.Background()
	tr := newRailVisitTracker("renfe_rodalies", "rail")
	t0 := time.Unix(1795100000, 0)

	// Poll 1: trip A next stop S1 (+60 s), trip B next stop S1 (+12000 s, implausible), trip C next stop S2.
	got := tr.observe(ctx, t0, nil, rvFeed(map[string][][3]int64{
		"A": {{1, t0.Unix() + 120, 60}},
		"B": {{1, t0.Unix() + 300, 12000}},
		"C": {{2, t0.Unix() + 600, 0}},
	}))
	if len(got) != 0 {
		t.Fatalf("poll 1 closed %v", got)
	}
	// Poll 2 (+30 s): A's S1 updated to +90 s and still listed; B moved on to S2 (S1 closes, implausible); C unchanged.
	t1 := t0.Add(30 * time.Second)
	got = tr.observe(ctx, t1, nil, rvFeed(map[string][][3]int64{
		"A": {{1, t0.Unix() + 150, 90}},
		"B": {{2, t0.Unix() + 900, 12000}},
		"C": {{2, t0.Unix() + 600, 0}},
	}))
	if len(got) != 0 || tr.Implausible != 1 {
		t.Fatalf("poll 2: closed %v, implausible %d", got, tr.Implausible)
	}
	// Poll 3 (+60 s): A moved on to S2, so A@S1 closes with its last delay (90 s); C vanished from the feed.
	t2 := t0.Add(60 * time.Second)
	got = tr.observe(ctx, t2, nil, rvFeed(map[string][][3]int64{
		"A": {{2, t0.Unix() + 400, 100}},
		"B": {{2, t0.Unix() + 900, 12000}},
	}))
	if len(got) != 1 || got[0].TripID != "A" || got[0].StopID != "S1" || got[0].DelaySec != 90 ||
		got[0].ActualUnix != t0.Unix()+150 || got[0].ScheduledUnix != t0.Unix()+60 || got[0].AgencyID != "renfe_rodalies" || got[0].Mode != "rail" {
		t.Fatalf("poll 3 closed %+v", got)
	}
	// Poll 4 (+20 min): A still lists S2 but predicted 13+ min ago -> closes by time.
	// C has been gone > 10 min and its S2 (t0+600) is in the past -> closes too.
	// B's S2 closes by time as implausible.
	t3 := t0.Add(20 * time.Minute)
	got = tr.observe(ctx, t3, nil, rvFeed(map[string][][3]int64{
		"A": {{2, t0.Unix() + 400, 100}},
	}))
	if len(got) != 2 || tr.Implausible != 2 {
		t.Fatalf("poll 4 closed %+v implausible %d", got, tr.Implausible)
	}
	if len(tr.open) != 0 {
		t.Fatalf("still open: %d", len(tr.open))
	}

	// A trip that disappears before its stop's predicted time gives no visit.
	tr2 := newRailVisitTracker("x", "rail")
	tr2.observe(ctx, t0, nil, rvFeed(map[string][][3]int64{"D": {{3, t0.Unix() + 3600, 0}}}))
	got = tr2.observe(ctx, t0.Add(11*time.Minute), nil, &FeedMessage{})
	if len(got) != 0 || len(tr2.open) != 0 {
		t.Fatalf("vanished trip: closed %v, open %d", got, len(tr2.open))
	}
}

// TestStuTimesTimetableChecks: trip "long" of the rail test timetable leaves
// A at 09:00 and reaches B at 09:05 and C at 09:09, every day.
func TestStuTimesTimetableChecks(t *testing.T) {
	tt := openRailTestTimetable(t)
	ctx := context.Background()
	ref, err := gtfsServiceDayRef("20261123")
	if err != nil {
		t.Fatal(err)
	}
	at := func(hms int64) int64 { return ref.Unix() + hms }
	stu := func(stop string, tm *int64, d *int32) StopTimeUpdate {
		return StopTimeUpdate{StopID: stop, Arrival: &StopTimeEvent{Time: tm, Delay: d}}
	}
	i64 := func(v int64) *int64 { return &v }
	i32 := func(v int32) *int32 { return &v }
	renfe := &TripUpdate{Trip: TripDescriptor{TripID: "long"}}
	fgc := &TripUpdate{Trip: TripDescriptor{TripID: "long", StartDate: "20261123"}}
	b, c := int64(9*3600+5*60), int64(9*3600+9*60)
	cases := []struct {
		name        string
		tu          *TripUpdate
		s           StopTimeUpdate
		ok          bool
		sched, pred int64
	}{
		{"feed delay agrees", renfe, stu("B", i64(at(b+120)), i32(120)), true, at(b), at(b + 120)},
		{"feed rounding: timetable's seconds kept", renfe, stu("B", i64(at(b+130)), i32(120)), true, at(b), at(b + 130)},
		{"before the origin departure", renfe, stu("B", i64(at(b-15*60)), i32(-900)), false, 0, 0},
		{"within the origin slack", renfe, stu("B", i64(at(9*3600-30)), i32(-330)), true, at(b), at(9*3600 - 30)},
		{"feed delay contradicts its time", renfe, stu("B", i64(at(b+840)), i32(-360)), false, 0, 0},
		{"origin stop itself may be early", renfe, stu("A", i64(at(9*3600-120)), i32(-120)), true, at(9 * 3600), at(9*3600 - 120)},
		{"stop not in the timetable: feed as sent", renfe, stu("Z", i64(at(b)), i32(60)), true, at(b - 60), at(b)},
		{"time only with start_date", fgc, stu("C", i64(at(c+60)), nil), true, at(c), at(c + 60)},
		{"time only, before the origin departure", fgc, stu("C", i64(at(8*3600)), nil), false, 0, 0},
	}
	for _, k := range cases {
		sched, pred, ok := stuTimes(ctx, tt, k.tu, k.s)
		if ok != k.ok || (ok && (sched != k.sched || pred != k.pred)) {
			t.Errorf("%s: got %v %d %d, want %v %d %d", k.name, ok, sched-ref.Unix(), pred-ref.Unix(), k.ok, k.sched-ref.Unix(), k.pred-ref.Unix())
		}
	}
}

package main

import (
	"testing"
	"time"
)

func TestMovSchedStoreRollingExpiryAndDayType(t *testing.T) {
	dir := t.TempDir()
	st := newMovSchedStore(dir)
	// Wednesday 2026-11-25 15:00 Madrid
	wed := time.Date(2026, 11, 25, 15, 0, 0, 0, madrid)
	st.record(7018, []movStopETA{
		{LineID: 53, Dest: "Barcelona", Sched: []string{"15:59", "16:44"}},
	}, wed)
	// Second observation merges new times without losing earlier ones.
	st.record(7018, []movStopETA{
		{LineID: 53, Dest: "Barcelona", Sched: []string{"16:44", "17:29"}},
	}, wed.Add(30*time.Minute))

	got := st.lookup(53, 7018, wed.Add(2*time.Hour))
	if got == nil || len(got["Barcelona"]) != 3 {
		t.Fatalf("expected 3 merged times, got %v", got)
	}

	// Saturday does not read Wednesday's weekday schedule.
	sat := time.Date(2026, 11, 28, 10, 0, 0, 0, madrid)
	if gotSat := st.lookup(53, 7018, sat); gotSat != nil {
		t.Fatalf("weekday schedule leaked into Saturday: %v", gotSat)
	}

	// Persists across restart.
	st.save(true)
	st2 := newMovSchedStore(dir)
	if got2 := st2.lookup(53, 7018, wed.Add(2*time.Hour)); got2 == nil || len(got2["Barcelona"]) != 3 {
		t.Fatalf("persisted reload lost schedule: %v", got2)
	}

	// Staggered TTL sits in [20h, 24h) and expires cleanly afterwards.
	ttl := movSchedTTL(7018)
	if ttl < 20*time.Hour || ttl >= 24*time.Hour {
		t.Fatalf("unexpected TTL %s", ttl)
	}
	if exp := st.lookup(53, 7018, wed.Add(25*time.Hour)); exp != nil {
		t.Fatalf("expected entry to expire after 25h, got %v", exp)
	}
}

package main

import (
	"testing"
	"time"
)

func TestRtServiceDayRef(t *testing.T) {
	// A normal day: the reference is local midnight.
	ref, err := gtfsServiceDayRef("20261119")
	if err != nil || !ref.Equal(time.Date(2026, 11, 19, 0, 0, 0, 0, madrid)) {
		t.Fatalf("normal day: %v %v", ref, err)
	}
	// Spring-forward day (2026-03-29, clocks 02:00 -> 03:00): noon is CEST,
	// so noon minus 12 h is 23:00 CET on the 28th, and 08:00 on the
	// timetable (28800 s) is 08:00 local, not 09:00.
	ref, err = gtfsServiceDayRef("20260329")
	if err != nil || !ref.Equal(time.Date(2026, 3, 28, 23, 0, 0, 0, madrid)) {
		t.Fatalf("spring-forward day: %v %v", ref, err)
	}
	if got := time.Unix(ref.Unix()+28800, 0).In(madrid); got.Hour() != 8 {
		t.Fatalf("08:00 on the spring-forward day resolves to %v", got)
	}
	// Fall-back day (2026-10-25): noon is CET, so noon minus 12 h is 01:00
	// CEST, an hour after midnight; 08:00 on the timetable is still 08:00.
	ref, _ = gtfsServiceDayRef("20261025")
	if got := time.Unix(ref.Unix()+28800, 0).In(madrid); got.Hour() != 8 {
		t.Fatalf("08:00 on the fall-back day resolves to %v", got)
	}
	if _, err := gtfsServiceDayRef("2026-11-19"); err == nil {
		t.Fatal("bad date accepted")
	}
}

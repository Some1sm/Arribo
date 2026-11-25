package main

import (
	"testing"
	"time"
)

func TestFormatScheduleDayObj(t *testing.T) {
	// Duplicate minute, unsorted, plus post-midnight 24:15 -> 00:15 kept at end.
	o := formatScheduleDayObj([]int{6*3600 + 30*60, 6*3600 + 15*60, 6*3600 + 15*60 + 20, 24*3600 + 15*60})
	if o.Num("count") != 3 {
		t.Fatalf("count = %v, want 3", o.Num("count"))
	}
	if o.Str("first") != "06:15" || o.Str("last") != "00:15" {
		t.Fatalf("first=%q last=%q, want 06:15 .. 00:15", o.Str("first"), o.Str("last"))
	}
	empty := formatScheduleDayObj(nil)
	if empty.Num("count") != 0 || empty.Get("first") != nil {
		t.Fatalf("unexpected empty schedule obj: %v", empty)
	}
}

func TestTodayScheduleDayTypeAndNextWeekday(t *testing.T) {
	wed := time.Date(2026, 11, 25, 12, 0, 0, 0, madrid) // Wednesday
	if got := todayScheduleDayType(wed); got != "weekday" {
		t.Fatalf("got %q, want weekday", got)
	}
	sat := nextWeekdayDate(wed, time.Saturday)
	if sat.Weekday() != time.Saturday || sat.Day() != 28 {
		t.Fatalf("next Saturday = %v", sat)
	}
	sun := nextWeekdayDate(wed, time.Sunday)
	if sun.Weekday() != time.Sunday || sun.Day() != 29 {
		t.Fatalf("next Sunday = %v", sun)
	}
}

func TestGencatBusSpatialDedup(t *testing.T) {
	idx := map[string][][2]float64{}
	// Moventis C-10 in Mataró-Barcelona
	movC10 := &rtLineProfile{
		Code:       "C-10",
		Directions: []rtLineDirection{{Stops: []rtLineStop{{Lat: 41.53, Lon: 2.44}}}},
	}
	recordDedicatedBus(idx, movAgencyID, "C-10", movC10)
	// Girona L1 in Girona
	girL1 := &rtLineProfile{
		Code:       "L1",
		Directions: []rtLineDirection{{Stops: []rtLineStop{{Lat: 41.98, Lon: 2.82}}}},
	}
	recordDedicatedBus(idx, gironaAgencyID, "L1", girL1)

	// gencat_bus C10 near Mataró -> duplicate!
	gcC10 := &rtLineProfile{
		Code:       "C10",
		Directions: []rtLineDirection{{Stops: []rtLineStop{{Lat: 41.52, Lon: 2.42}}}},
	}
	if !isGencatBusDuplicate("C10", gcC10, idx) {
		t.Fatal("expected gencat_bus:C10 near Mataró to be deduplicated against moventis:C-10")
	}

	// gencat_bus L1 in El Vendrell (135 km from Girona) -> NOT a duplicate!
	gcVendrellL1 := &rtLineProfile{
		Code:       "L1",
		Directions: []rtLineDirection{{Stops: []rtLineStop{{Lat: 41.22, Lon: 1.53}}}},
	}
	if isGencatBusDuplicate("L1", gcVendrellL1, idx) {
		t.Fatal("expected gencat_bus:L1 in El Vendrell NOT to be shadowed by girona:L1")
	}
}

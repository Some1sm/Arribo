package main

import (
	"context"
	"testing"
)

func TestInferRouteDirections(t *testing.T) {
	seqs := map[string][]string{
		"long":   {"A", "B", "C", "D", "E"}, // reference: most stops
		"same":   {"B", "C", "D"},
		"back":   {"E", "D", "C"},
		"zback":  {"E", "D", "C", "B", "A"}, // ties with long; long wins by id
		"branch": {"X", "Y", "C", "D"},      // shares C, D in order
		"one":    {"X", "C"},                // only one shared stop: unknown
		"none":   {"X", "Y"},                // no shared stop: unknown
	}
	got := inferRouteDirections(seqs)
	// "one" and "none" get a direction through "branch", which they overlap.
	want := map[string]int{"long": 0, "same": 0, "back": 1, "zback": 1, "branch": 0, "one": 0, "none": 0}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for id, d := range want {
		if g, ok := got[id]; !ok || g != d {
			t.Errorf("%s: got %v (%v), want %d", id, g, ok, d)
		}
	}
	// A stop the reference visits twice (a loop) does not decide.
	loop := inferRouteDirections(map[string][]string{
		"ref": {"A", "B", "C", "B", "D"},
		"t":   {"B", "C"}, // B is ambiguous; C alone is one stop: unknown
		"u":   {"D", "C"},
	})
	if _, ok := loop["t"]; ok {
		t.Errorf("loop: t should stay unknown, got %v", loop)
	}
	if loop["u"] != 1 {
		t.Errorf("loop: u got %v, want 1", loop)
	}
}

// TestImportInfersDirections: a feed without direction_id gets directions
// from stop order; one with direction_id keeps the operator's.
func TestImportInfersDirections(t *testing.T) {
	feed := railTestFeed()
	feed["trips.txt"] = "route_id,service_id,trip_id,trip_headsign,shape_id\n" +
		"RL6,S,short,Gràcia,\nRL6,S,long,Pl. Catalunya,SH\nRL6,S,back,,\n"
	tt := openRailTestTimetableWith(t, feed)
	ctx := context.Background()
	for trip, want := range map[string]int{"short": 0, "long": 0, "back": 1} {
		if got := tt.tripDirection(ctx, trip); got != want {
			t.Errorf("%s: direction %d, want %d", trip, got, want)
		}
	}
	var v string
	if err := tt.db.QueryRow(`SELECT value FROM gtfs_meta WHERE key = 'import_format'`).Scan(&v); err != nil || v != gtfsImportFormat {
		t.Errorf("import_format %q %v", v, err)
	}

	// The operator's own direction_id is kept as sent (here reversed on purpose).
	feed = railTestFeed()
	feed["trips.txt"] = "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\n" +
		"RL6,S,short,Gràcia,1,\nRL6,S,long,Pl. Catalunya,1,SH\nRL6,S,back,,0,\n"
	tt2 := openRailTestTimetableWith(t, feed)
	if tt2.tripDirection(ctx, "long") != 1 || tt2.tripDirection(ctx, "back") != 0 {
		t.Errorf("operator directions changed")
	}
}

// TestInferDirectionsChained: the reference covers one section only; trips
// of another section get oriented through a trip spanning both.
func TestInferDirectionsChained(t *testing.T) {
	got := inferRouteDirections(map[string][]string{
		"north":   {"P", "Q", "R", "S", "T", "U"}, // reference (most stations)
		"span":    {"U", "T", "V", "W"},           // reverse of north, then south
		"south":   {"V", "W", "X"},                // shares nothing with north
		"southBk": {"X", "W"},
	})
	want := map[string]int{"north": 0, "span": 1, "south": 1, "southBk": 0}
	for id, d := range want {
		if g, ok := got[id]; !ok || g != d {
			t.Errorf("%s: got %v (%v), want %d", id, g, ok, d)
		}
	}
}

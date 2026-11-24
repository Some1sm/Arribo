package main

import (
	"math"
	"testing"
	"time"
)

func loadTestGencat(t *testing.T) *gcData {
	t.Helper()
	g, err := readGencat("../src/data/gencat_casas.json")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return g
}

func TestGencatTimetable(t *testing.T) {
	g := loadTestGencat(t)
	if len(g.byMovLine) != 7 {
		t.Fatalf("lines joined to moventis ids: %d, want 7", len(g.byMovLine))
	}
	// Saturday 28 Nov 2026, 10:00 in Madrid; stop 7001 (Camí Ral, Premià de
	// Mar) is served by the C-10 (53) and the night N-80 (68).
	now := time.UnixMilli(localTimeToUtcDate(2026, 10, 28, 10, 0, 0))
	if next, ok := g.nextDeparture(53, 7001, now); !ok || next.IsZero() || next.Before(now) || next.Sub(now) > 90*time.Minute {
		t.Errorf("C-10 at 7001 after 10:00: %v ok=%v, want within 90 min", next, ok)
	}
	if next, ok := g.nextDeparture(68, 7001, now); !ok || (!next.IsZero() && next.Sub(now) < 6*time.Hour) {
		t.Errorf("N-80 at 7001 after 10:00: %v ok=%v, want nothing until the night", next, ok)
	}
	// Past midnight the night bus is due again (service day of the 24th or 25th).
	night := time.UnixMilli(localTimeToUtcDate(2026, 10, 25, 0, 30, 0))
	if next, ok := g.nextDeparture(68, 7001, night); !ok || next.IsZero() || next.Sub(night) > 70*time.Minute {
		t.Errorf("N-80 at 7001 after 00:30: %v ok=%v, want within 70 min", next, ok)
	}
	if _, ok := g.nextDeparture(53, 999999, now); ok {
		t.Errorf("an unknown stop must say the timetable does not know it")
	}
	if _, ok := g.nextDeparture(1, 7001, now); ok {
		t.Errorf("an unknown line must say the timetable does not know it")
	}
}

func TestGencatServiceRuns(t *testing.T) {
	g := &gcData{Services: map[string]gcService{
		"W": {Days: [7]int{1, 1, 1, 1, 1, 0, 0}, Start: "20260101", End: "20261231", Removed: []string{"20261208"}},
		"X": {Start: "20260101", End: "20261231", Added: []string{"20261206"}},
	}}
	g.index()
	for _, c := range []struct {
		svc, date string
		want      bool
	}{
		{"W", "20261124", true},  // Tuesday
		{"W", "20261129", false}, // Sunday
		{"W", "20261208", false}, // removed
		{"W", "20270104", false}, // after the end
		{"X", "20261206", true},  // added
		{"X", "20261207", false},
	} {
		if got := g.runs(c.svc, c.date); got != c.want {
			t.Errorf("runs(%s, %s) = %v, want %v", c.svc, c.date, got, c.want)
		}
	}
	if gcClock("25:10:05") != 25*3600+10*60+5 || gcClock("7:5") != -1 {
		t.Errorf("gcClock")
	}
}

// On an out-and-back street the stops of the way back belong to the second
// pass, not to the nearer point of the first.
func TestGencatFitFollowsOrder(t *testing.T) {
	shape := [][2]float64{{41.5, 2.40}, {41.5, 2.41}, {41.5003, 2.41}, {41.5003, 2.40}}
	stops := []movStop{
		{ID: 1, Lat: 41.5, Lon: 2.402},
		{ID: 2, Lat: 41.5, Lon: 2.408},
		{ID: 3, Lat: 41.5003, Lon: 2.408}, // way back, 33 m from the way out
		{ID: 4, Lat: 41.5003, Lon: 2.402},
	}
	along, off, cum := gcFit(shape, stops)
	for i := 1; i < len(along); i++ {
		if along[i] < along[i-1] {
			t.Fatalf("along goes back: %v", along)
		}
	}
	if along[2] < cum[2] || along[3] < along[2]+400 {
		t.Errorf("stops 3 and 4 must lie on the way back: along %v, cum %v", along, cum)
	}
	for i, o := range off {
		if o > 5 {
			t.Errorf("stop %d off by %.1f m", i+1, o)
		}
	}
}

// A bus halfway between two stops on an L-shaped road sits at the corner,
// not on the diagonal.
func TestMovAtFollowsShape(t *testing.T) {
	shape := [][2]float64{{41.50, 2.40}, {41.50, 2.41}, {41.51, 2.41}}
	stops := []movStop{{ID: 1, Lat: 41.50, Lon: 2.40, Km: 0}, {ID: 2, Lat: 41.51, Lon: 2.41, Km: 2}}
	rt := movRoute{LineID: 53, Stops: stops, Shape: shape}
	rt.ShapeAlong, _, rt.ShapeCum = gcFit(shape, stops)
	legA, legB := rt.ShapeCum[1], rt.ShapeCum[2]-rt.ShapeCum[1]
	km := 2 * legA / (legA + legB) // the corner's share of the way
	lat, lon, _ := movAt(rt, km)
	if math.Abs(lat-41.50) > 1e-4 || math.Abs(lon-2.41) > 1e-4 {
		t.Errorf("at the corner's share: %.5f, %.5f, want 41.50000, 2.41000", lat, lon)
	}
	plain := movRoute{LineID: 53, Stops: stops}
	if lat, lon, _ := movAt(plain, 1); math.Abs(lat-41.505) > 1e-6 || math.Abs(lon-2.405) > 1e-6 {
		t.Errorf("without a shape the straight line is kept: %.5f, %.5f", lat, lon)
	}
	trim := movShapeTrim(rt)
	if len(trim) != 3 {
		t.Errorf("trimmed shape: %v", trim)
	}
}

// Every direction of every line fits one of its own shapes.
func TestGencatRealRoutesFit(t *testing.T) {
	g := loadTestGencat(t)
	for id, line := range g.byMovLine {
		for _, d := range line.Directions {
			if len(d.Patterns) == 0 {
				continue
			}
			var stops []movStop
			for _, si := range d.Patterns[0].Stops {
				s := d.Stops[si]
				stops = append(stops, movStop{Name: s.Name, Lat: s.Lat, Lon: s.Lon})
			}
			shape, along, cum := g.routeShape(movRoute{LineID: id, Stops: stops})
			if shape == nil {
				t.Errorf("%s direction %d: no shape fits its own main pattern", line.Code, d.DirectionID)
				continue
			}
			if along[len(along)-1] <= along[0] || cum[len(cum)-1] < along[len(along)-1] {
				t.Errorf("%s direction %d: along %v..%v of %v", line.Code, d.DirectionID, along[0], along[len(along)-1], cum[len(cum)-1])
			}
		}
	}
}

func TestMovShouldAskUsesTimetable(t *testing.T) {
	now := time.UnixMilli(localTimeToUtcDate(2026, 10, 24, 12, 0, 0))
	idle := movStopObs{At: now.Add(-40 * time.Minute), Lines: map[int]movLineObs{}}
	followed := []int{68}
	none := func(int) (time.Time, bool) { return time.Time{}, true }
	if movShouldAsk(now, idle, true, followed, none) {
		t.Errorf("nothing due by the timetable: the 30-min re-ask waits")
	}
	old := idle
	old.At = now.Add(-2*time.Hour - time.Minute)
	if !movShouldAsk(now, old, true, followed, none) {
		t.Errorf("asked again after movIdleAskGap even with nothing due")
	}
	soon := func(int) (time.Time, bool) { return now.Add(20 * time.Minute), true }
	fresh := movStopObs{At: now.Add(-time.Minute), Lines: map[int]movLineObs{}}
	if !movShouldAsk(now, fresh, true, followed, soon) {
		t.Errorf("a departure due in 20 min by the timetable is asked")
	}
	unknown := func(int) (time.Time, bool) { return time.Time{}, false }
	if !movShouldAsk(now, idle, true, followed, unknown) {
		t.Errorf("an unknown line keeps the 30-min re-ask")
	}
	later := func(int) (time.Time, bool) { return now.Add(90 * time.Minute), true }
	if !movShouldAsk(now, idle, true, followed, later) {
		t.Errorf("a departure due within movIdleAskGap keeps the 30-min re-ask")
	}
}

// A day on which the file has no trip of a line at all is a gap in the feed
// (the C-10's weekday service had no 2026 dates), not a day without buses.
func TestGencatDayWithoutTripsIsUnknown(t *testing.T) {
	g := &gcData{
		Lines: []gcLine{{Code: "C-10", Directions: []gcDir{{
			Stops:    []gcStop{{ID: "S1"}},
			Patterns: []gcPattern{{Stops: []int{0}}},
			Trips:    []gcTrip{{Service: "SAT", Pattern: 0, Times: []string{"10:15:00"}}},
		}}}},
		Services: map[string]gcService{"SAT": {Start: "20260101", End: "20271231", Added: []string{"20261128"}}},
	}
	g.Crosswalk.LineIds = map[string]int{"C-10": 53}
	g.Crosswalk.Stops = map[string]struct {
		Gtfs string `json:"gtfs"`
	}{"7001": {Gtfs: "S1"}}
	g.index()
	sat := time.UnixMilli(localTimeToUtcDate(2026, 10, 28, 10, 0, 0))
	if next, ok := g.nextDeparture(53, 7001, sat); !ok || next.Sub(sat) != 15*time.Minute {
		t.Errorf("Saturday: %v ok=%v, want 10:15", next, ok)
	}
	tue := time.UnixMilli(localTimeToUtcDate(2026, 10, 24, 10, 0, 0))
	if _, ok := g.nextDeparture(53, 7001, tue); ok {
		t.Errorf("a day with no trip of the line must read as unknown")
	}
}

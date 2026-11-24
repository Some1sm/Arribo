package main

import (
	"testing"
	"time"
)

func TestAmbAlertText(t *testing.T) {
	in := "A causa d&#39;unes obres, hi haur&agrave; un canvi<br/>d&rsquo;ubicaci&oacute;.&nbsp;Les l&iacute;nies"
	want := "A causa d'unes obres, hi haurà un canvi d’ubicació. Les línies"
	if got := ambAlertText(in); got != want {
		t.Errorf("got %q", got)
	}
}

func TestTripUpdateSoon(t *testing.T) {
	ts := uint64(1795546731)
	at := func(sec int64) *TripUpdate {
		v := int64(ts) + sec
		return &TripUpdate{StopTimeUpdates: []StopTimeUpdate{{StopID: "a"}, {StopID: "b", Arrival: &StopTimeEvent{Time: &v}}}}
	}
	if !tripUpdateSoon(at(10*60), ts) {
		t.Errorf("a bus due in 10 min is running")
	}
	if tripUpdateSoon(at(45*60), ts) {
		t.Errorf("a trip starting in 45 min is not shown as live")
	}
	if tripUpdateSoon(&TripUpdate{}, ts) {
		t.Errorf("no predicted time: not running")
	}
}

// Departures of a source without a positions feed count a trip as live
// when its update names a bus (TripVehicles), with the computed delay.
func TestAmbDeparturesUseTripVehicles(t *testing.T) {
	now := time.Unix(1795546731, 0)
	sched := []any{O("tripId", "T1", "departUnix", float64(now.Unix()+600), "destination", "Barcelona", "direction", "0"),
		O("tripId", "T2", "departUnix", float64(now.Unix()+900), "destination", "Barcelona", "direction", "0")}
	snap := &rtSnapshot{TripDelays: map[string]int32{"T1": 120, "T2": 60}, ComputedTrips: map[string]bool{"T1": true, "T2": true},
		TripVehicles: map[string]string{"T1": "3318"}}
	res := railDeparturesResponse(ambOperator, rtLineStop{ID: "000119", Name: "Pl Lesseps"}, sched, snap, nil, nil, now)
	deps := res.Get("departures").([]any)
	if len(deps) != 2 {
		t.Fatalf("departures: %d", len(deps))
	}
	d1, d2 := deps[0].(*Obj), deps[1].(*Obj)
	if d1.Get("isRealTime") != true || d1.Get("delayMins") != 2.0 || d1.Get("delaySource") != "timetable" {
		t.Errorf("T1 has a bus: %s", toJSON(d1))
	}
	if d2.Get("isRealTime") != false || d2.Get("delayMins") != nil {
		t.Errorf("T2 names no bus: timetable only: %s", toJSON(d2))
	}
}

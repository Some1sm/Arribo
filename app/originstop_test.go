package main

import (
	"context"
	"testing"
)

// At a trip's first stop TRAM sends the tram's arrival at its terminus,
// minutes before the scheduled departure, and the departure on time: the
// delay and the station visit there must use the departure.
func TestOriginStopUsesDeparture(t *testing.T) {
	feed := map[string]string{
		"agency.txt":     "agency_id,agency_name,agency_url,agency_timezone\nA,A,http://e.com,Europe/Madrid\n",
		"routes.txt":     "route_id,agency_id,route_short_name,route_long_name,route_type\nT4,A,T4,T4,0\n",
		"trips.txt":      "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\nT4,S,1987_0188,X,0,\n",
		"stops.txt":      "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n2034,Origin,41.4,2.2,0,\n2033,Next,41.41,2.21,0,\n",
		"stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n1987_0188,23:03:30,23:03:30,2034,1\n1987_0188,23:05:30,23:05:30,2033,2\n",
		"calendar.txt":   "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nS,1,1,1,1,1,1,1,20260101,20271231\n",
	}
	tt := openRailTestTimetableWith(t, feed)
	ctx := context.Background()
	ref, err := gtfsServiceDayRef("20261124")
	if err != nil {
		t.Fatal(err)
	}
	at := func(hms int64) *int64 { v := ref.Unix() + hms; return &v }
	tu := &TripUpdate{Trip: TripDescriptor{TripID: "1987_0188", StartDate: "20261124"}, StopTimeUpdates: []StopTimeUpdate{
		{StopID: "2034", Arrival: &StopTimeEvent{Time: at(23*3600 + 3*60 + 30 - 327)}, Departure: &StopTimeEvent{Time: at(23*3600 + 3*60 + 30)}},
		{StopID: "2033", Arrival: &StopTimeEvent{Time: at(23*3600 + 5*60 + 36)}},
	}}
	if got := tt.originStop(ctx, "1987_0188"); got != "2034" {
		t.Fatalf("originStop = %q", got)
	}
	if d := tripUpdateComputedDelay(ctx, tt, tu); d == nil || *d != 0 {
		t.Errorf("computed delay = %v, want 0 (the departure, not the layover arrival)", d)
	}
	sched, pred, ok := stuTimes(ctx, tt, tu, tu.StopTimeUpdates[0])
	if !ok || pred-sched != 0 {
		t.Errorf("origin visit delay = %d s, want 0", pred-sched)
	}
	sched, pred, ok = stuTimes(ctx, tt, tu, tu.StopTimeUpdates[1])
	if !ok || pred-sched != 6 {
		t.Errorf("second stop keeps its arrival: %d s, want 6", pred-sched)
	}
}

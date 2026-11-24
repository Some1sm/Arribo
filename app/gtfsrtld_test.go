package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func ldTestFeedBytes(ts uint64, vps ...[]byte) []byte {
	var header []byte
	header = append(header, encStringField(1, "2.0")...)
	header = append(header, encVarintField(3, ts)...)
	feed := encMsgField(1, header)
	for _, e := range vps {
		feed = append(feed, encMsgField(2, e)...)
	}
	return feed
}

// ldVP builds a vehicle entity in the LD shape: number-based trip id, label
// equal to the number, empty route, no per-vehicle timestamp.
func ldVP(number, seg, date string, lat, lon float32, label string) []byte {
	trip := encStringField(1, number+seg+date)
	pos := append(encFloatField(1, lat), encFloatField(2, lon)...)
	veh := append(encStringField(1, number), encStringField(2, label)...)
	vp := append(encMsgField(1, trip), encMsgField(2, pos)...)
	vp = append(vp, encMsgField(8, veh)...)
	return append(encStringField(1, "VP_"+number), encMsgField(4, vp)...)
}

func ldTU(number, seg, date string, delay int32) []byte {
	trip := encStringField(1, number+seg+date)
	tu := append(encMsgField(1, trip), encInt32Field(5, delay)...)
	return append(encStringField(1, "TU_"+number), encMsgField(3, tu)...)
}

func TestLDTrainNumber(t *testing.T) {
	if n := ldTrainNumber("1591612026-11-23", ""); n != "15916" {
		t.Errorf("trip id: %q", n)
	}
	if n := ldTrainNumber("", "15916"); n != "15916" {
		t.Errorf("label: %q", n)
	}
	if n := ldTrainNumber("5127M15916R11", "R11-15916"); n != "" {
		t.Errorf("commuter ids are not LD: %q", n)
	}
	got := commuterTrainNumbers([]rtVehicle{{Label: "R15-15012-PLATF.(2)", TripID: "5127M17050R15"}})
	if !got["15012"] || !got["17050"] || len(got) != 2 {
		t.Errorf("commuter numbers: %v", got)
	}
}

// TestLDMergeAndDedupe: the LD feed adds a regional that only it carries,
// matched to the Rodalies timetable by number; the commuter entity wins for a
// number in both; trains with no (or an ambiguous) Rodalies trip are dropped.
func TestLDMergeAndDedupe(t *testing.T) {
	feed := map[string]string{
		"agency.txt":     "agency_id,agency_name,agency_url,agency_timezone\nA,A,http://e.com,Europe/Madrid\n",
		"routes.txt":     "route_id,agency_id,route_short_name,route_long_name,route_type\n51_R11,A,R11,R11,2\n51_R15,A,R15,R15,2\n",
		"trips.txt":      "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\n51_R11,S,5127M15916R11,X,0,\n51_R15,S,5127M15012R15,X,0,\n51_R11,S,5127M15999R11,X,0,\n51_R15,S,5127M15999R15,X,1,\n",
		"stops.txt":      "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n79300,Girona,41.98,2.82,0,\n",
		"stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n5127M15916R11,08:00:00,08:00:00,79300,1\n5148M15916R11,08:00:00,08:00:00,79300,1\n5127M15012R15,08:00:00,08:00:00,79300,1\n5127M15999R11,08:00:00,08:00:00,79300,1\n5127M15999R15,08:00:00,08:00:00,79300,1\n",
		"calendar.txt":   "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nS,1,1,1,1,1,1,1,20260101,20271231\nOLD,1,1,1,1,1,1,1,20250101,20251231\n",
	}
	tt := openRailTestTimetableWith(t, feed)
	const d = "2026-11-23"
	vsrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(ldTestFeedBytes(1795526876,
			ldVP("15916", "1", d, 41.98, 2.82, "15916"),   // LD only, matches R11
			ldVP("15916", "2", d, 41.98, 2.82, "15916"),   // second segment: one train
			ldVP("15012", "1", d, 41.40, 2.17, "15012"),   // also in the commuter feed
			ldVP("09725", "1", d, 41.50, 0.84, "09725"),   // long distance, no Rodalies trip
			ldVP("15999", "1", d, 41.60, 2.30, "15999"),   // two Rodalies trips: ambiguous
			ldVP("15916", "1", d, 38.00, -1.10, "15916x"), // outside Catalonia: ignored
		))
	}))
	defer vsrv.Close()
	tsrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(ldTestFeedBytes(1795530476, ldTU("15916", "1", d, 240), ldTU("15012", "1", d, 60)))
	}))
	defer tsrv.Close()

	p := &rtPoller{src: rtSource{AgencyID: "renfe_rodalies", Mode: "rail", ldVehicleURL: vsrv.URL, ldTripURL: tsrv.URL, bounds: &cataloniaBounds}, tt: tt}
	ctx := context.Background()
	p.pollLDTrips(ctx)
	snap := &rtSnapshot{Vehicles: []rtVehicle{{Label: "R15-15012", TripID: "5127M15012R15", LineCode: "R15"}}}
	p.appendLDVehicles(ctx, snap)

	if len(snap.Vehicles) != 2 || snap.LDVehicles != 1 || snap.LDDropped != 2 {
		t.Fatalf("vehicles %d, added %d, dropped %d: %+v", len(snap.Vehicles), snap.LDVehicles, snap.LDDropped, snap.Vehicles)
	}
	if c := snap.Vehicles[0]; c.Feed != "" || c.Label != "R15-15012" {
		t.Errorf("commuter entity must be kept untouched: %+v", c)
	}
	v := snap.Vehicles[1]
	if v.Feed != "ld" || v.TripID != "5127M15916R11" || v.LineCode != "R11" || v.DelaySec == nil || *v.DelaySec != 240 || v.FeedTS != 1795526876 || v.ObservedAt != 0 {
		t.Errorf("LD train: %+v", v)
	}
	// Its position time is the LD feed's header, labelled as the feed's.
	o := trainJSON(reportOperators[0], snap, &v, time.Unix(1795526876+30, 0))
	if o.Get("feedVariant") != "ld" || o.Get("positionTimeSource") != "feed" || o.Get("isEstimated") != false {
		t.Errorf("trainJSON: %s", toJSON(o))
	}
	if c := trainJSON(reportOperators[0], snap, &snap.Vehicles[0], time.Unix(1795526900, 0)); c.Has("feedVariant") {
		t.Errorf("commuter train must not carry feedVariant")
	}
}

func TestLDFeedErrorKeepsCommuterVehicles(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "no", 503) }))
	defer srv.Close()
	p := &rtPoller{src: rtSource{AgencyID: "renfe_rodalies", ldVehicleURL: srv.URL, ldTripURL: srv.URL}, tt: openRailTestTimetable(t)}
	snap := &rtSnapshot{Vehicles: []rtVehicle{{Label: "R1-25750"}}}
	p.pollLDTrips(context.Background())
	p.appendLDVehicles(context.Background(), snap)
	if len(snap.Vehicles) != 1 || snap.LDErr != "HTTP 503" || snap.LDTripsErr != "HTTP 503" {
		t.Errorf("%+v", snap)
	}
}

// A lookup that fails (here: a cancelled context) must not be remembered:
// neither the train-number table nor the per-date answer.
func TestLDTripForNumberRetriesAfterFailure(t *testing.T) {
	feed := map[string]string{
		"agency.txt":     "agency_id,agency_name,agency_url,agency_timezone\nA,A,http://e.com,Europe/Madrid\n",
		"routes.txt":     "route_id,agency_id,route_short_name,route_long_name,route_type\n51_R11,A,R11,R11,2\n",
		"trips.txt":      "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\n51_R11,S,5127M15916R11,X,0,\n",
		"stops.txt":      "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n79300,Girona,41.98,2.82,0,\n",
		"stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n5127M15916R11,08:00:00,08:00:00,79300,1\n",
		"calendar.txt":   "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nS,1,1,1,1,1,1,1,20260101,20271231\n",
	}
	tt := openRailTestTimetableWith(t, feed)
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if got := tt.tripForNumber(cancelled, "15916", "20261123"); got != "" {
		t.Fatalf("cancelled lookup = %q, want \"\"", got)
	}
	if got := tt.tripForNumber(context.Background(), "15916", "20261123"); got != "5127M15916R11" {
		t.Fatalf("lookup after a failure = %q, want 5127M15916R11", got)
	}
}

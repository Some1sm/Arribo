package main

import (
	"context"
	"testing"
)

func TestBuildRailAlerts(t *testing.T) {
	tt := openRailTestTimetable(t) // route RL6 = line L6; stops A Sarrià, B Gràcia, C Pl. Catalunya
	ctx := context.Background()
	tr := func(pairs ...string) TranslatedString {
		var s TranslatedString
		for i := 0; i+1 < len(pairs); i += 2 {
			s = append(s, Translation{Language: pairs[i], Text: pairs[i+1]})
		}
		return s
	}
	fm := &FeedMessage{Entities: []Entity{
		{ID: "route", Alert: &Alert{HeaderText: tr("es", "Obras", "ca", "Obres"), InformedEntities: []EntitySelector{{RouteID: "RL6"}}}},
		{ID: "trip", Alert: &Alert{DescriptionText: tr("es", "Retraso"), InformedEntities: []EntitySelector{{Trip: &TripDescriptor{TripID: "long"}}}}},
		{ID: "station", Alert: &Alert{HeaderText: tr("ca", "Ascensor fora de servei"), InformedEntities: []EntitySelector{{StopID: "B"}}}},
		{ID: "elsewhere", Alert: &Alert{HeaderText: tr("es", "Sevilla"), InformedEntities: []EntitySelector{{StopID: "51051"}, {RouteID: "60T0020C5"}}}},
		{ID: "empty", Alert: &Alert{InformedEntities: []EntitySelector{{RouteID: "RL6"}}}},
	}}
	got := buildRailAlerts(ctx, "fgc", tt, fm)
	if len(got) != 3 {
		t.Fatalf("kept %d: %+v", len(got), got)
	}
	byID := map[string]railAlert{}
	for _, a := range got {
		byID[a.ID] = a
	}
	if a := byID["route"]; a.Header != "Obres" || a.Lang != "ca" || len(a.Lines) != 1 || a.Lines[0] != "L6" {
		t.Errorf("route alert: %+v", a)
	}
	if a := byID["trip"]; a.Description != "Retraso" || len(a.Lines) != 1 || a.Lines[0] != "L6" {
		t.Errorf("trip alert: %+v", a)
	}
	if a := byID["station"]; len(a.Lines) != 0 || len(a.Stops) != 1 || a.Stops[0].Name != "Gràcia" {
		t.Errorf("station alert: %+v", a)
	}
	if buildRailAlerts(ctx, "fgc", nil, fm) != nil {
		t.Error("no timetable: nothing can be checked, nothing kept")
	}
}

func TestRailAlertActive(t *testing.T) {
	a := &railAlert{}
	if !railAlertActive(a, 100) {
		t.Error("no period = always")
	}
	a.Periods = []TimeRange{{Start: 50, End: 150}}
	if !railAlertActive(a, 100) || railAlertActive(a, 150) || railAlertActive(a, 40) {
		t.Error("bounded period")
	}
	a.Periods = []TimeRange{{Start: 50}}
	if !railAlertActive(a, 1e9) {
		t.Error("open end")
	}
}

// TestRailAlertsDuplicateIDs: one id tagged once with its line and once with
// the whole network is kept once, with the specific tagging.
func TestRailAlertsDuplicateIDs(t *testing.T) {
	feed := railTestFeed()
	feed["routes.txt"] += "RS1,FGC,S1,Terrassa - Pl. Catalunya,2,F4802E,FFFFFF\n"
	tt := openRailTestTimetableWith(t, feed)
	h := TranslatedString{{Language: "es", Text: "Obras en L6"}}
	fm := &FeedMessage{Entities: []Entity{
		{ID: "dup", Alert: &Alert{HeaderText: h, InformedEntities: []EntitySelector{{RouteID: "RL6"}}}},
		{ID: "dup", Alert: &Alert{HeaderText: h, InformedEntities: []EntitySelector{{RouteID: "RL6"}, {RouteID: "RS1"}}}},
	}}
	got := buildRailAlerts(context.Background(), "fgc", tt, fm)
	if len(got) != 1 || len(got[0].Lines) != 1 || got[0].Lines[0] != "L6" {
		t.Fatalf("got %+v", got)
	}
}

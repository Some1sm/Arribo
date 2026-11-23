package main

import (
	"path/filepath"
	"testing"
	"time"
)

// TestUsualPlatforms: a usual platform is named only with enough
// announcements and a clear majority, per direction; stale ones do not count.
func TestUsualPlatforms(t *testing.T) {
	t.Setenv("DB_PATH", filepath.Join(t.TempDir(), "h.db"))
	h := newHistoryDB()
	if !h.init() {
		t.Fatal("init")
	}
	defer h.close()
	now := nowMs() / 1000
	rec := func(dir int, platform string, n int, seen int64) {
		for i := 0; i < n; i++ {
			h.recordRailPlatform(railPlatformSighting{AgencyID: "renfe_rodalies", StopID: "79500", Line: "R1", Platform: platform, Dir: dir, Seen: seen})
		}
	}
	rec(0, "1", 6, now) // direction 0: 6 of 7 on platform 1
	rec(0, "2", 1, now)
	rec(1, "2", 3, now) // direction 1: 3 vs 3, no clear majority
	rec(1, "3", 3, now)
	rec(-1, "4", 4, now) // unknown direction: too few
	h.recordRailPlatform(railPlatformSighting{AgencyID: "renfe_rodalies", StopID: "79501", Line: "R1", Platform: "5", Dir: 0, Seen: now - 40*86400})

	got := h.usualPlatforms("renfe_rodalies", "79500", "R1")
	if len(got) != 1 || got["0"] != "1" {
		t.Errorf("usual: %v", got)
	}
	for i := 0; i < 9; i++ { // old station row refreshed only by stale sightings
		h.recordRailPlatform(railPlatformSighting{AgencyID: "renfe_rodalies", StopID: "79501", Line: "R1", Platform: "5", Dir: 0, Seen: now - 40*86400})
	}
	if got := h.usualPlatforms("renfe_rodalies", "79501", "R1"); len(got) != 0 {
		t.Errorf("stale counted: %v", got)
	}
}

// TestNotePlatformsOncePerTrip: a train keeps its platform label for several
// polls; it counts once per trip and station.
func TestNotePlatformsOncePerTrip(t *testing.T) {
	p := &rtPoller{src: rtSource{AgencyID: "renfe_rodalies"}}
	v := []rtVehicle{{TripID: "t1", StopID: "79500", LineCode: "R1", DirectionID: 0, Label: "R1-25547-PLATF.(2)"}}
	now := time.Unix(1_800_000_000, 0)
	p.notePlatforms(v, now)
	p.notePlatforms(v, now.Add(20*time.Second))
	v[0].StopID = "79501" // next station
	p.notePlatforms(v, now.Add(60*time.Second))
	got := p.takeRailPlatforms()
	if len(got) != 2 || got[0].Platform != "2" || got[1].StopID != "79501" {
		t.Errorf("sightings: %+v", got)
	}
	if len(p.takeRailPlatforms()) != 0 {
		t.Error("queue not emptied")
	}
}

// TestRailDeparturesUsualPlatform: the usual platform fills in only where
// neither the timetable nor a live announcement names one, and is labelled.
func TestRailDeparturesUsualPlatform(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	sched := []any{
		O("tripId", "t1", "headsign", "X", "directionId", 0.0, "departUnix", float64(now.Unix()+300), "stopId", "79500", "platform", ""),
		O("tripId", "t2", "headsign", "Y", "directionId", 1.0, "departUnix", float64(now.Unix()+600), "stopId", "79500", "platform", ""),
		O("tripId", "t3", "headsign", "X", "directionId", 0.0, "departUnix", float64(now.Unix()+900), "stopId", "79500", "platform", ""),
	}
	snap := &rtSnapshot{Vehicles: []rtVehicle{{TripID: "t3", StopID: "79500", Label: "R1-1-PLATF.(4)"}}}
	usual := O("0", "1")
	deps := railDeparturesResponse(reportOperators[0], rtLineStop{ID: "79500", Name: "Mataró"}, sched, snap, nil, usual, now).Get("departures").([]any)
	if d := deps[0].(*Obj); d.Get("platform") != "1" || d.Get("platformSource") != "usual" || d.Get("platformChanged") != false {
		t.Errorf("usual: %s", toJSON(d))
	}
	if d := deps[1].(*Obj); d.Get("platform") != nil {
		t.Errorf("other direction got a platform: %s", toJSON(d))
	}
	if d := deps[2].(*Obj); d.Get("platform") != "4" || d.Get("platformSource") != "live" {
		t.Errorf("announced must win: %s", toJSON(d))
	}
}

package main

import (
	"path/filepath"
	"testing"
)

// TestRailGapsDetected: a Rodalies train missing for longer than the
// operator's staleness bound is a loss; the same pause on FGC (whose bound
// is longer) is not; another train reporting meanwhile makes it not
// feed-wide.
func TestRailGapsDetected(t *testing.T) {
	base := int64(1_800_000_000)
	train := func(trip string, at int64, lat float64) rtVehicle {
		return rtVehicle{TripID: trip, LineCode: "R1", StopName: "Mataró", Lat: lat, Lon: 2.4, ObservedAt: at, DirectionID: 0}
	}
	renfe := &rtPoller{src: rtSource{AgencyID: "renfe_rodalies"}}
	renfe.noteGaps(&rtSnapshot{Vehicles: []rtVehicle{train("t77001", base, 41.50), train("t77002", base, 41.30)}})
	renfe.noteGaps(&rtSnapshot{Vehicles: []rtVehicle{train("t77002", base+100, 41.31)}}) // t77001 missing
	renfe.noteGaps(&rtSnapshot{Vehicles: []rtVehicle{train("t77001", base+200, 41.52), train("t77002", base+200, 41.32)}})
	gaps := renfe.takeRailGaps()
	if len(gaps) != 1 {
		t.Fatalf("gaps: %d", len(gaps))
	}
	g := gaps[0]
	if g.Get("vehicleId") != "t77001" || g.Get("gapSec") != 200.0 || g.Get("agencyId") != "renfe_rodalies" || g.Get("mode") != "rail" || g.Get("feedWide") != false {
		t.Errorf("gap: %s", toJSON(g))
	}

	fgc := &rtPoller{src: rtSource{AgencyID: "fgc"}}
	fgc.noteGaps(&rtSnapshot{Vehicles: []rtVehicle{train("f1", base, 41.40)}})
	fgc.noteGaps(&rtSnapshot{Vehicles: []rtVehicle{train("f1", base+200, 41.41)}})
	if n := len(fgc.takeRailGaps()); n != 0 {
		t.Errorf("FGC 200 s pause recorded as a loss (%d)", n)
	}
	fgc.noteGaps(&rtSnapshot{Vehicles: []rtVehicle{train("f1", base+600, 41.42)}})
	if g := fgc.takeRailGaps(); len(g) != 1 || g[0].Get("feedWide") != true {
		t.Errorf("FGC 400 s loss, alone on the feed: %s", toJSON(g))
	}
}

// TestGapReadersPerOperator: the gap views read one operator: Mataró's
// buses by default, a train operator when asked; a shared line code (L6)
// does not mix them.
func TestGapReadersPerOperator(t *testing.T) {
	t.Setenv("DB_PATH", filepath.Join(t.TempDir(), "h.db"))
	h := newHistoryDB()
	if !h.init() {
		t.Fatal("init")
	}
	defer h.close()
	now := float64(nowMs())
	gap := func(agency, mode, vehicle string, lat float64) {
		h.recordGpsGap(O("vehicleId", vehicle, "lineCode", "L6", "lostTs", now-3600000, "regainedTs", now-3500000, "gapSec", 100.0,
			"lostLat", lat, "lostLon", 2.44, "regainedLat", lat+0.001, "regainedLon", 2.44, "stopName", "X", "agencyId", agency, "mode", mode))
	}
	gap("mataro", "bus", "1234", 41.54)
	gap("fgc", "rail", "trip9", 41.40)
	count := func(o *Obj) float64 {
		gs, _ := o.Get("gaps").([]any)
		return float64(len(gs))
	}
	bus := h.getGpsGapHotspots(gapOpts{days: 7.0, lineCode: "L6", now: now})
	rail := h.getGpsGapHotspots(gapOpts{days: 7.0, lineCode: "L6", now: now, agency: "fgc"})
	if count(bus) != 1 || count(rail) != 1 {
		t.Fatalf("bus %v, fgc %v: %s / %s", count(bus), count(rail), toJSON(bus.Get("gaps")), toJSON(rail.Get("gaps")))
	}
	if field(bus.Get("gaps").([]any)[0], "vehicleId") != "1234" || field(rail.Get("gaps").([]any)[0], "vehicleId") != "trip9" {
		t.Errorf("mixed: %s / %s", toJSON(bus.Get("gaps")), toJSON(rail.Get("gaps")))
	}
}

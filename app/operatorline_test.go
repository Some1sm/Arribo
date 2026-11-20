package main

import (
	"path/filepath"
	"testing"
)

func TestOperatorLineReport(t *testing.T) {
	t.Setenv("DB_PATH", filepath.Join(t.TempDir(), "h.db"))
	h := newHistoryDB()
	if !h.init() {
		t.Fatal("init")
	}
	defer h.close()
	now := float64(nowMs())
	visit := func(agency, line, stop string, delay float64, ago int) {
		ts := now - float64(ago)*60000
		h.recordStopVisit(O("vehicleId", "trip-"+stop+numToString(float64(ago)), "lineCode", line, "stopName", stop, "firstTs", ts, "lastTs", ts,
			"delayMins", delay, "sampleCount", 1.0, "isRealTime", true, "agencyId", agency, "mode", "rail"))
	}
	visit("fgc", "L6", "Gràcia", 2, 10)
	visit("fgc", "L6", "Gràcia", 8, 20)
	visit("fgc", "L6", "Sarrià", 0, 30)
	visit("fgc", "S1", "Terrassa", 30, 10)         // another line
	visit("mataro", "L6", "Pl. Santa Anna", 1, 10) // Mataró's L6, same code
	r, err := h.getOperatorLineReport("fgc", "L6", 24)
	if err != nil {
		t.Fatal(err)
	}
	if r.Get("visits") != 3.0 {
		t.Fatalf("visits: %s", string(toJSON(r)))
	}
	st := r.Get("stations").([]any)
	if len(st) != 2 {
		t.Fatalf("stations: %s", string(toJSON(st)))
	}
	var gracia *Obj
	for _, x := range st {
		if o := x.(*Obj); o.Get("station") == "Gràcia" {
			gracia = o
		}
	}
	if gracia == nil || gracia.Get("avgDelay") != 5.0 || gracia.Get("onTimePct") != 50.0 || gracia.Get("maxDelay") != 8.0 {
		t.Errorf("Gràcia: %s", string(toJSON(gracia)))
	}
	if n := len(r.Get("byHour").([]any)); n < 1 {
		t.Errorf("byHour empty")
	}
	if _, err := h.getOperatorLineReport("nope", "L6", 24); err == nil {
		t.Errorf("unknown operator should fail")
	}
}

func TestOrderStationsAlongLine(t *testing.T) {
	prof := &rtLineProfile{Code: "L6", Directions: []rtLineDirection{
		{Stops: []rtLineStop{{Name: "Sarrià"}, {Name: "Gràcia"}, {Name: "Pl. Catalunya"}}},
		{Stops: []rtLineStop{{Name: "Pl. Catalunya"}, {Name: "Provença"}}},
	}}
	st := []any{
		O("station", "Pl. Catalunya", "avgDelay", 1.0),
		O("station", "Extra B", "avgDelay", 2.0),
		O("station", "Sarrià", "avgDelay", 3.0),
		O("station", "Extra A", "avgDelay", 9.0),
		O("station", "Provença", "avgDelay", 0.0),
		O("station", "gràcia", "avgDelay", 4.0),
	}
	orderStationsAlongLine(st, prof)
	want := []string{"Sarrià", "gràcia", "Pl. Catalunya", "Provença", "Extra A", "Extra B"}
	for i, w := range want {
		o := st[i].(*Obj)
		if o.Get("station") != w {
			t.Fatalf("order at %d: got %v, want %v (%s)", i, o.Get("station"), w, string(toJSON(st)))
		}
		if onp := o.Get("onProfile"); onp != (i < 4) {
			t.Errorf("%s onProfile = %v", w, onp)
		}
	}
}

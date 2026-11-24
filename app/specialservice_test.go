package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type snapshotCounter struct{ lines []string }

func (s *snapshotCounter) recordVehicleSnapshot(o *Obj) { s.lines = append(s.lines, o.Str("lineCode")) }

// specialTestWorld is a world with only the SIRI client and flight recorder,
// answering from the line-10 fixture, with its lock held as a task would.
func specialTestWorld(t *testing.T) (*World, *IngestionDaemon, *snapshotCounter) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "siri_vehicles_special_service.xml"))
	if err != nil {
		t.Fatal(err)
	}
	w := &World{name: "test"}
	w.siri = newSiriClient(w)
	w.fr = newFlightRecorder(w)
	var asked []string
	w.siri.soap = func(action, body string) (int, string, error) {
		asked = append(asked, body)
		return 200, strings.ReplaceAll(string(raw), "{{NOW}}", isoString(nowMs())), nil
	}
	db := &snapshotCounter{}
	w.fr.enablePersistence(db)
	w.mu.Lock()
	t.Cleanup(w.mu.Unlock)
	return w, newIngestionDaemon(w, nil, nil), db
}

func TestSpecialServiceLineCode(t *testing.T) {
	for in, want := range map[string]string{
		"10": "L10", "11": "L11", "12": "L12", " 10 ": "L10", "L10": "L10",
		"": "", "1": "", "8": "", "L3": "", "mataro_5": "", "9": "L9",
		"abc": "", "1234": "", "10;drop": "",
	} {
		if got := specialServiceLineCode(in); got != want {
			t.Errorf("specialServiceLineCode(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSiriKeepsUnknownLineVehicles(t *testing.T) {
	w, _, _ := specialTestWorld(t)
	list, err := w.siri.getLiveVehicles("")
	if err != nil || list == nil {
		t.Fatalf("getLiveVehicles: %v", err)
	}
	var lines []string
	for _, x := range *list {
		lines = append(lines, x.(*Obj).Str("lineId"))
	}
	if strings.Join(lines, ",") != "3,10,12," {
		t.Fatalf("parsed lines %q: the parser must keep a line 10 vehicle", lines)
	}
}

func TestSpecialServiceVehiclesAreExposedWithoutTimetableData(t *testing.T) {
	w, d, db := specialTestWorld(t)
	d.pollSpecialServiceVehicles()

	all := w.fr.getAllVehicles()
	if len(all) != 2 {
		t.Fatalf("fleet has %d vehicles, want the two special ones (line 3 and the LineRef-less bus stay out)", len(all))
	}
	byID := map[string]*Obj{}
	for _, x := range all {
		byID[x.(*Obj).Str("vehicleId")] = x.(*Obj)
	}
	v := byID["2210"]
	if v == nil || byID["2211"] == nil {
		t.Fatalf("fleet: %v", byID)
	}
	if !v.Bool("isSpecialService") || v.Str("lineCode") != "L10" || v.Str("lineId") != "10" {
		t.Errorf("flags: %s", jsonText(v))
	}
	if v.Bool("hasDelay") || v.Num("delayMins") != 0 {
		t.Errorf("a special service must carry no delay (SIRI said +7): %s", jsonText(v))
	}
	if v.Bool("isEstimated") || !v.Bool("isRealTime") || !v.Bool("hasSpeed") || v.Num("speedKmh") != 22 {
		t.Errorf("telemetry: %s", jsonText(v))
	}
	if v.Num("lat") != 41.5385 || v.Num("lon") != 2.4412 {
		t.Errorf("position: %v %v", v.Get("lat"), v.Get("lon"))
	}
	if byID["2211"].Bool("hasSpeed") {
		t.Errorf("a bus with no <Velocity> must not get a speed")
	}
	if got := w.fr.getLineVehicles("L10"); len(got) != 1 {
		t.Errorf("line index: %d", len(got))
	}
	if len(db.lines) != 0 {
		t.Errorf("special services must not reach vehicle_snapshots, got %v", db.lines)
	}

	// The punctuality side never sees them.
	if got := float64(d.regularFleetCount()); got != 0 {
		t.Errorf("liveCount counts special services: %v", got)
	}

	// A regular bus does persist, so the recorder double above does work.
	w.fr.ingestVehicle(O("vehicleId", "101", "lineId", "3", "lineCode", "L3", "lat", 41.54, "lon", 2.445))
	if len(db.lines) != 1 || db.lines[0] != "L3" {
		t.Errorf("regular snapshot: %v", db.lines)
	}
	if got := float64(d.regularFleetCount()); got != 1 {
		t.Errorf("liveCount with one regular bus: %v", got)
	}
}

func TestSpecialServiceHTTPFieldIsAdditive(t *testing.T) {
	w, d, _ := specialTestWorld(t)
	d.pollSpecialServiceVehicles()
	w.fr.ingestVehicle(O("vehicleId", "101", "lineId", "3", "lineCode", "L3", "lat", 41.54, "lon", 2.445))
	var regular, special *Obj
	for _, x := range w.fr.getAllVehicles() {
		switch x.(*Obj).Str("vehicleId") {
		case "101":
			regular = x.(*Obj)
		case "2210":
			special = x.(*Obj)
		}
	}
	if regular.Has("isSpecialService") {
		t.Errorf("a regular vehicle gained a key: %s", jsonText(regular))
	}
	if !special.Bool("isSpecialService") {
		t.Errorf("special vehicle lost its flag")
	}
	std := standardizeVehicle(special)
	if !std.Bool("isSpecialService") || std.Str("lineCode") != "L10" {
		t.Errorf("standardizeVehicle dropped the flag: %s", jsonText(std))
	}
}

func TestBusChangingBetweenRegularAndSpecialService(t *testing.T) {
	w, d, db := specialTestWorld(t)
	w.fr.ingestVehicle(O("vehicleId", "2210", "lineId", "3", "lineCode", "L3", "lat", 41.54, "lon", 2.445))
	d.pollSpecialServiceVehicles() // bus 2210 is now on line 10
	v, _ := w.fr.vehicles.Get("2210")
	if !v.(*Obj).Bool("isSpecialService") || v.(*Obj).Str("lineCode") != "L10" || v.(*Obj).Str("lineId") != "10" {
		t.Fatalf("not switched: %s", jsonText(v.(*Obj)))
	}
	if len(w.fr.getLineVehicles("L3")) != 0 {
		t.Errorf("still indexed under L3")
	}
	w.fr.ingestVehicle(O("vehicleId", "2210", "lineId", "5", "lineCode", "L5", "lat", 41.54, "lon", 2.445))
	if v.(*Obj).Bool("isSpecialService") || v.(*Obj).Str("lineId") != "5" {
		t.Errorf("flag not cleared: %s", jsonText(v.(*Obj)))
	}
	if len(db.lines) != 1 {
		t.Errorf("snapshots: %v", db.lines)
	}
}

func jsonText(v *Obj) string { return string(toJSON(v)) }

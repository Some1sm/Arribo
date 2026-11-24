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
		// Lines are asked by name (an empty LineRef gets no vehicles from
		// Avanza). The fixture answers line 10 (and an all-lines request, for
		// the parser test); lines 11 and 12 get Avanza's empty answer, as
		// recorded on 2026-11-24.
		if strings.Contains(body, "<siri:LineRef>11<") || strings.Contains(body, "<siri:LineRef>12<") {
			return 200, siriEmptyAnswer, nil
		}
		return 200, strings.ReplaceAll(string(raw), "{{NOW}}", isoString(nowMs())), nil
	}
	db := &snapshotCounter{}
	w.fr.enablePersistence(db)
	w.mu.Lock()
	t.Cleanup(w.mu.Unlock)
	return w, newIngestionDaemon(w, nil, nil), db
}

// siriEmptyAnswer is Avanza's answer for a line with no vehicles running.
const siriEmptyAnswer = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soap:Body><GetVehicleMonitoringResponse xmlns="http://tempuri.org/"><GetVehicleMonitoringResult><ServiceDeliveryInfo xmlns=""><ResponseTimestamp xmlns="http://www.siri.org.uk/siri">2026-11-24T15:24:24.938524+01:00</ResponseTimestamp></ServiceDeliveryInfo><Answer xmlns="" /></GetVehicleMonitoringResult></GetVehicleMonitoringResponse></soap:Body></soap:Envelope>`

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
	specialLastProbe, specialLastSeen = 0, 0
	t.Cleanup(func() { specialLastProbe, specialLastSeen = 0, 0 })
	d.pollSpecialServiceVehicles()

	// The line-10 answer holds buses 2210 (line 10), 2211 (line 12), 999 (no
	// LineRef: in an answer for line 10 it is a line-10 bus) and a line-3 bus,
	// which stays out.
	all := w.fr.getAllVehicles()
	if len(all) != 3 {
		t.Fatalf("fleet has %d vehicles, want the three special ones (the line 3 bus stays out)", len(all))
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
	if byID["999"] == nil || byID["999"].Str("lineCode") != "L10" {
		t.Errorf("the LineRef-less bus in the line-10 answer: %v", byID["999"])
	}
	if got := w.fr.getLineVehicles("L10"); len(got) != 2 {
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

// TestSpecialPollDue: special lines are asked every 5 minutes while none
// runs, and on every cycle for 30 minutes after a special bus was seen.
func TestSpecialPollDue(t *testing.T) {
	const min = 60 * 1000.0
	now := 1_000_000_000.0
	cases := []struct {
		name            string
		lastProbe, seen float64
		want            bool
	}{
		{"never asked", 0, 0, true},
		{"asked 1 min ago, none seen", now - 1*min, 0, false},
		{"asked 5 min ago, none seen", now - 5*min, 0, true},
		{"asked 20 s ago, bus seen 10 min ago", now - min/3, now - 10*min, true},
		{"asked 1 min ago, bus last seen 31 min ago", now - 1*min, now - 31*min, false},
	}
	for _, c := range cases {
		if got := specialPollDue(now, c.lastProbe, c.seen); got != c.want {
			t.Errorf("%s: specialPollDue = %v, want %v", c.name, got, c.want)
		}
	}
}

// TestSpecialServiceLineRefs: the default is 10, 11, 12; the variable
// overrides it, drops regular lines and junk, and "off" or "" turns it off.
func TestSpecialServiceLineRefs(t *testing.T) {
	cases := []struct {
		env  string
		set  bool
		want string
	}{
		{"", false, "10,11,12"},
		{"14, 3 ,x9,15", true, "14,15"},
		{"off", true, ""},
		{"", true, ""},
	}
	for _, c := range cases {
		if c.set {
			t.Setenv("ARRIBO_SPECIAL_LINES", c.env)
		} else {
			os.Unsetenv("ARRIBO_SPECIAL_LINES")
		}
		if got := strings.Join(specialServiceLineRefs(), ","); got != c.want {
			t.Errorf("env %q (set %v): %q, want %q", c.env, c.set, got, c.want)
		}
	}
}

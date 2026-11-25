package main

import (
	"os"
	"testing"
	"time"
)

func TestParseMovDuration(t *testing.T) {
	cases := []struct {
		in   string
		want float64
		ok   bool
	}{
		{"19 min 54 s", 19*60 + 54, true},
		{"01 h 00 min 54 s", 3654, true},
		{"45 s", 45, true},
		{"Imminent", 0, true},
		{"< 1 min", 0, true},
		{"", 0, false},
		{"A", 0, false},
	}
	for _, tc := range cases {
		got, ok := parseMovDuration(tc.in)
		if ok != tc.ok || got != tc.want {
			t.Errorf("parseMovDuration(%q) = (%v, %v), want (%v, %v)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

func TestParseLleidaStopTimes(t *testing.T) {
	body := []byte(`[
		{"idLinea":129,"desc_linea":"1 - INTERIOR","trayectos":{"ESTACIO":[{"minutos":"5 min 30 s","real":"S"}]}},
		{"idLinea":132,"desc_linea":"4 - PARDINYES","trayectos":{"MARIOLA":[{"minutos":"12 min 00 s","real":"N"},{"minutos":"01 h 00 min 10 s","real":"S"}]}}
	]`)
	arr, err := parseLleidaStopTimes(body)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(arr) != 3 {
		t.Fatalf("got %d arrivals, want 3", len(arr))
	}
	if arr[0].LineCode != "1" || !arr[0].RealTime || arr[0].EtaSec != 330 {
		t.Errorf("arr[0] = %+v", arr[0])
	}

	throttled := []byte(`[{"idLinea":"A","trayectos":{"A":[{"minutos":"A","real":"A"}]}}]`)
	if _, err := parseLleidaStopTimes(throttled); err != errMovThrottled {
		t.Errorf("throttled err = %v, want errMovThrottled", err)
	}
}

func TestLleidaEstimateAndHubPick(t *testing.T) {
	op := &rtCatalogOp{
		AgencyID: movLleidaAgencyID,
		Mode:     "bus",
		Lines: []rtRoute{
			{Code: "1", Name: "Interior", Color: "#007a5a"},
			{Code: "4", Name: "Pardinyes", Color: "#0055aa"},
		},
		Profiles: map[string]*rtLineProfile{
			"1": {
				Code: "1",
				Directions: []rtLineDirection{{
					DirectionID: 0,
					Headsign:    "Estació",
					Stops: []rtLineStop{
						{ID: "10001", Name: "Start", Lat: 41.610, Lon: 0.620},
						{ID: "10380", Name: "Universitat", Lat: 41.615, Lon: 0.623},
						{ID: "10002", Name: "End", Lat: 41.620, Lon: 0.626},
					},
				}},
			},
			"4": {
				Code: "4",
				Directions: []rtLineDirection{{
					DirectionID: 0,
					Headsign:    "Mariola",
					Stops: []rtLineStop{
						{ID: "10003", Name: "Start4", Lat: 41.611, Lon: 0.619},
						{ID: "10380", Name: "Universitat", Lat: 41.615, Lon: 0.623},
						{ID: "10004", Name: "End4", Lat: 41.621, Lon: 0.627},
					},
				}},
			},
		},
	}
	hubs := lleidaPickHubStops(op)
	if len(hubs) != 1 || hubs[0].stopID != "10380" {
		t.Fatalf("expected single shared hub 10380, got %+v", hubs)
	}
	now := time.Now()
	obs := map[string]lleidaHubObs{
		"10380": {
			stopID: "10380",
			at:     now.Add(-30 * time.Second),
			arrivals: []lleidaArrival{
				{LineCode: "1", Headsign: "Estació", EtaSec: 180, RealTime: true},
				{LineCode: "1", Headsign: "Estació", EtaSec: 900, RealTime: false}, // timetable ignored
			},
		},
	}
	buses := lleidaEstimateLineBuses(op.Lines[0], op.Profiles["1"], "both", obs, now)
	if len(buses) != 1 {
		t.Fatalf("expected 1 estimated Lleida bus, got %d", len(buses))
	}
	if buses[0].Str("agencyId") != movLleidaAgencyID || buses[0].Str("lineRef") != "moventis_lleida:1" {
		t.Errorf("unexpected bus metadata: agencyId=%q lineRef=%q", buses[0].Str("agencyId"), buses[0].Str("lineRef"))
	}
	if buses[0].Get("isEstimated") != true || buses[0].Get("isRealTime") != false {
		t.Errorf("expected isEstimated=true isRealTime=false")
	}
}

func TestEmtTarragonaSourceGate(t *testing.T) {
	origFlag := os.Getenv("ARRIBO_TARRAGONA")
	origKey := os.Getenv("NAP_API_KEY")
	defer func() {
		_ = os.Setenv("ARRIBO_TARRAGONA", origFlag)
		_ = os.Setenv("NAP_API_KEY", origKey)
	}()
	_ = os.Setenv("ARRIBO_TARRAGONA", "0")
	_ = os.Setenv("NAP_API_KEY", "testkey")
	if _, ok := emtTarragonaSource(); ok {
		t.Fatal("expected emtTarragonaSource disabled when ARRIBO_TARRAGONA=0")
	}
	_ = os.Setenv("ARRIBO_TARRAGONA", "1")
	src, ok := emtTarragonaSource()
	if !ok || src.AgencyID != emtTarragonaAgencyID || !src.noHistory {
		t.Fatalf("unexpected emtTarragonaSource: ok=%v src=%+v", ok, src)
	}
}

func TestBuildRailRoutesJSON(t *testing.T) {
	op := &rtCatalogOp{
		AgencyID: movLleidaAgencyID,
		Mode:     "bus",
		Lines:    []rtRoute{{Code: "1", Name: "Interior", Color: "#007a5a"}},
		Profiles: map[string]*rtLineProfile{
			"1": {
				Code: "1",
				Directions: []rtLineDirection{{
					DirectionID: 0,
					Geometry:    [][2]float64{{41.61, 0.62}, {41.62, 0.63}},
				}},
			},
		},
	}
	raw := string(buildRailRoutesJSON([]operatorInfo{movLleidaOperator}, []*rtCatalogOp{op}))
	if len(raw) < 40 || raw == "{}" {
		t.Fatalf("buildRailRoutesJSON returned empty/invalid payload: %s", raw)
	}
	if !containsAll(raw, `"success":true`, `"lines":[`, `"lineRef":"moventis_lleida:1"`, `"path":[[41.61,0.62],[41.62,0.63]]`) {
		t.Fatalf("unexpected rail-routes JSON: %s", raw)
	}
	// Verify gzipBytes produces valid compressed output for large payloads.
	big := make([]byte, 4096)
	for i := range big {
		big[i] = byte('a' + (i % 26))
	}
	gz := gzipBytes(big)
	if len(gz) == 0 || len(gz) >= len(big) {
		t.Fatalf("expected compressed gzipBytes < %d, got %d", len(big), len(gz))
	}
}

func containsAll(s string, subs ...string) bool {
	for _, sub := range subs {
		found := false
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

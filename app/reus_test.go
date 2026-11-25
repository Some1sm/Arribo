package main

import (
	"os"
	"testing"
	"time"
)

func TestParseReusETA(t *testing.T) {
	cases := []struct {
		body string
		mins int
		live bool
	}{
		{`{"timetoarrival": 5}`, 5, true},
		{`{"timetoarrival": "12"}`, 12, true},
		{`{"timetoarrival": "Imminent"}`, 0, true},
		{`{"timetoarrival": "CONSULTEU HORARI"}`, 0, false},
		{`{"timetoarrival": null}`, 0, false},
		{`not json`, 0, false},
	}
	for _, tc := range cases {
		m, live := parseReusETA([]byte(tc.body))
		if live != tc.live || m != tc.mins {
			t.Errorf("parseReusETA(%s) = (%d, %v), want (%d, %v)", tc.body, m, live, tc.mins, tc.live)
		}
	}
}

func TestReusNumericStopID(t *testing.T) {
	if got := reusNumericStopID("REU_042"); got != "42" {
		t.Fatalf("reusNumericStopID(REU_042) = %q, want 42", got)
	}
	if got := reusNumericStopID("105"); got != "105" {
		t.Fatalf("reusNumericStopID(105) = %q, want 105", got)
	}
	if got := reusNumericStopID("abc"); got != "" {
		t.Fatalf("reusNumericStopID(abc) = %q, want empty", got)
	}
}

func TestReusEstimateLineBuses(t *testing.T) {
	route := rtRoute{Code: "L10", Name: "Montserrat - Barri Gaudí", Color: "#c8102e"}
	prof := &rtLineProfile{
		Code: "L10",
		Directions: []rtLineDirection{{
			DirectionID: 0,
			Headsign:    "Barri Gaudí",
			Stops: []rtLineStop{
				{ID: "1", Name: "Montserrat", Lat: 41.145, Lon: 1.100},
				{ID: "2", Name: "Oques", Lat: 41.155, Lon: 1.105},
				{ID: "3", Name: "Barri Gaudí", Lat: 41.165, Lon: 1.110},
			},
		}},
	}
	buses := reusEstimateLineBusesFromSamples(route, prof, "both", map[string]int{"2": 3}, time.Now())
	if len(buses) != 1 {
		t.Fatalf("expected 1 estimated Reus bus, got %d", len(buses))
	}
	o := buses[0].(*Obj)
	if o.Str("agencyId") != reusAgencyID || o.Str("lineRef") != "reus_transport:L10" {
		t.Errorf("unexpected Reus bus metadata: agencyId=%q lineRef=%q", o.Str("agencyId"), o.Str("lineRef"))
	}
}

func TestMatchGtfsRouteFilterAndAtmUrbanFormat(t *testing.T) {
	if !matchGtfsRouteFilter(tusSabadellFilter, "TUS_109", "TUS_979") {
		t.Error("expected TUS_109 to match tusSabadellFilter")
	}
	if matchGtfsRouteFilter(tusSabadellFilter, "AMB_44", "AMB_B25") {
		t.Error("expected AMB_44 not to match tusSabadellFilter")
	}
	if !matchGtfsRouteFilter(atmUrbanFilter, "FIG_47", "FIG_416") {
		t.Error("expected FIG_47 to match atmUrbanFilter")
	}
	if !matchGtfsRouteFilter(atmUrbanFilter, "ALS_720", "ALS_3229") {
		t.Error("expected ALS_3229 to match atmUrbanFilter")
	}
	if matchGtfsRouteFilter(atmUrbanFilter, "ALS_720", "ALS_9999") {
		t.Error("expected ALS_9999 not to match atmUrbanFilter")
	}
	code, name := formatAtmUrbanRoute("FIG_47", "FIG_416", "L1", "Vilatenim - Geriàtric")
	if code != "FIG-L1" || name != "Figueres · Vilatenim - Geriàtric" {
		t.Errorf("formatAtmUrbanRoute = (%q, %q)", code, name)
	}
}

func TestCataloniaUrbanSourcesGate(t *testing.T) {
	origFlag := os.Getenv("ARRIBO_CATALONIA_URBAN")
	origKey := os.Getenv("NAP_API_KEY")
	defer func() {
		_ = os.Setenv("ARRIBO_CATALONIA_URBAN", origFlag)
		_ = os.Setenv("NAP_API_KEY", origKey)
	}()
	_ = os.Setenv("ARRIBO_CATALONIA_URBAN", "0")
	_ = os.Setenv("NAP_API_KEY", "testkey")
	if got := cataloniaUrbanSources(); len(got) != 0 {
		t.Fatalf("expected 0 sources when disabled, got %d", len(got))
	}
	_ = os.Setenv("ARRIBO_CATALONIA_URBAN", "1")
	got := cataloniaUrbanSources()
	if len(got) != 4 {
		t.Fatalf("expected 4 Catalonia urban sources, got %d", len(got))
	}
}

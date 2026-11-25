package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestTramTokenCacheCachesAndResets(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := hits.Add(1)
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if r.Form.Get("grant_type") != "client_credentials" ||
			r.Form.Get("client_id") != "test-id" ||
			r.Form.Get("client_secret") != "test-sec" {
			http.Error(w, "bad creds", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if n == 1 {
			_, _ = w.Write([]byte(`{"access_token":"tok1","expires_in":3599}`))
		} else {
			_, _ = w.Write([]byte(`{"access_token":"tok2","expires_in":3599}`))
		}
	}))
	defer srv.Close()

	tc := &tramTokenCache{
		tokenURL:     srv.URL,
		clientID:     "test-id",
		clientSecret: "test-sec",
		client:       srv.Client(),
	}
	ctx := context.Background()
	h1, err := tc.token(ctx)
	if err != nil || h1 != "Bearer tok1" {
		t.Fatalf("first token: %q, err=%v", h1, err)
	}
	h2, err := tc.token(ctx)
	if err != nil || h2 != "Bearer tok1" || hits.Load() != 1 {
		t.Fatalf("cached token: %q, hits=%d, err=%v", h2, hits.Load(), err)
	}
	tc.reset()
	h3, err := tc.token(ctx)
	if err != nil || h3 != "Bearer tok2" || hits.Load() != 2 {
		t.Fatalf("refreshed token: %q, hits=%d, err=%v", h3, hits.Load(), err)
	}
}

func TestTramSourcesGateAndNoHistory(t *testing.T) {
	t.Setenv("ARRIBO_TRAM", "0")
	t.Setenv("TRAM_CLIENT_ID", "id")
	t.Setenv("TRAM_CLIENT_SECRET", "sec")
	if got := tramSources(); len(got) != 0 {
		t.Fatalf("expected 0 sources when disabled, got %d", len(got))
	}

	t.Setenv("ARRIBO_TRAM", "1")
	t.Setenv("TRAM_CLIENT_SECRET", "")
	if got := tramSources(); len(got) != 0 {
		t.Fatalf("expected 0 sources without secret, got %d", len(got))
	}

	t.Setenv("TRAM_CLIENT_SECRET", "sec")
	srcs := tramSources()
	if len(srcs) != 2 {
		t.Fatalf("expected 2 sources (tbx+tbs), got %d", len(srcs))
	}
	for _, s := range srcs {
		if !s.noHistory {
			t.Errorf("%s: TRAM terms require noHistory=true", s.AgencyID)
		}
		if s.authHeader == nil || s.tripURL == nil || s.staticURL == "" {
			t.Errorf("%s: missing auth/trip/static config", s.AgencyID)
		}
		if !strings.HasPrefix(trainAttribution[s.AgencyID], "Powered by TRAM Barcelona") {
			t.Errorf("%s: missing required TRAM attribution", s.AgencyID)
		}
	}
}

func TestTramVehiclesFromFeed(t *testing.T) {
	now := time.Unix(1795554000, 0)
	rtCatalog.Store(tramTbxAgencyID, &rtCatalogOp{
		AgencyID: tramTbxAgencyID,
		Mode:     "tram",
		Lines:    []rtRoute{{Code: "T1", Name: "Francesc Macià - Bon Viatge", Color: "#009640", RouteIDs: []string{"1"}}},
		Profiles: map[string]*rtLineProfile{
			"T1": {
				Code: "T1",
				Directions: []rtLineDirection{{
					DirectionID: 0,
					Stops: []rtLineStop{
						{ID: "S1", Name: "Francesc Macià", Lat: 41.392, Lon: 2.144},
						{ID: "S2", Name: "L'Illa", Lat: 41.389, Lon: 2.135},
						{ID: "S3", Name: "Numància", Lat: 41.387, Lon: 2.131},
					},
				}},
			},
		},
	})
	t.Cleanup(func() { rtCatalog.Delete(tramTbxAgencyID) })

	tArr := now.Unix() + 38 // ~halfway between S1 and S2 (75s inter-station)
	delay := int32(60)
	fm := &FeedMessage{
		Header: FeedHeader{Timestamp: uint64(now.Unix())},
		Entities: []Entity{{
			ID: "e1",
			TripUpdate: &TripUpdate{
				Trip:    TripDescriptor{TripID: "TR1", RouteID: "1"},
				Vehicle: &VehicleDescriptor{ID: "101", Label: "101"},
				StopTimeUpdates: []StopTimeUpdate{
					{StopID: "S2", Arrival: &StopTimeEvent{Time: &tArr}},
				},
			},
		}},
	}
	vs := tramVehiclesFromFeed(context.Background(), tramTbxAgencyID, nil, fm, map[string]int32{"TR1": delay}, map[string]bool{}, now)
	if len(vs) != 1 {
		t.Fatalf("expected 1 synthesized tram, got %d", len(vs))
	}
	v := vs[0]
	if v.Mode != "tram" || v.LineCode != "T1" || v.StopName != "L'Illa" || v.CurrentStatus != "IN_TRANSIT_TO" {
		t.Errorf("unexpected tram vehicle: %+v", v)
	}
	if v.Lat >= 41.392 || v.Lat <= 41.389 {
		t.Errorf("expected interpolated lat between 41.389 and 41.392, got %v", v.Lat)
	}
	if !v.HasDelayFromTripUpdate || v.DelaySec == nil || *v.DelaySec != 60 {
		t.Errorf("expected delay 60s on tram, got %+v", v.DelaySec)
	}
}

package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParseNominatimHits(t *testing.T) {
	raw := `[
		{
			"lat": "41.3912",
			"lon": "2.1598",
			"name": "",
			"display_name": "120, Carrer de Balmes, Eixample, Barcelona, Catalunya",
			"address": {
				"road": "Carrer de Balmes",
				"house_number": "120",
				"suburb": "Eixample",
				"city": "Barcelona"
			}
		},
		{
			"lat": "41.9794",
			"lon": "2.8214",
			"name": "Plaça de la Independència",
			"display_name": "Plaça de la Independència, Girona, Catalunya",
			"address": {
				"city": "Girona"
			}
		}
	]`
	hits, err := parseNominatimHits([]byte(raw))
	if err != nil {
		t.Fatalf("parseNominatimHits: %v", err)
	}
	if len(hits) != 2 {
		t.Fatalf("want 2 hits, got %d", len(hits))
	}
	if hits[0].Name != "Carrer de Balmes, 120" || hits[0].Subtitle != "Eixample, Barcelona" {
		t.Errorf("hit 0: %+v", hits[0])
	}
	if hits[1].Name != "Plaça de la Independència" || hits[1].Subtitle != "Girona" {
		t.Errorf("hit 1: %+v", hits[1])
	}
}

func TestGeocodeCataloniaCachesAndParses(t *testing.T) {
	calls := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Query().Get("bounded") != "1" || r.URL.Query().Get("viewbox") != cataloniaViewbox {
			t.Errorf("missing Catalonia viewbox bounds: %s", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"lat":"41.3912","lon":"2.1598","name":"","display_name":"Carrer de Balmes, 120, Barcelona","address":{"road":"Carrer de Balmes","house_number":"120","city":"Barcelona"}}]`))
	}))
	defer ts.Close()

	origBase := geocodeBase
	geocodeBase = ts.URL
	geocodeMu.Lock()
	geocodeCache = map[string]geocodeCacheEntry{}
	geocodeMu.Unlock()
	t.Cleanup(func() {
		geocodeBase = origBase
		geocodeMu.Lock()
		geocodeCache = map[string]geocodeCacheEntry{}
		geocodeMu.Unlock()
	})

	var s *Server
	h1 := s.geocodeCatalonia(context.Background(), "Balmes 120 Barcelona", 5)
	if len(h1) != 1 || h1[0].Name != "Carrer de Balmes, 120" {
		t.Fatalf("unexpected h1: %+v", h1)
	}
	// Second identical query must hit cache without calling upstream again.
	h2 := s.geocodeCatalonia(context.Background(), "balmes 120 barcelona", 5)
	if len(h2) != 1 || calls != 1 {
		t.Fatalf("expected cached result with 1 upstream call, got len=%d calls=%d", len(h2), calls)
	}
}

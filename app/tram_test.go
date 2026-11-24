package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
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

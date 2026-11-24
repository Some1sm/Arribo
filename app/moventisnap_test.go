package main

import "testing"

func TestMoventisNapSourcesGateAndConfig(t *testing.T) {
	t.Setenv("ARRIBO_MOVENTIS_ALL", "0")
	t.Setenv("NAP_API_KEY", "test-key")
	if got := moventisNapSources(); len(got) != 0 {
		t.Fatalf("expected 0 sources when disabled, got %d", len(got))
	}

	t.Setenv("ARRIBO_MOVENTIS_ALL", "1")
	t.Setenv("NAP_API_KEY", "")
	if got := moventisNapSources(); len(got) != 0 {
		t.Fatalf("expected 0 sources without NAP_API_KEY, got %d", len(got))
	}

	t.Setenv("NAP_API_KEY", "test-key")
	srcs := moventisNapSources()
	if len(srcs) != 5 {
		t.Fatalf("expected 5 Moventis NAP sources, got %d", len(srcs))
	}
	for _, s := range srcs {
		if !s.noHistory || s.Mode != "bus" || s.staticHeaders["ApiKey"] != "test-key" {
			t.Errorf("unexpected source %s: %+v", s.AgencyID, s)
		}
		if trainAttribution[s.AgencyID] == "" {
			t.Errorf("missing attribution for %s", s.AgencyID)
		}
		if !isMoventisNapAgency(s.AgencyID) {
			t.Errorf("isMoventisNapAgency(%s) should be true", s.AgencyID)
		}
	}
}

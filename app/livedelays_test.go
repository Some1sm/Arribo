package main

import (
	"testing"
	"time"
)

func TestLiveDelaysStoreReportAndDedup(t *testing.T) {
	s := &liveDelaysStore{byAgency: map[string]*liveDelayBucket{}}
	t0 := time.Date(2026, 11, 25, 10, 0, 0, 0, madrid)

	// Record AMB delays: trip1 on time (+1m), duplicate within 3 min ignored,
	// trip2 late (+8m), implausible (+400m) dropped.
	s.record(ambAgencyID, "B25", "Pomar", "t1", 60, t0)
	s.record(ambAgencyID, "B25", "Pomar", "t1", 120, t0.Add(1*time.Minute)) // deduped
	s.record(ambAgencyID, "B25", "Pomar", "t2", 480, t0.Add(30*time.Second))
	s.record(ambAgencyID, "B25", "Pomar", "t3", 24000, t0.Add(40*time.Second)) // implausible

	// Record TRAM Trambaix delay (+2m) and Sagalés delay (+6m).
	s.record(tramTbxAgencyID, "T1", "Francesc Macià", "tr1", 120, t0)
	s.record(sagalesAgencyID, "400", "Granollers", "v100", 360, t0)

	reps := s.operatorReports(24, nil, t0.Add(5*time.Minute))
	if len(reps) != 3 {
		t.Fatalf("expected 3 active operators (amb, tram_tbx, sagales), got %d", len(reps))
	}
	byID := map[string]*Obj{}
	for _, r := range reps {
		o := r.(*Obj)
		byID[o.Str("id")] = o
	}
	amb := byID[ambAgencyID]
	if amb == nil || amb.Num("visits") != 2 || amb.Num("avgDelay") != 4.5 || amb.Num("onTimePct") != 50 {
		t.Fatalf("unexpected AMB report: %s", toJSON(amb))
	}
	if len(amb.Arr("worstStations")) != 1 {
		t.Errorf("expected 1 worst station for AMB, got %d", len(amb.Arr("worstStations")))
	}
	tbx := byID[tramTbxAgencyID]
	if tbx == nil || tbx.Num("visits") != 1 || tbx.Num("onTimePct") != 100 {
		t.Fatalf("unexpected TRAM Trambaix report: %s", toJSON(tbx))
	}
	sag := byID[sagalesAgencyID]
	if sag == nil || sag.Num("visits") != 1 || sag.Num("avgDelay") != 6 {
		t.Fatalf("unexpected Sagalés report: %s", toJSON(sag))
	}

	// Line drill-down for AMB B25.
	lr := s.lineReport(ambAgencyID, "B25", 24, t0.Add(5*time.Minute))
	if lr.Num("visits") != 2 || len(lr.Arr("stations")) != 1 || len(lr.Arr("byHour")) != 1 {
		t.Fatalf("unexpected AMB B25 lineReport: %s", toJSON(lr))
	}
}

package main

import (
	"testing"
	"time"
)

func TestParseMovAlertsDedupAndMatch(t *testing.T) {
	now := time.Date(2026, 11, 25, 15, 0, 0, 0, madrid)
	body := []byte(`[
		{"nid":"170166","TITLE_INCIDENCIA":"BADALONA. Tall carrer Francesc Layret (obres).","RESUMEN_INCIDENCIA":"<p>Desviament provisional</p>","CODE_LINEA":"C-10","ENDATE":"2026-12-31 12:30:00"},
		{"nid":"170166","TITLE_INCIDENCIA":"BADALONA. Tall carrer Francesc Layret (obres).","RESUMEN_INCIDENCIA":"<p>Desviament provisional</p>","CODE_LINEA":"C-10","ENDATE":"2026-12-31 12:30:00"},
		{"nid":"170166","TITLE_INCIDENCIA":"BADALONA. Tall carrer Francesc Layret (obres).","RESUMEN_INCIDENCIA":"<p>Desviament provisional</p>","CODE_LINEA":"N-80","ENDATE":"2026-12-31 12:30:00"},
		{"nid":"100001","TITLE_INCIDENCIA":"Expired alert","RESUMEN_INCIDENCIA":"Old","CODE_LINEA":"C-10","ENDATE":"2025-01-01 00:00:00"}
	]`)
	alerts, err := parseMovAlerts(body, now)
	if err != nil {
		t.Fatalf("parseMovAlerts: %v", err)
	}
	if len(alerts) != 1 {
		t.Fatalf("expected 1 active deduplicated alert, got %d: %+v", len(alerts), alerts)
	}
	a := alerts[0]
	if a.Cause != "CONSTRUCTION" || a.Effect != "DETOUR" {
		t.Errorf("cause/effect = %s/%s", a.Cause, a.Effect)
	}
	if a.Description != "Desviament provisional" {
		t.Errorf("HTML not stripped: %q", a.Description)
	}
	if len(a.Lines) != 2 || a.Lines[0] != "C-10" || a.Lines[1] != "N-80" {
		t.Errorf("lines = %v", a.Lines)
	}

	movAlertsLive.Store(&alerts)
	t.Cleanup(func() { movAlertsLive.Store(nil) })

	if got := moventisAlertsFor("moventis", "c10", now); len(got) != 1 {
		t.Fatalf("expected C-10 match, got %d", len(got))
	}
	if got := moventisAlertsFor("moventis", "e11.1", now); len(got) != 0 {
		t.Fatalf("unexpected match for e11.1: %d", len(got))
	}
	if got := moventisAlertsFor("renfe_rodalies", "R1", now); len(got) != 0 {
		t.Fatalf("unexpected match for renfe_rodalies: %d", len(got))
	}
}

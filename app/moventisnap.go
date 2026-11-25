package main

// Additional Moventis Catalonia bus networks via official NAP static GTFS
// feeds (all include road shapes, stops, and timetables; noHistory: true):
//   - NAP 1576: Moventis Sarfa (27 routes — Costa Brava & Girona)
//   - NAP 1577: Moventis Costa / Pujol (10 routes — Blanes, Lloret, Tossa, Malgrat)
//   - NAP 1579: Moventis Autobusos de Lleida (14 routes — Lleida urban)
//   - NAP 1580: Moventis TCC (8 routes — Sitges, Sant Sadurní, Garraf)
//   - NAP 1581: Moventis Sarbus (58 routes — Vallès Occidental)
//
// Empresa Casas (NAP 1578, Maresme C-10..C-22) stays on the live moventis.es
// poller (app/moventis.go) so Mataró/Maresme lines are not duplicated.
// Opt-in with ARRIBO_MOVENTIS_ALL=1 (on in compose) and requires NAP_API_KEY.

import (
	"os"
	"strings"
	"time"
)

const (
	movSarfaAgencyID  = "moventis_sarfa"
	movCostaAgencyID  = "moventis_costa"
	movLleidaAgencyID = "moventis_lleida"
	movTccAgencyID    = "moventis_tcc"
	movSarbusAgencyID = "moventis_sarbus"
)

var movLleidaOperator = operatorInfo{
	ID: movLleidaAgencyID, Name: "Moventis Lleida", ShortName: "Lleida",
	Mode: "bus", Tier: "predicted", Method: "operator_prediction",
	Source: "Previsions en temps real d'Autobusos de Lleida (moventis.es, font no oficial) i horaris oficials GTFS via NAP 1579. Sense GPS.",
}

var moventisNapOperators = []operatorInfo{
	{
		ID: movSarfaAgencyID, Name: "Moventis Sarfa", ShortName: "Sarfa",
		Mode: "bus", Tier: "timetable", Method: "timetable",
		Source: "Horaris i recorreguts oficials GTFS de Moventis Sarfa (Costa Brava i Girona) via NAP 1576.",
	},
	{
		ID: movCostaAgencyID, Name: "Moventis Costa", ShortName: "M. Costa",
		Mode: "bus", Tier: "timetable", Method: "timetable",
		Source: "Horaris i recorreguts oficials GTFS de Moventis Costa (Blanes, Lloret, Malgrat) via NAP 1577.",
	},
	movLleidaOperator,
	{
		ID: movTccAgencyID, Name: "Moventis TCC", ShortName: "M. TCC",
		Mode: "bus", Tier: "timetable", Method: "timetable",
		Source: "Horaris i recorreguts oficials GTFS de Moventis TCC (Sitges i Garraf) via NAP 1580.",
	},
	{
		ID: movSarbusAgencyID, Name: "Moventis Sarbus", ShortName: "Sarbus",
		Mode: "bus", Tier: "timetable", Method: "timetable",
		Source: "Horaris i recorreguts oficials GTFS de Moventis Sarbus (Vallès Occidental) via NAP 1581.",
	},
}

var moventisNapFeeds = []struct {
	agencyID string
	napID    string
}{
	{movSarfaAgencyID, "1576"},
	{movCostaAgencyID, "1577"},
	{movLleidaAgencyID, "1579"},
	{movTccAgencyID, "1580"},
	{movSarbusAgencyID, "1581"},
}

func isMoventisNapAgency(id string) bool {
	switch id {
	case movSarfaAgencyID, movCostaAgencyID, movLleidaAgencyID, movTccAgencyID, movSarbusAgencyID:
		return true
	default:
		return false
	}
}

func moventisNapSources() []rtSource {
	if os.Getenv("ARRIBO_MOVENTIS_ALL") != "1" {
		return nil
	}
	napKey := strings.TrimSpace(os.Getenv("NAP_API_KEY"))
	if napKey == "" {
		return nil
	}
	out := make([]rtSource, 0, len(moventisNapFeeds))
	for _, f := range moventisNapFeeds {
		out = append(out, rtSource{
			AgencyID:      f.agencyID,
			Mode:          "bus",
			vehicleEvery:  time.Minute,
			tripEvery:     time.Minute,
			staticURL:     "https://nap.transportes.gob.es/api/Fichero/download/" + f.napID,
			staticHeaders: map[string]string{"ApiKey": napKey},
			noHistory:     true,
		})
	}
	return out
}

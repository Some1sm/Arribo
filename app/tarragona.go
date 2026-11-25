package main

// EMT Tarragona — Empresa Municipal de Transports Públics de Tarragona:
//   - Official static GTFS via NAP feed 1694 (21 urban routes, 407 stops,
//     shapes, timetables; noHistory: true).
//   - No public real-time GPS or ETA API is currently published by EMT.
//   - Opt-in with ARRIBO_TARRAGONA=1 (on in compose) and requires NAP_API_KEY.

import (
	"os"
	"strings"
	"time"
)

const (
	emtTarragonaAgencyID    = "emt_tarragona"
	emtTarragonaNapURL      = "https://nap.transportes.gob.es/api/Fichero/download/1694"
	emtTarragonaAttribution = "EMT Tarragona · Dades GTFS (NAP 1694)"
)

var emtTarragonaOperator = operatorInfo{
	ID: emtTarragonaAgencyID, Name: "EMT Tarragona", ShortName: "Tarragona",
	Mode: "bus", Tier: "timetable", Method: "timetable",
	Source: "Recorreguts i horaris oficials GTFS d'EMT Tarragona via NAP 1694 (sense font pública de temps real).",
}

func emtTarragonaSource() (rtSource, bool) {
	if os.Getenv("ARRIBO_TARRAGONA") != "1" {
		return rtSource{}, false
	}
	napKey := strings.TrimSpace(os.Getenv("NAP_API_KEY"))
	if napKey == "" {
		return rtSource{}, false
	}
	return rtSource{
		AgencyID:      emtTarragonaAgencyID,
		Mode:          "bus",
		vehicleEvery:  time.Minute,
		tripEvery:     time.Minute,
		staticURL:     emtTarragonaNapURL,
		staticHeaders: map[string]string{"ApiKey": napKey},
		noHistory:     true,
	}, true
}

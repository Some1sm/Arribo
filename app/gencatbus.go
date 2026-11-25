package main

// Generalitat de Catalunya interurban bus GTFS (open data, no API key):
//   https://territori.gencat.cat/.../busos-interurbans-GTFS.zip
//
// Scoped to the Barcelona ATM / Vallès / Maresme / Garraf / Baix Llobregat
// bounding box so every interurban bus relayed by AMB's live GPS feed (e.g.
// 221 Sabadell-Caldes-Bigues, Vallès Oriental/Occidental Sagalés/Monbus/TGO
// lines, etc.) gets its real road shape, stops, timetable, and single-line
// view without bloating memory. Opt-in with ARRIBO_GENCAT_BUS=1 (on in
// compose); requires ARRIBO_GTFSRT=1. No SQLite history writes.

import (
	"os"
	"strings"
	"time"
)

const (
	gencatBusAgencyID    = "gencat_bus"
	gencatBusURL         = "https://territori.gencat.cat/web/.content/home/serveis/visors-cartografia/bases-cartografiques/infraestructures-mobilitat/autobusos-interurbans/busos-interurbans-GTFS.zip"
	gencatBusBBox        = "41.15,41.80,1.55,2.75"
	gencatBusAttribution = "Generalitat de Catalunya (dades obertes)"
)

var gencatBusOperator = operatorInfo{
	ID: gencatBusAgencyID, Name: "Bus Interurbà (Generalitat)", ShortName: "Interurbà",
	Mode: "bus", Tier: "timetable", Method: "timetable",
	Source: "Recorreguts i horaris oficials GTFS dels autobusos interurbans de la Generalitat de Catalunya (àmbit de Barcelona); posició GPS en directe per a les línies amb seguiment AMB.",
}

func gencatBusSource() (rtSource, bool) {
	if os.Getenv("ARRIBO_GENCAT_BUS") != "1" {
		return rtSource{}, false
	}
	return rtSource{
		AgencyID:     gencatBusAgencyID,
		Mode:         "bus",
		vehicleEvery: time.Minute,
		tripEvery:    time.Minute,
		staticURL:    gencatBusURL,
		staticBBox:   gencatBusBBox,
		noHistory:    true,
	}, true
}

// parseGencatBusRouteCode extracts the rider-facing line code from Generalitat
// interurban GTFS routes, where route_short_name is an internal 4-digit id
// (e.g. "0498") and route_long_name starts with "(221) Sabadell - Bigues".
func parseGencatBusRouteCode(shortName, longName string) (code, cleanName string) {
	shortName = strings.TrimSpace(shortName)
	longName = strings.TrimSpace(longName)
	if strings.HasPrefix(longName, "(") {
		if closeIdx := strings.IndexByte(longName, ')'); closeIdx > 1 && closeIdx <= 18 {
			inner := strings.TrimSpace(longName[1:closeIdx])
			rest := strings.TrimSpace(longName[closeIdx+1:])
			if inner != "" {
				if rest == "" {
					rest = longName
				}
				return inner, rest
			}
		}
	}
	return shortName, longName
}

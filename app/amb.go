package main

// AMB "Bus Metropolità" (plan step 6.3): the Àrea Metropolitana de
// Barcelona's open GTFS-RT trip updates and alerts (no key) with its static
// GTFS, through the same poller as the trains. AMB publishes no vehicle
// positions, so its lines have stops, paths and predicted departures but no
// buses on the map. Its stop visits are not stored (noHistory): about
// 30 000 trips a day would add some 750 000 rows a day to the history
// database. Opt-in with ARRIBO_AMB=1 (on in compose), and only with the
// pollers (ARRIBO_GTFSRT=1).

import (
	"html"
	"os"
	"strings"
	"time"
)

const ambAgencyID = "amb"

var ambOperator = operatorInfo{ID: ambAgencyID, Name: "AMB Bus Metropolità", ShortName: "AMB", Mode: "bus", Tier: "predicted", Method: "operator_prediction",
	Source: "Hora prevista d'arribada a cada parada que l'Àrea Metropolitana de Barcelona publica en temps real (GTFS-RT). L'AMB no publica la posició dels busos."}

const ambAttribution = "Àrea Metropolitana de Barcelona (dades obertes)"

// ambSource is AMB's feeds, when ARRIBO_AMB=1.
func ambSource() (rtSource, bool) {
	if os.Getenv("ARRIBO_AMB") != "1" {
		return rtSource{}, false
	}
	return rtSource{
		AgencyID: ambAgencyID, Mode: "bus",
		tripURL:      fixedURL("https://www.ambmobilitat.cat/transit/trips-updates/trips.bin"),
		alertURL:     fixedURL("https://www.ambmobilitat.cat/transit/alerts/alerts.bin"),
		vehicleEvery: time.Minute, tripEvery: time.Minute, // no vehicle feed: the tick only refreshes the snapshot
		// A six-day window, published every day: the daily refresh keeps it current.
		staticURL: "https://www.ambmobilitat.cat/OpenData/google_transit.zip",
		noHistory: true,
	}, true
}

// liveLineFeeds is the running pollers' snapshots for every operator the
// line view opens (lineOperators), AMB included; /api/trains keeps to the
// train operators (liveTrainFeeds).
func liveLineFeeds() []trainFeed {
	pp := rtLivePollers.Load()
	if pp == nil {
		return nil
	}
	var feeds []trainFeed
	for _, info := range lineOperators() {
		for _, p := range *pp {
			if p.src.AgencyID == info.ID {
				feeds = append(feeds, trainFeed{info: info, snap: p.snap.Load()})
			}
		}
	}
	return feeds
}

// rtNoFeedRunningWindow: without a positions feed, a trip counts as running
// (its predicted times shown as live) only when its next predicted stop is
// this close. AMB also lists trips that have not started, with a bus
// assigned, up to two hours ahead (2026-11-24: median 15 min, max 115 min).
const rtNoFeedRunningWindow = 30 * time.Minute

// tripUpdateSoon says whether the first predicted stop time of tu is at most
// rtNoFeedRunningWindow after the feed time ts (unix seconds).
func tripUpdateSoon(tu *TripUpdate, ts uint64) bool {
	for _, s := range tu.StopTimeUpdates {
		ev := s.Arrival
		if ev == nil || ev.Time == nil {
			ev = s.Departure
		}
		if ev == nil || ev.Time == nil {
			continue
		}
		return ts == 0 || *ev.Time <= int64(ts)+int64(rtNoFeedRunningWindow/time.Second)
	}
	return false
}

// ambAlertText is an AMB alert text as plain text: tags dropped, entities
// decoded (&agrave;, &#39;, &nbsp;...), runs of spaces folded.
func ambAlertText(s string) string {
	s = reTag.ReplaceAllString(s, " ")
	s = html.UnescapeString(s)
	s = strings.ReplaceAll(s, " ", " ")
	return strings.Join(strings.Fields(s), " ")
}

package main

// The line view for Moventis lines (/api/line/moventis:<code>): the same
// shape as the train lines' (railline.go), from the catalog the Moventis
// poller publishes, with the buses estimated from its predictions and, at a
// stop, the tracked predictions it last collected there. A stop the poller
// does not sample, or has not reached yet, says so instead of inventing
// times.

import (
	"math"
	"sort"
	"time"
)

// movLineBuses is one line's estimated buses for the line view, in the
// fields the view reads for a train (railLineTrains), in direction
// ("0", "1"... or "both").
func movLineBuses(code, direction string, now time.Time) []any {
	out := []any{}
	p := movLive.Load()
	if p == nil {
		return out
	}
	snap := p.snap.Load()
	if snap == nil || snap.Static == nil {
		return out
	}
	for _, v := range movVehiclesWithAMB(snap.Static, snap.Lines, snap.Preds, now) {
		b := v.(*Obj)
		if jsString(b.Get("lineCode")) != code {
			continue
		}
		dir := jsString(b.Get("directionId"))
		if direction != "both" && dir != direction {
			continue
		}
		b.Set("lineId", movAgencyID+":"+code)
		b.Set("vehicleId", b.Get("id"))
		b.Set("direction", dir)
		b.Set("toStop", b.Get("stopName"))
		b.Set("ageSec", b.Get("predictionAgeSec"))
		b.Set("delayMinutes", nil)
		b.Set("delayStatus", "unknown")
		b.Set("isGhostVehicle", false)
		if truthy(b.Get("isRealTime")) {
			// AMB measured GPS, not a moventis.es prediction.
			b.Set("delayBadgeText", "Posició GPS")
			b.Set("delayFormatted", "Posició en temps real")
			b.Set("agency", ambOperator.Name)
			b.Set("attribution", ambAttribution)
		} else {
			b.Set("delayBadgeText", "Posició estimada")
			b.Set("delayFormatted", "Posició estimada")
			b.Set("agency", movOperator.Name)
			b.Set("attribution", movAttributionText())
		}
		out = append(out, b)
	}
	return out
}

const movAttribution = "Moventis (prediccions del seu web de temps real)"

// movStopDepartures is the line view's departures at a stop of a Moventis
// line: the tracked predictions last collected there, run down to now.
func movStopDepartures(stop rtLineStop, code string, now time.Time) *Obj {
	deps := []any{}
	note := "not_sampled"
	p := movLive.Load()
	var snap *movSnapshot
	if p != nil {
		snap = p.snap.Load()
	}
	if snap != nil && snap.Static != nil {
		for _, id := range snap.Lines {
			l := snap.Static.Lines[id]
			if l.Code != code {
				continue
			}
			routes := snap.Static.Routes[id]
			for _, rt := range routes {
				for _, st := range rt.Stops {
					if numToString(float64(st.ID)) != stop.ID {
						continue
					}
					if movSampled(snap.Static, snap.Lines, st.ID) {
						note = "no_tracked_bus"
					}
					pr, ok := snap.Preds[[3]int{id, rt.Trayecto, st.ID}]
					if !ok {
						continue
					}
					age := now.Sub(pr.At).Seconds()
					if age > movObsMaxAge.Seconds() {
						continue
					}
					note = ""
					for _, e := range pr.EtaSec {
						left := e - age
						if left < -movPassedTolSec {
							continue
						}
						left = math.Max(left, 0)
						at := now.Add(time.Duration(left) * time.Second)
						deps = append(deps, O(
							"tripId", nil,
							"vehicleId", nil,
							"destination", strOrNil(movTitle(rt.Dest)),
							"direction", numToString(float64(movDirectionOf(routes, rt.Trayecto))),
							"departureTime", at.In(madrid).Format("15:04"),
							"scheduledTime", nil,
							"expectedIso", isoString(at.UnixMilli()),
							"minutesAway", math.Floor(left/60),
							"delayMins", nil,
							"delayMinutes", nil,
							"delayStatus", "unknown",
							"delayBadgeText", "Previsió de Moventis",
							"delaySource", "operator_prediction",
							"isRealTime", true,
							"isEstimated", false,
							"isTheoretical", false,
							"isCancelled", false,
							"predictionAgeSec", math.Round(age),
						))
					}
				}
			}
		}
	}
	sort.SliceStable(deps, func(i, j int) bool {
		return jsString(deps[i].(*Obj).Get("expectedIso")) < jsString(deps[j].(*Obj).Get("expectedIso"))
	})
	return O(
		"stop", O("id", stop.ID, "name", stop.Name, "lat", stop.Lat, "lon", stop.Lon, "agencyId", movAgencyID),
		"departures", deps,
		"source", "moventis_predictions",
		// not_sampled: the poller does not ask this stop (it samples about
		// one stop per 1.5 km); no_tracked_bus: asked, no tracked bus coming.
		"note", strOrNil(note),
		"attribution", movAttributionText(),
	)
}

// movSampled reports whether the poller asks this stop.
func movSampled(s *movStatic, lineIDs []int, stopID int) bool {
	for _, sm := range movSamples(s, lineIDs) {
		if sm.StopID == stopID {
			return true
		}
	}
	return false
}

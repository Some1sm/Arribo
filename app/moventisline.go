package main

// The line view for Moventis lines (/api/line/moventis:<code>): the same
// shape as the train lines' (railline.go), from the catalog the Moventis
// poller publishes, with the buses estimated from its predictions and, at a
// stop, the tracked predictions it last collected there. A stop the poller
// does not sample, or has not reached yet, says so instead of inventing
// times.

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
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
		} else if jsString(b.Get("positionSource")) == "gps_extrapolated" {
			// Dead-reckoning continuation from AMB's last real GPS ping.
			b.Set("delayBadgeText", "Posició estimada (GPS)")
			b.Set("delayFormatted", "Posició estimada (últim GPS)")
			b.Set("agency", movOperator.Name)
			b.Set("attribution", movAttributionText())
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

const movOnDemandTTL = 30 * time.Second

type movOnDemandEntry struct {
	etas []movStopETA
	at   time.Time
}

var (
	movOnDemandMu    sync.Mutex
	movOnDemandCache = map[[2]int]movOnDemandEntry{}
)

// movFetchStopLive fetches /api/json/GetTiemposParada on-demand for a clicked
// stop with a 30 s TTL cache so unsampled stops (e.g. Montgat Nord) show live
// Moventis predictions and scheduled departures instead of "not_sampled".
func movFetchStopLive(ctx context.Context, p *movPoller, s *movStatic, lineID, stopID int, now time.Time) ([]movStopETA, time.Time, bool) {
	if p == nil || ctx == nil {
		return nil, time.Time{}, false
	}
	key := [2]int{lineID, stopID}
	movOnDemandMu.Lock()
	if ent, ok := movOnDemandCache[key]; ok && now.Sub(ent.at) < movOnDemandTTL {
		movOnDemandMu.Unlock()
		return ent.etas, ent.at, true
	}
	movOnDemandMu.Unlock()

	body, err := p.getInteractive(ctx, fmt.Sprintf("/api/json/GetTiemposParada/ca/%d/%d/0", stopID, lineID))
	if err != nil {
		return nil, time.Time{}, false
	}
	etas, err := parseMovStopTimes(body)
	if err != nil {
		if err == errMovThrottled {
			p.throttled()
		}
		return nil, time.Time{}, false
	}
	fetchedAt := time.Now()
	movOnDemandMu.Lock()
	if len(movOnDemandCache) > 256 {
		for k, v := range movOnDemandCache {
			if fetchedAt.Sub(v.at) >= movOnDemandTTL {
				delete(movOnDemandCache, k)
			}
		}
	}
	movOnDemandCache[key] = movOnDemandEntry{etas: etas, at: fetchedAt}
	movOnDemandMu.Unlock()
	if s != nil {
		p.record(s, stopID, etas, fetchedAt)
	}
	return etas, fetchedAt, true
}

// movMatchDir finds the best direction index for a Moventis trayecto label.
func movMatchDir(routes []movRoute, dest string) string {
	norm := foldStationName(dest)
	for _, rt := range routes {
		if norm != "" && (foldStationName(rt.Dest) == norm || strings.Contains(norm, foldStationName(rt.Dest)) || strings.Contains(foldStationName(rt.Dest), norm)) {
			return numToString(float64(movDirectionOf(routes, rt.Trayecto)))
		}
	}
	return "0"
}

// movSchedTime resolves a Madrid-local "HH:MM" schedule string to a time.Time
// near now (handling midnight rollover) and returns false if outside [-2m, 120m].
func movSchedTime(hhmm string, now time.Time) (time.Time, bool) {
	m := reMovHora.FindStringSubmatch(hhmm)
	if m == nil {
		return time.Time{}, false
	}
	hh, _ := strconv.Atoi(m[1])
	mm, _ := strconv.Atoi(m[2])
	locNow := now.In(madrid)
	cand := time.Date(locNow.Year(), locNow.Month(), locNow.Day(), hh, mm, 0, 0, madrid)
	diff := cand.Sub(now)
	if diff < -12*time.Hour {
		cand = cand.Add(24 * time.Hour)
		diff = cand.Sub(now)
	}
	if diff < -2*time.Minute || diff > 120*time.Minute {
		return time.Time{}, false
	}
	return cand, true
}

// movStopDepartures is the line view's departures at a stop of a Moventis
// line: live on-demand predictions + scheduled departures (30 s TTL cache),
// falling back to the background poller's last snapshot.
func movStopDepartures(ctx context.Context, stop rtLineStop, code string, now time.Time) *Obj {
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
			stopNum := 0
			for _, rt := range routes {
				for _, st := range rt.Stops {
					if numToString(float64(st.ID)) == stop.ID {
						stopNum = st.ID
						break
					}
				}
				if stopNum != 0 {
					break
				}
			}
			if stopNum == 0 {
				continue
			}

			// 1. Try live on-demand fetch (30 s cache) for real-time + scheduled departures.
			if etas, fetchedAt, ok := movFetchStopLive(ctx, p, snap.Static, id, stopNum, now); ok {
				age := math.Max(0, now.Sub(fetchedAt).Seconds())
				note = "no_tracked_bus"
				var rtTimes []time.Time
				for _, e := range etas {
					if e.LineID != id {
						continue
					}
					dirStr := movMatchDir(routes, e.Dest)
					destTitle := strOrNil(movTitle(e.Dest))
					for _, sec := range e.EtaSec {
						left := sec - age
						if left < -movPassedTolSec {
							continue
						}
						left = math.Max(left, 0)
						at := now.Add(time.Duration(left) * time.Second)
						rtTimes = append(rtTimes, at)
						note = ""
						deps = append(deps, O(
							"tripId", nil,
							"vehicleId", nil,
							"destination", destTitle,
							"direction", dirStr,
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
					for _, hhmm := range e.Sched {
						at, ok := movSchedTime(hhmm, now)
						if !ok {
							continue
						}
						dup := false
						for _, rtt := range rtTimes {
							if math.Abs(at.Sub(rtt).Seconds()) < 120 {
								dup = true
								break
							}
						}
						if dup {
							continue
						}
						left := math.Max(0, at.Sub(now).Seconds())
						note = ""
						deps = append(deps, O(
							"tripId", nil,
							"vehicleId", nil,
							"destination", destTitle,
							"direction", dirStr,
							"departureTime", at.In(madrid).Format("15:04"),
							"scheduledTime", at.In(madrid).Format("15:04"),
							"expectedIso", isoString(at.UnixMilli()),
							"minutesAway", math.Floor(left/60),
							"delayMins", nil,
							"delayMinutes", nil,
							"delayStatus", "unknown",
							"delayBadgeText", "Horari teòric",
							"delaySource", "timetable",
							"isRealTime", false,
							"isEstimated", false,
							"isTheoretical", true,
							"isCancelled", false,
							"predictionAgeSec", nil,
						))
					}
				}
			} else {
				// 2. Fallback: background poller snapshot.
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

			// 3. Rolling 24h schedule cache (DATA_DIR/moventis/schedules.json):
			// supplements both live and fallback responses with cached day-type
			// departures (deduplicated within 2 min of already-listed times).
			if p.sched != nil {
				if byDest := p.sched.lookup(id, stopNum, now); len(byDest) > 0 {
					var existingTimes []time.Time
					for _, raw := range deps {
						if o, ok := raw.(*Obj); ok {
							if parsed, err := time.Parse(time.RFC3339Nano, jsString(o.Get("expectedIso"))); err == nil {
								existingTimes = append(existingTimes, parsed)
							}
						}
					}
					for dest, hhList := range byDest {
						dirStr := movMatchDir(routes, dest)
						destTitle := strOrNil(movTitle(dest))
						for _, hhmm := range hhList {
							at, ok := movSchedTime(hhmm, now)
							if !ok {
								continue
							}
							dup := false
							for _, et := range existingTimes {
								if math.Abs(at.Sub(et).Seconds()) < 120 {
									dup = true
									break
								}
							}
							if dup {
								continue
							}
							existingTimes = append(existingTimes, at)
							left := math.Max(0, at.Sub(now).Seconds())
							note = ""
							deps = append(deps, O(
								"tripId", nil,
								"vehicleId", nil,
								"destination", destTitle,
								"direction", dirStr,
								"departureTime", at.In(madrid).Format("15:04"),
								"scheduledTime", at.In(madrid).Format("15:04"),
								"expectedIso", isoString(at.UnixMilli()),
								"minutesAway", math.Floor(left/60),
								"delayMins", nil,
								"delayMinutes", nil,
								"delayStatus", "unknown",
								"delayBadgeText", "Horari teòric",
								"delaySource", "timetable",
								"isRealTime", false,
								"isEstimated", false,
								"isTheoretical", true,
								"isCancelled", false,
								"predictionAgeSec", nil,
							))
						}
					}
				}
			}

			// 4. Last-resort fallback: bundled Generalitat timetable so stops
			// never show empty "0 sortides" if moventis.es is throttled/down.
			if len(deps) == 0 {
				if gc := gencatData(); gc != nil {
					times := gc.upcomingDepartures(id, stopNum, now, 120*time.Minute)
					destFallback := ""
					dirFallback := "0"
					for _, rt := range routes {
						for _, st := range rt.Stops {
							if st.ID == stopNum {
								destFallback = movTitle(rt.Dest)
								dirFallback = numToString(float64(movDirectionOf(routes, rt.Trayecto)))
								break
							}
						}
						if destFallback != "" {
							break
						}
					}
					for _, at := range times {
						left := math.Max(0, at.Sub(now).Seconds())
						note = ""
						deps = append(deps, O(
							"tripId", nil,
							"vehicleId", nil,
							"destination", strOrNil(destFallback),
							"direction", dirFallback,
							"departureTime", at.In(madrid).Format("15:04"),
							"scheduledTime", at.In(madrid).Format("15:04"),
							"expectedIso", isoString(at.UnixMilli()),
							"minutesAway", math.Floor(left/60),
							"delayMins", nil,
							"delayMinutes", nil,
							"delayStatus", "unknown",
							"delayBadgeText", "Horari teòric",
							"delaySource", "timetable",
							"isRealTime", false,
							"isEstimated", false,
							"isTheoretical", true,
							"isCancelled", false,
							"predictionAgeSec", nil,
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

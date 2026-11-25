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

// movCleanDest returns a readable destination label for a matched route.
func movCleanDest(rawDest string, matched *movRoute) string {
	if matched != nil && strings.Contains(rawDest, "(") && matched.Dest != "" {
		return movTitle(matched.Dest)
	}
	return movTitle(rawDest)
}

// movMatchRoute finds the best direction index and clean destination label
// for a Moventis trayecto string (handling both short destinations like
// "Barcelona" and full route labels like "(C10) BCN - MATARÓ (PER LA NII)").
func movMatchRoute(routes []movRoute, dest string) (string, string) {
	// If the label has "ORIGIN - DEST", match the destination side first so
	// "(C10) BCN - MATARÓ" matches Mataró rather than BCN.
	destSide := dest
	if idx := strings.Index(dest, " - "); idx >= 0 {
		destSide = dest[idx+3:]
	}
	matchIn := func(candidate string) *movRoute {
		norm := foldStationName(candidate)
		if norm == "" {
			return nil
		}
		for i := range routes {
			rd := foldStationName(routes[i].Dest)
			if rd == "" {
				continue
			}
			if rd == norm || strings.Contains(norm, rd) || strings.Contains(rd, norm) ||
				(rd == "bcn" && strings.Contains(norm, "barcelona")) ||
				(rd == "barcelona" && strings.Contains(norm, "bcn")) {
				return &routes[i]
			}
		}
		return nil
	}
	rt := matchIn(destSide)
	if rt == nil && destSide != dest {
		rt = matchIn(dest)
	}
	if rt != nil {
		return numToString(float64(movDirectionOf(routes, rt.Trayecto))), movCleanDest(dest, rt)
	}
	return "0", movCleanDest(dest, nil)
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

type movClaimed struct {
	dir string
	at  time.Time
}

// movTimeClaimed reports whether t falls within 3 minutes of any already-listed
// live arrival, claimed scheduled slot, or scheduled departure in the same
// direction.
func movTimeClaimed(dir string, t time.Time, claimed []movClaimed) bool {
	for _, c := range claimed {
		if c.dir == dir && math.Abs(t.Sub(c.at).Seconds()) < 180 {
			return true
		}
	}
	return false
}

// movInferPriorSched infers the immediately preceding scheduled departure
// when moventis.es has already dropped a late bus's past slot from sched.
func movInferPriorSched(sched []string, expected, now time.Time) (time.Time, bool) {
	locNow := now.In(madrid)
	var times []time.Time
	for _, s := range sched {
		m := reMovHora.FindStringSubmatch(s)
		if m == nil {
			continue
		}
		hh, _ := strconv.Atoi(m[1])
		mm, _ := strconv.Atoi(m[2])
		if hh > 23 || mm > 59 {
			continue
		}
		cand := time.Date(locNow.Year(), locNow.Month(), locNow.Day(), hh, mm, 0, 0, madrid)
		diff := cand.Sub(now)
		if diff < -12*time.Hour {
			cand = cand.Add(24 * time.Hour)
			diff = cand.Sub(now)
		}
		if diff < -2*time.Minute || diff > 6*time.Hour {
			continue
		}
		times = append(times, cand)
	}
	if len(times) < 2 {
		return time.Time{}, false
	}
	sort.Slice(times, func(i, j int) bool { return times[i].Before(times[j]) })
	uniq := times[:0]
	for _, t := range times {
		if len(uniq) == 0 || !t.Equal(uniq[len(uniq)-1]) {
			uniq = append(uniq, t)
		}
	}
	if len(uniq) < 2 {
		return time.Time{}, false
	}
	t0, t1 := uniq[0], uniq[1]
	h := t1.Sub(t0)
	if h < 10*time.Minute || h > 90*time.Minute {
		return time.Time{}, false
	}
	if !expected.Before(t0.Add(-movDelayMaxEarly)) {
		return time.Time{}, false
	}
	prev := t0.Add(-h)
	if prev.After(now) {
		return time.Time{}, false
	}
	delay := expected.Sub(prev)
	if delay < time.Minute || delay > movDelayMaxLate {
		return time.Time{}, false
	}
	return prev, true
}

// movEstimateDelay compares a live Moventis predicted arrival (expected)
// against the direction-matched live scheduled times (extraSched), the
// rolling 24h schedule cache filtered by direction (p.sched), or the bundled
// Generalitat GTFS schedule (gencatData) to compute scheduledTime, delayMins,
// status, and badge text.
// Returns the matched scheduled time so the caller can suppress duplicate
// theoretical rows when a live bus is running late or early.
func movEstimateDelay(p *movPoller, lineID, stopID int, dirStr string, routes []movRoute, expected, now time.Time, extraSched []string) (matched time.Time, hasMatch bool, schedTime, aimedIso, delayMins any, delayStatus, badgeText, delaySource string) {
	delayStatus = "unknown"
	badgeText = "Previsió de Moventis"
	delaySource = "operator_prediction"

	if len(extraSched) > 0 {
		matched, hasMatch = matchMovSched(extraSched, expected, movDelayMaxEarly, movDelayMaxLate)
	}
	if !hasMatch && p != nil && p.sched != nil {
		if byDest := p.sched.lookup(lineID, stopID, now); len(byDest) > 0 {
			var dirTimes, allTimes []string
			for dest, list := range byDest {
				allTimes = append(allTimes, list...)
				if d, _ := movMatchRoute(routes, dest); d == dirStr {
					dirTimes = append(dirTimes, list...)
				}
			}
			if len(dirTimes) > 0 {
				matched, hasMatch = matchMovSched(dirTimes, expected, movDelayMaxEarly, movDelayMaxLate)
			}
			if !hasMatch && len(allTimes) > 0 {
				matched, hasMatch = matchMovSched(allTimes, expected, movDelayMaxEarly, movDelayMaxLate)
			}
		}
	}
	if !hasMatch {
		if gc := gencatData(); gc != nil {
			matched, hasMatch = gc.nearestDeparture(lineID, stopID, expected, movDelayMaxEarly, movDelayMaxLate)
		}
	}
	if !hasMatch && len(extraSched) >= 2 {
		matched, hasMatch = movInferPriorSched(extraSched, expected, now)
	}
	if !hasMatch {
		return
	}
	dMin := math.Round(expected.Sub(matched).Minutes())
	schedTime = matched.In(madrid).Format("15:04")
	aimedIso = isoString(matched.UnixMilli())
	delayMins = dMin
	delayStatus, badgeText = railDelayLabel(dMin, false)
	delaySource = "timetable"
	return
}

// movFilterDepsByDir filters Moventis stop departures by the requested
// direction ("0", "1", ... or ""/"both"). At a shared terminal stop (e.g.
// Metro La Pau 19946 or Hospital de Mataró 7340, which is the final drop-off
// stop of one direction and the origin boarding stop of the opposite
// direction), ""/"both" suppresses the drop-off-only terminating direction so
// "Sortides" lists only boardable departures instead of mixing in arrivals.
func movFilterDepsByDir(deps []any, direction string, routes []movRoute, stopNum int) []any {
	if len(deps) == 0 {
		return deps
	}
	if direction != "" && direction != "both" {
		out := make([]any, 0, len(deps))
		for _, raw := range deps {
			if o, ok := raw.(*Obj); ok && jsString(o.Get("direction")) == direction {
				out = append(out, raw)
			}
		}
		return out
	}
	dropOnlyDirs := map[string]bool{}
	hasBoardingDir := false
	for _, rt := range routes {
		if len(rt.Stops) < 2 {
			continue
		}
		dStr := numToString(float64(movDirectionOf(routes, rt.Trayecto)))
		lastIdx := len(rt.Stops) - 1
		isLast := rt.Stops[lastIdx].ID == stopNum
		isBoardable := false
		for i := 0; i < lastIdx; i++ {
			if rt.Stops[i].ID == stopNum {
				isBoardable = true
				break
			}
		}
		if isBoardable {
			hasBoardingDir = true
		} else if isLast {
			dropOnlyDirs[dStr] = true
		}
	}
	if !hasBoardingDir || len(dropOnlyDirs) == 0 {
		return deps
	}
	out := make([]any, 0, len(deps))
	for _, raw := range deps {
		if o, ok := raw.(*Obj); ok && !dropOnlyDirs[jsString(o.Get("direction"))] {
			out = append(out, raw)
		}
	}
	return out
}

func movTheoDep(destTitle any, dirStr string, at, now time.Time) *Obj {
	left := math.Max(0, at.Sub(now).Seconds())
	return O(
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
	)
}

// movBuildLiveAndSchedDeps merges live real-time predictions and scheduled
// departures for one line at a stop. Live departures run first so any
// scheduled slot claimed by a late/early live bus (e.g. 16:55 bus running at
// 17:04, +9 min) is suppressed instead of duplicating as a phantom theoretical
// arrival.
func movBuildLiveAndSchedDeps(p *movPoller, lineID, stopNum int, routes []movRoute, etas []movStopETA, age float64, now time.Time) (deps []any, claimed []movClaimed) {
	schedByDir := map[string][]string{}
	var allLiveSched []string
	for _, e := range etas {
		if e.LineID == lineID && len(e.Sched) > 0 {
			dirStr, _ := movMatchRoute(routes, e.Dest)
			schedByDir[dirStr] = append(schedByDir[dirStr], e.Sched...)
			allLiveSched = append(allLiveSched, e.Sched...)
		}
	}
	// Pass 1: live real-time predictions.
	for _, e := range etas {
		if e.LineID != lineID || len(e.EtaSec) == 0 {
			continue
		}
		dirStr, cleanDest := movMatchRoute(routes, e.Dest)
		destTitle := strOrNil(cleanDest)
		dirSched := schedByDir[dirStr]
		if len(dirSched) == 0 {
			dirSched = allLiveSched
		}
		for _, sec := range e.EtaSec {
			left := sec - age
			if left < -movPassedTolSec {
				continue
			}
			left = math.Max(left, 0)
			at := now.Add(time.Duration(left) * time.Second)
			claimed = append(claimed, movClaimed{dir: dirStr, at: at})
			matched, hasMatch, sTime, aIso, dMins, dStatus, dBadge, dSource := movEstimateDelay(p, lineID, stopNum, dirStr, routes, at, now, dirSched)
			if hasMatch {
				claimed = append(claimed, movClaimed{dir: dirStr, at: matched})
			}
			deps = append(deps, O(
				"tripId", nil,
				"vehicleId", nil,
				"destination", destTitle,
				"direction", dirStr,
				"departureTime", at.In(madrid).Format("15:04"),
				"scheduledTime", sTime,
				"aimedIso", aIso,
				"expectedIso", isoString(at.UnixMilli()),
				"minutesAway", math.Floor(left/60),
				"delayMins", dMins,
				"delayMinutes", dMins,
				"delayStatus", dStatus,
				"delayBadgeText", dBadge,
				"delaySource", dSource,
				"isRealTime", true,
				"isEstimated", false,
				"isTheoretical", false,
				"isCancelled", false,
				"predictionAgeSec", math.Round(age),
			))
		}
	}
	// Pass 2: scheduled times in the same direction not already claimed by a live bus.
	for _, e := range etas {
		if e.LineID != lineID || len(e.Sched) == 0 {
			continue
		}
		dirStr, cleanDest := movMatchRoute(routes, e.Dest)
		destTitle := strOrNil(cleanDest)
		for _, hhmm := range e.Sched {
			at, ok := movSchedTime(hhmm, now)
			if !ok || movTimeClaimed(dirStr, at, claimed) {
				continue
			}
			claimed = append(claimed, movClaimed{dir: dirStr, at: at})
			deps = append(deps, movTheoDep(destTitle, dirStr, at, now))
		}
	}
	return deps, claimed
}

// movStopDepartures is the line view's departures at a stop of a Moventis
// line: live on-demand predictions + scheduled departures (30 s TTL cache),
// filtered to direction ("0", "1", ... or ""/"both"), falling back to the
// background poller's last snapshot.
func movStopDepartures(ctx context.Context, stop rtLineStop, code, direction string, now time.Time) *Obj {
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

			var lineDeps []any
			var claimed []movClaimed
			// 1. Try live on-demand fetch (30 s cache) for real-time + scheduled departures.
			if etas, fetchedAt, ok := movFetchStopLive(ctx, p, snap.Static, id, stopNum, now); ok {
				age := math.Max(0, now.Sub(fetchedAt).Seconds())
				note = "no_tracked_bus"
				liveDeps, liveClaimed := movBuildLiveAndSchedDeps(p, id, stopNum, routes, etas, age, now)
				if len(liveDeps) > 0 {
					note = ""
					lineDeps = append(lineDeps, liveDeps...)
				}
				claimed = append(claimed, liveClaimed...)
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
						dirStr := numToString(float64(movDirectionOf(routes, rt.Trayecto)))
						for _, e := range pr.EtaSec {
							left := e - age
							if left < -movPassedTolSec {
								continue
							}
							left = math.Max(left, 0)
							at := now.Add(time.Duration(left) * time.Second)
							claimed = append(claimed, movClaimed{dir: dirStr, at: at})
							matched, hasMatch, sTime, aIso, dMins, dStatus, dBadge, dSource := movEstimateDelay(p, id, st.ID, dirStr, routes, at, now, nil)
							if hasMatch {
								claimed = append(claimed, movClaimed{dir: dirStr, at: matched})
							}
							lineDeps = append(lineDeps, O(
								"tripId", nil,
								"vehicleId", nil,
								"destination", strOrNil(movCleanDest(rt.Dest, &rt)),
								"direction", dirStr,
								"departureTime", at.In(madrid).Format("15:04"),
								"scheduledTime", sTime,
								"aimedIso", aIso,
								"expectedIso", isoString(at.UnixMilli()),
								"minutesAway", math.Floor(left/60),
								"delayMins", dMins,
								"delayMinutes", dMins,
								"delayStatus", dStatus,
								"delayBadgeText", dBadge,
								"delaySource", dSource,
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
			// departures not already claimed by a live bus (even if late/early).
			if p.sched != nil {
				if byDest := p.sched.lookup(id, stopNum, now); len(byDest) > 0 {
					for dest, hhList := range byDest {
						dirStr, cleanDest := movMatchRoute(routes, dest)
						destTitle := strOrNil(cleanDest)
						for _, hhmm := range hhList {
							at, ok := movSchedTime(hhmm, now)
							if !ok || movTimeClaimed(dirStr, at, claimed) {
								continue
							}
							claimed = append(claimed, movClaimed{dir: dirStr, at: at})
							note = ""
							lineDeps = append(lineDeps, movTheoDep(destTitle, dirStr, at, now))
						}
					}
				}
			}

			lineDeps = movFilterDepsByDir(lineDeps, direction, routes, stopNum)

			// 4. Last-resort fallback: bundled Generalitat timetable so stops
			// never show empty "0 sortides" if moventis.es is throttled/down.
			if len(lineDeps) == 0 {
				if gc := gencatData(); gc != nil {
					times := gc.upcomingDepartures(id, stopNum, now, 120*time.Minute)
					destFallback := ""
					dirFallback := "0"
					for _, rt := range routes {
						dStr := numToString(float64(movDirectionOf(routes, rt.Trayecto)))
						if direction != "" && direction != "both" && dStr != direction {
							continue
						}
						for _, st := range rt.Stops {
							if st.ID == stopNum {
								destFallback = movTitle(rt.Dest)
								dirFallback = dStr
								break
							}
						}
						if destFallback != "" {
							break
						}
					}
					if destFallback != "" {
						for _, at := range times {
							note = ""
							lineDeps = append(lineDeps, movTheoDep(strOrNil(destFallback), dirFallback, at, now))
						}
					}
				}
			}
			// 5. Propagate known upstream live delays to downstream theoretical
			// departures that sit beyond Moventis's ~40-minute real-time horizon.
			movPropagateUpstreamDelay(p, movSnapshotPreds(p, snap), id, stopNum, routes, lineDeps, now)
			deps = append(deps, lineDeps...)
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

const movUpstreamMaxAge = 15 * time.Minute

// movSnapshotPreds returns a copy of the freshest prediction map available:
// p.preds (which includes recent interactive stop clicks recorded by
// movFetchStopLive as well as background poller samples), falling back to
// snap.Preds when p is nil.
func movSnapshotPreds(p *movPoller, snap *movSnapshot) map[[3]int]movPrediction {
	if p != nil {
		p.mu.Lock()
		out := make(map[[3]int]movPrediction, len(p.preds))
		for k, v := range p.preds {
			out[k] = v
		}
		p.mu.Unlock()
		return out
	}
	if snap != nil {
		return snap.Preds
	}
	return nil
}

// movPropagateUpstreamDelay estimates arrival times for downstream theoretical
// departures beyond Moventis's ~40-minute real-time horizon by carrying forward
// the delay of a live tracked bus observed at an upstream stop on the same
// route. Upgraded rows are clearly marked isEstimated:true, isRealTime:false,
// delaySource:"upstream_propagated".
func movPropagateUpstreamDelay(p *movPoller, preds map[[3]int]movPrediction, lineID, stopNum int, routes []movRoute, deps []any, now time.Time) {
	if len(preds) == 0 || len(deps) == 0 {
		return
	}
	speedKmh := movSpeedKmh[lineID]
	if speedKmh <= 0 {
		speedKmh = movDefaultSpeedKmh
	}
	type theoCand struct {
		obj      *Obj
		at       time.Time
		upgraded bool
	}
	for _, rt := range routes {
		targetIdx := -1
		for i, st := range rt.Stops {
			if st.ID == stopNum {
				targetIdx = i
				break
			}
		}
		if targetIdx <= 0 {
			continue
		}
		dirStr := numToString(float64(movDirectionOf(routes, rt.Trayecto)))
		var cands []*theoCand
		for _, raw := range deps {
			o, ok := raw.(*Obj)
			if !ok || !truthy(o.Get("isTheoretical")) || truthy(o.Get("isRealTime")) || jsString(o.Get("direction")) != dirStr {
				continue
			}
			var at time.Time
			if iso := jsString(o.Get("expectedIso")); iso != "" {
				if parsed, err := time.Parse(time.RFC3339Nano, iso); err == nil {
					at = parsed
				}
			}
			if at.IsZero() {
				var okSched bool
				at, okSched = movSchedTime(jsString(o.Get("scheduledTime")), now)
				if !okSched {
					continue
				}
			}
			cands = append(cands, &theoCand{obj: o, at: at})
		}
		if len(cands) == 0 {
			continue
		}
		// Walk upstream stops closest-first so downstream stops inherit the
		// most recent accumulated delay along the route.
		for upIdx := targetIdx - 1; upIdx >= 0; upIdx-- {
			upStop := rt.Stops[upIdx]
			pr, ok := preds[[3]int{lineID, rt.Trayecto, upStop.ID}]
			if !ok || len(pr.EtaSec) == 0 {
				continue
			}
			age := now.Sub(pr.At).Seconds()
			if age < -30 || age > movUpstreamMaxAge.Seconds() {
				continue
			}
			distKm := rt.Stops[targetIdx].Km - upStop.Km
			if distKm < 0 {
				distKm = 0
			}
			estTravelMin := distKm / speedKmh * 60
			minSchedMin := math.Max(0, estTravelMin*0.35-5)
			maxSchedMin := math.Max(12, estTravelMin*2.2+12)

			for _, sec := range pr.EtaSec {
				upLeft := sec - age
				if upLeft < -movPassedTolSec {
					continue
				}
				upAt := now.Add(time.Duration(math.Max(0, upLeft)) * time.Second)
				upSched, hasMatch, _, _, dMinsAny, _, _, _ := movEstimateDelay(p, lineID, upStop.ID, dirStr, routes, upAt, now, nil)
				if !hasMatch {
					continue
				}
				dMin, ok := dMinsAny.(float64)
				if !ok || math.Abs(dMin) < 2 {
					continue
				}
				upDelay := upAt.Sub(upSched)
				var best *theoCand
				bestErr := math.MaxFloat64
				for _, c := range cands {
					if c.upgraded {
						continue
					}
					schedDiffMin := c.at.Sub(upSched).Minutes()
					if schedDiffMin < minSchedMin || schedDiffMin > maxSchedMin {
						continue
					}
					errMin := math.Abs(schedDiffMin - estTravelMin)
					if errMin < bestErr {
						bestErr = errMin
						best = c
					}
				}
				if best == nil {
					continue
				}
				estAt := best.at.Add(upDelay)
				left := math.Max(0, estAt.Sub(now).Seconds())
				propDelayMin := math.Round(estAt.Sub(best.at).Minutes())
				dStatus, dBadge := railDelayLabel(propDelayMin, false)
				best.obj.Set("departureTime", estAt.In(madrid).Format("15:04"))
				best.obj.Set("scheduledTime", best.at.In(madrid).Format("15:04"))
				best.obj.Set("aimedIso", isoString(best.at.UnixMilli()))
				best.obj.Set("expectedIso", isoString(estAt.UnixMilli()))
				best.obj.Set("minutesAway", math.Floor(left/60))
				best.obj.Set("delayMins", propDelayMin)
				best.obj.Set("delayMinutes", propDelayMin)
				best.obj.Set("delayStatus", dStatus)
				best.obj.Set("delayBadgeText", dBadge)
				best.obj.Set("delaySource", "upstream_propagated")
				best.obj.Set("isRealTime", false)
				best.obj.Set("isEstimated", true)
				best.obj.Set("isTheoretical", false)
				best.obj.Set("predictionAgeSec", math.Round(math.Max(0, age)))
				best.upgraded = true
			}
		}
	}
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

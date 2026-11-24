package main

// Port of mataroTracker.js lines 2683-3934: position-based arrival estimates,
// stop departure boards, the per-stop ETA view and the congestion heatmap.

import (
	"log"
	"math"
	"regexp"
	"sort"
	"strings"
)

var (
	reDestSuffixTrail = jsRe(`\s*-\s*\d+\s*$`)
	reDestSuffix      = jsRe(`\s*-\s*\d+$`)
	reSentitPrefix    = jsRe(`^sentit\s+`)
	reOriginNameSplit = regexp.MustCompile(`[\-\(,]`)
	reKeywordSplit    = jsRe(`[\s\-–\(\)/]+`)
)

func stripSecStr(s string) string { return reStripSeconds.ReplaceAllString(s, "$1") }

func formattedMinutes(m float64) string {
	switch m {
	case 0:
		return "Imminent"
	case 1:
		return "1 min"
	}
	return numToString(m) + " min"
}

func (t *MataroTracker) stopIndexIn(route *Obj, sID string) int {
	for i, s := range objList(route.Get("stops")) {
		if jsString(s.Get("id")) == sID {
			return i
		}
	}
	return -1
}

// estimateArrivalsForStop estimates ETAs from live positions along the route.
// ok is false where the source would reject (an unparseable date).
func (t *MataroTracker) estimateArrivalsForStop(stopID, lineID any, existing []any, opts *Obj) ([]any, bool) {
	sID := t.normalizeStopId(stopID)
	cleanLineID := ""
	if truthy(lineID) {
		cleanLineID = t.normalizeLineId(lineID)
	}
	existingIDs := map[string]bool{}
	for _, x := range existing {
		if v := asObj(x).Get("vehicleId"); truthy(v) {
			existingIDs[jsString(v)] = true
		}
	}
	estimated := []any{}

	var targetLineIDs []string
	if cleanLineID != "" {
		targetLineIDs = []string{cleanLineID}
	} else if info := t.stopObj(sID); info != nil {
		for _, l := range objList(info.Get("lineas")) {
			targetLineIDs = append(targetLineIDs, jsString(l.Get("id")))
		}
	}
	if len(targetLineIDs) == 0 {
		for _, l := range t.linesData {
			targetLineIDs = append(targetLineIDs, jsString(l.Get("id")))
		}
	}

	targetMs, ok := optionDate(opts)
	if !ok {
		return nil, false
	}
	now := float64(targetMs)
	net := getNetworkTime(targetMs)
	currentSec := float64(net.Hour*3600 + net.Minute*60 + net.Second)
	dayType := resolveDayType(targetMs).DayType

	for _, lID := range targetLineIDs {
		routes := t.routes(lID)
		if len(routes) == 0 {
			continue
		}
		var live []any
		if d := t.getLineDetails(lID, "both", opts); d != nil {
			if a, ok := d.Get("activeBuses").([]any); ok {
				live = a
			}
		}
		if len(live) == 0 {
			var siriRef *[]any
			if !truthy(opts.Get("skipSiri")) {
				if ref, err := t.w.siri.getLiveVehicles(lID); err == nil && ref != nil {
					siriRef = ref
					live = *ref
					if len(live) > 0 {
						t.stitchAnonymousVehicles(live, lID, routes, now)
					}
				}
			}
			if len(live) == 0 {
				var mataro []any
				for _, x := range t.w.fr.getLineVehicles("L" + lID) {
					v := asObj(x)
					if strings.Contains(jsString(or(v.Get("agency"), "")), "Mataró") || jsString(v.Get("lineId")) == lID {
						mataro = append(mataro, v)
					}
				}
				if len(mataro) > 0 {
					live = mataro
				} else {
					for _, k := range t.vehicleHistory.Keys() {
						hv, _ := t.vehicleHistory.Get(k)
						h := hv.(*Obj)
						if jsString(h.Get("lineId")) == lID && now-jsNumber(h.Get("lastSeen")) <= 600000 {
							live = append(live, O(
								"vehicleId", h.Get("vehicleId"),
								"lineId", h.Get("lineId"),
								"direction", h.Get("direction"),
								"directionName", h.Get("directionName"),
								"origin", h.Get("origin"),
								"destination", h.Get("destination"),
								"lat", h.Get("lat"),
								"lon", h.Get("lon"),
								"bearing", h.Get("bearing"),
								"speedKmh", h.Get("speedKmh"),
								"delayMins", h.Get("delayMins"),
								"isEstimated", true,
								"isRealTime", false,
								"timestamp", h.Get("lastSeen"),
							))
						}
					}
					// The source pushes into the array the SIRI client
					// returned, which is that client's cached array.
					if siriRef != nil && len(live) > 0 {
						*siriRef = live
					}
				}
			}
		}
		if len(live) == 0 {
			continue
		}
		lineInfo := t.lineInfo(lID)
		if lineInfo == nil {
			lineInfo = O("name", "Línia "+lID)
		}

		for routeIdx, route := range routes {
			routeStops := objList(or(route.Get("stops"), []any{}))
			targetIdx := t.stopIndexIn(route, sID)
			if targetIdx == -1 {
				continue
			}
			dirKeyRoute := jsString(or(route.Get("id"), float64(routeIdx)))
			dirSched := getDirectionSchedule(lID, dirKeyRoute, dayType, "")
			routeTravelSec := 1800.0
			lastDepSec := 0.0
			var lastDur float64
			if dirSched != nil {
				routeTravelSec = travelSecOf(dirSched)
				if len(dirSched.Departures) > 0 {
					lastDepSec = timeStringToSeconds(dirSched.Departures[len(dirSched.Departures)-1])
				} else if truthy(dirSched.LastTrip) {
					lastDepSec = timeStringToSeconds(jsString(dirSched.LastTrip))
				}
				if len(dirSched.Trips) > 0 {
					var nn []float64
					for _, x := range dirSched.Trips[len(dirSched.Trips)-1].S {
						if isFinite(x) {
							nn = append(nn, x)
						}
					}
					if len(nn) >= 2 {
						if d := nn[len(nn)-1] - nn[0]; d > 0 {
							lastDur = d
						}
					}
				}
			}
			dur := lastDur
			if dur == 0 {
				dur = routeTravelSec
			}
			if lastDepSec > 0 && currentSec > lastDepSec+dur+900 {
				continue
			}

			target := routeStops[targetIdx]
			coords := t.routeCoords(route)
			targetLat := stopCoord(target, "latitude", "lat")
			targetLon := stopCoord(target, "longitude", "lon")
			hasGeom := len(coords) >= 2
			var targetAlong float64
			if hasGeom {
				start := coords[0]
				tl, to := parseFloatJS(targetLat), parseFloatJS(targetLon)
				if !isFinite(tl) {
					tl = start.Lat
				}
				if !isFinite(to) {
					to = start.Lon
				}
				targetAlong = calculatePolylineDistanceBetween(coords, start.Lat, start.Lon, tl, to)
			}

			for _, x := range live {
				veh := asObj(x)
				if existingIDs[jsString(veh.Get("vehicleId"))] && truthy(veh.Get("vehicleId")) {
					continue
				}
				vehRouteIdx := t.matchVehicleToRouteIndex(veh, routes)
				d := veh.Get("direction")
				same := (!isNullish(d) && jsString(d) == dirKeyRoute) || vehRouteIdx == routeIdx
				if !same {
					continue
				}
				effLat := any(latOf(veh))
				effLon := any(lonOf(veh))
				elapsed := math.Max(0, (now-jsNumber(or(veh.Get("timestamp"), or(veh.Get("lastSeen"), now))))/1000)
				if elapsed > 15 && elapsed <= 600 {
					if est, ok := extrapolatePolylinePosition(normalizeCoordAny(veh), veh.Get("bearing"), elapsed, jsNumber(or(veh.Get("speedKmh"), 25.0)), coords); ok {
						effLat, effLon = est.Lat, est.Lon
					}
				}
				snapped := snapPointToPolyline(ptAny(effLat, effLon), coords)
				near := t.findNearestSegment(snapped.Lat, snapped.Lon, routeStops)
				vehStopIdx := math.Max(0, jsNumber(or(near.Get("fromSeq"), 1.0))-1)
				var remainingMeters, remainingStops float64
				if hasGeom {
					busAlong := calculatePolylineDistanceBetween(coords, coords[0].Lat, coords[0].Lon, snapped.Lat, snapped.Lon)
					remainingMeters = targetAlong - busAlong
					remainingStops = math.Max(0, float64(targetIdx)-vehStopIdx)
				} else {
					remainingStops = math.Max(0, float64(targetIdx)-vehStopIdx)
					if vehStopIdx <= float64(targetIdx) {
						tl, to := jsNumber(effLat), jsNumber(effLon)
						if f, ok := targetLat.(float64); ok && isFinite(f) {
							tl = f
						}
						if f, ok := targetLon.(float64); ok && isFinite(f) {
							to = f
						}
						remainingMeters = calculatePolylineDistanceBetween(coords, snapped.Lat, snapped.Lon, tl, to)
					}
				}
				upstream := vehStopIdx <= float64(targetIdx)
				if hasGeom {
					upstream = remainingMeters > -passedStopToleranceM
				}
				if !upstream {
					continue
				}
				speedMps := math.Max(4.5, jsNumber(or(veh.Get("speedKmh"), 22.0))/3.6)
				transit := jsRound(math.Max(0, remainingMeters)/speedMps) + remainingStops*25
				if vehStopIdx == 0 && (jsNumber(veh.Get("speedKmh")) <= 5 || truthy(veh.Get("isTerminalLayover"))) {
					if dirSched != nil && dirSched.Departures != nil {
						for _, tr := range dirSched.Departures {
							if timeStringToSeconds(tr) >= currentSec-60 {
								wait := math.Max(0, timeStringToSeconds(tr)-currentSec)
								transit = math.Max(transit, wait+transit)
								break
							}
						}
					}
				}
				minutesAway := math.Max(0, jsRound(transit/60))
				if !(minutesAway <= 45) {
					continue
				}
				arrMs := int64(now + minutesAway*60000)
				dm := veh.Get("delayMins")
				isDelayed := !isNullish(dm) && jsNumber(dm) >= 2
				var badge string
				switch {
				case isDelayed:
					badge = "+" + numToString(jsNumber(dm)) + " min retard"
				case truthy(veh.Get("isEstimated")):
					badge = jsString(or(veh.Get("delayBadgeText"), "⚡ En ruta (Estimat)"))
				case jsNumber(dm) > 0:
					badge = "+" + jsString(dm) + " min retard"
				default:
					badge = "⚡ En ruta (Bus #" + jsString(veh.Get("vehicleId")) + ")"
				}
				var rawDest any
				if len(routeStops) > 0 {
					rawDest = routeStops[len(routeStops)-1].Get("name")
				}
				rawDest = or(rawDest, route.Get("name"))
				dest := jsTrim(reDestSuffixTrail.ReplaceAllLiteralString(jsTrim(jsString(or(rawDest, ""))), ""))
				var delayV any
				if numberIsFinite(dm) {
					delayV = dm
				}
				status := "estimated"
				if isDelayed {
					status = "delayed"
				}
				iso := isoString(arrMs)
				estimated = append(estimated, O(
					"lineId", lID,
					"lineName", lineInfo.Get("name"),
					"directionId", dirKeyRoute,
					"directionName", route.Get("name"),
					"destination", dest,
					"vehicleId", veh.Get("vehicleId"),
					"distanceFromStop", numToString(jsRound(remainingMeters))+"m",
					"departureTime", formatTimeToTimezone(arrMs, true),
					"expectedIso", iso,
					"aimedIso", iso,
					"minutesAway", minutesAway,
					"formattedStatus", formattedMinutes(minutesAway),
					"delayMins", delayV,
					"delayBadgeText", badge,
					"delayStatus", status,
					"isRealTime", false,
					"isEstimated", true,
					"freshness", O("source", "position", "fetchedAt", now, "observedAt", or(objGet(veh.Get("freshness"), "observedAt"), nil)),
					"isUpstreamDirect", true,
					"busCoords", O("lat", effLat, "lon", effLon),
				))
				existingIDs[jsString(veh.Get("vehicleId"))] = true
			}
		}
	}
	return estimated, true
}

// findRoutesServingStop lists the route variants that visit a stop.
func (t *MataroTracker) findRoutesServingStop(stopID, lineID any) []*Obj {
	sID := t.normalizeStopId(stopID)
	clean := ""
	if truthy(lineID) {
		clean = t.normalizeLineId(lineID)
	}
	var results []*Obj
	lines := []string{clean}
	if clean == "" {
		lines = t.routesData.Keys()
	}
	nameOf := func(lID string) string {
		if li := t.lineInfo(lID); li != nil {
			return jsTrim(jsString(li.Get("name")))
		}
		return "Línia " + lID
	}
	for _, lID := range lines {
		for _, r := range t.routes(lID) {
			if t.stopIndexIn(r, sID) >= 0 {
				c := r.Clone()
				c.Set("id_linea", lID)
				c.Set("lineName", nameOf(lID))
				results = append(results, c)
			}
		}
	}
	if len(results) == 0 && clean != "" && t.routesData.Has(clean) && truthy(t.routesData.Get(clean)) {
		if rs := t.routes(clean); len(rs) > 0 && rs[0] != nil {
			c := rs[0].Clone()
			c.Set("id_linea", clean)
			c.Set("lineName", nameOf(clean))
			results = append(results, c)
		}
	}
	return results
}

func (t *MataroTracker) travelTimeFallback(stops any, sID string) float64 {
	tt := estimateStopTravelTimes(objList(stops), O("speedMps", 4.8, "dwellSecPerStop", 25.0, "defaultSegmentMeters", 300.0))
	return getTravelTimeToStop(tt, sID)
}

func dateKeyOf(v any) string {
	if d, ok := v.(JSDate); ok {
		return "D" + numToString(d.Ms)
	}
	return jsString(v)
}

// getStopDepartures builds a stop's board: live SIRI, position estimates,
// terminal regulation and the day's timetable. nil where the source rejects.
func (t *MataroTracker) getStopDepartures(stopID, lineID, direction any, opts *Obj) *Obj {
	direction, opts, _ = directionAsOptions(direction, opts)
	if opts == nil {
		opts = O()
	}
	if isUndef(lineID) {
		lineID = ""
	}
	sID := t.normalizeStopId(stopID)
	cleanLineID := ""
	if truthy(lineID) {
		cleanLineID = t.normalizeLineId(lineID)
	}
	dirKeyArg := jsString(or(direction, "0"))
	limitKey := jsString(or(opts.Get("limit"), 10.0))
	dateKey := ""
	if truthy(opts.Get("targetDate")) || truthy(opts.Get("dateObj")) {
		dateKey = dateKeyOf(or(opts.Get("targetDate"), opts.Get("dateObj")))
	}
	cacheKey := sID + "_" + cleanLineID + "_" + dirKeyArg + "_" + limitKey + "_" + dateKey

	if !truthy(opts.Get("skipCache")) {
		if cv, ok := t.stopDeparturesMemoryCache.Get(cacheKey); ok {
			c := cv.(*stopDepCacheEntry)
			if float64(nowMs())-c.timestamp < t.stopCacheTtlMs {
				return c.data
			}
		}
	}

	stopInfo := t.stopObj(sID)
	knownStop := stopInfo != nil
	if !knownStop {
		stopInfo = O("id", sID, "name", "Parada "+sID)
	}

	liveArrivals := []any{}
	if knownStop && !truthy(opts.Get("skipSiri")) {
		arr, err := t.w.siri.getStopArrivals(sID, cleanLineID)
		if err != nil {
			log.Printf("[getStopDepartures] SIRI query error for stop %s: %s", sID, err.Error())
		} else if arr != nil {
			liveArrivals = arr
		}
	}
	estimated, ok := t.estimateArrivalsForStop(sID, cleanLineID, liveArrivals, opts)
	if !ok {
		log.Printf("[getStopDepartures] Circuit estimation error for stop %s: Invalid time value", sID)
		estimated = []any{}
	}

	var sorted []*Obj
	for _, x := range append(append([]any{}, liveArrivals...), estimated...) {
		d := asObj(x)
		ma := d.Get("minutesAway")
		if isNullish(ma) || jsNumber(ma) > 120 {
			continue
		}
		dt := d.Get("departureTime")
		if !truthy(dt) || dt == "--:--" {
			continue
		}
		if truthy(d.Get("isRealTime")) && dt == "00:00" && strictEq(ma, 0.0) {
			ei := d.Get("expectedIso")
			es := jsString(ei)
			if !truthy(ei) || strings.HasPrefix(es, "0001-") || strings.HasPrefix(es, "1970-") {
				continue
			}
		}
		sorted = append(sorted, d)
	}
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Num("minutesAway") < sorted[j].Num("minutesAway") })

	cleanStopName := jsTrim(jsLower(jsString(or(stopInfo.Get("name"), ""))))
	routesForStop := t.findRoutesServingStop(sID, lineID)

	targetMs, ok := optionDate(opts)
	if !ok {
		return nil
	}
	dayToday := resolveDayType(targetMs).DayType
	dayTomorrow := resolveDayType(targetMs + 24*3600*1000).DayType
	nowSecOf := func() float64 {
		n := getNetworkTime(targetMs)
		return float64(n.Hour*3600 + n.Minute*60 + n.Second)
	}
	lastStopOf := func(r *Obj) *Obj {
		st := objList(r.Get("stops"))
		if len(st) == 0 {
			return nil
		}
		return st[len(st)-1]
	}

	var filtered []*Obj
	for _, dep := range sorted {
		var vID string
		hasVID := truthy(dep.Get("vehicleId"))
		if hasVID {
			vID = jsTrim(jsString(dep.Get("vehicleId")))
		}
		destName := jsTrim(jsLower(jsString(or(dep.Get("destination"), ""))))
		isLast := false
		for _, r := range routesForStop {
			st := objList(r.Get("stops"))
			if jsString(r.Get("id_linea")) != jsString(dep.Get("lineId")) || len(st) <= 1 || jsString(st[len(st)-1].Get("id")) != sID {
				continue
			}
			lastName := jsLower(jsString(or(st[len(st)-1].Get("name"), "")))
			if jsString(r.Get("id")) == jsString(dep.Get("directionId")) || jsLower(jsString(or(r.Get("name"), ""))) == destName || strings.Contains(destName, lastName) {
				isLast = true
				break
			}
		}
		terminating := isLast || (destName != "" && (destName == cleanStopName || strings.HasPrefix(cleanStopName, destName) ||
			strings.Contains(cleanStopName, destName) || strings.Contains(destName, cleanStopName)))

		if terminating {
			var outbound *Obj
			for _, r := range routesForStop {
				if jsString(r.Get("id_linea")) == jsString(dep.Get("lineId")) && t.stopIndexIn(r, sID) == 0 {
					outbound = r
					break
				}
			}
			if outbound != nil {
				arrTime := jsString(or(dep.Get("departureTime"), formatTimeToTimezone(nowMs(), true)))
				dk := jsString(or(outbound.Get("id"), "0"))
				dirSched := getDirectionSchedule(jsString(dep.Get("lineId")), dk, dayToday, "")
				nextDep := arrTime
				var schedDep any
				delay := 0.0
				if dirSched != nil && dirSched.Departures != nil {
					arrSec := timeStringToSeconds(arrTime)
					var secs []float64
					for _, s := range dirSched.Departures {
						if v := timeStringToSeconds(s); isFinite(v) {
							secs = append(secs, v)
						}
					}
					sort.Float64s(secs)
					headway := 0.0
					for i := 1; i < len(secs); i++ {
						headway = math.Max(headway, secs[i]-secs[i-1])
					}
					if !(headway > 0) {
						headway = 30 * 60
					}
					maxFwd := headway + 300
					for _, s := range dirSched.Departures {
						sec := timeStringToSeconds(s)
						if !isFinite(sec) || sec < arrSec-300 {
							continue
						}
						if sec-arrSec <= maxFwd {
							schedDep = s
							break
						}
					}
					if schedDep != nil {
						schedSec := timeStringToSeconds(schedDep.(string))
						if arrSec > schedSec {
							minDep := arrSec + 60
							nextDep = minutesToTimeString(jsRound(minDep / 60))
							delay = jsRound((minDep - schedSec) / 60)
						} else {
							nextDep = schedDep.(string)
							delay = 0
						}
					}
				}
				cleanArr := stripSecStr(arrTime)
				cleanDep := stripSecStr(nextDep)
				cleanSched := cleanDep
				if schedDep != nil {
					cleanSched = stripSecStr(schedDep.(string))
				}
				dep.Set("destination", outbound.Get("name"))
				dep.Set("directionId", jsString(or(outbound.Get("id"), "0")))
				dep.Set("arrivalTime", cleanArr)
				dep.Set("departureTime", cleanDep)
				dep.Set("scheduledTime", cleanSched)
				dep.Set("scheduledDepartureTime", cleanSched)
				dep.Set("delayMins", delay)
				dep.Set("delayMinutes", delay)
				dep.Set("isRegulating", true)
				if delay >= 2 {
					dep.Set("delayStatus", "delayed")
					dep.Set("delayBadgeText", "+"+numToString(delay)+" min retard")
				} else {
					dep.Set("delayStatus", "regulating")
					dep.Set("delayBadgeText", "⏱️ Regulació")
				}
				arrSecVal := timeStringToSeconds(cleanArr)
				depSecVal := timeStringToSeconds(cleanDep)
				delta := math.Max(0, jsRound((depSecVal-arrSecVal)/60))
				ma := jsNumber(or(dep.Get("minutesAway"), 0.0))
				dep.Set("arrivalMinutesAway", math.Max(0, ma))
				dep.Set("minutesAway", math.Max(0, ma+delta))
				dep.Set("departureMinutesAway", dep.Get("minutesAway"))
				if dep.Num("arrivalMinutesAway") <= 0 {
					dep.Set("formattedStatus", "En regulació")
				} else {
					dep.Set("formattedStatus", numToString(dep.Num("minutesAway"))+" min")
				}
				if timeStringToSeconds(cleanArr) < timeStringToSeconds(cleanDep) {
					dep.Set("statusText", "🅿️ Regulant (Arribada: "+cleanArr+" • Sortida: "+cleanDep+")")
				} else {
					dep.Set("statusText", "🅿️ Regulant a capçalera (Sortida: "+cleanDep+")")
				}
			}
		} else {
			cleanDest := jsTrim(reDestSuffix.ReplaceAllLiteralString(reSentitPrefix.ReplaceAllLiteralString(destName, ""), ""))
			var matching *Obj
			for _, r := range routesForStop {
				if jsString(r.Get("id_linea")) != jsString(dep.Get("lineId")) {
					continue
				}
				if di := dep.Get("directionId"); !isNullish(di) && jsString(r.Get("id")) == jsString(di) {
					matching = r
					break
				}
				rName := jsLower(jsString(or(r.Get("name"), "")))
				termName := ""
				if ls := lastStopOf(r); ls != nil {
					termName = jsTrim(reDestSuffix.ReplaceAllLiteralString(jsLower(jsString(or(ls.Get("name"), ""))), ""))
				}
				if strings.Contains(termName, cleanDest) || strings.Contains(cleanDest, termName) || strings.HasSuffix(rName, cleanDest) ||
					strings.Contains(rName, "- "+cleanDest) || rName == cleanDest {
					matching = r
					break
				}
			}
			if matching == nil {
				for _, r := range routesForStop {
					if jsString(r.Get("id_linea")) == jsString(dep.Get("lineId")) {
						matching = r
						break
					}
				}
			}
			mStops, isArr := matching.Get("stops").([]any)
			if matching != nil && isArr && len(mStops) > 1 {
				stopIdx := t.stopIndexIn(matching, sID)
				if stopIdx > 0 {
					t.applyOriginRegulation(dep, matching, sID, dayToday, targetMs, hasVID, vID, nowSecOf)
				}
			}
		}

		if hasVID {
			idx := -1
			for i, x := range filtered {
				if truthy(x.Get("vehicleId")) && jsTrim(jsString(x.Get("vehicleId"))) == vID &&
					math.Abs(x.Num("minutesAway")-dep.Num("minutesAway")) <= 7 {
					idx = i
					break
				}
			}
			if idx != -1 {
				ex := filtered[idx]
				exDest := jsTrim(jsLower(jsString(or(ex.Get("destination"), ""))))
				exTerm := exDest != "" && (exDest == cleanStopName || strings.HasPrefix(cleanStopName, exDest))
				if exTerm && !terminating {
					filtered[idx] = dep
				} else if truthy(ex.Get("isEstimated")) && truthy(dep.Get("isRealTime")) {
					filtered[idx] = dep
				}
				continue
			}
		}
		idx := -1
		for i, x := range filtered {
			if jsString(x.Get("lineId")) == jsString(dep.Get("lineId")) &&
				jsTrim(jsLower(jsString(or(x.Get("destination"), "")))) == destName &&
				math.Abs(x.Num("minutesAway")-dep.Num("minutesAway")) <= 3 {
				idx = i
				break
			}
		}
		if idx != -1 {
			if truthy(filtered[idx].Get("isEstimated")) && truthy(dep.Get("isRealTime")) {
				filtered[idx] = dep
			}
			continue
		}
		filtered = append(filtered, dep)
	}

	if !truthy(opts.Get("isDownstreamCheck")) {
		for _, r := range routesForStop {
			stopIdx := t.stopIndexIn(r, sID)
			if stopIdx <= 0 {
				continue
			}
			rStops := objList(r.Get("stops"))
			originStop := rStops[0]
			if originStop == nil {
				continue
			}
			lIDStr := jsString(or(r.Get("id_linea"), or(lineID, "1")))
			dk := jsString(or(r.Get("id"), "0"))
			sub := opts.Clone()
			sub.Set("isDownstreamCheck", true)
			board := t.getStopDepartures(jsString(originStop.Get("id")), lIDStr, dk, sub)
			if board == nil {
				continue
			}
			deps, isArr := board.Get("departures").([]any)
			if !isArr {
				continue
			}
			stopTravelSec := getStopTravelTime(lIDStr, dk, sID, dayToday, "")
			if stopTravelSec <= 0 && len(rStops) > 0 {
				stopTravelSec = t.travelTimeFallback(r.Get("stops"), sID)
			}
			cur := nowSecOf()
			originName := jsTrim(reOriginNameSplit.Split(jsString(or(originStop.Get("name"), "Capçalera")), -1)[0])
			for _, x := range deps {
				od := asObj(x)
				if jsString(od.Get("lineId")) != lIDStr {
					continue
				}
				matchDir := jsString(od.Get("directionId")) == dk ||
					(truthy(od.Get("destination")) && truthy(r.Get("name")) &&
						strings.Contains(jsLower(jsString(od.Get("destination"))), jsLower(jsString(r.Get("name")))))
				if !matchDir {
					continue
				}
				if !truthy(od.Get("isRegulating")) && !truthy(od.Get("isRealTime")) && !truthy(od.Get("isEstimated")) {
					continue
				}
				if truthy(od.Get("vehicleId")) {
					ov := jsTrim(jsString(od.Get("vehicleId")))
					has := false
					for _, d := range filtered {
						if truthy(d.Get("vehicleId")) && jsTrim(jsString(d.Get("vehicleId"))) == ov {
							has = true
							break
						}
					}
					if has {
						continue
					}
				}
				odDepTime := jsString(od.Get("departureTime"))
				origDepSec := timeStringToSeconds(odDepTime)
				until := origDepSec - cur
				if until > 600 || until < -300 {
					continue
				}
				origClock := jsSlice(jsString(or(od.Get("scheduledTime"), or(od.Get("departureTime"), ""))), 0, 5)
				perTrip, hasPerTrip := getTripStopTime(lIDStr, dk, origClock, sID, dayToday, "")
				schedDepSec := origDepSec
				if truthy(od.Get("scheduledTime")) {
					schedDepSec = timeStringToSeconds(jsString(od.Get("scheduledTime")))
				}
				var schedPass, estPass float64
				if hasPerTrip {
					schedPass = perTrip
					estPass = origDepSec + (perTrip - schedDepSec)
				} else {
					if ds := getDirectionSchedule(lIDStr, dk, dayToday, ""); ds != nil && len(ds.Trips) > 0 {
						continue
					}
					schedPass = schedDepSec + stopTravelSec
					estPass = origDepSec + stopTravelSec
				}
				mins := math.Max(0, jsRound((estPass-cur)/60))
				if cur > estPass+90 {
					continue
				}
				if mins > 90 {
					continue
				}
				fDep := minutesToTimeString(jsRound(estPass / 60))
				fSched := minutesToTimeString(jsRound(schedPass / 60))
				var delay any
				if !od.IsUndef("delayMins") {
					delay = od.Get("delayMins")
				} else {
					delay = math.Max(0, jsRound((estPass-schedPass)/60))
				}
				status, badge := "regulating", "⏱️ Regulant a "+originName
				if jsNumber(delay) >= 2 {
					status, badge = "delayed", "+"+jsString(delay)+" min retard"
				}
				iso := isoString(targetMs + int64(mins*60000))
				var dest any
				if ls := lastStopOf(r); ls != nil && truthy(ls.Get("name")) {
					dest = jsTrim(reDestSuffix.ReplaceAllLiteralString(jsString(ls.Get("name")), ""))
				} else {
					dest = or(r.Get("name"), od.Get("destination"))
				}
				c := od.Clone()
				c.Set("destination", dest)
				c.Set("directionId", dk)
				c.Set("departureTime", fDep)
				c.Set("time", fDep)
				c.Set("scheduledTime", fSched)
				c.Set("scheduledDepartureTime", fSched)
				c.Set("departureDate", iso)
				c.Set("expectedIso", iso)
				c.Set("aimedIso", iso)
				c.Set("minutesAway", mins)
				c.Set("departureMinutesAway", mins)
				c.Set("arrivalMinutesAway", nil)
				c.Set("formattedStatus", formattedMinutes(mins))
				c.Set("delayMins", delay)
				c.Set("delayMinutes", delay)
				c.Set("delayStatus", status)
				c.Set("delayBadgeText", badge)
				c.Set("isRegulating", true)
				c.Set("isOriginRegulating", true)
				c.Set("originTerminalName", originName)
				c.Set("originDepartureTime", od.Get("departureTime"))
				c.Set("statusText", "⏱️ Regulant a "+originName+" (sortida: "+jsString(od.Get("departureTime"))+")")
				c.Set("comparisonText", "Horari teòric: "+fSched+" • Regulant a "+originName+" (sortida: "+jsString(od.Get("departureTime"))+")")
				filtered = append(filtered, c)
			}
		}
	}

	var all []*Obj
	assigned := map[string]bool{}
	for _, r := range routesForStop {
		lIDStr := jsString(or(r.Get("id_linea"), or(lineID, "1")))
		dk := jsString(or(r.Get("id"), "0"))
		stopIdx := t.stopIndexIn(r, sID)
		nStops := jsNumber(objGet(r.Get("stops"), "length"))
		isTerminus := float64(stopIdx) == nStops-1 && nStops > 1
		isOrigin := stopIdx == 0
		if isTerminus && !isOrigin {
			continue
		}
		schedToday := getDirectionSchedule(lIDStr, dk, dayToday, "")
		schedTomorrow := getDirectionSchedule(lIDStr, dk, dayTomorrow, "")
		stopTravelSec := getStopTravelTime(lIDStr, dk, sID, dayToday, "")
		if stopTravelSec == 0 && nStops > 0 {
			stopTravelSec = t.travelTimeFallback(r.Get("stops"), sID)
		}
		depsToday := getDeparturesForStop(lIDStr, dk, sID, dayToday, "")
		depsTomorrow := getDeparturesForStop(lIDStr, dk, sID, dayTomorrow, "")
		hasPerTrip := len(depsToday) > 0 || (schedToday != nil && len(schedToday.Trips) > 0)

		rNameLower := jsLower(jsString(or(r.Get("name"), "")))
		keywords := func(s string) []string {
			var out []string
			for _, k := range reKeywordSplit.Split(s, -1) {
				if utf16Count(k) > 3 {
					out = append(out, k)
				}
			}
			return out
		}
		liveForRoute := []any{}
		for _, d := range filtered {
			if jsString(d.Get("lineId")) != lIDStr {
				continue
			}
			destLower := jsLower(jsString(or(d.Get("destination"), "")))
			liveKey := "time_" + jsString(d.Get("departureTime"))
			if truthy(d.Get("vehicleId")) {
				liveKey = "veh_" + jsString(d.Get("vehicleId"))
			}
			if assigned[liveKey] {
				continue
			}
			if truthy(d.Get("isRegulating")) && truthy(d.Get("directionId")) && d.Get("directionId") == dk {
				assigned[liveKey] = true
				liveForRoute = append(liveForRoute, d)
				continue
			}
			if len(routesForStop) > 1 {
				affinity := false
				for _, k := range keywords(rNameLower) {
					if strings.Contains(destLower, k) {
						affinity = true
						break
					}
				}
				if !affinity {
					for _, k := range keywords(destLower) {
						if strings.Contains(rNameLower, k) {
							affinity = true
							break
						}
					}
				}
				better := false
				for _, o := range routesForStop {
					if strictEq(o.Get("id"), r.Get("id")) {
						continue
					}
					for _, k := range reKeywordSplit.Split(jsLower(jsString(o.Get("name"))), -1) {
						if utf16Count(k) > 3 && strings.Contains(destLower, k) {
							better = true
							break
						}
					}
					if better {
						break
					}
				}
				if !affinity && better {
					continue
				}
			}
			assigned[liveKey] = true
			liveForRoute = append(liveForRoute, d)
		}

		var baseToday, baseTomorrow any = []any{}, []any{}
		var stopDepsTodayV, stopDepsTomorrowV any = Undefined, Undefined
		travelOpt := stopTravelSec
		if hasPerTrip {
			baseToday, baseTomorrow = depsToday, depsTomorrow
			stopDepsTodayV, stopDepsTomorrowV = depsToday, depsTomorrow
			travelOpt = 0
		} else {
			if schedToday != nil {
				baseToday = schedToday.Departures
			}
			if schedTomorrow != nil {
				baseTomorrow = schedTomorrow.Departures
			}
		}
		limit, minBefore, maxMorning := 10.0, 5.0, 10.0
		if !opts.IsUndef("limit") {
			limit = jsNumber(opts.Get("limit"))
		}
		if !opts.IsUndef("minCountBeforeMorning") {
			minBefore = jsNumber(opts.Get("minCountBeforeMorning"))
		}
		if !opts.IsUndef("maxMorningCount") {
			maxMorning = jsNumber(opts.Get("maxMorningCount"))
		}
		destination := or(r.Get("name"), "Línia "+lIDStr)
		if !truthy(r.Get("name")) && schedToday != nil && schedToday.DirectionName != "" {
			destination = schedToday.DirectionName
		}
		compiled := compileStopDepartures(O(
			"baseDeparturesToday", baseToday,
			"baseDeparturesTomorrow", baseTomorrow,
			"stopDeparturesToday", stopDepsTodayV,
			"stopDeparturesTomorrow", stopDepsTomorrowV,
			"stopTravelSec", travelOpt,
			"liveDepartures", liveForRoute,
			"limit", limit,
			"minCountBeforeMorning", minBefore,
			"maxMorningCount", maxMorning,
			"duplicateWindowMinutes", 8.0,
			"dateObj", JSDate{float64(targetMs)},
			"timezone", t.agencyTimezone,
			"lineId", lIDStr,
			"lineCode", lIDStr,
			"lineName", or(r.Get("lineName"), "Línia "+lIDStr),
			"destination", destination,
			"directionId", dk,
			"isTrain", false,
		))

		if isOrigin {
			var incoming *Obj
			for _, o := range routesForStop {
				st := objList(o.Get("stops"))
				if jsString(o.Get("id_linea")) == lIDStr && jsString(o.Get("id")) != dk && len(st) > 1 && jsString(st[len(st)-1].Get("id")) == sID {
					incoming = o
					break
				}
			}
			if incoming != nil {
				inSched := getDirectionSchedule(lIDStr, jsString(incoming.Get("id")), dayToday, "")
				cur := nowSecOf()
				if inSched != nil && inSched.Departures != nil && (inSched.TotalTravelSec > 0 || len(inSched.Trips) > 0) {
					inTravel := inSched.TotalTravelSec
					if math.IsNaN(inTravel) {
						inTravel = 0
					}
					termIdx := len(inSched.Stops) - 1
					for _, cd := range compiled {
						dt := cd.Get("departureTime")
						if truthy(cd.Get("arrivalTime")) || !truthy(dt) || dt == "--:--" {
							continue
						}
						depSecVal := timeStringToSeconds(jsString(dt))
						if !(depSecVal > 0) {
							continue
						}
						var bestArrTime string
						found := false
						for ti, tm := range inSched.Departures {
							aSec := math.NaN()
							hasA := false
							if inSched.Trips != nil && ti < len(inSched.Trips) && termIdx >= 0 && termIdx < len(inSched.Trips[ti].S) {
								if s := inSched.Trips[ti].S[termIdx]; isFinite(s) {
									aSec, hasA = s, true
								}
							}
							if !hasA {
								aSec = timeStringToSeconds(tm) + inTravel
							}
							if aSec <= depSecVal+60 && aSec >= depSecVal-1800 {
								bestArrTime = minutesToTimeString(jsRound(aSec / 60))
								found = true
							}
						}
						if !found {
							continue
						}
						cleanIn := stripSecStr(bestArrTime)
						inArrSec := timeStringToSeconds(cleanIn)
						if cur >= inArrSec-300 && cur <= depSecVal+180 {
							cd.Set("arrivalTime", cleanIn)
							cd.Set("isRegulating", true)
							cd.Set("isTerminalLayover", true)
							if cd.Get("delayStatus") == "scheduled" {
								cd.Set("delayStatus", "regulating")
								cd.Set("delayBadgeText", "⏱️ Regulació")
							}
							cd.Set("arrivalMinutesAway", jsRound((inArrSec-cur)/60))
							cd.Set("departureMinutesAway", cd.Get("minutesAway"))
							if cur >= inArrSec {
								cd.Set("statusText", "🅿️ A la parada (Sortida: "+jsString(dt)+")")
							} else {
								cd.Set("statusText", "🅿️ Regulant (Arribada: "+cleanIn+" • Sortida: "+jsString(dt)+")")
							}
						}
					}
				}
			}
		}
		all = append(all, compiled...)
	}

	if len(all) == 0 && len(filtered) > 0 {
		for _, d := range filtered {
			all = append(all, standardizeDeparture(d, nil))
		}
	}
	sort.SliceStable(all, func(i, j int) bool {
		a, b := all[i], all[j]
		if !strictEq(a.Get("isToday"), b.Get("isToday")) {
			return truthy(a.Get("isToday")) && !truthy(b.Get("isToday")) || (truthy(a.Get("isToday")) && truthy(b.Get("isToday")))
		}
		return jsNumber(or(a.Get("minutesAway"), 0.0)) < jsNumber(or(b.Get("minutesAway"), 0.0))
	})

	seenKeys := map[string]bool{}
	seenVeh := map[string]bool{}
	final := []any{}
	for _, d := range all {
		if truthy(d.Get("vehicleId")) {
			v := jsTrim(jsString(d.Get("vehicleId")))
			if seenVeh[v] {
				continue
			}
			seenVeh[v] = true
		}
		key := jsString(d.Get("lineId")) + "_" + jsString(d.Get("departureTime")) + "_" + jsString(d.Get("isToday"))
		if !seenKeys[key] {
			seenKeys[key] = true
			final = append(final, d)
		}
	}

	result := O(
		"stop", O("id", sID, "name", stopInfo.Get("name"), "lat", stopInfo.Get("lat"), "lon", stopInfo.Get("lon"), "zone", "Mataró Urbà"),
		"departures", final,
		"totalDepartures", float64(len(final)),
	)
	if knownStop {
		t.stopDeparturesMemoryCache.Set(cacheKey, &stopDepCacheEntry{timestamp: float64(nowMs()), data: result})
		if t.stopDeparturesMemoryCache.Len() > 200 {
			now := float64(nowMs())
			for _, k := range t.stopDeparturesMemoryCache.Keys() {
				v, _ := t.stopDeparturesMemoryCache.Get(k)
				if now-v.(*stopDepCacheEntry).timestamp > 60000 {
					t.stopDeparturesMemoryCache.Delete(k)
				}
			}
			for t.stopDeparturesMemoryCache.Len() > 256 {
				t.stopDeparturesMemoryCache.Delete(t.stopDeparturesMemoryCache.Keys()[0])
			}
		}
	}
	return result
}

// applyOriginRegulation marks a downstream departure whose bus is still
// regulating at the origin terminal (the source's "Downstream Stop Handling").
func (t *MataroTracker) applyOriginRegulation(dep, matching *Obj, sID, dayToday string, targetMs int64, hasVID bool, vID string, nowSecOf func() float64) {
	mStops := objList(matching.Get("stops"))
	originStop := mStops[0]
	originName := jsTrim(reOriginNameSplit.Split(jsString(or(originStop.Get("name"), "Capçalera")), -1)[0])
	lIDStr := jsString(dep.Get("lineId"))
	dk := jsString(or(matching.Get("id"), "0"))

	stopTravelSec := getStopTravelTime(lIDStr, dk, sID, dayToday, "")
	if stopTravelSec <= 0 {
		stopTravelSec = t.travelTimeFallback(matching.Get("stops"), sID)
	}
	rawAimed := or(dep.Get("scheduledTime"), nil)
	if !truthy(rawAimed) {
		if ai, ok := dep.Get("aimedIso").(string); ok && ai != "" {
			if strings.Contains(ai, "T") && !strings.HasPrefix(ai, "0001-") && !strings.HasPrefix(ai, "1970-") {
				ms, ok := parseDateJS(ai)
				if f := formatTimeToTimezone(ms, ok); f != "" && f != "--:--" {
					rawAimed = f
				}
			}
		}
	}
	if !truthy(rawAimed) {
		rawAimed = dep.Get("departureTime")
	}
	aimedClean := ""
	hasAimed := truthy(rawAimed)
	if hasAimed {
		aimedClean = stripSecStr(jsString(rawAimed))
	}

	dirSched := getDirectionSchedule(lIDStr, dk, dayToday, "")
	originDepTime := ""
	originDepSec := math.NaN() // NaN = null

	trips := getTripsServingStop(lIDStr, dk, sID, dayToday, "")
	if hasAimed && len(trips) > 0 {
		aimedSec := timeStringToSeconds(aimedClean)
		best := -1
		minDiff := math.Inf(1)
		for i, tr := range trips {
			diff := math.Abs(math.Mod(tr.StopSec, 86400) - math.Mod(aimedSec, 86400))
			if diff < minDiff {
				minDiff = diff
				best = i
			}
		}
		if best >= 0 && minDiff <= 600 && !math.IsNaN(trips[best].OriginSec) {
			originDepSec = trips[best].OriginSec
			originDepTime = jsSlice(secondsToTimeString(math.Mod(trips[best].OriginSec, 86400)), 0, 5)
			stopTravelSec = trips[best].StopSec - trips[best].OriginSec
		}
	}
	if originDepTime == "" && hasAimed && dirSched != nil && len(dirSched.Departures) > 0 {
		aimedSec := timeStringToSeconds(aimedClean)
		est := aimedSec - stopTravelSec
		bestTrip := ""
		minDiff := math.Inf(1)
		for _, tr := range dirSched.Departures {
			if diff := math.Abs(timeStringToSeconds(tr) - est); diff < minDiff {
				minDiff = diff
				bestTrip = tr
			}
		}
		if bestTrip != "" && minDiff <= 600 {
			originDepTime = bestTrip
			originDepSec = timeStringToSeconds(bestTrip)
		}
	}

	cur := nowSecOf()
	distToOrigin := math.Inf(1)
	vLat := or(objGet(dep.Get("busCoords"), "lat"), or(dep.Get("latitude"), dep.Get("lat")))
	vLon := or(objGet(dep.Get("busCoords"), "lon"), or(dep.Get("longitude"), dep.Get("lon")))
	oLat := or(originStop.Get("latitude"), originStop.Get("lat"))
	oLon := or(originStop.Get("longitude"), originStop.Get("lon"))
	if truthy(vLat) && truthy(vLon) && truthy(oLat) && truthy(oLon) {
		distToOrigin = distAny(vLat, vLon, oLat, oLon)
	} else if hasVID {
		if hv, ok := t.vehicleHistory.Get(vID); ok {
			h := hv.(*Obj)
			age := math.Inf(1)
			if truthy(h.Get("timestamp")) {
				age = float64(targetMs) - jsNumber(h.Get("timestamp"))
			}
			if age <= 90000 && truthy(oLat) && truthy(oLon) {
				distToOrigin = distAny(or(h.Get("lat"), h.Get("latitude")), or(h.Get("lon"), h.Get("longitude")), oLat, oLon)
			}
		}
	}
	var vehSpeed any
	if !dep.IsUndef("speedKmh") {
		vehSpeed = dep.Get("speedKmh")
	} else if !hasVID {
		vehSpeed = nil
	} else if hv, ok := t.vehicleHistory.Get(vID); ok {
		vehSpeed = hv.(*Obj).Get("speedKmh")
	} else {
		vehSpeed = Undefined
	}
	atOrigin := distToOrigin <= 350 && (isUndef(vehSpeed) || jsNumber(vehSpeed) <= 10 || truthy(dep.Get("isTerminalLayover")))

	until := math.Inf(1)
	if !math.IsNaN(originDepSec) {
		until = originDepSec - cur
	}
	regulating := false
	if until <= 600 && until >= 0 {
		if !math.IsInf(distToOrigin, 1) {
			regulating = atOrigin || distToOrigin <= 400
		} else {
			regulating = true
		}
	} else if until < 0 && until >= -300 {
		regulating = atOrigin
	}
	if !regulating {
		return
	}
	dep.Set("isRegulating", true)
	dep.Set("isOriginRegulating", true)
	dep.Set("originTerminalName", originName)
	if originDepTime != "" {
		dep.Set("originDepartureTime", originDepTime)
	}
	var rawDelay any
	if numberIsFinite(dep.Get("delayMinutes")) {
		rawDelay = dep.Get("delayMinutes")
	} else if numberIsFinite(dep.Get("delayMins")) {
		rawDelay = dep.Get("delayMins")
	}
	if (rawDelay != nil && jsNumber(rawDelay) < 0) || dep.Get("delayStatus") == "early" {
		dep.Set("delayMins", 0.0)
		dep.Set("delayMinutes", 0.0)
		if aimedClean != "" {
			dep.Set("departureTime", aimedClean)
			m := math.Max(0, jsRound((timeStringToSeconds(aimedClean)-cur)/60))
			dep.Set("minutesAway", m)
			dep.Set("formattedStatus", numToString(m)+" min")
		}
	}
	dm := dep.Get("delayMins")
	if truthy(dm) && jsNumber(dm) >= 2 {
		dep.Set("delayStatus", "delayed")
		dep.Set("delayBadgeText", "+"+jsString(dm)+" min retard")
	} else {
		dep.Set("delayStatus", "regulating")
		dep.Set("delayBadgeText", "⏱️ Regulant a "+originName)
	}
	switch {
	case aimedClean != "" && originDepTime != "":
		dep.Set("comparisonText", "Horari teòric: "+aimedClean+" • Regulant a "+originName+" (sortida: "+originDepTime+")")
	case aimedClean != "":
		dep.Set("comparisonText", "Horari teòric: "+aimedClean+" • Regulant a "+originName)
	default:
		dep.Set("comparisonText", "Regulant a "+originName)
	}
	if originDepTime != "" {
		dep.Set("statusText", "⏱️ Regulant a "+originName+" (sortida: "+originDepTime+")")
	} else {
		dep.Set("statusText", "⏱️ Regulant a "+originName)
	}
}

// warmLineStopsCache computes every stop board of a line in the background.
func (t *MataroTracker) warmLineStopsCache(lineID any) {
	lID := t.normalizeLineId(lineID)
	if lID == "" {
		lID = "1"
	}
	var ids []string
	seen := map[string]bool{}
	for _, r := range t.routes(lID) {
		for _, s := range objList(r.Get("stops")) {
			if truthy(s.Get("id")) {
				id := jsString(s.Get("id"))
				if !seen[id] {
					seen[id] = true
					ids = append(ids, id)
				}
			}
		}
	}
	for _, id := range ids {
		t.getStopDepartures(id, lID, "0", O("skipCache", true, "skipSiri", true))
	}
}

// getTargetStopETA is the stop view for one line and direction.
func (t *MataroTracker) getTargetStopETA(lineID, stopID, direction any, opts *Obj) *Obj {
	if opts == nil {
		opts = O()
	}
	lID := t.normalizeLineId(lineID)
	if lID == "" {
		lID = "1"
	}
	lineInfo := t.lineInfo(lID)
	if lineInfo == nil {
		lineInfo = O("id", lID, "name", "Línia "+lID, "color", "#009485")
	}
	routes := t.routes(lID)
	dirIdx := int(parseIntOr(or(direction, "0"), 0))
	var selected *Obj
	switch {
	case dirIdx >= 0 && dirIdx < len(routes) && routes[dirIdx] != nil:
		selected = routes[dirIdx]
	case len(routes) > 0 && routes[0] != nil:
		selected = routes[0]
	default:
		selected = O("stops", []any{})
	}
	routeStops := objList(or(selected.Get("stops"), []any{}))
	var chosen *Obj
	if truthy(stopID) {
		n := t.normalizeStopId(stopID)
		for _, s := range routeStops {
			if jsString(s.Get("id")) == n {
				chosen = s
				break
			}
		}
		if chosen == nil {
			chosen = t.stopObj(n)
		}
	}
	if chosen == nil && len(routeStops) > 0 {
		chosen = routeStops[0]
	}
	if chosen == nil {
		return O("targetStop", nil, "nextBus", nil, "upcomingDepartures", []any{})
	}
	sID := jsString(chosen.Get("id"))
	sd := t.getStopDepartures(sID, lID, numToString(float64(dirIdx)), opts)
	if sd == nil {
		return nil
	}
	deps, _ := or(sd.Get("departures"), []any{}).([]any)
	var nextBus any
	if len(deps) > 0 {
		nextBus = deps[0]
	}

	var d JSDate
	switch {
	case truthy(opts.Get("dateObj")):
		d = newDate(opts.Get("dateObj"))
	case truthy(opts.Get("targetDate")):
		d = newDate(opts.Get("targetDate"))
	default:
		d = dateNow()
	}
	if !d.Valid() {
		return nil
	}
	now := d.ms()
	dayTomorrow := resolveDayType(now + 24*3600*1000).DayType
	dirArgV := jsString(or(selected.Get("id"), numToString(float64(dirIdx))))
	schedTomorrow := getDirectionSchedule(lID, dirArgV, dayTomorrow, "")
	depsTomorrow := getDeparturesForStop(lID, dirArgV, sID, dayTomorrow, "")
	first := "06:30"
	if len(depsTomorrow) > 0 {
		first = depsTomorrow[0]
	} else if schedTomorrow != nil && truthy(schedTomorrow.FirstTrip) {
		ft := jsString(schedTomorrow.FirstTrip)
		travel := getStopTravelTime(lID, dirArgV, sID, dayTomorrow, "")
		if travel > 0 {
			parts := strings.Split(ft, ":")
			h := parseIntJS(parts[0])
			m := math.NaN()
			if len(parts) > 1 {
				m = parseIntJS(parts[1])
			}
			pass := h*3600 + m*60 + travel
			ph := math.Mod(math.Floor(pass/3600), 24)
			pm := math.Floor(math.Mod(pass, 3600) / 60)
			first = padStart(numToString(ph), 2, "0") + ":" + padStart(numToString(pm), 2, "0")
		} else {
			first = ft
		}
	}
	operating := false
	for _, x := range deps {
		if truthy(asObj(x).Get("isRealTime")) || truthy(asObj(x).Get("isEstimated")) {
			operating = true
			break
		}
	}
	hour := getDateComponents(now).Hour
	period := "day"
	if hour >= 22 || hour < 6 {
		period = "night"
	}
	var statusText string
	switch {
	case operating:
		statusText = "Servei en funcionament"
	case nextBus != nil:
		statusText = "Servei programat • Proper servei a les " + jsString(asObj(nextBus).Get("departureTime"))
	default:
		statusText = "Servei fora d'horari • Represa demà a les " + first
	}
	seq := -1
	for i, s := range routeStops {
		if jsString(s.Get("id")) == sID {
			seq = i
			break
		}
	}
	return O(
		"line", O("id", lID, "code", lID, "name", jsTrim(jsString(lineInfo.Get("name"))), "color", lineInfo.Get("color")),
		"targetStop", O(
			"id", sID,
			"mouteStopId", sID,
			"name", reStopSuffix.ReplaceAllLiteralString(jsString(chosen.Get("name")), ""),
			"lat", or(chosen.Get("latitude"), chosen.Get("lat")),
			"lon", or(chosen.Get("longitude"), chosen.Get("lon")),
			"zone", "Mataró Urbà",
			"seq", float64(seq+1),
		),
		"direction", numToString(float64(dirIdx)),
		"directionName", or(selected.Get("name"), lineInfo.Get("name")),
		"nextBus", nextBus,
		"upcomingDepartures", deps,
		"serviceStatus", O(
			"isOperating", operating,
			"period", period,
			"firstServiceTomorrow", first,
			"statusText", statusText,
		),
	)
}

// getLineCongestion colours route segments by the speed of nearby buses.
func (t *MataroTracker) getLineCongestion(lineID, direction any) *Obj {
	lID := reLeadingLInsens.ReplaceAllLiteralString(jsString(lineID), "")
	dirIdx := int(parseIntOr(or(direction, "0"), 0))
	routes := t.routes(lID)
	var route *Obj
	if dirIdx >= 0 && dirIdx < len(routes) && routes[dirIdx] != nil {
		route = routes[dirIdx]
	} else if len(routes) > 0 {
		route = routes[0]
	}
	if route == nil || !truthy(route.Get("coords")) || jsNumber(objGet(route.Get("coords"), "length")) < 2 {
		return O("lineId", lID, "direction", numToString(float64(dirIdx)), "segments", []any{})
	}
	vehicles := append([]any{}, t.w.fr.getLineVehicles("L"+lID)...)
	vehicles = append(vehicles, t.fetchLiveVehicles(lID)...)
	polyline := polylinePairs(route)
	stops := objList(or(route.Get("stops"), []any{}))
	sc := float64(len(stops) - 1)
	if sc == 0 {
		sc = 8
	}
	segCount := int(math.Max(4, math.Min(12, sc)))
	step := len(polyline) / segCount
	segments := []any{}
	for i := 0; i < segCount; i++ {
		start := i * step
		end := min(len(polyline), (i+1)*step+1)
		if i == segCount-1 {
			end = len(polyline)
		}
		if start > end {
			start = end
		}
		coords := polyline[start:end]
		if len(coords) < 2 {
			continue
		}
		mid := coords[len(coords)/2].([]any)
		speed := 26.0
		var delay any = 0.0
		found := false
		for _, x := range vehicles {
			v := asObj(x)
			vLat := v.Get("lat")
			if isUndef(vLat) {
				vLat = v.Get("latitude")
			}
			vLon := v.Get("lon")
			if isUndef(vLon) {
				vLon = v.Get("longitude")
			}
			if isUndef(vLat) || isUndef(vLon) {
				continue
			}
			if distAny(vLat, vLon, mid[0], mid[1]) < 500 {
				sv := v.Get("speedKmh")
				if isUndef(sv) {
					sv = v.Get("speed")
				}
				spd := jsNumber(sv)
				if isFinite(spd) && spd >= 0 {
					speed = spd
					rd := v.Get("delayMinutes")
					if isUndef(rd) {
						rd = v.Get("delayMins")
					}
					if isFinite(jsNumber(rd)) {
						delay = jsNumber(rd)
					} else {
						delay = nil
					}
					found = true
					break
				}
			}
		}
		status, color, label := "fluid", "#10b981", "Fluid"
		dNum, dOK := delay.(float64)
		if speed < 10 || (dOK && dNum >= 4) {
			status, color, label = "congested", "#ef4444", "Congestió"
		} else if speed < 20 || (dOK && dNum >= 2) {
			status, color, label = "moderate", "#f59e0b", "Trànsit Dens"
		}
		segments = append(segments, O(
			"segmentIndex", float64(i),
			"status", status,
			"color", color,
			"label", label,
			"avgSpeedKmh", jsRound(speed),
			"delayMins", jsRound(dNum),
			"hasLiveVehicle", found,
			"coords", append([]any{}, coords...),
		))
	}
	return O(
		"lineId", lID,
		"lineCode", "L"+lID,
		"direction", numToString(float64(dirIdx)),
		"segmentsCount", float64(len(segments)),
		"segments", segments,
	)
}

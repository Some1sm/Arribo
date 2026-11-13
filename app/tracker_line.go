package main

// Port of mataroTracker.js lines 1397-2593: the line view (_computeLineDetails),
// live and dead-reckoned buses, nearest-segment progress and timetable ghosts.

import (
	"math"
	"sort"
	"strings"
)

const offRouteM = 75

// strictEq is JavaScript === for the primitive values compared here.
func strictEq(a, b any) bool {
	switch x := a.(type) {
	case nil:
		return b == nil
	case undefinedT:
		return isUndef(b)
	case float64:
		y, ok := b.(float64)
		return ok && x == y
	case string:
		y, ok := b.(string)
		return ok && x == y
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	}
	return a == b
}

// latOf / lonOf are b.lat || b.latitude and b.lon || b.longitude.
func latOf(b *Obj) any { return or(b.Get("lat"), b.Get("latitude")) }
func lonOf(b *Obj) any { return or(b.Get("lon"), b.Get("longitude")) }

// distAny is calculateDistanceMeters on raw values (Number(x) || 0).
func distAny(lat1, lon1, lat2, lon2 any) float64 {
	return distM(jsNumber(lat1), jsNumber(lon1), jsNumber(lat2), jsNumber(lon2))
}

// ptAny is normalizeCoord({lat, lon}).
func ptAny(lat, lon any) LatLon {
	if isNullish(lat) {
		lat = 0.0
	}
	if isNullish(lon) {
		lon = 0.0
	}
	return LatLon{n0(jsNumber(lat)), n0(jsNumber(lon))}
}

// fixAtOf is (b.freshness && Number(b.freshness.observedAt)) || Number(b.observedAt) [|| Number(b.timestamp)] || null.
func fixAtOf(b *Obj, withTimestamp bool) any {
	fr := b.Get("freshness")
	var x any = fr
	if truthy(fr) {
		x = jsNumber(objGet(fr, "observedAt"))
	}
	x = or(x, jsNumber(b.Get("observedAt")))
	if withTimestamp {
		x = or(x, jsNumber(b.Get("timestamp")))
	}
	return or(x, nil)
}

// rawFilteredCoords is the source's
//
//	(r.coords || []).map(c => ({lat: parseFloat(c.Latitude ?? c.lat || 0), ...}))
//	  .filter(c => !isNaN(c.lat) && !isNaN(c.lon) && (c.lat !== 0 || c.lon !== 0))
func rawFilteredCoords(r *Obj) []LatLon {
	var out []LatLon
	for _, c := range objList(r.Get("coords")) {
		la := c.Get("Latitude")
		if isUndef(la) {
			la = or(c.Get("lat"), 0.0)
		}
		lo := c.Get("Longitude")
		if isUndef(lo) {
			lo = or(c.Get("lon"), 0.0)
		}
		lat, lon := parseFloatJS(la), parseFloatJS(lo)
		if !math.IsNaN(lat) && !math.IsNaN(lon) && (lat != 0 || lon != 0) {
			out = append(out, LatLon{lat, lon})
		}
	}
	return out
}

// optionDate resolves options.dateObj / targetDate / referenceDate / now.
// ok is false for a date that does not parse (the source then throws).
func optionDate(opts *Obj) (int64, bool) {
	var d JSDate
	switch {
	case truthy(opts.Get("dateObj")):
		d = newDate(opts.Get("dateObj"))
	case truthy(opts.Get("targetDate")):
		d = newDate(opts.Get("targetDate"))
	case truthy(opts.Get("referenceDate")):
		d = newDate(opts.Get("referenceDate"))
	default:
		return nowMs(), true
	}
	if !d.Valid() {
		return 0, false
	}
	return d.ms(), true
}

func secOfDay(ms int64) float64 {
	c := getDateComponents(ms)
	return float64(c.Hour*3600 + c.Minute*60 + c.Second)
}

func stopsList(v any) []*Obj { return objList(v) }

// computeLineDetails is _computeLineDetails. nil means the source would
// have rejected (an unparseable date).
func (t *MataroTracker) computeLineDetails(lineID any, direction any, opts *Obj) *Obj {
	direction, opts, _ = directionAsOptions(direction, opts)
	lID := t.normalizeLineId(lineID)
	if lID == "" {
		lID = "1"
	}
	isBoth := direction == "both"
	dirIdx := 0
	if !isBoth {
		dirIdx = int(parseIntOr(direction, 0))
	}
	staticTemplate := t.staticTemplate(lID + "_" + jsString(direction))
	if staticTemplate == nil {
		staticTemplate = t.staticTemplate(lID + "_0")
	}
	targetMs, ok := optionDate(opts)
	if !ok {
		return nil
	}

	lineInfo := t.lineInfo(lID)
	if lineInfo == nil {
		lineInfo = O("id", lID, "name", "Línia "+lID, "color", "#009485")
	}
	routes := t.routes(lID)
	var selected *Obj
	switch {
	case dirIdx >= 0 && dirIdx < len(routes) && routes[dirIdx] != nil:
		selected = routes[dirIdx]
	case len(routes) > 0 && routes[0] != nil:
		selected = routes[0]
	default:
		selected = O("coords", []any{}, "stops", []any{})
	}
	var polyline any
	var stops []*Obj
	var stopsRaw any = []any{}
	var allDirections []any
	if staticTemplate != nil {
		polyline = staticTemplate.Get("polyline")
		stopsRaw = staticTemplate.Get("stops")
		stops = stopsList(stopsRaw)
		allDirections, _ = staticTemplate.Get("allDirections").([]any)
	} else {
		polyline = polylinePairs(selected)
		allDirections = []any{}
	}

	live := []any{}
	if !truthy(opts.Get("skipSiri")) {
		if v, err := t.w.siri.getLiveVehicles(lID); err == nil && v != nil {
			live = *v
		}
	}
	filtered := []any{}
	for _, x := range live {
		v := asObj(x)
		lat, lon := latOf(v), lonOf(v)
		if !truthy(lat) || !truthy(lon) {
			continue
		}
		la, lo := jsNumber(lat), jsNumber(lon)
		if la < 41.48 || la > 41.62 || lo < 2.36 || lo > 2.52 {
			continue
		}
		filtered = append(filtered, v)
	}
	live = filtered

	dayType := resolveDayType(targetMs).DayType
	lineMaxFleet := getScheduledFleetRequirement(lID, dayType, secOfDay(targetMs), true, "")

	if lineMaxFleet > 0 {
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
			}
		}
		if len(live) > 0 {
			t.stitchAnonymousVehicles(live, lID, routes, float64(targetMs))
			kept := []any{}
			for _, x := range live {
				if !t.isAnonymousVehicle(asObj(x)) {
					kept = append(kept, x)
				}
			}
			live = kept
		}
		if len(live) == 0 {
			now := float64(targetMs)
			var hist []any
			for _, k := range t.vehicleHistory.Keys() {
				hv, _ := t.vehicleHistory.Get(k)
				h := hv.(*Obj)
				if jsString(h.Get("lineId")) == lID && now-jsNumber(h.Get("lastSeen")) <= 90000 {
					obs := or(jsNumber(h.Get("observedAt")), nil)
					sp := h.Get("speedKmh")
					var speed, delay any = nil, nil
					if numberIsFinite(sp) {
						speed = sp
					}
					if numberIsFinite(h.Get("delayMins")) {
						delay = h.Get("delayMins")
					}
					hasSpeed := numberIsFinite(sp)
					if !h.IsUndef("hasSpeed") {
						hasSpeed = truthy(h.Get("hasSpeed"))
					}
					hasDelay := numberIsFinite(h.Get("delayMins"))
					if !h.IsUndef("hasDelay") {
						hasDelay = truthy(h.Get("hasDelay"))
					}
					hist = append(hist, O(
						"vehicleId", h.Get("vehicleId"),
						"lineId", h.Get("lineId"),
						"direction", h.Get("direction"),
						"directionName", h.Get("directionName"),
						"origin", h.Get("origin"),
						"destination", h.Get("destination"),
						"lat", h.Get("lat"),
						"lon", h.Get("lon"),
						"bearing", h.Get("bearing"),
						"speedKmh", speed,
						"hasSpeed", hasSpeed,
						"delayMins", delay,
						"hasDelay", hasDelay,
						"isEstimated", true,
						"isRealTime", false,
						"observedAt", obs,
						"freshness", O("source", "position", "fetchedAt", now, "observedAt", obs),
						"timestamp", h.Get("lastSeen"),
					))
				}
			}
			if len(hist) > 0 {
				live = hist
			}
		}
	} else {
		live = []any{}
	}

	isMultiDir := len(routes) > 1
	for _, x := range live {
		v := asObj(x)
		if d := v.Get("direction"); isNullish(d) || d == "" {
			idx := 0
			if isMultiDir {
				idx = t.matchVehicleToRouteIndex(v, routes)
			}
			v.Set("direction", numToString(float64(idx)))
		}
	}
	var vehs0, vehs1 []any
	if isMultiDir {
		for _, x := range live {
			switch jsString(asObj(x).Get("direction")) {
			case "0":
				vehs0 = append(vehs0, x)
			case "1":
				vehs1 = append(vehs1, x)
			}
		}
	} else {
		vehs0 = live
	}

	dirStops := func(i int) []*Obj {
		if i < len(allDirections) {
			if s := asObj(allDirections[i]).Get("stops"); truthy(s) {
				return stopsList(s)
			}
		}
		if i < len(routes) && routes[i] != nil {
			if s := routes[i].Get("stops"); truthy(s) {
				return stopsList(s)
			}
		}
		return stops
	}
	route0 := selected
	if len(routes) > 0 && routes[0] != nil {
		route0 = routes[0]
	}
	buses0 := t.processBusesWithDeadReckoning(vehs0, route0, dirStops(0), "0", live, float64(targetMs), routes)
	var buses1 []*Obj
	if isMultiDir {
		buses1 = t.processBusesWithDeadReckoning(vehs1, routes[1], dirStops(1), "1", live, float64(targetMs), routes)
	}

	unique := newJSMap()
	for _, b := range append(append([]*Obj{}, buses0...), buses1...) {
		vID := jsString(or(b.Get("vehicleId"), b.Get("tripId")))
		if !unique.Has(vID) {
			unique.Set(vID, b)
		} else {
			ev, _ := unique.Get(vID)
			if truthy(ev.(*Obj).Get("isEstimated")) && !truthy(b.Get("isEstimated")) {
				unique.Set(vID, b)
			}
		}
	}
	var allLine []*Obj
	for _, k := range unique.Keys() {
		bv, _ := unique.Get(k)
		b := bv.(*Obj)
		fi := getVehicleFleetInfo(or(b.Get("vehicleId"), b.Get("tripId")))
		c := b.Clone()
		c.Set("propulsion", fi.Get("propulsion"))
		c.Set("isElectric", fi.Get("isElectric"))
		c.Set("isHybrid", fi.Get("isHybrid"))
		c.Set("propulsionBadge", fi.Get("propulsionBadge"))
		c.Set("propulsionIcon", fi.Get("badgeIcon"))
		c.Set("propulsionClass", fi.Get("badgeClass"))
		c.Set("modelName", fi.Get("modelName"))
		c.Set("isAccessible", fi.Get("isAccessible"))
		allLine = append(allLine, c)
	}

	synthetic, fleetStatus := t.synthesizeMissingScheduledBuses(lID, direction, routes, allDirections, allLine, targetMs, live)

	var processed []*Obj
	if isBoth {
		processed = append(processed, allLine...)
	} else {
		want := numToString(float64(dirIdx))
		for _, b := range allLine {
			if jsString(b.Get("direction")) == want {
				processed = append(processed, b)
			}
		}
	}
	processed = append(processed, synthetic...)

	maxFleetLimit := 0.0
	if lineMaxFleet != 0 {
		if isBoth {
			maxFleetLimit = lineMaxFleet
		} else {
			maxFleetLimit = math.Max(1, fleetStatus.Num("scheduledVehicles"))
		}
	}
	if maxFleetLimit == 0 {
		processed = nil
	} else if float64(len(processed)) > maxFleetLimit {
		var phys, synth []*Obj
		for _, b := range processed {
			if t.isPhysicalVehicle(b) {
				phys = append(phys, b)
			} else {
				synth = append(synth, b)
			}
		}
		capped := phys[:jsSliceLen(len(phys), maxFleetLimit)]
		remaining := math.Max(0, maxFleetLimit-float64(len(capped)))
		processed = append(append([]*Obj{}, capped...), synth[:jsSliceLen(len(synth), remaining)]...)
	}

	hasLiveGps := false
	isOnlyEstimated := maxFleetLimit > 0 && len(processed) > 0
	for _, b := range processed {
		if !truthy(b.Get("isEstimated")) {
			hasLiveGps = maxFleetLimit > 0
			isOnlyEstimated = false
		}
	}
	disruptions := t.getDisruptions(lID)
	cancelled := t.getCancelledStopsForLine(lID, disruptions, float64(targetMs), nil)

	withStatus := func(list []*Obj) []any {
		out := []any{}
		for _, s := range list {
			sID := jsString(s.Get("id"))
			c := s.Clone()
			isC := cancelled.Has(sID)
			c.Set("isCancelled", isC)
			var reason any
			if isC {
				reason, _ = cancelled.Get(sID)
			}
			c.Set("cancelledReason", reason)
			out = append(out, c)
		}
		return out
	}
	stopsWithStatus := withStatus(stops)
	allDirs := []any{}
	for _, d := range allDirections {
		do := asObj(d)
		c := do.Clone()
		c.Set("stops", withStatus(stopsList(or(do.Get("stops"), []any{}))))
		allDirs = append(allDirs, c)
	}

	directions := []any{}
	for idx, r := range routes {
		sc := 0.0
		if truthy(r.Get("stops")) {
			sc = jsNumber(lengthOf(r.Get("stops")))
		}
		directions = append(directions, O("dirId", numToString(float64(idx)), "routeId", r.Get("id"), "name", r.Get("name"), "stopsCount", sc))
	}
	var secCoords, secStops any = nil, nil
	if isBoth && len(allDirs) > 1 {
		secCoords = asObj(allDirs[1]).Get("polyline")
		secStops = asObj(allDirs[1]).Get("stops")
	}
	activeBuses := make([]any, len(processed))
	for i, b := range processed {
		activeBuses[i] = b
	}
	var fs any = fleetStatus
	if lineMaxFleet == 0 || maxFleetLimit == 0 {
		fs = O("scheduledVehicles", 0.0, "scheduledBuses", 0.0, "notDrawn", O(),
			"liveGpsVehicles", 0.0, "estimatedVehicles", 0.0, "deadReckonedVehicles", 0.0, "fleetCoveragePct", 100.0)
	}
	direction2 := "both"
	directionName := any("Ambdós sentits")
	if !isBoth {
		direction2 = numToString(float64(dirIdx))
		directionName = or(selected.Get("name"), jsString(lineInfo.Get("name")))
	}

	res := O()
	if staticTemplate != nil {
		res = staticTemplate.Clone()
	}
	res.Set("lineId", lID)
	res.Set("code", "L"+lID)
	res.Set("name", jsTrim(jsString(lineInfo.Get("name"))))
	res.Set("color", lineInfo.Get("color"))
	res.Set("agency", "Mataró Bus (Avanza)")
	res.Set("group", "mataro")
	res.Set("direction", direction2)
	res.Set("directionName", directionName)
	res.Set("directions", directions)
	res.Set("totalStops", float64(len(stopsWithStatus)))
	res.Set("stops", stopsWithStatus)
	res.Set("coords", polyline)
	res.Set("polyline", polyline)
	res.Set("geometrySource", "gtfs")
	res.Set("geometryEstimated", false)
	res.Set("secondaryCoords", secCoords)
	res.Set("secondaryStops", secStops)
	res.Set("secondaryColor", "#38bdf8")
	res.Set("allDirections", allDirs)
	res.Set("activeBuses", activeBuses)
	res.Set("totalActiveBuses", float64(len(processed)))
	res.Set("fleetStatus", fs)
	res.Set("isRealTime", hasLiveGps)
	res.Set("isEstimated", isOnlyEstimated)
	res.Set("isScheduleBaseline", len(processed) == 0)
	res.Set("lastSyncTimestamp", float64(nowMs()))
	res.Set("disruptions", disruptions)
	_ = stopsRaw
	return res
}

// processBusesWithDeadReckoning snaps live buses to the road, records them,
// and projects recently lost ones along the route.
func (t *MataroTracker) processBusesWithDeadReckoning(liveBuses []any, route *Obj, stops []*Obj, dirID string, allLineLive []any, now float64, lineRoutes []*Obj) []*Obj {
	var result []*Obj
	polyCoords := t.routeCoords(route)
	src := lineRoutes
	if len(src) == 0 {
		src = []*Obj{route}
	}
	var linePolys [][]LatLon
	for _, r := range src {
		var p []LatLon
		if r != nil {
			for _, c := range objList(r.Get("coords")) {
				la, lo := parseFloatJS(c.Get("Latitude")), parseFloatJS(c.Get("Longitude"))
				if isFinite(la) && isFinite(lo) {
					p = append(p, LatLon{la, lo})
				}
			}
		}
		if len(p) > 1 {
			linePolys = append(linePolys, p)
		}
	}
	nowSecFloor := math.Floor(now / 1000)

	for _, x := range liveBuses {
		b := asObj(x)
		p := ptAny(b.Get("lat"), b.Get("lon"))
		snapped := snapPointToPolyline(p, polyCoords)
		vKey := jsString(b.Get("vehicleId"))
		pv, hasPrev := t.vehicleHistory.Get(vKey)
		var prevHist *Obj
		if hasPrev {
			prevHist, _ = pv.(*Obj)
		}
		fixAt := fixAtOf(b, true)
		lineDist := snapped.Dist
		if len(linePolys) > 0 {
			lineDist = math.Inf(1)
			for _, lp := range linePolys {
				if d := snapPointToPolyline(p, lp).Dist; d < lineDist || math.IsNaN(d) {
					lineDist = d
				}
			}
		}
		farNow := !truthy(b.Get("isEstimated")) && isFinite(lineDist) && lineDist > offRouteM
		prevStreak := 0.0
		if prevHist != nil {
			prevStreak = jsNumber(or(prevHist.Get("offRouteStreak"), 0.0))
		}
		newFix := prevHist == nil || !truthy(fixAt) || !strictEq(prevHist.Get("offRouteFixAt"), fixAt)
		streak := 0.0
		if farNow {
			streak = prevStreak
			if newFix {
				streak = prevStreak + 1
			}
		}
		offRoute := streak >= 2
		var roadLat, roadLon float64
		var roadBearing any
		if offRoute {
			roadLat = round6(jsNumber(b.Get("lat")))
			roadLon = round6(jsNumber(b.Get("lon")))
			roadBearing = or(b.Get("bearing"), or(snapped.Bearing, 0.0))
		} else {
			roadLat = round6(snapped.Lat)
			roadLon = round6(snapped.Lon)
			roadBearing = or(snapped.Bearing, or(b.Get("bearing"), 0.0))
		}

		speedNum := jsNumber(b.Get("speedKmh"))
		hasSpeed := isFinite(speedNum)
		if !b.IsUndef("hasSpeed") {
			hasSpeed = truthy(b.Get("hasSpeed"))
		}
		var speedKmh any
		if hasSpeed && isFinite(speedNum) {
			speedKmh = speedNum
		}
		var histDelay any
		if !b.IsUndef("delayMins") && isFinite(jsNumber(b.Get("delayMins"))) {
			histDelay = jsNumber(b.Get("delayMins"))
		}
		t.vehicleHistory.Set(vKey, O(
			"vehicleId", b.Get("vehicleId"),
			"lineId", b.Get("lineId"),
			"direction", dirID,
			"lat", roadLat,
			"lon", roadLon,
			"bearing", roadBearing,
			"speedKmh", speedKmh,
			"hasSpeed", hasSpeed,
			"delayMins", histDelay,
			"lastSeen", now,
			"observedAt", fixAtOf(b, false),
			"directionName", b.Get("directionName"),
			"origin", b.Get("origin"),
			"destination", b.Get("destination"),
			"offRouteStreak", streak,
			"offRouteFixAt", fixAt,
		))

		seg := t.findNearestSegment(roadLat, roadLon, stops)
		speedCmp := 0.0
		if f, ok := speedKmh.(float64); ok {
			speedCmp = f
		}
		isTerminal := (!hasSpeed || speedCmp <= 3) &&
			((seg.Num("totalProgress") > 92 && seg.Num("distanceToNextMeters") <= 50) || seg.Num("totalProgress") < 8)
		busAgeSec := math.Max(0, (now-jsNumber(or(b.Get("timestamp"), or(b.Get("lastSeen"), now))))/1000)
		isStaleFix := busAgeSec > 45
		isEst := truthy(b.Get("isEstimated")) || isStaleFix
		hasDelay := isFinite(jsNumber(b.Get("delayMins")))
		if !b.IsUndef("hasDelay") {
			hasDelay = truthy(b.Get("hasDelay"))
		}
		rawNull := !hasDelay
		rawDelay := 0.0
		if hasDelay {
			rawDelay = jsNumber(b.Get("delayMins"))
		}
		isGhostDelay := !isEst && isTerminal && !rawNull && rawDelay > 10
		cleanNull := false
		cleanDelay := 0.0
		switch {
		case isGhostDelay:
			cleanDelay = 0
		case rawNull:
			cleanNull = true
		default:
			cleanDelay = math.Max(-15, math.Min(300, rawDelay))
		}
		var cleanDelayV any
		if !cleanNull {
			cleanDelayV = cleanDelay
		}
		var formatted string
		switch {
		case !hasDelay || cleanNull:
			formatted = "Sense dades de retard"
		case isEst:
			formatted = "⚡ Estimació en circuit"
		case isGhostDelay:
			formatted = "Regulant a capçalera"
		case cleanDelay > 0:
			formatted = "+" + numToString(cleanDelay) + " min retard"
		case cleanDelay < 0:
			formatted = numToString(cleanDelay) + " min avançat"
		default:
			formatted = "Puntual"
		}
		var statusText string
		switch {
		case isEst && isStaleFix:
			statusText = "⚡ Estimació (" + numToString(jsRound(busAgeSec)) + "s sense GPS)"
		case isEst:
			statusText = "⚡ Estimació per pèrdua temporal de senyal"
		case isGhostDelay:
			statusText = "⏱️ Regulant a capçalera"
		default:
			statusText = "🟢 Senyal GPS Actiu"
		}

		var tripStartTime, tripStartStop any = nil, nil
		if !(isTerminal || isGhostDelay || cleanNull) {
			ts := matchTripStart(MatchArgs{
				LineID:    b.Get("lineId"),
				Direction: dirID,
				ToSeq:     seg.Get("toSeq"),
				StopName:  seg.Get("toStop"),
				DelayMins: cleanDelay,
				At:        now,
			})
			if ts != nil && truthy(ts.Get("matched")) {
				tripStartTime = ts.Get("startTime")
			}
			if truthy(tripStartTime) {
				tripStartStop = ts.Get("startStopName")
			}
		}
		if he, ok := t.vehicleHistory.Get(vKey); ok {
			he.(*Obj).Set("tripStartTime", tripStartTime)
			he.(*Obj).Set("tripStartStop", tripStartStop)
		}

		var offRouteMV any
		if offRoute {
			offRouteMV = jsRound(lineDist)
		}
		badge := formatted
		if isEst {
			badge = "⚡ En ruta (Estimat)"
		}
		fresh := b.Get("freshness")
		if !truthy(fresh) {
			if isEst {
				fresh = O("source", "position", "fetchedAt", now, "observedAt", nil)
			} else {
				fresh = Undefined
			}
		}
		var tss any
		if truthy(tripStartTime) {
			tss = "timetable"
		}
		lineName := or(b.Get("lineName"), or(route.Get("name"), "Línia "+jsString(b.Get("lineId"))))
		result = append(result, O(
			"tripId", "mataro_"+jsString(b.Get("vehicleId")),
			"vehicleId", b.Get("vehicleId"),
			"lineId", b.Get("lineId"),
			"lineName", lineName,
			"direction", dirID,
			"_snapDist", snapped.Dist,
			"offRoute", offRoute,
			"offRouteM", offRouteMV,
			"lat", roadLat,
			"lon", roadLon,
			"latitude", roadLat,
			"longitude", roadLon,
			"bearing", roadBearing,
			"compass", getCompassDirection(jsNumber(roadBearing)),
			"speedKmh", speedKmh,
			"hasSpeed", hasSpeed,
			"delayMins", cleanDelayV,
			"hasDelay", hasDelay && !cleanNull,
			"delayFormatted", formatted,
			"delayBadgeText", badge,
			"isEstimated", isEst,
			"isRealTime", !isEst,
			"freshness", fresh,
			"observedAt", fixAtOf(b, false),
			"recordedAt", or(b.Get("recordedAt"), isoString(nowMs())),
			"timestamp", or(b.Get("timestamp"), now),
			"origin", or(b.Get("origin"), ""),
			"destination", or(b.Get("destination"), ""),
			"statusText", statusText,
			"tripStartTime", tripStartTime,
			"tripStartStop", tripStartStop,
			"tripStartSource", tss,
			"fromStop", seg.Get("fromStop"),
			"toStop", seg.Get("toStop"),
			"fromSeq", seg.Get("fromSeq"),
			"toSeq", seg.Get("toSeq"),
			"totalProgress", seg.Get("totalProgress"),
			"coordinatesFormatted", toFixed(roadLat, 5)+"° N, "+toFixed(roadLon, 5)+"° E",
			"secondsToNextStop", seg.Get("secondsToNextStop"),
			"distanceToNextMeters", seg.Get("distanceToNextMeters"),
			"fromCoords", O("lat", roadLat, "lon", roadLon),
			"toCoords", seg.Get("toCoords"),
			"segStartSec", nowSecFloor-10,
			"segEndSec", nowSecFloor+math.Max(15, seg.Num("secondsToNextStop")),
			"isTerminalLayover", isTerminal || isGhostDelay,
		))
	}

	lineKey := jsString(route.Get("id_linea"))
	others := allLineLive
	if others == nil {
		others = liveBuses
	}
	for _, vID := range t.vehicleHistory.Keys() {
		hv, ok := t.vehicleHistory.Get(vID)
		if !ok {
			continue
		}
		hist := hv.(*Obj)
		if strings.HasPrefix(vID, "EST_") || truthy(hist.Get("isGhostVehicle")) || truthy(hist.Get("isTheoretical")) {
			t.vehicleHistory.Delete(vID)
			continue
		}
		if jsString(hist.Get("lineId")) != lineKey {
			continue
		}
		if jsString(hist.Get("direction")) != dirID {
			continue
		}
		elapsed := (now - jsNumber(hist.Get("lastSeen"))) / 1000
		if elapsed > 90 {
			t.vehicleHistory.Delete(vID)
			continue
		}
		active := false
		for _, x := range others {
			if jsString(asObj(x).Get("vehicleId")) == vID {
				active = true
				break
			}
		}
		if active || !numberIsFinite(hist.Get("speedKmh")) || !(elapsed >= 1 && elapsed <= 90) {
			continue
		}
		hSpeed := jsNumber(hist.Get("speedKmh"))
		est, ok := extrapolatePolylinePosition(normalizeCoordAny(hist), hist.Get("bearing"), elapsed, hSpeed, polyCoords)
		if !ok {
			continue
		}
		bunched := false
		for _, x := range others {
			ob := asObj(x)
			bd := ob.Get("direction")
			if !isNullish(bd) && bd != "" && jsString(bd) != dirID {
				continue
			}
			bl, bo := latOf(ob), lonOf(ob)
			if !truthy(bl) || !truthy(bo) {
				continue
			}
			if distM(est.Lat, est.Lon, jsNumber(bl), jsNumber(bo)) < 600 {
				bunched = true
				break
			}
		}
		if bunched {
			continue
		}
		seg := t.findNearestSegment(est.Lat, est.Lon, stops)
		elapsedMin := math.Floor(elapsed / 60)
		elapsedText := numToString(jsRound(elapsed)) + "s"
		if elapsedMin > 0 {
			elapsedText = numToString(elapsedMin) + " min"
		}
		obs := or(jsNumber(hist.Get("observedAt")), nil)
		hasDelay := numberIsFinite(hist.Get("delayMins"))
		var delay any
		delayFmt := "Sense dades de retard"
		if hasDelay {
			delay = hist.Get("delayMins")
			if jsNumber(delay) > 0 {
				delayFmt = "+" + numToString(jsNumber(delay)) + " min retard"
			} else {
				delayFmt = "Puntual"
			}
		}
		recMs := jsNumber(or(obs, hist.Get("lastSeen")))
		var tss any
		if truthy(hist.Get("tripStartTime")) {
			tss = "timetable"
		}
		result = append(result, O(
			"tripId", "mataro_"+vID,
			"vehicleId", vID,
			"lineId", hist.Get("lineId"),
			"lineName", or(route.Get("name"), "Línia "+jsString(hist.Get("lineId"))),
			"direction", dirID,
			"lat", est.Lat,
			"lon", est.Lon,
			"latitude", est.Lat,
			"longitude", est.Lon,
			"bearing", est.BearingRaw,
			"compass", getCompassDirection(jsNumber(est.BearingRaw)),
			"speedKmh", math.Max(15, math.Min(45, hSpeed)),
			"hasSpeed", true,
			"delayMins", delay,
			"hasDelay", hasDelay,
			"delayFormatted", delayFmt,
			"isEstimated", true,
			"isRealTime", false,
			"observedAt", obs,
			"freshness", O("source", "position", "fetchedAt", now, "observedAt", obs),
			"recordedAt", isoStringChecked(recMs),
			"timestamp", hist.Get("lastSeen"),
			"origin", or(hist.Get("origin"), ""),
			"destination", or(hist.Get("destination"), ""),
			"statusText", "⚡ Estimació de posició ("+elapsedText+" sense GPS)",
			"tripStartTime", or(hist.Get("tripStartTime"), nil),
			"tripStartStop", or(hist.Get("tripStartStop"), nil),
			"tripStartSource", tss,
			"fromStop", seg.Get("fromStop"),
			"toStop", seg.Get("toStop"),
			"fromSeq", seg.Get("fromSeq"),
			"toSeq", seg.Get("toSeq"),
			"totalProgress", seg.Get("totalProgress"),
			"coordinatesFormatted", toFixed(est.Lat, 5)+"° N, "+toFixed(est.Lon, 5)+"° E (Est.)",
			"secondsToNextStop", math.Max(10, seg.Num("secondsToNextStop")),
			"distanceToNextMeters", seg.Get("distanceToNextMeters"),
			"fromCoords", seg.Get("fromCoords"),
			"toCoords", seg.Get("toCoords"),
			"segStartSec", nowSecFloor-10,
			"segEndSec", nowSecFloor+math.Max(15, seg.Num("secondsToNextStop")),
			"isTerminalLayover", false,
		))
	}
	return result
}

// isoStringChecked is new Date(ms).toISOString(); the source throws on an
// invalid date, which cannot happen for these finite timestamps.
func isoStringChecked(ms float64) string {
	if !isFinite(ms) {
		return ""
	}
	return isoString(int64(ms))
}

// stopCoord is stop.latitude !== undefined ? parseFloat(stop.latitude) : stop.lat.
func stopCoord(s *Obj, long, short string) any {
	if v := s.Get(long); !isUndef(v) {
		return parseFloatJS(v)
	}
	return s.Get(short)
}

// findNearestSegment finds the stop segment a position is on and its progress.
func (t *MataroTracker) findNearestSegment(lat, lon float64, stops []*Obj) *Obj {
	if len(stops) == 0 {
		return O("fromStop", "Mataró", "toStop", "Destí", "fromSeq", 1.0, "toSeq", 1.0,
			"totalProgress", 50.0, "secondsToNextStop", 60.0, "distanceToNextMeters", 300.0)
	}
	minIdx := 0
	minDist := math.Inf(1)
	for i, s := range stops {
		d := distM(lat, lon, jsNumber(stopCoord(s, "latitude", "lat")), jsNumber(stopCoord(s, "longitude", "lon")))
		if !math.IsNaN(d) && d < minDist {
			minDist = d
			minIdx = i
		}
	}
	fromIdx := max(0, min(len(stops)-2, minIdx))
	toIdx := min(len(stops)-1, fromIdx+1)
	s1, s2 := stops[fromIdx], stops[toIdx]
	s1Lat, s1Lon := stopCoord(s1, "latitude", "lat"), stopCoord(s1, "longitude", "lon")
	s2Lat, s2Lon := stopCoord(s2, "latitude", "lat"), stopCoord(s2, "longitude", "lon")
	distToNext := jsRound(distM(lat, lon, jsNumber(s2Lat), jsNumber(s2Lon)))
	totalProgress := jsRound(float64(toIdx) / math.Max(1, float64(len(stops)-1)) * 100)
	secondsToNext := math.Max(15, jsRound(distToNext/30*3.6))
	return O(
		"fromStop", s1.Get("name"),
		"toStop", s2.Get("name"),
		"fromSeq", or(s1.Get("seq"), float64(fromIdx+1)),
		"toSeq", or(s2.Get("seq"), float64(toIdx+1)),
		"totalProgress", totalProgress,
		"distanceToNextMeters", distToNext,
		"secondsToNextStop", secondsToNext,
		"fromCoords", O("lat", s1Lat, "lon", s1Lon),
		"toCoords", O("lat", s2Lat, "lon", s2Lon),
	)
}

type activeTrip struct {
	depTime           string
	depSec, arrSec    float64
	elapsedSec        float64
	progress          float64
	isTerminalLayover bool
	paired            bool
}

func travelSecOf(s *DirSchedule) float64 {
	v := s.TotalTravelSec
	if v == 0 || math.IsNaN(v) {
		v = s.TotalTravelMinutes * 60
	}
	if v == 0 || math.IsNaN(v) {
		v = 1800
	}
	return v
}

func totalProgressOr(b *Obj, def float64) float64 {
	if b.IsUndef("totalProgress") {
		return def
	}
	return jsNumber(b.Get("totalProgress"))
}

// synthesizeMissingScheduledBuses draws timetable ghosts for trips no real bus covers.
func (t *MataroTracker) synthesizeMissingScheduledBuses(lID string, direction any, routes []*Obj, allDirections []any, existing []*Obj, dateMs int64, allLineLive []any) ([]*Obj, *Obj) {
	isBoth := direction == "both"
	dayType := resolveDayType(dateMs).DayType
	nowSec := secOfDay(dateMs)
	nowMsF := float64(dateMs)

	known := append([]*Obj{}, existing...)
	idOf := func(b *Obj) string { return jsString(or(b.Get("vehicleId"), b.Get("tripId"))) }
	hasID := func(id string) bool {
		for _, b := range known {
			if idOf(b) == id {
				return true
			}
		}
		return false
	}
	for _, x := range allLineLive {
		lv := asObj(x)
		if !hasID(idOf(lv)) {
			known = append(known, lv)
		}
	}
	if math.Abs(float64(nowMs())-nowMsF) <= 120000 {
		for _, vID := range t.vehicleHistory.Keys() {
			hv, _ := t.vehicleHistory.Get(vID)
			h := hv.(*Obj)
			if jsString(h.Get("lineId")) != lID {
				continue
			}
			if strings.HasPrefix(vID, "EST_") || truthy(h.Get("isGhostVehicle")) || truthy(h.Get("isTheoretical")) {
				continue
			}
			elapsed := (nowMsF - jsNumber(or(h.Get("lastSeen"), nowMsF))) / 1000
			if elapsed >= 0 && elapsed <= 90 && !hasID(vID) {
				known = append(known, O(
					"vehicleId", h.Get("vehicleId"),
					"tripId", "mataro_"+jsString(h.Get("vehicleId")),
					"lineId", h.Get("lineId"),
					"direction", h.Get("direction"),
					"lat", h.Get("lat"),
					"lon", h.Get("lon"),
					"latitude", h.Get("lat"),
					"longitude", h.Get("lon"),
					"isEstimated", true,
					"isRealTime", false,
					"timestamp", h.Get("lastSeen"),
				))
			}
		}
	}
	for _, b := range known {
		if d := b.Get("direction"); (isNullish(d) || d == "") && len(routes) > 1 {
			b.Set("direction", numToString(float64(t.matchVehicleToRouteIndex(b, routes))))
		}
	}

	dirIdx := 0
	if !isBoth {
		dirIdx = int(parseIntOr(direction, 0))
	}
	allDirKeys := []string{"0"}
	if len(routes) > 1 {
		allDirKeys = []string{"0", "1"}
	}
	physicalOn := func(dk string) []*Obj {
		var out []*Obj
		for _, b := range known {
			if jsString(b.Get("direction")) == dk && t.isPhysicalVehicle(b) {
				out = append(out, b)
			}
		}
		return out
	}

	totalScheduled := 0.0
	tripsByDir := map[string][]*activeTrip{"0": {}, "1": {}}
	for _, dk := range allDirKeys {
		s := getDirectionSchedule(lID, dk, dayType, "")
		if s == nil || s.Departures == nil {
			continue
		}
		travelSec := travelSecOf(s)
		oppKey := "0"
		if dk == "0" {
			oppKey = "1"
		}
		oppS := getDirectionSchedule(lID, oppKey, dayType, "")
		oppPhysical := physicalOn(oppKey)
		physThis := physicalOn(dk)
		var trips []*activeTrip
		foundLayover := false
		for _, depTime := range s.Departures {
			depSec := timeStringToSeconds(depTime)
			arrSec := depSec + travelSec
			hasDelayedLive := false
			for _, b := range physThis {
				if b.IsUndef("totalProgress") || jsNumber(b.Get("totalProgress")) >= 60 {
					hasDelayedLive = true
					break
				}
			}
			if nowSec >= depSec && (nowSec < arrSec || (nowSec < arrSec+480 && hasDelayedLive)) {
				el := nowSec - depSec
				trips = append(trips, &activeTrip{depTime: depTime, depSec: depSec, arrSec: arrSec, elapsedSec: el,
					progress: math.Max(0.01, math.Min(0.99, el/travelSec))})
			} else if nowSec < depSec && !foundLayover {
				layoverStart := depSec - 600
				oppInTransit := false
				if oppS != nil && oppS.Departures != nil {
					oppTravel := travelSecOf(oppS)
					prevArr := math.NaN()
					for _, d := range oppS.Departures {
						a := timeStringToSeconds(d) + oppTravel
						if a <= depSec && a >= depSec-1200 {
							prevArr = a
						}
					}
					if prevArr != 0 && !math.IsNaN(prevArr) {
						layoverStart = math.Max(depSec-900, prevArr)
						prevDep := prevArr - oppTravel
						theo := (nowSec - prevDep) / oppTravel
						for _, b := range oppPhysical {
							tp := totalProgressOr(b, 50)
							if theo <= 1.20 && math.Abs(theo-tp/100) <= 0.35 && tp < 85 {
								oppInTransit = true
								break
							}
						}
					}
				}
				if nowSec >= layoverStart && !oppInTransit {
					foundLayover = true
					trips = append(trips, &activeTrip{depTime: depTime, depSec: depSec, arrSec: arrSec, isTerminalLayover: true})
				}
			}
		}
		if trips == nil {
			trips = []*activeTrip{}
		}
		tripsByDir[dk] = trips
		totalScheduled += float64(len(trips))
	}

	lineMaxFleet := getScheduledFleetRequirement(lID, dayType, nowSec, true, "")
	totalScheduled = math.Min(totalScheduled, lineMaxFleet)

	liveCount, drCount := 0.0, 0.0
	for _, b := range known {
		if t.isPhysicalVehicle(b) {
			if truthy(b.Get("isEstimated")) {
				drCount++
			} else {
				liveCount++
			}
		}
	}
	maxSyntheticForLine := math.Max(0, totalScheduled-(liveCount+drCount))

	var nd struct{ terminalBus, terminalGhost, lineCap, dirAllowance, colocated, noPosition float64 }
	unpairedByDir := map[string]float64{"0": 0, "1": 0}

	for _, dk := range allDirKeys {
		di := int(parseIntOr(dk, 0))
		var routeObj *Obj
		if di < len(routes) && routes[di] != nil {
			routeObj = routes[di]
		} else if len(routes) > 0 {
			routeObj = routes[0]
		}
		if routeObj == nil {
			continue
		}
		raw := rawFilteredCoords(routeObj)
		if len(raw) < 2 {
			continue
		}
		table := buildPolylineDistanceTable(raw)
		if !(table.Total > 0) {
			continue
		}
		active := tripsByDir[dk]
		origin := raw[0]
		unmatched := 0.0
		for _, bus := range physicalOn(dk) {
			bl, bo := latOf(bus), lonOf(bus)
			if !truthy(bl) || !truthy(bo) {
				continue
			}
			dOrigin := distM(jsNumber(bl), jsNumber(bo), origin.Lat, origin.Lon)
			var layover *activeTrip
			for _, tr := range active {
				if tr.isTerminalLayover && !tr.paired {
					layover = tr
					break
				}
			}
			if layover != nil && dOrigin < 350 {
				layover.paired = true
				continue
			}
			snap := snapPointToPolyline(ptAny(bl, bo), raw)
			segDist := table.Cum[snap.Index] + distM(raw[snap.Index].Lat, raw[snap.Index].Lon, snap.Lat, snap.Lon)
			busProg := math.Max(0, math.Min(1, segDist/table.Total))
			best := -1
			minDiff := math.Inf(1)
			for i, tr := range active {
				if tr.paired || tr.isTerminalLayover {
					continue
				}
				diff := math.Abs(tr.progress - busProg)
				if diff < minDiff && diff <= 0.40 {
					minDiff = diff
					best = i
				}
			}
			if best != -1 {
				active[best].paired = true
			} else {
				unmatched++
			}
		}
		unpairedByDir[dk] = unmatched

		oppKey := "0"
		if dk == "0" {
			oppKey = "1"
		}
		oppPhysical := physicalOn(oppKey)
		claimed := map[string]bool{}
		sorted := append([]*activeTrip{}, active...)
		sort.SliceStable(sorted, func(i, j int) bool {
			return sorted[i].isTerminalLayover && !sorted[j].isTerminalLayover
		})
		for _, tr := range sorted {
			if tr.paired {
				continue
			}
			if tr.isTerminalLayover || tr.progress <= 0.20 {
				var incoming *Obj
				for _, b := range oppPhysical {
					if claimed[jsString(b.Get("vehicleId"))] {
						continue
					}
					bl, bo := latOf(b), lonOf(b)
					if !truthy(bl) || !truthy(bo) {
						continue
					}
					d := distM(origin.Lat, origin.Lon, jsNumber(bl), jsNumber(bo))
					near := d < 400
					atEnd := near
					if !b.IsUndef("totalProgress") {
						atEnd = jsNumber(b.Get("totalProgress")) >= 85
					}
					if atEnd && near {
						incoming = b
						break
					}
				}
				if incoming != nil {
					claimed[jsString(incoming.Get("vehicleId"))] = true
					tr.paired = true
					nd.terminalBus++
				}
			}
		}
	}

	type candidate struct {
		trip      *activeTrip
		dirKey    string
		dirIndex  int
		sched     *DirSchedule
		raw       []LatLon
		table     PolyTable
		maxForDir float64
		origin    LatLon
	}
	var cands []candidate
	for _, dk := range allDirKeys {
		di := int(parseIntOr(dk, 0))
		sched := getDirectionSchedule(lID, dk, dayType, "")
		if sched == nil || len(sched.Departures) == 0 {
			continue
		}
		var routeObj *Obj
		if di < len(routes) && routes[di] != nil {
			routeObj = routes[di]
		} else if len(routes) > 0 {
			routeObj = routes[0]
		}
		if routeObj == nil {
			continue
		}
		raw := rawFilteredCoords(routeObj)
		if len(raw) < 2 {
			continue
		}
		table := buildPolylineDistanceTable(raw)
		if !(table.Total > 0) {
			continue
		}
		active := tripsByDir[dk]
		synthable := func(tr *activeTrip) bool { return !tr.paired && (tr.isTerminalLayover || nowSec < tr.arrSec) }
		n := 0.0
		for _, tr := range active {
			if synthable(tr) {
				n++
			}
		}
		maxForDir := math.Max(0, n-unpairedByDir[dk])
		for _, tr := range active {
			if synthable(tr) {
				cands = append(cands, candidate{tr, dk, di, sched, raw, table, maxForDir, raw[0]})
			}
		}
	}
	sort.SliceStable(cands, func(i, j int) bool {
		pi, pj := 0, 0
		if cands[i].trip.isTerminalLayover {
			pi = 1
		}
		if cands[j].trip.isTerminalLayover {
			pj = 1
		}
		if pi != pj {
			return pi < pj
		}
		return cands[i].trip.depSec < cands[j].trip.depSec
	})

	var synth []*Obj
	for ci, cand := range cands {
		if float64(len(synth)) >= maxSyntheticForLine {
			nd.lineCap += float64(len(cands) - ci)
			break
		}
		onDir := 0.0
		for _, b := range synth {
			if b.Get("direction") == cand.dirKey {
				onDir++
			}
		}
		if onDir >= cand.maxForDir {
			nd.dirAllowance++
			continue
		}
		trip, sched, raw := cand.trip, cand.sched, cand.raw
		var lat, lon, bearingV, totalProgress, speedKmh float64
		var statusText, formattedStatus, delayBadge string
		var fromStop, toStop, fromSeq, toSeq any
		allCurrent := append(append([]*Obj{}, known...), synth...)

		if trip.isTerminalLayover {
			lat = round6(cand.origin.Lat)
			lon = round6(cand.origin.Lon)
			bearingV = 0
			if len(raw) > 1 {
				bearingV = bearing(raw[0].Lat, raw[0].Lon, raw[1].Lat, raw[1].Lon)
				if math.IsNaN(bearingV) {
					bearingV = 0
				}
			}
			totalProgress = 0
			speedKmh = 0
			statusText = "🅿️ Capçalera / Regulació (Sortida: " + trip.depTime + ")"
			formattedStatus = "Sortida " + trip.depTime
			delayBadge = "⚡ Estimat (Regulant)"
			fromStop = or(sched.OriginStop.Get("name"), "Capçalera")
			toStop = "Sortida a les " + trip.depTime
			fromSeq, toSeq = 1.0, 2.0
			var clash *Obj
			for _, b := range allCurrent {
				bl, bo := latOf(b), lonOf(b)
				if !truthy(bl) || !truthy(bo) {
					continue
				}
				if distM(lat, lon, jsNumber(bl), jsNumber(bo)) < 150 {
					clash = b
					break
				}
			}
			if clash != nil {
				if t.isPhysicalVehicle(clash) {
					nd.terminalBus++
				} else {
					nd.terminalGhost++
				}
				continue
			}
		} else {
			tbl := cand.table
			pt, ptBearing, ok := pointAtDistance(raw, &tbl, trip.progress*cand.table.Total)
			if !ok {
				nd.noPosition++
				continue
			}
			lat = round6(pt.Lat)
			lon = round6(pt.Lon)
			bearingV = ptBearing
			if math.IsNaN(bearingV) {
				bearingV = 0
			}
			totalProgress = jsRound(trip.progress * 100)
			speedKmh = 20
			statusText = "⚡ Posició estimada segons horari (Sortida: " + trip.depTime + ")"
			formattedStatus = "Teòric (" + trip.depTime + ")"
			delayBadge = "⚡ Estimat (sense GPS)"
			var stopsForDir []*Obj
			if cand.dirIndex < len(allDirections) && truthy(asObj(allDirections[cand.dirIndex]).Get("stops")) {
				stopsForDir = stopsList(asObj(allDirections[cand.dirIndex]).Get("stops"))
			} else if sched.StopsRaw != nil {
				stopsForDir = stopsList(any(sched.StopsRaw))
			}
			seg := t.findNearestSegment(lat, lon, stopsForDir)
			fromStop, toStop = seg.Get("fromStop"), seg.Get("toStop")
			fromSeq, toSeq = seg.Get("fromSeq"), seg.Get("toSeq")

			nearSame, nearCross := math.Inf(1), math.Inf(1)
			for _, ex := range allCurrent {
				el, eo := latOf(ex), lonOf(ex)
				if !truthy(el) || !truthy(eo) {
					continue
				}
				d := distM(lat, lon, jsNumber(el), jsNumber(eo))
				if jsString(ex.Get("direction")) == cand.dirKey {
					if d < nearSame {
						nearSame = d
					}
				} else if d < nearCross {
					nearCross = d
				}
			}
			if nearSame < ghostOverlapSameDirM || nearCross < ghostOverlapCrossDirM {
				held := t.wasGhostDrawnRecently(lID+"|"+cand.dirKey+"|"+trip.depTime) &&
					(nearSame < ghostReleaseSameDirM || nearCross < ghostReleaseCrossDirM)
				if !held {
					nd.colocated++
					continue
				}
			}
		}

		depClean := strings.Replace(trip.depTime, ":", "", 1)
		vID := "EST_" + lID + "_" + cand.dirKey + "_" + depClean
		t.markGhostDrawn(lID + "|" + cand.dirKey + "|" + trip.depTime)
		lineName := any(sched.LineName)
		if sched.LineName == "" {
			lineName = "Línia " + lID
		}
		delayFmt := "Horari teòric"
		if trip.isTerminalLayover {
			delayFmt = "A l'hora"
		}
		synth = append(synth, O(
			"tripId", "mataro_ghost_"+lID+"_"+cand.dirKey+"_"+depClean,
			"vehicleId", vID,
			"lineId", lID,
			"lineName", lineName,
			"direction", cand.dirKey,
			"directionName", sched.DirectionName,
			"origin", or(sched.OriginStop.Get("name"), ""),
			"destination", or(sched.TerminalStop.Get("name"), sched.DirectionName),
			"lat", lat,
			"lon", lon,
			"latitude", lat,
			"longitude", lon,
			"bearing", bearingV,
			"compass", getCompassDirection(bearingV),
			"speedKmh", speedKmh,
			"delayMins", 0.0,
			"delayFormatted", delayFmt,
			"delayBadgeText", delayBadge,
			"departureTime", trip.depTime,
			"isEstimated", true,
			"isRealTime", false,
			"isGhostVehicle", true,
			"isTerminalLayover", trip.isTerminalLayover,
			"statusText", statusText,
			"formattedStatus", formattedStatus,
			"recordedAt", isoString(dateMs),
			"timestamp", nowMsF,
			"fromStop", fromStop,
			"toStop", toStop,
			"fromSeq", fromSeq,
			"toSeq", toSeq,
			"totalProgress", totalProgress,
			"propulsion", nil,
			"isElectric", false,
			"isHybrid", false,
			"propulsionBadge", "🕒 Horari Teòric",
			"propulsionIcon", "⚡",
			"propulsionClass", "estimated",
			"modelName", "Flota Mataró Bus (Sense GPS)",
		))
	}

	var synthetic []*Obj
	if isBoth {
		synthetic = synth
	} else {
		want := numToString(float64(dirIdx))
		for _, b := range synth {
			if jsString(b.Get("direction")) == want {
				synthetic = append(synthetic, b)
			}
		}
	}
	notDrawn := func() *Obj {
		return O("terminal_bus", nd.terminalBus, "terminal_ghost", nd.terminalGhost, "line_cap", nd.lineCap,
			"direction_allowance", nd.dirAllowance, "colocated", nd.colocated, "no_position", nd.noPosition)
	}
	coverage := func(live, eff float64) float64 {
		if eff > 0 {
			return math.Min(100, jsRound(live/eff*100))
		}
		return 100
	}
	var fleetStatus *Obj
	if isBoth {
		eff := math.Min(lineMaxFleet, totalScheduled)
		fleetStatus = O(
			"scheduledVehicles", eff,
			"scheduledBuses", math.Max(0, eff-nd.terminalBus),
			"notDrawn", notDrawn(),
			"liveGpsVehicles", liveCount,
			"estimatedVehicles", float64(len(synth))+drCount,
			"deadReckonedVehicles", drCount,
			"fleetCoveragePct", coverage(liveCount, eff),
		)
	} else {
		dk := numToString(float64(dirIdx))
		phys := physicalOn(dk)
		liveOn := 0.0
		for _, b := range phys {
			if !truthy(b.Get("isEstimated")) {
				liveOn++
			}
		}
		dr := float64(len(phys)) - liveOn
		eff := float64(len(tripsByDir[dk]))
		fleetStatus = O(
			"scheduledVehicles", eff,
			"scheduledBuses", math.Max(0, eff-nd.terminalBus),
			"notDrawn", notDrawn(),
			"liveGpsVehicles", liveOn,
			"estimatedVehicles", float64(len(synthetic))+dr,
			"deadReckonedVehicles", dr,
			"fleetCoveragePct", coverage(liveOn, eff),
		)
	}
	return synthetic, fleetStatus
}

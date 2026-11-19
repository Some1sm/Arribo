package main

// Port of mataroTracker.js: the tracker type, dataset loading, static route
// templates, vehicle history, identity stitching and the line-details cache
// (source lines 1-77, 807-1395, 2595-2681).
//
// Node runs the tracker twice, once in the ingestion worker and once in the
// HTTP process, each single-threaded. Here each copy lives in a World whose
// mutex plays the event loop: tracker code runs holding it, and releases it
// (World.await) wherever the source awaits real I/O.

import (
	"log"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

// appRoot is the repository root: data/, src/data/ and public/ live under it.
var appRoot = func() string {
	if v := os.Getenv("ARRIBO_ROOT"); v != "" {
		return v
	}
	if exe, err := os.Executable(); err == nil {
		return filepath.Dir(exe)
	}
	return "."
}()

func srcDataDir() string { return filepath.Join(appRoot, "src", "data") }

// World is one of the two Node processes.
type World struct {
	name string
	mu   sync.Mutex
	// handoffs holds, innermost last, the spawners waiting for their async
	// function to reach its first await (guarded by mu itself).
	handoffs []chan struct{}
	tracker  *MataroTracker
	siri     *SiriClient
	fr       *FlightRecorder
}

// release ends the running synchronous stretch. As on Node's event loop, a
// spawner waiting for its async function goes on before any other task: the
// lock passes straight to it. Only with no spawner waiting is it unlocked.
func (w *World) release() {
	if n := len(w.handoffs); n > 0 {
		ch := w.handoffs[n-1]
		w.handoffs = w.handoffs[:n-1]
		close(ch)
		return
	}
	w.mu.Unlock()
}

// await runs f with the world released, like an await on real I/O.
func (w *World) await(f func()) {
	w.release()
	defer w.mu.Lock()
	f()
}

type inflight struct {
	done   chan struct{}
	val    any
	source *siriCacheEntry
}

type lineDetailsEntry struct {
	result     any
	source     *siriCacheEntry
	bucket     int64
	generation int
}

type stopDepCacheEntry struct {
	timestamp float64
	data      *Obj
}

type MataroTracker struct {
	w              *World
	agencyTimezone string

	linesData   []*Obj
	routesData  *Obj
	routesByID  map[string][]*Obj // routesData[lId] when it is an array
	coordsCache map[*Obj][]LatLon // parseFloat(Latitude/Longitude), normalised

	allStopsMap               *JSMap // sId -> *Obj
	staticLineCache           *JSMap // `${lId}_${dir}` -> *Obj
	vehicleHistory            *JSMap // vId -> *Obj
	ghostHysteresisMemory     *JSMap // ghost key -> float64 ms
	stopDeparturesMemoryCache *JSMap // key -> *stopDepCacheEntry
	stopCacheTtlMs            float64

	avisosCache      []any
	hasAvisos        bool
	avisosGen        int
	avisosCacheTime  float64
	avisosCacheTtlMs float64
	avisosRpcBackend func() (*Obj, error)
	avisosInflight   *inflight

	lineDetailsCache    *JSMap // key -> *lineDetailsEntry
	lineDetailsInflight map[string]*inflight
	lineCacheGen        int

	isInitialized bool
}

func newMataroTracker(w *World) *MataroTracker {
	t := &MataroTracker{
		w:                         w,
		agencyTimezone:            "Europe/Madrid",
		routesData:                O(),
		routesByID:                map[string][]*Obj{},
		coordsCache:               map[*Obj][]LatLon{},
		allStopsMap:               newJSMap(),
		staticLineCache:           newJSMap(),
		vehicleHistory:            newJSMap(),
		ghostHysteresisMemory:     newJSMap(),
		stopDeparturesMemoryCache: newJSMap(),
		stopCacheTtlMs:            35000,
		avisosCacheTtlMs:          5 * 60 * 1000,
		lineDetailsCache:          newJSMap(),
		lineDetailsInflight:       map[string]*inflight{},
	}
	t.loadDatasets()
	t.precompileStaticRoutes()
	return t
}

// routes is this.routesData[lId] || [].
func (t *MataroTracker) routes(lID string) []*Obj { return t.routesByID[lID] }

// routeCoords is (route.coords || []).map(c => ({lat: parseFloat(c.Latitude),
// lon: parseFloat(c.Longitude)})), already passed through normalizeCoord as
// every geoEngine call does.
func (t *MataroTracker) routeCoords(r *Obj) []LatLon {
	if c, ok := t.coordsCache[r]; ok {
		return c
	}
	raw, _ := r.Get("coords").([]any)
	out := make([]LatLon, 0, len(raw))
	for _, x := range raw {
		c, _ := x.(*Obj)
		out = append(out, LatLon{n0(parseFloatJS(c.Get("Latitude"))), n0(parseFloatJS(c.Get("Longitude")))})
	}
	t.coordsCache[r] = out
	return out
}

// polylinePairs is coords.map(c => [parseFloat(c.Latitude), parseFloat(c.Longitude)]).
func polylinePairs(r *Obj) []any {
	raw, _ := r.Get("coords").([]any)
	out := make([]any, 0, len(raw))
	for _, x := range raw {
		c, _ := x.(*Obj)
		out = append(out, []any{parseFloatJS(c.Get("Latitude")), parseFloatJS(c.Get("Longitude"))})
	}
	return out
}

func objList(v any) []*Obj {
	arr, _ := v.([]any)
	out := make([]*Obj, 0, len(arr))
	for _, x := range arr {
		o, _ := x.(*Obj)
		out = append(out, o)
	}
	return out
}

func (t *MataroTracker) lineInfo(lID string) *Obj {
	for _, l := range t.linesData {
		if jsString(l.Get("id")) == lID {
			return l
		}
	}
	return nil
}

func (t *MataroTracker) loadDatasets() {
	getFilePath := func(name string) string {
		pCity := filepath.Join(appRoot, "data", "cities", "mataro", name)
		if _, err := os.Stat(pCity); err == nil {
			return pCity
		}
		p1 := filepath.Join(appRoot, "data", name)
		if _, err := os.Stat(p1); err == nil {
			return p1
		}
		return pCity
	}
	readJSON := func(p string) (*Obj, bool) {
		b, err := os.ReadFile(p)
		if err != nil {
			return nil, false
		}
		v, err := parseJSON(b)
		if err != nil {
			log.Printf("[MataroTracker] Error loading datasets: %v", err)
			return nil, false
		}
		o, _ := v.(*Obj)
		return o, true
	}

	if raw, ok := readJSON(getFilePath("mataro_lineas.json")); ok {
		t.linesData = objList(raw.Get("message"))
	}
	if raw, ok := readJSON(getFilePath("mataro_routes_full.json")); ok && raw != nil {
		t.routesData = raw
		for _, k := range raw.Keys() {
			if arr, ok := raw.Get(k).([]any); ok {
				_ = arr
				t.routesByID[k] = objList(raw.Get(k))
			}
		}
	}

	stopDirections := newJSMap() // sId -> []string (insertion-ordered set)
	for _, k := range t.routesData.Keys() {
		if _, ok := t.routesData.Get(k).([]any); !ok {
			continue
		}
		for _, route := range t.routesByID[k] {
			stops, ok := route.Get("stops").([]any)
			if !ok {
				continue
			}
			term := ""
			if len(stops) > 0 {
				if last, _ := stops[len(stops)-1].(*Obj); last != nil {
					if n, ok := last.Get("name").(string); ok {
						term = reStopSuffix.ReplaceAllLiteralString(n, "")
					}
				}
			}
			if term == "" {
				term = jsString(or(route.Get("name"), ""))
			}
			for _, x := range stops {
				st, _ := x.(*Obj)
				sID := jsString(st.Get("id"))
				if !stopDirections.Has(sID) {
					stopDirections.Set(sID, []string{})
				}
				if term != "" {
					cur, _ := stopDirections.Get(sID)
					set := cur.([]string)
					found := false
					for _, s := range set {
						if s == term {
							found = true
							break
						}
					}
					if !found {
						stopDirections.Set(sID, append(set, term))
					}
				}
			}
		}
	}

	if raw, ok := readJSON(getFilePath("mataro_paradas.json")); ok {
		for _, p := range objList(raw.Get("message")) {
			sID := jsString(p.Get("id"))
			var rawDests []string
			if v, ok := stopDirections.Get(sID); ok {
				rawDests = v.([]string)
			}
			var clean []string
			for _, d := range rawDests {
				clean = append(clean, jsTrim(reStopSuffix.ReplaceAllLiteralString(d, "")))
			}
			clean = uniqueStrings(clean)
			dests := []string{}
			for _, d := range clean {
				if d != "" {
					dests = append(dests, d)
				}
			}
			dirText := ""
			if len(dests) > 0 {
				n := min(2, len(dests))
				dirText = "Sentit " + strings.Join(dests[:n], " / ")
			}
			lineas := or(p.Get("lineas"), []any{})
			t.allStopsMap.Set(sID, O(
				"id", sID,
				"name", reStopSuffix.ReplaceAllLiteralString(jsString(p.Get("name")), ""),
				"lat", p.Get("latitude"),
				"lon", p.Get("longitude"),
				"lineas", lineas,
				"directionText", dirText,
				"destinations", stringsToAny(dests),
			))
		}
	}
	log.Printf("[MataroTracker] Loaded %d lines, %d stops.", len(t.linesData), t.allStopsMap.Len())
}

func (t *MataroTracker) stopObj(sID string) *Obj {
	v, _ := t.allStopsMap.Get(sID)
	o, _ := v.(*Obj)
	return o
}

func (t *MataroTracker) staticStops(route *Obj, line *Obj) []any {
	out := []any{}
	for idx, s := range objList(route.Get("stops")) {
		g := t.stopObj(jsString(s.Get("id")))
		out = append(out, O(
			"id", jsString(s.Get("id")),
			"seq", float64(idx+1),
			"name", reStopSuffix.ReplaceAllLiteralString(jsString(s.Get("name")), ""),
			"lat", or(s.Get("latitude"), g.Get("lat")),
			"lon", or(s.Get("longitude"), g.Get("lon")),
			"code", jsString(s.Get("id")),
			"zone", "Mataró Urbà",
			"color", line.Get("color"),
		))
	}
	return out
}

func (t *MataroTracker) precompileStaticRoutes() {
	// A route's polyline is the same in every variant of its line; the
	// templates are only read (responses copy them), so they share one slice.
	polylines := map[*Obj][]any{}
	routePolyline := func(r *Obj) []any {
		if p, ok := polylines[r]; ok {
			return p
		}
		p := polylinePairs(r)
		polylines[r] = p
		return p
	}
	for _, line := range t.linesData {
		lID := jsString(line.Get("id"))
		routes := t.routes(lID)
		for _, dir := range []string{"0", "1", "both"} {
			isBoth := dir == "both"
			dirIdx := 0
			if !isBoth {
				dirIdx = int(parseIntOr(dir, 0))
			}
			var selected *Obj
			if dirIdx < len(routes) && routes[dirIdx] != nil {
				selected = routes[dirIdx]
			} else if len(routes) > 0 && routes[0] != nil {
				selected = routes[0]
			} else {
				selected = O("coords", []any{}, "stops", []any{})
			}
			polyline := routePolyline(selected)
			stops := t.staticStops(selected, line)
			allDirections := []any{}
			for idx, r := range routes {
				allDirections = append(allDirections, O(
					"dirId", numToString(float64(idx)),
					"name", r.Get("name"),
					"polyline", routePolyline(r),
					"stops", t.staticStops(r, line),
				))
			}
			directions := []any{}
			for idx, r := range routes {
				sc := 0.0
				if st, ok := r.Get("stops").([]any); ok {
					sc = float64(len(st))
				} else if truthy(r.Get("stops")) {
					sc = jsNumber(lengthOf(r.Get("stops")))
				}
				directions = append(directions, O(
					"dirId", numToString(float64(idx)),
					"routeId", r.Get("id"),
					"name", r.Get("name"),
					"stopsCount", sc,
				))
			}
			direction := "both"
			directionName := any("Ambdós sentits")
			if !isBoth {
				direction = numToString(float64(dirIdx))
				directionName = or(selected.Get("name"), jsString(line.Get("name")))
			}
			var secCoords, secStops any = nil, nil
			if isBoth && len(allDirections) > 1 {
				secCoords = allDirections[1].(*Obj).Get("polyline")
				secStops = allDirections[1].(*Obj).Get("stops")
			}
			t.staticLineCache.Set(lID+"_"+dir, O(
				"lineId", lID,
				"code", "L"+lID,
				"name", jsTrim(jsString(line.Get("name"))),
				"color", or(line.Get("color"), "#009485"),
				"agency", "Mataró Bus (Avanza)",
				"group", "mataro",
				"direction", direction,
				"directionName", directionName,
				"directions", directions,
				"totalStops", float64(len(stops)),
				"stops", stops,
				"coords", polyline,
				"polyline", polyline,
				"geometrySource", "gtfs",
				"geometryEstimated", false,
				"secondaryCoords", secCoords,
				"secondaryStops", secStops,
				"secondaryColor", "#38bdf8",
				"allDirections", allDirections,
			))
		}
	}
	log.Printf("[MataroTracker] ⚡ Pre-compiled %d static line route variants in memory.", t.staticLineCache.Len())
}

// lengthOf is v.length for a string or array (undefined otherwise).
func lengthOf(v any) any {
	switch x := v.(type) {
	case []any:
		return float64(len(x))
	case string:
		return float64(utf16Count(x))
	}
	return Undefined
}

func (t *MataroTracker) staticTemplate(key string) *Obj {
	v, _ := t.staticLineCache.Get(key)
	o, _ := v.(*Obj)
	return o
}

// normalizeLineId: '1', 1, 'mataro_1', 'L1', 'Line 1' -> '1'..'8'.
func (t *MataroTracker) normalizeLineId(lineID any) string {
	if isNullish(lineID) {
		return ""
	}
	s := jsLower(jsTrim(jsString(lineID)))
	if strings.HasPrefix(s, "mataro") {
		s = strings.TrimPrefix(s[6:], "_")
	}
	if strings.HasPrefix(s, "line") {
		s = strings.TrimPrefix(s[4:], "-")
	}
	if strings.HasPrefix(s, "linia") {
		s = strings.TrimPrefix(s[5:], "-")
	}
	if len(s) == 2 && s[0] == 'l' && s[1] >= '1' && s[1] <= '8' {
		s = s[1:]
	}
	return s
}

func (t *MataroTracker) isPhysicalVehicle(b *Obj) bool {
	if b == nil {
		return false
	}
	if truthy(b.Get("isGhostVehicle")) {
		return false
	}
	vID := jsString(or(b.Get("vehicleId"), or(b.Get("tripId"), "")))
	if strings.HasPrefix(vID, "EST_") || strings.Contains(vID, "ghost") {
		return false
	}
	return true
}

// normalizeStopId: '11' -> '1011' when that stop exists.
func (t *MataroTracker) normalizeStopId(stopID any) string {
	if isNullish(stopID) {
		return ""
	}
	s := jsTrim(jsString(stopID))
	if s == "" {
		return ""
	}
	if t.allStopsMap.Has(s) {
		return s
	}
	num := parseIntJS(s)
	if !math.IsNaN(num) && num > 0 && num < 1000 {
		c := numToString(1000 + num)
		if t.allStopsMap.Has(c) {
			return c
		}
	}
	return s
}

// recordVehicleState stores a vehicle's telemetry for dead reckoning.
func (t *MataroTracker) recordVehicleState(v *Obj) {
	if v == nil || !truthy(v.Get("vehicleId")) {
		return
	}
	vID := jsString(v.Get("vehicleId"))
	if strings.HasPrefix(vID, "EST_") || truthy(v.Get("isGhostVehicle")) || truthy(v.Get("isTheoretical")) {
		return
	}
	now := float64(nowMs())
	lID := t.normalizeLineId(or(v.Get("lineId"), v.Get("lineCode")))
	if lID == "" {
		return
	}
	speedNum := jsNumber(v.Get("speedKmh"))
	delayNum := jsNumber(v.Get("delayMins"))
	obsNum := jsNumber(v.Get("observedAt"))

	dir := v.Get("direction")
	if isUndef(dir) {
		dir = "0"
	}
	var speed, delay any = nil, nil
	if isFinite(speedNum) {
		speed = speedNum
	}
	if isFinite(delayNum) {
		delay = delayNum
	}
	hasSpeed := isFinite(speedNum)
	if !v.IsUndef("hasSpeed") {
		hasSpeed = truthy(v.Get("hasSpeed"))
	}
	hasDelay := isFinite(delayNum)
	if !v.IsUndef("hasDelay") {
		hasDelay = truthy(v.Get("hasDelay"))
	}
	var observedAt any
	if isFinite(obsNum) && obsNum > 0 {
		observedAt = obsNum
	} else {
		fr := v.Get("freshness")
		var x any = fr
		if truthy(fr) {
			x = jsNumber(objGet(fr, "observedAt"))
		}
		observedAt = or(x, nil)
	}
	t.vehicleHistory.Set(vID, O(
		"vehicleId", vID,
		"lineId", lID,
		"direction", jsString(dir),
		"lat", jsNumber(or(v.Get("lat"), v.Get("latitude"))),
		"lon", jsNumber(or(v.Get("lon"), v.Get("longitude"))),
		"bearing", jsNumber(or(v.Get("bearing"), 0.0)),
		"speedKmh", speed,
		"hasSpeed", hasSpeed,
		"delayMins", delay,
		"hasDelay", hasDelay,
		"lastSeen", jsNumber(or(v.Get("lastSeen"), or(v.Get("timestamp"), now))),
		"observedAt", observedAt,
		"directionName", or(v.Get("directionName"), ""),
		"origin", or(v.Get("origin"), ""),
		"destination", or(v.Get("destination"), ""),
		"isEstimated", truthy(v.Get("isEstimated")),
	))
}

// objGet reads a property of any value (undefined unless it is an object).
func objGet(v any, k string) any {
	if o, ok := v.(*Obj); ok {
		return o.Get(k)
	}
	if arr, ok := v.([]any); ok && k == "length" {
		return float64(len(arr))
	}
	if s, ok := v.(string); ok && k == "length" {
		return float64(utf16Count(s))
	}
	return Undefined
}

// syncFleetVehicles ingests a FLEET_UPDATE batch from the worker world.
func (t *MataroTracker) syncFleetVehicles(vehicles any) {
	list, ok := vehicles.([]any)
	if !ok {
		return
	}
	now := float64(nowMs())
	for _, x := range list {
		v, _ := x.(*Obj)
		if v == nil || !truthy(v.Get("vehicleId")) {
			continue
		}
		vID := jsString(v.Get("vehicleId"))
		if strings.HasPrefix(vID, "EST_") || truthy(v.Get("isGhostVehicle")) || truthy(v.Get("isTheoretical")) {
			continue
		}
		isMataro := strings.Contains(jsString(or(v.Get("agency"), "")), "Mataró") ||
			strings.HasPrefix(jsString(or(v.Get("lineCode"), "")), "L")
		if !isMataro {
			continue
		}
		c := v.Clone()
		c.Set("lastSeen", or(v.Get("lastSeen"), now))
		t.recordVehicleState(c)
	}
	t.invalidateLineDetailsCache()
}

// getLines lists the urban lines L1..L8.
func (t *MataroTracker) getLines() []any {
	out := make([]any, 0, len(t.linesData))
	for _, l := range t.linesData {
		routes := t.routes(jsString(l.Get("id")))
		dirs := []any{}
		for idx, r := range routes {
			sc := 0.0
			if truthy(r.Get("stops")) {
				sc = jsNumber(lengthOf(r.Get("stops")))
			}
			dirs = append(dirs, O(
				"dirId", numToString(float64(idx)),
				"routeId", r.Get("id"),
				"name", r.Get("name"),
				"stopsCount", sc,
			))
		}
		out = append(out, O(
			"id", jsString(l.Get("id")),
			"code", "L"+jsString(l.Get("id")),
			"name", jsTrim(jsString(l.Get("name"))),
			"color", or(l.Get("color"), "#009485"),
			"agency", "Mataró Bus",
			"group", "mataro",
			"mode", "Urbà Mataró",
			"directions", dirs,
		))
	}
	return out
}

func (t *MataroTracker) resolveLineConfig(lineID any) *Obj {
	clean := t.normalizeLineId(lineID)
	for _, l := range t.linesData {
		if jsLower(jsString(l.Get("id"))) == clean {
			return l
		}
	}
	return nil
}

// getNearbyStops returns the stops within radius of (lat, lon), nearest first.
func (t *MataroTracker) getNearbyStops(lat, lon any, radius any, limit any) []any {
	if isUndef(radius) {
		radius = 800.0
	}
	if isUndef(limit) {
		limit = 6.0
	}
	userLat := parseFloatJS(lat)
	userLon := parseFloatJS(lon)
	if math.IsNaN(userLat) || math.IsNaN(userLon) {
		return []any{}
	}
	radiusN := jsNumber(radius)
	var cands []*Obj
	for _, k := range t.allStopsMap.Keys() {
		stop := t.stopObj(k)
		if !truthy(stop.Get("lat")) || !truthy(stop.Get("lon")) {
			continue
		}
		dist := distM(userLat, userLon, jsNumber(stop.Get("lat")), jsNumber(stop.Get("lon")))
		if dist <= radiusN {
			lines := []any{}
			for _, l := range objList(or(stop.Get("lineas"), []any{})) {
				lines = append(lines, O("id", jsString(l.Get("id")), "code", "L"+jsString(l.Get("id")), "name", l.Get("name")))
			}
			cands = append(cands, O(
				"id", stop.Get("id"),
				"code", stop.Get("id"),
				"name", stop.Get("name"),
				"lat", stop.Get("lat"),
				"lon", stop.Get("lon"),
				"lines", lines,
				"distanceMeters", jsRound(dist),
				"walkingMinutes", math.Max(1, jsRound(dist/80)),
			))
		}
	}
	sort.SliceStable(cands, func(i, j int) bool { return cands[i].Num("distanceMeters") < cands[j].Num("distanceMeters") })
	n := jsSliceLen(len(cands), jsNumber(limit))
	out := make([]any, 0, n)
	for _, c := range cands[:n] {
		out = append(out, c)
	}
	return out
}

// getNearbyStopsWithDepartures adds each stop's next three departures.
func (t *MataroTracker) getNearbyStopsWithDepartures(lat, lon, radius, limit any) []any {
	if isUndef(radius) {
		radius = 800.0
	}
	if isUndef(limit) {
		limit = 5.0
	}
	stops := t.getNearbyStops(lat, lon, radius, limit)
	out := make([]any, 0, len(stops))
	for _, x := range stops {
		stop := x.(*Obj)
		dep := t.getStopDepartures(stop.Get("id"), "", "0", O())
		deps, _ := dep.Get("departures").([]any)
		upcoming := deps
		if len(upcoming) > 3 {
			upcoming = upcoming[:3]
		}
		c := stop.Clone()
		c.Set("departures", append([]any{}, upcoming...))
		c.Set("totalDepartures", float64(len(deps)))
		out = append(out, c)
	}
	return out
}

var reNonAlnumLower = regexp.MustCompile(`[^a-z0-9]`)

func cleanAlnum(v any) string {
	return reNonAlnumLower.ReplaceAllLiteralString(jsLower(jsString(or(v, ""))), "")
}

// matchVehicleToRouteIndex picks a vehicle's direction (0 = Anada, 1 = Tornada).
func (t *MataroTracker) matchVehicleToRouteIndex(v *Obj, routes []*Obj) int {
	if len(routes) <= 1 {
		return 0
	}
	if d := v.Get("direction"); !isNullish(d) && d != "" {
		p := parseIntJS(d)
		if !math.IsNaN(p) && p >= 0 && p < float64(len(routes)) {
			return int(p)
		}
	}
	cleanDir := cleanAlnum(v.Get("directionName"))
	cleanDest := cleanAlnum(v.Get("destination"))

	for i, r := range routes {
		cr := cleanAlnum(r.Get("name"))
		if cleanDir != "" && cr != "" && cleanDir == cr {
			return i
		}
	}
	for i, r := range routes {
		parts := strings.Split(jsString(or(r.Get("name"), "")), "-")
		dp := ""
		if len(parts) > 1 && parts[1] != "" {
			dp = parts[1]
		} else if parts[0] != "" {
			dp = parts[0]
		}
		dp = reNonAlnumLower.ReplaceAllLiteralString(jsLower(dp), "")
		if cleanDest != "" && dp != "" && (strings.Contains(dp, cleanDest) || strings.Contains(cleanDest, dp)) {
			return i
		}
	}
	for i, r := range routes {
		cr := cleanAlnum(r.Get("name"))
		if cleanDir != "" && cr != "" && (strings.Contains(cleanDir, cr) || strings.Contains(cr, cleanDir)) {
			return i
		}
	}

	vLat := v.Get("lat")
	if isUndef(vLat) {
		vLat = v.Get("latitude")
	}
	vLon := v.Get("lon")
	if isUndef(vLon) {
		vLon = v.Get("longitude")
	}
	if truthy(vLat) && truthy(vLon) {
		best := 0
		minD := math.Inf(1)
		p := LatLon{n0(jsNumber(vLat)), n0(jsNumber(vLon))}
		for i, r := range routes {
			var coords []LatLon
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
					coords = append(coords, LatLon{lat, lon})
				}
			}
			if len(coords) < 2 {
				continue
			}
			snap := snapPointToPolyline(p, coords)
			dist := snap.Dist
			if vb := v.Get("bearing"); !isNullish(vb) {
				diff := math.Abs(math.Mod(jsNumber(vb)-snap.Bearing+540, 360) - 180)
				if diff > 100 {
					dist += 1200
				}
			}
			if dist < minD {
				minD = dist
				best = i
			}
		}
		return best
	}
	return 0
}

// isAnonymousVehicle: a fix the operator never identified ("Bus", empty...).
func (t *MataroTracker) isAnonymousVehicle(v *Obj) bool {
	if v == nil {
		return true
	}
	raw := ""
	if !v.IsNullish("vehicleId") {
		raw = jsTrim(jsString(v.Get("vehicleId")))
	}
	if raw == "" {
		return true
	}
	l := jsLower(raw)
	return l == "bus" || l == "vehicle" || l == "unknown"
}

// stitchAnonymousVehicles gives anonymous fixes the id of a recently seen bus.
func (t *MataroTracker) stitchAnonymousVehicles(live []any, lineID string, routes []*Obj, now float64) []any {
	if len(live) == 0 {
		return live
	}
	hasAnon := false
	for _, x := range live {
		if t.isAnonymousVehicle(asObj(x)) {
			hasAnon = true
			break
		}
	}
	if !hasAnon {
		return live
	}
	activeKnown := map[string]bool{}
	for _, x := range live {
		v := asObj(x)
		if !t.isAnonymousVehicle(v) {
			activeKnown[jsTrim(jsString(v.Get("vehicleId")))] = true
		}
	}
	type cand struct {
		vehicleID  string
		obj        *Obj
		elapsedSec float64
	}
	var cands []cand
	for _, vID := range t.vehicleHistory.Keys() {
		hv, _ := t.vehicleHistory.Get(vID)
		hist := hv.(*Obj)
		clean := jsTrim(vID)
		if clean == "" || t.isAnonymousVehicle(O("vehicleId", clean)) {
			continue
		}
		if strings.HasPrefix(clean, "EST_") || truthy(hist.Get("isGhostVehicle")) || truthy(hist.Get("isTheoretical")) {
			continue
		}
		if jsString(hist.Get("lineId")) != lineID {
			continue
		}
		if activeKnown[clean] {
			continue
		}
		elapsed := (now - jsNumber(or(hist.Get("lastSeen"), 0.0))) / 1000
		if math.Abs(elapsed) <= 90 {
			cands = append(cands, cand{clean, O(
				"vehicleId", clean,
				"direction", hist.Get("direction"),
				"lat", hist.Get("lat"),
				"lon", hist.Get("lon"),
				"bearing", hist.Get("bearing"),
				"speedKmh", hist.Get("speedKmh"),
				"delayMins", hist.Get("delayMins"),
				"lineName", hist.Get("lineName"),
				"directionName", hist.Get("directionName"),
				"origin", hist.Get("origin"),
				"destination", hist.Get("destination"),
			), math.Max(0, elapsed)})
		}
	}
	if len(cands) == 0 {
		return live
	}
	claimed := map[string]bool{}
	for _, x := range live {
		anon := asObj(x)
		if !t.isAnonymousVehicle(anon) {
			continue
		}
		aLat := anon.Get("lat")
		if isUndef(aLat) {
			aLat = anon.Get("latitude")
		}
		aLon := anon.Get("lon")
		if isUndef(aLon) {
			aLon = anon.Get("longitude")
		}
		if !truthy(aLat) || !truthy(aLon) {
			continue
		}
		anonDir := t.matchVehicleToRouteIndex(anon, routes)
		var best *cand
		bestScore := math.Inf(1)
		for i := range cands {
			c := &cands[i]
			if claimed[c.vehicleID] {
				continue
			}
			dist := distM(jsNumber(c.obj.Get("lat")), jsNumber(c.obj.Get("lon")), jsNumber(aLat), jsNumber(aLon))
			if dist > math.Max(400, (c.elapsedSec+15)*22) {
				continue
			}
			dirMatch := true
			if d := c.obj.Get("direction"); !isNullish(d) {
				dirMatch = jsString(d) == numToString(float64(anonDir))
			}
			score := dist
			if !dirMatch {
				score += 2500
			}
			if score < bestScore {
				bestScore = score
				best = c
			}
		}
		if best == nil {
			continue
		}
		b := best.obj
		claimed[best.vehicleID] = true
		activeKnown[best.vehicleID] = true
		anon.Set("vehicleId", best.vehicleID)
		anon.Set("stitchedFromHistory", true)
		for _, k := range []string{"lineName", "directionName", "origin", "destination"} {
			if !truthy(anon.Get(k)) && truthy(b.Get(k)) {
				anon.Set(k, b.Get(k))
			}
		}
		pick := func(k string) any {
			if !anon.IsUndef(k) {
				return anon.Get(k)
			}
			return b.Get(k)
		}
		prev, _ := t.vehicleHistory.Get(best.vehicleID)
		h := O()
		if po, ok := prev.(*Obj); ok {
			h = po.Clone()
		}
		h.Set("vehicleId", best.vehicleID)
		h.Set("lineId", lineID)
		h.Set("direction", numToString(float64(anonDir)))
		h.Set("lat", aLat)
		h.Set("lon", aLon)
		h.Set("bearing", pick("bearing"))
		h.Set("speedKmh", pick("speedKmh"))
		h.Set("delayMins", pick("delayMins"))
		h.Set("lastSeen", now)
		h.Set("directionName", or(anon.Get("directionName"), b.Get("directionName")))
		h.Set("origin", or(anon.Get("origin"), b.Get("origin")))
		h.Set("destination", or(anon.Get("destination"), b.Get("destination")))
		t.vehicleHistory.Set(best.vehicleID, h)
		t.vehicleHistory.Delete("Bus")
		t.vehicleHistory.Delete("bus")
	}
	return live
}

func asObj(v any) *Obj {
	o, _ := v.(*Obj)
	return o
}

// getLineDetails serves the computed line view, cached for one second per
// SIRI snapshot. opts nil is the default {}.
func (t *MataroTracker) getLineDetails(lineID any, direction any, opts *Obj) *Obj {
	if isUndef(direction) {
		direction = "0"
	}
	direction, opts, notPlain := directionAsOptions(direction, opts)
	lID := t.normalizeLineId(lineID)
	if lID == "" {
		lID = "1"
	}
	if !mataroAgency.hasLine(lID) || notPlain || (opts != nil && opts.Len() > 0) {
		return t.computeLineDetails(lineID, direction, opts)
	}
	dirKey := "both"
	if direction != "both" {
		dirKey = numToString(parseIntOr(direction, 0))
	}
	now := float64(nowMs())
	bucket := int64(math.Floor(now / 1000))
	generation := t.lineCacheGen
	source := t.w.siri.cacheEntry("veh_" + lID)
	sourceFresh := source != nil && now-source.ts < t.w.siri.cacheTtlMs
	key := lID + "_" + dirKey
	if cv, ok := t.lineDetailsCache.Get(key); ok {
		c := cv.(*lineDetailsEntry)
		if sourceFresh && c.bucket == bucket && c.source == source && c.generation == generation {
			return deepClone(c.result).(*Obj)
		}
	}
	inflightKey := key + "_" + numToString(float64(bucket)) + "_" + numToString(float64(generation))
	pending := t.lineDetailsInflight[inflightKey]
	if pending == nil || pending.source != source {
		pending = &inflight{done: make(chan struct{}), source: source}
		t.lineDetailsInflight[inflightKey] = pending
		result := t.computeLineDetails(lID, dirKey, nil)
		cur := t.w.siri.cacheEntry("veh_" + lID)
		if generation == t.lineCacheGen && bucket == int64(math.Floor(float64(nowMs())/1000)) && source == cur {
			t.lineDetailsCache.Set(key, &lineDetailsEntry{result: result, source: cur, bucket: bucket, generation: generation})
			if t.lineDetailsCache.Len() > 24 {
				t.lineDetailsCache.Delete(t.lineDetailsCache.Keys()[0])
			}
		}
		pending.val = result
		close(pending.done)
		if t.lineDetailsInflight[inflightKey] == pending {
			delete(t.lineDetailsInflight, inflightKey)
		}
		return deepClone(result).(*Obj)
	}
	p := pending
	t.w.await(func() { <-p.done })
	return deepClone(p.val).(*Obj)
}

// directionAsOptions is the source's
//
//	if (typeof direction === 'object' && direction !== null) { options = direction; direction = '0'; }
//
// A query string can make direction an array or an object. An array read
// as options has no named fields (an empty options object here) but is not
// a plain object, which getLineDetails treats as "do not cache".
func directionAsOptions(direction any, opts *Obj) (any, *Obj, bool) {
	switch d := direction.(type) {
	case *Obj:
		if d != nil {
			return "0", d, false
		}
	case []any:
		return "0", O(), true
	}
	return direction, opts, false
}

func (t *MataroTracker) invalidateLineDetailsCache() {
	t.lineCacheGen++
	t.lineDetailsCache.Clear()
}

// fetchLiveVehicles is the BaseTracker interface: a line's active buses.
func (t *MataroTracker) fetchLiveVehicles(lineID any) []any {
	lID := t.normalizeLineId(lineID)
	if lID == "" {
		lID = "1"
	}
	d := t.getLineDetails(lID, "both", nil)
	if a, ok := d.Get("activeBuses").([]any); ok {
		return a
	}
	return []any{}
}

func (t *MataroTracker) fetchStopArrivals(stopID, lineID, direction any) []any {
	sID := t.normalizeStopId(stopID)
	deps := t.getStopDepartures(sID, lineID, direction, O())
	if a, ok := deps.Get("departures").([]any); ok {
		return a
	}
	return []any{}
}

const passedStopToleranceM = 30

const (
	ghostOverlapSameDirM  = 100
	ghostOverlapCrossDirM = 250
	ghostReleaseSameDirM  = 350
	ghostReleaseCrossDirM = 600
	ghostHysteresisTTLMs  = 300000
)

func (t *MataroTracker) wasGhostDrawnRecently(key string) bool {
	t.pruneGhostHysteresis()
	return t.ghostHysteresisMemory.Has(key)
}

func (t *MataroTracker) markGhostDrawn(key string) {
	t.ghostHysteresisMemory.Set(key, float64(nowMs()))
	t.pruneGhostHysteresis()
}

func (t *MataroTracker) pruneGhostHysteresis() {
	cutoff := float64(nowMs()) - ghostHysteresisTTLMs
	for _, k := range t.ghostHysteresisMemory.Keys() {
		v, _ := t.ghostHysteresisMemory.Get(k)
		if v.(float64) < cutoff {
			t.ghostHysteresisMemory.Delete(k)
		}
	}
	if t.ghostHysteresisMemory.Len() <= 256 {
		return
	}
	keys := t.ghostHysteresisMemory.Keys()
	sort.SliceStable(keys, func(i, j int) bool {
		a, _ := t.ghostHysteresisMemory.Get(keys[i])
		b, _ := t.ghostHysteresisMemory.Get(keys[j])
		return a.(float64) < b.(float64)
	})
	for i := 0; i < len(keys)-256; i++ {
		t.ghostHysteresisMemory.Delete(keys[i])
	}
}

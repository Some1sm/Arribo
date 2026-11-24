package main

// Port of src/core/schedule/transitRouter.js and journeyTimeline.js: the
// "Com anar-hi" journey planner. Itineraries stay *Obj throughout because
// the source builds them with spreads and Object.assign, and the response's
// key order follows from that.

import (
	"bytes"
	"errors"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
)

type graphStop struct {
	obj      *Obj
	id, sh   string
	name     string
	lname    string // jsLower(name), compared per stop pair in buildCandidates
	lat, lon float64
}

type graphRoute struct {
	lineID, lineCode, color, direction string
	routeName, originName, destName    string
	stops                              []*graphStop
	coords                             [][]float64
}

type TransitRouter struct {
	t              *MataroTracker
	routesGraph    []*graphRoute
	isBuilt        bool
	candidateCache *JSMap // JSON key -> []*Obj
}

var (
	reShorthand     = regexp.MustCompile(`^10*`)
	reStopNumSuffix = regexp.MustCompile(` - \d+$`)
	reShortID       = regexp.MustCompile(`^[0-9]{1,3}$`)
	reAllDigitsPl   = regexp.MustCompile(`^\d+$`)
	reIsoDate       = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	reClockHM       = regexp.MustCompile(`^([01]?\d|2[0-3]):[0-5]\d$`)
)

func newTransitRouter(t *MataroTracker) *TransitRouter {
	r := &TransitRouter{t: t, candidateCache: newJSMap()}
	r.buildGraph()
	return r
}

// andJS is a && b.
func andJS(a, b any) any {
	if truthy(a) {
		return b
	}
	return a
}

func cleanName(v any) string {
	return jsTrim(reStopNumSuffix.ReplaceAllString(jsString(or(v, "")), ""))
}

func (r *TransitRouter) buildGraph() {
	r.candidateCache.Clear()
	t := r.t
	if t == nil || t.routesData == nil {
		return
	}
	r.routesGraph = nil
	cfgs := map[string]*Obj{}
	for _, l := range t.linesData {
		k := jsString(l.Get("id"))
		if _, ok := cfgs[k]; !ok {
			cfgs[k] = l
		}
		cfgs[k] = l
	}
	for _, lineID := range t.routesData.Keys() {
		cfg := cfgs[lineID]
		color := "#009485"
		if cfg != nil && truthy(cfg.Get("color")) {
			color = jsString(cfg.Get("color"))
		}
		dirRoutes, _ := t.routesData.Get(lineID).([]any)
		for dirIdx, rr := range dirRoutes {
			route, _ := rr.(*Obj)
			if route == nil {
				continue
			}
			rawStops, _ := route.Get("stops").([]any)
			var stops []*graphStop
			for idx, sr := range rawStops {
				s, _ := sr.(*Obj)
				if s == nil {
					s = O()
				}
				id := jsString(s.Get("id"))
				coords := s.Get("coords")
				lat := parseFloatJS(coalesce(coalesce(s.Get("latitude"), andJS(coords, fieldOf(coords, "lat"))), 0.0))
				lon := parseFloatJS(coalesce(coalesce(s.Get("longitude"), andJS(coords, fieldOf(coords, "lon"))), 0.0))
				name := cleanName(s.Get("name"))
				gs := &graphStop{id: id, sh: reShorthand.ReplaceAllString(id, ""), name: name, lname: jsLower(name), lat: lat, lon: lon}
				gs.obj = O("seq", float64(idx), "id", gs.id, "shorthandId", gs.sh, "name", gs.name, "lat", lat, "lon", lon)
				stops = append(stops, gs)
			}
			rawCoords, _ := route.Get("coords").([]any)
			var coords [][]float64
			for _, cr := range rawCoords {
				c, _ := cr.(*Obj)
				if c == nil {
					continue
				}
				la := parseFloatJS(coalesce(coalesce(c.Get("Latitude"), c.Get("lat")), c.Get("latitude")))
				lo := parseFloatJS(coalesce(coalesce(c.Get("Longitude"), c.Get("lon")), c.Get("longitude")))
				if isFinite(la) && isFinite(lo) {
					coords = append(coords, []float64{la, lo})
				}
			}
			if len(stops) > 1 {
				name := jsString(route.Get("name"))
				if !truthy(route.Get("name")) {
					name = stops[0].name + " ➔ " + stops[len(stops)-1].name
				}
				r.routesGraph = append(r.routesGraph, &graphRoute{
					lineID: lineID, lineCode: "L" + lineID, color: color, direction: itoa(dirIdx),
					routeName: name, originName: stops[0].name, destName: stops[len(stops)-1].name,
					stops: stops, coords: coords,
				})
			}
		}
	}
	r.isBuilt = true
}

// routeSlice is a leg polyline: raw[i:j] of a route's coordinates with the
// first and last points replaced by the stops'. It serializes exactly as the
// [][]float64 it stands for, without copying the route's points (cached
// plans hold many legs; the route coordinates are never modified).
type routeSlice struct {
	raw         [][]float64
	i, j        int // raw[i:j], at least two points
	first, last [2]float64
}

func (rs *routeSlice) Len() int { return rs.j - rs.i }

func (rs *routeSlice) At(k int) []float64 {
	switch k {
	case 0:
		return rs.first[:]
	case rs.Len() - 1:
		return rs.last[:]
	}
	return rs.raw[rs.i+k]
}

func (rs *routeSlice) WriteJSON(b *bytes.Buffer) {
	b.WriteByte('[')
	for k := 0; k < rs.Len(); k++ {
		if k > 0 {
			b.WriteByte(',')
		}
		writeJSON(b, rs.At(k))
	}
	b.WriteByte(']')
}

// polylineMeters sums the segment lengths of n points (at(k) is point k),
// skipping segments with a missing or non-finite latitude.
func polylineMeters(n int, at func(int) []float64) float64 {
	m := 0.0
	for p := 0; p < n-1; p++ {
		p1, p2 := at(p), at(p+1)
		if len(p1) > 0 && len(p2) > 0 && isFinite(p1[0]) && isFinite(p2[0]) {
			m += distM(p1[0], p1[1], p2[0], p2[1])
		}
	}
	return m
}

// sliceRoutePolyline returns a *routeSlice, or a two-point [][]float64 when
// the route has no usable stretch between the stops.
func (r *TransitRouter) sliceRoutePolyline(raw [][]float64, from, to *graphStop) any {
	fallback := [][]float64{{from.lat, from.lon}, {to.lat, to.lon}}
	if len(raw) < 2 {
		return fallback
	}
	closest := func(lat, lon float64, start int) int {
		best := start
		bestD := inf
		for i := start; i < len(raw); i++ {
			p := raw[i]
			if !isFinite(p[0]) || !isFinite(p[1]) {
				continue
			}
			if d := distM(lat, lon, p[0], p[1]); isFinite(d) && d < bestD {
				bestD, best = d, i
			}
		}
		return best
	}
	iStart := closest(from.lat, from.lon, 0)
	iEnd := closest(to.lat, to.lon, iStart)
	if iEnd+1-iStart < 2 {
		return fallback
	}
	return &routeSlice{raw: raw, i: iStart, j: iEnd + 1,
		first: [2]float64{from.lat, from.lon}, last: [2]float64{to.lat, to.lon}}
}

// stopCand is one origin/destination candidate: its JSON object plus the
// fields the planner reads back.
type stopCand struct {
	obj *Obj
	id  string
}

func stopLat(s *Obj) float64 { return parseFloatJS(coalesce(s.Get("lat"), s.Get("latitude"))) }
func stopLon(s *Obj) float64 { return parseFloatJS(coalesce(s.Get("lon"), s.Get("longitude"))) }

func walkMinutesFor(d float64) float64 {
	if d < 30 {
		return 0
	}
	return math.Max(1, jsRound(d/80))
}

func (r *TransitRouter) resolveStopCandidates(query any) ([]*stopCand, error) {
	t := r.t
	if t == nil || t.allStopsMap == nil || isNullish(query) {
		return nil, nil
	}
	all := t.allStopsMap
	if q, ok := query.(*Obj); ok && !q.IsUndef("lat") && !q.IsUndef("lon") {
		nLat, nLon := parseFloatJS(q.Get("lat")), parseFloatJS(q.Get("lon"))
		if !isFinite(nLat) || !isFinite(nLon) {
			return nil, nil
		}
		maxR := jsNumber(or(q.Get("radiusMeters"), 500.0))
		var nearby []*stopCand
		for _, k := range all.Keys() {
			raw, _ := all.Get(k)
			s, _ := raw.(*Obj)
			if s == nil {
				continue
			}
			sLat, sLon := stopLat(s), stopLon(s)
			if !isFinite(sLat) || !isFinite(sLon) {
				continue
			}
			d := distM(nLat, nLon, sLat, sLon)
			if isFinite(d) && d <= maxR {
				id := jsString(s.Get("id"))
				nearby = append(nearby, &stopCand{id: id, obj: O(
					"id", id, "shorthandId", reShorthand.ReplaceAllString(id, ""), "name", cleanName(s.Get("name")),
					"lat", sLat, "lon", sLon, "distanceMeters", jsRound(d), "walkingMinutes", math.Max(1, jsRound(d/80)),
					"isWalkPoint", true, "pointName", or(q.Get("name"), nil), "pointCoord", O("lat", nLat, "lon", nLon),
				)})
			}
		}
		sort.SliceStable(nearby, func(i, j int) bool {
			return nearby[i].obj.Num("distanceMeters") < nearby[j].obj.Num("distanceMeters")
		})
		if len(nearby) > 0 {
			if len(nearby) > 5 {
				nearby = nearby[:5]
			}
			return nearby, nil
		}
		nearest, err := r.findNearestStop(nLat, nLon, 800)
		if err != nil {
			return nil, err
		}
		if nearest != nil {
			nearest.obj.Set("isWalkPoint", true)
			nearest.obj.Set("pointName", or(q.Get("name"), nil))
			nearest.obj.Set("pointCoord", O("lat", nLat, "lon", nLon))
			return []*stopCand{nearest}, nil
		}
		return nil, nil
	}
	qStr := jsTrim(jsString(or(query, "")))
	if qStr == "" {
		return nil, nil
	}
	lower := jsLower(qStr)
	var base []*Obj
	if raw, ok := all.Get(qStr); ok {
		s, _ := raw.(*Obj)
		base = append(base, s)
	}
	if len(base) == 0 && reShortID.MatchString(qStr) {
		if raw, ok := all.Get("1" + padStart(qStr, 3, "0")); ok {
			s, _ := raw.(*Obj)
			base = append(base, s)
		}
	}
	for _, k := range all.Keys() {
		raw, _ := all.Get(k)
		s, _ := raw.(*Obj)
		if s == nil {
			continue
		}
		sName := jsLower(jsString(or(s.Get("name"), "")))
		if strings.Contains(sName, lower) || strings.Contains(lower, sName) {
			dup := false
			for _, b := range base {
				if b != nil && jsString(b.Get("id")) == jsString(s.Get("id")) {
					dup = true
					break
				}
			}
			if !dup {
				base = append(base, s)
			}
		}
	}
	if len(base) == 0 {
		return nil, nil
	}
	cands := newJSMap()
	reqObj := func(b *Obj) *Obj {
		id := jsString(b.Get("id"))
		return O("id", id, "shorthandId", reShorthand.ReplaceAllString(id, ""), "name", cleanName(b.Get("name")),
			"lat", stopLat(b), "lon", stopLon(b))
	}
	for _, b := range base {
		if b == nil {
			return nil, errTypeError
		}
		bID := jsString(b.Get("id"))
		if !cands.Has(bID) {
			ro := reqObj(b)
			cands.Set(bID, &stopCand{id: bID, obj: O("id", bID, "shorthandId", ro.Get("shorthandId"), "name", ro.Get("name"),
				"lat", ro.Get("lat"), "lon", ro.Get("lon"), "walkingMinutes", 0.0, "requestedStop", ro)})
		}
	}
	for _, b := range base {
		bLat, bLon := stopLat(b), stopLon(b)
		bClean := jsLower(cleanName(b.Get("name")))
		ro := reqObj(b)
		for _, k := range all.Keys() {
			raw, _ := all.Get(k)
			s, _ := raw.(*Obj)
			if s == nil {
				continue
			}
			sID := jsString(s.Get("id"))
			if cands.Has(sID) {
				continue
			}
			sClean := jsLower(cleanName(s.Get("name")))
			sLat, sLon := stopLat(s), stopLon(s)
			mk := func(dist float64) *stopCand {
				return &stopCand{id: sID, obj: O("id", sID, "shorthandId", reShorthand.ReplaceAllString(sID, ""),
					"name", cleanName(s.Get("name")), "lat", sLat, "lon", sLon, "distanceMeters", jsRound(dist),
					"walkingMinutes", walkMinutesFor(dist), "requestedStop", ro)}
			}
			if sClean == bClean {
				cands.Set(sID, mk(distM(bLat, bLon, sLat, sLon)))
				continue
			}
			if isFinite(bLat) && isFinite(sLat) {
				if dist := distM(bLat, bLon, sLat, sLon); dist <= 150 {
					cands.Set(sID, mk(dist))
				}
			}
		}
	}
	out := make([]*stopCand, 0, cands.Len())
	for _, k := range cands.Keys() {
		v, _ := cands.Get(k)
		out = append(out, v.(*stopCand))
	}
	return out, nil
}

func (r *TransitRouter) findNearestStop(lat, lon, maxD float64) (*stopCand, error) {
	if r.t == nil || r.t.allStopsMap == nil || !isFinite(lat) || !isFinite(lon) {
		return nil, nil
	}
	var closest *stopCand
	minD := inf
	all := r.t.allStopsMap
	for _, k := range all.Keys() {
		raw, _ := all.Get(k)
		s, _ := raw.(*Obj)
		if s == nil {
			continue
		}
		sLat, sLon := stopLat(s), stopLon(s)
		if !isFinite(sLat) || !isFinite(sLon) {
			continue
		}
		d := distM(lat, lon, sLat, sLon)
		if isFinite(d) && d < minD && d <= maxD {
			name, ok := s.Get("name").(string)
			if !ok {
				return nil, errTypeError
			}
			minD = d
			id := jsString(s.Get("id"))
			closest = &stopCand{id: id, obj: O("id", id, "shorthandId", reShorthand.ReplaceAllString(id, ""),
				"name", reStopNumSuffix.ReplaceAllString(name, ""), "lat", sLat, "lon", sLon,
				"distanceMeters", jsRound(d), "walkingMinutes", math.Max(1, jsRound(d/80)))}
		}
	}
	return closest, nil
}

// planOptions are the options server.js passes to planJourney.
type planOptions struct {
	originName, destName         any
	preference                   any
	walkingSpeed, maxWalkingDist any
	departureTime, departureDate any
	avisos                       any
}

var errTrim = errors.New("trim is not a function")

// trimStrict is v.trim(), which throws on anything but a string.
func trimStrict(v any) (string, error) {
	s, ok := v.(string)
	if !ok {
		return "", errTrim
	}
	return jsTrim(s), nil
}

func stopIndexIn(stops []*graphStop, id string) int {
	for i, s := range stops {
		if s.id == id || s.sh == id {
			return i
		}
	}
	return -1
}

func latLonOf(o *Obj) []float64       { return []float64{o.Num("lat"), o.Num("lon")} }
func gsLatLon(s *graphStop) []float64 { return []float64{s.lat, s.lon} }

// walkTo builds walkToFirstStop for candidate o boarding at first.
func walkTo(o *stopCand, first *graphStop, opt planOptions, origin any) (any, error) {
	if truthy(o.obj.Get("pointCoord")) && truthy(o.obj.Get("distanceMeters")) {
		rawV := or(or(or(o.obj.Get("pointName"), opt.originName), objectName(origin)), "")
		raw, err := trimStrict(rawV)
		if err != nil {
			return nil, err
		}
		fromName := "l'origen"
		if raw != "" && !reAllDigitsPl.MatchString(raw) {
			fromName = raw
		}
		pc := o.obj.ObjAt("pointCoord")
		dm := o.obj.Num("distanceMeters")
		return O("from", latLonOf(pc), "to", gsLatLon(first), "fromName", fromName, "toName", first.name,
			"distanceMeters", o.obj.Get("distanceMeters"),
			"walkingMinutes", or(o.obj.Get("walkingMinutes"), math.Max(1, jsRound(dm/80)))), nil
	}
	if rq := o.obj.ObjAt("requestedStop"); rq != nil && o.id != rq.Str("id") {
		var dist float64
		if dmv, isNum := o.obj.Get("distanceMeters").(float64); isNum && isFinite(dmv) {
			dist = dmv
		} else {
			dist = jsRound(distM(rq.Num("lat"), rq.Num("lon"), first.lat, first.lon))
		}
		return O("from", latLonOf(rq), "to", gsLatLon(first), "fromStop", rq, "toStop", first.obj,
			"fromName", rq.Get("name"), "toName", first.name, "distanceMeters", dist, "walkingMinutes", walkMinutesFor(dist)), nil
	}
	return nil, nil
}

func walkFrom(d *stopCand, last *graphStop, opt planOptions, destination any) (any, error) {
	if truthy(d.obj.Get("pointCoord")) && truthy(d.obj.Get("distanceMeters")) {
		rawV := or(or(or(d.obj.Get("pointName"), opt.destName), objectName(destination)), "")
		raw, err := trimStrict(rawV)
		if err != nil {
			return nil, err
		}
		toName := "la destinació"
		if raw != "" && !reAllDigitsPl.MatchString(raw) {
			toName = raw
		}
		pc := d.obj.ObjAt("pointCoord")
		dm := d.obj.Num("distanceMeters")
		return O("from", gsLatLon(last), "to", latLonOf(pc), "fromName", last.name, "toName", toName,
			"distanceMeters", d.obj.Get("distanceMeters"),
			"walkingMinutes", or(d.obj.Get("walkingMinutes"), math.Max(1, jsRound(dm/80)))), nil
	}
	if rq := d.obj.ObjAt("requestedStop"); rq != nil && d.id != rq.Str("id") {
		var dist float64
		if dmv, isNum := d.obj.Get("distanceMeters").(float64); isNum && isFinite(dmv) {
			dist = dmv
		} else {
			dist = jsRound(distM(last.lat, last.lon, rq.Num("lat"), rq.Num("lon")))
		}
		return O("from", gsLatLon(last), "to", latLonOf(rq), "fromStop", last.obj, "toStop", rq,
			"fromName", last.name, "toName", rq.Get("name"), "distanceMeters", dist, "walkingMinutes", walkMinutesFor(dist)), nil
	}
	return nil, nil
}

// objectName is (typeof x === 'object' ? x.name : ”).
func objectName(x any) any {
	switch v := x.(type) {
	case *Obj:
		return v.Get("name")
	case []any:
		return Undefined
	case nil:
		return Undefined // typeof null is 'object'; null.name throws, but origin is never null here
	}
	return ""
}

func walkMins(w any) float64 {
	if o, ok := w.(*Obj); ok {
		if v := o.Get("walkingMinutes"); truthy(v) {
			return jsNumber(v)
		}
	}
	return 0
}

func stopObjs(s []*graphStop) []any {
	out := make([]any, len(s))
	for i, x := range s {
		out[i] = x.obj
	}
	return out
}

func (r *TransitRouter) makeLeg(route *graphRoute, stops []*graphStop, ride float64) *Obj {
	first, last := stops[0], stops[len(stops)-1]
	dest := route.destName
	if dest == "" {
		dest = last.name
		if dest == "" {
			dest = "Destinació"
		}
	}
	n := float64(len(stops) - 1)
	return O(
		"lineId", route.lineID, "lineCode", route.lineCode, "lineColor", route.color, "color", route.color,
		"direction", route.direction, "destination", dest,
		"fromStop", first.obj, "toStop", last.obj, "intermediateStops", stopObjs(stops),
		"polyline", r.sliceRoutePolyline(route.coords, first, last),
		"stopsCount", n, "stopCount", n,
		"durationMinutes", ride, "durationMins", ride, "travelTimeMins", ride,
	)
}

// planJourney runs on the server's event loop (walking routes await).
func (r *TransitRouter) planJourney(w *World, origin, destination any, opt planOptions) (*Obj, error) {
	if !r.isBuilt {
		r.buildGraph()
	}
	orig, err := r.resolveStopCandidates(origin)
	if err != nil {
		return nil, err
	}
	dest, err := r.resolveStopCandidates(destination)
	if err != nil {
		return nil, err
	}
	if len(orig) == 0 || len(dest) == 0 {
		msg := "No hem trobat la parada de destinació."
		if len(orig) == 0 {
			msg = "No hem trobat la parada d'origen."
		}
		return O("success", false, "error", msg, "itineraries", []any{}), nil
	}
	oq, dq := "", ""
	if s, ok := origin.(string); ok {
		oq = jsLower(jsTrim(s))
	}
	if s, ok := destination.(string); ok {
		dq = jsLower(jsTrim(s))
	}
	if (oq != "" && oq == dq) || orig[0].id == dest[0].id {
		return O("success", true, "originStop", orig[0].obj, "destStop", dest[0].obj,
			"message", "L'origen i la destinació són la mateixa parada.", "itineraries", []any{}), nil
	}
	cacheKey := string(toJSON([]any{origin, destination}))
	var candidates []*Obj
	if v, ok := r.candidateCache.Get(cacheKey); ok {
		candidates = v.([]*Obj)
	} else {
		candidates, err = r.buildCandidates(orig, dest, opt, origin, destination)
		if err != nil {
			return nil, err
		}
		r.candidateCache.Set(cacheKey, candidates)
		if r.candidateCache.Len() > 32 {
			r.candidateCache.Delete(r.candidateCache.Keys()[0])
		}
	}
	var unique []*Obj
	for _, itin := range candidates {
		if strictEq(opt.preference, "direct_only") && itin.Str("type") != "direct" {
			continue
		}
		c := itin.Clone()
		legs := itin.Arr("legs")
		nl := make([]any, len(legs))
		for i, l := range legs {
			nl[i] = l.(*Obj).Clone()
		}
		c.Set("legs", nl)
		for _, f := range []string{"walkToFirstStop", "transferWalk", "walkFromLastStop"} {
			if wo, ok := itin.Get(f).(*Obj); ok {
				c.Set(f, wo.Clone())
			} else {
				c.Set(f, nil)
			}
		}
		unique = append(unique, c)
	}
	itineraries, err := evaluateJourneys(w, unique, r.t, opt)
	if err != nil {
		return nil, err
	}
	for _, itin := range itineraries {
		total := 0.0
		for _, l := range itin.Arr("legs") {
			leg := l.(*Obj)
			m := 0.0
			switch pl := leg.Get("polyline").(type) {
			case *routeSlice:
				m = polylineMeters(pl.Len(), pl.At)
			case [][]float64:
				m = polylineMeters(len(pl), func(k int) []float64 { return pl[k] })
			}
			if m < 100 && truthy(leg.Get("stopsCount")) {
				m = leg.Num("stopsCount") * 400
			}
			leg.Set("distanceMeters", jsRound(m))
			total += m
		}
		km := parseFloatJS(toFixed(total/1000, 1))
		grams := jsRound(km * 90)
		kg := parseFloatJS(toFixed(grams/1000, 2))
		formatted := "~" + numToString(grams) + " g"
		if grams >= 1000 {
			formatted = "~" + numToString(kg) + " kg"
		}
		itin.Set("transitDistanceKm", km)
		itin.Set("co2SavedGrams", grams)
		itin.Set("co2SavedKg", kg)
		itin.Set("co2Formatted", formatted)
		itin.Set("co2Label", "🌱 "+formatted+" CO₂ estalviats (aprox.)")
		itin.Set("co2BadgeHtml", "🌱 Estalvi aprox. "+formatted+" CO₂ respecte al cotxe")
		itin.Set("plannedDepartureTime", or(opt.departureTime, nil))
		itin.Set("plannedDepartureDate", or(opt.departureDate, nil))
		itin.Set("fare", itineraryFare(itin))
	}
	list := make([]any, len(itineraries))
	for i, x := range itineraries {
		list[i] = x
	}
	return O("success", true, "originStop", orig[0].obj, "destStop", dest[0].obj,
		"count", float64(len(itineraries)), "itineraries", list), nil
}

func itinKey(itin *Obj) string {
	var parts []string
	for _, l := range itin.Arr("legs") {
		leg := l.(*Obj)
		parts = append(parts, leg.Str("lineId")+":"+leg.Str("direction")+":"+leg.ObjAt("fromStop").Str("id")+":"+leg.ObjAt("toStop").Str("id"))
	}
	return strings.Join(parts, "|")
}

func (r *TransitRouter) buildCandidates(orig, dest []*stopCand, opt planOptions, origin, destination any) ([]*Obj, error) {
	var direct, transfer []*Obj
	seenDirect := map[string]bool{}
	seenTransfer := map[string]bool{}
	for _, o := range orig {
		for _, d := range dest {
			if o.id == d.id {
				continue
			}
			for _, route := range r.routesGraph {
				oi := stopIndexIn(route.stops, o.id)
				if oi == -1 {
					continue
				}
				di := stopIndexIn(route.stops, d.id)
				if di == -1 || di <= oi {
					continue
				}
				key := route.lineID + "_" + route.direction + "_" + o.id + "_" + d.id
				if seenDirect[key] {
					continue
				}
				seenDirect[key] = true
				inter := route.stops[oi : di+1]
				n := float64(di - oi)
				ride := math.Max(3, jsRound(n*1.8))
				w1, err := walkTo(o, inter[0], opt, origin)
				if err != nil {
					return nil, err
				}
				w2, err := walkFrom(d, inter[len(inter)-1], opt, destination)
				if err != nil {
					return nil, err
				}
				total := walkMins(w1) + ride + walkMins(w2)
				direct = append(direct, O(
					"type", "direct", "transfersCount", 0.0, "stopsCount", n, "stopCount", n,
					"rideMinutes", ride, "totalDurationMinutes", total, "totalDurationMins", total,
					"originStop", o.obj, "destStop", d.obj, "walkToFirstStop", w1, "walkFromLastStop", w2,
					"legs", []any{r.makeLeg(route, inter, ride)},
				))
			}
		}
	}
	for _, o := range orig {
		for _, d := range dest {
			if o.id == d.id {
				continue
			}
			for _, r1 := range r.routesGraph {
				oi := stopIndexIn(r1.stops, o.id)
				if oi == -1 {
					continue
				}
				for t1 := oi + 1; t1 < len(r1.stops); t1++ {
					ts := r1.stops[t1]
					for _, r2 := range r.routesGraph {
						if r2.lineID == r1.lineID {
							continue
						}
						di := stopIndexIn(r2.stops, d.id)
						if di == -1 {
							continue
						}
						type pt2 struct {
							idx  int
							stop *graphStop
							dist float64
						}
						var possible []pt2
						for i, s2 := range r2.stops {
							if i >= di {
								continue
							}
							if s2.id == ts.id || s2.sh == ts.id {
								possible = append(possible, pt2{i, s2, 0})
							} else if s2.lname == ts.lname {
								possible = append(possible, pt2{i, s2, distM(ts.lat, ts.lon, s2.lat, s2.lon)})
							} else if dist := distM(ts.lat, ts.lon, s2.lat, s2.lon); dist <= 160 {
								possible = append(possible, pt2{i, s2, dist})
							}
						}
						for _, p := range possible {
							if di <= p.idx {
								continue
							}
							key := r1.lineID + "_" + r2.lineID + "_" + ts.id + "_" + p.stop.id + "_" + o.id + "_" + d.id
							if seenTransfer[key] {
								continue
							}
							seenTransfer[key] = true
							leg1 := r1.stops[oi : t1+1]
							leg2 := r2.stops[p.idx : di+1]
							n1, n2 := float64(t1-oi), float64(di-p.idx)
							ride1 := math.Max(2, jsRound(n1*1.8))
							ride2 := math.Max(2, jsRound(n2*1.8))
							l1last, l2first := leg1[len(leg1)-1], leg2[0]
							tw := O("from", gsLatLon(l1last), "to", gsLatLon(l2first), "fromStop", l1last.obj, "toStop", l2first.obj,
								"distanceMeters", jsRound(p.dist), "walkingMinutes", math.Max(0, jsRound(p.dist/80)))
							w1, err := walkTo(o, leg1[0], opt, origin)
							if err != nil {
								return nil, err
							}
							w2, err := walkFrom(d, leg2[len(leg2)-1], opt, destination)
							if err != nil {
								return nil, err
							}
							total := walkMins(w1) + ride1 + 5 + ride2 + tw.Num("walkingMinutes") + walkMins(w2)
							transfer = append(transfer, O(
								"type", "transfer", "transfersCount", 1.0, "transferStop", ts.obj, "transferWalk", tw,
								"walkToFirstStop", w1, "walkFromLastStop", w2,
								"stopsCount", n1+n2, "stopCount", n1+n2, "rideMinutes", ride1+ride2,
								"transferWaitMinutes", 5.0, "totalDurationMinutes", total, "totalDurationMins", total,
								"originStop", o.obj, "destStop", d.obj,
								"legs", []any{r.makeLeg(r1, leg1, ride1), r.makeLeg(r2, leg2, ride2)},
							))
						}
					}
				}
			}
		}
	}
	m := newJSMap()
	for _, itin := range append(direct, transfer...) {
		m.Set(itinKey(itin), itin)
	}
	out := make([]*Obj, 0, m.Len())
	for _, k := range m.Keys() {
		v, _ := m.Get(k)
		out = append(out, v.(*Obj))
	}
	return out, nil
}

// ---------------------------------------------------------------- journeyTimeline

// requestedInstant is the departure instant asked for, or now.
func requestedInstant(depDate, depTime any, now float64) (float64, error) {
	if !truthy(depDate) && !truthy(depTime) {
		return now, nil
	}
	c := getDateComponents(int64(now))
	date := depDate
	if !truthy(date) {
		date = itoa(c.Year) + "-" + padStart(itoa(c.Month), 2, "0") + "-" + padStart(itoa(c.Day), 2, "0")
	}
	clock := depTime
	if !truthy(clock) {
		clock = padStart(itoa(c.Hour%24), 2, "0") + ":" + padStart(itoa(c.Minute), 2, "0")
	}
	if !reIsoDate.MatchString(jsString(date)) || !reClockHM.MatchString(jsString(clock)) {
		return 0, errors.New("Data o hora no vàlida")
	}
	ds, ok := date.(string)
	if !ok {
		return 0, errors.New("date.split is not a function")
	}
	cs, ok := clock.(string)
	if !ok {
		return 0, errors.New("clock.split is not a function")
	}
	dp := strings.Split(ds, "-")
	cp := strings.Split(cs, ":")
	y, m, d := int(stringToNumber(dp[0])), int(stringToNumber(dp[1])), int(stringToNumber(dp[2]))
	h, mi := int(stringToNumber(cp[0])), int(stringToNumber(cp[1]))
	candidate := float64(localTimeToUtcDate(y, m-1, d, h, mi, 0))
	matches := func(v float64) bool {
		k := getDateComponents(int64(v))
		return k.Year == y && k.Month == m && k.Day == d && k.Hour%24 == h && k.Minute == mi
	}
	if !matches(candidate) {
		return 0, errors.New("Data o hora inexistent a Europe/Madrid")
	}
	if matches(candidate - 3600000) {
		return candidate - 3600000, nil
	}
	return candidate, nil
}

type timelineDep struct {
	at          float64
	duration    float64
	dayType     string // "" for a live observation
	live        bool
	hasDuration bool
}

var planWeights = map[string][4]float64{
	"fastest":       {7, 2, 25, 0},
	"direct_only":   {7, 2, 25, 0},
	"least_walking": {5, 4, 60, 0.004},
}

func objField(o *Obj, k string) *Obj {
	v, _ := o.Get(k).(*Obj)
	return v
}

func durationSecondsOf(o *Obj) float64 {
	if o == nil {
		return 0
	}
	v := o.Get("durationSeconds")
	if truthy(v) {
		return jsNumber(v)
	}
	return 0
}

// stopKeyNum is offsets[id] as Number.isFinite sees it.
func finiteOffset(m *Obj, id string) (float64, bool) {
	if m == nil {
		return 0, false
	}
	v, ok := m.Get(id).(float64)
	return v, ok && isFinite(v)
}

func evaluateJourneys(w *World, candidates []*Obj, trk *MataroTracker, opt planOptions) ([]*Obj, error) {
	var activeAvisos []any
	if l, ok := opt.avisos.([]any); ok {
		activeAvisos = l
	} else if trk != nil && trk.hasAvisos {
		activeAvisos = trk.avisosCache
	}
	memo := map[string]*Obj{}
	cancellationsAt := func(lineID string, atMs float64) *Obj {
		minute := math.Floor(atMs/60000) * 60000
		key := lineID + "|" + numToString(minute)
		if v, ok := memo[key]; ok {
			return v
		}
		v := trk.getStopCancellations(lineID, activeAvisos, minute)
		memo[key] = v
		return v
	}
	now := float64(nowMs())
	start, err := requestedInstant(opt.departureDate, opt.departureTime, now)
	if err != nil {
		return nil, err
	}
	horizon := start + 86400000
	live := math.Abs(start-float64(nowMs())) < 1200000
	boards := map[string]*Obj{}
	budget := &walkBudget{remaining: 12}
	speed := jsNumber(opt.walkingSpeed)
	if !truthyNum(speed) {
		speed = 80
	}
	maxWalk := jsNumber(opt.maxWalkingDist)
	if !truthyNum(maxWalk) {
		maxWalk = 2000
	}
	var results []*Obj
	scheduleBoards := map[string][]timelineDep{}
	startDay := getDateComponents(int64(start))
	serviceDays := make([]DateComponents, 3)
	dayTypeByDate := map[string]string{}
	for i, off := range []int{-1, 0, 1} {
		ms := dateUTC(startDay.Year, startDay.Month-1, startDay.Day+off, 12, 0, 0)
		serviceDays[i] = getDateComponents(ms)
	}
	for _, day := range serviceDays {
		dayTypeByDate[day.DateStr] = resolveDayType(dateUTC(day.Year, day.Month-1, day.Day, 12, 0, 0)).DayType
	}
	configs := map[string]*DirSchedule{}
	walkFields := []string{"walkToFirstStop", "transferWalk", "walkFromLastStop"}

	for _, itin := range candidates {
		walkMeters := 0.0
		for _, field := range walkFields {
			wo := objField(itin, field)
			if wo == nil {
				continue
			}
			from, _ := wo.Get("from").([]float64)
			to, _ := wo.Get("to").([]float64)
			var res *walkResult
			var werr error
			w.await(func() { res, werr = walkRouter.route(from, to, speed, budget) })
			if werr != nil {
				return nil, werr
			}
			under := res.distanceMeters < 30
			wm, ds := 0.0, 0.0
			if !under {
				wm = math.Ceil(res.durationSeconds / 60)
				ds = res.durationSeconds
			}
			wo.Spread(res.toObj())
			wo.Set("durationSeconds", ds)
			wo.Set("walkingMinutes", wm)
			walkMeters += res.distanceMeters
		}
		if walkMeters > maxWalk {
			continue
		}
		cursor := start + durationSecondsOf(objField(itin, "walkToFirstStop"))*1000
		feasible := true
		rideSeconds, waitSeconds := 0.0, 0.0
		legs := itin.Arr("legs")
		for index, lr := range legs {
			leg := lr.(*Obj)
			if index > 0 {
				cursor += durationSecondsOf(objField(itin, "transferWalk")) * 1000
			}
			ready := cursor + 60000
			if index > 0 {
				ready = cursor + 120000
			}
			lineID := leg.Str("lineId")
			direction := leg.Str("direction")
			fromID := leg.ObjAt("fromStop").Str("id")
			toID := leg.ObjAt("toStop").Str("id")
			boardKey := lineID + "/" + direction + "/" + fromID
			schedKey := boardKey + "/" + toID
			var deps []timelineDep
			configKey := lineID + "/" + direction
			cfg, ok := configs[configKey]
			if !ok {
				cfg = getDirectionSchedule(lineID, direction, "", "")
				configs[configKey] = cfg
			}
			if live && trk != nil {
				board, ok := boards[boardKey]
				if !ok {
					board = safeStopDepartures(trk, fromID, lineID, direction)
					boards[boardKey] = board
				}
				var list []any
				if board != nil {
					list, _ = board.Get("departures").([]any)
				}
				for _, dr := range list {
					dep, _ := dr.(*Obj)
					if dep == nil {
						continue
					}
					dd := dep.Get("direction")
					keep := isNullish(dd)
					if !keep {
						ds := jsString(dd)
						// String(cfg?.dirId): "undefined" when there is no config
						// or the field is absent (the Go struct holds "").
						dirID, pathID := "undefined", "undefined"
						if cfg != nil && cfg.DirID != "" {
							dirID = cfg.DirID
						}
						if cfg != nil && cfg.PathID != "" {
							pathID = cfg.PathID
						}
						keep = direction == ds || dirID == ds || pathID == ds
					}
					if !keep {
						continue
					}
					at := nan
					if ms, ok := parseDateJS(jsString(or(dep.Get("expectedIso"), dep.Get("aimedIso")))); ok {
						at = float64(ms)
					}
					deps = append(deps, timelineDep{at: at, live: truthy(dep.Get("isRealTime"))})
				}
			}
			scheduled, ok := scheduleBoards[schedKey]
			if !ok {
				scheduled = []timelineDep{}
				for _, day := range serviceDays {
					dayType := dayTypeByDate[day.DateStr]
					sch := getDirectionSchedule(lineID, direction, dayType, "")
					fromIdx, toIdx := -1, -1
					if sch != nil {
						for idx, st := range sch.Stops {
							if fromIdx < 0 && st.ID == fromID {
								fromIdx = idx
							}
							if toIdx < 0 && st.ID == toID {
								toIdx = idx
							}
						}
					}
					if sch != nil && len(sch.Trips) > 0 && fromIdx >= 0 && toIdx > fromIdx {
						for ti, trip := range sch.Trips {
							if fromIdx >= len(trip.S) || toIdx >= len(trip.S) {
								continue
							}
							fs, ts := trip.S[fromIdx], trip.S[toIdx]
							if math.IsNaN(fs) || math.IsNaN(ts) || ts < fs {
								continue
							}
							sd := dateUTC(day.Year, day.Month-1, day.Day+int(math.Floor(fs/86400)), 0, 0, 0)
							st := msUTC(sd)
							at := float64(localTimeToUtcDate(st.Year(), int(st.Month())-1, st.Day(),
								int(math.Floor(fs/3600))%24, int(math.Floor(math.Mod(fs, 3600)/60)), int(math.Mod(fs, 60))))
							_ = ti
							scheduled = append(scheduled, timelineDep{at: at, dayType: dayType, duration: ts - fs, hasDuration: true})
						}
						continue
					}
					if sch == nil {
						continue
					}
					off, okOff := finiteOffset(sch.StopTravelSecMap, fromID)
					if !okOff {
						continue
					}
					for _, clk := range sch.Departures {
						secs := timeStringToSeconds(clk)
						sd := dateUTC(day.Year, day.Month-1, day.Day+int(math.Floor(secs/86400)), 0, 0, 0)
						st := msUTC(sd)
						base := float64(localTimeToUtcDate(st.Year(), int(st.Month())-1, st.Day(),
							int(math.Floor(secs/3600))%24, int(math.Floor(secs/60))%60, 0))
						scheduled = append(scheduled, timelineDep{at: base + off*1000, dayType: dayType})
					}
				}
				scheduleBoards[schedKey] = scheduled
			}
			observed := deps
			deps = make([]timelineDep, len(observed), len(observed)+len(scheduled))
			copy(deps, observed)
			for _, dep := range scheduled {
				dup := false
				for _, o := range observed {
					if math.Abs(o.at-dep.at) < 60000 {
						dup = true
						break
					}
				}
				if !dup {
					deps = append(deps, dep)
				}
			}

			legDirKey := resolveDirectionKey(getLineSchedule(lineID, ""), direction)
			legDirStr := legDirKey
			if legDirStr == "" {
				legDirStr = "null"
			}
			legDuration := func(dep timelineDep) float64 {
				dt := dep.dayType
				if dt == "" {
					dt = resolveDayType(int64(dep.at)).DayType
				}
				dc := getDirectionSchedule(lineID, direction, dt, "")
				var offs *Obj
				if dc != nil {
					offs = dc.StopTravelSecMap
				}
				fo, okF := finiteOffset(offs, fromID)
				to, okT := finiteOffset(offs, toID)
				if dep.hasDuration {
					return dep.duration
				}
				if okF && okT && to > fo {
					return to - fo
				}
				return math.Max(180, jsNumber(or(leg.Get("durationMinutes"), 3.0))*60)
			}
			cancelledAt := func(at float64, stopID string) bool {
				canc := cancellationsAt(lineID, at)
				if canc == nil {
					return false
				}
				list, _ := canc.Get("cancellations").([]any)
				for _, cr := range list {
					c, _ := cr.(*Obj)
					if c == nil {
						continue
					}
					if jsString(c.Get("stopId")) == stopID && (isNullish(c.Get("dirKey")) || jsString(c.Get("dirKey")) == legDirStr) {
						return true
					}
				}
				return false
			}
			isCancelled := func(dep timelineDep) bool {
				if !(len(activeAvisos) > 0 && trk != nil) {
					return false
				}
				est := legDuration(dep)
				if cancelledAt(dep.at, fromID) {
					return true
				}
				return cancelledAt(dep.at+est*1000, toID)
			}
			cands := make([]timelineDep, 0, len(deps))
			for _, dep := range deps {
				if isFinite(dep.at) && dep.at >= ready && dep.at <= horizon {
					cands = append(cands, dep)
				}
			}
			sort.SliceStable(cands, func(i, j int) bool { return cands[i].at < cands[j].at })
			var departure *timelineDep
			for i := range cands {
				if !isCancelled(cands[i]) {
					departure = &cands[i]
					break
				}
			}
			if departure == nil {
				feasible = false
				break
			}
			dt := departure.dayType
			if dt == "" {
				dt = resolveDayType(int64(departure.at)).DayType
			}
			dc := getDirectionSchedule(lineID, direction, dt, "")
			var offs *Obj
			var estimated []any
			if dc != nil {
				offs = dc.StopTravelSecMap
				estimated = dc.EstimatedStopIDs
			}
			fo, okF := finiteOffset(offs, fromID)
			to, okT := finiteOffset(offs, toID)
			touches := includesStrict(estimated, fromID) || includesStrict(estimated, toID)
			hasOffsets := okF && okT && to > fo
			exact := (departure.hasDuration || hasOffsets) && !touches
			var duration float64
			switch {
			case departure.hasDuration:
				duration = departure.duration
			case hasOffsets:
				duration = to - fo
			default:
				duration = math.Max(180, jsNumber(or(leg.Get("durationMinutes"), 3.0))*60)
			}
			wait := (departure.at - cursor) / 1000
			waitSeconds += wait
			rideSeconds += duration
			source := "heuristic"
			if exact {
				source = "timetable"
				if departure.live {
					source = "live"
				}
			}
			next := math.Ceil((departure.at - start) / 60000)
			leg.Set("boardAt", isoString(int64(departure.at)))
			leg.Set("alightAt", isoString(int64(departure.at+duration*1000)))
			leg.Set("departureTime", madridTime(int64(departure.at)).Format("15:04"))
			leg.Set("isRealTime", departure.live)
			leg.Set("timingSource", source)
			leg.Set("waitMinutes", math.Ceil(wait/60))
			leg.Set("nextDepartureMinutes", next)
			leg.Set("nextDepartureMins", next)
			leg.Set("durationMinutes", duration/60)
			leg.Set("durationMins", duration/60)
			leg.Set("travelTimeMins", duration/60)
			if index == 0 {
				itin.Set("initialWaitMinutes", leg.Get("waitMinutes"))
			} else {
				itin.Set("transferWaitMinutes", leg.Get("waitMinutes"))
			}
			cursor = departure.at + duration*1000
		}
		if !feasible {
			continue
		}
		cursor += durationSecondsOf(objField(itin, "walkFromLastStop")) * 1000
		if cursor > horizon {
			continue
		}
		walkSeconds := 0.0
		for _, f := range walkFields {
			walkSeconds += durationSecondsOf(objField(itin, f))
		}
		notices := newJSMap()
		if len(activeAvisos) > 0 && trk != nil {
			for _, lr := range legs {
				leg := lr.(*Obj)
				b, _ := parseDateJS(leg.Str("boardAt"))
				a, _ := parseDateJS(leg.Str("alightAt"))
				canc := cancellationsAt(leg.Str("lineId"), float64(b+a)/2)
				if canc == nil {
					continue
				}
				items := append(append([]any{}, listOf(canc.Get("cancellations"))...), listOf(canc.Get("provisional"))...)
				for _, ir := range items {
					item, _ := ir.(*Obj)
					if item == nil {
						continue
					}
					nid := item.Get("noticeId")
					key := mapKeyOf(nid)
					if notices.Has(key) {
						continue
					}
					var matched *Obj
					for _, ar := range activeAvisos {
						if a, ok := ar.(*Obj); ok && strictEq(a.Get("id"), nid) {
							matched = a
							break
						}
					}
					var mTitle, mURL any = Undefined, Undefined
					if matched != nil {
						mTitle, mURL = matched.Get("title"), matched.Get("url")
					}
					notices.Set(key, O("id", nid, "title", or(or(item.Get("title"), mTitle), ""),
						"url", or(mURL, "https://mataro.avanzagrupo.com/ca/avisos")))
				}
			}
		}
		noticeList := make([]any, 0, notices.Len())
		for _, k := range notices.Keys() {
			v, _ := notices.Get(k)
			noticeList = append(noticeList, v)
		}
		ids := make([]string, len(legs))
		anyHeuristic, anyLive := false, false
		for i, lr := range legs {
			leg := lr.(*Obj)
			ids[i] = leg.Str("lineId") + ":" + leg.Str("direction") + ":" + leg.ObjAt("fromStop").Str("id") + ":" + leg.ObjAt("toStop").Str("id")
			if leg.Str("timingSource") == "heuristic" {
				anyHeuristic = true
			}
			if truthy(leg.Get("isRealTime")) {
				anyLive = true
			}
		}
		source := "timetable"
		if anyHeuristic {
			source = "heuristic"
		} else if anyLive {
			source = "live"
		}
		first := legs[0].(*Obj)
		total := math.Ceil((cursor - start) / 60000)
		itin.Set("id", strings.Join(ids, "|"))
		itin.Set("requestedDepartureAt", isoString(int64(start)))
		itin.Set("arrivalAt", isoString(int64(cursor)))
		itin.Set("notices", noticeList)
		itin.Set("timesBasis", "published_trip")
		itin.Set("totalDurationMinutes", total)
		itin.Set("totalDurationMins", total)
		itin.Set("walkingMinutes", math.Ceil(walkSeconds/60))
		itin.Set("walkingDistanceMeters", walkMeters)
		itin.Set("rideMinutes", rideSeconds/60)
		itin.Set("waitMinutes", math.Ceil(waitSeconds/60))
		itin.Set("departureTime", first.Get("departureTime"))
		itin.Set("nextDepartureMinutes", first.Get("nextDepartureMinutes"))
		itin.Set("nextDepartureMins", first.Get("nextDepartureMinutes"))
		itin.Set("isRealTime", first.Get("isRealTime"))
		itin.Set("isFutureSchedule", !live)
		itin.Set("plannedDepartureTime", or(opt.departureTime, nil))
		itin.Set("plannedDepartureDate", or(opt.departureDate, nil))
		itin.Set("timingSource", source)
		results = append(results, itin)
	}

	wt, ok := planWeights[jsString(opt.preference)]
	if _, isStr := opt.preference.(string); !ok || !isStr {
		wt = planWeights["fastest"]
	}
	score := func(it *Obj) float64 {
		transfers := math.Max(0, float64(len(it.Arr("legs"))-1))
		if v, ok := it.Get("transfersCount").(float64); ok && isFinite(v) {
			transfers = v
		}
		arr, _ := parseDateJS(it.Str("arrivalAt"))
		return float64(arr)/60000 + transfers*wt[0] +
			math.Min(wt[2], jsNumber(or(it.Get("walkingMinutes"), 0.0))*wt[1]) +
			jsNumber(or(it.Get("walkingDistanceMeters"), 0.0))*wt[3]
	}
	cmp := func(a, b *Obj) float64 {
		if d := score(a) - score(b); d != 0 && !math.IsNaN(d) {
			return d
		}
		aa, _ := parseDateJS(a.Str("arrivalAt"))
		bb, _ := parseDateJS(b.Str("arrivalAt"))
		if d := float64(aa - bb); d != 0 {
			return d
		}
		return a.Num("walkingDistanceMeters") - b.Num("walkingDistanceMeters")
	}
	sort.SliceStable(results, func(i, j int) bool { return cmp(results[i], results[j]) < 0 })
	var selected []*Obj
	sigs := map[string]bool{}
	sawTransfer, sawDirect := false, false
	for _, it := range results {
		var parts []string
		for _, lr := range it.Arr("legs") {
			parts = append(parts, lr.(*Obj).Str("lineId"))
		}
		sig := strings.Join(parts, "->")
		if sigs[sig] {
			continue
		}
		if it.Num("transfersCount") > 0 {
			if !sawDirect && len(selected) >= 2 {
				continue
			}
			if sawTransfer && len(selected) >= 3 {
				continue
			}
			sawTransfer = true
		} else {
			sawDirect = true
		}
		sigs[sig] = true
		selected = append(selected, it)
		if len(selected) == 4 {
			break
		}
	}
	return selected, nil
}

// safeStopDepartures is the live board, or nil when it fails.
func safeStopDepartures(trk *MataroTracker, stopID, lineID, direction string) (b *Obj) {
	defer func() {
		if r := recover(); r != nil {
			b = nil
		}
	}()
	return trk.getStopDepartures(stopID, lineID, direction, nil)
}

func msUTC(ms int64) time.Time { return time.UnixMilli(ms).UTC() }

// stringIndexOf is list.findIndex(x => String(x) === id).
func stringIndexOf(list []any, id string) int {
	for i, x := range list {
		if jsString(x) == id {
			return i
		}
	}
	return -1
}

// includesStrict is list.includes(s) for a string s.
func includesStrict(list []any, s string) bool {
	for _, x := range list {
		if v, ok := x.(string); ok && v == s {
			return true
		}
	}
	return false
}

// mapKeyOf keys a Map by a primitive's identity (1 and "1" differ).
func mapKeyOf(v any) string {
	switch x := v.(type) {
	case string:
		return "s:" + x
	case float64:
		return "n:" + numToString(x)
	case nil:
		return "null"
	case undefinedT:
		return "undefined"
	case bool:
		if x {
			return "b:true"
		}
		return "b:false"
	}
	return "o:" + jsString(v)
}

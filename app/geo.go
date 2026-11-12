package main

// Port of src/core/geo/geoEngine.js, gapClusters.js, gapPath.js,
// gpsGapDetector.js and gapBuses.js.

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

const earthRadiusMeters = 6371000.0

func toRad(deg float64) float64 { return (deg * math.Pi) / 180 }
func toDeg(rad float64) float64 { return (rad * 180) / math.Pi }

// LatLon is { lat, lon }.
type LatLon struct{ Lat, Lon float64 }

func n0(f float64) float64 {
	if math.IsNaN(f) {
		return 0
	}
	return f
}

// normalizeCoordAny is geoEngine.normalizeCoord for any JS value.
func normalizeCoordAny(p any) LatLon {
	switch x := p.(type) {
	case nil, undefinedT:
		return LatLon{}
	case LatLon:
		return LatLon{n0(x.Lat), n0(x.Lon)}
	case []float64:
		var a, b float64 = math.NaN(), math.NaN()
		if len(x) > 0 {
			a = x[0]
		}
		if len(x) > 1 {
			b = x[1]
		}
		return LatLon{n0(a), n0(b)}
	case []any:
		var a, b any = Undefined, Undefined
		if len(x) > 0 {
			a = x[0]
		}
		if len(x) > 1 {
			b = x[1]
		}
		return LatLon{n0(jsNumber(a)), n0(jsNumber(b))}
	case *Obj:
		lat := coalesce(coalesce(coalesce(coalesce(x.Get("lat"), x.Get("latitude")), x.Get("Latitude")), x.Get("y")), 0.0)
		lon := coalesce(coalesce(coalesce(coalesce(coalesce(x.Get("lon"), x.Get("lng")), x.Get("longitude")), x.Get("Longitude")), x.Get("x")), 0.0)
		return LatLon{n0(jsNumber(lat)), n0(jsNumber(lon))}
	}
	return LatLon{}
}

// distM is calculateDistanceMeters(lat1, lon1, lat2, lon2) (NaN coords are 0).
func distM(lat1, lon1, lat2, lon2 float64) float64 {
	lat1, lon1, lat2, lon2 = n0(lat1), n0(lon1), n0(lat2), n0(lon2)
	if lat1 == lat2 && lon1 == lon2 {
		return 0
	}
	dLat := toRad(lat2 - lat1)
	dLon := toRad(lon2 - lon1)
	a := jsSin(dLat/2)*jsSin(dLat/2) + jsCos(toRad(lat1))*jsCos(toRad(lat2))*jsSin(dLon/2)*jsSin(dLon/2)
	c := 2 * jsAtan2(math.Sqrt(a), math.Sqrt(1-a))
	return earthRadiusMeters * c
}

func distLL(a, b LatLon) float64 { return distM(a.Lat, a.Lon, b.Lat, b.Lon) }

// bearing is calculateBearing (degrees, one decimal).
func bearing(lat1, lon1, lat2, lon2 float64) float64 {
	lat1, lon1, lat2, lon2 = n0(lat1), n0(lon1), n0(lat2), n0(lon2)
	if lat1 == lat2 && lon1 == lon2 {
		return 0
	}
	phi1 := toRad(lat1)
	phi2 := toRad(lat2)
	dl := toRad(lon2 - lon1)
	y := jsSin(dl) * jsCos(phi2)
	x := jsCos(phi1)*jsSin(phi2) - jsSin(phi1)*jsCos(phi2)*jsCos(dl)
	theta := jsAtan2(y, x)
	b := math.Mod(toDeg(theta)+360, 360)
	return jsRound(b*10) / 10
}

var compassDirs = [8][2]string{
	{"N", "Nord (N) ⬆️"}, {"NE", "Nord-Est (NE) ↗️"}, {"E", "Est (E) ➡️"}, {"SE", "Sud-Est (SE) ↘️"},
	{"S", "Sud (S) ⬇️"}, {"SW", "Sud-Oest (SO) ↙️"}, {"W", "Oest (O) ⬅️"}, {"NW", "Nord-Oest (NO) ↖️"},
}

func getCompassDirection(b float64) *Obj {
	norm := math.Mod(math.Mod(n0(b), 360)+360, 360)
	idx := int(jsRound(norm/45)) % 8
	return O("code", compassDirs[idx][0], "label", compassDirs[idx][1])
}

func round6(x float64) float64 { return jsRound(x*1000000) / 1000000 }

func interpolateCoordinate(p1, p2 LatLon, fraction float64) LatLon {
	f := math.Max(0, math.Min(1, n0(fraction)))
	return LatLon{round6(p1.Lat + f*(p2.Lat-p1.Lat)), round6(p1.Lon + f*(p2.Lon-p1.Lon))}
}

// SnapResult is snapPointToPolyline's { lat, lon, index, bearing, dist }.
type SnapResult struct {
	Lat, Lon float64
	Index    int
	Bearing  float64
	Dist     float64
}

func snapPointToPolyline(p LatLon, coords []LatLon) SnapResult {
	if len(coords) == 0 {
		return SnapResult{Lat: p.Lat, Lon: p.Lon}
	}
	if len(coords) == 1 {
		d := distM(p.Lat, p.Lon, coords[0].Lat, coords[0].Lon)
		return SnapResult{Lat: coords[0].Lat, Lon: coords[0].Lon, Dist: d}
	}
	minD := math.Inf(1)
	best := SnapResult{Lat: coords[0].Lat, Lon: coords[0].Lon}
	for i := 0; i < len(coords)-1; i++ {
		p1, p2 := coords[i], coords[i+1]
		x1, y1 := p1.Lon, p1.Lat
		x2, y2 := p2.Lon, p2.Lat
		px, py := p.Lon, p.Lat
		dx := x2 - x1
		dy := y2 - y1
		lenSq := dx*dx + dy*dy
		t := 0.0
		if lenSq > 0 {
			t = math.Max(0, math.Min(1, ((px-x1)*dx+(py-y1)*dy)/lenSq))
		}
		projX := x1 + t*dx
		projY := y1 + t*dy
		d := distM(p.Lat, p.Lon, projY, projX)
		if d < minD {
			minD = d
			best = SnapResult{
				Lat:     round6(projY),
				Lon:     round6(projX),
				Index:   i,
				Bearing: bearing(p1.Lat, p1.Lon, p2.Lat, p2.Lon),
				Dist:    jsRound(d*10) / 10,
			}
		}
	}
	return best
}

func calculatePolylineDistanceBetween(coords []LatLon, lat1, lon1, lat2, lon2 float64) float64 {
	if len(coords) < 2 {
		return distM(lat1, lon1, lat2, lon2)
	}
	s1 := snapPointToPolyline(LatLon{n0(lat1), n0(lon1)}, coords)
	s2 := snapPointToPolyline(LatLon{n0(lat2), n0(lon2)}, coords)
	startIdx := s1.Index
	endIdx := s2.Index
	if endIdx < startIdx {
		startIdx, endIdx = endIdx, startIdx
	}
	if startIdx == endIdx {
		return distM(s1.Lat, s1.Lon, s2.Lat, s2.Lon)
	}
	first, second := s1, s2
	if !(s1.Index <= s2.Index) {
		first, second = s2, s1
	}
	total := distM(first.Lat, first.Lon, coords[startIdx+1].Lat, coords[startIdx+1].Lon)
	for i := startIdx + 1; i < endIdx; i++ {
		total += distM(coords[i].Lat, coords[i].Lon, coords[i+1].Lat, coords[i+1].Lon)
	}
	total += distM(coords[endIdx].Lat, coords[endIdx].Lon, second.Lat, second.Lon)
	return math.Max(0, jsRound(total))
}

func calculateRouteTotalDistance(coords []LatLon) float64 {
	if len(coords) < 2 {
		return 0
	}
	d := 0.0
	for i := 0; i < len(coords)-1; i++ {
		d += distM(coords[i].Lat, coords[i].Lon, coords[i+1].Lat, coords[i+1].Lon)
	}
	return jsRound(d)
}

// ExtrapResult is extrapolatePolylinePosition's result.
type ExtrapResult struct {
	Lat, Lon, Bearing, Progress float64
	BearingRaw              any // currentPos.bearing || 0 when it came from the input
}

// extrapolatePolylinePosition: posBearing is `currentPos.bearing || 0`.
func extrapolatePolylinePosition(pos LatLon, posBearing any, elapsedSec, speedKmh float64, coords []LatLon) (ExtrapResult, bool) {
	if len(coords) < 2 {
		return ExtrapResult{}, false
	}
	snap := snapPointToPolyline(pos, coords)
	sp := speedKmh
	if math.IsNaN(sp) || sp == 0 {
		sp = 30
	}
	speed := math.Max(5, sp/3.6)
	advance := speed * math.Max(0, n0(elapsedSec))
	cur := snap.Index
	lastC := coords[len(coords)-1]
	tail := func() ExtrapResult {
		return ExtrapResult{Lat: lastC.Lat, Lon: lastC.Lon, BearingRaw: or(posBearing, 0.0), Progress: 100}
	}
	if cur >= len(coords)-1 {
		return tail(), true
	}
	toNext := distM(snap.Lat, snap.Lon, coords[cur+1].Lat, coords[cur+1].Lon)
	if toNext >= advance {
		frac := 0.0
		if toNext > 0 {
			frac = advance / toNext
		}
		lat := snap.Lat + frac*(coords[cur+1].Lat-snap.Lat)
		lon := snap.Lon + frac*(coords[cur+1].Lon-snap.Lon)
		b := bearing(snap.Lat, snap.Lon, coords[cur+1].Lat, coords[cur+1].Lon)
		return ExtrapResult{Lat: round6(lat), Lon: round6(lon), BearingRaw: b, Progress: math.Min(100, jsRound((float64(cur)+frac)/float64(len(coords))*100))}, true
	}
	acc := toNext
	cur++
	for cur < len(coords)-1 && acc < advance {
		p1, p2 := coords[cur], coords[cur+1]
		seg := distM(p1.Lat, p1.Lon, p2.Lat, p2.Lon)
		if acc+seg >= advance {
			frac := 0.0
			if seg > 0 {
				frac = (advance - acc) / seg
			}
			lat := p1.Lat + frac*(p2.Lat-p1.Lat)
			lon := p1.Lon + frac*(p2.Lon-p1.Lon)
			b := bearing(p1.Lat, p1.Lon, p2.Lat, p2.Lon)
			return ExtrapResult{Lat: round6(lat), Lon: round6(lon), BearingRaw: b, Progress: math.Min(100, jsRound((float64(cur)+frac)/float64(len(coords))*100))}, true
		}
		acc += seg
		cur++
	}
	return tail(), true
}

// decodePolyline decodes a Google encoded polyline.
func decodePolyline(enc string) []LatLon {
	if enc == "" {
		return []LatLon{}
	}
	u := utf16.Encode([]rune(enc)) // charCodeAt works on UTF-16 code units
	pts := []LatLon{}
	idx, n := 0, len(u)
	// lat/lng are JS numbers (doubles); each delta is an int32 from bitwise ops.
	lat, lng := 0.0, 0.0
	// chunk decodes one varint. Reading past the end gives NaN in JS, which
	// contributes 0 (NaN & 0x1f) and ends the loop (NaN >= 0x20 is false).
	// Shift counts are taken mod 32 as in JS.
	chunk := func() int32 {
		var result int32
		shift := 0
		for {
			if idx >= n {
				idx++
				return result
			}
			b := int32(u[idx]) - 63
			idx++
			result |= (b & 0x1f) << uint(shift&31)
			shift += 5
			if b < 0x20 {
				return result
			}
		}
	}
	delta := func(result int32) float64 {
		if result&1 != 0 {
			return float64(^(result >> 1))
		}
		return float64(result >> 1)
	}
	for idx < n {
		lat += delta(chunk())
		lng += delta(chunk())
		pts = append(pts, LatLon{round6(lat / 1e5), round6(lng / 1e5)})
	}
	return pts
}

// PolyTable is buildPolylineDistanceTable's { cum, total }.
type PolyTable struct {
	Cum   []float64
	Total float64
}

func buildPolylineDistanceTable(coords []LatLon) PolyTable {
	cum := []float64{0}
	for i := 1; i < len(coords); i++ {
		cum = append(cum, cum[i-1]+distM(coords[i-1].Lat, coords[i-1].Lon, coords[i].Lat, coords[i].Lon))
	}
	total := 0.0
	if len(cum) > 0 {
		total = cum[len(cum)-1]
	}
	return PolyTable{Cum: cum, Total: total}
}

// pointAtDistance returns ok=false for an empty polyline (JS null).
func pointAtDistance(coords []LatLon, table *PolyTable, d float64) (LatLon, float64, bool) {
	if len(coords) < 2 || table == nil || len(table.Cum) != len(coords) {
		if len(coords) > 0 {
			return coords[0], 0, true
		}
		return LatLon{}, 0, false
	}
	dd := math.Min(math.Max(0, d), table.Total)
	lo, hi := 0, len(table.Cum)-1
	for lo < hi-1 {
		mid := (lo + hi) >> 1
		if table.Cum[mid] <= dd {
			lo = mid
		} else {
			hi = mid
		}
	}
	seg := table.Cum[hi] - table.Cum[lo]
	frac := 0.0
	if seg > 0 {
		frac = (dd - table.Cum[lo]) / seg
	}
	lat := coords[lo].Lat + (coords[hi].Lat-coords[lo].Lat)*frac
	lon := coords[lo].Lon + (coords[hi].Lon-coords[lo].Lon)*frac
	b := jsRound(n0(bearing(coords[lo].Lat, coords[lo].Lon, coords[hi].Lat, coords[hi].Lon)))
	return LatLon{lat, lon}, b, true
}

// composeRouteWithStops: coords [lat, lon] pairs; returns new coords and the
// number of stops stitched in.
func composeRouteWithStops(coords [][]float64, stops []LatLon, thresholdM, maxSpliceM float64) ([][]float64, int) {
	if len(coords) < 2 || len(stops) == 0 {
		if coords == nil {
			coords = [][]float64{}
		}
		return coords, 0
	}
	type pj struct {
		idx     int
		dist    float64
		covered bool
	}
	proj := make([]pj, len(stops))
	for si, s := range stops {
		bestIdx, bestD := -1, math.Inf(1)
		for i, c := range coords {
			d := distLL(s, normalizeCoordAny(c))
			if d < bestD {
				bestD = d
				bestIdx = i
			}
		}
		proj[si] = pj{bestIdx, bestD, bestD <= thresholdM}
	}
	leadEnd := 0
	for leadEnd < len(stops) && !proj[leadEnd].covered {
		leadEnd++
	}
	tailStart := len(stops) - 1
	for tailStart >= leadEnd && !proj[tailStart].covered {
		tailStart--
	}
	out := [][]float64{}
	stitched := 0
	for i := leadEnd - 1; i >= 0; i-- {
		out = append(out, []float64{stops[i].Lat, stops[i].Lon})
		stitched++
	}
	out = append(out, coords...)
	for i := tailStart + 1; i < len(stops); i++ {
		out = append(out, []float64{stops[i].Lat, stops[i].Lon})
		stitched++
	}
	for s := leadEnd; s <= tailStart; s++ {
		if proj[s].covered || proj[s].dist > maxSpliceM || proj[s].idx < 0 {
			continue
		}
		lead := 0
		if leadEnd > 0 {
			lead = leadEnd
		}
		at := proj[s].idx + 1 + lead
		if at > len(out) {
			at = len(out)
		}
		out = append(out, nil)
		copy(out[at+1:], out[at:])
		out[at] = []float64{stops[s].Lat, stops[s].Lon}
		stitched++
	}
	return out, stitched
}

// ---------------------------------------------------------------------------
// gapClusters

const gapRadiusM = 100.0

func gapDistanceM(lat1, lon1, lat2, lon2 float64) float64 {
	dLat := toRad(lat2 - lat1)
	dLon := toRad(lon2 - lon1)
	s1 := jsSin(dLat / 2)
	s2 := jsSin(dLon / 2)
	a := jsPow(s1, 2) + jsCos(toRad(lat1))*jsCos(toRad(lat2))*jsPow(s2, 2)
	return 6371000 * 2 * jsAtan2(math.Sqrt(a), math.Sqrt(1-a))
}

type gapCluster struct {
	Lat, Lon float64
	Members  []*Obj
}

func clusterPoints(points []*Obj, radius float64) []*gapCluster {
	var clusters []*gapCluster
	add := func(c *gapCluster, p *Obj) {
		c.Members = append(c.Members, p)
		n := float64(len(c.Members))
		c.Lat += (p.Num("lat") - c.Lat) / n
		c.Lon += (p.Num("lon") - c.Lon) / n
	}
	for _, p := range points {
		lat, lon := p.Get("lat"), p.Get("lon")
		if !numberIsFinite(lat) || !numberIsFinite(lon) {
			continue
		}
		pl, pn := jsNumber(lat), jsNumber(lon)
		var best *gapCluster
		bestD := math.Inf(1)
		for _, c := range clusters {
			d := gapDistanceM(pl, pn, c.Lat, c.Lon)
			if d <= radius && d < bestD {
				best = c
				bestD = d
			}
		}
		if best != nil {
			add(best, p)
		} else {
			clusters = append(clusters, &gapCluster{Lat: pl, Lon: pn, Members: []*Obj{p}})
		}
	}
	merged := true
	for merged {
		merged = false
	outer:
		for i := 0; i < len(clusters); i++ {
			for j := i + 1; j < len(clusters); j++ {
				if gapDistanceM(clusters[i].Lat, clusters[i].Lon, clusters[j].Lat, clusters[j].Lon) <= radius {
					keep, gone := i, j
					if !(len(clusters[i].Members) >= len(clusters[j].Members)) {
						keep, gone = j, i
					}
					for _, p := range clusters[gone].Members {
						add(clusters[keep], p)
					}
					clusters = append(clusters[:gone], clusters[gone+1:]...)
					merged = true
					break outer
				}
			}
		}
	}
	return clusters
}

// ---------------------------------------------------------------------------
// gapPath

const (
	gapSnapM       = 60.0
	gapMaxSpeedMps = 16.7
	gapMinReachM   = 400.0
)

type gapProj struct {
	t float64
	q LatLon
	d float64
}

func gapProject(p, a, b LatLon) gapProj {
	kx := jsCos((p.Lat * math.Pi) / 180)
	ax, ay, bx, by, px, py := a.Lon*kx, a.Lat, b.Lon*kx, b.Lat, p.Lon*kx, p.Lat
	dx, dy := bx-ax, by-ay
	len2 := dx*dx + dy*dy
	t := 0.0
	if len2 > 0 {
		t = math.Max(0, math.Min(1, ((px-ax)*dx+(py-ay)*dy)/len2))
	}
	q := LatLon{ay + t*dy, (ax + t*dx) / kx}
	return gapProj{t, q, gapDistanceM(p.Lat, p.Lon, q.Lat, q.Lon)}
}

type gapCand struct {
	i     int
	along float64
	q     LatLon
	d     float64
}

func gapCandidates(p LatLon, coords []LatLon, cum []float64) []gapCand {
	var out []gapCand
	var run *struct {
		best gapCand
		last int
	}
	for i := 0; i < len(coords)-1; i++ {
		pr := gapProject(p, coords[i], coords[i+1])
		if pr.d <= gapSnapM {
			along := cum[i] + gapDistanceM(coords[i].Lat, coords[i].Lon, pr.q.Lat, pr.q.Lon)
			c := gapCand{i, along, pr.q, pr.d}
			if run != nil && i == run.last+1 {
				if c.d < run.best.d {
					run.best = c
				}
				run.last = i
			} else {
				if run != nil {
					out = append(out, run.best)
				}
				run = &struct {
					best gapCand
					last int
				}{c, i}
			}
		} else if run != nil {
			out = append(out, run.best)
			run = nil
		}
	}
	if run != nil {
		out = append(out, run.best)
	}
	return out
}

// gapPathCompute returns path [[lat,lon]...] and lengthM, or ok=false.
func gapPathCompute(route []LatLon, lost, regained LatLon, gapSec float64) ([][]float64, float64, bool) {
	var coords []LatLon
	for _, c := range route {
		if isFinite(c.Lat) && isFinite(c.Lon) {
			coords = append(coords, c)
		}
	}
	if len(coords) < 2 {
		return nil, 0, false
	}
	cum := []float64{0}
	for i := 1; i < len(coords); i++ {
		cum = append(cum, cum[i-1]+gapDistanceM(coords[i-1].Lat, coords[i-1].Lon, coords[i].Lat, coords[i].Lon))
	}
	total := cum[len(cum)-1]
	closed := gapDistanceM(coords[0].Lat, coords[0].Lon, coords[len(coords)-1].Lat, coords[len(coords)-1].Lon) < 80
	from := gapCandidates(lost, coords, cum)
	to := gapCandidates(regained, coords, cum)
	if len(from) == 0 || len(to) == 0 {
		return nil, 0, false
	}
	straight := gapDistanceM(lost.Lat, lost.Lon, regained.Lat, regained.Lon)
	reach := math.Max(gapMinReachM, n0(gapSec)*gapMaxSpeedMps)
	type bestT struct {
		a, b  gapCand
		len   float64
		wraps bool
	}
	var best *bestT
	for _, a := range from {
		for _, b := range to {
			l := b.along - a.along
			wraps := false
			if l < 0 && closed {
				l += total
				wraps = true
			}
			if l < 0 || l > reach || l < straight*0.8-2*gapSnapM {
				continue
			}
			if best == nil || l < best.len {
				best = &bestT{a, b, l, wraps}
			}
		}
	}
	if best == nil {
		return nil, 0, false
	}
	pts := [][]float64{{best.a.q.Lat, best.a.q.Lon}}
	push := func(i int) { pts = append(pts, []float64{coords[i].Lat, coords[i].Lon}) }
	if !best.wraps {
		for i := best.a.i + 1; i <= best.b.i; i++ {
			push(i)
		}
	} else {
		for i := best.a.i + 1; i < len(coords); i++ {
			push(i)
		}
		for i := 1; i <= best.b.i; i++ {
			push(i)
		}
	}
	pts = append(pts, []float64{best.b.q.Lat, best.b.q.Lon})
	for _, p := range pts {
		p[0] = round6(p[0])
		p[1] = round6(p[1])
	}
	return pts, jsRound(best.len), true
}

// ---------------------------------------------------------------------------
// gpsGapDetector

const (
	gapMinMs        = 90 * 1000
	gapMaxMs        = 15 * 60 * 1000
	gapEdgeMarginMs = 15 * 1000
	gapRetentionMs  = gapMaxMs + 5*60*1000
)

var reHasDigit = regexp.MustCompile(`\d`)

func isFleetId(id string) bool { return reHasDigit.MatchString(id) }

type gapFix struct {
	t          float64
	lat, lon   float64
	lineCode   string
	direction  string
	stopName   string
	atTerminal bool
}

type fixTime struct {
	t float64
	v string
}

type GpsGapDetector struct {
	last     map[string]*gapFix
	order    []string // insertion order of last (Map iteration)
	fixTimes []fixTime
}

func newGpsGapDetector() *GpsGapDetector { return &GpsGapDetector{last: map[string]*gapFix{}} }

// observe feeds one tracker emission (a vehicle object); returns a gap or nil.
func (g *GpsGapDetector) observe(bus *Obj) *Obj {
	vID := ""
	if bus != nil && truthy(bus.Get("vehicleId")) {
		vID = strings.TrimFunc(bus.Str("vehicleId"), isJSWhite)
	}
	if !isFleetId(vID) {
		return nil
	}
	t := jsNumber(bus.Get("observedAt"))
	lat := jsNumber(bus.Get("lat"))
	lon := jsNumber(bus.Get("lon"))
	if vID == "" || !isFinite(t) || t <= 0 || !isFinite(lat) || !isFinite(lon) {
		return nil
	}
	prev := g.last[vID]
	if prev != nil && t <= prev.t {
		return nil
	}
	dir := ""
	if !bus.IsNullish("direction") {
		dir = bus.Str("direction")
	}
	fix := &gapFix{t: t, lat: lat, lon: lon, lineCode: strOr(bus.Get("lineCode"), ""), direction: dir,
		stopName: strOr(bus.Get("toStop"), ""), atTerminal: bus.Bool("isTerminalLayover")}
	if prev == nil {
		g.order = append(g.order, vID)
	}
	g.last[vID] = fix
	g.addFixTime(t, vID)
	g.evict(t)
	if prev == nil {
		return nil
	}
	gapMs := t - prev.t
	if gapMs < gapMinMs || gapMs > gapMaxMs {
		return nil
	}
	if prev.lineCode != "" && fix.lineCode != "" && prev.lineCode != fix.lineCode {
		return nil
	}
	lc := prev.lineCode
	if lc == "" {
		lc = fix.lineCode
	}
	return O(
		"vehicleId", vID,
		"lineCode", lc,
		"direction", prev.direction,
		"lostTs", prev.t,
		"regainedTs", t,
		"gapSec", jsRound(gapMs/1000),
		"lostLat", prev.lat,
		"lostLon", prev.lon,
		"regainedLat", lat,
		"regainedLon", lon,
		"stopName", prev.stopName,
		"atTerminal", prev.atTerminal || fix.atTerminal,
		"feedWide", !g.othersReported(vID, prev.t, t),
	)
}

func (g *GpsGapDetector) addFixTime(t float64, v string) {
	i := len(g.fixTimes)
	for i > 0 && g.fixTimes[i-1].t > t {
		i--
	}
	g.fixTimes = append(g.fixTimes, fixTime{})
	copy(g.fixTimes[i+1:], g.fixTimes[i:])
	g.fixTimes[i] = fixTime{t, v}
}

func (g *GpsGapDetector) othersReported(vID string, from, to float64) bool {
	lo := from + gapEdgeMarginMs
	hi := to - gapEdgeMarginMs
	for _, f := range g.fixTimes {
		if f.t <= lo {
			continue
		}
		if f.t >= hi {
			break
		}
		if f.v != vID {
			return true
		}
	}
	return false
}

func (g *GpsGapDetector) evict(now float64) {
	cutoff := now - gapRetentionMs
	k := 0
	for k < len(g.fixTimes) && g.fixTimes[k].t < cutoff {
		k++
	}
	if k > 0 {
		g.fixTimes = append(g.fixTimes[:0], g.fixTimes[k:]...)
	}
	kept := g.order[:0]
	for _, v := range g.order {
		if f := g.last[v]; f != nil && f.t < cutoff {
			delete(g.last, v)
			continue
		}
		kept = append(kept, v)
	}
	g.order = kept
}

// ---------------------------------------------------------------------------
// gapBuses

const (
	gapBusMinGaps  = 4
	gapBusMinRatio = 1.5
	gapBusMaxP     = 0.05
)

func poissonTail(n int, lambda float64) float64 {
	if n <= 0 {
		return 1
	}
	if !(lambda > 0) {
		return 0
	}
	term := jsExp(-lambda)
	below := term
	for k := 1; k < n; k++ {
		term *= lambda / float64(k)
		below += term
	}
	return math.Max(0, math.Min(1, 1-below))
}

func medianRounded(xs []float64) any {
	if len(xs) == 0 {
		return nil
	}
	s := append([]float64(nil), xs...)
	sort.Float64s(s)
	m := len(s) / 2
	if len(s)%2 == 1 {
		return s[m]
	}
	return jsRound((s[m-1] + s[m]) / 2)
}

// GapRow / VisitRow are rankBuses inputs.
type GapRow struct {
	ID        any
	VehicleID string
	LineCode  string
	GapSec    float64
	Shared    bool
}

type VisitRow struct {
	VehicleID string
	LineCode  string
	N         float64
}

func rankBuses(gaps []GapRow, visits []VisitRow) *Obj {
	isFleet := func(id string) bool { return reHasDigit.MatchString(id) }
	var gs []GapRow
	for _, g := range gaps {
		if isFleet(g.VehicleID) {
			gs = append(gs, g)
		}
	}
	var vs []VisitRow
	for _, v := range visits {
		if isFleet(v.VehicleID) && v.N > 0 {
			vs = append(vs, v)
		}
	}
	lineGaps := map[string]float64{}
	lineVisits := map[string]float64{}
	for _, g := range gs {
		lineGaps[g.LineCode]++
	}
	for _, v := range vs {
		lineVisits[v.LineCode] += v.N
	}
	lineRate := func(l string) float64 {
		if lineVisits[l] != 0 {
			return lineGaps[l] / lineVisits[l]
		}
		return 0
	}
	type busAgg struct {
		gaps       []GapRow
		visits     map[string]float64
		visitOrder []string
	}
	byBus := map[string]*busAgg{}
	var busOrder []string
	bus := func(id string) *busAgg {
		b := byBus[id]
		if b == nil {
			b = &busAgg{visits: map[string]float64{}}
			byBus[id] = b
			busOrder = append(busOrder, id)
		}
		return b
	}
	for _, g := range gs {
		b := bus(g.VehicleID)
		b.gaps = append(b.gaps, g)
	}
	for _, v := range vs {
		b := bus(v.VehicleID)
		if _, ok := b.visits[v.LineCode]; !ok {
			b.visitOrder = append(b.visitOrder, v.LineCode)
		}
		b.visits[v.LineCode] += v.N
	}
	type busOut struct {
		obj     *Obj
		verdict string
		ratio   float64
		ratioOK bool
		gaps    int
	}
	var buses []busOut
	for _, id := range busOrder {
		b := byBus[id]
		if len(b.gaps) == 0 {
			continue
		}
		visitCount := 0.0
		for _, l := range b.visitOrder {
			visitCount += b.visits[l]
		}
		expected := 0.0
		for _, l := range b.visitOrder {
			expected += b.visits[l] * lineRate(l)
		}
		n := len(b.gaps)
		var ratio any = nil
		var pValue any = nil
		rf, pf := 0.0, 0.0
		if expected > 0 {
			rf = float64(n) / expected
			pf = poissonTail(n, expected)
			ratio, pValue = rf, pf
		}
		verdict := "normal"
		switch {
		case n < 3 || ratio == nil:
			verdict = "few"
		case n >= gapBusMinGaps && rf >= gapBusMinRatio && pf < gapBusMaxP:
			verdict = "suspect"
		case rf >= gapBusMinRatio:
			verdict = "watch"
		}
		lineSet := map[string]bool{}
		var lines []string
		for _, g := range b.gaps {
			if !lineSet[g.LineCode] {
				lineSet[g.LineCode] = true
				lines = append(lines, g.LineCode)
			}
		}
		for _, l := range b.visitOrder {
			if !lineSet[l] {
				lineSet[l] = true
				lines = append(lines, l)
			}
		}
		sort.Strings(lines) // default Array sort: UTF-16 code unit order (ASCII codes here)
		shared := 0
		var secs []float64
		for _, g := range b.gaps {
			if g.Shared {
				shared++
			}
			secs = append(secs, g.GapSec)
		}
		var per100 any = nil
		if visitCount != 0 {
			per100 = jsRound((1000*float64(n))/visitCount) / 10
		}
		var ratioOut, pOut any = nil, nil
		if ratio != nil {
			ratioOut = jsRound(rf*10) / 10
		}
		if pValue != nil {
			pOut = jsRound(pf*1000) / 1000
		}
		linesAny := make([]any, len(lines))
		for i, l := range lines {
			linesAny[i] = l
		}
		o := O(
			"vehicleId", id,
			"lines", linesAny,
			"gaps", n,
			"visits", visitCount,
			"per100", per100,
			"expected", jsRound(expected*10)/10,
			"ratio", ratioOut,
			"pValue", pOut,
			"sharedPct", jsRound((100*float64(shared))/float64(n)),
			"medianGapSec", medianRounded(secs),
			"verdict", verdict,
		)
		ro := 0.0
		if ratioOut != nil {
			ro = ratioOut.(float64)
		}
		buses = append(buses, busOut{o, verdict, ro, ratioOut != nil, n})
	}
	rank := map[string]int{"suspect": 0, "watch": 1, "normal": 2, "few": 3}
	sort.SliceStable(buses, func(i, j int) bool {
		a, b := buses[i], buses[j]
		if d := rank[a.verdict] - rank[b.verdict]; d != 0 {
			return d < 0
		}
		// (b.ratio || 0) - (a.ratio || 0) on the rounded ratios
		if a.verdict == "suspect" {
			return b.ratio-a.ratio < 0
		}
		if d := b.gaps - a.gaps; d != 0 {
			return d < 0
		}
		return b.ratio-a.ratio < 0
	})
	out := make([]any, len(buses))
	for i, b := range buses {
		out[i] = b.obj
	}
	inService := map[string]bool{}
	var inOrder []string
	for _, v := range vs {
		if !inService[v.VehicleID] {
			inService[v.VehicleID] = true
			inOrder = append(inOrder, v.VehicleID)
		}
	}
	without := 0
	for _, id := range inOrder {
		if b := byBus[id]; b == nil || len(b.gaps) == 0 {
			without++
		}
	}
	return O("buses", out, "inService", len(inOrder), "withoutLoss", without)
}

var _ = strconv.Itoa

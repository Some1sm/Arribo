package main

// Ports of src/core/geo/pedestrianRouter.js and src/core/geo/streetGeocoder.js.

import (
	"bytes"
	"context"
	"errors"
	"math"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/text/unicode/norm"
)

// ---------------------------------------------------------------- pedestrian router

type walkResult struct {
	distanceMeters  float64
	durationSeconds float64
	polyline        []any
	source          string
	approximate     bool
}

func (w *walkResult) toObj() *Obj {
	return O("distanceMeters", w.distanceMeters, "durationSeconds", w.durationSeconds,
		"polyline", w.polyline, "source", w.source, "approximate", w.approximate)
}

type walkCacheEntry struct {
	value   *walkResult // nil = provider failed
	expires float64
}

type walkFlight struct {
	done chan struct{}
	val  *walkResult
}

type pedestrianRouter struct {
	url, key string
	timeout  time.Duration
	maxEntry int
	mu       sync.Mutex
	cache    map[string]*walkCacheEntry
	order    []string
	pending  map[string]*walkFlight
	active   int
}

var walkRouter = &pedestrianRouter{
	url:      os.Getenv("ORS_BASE_URL"),
	key:      os.Getenv("ORS_API_KEY"),
	timeout:  2500 * time.Millisecond,
	maxEntry: 256,
	cache:    map[string]*walkCacheEntry{},
	pending:  map[string]*walkFlight{},
}

type walkBudget struct{ remaining int }

var errInvalidWalk = errors.New("Invalid walking parameters")

func validLatLon(p []float64) bool {
	return len(p) == 2 && isFinite(p[0]) && isFinite(p[1]) && math.Abs(p[0]) <= 90 && math.Abs(p[1]) <= 180
}

func latLonArr(p []float64) []any { return []any{p[0], p[1]} }

func (pr *pedestrianRouter) cacheSet(key string, e *walkCacheEntry) {
	if _, ok := pr.cache[key]; ok {
		delete(pr.cache, key)
		for i, k := range pr.order {
			if k == key {
				pr.order = append(pr.order[:i:i], pr.order[i+1:]...)
				break
			}
		}
	}
	pr.cache[key] = e
	pr.order = append(pr.order, key)
	for len(pr.cache) > pr.maxEntry {
		oldest := pr.order[0]
		pr.order = pr.order[1:]
		delete(pr.cache, oldest)
	}
}

// route returns the walking leg; from/to are [lat, lon].
func (pr *pedestrianRouter) route(from, to []float64, speed float64, budget *walkBudget) (*walkResult, error) {
	if !validLatLon(from) || !validLatLon(to) || !isFinite(speed) || speed <= 0 {
		return nil, errInvalidWalk
	}
	distance := distM(from[0], from[1], to[0], to[1])
	fallback := &walkResult{
		distanceMeters:  jsRound(distance),
		durationSeconds: math.Ceil(distance / speed * 60),
		polyline:        []any{latLonArr(from), latLonArr(to)},
		source:          "approximate",
		approximate:     true,
	}
	if pr.url == "" || distance < 1 {
		return fallback, nil
	}
	cacheKey := string(toJSON([]any{"foot-walking", latLonArr(from), latLonArr(to)}))
	var result *walkResult
	pr.mu.Lock()
	if c, ok := pr.cache[cacheKey]; ok && c.expires > float64(nowMs()) {
		result = c.value
		pr.mu.Unlock()
	} else if fl, ok := pr.pending[cacheKey]; ok {
		pr.mu.Unlock()
		<-fl.done
		result = fl.val
	} else {
		if budget.remaining <= 0 || pr.active >= 3 {
			pr.mu.Unlock()
			return fallback, nil
		}
		budget.remaining--
		pr.active++
		fl := &walkFlight{done: make(chan struct{})}
		pr.pending[cacheKey] = fl
		pr.mu.Unlock()
		var res *walkResult
		func() {
			defer func() {
				pr.mu.Lock()
				ttl := 15000.0
				if res != nil {
					ttl = 3600000
				}
				pr.cacheSet(cacheKey, &walkCacheEntry{value: res, expires: float64(nowMs()) + ttl})
				fl.val = res
				delete(pr.pending, cacheKey)
				pr.active--
				close(fl.done)
				pr.mu.Unlock()
			}()
			r, err := pr.fetchRoute(from, to)
			if err == nil {
				res = r
			}
		}()
		result = res
	}
	if result == nil {
		return fallback, nil
	}
	cp := *result
	cp.durationSeconds = math.Max(result.durationSeconds, math.Ceil(result.distanceMeters/speed*60))
	return &cp, nil
}

func (pr *pedestrianRouter) fetchRoute(from, to []float64) (*walkResult, error) {
	base, err := url.Parse(pr.url)
	if err != nil || (base.Scheme != "https" && base.Scheme != "http") {
		return nil, errors.New("Invalid ORS URL")
	}
	href := base.String()
	if base.Path == "" {
		href += "/"
	}
	endpoint := strings.TrimSuffix(href, "/") + "/v2/directions/foot-walking/geojson"
	body := toJSON(O("coordinates", []any{[]any{from[1], from[0]}, []any{to[1], to[0]}}))
	ctx, cancel := context.WithTimeout(context.Background(), pr.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if pr.key != "" {
		req.Header.Set("Authorization", pr.key)
	}
	resp, err := clientFor(base.Hostname(), "").Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, errors.New("Walking provider unavailable")
	}
	text, err := readBoundedBody(resp.Body, 262144)
	if err != nil {
		return nil, errors.New("Walking response too large")
	}
	v, err := parseJSON([]byte(text))
	if err != nil {
		return nil, err
	}
	root, _ := v.(*Obj)
	features := root.Arr("features")
	if len(features) == 0 {
		return nil, errors.New("Invalid walking response")
	}
	feature, _ := features[0].(*Obj)
	summary := feature.ObjAt("properties").ObjAt("summary")
	geom := feature.ObjAt("geometry")
	coords := geom.Arr("coordinates")
	if geom.Get("type") != "LineString" || len(coords) < 2 {
		return nil, errors.New("Invalid walking response")
	}
	poly := make([]any, 0, len(coords))
	for _, c := range coords {
		p, ok := c.([]any)
		if !ok || len(p) < 2 || !numberIsFinite(p[0]) || !numberIsFinite(p[1]) {
			return nil, errors.New("Invalid walking response")
		}
		lon, lat := jsNumber(p[0]), jsNumber(p[1])
		if math.Abs(lon) > 180 || math.Abs(lat) > 90 {
			return nil, errors.New("Invalid walking response")
		}
		poly = append(poly, []any{lat, lon})
	}
	dist, dur := summary.Get("distance"), summary.Get("duration")
	if !numberIsFinite(dist) || jsNumber(dist) < 0 || !numberIsFinite(dur) || jsNumber(dur) < 0 {
		return nil, errors.New("Invalid walking response")
	}
	return &walkResult{
		distanceMeters:  math.Ceil(jsNumber(dist)),
		durationSeconds: math.Ceil(jsNumber(dur)),
		polyline:        poly,
		source:          "openrouteservice",
		approximate:     false,
	}, nil
}

// ---------------------------------------------------------------- street geocoder

const (
	mataroLat         = 41.5388
	mataroLon         = 2.4445
	geocodeMaxRadiusM = 12000.0
	geocodeCacheMax   = 250
	geocodeCacheTTLms = 3600 * 1000.0
)

type geocodeEntry struct {
	ts      float64
	results []*Obj
}

type streetGeocoderT struct {
	mu           sync.Mutex
	cache        map[string]*geocodeEntry
	order        []string
	stopsCatalog []*Obj
	catalogSet   bool
}

var streetGeocoder = &streetGeocoderT{cache: map[string]*geocodeEntry{}}

func (g *streetGeocoderT) setStopsCatalog(stops []*Obj) {
	g.mu.Lock()
	g.stopsCatalog = stops
	g.catalogSet = true
	g.mu.Unlock()
}

func (g *streetGeocoderT) hasCatalog() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.catalogSet
}

var reStopSuffix = jsRe(` - \d+$`)

// cleanStopName: (name || ”).replace(/ - \d+$/, ”).trim()
func cleanStopName(v any) string {
	return jsTrim(reStopSuffix.ReplaceAllString(strOr(v, ""), ""))
}

func stopLatLon(s *Obj) (float64, float64) {
	return parseFloatJS(coalesce(s.Get("lat"), s.Get("latitude"))), parseFloatJS(coalesce(s.Get("lon"), s.Get("longitude")))
}

func (g *streetGeocoderT) findNearestStop(lat, lon float64) *Obj {
	g.mu.Lock()
	cat := g.stopsCatalog
	g.mu.Unlock()
	var closest *Obj
	minD := math.Inf(1)
	for _, s := range cat {
		sLat, sLon := stopLatLon(s)
		if !isFinite(sLat) || !isFinite(sLon) {
			continue
		}
		d := distM(lat, lon, sLat, sLon)
		if d < minD {
			minD = d
			closest = O(
				"id", jsString(s.Get("id")),
				"name", cleanStopName(s.Get("name")),
				"lat", sLat,
				"lon", sLon,
				"directionText", or(s.Get("directionText"), ""),
				"distMeters", jsRound(d),
				"walkingMinutes", math.Max(1, jsRound(d/80)),
			)
		}
	}
	return closest
}

func sliceObjs(list []*Obj, limit int) []*Obj {
	if limit < len(list) {
		return append([]*Obj(nil), list[:limit]...)
	}
	return append([]*Obj(nil), list...)
}

// searchStreets queries Photon around Mataró; errors yield an empty list.
func (g *streetGeocoderT) searchStreets(query string, limit int, catalog func() []*Obj) []*Obj {
	rawQ := jsTrim(query)
	if utf16Count(rawQ) < 2 {
		return []*Obj{}
	}
	normKey := norm.NFD.String(jsLower(rawQ))
	normKey = strings.Map(func(r rune) rune {
		if r >= 0x300 && r <= 0x36f {
			return -1
		}
		return r
	}, normKey)
	g.mu.Lock()
	if c, ok := g.cache[normKey]; ok && float64(nowMs())-c.ts < geocodeCacheTTLms {
		res := sliceObjs(c.results, limit)
		g.mu.Unlock()
		return res
	}
	needCatalog := !g.catalogSet
	g.mu.Unlock()
	if needCatalog && catalog != nil {
		g.setStopsCatalog(catalog())
	}

	u := "https://photon.komoot.io/api/?q=" + encodeURIComponent(rawQ) + "&lat=41.5388&lon=2.4445&bbox=2.30,41.48,2.58,41.62&limit=15"
	ctx, cancel := context.WithTimeout(context.Background(), 1600*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return []*Obj{}
	}
	req.Header.Set("User-Agent", "ArriboTransit/1.0 (https://arribo.cat)")
	resp, err := defaultHTTPClient.Do(req)
	if err != nil {
		return []*Obj{}
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return []*Obj{}
	}
	text, err := readBoundedBody(resp.Body, 1<<20)
	if err != nil {
		return []*Obj{}
	}
	v, err := parseJSON([]byte(text))
	if err != nil {
		return []*Obj{}
	}
	data, ok := v.(*Obj)
	if !ok {
		if v == nil {
			return []*Obj{} // data.features on null throws
		}
	}
	features := data.Arr("features")
	results := []*Obj{}
	seen := map[string]bool{}
	for _, fv := range features {
		f, _ := fv.(*Obj)
		if f == nil {
			if fv == nil {
				return []*Obj{} // f.properties on null throws
			}
		}
		p := f.ObjAt("properties")
		if p == nil {
			p = O()
		}
		coords := f.ObjAt("geometry").Arr("coordinates")
		if len(coords) < 2 {
			continue
		}
		lon := jsNumber(coords[0])
		lat := jsNumber(coords[1])
		if distM(mataroLat, mataroLon, lat, lon) > geocodeMaxRadiusM {
			continue
		}
		rawName := or(p.Get("name"), p.Get("street"))
		if !truthy(rawName) {
			continue
		}
		rn, isStr := rawName.(string)
		if !isStr {
			return []*Obj{} // rawName.trim is not a function
		}
		cleanName := jsTrim(rn)
		cityV := or(or(p.Get("city"), p.Get("locality")), "Mataró")
		city, isStr := cityV.(string)
		if !isStr {
			return []*Obj{}
		}
		dedupe := jsLower(cleanName) + "_" + jsLower(city)
		if seen[dedupe] {
			continue
		}
		seen[dedupe] = true
		nearest := g.findNearestStop(lat, lon)
		subtitle := "Carrer • " + city
		if nearest != nil {
			subtitle = "A " + jsString(nearest.Get("distMeters")) + "m de parada " + nearest.Str("name") + " (" + jsString(nearest.Get("walkingMinutes")) + " min a peu)"
		}
		idPart := p.Get("osm_id")
		if !truthy(idPart) {
			idPart = jsRound(lat * 10000)
		}
		var nearestV any = nil
		if nearest != nil {
			nearestV = nearest
		}
		results = append(results, O(
			"type", "street",
			"isStreet", true,
			"id", "street_"+jsString(idPart),
			"name", cleanName,
			"cityName", city,
			"lat", jsRound(lat*100000)/100000,
			"lon", jsRound(lon*100000)/100000,
			"subtitle", subtitle,
			"nearestStop", nearestV,
		))
		if len(results) >= limit {
			break
		}
	}
	distOf := func(o *Obj) float64 {
		n := o.ObjAt("nearestStop")
		if n == nil {
			return 99999
		}
		return n.Num("distMeters")
	}
	sort.SliceStable(results, func(i, j int) bool {
		a, b := results[i], results[j]
		aM := strings.Contains(jsLower(a.Str("cityName")), "matar")
		bM := strings.Contains(jsLower(b.Str("cityName")), "matar")
		if aM != bM {
			return aM
		}
		return distOf(a)-distOf(b) < 0
	})
	g.mu.Lock()
	if len(g.cache) >= geocodeCacheMax && len(g.order) > 0 {
		delete(g.cache, g.order[0])
		g.order = g.order[1:]
	}
	if _, exists := g.cache[normKey]; !exists {
		g.order = append(g.order, normKey)
	}
	g.cache[normKey] = &geocodeEntry{ts: float64(nowMs()), results: results}
	g.mu.Unlock()
	return sliceObjs(results, limit)
}

// utf16Count is a JavaScript string's .length.
func utf16Count(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// encodeURIComponent escapes everything except A-Z a-z 0-9 - _ . ! ~ * ' ( ).
func encodeURIComponent(s string) string {
	const unreserved = "-_.!~*'()"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.IndexByte(unreserved, c) >= 0 {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte("0123456789ABCDEF"[c>>4])
		b.WriteByte("0123456789ABCDEF"[c&15])
	}
	return b.String()
}

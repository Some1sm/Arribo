package main

// Port of server.js: the HTTP process. Its world (tracker, SIRI client,
// flight recorder) never touches SQLite or the providers directly; those go
// through the worker bridge, as in Node.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

var processStart = time.Now()

type routeEntry struct {
	paths   []*route
	label   any // req.route.path: a string, or []any for an array of paths
	all     bool
	handler func(q *xreq, res *xres) error
}

// errNext is next() from a handler (res.sendFile on a directory).
var errNext = errors.New("next")

type Server struct {
	w               *World
	reports         *ReportCache
	bridge          *WorkerBridge
	registry        *TrackerRegistry
	router          *TransitRouter
	fleet           *fleetBroadcaster
	trust           []netip.Prefix
	limiter         *apiLimiter
	publicDir       string
	shuttingDown    bool
	incidentCache   *JSMap
	incidentRefresh map[string]bool // incident cache keys being recomputed in the background
	monthlyCache    *JSMap          // month ("2026-11") -> monthly report (hMonthly)
	monthlyRefresh  map[string]bool // months being recomputed in the background
	gpsGapCache     *JSMap
	operatorCache   *JSMap
	sseRoute        *routeEntry
	routes          []*routeEntry
}

type cachedData struct {
	data      any
	timestamp float64
}

// ---------------------------------------------------------------- dispatch

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	target := r.RequestURI
	if target == "" {
		target = r.URL.RequestURI()
	}
	pathname, rawQuery, _ := splitTarget(target)
	q := &xreq{r: r, method: r.Method, url: target, pathname: pathname, start: time.Now()}
	q.query = parseQuery(rawQuery)
	q.ip = requestIP(r, s.trust)
	res := newXres(w, q)

	s.w.mu.Lock()
	s.dispatch(q, res)
	s.w.mu.Unlock()

	if res.sse != nil {
		s.fleet.serve(res)
		return
	}
	if err := res.flush(); err != nil {
		return
	}
	if q.apiLogged {
		rp := q.routePath
		if rp == "/api/health" || rp == "/api/ready" || rp == "/api/fleet/events" {
			return
		}
		var route any = "unmatched"
		if rp != nil {
			route = rp
		}
		consoleLog(toJSON(O(
			"event", "http_request",
			"requestId", q.requestID,
			"route", route,
			"status", float64(res.status),
			"durationMs", jsRound(float64(time.Since(q.start).Nanoseconds())/1e6),
		)))
	}
}

// dispatch walks the middleware stack of server.js in order.
func (s *Server) dispatch(q *xreq, res *xres) {
	setSecurityHeaders(res.h)
	if res.cors() {
		return
	}
	isAPI := useMatches("/api", q.pathname)
	if isAPI {
		pathname := strings.SplitN(q.url, "?", 2)[0]
		if retry := s.limiter.allow(q.method, pathname, clientKey(q.ip)); retry > 0 {
			res.h.Set("Retry-After", itoa(retry))
			res.h.Set("Cache-Control", "no-store")
			res.status = 429
			res.json(O("success", false, "error", "Too many requests; retry shortly."))
			return
		}
	}
	if q.method != "GET" && q.method != "HEAD" {
		res.status = 405
		res.json(O("success", false, "error", "Method Not Allowed: This transit service is strictly read-only."))
		return
	}
	if handled, err := s.serveStatic(q, res); handled {
		if err != nil {
			s.errorHandler(q, res, err)
		}
		return
	}
	if isAPI {
		q.requestID = randomUUID()
		res.h.Set("X-Request-ID", q.requestID)
		q.apiLogged = true
	}
	if err := s.runRoutes(q, res); err != nil {
		s.errorHandler(q, res, err)
	}
}

func (s *Server) serveStatic(q *xreq, res *xres) (bool, error) {
	r := res.sendPipe(q.pathname, sendOptions{
		root:     s.publicDir,
		maxAgeMs: 5 * 60 * 1000,
		onHeaders: func(res *xres, p string) {
			if strings.HasSuffix(p, ".html") || strings.HasSuffix(p, "sw.js") {
				res.h.Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
				res.h.Set("Pragma", "no-cache")
				res.h.Set("Expires", "0")
			}
		},
		directory: directoryRedirect,
	})
	if r.err != nil {
		if r.file || r.err.status >= 500 {
			return true, r.err
		}
		return false, nil
	}
	// Static files are compressed like API responses (gzip/br by
	// Accept-Encoding, compressible types of 1 KiB or more). Only a full 200
	// body: a 206 range is a byte slice of the uncompressed file, and a 304
	// or HEAD has no body.
	if r.file && res.file != nil && res.status == 200 {
		res.compress = true
	}
	return r.file || r.dir, nil
}

func (s *Server) runRoutes(q *xreq, res *xres) error {
	try := func(e *routeEntry) (bool, error) {
		for _, rt := range e.paths {
			params, ok, perr := rt.matchPath(q.pathname)
			if perr != nil {
				return true, perr
			}
			if !ok {
				continue
			}
			if !e.all && q.method != "GET" && q.method != "HEAD" {
				return false, nil
			}
			q.params = params
			q.routePath = e.label
			herr := s.runHandler(e, q, res)
			if herr == errNext {
				return false, nil
			}
			return true, herr
		}
		return false, nil
	}
	if done, err := try(s.sseRoute); done {
		return err
	}
	res.compress = true
	for _, e := range s.routes {
		if done, err := try(e); done {
			return err
		}
	}
	return nil
}

func (s *Server) runHandler(e *routeEntry, q *xreq, res *xres) (err error) {
	var herr error
	if perr := tryJS(func() { herr = e.handler(q, res) }); perr != nil {
		return perr
	}
	return herr
}

func (s *Server) errorHandler(q *xreq, res *xres, err error) {
	if res.headersSent() {
		return
	}
	var he *httpErr
	if errors.As(err, &he) && he.status >= 400 && he.status < 500 {
		res.status = he.status
		res.json(O("success", false, "error", "Bad request"))
		return
	}
	s.sendInternalError(q, res, err, nil)
}

func (s *Server) sendInternalError(q *xreq, res *xres, err error, extra *Obj) {
	var route any = "unmatched"
	if q.routePath != nil {
		route = q.routePath
	}
	var rid any = Undefined
	if q.requestID != "" {
		rid = q.requestID
	}
	consoleError(toJSON(O("event", "http_error", "requestId", rid, "route", route, "errorType", errName(err))))
	res.status = 500
	res.json(O("success", false, "error", "Internal server error").Spread(extra))
}

var reNotFound = regexp.MustCompile(`(?i)not found`)

func (s *Server) handleRouteError(q *xreq, res *xres, err error) {
	if err != nil && reNotFound.MatchString(err.Error()) {
		res.status = 404
		res.json(O("success", false, "error", "Unknown line or stop"))
		return
	}
	s.sendInternalError(q, res, err, nil)
}

func (s *Server) resolveTrackerOr404(res *xres, lineID any) *lineResolution {
	var r *lineResolution
	var err error
	if perr := tryJS(func() { r, err = s.registry.getTrackerForLine(lineID) }); perr != nil || err != nil || r == nil || r.Tracker == nil {
		res.status = 404
		res.json(O("success", false, "error", "Unknown line"))
		return nil
	}
	return r
}

// ---------------------------------------------------------------- helpers

func qv(q *xreq, k string) any { return q.query.Get(k) }

func field(x any, k string) any {
	switch o := x.(type) {
	case *Obj:
		if o != nil {
			return o.Get(k)
		}
	case *reportEntry:
		if o != nil {
			return o.get(k)
		}
	}
	return Undefined
}

func spreadCopy(x any) *Obj {
	if o, ok := x.(*Obj); ok && o != nil {
		return o.Clone()
	}
	return O()
}

// spreadAny is { ...dst, ...src } for whatever src the worker returned.
func spreadAny(dst *Obj, src any) *Obj {
	switch x := src.(type) {
	case *reportEntry:
		if x != nil {
			x.spreadInto(dst)
		}
	case *Obj:
		dst.Spread(x)
	case []any:
		for i, v := range x {
			dst.Set(itoa(i), v)
		}
	case string:
		i := 0
		for _, r := range x {
			dst.Set(itoa(i), string(r))
			i++
		}
	}
	return dst
}

func isNumberValue(v any) bool {
	switch v.(type) {
	case float64, int, int64:
		return true
	}
	return false
}

func numberOr0(v any) float64 {
	n := jsNumber(v)
	if math.IsNaN(n) || n == 0 {
		return 0
	}
	return n
}

func objKeysLen(v any) int {
	switch x := v.(type) {
	case *Obj:
		return x.Len()
	case []any:
		return len(x)
	case string:
		return utf16Count(x)
	}
	return 0
}

func objsAny(list []*Obj) []any {
	out := make([]any, len(list))
	for i, o := range list {
		out[i] = o
	}
	return out
}

func (s *Server) calendarInfo() *Obj {
	now := nowMs()
	var info *Obj
	if err := tryJS(func() { info = s.w.tracker.getServiceCalendarInfo(now) }); err != nil || info == nil {
		return serviceCalendarInfoBase(now)
	}
	return info
}

// historyQuery runs a worker request with the server's lock released.
func (s *Server) historyQuery(op string, args any, timeoutMs float64) (any, error) {
	var res any
	var err error
	s.w.await(func() { res, err = s.bridge.historyQuery(op, args, timeoutMs) })
	return res, err
}

// searchStreets is `await streetGeocoder.searchStreets(q, limit)`; a thrown
// error comes back as err.
func (s *Server) searchStreets(query string, limit int) ([]*Obj, error) {
	var catalog func() []*Obj
	if !streetGeocoder.hasCatalog() {
		stops := s.allStops()
		catalog = func() []*Obj { return stops }
	}
	var out []*Obj
	err := tryJS(func() { s.w.await(func() { out = streetGeocoder.searchStreets(query, limit, catalog) }) })
	return out, err
}

func (s *Server) allStops() []*Obj {
	m := s.w.tracker.allStopsMap
	out := make([]*Obj, 0, m.Len())
	for _, k := range m.Keys() {
		v, _ := m.Get(k)
		if o, ok := v.(*Obj); ok {
			out = append(out, o)
		}
	}
	return out
}

// ---------------------------------------------------------------- harmonizers

func standardizeVehicle(raw any) *Obj {
	v := spreadCopy(raw)
	rawDelay := v.Get("delayMinutes")
	if isUndef(rawDelay) {
		rawDelay = v.Get("delayMins")
	}
	delay := 0.0
	if n := jsNumber(rawDelay); isFinite(n) {
		delay = n
	}
	v.Set("delayMinutes", delay)
	v.Set("delayMins", delay)

	var isReal bool
	switch {
	case !v.IsUndef("isRealTime"):
		isReal = truthy(v.Get("isRealTime"))
	case !v.IsUndef("isRealtime"):
		isReal = truthy(v.Get("isRealtime"))
	default:
		isReal = !truthy(v.Get("isEstimated"))
	}
	v.Set("isRealTime", isReal)
	v.Set("isRealtime", isReal)

	rawSpeed := v.Get("speedKmh")
	if isUndef(rawSpeed) {
		rawSpeed = v.Get("speed")
	}
	speed := 0.0
	if n := jsNumber(rawSpeed); isFinite(n) {
		speed = n
	}
	v.Set("speedKmh", speed)
	v.Set("speed", speed)

	if truthy(v.Get("isGhostVehicle")) || (truthy(v.Get("vehicleId")) && strings.HasPrefix(jsString(v.Get("vehicleId")), "EST_")) {
		v.Set("isGhostVehicle", true)
		v.Set("isEstimated", true)
		v.Set("isRealTime", false)
		v.Set("isRealtime", false)
		if !truthy(v.Get("delayBadgeText")) {
			v.Set("delayBadgeText", "⚡ Estimat (sense GPS)")
		}
		if !truthy(v.Get("delayFormatted")) {
			v.Set("delayFormatted", "Horari teòric")
		}
		if !truthy(v.Get("statusText")) {
			v.Set("statusText", "⚡ Vehicle estimat segons horari oficial (sense GPS)")
		}
	}

	if v.IsUndef("lat") {
		if n := jsNumber(v.Get("latitude")); isFinite(n) {
			v.Set("lat", n)
		}
	}
	if v.IsUndef("lon") {
		if n := jsNumber(v.Get("longitude")); isFinite(n) {
			v.Set("lon", n)
		}
	}
	if n := jsNumber(v.Get("lat")); isFinite(n) {
		v.Set("latitude", n)
	}
	if n := jsNumber(v.Get("lon")); isFinite(n) {
		v.Set("longitude", n)
	}

	if !truthy(v.Get("lastUpdate")) {
		lu := v.Get("recordedAt")
		if !truthy(lu) {
			lu = isoString(nowMs())
		}
		v.Set("lastUpdate", lu)
	}

	if v.IsUndef("isElectric") {
		fleet := getVehicleFleetInfo(or(v.Get("vehicleId"), v.Get("tripId")))
		v.Set("propulsion", fleet.Get("propulsion"))
		v.Set("isElectric", fleet.Get("isElectric"))
		v.Set("isHybrid", fleet.Get("isHybrid"))
		v.Set("propulsionBadge", fleet.Get("propulsionBadge"))
		v.Set("propulsionIcon", fleet.Get("badgeIcon"))
		v.Set("propulsionClass", fleet.Get("badgeClass"))
		v.Set("modelName", fleet.Get("modelName"))
		v.Set("isAccessible", fleet.Get("isAccessible"))
	}
	return v
}

func mapStandardize(list []any) []any {
	out := make([]any, len(list))
	for i, x := range list {
		out[i] = standardizeVehicle(x)
	}
	return out
}

func harmonizeDeparture(dep any) *Obj {
	d := spreadCopy(dep)
	rawDelay := d.Get("delayMinutes")
	if isUndef(rawDelay) {
		rawDelay = d.Get("delayMins")
	}
	delay := 0.0
	if n := jsNumber(rawDelay); isFinite(n) {
		delay = jsRound(n)
	}
	d.Set("delayMinutes", delay)
	d.Set("delayMins", delay)

	rt := d.Get("isRealTime")
	if isUndef(rt) {
		rt = d.Get("isRealtime")
	}
	isRealTime := truthy(rt)
	d.Set("isRealTime", isRealTime)
	d.Set("isRealtime", isRealTime)

	if !truthy(d.Get("delayStatus")) {
		ev := computeDelayStatus(delay, isRealTime, O(
			"scheduledTime", or(d.Get("scheduledTime"), d.Get("departureTime")),
			"isFirstOfDay", truthy(d.Get("isFirstOfDay")),
			"isNextService", truthy(d.Get("isNextService")),
			"isPassed", truthy(d.Get("isPassed")),
			"isEstimated", truthy(d.Get("isEstimated")),
			"isRegulating", truthy(d.Get("isRegulating")),
			"isOriginRegulating", truthy(d.Get("isOriginRegulating")),
			"originTerminalName", d.Get("originTerminalName"),
			"originDepartureTime", d.Get("originDepartureTime"),
		))
		d.Set("delayStatus", ev.Get("delayStatus"))
		if !truthy(d.Get("delayBadgeText")) {
			d.Set("delayBadgeText", ev.Get("delayBadgeText"))
		}
		if !truthy(d.Get("delayFormatted")) {
			d.Set("delayFormatted", ev.Get("delayFormatted"))
		}
		if !truthy(d.Get("comparisonText")) {
			d.Set("comparisonText", ev.Get("comparisonText"))
		}
	}
	if !truthy(d.Get("formattedStatus")) {
		d.Set("formattedStatus", formatCountdownStatus(d.Get("minutesAway")))
	}
	return d
}

func mapHarmonize(list []any) []any {
	out := make([]any, len(list))
	for i, x := range list {
		out[i] = harmonizeDeparture(x)
	}
	return out
}

func (s *Server) harmonizeDeparturesEnvelope(data any, lineID any) any {
	o, ok := data.(*Obj)
	if !ok || o == nil {
		return data
	}
	stopRaw := or(o.Get("stop"), O())
	stopID := or(or(o.Get("stopId"), field(stopRaw, "id")), nil)
	stopName := or(or(o.Get("stopName"), field(stopRaw, "name")), "")
	departures := []any{}
	if arr, ok := o.Get("departures").([]any); ok {
		departures = mapHarmonize(arr)
	}
	stop := O(
		"id", or(field(stopRaw, "id"), stopID),
		"code", or(field(stopRaw, "code"), stopID),
		"name", stopName,
		"zone", or(field(stopRaw, "zone"), "Mataró Urbà"),
	)
	if v := field(stopRaw, "lat"); !isUndef(v) {
		stop.Set("lat", v)
	} else if v := field(stopRaw, "latitude"); isNumberValue(v) {
		stop.Set("lat", v)
	}
	if v := field(stopRaw, "lon"); !isUndef(v) {
		stop.Set("lon", v)
	} else if v := field(stopRaw, "longitude"); isNumberValue(v) {
		stop.Set("lon", v)
	}
	out := o.Clone()
	out.Set("lineId", or(o.Get("lineId"), jsString(or(lineID, ""))))
	out.Set("stopId", stopID)
	out.Set("stopName", stopName)
	out.Set("stop", stop)
	out.Set("departures", departures)
	if isNumberValue(o.Get("totalDepartures")) {
		out.Set("totalDepartures", o.Get("totalDepartures"))
	} else {
		out.Set("totalDepartures", float64(len(departures)))
	}
	if truthy(o.Get("calendarInfo")) {
		out.Set("calendarInfo", o.Get("calendarInfo"))
	} else {
		out.Set("calendarInfo", s.calendarInfo())
	}
	out.Set("lastUpdated", or(o.Get("lastUpdated"), isoString(nowMs())))
	return out
}

func (s *Server) harmonizeTargetEta(data any, direction any) any {
	o, ok := data.(*Obj)
	if !ok || o == nil {
		return data
	}
	tsRaw := or(o.Get("targetStop"), O())
	coords := field(tsRaw, "coords")
	tsLat := field(tsRaw, "lat")
	if isUndef(tsLat) {
		tsLat = Undefined
		if truthy(coords) {
			tsLat = field(coords, "lat")
		}
	}
	tsLon := field(tsRaw, "lon")
	if isUndef(tsLon) {
		tsLon = Undefined
		if truthy(coords) {
			tsLon = field(coords, "lon")
		}
	}
	nested := spreadCopy(or(coords, O()))
	if !isUndef(tsLat) {
		nested.Set("lat", tsLat)
	}
	if !isUndef(tsLon) {
		nested.Set("lon", tsLon)
	}
	targetStop := spreadCopy(tsRaw)
	if !isUndef(tsLat) {
		targetStop.Set("lat", tsLat)
	}
	if !isUndef(tsLon) {
		targetStop.Set("lon", tsLon)
	}
	if !nested.IsUndef("lat") || !nested.IsUndef("lon") {
		targetStop.Set("coords", nested)
	}
	var upcoming []any
	if arr, ok := o.Get("upcomingDepartures").([]any); ok {
		upcoming = arr
	} else if arr, ok := o.Get("allDepartures").([]any); ok {
		upcoming = arr
	} else {
		upcoming = []any{}
	}
	allDepartures := upcoming
	if arr, ok := o.Get("allDepartures").([]any); ok {
		allDepartures = arr
	}
	out := o.Clone()
	out.Set("targetStop", targetStop)
	if !o.IsUndef("direction") {
		out.Set("direction", jsString(o.Get("direction")))
	} else {
		out.Set("direction", jsString(or(direction, "0")))
	}
	out.Set("directionName", or(o.Get("directionName"), nil))
	if truthy(o.Get("nextBus")) {
		out.Set("nextBus", harmonizeDeparture(o.Get("nextBus")))
	} else {
		out.Set("nextBus", nil)
	}
	out.Set("upcomingDepartures", mapHarmonize(upcoming))
	out.Set("allDepartures", mapHarmonize(allDepartures))
	if truthy(o.Get("calendarInfo")) {
		out.Set("calendarInfo", o.Get("calendarInfo"))
	} else {
		out.Set("calendarInfo", s.calendarInfo())
	}
	out.Set("serviceStatus", or(o.Get("serviceStatus"), nil))
	out.Set("lastUpdated", or(o.Get("lastUpdated"), isoString(nowMs())))
	return out
}

// ---------------------------------------------------------------- SSE

type sseClient struct {
	key     string
	queue   *msgQueue[[]byte]
	removed bool
}

type fleetBroadcaster struct {
	s         *Server
	clients   []*sseClient
	perClient map[string]int
	latest    []byte // the latest snapshot's JSON, nil before the first
	stop      chan struct{}
}

const sseMaxClients = 200
const sseMaxPerClient = 8

// sseMaxQueued frames may wait for a client before the backlog is replaced
// by the newest frame (each fleet frame is a full snapshot, so nothing is
// lost). sseWriteTimeout bounds one frame's write: a client that has stopped
// reading is dropped instead of holding its connection open indefinitely.
const sseMaxQueued = 4
const sseWriteTimeout = 30 * time.Second

func newFleetBroadcaster(s *Server) *fleetBroadcaster {
	return &fleetBroadcaster{s: s, perClient: map[string]int{}}
}

func (b *fleetBroadcaster) frame() []byte {
	if b.latest != nil {
		return append(append([]byte("event: fleet\ndata: "), b.latest...), '\n', '\n')
	}
	return []byte("event: waiting\ndata: {}\n\n")
}

func (b *fleetBroadcaster) removeClient(c *sseClient) {
	if c.removed {
		return
	}
	c.removed = true
	for i, x := range b.clients {
		if x == c {
			b.clients = append(b.clients[:i:i], b.clients[i+1:]...)
			break
		}
	}
	left := b.perClient[c.key] - 1
	if _, ok := b.perClient[c.key]; !ok {
		left = 0
	}
	if left > 0 {
		b.perClient[c.key] = left
	} else {
		delete(b.perClient, c.key)
	}
	c.queue.close()
}

func (b *fleetBroadcaster) broadcast(snapshot *Obj) {
	b.latest = toJSON(snapshot)
	f := b.frame()
	for _, c := range append([]*sseClient(nil), b.clients...) {
		c.queue.pushLatest(f, sseMaxQueued)
	}
}

func (b *fleetBroadcaster) handleRequest(q *xreq, res *xres) error {
	if q.method == "HEAD" {
		res.status = 405
		res.json(O("success", false, "error", "SSE stream requires GET."))
		return nil
	}
	if len(b.clients) >= sseMaxClients {
		res.status = 503
		res.json(O("success", false, "error", "Too many fleet stream clients."))
		return nil
	}
	key := clientKey(q.ip)
	if b.perClient[key] >= sseMaxPerClient {
		res.status = 429
		res.json(O("success", false, "error", "Too many fleet streams from this client."))
		return nil
	}
	res.status = 200
	res.h.Set("Content-Type", "text/event-stream; charset=utf-8")
	res.h.Set("Cache-Control", "no-cache, no-store, no-transform")
	res.h.Set("Connection", "keep-alive")
	res.h.Set("X-Accel-Buffering", "no")
	c := &sseClient{key: key, queue: newMsgQueue[[]byte]()}
	b.clients = append(b.clients, c)
	b.perClient[key]++
	res.sse = c
	c.queue.push(b.frame())
	return nil
}

// serve streams one client's frames, outside the world lock.
func (b *fleetBroadcaster) serve(res *xres) {
	c := res.sse
	w := res.w
	rc := http.NewResponseController(w)
	res.h.Del("Connection") // hop-by-hop: net/http manages keep-alive itself
	w.WriteHeader(200)
	_ = rc.Flush()
	ctx := res.req.r.Context()
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
		case <-done:
		}
		b.s.w.mu.Lock()
		b.removeClient(c)
		b.s.w.mu.Unlock()
	}()
	for {
		f, ok := c.queue.pop()
		if !ok {
			return
		}
		_ = rc.SetWriteDeadline(time.Now().Add(sseWriteTimeout))
		if _, err := w.Write(f); err != nil {
			return
		}
		if err := rc.Flush(); err != nil {
			return
		}
	}
}

func (b *fleetBroadcaster) start() {
	if b.stop != nil {
		return
	}
	b.stop = make(chan struct{})
	stop := b.stop
	go func() {
		t := time.NewTicker(25 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				b.s.w.mu.Lock()
				for _, c := range append([]*sseClient(nil), b.clients...) {
					c.queue.pushLatest([]byte(": ping\n\n"), sseMaxQueued)
				}
				b.s.w.mu.Unlock()
			}
		}
	}()
}

func (b *fleetBroadcaster) shutdown() {
	if b.stop != nil {
		close(b.stop)
		b.stop = nil
	}
	for _, c := range append([]*sseClient(nil), b.clients...) {
		b.removeClient(c)
	}
}

// ---------------------------------------------------------------- startup

func newServer() (*Server, error) {
	trust, err := parseTrustedProxies(os.Getenv("TRUSTED_PROXIES"))
	if err != nil {
		return nil, err
	}
	s := &Server{
		trust:           trust,
		limiter:         newAPILimiter(),
		publicDir:       filepath.Join(appRoot, "public"),
		incidentCache:   newJSMap(),
		incidentRefresh: map[string]bool{},
		monthlyCache:    newJSMap(),
		monthlyRefresh:  map[string]bool{},
		gpsGapCache:     newJSMap(),
		operatorCache:   newJSMap(),
	}
	s.w = newWorld("server")
	s.w.mu.Lock()
	defer s.w.mu.Unlock()
	s.reports = newReportCache(s.w)
	s.registry = newTrackerRegistry(s.w.tracker)
	s.router = newTransitRouter(s.w.tracker)
	s.bridge = newWorkerBridge(s.w, s.reports)

	s.bridge.start()
	s.w.fr.setAutoExtrapolation(false)
	s.w.fr.setHistoryGateway(func(op string, args *Obj) (any, error) {
		timeout := 10000.0
		if op == "getLineDelayStats" {
			timeout = 25000
		}
		return s.bridge.historyQuery(op, args, timeout)
	})
	s.w.siri.setRpcBackend(func(op string, args *Obj) (any, error) {
		return s.bridge.historyQuery(op, args, 1200)
	})
	s.w.tracker.setAvisosRpcBackend(func() (*Obj, error) {
		res, err := s.bridge.historyQuery("getMataroAvisos", O(), 7000)
		if err != nil {
			return nil, err
		}
		if isNullish(res) {
			return nil, errors.New("Cannot read properties of null (reading 'avisos')")
		}
		if o, ok := res.(*Obj); ok {
			return o, nil
		}
		return O(), nil
	})
	s.bridge.onFleetUpdate(func(payload *Obj) {
		if payload == nil {
			return
		}
		if v, ok := payload.Get("vehicles").([]any); ok {
			s.w.tracker.syncFleetVehicles(v)
		}
	})
	s.fleet = newFleetBroadcaster(s)
	s.bridge.onFleetUpdate(func(payload *Obj) {
		if payload == nil {
			return
		}
		if v, ok := payload.Get("vehicles").([]any); ok {
			ts := payload.Get("timestamp")
			if !truthy(ts) {
				ts = float64(nowMs())
			}
			s.fleet.broadcast(O("timestamp", ts, "vehicles", v))
		}
	})
	s.fleet.start()
	s.buildRoutes()
	return s, nil
}

var reCoreDump = regexp.MustCompile(`^core(\.|\b)`)

func cleanCoreDumps() {
	entries, err := os.ReadDir(appRoot)
	if err != nil {
		return
	}
	for _, e := range entries {
		if reCoreDump.MatchString(e.Name()) {
			if os.Remove(filepath.Join(appRoot, e.Name())) == nil {
				log.Printf("[Startup] Cleaned residual core dump file: %s", e.Name())
			}
		}
	}
}

func runServer() int {
	log.SetFlags(0)
	log.SetOutput(os.Stdout)
	cleanCoreDumps()
	startPprof()
	startMemTrimmer()
	loadHolidays(filepath.Join(srcDataDir(), "holidays.json"))
	loadFares(filepath.Join(srcDataDir(), "fares.json"))
	if err := loadSchedules(filepath.Join(srcDataDir(), "mataro_schedules.seasons.json"), filepath.Join(srcDataDir(), "mataro_schedules.json")); err != nil {
		fmt.Fprintln(os.Stderr, "[MataroSchedules] Could not load timetables:", err)
		return 1
	}
	s, err := newServer()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	httpSrv := &http.Server{
		Addr:              ":" + port,
		Handler:           s,
		ReadHeaderTimeout: 60 * time.Second,
		IdleTimeout:       5 * time.Second,
		ErrorLog:          log.New(os.Stderr, "", 0),
	}
	listenErr := make(chan error, 1)
	go func() { listenErr <- httpSrv.ListenAndServe() }()
	fmt.Println("\n======================================================")
	fmt.Println("🚌 Arribo! Mataró Bus Tracker HTTP Server")
	fmt.Println("📡 URL: http://localhost:" + port)
	fmt.Println("📊 Lines: Mataró Bus Urbà (L1 - L8)")
	fmt.Println("🛰️ SIRI: sirimataro.avanzagrupo.com")
	fmt.Print("======================================================\n\n")

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	select {
	case err := <-listenErr:
		fmt.Fprintln(os.Stderr, err)
		return 1
	case <-sig:
	}
	done := make(chan struct{})
	go func() {
		s.shutdown(httpSrv)
		close(done)
	}()
	select {
	case <-done:
		return 0
	case <-time.After(12 * time.Second):
		return 1
	}
}

func (s *Server) shutdown(httpSrv *http.Server) {
	s.w.mu.Lock()
	s.shuttingDown = true
	s.fleet.shutdown()
	s.w.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	if err := httpSrv.Shutdown(ctx); err != nil {
		httpSrv.Close()
	}
	cancel()
	s.w.mu.Lock()
	s.bridge.shutdown(5 * time.Second)
	s.w.mu.Unlock()
	consoleLog([]byte(`{"event":"shutdown_complete"}`))
}

// ---------------------------------------------------------------- routes

func (s *Server) get(paths []string, h func(q *xreq, res *xres) error) {
	e := &routeEntry{handler: h}
	if len(paths) == 1 {
		e.label = paths[0]
	} else {
		e.label = stringsToAny(paths)
	}
	for _, p := range paths {
		e.paths = append(e.paths, compileRoute(p))
	}
	s.routes = append(s.routes, e)
}

func p(paths ...string) []string { return paths }

func (s *Server) sendPage(res *xres, file string) error {
	res.h.Set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0")
	res.h.Set("Pragma", "no-cache")
	res.h.Set("Expires", "0")
	r := res.sendPipe(filepath.Join(s.publicDir, file), sendOptions{maxAgeMs: 0})
	if r.dir {
		return errNext
	}
	if r.err != nil {
		return r.err
	}
	return nil
}

func (s *Server) buildRoutes() {
	s.sseRoute = &routeEntry{label: "/api/fleet/events", paths: []*route{compileRoute("/api/fleet/events")},
		handler: s.fleet.handleRequest}

	planPages := p("/plan", "/com-anar-hi", "/rutes", "/itinerari")
	dadesPages := p("/dades", "/observatori", "/analytics")
	s.get(planPages, func(q *xreq, res *xres) error { return s.sendPage(res, "plan.html") })
	s.get(dadesPages, func(q *xreq, res *xres) error { return s.sendPage(res, "dades.html") })

	s.get(p("/api/ready"), s.hReady)
	s.get(p("/api/health"), s.hHealth)
	s.get(p("/api/data-health"), s.hDataHealth)
	s.get(p("/api/lines"), s.hLines)
	s.get(p("/api/search/stops"), s.hSearchStops)
	s.get(p("/api/network/vehicles"), s.hNetworkVehicles)
	s.get(p("/api/network/rail-routes"), s.hRailRoutes)
	s.get(p("/api/rail/alerts"), s.hRailAlerts)
	s.get(p("/api/line/:lineId"), s.hLine)
	s.get(p("/api/line/:lineId/target-eta"), s.hLineTargetEta)
	s.get(p("/api/line/:lineId/vehicles"), s.hLineVehicles)
	s.get(p("/api/line/:lineId/stop/:stopId/departures"), s.hLineStopDepartures)
	s.get(p("/api/mataro/lines"), func(q *xreq, res *xres) error {
		res.json(O("success", true, "lines", s.w.tracker.getLines()))
		return nil
	})
	s.get(p("/api/mataro/line/:lineId"), s.hMataroLine)
	s.get(p("/api/mataro/target-eta"), s.hMataroTargetEta)
	s.get(p("/api/mataro/stop/:stopId/departures"), s.hMataroStopDepartures)
	s.get(p("/api/mataro/stops/nearby", "/api/mataro/nearby", "/api/stops/nearby"), s.hNearby)
	s.get(p("/api/mataro/plan", "/api/plan"), s.hPlan)
	s.get(p("/api/mataro/line/:lineId/traffic"), s.hTraffic)
	s.get(p("/api/disruptions"), s.hDisruptions)
	s.get(p("/api/vehicles"), s.hVehicles)
	s.get(p("/api/fleet/live"), s.hFleetLive)
	s.get(p("/api/trains"), s.hTrains)
	s.get(p("/api/vehicle/:vehicleId/trail"), s.hTrail)
	s.get(p("/api/line/:lineId/stats"), s.hLineStats)
	s.get(p("/api/analytics/journalism", "/api/retards/journalism"), s.hJournalism)
	s.get(p("/api/analytics/report/monthly", "/api/retards/report/monthly"), s.hMonthly)
	s.get(p("/api/analytics/export/csv", "/api/retards/export/csv"), func(q *xreq, res *xres) error {
		return s.hCsv(q, res, "exportCsv", "transit_delays_")
	})
	s.get(p("/api/analytics/export/visits.csv", "/api/retards/export/visits.csv"), func(q *xreq, res *xres) error {
		return s.hCsv(q, res, "exportVisitsCsv", "transit_stop_visits_")
	})
	s.get(p("/api/retards/ranking", "/api/analytics/ranking"), s.hRanking)
	s.get(p("/api/analytics/termometre", "/api/retards/termometre"), s.hTermometre)
	s.get(p("/api/analytics/incidents", "/api/retards/incidents", "/api/analytics/line/:lineId/incidents"), s.hIncidents)
	s.get(p("/api/analytics/incidents/inspect"), s.hInspect)
	s.get(p("/api/analytics/gps-gaps"), s.hGpsGaps)
	s.get(p("/api/analytics/operators"), s.hOperators)
	s.get(p("/api/analytics/operators/line"), s.hOperatorLine)
	s.get(p("/api/analytics/operators/history"), s.hOperatorHistory)
	s.get(p("/api/analytics/network"), s.hNetwork)
	s.get(p("/api/moventis"), s.hMoventis)
	s.get(p("/api/analytics/gps-gaps/paths"), s.hGpsGapPaths)
	s.get(p("/api/analytics/gps-gaps/passes"), s.hGpsGapPasses)
	s.get(p("/api/diagnostics/upstream"), s.hDiagUpstream)
	s.get(p("/api/diagnostics/test"), s.hDiagTest)
	s.get(p("/sw.js"), func(q *xreq, res *xres) error { return s.sendPage(res, "sw.js") })
	s.get(planPages, func(q *xreq, res *xres) error { return s.sendPage(res, "plan.html") })
	s.get(dadesPages, func(q *xreq, res *xres) error { return s.sendPage(res, "dades.html") })

	s.get(p("/api/*"), func(q *xreq, res *xres) error {
		res.status = 404
		res.json(O("success", false, "error", "API endpoint '"+q.pathname+"' not found."))
		return nil
	})
	s.routes[len(s.routes)-1].all = true
	s.get(p("*"), func(q *xreq, res *xres) error { return s.sendPage(res, "index.html") })
}

// ---------------------------------------------------------------- handlers

func (s *Server) hReady(q *xreq, res *xres) error {
	status := serviceStatus(s.bridge.getStatus(), s.reports.getFreshnessStatus(), len(s.registry.getAllLines()) > 0, s.shuttingDown, float64(nowMs()))
	res.h.Set("Cache-Control", "no-store")
	if truthy(status.Get("ready")) {
		res.status = 200
	} else {
		res.status = 503
	}
	res.json(status)
	return nil
}

func heartbeatAge(now float64, hb any) any {
	if f, ok := hb.(float64); ok && isFinite(f) {
		return math.Max(0, now-f)
	}
	return nil
}

func (s *Server) hHealth(q *xreq, res *xres) error {
	nowI := nowMs()
	now := float64(nowI)
	worker := s.bridge.getStatus()
	reports := s.reports.getFreshnessStatus()
	v := getScheduleValidity()
	allFresh := true
	for _, r := range reports {
		if !truthy(field(r, "fresh")) {
			allFresh = false
			break
		}
	}
	var dataReady any = worker.Get("isHealthy")
	if truthy(dataReady) {
		dataReady = allFresh
	}
	res.json(O(
		"status", "ok",
		"uptime", time.Since(processStart).Seconds(),
		"timestamp", now,
		"agency", "Mataró Bus Urbà",
		"worker", O(
			"healthy", worker.Get("isHealthy"),
			"running", worker.Get("isRunning"),
			"lastHeartbeat", worker.Get("lastHeartbeat"),
			"heartbeatAgeMs", heartbeatAge(now, worker.Get("lastHeartbeat")),
			"restarts", worker.Get("restarts"),
		),
		"reports", reports,
		"schedule", O(
			"season", v.Get("season"),
			"seasonSource", v.Get("seasonSource"),
			"seasonKnown", v.Get("seasonKnown"),
			"seasonsAvailable", v.Get("seasonsAvailable"),
			"usingSeasonsFile", v.Get("usingSeasonsFile"),
			"validUntil", v.Get("validUntil"),
			"expired", v.Get("expired"),
			"source", v.Get("source"),
			"drift", or(field(worker.Get("metrics"), "scheduleDrift"), nil),
			"holidaysKnownForYear", isHolidayKnown(nowI),
			"holidayCoverage", getHolidayCoverage(nowI),
			"seasonOutlook", getSeasonOutlook(nowI),
		),
		"dataReady", dataReady,
	))
	return nil
}

func (s *Server) hDataHealth(q *xreq, res *xres) error {
	res.h.Set("Cache-Control", "no-store")
	nowI := nowMs()
	now := float64(nowI)
	worker := s.bridge.getStatus()
	metrics := worker.Get("metrics")
	circuit := or(field(metrics, "upstream"), nil)
	canary := or(field(metrics, "upstreamCanary"), nil)
	anomaly := or(field(metrics, "fleetAnomaly"), nil)
	drift := or(field(metrics, "scheduleDrift"), nil)
	reports := s.reports.getFreshnessStatus()
	validity := getScheduleValidity()
	outlook := getSeasonOutlook(nowI)
	holidaysKnown := isHolidayKnown(nowI)
	holidayCoverage := getHolidayCoverage(nowI)

	ids := mataroAgency.LineIDs
	chans := make([]chan *Obj, len(ids))
	deadline := time.Now().Add(3 * time.Second)
	for i, id := range ids {
		ch := make(chan *Obj, 1)
		chans[i] = ch
		id := id
		s.w.spawn(func() {
			var d *Obj
			_ = tryJS(func() { d = s.w.tracker.getLineDetails(id, "both", nil) })
			ch <- d
		})
	}
	details := make([]*Obj, len(ids))
	s.w.await(func() {
		for i, ch := range chans {
			t := time.NewTimer(time.Until(deadline))
			select {
			case d := <-ch:
				details[i] = d
			case <-t.C:
			}
			t.Stop()
		}
	})

	linesFleet := []any{}
	var totalLive, totalEst, totalDead, totalSched, totalSchedBuses float64
	complete := true
	for i, id := range ids {
		var fs any = Undefined
		if details[i] != nil {
			fs = details[i].Get("fleetStatus")
		}
		if !truthy(fs) {
			complete = false
			linesFleet = append(linesFleet, O("lineId", id, "lineCode", "L"+id, "available", false))
			continue
		}
		live := numberOr0(field(fs, "liveGpsVehicles"))
		est := numberOr0(field(fs, "estimatedVehicles"))
		dead := numberOr0(field(fs, "deadReckonedVehicles"))
		sched := numberOr0(field(fs, "scheduledVehicles"))
		schedBuses := sched
		if n := jsNumber(field(fs, "scheduledBuses")); isFinite(n) {
			schedBuses = n
		}
		notDrawn := or(field(fs, "notDrawn"), O())
		totalLive += live
		totalEst += est
		totalDead += dead
		totalSched += sched
		totalSchedBuses += schedBuses
		linesFleet = append(linesFleet, O("lineId", id, "lineCode", "L"+id, "available", true,
			"liveGpsVehicles", live, "estimatedVehicles", est, "deadReckonedVehicles", dead,
			"scheduledVehicles", sched, "scheduledBuses", schedBuses, "notDrawn", notDrawn))
	}

	var canaryOut any = nil
	if truthy(canary) {
		canaryOut = O("ok", truthy(field(canary, "ok")), "error", or(field(canary, "error"), nil),
			"checkedAt", or(field(canary, "checkedAt"), nil))
	}
	var lastErrorAt any = nil
	if truthy(field(circuit, "lastError")) {
		lastErrorAt = or(field(circuit, "lastFailureAt"), nil)
	}
	var fleetAnomaly any = nil
	if truthy(metrics) {
		if truthy(anomaly) {
			msg := jsString(anomaly)
			if strictEq(anomaly, "no_vehicles_during_service") {
				msg = "Cap autobús amb GPS mentre l'horari en preveu en servei."
			}
			fleetAnomaly = O("detected", true, "code", jsString(anomaly), "message", msg)
		} else {
			fleetAnomaly = O("detected", false, "code", nil, "message", nil)
		}
	}
	var season any = nil
	if truthy(validity.Get("season")) {
		season = O("season", validity.Get("season"), "seasonKnown", validity.Get("seasonKnown"),
			"seasonSource", validity.Get("seasonSource"))
	}
	res.json(O(
		"success", true,
		"timestamp", now,
		"upstreamCanary", canaryOut,
		"lastError", or(field(circuit, "lastError"), nil),
		"upstreamKnown", truthy(circuit),
		"lastErrorAt", lastErrorAt,
		"circuitOpen", truthy(field(circuit, "circuitOpen")),
		"fleetAnomaly", fleetAnomaly,
		"fleet", O("totalLiveGps", totalLive, "totalEstimated", totalEst, "totalDeadReckoned", totalDead,
			"totalScheduled", totalSched, "totalScheduledBuses", totalSchedBuses, "complete", complete,
			"source", "tracker-line-details", "lines", linesFleet),
		"scheduleDrift", drift,
		"season", season,
		"seasonOutlook", outlook,
		"holidaysKnownForYear", holidaysKnown,
		"holidayCoverage", holidayCoverage,
		"reportFreshness", reports,
	))
	return nil
}

func (s *Server) hLines(q *xreq, res *xres) error {
	var lines []any
	if err := tryJS(func() { lines = s.registry.getAllLines() }); err != nil {
		s.sendInternalError(q, res, err, O("count", 0.0, "lines", []any{}))
		return nil
	}
	out := make([]any, 0, len(lines))
	for _, x := range lines {
		if l, ok := x.(*Obj); ok {
			out = append(out, catalogLine(l))
		}
	}
	ops := catalogOperators(lines)
	if railLines, railOps := railCatalog(); len(railOps) > 0 {
		out = append(out, railLines...)
		ops = append(ops, railOps...)
	}
	res.json(O("success", true, "count", float64(len(out)), "lines", out, "operators", ops))
	return nil
}

func (s *Server) hSearchStops(q *xreq, res *xres) error {
	qs, _ := qv(q, "q").(string)
	if jsTrim(qs) == "" {
		res.json(O("success", true, "query", "", "results", []any{}, "stops", []any{}, "streets", []any{}))
		return nil
	}
	if !streetGeocoder.hasCatalog() && s.w.tracker.allStopsMap != nil {
		streetGeocoder.setStopsCatalog(s.allStops())
	}
	results := s.registry.searchStopsAndLines(qs, 35)
	// Train stations (Rodalies, FGC) after Mataró's stops and lines.
	results = append(results, searchRailStations(qs, 10)...)
	stops := []any{}
	for _, x := range results {
		r, _ := x.(*Obj)
		if r == nil || !strictEq(r.Get("type"), "stop") {
			continue
		}
		stops = append(stops, O(
			"id", or(r.Get("stopId"), r.Get("code")),
			"name", r.Get("stopName"),
			"code", or(r.Get("code"), r.Get("stopId")),
			"zone", or(r.Get("zone"), "Mataró Urbà"),
			"directionText", or(r.Get("directionText"), ""),
			"destinations", or(r.Get("destinations"), []any{}),
			"lineCode", r.Get("lineCode"),
			"lat", r.Get("lat"),
			"lon", r.Get("lon"),
		))
	}
	streets := []any{}
	if utf16Count(jsTrim(qs)) >= 3 {
		if found, err := s.searchStreets(jsTrim(qs), 4); err == nil {
			streets = objsAny(found)
		}
	}
	res.json(O("success", true, "query", qs, "results", results, "stops", stops, "streets", streets))
	return nil
}

// hNetworkVehicles serves the landing network map's buses for every trackable
// line in one response: each line's activeBuses exactly as
// /api/line/:id?direction=both builds them (getLineDetails, mapStandardize),
// without the geometry, stops and departures, which the map loads once.
func (s *Server) hNetworkVehicles(q *xreq, res *xres) error {
	err := tryJS(func() {
		lines := []any{}
		for _, x := range s.registry.getAllLines() {
			l, _ := x.(*Obj)
			if l == nil {
				continue
			}
			id := jsString(l.Get("id"))
			r, rerr := s.registry.getTrackerForLine(id)
			if rerr != nil || r == nil || r.Tracker == nil {
				continue
			}
			buses := []any{}
			if data := r.Tracker.getLineDetails(r.LineID, "both", nil); data != nil {
				if arr, ok := data.Get("activeBuses").([]any); ok {
					buses = mapStandardize(arr)
				}
			}
			lines = append(lines, O("id", id, "code", or(l.Get("code"), id), "activeBuses", buses))
		}
		res.json(O("success", true, "timestamp", float64(nowMs()), "lines", lines))
	})
	if err != nil {
		s.handleRouteError(q, res, err)
	}
	return nil
}

func (s *Server) hLine(q *xreq, res *xres) error {
	if s.hRailLine(q, res, "line") {
		return nil
	}
	lineID := q.params.Get("lineId")
	direction := or(qv(q, "direction"), "0")
	err := tryJS(func() {
		r := s.resolveTrackerOr404(res, lineID)
		if r == nil {
			return
		}
		target := any(r.LineID)
		if r.LineID == "" {
			target = lineID
		}
		data := r.Tracker.getLineDetails(target, direction, nil)
		if data != nil {
			if arr, ok := data.Get("activeBuses").([]any); ok {
				data.Set("activeBuses", mapStandardize(arr))
			}
			data.Set("delayStats", s.w.fr.getLineStats(or(data.Get("code"), target), target))
		}
		res.json(O("success", true, "data", data))
	})
	if err != nil {
		s.handleRouteError(q, res, err)
	}
	return nil
}

func (s *Server) hLineTargetEta(q *xreq, res *xres) error {
	if s.hRailLine(q, res, "eta") {
		return nil
	}
	lineID := q.params.Get("lineId")
	direction := or(qv(q, "direction"), "0")
	stopID := or(qv(q, "stopId"), nil)
	err := tryJS(func() {
		r := s.resolveTrackerOr404(res, lineID)
		if r == nil {
			return
		}
		target := any(r.LineID)
		if r.LineID == "" {
			target = lineID
		}
		data := r.Tracker.getTargetStopETA(target, stopID, direction, nil)
		var d any = data
		if data == nil {
			d = nil
		}
		res.json(O("success", true, "data", s.harmonizeTargetEta(d, direction)))
	})
	if err != nil {
		s.handleRouteError(q, res, err)
	}
	return nil
}

func (s *Server) hLineVehicles(q *xreq, res *xres) error {
	if s.hRailLine(q, res, "vehicles") {
		return nil
	}
	lineID := q.params.Get("lineId")
	direction := or(qv(q, "direction"), "0")
	err := tryJS(func() {
		r := s.resolveTrackerOr404(res, lineID)
		if r == nil {
			return
		}
		target := any(r.LineID)
		if r.LineID == "" {
			target = lineID
		}
		code := r.CleanCode
		if code == "" {
			code = jsString(target)
		}
		vehicles := s.w.fr.getLineVehicles(code)
		var details *Obj
		if len(vehicles) == 0 {
			details = r.Tracker.getLineDetails(target, direction, nil)
			list, _ := field(details, "activeBuses").([]any)
			vehicles = mapStandardize(list)
		} else {
			wanted := jsString(direction)
			kept := []any{}
			for _, x := range mapStandardize(vehicles) {
				v := x.(*Obj)
				d := v.Get("direction")
				if isNullish(d) || jsString(d) == wanted {
					kept = append(kept, v)
				}
			}
			vehicles = kept
		}
		var codeOut any = r.CleanCode
		if c := field(details, "code"); truthy(c) {
			codeOut = c
		} else if r.CleanCode == "" {
			codeOut = jsString(lineID)
		}
		var agency any = "Mataró Bus"
		if a := field(details, "agency"); truthy(a) {
			agency = a
		} else if r.Agency != "" {
			agency = r.Agency
		}
		res.json(O(
			"success", true,
			"lineId", lineID,
			"code", codeOut,
			"name", or(field(details, "name"), nil),
			"agency", agency,
			"direction", jsString(direction),
			"totalVehicles", float64(len(vehicles)),
			"vehicles", vehicles,
			"lastUpdated", isoString(nowMs()),
		))
	})
	if err != nil {
		s.sendInternalError(q, res, err, O("totalVehicles", 0.0, "vehicles", []any{}))
	}
	return nil
}

func (s *Server) hLineStopDepartures(q *xreq, res *xres) error {
	if s.hRailLine(q, res, "departures") {
		return nil
	}
	lineID := q.params.Get("lineId")
	stopID := q.params.Get("stopId")
	direction := or(qv(q, "direction"), "0")
	err := tryJS(func() {
		r := s.resolveTrackerOr404(res, lineID)
		if r == nil {
			return
		}
		target := any(r.LineID)
		if r.LineID == "" {
			target = lineID
		}
		data := r.Tracker.getStopDepartures(stopID, target, direction, nil)
		var d any = data
		if data == nil {
			d = nil
		}
		res.json(O("success", true, "data", s.harmonizeDeparturesEnvelope(d, target)))
	})
	if err != nil {
		s.handleRouteError(q, res, err)
	}
	return nil
}

func (s *Server) hMataroLine(q *xreq, res *xres) error {
	lineID := q.params.Get("lineId")
	direction := "0"
	if strictEq(qv(q, "direction"), "both") {
		direction = "both"
	} else if strictEq(qv(q, "direction"), "1") {
		direction = "1"
	}
	err := tryJS(func() {
		res.json(O("success", true, "data", s.w.tracker.getLineDetails(lineID, direction, nil)))
	})
	if err != nil {
		s.handleRouteError(q, res, err)
	}
	return nil
}

func (s *Server) hMataroTargetEta(q *xreq, res *xres) error {
	lineID := or(qv(q, "lineId"), "1")
	stopID := or(qv(q, "stopId"), nil)
	direction := "0"
	if strictEq(qv(q, "direction"), "1") {
		direction = "1"
	}
	err := tryJS(func() {
		res.json(O("success", true, "data", s.w.tracker.getTargetStopETA(lineID, stopID, direction, nil)))
	})
	if err != nil {
		s.handleRouteError(q, res, err)
	}
	return nil
}

func (s *Server) hMataroStopDepartures(q *xreq, res *xres) error {
	stopID := q.params.Get("stopId")
	lineID := or(qv(q, "lineId"), "")
	err := tryJS(func() {
		res.json(O("success", true, "data", s.w.tracker.getStopDepartures(stopID, lineID, Undefined, nil)))
	})
	if err != nil {
		s.handleRouteError(q, res, err)
	}
	return nil
}

func (s *Server) hNearby(q *xreq, res *xres) error {
	lat := qv(q, "lat")
	lon := qv(q, "lon")
	radius := parseIntOr(qv(q, "radius"), 800)
	limit := math.Min(parseIntOr(qv(q, "limit"), 5), 12)
	includeDepartures := !strictEq(qv(q, "departures"), "false")
	if !truthy(lat) || !truthy(lon) {
		res.status = 400
		res.json(O("success", false, "error", `Query parameters "lat" and "lon" are required.`))
		return nil
	}
	err := tryJS(func() {
		var stops []any
		if includeDepartures {
			stops = s.w.tracker.getNearbyStopsWithDepartures(lat, lon, radius, limit)
		} else {
			stops = s.w.tracker.getNearbyStops(lat, lon, radius, limit)
		}
		if stops == nil {
			stops = []any{}
		}
		res.json(O(
			"success", true,
			"coords", O("lat", parseFloatJS(lat), "lon", parseFloatJS(lon)),
			"radiusMeters", radius,
			"count", float64(len(stops)),
			"stops", stops,
		))
	})
	if err != nil {
		s.sendInternalError(q, res, err, O("count", 0.0, "stops", []any{}))
	}
	return nil
}

// resolveStopName matches an accent-free stop name to the catalog's.
func (s *Server) resolveStopName(query string) string {
	target := jsLower(normalizeStopName(query))
	if target == "" || s.w.tracker.allStopsMap == nil {
		return ""
	}
	for _, stop := range s.allStops() {
		name := jsString(stop.Get("name"))
		if jsLower(normalizeStopName(name)) == target {
			return name
		}
	}
	return ""
}

func (s *Server) geocodeEndpoint(v any) any {
	str, ok := v.(string)
	if !ok || reAllDigits.MatchString(str) {
		return v
	}
	if canonical := s.resolveStopName(str); canonical != "" {
		return canonical
	}
	found, err := s.searchStreets(str, 1)
	if err == nil && len(found) > 0 {
		return O("lat", found[0].Get("lat"), "lon", found[0].Get("lon"), "name", or(found[0].Get("name"), str))
	}
	return v
}

func (s *Server) hPlan(q *xreq, res *xres) error {
	numeric := func(name string, min, max float64) bool {
		v := qv(q, name)
		if isUndef(v) {
			return true
		}
		str, ok := v.(string)
		if !ok || jsTrim(str) == "" {
			return false
		}
		n := stringToNumber(str)
		return isFinite(n) && n >= min && n <= max
	}
	preference := or(qv(q, "preference"), "fastest")
	validPref := strictEq(preference, "fastest") || strictEq(preference, "least_walking") || strictEq(preference, "direct_only")
	if !validPref || !numeric("walkingSpeed", 30, 120) || !numeric("maxWalkingDistance", 50, 5000) ||
		!numeric("fromLat", -90, 90) || !numeric("toLat", -90, 90) || !numeric("fromLon", -180, 180) || !numeric("toLon", -180, 180) ||
		isUndef(qv(q, "fromLat")) != isUndef(qv(q, "fromLon")) || isUndef(qv(q, "toLat")) != isUndef(qv(q, "toLon")) {
		res.status = 400
		res.json(O("success", false, "error", "Paràmetres del trajecte no vàlids."))
		return nil
	}
	if _, err := requestedInstant(or(qv(q, "departureDate"), qv(q, "date")), or(qv(q, "departureTime"), qv(q, "time")), float64(nowMs())); err != nil {
		res.status = 400
		res.json(O("success", false, "error", err.Error()))
		return nil
	}
	from := qv(q, "from")
	to := qv(q, "to")
	if !truthy(from) || !truthy(to) {
		res.status = 400
		res.json(O("success", false, "error", `Query parameters "from" and "to" are required.`))
		return nil
	}
	origin := from
	destination := to
	if truthy(qv(q, "fromLat")) && truthy(qv(q, "fromLon")) {
		origin = O("lat", parseFloatJS(qv(q, "fromLat")), "lon", parseFloatJS(qv(q, "fromLon")), "name", or(qv(q, "fromName"), from))
	}
	if truthy(qv(q, "toLat")) && truthy(qv(q, "toLon")) {
		destination = O("lat", parseFloatJS(qv(q, "toLat")), "lon", parseFloatJS(qv(q, "toLon")), "name", or(qv(q, "toName"), to))
	}
	_, explicitFrom := origin.(*Obj)
	_, explicitTo := destination.(*Obj)
	origin = s.geocodeEndpoint(origin)
	destination = s.geocodeEndpoint(destination)
	// Train journeys (Rodalies, FGC), merged with the bus planner's below.
	departMs, _ := requestedInstant(or(qv(q, "departureDate"), qv(q, "date")), or(qv(q, "departureTime"), qv(q, "time")), float64(nowMs()))
	railItins := s.railPlanFor(from, to, origin, destination, explicitFrom, explicitTo, departMs, qv(q, "walkingSpeed"), qv(q, "maxWalkingDistance"))

	err := tryJS(func() {
		label := func(v any, nameKey string, raw any) any {
			if o, ok := v.(*Obj); ok && truthy(o.Get("name")) {
				return o.Get("name")
			}
			return or(qv(q, nameKey), raw)
		}
		plan, perr := s.router.planJourney(s.w, origin, destination, planOptions{
			originName:     label(origin, "fromName", from),
			destName:       label(destination, "toName", to),
			preference:     or(qv(q, "preference"), "fastest"),
			walkingSpeed:   qv(q, "walkingSpeed"),
			maxWalkingDist: qv(q, "maxWalkingDistance"),
			departureTime:  or(or(qv(q, "departureTime"), qv(q, "time")), nil),
			departureDate:  or(or(qv(q, "departureDate"), qv(q, "date")), nil),
			avisos:         s.w.tracker.avisosList(),
		})
		if perr != nil {
			panic(perr)
		}
		mergeRailItineraries(plan, railItins, jsString(or(qv(q, "preference"), "fastest")))
		res.json(plan)
	})
	if err != nil {
		var jp *jsPanic
		if errors.As(err, &jp) {
			if e, ok := jp.v.(error); ok {
				err = e
			}
		}
		s.sendInternalError(q, res, err, O("success", false, "itineraries", []any{}))
	}
	return nil
}

func (s *Server) hTraffic(q *xreq, res *xres) error {
	lineID := q.params.Get("lineId")
	direction := or(qv(q, "direction"), "0")
	err := tryJS(func() {
		traffic := s.w.tracker.getLineCongestion(lineID, direction)
		res.json(O("success", true).Spread(traffic))
	})
	if err != nil {
		s.sendInternalError(q, res, err, O("success", false, "segments", []any{}))
	}
	return nil
}

func (s *Server) hDisruptions(q *xreq, res *xres) error {
	err := tryJS(func() {
		d := s.w.tracker.getDisruptions(or(qv(q, "line"), nil))
		if d == nil {
			d = []any{}
		}
		res.json(O("success", true, "count", float64(len(d)), "disruptions", d))
	})
	if err != nil {
		s.sendInternalError(q, res, err, O("count", 0.0, "disruptions", []any{}))
	}
	return nil
}

func (s *Server) hVehicles(q *xreq, res *xres) error {
	rawLine := ""
	if !isUndef(qv(q, "line")) {
		rawLine = jsTrim(jsString(qv(q, "line")))
	}
	vehicles := s.w.fr.getAllVehicles()
	if rawLine != "" {
		filter := "L" + reLeadingL.ReplaceAllString(rawLine, "")
		kept := []any{}
		for _, x := range vehicles {
			if jsUpper(jsString(or(field(x, "lineCode"), ""))) == filter {
				kept = append(kept, x)
			}
		}
		vehicles = kept
	}
	std := mapStandardize(vehicles)
	res.json(O("success", true, "count", float64(len(std)), "timestamp", float64(nowMs()), "vehicles", std))
	return nil
}

func (s *Server) hFleetLive(q *xreq, res *xres) error {
	vehicles := s.w.fr.getAllVehicles()
	if vehicles == nil {
		vehicles = []any{}
	}
	metrics := s.bridge.getStatus().Get("metrics")
	res.json(O(
		"success", true,
		"count", float64(len(vehicles)),
		"timestamp", float64(nowMs()),
		"anomaly", or(field(metrics, "fleetAnomaly"), nil),
		"upstreamCanary", or(field(metrics, "upstreamCanary"), nil),
		"vehicles", vehicles,
	))
	return nil
}

func (s *Server) hTrail(q *xreq, res *xres) error {
	vehicleID := q.params.Get("vehicleId")
	var trail any
	var terr error
	perr := tryJS(func() { trail, terr = s.w.fr.getVehicleTrail(vehicleID) })
	if perr != nil {
		terr = perr
	}
	if terr == nil {
		var count any
		switch t := trail.(type) {
		case []any:
			count = float64(len(t))
		case string:
			count = float64(utf16Count(t))
		case *Obj:
			count = t.Get("length")
		case nil, undefinedT:
			terr = &jsPanic{v: "Cannot read properties of null (reading 'length')"}
		default:
			count = Undefined
		}
		if terr == nil {
			res.json(O("success", true, "vehicleId", vehicleID, "pointsCount", count, "trail", trail))
			return nil
		}
	}
	s.handleRouteError(q, res, terr)
	return nil
}

func (s *Server) hLineStats(q *xreq, res *xres) error {
	if s.hRailLine(q, res, "stats") {
		return nil
	}
	lineID := jsString(q.params.Get("lineId"))
	cleanCode := "L" + reLeadingL.ReplaceAllString(lineID, "")
	err := tryJS(func() {
		stats := s.w.fr.getLineStats(cleanCode, lineID)
		res.json(O("success", true, "lineId", lineID, "code", cleanCode, "hoursMonitored", 24.0, "stats", stats))
	})
	if err != nil {
		s.handleRouteError(q, res, err)
	}
	return nil
}

func clampHours(v any, def, max float64) float64 {
	return math.Max(1, math.Min(max, parseIntOr(v, def)))
}

// latestReport is reportCacheService.getLatestReport: nil when missing.
func (s *Server) latestReport(hours float64) any {
	if e := s.reports.getLatestReport(hours); e != nil {
		return e
	}
	return nil
}

func reportTruthy(r any) bool { return r != nil && truthy(r) }

func (s *Server) hJournalism(q *xreq, res *xres) error {
	hours := clampHours(qv(q, "hours"), 24, 168)
	allLines := s.registry.getAllLines()
	err := tryJS(func() {
		report := s.latestReport(hours)
		if !reportTruthy(report) || !truthy(field(report, "summary")) || objKeysLen(field(report, "summary")) == 0 {
			if r, err := s.historyQuery("generateReport", O("hours", hours, "allLinesCatalog", allLines), 30000); err == nil {
				report = r
			}
		}
		if !reportTruthy(report) {
			res.status = 503
			res.json(O("success", false, "error", "Report is warming up, retry shortly."))
			return
		}
		out := spreadAny(O("success", true), report)
		out.Set("report", report)
		res.json(out)
	})
	if err != nil {
		s.sendInternalError(q, res, err, nil)
	}
	return nil
}

var reMonth = regexp.MustCompile(`^\d{4}-\d{2}$`)

// The monthly report reads a whole month of stop visits (about 2.4 s on
// the VPS) and changes slowly, so it is cached per month: a result under
// monthlyFreshMs old is served as is (X-Cache: HIT); one under
// monthlyStaleMs is served at once (X-Cache: STALE) while one background
// query replaces it. A failed or empty report, or one that carries an
// error, is never cached.
const (
	monthlyFreshMs = 5 * 60 * 1000
	monthlyStaleMs = 30 * 60 * 1000
)

func (s *Server) hMonthly(q *xreq, res *xres) error {
	var month any = nil
	if m, ok := qv(q, "month").(string); ok && reMonth.MatchString(m) {
		month = m
	}
	key := getMadridMonthRange(month).MonthStr
	now := float64(nowMs())
	args := func() *Obj { return O("month", month, "allLinesCatalog", s.registry.getAllLines()) }
	if v, ok := s.monthlyCache.Get(key); ok {
		e := v.(*cachedData)
		switch age := now - e.timestamp; {
		case age < monthlyFreshMs:
			res.h.Set("X-Cache", "HIT")
			res.json(spreadAny(O("success", true), e.data))
			return nil
		case age < monthlyStaleMs:
			if !s.monthlyRefresh[key] {
				s.monthlyRefresh[key] = true
				a := args()
				s.w.spawn(func() {
					defer delete(s.monthlyRefresh, key)
					fresh, err := s.historyQuery("getMonthlyReport", a, 30000)
					if err == nil && reportTruthy(fresh) && isUndef(field(fresh, "error")) {
						s.storeMonthly(key, fresh, float64(nowMs()))
					}
				})
			}
			res.h.Set("X-Cache", "STALE")
			res.json(spreadAny(O("success", true), e.data))
			return nil
		}
	}
	report, err := s.historyQuery("getMonthlyReport", args(), 30000)
	if err != nil {
		s.sendInternalError(q, res, err, nil)
		return nil
	}
	if !reportTruthy(report) {
		res.status = 503
		res.json(O("success", false, "error", "Monthly report service unavailable."))
		return nil
	}
	if isUndef(field(report, "error")) {
		s.storeMonthly(key, report, now)
	}
	res.h.Set("X-Cache", "MISS")
	res.json(spreadAny(O("success", true), report))
	return nil
}

func (s *Server) storeMonthly(key string, data any, at float64) {
	s.monthlyCache.Set(key, &cachedData{data: data, timestamp: at})
	if s.monthlyCache.Len() > 24 {
		s.monthlyCache.Delete(s.monthlyCache.Keys()[0])
	}
}

func (s *Server) hCsv(q *xreq, res *xres, which, prefix string) error {
	hours := clampHours(qv(q, "hours"), 48, 720)
	page := math.Max(1, parseIntOr(qv(q, "page"), 1))
	var result any
	var err error
	if which == "exportCsv" {
		result, err = s.w.fr.exportCsv(hours, page)
	} else {
		result, err = s.w.fr.exportVisitsCsv(hours, page)
	}
	if err != nil {
		s.sendInternalError(q, res, err, nil)
		return nil
	}
	var csv any
	if str, ok := result.(string); ok {
		csv = str
	} else {
		csv = or(field(result, "csv"), "")
	}
	total := coalesce(field(result, "total"), 0.0)
	totalPages := coalesce(field(result, "totalPages"), 1.0)
	res.h.Set("Content-Type", "text/csv; charset=utf-8")
	res.h.Set("Content-Disposition", `attachment; filename="`+prefix+numToString(hours)+"h_p"+numToString(page)+`.csv"`)
	res.h.Set("X-Total-Rows", jsString(total))
	res.h.Set("X-Page", numToString(page))
	res.h.Set("X-Pages", jsString(totalPages))
	if str, ok := csv.(string); ok {
		res.send([]byte(str))
	} else {
		res.json(csv)
	}
	return nil
}

func (s *Server) hRanking(q *xreq, res *xres) error {
	allLines := s.registry.getAllLines()
	err := tryJS(func() {
		report := s.latestReport(24)
		if !reportTruthy(report) {
			if r, err := s.historyQuery("generateReport", O("hours", 24.0, "allLinesCatalog", allLines), 30000); err == nil {
				report = r
			}
		}
		var ranking, agency any = []any{}, []any{}
		if reportTruthy(report) {
			ranking = or(field(report, "rankingMostDelayed"), []any{})
			agency = or(field(report, "agencyStats"), []any{})
		}
		res.json(O("success", true, "timeframe", "24h", "timeframeHours", 24.0,
			"ranking", ranking, "rankingMostDelayed", ranking, "agencyStats", agency))
	})
	if err != nil {
		s.sendInternalError(q, res, err, O("ranking", []any{}, "rankingMostDelayed", []any{}, "agencyStats", []any{}, "timeframeHours", 24.0))
	}
	return nil
}

func (s *Server) hTermometre(q *xreq, res *xres) error {
	hours := clampHours(qv(q, "hours"), 24, 168)
	allLines := s.registry.getAllLines()
	err := tryJS(func() {
		report := s.latestReport(hours)
		if !reportTruthy(report) {
			if r, err := s.historyQuery("generateReport", O("hours", hours, "allLinesCatalog", allLines), 30000); err == nil {
				report = r
			}
		}
		var summary any = Undefined
		if reportTruthy(report) {
			summary = field(report, "summary")
		}
		var termometre any = Undefined
		if reportTruthy(report) {
			termometre = field(report, "termometre")
		}
		var term any = termometre
		if !truthy(termometre) {
			// No report (or one without a termòmetre): say so. This used to
			// answer with a made-up scorecard (grade A, 92 %, "Pl. de les
			// Tereses" as the bottleneck) that the API, the share text and the
			// exports passed on as measurements. Same keys as a real
			// termòmetre (historydb_report.go), with nulls and noData.
			term = O(
				"title", "El Termòmetre del Bus ("+numToString(hours)+"h)",
				"timeframeHours", hours,
				"noData", true,
				"noDataReason", "Encara no hi ha cap informe de puntualitat per a aquest període.",
				"grade", nil,
				"punctualityPct", nil,
				"earlyPct", nil,
				"latePct", nil,
				"networkAvgDelay", nil,
				"championLine", nil,
				"worstBottleneck", nil,
				"peakHour", nil,
				"peakHourDelay", nil,
				"totalTripsAnalyzed", 0.0,
				"totalStopVisits", 0.0,
			)
		}
		res.json(O("success", true, "termometre", term, "summary", or(summary, O())))
	})
	if err != nil {
		s.sendInternalError(q, res, err, nil)
	}
	return nil
}

func cacheGetFresh(c *JSMap, key string, now float64) (any, bool) {
	if v, ok := c.Get(key); ok {
		e := v.(*cachedData)
		if now-e.timestamp < 60000 {
			return e.data, true
		}
	}
	return nil, false
}

// incidentStaleMs: how old a cached incidents result may be and still be
// served (marked X-Cache: STALE) while a background query refreshes it.
const incidentStaleMs = 10 * 60 * 1000

func (s *Server) storeIncidents(key string, data any, at float64) {
	s.incidentCache.Set(key, &cachedData{data: data, timestamp: at})
	if s.incidentCache.Len() > 40 {
		s.incidentCache.Delete(s.incidentCache.Keys()[0])
	}
}

func (s *Server) hIncidents(q *xreq, res *xres) error {
	lineParam := or(or(field(q.params, "lineId"), qv(q, "line")), "all")
	hours := clampHours(qv(q, "hours"), 168, 720)
	limit := math.Max(1, math.Min(100, parseIntOr(qv(q, "limit"), 20)))
	minDelay := math.Max(1, parseIntOr(qv(q, "minDelay"), 5))
	upper := jsUpper(jsString(lineParam))
	cacheKey := upper + "_" + numToString(hours) + "_" + numToString(limit) + "_" + numToString(minDelay)
	now := float64(nowMs())
	if data, ok := cacheGetFresh(s.incidentCache, cacheKey, now); ok {
		res.h.Set("X-Cache", "HIT")
		res.json(spreadAny(O("success", true), data))
		return nil
	}
	args := O("lineCode", lineParam, "hours", hours, "limit", limit, "minDelay", minDelay)
	// A result up to incidentStaleMs old is served at once while one
	// background query replaces it: the analysis covers past hours or days,
	// and computing it takes seconds (a 7-day view about 2 s on the VPS),
	// which with a 60 s cache nearly every visit used to wait for.
	if v, ok := s.incidentCache.Get(cacheKey); ok {
		if e := v.(*cachedData); now-e.timestamp < incidentStaleMs {
			if !s.incidentRefresh[cacheKey] {
				s.incidentRefresh[cacheKey] = true
				s.w.spawn(func() {
					defer delete(s.incidentRefresh, cacheKey)
					fresh, err := s.historyQuery("getDelayIncidents", args, 35000)
					if err == nil && truthy(fresh) {
						s.storeIncidents(cacheKey, fresh, float64(nowMs()))
					}
				})
			}
			res.h.Set("X-Cache", "STALE")
			res.json(spreadAny(O("success", true), e.data))
			return nil
		}
	}
	data, err := s.historyQuery("getDelayIncidents", args, 35000)
	if err != nil {
		s.sendInternalError(q, res, err, O("success", false, "lineCode", upper, "hoursAnalyzed", hours,
			"summary", O(), "topIncidents", []any{}, "incidentTrips", []any{}))
		return nil
	}
	if truthy(data) {
		s.storeIncidents(cacheKey, data, now)
	}
	res.h.Set("X-Cache", "MISS")
	res.json(spreadAny(O("success", true), data))
	return nil
}

func (s *Server) hInspect(q *xreq, res *xres) error {
	lineParam := or(qv(q, "line"), "all")
	at := jsNumber(or(qv(q, "at"), 0.0))
	windowMins := math.Max(5, math.Min(240, parseIntJS(or(qv(q, "windowMins"), 60.0))))
	minDelay := math.Max(1, parseIntJS(or(qv(q, "minDelay"), 5.0)))
	data, err := s.historyQuery("inspectDelayIncident", O(
		"lineCode", lineParam,
		"stopName", jsString(or(qv(q, "stop"), "")),
		"vehicleId", jsString(or(qv(q, "vehicle"), "")),
		"at", at,
		"windowMins", windowMins,
		"minDelay", minDelay,
	), 35000)
	if err != nil {
		s.sendInternalError(q, res, err, O("success", false, "found", false, "error", err.Error(), "episode", nil, "dataQuality", O()))
		return nil
	}
	if truthy(data) && truthy(field(data, "found")) {
		res.json(spreadAny(O("success", true), data))
		return nil
	}
	res.json(O("success", true, "found", false,
		"error", or(field(data, "error"), "no data in window"),
		"episode", nil,
		"dataQuality", or(field(data, "dataQuality"), O())))
	return nil
}

var reGapLine = regexp.MustCompile(`^L?[1-8]$`)
var reGapVehicle = regexp.MustCompile(`^\d{3,6}$`)

func (s *Server) hGpsGaps(q *xreq, res *xres) error {
	days := clampHours(qv(q, "days"), 7, 30)
	// ?agency=<train operator> reads that operator's position losses
	// (railgaps.go); without it, Mataró's buses as before.
	agency := ""
	if a := jsTrim(jsString(or(qv(q, "agency"), ""))); a != "" && a != mataroAgency.ID {
		for _, op := range reportOperators {
			if op.ID == a {
				agency = a
			}
		}
		if agency == "" {
			res.status = 400
			res.json(O("success", false, "error", "Unknown operator"))
			return nil
		}
	}
	rawLine := jsUpper(jsTrim(jsString(or(qv(q, "line"), "all"))))
	lineCode := ""
	if agency == "" && reGapLine.MatchString(rawLine) {
		lineCode = "L" + strings.TrimPrefix(rawLine, "L")
	} else if agency != "" && rawLine != "ALL" && reRailLineCode.MatchString(rawLine) {
		lineCode = rawLine
	}
	rawVehicle := jsTrim(jsString(or(qv(q, "vehicle"), "")))
	vehicleID := ""
	if reGapVehicle.MatchString(rawVehicle) {
		vehicleID = rawVehicle
	}
	hideRaw := jsString(or(qv(q, "hide"), ""))
	hide := ""
	if hideRaw == "suspect" || hideRaw == "watch" {
		hide = hideRaw
	}
	keyLine, keyVeh, keyHide := lineCode, vehicleID, hide
	if keyLine == "" {
		keyLine = "ALL"
	}
	if keyVeh == "" {
		keyVeh = "all"
	}
	if keyHide == "" {
		keyHide = "none"
	}
	cacheKey := keyLine + "_" + numToString(days) + "_" + keyVeh + "_" + keyHide
	if agency != "" {
		cacheKey = agency + ":" + cacheKey
	}
	now := float64(nowMs())
	if data, ok := cacheGetFresh(s.gpsGapCache, cacheKey, now); ok {
		res.h.Set("X-Cache", "HIT")
		res.json(spreadAny(O("success", true), data))
		return nil
	}
	args := O("days", days, "lineCode", lineCode, "vehicleId", vehicleID, "hide", hide)
	if agency != "" {
		args.Set("agency", agency)
	}
	data, err := s.historyQuery("getGpsGapHotspots", args, 15000)
	if err != nil {
		s.sendInternalError(q, res, err, O("success", false, "cells", []any{}, "gaps", []any{}, "totals", O()))
		return nil
	}
	s.gpsGapCache.Set(cacheKey, &cachedData{data: data, timestamp: now})
	if s.gpsGapCache.Len() > 20 {
		s.gpsGapCache.Delete(s.gpsGapCache.Keys()[0])
	}
	res.h.Set("X-Cache", "MISS")
	res.json(spreadAny(O("success", true), data))
	return nil
}

// gapIDs is the ?ids= list: unique positive integers, at most 12.
func gapIDs(v any) []any {
	out := []any{}
	seen := map[float64]bool{}
	for _, part := range strings.Split(jsString(or(v, "")), ",") {
		n := stringToNumber(jsTrim(part))
		if !isFinite(n) || math.Trunc(n) != n || !(n > 0) || seen[n] {
			continue
		}
		seen[n] = true
		out = append(out, n)
	}
	if len(out) > 12 {
		out = out[:12]
	}
	return out
}

func (s *Server) hGpsGapPaths(q *xreq, res *xres) error {
	ids := gapIDs(qv(q, "ids"))
	if len(ids) == 0 {
		res.json(O("success", true, "paths", []any{}))
		return nil
	}
	paths, err := s.historyQuery("getGpsGapPaths", O("ids", ids), 15000)
	if err != nil {
		s.sendInternalError(q, res, err, O("success", false, "paths", []any{}))
		return nil
	}
	if _, ok := paths.([]any); !ok {
		paths = []any{}
	}
	res.json(O("success", true, "paths", paths))
	return nil
}

func (s *Server) hGpsGapPasses(q *xreq, res *xres) error {
	ids := gapIDs(qv(q, "ids"))
	days := clampHours(qv(q, "days"), 7, 30)
	if len(ids) == 0 {
		res.json(O("success", true, "stops", []any{}, "buses", []any{}, "totals", nil))
		return nil
	}
	data, err := s.historyQuery("getGpsGapPasses", O("ids", ids, "days", days), 15000)
	if err != nil {
		s.sendInternalError(q, res, err, O("success", false, "buses", []any{}))
		return nil
	}
	res.json(spreadAny(O("success", true), data))
	return nil
}

func (s *Server) hDiagUpstream(q *xreq, res *xres) error {
	res.h.Set("Cache-Control", "no-store")
	now := float64(nowMs())
	status := s.bridge.getStatus()
	metrics := status.Get("metrics")
	circuit := or(field(metrics, "upstream"), nil)
	canary := or(field(metrics, "upstreamCanary"), nil)
	snapshotAt := or(field(circuit, "timestamp"), nil)
	var snapshotAge any = nil
	if f, ok := snapshotAt.(float64); ok && isFinite(f) {
		snapshotAge = math.Max(0, now-f)
	}
	var canaryAge any = nil
	if truthy(field(canary, "checkedAt")) {
		canaryAge = math.Max(0, now-jsNumber(field(canary, "checkedAt")))
	}
	var canaryOut any = nil
	if truthy(canary) {
		canaryOut = O("ok", truthy(field(canary, "ok")), "error", or(field(canary, "error"), nil),
			"checkedAt", or(field(canary, "checkedAt"), nil), "ageMs", canaryAge)
	}
	var upstream *Obj
	if truthy(circuit) {
		vds := field(circuit, "vehicleDeliveryStatus")
		if isUndef(vds) {
			vds = nil
		}
		upstream = O(
			"circuitOpen", truthy(field(circuit, "circuitOpen")),
			"circuitOpenUntil", or(field(circuit, "circuitOpenUntil"), nil),
			"consecutiveFailures", coalesce(field(circuit, "consecutiveFailures"), nil),
			"cooldownMs", coalesce(field(circuit, "cooldownMs"), nil),
			"lastError", or(field(circuit, "lastError"), nil),
			"vehicleDeliveryStatus", vds,
			"lastSuccess", O("vehicles", or(field(circuit, "lastVehicleSuccessAt"), nil), "arrivals", or(field(circuit, "lastArrivalsSuccessAt"), nil)),
			"lastFailureAt", or(field(circuit, "lastFailureAt"), nil),
			"snapshotAgeMs", snapshotAge,
			"canary", canaryOut,
		)
	} else {
		upstream = O("available", false, "snapshotAgeMs", snapshotAge, "canary", canaryOut)
	}
	res.json(O(
		"success", true,
		"timestamp", now,
		"worker", O(
			"running", status.Get("isRunning"),
			"healthy", status.Get("isHealthy"),
			"lastHeartbeatAgeMs", heartbeatAge(now, status.Get("lastHeartbeat")),
		),
		"upstream", upstream,
	))
	return nil
}

func (s *Server) hDiagTest(q *xreq, res *xres) error {
	lineID := or(qv(q, "lineId"), "1")
	start := nowMs()
	var result *Obj
	err := tryJS(func() { result = s.w.tracker.getLineDetails(lineID, "0", nil) })
	if err != nil {
		consoleError(toJSON(O("event", "diagnostics_test_failed", "requestId", q.requestID, "errorType", errName(err))))
		res.json(O("success", false, "lineId", lineID, "provider", "Mataró Bus Urbà", "host", "sirimataro.avanzagrupo.com",
			"status", "offline", "statusCode", 502.0, "error", "Upstream check failed"))
		return nil
	}
	latency := float64(nowMs() - start)
	active := 0.0
	if arr, ok := field(result, "activeBuses").([]any); ok {
		active = float64(len(arr))
	}
	status := "online"
	if latency > 3000 {
		status = "slow"
	}
	t := madridTime(nowMs())
	res.json(O(
		"success", true,
		"lineId", lineID,
		"provider", "Mataró Bus Urbà (Avanza SIRI Gateway)",
		"host", "sirimataro.avanzagrupo.com",
		"auth", "SIRI-Lite Protocol",
		"type", "SOAP / XML VehicleMonitoring",
		"latencyMs", latency,
		"status", status,
		"statusCode", 200.0,
		"activeVehicles", active,
		"message", "Connexió correcta amb sirimataro.avanzagrupo.com ("+numToString(latency)+"ms). "+numToString(active)+" vehicles actius.",
		"testedAt", fmt.Sprintf("%d:%02d:%02d", t.Hour(), t.Minute(), t.Second()),
	))
	return nil
}

// hOperators serves per-operator punctuality for the GTFS-RT operators
// (Rodalies, FGC): /api/analytics/operators?hours=24|168. Cached 60 s.
func (s *Server) hOperators(q *xreq, res *xres) error {
	hours := clampHours(qv(q, "hours"), 24, 168)
	key := numToString(hours)
	now := float64(nowMs())
	if data, ok := cacheGetFresh(s.operatorCache, key, now); ok {
		res.h.Set("X-Cache", "HIT")
		res.json(spreadAny(O("success", true), data))
		return nil
	}
	data, err := s.historyQuery("getOperatorReport", O("hours", hours), 15000)
	if err != nil {
		s.sendInternalError(q, res, err, O("success", false, "operators", []any{}))
		return nil
	}
	s.operatorCache.Set(key, &cachedData{data: data, timestamp: now})
	res.h.Set("X-Cache", "MISS")
	res.json(spreadAny(O("success", true), data))
	return nil
}

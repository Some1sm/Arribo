package main

// Port of src/workers/ingestionWorker.js. Node forks the worker as a child
// process; here it is a second World in the same process. Messages between
// the two still cross as JSON (Node's IPC serializes them), so neither side
// can hold on to the other's objects. The one exception is a report, which
// is already JSON and immutable (see reportcache.go).

import (
	"errors"
	"log"
	"math"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	nan = math.NaN()
	inf = math.Inf(1)
)

func itoa(n int) string { return strconv.Itoa(n) }

// readFileIfExists is fs.existsSync + readFileSync: nil, nil when absent.
func readFileIfExists(p string) ([]byte, error) {
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return b, err
}

func newWorld(name string) *World {
	w := &World{name: name}
	w.siri = newSiriClient(w)
	w.fr = newFlightRecorder(w)
	w.tracker = newMataroTracker(w)
	return w
}

// spawn calls an async function: f runs at once, holding the lock the caller
// holds, until its first await or its end; then the caller carries on.
func (w *World) spawn(f func()) {
	go func() {
		defer w.mu.Unlock()
		f()
	}()
	w.mu.Lock()
}

// msgQueue is an unbounded FIFO: senders never block, as process.send does
// not.
type msgQueue[T any] struct {
	mu     sync.Mutex
	cond   *sync.Cond
	items  []T
	closed bool
}

func newMsgQueue[T any]() *msgQueue[T] {
	q := &msgQueue[T]{}
	q.cond = sync.NewCond(&q.mu)
	return q
}

func (q *msgQueue[T]) push(v T) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return false
	}
	q.items = append(q.items, v)
	q.cond.Signal()
	return true
}

func (q *msgQueue[T]) pop() (T, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.items) == 0 && !q.closed {
		q.cond.Wait()
	}
	var zero T
	if len(q.items) == 0 {
		return zero, false
	}
	v := q.items[0]
	q.items[0] = zero
	q.items = q.items[1:]
	return v, true
}

func (q *msgQueue[T]) close() {
	q.mu.Lock()
	q.closed = true
	q.cond.Broadcast()
	q.mu.Unlock()
}

// passJSON is what a value looks like after Node's IPC: JSON.parse of its
// JSON. Undefined stays Undefined (the key is simply absent); a report entry
// is already JSON.
func passJSON(v any) any {
	switch x := v.(type) {
	case undefinedT:
		return Undefined
	case *reportEntry:
		if x == nil {
			return nil
		}
		return x
	}
	return jsonRoundTrip(v)
}

// workerMsg is a message from the server to the worker.
type workerMsg struct {
	typ       string
	requestID float64
	op        string
	args      any
}

// serverMsg is a message from the worker to the server.
type serverMsg struct {
	typ     string
	payload any
	report  *reportEntry // REPORT_CACHE_UPDATE
	// DB_RESPONSE
	requestID float64
	ok        bool
	result    any
	errMsg    string
}

type Worker struct {
	w        *World
	db       *HistoryDB
	reports  *ReportCache
	registry *TrackerRegistry
	daemon   *IngestionDaemon
	inbox    *msgQueue[workerMsg]
	out      func(serverMsg)
	exited   chan struct{}
	exitOnce sync.Once
}

func newWorker(out func(serverMsg)) *Worker {
	w := newWorld("worker")
	k := &Worker{
		w:      w,
		db:     newHistoryDB(),
		inbox:  newMsgQueue[workerMsg](),
		out:    out,
		exited: make(chan struct{}),
	}
	k.reports = newReportCache(w)
	k.registry = newTrackerRegistry(w.tracker)
	k.daemon = newIngestionDaemon(w, k.db, k.reports)
	k.daemon.setIpcCallback(k.sendToMaster)
	return k
}

func (k *Worker) sendToMaster(typ string, payload any) {
	m := serverMsg{typ: typ}
	if typ == "REPORT_CACHE_UPDATE" {
		if p, ok := payload.(*Obj); ok {
			e, _ := p.Get("report").(*reportEntry)
			m.report = e
			rest := p.Clone()
			rest.Delete("report")
			m.payload = passJSON(rest)
		}
	} else {
		m.payload = passJSON(payload)
	}
	k.out(m)
}

// boot is bootWorker(); then the worker takes messages.
func (k *Worker) boot() {
	log.Printf("[Worker] ⚡ Ingestion Worker initializing (PID: %d)...", os.Getpid())
	k.w.mu.Lock()
	if !k.db.init() {
		log.Printf("[Worker] Fatal: SQLite initialization failed")
	}
	k.reports.setDatabase(k.db)
	k.reports.setIpcCallback(k.sendToMaster)
	k.w.fr.enablePersistence(k.db)
	k.w.fr.setHistoryGateway(func(op string, args *Obj) (any, error) {
		k.w.mu.Lock()
		defer k.w.mu.Unlock()
		return k.executeDbOperation(op, args)
	})
	k.registry.isInitialized = true
	k.daemon.start()
	k.sendToMaster("WORKER_READY", O("pid", float64(os.Getpid()), "version", "3.0.0-mataro"))
	log.Printf("[Worker] ✅ Ingestion Worker Ready and Listening.")
	k.w.mu.Unlock()
	go k.dispatch()
}

// dispatch takes messages in order. Each starts as its own task holding the
// lock; the next one starts once that task finishes or awaits.
func (k *Worker) dispatch() {
	for {
		m, ok := k.inbox.pop()
		if !ok {
			return
		}
		k.w.mu.Lock()
		go func(m workerMsg) {
			defer k.w.mu.Unlock()
			k.handleMasterMessage(m)
		}(m)
	}
}

func (k *Worker) exit() {
	k.exitOnce.Do(func() {
		k.inbox.close()
		close(k.exited)
	})
}

func (k *Worker) handleMasterMessage(m workerMsg) {
	switch m.typ {
	case "PING":
		k.sendToMaster("PONG", k.pongPayload())
	case "TRIGGER_POLL":
		k.daemon.pollMataroVehicles()
	case "GENERATE_REPORT":
		k.reports.generateAllReports(k.registry.getAllLines())
		k.sendToMaster("REPORT_GENERATED", O("timestamp", float64(nowMs())))
	case "DB_REQUEST":
		if m.requestID == 0 || m.op == "" {
			return
		}
		res, err := k.executeDbOperation(m.op, m.args)
		if err != nil {
			msg := err.Error()
			if msg == "" {
				msg = "Error"
			}
			k.out(serverMsg{typ: "DB_RESPONSE", requestID: m.requestID, ok: false, errMsg: msg})
			return
		}
		k.out(serverMsg{typ: "DB_RESPONSE", requestID: m.requestID, ok: true, result: passJSON(res)})
	case "SHUTDOWN":
		log.Printf("[Worker] Graceful shutdown requested by master...")
		k.daemon.stop()
		k.db.close()
		k.exit()
	default:
		log.Printf("[Worker] Unhandled master message type: %s", m.typ)
	}
}

var processBornWorker = time.Now()

func (k *Worker) pongPayload() *Obj {
	vehicles := k.w.fr.getAllVehicles()
	last := 0.0
	for _, raw := range vehicles {
		v, _ := raw.(*Obj)
		x := 0.0
		if v != nil {
			x = jsNumber(v.Get("observedAt"))
			if !truthyNum(x) {
				x = jsNumber(v.Get("timestamp"))
			}
			if !truthyNum(x) {
				x = nan
				if ms, ok := parseDateJS(jsString(v.Get("recordedAt"))); ok {
					x = float64(ms)
				}
			}
			if !truthyNum(x) {
				x = 0
			}
		}
		if x > last {
			last = x
		}
	}
	var lastObs any = nil
	if last != 0 {
		lastObs = last
	}
	return O(
		"timestamp", float64(nowMs()),
		"pid", float64(os.Getpid()),
		"memory", memoryUsage(),
		"uptime", time.Since(processBornWorker).Seconds(),
		"activeVehicles", float64(len(vehicles)),
		"upstream", k.w.siri.getUpstreamStatus(),
		"noticesUpdatedAt", or(k.daemon.noticesUpdatedAt, nil),
		"upstreamCanary", or(k.daemon.upstreamCanary, nil),
		"fleetAnomaly", or(k.daemon.fleetAnomaly, nil),
		"scheduleDrift", or(k.daemon.scheduleDrift, nil),
		"lastObservationAt", lastObs,
	)
}

func truthyNum(x float64) bool { return x != 0 && !math.IsNaN(x) }

// memoryUsage has the shape of process.memoryUsage().
func memoryUsage() *Obj {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	rss := float64(ms.Sys)
	if b, err := os.ReadFile("/proc/self/statm"); err == nil {
		if f := strings.Fields(string(b)); len(f) > 1 {
			if pages, err := strconv.ParseFloat(f[1], 64); err == nil {
				rss = pages * float64(os.Getpagesize())
			}
		}
	}
	return O(
		"rss", rss,
		"heapTotal", float64(ms.HeapSys),
		"heapUsed", float64(ms.HeapAlloc),
		"external", 0.0,
		"arrayBuffers", 0.0,
	)
}

func (k *Worker) executeDbOperation(op string, rawArgs any) (res any, err error) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[Worker] %s failed: %v", op, r)
			err = errors.New(jsString(r))
		}
	}()
	args, _ := rawArgs.(*Obj)
	if args == nil {
		args = O()
	}
	db := k.db
	siri := k.w.siri
	switch op {
	case "getVehicleTrail":
		return db.getVehicleTrail(args.Get("vehicleId"), jsNumber(coalesce(args.Get("minutesBack"), 60.0))), nil
	case "getLineDelayStats":
		return db.getLineDelayStats(args.Get("lineCode"), coalesce(args.Get("hours"), 24.0), args.Get("lineId")), nil
	case "getMataroAvisos":
		avisos := k.w.tracker.fetchAvisos()
		return O("avisos", avisos, "timestamp", k.w.tracker.avisosCacheTime), nil
	case "getMataroLiveVehicles":
		r, err := siri.getLiveVehicles(jsString(or(args.Get("lineRef"), "")))
		if err != nil {
			return nil, err
		}
		if truthy(siri.lastError) {
			return nil, errors.New("SIRI " + jsString(siri.lastError))
		}
		return derefList(r), nil
	case "getMataroStopArrivals":
		r, err := siri.getStopArrivalsOpt(jsString(or(args.Get("stopId"), "")), jsString(or(args.Get("lineRef"), "")), truthy(args.Get("bypassCache")), false)
		if err != nil {
			return nil, err
		}
		if truthy(siri.lastError) {
			return nil, errors.New("SIRI " + jsString(siri.lastError))
		}
		return derefList(r), nil
	case "getJournalismReport":
		return db.getJournalismReport(args.Get("hours"), k.catalogArg(args)), nil
	case "getMonthlyReport":
		return db.getMonthlyReport(args.Get("month"), k.catalogArg(args)), nil
	case "exportDelayLogsCsv":
		return db.exportDelayLogsCsv(args.Get("hours"), args.Get("page"), args.Get("pageSize")), nil
	case "exportStopVisitsCsv":
		return db.exportStopVisitsCsv(args.Get("hours"), args.Get("page"), args.Get("pageSize")), nil
	case "getDelayIncidents":
		return db.getDelayIncidents(args), nil
	case "inspectDelayIncident":
		return db.inspectDelayIncident(args), nil
	case "getGpsGapHotspots":
		return db.getGpsGapHotspots(gapOpts{days: args.Get("days"), lineCode: args.Get("lineCode"),
			vehicleID: args.Get("vehicleId"), hide: args.Get("hide"), now: float64(nowMs())}), nil
	case "getGpsGapPasses":
		return db.getGpsGapPasses(args.Get("ids"), args.Get("days"), float64(nowMs())), nil
	case "getGpsGapPaths":
		return k.gpsGapPaths(args.Get("ids")), nil
	case "generateReport":
		var catalog any
		if l, ok := args.Get("allLinesCatalog").([]any); ok {
			catalog = l
		} else {
			catalog = k.registry.getAllLines()
		}
		return k.reports.generateAndSaveReport(args.Get("hours"), catalog)
	case "checkScheduleDrift":
		return k.daemon.checkScheduleDrift(), nil
	}
	return nil, errors.New("Unknown DB operation: " + op)
}

func derefList(p *[]any) any {
	if p == nil {
		return nil
	}
	return *p
}

func (k *Worker) catalogArg(args *Obj) any {
	if c := args.Get("allLinesCatalog"); truthy(c) {
		return c
	}
	return k.registry.getAllLines()
}

// gapNorm is gapPath.js's norm(): {lat, lon} or {Latitude, Longitude}.
func gapNorm(c any) LatLon {
	o, _ := c.(*Obj)
	if o == nil {
		// Number(undefined.lat) throws in the source; a route point is
		// always an object.
		return LatLon{nan, nan}
	}
	lat := o.Get("lat")
	if isUndef(lat) {
		lat = o.Get("Latitude")
	}
	lon := o.Get("lon")
	if isUndef(lon) {
		lon = o.Get("Longitude")
	}
	return LatLon{jsNumber(lat), jsNumber(lon)}
}

func (k *Worker) gpsGapPaths(ids any) []any {
	gaps := k.db.getGpsGapsByIds(ids)
	out := make([]any, 0, len(gaps))
	for _, g := range gaps {
		routes := k.w.tracker.routes(reLeadingUpperL.ReplaceAllString(jsString(g.Get("lineCode")), ""))
		pref := jsNumber(g.Get("direction"))
		if !truthyNum(pref) {
			pref = 0
		}
		order := []float64{pref}
		for i := range routes {
			if float64(i) != pref {
				order = append(order, float64(i))
			}
		}
		lost := LatLon{g.Num("lostLat"), g.Num("lostLon")}
		reg := LatLon{g.Num("regainedLat"), g.Num("regainedLon")}
		found := false
		for _, i := range order {
			var coords []LatLon
			if i >= 0 && i == math.Trunc(i) && int(i) < len(routes) && routes[int(i)] != nil {
				raw, _ := routes[int(i)].Get("coords").([]any)
				coords = make([]LatLon, len(raw))
				for j, c := range raw {
					coords[j] = gapNorm(c)
				}
			}
			path, length, ok := gapPathCompute(coords, lost, reg, g.Num("gapSec"))
			if ok {
				out = append(out, O("id", g.Get("id"), "lineCode", g.Get("lineCode"), "vehicleId", g.Get("vehicleId"),
					"lostTs", g.Get("lostTs"), "gapSec", g.Get("gapSec"), "lengthM", length, "path", path))
				found = true
				break
			}
		}
		if !found {
			out = append(out, O("id", g.Get("id"), "lineCode", g.Get("lineCode"), "vehicleId", g.Get("vehicleId"),
				"lostTs", g.Get("lostTs"), "gapSec", g.Get("gapSec"), "lengthM", nil, "path", nil))
		}
	}
	return out
}


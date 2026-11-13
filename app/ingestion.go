package main

// Port of src/ingestionDaemon.js: the worker's polling loop. Every method
// runs holding the worker World's lock, as the source runs on the worker's
// event loop; timers take the lock before they call in.

import (
	"log"
	"strings"
	"sync"
	"time"
)

type openVisit struct {
	key            string
	vehicleID      any
	lineCode       string
	direction      string
	stopName       any
	firstTs        float64
	lastTs         float64
	lastDelay      float64
	count          float64
	scheduledTime  string
	actualTime     string
	timesSource    string
	isRealTime     bool
	lastObservedAt any // float64 or nil
	passingAt      any // float64 or nil
}

type IngestionDaemon struct {
	w        *World
	db       *HistoryDB
	reports  *ReportCache
	isRunning bool
	stopping  bool

	openVisits *JSMap // vehId -> *openVisit
	stopCh     chan struct{}
	timersMu   sync.Mutex

	ipc            func(typ string, payload any)
	lastFleetEmit  float64
	lastWarnAt     map[string]float64
	upstreamCanary any // *Obj or nil
	fleetAnomaly   any // string or nil
	zeroFleetSince float64
	scheduleDrift  any // *Obj or nil
	lastDriftDate  string
	noticesUpdatedAt any
	gpsGaps        *GpsGapDetector

	// fetchPage replaces the timetable download in tests.
	fetchPage func(url string) (string, error)
}

func newIngestionDaemon(w *World, db *HistoryDB, reports *ReportCache) *IngestionDaemon {
	return &IngestionDaemon{
		w:                w,
		db:               db,
		reports:          reports,
		openVisits:       newJSMap(),
		lastWarnAt:       map[string]float64{},
		gpsGaps:          newGpsGapDetector(),
		noticesUpdatedAt: Undefined,
	}
}

func (d *IngestionDaemon) setIpcCallback(fn func(typ string, payload any)) { d.ipc = fn }

func (d *IngestionDaemon) emitIpc(typ string, payload any) {
	if d.ipc != nil {
		d.ipc(typ, payload)
	}
}

func (d *IngestionDaemon) emitFleetUpdate() {
	now := float64(nowMs())
	if d.lastFleetEmit != 0 && now-d.lastFleetEmit < 500 {
		return
	}
	d.lastFleetEmit = now
	vehicles := d.w.fr.getAllVehicles()
	d.emitIpc("FLEET_UPDATE", O(
		"timestamp", now,
		"vehicles", vehicles,
		"anomaly", d.fleetAnomaly,
		"upstreamCanary", d.upstreamCanary,
		"scheduleDrift", d.scheduleDrift,
	))
}

func (d *IngestionDaemon) warnThrottled(key, message string) {
	now := float64(nowMs())
	if now-d.lastWarnAt[key] < 5*60*1000 {
		return
	}
	d.lastWarnAt[key] = now
	log.Printf("[IngestionDaemon] ⚠️ [%s] %s", key, message)
}

// task runs fn as an event-loop task: it takes the world lock, unless the
// daemon has been stopped since the timer was armed.
func (d *IngestionDaemon) task(stop chan struct{}, fn func()) {
	d.w.mu.Lock()
	defer d.w.mu.Unlock()
	select {
	case <-stop:
		return
	default:
	}
	fn()
}

func (d *IngestionDaemon) after(stop chan struct{}, delay time.Duration, fn func()) {
	go func() {
		t := time.NewTimer(delay)
		defer t.Stop()
		select {
		case <-stop:
		case <-t.C:
			d.task(stop, fn)
		}
	}()
}

// every is setInterval: each tick is its own task, so a slow async run does
// not hold back the next one.
func (d *IngestionDaemon) every(stop chan struct{}, period time.Duration, fn func()) {
	go func() {
		tk := time.NewTicker(period)
		defer tk.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tk.C:
				go d.task(stop, fn)
			}
		}
	}()
}

func (d *IngestionDaemon) start() {
	if d.isRunning {
		return
	}
	d.isRunning = true
	log.Printf("[IngestionDaemon] 🚀 Starting Mataró Bus Ingestion Server...")
	if d.stopCh != nil {
		close(d.stopCh)
	}
	stop := make(chan struct{})
	d.stopCh = stop

	d.after(stop, 1000*time.Millisecond, func() { d.db.pruneOldRecords() })
	d.after(stop, 200*time.Millisecond, d.pollMataroVehicles)
	d.after(stop, 800*time.Millisecond, d.pollDisruptions)
	d.every(stop, 20*time.Second, d.pollMataroVehicles)
	d.every(stop, 5*time.Minute, d.pollDisruptions)
	d.every(stop, time.Hour, func() { d.db.pruneOldRecords() })
	d.after(stop, 45*time.Second, d.generateJournalismReport)
	d.every(stop, 30*time.Minute, d.generateJournalismReport)
	d.after(stop, 1500*time.Millisecond, d.pollCanary)
	d.every(stop, 5*time.Minute, d.pollCanary)
	d.every(stop, 60*time.Second, func() { d.checkScheduleDriftSchedule(float64(nowMs())) })

	log.Printf("[IngestionDaemon] ✅ Mataró Bus Ingestion Engine Active.")
}

func (d *IngestionDaemon) stop() {
	d.stopping = true
	d.isRunning = false
	if d.stopCh != nil {
		close(d.stopCh)
		d.stopCh = nil
	}
	d.flushAllVisits()
	log.Printf("[IngestionDaemon] Ingestion Daemon Stopped.")
}

func (d *IngestionDaemon) flushVisit(v *openVisit) {
	if v == nil {
		return
	}
	var measured any = nil
	var tripAgrees any = nil
	passingAt := or(or(v.passingAt, v.lastObservedAt), v.lastTs)
	publishedSec := nan
	if v.scheduledTime != "" {
		publishedSec = timeStringToSeconds(v.scheduledTime)
	}
	if truthy(passingAt) && isFinite(publishedSec) {
		if dt := newDate(passingAt); dt.Valid() {
			net := getNetworkTime(dt.ms())
			passingSec := float64(net.Hour*3600 + net.Minute*60 + net.Second)
			m := jsRound(circularDiffSec(passingSec, publishedSec) / 60)
			measured = m
			nearest := matchTrip(MatchArgs{
				LineID:    reLeadingLi.ReplaceAllString(v.lineCode, ""),
				Direction: v.direction,
				ToSeq:     Undefined,
				StopName:  v.stopName,
				DelayMins: Undefined,
				At:        passingAt,
			})
			nearestSec := nan
			if nearest.Bool("matched") {
				nearestSec = timeStringToSeconds(nearest.Str("scheduledTime"))
			}
			if isFinite(nearestSec) {
				if circularDiffSec(nearestSec, publishedSec) == 0 {
					tripAgrees = 1.0
				} else {
					tripAgrees = 0.0
				}
			}
		}
	}
	method := ""
	if m, ok := measured.(float64); ok && isFinite(m) {
		method = "operator_trip"
	} else {
		measured = nil
	}
	d.db.recordStopVisit(O(
		"vehicleId", v.vehicleID,
		"lineCode", v.lineCode,
		"direction", v.direction,
		"stopName", v.stopName,
		"firstTs", v.firstTs,
		"lastTs", v.lastTs,
		"delayMins", v.lastDelay,
		"sampleCount", v.count,
		"scheduledTime", v.scheduledTime,
		"actualTime", v.actualTime,
		"timesSource", v.timesSource,
		"isRealTime", v.isRealTime,
		"measuredDelayMins", measured,
		"measuredMethod", method,
		"tripAgrees", tripAgrees,
		"source", "live",
	))
}

func (d *IngestionDaemon) flushExpiredVisits(now float64) {
	for _, k := range d.openVisits.Keys() {
		raw, ok := d.openVisits.Get(k)
		if !ok {
			continue
		}
		v := raw.(*openVisit)
		if now-v.lastTs > 5*60*1000 {
			d.flushVisit(v)
			d.openVisits.Delete(k)
		}
	}
}

func (d *IngestionDaemon) flushAllVisits() {
	for _, k := range d.openVisits.Keys() {
		raw, _ := d.openVisits.Get(k)
		d.flushVisit(raw.(*openVisit))
	}
	d.openVisits.Clear()
}

// resolveObservedAt is the real observation time of a bus, or nil.
func resolveObservedAt(bus *Obj, isDerived bool) any {
	if c := jsNumber(bus.Get("observedAt")); isFinite(c) && c > 0 {
		return c
	}
	if fr := bus.Get("freshness"); truthy(fr) {
		var fresh float64 = nan
		if fo, ok := fr.(*Obj); ok {
			fresh = jsNumber(fo.Get("observedAt"))
		} else {
			fresh = jsNumber(Undefined)
		}
		if isFinite(fresh) && fresh > 0 {
			return fresh
		}
	}
	if isDerived {
		return nil
	}
	if ts := jsNumber(bus.Get("timestamp")); isFinite(ts) && ts > 0 {
		return ts
	}
	if rec := bus.Get("recordedAt"); truthy(rec) {
		if ms, ok := parseDateJS(jsString(rec)); ok && ms > 0 {
			return float64(ms)
		}
	}
	return nil
}

func (d *IngestionDaemon) pollMataroVehicles() {
	lines := []string{"1", "2", "3", "4", "5", "6", "7", "8"}
	var wg sync.WaitGroup
	for _, lID := range lines {
		lID := lID
		wg.Add(1)
		d.w.spawn(func() {
			defer wg.Done()
			d.pollLine(lID)
		})
	}
	d.w.await(wg.Wait)
	if !d.stopping {
		now := float64(nowMs())
		d.flushExpiredVisits(now)
		d.checkFleetAnomaly(now)
		d.emitFleetUpdate()
	}
}

func (d *IngestionDaemon) pollLine(lID string) {
	defer func() {
		// A failing line is skipped, as the source's per-line catch does.
		if r := recover(); r != nil {
			log.Printf("[IngestionDaemon] line %s poll error: %v", lID, r)
		}
	}()
	details := d.w.tracker.getLineDetails(lID, "both", nil)
	if d.stopping {
		return
	}
	if details == nil {
		return
	}
	buses, ok := details.Get("activeBuses").([]any)
	if !ok {
		return
	}
	for _, raw := range buses {
		b, _ := raw.(*Obj)
		if b == nil {
			continue
		}
		d.ingestBus(lID, b)
	}
}

func (d *IngestionDaemon) ingestBus(lID string, b *Obj) {
	vehicleIDRaw := b.Get("vehicleId")
	if truthy(b.Get("isGhostVehicle")) || (truthy(vehicleIDRaw) && strings.HasPrefix(jsString(vehicleIDRaw), "EST_")) {
		return
	}
	isDerived := truthy(b.Get("isEstimated")) || strictEq(b.Get("isRealTime"), false)
	observedAt := resolveObservedAt(b, isDerived)
	lineCode := "L" + lID

	gap := d.gpsGaps.observe(O(
		"vehicleId", vehicleIDRaw,
		"lineCode", lineCode,
		"direction", b.Get("direction"),
		"lat", b.Get("lat"),
		"lon", b.Get("lon"),
		"observedAt", observedAt,
		"isTerminalLayover", b.Get("isTerminalLayover"),
		"toStop", b.Get("toStop"),
	))
	if gap != nil && !isOutsideRevenueService(lID, gap.Num("lostTs")) {
		d.db.recordGpsGap(gap)
	}

	var hasSpeed bool
	if !b.IsUndef("hasSpeed") {
		hasSpeed = truthy(b.Get("hasSpeed"))
	} else {
		_, isNum := b.Get("speedKmh").(float64)
		hasSpeed = isNum && isFinite(b.Num("speedKmh"))
	}
	var speedKmh any = nil
	if hasSpeed {
		speedKmh = b.Num("speedKmh")
	}
	var hasDelay bool
	if !b.IsUndef("hasDelay") {
		hasDelay = truthy(b.Get("hasDelay"))
	} else {
		_, isNum := b.Get("delayMins").(float64)
		hasDelay = isNum && isFinite(b.Num("delayMins"))
	}
	var delayMins any = nil
	if hasDelay {
		delayMins = b.Num("delayMins")
	}
	var direction any = Undefined
	if !b.IsUndef("direction") {
		direction = jsString(b.Get("direction"))
	}
	var offRouteM any = nil
	if truthy(b.Get("offRoute")) {
		offRouteM = b.Get("offRouteM")
	}
	d.w.fr.ingestVehicle(O(
		"vehicleId", or(vehicleIDRaw, "mataro_"+lID+"_"+jsString(or(b.Get("plateNumber"), "bus"))),
		"lineId", lID,
		"lineCode", lineCode,
		"agency", "Mataró Bus (Avanza)",
		"direction", direction,
		"plateNumber", or(b.Get("plateNumber"), ""),
		"lat", b.Get("lat"),
		"lon", b.Get("lon"),
		"latitude", b.Get("lat"),
		"longitude", b.Get("lon"),
		"speedKmh", speedKmh,
		"hasSpeed", hasSpeed,
		"bearing", or(b.Get("bearing"), 0.0),
		"delayMins", delayMins,
		"hasDelay", hasDelay,
		"destination", or(b.Get("destination"), ""),
		"isRealTime", !truthy(b.Get("isEstimated")),
		"isEstimated", truthy(b.Get("isEstimated")),
		"observedAt", observedAt,
		"serviceableMs", 90.0*1000,
		"isTerminalLayover", truthy(b.Get("isTerminalLayover")),
		"offRoute", truthy(b.Get("offRoute")),
		"offRouteM", offRouteM,
		"fromStop", b.Get("fromStop"),
		"toStop", b.Get("toStop"),
		"fromSeq", b.Get("fromSeq"),
		"toSeq", b.Get("toSeq"),
		"totalProgress", b.Get("totalProgress"),
		"distanceToNextMeters", b.Get("distanceToNextMeters"),
	))

	nowF := float64(nowMs())
	obsOrNow := nowF
	if truthy(observedAt) {
		obsOrNow = observedAt.(float64)
	}
	outsideRevenue := isOutsideRevenueService(lID, obsOrNow)
	isLayover := truthy(b.Get("isTerminalLayover")) || outsideRevenue
	if !isLayover && hasSpeed {
		sp := speedKmh.(float64)
		if sp <= 3 && delayMins != nil {
			dm := delayMins.(float64)
			isLayover = dm > 10 || dm < -5
		}
	}
	plausible := false
	if hasDelay {
		dm := delayMins.(float64)
		plausible = dm > -15 && dm <= 300
	}
	if !plausible || isLayover {
		return
	}
	dm := delayMins.(float64)

	var vehID any
	if truthy(vehicleIDRaw) {
		vehID = vehicleIDRaw
	} else if truthy(b.Get("plateNumber")) {
		vehID = "mataro_" + lID + "_" + jsString(b.Get("plateNumber"))
	} else {
		vehID = "mataro_" + lID + "_bus"
	}
	stopName := or(b.Get("toStop"), "Parada")
	dirStr := ""
	if !b.IsUndef("direction") {
		dirStr = jsString(b.Get("direction"))
	}
	sampleTs := obsOrNow
	visitKey := lineCode + "|" + dirStr + "|" + jsString(stopName)

	trip := matchTrip(MatchArgs{
		LineID:    lID,
		Direction: b.Get("direction"),
		ToSeq:     b.Get("toSeq"),
		StopName:  b.Get("toStop"),
		DelayMins: dm,
		At:        sampleTs,
	})

	mapKey := jsString(vehID)
	var open *openVisit
	if raw, ok := d.openVisits.Get(mapKey); ok {
		open = raw.(*openVisit)
	}
	if open != nil && open.key == visitKey && truthy(observedAt) && truthy(open.lastObservedAt) && observedAt.(float64) == open.lastObservedAt.(float64) {
		return
	}
	dist := jsNumber(b.Get("distanceToNextMeters"))
	within30 := isFinite(dist) && dist <= 30
	var obsOrNil any = nil
	if truthy(observedAt) {
		obsOrNil = observedAt
	}
	matched := trip.Bool("matched")

	if open != nil && open.key == visitKey && sampleTs-open.lastTs <= 5*60*1000 && sampleTs >= open.firstTs-60000 {
		open.lastTs = sampleTs
		open.lastDelay = dm
		open.count++
		if within30 {
			open.passingAt = sampleTs
		}
		if matched {
			open.scheduledTime = trip.Str("scheduledTime")
			open.actualTime = trip.Str("actualTime")
			open.timesSource = "derived_timetable"
		}
		open.isRealTime = !truthy(b.Get("isEstimated"))
		open.lastObservedAt = obsOrNil
	} else {
		if open != nil {
			if !truthy(open.passingAt) {
				open.passingAt = sampleTs
			}
			d.flushVisit(open)
		}
		nv := &openVisit{
			key:            visitKey,
			vehicleID:      vehID,
			lineCode:       lineCode,
			direction:      dirStr,
			stopName:       stopName,
			firstTs:        sampleTs,
			lastTs:         sampleTs,
			lastDelay:      dm,
			count:          1,
			isRealTime:     !truthy(b.Get("isEstimated")),
			lastObservedAt: obsOrNil,
		}
		if matched {
			nv.scheduledTime = trip.Str("scheduledTime")
			nv.actualTime = trip.Str("actualTime")
			nv.timesSource = "derived_timetable"
		}
		if within30 {
			nv.passingAt = sampleTs
		}
		d.openVisits.Set(mapKey, nv)
		if d.openVisits.Len() > 500 {
			oldestKey := ""
			found := false
			oldestTs := inf
			for _, k := range d.openVisits.Keys() {
				raw, _ := d.openVisits.Get(k)
				if v := raw.(*openVisit); v.lastTs < oldestTs {
					oldestTs = v.lastTs
					oldestKey = k
					found = true
				}
			}
			if found {
				raw, _ := d.openVisits.Get(oldestKey)
				d.flushVisit(raw.(*openVisit))
				d.openVisits.Delete(oldestKey)
			}
		}
	}

	sched, actual, src := "", "", ""
	if matched {
		sched, actual, src = trip.Str("scheduledTime"), trip.Str("actualTime"), "derived_timetable"
	}
	d.db.recordDelayLog(O(
		"vehicleId", vehID,
		"lineId", lID,
		"lineCode", lineCode,
		"agency", "Mataró Bus (Avanza)",
		"stopId", stopName,
		"stopName", stopName,
		"delayMins", dm,
		"scheduledTime", sched,
		"actualTime", actual,
		"direction", dirStr,
		"timesSource", src,
		"isRealTime", !truthy(b.Get("isEstimated")),
		"observedAt", obsOrNil,
	))
}

func (d *IngestionDaemon) pollCanary() {
	checkedAt := float64(nowMs())
	s := d.w.siri
	_, err := s.getStopArrivalsOpt("1016", "", true, true)
	if err == nil {
		if truthy(s.lastError) {
			d.upstreamCanary = O("ok", false, "error", s.lastError, "checkedAt", checkedAt)
		} else {
			d.upstreamCanary = O("ok", true, "error", nil, "checkedAt", checkedAt)
		}
	} else {
		var name any = s.lastError
		if !truthy(name) {
			msg := err.Error()
			if strings.HasPrefix(msg, "SIRI ") {
				name = msg[5:]
			} else {
				name = "upstream_error"
			}
			if !truthy(name) {
				name = "upstream_error"
			}
		}
		d.upstreamCanary = O("ok", false, "error", name, "checkedAt", checkedAt)
	}
	if !d.stopping {
		d.emitFleetUpdate()
	}
}

func (d *IngestionDaemon) checkFleetAnomaly(now float64) *Obj {
	liveCount := len(d.w.fr.getAllVehicles())
	net := getNetworkTime(int64(now))
	nowSec := float64(net.Hour*3600 + net.Minute*60 + net.Second)
	dayType := resolveDayType(int64(now)).DayType
	scheduled := 0.0
	for _, l := range []string{"1", "2", "3", "4", "5", "6", "7", "8"} {
		scheduled += getScheduledFleetRequirement(l, dayType, nowSec, true, "")
	}
	if liveCount > 0 {
		d.zeroFleetSince = 0
		d.fleetAnomaly = nil
	} else {
		if d.zeroFleetSince == 0 {
			d.zeroFleetSince = now
		}
		if scheduled >= 3 && now-d.zeroFleetSince >= 5*60*1000 {
			d.fleetAnomaly = "no_vehicles_during_service"
		} else {
			d.fleetAnomaly = nil
		}
	}
	return O("scheduled", scheduled, "liveCount", float64(liveCount), "anomaly", d.fleetAnomaly)
}

func (d *IngestionDaemon) pollDisruptions() {
	disruptions := d.w.tracker.getDisruptions(Undefined)
	if d.stopping {
		return
	}
	d.noticesUpdatedAt = float64(nowMs())
	if disruptions == nil {
		disruptions = []any{}
	}
	d.emitIpc("DISRUPTIONS_UPDATE", O(
		"timestamp", float64(nowMs()),
		"disruptions", disruptions,
	))
}

func (d *IngestionDaemon) generateJournalismReport() {
	all := d.w.tracker.getLines()
	d.reports.generateAllReports(all)
}

func (d *IngestionDaemon) checkScheduleDriftSchedule(now float64) {
	net := getNetworkTime(int64(now))
	if net.Hour == 4 && net.Minute >= 10 && net.Minute <= 20 {
		key := itoa(net.Year) + "-" + itoa(net.Month) + "-" + itoa(net.Day)
		if d.lastDriftDate != key {
			d.lastDriftDate = key
			d.w.spawn(func() { d.checkScheduleDrift() })
		}
	}
}

// checkScheduleDrift compares the published grids on maresme.net with the
// shipped seasons file. Returns nil when the check could not run.
func (d *IngestionDaemon) checkScheduleDrift() any {
	shippedPath := scraperOutputPath()
	shippedRaw, err := readFileIfExists(shippedPath)
	if err != nil || shippedRaw == nil {
		if err != nil {
			log.Printf("[IngestionDaemon] Schedule drift check failed: %v", err)
		}
		return nil
	}
	shipped, err := parseJSON(shippedRaw)
	if err != nil {
		log.Printf("[IngestionDaemon] Schedule drift check failed: %v", err)
		return nil
	}
	curRaw, err := readFileIfExists(scraperCurrentPath())
	if err != nil || curRaw == nil {
		log.Printf("[IngestionDaemon] Schedule drift check failed: ENOENT")
		return nil
	}
	current, err := parseJSON(curRaw)
	if err != nil {
		log.Printf("[IngestionDaemon] Schedule drift check failed: %v", err)
		return nil
	}
	var fresh *Obj
	fetch := d.fetchPage
	if fetch == nil {
		fetch = fetchTimetablePage
	}
	// The download is real I/O: the event loop keeps running meanwhile.
	d.w.await(func() { fresh, err = scrapeSeasons(current, fetch) })
	if err != nil {
		log.Printf("[IngestionDaemon] Schedule drift check failed: %v", err)
		return nil
	}
	var differences []any
	layoutErr := fresh.Get("error")
	if !truthy(layoutErr) {
		so, _ := shipped.(*Obj)
		var shippedSeasons any = Undefined
		if so != nil {
			shippedSeasons = so.Get("seasons")
		}
		differences, err = diffAgainstShipped(shippedSeasons, fresh.Get("seasons"))
		if err != nil {
			log.Printf("[IngestionDaemon] Schedule drift check failed: %v", err)
			return nil
		}
	}
	res := O(
		"drift", truthy(layoutErr) || len(differences) > 0,
		"checkedAt", isoString(nowMs()),
		"differencesCount", float64(len(differences)),
	)
	if truthy(layoutErr) {
		res.Set("layoutError", layoutErr)
	}
	d.scheduleDrift = res
	d.emitIpc("SCHEDULE_DRIFT_UPDATE", res)
	return res
}

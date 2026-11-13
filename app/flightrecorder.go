package main

// Port of src/flightRecorder.js: in-memory fleet state per process, the 5 s
// dead-reckoning tick (worker only), 60 s snapshot sampling to SQLite, and
// the async history gateway for reads.
//
// Vehicle states are *Obj values with the source's key order; getLineVehicles
// returns the states themselves, as the source does, and callers mutate them.

import (
	"log"
	"math"
	"os"
	"strings"
	"time"
)

func noLineStats() *Obj {
	return O("totalVisits", 0.0, "totalSamples", 0.0, "avgDelayMins", nil, "maxDelayMins", nil, "onTimePct", nil,
		"earlyPct", nil, "latePct", nil, "moderateLatePct", nil, "severeLatePct", nil, "isBaseline", true)
}

type frPersistence interface {
	recordVehicleSnapshot(*Obj)
}

type statsEntry struct {
	data      any
	timestamp float64
}

type FlightRecorder struct {
	w                      *World
	vehicles               *JSMap // vehicleId -> *Obj
	lineIndex              *JSMap // lineCode -> *JSMap (ordered set)
	maxMemoryBreadcrumbs   int
	snapshotIntervalMs     float64
	statsCache             *JSMap
	statsCacheTtlMs        float64
	autoExtrapolation      bool
	db                     frPersistence
	gateway                func(op string, args *Obj) (any, error)
	maxExtrapolationMs     float64
	staleEvictionCeilingMs float64
	stopTick               chan struct{}
}

func newFlightRecorder(w *World) *FlightRecorder {
	iv := parseIntJS(strOr(os.Getenv("VEHICLE_SNAPSHOT_INTERVAL_MS"), "60000"))
	if !(isFinite(iv) && iv > 0) {
		iv = 60000
	}
	return &FlightRecorder{
		w:                      w,
		vehicles:               newJSMap(),
		lineIndex:              newJSMap(),
		maxMemoryBreadcrumbs:   60,
		snapshotIntervalMs:     iv,
		statsCache:             newJSMap(),
		statsCacheTtlMs:        30000,
		autoExtrapolation:      true,
		maxExtrapolationMs:     90000,
		staleEvictionCeilingMs: 90000,
	}
}

// startAutoExtrapolation runs the 5 s dead-reckoning tick under the world
// lock (the source's setInterval). The server process never starts it.
func (f *FlightRecorder) startAutoExtrapolation() {
	if f.stopTick != nil || !f.autoExtrapolation {
		return
	}
	stop := make(chan struct{})
	f.stopTick = stop
	go func() {
		tk := time.NewTicker(5 * time.Second)
		defer tk.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tk.C:
				f.w.mu.Lock()
				f.extrapolateStaleVehicles()
				f.w.mu.Unlock()
			}
		}
	}()
}

func (f *FlightRecorder) setAutoExtrapolation(enabled bool) {
	f.autoExtrapolation = enabled
	if !enabled && f.stopTick != nil {
		close(f.stopTick)
		f.stopTick = nil
	}
}

func (f *FlightRecorder) enablePersistence(db frPersistence) { f.db = db }

func (f *FlightRecorder) setHistoryGateway(fn func(op string, args *Obj) (any, error)) { f.gateway = fn }

// callGateway awaits the gateway with the world unlocked.
func (f *FlightRecorder) callGateway(op string, args *Obj) (any, error) {
	var res any
	var err error
	g := f.gateway
	f.w.await(func() { res, err = g(op, args) })
	return res, err
}

func finiteNumOrNull(v any) any {
	if n := jsNumber(v); isFinite(n) {
		return n
	}
	return nil
}

func definedOr(v any, def any) any {
	if isUndef(v) {
		return def
	}
	return v
}

func (f *FlightRecorder) indexLine(lineCode, vID string) {
	sv, ok := f.lineIndex.Get(lineCode)
	if !ok {
		sv = newJSMap()
		f.lineIndex.Set(lineCode, sv)
	}
	sv.(*JSMap).Set(vID, true)
}

func (f *FlightRecorder) ingestVehicle(snap *Obj) {
	if snap == nil || !truthy(snap.Get("vehicleId")) {
		return
	}
	vID := jsString(snap.Get("vehicleId"))
	if strings.HasPrefix(vID, "EST_") || truthy(snap.Get("isGhostVehicle")) || truthy(snap.Get("isTheoretical")) {
		return
	}
	lineCode := strings.ToUpper(jsString(or(snap.Get("lineCode"), "")))
	now := float64(nowMs())
	fresh := !truthy(snap.Get("isEstimated")) && !truthy(snap.Get("isDeadReckoned"))
	snapObs := jsNumber(snap.Get("observedAt"))
	observedAt := now
	if isFinite(snapObs) && snapObs > 0 {
		observedAt = snapObs
	}
	speed := finiteNumOrNull(snap.Get("speedKmh"))
	delay := finiteNumOrNull(snap.Get("delayMins"))
	serviceable := func() any {
		if s := jsNumber(snap.Get("serviceableMs")); isFinite(s) && s > 0 {
			return s
		}
		return Undefined
	}
	offRouteM := any(nil)
	if truthy(snap.Get("offRoute")) {
		offRouteM = snap.Get("offRouteM")
	}

	var v *Obj
	if vv, ok := f.vehicles.Get(vID); ok {
		v = vv.(*Obj)
		v.Set("lat", jsNumber(snap.Get("lat")))
		v.Set("lon", jsNumber(snap.Get("lon")))
		v.Set("speedKmh", speed)
		if !snap.IsUndef("hasSpeed") {
			v.Set("hasSpeed", truthy(snap.Get("hasSpeed")))
		}
		v.Set("bearing", jsNumber(or(snap.Get("bearing"), 0.0)))
		v.Set("delayMins", delay)
		if !snap.IsUndef("hasDelay") {
			v.Set("hasDelay", truthy(snap.Get("hasDelay")))
		}
		if truthy(snap.Get("destination")) {
			v.Set("destination", snap.Get("destination"))
		}
		if !snap.IsUndef("direction") {
			v.Set("direction", jsString(snap.Get("direction")))
		}
		v.Set("isRealTime", snap.Get("isRealTime") != false)
		v.Set("isEstimated", truthy(snap.Get("isEstimated")) || truthy(snap.Get("isDeadReckoned")))
		if !snap.IsUndef("serviceableMs") {
			v.Set("serviceableMs", serviceable())
		}
		v.Set("status", "active")
		if fresh {
			v.Set("extrapolatedMs", 0.0)
			v.Set("observedAt", observedAt)
		}
		v.Set("lastSeen", now)
		if lineCode != "" {
			v.Set("lineCode", lineCode)
		}
		v.Set("isTerminalLayover", truthy(snap.Get("isTerminalLayover")))
		v.Set("offRoute", truthy(snap.Get("offRoute")))
		v.Set("offRouteM", offRouteM)
		for _, k := range []string{"fromStop", "toStop", "fromSeq", "toSeq", "totalProgress", "distanceToNextMeters"} {
			if !snap.IsUndef(k) {
				v.Set(k, snap.Get(k))
			}
		}
	} else {
		var dir any = Undefined
		if !snap.IsUndef("direction") {
			dir = jsString(snap.Get("direction"))
		}
		hasSpeed := any(isFinite(jsNumber(snap.Get("speedKmh"))))
		if !snap.IsUndef("hasSpeed") {
			hasSpeed = truthy(snap.Get("hasSpeed"))
		}
		hasDelay := any(isFinite(jsNumber(snap.Get("delayMins"))))
		if !snap.IsUndef("hasDelay") {
			hasDelay = truthy(snap.Get("hasDelay"))
		}
		v = O(
			"vehicleId", vID,
			"lineId", or(snap.Get("lineId"), ""),
			"lineCode", lineCode,
			"direction", dir,
			"agency", or(snap.Get("agency"), "Transit"),
			"plateNumber", or(snap.Get("plateNumber"), ""),
			"lat", jsNumber(snap.Get("lat")),
			"lon", jsNumber(snap.Get("lon")),
			"speedKmh", speed,
			"hasSpeed", hasSpeed,
			"bearing", jsNumber(or(snap.Get("bearing"), 0.0)),
			"delayMins", delay,
			"hasDelay", hasDelay,
			"destination", or(snap.Get("destination"), ""),
			"isRealTime", snap.Get("isRealTime") != false,
			"isEstimated", truthy(snap.Get("isEstimated")) || truthy(snap.Get("isDeadReckoned")),
			"serviceableMs", serviceable(),
			"status", "active",
			"lastSeen", now,
			"observedAt", observedAt,
			"extrapolatedMs", 0.0,
			"lastPersistedAt", 0.0,
			"history", []any{},
			"isTerminalLayover", truthy(snap.Get("isTerminalLayover")),
			"offRoute", truthy(snap.Get("offRoute")),
			"offRouteM", offRouteM,
			"fromStop", definedOr(snap.Get("fromStop"), Undefined),
			"toStop", definedOr(snap.Get("toStop"), Undefined),
			"fromSeq", definedOr(snap.Get("fromSeq"), Undefined),
			"toSeq", definedOr(snap.Get("toSeq"), Undefined),
			"totalProgress", definedOr(snap.Get("totalProgress"), Undefined),
			"distanceToNextMeters", definedOr(snap.Get("distanceToNextMeters"), Undefined),
		)
		f.vehicles.Set(vID, v)
	}

	hist, _ := v.Get("history").([]any)
	hist = append(hist, O("lat", v.Get("lat"), "lon", v.Get("lon"), "speedKmh", v.Get("speedKmh"), "bearing", v.Get("bearing"), "timestamp", now))
	if len(hist) > f.maxMemoryBreadcrumbs {
		hist = append([]any(nil), hist[1:]...)
	}
	v.Set("history", hist)

	if lineCode != "" {
		f.indexLine(lineCode, vID)
	}

	if f.db != nil && (!truthy(v.Get("lastPersistedAt")) || now-v.Num("lastPersistedAt") >= f.snapshotIntervalMs) {
		f.db.recordVehicleSnapshot(O(
			"vehicleId", v.Get("vehicleId"),
			"lineId", v.Get("lineId"),
			"lineCode", v.Get("lineCode"),
			"agency", v.Get("agency"),
			"lat", v.Get("lat"),
			"lon", v.Get("lon"),
			"speedKmh", v.Get("speedKmh"),
			"bearing", v.Get("bearing"),
			"delayMins", v.Get("delayMins"),
			"isRealTime", v.Get("isRealTime"),
			"status", v.Get("status"),
			"timestamp", now,
		))
		v.Set("lastPersistedAt", now)
	}
}

func (f *FlightRecorder) observedAtOf(v *Obj) float64 {
	if o := jsNumber(v.Get("observedAt")); isFinite(o) {
		return o
	}
	return jsNumber(v.Get("lastSeen"))
}

func (f *FlightRecorder) extrapolateStaleVehicles() {
	now := float64(nowMs())
	for _, vID := range f.vehicles.Keys() {
		vv, ok := f.vehicles.Get(vID)
		if !ok {
			continue
		}
		v := vv.(*Obj)
		obs := f.observedAtOf(v)
		age := math.Inf(1)
		if isFinite(obs) {
			age = now - obs
		}
		if age > f.maxExtrapolationMs {
			f.vehicles.Delete(vID)
			lc := v.Get("lineCode")
			if truthy(lc) {
				if sv, ok := f.lineIndex.Get(jsString(lc)); ok {
					sv.(*JSMap).Delete(vID)
				}
			}
			continue
		}
		speed, isNum := v.Get("speedKmh").(float64)
		b := v.Get("bearing")
		canProject := isNum && isFinite(speed) && speed > 5 && !isNullish(b)
		if age > 15000 && canProject {
			projected := jsNumber(or(v.Get("extrapolatedMs"), 0.0))
			if projected >= f.maxExtrapolationMs {
				continue
			}
			v.Set("status", "extrapolated")
			v.Set("isEstimated", true)
			v.Set("isRealTime", false)
			const stepMs = 5000.0
			stepCap := f.maxExtrapolationMs - projected
			v.Set("extrapolatedMs", math.Min(f.maxExtrapolationMs, projected+stepMs))
			speedMps := speed * 1000 / 3600
			dist := speedMps * (math.Min(stepMs, stepCap) / 1000)
			rad := jsNumber(b) * math.Pi / 180
			lat := jsNumber(v.Get("lat"))
			dLat := dist * jsCos(rad) / 111320
			dLon := dist * jsSin(rad) / (111320 * jsCos(lat*math.Pi/180))
			v.Set("lat", lat+dLat)
			v.Set("lon", jsNumber(v.Get("lon"))+dLon)
		}
	}
}

func (f *FlightRecorder) isServiceable(v *Obj) bool {
	if v == nil {
		return false
	}
	obs := f.observedAtOf(v)
	if !isFinite(obs) {
		return false
	}
	return float64(nowMs())-obs <= math.Min(f.maxExtrapolationMs, f.staleEvictionCeilingMs)
}

func (f *FlightRecorder) getLineVehicles(lineCode string) []any {
	if lineCode == "" {
		return []any{}
	}
	sv, ok := f.lineIndex.Get(jsTrim(strings.ToUpper(lineCode)))
	if !ok || sv.(*JSMap).Len() == 0 {
		return []any{}
	}
	out := []any{}
	for _, id := range sv.(*JSMap).Keys() {
		if vv, ok := f.vehicles.Get(id); ok && f.isServiceable(vv.(*Obj)) {
			out = append(out, vv)
		}
	}
	return out
}

func (f *FlightRecorder) getAllVehicles() []any {
	out := []any{}
	for _, id := range f.vehicles.Keys() {
		vv, _ := f.vehicles.Get(id)
		if f.isServiceable(vv.(*Obj)) {
			out = append(out, vv)
		}
	}
	return out
}

func (f *FlightRecorder) getVehicleTrail(vehicleID any) (any, error) {
	if vv, ok := f.vehicles.Get(jsString(vehicleID)); ok {
		if h, _ := vv.(*Obj).Get("history").([]any); len(h) > 0 {
			return h, nil
		}
	}
	if f.gateway != nil {
		return f.callGateway("getVehicleTrail", O("vehicleId", vehicleID, "minutesBack", 60.0))
	}
	return []any{}, nil
}

func (f *FlightRecorder) getLineStats(lineCode, lineID any) any {
	key := strings.ToUpper(jsString(or(lineCode, ""))) + "|" + jsString(or(lineID, ""))
	now := float64(nowMs())
	if cv, ok := f.statsCache.Get(key); ok {
		c := cv.(*statsEntry)
		if now-c.timestamp < f.statsCacheTtlMs {
			return c.data
		}
	}
	var data any
	if f.gateway != nil {
		res, err := f.callGateway("getLineDelayStats", O("lineCode", lineCode, "hours", 24.0, "lineId", lineID))
		if err != nil {
			log.Printf("[FlightRecorder] getLineDelayStats unavailable (%s) — serving baseline stats.", err.Error())
			data = noLineStats()
		} else {
			data = res
		}
	} else {
		data = noLineStats()
	}
	f.statsCache.Set(key, &statsEntry{data: data, timestamp: now})
	if f.statsCache.Len() > 500 {
		f.statsCache.Delete(f.statsCache.Keys()[0])
	}
	return data
}

var errNoGateway = errString("No history gateway configured")

type errString string

func (e errString) Error() string { return string(e) }

func (f *FlightRecorder) getJournalismReport(hours, catalog any) (any, error) {
	if f.gateway == nil {
		return nil, errNoGateway
	}
	return f.callGateway("getJournalismReport", O("hours", hours, "allLinesCatalog", catalog))
}

func (f *FlightRecorder) exportCsv(hours, page any) (any, error) {
	if f.gateway == nil {
		return nil, errNoGateway
	}
	return f.callGateway("exportDelayLogsCsv", O("hours", hours, "page", page))
}

func (f *FlightRecorder) exportVisitsCsv(hours, page any) (any, error) {
	if f.gateway == nil {
		return nil, errNoGateway
	}
	return f.callGateway("exportStopVisitsCsv", O("hours", hours, "page", page))
}

func (f *FlightRecorder) syncFleetFromWorker(vehicles any) {
	list, ok := vehicles.([]any)
	if !ok {
		return
	}
	newMap := newJSMap()
	newIndex := newJSMap()
	now := float64(nowMs())
	for _, x := range list {
		v, _ := x.(*Obj)
		if v == nil || !truthy(v.Get("vehicleId")) {
			continue
		}
		vID := jsString(v.Get("vehicleId"))
		lineCode := strings.ToUpper(jsString(or(v.Get("lineCode"), "")))
		var existing *Obj
		if ev, ok := f.vehicles.Get(vID); ok {
			existing = ev.(*Obj)
		}
		fromExisting := func(k string) any {
			if !v.IsUndef(k) {
				return v.Get(k)
			}
			if existing != nil {
				return existing.Get(k)
			}
			return Undefined
		}
		var history any = []any{}
		if h, ok := v.Get("history").([]any); ok && len(h) > 0 {
			history = h
		} else if existing != nil {
			history = existing.Get("history")
		}
		var dir any = Undefined
		if !v.IsUndef("direction") {
			dir = jsString(v.Get("direction"))
		} else if existing != nil {
			dir = existing.Get("direction")
		}
		hasSpeed := any(isFinite(jsNumber(v.Get("speedKmh"))))
		if !v.IsUndef("hasSpeed") {
			hasSpeed = truthy(v.Get("hasSpeed"))
		}
		hasDelay := any(isFinite(jsNumber(v.Get("delayMins"))))
		if !v.IsUndef("hasDelay") {
			hasDelay = truthy(v.Get("hasDelay"))
		}
		var serviceable any = Undefined
		if s := jsNumber(v.Get("serviceableMs")); s > 0 {
			serviceable = s
		}
		lastSeen := or(v.Get("lastSeen"), now)
		var observedAt any = lastSeen
		if o := jsNumber(v.Get("observedAt")); isFinite(o) {
			observedAt = o
		}
		var extrap any = v.Get("extrapolatedMs")
		if !truthy(extrap) {
			if existing != nil {
				extrap = existing.Get("extrapolatedMs")
			} else {
				extrap = 0.0
			}
		}
		offRouteM := any(nil)
		if truthy(v.Get("offRoute")) {
			offRouteM = v.Get("offRouteM")
		}
		state := O(
			"vehicleId", vID,
			"lineId", or(v.Get("lineId"), ""),
			"lineCode", lineCode,
			"direction", dir,
			"agency", or(v.Get("agency"), "Transit"),
			"plateNumber", or(v.Get("plateNumber"), ""),
			"lat", jsNumber(v.Get("lat")),
			"lon", jsNumber(v.Get("lon")),
			"speedKmh", finiteNumOrNull(v.Get("speedKmh")),
			"hasSpeed", hasSpeed,
			"bearing", jsNumber(or(v.Get("bearing"), 0.0)),
			"delayMins", finiteNumOrNull(v.Get("delayMins")),
			"hasDelay", hasDelay,
			"destination", or(v.Get("destination"), ""),
			"isRealTime", v.Get("isRealTime") != false,
			"isEstimated", truthy(v.Get("isEstimated")) || truthy(v.Get("isDeadReckoned")),
			"serviceableMs", serviceable,
			"status", or(v.Get("status"), "active"),
			"lastSeen", lastSeen,
			"observedAt", observedAt,
			"lastPersistedAt", or(v.Get("lastPersistedAt"), 0.0),
			"extrapolatedMs", extrap,
			"history", history,
			"isTerminalLayover", truthy(v.Get("isTerminalLayover")),
			"offRoute", truthy(v.Get("offRoute")),
			"offRouteM", offRouteM,
			"fromStop", fromExisting("fromStop"),
			"toStop", fromExisting("toStop"),
			"fromSeq", fromExisting("fromSeq"),
			"toSeq", fromExisting("toSeq"),
			"totalProgress", fromExisting("totalProgress"),
			"distanceToNextMeters", fromExisting("distanceToNextMeters"),
		)
		newMap.Set(vID, state)
		if lineCode != "" {
			sv, ok := newIndex.Get(lineCode)
			if !ok {
				sv = newJSMap()
				newIndex.Set(lineCode, sv)
			}
			sv.(*JSMap).Set(vID, true)
		}
	}
	f.vehicles = newMap
	f.lineIndex = newIndex
}

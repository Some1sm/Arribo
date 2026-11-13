package main

// Port of src/historyDb.js: the phantom-stretch finders (trip relinks,
// deadhead returns, delay jumps, backward legs), their descriptions, and
// _serviceFilter / _setRelinkWindows.

import (
	"math"
	"sort"
)

type lineScope struct {
	since, until float64
	lineWhereSQL string
	lineParams   []any
}

func (s lineScope) args(extra ...any) []any {
	out := []any{s.since, s.until}
	out = append(out, s.lineParams...)
	return append(out, extra...)
}

// hhmm is timeEngine.formatTimeToTimezone(v, 'Europe/Madrid').
func hhmm(v any) string {
	if !truthy(v) {
		return "--:--"
	}
	d := newDate(v)
	return formatTimeToTimezone(d.ms(), d.Valid())
}

const samplesByVehicleSQL = `
      SELECT vehicle_id AS vehicleId, line_code AS lineCode, direction, delay_mins AS delayMins, timestamp, stop_name AS stopName
      FROM delay_logs
      WHERE vehicle_id = ? AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC
      LIMIT 3000
    `

func (h *HistoryDB) findTripRelinksDB(sc lineScope, candidates []*Obj) ([]*Obj, error) {
	drops := candidates
	if drops == nil {
		var err error
		drops, err = h.all(`
      SELECT vehicleId, timestamp FROM (
        SELECT vehicle_id AS vehicleId, UPPER(line_code) AS lineCode, direction, timestamp, delay_mins AS delayMins,
          LAG(delay_mins) OVER w AS prevDelay,
          LAG(timestamp) OVER w AS prevTs,
          LAG(UPPER(line_code)) OVER w AS prevLine,
          LAG(direction) OVER w AS prevDirection
        FROM delay_logs
        WHERE vehicle_id <> '' AND timestamp >= ? AND timestamp <= ?`+sc.lineWhereSQL+`
        WINDOW w AS (PARTITION BY vehicle_id ORDER BY timestamp)
      )
      WHERE prevDelay - delayMins >= ? AND timestamp - prevTs <= ?
        AND lineCode = prevLine AND direction <> '' AND direction = prevDirection
      ORDER BY vehicleId, timestamp
    `, sc.args(relinkDropMins, relinkWindowMs)...)
		if err != nil {
			return nil, err
		}
	}
	relinks := []*Obj{}
	if len(drops) == 0 {
		return relinks, nil
	}
	stopIndex := scheduleStopIndex()
	for _, d := range drops {
		ts := jsNumber(d.Get("timestamp"))
		rows, err := h.all(samplesByVehicleSQL, d.Get("vehicleId"), ts-3*3600*1000, d.Get("timestamp"))
		if err != nil {
			return nil, err
		}
		for _, r := range findTripRelinks(rows, stopIndex) {
			if strictEq(r.Get("relinkTs"), d.Get("timestamp")) {
				relinks = append(relinks, r)
				break
			}
		}
	}
	return relinks, nil
}

func (h *HistoryDB) findDeadheadReturnsDB(sc lineScope, candidates []*Obj) ([]*Obj, error) {
	changes := candidates
	if changes == nil {
		var err error
		changes, err = h.all(`
      SELECT vehicleId, lineCode, direction, timestamp FROM (
        SELECT vehicle_id AS vehicleId, UPPER(line_code) AS lineCode, direction, timestamp,
          LAG(direction) OVER w AS prevDirection,
          LAG(UPPER(line_code)) OVER w AS prevLine
        FROM delay_logs
        WHERE vehicle_id <> '' AND timestamp >= ? AND timestamp <= ?`+sc.lineWhereSQL+`
        WINDOW w AS (PARTITION BY vehicle_id ORDER BY timestamp)
      )
      WHERE direction <> '' AND prevDirection <> '' AND direction <> prevDirection AND lineCode = prevLine
      ORDER BY vehicleId, timestamp
    `, sc.args()...)
		if err != nil {
			return nil, err
		}
	}
	if len(changes) < 2 {
		return []*Obj{}, nil
	}
	stopIndex := scheduleStopIndex()
	found := newJSMap()
	for i := 1; i < len(changes); i++ {
		out, back := changes[i-1], changes[i]
		if !strictEq(out.Get("vehicleId"), back.Get("vehicleId")) || !strictEq(out.Get("lineCode"), back.Get("lineCode")) {
			continue
		}
		tm := scheduleTripMinutes(jsString(out.Get("lineCode")), jsString(out.Get("direction")))
		if !truthy(tm) || jsNumber(back.Get("timestamp"))-jsNumber(out.Get("timestamp")) >= dhSpeedFactor*jsNumber(tm)*60000 {
			continue
		}
		outTs := jsNumber(out.Get("timestamp"))
		rows, err := h.all(`
      SELECT vehicle_id AS vehicleId, line_code AS lineCode, direction, delay_mins AS delayMins, timestamp,
        stop_name AS stopName, scheduled_time AS scheduledTime
      FROM delay_logs
      WHERE vehicle_id = ? AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC
      LIMIT 3000
    `, out.Get("vehicleId"), outTs-3*3600*1000, jsNumber(back.Get("timestamp"))+45*60*1000)
		if err != nil {
			return nil, err
		}
		for _, d := range findDeadheadReturns(rows, stopIndex, scheduleTripMinutes) {
			if jsNumber(d.Get("phantomFromTs")) <= outTs && jsNumber(d.Get("phantomToTs")) >= outTs {
				found.Set(jsString(d.Get("vehicleId"))+"|"+jsString(d.Get("resumeTs")), d)
			}
		}
	}
	res := []*Obj{}
	for _, k := range found.Keys() {
		v, _ := found.Get(k)
		res = append(res, v.(*Obj))
	}
	return res, nil
}

func (h *HistoryDB) describeBackwardLeg(b *Obj) *Obj {
	return O(
		"vehicleId", b.Get("vehicleId"),
		"lineCode", b.Get("lineCode"),
		"lastServedStop", b.Get("lastServedStop"),
		"lastServedTime", hhmm(b.Get("lastServedTs")),
		"lastServedDelay", b.Get("lastServedDelay"),
		"lowestStop", b.Get("lowestStop"),
		"stepsBack", b.Get("stepsBack"),
		"fromTime", hhmm(b.Get("staleFromTs")),
		"toTime", hhmm(b.Get("staleToTs")),
		"visitCount", b.Get("visitCount"),
		"staleStops", b.Get("staleStops"),
	)
}

func (h *HistoryDB) describeDeadhead(d *Obj) (*Obj, error) {
	skipped, err := h.skippedTrip(d)
	if err != nil {
		return nil, err
	}
	var skippedFrom any = ""
	if names := directionStopNames(d.Get("lineCode"), d.Get("oppositeDirection")); len(names) > 0 {
		skippedFrom = or(names[0], "")
	}
	phantoms := []any{}
	for _, x := range listOf(d.Get("phantoms")) {
		p := asObj(x)
		phantoms = append(phantoms, O("stopName", p.Get("stopName"), "delayMins", p.Get("delayMins"), "time", hhmm(p.Get("firstTs"))))
	}
	var departure, gap any = "", nil
	if skipped != nil {
		departure = skipped.Get("departure")
		gap = skipped.Get("gap")
	}
	return O(
		"vehicleId", d.Get("vehicleId"),
		"lineCode", d.Get("lineCode"),
		"lastServedStop", d.Get("lastServedStop"),
		"lastServedTime", hhmm(d.Get("lastServedTs")),
		"lastServedDelay", d.Get("lastServedDelay"),
		"resumeStop", d.Get("resumeStop"),
		"resumeTime", hhmm(d.Get("resumeTs")),
		"returnMinutes", d.Get("returnMinutes"),
		"oppositeTripMinutes", d.Get("oppositeTripMinutes"),
		"towards", directionTerminus(d.Get("lineCode"), d.Get("direction")),
		"skippedFrom", skippedFrom,
		"skippedTo", directionTerminus(d.Get("lineCode"), d.Get("oppositeDirection")),
		"skippedDeparture", departure,
		"phantoms", phantoms,
		"unservedGap", gap,
	), nil
}

func daySecJS(sec float64) float64 { return math.Mod(math.Mod(sec, 86400)+86400, 86400) }

func (h *HistoryDB) skippedTrip(d *Obj) (*Obj, error) {
	closed, _ := d.Get("closedTrip").(*Obj)
	if closed == nil || !truthy(closed.Get("scheduledTime")) {
		return nil, nil
	}
	target := timeStringToSeconds(jsString(closed.Get("scheduledTime")))
	if !isFinite(target) {
		return nil, nil
	}
	cts := jsNumber(closed.Get("timestamp"))
	dt := resolveDayType(int64(cts))
	ds := getDirectionSchedule(lineIDFromCode(d.Get("lineCode")), dirArg(closed.Get("direction")), dt.DayType, "")
	if ds == nil || len(ds.Stops) < 2 || ds.Trips == nil {
		return nil, nil
	}
	wanted := normalizeStopName(strOr(closed.Get("stopName"), ""))
	var at []int
	for i, s := range ds.Stops {
		if normalizeStopName(strOr(s.Raw.Get("name"), "")) == wanted {
			at = append(at, i)
		}
	}
	tripIdx := -1
	for ti, t := range ds.Trips {
		hit := false
		for _, i := range at {
			if i < len(t.S) && isFinite(t.S[i]) && daySecJS(t.S[i]) == target {
				hit = true
				break
			}
		}
		if hit {
			tripIdx = ti
			break
		}
	}
	if tripIdx < 0 {
		return nil, nil
	}
	const probe = 1
	secs := ds.Trips[tripIdx].S
	if len(secs) <= probe || !isFinite(secs[0]) || !isFinite(secs[probe]) {
		return nil, nil
	}
	departure := jsSlice(secondsToTimeString(daySecJS(secs[0])), 0, 5)
	c := dt.C
	dueOn := func(off int) float64 {
		sec := secs[probe]
		s := daySecJS(sec)
		return float64(localTimeToUtcDate(c.Year, c.MonthIndex, c.Day+off+int(math.Floor(sec/86400)),
			int(math.Floor(s/3600)), int(math.Floor(math.Mod(s, 3600)/60)), int(math.Mod(s, 60))))
	}
	due := dueOn(-1)
	if b := dueOn(0); math.Abs(b-cts) < math.Abs(due-cts) {
		due = b
	}
	probeName := normalizeStopName(strOr(ds.Stops[probe].Raw.Get("name"), ""))
	rows, err := h.all(`
      SELECT vehicle_id AS vehicleId, stop_name AS stopName, timestamp
      FROM delay_logs
      WHERE UPPER(line_code) = ? AND direction = ? AND vehicle_id <> '' AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC
    `, jsUpper(jsString(or(d.Get("lineCode"), ""))), jsString(closed.Get("direction")), due-3*3600*1000, due+3*3600*1000)
	if err != nil {
		return nil, err
	}
	pf, pt := jsNumber(d.Get("phantomFromTs")), jsNumber(d.Get("phantomToTs"))
	var passes []float64
	lastByBus := map[string]float64{}
	for _, r := range rows {
		if normalizeStopName(strOr(r.Get("stopName"), "")) != probeName {
			continue
		}
		ts := jsNumber(r.Get("timestamp"))
		if strictEq(r.Get("vehicleId"), d.Get("vehicleId")) && ts >= pf && ts <= pt {
			continue
		}
		vid := jsString(r.Get("vehicleId"))
		prev, ok := lastByBus[vid]
		if !ok || ts-prev > 10*60*1000 {
			passes = append(passes, ts)
		}
		lastByBus[vid] = ts
	}
	sort.Float64s(passes)
	before, after := math.NaN(), math.NaN()
	for _, ts := range passes {
		if ts <= due {
			before = ts
		}
	}
	for _, ts := range passes {
		if ts > due {
			after = ts
			break
		}
	}
	var gap any
	if !math.IsNaN(before) && !math.IsNaN(after) {
		probeAt := func(i int) (float64, bool) {
			if i < 0 || i >= len(ds.Trips) {
				return 0, false
			}
			s := ds.Trips[i].S
			if probe < len(s) && isFinite(s[probe]) {
				return s[probe], true
			}
			return 0, false
		}
		prevDue, hasPrev := probeAt(tripIdx - 1)
		nextDue, hasNext := probeAt(tripIdx + 1)
		var planned any
		switch {
		case hasPrev && hasNext:
			planned = (nextDue - prevDue) / 2
		case hasPrev:
			planned = secs[probe] - prevDue
		case hasNext:
			planned = nextDue - secs[probe]
		}
		var plannedMin any
		if planned != nil {
			plannedMin = jsRound(planned.(float64) / 60)
		}
		gap = O(
			"stopName", strOr(ds.Stops[probe].Raw.Get("name"), ""),
			"fromTime", hhmm(before),
			"toTime", hhmm(after),
			"minutes", jsRound((after-before)/60000),
			"plannedHeadwayMinutes", plannedMin,
		)
	}
	return O("departure", departure, "gap", gap), nil
}

func (h *HistoryDB) findDelayJumpsDB(sc lineScope, candidates []*Obj) ([]*Obj, error) {
	rises := candidates
	if rises == nil {
		var err error
		rises, err = h.all(`
      SELECT vehicleId, prevTs FROM (
        SELECT vehicle_id AS vehicleId, UPPER(line_code) AS lineCode, timestamp, delay_mins AS delayMins,
          LAG(delay_mins) OVER w AS prevDelay,
          LAG(timestamp) OVER w AS prevTs,
          LAG(UPPER(line_code)) OVER w AS prevLine
        FROM delay_logs
        WHERE vehicle_id <> '' AND timestamp >= ? AND timestamp <= ?`+sc.lineWhereSQL+`
        WINDOW w AS (PARTITION BY vehicle_id ORDER BY timestamp)
      )
      WHERE lineCode = prevLine AND prevDelay >= ? AND delayMins - prevDelay >= ?
        AND timestamp - prevTs <= ? AND (delayMins - prevDelay) * 60000 > (timestamp - prevTs) + ?
      ORDER BY vehicleId, timestamp
    `, sc.args(jumpFromMinMins, jumpMinMins, jumpMaxGapMs, jumpSlackMins*60000)...)
		if err != nil {
			return nil, err
		}
	}
	if len(rises) == 0 {
		return []*Obj{}, nil
	}
	found := newJSMap()
	for _, r := range rises {
		pts := jsNumber(r.Get("prevTs"))
		rows, err := h.all(samplesByVehicleSQL, r.Get("vehicleId"), r.Get("prevTs"), math.Min(sc.until, pts+3*3600*1000))
		if err != nil {
			return nil, err
		}
		for _, j := range findDelayJumps(rows) {
			k := jsString(j.Get("vehicleId")) + "|" + jsString(j.Get("jumpTs"))
			if !found.Has(k) {
				found.Set(k, j)
			}
		}
	}
	res := []*Obj{}
	for _, k := range found.Keys() {
		v, _ := found.Get(k)
		res = append(res, v.(*Obj))
	}
	sort.SliceStable(res, func(i, j int) bool {
		if c := localeCompareJS(jsString(res[i].Get("vehicleId")), jsString(res[j].Get("vehicleId")), false); c != 0 {
			return c < 0
		}
		return res[i].Num("jumpTs") < res[j].Num("jumpTs")
	})
	return res, nil
}

type phantomCands struct{ drops, changes, rises []*Obj }

func (h *HistoryDB) phantomCandidates(sc lineScope) (phantomCands, error) {
	rows, err := h.all(`
      SELECT vehicleId, lineCode, direction, timestamp, delayMins, prevTs, prevDelay, prevDirection FROM (
        SELECT vehicle_id AS vehicleId, UPPER(line_code) AS lineCode, direction, timestamp, delay_mins AS delayMins,
          LAG(delay_mins) OVER w AS prevDelay,
          LAG(timestamp) OVER w AS prevTs,
          LAG(UPPER(line_code)) OVER w AS prevLine,
          LAG(direction) OVER w AS prevDirection
        FROM delay_logs
        WHERE vehicle_id <> '' AND timestamp >= ? AND timestamp <= ?`+sc.lineWhereSQL+`
        WINDOW w AS (PARTITION BY vehicle_id ORDER BY timestamp)
      )
      WHERE lineCode = prevLine AND (
        (direction <> '' AND prevDirection <> '' AND direction <> prevDirection)
        OR (prevDelay - delayMins >= ? AND timestamp - prevTs <= ? AND direction <> '' AND direction = prevDirection)
        OR (prevDelay >= ? AND delayMins - prevDelay >= ? AND timestamp - prevTs <= ? AND (delayMins - prevDelay) * 60000 > (timestamp - prevTs) + ?)
      )
      ORDER BY vehicleId, timestamp
    `, sc.args(relinkDropMins, relinkWindowMs, jumpFromMinMins, jumpMinMins, jumpMaxGapMs, jumpSlackMins*60000)...)
	if err != nil {
		return phantomCands{}, err
	}
	dir := func(v any) string {
		if isNullish(v) {
			return ""
		}
		return jsString(v)
	}
	var pc phantomCands
	pc.drops, pc.changes, pc.rises = []*Obj{}, []*Obj{}, []*Obj{}
	for _, r := range rows {
		pd, d := jsNumber(r.Get("prevDelay")), jsNumber(r.Get("delayMins"))
		ts, pts := jsNumber(r.Get("timestamp")), jsNumber(r.Get("prevTs"))
		cd, pdir := dir(r.Get("direction")), dir(r.Get("prevDirection"))
		if pd-d >= relinkDropMins && ts-pts <= relinkWindowMs && cd != "" && cd == pdir {
			pc.drops = append(pc.drops, r)
		}
		if cd != "" && pdir != "" && cd != pdir {
			pc.changes = append(pc.changes, r)
		}
		if pd >= jumpFromMinMins && d-pd >= jumpMinMins && ts-pts <= jumpMaxGapMs && (d-pd)*60000 > (ts-pts)+jumpSlackMins*60000 {
			pc.rises = append(pc.rises, r)
		}
	}
	return pc, nil
}

func (h *HistoryDB) findBackwardLegsDB(sc lineScope) ([]*Obj, error) {
	args := []any{backMinDelayMins, sc.since, sc.until}
	args = append(args, sc.lineParams...)
	rows, err := h.all(`
      SELECT vehicle_id AS vehicleId, line_code AS lineCode, direction, delay_mins AS delayMins, timestamp, stop_name AS stopName
      FROM delay_logs
      WHERE vehicle_id <> '' AND delay_mins >= ? AND timestamp >= ? AND timestamp <= ?`+sc.lineWhereSQL+`
      ORDER BY vehicle_id, timestamp ASC
      LIMIT 200000
    `, args...)
	if err != nil {
		return nil, err
	}
	return findBackwardLegs(rows, scheduleStopIndex()), nil
}

type phantomStretches struct {
	relinks, deadheads, jumps, backs, windows []*Obj
}

func (h *HistoryDB) findPhantomStretches(sc lineScope) (*phantomStretches, error) {
	c, err := h.phantomCandidates(sc)
	if err != nil {
		return nil, err
	}
	p := &phantomStretches{}
	if p.relinks, err = h.findTripRelinksDB(sc, c.drops); err != nil {
		return nil, err
	}
	if p.deadheads, err = h.findDeadheadReturnsDB(sc, c.changes); err != nil {
		return nil, err
	}
	if p.jumps, err = h.findDelayJumpsDB(sc, c.rises); err != nil {
		return nil, err
	}
	if p.backs, err = h.findBackwardLegsDB(sc); err != nil {
		return nil, err
	}
	p.windows = append(p.windows, p.relinks...)
	for _, d := range p.deadheads {
		p.windows = append(p.windows, O("vehicleId", d.Get("vehicleId"), "lineCode", d.Get("lineCode"), "staleFromTs", d.Get("phantomFromTs"), "staleToTs", d.Get("phantomToTs")))
	}
	p.windows = append(p.windows, p.jumps...)
	for _, b := range p.backs {
		p.windows = append(p.windows, O("vehicleId", b.Get("vehicleId"), "lineCode", b.Get("lineCode"), "staleFromTs", b.Get("staleFromTs"), "staleToTs", b.Get("staleToTs")))
	}
	return p, nil
}

type serviceFilterOpts struct {
	since, until float64
	lineCode     any // nil = all lines
	tables       []string
	windowsReady bool
}

type serviceSQL struct{ visits, logs string }

func (h *HistoryDB) serviceFilter(o serviceFilterOpts) (serviceSQL, error) {
	code := ""
	if truthy(o.lineCode) {
		code = jsUpper(jsString(o.lineCode))
	}
	if o.tables == nil {
		o.tables = []string{"visits", "logs"}
	}
	if !o.windowsReady {
		sc := lineScope{since: o.since - 3*3600*1000, until: o.until}
		if code != "" {
			sc.lineWhereSQL, sc.lineParams = " AND UPPER(line_code) = ?", []any{code}
		} else {
			sc.lineWhereSQL, sc.lineParams = mataroScopeSQL, nil
		}
		p, err := h.findPhantomStretches(sc)
		if err != nil {
			return serviceSQL{}, err
		}
		if err := h.setRelinkWindows(p.windows); err != nil {
			return serviceSQL{}, err
		}
	}
	exclude := func(name, table, tsCol, inRelink, scopeSQL string) (string, error) {
		if err := h.exec("CREATE TEMP TABLE IF NOT EXISTS " + name + " (id INTEGER PRIMARY KEY)"); err != nil {
			return "", err
		}
		if err := h.exec("DELETE FROM temp." + name); err != nil {
			return "", err
		}
		filter := scopeSQL
		args := []any{o.since, o.until}
		if code != "" {
			filter = " AND UPPER(line_code) = ?"
			args = append(args, code)
		}
		if _, err := h.run(`
        INSERT INTO temp.`+name+` (id)
        SELECT id FROM `+table+`
        WHERE `+tsCol+` >= ? AND `+tsCol+` <= ?`+filter+`
          AND (`+inRelink+` OR is_telemetry_anomaly(`+tsCol+`, delay_mins, stop_name, line_code) = 1)
      `, args...); err != nil {
			return "", err
		}
		return " AND id NOT IN (SELECT id FROM temp." + name + ")", nil
	}
	var out serviceSQL
	var err error
	for _, t := range o.tables {
		if t == "visits" {
			if out.visits, err = exclude("excluded_visits", "stop_visits", "last_ts", visitInRelinkSQL, mataroVisitsScopeSQL); err != nil {
				return out, err
			}
		}
	}
	for _, t := range o.tables {
		if t == "logs" {
			if out.logs, err = exclude("excluded_logs", "delay_logs", "timestamp", inRelinkSQL, mataroScopeSQL); err != nil {
				return out, err
			}
		}
	}
	return out, nil
}

func (h *HistoryDB) setRelinkWindows(rs []*Obj) error {
	if err := h.exec("CREATE TEMP TABLE IF NOT EXISTS relink_windows (vehicle_id TEXT, line_code TEXT, from_ts INTEGER, to_ts INTEGER)"); err != nil {
		return err
	}
	if err := h.exec("CREATE INDEX IF NOT EXISTS temp.idx_relink_windows_vehicle ON relink_windows (vehicle_id, line_code)"); err != nil {
		return err
	}
	if err := h.exec("DELETE FROM temp.relink_windows"); err != nil {
		return err
	}
	for _, r := range rs {
		if _, err := h.run("INSERT INTO temp.relink_windows (vehicle_id, line_code, from_ts, to_ts) VALUES (?, ?, ?, ?)",
			r.Get("vehicleId"), r.Get("lineCode"), r.Get("staleFromTs"), r.Get("staleToTs")); err != nil {
			return err
		}
	}
	return nil
}

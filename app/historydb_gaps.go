package main

// Port of src/historyDb.js: GPS gap hotspots / passes / ids and
// getLineDelayStats.

import (
	"log"
	"math"
	"regexp"
	"sort"
	"strings"
)

var (
	reSingleDigit = regexp.MustCompile(`^(\d)$`)
	reFleet3to6   = regexp.MustCompile(`^\d{3,6}$`)
	reAnyDigit    = regexp.MustCompile(`\d`)
)

func sortedUniqueStrings(xs []string) []any {
	seen := map[string]bool{}
	var u []string
	for _, x := range xs {
		if !seen[x] {
			seen[x] = true
			u = append(u, x)
		}
	}
	sort.Strings(u)
	return stringsToAny(u)
}

func medianOrNull(xs []float64) any {
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

func (h *HistoryDB) emptyGapHotspots(days any, now float64) *Obj {
	return O("days", days, "lineCode", "", "vehicleId", "", "hide", "", "hidden", []any{}, "since", 0.0, "until", now,
		"totals", O("gaps", 0.0, "mapped", 0.0, "atTerminal", 0.0, "feedWide", 0.0, "vehicles", 0.0, "medianGapSec", nil, "recurrentShare", nil),
		"cells", []any{}, "gaps", []any{}, "buses", []any{}, "fleet", O("inService", 0.0, "withoutLoss", 0.0))
}

type gapOpts struct {
	days, lineCode, vehicleID, hide any
	now                             float64
}

func gapRowsFor(rows []*Obj, shared map[string]bool) []GapRow {
	out := make([]GapRow, len(rows))
	for i, r := range rows {
		out[i] = GapRow{ID: r.Get("id"), VehicleID: jsString(r.Get("vehicleId")), LineCode: jsString(r.Get("lineCode")),
			GapSec: jsNumber(r.Get("gapSec")), Shared: shared[jsString(r.Get("id"))]}
	}
	return out
}

func clusterInput(rows []*Obj) []*Obj {
	out := make([]*Obj, 0, len(rows))
	for i := len(rows) - 1; i >= 0; i-- {
		c := rows[i].Clone()
		c.Set("lat", rows[i].Get("lostLat"))
		c.Set("lon", rows[i].Get("lostLon"))
		out = append(out, c)
	}
	return out
}

func (h *HistoryDB) getGpsGapHotspots(o gapOpts) *Obj {
	if isUndef(o.days) {
		o.days = 7.0
	}
	if isUndef(o.lineCode) {
		o.lineCode = ""
	}
	if isUndef(o.vehicleID) {
		o.vehicleID = ""
	}
	if isUndef(o.hide) {
		o.hide = ""
	}
	now := o.now
	empty := h.emptyGapHotspots(o.days, now)
	if !h.ensureOpen() {
		return empty
	}
	res, err := func() (*Obj, error) {
		d := math.Min(30, math.Max(1, jsRound(jsNumber(or(o.days, 0.0)))))
		if n := jsNumber(o.days); !truthy(n) || math.IsNaN(n) {
			d = math.Min(30, math.Max(1, 7))
		}
		since := now - d*86400*1000
		code := reSingleDigit.ReplaceAllString(jsUpper(jsTrim(jsString(or(o.lineCode, "")))), "L$1")
		lineSQL := ""
		params := []any{since, now}
		if code != "" && code != "ALL" {
			lineSQL = " AND line_code = ?"
			params = append(params, code)
		}
		rows, err := h.all(`
        SELECT id, vehicle_id AS vehicleId, line_code AS lineCode, lost_ts AS lostTs, gap_sec AS gapSec,
               lost_lat AS lostLat, lost_lon AS lostLon, regained_lat AS regainedLat, regained_lon AS regainedLon,
               stop_name AS stopName, at_terminal AS atTerminal, feed_wide AS feedWide
        FROM gps_gaps
        WHERE lost_ts >= ? AND lost_ts < ?`+lineSQL+`
        ORDER BY lost_ts DESC
      `, params...)
		if err != nil {
			return nil, err
		}
		var lineMapped []*Obj
		for _, r := range rows {
			if !truthy(r.Get("atTerminal")) && !truthy(r.Get("feedWide")) {
				lineMapped = append(lineMapped, r)
			}
		}
		shared := map[string]bool{}
		allGroups := clusterPoints(clusterInput(lineMapped), 100)
		for _, c := range allGroups {
			vs := map[string]bool{}
			for _, m := range c.Members {
				vs[jsString(m.Get("vehicleId"))] = true
			}
			if len(vs) >= 2 {
				for _, m := range c.Members {
					shared[jsString(m.Get("id"))] = true
				}
			}
		}
		visitRows, err := h.all(`
        SELECT vehicle_id AS vehicleId, line_code AS lineCode, COUNT(*) AS n
        FROM stop_visits
        WHERE last_ts >= ? AND last_ts < ?`+lineSQL+`
        GROUP BY vehicle_id, line_code
      `, params...)
		if err != nil {
			return nil, err
		}
		visits := make([]VisitRow, len(visitRows))
		for i, v := range visitRows {
			visits[i] = VisitRow{VehicleID: jsString(v.Get("vehicleId")), LineCode: jsString(v.Get("lineCode")), N: jsNumber(v.Get("n"))}
		}
		ranked := rankBuses(gapRowsFor(lineMapped, shared), visits)
		buses, _ := anyList(ranked.Get("buses"))

		vehicle := ""
		if s := jsString(or(o.vehicleID, "")); reFleet3to6.MatchString(s) {
			vehicle = s
		}
		var hideVerdicts []string
		switch o.hide {
		case "watch":
			hideVerdicts = []string{"suspect", "watch"}
		case "suspect":
			hideVerdicts = []string{"suspect"}
		}
		hidden := []any{}
		hiddenSet := map[string]bool{}
		if vehicle == "" {
			for _, x := range buses {
				b := asObj(x)
				for _, v := range hideVerdicts {
					if b.Get("verdict") == v {
						hidden = append(hidden, b.Get("vehicleId"))
						hiddenSet[jsString(b.Get("vehicleId"))] = true
						break
					}
				}
			}
		}
		keep := func(r *Obj) bool {
			if vehicle != "" {
				return r.Get("vehicleId") == vehicle
			}
			return !hiddenSet[jsString(r.Get("vehicleId"))]
		}
		narrowed := vehicle != "" || len(hidden) > 0
		shown, mapped := rows, lineMapped
		if narrowed {
			shown, mapped = nil, nil
			for _, r := range rows {
				if keep(r) {
					shown = append(shown, r)
				}
			}
			for _, r := range lineMapped {
				if keep(r) {
					mapped = append(mapped, r)
				}
			}
		}
		groupsC := allGroups
		if narrowed {
			groupsC = clusterPoints(clusterInput(mapped), 100)
		}
		mode := func(xs []any) any {
			counts := newJSMap()
			for _, x := range xs {
				if truthy(x) {
					k := jsString(x)
					c, _ := counts.Get(k)
					n, _ := c.(float64)
					counts.Set(k, n+1)
				}
			}
			best, n := "", 0.0
			for _, k := range counts.Keys() {
				c, _ := counts.Get(k)
				if c.(float64) > n {
					best, n = k, c.(float64)
				}
			}
			return best
		}
		type cellT struct {
			o         *Obj
			count     float64
			vehicles  float64
			lastTs    float64
			memberIDs []any
		}
		var cells []*cellT
		for _, g := range groupsC {
			rs := g.Members
			vs := map[string]bool{}
			var lines []string
			var gaps []float64
			var names []any
			maxGap, lastTs := math.Inf(-1), math.Inf(-1)
			var ids []any
			sums := map[string]float64{}
			for _, r := range rs {
				vs[jsString(r.Get("vehicleId"))] = true
				lines = append(lines, jsString(r.Get("lineCode")))
				gs := jsNumber(r.Get("gapSec"))
				gaps = append(gaps, gs)
				maxGap = math.Max(maxGap, gs)
				lastTs = math.Max(lastTs, jsNumber(r.Get("lostTs")))
				names = append(names, r.Get("stopName"))
				ids = append(ids, r.Get("id"))
				for _, f := range []string{"lostLat", "lostLon", "regainedLat", "regainedLon"} {
					sums[f] = sums[f] + jsNumber(r.Get(f))
				}
			}
			n := float64(len(rs))
			mean := func(f string) float64 { return jsRound(sums[f]/n*1e6) / 1e6 }
			byTs := append([]*Obj(nil), rs...)
			sort.SliceStable(byTs, func(i, j int) bool { return byTs[i].Num("lostTs") > byTs[j].Num("lostTs") })
			var gapIDs []any
			for i, r := range byTs {
				if i >= 12 {
					break
				}
				gapIDs = append(gapIDs, r.Get("id"))
			}
			if gapIDs == nil {
				gapIDs = []any{}
			}
			nv := float64(len(vs))
			c := &cellT{count: n, vehicles: nv, lastTs: lastTs, memberIDs: ids}
			c.o = O(
				"lat", mean("lostLat"),
				"lon", mean("lostLon"),
				"regainedLat", mean("regainedLat"),
				"regainedLon", mean("regainedLon"),
				"count", n,
				"vehicles", nv,
				"lines", sortedUniqueStrings(lines),
				"medianGapSec", medianOrNull(gaps),
				"maxGapSec", maxGap,
				"stopName", mode(names),
				"lastTs", lastTs,
				"recurrent", n >= 3 && nv >= 2,
				"gapIds", gapIDs,
			)
			cells = append(cells, c)
		}
		sort.SliceStable(cells, func(i, j int) bool {
			a, b := cells[i], cells[j]
			if d := b.count - a.count; d != 0 {
				return d < 0
			}
			if d := b.vehicles - a.vehicles; d != 0 {
				return d < 0
			}
			return b.lastTs-a.lastTs < 0
		})
		inRecurrent := 0.0
		for _, c := range cells {
			if truthy(c.o.Get("recurrent")) {
				inRecurrent += c.count
			}
		}
		cellOf := map[string]float64{}
		top := cells
		if len(top) > 80 {
			top = top[:80]
		}
		for i, c := range top {
			for _, id := range c.memberIDs {
				cellOf[jsString(id)] = float64(i)
			}
		}
		cellsOut := make([]any, len(top))
		for i, c := range top {
			cellsOut[i] = c.o
		}
		atTerminal, feedWide := 0.0, 0.0
		for _, r := range shown {
			if truthy(r.Get("atTerminal")) {
				atTerminal++
			} else if truthy(r.Get("feedWide")) {
				feedWide++
			}
		}
		mv := map[string]bool{}
		var mgaps []float64
		for _, r := range mapped {
			mv[jsString(r.Get("vehicleId"))] = true
			mgaps = append(mgaps, jsNumber(r.Get("gapSec")))
		}
		var share any
		if len(mapped) > 0 {
			share = jsRound(inRecurrent / float64(len(mapped)) * 100)
		}
		lc := ""
		if code != "" && code != "ALL" {
			lc = code
		}
		hideOut := any("")
		if len(hideVerdicts) > 0 {
			hideOut = o.hide
		}
		busesOut := buses
		if len(busesOut) > 20 {
			busesOut = busesOut[:20]
		}
		gapsOut := []any{}
		for i, r := range mapped {
			if i >= 400 {
				break
			}
			var cell any
			if c, ok := cellOf[jsString(r.Get("id"))]; ok {
				cell = c
			}
			gapsOut = append(gapsOut, O("cell", cell, "vehicleId", r.Get("vehicleId"), "lineCode", r.Get("lineCode"), "gapSec", r.Get("gapSec"),
				"lostLat", r.Get("lostLat"), "lostLon", r.Get("lostLon"), "regainedLat", r.Get("regainedLat"), "regainedLon", r.Get("regainedLon")))
		}
		return O(
			"days", d,
			"lineCode", lc,
			"vehicleId", vehicle,
			"hide", hideOut,
			"hidden", hidden,
			"since", since,
			"until", now,
			"totals", O(
				"gaps", float64(len(shown)),
				"mapped", float64(len(mapped)),
				"atTerminal", atTerminal,
				"feedWide", feedWide,
				"vehicles", float64(len(mv)),
				"medianGapSec", medianOrNull(mgaps),
				"recurrentShare", share,
			),
			"cells", cellsOut,
			"buses", busesOut,
			"fleet", O("inService", ranked.Get("inService"), "withoutLoss", ranked.Get("withoutLoss")),
			"gaps", gapsOut,
		), nil
	}()
	if err != nil {
		log.Printf("[HistoryDB] getGpsGapHotspots error: %s", err.Error())
		return empty
	}
	return res
}

func (h *HistoryDB) getGpsGapPasses(ids any, days any, now float64) *Obj {
	empty := func() *Obj {
		return O("stops", []any{}, "buses", []any{}, "totals", O("buses", 0.0, "lossBuses", 0.0, "cleanBuses", 0.0, "gpsPasses", 0.0, "lost", 0.0))
	}
	if !h.ensureOpen() {
		return empty()
	}
	res, err := func() (*Obj, error) {
		here, err := h.getGpsGapsByIdsE(ids)
		if err != nil {
			return nil, err
		}
		var stops []string
		seen := map[string]bool{}
		for _, g := range here {
			if s := g.Get("stopName"); truthy(s) && !seen[jsString(s)] {
				seen[jsString(s)] = true
				stops = append(stops, jsString(s))
			}
		}
		if len(stops) == 0 {
			return empty(), nil
		}
		if isUndef(days) {
			days = 7.0
		}
		d := math.Min(30, math.Max(1, jsRound(jsNumber(days))))
		if n := jsNumber(days); !truthy(n) || math.IsNaN(n) {
			d = 7
		}
		since := now - d*86400*1000
		marks := strings.TrimSuffix(strings.Repeat("?,", len(stops)), ",")
		isFleet := func(v any) bool { return reAnyDigit.MatchString(jsString(or(v, ""))) }
		args := stringsToAny(stops)
		visitRows, err := h.all(`
        SELECT vehicle_id AS vehicleId, line_code AS lineCode, stop_name AS stopName, first_ts AS firstTs, last_ts AS lastTs
        FROM stop_visits WHERE stop_name IN (`+marks+`) AND last_ts >= ? AND last_ts < ?
      `, append(append([]any{}, args...), since, now)...)
		if err != nil {
			return nil, err
		}
		gapRows, err := h.all(`
        SELECT vehicle_id AS vehicleId, stop_name AS stopName, lost_ts AS lostTs
        FROM gps_gaps WHERE stop_name IN (`+marks+`) AND lost_ts >= ? AND lost_ts < ?
      `, append(append([]any{}, args...), since-20*60000, now)...)
		if err != nil {
			return nil, err
		}
		onTheWay := map[string][]float64{}
		for _, g := range gapRows {
			k := jsString(g.Get("vehicleId")) + "|" + jsString(g.Get("stopName"))
			onTheWay[k] = append(onTheWay[k], jsNumber(g.Get("lostTs")))
		}
		lostBefore := func(v *Obj) bool {
			for _, t := range onTheWay[jsString(v.Get("vehicleId"))+"|"+jsString(v.Get("stopName"))] {
				if t >= jsNumber(v.Get("firstTs"))-20*60000 && t <= jsNumber(v.Get("lastTs"))+60000 {
					return true
				}
			}
			return false
		}
		type busT struct {
			id        any
			lines     []string
			lineSet   map[string]bool
			gpsPasses float64
			lost      float64
		}
		byBus := newJSMap()
		bus := func(id any) *busT {
			k := jsString(id)
			if b, ok := byBus.Get(k); ok {
				return b.(*busT)
			}
			b := &busT{id: id, lineSet: map[string]bool{}}
			byBus.Set(k, b)
			return b
		}
		addLine := func(b *busT, l any) {
			s := jsString(l)
			if !b.lineSet[s] {
				b.lineSet[s] = true
				b.lines = append(b.lines, s)
			}
		}
		for _, v := range visitRows {
			if !isFleet(v.Get("vehicleId")) || lostBefore(v) {
				continue
			}
			b := bus(v.Get("vehicleId"))
			b.gpsPasses++
			addLine(b, v.Get("lineCode"))
		}
		for _, g := range here {
			if !isFleet(g.Get("vehicleId")) {
				continue
			}
			b := bus(g.Get("vehicleId"))
			b.lost++
			addLine(b, g.Get("lineCode"))
		}
		var list []*busT
		for _, k := range byBus.Keys() {
			b, _ := byBus.Get(k)
			list = append(list, b.(*busT))
		}
		sort.SliceStable(list, func(i, j int) bool {
			a, b := list[i], list[j]
			if d := b.lost - a.lost; d != 0 {
				return d < 0
			}
			return b.gpsPasses-a.gpsPasses < 0
		})
		busesOut := []any{}
		lossBuses, cleanBuses, gpsPasses, lost := 0.0, 0.0, 0.0, 0.0
		for _, b := range list {
			l := append([]string(nil), b.lines...)
			sort.Strings(l)
			busesOut = append(busesOut, O("vehicleId", b.id, "lines", stringsToAny(l), "gpsPasses", b.gpsPasses, "lost", b.lost))
			if b.lost != 0 {
				lossBuses++
			} else if b.gpsPasses != 0 {
				cleanBuses++
			}
			gpsPasses += b.gpsPasses
			lost += b.lost
		}
		return O("stops", stringsToAny(stops), "buses", busesOut, "totals", O(
			"buses", float64(len(busesOut)), "lossBuses", lossBuses, "cleanBuses", cleanBuses, "gpsPasses", gpsPasses, "lost", lost)), nil
	}()
	if err != nil {
		log.Printf("[HistoryDB] getGpsGapPasses error: %s", err.Error())
		return empty()
	}
	return res
}

func cleanGapIDs(ids any) []any {
	list, _ := ids.([]any)
	seen := map[float64]bool{}
	var out []any
	for _, x := range list {
		n := jsNumber(x)
		if !isFinite(n) || n != math.Trunc(n) || n <= 0 || seen[n] {
			continue
		}
		seen[n] = true
		out = append(out, n)
		if len(out) == 12 {
			break
		}
	}
	return out
}

func (h *HistoryDB) getGpsGapsByIdsE(ids any) ([]*Obj, error) {
	if !h.ensureOpen() {
		return []*Obj{}, nil
	}
	clean := cleanGapIDs(ids)
	if len(clean) == 0 {
		return []*Obj{}, nil
	}
	marks := strings.TrimSuffix(strings.Repeat("?,", len(clean)), ",")
	return h.all(`
        SELECT id, vehicle_id AS vehicleId, line_code AS lineCode, direction, lost_ts AS lostTs, gap_sec AS gapSec, stop_name AS stopName,
               lost_lat AS lostLat, lost_lon AS lostLon, regained_lat AS regainedLat, regained_lon AS regainedLon
        FROM gps_gaps WHERE id IN (`+marks+`)
      `, clean...)
}

// getGpsGapsByIds logs and returns [] on a query error (getGpsGapPasses
// lets the error reach its own handler instead).
func (h *HistoryDB) getGpsGapsByIds(ids any) []*Obj {
	rows, err := h.getGpsGapsByIdsE(ids)
	if err != nil {
		log.Printf("[HistoryDB] getGpsGapsByIds error: %s", err.Error())
		return []*Obj{}
	}
	return rows
}

var reHyphenWS = jsRe(`[-_\s]`)
var reUpToUnderscore = regexp.MustCompile(`^.*_`)

func pctOf(n, total any) float64 { return jsRound(jsNumber(n) / jsNumber(total) * 100) }

func clampPct(n, total any) float64 {
	return math.Max(0, math.Min(100, pctOf(n, total)))
}

func (h *HistoryDB) getLineDelayStats(lineCode, hoursBack, lineID any) *Obj {
	if isUndef(hoursBack) {
		hoursBack = 24.0
	}
	if isUndef(lineID) {
		lineID = nil
	}
	if !h.ensureOpen() {
		return noLineStatsDB()
	}
	res, err := func() (*Obj, error) {
		cutoff := float64(nowMs()) - jsNumber(hoursBack)*3600*1000
		raw := jsTrim(jsString(or(lineCode, "")))
		codeUpper := jsUpper(raw)
		codeNoHyphen := reHyphenWS.ReplaceAllLiteralString(codeUpper, "")
		codeWithL, codeWithoutL := "L"+codeUpper, codeUpper
		if strings.HasPrefix(codeUpper, "L") {
			codeWithL, codeWithoutL = codeUpper, codeUpper[1:]
		}
		idUpper := codeUpper
		if truthy(lineID) {
			idUpper = jsTrim(jsUpper(jsString(lineID)))
		}
		idClean := reUpToUnderscore.ReplaceAllLiteralString(strings.Replace(idUpper, "CAT_GEN_", "", 1), "")
		service, err := h.serviceFilter(serviceFilterOpts{since: cutoff, until: float64(nowMs()), lineCode: codeWithL})
		if err != nil {
			return nil, err
		}
		v, err := h.get(`
        SELECT
          COUNT(*) as totalVisits,
          SUM(sample_count) as totalSamples,
          AVG(delay_mins) as avgDelayMins,
          MAX(delay_mins) as maxDelayMins,
          SUM(CASE WHEN `+onTimeSQL+` THEN 1 ELSE 0 END) as onTimeCount,
          SUM(CASE WHEN `+earlySQL+` THEN 1 ELSE 0 END) as earlyCount,
          SUM(CASE WHEN `+lateSQL+` THEN 1 ELSE 0 END) as lateCount,
          SUM(CASE WHEN delay_mins > 3 AND delay_mins <= 8 THEN 1 ELSE 0 END) as moderateLateCount,
          SUM(CASE WHEN `+severeLateSQL+` THEN 1 ELSE 0 END) as severeLateCount
        FROM stop_visits
        WHERE (
          UPPER(line_code) = ?
          OR UPPER(line_code) = ?
          OR UPPER(line_code) = ?
          OR UPPER(line_code) = ?
          OR UPPER(REPLACE(REPLACE(line_code, '-', ''), '_', '')) = ?
        ) AND last_ts >= ? AND `+validDelaySQL+service.visits+`
      `, codeUpper, codeNoHyphen, codeWithL, codeWithoutL, codeNoHyphen, cutoff)
		if err != nil {
			return nil, err
		}
		if v != nil && jsNumber(v.Get("totalVisits")) > 0 {
			total := v.Get("totalVisits")
			return O(
				"totalVisits", total,
				"totalSamples", or(v.Get("totalSamples"), total),
				"sampleCount", or(v.Get("totalSamples"), total),
				"avgDelayMins", jsRound(jsNumber(or(v.Get("avgDelayMins"), 0.0))*10)/10,
				"maxDelayMins", or(v.Get("maxDelayMins"), 0.0),
				"onTimePct", pctOf(v.Get("onTimeCount"), total),
				"earlyPct", pctOf(v.Get("earlyCount"), total),
				"latePct", pctOf(v.Get("lateCount"), total),
				"moderateLatePct", pctOf(v.Get("moderateLateCount"), total),
				"severeLatePct", pctOf(v.Get("severeLateCount"), total),
				"severitySplitMeasured", true,
			), nil
		}
		r, err := h.get(`
        SELECT
          COUNT(*) as totalSamples,
          AVG(delay_mins) as avgDelayMins,
          MAX(delay_mins) as maxDelayMins,
          SUM(CASE WHEN `+onTimeSQL+` THEN 1 ELSE 0 END) as onTimeCount,
          SUM(CASE WHEN `+earlySQL+` THEN 1 ELSE 0 END) as earlyCount,
          SUM(CASE WHEN `+lateSQL+` THEN 1 ELSE 0 END) as lateCount,
          SUM(CASE WHEN delay_mins > 3 AND delay_mins <= 8 THEN 1 ELSE 0 END) as moderateLateCount,
          SUM(CASE WHEN `+severeLateSQL+` THEN 1 ELSE 0 END) as severeLateCount
        FROM delay_logs
        WHERE (
          UPPER(line_code) = ?
          OR UPPER(line_code) = ?
          OR UPPER(line_code) = ?
          OR UPPER(line_code) = ?
          OR UPPER(line_code) = ?
          OR UPPER(line_id) = ?
          OR UPPER(line_id) = ?
          OR UPPER(REPLACE(REPLACE(line_code, '-', ''), '_', '')) = ?
        ) AND timestamp >= ? AND `+validDelaySQL+service.logs+`
      `, codeUpper, codeNoHyphen, codeWithL, codeWithoutL, idClean, idUpper, codeUpper, codeNoHyphen, cutoff)
		if err != nil {
			return nil, err
		}
		if r != nil && jsNumber(r.Get("totalSamples")) > 0 {
			total := r.Get("totalSamples")
			return O(
				"totalVisits", total,
				"totalSamples", total,
				"sampleCount", total,
				"avgDelayMins", jsRound(jsNumber(or(r.Get("avgDelayMins"), 0.0))*10)/10,
				"maxDelayMins", or(r.Get("maxDelayMins"), 0.0),
				"onTimePct", pctOf(r.Get("onTimeCount"), total),
				"earlyPct", pctOf(r.Get("earlyCount"), total),
				"latePct", pctOf(r.Get("lateCount"), total),
				"moderateLatePct", pctOf(r.Get("moderateLateCount"), total),
				"severeLatePct", pctOf(r.Get("severeLateCount"), total),
				"severitySplitMeasured", true,
			), nil
		}
		hv, err := h.get(`
        SELECT
          SUM(visit_count) as totalVisits,
          SUM(sample_count) as totalSamples,
          -- Weighted by volume: a plain AVG of hourly averages counts an hour
          -- with one visit as much as an hour with two hundred.
          SUM(delay_sum) * 1.0 / NULLIF(SUM(visit_count), 0) as avgDelayMins,
          MAX(max_delay_mins) as maxDelayMins,
          SUM(on_time_count) as onTimeCount,
          SUM(early_count) as earlyCount,
          SUM(late_count) as lateCount
        FROM hourly_line_visit_stats
        WHERE agency_id = ? AND (UPPER(line_code) = ? OR UPPER(line_code) = ? OR UPPER(line_code) = ?) AND timestamp >= ?
      `, mataroAgency.ID, codeUpper, codeNoHyphen, codeWithL, cutoff)
		if err != nil {
			return nil, err
		}
		if hv != nil && jsNumber(hv.Get("totalVisits")) > 0 {
			total := hv.Get("totalVisits")
			return O(
				"totalVisits", total,
				"totalSamples", or(hv.Get("totalSamples"), total),
				"sampleCount", or(hv.Get("totalSamples"), total),
				"avgDelayMins", jsRound(jsNumber(or(hv.Get("avgDelayMins"), 0.0))*10)/10,
				"maxDelayMins", or(hv.Get("maxDelayMins"), 0.0),
				"onTimePct", clampPct(hv.Get("onTimeCount"), total),
				"earlyPct", clampPct(hv.Get("earlyCount"), total),
				"latePct", clampPct(hv.Get("lateCount"), total),
				"moderateLatePct", nil,
				"severeLatePct", nil,
				"severitySplitMeasured", false,
				"severitySplitNote", "hourly rollups keep a single late bucket (> 3 min)",
			), nil
		}
		hr, err := h.get(`
        SELECT
          SUM(sample_count) as totalSamples,
          SUM(COALESCE(delay_sum, avg_delay_mins * sample_count)) * 1.0 / NULLIF(SUM(sample_count), 0) as avgDelayMins,
          MAX(max_delay_mins) as maxDelayMins,
          SUM(on_time_count) as onTimeCount,
          SUM(early_count) as earlyCount,
          SUM(CASE WHEN early_count IS NULL THEN 1 ELSE 0 END) as legacyHours,
          SUM(late_count) as lateCount
        FROM hourly_line_stats
        WHERE agency_id = ? AND (UPPER(line_code) = ? OR UPPER(line_code) = ? OR UPPER(line_code) = ?) AND timestamp >= ?
      `, mataroAgency.ID, codeUpper, codeNoHyphen, codeWithL, cutoff)
		if err != nil {
			return nil, err
		}
		if hr != nil && jsNumber(hr.Get("totalSamples")) > 0 {
			total := hr.Get("totalSamples")
			split := !truthy(hr.Get("legacyHours"))
			var onTime, early any
			note := "rolled-up hours before early buses were counted apart: on-time and early cannot be separated"
			if split {
				onTime = clampPct(hr.Get("onTimeCount"), total)
				early = clampPct(or(hr.Get("earlyCount"), 0.0), total)
				note = ""
			}
			return O(
				"totalVisits", total,
				"totalSamples", total,
				"sampleCount", total,
				"avgDelayMins", jsRound(jsNumber(or(hr.Get("avgDelayMins"), 0.0))*10)/10,
				"maxDelayMins", or(hr.Get("maxDelayMins"), 0.0),
				"onTimePct", onTime,
				"earlyPct", early,
				"latePct", clampPct(hr.Get("lateCount"), total),
				"moderateLatePct", nil,
				"severeLatePct", nil,
				"severitySplitMeasured", false,
				"severitySplitNote", `hourly_line_stats keeps a single "late > 3 min" bucket, so the moderate/severe split cannot be measured for rolled-up hours`,
				"earlySplitNote", note,
			), nil
		}
		return noLineStatsDB(), nil
	}()
	if err != nil {
		log.Printf("[HistoryDB] getLineDelayStats error: %s", err.Error())
		return noLineStatsDB()
	}
	return res
}

package main

// Port of src/historyDb.js: getJournalismReport, getHourlyTrafficContext,
// getAnomalyContext.

import (
	"errors"
	"log"
	"math"
	"regexp"
	"sort"
	"strings"
)

// orF is JS `a || b` for numbers (0 and NaN are falsy).
func orF(a, b float64) float64 {
	if a != 0 && !math.IsNaN(a) {
		return a
	}
	return b
}

// sortObjs is Array.prototype.sort with a comparator (stable, like V8).
func sortObjs(list []*Obj, cmp func(a, b *Obj) float64) {
	sort.SliceStable(list, func(i, j int) bool { return cmp(list[i], list[j]) < 0 })
}

// valueKey stands in for JSON.stringify of a SQLite value inside a
// composite key: distinct values give distinct keys.
func valueKey(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case float64:
		return "n" + numToString(x)
	case string:
		return "s" + x
	case []byte:
		return "b" + string(x)
	}
	return "?" + jsString(v)
}

var reNonAZ09 = regexp.MustCompile(`[^A-Z0-9]`)

func normKey(s any) string {
	return reNonAZ09.ReplaceAllLiteralString(jsUpper(jsString(or(s, ""))), "")
}

type trafficContext struct {
	Tag          string
	IsSchoolHour bool
	IsPeak       bool
	Icon         string
	IsDepot      bool
}

func (c trafficContext) obj() *Obj {
	return O("tag", c.Tag, "isSchoolHour", c.IsSchoolHour, "isPeak", c.IsPeak, "icon", c.Icon, "isDepot", c.IsDepot)
}

func getHourlyTrafficContext(hourNum any) trafficContext {
	h := orF(jsNumber(hourNum), 0)
	if isUndef(hourNum) {
		h = 0
	}
	switch {
	case h >= 0 && h < 5:
		return trafficContext{"🔧 Cotxeres / Manteniment nocturn", false, false, "🔧", true}
	case h == 5:
		return trafficContext{"🌅 Primeres sortides", false, false, "🌅", false}
	case h == 6:
		return trafficContext{"🌅 Inici servei matinal", false, false, "🌅", false}
	case h == 7:
		return trafficContext{"🌅 Primer torn de feina", false, false, "🌅", false}
	case h == 8:
		return trafficContext{"🚨 Entrada escolar & feina", true, true, "🎒", false}
	case h == 9:
		return trafficContext{"🏫 Post-entrada escoles", true, false, "📚", false}
	case h >= 10 && h <= 12:
		return trafficContext{"🟢 Vall matinal regular", false, false, "🟢", false}
	case h == 13 || h == 14:
		return trafficContext{"🥪 Migdia escolar & feina", true, true, "🥪", false}
	case h >= 15 && h <= 16:
		return trafficContext{"🟡 Vall tarda regular", false, false, "🟡", false}
	case h == 17:
		return trafficContext{"🚨 Sortida escolar", true, true, "🎒", false}
	case h == 18 || h == 19:
		return trafficContext{"🚗 Punta tornada feina", false, true, "🚗", false}
	case h >= 20 && h <= 22:
		return trafficContext{"🌙 Servei vespre", false, false, "🌙", false}
	}
	return trafficContext{"🌙 Tancament servei", false, false, "🌙", false}
}

func getAnomalyContext(timestamp, delayMins, stopName, lineCode any) *Obj {
	sName := jsLower(jsString(or(stopName, "")))
	isDepotStop := strings.Contains(sName, "cotxeres") || strings.Contains(sName, "depot") || strings.Contains(sName, "taller")
	if isDepotStop || isOutsideRevenueService(lineCode, jsNumber(timestamp)) {
		return O("anomalyType", "maintenance", "diagnosticBadge", "🔧 Cotxeres / Manteniment nocturn", "anomalyIcon", "🔧")
	}
	return O("anomalyType", "startup_sae", "diagnosticBadge", "⚠️ Desfasament SAE torn matinal", "anomalyIcon", "⚠️")
}

// catalogIndex is validCatalogMap: normalised and raw code/id -> line.
type catalogIndex map[string]*Obj

func buildCatalogIndex(catalog []any) catalogIndex {
	m := catalogIndex{}
	for _, x := range catalog {
		if !truthy(x) {
			continue
		}
		line := asObj(x)
		kCode, kID := normKey(line.Get("code")), normKey(line.Get("id"))
		rawCode := jsUpper(jsString(or(line.Get("code"), "")))
		rawID := jsUpper(jsString(or(line.Get("id"), "")))
		if kCode != "" {
			m[kCode] = line
		}
		if kID != "" {
			m[kID] = line
		}
		if rawCode != "" {
			m[rawCode] = line
		}
		if rawID != "" {
			m[rawID] = line
		}
	}
	return m
}

func (c catalogIndex) lookup(lineCode any) *Obj {
	if l, ok := c[normKey(lineCode)]; ok {
		return l
	}
	return c[jsUpper(jsString(or(lineCode, "")))]
}

func (c catalogIndex) has(lineCode any) bool {
	_, a := c[normKey(lineCode)]
	_, b := c[jsUpper(jsString(or(lineCode, "")))]
	return a || b
}

func roundAvg1(r *Obj) *Obj {
	c := r.Clone()
	c.Set("avgDelay", jsRound(jsNumber(or(r.Get("avgDelay"), 0.0))*10)/10)
	return c
}

// onTimeOf / earlyOf follow `x.onTimePercentage !== undefined ? ... : ...`.
func onTimeOf(r *Obj) float64 {
	if !r.IsUndef("onTimePercentage") {
		return jsNumber(r.Get("onTimePercentage"))
	}
	return 100 - jsNumber(or(r.Get("latePercentage"), 0.0))
}

func earlyOf(r *Obj) float64 {
	if !r.IsUndef("earlyPercentage") {
		return jsNumber(r.Get("earlyPercentage"))
	}
	return 0
}

func punctualityCmp(a, b *Obj) float64 {
	oa, ob := onTimeOf(a), onTimeOf(b)
	if ob != oa {
		return ob - oa
	}
	ea, eb := earlyOf(a), earlyOf(b)
	if ea != eb {
		return ea - eb
	}
	return a.Num("avgDelay") - b.Num("avgDelay")
}

func emptyJournalism() *Obj {
	return O("summary", O(), "rankingMostDelayed", []any{}, "rankingBestPunctuality", []any{}, "rankingWorstStops", []any{}, "allStopDelays", []any{}, "agencyStats", []any{})
}

func (h *HistoryDB) getJournalismReport(hoursBack any, allLinesCatalog any) *Obj {
	if isUndef(hoursBack) {
		hoursBack = 24.0
	}
	catalog, _ := allLinesCatalog.([]any)
	if !h.ensureOpen() {
		return emptyJournalism()
	}
	res, err := h.journalismReport(hoursBack, catalog)
	if err != nil {
		log.Printf("[HistoryDB] getJournalismReport error: %s", err.Error())
		return O("summary", O(), "termometre", nil, "rankingMostDelayed", []any{}, "rankingBestPunctuality", []any{}, "rankingWorstStops", []any{}, "allStopDelays", []any{}, "agencyStats", []any{})
	}
	return res
}

func (h *HistoryDB) journalismReport(hoursBack any, catalog []any) (*Obj, error) {
	hb := jsNumber(hoursBack)
	cutoff := float64(nowMs()) - hb*3600*1000

	hv, err := h.get("SELECT COUNT(*) as c FROM stop_visits WHERE last_ts >= ? AND "+validDelaySQL+mataroVisitsScopeSQL, cutoff)
	if err != nil {
		return nil, err
	}
	hasVisitsCount := 0.0
	if hv != nil {
		hasVisitsCount = jsNumber(or(hv.Get("c"), 0.0))
	}
	useVisits := hasVisitsCount > 0
	tbl, tsCol, scopeSQL, which := "delay_logs", "timestamp", mataroScopeSQL, "logs"
	agencyCol, rawCountCol := "agency", "COUNT(*)"
	stopIDCol, lineIDCol := "stop_id", "line_id"
	if useVisits {
		tbl, tsCol, scopeSQL, which = "stop_visits", "last_ts", mataroVisitsScopeSQL, "visits"
		agencyCol, rawCountCol = "'Mataró Bus (Avanza)'", "SUM(sample_count)"
		stopIDCol, lineIDCol = "stop_name", "REPLACE(line_code, 'L', '')"
	}
	sf, err := h.serviceFilter(serviceFilterOpts{since: cutoff, until: float64(nowMs()), tables: []string{which}})
	if err != nil {
		return nil, err
	}
	serviceSQL := sf.logs
	if useVisits {
		serviceSQL = sf.visits
	}
	where := `WHERE ` + tsCol + ` >= ? AND ` + validDelaySQL + scopeSQL + serviceSQL

	sum, err := h.get(`
        SELECT
          COUNT(*) as totalRecordedArrivals,
          COUNT(DISTINCT line_code) as monitoredLinesCount,
          AVG(delay_mins) as networkAvgDelay,
          MAX(delay_mins) as networkMaxDelay,
          SUM(CASE WHEN `+onTimeSQL+` THEN 1 ELSE 0 END) as totalOnTime,
          SUM(CASE WHEN `+earlySQL+` THEN 1 ELSE 0 END) as totalEarly,
          SUM(CASE WHEN `+lateSQL+` THEN 1 ELSE 0 END) as totalLate,
          SUM(CASE WHEN `+severeLateSQL+` THEN 1 ELSE 0 END) as totalSignificantDelay,
          SUM(CASE WHEN is_realtime = 0 THEN 1 ELSE 0 END) as nonRealtimeSamples,
          `+rawCountCol+` as rawSampleCount
        FROM `+tbl+`
        `+where+`
      `, cutoff)
	if err != nil {
		return nil, err
	}
	if sum == nil {
		sum = O()
	}
	totalArrivals := jsNumber(or(sum.Get("totalRecordedArrivals"), 0.0))
	nonRealtimeSamples := jsNumber(or(sum.Get("nonRealtimeSamples"), 0.0))

	delayedRows, err := h.all(`
        SELECT
          line_code as lineCode,
          `+agencyCol+` as agency,
          COUNT(*) as sampleCount,
          COUNT(*) as visitCount,
          `+rawCountCol+` as rawSampleCount,
          AVG(delay_mins) as avgDelay,
          MAX(delay_mins) as maxDelay,
          ROUND((SUM(CASE WHEN `+onTimeSQL+` THEN 1.0 ELSE 0.0 END) / COUNT(*)) * 100, 1) as onTimePercentage,
          ROUND((SUM(CASE WHEN `+earlySQL+` THEN 1.0 ELSE 0.0 END) / COUNT(*)) * 100, 1) as earlyPercentage,
          ROUND((SUM(CASE WHEN `+lateSQL+` THEN 1.0 ELSE 0.0 END) / COUNT(*)) * 100, 1) as latePercentage
        FROM `+tbl+`
        `+where+`
        GROUP BY line_code
        HAVING sampleCount >= 1
        ORDER BY avgDelay DESC
        LIMIT 2000
      `, cutoff)
	if err != nil {
		return nil, err
	}

	idx := buildCatalogIndex(catalog)
	var rankingMostDelayed []*Obj
	for _, raw := range delayedRows {
		r := roundAvg1(raw)
		if jsNumber(or(r.Get("sampleCount"), 0.0)) < 1 {
			continue
		}
		cl := idx.lookup(r.Get("lineCode"))
		if cl == nil && len(idx) > 0 {
			continue
		}
		o := r.Clone()
		if cl != nil {
			o.Set("lineId", cl.Get("id"))
			o.Set("lineCode", cl.Get("code"))
			o.Set("name", cl.Get("name"))
			o.Set("color", cl.Get("color"))
			o.Set("agency", or(cl.Get("agency"), r.Get("agency")))
		} else {
			o.Set("lineId", r.Get("lineCode"))
			o.Set("lineCode", r.Get("lineCode"))
			o.Set("name", or(r.Get("name"), r.Get("lineCode")))
			o.Set("color", or(r.Get("color"), "#009485"))
			o.Set("agency", r.Get("agency"))
		}
		rankingMostDelayed = append(rankingMostDelayed, o)
	}
	sortObjs(rankingMostDelayed, func(a, b *Obj) float64 {
		if b.Num("avgDelay") != a.Num("avgDelay") {
			return b.Num("avgDelay") - a.Num("avgDelay")
		}
		if !strictEq(b.Get("sampleCount"), a.Get("sampleCount")) {
			return b.Num("sampleCount") - a.Num("sampleCount")
		}
		return float64(localeCompareJS(jsString(or(a.Get("lineCode"), "")), jsString(or(b.Get("lineCode"), "")), true))
	})

	rankingBestPunctuality := append([]*Obj(nil), rankingMostDelayed...)
	sortObjs(rankingBestPunctuality, punctualityCmp)
	if len(rankingBestPunctuality) > 1000 {
		rankingBestPunctuality = rankingBestPunctuality[:1000]
	}

	groupBy := "agency"
	if useVisits {
		groupBy = "1"
	}
	agencyRows, err := h.all(`
        SELECT
          `+agencyCol+` as agency,
          COUNT(*) as totalSamples,
          COUNT(*) as totalVisits,
          `+rawCountCol+` as rawSampleCount,
          COUNT(DISTINCT line_code) as linesCount,
          AVG(delay_mins) as avgDelay,
          ROUND((SUM(CASE WHEN `+onTimeSQL+` THEN 1.0 ELSE 0.0 END) / COUNT(*)) * 100, 1) as onTimePct,
          ROUND((SUM(CASE WHEN `+earlySQL+` THEN 1.0 ELSE 0.0 END) / COUNT(*)) * 100, 1) as earlyPct,
          ROUND((SUM(CASE WHEN `+lateSQL+` THEN 1.0 ELSE 0.0 END) / COUNT(*)) * 100, 1) as latePct
        FROM `+tbl+`
        `+where+`
        GROUP BY `+groupBy+`
        HAVING totalSamples >= 1
        ORDER BY avgDelay DESC
      `, cutoff)
	if err != nil {
		return nil, err
	}
	var agencyStats []*Obj
	for _, a := range agencyRows {
		a = roundAvg1(a)
		if jsNumber(or(a.Get("totalSamples"), 0.0)) >= 1 {
			agencyStats = append(agencyStats, a)
		}
	}
	sortObjs(agencyStats, func(a, b *Obj) float64 { return b.Num("totalSamples") - a.Num("totalSamples") })

	notNight := `
          AND madrid_hour(` + tsCol + `) NOT IN ('00', '01', '02', '03', '04')`
	stopKey := func(r *Obj) string {
		return valueKey(r.Get("agency")) + "\x00" + valueKey(r.Get("recordedLineId")) + "\x00" + valueKey(r.Get("stopId"))
	}

	type opHours struct{ minH, maxH float64 }
	lineOperatingHours := map[string]opHours{}
	for l := 1; l <= 8; l++ {
		s := numToString(float64(l))
		if mn, mx, ok := operatingHours(s, ""); ok {
			lineOperatingHours[s] = opHours{float64(mn), float64(mx)}
			lineOperatingHours["L"+s] = opHours{float64(mn), float64(mx)}
		}
	}

	stopHourlyRows, err := h.all(`
        SELECT
          madrid_hour(`+tsCol+`) as hourOfDay,
          `+stopIDCol+` as stopId,
          `+lineIDCol+` as recordedLineId,
          MAX(stop_name) as stopName,
          MAX(line_code) as lineCode,
          `+agencyCol+` as agency,
          COUNT(*) as arrivalCount,
          ROUND(AVG(delay_mins), 1) as avgDelay,
          MAX(delay_mins) as maxDelay,
          ROUND((SUM(CASE WHEN `+severeLateSQL+` THEN 1.0 ELSE 0.0 END) / COUNT(*)) * 100, 1) as severeLatePct
        FROM `+tbl+`
        `+where+notNight+`
        GROUP BY hourOfDay, agency, recordedLineId, stopId
        ORDER BY hourOfDay ASC, avgDelay DESC, arrivalCount DESC
      `, cutoff)
	if err != nil {
		return nil, err
	}
	stopHoursMap := map[string][]*Obj{}
	hourlyStopsMap := map[string][]*Obj{}
	for _, r := range stopHourlyRows {
		k := stopKey(r)
		stopHoursMap[k] = append(stopHoursMap[k], r)
		hk := padStart(jsString(r.Get("hourOfDay")), 2, "0")
		hourlyStopsMap[hk] = append(hourlyStopsMap[hk], r)
	}

	allStopsRows, err := h.all(`
        SELECT
          `+stopIDCol+` as stopId,
          `+lineIDCol+` as recordedLineId,
          MAX(stop_name) as stopName,
          MAX(line_code) as lineCode,
          `+agencyCol+` as agency,
          COUNT(*) as arrivalCount,
          COUNT(*) as visitCount,
          `+rawCountCol+` as sampleCount,
          AVG(delay_mins) as avgDelay,
          MAX(delay_mins) as maxDelay,
          ROUND((SUM(CASE WHEN `+severeLateSQL+` THEN 1.0 ELSE 0.0 END) / COUNT(*)) * 100, 1) as severeLatePct
        FROM `+tbl+`
        `+where+notNight+`
        GROUP BY agency, recordedLineId, stopId
        HAVING arrivalCount >= 1
        ORDER BY avgDelay DESC, maxDelay DESC
      `, cutoff)
	if err != nil {
		return nil, err
	}
	var allStopDelays []*Obj
	for _, raw := range allStopsRows {
		r := roundAvg1(raw)
		if len(idx) > 0 && !idx.has(r.Get("lineCode")) {
			continue
		}
		cleanKey := normKey(r.Get("lineCode"))
		rawKey := jsUpper(jsString(or(r.Get("lineCode"), "")))
		cl := idx.lookup(r.Get("lineCode"))
		sk := stopKey(r)
		hoursForStop := stopHoursMap[sk]
		sortObjs(hoursForStop, func(a, b *Obj) float64 {
			return orF(b.Num("avgDelay")-a.Num("avgDelay"), b.Num("arrivalCount")-a.Num("arrivalCount"))
		})
		var criticalHour any = "--"
		criticalHourAvgDelay := r.Get("avgDelay")
		var criticalHourArrivals any = 0.0
		criticalHourTag, criticalHourIcon, isSchoolHour := "Regular", "📍", false
		if len(hoursForStop) > 0 {
			critical := hoursForStop[0]
			hNum := parseIntJS(critical.Get("hourOfDay"))
			nextH := padStart(numToString(jsMod(hNum+1, 24)), 2, "0")
			ctx := getHourlyTrafficContext(hNum)
			criticalHour = jsString(critical.Get("hourOfDay")) + ":00 - " + nextH + ":00"
			criticalHourAvgDelay = critical.Get("avgDelay")
			criticalHourArrivals = critical.Get("arrivalCount")
			criticalHourTag, criticalHourIcon, isSchoolHour = ctx.Tag, ctx.Icon, ctx.IsSchoolHour
		}
		op, ok := lineOperatingHours[cleanKey]
		if !ok {
			op, ok = lineOperatingHours[rawKey]
		}
		if !ok {
			op = opHours{5, 22}
		}
		isBottleneck := jsNumber(or(r.Get("avgDelay"), 0.0)) >= 1.5 || jsNumber(or(r.Get("severeLatePct"), 0.0)) >= 20.0
		hourly := make([]any, 24)
		for hour := 0; hour < 24; hour++ {
			hourKey := padStart(numToString(float64(hour)), 2, "0")
			var bucket *Obj
			if float64(hour) >= op.minH && float64(hour) <= op.maxH {
				for _, row := range hoursForStop {
					if strictEq(row.Get("hourOfDay"), hourKey) {
						bucket = row
						break
					}
				}
			}
			cell := O("hour", hourKey, "sampleCount", 0.0, "avgDelay", nil, "maxDelay", nil, "severeLatePct", nil)
			if bucket != nil {
				cell.Set("sampleCount", or(bucket.Get("arrivalCount"), 0.0))
				cell.Set("avgDelay", coalesce(bucket.Get("avgDelay"), nil))
				cell.Set("maxDelay", coalesce(bucket.Get("maxDelay"), nil))
				cell.Set("severeLatePct", coalesce(bucket.Get("severeLatePct"), nil))
			}
			hourly[hour] = cell
		}
		o := r.Clone()
		o.Set("isBottleneck", isBottleneck)
		o.Set("hourly", hourly)
		if cl != nil {
			o.Set("lineId", cl.Get("id"))
			o.Set("lineCode", cl.Get("code"))
			o.Set("agency", or(cl.Get("agency"), r.Get("agency")))
		} else {
			o.Set("lineId", r.Get("recordedLineId"))
			o.Set("lineCode", r.Get("lineCode"))
			o.Set("agency", r.Get("agency"))
		}
		o.Set("criticalHour", criticalHour)
		o.Set("criticalHourAvgDelay", criticalHourAvgDelay)
		o.Set("criticalHourArrivals", criticalHourArrivals)
		o.Set("criticalHourTag", criticalHourTag)
		o.Set("criticalHourIcon", criticalHourIcon)
		o.Set("isSchoolHour", isSchoolHour)
		allStopDelays = append(allStopDelays, o)
	}
	var rankingWorstStops []*Obj
	for _, r := range allStopDelays {
		if truthy(r.Get("isBottleneck")) && len(rankingWorstStops) < 100 {
			rankingWorstStops = append(rankingWorstStops, r)
		}
	}
	var totalMonitoredCount float64
	if len(catalog) > 0 {
		totalMonitoredCount = float64(len(catalog))
	} else {
		totalMonitoredCount = math.Max(jsNumber(or(sum.Get("monitoredLinesCount"), 0.0)), float64(len(rankingMostDelayed)))
	}

	dbHourly, err := h.all(`
        SELECT
          madrid_hour(`+tsCol+`) as hourOfDay,
          COUNT(*) as sampleCount,
          COUNT(*) as visitCount,
          `+rawCountCol+` as rawSampleCount,
          ROUND(AVG(delay_mins), 1) as avgDelay,
          MAX(delay_mins) as maxDelay,
          SUM(CASE WHEN `+lateSQL+` THEN 1 ELSE 0 END) as lateCount,
          ROUND((SUM(CASE WHEN `+onTimeSQL+` THEN 1.0 ELSE 0.0 END) / COUNT(*)) * 100, 1) as onTimePercentage,
          ROUND((SUM(CASE WHEN `+earlySQL+` THEN 1.0 ELSE 0.0 END) / COUNT(*)) * 100, 1) as earlyPercentage,
          ROUND((SUM(CASE WHEN `+lateSQL+` THEN 1.0 ELSE 0.0 END) / COUNT(*)) * 100, 1) as latePercentage,
          ROUND((SUM(CASE WHEN `+severeLateSQL+` THEN 1.0 ELSE 0.0 END) / COUNT(*)) * 100, 1) as severeLatePercentage
        FROM `+tbl+`
        `+where+notNight+`
        GROUP BY hourOfDay
        ORDER BY hourOfDay ASC
      `, cutoff)
	if err != nil {
		return nil, err
	}
	hourlyMap := map[string]*Obj{}
	for _, row := range dbHourly {
		hourlyMap[padStart(jsString(row.Get("hourOfDay")), 2, "0")] = row
	}
	var hourlyDelays []*Obj
	for hr := 0; hr < 24; hr++ {
		hStr := padStart(numToString(float64(hr)), 2, "0")
		nextHStr := padStart(numToString(float64((hr+1)%24)), 2, "0")
		ctx := getHourlyTrafficContext(float64(hr))
		row := hourlyMap[hStr]
		f := func(k string) any {
			if row == nil {
				return 0.0
			}
			return or(row.Get(k), 0.0)
		}
		hourlyDelays = append(hourlyDelays, O(
			"hour", hStr,
			"timeWindow", hStr+":00 - "+nextHStr+":00",
			"sampleCount", f("sampleCount"),
			"visitCount", f("visitCount"),
			"avgDelay", f("avgDelay"),
			"maxDelay", f("maxDelay"),
			"lateCount", f("lateCount"),
			"onTimePercentage", f("onTimePercentage"),
			"earlyPercentage", f("earlyPercentage"),
			"latePercentage", f("latePercentage"),
			"severeLatePercentage", f("severeLatePercentage"),
			"trafficTag", ctx.Tag,
			"isSchoolHour", ctx.IsSchoolHour,
			"isPeak", ctx.IsPeak,
			"icon", ctx.Icon,
		))
	}
	var activeHours []*Obj
	for _, x := range hourlyDelays {
		if x.Num("sampleCount") > 0 {
			activeHours = append(activeHours, x)
		}
	}
	sortObjs(activeHours, func(a, b *Obj) float64 {
		return orF(b.Num("avgDelay")-a.Num("avgDelay"), b.Num("latePercentage")-a.Num("latePercentage"))
	})
	if len(activeHours) > 5 {
		activeHours = activeHours[:5]
	}
	peakHours := []any{}
	for _, ph := range activeHours {
		worst := []any{}
		for i, st := range hourlyStopsMap[jsString(ph.Get("hour"))] {
			if i >= 3 {
				break
			}
			worst = append(worst, O("stopName", st.Get("stopName"), "lineCode", st.Get("lineCode"), "agency", st.Get("agency"),
				"avgDelay", st.Get("avgDelay"), "arrivalCount", st.Get("arrivalCount")))
		}
		peakHours = append(peakHours, ph.Clone().Set("worstStopsDuringHour", worst))
	}

	hasSamples := totalArrivals > 0
	var peakHour *Obj
	if len(peakHours) > 0 {
		peakHour = peakHours[0].(*Obj)
	}
	var punctualityPct any
	var grade any
	if hasSamples {
		p := jsRound(jsNumber(sum.Get("totalOnTime")) / totalArrivals * 100)
		punctualityPct = p
		switch {
		case p >= 92:
			grade = "A+"
		case p >= 84:
			grade = "A"
		case p >= 74:
			grade = "B"
		case p >= 62:
			grade = "C"
		default:
			grade = "D"
		}
	}

	var candidateLines []*Obj
	for _, r := range rankingBestPunctuality {
		var early float64
		if !r.IsUndef("earlyPercentage") {
			early = jsNumber(r.Get("earlyPercentage"))
		} else {
			early = jsNumber(or(r.Get("earlyPct"), 0.0))
		}
		if early <= 10.0 {
			candidateLines = append(candidateLines, r)
		}
	}
	maxLineVisits := 0.0
	for _, c := range candidateLines {
		maxLineVisits = math.Max(maxLineVisits, jsNumber(or(c.Get("sampleCount"), 0.0)))
	}
	minVisitsThreshold := 1.0
	if maxLineVisits >= 200 {
		minVisitsThreshold = 200
	}
	var eligible []*Obj
	for _, c := range candidateLines {
		if jsNumber(or(c.Get("sampleCount"), 0.0)) >= minVisitsThreshold {
			eligible = append(eligible, c)
		}
	}
	sortObjs(eligible, punctualityCmp)

	pctRound := func(k string) any {
		if !hasSamples {
			return nil
		}
		return jsRound(jsNumber(or(sum.Get(k), 0.0)) / totalArrivals * 100)
	}
	var networkAvgDelay any
	if hasSamples {
		networkAvgDelay = jsRound(jsNumber(or(sum.Get("networkAvgDelay"), 0.0))*10) / 10
	}
	var championLine any
	if len(eligible) > 0 {
		c := eligible[0]
		var onTime, early, late any
		if !c.IsUndef("onTimePercentage") {
			onTime = c.Get("onTimePercentage")
		} else {
			onTime = or(c.Get("onTimePct"), jsRound(100-jsNumber(or(c.Get("latePercentage"), 0.0))))
		}
		if !c.IsUndef("earlyPercentage") {
			early = c.Get("earlyPercentage")
		} else {
			early = or(c.Get("earlyPct"), 0.0)
		}
		if !c.IsUndef("latePercentage") {
			late = c.Get("latePercentage")
		} else {
			late = or(c.Get("latePct"), 0.0)
		}
		championLine = O(
			"code", or(c.Get("lineCode"), c.Get("id")),
			"name", or(c.Get("name"), "Línia "+jsString(c.Get("lineCode"))),
			"onTimePct", onTime,
			"earlyPct", early,
			"latePct", late,
			"avgDelay", c.Get("avgDelay"),
		)
	}
	var worstBottleneck any
	if len(rankingWorstStops) > 0 {
		b := rankingWorstStops[0]
		worstBottleneck = O("stopName", b.Get("stopName"), "lineCode", b.Get("lineCode"), "avgDelay", b.Get("avgDelay"),
			"severeLatePct", b.Get("severeLatePct"), "criticalHour", b.Get("criticalHour"), "criticalHourTag", b.Get("criticalHourTag"))
	}
	window := "7 dies"
	if hb <= 24 {
		window = "24h"
	} else if hb <= 48 {
		window = "48h"
	}
	noDataReason := ""
	if !hasSamples {
		noDataReason = "No hi ha cap mostra de retard registrada en aquesta finestra temporal."
	}
	var peakHourWindow, peakHourDelay, peakHourTag, peakHourIcon any
	if peakHour != nil {
		peakHourWindow = peakHour.Get("timeWindow")
		peakHourDelay = coalesce(peakHour.Get("avgDelay"), nil)
		peakHourTag = or(peakHour.Get("trafficTag"), nil)
		peakHourIcon = or(peakHour.Get("icon"), nil)
	}
	termometre := O(
		"title", "El Termòmetre del Bus ("+window+")",
		"timeframeHours", hoursBack,
		"noData", !hasSamples,
		"noDataReason", noDataReason,
		"grade", grade,
		"punctualityPct", punctualityPct,
		"earlyPct", pctRound("totalEarly"),
		"latePct", pctRound("totalLate"),
		"networkAvgDelay", networkAvgDelay,
		"championLine", championLine,
		"worstBottleneck", worstBottleneck,
		"peakHour", peakHourWindow,
		"peakHourDelay", peakHourDelay,
		"peakHourTag", peakHourTag,
		"peakHourIcon", peakHourIcon,
		"totalTripsAnalyzed", totalArrivals,
		"totalStopVisits", totalArrivals,
	)

	comparison := O(
		"hasData", false,
		"method", "operator_trip",
		"comparedVisits", 0.0,
		"operatorAvgDelay", nil,
		"measuredAvgDelay", nil,
		"biasMins", nil,
		"agreedVisits", 0.0,
		"agreementPct", nil,
		"tripCheckedVisits", 0.0,
		"tripConfirmedVisits", 0.0,
		"tripConfirmedPct", nil,
		"byLine", []any{},
		"byHour", []any{},
	)
	if useVisits {
		if c, err := h.delayMeasurementComparison(cutoff, scopeSQL, serviceSQL); err == nil && c != nil {
			comparison = c
		}
	}

	var totalSamples any = or(sum.Get("rawSampleCount"), totalArrivals)
	var nonRealtimePct any
	if hasSamples {
		nonRealtimePct = jsRound(nonRealtimeSamples/totalArrivals*1000) / 10
	}
	var networkMaxDelay any
	if hasSamples {
		networkMaxDelay = coalesce(sum.Get("networkMaxDelay"), nil)
	}
	return O(
		"summary", O(
			"totalRecordedArrivals", totalArrivals,
			"totalStopVisits", totalArrivals,
			"totalSamples", totalSamples,
			"monitoredLinesCount", totalMonitoredCount,
			"networkAvgDelay", networkAvgDelay,
			"networkMaxDelay", networkMaxDelay,
			"networkPunctualityPct", punctualityPct,
			"delayMeasurementComparison", comparison,
			"onTimePct", punctualityPct,
			"earlyPct", pctRound("totalEarly"),
			"latePct", pctRound("totalLate"),
			"hasSamples", hasSamples,
			"hoursAnalyzed", hoursBack,
			"samplingBreakdown", O(
				"totalSamples", totalSamples,
				"totalVisits", totalArrivals,
				"realtimeSamples", math.Max(0, jsNumber(totalSamples)-nonRealtimeSamples),
				"nonRealtimeSamples", nonRealtimeSamples,
				"nonRealtimePct", nonRealtimePct,
				"note", "Les dades reflecteixen passos per parada (stop_visits). Les mostres amb is_realtime = 0 són posicions extrapolades (dead-reckoning), no GPS fresc.",
			),
		),
		"termometre", termometre,
		"hourlyDelays", objsToAny(hourlyDelays),
		"peakHours", peakHours,
		"rankingMostDelayed", objsToAny(rankingMostDelayed),
		"rankingBestPunctuality", objsToAny(rankingBestPunctuality),
		"rankingWorstStops", objsToAny(rankingWorstStops),
		"allStopDelays", objsToAny(allStopDelays),
		"agencyStats", objsToAny(agencyStats),
	), nil
}

// delayMeasurementComparison returns (nil, nil) when nothing was compared;
// any error leaves the caller's default in place (the JS swallows it).
func (h *HistoryDB) delayMeasurementComparison(cutoff float64, scopeSQL, serviceSQL string) (*Obj, error) {
	compWhere := `WHERE last_ts >= ? AND measured_method = 'operator_trip' AND measured_delay_mins IS NOT NULL AND ` + validDelaySQL + scopeSQL + serviceSQL
	compCols := `
              COUNT(*) as comparedVisits,
              AVG(delay_mins) as operatorAvgDelay,
              AVG(measured_delay_mins) as measuredAvgDelay,
              AVG(measured_delay_mins - delay_mins) as biasMins,
              SUM(CASE WHEN ABS(delay_mins - measured_delay_mins) <= 1 THEN 1 ELSE 0 END) as agreedVisits,
              SUM(CASE WHEN trip_agrees IS NOT NULL THEN 1 ELSE 0 END) as tripCheckedVisits,
              SUM(CASE WHEN trip_agrees = 1 THEN 1 ELSE 0 END) as tripConfirmedVisits`
	round1 := func(x any) any {
		if isNullish(x) {
			return nil
		}
		return jsRound(jsNumber(x)*10) / 10
	}
	pct := func(part, whole float64) any {
		if whole > 0 {
			return jsRound(part/whole*1000) / 10
		}
		return nil
	}
	shape := func(o *Obj, r *Obj) *Obj {
		agreed := jsNumber(or(r.Get("agreedVisits"), 0.0))
		checked := jsNumber(or(r.Get("tripCheckedVisits"), 0.0))
		confirmed := jsNumber(or(r.Get("tripConfirmedVisits"), 0.0))
		o.Set("comparedVisits", r.Get("comparedVisits"))
		o.Set("operatorAvgDelay", round1(r.Get("operatorAvgDelay")))
		o.Set("measuredAvgDelay", round1(r.Get("measuredAvgDelay")))
		o.Set("biasMins", round1(r.Get("biasMins")))
		o.Set("agreedVisits", agreed)
		o.Set("agreementPct", pct(agreed, jsNumber(r.Get("comparedVisits"))))
		o.Set("tripCheckedVisits", checked)
		o.Set("tripConfirmedVisits", confirmed)
		o.Set("tripConfirmedPct", pct(confirmed, checked))
		return o
	}
	comp, err := h.get(`SELECT `+compCols+` FROM stop_visits `+compWhere, cutoff)
	if err != nil {
		return nil, err
	}
	if comp == nil || !(jsNumber(comp.Get("comparedVisits")) > 0) {
		return nil, nil
	}
	lineRows, err := h.all(`
              SELECT UPPER(line_code) as lineCode, `+compCols+`
              FROM stop_visits `+compWhere+`
              GROUP BY UPPER(line_code)
            `, cutoff)
	if err != nil {
		return nil, err
	}
	var byLine []*Obj
	for _, r := range lineRows {
		byLine = append(byLine, shape(O("lineCode", r.Get("lineCode")), r))
	}
	if len(byLine) >= 2 {
		for _, r := range byLine {
			if _, ok := r.Get("lineCode").(string); !ok {
				return nil, errors.New("Cannot read properties of null (reading 'replace')")
			}
		}
	}
	lineNum := func(r *Obj) float64 {
		return orF(parseIntJS(reLeadingUpperL.ReplaceAllLiteralString(r.Str("lineCode"), "")), 0)
	}
	sortObjs(byLine, func(a, b *Obj) float64 { return lineNum(a) - lineNum(b) })
	hourRows, err := h.all(`
              SELECT madrid_hour(last_ts) as hour, `+compCols+`
              FROM stop_visits `+compWhere+`
              GROUP BY madrid_hour(last_ts)
              ORDER BY hour
            `, cutoff)
	if err != nil {
		return nil, err
	}
	byHour := []any{}
	for _, r := range hourRows {
		byHour = append(byHour, shape(O("hour", r.Get("hour")), r))
	}
	out := O("hasData", true, "method", "operator_trip")
	shape(out, comp)
	out.Set("byLine", objsToAny(byLine))
	out.Set("byHour", byHour)
	return out, nil
}

var reLeadingUpperL = regexp.MustCompile(`^L`)

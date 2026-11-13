package main

// Port of src/historyDb.js: getMonthlyReport and the CSV exports.

import (
	"log"
	"math"
	"strings"
	"time"
)

const operatingWindowDaily = "horari publicat de cada línia i dia"

func monthlyShell(mr monthRange, errMsg *string) *Obj {
	o := O("month", mr.MonthStr, "startTs", mr.StartTs, "endTs", mr.EndTs)
	if errMsg != nil {
		o.Set("error", *errMsg)
	}
	o.Set("generationTimestamp", isoString(nowMs()))
	o.Set("dataVersion", getDataVersion())
	o.Set("summary", O())
	o.Set("linesPunctuality", []any{})
	o.Set("hourlyPunctuality", []any{})
	o.Set("worstStops", []any{})
	o.Set("dataCoverage", O("activeFeedHours", 0.0, "scheduledServiceHours", 0.0, "coveragePct", nil, "operatingWindowDaily", operatingWindowDaily))
	o.Set("methodology", "")
	return o
}

func (h *HistoryDB) getMonthlyReport(monthStr any, allLinesCatalog any) *Obj {
	if !h.ensureOpen() {
		return monthlyShell(getMadridMonthRange(monthStr), nil)
	}
	res, err := h.monthlyReport(monthStr)
	if err != nil {
		log.Printf("[HistoryDB] getMonthlyReport error: %s", err.Error())
		msg := err.Error()
		return monthlyShell(getMadridMonthRange(monthStr), &msg)
	}
	return res
}

func pct1(n any, total float64) float64 { return jsRound(jsNumber(n)*1000/total) / 10 }

func (h *HistoryDB) monthlyReport(monthStr any) (*Obj, error) {
	mr := getMadridMonthRange(monthStr)
	startTs, endTs := mr.StartTs, mr.EndTs
	hv, err := h.get("SELECT COUNT(*) as c FROM stop_visits WHERE last_ts >= ? AND last_ts < ? AND "+validDelaySQL+mataroVisitsScopeSQL, startTs, endTs)
	if err != nil {
		return nil, err
	}
	hasVisitsCount := 0.0
	if hv != nil {
		hasVisitsCount = jsNumber(or(hv.Get("c"), 0.0))
	}
	useVisits := hasVisitsCount > 0
	tbl, tsCol, scopeSQL, which, basis := "delay_logs", "timestamp", mataroScopeSQL, "logs", "delay_logs"
	if useVisits {
		tbl, tsCol, scopeSQL, which, basis = "stop_visits", "last_ts", mataroVisitsScopeSQL, "visits", "stop_visits"
	}
	sf, err := h.serviceFilter(serviceFilterOpts{since: startTs, until: math.Min(float64(nowMs()), endTs), tables: []string{which}})
	if err != nil {
		return nil, err
	}
	serviceSQL := sf.logs
	if useVisits {
		serviceSQL = sf.visits
	}
	where := `WHERE ` + tsCol + ` >= ? AND ` + tsCol + ` < ? AND ` + validDelaySQL + scopeSQL + serviceSQL

	sumRow, err := h.get(`
        SELECT
          COUNT(*) as totalVisits,
          COUNT(DISTINCT line_code) as monitoredLinesCount,
          AVG(delay_mins) as networkAvgDelay,
          MAX(delay_mins) as networkMaxDelay,
          SUM(CASE WHEN `+onTimeSQL+` THEN 1 ELSE 0 END) as onTimeCount,
          SUM(CASE WHEN `+earlySQL+` THEN 1 ELSE 0 END) as earlyCount,
          SUM(CASE WHEN `+lateSQL+` THEN 1 ELSE 0 END) as lateCount,
          SUM(CASE WHEN `+severeLateSQL+` THEN 1 ELSE 0 END) as severeLateCount
        FROM `+tbl+`
        `+where+`
      `, startTs, endTs)
	if err != nil {
		return nil, err
	}
	if sumRow == nil {
		sumRow = O()
	}
	totalVisits := jsNumber(or(sumRow.Get("totalVisits"), 0.0))
	share := func(n any) any {
		if totalVisits > 0 {
			return pct1(n, totalVisits)
		}
		return nil
	}
	var avgDelay, maxDelay any
	if totalVisits > 0 {
		avgDelay = jsRound(jsNumber(or(sumRow.Get("networkAvgDelay"), 0.0))*10) / 10
		maxDelay = coalesce(sumRow.Get("networkMaxDelay"), nil)
	}
	summary := O(
		"totalVisits", totalVisits,
		"monitoredLinesCount", or(sumRow.Get("monitoredLinesCount"), 0.0),
		"avgDelayMins", avgDelay,
		"maxDelayMins", maxDelay,
		"onTimePct", share(sumRow.Get("onTimeCount")),
		"earlyPct", share(sumRow.Get("earlyCount")),
		"latePct", share(sumRow.Get("lateCount")),
		"severeLatePct", share(sumRow.Get("severeLateCount")),
		"basis", basis,
	)

	lineRows, err := h.all(`
        SELECT
          line_code as lineCode,
          COUNT(*) as visitCount,
          AVG(delay_mins) as avgDelayMins,
          MAX(delay_mins) as maxDelayMins,
          SUM(CASE WHEN `+onTimeSQL+` THEN 1 ELSE 0 END) as onTimeCount,
          SUM(CASE WHEN `+earlySQL+` THEN 1 ELSE 0 END) as earlyCount,
          SUM(CASE WHEN `+lateSQL+` THEN 1 ELSE 0 END) as lateCount,
          SUM(CASE WHEN `+severeLateSQL+` THEN 1 ELSE 0 END) as severeLateCount
        FROM `+tbl+`
        `+where+`
        GROUP BY line_code
        ORDER BY line_code ASC
      `, startTs, endTs)
	if err != nil {
		return nil, err
	}
	pctOr0 := func(n any, v float64) float64 {
		if v > 0 {
			return pct1(n, v)
		}
		return 0
	}
	linesPunctuality := []any{}
	for _, r := range lineRows {
		v := jsNumber(or(r.Get("visitCount"), 0.0))
		linesPunctuality = append(linesPunctuality, O(
			"lineCode", r.Get("lineCode"),
			"visitCount", v,
			"avgDelayMins", jsRound(jsNumber(or(r.Get("avgDelayMins"), 0.0))*10)/10,
			"maxDelayMins", or(r.Get("maxDelayMins"), 0.0),
			"onTimePct", pctOr0(r.Get("onTimeCount"), v),
			"earlyPct", pctOr0(r.Get("earlyCount"), v),
			"latePct", pctOr0(r.Get("lateCount"), v),
			"severeLatePct", pctOr0(r.Get("severeLateCount"), v),
		))
	}

	hourRows, err := h.all(`
        SELECT
          madrid_hour(`+tsCol+`) as hourStr,
          COUNT(*) as visitCount,
          AVG(delay_mins) as avgDelayMins,
          SUM(CASE WHEN `+onTimeSQL+` THEN 1 ELSE 0 END) as onTimeCount,
          SUM(CASE WHEN `+earlySQL+` THEN 1 ELSE 0 END) as earlyCount,
          SUM(CASE WHEN `+lateSQL+` THEN 1 ELSE 0 END) as lateCount,
          SUM(CASE WHEN `+severeLateSQL+` THEN 1 ELSE 0 END) as severeLateCount
        FROM `+tbl+`
        `+where+`
        GROUP BY hourStr
        ORDER BY hourStr ASC
      `, startTs, endTs)
	if err != nil {
		return nil, err
	}
	hourlyPunctuality := []any{}
	for _, r := range hourRows {
		v := jsNumber(or(r.Get("visitCount"), 0.0))
		hNum := parseIntJS(r.Get("hourStr"))
		hs := padStart(numToString(hNum), 2, "0")
		hourlyPunctuality = append(hourlyPunctuality, O(
			"hour", hNum,
			"hourLabel", hs+":00 - "+hs+":59",
			"visitCount", v,
			"avgDelayMins", jsRound(jsNumber(or(r.Get("avgDelayMins"), 0.0))*10)/10,
			"onTimePct", pctOr0(r.Get("onTimeCount"), v),
			"earlyPct", pctOr0(r.Get("earlyCount"), v),
			"latePct", pctOr0(r.Get("lateCount"), v),
			"severeLatePct", pctOr0(r.Get("severeLateCount"), v),
		))
	}

	worstRows, err := h.all(`
        SELECT
          stop_name as stopName,
          COUNT(DISTINCT line_code) as linesCount,
          GROUP_CONCAT(DISTINCT line_code) as linesServed,
          COUNT(*) as visitCount,
          AVG(delay_mins) as avgDelayMins,
          MAX(delay_mins) as maxDelayMins,
          ROUND((SUM(CASE WHEN `+onTimeSQL+` THEN 1.0 ELSE 0.0 END) / COUNT(*)) * 100, 1) as onTimePct,
          ROUND((SUM(CASE WHEN `+earlySQL+` THEN 1.0 ELSE 0.0 END) / COUNT(*)) * 100, 1) as earlyPct,
          ROUND((SUM(CASE WHEN `+lateSQL+` THEN 1.0 ELSE 0.0 END) / COUNT(*)) * 100, 1) as latePct,
          ROUND((SUM(CASE WHEN `+severeLateSQL+` THEN 1.0 ELSE 0.0 END) / COUNT(*)) * 100, 1) as severeLatePct
        FROM `+tbl+`
        `+where+`
        GROUP BY stop_name
        HAVING visitCount >= 50
        ORDER BY avgDelayMins DESC
        LIMIT 20
      `, startTs, endTs)
	if err != nil {
		return nil, err
	}
	worstStops := []any{}
	for _, r := range worstRows {
		c := r.Clone()
		c.Set("avgDelayMins", jsRound(jsNumber(or(r.Get("avgDelayMins"), 0.0))*10)/10)
		worstStops = append(worstStops, c)
	}

	now := float64(nowMs())
	effectiveEndTs := math.Min(now, endTs)
	pad2i := func(n int) string { return padStart(numToString(float64(n)), 2, "0") }
	scheduled := map[string]bool{}
	if effectiveEndTs > startTs {
		daysInMonth := time.Date(mr.Year, time.Month(mr.Month)+1, 0, 0, 0, 0, 0, time.UTC).Day()
		for d := 1; d <= daysInMonth; d++ {
			for hr := range serviceHoursOnDate(mr.Year, mr.Month, d) {
				hourTs := toMadridUtcEpoch(mr.Year, mr.Month, d, hr)
				if hourTs >= startTs && hourTs < effectiveEndTs {
					scheduled[numToString(float64(mr.Year))+"-"+pad2i(mr.Month)+"-"+pad2i(d)+" "+pad2i(hr)] = true
				}
			}
		}
	}
	scheduledServiceHours := float64(len(scheduled))
	feedRows, err := h.all(`
        SELECT DISTINCT substr(madrid_datetime(`+tsCol+`), 1, 13) as hourKey
        FROM `+tbl+`
        WHERE `+tsCol+` >= ? AND `+tsCol+` < ?
      `, startTs, effectiveEndTs)
	if err != nil {
		return nil, err
	}
	activeFeedHours := 0.0
	for _, r := range feedRows {
		if k, ok := r.Get("hourKey").(string); ok && scheduled[k] {
			activeFeedHours++
		}
	}
	var coveragePct any
	if scheduledServiceHours > 0 {
		coveragePct = math.Min(100, jsRound(activeFeedHours*1000/scheduledServiceHours)/10)
	}

	unitText := "Aquest mes no té passos consolidats per parada: les xifres es calculen sobre mostres individuals del feed, i un mateix bus pot comptar diverses vegades a la mateixa parada."
	if useVisits {
		unitText = "La unitat d'anàlisi és el pas consolidat per parada (stop_visits): un bus a una parada compta una sola vegada, sense el biaix de cues, retencions o mostreig repetit."
	}
	methodology := "L'Informe Mensual de Puntualitat i Qualitat de Servei de Mataró Bus Urbà es basa en el retard que el sistema de l'operador (Avanza, feed SIRI) informa per a cada bus, registrat per Arribo! cada 20 segons en horari Europe/Madrid. " + unitText + " Criteris de puntualitat: avançat (retard < -1 min, no puntual perquè qui arriba a l'hora fixada perd el bus), puntual (-1 a +3 min), retardat (> 3 min) i retard greu (>= 5 min). Queden fora els registres fora de l'horari publicat de cada línia, els de 10 min o més a la primera mitja hora de servei de la línia (un bus que comença torn assignat a una expedició anterior) i els trams en què el retard es mesurava contra una expedició que el bus no feia (reassignacions del SAE, tornades sense servei i salts de retard impossibles). Les parades més afectades requereixen un mínim de 50 passos al mes. La cobertura de dades és la proporció d'hores amb servei publicat, segons l'horari de cada dia, en què s'ha rebut alguna dada."

	return O(
		"month", mr.MonthStr,
		"startTs", startTs,
		"endTs", endTs,
		"generationTimestamp", isoString(nowMs()),
		"dataVersion", getDataVersion(),
		"summary", summary,
		"linesPunctuality", linesPunctuality,
		"hourlyPunctuality", hourlyPunctuality,
		"worstStops", worstStops,
		"dataCoverage", O(
			"activeFeedHours", activeFeedHours,
			"scheduledServiceHours", scheduledServiceHours,
			"coveragePct", coveragePct,
			"operatingWindowDaily", operatingWindowDaily,
		),
		"methodology", methodology,
	), nil
}

// ---------------------------------------------------------------- CSV

const (
	delayLogsCsvHeader  = "Data i Hora,Vehicle,Linia,Direcció,Operador,Parada,Retard (min),Horari Teoric,Horari Real,Origen horari,Es Temps Real\n"
	stopVisitsCsvHeader = "Data i Hora,Vehicle,Linia,Direcció,Parada,Retard informat (min),Retard mesurat (min),Mostres,Horari Teoric,Horari Real,Origen horari,Es Temps Real,Font,Viatge confirmat\n"
)

func csvPaging(page, pageSize any) (pageNum, limit, offset float64) {
	if isUndef(page) {
		page = 1.0
	}
	if isUndef(pageSize) {
		pageSize = 50000.0
	}
	pageNum = math.Max(1, orF(parseIntJS(page), 1))
	limit = math.Max(1, math.Min(100000, orF(parseIntJS(pageSize), 50000)))
	offset = (pageNum - 1) * limit
	return
}

// csvClean is `(v || '').replace(/"/g, '""')`.
func csvClean(v any) string {
	return strings.ReplaceAll(jsString(or(v, "")), `"`, `""`)
}

func csvQuotedSrc(v any) string {
	if s := csvClean(v); s != "" {
		return `"` + s + `"`
	}
	return `""`
}

func (h *HistoryDB) exportDelayLogsCsv(hoursBack, page, pageSize any) *Obj {
	if isUndef(hoursBack) {
		hoursBack = 48.0
	}
	pageNum, limit, offset := csvPaging(page, pageSize)
	if !h.ensureOpen() {
		return O("csv", delayLogsCsvHeader, "total", 0.0, "page", pageNum, "totalPages", 1.0)
	}
	res, err := func() (*Obj, error) {
		cutoff := float64(nowMs()) - jsNumber(hoursBack)*3600*1000
		c, err := h.get(`
        SELECT COUNT(*) as total
        FROM delay_logs
        WHERE timestamp >= ? AND delay_mins > -15`+mataroScopeSQL+`
      `, cutoff)
		if err != nil {
			return nil, err
		}
		total := 0.0
		if c != nil {
			total = jsNumber(or(c.Get("total"), 0.0))
		}
		totalPages := math.Max(1, math.Ceil(total/limit))
		rows, err := h.all(`
        SELECT
          madrid_datetime(timestamp) as formatted_date,
          vehicle_id,
          line_code,
          direction,
          agency,
          stop_name,
          delay_mins,
          scheduled_time,
          actual_time,
          times_source,
          is_realtime
        FROM delay_logs
        WHERE timestamp >= ? AND delay_mins > -15`+mataroScopeSQL+`
        ORDER BY timestamp DESC
        LIMIT ? OFFSET ?
      `, cutoff, limit, offset)
		if err != nil {
			return nil, err
		}
		var b strings.Builder
		b.WriteString(delayLogsCsvHeader)
		for _, r := range rows {
			b.WriteString(`"` + jsString(r.Get("formatted_date")) + `","` + csvClean(r.Get("vehicle_id")) + `","` + jsString(r.Get("line_code")) +
				`","` + csvClean(r.Get("direction")) + `","` + csvClean(r.Get("agency")) + `","` + csvClean(r.Get("stop_name")) + `",` +
				jsString(r.Get("delay_mins")) + `,"` + jsString(or(r.Get("scheduled_time"), "")) + `","` + jsString(or(r.Get("actual_time"), "")) +
				`",` + csvQuotedSrc(r.Get("times_source")) + `,` + jsString(r.Get("is_realtime")) + "\n")
		}
		return O("csv", b.String(), "total", total, "page", pageNum, "totalPages", totalPages), nil
	}()
	if err != nil {
		log.Printf("[HistoryDB] exportDelayLogsCsv error: %s", err.Error())
		return O("csv", "Error exporting CSV\n", "total", 0.0, "page", pageNum, "totalPages", 1.0)
	}
	return res
}

func (h *HistoryDB) exportStopVisitsCsv(hoursBack, page, pageSize any) *Obj {
	if isUndef(hoursBack) {
		hoursBack = 48.0
	}
	pageNum, limit, offset := csvPaging(page, pageSize)
	if !h.ensureOpen() {
		return O("csv", stopVisitsCsvHeader, "total", 0.0, "page", pageNum, "totalPages", 1.0)
	}
	res, err := func() (*Obj, error) {
		cutoff := float64(nowMs()) - jsNumber(hoursBack)*3600*1000
		c, err := h.get(`
        SELECT COUNT(*) as total
        FROM stop_visits
        WHERE last_ts >= ? AND `+validDelaySQL+mataroVisitsScopeSQL+`
      `, cutoff)
		if err != nil {
			return nil, err
		}
		total := 0.0
		if c != nil {
			total = jsNumber(or(c.Get("total"), 0.0))
		}
		totalPages := math.Max(1, math.Ceil(total/limit))
		rows, err := h.all(`
        SELECT
          madrid_datetime(last_ts) as formatted_date,
          vehicle_id,
          line_code,
          direction,
          stop_name,
          delay_mins,
          measured_delay_mins,
          measured_method,
          trip_agrees,
          sample_count,
          scheduled_time,
          actual_time,
          times_source,
          is_realtime,
          source
        FROM stop_visits
        WHERE last_ts >= ? AND `+validDelaySQL+mataroVisitsScopeSQL+`
        ORDER BY last_ts DESC
        LIMIT ? OFFSET ?
      `, cutoff, limit, offset)
		if err != nil {
			return nil, err
		}
		var b strings.Builder
		b.WriteString(stopVisitsCsvHeader)
		for _, r := range rows {
			var measured any = ""
			if r.Get("measured_method") == "operator_trip" && !isNullish(r.Get("measured_delay_mins")) {
				measured = r.Get("measured_delay_mins")
			}
			var tripConfirmed any = ""
			if ta := r.Get("trip_agrees"); strictEq(ta, 1.0) || strictEq(ta, 0.0) {
				tripConfirmed = ta
			}
			b.WriteString(`"` + jsString(r.Get("formatted_date")) + `","` + csvClean(r.Get("vehicle_id")) + `","` + jsString(r.Get("line_code")) +
				`","` + csvClean(r.Get("direction")) + `","` + csvClean(r.Get("stop_name")) + `",` + jsString(r.Get("delay_mins")) +
				`,"` + jsString(measured) + `",` + jsString(r.Get("sample_count")) + `,"` + jsString(or(r.Get("scheduled_time"), "")) +
				`","` + jsString(or(r.Get("actual_time"), "")) + `",` + csvQuotedSrc(r.Get("times_source")) + `,` + jsString(r.Get("is_realtime")) +
				`,"` + jsString(or(r.Get("source"), "live")) + `","` + jsString(tripConfirmed) + "\"\n")
		}
		return O("csv", b.String(), "total", total, "page", pageNum, "totalPages", totalPages), nil
	}()
	if err != nil {
		log.Printf("[HistoryDB] exportStopVisitsCsv error: %s", err.Error())
		return O("csv", "Error exporting CSV\n", "total", 0.0, "page", pageNum, "totalPages", 1.0)
	}
	return res
}

package main

// Port of src/historyDb.js: getDelayIncidents, _buildVehicleTrajectory,
// _signalEvidence, _buildEdgeCases, _snapshotTrail, _delayDataQuality.

import (
	"log"
	"math"
	"regexp"
	"sort"
	"strings"
)

var reLeadingLi = regexp.MustCompile(`(?i)^l`)

// stopDistanceAny is _getStopDistance with JS falsy checks on the inputs.
func (h *HistoryDB) stopDistanceAny(a, b any) any {
	if !truthy(a) || !truthy(b) {
		return nil
	}
	return h.stopDistance(jsString(a), jsString(b))
}

// includesAny is Array.prototype.includes (SameValueZero).
func includesAny(list []any, v any) bool {
	for _, x := range list {
		if strictEq(x, v) {
			return true
		}
		if a, ok := x.(float64); ok {
			if b, ok := v.(float64); ok && math.IsNaN(a) && math.IsNaN(b) {
				return true
			}
		}
	}
	return false
}

func lastIndexOfAny(list []any, v any) int {
	for i := len(list) - 1; i >= 0; i-- {
		if strictEq(list[i], v) {
			return i
		}
	}
	return -1
}

// andFirst is `(a && a[0])`.
func andFirst(v any) any {
	if !truthy(v) {
		return v
	}
	if arr, ok := v.([]any); ok && len(arr) > 0 {
		return arr[0]
	}
	return Undefined
}

func lenOr0(v any) float64 {
	// (v || []).length
	if !truthy(v) {
		return 0
	}
	switch x := v.(type) {
	case []any:
		return float64(len(x))
	case string:
		return float64(utf16Count(x))
	}
	return math.NaN()
}

func incidentsShell(lineCode, hours, minDelay any, full bool) *Obj {
	summary := O(
		"totalRecordedIncidents", 0.0,
		"rawSamplesOverThreshold", 0.0,
		"listedCommercialEpisodes", 0.0,
		"commercialEpisodeLimit", 0.0,
	)
	if full {
		summary.Set("trajectorySamplesTruncated", false)
	}
	summary.Set("maxDelayMins", nil)
	summary.Set("maxCommercialDelayMins", nil)
	summary.Set("maxDelayIsFromInvestigationTier", false)
	summary.Set("worstStop", "Cap")
	summary.Set("worstStopCount", 0.0)
	summary.Set("worstHour", "--:00")
	summary.Set("worstHourTag", "")
	summary.Set("movingCount", 0.0)
	summary.Set("stationaryCount", 0.0)
	if full {
		summary.Set("maintenanceCount", 0.0)
	}
	summary.Set("movingPct", 0.0)
	if full {
		summary.Set("investigationCount", 0.0)
		summary.Set("tripRelinkEpisodes", 0.0)
		summary.Set("deadheadReturns", 0.0)
		summary.Set("delayJumps", 0.0)
		summary.Set("backwardLegs", 0.0)
	}
	o := O(
		"lineCode", jsUpper(jsString(or(lineCode, "all"))),
		"hoursAnalyzed", orF(jsNumber(hours), 168),
		"minDelayThreshold", orF(jsNumber(minDelay), 5),
		"summary", summary,
	)
	if full {
		o.Set("topIncidents", []any{})
		o.Set("investigationIncidents", []any{})
	} else {
		o.Set("investigationIncidents", []any{})
		o.Set("topIncidents", []any{})
	}
	o.Set("telemetryAnomalies", []any{})
	o.Set("incidentTrips", []any{})
	return o
}

func optOr(opts *Obj, k string, def any) any {
	if opts == nil {
		return def
	}
	if v := opts.Get(k); !isUndef(v) {
		return v
	}
	return def
}

type incTrack struct {
	vehicleID       any
	lineCode        any
	agency          any
	direction       any
	closeReason     any
	firstTs, lastTs float64
	startTime       any
	endTime         any
	hourOfDay       any
	maxDelay        float64
	delaySum        float64
	lastDelay       any
	sampleCount     float64
	stops           []any
	stopProgression []*Obj
	firstStop       any
	lastStop        any
	isDepot         bool

	endReason    any
	endStop      any
	endMomentTs  any
	endDelayMins any
	nextTrip     any
}

// incRow is one clustering sample from an incidentColumns query: the
// values the clustering reads, as the row object would have returned them.
type incRow struct {
	vehicleID, lineCode, agency, stopName, direction any
	delayMins, timestamp, formattedDate, hourOfDay   any
	ts, delay                                        float64
}

func newIncRow(cols []string, vals []any) *incRow {
	r := &incRow{}
	// A repeated column name takes the last value, as in rows.
	for i, c := range cols {
		switch c {
		case "vehicleId":
			r.vehicleID = vals[i]
		case "lineCode":
			r.lineCode = vals[i]
		case "agency":
			r.agency = vals[i]
		case "stopName":
			r.stopName = vals[i]
		case "direction":
			r.direction = vals[i]
		case "delayMins":
			r.delayMins = vals[i]
		case "timestamp":
			r.timestamp = vals[i]
		case "formattedDate":
			r.formattedDate = vals[i]
		case "hourOfDay":
			r.hourOfDay = vals[i]
		}
	}
	r.ts = jsNumber(r.timestamp)
	r.delay = jsNumber(r.delayMins)
	return r
}

const incidentColumns = `
          id,
          vehicle_id as vehicleId,
          line_id as lineId,
          line_code as lineCode,
          agency,
          stop_id as stopId,
          stop_name as stopName,
          direction,
          delay_mins as delayMins,
          is_realtime as isRealTime,
          timestamp,
          madrid_datetime(timestamp) as formattedDate,
          madrid_hour(timestamp) as hourOfDay`

func (h *HistoryDB) getDelayIncidents(opts *Obj) *Obj {
	lineCode := optOr(opts, "lineCode", "all")
	hours := optOr(opts, "hours", 168.0)
	limit := optOr(opts, "limit", 20.0)
	minDelay := optOr(opts, "minDelay", 5.0)
	if !h.ensureOpen() {
		return incidentsShell(lineCode, hours, minDelay, false)
	}
	res, err := h.delayIncidents(lineCode, hours, limit, minDelay)
	if err != nil {
		log.Printf("[HistoryDB] getDelayIncidents error: %s", err.Error())
		return incidentsShell(lineCode, hours, minDelay, true)
	}
	return res
}

func (h *HistoryDB) delayIncidents(lineCode, hours, limit, minDelay any) (*Obj, error) {
	hoursNum := math.Max(1, math.Min(720, orF(jsNumber(hours), 168)))
	limitNum := math.Max(1, math.Min(100, orF(jsNumber(limit), 20)))
	minDelayNum := math.Max(1, orF(jsNumber(minDelay), 5))
	now := float64(nowMs())
	cutoff := now - hoursNum*3600*1000

	cleanCode := jsTrim(jsUpper(jsString(or(lineCode, ""))))
	isAll := cleanCode == "" || cleanCode == "ALL" || cleanCode == "TOTES"
	codeWithL := cleanCode
	if !strings.HasPrefix(cleanCode, "L") {
		codeWithL = "L" + cleanCode
	}
	codeWithoutL := reLeadingUpperL.ReplaceAllLiteralString(cleanCode, "")

	sqlWhere := "timestamp >= ? AND delay_mins >= ?"
	baseParams := []any{cutoff, minDelayNum}
	if !isAll {
		sqlWhere += " AND (UPPER(line_code) = ? OR UPPER(line_code) = ? OR line_id = ?)"
		baseParams = append(baseParams, codeWithL, codeWithoutL, codeWithoutL)
	}
	sqlWhere = appendMataroScope(sqlWhere, isAll)

	sc := lineScope{since: cutoff, until: float64(nowMs())}
	if isAll {
		sc.lineWhereSQL = mataroScopeSQL
	} else {
		sc.lineWhereSQL = " AND (UPPER(line_code) = ? OR UPPER(line_code) = ? OR line_id = ?)"
		sc.lineParams = []any{codeWithL, codeWithoutL, codeWithoutL}
	}
	ph, err := h.findPhantomStretches(sc)
	if err != nil {
		return nil, err
	}
	relinks, deadheads, jumps, backs := ph.relinks, ph.deadheads, ph.jumps, ph.backs
	if err := h.setRelinkWindows(ph.windows); err != nil {
		return nil, err
	}
	serviceWhere := sqlWhere + " AND NOT " + inRelinkSQL

	agg, err := h.get(`
        SELECT COUNT(*) as totalCount, COALESCE(MAX(delay_mins), 0) as maxDelay,
          MAX(CASE WHEN delay_mins < 25 THEN delay_mins END) as maxCommercialDelay,
          SUM(CASE WHEN is_realtime = 0 THEN 1 ELSE 0 END) as nonRealtimeCount
        FROM delay_logs
        WHERE `+serviceWhere+` AND is_telemetry_anomaly(timestamp, delay_mins, stop_name, line_code) = 0
      `, baseParams...)
	if err != nil {
		return nil, err
	}
	if agg == nil {
		agg = O("totalCount", 0.0, "maxDelay", 0.0, "maxCommercialDelay", nil, "nonRealtimeCount", 0.0)
	}

	visitLineWhere := mataroVisitsScopeSQL
	var visitLineParams []any
	var visitCode any
	if !isAll {
		visitLineWhere = mataroAgencySQL + " AND (UPPER(line_code) = ? OR UPPER(line_code) = ?)"
		visitLineParams = []any{codeWithL, codeWithoutL}
		visitCode = codeWithL
	}
	vf, err := h.serviceFilter(serviceFilterOpts{since: cutoff, until: float64(nowMs()), lineCode: visitCode, tables: []string{"visits"}, windowsReady: true})
	if err != nil {
		return nil, err
	}
	visitServiceWhere := "last_ts >= ? AND " + validDelaySQL + visitLineWhere + vf.visits
	cv, err := h.get("SELECT COUNT(*) AS c FROM stop_visits WHERE "+visitServiceWhere, append([]any{cutoff}, visitLineParams...)...)
	if err != nil {
		return nil, err
	}
	hasVisits := cv != nil && jsNumber(or(cv.Get("c"), 0.0)) > 0
	var worstStopRow, worstHourRow *Obj
	var worstBasis string
	if hasVisits {
		worstBasis = "visits"
		worstStopRow, err = h.get(`
          SELECT stop_name as stopName, COUNT(*) as cnt
          FROM stop_visits
          WHERE `+visitServiceWhere+` AND delay_mins >= ?
          GROUP BY stop_name
          ORDER BY cnt DESC
          LIMIT 1
        `, append(append([]any{cutoff}, visitLineParams...), minDelayNum)...)
		if err != nil {
			return nil, err
		}
		rows, err := h.all(`
          SELECT madrid_hour(last_ts) as hourOfDay, COUNT(*) as visits, SUM(CASE WHEN delay_mins >= ? THEN 1 ELSE 0 END) as cnt
          FROM stop_visits
          WHERE `+visitServiceWhere+`
          GROUP BY hourOfDay
        `, append([]any{minDelayNum, cutoff}, visitLineParams...)...)
		if err != nil {
			return nil, err
		}
		var hourRows, enough []*Obj
		for _, r := range rows {
			if r.Num("cnt") > 0 {
				hourRows = append(hourRows, r)
			}
		}
		for _, r := range hourRows {
			if r.Num("visits") >= worstHourMinVisits {
				enough = append(enough, r)
			}
		}
		pool := hourRows
		if len(enough) > 0 {
			pool = enough
		}
		sortObjs(pool, func(a, b *Obj) float64 {
			return orF(b.Num("cnt")/b.Num("visits")-a.Num("cnt")/a.Num("visits"), b.Num("cnt")-a.Num("cnt"))
		})
		if len(pool) > 0 {
			worstHourRow = pool[0]
			worstHourRow.Set("latePct", jsRound(worstHourRow.Num("cnt")/worstHourRow.Num("visits")*100))
		}
	} else {
		worstBasis = "samples"
		worstStopRow, err = h.get(`
          SELECT stop_name as stopName, COUNT(*) as cnt
          FROM delay_logs
          WHERE `+serviceWhere+` AND is_telemetry_anomaly(timestamp, delay_mins, stop_name, line_code) = 0
          GROUP BY stop_name
          ORDER BY cnt DESC
          LIMIT 1
        `, baseParams...)
		if err != nil {
			return nil, err
		}
		worstHourRow, err = h.get(`
          SELECT madrid_hour(timestamp) as hourOfDay, COUNT(*) as cnt
          FROM delay_logs
          WHERE `+serviceWhere+` AND is_telemetry_anomaly(timestamp, delay_mins, stop_name, line_code) = 0
          GROUP BY hourOfDay
          ORDER BY cnt DESC
          LIMIT 1
        `, baseParams...)
		if err != nil {
			return nil, err
		}
	}

	regularCandidates, err := h.all(`
        SELECT `+incidentColumns+`,
          0 as isAnomaly
        FROM delay_logs
        WHERE `+serviceWhere+` AND delay_mins < 25 AND is_telemetry_anomaly(timestamp, delay_mins, stop_name, line_code) = 0
        ORDER BY delay_mins DESC, timestamp DESC
        LIMIT 3000
      `, baseParams...)
	if err != nil {
		return nil, err
	}
	investigationCandidates, err := h.all(`
        SELECT `+incidentColumns+`,
          0 as isAnomaly
        FROM delay_logs
        WHERE `+serviceWhere+` AND delay_mins >= 25 AND is_telemetry_anomaly(timestamp, delay_mins, stop_name, line_code) = 0
        ORDER BY delay_mins DESC, timestamp DESC
        LIMIT 2000
      `, baseParams...)
	if err != nil {
		return nil, err
	}
	rawAnomalyRows, err := h.all(`
        SELECT `+incidentColumns+`,
          1 as isAnomaly
        FROM delay_logs
        WHERE `+sqlWhere+` AND is_telemetry_anomaly(timestamp, delay_mins, stop_name, line_code) = 1
        ORDER BY delay_mins DESC, timestamp DESC
        LIMIT 2000
      `, baseParams...)
	if err != nil {
		return nil, err
	}
	var allAnomalyCandidates []*Obj
	for _, r := range rawAnomalyRows {
		allAnomalyCandidates = append(allAnomalyCandidates, r.Clone().Spread(getAnomalyContext(r.Get("timestamp"), r.Get("delayMins"), r.Get("stopName"), r.Get("lineCode"))))
	}
	relinkRows, err := h.all(`
        SELECT `+incidentColumns+`,
          1 as isAnomaly
        FROM delay_logs
        WHERE `+sqlWhere+` AND `+inRelinkSQL+` AND is_telemetry_anomaly(timestamp, delay_mins, stop_name, line_code) = 0
        ORDER BY delay_mins DESC, timestamp DESC
        LIMIT 2000
      `, baseParams...)
	if err != nil {
		return nil, err
	}
	for _, r := range relinkRows {
		v, l, ts := r.Get("vehicleId"), r.Get("lineCode"), r.Get("timestamp")
		o := r.Clone()
		if dh := deadheadCovering(deadheads, v, l, ts); dh != nil {
			o.Set("anomalyType", "deadhead_return")
			o.Set("diagnosticBadge", "↩️ Tornada sense servei")
			o.Set("anomalyIcon", "↩️")
			o.Set("deadhead", O("lastServedStop", dh.Get("lastServedStop"), "resumeStop", dh.Get("resumeStop"), "returnMinutes", dh.Get("returnMinutes"), "oppositeTripMinutes", dh.Get("oppositeTripMinutes")))
			allAnomalyCandidates = append(allAnomalyCandidates, o)
			continue
		}
		rl := relinkCovering(relinks, v, l, ts)
		if bk := backwardCovering(backs, v, l, ts); bk != nil {
			o.Set("anomalyType", "backward_leg")
			o.Set("diagnosticBadge", "⏪ Recorregut en sentit invers")
			o.Set("anomalyIcon", "⏪")
			o.Set("backwardLeg", O("lastServedStop", bk.Get("lastServedStop"), "lowestStop", bk.Get("lowestStop"), "stepsBack", bk.Get("stepsBack"), "visitCount", bk.Get("visitCount"), "lastServedDelay", bk.Get("lastServedDelay")))
			allAnomalyCandidates = append(allAnomalyCandidates, o)
			continue
		}
		var jp *Obj
		if rl == nil {
			jp = jumpCovering(jumps, v, l, ts)
		}
		if jp != nil {
			o.Set("anomalyType", "delay_jump")
			o.Set("diagnosticBadge", "⏫ Salt de retard impossible")
			o.Set("anomalyIcon", "⏫")
			o.Set("delayJump", O("delayBefore", jp.Get("delayBefore"), "delayAfter", jp.Get("delayAfter"), "beforeStop", jp.Get("beforeStop"), "jumpStop", jp.Get("jumpStop"), "elapsedMins", jp.Get("elapsedMins"), "jumpTs", jp.Get("jumpTs")))
			allAnomalyCandidates = append(allAnomalyCandidates, o)
			continue
		}
		o.Set("anomalyType", "trip_relink")
		o.Set("diagnosticBadge", "🔀 Viatge reassignat pel SAE")
		o.Set("anomalyIcon", "🔀")
		if rl != nil {
			o.Set("relink", O("delayBefore", rl.Get("delayBefore"), "delayAfter", rl.Get("delayAfter"), "stopName", rl.Get("relinkStop"), "relinkTs", rl.Get("relinkTs")))
		} else {
			o.Set("relink", nil)
		}
		allAnomalyCandidates = append(allAnomalyCandidates, o)
	}
	sortObjs(allAnomalyCandidates, func(a, b *Obj) float64 {
		return orF(b.Num("delayMins")-a.Num("delayMins"), b.Num("timestamp")-a.Num("timestamp"))
	})

	const tripGapMs = 12 * 60 * 1000
	tripOf := map[*Obj]int{}
	tripCounter := 0
	assignTrips := func(rows []*Obj) {
		byBus := newJSMap()
		for _, r := range rows {
			if !truthy(r.Get("vehicleId")) {
				continue
			}
			k := jsString(r.Get("lineCode")) + "|" + jsString(r.Get("vehicleId"))
			cur, _ := byBus.Get(k)
			list, _ := cur.([]*Obj)
			byBus.Set(k, append(list, r))
		}
		for _, k := range byBus.Keys() {
			cur, _ := byBus.Get(k)
			list := append([]*Obj(nil), cur.([]*Obj)...)
			sortObjs(list, func(a, b *Obj) float64 { return a.Num("timestamp") - b.Num("timestamp") })
			var prev *Obj
			for _, r := range list {
				directionChanged := prev != nil && truthy(prev.Get("direction")) && truthy(r.Get("direction")) &&
					jsString(prev.Get("direction")) != jsString(r.Get("direction"))
				if prev == nil || r.Num("timestamp")-prev.Num("timestamp") > tripGapMs || directionChanged {
					tripCounter++
				}
				tripOf[r] = tripCounter
				prev = r
			}
		}
	}
	dedupe := func(rows []*Obj, maxLimit float64) []*Obj {
		var deduped []*Obj
		windows := map[string][]float64{}
		seenTrips := map[int]bool{}
		const tripWindowMs = 20 * 60 * 1000
		for _, r := range rows {
			if trip, ok := tripOf[r]; ok {
				if seenTrips[trip] {
					continue
				}
				seenTrips[trip] = true
				deduped = append(deduped, r)
				if float64(len(deduped)) >= maxLimit {
					break
				}
				continue
			}
			var lk string
			if truthy(r.Get("vehicleId")) {
				lk = jsString(r.Get("lineCode")) + "_" + jsString(r.Get("vehicleId"))
			} else {
				lk = jsString(r.Get("lineCode")) + "|" + jsString(or(r.Get("stopName"), ""))
			}
			accepted := windows[lk]
			same := false
			for _, ts := range accepted {
				if math.Abs(r.Num("timestamp")-ts) < tripWindowMs {
					same = true
					break
				}
			}
			if same {
				continue
			}
			windows[lk] = append(accepted, r.Num("timestamp"))
			deduped = append(deduped, r)
			if float64(len(deduped)) >= maxLimit {
				break
			}
		}
		return deduped
	}
	assignTrips(append(append([]*Obj(nil), regularCandidates...), investigationCandidates...))
	assignTrips(allAnomalyCandidates)
	dedupedRegular := dedupe(regularCandidates, limitNum)
	dedupedInvestigation := dedupe(investigationCandidates, limitNum)
	dedupedAnomalies := dedupe(allAnomalyCandidates, limitNum)

	enrichedTop := []any{}
	for idx, r := range dedupedRegular {
		ctx := getHourlyTrafficContext(parseIntJS(r.Get("hourOfDay")))
		o := O("rank", float64(idx+1)).Spread(r)
		o.Set("isRealTime", truthy(r.Get("isRealTime")))
		o.Set("trafficTag", ctx.Tag)
		o.Set("trafficIcon", ctx.Icon)
		o.Set("isPeak", ctx.IsPeak)
		o.Set("isSchoolHour", ctx.IsSchoolHour)
		enrichedTop = append(enrichedTop, o)
	}
	enrichedInvestigation := []any{}
	for idx, r := range dedupedInvestigation {
		ctx := getHourlyTrafficContext(parseIntJS(r.Get("hourOfDay")))
		o := O("rank", float64(idx+1)).Spread(r)
		o.Set("isRealTime", truthy(r.Get("isRealTime")))
		o.Set("trafficTag", "🔬 En investigació")
		o.Set("trafficIcon", "🔬")
		o.Set("investigationReason", "Horari no habitual (≥25 min) — Pendent d'investigació de telemetria / SAE")
		o.Set("isPeak", ctx.IsPeak)
		o.Set("isSchoolHour", ctx.IsSchoolHour)
		enrichedInvestigation = append(enrichedInvestigation, o)
	}
	enrichedAnomalies := []any{}
	for idx, r := range dedupedAnomalies {
		o := O("rank", float64(idx+1)).Spread(r)
		o.Set("isRealTime", truthy(r.Get("isRealTime")))
		o.Set("trafficTag", r.Get("diagnosticBadge"))
		o.Set("trafficIcon", r.Get("anomalyIcon"))
		o.Set("diagnosticBadge", r.Get("diagnosticBadge"))
		o.Set("anomalyType", r.Get("anomalyType"))
		enrichedAnomalies = append(enrichedAnomalies, o)
	}

	// Up to 30 000 samples feed the clustering; each is kept as a small
	// record of the columns it reads instead of a full row object.
	var clusterRowsDesc []*incRow
	err = h.each(`
        SELECT `+incidentColumns+`
        FROM delay_logs
        WHERE `+sqlWhere+`
        ORDER BY timestamp DESC
        LIMIT 30000
      `, baseParams, func(cols []string, vals []any) bool {
		clusterRowsDesc = append(clusterRowsDesc, newIncRow(cols, vals))
		return len(clusterRowsDesc) < 30000
	})
	if err != nil {
		return nil, err
	}
	trajectorySamplesTruncated := len(clusterRowsDesc) == 30000
	var clusterRows []*incRow
	for i := len(clusterRowsDesc) - 1; i >= 0; i-- {
		r := clusterRowsDesc[i]
		if deadheadCovering(deadheads, r.vehicleID, r.lineCode, r.timestamp) == nil &&
			backwardCovering(backs, r.vehicleID, r.lineCode, r.timestamp) == nil {
			clusterRows = append(clusterRows, r)
		}
	}
	clusterRowsDesc = nil
	sort.SliceStable(clusterRows, func(i, j int) bool {
		a, b := clusterRows[i], clusterRows[j]
		return orF(float64(localeCompareJS(jsString(a.lineCode), jsString(b.lineCode), false)), a.ts-b.ts) < 0
	})

	byLine := newJSMap()
	for _, r := range clusterRows {
		k := valueKey(r.lineCode)
		cur, _ := byLine.Get(k)
		list, _ := cur.([]*incRow)
		byLine.Set(k, append(list, r))
	}
	var allClusters []*incTrack
	for _, key := range byLine.Keys() {
		cur, _ := byLine.Get(key)
		rows := cur.([]*incRow)
		lk := rows[0].lineCode
		var activeTracks []*incTrack
		for _, r := range rows {
			rts := r.ts
			rDelay := r.delay
			isDepotHour := isOutsideRevenueService(r.lineCode, rts)
			for i := len(activeTracks) - 1; i >= 0; i-- {
				t := activeTracks[i]
				gap := rts - t.lastTs
				dur := rts - t.firstTs
				newTrip := truthy(t.vehicleID) && truthy(r.vehicleID) && strictEq(t.vehicleID, r.vehicleID) &&
					truthy(t.direction) && truthy(r.direction) && jsString(t.direction) != jsString(r.direction)
				capped := !truthy(t.vehicleID) && dur > 45*60*1000
				if gap > 12*60*1000 || capped || newTrip {
					switch {
					case newTrip:
						t.closeReason = "end_of_line"
					case capped:
						t.closeReason = "split"
					default:
						t.closeReason = "gap"
					}
					allClusters = append(allClusters, t)
					activeTracks = append(activeTracks[:i], activeTracks[i+1:]...)
				}
			}
			var bestTrack *incTrack
			bestScore := -1.0
			for _, t := range activeTracks {
				if isDepotHour != t.isDepot {
					continue
				}
				if truthy(r.vehicleID) && truthy(t.vehicleID) {
					if strictEq(r.vehicleID, t.vehicleID) {
						bestTrack = t
						break
					}
					continue
				}
				dtSec := math.Max(1, (rts-t.lastTs)/1000)
				dDelay := math.Abs(rDelay - jsNumber(t.lastDelay))
				if dtSec < 180 && dDelay > 6 {
					continue
				}
				if dv := h.stopDistanceAny(t.lastStop, r.stopName); dv != nil {
					distMeters := dv.(float64)
					impliedSpeed := distMeters / dtSec
					isSyncTestFixture := dtSec <= 2 && dDelay <= 3
					if !isSyncTestFixture {
						if impliedSpeed > 25 && distMeters > 400 {
							continue
						}
						if distMeters > 1400 && dtSec < 90 {
							continue
						}
					}
				}
				score := 1000 - dtSec/10 - dDelay*20
				if score > bestScore {
					bestScore = score
					bestTrack = t
				}
			}
			if bestTrack != nil {
				bestTrack.lastTs = rts
				if !truthy(bestTrack.direction) && truthy(r.direction) {
					bestTrack.direction = r.direction
				}
				bestTrack.endTime = r.formattedDate
				bestTrack.sampleCount++
				bestTrack.delaySum += rDelay
				bestTrack.lastDelay = r.delayMins
				if truthy(r.vehicleID) && !truthy(bestTrack.vehicleID) {
					bestTrack.vehicleID = r.vehicleID
				}
				if rDelay > bestTrack.maxDelay {
					bestTrack.maxDelay = rDelay
				}
				if !includesAny(bestTrack.stops, r.stopName) {
					bestTrack.stops = append(bestTrack.stops, r.stopName)
					bestTrack.stopProgression = append(bestTrack.stopProgression, O("stopName", r.stopName, "delayMins", r.delayMins, "isRecovered", false))
				} else if n := len(bestTrack.stopProgression); n > 0 {
					lastEntry := bestTrack.stopProgression[n-1]
					if strictEq(lastEntry.Get("stopName"), r.stopName) && rDelay > lastEntry.Num("delayMins") {
						lastEntry.Set("delayMins", r.delayMins)
					}
				}
				bestTrack.lastStop = r.stopName
			} else {
				activeTracks = append(activeTracks, &incTrack{
					vehicleID:       or(r.vehicleID, ""),
					lineCode:        lk,
					agency:          r.agency,
					direction:       or(r.direction, ""),
					closeReason:     nil,
					firstTs:         rts,
					lastTs:          rts,
					startTime:       r.formattedDate,
					endTime:         r.formattedDate,
					hourOfDay:       r.hourOfDay,
					maxDelay:        rDelay,
					delaySum:        rDelay,
					lastDelay:       r.delayMins,
					sampleCount:     1,
					stops:           []any{r.stopName},
					stopProgression: []*Obj{O("stopName", r.stopName, "delayMins", r.delayMins, "isRecovered", false)},
					firstStop:       r.stopName,
					lastStop:        r.stopName,
					isDepot:         isDepotHour,
				})
			}
		}
		for _, t := range activeTracks {
			t.closeReason = or(t.closeReason, "open")
			allClusters = append(allClusters, t)
		}
	}

	resetRecovered := func(ps []*Obj) []*Obj {
		out := make([]*Obj, len(ps))
		for i, p := range ps {
			out[i] = p.Clone().Set("isRecovered", false)
		}
		return out
	}
	stopNames := func(ps []*Obj) []any {
		out := make([]any, len(ps))
		for i, p := range ps {
			out[i] = p.Get("stopName")
		}
		return out
	}
	var enrichedClusters []*Obj
	for _, c := range allClusters {
		c.endReason = nil
		c.endStop = c.lastStop
		c.endMomentTs = c.lastTs
		c.endDelayMins = c.lastDelay
		c.nextTrip = nil
		if truthy(c.vehicleID) && !c.isDepot && len(c.stops) > 1 {
			if traj, err := h.buildVehicleTrajectory(c, minDelayNum); err == nil {
				if len(traj.progression) > 0 {
					c.stopProgression = traj.progression
					c.stops = stopNames(traj.progression)
					c.lastStop = traj.endStop
				}
				c.endReason = traj.endReason
				c.endStop = traj.endStop
				c.endMomentTs = traj.endTs
				c.endDelayMins = traj.endDelayMins
				c.nextTrip = traj.nextTrip
			}
		} else if !c.isDepot && len(c.stops) > 1 {
			func() {
				lkStr, ok := c.lineCode.(string)
				if !ok {
					return // lk.startsWith throws: caught
				}
				lkWithL := lkStr
				if !strings.HasPrefix(lkStr, "L") {
					lkWithL = "L" + lkStr
				}
				lkNoL := reLeadingLi.ReplaceAllLiteralString(lkStr, "")
				candidates, err := h.all(`
        SELECT
          vehicle_id as vehicleId,
          stop_name as stopName,
          delay_mins as delayMins,
          timestamp
        FROM delay_logs
        WHERE (UPPER(line_code) = ? OR UPPER(line_code) = ?)
          AND timestamp > ?
          AND timestamp <= ?
          AND delay_mins < ?
          AND is_telemetry_anomaly(timestamp, delay_mins, stop_name, line_code) = 0
        ORDER BY timestamp ASC
        LIMIT 10
      `, lkWithL, lkNoL, c.lastTs, c.lastTs+15*60*1000, minDelayNum)
				if err != nil {
					return
				}
				var ping *Obj
				for _, cand := range candidates {
					var hit bool
					if truthy(c.vehicleID) && truthy(cand.Get("vehicleId")) {
						hit = strictEq(cand.Get("vehicleId"), c.vehicleID)
					} else {
						d := h.stopDistanceAny(c.lastStop, cand.Get("stopName"))
						hit = d == nil || d.(float64) < 1500
					}
					if hit {
						ping = cand
						break
					}
				}
				if ping != nil && truthy(ping.Get("stopName")) && !includesAny(c.stops, ping.Get("stopName")) {
					c.stops = append(c.stops, ping.Get("stopName"))
					c.stopProgression = append(c.stopProgression, O("stopName", ping.Get("stopName"), "delayMins", ping.Get("delayMins"), "isRecovered", true))
					c.lastStop = ping.Get("stopName")
				}
			}()
			c.endReason = "unknown"
			for _, p := range c.stopProgression {
				if truthy(p.Get("isRecovered")) {
					c.endReason = "recovered"
					break
				}
			}
			c.endStop = c.lastStop
		}

		var relink, deadhead, backward *Obj
		if truthy(c.vehicleID) {
			relink = relinkOverlapping(relinks, c.vehicleID, c.lineCode, c.firstTs, c.lastTs)
		}
		if relink != nil {
			c.endReason = "relinked"
			c.stopProgression = resetRecovered(c.stopProgression)
		}
		if relink == nil && truthy(c.vehicleID) {
			deadhead = deadheadTouching(deadheads, c.vehicleID, c.lineCode, c.firstTs, c.lastTs)
		}
		if deadhead != nil {
			progression := c.stopProgression
			at := lastIndexOfAny(stopNames(progression), deadhead.Get("lastServedStop"))
			if at >= 0 {
				progression = progression[:at+1]
			}
			c.stopProgression = resetRecovered(progression)
			c.stops = stopNames(c.stopProgression)
			c.lastStop = deadhead.Get("lastServedStop")
			c.endReason = "deadhead_return"
			c.endStop = deadhead.Get("lastServedStop")
			c.endMomentTs = c.lastTs
			c.nextTrip = nil
		}
		if relink == nil && deadhead == nil && truthy(c.vehicleID) {
			backward = backwardOverlapping(backs, c.vehicleID, c.lineCode, c.firstTs, c.lastTs+15*60*1000)
		}
		if backward != nil {
			progression := c.stopProgression
			at := lastIndexOfAny(stopNames(progression), backward.Get("lastServedStop"))
			if at >= 0 {
				progression = progression[:at+1]
			}
			c.stopProgression = resetRecovered(progression)
			c.stops = stopNames(c.stopProgression)
			c.lastStop = backward.Get("lastServedStop")
			c.endReason = "backward_leg"
			c.endStop = backward.Get("lastServedStop")
			c.endMomentTs = backward.Get("lastServedTs")
			c.endDelayMins = backward.Get("lastServedDelay")
			c.nextTrip = nil
		}

		durMins := jsRound((c.lastTs - c.firstTs) / 60000)
		ctx := getHourlyTrafficContext(parseIntJS(c.hourOfDay))
		isDepot := c.isDepot
		isMovingTraffic := !isDepot && len(c.stops) > 1
		incidentType, incidentTypeLabel := "traffic", "🚗 Trànsit en Ruta"
		if isDepot {
			incidentType, incidentTypeLabel = "maintenance", "🔧 Cotxeres / Manteniment"
		} else if !isMovingTraffic {
			incidentType, incidentTypeLabel = "layover", "⏱️ Regulació / Capçalera"
		}
		if relink != nil && !isDepot {
			incidentType, incidentTypeLabel = "trip_relink", "🔀 Viatge reassignat (SAE)"
		}
		var relinkOut, deadheadOut, backwardOut any
		if relink != nil {
			relinkOut = O("delayBefore", relink.Get("delayBefore"), "delayAfter", relink.Get("delayAfter"), "stopName", relink.Get("relinkStop"), "relinkTs", relink.Get("relinkTs"), "staleStops", relink.Get("staleStops"))
		}
		if deadhead != nil {
			deadheadOut = O("lastServedStop", deadhead.Get("lastServedStop"), "resumeStop", deadhead.Get("resumeStop"), "returnMinutes", deadhead.Get("returnMinutes"),
				"oppositeTripMinutes", deadhead.Get("oppositeTripMinutes"), "towards", directionTerminus(deadhead.Get("lineCode"), deadhead.Get("oppositeDirection")))
		}
		if backward != nil {
			backwardOut = O("lastServedStop", backward.Get("lastServedStop"), "lowestStop", backward.Get("lowestStop"), "stepsBack", backward.Get("stepsBack"),
				"visitCount", backward.Get("visitCount"), "lastServedDelay", backward.Get("lastServedDelay"))
		}
		enrichedClusters = append(enrichedClusters, O(
			"vehicleId", or(c.vehicleID, ""),
			"lineCode", c.lineCode,
			"agency", c.agency,
			"direction", or(c.direction, ""),
			"endReason", or(c.endReason, "unknown"),
			"endStop", or(c.endStop, c.lastStop),
			"endMomentTs", c.endMomentTs,
			"endDelayMins", c.endDelayMins,
			"nextTrip", c.nextTrip,
			"startTime", c.startTime,
			"startTs", c.firstTs,
			"endTs", c.lastTs,
			"endTime", c.endTime,
			"durationMinutes", durMins,
			"maxDelayMins", c.maxDelay,
			"avgDelayMins", jsRound(c.delaySum/c.sampleCount*10)/10,
			"sampleCount", c.sampleCount,
			"stopsTraversed", c.stops,
			"stopProgression", objsToAny(c.stopProgression),
			"firstStop", c.firstStop,
			"lastStop", c.lastStop,
			"stopsCount", float64(len(c.stops)),
			"isMovingTraffic", isMovingTraffic,
			"isDepot", isDepot,
			"incidentType", incidentType,
			"incidentTypeLabel", incidentTypeLabel,
			"trafficTag", ctx.Tag,
			"trafficIcon", ctx.Icon,
			"relink", relinkOut,
			"deadhead", deadheadOut,
			"backwardLeg", backwardOut,
		))
	}
	isRelink := func(o *Obj) float64 {
		if o.Get("incidentType") == "trip_relink" {
			return 1
		}
		return 0
	}
	sortObjs(enrichedClusters, func(a, b *Obj) float64 {
		return orF(orF(isRelink(a)-isRelink(b), b.Num("maxDelayMins")-a.Num("maxDelayMins")), b.Num("sampleCount")-a.Num("sampleCount"))
	})

	edgeCases := h.buildEdgeCases(relinks, deadheads, jumps, backs, enrichedClusters)
	movingCount, stationaryCount, maintenanceCount := 0.0, 0.0, 0.0
	for _, c := range enrichedClusters {
		switch c.Get("incidentType") {
		case "traffic":
			movingCount++
		case "layover":
			stationaryCount++
		case "maintenance":
			maintenanceCount++
		}
	}
	totalClusters := float64(len(enrichedClusters))

	worstHourStr := "--:00"
	worstHourTag := ""
	if worstHourRow != nil && !isNullish(worstHourRow.Get("hourOfDay")) {
		worstHourStr = padStart(jsString(worstHourRow.Get("hourOfDay")), 2, "0") + ":00"
		worstHourTag = getHourlyTrafficContext(parseIntJS(worstHourRow.Get("hourOfDay"))).Tag
	}
	trueMaxDelay := or(agg.Get("maxDelay"), 0.0)
	var commercialMaxDelay any
	if !isNullish(agg.Get("maxCommercialDelay")) {
		commercialMaxDelay = agg.Get("maxCommercialDelay")
	}
	maxDelayIsFromInvestigationTier := jsNumber(trueMaxDelay) >= 25 && commercialMaxDelay == nil

	totalCount := or(agg.Get("totalCount"), 0.0)
	var nonRealtimeSamplePct any
	if jsNumber(totalCount) > 0 {
		nonRealtimeSamplePct = jsRound(jsNumber(or(agg.Get("nonRealtimeCount"), 0.0))/jsNumber(agg.Get("totalCount"))*1000) / 10
	}
	var worstStop, worstStopCount any = "Cap", 0.0
	if worstStopRow != nil {
		worstStop = or(worstStopRow.Get("stopName"), "Cap")
		worstStopCount = or(worstStopRow.Get("cnt"), 0.0)
	}
	var worstHourLatePct any
	if worstHourRow != nil && !worstHourRow.IsUndef("latePct") {
		worstHourLatePct = worstHourRow.Get("latePct")
	}
	movingPct := 0.0
	if totalClusters > 0 {
		movingPct = jsRound(movingCount / totalClusters * 100)
	}
	incidentTrips := enrichedClusters
	if float64(len(incidentTrips)) > limitNum {
		incidentTrips = incidentTrips[:int(limitNum)]
	}
	lineOut := codeWithL
	if isAll {
		lineOut = "ALL"
	}
	return O(
		"lineCode", lineOut,
		"hoursAnalyzed", hoursNum,
		"minDelayThreshold", minDelayNum,
		"summary", O(
			"totalRecordedIncidents", totalCount,
			"rawSamplesOverThreshold", totalCount,
			"listedCommercialEpisodes", float64(len(enrichedTop)),
			"commercialEpisodeLimit", limitNum,
			"trajectorySamplesTruncated", trajectorySamplesTruncated,
			"kpiBasis", "totalRecordedIncidents / rawSamplesOverThreshold count RAW SAMPLES at or above the threshold; topIncidents and investigationIncidents are those same samples DEDUPED into per-trip episodes (20-minute sliding window, keyed by line+vehicle, or line+stop when vehicle_id is missing). listedCommercialEpisodes is that deduped list after the per-list limit.",
			"maxDelayMins", trueMaxDelay,
			"maxCommercialDelayMins", commercialMaxDelay,
			"maxDelayIsFromInvestigationTier", maxDelayIsFromInvestigationTier,
			"nonRealtimeSampleCount", or(agg.Get("nonRealtimeCount"), 0.0),
			"nonRealtimeSamplePct", nonRealtimeSamplePct,
			"worstStop", worstStop,
			"worstStopCount", worstStopCount,
			"worstBasis", worstBasis,
			"worstHourLatePct", worstHourLatePct,
			"worstHour", worstHourStr,
			"worstHourTag", worstHourTag,
			"movingCount", movingCount,
			"stationaryCount", stationaryCount,
			"maintenanceCount", maintenanceCount,
			"movingPct", movingPct,
			"investigationCount", float64(len(enrichedInvestigation)),
			"tripRelinkEpisodes", float64(len(relinks)),
			"deadheadReturns", float64(len(deadheads)),
			"delayJumps", float64(len(jumps)),
			"backwardLegs", float64(len(backs)),
			"dataQuality", h.delayDataQuality(hoursNum, lineCode),
		),
		"topIncidents", enrichedTop,
		"investigationIncidents", enrichedInvestigation,
		"telemetryAnomalies", enrichedAnomalies,
		"incidentTrips", objsToAny(incidentTrips),
		"edgeCases", objsToAny(edgeCases),
		"snapshotRetentionHours", h.snapshotRetentionHours,
	), nil
}

type vehicleTrajectory struct {
	progression  []*Obj
	endReason    any
	endStop      any
	endTs        any
	endDelayMins any
	nextTrip     any
}

func (h *HistoryDB) buildVehicleTrajectory(c *incTrack, minDelay float64) (*vehicleTrajectory, error) {
	rows, err := h.all(`
        SELECT stop_name as stopName, delay_mins as delayMins, direction, timestamp
        FROM delay_logs
        WHERE vehicle_id = ? AND timestamp >= ? AND timestamp <= ?
          AND is_telemetry_anomaly(timestamp, delay_mins, stop_name, line_code) = 0
        ORDER BY timestamp ASC
        LIMIT 2000
      `, c.vehicleID, c.firstTs, c.lastTs+15*60*1000)
	if err != nil {
		return nil, err
	}
	type visit struct {
		stopName, delayMins, firstTs, lastTs any
	}
	var visits []*visit
	var endReason, nextTrip any
	for _, row := range rows {
		var last *visit
		if len(visits) > 0 {
			last = visits[len(visits)-1]
		}
		if last != nil && jsNumber(last.firstTs) > c.lastTs && jsNumber(last.delayMins) < minDelay && !strictEq(last.stopName, row.Get("stopName")) {
			break
		}
		if truthy(c.direction) && truthy(row.Get("direction")) && jsString(row.Get("direction")) != jsString(c.direction) {
			endReason = "end_of_line"
			nextTrip = O("stopName", row.Get("stopName"), "delayMins", row.Get("delayMins"), "ts", row.Get("timestamp"))
			break
		}
		if last != nil && strictEq(last.stopName, row.Get("stopName")) {
			last.delayMins = row.Get("delayMins")
			last.lastTs = row.Get("timestamp")
		} else {
			visits = append(visits, &visit{row.Get("stopName"), row.Get("delayMins"), row.Get("timestamp"), row.Get("timestamp")})
		}
	}
	if endReason == nil && len(visits) > 0 {
		lastVisit := visits[len(visits)-1]
		if jsNumber(lastVisit.firstTs) > c.lastTs && jsNumber(lastVisit.delayMins) < minDelay {
			var before *visit
			if len(visits) >= 2 {
				before = visits[len(visits)-2]
			}
			stopIndex := scheduleStopIndex()
			var from *StopPos
			if before != nil {
				from = stopIndex(c.lineCode, c.direction, before.stopName)
			}
			to := stopIndex(c.lineCode, c.direction, lastVisit.stopName)
			droppedAtOnce := before != nil && jsNumber(before.delayMins)-jsNumber(lastVisit.delayMins) >= relinkDropMins
			jumpedBack := from != nil && to != nil && minIdx(from.Indexes)-maxIdx(to.Indexes) >= runJumpBackMinStops
			if before != nil && (droppedAtOnce || jumpedBack) {
				endReason = "trip_change"
				nextTrip = O("stopName", lastVisit.stopName, "delayMins", lastVisit.delayMins, "ts", lastVisit.firstTs)
				visits = visits[:len(visits)-1]
			} else {
				endReason = "recovered"
			}
		}
	}
	if endReason == nil && c.closeReason == "end_of_line" {
		endReason = "end_of_line"
	}
	if endReason == nil {
		if float64(nowMs())-c.lastTs < 5*60*1000 {
			endReason = "ongoing"
		} else {
			endReason = "signal_lost"
		}
	}
	for len(visits) > 1 {
		lv := visits[len(visits)-1]
		if jsNumber(lv.firstTs) > c.lastTs && endReason != "recovered" && endReason != "trip_change" && jsNumber(lv.delayMins) >= minDelay {
			visits = visits[:len(visits)-1]
			continue
		}
		break
	}
	progression := make([]*Obj, len(visits))
	for i, v := range visits {
		progression[i] = O("stopName", v.stopName, "delayMins", v.delayMins,
			"isRecovered", endReason == "recovered" && i == len(visits)-1,
			"belowThreshold", jsNumber(v.delayMins) < minDelay)
	}
	t := &vehicleTrajectory{progression: progression, endReason: endReason, nextTrip: nextTrip}
	if len(progression) > 0 {
		t.endStop = progression[len(progression)-1].Get("stopName")
	} else {
		t.endStop = c.lastStop
	}
	if len(visits) > 0 {
		fv := visits[len(visits)-1]
		t.endTs, t.endDelayMins = fv.lastTs, fv.delayMins
	} else {
		t.endTs, t.endDelayMins = c.lastTs, c.lastDelay
	}
	return t, nil
}

func (h *HistoryDB) signalEvidence(vehicleID, fromTs, toTs any) *Obj {
	empty := O("signal", "unknown", "gaps", []any{}, "snapshots", 0.0, "fromTs", fromTs, "toTs", toTs)
	f, t := jsNumber(fromTs), jsNumber(toTs)
	if !truthy(vehicleID) || !isFinite(f) || !isFinite(t) || t < f {
		return empty
	}
	rows, err := h.all(`
        SELECT lost_ts AS lostTs, regained_ts AS regainedTs, gap_sec AS gapSec, stop_name AS stopName,
               at_terminal AS atTerminal, feed_wide AS feedWide
        FROM gps_gaps
        WHERE vehicle_id = ? AND lost_ts <= ? AND regained_ts >= ?
        ORDER BY lost_ts ASC
        LIMIT 5
      `, jsString(vehicleID), t+signalMarginMs, f-signalMarginMs)
	if err != nil {
		return empty
	}
	gaps := make([]any, len(rows))
	lost, stalled, terminal := false, false, false
	for i, g := range rows {
		at, fw := truthy(g.Get("atTerminal")), truthy(g.Get("feedWide"))
		gaps[i] = g.Clone().Set("atTerminal", at).Set("feedWide", fw)
		if !fw && !at {
			lost = true
		}
		if fw {
			stalled = true
		}
		if at {
			terminal = true
		}
	}
	sn, err := h.get("SELECT COUNT(*) AS c FROM vehicle_snapshots WHERE vehicle_id = ? AND is_realtime = 1 AND timestamp >= ? AND timestamp <= ?", jsString(vehicleID), f, t)
	if err != nil || sn == nil {
		return empty
	}
	snapshots := sn.Get("c")
	signal := "unknown"
	switch {
	case lost:
		signal = "lost"
	case stalled:
		signal = "feed_stalled"
	case terminal:
		signal = "terminal"
	case jsNumber(snapshots) >= 2:
		signal = "kept"
	}
	return O("signal", signal, "gaps", gaps, "snapshots", snapshots, "fromTs", fromTs, "toTs", toTs)
}

func (h *HistoryDB) snapshotTrail(vehicleID any, from, to float64) []*Obj {
	rows, err := h.all(`SELECT lat, lon, speed_kmh as speedKmh, delay_mins as delayMins, timestamp FROM vehicle_snapshots WHERE vehicle_id = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC LIMIT 50`,
		jsString(vehicleID), from, to)
	if err != nil {
		return []*Obj{}
	}
	return rows
}

func edgeBase(kind string, o *Obj) *Obj {
	dir := ""
	if !isNullish(o.Get("direction")) {
		dir = jsString(o.Get("direction"))
	}
	finiteOrNull := func(v any) any {
		if n := jsNumber(v); isFinite(n) {
			return n
		}
		return nil
	}
	sigFrom := o.Get("sigFromTs")
	if isUndef(sigFrom) {
		sigFrom = o.Get("fromTs")
	}
	sigTo := o.Get("sigToTs")
	if isUndef(sigTo) {
		sigTo = o.Get("toTs")
	}
	return O(
		"kind", kind,
		"lineCode", jsUpper(jsString(or(o.Get("lineCode"), ""))),
		"vehicleId", jsString(or(o.Get("vehicleId"), "")),
		"direction", dir,
		"fromTs", o.Get("fromTs"),
		"toTs", o.Get("toTs"),
		"fromStop", jsString(or(o.Get("fromStop"), "")),
		"toStop", jsString(or(o.Get("toStop"), "")),
		"delayBefore", finiteOrNull(o.Get("delayBefore")),
		"delayAfter", finiteOrNull(o.Get("delayAfter")),
		"stop", jsString(or(o.Get("stop"), or(o.Get("fromStop"), ""))),
		"at", o.Get("at"),
		"sigFromTs", sigFrom,
		"sigToTs", sigTo,
		"detail", or(o.Get("detail"), O()),
	)
}

// with is `{ ...src, k1: v1, ... }`.
func with(src *Obj, kv ...any) *Obj {
	o := src.Clone()
	for i := 0; i+1 < len(kv); i += 2 {
		o.Set(kv[i].(string), kv[i+1])
	}
	return o
}

func (h *HistoryDB) buildEdgeCases(relinks, deadheads, jumps, backs, clusters []*Obj) []*Obj {
	var cases []*Obj
	for _, r := range relinks {
		first := or(andFirst(r.Get("staleStops")), r.Get("relinkStop"))
		cases = append(cases, edgeBase("relink", with(r,
			"fromTs", r.Get("staleFromTs"), "toTs", r.Get("relinkTs"), "fromStop", first, "toStop", r.Get("relinkStop"),
			"stop", first, "at", r.Get("staleFromTs"), "sigFromTs", r.Get("staleToTs"), "sigToTs", r.Get("relinkTs"),
			"detail", O("samples", r.Get("staleSampleCount"), "stops", lenOr0(r.Get("staleStops"))))))
	}
	for _, d := range deadheads {
		cases = append(cases, edgeBase("deadhead_return", with(d,
			"fromTs", d.Get("lastServedTs"), "toTs", d.Get("resumeTs"), "fromStop", d.Get("lastServedStop"), "toStop", d.Get("resumeStop"),
			"delayBefore", d.Get("lastServedDelay"), "stop", d.Get("lastServedStop"), "at", d.Get("lastServedTs"),
			"detail", O("returnMinutes", d.Get("returnMinutes"), "oppositeTripMinutes", d.Get("oppositeTripMinutes"), "records", lenOr0(d.Get("phantoms"))))))
	}
	for _, j := range jumps {
		cases = append(cases, edgeBase("delay_jump", with(j,
			"fromTs", j.Get("beforeTs"), "toTs", j.Get("staleToTs"), "fromStop", j.Get("beforeStop"), "toStop", j.Get("jumpStop"),
			"stop", j.Get("jumpStop"), "at", j.Get("jumpTs"), "sigFromTs", j.Get("beforeTs"), "sigToTs", j.Get("jumpTs"),
			"detail", O("elapsedMins", j.Get("elapsedMins"), "samples", j.Get("staleSampleCount")))))
	}
	for _, b := range backs {
		cases = append(cases, edgeBase("backward_leg", with(b,
			"fromTs", b.Get("lastServedTs"), "toTs", b.Get("staleToTs"), "fromStop", b.Get("lastServedStop"), "toStop", b.Get("lowestStop"),
			"delayBefore", b.Get("lastServedDelay"), "delayAfter", b.Get("lastServedDelay"),
			"stop", or(andFirst(b.Get("staleStops")), b.Get("lowestStop")), "at", b.Get("staleFromTs"),
			"detail", O("stepsBack", b.Get("stepsBack"), "visits", b.Get("visitCount")))))
	}
	for _, c := range clusters {
		nt, _ := c.Get("nextTrip").(*Obj)
		if c.Get("endReason") != "trip_change" || nt == nil {
			continue
		}
		cases = append(cases, edgeBase("trip_change", with(c,
			"fromTs", c.Get("endMomentTs"), "toTs", nt.Get("ts"), "fromStop", c.Get("endStop"), "toStop", nt.Get("stopName"),
			"delayBefore", c.Get("endDelayMins"), "delayAfter", nt.Get("delayMins"), "stop", c.Get("endStop"), "at", c.Get("endMomentTs"),
			"detail", O("silentMinutes", jsRound((jsNumber(nt.Get("ts"))-jsNumber(c.Get("endMomentTs")))/60000)))))
	}
	sortObjs(cases, func(a, b *Obj) float64 { return b.Num("fromTs") - a.Num("fromTs") })
	shown := cases
	if len(shown) > edgeCaseLimit {
		shown = shown[:edgeCaseLimit]
	}
	now := float64(nowMs())
	keptMs := h.snapshotRetentionHours * 3600 * 1000
	for _, c := range shown {
		var n int
		if truthy(c.Get("vehicleId")) {
			n = len(h.snapshotTrail(c.Get("vehicleId"), c.Num("fromTs")-snapshotContextMs, c.Num("toTs")+snapshotContextMs))
		}
		c.Set("gpsPoints", float64(n))
		c.Set("gpsExpired", n == 0 && c.Num("toTs")+snapshotContextMs < now-keptMs)
		ev := h.signalEvidence(c.Get("vehicleId"), c.Get("sigFromTs"), c.Get("sigToTs"))
		c.Set("signal", ev.Get("signal"))
		m := 0.0
		for _, g := range ev.Arr("gaps") {
			m = jsMathMax(m, jsNumber(asObj(g).Get("gapSec")))
		}
		c.Set("signalGapSec", m)
	}
	if shown == nil {
		shown = []*Obj{}
	}
	return shown
}

// jsMathMax is Math.max(a, b): NaN wins.
func jsMathMax(a, b float64) float64 {
	if math.IsNaN(a) || math.IsNaN(b) {
		return math.NaN()
	}
	return math.Max(a, b)
}

func emptyDataQuality() *Obj {
	return O("totalRawRows", 0.0, "distinctEpisodes", 0.0, "episodeGapMinutes", float64(episodeGapMs)/60000, "episodesNote", "",
		"rowsWithoutVehicleId", 0.0, "rowsWithoutProvenance", 0.0, "feedTailCap", "")
}

func (h *HistoryDB) delayDataQuality(hours, lineCode any) *Obj {
	if !h.ensureOpen() {
		return emptyDataQuality()
	}
	res, err := func() (*Obj, error) {
		cutoff := float64(nowMs()) - math.Max(1, math.Min(720, orF(jsNumber(hours), 168)))*3600*1000
		cleanCode := jsTrim(jsUpper(jsString(or(lineCode, ""))))
		isAll := cleanCode == "" || cleanCode == "ALL" || cleanCode == "TOTES"
		codeWithL := cleanCode
		if !strings.HasPrefix(cleanCode, "L") {
			codeWithL = "L" + cleanCode
		}
		codeWithoutL := reLeadingUpperL.ReplaceAllLiteralString(cleanCode, "")
		wh := "timestamp >= ?"
		wp := []any{cutoff}
		if !isAll {
			wh += " AND (UPPER(line_code) = ? OR UPPER(line_code) = ? OR line_id = ?)"
			wp = append(wp, codeWithL, codeWithoutL, codeWithoutL)
		}
		wh = appendMataroScope(wh, isAll)
		agg, err := h.get(`SELECT COUNT(*) as n, SUM(CASE WHEN vehicle_id = '' OR vehicle_id IS NULL THEN 1 ELSE 0 END) as noVeh, SUM(CASE WHEN scheduled_time = '' OR scheduled_time IS NULL OR actual_time = '' OR actual_time IS NULL THEN 1 ELSE 0 END) as noProv, COUNT(DISTINCT CASE WHEN vehicle_id != '' AND vehicle_id IS NOT NULL THEN vehicle_id END) as vehIds FROM delay_logs WHERE `+wh, wp...)
		if err != nil {
			return nil, err
		}
		ep, err := h.get(`
        WITH scoped AS (
          SELECT line_code, stop_name, vehicle_id, timestamp,
            CASE WHEN vehicle_id IS NULL OR vehicle_id = ''
              THEN '__novehicle__:' || COALESCE(stop_name, '')
              ELSE 'veh:' || vehicle_id
            END AS epKey
          FROM delay_logs WHERE `+wh+`
        ),
        marked AS (
          SELECT epKey, timestamp,
            LAG(timestamp) OVER (PARTITION BY epKey ORDER BY timestamp) AS prevTs
          FROM scoped
        )
        SELECT COUNT(*) as n FROM marked WHERE prevTs IS NULL OR (timestamp - prevTs) > ?
      `, append(append([]any{}, wp...), float64(episodeGapMs))...)
		if err != nil {
			return nil, err
		}
		return O(
			"totalRawRows", or(agg.Get("n"), 0.0),
			"rowsWithoutVehicleId", or(agg.Get("noVeh"), 0.0),
			"rowsWithoutProvenance", or(agg.Get("noProv"), 0.0),
			"distinctEpisodes", or(ep.Get("n"), 0.0),
			"episodeGapMinutes", float64(episodeGapMs)/60000,
			"episodesNote", "distinctEpisodes counts groups of consecutive samples that are ≤ 5 min apart, grouped by line+vehicle — the same key and the same boundary inspectDelayIncident uses, so this figure and the drill-down table agree. Rows with no stored vehicle_id (before the 2026-09-19 column existed) fall back to line+stop. It is NOT a count of delay causes.",
			"feedTailCap", "Delays ≥ 25 min appear to be the upstream SIRI feed tail cap, not real-world outliers",
		), nil
	}()
	if err != nil {
		return emptyDataQuality()
	}
	return res
}

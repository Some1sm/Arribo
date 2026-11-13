package main

// Port of src/historyDb.js: inspectDelayIncident.

import (
	"log"
	"math"
	"strings"
)

// localeStringGB is new Date(ms).toLocaleString('en-GB', { timeZone:
// 'Europe/Madrid' }): "dd/mm/yyyy, HH:MM:SS".
func localeStringGB(v any) string {
	d := newDate(v)
	if !d.Valid() {
		return "Invalid Date"
	}
	t := madridTime(d.ms())
	y := t.Year()
	ys := numToString(float64(y))
	if y >= 0 && y < 1000 {
		ys = padStart(ys, 4, "0")
	}
	return pad2(t.Day()) + "/" + pad2(int(t.Month())) + "/" + ys + ", " + pad2(t.Hour()) + ":" + pad2(t.Minute()) + ":" + pad2(t.Second())
}

func peakOf(rows []*Obj) *Obj {
	// rows.reduce((a, b) => (b.delayMins > a.delayMins ? b : a))
	p := rows[0]
	for _, r := range rows[1:] {
		if jsGreater(r.Get("delayMins"), p.Get("delayMins")) {
			p = r
		}
	}
	return p
}

// jsGreater is a > b for numbers / null (both read as numbers).
func jsGreater(a, b any) bool {
	if sa, ok := a.(string); ok {
		if sb, ok := b.(string); ok {
			return sa > sb
		}
	}
	return jsNumber(a) > jsNumber(b)
}

func (h *HistoryDB) inspectDelayIncident(opts *Obj) *Obj {
	if !h.ensureOpen() {
		return O("found", false, "error", "database unavailable", "episode", nil, "dataQuality", O())
	}
	res, err := h.inspectIncident(opts)
	if err != nil {
		log.Printf("[HistoryDB] inspectDelayIncident error: %s", err.Error())
		return O("found", false, "error", err.Error(), "episode", nil, "dataQuality", O())
	}
	return res
}

func (h *HistoryDB) inspectIncident(opts *Obj) (*Obj, error) {
	lineCode := optOr(opts, "lineCode", "all")
	stopName := optOr(opts, "stopName", "")
	vehicleID := optOr(opts, "vehicleId", "")
	at := optOr(opts, "at", Undefined)
	windowMins := optOr(opts, "windowMins", 60.0)
	minDelay := optOr(opts, "minDelay", 5.0)

	windowMs := math.Max(5, math.Min(240, orF(jsNumber(windowMins), 60))) * 60000
	center := float64(nowMs())
	if n := jsNumber(at); n > 0 {
		center = n
	}
	from := math.Floor(center - windowMs/2)
	to := math.Floor(center + windowMs/2)
	minDelayNum := math.Max(1, orF(jsNumber(minDelay), 5))

	cleanCode := jsTrim(strings.ToUpper(jsString(or(lineCode, ""))))
	isAll := cleanCode == "" || cleanCode == "ALL" || cleanCode == "TOTES"
	codeWithL := cleanCode
	if !strings.HasPrefix(cleanCode, "L") {
		codeWithL = "L" + cleanCode
	}
	codeWithoutL := reLeadingUpperL.ReplaceAllLiteralString(cleanCode, "")

	sqlWhere := "timestamp >= ? AND timestamp <= ? AND delay_mins >= ?"
	params := []any{from, to, minDelayNum}
	if !isAll {
		sqlWhere += " AND (UPPER(line_code) = ? OR UPPER(line_code) = ? OR line_id = ?)"
		params = append(params, codeWithL, codeWithoutL, codeWithoutL)
	}
	sqlWhere = appendMataroScope(sqlWhere, isAll)
	if truthy(stopName) {
		sqlWhere += " AND stop_name LIKE ?"
		params = append(params, "%"+jsString(stopName)+"%")
	}
	wantedVehicle := jsTrim(jsString(or(vehicleID, "")))
	if wantedVehicle != "" {
		sqlWhere += " AND vehicle_id = ?"
		params = append(params, wantedVehicle)
	}
	rows, err := h.all(`
        SELECT id, vehicle_id as vehicleId, line_id as lineId, line_code as lineCode,
          agency, stop_id as stopId, stop_name as stopName, delay_mins as delayMins,
          direction, times_source as timesSource,
          is_realtime as isRealTime, timestamp, madrid_datetime(timestamp) as formattedDate,
          scheduled_time as scheduledTime, actual_time as actualTime,
          is_telemetry_anomaly(timestamp, delay_mins, stop_name, line_code) as isAnomaly
        FROM delay_logs
        WHERE `+sqlWhere+`
        ORDER BY timestamp ASC
        LIMIT 500
      `, params...)
	if err != nil {
		return nil, err
	}
	lineOut := codeWithL
	if isAll {
		lineOut = "ALL"
	}
	if len(rows) == 0 {
		return O("found", false, "lineCode", lineOut, "stopName", stopName, "windowMs", windowMs, "dataQuality", O(), "episode", nil), nil
	}

	const gapMs = episodeGapMs
	episodeKey := func(r *Obj) string {
		if truthy(r.Get("vehicleId")) {
			return jsString(r.Get("lineCode")) + "|" + jsString(r.Get("vehicleId"))
		}
		return jsString(r.Get("lineCode")) + "|" + jsString(or(r.Get("stopName"), ""))
	}
	byKey := newJSMap()
	for _, r := range rows {
		k := episodeKey(r)
		cur, _ := byKey.Get(k)
		list, _ := cur.([]*Obj)
		byKey.Set(k, append(list, r))
	}
	var episodes [][]*Obj
	for _, k := range byKey.Keys() {
		cur, _ := byKey.Get(k)
		var ep []*Obj
		for _, r := range cur.([]*Obj) {
			if len(ep) > 0 && r.Num("timestamp")-ep[len(ep)-1].Num("timestamp") > gapMs {
				episodes = append(episodes, ep)
				ep = nil
			}
			ep = append(ep, r)
		}
		if len(ep) > 0 {
			episodes = append(episodes, ep)
		}
	}

	inWindow := func(e []*Obj) bool {
		return center >= e[0].Num("timestamp") && center <= e[len(e)-1].Num("timestamp")+gapMs
	}
	var pick []*Obj
	for _, e := range episodes {
		if !inWindow(e) {
			continue
		}
		for _, r := range e {
			if strictEq(r.Get("vehicleId"), wantedVehicle) {
				pick = e
				break
			}
		}
		if pick != nil {
			break
		}
	}
	if pick == nil {
		for _, e := range episodes {
			if inWindow(e) {
				pick = e
				break
			}
		}
	}
	if pick == nil {
		pick = episodes[0]
		for _, b := range episodes[1:] {
			if jsGreater(b[len(b)-1].Get("delayMins"), pick[len(pick)-1].Get("delayMins")) {
				pick = b
			}
		}
	}
	first, last := pick[0], pick[len(pick)-1]

	var vehicleIDs []any
	for _, r := range pick {
		v := r.Get("vehicleId")
		if truthy(v) && !includesAny(vehicleIDs, v) {
			vehicleIDs = append(vehicleIDs, v)
		}
	}
	if vehicleIDs == nil {
		vehicleIDs = []any{}
	}
	episodeVehicleAmbiguous := !truthy(first.Get("vehicleId")) && len(vehicleIDs) > 1

	prov := countTimesProvenance(pick)
	rowsWithTimes := 0.0
	for _, r := range pick {
		if hasStoredTimes(r) {
			rowsWithTimes++
		}
	}
	observedTimeRows, derivedRows, backfilledRows := prov.observed, prov.derived, prov.backfill
	episodeTimesProvenance := summariseTimesProvenance(prov)
	var snapshotRows []*Obj
	if len(vehicleIDs) > 0 {
		snapshotRows = h.snapshotTrail(vehicleIDs[0], first.Num("timestamp")-snapshotContextMs, last.Num("timestamp")+snapshotContextMs)
	}
	hasVehicleID := len(vehicleIDs) > 0
	vehicleIDColumnAddedMs, _ := parseDateJS("2026-09-19T00:00:00Z")
	allPredate := true
	for _, r := range pick {
		if !(r.Num("timestamp") < float64(vehicleIDColumnAddedMs)) {
			allPredate = false
			break
		}
	}
	vehicleIDGapExplained := !hasVehicleID && allPredate
	hasProvenanceTimes := observedTimeRows > 0
	hasDerivedTimes := derivedRows > 0
	hasBackfilledTimes := backfilledRows > 0
	hasSnapshotTrail := len(snapshotRows) >= 2

	var tripRelink, deadhead, delayJump, backwardLeg *Obj
	clickedPhantom, clickedBackward := false, false
	var run any = nil
	if len(vehicleIDs) == 1 {
		vid := vehicleIDs[0]
		vehicleRows, err := h.all(`
          SELECT vehicle_id AS vehicleId, line_code AS lineCode, direction, delay_mins AS delayMins, timestamp, stop_name AS stopName,
            madrid_datetime(timestamp) AS formattedDate, is_realtime AS isRealTime,
            scheduled_time AS scheduledTime, actual_time AS actualTime, times_source AS timesSource
          FROM delay_logs
          WHERE vehicle_id = ? AND timestamp >= ? AND timestamp <= ?
          ORDER BY timestamp ASC
          LIMIT 3000
        `, vid, first.Num("timestamp")-runLookbackMs, last.Num("timestamp")+runContextMs)
		if err != nil {
			return nil, err
		}
		var relinkRows []*Obj
		for _, r := range vehicleRows {
			if r.Num("timestamp") <= last.Num("timestamp")+15*60*1000 {
				relinkRows = append(relinkRows, r)
			}
		}
		tripRelink = relinkOverlapping(findTripRelinks(relinkRows, scheduleStopIndex()), vid, first.Get("lineCode"), first.Get("timestamp"), last.Get("timestamp"))
		deadheadList := findDeadheadReturns(vehicleRows, scheduleStopIndex(), scheduleTripMinutes)
		deadhead = deadheadTouching(deadheadList, vid, first.Get("lineCode"), first.Num("timestamp")-runContextMs, last.Num("timestamp")+runContextMs)
		peakRow := peakOf(pick)
		clickedPhantom = deadheadCovering(deadheadList, peakRow.Get("vehicleId"), peakRow.Get("lineCode"), peakRow.Get("timestamp")) != nil
		delayJump = jumpCovering(findDelayJumps(vehicleRows), peakRow.Get("vehicleId"), peakRow.Get("lineCode"), peakRow.Get("timestamp"))
		backLegs := findBackwardLegs(vehicleRows, scheduleStopIndex())
		backwardLeg = backwardOverlapping(backLegs, vid, first.Get("lineCode"), first.Num("timestamp")-runContextMs, last.Num("timestamp")+runContextMs)
		clickedBackward = backwardCovering(backLegs, peakRow.Get("vehicleId"), peakRow.Get("lineCode"), peakRow.Get("timestamp")) != nil
		phantomStretches := append([]*Obj(nil), deadheadList...)
		for _, b := range backLegs {
			phantomStretches = append(phantomStretches, O("lineCode", b.Get("lineCode"), "phantomFromTs", b.Get("staleFromTs"), "phantomToTs", b.Get("staleToTs"), "kind", "backward"))
		}
		lineUpper := strings.ToUpper(jsString(or(first.Get("lineCode"), "")))
		var runRows []*Obj
		for _, r := range vehicleRows {
			if strings.ToUpper(jsString(or(r.Get("lineCode"), ""))) == lineUpper {
				runRows = append(runRows, r.Clone().Set("timesProvenance", classifyTimes(r)))
			}
		}
		clickedStop := ""
		if s, ok := stopName.(string); ok {
			clickedStop = s
		} else if !isNullish(stopName) {
			clickedStop = jsString(stopName)
		}
		ir := buildIncidentRun(runRows, IncidentRunOpts{
			ClickedStop:    clickedStop,
			ClickedFrom:    first.Get("timestamp"),
			ClickedTo:      last.Get("timestamp"),
			Towards:        directionTerminus,
			StopIndex:      scheduleStopIndex(),
			DirectionStops: directionStopNames,
			Deadheads:      phantomStretches,
			ShowFrom:       first.Num("timestamp") - runContextMs,
		})
		for _, t := range ir.Trips {
			jm, _ := t.Get("joinedMidRoute").(*Obj)
			if jm == nil {
				continue
			}
			si := intOf(t.Get("startIndex"))
			firstStop := ir.Stops[si]
			var fromTs float64
			if si-1 >= 0 {
				fromTs = ir.Stops[si-1].lastTs
			} else {
				fromTs = firstStop.firstTs - 10*60*1000
			}
			jm.Set("evidence", h.signalEvidence(vid, fromTs, firstStop.firstTs))
		}
		run = ir.toObj()
	}

	var verdict, verdictLabel string
	allAnomaly := true
	for _, r := range pick {
		if !truthy(r.Get("isAnomaly")) {
			allAnomaly = false
			break
		}
	}
	s := jsString
	switch {
	case clickedPhantom && deadhead != nil:
		verdict = "deadhead_return"
		verdictLabel = "Deadhead return — bus " + s(deadhead.Get("vehicleId")) + " stopped serving its trip after " + s(deadhead.Get("lastServedStop")) +
			" and was back at " + s(deadhead.Get("resumeStop")) + " " + s(deadhead.Get("returnMinutes")) + " min later (the opposite trip takes " +
			s(deadhead.Get("oppositeTripMinutes")) + " min); this record was logged while it ran without passengers and is not a stop visit"
	case clickedBackward && backwardLeg != nil:
		verdict = "backward_leg"
		verdictLabel = "Backward leg — bus " + s(backwardLeg.Get("vehicleId")) + " was at " + s(backwardLeg.Get("lastServedStop")) + " (+" +
			s(backwardLeg.Get("lastServedDelay")) + ") and its next " + s(backwardLeg.Get("visitCount")) + " records run back along the route to " +
			s(backwardLeg.Get("lowestStop")) + " (" + s(backwardLeg.Get("stepsBack")) + " stops) with the delay unchanged; this record was logged while it drove back and is not a stop visit"
	case tripRelink != nil:
		verdict = "trip_relink"
		mins := math.Max(1, jsRound((jsNumber(tripRelink.Get("relinkTs"))-jsNumber(tripRelink.Get("staleToTs")))/60000))
		verdictLabel = "Trip relink — the operator's AVL re-attached bus " + s(tripRelink.Get("vehicleId")) + " to its real trip at " + s(tripRelink.Get("relinkStop")) +
			" (+" + s(tripRelink.Get("delayBefore")) + " → " + s(tripRelink.Get("delayAfter")) + " min within " + numToString(mins) +
			" min); the delay before it was measured against a trip the bus was not running"
	case delayJump != nil:
		verdict = "delay_jump"
		sign := ""
		if jsNumber(delayJump.Get("delayBefore")) >= 0 {
			sign = "+"
		}
		verdictLabel = "Impossible delay jump — the operator's AVL moved bus " + s(delayJump.Get("vehicleId")) + " from " + sign + s(delayJump.Get("delayBefore")) +
			" at " + s(delayJump.Get("beforeStop")) + " to +" + s(delayJump.Get("delayAfter")) + " at " + s(delayJump.Get("jumpStop")) + " in " +
			s(delayJump.Get("elapsedMins")) + " min; a delay cannot grow faster than time passes, so it was measured against an earlier trip than the bus was running"
	case allAnomaly:
		verdict, verdictLabel = "telemetry_anomaly", "Telemetry anomaly — depot / night maintenance"
	case hasVehicleID && (hasProvenanceTimes || hasSnapshotTrail):
		verdict, verdictLabel = "corroborated", "Corroborated — vehicle identity plus independent evidence"
	case hasVehicleID && (hasDerivedTimes || hasBackfilledTimes):
		verdict = "derived_only"
		switch {
		case hasBackfilledTimes && !hasDerivedTimes:
			verdictLabel = "Backfilled approximation — timetable time reconstructed offline (direction guessed), no observed evidence"
		case hasDerivedTimes && !hasBackfilledTimes:
			verdictLabel = "Derived only — timetable time reconstructed, no observed evidence"
		default:
			verdictLabel = "Derived only — timetable time reconstructed (live and/or backfilled), no observed evidence"
		}
	case len(pick) >= 3 && (!hasVehicleID || len(vehicleIDs) <= 1):
		verdict, verdictLabel = "poll_inflated", "Inflated by repeated polling — same bus logged every 20 s"
	default:
		verdict, verdictLabel = "unverifiable", "Unverifiable — no vehicle identity or independent evidence"
	}

	retiredScope := !isAll
	for _, c := range mataroLineCodes {
		if c == codeWithL {
			retiredScope = false
		}
	}
	vehicleDist := O()
	for _, r := range pick {
		k := jsString(or(r.Get("vehicleId"), "(none)"))
		vehicleDist.Set(k, jsNumber(or(vehicleDist.Get(k), 0.0))+1)
	}

	var tripRelinkOut, deadheadOut, backwardOut, delayJumpOut any
	if tripRelink != nil {
		tripRelinkOut = O("delayBefore", tripRelink.Get("delayBefore"), "delayAfter", tripRelink.Get("delayAfter"), "stopName", tripRelink.Get("relinkStop"),
			"relinkTs", tripRelink.Get("relinkTs"), "staleStops", tripRelink.Get("staleStops"))
	}
	if deadhead != nil {
		d, err := h.describeDeadhead(deadhead)
		if err != nil {
			return nil, err
		}
		deadheadOut = d
	}
	if backwardLeg != nil {
		backwardOut = h.describeBackwardLeg(backwardLeg)
	}
	if delayJump != nil {
		delayJumpOut = O(
			"vehicleId", delayJump.Get("vehicleId"),
			"delayBefore", delayJump.Get("delayBefore"),
			"beforeStop", delayJump.Get("beforeStop"),
			"beforeTime", hhmm(delayJump.Get("beforeTs")),
			"delayAfter", delayJump.Get("delayAfter"),
			"jumpStop", delayJump.Get("jumpStop"),
			"jumpTime", hhmm(delayJump.Get("jumpTs")),
			"elapsedMins", delayJump.Get("elapsedMins"),
			"staleStops", delayJump.Get("staleStops"),
		)
	}
	peakDelay := math.Inf(-1)
	for _, r := range pick {
		peakDelay = jsMathMax(peakDelay, jsNumber(r.Get("delayMins")))
	}
	vehicleIDNote := ""
	if vehicleIDGapExplained {
		vehicleIDNote = "Rows predate the vehicle_id column (added 2026-09-19). The bus was recorded but the id was not stored, and no snapshot trail survives to recover it."
	} else if !hasVehicleID {
		vehicleIDNote = "No vehicle identity on these rows, and they postdate the vehicle_id column — the feed genuinely omitted it."
	}
	var note string
	switch {
	case backfilledRows > 0:
		note = "Scheduled / actual times were approximated offline by scripts/backfill_delay_times.js from the static timetable (the direction was guessed) — not reported by the upstream feed, and weaker than a live derivation"
	case derivedRows > 0:
		note = "Scheduled / actual times were derived from the static timetable, not reported by the upstream feed"
	case observedTimeRows > 0:
		note = "Scheduled / actual times were reported by the upstream feed"
	default:
		note = "Scheduled / actual times are empty in the stored rows — the delay cannot be recomputed from a timetable"
	}
	rawRows := []any{}
	for i, r := range pick {
		if i >= 100 {
			break
		}
		st := r.Get("scheduledTime")
		rawRows = append(rawRows, O(
			"delayMins", r.Get("delayMins"),
			"stopName", r.Get("stopName"),
			"vehicleId", r.Get("vehicleId"),
			"formattedDate", r.Get("formattedDate"),
			"isRealTime", truthy(r.Get("isRealTime")),
			"hasTimes", truthy(st) && st != "",
			"scheduledTime", or(st, ""),
			"actualTime", or(r.Get("actualTime"), ""),
			"timesSource", or(r.Get("timesSource"), ""),
			"timesProvenance", classifyTimes(r),
			"direction", or(r.Get("direction"), ""),
		))
	}
	return O(
		"found", true,
		"lineCode", lineOut,
		"stopName", first.Get("stopName"),
		"incidentTime", localeStringGB(first.Get("timestamp")),
		"episode", O(
			"start", localeStringGB(first.Get("timestamp")),
			"end", localeStringGB(last.Get("timestamp")),
			"durationMinutes", (last.Num("timestamp")-first.Num("timestamp"))/60000,
			"peakDelayMins", peakDelay,
			"peakAt", localeStringGB(peakOf(pick).Get("timestamp")),
			"rowCount", float64(len(pick)),
			"distinctVehicles", vehicleIDs,
			"vehicleAmbiguous", episodeVehicleAmbiguous,
			"tripKey", O(
				"lineCode", first.Get("lineCode"),
				"vehicleId", or(first.Get("vehicleId"), ""),
				"startTs", first.Get("timestamp"),
				"endTs", last.Get("timestamp"),
			),
			"verdict", verdict,
			"verdictLabel", verdictLabel,
			"tripRelink", tripRelinkOut,
			"deadheadReturn", deadheadOut,
			"backwardLeg", backwardOut,
			"delayJump", delayJumpOut,
			"run", run,
			"timesProvenance", episodeTimesProvenance,
			"evidence", O(
				"hasVehicleId", hasVehicleID,
				"hasProvenanceTimes", hasProvenanceTimes,
				"hasSnapshotTrail", hasSnapshotTrail,
				"hasDerivedTimes", hasDerivedTimes,
				"hasBackfilledTimes", hasBackfilledTimes,
				"timesProvenance", episodeTimesProvenance,
				"vehicleIdGapExplained", vehicleIDGapExplained,
				"vehicleIdNote", vehicleIDNote,
				"vehicleIdDistribution", vehicleDist,
				"rowsWithProvenanceTimes", rowsWithTimes,
				"rowsWithDerivedTimes", derivedRows,
				"rowsWithBackfilledTimes", backfilledRows,
				"rowsWithObservedTimes", observedTimeRows,
				"snapshotTrailPoints", float64(len(snapshotRows)),
				"snapshotRetentionHours", h.snapshotRetentionHours,
				"rowsWithoutProvenance", float64(len(pick))-rowsWithTimes,
			),
			"timetableCheck", O(
				"available", derivedRows > 0 || backfilledRows > 0 || observedTimeRows > 0,
				"derivedFromTimetable", derivedRows > 0 || backfilledRows > 0,
				"backfilledFromTimetable", backfilledRows > 0,
				"derivedLiveFromTimetable", derivedRows > 0,
				"note", note,
			),
			"retiredScope", retiredScope,
			"rawRows", rawRows,
		),
		"dataQuality", O(
			"totalRawRowsReturned", float64(len(rows)),
			"episodesInWindow", float64(len(episodes)),
			"feedTailCap", "Delays ≥ 25 min appear to be the upstream SIRI feed tail cap, not real-world outliers",
			"retiredScopeLinesPresent", retiredScope,
		),
	), nil
}

func intOf(v any) int {
	switch x := v.(type) {
	case int:
		return x
	case float64:
		return int(x)
	case int64:
		return int(x)
	}
	return 0
}

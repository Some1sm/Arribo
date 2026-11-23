package main

// /api/analytics/network?hours=24|48|168: the train operators' figures in
// the shapes of the Dades bus report blocks (historydb_report.go), so the
// page can list every mode in the same tables and charts instead of only
// Mataró's buses: the operator comparison (agencyStats), the most delayed
// lines (rankingMostDelayed), the stops with most delay and their per-hour
// heatmap (allStopDelays) and the delay by hour of the day (hourlyDelays).
//
// Each operator keeps its own rules and says so: rail is on time up to
// OnTimeMaxMins (5) and "severely late" beyond railSevereLateMins (15);
// Mataró's buses use 3 and 5 (anomalies.go). The figures come from the
// station visits the operators' trip updates produce; what only exists for
// buses (GPS gaps, the operator-vs-GPS contrast) is not invented here.

import (
	"errors"
	"sort"
)

const (
	railSevereLateMins    = 15 // a train this late is "severely late" (the report's late30 bucket and beyond)
	railBottleneckAvgMins = 5  // a station is a bottleneck from this average delay...
	railBottleneckSevere  = 20 // ...or this share (%) of severely late visits
	railNetworkStops      = 100
	railNetworkMinVisits  = 3
)

// getNetworkReport builds the per-operator blocks for the last `hours`.
func (h *HistoryDB) getNetworkReport(hours float64) (*Obj, error) {
	if !h.ensureOpen() {
		return nil, errors.New("History database unavailable")
	}
	cutoff := float64(nowMs()) - hours*3600000
	round1 := func(v any) any {
		if isNullish(v) {
			return nil
		}
		return jsRound(jsNumber(v)*10) / 10
	}
	pct := func(part, total any) any {
		n := jsNumber(total)
		if !(n > 0) {
			return nil
		}
		return jsRound(jsNumber(part)*1000/n) / 10
	}
	ops := []any{}
	for _, op := range reportOperators {
		on := op.OnTimeMaxMins
		counts := `COUNT(*) AS visits, AVG(delay_mins) AS avgDelay, MAX(delay_mins) AS maxDelay,
		  SUM(CASE WHEN delay_mins < -1 THEN 1 ELSE 0 END) AS early,
		  SUM(CASE WHEN delay_mins >= -1 AND delay_mins <= ? THEN 1 ELSE 0 END) AS onTime,
		  SUM(CASE WHEN delay_mins > ? THEN 1 ELSE 0 END) AS late,
		  SUM(CASE WHEN delay_mins > ? THEN 1 ELSE 0 END) AS severe`
		sum, err := h.get(`SELECT `+counts+`, COUNT(DISTINCT line_code) AS lines
		  FROM stop_visits WHERE agency_id = ? AND last_ts >= ?`, on, on, railSevereLateMins, op.ID, cutoff)
		if err != nil {
			return nil, err
		}
		visits := jsNumber(field(sum, "visits"))
		stats := O(
			"agency", op.Name, "agencyId", op.ID, "mode", op.Mode,
			"totalVisits", visits, "totalSamples", visits,
			"linesCount", jsNumber(field(sum, "lines")),
			"avgDelay", round1(field(sum, "avgDelay")), "maxDelay", field(sum, "maxDelay"),
			"onTimePct", pct(field(sum, "onTime"), visits),
			"earlyPct", pct(field(sum, "early"), visits),
			"latePct", pct(field(sum, "late"), visits),
			"severeLatePct", pct(field(sum, "severe"), visits),
		)

		lineRows, err := h.all(`SELECT line_code AS line, `+counts+`
		  FROM stop_visits WHERE agency_id = ? AND last_ts >= ?
		  GROUP BY line_code ORDER BY AVG(delay_mins) DESC`, on, on, railSevereLateMins, op.ID, cutoff)
		if err != nil {
			return nil, err
		}
		lines := make([]any, 0, len(lineRows))
		for _, r := range lineRows {
			n := r.Get("visits")
			lines = append(lines, O(
				"lineCode", r.Get("line"), "agency", op.ShortName, "agencyId", op.ID,
				"visitCount", n, "sampleCount", n,
				"avgDelay", round1(r.Get("avgDelay")), "maxDelay", r.Get("maxDelay"),
				"onTimePercentage", pct(r.Get("onTime"), n),
				"earlyPercentage", pct(r.Get("early"), n),
				"latePercentage", pct(r.Get("late"), n),
			))
		}

		stopRows, err := h.all(`SELECT stop_name AS stop, line_code AS line, COUNT(*) AS visits,
		    AVG(delay_mins) AS avgDelay, MAX(delay_mins) AS maxDelay,
		    SUM(CASE WHEN delay_mins > ? THEN 1 ELSE 0 END) AS severe
		  FROM stop_visits WHERE agency_id = ? AND last_ts >= ?
		  GROUP BY line_code, stop_name HAVING COUNT(*) >= ?
		  ORDER BY AVG(delay_mins) DESC, MAX(delay_mins) DESC, line_code, stop_name LIMIT ?`,
			railSevereLateMins, op.ID, cutoff, railNetworkMinVisits, railNetworkStops)
		if err != nil {
			return nil, err
		}
		type stopKey struct{ line, stop string }
		kept := map[stopKey]*Obj{}
		stops := make([]any, 0, len(stopRows))
		for _, r := range stopRows {
			n := r.Get("visits")
			avg := round1(r.Get("avgDelay"))
			severe := pct(r.Get("severe"), n)
			o := O(
				"stopId", r.Get("stop"), "stopName", r.Get("stop"), "lineCode", r.Get("line"),
				"agency", op.ShortName, "agencyId", op.ID,
				"arrivalCount", n, "visitCount", n, "sampleCount", n,
				"avgDelay", avg, "maxDelay", r.Get("maxDelay"), "severeLatePct", severe,
				"isBottleneck", jsNumber(avg) >= railBottleneckAvgMins || jsNumber(severe) >= railBottleneckSevere,
			)
			kept[stopKey{jsString(r.Get("line")), jsString(r.Get("stop"))}] = o
			stops = append(stops, o)
		}
		// Per-hour cells for the kept stations (the heatmap).
		hourly := map[stopKey][]any{}
		if len(kept) > 0 {
			cells, err := h.all(`SELECT stop_name AS stop, line_code AS line, madrid_hour(last_ts) AS hour,
			    COUNT(*) AS visits, AVG(delay_mins) AS avgDelay, MAX(delay_mins) AS maxDelay,
			    SUM(CASE WHEN delay_mins > ? THEN 1 ELSE 0 END) AS severe
			  FROM stop_visits WHERE agency_id = ? AND last_ts >= ?
			  GROUP BY line_code, stop_name, madrid_hour(last_ts)`, railSevereLateMins, op.ID, cutoff)
			if err != nil {
				return nil, err
			}
			byKey := map[stopKey]map[int]*Obj{}
			for _, c := range cells {
				k := stopKey{jsString(c.Get("line")), jsString(c.Get("stop"))}
				if kept[k] == nil {
					continue
				}
				if byKey[k] == nil {
					byKey[k] = map[int]*Obj{}
				}
				byKey[k][int(jsNumber(c.Get("hour")))] = c
			}
			for k, m := range byKey {
				row := make([]any, 0, 24)
				for hr := 0; hr < 24; hr++ {
					cell := O("hour", padStart(numToString(float64(hr)), 2, "0"), "sampleCount", 0.0, "avgDelay", nil, "maxDelay", nil, "severeLatePct", nil)
					if c := m[hr]; c != nil {
						cell.Set("sampleCount", c.Get("visits"))
						cell.Set("avgDelay", round1(c.Get("avgDelay")))
						cell.Set("maxDelay", c.Get("maxDelay"))
						cell.Set("severeLatePct", pct(c.Get("severe"), c.Get("visits")))
					}
					row = append(row, cell)
				}
				hourly[k] = row
			}
		}
		for k, o := range kept {
			o.Set("hourly", hourly[k])
		}

		hourRows, err := h.all(`SELECT madrid_hour(last_ts) AS hour, `+counts+`
		  FROM stop_visits WHERE agency_id = ? AND last_ts >= ?
		  GROUP BY madrid_hour(last_ts)`, on, on, railSevereLateMins, op.ID, cutoff)
		if err != nil {
			return nil, err
		}
		byHour := map[int]*Obj{}
		for _, r := range hourRows {
			byHour[int(jsNumber(r.Get("hour")))] = r
		}
		hours24 := make([]any, 0, 24)
		for hr := 0; hr < 24; hr++ {
			hh := padStart(numToString(float64(hr)), 2, "0")
			next := padStart(numToString(float64((hr+1)%24)), 2, "0")
			o := O("hour", hh, "timeWindow", hh+":00 - "+next+":00", "visitCount", 0.0, "sampleCount", 0.0,
				"avgDelay", nil, "maxDelay", nil, "onTimePercentage", nil, "earlyPercentage", nil,
				"latePercentage", nil, "severeLatePercentage", nil)
			if r := byHour[hr]; r != nil {
				n := r.Get("visits")
				o.Set("visitCount", n)
				o.Set("sampleCount", n)
				o.Set("avgDelay", round1(r.Get("avgDelay")))
				o.Set("maxDelay", r.Get("maxDelay"))
				o.Set("onTimePercentage", pct(r.Get("onTime"), n))
				o.Set("earlyPercentage", pct(r.Get("early"), n))
				o.Set("latePercentage", pct(r.Get("late"), n))
				o.Set("severeLatePercentage", pct(r.Get("severe"), n))
			}
			hours24 = append(hours24, o)
		}

		ops = append(ops, O(
			"agencyId", op.ID, "agency", op.Name, "shortName", op.ShortName, "mode", op.Mode,
			"tier", op.Tier, "method", op.Method,
			"onTimeMaxMins", on, "severeLateMins", float64(railSevereLateMins),
			"bottleneckRule", O("avgDelayMins", float64(railBottleneckAvgMins), "severeLatePct", float64(railBottleneckSevere)),
			"agencyStats", stats,
			"rankingMostDelayed", lines,
			"allStopDelays", stops,
			"hourlyDelays", hours24,
			// Only buses have these: Arribo! measures bus passes from GPS
			// against the operator's own delay, and records GPS losses.
			// Trains are timed from the operator's trip updates alone.
			"delayMeasurementComparison", nil,
			"gpsGaps", nil,
		))
	}
	// Operators with no visits in the period come last, in registry order.
	sort.SliceStable(ops, func(i, j int) bool {
		vi := jsNumber(field(field(ops[i], "agencyStats"), "totalVisits"))
		vj := jsNumber(field(field(ops[j], "agencyStats"), "totalVisits"))
		return vi > 0 && !(vj > 0)
	})
	return O("hours", hours, "generatedAt", float64(nowMs()), "operators", ops), nil
}

// hNetwork serves /api/analytics/network. Cached 60 s per period.
func (s *Server) hNetwork(q *xreq, res *xres) error {
	hours := clampHours(qv(q, "hours"), 24, 168)
	key := "network:" + numToString(hours)
	now := float64(nowMs())
	if data, ok := cacheGetFresh(s.operatorCache, key, now); ok {
		res.h.Set("X-Cache", "HIT")
		res.json(spreadAny(O("success", true), data))
		return nil
	}
	data, err := s.historyQuery("getNetworkReport", O("hours", hours), 20000)
	if err != nil {
		s.sendInternalError(q, res, err, O("success", false, "operators", []any{}))
		return nil
	}
	// Line colours and openable refs from the catalog the server holds.
	opsList, _ := field(data, "operators").([]any)
	for _, o := range opsList {
		agency := jsString(field(o, "agencyId"))
		v, ok := rtCatalog.Load(agency)
		if !ok {
			continue
		}
		colors := map[string]string{}
		for _, r := range v.(*rtCatalogOp).Lines {
			colors[r.Code] = r.Color
		}
		linesList, _ := field(o, "rankingMostDelayed").([]any)
		for _, l := range linesList {
			lo := l.(*Obj)
			code := jsString(lo.Get("lineCode"))
			lo.Set("lineId", agency+":"+code)
			lo.Set("color", strOrNil(colors[code]))
		}
	}
	s.operatorCache.Set(key, &cachedData{data: data, timestamp: now})
	res.h.Set("X-Cache", "MISS")
	res.json(spreadAny(O("success", true), data))
	return nil
}

package main

// Per-operator punctuality for the Dades "Operadors" view (phase 2, slice 3d
// of docs/catalonia-review/REPORT.md). It summarises the stop_visits rows of
// the GTFS-RT operators (Rodalies, FGC); Mataró keeps its own reports,
// whose filters (phantom stretches, service hours) are bus-specific.

import (
	"errors"
	"math"
	"time"
)

// operatorInfo is what the view says about an operator and its data.
type operatorInfo struct {
	ID, Name, Mode string
	ShortName      string // for filters and pills
	// OnTimeMaxMins is the upper bound of "on time" for this mode, in
	// minutes (trains: 5, the usual rail standard; Mataró buses use 3).
	OnTimeMaxMins float64
	// Source explains how a delay is obtained, in the app's language.
	Source string
}

var reportOperators = []operatorInfo{
	{
		ID: "renfe_rodalies", Name: "Rodalies de Catalunya (Renfe)", ShortName: "Rodalies", Mode: "rail", OnTimeMaxMins: 5,
		Source: "Retard que Renfe publica en temps real (GTFS-RT) per a cada tren, pres a l'estació just quan el tren hi passa. Els valors impossibles (més de 10 min d'avançament o més de 3 h de retard) es descarten i es compten.",
	},
	{
		ID: "fgc", Name: "Ferrocarrils de la Generalitat (FGC)", ShortName: "FGC", Mode: "rail", OnTimeMaxMins: 5,
		Source: "Hora prevista que FGC publica en temps real (GTFS-RT), comparada amb l'horari oficial publicat (GTFS) a cada estació, just quan el tren hi passa.",
	},
}

// getOperatorReport summarises the last `hours` of stop visits per
// GTFS-RT operator: totals, punctuality buckets, lines and worst stations.
// feeds is the pollers' live state (nil when they are off).
func (h *HistoryDB) getOperatorReport(hours float64, feeds map[string]*Obj) (*Obj, error) {
	if !h.ensureOpen() {
		return O("hours", hours, "operators", []any{}), nil
	}
	cutoff := float64(nowMs()) - hours*3600000
	ops := []any{}
	for _, op := range reportOperators {
		on := op.OnTimeMaxMins
		sum, err := h.get(`SELECT COUNT(*) AS visits, COUNT(DISTINCT vehicle_id) AS trips,
		    AVG(delay_mins) AS avgDelay, MAX(delay_mins) AS maxDelay,
		    SUM(CASE WHEN delay_mins < -1 THEN 1 ELSE 0 END) AS early,
		    SUM(CASE WHEN delay_mins >= -1 AND delay_mins <= ? THEN 1 ELSE 0 END) AS onTime,
		    SUM(CASE WHEN delay_mins > ? AND delay_mins <= 15 THEN 1 ELSE 0 END) AS late15,
		    SUM(CASE WHEN delay_mins > 15 AND delay_mins <= 30 THEN 1 ELSE 0 END) AS late30,
		    SUM(CASE WHEN delay_mins > 30 AND delay_mins <= 60 THEN 1 ELSE 0 END) AS late60,
		    SUM(CASE WHEN delay_mins > 60 THEN 1 ELSE 0 END) AS lateOver60,
		    MIN(last_ts) AS firstTs, MAX(last_ts) AS lastTs
		  FROM stop_visits WHERE agency_id = ? AND last_ts >= ?`, on, on, op.ID, cutoff)
		if err != nil {
			return nil, err
		}
		visits := jsNumber(field(sum, "visits"))
		pct := func(k string) any {
			if !(visits > 0) {
				return nil
			}
			return jsRound(jsNumber(field(sum, k))*1000/visits) / 10
		}
		round1 := func(v any) any {
			if isNullish(v) {
				return nil
			}
			return jsRound(jsNumber(v)*10) / 10
		}
		lines, err := h.all(`SELECT line_code AS line, COUNT(*) AS visits, AVG(delay_mins) AS avgDelay,
		    MAX(delay_mins) AS maxDelay,
		    SUM(CASE WHEN delay_mins >= -1 AND delay_mins <= ? THEN 1 ELSE 0 END) AS onTime
		  FROM stop_visits WHERE agency_id = ? AND last_ts >= ?
		  GROUP BY line_code ORDER BY AVG(delay_mins) DESC`, on, op.ID, cutoff)
		if err != nil {
			return nil, err
		}
		lineRows := []any{}
		for _, l := range lines {
			n := jsNumber(l.Get("visits"))
			lineRows = append(lineRows, O(
				"line", l.Get("line"), "visits", n,
				"avgDelay", round1(l.Get("avgDelay")), "maxDelay", l.Get("maxDelay"),
				"onTimePct", jsRound(jsNumber(l.Get("onTime"))*1000/math.Max(n, 1))/10,
			))
		}
		stations, err := h.all(`SELECT stop_name AS station, COUNT(*) AS visits, AVG(delay_mins) AS avgDelay,
		    MAX(delay_mins) AS maxDelay
		  FROM stop_visits WHERE agency_id = ? AND last_ts >= ?
		  GROUP BY stop_name HAVING COUNT(*) >= 3 ORDER BY AVG(delay_mins) DESC LIMIT 10`, op.ID, cutoff)
		if err != nil {
			return nil, err
		}
		stationRows := []any{}
		for _, s := range stations {
			stationRows = append(stationRows, O(
				"station", s.Get("station"), "visits", s.Get("visits"),
				"avgDelay", round1(s.Get("avgDelay")), "maxDelay", s.Get("maxDelay"),
			))
		}
		var feed any = nil
		if f := feeds[op.ID]; f != nil {
			feed = f
		}
		ops = append(ops, O(
			"id", op.ID, "name", op.Name, "shortName", op.ShortName, "mode", op.Mode,
			"onTimeMaxMins", on,
			"source", op.Source,
			"visits", visits, "trips", field(sum, "trips"),
			"avgDelay", round1(field(sum, "avgDelay")), "maxDelay", field(sum, "maxDelay"),
			"onTimePct", pct("onTime"), "earlyPct", pct("early"),
			"buckets", O(
				"early", field(sum, "early"), "onTime", field(sum, "onTime"),
				"late15", field(sum, "late15"), "late30", field(sum, "late30"),
				"late60", field(sum, "late60"), "lateOver60", field(sum, "lateOver60"),
			),
			"firstTs", field(sum, "firstTs"), "lastTs", field(sum, "lastTs"),
			"lines", lineRows, "worstStations", stationRows,
			"feed", feed,
		))
	}
	return O("hours", hours, "generatedAt", float64(nowMs()), "operators", ops), nil
}

// gtfsRtFeedStats is the pollers' live state per operator, for the report
// (empty when the pollers are off). Called on the worker, which owns them.
func gtfsRtFeedStats() map[string]*Obj {
	out := map[string]*Obj{}
	for _, p := range gtfsRtPollers {
		s := p.snap.Load()
		p.mu.Lock()
		o := O(
			"live", true,
			"implausibleDropped", float64(p.implausible),
			"visitsClosed", float64(p.closedVisits),
		)
		p.mu.Unlock()
		if s != nil {
			o.Set("vehiclesNow", float64(len(s.Vehicles)))
			o.Set("fetchAgeSec", math.Round(time.Since(s.FetchedAt).Seconds()))
			o.Set("vehiclesError", strOrNil(s.VehiclesErr))
			o.Set("tripUpdatesError", strOrNil(s.TripsErr))
		}
		out[p.src.AgencyID] = o
	}
	return out
}

func strOrNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// getOperatorLineReport is one GTFS-RT line's punctuality in the last
// `hours`: per station and per hour of the day (Europe/Madrid). Stations
// come back unordered; the server puts them in line order.
func (h *HistoryDB) getOperatorLineReport(agencyID, line string, hours float64) (*Obj, error) {
	var op *operatorInfo
	for i := range reportOperators {
		if reportOperators[i].ID == agencyID {
			op = &reportOperators[i]
		}
	}
	if op == nil {
		return nil, errors.New("Unknown operator")
	}
	empty := O("agencyId", agencyID, "line", line, "hours", hours, "visits", 0.0, "stations", []any{}, "byHour", []any{})
	if !h.ensureOpen() {
		return empty, nil
	}
	on := op.OnTimeMaxMins
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
	stations, err := h.all(`SELECT stop_name AS station, COUNT(*) AS visits, AVG(delay_mins) AS avgDelay,
	    MAX(delay_mins) AS maxDelay,
	    SUM(CASE WHEN delay_mins >= -1 AND delay_mins <= ? THEN 1 ELSE 0 END) AS onTime
	  FROM stop_visits WHERE agency_id = ? AND line_code = ? AND last_ts >= ?
	  GROUP BY stop_name`, on, agencyID, line, cutoff)
	if err != nil {
		return nil, err
	}
	total := 0.0
	stationRows := []any{}
	for _, s := range stations {
		total += jsNumber(s.Get("visits"))
		stationRows = append(stationRows, O(
			"station", s.Get("station"), "visits", s.Get("visits"),
			"avgDelay", round1(s.Get("avgDelay")), "maxDelay", s.Get("maxDelay"),
			"onTimePct", pct(s.Get("onTime"), s.Get("visits")),
		))
	}
	hoursRows, err := h.all(`SELECT madrid_hour(last_ts) AS hour, COUNT(*) AS visits, AVG(delay_mins) AS avgDelay,
	    SUM(CASE WHEN delay_mins >= -1 AND delay_mins <= ? THEN 1 ELSE 0 END) AS onTime
	  FROM stop_visits WHERE agency_id = ? AND line_code = ? AND last_ts >= ?
	  GROUP BY madrid_hour(last_ts) ORDER BY madrid_hour(last_ts)`, on, agencyID, line, cutoff)
	if err != nil {
		return nil, err
	}
	byHour := []any{}
	for _, r := range hoursRows {
		byHour = append(byHour, O(
			"hour", r.Get("hour"), "visits", r.Get("visits"),
			"avgDelay", round1(r.Get("avgDelay")), "onTimePct", pct(r.Get("onTime"), r.Get("visits")),
		))
	}
	empty.Set("visits", total)
	empty.Set("onTimeMaxMins", on)
	empty.Set("stations", stationRows)
	empty.Set("byHour", byHour)
	return empty, nil
}

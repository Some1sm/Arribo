package main

// Train punctuality history beyond the raw retention. Raw stop visits are
// deleted after DELAY_RETENTION_DAYS (30 in production); before that, every
// train visit is folded into two tables kept indefinitely:
//
//   - rail_hourly_stats: per operator, line and Madrid hour (the hour-of-day
//     profile and the long-term trend of a line);
//   - rail_daily_station_stats: per operator, line, station and Madrid day.
//
// Both keep the counters the Dades train report shows (getOperatorReport):
// visits, delay sum and maximum, and the same buckets (early below -1 min,
// on time up to the operator's OnTimeMaxMins, late up to 15, 30, 60 and
// beyond), so a period read back from them gives the report's numbers. What
// cannot be summed across hours (distinct trips) is not kept.
//
// The fold is incremental by stop_visits.id, like the Mataró rollups
// (rollup in historydb_maint.go): it runs in pruneOldRecords before rows are
// deleted, and its first run folds every visit still on disk.

import (
	"errors"
	"strings"
)

// railRollupChunk bounds the ids folded per transaction, so the first run
// over a full month of visits does not hold one long write transaction.
const railRollupChunk = 50000

// railHistoryAgencies is the SQL list of the train operators and the CASE
// giving each one's on-time bound, built from reportOperators.
func railHistoryAgencies() (in, onTime string) {
	ids := make([]string, 0, len(reportOperators))
	var cases strings.Builder
	cases.WriteString("CASE agency_id")
	for _, op := range reportOperators {
		ids = append(ids, "'"+op.ID+"'")
		cases.WriteString(" WHEN '" + op.ID + "' THEN " + numToString(op.OnTimeMaxMins))
	}
	cases.WriteString(" ELSE 5 END")
	return "(" + strings.Join(ids, ", ") + ")", cases.String()
}

// railBucketsSQL is the counters of a group of visits, in the report's buckets.
func railBucketsSQL(on string) string {
	return `COUNT(*) AS visits, SUM(delay_mins) AS delay_sum, MAX(delay_mins) AS max_delay,
	  SUM(CASE WHEN delay_mins < -1 THEN 1 ELSE 0 END) AS early,
	  SUM(CASE WHEN delay_mins >= -1 AND delay_mins <= ` + on + ` THEN 1 ELSE 0 END) AS on_time,
	  SUM(CASE WHEN delay_mins > ` + on + ` AND delay_mins <= 15 THEN 1 ELSE 0 END) AS late15,
	  SUM(CASE WHEN delay_mins > 15 AND delay_mins <= 30 THEN 1 ELSE 0 END) AS late30,
	  SUM(CASE WHEN delay_mins > 30 AND delay_mins <= 60 THEN 1 ELSE 0 END) AS late60,
	  SUM(CASE WHEN delay_mins > 60 THEN 1 ELSE 0 END) AS late_over60,
	  MIN(last_ts) AS first_ts`
}

// railCountersUpsert adds a new group's counters to an existing row.
const railCountersUpsert = `visits = visits + excluded.visits, delay_sum = delay_sum + excluded.delay_sum,
	  max_delay = MAX(max_delay, excluded.max_delay), early = early + excluded.early,
	  on_time = on_time + excluded.on_time, late15 = late15 + excluded.late15,
	  late30 = late30 + excluded.late30, late60 = late60 + excluded.late60,
	  late_over60 = late_over60 + excluded.late_over60, first_ts = MIN(first_ts, excluded.first_ts)`

// aggregateRailHistory folds the train visits written since the last run.
// Returns how many visit ids it covered.
func (h *HistoryDB) aggregateRailHistory() (float64, error) {
	if !h.ensureOpen() {
		return 0, nil
	}
	in, on := railHistoryAgencies()
	cols := railBucketsSQL(on)
	p, err := h.get("SELECT last_id FROM rail_rollup_progress WHERE singleton = 1")
	if err != nil {
		return 0, err
	}
	last := 0.0
	if p != nil {
		last = jsNumber(p.Get("last_id"))
	}
	mx, err := h.get("SELECT COALESCE(MAX(id), 0) AS id FROM stop_visits")
	if err != nil {
		return 0, err
	}
	maxID := jsNumber(mx.Get("id"))
	start := last
	for last < maxID {
		to := last + railRollupChunk
		if to > maxID {
			to = maxID
		}
		if err := h.foldRailChunk(in, cols, last, to); err != nil {
			return last - start, err
		}
		last = to
	}
	if err := h.foldRailCancels(); err != nil {
		return last - start, err
	}
	return last - start, nil
}

// foldRailCancels adds the cancellations recorded since the last run to
// rail_daily_cancellations, by the Madrid day of the scheduled start (the
// day the train report counts them in). A cancellation is one row per trip
// and service day in rail_cancellations, inserted once and only refreshed
// (last_seen) afterwards, so folding by id counts each one once.
func (h *HistoryDB) foldRailCancels() error {
	p, err := h.get("SELECT last_id FROM rail_cancel_rollup_progress WHERE singleton = 1")
	if err != nil {
		return err
	}
	last := 0.0
	if p != nil {
		last = jsNumber(p.Get("last_id"))
	}
	mx, err := h.get("SELECT COALESCE(MAX(id), 0) AS id FROM rail_cancellations")
	if err != nil {
		return err
	}
	maxID := jsNumber(mx.Get("id"))
	if maxID <= last {
		return nil
	}
	if err := h.exec("BEGIN IMMEDIATE"); err != nil {
		return err
	}
	err = func() error {
		if _, err := h.run(`INSERT INTO rail_daily_cancellations (agency_id, line_code, service_date, cancelled)
		  SELECT agency_id, line_code, substr(madrid_datetime(scheduled_start), 1, 10) AS day, COUNT(*)
		  FROM rail_cancellations WHERE id > ? AND id <= ? AND scheduled_start IS NOT NULL
		  GROUP BY agency_id, line_code, day
		  ON CONFLICT(agency_id, line_code, service_date) DO UPDATE SET cancelled = cancelled + excluded.cancelled`, last, maxID); err != nil {
			return err
		}
		_, err := h.run(`INSERT INTO rail_cancel_rollup_progress (singleton, last_id) VALUES (1, ?)
		  ON CONFLICT(singleton) DO UPDATE SET last_id = excluded.last_id`, maxID)
		return err
	}()
	if err != nil {
		_ = h.exec("ROLLBACK")
		return err
	}
	return h.exec("COMMIT")
}

// foldRailChunk folds visit ids (from, to] in one transaction.
func (h *HistoryDB) foldRailChunk(in, cols string, from, to float64) error {
	if err := h.exec("BEGIN IMMEDIATE"); err != nil {
		return err
	}
	err := func() error {
		if _, err := h.run(`INSERT INTO rail_hourly_stats
		    (agency_id, line_code, date_hour, visits, delay_sum, max_delay, early, on_time, late15, late30, late60, late_over60, first_ts)
		  SELECT agency_id, line_code, substr(madrid_datetime(last_ts), 1, 13) || ':00' AS date_hour, `+cols+`
		  FROM stop_visits WHERE id > ? AND id <= ? AND agency_id IN `+in+`
		  GROUP BY agency_id, line_code, date_hour
		  ON CONFLICT(agency_id, line_code, date_hour) DO UPDATE SET `+railCountersUpsert, from, to); err != nil {
			return err
		}
		if _, err := h.run(`INSERT INTO rail_daily_station_stats
		    (agency_id, line_code, stop_name, service_date, visits, delay_sum, max_delay, early, on_time, late15, late30, late60, late_over60, first_ts)
		  SELECT agency_id, line_code, stop_name, substr(madrid_datetime(last_ts), 1, 10) AS service_date, `+cols+`
		  FROM stop_visits WHERE id > ? AND id <= ? AND agency_id IN `+in+`
		  GROUP BY agency_id, line_code, stop_name, service_date
		  ON CONFLICT(agency_id, line_code, stop_name, service_date) DO UPDATE SET `+railCountersUpsert, from, to); err != nil {
			return err
		}
		_, err := h.run(`INSERT INTO rail_rollup_progress (singleton, last_id) VALUES (1, ?)
		  ON CONFLICT(singleton) DO UPDATE SET last_id = excluded.last_id`, to)
		return err
	}()
	if err != nil {
		_ = h.exec("ROLLBACK")
		return err
	}
	return h.exec("COMMIT")
}

// getRailHistory is one operator's (or one of its lines') punctuality per
// Madrid day over the last `days` days, today included, from
// rail_daily_station_stats. Only days with visits are listed: a day the
// feed was down is missing, never shown as zero. Today and the history's first day are marked partial.
func (h *HistoryDB) getRailHistory(agencyID, line string, days float64) (*Obj, error) {
	var op *operatorInfo
	for i := range reportOperators {
		if reportOperators[i].ID == agencyID {
			op = &reportOperators[i]
		}
	}
	if op == nil {
		return nil, errors.New("Unknown operator")
	}
	today := madridTime(nowMs())
	from := today.AddDate(0, 0, -int(days)+1).Format("2006-01-02")
	to := today.Format("2006-01-02")
	out := O("agencyId", agencyID, "line", strOrNil(line), "days", days, "from", from, "to", to,
		"onTimeMaxMins", op.OnTimeMaxMins, "firstDate", nil, "daily", []any{})
	if !h.ensureOpen() {
		return out, nil
	}
	where, args := "agency_id = ?", []any{agencyID}
	if line != "" {
		where += " AND line_code = ?"
		args = append(args, line)
	}
	first, err := h.get(`SELECT MIN(service_date) AS d FROM rail_daily_station_stats WHERE `+where, args...)
	if err != nil {
		return nil, err
	}
	if first != nil && !isNullish(first.Get("d")) {
		out.Set("firstDate", first.Get("d"))
	}
	rows, err := h.all(`SELECT service_date AS date, SUM(visits) AS visits, SUM(delay_sum) AS delay_sum,
	    MAX(max_delay) AS max_delay, SUM(early) AS early, SUM(on_time) AS on_time, SUM(late15) AS late15,
	    SUM(late30) AS late30, SUM(late60) AS late60, SUM(late_over60) AS late_over60
	  FROM rail_daily_station_stats WHERE `+where+` AND service_date >= ? AND service_date <= ?
	  GROUP BY service_date ORDER BY service_date`, append(args, from, to)...)
	if err != nil {
		return nil, err
	}
	// Today is still running, and the first day of the history started when
	// collection did: both are partial days, said so rather than compared.
	firstDay := jsString(out.Get("firstDate"))
	partialReason := func(date string) any {
		switch date {
		case to:
			return "today"
		case firstDay:
			return "first_day"
		}
		return nil
	}
	// Cancellations per day. Before the first recorded one for this operator
	// they were not collected: those days say null, not 0.
	cancelSince := ""
	if c, err := h.get(`SELECT MIN(service_date) AS d FROM rail_daily_cancellations WHERE agency_id = ?`, agencyID); err == nil && c != nil && !isNullish(c.Get("d")) {
		cancelSince = jsString(c.Get("d"))
	}
	out.Set("cancellationsSince", strOrNil(cancelSince))
	cancelled := map[string]float64{}
	if cancelSince != "" {
		crows, err := h.all(`SELECT service_date AS date, SUM(cancelled) AS n FROM rail_daily_cancellations
		  WHERE `+where+` AND service_date >= ? AND service_date <= ? GROUP BY service_date`, append(args, from, to)...)
		if err != nil {
			return nil, err
		}
		for _, c := range crows {
			cancelled[jsString(c.Get("date"))] = jsNumber(c.Get("n"))
		}
	}
	var totCancelled float64
	cancelKnown := false
	dayCancelled := func(date string) any {
		if cancelSince == "" || date < cancelSince {
			return nil
		}
		return cancelled[date]
	}
	daily := make([]any, 0, len(rows))
	var totVisits, totOnTime, totDelay float64
	for _, r := range rows {
		n := jsNumber(r.Get("visits"))
		totVisits += n
		totOnTime += jsNumber(r.Get("on_time"))
		totDelay += jsNumber(r.Get("delay_sum"))
		if c := dayCancelled(jsString(r.Get("date"))); c != nil {
			cancelKnown = true
			totCancelled += c.(float64)
		}
		pct := func(k string) any {
			if !(n > 0) {
				return nil
			}
			return jsRound(jsNumber(r.Get(k))*1000/n) / 10
		}
		var avg any
		if n > 0 {
			avg = jsRound(jsNumber(r.Get("delay_sum"))*10/n) / 10
		}
		daily = append(daily, O(
			"date", r.Get("date"),
			"visits", n,
			"avgDelay", avg,
			"maxDelay", r.Get("max_delay"),
			"onTimePct", pct("on_time"),
			"earlyPct", pct("early"),
			"late15Pct", pct("late15"),
			"late30Pct", pct("late30"),
			"late60Pct", pct("late60"),
			"lateOver60Pct", pct("late_over60"),
			"partial", partialReason(jsString(r.Get("date"))) != nil,
			"partialReason", partialReason(jsString(r.Get("date"))),
			"cancelled", dayCancelled(jsString(r.Get("date"))),
		))
	}
	out.Set("daily", daily)
	var cancelledTotal any // null when no shown day had cancellations recorded
	if cancelKnown {
		cancelledTotal = totCancelled
	}
	// The period as a whole, from the counts (not from the rounded days).
	if totVisits > 0 {
		out.Set("total", O("visits", totVisits, "daysWithData", float64(len(daily)),
			"onTimePct", jsRound(totOnTime*1000/totVisits)/10, "avgDelay", jsRound(totDelay*10/totVisits)/10, "cancelled", cancelledTotal))
	} else {
		out.Set("total", nil)
	}
	return out, nil
}

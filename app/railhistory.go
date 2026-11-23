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
	return last - start, nil
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

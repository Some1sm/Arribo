package main

// Port of src/historyDb.js, maintenance: hourly rollups, retention pruning,
// WAL checkpoints and close.

import (
	"errors"
	"log"
	"math"
	"runtime/debug"
)

// jsPlus is a + b for numbers or null (null reads as 0, undefined as NaN).
func jsPlus(a, b any) float64 { return jsNumber(a) + jsNumber(b) }

func numOrZeroOr(v any) any {
	// v || 0
	if truthy(v) {
		return v
	}
	return 0.0
}

func (h *HistoryDB) rollup(progressTable, maxSQL, batchSQL string, visits bool) (*Obj, error) {
	if err := h.exec("BEGIN IMMEDIATE"); err != nil {
		return nil, err
	}
	res, err := func() (*Obj, error) {
		progress, err := h.get("SELECT last_id FROM " + progressTable + " WHERE singleton = 1")
		if err != nil {
			return nil, err
		}
		lastID := 0.0
		if progress != nil && truthy(progress.Get("last_id")) {
			lastID = jsNumber(progress.Get("last_id"))
		}
		mx, err := h.get(maxSQL)
		if err != nil {
			return nil, err
		}
		maxID := math.Max(lastID, jsNumber(mx.Get("id")))
		batches, err := h.all(batchSQL, lastID, maxID)
		if err != nil {
			return nil, err
		}
		table := "hourly_line_stats"
		if visits {
			table = "hourly_line_visit_stats"
		}
		for _, b := range batches {
			previous, err := h.get("SELECT * FROM "+table+" WHERE agency_id = ? AND line_code = ? AND date_hour = ?", b.Get("agency_id"), b.Get("line_code"), b.Get("date_hour"))
			if err != nil {
				return nil, err
			}
			countKey, batchCount := "sample_count", "samples"
			if visits {
				countKey, batchCount = "visit_count", "visits"
			}
			if progress == nil && previous != nil && jsNumber(previous.Get(countKey)) > jsNumber(b.Get(batchCount)) {
				continue
			}
			var base *Obj
			if progress != nil {
				base = previous
			}
			bget := func(k string) any {
				if base == nil {
					return Undefined
				}
				return base.Get(k)
			}
			sumBase := 0.0
			if base != nil {
				if ds := base.Get("delay_sum"); !isNullish(ds) {
					sumBase = jsNumber(ds)
				} else {
					sumBase = jsNumber(base.Get("avg_delay_mins")) * jsNumber(base.Get(countKey))
				}
			}
			sum := jsPlus(sumBase, b.Get("delay_sum"))
			maxDelay := b.Get("max_delay")
			minTs := b.Get("timestamp")
			if base != nil {
				maxDelay = math.Max(jsNumber(base.Get("max_delay_mins")), jsNumber(b.Get("max_delay")))
				minTs = math.Min(jsNumber(base.Get("timestamp")), jsNumber(b.Get("timestamp")))
			}
			if !visits {
				samples := jsPlus(numOrZeroOr(bget("sample_count")), b.Get("samples"))
				var agency any = b.Get("agency")
				if base != nil && !isNullish(base.Get("agency")) {
					agency = base.Get("agency")
				}
				var early any
				if base != nil && isNullish(base.Get("early_count")) {
					early = nil
				} else {
					early = jsPlus(numOrZeroOr(bget("early_count")), b.Get("early"))
				}
				if _, err := h.run(`
        INSERT INTO hourly_line_stats
          (agency_id, line_code, agency, date_hour, sample_count, delay_sum, avg_delay_mins, max_delay_mins, on_time_count, early_count, late_count, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ROUND(? * 1.0 / ?, 2), ?, ?, ?, ?, ?)
        ON CONFLICT(agency_id, line_code, date_hour) DO UPDATE SET
          agency = excluded.agency, sample_count = excluded.sample_count,
          delay_sum = excluded.delay_sum, avg_delay_mins = excluded.avg_delay_mins,
          max_delay_mins = excluded.max_delay_mins, on_time_count = excluded.on_time_count,
          early_count = excluded.early_count, late_count = excluded.late_count, timestamp = excluded.timestamp
      `, b.Get("agency_id"), b.Get("line_code"), agency, b.Get("date_hour"), samples, sum, sum, samples, maxDelay,
					jsPlus(numOrZeroOr(bget("on_time_count")), b.Get("on_time")),
					early,
					jsPlus(numOrZeroOr(bget("late_count")), b.Get("late")),
					minTs); err != nil {
					return nil, err
				}
			} else {
				vis := jsPlus(numOrZeroOr(bget("visit_count")), b.Get("visits"))
				samples := jsPlus(numOrZeroOr(bget("sample_count")), or(b.Get("samples"), b.Get("visits")))
				if _, err := h.run(`
        INSERT INTO hourly_line_visit_stats
          (agency_id, line_code, agency, date_hour, visit_count, sample_count, delay_sum, avg_delay_mins, max_delay_mins, on_time_count, early_count, late_count, timestamp)
        VALUES (?, ?, 'Mataró Bus (Avanza)', ?, ?, ?, ?, ROUND(? * 1.0 / ?, 2), ?, ?, ?, ?, ?)
        ON CONFLICT(agency_id, line_code, date_hour) DO UPDATE SET
          agency = excluded.agency, visit_count = excluded.visit_count,
          sample_count = excluded.sample_count, delay_sum = excluded.delay_sum,
          avg_delay_mins = excluded.avg_delay_mins, max_delay_mins = excluded.max_delay_mins,
          on_time_count = excluded.on_time_count, early_count = excluded.early_count,
          late_count = excluded.late_count, timestamp = excluded.timestamp
      `, b.Get("agency_id"), b.Get("line_code"), b.Get("date_hour"), vis, samples, sum, sum, vis, maxDelay,
					jsPlus(numOrZeroOr(bget("on_time_count")), b.Get("on_time")),
					jsPlus(numOrZeroOr(bget("early_count")), b.Get("early")),
					jsPlus(numOrZeroOr(bget("late_count")), b.Get("late")),
					minTs); err != nil {
					return nil, err
				}
			}
		}
		if _, err := h.run(`
        INSERT INTO `+progressTable+` (singleton, last_id) VALUES (1, ?)
        ON CONFLICT(singleton) DO UPDATE SET last_id = excluded.last_id
      `, maxID); err != nil {
			return nil, err
		}
		if err := h.exec("COMMIT"); err != nil {
			return nil, err
		}
		return O("bucketsUpdated", float64(len(batches)), "lastId", maxID), nil
	}()
	if err != nil {
		_ = h.exec("ROLLBACK")
		return nil, err
	}
	return res, nil
}

func (h *HistoryDB) aggregateHourlyStats() (*Obj, error) {
	if !h.ensureOpen() {
		return nil, errors.New("Hourly rollup database unavailable")
	}
	return h.rollup("hourly_rollup_progress", "SELECT COALESCE(MAX(id), 0) AS id FROM delay_logs", `
        SELECT agency_id, line_code, MIN(agency) AS agency,
          -- Europe/Madrid bucketing via the registered madrid_datetime UDF
          -- ('YYYY-MM-DD HH:MM:SS'), NOT strftime(...,'localtime'). The
          -- host-local variant silently depended on the process TZ, so a
          -- deployment outside Europe/Madrid split Madrid's morning peak
          -- across two buckets and fed the wrong per-line punctuality.
          substr(madrid_datetime(timestamp), 1, 13) || ':00' AS date_hour,
          COUNT(*) AS samples, SUM(delay_mins) AS delay_sum, MAX(delay_mins) AS max_delay,
          SUM(CASE WHEN `+onTimeSQL+` THEN 1 ELSE 0 END) AS on_time,
          SUM(CASE WHEN `+earlySQL+` THEN 1 ELSE 0 END) AS early,
          SUM(CASE WHEN delay_mins > 3 THEN 1 ELSE 0 END) AS late,
          MIN(timestamp) AS timestamp
        FROM delay_logs WHERE id > ? AND id <= ?
        GROUP BY agency_id, line_code, date_hour
      `, false)
}

func (h *HistoryDB) aggregateHourlyVisitStats() (*Obj, error) {
	if !h.ensureOpen() {
		return nil, errors.New("Hourly visit rollup database unavailable")
	}
	return h.rollup("hourly_visit_rollup_progress", "SELECT COALESCE(MAX(id), 0) AS id FROM stop_visits", `
        SELECT agency_id, line_code,
          substr(madrid_datetime(last_ts), 1, 13) || ':00' AS date_hour,
          COUNT(*) AS visits,
          SUM(sample_count) AS samples,
          SUM(delay_mins) AS delay_sum,
          MAX(delay_mins) AS max_delay,
          SUM(CASE WHEN `+onTimeSQL+` THEN 1 ELSE 0 END) AS on_time,
          SUM(CASE WHEN `+earlySQL+` THEN 1 ELSE 0 END) AS early,
          SUM(CASE WHEN `+lateSQL+` THEN 1 ELSE 0 END) AS late,
          MIN(last_ts) AS timestamp
        FROM stop_visits WHERE id > ? AND id <= ? AND `+validDelaySQL+` AND agency_id = 'mataro'
        GROUP BY agency_id, line_code, date_hour
      `, true)
}

// pruneOldRecords is called without arguments everywhere, so the retention
// is always this.delayRetentionDays.
func (h *HistoryDB) pruneOldRecords() {
	daysRetention := h.delayRetentionDays
	if !h.ensureOpen() {
		return
	}
	err := func() error {
		if _, err := h.aggregateHourlyStats(); err != nil {
			return err
		}
		if _, err := h.aggregateHourlyVisitStats(); err != nil {
			return err
		}
		// A failed train fold is logged, not fatal: it must not stop pruning.
		if _, err := h.aggregateRailHistory(); err != nil {
			log.Printf("[HistoryDB] Rail history rollup failed: %s", err.Error())
		}
		snapCut := float64(nowMs()) - h.snapshotRetentionHours*3600*1000
		snaps, err := h.run("DELETE FROM vehicle_snapshots WHERE timestamp < ?", snapCut)
		if err != nil {
			return err
		}
		cutoff := float64(nowMs()) - daysRetention*86400*1000
		delays, err := h.run("DELETE FROM delay_logs WHERE timestamp < ?", cutoff)
		if err != nil {
			return err
		}
		if _, err := h.run("DELETE FROM stop_visits WHERE last_ts < ?", cutoff); err != nil {
			return err
		}
		if _, err := h.run("DELETE FROM gps_gaps WHERE lost_ts < ?", cutoff); err != nil {
			return err
		}
		if _, err := h.run("DELETE FROM rail_cancellations WHERE last_seen < ?", cutoff); err != nil {
			return err
		}
		if _, err := h.run("DELETE FROM rail_platforms WHERE last_seen < ?", cutoff); err != nil {
			return err
		}
		if err := h.exec("PRAGMA optimize; PRAGMA incremental_vacuum; PRAGMA shrink_memory;"); err != nil {
			return err
		}
		h.checkpointTruncate()
		debug.FreeOSMemory()
		log.Printf("[HistoryDB] Pruned old records (snapshots: %sh, delays: %sd, deleted: %s, hourly stats preserved).",
			numToString(h.snapshotRetentionHours), numToString(daysRetention), numToString(snaps.changes+delays.changes))
		return nil
	}()
	if err != nil {
		log.Printf("[HistoryDB] pruneOldRecords error: %s", err.Error())
	}
}

func (h *HistoryDB) checkpointTruncate() bool {
	if h.conn == nil {
		return false
	}
	if err := h.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA shrink_memory;"); err != nil {
		log.Printf("[HistoryDB] checkpointTruncate error: %s", err.Error())
		return false
	}
	log.Printf("[HistoryDB] WAL checkpoint (TRUNCATE) executed successfully.")
	return true
}

func (h *HistoryDB) closeDB() {
	h.checkpointTruncate()
	if err := h.conn.Close(); err != nil {
		log.Printf("[HistoryDB] close error: %s", err.Error())
	}
	if err := h.db.Close(); err != nil {
		log.Printf("[HistoryDB] close error: %s", err.Error())
	}
	h.conn, h.db = nil, nil
}

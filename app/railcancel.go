package main

// Cancelled trains for Dades. The operators mark cancelled trips in their
// trip updates (GTFS-RT schedule_relationship CANCELED); the pollers keep
// them for the live views (rtSnapshot.Canceled) and, through this file,
// queue them for the history database: one row per operator, trip and
// service day, with when it was first and last announced. The worker
// writes them (only the worker touches SQLite). These are the
// cancellations the operator announced in its real-time feed, not an
// audit of every scheduled train.

import (
	"context"
	"math"
	"time"
)

// railCancel is one announced cancellation.
type railCancel struct {
	AgencyID, TripID, ServiceDate string
	Line, Headsign                string
	Start                         int64 // scheduled departure from the trip's first stop (unix s)
	Seen                          int64 // when this poll saw it (unix s)
}

// rtMaxPendingCancels bounds the queue between two worker drains.
const rtMaxPendingCancels = 2000

// cancelFor resolves a cancelled trip against the timetable: its line,
// headsign, scheduled start and service day. Renfe sends no start_date, so
// the service day is the one (yesterday, today or tomorrow) whose start is
// closest to now. ok is false for a trip outside the timetable (Renfe's
// feed covers all of Spain).
func cancelFor(ctx context.Context, tt *rtTimetable, agencyID string, td TripDescriptor, now time.Time) (railCancel, bool) {
	if tt == nil || !tt.hasTrip(ctx, td.TripID) {
		return railCancel{}, false
	}
	orig, ok := tt.originSec(ctx, td.TripID)
	if !ok {
		return railCancel{}, false
	}
	var date string
	var start int64
	if td.StartDate != "" {
		if ref, err := gtfsServiceDayRef(td.StartDate); err == nil {
			date, start = td.StartDate, ref.Unix()+orig
		}
	}
	if date == "" {
		today := now.In(madrid)
		best := math.Inf(1)
		for _, back := range []int{1, 0, -1} {
			d := time.Date(today.Year(), today.Month(), today.Day()-back, 12, 0, 0, 0, madrid).Format("20060102")
			ref, err := gtfsServiceDayRef(d)
			if err != nil {
				continue
			}
			s := ref.Unix() + orig
			if gap := math.Abs(float64(s - now.Unix())); gap < best {
				best, date, start = gap, d, s
			}
		}
	}
	if date == "" {
		return railCancel{}, false
	}
	return railCancel{
		AgencyID: agencyID, TripID: td.TripID, ServiceDate: date,
		Line: tt.tripLine(ctx, td.TripID), Headsign: tt.tripHeadsign(ctx, td.TripID),
		Start: start, Seen: now.Unix(),
	}, true
}

// queueCancels adds this poll's cancelled trips to the worker's queue.
func (p *rtPoller) queueCancels(list []railCancel) {
	if len(list) == 0 {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.pendingCancels = append(p.pendingCancels, list...)
	if over := len(p.pendingCancels) - rtMaxPendingCancels; over > 0 {
		p.pendingCancels = append([]railCancel(nil), p.pendingCancels[over:]...)
	}
}

// takeRailCancels hands over the queued cancellations (for the worker).
func (p *rtPoller) takeRailCancels() []railCancel {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := p.pendingCancels
	p.pendingCancels = nil
	return out
}

// writeRailCancels stores the queued cancellations: a new trip and day is
// inserted, a known one only moves its last_seen. Runs as a daemon task
// under the worker lock.
func (d *IngestionDaemon) writeRailCancels() {
	var batch []railCancel
	for _, p := range gtfsRtPollers {
		for _, c := range p.takeRailCancels() {
			if c.Line == "" {
				continue
			}
			batch = append(batch, c)
		}
	}
	if len(batch) == 0 {
		return
	}
	_ = d.db.withTx(func() error {
		for _, c := range batch {
			d.db.recordRailCancel(c)
		}
		return nil
	})
}

// recordRailCancel upserts one cancellation.
func (h *HistoryDB) recordRailCancel(c railCancel) {
	if !h.ensureOpen() {
		return
	}
	_, _ = h.run(`INSERT INTO rail_cancellations (agency_id, trip_id, service_date, line_code, headsign, scheduled_start, first_seen, last_seen)
	  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	  ON CONFLICT(agency_id, trip_id, service_date) DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen)`,
		c.AgencyID, c.TripID, c.ServiceDate, c.Line, c.Headsign, float64(c.Start*1000), float64(c.Seen*1000), float64(c.Seen*1000))
}

// railCancelCounts is the cancellations of one operator whose scheduled
// start falls in [from, to] (ms), per line.
func (h *HistoryDB) railCancelCounts(agencyID string, from, to float64) (total float64, byLine map[string]float64) {
	byLine = map[string]float64{}
	if !h.ensureOpen() {
		return 0, byLine
	}
	rows, err := h.all(`SELECT line_code AS line, COUNT(*) AS n FROM rail_cancellations
	  WHERE agency_id = ? AND scheduled_start >= ? AND scheduled_start <= ? GROUP BY line_code`, agencyID, from, to)
	if err != nil {
		return 0, byLine
	}
	for _, r := range rows {
		n := jsNumber(r.Get("n"))
		byLine[jsString(r.Get("line"))] = n
		total += n
	}
	return total, byLine
}

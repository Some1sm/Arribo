package main

// Scheduled times from an imported GTFS timetable (arribo gtfs-import),
// used to turn predicted GTFS-RT times into delays for feeds that send no
// delay field (FGC). The file is opened read-only; it is not the history
// database and the server world never uses it.

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// rtTimetable answers scheduled-time lookups from one imported GTFS file.
type rtTimetable struct {
	db    *sql.DB
	mu    sync.Mutex
	cache map[string]int64 // trip_id + "\x00" + stop_id -> scheduled seconds (-1 = none)
}

// openRtTimetable opens <ARRIBO_GTFS_DIR>/<agencyID>.db read-only, or
// returns nil when the variable or the file is missing.
func openRtTimetable(agencyID string) (*rtTimetable, error) {
	dir := os.Getenv("ARRIBO_GTFS_DIR")
	if dir == "" {
		return nil, nil
	}
	p := filepath.Join(dir, agencyID+".db")
	if _, err := os.Stat(p); err != nil {
		return nil, nil
	}
	db, err := sql.Open("sqlite", "file:"+p+"?mode=ro")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	return &rtTimetable{db: db, cache: map[string]int64{}}, nil
}

// scheduledSec is the trip's scheduled arrival (else departure) at stopID,
// in seconds after the service day's reference time. ok is false when the
// timetable has no such stop on that trip. A trip visiting the stop twice
// (a loop) gets its first visit.
func (t *rtTimetable) scheduledSec(ctx context.Context, tripID, stopID string) (int64, bool) {
	key := tripID + "\x00" + stopID
	t.mu.Lock()
	if v, hit := t.cache[key]; hit {
		t.mu.Unlock()
		return v, v >= 0
	}
	t.mu.Unlock()
	var sec sql.NullInt64
	err := t.db.QueryRowContext(ctx, `SELECT COALESCE(arrival_sec, departure_sec) FROM stop_times
	  WHERE trip_id = ? AND stop_id = ? ORDER BY stop_sequence LIMIT 1`, tripID, stopID).Scan(&sec)
	v := int64(-1)
	if err == nil && sec.Valid {
		v = sec.Int64
	}
	t.mu.Lock()
	if len(t.cache) > 50000 { // bounded: a day's trips are far fewer
		t.cache = map[string]int64{}
	}
	t.cache[key] = v
	t.mu.Unlock()
	return v, v >= 0
}

// gtfsServiceDayRef is the reference instant of a GTFS service date
// (YYYYMMDD) in Europe/Madrid: "noon minus 12 hours", which is local
// midnight except on DST change days, where GTFS times count from it.
func gtfsServiceDayRef(date string) (time.Time, error) {
	d, err := time.ParseInLocation("20060102", date, madrid)
	if err != nil {
		return time.Time{}, fmt.Errorf("bad service date %q", date)
	}
	noon := time.Date(d.Year(), d.Month(), d.Day(), 12, 0, 0, 0, madrid)
	return noon.Add(-12 * time.Hour), nil
}

// tripUpdateComputedDelay derives a delay from predicted times: at the
// first stop update that has a predicted arrival (else departure) time and
// a scheduled time in the timetable, predicted minus scheduled. It needs the
// trip's start_date; nil when anything is missing.
func tripUpdateComputedDelay(ctx context.Context, tt *rtTimetable, tu *TripUpdate) *int32 {
	if tt == nil || tu.Trip.TripID == "" || tu.Trip.StartDate == "" {
		return nil
	}
	ref, err := gtfsServiceDayRef(tu.Trip.StartDate)
	if err != nil {
		return nil
	}
	for _, s := range tu.StopTimeUpdates {
		ev := s.Arrival
		if ev == nil || ev.Time == nil {
			ev = s.Departure
		}
		if ev == nil || ev.Time == nil || s.StopID == "" {
			continue
		}
		sched, ok := tt.scheduledSec(ctx, tu.Trip.TripID, s.StopID)
		if !ok {
			continue
		}
		d := int32(*ev.Time - (ref.Unix() + sched))
		return &d
	}
	return nil
}

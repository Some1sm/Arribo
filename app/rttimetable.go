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
	"sync"
	"time"
)

// rtTimetable answers scheduled-time lookups from one imported GTFS file.
type rtTimetable struct {
	db    *sql.DB
	mu    sync.Mutex
	cache map[string]int64  // trip_id + "\x00" + stop_id -> scheduled seconds (-1 = none)
	names map[string]string // line and stop name lookups
}

// openRtTimetable opens the imported timetable at path read-only, or
// returns nil when the file is missing.
func openRtTimetable(p string) (*rtTimetable, error) {
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

// hasTrip reports whether the timetable has trip_id (cached, bounded).
func (t *rtTimetable) hasTrip(ctx context.Context, tripID string) bool {
	key := "\x01" + tripID
	t.mu.Lock()
	if v, hit := t.cache[key]; hit {
		t.mu.Unlock()
		return v >= 0
	}
	t.mu.Unlock()
	var one int
	v := int64(-1)
	if t.db.QueryRowContext(ctx, `SELECT 1 FROM trips WHERE trip_id = ? LIMIT 1`, tripID).Scan(&one) == nil {
		v = 1
	}
	t.mu.Lock()
	if len(t.cache) > 50000 {
		t.cache = map[string]int64{}
	}
	t.cache[key] = v
	t.mu.Unlock()
	return v >= 0
}

// lookupString runs a one-value query with a bounded cache keyed by key.
func (t *rtTimetable) lookupString(ctx context.Context, key, q, arg string) string {
	t.mu.Lock()
	if t.names == nil {
		t.names = map[string]string{}
	}
	if v, hit := t.names[key]; hit {
		t.mu.Unlock()
		return v
	}
	t.mu.Unlock()
	var s sql.NullString
	_ = t.db.QueryRowContext(ctx, q, arg).Scan(&s)
	t.mu.Lock()
	if len(t.names) > 50000 {
		t.names = map[string]string{}
	}
	t.names[key] = s.String
	t.mu.Unlock()
	return s.String
}

// tripLine is the trip's route short name (else long name), "" if unknown.
func (t *rtTimetable) tripLine(ctx context.Context, tripID string) string {
	return t.lookupString(ctx, "L\x00"+tripID, `SELECT COALESCE(NULLIF(r.short_name, ''), r.long_name)
	  FROM trips t JOIN routes r ON r.route_id = t.route_id WHERE t.trip_id = ? LIMIT 1`, tripID)
}

// stopName is the stop's name, "" if unknown.
func (t *rtTimetable) stopName(ctx context.Context, stopID string) string {
	return t.lookupString(ctx, "S\x00"+stopID, `SELECT name FROM stops WHERE stop_id = ? LIMIT 1`, stopID)
}

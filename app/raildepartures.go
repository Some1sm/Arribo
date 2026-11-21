package main

// Timetable departures at a rail station (bit 4 of the GUI scalability
// plan in docs/catalonia-review/REPORT.md). The imported timetable is a
// SQLite file, so it is read on the worker, the only side that opens
// SQLite; the server asks through the bridge (op "getRailDepartures") and
// then adds the live trip delays it already holds in memory.

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"os"
	"time"
)

// railDepWindowSec is how far ahead departures are listed, as the bus board.
const railDepWindowSec = 120 * 60

// railTimetables is the worker's own read-only handles, one per operator,
// reopened when a refresh replaces the file. Used under the worker lock.
type railTimetables struct {
	open map[string]*rtTimetable
	mod  map[string]time.Time
}

func (r *railTimetables) get(agencyID string) (*rtTimetable, error) {
	if r.open == nil {
		r.open, r.mod = map[string]*rtTimetable{}, map[string]time.Time{}
	}
	path := gtfsTimetablePath(agencyID)
	fi, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("no timetable for %s", agencyID)
	}
	if tt := r.open[agencyID]; tt != nil && fi.ModTime().Equal(r.mod[agencyID]) {
		return tt, nil
	}
	tt, err := openRtTimetable(path)
	if err != nil || tt == nil {
		return nil, fmt.Errorf("timetable for %s not opened", agencyID)
	}
	if old := r.open[agencyID]; old != nil {
		_ = old.db.Close()
	}
	r.open[agencyID], r.mod[agencyID] = tt, fi.ModTime()
	return tt, nil
}

func (r *railTimetables) close() {
	for _, tt := range r.open {
		_ = tt.db.Close()
	}
	r.open = nil
}

// railDeparture is one scheduled departure of a line from a station.
type railDeparture struct {
	TripID, Headsign string
	DirectionID      int
	DepartUnix       int64 // scheduled, absolute
}

var gtfsWeekdayColumn = [...]string{"sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"}

// departures lists the line's scheduled departures from stopID (or any
// platform of the same parent station) in the next railDepWindowSec, for
// direction dir (-1 = both). A trip's last stop is not a departure. Trips
// after midnight are found on the previous service day (GTFS times above
// 24:00). Service days follow calendar and calendar_dates.
func (t *rtTimetable) departures(ctx context.Context, code, stopID string, dir int, now time.Time) ([]railDeparture, error) {
	var out []railDeparture
	today := now.In(madrid)
	for _, back := range []int{1, 0} {
		day := time.Date(today.Year(), today.Month(), today.Day()-back, 12, 0, 0, 0, madrid)
		date := day.Format("20060102")
		ref, err := gtfsServiceDayRef(date)
		if err != nil {
			return nil, err
		}
		from := now.Unix() - ref.Unix()
		to := from + railDepWindowSec
		col := gtfsWeekdayColumn[day.Weekday()]
		q := `WITH active(service_id) AS (
		    SELECT service_id FROM calendar WHERE start_date <= ?1 AND end_date >= ?1 AND ` + col + ` = 1
		    UNION SELECT service_id FROM calendar_dates WHERE date = ?1 AND exception_type = 1
		    EXCEPT SELECT service_id FROM calendar_dates WHERE date = ?1 AND exception_type = 2
		  ), here(stop_id) AS (
		    SELECT stop_id FROM stops WHERE stop_id = ?2
		    UNION SELECT s.stop_id FROM stops s JOIN stops p ON p.stop_id = ?2
		      WHERE COALESCE(p.parent_station, '') != '' AND s.parent_station = p.parent_station
		  )
		  SELECT st.trip_id, COALESCE(tr.headsign, ''), COALESCE(tr.direction_id, -1),
		      COALESCE(st.departure_sec, st.arrival_sec) AS sec
		    FROM stop_times st
		    JOIN trips tr ON tr.trip_id = st.trip_id
		    JOIN routes r ON r.route_id = tr.route_id
		   WHERE st.stop_id IN (SELECT stop_id FROM here)
		     AND COALESCE(NULLIF(r.short_name, ''), r.route_id) = ?3
		     AND tr.service_id IN (SELECT service_id FROM active)
		     AND COALESCE(st.departure_sec, st.arrival_sec) BETWEEN ?4 AND ?5
		     AND (?6 < 0 OR tr.direction_id = ?6)
		     AND st.stop_sequence < (SELECT MAX(stop_sequence) FROM stop_times s2 WHERE s2.trip_id = st.trip_id)
		   ORDER BY sec LIMIT 30`
		rows, err := t.db.QueryContext(ctx, q, date, stopID, code, from, to, dir)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var d railDeparture
			var sec sql.NullInt64
			if err := rows.Scan(&d.TripID, &d.Headsign, &d.DirectionID, &sec); err != nil {
				rows.Close()
				return nil, err
			}
			if !sec.Valid {
				continue
			}
			d.DepartUnix = ref.Unix() + sec.Int64
			out = append(out, d)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	// Merge the two service days in time order (each is already sorted).
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].DepartUnix < out[j-1].DepartUnix; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	if len(out) > 30 {
		out = out[:30]
	}
	return out, nil
}

// railDeparturesOp is the worker op: args agencyId, code, stopId,
// direction ("0", "1", anything else = both). The answer crosses the
// bridge as plain JSON values.
func (k *Worker) railDeparturesOp(args *Obj) (any, error) {
	agency, code, stop := jsString(args.Get("agencyId")), jsString(args.Get("code")), jsString(args.Get("stopId"))
	dir := -1
	switch jsString(args.Get("direction")) {
	case "0":
		dir = 0
	case "1":
		dir = 1
	}
	tt, err := k.railTT.get(agency)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	deps, err := tt.departures(ctx, code, stop, dir, time.UnixMilli(nowMs()))
	if err != nil {
		return nil, err
	}
	list := make([]any, 0, len(deps))
	for _, d := range deps {
		list = append(list, O("tripId", d.TripID, "headsign", d.Headsign, "directionId", float64(d.DirectionID), "departUnix", float64(d.DepartUnix)))
	}
	return O("departures", list), nil
}

// railDeparturesResponse turns the worker's scheduled departures into the
// stop board's departures (the fields renderModalDepartures reads), adding
// a live delay where the operator's feed has one for that trip. A trip
// with no live delay is shown as timetable only, never as on time.
func railDeparturesResponse(info operatorInfo, stop rtLineStop, sched []any, snap *rtSnapshot, now time.Time) *Obj {
	deps := []any{}
	// Trips the operator reports a train for. Renfe's trip updates also list
	// trips that have not started, with a delay of 0: shown as live, a train
	// two hours away read "real time, on time". A delay counts as a live
	// forecast only for a trip with a train in the positions feed.
	running := map[string]bool{}
	if snap != nil {
		for i := range snap.Vehicles {
			if id := snap.Vehicles[i].TripID; id != "" {
				running[id] = true
			}
		}
	}
	for _, raw := range sched {
		o, ok := raw.(*Obj)
		if !ok {
			continue
		}
		trip := jsString(o.Get("tripId"))
		aimed := int64(jsNumber(o.Get("departUnix")))
		expected := aimed
		var delayMins any
		delaySource := any(nil)
		discarded := false
		isRT := false
		if snap != nil && running[trip] {
			if d, ok := snap.TripDelays[trip]; ok {
				if int(d) < railMinDelaySec || int(d) > railMaxDelaySec {
					discarded = true
				} else {
					expected = aimed + int64(d)
					delayMins = math.Round(float64(d) / 60)
					isRT = true
					if snap.ComputedTrips[trip] {
						delaySource = "timetable"
					} else {
						delaySource = "feed"
					}
				}
			}
		}
		minutes := math.Floor(float64(expected-now.Unix()) / 60)
		if minutes < 0 {
			continue // already left (by its live time)
		}
		status, badge := railDelayLabel(delayMins, discarded)
		if !isRT && !discarded {
			status, badge = "scheduled", "Horari"
		}
		hhmm := func(u int64) string { return time.Unix(u, 0).In(madrid).Format("15:04") }
		deps = append(deps, O(
			"tripId", trip,
			"vehicleId", nil,
			"destination", strOrNil(jsString(o.Get("headsign"))),
			"direction", numToString(jsNumber(o.Get("directionId"))),
			"departureTime", hhmm(expected),
			"scheduledTime", hhmm(aimed),
			"aimedIso", isoString(aimed*1000),
			"expectedIso", isoString(expected*1000),
			"minutesAway", minutes,
			"delayMins", delayMins,
			"delayMinutes", delayMins,
			"delayStatus", status,
			"delayBadgeText", badge,
			"delaySource", delaySource,
			"delayDiscarded", discarded,
			"isRealTime", isRT,
			"isEstimated", false,
			"isTheoretical", !isRT,
		))
	}
	return O(
		"stop", O("id", stop.ID, "name", stop.Name, "lat", stop.Lat, "lon", stop.Lon, "agencyId", info.ID),
		"departures", deps,
		"windowMinutes", float64(railDepWindowSec/60),
		"source", "gtfs",
		"attribution", trainAttribution[info.ID],
	)
}

// lineStop finds a station of the line's profile by id.
func lineStop(op *rtCatalogOp, code, stopID string) (rtLineStop, bool) {
	if op.Profiles == nil || op.Profiles[code] == nil {
		return rtLineStop{}, false
	}
	for _, d := range op.Profiles[code].Directions {
		for _, s := range d.Stops {
			if s.ID == stopID {
				return s, true
			}
		}
	}
	return rtLineStop{}, false
}

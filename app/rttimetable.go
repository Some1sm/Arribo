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
	"strings"
	"sync"
	"time"
)

// rtTimetable answers scheduled-time lookups from one imported GTFS file.
type rtTimetable struct {
	db                           *sql.DB
	mu                           sync.Mutex
	cache                        map[string]int64    // trip_id + "\x00" + stop_id -> scheduled seconds (-1 = none)
	names                        map[string]string   // line and stop name lookups
	platformChecked, platformCol bool                // stops.platform_code looked up / present
	hours                        map[string][]int    // scheduledHoursOn per service day (YYYYMMDD)
	numMu                        sync.Mutex          // guards byNumber, built on first use (gtfsrtld.go)
	byNumber                     map[string][]string // train number -> trip ids
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

// originSec is the trip's scheduled departure (else arrival) from its first
// stop, in seconds after the service day's reference time (cached, bounded).
func (t *rtTimetable) originSec(ctx context.Context, tripID string) (int64, bool) {
	key := "\x02" + tripID
	t.mu.Lock()
	if v, hit := t.cache[key]; hit {
		t.mu.Unlock()
		return v, v >= 0
	}
	t.mu.Unlock()
	var sec sql.NullInt64
	err := t.db.QueryRowContext(ctx, `SELECT COALESCE(departure_sec, arrival_sec) FROM stop_times
	  WHERE trip_id = ? ORDER BY stop_sequence LIMIT 1`, tripID).Scan(&sec)
	v := int64(-1)
	if err == nil && sec.Valid {
		v = sec.Int64
	}
	t.mu.Lock()
	if len(t.cache) > 50000 {
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

// routeLine is a route id's line code as the catalog names it (short name,
// else route id), or "" when the timetable has no such route.
// tripHeadsign is a trip's headsign (the import fills a missing one with its
// last station), or "".
func (t *rtTimetable) tripHeadsign(ctx context.Context, tripID string) string {
	return t.lookupString(ctx, "H\x00"+tripID, `SELECT COALESCE(headsign, '') FROM trips WHERE trip_id = ? LIMIT 1`, tripID)
}

func (t *rtTimetable) routeLine(ctx context.Context, routeID string) string {
	return t.lookupString(ctx, "Q\x00"+routeID, `SELECT COALESCE(NULLIF(short_name, ''), route_id) FROM routes WHERE route_id = ? LIMIT 1`, routeID)
}

// tripDirection is the trip's direction_id, -1 if unknown.
func (t *rtTimetable) tripDirection(ctx context.Context, tripID string) int {
	v := t.lookupString(ctx, "D\x00"+tripID, `SELECT CAST(direction_id AS TEXT) FROM trips WHERE trip_id = ? LIMIT 1`, tripID)
	switch v {
	case "0":
		return 0
	case "1":
		return 1
	}
	return -1
}

// stopName is the stop's name, "" if unknown.
func (t *rtTimetable) stopName(ctx context.Context, stopID string) string {
	return t.lookupString(ctx, "S\x00"+stopID, `SELECT name FROM stops WHERE stop_id = ? LIMIT 1`, stopID)
}

// rtRoute is one line of an imported timetable, for the line catalog.
type rtRoute struct {
	Code, Name, Color, TextColor string
	RouteType                    int
}

// catalogRoutes is the timetable's lines grouped by short name (Renfe's
// feed has several routes per line code), in a stable order: the first
// route's long name and colours win. Colours are returned as "#rrggbb";
// a missing text colour stays empty (the client applies the GTFS default).
func (t *rtTimetable) catalogRoutes(ctx context.Context) ([]rtRoute, error) {
	rows, err := t.db.QueryContext(ctx, `SELECT COALESCE(NULLIF(short_name, ''), route_id), COALESCE(long_name, ''),
	    COALESCE(color, ''), COALESCE(text_color, ''), COALESCE(route_type, 3)
	  FROM routes ORDER BY rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	seen := map[string]bool{}
	var out []rtRoute
	hex := func(s string) string {
		if len(s) == 6 {
			for _, c := range s {
				if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
					return ""
				}
			}
			return "#" + s
		}
		return ""
	}
	for rows.Next() {
		var r rtRoute
		if err := rows.Scan(&r.Code, &r.Name, &r.Color, &r.TextColor, &r.RouteType); err != nil {
			return nil, err
		}
		if r.Code == "" || seen[r.Code] {
			continue
		}
		seen[r.Code] = true
		r.Name = strings.Join(strings.Fields(r.Name), " ") // Renfe pads its names with runs of spaces
		r.Color, r.TextColor = hex(r.Color), hex(r.TextColor)
		out = append(out, r)
	}
	return out, rows.Err()
}

// rtLineStop is one station of a line profile, in travel order.
type rtLineStop struct {
	ID, Name string
	Lat, Lon float64
}

// rtLineDirection is one direction of a rail line as the timetable
// describes it: the stations of its longest trip in that direction and
// the trip's GTFS shape (else the straight segments between the
// stations, which GeometryFromStops says).
type rtLineDirection struct {
	DirectionID       int
	Headsign          string
	Stops             []rtLineStop
	Geometry          [][2]float64 // [lat, lon]
	GeometryFromStops bool
	Trips             int // trips of the line in this direction in the timetable
}

// rtLineProfile is one line (grouped by short name, as in the catalog).
type rtLineProfile struct {
	Code       string
	Directions []rtLineDirection // ordered by direction id
}

// rtMaxShapePoints bounds a direction's geometry; longer shapes keep every
// n-th point plus the last, which is far finer than a phone map shows.
const rtMaxShapePoints = 600

// lineProfiles builds every line's profile from the timetable. Run on the
// poller goroutine when a timetable opens; the result is immutable.
//
// A line's stations per direction are those of its trip with the most
// stops (the first such trip in file order on a tie). Branches and short
// workings are therefore not listed separately: this is a map of the
// line, not its timetable.
func (t *rtTimetable) lineProfiles(ctx context.Context) ([]rtLineProfile, error) {
	rows, err := t.db.QueryContext(ctx, `SELECT COALESCE(NULLIF(r.short_name, ''), r.route_id), COALESCE(tr.direction_id, 0),
	    tr.trip_id, COALESCE(tr.headsign, ''), COALESCE(tr.shape_id, ''),
	    (SELECT COUNT(*) FROM stop_times st WHERE st.trip_id = tr.trip_id)
	  FROM trips tr JOIN routes r ON r.route_id = tr.route_id
	  ORDER BY tr.rowid`)
	if err != nil {
		return nil, err
	}
	type pick struct {
		tripID, headsign, shapeID string
		n, trips                  int
	}
	type key struct {
		code string
		dir  int
	}
	best := map[key]*pick{}
	var order []string
	seenCode := map[string]bool{}
	for rows.Next() {
		var k key
		var p pick
		if err := rows.Scan(&k.code, &k.dir, &p.tripID, &p.headsign, &p.shapeID, &p.n); err != nil {
			rows.Close()
			return nil, err
		}
		if k.code == "" || p.n < 2 {
			continue
		}
		if !seenCode[k.code] {
			seenCode[k.code] = true
			order = append(order, k.code)
		}
		cur := best[k]
		if cur == nil {
			p.trips = 1
			best[k] = &p
			continue
		}
		cur.trips++
		if p.n > cur.n {
			p.trips = cur.trips
			best[k] = &p
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	out := make([]rtLineProfile, 0, len(order))
	for _, code := range order {
		prof := rtLineProfile{Code: code}
		for dir := 0; dir <= 1; dir++ {
			p := best[key{code, dir}]
			if p == nil {
				continue
			}
			d := rtLineDirection{DirectionID: dir, Headsign: strings.Join(strings.Fields(p.headsign), " "), Trips: p.trips}
			if d.Stops, err = t.tripStops(ctx, p.tripID); err != nil {
				return nil, err
			}
			if p.shapeID != "" {
				if d.Geometry, err = t.shapePoints(ctx, p.shapeID); err != nil {
					return nil, err
				}
			}
			if len(d.Geometry) < 2 {
				d.Geometry, d.GeometryFromStops = nil, true
				for _, s := range d.Stops {
					d.Geometry = append(d.Geometry, [2]float64{s.Lat, s.Lon})
				}
			}
			if d.Headsign == "" && len(d.Stops) > 0 {
				d.Headsign = d.Stops[len(d.Stops)-1].Name
			}
			prof.Directions = append(prof.Directions, d)
		}
		if len(prof.Directions) > 0 {
			out = append(out, prof)
		}
	}
	return out, nil
}

// tripStops is a trip's stations in stop_sequence order.
func (t *rtTimetable) tripStops(ctx context.Context, tripID string) ([]rtLineStop, error) {
	rows, err := t.db.QueryContext(ctx, `SELECT st.stop_id, COALESCE(s.name, st.stop_id), s.lat, s.lon
	  FROM stop_times st LEFT JOIN stops s ON s.stop_id = st.stop_id
	  WHERE st.trip_id = ? ORDER BY st.stop_sequence`, tripID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []rtLineStop
	for rows.Next() {
		var s rtLineStop
		var lat, lon sql.NullFloat64
		if err := rows.Scan(&s.ID, &s.Name, &lat, &lon); err != nil {
			return nil, err
		}
		if !lat.Valid || !lon.Valid { // a station without coordinates cannot be drawn
			continue
		}
		s.Name = strings.Join(strings.Fields(s.Name), " ")
		s.Lat, s.Lon = lat.Float64, lon.Float64
		out = append(out, s)
	}
	return out, rows.Err()
}

// shapePoints is a shape's points in order, thinned to rtMaxShapePoints.
func (t *rtTimetable) shapePoints(ctx context.Context, shapeID string) ([][2]float64, error) {
	rows, err := t.db.QueryContext(ctx, `SELECT lat, lon FROM shapes WHERE shape_id = ? ORDER BY seq`, shapeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var pts [][2]float64
	for rows.Next() {
		var p [2]float64
		if err := rows.Scan(&p[0], &p[1]); err != nil {
			return nil, err
		}
		pts = append(pts, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(pts) > rtMaxShapePoints {
		step := (len(pts) + rtMaxShapePoints - 1) / rtMaxShapePoints
		thin := make([][2]float64, 0, rtMaxShapePoints+1)
		for i := 0; i < len(pts); i += step {
			thin = append(thin, pts[i])
		}
		if last := pts[len(pts)-1]; thin[len(thin)-1] != last {
			thin = append(thin, last)
		}
		pts = thin
	}
	return pts, nil
}

// hasPlatformCodes reports whether this timetable has stops.platform_code
// (imported since format 3; an older file lacks it until its next import).
func (t *rtTimetable) hasPlatformCodes(ctx context.Context) bool {
	t.mu.Lock()
	if t.platformChecked {
		v := t.platformCol
		t.mu.Unlock()
		return v
	}
	t.mu.Unlock()
	has := false
	if rows, err := t.db.QueryContext(ctx, `PRAGMA table_info(stops)`); err == nil {
		for rows.Next() {
			var cid, notnull, pk int
			var name, typ string
			var dflt sql.NullString
			if rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk) == nil && name == "platform_code" {
				has = true
			}
		}
		rows.Close()
	}
	t.mu.Lock()
	t.platformChecked, t.platformCol = true, has
	t.mu.Unlock()
	return has
}

// platformSQL is an SQL expression for the platform code of the stop in
// col ("" when the timetable has none).
func (t *rtTimetable) platformSQL(col string) string {
	if !t.hasPlatformCodes(context.Background()) {
		return "''"
	}
	return "COALESCE((SELECT platform_code FROM stops ps WHERE ps.stop_id = " + col + "), '')"
}

// platformCodes lists the platforms of stopID's station as [stop id, code],
// only those with a code.
func (t *rtTimetable) platformCodes(ctx context.Context, stopID string) ([][2]string, error) {
	if !t.hasPlatformCodes(ctx) {
		return nil, nil
	}
	ids, err := t.stationPlatforms(ctx, []string{stopID})
	if err != nil {
		return nil, err
	}
	var out [][2]string
	for _, id := range ids {
		var code sql.NullString
		if t.db.QueryRowContext(ctx, `SELECT platform_code FROM stops WHERE stop_id = ?`, id).Scan(&code) == nil && code.String != "" {
			out = append(out, [2]string{id, code.String})
		}
	}
	return out, nil
}

// scheduledHoursOn is the hours after the service day's reference time
// (0, 1, ... 24, 25 for trips past midnight) in which trains run on one
// service day (calendar and calendar_dates, as for the departures), cached
// per day for the life of the opened timetable. The Dades charts show only
// the clock hours these fall in: an hour with nothing scheduled is not a
// gap in the data.
func (t *rtTimetable) scheduledHoursOn(ctx context.Context, day time.Time) ([]int, error) {
	date := day.Format("20060102")
	t.mu.Lock()
	if h, ok := t.hours[date]; ok {
		t.mu.Unlock()
		return h, nil
	}
	t.mu.Unlock()
	col := gtfsWeekdayColumn[day.Weekday()]
	rows, err := t.db.QueryContext(ctx, `WITH active(service_id) AS (
	    SELECT service_id FROM calendar WHERE start_date <= ?1 AND end_date >= ?1 AND `+col+` = 1
	    UNION SELECT service_id FROM calendar_dates WHERE date = ?1 AND exception_type = 1
	    EXCEPT SELECT service_id FROM calendar_dates WHERE date = ?1 AND exception_type = 2
	  )
	  SELECT DISTINCT COALESCE(st.departure_sec, st.arrival_sec) / 3600 AS h
	    FROM stop_times st JOIN trips tr ON tr.trip_id = st.trip_id
	   WHERE tr.service_id IN (SELECT service_id FROM active)
	     AND COALESCE(st.departure_sec, st.arrival_sec) IS NOT NULL
	   ORDER BY h`, date)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []int{}
	for rows.Next() {
		var h int
		if err := rows.Scan(&h); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	t.mu.Lock()
	if t.hours == nil || len(t.hours) > 32 {
		t.hours = map[string][]int{}
	}
	t.hours[date] = out
	t.mu.Unlock()
	return out, nil
}

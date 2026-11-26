package main

import (
	"archive/zip"
	"context"
	"database/sql"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// runGtfsImport handles CLI dispatch for:
// arribo gtfs-import <agency_id> <gtfs.zip> <out.db> [--bbox minLat,maxLat,minLon,maxLon]
// Exit codes: 0 ok, 1 usage error, 2 import error.
func runGtfsImport(args []string) int {
	usage := func() {
		fmt.Fprintln(os.Stderr, "Usage: arribo gtfs-import <agency_id> <gtfs.zip> <out.db> [--bbox minLat,maxLat,minLon,maxLon]")
	}
	var bboxStr string
	var pos []string
	for i := 0; i < len(args); i++ {
		if args[i] == "--bbox" {
			if i+1 >= len(args) {
				usage()
				return 1
			}
			i++
			bboxStr = args[i]
		} else if strings.HasPrefix(args[i], "--bbox=") {
			bboxStr = strings.TrimPrefix(args[i], "--bbox=")
		} else if strings.HasPrefix(args[i], "-") {
			usage()
			return 1
		} else {
			pos = append(pos, args[i])
		}
	}
	if len(pos) != 3 || pos[0] == "" || pos[1] == "" || pos[2] == "" {
		usage()
		return 1
	}
	var bbox *bboxFilter
	if bboxStr != "" {
		var err error
		if bbox, err = parseBBox(bboxStr); err != nil {
			fmt.Fprintf(os.Stderr, "invalid --bbox: %v\n", err)
			usage()
			return 1
		}
	}
	if err := importGTFS(pos[0], pos[1], pos[2], bbox, bboxStr); err != nil {
		fmt.Fprintf(os.Stderr, "gtfs-import error: %v\n", err)
		return 2
	}
	return 0
}

type bboxFilter struct {
	minLat, maxLat, minLon, maxLon float64
}

func parseBBox(s string) (*bboxFilter, error) {
	parts := strings.Split(s, ",")
	if len(parts) != 4 {
		return nil, fmt.Errorf("expected minLat,maxLat,minLon,maxLon")
	}
	p := make([]float64, 4)
	for i, part := range parts {
		v, err := strconv.ParseFloat(strings.TrimSpace(part), 64)
		if err != nil {
			return nil, fmt.Errorf("invalid coordinate numbers")
		}
		p[i] = v
	}
	if p[0] > p[1] || p[2] > p[3] {
		return nil, fmt.Errorf("min coordinates must be <= max coordinates")
	}
	return &bboxFilter{minLat: p[0], maxLat: p[1], minLon: p[2], maxLon: p[3]}, nil
}

func (b *bboxFilter) contains(lat, lon float64) bool {
	return lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon
}

func parseFloat(s string) (float64, bool) {
	v, err := strconv.ParseFloat(s, 64)
	return v, err == nil && !math.IsNaN(v) && !math.IsInf(v, 0)
}

func parseInt(s string) (int, bool) {
	v, err := strconv.Atoi(s)
	return v, err == nil
}

type csvRow struct {
	rec    []string
	header map[string]int
}

func (r *csvRow) get(col string) string {
	idx, ok := r.header[col]
	if !ok || idx >= len(r.rec) {
		return ""
	}
	return strings.TrimSpace(r.rec[idx])
}

func eachCSV(zf *zip.File, fn func(*csvRow) error) error {
	if zf == nil {
		return nil
	}
	rc, err := zf.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	cr := csv.NewReader(rc)
	cr.FieldsPerRecord, cr.LazyQuotes = -1, true
	headers, err := cr.Read()
	if err == io.EOF {
		return nil // empty file
	}
	if err != nil {
		return fmt.Errorf("%s: header: %w", zf.Name, err)
	}
	hmap := make(map[string]int, len(headers))
	for i, h := range headers {
		h = strings.TrimSpace(h)
		if i == 0 {
			h = strings.TrimPrefix(h, "\ufeff") // strip UTF-8 BOM
		}
		hmap[h] = i
	}
	row := &csvRow{header: hmap}
	for {
		rec, err := cr.Read()
		if err == io.EOF {
			break
		}
		// A malformed CSV row is skipped (the callback is told with a nil
		// record, so it counts it); any other read error, such as a corrupt
		// zip stream, fails the import instead of silently truncating it.
		var perr *csv.ParseError
		if errors.As(err, &perr) {
			row.rec = nil
		} else if err != nil {
			return fmt.Errorf("%s: %w", zf.Name, err)
		} else {
			row.rec = rec
		}
		if err := fn(row); err != nil {
			return err
		}
	}
	return nil
}

func findZipFile(zr *zip.Reader, name string) *zip.File {
	target := strings.ToLower(name)
	for _, f := range zr.File {
		if strings.HasPrefix(f.Name, "__MACOSX") || strings.HasPrefix(filepath.Base(f.Name), "._") {
			continue
		}
		if strings.ToLower(filepath.Base(f.Name)) == target {
			return f
		}
	}
	return nil
}

func parseGTFSTime(s string) (int, error) {
	parts := strings.Split(strings.TrimSpace(s), ":")
	if len(parts) != 3 {
		return 0, fmt.Errorf("invalid time: %q", s)
	}
	h, err1 := strconv.Atoi(parts[0])
	m, err2 := strconv.Atoi(parts[1])
	sec, err3 := strconv.Atoi(parts[2])
	if err1 != nil || err2 != nil || err3 != nil || h < 0 || m < 0 || m >= 60 || sec < 0 || sec >= 60 {
		return 0, fmt.Errorf("invalid time: %q", s)
	}
	return h*3600 + m*60 + sec, nil
}

type idSet map[string]struct{}

func (s idSet) has(id string) bool {
	if s == nil {
		return true
	}
	_, ok := s[id]
	return ok
}

const (
	gtfsSchema = `
CREATE TABLE gtfs_meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE agencies (agency_id TEXT, gtfs_agency_id TEXT, name TEXT, url TEXT, timezone TEXT);
CREATE TABLE routes (agency_id TEXT, route_id TEXT, gtfs_agency_id TEXT, short_name TEXT, long_name TEXT, route_type INTEGER, color TEXT, text_color TEXT);
CREATE TABLE stops (agency_id TEXT, stop_id TEXT, name TEXT, lat REAL, lon REAL, location_type INTEGER, parent_station TEXT, platform_code TEXT);
CREATE TABLE trips (agency_id TEXT, trip_id TEXT, route_id TEXT, service_id TEXT, headsign TEXT, direction_id INTEGER, shape_id TEXT);
CREATE TABLE stop_times (agency_id TEXT, trip_id TEXT, stop_sequence INTEGER, stop_id TEXT, arrival_sec INTEGER, departure_sec INTEGER);
CREATE TABLE calendar (agency_id TEXT, service_id TEXT, monday INTEGER, tuesday INTEGER, wednesday INTEGER, thursday INTEGER, friday INTEGER, saturday INTEGER, sunday INTEGER, start_date TEXT, end_date TEXT);
CREATE TABLE calendar_dates (agency_id TEXT, service_id TEXT, date TEXT, exception_type INTEGER);
CREATE TABLE frequencies (agency_id TEXT, trip_id TEXT, start_sec INTEGER, end_sec INTEGER, headway_secs INTEGER, exact_times INTEGER);
CREATE TABLE shapes (agency_id TEXT, shape_id TEXT, seq INTEGER, lat REAL, lon REAL);
`
	gtfsIndexes = `
CREATE INDEX idx_stop_times_stop ON stop_times(stop_id, departure_sec);
CREATE INDEX idx_stop_times_trip ON stop_times(trip_id, stop_sequence);
CREATE INDEX idx_trips_route ON trips(route_id);
CREATE INDEX idx_trips_trip ON trips(trip_id);
CREATE INDEX idx_trips_service ON trips(service_id);
CREATE INDEX idx_calendar_dates_service ON calendar_dates(service_id, date);
CREATE INDEX idx_calendar_dates_date ON calendar_dates(date, exception_type, service_id);
CREATE INDEX idx_shapes_shape_seq ON shapes(shape_id, seq);
CREATE INDEX idx_stops_stop ON stops(stop_id);
CREATE INDEX idx_stops_parent ON stops(parent_station);
CREATE INDEX idx_routes_route ON routes(route_id);
`
)

func importGTFS(agencyID, zipPath, outPath string, bbox *bboxFilter, bboxStr string) error {
	return importGTFSContext(context.Background(), agencyID, zipPath, outPath, bbox, bboxStr, "")
}

func importGTFSContext(ctx context.Context, agencyID, zipPath, outPath string, bbox *bboxFilter, bboxStr, routeFilter string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	startTime := time.Now()
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("open zip: %w", err)
	}
	defer zr.Close()

	file := func(name string) *zip.File { return findZipFile(&zr.Reader, name) }
	stopsFile, routesFile, tripsFile, stopTimesFile := file("stops.txt"), file("routes.txt"), file("trips.txt"), file("stop_times.txt")
	calFile, calDatesFile, agencyFile := file("calendar.txt"), file("calendar_dates.txt"), file("agency.txt")
	freqFile, shapesFile, feedInfoFile := file("frequencies.txt"), file("shapes.txt"), file("feed_info.txt")

	if stopsFile == nil || routesFile == nil || tripsFile == nil || stopTimesFile == nil {
		return fmt.Errorf("missing required GTFS file (stops, routes, trips, or stop_times)")
	}
	if calFile == nil && calDatesFile == nil {
		return fmt.Errorf("missing calendar: requires calendar.txt or calendar_dates.txt")
	}

	tmpPath := outPath + ".tmp"
	_ = os.Remove(tmpPath)
	if err := os.MkdirAll(filepath.Dir(tmpPath), 0o755); err != nil {
		return fmt.Errorf("create dir: %w", err)
	}
	db, err := sql.Open("sqlite", tmpPath)
	if err != nil {
		return fmt.Errorf("open sqlite: %w", err)
	}
	// One connection, so the PRAGMAs below apply to the connection the import
	// transaction runs on.
	db.SetMaxOpenConns(1)
	success := false
	defer func() {
		if db != nil {
			_ = db.Close()
		}
		if !success {
			_ = os.Remove(tmpPath)
		}
	}()

	if _, err := db.ExecContext(ctx, "PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; "+gtfsSchema); err != nil {
		return fmt.Errorf("init db: %w", err)
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() {
		if !success {
			_ = tx.Rollback()
		}
	}()

	var stmts []*sql.Stmt
	defer func() {
		for _, s := range stmts {
			_ = s.Close()
		}
	}()
	prep := func(q string) *sql.Stmt {
		if err != nil {
			return nil
		}
		var s *sql.Stmt
		if s, err = tx.Prepare(q); err == nil {
			stmts = append(stmts, s)
		}
		return s
	}

	stmtAgency := prep("INSERT INTO agencies (agency_id, gtfs_agency_id, name, url, timezone) VALUES (?, ?, ?, ?, ?)")
	stmtRoute := prep("INSERT INTO routes (agency_id, route_id, gtfs_agency_id, short_name, long_name, route_type, color, text_color) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
	stmtStop := prep("INSERT INTO stops (agency_id, stop_id, name, lat, lon, location_type, parent_station, platform_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
	stmtTrip := prep("INSERT INTO trips (agency_id, trip_id, route_id, service_id, headsign, direction_id, shape_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
	stmtStopTime := prep("INSERT INTO stop_times (agency_id, trip_id, stop_sequence, stop_id, arrival_sec, departure_sec) VALUES (?, ?, ?, ?, ?, ?)")
	stmtCalendar := prep("INSERT INTO calendar (agency_id, service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
	stmtCalendarDate := prep("INSERT INTO calendar_dates (agency_id, service_id, date, exception_type) VALUES (?, ?, ?, ?)")
	stmtFreq := prep("INSERT INTO frequencies (agency_id, trip_id, start_sec, end_sec, headway_secs, exact_times) VALUES (?, ?, ?, ?, ?, ?)")
	stmtShape := prep("INSERT INTO shapes (agency_id, shape_id, seq, lat, lon) VALUES (?, ?, ?, ?, ?)")
	stmtMeta := prep("INSERT OR REPLACE INTO gtfs_meta (key, value) VALUES (?, ?)")
	if err != nil {
		return fmt.Errorf("prepare statements: %w", err)
	}

	kept, skipped := make(map[string]int), make(map[string]int)
	var keptTripIDs, keptRouteIDs, keptServiceIDs, keptShapeIDs, keptStopIDs, keptGtfsAgencyIDs idSet
	parentOf := make(map[string]string)
	filtered := bbox != nil || routeFilter != ""

	if routeFilter != "" {
		keptRouteIDs, keptGtfsAgencyIDs = make(idSet), make(idSet)
		if err := eachCSV(routesFile, func(r *csvRow) error {
			rid, gid := r.get("route_id"), r.get("agency_id")
			if rid != "" && matchGtfsRouteFilter(routeFilter, gid, rid) {
				keptRouteIDs[rid] = struct{}{}
				if gid != "" {
					keptGtfsAgencyIDs[gid] = struct{}{}
				}
			}
			return nil
		}); err != nil {
			return err
		}
		keptTripIDs, keptServiceIDs, keptShapeIDs = make(idSet), make(idSet), make(idSet)
		if err := eachCSV(tripsFile, func(r *csvRow) error {
			tid, rid := r.get("trip_id"), r.get("route_id")
			if tid != "" && keptRouteIDs.has(rid) {
				keptTripIDs[tid] = struct{}{}
			}
			return nil
		}); err != nil {
			return err
		}
		if err := eachCSV(stopsFile, func(r *csvRow) error {
			id := r.get("stop_id")
			if p := r.get("parent_station"); id != "" && p != "" {
				parentOf[id] = p
			}
			return nil
		}); err != nil {
			return err
		}
	}

	if bbox != nil {
		insideStops := make(map[string]bool)
		if err := eachCSV(stopsFile, func(r *csvRow) error {
			id := r.get("stop_id")
			lat, ok1 := parseFloat(r.get("stop_lat"))
			lon, ok2 := parseFloat(r.get("stop_lon"))
			if id == "" || !ok1 || !ok2 {
				return nil
			}
			if p := r.get("parent_station"); p != "" {
				parentOf[id] = p
			}
			if bbox.contains(lat, lon) {
				insideStops[id] = true
			}
			return nil
		}); err != nil {
			return err
		}

		bboxTrips := make(idSet)
		if err := eachCSV(stopTimesFile, func(r *csvRow) error {
			tid, sid := r.get("trip_id"), r.get("stop_id")
			if tid != "" && sid != "" && insideStops[sid] && (keptTripIDs == nil || keptTripIDs.has(tid)) {
				bboxTrips[tid] = struct{}{}
			}
			return nil
		}); err != nil {
			return err
		}
		keptTripIDs = bboxTrips
		keptRouteIDs, keptServiceIDs, keptShapeIDs, keptGtfsAgencyIDs = make(idSet), make(idSet), make(idSet), make(idSet)
	}

	if err := eachCSV(tripsFile, func(r *csvRow) error {
		id, rid, sid := r.get("trip_id"), r.get("route_id"), r.get("service_id")
		if id == "" || rid == "" || sid == "" {
			skipped["trips"]++
			return nil
		}
		var dir any
		if s := r.get("direction_id"); s != "" {
			d, ok := parseInt(s)
			if !ok {
				skipped["trips"]++
				return nil
			}
			dir = d
		}
		if !keptTripIDs.has(id) {
			return nil
		}
		sh := r.get("shape_id")
		if filtered {
			keptRouteIDs[rid], keptServiceIDs[sid] = struct{}{}, struct{}{}
			if sh != "" {
				keptShapeIDs[sh] = struct{}{}
			}
		}
		kept["trips"]++
		_, err := stmtTrip.Exec(agencyID, id, rid, sid, r.get("trip_headsign"), dir, sh)
		return err
	}); err != nil {
		return fmt.Errorf("trips: %w", err)
	}

	usedStopIDs := make(idSet)
	if err := eachCSV(stopTimesFile, func(r *csvRow) error {
		tid, sid := r.get("trip_id"), r.get("stop_id")
		seq, ok := parseInt(r.get("stop_sequence"))
		if tid == "" || sid == "" || !ok {
			skipped["stop_times"]++
			return nil
		}
		arrStr, depStr := r.get("arrival_time"), r.get("departure_time")
		var arrSec, depSec any
		if arrStr == "" && depStr == "" {
			// timepoint-less stop
		} else {
			if arrStr == "" {
				arrStr = depStr
			}
			if depStr == "" {
				depStr = arrStr
			}
			a, err1 := parseGTFSTime(arrStr)
			d, err2 := parseGTFSTime(depStr)
			if err1 != nil || err2 != nil {
				skipped["stop_times"]++
				return nil
			}
			arrSec, depSec = a, d
		}
		if !keptTripIDs.has(tid) {
			return nil
		}
		if filtered {
			usedStopIDs[sid] = struct{}{}
		}
		kept["stop_times"]++
		_, err := stmtStopTime.Exec(agencyID, tid, seq, sid, arrSec, depSec)
		return err
	}); err != nil {
		return fmt.Errorf("stop_times: %w", err)
	}

	if filtered {
		keptStopIDs = make(idSet)
		for sid := range usedStopIDs {
			for curr := sid; curr != ""; curr = parentOf[curr] {
				if _, seen := keptStopIDs[curr]; seen {
					break
				}
				keptStopIDs[curr] = struct{}{}
			}
		}
	}

	if err := eachCSV(stopsFile, func(r *csvRow) error {
		id := r.get("stop_id")
		lat, ok1 := parseFloat(r.get("stop_lat"))
		lon, ok2 := parseFloat(r.get("stop_lon"))
		if id == "" || !ok1 || !ok2 {
			skipped["stops"]++
			return nil
		}
		locType := 0
		if s := r.get("location_type"); s != "" {
			v, ok := parseInt(s)
			if !ok {
				skipped["stops"]++
				return nil
			}
			locType = v
		}
		if !keptStopIDs.has(id) {
			return nil
		}
		kept["stops"]++
		_, err := stmtStop.Exec(agencyID, id, r.get("stop_name"), lat, lon, locType, r.get("parent_station"), r.get("platform_code"))
		return err
	}); err != nil {
		return fmt.Errorf("stops: %w", err)
	}

	if err := eachCSV(routesFile, func(r *csvRow) error {
		id := r.get("route_id")
		rt, ok := parseInt(r.get("route_type"))
		if id == "" || !ok {
			skipped["routes"]++
			return nil
		}
		if !keptRouteIDs.has(id) {
			return nil
		}
		gid := r.get("agency_id")
		if filtered && gid != "" {
			keptGtfsAgencyIDs[gid] = struct{}{}
		}
		kept["routes"]++
		shortName, longName := r.get("route_short_name"), r.get("route_long_name")
		if agencyID == gencatBusAgencyID {
			shortName, longName = parseGencatBusRouteCode(shortName, longName)
		} else if agencyID == atmUrbanAgencyID {
			shortName, longName = formatAtmUrbanRoute(gid, id, shortName, longName)
		}
		_, err := stmtRoute.Exec(agencyID, id, gid, shortName, longName, rt, r.get("route_color"), r.get("route_text_color"))
		return err
	}); err != nil {
		return fmt.Errorf("routes: %w", err)
	}

	if err := eachCSV(agencyFile, func(r *csvRow) error {
		name := r.get("agency_name")
		if name == "" {
			skipped["agencies"]++
			return nil
		}
		gid := r.get("agency_id")
		if filtered && len(keptRouteIDs) > 0 && len(keptGtfsAgencyIDs) > 0 && !keptGtfsAgencyIDs.has(gid) {
			return nil
		}
		if filtered && len(keptRouteIDs) == 0 {
			return nil
		}
		kept["agencies"]++
		_, err := stmtAgency.Exec(agencyID, gid, name, r.get("agency_url"), r.get("agency_timezone"))
		return err
	}); err != nil {
		return fmt.Errorf("agency: %w", err)
	}

	if err := eachCSV(calFile, func(r *csvRow) error {
		id, sd, ed := r.get("service_id"), r.get("start_date"), r.get("end_date")
		if id == "" || sd == "" || ed == "" {
			skipped["calendar"]++
			return nil
		}
		days := make([]any, 7)
		for i, day := range []string{"monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"} {
			v, ok := parseInt(r.get(day))
			if !ok {
				skipped["calendar"]++
				return nil
			}
			days[i] = v
		}
		if !keptServiceIDs.has(id) {
			return nil
		}
		kept["calendar"]++
		_, err := stmtCalendar.Exec(append([]any{agencyID, id}, append(days, sd, ed)...)...)
		return err
	}); err != nil {
		return fmt.Errorf("calendar: %w", err)
	}

	if err := eachCSV(calDatesFile, func(r *csvRow) error {
		id, d := r.get("service_id"), r.get("date")
		et, ok := parseInt(r.get("exception_type"))
		if id == "" || d == "" || !ok {
			skipped["calendar_dates"]++
			return nil
		}
		if !keptServiceIDs.has(id) {
			return nil
		}
		kept["calendar_dates"]++
		_, err := stmtCalendarDate.Exec(agencyID, id, d, et)
		return err
	}); err != nil {
		return fmt.Errorf("calendar_dates: %w", err)
	}

	if err := eachCSV(freqFile, func(r *csvRow) error {
		id, hwStr := r.get("trip_id"), r.get("headway_secs")
		hw, ok := parseInt(hwStr)
		startSec, err1 := parseGTFSTime(r.get("start_time"))
		endSec, err2 := parseGTFSTime(r.get("end_time"))
		if id == "" || !ok || err1 != nil || err2 != nil {
			skipped["frequencies"]++
			return nil
		}
		et := 0
		if s := r.get("exact_times"); s != "" {
			if v, ok := parseInt(s); ok {
				et = v
			} else {
				skipped["frequencies"]++
				return nil
			}
		}
		if !keptTripIDs.has(id) {
			return nil
		}
		kept["frequencies"]++
		_, err := stmtFreq.Exec(agencyID, id, startSec, endSec, hw, et)
		return err
	}); err != nil {
		return fmt.Errorf("frequencies: %w", err)
	}

	if err := eachCSV(shapesFile, func(r *csvRow) error {
		id := r.get("shape_id")
		seq, ok1 := parseInt(r.get("shape_pt_sequence"))
		lat, ok2 := parseFloat(r.get("shape_pt_lat"))
		lon, ok3 := parseFloat(r.get("shape_pt_lon"))
		if id == "" || !ok1 || !ok2 || !ok3 {
			skipped["shapes"]++
			return nil
		}
		if !keptShapeIDs.has(id) {
			return nil
		}
		kept["shapes"]++
		_, err := stmtShape.Exec(agencyID, id, seq, lat, lon)
		return err
	}); err != nil {
		return fmt.Errorf("shapes: %w", err)
	}

	var feedVersion, feedStartDate, feedEndDate string
	_ = eachCSV(feedInfoFile, func(r *csvRow) error {
		if feedVersion == "" && feedStartDate == "" && feedEndDate == "" {
			feedVersion, feedStartDate, feedEndDate = r.get("feed_version"), r.get("feed_start_date"), r.get("feed_end_date")
		}
		return nil
	})

	tableNames := []string{"agencies", "routes", "stops", "trips", "stop_times", "calendar", "calendar_dates", "frequencies", "shapes"}
	meta := [][2]string{
		{"agency_id", agencyID},
		{"source_file", filepath.Base(zipPath)},
		{"imported_at", time.Now().UTC().Format(time.RFC3339)},
	}
	if bboxStr != "" {
		meta = append(meta, [2]string{"bbox", bboxStr})
	}
	if routeFilter != "" {
		meta = append(meta, [2]string{"route_filter", routeFilter})
	}
	if feedVersion != "" {
		meta = append(meta, [2]string{"feed_version", feedVersion})
	}
	if feedStartDate != "" {
		meta = append(meta, [2]string{"feed_start_date", feedStartDate})
	}
	if feedEndDate != "" {
		meta = append(meta, [2]string{"feed_end_date", feedEndDate})
	}
	for _, tbl := range tableNames {
		c := strconv.Itoa(kept[tbl])
		meta = append(meta, [2]string{"rows_" + tbl, c}, [2]string{"count_" + tbl, c})
	}
	for _, p := range meta {
		if _, err := stmtMeta.Exec(p[0], p[1]); err != nil {
			return err
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}
	if _, err := db.ExecContext(ctx, gtfsIndexes); err != nil {
		return fmt.Errorf("create indexes: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	inferred, err := inferDirections(db)
	if err != nil {
		return fmt.Errorf("infer directions: %w", err)
	}
	// A trip without a headsign (all of Renfe's) gets its own last station's
	// name, so departures and trains show where they go.
	filled, err := db.ExecContext(ctx, `UPDATE trips SET headsign = (SELECT s.name FROM stop_times st JOIN stops s ON s.stop_id = st.stop_id
	  WHERE st.trip_id = trips.trip_id ORDER BY st.stop_sequence DESC LIMIT 1) WHERE COALESCE(headsign, '') = ''`)
	if err != nil {
		return fmt.Errorf("fill headsigns: %w", err)
	}
	nFilled, _ := filled.RowsAffected()
	if _, err := db.Exec(`INSERT OR REPLACE INTO gtfs_meta (key, value) VALUES ('import_format', ?), ('directions_inferred', ?), ('headsigns_from_last_stop', ?)`,
		gtfsImportFormat, strconv.Itoa(inferred), strconv.FormatInt(nFilled, 10)); err != nil {
		return fmt.Errorf("meta: %w", err)
	}
	_, _ = db.ExecContext(ctx, "ANALYZE")
	if err := db.Close(); err != nil {
		return fmt.Errorf("close db: %w", err)
	}
	db = nil

	if err := os.Rename(tmpPath, outPath); err != nil {
		return fmt.Errorf("rename to %s: %w", outPath, err)
	}
	success = true

	elapsed := time.Since(startTime)
	fmt.Printf("Imported GTFS in %v:\n", elapsed.Round(time.Millisecond))
	for _, tbl := range tableNames {
		fmt.Printf("  %-16s %7d kept, %5d skipped\n", tbl+":", kept[tbl], skipped[tbl])
	}
	return nil
}

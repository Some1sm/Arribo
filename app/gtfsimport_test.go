package main

import (
	"archive/zip"
	"database/sql"
	"io"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func writeTestZip(t *testing.T, path string, files map[string]string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create zip: %v", err)
	}
	defer f.Close()

	zw := zip.NewWriter(f)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("create zip entry %s: %v", name, err)
		}
		if _, err := io.WriteString(w, content); err != nil {
			t.Fatalf("write zip entry %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
}

func baseValidFeed() map[string]string {
	return map[string]string{
		"agency.txt": "agency_id,agency_name,agency_url,agency_timezone\n" +
			"A1,Test Agency,http://example.com,Europe/Madrid\n",
		"routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_color\n" +
			"R1,A1,1,Route 1,3,FF0000,FFFFFF\n",
		"trips.txt": "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\n" +
			"R1,S1,T1,Station,0,SH1\n",
		"stops.txt": "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n" +
			"ST1,Stop One,41.5381,2.4447,0,\n" +
			"ST2,Stop Two,41.5400,2.4500,0,\n",
		"stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n" +
			"T1,08:00:00,08:00:00,ST1,1\n" +
			"T1,08:15:00,08:15:00,ST2,2\n",
		"calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n" +
			"S1,1,1,1,1,1,0,0,20260101,20261231\n",
	}
}

// 1. BOM on the first header, quoted field with a comma, columns in non-standard order.
func TestGtfsImport_BOM_Quotes_ColumnOrder(t *testing.T) {
	tmpDir := t.TempDir()
	zipPath := filepath.Join(tmpDir, "bom_quotes.zip")
	outDB := filepath.Join(tmpDir, "out.db")

	feed := baseValidFeed()
	// stops.txt with UTF-8 BOM, non-standard column order, and quoted name with comma
	feed["stops.txt"] = "\xef\xbb\xbfstop_lon,stop_id,stop_name,stop_lat\n" +
		"2.4447,ST1,\"Plaça de les Tereses, 1\",41.5381\n" +
		"2.4500,ST2,Estació Rodalies,41.5400\n"

	writeTestZip(t, zipPath, feed)

	code := runGtfsImport([]string{"test_agency", zipPath, outDB})
	if code != 0 {
		t.Fatalf("expected code 0, got %d", code)
	}

	db, err := sql.Open("sqlite", outDB)
	if err != nil {
		t.Fatalf("open out db: %v", err)
	}
	defer db.Close()

	var stopID, name string
	var lat, lon float64
	err = db.QueryRow("SELECT stop_id, name, lat, lon FROM stops WHERE stop_id = 'ST1'").Scan(&stopID, &name, &lat, &lon)
	if err != nil {
		t.Fatalf("query stop ST1: %v", err)
	}
	if stopID != "ST1" || name != "Plaça de les Tereses, 1" || lat != 41.5381 || lon != 2.4447 {
		t.Errorf("unexpected stop values: id=%s name=%q lat=%f lon=%f", stopID, name, lat, lon)
	}
}

// 2. 25:10:00 time, empty arrival_time falling back to departure and vice versa, both empty -> NULL.
func TestGtfsImport_Time25HoursAndFallbacks(t *testing.T) {
	tmpDir := t.TempDir()
	zipPath := filepath.Join(tmpDir, "times.zip")
	outDB := filepath.Join(tmpDir, "out.db")

	feed := baseValidFeed()
	feed["stop_times.txt"] = "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n" +
		"T1,,25:10:00,ST1,1\n" + // empty arrival -> departure: 25*3600 + 10*60 = 90600
		"T1,25:20:00,,ST2,2\n" + // empty departure -> arrival: 25*3600 + 20*60 = 91200
		"T1,,,ST1,3\n" // both empty -> NULL

	writeTestZip(t, zipPath, feed)

	code := runGtfsImport([]string{"test_agency", zipPath, outDB})
	if code != 0 {
		t.Fatalf("expected code 0, got %d", code)
	}

	db, err := sql.Open("sqlite", outDB)
	if err != nil {
		t.Fatalf("open out db: %v", err)
	}
	defer db.Close()

	rows, err := db.Query("SELECT stop_sequence, arrival_sec, departure_sec FROM stop_times ORDER BY stop_sequence")
	if err != nil {
		t.Fatalf("query stop_times: %v", err)
	}
	defer rows.Close()

	type stRow struct {
		seq int
		arr sql.NullInt64
		dep sql.NullInt64
	}
	var res []stRow
	for rows.Next() {
		var r stRow
		if err := rows.Scan(&r.seq, &r.arr, &r.dep); err != nil {
			t.Fatalf("scan row: %v", err)
		}
		res = append(res, r)
	}

	if len(res) != 3 {
		t.Fatalf("expected 3 stop_times, got %d", len(res))
	}

	// seq 1: 90600 for both
	if !res[0].arr.Valid || res[0].arr.Int64 != 90600 || !res[0].dep.Valid || res[0].dep.Int64 != 90600 {
		t.Errorf("seq 1 expected 90600, 90600, got %v, %v", res[0].arr, res[0].dep)
	}
	// seq 2: 91200 for both
	if !res[1].arr.Valid || res[1].arr.Int64 != 91200 || !res[1].dep.Valid || res[1].dep.Int64 != 91200 {
		t.Errorf("seq 2 expected 91200, 91200, got %v, %v", res[1].arr, res[1].dep)
	}
	// seq 3: both NULL
	if res[2].arr.Valid || res[2].dep.Valid {
		t.Errorf("seq 3 expected NULL for arrival and departure, got %v, %v", res[2].arr, res[2].dep)
	}
}

// 3. bbox filter: trip with one stop inside keeps ALL its stops and parent stations;
// trip fully outside is dropped along with its unused stop, route, agency, service.
func TestGtfsImport_BBoxFilter(t *testing.T) {
	tmpDir := t.TempDir()
	zipPath := filepath.Join(tmpDir, "bbox.zip")
	outDB := filepath.Join(tmpDir, "out.db")

	feed := map[string]string{
		"agency.txt": "agency_id,agency_name,agency_url,agency_timezone\n" +
			"AG_IN,Agency Inside,http://example.com,Europe/Madrid\n" +
			"AG_OUT,Agency Outside,http://outside.com,Europe/Madrid\n",
		"routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type\n" +
			"R_KEPT,AG_IN,K1,Kept Route,3\n" +
			"R_DROP,AG_OUT,D1,Dropped Route,3\n",
		"trips.txt": "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\n" +
			"R_KEPT,SERV_KEPT,T_KEPT,InTown,0,SH_KEPT\n" +
			"R_DROP,SERV_DROP,T_DROP,OutTown,0,SH_DROP\n",
		"stops.txt": "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n" +
			"STOP_IN,Inside Stop,41.5381,2.4447,0,\n" + // Inside bbox
			"STOP_OUT_KEPT,Outside But Kept,40.1000,1.1000,0,PARENT_OUT\n" + // Outside, but on T_KEPT
			"PARENT_OUT,Parent Station,40.1000,1.1000,1,\n" + // Parent station of STOP_OUT_KEPT
			"STOP_DROP,Dropped Stop,40.5000,1.5000,0,\n", // Outside, only on T_DROP
		"stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n" +
			"T_KEPT,08:00:00,08:00:00,STOP_IN,1\n" +
			"T_KEPT,08:30:00,08:30:00,STOP_OUT_KEPT,2\n" +
			"T_DROP,09:00:00,09:00:00,STOP_DROP,1\n",
		"calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n" +
			"SERV_KEPT,1,1,1,1,1,0,0,20260101,20261231\n" +
			"SERV_DROP,1,1,1,1,1,0,0,20260101,20261231\n",
		"calendar_dates.txt": "service_id,date,exception_type\n" +
			"SERV_KEPT,20260501,2\n" +
			"SERV_DROP,20260501,2\n",
		"frequencies.txt": "trip_id,start_time,end_time,headway_secs,exact_times\n" +
			"T_KEPT,08:00:00,12:00:00,900,1\n" +
			"T_DROP,09:00:00,13:00:00,900,1\n",
		"shapes.txt": "shape_id,shape_pt_sequence,shape_pt_lat,shape_pt_lon\n" +
			"SH_KEPT,1,41.5381,2.4447\n" +
			"SH_DROP,1,40.5000,1.5000\n",
	}

	writeTestZip(t, zipPath, feed)

	// Bbox around 41.5..41.6, 2.4..2.5 (Mataro area)
	code := runGtfsImport([]string{"renfe", zipPath, outDB, "--bbox", "41.50,41.60,2.40,2.50"})
	if code != 0 {
		t.Fatalf("expected code 0, got %d", code)
	}

	db, err := sql.Open("sqlite", outDB)
	if err != nil {
		t.Fatalf("open out db: %v", err)
	}
	defer db.Close()

	checkCount := func(table, where string, expected int) {
		t.Helper()
		var count int
		q := "SELECT COUNT(*) FROM " + table
		if where != "" {
			q += " WHERE " + where
		}
		if err := db.QueryRow(q).Scan(&count); err != nil {
			t.Fatalf("count %s: %v", table, err)
		}
		if count != expected {
			t.Errorf("table %s (%s): expected %d, got %d", table, where, expected, count)
		}
	}

	checkCount("trips", "trip_id = 'T_KEPT'", 1)
	checkCount("trips", "trip_id = 'T_DROP'", 0)

	// Stop times: both stops of T_KEPT are kept!
	checkCount("stop_times", "trip_id = 'T_KEPT'", 2)
	checkCount("stop_times", "trip_id = 'T_DROP'", 0)

	// Stops: STOP_IN, STOP_OUT_KEPT, and PARENT_OUT must be kept. STOP_DROP must be dropped.
	checkCount("stops", "stop_id = 'STOP_IN'", 1)
	checkCount("stops", "stop_id = 'STOP_OUT_KEPT'", 1)
	checkCount("stops", "stop_id = 'PARENT_OUT'", 1)
	checkCount("stops", "stop_id = 'STOP_DROP'", 0)

	// Routes: R_KEPT kept, R_DROP dropped
	checkCount("routes", "route_id = 'R_KEPT'", 1)
	checkCount("routes", "route_id = 'R_DROP'", 0)

	// Agencies: AG_IN kept, AG_OUT dropped
	checkCount("agencies", "gtfs_agency_id = 'AG_IN'", 1)
	checkCount("agencies", "gtfs_agency_id = 'AG_OUT'", 0)

	// Services: SERV_KEPT kept, SERV_DROP dropped
	checkCount("calendar", "service_id = 'SERV_KEPT'", 1)
	checkCount("calendar", "service_id = 'SERV_DROP'", 0)
	checkCount("calendar_dates", "service_id = 'SERV_KEPT'", 1)
	checkCount("calendar_dates", "service_id = 'SERV_DROP'", 0)

	// Frequencies and shapes
	checkCount("frequencies", "trip_id = 'T_KEPT'", 1)
	checkCount("frequencies", "trip_id = 'T_DROP'", 0)
	checkCount("shapes", "shape_id = 'SH_KEPT'", 1)
	checkCount("shapes", "shape_id = 'SH_DROP'", 0)
}

// 4. calendar_dates-only feed (no calendar.txt).
func TestGtfsImport_CalendarDatesOnly(t *testing.T) {
	tmpDir := t.TempDir()
	zipPath := filepath.Join(tmpDir, "calendar_dates_only.zip")
	outDB := filepath.Join(tmpDir, "out.db")

	feed := baseValidFeed()
	delete(feed, "calendar.txt")
	feed["calendar_dates.txt"] = "service_id,date,exception_type\n" +
		"S1,20260401,1\n" +
		"S1,20260402,1\n"

	writeTestZip(t, zipPath, feed)

	code := runGtfsImport([]string{"test_agency", zipPath, outDB})
	if code != 0 {
		t.Fatalf("expected code 0, got %d", code)
	}

	db, err := sql.Open("sqlite", outDB)
	if err != nil {
		t.Fatalf("open out db: %v", err)
	}
	defer db.Close()

	var calCount, dateCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM calendar").Scan(&calCount); err != nil {
		t.Fatalf("query calendar count: %v", err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM calendar_dates").Scan(&dateCount); err != nil {
		t.Fatalf("query calendar_dates count: %v", err)
	}

	if calCount != 0 {
		t.Errorf("expected 0 calendar rows, got %d", calCount)
	}
	if dateCount != 2 {
		t.Errorf("expected 2 calendar_dates rows, got %d", dateCount)
	}
}

// 5. Missing required file -> error and no output file left behind.
func TestGtfsImport_MissingRequiredFile(t *testing.T) {
	tmpDir := t.TempDir()
	zipPath := filepath.Join(tmpDir, "missing_stop_times.zip")
	outDB := filepath.Join(tmpDir, "out.db")

	feed := baseValidFeed()
	delete(feed, "stop_times.txt")
	writeTestZip(t, zipPath, feed)

	code := runGtfsImport([]string{"test_agency", zipPath, outDB})
	if code != 2 {
		t.Fatalf("expected code 2 (import error), got %d", code)
	}

	if _, err := os.Stat(outDB); !os.IsNotExist(err) {
		t.Errorf("expected %s to not exist after error", outDB)
	}
	if _, err := os.Stat(outDB + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("expected %s.tmp to not exist after error", outDB)
	}

	// Also test missing both calendar.txt and calendar_dates.txt
	feed2 := baseValidFeed()
	delete(feed2, "calendar.txt")
	zipPath2 := filepath.Join(tmpDir, "missing_calendar.zip")
	writeTestZip(t, zipPath2, feed2)

	outDB2 := filepath.Join(tmpDir, "out2.db")
	code2 := runGtfsImport([]string{"test_agency", zipPath2, outDB2})
	if code2 != 2 {
		t.Fatalf("expected code 2, got %d", code2)
	}
	if _, err := os.Stat(outDB2); !os.IsNotExist(err) {
		t.Errorf("expected %s to not exist", outDB2)
	}
	if _, err := os.Stat(outDB2 + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("expected %s.tmp to not exist", outDB2)
	}
}

// 6. That out.db is created by rename (no .tmp left).
func TestGtfsImport_AtomicRenameNoTmpLeft(t *testing.T) {
	tmpDir := t.TempDir()
	zipPath := filepath.Join(tmpDir, "valid.zip")
	outDB := filepath.Join(tmpDir, "out.db")

	feed := baseValidFeed()
	writeTestZip(t, zipPath, feed)

	code := runGtfsImport([]string{"test_agency", zipPath, outDB})
	if code != 0 {
		t.Fatalf("expected code 0, got %d", code)
	}

	if fi, err := os.Stat(outDB); err != nil || fi.Size() == 0 {
		t.Errorf("out.db must exist and be non-empty: err=%v", err)
	}
	if _, err := os.Stat(outDB + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("out.db.tmp must not exist after success")
	}
}

// 7. CLI usage errors: bad args, unknown flags, invalid bbox.
func TestGtfsImport_CLIUsage(t *testing.T) {
	tmpDir := t.TempDir()
	zipPath := filepath.Join(tmpDir, "valid.zip")
	outDB := filepath.Join(tmpDir, "out.db")
	writeTestZip(t, zipPath, baseValidFeed())

	testCases := [][]string{
		{},
		{"only_agency"},
		{"agency", zipPath},
		{"agency", zipPath, outDB, "extra_arg"},
		{"agency", zipPath, outDB, "--bbox"},
		{"agency", zipPath, outDB, "--bbox", "not,enough,coords"},
		{"agency", zipPath, outDB, "--bbox", "42.0,41.0,2.0,3.0"}, // minLat > maxLat
		{"agency", zipPath, outDB, "--unknown-flag"},
	}

	for _, tc := range testCases {
		code := runGtfsImport(tc)
		if code != 1 {
			t.Errorf("args %v: expected exit code 1, got %d", tc, code)
		}
	}
}

// 8. Output metadata and created indexes.
func TestGtfsImport_MetadataAndIndexes(t *testing.T) {
	tmpDir := t.TempDir()
	zipPath := filepath.Join(tmpDir, "meta.zip")
	outDB := filepath.Join(tmpDir, "out.db")

	feed := baseValidFeed()
	feed["feed_info.txt"] = "feed_publisher_name,feed_version,feed_start_date,feed_end_date\n" +
		"Publisher,v1.2.3,20260101,20261231\n"
	writeTestZip(t, zipPath, feed)

	code := runGtfsImport([]string{"mataro", zipPath, outDB, "--bbox=41.0,42.0,2.0,3.0"})
	if code != 0 {
		t.Fatalf("expected code 0, got %d", code)
	}

	db, err := sql.Open("sqlite", outDB)
	if err != nil {
		t.Fatalf("open out db: %v", err)
	}
	defer db.Close()

	getMeta := func(k string) string {
		var v string
		_ = db.QueryRow("SELECT value FROM gtfs_meta WHERE key = ?", k).Scan(&v)
		return v
	}

	if getMeta("agency_id") != "mataro" {
		t.Errorf("expected agency_id mataro, got %q", getMeta("agency_id"))
	}
	if getMeta("source_file") != "meta.zip" {
		t.Errorf("expected source_file meta.zip, got %q", getMeta("source_file"))
	}
	if getMeta("feed_version") != "v1.2.3" {
		t.Errorf("expected feed_version v1.2.3, got %q", getMeta("feed_version"))
	}
	if getMeta("feed_start_date") != "20260101" {
		t.Errorf("expected feed_start_date 20260101, got %q", getMeta("feed_start_date"))
	}
	if getMeta("feed_end_date") != "20261231" {
		t.Errorf("expected feed_end_date 20261231, got %q", getMeta("feed_end_date"))
	}
	if getMeta("bbox") != "41.0,42.0,2.0,3.0" {
		t.Errorf("expected bbox 41.0,42.0,2.0,3.0, got %q", getMeta("bbox"))
	}
	if getMeta("rows_stops") != "2" || getMeta("count_stops") != "2" {
		t.Errorf("expected stops count 2, got %q", getMeta("rows_stops"))
	}

	// Verify all 8 indexes exist
	expectedIndexes := []string{
		"idx_stop_times_stop",
		"idx_stop_times_trip",
		"idx_trips_route",
		"idx_trips_service",
		"idx_calendar_dates_service",
		"idx_shapes_shape_seq",
		"idx_stops_stop",
		"idx_routes_route",
	}

	for _, idx := range expectedIndexes {
		var name string
		err := db.QueryRow("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?", idx).Scan(&name)
		if err != nil || name != idx {
			t.Errorf("expected index %s to exist, err=%v", idx, err)
		}
	}
}

// 9. Finite lat/lon with (0,0) coordinate stop.
func TestGtfsImport_ZeroCoordinateStop(t *testing.T) {
	tmpDir := t.TempDir()
	zipPath := filepath.Join(tmpDir, "zero_coords.zip")
	outDB := filepath.Join(tmpDir, "out.db")

	feed := baseValidFeed()
	feed["stops.txt"] = "stop_id,stop_name,stop_lat,stop_lon\n" +
		"ST_ZERO,Null Island,0,0\n"

	writeTestZip(t, zipPath, feed)

	code := runGtfsImport([]string{"test_agency", zipPath, outDB})
	if code != 0 {
		t.Fatalf("expected code 0, got %d", code)
	}

	db, err := sql.Open("sqlite", outDB)
	if err != nil {
		t.Fatalf("open out db: %v", err)
	}
	defer db.Close()

	var lat, lon float64
	err = db.QueryRow("SELECT lat, lon FROM stops WHERE stop_id = 'ST_ZERO'").Scan(&lat, &lon)
	if err != nil {
		t.Fatalf("query ST_ZERO: %v", err)
	}
	if lat != 0.0 || lon != 0.0 {
		t.Errorf("expected lat 0.0, lon 0.0, got lat=%f lon=%f", lat, lon)
	}
}

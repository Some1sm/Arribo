package main

// Port of src/historyDb.js, part 1: opening the database (schema, pragmas,
// custom SQL functions, migrations), the write paths, and the query helpers.
//
// node:sqlite binds every JavaScript number as REAL and returns INTEGER and
// REAL columns alike as numbers; the helpers below do the same (numbers are
// bound as float64 and read back as float64) so SQL arithmetic and the JSON
// produced from rows match.

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	sqlite "modernc.org/sqlite"
)

const (
	timesSourceDerivedLive     = "derived_timetable"
	timesSourceDerivedBackfill = "derived_timetable_backfill"
	provObserved               = "observed"
	provMixed                  = "mixed"
	provNone                   = "none"
)

func hasStoredTimes(row *Obj) bool {
	if row == nil {
		return false
	}
	return truthy(row.Get("scheduledTime")) && row.Get("scheduledTime") != "" && truthy(row.Get("actualTime")) && row.Get("actualTime") != ""
}

func classifyTimes(row *Obj) string {
	if !hasStoredTimes(row) {
		return provNone
	}
	ts := row.Get("timesSource")
	if ts == timesSourceDerivedBackfill {
		return timesSourceDerivedBackfill
	}
	if ts == timesSourceDerivedLive {
		return timesSourceDerivedLive
	}
	return provObserved
}

type provCounts struct{ observed, derived, backfill, none float64 }

func countTimesProvenance(rows []*Obj) provCounts {
	var c provCounts
	for _, r := range rows {
		switch classifyTimes(r) {
		case provObserved:
			c.observed++
		case timesSourceDerivedLive:
			c.derived++
		case timesSourceDerivedBackfill:
			c.backfill++
		default:
			c.none++
		}
	}
	return c
}

func (c provCounts) toObj() *Obj {
	return O("observed", c.observed, "derived", c.derived, "backfill", c.backfill, "none", c.none)
}

func summariseTimesProvenance(c provCounts) string {
	var present []string
	if c.observed > 0 {
		present = append(present, provObserved)
	}
	if c.derived > 0 {
		present = append(present, timesSourceDerivedLive)
	}
	if c.backfill > 0 {
		present = append(present, timesSourceDerivedBackfill)
	}
	if len(present) == 0 {
		return provNone
	}
	if len(present) == 1 {
		return present[0]
	}
	return provMixed
}

var mataroLineIDs = mataroAgency.LineIDs
var mataroLineCodes = func() []string {
	out := make([]string, len(mataroLineIDs))
	for i, id := range mataroLineIDs {
		out[i] = "L" + id
	}
	return out
}()

func quotedList(xs []string) string {
	q := make([]string, len(xs))
	for i, x := range xs {
		q[i] = "'" + x + "'"
	}
	return strings.Join(q, ", ")
}

// The "all lines" scope of the delay_logs and stop_visits reports: Mataró's rows
// (agency_id) on Mataró's line codes. Every row is Mataró's today, so the
// agency_id term changes no result; it keeps the reports Mataró-only once
// other operators are ingested.
var mataroScopeSQL = " AND agency_id = '" + mataroAgency.ID + "' AND (UPPER(line_code) IN (" + quotedList(mataroLineCodes) + ") AND line_id IN (" +
	quotedList(append(append([]string{}, mataroLineIDs...), mataroLineCodes...)) + "))"
var mataroVisitsScopeSQL = " AND agency_id = '" + mataroAgency.ID + "' AND (UPPER(line_code) IN (" + quotedList(mataroLineCodes) + "))"

// mataroAgencySQL keeps a per-line or per-stop Mataró query on Mataró's
// rows. stop_visits also holds the GTFS-RT operators' station visits under
// their own line codes, and FGC's L6, L7 and L8 share Mataró's codes: a
// filter on line_code alone mixed FGC trains into Mataró's lines 6-8.
var mataroAgencySQL = " AND agency_id = '" + mataroAgency.ID + "'"

func appendMataroScope(where string, isAll bool) string {
	if isAll {
		return where + mataroScopeSQL
	}
	return where
}

const (
	episodeGapMs         = 5 * 60 * 1000
	worstHourMinVisits   = 20
	snapshotContextMs    = 5 * 60 * 1000
	edgeCaseLimit        = 150
	signalMarginMs       = 60 * 1000
	inRelinkSQL          = "EXISTS (SELECT 1 FROM temp.relink_windows rw WHERE rw.vehicle_id = delay_logs.vehicle_id AND rw.line_code = UPPER(delay_logs.line_code) AND delay_logs.timestamp BETWEEN rw.from_ts AND rw.to_ts)"
	visitInRelinkSQL     = "EXISTS (SELECT 1 FROM temp.relink_windows rw WHERE rw.vehicle_id = stop_visits.vehicle_id AND rw.line_code = UPPER(stop_visits.line_code) AND stop_visits.first_ts <= rw.to_ts AND stop_visits.last_ts >= rw.from_ts)"
	defaultSnapshotHours = 6
)

func noLineStatsDB() *Obj {
	return O("totalVisits", 0.0, "totalSamples", 0.0, "sampleCount", 0.0, "avgDelayMins", nil, "maxDelayMins", nil,
		"onTimePct", nil, "earlyPct", nil, "latePct", nil, "moderateLatePct", nil, "severeLatePct", nil, "isBaseline", true)
}

var (
	dataVersionOnce sync.Once
	dataVersion     string
)

// getDataVersion: the source asks git, then package.json. The image has no
// git, so the package.json version is what production reports.
func getDataVersion() string {
	dataVersionOnce.Do(func() {
		if v := os.Getenv("ARRIBO_DATA_VERSION"); v != "" {
			dataVersion = v
			return
		}
		b, err := os.ReadFile(filepath.Join(appRoot, "package.json"))
		if err == nil {
			if pkg, ok := parseJSONValue(b).(*Obj); ok && !isUndef(pkg.Get("version")) {
				dataVersion = "v" + jsString(pkg.Get("version"))
				return
			}
		}
		dataVersion = "v3.0.0"
	})
	return dataVersion
}

// toMadridUtcEpoch reproduces the source's offset trick: the Madrid offset is
// taken at the UTC instant yr-mo-da hr:00Z, then subtracted from it.
func toMadridUtcEpoch(yr, mo, da, hr int) float64 {
	d := dateUTC(yr, mo-1, da, hr, 0, 0)
	t := madridTime(d)
	local := dateUTC(t.Year(), int(t.Month())-1, t.Day(), t.Hour(), t.Minute(), t.Second())
	return float64(d - (local - d))
}

var reMonthStr = regexp.MustCompile(`^\d{4}-\d{2}$`)

type monthRange struct {
	Year, Month    int
	MonthStr       string
	StartTs, EndTs float64
}

func getMadridMonthRange(monthStr any) monthRange {
	var y, m int
	if s, ok := monthStr.(string); ok && reMonthStr.MatchString(s) {
		y = int(parseIntJS(s[:4]))
		m = int(parseIntJS(s[5:]))
	} else {
		t := madridTime(nowMs())
		y, m = t.Year(), int(t.Month())
	}
	nextY, nextM := y, m+1
	if m == 12 {
		nextY, nextM = y+1, 1
	}
	return monthRange{
		Year: y, Month: m,
		MonthStr: numToString(float64(y)) + "-" + padStart(numToString(float64(m)), 2, "0"),
		StartTs:  toMadridUtcEpoch(y, m, 1, 0),
		EndTs:    toMadridUtcEpoch(nextY, nextM, 1, 0),
	}
}

// HistoryDB is the worker's SQLite store.
type HistoryDB struct {
	dbPath                 string
	snapshotRetentionHours float64
	delayRetentionDays     float64
	db                     *sql.DB
	conn                   *sql.Conn
	stopCoords             map[string][2]float64
	stopCoordsLoaded       bool
}

func newHistoryDB() *HistoryDB {
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = filepath.Join(appRoot, "data")
	}
	p := os.Getenv("DB_PATH")
	if p == "" {
		p = filepath.Join(dataDir, "transit_history.db")
	}
	sh := parseFloatJS(strOr(os.Getenv("SNAPSHOT_RETENTION_HOURS"), "6"))
	if !(isFinite(sh) && sh > 0) {
		sh = defaultSnapshotHours
	}
	dd := parseIntJS(strOr(os.Getenv("DELAY_RETENTION_DAYS"), "30"))
	if !(isFinite(dd) && dd > 0) {
		dd = 30
	}
	return &HistoryDB{dbPath: p, snapshotRetentionHours: sh, delayRetentionDays: dd}
}

var sqlFuncsOnce sync.Once

// jsDateMs is new Date(n).getTime(), ok=false for an Invalid Date.
func jsDateMs(n float64) (int64, bool) {
	if !isFinite(n) || math.Abs(n) > 8.64e15 {
		return 0, false
	}
	return int64(math.Trunc(n)), true
}

func sqlArgToJS(v driver.Value) any {
	switch x := v.(type) {
	case nil:
		return nil
	case int64:
		return float64(x)
	case float64:
		return x
	case string:
		return v // already boxed
	case []byte:
		return string(x)
	case bool:
		if x {
			return 1.0
		}
		return 0.0
	case time.Time:
		return float64(x.UnixMilli())
	}
	return v
}

// argTruthy and argNum are truthy / Number() of a SQL function argument as
// the JS callback sees it (sqlArgToJS), without boxing the common numbers.
func argTruthy(v driver.Value) bool {
	switch x := v.(type) {
	case nil:
		return false
	case int64:
		return x != 0
	case float64:
		return truthyNum(x)
	}
	return truthy(sqlArgToJS(v))
}

func argNum(v driver.Value) float64 {
	switch x := v.(type) {
	case int64:
		return float64(x)
	case float64:
		return x
	}
	return jsNumber(sqlArgToJS(v))
}

// depotName is /cotxeres|depot|taller/ on the lower-cased name. For ASCII
// names it compares without building the lower-cased copy.
func depotName(name string) bool {
	for i := 0; i < len(name); i++ {
		if name[i] >= utf8.RuneSelf {
			l := jsLower(name)
			return strings.Contains(l, "cotxeres") || strings.Contains(l, "depot") || strings.Contains(l, "taller")
		}
	}
	return asciiContainsFold(name, "cotxeres") || asciiContainsFold(name, "depot") || asciiContainsFold(name, "taller")
}

// asciiContainsFold: ASCII s contains lower-case ASCII pat, ignoring case.
func asciiContainsFold(s, pat string) bool {
	for i := 0; i+len(pat) <= len(s); i++ {
		j := 0
		for ; j < len(pat); j++ {
			c := s[i+j]
			if c >= 'A' && c <= 'Z' {
				c += 'a' - 'A'
			}
			if c != pat[j] {
				break
			}
		}
		if j == len(pat) {
			return true
		}
	}
	return false
}

var errInvalidTime = errors.New("Invalid time value")

func registerSQLFunctions() {
	sqlFuncsOnce.Do(func() {
		must := func(err error) {
			if err != nil {
				panic(err)
			}
		}
		must(sqlite.RegisterDeterministicScalarFunction("madrid_hour", 1, func(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
			if !argTruthy(args[0]) {
				return "00", nil
			}
			ms, ok := jsDateMs(argNum(args[0]))
			if !ok {
				return nil, errInvalidTime
			}
			return pad2(madridTime(ms).Hour()), nil
		}))
		must(sqlite.RegisterDeterministicScalarFunction("madrid_datetime", 1, func(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
			if !argTruthy(args[0]) {
				return "", nil
			}
			ms, ok := jsDateMs(argNum(args[0]))
			if !ok {
				return nil, errInvalidTime
			}
			return madridTime(ms).Format("2006-01-02 15:04:05"), nil
		}))
		must(sqlite.RegisterDeterministicScalarFunction("is_telemetry_anomaly", 4, func(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
			if !argTruthy(args[0]) {
				return 0.0, nil
			}
			name := ""
			if nv, ok := args[2].(string); ok {
				name = nv
			} else {
				name = jsString(or(sqlArgToJS(args[2]), ""))
			}
			if depotName(name) {
				return 1.0, nil
			}
			t := argNum(args[0])
			line := sqlArgToJS(args[3])
			if isOutsideRevenueService(line, t) {
				return 1.0, nil
			}
			d := argNum(args[1])
			if isFinite(d) && d >= 10 && isServiceStartup(line, t, float64(startupWindowMin)) {
				return 1.0, nil
			}
			return 0.0, nil
		}))
	})
}

func (h *HistoryDB) init() bool { return h.ensureOpen() }

func (h *HistoryDB) ensureOpen() bool {
	if h.conn != nil {
		return true
	}
	if err := os.MkdirAll(filepath.Dir(h.dbPath), 0o755); err != nil {
		log.Printf("[HistoryDB] Failed to initialize SQLite: %s", err.Error())
		return false
	}
	registerSQLFunctions()
	db, err := sql.Open("sqlite", h.dbPath)
	if err == nil {
		db.SetMaxOpenConns(1)
		db.SetMaxIdleConns(1)
		db.SetConnMaxLifetime(0)
		var conn *sql.Conn
		conn, err = db.Conn(context.Background())
		if err == nil {
			h.db, h.conn = db, conn
			err = h.migrate()
		}
		if err != nil {
			if h.conn != nil {
				h.conn.Close()
			}
			db.Close()
			h.db, h.conn = nil, nil
		}
	}
	if err != nil {
		log.Printf("[HistoryDB] Failed to initialize SQLite: %s", err.Error())
		return false
	}
	log.Printf("[HistoryDB] SQLite Database Initialized successfully at %s", h.dbPath)
	return true
}

const historySchema = `
          PRAGMA auto_vacuum = INCREMENTAL;
          PRAGMA journal_mode = WAL;
          PRAGMA busy_timeout = 5000;
          PRAGMA synchronous = NORMAL;
          PRAGMA cache_size = -1024;
          PRAGMA mmap_size = 0;
          PRAGMA wal_autocheckpoint = 200;
          PRAGMA journal_size_limit = 67108864;
          PRAGMA temp_store = MEMORY;

          CREATE TABLE IF NOT EXISTS vehicle_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vehicle_id TEXT NOT NULL,
            line_id TEXT NOT NULL,
            line_code TEXT NOT NULL,
            agency TEXT,
            lat REAL NOT NULL,
            lon REAL NOT NULL,
            speed_kmh REAL DEFAULT 0,
            bearing REAL DEFAULT 0,
            delay_mins INTEGER DEFAULT 0,
            is_realtime INTEGER DEFAULT 1,
            status TEXT DEFAULT 'active',
            timestamp INTEGER NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_veh_time ON vehicle_snapshots(vehicle_id, timestamp);
          CREATE INDEX IF NOT EXISTS idx_line_time ON vehicle_snapshots(line_code, timestamp);
          CREATE INDEX IF NOT EXISTS idx_veh_timestamp ON vehicle_snapshots(timestamp);

          CREATE TABLE IF NOT EXISTS delay_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vehicle_id TEXT DEFAULT '',
            line_id TEXT NOT NULL,
            line_code TEXT NOT NULL,
            agency TEXT,
            stop_id TEXT,
            stop_name TEXT,
            delay_mins INTEGER DEFAULT 0,
            scheduled_time TEXT,
            actual_time TEXT,
            is_realtime INTEGER DEFAULT 1,
            is_delayed INTEGER DEFAULT 0,
            timestamp INTEGER NOT NULL,
            direction TEXT DEFAULT '',
            times_source TEXT DEFAULT '',
            observed_at INTEGER
          );

          -- idx_delay_line / idx_delay_line_timestamp (exact duplicates of each
          -- other) and idx_delay_timestamp (prefix-covered by idx_delay_time_line)
          -- removed as redundant.
          CREATE INDEX IF NOT EXISTS idx_delay_stop ON delay_logs(stop_id, timestamp);
          CREATE INDEX IF NOT EXISTS idx_delay_time_line ON delay_logs(timestamp, line_code);

          -- Stop Visits: One row per bus per stop (Phase 6.4)
          CREATE TABLE IF NOT EXISTS stop_visits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vehicle_id TEXT NOT NULL,
            line_code TEXT NOT NULL,
            direction TEXT DEFAULT '',
            stop_name TEXT NOT NULL,
            first_ts INTEGER NOT NULL,
            last_ts INTEGER NOT NULL,
            delay_mins INTEGER NOT NULL,
            sample_count INTEGER NOT NULL,
            scheduled_time TEXT DEFAULT '',
            actual_time TEXT DEFAULT '',
            times_source TEXT DEFAULT '',
            is_realtime INTEGER DEFAULT 1,
            measured_delay_mins INTEGER,
            source TEXT DEFAULT 'live',
            measured_method TEXT DEFAULT '',
            trip_agrees INTEGER
          );
          CREATE INDEX IF NOT EXISTS idx_visits_time_line ON stop_visits(last_ts, line_code);

          -- Incremental visit rollup progress
          CREATE TABLE IF NOT EXISTS hourly_visit_rollup_progress (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            last_id INTEGER NOT NULL
          );

          -- Hourly Aggregated Visit Rollup Table
          CREATE TABLE IF NOT EXISTS hourly_line_visit_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            line_code TEXT NOT NULL,
            agency TEXT,
            date_hour TEXT NOT NULL,
            visit_count INTEGER DEFAULT 0,
            sample_count INTEGER DEFAULT 0,
            delay_sum REAL DEFAULT 0,
            avg_delay_mins REAL DEFAULT 0,
            max_delay_mins INTEGER DEFAULT 0,
            on_time_count INTEGER DEFAULT 0,
            early_count INTEGER DEFAULT 0,
            late_count INTEGER DEFAULT 0,
            timestamp INTEGER NOT NULL,
            UNIQUE(line_code, date_hour)
          );

          -- Incremental rollup progress. last_id = highest delay_logs.id folded
          -- into hourly_line_stats so successive runs only touch new rows.
          CREATE TABLE IF NOT EXISTS hourly_rollup_progress (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            last_id INTEGER NOT NULL
          );

          -- Option B: Hourly Aggregated Rollup Table (Kept indefinitely with <1 MB/day footprint)
          CREATE TABLE IF NOT EXISTS hourly_line_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            line_code TEXT NOT NULL,
            agency TEXT,
            date_hour TEXT NOT NULL,
            sample_count INTEGER DEFAULT 0,
            avg_delay_mins REAL DEFAULT 0,
            max_delay_mins INTEGER DEFAULT 0,
            on_time_count INTEGER DEFAULT 0,
            late_count INTEGER DEFAULT 0,
            timestamp INTEGER NOT NULL,
            UNIQUE(line_code, date_hour)
          );


          -- Realtime bus observations (delay memory): AMB-tracked arrivals
          -- persisted so downstream stops without realtime coverage can still
          -- show the known delay. Purged after 2 route completions.
          CREATE TABLE IF NOT EXISTS amb_bus_observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agency TEXT NOT NULL,
            line_code TEXT NOT NULL,
            line_id TEXT NOT NULL,
            direction TEXT NOT NULL,
            trip_id TEXT,
            stop_id TEXT NOT NULL,
            stop_name TEXT,
            scheduled_ms INTEGER NOT NULL,
            actual_ms INTEGER NOT NULL,
            delay_mins INTEGER NOT NULL,
            run_duration_secs INTEGER,
            created_ms INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_ambobs_line ON amb_bus_observations(line_id, direction, scheduled_ms);

          -- GPS gaps: one row per silence of 90 s - 15 min in a bus's fixes
          -- (src/core/geo/gpsGapDetector.js). Where the signal was lost and
          -- where it came back; terminal layovers and feed-wide stalls are
          -- kept but flagged, so they can be left off the map.
          CREATE TABLE IF NOT EXISTS gps_gaps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vehicle_id TEXT NOT NULL,
            line_code TEXT NOT NULL,
            direction TEXT DEFAULT '',
            lost_ts INTEGER NOT NULL,
            regained_ts INTEGER NOT NULL,
            gap_sec INTEGER NOT NULL,
            lost_lat REAL NOT NULL,
            lost_lon REAL NOT NULL,
            regained_lat REAL NOT NULL,
            regained_lon REAL NOT NULL,
            stop_name TEXT DEFAULT '',
            at_terminal INTEGER DEFAULT 0,
            feed_wide INTEGER DEFAULT 0
          );
          CREATE INDEX IF NOT EXISTS idx_gps_gaps_time ON gps_gaps(lost_ts, line_code);
        `

func (h *HistoryDB) columnNames(table string) ([]string, error) {
	rows, err := h.all("PRAGMA table_info(" + table + ")")
	if err != nil {
		return nil, err
	}
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = jsString(r.Get("name"))
	}
	return out, nil
}

func (h *HistoryDB) hasColumn(table, col string) (bool, error) {
	cols, err := h.columnNames(table)
	if err != nil {
		return false, err
	}
	for _, c := range cols {
		if c == col {
			return true, nil
		}
	}
	return false, nil
}

// rollupPerAgencyDDL is the shape of the two hourly rollup tables once they
// are keyed per operator: agency_id joins the unique key, so line codes
// shared by several operators (Mataró bus L1, metro L1) get separate
// buckets. historySchema still creates the original shape; a table without
// agency_id is rebuilt into this one, keeping every row and id. %s is the
// table name.
var rollupPerAgencyDDL = map[string]struct{ ddl, cols string }{
	"hourly_line_stats": {`CREATE TABLE %s (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agency_id TEXT NOT NULL DEFAULT 'mataro',
            line_code TEXT NOT NULL,
            agency TEXT,
            date_hour TEXT NOT NULL,
            sample_count INTEGER DEFAULT 0,
            avg_delay_mins REAL DEFAULT 0,
            max_delay_mins INTEGER DEFAULT 0,
            on_time_count INTEGER DEFAULT 0,
            late_count INTEGER DEFAULT 0,
            timestamp INTEGER NOT NULL,
            delay_sum REAL,
            early_count INTEGER,
            UNIQUE(agency_id, line_code, date_hour)
          )`, "id, line_code, agency, date_hour, sample_count, avg_delay_mins, max_delay_mins, on_time_count, late_count, timestamp, delay_sum, early_count"},
	"hourly_line_visit_stats": {`CREATE TABLE %s (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agency_id TEXT NOT NULL DEFAULT 'mataro',
            line_code TEXT NOT NULL,
            agency TEXT,
            date_hour TEXT NOT NULL,
            visit_count INTEGER DEFAULT 0,
            sample_count INTEGER DEFAULT 0,
            delay_sum REAL DEFAULT 0,
            avg_delay_mins REAL DEFAULT 0,
            max_delay_mins INTEGER DEFAULT 0,
            on_time_count INTEGER DEFAULT 0,
            early_count INTEGER DEFAULT 0,
            late_count INTEGER DEFAULT 0,
            timestamp INTEGER NOT NULL,
            UNIQUE(agency_id, line_code, date_hour)
          )`, "id, line_code, agency, date_hour, visit_count, sample_count, delay_sum, avg_delay_mins, max_delay_mins, on_time_count, early_count, late_count, timestamp"},
}

// rebuildRollupsPerAgency rebuilds each rollup table that has no agency_id
// column into rollupPerAgencyDDL, in one transaction per table. Existing
// rows are all Mataró's, which the column default records.
func (h *HistoryDB) rebuildRollupsPerAgency() error {
	for _, table := range []string{"hourly_line_stats", "hourly_line_visit_stats"} {
		ok, err := h.hasColumn(table, "agency_id")
		if err != nil {
			return err
		}
		if ok {
			continue
		}
		spec := rollupPerAgencyDDL[table]
		tmp := table + "_per_agency"
		if err := h.exec("BEGIN IMMEDIATE; DROP TABLE IF EXISTS " + tmp + "; " +
			fmt.Sprintf(spec.ddl, tmp) + "; " +
			"INSERT INTO " + tmp + " (" + spec.cols + ") SELECT " + spec.cols + " FROM " + table + "; " +
			"DROP TABLE " + table + "; ALTER TABLE " + tmp + " RENAME TO " + table + "; COMMIT;"); err != nil {
			_ = h.exec("ROLLBACK")
			return err
		}
	}
	return nil
}

func (h *HistoryDB) migrate() error {
	if err := h.exec(historySchema); err != nil {
		return err
	}
	type add struct{ table, col, ddl string }
	for _, a := range []add{
		{"hourly_line_stats", "delay_sum", "ALTER TABLE hourly_line_stats ADD COLUMN delay_sum REAL;"},
		{"hourly_line_stats", "early_count", "ALTER TABLE hourly_line_stats ADD COLUMN early_count INTEGER;"},
		{"delay_logs", "vehicle_id", "ALTER TABLE delay_logs ADD COLUMN vehicle_id TEXT DEFAULT '';"},
		{"delay_logs", "direction", "ALTER TABLE delay_logs ADD COLUMN direction TEXT DEFAULT '';"},
		{"delay_logs", "times_source", "ALTER TABLE delay_logs ADD COLUMN times_source TEXT DEFAULT '';"},
		{"delay_logs", "observed_at", "ALTER TABLE delay_logs ADD COLUMN observed_at INTEGER;"},
		// Multi-agency groundwork (docs/catalonia-review/REPORT.md, phase 1):
		// which operator and transport mode a row belongs to. Every existing
		// and current row is Mataró's urban bus, so the defaults are exact;
		// no query reads these yet. SQLite adds a column with a constant
		// default without rewriting the table.
		{"delay_logs", "agency_id", "ALTER TABLE delay_logs ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'mataro';"},
		{"delay_logs", "mode", "ALTER TABLE delay_logs ADD COLUMN mode TEXT NOT NULL DEFAULT 'bus';"},
		{"stop_visits", "agency_id", "ALTER TABLE stop_visits ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'mataro';"},
		{"stop_visits", "mode", "ALTER TABLE stop_visits ADD COLUMN mode TEXT NOT NULL DEFAULT 'bus';"},
		{"vehicle_snapshots", "agency_id", "ALTER TABLE vehicle_snapshots ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'mataro';"},
		{"vehicle_snapshots", "mode", "ALTER TABLE vehicle_snapshots ADD COLUMN mode TEXT NOT NULL DEFAULT 'bus';"},
		{"gps_gaps", "agency_id", "ALTER TABLE gps_gaps ADD COLUMN agency_id TEXT NOT NULL DEFAULT 'mataro';"},
		{"gps_gaps", "mode", "ALTER TABLE gps_gaps ADD COLUMN mode TEXT NOT NULL DEFAULT 'bus';"},
	} {
		ok, err := h.hasColumn(a.table, a.col)
		if err != nil {
			return err
		}
		if !ok {
			if err := h.exec(a.ddl); err != nil {
				return err
			}
		}
	}
	if err := h.rebuildRollupsPerAgency(); err != nil {
		return err
	}
	visitCols, err := h.columnNames("stop_visits")
	if err != nil {
		return err
	}
	has := func(c string) bool {
		for _, x := range visitCols {
			if x == c {
				return true
			}
		}
		return false
	}
	if !has("measured_method") {
		if err := h.exec("ALTER TABLE stop_visits ADD COLUMN measured_method TEXT DEFAULT '';"); err != nil {
			return err
		}
	}
	if !has("trip_agrees") {
		if err := h.exec("ALTER TABLE stop_visits ADD COLUMN trip_agrees INTEGER;"); err != nil {
			return err
		}
	}
	// The incident and phantom-stretch readers walk delay_logs vehicle by
	// vehicle in time order (window functions PARTITION BY vehicle_id ORDER
	// BY timestamp, per-vehicle sample reads), and with (vehicle_id,
	// timestamp) alone every row also cost a table lookup. This index
	// replaces it and carries the columns those readers use, so they read
	// the index alone. id follows timestamp so rows with equal timestamps
	// keep the order the old index gave them (by rowid): the window
	// functions' "previous sample" must not change. Rebuilt from 7 days of
	// production delay logs (190k rows): 7-day phantom candidates 340 -> 228
	// ms, backward legs 101 -> 11 ms, data quality 55 -> 34 ms (C SQLite;
	// the Go build gains more), file +11%.
	if err := h.exec(`
          DROP INDEX IF EXISTS idx_delay_veh_time;
          CREATE INDEX IF NOT EXISTS idx_delay_veh_cover ON delay_logs(vehicle_id, timestamp, id, line_code, line_id, agency_id, direction, delay_mins, stop_name);
        `); err != nil {
		return err
	}
	// Every report reads one operator's visits over a time window, often
	// grouped by stop. With rail polling on, trains write about five times as
	// many visits as Mataró's buses, and with only (last_ts, line_code) and
	// (stop_name, last_ts) each Mataró report also read every train row in
	// its window. (agency_id, stop_name, last_ts) replaces (stop_name,
	// last_ts): the one query that filters by stop names also filters by
	// agency. On a synthetic 30-day table at today's volume (1.7M rows, with
	// ANALYZE run, as PRAGMA optimize does here): Mataró per-stop 7 d
	// 272 -> 57 ms and 30 d 1346 -> 252 ms, counts about 2x faster, a
	// Rodalies line's stations 285 -> 131 ms; Rodalies per-station 24 h
	// 18 -> 33 ms; file +23%.
	if err := h.exec(`
          DROP INDEX IF EXISTS idx_visits_stop;
          CREATE INDEX IF NOT EXISTS idx_visits_agency_stop ON stop_visits(agency_id, stop_name, last_ts);
          CREATE INDEX IF NOT EXISTS idx_visits_agency_time ON stop_visits(agency_id, last_ts);
          -- Cancellations the operators announce in their GTFS-RT trip updates
          -- (railcancel.go): one row per operator, trip and service day.
          CREATE TABLE IF NOT EXISTS rail_cancellations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agency_id TEXT NOT NULL,
            trip_id TEXT NOT NULL,
            service_date TEXT NOT NULL,
            line_code TEXT NOT NULL,
            headsign TEXT DEFAULT '',
            scheduled_start INTEGER,
            first_seen INTEGER NOT NULL,
            last_seen INTEGER NOT NULL,
            UNIQUE(agency_id, trip_id, service_date)
          );
          CREATE INDEX IF NOT EXISTS idx_cancel_agency_start ON rail_cancellations(agency_id, scheduled_start);
          -- Platforms Renfe announced for trains approaching a station
          -- (railplatforms.go): sightings per station, line, direction, platform.
          CREATE TABLE IF NOT EXISTS rail_platforms (
            agency_id TEXT NOT NULL,
            stop_id TEXT NOT NULL,
            line_code TEXT NOT NULL,
            direction INTEGER NOT NULL,
            platform TEXT NOT NULL,
            sightings INTEGER NOT NULL,
            first_seen INTEGER NOT NULL,
            last_seen INTEGER NOT NULL,
            PRIMARY KEY (agency_id, stop_id, line_code, direction, platform)
          );
          -- Train punctuality kept beyond the raw retention (railhistory.go).
          CREATE TABLE IF NOT EXISTS rail_hourly_stats (
            agency_id TEXT NOT NULL,
            line_code TEXT NOT NULL,
            date_hour TEXT NOT NULL,
            visits INTEGER NOT NULL,
            delay_sum REAL NOT NULL,
            max_delay INTEGER NOT NULL,
            early INTEGER NOT NULL,
            on_time INTEGER NOT NULL,
            late15 INTEGER NOT NULL,
            late30 INTEGER NOT NULL,
            late60 INTEGER NOT NULL,
            late_over60 INTEGER NOT NULL,
            first_ts INTEGER NOT NULL,
            PRIMARY KEY (agency_id, line_code, date_hour)
          );
          CREATE TABLE IF NOT EXISTS rail_daily_station_stats (
            agency_id TEXT NOT NULL,
            line_code TEXT NOT NULL,
            stop_name TEXT NOT NULL,
            service_date TEXT NOT NULL,
            visits INTEGER NOT NULL,
            delay_sum REAL NOT NULL,
            max_delay INTEGER NOT NULL,
            early INTEGER NOT NULL,
            on_time INTEGER NOT NULL,
            late15 INTEGER NOT NULL,
            late30 INTEGER NOT NULL,
            late60 INTEGER NOT NULL,
            late_over60 INTEGER NOT NULL,
            first_ts INTEGER NOT NULL,
            PRIMARY KEY (agency_id, line_code, stop_name, service_date)
          );
          CREATE INDEX IF NOT EXISTS idx_rail_daily_agency_date ON rail_daily_station_stats(agency_id, service_date);
          CREATE TABLE IF NOT EXISTS rail_rollup_progress (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            last_id INTEGER NOT NULL
          );
          -- Cancellations per operator, line and Madrid day of the scheduled
          -- start, kept beyond the raw retention (railhistory.go).
          CREATE TABLE IF NOT EXISTS rail_daily_cancellations (
            agency_id TEXT NOT NULL,
            line_code TEXT NOT NULL,
            service_date TEXT NOT NULL,
            cancelled INTEGER NOT NULL,
            PRIMARY KEY (agency_id, line_code, service_date)
          );
          CREATE TABLE IF NOT EXISTS rail_cancel_rollup_progress (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            last_id INTEGER NOT NULL
          );
          -- The Mataró hourly visit rollup is Mataró's only: train rows there
          -- used the bus on-time rule and nothing read them.
          DELETE FROM hourly_line_visit_stats WHERE agency_id <> 'mataro';
        `); err != nil {
		return err
	}
	return h.exec(`
          DROP INDEX IF EXISTS idx_delay_line;
          DROP INDEX IF EXISTS idx_delay_timestamp;
          DROP INDEX IF EXISTS idx_delay_line_timestamp;
          DROP INDEX IF EXISTS idx_delay_stop_timestamp;
          DROP INDEX IF EXISTS idx_hourly_stats;
        `)
}

// ---------------------------------------------------------------- helpers

// bindArgs converts JavaScript-shaped values to what node:sqlite would bind:
// every number as REAL, booleans refused.
func bindArgs(args []any) ([]any, error) {
	out := make([]any, len(args))
	for i, a := range args {
		switch x := a.(type) {
		case nil:
			out[i] = nil
		case float64:
			out[i] = x
		case int:
			out[i] = float64(x)
		case int64:
			out[i] = float64(x)
		case string:
			out[i] = x
		case JSDate:
			return nil, fmt.Errorf("Provided value cannot be bound to SQLite parameter %d.", i+1)
		default:
			if isUndef(a) {
				return nil, fmt.Errorf("Provided value cannot be bound to SQLite parameter %d.", i+1)
			}
			return nil, fmt.Errorf("Provided value cannot be bound to SQLite parameter %d.", i+1)
		}
	}
	return out, nil
}

func (h *HistoryDB) exec(q string, args ...any) error {
	b, err := bindArgs(args)
	if err != nil {
		return err
	}
	_, err = h.conn.ExecContext(context.Background(), q, b...)
	return err
}

type runResult struct{ changes, lastID float64 }

func (h *HistoryDB) run(q string, args ...any) (runResult, error) {
	b, err := bindArgs(args)
	if err != nil {
		return runResult{}, err
	}
	res, err := h.conn.ExecContext(context.Background(), q, b...)
	if err != nil {
		return runResult{}, err
	}
	n, _ := res.RowsAffected()
	id, _ := res.LastInsertId()
	return runResult{changes: float64(n), lastID: float64(id)}, nil
}

func sqlValueToJS(v any) any {
	switch x := v.(type) {
	case nil:
		return nil
	case int64:
		return float64(x)
	case float64:
		return x
	case string:
		return v // already boxed
	case []byte:
		return string(x)
	case bool:
		if x {
			return 1.0
		}
		return 0.0
	case time.Time:
		return x.Format(time.RFC3339Nano)
	}
	return v
}

// all is stmt.all(...): every row as an object keyed by column name.
func (h *HistoryDB) all(q string, args ...any) ([]*Obj, error) {
	return h.rows(q, -1, args...)
}

// rows runs q and returns up to max rows (all when max < 0). Each row is an
// object keyed by column name; a repeated column name keeps its first
// position and takes the last value, as in better-sqlite3.
func (h *HistoryDB) rows(q string, max int, args ...any) ([]*Obj, error) {
	out := []*Obj{}
	err := h.each(q, args, func(cols []string, vals []any) bool {
		o := &Obj{kvs: make([]objKV, 0, len(cols))}
		for i, c := range cols {
			o.Set(c, vals[i])
		}
		out = append(out, o)
		return max < 0 || len(out) < max
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// each runs q and calls fn with every row's values (converted as in rows)
// until fn returns false; vals is reused between calls. It lets a large
// result be reduced as it is read instead of being held as objects.
func (h *HistoryDB) each(q string, args []any, fn func(cols []string, vals []any) bool) error {
	b, err := bindArgs(args)
	if err != nil {
		return err
	}
	rows, err := h.conn.QueryContext(context.Background(), q, b...)
	if err != nil {
		return err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return err
	}
	raw := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range raw {
		ptrs[i] = &raw[i]
	}
	vals := make([]any, len(cols))
	// Short text values (line codes, vehicle and stop ids, enum-like flags)
	// repeat on most rows; keeping one copy each makes a large result much
	// smaller while it is held. The map keeps the boxed value, so a repeat
	// is not boxed again.
	intern := map[string]any{}
	for rows.Next() {
		if err := rows.Scan(ptrs...); err != nil {
			return err
		}
		for i := range raw {
			v := sqlValueToJS(raw[i])
			if str, ok := v.(string); ok && len(str) <= internMaxLen {
				if kept, ok := intern[str]; ok {
					v = kept
				} else {
					intern[str] = v
				}
			}
			vals[i] = v
		}
		if !fn(cols, vals) {
			break
		}
	}
	return rows.Err()
}

// get is stmt.get(...): the first row, or nil where the source gets undefined.
// Like better-sqlite3 it stops stepping after that row.
func (h *HistoryDB) get(q string, args ...any) (*Obj, error) {
	rows, err := h.rows(q, 1, args...)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}

// objs converts rows to []any for JSON output.
func objsToAny(rows []*Obj) []any {
	out := make([]any, len(rows))
	for i, r := range rows {
		out[i] = r
	}
	return out
}

// ---------------------------------------------------------------- writes

func finiteOr(v any, def any) any {
	if n := jsNumber(v); isFinite(n) {
		return n
	}
	return def
}

func (h *HistoryDB) recordVehicleSnapshot(snap *Obj) {
	if snap == nil || !truthy(snap.Get("vehicleId")) {
		return
	}
	if !h.ensureOpen() {
		return
	}
	ts := snap.Get("timestamp")
	if !truthy(ts) {
		ts = float64(nowMs())
	}
	rt := 0.0
	if snap.Get("isRealTime") != false {
		rt = 1
	}
	agencyID, mode := rowAgency(snap)
	_, _ = h.run(`
          INSERT INTO vehicle_snapshots
          (vehicle_id, line_id, line_code, agency, lat, lon, speed_kmh, bearing, delay_mins, is_realtime, status, timestamp, agency_id, mode)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
		jsString(snap.Get("vehicleId")),
		jsString(or(snap.Get("lineId"), "")),
		jsUpper(jsString(or(snap.Get("lineCode"), ""))),
		jsString(or(snap.Get("agency"), "Transit")),
		finiteOr(snap.Get("lat"), 0.0),
		finiteOr(snap.Get("lon"), 0.0),
		finiteOr(snap.Get("speedKmh"), nil),
		finiteOr(snap.Get("bearing"), 0.0),
		finiteOr(snap.Get("delayMins"), nil),
		rt,
		jsString(or(snap.Get("status"), "active")),
		bindNumberish(ts),
		agencyID, mode,
	)
}

// rowAgency is the operator and transport mode a history row is stored
// under: the record's agencyId / mode when the caller gives them, else
// Mataró's urban bus, which every caller is today.
func rowAgency(o *Obj) (string, string) {
	return jsString(or(o.Get("agencyId"), "mataro")), jsString(or(o.Get("mode"), "bus"))
}

// bindNumberish binds a value the way the source passes it straight through
// (a number, or whatever the caller put there).
func bindNumberish(v any) any {
	switch x := v.(type) {
	case float64, string, nil:
		return x
	case bool:
		return v // refused by bindArgs, like node:sqlite
	}
	return v
}

func (h *HistoryDB) stopCoordsMap() map[string][2]float64 {
	if h.stopCoordsLoaded {
		return h.stopCoords
	}
	h.stopCoordsLoaded = true
	h.stopCoords = map[string][2]float64{}
	b, err := os.ReadFile(filepath.Join(appRoot, "data", "cities", "mataro", "mataro_paradas.json"))
	if err != nil {
		return h.stopCoords
	}
	raw := parseJSONValue(b)
	var list []any
	if a, ok := raw.([]any); ok {
		list = a
	} else if o, ok := raw.(*Obj); ok {
		list, _ = or(o.Get("message"), []any{}).([]any)
	}
	for _, x := range list {
		p, _ := x.(*Obj)
		if p == nil {
			continue
		}
		name, ok := p.Get("name").(string)
		lat, ok1 := p.Get("latitude").(float64)
		lon, ok2 := p.Get("longitude").(float64)
		if !ok || name == "" || !ok1 || !ok2 || !isFinite(lat) || !isFinite(lon) {
			continue
		}
		clean := jsLower(jsTrim(strings.SplitN(name, " - ", 2)[0]))
		h.stopCoords[clean] = [2]float64{lat, lon}
	}
	return h.stopCoords
}

func (h *HistoryDB) stopDistance(a, b string) any {
	if a == "" || b == "" {
		return nil
	}
	if jsLower(a) == jsLower(b) {
		return 0.0
	}
	m := h.stopCoordsMap()
	pa, okA := m[jsLower(jsTrim(strings.SplitN(a, " - ", 2)[0]))]
	pb, okB := m[jsLower(jsTrim(strings.SplitN(b, " - ", 2)[0]))]
	if !okA || !okB {
		return nil
	}
	dLat := (pb[0] - pa[0]) * 111320
	dLon := (pb[1] - pa[1]) * 83300
	return math.Sqrt(dLat*dLat + dLon*dLon)
}

func (h *HistoryDB) recordDelayLog(e *Obj) {
	if e == nil || !truthy(e.Get("lineCode")) {
		return
	}
	if !h.ensureOpen() {
		return
	}
	delay := jsNumber(e.Get("delayMins"))
	if !isFinite(delay) || delay <= -15 || delay > 300 {
		return
	}
	rt, delayed := 0.0, 0.0
	if truthy(e.Get("isRealTime")) {
		rt = 1
	}
	if delay > 3 {
		delayed = 1
	}
	ts := e.Get("timestamp")
	if !truthy(ts) {
		ts = float64(nowMs())
	}
	agencyID, mode := rowAgency(e)
	_, _ = h.run(`
          INSERT INTO delay_logs
          (vehicle_id, line_id, line_code, agency, stop_id, stop_name, delay_mins, scheduled_time, actual_time, is_realtime, is_delayed, timestamp, direction, times_source, observed_at, agency_id, mode)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
		jsString(or(e.Get("vehicleId"), "")),
		jsString(or(e.Get("lineId"), "")),
		jsUpper(jsString(or(e.Get("lineCode"), ""))),
		jsString(or(e.Get("agency"), "Transit")),
		jsString(or(e.Get("stopId"), "")),
		jsString(or(e.Get("stopName"), "")),
		delay,
		jsString(or(e.Get("scheduledTime"), "")),
		jsString(or(e.Get("actualTime"), "")),
		rt, delayed,
		bindNumberish(ts),
		jsString(or(e.Get("direction"), "")),
		jsString(or(e.Get("timesSource"), "")),
		finiteOr(e.Get("observedAt"), nil),
		agencyID, mode,
	)
}

func (h *HistoryDB) recordStopVisit(v *Obj) {
	if v == nil || !truthy(v.Get("lineCode")) || !truthy(v.Get("vehicleId")) || !truthy(v.Get("stopName")) {
		return
	}
	if !h.ensureOpen() {
		return
	}
	delay := jsNumber(v.Get("delayMins"))
	if !isFinite(delay) || delay <= -15 || delay > 300 {
		return
	}
	now := float64(nowMs())
	dir := ""
	if !v.IsUndef("direction") {
		dir = jsString(v.Get("direction"))
	}
	rt := 0.0
	if v.Get("isRealTime") != false {
		rt = 1
	}
	var measured any
	if m := v.Get("measuredDelayMins"); !isNullish(m) {
		measured = jsNumber(m)
	}
	var agrees any
	if a, ok := v.Get("tripAgrees").(float64); ok && (a == 1 || a == 0) {
		agrees = a
	}
	agencyID, mode := rowAgency(v)
	_, _ = h.run(`
          INSERT INTO stop_visits
          (vehicle_id, line_code, direction, stop_name, first_ts, last_ts, delay_mins, sample_count, scheduled_time, actual_time, times_source, is_realtime, measured_delay_mins, source, measured_method, trip_agrees, agency_id, mode)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
		jsString(or(v.Get("vehicleId"), "")),
		jsUpper(jsString(or(v.Get("lineCode"), ""))),
		dir,
		jsString(or(v.Get("stopName"), "")),
		jsNumber(or(v.Get("firstTs"), or(v.Get("lastTs"), now))),
		jsNumber(or(v.Get("lastTs"), now)),
		delay,
		jsNumber(or(v.Get("sampleCount"), 1.0)),
		jsString(or(v.Get("scheduledTime"), "")),
		jsString(or(v.Get("actualTime"), "")),
		jsString(or(v.Get("timesSource"), "")),
		rt,
		measured,
		jsString(or(v.Get("source"), "live")),
		jsString(or(v.Get("measuredMethod"), "")),
		agrees,
		agencyID, mode,
	)
}

func (h *HistoryDB) recordGpsGap(g *Obj) {
	if g == nil || !truthy(g.Get("vehicleId")) {
		return
	}
	if !h.ensureOpen() {
		return
	}
	b2f := func(v any) float64 {
		if truthy(v) {
			return 1
		}
		return 0
	}
	gap := jsNumber(g.Get("gapSec"))
	if math.IsNaN(gap) || gap == 0 {
		gap = 0
	}
	agencyID, mode := rowAgency(g)
	_, _ = h.run(`
          INSERT INTO gps_gaps
          (vehicle_id, line_code, direction, lost_ts, regained_ts, gap_sec, lost_lat, lost_lon, regained_lat, regained_lon, stop_name, at_terminal, feed_wide, agency_id, mode)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
		jsString(g.Get("vehicleId")),
		jsUpper(jsString(or(g.Get("lineCode"), ""))),
		jsString(or(g.Get("direction"), "")),
		jsNumber(g.Get("lostTs")),
		jsNumber(g.Get("regainedTs")),
		jsRound(gap),
		jsNumber(g.Get("lostLat")),
		jsNumber(g.Get("lostLon")),
		jsNumber(g.Get("regainedLat")),
		jsNumber(g.Get("regainedLon")),
		jsString(or(g.Get("stopName"), "")),
		b2f(g.Get("atTerminal")),
		b2f(g.Get("feedWide")),
		agencyID, mode,
	)
}

func (h *HistoryDB) getVehicleTrail(vehicleID any, minutesBack float64) []any {
	if !h.ensureOpen() {
		return []any{}
	}
	cutoff := float64(nowMs()) - minutesBack*60*1000
	rows, err := h.all(`
        SELECT lat, lon, speed_kmh as speedKmh, bearing, delay_mins as delayMins, timestamp
        FROM vehicle_snapshots
        WHERE vehicle_id = ? AND timestamp >= ?
        ORDER BY timestamp ASC
        LIMIT 100
      `, jsString(vehicleID), cutoff)
	if err != nil {
		log.Printf("[HistoryDB] getVehicleTrail error: %s", err.Error())
		return []any{}
	}
	return objsToAny(rows)
}

func (h *HistoryDB) close() {
	if h.conn == nil {
		return
	}
	h.closeDB()
}

// parseJSONValue is JSON.parse for a file's bytes (undefined on error).
func parseJSONValue(b []byte) any {
	v, err := parseJSON(b)
	if err != nil {
		return Undefined
	}
	return v
}

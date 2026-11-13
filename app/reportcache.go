package main

// Port of src/reportCacheService.js. Node keeps one instance per process; so
// does this (the worker's generates, the server's is fed by
// REPORT_CACHE_UPDATE). A report is about 1.4 MB of JSON, so it is held as
// compact JSON split into its top-level fields, never as an object tree, and
// both instances share the same immutable entries.

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type rawField struct {
	k string
	v []byte
}

// reportEntry is one report as JSON: its top-level keys in order, each with
// its value's compact JSON.
type reportEntry struct {
	fields []rawField
	// metaTs is report.meta.generatedTimestamp when it is a number.
	metaTs    float64
	hasMetaTs bool
}

func (r *reportEntry) WriteJSON(b *bytes.Buffer) {
	b.WriteByte('{')
	for i, f := range r.fields {
		if i > 0 {
			b.WriteByte(',')
		}
		writeJSONString(b, f.k)
		b.WriteByte(':')
		b.Write(f.v)
	}
	b.WriteByte('}')
}

func (r *reportEntry) raw(k string) ([]byte, bool) {
	for _, f := range r.fields {
		if f.k == k {
			return f.v, true
		}
	}
	return nil, false
}

// get is report[k] (Undefined when absent), parsed afresh.
func (r *reportEntry) get(k string) any {
	b, ok := r.raw(k)
	if !ok {
		return Undefined
	}
	v, err := parseJSON(b)
	if err != nil {
		return Undefined
	}
	return v
}

// spreadInto is {...o, ...report}: each field keeps its JSON verbatim.
func (r *reportEntry) spreadInto(o *Obj) *Obj {
	for _, f := range r.fields {
		o.Set(f.k, rawJSON(f.v))
	}
	return o
}

// newReportEntry serializes v (a JSON object) as JSON.stringify would.
func newReportEntry(v any) *reportEntry {
	e, err := reportEntryFromJSON(toJSON(v))
	if err != nil {
		return nil
	}
	return e
}

// reportEntryFromJSON splits a compact JSON object into its fields.
func reportEntryFromJSON(b []byte) (*reportEntry, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	t, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if d, ok := t.(json.Delim); !ok || d != '{' {
		return nil, errors.New("report is not an object")
	}
	e := &reportEntry{}
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return nil, err
		}
		k, _ := kt.(string)
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return nil, err
		}
		// Exact-size copy: the decoder's buffer can be twice as large.
		v := make([]byte, len(raw))
		copy(v, raw)
		e.fields = append(e.fields, rawField{k, v})
	}
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("unexpected trailing data")
	}
	if m, ok := e.get("meta").(*Obj); ok {
		if ts, isNum := m.Get("generatedTimestamp").(float64); isNum && isFinite(ts) {
			e.metaTs, e.hasMetaTs = ts, true
		}
	}
	return e, nil
}

type ReportCache struct {
	w                   *World
	reportsDir          string
	maxRetention        int
	supportedHours      []int
	cached              map[string]*reportEntry
	isGenerating        bool
	ipc                 func(typ string, payload any)
	consecutiveFailures map[string]int
	db                  *HistoryDB
}

// Both instances (worker and server) read the same files at start-up; one
// parse serves both. The second read takes the entry out, so the start-up
// reports are not kept once newer ones replace them.
var (
	reportFileMu    sync.Mutex
	reportFileCache = map[string]*reportEntry{}
)

func newReportCache(w *World) *ReportCache {
	dir := os.Getenv("REPORTS_DIR")
	if dir == "" {
		dir = filepath.Join(appRoot, "data", "reports")
	}
	c := &ReportCache{
		w:                   w,
		reportsDir:          dir,
		maxRetention:        2,
		supportedHours:      []int{24, 48, 168},
		cached:              map[string]*reportEntry{},
		consecutiveFailures: map[string]int{},
	}
	c.init()
	return c
}

func (c *ReportCache) setDatabase(db *HistoryDB)                       { c.db = db }
func (c *ReportCache) setIpcCallback(fn func(typ string, payload any)) { c.ipc = fn }

func (c *ReportCache) emitIpc(typ string, payload any) {
	if c.ipc != nil {
		c.ipc(typ, payload)
	}
}

func (c *ReportCache) updateMemoryCache(hours any, report *reportEntry) {
	if report == nil {
		return
	}
	h := c.normalizeHours(hours)
	c.cached[itoa(h)] = report
	log.Printf("[ReportCacheService] ⚡ Memory cache updated via IPC for %dh report", h)
}

func (c *ReportCache) init() {
	if _, err := os.Stat(c.reportsDir); err != nil {
		if err := os.MkdirAll(c.reportsDir, 0o755); err != nil {
			log.Printf("[ReportCacheService] Init error: %v", err)
			return
		}
		log.Printf("[ReportCacheService] Created reports directory: %s", c.reportsDir)
	}
	c.loadLatestFromDisk()
	c.pruneOldReports()
}

func (c *ReportCache) normalizeHours(hours any) int {
	n := parseIntJS(or(hours, "24"))
	if n <= 36 {
		return 24
	}
	if n <= 96 {
		return 48
	}
	return 168
}

type reportFile struct {
	filename, fullPath string
	mtime              float64
}

func (c *ReportCache) getReportFilesForHours(h int) []reportFile {
	entries, err := os.ReadDir(c.reportsDir)
	if err != nil {
		return nil
	}
	prefix := "journalism_report_" + itoa(h) + "h_"
	var out []reportFile
	for _, de := range entries {
		f := de.Name()
		if !strings.HasPrefix(f, prefix) || !strings.HasSuffix(f, ".json") {
			continue
		}
		full := filepath.Join(c.reportsDir, f)
		st, err := os.Stat(full)
		if err != nil {
			return nil
		}
		out = append(out, reportFile{f, full, float64(st.ModTime().UnixNano()) / 1e6})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].mtime > out[j].mtime })
	return out
}

func (c *ReportCache) loadLatestFromDisk() {
	for _, h := range c.supportedHours {
		files := c.getReportFilesForHours(h)
		if len(files) == 0 {
			continue
		}
		latest := files[0]
		e, err := loadReportFile(latest)
		if err != nil {
			log.Printf("[ReportCacheService] Error reading %s: %v", latest.filename, err)
			continue
		}
		if s, ok := e.get("summary").(*Obj); ok && s.Len() > 0 {
			c.cached[itoa(h)] = e
			gen := "unknown"
			if m, ok := e.get("meta").(*Obj); ok && truthy(m.Get("generatedAt")) {
				gen = jsString(m.Get("generatedAt"))
			}
			log.Printf("[ReportCacheService] ⚡ Loaded pre-generated %dh report from disk (%s, generated at %s)", h, latest.filename, gen)
		} else {
			log.Printf("[ReportCacheService] ⚠️ Skipping corrupted/empty report on disk: %s", latest.filename)
		}
	}
}

// loadReportFile reads a report as JSON.parse would, then keeps it as
// compact JSON.
func loadReportFile(f reportFile) (*reportEntry, error) {
	key := f.fullPath + "|" + numToString(f.mtime)
	reportFileMu.Lock()
	if e, ok := reportFileCache[key]; ok {
		delete(reportFileCache, key)
		reportFileMu.Unlock()
		return e, nil
	}
	reportFileMu.Unlock()
	b, err := os.ReadFile(f.fullPath)
	if err != nil {
		return nil, err
	}
	v, err := parseJSON(b)
	if err != nil {
		return nil, err
	}
	if _, ok := v.(*Obj); !ok {
		return nil, errors.New("not an object")
	}
	e := newReportEntry(v)
	if e == nil {
		return nil, errors.New("unserializable report")
	}
	reportFileMu.Lock()
	reportFileCache[key] = e
	reportFileMu.Unlock()
	return e, nil
}

func (c *ReportCache) pruneOldReports() {
	for _, h := range c.supportedHours {
		files := c.getReportFilesForHours(h)
		if len(files) > c.maxRetention {
			for _, f := range files[c.maxRetention:] {
				if err := os.Remove(f.fullPath); err != nil {
					log.Printf("[ReportCacheService] Error pruning %s: %v", f.filename, err)
				} else {
					log.Printf("[ReportCacheService] 🧹 Pruned old %dh report file: %s (keeping max %d)", h, f.filename, c.maxRetention)
				}
			}
		}
	}
	entries, err := os.ReadDir(c.reportsDir)
	if err != nil {
		return
	}
	for _, de := range entries {
		f := de.Name()
		if strings.HasPrefix(f, "journalism_report_") && !strings.Contains(f, "h_") && strings.HasSuffix(f, ".json") {
			os.Remove(filepath.Join(c.reportsDir, f))
		}
	}
}

var errNoReportDB = errors.New("Report database unavailable in this process")

func emptyReportSkeleton() *Obj {
	return O("summary", O(), "hourlyDelays", []any{}, "peakHours", []any{}, "rankingMostDelayed", []any{},
		"rankingBestPunctuality", []any{}, "rankingWorstStops", []any{}, "allStopDelays", []any{}, "agencyStats", []any{})
}

// generateAndSaveReport returns a *reportEntry, or the skeleton *Obj when
// generation failed and nothing is cached.
func (c *ReportCache) generateAndSaveReport(hours any, catalog any) (any, error) {
	h := c.normalizeHours(hours)
	start := nowMs()
	if c.db == nil {
		return nil, errNoReportDB
	}
	key := itoa(h)
	entry, err := c.generate(h, catalog, start)
	if err == nil {
		return entry, nil
	}
	fails := c.consecutiveFailures[key] + 1
	c.consecutiveFailures[key] = fails
	if fails <= 2 || fails%10 == 0 {
		log.Printf("[ReportCacheService] ❌ %dh report generation FAILED (%d consecutive): %v", h, fails, err)
	}
	if e := c.cached[key]; e != nil {
		return e, nil
	}
	return emptyReportSkeleton(), nil
}

func (c *ReportCache) generate(h int, catalog any, start int64) (e *reportEntry, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = errors.New(jsString(r))
		}
	}()
	key := itoa(h)
	cat := catalog
	if !truthy(cat) {
		cat = []any{}
	}
	n := 0
	if l, ok := cat.([]any); ok {
		n = len(l)
	}
	log.Printf("[ReportCacheService] 📊 Generating fresh %dh Journalism Report (catalog lines: %d)...", h, n)
	report := c.db.getJournalismReport(float64(h), cat)
	if report == nil {
		return nil, errors.New("historyDb.getJournalismReport returned empty or invalid summary")
	}
	summary, _ := report.Get("summary").(*Obj)
	if !truthy(report.Get("summary")) || summary == nil || summary.IsUndef("totalRecordedArrivals") {
		return nil, errors.New("historyDb.getJournalismReport returned empty or invalid summary")
	}
	now := nowMs()
	if f := c.consecutiveFailures[key]; f != 0 {
		log.Printf("[ReportCacheService] ✅ %dh report generation recovered after %d consecutive failure(s).", h, f)
		delete(c.consecutiveFailures, key)
	}
	meta := O(
		"generatedAt", isoString(now),
		"generatedTimestamp", float64(now),
		"expiresAt", isoString(now+30*60*1000),
		"generationDurationMs", float64(nowMs()-start),
		"updateIntervalMinutes", 30.0,
		"timeframeHours", float64(h),
		"isCached", true,
	)
	full := report.Clone().Set("meta", meta)
	compact := toJSON(full)
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, compact, "", "  "); err != nil {
		return nil, err
	}
	name := "journalism_report_" + key + "h_" + numToString(float64(now)) + ".json"
	if err := os.WriteFile(filepath.Join(c.reportsDir, name), pretty.Bytes(), 0o644); err != nil {
		return nil, err
	}
	log.Printf("[ReportCacheService] 💾 Saved %dh report to %s (%dms).", h, name, nowMs()-start)
	entry, err := reportEntryFromJSON(compact)
	if err != nil {
		return nil, err
	}
	c.cached[key] = entry
	c.emitIpc("REPORT_CACHE_UPDATE", O("timeframeHours", float64(h), "report", entry, "generatedAt", float64(now)))
	c.pruneOldReports()
	return entry, nil
}

// generateAllReports runs on the worker's event loop; the 100 ms pauses let
// queued requests in between reports.
func (c *ReportCache) generateAllReports(catalog any) {
	if c.isGenerating {
		return
	}
	c.isGenerating = true
	defer func() { c.isGenerating = false }()
	log.Printf("[ReportCacheService] 🔄 Starting batch generation for all timeframes (24h, 48h, 7d/168h)...")
	for _, h := range c.supportedHours {
		if _, err := c.generateAndSaveReport(float64(h), catalog); err != nil {
			log.Printf("[ReportCacheService] Batch generation error: %v", err)
			return
		}
		c.w.await(func() { time.Sleep(100 * time.Millisecond) })
	}
	log.Printf("[ReportCacheService] ✅ Batch report generation completed for all timeframes.")
}

// getLatestReport serves the cached report while fresh; nil otherwise (the
// server never generates: callers fall back to the worker).
func (c *ReportCache) getLatestReport(hours any) *reportEntry {
	h := c.normalizeHours(hours)
	e := c.cached[itoa(h)]
	if e != nil && !c.isReportStale(e, 0) {
		return e
	}
	if e != nil {
		age := "?"
		if e.hasMetaTs && e.metaTs != 0 {
			age = numToString(jsRound((float64(nowMs()) - e.metaTs) / 60000))
		}
		log.Printf("[ReportCacheService] ⚠️ Cached %dh report is stale (%s min old) — treating as miss so the worker regenerates it.", h, age)
	}
	return nil
}

func (c *ReportCache) getFreshnessStatus() []any {
	now := float64(nowMs())
	out := make([]any, 0, len(c.supportedHours))
	for _, h := range c.supportedHours {
		e := c.cached[itoa(h)]
		var ts, age any = nil, nil
		if e != nil && e.hasMetaTs {
			ts = e.metaTs
			age = maxF(0, now-e.metaTs)
		}
		out = append(out, O(
			"hours", float64(h),
			"generatedTimestamp", ts,
			"ageMs", age,
			"fresh", e != nil && !c.isReportStale(e, 0),
		))
	}
	return out
}

func (c *ReportCache) isReportStale(e *reportEntry, maxAgeMs float64) bool {
	if maxAgeMs == 0 {
		maxAgeMs = 65 * 60 * 1000
	}
	if e == nil || !e.hasMetaTs {
		return true
	}
	return float64(nowMs())-e.metaTs >= maxAgeMs
}

func maxF(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

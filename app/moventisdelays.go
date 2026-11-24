package main

// Moventis delay observations for Dades (estimated from live moventis.es
// countdowns vs the Generalitat GTFS timetable or moventis.es scheduled times).
//
// Telemetry honesty:
//   - Every delay comes from a predicted arrival ("real":"S") matched against
//     a published scheduled departure, never from GPS.
//   - Always labelled tier="predicted", source="prediction_vs_timetable".
//   - Kept in memory (7-day rolling window, max 10 000 entries) and persisted
//     atomically to DATA_DIR/moventis/delays.json so restarts keep Dades stats
//     without the server world ever touching SQLite.

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"time"
)

const (
	movDelayMaxApproach = 15 * time.Minute // only score buses approaching within 15 min
	movDelayMaxEarly    = 5 * time.Minute  // reject >5 min early as wrong trip match
	movDelayMaxLate     = 35 * time.Minute // reject >35 min late as wrong trip match
	movDelayOnTimeSec   = 180              // <= 3 min counts as on time (same as rail)
	movDelayRetention   = 7 * 24 * time.Hour
	movDelayMaxObs      = 10000
	movDelaySaveEvery   = 3 * time.Minute
)

// movDelayObs is one deduplicated arrival-delay observation for a scheduled
// departure of a Moventis line at a sampled stop.
type movDelayObs struct {
	LineID     int     `json:"lineId"`
	LineCode   string  `json:"lineCode"`
	StopID     int     `json:"stopId"`
	SchedUnix  int64   `json:"schedUnix"`  // matched scheduled departure (unix s)
	ObservedAt int64   `json:"observedAt"` // when the prediction was fetched (unix s)
	EtaSec     float64 `json:"etaSec"`     // remaining countdown at ObservedAt
	DelaySec   int     `json:"delaySec"`   // expected - scheduled (seconds)
	Source     string  `json:"source"`     // "gencat_gtfs" or "moventis_sched"
}

type movDelayTracker struct {
	dir string

	mu       sync.Mutex
	byKey    map[[3]int64]movDelayObs // (lineID, stopID, schedUnix) -> closest observation
	dirty    bool
	lastSave time.Time
}

func newMovDelayTracker(dir string) *movDelayTracker {
	t := &movDelayTracker{
		dir:   dir,
		byKey: map[[3]int64]movDelayObs{},
	}
	t.load()
	return t
}

func (t *movDelayTracker) path() string {
	return filepath.Join(t.dir, "delays.json")
}

func (t *movDelayTracker) load() {
	if t.dir == "" {
		return
	}
	b, err := os.ReadFile(t.path())
	if err != nil {
		return
	}
	var list []movDelayObs
	if json.Unmarshal(b, &list) != nil {
		return
	}
	cutoff := time.Now().Add(-movDelayRetention).Unix()
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, o := range list {
		if o.ObservedAt >= cutoff && o.LineID > 0 && o.SchedUnix > 0 {
			t.byKey[[3]int64{int64(o.LineID), int64(o.StopID), o.SchedUnix}] = o
		}
	}
}

func (t *movDelayTracker) save(force bool) {
	if t.dir == "" {
		return
	}
	t.mu.Lock()
	if !t.dirty || (!force && time.Since(t.lastSave) < movDelaySaveEvery) {
		t.mu.Unlock()
		return
	}
	list := make([]movDelayObs, 0, len(t.byKey))
	for _, o := range t.byKey {
		list = append(list, o)
	}
	t.dirty = false
	t.lastSave = time.Now()
	t.mu.Unlock()

	sort.Slice(list, func(i, j int) bool { return list[i].ObservedAt < list[j].ObservedAt })
	b, err := json.Marshal(list)
	if err != nil {
		return
	}
	if os.MkdirAll(t.dir, 0o755) != nil {
		return
	}
	tmp := t.path() + ".tmp"
	if os.WriteFile(tmp, b, 0o644) == nil {
		_ = os.Rename(tmp, t.path())
	}
}

// matchMovSched finds the nearest scheduled time to expected from a stop's
// moventis.es "real":"N" HH:MM list within [-maxEarly, +maxLate].
func matchMovSched(sched []string, expected time.Time, maxEarly, maxLate time.Duration) (time.Time, bool) {
	if len(sched) == 0 {
		return time.Time{}, false
	}
	day := expected.In(madrid)
	var best time.Time
	var bestAbs time.Duration
	for _, s := range sched {
		m := reMovHora.FindStringSubmatch(s)
		if m == nil {
			continue
		}
		hh, _ := strconv.Atoi(m[1])
		mm, _ := strconv.Atoi(m[2])
		if hh > 23 || mm > 59 {
			continue
		}
		for off := -1; off <= 1; off++ {
			d := day.AddDate(0, 0, off)
			y, mo, dd := d.Date()
			cand := time.UnixMilli(localTimeToUtcDate(y, int(mo)-1, dd, hh, mm, 0))
			delay := expected.Sub(cand)
			if delay < -maxEarly || delay > maxLate {
				continue
			}
			abs := delay
			if abs < 0 {
				abs = -abs
			}
			if best.IsZero() || abs < bestAbs {
				best = cand
				bestAbs = abs
			}
		}
	}
	return best, !best.IsZero()
}

// observe inspects a stop's live predictions for one line and records a delay
// observation when an approaching bus (eta <= movDelayMaxApproach) matches a
// scheduled departure from the Generalitat GTFS or moventis.es timetable.
func (t *movDelayTracker) observe(lineID int, lineCode string, stopID int, etas []float64, sched []string, at time.Time, g *gcData) {
	if t == nil || len(etas) == 0 || lineID <= 0 {
		return
	}
	if lineCode == "" {
		lineCode = strconv.Itoa(lineID)
	}
	// Take the nearest approaching live bus within movDelayMaxApproach.
	etaSec := etas[0]
	if etaSec < 0 || etaSec > movDelayMaxApproach.Seconds() {
		return
	}
	expected := at.Add(time.Duration(etaSec * float64(time.Second)))
	var matched time.Time
	src := ""
	if g != nil {
		if m, ok := g.nearestDeparture(lineID, stopID, expected, movDelayMaxEarly, movDelayMaxLate); ok {
			matched = m
			src = "gencat_gtfs"
		}
	}
	if matched.IsZero() {
		if m, ok := matchMovSched(sched, expected, movDelayMaxEarly, movDelayMaxLate); ok {
			matched = m
			src = "moventis_sched"
		}
	}
	if matched.IsZero() {
		return
	}
	delaySec := int(math.Round(expected.Sub(matched).Seconds()))
	if delaySec < railMinDelaySec || delaySec > railMaxDelaySec {
		return
	}
	key := [3]int64{int64(lineID), int64(stopID), matched.Unix()}
	obs := movDelayObs{
		LineID:     lineID,
		LineCode:   lineCode,
		StopID:     stopID,
		SchedUnix:  matched.Unix(),
		ObservedAt: at.Unix(),
		EtaSec:     etaSec,
		DelaySec:   delaySec,
		Source:     src,
	}

	t.mu.Lock()
	prev, exists := t.byKey[key]
	// Update when new, or when this observation is closer to arrival (smaller ETA).
	if !exists || etaSec <= prev.EtaSec {
		t.byKey[key] = obs
		t.dirty = true
	}
	// Prune old observations and enforce cap.
	cutoff := at.Add(-movDelayRetention).Unix()
	if len(t.byKey) > movDelayMaxObs {
		for k, v := range t.byKey {
			if v.ObservedAt < cutoff {
				delete(t.byKey, k)
			}
		}
		if len(t.byKey) > movDelayMaxObs {
			all := make([]movDelayObs, 0, len(t.byKey))
			for _, v := range t.byKey {
				all = append(all, v)
			}
			sort.Slice(all, func(i, j int) bool { return all[i].ObservedAt > all[j].ObservedAt })
			t.byKey = make(map[[3]int64]movDelayObs, movDelayMaxObs)
			for _, v := range all[:movDelayMaxObs] {
				t.byKey[[3]int64{int64(v.LineID), int64(v.StopID), v.SchedUnix}] = v
			}
		}
	}
	t.mu.Unlock()
	t.save(false)
}

func round1(x float64) float64 { return math.Round(x*10) / 10 }

// report builds the additive `delays` JSON object for /api/moventis?hours=H.
func (t *movDelayTracker) report(hours float64, now time.Time) *Obj {
	if hours <= 0 {
		hours = 24
	}
	if hours > 168 {
		hours = 168
	}
	cutoff := now.Add(-time.Duration(hours * float64(time.Hour))).Unix()

	var obs []movDelayObs
	if t != nil {
		t.mu.Lock()
		for _, o := range t.byKey {
			if o.ObservedAt >= cutoff {
				obs = append(obs, o)
			}
		}
		t.mu.Unlock()
	}

	type lineAgg struct {
		code   string
		delays []int
		onTime int
	}
	byLine := map[string]*lineAgg{}
	var allDelays []int
	allOnTime := 0
	hourSum := [24]int{}
	hourCnt := [24]int{}

	for _, o := range obs {
		allDelays = append(allDelays, o.DelaySec)
		if o.DelaySec <= movDelayOnTimeSec {
			allOnTime++
		}
		la := byLine[o.LineCode]
		if la == nil {
			la = &lineAgg{code: o.LineCode}
			byLine[o.LineCode] = la
		}
		la.delays = append(la.delays, o.DelaySec)
		if o.DelaySec <= movDelayOnTimeSec {
			la.onTime++
		}
		h := time.Unix(o.SchedUnix, 0).In(madrid).Hour()
		if h >= 0 && h < 24 {
			hourSum[h] += o.DelaySec
			hourCnt[h]++
		}
	}

	calcStats := func(ds []int, onTime int) (avgMin, medMin, maxMin, onTimePct float64) {
		n := len(ds)
		if n == 0 {
			return 0, 0, 0, 0
		}
		sorted := append([]int(nil), ds...)
		sort.Ints(sorted)
		sum := 0
		for _, d := range sorted {
			sum += d
		}
		avgMin = round1(float64(sum) / float64(n) / 60.0)
		med := float64(sorted[n/2])
		if n%2 == 0 {
			med = float64(sorted[n/2-1]+sorted[n/2]) / 2.0
		}
		medMin = round1(med / 60.0)
		maxMin = round1(float64(sorted[n-1]) / 60.0)
		onTimePct = round1(float64(onTime) * 100.0 / float64(n))
		return
	}

	avg, med, maxM, onPct := calcStats(allDelays, allOnTime)
	summary := O(
		"hours", hours,
		"observations", float64(len(allDelays)),
		"onTimePct", onPct,
		"latePct", round1(100.0-onPct),
		"avgDelayMins", avg,
		"medianDelayMins", med,
		"maxDelayMins", maxM,
		"onTimeThresholdSec", float64(movDelayOnTimeSec),
		"tier", "predicted",
		"source", "prediction_vs_timetable",
	)
	if len(allDelays) == 0 {
		summary.Set("onTimePct", nil)
		summary.Set("latePct", nil)
		summary.Set("avgDelayMins", nil)
		summary.Set("medianDelayMins", nil)
		summary.Set("maxDelayMins", nil)
	}

	codes := make([]string, 0, len(byLine))
	for c := range byLine {
		codes = append(codes, c)
	}
	sort.Strings(codes)
	lineRows := make([]any, 0, len(codes))
	for _, c := range codes {
		la := byLine[c]
		laAvg, laMed, laMax, laPct := calcStats(la.delays, la.onTime)
		lineRows = append(lineRows, O(
			"lineCode", la.code,
			"observations", float64(len(la.delays)),
			"onTimePct", laPct,
			"avgDelayMins", laAvg,
			"medianDelayMins", laMed,
			"maxDelayMins", laMax,
		))
	}

	byHour := make([]any, 0, 24)
	for h := 0; h < 24; h++ {
		if hourCnt[h] == 0 {
			continue
		}
		byHour = append(byHour, O(
			"hour", float64(h),
			"observations", float64(hourCnt[h]),
			"avgDelayMins", round1(float64(hourSum[h])/float64(hourCnt[h])/60.0),
		))
	}

	return O(
		"summary", summary,
		"byLine", lineRows,
		"byHour", byHour,
	)
}

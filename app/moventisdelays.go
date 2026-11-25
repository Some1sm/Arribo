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

const (
	movDelayEarlySec     = -60 // < -1 min counts as early (same as Mataró/rail)
	movDelaySevereSec    = 300 // > 5 min counts as severely late (bus standard)
	movBottleneckAvgMins = 3.0 // a stop is a bottleneck from this avg delay...
	movBottleneckSevere  = 20  // ...or this share (%) of severely late visits
	movMaxReportStops    = 100
)

// report builds the additive `delays` JSON object for /api/moventis?hours=H.
func (t *movDelayTracker) report(hours float64, now time.Time) *Obj {
	return t.reportWithStatic(hours, now, nil)
}

// reportWithStatic builds the full `delays` analytics payload for Dades,
// resolving stop names and line names from static when available.
func (t *movDelayTracker) reportWithStatic(hours float64, now time.Time, static *movStatic) *Obj {
	if hours <= 0 {
		hours = 24
	}
	if hours > 168 {
		hours = 168
	}
	cutoff := now.Add(-time.Duration(hours * float64(time.Hour))).Unix()
	dailyCutoff := now.Add(-movDelayRetention).Unix()

	var obs []movDelayObs
	var allWindowObs []movDelayObs
	if t != nil {
		t.mu.Lock()
		for _, o := range t.byKey {
			if o.ObservedAt >= dailyCutoff {
				allWindowObs = append(allWindowObs, o)
			}
			if o.ObservedAt >= cutoff {
				obs = append(obs, o)
			}
		}
		t.mu.Unlock()
	}

	stopNames := map[int]string{}
	lineNames := map[string]string{}
	if static != nil {
		for _, l := range static.Lines {
			if l.Code != "" && l.Name != "" {
				lineNames[l.Code] = l.Name
			}
		}
		for _, rs := range static.Routes {
			for _, rt := range rs {
				for _, st := range rt.Stops {
					if st.ID > 0 && st.Name != "" {
						stopNames[st.ID] = st.Name
					}
				}
			}
		}
	}

	type statCounts struct {
		delays []int
		early  int
		onTime int
		late   int
		severe int
		maxSec int
		hasMax bool
	}
	addCount := func(sc *statCounts, d int) {
		sc.delays = append(sc.delays, d)
		if !sc.hasMax || d > sc.maxSec {
			sc.maxSec = d
			sc.hasMax = true
		}
		if d < movDelayEarlySec {
			sc.early++
		} else if d <= movDelayOnTimeSec {
			sc.onTime++
		} else {
			sc.late++
		}
		if d > movDelaySevereSec {
			sc.severe++
		}
	}
	calcCounts := func(sc *statCounts) (avgMin, medMin, maxMin, earlyPct, onTimePct, latePct, severePct float64) {
		n := len(sc.delays)
		if n == 0 {
			return 0, 0, 0, 0, 0, 0, 0
		}
		sorted := append([]int(nil), sc.delays...)
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
		earlyPct = round1(float64(sc.early) * 100.0 / float64(n))
		onTimePct = round1(float64(sc.onTime) * 100.0 / float64(n))
		latePct = round1(float64(sc.late) * 100.0 / float64(n))
		severePct = round1(float64(sc.severe) * 100.0 / float64(n))
		return
	}

	type stopKey struct {
		lineCode string
		stopID   int
	}
	type stopAgg struct {
		key    stopKey
		counts statCounts
		hourly [24]statCounts
	}

	var allCounts statCounts
	var bEarly, bOnTime, bLate15, bLate30, bLate60, bLateOver60 int
	byLine := map[string]*statCounts{}
	var byHourCounts [24]statCounts
	byStop := map[stopKey]*stopAgg{}

	for _, o := range obs {
		addCount(&allCounts, o.DelaySec)
		switch {
		case o.DelaySec < movDelayEarlySec:
			bEarly++
		case o.DelaySec <= movDelayOnTimeSec:
			bOnTime++
		case o.DelaySec <= 15*60:
			bLate15++
		case o.DelaySec <= 30*60:
			bLate30++
		case o.DelaySec <= 60*60:
			bLate60++
		default:
			bLateOver60++
		}

		la := byLine[o.LineCode]
		if la == nil {
			la = &statCounts{}
			byLine[o.LineCode] = la
		}
		addCount(la, o.DelaySec)

		h := time.Unix(o.SchedUnix, 0).In(madrid).Hour()
		if h >= 0 && h < 24 {
			addCount(&byHourCounts[h], o.DelaySec)
		}

		sk := stopKey{lineCode: o.LineCode, stopID: o.StopID}
		sa := byStop[sk]
		if sa == nil {
			sa = &stopAgg{key: sk}
			byStop[sk] = sa
		}
		addCount(&sa.counts, o.DelaySec)
		if h >= 0 && h < 24 {
			addCount(&sa.hourly[h], o.DelaySec)
		}
	}

	avg, med, maxM, earlyPct, onPct, latePct, severePct := calcCounts(&allCounts)
	summary := O(
		"hours", hours,
		"observations", float64(len(allCounts.delays)),
		"linesCount", float64(len(byLine)),
		"earlyPct", earlyPct,
		"onTimePct", onPct,
		"latePct", latePct,
		"severeLatePct", severePct,
		"avgDelayMins", avg,
		"medianDelayMins", med,
		"maxDelayMins", maxM,
		"onTimeThresholdSec", float64(movDelayOnTimeSec),
		"onTimeMaxMins", float64(movDelayOnTimeSec/60),
		"tier", "predicted",
		"source", "prediction_vs_timetable",
		"buckets", O(
			"early", float64(bEarly),
			"onTime", float64(bOnTime),
			"late15", float64(bLate15),
			"late30", float64(bLate30),
			"late60", float64(bLate60),
			"lateOver60", float64(bLateOver60),
		),
	)
	if len(allCounts.delays) == 0 {
		summary.Set("earlyPct", nil)
		summary.Set("onTimePct", nil)
		summary.Set("latePct", nil)
		summary.Set("severeLatePct", nil)
		summary.Set("avgDelayMins", nil)
		summary.Set("medianDelayMins", nil)
		summary.Set("maxDelayMins", nil)
	}

	type lineRowTmp struct {
		code string
		avg  float64
		obj  *Obj
	}
	lineTmp := make([]lineRowTmp, 0, len(byLine))
	for code, la := range byLine {
		laAvg, laMed, laMax, laEarly, laOn, laLate, laSev := calcCounts(la)
		o := O(
			"lineCode", code,
			"lineName", strOrNil(lineNames[code]),
			"observations", float64(len(la.delays)),
			"earlyPct", laEarly,
			"onTimePct", laOn,
			"latePct", laLate,
			"severeLatePct", laSev,
			"avgDelayMins", laAvg,
			"medianDelayMins", laMed,
			"maxDelayMins", laMax,
		)
		lineTmp = append(lineTmp, lineRowTmp{code: code, avg: laAvg, obj: o})
	}
	sort.Slice(lineTmp, func(i, j int) bool {
		if lineTmp[i].avg != lineTmp[j].avg {
			return lineTmp[i].avg > lineTmp[j].avg
		}
		return lineTmp[i].code < lineTmp[j].code
	})
	lineRows := make([]any, 0, len(lineTmp))
	for _, lr := range lineTmp {
		lineRows = append(lineRows, lr.obj)
	}

	byHour := make([]any, 0, 24)
	for h := 0; h < 24; h++ {
		n := len(byHourCounts[h].delays)
		if n == 0 {
			continue
		}
		hAvg, _, hMax, hEarly, hOn, hLate, hSev := calcCounts(&byHourCounts[h])
		hh := padStart(numToString(float64(h)), 2, "0")
		next := padStart(numToString(float64((h+1)%24)), 2, "0")
		byHour = append(byHour, O(
			"hour", float64(h),
			"timeWindow", hh+":00 - "+next+":00",
			"observations", float64(n),
			"avgDelayMins", hAvg,
			"maxDelayMins", hMax,
			"earlyPct", hEarly,
			"onTimePct", hOn,
			"latePct", hLate,
			"severeLatePct", hSev,
		))
	}

	// Build per-stop delay breakdown & 24h heatmap cells.
	minStopObs := 2
	multiObsStops := 0
	for _, sa := range byStop {
		if len(sa.counts.delays) >= 2 {
			multiObsStops++
		}
	}
	if multiObsStops < 3 {
		minStopObs = 1
	}
	type stopRowTmp struct {
		avg  float64
		max  float64
		code string
		id   int
		obj  *Obj
	}
	stopTmp := make([]stopRowTmp, 0, len(byStop))
	for _, sa := range byStop {
		n := len(sa.counts.delays)
		if n < minStopObs {
			continue
		}
		sAvg, _, sMax, _, sOn, _, sSev := calcCounts(&sa.counts)
		name := stopNames[sa.key.stopID]
		if name == "" {
			name = "Parada " + strconv.Itoa(sa.key.stopID)
		}
		hourly := make([]any, 0, 24)
		critHour := "--"
		critAvg := 0.0
		for hr := 0; hr < 24; hr++ {
			hh := padStart(numToString(float64(hr)), 2, "0")
			cell := O("hour", hh, "sampleCount", 0.0, "avgDelay", nil, "maxDelay", nil, "severeLatePct", nil)
			hn := len(sa.hourly[hr].delays)
			if hn > 0 {
				cAvg, _, cMax, _, _, _, cSev := calcCounts(&sa.hourly[hr])
				cell.Set("sampleCount", float64(hn))
				cell.Set("avgDelay", cAvg)
				cell.Set("maxDelay", cMax)
				cell.Set("severeLatePct", cSev)
				if cAvg > critAvg {
					critAvg = cAvg
					next := padStart(numToString(float64((hr+1)%24)), 2, "0")
					critHour = hh + ":00 - " + next + ":00"
				}
			}
			hourly = append(hourly, cell)
		}
		o := O(
			"stopId", strconv.Itoa(sa.key.stopID),
			"stopName", name,
			"lineCode", sa.key.lineCode,
			"observations", float64(n),
			"avgDelayMins", sAvg,
			"maxDelayMins", sMax,
			"onTimePct", sOn,
			"severeLatePct", sSev,
			"isBottleneck", sAvg >= movBottleneckAvgMins || sSev >= movBottleneckSevere,
			"criticalHour", critHour,
			"criticalHourAvgDelay", critAvg,
			"hourly", hourly,
		)
		stopTmp = append(stopTmp, stopRowTmp{avg: sAvg, max: sMax, code: sa.key.lineCode, id: sa.key.stopID, obj: o})
	}
	sort.Slice(stopTmp, func(i, j int) bool {
		if stopTmp[i].avg != stopTmp[j].avg {
			return stopTmp[i].avg > stopTmp[j].avg
		}
		if stopTmp[i].max != stopTmp[j].max {
			return stopTmp[i].max > stopTmp[j].max
		}
		if stopTmp[i].code != stopTmp[j].code {
			return stopTmp[i].code < stopTmp[j].code
		}
		return stopTmp[i].id < stopTmp[j].id
	})
	if len(stopTmp) > movMaxReportStops {
		stopTmp = stopTmp[:movMaxReportStops]
	}
	stopRows := make([]any, 0, len(stopTmp))
	for _, sr := range stopTmp {
		stopRows = append(stopRows, sr.obj)
	}

	// Build 7-day rolling daily punctuality trend from all retained observations.
	byDay := map[string]*statCounts{}
	for _, o := range allWindowObs {
		dayKey := time.Unix(o.SchedUnix, 0).In(madrid).Format("2006-01-02")
		dc := byDay[dayKey]
		if dc == nil {
			dc = &statCounts{}
			byDay[dayKey] = dc
		}
		addCount(dc, o.DelaySec)
	}
	dayKeys := make([]string, 0, len(byDay))
	for d := range byDay {
		dayKeys = append(dayKeys, d)
	}
	sort.Strings(dayKeys)
	dailyRows := make([]any, 0, len(dayKeys))
	for _, d := range dayKeys {
		dc := byDay[d]
		dAvg, _, dMax, _, dOn, _, _ := calcCounts(dc)
		dailyRows = append(dailyRows, O(
			"date", d,
			"observations", float64(len(dc.delays)),
			"onTimePct", dOn,
			"avgDelayMins", dAvg,
			"maxDelayMins", dMax,
		))
	}

	return O(
		"summary", summary,
		"byLine", lineRows,
		"byHour", byHour,
		"byStop", stopRows,
		"daily", dailyRows,
	)
}

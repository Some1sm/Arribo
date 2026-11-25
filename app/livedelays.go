package main

// In-memory rolling delay observatory for live operators whose terms or
// volume keep them out of SQLite history.db (noHistory: true):
//   - AMB Bus Metropolità (GTFS-RT trip_updates)
//   - TRAM Barcelona: Trambaix (T1-T3) & Trambesòs (T4-T6) (GTFS-RT trip_updates)
//   - Sagalés (sagales.com live GPS + stop delays, unofficial)
//
// Each operator is emitted in the exact same JSON schema as Rodalies & FGC
// inside /api/analytics/operators and /api/analytics/operators/line so /dades
// automatically renders scope pills, KPI cards, line drill-downs, worst stops,
// and the Comparison by Operator table without touching SQLite.

import (
	"math"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	liveDelayMaxPerAgency = 30000
	liveDelayMaxAge       = 7 * 24 * time.Hour
	liveDelayDedupGapMs   = 3 * 60 * 1000 // score each trip/bus at most once per 3 min
	liveDelayOnTimeMax    = 3.0           // urban/metropolitan bus & tram standard (<= 3 min)
)

type liveDelaySample struct {
	TsMs      int64
	Line      string
	Stop      string
	TripKey   string
	DelayMins float64
}

type liveDelayBucket struct {
	samples  []liveDelaySample
	lastSeen map[string]int64
	dropped  int
}

type liveDelaysStore struct {
	mu       sync.Mutex
	byAgency map[string]*liveDelayBucket
}

var liveDelaysLive = &liveDelaysStore{
	byAgency: map[string]*liveDelayBucket{},
}

func liveDelayOperators() []operatorInfo {
	amb := ambOperator
	amb.OnTimeMaxMins = liveDelayOnTimeMax
	tbx := tramTbxOperator
	tbx.OnTimeMaxMins = liveDelayOnTimeMax
	tbs := tramTbsOperator
	tbs.OnTimeMaxMins = liveDelayOnTimeMax
	sag := sagalesOperator
	sag.OnTimeMaxMins = liveDelayOnTimeMax
	return []operatorInfo{amb, tbx, tbs, sag}
}

func isLiveDelayOperator(agencyID string) (operatorInfo, bool) {
	for _, op := range liveDelayOperators() {
		if op.ID == agencyID {
			return op, true
		}
	}
	return operatorInfo{}, false
}

// record adds one live delay observation for agencyID, deduplicating by
// tripKey within liveDelayDedupGapMs and discarding implausible values
// (< -10 min or > 180 min).
func (s *liveDelaysStore) record(agencyID, lineCode, stopName, tripKey string, delaySec int32, now time.Time) {
	if s == nil || agencyID == "" || lineCode == "" {
		return
	}
	nowMs := now.UnixMilli()
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.byAgency[agencyID]
	if b == nil {
		b = &liveDelayBucket{lastSeen: map[string]int64{}}
		s.byAgency[agencyID] = b
	}
	if int(delaySec) < railMinDelaySec || int(delaySec) > railMaxDelaySec {
		b.dropped++
		return
	}
	if tripKey == "" {
		tripKey = lineCode + "\x00" + stopName
	}
	if prev, ok := b.lastSeen[tripKey]; ok && nowMs-prev < liveDelayDedupGapMs {
		return
	}
	b.lastSeen[tripKey] = nowMs
	delayMins := math.Round(float64(delaySec)/60.0*10) / 10
	b.samples = append(b.samples, liveDelaySample{
		TsMs:      nowMs,
		Line:      lineCode,
		Stop:      strings.TrimSpace(stopName),
		TripKey:   tripKey,
		DelayMins: delayMins,
	})
	// Prune expired or overflow samples occasionally.
	if len(b.samples) > liveDelayMaxPerAgency+500 {
		cutoff := nowMs - liveDelayMaxAge.Milliseconds()
		keep := b.samples[:0]
		for _, sm := range b.samples {
			if sm.TsMs >= cutoff {
				keep = append(keep, sm)
			}
		}
		if len(keep) > liveDelayMaxPerAgency {
			keep = keep[len(keep)-liveDelayMaxPerAgency:]
		}
		b.samples = append([]liveDelaySample(nil), keep...)
	}
	if len(b.lastSeen) > 8000 {
		staleCut := nowMs - 2*liveDelayDedupGapMs
		for k, ts := range b.lastSeen {
			if ts < staleCut {
				delete(b.lastSeen, k)
			}
		}
	}
}

func (s *liveDelaysStore) operatorActive(agencyID string, feeds map[string]*Obj) bool {
	if feeds != nil && feeds[agencyID] != nil {
		return true
	}
	if agencyID == sagalesAgencyID && sagalesLive.Load() != nil {
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if b := s.byAgency[agencyID]; b != nil && len(b.samples) > 0 {
		return true
	}
	return false
}

// operatorReports builds /api/analytics/operators entries for every active
// in-memory live-delay operator (AMB, TRAM Trambaix/Trambesòs, Sagalés).
func (s *liveDelaysStore) operatorReports(hours float64, feeds map[string]*Obj, now time.Time) []any {
	if s == nil {
		return nil
	}
	cutoff := now.UnixMilli() - int64(hours*3600000)
	round1 := func(v float64) float64 { return math.Round(v*10) / 10 }
	var out []any

	for _, op := range liveDelayOperators() {
		if !s.operatorActive(op.ID, feeds) {
			continue
		}
		s.mu.Lock()
		var list []liveDelaySample
		dropped := 0
		if b := s.byAgency[op.ID]; b != nil {
			dropped = b.dropped
			for _, sm := range b.samples {
				if sm.TsMs >= cutoff {
					list = append(list, sm)
				}
			}
		}
		s.mu.Unlock()

		on := op.OnTimeMaxMins
		visits := float64(len(list))
		tripsSet := map[string]bool{}
		var sumDelay, maxDelay float64
		var early, onTime, late15, late30, late60, lateOver60 float64
		var firstTs, lastTs int64

		type agg struct {
			n      int
			sum    float64
			max    float64
			onTime int
		}
		byLine := map[string]*agg{}
		byStop := map[string]*agg{}

		for i, sm := range list {
			tripsSet[sm.TripKey] = true
			sumDelay += sm.DelayMins
			if i == 0 || sm.DelayMins > maxDelay {
				maxDelay = sm.DelayMins
			}
			if firstTs == 0 || sm.TsMs < firstTs {
				firstTs = sm.TsMs
			}
			if sm.TsMs > lastTs {
				lastTs = sm.TsMs
			}
			switch {
			case sm.DelayMins < -1:
				early++
			case sm.DelayMins <= on:
				onTime++
			case sm.DelayMins <= 15:
				late15++
			case sm.DelayMins <= 30:
				late30++
			case sm.DelayMins <= 60:
				late60++
			default:
				lateOver60++
			}
			la := byLine[sm.Line]
			if la == nil {
				la = &agg{max: sm.DelayMins}
				byLine[sm.Line] = la
			}
			la.n++
			la.sum += sm.DelayMins
			if sm.DelayMins > la.max {
				la.max = sm.DelayMins
			}
			if sm.DelayMins >= -1 && sm.DelayMins <= on {
				la.onTime++
			}
			if sm.Stop != "" {
				sa := byStop[sm.Stop]
				if sa == nil {
					sa = &agg{max: sm.DelayMins}
					byStop[sm.Stop] = sa
				}
				sa.n++
				sa.sum += sm.DelayMins
				if sm.DelayMins > sa.max {
					sa.max = sm.DelayMins
				}
				if sm.DelayMins >= -1 && sm.DelayMins <= on {
					sa.onTime++
				}
			}
		}

		pct := func(v float64) any {
			if visits <= 0 {
				return nil
			}
			return math.Round(v*1000/visits) / 10
		}
		var avgDelayVal, maxDelayVal, firstTsVal, lastTsVal any
		if visits > 0 {
			avgDelayVal = round1(sumDelay / visits)
			maxDelayVal = round1(maxDelay)
			firstTsVal = float64(firstTs)
			lastTsVal = float64(lastTs)
		}

		type lineItem struct {
			code string
			a    *agg
		}
		var lItems []lineItem
		for c, a := range byLine {
			lItems = append(lItems, lineItem{c, a})
		}
		sort.Slice(lItems, func(i, j int) bool {
			ai := lItems[i].a.sum / float64(lItems[i].a.n)
			aj := lItems[j].a.sum / float64(lItems[j].a.n)
			if ai != aj {
				return ai > aj
			}
			return lItems[i].code < lItems[j].code
		})
		lineRows := make([]any, 0, len(lItems))
		for _, it := range lItems {
			n := float64(it.a.n)
			lineRows = append(lineRows, O(
				"line", it.code, "visits", n,
				"avgDelay", round1(it.a.sum/n), "maxDelay", round1(it.a.max),
				"onTimePct", math.Round(float64(it.a.onTime)*1000/n)/10,
				"cancelled", 0.0,
			))
		}

		type stopItem struct {
			name string
			a    *agg
		}
		var sItems []stopItem
		for nm, a := range byStop {
			if a.n >= 2 {
				sItems = append(sItems, stopItem{nm, a})
			}
		}
		sort.Slice(sItems, func(i, j int) bool {
			ai := sItems[i].a.sum / float64(sItems[i].a.n)
			aj := sItems[j].a.sum / float64(sItems[j].a.n)
			if ai != aj {
				return ai > aj
			}
			return sItems[i].name < sItems[j].name
		})
		if len(sItems) > 10 {
			sItems = sItems[:10]
		}
		stationRows := make([]any, 0, len(sItems))
		for _, it := range sItems {
			n := float64(it.a.n)
			stationRows = append(stationRows, O(
				"station", it.name, "visits", n,
				"avgDelay", round1(it.a.sum/n), "maxDelay", round1(it.a.max),
			))
		}

		var feed any
		if feeds != nil && feeds[op.ID] != nil {
			feed = feeds[op.ID]
		} else if op.ID == sagalesAgencyID {
			if sp := sagalesLive.Load(); sp != nil {
				sp.mu.RLock()
				nVeh := 0
				for _, list := range sp.buses {
					nVeh += len(list)
				}
				age := 0.0
				if !sp.lastPoll.IsZero() {
					age = math.Round(now.Sub(sp.lastPoll).Seconds())
				}
				lerr := sp.lastErr
				sp.mu.RUnlock()
				feed = O(
					"live", true,
					"implausibleDropped", float64(dropped),
					"visitsClosed", visits,
					"vehiclesNow", float64(nVeh),
					"fetchAgeSec", age,
					"vehiclesError", strOrNil(lerr),
					"tripUpdatesError", nil,
				)
			}
		}

		out = append(out, O(
			"id", op.ID, "name", op.Name, "shortName", op.ShortName, "mode", op.Mode,
			"onTimeMaxMins", on,
			"source", op.Source,
			"tier", op.Tier, "method", op.Method,
			"visits", visits, "trips", float64(len(tripsSet)),
			"cancelled", 0.0,
			"avgDelay", avgDelayVal, "maxDelay", maxDelayVal,
			"onTimePct", pct(onTime), "earlyPct", pct(early),
			"buckets", O(
				"early", early, "onTime", onTime,
				"late15", late15, "late30", late30,
				"late60", late60, "lateOver60", lateOver60,
			),
			"firstTs", firstTsVal, "lastTs", lastTsVal,
			"lines", lineRows, "worstStations", stationRows,
			"feed", feed,
		))
	}
	return out
}

// lineReport builds /api/analytics/operators/line for an in-memory live-delay
// operator (AMB, TRAM Trambaix/Trambesòs, Sagalés).
func (s *liveDelaysStore) lineReport(agencyID, line string, hours float64, now time.Time) *Obj {
	op, ok := isLiveDelayOperator(agencyID)
	on := liveDelayOnTimeMax
	if ok {
		on = op.OnTimeMaxMins
	}
	cutoff := now.UnixMilli() - int64(hours*3600000)
	s.mu.Lock()
	var list []liveDelaySample
	if b := s.byAgency[agencyID]; b != nil {
		for _, sm := range b.samples {
			if sm.TsMs >= cutoff && strings.EqualFold(sm.Line, line) {
				list = append(list, sm)
			}
		}
	}
	s.mu.Unlock()

	type agg struct {
		n, onTime int
		sum, max  float64
	}
	byStop := map[string]*agg{}
	byHour := map[int]*agg{}
	for _, sm := range list {
		if sm.Stop != "" {
			sa := byStop[sm.Stop]
			if sa == nil {
				sa = &agg{max: sm.DelayMins}
				byStop[sm.Stop] = sa
			}
			sa.n++
			sa.sum += sm.DelayMins
			if sm.DelayMins > sa.max {
				sa.max = sm.DelayMins
			}
			if sm.DelayMins >= -1 && sm.DelayMins <= on {
				sa.onTime++
			}
		}
		h := time.UnixMilli(sm.TsMs).In(madrid).Hour()
		ha := byHour[h]
		if ha == nil {
			ha = &agg{max: sm.DelayMins}
			byHour[h] = ha
		}
		ha.n++
		ha.sum += sm.DelayMins
		if sm.DelayMins >= -1 && sm.DelayMins <= on {
			ha.onTime++
		}
	}

	round1 := func(v float64) float64 { return math.Round(v*10) / 10 }
	stationRows := make([]any, 0, len(byStop))
	for nm, a := range byStop {
		n := float64(a.n)
		stationRows = append(stationRows, O(
			"station", nm, "visits", n,
			"avgDelay", round1(a.sum/n), "maxDelay", round1(a.max),
			"onTimePct", math.Round(float64(a.onTime)*1000/n)/10,
		))
	}
	hourKeys := make([]int, 0, len(byHour))
	for h := range byHour {
		hourKeys = append(hourKeys, h)
	}
	sort.Ints(hourKeys)
	hourRows := make([]any, 0, len(hourKeys))
	for _, h := range hourKeys {
		a := byHour[h]
		n := float64(a.n)
		hourRows = append(hourRows, O(
			"hour", float64(h), "visits", n,
			"avgDelay", round1(a.sum/n),
			"onTimePct", math.Round(float64(a.onTime)*1000/n)/10,
		))
	}

	return O(
		"agencyId", agencyID,
		"line", line,
		"hours", hours,
		"visits", float64(len(list)),
		"onTimeMaxMins", on,
		"stations", stationRows,
		"byHour", hourRows,
	)
}

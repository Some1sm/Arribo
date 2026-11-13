package main

// Ports of src/core/schedule/delayJump.js, tripRelink.js, backwardLeg.js,
// deadheadReturn.js, plus src/core/punctuality.js and the
// String.prototype.localeCompare ordering they sort vehicles with.
//
// Sample rows are *Obj (database rows), because the detectors spread the
// whole row ({...s}) and read optional columns such as scheduledTime.

import (
	"math"
	"sort"
	"strings"
)

// ---------------------------------------------------------------- punctuality

const (
	earlyLimitMin = -1.0
	lateLimitMin  = 3.0
	severeLateMin = 5.0
	validDelayMin = -15.0
	validDelaySQL = "delay_mins > -15"
	onTimeSQL     = "(delay_mins >= -1 AND delay_mins <= 3)"
	earlySQL      = "(delay_mins < -1 AND delay_mins > -15)"
	lateSQL       = "(delay_mins > 3)"
	severeLateSQL = "(delay_mins >= 5)"
)

func classifyDelay(d float64) string {
	if !isFinite(d) {
		return "unknown"
	}
	if d < earlyLimitMin {
		return "early"
	}
	if d > lateLimitMin {
		return "late"
	}
	return "on_time"
}

// ---------------------------------------------------------------- localeCompare

// collationKey gives the ICU root-collation primary weight of an ASCII
// character (0 = ignorable) and whether it is an uppercase letter.
var asciiPrimary [128]int

func init() {
	order := "\t\n\v\f\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz"
	for i := 0; i < len(order); i++ {
		asciiPrimary[order[i]] = i + 1
	}
	for c := 'A'; c <= 'Z'; c++ {
		asciiPrimary[c] = asciiPrimary[c+32]
	}
}

func primaryOf(r rune) int {
	if r < 128 {
		return asciiPrimary[r]
	}
	return 1000 + int(r) // outside ASCII: after the letters, by code point
}

// localeCompareJS is a.localeCompare(b) (root locale, tertiary strength).
// Exact for ASCII; other characters order after ASCII letters by code point.
func localeCompareJS(a, b string, numeric bool) int {
	// Weights go into stack buffers: sorts call this O(n log n) times.
	var bufA, bufB [2][48]int
	pa, ta := collationWeightsInto(a, numeric, bufA[0][:0], bufA[1][:0])
	pb, tb := collationWeightsInto(b, numeric, bufB[0][:0], bufB[1][:0])
	if c := cmpInts(pa, pb); c != 0 {
		return c
	}
	return cmpInts(ta, tb)
}

// collationWeightsInto appends the weights of s to prim and tert.
func collationWeightsInto(s string, numeric bool, prim, tert []int) ([]int, []int) {
	rs := []rune(s)
	for i := 0; i < len(rs); i++ {
		r := rs[i]
		if numeric && r >= '0' && r <= '9' {
			j := i
			for j < len(rs) && rs[j] >= '0' && rs[j] <= '9' {
				j++
			}
			digits := strings.TrimLeft(string(rs[i:j]), "0")
			if digits == "" {
				digits = "0"
			}
			// numeric runs: a marker weight, the length, then each digit
			prim = append(prim, asciiPrimary['0'], 100+len(digits))
			for _, d := range digits {
				prim = append(prim, asciiPrimary[d])
			}
			tert = append(tert, 0)
			i = j - 1
			continue
		}
		p := primaryOf(r)
		if p == 0 {
			continue
		}
		prim = append(prim, p)
		if r >= 'A' && r <= 'Z' {
			tert = append(tert, 1)
		} else {
			tert = append(tert, 0)
		}
	}
	return prim, tert
}

func cmpInts(a, b []int) int {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			if a[i] < b[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(a) < len(b):
		return -1
	case len(a) > len(b):
		return 1
	}
	return 0
}

// ---------------------------------------------------------------- shared helpers

// StopPos is scheduleStopIndex's { indexes, lastIndex }.
type StopPos struct {
	Indexes   []int
	LastIndex int
}

type StopIndexFn func(lineCode, direction, stopName any) *StopPos

func minIdx(xs []int) float64 {
	m := math.Inf(1)
	for _, x := range xs {
		if float64(x) < m {
			m = float64(x)
		}
	}
	return m
}

func maxIdx(xs []int) float64 {
	m := math.Inf(-1)
	for _, x := range xs {
		if float64(x) > m {
			m = float64(x)
		}
	}
	return m
}

func intsToAny(xs []int) []any {
	out := make([]any, len(xs))
	for i, x := range xs {
		out[i] = x
	}
	return out
}

func upperLine(v any) string { return jsUpper(strOr(v, "")) }

// dirString: s.direction === undefined || s.direction === null ? ” : String(s.direction)
func dirString(v any) string {
	if isNullish(v) {
		return ""
	}
	return jsString(v)
}

type vehicleGroup struct {
	id   string
	list []*Obj
}

// groupSamples buckets valid samples per vehicle (Map insertion order) and
// returns them sorted with localeCompare, each list sorted by timestamp.
// mk builds the stored copy of a sample (nil = skip it).
func groupSamples(samples []*Obj, mk func(s *Obj, ts, delay float64) *Obj) []vehicleGroup {
	idx := map[string]int{}
	var groups []vehicleGroup
	for _, s := range samples {
		if s == nil || !truthy(s.Get("vehicleId")) {
			continue
		}
		ts := s.Num("timestamp")
		delay := s.Num("delayMins")
		if !isFinite(ts) || !isFinite(delay) {
			continue
		}
		c := mk(s, ts, delay)
		if c == nil {
			continue
		}
		key := s.Str("vehicleId")
		i, ok := idx[key]
		if !ok {
			i = len(groups)
			idx[key] = i
			groups = append(groups, vehicleGroup{id: key})
		}
		groups[i].list = append(groups[i].list, c)
	}
	sort.SliceStable(groups, func(i, j int) bool { return localeCompareJS(groups[i].id, groups[j].id, false) < 0 })
	return groups
}

func sortByTs(list []*Obj, key string) {
	sort.SliceStable(list, func(i, j int) bool { return list[i].Num(key)-list[j].Num(key) < 0 })
}

func staleStopNames(stale []*Obj, key string) []any {
	out := []any{}
	for _, s := range stale {
		name := strOr(s.Get(key), "")
		if name != "" && (len(out) == 0 || out[len(out)-1] != name) {
			out = append(out, name)
		}
	}
	return out
}

// ---------------------------------------------------------------- delayJump

const (
	jumpMinMins     = 10.0
	jumpSlackMins   = 3.0
	jumpMaxGapMs    = 20 * 60 * 1000.0
	jumpFromMinMins = -3.0
	jumpStaleGapMs  = 10 * 60 * 1000.0
)

func findDelayJumps(samples []*Obj) []*Obj {
	groups := groupSamples(samples, func(s *Obj, ts, delay float64) *Obj {
		c := s.Clone()
		c.Set("timestamp", ts)
		c.Set("delayMins", delay)
		c.Set("lineCode", upperLine(s.Get("lineCode")))
		return c
	})
	jumps := []*Obj{}
	for _, g := range groups {
		list := g.list
		sortByTs(list, "timestamp")
		i := 1
		for i < len(list) {
			before, after := list[i-1], list[i]
			elapsed := after.Num("timestamp") - before.Num("timestamp")
			rise := after.Num("delayMins") - before.Num("delayMins")
			bl := before.Str("lineCode")
			isJump := bl != "" && bl == after.Str("lineCode") &&
				before.Num("delayMins") >= jumpFromMinMins &&
				elapsed <= jumpMaxGapMs &&
				rise >= jumpMinMins &&
				rise*60000 > elapsed+jumpSlackMins*60000
			if !isJump {
				i++
				continue
			}
			end := i
			for end+1 < len(list) &&
				list[end+1].Str("lineCode") == after.Str("lineCode") &&
				list[end+1].Num("timestamp")-list[end].Num("timestamp") <= jumpStaleGapMs &&
				list[end+1].Num("delayMins") >= before.Num("delayMins")+jumpMinMins {
				end++
			}
			stale := list[i : end+1]
			jumps = append(jumps, O(
				"vehicleId", g.id,
				"lineCode", after.Get("lineCode"),
				"direction", dirString(after.Get("direction")),
				"beforeTs", before.Get("timestamp"),
				"beforeStop", strOr(before.Get("stopName"), ""),
				"delayBefore", before.Get("delayMins"),
				"jumpTs", after.Get("timestamp"),
				"jumpStop", strOr(after.Get("stopName"), ""),
				"delayAfter", after.Get("delayMins"),
				"elapsedMins", jsRound(elapsed/60000),
				"staleFromTs", after.Get("timestamp"),
				"staleToTs", stale[len(stale)-1].Get("timestamp"),
				"staleStops", staleStopNames(stale, "stopName"),
				"staleSampleCount", len(stale),
			))
			i = end + 1
		}
	}
	return jumps
}

// coveringFind implements jumpCovering / relinkCovering / backwardCovering.
func coveringFind(list []*Obj, vehicleID, lineCode, ts any, fromKey, toKey string) *Obj {
	if !truthy(vehicleID) {
		return nil
	}
	code := upperLine(lineCode)
	t := jsNumber(ts)
	vid := jsString(vehicleID)
	for _, j := range list {
		if j.Str("vehicleId") == vid && j.Str("lineCode") == code && t >= j.Num(fromKey) && t <= j.Num(toKey) {
			return j
		}
	}
	return nil
}

// overlappingFind implements jumpOverlapping / relinkOverlapping / backwardOverlapping.
func overlappingFind(list []*Obj, vehicleID, lineCode, fromTs, toTs any, fromKey, toKey string) *Obj {
	if !truthy(vehicleID) {
		return nil
	}
	code := upperLine(lineCode)
	vid := jsString(vehicleID)
	for _, j := range list {
		if j.Str("vehicleId") == vid && j.Str("lineCode") == code && j.Num(fromKey) <= jsNumber(toTs) && j.Num(toKey) >= jsNumber(fromTs) {
			return j
		}
	}
	return nil
}

func jumpCovering(j []*Obj, v, l, ts any) *Obj {
	return coveringFind(j, v, l, ts, "staleFromTs", "staleToTs")
}
func jumpOverlapping(j []*Obj, v, l, f, t any) *Obj {
	return overlappingFind(j, v, l, f, t, "staleFromTs", "staleToTs")
}

// ---------------------------------------------------------------- tripRelink

const (
	relinkDropMins   = 10.0
	relinkWindowMs   = 10 * 60 * 1000.0
	relinkStaleGapMs = 10 * 60 * 1000.0
)

func sameRun(a, b *Obj) bool {
	return upperLine(a.Get("lineCode")) == upperLine(b.Get("lineCode")) &&
		!isNullish(a.Get("direction")) && jsString(a.Get("direction")) != "" &&
		jsString(a.Get("direction")) == jsString(b.Get("direction"))
}

func findTripRelinks(samples []*Obj, stopIndex StopIndexFn) []*Obj {
	// position caches per copied sample, as s._position does.
	posCache := map[*Obj]*StopPos{}
	posDone := map[*Obj]bool{}
	position := func(s *Obj) *StopPos {
		if stopIndex == nil {
			return nil
		}
		if !posDone[s] {
			posCache[s] = stopIndex(s.Get("lineCode"), s.Get("direction"), s.Get("stopName"))
			posDone[s] = true
		}
		return posCache[s]
	}
	movesForward := func(earlier, later *Obj) bool {
		e, l := position(earlier), position(later)
		return e != nil && l != nil && minIdx(e.Indexes) <= maxIdx(l.Indexes)
	}
	groups := groupSamples(samples, func(s *Obj, ts, delay float64) *Obj {
		c := s.Clone()
		c.Set("timestamp", ts)
		c.Set("delayMins", delay)
		return c
	})
	relinks := []*Obj{}
	for _, g := range groups {
		list := g.list
		sortByTs(list, "timestamp")
		for i := 1; i < len(list); i++ {
			before, after := list[i-1], list[i]
			if !sameRun(before, after) {
				continue
			}
			if after.Num("timestamp")-before.Num("timestamp") > relinkWindowMs {
				continue
			}
			if before.Num("delayMins")-after.Num("delayMins") < relinkDropMins {
				continue
			}
			if stopIndex != nil {
				b := position(before)
				if b == nil {
					continue
				}
				all := true
				for _, idx := range b.Indexes {
					if !(idx == 0 || idx == b.LastIndex) {
						all = false
						break
					}
				}
				if all {
					continue
				}
				if !movesForward(before, after) {
					continue
				}
			}
			start := i - 1
			for start-1 >= 0 &&
				sameRun(list[start-1], after) &&
				list[start].Num("timestamp")-list[start-1].Num("timestamp") <= relinkStaleGapMs &&
				list[start-1].Num("delayMins") >= after.Num("delayMins")+relinkDropMins &&
				(stopIndex == nil || movesForward(list[start-1], list[start])) {
				start--
			}
			stale := list[start:i]
			relinks = append(relinks, O(
				"vehicleId", g.id,
				"lineCode", upperLine(after.Get("lineCode")),
				"direction", jsString(after.Get("direction")),
				"staleFromTs", stale[0].Get("timestamp"),
				"staleToTs", before.Get("timestamp"),
				"relinkTs", after.Get("timestamp"),
				"delayBefore", before.Get("delayMins"),
				"delayAfter", after.Get("delayMins"),
				"relinkStop", strOr(after.Get("stopName"), ""),
				"staleStops", staleStopNames(stale, "stopName"),
				"staleSampleCount", len(stale),
			))
		}
	}
	return relinks
}

func relinkCovering(r []*Obj, v, l, ts any) *Obj {
	return coveringFind(r, v, l, ts, "staleFromTs", "staleToTs")
}
func relinkOverlapping(r []*Obj, v, l, f, t any) *Obj {
	return overlappingFind(r, v, l, f, t, "staleFromTs", "staleToTs")
}

// ---------------------------------------------------------------- backwardLeg

const (
	backMinDelayMins     = 15.0
	backMinStops         = 4
	backKeepStops        = 3
	backMinVisits        = 3
	backDelayToleranceMn = 3.0
	backVisitGapMs       = 5 * 60 * 1000.0
	backRunGapMs         = 10 * 60 * 1000.0
)

type backVisit struct {
	lineCode, direction, stopName string
	firstTs, lastTs, delay        float64
	known                         bool
	low, high                     int
}

func findBackwardLegs(samples []*Obj, stopIndex StopIndexFn) []*Obj {
	if stopIndex == nil {
		return []*Obj{}
	}
	groups := groupSamples(samples, func(s *Obj, ts, delay float64) *Obj {
		if delay < backMinDelayMins {
			return nil
		}
		return O("ts", ts, "delay", delay, "lineCode", upperLine(s.Get("lineCode")),
			"direction", dirString(s.Get("direction")), "stopName", strOr(s.Get("stopName"), ""))
	})
	legs := []*Obj{}
	for _, g := range groups {
		list := g.list
		sortByTs(list, "ts")
		var visits []*backVisit
		for _, r := range list {
			lc, dir, stop := r.Str("lineCode"), r.Str("direction"), r.Str("stopName")
			ts, delay := r.Num("ts"), r.Num("delay")
			if n := len(visits); n > 0 {
				last := visits[n-1]
				if last.lineCode == lc && last.direction == dir && last.stopName == stop && ts-last.lastTs <= backVisitGapMs {
					last.lastTs = ts
					last.delay = delay
					continue
				}
			}
			var pos *StopPos
			if dir != "" {
				pos = stopIndex(lc, dir, stop)
			}
			v := &backVisit{lineCode: lc, direction: dir, stopName: stop, firstTs: ts, lastTs: ts, delay: delay}
			if pos != nil && len(pos.Indexes) == 1 {
				v.known, v.low, v.high = true, pos.Indexes[0], pos.Indexes[0]
			}
			visits = append(visits, v)
		}

		var peak *backVisit
		type legT struct {
			peak   *backVisit
			visits []*backVisit
		}
		var leg *legT
		closeLeg := func(returned bool) {
			if leg != nil && !returned && len(leg.visits) >= backMinVisits {
				names := []any{}
				for _, v := range leg.visits {
					if len(names) == 0 || names[len(names)-1] != v.stopName {
						names = append(names, v.stopName)
					}
				}
				lowest := leg.visits[0]
				for _, b := range leg.visits[1:] {
					if b.high < lowest.high {
						lowest = b
					}
				}
				legs = append(legs, O(
					"vehicleId", g.id,
					"lineCode", leg.peak.lineCode,
					"direction", leg.peak.direction,
					"lastServedStop", leg.peak.stopName,
					"lastServedTs", leg.peak.lastTs,
					"lastServedDelay", leg.peak.delay,
					"staleFromTs", leg.visits[0].firstTs,
					"staleToTs", leg.visits[len(leg.visits)-1].lastTs,
					"lowestStop", lowest.stopName,
					"stepsBack", leg.peak.low-lowest.high,
					"staleStops", names,
					"visitCount", len(leg.visits),
				))
			}
			leg = nil
			peak = nil
		}
		for i, v := range visits {
			if i > 0 {
				prev := visits[i-1]
				if prev.lineCode != v.lineCode || prev.direction != v.direction || v.firstTs-prev.lastTs > backRunGapMs {
					closeLeg(false)
				}
			}
			if !v.known {
				continue
			}
			if leg != nil {
				behind := leg.peak.low - v.high
				if behind >= backKeepStops && math.Abs(v.delay-leg.peak.delay) <= backDelayToleranceMn {
					leg.visits = append(leg.visits, v)
					continue
				}
				closeLeg(v.high >= leg.peak.low-1)
			}
			if peak == nil || v.high >= peak.high {
				peak = v
				continue
			}
			if peak.low-v.high >= backMinStops && math.Abs(v.delay-peak.delay) <= backDelayToleranceMn {
				leg = &legT{peak: peak, visits: []*backVisit{v}}
			}
		}
		closeLeg(false)
	}
	return legs
}

func backwardCovering(l []*Obj, v, lc, ts any) *Obj {
	return coveringFind(l, v, lc, ts, "staleFromTs", "staleToTs")
}
func backwardOverlapping(l []*Obj, v, lc, f, t any) *Obj {
	return overlappingFind(l, v, lc, f, t, "staleFromTs", "staleToTs")
}

// ---------------------------------------------------------------- deadheadReturn

const (
	dhMinRunStops     = 3
	dhRestartMaxIndex = 3.0
	dhMinJumpStops    = 5.0
	dhSpeedFactor     = 0.6
	dhRunGapMs        = 30 * 60 * 1000.0
)

type dhRun struct {
	lineCode, direction string
	samples             []*Obj
	stops               map[string]bool
	firstIndex          float64
	maxIndex            float64
	lastIndex           int
	lastPos             *StopPos
	firstTs, lastTs     float64
}

func findDeadheadReturns(samples []*Obj, stopIndex StopIndexFn, tripMinutes func(lineCode, direction string) any) []*Obj {
	if stopIndex == nil || tripMinutes == nil {
		return []*Obj{}
	}
	groups := groupSamples(samples, func(s *Obj, ts, delay float64) *Obj {
		d := s.Get("direction")
		if isNullish(d) || jsString(d) == "" {
			return nil
		}
		c := s.Clone()
		c.Set("lineCode", upperLine(s.Get("lineCode")))
		c.Set("direction", jsString(d))
		c.Set("stopName", strOr(s.Get("stopName"), ""))
		c.Set("timestamp", ts)
		c.Set("delayMins", delay)
		return c
	})
	found := []*Obj{}
	for _, g := range groups {
		list := g.list
		sortByTs(list, "timestamp")
		var runs []*dhRun
		for _, s := range list {
			lc, dir, stop := s.Str("lineCode"), s.Str("direction"), s.Str("stopName")
			ts := s.Num("timestamp")
			pos := stopIndex(lc, dir, stop)
			if pos == nil {
				continue
			}
			var run *dhRun
			if len(runs) > 0 {
				run = runs[len(runs)-1]
			}
			steppedBack := run != nil && minIdx(run.lastPos.Indexes) > maxIdx(pos.Indexes)
			if run == nil || run.lineCode != lc || run.direction != dir || steppedBack || ts-run.lastTs > dhRunGapMs {
				runs = append(runs, &dhRun{
					lineCode: lc, direction: dir, samples: []*Obj{s}, stops: map[string]bool{stop: true},
					firstIndex: minIdx(pos.Indexes), maxIndex: maxIdx(pos.Indexes), lastIndex: pos.LastIndex,
					lastPos: pos, firstTs: ts, lastTs: ts,
				})
				continue
			}
			run.samples = append(run.samples, s)
			run.stops[stop] = true
			run.maxIndex = math.Max(run.maxIndex, maxIdx(pos.Indexes))
			run.lastPos = pos
			run.lastTs = ts
		}

		prevServed := -1
		for k := 0; k < len(runs); k++ {
			if len(runs[k].stops) < dhMinRunStops {
				continue
			}
			served := prevServed
			prevServed = k
			if served < 0 {
				continue
			}
			before, after := runs[served], runs[k]
			if before.lineCode != after.lineCode || before.direction != after.direction {
				continue
			}
			if after.firstIndex > dhRestartMaxIndex {
				continue
			}
			if before.maxIndex-after.firstIndex < math.Max(dhMinJumpStops, float64(after.lastIndex)/2) {
				continue
			}
			var between []*Obj
			for _, r := range runs[served+1 : k] {
				for _, s := range r.samples {
					if s.Str("lineCode") == after.lineCode {
						between = append(between, s)
					}
				}
			}
			var opposite []*Obj
			oppStops := map[string]bool{}
			for _, s := range between {
				if s.Str("direction") != after.direction {
					opposite = append(opposite, s)
					oppStops[s.Str("stopName")] = true
				}
			}
			if len(oppStops) != 1 {
				continue
			}
			oppDir := opposite[0].Str("direction")
			oppMinutes := jsNumber(tripMinutes(after.lineCode, oppDir))
			if !isFinite(oppMinutes) || oppMinutes <= 0 {
				continue
			}
			returnMs := after.firstTs - before.lastTs
			if returnMs >= dhSpeedFactor*oppMinutes*60000 {
				continue
			}
			lastServed := before.samples[len(before.samples)-1]
			lsPos := stopIndex(lastServed.Str("lineCode"), lastServed.Str("direction"), lastServed.Str("stopName"))
			var phantoms []*Obj
			for _, s := range between {
				if n := len(phantoms); n > 0 {
					last := phantoms[n-1]
					if last.Str("stopName") == s.Str("stopName") && last.Str("direction") == s.Str("direction") {
						last.Set("lastTs", s.Get("timestamp"))
						last.Set("delayMins", math.Max(last.Num("delayMins"), s.Num("delayMins")))
						continue
					}
				}
				phantoms = append(phantoms, O(
					"stopName", s.Get("stopName"),
					"direction", s.Get("direction"),
					"delayMins", s.Get("delayMins"),
					"firstTs", s.Get("timestamp"),
					"lastTs", s.Get("timestamp"),
					"scheduledTime", strOr(s.Get("scheduledTime"), ""),
				))
			}
			lastServedIndex := before.maxIndex
			if lsPos != nil {
				lastServedIndex = maxIdx(lsPos.Indexes)
			}
			ph := make([]any, len(phantoms))
			for i, p := range phantoms {
				ph[i] = p
			}
			found = append(found, O(
				"vehicleId", g.id,
				"lineCode", after.lineCode,
				"direction", after.direction,
				"oppositeDirection", oppDir,
				"lastServedStop", lastServed.Get("stopName"),
				"lastServedTs", before.lastTs,
				"lastServedDelay", lastServed.Get("delayMins"),
				"lastServedIndex", lastServedIndex,
				"directionLastIndex", after.lastIndex,
				"resumeStop", after.samples[0].Get("stopName"),
				"resumeTs", after.firstTs,
				"resumeIndex", after.firstIndex,
				"returnMinutes", jsRound(returnMs/60000),
				"oppositeTripMinutes", oppMinutes,
				"phantomFromTs", between[0].Get("timestamp"),
				"phantomToTs", between[len(between)-1].Get("timestamp"),
				"phantoms", ph,
				"closedTrip", O(
					"direction", oppDir,
					"stopName", opposite[0].Get("stopName"),
					"scheduledTime", strOr(opposite[0].Get("scheduledTime"), ""),
					"timestamp", opposite[0].Get("timestamp"),
				),
			))
		}
	}
	return found
}

func deadheadCovering(d []*Obj, v, l, ts any) *Obj {
	return coveringFind(d, v, l, ts, "phantomFromTs", "phantomToTs")
}

func deadheadTouching(list []*Obj, vehicleID, lineCode, fromTs, toTs any) *Obj {
	if !truthy(vehicleID) {
		return nil
	}
	code := upperLine(lineCode)
	vid := jsString(vehicleID)
	from, to := jsNumber(fromTs), jsNumber(toTs)
	for _, d := range list {
		if d.Str("vehicleId") != vid || d.Str("lineCode") != code {
			continue
		}
		ls := d.Num("lastServedTs")
		if (ls >= from && ls <= to) || (d.Num("phantomFromTs") <= to && d.Num("phantomToTs") >= from) {
			return d
		}
	}
	return nil
}

// ---------------------------------------------------------------- schedule lookups (historyDb helpers)

func lineIDFromCode(lineCode any) string {
	return reLeadingL.ReplaceAllString(strOr(lineCode, ""), "")
}

// scheduleStopIndex returns a cached stop-position lookup on the weekday grid.
func scheduleStopIndex() StopIndexFn {
	cache := map[string][]string{}
	known := map[string]bool{}
	return func(lineCode, direction, stopName any) *StopPos {
		key := jsString(lineCode) + "|" + jsString(direction)
		if !known[key] {
			known[key] = true
			ds := getDirectionSchedule(lineIDFromCode(lineCode), dirArg(direction), "weekday", "")
			if ds != nil && len(ds.Stops) > 0 {
				names := make([]string, len(ds.Stops))
				for i, s := range ds.Stops {
					names[i] = normalizeStopName(strOr(s.Raw.Get("name"), ""))
				}
				cache[key] = names
			}
		}
		names := cache[key]
		if names == nil {
			return nil
		}
		wanted := normalizeStopName(strOr(stopName, ""))
		var idx []int
		for i, n := range names {
			if n == wanted {
				idx = append(idx, i)
			}
		}
		if len(idx) == 0 {
			return nil
		}
		return &StopPos{Indexes: idx, LastIndex: len(names) - 1}
	}
}

func directionTerminus(lineCode, direction any) string {
	ds := getDirectionSchedule(lineIDFromCode(lineCode), dirArg(direction), "weekday", "")
	if ds == nil || len(ds.Stops) == 0 {
		return ""
	}
	return strOr(ds.Stops[len(ds.Stops)-1].Raw.Get("name"), "")
}

func directionStopNames(lineCode, direction any) []any {
	ds := getDirectionSchedule(lineIDFromCode(lineCode), dirArg(direction), "weekday", "")
	out := []any{}
	if ds == nil {
		return out
	}
	for _, s := range ds.Stops {
		out = append(out, strOr(s.Raw.Get("name"), ""))
	}
	return out
}

// scheduleTripMinutes returns the trip time in minutes, or nil.
func scheduleTripMinutes(lineCode, direction string) any {
	ds := getDirectionSchedule(lineIDFromCode(lineCode), dirArg(direction), "weekday", "")
	if ds == nil {
		return nil
	}
	m := ds.TotalTravelMinutes
	if isFinite(m) && m > 0 {
		return m
	}
	return nil
}

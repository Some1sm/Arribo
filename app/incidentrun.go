package main

// Port of src/core/schedule/incidentRun.js: the Investigar panel's view of one
// bus around a clicked delay. Pure: no database, no clock.

import (
	"math"
	"sort"
	"strings"
	"unicode/utf16"

	"golang.org/x/text/unicode/norm"
)

const (
	runContextMs         = 30 * 60 * 1000.0
	runLookbackMs        = 4 * 60 * 60 * 1000.0
	originGrowthMins     = 3.0
	maxOriginEvents      = 3
	sustainedSpreadMins  = 5.0
	trendMins            = 5.0
	serviceDelayMins     = 5.0
	maxRunStops          = 150
	midRouteJoinMinIndex = 3.0
	runJumpBackMinStops  = 3.0
)

// jsSlice is String.prototype.slice(start, end) on UTF-16 code units
// (non-negative arguments).
func jsSlice(s string, start, end int) string {
	ascii := true
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			ascii = false
			break
		}
	}
	if ascii {
		if start > len(s) {
			start = len(s)
		}
		if end > len(s) {
			end = len(s)
		}
		if end < start {
			return ""
		}
		return s[start:end]
	}
	u := utf16.Encode([]rune(s))
	if start > len(u) {
		start = len(u)
	}
	if end > len(u) {
		end = len(u)
	}
	if end < start {
		return ""
	}
	return string(utf16.Decode(u[start:end]))
}

// foldAccents: String(v || ”).normalize('NFD').replace(/[̀-ͯ]/g, ”).toLowerCase().trim()
func foldAccents(v any) string {
	s := norm.NFD.String(strOr(v, ""))
	s = strings.Map(func(r rune) rune {
		if r >= 0x300 && r <= 0x36f {
			return -1
		}
		return r
	}, s)
	return jsTrim(jsLower(s))
}

type runStop struct {
	stopName         string
	lineCode         string
	direction        string
	towards          string
	time             string
	lastTime         string
	firstTs          float64
	lastTs           float64
	firstDelay       float64
	delayMins        float64
	sampleCount      int
	isRealTime       bool
	scheduledTime    string
	actualTime       string
	timesProvenance  any
	directionChanged bool
	newTrip          bool
	isClicked        bool
	phantom          bool
	delayGrowth      float64
	originStart      bool
	phantomKind      any // nil = key absent
	joinedMidRoute   *Obj
	obj              *Obj
}

func (s *runStop) toObj() *Obj {
	if s.obj != nil {
		return s.obj
	}
	o := O(
		"stopName", s.stopName,
		"lineCode", s.lineCode,
		"direction", s.direction,
		"towards", s.towards,
		"time", s.time,
		"lastTime", s.lastTime,
		"firstTs", s.firstTs,
		"lastTs", s.lastTs,
		"firstDelay", s.firstDelay,
		"delayMins", s.delayMins,
		"sampleCount", s.sampleCount,
		"isRealTime", s.isRealTime,
		"scheduledTime", s.scheduledTime,
		"actualTime", s.actualTime,
		"timesProvenance", s.timesProvenance,
		"directionChanged", s.directionChanged,
		"newTrip", s.newTrip,
		"isClicked", s.isClicked,
		"phantom", s.phantom,
		"delayGrowth", s.delayGrowth,
		"originStart", s.originStart,
	)
	if s.phantomKind != nil {
		o.Set("phantomKind", s.phantomKind)
	}
	if s.joinedMidRoute != nil {
		o.Set("joinedMidRoute", s.joinedMidRoute)
	}
	s.obj = o
	return o
}

func summariseRun(seg []*runStop) *Obj {
	if len(seg) == 0 {
		return O("pattern", "none", "stopCount", 0)
	}
	minD, maxD := math.Inf(1), math.Inf(-1)
	for _, s := range seg {
		minD = math.Min(minD, s.delayMins)
		maxD = math.Max(maxD, s.delayMins)
	}
	first := seg[0].delayMins
	last := seg[len(seg)-1].delayMins
	var pattern string
	switch {
	case len(seg) == 1:
		pattern = "isolated"
	case minD >= serviceDelayMins && maxD-minD <= sustainedSpreadMins:
		pattern = "sustained"
	case last-first >= trendMins:
		pattern = "building"
	case first-last >= trendMins:
		pattern = "recovering"
	default:
		pattern = "variable"
	}
	return O(
		"pattern", pattern,
		"stopCount", len(seg),
		"fromTime", seg[0].time,
		"toTime", seg[len(seg)-1].time,
		"minDelay", minD,
		"maxDelay", maxD,
		"firstDelay", first,
		"lastDelay", last,
		"direction", seg[0].direction,
		"towards", seg[0].towards,
	)
}

// IncidentRunOpts mirrors buildIncidentRun's options object.
type IncidentRunOpts struct {
	ClickedStop    string
	ClickedFrom    any
	ClickedTo      any
	Towards        func(lineCode any, direction any) string
	StopIndex      StopIndexFn
	DirectionStops func(lineCode, direction any) []any
	Deadheads      []*Obj
	ShowFrom       any // Undefined / nil = show every visit
}

// IncidentRun is the result; Stops/Trips stay addressable so the caller can
// attach evidence to joinedMidRoute (shared between a stop and its trip).
type IncidentRun struct {
	Stops   []*runStop
	Summary *Obj
	Trips   []*Obj
	Origin  *Obj
}

func (r *IncidentRun) toObj() *Obj {
	stops := make([]any, len(r.Stops))
	for i, s := range r.Stops {
		stops[i] = s.toObj()
	}
	trips := make([]any, len(r.Trips))
	for i, t := range r.Trips {
		trips[i] = t
	}
	var origin any = nil
	if r.Origin != nil {
		origin = r.Origin
	}
	return O("stops", stops, "summary", r.Summary, "trips", trips, "origin", origin)
}

func buildIncidentRun(rows []*Obj, opt IncidentRunOpts) *IncidentRun {
	var sorted []*Obj
	for _, r := range rows {
		if r == nil || !isFinite(r.Num("timestamp")) || !isFinite(r.Num("delayMins")) {
			continue
		}
		sorted = append(sorted, r)
	}
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Num("timestamp")-sorted[j].Num("timestamp") < 0 })

	towardsCache := map[string]string{}
	terminusOf := func(lineCode any, direction string) string {
		if opt.Towards == nil {
			return ""
		}
		key := jsString(lineCode) + "|" + direction
		if v, ok := towardsCache[key]; ok {
			return v
		}
		v := opt.Towards(lineCode, direction)
		towardsCache[key] = v
		return v
	}

	var stops []*runStop
	for _, r := range sorted {
		var last *runStop
		if len(stops) > 0 {
			last = stops[len(stops)-1]
		}
		direction := dirString(r.Get("direction"))
		stopName := strOr(r.Get("stopName"), "")
		ts := r.Num("timestamp")
		delay := r.Num("delayMins")
		fdate := strOr(r.Get("formattedDate"), "")
		if last != nil && last.stopName == stopName && last.direction == direction {
			last.lastTs = ts
			last.lastTime = jsSlice(fdate, 11, 19)
			last.delayMins = delay
			last.sampleCount++
			if truthy(r.Get("isRealTime")) {
				last.isRealTime = true
			}
			if truthy(r.Get("scheduledTime")) {
				last.scheduledTime = jsString(r.Get("scheduledTime"))
				last.actualTime = strOr(r.Get("actualTime"), "")
				last.timesProvenance = or(r.Get("timesProvenance"), last.timesProvenance)
			}
			continue
		}
		directionChanged := last != nil && last.direction != direction
		jumpedBack := false
		if last != nil && !directionChanged && opt.StopIndex != nil {
			prev := opt.StopIndex(r.Get("lineCode"), last.direction, last.stopName)
			cur := opt.StopIndex(r.Get("lineCode"), direction, stopName)
			jumpedBack = prev != nil && cur != nil && minIdx(prev.Indexes)-maxIdx(cur.Indexes) >= runJumpBackMinStops
		}
		stops = append(stops, &runStop{
			stopName:         stopName,
			lineCode:         strOr(r.Get("lineCode"), ""),
			direction:        direction,
			towards:          terminusOf(r.Get("lineCode"), direction),
			time:             jsSlice(fdate, 11, 19),
			lastTime:         jsSlice(fdate, 11, 19),
			firstTs:          ts,
			lastTs:           ts,
			firstDelay:       delay,
			delayMins:        delay,
			sampleCount:      1,
			isRealTime:       truthy(r.Get("isRealTime")),
			scheduledTime:    strOr(r.Get("scheduledTime"), ""),
			actualTime:       strOr(r.Get("actualTime"), ""),
			timesProvenance:  or(r.Get("timesProvenance"), "none"),
			directionChanged: directionChanged,
			newTrip:          directionChanged || jumpedBack,
		})
	}

	if len(opt.Deadheads) > 0 {
		var group *Obj
		for _, s := range stops {
			code := jsUpper(s.lineCode)
			var d *Obj
			for _, x := range opt.Deadheads {
				if upperLine(x.Get("lineCode")) == code && s.firstTs >= x.Num("phantomFromTs") && s.firstTs <= x.Num("phantomToTs") {
					d = x
					break
				}
			}
			if d != nil {
				s.phantom = true
				s.phantomKind = or(d.Get("kind"), "deadhead")
				s.newTrip = group != d
			} else if group != nil {
				s.newTrip = true
			}
			group = d
		}
	}

	if opt.StopIndex != nil {
		for i := 0; i < len(stops); i++ {
			s := stops[i]
			if !s.directionChanged || i+1 >= len(stops) || stops[i+1].newTrip {
				continue
			}
			if s.phantom || (i > 0 && stops[i-1].phantom) {
				continue
			}
			pos := opt.StopIndex(s.lineCode, s.direction, s.stopName)
			first := 0.0
			if pos != nil {
				first = minIdx(pos.Indexes)
			}
			if first < midRouteJoinMinIndex {
				continue
			}
			var names []any
			if opt.DirectionStops != nil {
				names = opt.DirectionStops(s.lineCode, s.direction)
			}
			at := func(i int) string {
				if i >= 0 && i < len(names) {
					return strOr(names[i], "")
				}
				return ""
			}
			fi := int(first)
			s.joinedMidRoute = O("skippedCount", first, "firstSkipped", at(0), "lastSkipped", at(fi-1))
		}
	}

	wanted := foldAccents(opt.ClickedStop)
	from := jsNumber(opt.ClickedFrom)
	to := jsNumber(opt.ClickedTo)
	clickedIdx := -1
	if isFinite(from) && isFinite(to) {
		for i, s := range stops {
			if s.firstTs <= to && s.lastTs >= from && (wanted == "" || strings.Contains(foldAccents(s.stopName), wanted)) {
				s.isClicked = true
				if clickedIdx < 0 {
					clickedIdx = i
				}
			}
		}
	}

	segStart := 0
	segEnd := len(stops) - 1
	if clickedIdx >= 0 {
		segStart = clickedIdx
		for segStart > 0 && !stops[segStart].newTrip {
			segStart--
		}
		segEnd = clickedIdx
		for segEnd+1 < len(stops) && !stops[segEnd+1].newTrip {
			segEnd++
		}
	}
	var seg []*runStop
	if segEnd >= segStart && segStart < len(stops) {
		seg = stops[segStart : segEnd+1]
	}
	summary := summariseRun(seg)
	origin, originFrom := traceDelayOrigin(stops, clickedIdx, segStart)

	first := 0
	if !isNullish(opt.ShowFrom) {
		showFromTs := jsNumber(opt.ShowFrom)
		if isFinite(showFromTs) {
			first = -1
			for i, s := range stops {
				if s.lastTs >= showFromTs {
					first = i
					break
				}
			}
			if first < 0 {
				first = len(stops)
			}
			if clickedIdx >= 0 && clickedIdx < first {
				first = clickedIdx
			}
			if origin != nil && originFrom < first {
				first = originFrom
			}
		}
	}
	shown := stops[first:]
	if len(shown) > maxRunStops {
		centre := 0
		if clickedIdx >= 0 {
			centre = clickedIdx - first
		}
		var preferred int
		if origin != nil {
			preferred = originFrom - first
		} else {
			preferred = centre - maxRunStops/2
		}
		begin := preferred
		if c := centre - (maxRunStops - 20); c > begin {
			begin = c
		}
		if m := len(shown) - maxRunStops; m < begin {
			begin = m
		}
		if begin < 0 {
			begin = 0
		}
		shown = shown[begin : begin+maxRunStops]
	}

	type span struct{ start, end int }
	var trips []span
	for i, s := range shown {
		if i == 0 || s.newTrip {
			trips = append(trips, span{i, i})
		} else {
			trips[len(trips)-1].end = i
		}
	}
	tripObjs := make([]*Obj, 0, len(trips))
	for _, t := range trips {
		segment := shown[t.start : t.end+1]
		o := summariseRun(segment)
		o.Set("startIndex", t.start)
		o.Set("endIndex", t.end)
		if segment[0].joinedMidRoute != nil {
			o.Set("joinedMidRoute", segment[0].joinedMidRoute)
		} else {
			o.Set("joinedMidRoute", nil)
		}
		o.Set("isDeadhead", segment[0].phantom)
		pk := any("")
		if segment[0].phantom {
			pk = or(segment[0].phantomKind, "deadhead")
		}
		o.Set("phantomKind", pk)
		clicked := false
		for _, v := range segment {
			if v.isClicked {
				clicked = true
				break
			}
		}
		o.Set("isClickedTrip", clicked)
		tripObjs = append(tripObjs, o)
	}
	return &IncidentRun{Stops: shown, Summary: summary, Trips: tripObjs, Origin: origin}
}

// traceDelayOrigin returns the origin object (without fromIndex) and fromIndex.
func traceDelayOrigin(stops []*runStop, clickedIdx, clickedTripStart int) (*Obj, int) {
	if clickedIdx < 0 {
		return nil, 0
	}
	clicked := stops[clickedIdx]
	if clicked.phantom || clicked.delayMins < serviceDelayMins {
		return nil, 0
	}
	onTimeIdx := -1
	for i := clickedIdx - 1; i >= 0; i-- {
		s := stops[i]
		if s.phantom {
			continue
		}
		if math.Min(s.firstDelay, s.delayMins) <= lateLimitMin {
			onTimeIdx = i
			break
		}
	}
	from := onTimeIdx
	if from < 0 {
		for i, s := range stops {
			if !s.phantom {
				from = i
				break
			}
		}
	}
	if from < 0 || from > clickedIdx {
		return nil, 0
	}
	type event struct {
		index                        int
		kind, stopName, previousStop string
		fromTime, toTime             string
		fromDelay, toDelay, growth   float64
	}
	var events []event
	var prev *runStop
	tripsBefore := 0
	for i := from; i <= clickedIdx; i++ {
		s := stops[i]
		if s.phantom {
			prev = nil
			continue
		}
		if i > from && s.newTrip && i <= clickedTripStart {
			tripsBefore++
		}
		var kind string
		var startDelay float64
		if prev == nil {
			kind = "at_stop"
			startDelay = s.firstDelay
		} else if s.newTrip {
			kind = "turn"
			startDelay = prev.delayMins
		} else {
			startDelay = prev.delayMins
			if (s.delayMins-s.firstDelay)*2 >= s.delayMins-startDelay {
				kind = "at_stop"
			} else {
				kind = "between"
			}
		}
		growth := s.delayMins - startDelay
		if growth >= originGrowthMins {
			atStop := kind == "at_stop"
			e := event{index: i, kind: kind, stopName: s.stopName, toTime: s.lastTime, toDelay: s.delayMins, growth: growth}
			if prev != nil {
				e.previousStop = prev.stopName
			}
			if atStop {
				e.fromTime = s.time
				e.fromDelay = s.firstDelay
			} else {
				e.fromTime = prev.lastTime
				e.fromDelay = prev.delayMins
			}
			events = append(events, e)
		}
		prev = s
	}
	named := append([]event(nil), events...)
	sort.SliceStable(named, func(a, b int) bool {
		x, y := named[a], named[b]
		if d := y.growth - x.growth; d != 0 {
			return d < 0
		}
		return x.index-y.index < 0
	})
	if len(named) > maxOriginEvents {
		named = named[:maxOriginEvents]
	}
	sort.SliceStable(named, func(a, b int) bool { return named[a].index < named[b].index })
	for _, e := range named {
		stops[e.index].delayGrowth = e.growth
	}
	if onTimeIdx >= 0 {
		stops[onTimeIdx].originStart = true
	}
	start := stops[from]
	var onTime any = nil
	if onTimeIdx >= 0 {
		onTime = O("stopName", start.stopName, "towards", start.towards, "time", start.time, "delayMins", math.Min(start.firstDelay, start.delayMins))
	}
	evs := make([]any, len(named))
	for i, e := range named {
		evs[i] = O("kind", e.kind, "stopName", e.stopName, "previousStop", e.previousStop,
			"fromTime", e.fromTime, "toTime", e.toTime, "fromDelay", e.fromDelay, "toDelay", e.toDelay, "growth", e.growth)
	}
	return O(
		"onTime", onTime,
		"since", O("time", start.time, "delayMins", start.firstDelay),
		"tripsBefore", tripsBefore,
		"events", evs,
	), from
}

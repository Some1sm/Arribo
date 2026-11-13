package main

// Port of the parts of src/core/schedule/scheduleSynthesizer.js the tracker
// uses: estimateStopTravelTimes, getTravelTimeToStop, compileStopDepartures
// (with generateMorningFirstService).

import (
	"math"
	"sort"
	"strings"
)

// StopTravel is one row of estimateStopTravelTimes.
type StopTravel struct {
	StopID           string
	StopIndex        int
	Seq              float64
	Name             any
	SegmentMeters    float64
	CumulativeMeters float64
	DwellSec         float64
	TravelSec        float64
	TravelMinutes    float64
}

func (s StopTravel) toObj() *Obj {
	return O("stopId", s.StopID, "stopIndex", s.StopIndex, "seq", s.Seq, "name", s.Name,
		"segmentMeters", s.SegmentMeters, "cumulativeMeters", s.CumulativeMeters,
		"dwellSec", s.DwellSec, "travelSec", s.TravelSec, "travelMinutes", s.TravelMinutes)
}

func estimateStopTravelTimes(stops []*Obj, opt *Obj) []StopTravel {
	if len(stops) == 0 {
		return []StopTravel{}
	}
	if opt == nil {
		opt = O()
	}
	var speedMps float64
	switch {
	case truthy(opt.Get("speedMps")):
		speedMps = opt.Num("speedMps")
	case truthy(opt.Get("speedKmh")):
		speedMps = opt.Num("speedKmh") / 3.6
	case truthy(opt.Get("avgSpeedKmh")):
		speedMps = opt.Num("avgSpeedKmh") / 3.6
	default:
		speedMps = 8.0
	}
	dwellPerStop := 25.0
	if !opt.IsUndef("dwellSecPerStop") {
		dwellPerStop = opt.Num("dwellSecPerStop")
	}
	defaultSeg := opt.Num("defaultSegmentMeters")
	if math.IsNaN(defaultSeg) || defaultSeg == 0 {
		defaultSeg = 400
	}
	out := make([]StopTravel, 0, len(stops))
	cum := 0.0
	for i, s := range stops {
		if s == nil {
			s = O()
		}
		idv := coalesce(coalesce(coalesce(s.Get("id"), s.Get("stopId")), s.Get("code")), float64(i))
		stopID := jsString(idv)
		var name any = s.Get("name")
		if !truthy(name) {
			name = "Parada " + stopID
		}
		seq := float64(i)
		if !s.IsUndef("seq") {
			seq = s.Num("seq")
		}
		seg := 0.0
		if i > 0 {
			prev := stops[i-1]
			if prev == nil {
				prev = O()
			}
			lat0 := jsNumber(coalesce(prev.Get("lat"), prev.Get("latitude")))
			lon0 := jsNumber(coalesce(prev.Get("lon"), prev.Get("longitude")))
			lat1 := jsNumber(coalesce(s.Get("lat"), s.Get("latitude")))
			lon1 := jsNumber(coalesce(s.Get("lon"), s.Get("longitude")))
			if !math.IsNaN(lat0) && !math.IsNaN(lon0) && !math.IsNaN(lat1) && !math.IsNaN(lon1) && lat0 != 0 && lat1 != 0 {
				seg = distM(lat0, lon0, lat1, lon1)
			} else {
				seg = defaultSeg
			}
		}
		cum += seg
		dwell := float64(i) * dwellPerStop
		travel := 0.0
		if i != 0 {
			travel = jsRound(cum/speedMps + dwell)
		}
		out = append(out, StopTravel{
			StopID: stopID, StopIndex: i, Seq: seq, Name: name,
			SegmentMeters: jsRound(seg), CumulativeMeters: jsRound(cum),
			DwellSec: dwell, TravelSec: travel, TravelMinutes: jsRound(travel / 60),
		})
	}
	return out
}

func getTravelTimeToStop(rows []StopTravel, id string) float64 {
	for _, st := range rows {
		if st.StopID == id || numToString(st.Seq) == id || numToString(float64(st.StopIndex)) == id {
			return st.TravelSec
		}
	}
	return 0
}

// isSyntheticDeparture: EST_ runs and ghost/theoretical vehicles.
func isSyntheticDeparture(d *Obj) bool {
	if d == nil {
		return false
	}
	if d.Get("isTheoretical") == true || d.Get("isGhostVehicle") == true {
		return true
	}
	id := ""
	if truthy(d.Get("vehicleId")) {
		id = jsTrim(d.Str("vehicleId"))
	}
	return strings.HasPrefix(id, "EST_")
}

// itemTimeStr: typeof item === 'string' ? item : (item ? (item.dep || item.arr || item.departureTime || item.time || ”) : ”)
func itemTimeStr(item any) any {
	switch x := item.(type) {
	case string:
		return x
	case *Obj:
		return or(or(or(or(x.Get("dep"), x.Get("arr")), x.Get("departureTime")), x.Get("time")), "")
	}
	if truthy(item) {
		return Undefined // a non-object truthy value has no such properties
	}
	return ""
}

// optDate: opts.a ? new Date(opts.a) : (opts.b ? new Date(opts.b) : ... : now)
func optDate(opt *Obj, keys ...string) JSDate {
	for _, k := range keys {
		if truthy(opt.Get(k)) {
			return newDate(opt.Get(k))
		}
	}
	return dateNow()
}

func numOpt(opt *Obj, k string, def float64) float64 {
	if !opt.IsUndef(k) {
		return opt.Num(k)
	}
	return def
}

// splitHM is `str.split(':').map(Number)` -> [h, m] (m is NaN when absent).
func splitHM(s string) (float64, float64) {
	parts := strings.Split(s, ":")
	h := stringToNumber(parts[0])
	m := math.NaN()
	if len(parts) > 1 {
		m = stringToNumber(parts[1])
	}
	return h, m
}

// passing computes (passHour, passMin, "HH:MM") for baseSec + travelSec.
func passing(passSec float64) (float64, float64, string) {
	h := jsMod(math.Floor(passSec/3600), 24)
	m := math.Floor(jsMod(passSec, 3600) / 60)
	return h, m, pad2f(h) + ":" + pad2f(m)
}

// localDepMs is localTimeToUtcDate(net.year, net.month, net.day, h, m, 0).
func localDepMs(net NetworkTime, h, m float64) int64 {
	return localTimeToUtcDate(net.Year, net.Month, net.Day, int(h), int(m), 0)
}

func jsSliceLen(n int, end float64) int {
	if math.IsNaN(end) {
		return 0
	}
	e := math.Trunc(end)
	if e < 0 {
		e = math.Max(0, float64(n)+e)
	}
	if e > float64(n) {
		return n
	}
	return int(e)
}

func generateMorningFirstService(times []any, travelSec float64, opt *Obj) []*Obj {
	if len(times) == 0 {
		return []*Obj{}
	}
	now := optDate(opt, "referenceDate", "dateObj")
	dayOffset := 1.0
	if !opt.IsUndef("dayOffset") {
		dayOffset = opt.Num("dayOffset")
	}
	target := JSDate{timeClip(now.Ms + dayOffset*86400000)}
	net := getNetworkTime(target.ms())
	isTrain := opt.Bool("isTrain")
	badgeFirst := opt.Get("badgeTextFirst")
	if !truthy(badgeFirst) {
		if isTrain {
			badgeFirst = "🌅 1r Tren del matí"
		} else {
			badgeFirst = "🌅 1r Servei del matí"
		}
	}
	badgeNext := or(opt.Get("badgeTextSubsequent"), "Programat")
	maxCount := 10.0
	if truthy(opt.Get("maxCount")) {
		maxCount = opt.Num("maxCount")
	}
	use := times[:jsSliceLen(len(times), maxCount)]
	out := []*Obj{}
	for idx, item := range use {
		ts := itemTimeStr(item)
		if !truthy(ts) {
			continue
		}
		baseSec := timeStringToSeconds(jsString(ts))
		h, m, pstr := passing(baseSec + travelSec)
		depMs := localDepMs(net, h, m)
		diffMin := math.Max(1, jsRound((float64(depMs)-now.Ms)/60000))
		isFirst := idx == 0
		iso := isoString(depMs)
		badge := badgeNext
		cmp := "📅 Horari teòric: " + pstr
		if isFirst {
			badge = badgeFirst
			cmp = "📅 Pas teòric previst demà a les " + pstr
		}
		out = append(out, O(
			"lineId", or(opt.Get("lineId"), "line"),
			"lineCode", or(or(opt.Get("lineCode"), opt.Get("lineId")), "BUS"),
			"lineName", or(or(opt.Get("lineName"), opt.Get("lineCode")), "Bus"),
			"destination", or(opt.Get("destination"), "Destinació"),
			"directionId", dirIDOpt(opt),
			"departureTime", pstr,
			"scheduledTime", pstr,
			"time", pstr,
			"departureDate", iso,
			"expectedIso", iso,
			"aimedIso", iso,
			"minutesAway", diffMin,
			"formattedStatus", pstr,
			"isRealTime", false,
			"isRealtime", false,
			"isEstimated", false,
			"isTrain", isTrain,
			"isToday", false,
			"isFirstOfDay", isFirst,
			"isNextService", isFirst,
			"delayMinutes", 0.0,
			"delayMins", 0.0,
			"delayStatus", "scheduled",
			"delayBadgeText", badge,
			"badgeText", badge,
			"comparisonText", cmp,
		))
	}
	return out
}

// dirIDOpt: opts.directionId !== undefined ? String(opts.directionId) : '0'
func dirIDOpt(opt *Obj) string {
	if !opt.IsUndef("directionId") {
		return opt.Str("directionId")
	}
	return "0"
}

func anyList(v any) ([]any, bool) {
	switch x := v.(type) {
	case []any:
		return x, true
	case []string:
		out := make([]any, len(x))
		for i, s := range x {
			out[i] = s
		}
		return out, true
	}
	return nil, false
}

func compileStopDepartures(opt *Obj) []*Obj {
	if opt == nil {
		opt = O()
	}
	target := optDate(opt, "dateObj", "targetDate", "referenceDate")
	net := getNetworkTime(target.ms())
	nowMs := target.Ms
	nowMinOfDay := float64(net.Hour*60 + net.Minute)

	stopTravelSec := opt.Num("stopTravelSec")
	if math.IsNaN(stopTravelSec) {
		stopTravelSec = 0
	}
	limit := numOpt(opt, "limit", 10)
	minCountBeforeMorning := numOpt(opt, "minCountBeforeMorning", jsMin(limit, 5))
	maxMorningCount := numOpt(opt, "maxMorningCount", 10)
	dupWin := numOpt(opt, "duplicateWindowMinutes", 3)
	minAway := numOpt(opt, "minMinutesAway", -1)
	maxAway := numOpt(opt, "maxMinutesAway", 1440)

	baseTodayV := or(or(or(or(opt.Get("baseDeparturesToday"), opt.Get("scheduledDeparturesToday")), opt.Get("scheduledDepartures")), opt.Get("baseDepartureTimes")), []any{})
	baseTomorrowV := or(or(or(opt.Get("baseDeparturesTomorrow"), opt.Get("scheduledDeparturesTomorrow")), opt.Get("tomorrowDepartures")), []any{})
	var rawLive []any
	if l, ok := anyList(opt.Get("liveDepartures")); ok {
		rawLive = l
	}

	// 1. live departures
	var live []*Obj
	var liveMin, liveAimed []float64
	var liveExplicit []bool
	for _, rv := range rawLive {
		raw, _ := rv.(*Obj)
		if raw == nil {
			continue
		}
		std := standardizeDeparture(raw, opt)
		var explicitLive bool
		switch {
		case !raw.IsUndef("isRealTime"):
			explicitLive = raw.Bool("isRealTime")
		case !raw.IsUndef("isRealtime"):
			explicitLive = raw.Bool("isRealtime")
		default:
			explicitLive = !raw.Bool("isEstimated")
		}
		isEst := raw.Bool("isEstimated")
		std.Set("isRealTime", explicitLive && !isEst)
		std.Set("isRealtime", std.Get("isRealTime"))
		std.Set("isEstimated", isEst)
		std.Set("_isSynthetic", isSyntheticDeparture(raw))
		std.Set("isToday", true)
		std.Set("time", std.Get("departureTime"))
		if truthy(raw.Get("delayBadgeText")) {
			std.Set("badgeText", raw.Get("delayBadgeText"))
		} else if isEst {
			std.Set("badgeText", "⚡ En ruta")
		} else {
			std.Set("badgeText", std.Get("delayBadgeText"))
		}

		depMin, hasDep := 0.0, false
		aimedMin, hasAimed := 0.0, false
		dt := std.Str("departureTime")
		if dt != "" && dt != "--:--" && strings.Contains(dt, ":") {
			h, m := splitHM(dt)
			if !math.IsNaN(h) && !math.IsNaN(m) {
				depMin, hasDep = jsMod(h, 24)*60+jsMod(m, 60), true
			}
		} else if !std.IsUndef("minutesAway") && !math.IsNaN(std.Num("minutesAway")) {
			depMin, hasDep = jsMod(nowMinOfDay+jsRound(std.Num("minutesAway")), 1440), true
		}

		aimedIso, _ := raw.Get("aimedIso").(string)
		schedT, schedIsStr := raw.Get("scheduledTime").(string)
		aimedUsable := aimedIso != "" && !strings.HasPrefix(aimedIso, "0001-") && !strings.HasPrefix(aimedIso, "1970-")
		schedUsable := schedIsStr && schedT != "" && strings.Contains(schedT, ":")
		hasExplicit := aimedUsable || schedUsable

		if aimedUsable {
			d := newDate(aimedIso)
			if d.Valid() {
				an := getNetworkTime(d.ms())
				aimedMin, hasAimed = float64((an.Hour*60+an.Minute)%1440), true
			}
		} else if schedUsable {
			sh, sm := splitHM(schedT)
			if !math.IsNaN(sh) && !math.IsNaN(sm) {
				aimedMin, hasAimed = jsMod(sh, 24)*60+jsMod(sm, 60), true
			}
		} else if hasDep {
			delay := std.Num("delayMins")
			if math.IsNaN(delay) {
				delay = 0
			}
			aimedMin, hasAimed = jsMod(depMin-delay+1440, 1440), true
		}

		if hasDep {
			liveMin = append(liveMin, depMin)
			if hasAimed {
				liveAimed = append(liveAimed, aimedMin)
			} else {
				liveAimed = append(liveAimed, depMin)
			}
			liveExplicit = append(liveExplicit, hasExplicit)
		}
		live = append(live, std)
	}

	// isDuplicateWithLive indexes `live` with the position in the
	// minutes-of-day arrays, exactly as the JavaScript does (the two only line
	// up when every live departure had a parseable time).
	isDuplicateWithLive := func(schedMin float64) bool {
		for i := range liveMin {
			if i < len(live) {
				d := live[i]
				if d.Bool("_isSynthetic") || (!d.Bool("isRealTime") && !d.Bool("isEstimated")) {
					continue
				}
			} else {
				// live[i] is undefined: `undefined?.isRealTime` is falsy -> skipped
				continue
			}
			lm := liveMin[i]
			if liveExplicit[i] {
				diff := math.Abs(liveAimed[i] - schedMin)
				if diff > 720 {
					diff = 1440 - diff
				}
				if diff <= dupWin {
					return true
				}
				continue
			}
			diff := math.Abs(lm - schedMin)
			if diff > 720 {
				diff = 1440 - diff
			}
			if diff <= dupWin {
				return true
			}
		}
		return false
	}

	// 2. today's scheduled departures
	var sched []*Obj
	seen := map[string]bool{}
	if baseToday, ok := anyList(baseTodayV); ok {
		for _, item := range baseToday {
			tsv := itemTimeStr(item)
			ts, isStr := tsv.(string)
			if !truthy(tsv) || !isStr || !strings.Contains(ts, ":") {
				continue
			}
			baseSec := timeStringToSeconds(ts)
			if !opt.IsUndef("serviceStartSec") && baseSec < opt.Num("serviceStartSec") {
				continue
			}
			if !opt.IsUndef("serviceEndSec") && baseSec > opt.Num("serviceEndSec") {
				continue
			}
			h, m, pstr := passing(baseSec + stopTravelSec)
			passMinOfDay := h*60 + m
			depMs := localDepMs(net, h, m)
			diffMin := jsRound((float64(depMs) - nowMs) / 60000)
			if diffMin < minAway || diffMin > maxAway {
				continue
			}
			if isDuplicateWithLive(passMinOfDay) {
				continue
			}
			if seen[pstr] {
				continue
			}
			seen[pstr] = true
			safe := math.Max(0, diffMin)
			iso := isoString(depMs)
			sched = append(sched, standardizeDeparture(O(
				"lineId", or(opt.Get("lineId"), "line"),
				"lineCode", or(or(opt.Get("lineCode"), opt.Get("lineId")), "BUS"),
				"lineName", or(or(opt.Get("lineName"), opt.Get("lineCode")), "Bus"),
				"destination", or(opt.Get("destination"), "Destinació"),
				"directionId", dirIDOpt(opt),
				"departureTime", pstr,
				"scheduledTime", pstr,
				"time", pstr,
				"departureDate", iso,
				"expectedIso", iso,
				"aimedIso", iso,
				"minutesAway", safe,
				"formattedStatus", pstr,
				"isRealTime", false,
				"isRealtime", false,
				"isEstimated", false,
				"isTrain", opt.Bool("isTrain"),
				"isToday", true,
				"isFirstOfDay", false,
				"isNextService", false,
				"delayMinutes", 0.0,
				"delayMins", 0.0,
				"delayStatus", "scheduled",
				"delayBadgeText", "Horari teòric",
				"badgeText", "Horari teòric",
				"comparisonText", "📅 Horari teòric: "+pstr,
			), opt))
		}
	}

	// 3. merge
	numOr := func(o *Obj) float64 {
		f := o.Num("minutesAway")
		if math.IsNaN(f) {
			return 0
		}
		return f
	}
	var combined []*Obj
	for _, d := range live {
		if d.Bool("_isSynthetic") || (!d.Bool("isRealTime") && !d.Bool("isEstimated")) {
			near := false
			for _, s := range sched {
				if math.Abs(numOr(d)-numOr(s)) <= dupWin {
					near = true
					break
				}
			}
			if near {
				continue
			}
		}
		combined = append(combined, d)
	}
	combined = append(combined, sched...)
	sort.SliceStable(combined, func(i, j int) bool { return numOr(combined[i])-numOr(combined[j]) < 0 })
	if len(combined) > 0 && len(live) == 0 {
		combined[0].Set("isNextService", true)
	}

	// 4. tomorrow's first services
	final := append([]*Obj{}, combined...)
	baseTomorrow, tomorrowOK := anyList(baseTomorrowV)
	if float64(len(final)) < minCountBeforeMorning && tomorrowOK && len(baseTomorrow) > 0 {
		need := maxMorningCount
		if limit > 0 {
			need = jsMin(maxMorningCount, limit-float64(len(final)))
		} else {
			need = jsMin(maxMorningCount, maxMorningCount)
		}
		if need > 0 {
			mo := opt.Clone()
			mo.Set("referenceDate", target)
			mo.Set("maxCount", need)
			morning := generateMorningFirstService(baseTomorrow, stopTravelSec, mo)
			if len(final) == 0 && len(morning) > 0 {
				morning[0].Set("isNextService", true)
			}
			for _, md := range morning {
				if limit > 0 && float64(len(final)) >= limit {
					break
				}
				final = append(final, md)
			}
		}
	}
	if limit > 0 && float64(len(final)) > limit {
		return final[:jsSliceLen(len(final), limit)]
	}
	return final
}

// jsMin is Math.min for two numbers (NaN if either is NaN; -0 < +0).
func jsMin(a, b float64) float64 {
	if math.IsNaN(a) || math.IsNaN(b) {
		return math.NaN()
	}
	return math.Min(a, b)
}

// listOf is anyList without the ok flag (nil for a non-array).
func listOf(v any) []any {
	l, _ := anyList(v)
	return l
}

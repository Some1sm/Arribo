package main

// Ports of src/core/schedule/tripMatcher.js, delayEngine.js, serviceHours.js
// and scheduleSynthesizer.js.

import (
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/text/unicode/norm"
)

// ---------------------------------------------------------------------------
// tripMatcher

const (
	maxResidualMinutes           = 30.0
	headwayToleranceFloorMinutes = 5.0
)

var (
	reStopIdSuffix = jsRe(`\s*-\s*\d{3,5}\s*$`)
	rePunct        = jsRe(`[.,;:'"()·-]`)
	reSpaces       = jsRe(`\s+`)
)

// normalizeStopName strips accents, punctuation and the " - 1234" suffix.
func normalizeStopName(name string) string {
	s := norm.NFD.String(name)
	s = strings.Map(func(r rune) rune {
		if r >= 0x300 && r <= 0x36f {
			return -1
		}
		return r
	}, s)
	s = reStopIdSuffix.ReplaceAllString(s, "")
	s = rePunct.ReplaceAllString(s, " ")
	s = reSpaces.ReplaceAllString(s, " ")
	s = jsTrim(s)
	return jsLower(s)
}

// jsLower is String.prototype.toLowerCase for the characters that occur in
// stop and street names (Go's ToLower agrees except for a few special cases
// that do not appear after NFD stripping).

func circularDiffSec(a, b float64) float64 {
	d := a - b
	for d > 43200 {
		d -= 86400
	}
	for d < -43200 {
		d += 86400
	}
	return d
}

type DayTypeInfo struct {
	DayType    string
	C          DateComponents
	IsHoliday  bool
	IsOverride bool
}

func resolveDayType(ms int64) DayTypeInfo {
	c := getDateComponents(ms)
	if ov := getServiceOverride(ms); ov != "" {
		return DayTypeInfo{DayType: ov, C: c, IsHoliday: false, IsOverride: true}
	}
	dayType := "weekday"
	hol := isHoliday(ms)
	if hol {
		dayType = "sunday"
	} else if c.IsSunday {
		dayType = "sunday"
	} else if c.IsSaturday {
		dayType = "saturday"
	}
	return DayTypeInfo{DayType: dayType, C: c, IsHoliday: hol || (dayType == "sunday" && !c.IsSunday)}
}

// medianHeadwayMinutes returns ok=false for JS null.
func medianHeadwayMinutes(passing []string) (float64, bool) {
	var secs []float64
	for _, t := range passing {
		s := timeStringToSeconds(t)
		if isFinite(s) {
			secs = append(secs, s)
		}
	}
	sort.Float64s(secs)
	if len(secs) < 2 {
		return 0, false
	}
	var gaps []float64
	for i := 1; i < len(secs); i++ {
		gaps = append(gaps, (secs[i]-secs[i-1])/60)
	}
	sort.Float64s(gaps)
	mid := len(gaps) / 2
	var med float64
	if len(gaps)%2 == 1 {
		med = gaps[mid]
	} else {
		med = (gaps[mid-1] + gaps[mid]) / 2
	}
	if med > 0 {
		return med, true
	}
	return 0, false
}

// resolveStop: by sequence number, then by unambiguous normalized name.
func resolveStop(ds *DirSchedule, toSeq any, stopName string) (*SchedStop, bool) {
	if !isNullish(toSeq) && toSeq != "" {
		wanted := jsNumber(toSeq)
		if isFinite(wanted) {
			for _, s := range ds.Stops {
				if s.Seq == wanted {
					return s, false
				}
			}
		}
	}
	if stopName != "" {
		wn := normalizeStopName(stopName)
		if wn != "" {
			var matches []*SchedStop
			for _, s := range ds.Stops {
				if normalizeStopName(s.Name) == wn {
					matches = append(matches, s)
				}
			}
			if len(matches) == 1 {
				return matches[0], false
			}
			if len(matches) > 1 {
				return nil, true
			}
		}
	}
	return nil, false
}

// MatchArgs are matchTrip's arguments. Direction/ToSeq/DelayMins keep their
// JavaScript values (any) because the coercions differ per use.
type MatchArgs struct {
	LineID    any
	Direction any
	ToSeq     any
	StopName  any
	DelayMins any
	At        any // epoch ms; Undefined -> now
}

func matchTrip(a MatchArgs) *Obj {
	dirStr := strOr(a.Direction, "")
	empty := func(reason string, extra *Obj) *Obj {
		o := O("matched", false, "reason", reason, "scheduledTime", "", "actualTime", "",
			"dayType", "", "direction", dirStr, "stopId", "", "stopSeq", nil,
			"residualMinutes", nil, "candidateCount", 0)
		return o.Spread(extra)
	}
	if isNullish(a.LineID) || jsTrim(jsString(a.LineID)) == "" {
		return empty("no lineId", nil)
	}
	at := a.At
	if isUndef(at) {
		at = float64(nowMs())
	}
	if isNullish(at) || math.IsNaN(jsNumber(at)) || jsNumber(at) <= 0 {
		return empty("no observation timestamp", nil)
	}
	atMs := int64(jsNumber(at))
	dt := resolveDayType(atMs)
	lineID := jsString(a.LineID)
	direction := dirArg(a.Direction)
	ds := getDirectionSchedule(lineID, direction, dt.DayType, "")
	if ds == nil {
		return empty("no direction schedule", O("dayType", dt.DayType, "isHoliday", dt.IsHoliday))
	}
	stopName := ""
	if truthy(a.StopName) {
		stopName = jsString(a.StopName)
	}
	stop, ambiguous := resolveStop(ds, a.ToSeq, stopName)
	if ambiguous {
		return empty("ambiguous stop name in schedule", O("dayType", dt.DayType, "isHoliday", dt.IsHoliday))
	}
	if stop == nil {
		return empty("next stop not found in schedule", O("dayType", dt.DayType, "isHoliday", dt.IsHoliday))
	}
	passing := getDeparturesForStop(lineID, direction, stop.ID, dt.DayType, "")
	if len(passing) == 0 {
		return empty("no scheduled departures for this stop", O("dayType", dt.DayType, "isHoliday", dt.IsHoliday, "stopId", stop.ID, "stopSeq", stop.Raw.Get("seq")))
	}
	delayNum := 0.0
	if f := jsNumber(a.DelayMins); isFinite(f) {
		delayNum = f
	}
	c := dt.C
	nowSec := float64((c.Hour%24)*3600 + c.Minute*60 + c.Second)
	targetSec := nowSec - delayNum*60
	var bestTime string
	var bestDiff float64
	found := false
	for _, t := range passing {
		sec := timeStringToSeconds(t)
		if !isFinite(sec) {
			continue
		}
		diff := circularDiffSec(targetSec, sec)
		if !found || math.Abs(diff) < math.Abs(bestDiff) {
			bestTime, bestDiff, found = t, diff, true
		}
	}
	if !found {
		return empty("no parseable scheduled departures", O("dayType", dt.DayType, "isHoliday", dt.IsHoliday, "stopId", stop.ID, "stopSeq", stop.Raw.Get("seq")))
	}
	residual := jsRound(bestDiff / 60)
	headway, hasHeadway := medianHeadwayMinutes(passing)
	tol := maxResidualMinutes
	if hasHeadway {
		tol = math.Min(maxResidualMinutes, headway/2+headwayToleranceFloorMinutes)
	}
	if math.Abs(residual) > tol {
		return empty("no departure close enough to trust", O("dayType", dt.DayType, "isHoliday", dt.IsHoliday,
			"stopId", stop.ID, "stopSeq", stop.Raw.Get("seq"), "residualMinutes", residual,
			"toleranceMinutes", tol, "candidateCount", len(passing)))
	}
	schedSec := timeStringToSeconds(bestTime)
	actualSec := schedSec + delayNum*60
	var headwayOut any = nil
	if hasHeadway {
		headwayOut = headway
	}
	dirOut := ds.DirID
	if dirOut == "" {
		dirOut = strOr(a.Direction, "")
	}
	return O(
		"matched", true,
		"scheduledTime", secondsToTimeString(posMod(schedSec, 86400)),
		"actualTime", secondsToTimeString(posMod(actualSec, 86400)),
		"dayType", dt.DayType,
		"isHoliday", dt.IsHoliday,
		"direction", dirOut,
		"stopId", stop.ID,
		"stopSeq", stop.Raw.Get("seq"),
		"residualMinutes", residual,
		"toleranceMinutes", tol,
		"headwayMinutes", headwayOut,
		"candidateCount", len(passing),
	)
}

// dirArg converts a JavaScript direction argument as resolveDirectionKey's
// String(direction ?? ”) would; getDirectionSchedule's default '0' applies
// only to undefined.
func dirArg(v any) string {
	if isUndef(v) {
		return "0"
	}
	if v == nil {
		return ""
	}
	return jsString(v)
}

func matchTripStart(a MatchArgs) *Obj {
	d := a.DelayMins
	if isNullish(d) || d == "" || !isFinite(jsNumber(d)) {
		return O("matched", false, "reason", "no reported delay")
	}
	m := matchTrip(a)
	if !m.Bool("matched") {
		return O("matched", false, "reason", m.Get("reason"))
	}
	lineID := jsString(a.LineID)
	direction := dirArg(a.Direction)
	dayType := m.Str("dayType")
	ds := getDirectionSchedule(lineID, direction, dayType, "")
	var stops []*SchedStop
	if ds != nil {
		stops = ds.Stops
	}
	wanted := timeStringToSeconds(m.Str("scheduledTime"))
	type start struct {
		sec   float64
		index int
	}
	starts := map[string]start{}
	var order []string
	for _, t := range getTripsServingStop(lineID, direction, m.Str("stopId"), dayType, "") {
		pass := posMod(t.StopSec, 86400)
		if math.Floor(pass/60)*60 != wanted || t.FirstStopIndex < 0 {
			continue
		}
		var startSec float64
		if ds != nil && t.TripIndex < len(ds.Trips) {
			row := ds.Trips[t.TripIndex].S
			if t.FirstStopIndex < len(row) {
				startSec = row[t.FirstStopIndex]
			} else {
				startSec = math.NaN()
			}
		} else {
			startSec = t.OriginSec
		}
		if !isFinite(startSec) {
			continue
		}
		key := numToString(startSec) + "|" + strconv.Itoa(t.FirstStopIndex)
		if _, ok := starts[key]; !ok {
			order = append(order, key)
		}
		starts[key] = start{startSec, t.FirstStopIndex}
	}
	if len(starts) != 1 {
		reason := "trip not found"
		if len(starts) > 0 {
			reason = "two trips pass the stop in that minute"
		}
		return O("matched", false, "reason", reason)
	}
	s := starts[order[0]]
	stopID, stopName := "", ""
	if s.index < len(stops) && stops[s.index] != nil {
		stopID = stops[s.index].ID
		stopName = stops[s.index].Name
	}
	return O(
		"matched", true,
		"startTime", secondsToTimeString(posMod(s.sec, 86400))[:5],
		"startStopId", stopID,
		"startStopName", stopName,
		"scheduledTime", m.Get("scheduledTime"),
		"residualMinutes", m.Get("residualMinutes"),
	)
}

// ---------------------------------------------------------------------------
// delayEngine

func computeDelayStatus(delayMinutes any, isRealTime bool, opt *Obj) *Obj {
	if opt == nil {
		opt = O()
	}
	raw := 0.0
	if !isNullish(delayMinutes) {
		raw = jsNumber(delayMinutes)
	}
	delay := 0.0
	if !math.IsNaN(raw) {
		delay = jsRound(raw)
	}
	thDelay := 2.0
	if !opt.IsUndef("thresholdDelayMinutes") {
		thDelay = opt.Num("thresholdDelayMinutes")
	}
	thEarly := -1.0
	if !opt.IsUndef("thresholdEarlyMinutes") {
		thEarly = opt.Num("thresholdEarlyMinutes")
	}
	scheduled := or(opt.Get("scheduledTime"), nil)
	realtime := or(opt.Get("realtimeTime"), nil)
	style := strOr(opt.Get("punctualStyle"), "short")
	punctual := "Puntual"
	if style == "long" {
		punctual = "A l'hora (Puntual)"
	}
	ds := func(n float64) string { return numToString(n) }

	if opt.Bool("isRegulating") || opt.Bool("isTerminalLayover") || opt.Get("delayStatus") == "regulating" {
		term := strOr(opt.Get("originTerminalName"), "capçalera")
		dep := or(opt.Get("originDepartureTime"), scheduled)
		badge := opt.Get("delayBadgeText")
		if !truthy(badge) {
			if truthy(opt.Get("originTerminalName")) {
				badge = "⏱️ Regulant a " + opt.Str("originTerminalName")
			} else {
				badge = "⏱️ Regulació"
			}
		}
		var cmp string
		if truthy(scheduled) {
			if truthy(dep) && jsString(dep) != jsString(scheduled) {
				cmp = "Horari teòric: " + jsString(scheduled) + " • Regulant a " + term + " (sortida: " + jsString(dep) + ")"
			} else {
				cmp = "Regulant a " + term + " (Sortida: " + jsString(scheduled) + ")"
			}
		} else {
			cmp = "Regulant a " + term
		}
		return O("delayMinutes", delay, "delayMins", delay, "delayStatus", "regulating",
			"delayBadgeText", badge, "delayFormatted", "Regulant a "+term, "comparisonText", cmp)
	}
	if opt.Bool("isPassed") {
		cmp := "Passat ✓"
		if truthy(scheduled) {
			cmp = "Horari teòric: " + jsString(scheduled)
		}
		return O("delayMinutes", 0.0, "delayMins", 0.0, "delayStatus", "passed",
			"delayBadgeText", "Passat ✓", "delayFormatted", "Passat ✓", "comparisonText", cmp)
	}
	if !isRealTime {
		if opt.Bool("isFirstOfDay") || opt.Bool("isNextService") {
			badge := "🌅 1r Servei del matí"
			if opt.Bool("isTrain") {
				badge = "🌅 1r Tren del matí"
			}
			cmp := badge
			if truthy(scheduled) {
				cmp = "📅 Pas teòric previst demà a les " + jsString(scheduled)
			}
			return O("delayMinutes", 0.0, "delayMins", 0.0, "delayStatus", "scheduled",
				"delayBadgeText", badge, "delayFormatted", badge, "comparisonText", cmp)
		}
		if opt.Bool("isEstimated") {
			late := punctual
			if delay > 0 {
				late = "+" + ds(delay) + " min retard"
			}
			cmp := "⚡ Estimació en ruta"
			if truthy(scheduled) {
				cmp = "Teòric: " + jsString(scheduled) + " (" + late + ")"
			}
			return O("delayMinutes", delay, "delayMins", delay, "delayStatus", "estimated",
				"delayBadgeText", or(opt.Get("badgeText"), "⚡ En ruta"), "delayFormatted", late, "comparisonText", cmp)
		}
		cmp := "Horari teòric"
		if truthy(scheduled) {
			cmp = "Horari teòric: " + jsString(scheduled)
		}
		return O("delayMinutes", 0.0, "delayMins", 0.0, "delayStatus", "scheduled",
			"delayBadgeText", "Horari teòric", "delayFormatted", "Horari teòric", "comparisonText", cmp)
	}
	status := "on_time"
	badge := punctual
	formatted := "Puntual"
	if delay >= thDelay {
		status = "delayed"
		badge = "+" + ds(delay) + " min retard"
		formatted = badge
	} else if delay <= thEarly {
		status = "early"
		badge = ds(math.Abs(delay)) + " min avançat"
		formatted = badge
	}
	var cmp string
	switch {
	case truthy(scheduled):
		cmp = "Teòric: " + jsString(scheduled) + " (" + badge + ")"
	case truthy(opt.Get("agency")) && truthy(realtime):
		cmp = "Temps real " + opt.Str("agency") + " (" + jsString(realtime) + ")"
	case truthy(realtime):
		cmp = "Temps real (" + jsString(realtime) + ")"
	default:
		cmp = "Temps real (" + badge + ")"
	}
	return O("delayMinutes", delay, "delayMins", delay, "delayStatus", status,
		"delayBadgeText", badge, "delayFormatted", formatted, "comparisonText", cmp)
}

func formatCountdownStatus(minutesAway any) string {
	if isNullish(minutesAway) || math.IsNaN(jsNumber(minutesAway)) {
		return "--:--"
	}
	m := jsNumber(minutesAway)
	if m <= 0 {
		return "Imminent"
	}
	if m == 1 {
		return "1 min"
	}
	return numToString(m) + " min"
}

var reStripSeconds = jsRe(`^(\d{1,2}:\d{2}):\d{2}$`)

func stripSeconds(v any) any {
	s, ok := v.(string)
	if !ok || s == "" {
		return v
	}
	return reStripSeconds.ReplaceAllString(s, "$1")
}

// standardizeDeparture: dep and defaults are plain objects.
func standardizeDeparture(d, def *Obj) *Obj {
	if d == nil {
		d = O()
	}
	if def == nil {
		def = O()
	}
	var rt any
	if !d.IsUndef("isRealTime") {
		rt = d.Get("isRealTime")
	} else {
		rt = d.Get("isRealtime")
	}
	isRealTime := truthy(rt)
	var rawDelay any = 0.0
	if !d.IsUndef("delayMinutes") {
		rawDelay = d.Get("delayMinutes")
	} else if !d.IsUndef("delayMins") {
		rawDelay = d.Get("delayMins")
	}
	isRegulating := d.Bool("isRegulating") || d.Bool("isTerminalLayover") || d.Get("delayStatus") == "regulating"
	isOriginRegulating := d.Bool("isOriginRegulating")
	originTerminalName := or(d.Get("originTerminalName"), nil)
	originDepartureTime := or(d.Get("originDepartureTime"), nil)

	ev := computeDelayStatus(rawDelay, isRealTime, O(
		"scheduledTime", or(d.Get("scheduledTime"), d.Get("departureTime")),
		"realtimeTime", d.Get("departureTime"),
		"isFirstOfDay", d.Bool("isFirstOfDay"),
		"isNextService", d.Bool("isNextService"),
		"isPassed", d.Bool("isPassed"),
		"isEstimated", d.Bool("isEstimated"),
		"isRegulating", isRegulating,
		"isOriginRegulating", isOriginRegulating,
		"originTerminalName", originTerminalName,
		"originDepartureTime", originDepartureTime,
		"isTrain", d.Bool("isTrain"),
		"delayBadgeText", d.Get("delayBadgeText"),
		"punctualStyle", "short",
	))
	minutesAway := 0.0
	if !d.IsUndef("minutesAway") {
		minutesAway = jsNumber(d.Get("minutesAway"))
	}
	var formattedStatus any = d.Get("formattedStatus")
	if !truthy(formattedStatus) {
		if isRegulating && !isOriginRegulating {
			formattedStatus = "En regulació"
		} else {
			formattedStatus = formatCountdownStatus(minutesAway)
		}
	}
	tz := "Europe/Madrid"
	_ = tz
	cleanDep := or(stripSeconds(d.Get("departureTime")), "--:--")
	var cleanArr any = nil
	if truthy(d.Get("arrivalTime")) {
		cleanArr = stripSeconds(d.Get("arrivalTime"))
	}
	var cleanSched any = nil
	if truthy(d.Get("scheduledTime")) {
		cleanSched = stripSeconds(d.Get("scheduledTime"))
	}
	if !truthy(cleanSched) {
		if ai, ok := d.Get("aimedIso").(string); ok && ai != "" {
			if strings.Contains(ai, "T") && !strings.HasPrefix(ai, "0001-") && !strings.HasPrefix(ai, "1970-") {
				dd := newDate(ai)
				f := formatTimeToTimezone(dd.ms(), dd.Valid())
				if f != "" && f != "--:--" {
					cleanSched = stripSeconds(f)
				}
			} else if len([]rune(ai)) >= 16 {
				cleanSched = stripSeconds(jsSubstring(ai, 11, 16))
			}
		}
	}
	if !truthy(cleanSched) && !isRealTime && !d.Bool("isEstimated") && truthy(cleanDep) && cleanDep != "--:--" {
		cleanSched = cleanDep
	}
	var refDate JSDate
	switch {
	case truthy(def.Get("dateObj")):
		refDate = newDate(def.Get("dateObj"))
	case truthy(def.Get("targetDate")):
		refDate = newDate(def.Get("targetDate"))
	case truthy(def.Get("referenceDate")):
		refDate = newDate(def.Get("referenceDate"))
	default:
		refDate = dateNow()
	}
	var fallbackIso any = nil
	if cs, ok := cleanDep.(string); ok && strings.Contains(cs, ":") {
		parts := strings.Split(cs, ":")
		ch := stringToNumber(parts[0])
		cm := math.NaN()
		if len(parts) > 1 {
			cm = stringToNumber(parts[1])
		}
		if !math.IsNaN(ch) && !math.IsNaN(cm) {
			net := getNetworkTime(refDate.ms())
			ms := localTimeToUtcDate(net.Year, net.Month, net.Day, int(jsMod(ch, 24)), int(jsMod(cm, 60)), 0)
			fallbackIso = isoString(ms)
		}
	}
	if fallbackIso == nil {
		fallbackIso = isoString(refDate.ms())
	}
	var dirID any
	if !d.IsUndef("directionId") {
		dirID = jsString(d.Get("directionId"))
	} else {
		dirID = strOr(def.Get("directionId"), "0")
	}
	cmp := or(d.Get("comparisonText"), ev.Get("comparisonText"))
	if truthy(cleanArr) && truthy(cleanDep) && timeStringToSeconds(jsString(cleanArr)) < timeStringToSeconds(jsString(cleanDep)) {
		cmp = "Arribada: " + jsString(cleanArr) + " • Sortida: " + jsString(cleanDep)
	}
	var aimed any = d.Get("aimedIso")
	if !truthy(aimed) {
		if truthy(d.Get("scheduledTime")) {
			aimed = fallbackIso
		} else {
			aimed = or(or(d.Get("expectedIso"), d.Get("departureDate")), fallbackIso)
		}
	}
	var arrMin any = nil
	if !d.IsNullish("arrivalMinutesAway") {
		arrMin = jsNumber(d.Get("arrivalMinutesAway"))
	}
	var depMin any = minutesAway
	if !d.IsNullish("departureMinutesAway") {
		depMin = jsNumber(d.Get("departureMinutesAway"))
	}
	isToday := true
	if !d.IsUndef("isToday") {
		isToday = d.Bool("isToday")
	}
	return O(
		"lineId", jsString(or(or(d.Get("lineId"), def.Get("lineId")), "line")),
		"lineCode", jsString(or(or(or(d.Get("lineCode"), d.Get("lineName")), def.Get("lineCode")), "BUS")),
		"lineName", jsString(or(or(or(d.Get("lineName"), d.Get("lineCode")), def.Get("lineName")), "Bus")),
		"destination", jsString(or(or(d.Get("destination"), def.Get("destination")), "Destinació")),
		"directionId", dirID,
		"departureTime", jsString(cleanDep),
		"departureDate", or(or(d.Get("departureDate"), d.Get("expectedIso")), fallbackIso),
		"expectedIso", or(or(d.Get("expectedIso"), d.Get("departureDate")), fallbackIso),
		"aimedIso", aimed,
		"minutesAway", minutesAway,
		"formattedStatus", formattedStatus,
		"isRealTime", isRealTime,
		"isRealtime", isRealTime,
		"isEstimated", d.Bool("isEstimated"),
		"isTrain", d.Bool("isTrain"),
		"isToday", isToday,
		"isFirstOfDay", d.Bool("isFirstOfDay"),
		"isNextService", d.Bool("isNextService"),
		"delayMinutes", ev.Get("delayMinutes"),
		"delayMins", ev.Get("delayMins"),
		"delayStatus", ev.Get("delayStatus"),
		"delayBadgeText", or(d.Get("delayBadgeText"), ev.Get("delayBadgeText")),
		"delayFormatted", ev.Get("delayFormatted"),
		"comparisonText", cmp,
		"arrivalTime", cleanArr,
		"scheduledTime", cleanSched,
		"isRegulating", isRegulating,
		"isTerminalLayover", d.Bool("isTerminalLayover") || isRegulating,
		"isOriginRegulating", isOriginRegulating,
		"originTerminalName", originTerminalName,
		"originDepartureTime", originDepartureTime,
		"statusText", or(d.Get("statusText"), nil),
		"arrivalMinutesAway", arrMin,
		"departureMinutesAway", depMin,
		"vehicleId", or(d.Get("vehicleId"), nil),
		"busCoords", or(d.Get("busCoords"), nil),
	)
}

// jsMod is the JavaScript % operator (sign of the dividend).
func jsMod(a, b float64) float64 { return math.Mod(a, b) }

// jsSubstring is String.prototype.substring on UTF-16 code units; the inputs
// here are ASCII timestamps, so runes are code units.
func jsSubstring(s string, start, end int) string {
	r := []rune(s)
	if start > len(r) {
		start = len(r)
	}
	if end > len(r) {
		end = len(r)
	}
	if start > end {
		start, end = end, start
	}
	return string(r[start:end])
}

// ---------------------------------------------------------------------------
// serviceHours

const (
	startupWindowMin = 30
	hourMs           = 3600 * 1000
	dayMs            = 24 * hourMs
)

var lineIDs = []string{"1", "2", "3", "4", "5", "6", "7", "8"}

var (
	shMu          sync.Mutex
	offsetByHour  = map[int64]int64{}
	dayByNumber   = map[int64]struct{ dayType, season string }{}
	windowByKey   = map[windowKey]*ServiceWindow{} // nil values are cached too
	shNoticeCount = -1
)

func floorDiv(a, b int64) int64 {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}

func madridOffsetMs(ts int64) int64 {
	bucket := floorDiv(ts, hourMs)
	if off, ok := offsetByHour[bucket]; ok {
		return off
	}
	at := bucket * hourMs
	c := getDateComponents(at)
	off := dateUTC(c.Year, c.Month-1, c.Day, c.Hour, c.Minute, c.Second) - at
	if len(offsetByHour) > 20000 {
		offsetByHour = map[int64]int64{}
	}
	offsetByHour[bucket] = off
	return off
}

func madridClock(ts int64) (int64, int64) {
	local := ts + madridOffsetMs(ts)
	dayNumber := floorDiv(local, dayMs)
	return dayNumber, (local - dayNumber*dayMs) / 1000
}

func serviceDay(dayNumber int64) (string, string) {
	if n := noticeWindowCount(); n != shNoticeCount {
		shNoticeCount = n
		dayByNumber = map[int64]struct{ dayType, season string }{}
	}
	if d, ok := dayByNumber[dayNumber]; ok {
		return d.dayType, d.season
	}
	midday := dayNumber*dayMs + 10*hourMs
	d := struct{ dayType, season string }{resolveDayType(midday).DayType, resolveSeason(midday).Season}
	if len(dayByNumber) > 2000 {
		dayByNumber = map[int64]struct{ dayType, season string }{}
	}
	dayByNumber[dayNumber] = d
	return d.dayType, d.season
}

type windowKey struct{ line, dayType, season string }

func lineWindow(lineID string, dayNumber int64) *ServiceWindow {
	dayType, season := serviceDay(dayNumber)
	key := windowKey{lineID, dayType, season}
	w, ok := windowByKey[key]
	if !ok {
		w = getServiceWindow(lineID, dayType, season)
		windowByKey[key] = w
	}
	return w
}

func lineIdOf(lineCode any) string {
	s := ""
	if !isNullish(lineCode) {
		s = jsString(lineCode)
	}
	// .replace(/^L/i, ''): only "L" and "l" fold to L.
	id := jsTrim(s)
	if id != "" && (id[0] == 'L' || id[0] == 'l') {
		id = id[1:]
	}
	for _, l := range lineIDs {
		if l == id {
			return id
		}
	}
	return ""
}

func inService(lineID string, dayNumber, secOfDay int64) bool {
	if t := lineWindow(lineID, dayNumber); t != nil && float64(secOfDay) >= t.StartSec && float64(secOfDay) <= t.EndSec {
		return true
	}
	y := lineWindow(lineID, dayNumber-1)
	return y != nil && y.EndSec > 86400 && float64(secOfDay+86400) <= y.EndSec
}

func isOutsideRevenueService(lineCode any, ts float64) bool {
	if !isFinite(ts) || ts <= 0 {
		return false
	}
	shMu.Lock()
	defer shMu.Unlock()
	dayNumber, sec := madridClock(int64(ts))
	ids := lineIDs
	if id := lineIdOf(lineCode); id != "" {
		ids = []string{id}
	}
	for _, l := range ids {
		if inService(l, dayNumber, sec) {
			return false
		}
	}
	return true
}

func isServiceStartup(lineCode any, ts float64, minutes float64) bool {
	id := lineIdOf(lineCode)
	if id == "" || !isFinite(ts) || ts <= 0 {
		return false
	}
	shMu.Lock()
	defer shMu.Unlock()
	dayNumber, sec := madridClock(int64(ts))
	w := lineWindow(id, dayNumber)
	return w != nil && float64(sec) >= w.StartSec && float64(sec) < w.FirstDepartureSec+minutes*60
}

// operatingHours returns ok=false for null.
func operatingHours(lineCode any, season string) (int, int, bool) {
	id := lineIdOf(lineCode)
	if id == "" {
		return 0, 0, false
	}
	minH, maxH := 24, -1
	for _, dt := range []string{"weekday", "saturday", "sunday"} {
		w := getServiceWindow(id, dt, season)
		if w == nil {
			continue
		}
		if h := int(math.Floor(w.FirstDepartureSec / 3600)); h < minH {
			minH = h
		}
		if h := int(math.Floor(math.Min(w.LastStopSec, 86399) / 3600)); h > maxH {
			maxH = h
		}
	}
	if maxH < 0 {
		return 0, 0, false
	}
	return minH, maxH, true
}

func serviceHoursOnDate(year, month, day int) map[int]bool {
	shMu.Lock()
	defer shMu.Unlock()
	dayNumber := floorDiv(dateUTC(year, month-1, day, 0, 0, 0), dayMs)
	hours := map[int]bool{}
	for _, id := range lineIDs {
		w := lineWindow(id, dayNumber)
		if w == nil {
			continue
		}
		last := math.Min(w.LastStopSec, 86399)
		for h := int(math.Floor(w.FirstDepartureSec / 3600)); h <= int(math.Floor(last/3600)); h++ {
			hours[h] = true
		}
	}
	return hours
}

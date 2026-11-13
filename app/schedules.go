package main

// Port of src/data/mataroSchedules.js and src/data/mataroFleet.js.

import (
	"encoding/json"
	"math"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// SchedStop is one stop of a direction; Raw keeps the file's own object so
// it serializes exactly as Node returns it.
type SchedStop struct {
	ID   string
	Seq  float64
	Name string
	Lat  float64
	Lon  float64
	Raw  *Obj
}

type tripRow struct {
	S []float64 // NaN = null (stop not served)
}

type dayStats struct {
	Count float64 `json:"count"`
}

type SchedDirection struct {
	DirID               string
	PathID              string
	Direction           string
	DirectionName       string
	OriginStop          *Obj
	TerminalStop        *Obj
	StopsCount          any
	TotalDistanceMeters float64
	TotalDistanceKm     float64
	TotalTravelSec      float64
	TotalTravelMinutes  float64
	AfternoonOnly       map[string]bool
	Schedules           map[string][]string
	ScheduleStats       map[string]dayStats
	StopTravelSecMap    *Obj // integer-like keys -> seconds
	HasStopTravelMap    bool
	Stops               []*SchedStop
	StopsRaw            []any
	DayStopTravelSec    map[string]*Obj
	DayTravelSec        map[string]float64
	EstimatedStops      []any
	HasEstimated        bool
	DayTrips            map[string][]tripRow
	HasDayTrips         bool
	Invalid             string
}

type SchedLine struct {
	LineID              string
	Code                string
	LineName            string
	Color               string
	Agency              string
	Operator            string
	Directions          map[string]*SchedDirection
	DirKeys             []string // Object.keys(directions)
	DirectionIndexOrder []string
	HasIndexOrder       bool
}

type schedGrid struct {
	lines map[string]*SchedLine
	keys  []string // grid keys in Object.keys order (excluding _meta)
	meta  *Obj
}

var (
	seasonGrids map[string]*schedGrid
	seasonKeys  []string
	seasonsMeta *Obj
	legacyGrid  *schedGrid
	scheduleMu  sync.Mutex
)

// loadSchedules reads the seasons file (and the legacy file, which is only
// served when the seasons file has no grid for the season in force).
func loadSchedules(seasonsPath, legacyPath string) error {
	if b, err := os.ReadFile(legacyPath); err == nil {
		v, err := parseJSON(b)
		if err != nil {
			return err
		}
		legacyGrid = buildGrid(v.(*Obj))
	} else {
		return err
	}
	b, err := os.ReadFile(seasonsPath)
	if err != nil {
		return nil // fresh clone without seasons file: legacy grid served
	}
	v, err := parseJSON(b)
	if err != nil {
		return nil
	}
	root, _ := v.(*Obj)
	if root == nil {
		return nil
	}
	seasonsMeta = root.ObjAt("_meta")
	if seasons := root.ObjAt("seasons"); seasons != nil {
		seasonGrids = map[string]*schedGrid{}
		seasonKeys = seasons.Keys()
		for _, k := range seasonKeys {
			if g, ok := seasons.Get(k).(*Obj); ok {
				seasonGrids[k] = buildGrid(g)
			}
		}
	}
	return nil
}

func buildGrid(g *Obj) *schedGrid {
	grid := &schedGrid{lines: map[string]*SchedLine{}, meta: g.ObjAt("_meta")}
	for _, k := range g.Keys() {
		if k == "_meta" {
			continue
		}
		lo, ok := g.Get(k).(*Obj)
		if !ok {
			continue
		}
		grid.keys = append(grid.keys, k)
		grid.lines[k] = buildLine(lo)
	}
	return grid
}

func buildLine(lo *Obj) *SchedLine {
	l := &SchedLine{
		LineID: lo.Str("lineId"), Code: lo.Str("code"), LineName: lo.Str("lineName"),
		Color: lo.Str("color"), Agency: lo.Str("agency"), Operator: lo.Str("operator"),
		Directions: map[string]*SchedDirection{},
	}
	if dirs := lo.ObjAt("directions"); dirs != nil {
		l.DirKeys = dirs.Keys()
		for _, dk := range l.DirKeys {
			if d, ok := dirs.Get(dk).(*Obj); ok {
				l.Directions[dk] = buildDirection(d)
			}
		}
	}
	if arr := lo.Arr("directionIndexOrder"); arr != nil {
		l.HasIndexOrder = true
		for _, x := range arr {
			l.DirectionIndexOrder = append(l.DirectionIndexOrder, jsString(x))
		}
	}
	return l
}

func buildDirection(d *Obj) *SchedDirection {
	sd := &SchedDirection{
		DirID: d.Str("dirId"), PathID: d.Str("pathId"), Direction: d.Str("direction"),
		DirectionName: d.Str("directionName"),
		OriginStop:    d.ObjAt("originStop"), TerminalStop: d.ObjAt("terminalStop"),
		StopsCount:          d.Get("stopsCount"),
		TotalDistanceMeters: numOrZero(d.Get("totalDistanceMeters")),
		TotalDistanceKm:     numOrZero(d.Get("totalDistanceKm")),
		TotalTravelSec:      numOrZero(d.Get("totalTravelSec")),
		TotalTravelMinutes:  numOrZero(d.Get("totalTravelMinutes")),
		AfternoonOnly:       map[string]bool{},
		Schedules:           map[string][]string{},
		ScheduleStats:       map[string]dayStats{},
		DayStopTravelSec:    map[string]*Obj{},
		DayTravelSec:        map[string]float64{},
		DayTrips:            map[string][]tripRow{},
	}
	if v, ok := d.Get("_invalid").(string); ok {
		sd.Invalid = v
	} else if truthy(d.Get("_invalid")) {
		sd.Invalid = jsString(d.Get("_invalid"))
	}
	if ao := d.ObjAt("afternoonOnly"); ao != nil {
		for _, k := range ao.Keys() {
			sd.AfternoonOnly[k] = truthy(ao.Get(k))
		}
	}
	if sc := d.ObjAt("schedules"); sc != nil {
		for _, k := range sc.Keys() {
			arr, ok := sc.Get(k).([]any)
			if !ok {
				continue // `schedules[day] || ...` falls through on null
			}
			list := make([]string, 0, len(arr))
			for _, x := range arr {
				list = append(list, jsString(x))
			}
			sd.Schedules[k] = list
		}
	}
	if st := d.ObjAt("scheduleStats"); st != nil {
		for _, k := range st.Keys() {
			if o := st.ObjAt(k); o != nil {
				sd.ScheduleStats[k] = dayStats{Count: numOrZero(o.Get("count"))}
			}
		}
	}
	if m := d.ObjAt("stopTravelSecMap"); m != nil {
		sd.StopTravelSecMap = m
		sd.HasStopTravelMap = true
	}
	sd.StopsRaw = d.Arr("stops")
	for _, x := range sd.StopsRaw {
		so, _ := x.(*Obj)
		if so == nil {
			so = O()
		}
		sd.Stops = append(sd.Stops, &SchedStop{
			ID: so.Str("id"), Seq: so.Num("seq"), Name: so.Str("name"),
			Lat: so.Num("lat"), Lon: so.Num("lon"), Raw: so,
		})
	}
	if m := d.ObjAt("dayStopTravelSec"); m != nil {
		for _, k := range m.Keys() {
			if o := m.ObjAt(k); o != nil {
				sd.DayStopTravelSec[k] = o
			}
		}
	}
	if m := d.ObjAt("dayTravelSec"); m != nil {
		for _, k := range m.Keys() {
			sd.DayTravelSec[k] = numOrZero(m.Get(k))
		}
	}
	if arr, ok := d.Get("_estimatedStops").([]any); ok {
		sd.HasEstimated = true
		sd.EstimatedStops = arr
	}
	if dt := d.ObjAt("dayTrips"); dt != nil {
		sd.HasDayTrips = true
		for _, k := range dt.Keys() {
			arr, ok := dt.Get(k).([]any)
			if !ok {
				continue
			}
			rows := []tripRow{}
			for _, t := range arr {
				to, _ := t.(*Obj)
				var s []float64
				if to != nil {
					for _, x := range to.Arr("s") {
						if f, ok := x.(float64); ok {
							s = append(s, f)
						} else {
							s = append(s, math.NaN())
						}
					}
				}
				rows = append(rows, tripRow{S: s})
			}
			sd.DayTrips[k] = rows
		}
	}
	return sd
}

// numOrZero is `x || 0` for a number field (anything non-numeric is 0).
func numOrZero(v any) float64 {
	f, ok := toF(v)
	if !ok || math.IsNaN(f) {
		return 0
	}
	return f
}

// activeGrid is cached per (season, known, source).
type activeGridT struct {
	key          string
	res          SeasonResolution
	grid         *schedGrid
	usingSeasons bool
	meta         *Obj
}

var activeCache *activeGridT

func activeGrid() *activeGridT {
	res := resolveSeason(nowMs())
	key := res.Season + "|" + strconv.FormatBool(res.Known) + "|" + res.Source
	scheduleMu.Lock()
	defer scheduleMu.Unlock()
	if activeCache != nil && activeCache.key == key {
		return activeCache
	}
	var chosen *schedGrid
	if seasonGrids != nil {
		chosen = seasonGrids[res.Season]
	}
	a := &activeGridT{key: key, res: res}
	if chosen != nil {
		a.grid = chosen
		a.usingSeasons = true
		a.meta = seasonsMeta
	} else {
		a.grid = legacyGrid
		a.meta = legacyGrid.meta
	}
	if a.meta == nil {
		a.meta = O()
	}
	activeCache = a
	return a
}

// normalizeSeason: "" -> active season; unrecognised -> "".
func normalizeSeason(season string) string {
	if season == "" {
		return activeGrid().res.Season
	}
	s := jsLower(jsTrim(season))
	switch s {
	case "hivern", "invierno", "winter":
		return "winter"
	case "estiu", "verano", "summer":
		return "summer"
	}
	return ""
}

func gridFor(season string) *schedGrid {
	norm := normalizeSeason(season)
	if norm == "" {
		return nil
	}
	a := activeGrid()
	if norm == a.res.Season {
		return a.grid
	}
	if seasonGrids != nil {
		return seasonGrids[norm]
	}
	return nil
}

var (
	reMataroPrefix = regexp.MustCompile(`^mataro_?`)
	reLinePrefix   = regexp.MustCompile(`^line-?`)
	reLiniaPrefix  = regexp.MustCompile(`^linia-?`)
	reLDigit       = regexp.MustCompile(`^l([1-8])$`)
	reLineID18     = regexp.MustCompile(`^[1-8]$`)
)

// normalizeLineId: '1', 'mataro_1', 'L1', 'Line 1' -> '1'..'8'.
func normalizeLineId(lineID string) string {
	clean := jsLower(jsTrim(lineID))
	clean = reMataroPrefix.ReplaceAllString(clean, "")
	clean = reLinePrefix.ReplaceAllString(clean, "")
	clean = reLiniaPrefix.ReplaceAllString(clean, "")
	clean = reLDigit.ReplaceAllString(clean, "$1")
	clean = jsTrim(clean)
	if clean == "" {
		return "1"
	}
	return clean
}

func normalizeDayType(dayType string) string {
	if dayType == "" {
		return "weekday"
	}
	s := jsLower(jsTrim(dayType))
	if strings.Contains(s, "dissabte") || strings.Contains(s, "sat") || s == "6" {
		return "saturday"
	}
	if strings.Contains(s, "diumenge") || strings.Contains(s, "festiu") || strings.Contains(s, "sun") || strings.Contains(s, "hol") || s == "0" || s == "7" {
		return "sunday"
	}
	return "weekday"
}

func toCatalanDayType(dayType string) string {
	switch normalizeDayType(dayType) {
	case "saturday":
		return "Dissabtes"
	case "sunday":
		return "Diumenges i Festius"
	}
	return "Feiners"
}

func getLineSchedule(lineID, season string) *SchedLine {
	grid := gridFor(season)
	if grid == nil {
		return nil
	}
	clean := normalizeLineId(lineID)
	if !reLineID18.MatchString(clean) {
		return nil
	}
	return grid.lines[clean]
}

var reAllDigits = regexp.MustCompile(`^\d+$`)

// resolveDirectionKey maps '0'/'1' (index) or '11'/'12'/'21' (path id) onto a key.
func resolveDirectionKey(l *SchedLine, direction string) string {
	if l == nil || l.Directions == nil {
		return ""
	}
	key := jsTrim(direction)
	if key == "" {
		return ""
	}
	order := l.DirKeys
	if l.HasIndexOrder {
		order = l.DirectionIndexOrder
	}
	if reAllDigits.MatchString(key) {
		if n, err := strconv.Atoi(key); err == nil && n >= 0 && n < len(order) {
			return order[n]
		}
	}
	if _, ok := l.Directions[key]; ok {
		return key
	}
	for _, dk := range l.DirKeys {
		if l.Directions[dk].PathID == key {
			return dk
		}
	}
	return ""
}

func isDirectionUsable(lineID, direction, season string) bool {
	l := getLineSchedule(lineID, season)
	key := resolveDirectionKey(l, direction)
	if key == "" {
		return false
	}
	return l.Directions[key].Invalid == ""
}

// DirSchedule is the object getDirectionSchedule returns.
type DirSchedule struct {
	LineID              string
	Code                string
	LineName            string
	Color               string
	DirID               string
	PathID              string
	Direction           string
	DirectionName       string
	OriginStop          *Obj
	TerminalStop        *Obj
	Departures          []string
	Trips               []tripRow // index = position
	Stops               []*SchedStop
	StopsRaw            []any
	StopTravelSecMap    *Obj
	EstimatedStopIDs    []any
	TotalTravelSec      float64
	TotalTravelMinutes  float64
	TotalDistanceMeters float64
	TotalDistanceKm     float64
	AfternoonOnly       bool
	FirstTrip           any
	LastTrip            any
	TripsCount          int
}

func getDirectionSchedule(lineID, direction, dayType, season string) *DirSchedule {
	l := getLineSchedule(lineID, season)
	if l == nil {
		return nil
	}
	dk := resolveDirectionKey(l, direction)
	if dk == "" {
		return nil
	}
	d := l.Directions[dk]
	if d == nil || d.Invalid != "" {
		return nil
	}
	normDay := normalizeDayType(dayType)
	catDay := toCatalanDayType(dayType)
	deps, ok := d.Schedules[normDay]
	if !ok {
		deps = d.Schedules[catDay]
	}
	if deps == nil {
		deps = []string{}
	}
	var trips []tripRow
	if d.HasDayTrips {
		if t, ok := d.DayTrips[normDay]; ok {
			trips = t
		} else {
			trips = d.DayTrips[catDay]
		}
	}
	totalTravelSec := d.DayTravelSec[normDay]
	if totalTravelSec == 0 {
		totalTravelSec = d.TotalTravelSec
	}
	totalTravelMinutes := jsRound(totalTravelSec / 60)
	if totalTravelMinutes == 0 {
		totalTravelMinutes = d.TotalTravelMinutes
	}
	stm := d.DayStopTravelSec[normDay]
	if stm == nil {
		if d.HasStopTravelMap {
			stm = d.StopTravelSecMap
		} else {
			stm = O()
		}
	}
	est := []any{}
	if d.HasEstimated {
		est = append(est, d.EstimatedStops...)
	}
	ds := &DirSchedule{
		LineID: l.LineID, Code: l.Code, LineName: l.LineName, Color: l.Color,
		DirID: d.DirID, PathID: d.PathID, Direction: d.Direction, DirectionName: d.DirectionName,
		OriginStop: d.OriginStop, TerminalStop: d.TerminalStop,
		Departures: deps, Trips: trips, Stops: d.Stops, StopsRaw: d.StopsRaw,
		StopTravelSecMap: stm, EstimatedStopIDs: est,
		TotalTravelSec: totalTravelSec, TotalTravelMinutes: totalTravelMinutes,
		TotalDistanceMeters: d.TotalDistanceMeters, TotalDistanceKm: d.TotalDistanceKm,
		AfternoonOnly: d.AfternoonOnly[normDay],
		FirstTrip:     nil, LastTrip: nil, TripsCount: len(deps),
	}
	if ds.StopsRaw == nil {
		ds.StopsRaw = []any{}
	}
	if len(deps) > 0 {
		ds.FirstTrip = deps[0]
		ds.LastTrip = deps[len(deps)-1]
		if deps[0] == "" {
			ds.FirstTrip = nil
		}
		if deps[len(deps)-1] == "" {
			ds.LastTrip = nil
		}
	}
	return ds
}

// stopTravel returns stopTravelSecMap[id] (ok=false when absent).
func (ds *DirSchedule) stopTravel(id string) (float64, bool) {
	v := ds.StopTravelSecMap.Get(id)
	if isUndef(v) {
		return 0, false
	}
	return jsNumber(v), !isNullish(v)
}

func (ds *DirSchedule) stopIndex(id string) int {
	for i, s := range ds.Stops {
		if s.ID == id {
			return i
		}
	}
	return -1
}

type TripAtStop struct {
	TripIndex      int
	OriginSec      float64 // NaN = null
	StopSec        float64
	FirstStopIndex int
	LastStopIndex  int
}

func getTripsServingStop(lineID, direction, stopID, dayType, season string) []TripAtStop {
	ds := getDirectionSchedule(lineID, direction, dayType, season)
	if ds == nil {
		return nil
	}
	idx := ds.stopIndex(stopID)
	if idx < 0 {
		return nil
	}
	if len(ds.Trips) > 0 {
		var out []TripAtStop
		for ti, t := range ds.Trips {
			if idx >= len(t.S) {
				continue
			}
			stopSec := t.S[idx]
			if math.IsNaN(stopSec) || math.IsInf(stopSec, 0) {
				continue
			}
			first, last := -1, -1
			for i, v := range t.S {
				if !math.IsNaN(v) {
					if first == -1 {
						first = i
					}
					last = i
				}
			}
			origin := math.NaN()
			if len(t.S) > 0 && !math.IsNaN(t.S[0]) {
				origin = t.S[0]
			}
			out = append(out, TripAtStop{TripIndex: ti, OriginSec: origin, StopSec: stopSec, FirstStopIndex: first, LastStopIndex: last})
		}
		sort.SliceStable(out, func(i, j int) bool {
			if out[i].StopSec != out[j].StopSec {
				return out[i].StopSec < out[j].StopSec
			}
			return out[i].TripIndex < out[j].TripIndex
		})
		return out
	}
	travel, _ := ds.stopTravel(stopID)
	if v := ds.StopTravelSecMap.Get(stopID); isNullish(v) {
		travel = 0
	}
	out := make([]TripAtStop, 0, len(ds.Departures))
	for i, dep := range ds.Departures {
		o := timeStringToSec(dep)
		out = append(out, TripAtStop{TripIndex: i, OriginSec: o, StopSec: o + travel, FirstStopIndex: 0, LastStopIndex: len(ds.Stops) - 1})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].StopSec < out[j].StopSec })
	return out
}

func posMod(a, m float64) float64 { return math.Mod(math.Mod(a, m)+m, m) }

// getTripStopTime: published seconds-of-day of the trip leaving its origin at
// originDep ('HH:MM') at stopID; ok=false when none.
func getTripStopTime(lineID, direction, originDep, stopID, dayType, season string) (float64, bool) {
	ds := getDirectionSchedule(lineID, direction, dayType, season)
	if ds == nil {
		return 0, false
	}
	idx := ds.stopIndex(stopID)
	if idx < 0 {
		return 0, false
	}
	target := timeStringToSec(originDep)
	if len(ds.Trips) > 0 {
		for _, t := range ds.Trips {
			if len(t.S) == 0 || math.IsNaN(t.S[0]) {
				continue
			}
			if posMod(t.S[0], 86400) == target {
				if idx < len(t.S) && isFinite(t.S[idx]) {
					return t.S[idx], true
				}
				return 0, false
			}
		}
		return 0, false
	}
	found := false
	for _, d := range ds.Departures {
		if d == originDep {
			found = true
			break
		}
	}
	if !found {
		return 0, false
	}
	v := ds.StopTravelSecMap.Get(stopID)
	if isNullish(v) {
		return 0, false
	}
	return target + jsNumber(v), true
}

// getStopTravelTime is the median-profile offset (interpolation only).
func getStopTravelTime(lineID, direction, stopID, dayType, season string) float64 {
	ds := getDirectionSchedule(lineID, direction, dayType, season)
	if ds == nil || ds.StopTravelSecMap == nil {
		return 0
	}
	v := ds.StopTravelSecMap.Get(stopID)
	if !truthy(v) {
		return 0
	}
	return jsNumber(v)
}

func hasStopInSchedule(lineID, direction, stopID, dayType, season string) bool {
	ds := getDirectionSchedule(lineID, direction, dayType, season)
	return ds != nil && ds.stopIndex(stopID) >= 0
}

func getDeparturesForStop(lineID, direction, stopID, dayType, season string) []string {
	trips := getTripsServingStop(lineID, direction, stopID, dayType, season)
	out := make([]string, 0, len(trips))
	for _, t := range trips {
		p := posMod(t.StopSec, 86400)
		out = append(out, pad2(int(math.Floor(p/3600)))+":"+pad2(int(math.Floor(math.Mod(p, 3600)/60))))
	}
	return out
}

// timeStringToSec (mataroSchedules) uses parseInt per part.
func timeStringToSec(s string) float64 {
	if s == "" {
		return 0
	}
	p := strings.Split(s, ":")
	get := func(i int) float64 {
		if i >= len(p) {
			return 0
		}
		n := parseIntJS(p[i])
		if math.IsNaN(n) {
			return 0
		}
		return n
	}
	return get(0)*3600 + get(1)*60 + get(2)
}

func getAllScheduleLines(season string) []any {
	grid := gridFor(season)
	if grid == nil {
		return []any{}
	}
	out := []any{}
	for _, k := range grid.keys {
		l := grid.lines[k]
		order := l.DirKeys
		if l.HasIndexOrder {
			order = l.DirectionIndexOrder
		}
		dirs := []any{}
		for _, dk := range order {
			d := l.Directions[dk]
			if d == nil || d.Invalid != "" {
				continue
			}
			dirs = append(dirs, O(
				"dirId", d.DirID, "pathId", d.PathID, "name", d.DirectionName,
				"stopsCount", d.StopsCount, "distanceKm", d.TotalDistanceKm, "travelMinutes", d.TotalTravelMinutes,
				"weekdayTrips", d.ScheduleStats["weekday"].Count,
				"saturdayTrips", d.ScheduleStats["saturday"].Count,
				"sundayTrips", d.ScheduleStats["sunday"].Count,
			))
		}
		out = append(out, O("id", l.LineID, "code", l.Code, "name", l.LineName, "color", l.Color,
			"agency", l.Agency, "operator", l.Operator, "directions", dirs))
	}
	return out
}

// getScheduleValidity mirrors mataroSchedules.getScheduleValidity.
func getScheduleValidity() *Obj {
	a := activeGrid()
	meta := a.meta
	seasonsAvail := []any{}
	for _, k := range seasonKeys {
		seasonsAvail = append(seasonsAvail, k)
	}
	add := func(o *Obj) *Obj {
		return o.Set("season", a.res.Season).Set("seasonSource", a.res.Source).
			Set("seasonKnown", a.res.Known).Set("seasonsAvailable", seasonsAvail).
			Set("usingSeasonsFile", a.usingSeasons)
	}
	source := ""
	if truthy(meta.Get("source")) {
		source = meta.Str("source")
	}
	vu := meta.Get("validUntil")
	if !truthy(vu) {
		return add(O("validUntil", nil, "expired", false, "known", false, "source", source))
	}
	validUntil := jsString(vu)
	expiry, ok := parseDateJS(validUntil + "T23:59:59Z")
	o := O("validUntil", validUntil, "known", ok, "expired", ok && nowMs() > expiry, "source", source)
	return add(o)
}

// activeSeasonObj is getActiveSeason() with no argument.
func activeSeasonObj() *Obj {
	a := activeGrid()
	return O("season", a.res.Season, "source", a.res.Source, "known", a.res.Known, "window", a.res.Window.toObj(), "usingSeasonsFile", a.usingSeasons)
}

// --- fleet requirement --------------------------------------------------

type fleetIvKey struct {
	line, day, season string
	t0, t1            float64
}

var (
	fleetIvCache   = map[fleetIvKey][2][]float64{}
	fleetIvCacheMu sync.Mutex
)

func countAtOrBelow(sorted []float64, x float64) int {
	return sort.Search(len(sorted), func(i int) bool { return sorted[i] > x })
}

// getScheduledFleetRequirement: whole-line peak concurrent trips over the next
// hour (hasNow) or the whole day.
func getScheduledFleetRequirement(lineID, dayType string, nowSec float64, hasNow bool, season string) float64 {
	normLine := normalizeLineId(lineID)
	normDay := normalizeDayType(dayType)
	s0 := getDirectionSchedule(normLine, "0", normDay, season)
	s1 := getDirectionSchedule(normLine, "1", normDay, season)
	if s0 == nil || s1 == nil {
		return 1
	}
	if len(s0.Departures) == 0 && len(s1.Departures) == 0 {
		return 0
	}
	t0 := s0.TotalTravelSec
	if t0 == 0 {
		t0 = s0.TotalTravelMinutes * 60
	}
	if t0 == 0 {
		t0 = 1800
	}
	t1 := s1.TotalTravelSec
	if t1 == 0 {
		t1 = s1.TotalTravelMinutes * 60
	}
	if t1 == 0 {
		t1 = 1800
	}
	key := fleetIvKey{normLine, normDay, normalizeSeason(season), t0, t1}
	fleetIvCacheMu.Lock()
	iv, ok := fleetIvCache[key]
	if !ok {
		var starts, ends []float64
		for _, d := range s0.Departures {
			s := timeStringToSec(d)
			starts = append(starts, s)
			ends = append(ends, s+t0+60)
		}
		for _, d := range s1.Departures {
			s := timeStringToSec(d)
			starts = append(starts, s)
			ends = append(ends, s+t1+60)
		}
		sort.Float64s(starts)
		sort.Float64s(ends)
		iv = [2][]float64{starts, ends}
		fleetIvCache[key] = iv
	}
	fleetIvCacheMu.Unlock()
	starts, ends := iv[0], iv[1]
	if hasNow {
		if len(starts) == 0 {
			return 0
		}
		first := math.Max(0, starts[0]-1200)
		last := starts[len(starts)-1] + math.Max(t0, t1)
		if nowSec < first || nowSec > last {
			return 0
		}
	}
	if len(starts) == 0 {
		return 0
	}
	winStart, winEnd := 0.0, 86400.0
	if hasNow {
		winStart = nowSec
		winEnd = math.Min(86400, nowSec+3600)
	}
	maxC := 0
	for s := winStart; s <= winEnd; s += 30 {
		c := countAtOrBelow(starts, s) - countAtOrBelow(ends, s)
		if c > maxC {
			maxC = c
		}
	}
	if hasNow {
		return float64(maxC)
	}
	return math.Max(1, float64(maxC))
}

// ServiceWindow is getServiceWindow's result.
type ServiceWindow struct {
	StartSec, EndSec, FirstDepartureSec, LastStopSec float64
}

var reLeadingL = regexp.MustCompile(`(?i)^l`)

func getServiceWindow(lineID, dayType, season string) *ServiceWindow {
	lID := reLeadingL.ReplaceAllString(lineID, "")
	sched := getLineSchedule(lID, season)
	if sched == nil || sched.Directions == nil {
		return nil
	}
	day := normalizeDayType(dayType)
	minO := math.Inf(1)
	maxE := math.Inf(-1)
	for _, dk := range sched.DirKeys {
		dir := sched.Directions[dk]
		if dir.Invalid != "" {
			continue
		}
		trips := dir.DayTrips[day]
		if len(trips) > 0 {
			for _, t := range trips {
				first, last := math.NaN(), math.NaN()
				for _, v := range t.S {
					if isFinite(v) {
						if math.IsNaN(first) {
							first = v
						}
						last = v
					}
				}
				if !math.IsNaN(first) && first < minO {
					minO = first
				}
				if !math.IsNaN(last) && last > maxE {
					maxE = last
				}
			}
		} else {
			travel := dir.DayTravelSec[day]
			if travel == 0 {
				travel = dir.TotalTravelSec
			}
			if travel == 0 {
				travel = 1800
			}
			for _, clock := range dir.Schedules[day] {
				s := timeStringToSec(clock)
				if s < minO {
					minO = s
				}
				if s+travel > maxE {
					maxE = s + travel
				}
			}
		}
	}
	if !isFinite(minO) || !isFinite(maxE) {
		return nil
	}
	return &ServiceWindow{StartSec: minO - 15*60, EndSec: maxE + 20*60, FirstDepartureSec: minO, LastStopSec: maxE}
}

// --- mataroFleet -------------------------------------------------------

var reNonDigit = regexp.MustCompile(`[^0-9]`)

func normalizeVehicleId(raw any) string {
	if isNullish(raw) {
		return ""
	}
	return strings.TrimSpace(reNonDigit.ReplaceAllString(jsString(raw), ""))
}

func isHybridId(norm string) bool {
	n, err := strconv.Atoi(norm)
	return err == nil && n >= 2668 && n <= 2687 && strconv.Itoa(n) == norm
}

func getVehicleFleetInfo(raw any) *Obj {
	norm := normalizeVehicleId(raw)
	h := isHybridId(norm)
	pick := func(s string) any {
		if h {
			return s
		}
		return nil
	}
	var vid string
	if truthy(raw) {
		vid = jsString(raw)
	} else {
		vid = norm
	}
	var propulsion any = nil
	if h {
		propulsion = "hybrid"
	}
	return O(
		"vehicleId", vid,
		"propulsion", propulsion,
		"isElectric", false,
		"isHybrid", h,
		"badgeText", pick("Híbrid Eco"),
		"badgeIcon", pick("🌱"),
		"badgeClass", pick("fleet-hybrid"),
		"propulsionBadge", pick("🌱 Híbrid Eco"),
		"modelName", pick("Volvo 7900 Hybrid"),
		"isAccessible", true,
		"hasAirConditioning", nil,
		"emissionStandard", pick("Euro VI"),
	)
}

var _ = json.Marshal

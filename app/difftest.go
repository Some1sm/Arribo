package main

// `arribo difftest <cases.jsonl> [dataDir]` replays the cases difftest/gen.js
// recorded from the JavaScript implementation and reports every result whose
// JSON differs. Exit status 1 when anything differs.

import (
	"bufio"
	"bytes"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

func runDifftest(args []string) int {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "usage: arribo difftest <cases.jsonl> [dataDir] [maxShown]")
		return 2
	}
	dataDir := "src/data"
	if len(args) > 1 {
		dataDir = args[1]
	}
	maxShown := 4
	if len(args) > 2 {
		maxShown, _ = strconv.Atoi(args[2])
	}
	checkFdlibmConsts()
	loadHolidays(filepath.Join(dataDir, "holidays.json"))
	if err := loadSchedules(filepath.Join(dataDir, "mataro_schedules.seasons.json"), filepath.Join(dataDir, "mataro_schedules.json")); err != nil {
		fmt.Fprintln(os.Stderr, "schedules:", err)
		return 2
	}
	f, err := os.Open(args[0])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	type stat struct{ total, bad int }
	stats := map[string]*stat{}
	var order []string
	shown := map[string]int{}
	for sc.Scan() {
		line := sc.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		v, err := parseJSON(line)
		if err != nil {
			fmt.Fprintln(os.Stderr, "bad case line:", err)
			return 2
		}
		c := v.(*Obj)
		fn := c.Str("fn")
		argv, _ := decodeArgs(c.Get("args")).([]any)
		want := c.Str("out")
		got := difftestCall(fn, argv)
		st := stats[fn]
		if st == nil {
			st = &stat{}
			stats[fn] = st
			order = append(order, fn)
		}
		st.total++
		if got != want {
			st.bad++
			if shown[fn] < maxShown {
				shown[fn]++
				a := toJSON(c.Get("args"))
				if len(a) > 600 {
					a = append(a[:600], "..."...)
				}
				fmt.Printf("DIFF %s args=%s\n  js=%s\n  go=%s\n", fn, a, clip(want, 1500), clip(got, 1500))
			}
		}
	}
	if err := sc.Err(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	bad := 0
	for _, fn := range order {
		st := stats[fn]
		mark := "ok"
		if st.bad > 0 {
			mark = "MISMATCH"
			bad++
		}
		fmt.Printf("%-34s %6d cases %6d diff  %s\n", fn, st.total, st.bad, mark)
	}
	if bad > 0 {
		return 1
	}
	return 0
}

// checkFdlibmConsts cross-checks every fdlibm constant's decimal literal
// against the hex words of the C source.
func checkFdlibmConsts() {
	type c struct {
		name   string
		v      float64
		hi, lo uint32
	}
	cs := []c{
		{"atanhi0", atanhi[0], 0x3FDDAC67, 0x0561BB4F}, {"atanhi1", atanhi[1], 0x3FE921FB, 0x54442D18},
		{"atanhi2", atanhi[2], 0x3FEF730B, 0xD281F69B}, {"atanhi3", atanhi[3], 0x3FF921FB, 0x54442D18},
		{"atanlo0", atanlo[0], 0x3C7A2B7F, 0x222F65E2}, {"atanlo1", atanlo[1], 0x3C81A626, 0x33145C07},
		{"atanlo2", atanlo[2], 0x3C700788, 0x7AF0CBBD}, {"atanlo3", atanlo[3], 0x3C91A626, 0x33145C07},
		{"aT0", aT[0], 0x3FD55555, 0x5555550D}, {"aT1", aT[1], 0xBFC99999, 0x9998EBC4},
		{"aT2", aT[2], 0x3FC24924, 0x920083FF}, {"aT3", aT[3], 0xBFBC71C6, 0xFE231671},
		{"aT4", aT[4], 0x3FB745CD, 0xC54C206E}, {"aT5", aT[5], 0xBFB3B0F2, 0xAF749A6D},
		{"aT6", aT[6], 0x3FB10D66, 0xA0D03D51}, {"aT7", aT[7], 0xBFADDE2D, 0x52DEFD9A},
		{"aT8", aT[8], 0x3FA97B4B, 0x24760DEB}, {"aT9", aT[9], 0xBFA2B444, 0x2C6A6C2F},
		{"aT10", aT[10], 0x3F90AD3A, 0xE322DA11},
		{"pi_o_4", fdPiO4, 0x3FE921FB, 0x54442D18}, {"pi_o_2", fdPiO2, 0x3FF921FB, 0x54442D18},
		{"pi", fdPi, 0x400921FB, 0x54442D18}, {"pi_lo", fdPiLo, 0x3CA1A626, 0x33145C07},
		{"o_threshold", expOThreshold, 0x40862E42, 0xFEFA39EF}, {"u_threshold", expUThreshold, 0xc0874910, 0xD52D3051},
		{"invln2", expInvLn2, 0x3ff71547, 0x652b82fe}, {"ln2HI", expLn2HI[0], 0x3fe62e42, 0xfee00000},
		{"ln2LO", expLn2LO[0], 0x3dea39ef, 0x35793c76},
		{"P1", expP1, 0x3FC55555, 0x5555553E}, {"P2", expP2, 0xBF66C16C, 0x16BEBD93},
		{"P3", expP3, 0x3F11566A, 0xAF25DE2C}, {"P4", expP4, 0xBEBBBD41, 0xC5D26BF1},
		{"P5", expP5, 0x3E663769, 0x72BEA4D0}, {"E", expE, 0x4005bf0a, 0x8b145769},
		{"twom1000", expTwom1000, 0x01700000, 0},
		{"S1", ksS1, 0xBFC55555, 0x55555549}, {"S2", ksS2, 0x3F811111, 0x1110F8A6},
		{"S3", ksS3, 0xBF2A01A0, 0x19C161D5}, {"S4", ksS4, 0x3EC71DE3, 0x57B1FE7D},
		{"S5", ksS5, 0xBE5AE5E6, 0x8A2B9CEB}, {"S6", ksS6, 0x3DE5D93A, 0x5ACFD57C},
		{"C1", kcC1, 0x3FA55555, 0x5555554C}, {"C2", kcC2, 0xBF56C16C, 0x16C15177},
		{"C3", kcC3, 0x3EFA01A0, 0x19CB1590}, {"C4", kcC4, 0xBE927E4F, 0x809C52AD},
		{"C5", kcC5, 0x3E21EE9E, 0xBDB4B1C4}, {"C6", kcC6, 0xBDA8FAE9, 0xBE8838D4},
		{"invpio2", rpInvPio2, 0x3FE45F30, 0x6DC9C883}, {"pio2_1", rpPio21, 0x3FF921FB, 0x54400000},
		{"pio2_1t", rpPio21t, 0x3DD0B461, 0x1A626331}, {"pio2_2", rpPio22, 0x3DD0B461, 0x1A600000},
		{"pio2_2t", rpPio22t, 0x3BA3198A, 0x2E037073}, {"pio2_3", rpPio23, 0x3BA3198A, 0x2E000000},
		{"pio2_3t", rpPio23t, 0x397B839A, 0x252049C1},
	}
	for _, k := range cs {
		b := math.Float64bits(k.v)
		if uint32(b>>32) != k.hi || uint32(b) != k.lo {
			fmt.Printf("FDLIBM CONST %s: decimal gives %08X %08X, comment says %08X %08X\n", k.name, uint32(b>>32), uint32(b), k.hi, k.lo)
		}
	}
	for n := 1; n <= 32; n++ {
		if hw := hiWord(float64(n) * (math.Pi / 2)); hw != npio2hw[n-1] {
			fmt.Printf("FDLIBM npio2_hw[%d] = %08X, computed %08X\n", n-1, npio2hw[n-1], hw)
		}
	}
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}

// decodeArgs restores what JSON could not carry.
func decodeArgs(v any) any {
	switch x := v.(type) {
	case string:
		if x == "__undef" {
			return Undefined
		}
		if strings.HasPrefix(x, "__num:") {
			switch x[6:] {
			case "NaN":
				return math.NaN()
			case "Infinity":
				return math.Inf(1)
			case "-Infinity":
				return math.Inf(-1)
			case "-0":
				return math.Copysign(0, -1)
			}
		}
		return x
	case []any:
		for i := range x {
			x[i] = decodeArgs(x[i])
		}
		return x
	case *Obj:
		for _, k := range x.Keys() {
			x.Set(k, decodeArgs(x.Get(k)))
		}
		return x
	}
	return v
}

func resultString(r any) string {
	switch x := r.(type) {
	case float64:
		if !isFinite(x) {
			return "NUM:" + numToString(x)
		}
	case undefinedT:
		return "undefined"
	}
	return string(toJSON(r))
}

func argTs(v any) int64 { return int64(jsNumber(v)) }

// seasonArg maps undefined/null/” to "" (the season in force).
func seasonArg(v any) string {
	if isNullish(v) {
		return ""
	}
	return jsString(v)
}

func coordsArg(v any) []LatLon {
	arr, _ := v.([]any)
	out := make([]LatLon, 0, len(arr))
	for _, p := range arr {
		out = append(out, normalizeCoordAny(p))
	}
	return out
}

func coordsArrArg(v any) [][]float64 {
	arr, _ := v.([]any)
	out := make([][]float64, 0, len(arr))
	for _, p := range arr {
		pa, _ := p.([]any)
		row := make([]float64, len(pa))
		for i, x := range pa {
			row[i] = jsNumber(x)
		}
		out = append(out, row)
	}
	return out
}

func latLonObj(p LatLon) *Obj { return O("lat", p.Lat, "lon", p.Lon) }

func nullableNum(f float64, ok bool) any {
	if !ok {
		return nil
	}
	return f
}

func (ds *DirSchedule) toObj() *Obj {
	if ds == nil {
		return nil
	}
	trips := make([]any, len(ds.Trips))
	for i, t := range ds.Trips {
		secs := make([]any, len(t.S))
		for j, s := range t.S {
			if math.IsNaN(s) {
				secs[j] = nil
			} else {
				secs[j] = s
			}
		}
		trips[i] = O("index", i, "stopSecs", secs)
	}
	deps := make([]any, len(ds.Departures))
	for i, d := range ds.Departures {
		deps[i] = d
	}
	return O(
		"lineId", ds.LineID, "code", ds.Code, "lineName", ds.LineName, "color", ds.Color,
		"dirId", ds.DirID, "pathId", ds.PathID, "direction", ds.Direction, "directionName", ds.DirectionName,
		"originStop", ds.OriginStop, "terminalStop", ds.TerminalStop,
		"departures", deps, "trips", trips, "stops", ds.StopsRaw,
		"stopTravelSecMap", ds.StopTravelSecMap, "estimatedStopIds", ds.EstimatedStopIDs,
		"totalTravelSec", ds.TotalTravelSec, "totalTravelMinutes", ds.TotalTravelMinutes,
		"totalDistanceMeters", ds.TotalDistanceMeters, "totalDistanceKm", ds.TotalDistanceKm,
		"afternoonOnly", ds.AfternoonOnly, "firstTrip", ds.FirstTrip, "lastTrip", ds.LastTrip,
		"tripsCount", ds.TripsCount,
	)
}

func (c DateComponents) toObj() *Obj {
	return O("dateStr", c.DateStr, "mmdd", c.MMDD, "year", c.Year, "month", c.Month, "monthIndex", c.MonthIndex,
		"day", c.Day, "dayOfWeek", c.DayOfWeek, "hour", c.Hour, "minute", c.Minute, "second", c.Second,
		"timeStr", c.TimeStr, "isWeekend", c.IsWeekend, "isSunday", c.IsSunday, "isSaturday", c.IsSaturday,
		"isWeekday", c.IsWeekday, "isAugust", c.IsAugust)
}

func (r SeasonResolution) toObj() *Obj {
	var w any = nil
	if r.Window != nil {
		w = r.Window.toObj()
	}
	return O("season", r.Season, "source", r.Source, "known", r.Known, "window", w)
}

func difftestCall(fn string, a []any) (res string) {
	defer func() {
		if p := recover(); p != nil {
			res = fmt.Sprintf("PANIC: %v", p)
		}
	}()
	arg := func(i int) any {
		if i < len(a) {
			return a[i]
		}
		return Undefined
	}
	s := func(i int) string { return jsString(arg(i)) }
	n := func(i int) float64 { return jsNumber(arg(i)) }
	var r any
	switch fn {
	case "String":
		r = numToString(n(0))
	case "toFixed":
		r = toFixed(n(0), int(n(1)))
	case "Math.round":
		r = jsRound(n(0))
	case "Number":
		r = numToString(jsNumber(arg(0)))
	case "parseFloat":
		r = numToString(parseFloatJS(arg(0)))
	case "parseInt":
		r = numToString(parseIntJS(arg(0)))
	case "JSON.stringify":
		r = s(0)
	case "Math.sin":
		r = jsSin(n(0))
	case "Math.cos":
		r = jsCos(n(0))
	case "Math.atan2":
		r = jsAtan2(n(0), n(1))
	case "Math.atan2s":
		r = jsAtan2(math.Sqrt(n(0)), math.Sqrt(1-n(0)))
	case "Math.sqrt":
		r = math.Sqrt(n(0))
	case "Math.exp":
		r = jsExp(n(0))
	case "Math.pow":
		r = jsPow(n(0), n(1))

	case "timeStringToMinutes":
		r = timeStringToMinutes(s(0))
	case "timeStringToSeconds":
		r = timeStringToSeconds(s(0))
	case "timeStringToSec":
		r = timeStringToSec(s(0))
	case "minutesToTimeString":
		r = minutesToTimeString(n(0))
	case "secondsToTimeString":
		r = secondsToTimeString(n(0))
	case "getNetworkTime":
		t := getNetworkTime(argTs(arg(0)))
		r = O("timeZone", "Europe/Madrid", "year", t.Year, "month", t.Month, "month1", t.Month1, "day", t.Day,
			"hour", t.Hour, "minute", t.Minute, "second", t.Second, "currentSec", t.CurrentSec,
			"dateStr", t.DateStr, "timeStr", t.TimeStr, "dayOfWeek", t.DayOfWeek)
	case "formatTimeToTimezone":
		r = formatTimeToTimezone(argTs(arg(0)), true)
	case "getDateComponents":
		r = getDateComponents(argTs(arg(0))).toObj()
	case "getServiceCalendarInfo":
		r = serviceCalendarInfoBase(argTs(arg(0)))
	case "isHoliday":
		r = isHoliday(argTs(arg(0)))
	case "isHolidayKnown":
		r = isHolidayKnown(argTs(arg(0)))
	case "holidayInfo":
		r = holidayInfo(argTs(arg(0)))
	case "getHolidayCoverage":
		r = getHolidayCoverage(argTs(arg(0)))
	case "getServiceOverride":
		if ov := getServiceOverride(argTs(arg(0))); ov != "" {
			r = ov
		} else {
			r = nil
		}
	case "madridDate":
		r = madridDate(argTs(arg(0)))
	case "resolveSeason":
		r = resolveSeason(argTs(arg(0))).toObj()
	case "getSeasonOutlook":
		r = getSeasonOutlook(argTs(arg(0)))
	case "resolveDayType":
		d := resolveDayType(argTs(arg(0)))
		o := O("dayType", d.DayType, "components", d.C.toObj(), "isHoliday", d.IsHoliday)
		if d.IsOverride {
			o.Set("isOverride", true)
		}
		r = o
	case "localTimeToUtcDate":
		r = float64(localTimeToUtcDate(int(n(0)), int(n(1)), int(n(2)), int(n(3)), int(n(4)), int(n(5))))
	case "easterSunday":
		m, d := easterSunday(int(n(0)))
		r = O("month", m, "day", d)
	case "holidaysForYear":
		set := holidaysForYear(int(n(0)))
		keys := make([]string, 0, len(set))
		for k := range set {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		r = keys

	case "normalizeLineId":
		r = normalizeLineId(s(0))
	case "normalizeDayType":
		r = normalizeDayType(s(0))
	case "toCatalanDayType":
		r = toCatalanDayType(s(0))
	case "normalizeSeason":
		if v := normalizeSeason(seasonArg(arg(0))); v != "" {
			r = v
		} else {
			r = nil
		}
	case "getScheduleValidity":
		r = getScheduleValidity()
	case "getAllLines":
		r = getAllScheduleLines(seasonArg(arg(0)))
	case "getDirectionSchedule":
		r = getDirectionSchedule(s(0), dirArg(arg(1)), s(2), seasonArg(arg(3))).toObj()
	case "isDirectionUsable":
		r = isDirectionUsable(s(0), seasonArg(arg(1)), seasonArg(arg(2))) // no default: undefined -> ''
	case "getTripsServingStop":
		trips := getTripsServingStop(s(0), dirArg(arg(1)), s(2), s(3), seasonArg(arg(4)))
		out := make([]any, len(trips))
		for i, t := range trips {
			var origin any = t.OriginSec
			if math.IsNaN(t.OriginSec) {
				origin = nil
			}
			out[i] = O("tripIndex", t.TripIndex, "originSec", origin, "stopSec", t.StopSec,
				"firstStopIndex", t.FirstStopIndex, "lastStopIndex", t.LastStopIndex)
		}
		r = out
	case "getStopTravelTime":
		r = getStopTravelTime(s(0), dirArg(arg(1)), s(2), s(3), seasonArg(arg(4)))
	case "hasStopInSchedule":
		r = hasStopInSchedule(s(0), dirArg(arg(1)), s(2), s(3), seasonArg(arg(4)))
	case "getDeparturesForStop":
		r = getDeparturesForStop(s(0), dirArg(arg(1)), s(2), s(3), seasonArg(arg(4)))
	case "getTripStopTime":
		r = nullableNum(getTripStopTime(s(0), dirArg(arg(1)), s(2), s(3), s(4), seasonArg(arg(5))))
	case "getScheduledFleetRequirement":
		r = getScheduledFleetRequirement(s(0), s(1), n(2), !isUndef(arg(2)), seasonArg(arg(3)))
	case "getServiceWindow":
		if w := getServiceWindow(s(0), s(1), seasonArg(arg(2))); w != nil {
			r = O("startSec", w.StartSec, "endSec", w.EndSec, "firstDepartureSec", w.FirstDepartureSec, "lastStopSec", w.LastStopSec)
		} else {
			r = nil
		}
	case "getVehicleFleetInfo":
		r = getVehicleFleetInfo(arg(0))
	case "normalizeVehicleId":
		r = normalizeVehicleId(arg(0))

	case "calculateDistanceMeters":
		r = distM(n(0), n(1), n(2), n(3))
	case "calculateBearing":
		r = bearing(n(0), n(1), n(2), n(3))
	case "gapDistanceM":
		r = gapDistanceM(n(0), n(1), n(2), n(3))
	case "interpolateCoordinate":
		r = latLonObj(interpolateCoordinate(LatLon{n(0), n(1)}, LatLon{n(2), n(3)}, n(4)))
	case "getCompassDirection":
		r = getCompassDirection(n(0))
	case "snapPointToPolyline":
		sn := snapPointToPolyline(LatLon{n(0), n(1)}, coordsArg(arg(2)))
		r = O("lat", sn.Lat, "lon", sn.Lon, "index", sn.Index, "bearing", sn.Bearing, "dist", sn.Dist)
	case "calculatePolylineDistanceBetween":
		r = calculatePolylineDistanceBetween(coordsArg(arg(0)), n(1), n(2), n(3), n(4))
	case "calculateRouteTotalDistance":
		r = calculateRouteTotalDistance(coordsArg(arg(0)))
	case "extrapolatePolylinePosition":
		pos := normalizeCoordAny(arg(0))
		var pb any = Undefined
		if o, ok := arg(0).(*Obj); ok {
			pb = o.Get("bearing")
		}
		ex, ok := extrapolatePolylinePosition(pos, pb, n(1), n(2), coordsArg(arg(3)))
		if !ok {
			r = nil
		} else {
			r = O("lat", ex.Lat, "lon", ex.Lon, "bearing", ex.BearingRaw, "progress", ex.Progress)
		}
	case "buildPolylineDistanceTable":
		t := buildPolylineDistanceTable(coordsArg(arg(0)))
		r = O("cum", t.Cum, "total", t.Total)
	case "pointAtDistance":
		c := coordsArg(arg(0))
		t := buildPolylineDistanceTable(c)
		p, b, ok := pointAtDistance(c, &t, n(1))
		if !ok {
			r = nil
		} else {
			r = O("lat", p.Lat, "lon", p.Lon, "bearing", b)
		}
	case "composeRouteWithStops":
		var stops []LatLon
		for _, st := range arg(1).([]any) {
			o := st.(*Obj)
			stops = append(stops, LatLon{o.Num("lat"), o.Num("lon")})
		}
		opt, _ := arg(2).(*Obj)
		th, mx := 150.0, 400.0
		if opt != nil && !opt.IsNullish("thresholdM") {
			th = opt.Num("thresholdM")
		}
		if opt != nil && !opt.IsNullish("maxSpliceM") {
			mx = opt.Num("maxSpliceM")
		}
		coords, stitched := composeRouteWithStops(coordsArrArg(arg(0)), stops, th, mx)
		r = O("coords", coords, "stitched", stitched)
	case "gapPath":
		lost, reg := arg(1).(*Obj), arg(2).(*Obj)
		path, length, ok := gapPathCompute(coordsArg(arg(0)), LatLon{lost.Num("lat"), lost.Num("lon")}, LatLon{reg.Num("lat"), reg.Num("lon")}, n(3))
		if !ok {
			r = nil
		} else {
			r = O("path", path, "lengthM", length)
		}
	case "decodePolyline":
		pts := decodePolyline(s(0))
		out := make([]any, len(pts))
		for i, p := range pts {
			out[i] = latLonObj(p)
		}
		r = out
	case "clusterPoints":
		var pts []*Obj
		for _, p := range arg(0).([]any) {
			pts = append(pts, p.(*Obj))
		}
		rad := gapRadiusM
		if !isUndef(arg(1)) {
			rad = n(1)
		}
		cl := clusterPoints(pts, rad)
		out := make([]any, len(cl))
		for i, c := range cl {
			mem := make([]any, len(c.Members))
			for j, m := range c.Members {
				mem[j] = m
			}
			out[i] = O("lat", c.Lat, "lon", c.Lon, "members", mem)
		}
		r = out
	case "GpsGapDetector":
		det := newGpsGapDetector()
		var out []any
		for _, b := range arg(0).([]any) {
			g := det.observe(b.(*Obj))
			if g == nil {
				out = append(out, nil)
			} else {
				out = append(out, g)
			}
		}
		if out == nil {
			out = []any{}
		}
		r = out
	case "poissonTail":
		r = poissonTail(int(n(0)), n(1))
	case "rankBuses":
		var gaps []GapRow
		for _, g := range arg(0).([]any) {
			o := g.(*Obj)
			gaps = append(gaps, GapRow{ID: o.Get("id"), VehicleID: o.Str("vehicleId"), LineCode: o.Str("lineCode"), GapSec: o.Num("gapSec"), Shared: o.Bool("shared")})
		}
		var visits []VisitRow
		for _, v := range arg(1).([]any) {
			o := v.(*Obj)
			visits = append(visits, VisitRow{VehicleID: o.Str("vehicleId"), LineCode: o.Str("lineCode"), N: o.Num("n")})
		}
		r = rankBuses(gaps, visits)

	case "normalizeStopName":
		r = normalizeStopName(s(0))
	case "circularDiffSec":
		r = circularDiffSec(n(0), n(1))
	case "medianHeadwayMinutes":
		var list []string
		for _, x := range arg(0).([]any) {
			list = append(list, jsString(x))
		}
		r = nullableNum(medianHeadwayMinutes(list))
	case "matchTrip", "matchTripStart":
		o := arg(0).(*Obj)
		ma := MatchArgs{LineID: o.Get("lineId"), Direction: o.Get("direction"), ToSeq: o.Get("toSeq"),
			StopName: o.Get("stopName"), DelayMins: o.Get("delayMins"), At: o.Get("at")}
		if fn == "matchTrip" {
			r = matchTrip(ma)
		} else {
			r = matchTripStart(ma)
		}
	case "computeDelayStatus":
		opt, _ := arg(2).(*Obj)
		r = computeDelayStatus(arg(0), truthy(arg(1)), opt)
	case "formatCountdownStatus":
		r = formatCountdownStatus(arg(0))
	case "standardizeDeparture":
		d, _ := arg(0).(*Obj)
		def, _ := arg(1).(*Obj)
		r = standardizeDeparture(d, def)
	case "isOutsideRevenueService":
		r = isOutsideRevenueService(arg(0), n(1))
	case "isServiceStartup":
		mins := float64(startupWindowMin)
		if !isUndef(arg(2)) {
			mins = n(2)
		}
		r = isServiceStartup(arg(0), n(1), mins)
	case "operatingHours":
		minH, maxH, ok := operatingHours(arg(0), seasonArg(arg(1)))
		if !ok {
			r = nil
		} else {
			r = O("minH", minH, "maxH", maxH)
		}
	case "serviceHoursOnDate":
		set := serviceHoursOnDate(int(n(0)), int(n(1)), int(n(2)))
		hs := make([]int, 0, len(set))
		for h := range set {
			hs = append(hs, h)
		}
		sort.Ints(hs)
		r = hs
	case "estimateStopTravelTimes", "getTravelTimeToStop":
		var stops []*Obj
		for _, x := range arg(0).([]any) {
			o, _ := x.(*Obj)
			stops = append(stops, o)
		}
		opt, _ := arg(1).(*Obj)
		rows := estimateStopTravelTimes(stops, opt)
		if fn == "getTravelTimeToStop" {
			r = getTravelTimeToStop(rows, s(2))
		} else {
			out := make([]any, len(rows))
			for i, row := range rows {
				out[i] = row.toObj()
			}
			r = out
		}
	case "compileStopDepartures":
		o, _ := arg(0).(*Obj)
		list := compileStopDepartures(o)
		out := make([]any, len(list))
		for i, d := range list {
			out[i] = d
		}
		r = out
	case "findDelayJumps", "findTripRelinks", "findBackwardLegs", "findDeadheadReturns", "jumpCovering", "jumpOverlapping":
		var samples []*Obj
		for _, x := range arg(0).([]any) {
			o, _ := x.(*Obj)
			samples = append(samples, o)
		}
		objs := func(l []*Obj) []any {
			out := make([]any, len(l))
			for i, o := range l {
				out[i] = o
			}
			return out
		}
		switch fn {
		case "findDelayJumps":
			r = objs(findDelayJumps(samples))
		case "findTripRelinks":
			var si StopIndexFn
			if truthy(arg(1)) {
				si = scheduleStopIndex()
			}
			r = objs(findTripRelinks(samples, si))
		case "findBackwardLegs":
			r = objs(findBackwardLegs(samples, scheduleStopIndex()))
		case "findDeadheadReturns":
			r = objs(findDeadheadReturns(samples, scheduleStopIndex(), scheduleTripMinutes))
		case "jumpCovering":
			if j := jumpCovering(findDelayJumps(samples), arg(1), arg(2), arg(3)); j != nil {
				r = j
			} else {
				r = nil
			}
		case "jumpOverlapping":
			if j := jumpOverlapping(findDelayJumps(samples), arg(1), arg(2), arg(3), arg(4)); j != nil {
				r = j
			} else {
				r = nil
			}
		}
	case "localeCompare":
		r = localeCompareJS(s(0), s(1), truthy(arg(2)))
	case "classifyDelay":
		r = classifyDelay(n(0))
	case "buildIncidentRun":
		var rows []*Obj
		for _, x := range arg(0).([]any) {
			o, _ := x.(*Obj)
			rows = append(rows, o)
		}
		o := arg(1).(*Obj)
		si := scheduleStopIndex()
		var phantom []*Obj
		phantom = append(phantom, findDeadheadReturns(rows, si, scheduleTripMinutes)...)
		for _, b := range findBackwardLegs(rows, scheduleStopIndex()) {
			phantom = append(phantom, O("lineCode", b.Get("lineCode"), "phantomFromTs", b.Get("staleFromTs"), "phantomToTs", b.Get("staleToTs"), "kind", "backward"))
		}
		opt := IncidentRunOpts{
			ClickedStop: strOr(o.Get("clickedStop"), ""),
			ClickedFrom: o.Get("clickedFrom"),
			ClickedTo:   o.Get("clickedTo"),
			ShowFrom:    o.Get("showFrom"),
		}
		if truthy(o.Get("useTowards")) {
			opt.Towards = func(l, d any) string { return directionTerminus(l, d) }
		}
		if truthy(o.Get("useIdx")) {
			opt.StopIndex = scheduleStopIndex()
			opt.DirectionStops = directionStopNames
		}
		if truthy(o.Get("useDH")) {
			opt.Deadheads = phantom
		}
		r = buildIncidentRun(rows, opt).toObj()
	default:
		return "UNKNOWN FN"
	}
	return resultString(r)
}

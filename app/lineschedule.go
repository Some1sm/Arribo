package main

// GET /api/line/:lineId/schedule[?stopId=...]:
// Full-day departure timetable across weekdays (Mon-Fri), Saturdays, and
// Sundays/holidays for any line in Arribo — both Mataró Bus (from schedules.go)
// and every GTFS-backed rail/metro/tram/bus operator (via sharedRailTT).

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	lineScheduleCacheTTL = 10 * time.Minute
	lineScheduleCacheMax = 128
)

type lineScheduleCacheEntry struct {
	at   time.Time
	data *Obj
}

var lineScheduleCache = struct {
	mu      sync.Mutex
	entries map[string]lineScheduleCacheEntry
}{entries: map[string]lineScheduleCacheEntry{}}

func todayScheduleDayType(now time.Time) string {
	switch now.In(madrid).Weekday() {
	case time.Saturday:
		return "saturday"
	case time.Sunday:
		return "sunday"
	default:
		return "weekday"
	}
}

// nextWeekdayDate returns the next date (including today) whose weekday equals target.
func nextWeekdayDate(now time.Time, target time.Weekday) time.Time {
	t := now.In(madrid)
	base := time.Date(t.Year(), t.Month(), t.Day(), 12, 0, 0, 0, madrid)
	diff := (int(target) - int(base.Weekday()) + 7) % 7
	return base.AddDate(0, 0, diff)
}

func formatScheduleDayObj(secs []int) *Obj {
	if len(secs) == 0 {
		return O("times", []any{}, "count", 0.0, "first", nil, "last", nil, "avgHeadwayMin", nil)
	}
	sort.Ints(secs)
	// Deduplicate identical minute slots while preserving post-midnight order.
	times := make([]any, 0, len(secs))
	uniqSecs := make([]int, 0, len(secs))
	lastMin := -1
	for _, s := range secs {
		m := s / 60
		if m == lastMin {
			continue
		}
		lastMin = m
		uniqSecs = append(uniqSecs, s)
		mod := ((s % 86400) + 86400) % 86400
		hh := mod / 3600
		mm := (mod % 3600) / 60
		times = append(times, fmt.Sprintf("%02d:%02d", hh, mm))
	}
	var avgHeadway any
	if len(uniqSecs) >= 2 {
		span := uniqSecs[len(uniqSecs)-1] - uniqSecs[0]
		if span > 0 {
			avgHeadway = math.Round(float64(span)/float64(len(uniqSecs)-1)/60.0*10) / 10
		}
	}
	return O(
		"times", times,
		"count", float64(len(times)),
		"first", times[0],
		"last", times[len(times)-1],
		"avgHeadwayMin", avgHeadway,
	)
}

func formatScheduleTimesFromStrings(raw []string) *Obj {
	secs := make([]int, 0, len(raw))
	for _, hhmm := range raw {
		parts := strings.Split(strings.TrimSpace(hhmm), ":")
		if len(parts) < 2 {
			continue
		}
		hh, err1 := strconv.Atoi(parts[0])
		mm, err2 := strconv.Atoi(parts[1])
		if err1 != nil || err2 != nil || hh < 0 || mm < 0 || mm >= 60 {
			continue
		}
		s := hh*3600 + mm*60
		// Keep post-midnight service times (00:00..03:59) after 23:59 when mixed with daytime trips.
		if hh < 4 && len(raw) > 5 {
			s += 86400
		}
		secs = append(secs, s)
	}
	return formatScheduleDayObj(secs)
}

// dayScheduleSecs queries all scheduled departure seconds (from service-day 00:00)
// for (code, stopID, dir) on sampleDay. If the feed's calendar has expired
// (0 rows with date range), it falls back to matching the weekday column alone.
func (t *rtTimetable) dayScheduleSecs(ctx context.Context, code, stopID string, dir int, sampleDay time.Time) ([]int, bool, error) {
	date := sampleDay.Format("20060102")
	col := gtfsWeekdayColumn[sampleDay.Weekday()]

	runQuery := func(ignoreDateRange bool) ([]int, error) {
		var activeCTE string
		var args []any
		if ignoreDateRange {
			activeCTE = `WITH active(service_id) AS (
			    SELECT service_id FROM calendar WHERE ` + col + ` = 1
			  )`
			args = []any{stopID, code}
		} else {
			activeCTE = `WITH active(service_id) AS (
			    SELECT service_id FROM calendar WHERE start_date <= ?1 AND end_date >= ?1 AND ` + col + ` = 1
			    UNION SELECT service_id FROM calendar_dates WHERE date = ?1 AND exception_type = 1
			    EXCEPT SELECT service_id FROM calendar_dates WHERE date = ?1 AND exception_type = 2
			  )`
			args = []any{date, stopID, code}
		}
		pStop, pCode, pDir := "?2", "?3", "?4"
		if ignoreDateRange {
			pStop, pCode, pDir = "?1", "?2", "?3"
		}
		dirClause := ""
		if dir >= 0 {
			dirClause = " AND t.direction_id = " + pDir
			args = append(args, dir)
		}
		q := activeCTE + `, here(stop_id) AS (
		    SELECT stop_id FROM stops WHERE stop_id = ` + pStop + `
		    UNION SELECT stop_id FROM stops WHERE parent_station = ` + pStop + `
		    UNION SELECT s2.stop_id FROM stops s1 JOIN stops s2
		      ON s1.parent_station != '' AND s2.parent_station = s1.parent_station
		      WHERE s1.stop_id = ` + pStop + `
		  )
		  SELECT DISTINCT COALESCE(st.departure_sec, st.arrival_sec)
		  FROM stop_times st
		  JOIN here h ON h.stop_id = st.stop_id
		  JOIN trips t ON t.trip_id = st.trip_id
		  JOIN routes r ON r.route_id = t.route_id
		  JOIN active a ON a.service_id = t.service_id
		  WHERE LOWER(COALESCE(NULLIF(r.short_name, ''), r.route_id)) = LOWER(` + pCode + `)
		    AND COALESCE(st.departure_sec, st.arrival_sec) IS NOT NULL` + dirClause + `
		    AND EXISTS (SELECT 1 FROM stop_times st2 WHERE st2.trip_id = st.trip_id AND st2.stop_sequence > st.stop_sequence)
		  ORDER BY 1`
		rows, err := t.db.QueryContext(ctx, q, args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []int
		for rows.Next() {
			var sec int
			if err := rows.Scan(&sec); err == nil {
				out = append(out, sec)
			}
		}
		return out, rows.Err()
	}

	secs, err := runQuery(false)
	if err != nil {
		return nil, false, err
	}
	if len(secs) > 0 {
		return secs, false, nil
	}
	// Fallback for expired static calendars (e.g. TMESA Terrassa NAP 1175).
	fb, err := runQuery(true)
	if err != nil {
		return nil, false, err
	}
	return fb, len(fb) > 0, nil
}

func (s *Server) buildMataroLineSchedule(lineID, reqStopID string, now time.Time) *Obj {
	grid := gridFor("")
	if grid == nil {
		return nil
	}
	want := strings.TrimSpace(lineID)
	want = strings.TrimPrefix(strings.ToLower(want), "mataro:")
	var canon string
	var l *SchedLine
	for _, k := range grid.keys {
		cand := grid.lines[k]
		if cand == nil {
			continue
		}
		if strings.EqualFold(k, want) || strings.EqualFold(cand.Code, want) || strings.EqualFold("l"+k, want) {
			canon = k
			l = cand
			break
		}
	}
	if l == nil {
		return nil
	}
	order := l.DirKeys
	if l.HasIndexOrder {
		order = l.DirectionIndexOrder
	}
	dirs := make([]any, 0, len(order))
	for _, dk := range order {
		d := l.Directions[dk]
		if d == nil || d.Invalid != "" || len(d.Stops) == 0 {
			continue
		}
		targetStop := d.Stops[0]
		if reqStopID != "" {
			for _, st := range d.Stops {
				if st.ID == reqStopID {
					targetStop = st
					break
				}
			}
		}
		stopsList := make([]any, 0, len(d.Stops))
		for _, st := range d.Stops {
			stopsList = append(stopsList, O("id", st.ID, "name", st.Name))
		}
		wk := getDeparturesForStop(canon, dk, targetStop.ID, "weekday", "")
		sat := getDeparturesForStop(canon, dk, targetStop.ID, "saturday", "")
		sun := getDeparturesForStop(canon, dk, targetStop.ID, "sunday", "")
		dirs = append(dirs, O(
			"direction", dk,
			"name", d.DirectionName,
			"selectedStop", O("id", targetStop.ID, "name", targetStop.Name),
			"stops", stopsList,
			"days", O(
				"weekday", formatScheduleTimesFromStrings(wk),
				"saturday", formatScheduleTimesFromStrings(sat),
				"sunday", formatScheduleTimesFromStrings(sun),
			),
		))
	}
	return O(
		"lineId", canon,
		"code", l.Code,
		"name", l.LineName,
		"agency", "Mataró Bus",
		"source", "mataro_schedules",
		"todayDayType", todayScheduleDayType(now),
		"calendarExpired", false,
		"directions", dirs,
	)
}

// findGencatBusScheduleMatch locates the matching route & profile in gencat_bus
// for live web-polled operators (Moventis Casas, Sagalés) that do not have
// their own static GTFS SQLite file. Matches by normalized code ("C-10" == "C10")
// and spatial proximity (<= 20 km).
func findGencatBusScheduleMatch(code string, srcProf *rtLineProfile) (string, *rtLineProfile, bool) {
	v, ok := rtCatalog.Load(gencatBusAgencyID)
	if !ok {
		return "", nil, false
	}
	gbOp := v.(*rtCatalogOp)
	wantNorm := ambNormLine(code)
	if wantNorm == "" {
		return "", nil, false
	}
	srcLat, srcLon, hasSrc := profileMidpoint(srcProf)
	bestCode := ""
	var bestProf *rtLineProfile
	bestDist := 1e9
	for _, r := range gbOp.Lines {
		if ambNormLine(r.Code) != wantNorm {
			continue
		}
		p := gbOp.Profiles[r.Code]
		if p == nil || len(p.Directions) == 0 {
			continue
		}
		if !hasSrc {
			return r.Code, p, true
		}
		lat, lon, hasPt := profileMidpoint(p)
		if !hasPt {
			if bestProf == nil {
				bestCode, bestProf = r.Code, p
			}
			continue
		}
		d := haversineKm(srcLat, srcLon, lat, lon)
		if d <= 20.0 && d < bestDist {
			bestDist = d
			bestCode = r.Code
			bestProf = p
		}
	}
	return bestCode, bestProf, bestProf != nil
}

func buildRailLineSchedule(ctx context.Context, info operatorInfo, op *rtCatalogOp, code, reqStopID string, now time.Time) *Obj {
	prof := op.Profiles[code]
	if prof == nil || len(prof.Directions) == 0 {
		return nil
	}
	var route rtRoute
	for _, r := range op.Lines {
		if strings.EqualFold(r.Code, code) {
			route = r
			break
		}
	}
	if route.Code == "" {
		route.Code = code
	}

	ttAgency := info.ID
	queryCode := route.Code
	schedProf := prof
	if ttAgency == movAgencyID || ttAgency == sagalesAgencyID {
		if gbCode, gbProf, found := findGencatBusScheduleMatch(route.Code, prof); found {
			ttAgency = gencatBusAgencyID
			queryCode = gbCode
			schedProf = gbProf
		} else {
			return nil
		}
	}
	tt, err := sharedRailTT.get(ttAgency)
	if err != nil || tt == nil {
		return nil
	}

	wed := nextWeekdayDate(now, time.Wednesday)
	sat := nextWeekdayDate(now, time.Saturday)
	sun := nextWeekdayDate(now, time.Sunday)

	calExpired := false
	dirs := make([]any, 0, len(schedProf.Directions))
	for _, d := range schedProf.Directions {
		if len(d.Stops) == 0 {
			continue
		}
		targetStop := d.Stops[0]
		explicitStop := false
		if reqStopID != "" {
			for _, st := range d.Stops {
				if st.ID == reqStopID {
					targetStop = st
					explicitStop = true
					break
				}
			}
		}
		stopsList := make([]any, 0, len(d.Stops))
		for _, st := range d.Stops {
			stopsList = append(stopsList, O("id", st.ID, "name", st.Name))
		}
		dirParam := d.DirectionID
		wkSecs, exp1, _ := tt.dayScheduleSecs(ctx, queryCode, targetStop.ID, dirParam, wed)
		// If no stop was explicitly picked and the longest-trip first stop is a
		// rare branch extension (0 or very few weekday trips), try the midpoint stop.
		if !explicitStop && len(wkSecs) < 3 && len(d.Stops) >= 4 {
			midStop := d.Stops[len(d.Stops)/2]
			if midSecs, midExp, merr := tt.dayScheduleSecs(ctx, queryCode, midStop.ID, dirParam, wed); merr == nil && len(midSecs) > len(wkSecs) {
				targetStop = midStop
				wkSecs = midSecs
				exp1 = midExp
			}
		}
		satSecs, exp2, _ := tt.dayScheduleSecs(ctx, queryCode, targetStop.ID, dirParam, sat)
		sunSecs, exp3, _ := tt.dayScheduleSecs(ctx, queryCode, targetStop.ID, dirParam, sun)
		if exp1 || exp2 || exp3 {
			calExpired = true
		}
		dirName := d.Headsign
		if dirName == "" && len(d.Stops) > 0 {
			dirName = d.Stops[len(d.Stops)-1].Name
		}
		dirs = append(dirs, O(
			"direction", strconv.Itoa(d.DirectionID),
			"name", dirName,
			"selectedStop", O("id", targetStop.ID, "name", targetStop.Name),
			"stops", stopsList,
			"days", O(
				"weekday", formatScheduleDayObj(wkSecs),
				"saturday", formatScheduleDayObj(satSecs),
				"sunday", formatScheduleDayObj(sunSecs),
			),
		))
	}
	return O(
		"lineId", info.ID+":"+route.Code,
		"code", route.Code,
		"name", route.Name,
		"agency", info.Name,
		"source", "gtfs_timetable",
		"todayDayType", todayScheduleDayType(now),
		"calendarExpired", calExpired,
		"directions", dirs,
	)
}

func (s *Server) hLineSchedule(q *xreq, res *xres) error {
	lineID := jsTrim(jsString(q.params.Get("lineId")))
	stopID := jsTrim(jsString(qv(q, "stopId")))
	if lineID == "" {
		res.status = 400
		res.json(O("success", false, "error", "Missing lineId"))
		return nil
	}
	now := time.Now()
	cacheKey := lineID + "\x00" + stopID + "\x00" + now.In(madrid).Format("2006-01-02")
	lineScheduleCache.mu.Lock()
	if e, hit := lineScheduleCache.entries[cacheKey]; hit && now.Sub(e.at) <= lineScheduleCacheTTL {
		data := e.data
		lineScheduleCache.mu.Unlock()
		res.h.Set("Cache-Control", "public, max-age=120")
		res.json(O("success", true, "data", data))
		return nil
	}
	lineScheduleCache.mu.Unlock()

	var data *Obj
	if info, op, code, ok := railLineRef(lineID); ok {
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		data = buildRailLineSchedule(ctx, info, op, code, stopID, now)
		cancel()
	} else {
		data = s.buildMataroLineSchedule(lineID, stopID, now)
	}

	if data == nil {
		res.status = 404
		res.json(O("success", false, "error", "Schedule not available for this line"))
		return nil
	}

	lineScheduleCache.mu.Lock()
	if len(lineScheduleCache.entries) >= lineScheduleCacheMax {
		for k, v := range lineScheduleCache.entries {
			if now.Sub(v.at) > lineScheduleCacheTTL {
				delete(lineScheduleCache.entries, k)
			}
		}
		if len(lineScheduleCache.entries) >= lineScheduleCacheMax {
			lineScheduleCache.entries = map[string]lineScheduleCacheEntry{}
		}
	}
	lineScheduleCache.entries[cacheKey] = lineScheduleCacheEntry{at: now, data: data}
	lineScheduleCache.mu.Unlock()

	res.h.Set("Cache-Control", "public, max-age=120")
	res.json(O("success", true, "data", data))
	return nil
}

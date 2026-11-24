package main

// /api/analytics/operators/line?agency=<id>&line=<code>&hours=24|168: one
// Rodalies or FGC line's punctuality per station and per hour, for the
// Dades drill-down (GUI scalability phase 4). The figures come from the
// worker (op getOperatorLineReport); the stations are put in line order
// here from the line's timetable profile, which the server already holds.

import (
	"regexp"
	"sort"
	"strings"
)

var reRailLineCode = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 _-]{0,15}$`)

// orderStationsAlongLine sorts the report's stations by their position on
// the line's first direction (then the second); stations the profile does
// not list (short workings, renamed stations) follow, worst first.
func orderStationsAlongLine(stations []any, prof *rtLineProfile) {
	pos := map[string]int{}
	if prof != nil {
		n := 0
		for _, d := range prof.Directions {
			for _, s := range d.Stops {
				key := strings.ToLower(s.Name)
				if _, seen := pos[key]; !seen {
					pos[key] = n
					n++
				}
			}
		}
	}
	rank := func(o *Obj) (int, float64) {
		if p, ok := pos[strings.ToLower(jsString(o.Get("station")))]; ok {
			return p, 0
		}
		return len(pos), -jsNumber(o.Get("avgDelay"))
	}
	sort.SliceStable(stations, func(i, j int) bool {
		pi, di := rank(stations[i].(*Obj))
		pj, dj := rank(stations[j].(*Obj))
		if pi != pj {
			return pi < pj
		}
		return di < dj
	})
	for _, s := range stations {
		o := s.(*Obj)
		_, onLine := pos[strings.ToLower(jsString(o.Get("station")))]
		o.Set("onProfile", onLine)
	}
}

func (s *Server) hOperatorLine(q *xreq, res *xres) error {
	agency := jsTrim(jsString(or(qv(q, "agency"), "")))
	line := jsTrim(jsString(or(qv(q, "line"), "")))
	var info *operatorInfo
	for i := range reportOperators {
		if reportOperators[i].ID == agency {
			info = &reportOperators[i]
		}
	}
	if info == nil || !reRailLineCode.MatchString(line) {
		res.status = 400
		res.json(O("success", false, "error", "Unknown operator or line"))
		return nil
	}
	// With the operator's catalog loaded, only its lines are answered (and
	// cached): the cache must not grow with whatever codes a client sends.
	// Without it (polling off) the stored history can still be read, uncached.
	var prof *rtLineProfile
	known := false
	if v, ok := rtCatalog.Load(agency); ok {
		c := v.(*rtCatalogOp)
		for _, r := range c.Lines {
			if r.Code == line {
				known = true
			}
		}
		if !known {
			res.status = 404
			res.json(O("success", false, "error", "Unknown line"))
			return nil
		}
		if c.Profiles != nil {
			prof = c.Profiles[line]
		}
	}
	hours := clampHours(qv(q, "hours"), 24, 168)
	key := "line:" + agency + ":" + line + ":" + numToString(hours)
	now := float64(nowMs())
	if data, ok := cacheGetFresh(s.operatorCache, key, now); known && ok {
		res.h.Set("X-Cache", "HIT")
		res.json(spreadAny(O("success", true), data))
		return nil
	}
	data, err := s.singleflightQuery("opline:"+key, "getOperatorLineReport", O("agencyId", agency, "line", line, "hours", hours), 15000)
	if err != nil {
		s.sendInternalError(q, res, err, O("success", false))
		return nil
	}
	if stations, ok := field(data, "stations").([]any); ok {
		orderStationsAlongLine(stations, prof)
	}
	if o, ok := data.(*Obj); ok {
		o.Set("name", info.Name)
		o.Set("shortName", info.ShortName)
		order := "worst_first"
		if prof != nil {
			order = "line"
		}
		o.Set("stationOrder", order)
	}
	if known {
		s.storeOperatorCache(key, data, now)
	}
	res.h.Set("X-Cache", "MISS")
	res.json(spreadAny(O("success", true), data))
	return nil
}

// hOperatorHistory serves /api/analytics/operators/history?agency=<id>
// [&line=<code>][&days=30]: punctuality per day from the train history kept
// beyond the raw retention (railhistory.go). days is 7, 30, 90 or 365 (anything else is 30).
// Cached 60 s per operator, line and days, for known lines only.
func (s *Server) hOperatorHistory(q *xreq, res *xres) error {
	agency := jsTrim(jsString(or(qv(q, "agency"), "")))
	line := jsTrim(jsString(or(qv(q, "line"), "")))
	var info *operatorInfo
	for i := range reportOperators {
		if reportOperators[i].ID == agency {
			info = &reportOperators[i]
		}
	}
	if info == nil || (line != "" && !reRailLineCode.MatchString(line)) {
		res.status = 400
		res.json(O("success", false, "error", "Unknown operator or line"))
		return nil
	}
	known := line == ""
	if v, ok := rtCatalog.Load(agency); ok && line != "" {
		for _, r := range v.(*rtCatalogOp).Lines {
			if r.Code == line {
				known = true
			}
		}
		if !known {
			res.status = 404
			res.json(O("success", false, "error", "Unknown line"))
			return nil
		}
	}
	days := 30.0
	switch v := parseIntOr(qv(q, "days"), 30); v {
	case 7, 30, 90, 365:
		days = v
	}
	key := "history:" + agency + ":" + line + ":" + numToString(days)
	now := float64(nowMs())
	if data, ok := cacheGetFresh(s.operatorCache, key, now); known && ok {
		res.h.Set("X-Cache", "HIT")
		res.json(spreadAny(O("success", true), data))
		return nil
	}
	data, err := s.singleflightQuery("ophist:"+key, "getRailHistory", O("agencyId", agency, "line", line, "days", days), 15000)
	if err != nil {
		s.sendInternalError(q, res, err, O("success", false))
		return nil
	}
	if o, ok := data.(*Obj); ok {
		o.Set("name", info.Name)
		o.Set("shortName", info.ShortName)
	}
	if known {
		s.storeOperatorCache(key, data, now)
	}
	res.h.Set("X-Cache", "MISS")
	res.json(spreadAny(O("success", true), data))
	return nil
}

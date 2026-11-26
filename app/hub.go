package main

// Unified Interchange Hub API: GET /api/hub/connections?lat=...&lon=...&radius=180&excludeLineId=...
// Finds every connecting line/operator physically co-located within radius metres
// of a stop (across Mataró Bus + all Catalonia GTFS/live operators) using the
// O(1) spatial grid in railstations.go.

import (
	"math"
	"sort"
	"strings"
)

func (s *Server) hHubConnections(q *xreq, res *xres) error {
	lat := parseFloatJS(qv(q, "lat"))
	lon := parseFloatJS(qv(q, "lon"))
	if !isFinite(lat) || !isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180 {
		res.status = 400
		res.json(O("success", false, "error", "Invalid lat/lon"))
		return nil
	}
	radius := 180.0
	if v := parseFloatJS(qv(q, "radius")); isFinite(v) && v >= 50 {
		radius = math.Min(400, v)
	}
	excludeLine := strings.ToLower(strings.TrimSpace(jsString(qv(q, "excludeLineId"))))

	type hubConn struct {
		lineID   string
		code     string
		name     string
		color    string
		textCol  string
		mode     string
		agency   string
		agencyID string
		stopID   string
		stopName string
		distM    float64
	}
	byLine := map[string]*hubConn{}
	add := func(c hubConn) {
		if c.lineID == "" || strings.ToLower(c.lineID) == excludeLine {
			return
		}
		key := strings.ToLower(c.lineID)
		if prev := byLine[key]; prev == nil || c.distM < prev.distM {
			cp := c
			byLine[key] = &cp
		}
	}

	// 1. Mataró Bus stops within radius.
	if s != nil && s.w != nil && s.w.tracker != nil && s.w.tracker.allStopsMap != nil {
		lineMeta := map[string]*Obj{}
		if s.registry != nil {
			for _, raw := range s.registry.getAllLines() {
				if l, ok := raw.(*Obj); ok && l != nil {
					lineMeta[jsLower(jsString(l.Get("id")))] = l
				}
			}
		}
		for _, k := range s.w.tracker.allStopsMap.Keys() {
			sv, _ := s.w.tracker.allStopsMap.Get(k)
			st, _ := sv.(*Obj)
			if st == nil {
				continue
			}
			sLat, sLon := st.Num("lat"), st.Num("lon")
			if sLat == 0 && sLon == 0 {
				continue
			}
			d := distM(lat, lon, sLat, sLon)
			if d > radius {
				continue
			}
			sid := jsString(or(st.Get("id"), st.Get("code")))
			sname := jsString(st.Get("name"))
			linesArr, _ := st.Get("lineas").([]any)
			for _, lr := range linesArr {
				lo := asObj(lr)
				lid := jsString(lo.Get("id"))
				if lid == "" {
					continue
				}
				code := "L" + lid
				name := jsString(lo.Get("name"))
				col := jsString(lo.Get("color"))
				txt := ""
				if lm := lineMeta[jsLower(lid)]; lm != nil {
					if c := jsString(lm.Get("code")); c != "" {
						code = c
					}
					if n := jsString(lm.Get("name")); n != "" {
						name = n
					}
					if c := jsString(lm.Get("color")); c != "" {
						col = c
					}
					txt = jsString(lm.Get("textColor"))
				}
				add(hubConn{
					lineID:   lid,
					code:     code,
					name:     name,
					color:    col,
					textCol:  txt,
					mode:     "bus",
					agency:   "Mataró Bus",
					agencyID: "mataro",
					stopID:   sid,
					stopName: sname,
					distM:    jsRound(d),
				})
			}
		}
	}

	// 2. All Catalonia operators via O(1) spatial grid.
	for _, stObj := range nearbyCatalogStops(lat, lon, radius, 24) {
		agID := stObj.Str("agencyId")
		ag := stObj.Str("agency")
		sName := stObj.Str("name")
		dist := stObj.Num("distanceMeters")
		defaultStopID := stObj.Str("id")
		linesArr, _ := stObj.Get("lines").([]any)
		for _, raw := range linesArr {
			l, _ := raw.(*Obj)
			if l == nil {
				continue
			}
			stopID := l.Str("stopId")
			if stopID == "" {
				stopID = defaultStopID
			}
			add(hubConn{
				lineID:   l.Str("id"),
				code:     l.Str("code"),
				name:     l.Str("name"),
				color:    l.Str("color"),
				textCol:  l.Str("textColor"),
				mode:     l.Str("mode"),
				agency:   ag,
				agencyID: agID,
				stopID:   stopID,
				stopName: sName,
				distM:    dist,
			})
		}
	}

	list := make([]*hubConn, 0, len(byLine))
	for _, c := range byLine {
		list = append(list, c)
	}
	sort.SliceStable(list, func(i, j int) bool {
		mi, mj := modeSearchRank(list[i].mode), modeSearchRank(list[j].mode)
		if mi != mj {
			return mi < mj
		}
		if list[i].distM != list[j].distM {
			return list[i].distM < list[j].distM
		}
		return list[i].code < list[j].code
	})
	if len(list) > 16 {
		list = list[:16]
	}

	out := make([]any, 0, len(list))
	for _, c := range list {
		out = append(out, O(
			"lineId", c.lineID,
			"code", c.code,
			"name", strOrNil(c.name),
			"color", strOrNil(c.color),
			"textColor", strOrNil(c.textCol),
			"mode", c.mode,
			"agency", c.agency,
			"agencyId", c.agencyID,
			"stopId", c.stopID,
			"stopName", c.stopName,
			"distanceMeters", c.distM,
		))
	}
	res.h.Set("Cache-Control", "public, max-age=60")
	res.json(O("success", true, "radiusMeters", radius, "count", float64(len(out)), "connections", out))
	return nil
}

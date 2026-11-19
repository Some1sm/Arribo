package main

// Port of src/core/TrackerRegistry.js. Only the Mataró provider exists, so
// the registry wraps one world's tracker.

import (
	"errors"
	"regexp"
	"sort"
	"strings"
)

type TrackerRegistry struct {
	t             *MataroTracker
	cachedLines   []any
	hasCache      bool
	lastCacheTime float64
	cacheTtlMs    float64
	isInitialized bool
}

func newTrackerRegistry(t *MataroTracker) *TrackerRegistry {
	return &TrackerRegistry{t: t, cacheTtlMs: 60000}
}

type lineResolution struct {
	Type       string
	AgencyID   string
	Tracker    *MataroTracker
	LineID     string
	CleanCode  string
	Agency     string
	IsTrain    bool
	Color      any
	LineConfig *Obj
}

var (
	reRegLinePrefix   = regexp.MustCompile(`^(line-|linia-)`)
	reRegMataroPrefix = regexp.MustCompile(`^mataro_?`)
	reRegL18          = regexp.MustCompile(`^l[1-8]$`)
	reRegNonAlnum     = regexp.MustCompile(`[^a-z0-9]`)
	reRegSearchStrip  = jsRe(`[-_\s\.]`)
	reRegWS           = jsRe(`\s+`)
)

func (r *TrackerRegistry) getTrackerForLine(lineID any) (*lineResolution, error) {
	raw := jsTrim(jsString(or(lineID, "")))
	clean := reRegLinePrefix.ReplaceAllLiteralString(jsLower(raw), "")
	agency, id, ok := agencyForLine(clean)
	if !ok {
		return nil, errors.New("No transit tracker registered for line '" + jsString(lineID) + "'.")
	}
	// Only Mataró is registered, and it has the one tracker r.t.
	cfg := r.t.resolveLineConfig(id)
	var color any = agency.DefaultColor
	if cfg != nil && truthy(cfg.Get("color")) {
		color = cfg.Get("color")
	}
	return &lineResolution{
		Type: agency.ID, AgencyID: agency.ID, Tracker: r.t, LineID: id, CleanCode: "L" + id,
		Agency: agency.Name, IsTrain: agency.Mode == "rail", Color: color, LineConfig: cfg,
	}, nil
}

var prominentCodes = map[string]bool{"c10": true, "e111": true, "e112": true, "n80": true, "n81": true, "n82": true, "n83": true, "603": true}

func (r *TrackerRegistry) getAllLines() []any {
	now := float64(nowMs())
	if r.hasCache && now-r.lastCacheTime < r.cacheTtlMs {
		return r.cachedLines
	}
	seenIDs := map[string]bool{}
	seenRoutes := map[string]bool{}
	seenProminent := map[string]bool{}
	all := []any{}
	for _, x := range r.t.getLines() {
		l, _ := x.(*Obj)
		if l == nil || !truthy(l.Get("id")) {
			continue
		}
		cleanID := jsLower(jsString(l.Get("id")))
		routeID := ""
		if truthy(l.Get("routeId")) {
			routeID = jsUpper(jsString(l.Get("routeId")))
		}
		normCode := reRegNonAlnum.ReplaceAllLiteralString(jsLower(jsString(or(l.Get("code"), ""))), "")
		if seenIDs[cleanID] {
			continue
		}
		if routeID != "" && seenRoutes[routeID] {
			continue
		}
		if prominentCodes[normCode] && seenProminent[normCode] {
			continue
		}
		seenIDs[cleanID] = true
		if routeID != "" {
			seenRoutes[routeID] = true
		}
		if prominentCodes[normCode] {
			seenProminent[normCode] = true
		}
		all = append(all, l)
	}
	r.cachedLines = all
	r.hasCache = true
	r.lastCacheTime = now
	return all
}

func (r *TrackerRegistry) searchStopsAndLines(query any, limit int) []any {
	q := jsLower(jsTrim(jsString(or(query, ""))))
	if q == "" {
		return []any{}
	}
	normQ := reRegSearchStrip.ReplaceAllLiteralString(q, "")
	results := []any{}

	allLines := r.getAllLines()
	var matching []*Obj
	for _, x := range allLines {
		l := x.(*Obj)
		code := jsLower(jsString(or(l.Get("code"), "")))
		name := jsLower(jsString(or(l.Get("name"), "")))
		id := jsLower(jsString(or(l.Get("id"), "")))
		normCode := reRegSearchStrip.ReplaceAllLiteralString(code, "")
		normID := reRegSearchStrip.ReplaceAllLiteralString(id, "")
		var ok bool
		if utf16Count(q) == 1 {
			ok = code == q || normCode == normQ || strings.HasPrefix(code, q) || strings.HasPrefix(normCode, normQ)
		} else {
			ok = strings.Contains(code, q) || strings.Contains(normCode, normQ) || strings.Contains(id, q) ||
				strings.Contains(normID, normQ) || strings.Contains(name, q)
		}
		if ok {
			matching = append(matching, l)
		}
	}
	exact := func(l *Obj) bool {
		c := jsLower(jsString(or(l.Get("code"), "")))
		return c == q || reRegSearchStrip.ReplaceAllLiteralString(c, "") == normQ
	}
	sort.SliceStable(matching, func(i, j int) bool { return exact(matching[i]) && !exact(matching[j]) })
	for i, l := range matching {
		if i >= 8 {
			break
		}
		agency := or(l.Get("agency"), "Mataró Bus")
		results = append(results, O(
			"type", "line",
			"isLine", true,
			"lineId", l.Get("id"),
			"lineCode", l.Get("code"),
			"lineName", l.Get("name"),
			"lineColor", or(l.Get("color"), "#009485"),
			"agency", agency,
			"zone", "🚌 Línia • "+jsString(agency),
			"isTrain", false,
		))
	}

	lineMap := map[string]*Obj{}
	for _, x := range allLines {
		l := x.(*Obj)
		lineMap[jsLower(jsString(l.Get("id")))] = l
		lineMap[jsLower(jsString(l.Get("code")))] = l
	}
	for _, k := range r.t.allStopsMap.Keys() {
		sv, _ := r.t.allStopsMap.Get(k)
		s, _ := sv.(*Obj)
		if len(results) >= limit || s == nil {
			continue
		}
		sName := jsLower(jsString(or(s.Get("name"), "")))
		sCode := jsLower(jsString(or(s.Get("code"), or(s.Get("id"), ""))))
		matchesStop := strings.Contains(sName, q) || strings.Contains(sCode, q)
		linesForStop, isArr := s.Get("lineas").([]any)
		if !isArr || len(linesForStop) == 0 {
			linesForStop = []any{O("id", "1", "name", "Circular", "color", "#ff00ff")}
		}
		for _, lr := range linesForStop {
			if len(results) >= limit {
				break
			}
			lineRef := asObj(lr)
			lID := jsString(or(lineRef.Get("id"), ""))
			lCode := "L" + lID
			catalog := lineMap[jsLower(lID)]
			if catalog == nil {
				catalog = lineMap[jsLower(lCode)]
			}
			var lColor any = Undefined
			if catalog != nil {
				lColor = catalog.Get("color")
			}
			lColor = or(lColor, or(lineRef.Get("color"), "#009485"))

			matched := matchesStop
			if !matched {
				tokens := reRegWS.Split(q, -1)
				if len(tokens) > 1 {
					isLineTok := func(t string) bool {
						return t == lID || t == jsLower(lCode) || t == "l"+lID || t == "línia"+lID || t == "linia"+lID
					}
					has := false
					var others []string
					for _, t := range tokens {
						if isLineTok(t) {
							has = true
						} else {
							others = append(others, t)
						}
					}
					other := strings.Join(others, " ")
					if has && (strings.Contains(sName, other) || strings.Contains(sCode, other)) {
						matched = true
					}
				}
			}
			if matched {
				results = append(results, O(
					"type", "stop",
					"lineId", lID,
					"lineCode", lCode,
					"lineName", s.Get("name"),
					"lineColor", lColor,
					"stopId", jsString(s.Get("id")),
					"stopName", s.Get("name"),
					"code", jsString(s.Get("id")),
					"zone", "Mataró Urbà",
					"directionText", or(s.Get("directionText"), ""),
					"destinations", or(s.Get("destinations"), []any{}),
					"isTrain", false,
					"lat", s.Get("lat"),
					"lon", s.Get("lon"),
					"lineas", or(s.Get("lineas"), []any{}),
				))
			}
		}
	}
	if len(results) > limit {
		results = results[:limit]
	}
	return results
}

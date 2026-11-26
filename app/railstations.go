package main

// Train stations in the stop search. /api/search/stops only knew Mataró's
// bus stops, so a station such as Barcelona-Sants or Gràcia could not be
// found by name. This searches the stations of the train lines the line
// view can open (the line profiles in rtCatalog, built when a timetable
// opens): no database access and no World lock, like /api/lines.

import (
	"math"
	"sort"
	"strings"
	"sync"
	"unicode"
)

type indexedCatalogLine struct {
	info         operatorInfo
	r            rtRoute
	mode         string
	fCode        string
	fCodeCompact string
	fName        string
	fAgency      string
	fShort       string
	idx          int
}

type indexedCatalogStop struct {
	agency operatorInfo
	mode   string
	stopID string
	name   string
	fold   string
	fID    string
	lat    float64
	lon    float64
	lines  []rtRoute
	stopBy map[string]string
}

type catalogSearchSnapshot struct {
	key        string
	lines      []indexedCatalogLine
	stops      []*indexedCatalogStop
	stopsByOp  map[string][]*indexedCatalogStop
	spatialMap map[[2]int][]*indexedCatalogStop // 0.01° cells (~1.1 km)
}

var (
	catSearchMu    sync.RWMutex
	catSearchCache *catalogSearchSnapshot
)

func getCatalogSearchSnapshot() *catalogSearchSnapshot {
	ops := lineOperators()
	key, loaded := railRoutesCatalogKey(ops)
	catSearchMu.RLock()
	if catSearchCache != nil && catSearchCache.key == key {
		snap := catSearchCache
		catSearchMu.RUnlock()
		return snap
	}
	catSearchMu.RUnlock()

	snap := buildCatalogSearchSnapshot(key, ops, loaded)
	catSearchMu.Lock()
	catSearchCache = snap
	catSearchMu.Unlock()
	return snap
}

func buildCatalogSearchSnapshot(key string, ops []operatorInfo, loaded []*rtCatalogOp) *catalogSearchSnapshot {
	snap := &catalogSearchSnapshot{
		key:        key,
		stopsByOp:  map[string][]*indexedCatalogStop{},
		spatialMap: map[[2]int][]*indexedCatalogStop{},
	}
	dedicatedBus := map[string][][2]float64{}
	lineIdx := 0
	for i, info := range ops {
		op := loaded[i]
		if op == nil {
			continue
		}
		fAgency := foldStationName(info.Name)
		fShort := foldStationName(info.ShortName)
		byKey := map[string]*indexedCatalogStop{}
		for _, r := range op.Lines {
			lineIdx++
			prof := op.Profiles[r.Code]
			if prof == nil {
				continue
			}
			mode := routeModeFor(info, r.Code)
			if info.ID == gencatBusAgencyID && isGencatBusDuplicate(r.Code, prof, dedicatedBus) {
				continue
			}
			if mode == "bus" && info.ID != gencatBusAgencyID {
				recordDedicatedBus(dedicatedBus, info.ID, r.Code, prof)
			}
			fCode := foldStationName(r.Code)
			snap.lines = append(snap.lines, indexedCatalogLine{
				info:         info,
				r:            r,
				mode:         mode,
				fCode:        fCode,
				fCodeCompact: strings.ReplaceAll(fCode, " ", ""),
				fName:        foldStationName(r.Name),
				fAgency:      fAgency,
				fShort:       fShort,
				idx:          lineIdx,
			})
			for _, d := range prof.Directions {
				for _, st := range d.Stops {
					f := foldStationName(st.Name)
					nameKey := f
					if nameKey == "" {
						nameKey = st.ID
					}
					stopKey := mode + "\x00" + nameKey
					if st.Lat != 0 || st.Lon != 0 {
						cellLat := int(math.Round(st.Lat * 250))
						cellLon := int(math.Round(st.Lon * 250))
						stopKey += "\x00" + itoa(cellLat) + "," + itoa(cellLon)
					}
					h := byKey[stopKey]
					if h == nil {
						h = &indexedCatalogStop{
							agency: info,
							mode:   mode,
							stopID: st.ID,
							name:   st.Name,
							fold:   f,
							fID:    foldStationName(st.ID),
							lat:    st.Lat,
							lon:    st.Lon,
							stopBy: map[string]string{r.Code: st.ID},
						}
						byKey[stopKey] = h
						snap.stops = append(snap.stops, h)
						snap.stopsByOp[info.ID] = append(snap.stopsByOp[info.ID], h)
						if st.Lat != 0 || st.Lon != 0 {
							cell := [2]int{int(math.Floor(st.Lat * 100)), int(math.Floor(st.Lon * 100))}
							snap.spatialMap[cell] = append(snap.spatialMap[cell], h)
						}
					} else if _, exists := h.stopBy[r.Code]; !exists {
						h.stopBy[r.Code] = st.ID
					}
					if n := len(h.lines); n == 0 || h.lines[n-1].Code != r.Code {
						dup := false
						for _, existing := range h.lines {
							if existing.Code == r.Code {
								dup = true
								break
							}
						}
						if !dup {
							h.lines = append(h.lines, r)
						}
					}
				}
			}
		}
	}
	return snap
}

// railStationHit is one station: its name per operator, the lines that
// stop there (catalog order) and the stop id the first of them uses, which
// that line's departures and stop modal accept.
type railStationHit struct {
	agency     operatorInfo
	stopID     string
	name, fold string
	lat, lon   float64
	lines      []rtRoute
}

// searchRailStations returns up to limit rail stations (Rodalies, FGC) whose
// name contains q (case and accents ignored). Used by the rail journey planner.
func searchRailStations(q string, limit int) []any {
	return searchOperatorStops(reportOperators, q, limit)
}

// searchCatalogStops returns up to limit stops across every openable operator
// in rtCatalog (Rodalies, FGC, TMB, TRAM, AMB, Moventis, Sagalés, Girona).
func searchCatalogStops(q string, limit int) []any {
	return searchOperatorStops(lineOperators(), q, limit)
}

// nearbyCatalogStops returns stops across all openable Catalonia operators in
// rtCatalog within radiusM metres of (lat, lon), nearest first.
func nearbyCatalogStops(lat, lon, radiusM float64, limit int) []*Obj {
	if math.IsNaN(lat) || math.IsNaN(lon) || radiusM <= 0 || limit <= 0 {
		return nil
	}
	snap := getCatalogSearchSnapshot()
	dLat := (radiusM / 110574.0) * 1.05
	cosLat := math.Cos(lat * math.Pi / 180)
	if cosLat < 0.1 {
		cosLat = 0.1
	}
	dLon := (radiusM / (111320.0 * cosLat)) * 1.05

	minCLat := int(math.Floor((lat - dLat) * 100))
	maxCLat := int(math.Floor((lat + dLat) * 100))
	minCLon := int(math.Floor((lon - dLon) * 100))
	maxCLon := int(math.Floor((lon + dLon) * 100))

	type nearbyHit struct {
		s    *indexedCatalogStop
		dist float64
	}
	var hits []nearbyHit
	for cLat := minCLat; cLat <= maxCLat; cLat++ {
		for cLon := minCLon; cLon <= maxCLon; cLon++ {
			for _, st := range snap.spatialMap[[2]int{cLat, cLon}] {
				if math.Abs(st.lat-lat) > dLat || math.Abs(st.lon-lon) > dLon {
					continue
				}
				dist := distM(lat, lon, st.lat, st.lon)
				if dist <= radiusM {
					hits = append(hits, nearbyHit{s: st, dist: dist})
				}
			}
		}
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].dist != hits[j].dist {
			return hits[i].dist < hits[j].dist
		}
		return len(hits[i].s.lines) > len(hits[j].s.lines)
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	out := make([]*Obj, 0, len(hits))
	for _, nh := range hits {
		h := nh.s
		first := h.lines[0]
		primaryStopID := h.stopBy[first.Code]
		if primaryStopID == "" {
			primaryStopID = h.stopID
		}
		lines := make([]any, 0, len(h.lines))
		for _, l := range h.lines {
			lines = append(lines, O(
				"id", h.agency.ID+":"+l.Code,
				"code", l.Code,
				"name", l.Name,
				"color", strOrNil(l.Color),
				"textColor", strOrNil(l.TextColor),
				"mode", routeModeFor(h.agency, l.Code),
				"stopId", strOrNil(h.stopBy[l.Code]),
			))
		}
		short := h.agency.ShortName
		if short == "" {
			short = h.agency.Name
		}
		out = append(out, O(
			"id", primaryStopID,
			"code", primaryStopID,
			"name", h.name,
			"lat", h.lat,
			"lon", h.lon,
			"lineId", h.agency.ID+":"+first.Code,
			"agency", short,
			"agencyId", h.agency.ID,
			"mode", h.mode,
			"lines", lines,
			"departures", []any{},
			"distanceMeters", jsRound(nh.dist),
			"walkingMinutes", math.Max(1, jsRound(nh.dist/80)),
		))
	}
	return out
}

func modeSearchRank(mode string) int {
	switch mode {
	case "rail":
		return 0
	case "metro":
		return 1
	case "tram":
		return 2
	default:
		return 3
	}
}

// searchCatalogLines returns up to limit openable lines across all non-Mataró
// operators in rtCatalog matching q by code, route name, or operator name.
func searchCatalogLines(q string, limit int) []any {
	fq := foldStationName(q)
	if fq == "" || limit <= 0 {
		return nil
	}
	fqCompact := strings.ReplaceAll(fq, " ", "")
	snap := getCatalogSearchSnapshot()
	type lineHit struct {
		l    indexedCatalogLine
		rank int
	}
	var hits []lineHit
	for _, l := range snap.lines {
		rank := -1
		switch {
		case l.fCode == fq || (fqCompact != "" && l.fCodeCompact == fqCompact):
			rank = 0
		case strings.HasPrefix(l.fCode, fq) || (fqCompact != "" && strings.HasPrefix(l.fCodeCompact, fqCompact)):
			rank = 1
		case strings.HasPrefix(l.fName, fq) || strings.HasPrefix(l.fAgency, fq) || (l.fShort != "" && strings.HasPrefix(l.fShort, fq)):
			rank = 2
		case strings.Contains(l.fCode, fq) || strings.Contains(l.fName, fq) || strings.Contains(l.fAgency, fq) || (l.fShort != "" && strings.Contains(l.fShort, fq)):
			rank = 3
		}
		if rank >= 0 {
			hits = append(hits, lineHit{l: l, rank: rank})
		}
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].rank != hits[j].rank {
			return hits[i].rank < hits[j].rank
		}
		mi, mj := modeSearchRank(hits[i].l.mode), modeSearchRank(hits[j].l.mode)
		if mi != mj {
			return mi < mj
		}
		if len(hits[i].l.r.Code) != len(hits[j].l.r.Code) {
			return len(hits[i].l.r.Code) < len(hits[j].l.r.Code)
		}
		return hits[i].l.idx < hits[j].l.idx
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	out := make([]any, 0, len(hits))
	for _, h := range hits {
		var color any
		if h.l.r.Color != "" {
			color = h.l.r.Color
		}
		short := h.l.info.ShortName
		if short == "" {
			short = h.l.info.Name
		}
		out = append(out, O(
			"type", "line",
			"isLine", true,
			"lineId", h.l.info.ID+":"+h.l.r.Code,
			"lineCode", h.l.r.Code,
			"lineName", h.l.r.Name,
			"lineColor", color,
			"agency", h.l.info.Name,
			"agencyId", h.l.info.ID,
			"mode", h.l.mode,
			"isTrain", h.l.mode == "rail",
			"zone", short,
		))
	}
	return out
}

func searchOperatorStops(ops []operatorInfo, q string, limit int) []any {
	fq := foldStationName(q)
	if utf16Count(fq) < 2 || limit <= 0 {
		return nil
	}
	snap := getCatalogSearchSnapshot()
	var hits []*indexedCatalogStop
	for _, info := range ops {
		for _, st := range snap.stopsByOp[info.ID] {
			if st.fold == "" || (!strings.Contains(st.fold, fq) && (st.fID == "" || !strings.HasPrefix(st.fID, fq))) {
				continue
			}
			hits = append(hits, st)
		}
	}
	sort.SliceStable(hits, func(i, j int) bool {
		ei, ej := hits[i].fold == fq, hits[j].fold == fq
		if ei != ej {
			return ei
		}
		pi, pj := strings.HasPrefix(hits[i].fold, fq), strings.HasPrefix(hits[j].fold, fq)
		if pi != pj {
			return pi
		}
		mi := modeSearchRank(hits[i].mode)
		mj := modeSearchRank(hits[j].mode)
		if mi != mj {
			return mi < mj
		}
		if len(hits[i].lines) != len(hits[j].lines) {
			return len(hits[i].lines) > len(hits[j].lines)
		}
		return hits[i].fold < hits[j].fold
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	out := make([]any, 0, len(hits))
	for _, h := range hits {
		first := h.lines[0]
		codes := make([]any, len(h.lines))
		names := make([]string, len(h.lines))
		for i, l := range h.lines {
			codes[i], names[i] = l.Code, l.Code
		}
		var color any
		if first.Color != "" {
			color = first.Color
		}
		short := h.agency.ShortName
		if short == "" {
			short = h.agency.Name
		}
		out = append(out, O(
			"type", "stop",
			"lineId", h.agency.ID+":"+first.Code,
			"lineCode", first.Code,
			"lineName", first.Name,
			"lineColor", color,
			"stopId", h.stopID,
			"stopName", h.name,
			"code", h.stopID,
			"zone", short+" · "+strings.Join(names, ", "),
			"directionText", "",
			"destinations", []any{},
			"isTrain", h.mode == "rail",
			"agency", h.agency.Name,
			"agencyId", h.agency.ID,
			"mode", h.mode,
			"lines", codes,
			"lat", h.lat,
			"lon", h.lon,
		))
	}
	return out
}

// foldStationName is a station name for matching: accents and case
// ignored, and any run of punctuation or spaces one space, so "Terrassa
// Rambla" finds FGC's "Terrassa - Rambla" and "Sants" finds "Barcelona-Sants".
func foldStationName(s string) string {
	f := foldAccents(s)
	var b strings.Builder
	space := false
	for _, r := range f {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			if space && b.Len() > 0 {
				b.WriteByte(' ')
			}
			space = false
			b.WriteRune(r)
			continue
		}
		space = true
	}
	return b.String()
}

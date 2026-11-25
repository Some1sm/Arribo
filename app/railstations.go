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
	"unicode"
)

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
	// Quick degree bounding box pre-filter before haversine distance.
	dLat := (radiusM / 110574.0) * 1.05
	cosLat := math.Cos(lat * math.Pi / 180)
	if cosLat < 0.1 {
		cosLat = 0.1
	}
	dLon := (radiusM / (111320.0 * cosLat)) * 1.05

	type nearbyHit struct {
		agency operatorInfo
		stopID string
		name   string
		lat    float64
		lon    float64
		dist   float64
		lines  []rtRoute
		seenL  map[string]bool
	}
	var hits []*nearbyHit
	for _, info := range lineOperators() {
		v, ok := rtCatalog.Load(info.ID)
		if !ok {
			continue
		}
		op := v.(*rtCatalogOp)
		byKey := map[string]*nearbyHit{}
		for _, r := range op.Lines {
			prof := op.Profiles[r.Code]
			if prof == nil {
				continue
			}
			for _, d := range prof.Directions {
				for _, st := range d.Stops {
					if st.Lat == 0 && st.Lon == 0 {
						continue
					}
					if math.Abs(st.Lat-lat) > dLat || math.Abs(st.Lon-lon) > dLon {
						continue
					}
					dist := distM(lat, lon, st.Lat, st.Lon)
					if dist > radiusM {
						continue
					}
					key := foldStationName(st.Name)
					if key == "" {
						key = st.ID
					}
					h := byKey[key]
					if h == nil {
						h = &nearbyHit{
							agency: info,
							stopID: st.ID,
							name:   st.Name,
							lat:    st.Lat,
							lon:    st.Lon,
							dist:   dist,
							seenL:  map[string]bool{},
						}
						byKey[key] = h
						hits = append(hits, h)
					} else if dist < h.dist {
						h.dist = dist
						h.lat = st.Lat
						h.lon = st.Lon
						h.stopID = st.ID
					}
					if !h.seenL[r.Code] {
						h.seenL[r.Code] = true
						h.lines = append(h.lines, r)
					}
				}
			}
		}
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].dist != hits[j].dist {
			return hits[i].dist < hits[j].dist
		}
		return len(hits[i].lines) > len(hits[j].lines)
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	out := make([]*Obj, 0, len(hits))
	for _, h := range hits {
		first := h.lines[0]
		mode := routeModeFor(h.agency, first.Code)
		lines := make([]any, 0, len(h.lines))
		for _, l := range h.lines {
			lines = append(lines, O(
				"id", h.agency.ID+":"+l.Code,
				"code", l.Code,
				"name", l.Name,
				"color", strOrNil(l.Color),
				"textColor", strOrNil(l.TextColor),
				"mode", routeModeFor(h.agency, l.Code),
			))
		}
		short := h.agency.ShortName
		if short == "" {
			short = h.agency.Name
		}
		out = append(out, O(
			"id", h.stopID,
			"code", h.stopID,
			"name", h.name,
			"lat", h.lat,
			"lon", h.lon,
			"lineId", h.agency.ID+":"+first.Code,
			"agency", short,
			"agencyId", h.agency.ID,
			"mode", mode,
			"lines", lines,
			"departures", []any{},
			"distanceMeters", jsRound(h.dist),
			"walkingMinutes", math.Max(1, jsRound(h.dist/80)),
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
	type lineHit struct {
		info operatorInfo
		r    rtRoute
		mode string
		rank int
		idx  int
	}
	var hits []lineHit
	dedicatedBus := map[string][][2]float64{}
	idx := 0
	for _, info := range lineOperators() {
		v, ok := rtCatalog.Load(info.ID)
		if !ok {
			continue
		}
		op := v.(*rtCatalogOp)
		fAgency := foldStationName(info.Name)
		fShort := foldStationName(info.ShortName)
		for _, r := range op.Lines {
			idx++
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
			fCodeCompact := strings.ReplaceAll(fCode, " ", "")
			fName := foldStationName(r.Name)
			rank := -1
			switch {
			case fCode == fq || (fqCompact != "" && fCodeCompact == fqCompact):
				rank = 0
			case strings.HasPrefix(fCode, fq) || (fqCompact != "" && strings.HasPrefix(fCodeCompact, fqCompact)):
				rank = 1
			case strings.HasPrefix(fName, fq) || strings.HasPrefix(fAgency, fq) || (fShort != "" && strings.HasPrefix(fShort, fq)):
				rank = 2
			case strings.Contains(fCode, fq) || strings.Contains(fName, fq) || strings.Contains(fAgency, fq) || (fShort != "" && strings.Contains(fShort, fq)):
				rank = 3
			}
			if rank < 0 {
				continue
			}
			hits = append(hits, lineHit{
				info: info,
				r:    r,
				mode: mode,
				rank: rank,
				idx:  idx,
			})
		}
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].rank != hits[j].rank {
			return hits[i].rank < hits[j].rank
		}
		mi, mj := modeSearchRank(hits[i].mode), modeSearchRank(hits[j].mode)
		if mi != mj {
			return mi < mj
		}
		if len(hits[i].r.Code) != len(hits[j].r.Code) {
			return len(hits[i].r.Code) < len(hits[j].r.Code)
		}
		return hits[i].idx < hits[j].idx
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	out := make([]any, 0, len(hits))
	for _, h := range hits {
		var color any
		if h.r.Color != "" {
			color = h.r.Color
		}
		short := h.info.ShortName
		if short == "" {
			short = h.info.Name
		}
		out = append(out, O(
			"type", "line",
			"isLine", true,
			"lineId", h.info.ID+":"+h.r.Code,
			"lineCode", h.r.Code,
			"lineName", h.r.Name,
			"lineColor", color,
			"agency", h.info.Name,
			"agencyId", h.info.ID,
			"mode", h.mode,
			"isTrain", h.mode == "rail",
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
	var hits []*railStationHit
	for _, info := range ops {
		v, ok := rtCatalog.Load(info.ID)
		if !ok {
			continue
		}
		op := v.(*rtCatalogOp)
		byName := map[string]*railStationHit{}
		for _, r := range op.Lines {
			prof := op.Profiles[r.Code]
			if prof == nil {
				continue
			}
			for _, d := range prof.Directions {
				for _, st := range d.Stops {
					f := foldStationName(st.Name)
					fID := foldStationName(st.ID)
					if f == "" || (!strings.Contains(f, fq) && (fID == "" || !strings.HasPrefix(fID, fq))) {
						continue
					}
					h := byName[f]
					if h == nil {
						h = &railStationHit{agency: info, stopID: st.ID, name: st.Name, fold: f, lat: st.Lat, lon: st.Lon}
						byName[f] = h
						hits = append(hits, h)
					}
					if n := len(h.lines); n == 0 || h.lines[n-1].Code != r.Code {
						h.lines = append(h.lines, r) // lines arrive grouped, so the last one is the only possible repeat
					}
				}
			}
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
		mi := modeSearchRank(routeModeFor(hits[i].agency, hits[i].lines[0].Code))
		mj := modeSearchRank(routeModeFor(hits[j].agency, hits[j].lines[0].Code))
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
		mode := routeModeFor(h.agency, first.Code)
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
			"isTrain", mode == "rail",
			"agency", h.agency.Name,
			"agencyId", h.agency.ID,
			"mode", mode,
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

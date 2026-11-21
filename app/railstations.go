package main

// Train stations in the stop search. /api/search/stops only knew Mataró's
// bus stops, so a station such as Barcelona-Sants or Gràcia could not be
// found by name. This searches the stations of the train lines the line
// view can open (the line profiles in rtCatalog, built when a timetable
// opens): no database access and no World lock, like /api/lines.

import (
	"sort"
	"strings"
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

// searchRailStations returns up to limit stations whose name contains q
// (case and accents ignored), stations whose name starts with it first,
// then those served by more lines, then by name. Each is a stop result in
// the shape the search lists read, opening the station on its first line.
func searchRailStations(q string, limit int) []any {
	fq := foldAccents(q)
	if utf16Count(fq) < 2 || limit <= 0 {
		return nil
	}
	var hits []*railStationHit
	for _, info := range reportOperators {
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
					f := foldAccents(st.Name)
					if f == "" || !strings.Contains(f, fq) {
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
		pi, pj := strings.HasPrefix(hits[i].fold, fq), strings.HasPrefix(hits[j].fold, fq)
		if pi != pj {
			return pi
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
			"isTrain", true,
			"agency", h.agency.Name,
			"agencyId", h.agency.ID,
			"mode", h.agency.Mode,
			"lines", codes,
			"lat", h.lat,
			"lon", h.lon,
		))
	}
	return out
}

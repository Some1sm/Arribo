package main

import "strings"

// Operators Arribo tracks. Phase 1 of the Catalonia plan
// (docs/catalonia-review/REPORT.md): line resolution goes through this list
// instead of hard-coding Mataró, so a second operator (Rodalies, FGC) is a
// new entry rather than a new code path. Today the list holds Mataró only
// and every answer is the same as before.

// Agency is one transit operator.
type Agency struct {
	// ID is stored in the history tables' agency_id column and used as the
	// line resolution's Type.
	ID string
	// Name is the operator label line resolution reports.
	Name string
	// Mode is stored in the history tables' mode column (GTFS-style: bus,
	// rail, metro, tram).
	Mode string
	// DefaultColor is used when a line's own colour is unknown.
	DefaultColor string
	// LineIDs are the operator's line ids, in catalog order. Read-only:
	// callers must not modify the slice.
	LineIDs []string
	// Bounds is the box a vehicle fix must fall in to be accepted.
	Bounds GeoBounds
	// LineInk is the text colour on each line's colour (GTFS route_text_color;
	// for Mataró the design system's on-line-N values). Data, never computed.
	LineInk map[string]string
	// Center and Zoom are the map's starting view when this is the only operator.
	Center [2]float64
	Zoom   float64
	// matchLine takes a lower-cased line id with any "line-" / "linia-"
	// prefix removed and returns the operator's own id for that line, or
	// ok=false when the line is not this operator's.
	matchLine func(clean string) (id string, ok bool)
}

// GeoBounds is a lat/lon box, edges included.
type GeoBounds struct{ MinLat, MaxLat, MinLon, MaxLon float64 }

// contains reports whether a finite fix lies in the box.
func (b GeoBounds) contains(lat, lon float64) bool {
	return isFinite(lat) && isFinite(lon) && lat >= b.MinLat && lat <= b.MaxLat && lon >= b.MinLon && lon <= b.MaxLon
}

// hasLine reports whether id is exactly one of the operator's line ids.
func (a *Agency) hasLine(id string) bool { return containsString(a.LineIDs, id) }

// lineIDsAny is LineIDs as a fresh []any, for JSON values.
func (a *Agency) lineIDsAny() []any {
	out := make([]any, len(a.LineIDs))
	for i, id := range a.LineIDs {
		out[i] = id
	}
	return out
}

var mataroAgency = &Agency{
	ID:           "mataro",
	Name:         "Mataró Bus",
	Mode:         "bus",
	DefaultColor: "#009485",
	LineIDs:      mataroLineIDList,
	Bounds:       GeoBounds{MinLat: 41.45, MaxLat: 41.65, MinLon: 2.30, MaxLon: 2.55},
	Center:       [2]float64{41.54, 2.44},
	Zoom:         13,
	LineInk: map[string]string{
		"1": "#09090b", "2": "#ffffff", "3": "#09090b", "4": "#09090b",
		"5": "#09090b", "6": "#09090b", "7": "#09090b", "8": "#ffffff",
	},
	matchLine: func(clean string) (string, bool) {
		id := reRegMataroPrefix.ReplaceAllLiteralString(clean, "")
		if reRegL18.MatchString(id) {
			id = id[1:]
		}
		if !containsString(mataroLineIDList, id) {
			return "", false
		}
		return id, true
	},
}

// agencies is checked in order; the first operator that claims a line id
// resolves it.
var agencies = []*Agency{mataroAgency}

// agencyForLine finds the operator a cleaned line id belongs to.
func agencyForLine(clean string) (*Agency, string, bool) {
	for _, a := range agencies {
		if id, ok := a.matchLine(clean); ok {
			return a, id, true
		}
	}
	return nil, "", false
}

// mataroLineIDList is Mataró's lines. A separate variable so the matcher
// above can use it without referring to mataroAgency itself (Go rejects a
// package variable whose initializer refers to the variable).
var mataroLineIDList = []string{"1", "2", "3", "4", "5", "6", "7", "8"}

func containsString(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

// catalogOperators describes the registered operators for the line catalog:
// id, name, mode, how many lines and the map area their vehicles cover.
func catalogOperators(lines []any) []any {
	counts := map[string]float64{}
	for _, x := range lines {
		if l, ok := x.(*Obj); ok {
			if a, _, ok := agencyForLine(jsLower(jsString(l.Get("id")))); ok {
				counts[a.ID]++
			}
		}
	}
	out := []any{}
	for _, a := range agencies {
		b := a.Bounds
		out = append(out, O(
			"id", a.ID, "name", a.Name, "shortName", a.Name, "mode", a.Mode, "lineCount", counts[a.ID],
			"bounds", O("minLat", b.MinLat, "maxLat", b.MaxLat, "minLon", b.MinLon, "maxLon", b.MaxLon),
			"center", []any{a.Center[0], a.Center[1]}, "zoom", a.Zoom,
			"trackable", true,
			// Additive: live GPS from the operator's SIRI feed, and the credit.
			"realtime", "gps", "attribution", mataroAttribution,
		))
	}
	return out
}

// catalogLine is a catalog line with its operator id and text colour added.
func catalogLine(l *Obj) *Obj {
	out := spreadAny(O(), l)
	a, id, ok := agencyForLine(jsLower(jsString(l.Get("id"))))
	if !ok {
		return out
	}
	out.Set("agencyId", a.ID)
	out.Set("trackable", true)
	if ink, ok := a.LineInk[id]; ok {
		out.Set("textColor", ink)
	} else {
		out.Set("textColor", nil)
	}
	return out
}

// railCatalog adds the GTFS-RT operators' lines (Rodalies, FGC: names and
// colours from their imported timetables) to the line catalog, in the order
// of reportOperators. They are not trackable yet (no live line view), so the
// client lists them for colours and Dades but not as lines to follow.
func profileMidpoint(prof *rtLineProfile) (float64, float64, bool) {
	if prof == nil || len(prof.Directions) == 0 {
		return 0, 0, false
	}
	d := prof.Directions[0]
	if len(d.Stops) > 0 {
		st := d.Stops[len(d.Stops)/2]
		if st.Lat != 0 || st.Lon != 0 {
			return st.Lat, st.Lon, true
		}
	}
	if len(d.Geometry) > 0 {
		p := d.Geometry[len(d.Geometry)/2]
		if p[0] != 0 || p[1] != 0 {
			return p[0], p[1], true
		}
	}
	return 0, 0, false
}

// recordDedicatedBus registers a non-gencat_bus bus line's normalized code and
// representative midpoint so overlapping Generalitat interurban copies (e.g.
// gencat_bus:C10 duplicating moventis:C-10) are hidden from the rider catalog
// without shadowing unrelated towns that reuse generic codes like L1.
func recordDedicatedBus(idx map[string][][2]float64, agencyID, code string, prof *rtLineProfile) {
	lat, lon, hasPt := profileMidpoint(prof)
	add := func(c string) {
		norm := ambNormLine(c)
		if norm == "" {
			return
		}
		if hasPt {
			idx[norm] = append(idx[norm], [2]float64{lat, lon})
		} else if _, exists := idx[norm]; !exists {
			idx[norm] = nil
		}
	}
	add(code)
	// For city-prefixed atm_urban codes (e.g. "FIG-L1"), also index the local
	// suffix ("L1") at the exact city midpoint.
	if agencyID == atmUrbanAgencyID {
		if dash := strings.IndexByte(code, '-'); dash > 0 && dash+1 < len(code) {
			add(code[dash+1:])
		}
	}
}

func isGencatBusDuplicate(code string, prof *rtLineProfile, dedicated map[string][][2]float64) bool {
	norm := ambNormLine(code)
	pts, ok := dedicated[norm]
	if !ok {
		return false
	}
	if len(pts) == 0 {
		return true
	}
	lat, lon, hasPt := profileMidpoint(prof)
	if !hasPt {
		return true
	}
	for _, p := range pts {
		if haversineKm(lat, lon, p[0], p[1]) <= 18.0 {
			return true
		}
	}
	return false
}

func railCatalog() (lines []any, ops []any) {
	dedicatedBus := map[string][][2]float64{}
	for _, info := range lineOperators() {
		v, ok := rtCatalog.Load(info.ID)
		if !ok {
			continue
		}
		op := v.(*rtCatalogOp)
		emitted := 0
		for _, r := range op.Lines {
			prof, hasProfile := op.Profiles[r.Code]
			mode := routeModeFor(info, r.Code)
			if info.ID == gencatBusAgencyID && isGencatBusDuplicate(r.Code, prof, dedicatedBus) {
				continue
			}
			if mode == "bus" && info.ID != gencatBusAgencyID {
				recordDedicatedBus(dedicatedBus, info.ID, r.Code, prof)
			}
			var color, ink any = nil, nil
			if r.Color != "" {
				color = r.Color
			}
			if r.TextColor != "" {
				ink = r.TextColor
			}
			// lineRef opens the line view (/api/line/<agency>:<code>);
			// openable says a line profile exists to draw it.
			lines = append(lines, O(
				"id", r.Code, "code", r.Code, "name", r.Name, "color", color, "textColor", ink,
				"agency", info.Name, "agencyId", info.ID, "group", info.ID, "mode", catalogLineModeLabel(info, r.Code),
				"directions", []any{}, "trackable", false,
				"lineRef", info.ID+":"+r.Code, "openable", hasProfile,
			))
			emitted++
		}
		b := cataloniaBounds
		o := O(
			"id", info.ID, "name", info.Name, "shortName", info.ShortName, "mode", op.Mode, "lineCount", float64(emitted),
			"bounds", O("minLat", b.MinLat, "maxLat", b.MaxLat, "minLon", b.MinLon, "maxLon", b.MaxLon),
			"center", nil, "zoom", nil, "trackable", false,
		)
		// Additive, for operators without GPS: what their map shows.
		switch info.ID {
		case movAgencyID:
			o.Set("positions", "estimated") // estimated from stop predictions
		case ambAgencyID, tramTbxAgencyID, tramTbsAgencyID, tmbAgencyID, gironaAgencyID,
			movSarfaAgencyID, movCostaAgencyID, movLleidaAgencyID, movTccAgencyID, movSarbusAgencyID:
			o.Set("positions", "none") // predicted/scheduled departures only
		}
		// Additive: what kind of real-time data the operator has, and its credit.
		o.Set("realtime", catalogRealtime(info))
		o.Set("attribution", railAttribution(info.ID))
		ops = append(ops, o)
	}
	return lines, ops
}

// mataroAttribution is the credit for Mataró Bus data.
const mataroAttribution = "Mataró Bus Urbà (Avanza / Ajuntament de Mataró)"

// catalogRealtime says what an operator's live data is, from its data tier:
// "gps" (its buses' own GPS), "positions" (vehicle positions the operator
// reports: Rodalies, FGC), "estimated" (positions estimated from stop
// predictions: Moventis), "predicted" (predicted times at stops, no positions)
// or "timetable" (no live data).
func catalogRealtime(info operatorInfo) string {
	switch {
	case info.Tier == "timetable":
		return "timetable"
	case info.Method == "gps" || info.Method == "operator_gps":
		return "gps"
	case info.ID == movAgencyID:
		return "estimated"
	case info.Mode == "rail":
		return "positions"
	}
	return "predicted"
}

// catalogModeLabel is the catalog's mode word for an operator's lines.
func catalogModeLabel(info operatorInfo) string {
	return modeWord(info.Mode)
}

func catalogLineModeLabel(info operatorInfo, code string) string {
	return modeWord(routeModeFor(info, code))
}

func modeWord(mode string) string {
	switch mode {
	case "bus":
		return "Bus"
	case "tram":
		return "Tramvia"
	case "metro":
		return "Metro"
	default:
		return "Tren"
	}
}

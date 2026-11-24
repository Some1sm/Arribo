package main

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
func railCatalog() (lines []any, ops []any) {
	for _, info := range lineOperators() {
		v, ok := rtCatalog.Load(info.ID)
		if !ok {
			continue
		}
		op := v.(*rtCatalogOp)
		for _, r := range op.Lines {
			var color, ink any = nil, nil
			if r.Color != "" {
				color = r.Color
			}
			if r.TextColor != "" {
				ink = r.TextColor
			}
			// lineRef opens the line view (/api/line/<agency>:<code>);
			// openable says a line profile exists to draw it.
			_, hasProfile := op.Profiles[r.Code]
			lines = append(lines, O(
				"id", r.Code, "code", r.Code, "name", r.Name, "color", color, "textColor", ink,
				"agency", info.Name, "agencyId", info.ID, "group", info.ID, "mode", catalogModeLabel(info),
				"directions", []any{}, "trackable", false,
				"lineRef", info.ID+":"+r.Code, "openable", hasProfile,
			))
		}
		b := cataloniaBounds
		o := O(
			"id", info.ID, "name", info.Name, "shortName", info.ShortName, "mode", op.Mode, "lineCount", float64(len(op.Lines)),
			"bounds", O("minLat", b.MinLat, "maxLat", b.MaxLat, "minLon", b.MinLon, "maxLon", b.MaxLon),
			"center", nil, "zoom", nil, "trackable", false,
		)
		// Additive, for bus operators without GPS: what their map shows.
		switch info.ID {
		case movAgencyID:
			o.Set("positions", "estimated") // estimated from stop predictions
		case ambAgencyID:
			o.Set("positions", "none") // predicted departures only
		}
		ops = append(ops, o)
	}
	return lines, ops
}

// catalogModeLabel is the catalog's mode word for an operator's lines.
func catalogModeLabel(info operatorInfo) string {
	if info.Mode == "bus" {
		return "Bus"
	}
	return "Tren"
}

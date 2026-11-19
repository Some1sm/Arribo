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
	LineIDs:      []string{"1", "2", "3", "4", "5", "6", "7", "8"},
	Bounds:       GeoBounds{MinLat: 41.45, MaxLat: 41.65, MinLon: 2.30, MaxLon: 2.55},
	matchLine: func(clean string) (string, bool) {
		id := reRegMataroPrefix.ReplaceAllLiteralString(clean, "")
		if reRegL18.MatchString(id) {
			id = id[1:]
		}
		if !reRegDigit18.MatchString(id) {
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

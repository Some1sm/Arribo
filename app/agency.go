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
	// matchLine takes a lower-cased line id with any "line-" / "linia-"
	// prefix removed and returns the operator's own id for that line, or
	// ok=false when the line is not this operator's.
	matchLine func(clean string) (id string, ok bool)
}

var mataroAgency = &Agency{
	ID:           "mataro",
	Name:         "Mataró Bus",
	Mode:         "bus",
	DefaultColor: "#009485",
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

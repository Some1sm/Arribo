package main

// Direction inference for timetables without direction_id. Neither
// Renfe's Cercanías GTFS nor FGC's sends a direction_id column (checked
// 2026-11-21), so every trip and every live train had an unknown direction:
// a line had one "direction" holding both ways, and the line view's
// one-direction mode showed no trains at all. This derives the direction
// from the operator's own stop order and nothing else: per line (route
// short name), its trip with the most stations is the reference; a trip
// that visits two of the reference's stations in the same order is
// direction 0, in the reverse order direction 1. A trip sharing fewer than
// two stations with the reference, or only stations the reference visits
// twice, stays unknown (NULL). Lines whose trips already carry a
// direction_id are left as the operator sent them.

import (
	"database/sql"
	"sort"
)

// gtfsImportFormat is written to gtfs_meta as "import_format". A timetable
// imported by an older format (no direction inference) is re-imported at
// the next refresh check, even when it is not yet stale.
// 3: stops.platform_code (FGC names each platform; Renfe sends none).
const gtfsImportFormat = "3"

// inferDirections fills trips.direction_id for routes where no trip has
// one, and returns how many trips got a direction.
func inferDirections(db *sql.DB) (int, error) {
	lines, err := queryStrings(db, `SELECT `+gtfsLineKeySQL+` FROM trips t JOIN routes r ON r.route_id = t.route_id
	  GROUP BY `+gtfsLineKeySQL+` HAVING COUNT(t.direction_id) = 0`)
	if err != nil {
		return 0, err
	}
	tx, err := db.Begin()
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	upd, err := tx.Prepare(`UPDATE trips SET direction_id = ? WHERE trip_id = ?`)
	if err != nil {
		return 0, err
	}
	defer upd.Close()
	set := 0
	for _, line := range lines {
		seqs, err := tripStopSequences(tx, line)
		if err != nil {
			return 0, err
		}
		dirs := inferRouteDirections(seqs)
		ids := make([]string, 0, len(dirs))
		for id := range dirs {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			if _, err := upd.Exec(dirs[id], id); err != nil {
				return 0, err
			}
			set++
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return set, nil
}

// inferRouteDirections maps trip id -> 0 or 1 for the trips whose direction
// can be told. The reference is the trip with the most stations (on a tie,
// the smallest trip id): direction 0. Directions then spread from oriented
// trips to the trips they share two stations with, until nothing changes,
// so a line whose longest trip covers only one section (Rodalies R3: the
// Puigcerdà end, while most trips run Vic/Granollers - Barcelona) is still
// oriented through the trips that span both. The work is per distinct
// station sequence, in a fixed order, so the result is deterministic.
// Trips left out stay unknown.
func inferRouteDirections(seqs map[string][]string) map[string]int {
	type pattern struct {
		key   string
		stops []string
		trips []string
		dir   int // -1 unknown
	}
	byKey := map[string]*pattern{}
	refTrip := ""
	for id, s := range seqs {
		if refTrip == "" || len(s) > len(seqs[refTrip]) || (len(s) == len(seqs[refTrip]) && id < refTrip) {
			refTrip = id
		}
		k := ""
		for _, st := range s {
			k += st + "\x00"
		}
		p := byKey[k]
		if p == nil {
			p = &pattern{key: k, stops: s, dir: -1}
			byKey[k] = p
		}
		p.trips = append(p.trips, id)
	}
	out := map[string]int{}
	if refTrip == "" {
		return out
	}
	pats := make([]*pattern, 0, len(byKey))
	for _, p := range byKey {
		pats = append(pats, p)
	}
	sort.Slice(pats, func(i, j int) bool {
		if len(pats[i].stops) != len(pats[j].stops) {
			return len(pats[i].stops) > len(pats[j].stops)
		}
		return pats[i].key < pats[j].key
	})
	// Spread from the reference, breadth first: each newly oriented pattern
	// is compared once with the still unknown patterns that share a station
	// with it (in the fixed pattern order), using its station positions.
	byStation := map[string][]int{}
	for i, p := range pats {
		seen := map[string]bool{}
		for _, st := range p.stops {
			if !seen[st] {
				seen[st] = true
				byStation[st] = append(byStation[st], i)
			}
		}
	}
	var queue []int
	for i, p := range pats {
		for _, t := range p.trips {
			if t == refTrip {
				p.dir = 0
				queue = append(queue, i)
			}
		}
	}
	for len(queue) > 0 {
		o := pats[queue[0]]
		queue = queue[1:]
		pos, twice := stationPositions(o.stops)
		var cand []int
		seenCand := map[int]bool{}
		for st := range pos {
			for _, i := range byStation[st] {
				if !seenCand[i] && pats[i].dir < 0 {
					seenCand[i] = true
					cand = append(cand, i)
				}
			}
		}
		sort.Ints(cand)
		for _, i := range cand {
			if same, ok := orderAgainst(pos, twice, pats[i].stops); ok {
				pats[i].dir = o.dir
				if !same {
					pats[i].dir = 1 - o.dir
				}
				queue = append(queue, i)
			}
		}
	}
	for _, p := range pats {
		if p.dir >= 0 {
			for _, t := range p.trips {
				out[t] = p.dir
			}
		}
	}
	return out
}

// sameOrder compares b's station order with a's: at the first two stations
// of b that a visits exactly once (at different places), same is whether b
// meets them in a's order. ok is false when they share no such pair.
func sameOrder(a, b []string) (same, ok bool) {
	pos, twice := stationPositions(a)
	return orderAgainst(pos, twice, b)
}

// stationPositions maps each station of a to its first position, and marks
// the stations a visits more than once.
func stationPositions(a []string) (map[string]int, map[string]bool) {
	pos := map[string]int{}
	twice := map[string]bool{}
	for i, st := range a {
		if _, seen := pos[st]; seen {
			twice[st] = true
			continue
		}
		pos[st] = i
	}
	return pos, twice
}

// orderAgainst is sameOrder with a's positions already built.
func orderAgainst(pos map[string]int, twice map[string]bool, b []string) (same, ok bool) {
	first := -1
	for _, st := range b {
		p, in := pos[st]
		if !in || twice[st] {
			continue
		}
		if first < 0 {
			first = p
			continue
		}
		if p == first {
			continue
		}
		return p > first, true
	}
	return false, false
}

// gtfsLineKeySQL is the line a trip belongs to, as riders and the catalog
// see it: the route short name, else the route id. Renfe splits a line into
// one route per direction (51T0001R1 and 51T0002R1 are both R1), so
// grouping by route id would compare trips that all run the same way.
const gtfsLineKeySQL = "COALESCE(NULLIF(r.short_name, ''), r.route_id)"

// tripStopSequences returns each trip of a line with its stations in
// stop_sequence order. A station is the stop's parent station when it has
// one: FGC gives each direction its own platform (GR1, GR2 under GR), so
// trips running opposite ways share no stop id, only the station.
func tripStopSequences(tx *sql.Tx, line string) (map[string][]string, error) {
	rows, err := tx.Query(`SELECT st.trip_id, COALESCE(NULLIF(s.parent_station, ''), st.stop_id) FROM stop_times st
	  JOIN trips t ON t.trip_id = st.trip_id
	  JOIN routes r ON r.route_id = t.route_id
	  LEFT JOIN stops s ON s.stop_id = st.stop_id
	  WHERE `+gtfsLineKeySQL+` = ? ORDER BY st.trip_id, st.stop_sequence`, line)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]string{}
	for rows.Next() {
		var trip, stop string
		if err := rows.Scan(&trip, &stop); err != nil {
			return nil, err
		}
		out[trip] = append(out[trip], stop)
	}
	return out, rows.Err()
}

func queryStrings(db *sql.DB, q string, args ...any) ([]string, error) {
	rows, err := db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s sql.NullString
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		out = append(out, s.String)
	}
	return out, rows.Err()
}

// gtfsImportCurrent reports whether the timetable at path was written by
// the current import format and matches expectedBBox & expectedRouteFilter.
func gtfsImportCurrent(path, expectedBBox, expectedRouteFilter string) bool {
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		return false
	}
	defer db.Close()
	var v sql.NullString
	if db.QueryRow(`SELECT value FROM gtfs_meta WHERE key = 'import_format'`).Scan(&v) != nil {
		return false
	}
	if v.String != gtfsImportFormat {
		return false
	}
	if expectedBBox != "" {
		var bb sql.NullString
		if db.QueryRow(`SELECT value FROM gtfs_meta WHERE key = 'bbox'`).Scan(&bb) != nil || bb.String != expectedBBox {
			return false
		}
	}
	if expectedRouteFilter != "" {
		var rf sql.NullString
		if db.QueryRow(`SELECT value FROM gtfs_meta WHERE key = 'route_filter'`).Scan(&rf) != nil || rf.String != expectedRouteFilter {
			return false
		}
	}
	return true
}

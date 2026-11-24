package main

// GET /api/network/rail-routes: the path of every train line the line view
// can open, for the landing network map, which until now drew only
// Mataró's bus routes. One response for all lines, from the line profiles
// already in memory (rtCatalog; no database, no World lock). Each line is
// drawn once, from its first direction (both directions share the track),
// simplified to about 25 m, which is invisible at the zooms where the
// whole network is on screen.

import "math"

// railRouteTolerance is the simplification tolerance in degrees of latitude
// (about 25 m).
const railRouteTolerance = 0.00025

func (s *Server) hRailRoutes(q *xreq, res *xres) error {
	lines := []any{}
	for _, info := range lineOperators() {
		v, ok := rtCatalog.Load(info.ID)
		if !ok {
			continue
		}
		op := v.(*rtCatalogOp)
		for _, r := range op.Lines {
			prof := op.Profiles[r.Code]
			if prof == nil || len(prof.Directions) == 0 {
				continue
			}
			d := prof.Directions[0]
			if len(d.Geometry) < 2 {
				continue
			}
			pts := simplifyPath(d.Geometry, railRouteTolerance)
			path := make([]any, len(pts))
			for i, p := range pts {
				path[i] = []any{round5(p[0]), round5(p[1])}
			}
			var color any
			if r.Color != "" {
				color = r.Color
			}
			lines = append(lines, O(
				"lineRef", info.ID+":"+r.Code,
				"agencyId", info.ID,
				"code", r.Code,
				"mode", routeModeFor(info, r.Code),
				"color", color,
				// The path joins the stations when the timetable has no shape.
				"fromStops", d.GeometryFromStops,
				"path", path,
			))
		}
	}
	res.json(O("success", true, "lines", lines))
	return nil
}

func round5(v float64) float64 { return math.Round(v*1e5) / 1e5 }

// simplifyPath is Douglas-Peucker on [lat, lon] points, with distances in
// degrees and longitude scaled by cos(latitude) so the tolerance is the
// same north-south and east-west. The first and last points are kept.
func simplifyPath(pts [][2]float64, tol float64) [][2]float64 {
	if len(pts) < 3 {
		return pts
	}
	k := math.Cos(pts[0][0] * math.Pi / 180)
	keep := make([]bool, len(pts))
	keep[0], keep[len(pts)-1] = true, true
	type span struct{ a, b int }
	stack := []span{{0, len(pts) - 1}}
	for len(stack) > 0 {
		sp := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		ax, ay := pts[sp.a][1]*k, pts[sp.a][0]
		bx, by := pts[sp.b][1]*k, pts[sp.b][0]
		dx, dy := bx-ax, by-ay
		l2 := dx*dx + dy*dy
		far, best := -1.0, -1
		for i := sp.a + 1; i < sp.b; i++ {
			px, py := pts[i][1]*k, pts[i][0]
			var d float64
			if l2 == 0 {
				d = math.Hypot(px-ax, py-ay)
			} else {
				t := math.Max(0, math.Min(1, ((px-ax)*dx+(py-ay)*dy)/l2))
				d = math.Hypot(px-(ax+t*dx), py-(ay+t*dy))
			}
			if d > far {
				far, best = d, i
			}
		}
		if best >= 0 && far > tol {
			keep[best] = true
			stack = append(stack, span{sp.a, best}, span{best, sp.b})
		}
	}
	out := make([][2]float64, 0, len(pts)/4+2)
	for i, p := range pts {
		if keep[i] {
			out = append(out, p)
		}
	}
	return out
}

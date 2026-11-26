package main

// GET /api/network/rail-routes: the path of every train line the line view
// can open, for the landing network map, which until now drew only
// Mataró's bus routes. One response for all lines, from the line profiles
// already in memory (rtCatalog; no database, no World lock). Each line is
// drawn once, from its first direction (both directions share the track),
// simplified to about 25 m, which is invisible at the zooms where the
// whole network is on screen.

import (
	"bytes"
	"compress/gzip"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"
)

// railRouteTolerance is the simplification tolerance in degrees of latitude
// (about 25 m). gencatBusRouteTolerance (~55 m) slims Catalonia-wide
// interurban highway shapes without visible loss on the overview map.
const (
	railRouteTolerance      = 0.00025
	gencatBusRouteTolerance = 0.00050
	railRouteCacheTTL       = 5 * time.Minute
	linesCacheTTL           = 2 * time.Minute
)

type precompressedCache struct {
	mu      sync.RWMutex
	key     string
	at      time.Time
	raw     []byte
	gz      []byte
	etagRaw string
	etagGz  string
}

func weakETagBytes(b []byte) string {
	if len(b) == 0 {
		return ""
	}
	sum := sha1.Sum(b)
	return fmt.Sprintf(`W/"%x-%s"`, len(b), hex.EncodeToString(sum[:8]))
}

func gzipBytes(raw []byte) []byte {
	if len(raw) < 1024 {
		return nil
	}
	var buf bytes.Buffer
	gw, err := gzip.NewWriterLevel(&buf, gzip.DefaultCompression)
	if err != nil {
		return nil
	}
	if _, err := gw.Write(raw); err != nil {
		return nil
	}
	if err := gw.Close(); err != nil {
		return nil
	}
	return buf.Bytes()
}

func gunzipBytes(gz []byte) []byte {
	gr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		return nil
	}
	defer gr.Close()
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(gr); err != nil {
		return nil
	}
	return buf.Bytes()
}

func sendPrecompressedJSON(q *xreq, res *xres, raw, gz []byte, maxAgeSec int) {
	sendPrecompressedJSONWithETag(q, res, raw, gz, "", "", maxAgeSec)
}

func sendPrecompressedJSONWithETag(q *xreq, res *xres, raw, gz []byte, etagRaw, etagGz string, maxAgeSec int) {
	res.h.Set("Cache-Control", fmt.Sprintf("public, max-age=%d", maxAgeSec))
	res.setContentType("application/json; charset=utf-8")
	res.vary("Accept-Encoding")
	if len(gz) > 0 && strings.Contains(strings.ToLower(q.header("Accept-Encoding")), "gzip") {
		if etagGz != "" {
			res.h.Set("ETag", etagGz)
		}
		res.h.Set("Content-Encoding", "gzip")
		res.send(gz)
		return
	}
	if len(raw) == 0 && len(gz) > 0 {
		raw = gunzipBytes(gz)
	}
	if etagRaw != "" {
		res.h.Set("ETag", etagRaw)
	}
	res.send(raw)
}

var (
	railRoutesCache precompressedCache
	linesCache      precompressedCache
)

func railRoutesCatalogKey(ops []operatorInfo) (string, []*rtCatalogOp) {
	var b strings.Builder
	loaded := make([]*rtCatalogOp, len(ops))
	for i, info := range ops {
		v, ok := rtCatalog.Load(info.ID)
		if !ok {
			continue
		}
		op := v.(*rtCatalogOp)
		loaded[i] = op
		fmt.Fprintf(&b, "%s:%p:%d|", info.ID, op, len(op.Lines))
	}
	return b.String(), loaded
}

func buildRailRoutesJSON(ops []operatorInfo, loaded []*rtCatalogOp) []byte {
	lines := []any{}
	dedicatedBus := map[string][][2]float64{}
	for i, info := range ops {
		op := loaded[i]
		if op == nil {
			continue
		}
		tol := railRouteTolerance
		if info.ID == gencatBusAgencyID {
			tol = gencatBusRouteTolerance
		}
		for _, r := range op.Lines {
			mode := routeModeFor(info, r.Code)
			prof := op.Profiles[r.Code]
			if info.ID == gencatBusAgencyID && isGencatBusDuplicate(r.Code, prof, dedicatedBus) {
				continue
			}
			if prof == nil || len(prof.Directions) == 0 {
				continue
			}
			d := prof.Directions[0]
			if len(d.Geometry) < 2 {
				continue
			}
			if mode == "bus" && info.ID != gencatBusAgencyID {
				recordDedicatedBus(dedicatedBus, info.ID, r.Code, prof)
			}
			pts := simplifyPath(d.Geometry, tol)
			path := make([]any, len(pts))
			for j, p := range pts {
				path[j] = []any{round5(p[0]), round5(p[1])}
			}
			var color any
			if r.Color != "" {
				color = r.Color
			}
			lines = append(lines, O(
				"lineRef", info.ID+":"+r.Code,
				"agencyId", info.ID,
				"code", r.Code,
				"mode", mode,
				"color", color,
				// The path joins the stations when the timetable has no shape.
				"fromStops", d.GeometryFromStops,
				"path", path,
			))
		}
	}
	return toJSON(O("success", true, "lines", lines))
}

func (s *Server) hRailRoutes(q *xreq, res *xres) error {
	ops := lineOperators()
	key, loaded := railRoutesCatalogKey(ops)
	now := time.Now()

	railRoutesCache.mu.RLock()
	if (railRoutesCache.gz != nil || railRoutesCache.raw != nil) && railRoutesCache.key == key && now.Sub(railRoutesCache.at) <= railRouteCacheTTL {
		raw, gz, eRaw, eGz := railRoutesCache.raw, railRoutesCache.gz, railRoutesCache.etagRaw, railRoutesCache.etagGz
		railRoutesCache.mu.RUnlock()
		sendPrecompressedJSONWithETag(q, res, raw, gz, eRaw, eGz, 120)
		return nil
	}
	railRoutesCache.mu.RUnlock()

	var raw, gz []byte
	var eRaw, eGz string
	build := func() {
		raw = buildRailRoutesJSON(ops, loaded)
		gz = gzipBytes(raw)
		eRaw = weakETagBytes(raw)
		eGz = weakETagBytes(gz)
	}
	if s != nil && s.w != nil {
		s.w.await(build)
	} else {
		build()
	}
	storedRaw := raw
	if len(gz) > 0 {
		storedRaw = nil // keep only gzipped bytes in RAM; rare non-gzip clients decompress on the fly
	}
	railRoutesCache.mu.Lock()
	railRoutesCache.key = key
	railRoutesCache.at = now
	railRoutesCache.raw = storedRaw
	railRoutesCache.gz = gz
	railRoutesCache.etagRaw = eRaw
	railRoutesCache.etagGz = eGz
	railRoutesCache.mu.Unlock()

	sendPrecompressedJSONWithETag(q, res, raw, gz, eRaw, eGz, 120)
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

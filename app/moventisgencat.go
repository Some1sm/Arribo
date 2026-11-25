package main

// Static data for the Moventis lines from the Generalitat de Catalunya
// interurban bus GTFS (src/data/gencat_casas.json, written by
// scripts/import_gencat_moventis.js):
//
//   - road shapes, used to draw the lines and to place the estimated buses
//     along the road between two stops instead of on a straight line
//     (plan step 2.3; the moventis.es KML stays the fallback);
//   - the published timetable, which says when a line is due at a stop, so
//     the poller does not ask stops where nothing runs (plan step 2.4).
//
// The file is read once and only read afterwards. Its licence (Llicència
// oberta d'ús d'informació - Catalunya) asks for the credit "Generalitat de
// Catalunya" wherever it is used: movAttributionText adds it.

import (
	"encoding/json"
	"log"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

type gcStop struct {
	ID   string  `json:"id"`
	Code string  `json:"code"`
	Name string  `json:"name"`
	Lat  float64 `json:"lat"`
	Lon  float64 `json:"lon"`
}

type gcPattern struct {
	Trips int   `json:"trips"`
	Stops []int `json:"stops"` // indexes into gcDir.Stops
}

type gcTrip struct {
	Service     json.Number `json:"service"`
	Pattern     int         `json:"pattern"`
	Shape       int         `json:"shape"`
	Times       []string    `json:"times"` // "HH:MM:SS", one per pattern stop; hours may pass 23
	Note        string      `json:"note,omitempty"`
	NoteAdded   []string    `json:"noteAdded,omitempty"`
	NoteRemoved []string    `json:"noteRemoved,omitempty"`
}

type gcDir struct {
	DirectionID int            `json:"directionId"`
	Headsign    string         `json:"headsign"`
	Stops       []gcStop       `json:"stops"`
	Patterns    []gcPattern    `json:"patterns"`
	Shapes      [][][2]float64 `json:"shapes"` // [lat, lon]
	Trips       []gcTrip       `json:"trips"`
}

type gcLine struct {
	Code       string  `json:"code"`
	GtfsCode   string  `json:"gtfsCode"`
	Name       string  `json:"name"`
	Directions []gcDir `json:"directions"`
}

type gcService struct {
	Days    [7]int   `json:"days"` // Monday first
	Start   string   `json:"start"`
	End     string   `json:"end"`
	Added   []string `json:"added"`
	Removed []string `json:"removed"`
}

// gcStopTime is one published departure of a line at a stop.
type gcStopTime struct {
	service     string
	sec         int // seconds after the service day's midnight (may pass 24 h)
	noteAdded   map[string]bool
	noteRemoved map[string]bool
}

func (st gcStopTime) runsOn(g *gcData, date string) bool {
	if st.noteRemoved[date] {
		return false
	}
	if st.noteAdded[date] {
		return true
	}
	return g.runs(st.service, date)
}

type gcData struct {
	Feed struct {
		LastModified string `json:"lastModified"`
		Attribution  string `json:"attribution"`
	} `json:"feed"`
	Lines     []gcLine             `json:"lines"`
	Services  map[string]gcService `json:"services"`
	Crosswalk struct {
		LineIds map[string]int `json:"lineIds"`
		Stops   map[string]struct {
			Gtfs string `json:"gtfs"`
		} `json:"stops"`
	} `json:"crosswalk"`

	byMovLine map[int]*gcLine
	added     map[string]map[string]bool // service -> dates
	removed   map[string]map[string]bool

	mu      sync.Mutex
	times   map[[2]int][]gcStopTime // (moventis line, moventis stop) -> departures; nil entry: unknown
	lineSvc map[int]map[string]bool // moventis line -> the services its trips use
}

var (
	gcOnce   sync.Once
	gcLoaded *gcData
)

// gencatData is the loaded file, or nil when it is missing or unreadable
// (then everything falls back to the moventis.es data alone).
func gencatData() *gcData {
	gcOnce.Do(func() {
		path := filepath.Join(appRoot, "src", "data", "gencat_casas.json")
		g, err := readGencat(path)
		if err != nil {
			if !os.IsNotExist(err) {
				log.Printf("[Moventis] Could not load gencat_casas.json: %v", err)
			}
			return
		}
		gcLoaded = g
	})
	return gcLoaded
}

func readGencat(path string) (*gcData, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var g gcData
	if err := json.Unmarshal(b, &g); err != nil {
		return nil, err
	}
	g.index()
	return &g, nil
}

func (g *gcData) index() {
	g.byMovLine = map[int]*gcLine{}
	for i := range g.Lines {
		if id, ok := g.Crosswalk.LineIds[g.Lines[i].Code]; ok {
			g.byMovLine[id] = &g.Lines[i]
		}
	}
	g.added, g.removed = map[string]map[string]bool{}, map[string]map[string]bool{}
	for id, s := range g.Services {
		g.added[id], g.removed[id] = map[string]bool{}, map[string]bool{}
		for _, d := range s.Added {
			g.added[id][d] = true
		}
		for _, d := range s.Removed {
			g.removed[id][d] = true
		}
	}
	g.times = map[[2]int][]gcStopTime{}
	g.lineSvc = map[int]map[string]bool{}
	for id, l := range g.byMovLine {
		svc := map[string]bool{}
		for _, d := range l.Directions {
			for _, t := range d.Trips {
				svc[t.Service.String()] = true
			}
		}
		g.lineSvc[id] = svc
	}
}

// runs says whether service id runs on date (YYYYMMDD).
func (g *gcData) runs(id, date string) bool {
	if g.removed[id][date] {
		return false
	}
	if g.added[id][date] {
		return true
	}
	s, ok := g.Services[id]
	if !ok || date < s.Start || date > s.End {
		return false
	}
	d, err := time.ParseInLocation("20060102", date, madrid)
	if err != nil {
		return false
	}
	return s.Days[(int(d.Weekday())+6)%7] == 1
}

// gcClock is "HH:MM:SS" as seconds (-1 when it does not parse).
func gcClock(s string) int {
	if len(s) < 7 {
		return -1
	}
	h, e1 := strconv.Atoi(s[:len(s)-6])
	m, e2 := strconv.Atoi(s[len(s)-5 : len(s)-3])
	sec, e3 := strconv.Atoi(s[len(s)-2:])
	if e1 != nil || e2 != nil || e3 != nil || m > 59 || sec > 59 {
		return -1
	}
	return h*3600 + m*60 + sec
}

// stopTimes is every published departure of Moventis line lineID at
// Moventis stop stopID; ok is false when the line or the stop is not in the
// file (the timetable then says nothing about it).
func (g *gcData) stopTimes(lineID, stopID int) ([]gcStopTime, bool) {
	key := [2]int{lineID, stopID}
	g.mu.Lock()
	defer g.mu.Unlock()
	if v, hit := g.times[key]; hit {
		return v, v != nil
	}
	var out []gcStopTime
	line := g.byMovLine[lineID]
	gtfs := g.Crosswalk.Stops[strconv.Itoa(stopID)].Gtfs
	if line != nil && gtfs != "" {
		out = []gcStopTime{}
		for _, d := range line.Directions {
			for _, t := range d.Trips {
				if t.Pattern < 0 || t.Pattern >= len(d.Patterns) {
					continue
				}
				pat := d.Patterns[t.Pattern].Stops
				for i, si := range pat {
					if si >= 0 && si < len(d.Stops) && d.Stops[si].ID == gtfs && i < len(t.Times) {
						if sec := gcClock(t.Times[i]); sec >= 0 {
							st := gcStopTime{service: t.Service.String(), sec: sec}
							if len(t.NoteAdded) > 0 {
								st.noteAdded = make(map[string]bool, len(t.NoteAdded))
								for _, dd := range t.NoteAdded {
									st.noteAdded[dd] = true
								}
							}
							if len(t.NoteRemoved) > 0 {
								st.noteRemoved = make(map[string]bool, len(t.NoteRemoved))
								for _, dd := range t.NoteRemoved {
									st.noteRemoved[dd] = true
								}
							}
							out = append(out, st)
						}
					}
				}
			}
		}
		if len(out) == 0 {
			out = nil // the stop is matched but this line does not call there
		}
	}
	g.times[key] = out
	return out, out != nil
}

// lineRuns says whether the timetable has any trip of the line on date.
// The feed has gaps: on 2026-11-23 the C-10's weekday service (184910)
// had dates only from January 2027, so by the file the C-10 ran no weekday
// trip until then. A day without any trip of a line is therefore read as
// "the timetable does not know", never as "the line does not run".
func (g *gcData) lineRuns(lineID int, date string) bool {
	for svc := range g.lineSvc[lineID] {
		if g.runs(svc, date) {
			return true
		}
	}
	return false
}

// nextDeparture is the first published departure of the line at the stop at
// or after now (searching the service days from yesterday to tomorrow, for
// trips past midnight); zero time when none in that span. ok is false when
// the timetable does not know the line at that stop, or has no trip of the
// line at all today (see lineRuns).
func (g *gcData) nextDeparture(lineID, stopID int, now time.Time) (time.Time, bool) {
	sts, ok := g.stopTimes(lineID, stopID)
	if !ok {
		return time.Time{}, false
	}
	var best time.Time
	day := now.In(madrid)
	if !g.lineRuns(lineID, day.Format("20060102")) {
		return time.Time{}, false // no trip of the line at all today: a gap in the feed
	}
	for off := -1; off <= 1; off++ {
		d := day.AddDate(0, 0, off)
		date := d.Format("20060102")
		y, m, dd := d.Date()
		for _, st := range sts {
			if !st.runsOn(g, date) {
				continue
			}
			t := time.UnixMilli(localTimeToUtcDate(y, int(m)-1, dd, 0, 0, 0)).Add(time.Duration(st.sec) * time.Second)
			if t.Before(now) {
				continue
			}
			if best.IsZero() || t.Before(best) {
				best = t
			}
		}
	}
	return best, true
}

// upcomingDepartures returns all published departures of lineID at stopID
// within [now-2m, now+horizon], sorted chronologically.
func (g *gcData) upcomingDepartures(lineID, stopID int, now time.Time, horizon time.Duration) []time.Time {
	sts, ok := g.stopTimes(lineID, stopID)
	if !ok {
		return nil
	}
	day := now.In(madrid)
	if !g.lineRuns(lineID, day.Format("20060102")) {
		return nil
	}
	lo := now.Add(-2 * time.Minute)
	hi := now.Add(horizon)
	var out []time.Time
	for off := -1; off <= 1; off++ {
		d := day.AddDate(0, 0, off)
		date := d.Format("20060102")
		y, m, dd := d.Date()
		base := localTimeToUtcDate(y, int(m)-1, dd, 0, 0, 0)
		for _, st := range sts {
			if !st.runsOn(g, date) {
				continue
			}
			t := time.UnixMilli(base).Add(time.Duration(st.sec) * time.Second)
			if t.Before(lo) || t.After(hi) {
				continue
			}
			out = append(out, t)
		}
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].Before(out[j-1]); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// nearestDeparture finds the published departure of lineID at stopID closest to
// expected within [expected - maxLate, expected + maxEarly] (i.e. delay in
// [-maxEarly, +maxLate]). Returns ok=false when the timetable has no entry for
// this line today or nothing lies in that window.
func (g *gcData) nearestDeparture(lineID, stopID int, expected time.Time, maxEarly, maxLate time.Duration) (time.Time, bool) {
	sts, ok := g.stopTimes(lineID, stopID)
	if !ok {
		return time.Time{}, false
	}
	day := expected.In(madrid)
	if !g.lineRuns(lineID, day.Format("20060102")) {
		return time.Time{}, false
	}
	var best time.Time
	var bestAbs time.Duration
	for off := -1; off <= 1; off++ {
		d := day.AddDate(0, 0, off)
		date := d.Format("20060102")
		y, m, dd := d.Date()
		baseMs := localTimeToUtcDate(y, int(m)-1, dd, 0, 0, 0)
		for _, st := range sts {
			if !st.runsOn(g, date) {
				continue
			}
			sched := time.UnixMilli(baseMs).Add(time.Duration(st.sec) * time.Second)
			delay := expected.Sub(sched)
			if delay < -maxEarly || delay > maxLate {
				continue
			}
			abs := delay
			if abs < 0 {
				abs = -abs
			}
			if best.IsZero() || abs < bestAbs {
				best = sched
				bestAbs = abs
			}
		}
	}
	return best, !best.IsZero()
}

// movDueFunc is the poller's view of the timetable for one stop: when each
// followed line is next due there. nil when the file is not loaded.
func movDueFunc(stopID int, now time.Time) func(lineID int) (time.Time, bool) {
	g := gencatData()
	if g == nil {
		return nil
	}
	return func(lineID int) (time.Time, bool) { return g.nextDeparture(lineID, stopID, now) }
}

// movAttributionText is the credit for Moventis data: the live predictions
// are moventis.es's; shapes and timetables, when used, the Generalitat's.
func movAttributionText() string {
	if g := gencatData(); g != nil {
		return movAttribution + " · Recorreguts i horaris: Generalitat de Catalunya"
	}
	return movAttribution
}

// ---- shapes (plan step 2.3) ----

const (
	gcShapeMaxOffM = 150.0 // a stop further than this from a shape does not lie on it
	gcShapeMinFit  = 0.9   // share of a route's stops that must lie on the shape
	gcShapeSlackM  = 10.0  // an earlier segment wins over the nearest if no more than this further
)

// gcLocalXY projects [lat, lon] to metres around lat0 (flat; fine at a few km).
func gcLocalXY(p [2]float64, lat0 float64) (x, y float64) {
	return p[1] * 111320 * math.Cos(lat0*math.Pi/180), p[0] * 110540
}

// gcFit places a route's stops, in order, along a shape: for each stop the
// distance along the shape (metres) of its projection, never going back,
// and how far off the shape it lies. cum is the shape's cumulative length.
func gcFit(shape [][2]float64, stops []movStop) (along, off, cum []float64) {
	if len(shape) < 2 || len(stops) == 0 {
		return nil, nil, nil
	}
	lat0 := shape[0][0]
	xs, ys := make([]float64, len(shape)), make([]float64, len(shape))
	cum = make([]float64, len(shape))
	for i, p := range shape {
		xs[i], ys[i] = gcLocalXY(p, lat0)
		if i > 0 {
			cum[i] = cum[i-1] + math.Hypot(xs[i]-xs[i-1], ys[i]-ys[i-1])
		}
	}
	along, off = make([]float64, len(stops)), make([]float64, len(stops))
	seg, prevAlong := 0, 0.0
	for k, st := range stops {
		px, py := gcLocalXY([2]float64{st.Lat, st.Lon}, lat0)
		type hit struct {
			seg  int
			a, d float64
		}
		var hits []hit
		best := math.Inf(1)
		for i := seg; i < len(shape)-1; i++ {
			dx, dy := xs[i+1]-xs[i], ys[i+1]-ys[i]
			l2 := dx*dx + dy*dy
			f := 0.0
			if l2 > 0 {
				f = math.Min(math.Max(((px-xs[i])*dx+(py-ys[i])*dy)/l2, 0), 1)
			}
			a := cum[i] + f*math.Sqrt(l2)
			if a < prevAlong {
				a, f = prevAlong, 0
				if l2 > 0 {
					f = math.Min(math.Max((prevAlong-cum[i])/math.Sqrt(l2), 0), 1)
				}
			}
			d := math.Hypot(px-(xs[i]+f*dx), py-(ys[i]+f*dy))
			hits = append(hits, hit{i, a, d})
			best = math.Min(best, d)
		}
		// The earliest segment about as close as the nearest: on a loop or
		// an out-and-back street, the stop belongs to the first pass.
		for _, h := range hits {
			if h.d <= best+gcShapeSlackM {
				seg, prevAlong = h.seg, h.a
				along[k], off[k] = h.a, h.d
				break
			}
		}
	}
	return along, off, cum
}

// gcRouteShape is the Generalitat shape that fits a Moventis route best:
// most stops within gcShapeMaxOffM, in order; nil when no shape of the line
// fits gcShapeMinFit of the stops.
func (g *gcData) routeShape(rt movRoute) (shape [][2]float64, along, cum []float64) {
	line := g.byMovLine[rt.LineID]
	if line == nil || len(rt.Stops) < 2 {
		return nil, nil, nil
	}
	bestFit, bestOff := 0, math.Inf(1)
	for _, d := range line.Directions {
		for _, sh := range d.Shapes {
			a, off, c := gcFit(sh, rt.Stops)
			if a == nil {
				continue
			}
			fit, sum := 0, 0.0
			for _, o := range off {
				if o <= gcShapeMaxOffM {
					fit++
				}
				sum += o
			}
			if fit > bestFit || (fit == bestFit && sum < bestOff) {
				bestFit, bestOff = fit, sum
				shape, along, cum = sh, a, c
			}
		}
	}
	if float64(bestFit) < gcShapeMinFit*float64(len(rt.Stops)) {
		return nil, nil, nil
	}
	return shape, along, cum
}

// gencatEnrich returns s with the Generalitat shapes set on the routes they
// fit (a new movStatic: the published one is never changed); s itself when
// the file is not loaded.
func gencatEnrich(s *movStatic) *movStatic {
	g := gencatData()
	if g == nil || s == nil {
		return s
	}
	out := &movStatic{FetchedAt: s.FetchedAt, Lines: s.Lines, Routes: make(map[int][]movRoute, len(s.Routes))}
	for id, rs := range s.Routes {
		cp := make([]movRoute, len(rs))
		for i, rt := range rs {
			rt.Shape, rt.ShapeAlong, rt.ShapeCum = g.routeShape(rt)
			cp[i] = rt
		}
		out.Routes[id] = cp
	}
	return out
}

// movShapeAt is the point at distance m (metres) along a shape and the
// heading of the segment there.
func movShapeAt(shape [][2]float64, cum []float64, m float64) (lat, lon, bearing float64) {
	n := len(shape)
	i := 1
	for i < n-1 && cum[i] < m {
		i++
	}
	a, b := shape[i-1], shape[i]
	f := 0.0
	if cum[i] > cum[i-1] {
		f = math.Min(math.Max((m-cum[i-1])/(cum[i]-cum[i-1]), 0), 1)
	}
	return a[0] + (b[0]-a[0])*f, a[1] + (b[1]-a[1])*f, movBearing(a, b)
}

// movBearing is the initial heading from a to b ([lat, lon]), in degrees.
func movBearing(a, b [2]float64) float64 {
	y := math.Sin((b[1]-a[1])*math.Pi/180) * math.Cos(b[0]*math.Pi/180)
	x := math.Cos(a[0]*math.Pi/180)*math.Sin(b[0]*math.Pi/180) - math.Sin(a[0]*math.Pi/180)*math.Cos(b[0]*math.Pi/180)*math.Cos((b[1]-a[1])*math.Pi/180)
	return math.Mod(math.Atan2(y, x)*180/math.Pi+360, 360)
}

// movShapeTrim is the part of a route's shape from its first stop to its
// last (a shape can belong to a longer variant of the line).
func movShapeTrim(rt movRoute) [][2]float64 {
	n := len(rt.ShapeAlong)
	if len(rt.Shape) < 2 || n == 0 || len(rt.ShapeCum) != len(rt.Shape) {
		return rt.Shape
	}
	from, to := rt.ShapeAlong[0], rt.ShapeAlong[n-1]
	if to <= from {
		return rt.Shape
	}
	lat, lon, _ := movShapeAt(rt.Shape, rt.ShapeCum, from)
	out := [][2]float64{{lat, lon}}
	for i, p := range rt.Shape {
		if rt.ShapeCum[i] > from && rt.ShapeCum[i] < to {
			out = append(out, p)
		}
	}
	lat, lon, _ = movShapeAt(rt.Shape, rt.ShapeCum, to)
	return append(out, [2]float64{lat, lon})
}

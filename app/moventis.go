package main

// Moventis buses (Empresa Casas, Sarbus, Sarfa... ; moventis.es). Moventis
// publishes no open data, only the arrival predictions its own "Temps
// real" page shows, one stop at a time, from a JSON API the page calls:
//
//   /es/moventis/ca/lines                       every line (id, code, colour)
//   /api/json/GetTrayectos/<line>/<YYYYMMDD>    a line's routes and their stops
//                                               (id, name, coordinates, km)
//   /api/json/GetTiemposParada/ca/<stop>/<line>/0
//                                               the next buses at a stop, for
//                                               every line serving it
//
// This poller asks for those, politely: one request at a time, at least
// movMinGap apart (the site's robots.txt asks for a 10 s crawl delay), and
// when the site answers with its placeholder (every field "A", which is how
// it says "too many requests") it backs off, doubling from movBackoffMin up
// to movBackoffMax. Routes and stops are cached on disk and refreshed once a
// day. Only predictions the site marks as tracked ("real":"S", given to the
// second) are used; timetable-only ones ("real":"N") are ignored.
//
// Bus positions are estimated from those predictions (moventisestimate.go)
// and always say so (isEstimated, positionSource "stop_predictions"): the
// site gives no positions.
//
// Opt-in with ARRIBO_MOVENTIS=1. ARRIBO_MOVENTIS_LINES lists the line ids to
// follow (default: the seven lines through Mataró). The request budget is
// what limits it: a line costs about one request per movStopSpacingKm of
// route, and every request takes movMinGap.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	movBase          = "https://www.moventis.es"
	movUserAgent     = "Mozilla/5.0 (compatible; Arribo transit observatory)"
	movMinGap        = 11 * time.Second // robots.txt: Crawl-delay: 10
	movBackoffMin    = time.Minute
	movBackoffMax    = 10 * time.Minute
	movStopSpacingKm = 1.5              // the closest stops are ever sampled (see movSpacingKm)
	movStaticMaxAge  = 20 * time.Hour   // routes and stops are refetched after this
	movObsMaxAge     = 40 * time.Minute // a stop's predictions are not used after this
	movRetryMissing  = 30 * time.Minute // a followed line without routes is asked again after this
	movAgencyID      = "moventis"
)

// movDefaultLines: the primary seven lines through Mataró (zone Maresme,
// subzone Mataró): e11.1, e11.2, 865, C-10, C-20, C-30, N-80 (Empresa Casas).
var movDefaultLines = []int{47, 48, 51, 53, 57, 59, 68}

// movMaresmeExtraLines: Maresme Casas urban/feeder lines (plan step 6.1):
// C-12 (55), C-15 (56), C-22 (58), C-16 (60), C-14 (64), C-21 (67),
// C-13 (161), C-19 (340), C-18 (385), 862 (627), C-17 (715).
// Enabled with ARRIBO_MOVENTIS_MARESME=1; stops serving only secondary lines
// are polled on every second cycle so the primary Mataró lines stay fast.
var movMaresmeExtraLines = []int{55, 56, 58, 60, 64, 67, 161, 340, 385, 627, 715}

var movHTTP = &http.Client{Timeout: 20 * time.Second}

// A stop's answer holds only the next live bus of each line and direction
// (one real:"S" entry), so a bus is seen from any sampled stop between it
// and the bus ahead. Sampled stops therefore need to be no further apart
// than consecutive buses: about speed x headway. Asking every 1.5 km took
// 89 stops, a 16-minute cycle at one request per movMinGap, for the 7 lines
// through Mataró.
//
// movHeadwayMin is each line's day-average headway in minutes, from the
// Generalitat interurban GTFS (17 service hours / trips per direction,
// November 2026): C-10 78 trips a day, C-20 42, C-30 57, e11.1 268, e11.2
// 170, 865 29, N-80 6, plus Maresme town/feeder lines C-12..C-22 & 862.
// A line not listed uses movDefaultHeadwayMin.
var movHeadwayMin = map[int]float64{
	53: 26, 57: 49, 59: 36, 47: 8, 48: 12, 51: 70, 68: 340,
	55: 45, 56: 40, 58: 35, 60: 45, 64: 30, 67: 60, 161: 30, 340: 30, 385: 30, 627: 45, 715: 40,
}

func movStopIsPrimary(stopLines []int, primary map[int]bool) bool {
	if len(primary) == 0 {
		return true
	}
	for _, id := range stopLines {
		if primary[id] {
			return true
		}
	}
	return false
}

func movStaticMissingLines(s *movStatic, ids []int) bool {
	if s == nil {
		return true
	}
	for _, id := range ids {
		if _, ok := s.Lines[id]; !ok {
			return true
		}
	}
	return false
}

// movSpeedKmh is a line's average commercial speed: the motorway expresses
// (e11.1, e11.2, 865) run faster than the N-II and town lines.
var movSpeedKmh = map[int]float64{47: 40, 48: 40, 51: 40}

const (
	movDefaultHeadwayMin = 15 // movDefaultSpeedKmh is in moventisestimate.go
	// movSpacingFactor keeps the spacing under the day-average gap between
	// buses, since peak headways are shorter than the day's average.
	movSpacingFactor = 0.8
)

// movSpacingKm is the distance between sampled stops on a route of routeKm
// of the line: speed x headway x movSpacingFactor, at least movStopSpacingKm
// and at most half the route (so a route keeps a middle stop besides its
// first and last).
func movSpacingKm(lineID int, routeKm float64) float64 {
	h, ok := movHeadwayMin[lineID]
	if !ok {
		h = movDefaultHeadwayMin
	}
	v, ok := movSpeedKmh[lineID]
	if !ok {
		v = movDefaultSpeedKmh
	}
	d := v * h / 60 * movSpacingFactor
	if max := routeKm / 2; d > max {
		d = max
	}
	if d < movStopSpacingKm {
		d = movStopSpacingKm
	}
	return d
}

// movLine is one line of the lines list.
type movLine struct {
	ID        int    `json:"id"`
	Code      string `json:"code"`
	Name      string `json:"name"`
	Color     string `json:"color"`
	TextColor string `json:"textColor"`
}

// movStop is one stop of a route, with its distance from the route's start.
type movStop struct {
	ID   int     `json:"id"`
	Name string  `json:"name"`
	Town string  `json:"town"`
	Lat  float64 `json:"lat"`
	Lon  float64 `json:"lon"`
	Km   float64 `json:"km"`
}

// movRoute is one direction (trayecto) of a line, its stops in order.
type movRoute struct {
	LineID   int       `json:"lineId"`
	Trayecto int       `json:"trayecto"`
	Desc     string    `json:"desc"`
	Dest     string    `json:"dest"`
	Stops    []movStop `json:"stops"`
	// Geometry is the route's path from the site's KML ([lat, lon]); empty
	// when it could not be fetched (the stops are joined instead).
	Geometry [][2]float64 `json:"geometry,omitempty"`
	// Shape is the Generalitat road shape that fits the route (gencatEnrich;
	// nil: none fits), with each stop's distance along it and the shape's
	// cumulative length, in metres. Not cached: rebuilt from the data file.
	Shape      [][2]float64 `json:"-"`
	ShapeAlong []float64    `json:"-"`
	ShapeCum   []float64    `json:"-"`
}

// movStatic is the cached lines and routes.
type movStatic struct {
	FetchedAt time.Time          `json:"fetchedAt"`
	Lines     map[int]movLine    `json:"lines"`
	Routes    map[int][]movRoute `json:"routes"`
}

// movPrediction is one tracked bus's time to a stop, as observed.
type movPrediction struct {
	LineID   int
	Trayecto int
	StopID   int
	EtaSec   []float64 // tracked buses, soonest first
	At       time.Time
}

// movPoller follows the configured lines.
type movPoller struct {
	lineIDs   []int
	primary   map[int]bool // primary lines polled every cycle (secondary-only stops every 2nd cycle)
	dir       string       // cache directory
	lastRetry time.Time    // last retryMissing (poller goroutine only)
	delays    *movDelayTracker
	sched     *movSchedStore

	mu               sync.Mutex
	static           *movStatic
	preds            map[[3]int]movPrediction // line, trayecto, stop
	obs              map[int]movStopObs       // stop -> what its last answer showed
	stats            movStats
	backoff          time.Duration
	until            time.Time // background crawler pacing + backoff
	throttledUntil   time.Time // hard site-throttle backoff (shared with interactive clicks)
	interactiveUntil time.Time // lightweight 800 ms spacing for user stop clicks

	snap atomic.Pointer[movSnapshot]
}

type movStats struct {
	Requests, Throttled, Errors int
	LastOK                      time.Time
	LastError                   string
	CycleStarted                time.Time
	LastCycleSec                float64
	SampledStops                int // stops picked by movSamples for a cycle
	SkippedStops                int // of the last cycle's samples, not asked (no bus due)
	AskedStops                  int // of the last cycle's samples, asked
}

var movLive atomic.Pointer[movPoller]

// startMoventisPoller starts the poller when ARRIBO_MOVENTIS=1 and returns a
// function that stops it.
func startMoventisPoller() (stop func()) {
	if os.Getenv("ARRIBO_MOVENTIS") != "1" {
		return func() {}
	}
	ids := append([]int(nil), movDefaultLines...)
	primary := map[int]bool{}
	for _, id := range movDefaultLines {
		primary[id] = true
	}
	if s := strings.TrimSpace(os.Getenv("ARRIBO_MOVENTIS_LINES")); s != "" {
		ids = nil
		primary = nil
		for _, part := range strings.Split(s, ",") {
			if n, err := strconv.Atoi(strings.TrimSpace(part)); err == nil && n > 0 {
				ids = append(ids, n)
			}
		}
	} else if os.Getenv("ARRIBO_MOVENTIS_MARESME") == "1" {
		ids = append(ids, movMaresmeExtraLines...)
	}
	dir := movCacheDir()
	p := &movPoller{
		lineIDs: ids,
		primary: primary,
		dir:     dir,
		delays:  newMovDelayTracker(dir),
		sched:   newMovSchedStore(dir),
		preds:   map[[3]int]movPrediction{},
	}
	ctx, cancel := context.WithCancel(context.Background())
	var alertsWG sync.WaitGroup
	startMovAlertsPoller(ctx, &alertsWG)
	done := make(chan struct{})
	go func() {
		defer close(done)
		p.run(ctx)
	}()
	movLive.Store(p)
	log.Printf("[Moventis] following %d lines (ARRIBO_MOVENTIS=1)", len(ids))
	return func() {
		movLive.CompareAndSwap(p, nil)
		movAlertsLive.Store(nil)
		rtCatalog.Delete(movAgencyID)
		cancel()
		<-done
		alertsWG.Wait()
		if p.delays != nil {
			p.delays.save(true)
		}
		if p.sched != nil {
			p.sched.save(true)
		}
	}
}

// errMovThrottled is the site's placeholder answer.
var errMovThrottled = errors.New("throttled by the site (placeholder answer)")

// get fetches one API path, spacing requests and honouring the backoff.
func (p *movPoller) get(ctx context.Context, path string) ([]byte, error) {
	p.mu.Lock()
	wait := time.Until(p.until)
	p.mu.Unlock()
	if wait > 0 {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(wait):
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, movBase+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", movUserAgent)
	req.Header.Set("Accept", "application/json")
	resp, err := movHTTP.Do(req)
	p.mu.Lock()
	p.stats.Requests++
	p.until = time.Now().Add(movMinGap)
	p.mu.Unlock()
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	const movMaxBody = 8 << 20
	body, err := io.ReadAll(io.LimitReader(resp.Body, movMaxBody+1))
	if err != nil {
		return nil, err
	}
	if len(body) > movMaxBody {
		return nil, fmt.Errorf("response body exceeded %d bytes", movMaxBody)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return body, nil
}

// getInteractive fetches a stop's live predictions for an interactive user
// click without blocking on the background crawler's 11 s movMinGap. It still
// respects site-level throttling (throttledUntil) and spaces interactive
// requests 800 ms apart.
func (p *movPoller) getInteractive(ctx context.Context, path string) ([]byte, error) {
	const interactiveGap = 800 * time.Millisecond
	p.mu.Lock()
	if time.Now().Before(p.throttledUntil) {
		p.mu.Unlock()
		return nil, errMovThrottled
	}
	wait := time.Until(p.interactiveUntil)
	nextAt := time.Now()
	if wait > 0 {
		nextAt = nextAt.Add(wait)
	}
	p.interactiveUntil = nextAt.Add(interactiveGap)
	p.mu.Unlock()
	if wait > 0 {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(wait):
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, movBase+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", movUserAgent)
	req.Header.Set("Accept", "application/json")
	resp, err := movHTTP.Do(req)
	p.mu.Lock()
	p.stats.Requests++
	p.mu.Unlock()
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	const movMaxBody = 8 << 20
	body, err := io.ReadAll(io.LimitReader(resp.Body, movMaxBody+1))
	if err != nil {
		return nil, err
	}
	if len(body) > movMaxBody {
		return nil, fmt.Errorf("response body exceeded %d bytes", movMaxBody)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return body, nil
}

// throttled records a placeholder answer and lengthens the backoff.
func (p *movPoller) throttled() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.stats.Throttled++
	if p.backoff == 0 {
		log.Printf("[Moventis] the site is holding requests back; waiting %s", movBackoffMin)
	}
	if p.backoff < movBackoffMin {
		p.backoff = movBackoffMin
	} else if p.backoff < movBackoffMax {
		p.backoff *= 2
		if p.backoff > movBackoffMax {
			p.backoff = movBackoffMax
		}
	}
	until := time.Now().Add(p.backoff)
	p.until = until
	p.throttledUntil = until
}

func (p *movPoller) ok() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.backoff = 0
	p.stats.LastOK = time.Now()
}

func (p *movPoller) failed(err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.stats.Errors++
	p.stats.LastError = movErrText(err)
	if p.until.Before(time.Now().Add(movBackoffMin)) {
		p.until = time.Now().Add(movBackoffMin)
	}
}

// ---------------------------------------------------------------- parsing

// parseMovLines reads the lines list (one row per line and service day).
func parseMovLines(body []byte) (map[int]movLine, error) {
	var rows []struct {
		ID        string `json:"ID_LINEA"`
		Code      string `json:"COD_LINEA"`
		Desc      string `json:"DESC_LINEA"`
		Color     string `json:"COLOR"`
		TextColor any    `json:"TEXT_COLOR"`
	}
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, err
	}
	out := map[int]movLine{}
	for _, r := range rows {
		id, err := strconv.Atoi(r.ID)
		if err != nil || id <= 0 {
			continue
		}
		if _, seen := out[id]; seen {
			continue
		}
		tc, _ := r.TextColor.(string)
		out[id] = movLine{ID: id, Code: strings.TrimSpace(r.Code), Name: strings.TrimSpace(r.Desc), Color: movHex(r.Color), TextColor: movHex(tc)}
	}
	if len(out) == 0 {
		return nil, errMovThrottled
	}
	return out, nil
}

var reMovHex = regexp.MustCompile(`^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$`)

func movHex(s string) string {
	s = strings.TrimSpace(s)
	if reMovHex.MatchString(s) {
		return s
	}
	return ""
}

// errMovNoRoutes: the routes answer had no route (no service that day, or
// the site holding back); the caller tries other days.
var errMovNoRoutes = errors.New("no routes in the answer")

// parseMovRoutes reads a line's routes. The site answers [{"numLinea":..}]
// with no route for a day without (remaining) service, and also while it
// holds requests back. Some lines (e.g. C-20 circular/concatenated routes)
// encode ID_TRAYECTO as a JSON array ([1, 2] or [3]) instead of a scalar,
// with each stop in TrayectosDet carrying its sub-route's ID_TRAYECTO.
func parseMovRoutes(lineID int, body []byte) ([]movRoute, error) {
	type detRow struct {
		Trayecto float64 `json:"ID_TRAYECTO"`
		Seq      float64 `json:"SECUENCIA"`
		Km       float64 `json:"NKM_ORIGEN"`
		Parada   struct {
			ID   float64 `json:"ID_PARADA"`
			Name string  `json:"DESC_PARADA"`
			Town string  `json:"MUNICIPIO"`
			Lat  any     `json:"LATITUD"`
			Lon  any     `json:"LONGITUD"`
		} `json:"Parada"`
	}
	var rows []struct {
		Trayecto any      `json:"ID_TRAYECTO"`
		Desc     string   `json:"DESC_TRAYECTO"`
		Det      []detRow `json:"TrayectosDet"`
	}
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, err
	}
	buildRoute := func(tid int, desc string, det []detRow, preferLastTown bool) (movRoute, bool) {
		if len(det) < 2 {
			return movRoute{}, false
		}
		cp := append([]detRow(nil), det...)
		sort.SliceStable(cp, func(i, j int) bool { return cp[i].Seq < cp[j].Seq })
		rt := movRoute{LineID: lineID, Trayecto: tid, Desc: strings.TrimSpace(desc)}
		for _, d := range cp {
			lat, lon := movNum(d.Parada.Lat), movNum(d.Parada.Lon)
			if d.Parada.ID <= 0 || lat == 0 || lon == 0 || math.IsNaN(lat) || math.IsNaN(lon) {
				continue
			}
			rt.Stops = append(rt.Stops, movStop{ID: int(d.Parada.ID), Name: cleanMovStopName(d.Parada.Name), Town: strings.TrimSpace(d.Parada.Town), Lat: lat, Lon: lon, Km: d.Km})
		}
		if len(rt.Stops) < 2 {
			return movRoute{}, false
		}
		if preferLastTown && rt.Stops[len(rt.Stops)-1].Town != "" {
			rt.Dest = rt.Stops[len(rt.Stops)-1].Town
		} else {
			rt.Dest = movRouteDest(rt)
		}
		return rt, true
	}
	var out []movRoute
	for _, r := range rows {
		tids := movTrayectoIDs(r.Trayecto)
		if len(tids) == 0 || len(r.Det) < 2 {
			continue
		}
		if len(tids) == 1 {
			if rt, ok := buildRoute(tids[0], r.Desc, r.Det, false); ok {
				out = append(out, rt)
			}
			continue
		}
		byTID := map[int][]detRow{}
		for _, d := range r.Det {
			if d.Trayecto > 0 {
				byTID[int(d.Trayecto)] = append(byTID[int(d.Trayecto)], d)
			}
		}
		added := 0
		for idx, tid := range tids {
			if rt, ok := buildRoute(tid, r.Desc, byTID[tid], idx > 0); ok {
				out = append(out, rt)
				added++
			}
		}
		if added == 0 {
			if rt, ok := buildRoute(tids[0], r.Desc, r.Det, false); ok {
				out = append(out, rt)
			}
		}
	}
	if len(out) == 0 {
		return nil, errMovNoRoutes
	}
	return out, nil
}

// movTrayectoIDs parses ID_TRAYECTO from either a scalar number (1) or an
// array of numbers ([1, 2] on concatenated/circular Moventis routes like C-20).
func movTrayectoIDs(v any) []int {
	switch x := v.(type) {
	case float64:
		if x > 0 {
			return []int{int(x)}
		}
	case []any:
		var out []int
		for _, elem := range x {
			if f, ok := elem.(float64); ok && f > 0 {
				out = append(out, int(f))
			}
		}
		return out
	}
	return nil
}

func movNum(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		if err != nil {
			return math.NaN()
		}
		return f
	}
	return math.NaN()
}

// movRouteDest is the route's destination as the predictions name it: the
// part of the description after the last " - " ("(C10) BCN - MATARÓ (PER LA
// NII)" -> "MATARÓ"), else the last stop's town.
func movRouteDest(rt movRoute) string {
	d := rt.Desc
	if i := strings.LastIndex(d, " - "); i >= 0 {
		d = d[i+3:]
	}
	if i := strings.Index(d, "("); i > 0 {
		d = d[:i]
	}
	d = strings.TrimSpace(d)
	// "865 MATARÓ-BELLATERA": the line code in front is not a place.
	if f := strings.Fields(d); len(f) > 1 && strings.IndexFunc(f[0], func(r rune) bool { return r >= '0' && r <= '9' }) >= 0 {
		d = strings.Join(f[1:], " ")
	}
	// "MATARÓ-BELLATERRA": origin and destination joined by a bare dash.
	if i := strings.LastIndex(d, "-"); i >= 0 && strings.TrimSpace(d[i+1:]) != "" {
		d = strings.TrimSpace(d[i+1:])
	}
	if d == "" && len(rt.Stops) > 0 {
		d = rt.Stops[len(rt.Stops)-1].Town
	}
	return d
}

// movNorm folds case and accents for name matching.
func movNorm(s string) string {
	r := strings.NewReplacer("à", "a", "á", "a", "è", "e", "é", "e", "í", "i", "ï", "i", "ò", "o", "ó", "o", "ú", "u", "ü", "u", "ç", "c", "ñ", "n", "·", "", "'", "", "`", "")
	return strings.Join(strings.Fields(r.Replace(strings.ToLower(s))), " ")
}

var reMovRealtime = regexp.MustCompile(`^\s*(\d+)\s*min\s*([\d.]+)\s*s`)

// movStopETA is one line's tracked buses at a stop, by destination.
type movStopETA struct {
	LineID int
	Dest   string
	EtaSec []float64
	// Sched holds the "HH:MM" departures of the timetable-only entries
	// ("real":"N", Madrid local time) of the answer, as listed.
	Sched []string
}

var reMovHora = regexp.MustCompile(`^\s*(\d{1,2}):(\d{2})\s*$`)

// parseMovStopTimes reads a stop's predictions: every line serving the stop,
// per destination: the tracked buses ("real":"S", "26 min 42.4 s") and the
// scheduled departure times of the timetable-only entries ("real":"N",
// "hora":"22:08"), which are not predictions of a bus.
func parseMovStopTimes(body []byte) ([]movStopETA, error) {
	var rows []struct {
		IDLinea   any                        `json:"idLinea"`
		Trayectos map[string]json.RawMessage `json:"trayectos"`
	}
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, err
	}
	type entry struct {
		Minutos string `json:"minutos"`
		Real    string `json:"real"`
	}
	var out []movStopETA
	placeholder := len(rows) > 0
	for _, r := range rows {
		id, ok := r.IDLinea.(float64)
		if !ok {
			continue // "A": the placeholder
		}
		placeholder = false
		for dest, raw := range r.Trayectos {
			var list []entry
			var sched []string
			if err := json.Unmarshal(raw, &list); err != nil {
				// Timetable-only times come as an object keyed by minutes.
				var tt map[string]struct {
					Real string `json:"real"`
					Hora string `json:"hora"`
				}
				if json.Unmarshal(raw, &tt) == nil {
					for _, e := range tt {
						if e.Real == "N" && reMovHora.MatchString(e.Hora) {
							sched = append(sched, strings.TrimSpace(e.Hora))
						}
					}
				}
				if len(sched) > 0 {
					sort.Strings(sched)
					out = append(out, movStopETA{LineID: int(id), Dest: dest, Sched: sched})
				}
				continue
			}
			var etas []float64
			for _, e := range list {
				if e.Real != "S" {
					continue
				}
				m := reMovRealtime.FindStringSubmatch(e.Minutos)
				if m == nil {
					continue
				}
				mins, _ := strconv.Atoi(m[1])
				secs, _ := strconv.ParseFloat(m[2], 64)
				etas = append(etas, float64(mins)*60+secs)
			}
			if len(etas) > 0 {
				sort.Float64s(etas)
				out = append(out, movStopETA{LineID: int(id), Dest: dest, EtaSec: etas})
			}
		}
	}
	if placeholder {
		return nil, errMovThrottled
	}
	return out, nil
}

// --------------------------------------------------------------- static

func (p *movPoller) cachePath() string { return filepath.Join(p.dir, "static.json") }

func (p *movPoller) loadCache() *movStatic {
	b, err := os.ReadFile(p.cachePath())
	if err != nil {
		return nil
	}
	var s movStatic
	if json.Unmarshal(b, &s) != nil || len(s.Routes) == 0 {
		return nil
	}
	// Destinations follow the current rule, not the one the cache was written with.
	paths := true
	for id, rs := range s.Routes {
		for i := range rs {
			for j := range rs[i].Stops {
				rs[i].Stops[j].Name = cleanMovStopName(rs[i].Stops[j].Name)
			}
			rs[i].Dest = movRouteDest(rs[i])
			if len(rs[i].Geometry) < 2 {
				paths = false
			}
		}
		s.Routes[id] = rs
	}
	if !paths {
		// A cache written before route paths were fetched: refresh it now
		// (it is still used until the refresh succeeds).
		s.FetchedAt = time.Time{}
	}
	return &s
}

func (p *movPoller) saveCache(s *movStatic) {
	if err := os.MkdirAll(p.dir, 0o755); err != nil {
		return
	}
	b, err := json.Marshal(s)
	if err != nil {
		return
	}
	tmp := p.cachePath() + ".tmp"
	if os.WriteFile(tmp, b, 0o644) == nil {
		_ = os.Rename(tmp, p.cachePath())
	}
}

// refreshStatic fetches the lines list and the followed lines' routes. A
// line whose routes cannot be fetched keeps the cached ones.
func (p *movPoller) refreshStatic(ctx context.Context, prev *movStatic) (*movStatic, error) {
	body, err := p.get(ctx, "/es/moventis/ca/lines")
	if err != nil {
		return nil, err
	}
	lines, err := parseMovLines(body)
	if err != nil {
		return nil, err
	}
	s := &movStatic{FetchedAt: time.Now(), Lines: map[int]movLine{}, Routes: map[int][]movRoute{}}
	reusePrev := prev != nil && time.Since(prev.FetchedAt) <= movStaticMaxAge
	for _, id := range p.lineIDs {
		if l, ok := lines[id]; ok {
			s.Lines[id] = l
		}
		if reusePrev && len(prev.Routes[id]) > 0 {
			s.Routes[id] = prev.Routes[id]
			continue
		}
		if routes, err := p.fetchRoutes(ctx, id); err == nil {
			s.Routes[id] = routes
		} else if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if _, ok := s.Routes[id]; !ok && prev != nil && len(prev.Routes[id]) > 0 {
			s.Routes[id] = prev.Routes[id]
		}
	}
	if len(s.Routes) == 0 {
		return nil, errMovNoRoutes
	}
	n := 0
	for _, rs := range s.Routes {
		n += len(rs)
	}
	log.Printf("[Moventis] routes loaded: %d lines, %d routes", len(s.Routes), n)
	return s, nil
}

// fetchRoutes is a line's routes (the same every day) from today's answer,
// else the next days' (a line may have no service left today).
func (p *movPoller) fetchRoutes(ctx context.Context, id int) ([]movRoute, error) {
	today := time.Now().In(madrid)
	for d := 0; d < 3; d++ {
		date := today.AddDate(0, 0, d).Format("20060102")
		body, err := p.get(ctx, fmt.Sprintf("/api/json/GetTrayectos/%d/%s", id, date))
		if err != nil {
			return nil, err
		}
		if routes, err := parseMovRoutes(id, body); err == nil {
			p.ok()
			for i := range routes {
				if b, err := p.get(ctx, fmt.Sprintf("/api/json/GetKMLs/%d/%d", id, routes[i].Trayecto)); err == nil {
					routes[i].Geometry = parseMovKML(b)
				} else if ctx.Err() != nil {
					return nil, ctx.Err()
				}
			}
			return routes, nil
		}
	}
	return nil, errMovNoRoutes
}

var reMovKMLCoords = regexp.MustCompile(`(?s)<coordinates>(.*?)</coordinates>`)

// parseMovKML is the path of a route's KML (lon,lat[,alt] tuples), as
// [lat, lon], at most rtMaxShapePoints points; nil when there is none.
func parseMovKML(b []byte) [][2]float64 {
	var pts [][2]float64
	for _, m := range reMovKMLCoords.FindAllSubmatch(b, -1) {
		for _, tuple := range strings.Fields(string(m[1])) {
			parts := strings.Split(tuple, ",")
			if len(parts) < 2 {
				continue
			}
			lon, err1 := strconv.ParseFloat(parts[0], 64)
			lat, err2 := strconv.ParseFloat(parts[1], 64)
			if err1 != nil || err2 != nil || lat < 35 || lat > 45 || lon < -5 || lon > 5 {
				continue
			}
			pts = append(pts, [2]float64{lat, lon})
		}
	}
	if len(pts) < 2 {
		return nil
	}
	if len(pts) > rtMaxShapePoints {
		step := float64(len(pts)-1) / float64(rtMaxShapePoints-1)
		thin := make([][2]float64, 0, rtMaxShapePoints)
		for i := 0; i < rtMaxShapePoints-1; i++ {
			thin = append(thin, pts[int(float64(i)*step)])
		}
		pts = append(thin, pts[len(pts)-1])
	}
	return pts
}

// movOperator is Moventis in the line catalog (catalogOperators). It is
// not in reportOperators: Dades has no delays for it (its predictions come
// without the scheduled time).
var movOperator = operatorInfo{ID: movAgencyID, Name: "Moventis", ShortName: "Moventis", Mode: "bus", Tier: "predicted", Method: "operator_prediction",
	Source: "Previsions d'arribada a cada parada que Moventis publica al seu web de temps real; la posició dels busos s'estima a partir d'aquestes previsions."}

// lineOperators is the operators whose lines the catalog lists and the
// line view opens: the train operators, and Moventis and AMB while their
// lines are in the catalog.
func lineOperators() []operatorInfo {
	ops := reportOperators
	extras := append([]operatorInfo{movOperator, ambOperator, tramTbxOperator, tramTbsOperator, tmbOperator, sagalesOperator, gironaOperator}, moventisNapOperators...)
	for _, extra := range extras {
		if _, ok := rtCatalog.Load(extra.ID); ok {
			ops = append(append([]operatorInfo(nil), ops...), extra)
		}
	}
	return ops
}

// publishCatalog puts the followed lines in the line catalog (rtCatalog):
// code, name, colours, and per route its stops and path, as the train
// lines' profiles. Directions are the routes in trayecto order (0, 1...).
func (s *movStatic) publishCatalog(lineIDs []int) {
	op := &rtCatalogOp{AgencyID: movAgencyID, Mode: "bus", Profiles: map[string]*rtLineProfile{}}
	for _, id := range lineIDs {
		l, ok := s.Lines[id]
		routes := s.Routes[id]
		if !ok || l.Code == "" || len(routes) == 0 {
			continue
		}
		op.Lines = append(op.Lines, rtRoute{Code: l.Code, Name: l.Name, Color: strings.ToUpper(l.Color), TextColor: strings.ToUpper(l.TextColor), RouteType: 3})
		prof := &rtLineProfile{Code: l.Code}
		for i, rt := range movOrderedRoutes(routes) {
			d := rtLineDirection{DirectionID: i, Headsign: movTitle(rt.Dest)}
			for _, st := range rt.Stops {
				d.Stops = append(d.Stops, rtLineStop{ID: numToString(float64(st.ID)), Name: cleanMovStopName(st.Name), Lat: st.Lat, Lon: st.Lon})
				if len(rt.Geometry) < 2 && len(rt.Shape) < 2 {
					d.Geometry = append(d.Geometry, [2]float64{st.Lat, st.Lon})
				}
			}
			if len(rt.Shape) >= 2 {
				d.Geometry = movShapeTrim(rt) // the Generalitat road shape, first to last stop
			} else if len(rt.Geometry) >= 2 {
				d.Geometry = rt.Geometry
			} else {
				d.GeometryFromStops = true
			}
			prof.Directions = append(prof.Directions, d)
		}
		op.Profiles[l.Code] = prof
	}
	if len(op.Lines) > 0 {
		rtCatalog.Store(movAgencyID, op)
	}
}

// movOrderedRoutes is a line's routes in trayecto order: their index is
// the line view's direction id.
func movOrderedRoutes(routes []movRoute) []movRoute {
	out := append([]movRoute(nil), routes...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Trayecto < out[j].Trayecto })
	return out
}

// movDirectionOf is the direction id (movOrderedRoutes index) of a route.
func movDirectionOf(routes []movRoute, trayecto int) int {
	for i, rt := range movOrderedRoutes(routes) {
		if rt.Trayecto == trayecto {
			return i
		}
	}
	return -1
}

var (
	reMovBrokenQMark = regexp.MustCompile(`(\p{L})¿(\p{L})`)
	reMovElidedD     = regexp.MustCompile(`(^|[\s/(.])D'(\p{L})`)
	reMovElidedL     = regexp.MustCompile(`([\s/.])L'(\p{L})`)
	reMovElidedDEn   = regexp.MustCompile(`(?i)(^|[\s/(.])d'en(\s)`)
)

// cleanMovStopName repairs legacy Moventis encoding artifacts in stop names:
// broken apostrophes ("D¿Ocata", "L´Ajuntament", "O`Donnell"), title-cased
// Catalan elisions ("D'Ocata" -> "d'Ocata", "de L'Ajuntament" -> "de l'Ajuntament",
// "d'En Valls" -> "d'en Valls"), and runs of multiple spaces.
func cleanMovStopName(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	s = reMovBrokenQMark.ReplaceAllString(s, "$1'$2")
	s = strings.ReplaceAll(s, "´", "'")
	s = strings.ReplaceAll(s, "`", "'")
	s = reMovElidedD.ReplaceAllString(s, "${1}d'${2}")
	s = reMovElidedL.ReplaceAllString(s, "${1}l'${2}")
	s = reMovElidedDEn.ReplaceAllString(s, "${1}d'en${2}")
	return strings.Join(strings.Fields(s), " ")
}

// movTitle turns "VILASSAR DE DALT" into "Vilassar De Dalt"-like title case
// for headsigns, keeping short words lower case ("de", "del", "la").
func movTitle(s string) string {
	if strings.EqualFold(strings.TrimSpace(s), "BCN") {
		return "Barcelona"
	}
	words := strings.Fields(strings.ToLower(s))
	small := map[string]bool{"de": true, "del": true, "la": true, "les": true, "el": true, "els": true, "i": true, "d'": true}
	for i, w := range words {
		if i > 0 && small[w] {
			continue
		}
		r := []rune(w)
		if len(r) > 0 {
			r[0] = []rune(strings.ToUpper(string(r[0])))[0]
		}
		words[i] = string(r)
	}
	return strings.Join(words, " ")
}

// retryMissing asks again for the followed lines that have no routes
// (the site may have held them back), at most every movRetryMissing. The
// published static data is never changed in place (the server reads it):
// a new copy is returned when something was added.
func (p *movPoller) retryMissing(ctx context.Context, s *movStatic) *movStatic {
	if time.Since(p.lastRetry) < movRetryMissing {
		return s
	}
	p.lastRetry = time.Now()
	var next *movStatic
	for _, id := range p.lineIDs {
		if len(s.Routes[id]) > 0 {
			continue
		}
		routes, err := p.fetchRoutes(ctx, id)
		if err != nil {
			continue
		}
		if next == nil {
			next = &movStatic{FetchedAt: s.FetchedAt, Lines: s.Lines, Routes: map[int][]movRoute{}}
			for k, v := range s.Routes {
				next.Routes[k] = v
			}
		}
		next.Routes[id] = routes
	}
	if next == nil {
		return s
	}
	p.saveCache(next)
	log.Printf("[Moventis] routes added for lines that had none: now %d lines", len(next.Routes))
	return next
}

// --------------------------------------------------------------- polling

// movSample is one stop to ask, with a followed line serving it.
type movSample struct {
	StopID, LineID int
}

// movStopLines maps each stop id to the followed lines that serve it.
func movStopLines(s *movStatic, lineIDs []int) map[int][]int {
	out := map[int][]int{}
	for _, id := range lineIDs {
		for _, rt := range s.Routes[id] {
			for _, st := range rt.Stops {
				ls := out[st.ID]
				if len(ls) == 0 || ls[len(ls)-1] != id {
					dup := false
					for _, l := range ls {
						if l == id {
							dup = true
						}
					}
					if !dup {
						out[st.ID] = append(ls, id)
					}
				}
			}
		}
	}
	return out
}

// movPickStops chooses the stops to sample on one route: the first and last
// always; between them, from each window [last+spacing/2, last+spacing] the
// stop that serves the most followed lines (the furthest on a tie), so a
// stop shared by several lines answers for all of them. When the window
// holds no stop, the first stop at least spacing away.
func movPickStops(stops []movStop, spacing float64, lines map[int][]int) []int {
	n := len(stops)
	if n == 0 {
		return nil
	}
	picks := []int{0}
	last := 0
	for last < n-1 {
		best, bestN := -1, -1
		next := -1
		for j := last + 1; j < n-1; j++ {
			d := stops[j].Km - stops[last].Km
			if d >= spacing/2 && d <= spacing {
				if c := len(lines[stops[j].ID]); c >= bestN {
					best, bestN = j, c
				}
			}
			if d > spacing {
				next = j
				break
			}
		}
		if best < 0 {
			best = next
		}
		if best < 0 {
			break
		}
		picks = append(picks, best)
		last = best
	}
	return append(picks, n-1)
}

// samples picks the stops to ask: per route the first and last stop and
// about one every movSpacingKm (the distance between consecutive buses),
// preferring stops shared by several followed lines, each stop once (a stop
// answers for every line serving it), the routes interleaved so every line
// is refreshed throughout a cycle.
func movSamples(s *movStatic, lineIDs []int) []movSample {
	stopLines := movStopLines(s, lineIDs)
	var perRoute [][]movSample
	for _, id := range lineIDs {
		for _, rt := range s.Routes[id] {
			var picks []movSample
			routeKm := 0.0
			if n := len(rt.Stops); n > 0 {
				routeKm = rt.Stops[n-1].Km
			}
			for _, i := range movPickStops(rt.Stops, movSpacingKm(id, routeKm), stopLines) {
				picks = append(picks, movSample{StopID: rt.Stops[i].ID, LineID: id})
			}
			perRoute = append(perRoute, picks)
		}
	}
	seen := map[int]bool{}
	var out []movSample
	for k := 0; ; k++ {
		added := false
		for _, picks := range perRoute {
			if k < len(picks) {
				added = true
				if !seen[picks[k].StopID] {
					seen[picks[k].StopID] = true
					out = append(out, picks[k])
				}
			}
		}
		if !added {
			return out
		}
	}
}

// Skipping stops with no bus due: a sampled stop is not asked in a cycle
// when its last answer showed no live bus for any followed line and none is
// scheduled within movSkipAhead, except that every stop is asked at least
// every movMaxAskGap, to notice extra trips.
const (
	movSkipAhead  = 60 * time.Minute // next timetable departure further than this
	movObsFresh   = 60 * time.Minute // an answer older than this tells nothing
	movMaxAskGap  = 30 * time.Minute // longest a stop goes unasked
	movIdleAskGap = 2 * time.Hour    // the same while the timetable has nothing due there
)

// movLineObs is what a stop's answer showed for one followed line.
type movLineObs struct {
	Live      bool      // a tracked bus (real:"S") was listed
	NextSched time.Time // the soonest timetable departure listed; zero if none
}

// movStopObs is a stop's last answer.
type movStopObs struct {
	At    time.Time
	Lines map[int]movLineObs
}

// movNextSched is the soonest of the "HH:MM" Madrid times at or after at
// (a time more than 10 minutes past is read as the next day; the answer
// carries no date), zero when none parses.
func movNextSched(horas []string, at time.Time) time.Time {
	var best time.Time
	c := getDateComponents(at.UnixMilli())
	for _, h := range horas {
		m := reMovHora.FindStringSubmatch(h)
		if m == nil {
			continue
		}
		hh, _ := strconv.Atoi(m[1])
		mm, _ := strconv.Atoi(m[2])
		if hh > 23 || mm > 59 {
			continue
		}
		t := time.UnixMilli(localTimeToUtcDate(c.Year, c.MonthIndex, c.Day, hh, mm, 0))
		if t.Before(at.Add(-10 * time.Minute)) {
			t = time.UnixMilli(localTimeToUtcDate(c.Year, c.MonthIndex, c.Day+1, hh, mm, 0))
		}
		if best.IsZero() || t.Before(best) {
			best = t
		}
	}
	return best
}

// movShouldAsk decides whether a sampled stop is asked at now. followed are
// the followed lines serving it; obs is its last answer (ok false: never
// asked, or forgotten). due, when not nil, is the Generalitat timetable: when
// a line is next due at the stop (ok false: it does not know). A stop is
// asked when a bus was live there, or a departure is due within
// movSkipAhead by the last answer or by the timetable, and at least every
// movMaxAskGap to notice extra trips; that gap stretches to movIdleAskGap
// while the timetable knows every followed line there and has none due.
func movShouldAsk(now time.Time, obs movStopObs, ok bool, followed []int, due func(lineID int) (time.Time, bool)) bool {
	if !ok || obs.At.IsZero() {
		return true
	}
	age := now.Sub(obs.At)
	if age < 0 {
		return true
	}
	if age < movObsFresh {
		for _, l := range followed {
			o := obs.Lines[l] // a line the answer did not list: no bus shown
			if o.Live {
				return true
			}
			if !o.NextSched.IsZero() && o.NextSched.Sub(now) <= movSkipAhead {
				return true
			}
		}
	}
	idle := due != nil && len(followed) > 0
	for _, l := range followed {
		if due == nil {
			break
		}
		t, known := due(l)
		if known && !t.IsZero() && t.Sub(now) <= movSkipAhead {
			return true
		}
		if !known || !t.IsZero() && t.Sub(now) <= movIdleAskGap {
			idle = false
		}
	}
	if idle {
		return age >= movIdleAskGap
	}
	return age >= movMaxAskGap
}

// routeFor is the route of a followed line that a prediction at stopID
// towards dest belongs to: the only route of the line through that stop,
// else the one whose destination matches.
func (s *movStatic) routeFor(lineID, stopID int, dest string) (movRoute, bool) {
	var cands []movRoute
	for _, rt := range s.Routes[lineID] {
		for _, st := range rt.Stops {
			if st.ID == stopID {
				cands = append(cands, rt)
				break
			}
		}
	}
	if len(cands) == 1 {
		return cands[0], true
	}
	nd := movNorm(dest)
	for _, rt := range cands {
		if nd != "" && (strings.Contains(movNorm(rt.Dest), nd) || strings.Contains(nd, movNorm(rt.Dest))) {
			return rt, true
		}
	}
	return movRoute{}, false
}

func (p *movPoller) run(ctx context.Context) {
	static := p.loadCache()
	// enriched is the last static given the Generalitat shapes (gencatEnrich
	// makes a new value, so a changed static is noticed by its pointer).
	var enriched *movStatic
	enrich := func() {
		if static != nil && static != enriched {
			static = gencatEnrich(static)
			enriched = static
		}
	}
	enrich()
	if static != nil {
		// The cached lines are listed at once, also while a refresh runs.
		p.mu.Lock()
		p.static = static
		p.mu.Unlock()
		static.publishCatalog(p.lineIDs)
	}
	p.publish(time.Now())
	cycle := 0
	for ctx.Err() == nil {
		if static == nil || time.Since(static.FetchedAt) > movStaticMaxAge || movStaticMissingLines(static, p.lineIDs) {
			fresh, err := p.refreshStatic(ctx, static)
			switch {
			case err == nil:
				static = fresh
				p.saveCache(static)
			case errors.Is(err, errMovThrottled):
				p.throttled()
			case ctx.Err() == nil:
				p.failed(err)
			}
			p.publish(time.Now())
			if static == nil {
				if !movSleep(ctx, movBackoffMin) {
					return
				}
				continue
			}
		}
		enrich()
		if static != nil {
			static = p.retryMissing(ctx, static)
			enrich()
		}
		p.mu.Lock()
		p.static = static
		p.mu.Unlock()
		static.publishCatalog(p.lineIDs)
		p.publish(time.Now())
		samples := movSamples(static, p.lineIDs)
		p.mu.Lock()
		p.stats.SampledStops = len(samples)
		p.stats.CycleStarted = time.Now()
		p.mu.Unlock()
		if len(samples) == 0 {
			if !movSleep(ctx, movBackoffMax) {
				return
			}
			continue
		}
		start := time.Now()
		stopLines := movStopLines(static, p.lineIDs)
		asked, skipped := 0, 0
		for _, sm := range samples {
			if ctx.Err() != nil {
				return
			}
			// Secondary-only Maresme stops are polled on even cycles so the
			// primary Mataró lines keep their ~6 min refresh cadence.
			if cycle%2 == 1 && !movStopIsPrimary(stopLines[sm.StopID], p.primary) {
				skipped++
				continue
			}
			p.mu.Lock()
			obs, seenBefore := p.obs[sm.StopID]
			p.mu.Unlock()
			if now := time.Now(); !movShouldAsk(now, obs, seenBefore, stopLines[sm.StopID], movDueFunc(sm.StopID, now)) {
				skipped++
				continue
			}
			asked++
			body, err := p.get(ctx, fmt.Sprintf("/api/json/GetTiemposParada/ca/%d/%d/0", sm.StopID, sm.LineID))
			if err != nil {
				if ctx.Err() == nil {
					p.failed(err)
				}
				continue
			}
			etas, err := parseMovStopTimes(body)
			if errors.Is(err, errMovThrottled) {
				p.throttled()
				continue
			}
			if err != nil {
				p.failed(err)
				continue
			}
			p.ok()
			p.record(static, sm.StopID, etas, time.Now())
			p.publish(time.Now())
		}
		p.mu.Lock()
		p.stats.LastCycleSec = math.Round(time.Since(start).Seconds())
		p.stats.AskedStops, p.stats.SkippedStops = asked, skipped
		p.mu.Unlock()
		cycle++
		if asked == 0 && !movSleep(ctx, movBackoffMin) {
			return // nothing due: do not spin
		}
		static = p.retryMissing(ctx, static)
	}
}

func movSleep(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}

// record stores a stop's predictions for the followed lines. A followed line
// at the stop with no tracked bus clears the stop (no bus is coming soon).
func (p *movPoller) record(s *movStatic, stopID int, etas []movStopETA, at time.Time) {
	if p.sched != nil {
		p.sched.record(stopID, etas, at)
	}
	followed := map[int]bool{}
	for _, id := range p.lineIDs {
		followed[id] = true
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	// Clear what this stop said before, for every followed line.
	for k := range p.preds {
		if k[2] == stopID {
			delete(p.preds, k)
		}
	}
	// Collect scheduled HH:MM departures per line from both this stop's
	// response (where real:"N" entries live under a full-route Dest label
	// separate from the real:"S" entry's short Dest) and the 24h schedule cache.
	schedByLine := map[int][]string{}
	for _, e := range etas {
		if followed[e.LineID] && len(e.Sched) > 0 {
			schedByLine[e.LineID] = append(schedByLine[e.LineID], e.Sched...)
		}
	}
	ob := movStopObs{At: at, Lines: map[int]movLineObs{}}
	for _, e := range etas {
		if !followed[e.LineID] {
			continue
		}
		lo := ob.Lines[e.LineID]
		lo.Live = lo.Live || len(e.EtaSec) > 0
		if t := movNextSched(e.Sched, at); !t.IsZero() && (lo.NextSched.IsZero() || t.Before(lo.NextSched)) {
			lo.NextSched = t
		}
		ob.Lines[e.LineID] = lo
		if len(e.EtaSec) == 0 {
			continue
		}
		rt, ok := s.routeFor(e.LineID, stopID, e.Dest)
		if !ok {
			continue
		}
		k := [3]int{e.LineID, rt.Trayecto, stopID}
		p.preds[k] = movPrediction{LineID: e.LineID, Trayecto: rt.Trayecto, StopID: stopID, EtaSec: e.EtaSec, At: at}
		if p.delays != nil {
			code := ""
			if s != nil {
				code = s.Lines[e.LineID].Code
			}
			lineSched := schedByLine[e.LineID]
			if p.sched != nil {
				if cached := p.sched.lookup(e.LineID, stopID, at); len(cached) > 0 {
					merged := make([]string, 0, len(lineSched)+8)
					merged = append(merged, lineSched...)
					for _, list := range cached {
						merged = append(merged, list...)
					}
					lineSched = merged
				}
			}
			p.delays.observe(e.LineID, code, stopID, e.EtaSec, lineSched, at, gencatData())
		}
	}
	if p.obs == nil {
		p.obs = map[int]movStopObs{}
	}
	p.obs[stopID] = ob
	// Drop predictions too old to use.
	for k, v := range p.preds {
		if at.Sub(v.At) > movObsMaxAge {
			delete(p.preds, k)
		}
	}
}

// movCacheDir is where the routes are cached: DATA_DIR/moventis (the data
// directory, like the history database), not under the timetables' folder.
func movCacheDir() string {
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = filepath.Join(appRoot, "data")
	}
	return filepath.Join(dataDir, "moventis")
}

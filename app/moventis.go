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
	movStopSpacingKm = 1.5              // sample a stop about every 1.5 km of route
	movStaticMaxAge  = 20 * time.Hour   // routes and stops are refetched after this
	movObsMaxAge     = 40 * time.Minute // a stop's predictions are not used after this
	movRetryMissing  = 30 * time.Minute // a followed line without routes is asked again after this
	movAgencyID      = "moventis"
)

// movDefaultLines: the lines through Mataró (zone Maresme, subzone Mataró):
// e11.1, e11.2, 865, C-10, C-20, C-30, N-80 (Empresa Casas).
var movDefaultLines = []int{47, 48, 51, 53, 57, 59, 68}

var movHTTP = &http.Client{Timeout: 20 * time.Second}

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
	dir       string    // cache directory
	lastRetry time.Time // last retryMissing (poller goroutine only)

	mu      sync.Mutex
	static  *movStatic
	preds   map[[3]int]movPrediction // line, trayecto, stop
	stats   movStats
	backoff time.Duration
	until   time.Time // no request before this (backoff)

	snap atomic.Pointer[movSnapshot]
}

type movStats struct {
	Requests, Throttled, Errors int
	LastOK                      time.Time
	LastError                   string
	CycleStarted                time.Time
	LastCycleSec                float64
	SampledStops                int
}

var movLive atomic.Pointer[movPoller]

// startMoventisPoller starts the poller when ARRIBO_MOVENTIS=1 and returns a
// function that stops it.
func startMoventisPoller() (stop func()) {
	if os.Getenv("ARRIBO_MOVENTIS") != "1" {
		return func() {}
	}
	ids := movDefaultLines
	if s := strings.TrimSpace(os.Getenv("ARRIBO_MOVENTIS_LINES")); s != "" {
		ids = nil
		for _, part := range strings.Split(s, ",") {
			if n, err := strconv.Atoi(strings.TrimSpace(part)); err == nil && n > 0 {
				ids = append(ids, n)
			}
		}
	}
	p := &movPoller{lineIDs: ids, dir: filepath.Join(filepath.Dir(gtfsDir()), "moventis"), preds: map[[3]int]movPrediction{}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		p.run(ctx)
	}()
	movLive.Store(p)
	log.Printf("[Moventis] following %d lines (ARRIBO_MOVENTIS=1)", len(ids))
	return func() {
		movLive.CompareAndSwap(p, nil)
		cancel()
		<-done
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
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, err
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
	p.until = time.Now().Add(p.backoff)
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
// holds requests back.
func parseMovRoutes(lineID int, body []byte) ([]movRoute, error) {
	var rows []struct {
		Trayecto any    `json:"ID_TRAYECTO"`
		Desc     string `json:"DESC_TRAYECTO"`
		Det      []struct {
			Seq    float64 `json:"SECUENCIA"`
			Km     float64 `json:"NKM_ORIGEN"`
			Parada struct {
				ID   float64 `json:"ID_PARADA"`
				Name string  `json:"DESC_PARADA"`
				Town string  `json:"MUNICIPIO"`
				Lat  any     `json:"LATITUD"`
				Lon  any     `json:"LONGITUD"`
			} `json:"Parada"`
		} `json:"TrayectosDet"`
	}
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, err
	}
	var out []movRoute
	for _, r := range rows {
		tid, ok := r.Trayecto.(float64)
		if !ok || len(r.Det) < 2 {
			continue
		}
		det := r.Det
		sort.SliceStable(det, func(i, j int) bool { return det[i].Seq < det[j].Seq })
		rt := movRoute{LineID: lineID, Trayecto: int(tid), Desc: strings.TrimSpace(r.Desc)}
		for _, d := range det {
			lat, lon := movNum(d.Parada.Lat), movNum(d.Parada.Lon)
			if d.Parada.ID <= 0 || lat == 0 || lon == 0 || math.IsNaN(lat) || math.IsNaN(lon) {
				continue
			}
			rt.Stops = append(rt.Stops, movStop{ID: int(d.Parada.ID), Name: strings.TrimSpace(d.Parada.Name), Town: strings.TrimSpace(d.Parada.Town), Lat: lat, Lon: lon, Km: d.Km})
		}
		if len(rt.Stops) < 2 {
			continue
		}
		rt.Dest = movRouteDest(rt)
		out = append(out, rt)
	}
	if len(out) == 0 {
		return nil, errMovNoRoutes
	}
	return out, nil
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
}

// parseMovStopTimes reads a stop's predictions: every line serving the stop,
// per destination, keeping only tracked buses ("real":"S", "26 min 42.4 s").
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
			if err := json.Unmarshal(raw, &list); err != nil {
				// Timetable-only times come as an object keyed by minutes.
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
	for id, rs := range s.Routes {
		for i := range rs {
			rs[i].Dest = movRouteDest(rs[i])
		}
		s.Routes[id] = rs
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
	for _, id := range p.lineIDs {
		if l, ok := lines[id]; ok {
			s.Lines[id] = l
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
			return routes, nil
		}
	}
	return nil, errMovNoRoutes
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

// samples picks the stops to ask: per route the first and last stop and
// about one every movStopSpacingKm, each stop once (a stop answers for every
// line serving it), the routes interleaved so every line is refreshed
// throughout a cycle.
func movSamples(s *movStatic, lineIDs []int) []movSample {
	var perRoute [][]movSample
	for _, id := range lineIDs {
		for _, rt := range s.Routes[id] {
			var picks []movSample
			last := math.Inf(-1)
			for i, st := range rt.Stops {
				if i == 0 || i == len(rt.Stops)-1 || st.Km-last >= movStopSpacingKm {
					picks = append(picks, movSample{StopID: st.ID, LineID: id})
					last = st.Km
				}
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
	p.publish(time.Now())
	for ctx.Err() == nil {
		if static == nil || time.Since(static.FetchedAt) > movStaticMaxAge {
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
		p.mu.Lock()
		p.static = static
		p.mu.Unlock()
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
		for _, sm := range samples {
			if ctx.Err() != nil {
				return
			}
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
		p.mu.Unlock()
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
	for _, e := range etas {
		if !followed[e.LineID] {
			continue
		}
		rt, ok := s.routeFor(e.LineID, stopID, e.Dest)
		if !ok {
			continue
		}
		k := [3]int{e.LineID, rt.Trayecto, stopID}
		p.preds[k] = movPrediction{LineID: e.LineID, Trayecto: rt.Trayecto, StopID: stopID, EtaSec: e.EtaSec, At: at}
	}
	// Drop predictions too old to use.
	for k, v := range p.preds {
		if at.Sub(v.At) > movObsMaxAge {
			delete(p.preds, k)
		}
	}
}

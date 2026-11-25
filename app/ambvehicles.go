package main

// Real GPS for the Maresme / Empresa Casas lines (C-10, C-20, C-30, e11.1,
// e11.2, 865, C-12..C-22) from the AMB app's private API
// (api.ambmobilitat.cat/v2/bus/vehicles), the source behind AMB Mobilitat.
// Unlike AMB's open GTFS-RT, which carries no Casas line, this feed has the
// whole route of each line, well past the AMB fare zone into Mataró.
//
// GOVERNANCE: this uses the AMB app's reverse-engineered API key, which plan
// step 0.1 ruled out for production; the owner chose to enable it (2026-11-25).
// The key is read from AMB_API_KEY only (never committed) and the poller is
// off unless ARRIBO_AMB_VEHICLES=1 and the key is set. It is a revocable,
// ToS-grey stopgap until AMB grants an official key (data request, plan 0.5).
// See docs/research/catalonia-2026/13-amb-app-api-c10-gps.md.
//
// These positions are measured GPS: a bus carries isRealTime, not isEstimated.
// They replace the estimated (stop-prediction) positions from moventis.go for
// a line while AMB has it live; moventis.go still provides the per-stop boards.

import (
	"context"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	ambVehURL    = "https://api.ambmobilitat.cat/v2/bus/vehicles"
	ambVehGap    = 20 * time.Second
	ambVehMaxAge = 90 * time.Second // a snapshot older than this is not shown
)

// ambVeh is one bus of a followed line, from /bus/vehicles.
type ambVeh struct {
	Line     string
	Dir      int // routeId's last digit (1/2); the moventis trayecto — unverified, flip the map if directions look swapped
	Lat, Lon float64
	VehID    string
}

type ambVehSnapshot struct {
	At     time.Time
	ByLine map[string][]ambVeh // keyed by ambNormLine(line)
}

type ambVehPoller struct {
	key string

	mu      sync.Mutex
	lastErr string
	lastOK  time.Time
	count   int

	snap atomic.Pointer[ambVehSnapshot]
}

var ambVehLive atomic.Pointer[ambVehPoller]

var ambVehHTTP = &http.Client{Timeout: 20 * time.Second}

// ambNormLine makes line codes from the two feeds comparable ("C-10"/"c10").
func ambNormLine(s string) string {
	return strings.ToLower(strings.ReplaceAll(strings.TrimSpace(s), "-", ""))
}

// startAmbVehiclesPoller follows AMB's live vehicle GPS when
// ARRIBO_AMB_VEHICLES=1 and AMB_API_KEY is set.
func startAmbVehiclesPoller() (stop func()) {
	if os.Getenv("ARRIBO_AMB_VEHICLES") != "1" {
		return func() {}
	}
	key := strings.TrimSpace(os.Getenv("AMB_API_KEY"))
	if key == "" {
		log.Printf("[AMB-GPS] ARRIBO_AMB_VEHICLES=1 but AMB_API_KEY is empty — off")
		return func() {}
	}
	p := &ambVehPoller{key: key}
	ambVehLive.Store(p)
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Add(1)
	go p.run(ctx, &wg)
	log.Printf("[AMB-GPS] polling %s every %s (ARRIBO_AMB_VEHICLES=1, font no oficial)", ambVehURL, ambVehGap)
	return func() {
		ambVehLive.CompareAndSwap(p, nil)
		cancel()
		wg.Wait()
	}
}

func (p *ambVehPoller) run(ctx context.Context, wg *sync.WaitGroup) {
	defer wg.Done()
	for {
		p.poll(ctx)
		if !movSleep(ctx, ambVehGap) {
			return
		}
	}
}

func (p *ambVehPoller) poll(ctx context.Context) {
	body, err := p.fetch(ctx)
	if err != nil {
		p.mu.Lock()
		p.lastErr = movErrText(err)
		p.mu.Unlock()
		return
	}
	v, err := parseJSON(body)
	if err != nil {
		p.mu.Lock()
		p.lastErr = "bad JSON"
		p.mu.Unlock()
		return
	}
	arr, _ := v.([]any)
	byLine := map[string][]ambVeh{}
	n := 0
	for _, raw := range arr {
		o, _ := raw.(*Obj)
		if o == nil {
			continue
		}
		line := jsString(o.Get("line"))
		if line == "" {
			continue
		}
		lat, err1 := strconv.ParseFloat(jsString(o.Get("latitude")), 64)
		lon, err2 := strconv.ParseFloat(jsString(o.Get("longitude")), 64)
		if err1 != nil || err2 != nil || (lat == 0 && lon == 0) {
			continue
		}
		k := ambNormLine(line)
		byLine[k] = append(byLine[k], ambVeh{
			Line:  line,
			Dir:   ambDirFromRoute(jsString(o.Get("routeId"))),
			Lat:   lat,
			Lon:   lon,
			VehID: jsString(o.Get("id")),
		})
		n++
	}
	now := time.Now()
	p.snap.Store(&ambVehSnapshot{At: now, ByLine: byLine})
	p.mu.Lock()
	p.lastOK = now
	p.lastErr = ""
	p.count = n
	p.mu.Unlock()
}

func (p *ambVehPoller) fetch(ctx context.Context) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ambVehURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-api-key", p.key)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", movUserAgent)
	res, err := ambVehHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, &httpStatusError{res.StatusCode}
	}
	return io.ReadAll(io.LimitReader(res.Body, 8<<20))
}

type httpStatusError struct{ code int }

func (e *httpStatusError) Error() string { return "HTTP " + strconv.Itoa(e.code) }

// ambDirFromRoute reads a trayecto (1/2) from a routeId's last digit
// (e.g. "11950002" -> 2). Unverified against the moventis trayecto numbering.
func ambDirFromRoute(routeID string) int {
	if routeID == "" {
		return 0
	}
	if d := routeID[len(routeID)-1]; d >= '0' && d <= '9' {
		return int(d - '0')
	}
	return 0
}

// movVehiclesWithAMB returns the followed lines' buses: AMB's real GPS for a
// line while it has it (measured), the estimated buses for the rest. Used by
// both the map (/api/moventis) and the line view.
func movVehiclesWithAMB(s *movStatic, lineIDs []int, preds map[[3]int]movPrediction, now time.Time) []any {
	est := movEstimate(s, lineIDs, preds, now)
	if s == nil {
		return est
	}
	p := ambVehLive.Load()
	if p == nil {
		return est
	}
	snap := p.snap.Load()
	if snap == nil || now.Sub(snap.At) > ambVehMaxAge {
		return est
	}
	covered := map[string]bool{}
	var measured []any
	for _, id := range lineIDs {
		line := s.Lines[id]
		if line.Code == "" {
			continue
		}
		vs := snap.ByLine[ambNormLine(line.Code)]
		if len(vs) == 0 {
			continue
		}
		covered[line.Code] = true
		for _, v := range vs {
			measured = append(measured, ambVehicleJSON(s, id, line, v, snap.At, now))
		}
	}
	if len(measured) == 0 {
		return est
	}
	out := make([]any, 0, len(est)+len(measured))
	for _, e := range est {
		if o, _ := e.(*Obj); o == nil || !covered[jsString(o.Get("lineCode"))] {
			out = append(out, e)
		}
	}
	return append(out, measured...)
}

// ambVehicleJSON is one AMB bus in the shape movVehicleJSON uses, but with
// measured GPS instead of an estimated position.
func ambVehicleJSON(s *movStatic, id int, line movLine, v ambVeh, at, now time.Time) *Obj {
	code := line.Code
	if code == "" {
		code = numToString(float64(id))
	}
	var rt *movRoute
	for i := range s.Routes[id] {
		if s.Routes[id][i].Trayecto == v.Dir {
			rt = &s.Routes[id][i]
			break
		}
	}
	dest := ""
	bearing := 0.0
	dirID := v.Dir
	if rt != nil {
		dest = rt.Dest
		bearing = movBearingNear(*rt, v.Lat, v.Lon)
		dirID = movDirectionOf(s.Routes[id], rt.Trayecto)
	}
	ageSec := now.Sub(at).Seconds()
	return O(
		"id", "AMB_MOV_"+code+"_"+v.VehID,
		"agencyId", movAgencyID,
		"mode", "bus",
		"lineId", float64(id),
		"lineCode", code,
		"lineRef", movAgencyID+":"+code,
		"lineName", strOrNil(line.Name),
		"color", strOrNil(line.Color),
		"textColor", strOrNil(line.TextColor),
		"direction", numToString(float64(dirID)),
		"directionId", numToString(float64(dirID)),
		"destination", strOrNil(dest),
		"lat", jsRound(v.Lat*1e6)/1e6, "lon", jsRound(v.Lon*1e6)/1e6,
		"latitude", jsRound(v.Lat*1e6)/1e6, "longitude", jsRound(v.Lon*1e6)/1e6,
		"bearing", jsRound(bearing),
		"vehicleRef", strOrNil(v.VehID),
		"stopName", nil,
		"currentStatus", "IN_TRANSIT_TO",
		// Measured GPS from the AMB feed, not a prediction.
		"isEstimated", false,
		"isRealTime", true,
		"isTheoretical", false,
		"positionSource", "operator_gps",
		"predictionAgeSec", jsRound(ageSec),
		"delayMins", nil,
		"stale", ageSec > ambVehMaxAge.Seconds(),
	)
}

// movBearingNear is the route heading at the stop nearest (lat, lon).
func movBearingNear(rt movRoute, lat, lon float64) float64 {
	if len(rt.Stops) < 2 {
		return 0
	}
	best, bd := 0, 1e18
	for i, st := range rt.Stops {
		d := (st.Lat-lat)*(st.Lat-lat) + (st.Lon-lon)*(st.Lon-lon)
		if d < bd {
			bd, best = d, i
		}
	}
	a := rt.Stops[best]
	b := rt.Stops[best]
	if best+1 < len(rt.Stops) {
		b = rt.Stops[best+1]
	} else if best > 0 {
		a = rt.Stops[best-1]
	}
	return bearing(a.Lat, a.Lon, b.Lat, b.Lon)
}

// anyMeasured reports whether any vehicle in the list carries measured GPS
// (isRealTime), used to mark a mixed Moventis/AMB line honestly.
func anyMeasured(vs []any) bool {
	for _, v := range vs {
		if o, _ := v.(*Obj); o != nil && truthy(o.Get("isRealTime")) {
			return true
		}
	}
	return false
}

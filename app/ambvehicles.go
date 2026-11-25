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
	"encoding/json"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	ambVehURL      = "https://api.ambmobilitat.cat/v2/bus/vehicles"
	ambVehGap      = 20 * time.Second
	ambVehMaxAge   = 90 * time.Second // live GPS cutoff: older than this switches to dead-reckoning estimate
	ambVehCarryMax = 10 * time.Minute // keep extrapolating from last live GPS up to this long between pings
	ambVehSaveGap  = 40 * time.Second // throttle disk snapshots of tracked buses
	ambDedupKm     = 2.5              // suppress Moventis stop-prediction estimate within this radius of an AMB bus
)

// ambVeh is one bus of a followed line, from /bus/vehicles.
type ambVeh struct {
	Line       string    `json:"line"`
	Dir        int       `json:"dir"` // routeId's last digit (1/2); the moventis trayecto
	Lat        float64   `json:"lat"`
	Lon        float64   `json:"lon"`
	VehID      string    `json:"vehId"`
	ObservedAt time.Time `json:"observedAt"` // when AMB last returned this vehicle (zero falls back to snap.At)
	SpeedKmh   float64   `json:"speedKmh,omitempty"`
}

type ambTrackedVeh struct {
	Veh      ambVeh    `json:"veh"`
	MoveAt   time.Time `json:"moveAt"`
	MoveLat  float64   `json:"moveLat"`
	MoveLon  float64   `json:"moveLon"`
	SpeedKmh float64   `json:"speedKmh,omitempty"`
}

type ambTrackedFile struct {
	SavedAt time.Time                 `json:"savedAt"`
	Tracked map[string]*ambTrackedVeh `json:"tracked"`
}

type ambVehSnapshot struct {
	At     time.Time
	ByLine map[string][]ambVeh // keyed by ambNormLine(line)
}

type ambVehPoller struct {
	key       string
	cachePath string

	mu       sync.Mutex
	lastErr  string
	lastOK   time.Time
	lastSave time.Time
	count    int
	tracked  map[string]*ambTrackedVeh // keyed by ambNormLine(line)+"\x00"+vehID

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
	cachePath := ""
	if dir := movCacheDir(); dir != "" {
		cachePath = filepath.Join(dir, "amb_tracked.json")
	}
	p := &ambVehPoller{key: key, cachePath: cachePath}
	if loaded := p.loadTracked(time.Now()); loaded > 0 {
		log.Printf("[AMB-GPS] restored %d tracked vehicles from %s", loaded, cachePath)
	}
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
		p.saveTracked(time.Now(), true)
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
		msg := movErrText(err)
		p.mu.Lock()
		changed := p.lastErr != msg
		p.lastErr = msg
		p.mu.Unlock()
		if changed && ctx.Err() == nil {
			log.Printf("[AMB-GPS] poll failed: %s", msg)
		}
		return
	}
	v, err := parseJSON(body)
	if err != nil {
		p.mu.Lock()
		changed := p.lastErr != "bad JSON"
		p.lastErr = "bad JSON"
		p.mu.Unlock()
		if changed {
			log.Printf("[AMB-GPS] poll failed: bad JSON")
		}
		return
	}
	arr, _ := v.([]any)
	now := time.Now()
	var fresh []ambVeh
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
		fresh = append(fresh, ambVeh{
			Line:       line,
			Dir:        ambDirFromRoute(jsString(o.Get("routeId"))),
			Lat:        lat,
			Lon:        lon,
			VehID:      jsString(o.Get("id")),
			ObservedAt: now,
		})
	}
	byLine := p.mergeAndSnapshot(fresh, now)
	p.snap.Store(&ambVehSnapshot{At: now, ByLine: byLine})
	p.saveTracked(now, false)
	if bg := busGapsLive.Load(); bg != nil {
		obsMs := float64(now.UnixMilli())
		for _, v := range fresh {
			if v.VehID == "" {
				continue
			}
			ag, code := classifyAmbVehicleAgency(v.Line)
			stopName := nearestStopNameForBus(ag, code, v.Lat, v.Lon)
			dirStr := ""
			if v.Dir > 0 {
				dirStr = strconv.Itoa(v.Dir)
			}
			bg.observeGPS(ag, v.VehID, code, dirStr, stopName, v.Lat, v.Lon, obsMs)
		}
	}
	p.mu.Lock()
	recovered := p.lastErr != ""
	p.lastOK = now
	p.lastErr = ""
	p.count = len(fresh)
	p.mu.Unlock()
	if recovered {
		log.Printf("[AMB-GPS] recovered (%d vehicles)", len(fresh))
	}
}

// mergeAndSnapshot updates tracked vehicles with a fresh poll and keeps
// previously seen buses alive for up to ambVehCarryMax so intermittent drops
// in AMB's /bus/vehicles cache (e.g. Casas buses pinging every 1–5 min) can
// continue smoothly via route-snapped dead-reckoning instead of vanishing.
func (p *ambVehPoller) mergeAndSnapshot(fresh []ambVeh, now time.Time) map[string][]ambVeh {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.tracked == nil {
		p.tracked = map[string]*ambTrackedVeh{}
	}
	for _, v := range fresh {
		k := ambNormLine(v.Line)
		id := v.VehID
		if id == "" {
			id = fmtCoordKey(v.Lat, v.Lon)
		}
		tk := k + "\x00" + id
		obsAt := v.ObservedAt
		if obsAt.IsZero() {
			obsAt = now
		}
		v.ObservedAt = obsAt
		if prev, ok := p.tracked[tk]; ok {
			dKm := haversineKm(prev.MoveLat, prev.MoveLon, v.Lat, v.Lon)
			dt := obsAt.Sub(prev.MoveAt).Seconds()
			if dKm > 0.025 && dt >= 5 && dt <= 600 {
				inst := dKm / (dt / 3600)
				if inst >= 8 && inst <= 80 {
					if prev.SpeedKmh > 0 {
						prev.SpeedKmh = 0.5*prev.SpeedKmh + 0.5*inst
					} else {
						prev.SpeedKmh = inst
					}
				}
				prev.MoveAt = obsAt
				prev.MoveLat = v.Lat
				prev.MoveLon = v.Lon
			} else if dKm > 0.005 {
				prev.MoveAt = obsAt
				prev.MoveLat = v.Lat
				prev.MoveLon = v.Lon
			}
			v.SpeedKmh = prev.SpeedKmh
			prev.Veh = v
		} else {
			p.tracked[tk] = &ambTrackedVeh{
				Veh:     v,
				MoveAt:  obsAt,
				MoveLat: v.Lat,
				MoveLon: v.Lon,
			}
		}
	}
	byLine := map[string][]ambVeh{}
	for tk, tv := range p.tracked {
		if now.Sub(tv.Veh.ObservedAt) > ambVehCarryMax {
			delete(p.tracked, tk)
			continue
		}
		k := ambNormLine(tv.Veh.Line)
		byLine[k] = append(byLine[k], tv.Veh)
	}
	return byLine
}

// loadTracked restores unexpired AMB-tracked vehicles from disk so container
// restarts/deploys do not lose in-flight buses during GPS dropouts.
func (p *ambVehPoller) loadTracked(now time.Time) int {
	if p == nil || p.cachePath == "" {
		return 0
	}
	b, err := os.ReadFile(p.cachePath)
	if err != nil {
		return 0
	}
	var f ambTrackedFile
	if err := json.Unmarshal(b, &f); err != nil || len(f.Tracked) == 0 {
		return 0
	}
	p.mu.Lock()
	if p.tracked == nil {
		p.tracked = map[string]*ambTrackedVeh{}
	}
	byLine := map[string][]ambVeh{}
	restored := 0
	for tk, tv := range f.Tracked {
		if tv == nil || tv.Veh.Line == "" || tv.Veh.ObservedAt.IsZero() {
			continue
		}
		age := now.Sub(tv.Veh.ObservedAt)
		if age < 0 || age > ambVehCarryMax {
			continue
		}
		p.tracked[tk] = tv
		k := ambNormLine(tv.Veh.Line)
		byLine[k] = append(byLine[k], tv.Veh)
		restored++
	}
	p.mu.Unlock()
	if restored > 0 {
		p.snap.Store(&ambVehSnapshot{At: now, ByLine: byLine})
	}
	return restored
}

// saveTracked atomically persists unexpired AMB-tracked vehicles to disk.
func (p *ambVehPoller) saveTracked(now time.Time, force bool) {
	if p == nil || p.cachePath == "" {
		return
	}
	p.mu.Lock()
	if !force && now.Sub(p.lastSave) < ambVehSaveGap {
		p.mu.Unlock()
		return
	}
	cp := make(map[string]*ambTrackedVeh, len(p.tracked))
	for tk, tv := range p.tracked {
		if tv == nil || now.Sub(tv.Veh.ObservedAt) > ambVehCarryMax {
			continue
		}
		dup := *tv
		cp[tk] = &dup
	}
	p.lastSave = now
	p.mu.Unlock()

	if err := os.MkdirAll(filepath.Dir(p.cachePath), 0o755); err != nil {
		return
	}
	raw, err := json.Marshal(ambTrackedFile{SavedAt: now, Tracked: cp})
	if err != nil {
		return
	}
	tmp := p.cachePath + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, p.cachePath)
}

func fmtCoordKey(lat, lon float64) string {
	return strconv.FormatFloat(lat, 'f', 4, 64) + "," + strconv.FormatFloat(lon, 'f', 4, 64)
}

func haversineKm(lat1, lon1, lat2, lon2 float64) float64 {
	const earthKm = 6371.0
	dLat := (lat2 - lat1) * math.Pi / 180
	dLon := (lon2 - lon1) * math.Pi / 180
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*math.Pi/180)*math.Cos(lat2*math.Pi/180)*math.Sin(dLon/2)*math.Sin(dLon/2)
	return 2 * earthKm * math.Asin(math.Min(1, math.Sqrt(a)))
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

// movVehiclesWithAMB returns the followed lines' buses: AMB's real GPS (or
// route-snapped dead-reckoning continuation from its last GPS) per
// (line, direction), falling back to moventis.es estimated buses for any
// line or direction AMB does not cover.
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
	type ambPt struct{ lat, lon float64 }
	ambCoords := map[[2]string][]ambPt{}
	var ambOut []any
	for _, id := range lineIDs {
		line := s.Lines[id]
		if line.Code == "" {
			continue
		}
		vs := snap.ByLine[ambNormLine(line.Code)]
		if len(vs) == 0 {
			continue
		}
		for _, v := range vs {
			obj := ambVehicleJSON(s, id, line, v, snap.At, now)
			if obj == nil {
				continue
			}
			key := [2]string{line.Code, jsString(obj.Get("directionId"))}
			ambCoords[key] = append(ambCoords[key], ambPt{lat: obj.Num("lat"), lon: obj.Num("lon")})
			ambOut = append(ambOut, obj)
		}
	}
	if len(ambOut) == 0 {
		return est
	}
	out := make([]any, 0, len(est)+len(ambOut))
	for _, e := range est {
		o, _ := e.(*Obj)
		if o == nil {
			out = append(out, e)
			continue
		}
		key := [2]string{jsString(o.Get("lineCode")), jsString(o.Get("directionId"))}
		pts := ambCoords[key]
		if len(pts) == 0 {
			out = append(out, e)
			continue
		}
		elat, elon := o.Num("lat"), o.Num("lon")
		dup := false
		for _, pt := range pts {
			if haversineKm(elat, elon, pt.lat, pt.lon) <= ambDedupKm {
				dup = true
				break
			}
		}
		if !dup {
			out = append(out, e)
		}
	}
	return append(out, ambOut...)
}

// ambVehicleJSON builds one AMB bus in the shape movVehicleJSON uses. When
// AMB reported the bus within ambVehMaxAge it is emitted as measured GPS
// (isRealTime: true, positionSource: "operator_gps"). If AMB temporarily
// dropped it between pings (up to ambVehCarryMax), it is projected forward
// along the matched route from its last GPS position and marked honestly as
// estimated (isEstimated: true, positionSource: "gps_extrapolated"). Returns
// nil if the bus expired or its projection passed the terminus.
func ambVehicleJSON(s *movStatic, id int, line movLine, v ambVeh, snapAt, now time.Time) *Obj {
	obsAt := v.ObservedAt
	if obsAt.IsZero() {
		obsAt = snapAt
	}
	age := now.Sub(obsAt)
	if age > ambVehCarryMax {
		return nil
	}
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
	lat, lon := v.Lat, v.Lon
	bearingVal := 0.0
	dirID := v.Dir
	if rt != nil {
		dest = rt.Dest
		bearingVal = movBearingNear(*rt, lat, lon)
		dirID = movDirectionOf(s.Routes[id], rt.Trayecto)
	}

	isLive := age <= ambVehMaxAge
	posSource := "operator_gps"
	if !isLive {
		// Extrapolate smoothly forward along the route from the last known GPS.
		if rt == nil || len(rt.Stops) < 2 {
			return nil
		}
		startKm, ok := movKmNear(*rt, v.Lat, v.Lon)
		if !ok {
			return nil
		}
		speedKmh := v.SpeedKmh
		if speedKmh <= 0 {
			speedKmh = movDefaultSpeedKmh
		}
		speedKmh = math.Max(12, math.Min(55, speedKmh))
		// Subtract a small 20 s buffer so we don't jump ahead the instant a ping lags.
		advanceSec := math.Max(0, age.Seconds()-20)
		projKm := startKm + speedKmh*(advanceSec/3600)
		endKm := rt.Stops[len(rt.Stops)-1].Km
		if projKm > endKm+0.25 {
			return nil // projected past terminus: trip finished
		}
		if projKm > endKm {
			projKm = endKm
		}
		lat, lon, bearingVal = movAt(*rt, projKm)
		posSource = "gps_extrapolated"
	}

	ageSec := math.Max(0, age.Seconds())
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
		"lat", jsRound(lat*1e6)/1e6, "lon", jsRound(lon*1e6)/1e6,
		"latitude", jsRound(lat*1e6)/1e6, "longitude", jsRound(lon*1e6)/1e6,
		"bearing", jsRound(bearingVal),
		"vehicleRef", strOrNil(v.VehID),
		"stopName", nil,
		"currentStatus", "IN_TRANSIT_TO",
		"isEstimated", !isLive,
		"isRealTime", isLive,
		"isTheoretical", false,
		"positionSource", posSource,
		"predictionAgeSec", jsRound(ageSec),
		"delayMins", nil,
		"stale", false,
	)
}

// movKmNear projects (lat, lon) onto the route's stop polyline and returns
// the cumulative km along the route. Returns ok=false if the bus is > 2 km
// off the route.
func movKmNear(rt movRoute, lat, lon float64) (float64, bool) {
	if len(rt.Stops) < 2 {
		return 0, false
	}
	cosLat := math.Cos(lat * math.Pi / 180)
	bestDist2 := 1e18
	bestKm := rt.Stops[0].Km
	for i := 1; i < len(rt.Stops); i++ {
		a, b := rt.Stops[i-1], rt.Stops[i]
		ax, ay := (a.Lon-lon)*cosLat*111.32, (a.Lat-lat)*110.57
		bx, by := (b.Lon-lon)*cosLat*111.32, (b.Lat-lat)*110.57
		dx, dy := bx-ax, by-ay
		l2 := dx*dx + dy*dy
		t := 0.0
		if l2 > 0 {
			t = math.Max(0, math.Min(1, -(ax*dx+ay*dy)/l2))
		}
		px, py := ax+t*dx, ay+t*dy
		d2 := px*px + py*py
		if d2 < bestDist2 {
			bestDist2 = d2
			bestKm = a.Km + t*(b.Km-a.Km)
		}
	}
	if bestDist2 > 4.0 { // > 2 km away from route
		return 0, false
	}
	return bestKm, true
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

// ambCatalogRouteIndex maps normalized AMB line codes to their GTFS catalog
// metadata (canonical code, name, color, textColor) for O(1) lookups when
// emitting hundreds of live AMB metropolitan buses.
func ambCatalogRouteIndex(op *rtCatalogOp) map[string]rtRoute {
	if op == nil || len(op.Lines) == 0 {
		return nil
	}
	idx := make(map[string]rtRoute, len(op.Lines))
	for _, r := range op.Lines {
		if r.Code == "" {
			continue
		}
		idx[ambNormLine(r.Code)] = r
	}
	return idx
}

// ambDirToGTFS maps AMB's routeId last digit (1/2) to GTFS direction_id (0/1).
// Returns "" when unknown.
func ambDirToGTFS(dir int) string {
	switch dir {
	case 1:
		return "0"
	case 2:
		return "1"
	default:
		return ""
	}
}

// ambBearingNearProfile estimates the road heading near (lat, lon) using the
// AMB GTFS line profile's geometry (or stop sequence).
func ambBearingNearProfile(d *rtLineDirection, lat, lon float64) float64 {
	if d == nil {
		return 0
	}
	if len(d.Geometry) >= 2 {
		best, bd := 0, 1e18
		for i, pt := range d.Geometry {
			dist := (pt[0]-lat)*(pt[0]-lat) + (pt[1]-lon)*(pt[1]-lon)
			if dist < bd {
				bd, best = dist, i
			}
		}
		a, b := d.Geometry[best], d.Geometry[best]
		if best+1 < len(d.Geometry) {
			b = d.Geometry[best+1]
		} else if best > 0 {
			a = d.Geometry[best-1]
		}
		return bearing(a[0], a[1], b[0], b[1])
	}
	if len(d.Stops) >= 2 {
		best, bd := 0, 1e18
		for i, st := range d.Stops {
			dist := (st.Lat-lat)*(st.Lat-lat) + (st.Lon-lon)*(st.Lon-lon)
			if dist < bd {
				bd, best = dist, i
			}
		}
		a, b := d.Stops[best], d.Stops[best]
		if best+1 < len(d.Stops) {
			b = d.Stops[best+1]
		} else if best > 0 {
			a = d.Stops[best-1]
		}
		return bearing(a.Lat, a.Lon, b.Lat, b.Lon)
	}
	return 0
}

// ambCatalogVehicleJSON formats one live AMB metropolitan bus (Badalona,
// Barcelona, L'Hospitalet, Baix Llobregat, Aerobús, NitBus, etc.) for both
// /api/moventis (homepage network map) and /api/line/amb:<code> (single-line
// view). Only fresh live GPS pings (age <= ambVehMaxAge) are emitted.
func ambCatalogVehicleJSON(v ambVeh, snapAt, now time.Time, op *rtCatalogOp, routeIdx map[string]rtRoute) *Obj {
	obsAt := v.ObservedAt
	if obsAt.IsZero() {
		obsAt = snapAt
	}
	age := now.Sub(obsAt)
	if age < 0 {
		age = 0
	}
	if age > ambVehMaxAge {
		return nil
	}

	norm := ambNormLine(v.Line)
	code := strings.TrimSpace(v.Line)
	lineName := ""
	color := "#007a5a"
	textColor := "#ffffff"
	inCatalog := false
	if r, ok := routeIdx[norm]; ok {
		inCatalog = true
		if r.Code != "" {
			code = r.Code
		}
		lineName = r.Name
		if r.Color != "" {
			color = r.Color
		}
		if r.TextColor != "" {
			textColor = r.TextColor
		}
	}

	dirStr := ambDirToGTFS(v.Dir)
	dest := ""
	bearingVal := 0.0
	if op != nil && op.Profiles != nil {
		if prof := op.Profiles[code]; prof != nil {
			var sel *rtLineDirection
			for i := range prof.Directions {
				d := &prof.Directions[i]
				if dirStr != "" && strconv.Itoa(d.DirectionID) == dirStr {
					sel = d
					break
				}
			}
			if sel == nil && len(prof.Directions) > 0 {
				sel = &prof.Directions[0]
			}
			if sel != nil {
				dest = sel.Headsign
				bearingVal = ambBearingNearProfile(sel, v.Lat, v.Lon)
			}
		}
	}

	vehID := v.VehID
	if vehID == "" {
		vehID = fmtCoordKey(v.Lat, v.Lon)
	}
	var lineRef any
	if inCatalog {
		lineRef = ambAgencyID + ":" + code
	}
	ageSec := jsRound(age.Seconds())
	return O(
		"id", "AMB_BUS_"+code+"_"+vehID,
		"agencyId", ambAgencyID,
		"agency", ambOperator.Name,
		"mode", "bus",
		"vehicleId", vehID,
		"vehicleRef", vehID,
		"label", code+"-"+vehID,
		"lineId", ambAgencyID+":"+code,
		"lineCode", code,
		"lineRef", lineRef,
		"lineName", strOrNil(lineName),
		"color", color,
		"textColor", textColor,
		"direction", strOrNil(dirStr),
		"directionId", strOrNil(dirStr),
		"destination", strOrNil(dest),
		"lat", jsRound(v.Lat*1e6)/1e6, "lon", jsRound(v.Lon*1e6)/1e6,
		"latitude", jsRound(v.Lat*1e6)/1e6, "longitude", jsRound(v.Lon*1e6)/1e6,
		"bearing", jsRound(bearingVal),
		"stopName", nil,
		"currentStatus", "IN_TRANSIT_TO",
		"isEstimated", false,
		"isRealTime", true,
		"isTheoretical", false,
		"isGhostVehicle", false,
		"positionSource", "operator_gps",
		"predictionAgeSec", ageSec,
		"ageSec", ageSec,
		"delayMins", nil,
		"stale", false,
		"attribution", ambAttribution,
	)
}

// ambCatalogVehicles returns all live GPS AMB metropolitan buses (excluding
// Moventis-followed lines already emitted by movVehiclesWithAMB), optionally
// filtered to box.
func ambCatalogVehicles(now time.Time, box *trainBox) []any {
	p := ambVehLive.Load()
	if p == nil {
		return nil
	}
	snap := p.snap.Load()
	if snap == nil || now.Sub(snap.At) > ambVehMaxAge {
		return nil
	}
	movNorms := map[string]bool{}
	if mp := movLive.Load(); mp != nil {
		if ms := mp.snap.Load(); ms != nil && ms.Static != nil {
			for _, id := range ms.Lines {
				if l, ok := ms.Static.Lines[id]; ok && l.Code != "" {
					movNorms[ambNormLine(l.Code)] = true
				}
			}
		}
	}
	var op *rtCatalogOp
	if v, ok := rtCatalog.Load(ambAgencyID); ok {
		op = v.(*rtCatalogOp)
	}
	routeIdx := ambCatalogRouteIndex(op)

	keys := make([]string, 0, len(snap.ByLine))
	for k := range snap.ByLine {
		if !movNorms[k] {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)

	var out []any
	for _, k := range keys {
		for _, v := range snap.ByLine[k] {
			if !box.has(v.Lat, v.Lon) {
				continue
			}
			if obj := ambCatalogVehicleJSON(v, snap.At, now, op, routeIdx); obj != nil {
				out = append(out, obj)
			}
		}
	}
	return out
}

// ambLineBuses returns the live GPS buses for one AMB line (e.g. B25, M30, A1)
// in the single-line view (/api/line/amb:<code>).
func ambLineBuses(code, direction string, now time.Time) (buses []any, stale int) {
	buses = []any{}
	p := ambVehLive.Load()
	if p == nil {
		return buses, 0
	}
	snap := p.snap.Load()
	if snap == nil || now.Sub(snap.At) > ambVehMaxAge {
		return buses, 0
	}
	vs := snap.ByLine[ambNormLine(code)]
	if len(vs) == 0 {
		return buses, 0
	}
	var op *rtCatalogOp
	if v, ok := rtCatalog.Load(ambAgencyID); ok {
		op = v.(*rtCatalogOp)
	}
	routeIdx := ambCatalogRouteIndex(op)
	for _, v := range vs {
		dirStr := ambDirToGTFS(v.Dir)
		if direction != "both" && direction != "" && dirStr != "" && dirStr != direction {
			continue
		}
		obsAt := v.ObservedAt
		if obsAt.IsZero() {
			obsAt = snap.At
		}
		if now.Sub(obsAt) > ambVehMaxAge {
			stale++
			continue
		}
		if obj := ambCatalogVehicleJSON(v, snap.At, now, op, routeIdx); obj != nil {
			buses = append(buses, obj)
		}
	}
	return buses, stale
}

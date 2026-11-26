package main

// Estimated positions for Moventis buses from the arrival predictions the
// poller collects (moventis.go). Along a route, in stop order, each sampled
// stop says when its next tracked bus arrives. Stops a bus has already
// passed show the following bus, so going along the route the countdown
// grows while the stops lie ahead of one bus and drops where they start to
// lie ahead of the next: a bus sits just before every stop where the
// countdown drops (and before the first sampled stop). Its distance back
// from that stop is the countdown at the route's speed, never behind the
// previous sampled stop. Positions move between requests as the countdowns
// run down. Nothing here is observed: every bus says isEstimated, its
// source, and how old the prediction behind it is.

import (
	"errors"
	"math"
	"net/url"
	"sort"
	"sync"
	"time"
)

const (
	movDefaultSpeedKmh = 22.0
	movPassedTolSec    = 60.0 // a bus predicted up to a minute ago may still be at the stop
	movDropSec         = 30.0 // a countdown must drop by this much to mark another bus
	movMaxApproachKm   = 0.3  // a bus estimated this far before the route's start is not shown
)

// movSnapshot is what the server reads: the static data and predictions as
// of the last answer, and the poller's state.
type movSnapshot struct {
	Static  *movStatic
	Preds   map[[3]int]movPrediction
	Lines   []int
	Stats   movStats
	Backoff time.Duration
	Until   time.Time
}

// publish stores the current state for the server world.
func (p *movPoller) publish(now time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	preds := make(map[[3]int]movPrediction, len(p.preds))
	for k, v := range p.preds {
		preds[k] = v
	}
	p.snap.Store(&movSnapshot{Static: p.static, Preds: preds, Lines: append([]int(nil), p.lineIDs...), Stats: p.stats, Backoff: p.backoff, Until: p.until})
}

type movPoint struct {
	stop movStop
	t    float64 // seconds until the next tracked bus, now
	age  float64 // seconds since the prediction was observed
}

// movEstimate is the estimated buses of the followed lines at now.
func movEstimate(s *movStatic, lineIDs []int, preds map[[3]int]movPrediction, now time.Time) []any {
	out := []any{}
	if s == nil {
		return out
	}
	for _, id := range lineIDs {
		line := s.Lines[id]
		for _, rt := range s.Routes[id] {
			pts := movRoutePoints(rt, preds, now)
			if len(pts) == 0 {
				continue
			}
			v := movRouteSpeed(pts)
			var prev *movPoint
			for i := range pts {
				pt := &pts[i]
				if prev == nil || pt.t < prev.t-movDropSec {
					km := pt.stop.Km - pt.t/3600*v
					if prev == nil {
						if km < rt.Stops[0].Km-movMaxApproachKm {
							prev = pt
							continue // not on the route yet (not departed)
						}
						km = math.Max(km, rt.Stops[0].Km)
					} else {
						km = math.Min(math.Max(km, prev.stop.Km), pt.stop.Km)
					}
					b := movVehicleJSON(line, rt, pt, km, now)
					b.Set("directionId", numToString(float64(movDirectionOf(s.Routes[id], rt.Trayecto))))
					out = append(out, b)
				}
				prev = pt
			}
		}
	}
	return out
}

// movRoutePoints is the route's sampled stops with a usable prediction, in
// route order, each with the countdown of its next tracked bus at now.
func movRoutePoints(rt movRoute, preds map[[3]int]movPrediction, now time.Time) []movPoint {
	var pts []movPoint
	for _, st := range rt.Stops {
		pr, ok := preds[[3]int{rt.LineID, rt.Trayecto, st.ID}]
		if !ok {
			continue
		}
		age := now.Sub(pr.At).Seconds()
		if age > movObsMaxAge.Seconds() || age < -5 {
			continue
		}
		t := math.NaN()
		for _, e := range pr.EtaSec {
			if left := e - age; left >= -movPassedTolSec {
				t = math.Max(left, 0)
				break
			}
		}
		if math.IsNaN(t) {
			continue
		}
		pts = append(pts, movPoint{stop: st, t: t, age: age})
	}
	return pts
}

// movRouteSpeed is the route's bus speed (km/h) from consecutive sampled
// stops whose countdowns grow (the same bus reaching one after the other):
// the median of plausible values, else movDefaultSpeedKmh.
func movRouteSpeed(pts []movPoint) float64 {
	var vs []float64
	for i := 1; i < len(pts); i++ {
		dt := pts[i].t - pts[i-1].t
		dkm := pts[i].stop.Km - pts[i-1].stop.Km
		if dt > 30 && dkm > 0.2 {
			if v := dkm / (dt / 3600); v >= 8 && v <= 70 {
				vs = append(vs, v)
			}
		}
	}
	if len(vs) == 0 {
		return movDefaultSpeedKmh
	}
	sort.Float64s(vs)
	return vs[len(vs)/2]
}

// movAt is the position at km along the route (between its stops) and the
// heading there: on the Generalitat road shape when one fits the route,
// else on the straight line between the two stops.
func movAt(rt movRoute, km float64) (lat, lon, bearing float64) {
	st := rt.Stops
	for i := 1; i < len(st); i++ {
		a, b := st[i-1], st[i]
		if km <= b.Km || i == len(st)-1 {
			f := 0.0
			if b.Km > a.Km {
				f = math.Min(math.Max((km-a.Km)/(b.Km-a.Km), 0), 1)
			}
			if len(rt.Shape) >= 2 && len(rt.ShapeAlong) == len(st) {
				// Along the road: the same share of the way between the two
				// stops, measured on the Generalitat shape.
				m := rt.ShapeAlong[i-1] + f*(rt.ShapeAlong[i]-rt.ShapeAlong[i-1])
				return movShapeAt(rt.Shape, rt.ShapeCum, m)
			}
			lat = a.Lat + (b.Lat-a.Lat)*f
			lon = a.Lon + (b.Lon-a.Lon)*f
			y := math.Sin((b.Lon-a.Lon)*math.Pi/180) * math.Cos(b.Lat*math.Pi/180)
			x := math.Cos(a.Lat*math.Pi/180)*math.Sin(b.Lat*math.Pi/180) - math.Sin(a.Lat*math.Pi/180)*math.Cos(b.Lat*math.Pi/180)*math.Cos((b.Lon-a.Lon)*math.Pi/180)
			bearing = math.Mod(math.Atan2(y, x)*180/math.Pi+360, 360)
			return
		}
	}
	return st[0].Lat, st[0].Lon, 0
}

func movVehicleJSON(line movLine, rt movRoute, pt *movPoint, km float64, now time.Time) *Obj {
	lat, lon, bearing := movAt(rt, km)
	code := line.Code
	if code == "" {
		code = numToString(float64(rt.LineID))
	}
	return O(
		"id", "EST_MOV_"+numToString(float64(rt.LineID))+"_"+numToString(float64(rt.Trayecto))+"_"+numToString(float64(pt.stop.ID)),
		"agencyId", movAgencyID,
		"mode", "bus",
		"lineId", float64(rt.LineID),
		"lineCode", code,
		"lineRef", movAgencyID+":"+code,
		"lineName", strOrNil(line.Name),
		"color", strOrNil(line.Color),
		"textColor", strOrNil(line.TextColor),
		"direction", numToString(float64(rt.Trayecto)),
		"destination", strOrNil(rt.Dest),
		"lat", jsRound(lat*1e6)/1e6, "lon", jsRound(lon*1e6)/1e6,
		"latitude", jsRound(lat*1e6)/1e6, "longitude", jsRound(lon*1e6)/1e6,
		"bearing", jsRound(bearing),
		"stopName", strOrNil(pt.stop.Name),
		"nextStopEtaSec", jsRound(pt.t),
		"currentStatus", "IN_TRANSIT_TO",
		// The position is estimated from the operator's tracked arrival
		// predictions; it was not observed.
		"isEstimated", true,
		"isRealTime", false,
		"isTheoretical", false,
		"positionSource", "stop_predictions",
		"predictionAgeSec", jsRound(pt.age),
		"delayMins", nil,
		"stale", false,
	)
}

// movErrText is an error without the URL net/http puts in it.
func movErrText(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err.Error()
	}
	return err.Error()
}

// hMoventis serves /api/moventis: the followed Moventis lines, live regional
// and metropolitan buses (Moventis + AMB GPS + Sagalés GPS, optionally filtered
// to ?bbox=minLat,minLon,maxLat,maxLon) and the Moventis poller's state. No
// lock, no database: it reads the pollers' published snapshots.
func (s *Server) hMoventis(q *xreq, res *xres) error {
	p := movLive.Load()
	box := parseTrainBox(jsString(qv(q, "bbox")))
	now := time.Now()
	extraBuses := ambCatalogVehicles(now, box)
	extraBuses = append(extraBuses, sagalesAllVehicles(now, box)...)
	extraBuses = append(extraBuses, gironaAllVehicles(now, box)...)
	extraBuses = append(extraBuses, lleidaAllVehicles(now, box)...)
	extraBuses = append(extraBuses, reusAllVehicles(now, box)...)
	if p == nil && len(extraBuses) == 0 && ambVehLive.Load() == nil && sagalesLive.Load() == nil && gironaFleetLive.Load() == nil && lleidaFleetLive.Load() == nil && reusFleetLive.Load() == nil {
		res.json(O("success", true, "enabled", false, "lines", []any{}, "vehicles", []any{}))
		return nil
	}
	var snap *movSnapshot
	if p != nil {
		snap = p.snap.Load()
	}
	lines := []any{}
	vehicles := []any{}
	status := O("requests", 0.0)
	if snap != nil && snap.Static != nil {
		for _, v := range movVehiclesWithAMB(snap.Static, snap.Lines, snap.Preds, now) {
			if box != nil {
				if o, _ := v.(*Obj); o != nil && !box.has(o.Num("lat"), o.Num("lon")) {
					continue
				}
			}
			vehicles = append(vehicles, v)
		}
	}
	vehicles = append(vehicles, extraBuses...)
	if snap != nil {
		for _, id := range snap.Lines {
			if snap.Static == nil {
				break
			}
			l := snap.Static.Lines[id]
			routes := []any{}
			for _, rt := range snap.Static.Routes[id] {
				routes = append(routes, O("trayecto", float64(rt.Trayecto), "desc", rt.Desc, "dest", rt.Dest, "stops", float64(len(rt.Stops))))
			}
			lines = append(lines, O("id", float64(id), "code", strOrNil(l.Code), "name", strOrNil(l.Name), "color", strOrNil(l.Color),
				"textColor", strOrNil(l.TextColor), "lineRef", movAgencyID+":"+l.Code, "routes", routes))
		}
		// The live counters (a short lock on the poller, no database).
		p.mu.Lock()
		st, until, bo := p.stats, p.until, p.backoff
		p.mu.Unlock()
		backoff := 0.0
		if until.After(now) && bo > 0 {
			backoff = math.Round(until.Sub(now).Seconds())
		}
		var lastOK any
		if !st.LastOK.IsZero() {
			lastOK = float64(st.LastOK.UnixMilli())
		}
		status = O("requests", float64(st.Requests), "throttled", float64(st.Throttled), "errors", float64(st.Errors),
			"lastOkAt", lastOK, "lastError", strOrNil(st.LastError), "backoffSec", backoff,
			"sampledStops", float64(st.SampledStops), "askedStops", float64(st.AskedStops), "skippedStops", float64(st.SkippedStops),
			"lastCycleSec", st.LastCycleSec,
			"requestGapSec", movMinGap.Seconds(), "staticAt", movStaticAt(snap.Static))
	}
	hours := clampHours(qv(q, "hours"), 24, 168)
	var delaysObj any
	if p != nil && p.delays != nil && jsString(qv(q, "includeDelays")) != "false" {
		var st *movStatic
		if snap != nil {
			st = snap.Static
		}
		delaysObj = cachedMovDelayReport(p.delays, hours, now, st)
	}
	res.json(O("success", true, "enabled", true, "agencyId", movAgencyID, "mode", "bus",
		"attribution", movAttributionText(),
		"bbox", boxJSON(box),
		"positionsEstimated", true, "lines", lines, "vehicles", vehicles, "status", status, "delays", delaysObj))
	return nil
}

func movStaticAt(s *movStatic) any {
	if s == nil {
		return nil
	}
	return float64(s.FetchedAt.UnixMilli())
}

type movDelayReportCacheEnt struct {
	at   time.Time
	data any
}

var (
	movDelayReportCacheMu sync.Mutex
	movDelayReportCache   = map[float64]movDelayReportCacheEnt{}
)

func cachedMovDelayReport(t *movDelayTracker, hours float64, now time.Time, st *movStatic) any {
	movDelayReportCacheMu.Lock()
	if ent, ok := movDelayReportCache[hours]; ok && now.Sub(ent.at) < 60*time.Second {
		movDelayReportCacheMu.Unlock()
		return ent.data
	}
	movDelayReportCacheMu.Unlock()
	data := t.reportWithStatic(hours, now, st)
	movDelayReportCacheMu.Lock()
	movDelayReportCache[hours] = movDelayReportCacheEnt{at: now, data: data}
	movDelayReportCacheMu.Unlock()
	return data
}

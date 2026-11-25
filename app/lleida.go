package main

// Autobusos de Lleida (Moventis, moventis_lleida, NAP 1579):
//   - Static GTFS (NAP 1579) provides all 14 urban routes (1..10, 16, 20, 70, N1),
//     shapes, stops (whose GTFS stop_id equals Moventis ID_PARADA), and timetables.
//   - Live second-precision stop predictions come from moventis.es
//     /api/json/GetTiemposParada/ca/{stopID}/{movLineID}/0, which returns ALL
//     Lleida lines serving that stop in a single response!
//   - Shares movLive's polite pacing/backoff when movPoller is active (respecting
//     moventis.es Crawl-delay: 10), and polls a minimal greedy set-cover of ~6-8
//     central Lleida hub stops (1 stop every 45 s) to estimate live bus positions
//     on both the homepage network map and single-line view, plus live stop
//     departures and in-memory /dades punctuality vs GTFS schedule (noHistory: true).

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	lleidaAttribution   = "Moventis Autobusos de Lleida · Previsions en temps real (font no oficial)"
	lleidaCacheTTL      = 60 * time.Second
	lleidaCacheMax      = 256
	lleidaHubPollStep   = 45 * time.Second
	lleidaObsMaxAge     = 7 * time.Minute
	lleidaCommercialKmh = 15.0
	lleidaDedupKm       = 0.45
)

// lleidaMovLineID maps Lleida GTFS route_short_name -> Moventis ID_LINEA
// (from moventis.es/es/moventis/ca/lines, ID_ZONA=2, ID_SUBZONA=1).
var lleidaMovLineID = map[string]int{
	"1":  129,
	"2":  130,
	"3":  131,
	"4":  132,
	"5":  133,
	"6":  134,
	"7":  135,
	"8":  136,
	"9":  137,
	"10": 138,
	"16": 713,
	"20": 332,
	"70": 628,
	"N1": 717,
}

var lleidaCodeByMovID = func() map[int]string {
	m := make(map[int]string, len(lleidaMovLineID))
	for code, id := range lleidaMovLineID {
		m[id] = code
	}
	return m
}()

type lleidaArrival struct {
	LineCode string
	Headsign string
	EtaSec   float64
	RealTime bool
}

type lleidaStopCacheEntry struct {
	at       time.Time
	arrivals []lleidaArrival
}

var lleidaStopCache = struct {
	mu      sync.Mutex
	entries map[string]lleidaStopCacheEntry
	until   time.Time // fallback rate limiter when movLive is nil
}{entries: map[string]lleidaStopCacheEntry{}}

// parseLleidaStopTimes decodes Moventis GetTiemposParada JSON into per-line
// arrivals for Lleida urban lines, returning errMovThrottled on placeholder "A".
func parseLleidaStopTimes(body []byte) ([]lleidaArrival, error) {
	var rows []struct {
		IDLinea   any `json:"idLinea"`
		Trayectos any `json:"trayectos"`
	}
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, err
	}
	var out []lleidaArrival
	throttled := false
	for _, r := range rows {
		if s, ok := r.IDLinea.(string); ok {
			if strings.EqualFold(strings.TrimSpace(s), "A") {
				throttled = true
				continue
			}
		}
		var movID int
		switch v := r.IDLinea.(type) {
		case float64:
			movID = int(v)
		case string:
			movID, _ = strconv.Atoi(strings.TrimSpace(v))
		}
		code, ok := lleidaCodeByMovID[movID]
		if !ok {
			continue
		}
		trMap, ok := r.Trayectos.(map[string]any)
		if !ok {
			continue
		}
		for headsign, rawList := range trMap {
			list, ok := rawList.([]any)
			if !ok {
				continue
			}
			for _, item := range list {
				obj, ok := item.(map[string]any)
				if !ok {
					continue
				}
				minStr, _ := obj["minutos"].(string)
				realStr, _ := obj["real"].(string)
				if strings.EqualFold(strings.TrimSpace(minStr), "A") || strings.EqualFold(strings.TrimSpace(realStr), "A") {
					throttled = true
					continue
				}
				etaSec, ok := parseMovDuration(minStr)
				if !ok || etaSec < 0 || etaSec > 7200 {
					continue
				}
				out = append(out, lleidaArrival{
					LineCode: code,
					Headsign: strings.TrimSpace(headsign),
					EtaSec:   etaSec,
					RealTime: strings.EqualFold(strings.TrimSpace(realStr), "S"),
				})
			}
		}
	}
	if throttled && len(out) == 0 {
		return nil, errMovThrottled
	}
	return out, nil
}

// parseMovDuration parses Moventis Spanish/Catalan ETA strings like
// "19 min 54 s", "01 h 00 min 54 s", "54 s", "Imminent" -> seconds.
func parseMovDuration(s string) (float64, bool) {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return 0, false
	}
	if strings.Contains(s, "imminent") || strings.Contains(s, "inminent") || s == "ara" || s == "< 1 min" {
		return 0, true
	}
	fields := strings.Fields(s)
	var total float64
	matched := false
	for i := 0; i < len(fields); i++ {
		n, err := strconv.Atoi(fields[i])
		if err != nil {
			continue
		}
		if i+1 < len(fields) {
			unit := fields[i+1]
			switch {
			case strings.HasPrefix(unit, "h"):
				total += float64(n * 3600)
				matched = true
				i++
			case strings.HasPrefix(unit, "min"):
				total += float64(n * 60)
				matched = true
				i++
			case unit == "s" || strings.HasPrefix(unit, "seg"):
				total += float64(n)
				matched = true
				i++
			}
		}
	}
	return total, matched
}

func fetchLleidaStopTimes(ctx context.Context, stopID string, movLineID int, interactive bool, now time.Time) ([]lleidaArrival, time.Time, bool) {
	if stopID == "" || movLineID <= 0 {
		return nil, time.Time{}, false
	}
	lleidaStopCache.mu.Lock()
	if e, hit := lleidaStopCache.entries[stopID]; hit && now.Sub(e.at) <= lleidaCacheTTL {
		arr, at := e.arrivals, e.at
		lleidaStopCache.mu.Unlock()
		return arr, at, true
	}
	lleidaStopCache.mu.Unlock()

	path := fmt.Sprintf("/api/json/GetTiemposParada/ca/%s/%d/0", stopID, movLineID)
	var body []byte
	var err error
	if p := movLive.Load(); p != nil {
		if interactive {
			body, err = p.getInteractive(ctx, path)
		} else {
			body, err = p.get(ctx, path)
		}
		if err != nil {
			return nil, time.Time{}, false
		}
	} else {
		lleidaStopCache.mu.Lock()
		wait := time.Until(lleidaStopCache.until)
		lleidaStopCache.mu.Unlock()
		if wait > 0 {
			select {
			case <-ctx.Done():
				return nil, time.Time{}, false
			case <-time.After(wait):
			}
		}
		req, rerr := http.NewRequestWithContext(ctx, http.MethodGet, movBase+path, nil)
		if rerr != nil {
			return nil, time.Time{}, false
		}
		req.Header.Set("User-Agent", movUserAgent)
		req.Header.Set("Accept", "application/json")
		resp, derr := movHTTP.Do(req)
		lleidaStopCache.mu.Lock()
		lleidaStopCache.until = time.Now().Add(movMinGap)
		lleidaStopCache.mu.Unlock()
		if derr != nil {
			return nil, time.Time{}, false
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, time.Time{}, false
		}
		body, err = io.ReadAll(io.LimitReader(resp.Body, 2<<20))
		if err != nil {
			return nil, time.Time{}, false
		}
	}

	arr, err := parseLleidaStopTimes(body)
	if err != nil {
		if err == errMovThrottled {
			if p := movLive.Load(); p != nil {
				p.throttled()
			}
		}
		return nil, time.Time{}, false
	}
	lleidaStopCache.mu.Lock()
	if len(lleidaStopCache.entries) >= lleidaCacheMax {
		for k, v := range lleidaStopCache.entries {
			if now.Sub(v.at) > lleidaCacheTTL {
				delete(lleidaStopCache.entries, k)
			}
		}
		if len(lleidaStopCache.entries) >= lleidaCacheMax {
			lleidaStopCache.entries = map[string]lleidaStopCacheEntry{}
		}
	}
	lleidaStopCache.entries[stopID] = lleidaStopCacheEntry{at: now, arrivals: arr}
	lleidaStopCache.mu.Unlock()
	return arr, now, true
}

// Shared read-only GTFS timetable handle cache for computing honest schedule-vs-live
// delays for live prediction feeds (Lleida, Girona) into in-memory /dades.
var liveTimetables railTimetables

func recordScheduleLiveDelay(ctx context.Context, agencyID, lineCode, stopID, stopName string, dir int, expected, now time.Time) {
	if agencyID == "" || lineCode == "" || stopID == "" {
		return
	}
	tt, err := liveTimetables.get(agencyID)
	if err != nil || tt == nil {
		return
	}
	qctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	deps, err := tt.departures(qctx, lineCode, stopID, dir, now)
	if err != nil || len(deps) == 0 {
		return
	}
	expUnix := expected.Unix()
	bestIdx := -1
	bestAbs := int64(1 << 60)
	for i, d := range deps {
		diff := expUnix - d.DepartUnix
		if diff < 0 {
			diff = -diff
		}
		if diff < bestAbs {
			bestAbs = diff
			bestIdx = i
		}
	}
	if bestIdx < 0 || bestAbs > 20*60 {
		return
	}
	// Cap match tolerance at half the local headway so frequent lines never
	// attribute a bus to the previous or next scheduled trip.
	if len(deps) >= 2 {
		headway := int64(20 * 60)
		if bestIdx > 0 {
			if h := deps[bestIdx].DepartUnix - deps[bestIdx-1].DepartUnix; h > 0 && h < headway {
				headway = h
			}
		}
		if bestIdx+1 < len(deps) {
			if h := deps[bestIdx+1].DepartUnix - deps[bestIdx].DepartUnix; h > 0 && h < headway {
				headway = h
			}
		}
		if bestAbs > headway/2+90 {
			return
		}
	}
	delaySec := int32(expUnix - deps[bestIdx].DepartUnix)
	tripKey := fmt.Sprintf("%s\x00%d\x00%s", lineCode, deps[bestIdx].DepartUnix, stopID)
	liveDelaysLive.record(agencyID, lineCode, stopName, tripKey, delaySec, now)
}

// lleidaLiveDepartures returns live Moventis predictions for a Lleida stop;
// returns nil so the caller falls back to the GTFS timetable when unavailable.
func lleidaLiveDepartures(ctx context.Context, stop rtLineStop, lineCode, direction string, now time.Time) *Obj {
	if os.Getenv("ARRIBO_MOVENTIS_ALL") != "1" {
		return nil
	}
	movID, ok := lleidaMovLineID[strings.ToUpper(strings.TrimSpace(lineCode))]
	if !ok || stop.ID == "" {
		return nil
	}
	arrs, _, ok := fetchLleidaStopTimes(ctx, stop.ID, movID, true, now)
	if !ok || len(arrs) == 0 {
		return nil
	}
	var matching []lleidaArrival
	hasLive := false
	for _, a := range arrs {
		if !strings.EqualFold(a.LineCode, lineCode) {
			continue
		}
		matching = append(matching, a)
		if a.RealTime {
			hasLive = true
		}
	}
	if !hasLive {
		return nil
	}
	sort.Slice(matching, func(i, j int) bool { return matching[i].EtaSec < matching[j].EtaSec })
	deps := make([]any, 0, len(matching))
	for _, a := range matching {
		exp := now.Add(time.Duration(a.EtaSec) * time.Second)
		hhmm := exp.In(madrid).Format("15:04")
		minsAway := math.Floor(a.EtaSec / 60.0)
		status, badge := "scheduled", "Horari"
		var src any = nil
		if a.RealTime {
			status, badge, src = "live", "Temps real", "moventis_lleida_unofficial"
		}
		deps = append(deps, O(
			"tripId", nil,
			"vehicleId", nil,
			"destination", strOrNil(a.Headsign),
			"direction", strOrNil(direction),
			"departureTime", hhmm,
			"scheduledTime", hhmm,
			"aimedIso", isoString(exp.UnixMilli()),
			"expectedIso", isoString(exp.UnixMilli()),
			"minutesAway", minsAway,
			"delayMins", nil,
			"delayMinutes", nil,
			"delayStatus", status,
			"delayBadgeText", badge,
			"delaySource", src,
			"delayDiscarded", false,
			"isRealTime", a.RealTime,
			"isEstimated", false,
			"isTheoretical", !a.RealTime,
			"isCancelled", false,
			"unofficial", true,
			"platform", nil,
			"platformSource", nil,
			"platformChanged", false,
			"scheduledPlatform", nil,
		))
	}
	return O(
		"stop", O("id", stop.ID, "name", stop.Name, "lat", stop.Lat, "lon", stop.Lon, "agencyId", movLleidaAgencyID),
		"departures", deps,
		"windowMinutes", float64(railDepWindowSec/60),
		"source", "moventis_lleida_unofficial",
		"unofficial", true,
		"attribution", lleidaAttribution,
	)
}

// lleidaHubObs stores one stop's most recent Moventis GetTiemposParada snapshot.
type lleidaHubObs struct {
	stopID   string
	at       time.Time
	arrivals []lleidaArrival
}

type lleidaFleetSnap struct {
	at       time.Time
	vehicles []*Obj
}

var (
	lleidaFleetLive atomic.Pointer[lleidaFleetSnap]
	lleidaObsState  = struct {
		mu    sync.Mutex
		byStp map[string]lleidaHubObs
	}{byStp: map[string]lleidaHubObs{}}
)

// lleidaEstimateLineBuses back-projects live ("real":"S") Moventis Lleida stop
// ETAs onto each direction's GTFS stops (advancing by elapsed observation age)
// and deduplicates nearby estimates within lleidaDedupKm.
func lleidaEstimateLineBuses(route rtRoute, prof *rtLineProfile, direction string, obs map[string]lleidaHubObs, now time.Time) []*Obj {
	if prof == nil || len(prof.Directions) == 0 || len(obs) == 0 {
		return nil
	}
	ref := movLleidaAgencyID + ":" + route.Code
	color := route.Color
	if color == "" {
		color = "#007a5a"
	}
	textColor := route.TextColor
	if textColor == "" {
		textColor = "#FFFFFF"
	}

	type cand struct {
		dir     *rtLineDirection
		stopIdx int
		etaSec  float64
		ageSec  float64
		busKm   float64
	}
	var out []*Obj
	for di := range prof.Directions {
		d := &prof.Directions[di]
		dirStr := strconv.Itoa(d.DirectionID)
		if direction != "both" && direction != "" && dirStr != direction {
			continue
		}
		if len(d.Stops) == 0 {
			continue
		}
		cum := tmbCumKm(d.Stops)
		var cands []cand
		for si, st := range d.Stops {
			o, ok := obs[st.ID]
			if !ok {
				continue
			}
			ageSec := now.Sub(o.at).Seconds()
			if ageSec < 0 || ageSec > lleidaObsMaxAge.Seconds() {
				continue
			}
			for _, a := range o.arrivals {
				if !a.RealTime || !strings.EqualFold(a.LineCode, route.Code) {
					continue
				}
				remSec := a.EtaSec - ageSec
				if remSec < -30 || remSec > 30*60 {
					continue
				}
				if remSec < 0 {
					remSec = 0
				}
				backKm := (remSec / 3600.0) * lleidaCommercialKmh
				busKm := cum[si] - backKm
				if busKm < 0 {
					busKm = 0
				}
				cands = append(cands, cand{dir: d, stopIdx: si, etaSec: remSec, ageSec: ageSec, busKm: busKm})
			}
		}
		sort.Slice(cands, func(i, j int) bool { return cands[i].etaSec < cands[j].etaSec })
		var kept []cand
		for _, c := range cands {
			dup := false
			for _, k := range kept {
				if math.Abs(c.busKm-k.busKm) <= lleidaDedupKm {
					dup = true
					break
				}
			}
			if !dup {
				kept = append(kept, c)
			}
		}
		for idx, c := range kept {
			lat, lon, brg, nextIdx := tmbInterpolateStops(d.Stops, cum, c.busKm)
			status := "IN_TRANSIT_TO"
			if c.etaSec <= 25 {
				status = "STOPPED_AT"
				nextIdx = c.stopIdx
				lat = d.Stops[c.stopIdx].Lat
				lon = d.Stops[c.stopIdx].Lon
			}
			nextStop := d.Stops[nextIdx]
			vid := fmt.Sprintf("EST_%s_%d", dirStr, idx+1)
			out = append(out, O(
				"id", "LLEIDA_BUS_"+route.Code+"_"+vid,
				"agencyId", movLleidaAgencyID,
				"agency", "Moventis Lleida",
				"mode", "bus",
				"vehicleId", vid,
				"vehicleRef", vid,
				"label", route.Code+"-"+vid,
				"lineId", ref,
				"lineCode", route.Code,
				"lineRef", ref,
				"lineName", strOrNil(route.Name),
				"color", color,
				"textColor", textColor,
				"direction", dirStr,
				"directionId", dirStr,
				"destination", strOrNil(d.Headsign),
				"lat", jsRound(lat*1e6)/1e6, "lon", jsRound(lon*1e6)/1e6,
				"latitude", jsRound(lat*1e6)/1e6, "longitude", jsRound(lon*1e6)/1e6,
				"bearing", jsRound(brg),
				"stopId", strOrNil(nextStop.ID),
				"stopName", strOrNil(nextStop.Name),
				"toStop", strOrNil(nextStop.Name),
				"nextStopEtaSec", jsRound(c.etaSec),
				"currentStatus", status,
				"isEstimated", true,
				"isRealTime", false,
				"isTheoretical", false,
				"isGhostVehicle", false,
				"unofficial", true,
				"positionSource", "moventis_lleida_predictions",
				"predictionAgeSec", jsRound(c.ageSec),
				"delayMins", nil,
				"stale", false,
				"attribution", lleidaAttribution,
			))
		}
	}
	return out
}

type lleidaHubStop struct {
	stopID    string
	stopName  string
	movLineID int
}

// lleidaPickHubStops chooses a minimal greedy set-cover of central Lleida
// stops that together serve every known Lleida line (typically 5-7 stops).
func lleidaPickHubStops(op *rtCatalogOp) []lleidaHubStop {
	if op == nil || op.Profiles == nil {
		return nil
	}
	stopLines := map[string]map[string]bool{}
	stopNames := map[string]string{}
	stopAnyMovID := map[string]int{}
	uncovered := map[string]bool{}
	for _, r := range op.Lines {
		code := strings.ToUpper(strings.TrimSpace(r.Code))
		movID, ok := lleidaMovLineID[code]
		if !ok {
			continue
		}
		prof := op.Profiles[r.Code]
		if prof == nil {
			continue
		}
		uncovered[code] = true
		for _, d := range prof.Directions {
			// Prefer middle-of-route stops (not terminals) so approaching buses have positive ETAs.
			start, end := 1, len(d.Stops)-1
			if end <= start {
				start, end = 0, len(d.Stops)
			}
			for i := start; i < end; i++ {
				st := d.Stops[i]
				if st.ID == "" {
					continue
				}
				if stopLines[st.ID] == nil {
					stopLines[st.ID] = map[string]bool{}
				}
				stopLines[st.ID][code] = true
				if stopNames[st.ID] == "" {
					stopNames[st.ID] = st.Name
				}
				if stopAnyMovID[st.ID] == 0 {
					stopAnyMovID[st.ID] = movID
				}
			}
		}
	}
	var hubs []lleidaHubStop
	for len(uncovered) > 0 && len(hubs) < 10 {
		bestStop := ""
		bestGain := 0
		for sid, lines := range stopLines {
			gain := 0
			for code := range lines {
				if uncovered[code] {
					gain++
				}
			}
			if gain > bestGain || (gain == bestGain && gain > 0 && sid < bestStop) {
				bestGain = gain
				bestStop = sid
			}
		}
		if bestStop == "" || bestGain == 0 {
			break
		}
		hubs = append(hubs, lleidaHubStop{
			stopID:    bestStop,
			stopName:  stopNames[bestStop],
			movLineID: stopAnyMovID[bestStop],
		})
		for code := range stopLines[bestStop] {
			delete(uncovered, code)
		}
	}
	return hubs
}

func startLleidaPoller() (stop func()) {
	if os.Getenv("ARRIBO_MOVENTIS_ALL") != "1" {
		return func() {}
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		select {
		case <-ctx.Done():
			return
		case <-time.After(15 * time.Second):
		}
		var hubs []lleidaHubStop
		idx := 0
		for {
			v, ok := rtCatalog.Load(movLleidaAgencyID)
			if ok {
				op := v.(*rtCatalogOp)
				if len(hubs) == 0 {
					hubs = lleidaPickHubStops(op)
				}
				if len(hubs) > 0 {
					hub := hubs[idx%len(hubs)]
					idx++
					pctx, pcancel := context.WithTimeout(ctx, 20*time.Second)
					arrs, at, fetched := fetchLleidaStopTimes(pctx, hub.stopID, hub.movLineID, false, time.Now())
					if fetched {
						now := time.Now()
						lleidaObsState.mu.Lock()
						lleidaObsState.byStp[hub.stopID] = lleidaHubObs{stopID: hub.stopID, at: at, arrivals: arrs}
						for k, o := range lleidaObsState.byStp {
							if now.Sub(o.at) > lleidaObsMaxAge {
								delete(lleidaObsState.byStp, k)
							}
						}
						obsCopy := make(map[string]lleidaHubObs, len(lleidaObsState.byStp))
						for k, o := range lleidaObsState.byStp {
							obsCopy[k] = o
						}
						lleidaObsState.mu.Unlock()

						// Record live vs GTFS timetable delays into /dades (in-memory only).
						scoredLine := map[string]bool{}
						for _, a := range arrs {
							if !a.RealTime || scoredLine[a.LineCode] {
								continue
							}
							scoredLine[a.LineCode] = true
							recordScheduleLiveDelay(pctx, movLleidaAgencyID, a.LineCode, hub.stopID, hub.stopName, -1, at.Add(time.Duration(a.EtaSec)*time.Second), now)
						}

						// Rebuild estimated fleet across all Lleida lines.
						var vehicles []*Obj
						for _, r := range op.Lines {
							if prof := op.Profiles[r.Code]; prof != nil {
								vehicles = append(vehicles, lleidaEstimateLineBuses(r, prof, "both", obsCopy, now)...)
							}
						}
						lleidaFleetLive.Store(&lleidaFleetSnap{at: now, vehicles: vehicles})
					}
					pcancel()
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(lleidaHubPollStep):
			}
		}
	}()
	log.Printf("[Lleida] background hub poller started (ARRIBO_MOVENTIS_ALL=1)")
	return func() {
		cancel()
		<-done
		lleidaFleetLive.Store(nil)
	}
}

// lleidaAllVehicles returns the latest estimated Autobusos de Lleida vehicles
// for /api/moventis?bbox=... on the homepage network map.
func lleidaAllVehicles(now time.Time, box *trainBox) []any {
	snap := lleidaFleetLive.Load()
	if snap == nil || len(snap.vehicles) == 0 || now.Sub(snap.at) > lleidaObsMaxAge {
		return nil
	}
	out := make([]any, 0, len(snap.vehicles))
	for _, o := range snap.vehicles {
		if box != nil && !box.has(o.Num("lat"), o.Num("lon")) {
			continue
		}
		out = append(out, o)
	}
	return out
}

// lleidaBusLineBuses returns estimated bus positions for a single opened Lleida
// line, reusing hub observations and fetching 1-2 mid-route stops interactively
// if the line has no recent observation yet.
func lleidaBusLineBuses(ctx context.Context, op *rtCatalogOp, code, direction string, now time.Time) []any {
	if os.Getenv("ARRIBO_MOVENTIS_ALL") != "1" || op == nil || op.Profiles == nil {
		return []any{}
	}
	prof := op.Profiles[code]
	if prof == nil || len(prof.Directions) == 0 {
		return []any{}
	}
	var route rtRoute
	for _, r := range op.Lines {
		if strings.EqualFold(r.Code, code) {
			route = r
			break
		}
	}
	if route.Code == "" {
		route.Code = code
	}

	lleidaObsState.mu.Lock()
	obsCopy := make(map[string]lleidaHubObs, len(lleidaObsState.byStp))
	for k, o := range lleidaObsState.byStp {
		if now.Sub(o.at) <= lleidaObsMaxAge {
			obsCopy[k] = o
		}
	}
	lleidaObsState.mu.Unlock()

	objs := lleidaEstimateLineBuses(route, prof, direction, obsCopy, now)
	if len(objs) == 0 {
		if movID, ok := lleidaMovLineID[strings.ToUpper(strings.TrimSpace(code))]; ok {
			for di := range prof.Directions {
				d := &prof.Directions[di]
				if len(d.Stops) == 0 {
					continue
				}
				mid := d.Stops[len(d.Stops)/2]
				if mid.ID == "" {
					continue
				}
				if arrs, at, fetched := fetchLleidaStopTimes(ctx, mid.ID, movID, true, now); fetched {
					obsCopy[mid.ID] = lleidaHubObs{stopID: mid.ID, at: at, arrivals: arrs}
					lleidaObsState.mu.Lock()
					lleidaObsState.byStp[mid.ID] = lleidaHubObs{stopID: mid.ID, at: at, arrivals: arrs}
					lleidaObsState.mu.Unlock()
				}
			}
			objs = lleidaEstimateLineBuses(route, prof, direction, obsCopy, now)
		}
	}
	out := make([]any, len(objs))
	for i, o := range objs {
		out[i] = o
	}
	return out
}

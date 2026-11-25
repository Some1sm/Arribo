package main

// Reus Transport (reus_transport):
//   - Static GTFS: official NAP feed 1788 (19 urban routes L10..L82, 184 stops;
//     valid through 2027-10-09; noHistory: true).
//   - Live stop predictions (unofficial web JSON used by reustransport.cat):
//       GET https://rtp.amersam.net/timetoarrival_real_time/{routeShort}/{stopId}
//     Returns {"timetoarrival": <minutes_or_"CONSULTEU HORARI">}.
//   - Background poller samples a few stops per line on a gentle 12 s step
//     so estimated live Reus buses appear on both the homepage network map and
//     single-line view, plus live stop departures and in-memory /dades delays.
//   - Opt-in with ARRIBO_REUS=1 (on in compose); requires NAP_API_KEY.

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
	reusAgencyID      = "reus_transport"
	reusNapStaticURL  = "https://nap.transportes.gob.es/api/Fichero/download/1788"
	reusLiveBaseURL   = "https://rtp.amersam.net/timetoarrival_real_time"
	reusAttribution   = "Reus Transport · Previsions en temps real (font no oficial)"
	reusCacheTTL      = 25 * time.Second
	reusCacheMax      = 512
	reusLineCacheMax  = 64
	reusSamplePerDir  = 4
	reusCommercialKmh = 14.0
	reusDedupKm       = 0.45
	reusPollStep      = 12 * time.Second
	reusLineMaxAge    = 5 * time.Minute
)

var reusOperator = operatorInfo{
	ID: reusAgencyID, Name: "Reus Transport", ShortName: "Reus",
	Mode: "bus", Tier: "predicted", Method: "operator_prediction",
	Source: "Previsions de pas publicades per rtp.amersam.net (font no oficial) i horaris oficials GTFS de Reus Transport (NAP 1788). Sense GPS.",
}

func reusSource() (rtSource, bool) {
	if os.Getenv("ARRIBO_REUS") != "1" {
		return rtSource{}, false
	}
	napKey := strings.TrimSpace(os.Getenv("NAP_API_KEY"))
	if napKey == "" {
		return rtSource{}, false
	}
	return rtSource{
		AgencyID:      reusAgencyID,
		Mode:          "bus",
		vehicleEvery:  time.Minute,
		tripEvery:     time.Minute,
		staticURL:     reusNapStaticURL,
		staticHeaders: map[string]string{"ApiKey": napKey},
		noHistory:     true,
	}, true
}

// reusNumericStopID extracts the numeric stop ID expected by rtp.amersam.net
// from a GTFS stop_id (e.g. "123" or "REU_123" -> "123").
func reusNumericStopID(stopID string) string {
	s := strings.TrimSpace(stopID)
	if idx := strings.LastIndexByte(s, '_'); idx >= 0 {
		s = s[idx+1:]
	}
	s = strings.TrimLeft(s, "0")
	if s == "" {
		return ""
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return ""
		}
	}
	return s
}

// parseReusETA parses {"timetoarrival": 5} or {"timetoarrival": "5"} or
// {"timetoarrival": "CONSULTEU HORARI"}. Returns (minutes, true) only for
// live numeric predictions.
func parseReusETA(body []byte) (int, bool) {
	var raw struct {
		TimeToArrival any `json:"timetoarrival"`
	}
	if err := json.Unmarshal(body, &raw); err != nil || raw.TimeToArrival == nil {
		return 0, false
	}
	switch v := raw.TimeToArrival.(type) {
	case float64:
		m := int(math.Round(v))
		if m >= 0 && m <= 120 {
			return m, true
		}
	case string:
		s := strings.TrimSpace(v)
		low := strings.ToLower(s)
		if low == "" || strings.Contains(low, "consulteu") || strings.Contains(low, "horari") {
			return 0, false
		}
		if strings.Contains(low, "imminent") || strings.Contains(low, "ara") || low == "<1" {
			return 0, true
		}
		s = strings.TrimSuffix(low, "min")
		s = strings.TrimSpace(s)
		if m, err := strconv.Atoi(s); err == nil && m >= 0 && m <= 120 {
			return m, true
		}
	}
	return 0, false
}

type reusCacheEntry struct {
	at   time.Time
	mins int
	live bool
}

var reusStopCache = struct {
	mu      sync.Mutex
	entries map[string]reusCacheEntry
}{entries: map[string]reusCacheEntry{}}

func fetchReusStopETA(ctx context.Context, lineCode, stopID string, now time.Time) (int, bool) {
	numID := reusNumericStopID(stopID)
	code := strings.ToUpper(strings.TrimSpace(lineCode))
	if code == "" || numID == "" {
		return 0, false
	}
	key := code + "|" + numID
	reusStopCache.mu.Lock()
	if e, hit := reusStopCache.entries[key]; hit && now.Sub(e.at) <= reusCacheTTL {
		m, live := e.mins, e.live
		reusStopCache.mu.Unlock()
		return m, live
	}
	reusStopCache.mu.Unlock()

	u := fmt.Sprintf("%s/%s/%s", reusLiveBaseURL, code, numID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, false
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; Arribo transit observatory)")
	req.Header.Set("Accept", "application/json")
	resp, err := rtHTTP.Do(req)
	if err != nil {
		return 0, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, false
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<10))
	if err != nil {
		return 0, false
	}
	mins, live := parseReusETA(body)
	reusStopCache.mu.Lock()
	if len(reusStopCache.entries) >= reusCacheMax {
		for k, v := range reusStopCache.entries {
			if now.Sub(v.at) > reusCacheTTL {
				delete(reusStopCache.entries, k)
			}
		}
		if len(reusStopCache.entries) >= reusCacheMax {
			reusStopCache.entries = map[string]reusCacheEntry{}
		}
	}
	reusStopCache.entries[key] = reusCacheEntry{at: now, mins: mins, live: live}
	reusStopCache.mu.Unlock()
	return mins, live
}

func reusLiveDepartures(ctx context.Context, stop rtLineStop, lineCode, direction string, now time.Time) *Obj {
	if os.Getenv("ARRIBO_REUS") != "1" || stop.ID == "" {
		return nil
	}
	mins, live := fetchReusStopETA(ctx, lineCode, stop.ID, now)
	if !live {
		return nil
	}
	exp := now.Add(time.Duration(mins) * time.Minute)
	hhmm := exp.In(madrid).Format("15:04")
	deps := []any{
		O(
			"tripId", nil,
			"vehicleId", nil,
			"destination", nil,
			"direction", strOrNil(direction),
			"departureTime", hhmm,
			"scheduledTime", hhmm,
			"aimedIso", isoString(exp.UnixMilli()),
			"expectedIso", isoString(exp.UnixMilli()),
			"minutesAway", float64(mins),
			"delayMins", nil,
			"delayMinutes", nil,
			"delayStatus", "live",
			"delayBadgeText", "Temps real",
			"delaySource", "reus_amersam_unofficial",
			"delayDiscarded", false,
			"isRealTime", true,
			"isEstimated", false,
			"isTheoretical", false,
			"isCancelled", false,
			"unofficial", true,
			"platform", nil,
			"platformSource", nil,
			"platformChanged", false,
			"scheduledPlatform", nil,
		),
	}
	return O(
		"stop", O("id", stop.ID, "name", stop.Name, "lat", stop.Lat, "lon", stop.Lon, "agencyId", reusAgencyID),
		"departures", deps,
		"windowMinutes", float64(railDepWindowSec/60),
		"source", "reus_amersam_unofficial",
		"unofficial", true,
		"attribution", reusAttribution,
	)
}

type reusLineCacheEntry struct {
	at    time.Time
	buses []any
}

var reusLineCache = struct {
	mu      sync.Mutex
	entries map[string]reusLineCacheEntry
}{entries: map[string]reusLineCacheEntry{}}

func reusEstimateLineBusesFromSamples(route rtRoute, prof *rtLineProfile, direction string, samples map[string]int, now time.Time) []any {
	buses := []any{}
	if prof == nil || len(prof.Directions) == 0 || len(samples) == 0 {
		return buses
	}
	ref := reusAgencyID + ":" + route.Code
	color := route.Color
	if color == "" {
		color = "#c8102e"
	}
	textColor := route.TextColor
	if textColor == "" {
		textColor = "#FFFFFF"
	}
	type cand struct {
		dir     *rtLineDirection
		stopIdx int
		etaMin  int
		busKm   float64
	}
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
			etaMin, ok := samples[st.ID]
			if !ok || etaMin < 0 || etaMin > 25 {
				continue
			}
			backKm := (float64(etaMin) / 60.0) * reusCommercialKmh
			busKm := cum[si] - backKm
			if busKm < 0 {
				busKm = 0
			}
			cands = append(cands, cand{dir: d, stopIdx: si, etaMin: etaMin, busKm: busKm})
		}
		sort.Slice(cands, func(i, j int) bool { return cands[i].etaMin < cands[j].etaMin })
		var kept []cand
		for _, c := range cands {
			dup := false
			for _, k := range kept {
				if math.Abs(c.busKm-k.busKm) <= reusDedupKm {
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
			if c.etaMin == 0 {
				status = "STOPPED_AT"
				nextIdx = c.stopIdx
				lat = d.Stops[c.stopIdx].Lat
				lon = d.Stops[c.stopIdx].Lon
			}
			nextStop := d.Stops[nextIdx]
			vid := fmt.Sprintf("EST_%s_%d", dirStr, idx+1)
			buses = append(buses, O(
				"id", "REUS_BUS_"+route.Code+"_"+vid,
				"agencyId", reusAgencyID,
				"agency", reusOperator.Name,
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
				"nextStopEtaSec", float64(c.etaMin*60),
				"currentStatus", status,
				"isEstimated", true,
				"isRealTime", false,
				"isTheoretical", false,
				"isGhostVehicle", false,
				"unofficial", true,
				"positionSource", "reus_stop_predictions",
				"predictionAgeSec", 0.0,
				"delayMins", nil,
				"stale", false,
				"attribution", reusAttribution,
			))
		}
	}
	return buses
}

func reusBusLineBuses(ctx context.Context, op *rtCatalogOp, code, direction string, now time.Time) []any {
	if os.Getenv("ARRIBO_REUS") != "1" || op == nil || op.Profiles == nil {
		return []any{}
	}
	prof := op.Profiles[code]
	if prof == nil || len(prof.Directions) == 0 {
		return []any{}
	}
	cacheKey := strings.ToUpper(strings.TrimSpace(code)) + "\x00" + direction
	reusLineCache.mu.Lock()
	if e, hit := reusLineCache.entries[cacheKey]; hit && now.Sub(e.at) <= reusCacheTTL {
		out := append([]any(nil), e.buses...)
		reusLineCache.mu.Unlock()
		return out
	}
	reusLineCache.mu.Unlock()

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

	var stopIDs []string
	seen := map[string]bool{}
	for i := range prof.Directions {
		d := &prof.Directions[i]
		dirStr := strconv.Itoa(d.DirectionID)
		if direction != "both" && direction != "" && dirStr != direction {
			continue
		}
		for _, idx := range tmbSampleStopIndices(len(d.Stops), reusSamplePerDir) {
			sid := d.Stops[idx].ID
			if sid != "" && !seen[sid] {
				seen[sid] = true
				stopIDs = append(stopIDs, sid)
			}
		}
	}
	if len(stopIDs) == 0 {
		return []any{}
	}

	samples := make(map[string]int, len(stopIDs))
	var smu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 3)
	for _, sid := range stopIDs {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				return
			}
			mins, live := fetchReusStopETA(ctx, route.Code, id, now)
			if !live {
				return
			}
			smu.Lock()
			samples[id] = mins
			smu.Unlock()
		}(sid)
	}
	wg.Wait()

	buses := reusEstimateLineBusesFromSamples(route, prof, direction, samples, now)
	for di := range prof.Directions {
		d := &prof.Directions[di]
		for _, st := range d.Stops {
			if mins, ok := samples[st.ID]; ok && mins >= 0 && mins <= 25 {
				recordScheduleLiveDelay(ctx, reusAgencyID, route.Code, st.ID, st.Name, d.DirectionID, now.Add(time.Duration(mins)*time.Minute), now)
			}
		}
	}

	reusLineCache.mu.Lock()
	if len(reusLineCache.entries) >= reusLineCacheMax {
		for k, v := range reusLineCache.entries {
			if now.Sub(v.at) > reusCacheTTL {
				delete(reusLineCache.entries, k)
			}
		}
		if len(reusLineCache.entries) >= reusLineCacheMax {
			reusLineCache.entries = map[string]reusLineCacheEntry{}
		}
	}
	reusLineCache.entries[cacheKey] = reusLineCacheEntry{at: now, buses: append([]any(nil), buses...)}
	reusLineCache.mu.Unlock()
	return buses
}

type reusFleetSnap struct {
	at       time.Time
	vehicles []*Obj
}

var reusFleetLive atomic.Pointer[reusFleetSnap]

func startReusPoller() (stop func()) {
	if os.Getenv("ARRIBO_REUS") != "1" {
		return func() {}
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		byLine := map[string]struct {
			at    time.Time
			buses []*Obj
		}{}
		idx := 0
		publish := func(now time.Time) {
			var out []*Obj
			for k, v := range byLine {
				if now.Sub(v.at) > reusLineMaxAge {
					delete(byLine, k)
					continue
				}
				out = append(out, v.buses...)
			}
			reusFleetLive.Store(&reusFleetSnap{at: now, vehicles: out})
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(14 * time.Second):
		}
		for {
			if v, ok := rtCatalog.Load(reusAgencyID); ok {
				op := v.(*rtCatalogOp)
				if len(op.Lines) > 0 {
					line := op.Lines[idx%len(op.Lines)]
					idx++
					pctx, pcancel := context.WithTimeout(ctx, 8*time.Second)
					raw := reusBusLineBuses(pctx, op, line.Code, "both", time.Now())
					pcancel()
					now := time.Now()
					objs := make([]*Obj, 0, len(raw))
					for _, item := range raw {
						if o, _ := item.(*Obj); o != nil {
							objs = append(objs, o)
						}
					}
					byLine[line.Code] = struct {
						at    time.Time
						buses []*Obj
					}{at: now, buses: objs}
					publish(now)
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(reusPollStep):
			}
		}
	}()
	log.Printf("[Reus] background bus estimator started (ARRIBO_REUS=1)")
	return func() {
		cancel()
		<-done
		reusFleetLive.Store(nil)
	}
}

func reusAllVehicles(now time.Time, box *trainBox) []any {
	snap := reusFleetLive.Load()
	if snap == nil || len(snap.vehicles) == 0 || now.Sub(snap.at) > reusLineMaxAge {
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

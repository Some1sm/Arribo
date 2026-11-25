package main

// TMB Barcelona — Metro (L1–L5, L9N/S, L10N/S, L11, FM) and TMB Bus
// (plan step 6.5):
//   - Static GTFS: api.tmb.cat/v1/static/datasets/gtfs.zip (daily refresh
//     through gtfsrefresh.go; errors never include URLs/keys).
//   - Metro live predictions: single-call api.tmb.cat/v1/itransit/metro/estacions
//     polled every 30 s (covers L1–L5, L11; L9/L10/FM fall back to GTFS).
//   - Bus live predictions: on-demand per-stop api.tmb.cat/v1/itransit/bus/parades/{code}
//     with a 20 s in-memory TTL cache (drops transit_namespace="amb" duplicates
//     when ARRIBO_AMB=1; falls back to GTFS on error or empty response).
//
// Licence (developer.tmb.cat):
//   - Always cite Transports Metropolitans de Barcelona (TMB) AND the date of
//     the last update (tmbAttributionWithDate).
//   - Do not alter or distort content.
//   - Opt-in with ARRIBO_TMB=1 (on in compose) and requires TMB_APP_ID and
//     TMB_APP_KEY in the environment (never logged or committed).

import (
	"context"
	"encoding/json"
	"math"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	tmbAgencyID         = "tmb"
	tmbBaseURL          = "https://api.tmb.cat/v1"
	tmbMetroEvery       = 30 * time.Second
	tmbMetroMaxAge      = 3 * time.Minute
	tmbBusCacheTTL      = 20 * time.Second
	tmbBusCacheMaxSize  = 512
	tmbBusLineCacheMax  = 128
	tmbBusSamplePerDir  = 6
	tmbBusCommercialKmh = 13.0   // Barcelona urban bus average commercial speed
	tmbBusMaxEtaSec     = 1200.0 // 20 min horizon for stop-prediction back-projection
	tmbAttributionBase  = "Transports Metropolitans de Barcelona (TMB)"
)

var tmbOperator = operatorInfo{
	ID: tmbAgencyID, Name: "TMB Metro i Bus", ShortName: "TMB",
	Mode: "metro", Tier: "predicted", Method: "operator_prediction",
	Source: "Previsions de pas en temps real (iTransit) de Transports Metropolitans de Barcelona per a Metro (L1–L5, L11) i Bus; L9/L10 i FM segons horari GTFS.",
}

type tmbArrival struct {
	Line       string
	Direction  string // "0" or "1" (derived from id_sentit: 1->"0", 2->"1")
	Dest       string
	ArriveMs   int64
	VehicleID  string // codi_servei (metro) or id_bus (bus)
	Track      string // codi_via (metro)
	Wheelchair *bool  // bus ramp status when present
}

type tmbMetroSnapshot struct {
	At       time.Time
	ServerMs int64
	// ByLineStation keys on uppercase lineCode + "\x00" + stationCode (e.g. "L1\x00111").
	ByLineStation map[string][]tmbArrival
}

func (s *tmbMetroSnapshot) fresh(now time.Time) bool {
	return s != nil && !s.At.IsZero() && now.Sub(s.At) <= tmbMetroMaxAge
}

// tmbMetroLive holds the latest iTransit Metro snapshot (written by the tmb poller).
var tmbMetroLive atomic.Pointer[tmbMetroSnapshot]

func tmbCredentials() (appID, appKey string, ok bool) {
	if os.Getenv("ARRIBO_TMB") != "1" {
		return "", "", false
	}
	appID = strings.TrimSpace(os.Getenv("TMB_APP_ID"))
	appKey = strings.TrimSpace(os.Getenv("TMB_APP_KEY"))
	return appID, appKey, appID != "" && appKey != ""
}

func tmbAuthedURL(base, path, appID, appKey string) string {
	return base + path + "?app_id=" + url.QueryEscape(appID) + "&app_key=" + url.QueryEscape(appKey)
}

func tmbSource() (rtSource, bool) {
	appID, appKey, ok := tmbCredentials()
	if !ok {
		return rtSource{}, false
	}
	return rtSource{
		AgencyID:     tmbAgencyID,
		Mode:         "metro",
		vehicleEvery: time.Minute,
		tripEvery:    time.Minute,
		staticURL:    tmbAuthedURL(tmbBaseURL, "/static/datasets/gtfs.zip", appID, appKey),
		tmbMetroURL:  tmbAuthedURL(tmbBaseURL, "/itransit/metro/estacions", appID, appKey),
		noHistory:    true,
	}, true
}

func tmbAttributionWithDate(at time.Time) string {
	if at.IsZero() {
		at = time.Now()
	}
	return tmbAttributionBase + " · Actualitzat " + at.In(madrid).Format("2006-01-02")
}

// tmbIsMetroCode reports whether a TMB route_short_name is a Metro or
// Funicular de Montjuïc line (as opposed to a TMB Bus line).
func tmbIsMetroCode(code string) bool {
	switch strings.ToUpper(strings.TrimSpace(code)) {
	case "L1", "L2", "L3", "L4", "L5", "L9N", "L9S", "L10N", "L10S", "L11", "FM":
		return true
	default:
		return false
	}
}

// routeModeFor returns the canonical mode ("rail", "metro", "tram", "bus")
// for one line of an operator, distinguishing TMB Metro from TMB Bus.
func routeModeFor(info operatorInfo, code string) string {
	if info.ID == tmbAgencyID {
		if tmbIsMetroCode(code) {
			return "metro"
		}
		return "bus"
	}
	return info.Mode
}

// tmbMetroStationCode extracts the iTransit codi_estacio from a TMB GTFS stop_id
// (e.g. "1.111" -> "111", "P.6660111" -> "").
func tmbMetroStationCode(stopID string) string {
	if !strings.HasPrefix(stopID, "1.") {
		return ""
	}
	code := strings.TrimPrefix(stopID, "1.")
	if code == "" || strings.Contains(code, ".") {
		return ""
	}
	return code
}

// tmbBusStopCode extracts the iTransit codi_parada from a TMB GTFS bus stop_id
// (e.g. "2.108.680249" -> "108", "2.108" -> "108").
func tmbBusStopCode(stopID string) string {
	if !strings.HasPrefix(stopID, "2.") {
		return ""
	}
	rest := strings.TrimPrefix(stopID, "2.")
	if dot := strings.IndexByte(rest, '.'); dot >= 0 {
		rest = rest[:dot]
	}
	if rest == "" {
		return ""
	}
	return rest
}

func tmbDirectionCode(sentit int) string {
	if sentit == 2 {
		return "1"
	}
	return "0"
}

// parseTmbMetro parses api.tmb.cat/v1/itransit/metro/estacions JSON.
func parseTmbMetro(body []byte, now time.Time) (*tmbMetroSnapshot, error) {
	var raw struct {
		Timestamp int64 `json:"timestamp"`
		Linies    []struct {
			NomLinia  string `json:"nom_linia"`
			Estacions []struct {
				CodiEstacio int `json:"codi_estacio"`
				CodiVia     int `json:"codi_via"`
				IDSentit    int `json:"id_sentit"`
				Trajectes   []struct {
					NomLinia      string `json:"nom_linia"`
					DestiTrajecte string `json:"desti_trajecte"`
					PropersTrens  []struct {
						TempsArribada int64  `json:"temps_arribada"`
						CodiServei    string `json:"codi_servei"`
					} `json:"propers_trens"`
				} `json:"linies_trajectes"`
			} `json:"estacions"`
		} `json:"linies"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}
	byLS := map[string][]tmbArrival{}
	for _, l := range raw.Linies {
		for _, e := range l.Estacions {
			if e.CodiEstacio <= 0 {
				continue
			}
			stCode := strconv.Itoa(e.CodiEstacio)
			via := ""
			if e.CodiVia > 0 {
				via = strconv.Itoa(e.CodiVia)
			}
			dir := tmbDirectionCode(e.IDSentit)
			for _, tr := range e.Trajectes {
				line := strings.TrimSpace(tr.NomLinia)
				if line == "" {
					line = strings.TrimSpace(l.NomLinia)
				}
				if line == "" {
					continue
				}
				key := strings.ToUpper(line) + "\x00" + stCode
				for _, pt := range tr.PropersTrens {
					if pt.TempsArribada <= 0 {
						continue
					}
					byLS[key] = append(byLS[key], tmbArrival{
						Line:      line,
						Direction: dir,
						Dest:      strings.TrimSpace(tr.DestiTrajecte),
						ArriveMs:  pt.TempsArribada,
						VehicleID: strings.TrimSpace(pt.CodiServei),
						Track:     via,
					})
				}
			}
		}
	}
	for k := range byLS {
		arr := byLS[k]
		sort.Slice(arr, func(i, j int) bool { return arr[i].ArriveMs < arr[j].ArriveMs })
		byLS[k] = arr
	}
	return &tmbMetroSnapshot{At: now, ServerMs: raw.Timestamp, ByLineStation: byLS}, nil
}

// parseTmbBusStop parses api.tmb.cat/v1/itransit/bus/parades/{code} JSON.
// When skipAmb is true, entries with transit_namespace=="amb" are dropped so
// they do not duplicate AMB's own feed.
func parseTmbBusStop(body []byte, skipAmb bool) ([]tmbArrival, int64, error) {
	var raw struct {
		Timestamp int64 `json:"timestamp"`
		Parades   []struct {
			Trajectes []struct {
				Namespace     string `json:"transit_namespace"`
				NomLinia      string `json:"nom_linia"`
				IDSentit      int    `json:"id_sentit"`
				DestiTrajecte string `json:"desti_trajecte"`
				PropersBusos  []struct {
					TempsArribada int64 `json:"temps_arribada"`
					IDBus         int   `json:"id_bus"`
					InfoBus       *struct {
						Accessibilitat *struct {
							EstatRampa string `json:"estat_rampa"`
						} `json:"accessibilitat"`
					} `json:"info_bus"`
				} `json:"propers_busos"`
			} `json:"linies_trajectes"`
		} `json:"parades"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, 0, err
	}
	var out []tmbArrival
	for _, p := range raw.Parades {
		for _, tr := range p.Trajectes {
			if skipAmb && strings.EqualFold(tr.Namespace, "amb") {
				continue
			}
			line := strings.TrimSpace(tr.NomLinia)
			if line == "" {
				continue
			}
			dir := tmbDirectionCode(tr.IDSentit)
			for _, b := range tr.PropersBusos {
				if b.TempsArribada <= 0 {
					continue
				}
				vid := ""
				if b.IDBus > 0 {
					vid = strconv.Itoa(b.IDBus)
				}
				var wc *bool
				if b.InfoBus != nil && b.InfoBus.Accessibilitat != nil {
					switch strings.ToUpper(strings.TrimSpace(b.InfoBus.Accessibilitat.EstatRampa)) {
					case "SENSE_INCIDENCIA":
						v := true
						wc = &v
					case "AMB_INCIDENCIA", "NO_OPERATIVA", "AVERIADA":
						v := false
						wc = &v
					}
				}
				out = append(out, tmbArrival{
					Line:       line,
					Direction:  dir,
					Dest:       strings.TrimSpace(tr.DestiTrajecte),
					ArriveMs:   b.TempsArribada,
					VehicleID:  vid,
					Wheelchair: wc,
				})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ArriveMs < out[j].ArriveMs })
	return out, raw.Timestamp, nil
}

// pollTmbMetro refreshes tmbMetroLive from api.tmb.cat/v1/itransit/metro/estacions.
func (p *rtPoller) pollTmbMetro(ctx context.Context) {
	if p.src.tmbMetroURL == "" {
		return
	}
	b, err := rtFetch(ctx, p.src.tmbMetroURL)
	if err != nil {
		return
	}
	snap, err := parseTmbMetro(b, time.Now())
	if err != nil {
		return
	}
	tmbMetroLive.Store(snap)
}

// Per-stop TTL cache for on-demand TMB bus predictions.
type tmbBusCacheEntry struct {
	at       time.Time
	arrivals []tmbArrival
}

var tmbBusCache = struct {
	mu      sync.Mutex
	entries map[string]tmbBusCacheEntry
}{entries: map[string]tmbBusCacheEntry{}}

func fetchTmbBusStop(ctx context.Context, stopCode string, now time.Time) ([]tmbArrival, time.Time, bool) {
	appID, appKey, ok := tmbCredentials()
	if !ok || stopCode == "" {
		return nil, time.Time{}, false
	}
	tmbBusCache.mu.Lock()
	if e, hit := tmbBusCache.entries[stopCode]; hit && now.Sub(e.at) <= tmbBusCacheTTL {
		arr, at := e.arrivals, e.at
		tmbBusCache.mu.Unlock()
		return arr, at, true
	}
	tmbBusCache.mu.Unlock()

	u := tmbAuthedURL(tmbBaseURL, "/itransit/bus/parades/"+url.PathEscape(stopCode), appID, appKey)
	b, err := rtFetch(ctx, u)
	if err != nil {
		return nil, time.Time{}, false
	}
	skipAmb := os.Getenv("ARRIBO_AMB") == "1"
	arr, _, err := parseTmbBusStop(b, skipAmb)
	if err != nil {
		return nil, time.Time{}, false
	}
	tmbBusCache.mu.Lock()
	if len(tmbBusCache.entries) >= tmbBusCacheMaxSize {
		// Evict expired entries first, else reset.
		for k, v := range tmbBusCache.entries {
			if now.Sub(v.at) > tmbBusCacheTTL {
				delete(tmbBusCache.entries, k)
			}
		}
		if len(tmbBusCache.entries) >= tmbBusCacheMaxSize {
			tmbBusCache.entries = map[string]tmbBusCacheEntry{}
		}
	}
	tmbBusCache.entries[stopCode] = tmbBusCacheEntry{at: now, arrivals: arr}
	tmbBusCache.mu.Unlock()
	return arr, now, true
}

func tmbDeparturesResponse(stop rtLineStop, arrivals []tmbArrival, direction string, fetchedAt, now time.Time) *Obj {
	deps := []any{}
	nowMs := now.UnixMilli()
	for _, a := range arrivals {
		if direction != "" && a.Direction != direction {
			continue
		}
		mins := math.Floor(float64(a.ArriveMs-nowMs) / 60000)
		if mins < 0 {
			continue
		}
		hhmm := time.UnixMilli(a.ArriveMs).In(madrid).Format("15:04")
		o := O(
			"tripId", nil,
			"vehicleId", strOrNil(a.VehicleID),
			"destination", strOrNil(a.Dest),
			"direction", a.Direction,
			"departureTime", hhmm,
			"scheduledTime", hhmm,
			"aimedIso", isoString(a.ArriveMs),
			"expectedIso", isoString(a.ArriveMs),
			"minutesAway", mins,
			"delayMins", nil,
			"delayMinutes", nil,
			"delayStatus", "live",
			"delayBadgeText", "Temps real",
			"delaySource", "tmb_itransit",
			"delayDiscarded", false,
			"isRealTime", true,
			"isEstimated", false,
			"isTheoretical", false,
			"isCancelled", false,
			"platform", strOrNil(a.Track),
			"platformSource", strOrNil(func() string {
				if a.Track != "" {
					return "live"
				}
				return ""
			}()),
			"platformChanged", false,
			"scheduledPlatform", nil,
		)
		if a.Wheelchair != nil {
			o.Set("wheelchairAccessible", *a.Wheelchair)
		}
		deps = append(deps, o)
		if len(deps) >= railDepShown {
			break
		}
	}
	return O(
		"stop", O("id", stop.ID, "name", stop.Name, "lat", stop.Lat, "lon", stop.Lon, "agencyId", tmbAgencyID),
		"departures", deps,
		"windowMinutes", float64(railDepWindowSec/60),
		"source", "tmb_itransit",
		"dataUpdatedAt", fetchedAt.In(madrid).Format("2006-01-02"),
		"attribution", tmbAttributionWithDate(fetchedAt),
	)
}

// tmbLiveDepartures returns a live iTransit response for a TMB Metro or Bus
// stop when predictions exist; returns nil to let the caller fall back to GTFS.
func tmbLiveDepartures(ctx context.Context, stop rtLineStop, lineCode, direction string, now time.Time) *Obj {
	if stCode := tmbMetroStationCode(stop.ID); stCode != "" {
		snap := tmbMetroLive.Load()
		if !snap.fresh(now) {
			return nil
		}
		arr := snap.ByLineStation[strings.ToUpper(strings.TrimSpace(lineCode))+"\x00"+stCode]
		if len(arr) == 0 {
			return nil
		}
		res := tmbDeparturesResponse(stop, arr, direction, snap.At, now)
		if len(res.Arr("departures")) == 0 {
			return nil
		}
		return res
	}
	if busCode := tmbBusStopCode(stop.ID); busCode != "" {
		all, at, ok := fetchTmbBusStop(ctx, busCode, now)
		if !ok || len(all) == 0 {
			return nil
		}
		want := strings.ToUpper(strings.TrimSpace(lineCode))
		var filtered []tmbArrival
		for _, a := range all {
			if strings.ToUpper(a.Line) == want {
				filtered = append(filtered, a)
			}
		}
		if len(filtered) == 0 {
			return nil
		}
		res := tmbDeparturesResponse(stop, filtered, direction, at, now)
		if len(res.Arr("departures")) == 0 {
			return nil
		}
		return res
	}
	return nil
}

// tmbMetroTrainFeed synthesises live Barcelona Metro train positions from the
// latest iTransit station arrival snapshot (tmbMetroLive) and the GTFS line
// profiles in rtCatalog. Each unique codi_servei is placed at or interpolated
// just before its immediate next upcoming station.
func tmbMetroTrainFeed(now time.Time) (trainFeed, bool) {
	snap := tmbMetroLive.Load()
	if !snap.fresh(now) {
		return trainFeed{}, false
	}
	v, ok := rtCatalog.Load(tmbAgencyID)
	if !ok {
		return trainFeed{}, false
	}
	op := v.(*rtCatalogOp)

	nowMs := now.UnixMilli()
	if snap.ServerMs > 0 && abs64(nowMs-snap.ServerMs) < 300_000 {
		nowMs = snap.ServerMs + now.Sub(snap.At).Milliseconds()
	}

	type nextCand struct {
		line     string
		dir      string
		stCode   string
		vehID    string
		etaSec   float64
		arriveMs int64
	}
	bestByTrain := map[string]nextCand{}
	for key, arrs := range snap.ByLineStation {
		sep := strings.IndexByte(key, '\x00')
		if sep <= 0 {
			continue
		}
		lineUpper := key[:sep]
		stCode := key[sep+1:]
		for _, a := range arrs {
			if a.VehicleID == "" {
				continue
			}
			etaSec := float64(a.ArriveMs-nowMs) / 1000.0
			if etaSec < -15 || etaSec > 240 {
				continue
			}
			tk := lineUpper + "\x00" + a.Direction + "\x00" + a.VehicleID
			prev, exists := bestByTrain[tk]
			if !exists || etaSec < prev.etaSec {
				bestByTrain[tk] = nextCand{
					line:     lineUpper,
					dir:      a.Direction,
					stCode:   stCode,
					vehID:    a.VehicleID,
					etaSec:   etaSec,
					arriveMs: a.ArriveMs,
				}
			}
		}
	}

	var vehicles []rtVehicle
	for _, c := range bestByTrain {
		prof := op.Profiles[c.line]
		if prof == nil {
			continue
		}
		wantDir := 0
		if c.dir == "1" {
			wantDir = 1
		}
		var dirObj *rtLineDirection
		stopIdx := -1
		for i := range prof.Directions {
			d := &prof.Directions[i]
			if d.DirectionID != wantDir {
				continue
			}
			for j, st := range d.Stops {
				if tmbMetroStationCode(st.ID) == c.stCode {
					dirObj = d
					stopIdx = j
					break
				}
			}
			if stopIdx >= 0 {
				break
			}
		}
		if stopIdx < 0 {
			for i := range prof.Directions {
				d := &prof.Directions[i]
				for j, st := range d.Stops {
					if tmbMetroStationCode(st.ID) == c.stCode {
						dirObj = d
						stopIdx = j
						break
					}
				}
				if stopIdx >= 0 {
					break
				}
			}
		}
		if dirObj == nil || stopIdx < 0 {
			continue
		}
		nextSt := dirObj.Stops[stopIdx]
		lat, lon := nextSt.Lat, nextSt.Lon
		status := "STOPPED_AT"
		if c.etaSec > 15 && stopIdx > 0 {
			prevSt := dirObj.Stops[stopIdx-1]
			// Typical Barcelona Metro inter-station run time is ~90s.
			frac := 1.0 - c.etaSec/90.0
			if frac < 0.05 {
				frac = 0.05
			}
			if frac > 0.95 {
				frac = 0.95
			}
			lat = prevSt.Lat + (nextSt.Lat-prevSt.Lat)*frac
			lon = prevSt.Lon + (nextSt.Lon-prevSt.Lon)*frac
			status = "IN_TRANSIT_TO"
		}
		vehicles = append(vehicles, rtVehicle{
			AgencyID:      tmbAgencyID,
			Mode:          "metro",
			VehicleID:     "TMB_M_" + c.line + "_" + c.vehID,
			Label:         c.line + " · " + c.vehID,
			LineCode:      c.line,
			DirectionID:   dirObj.DirectionID,
			StopID:        nextSt.ID,
			StopName:      nextSt.Name,
			CurrentStatus: status,
			Lat:           lat,
			Lon:           lon,
			ObservedAt:    snap.At.Unix(),
		})
	}
	if len(vehicles) == 0 {
		return trainFeed{}, false
	}
	return trainFeed{
		info: tmbOperator,
		snap: &rtSnapshot{
			AgencyID:  tmbAgencyID,
			FetchedAt: snap.At,
			Vehicles:  vehicles,
		},
	}, true
}

func abs64(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}

// Per-line TTL cache for estimated TMB city bus positions on single-line view.
type tmbBusLineCacheEntry struct {
	at    time.Time
	buses []any
}

var tmbBusLineCache = struct {
	mu      sync.Mutex
	entries map[string]tmbBusLineCacheEntry
}{entries: map[string]tmbBusLineCacheEntry{}}

// tmbSampleStopIndices picks up to maxSamples evenly spaced stop indices along
// a direction (skipping origin terminus index 0 when there are multiple stops).
func tmbSampleStopIndices(n, maxSamples int) []int {
	if n <= 0 || maxSamples <= 0 {
		return nil
	}
	if n == 1 {
		return []int{0}
	}
	if n-1 <= maxSamples {
		out := make([]int, 0, n-1)
		for i := 1; i < n; i++ {
			out = append(out, i)
		}
		return out
	}
	out := make([]int, 0, maxSamples)
	seen := map[int]bool{}
	for s := 1; s <= maxSamples; s++ {
		idx := int(math.Round(float64(s) * float64(n-1) / float64(maxSamples)))
		if idx < 1 {
			idx = 1
		}
		if idx >= n {
			idx = n - 1
		}
		if !seen[idx] {
			seen[idx] = true
			out = append(out, idx)
		}
	}
	return out
}

func tmbCumKm(stops []rtLineStop) []float64 {
	cum := make([]float64, len(stops))
	for i := 1; i < len(stops); i++ {
		cum[i] = cum[i-1] + haversineKm(stops[i-1].Lat, stops[i-1].Lon, stops[i].Lat, stops[i].Lon)
	}
	return cum
}

func tmbInterpolateStops(stops []rtLineStop, cum []float64, targetKm float64) (lat, lon, brg float64, nextIdx int) {
	if len(stops) == 0 {
		return 0, 0, 0, 0
	}
	if len(stops) == 1 || targetKm <= 0 {
		brg = 0
		if len(stops) > 1 {
			brg = bearing(stops[0].Lat, stops[0].Lon, stops[1].Lat, stops[1].Lon)
		}
		return stops[0].Lat, stops[0].Lon, brg, 0
	}
	last := len(stops) - 1
	if targetKm >= cum[last] {
		return stops[last].Lat, stops[last].Lon, bearing(stops[last-1].Lat, stops[last-1].Lon, stops[last].Lat, stops[last].Lon), last
	}
	for i := 1; i < len(stops); i++ {
		if cum[i] >= targetKm {
			seg := cum[i] - cum[i-1]
			frac := 0.0
			if seg > 1e-6 {
				frac = (targetKm - cum[i-1]) / seg
			}
			lat = stops[i-1].Lat + (stops[i].Lat-stops[i-1].Lat)*frac
			lon = stops[i-1].Lon + (stops[i].Lon-stops[i-1].Lon)*frac
			brg = bearing(stops[i-1].Lat, stops[i-1].Lon, stops[i].Lat, stops[i].Lon)
			return lat, lon, brg, i
		}
	}
	return stops[last].Lat, stops[last].Lon, 0, last
}

// tmbEstimateLineBusesFromSamples synthesizes estimated TMB city bus positions
// from sampled per-stop iTransit arrivals (each carrying a unique id_bus).
// Every bus is marked honestly as estimated (isEstimated: true, isRealTime: false,
// positionSource: "tmb_stop_predictions").
func tmbEstimateLineBusesFromSamples(route rtRoute, prof *rtLineProfile, direction string, samples map[string][]tmbArrival, now time.Time) []any {
	buses := []any{}
	if prof == nil || len(prof.Directions) == 0 || len(samples) == 0 {
		return buses
	}
	wantCode := strings.ToUpper(strings.TrimSpace(route.Code))
	nowMs := now.UnixMilli()
	ref := tmbAgencyID + ":" + route.Code
	color := route.Color
	if color == "" {
		color = "#E2001A"
	}
	textColor := route.TextColor
	if textColor == "" {
		textColor = "#FFFFFF"
	}
	attr := tmbAttributionWithDate(now)

	type bestObs struct {
		dir      *rtLineDirection
		stopIdx  int
		etaSec   float64
		arriveMs int64
		arr      tmbArrival
	}
	bestByBus := map[string]bestObs{}

	for di := range prof.Directions {
		d := &prof.Directions[di]
		dirStr := strconv.Itoa(d.DirectionID)
		if direction != "both" && direction != "" && dirStr != direction {
			continue
		}
		for si, st := range d.Stops {
			sc := tmbBusStopCode(st.ID)
			if sc == "" {
				continue
			}
			arrs, ok := samples[sc]
			if !ok || len(arrs) == 0 {
				continue
			}
			for _, a := range arrs {
				if strings.ToUpper(strings.TrimSpace(a.Line)) != wantCode {
					continue
				}
				if a.Direction != "" && a.Direction != dirStr {
					continue
				}
				etaSec := float64(a.ArriveMs-nowMs) / 1000.0
				if etaSec < -30 || etaSec > tmbBusMaxEtaSec {
					continue
				}
				vid := a.VehicleID
				if vid == "" {
					vid = fmtCoordKey(st.Lat, st.Lon) + "_" + strconv.FormatInt(a.ArriveMs/60000, 10)
				}
				key := dirStr + "\x00" + vid
				if prev, exists := bestByBus[key]; !exists || etaSec < prev.etaSec {
					bestByBus[key] = bestObs{
						dir:      d,
						stopIdx:  si,
						etaSec:   etaSec,
						arriveMs: a.ArriveMs,
						arr:      a,
					}
				}
			}
		}
	}

	if len(bestByBus) == 0 {
		return buses
	}

	cumByDir := map[int][]float64{}
	keys := make([]string, 0, len(bestByBus))
	for k := range bestByBus {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	for _, k := range keys {
		obs := bestByBus[k]
		d := obs.dir
		cum, ok := cumByDir[d.DirectionID]
		if !ok {
			cum = tmbCumKm(d.Stops)
			cumByDir[d.DirectionID] = cum
		}
		clampedEta := math.Max(0, obs.etaSec)
		backKm := (clampedEta / 3600.0) * tmbBusCommercialKmh
		targetKm := cum[obs.stopIdx] - backKm
		if targetKm < 0 {
			targetKm = 0
		}
		lat, lon, brg, nextIdx := tmbInterpolateStops(d.Stops, cum, targetKm)
		status := "IN_TRANSIT_TO"
		if obs.etaSec <= 15 {
			status = "STOPPED_AT"
			nextIdx = obs.stopIdx
			lat = d.Stops[obs.stopIdx].Lat
			lon = d.Stops[obs.stopIdx].Lon
		}
		nextStop := d.Stops[nextIdx]
		dest := obs.arr.Dest
		if dest == "" {
			dest = d.Headsign
		}
		dirStr := strconv.Itoa(d.DirectionID)
		vid := obs.arr.VehicleID
		if vid == "" {
			vid = "EST_" + strconv.Itoa(obs.stopIdx)
		}
		obj := O(
			"id", "TMB_BUS_"+route.Code+"_"+vid,
			"agencyId", tmbAgencyID,
			"agency", tmbOperator.Name,
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
			"destination", strOrNil(dest),
			"lat", jsRound(lat*1e6)/1e6, "lon", jsRound(lon*1e6)/1e6,
			"latitude", jsRound(lat*1e6)/1e6, "longitude", jsRound(lon*1e6)/1e6,
			"bearing", jsRound(brg),
			"stopId", strOrNil(nextStop.ID),
			"stopName", strOrNil(nextStop.Name),
			"toStop", strOrNil(nextStop.Name),
			"nextStopEtaSec", jsRound(clampedEta),
			"currentStatus", status,
			"isEstimated", true,
			"isRealTime", false,
			"isTheoretical", false,
			"isGhostVehicle", false,
			"positionSource", "tmb_stop_predictions",
			"predictionAgeSec", 0.0,
			"delayMins", nil,
			"stale", false,
			"attribution", attr,
		)
		if obs.arr.Wheelchair != nil {
			obj.Set("wheelchairAccessible", *obs.arr.Wheelchair)
		}
		buses = append(buses, obj)
	}
	return buses
}

// tmbBusLineBuses samples up to tmbBusSamplePerDir stops per visible direction
// via TMB iTransit (using the shared 20 s per-stop cache and a 20 s per-line
// cache) to produce estimated bus positions for the single-line view.
func tmbBusLineBuses(ctx context.Context, op *rtCatalogOp, code, direction string, now time.Time) []any {
	if _, _, ok := tmbCredentials(); !ok || op == nil || op.Profiles == nil {
		return []any{}
	}
	prof := op.Profiles[code]
	if prof == nil || len(prof.Directions) == 0 {
		return []any{}
	}
	cacheKey := strings.ToUpper(strings.TrimSpace(code)) + "\x00" + direction
	tmbBusLineCache.mu.Lock()
	if e, hit := tmbBusLineCache.entries[cacheKey]; hit && now.Sub(e.at) <= tmbBusCacheTTL {
		out := append([]any(nil), e.buses...)
		tmbBusLineCache.mu.Unlock()
		return out
	}
	tmbBusLineCache.mu.Unlock()

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

	stopCodes := []string{}
	seenCode := map[string]bool{}
	for i := range prof.Directions {
		d := &prof.Directions[i]
		dirStr := strconv.Itoa(d.DirectionID)
		if direction != "both" && direction != "" && dirStr != direction {
			continue
		}
		for _, idx := range tmbSampleStopIndices(len(d.Stops), tmbBusSamplePerDir) {
			sc := tmbBusStopCode(d.Stops[idx].ID)
			if sc != "" && !seenCode[sc] {
				seenCode[sc] = true
				stopCodes = append(stopCodes, sc)
			}
		}
	}
	if len(stopCodes) == 0 {
		return []any{}
	}

	samples := make(map[string][]tmbArrival, len(stopCodes))
	var smu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for _, sc := range stopCodes {
		wg.Add(1)
		go func(stopCode string) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				return
			}
			arr, _, ok := fetchTmbBusStop(ctx, stopCode, now)
			if !ok || len(arr) == 0 {
				return
			}
			smu.Lock()
			samples[stopCode] = arr
			smu.Unlock()
		}(sc)
	}
	wg.Wait()

	buses := tmbEstimateLineBusesFromSamples(route, prof, direction, samples, now)

	tmbBusLineCache.mu.Lock()
	if len(tmbBusLineCache.entries) >= tmbBusLineCacheMax {
		for k, v := range tmbBusLineCache.entries {
			if now.Sub(v.at) > tmbBusCacheTTL {
				delete(tmbBusLineCache.entries, k)
			}
		}
		if len(tmbBusLineCache.entries) >= tmbBusLineCacheMax {
			tmbBusLineCache.entries = map[string]tmbBusLineCacheEntry{}
		}
	}
	tmbBusLineCache.entries[cacheKey] = tmbBusLineCacheEntry{at: now, buses: append([]any(nil), buses...)}
	tmbBusLineCache.mu.Unlock()

	return buses
}

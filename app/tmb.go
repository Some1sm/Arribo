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
	tmbAgencyID        = "tmb"
	tmbBaseURL         = "https://api.tmb.cat/v1"
	tmbMetroEvery      = 30 * time.Second
	tmbMetroMaxAge     = 3 * time.Minute
	tmbBusCacheTTL     = 20 * time.Second
	tmbBusCacheMaxSize = 512
	tmbAttributionBase = "Transports Metropolitans de Barcelona (TMB)"
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

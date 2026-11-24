package main

// TMG Girona — Transports Municipals del Gironès (plan step 6.7):
//   - Static GTFS: NAP feed 1570 (L1, L2, L5, L7, L8, L10, L11, L12; 251 stops,
//     shapes, Fires & Temps de Flors calendars), downloaded daily with
//     NAP_API_KEY (never logged).
//   - Live stop predictions (unofficial, ARRIBO_GIRONA=1): on-demand GET to
//     web2.girona.cat/appbus/cat/busos_json.php?linia=<n>&dir=<anada|torna>&codi=<stop_id>
//     with a 20 s per-(line,dir,stop) TTL cache. Parses HTML `contingut` for
//     "N min" / "Imminent" live predictions and "HH:MM" scheduled fallback,
//     falling back cleanly to the GTFS timetable when "(sense informació)".
//   - Labelled "font no oficial"; noHistory: true.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	gironaAgencyID        = "girona"
	gironaNapStaticURL    = "https://nap.transportes.gob.es/api/Fichero/download/1570"
	gironaAppBusURL       = "https://web2.girona.cat/appbus/cat/busos_json.php"
	gironaAppBusReferer   = "https://web2.girona.cat/appbus/cat/app_index.php"
	gironaAttribution     = "TMG Girona · Previsions en temps real (font no oficial)"
	gironaCacheTTL        = 20 * time.Second
	gironaCacheMaxEntries = 512
)

var gironaOperator = operatorInfo{
	ID: gironaAgencyID, Name: "TMG Girona", ShortName: "Girona",
	Mode: "bus", Tier: "predicted", Method: "operator_prediction",
	Source: "Previsions de pas publicades per web2.girona.cat/appbus (font no oficial) i horaris GTFS TMG (NAP 1570). Sense GPS.",
}

func gironaSource() (rtSource, bool) {
	if os.Getenv("ARRIBO_GIRONA") != "1" {
		return rtSource{}, false
	}
	napKey := strings.TrimSpace(os.Getenv("NAP_API_KEY"))
	if napKey == "" {
		return rtSource{}, false
	}
	return rtSource{
		AgencyID:      gironaAgencyID,
		Mode:          "bus",
		vehicleEvery:  time.Minute,
		tripEvery:     time.Minute,
		staticURL:     gironaNapStaticURL,
		staticHeaders: map[string]string{"ApiKey": napKey},
		noHistory:     true,
	}, true
}

// gironaLineNumber strips leading "L"/"l" from a TMG line code ("L10" -> "10").
func gironaLineNumber(code string) string {
	s := strings.TrimSpace(code)
	if len(s) > 1 && (s[0] == 'L' || s[0] == 'l') {
		s = s[1:]
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return ""
		}
	}
	return s
}

type gironaArrival struct {
	MinutesAway int
	ClockHHMM   string // non-empty when parsed from "HH:MM"
	RealTime    bool   // true for "N min" / "Imminent"; false for "HH:MM"
	Direction   string // "0" (anada) or "1" (torna)
}

var (
	reGironaMin      = regexp.MustCompile(`(?i)\b(\d{1,3})\s*min(?:uts?)?\b`)
	reGironaImminent = regexp.MustCompile(`(?i)\b(?:imminent|ara|< ?1\s*min)\b`)
	reGironaClock    = regexp.MustCompile(`\b([01]?\d|2[0-3]):([0-5]\d)\b`)
)

// parseGironaBusosJSON extracts arrival predictions from the HTML `contingut`
// returned by web2.girona.cat/appbus/cat/busos_json.php.
func parseGironaBusosJSON(body []byte, dirCode string, now time.Time) ([]gironaArrival, error) {
	var raw struct {
		Contingut string `json:"contingut"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}
	// Drop links ("Afegir a 'Les meves parades'", PDF links) before stripping tags.
	text := reTag.ReplaceAllString(raw.Contingut, " ")
	text = html.UnescapeString(text)
	text = strings.Join(strings.Fields(text), " ")
	low := strings.ToLower(text)
	if text == "" || strings.Contains(low, "sense informaci") || strings.Contains(low, "no hi ha") {
		return nil, nil
	}

	var out []gironaArrival
	seen := map[int]bool{}
	if reGironaImminent.MatchString(text) {
		out = append(out, gironaArrival{MinutesAway: 0, RealTime: true, Direction: dirCode})
		seen[0] = true
	}
	for _, m := range reGironaMin.FindAllStringSubmatch(text, 10) {
		mins, err := strconv.Atoi(m[1])
		if err != nil || mins < 0 || mins > 180 || seen[mins] {
			continue
		}
		seen[mins] = true
		out = append(out, gironaArrival{MinutesAway: mins, RealTime: true, Direction: dirCode})
	}
	if len(out) == 0 {
		// Fall back to absolute HH:MM strings in the fragment (timetable times).
		locNow := now.In(madrid)
		for _, m := range reGironaClock.FindAllStringSubmatch(text, 10) {
			hh, _ := strconv.Atoi(m[1])
			mm, _ := strconv.Atoi(m[2])
			cand := time.Date(locNow.Year(), locNow.Month(), locNow.Day(), hh, mm, 0, 0, madrid)
			if cand.Before(locNow.Add(-2 * time.Minute)) {
				cand = cand.Add(24 * time.Hour)
			}
			diff := int(math.Floor(cand.Sub(locNow).Minutes()))
			if diff >= 0 && diff <= 180 {
				out = append(out, gironaArrival{
					MinutesAway: diff,
					ClockHHMM:   fmt.Sprintf("%02d:%02d", hh, mm),
					RealTime:    false,
					Direction:   dirCode,
				})
			}
		}
	}
	return out, nil
}

type gironaCacheEntry struct {
	at       time.Time
	arrivals []gironaArrival
}

var gironaCache = struct {
	mu      sync.Mutex
	entries map[string]gironaCacheEntry
}{entries: map[string]gironaCacheEntry{}}

func fetchGironaAppBus(ctx context.Context, lineNum, dirWord, stopID string, now time.Time) ([]gironaArrival, time.Time, bool) {
	key := lineNum + "|" + dirWord + "|" + stopID
	gironaCache.mu.Lock()
	if e, hit := gironaCache.entries[key]; hit && now.Sub(e.at) <= gironaCacheTTL {
		arr, at := e.arrivals, e.at
		gironaCache.mu.Unlock()
		return arr, at, true
	}
	gironaCache.mu.Unlock()

	q := url.Values{}
	q.Set("linia", lineNum)
	q.Set("dir", dirWord)
	q.Set("codi", stopID)
	q.Set("_", strconv.FormatInt(now.UnixMilli(), 10))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, gironaAppBusURL+"?"+q.Encode(), nil)
	if err != nil {
		return nil, time.Time{}, false
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; Arribo transit observatory)")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	req.Header.Set("Referer", gironaAppBusReferer)
	res, err := rtHTTP.Do(req)
	if err != nil {
		return nil, time.Time{}, false
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, time.Time{}, false
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, 256<<10))
	if err != nil {
		return nil, time.Time{}, false
	}
	dirCode := "0"
	if dirWord == "torna" {
		dirCode = "1"
	}
	arr, err := parseGironaBusosJSON(body, dirCode, now)
	if err != nil {
		return nil, time.Time{}, false
	}
	gironaCache.mu.Lock()
	if len(gironaCache.entries) >= gironaCacheMaxEntries {
		for k, v := range gironaCache.entries {
			if now.Sub(v.at) > gironaCacheTTL {
				delete(gironaCache.entries, k)
			}
		}
		if len(gironaCache.entries) >= gironaCacheMaxEntries {
			gironaCache.entries = map[string]gironaCacheEntry{}
		}
	}
	gironaCache.entries[key] = gironaCacheEntry{at: now, arrivals: arr}
	gironaCache.mu.Unlock()
	return arr, now, true
}

// gironaLiveDepartures returns live unofficial predictions for a TMG Girona
// stop when available; returns nil so the caller falls back to GTFS timetable.
func gironaLiveDepartures(ctx context.Context, stop rtLineStop, lineCode, direction string, now time.Time) *Obj {
	if os.Getenv("ARRIBO_GIRONA") != "1" {
		return nil
	}
	lineNum := gironaLineNumber(lineCode)
	if lineNum == "" || stop.ID == "" {
		return nil
	}
	dirs := []string{"anada", "torna"}
	if direction == "0" {
		dirs = []string{"anada"}
	} else if direction == "1" {
		dirs = []string{"torna"}
	}
	var all []gironaArrival
	for _, d := range dirs {
		arr, _, ok := fetchGironaAppBus(ctx, lineNum, d, stop.ID, now)
		if ok {
			all = append(all, arr...)
		}
	}
	// Only override GTFS when at least one live (RealTime) prediction was found.
	hasLive := false
	for _, a := range all {
		if a.RealTime {
			hasLive = true
			break
		}
	}
	if !hasLive {
		return nil
	}
	deps := []any{}
	for _, a := range all {
		exp := now.Add(time.Duration(a.MinutesAway) * time.Minute)
		hhmm := exp.In(madrid).Format("15:04")
		if a.ClockHHMM != "" {
			hhmm = a.ClockHHMM
		}
		status, badge := "scheduled", "Horari"
		var src any = nil
		if a.RealTime {
			status, badge, src = "live", "Temps real", "girona_appbus_unofficial"
		}
		deps = append(deps, O(
			"tripId", nil,
			"vehicleId", nil,
			"destination", nil,
			"direction", a.Direction,
			"departureTime", hhmm,
			"scheduledTime", hhmm,
			"aimedIso", isoString(exp.UnixMilli()),
			"expectedIso", isoString(exp.UnixMilli()),
			"minutesAway", float64(a.MinutesAway),
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
		"stop", O("id", stop.ID, "name", stop.Name, "lat", stop.Lat, "lon", stop.Lon, "agencyId", gironaAgencyID),
		"departures", deps,
		"windowMinutes", float64(railDepWindowSec/60),
		"source", "girona_appbus_unofficial",
		"unofficial", true,
		"attribution", gironaAttribution,
	)
}

var errGironaBadInput = errors.New("invalid girona request")

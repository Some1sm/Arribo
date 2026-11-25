package main

// Catalonia-bounded address & place geocoder for /api/geocode?q=...
// Combines instant catalog station/stop matches with OpenStreetMap Nominatim
// (bounded to Catalonia's bounding box, 1 req/s rate limit, 15 min cache)
// and falls back to the local street index when offline or rate-limited.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	catGeocodeCacheTTL = 15 * time.Minute
	catGeocodeCacheMax = 512
	catGeocodeMinGap   = 1050 * time.Millisecond // Nominatim usage policy: max 1 req/sec
)

// Catalonia bounding box: west,north,east,south for Nominatim viewbox.
const cataloniaViewbox = "0.15,42.87,3.35,40.52"

type geocodeHit struct {
	Name     string  `json:"name"`
	Subtitle string  `json:"subtitle"`
	Lat      float64 `json:"lat"`
	Lon      float64 `json:"lon"`
	Type     string  `json:"type"`
}

type geocodeCacheEntry struct {
	at   time.Time
	hits []geocodeHit
}

var (
	geocodeMu    sync.Mutex
	geocodeCache = map[string]geocodeCacheEntry{}
	geocodeNext  time.Time
	geocodeHTTP  = &http.Client{Timeout: 6 * time.Second}
	geocodeBase  = "https://nominatim.openstreetmap.org/search"
)

func (s *Server) hGeocode(q *xreq, res *xres) error {
	raw := strings.TrimSpace(jsString(qv(q, "q")))
	if len(raw) < 2 {
		res.json(O("success", true, "query", raw, "results", []any{}))
		return nil
	}
	if len(raw) > 160 {
		raw = raw[:160]
	}
	hits := s.geocodeCatalonia(q.r.Context(), raw, 6)
	out := make([]any, 0, len(hits))
	for _, h := range hits {
		out = append(out, O(
			"name", h.Name,
			"subtitle", h.Subtitle,
			"lat", h.Lat,
			"lon", h.Lon,
			"type", h.Type,
		))
	}
	res.json(O("success", true, "query", raw, "results", out))
	return nil
}

func (s *Server) geocodeCatalonia(ctx context.Context, query string, limit int) []geocodeHit {
	key := foldStationName(query)
	if key == "" {
		return nil
	}
	now := time.Now()
	geocodeMu.Lock()
	if ent, ok := geocodeCache[key]; ok && now.Sub(ent.at) < catGeocodeCacheTTL {
		geocodeMu.Unlock()
		if len(ent.hits) > limit {
			return ent.hits[:limit]
		}
		return ent.hits
	}
	geocodeMu.Unlock()

	var hits []geocodeHit
	// 1. Try Catalonia-bounded Nominatim for real street addresses & places.
	nomHits, err := fetchNominatimCatalonia(ctx, query, limit)
	if err == nil && len(nomHits) > 0 {
		hits = append(hits, nomHits...)
	}

	// 2. Fallback / supplement with local street index if Nominatim returned few/no hits.
	if len(hits) < 3 && s != nil {
		if streets, serr := s.searchStreets(query, 4); serr == nil {
			for _, st := range streets {
				lat, lon := st.Num("lat"), st.Num("lon")
				if lat == 0 && lon == 0 {
					continue
				}
				name := strings.TrimSpace(jsString(st.Get("name")))
				city := strings.TrimSpace(jsString(st.Get("cityName")))
				if name == "" {
					continue
				}
				if !hasNearbyGeocodeHit(hits, lat, lon, 120) {
					hits = append(hits, geocodeHit{
						Name:     name,
						Subtitle: city,
						Lat:      lat,
						Lon:      lon,
						Type:     "address",
					})
				}
			}
		}
	}

	// 3. Also include top matching catalog stations/stops (e.g. "Sants", "Pl. Catalunya").
	if len(hits) < limit {
		for _, raw := range searchCatalogStops(query, 3) {
			o, _ := raw.(*Obj)
			if o == nil {
				continue
			}
			lat, lon := o.Num("lat"), o.Num("lon")
			if lat == 0 && lon == 0 {
				continue
			}
			if !hasNearbyGeocodeHit(hits, lat, lon, 120) {
				hits = append(hits, geocodeHit{
					Name:     strings.TrimSpace(jsString(o.Get("stopName"))),
					Subtitle: strings.TrimSpace(jsString(o.Get("zone"))),
					Lat:      lat,
					Lon:      lon,
					Type:     "stop",
				})
			}
		}
	}

	if len(hits) > limit {
		hits = hits[:limit]
	}

	geocodeMu.Lock()
	if len(geocodeCache) >= catGeocodeCacheMax {
		for k, v := range geocodeCache {
			if now.Sub(v.at) >= catGeocodeCacheTTL {
				delete(geocodeCache, k)
			}
		}
		if len(geocodeCache) >= catGeocodeCacheMax {
			geocodeCache = map[string]geocodeCacheEntry{}
		}
	}
	geocodeCache[key] = geocodeCacheEntry{at: now, hits: hits}
	geocodeMu.Unlock()
	return hits
}

func hasNearbyGeocodeHit(hits []geocodeHit, lat, lon, radiusM float64) bool {
	for _, h := range hits {
		if distM(h.Lat, h.Lon, lat, lon) <= radiusM {
			return true
		}
	}
	return false
}

func fetchNominatimCatalonia(ctx context.Context, query string, limit int) ([]geocodeHit, error) {
	geocodeMu.Lock()
	wait := time.Until(geocodeNext)
	nextAt := time.Now()
	if wait > 0 {
		nextAt = nextAt.Add(wait)
	}
	geocodeNext = nextAt.Add(catGeocodeMinGap)
	geocodeMu.Unlock()

	if wait > 0 {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(wait):
		}
	}

	u, err := url.Parse(geocodeBase)
	if err != nil {
		return nil, err
	}
	params := u.Query()
	params.Set("format", "jsonv2")
	params.Set("addressdetails", "1")
	params.Set("limit", strconv.Itoa(limit))
	params.Set("countrycodes", "es")
	params.Set("viewbox", cataloniaViewbox)
	params.Set("bounded", "1")
	params.Set("q", query)
	u.RawQuery = params.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", movUserAgent)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Language", "ca,es,en")

	resp, err := geocodeHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, &httpStatusError{resp.StatusCode}
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 512<<10))
	if err != nil {
		return nil, err
	}
	return parseNominatimHits(body)
}

func parseNominatimHits(body []byte) ([]geocodeHit, error) {
	var rows []struct {
		Lat         string `json:"lat"`
		Lon         string `json:"lon"`
		Name        string `json:"name"`
		DisplayName string `json:"display_name"`
		Address     struct {
			Road          string `json:"road"`
			HouseNumber   string `json:"house_number"`
			Neighbourhood string `json:"neighbourhood"`
			Suburb        string `json:"suburb"`
			City          string `json:"city"`
			Town          string `json:"town"`
			Village       string `json:"village"`
			Municipality  string `json:"municipality"`
		} `json:"address"`
	}
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, err
	}
	out := make([]geocodeHit, 0, len(rows))
	for _, r := range rows {
		lat, err1 := strconv.ParseFloat(strings.TrimSpace(r.Lat), 64)
		lon, err2 := strconv.ParseFloat(strings.TrimSpace(r.Lon), 64)
		if err1 != nil || err2 != nil || (lat == 0 && lon == 0) {
			continue
		}
		city := firstNonEmpty(r.Address.City, r.Address.Town, r.Address.Village, r.Address.Municipality)
		area := firstNonEmpty(r.Address.Suburb, r.Address.Neighbourhood)
		primary := strings.TrimSpace(r.Name)
		if r.Address.Road != "" {
			if r.Address.HouseNumber != "" {
				primary = r.Address.Road + ", " + r.Address.HouseNumber
			} else if primary == "" {
				primary = r.Address.Road
			}
		}
		if primary == "" {
			parts := strings.Split(r.DisplayName, ",")
			primary = strings.TrimSpace(parts[0])
		}
		var subParts []string
		if area != "" && !strings.EqualFold(area, primary) && !strings.EqualFold(area, city) {
			subParts = append(subParts, area)
		}
		if city != "" && !strings.EqualFold(city, primary) {
			subParts = append(subParts, city)
		}
		sub := strings.Join(subParts, ", ")
		if sub == "" && r.DisplayName != "" {
			parts := strings.Split(r.DisplayName, ",")
			if len(parts) > 1 {
				sub = strings.TrimSpace(strings.Join(parts[1:min(len(parts), 3)], ", "))
			}
		}
		out = append(out, geocodeHit{
			Name:     primary,
			Subtitle: sub,
			Lat:      lat,
			Lon:      lon,
			Type:     "address",
		})
	}
	return out, nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}

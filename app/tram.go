package main

// TRAM Barcelona (Trambaix T1–T3 and Trambesòs T4–T6, plan step 6.6):
// official GTFS-RT trip updates authenticated via OAuth2 client_credentials
// (opendata.tram.cat/connect/token) plus daily static GTFS zips (TBX.zip and
// TBS.zip).
//
// Terms (docs/research/catalonia-2026/07-other-modes.md §4):
//   - Attribution: "Powered by TRAM Barcelona" with link and update date.
//   - Deletion on agreement end: noHistory is true so TRAM rows are never
//     written to the persistent history SQLite database.
//
// Opt-in with ARRIBO_TRAM=1 (on in compose) and requires TRAM_CLIENT_ID and
// TRAM_CLIENT_SECRET in the environment (never logged or committed).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	tramTbxAgencyID = "tram_tbx"
	tramTbsAgencyID = "tram_tbs"
	tramTokenURL    = "https://opendata.tram.cat/connect/token"
	tramTbxStatic   = "https://opendata.tram.cat/GTFS/zip/TBX.zip"
	tramTbsStatic   = "https://opendata.tram.cat/GTFS/zip/TBS.zip"
	tramTbxTripURL  = "https://opendata.tram.cat/api/v1/gtfsrealtime?networkId=1"
	tramTbsTripURL  = "https://opendata.tram.cat/api/v1/gtfsrealtime?networkId=2"
	tramAttribution = "Powered by TRAM Barcelona (https://opendata.tram.cat)"
)

var (
	tramTbxOperator = operatorInfo{
		ID: tramTbxAgencyID, Name: "TRAM · Trambaix", ShortName: "Trambaix",
		Mode: "tram", Tier: "predicted", Method: "operator_prediction",
		Source: "Previsions de pas en temps real (GTFS-RT) de TRAM Barcelona per al Trambaix (T1–T3). Sense GPS.",
	}
	tramTbsOperator = operatorInfo{
		ID: tramTbsAgencyID, Name: "TRAM · Trambesòs", ShortName: "Trambesòs",
		Mode: "tram", Tier: "predicted", Method: "operator_prediction",
		Source: "Previsions de pas en temps real (GTFS-RT) de TRAM Barcelona per al Trambesòs (T4–T6). Sense GPS.",
	}
)

// tramTokenCache caches the TRAM OpenIddict OAuth2 bearer token across
// Trambaix and Trambesòs pollers, refreshing 60 s before expiry.
type tramTokenCache struct {
	tokenURL     string
	clientID     string
	clientSecret string
	client       *http.Client

	mu      sync.Mutex
	header  string
	expires time.Time
}

func (c *tramTokenCache) token(ctx context.Context) (string, error) {
	c.mu.Lock()
	if c.header != "" && time.Now().Before(c.expires) {
		h := c.header
		c.mu.Unlock()
		return h, nil
	}
	c.mu.Unlock()

	form := url.Values{}
	form.Set("grant_type", "client_credentials")
	form.Set("client_id", c.clientID)
	form.Set("client_secret", c.clientSecret)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", errors.New("tram token bad request")
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", "arribo-gtfsrt/1")

	cli := c.client
	if cli == nil {
		cli = rtHTTP
	}
	res, err := cli.Do(req)
	if err != nil {
		return "", errors.New("tram token request failed")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("tram token HTTP %d", res.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return "", errors.New("tram token read failed")
	}
	var tok struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &tok); err != nil || tok.AccessToken == "" {
		return "", errors.New("tram token response invalid")
	}
	ttl := time.Duration(tok.ExpiresIn) * time.Second
	if ttl <= 120*time.Second {
		ttl = 10 * time.Minute
	} else {
		ttl -= 60 * time.Second
	}
	h := "Bearer " + tok.AccessToken
	c.mu.Lock()
	c.header = h
	c.expires = time.Now().Add(ttl)
	c.mu.Unlock()
	return h, nil
}

func (c *tramTokenCache) reset() {
	c.mu.Lock()
	c.header = ""
	c.expires = time.Time{}
	c.mu.Unlock()
}

// tramSources returns the Trambaix and Trambesòs GTFS-RT sources when
// ARRIBO_TRAM=1 and OAuth credentials are present.
func tramSources() []rtSource {
	if os.Getenv("ARRIBO_TRAM") != "1" {
		return nil
	}
	cid := strings.TrimSpace(os.Getenv("TRAM_CLIENT_ID"))
	sec := strings.TrimSpace(os.Getenv("TRAM_CLIENT_SECRET"))
	if cid == "" || sec == "" {
		return nil
	}
	tc := &tramTokenCache{
		tokenURL:     tramTokenURL,
		clientID:     cid,
		clientSecret: sec,
	}
	return []rtSource{
		{
			AgencyID:     tramTbxAgencyID,
			Mode:         "tram",
			tripURL:      fixedURL(tramTbxTripURL),
			tripReset:    tc.reset,
			authHeader:   tc.token,
			vehicleEvery: 30 * time.Second,
			tripEvery:    30 * time.Second,
			staticURL:    tramTbxStatic,
			noHistory:    true,
		},
		{
			AgencyID:     tramTbsAgencyID,
			Mode:         "tram",
			tripURL:      fixedURL(tramTbsTripURL),
			tripReset:    tc.reset,
			authHeader:   tc.token,
			vehicleEvery: 30 * time.Second,
			tripEvery:    30 * time.Second,
			staticURL:    tramTbsStatic,
			noHistory:    true,
		},
	}
}

func isTramAgency(id string) bool {
	return id == tramTbxAgencyID || id == tramTbsAgencyID
}

// tramVehiclesFromFeed synthesizes live estimated TRAM Barcelona positions
// (Trambaix T1-T3, Trambesòs T4-T6) from TRAM's official GTFS-RT trip_updates
// and the imported static GTFS line profiles in rtCatalog. Every tram is
// placed at or interpolated just before its earliest upcoming stop (<= 4 min).
func tramVehiclesFromFeed(ctx context.Context, agencyID string, tt *rtTimetable, fm *FeedMessage, delays map[string]int32, computedTrips map[string]bool, now time.Time) []rtVehicle {
	if fm == nil || !isTramAgency(agencyID) {
		return nil
	}
	v, ok := rtCatalog.Load(agencyID)
	if !ok {
		return nil
	}
	op := v.(*rtCatalogOp)
	if op == nil || op.Profiles == nil {
		return nil
	}
	nowUnix := now.Unix()
	feedTS := fm.Header.Timestamp
	if feedTS == 0 {
		feedTS = uint64(nowUnix)
	}
	obsUnix := int64(feedTS)
	if abs64(nowUnix-obsUnix) > 300 {
		obsUnix = nowUnix
	}

	var out []rtVehicle
	seenTrip := map[string]bool{}
	for _, e := range fm.Entities {
		if e.IsDeleted || e.TripUpdate == nil || e.TripUpdate.Trip.TripID == "" {
			continue
		}
		tu := e.TripUpdate
		if tu.Trip.ScheduleRelationship == gtfsTripCanceled || seenTrip[tu.Trip.TripID] {
			continue
		}
		seenTrip[tu.Trip.TripID] = true

		// Find the earliest upcoming stop within [-30s, +240s].
		bestStopID := ""
		bestEta := 1e9
		for _, stu := range tu.StopTimeUpdates {
			if stu.StopID == "" {
				continue
			}
			var tUnix int64
			if stu.Arrival != nil && stu.Arrival.Time != nil {
				tUnix = *stu.Arrival.Time
			} else if stu.Departure != nil && stu.Departure.Time != nil {
				tUnix = *stu.Departure.Time
			}
			if tUnix <= 0 {
				continue
			}
			eta := float64(tUnix - nowUnix)
			if eta >= -30 && eta <= 240 && eta < bestEta {
				bestEta = eta
				bestStopID = stu.StopID
			}
		}
		if bestStopID == "" {
			continue
		}

		// Resolve line code from timetable or route_id.
		lineCode := ""
		wantDir := -1
		if tt != nil {
			lineCode = tt.tripLine(ctx, tu.Trip.TripID)
			if lineCode == "" && tu.Trip.RouteID != "" {
				lineCode = tt.routeLine(ctx, tu.Trip.RouteID)
			}
			wantDir = tt.tripDirection(ctx, tu.Trip.TripID)
		}
		if lineCode == "" && tu.Trip.RouteID != "" {
			for _, r := range op.Lines {
				if strings.EqualFold(r.Code, tu.Trip.RouteID) {
					lineCode = r.Code
					break
				}
				for _, rid := range r.RouteIDs {
					if rid == tu.Trip.RouteID {
						lineCode = r.Code
						break
					}
				}
				if lineCode != "" {
					break
				}
			}
		}
		if lineCode == "" {
			continue
		}
		prof := op.Profiles[lineCode]
		if prof == nil {
			continue
		}

		var dirObj *rtLineDirection
		stopIdx := -1
		for i := range prof.Directions {
			d := &prof.Directions[i]
			if wantDir >= 0 && d.DirectionID != wantDir {
				continue
			}
			for j, st := range d.Stops {
				if st.ID == bestStopID {
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
					if st.ID == bestStopID {
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
		if bestEta > 15 && stopIdx > 0 {
			prevSt := dirObj.Stops[stopIdx-1]
			// Typical Barcelona TRAM inter-station run time is ~75 s.
			frac := 1.0 - bestEta/75.0
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

		vehID := tu.Trip.TripID
		label := lineCode
		if tu.Vehicle != nil {
			if tu.Vehicle.ID != "" {
				vehID = tu.Vehicle.ID
			}
			if tu.Vehicle.Label != "" {
				label = lineCode + " · " + tu.Vehicle.Label
			}
		}
		rv := rtVehicle{
			AgencyID:      agencyID,
			Mode:          "tram",
			VehicleID:     vehID,
			Label:         label,
			TripID:        tu.Trip.TripID,
			RouteID:       tu.Trip.RouteID,
			LineCode:      lineCode,
			DirectionID:   dirObj.DirectionID,
			StopID:        nextSt.ID,
			StopName:      nextSt.Name,
			CurrentStatus: status,
			Lat:           lat,
			Lon:           lon,
			ObservedAt:    obsUnix,
		}
		if d, hasD := delays[tu.Trip.TripID]; hasD {
			dCopy := d
			rv.DelaySec = &dCopy
			rv.HasDelayFromTripUpdate = true
			rv.DelayComputed = computedTrips[tu.Trip.TripID]
		}
		out = append(out, rv)
	}
	return out
}

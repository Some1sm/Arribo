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

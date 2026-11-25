package main

// Live service alerts for Moventis lines from the public JSON endpoint behind
// https://www.moventis.es/ca/informacio-practica/incidencies:
//   GET https://www.moventis.es/es/moventis/ca/incidencias
//
// Polled every 10 minutes while ARRIBO_MOVENTIS=1 and merged into
// railAlertsJSON (/api/rail/alerts and each Moventis line's railAlerts banner).

import (
	"context"
	"encoding/json"
	"html"
	"io"
	"log"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	movAlertsPath = "/es/moventis/ca/incidencias"
	movAlertsGap  = 10 * time.Minute
)

var (
	movAlertsLive atomic.Pointer[[]railAlert]
	reMovHTMLTag  = regexp.MustCompile(`<[^>]+>`)
)

func cleanMovAlertText(s string) string {
	s = reMovHTMLTag.ReplaceAllString(s, " ")
	s = html.UnescapeString(s)
	return strings.Join(strings.Fields(s), " ")
}

func parseMovAlerts(body []byte, now time.Time) ([]railAlert, error) {
	var rows []struct {
		NID        string `json:"nid"`
		Title      string `json:"TITLE_INCIDENCIA"`
		Summary    string `json:"RESUMEN_INCIDENCIA"`
		CodeLinea  string `json:"CODE_LINEA"`
		TitleLinea string `json:"TITLE_LINEA"`
		EndDate    string `json:"ENDATE"`
	}
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, err
	}
	type acc struct {
		nid     string
		header  string
		desc    string
		endUnix int64
		lines   map[string]bool
	}
	byNID := map[string]*acc{}
	var order []string
	for _, r := range rows {
		nid := strings.TrimSpace(r.NID)
		if nid == "" {
			continue
		}
		a := byNID[nid]
		if a == nil {
			hdr := cleanMovAlertText(r.Title)
			desc := cleanMovAlertText(r.Summary)
			if hdr == "" && desc == "" {
				continue
			}
			if desc == hdr {
				desc = ""
			}
			var endUnix int64
			if ed := strings.TrimSpace(r.EndDate); ed != "" {
				if t, err := time.ParseInLocation("2006-01-02 15:04:05", ed, madrid); err == nil {
					endUnix = t.Unix()
				}
			}
			a = &acc{nid: nid, header: hdr, desc: desc, endUnix: endUnix, lines: map[string]bool{}}
			byNID[nid] = a
			order = append(order, nid)
		}
		if code := strings.TrimSpace(r.CodeLinea); code != "" {
			a.lines[code] = true
		}
	}

	out := make([]railAlert, 0, len(order))
	for _, nid := range order {
		a := byNID[nid]
		lines := make([]string, 0, len(a.lines))
		for code := range a.lines {
			lines = append(lines, code)
		}
		sort.Strings(lines)
		var periods []TimeRange
		if a.endUnix > 0 {
			periods = []TimeRange{{End: uint64(a.endUnix)}}
		}
		lower := strings.ToLower(a.header + " " + a.desc)
		cause := "OTHER_CAUSE"
		effect := "OTHER_EFFECT"
		if strings.Contains(lower, "obra") || strings.Contains(lower, "tall") || strings.Contains(lower, "corte") {
			cause = "CONSTRUCTION"
			effect = "DETOUR"
		} else if strings.Contains(lower, "desvi") || strings.Contains(lower, "parada") {
			effect = "DETOUR"
		} else if strings.Contains(lower, "vaga") || strings.Contains(lower, "huelga") {
			cause = "STRIKE"
			effect = "REDUCED_SERVICE"
		}
		ra := railAlert{
			ID:          "moventis:" + nid,
			AgencyID:    movAgencyID,
			Header:      a.header,
			Description: a.desc,
			Lang:        "ca",
			URL:         movBase + "/ca/node/" + nid,
			Cause:       cause,
			Effect:      effect,
			Lines:       lines,
			Periods:     periods,
		}
		if railAlertActive(&ra, now.Unix()) {
			out = append(out, ra)
		}
	}
	return out, nil
}

func startMovAlertsPoller(ctx context.Context, wg *sync.WaitGroup) {
	wg.Add(1)
	go func() {
		defer wg.Done()
		var lastErr string
		poll := func() {
			reqCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
			defer cancel()
			req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, movBase+movAlertsPath, nil)
			if err != nil {
				return
			}
			req.Header.Set("User-Agent", movUserAgent)
			req.Header.Set("Accept", "application/json")
			resp, err := movHTTP.Do(req)
			if err != nil {
				msg := movErrText(err)
				if msg != lastErr && ctx.Err() == nil {
					log.Printf("[Moventis-Alerts] fetch failed: %s", msg)
					lastErr = msg
				}
				return
			}
			defer resp.Body.Close()
			body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
			if err != nil || resp.StatusCode != http.StatusOK {
				return
			}
			alerts, err := parseMovAlerts(body, time.Now())
			if err != nil {
				return
			}
			movAlertsLive.Store(&alerts)
			if lastErr != "" {
				log.Printf("[Moventis-Alerts] recovered (%d active alerts)", len(alerts))
				lastErr = ""
			}
		}
		poll()
		for movSleep(ctx, movAlertsGap) {
			poll()
		}
	}()
}

// moventisAlertsFor returns active Moventis alerts formatted identically to
// railAlertsJSON for agencyID ("" = all, or "moventis" / "moventis_*") and
// optional line code.
func moventisAlertsFor(agencyID, line string, now time.Time) []any {
	if agencyID != "" && agencyID != movAgencyID && !strings.HasPrefix(agencyID, "moventis_") {
		return nil
	}
	lp := movAlertsLive.Load()
	if lp == nil {
		return nil
	}
	wantLine := ambNormLine(line)
	var out []any
	for i := range *lp {
		a := &(*lp)[i]
		if !railAlertActive(a, now.Unix()) {
			continue
		}
		if wantLine != "" {
			match := false
			for _, l := range a.Lines {
				if ambNormLine(l) == wantLine {
					match = true
					break
				}
			}
			if !match {
				continue
			}
		}
		lines := make([]any, len(a.Lines))
		for j, l := range a.Lines {
			lines[j] = l
		}
		periods := make([]any, 0, len(a.Periods))
		for _, pr := range a.Periods {
			var start, end any
			if pr.Start > 0 {
				start = float64(pr.Start) * 1000
			}
			if pr.End > 0 {
				end = float64(pr.End) * 1000
			}
			periods = append(periods, O("start", start, "end", end))
		}
		ag := a.AgencyID
		if agencyID != "" {
			ag = agencyID
		}
		out = append(out, O(
			"id", a.ID, "agencyId", ag,
			"header", strOrNil(a.Header), "description", strOrNil(a.Description),
			"lang", strOrNil(a.Lang), "url", strOrNil(a.URL),
			"cause", a.Cause, "effect", a.Effect,
			"lines", lines, "stops", []any{}, "activePeriods", periods,
		))
	}
	return out
}

package main

// Service alerts for trains (GTFS-RT Alerts): Renfe publishes one national
// feed and FGC one through its open-data API. Each poller fetches its
// operator's feed every few minutes, keeps the alerts that touch a line,
// trip or station of its imported timetable (Renfe's feed covers all of
// Spain, and a station id alone is ambiguous: "51051" is in Seville), and
// stores them behind an atomic pointer like the vehicle snapshot. The
// text is the operator's own, in its language: nothing is rewritten.

import (
	"context"
	"sort"
	"time"
)

// railAlertEvery is how often the alerts feeds are fetched. FGC allows
// 5,000 anonymous requests a day; positions and trip updates use 3,840 and
// this adds 288.
const railAlertEvery = 5 * time.Minute

type railAlertStop struct{ ID, Name string }

// railAlert is one alert as served: the operator's header and description
// (the best language available: ca, es, en, then whatever there is), its
// active periods, and the lines and stations of the timetable it names.
type railAlert struct {
	ID, AgencyID        string
	Header, Description string
	Lang, URL           string
	Cause, Effect       string
	Periods             []TimeRange
	Lines               []string
	Stops               []railAlertStop
}

// pickText returns the text in the preferred language and that language.
func pickText(ts TranslatedString) (string, string) {
	for _, want := range []string{"ca", "es", "en"} {
		for _, t := range ts {
			if t.Language == want && t.Text != "" {
				return t.Text, t.Language
			}
		}
	}
	for _, t := range ts {
		if t.Text != "" {
			return t.Text, t.Language
		}
	}
	return "", ""
}

// railAlertActive: no period means always; else now is inside one of them
// (a missing end is open).
func railAlertActive(a *railAlert, now int64) bool {
	if len(a.Periods) == 0 {
		return true
	}
	for _, p := range a.Periods {
		if (p.Start == 0 || int64(p.Start) <= now) && (p.End == 0 || now < int64(p.End)) {
			return true
		}
	}
	return false
}

// buildRailAlerts maps a decoded feed onto the timetable. An alert is kept
// when at least one informed entity resolves to a line or station of the
// timetable; without a timetable nothing can be checked and nothing is kept.
func buildRailAlerts(ctx context.Context, agencyID string, tt *rtTimetable, fm *FeedMessage) []railAlert {
	if tt == nil || fm == nil {
		return nil
	}
	var out []railAlert
	for _, e := range fm.Entities {
		a := e.Alert
		if e.IsDeleted || a == nil {
			continue
		}
		lines := map[string]bool{}
		stops := map[string]string{}
		for _, ie := range a.InformedEntities {
			if ie.RouteID != "" {
				if l := tt.routeLine(ctx, ie.RouteID); l != "" {
					lines[l] = true
				}
			}
			if ie.Trip != nil && ie.Trip.TripID != "" {
				if l := tt.tripLine(ctx, ie.Trip.TripID); l != "" {
					lines[l] = true
				}
			}
			if ie.StopID != "" {
				if n := tt.stopName(ctx, ie.StopID); n != "" {
					stops[ie.StopID] = n
				}
			}
		}
		if len(lines) == 0 && len(stops) == 0 {
			continue // nothing of this operator's Catalan timetable
		}
		header, lang := pickText(a.HeaderText)
		desc, dlang := pickText(a.DescriptionText)
		if agencyID == ambAgencyID {
			// AMB sends its alert texts as HTML (entities, some tags).
			header, desc = ambAlertText(header), ambAlertText(desc)
		}
		if lang == "" {
			lang = dlang
		}
		if header == "" && desc == "" {
			continue
		}
		url, _ := pickText(a.URL)
		r := railAlert{
			ID: e.ID, AgencyID: agencyID, Header: header, Description: desc, Lang: lang, URL: url,
			Cause: enumName(a.Cause, causeNames), Effect: enumName(a.Effect, effectNames),
			Periods: a.ActivePeriods,
		}
		for l := range lines {
			r.Lines = append(r.Lines, l)
		}
		sort.Strings(r.Lines)
		for id, n := range stops {
			r.Stops = append(r.Stops, railAlertStop{ID: id, Name: n})
		}
		sort.Slice(r.Stops, func(i, j int) bool { return r.Stops[i].Name < r.Stops[j].Name })
		out = append(out, r)
	}
	// Renfe sends some alerts twice under one id: tagged with the line it is
	// about (R2) and again with every line of the network. Keep one per id,
	// the most specific (fewest lines; stations merged), so an R2 works
	// notice is not listed on R1.
	byID := map[string]int{}
	merged := out[:0]
	for _, a := range out {
		i, seen := byID[a.ID]
		if !seen {
			byID[a.ID] = len(merged)
			merged = append(merged, a)
			continue
		}
		cur := &merged[i]
		if len(a.Lines) > 0 && (len(cur.Lines) == 0 || len(a.Lines) < len(cur.Lines)) {
			cur.Lines = a.Lines
		}
		for _, s := range a.Stops {
			dup := false
			for _, c := range cur.Stops {
				if c.ID == s.ID {
					dup = true
				}
			}
			if !dup {
				cur.Stops = append(cur.Stops, s)
			}
		}
	}
	out = merged
	sort.SliceStable(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// pollAlerts fetches and stores the operator's alerts. A failed fetch keeps
// the previous list (alerts change slowly; an empty list would read as "no
// incidents").
func (p *rtPoller) pollAlerts(ctx context.Context) {
	if p.src.alertURL == nil {
		return
	}
	p.syncTimetable()
	u, err := p.src.alertURL(ctx)
	if err != nil {
		return
	}
	b, err := rtFetch(ctx, u)
	if err != nil {
		return
	}
	fm, err := decodeGtfsRealtime(b)
	if err != nil {
		return
	}
	list := buildRailAlerts(ctx, p.src.AgencyID, p.tt, fm)
	p.alerts.Store(&list)
}

// railAlertsJSON is the active alerts of an operator ("" = all), optionally
// only those naming line code (or none of its stations' lines: an alert
// that names only stations is listed for every line through them, which
// the caller decides by passing the line's station ids).
func railAlertsJSON(agencyID, line string, lineStops map[string]bool, now time.Time) []any {
	out := []any{}
	pp := rtLivePollers.Load()
	if pp == nil {
		return out
	}
	for _, p := range *pp {
		if agencyID != "" && p.src.AgencyID != agencyID {
			continue
		}
		lp := p.alerts.Load()
		if lp == nil {
			continue
		}
		for i := range *lp {
			a := &(*lp)[i]
			if !railAlertActive(a, now.Unix()) {
				continue
			}
			if line != "" {
				match := false
				for _, l := range a.Lines {
					if l == line {
						match = true
					}
				}
				if !match && len(a.Lines) == 0 {
					for _, s := range a.Stops {
						if lineStops[s.ID] {
							match = true
						}
					}
				}
				if !match {
					continue
				}
			}
			lines := make([]any, len(a.Lines))
			for i, l := range a.Lines {
				lines[i] = l
			}
			stops := make([]any, len(a.Stops))
			for i, s := range a.Stops {
				stops[i] = O("id", s.ID, "name", s.Name)
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
			out = append(out, O(
				"id", a.ID, "agencyId", a.AgencyID,
				"header", strOrNil(a.Header), "description", strOrNil(a.Description),
				"lang", strOrNil(a.Lang), "url", strOrNil(a.URL),
				"cause", a.Cause, "effect", a.Effect,
				"lines", lines, "stops", stops, "activePeriods", periods,
			))
		}
	}
	return out
}

// GET /api/rail/alerts[?agency=<id>][&line=<code>]: active train alerts.
func (s *Server) hRailAlerts(q *xreq, res *xres) error {
	agency, _ := qv(q, "agency").(string)
	line, _ := qv(q, "line").(string)
	alerts := railAlertsJSON(jsTrim(agency), jsTrim(line), nil, time.Now())
	res.json(O("success", true, "count", float64(len(alerts)), "alerts", alerts))
	return nil
}

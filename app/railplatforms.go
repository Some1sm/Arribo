package main

// Usual platforms for Rodalies. Renfe publishes no platform plan; it only
// announces the platform at the next station in the label of a train
// approaching it ("R2S-25547-PLATF.(11)", see labelPlatform). Each such
// announcement is counted once per trip and station, per station, line,
// direction and platform; a board then names the platform a line usually
// uses at a station in a direction, marked "usual", until the operator
// announces the real one. Usual only when there is enough evidence and one
// platform clearly dominates: a guess is never shown.

import (
	"context"
	"time"
)

const (
	railPlatformMinSightings = 5    // announcements needed before a usual platform is named
	railPlatformMinShare     = 0.6  // and the share the most used platform must have
	railPlatformWindowDays   = 30   // announcements older than this no longer count (the history retention)
	rtMaxPendingPlatforms    = 2000 // queue bound between two worker drains
)

// railPlatformSighting is one platform announcement.
type railPlatformSighting struct {
	AgencyID, StopID, Line, Platform string
	Dir                              int
	Seen                             int64 // unix s
}

// notePlatforms queues this poll's platform announcements, once per trip
// and station (a train keeps the label for several polls while approaching).
func (p *rtPoller) notePlatforms(vehicles []rtVehicle, now time.Time) {
	var out []railPlatformSighting
	if p.platSeen == nil {
		p.platSeen = map[string]int64{}
	}
	for i := range vehicles {
		v := &vehicles[i]
		_, code := labelPlatform(v.Label)
		if code == "" || v.TripID == "" || v.StopID == "" || v.LineCode == "" {
			continue
		}
		key := v.TripID + "\x00" + v.StopID
		if _, seen := p.platSeen[key]; seen {
			continue
		}
		p.platSeen[key] = now.Unix()
		out = append(out, railPlatformSighting{AgencyID: p.src.AgencyID, StopID: v.StopID, Line: v.LineCode, Platform: code, Dir: v.DirectionID, Seen: now.Unix()})
	}
	// Forget trips announced more than six hours ago (bounded memory).
	for k, t := range p.platSeen {
		if now.Unix()-t > 6*3600 {
			delete(p.platSeen, k)
		}
	}
	if len(out) == 0 {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.pendingPlatforms = append(p.pendingPlatforms, out...)
	if over := len(p.pendingPlatforms) - rtMaxPendingPlatforms; over > 0 {
		p.pendingPlatforms = append([]railPlatformSighting(nil), p.pendingPlatforms[over:]...)
	}
}

// takeRailPlatforms hands over the queued announcements (for the worker).
func (p *rtPoller) takeRailPlatforms() []railPlatformSighting {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := p.pendingPlatforms
	p.pendingPlatforms = nil
	return out
}

// writeRailPlatforms stores the queued announcements. Runs as a daemon task
// under the worker lock.
func (d *IngestionDaemon) writeRailPlatforms() {
	var batch []railPlatformSighting
	for _, p := range gtfsRtPollers {
		batch = append(batch, p.takeRailPlatforms()...)
	}
	if len(batch) == 0 {
		return
	}
	_ = d.db.withTx(func() error {
		for _, s := range batch {
			d.db.recordRailPlatform(s)
		}
		return nil
	})
}

// recordRailPlatform counts one announcement.
func (h *HistoryDB) recordRailPlatform(s railPlatformSighting) {
	if !h.ensureOpen() {
		return
	}
	_, _ = h.run(`INSERT INTO rail_platforms (agency_id, stop_id, line_code, direction, platform, sightings, first_seen, last_seen)
	  VALUES (?, ?, ?, ?, ?, 1, ?, ?)
	  ON CONFLICT(agency_id, stop_id, line_code, direction, platform) DO UPDATE SET sightings = sightings + 1, last_seen = MAX(last_seen, excluded.last_seen)`,
		s.AgencyID, s.StopID, s.Line, float64(s.Dir), s.Platform, float64(s.Seen*1000), float64(s.Seen*1000))
}

// usualPlatforms is, for one station and line, the usual platform per
// direction ("0", "1"): the most announced one in the last
// railPlatformWindowDays, when there are at least railPlatformMinSightings
// announcements in that direction and it has railPlatformMinShare of them.
func (h *HistoryDB) usualPlatforms(agencyID, stopID, line string) map[string]string {
	out := map[string]string{}
	if !h.ensureOpen() {
		return out
	}
	since := float64(nowMs()) - railPlatformWindowDays*86400000
	rows, err := h.all(`SELECT direction AS dir, platform, sightings AS n FROM rail_platforms
	  WHERE agency_id = ? AND stop_id = ? AND line_code = ? AND last_seen >= ?
	  ORDER BY direction, sightings DESC, platform`, agencyID, stopID, line, since)
	if err != nil {
		return out
	}
	type agg struct {
		total, top float64
		platform   string
	}
	byDir := map[string]*agg{}
	var order []string
	for _, r := range rows {
		dir := numToString(jsNumber(r.Get("dir")))
		a := byDir[dir]
		if a == nil {
			a = &agg{}
			byDir[dir] = a
			order = append(order, dir)
		}
		n := jsNumber(r.Get("n"))
		a.total += n
		if a.platform == "" { // rows are ordered by sightings, most first
			a.platform, a.top = jsString(r.Get("platform")), n
		}
	}
	for _, dir := range order {
		a := byDir[dir]
		if a.total >= railPlatformMinSightings && a.top/a.total >= railPlatformMinShare {
			out[dir] = a.platform
		}
	}
	return out
}

// usualPlatformsFor is the worker's lookup for the departures op.
func (k *Worker) usualPlatformsFor(ctx context.Context, agencyID, stopID, line string) *Obj {
	o := O()
	if k.db == nil {
		return o
	}
	m := k.db.usualPlatforms(agencyID, stopID, line)
	for _, dir := range []string{"-1", "0", "1"} {
		if p, ok := m[dir]; ok {
			o.Set(dir, p)
		}
	}
	return o
}

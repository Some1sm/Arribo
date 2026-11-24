package main

// Position losses for trains, the rail counterpart of the buses' GPS gaps
// (GpsGapDetector in geo.go). A train's position "is lost" when the operator
// stops publishing a fresh one for it for at least that operator's
// staleness bound (trainStaleAfter: 180 s for Rodalies, 300 s for FGC,
// whose files are only refreshed about every 2 minutes) and at most
// railGapMaxMs, then publishes it again on the same trip. What is recorded
// is what the feed showed: where the train was last placed and where it
// reappeared; nothing is said about where it went in between. A loss that
// every other train of the operator shared is flagged feed-wide (an outage
// of the feed, not of the train), as for the buses.

const (
	railGapMaxMs     = 30 * 60 * 1000 // longer than this: a different service, not a loss
	rtMaxPendingGaps = 500            // queue bound between two worker drains
)

// noteGaps feeds this poll's trains to the operator's detector and queues
// the losses it closes. Runs on the poller's goroutine.
func (p *rtPoller) noteGaps(snap *rtSnapshot) {
	if snap == nil {
		return
	}
	if p.gapDet == nil {
		p.gapDet = newGpsGapDetectorFor(float64(trainStaleAfter(p.src.AgencyID))*1000, railGapMaxMs)
	}
	var out []*Obj
	for i := range snap.Vehicles {
		v := &snap.Vehicles[i]
		key := v.TripID
		if key == "" {
			key = v.VehicleID
		}
		if key == "" || (v.Lat == 0 && v.Lon == 0) {
			continue
		}
		t := float64(v.ObservedAt) * 1000
		if v.ObservedAt == 0 {
			t = float64(snap.FeedTimestamp) * 1000 // the feed's time when the train has none
			if v.Feed == "ld" && v.FeedTS > 0 {
				t = float64(v.FeedTS) * 1000 // a long-distance train: its own feed's time
			}
		}
		dir := ""
		if v.DirectionID >= 0 {
			dir = numToString(float64(v.DirectionID))
		}
		gap := p.gapDet.observe(O(
			"vehicleId", key,
			"lineCode", v.LineCode,
			"direction", dir,
			"lat", v.Lat,
			"lon", v.Lon,
			"observedAt", t,
			"toStop", v.StopName,
		))
		if gap != nil {
			gap.Set("agencyId", p.src.AgencyID)
			gap.Set("mode", "rail")
			out = append(out, gap)
		}
	}
	if len(out) == 0 {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.pendingGaps = append(p.pendingGaps, out...)
	if over := len(p.pendingGaps) - rtMaxPendingGaps; over > 0 {
		p.pendingGaps = append([]*Obj(nil), p.pendingGaps[over:]...)
	}
}

// takeRailGaps hands over the queued losses (for the worker).
func (p *rtPoller) takeRailGaps() []*Obj {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := p.pendingGaps
	p.pendingGaps = nil
	return out
}

// writeRailGaps stores the queued losses in gps_gaps, with the operator.
// Runs as a daemon task under the worker lock.
func (d *IngestionDaemon) writeRailGaps() {
	var batch []*Obj
	for _, p := range gtfsRtPollers {
		batch = append(batch, p.takeRailGaps()...)
	}
	if len(batch) == 0 {
		return
	}
	_ = d.db.withTx(func() error {
		for _, g := range batch {
			d.db.recordGpsGap(g)
		}
		return nil
	})
}

package main

// Station visits for trains, from GTFS-RT trip updates (phase 2, slice 3c of
// docs/catalonia-review/REPORT.md). A bus visit is detected from GPS near a
// stop; a train at 100 km/h polled every 30 s can skip a 30 m radius, so a
// rail visit comes from the operator's own per-stop predictions instead:
// while a stop is listed in its trip's update, its latest predicted and
// scheduled times are kept; when the stop leaves the list (the train has
// passed it) or its predicted time is well past, it closes as one visit
// with its last delay. Pure logic: the caller decides where visits go.

import (
	"context"
	"time"
)

// railVisit is one closed station visit.
type railVisit struct {
	AgencyID, Mode string
	TripID, StopID string
	ScheduledUnix  int64 // scheduled arrival (else departure)
	ActualUnix     int64 // last predicted time before the train passed
	DelaySec       int32
}

type openRailVisit struct {
	railVisit
	seen time.Time // last poll that listed this stop for this trip
}

// Plausibility bounds: outside them a delay is dropped (and counted), not
// recorded. Renfe's feed has been seen reporting -3240 s.
const (
	railMinDelaySec = -10 * 60
	railMaxDelaySec = 90 * 60
	// A stop still listed but predicted this long ago is taken as passed.
	railPastGrace = 2 * time.Minute
	// A trip missing from the feed this long is forgotten; its stops close
	// only if their predicted time had already passed.
	railTripGone = 10 * time.Minute
)

// railVisitTracker turns successive trip-update feeds into closed visits.
// Not safe for concurrent use; each poller owns one.
type railVisitTracker struct {
	agencyID, mode string
	open           map[string]*openRailVisit // trip_id + "\x00" + stop_id
	Implausible    int                       // delays dropped by the bounds, since start
}

func newRailVisitTracker(agencyID, mode string) *railVisitTracker {
	return &railVisitTracker{agencyID: agencyID, mode: mode, open: map[string]*openRailVisit{}}
}

// stuTimes is the scheduled and predicted unix time of one stop update:
// from its time and delay when the feed sends both (Renfe), else from its
// time or delay plus the imported timetable (FGC sends times only).
func stuTimes(ctx context.Context, tt *rtTimetable, tu *TripUpdate, s StopTimeUpdate) (sched, pred int64, ok bool) {
	ev := s.Arrival
	if ev == nil || (ev.Time == nil && ev.Delay == nil) {
		ev = s.Departure
	}
	if ev == nil || s.StopID == "" {
		return 0, 0, false
	}
	if ev.Time != nil && ev.Delay != nil {
		return *ev.Time - int64(*ev.Delay), *ev.Time, true
	}
	if tt == nil || tu.Trip.StartDate == "" {
		return 0, 0, false
	}
	ref, err := gtfsServiceDayRef(tu.Trip.StartDate)
	if err != nil {
		return 0, 0, false
	}
	sec, found := tt.scheduledSec(ctx, tu.Trip.TripID, s.StopID)
	if !found {
		return 0, 0, false
	}
	sched = ref.Unix() + sec
	switch {
	case ev.Time != nil:
		return sched, *ev.Time, true
	case ev.Delay != nil:
		return sched, sched + int64(*ev.Delay), true
	}
	return 0, 0, false
}

// observe folds one trip-update feed in and returns the visits that closed.
func (t *railVisitTracker) observe(ctx context.Context, now time.Time, tt *rtTimetable, fm *FeedMessage) []railVisit {
	listed := map[string]bool{}    // keys listed in this feed
	tripsSeen := map[string]bool{} // trips present in this feed
	for _, e := range fm.Entities {
		tu := e.TripUpdate
		if e.IsDeleted || tu == nil || tu.Trip.TripID == "" {
			continue
		}
		tripsSeen[tu.Trip.TripID] = true
		for _, s := range tu.StopTimeUpdates {
			sched, pred, ok := stuTimes(ctx, tt, tu, s)
			if !ok {
				continue
			}
			key := tu.Trip.TripID + "\x00" + s.StopID
			listed[key] = true
			v := t.open[key]
			if v == nil {
				v = &openRailVisit{railVisit: railVisit{AgencyID: t.agencyID, Mode: t.mode, TripID: tu.Trip.TripID, StopID: s.StopID}}
				t.open[key] = v
			}
			v.ScheduledUnix, v.ActualUnix, v.DelaySec, v.seen = sched, pred, int32(pred-sched), now
		}
	}
	var closed []railVisit
	for key, v := range t.open {
		passedByList := !listed[key] && tripsSeen[v.TripID]
		passedByTime := time.Unix(v.ActualUnix, 0).Before(now.Add(-railPastGrace))
		tripGone := !tripsSeen[v.TripID] && now.Sub(v.seen) > railTripGone
		switch {
		case passedByList || passedByTime || (tripGone && time.Unix(v.ActualUnix, 0).Before(now)):
			delete(t.open, key)
			if v.DelaySec < railMinDelaySec || v.DelaySec > railMaxDelaySec {
				t.Implausible++
				continue
			}
			closed = append(closed, v.railVisit)
		case tripGone:
			delete(t.open, key) // never reached as far as we know: no visit
		}
	}
	return closed
}

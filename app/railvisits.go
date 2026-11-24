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
	LineCode       string // route short name from the timetable (R2S, S1, ...)
	StopName       string // station name from the timetable
	ScheduledUnix  int64  // scheduled arrival (else departure)
	ActualUnix     int64  // last predicted time before the train passed
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
	railMaxDelaySec = 180 * 60 // Rodalies disruptions of an hour or more are real
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

// railOriginSlack: how much earlier than the trip's scheduled departure from
// its origin a prediction for a later stop may be before it is rejected.
// railFeedDisagree: how far a feed's own delay may differ from its predicted
// time against the timetable before the update is dropped as contradictory.
const (
	railOriginSlack  = 60     // seconds
	railFeedDisagree = 5 * 60 // seconds
)

// stuTimes is the scheduled and predicted unix time of one stop update.
//
// With the stop in the imported timetable, the scheduled time is the
// timetable's and the delay is predicted minus scheduled. Renfe sends both a
// time and a delay, but its delay has been seen disagreeing with its own
// time against the timetable. Small differences are its rounding (it sends
// whole minutes), so the timetable's second-precise delay is kept; beyond
// railFeedDisagree the two contradict each other (seen: "6 min early" by its
// delay, 14 min late by its time) and the update is dropped, since nothing
// says which one is right. Without a start_date (Renfe sends none) the
// service day is the one the feed's own scheduled time (time minus delay)
// falls in. FGC sends times only and a start_date. Without the stop in the
// timetable, a feed that sends time and delay is taken as it is.
//
// A prediction for a later stop that is earlier than the trip's scheduled
// departure from its first stop is rejected: the train cannot get there
// before it leaves, and trains do not leave their origin early. Renfe sends
// such predictions while a train waits at its origin (seen 2026-11-21: 10
// of the 13 trains waiting at their origin were predicted 9 to 73 minutes
// "early" at the next stop), and the small ones used to pass the −10 min
// bound and be recorded as early arrivals.
func stuTimes(ctx context.Context, tt *rtTimetable, tu *TripUpdate, s StopTimeUpdate) (sched, pred int64, ok bool) {
	ev := s.Arrival
	if ev == nil || (ev.Time == nil && ev.Delay == nil) {
		ev = s.Departure
	}
	if d := s.Departure; d != nil && (d.Time != nil || d.Delay != nil) && tt != nil && tt.originStop(ctx, tu.Trip.TripID) == s.StopID {
		ev = d // at the trip's first stop: its departure (see originStop)
	}
	if ev == nil || s.StopID == "" {
		return 0, 0, false
	}
	feedTimes := ev.Time != nil && ev.Delay != nil
	var sec int64
	found := false
	if tt != nil {
		sec, found = tt.scheduledSec(ctx, tu.Trip.TripID, s.StopID)
	}
	if !found {
		if feedTimes {
			return *ev.Time - int64(*ev.Delay), *ev.Time, true
		}
		return 0, 0, false
	}
	var ref time.Time
	var err error
	switch {
	case tu.Trip.StartDate != "":
		ref, err = gtfsServiceDayRef(tu.Trip.StartDate)
	case feedTimes:
		// The feed's scheduled time minus the timetable's offset is near the
		// service day's reference (local midnight); +12 h lands mid-day so a
		// few seconds either side cannot pick the wrong date.
		at := time.Unix(*ev.Time-int64(*ev.Delay)-sec, 0).Add(12 * time.Hour).In(madrid)
		ref, err = gtfsServiceDayRef(at.Format("20060102"))
	default:
		return 0, 0, false
	}
	if err != nil {
		return 0, 0, false
	}
	sched = ref.Unix() + sec
	switch {
	case ev.Time != nil:
		pred = *ev.Time
	default:
		pred = sched + int64(*ev.Delay)
	}
	if feedTimes {
		if diff := (pred - sched) - int64(*ev.Delay); diff > railFeedDisagree || diff < -railFeedDisagree {
			return 0, 0, false
		}
	}
	if orig, has := tt.originSec(ctx, tu.Trip.TripID); has && sec > orig && pred < ref.Unix()+orig-railOriginSlack {
		return 0, 0, false
	}
	return sched, pred, true
}

// observe folds one trip-update feed in and returns the visits that closed.
func (t *railVisitTracker) observe(ctx context.Context, now time.Time, tt *rtTimetable, fm *FeedMessage) []railVisit {
	listed := map[string]bool{}    // keys listed in this feed
	tripsSeen := map[string]bool{} // trips present in this feed
	for _, e := range fm.Entities {
		tu := e.TripUpdate
		// A cancelled trip makes no station visits.
		if e.IsDeleted || tu == nil || tu.Trip.TripID == "" || tu.Trip.ScheduleRelationship == gtfsTripCanceled {
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

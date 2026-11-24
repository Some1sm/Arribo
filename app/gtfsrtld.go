package main

// Renfe's long-distance GTFS-RT feeds (vehicle_positions_LD.pb and
// trip_updates_LD.pb, same host and licence as the commuter feed). Catalan
// regional trains (R11, R13-R17, RG1, RL3/RL4, RT1/RT2) can appear there and
// not in the commuter feed.
//
// What the LD feed is, as observed on 2026-11-24:
//   - vehicle label and trip_id start with the five-digit train number
//     (label "15916", trip_id "1591612026-11-23" = number + a segment digit +
//     a date, seen a day behind the day the train runs); route_id is empty and the entity carries no per-vehicle
//     timestamp (only the feed header's);
//   - one train can have several entities (segment digits 1, 2, 3...);
//   - its trip ids are NOT in the Cercanías static GTFS, whose ids look like
//     "5127M15916R11".
//
// So an LD train is only kept when its number matches exactly one trip of the
// imported Cercanías timetable (which fixes its line and direction); LD trains
// with no such trip (AVE, Avant, Alvia, MD to Lleida/Zaragoza...) are counted
// and dropped rather than shown without a line. Where a train is in both feeds
// the commuter entity wins: it has the line label, the platform and a
// timestamp of its own. Delays come from the LD trip updates, matched by
// number. Positions keep the commuter semantics (a reported position, which
// may be a station's coordinates for a stopped train).

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"strings"
	"time"
)

const (
	renfeLDVehicleURL = "https://gtfsrt.renfe.com/vehicle_positions_LD.pb"
	renfeLDTripURL    = "https://gtfsrt.renfe.com/trip_updates_LD.pb"
)

var (
	reLDTripID     = regexp.MustCompile(`^(\d{5})\d\d{4}-\d{2}-\d{2}$`)
	reStaticNumber = regexp.MustCompile(`^\d+M(\d{5})R\w+$`)
	reLabelNumber  = regexp.MustCompile(`-(\d{5})(?:-|$)`)
)

// ldTrainNumber is the train number of an LD trip id or vehicle label ("" if neither fits).
func ldTrainNumber(tripID, label string) string {
	if m := reLDTripID.FindStringSubmatch(tripID); m != nil {
		return m[1]
	}
	if len(label) == 5 && strings.Trim(label, "0123456789") == "" {
		return label
	}
	return ""
}

// ldServiceDate is the YYYYMMDD in an LD trip id ("" if it has none). It is
// not reliably the day the train runs: on 2026-11-24 every Catalan train in
// the feed carried "2026-11-23" (see ldCandidateDates).
func ldServiceDate(tripID string) string {
	if len(tripID) == 16 && reLDTripID.MatchString(tripID) {
		return strings.ReplaceAll(tripID[6:], "-", "")
	}
	return ""
}

// ldCandidateDates are the service dates to look an LD train up on, in order:
// the feed's own Madrid date, the day before (a train still running after
// midnight), then the date written in its trip id. Renfe's Cercanías
// timetable has one-day services, so the right day matters; the trip id's
// date was seen a day behind the trains it named.
func ldCandidateDates(tripID string, feedTS uint64) []string {
	now := time.Now()
	if feedTS > 0 {
		now = time.Unix(int64(feedTS), 0)
	}
	day := now.In(madrid)
	out := []string{day.Format("20060102"), day.AddDate(0, 0, -1).Format("20060102")}
	if d := ldServiceDate(tripID); d != "" && d != out[0] && d != out[1] {
		out = append(out, d)
	}
	return out
}

// ldTrip is the imported trip of LD train `number` (trip id `tripID`, feed
// header time feedTS), trying each of ldCandidateDates; "" when none or when
// the first day that has the number has it on several routes.
func (t *rtTimetable) ldTrip(ctx context.Context, number, tripID string, feedTS uint64) string {
	for _, date := range ldCandidateDates(tripID, feedTS) {
		switch trip := t.tripForNumberOn(ctx, number, date); trip {
		case "":
			continue
		case ldAmbiguous:
			return "" // an earlier day must not decide the line
		default:
			return trip
		}
	}
	return ""
}

// commuterTrainNumbers collects the numbers of the commuter feed's trains,
// from the label ("R15-15012-PLATF.(2)") and from the static trip id, which
// can differ (a label can carry another number than its trip id).
func commuterTrainNumbers(vs []rtVehicle) map[string]bool {
	out := map[string]bool{}
	for i := range vs {
		if m := reLabelNumber.FindStringSubmatch(vs[i].Label); m != nil {
			out[m[1]] = true
		}
		if m := reStaticNumber.FindStringSubmatch(strings.TrimSpace(vs[i].TripID)); m != nil {
			out[m[1]] = true
		}
	}
	return out
}

// tripsByNumber lists the imported timetable's trips for a train number
// (built on first use; the number is the digits after "M" in Renfe's trip
// id). A failed build is not kept: the next call tries again.
func (t *rtTimetable) tripsByNumber(ctx context.Context, number string) ([]string, bool) {
	t.numMu.Lock()
	defer t.numMu.Unlock()
	if t.byNumber == nil {
		byNumber, err := t.loadTripNumbers(ctx)
		if err != nil {
			return nil, false
		}
		t.byNumber = byNumber
	}
	return t.byNumber[number], true
}

func (t *rtTimetable) loadTripNumbers(ctx context.Context) (map[string][]string, error) {
	rows, err := t.db.QueryContext(ctx, `SELECT trip_id FROM trips`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]string{}
	for rows.Next() {
		var id string
		if rows.Scan(&id) != nil {
			continue
		}
		if m := reStaticNumber.FindStringSubmatch(strings.TrimSpace(id)); m != nil {
			out[m[1]] = append(out[m[1]], id)
		}
	}
	return out, rows.Err()
}

// tripForNumber is the one imported trip that runs train `number` on service
// date (YYYYMMDD): Renfe publishes the same number once per day-type service
// ("5127M15916R11", "5148M15916R11", ...), so the candidates are narrowed to
// the services active that day. "" when none is active or the active ones
// belong to different routes (then the line would be a guess). Cached,
// bounded.
func (t *rtTimetable) tripForNumber(ctx context.Context, number, date string) string {
	if v := t.tripForNumberOn(ctx, number, date); v != ldAmbiguous {
		return v
	}
	return ""
}

// ldAmbiguous is what tripForNumberOn answers when trips on different routes
// run the number that day (never a real trip id).
const ldAmbiguous = "?"

// tripForNumberOn is tripForNumber, telling "ambiguous" (ldAmbiguous) apart
// from "no trip that day" ("").
func (t *rtTimetable) tripForNumberOn(ctx context.Context, number, date string) string {
	key := "\x03" + number + "\x00" + date
	t.mu.Lock()
	if v, hit := t.names[key]; hit {
		t.mu.Unlock()
		return v
	}
	t.mu.Unlock()
	best, route, failed := "", "", false
	day, err := time.ParseInLocation("20060102", date, madrid)
	if err == nil {
		col := gtfsWeekdayColumn[day.Weekday()]
		q := `SELECT route_id FROM trips WHERE trip_id = ?2 AND service_id IN (
		    SELECT service_id FROM calendar WHERE start_date <= ?1 AND end_date >= ?1 AND ` + col + ` = 1
		    UNION SELECT service_id FROM calendar_dates WHERE date = ?1 AND exception_type = 1
		    EXCEPT SELECT service_id FROM calendar_dates WHERE date = ?1 AND exception_type = 2) LIMIT 1`
		ids, ok := t.tripsByNumber(ctx, number)
		failed = !ok
		for _, id := range ids {
			var r string
			if err := t.db.QueryRowContext(ctx, q, date, id).Scan(&r); err != nil {
				if !errors.Is(err, sql.ErrNoRows) {
					failed = true // a read error, not an inactive service
				}
				continue
			}
			if best == "" {
				best, route = id, r
			} else if r != route {
				best = ldAmbiguous // active trips on different routes: do not guess
				break
			}
		}
	}
	if failed {
		return "" // the candidates were not all read: no line this time, and nothing cached
	}
	t.mu.Lock()
	if t.names == nil || len(t.names) > 50000 {
		t.names = map[string]string{}
	}
	t.names[key] = best
	t.mu.Unlock()
	return best
}

// pollLDTrips reads the LD trip updates into delays by train number. A failure
// is kept for the snapshot and never affects the commuter feed.
func (p *rtPoller) pollLDTrips(ctx context.Context) {
	if p.src.ldTripURL == "" {
		return
	}
	delays := map[string]int32{}
	b, err := rtFetch(ctx, p.src.ldTripURL)
	if err == nil {
		var fm *FeedMessage
		if fm, err = decodeGtfsRealtime(b); err == nil {
			for _, e := range fm.Entities {
				if e.IsDeleted || e.TripUpdate == nil || e.TripUpdate.Trip.ScheduleRelationship == gtfsTripCanceled {
					continue
				}
				num := ldTrainNumber(e.TripUpdate.Trip.TripID, "")
				if num == "" {
					continue
				}
				if _, seen := delays[num]; seen {
					continue
				}
				if d := tripUpdateDelay(e.TripUpdate); d != nil {
					delays[num] = *d
				}
			}
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err != nil {
		p.ldTripsErr = err.Error()
		return // keep the previous delays until the next good poll
	}
	p.ldDelays, p.ldTripsErr = delays, ""
}

// appendLDVehicles adds the LD feed's regional trains to snap (see the file
// comment). Called on the poller goroutine, after the commuter vehicles.
func (p *rtPoller) appendLDVehicles(ctx context.Context, snap *rtSnapshot) {
	if p.src.ldVehicleURL == "" || p.tt == nil {
		return
	}
	p.mu.Lock()
	snap.LDTripsErr = p.ldTripsErr
	delays := p.ldDelays
	p.mu.Unlock()
	b, err := rtFetch(ctx, p.src.ldVehicleURL)
	var fm *FeedMessage
	if err == nil {
		fm, err = decodeGtfsRealtime(b)
	}
	if err != nil {
		snap.LDErr = err.Error()
		return
	}
	// Seen on 2026-11-24: the LD header an hour behind the commuter feed, and
	// its positions an hour old too (trains in both feeds were 4-75 km from
	// where the commuter feed had them). Such positions would only draw old
	// pins, so the whole feed is left out while it lags more than a train is
	// allowed to (trainStaleAfter); the lag is logged.
	if snap.FeedTimestamp > 0 && fm.Header.Timestamp > 0 && snap.FeedTimestamp > fm.Header.Timestamp &&
		float64(snap.FeedTimestamp-fm.Header.Timestamp) > trainStaleAfter(p.src.AgencyID) {
		snap.LDLagSec = int64(snap.FeedTimestamp - fm.Header.Timestamp)
		return
	}
	known := commuterTrainNumbers(snap.Vehicles)
	taken := map[string]bool{}
	for _, e := range fm.Entities {
		vp := e.Vehicle
		if e.IsDeleted || vp == nil || vp.Position == nil || vp.Trip == nil {
			continue
		}
		lat, lon := float64(vp.Position.Latitude), float64(vp.Position.Longitude)
		if p.src.bounds != nil && !p.src.bounds.contains(lat, lon) {
			continue
		}
		label := ""
		if vp.Vehicle != nil {
			label = vp.Vehicle.Label
		}
		num := ldTrainNumber(vp.Trip.TripID, label)
		if num == "" || known[num] || taken[num] {
			continue // in the commuter feed (it wins), or a second segment of a train already kept
		}
		trip := p.tt.ldTrip(ctx, num, vp.Trip.TripID, fm.Header.Timestamp)
		if trip == "" {
			snap.LDDropped++ // not a Rodalies trip that day (or ambiguous): no line to show it on
			continue
		}
		taken[num] = true
		v := rtVehicle{
			AgencyID: p.src.AgencyID, Mode: p.src.Mode, Lat: lat, Lon: lon,
			StopID: vp.StopID, TripID: trip, Label: num, Feed: "ld", FeedTS: fm.Header.Timestamp,
		}
		if vp.Vehicle != nil {
			v.VehicleID = vp.Vehicle.ID
		}
		if vp.CurrentStatus != nil {
			v.CurrentStatus = enumName(*vp.CurrentStatus, vehicleStatusNames)
		}
		if vp.Timestamp != nil {
			v.ObservedAt = int64(*vp.Timestamp)
		}
		if d, ok := delays[num]; ok {
			d := d
			v.DelaySec, v.HasDelayFromTripUpdate = &d, true
		}
		p.describeVehicle(ctx, &v)
		snap.Vehicles = append(snap.Vehicles, v)
		snap.LDVehicles++
	}
}

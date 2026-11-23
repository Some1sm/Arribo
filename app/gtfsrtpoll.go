package main

// Live GTFS-RT polling for operators beyond Mataró (phase 2 of
// docs/catalonia-review/REPORT.md). Opt-in with ARRIBO_GTFSRT=1: nothing
// reads the snapshots yet, so by default no request is made.
//
// Each feed has its own goroutine and keeps its latest decoded snapshot
// behind an atomic pointer. Pollers never take a World lock and never touch
// SQLite, the tracker or the flight recorder; future readers load the
// snapshot pointer.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// rtVehicle is one live vehicle as the history and fleet code will want it.
type rtVehicle struct {
	AgencyID, Mode         string
	VehicleID, Label       string
	TripID, RouteID        string
	StopID, CurrentStatus  string
	Lat, Lon               float64
	ObservedAt             int64 // unix seconds; 0 when the feed omits it
	DelaySec               *int32
	HasDelayFromTripUpdate bool
	DelayComputed          bool   // the delay was derived from predicted times and the timetable
	LineCode, StopName     string // from the imported timetable (line: else the label's prefix); "" if unknown
	DirectionID            int    // the trip's GTFS direction_id from the timetable; -1 if unknown
}

// rtSnapshot is a feed's latest state.
type rtSnapshot struct {
	AgencyID      string
	FetchedAt     time.Time
	FeedTimestamp uint64
	Vehicles      []rtVehicle
	TripDelays    map[string]int32    // trip_id -> trip-level delay in seconds
	TripUpdates   int                 // trip updates in the last feed, with or without a delay
	Computed      int                 // of TripDelays, how many came from predicted times vs the timetable
	ComputedTrips map[string]bool     // trip ids whose delay was computed (immutable once stored)
	Canceled      map[string]bool     // trip ids the operator marks cancelled (schedule_relationship CANCELED)
	TripStops     map[string][]string // stops (FGC: platforms) each trip update names, in feed order
	VehiclesErr   string
	TripsErr      string
}

// rtSource describes one operator's feeds.
type rtSource struct {
	AgencyID, Mode string
	// vehicleURL / tripURL return the protobuf URL to fetch (FGC's file URL
	// is looked up from its dataset record and cached).
	vehicleURL, tripURL func(context.Context) (string, error)
	// alertURL returns the service-alerts feed (nil: none); fetched every railAlertEvery.
	alertURL                func(context.Context) (string, error)
	vehicleEvery, tripEvery time.Duration
	bounds                  *GeoBounds // keep only vehicles inside (Renfe covers all of Spain)
	// staticURL is the operator's static GTFS zip, imported daily into the
	// timetable the poller uses; staticBBox cuts it down like --bbox.
	staticURL, staticBBox string
}

// rtPoller polls one rtSource.
type rtPoller struct {
	src                                      rtSource
	snap                                     atomic.Pointer[rtSnapshot]
	alerts                                   atomic.Pointer[[]railAlert] // latest service alerts (railalerts.go)
	mu                                       sync.Mutex                  // guards trips between the two loops
	trip                                     map[string]int32
	trips                                    int
	terr                                     string
	tt                                       *rtTimetable           // imported timetable, for feeds without delays (nil if absent)
	ttMod                                    time.Time              // modification time of the open timetable file
	logNext                                  bool                   // log the next snapshot (after a timetable opens)
	visits                                   *railVisitTracker      // station visits from trip updates (run goroutine only)
	pending                                  []railVisit            // closed visits waiting for the worker (guarded by mu)
	pendingCancels                           []railCancel           // cancelled trips waiting for the worker (guarded by mu)
	pendingPlatforms                         []railPlatformSighting // platform announcements waiting for the worker (guarded by mu)
	pendingGaps                              []*Obj                 // position losses waiting for the worker (guarded by mu; railgaps.go)
	gapDet                                   *GpsGapDetector        // this operator's position-loss detector (poller goroutine only)
	platSeen                                 map[string]int64       // trip+station already counted (poll goroutine only)
	closedVisits, droppedVisits, implausible int                    // counters (guarded by mu)
	computed                                 int                    // delays derived from predicted times in the last trip feed
	computedTrips                            map[string]bool        // which trips those were (guarded by mu; replaced, never mutated)
	canceled                                 map[string]bool        // trips marked CANCELED in the last trip feed (guarded by mu; replaced, never mutated)
	tripStops                                map[string][]string    // stops each trip update named in the last trip feed (guarded by mu; replaced, never mutated)
}

var cataloniaBounds = GeoBounds{MinLat: 40.5, MaxLat: 42.9, MinLon: 0.15, MaxLon: 3.4}

var rtHTTP = &http.Client{Timeout: 20 * time.Second}

const rtMaxBody = 32 << 20

// rtFetch GETs url and returns the body. Errors never include the URL.
func rtFetch(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, errors.New("bad request")
	}
	req.Header.Set("User-Agent", "arribo-gtfsrt/1")
	res, err := rtHTTP.Do(req)
	if err != nil {
		return nil, errors.New(nodeErrMessage(err))
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, rtMaxBody+1))
	if err != nil {
		return nil, errors.New(nodeErrMessage(err))
	}
	if len(b) > rtMaxBody {
		return nil, errors.New("body too large")
	}
	return b, nil
}

func fixedURL(u string) func(context.Context) (string, error) {
	return func(context.Context) (string, error) { return u, nil }
}

// fgcFileURL resolves an FGC Opendatasoft GTFS-RT dataset to its .pb file
// URL (the dataset holds one record whose "file" field points at it). The
// URL is cached; a failed fetch clears it so it is looked up again.
func fgcFileURL(dataset string) (resolve func(context.Context) (string, error), invalidate func()) {
	var mu sync.Mutex
	cached := ""
	resolve = func(ctx context.Context) (string, error) {
		mu.Lock()
		defer mu.Unlock()
		if cached != "" {
			return cached, nil
		}
		b, err := rtFetch(ctx, "https://dadesobertes.fgc.cat/api/explore/v2.1/catalog/datasets/"+dataset+"/records?limit=1")
		if err != nil {
			return "", err
		}
		var rec struct {
			Results []struct {
				File struct {
					URL string `json:"url"`
				} `json:"file"`
			} `json:"results"`
		}
		if json.Unmarshal(b, &rec) != nil || len(rec.Results) == 0 || rec.Results[0].File.URL == "" {
			return "", errors.New("dataset record has no file url")
		}
		cached = rec.Results[0].File.URL
		return cached, nil
	}
	invalidate = func() { mu.Lock(); cached = ""; mu.Unlock() }
	return resolve, invalidate
}

func defaultRtSources() []rtSource {
	fgcVP, fgcVPReset := fgcFileURL("vehicle-positions-gtfs_realtime")
	fgcTU, fgcTUReset := fgcFileURL("trip-updates-gtfs_realtime")
	fgcAL, fgcALReset := fgcFileURL("alerts-gtfs_realtime")
	retry := func(resolve func(context.Context) (string, error), reset func()) func(context.Context) (string, error) {
		return func(ctx context.Context) (string, error) {
			u, err := resolve(ctx)
			if err != nil {
				reset()
			}
			return u, err
		}
	}
	return []rtSource{
		{
			AgencyID: "renfe_rodalies", Mode: "rail",
			vehicleURL:   fixedURL("https://gtfsrt.renfe.com/vehicle_positions.pb"),
			tripURL:      fixedURL("https://gtfsrt.renfe.com/trip_updates.pb"),
			alertURL:     fixedURL("https://gtfsrt.renfe.com/alerts.pb"),
			vehicleEvery: 30 * time.Second, tripEvery: 30 * time.Second,
			bounds:     &cataloniaBounds,
			staticURL:  "https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip",
			staticBBox: "40.5,42.9,0.15,3.4",
		},
		{
			// FGC's open-data API allows 5,000 anonymous requests a day:
			// positions every 30 s (2,880) + trip updates every 90 s (960).
			AgencyID: "fgc", Mode: "rail",
			vehicleURL:   retry(fgcVP, fgcVPReset),
			tripURL:      retry(fgcTU, fgcTUReset),
			alertURL:     retry(fgcAL, fgcALReset),
			vehicleEvery: 30 * time.Second, tripEvery: 90 * time.Second,
			staticURL: "https://www.fgc.cat/google/google_transit.zip",
		},
	}
}

// pollTrips refreshes trip-level delays.
// syncTimetable (re)opens the imported timetable when the file appears or
// is replaced by a refresh; an open handle keeps reading the old file until
// then, so a refresh never breaks a lookup in progress.
func (p *rtPoller) syncTimetable() {
	path := gtfsTimetablePath(p.src.AgencyID)
	fi, err := os.Stat(path)
	if err != nil || fi.ModTime().Equal(p.ttMod) {
		return
	}
	tt, err := openRtTimetable(path)
	if err != nil || tt == nil {
		log.Printf("[GTFS-RT] %s: timetable not opened: %v", p.src.AgencyID, err)
		return
	}
	if p.tt != nil {
		_ = p.tt.db.Close()
	}
	p.tt, p.ttMod = tt, fi.ModTime()
	if routes, err := tt.catalogRoutes(context.Background()); err == nil {
		op := &rtCatalogOp{AgencyID: p.src.AgencyID, Mode: p.src.Mode, Lines: routes}
		// Line profiles (stations and geometry per direction) for the line
		// view; a failure leaves the catalog without them, not without lines.
		if profiles, err := tt.lineProfiles(context.Background()); err == nil {
			op.Profiles = map[string]*rtLineProfile{}
			for i := range profiles {
				op.Profiles[profiles[i].Code] = &profiles[i]
			}
		} else {
			log.Printf("[GTFS-RT] %s: line profiles not read: %v", p.src.AgencyID, err)
		}
		rtCatalog.Store(p.src.AgencyID, op)
	} else {
		log.Printf("[GTFS-RT] %s: timetable lines not read: %v", p.src.AgencyID, err)
	}
	p.logNext = true
	log.Printf("[GTFS-RT] %s: timetable opened (%s)", p.src.AgencyID, fi.ModTime().UTC().Format(time.RFC3339))
}

func (p *rtPoller) pollTrips(ctx context.Context) {
	p.syncTimetable()
	total, computed := 0, 0
	computedTrips := map[string]bool{}
	canceled := map[string]bool{}
	tripStops := map[string][]string{} // stops (platforms, for FGC) each trip update names
	var cancels []railCancel           // announced cancellations for the history database
	delays, err := func() (map[string]int32, error) {
		u, err := p.src.tripURL(ctx)
		if err != nil {
			return nil, err
		}
		b, err := rtFetch(ctx, u)
		if err != nil {
			return nil, err
		}
		fm, err := decodeGtfsRealtime(b)
		if err != nil {
			return nil, err
		}
		p.trackVisits(ctx, fm)
		out := map[string]int32{}
		for _, e := range fm.Entities {
			if e.IsDeleted || e.TripUpdate == nil || e.TripUpdate.Trip.TripID == "" {
				continue
			}
			total++
			// A cancelled trip (schedule_relationship CANCELED) has no delay:
			// departure boards and the planner must not offer it as running.
			if e.TripUpdate.Trip.ScheduleRelationship == gtfsTripCanceled {
				canceled[e.TripUpdate.Trip.TripID] = true
				if c, ok := cancelFor(ctx, p.tt, p.src.AgencyID, e.TripUpdate.Trip, time.Now()); ok {
					cancels = append(cancels, c)
				}
				continue
			}
			for _, s := range e.TripUpdate.StopTimeUpdates {
				if s.StopID != "" {
					tripStops[e.TripUpdate.Trip.TripID] = append(tripStops[e.TripUpdate.Trip.TripID], s.StopID)
				}
			}
			// Some feeds (FGC) send predicted times only, no delay: those
			// delays need the static timetable (slice 3).
			if d := tripUpdateDelay(e.TripUpdate); d != nil {
				out[e.TripUpdate.Trip.TripID] = *d
			} else if d := tripUpdateComputedDelay(ctx, p.tt, e.TripUpdate); d != nil {
				out[e.TripUpdate.Trip.TripID] = *d
				computedTrips[e.TripUpdate.Trip.TripID] = true
				computed++
			}
		}
		return out, nil
	}()
	if err == nil {
		p.queueCancels(cancels)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err != nil {
		p.terr = err.Error()
		return
	}
	p.trip, p.trips, p.computed, p.computedTrips, p.canceled, p.terr = delays, total, computed, computedTrips, canceled, ""
	p.tripStops = tripStops
}

// tripUpdateDelay is the trip-level delay, else the first stop event's.
func tripUpdateDelay(tu *TripUpdate) *int32 {
	if tu.Delay != nil {
		return tu.Delay
	}
	for _, s := range tu.StopTimeUpdates {
		if s.Arrival != nil && s.Arrival.Delay != nil {
			return s.Arrival.Delay
		}
		if s.Departure != nil && s.Departure.Delay != nil {
			return s.Departure.Delay
		}
	}
	return nil
}

// pollVehicles refreshes positions and publishes a new snapshot.
func (p *rtPoller) pollVehicles(ctx context.Context) {
	snap := &rtSnapshot{AgencyID: p.src.AgencyID, FetchedAt: time.Now()}
	p.mu.Lock()
	snap.TripDelays, snap.TripUpdates, snap.Computed, snap.ComputedTrips, snap.TripsErr = p.trip, p.trips, p.computed, p.computedTrips, p.terr
	snap.Canceled = p.canceled
	snap.TripStops = p.tripStops
	p.mu.Unlock()
	fm, err := func() (*FeedMessage, error) {
		u, err := p.src.vehicleURL(ctx)
		if err != nil {
			return nil, err
		}
		b, err := rtFetch(ctx, u)
		if err != nil {
			return nil, err
		}
		return decodeGtfsRealtime(b)
	}()
	if err != nil {
		// Keep the last good vehicles, marked with the error; their
		// ObservedAt says how old they are.
		if prev := p.snap.Load(); prev != nil {
			snap.Vehicles, snap.FeedTimestamp = prev.Vehicles, prev.FeedTimestamp
		}
		snap.VehiclesErr = err.Error()
		p.snap.Store(snap)
		return
	}
	snap.FeedTimestamp = fm.Header.Timestamp
	for _, e := range fm.Entities {
		vp := e.Vehicle
		if e.IsDeleted || vp == nil || vp.Position == nil {
			continue
		}
		lat, lon := float64(vp.Position.Latitude), float64(vp.Position.Longitude)
		if p.src.bounds != nil && !p.src.bounds.contains(lat, lon) {
			continue
		}
		v := rtVehicle{AgencyID: p.src.AgencyID, Mode: p.src.Mode, Lat: lat, Lon: lon, StopID: vp.StopID}
		if vp.Vehicle != nil {
			v.VehicleID, v.Label = vp.Vehicle.ID, vp.Vehicle.Label
		}
		if vp.Trip != nil {
			v.TripID, v.RouteID = vp.Trip.TripID, vp.Trip.RouteID
		}
		if vp.CurrentStatus != nil {
			v.CurrentStatus = enumName(*vp.CurrentStatus, vehicleStatusNames)
		}
		if vp.Timestamp != nil {
			v.ObservedAt = int64(*vp.Timestamp)
		}
		if d, ok := snap.TripDelays[v.TripID]; ok && v.TripID != "" {
			d := d
			v.DelaySec, v.HasDelayFromTripUpdate = &d, true
			v.DelayComputed = snap.ComputedTrips[v.TripID]
		}
		p.describeVehicle(ctx, &v)
		snap.Vehicles = append(snap.Vehicles, v)
	}
	p.notePlatforms(snap.Vehicles, time.Now())
	p.noteGaps(snap)
	p.snap.Store(snap)
}

// describeVehicle adds the line code and the station name from the
// imported timetable. Without a timetable line for the trip, the label's
// prefix ("R2S-28385" -> "R2S") is used only when it is one of the
// operator's catalog lines, so a label is never taken for a line it isn't.
// Runs on the poller's goroutine, which owns the timetable handle; the
// server only ever reads the finished snapshot.
func (p *rtPoller) describeVehicle(ctx context.Context, v *rtVehicle) {
	v.DirectionID = -1
	if p.tt != nil {
		if v.TripID != "" {
			v.LineCode = p.tt.tripLine(ctx, v.TripID)
			v.DirectionID = p.tt.tripDirection(ctx, v.TripID)
		}
		if v.StopID != "" {
			v.StopName = p.tt.stopName(ctx, v.StopID)
		}
	}
	if v.LineCode == "" {
		v.LineCode = catalogLineFromLabel(p.src.AgencyID, v.Label)
	}
}

// catalogLineFromLabel is the label's prefix before '-' when the operator's
// catalog has a line with that code, else "".
func catalogLineFromLabel(agencyID, label string) string {
	i := strings.IndexByte(label, '-')
	if i <= 0 {
		return ""
	}
	prefix := label[:i]
	c, ok := rtCatalog.Load(agencyID)
	if !ok {
		return ""
	}
	for _, r := range c.(*rtCatalogOp).Lines {
		if r.Code == prefix {
			return prefix
		}
	}
	return ""
}

// run polls until ctx ends. The first poll of each kind starts at once
// (trip updates first, so the first snapshot can carry delays).
func (p *rtPoller) run(ctx context.Context, wg *sync.WaitGroup) {
	defer wg.Done()
	defer func() {
		if p.tt != nil {
			_ = p.tt.db.Close()
		}
	}()
	p.pollTrips(ctx)
	p.pollVehicles(ctx)
	p.pollAlerts(ctx)
	p.logSnapshot()
	vt := time.NewTicker(p.src.vehicleEvery)
	tt := time.NewTicker(p.src.tripEvery)
	at := time.NewTicker(railAlertEvery)
	defer vt.Stop()
	defer tt.Stop()
	defer at.Stop()
	polls := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-tt.C:
			p.pollTrips(ctx)
		case <-at.C:
			p.pollAlerts(ctx)
		case <-vt.C:
			p.pollVehicles(ctx)
			polls++
			// About every 10 minutes, and right after a timetable opens.
			if polls%20 == 0 || p.logNext {
				p.logNext = false
				p.logSnapshot()
			}
		}
	}
}

func (p *rtPoller) logSnapshot() {
	s := p.snap.Load()
	if s == nil {
		return
	}
	withDelay := 0
	for _, v := range s.Vehicles {
		if v.HasDelayFromTripUpdate {
			withDelay++
		}
	}
	msg := fmt.Sprintf("[GTFS-RT] %s: %d vehicles (%d with a trip delay), %d trip updates (%d with a delay, %d computed from the timetable)", s.AgencyID, len(s.Vehicles), withDelay, s.TripUpdates, len(s.TripDelays), s.Computed)
	if len(s.TripDelays) > 0 {
		ds := make([]int, 0, len(s.TripDelays))
		for _, d := range s.TripDelays {
			ds = append(ds, int(d))
		}
		sort.Ints(ds)
		msg += fmt.Sprintf("; trip delay s min/median/max %d/%d/%d", ds[0], ds[len(ds)/2], ds[len(ds)-1])
	}
	if s.VehiclesErr != "" {
		msg += "; vehicles error: " + s.VehiclesErr
	}
	if s.TripsErr != "" {
		msg += "; trip updates error: " + s.TripsErr
	}
	p.mu.Lock()
	msg += fmt.Sprintf("; station visits closed %d (queued %d, implausible %d, dropped %d)", p.closedVisits, len(p.pending), p.implausible, p.droppedVisits)
	p.mu.Unlock()
	log.Print(msg)
}

// gtfsRtPollers holds the running pollers (nil unless ARRIBO_GTFSRT=1).
// Worker-side: read under the worker lock.
var gtfsRtPollers []*rtPoller

// rtLivePollers publishes the running pollers to the server world, which
// reads their snapshots (/api/trains) without any lock or database access.
// nil while the pollers are off or stopped.
var rtLivePollers atomic.Pointer[[]*rtPoller]

// startGtfsRtPollers starts one poller per source when ARRIBO_GTFSRT=1 and
// returns a function that stops them and waits for them to finish.
func startGtfsRtPollers() (stop func()) {
	if os.Getenv("ARRIBO_GTFSRT") != "1" {
		return func() {}
	}
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	// A restarted worker starts a fresh set; the stopped pollers of the
	// previous one must not be counted or drained again.
	gtfsRtPollers = nil
	for _, src := range defaultRtSources() {
		p := &rtPoller{src: src}
		gtfsRtPollers = append(gtfsRtPollers, p)
		wg.Add(1)
		go p.run(ctx, &wg)
	}
	wg.Add(1)
	go func(srcs []rtSource) {
		defer wg.Done()
		runTimetableRefresher(ctx, srcs)
	}(defaultRtSources())
	live := append([]*rtPoller(nil), gtfsRtPollers...)
	rtLivePollers.Store(&live)
	log.Printf("[GTFS-RT] polling %d operators (ARRIBO_GTFSRT=1)", len(gtfsRtPollers))
	return func() {
		rtLivePollers.CompareAndSwap(&live, nil)
		cancel()
		wg.Wait()
	}
}

// rtMaxPending bounds the closed visits waiting for the worker; the oldest
// are dropped (and counted) beyond it.
const rtMaxPending = 5000

// trackVisits folds a trip-update feed into the station-visit tracker and
// queues the visits that closed. With bounds set (Renfe's feed covers all
// of Spain) only trips in the area count: trips in the imported timetable,
// else trips of vehicles last seen inside the bounds.
func (p *rtPoller) trackVisits(ctx context.Context, fm *FeedMessage) {
	if p.visits == nil {
		p.visits = newRailVisitTracker(p.src.AgencyID, p.src.Mode)
	}
	if p.src.bounds != nil {
		var inArea map[string]bool
		if p.tt == nil {
			inArea = map[string]bool{}
			if s := p.snap.Load(); s != nil {
				for _, v := range s.Vehicles {
					inArea[v.TripID] = true
				}
			}
		}
		kept := make([]Entity, 0, len(fm.Entities))
		for _, e := range fm.Entities {
			if e.TripUpdate == nil {
				continue
			}
			id := e.TripUpdate.Trip.TripID
			if (p.tt != nil && p.tt.hasTrip(ctx, id)) || (p.tt == nil && inArea[id]) {
				kept = append(kept, e)
			}
		}
		fm = &FeedMessage{Header: fm.Header, Entities: kept}
	}
	closed := p.visits.observe(ctx, time.Now(), p.tt, fm)
	if p.tt != nil {
		for i := range closed {
			closed[i].LineCode = p.tt.tripLine(ctx, closed[i].TripID)
			closed[i].StopName = p.tt.stopName(ctx, closed[i].StopID)
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.pending = append(p.pending, closed...)
	if over := len(p.pending) - rtMaxPending; over > 0 {
		p.pending = append([]railVisit(nil), p.pending[over:]...)
		p.droppedVisits += over
	}
	p.closedVisits += len(closed)
	p.implausible = p.visits.Implausible
}

// takeRailVisits hands over the queued closed visits (for the worker).
func (p *rtPoller) takeRailVisits() []railVisit {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := p.pending
	p.pending = nil
	return out
}

// rtCatalogOp is one GTFS-RT operator's lines, read from its imported
// timetable and published for the line catalog. Immutable once stored.
type rtCatalogOp struct {
	AgencyID, Mode string
	Lines          []rtRoute
	Profiles       map[string]*rtLineProfile // line code -> profile (nil if not built)
}

// rtCatalog maps agency id -> *rtCatalogOp. Written by the pollers when a
// timetable (re)opens, read by the server's /api/lines without any lock or
// database access.
var rtCatalog sync.Map

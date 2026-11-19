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
}

// rtSnapshot is a feed's latest state.
type rtSnapshot struct {
	AgencyID      string
	FetchedAt     time.Time
	FeedTimestamp uint64
	Vehicles      []rtVehicle
	TripDelays    map[string]int32 // trip_id -> trip-level delay in seconds
	TripUpdates   int              // trip updates in the last feed, with or without a delay
	Computed      int              // of TripDelays, how many came from predicted times vs the timetable
	VehiclesErr   string
	TripsErr      string
}

// rtSource describes one operator's feeds.
type rtSource struct {
	AgencyID, Mode string
	// vehicleURL / tripURL return the protobuf URL to fetch (FGC's file URL
	// is looked up from its dataset record and cached).
	vehicleURL, tripURL     func(context.Context) (string, error)
	vehicleEvery, tripEvery time.Duration
	bounds                  *GeoBounds // keep only vehicles inside (Renfe covers all of Spain)
	// staticURL is the operator's static GTFS zip, imported daily into the
	// timetable the poller uses; staticBBox cuts it down like --bbox.
	staticURL, staticBBox string
}

// rtPoller polls one rtSource.
type rtPoller struct {
	src      rtSource
	snap     atomic.Pointer[rtSnapshot]
	mu       sync.Mutex // guards trips between the two loops
	trip     map[string]int32
	trips    int
	terr     string
	tt       *rtTimetable // imported timetable, for feeds without delays (nil if absent)
	ttMod    time.Time    // modification time of the open timetable file
	logNext  bool         // log the next snapshot (after a timetable opens)
	computed int          // delays derived from predicted times in the last trip feed
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
	p.logNext = true
	log.Printf("[GTFS-RT] %s: timetable opened (%s)", p.src.AgencyID, fi.ModTime().UTC().Format(time.RFC3339))
}

func (p *rtPoller) pollTrips(ctx context.Context) {
	p.syncTimetable()
	total, computed := 0, 0
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
		out := map[string]int32{}
		for _, e := range fm.Entities {
			if e.IsDeleted || e.TripUpdate == nil || e.TripUpdate.Trip.TripID == "" {
				continue
			}
			total++
			// Some feeds (FGC) send predicted times only, no delay: those
			// delays need the static timetable (slice 3).
			if d := tripUpdateDelay(e.TripUpdate); d != nil {
				out[e.TripUpdate.Trip.TripID] = *d
			} else if d := tripUpdateComputedDelay(ctx, p.tt, e.TripUpdate); d != nil {
				out[e.TripUpdate.Trip.TripID] = *d
				computed++
			}
		}
		return out, nil
	}()
	p.mu.Lock()
	defer p.mu.Unlock()
	if err != nil {
		p.terr = err.Error()
		return
	}
	p.trip, p.trips, p.computed, p.terr = delays, total, computed, ""
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
	snap.TripDelays, snap.TripUpdates, snap.Computed, snap.TripsErr = p.trip, p.trips, p.computed, p.terr
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
		}
		snap.Vehicles = append(snap.Vehicles, v)
	}
	p.snap.Store(snap)
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
	p.logSnapshot()
	vt := time.NewTicker(p.src.vehicleEvery)
	tt := time.NewTicker(p.src.tripEvery)
	defer vt.Stop()
	defer tt.Stop()
	polls := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-tt.C:
			p.pollTrips(ctx)
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
	log.Print(msg)
}

// gtfsRtPollers holds the running pollers (nil unless ARRIBO_GTFSRT=1).
var gtfsRtPollers []*rtPoller

// startGtfsRtPollers starts one poller per source when ARRIBO_GTFSRT=1 and
// returns a function that stops them and waits for them to finish.
func startGtfsRtPollers() (stop func()) {
	if os.Getenv("ARRIBO_GTFSRT") != "1" {
		return func() {}
	}
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
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
	log.Printf("[GTFS-RT] polling %d operators (ARRIBO_GTFSRT=1)", len(gtfsRtPollers))
	return func() {
		cancel()
		wg.Wait()
	}
}

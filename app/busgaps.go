package main

// Multi-operator bus signal-loss tracker (GPS dropouts + per-stop arrival
// prediction dropouts) for Dades "On perden el GPS els autobusos".
//
// Covers server-side real-time bus feeds (Moventis via AMB GPS + Moventis
// per-stop arrival predictions, AMB Bus via AMB GPS, Sagalés via sagales.com
// GPS) without ever writing unofficial feeds into SQLite history.db:
//   - Kept in memory (30-day rolling window, max 6 000 records) and persisted
//     atomically to DATA_DIR/bus_gaps.json.
//   - Two explicit signal modes:
//       * "gps":  vehicle GPS position lost for >= minGap and later regained
//                 (GpsGapDetector in geo.go).
//       * "stop": live stop arrival prediction ("real":"S") vanished before
//                 the bus could have arrived, plotted at the stop's coordinates.
//   - Outputs the exact JSON shape expected by /api/analytics/gps-gaps.

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	busGapRetention = 30 * 24 * time.Hour
	busGapMaxRecs   = 6000
	busGapSaveEvery = 3 * time.Minute
	busGapMaxCells  = 80

	// Per-stop arrival-loss thresholds (Moventis GetTiemposParada).
	stopLossMinEtaSec   = 180  // ignore buses already <= 3 min away (could arrive naturally)
	stopLossMaxEtaSec   = 1500 // ignore buses > 25 min away (near Moventis's ~40m horizon)
	stopLossEarlyBufSec = 120  // require >= 2 min remaining before expected arrival to flag dropout
	stopLossMinPollGap  = 60   // ignore back-to-back polls < 60 s apart
	stopLossMatchEarlyS = 300  // match same bus if expected arrival shifted -5m..+15m
	stopLossMatchLateS  = 900
)

type busGapRecord struct {
	ID          int64   `json:"id"`
	AgencyID    string  `json:"agencyId"`
	SignalMode  string  `json:"signalMode"` // "gps" or "stop"
	VehicleID   string  `json:"vehicleId"`
	LineCode    string  `json:"lineCode"`
	Direction   string  `json:"direction,omitempty"`
	LostTs      float64 `json:"lostTs"`
	RegainedTs  float64 `json:"regainedTs"`
	GapSec      float64 `json:"gapSec"`
	LostLat     float64 `json:"lostLat"`
	LostLon     float64 `json:"lostLon"`
	RegainedLat float64 `json:"regainedLat"`
	RegainedLon float64 `json:"regainedLon"`
	StopName    string  `json:"stopName,omitempty"`
	AtTerminal  bool    `json:"atTerminal,omitempty"`
	FeedWide    bool    `json:"feedWide,omitempty"`
}

type busStopWatch struct {
	LineCode   string
	StopID     int
	StopName   string
	Lat, Lon   float64
	LastSeen   time.Time
	ExpectedAt time.Time
}

type busGapStore struct {
	path string

	mu       sync.Mutex
	nextID   int64
	recs     []busGapRecord
	gpsDet   map[string]*GpsGapDetector // agencyID -> detector
	watches  map[[3]int]*busStopWatch   // (lineID, trayecto, stopID) -> active live countdown
	dirty    bool
	lastSave time.Time
}

var busGapsLive atomic.Pointer[busGapStore]

func busGapsFilePath() string {
	dir := os.Getenv("DATA_DIR")
	if dir == "" {
		dir = filepath.Join(appRoot, "data")
	}
	return filepath.Join(dir, "bus_gaps.json")
}

func startBusGapStore() (stop func()) {
	st := newBusGapStore(busGapsFilePath())
	busGapsLive.Store(st)
	return func() {
		busGapsLive.CompareAndSwap(st, nil)
		st.save(true)
	}
}

func newBusGapStore(path string) *busGapStore {
	s := &busGapStore{
		path:    path,
		nextID:  1,
		gpsDet:  map[string]*GpsGapDetector{},
		watches: map[[3]int]*busStopWatch{},
	}
	s.load()
	return s
}

func (s *busGapStore) load() {
	if s.path == "" {
		return
	}
	b, err := os.ReadFile(s.path)
	if err != nil {
		return
	}
	var list []busGapRecord
	if json.Unmarshal(b, &list) != nil {
		return
	}
	cutoff := float64(time.Now().Add(-busGapRetention).UnixMilli())
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range list {
		if r.LostTs >= cutoff && r.AgencyID != "" && r.LineCode != "" {
			if r.SignalMode == "" {
				r.SignalMode = "gps"
			}
			if r.ID >= s.nextID {
				s.nextID = r.ID + 1
			}
			s.recs = append(s.recs, r)
		}
	}
}

func (s *busGapStore) save(force bool) {
	if s == nil || s.path == "" {
		return
	}
	s.mu.Lock()
	if !s.dirty || (!force && time.Since(s.lastSave) < busGapSaveEvery) {
		s.mu.Unlock()
		return
	}
	cp := append([]busGapRecord(nil), s.recs...)
	s.dirty = false
	s.lastSave = time.Now()
	s.mu.Unlock()

	b, err := json.Marshal(cp)
	if err != nil {
		return
	}
	if os.MkdirAll(filepath.Dir(s.path), 0o755) != nil {
		return
	}
	tmp := s.path + ".tmp"
	if os.WriteFile(tmp, b, 0o644) == nil {
		_ = os.Rename(tmp, s.path)
	}
}

func (s *busGapStore) detectorFor(agencyID string) *GpsGapDetector {
	det := s.gpsDet[agencyID]
	if det != nil {
		return det
	}
	switch agencyID {
	case sagalesAgencyID:
		// Sagalés cycles 13 lines × 2 directions × 3 s ≈ 78 s between polls.
		det = newGpsGapDetectorFor(180*1000, 20*60*1000)
	default:
		// Moventis/AMB via AMB GPS (polled every 20 s): same 90 s..15 min bounds as Mataró Bus.
		det = newGpsGapDetector()
	}
	s.gpsDet[agencyID] = det
	return det
}

// observeGPS feeds one live GPS fix for an external bus operator and records
// any closed signal dropout into the rolling store.
func (s *busGapStore) observeGPS(agencyID, vehicleID, lineCode, direction, stopName string, lat, lon float64, observedMs float64) {
	if s == nil || agencyID == "" || vehicleID == "" || lineCode == "" || (lat == 0 && lon == 0) {
		return
	}
	s.mu.Lock()
	det := s.detectorFor(agencyID)
	gap := det.observe(O(
		"vehicleId", vehicleID,
		"lineCode", lineCode,
		"direction", direction,
		"lat", lat,
		"lon", lon,
		"observedAt", observedMs,
		"toStop", stopName,
	))
	if gap == nil {
		s.mu.Unlock()
		return
	}
	rec := busGapRecord{
		ID:          s.nextID,
		AgencyID:    agencyID,
		SignalMode:  "gps",
		VehicleID:   jsString(gap.Get("vehicleId")),
		LineCode:    jsString(gap.Get("lineCode")),
		Direction:   jsString(gap.Get("direction")),
		LostTs:      jsNumber(gap.Get("lostTs")),
		RegainedTs:  jsNumber(gap.Get("regainedTs")),
		GapSec:      jsNumber(gap.Get("gapSec")),
		LostLat:     jsNumber(gap.Get("lostLat")),
		LostLon:     jsNumber(gap.Get("lostLon")),
		RegainedLat: jsNumber(gap.Get("regainedLat")),
		RegainedLon: jsNumber(gap.Get("regainedLon")),
		StopName:    jsString(gap.Get("stopName")),
		AtTerminal:  truthy(gap.Get("atTerminal")),
		FeedWide:    truthy(gap.Get("feedWide")),
	}
	s.nextID++
	s.appendLocked(rec)
	s.mu.Unlock()
	s.save(false)
}

// observeMovStopArrivals inspects a valid Moventis stop response (GetTiemposParada)
// and records a per-stop signal loss whenever a previously tracked live bus
// ("real":"S") disappears from the stop's predictions well before its expected
// arrival time.
func (s *busGapStore) observeMovStopArrivals(static *movStatic, stopID int, etas []movStopETA, at time.Time) {
	if s == nil || static == nil || stopID <= 0 {
		return
	}
	// Resolve stop coordinates and name from static routes.
	stopName := ""
	stopLat, stopLon := 0.0, 0.0
	type routeRef struct {
		lineID   int
		trayecto int
		code     string
	}
	var serving []routeRef
	for lineID, rs := range static.Routes {
		code := static.Lines[lineID].Code
		if code == "" {
			continue
		}
		for _, rt := range rs {
			for _, st := range rt.Stops {
				if st.ID == stopID {
					if stopName == "" {
						stopName = st.Name
						stopLat, stopLon = st.Lat, st.Lon
					}
					serving = append(serving, routeRef{lineID: lineID, trayecto: rt.Trayecto, code: code})
					break
				}
			}
		}
	}
	if stopLat == 0 && stopLon == 0 {
		return
	}

	// Map incoming live predictions at this stop by (lineID, trayecto).
	liveByRoute := map[[2]int][]float64{}
	for _, e := range etas {
		if len(e.EtaSec) == 0 {
			continue
		}
		rt, ok := static.routeFor(e.LineID, stopID, e.Dest)
		if !ok {
			continue
		}
		k := [2]int{e.LineID, rt.Trayecto}
		liveByRoute[k] = append(liveByRoute[k], e.EtaSec...)
	}

	s.mu.Lock()
	var added bool
	for _, rr := range serving {
		wk := [3]int{rr.lineID, rr.trayecto, stopID}
		incoming := liveByRoute[[2]int{rr.lineID, rr.trayecto}]
		prev := s.watches[wk]

		if prev != nil {
			dtPoll := at.Sub(prev.LastSeen).Seconds()
			remSec := prev.ExpectedAt.Sub(at).Seconds()
			if remSec <= 0 {
				// Past expected arrival time: trip naturally arrived/passed.
				delete(s.watches, wk)
				prev = nil
			} else if dtPoll >= stopLossMinPollGap {
				// Check if any incoming live prediction matches this watched bus.
				matchedIdx := -1
				for i, sec := range incoming {
					candExp := at.Add(time.Duration(sec * float64(time.Second)))
					shift := candExp.Sub(prev.ExpectedAt).Seconds()
					if shift >= -stopLossMatchEarlyS && shift <= stopLossMatchLateS {
						matchedIdx = i
						break
					}
				}
				if matchedIdx >= 0 {
					// Still tracked: refresh watch.
					sec := incoming[matchedIdx]
					prev.LastSeen = at
					prev.ExpectedAt = at.Add(time.Duration(sec * float64(time.Second)))
					if sec < stopLossMinEtaSec {
						delete(s.watches, wk)
					}
				} else if remSec >= stopLossEarlyBufSec {
					// Vanished well before expected arrival -> record per-stop signal loss.
					gapSec := math.Max(90, math.Round(dtPoll))
					vehKey := fmt.Sprintf("S%d-%d", stopID, prev.ExpectedAt.Unix()/60)
					rec := busGapRecord{
						ID:          s.nextID,
						AgencyID:    movAgencyID,
						SignalMode:  "stop",
						VehicleID:   vehKey,
						LineCode:    rr.code,
						LostTs:      float64(prev.LastSeen.UnixMilli()),
						RegainedTs:  float64(at.UnixMilli()),
						GapSec:      gapSec,
						LostLat:     stopLat,
						LostLon:     stopLon,
						RegainedLat: stopLat,
						RegainedLon: stopLon,
						StopName:    stopName,
					}
					s.nextID++
					s.appendLocked(rec)
					added = true
					delete(s.watches, wk)
					prev = nil
				}
			}
		}

		// Start watching a newly observed mid-horizon live bus if none active.
		if prev == nil && len(incoming) > 0 {
			for _, sec := range incoming {
				if sec >= stopLossMinEtaSec && sec <= stopLossMaxEtaSec {
					s.watches[wk] = &busStopWatch{
						LineCode:   rr.code,
						StopID:     stopID,
						StopName:   stopName,
						Lat:        stopLat,
						Lon:        stopLon,
						LastSeen:   at,
						ExpectedAt: at.Add(time.Duration(sec * float64(time.Second))),
					}
					break
				}
			}
		}
	}
	// Prune stale watches (> 45 min old).
	if len(s.watches) > 500 {
		for k, w := range s.watches {
			if at.Sub(w.LastSeen) > 45*time.Minute {
				delete(s.watches, k)
			}
		}
	}
	s.mu.Unlock()
	if added {
		s.save(false)
	}
}

func (s *busGapStore) appendLocked(rec busGapRecord) {
	s.recs = append(s.recs, rec)
	s.dirty = true
	if len(s.recs) > busGapMaxRecs {
		cutoff := float64(time.Now().Add(-busGapRetention).UnixMilli())
		kept := s.recs[:0]
		for _, r := range s.recs {
			if r.LostTs >= cutoff {
				kept = append(kept, r)
			}
		}
		if len(kept) > busGapMaxRecs {
			kept = kept[len(kept)-busGapMaxRecs:]
		}
		s.recs = append([]busGapRecord(nil), kept...)
	}
}

// nearestStopForCoord finds the closest stop name (within 350 m) on a line
// from movStatic or rtCatalog so AMB/Moventis GPS gaps carry readable stop names.
func nearestStopNameForBus(agencyID, lineCode string, lat, lon float64) string {
	bestName := ""
	bestKm := 0.35
	check := func(name string, sLat, sLon float64) {
		if name == "" || (sLat == 0 && sLon == 0) {
			return
		}
		if d := haversineKm(lat, lon, sLat, sLon); d < bestKm {
			bestKm = d
			bestName = name
		}
	}
	if agencyID == movAgencyID {
		if mp := movLive.Load(); mp != nil {
			if snap := mp.snap.Load(); snap != nil && snap.Static != nil {
				want := ambNormLine(lineCode)
				for id, l := range snap.Static.Lines {
					if ambNormLine(l.Code) != want {
						continue
					}
					for _, rt := range snap.Static.Routes[id] {
						for _, st := range rt.Stops {
							check(st.Name, st.Lat, st.Lon)
						}
					}
				}
			}
		}
		return bestName
	}
	if v, ok := rtCatalog.Load(agencyID); ok {
		op := v.(*rtCatalogOp)
		if prof := op.Profiles[lineCode]; prof != nil {
			for _, d := range prof.Directions {
				for _, st := range d.Stops {
					check(st.Name, st.Lat, st.Lon)
				}
			}
		}
	}
	return bestName
}

// hotspots builds the /api/analytics/gps-gaps payload for an agency and signal
// mode ("gps" or "stop"), matching HistoryDB.getGpsGapHotspots's JSON schema.
func (s *busGapStore) hotspots(agencyID, signalMode, lineCode, vehicleID string, days, now float64) *Obj {
	if signalMode != "stop" {
		signalMode = "gps"
	}
	d := math.Min(30, math.Max(1, jsRound(days)))
	if math.IsNaN(d) || d <= 0 {
		d = 7
	}
	since := now - d*86400*1000
	wantLine := strings.ToUpper(strings.TrimSpace(lineCode))
	if wantLine == "ALL" {
		wantLine = ""
	}
	wantVeh := strings.TrimSpace(vehicleID)

	var matched []*Obj
	var mapped []*Obj
	lineSet := map[string]bool{}
	atTerm, feedWide := 0.0, 0.0

	if s != nil {
		s.mu.Lock()
		for i := len(s.recs) - 1; i >= 0; i-- {
			r := s.recs[i]
			if r.AgencyID != agencyID || r.SignalMode != signalMode {
				continue
			}
			if r.LostTs < since || r.LostTs >= now {
				continue
			}
			lineSet[r.LineCode] = true
			if wantLine != "" && strings.ToUpper(r.LineCode) != wantLine {
				continue
			}
			if wantVeh != "" && r.VehicleID != wantVeh {
				continue
			}
			o := O(
				"id", float64(r.ID),
				"vehicleId", r.VehicleID,
				"lineCode", r.LineCode,
				"lostTs", r.LostTs,
				"gapSec", r.GapSec,
				"lostLat", r.LostLat,
				"lostLon", r.LostLon,
				"regainedLat", r.RegainedLat,
				"regainedLon", r.RegainedLon,
				"stopName", r.StopName,
				"atTerminal", r.AtTerminal,
				"feedWide", r.FeedWide,
			)
			matched = append(matched, o)
			if r.AtTerminal {
				atTerm++
			} else if r.FeedWide {
				feedWide++
			} else {
				mapped = append(mapped, o)
			}
		}
		s.mu.Unlock()
	}

	groups := clusterPoints(clusterInput(mapped), 100)
	type cellT struct {
		o         *Obj
		count     float64
		vehicles  float64
		lastTs    float64
		memberIDs []any
	}
	var cells []*cellT
	for _, g := range groups {
		rs := g.Members
		vs := map[string]bool{}
		var lines []string
		var gaps []float64
		nameCount := map[string]int{}
		maxGap, lastTs := math.Inf(-1), math.Inf(-1)
		var ids []any
		var sumLat, sumLon, sumRLat, sumRLon float64
		for _, r := range rs {
			vs[jsString(r.Get("vehicleId"))] = true
			lines = append(lines, jsString(r.Get("lineCode")))
			gs := jsNumber(r.Get("gapSec"))
			gaps = append(gaps, gs)
			maxGap = math.Max(maxGap, gs)
			lastTs = math.Max(lastTs, jsNumber(r.Get("lostTs")))
			if sn := jsString(r.Get("stopName")); sn != "" {
				nameCount[sn]++
			}
			ids = append(ids, r.Get("id"))
			sumLat += jsNumber(r.Get("lostLat"))
			sumLon += jsNumber(r.Get("lostLon"))
			sumRLat += jsNumber(r.Get("regainedLat"))
			sumRLon += jsNumber(r.Get("regainedLon"))
		}
		bestName, bestN := "", 0
		for nm, cnt := range nameCount {
			if cnt > bestN || (cnt == bestN && nm < bestName) {
				bestName, bestN = nm, cnt
			}
		}
		n := float64(len(rs))
		mean := func(v float64) float64 { return jsRound(v/n*1e6) / 1e6 }
		nv := float64(len(vs))
		gapIDs := ids
		if len(gapIDs) > 12 {
			gapIDs = gapIDs[:12]
		}
		c := &cellT{count: n, vehicles: nv, lastTs: lastTs, memberIDs: ids}
		c.o = O(
			"lat", mean(sumLat),
			"lon", mean(sumLon),
			"regainedLat", mean(sumRLat),
			"regainedLon", mean(sumRLon),
			"count", n,
			"vehicles", nv,
			"lines", sortedUniqueStrings(lines),
			"medianGapSec", medianOrNull(gaps),
			"maxGapSec", maxGap,
			"stopName", bestName,
			"lastTs", lastTs,
			"recurrent", n >= 3 && nv >= 2,
			"gapIds", gapIDs,
		)
		cells = append(cells, c)
	}
	sort.SliceStable(cells, func(i, j int) bool {
		if cells[i].count != cells[j].count {
			return cells[i].count > cells[j].count
		}
		if cells[i].vehicles != cells[j].vehicles {
			return cells[i].vehicles > cells[j].vehicles
		}
		return cells[i].lastTs > cells[j].lastTs
	})
	inRecurrent := 0.0
	for _, c := range cells {
		if truthy(c.o.Get("recurrent")) {
			inRecurrent += c.count
		}
	}
	if len(cells) > busGapMaxCells {
		cells = cells[:busGapMaxCells]
	}
	cellOf := map[string]float64{}
	cellObjs := make([]any, 0, len(cells))
	for i, c := range cells {
		cellObjs = append(cellObjs, c.o)
		for _, id := range c.memberIDs {
			cellOf[jsString(id)] = float64(i)
		}
	}

	vehSet := map[string]bool{}
	var allGapsSec []float64
	gapOut := make([]any, 0, len(mapped))
	for _, r := range mapped {
		vehSet[jsString(r.Get("vehicleId"))] = true
		allGapsSec = append(allGapsSec, jsNumber(r.Get("gapSec")))
		if len(gapOut) < 400 {
			gObj := O(
				"id", r.Get("id"),
				"vehicleId", r.Get("vehicleId"),
				"lineCode", r.Get("lineCode"),
				"lostTs", r.Get("lostTs"),
				"gapSec", r.Get("gapSec"),
				"lostLat", r.Get("lostLat"),
				"lostLon", r.Get("lostLon"),
				"regainedLat", r.Get("regainedLat"),
				"regainedLon", r.Get("regainedLon"),
				"stopName", r.Get("stopName"),
			)
			if ci, ok := cellOf[jsString(r.Get("id"))]; ok {
				gObj.Set("cell", ci)
			}
			gapOut = append(gapOut, gObj)
		}
	}

	var recShare any
	if len(mapped) > 0 {
		recShare = jsRound(inRecurrent * 100 / float64(len(mapped)))
	}
	linesOut := make([]string, 0, len(lineSet))
	for c := range lineSet {
		linesOut = append(linesOut, c)
	}
	sort.Strings(linesOut)

	return O(
		"days", d,
		"agency", agencyID,
		"signalMode", signalMode,
		"lineCode", wantLine,
		"vehicleId", wantVeh,
		"hide", "",
		"hidden", []any{},
		"since", since,
		"until", now,
		"lines", stringsToAny(linesOut),
		"totals", O(
			"gaps", float64(len(matched)),
			"mapped", float64(len(mapped)),
			"atTerminal", atTerm,
			"feedWide", feedWide,
			"vehicles", float64(len(vehSet)),
			"medianGapSec", medianOrNull(allGapsSec),
			"recurrentShare", recShare,
		),
		"cells", cellObjs,
		"gaps", gapOut,
		"buses", []any{},
		"fleet", O("inService", 0.0, "withoutLoss", 0.0),
	)
}

// gapAgenciesMeta returns the list of operators available in the "Where buses
// lose GPS / signal" selector, including whether each supports per-stop
// arrival-loss mode.
func gapAgenciesMeta() []any {
	out := []any{
		O("id", mataroAgency.ID, "name", "Mataró Bus", "mode", "bus", "supportsStopMode", false),
	}
	if movLive.Load() != nil {
		out = append(out, O("id", movAgencyID, "name", "Moventis", "mode", "bus", "supportsStopMode", true))
	}
	if ambVehLive.Load() != nil {
		out = append(out, O("id", ambAgencyID, "name", "AMB Bus", "mode", "bus", "supportsStopMode", false))
	}
	if sagalesLive.Load() != nil {
		out = append(out, O("id", sagalesAgencyID, "name", "Sagalés", "mode", "bus", "supportsStopMode", false))
	}
	for _, op := range reportOperators {
		if _, ok := rtCatalog.Load(op.ID); ok {
			out = append(out, O("id", op.ID, "name", op.ShortName, "mode", op.Mode, "supportsStopMode", false))
		}
	}
	return out
}

// gapLinesForAgency returns the known line codes for an operator's GPS-gap filter pills.
func gapLinesForAgency(agencyID string) []any {
	if agencyID == "" || agencyID == mataroAgency.ID {
		return []any{"L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"}
	}
	if agencyID == movAgencyID {
		if mp := movLive.Load(); mp != nil {
			if snap := mp.snap.Load(); snap != nil && snap.Static != nil {
				out := make([]any, 0, len(snap.Lines))
				for _, id := range snap.Lines {
					if c := snap.Static.Lines[id].Code; c != "" {
						out = append(out, c)
					}
				}
				return out
			}
		}
	}
	if v, ok := rtCatalog.Load(agencyID); ok {
		op := v.(*rtCatalogOp)
		out := make([]any, 0, len(op.Lines))
		for _, r := range op.Lines {
			if r.Code != "" {
				out = append(out, r.Code)
			}
		}
		return out
	}
	return []any{}
}

func isBusGapStoreAgency(agencyID string) bool {
	return agencyID == movAgencyID || agencyID == ambAgencyID || agencyID == sagalesAgencyID
}

// classifyAmbVehicleAgency assigns an AMB /bus/vehicles entry to "moventis"
// (returning the canonical Moventis code, e.g. "C-10") if the line is followed
// by movLive, otherwise to "amb".
func classifyAmbVehicleAgency(rawLine string) (agencyID, canonicalCode string) {
	norm := ambNormLine(rawLine)
	if mp := movLive.Load(); mp != nil {
		if snap := mp.snap.Load(); snap != nil && snap.Static != nil {
			for _, id := range snap.Lines {
				if l, ok := snap.Static.Lines[id]; ok && ambNormLine(l.Code) == norm {
					return movAgencyID, l.Code
				}
			}
		}
	}
	return ambAgencyID, strings.TrimSpace(rawLine)
}

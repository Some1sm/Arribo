package main

// Sagalés (plan step 6.2 — Granollers, Mataró–Granollers/Argentona/Canyamars,
// Pineda–Calella, LloretBus, Girona Airport, Vallès):
//
// Polls the public website JSON at
//   https://www.sagales.com/es/real-time-bus/{routeId}/{dir}[?bus=true]
//
// Quirks handled (docs/research/catalonia-2026/03 & 05):
//   - Position key is misspelt `postion` (lat/lon/bearing/speed).
//   - Timestamps (vehicle.timestamp, arrival.time, departure.time) are unix ms.
//   - One physical bus (`vehicle.vehicle.id`) is repeated for each upcoming trip:
//     deduplicated to keep the active/earliest real-time trip per bus.
//   - Route geometry in `ruta.shapes` is a Google encoded polyline (precision 1e5).
//   - Unofficial public source: gated behind ARRIBO_SAGALES=1, labelled
//     "font no oficial", no SQLite history writes.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	sagalesAgencyID     = "sagales"
	sagalesBaseURL      = "https://www.sagales.com/es/real-time-bus"
	sagalesUserAgent    = "Mozilla/5.0 (compatible; Arribo transit observatory)"
	sagalesAttribution  = "Sagalés (font no oficial)"
	sagalesMinGap       = 3 * time.Second
	sagalesStaticMaxAge = 20 * time.Hour
	sagalesStaleSec     = 300 // 5 min GPS freshness
)

// sagalesDefaultLines: high-value Mataró/Maresme, Vallès, and Girona Sagalés lines:
//
//	550 Mataró-Granollers, 551 Mataró-Canyamars, 553/554 Mataró-Argentona,
//	400 Barcelona-Granollers, 405 BCN-La Roca-Cardedeu, 691 Pineda-Calella,
//	601 Blanes-Girona, 604 BCN-Aeroport Girona, 617 e4 Lloret-Girona,
//	671/672/673 LloretBus L011-L013.
var sagalesDefaultLines = []int{550, 551, 553, 554, 400, 405, 691, 601, 604, 617, 671, 672, 673}

var sagalesOperator = operatorInfo{
	ID: sagalesAgencyID, Name: "Sagalés", ShortName: "Sagalés",
	Mode: "bus", Tier: "measured", Method: "operator_gps",
	Source: "Posició GPS i previsions de pas publicades per sagales.com (font no oficial).",
}

type sagalesStop struct {
	ID       string
	Code     string
	Name     string
	Lat, Lon float64
	Seq      int
	OnDemand bool
}

type sagalesDirMeta struct {
	DirID    int
	Headsign string
	Stops    []sagalesStop
	Coords   [][2]float64
}

type sagalesLineMeta struct {
	RouteID   int
	Code      string // shortName (e.g. "550", "e4", "L011")
	Name      string // longName
	Color     string
	TextColor string
	Dirs      [2]*sagalesDirMeta
	FetchedAt time.Time
}

type sagalesBus struct {
	VehicleID  string
	LineCode   string
	RouteID    int
	DirID      int
	TripID     string
	Headsign   string
	StopID     string
	StopName   string
	Status     string
	Lat, Lon   float64
	Bearing    float64
	Speed      float64
	ObservedMs int64
	DelaySec   *int32
}

type sagalesStopPred struct {
	LineCode  string
	DirID     int
	Headsign  string
	VehicleID string
	TripID    string
	StopID    string
	ArriveMs  int64
	DelaySec  *int32
	RealTime  bool
}

type sagalesPoller struct {
	lineIDs []int
	baseURL string
	client  *http.Client

	mu       sync.RWMutex
	lines    map[int]*sagalesLineMeta
	byCode   map[string]int               // uppercase code -> routeID
	buses    map[string][]sagalesBus      // "routeID:dir" -> deduplicated active buses
	preds    map[string][]sagalesStopPred // "routeID:stopID" -> upcoming stop predictions
	stopName map[string]string            // stopID -> name
	lastPoll time.Time
	lastErr  string
	cycles   int
}

var sagalesLive atomic.Pointer[sagalesPoller]

// decodeSagalesPolyline decodes a Google encoded polyline (precision 1e5) into
// [lat, lon] pairs (internal Arribo order).
func decodeSagalesPolyline(enc string) [][2]float64 {
	if enc == "" {
		return nil
	}
	var pts [][2]float64
	idx, lat, lon := 0, 0, 0
	n := len(enc)
	decodeVal := func() (int, bool) {
		var shift, res uint
		for idx < n {
			b := int(enc[idx]) - 63
			idx++
			if b < 0 {
				return 0, false
			}
			res |= uint(b&0x1f) << shift
			shift += 5
			if b < 0x20 {
				if res&1 != 0 {
					return ^int(res >> 1), true
				}
				return int(res >> 1), true
			}
		}
		return 0, false
	}
	for idx < n {
		dLat, ok1 := decodeVal()
		if !ok1 {
			break
		}
		dLon, ok2 := decodeVal()
		if !ok2 {
			break
		}
		lat += dLat
		lon += dLon
		pts = append(pts, [2]float64{float64(lat) / 1e5, float64(lon) / 1e5})
	}
	return pts
}

type sagalesRawPayload struct {
	Linia *struct {
		ID        string `json:"id"`
		ShortName string `json:"shortName"`
		LongName  string `json:"longName"`
		Color     string `json:"color"`
		TextColor string `json:"textColor"`
	} `json:"linia"`
	Ruta *struct {
		Shapes string `json:"shapes"`
		Stops  []struct {
			ID           json.Number `json:"id"`
			StopCode     string      `json:"stopCode"`
			StopName     string      `json:"stopName"`
			StopLat      json.Number `json:"stopLat"`
			StopLon      json.Number `json:"stopLon"`
			StopSequence int         `json:"stopsequence"`
			OnDemand     int         `json:"onDemand"`
		} `json:"stops"`
	} `json:"ruta"`
	Bus *struct {
		Entities []struct {
			ID         string `json:"id"`
			TripUpdate *struct {
				StopTimeUpdate []struct {
					StopID   string `json:"stopId"`
					RealTime bool   `json:"realTime"`
					Arrival  *struct {
						Delay *int32 `json:"delay"`
						Time  int64  `json:"time"`
					} `json:"arrival"`
					Departure *struct {
						Delay *int32 `json:"delay"`
						Time  int64  `json:"time"`
					} `json:"departure"`
				} `json:"stopTimeUpdate"`
			} `json:"tripUpdate"`
			Vehicle *struct {
				CurrentStatus string `json:"currentStatus"`
				StopID        string `json:"stopId"`
				Timestamp     int64  `json:"timestamp"`
				Postion       *struct {
					Latitude  float64 `json:"latitude"`
					Longitude float64 `json:"longitude"`
					Bearing   float64 `json:"bearing"`
					Speed     float64 `json:"speed"`
				} `json:"postion"`
				Trip *struct {
					TripID         string `json:"tripId"`
					DirectionID    string `json:"directionId"`
					HeadSign       string `json:"headSign"`
					RouteShortName string `json:"routeShortName"`
				} `json:"trip"`
				Vehicle *struct {
					ID    string `json:"id"`
					Label string `json:"label"`
				} `json:"vehicle"`
			} `json:"vehicle"`
		} `json:"entities"`
	} `json:"bus"`
}

func parseSagalesColor(hex string) string {
	h := strings.TrimPrefix(strings.TrimSpace(hex), "#")
	if len(h) == 6 {
		return "#" + strings.ToUpper(h)
	}
	return ""
}

// parseSagalesResponse decodes one /es/real-time-bus/{routeId}/{dir} JSON body,
// extracting optional static route metadata, deduplicated live GPS vehicles,
// and upcoming stop predictions.
func parseSagalesResponse(routeID, dirID int, lineCodeFallback string, stopNames map[string]string, body []byte, now time.Time) (
	meta *sagalesDirMeta,
	code, name, color, textColor string,
	buses []sagalesBus,
	preds []sagalesStopPred,
	err error,
) {
	var raw sagalesRawPayload
	if err = json.Unmarshal(body, &raw); err != nil {
		return
	}
	code = lineCodeFallback
	if raw.Linia != nil {
		if s := strings.TrimSpace(raw.Linia.ShortName); s != "" {
			code = s
		}
		name = strings.TrimSpace(raw.Linia.LongName)
		color = parseSagalesColor(raw.Linia.Color)
		textColor = parseSagalesColor(raw.Linia.TextColor)
	}
	if code == "" {
		code = strconv.Itoa(routeID)
	}

	if raw.Ruta != nil && len(raw.Ruta.Stops) > 0 {
		stops := make([]sagalesStop, 0, len(raw.Ruta.Stops))
		for _, s := range raw.Ruta.Stops {
			lat, e1 := s.StopLat.Float64()
			lon, e2 := s.StopLon.Float64()
			if e1 != nil || e2 != nil || (lat == 0 && lon == 0) {
				continue
			}
			id := strings.TrimSpace(s.ID.String())
			if id == "" {
				id = strings.TrimSpace(s.StopCode)
			}
			stops = append(stops, sagalesStop{
				ID:       id,
				Code:     strings.TrimSpace(s.StopCode),
				Name:     strings.TrimSpace(s.StopName),
				Lat:      lat,
				Lon:      lon,
				Seq:      s.StopSequence,
				OnDemand: s.OnDemand != 0,
			})
		}
		sort.SliceStable(stops, func(i, j int) bool { return stops[i].Seq < stops[j].Seq })
		hs := ""
		if len(stops) > 0 {
			hs = stops[len(stops)-1].Name
		}
		meta = &sagalesDirMeta{
			DirID:    dirID,
			Headsign: hs,
			Stops:    stops,
			Coords:   decodeSagalesPolyline(raw.Ruta.Shapes),
		}
	}

	if raw.Bus == nil || len(raw.Bus.Entities) == 0 {
		return
	}

	// Deduplicate by physical bus vehicle.id (Sagalés repeats one bus per
	// upcoming trip). Keep the entity with the earliest upcoming real-time stop
	// (or freshest observation timestamp on a tie).
	type bestCand struct {
		bus       sagalesBus
		nextArrMs int64
	}
	byVeh := map[string]bestCand{}
	nowMs := now.UnixMilli()

	for _, e := range raw.Bus.Entities {
		var delay *int32
		var earliestMs int64
		vehID, tripID, hs := "", "", ""
		if e.Vehicle != nil {
			if e.Vehicle.Vehicle != nil {
				vehID = strings.TrimSpace(e.Vehicle.Vehicle.ID)
				if vehID == "" {
					vehID = strings.TrimSpace(e.Vehicle.Vehicle.Label)
				}
			}
			if e.Vehicle.Trip != nil {
				tripID = strings.TrimSpace(e.Vehicle.Trip.TripID)
				hs = strings.TrimSpace(e.Vehicle.Trip.HeadSign)
			}
		}
		if e.TripUpdate != nil {
			for _, stu := range e.TripUpdate.StopTimeUpdate {
				var tMs int64
				var d *int32
				if stu.Arrival != nil && stu.Arrival.Time > 0 {
					tMs = stu.Arrival.Time
					d = stu.Arrival.Delay
				} else if stu.Departure != nil && stu.Departure.Time > 0 {
					tMs = stu.Departure.Time
					d = stu.Departure.Delay
				}
				if tMs <= 0 {
					continue
				}
				if d != nil && delay == nil {
					v := *d
					delay = &v
				}
				if tMs >= nowMs-60_000 {
					if earliestMs == 0 || tMs < earliestMs {
						earliestMs = tMs
					}
					if stu.StopID != "" {
						preds = append(preds, sagalesStopPred{
							LineCode:  code,
							DirID:     dirID,
							Headsign:  hs,
							VehicleID: vehID,
							TripID:    tripID,
							StopID:    stu.StopID,
							ArriveMs:  tMs,
							DelaySec:  d,
							RealTime:  stu.RealTime,
						})
					}
				}
			}
		}
		if e.Vehicle == nil || e.Vehicle.Postion == nil {
			continue
		}
		pos := e.Vehicle.Postion
		if pos.Latitude == 0 && pos.Longitude == 0 {
			continue
		}
		if vehID == "" {
			vehID = strings.TrimSpace(e.ID)
		}
		if vehID == "" {
			continue
		}
		stName := ""
		if stopNames != nil {
			stName = stopNames[e.Vehicle.StopID]
		}
		obs := e.Vehicle.Timestamp
		if obs <= 0 {
			obs = nowMs
		}
		b := sagalesBus{
			VehicleID:  vehID,
			LineCode:   code,
			RouteID:    routeID,
			DirID:      dirID,
			TripID:     tripID,
			Headsign:   hs,
			StopID:     e.Vehicle.StopID,
			StopName:   stName,
			Status:     e.Vehicle.CurrentStatus,
			Lat:        pos.Latitude,
			Lon:        pos.Longitude,
			Bearing:    pos.Bearing,
			Speed:      pos.Speed,
			ObservedMs: obs,
			DelaySec:   delay,
		}
		if prev, exists := byVeh[vehID]; !exists ||
			(earliestMs > 0 && (prev.nextArrMs == 0 || earliestMs < prev.nextArrMs)) ||
			(earliestMs == prev.nextArrMs && obs > prev.bus.ObservedMs) {
			byVeh[vehID] = bestCand{bus: b, nextArrMs: earliestMs}
		}
	}
	buses = make([]sagalesBus, 0, len(byVeh))
	for _, c := range byVeh {
		buses = append(buses, c.bus)
	}
	sort.Slice(buses, func(i, j int) bool { return buses[i].VehicleID < buses[j].VehicleID })
	sort.Slice(preds, func(i, j int) bool { return preds[i].ArriveMs < preds[j].ArriveMs })
	return
}

func (p *sagalesPoller) fetch(ctx context.Context, routeID, dirID int, busOnly bool) ([]byte, error) {
	u := fmt.Sprintf("%s/%d/%d", p.baseURL, routeID, dirID)
	if busOnly {
		u += "?bus=true"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", sagalesUserAgent)
	req.Header.Set("Accept", "application/json")
	cli := p.client
	if cli == nil {
		cli = rtHTTP
	}
	res, err := cli.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return io.ReadAll(io.LimitReader(res.Body, 4<<20))
}

func (p *sagalesPoller) pollOne(ctx context.Context, routeID, dirID int, wantStatic bool) {
	body, err := p.fetch(ctx, routeID, dirID, !wantStatic)
	if err != nil {
		p.mu.Lock()
		p.lastErr = err.Error()
		p.mu.Unlock()
		return
	}
	now := time.Now()
	p.mu.RLock()
	fallbackCode := ""
	if lm := p.lines[routeID]; lm != nil {
		fallbackCode = lm.Code
	}
	snames := p.stopName
	p.mu.RUnlock()

	meta, code, name, color, textColor, buses, preds, err := parseSagalesResponse(routeID, dirID, fallbackCode, snames, body, now)
	if err != nil {
		p.mu.Lock()
		p.lastErr = err.Error()
		p.mu.Unlock()
		return
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	p.lastPoll = now
	p.lastErr = ""

	if wantStatic {
		lm := p.lines[routeID]
		if lm == nil {
			lm = &sagalesLineMeta{RouteID: routeID, Code: code}
			p.lines[routeID] = lm
		}
		if code != "" {
			lm.Code = code
		}
		if name != "" {
			lm.Name = name
		}
		if color != "" {
			lm.Color = color
		}
		if textColor != "" {
			lm.TextColor = textColor
		}
		if meta != nil {
			lm.Dirs[dirID] = meta
			for _, s := range meta.Stops {
				p.stopName[s.ID] = s.Name
			}
		}
		lm.FetchedAt = now
		p.byCode[strings.ToUpper(lm.Code)] = routeID
	}

	p.buses[fmt.Sprintf("%d:%d", routeID, dirID)] = buses

	// Rebuild predictions for this (routeID, dirID) across stops.
	byStop := map[string][]sagalesStopPred{}
	for _, pr := range preds {
		key := fmt.Sprintf("%d:%s", routeID, pr.StopID)
		byStop[key] = append(byStop[key], pr)
	}
	// Replace only entries belonging to this direction.
	prefix := strconv.Itoa(routeID) + ":"
	for k, existing := range p.preds {
		if !strings.HasPrefix(k, prefix) {
			continue
		}
		var kept []sagalesStopPred
		for _, e := range existing {
			if e.DirID != dirID {
				kept = append(kept, e)
			}
		}
		if len(kept) == 0 {
			delete(p.preds, k)
		} else {
			p.preds[k] = kept
		}
	}
	for k, list := range byStop {
		merged := append(p.preds[k], list...)
		sort.Slice(merged, func(i, j int) bool { return merged[i].ArriveMs < merged[j].ArriveMs })
		p.preds[k] = merged
	}
}

func (p *sagalesPoller) publishCatalog() {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if len(p.lines) == 0 {
		return
	}
	op := &rtCatalogOp{
		AgencyID: sagalesAgencyID,
		Mode:     "bus",
		Profiles: map[string]*rtLineProfile{},
	}
	for _, id := range p.lineIDs {
		lm := p.lines[id]
		if lm == nil || lm.Code == "" {
			continue
		}
		op.Lines = append(op.Lines, rtRoute{
			Code:      lm.Code,
			Name:      lm.Name,
			Color:     lm.Color,
			TextColor: lm.TextColor,
		})
		prof := &rtLineProfile{Code: lm.Code}
		for d := 0; d < 2; d++ {
			dm := lm.Dirs[d]
			if dm == nil || len(dm.Stops) == 0 {
				continue
			}
			rd := rtLineDirection{
				DirectionID:       d,
				Headsign:          dm.Headsign,
				Geometry:          dm.Coords,
				GeometryFromStops: len(dm.Coords) == 0,
			}
			for _, s := range dm.Stops {
				rd.Stops = append(rd.Stops, rtLineStop{ID: s.ID, Name: s.Name, Lat: s.Lat, Lon: s.Lon})
			}
			prof.Directions = append(prof.Directions, rd)
		}
		if len(prof.Directions) > 0 {
			op.Profiles[lm.Code] = prof
		}
	}
	if len(op.Lines) > 0 {
		rtCatalog.Store(sagalesAgencyID, op)
	}
}

func (p *sagalesPoller) run(ctx context.Context, wg *sync.WaitGroup) {
	defer wg.Done()
	for {
		staticChanged := false
		for _, id := range p.lineIDs {
			for d := 0; d < 2; d++ {
				if ctx.Err() != nil {
					return
				}
				p.mu.RLock()
				lm := p.lines[id]
				wantStatic := lm == nil || lm.Dirs[d] == nil || time.Since(lm.FetchedAt) > sagalesStaticMaxAge
				p.mu.RUnlock()
				p.pollOne(ctx, id, d, wantStatic)
				if wantStatic {
					staticChanged = true
					p.publishCatalog()
				}
				select {
				case <-ctx.Done():
					return
				case <-time.After(sagalesMinGap):
				}
			}
		}
		if staticChanged {
			p.publishCatalog()
		}
		p.mu.Lock()
		p.cycles++
		p.mu.Unlock()
	}
}

func startSagalesPoller() (stop func()) {
	if os.Getenv("ARRIBO_SAGALES") != "1" {
		return func() {}
	}
	ids := sagalesDefaultLines
	if s := strings.TrimSpace(os.Getenv("ARRIBO_SAGALES_LINES")); s != "" {
		ids = nil
		for _, part := range strings.Split(s, ",") {
			if n, err := strconv.Atoi(strings.TrimSpace(part)); err == nil && n > 0 {
				ids = append(ids, n)
			}
		}
		if len(ids) == 0 {
			return func() {}
		}
	}
	p := &sagalesPoller{
		lineIDs:  ids,
		baseURL:  sagalesBaseURL,
		lines:    map[int]*sagalesLineMeta{},
		byCode:   map[string]int{},
		buses:    map[string][]sagalesBus{},
		preds:    map[string][]sagalesStopPred{},
		stopName: map[string]string{},
	}
	sagalesLive.Store(p)
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Add(1)
	go p.run(ctx, &wg)
	log.Printf("[Sagalés] polling %d lines (ARRIBO_SAGALES=1, font no oficial)", len(ids))
	return func() {
		sagalesLive.CompareAndSwap(p, nil)
		cancel()
		wg.Wait()
	}
}

// sagalesLineBuses builds the live GPS vehicle objects for /api/line/sagales:<code>.
func sagalesLineBuses(code, direction string, now time.Time) (buses []any, stale int) {
	buses = []any{}
	p := sagalesLive.Load()
	if p == nil {
		return buses, 0
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	routeID, ok := p.byCode[strings.ToUpper(strings.TrimSpace(code))]
	if !ok {
		return buses, 0
	}
	nowMs := now.UnixMilli()
	ref := sagalesAgencyID + ":" + code
	for d := 0; d < 2; d++ {
		dirStr := strconv.Itoa(d)
		if direction != "both" && direction != "" && direction != dirStr {
			continue
		}
		for _, b := range p.buses[fmt.Sprintf("%d:%d", routeID, d)] {
			ageSec := math.Max(0, float64(nowMs-b.ObservedMs)/1000)
			if ageSec > sagalesStaleSec {
				stale++
				continue
			}
			var delayMins any = nil
			var delaySec any = nil
			if b.DelaySec != nil {
				delaySec = float64(*b.DelaySec)
				delayMins = math.Round(float64(*b.DelaySec) / 60)
			}
			status, badge := railDelayLabel(delayMins, false)
			buses = append(buses, O(
				"id", sagalesAgencyID+":"+b.VehicleID,
				"agencyId", sagalesAgencyID,
				"agency", sagalesOperator.Name,
				"mode", "bus",
				"vehicleId", b.VehicleID,
				"label", b.LineCode+"-"+b.VehicleID,
				"lineId", ref,
				"lineCode", b.LineCode,
				"direction", dirStr,
				"destination", strOrNil(b.Headsign),
				"tripId", strOrNil(b.TripID),
				"lat", b.Lat,
				"lon", b.Lon,
				"latitude", b.Lat,
				"longitude", b.Lon,
				"bearing", b.Bearing,
				"speed", b.Speed,
				"stopId", strOrNil(b.StopID),
				"stopName", strOrNil(b.StopName),
				"toStop", strOrNil(b.StopName),
				"currentStatus", strOrNil(b.Status),
				"observedAt", float64(b.ObservedMs),
				"ageSec", math.Round(ageSec),
				"stale", false,
				"isRealTime", true,
				"isEstimated", false,
				"isTheoretical", false,
				"isGhostVehicle", false,
				"positionSource", "sagales_gps_unofficial",
				"unofficial", true,
				"delaySec", delaySec,
				"delayMins", delayMins,
				"delayMinutes", delayMins,
				"delayStatus", status,
				"delayBadgeText", badge,
				"delayFormatted", badge,
				"delaySource", "sagales_unofficial",
				"delayDiscarded", false,
				"attribution", sagalesAttribution,
			))
		}
	}
	return buses, stale
}

// sagalesStopDepartures builds the stop departure board for a Sagalés stop.
func sagalesStopDepartures(stop rtLineStop, code, direction string, now time.Time) *Obj {
	deps := []any{}
	p := sagalesLive.Load()
	if p != nil {
		p.mu.RLock()
		routeID, ok := p.byCode[strings.ToUpper(strings.TrimSpace(code))]
		var list []sagalesStopPred
		if ok {
			list = append(list, p.preds[fmt.Sprintf("%d:%s", routeID, stop.ID)]...)
		}
		p.mu.RUnlock()

		nowMs := now.UnixMilli()
		for _, pr := range list {
			dirStr := strconv.Itoa(pr.DirID)
			if direction != "" && dirStr != direction {
				continue
			}
			mins := math.Floor(float64(pr.ArriveMs-nowMs) / 60000)
			if mins < 0 {
				continue
			}
			var delayMins any = nil
			if pr.DelaySec != nil {
				delayMins = math.Round(float64(*pr.DelaySec) / 60)
			}
			status, badge := railDelayLabel(delayMins, false)
			if !pr.RealTime {
				status, badge = "scheduled", "Horari"
			}
			hhmm := time.UnixMilli(pr.ArriveMs).In(madrid).Format("15:04")
			deps = append(deps, O(
				"tripId", strOrNil(pr.TripID),
				"vehicleId", strOrNil(pr.VehicleID),
				"destination", strOrNil(pr.Headsign),
				"direction", dirStr,
				"departureTime", hhmm,
				"scheduledTime", hhmm,
				"aimedIso", isoString(pr.ArriveMs),
				"expectedIso", isoString(pr.ArriveMs),
				"minutesAway", mins,
				"delayMins", delayMins,
				"delayMinutes", delayMins,
				"delayStatus", status,
				"delayBadgeText", badge,
				"delaySource", "sagales_unofficial",
				"delayDiscarded", false,
				"isRealTime", pr.RealTime,
				"isEstimated", false,
				"isTheoretical", !pr.RealTime,
				"isCancelled", false,
				"unofficial", true,
				"platform", nil,
				"platformSource", nil,
				"platformChanged", false,
				"scheduledPlatform", nil,
			))
			if len(deps) >= railDepShown {
				break
			}
		}
	}
	return O(
		"stop", O("id", stop.ID, "name", stop.Name, "lat", stop.Lat, "lon", stop.Lon, "agencyId", sagalesAgencyID),
		"departures", deps,
		"windowMinutes", float64(railDepWindowSec/60),
		"source", "sagales_unofficial",
		"unofficial", true,
		"attribution", sagalesAttribution,
	)
}

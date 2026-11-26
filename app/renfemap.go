package main

// Renfe's public web-map JSON feeds (plan steps 3.1, 3.2, 3.4):
//   - Commuter map (flota.json): núcleo 50 (Rodalies de Catalunya) gives
//     nextVia / via (announced platform) and accesible (wheelchair flag).
//   - Long-distance map (flotaLD.json): gives mat (physical unit numbers,
//     comma-separated when coupled), codProduct, p (platform) and accesible
//     for Catalan regional trains (R11, R13-R17, RG1, RL3/RL4, RT1/RT2).
//
// Both feeds are undocumented unofficial sources behind Renfe's public visors.
// Gated behind ARRIBO_RENFE_MAP=1, polled gently every 30 s, and every field
// derived from them is tagged source="renfe_visor_unofficial" so the UI labels
// it "font no oficial". Official GTFS-RT fields always win when present.

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"strings"
	"time"
)

const (
	renfeFlotaURL        = "https://tiempo-real.renfe.com/renfe-visor/flota.json"
	renfeFlotaLDURL      = "https://tiempo-real.largorecorrido.renfe.com/renfe-visor/flotaLD.json"
	renfeMapEvery        = 30 * time.Second
	renfeMapMaxAge       = 3 * time.Minute
	renfeMapSourceTag    = "renfe_visor_unofficial"
	renfeCataloniaNucleo = "50"
)

func renfeMapEnabled() bool {
	return os.Getenv("ARRIBO_RENFE_MAP") == "1"
}

type renfeFlotaTrain struct {
	CodTren    string
	TripID     string
	Via        string
	NextVia    string
	CodEstAct  string
	CodEstSig  string
	Accessible *bool
}

type renfeLDTrain struct {
	CodComercial string
	Units        []string
	Series       string
	ProductCode  int
	Platform     string
	CodEstSig    string
	Accessible   *bool
}

type renfeMapSnapshot struct {
	Commuter   map[string]renfeFlotaTrain // keyed by codTren (5-digit train number)
	LD         map[string]renfeLDTrain    // keyed by codComercial (5-digit train number)
	At         time.Time                  // latest successful fetch (legacy/compat)
	CommuterAt time.Time
	LDAt       time.Time
}

func (m *renfeMapSnapshot) fresh(now time.Time) bool {
	return m != nil && !m.At.IsZero() && now.Sub(m.At) <= renfeMapMaxAge
}

func (m *renfeMapSnapshot) commuterFresh(now time.Time) bool {
	if m == nil {
		return false
	}
	t := m.CommuterAt
	if t.IsZero() {
		t = m.At
	}
	return !t.IsZero() && now.Sub(t) <= renfeMapMaxAge
}

func (m *renfeMapSnapshot) ldFresh(now time.Time) bool {
	if m == nil {
		return false
	}
	t := m.LDAt
	if t.IsZero() {
		t = m.At
	}
	return !t.IsZero() && now.Sub(t) <= renfeMapMaxAge
}

// parseRenfeFlota parses Renfe's commuter visor flota.json, keeping only
// núcleo 50 (Rodalies de Catalunya).
func parseRenfeFlota(b []byte) (map[string]renfeFlotaTrain, error) {
	var doc struct {
		Trenes []struct {
			TripID     string `json:"tripId"`
			CodTren    string `json:"codTren"`
			Nucleo     string `json:"nucleo"`
			Via        string `json:"via"`
			NextVia    string `json:"nextVia"`
			CodEstAct  string `json:"codEstAct"`
			CodEstSig  string `json:"codEstSig"`
			Accessible *bool  `json:"accesible"`
		} `json:"trenes"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		return nil, err
	}
	out := map[string]renfeFlotaTrain{}
	for _, t := range doc.Trenes {
		if strings.TrimSpace(t.Nucleo) != renfeCataloniaNucleo {
			continue
		}
		num := strings.TrimSpace(t.CodTren)
		if num == "" {
			continue
		}
		out[num] = renfeFlotaTrain{
			CodTren:    num,
			TripID:     strings.TrimSpace(t.TripID),
			Via:        strings.TrimSpace(t.Via),
			NextVia:    strings.TrimSpace(t.NextVia),
			CodEstAct:  strings.TrimSpace(t.CodEstAct),
			CodEstSig:  strings.TrimSpace(t.CodEstSig),
			Accessible: t.Accessible,
		}
	}
	return out, nil
}

// parseRenfeFlotaLD parses Renfe's long-distance visor flotaLD.json.
func parseRenfeFlotaLD(b []byte) (map[string]renfeLDTrain, error) {
	var doc struct {
		Trenes []struct {
			CodComercial string `json:"codComercial"`
			CodProduct   int    `json:"codProduct"`
			CodEstSig    string `json:"codEstSig"`
			Platform     string `json:"p"`
			Mat          string `json:"mat"`
			Accessible   *bool  `json:"accesible"`
		} `json:"trenes"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		return nil, err
	}
	out := map[string]renfeLDTrain{}
	for _, t := range doc.Trenes {
		num := strings.TrimSpace(t.CodComercial)
		if num == "" {
			continue
		}
		var units []string
		for _, part := range strings.Split(t.Mat, ",") {
			if u := strings.TrimSpace(part); u != "" {
				units = append(units, u)
			}
		}
		series := ""
		if len(units) > 0 {
			series = renfeUnitSeries(units[0])
		}
		out[num] = renfeLDTrain{
			CodComercial: num,
			Units:        units,
			Series:       series,
			ProductCode:  t.CodProduct,
			Platform:     strings.TrimSpace(t.Platform),
			CodEstSig:    strings.TrimSpace(t.CodEstSig),
			Accessible:   t.Accessible,
		}
	}
	return out, nil
}

// renfeUnitSeries extracts the 3-digit series code from a Renfe unit number
// (e.g. "449027" -> "449", "470095" -> "470").
func renfeUnitSeries(unit string) string {
	u := strings.TrimSpace(unit)
	if len(u) < 3 {
		return ""
	}
	for i := 0; i < 3; i++ {
		if u[i] < '0' || u[i] > '9' {
			return ""
		}
	}
	return u[:3]
}

// renfeTrainNumber recovers the 5-digit train number from a Rodalies static
// trip id ("5127M15916R11"), vehicle label ("R2S-25547-PLATF.(11)"), or LD id.
func renfeTrainNumber(tripID, label string) string {
	if m := reStaticNumber.FindStringSubmatch(tripID); m != nil {
		return m[1]
	}
	if m := reLabelNumber.FindStringSubmatch(label); m != nil {
		return m[1]
	}
	return ldTrainNumber(tripID, label)
}

// pollRenfeMap fetches flota.json and flotaLD.json independently; a transient
// error on one keeps the other's fresh data.
func (p *rtPoller) pollRenfeMap(ctx context.Context) {
	now := time.Now()
	prev := p.renfeMap.Load()
	next := &renfeMapSnapshot{At: now}
	updated := false

	if p.src.renfeMapURL != "" {
		if b, err := rtFetch(ctx, p.src.renfeMapURL); err != nil {
			log.Printf("[GTFS-RT] %s: flota.json fetch failed: %v", p.src.AgencyID, err)
			if prev != nil {
				next.Commuter = prev.Commuter
				next.CommuterAt = prev.CommuterAt
			}
		} else if m, err := parseRenfeFlota(b); err != nil {
			log.Printf("[GTFS-RT] %s: flota.json parse failed: %v", p.src.AgencyID, err)
			if prev != nil {
				next.Commuter = prev.Commuter
				next.CommuterAt = prev.CommuterAt
			}
		} else {
			next.Commuter = m
			next.CommuterAt = now
			updated = true
		}
	}

	if p.src.renfeMapLDURL != "" {
		if b, err := rtFetch(ctx, p.src.renfeMapLDURL); err != nil {
			log.Printf("[GTFS-RT] %s: flotaLD.json fetch failed: %v", p.src.AgencyID, err)
			if prev != nil {
				next.LD = prev.LD
				next.LDAt = prev.LDAt
			}
		} else if m, err := parseRenfeFlotaLD(b); err != nil {
			log.Printf("[GTFS-RT] %s: flotaLD.json parse failed: %v", p.src.AgencyID, err)
			if prev != nil {
				next.LD = prev.LD
				next.LDAt = prev.LDAt
			}
		} else {
			next.LD = m
			next.LDAt = now
			updated = true
		}
	}

	if updated {
		p.renfeMap.Store(next)
	}
}

// renfeMapPlatformFor returns the platform announced in Renfe's unofficial
// visor feeds for a train at/approaching stopID ("" when absent or stale).
func renfeMapPlatformFor(m *renfeMapSnapshot, tripID, label, stopID, status string, now time.Time) string {
	if m == nil {
		return ""
	}
	num := renfeTrainNumber(tripID, label)
	if num == "" {
		return ""
	}
	if m.commuterFresh(now) {
		if c, ok := m.Commuter[num]; ok {
			if status == "STOPPED_AT" && c.Via != "" && (stopID == "" || c.CodEstAct == "" || c.CodEstAct == stopID) {
				return c.Via
			}
			if c.NextVia != "" && (stopID == "" || c.CodEstSig == "" || c.CodEstSig == stopID) {
				return c.NextVia
			}
			if stopID != "" && c.CodEstAct == stopID && c.Via != "" {
				return c.Via
			}
		}
	}
	if m.ldFresh(now) {
		if ld, ok := m.LD[num]; ok && ld.Platform != "" {
			if stopID == "" || ld.CodEstSig == "" || ld.CodEstSig == stopID {
				return ld.Platform
			}
		}
	}
	return ""
}

// renfeMapUnitJSON builds the additive "unit" object for a Rodalies regional
// train found in flotaLD.json, enriched with static facts from renfe_fleet.json.
func renfeMapUnitJSON(m *renfeMapSnapshot, tripID, label string, now time.Time) *Obj {
	if !m.ldFresh(now) {
		return nil
	}
	num := renfeTrainNumber(tripID, label)
	if num == "" {
		return nil
	}
	ld, ok := m.LD[num]
	if !ok || len(ld.Units) == 0 {
		return nil
	}
	units := make([]any, len(ld.Units))
	for i, u := range ld.Units {
		units[i] = u
	}
	obsAt := m.LDAt
	if obsAt.IsZero() {
		obsAt = m.At
	}
	o := O(
		"series", strOrNil(ld.Series),
		"units", units,
		"coupledCount", float64(len(ld.Units)),
		"observedAt", float64(obsAt.UnixMilli()),
		"source", renfeMapSourceTag,
		"unofficial", true,
	)
	if spec, ok := renfeSeriesSpecFor(ld.Series); ok {
		if spec.Manufacturer != "" {
			o.Set("manufacturer", spec.Manufacturer)
		}
		if spec.Cars != nil {
			o.Set("cars", spec.Cars)
		}
		if spec.LowFloor != nil {
			o.Set("lowFloor", spec.LowFloor)
		}
	}
	return o
}

// renfeMapAccessible returns the wheelchair accessibility flag from Renfe's
// visor feeds when explicitly reported (nil when unknown or stale).
func renfeMapAccessible(m *renfeMapSnapshot, tripID, label string, now time.Time) *bool {
	if m == nil {
		return nil
	}
	num := renfeTrainNumber(tripID, label)
	if num == "" {
		return nil
	}
	if m.commuterFresh(now) {
		if c, ok := m.Commuter[num]; ok && c.Accessible != nil {
			return c.Accessible
		}
	}
	if m.ldFresh(now) {
		if ld, ok := m.LD[num]; ok && ld.Accessible != nil {
			return ld.Accessible
		}
	}
	return nil
}

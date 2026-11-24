package main

// FGC train series and occupancy (plan step 6.4) from FGC's open dataset
// "posicionament-dels-trens" (Geotren) on dadesobertes.fgc.cat: per train in
// service, its unit type (tipus_unitat, the series: 112, 113, 114, 115,
// 213...) and the occupancy FGC reports per car (ocupacio_<car>_percent).
// Its `ut` is the GTFS-RT vehicle id and its `id` the trip id, so it joins
// the FGC trains exactly. The dataset shares FGC's 5 000 anonymous requests
// a day with the GTFS-RT polling (about 4 130 a day): one request every
// fgcGeotrenEvery adds 480. A record older than fgcGeotrenMaxAge is not shown.

import (
	"context"
	"encoding/json"
	"log"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	fgcGeotrenURL    = "https://dadesobertes.fgc.cat/api/explore/v2.1/catalog/datasets/posicionament-dels-trens/records?limit=100"
	fgcGeotrenEvery  = 3 * time.Minute
	fgcGeotrenMaxAge = 7 * time.Minute
)

// fgcCar is one car's occupancy as FGC reports it.
type fgcCar struct {
	Car     string // FGC's car code, upper case (MI, RI, M1, M2...)
	Percent float64
}

// fgcUnit is what Geotren says about one train.
type fgcUnit struct {
	Series string
	Cars   []fgcCar
	At     time.Time // when it was fetched
}

// parseGeotren reads a records answer into units by vehicle id (ut).
func parseGeotren(b []byte, at time.Time) (map[string]fgcUnit, error) {
	var r struct {
		Results []map[string]any `json:"results"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	out := map[string]fgcUnit{}
	for _, rec := range r.Results {
		ut, _ := rec["ut"].(string)
		if ut == "" {
			continue
		}
		u := fgcUnit{At: at}
		u.Series, _ = rec["tipus_unitat"].(string)
		for k, v := range rec {
			if !strings.HasPrefix(k, "ocupacio_") || !strings.HasSuffix(k, "_percent") {
				continue
			}
			s, _ := v.(string)
			p, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
			if err != nil || p < 0 || p > 200 {
				continue
			}
			car := strings.ToUpper(strings.TrimSuffix(strings.TrimPrefix(k, "ocupacio_"), "_percent"))
			u.Cars = append(u.Cars, fgcCar{Car: car, Percent: p})
		}
		sort.Slice(u.Cars, func(i, j int) bool { return u.Cars[i].Car < u.Cars[j].Car })
		out[ut] = u
	}
	return out, nil
}

// pollGeotren refreshes the units; a failure keeps the last ones (they age out).
func (p *rtPoller) pollGeotren(ctx context.Context) {
	b, err := rtFetch(ctx, p.src.geotrenURL)
	if err != nil {
		log.Printf("[GTFS-RT] %s: geotren fetch failed: %v", p.src.AgencyID, err)
		return
	}
	units, err := parseGeotren(b, time.Now())
	if err != nil {
		log.Printf("[GTFS-RT] %s: geotren parse failed: %v", p.src.AgencyID, err)
		return
	}
	p.geotren.Store(&units)
}

// fgcUnitJSON is the additive "unit" key of an FGC train (nil when Geotren
// has no fresh record for it): the series and the occupancy per car, with
// the mean, all as FGC reports them.
func fgcUnitJSON(units map[string]fgcUnit, vehicleID string, now time.Time) *Obj {
	u, ok := units[vehicleID]
	if !ok || vehicleID == "" || now.Sub(u.At) > fgcGeotrenMaxAge {
		return nil
	}
	cars := []any{}
	sum := 0.0
	for _, c := range u.Cars {
		cars = append(cars, O("car", c.Car, "percent", c.Percent))
		sum += c.Percent
	}
	var mean any
	if len(u.Cars) > 0 {
		mean = jsRound(sum / float64(len(u.Cars)))
	}
	return O("series", strOrNil(u.Series), "occupancyPercent", mean, "cars", cars,
		"observedAt", float64(u.At.UnixMilli()), "source", "fgc_geotren")
}

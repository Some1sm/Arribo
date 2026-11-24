package main

// Indicative ticket prices for planner itineraries (plan step 4.2).
// The table is src/data/fares.json (ATM Area de Barcelona 2026 plus the
// Mataro Bus own tickets). A price is given only where the data supports
// it: a journey whose zones are not known gets "fare": null, never a guess.

import (
	"encoding/json"
	"log"
	"math"
	"os"
)

type fareTable struct {
	ValidFrom string   `json:"validFrom"`
	Currency  string   `json:"currency"`
	Sources   []string `json:"sources"`
	ATM       struct {
		Single       []float64 `json:"single"`
		TCasual      []float64 `json:"tCasual"`
		TCasualTrips float64   `json:"tCasualTrips"`
		Transfer     struct {
			WindowSeconds []float64 `json:"windowSeconds"`
		} `json:"transfer"`
	} `json:"atm"`
	MataroBus struct {
		Zone                  int     `json:"zone"`
		Sector                string  `json:"sector"`
		Single                float64 `json:"single"`
		SingleTransferSeconds float64 `json:"singleTransferSeconds"`
		T10                   float64 `json:"t10"`
		T10Trips              float64 `json:"t10Trips"`
	} `json:"mataroBus"`
	SectorZones map[string]map[string]int `json:"sectorZones"`
	Stations    map[string]string         `json:"stations"`
}

// fares is set once at start-up (or by a test) and only read afterwards.
var fares *fareTable

func loadFares(path string) {
	t, err := readFareTable(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("[Fares] Could not load fares.json: %v", err)
		}
		return
	}
	fares = t
}

func readFareTable(path string) (*fareTable, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	t := &fareTable{}
	if err := json.Unmarshal(b, t); err != nil {
		return nil, err
	}
	if len(t.ATM.Single) != 7 || len(t.ATM.TCasual) != 7 || len(t.ATM.Transfer.WindowSeconds) != 7 {
		return nil, os.ErrInvalid
	}
	return t, nil
}

func fareRound(x float64) float64 { return math.Round(x*1000) / 1000 }

// sectorZoneCount is the ATM zone count between two sectors, from the
// checked-in matrix rows (reverse direction when only that row is known).
func (t *fareTable) sectorZoneCount(from, to string) (int, bool) {
	if n, ok := t.SectorZones[from][to]; ok {
		return n, true
	}
	if n, ok := t.SectorZones[to][from]; ok {
		return n, true
	}
	return 0, false
}

func (t *fareTable) stationZones(fromName, toName string) (n int, fromSec, toSec string, ok bool) {
	fromSec, ok1 := t.Stations[foldStationName(fromName)]
	toSec, ok2 := t.Stations[foldStationName(toName)]
	if !ok1 || !ok2 {
		return 0, "", "", false
	}
	n, ok = t.sectorZoneCount(fromSec, toSec)
	return
}

type fareLeg struct {
	rail              bool
	fromName, toName  string
	boardMs, alightMs int64
}

func fareLegsOf(itin *Obj) ([]fareLeg, bool) {
	raw := itin.Arr("legs")
	if len(raw) == 0 {
		return nil, false
	}
	out := make([]fareLeg, 0, len(raw))
	for _, r := range raw {
		l, _ := r.(*Obj)
		if l == nil {
			return nil, false
		}
		b, okb := parseDateJS(l.Str("boardAt"))
		a, oka := parseDateJS(l.Str("alightAt"))
		if !okb || !oka {
			return nil, false
		}
		fl := fareLeg{rail: l.Str("mode") == "rail", boardMs: int64(b), alightMs: int64(a)}
		if fs := l.ObjAt("fromStop"); fs != nil {
			fl.fromName = fs.Str("name")
		}
		if ts := l.ObjAt("toStop"); ts != nil {
			fl.toName = ts.Str("name")
		}
		out = append(out, fl)
	}
	return out, true
}

func fareOpt(product, operator, kind string, price float64, tickets int, note string) *Obj {
	o := O("product", product, "operator", operator, "kind", kind, "price", fareRound(price), "tickets", float64(tickets))
	if note != "" {
		o.Set("note", note)
	}
	return o
}

// itineraryFare prices one planner itinerary: an *Obj, or nil when the
// price is not known.
func itineraryFare(itin *Obj) any {
	t := fares
	if t == nil {
		return nil
	}
	legs, ok := fareLegsOf(itin)
	if !ok {
		return nil
	}
	rail := 0
	for _, l := range legs {
		if l.rail {
			rail++
		}
	}
	if rail != 0 && rail != len(legs) {
		return nil
	}
	n := len(legs)
	spanSec := float64(legs[n-1].boardMs-legs[0].boardMs) / 1000
	var options []any
	var zonesObj *Obj
	var singles, tens []*Obj
	revalidate := false
	var windowSec float64

	if rail == 0 {
		// Mataro Bus: every stop is sector 3E, one ATM zone for a trip.
		zonesObj = O("count", 1.0, "from", t.MataroBus.Sector, "to", t.MataroBus.Sector,
			"basis", "Mataró Bus, tot dins el sector "+t.MataroBus.Sector)
		own := 1
		if spanSec > t.MataroBus.SingleTransferSeconds {
			own = n
			revalidate = true
		}
		windowSec = t.MataroBus.SingleTransferSeconds
		atmTen := 1
		if spanSec > t.ATM.Transfer.WindowSeconds[0] {
			atmTen = n
			revalidate = true
		}
		s1 := fareOpt("mataro_single", "mataro_bus", "single", t.MataroBus.Single*float64(own), own, "")
		t10 := fareOpt("mataro_t10", "mataro_bus", "ten", t.MataroBus.T10/t.MataroBus.T10Trips*float64(own), own, "")
		s2 := fareOpt("atm_single_1z", "atm", "single", t.ATM.Single[0]*float64(n), n, "")
		t2 := fareOpt("atm_t_casual_1z", "atm", "ten", t.ATM.TCasual[0]/t.ATM.TCasualTrips*float64(atmTen), atmTen, "")
		singles, tens = []*Obj{s1, s2}, []*Obj{t10, t2}
		options = []any{s1, t10, s2, t2}
	} else {
		total, fromSec, toSec, ok := t.stationZones(legs[0].fromName, legs[n-1].toName)
		if !ok || total < 1 || total > 7 {
			return nil
		}
		zonesObj = O("count", float64(total), "from", fromSec, "to", toSec,
			"basis", "sectors ATM "+fromSec+" → "+toSec)
		windowSec = t.ATM.Transfer.WindowSeconds[total-1]
		perLegSingle, perLegTen := 0.0, 0.0
		legsKnown := true
		for _, l := range legs {
			z, _, _, lok := t.stationZones(l.fromName, l.toName)
			if !lok || z < 1 || z > 7 {
				legsKnown = false
				break
			}
			perLegSingle += t.ATM.Single[z-1]
			perLegTen += t.ATM.TCasual[z-1] / t.ATM.TCasualTrips
		}
		// The single ticket has no transfers: one per leg.
		if n == 1 {
			s := fareOpt("atm_single", "atm", "single", t.ATM.Single[total-1], 1, "")
			singles = []*Obj{s}
			options = append(options, s)
		} else if legsKnown {
			s := fareOpt("atm_single", "atm", "single", perLegSingle, n, "un bitllet per tram")
			singles = []*Obj{s}
			options = append(options, s)
		}
		if n == 1 || spanSec <= windowSec {
			c := fareOpt("atm_t_casual", "atm", "ten", t.ATM.TCasual[total-1]/t.ATM.TCasualTrips, 1, "")
			tens = []*Obj{c}
			options = append(options, c)
		} else {
			revalidate = true
			if legsKnown {
				c := fareOpt("atm_t_casual", "atm", "ten", perLegTen, n, "cal validar de nou: fora de la finestra de transbord")
				tens = []*Obj{c}
				options = append(options, c)
			}
		}
	}
	if len(singles) == 0 && len(tens) == 0 {
		return nil
	}
	cheapest := func(list []*Obj) any {
		var best *Obj
		for _, o := range list {
			if best == nil || o.Num("price") < best.Num("price") {
				best = o
			}
		}
		if best == nil {
			return nil
		}
		return best
	}
	return O(
		"currency", t.Currency, "validFrom", t.ValidFrom, "note", "preu orientatiu",
		"zones", zonesObj,
		"cheapestSingle", cheapest(singles), "perTripWithTen", cheapest(tens),
		"options", options,
		"transferWindowMinutes", math.Round(windowSec/60),
		"needsRevalidation", revalidate,
	)
}

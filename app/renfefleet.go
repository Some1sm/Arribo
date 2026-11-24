package main

// Rolling-stock metadata for Rodalies and Renfe regionals, from the static
// fleet table src/data/renfe_fleet.json (plan step 3.3).
//   - renfeUsualSeries(line): series usually seen on a line (for R1-R8 where
//     no public source gives the train's own unit).
//   - renfeSeriesSpecFor(code): manufacturer / cars / low-floor facts for a
//     concrete series seen in flotaLD.json (step 3.2).

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync"
)

type renfeSeriesSpec struct {
	Series       string
	Manufacturer string
	Cars         any // int/float64 or string (e.g. Civia "3 / 4 / 5 (462 = 2 cars)")
	LowFloor     any // bool or string (e.g. "partial" for 447 PMR-refitted)
}

var (
	renfeFleetOnce  sync.Once
	renfeUsual      map[string][]string        // line code -> series in service, in file order
	renfeSeriesInfo map[string]renfeSeriesSpec // series code or alias -> static facts
)

func readRenfeFleetData(path string) (map[string][]string, map[string]renfeSeriesSpec, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}
	var f struct {
		Series []struct {
			Series       string   `json:"series"`
			Aliases      []string `json:"aliases"`
			Manufacturer string   `json:"manufacturer"`
			Cars         any      `json:"cars"`
			LowFloor     any      `json:"low_floor"`
			Status       string   `json:"status"`
			UsualLines   []string `json:"usual_lines"`
		} `json:"series"`
	}
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, nil, err
	}
	usual := map[string][]string{}
	specs := map[string]renfeSeriesSpec{}
	for _, s := range f.Series {
		if s.Series == "" {
			continue
		}
		spec := renfeSeriesSpec{
			Series:       s.Series,
			Manufacturer: s.Manufacturer,
			Cars:         s.Cars,
			LowFloor:     s.LowFloor,
		}
		specs[s.Series] = spec
		for _, a := range s.Aliases {
			if a != "" {
				specs[a] = spec
			}
		}
		if s.Status != "in_service" {
			continue
		}
		for _, l := range s.UsualLines {
			usual[l] = append(usual[l], s.Series)
		}
	}
	return usual, specs, nil
}

func readRenfeUsualSeries(path string) (map[string][]string, error) {
	usual, _, err := readRenfeFleetData(path)
	return usual, err
}

func loadRenfeFleetOnce() {
	renfeFleetOnce.Do(func() {
		usual, specs, err := readRenfeFleetData(filepath.Join(srcDataDir(), "renfe_fleet.json"))
		if err != nil {
			if !os.IsNotExist(err) {
				log.Printf("[Trains] Could not load renfe_fleet.json: %v", err)
			}
			return
		}
		renfeUsual = usual
		renfeSeriesInfo = specs
	})
}

// renfeUsualSeries is the series usually seen on a Rodalies line (nil when
// the table does not list the line or cannot be read).
func renfeUsualSeries(line string) []string {
	loadRenfeFleetOnce()
	return renfeUsual[line]
}

// renfeSeriesSpecFor looks up static fleet facts for a concrete series code
// (e.g. "449", "470", "447", "465").
func renfeSeriesSpecFor(code string) (renfeSeriesSpec, bool) {
	if code == "" {
		return renfeSeriesSpec{}, false
	}
	loadRenfeFleetOnce()
	spec, ok := renfeSeriesInfo[code]
	return spec, ok
}

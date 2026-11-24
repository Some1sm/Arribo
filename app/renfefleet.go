package main

// The series usually seen on each Rodalies line, from the static fleet table
// src/data/renfe_fleet.json (plan step 3.3). No public source says which
// unit runs a given R1-R8 train, so this is only ever shown as "series
// usually seen on this line", never as the train's own unit. Planned series
// are left out.

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync"
)

var (
	renfeFleetOnce sync.Once
	renfeUsual     map[string][]string // line code -> series in service, in file order
)

func readRenfeUsualSeries(path string) (map[string][]string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var f struct {
		Series []struct {
			Series     string   `json:"series"`
			Status     string   `json:"status"`
			UsualLines []string `json:"usual_lines"`
		} `json:"series"`
	}
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, err
	}
	out := map[string][]string{}
	for _, s := range f.Series {
		if s.Status != "in_service" || s.Series == "" {
			continue
		}
		for _, l := range s.UsualLines {
			out[l] = append(out[l], s.Series)
		}
	}
	return out, nil
}

// renfeUsualSeries is the series usually seen on a Rodalies line (nil when
// the table does not list the line or cannot be read).
func renfeUsualSeries(line string) []string {
	renfeFleetOnce.Do(func() {
		m, err := readRenfeUsualSeries(filepath.Join(srcDataDir(), "renfe_fleet.json"))
		if err != nil {
			if !os.IsNotExist(err) {
				log.Printf("[Trains] Could not load renfe_fleet.json: %v", err)
			}
			return
		}
		renfeUsual = m
	})
	return renfeUsual[line]
}

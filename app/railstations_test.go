package main

import (
	"strings"
	"testing"
)

func TestSearchRailStations(t *testing.T) {
	st := func(id, name string) rtLineStop { return rtLineStop{ID: id, Name: name, Lat: 41.4, Lon: 2.1} }
	op := &rtCatalogOp{AgencyID: "fgc", Mode: "rail",
		Lines: []rtRoute{{Code: "L6", Name: "Sarrià - Pl. Catalunya", Color: "#7C7CBF"}, {Code: "S1", Name: "Terrassa - Pl. Catalunya", Color: "#F4802E"}, {Code: "L12", Name: "Sarrià - Reina Elisenda"}},
		Profiles: map[string]*rtLineProfile{
			"L6": {Code: "L6", Directions: []rtLineDirection{
				{DirectionID: 0, Stops: []rtLineStop{st("SR1", "Sarrià"), st("GR1", "Gràcia"), st("PC1", "Barcelona - Plaça Catalunya")}},
				{DirectionID: 1, Stops: []rtLineStop{st("PC2", "Barcelona - Plaça Catalunya"), st("GR2", "Gràcia"), st("SR2", "Sarrià")}},
			}},
			"S1": {Code: "S1", Directions: []rtLineDirection{
				{DirectionID: 0, Stops: []rtLineStop{st("TN1", "Terrassa Nacions Unides"), st("GR3", "Gràcia"), st("PC3", "Barcelona - Plaça Catalunya")}},
			}},
			// L12 has no profile in this test: its stations are not searched.
		}}
	rtCatalog.Store("fgc", op)
	t.Cleanup(func() { rtCatalog.Delete("fgc") })

	got := searchRailStations("gracia", 10) // accents and case ignored
	if len(got) != 1 {
		t.Fatalf("gracia: %d results: %s", len(got), toJSON(got))
	}
	g := string(toJSON(got[0]))
	for _, want := range []string{`"type":"stop"`, `"lineId":"fgc:L6"`, `"stopId":"GR1"`, `"stopName":"Gràcia"`, `"lines":["L6","S1"]`, `"zone":"FGC · L6, S1"`, `"isTrain":true`, `"lineColor":"#7C7CBF"`} {
		if !strings.Contains(g, want) {
			t.Errorf("missing %s in %s", want, g)
		}
	}
	// Prefix matches first: "barcelona" starts Pl. Catalunya's name only.
	if r := searchRailStations("catalunya", 10); len(r) != 1 || !strings.Contains(string(toJSON(r[0])), `"stopId":"PC1"`) {
		t.Errorf("catalunya: %s", toJSON(r))
	}
	if r := searchRailStations("s", 10); r != nil {
		t.Errorf("one letter should not search: %s", toJSON(r))
	}
	if r := searchRailStations("nowhere", 10); len(r) != 0 {
		t.Errorf("nowhere: %s", toJSON(r))
	}
	if r := searchRailStations("ar", 1); len(r) != 1 {
		t.Errorf("limit 1: %d", len(r))
	}
}

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

func TestSearchCatalogLinesAndStops(t *testing.T) {
	st := func(id, name string) rtLineStop { return rtLineStop{ID: id, Name: name, Lat: 41.5, Lon: 2.4} }
	rtCatalog.Store("moventis", &rtCatalogOp{
		AgencyID: "moventis", Mode: "bus",
		Lines: []rtRoute{{Code: "C-10", Name: "Mataró - Barcelona", Color: "#00A651"}},
		Profiles: map[string]*rtLineProfile{
			"C-10": {Code: "C-10", Directions: []rtLineDirection{
				{DirectionID: 0, Stops: []rtLineStop{st("M100", "Plaça Tereses"), st("B200", "Ronda Universitat")}},
			}},
		},
	})
	rtCatalog.Store("renfe_rodalies", &rtCatalogOp{
		AgencyID: "renfe_rodalies", Mode: "rail",
		Lines: []rtRoute{{Code: "R1", Name: "Molins de Rei - Maçanet", Color: "#7DBCEC"}},
		Profiles: map[string]*rtLineProfile{
			"R1": {Code: "R1", Directions: []rtLineDirection{
				{DirectionID: 0, Stops: []rtLineStop{st("71801", "Barcelona-Sants")}},
			}},
		},
	})
	t.Cleanup(func() {
		rtCatalog.Delete("moventis")
		rtCatalog.Delete("renfe_rodalies")
	})

	// Compact code match: "c10" finds "C-10" with isLine:true and isTrain:false.
	if got := searchCatalogLines("c10", 10); len(got) != 1 {
		t.Fatalf("c10 lines: %s", toJSON(got))
	} else {
		g := string(toJSON(got[0]))
		for _, want := range []string{`"type":"line"`, `"isLine":true`, `"lineId":"moventis:C-10"`, `"isTrain":false`, `"mode":"bus"`} {
			if !strings.Contains(g, want) {
				t.Errorf("c10 line missing %s in %s", want, g)
			}
		}
	}
	// Exact code match: "R1" finds Rodalies R1 with isTrain:true.
	if got := searchCatalogLines("R1", 10); len(got) != 1 || !strings.Contains(string(toJSON(got[0])), `"lineId":"renfe_rodalies:R1"`) {
		t.Errorf("R1 lines: %s", toJSON(got))
	}
	// Multi-operator stop search finds Moventis bus stop with isTrain:false.
	if got := searchCatalogStops("tereses", 10); len(got) != 1 {
		t.Fatalf("tereses stops: %s", toJSON(got))
	} else {
		g := string(toJSON(got[0]))
		for _, want := range []string{`"type":"stop"`, `"lineId":"moventis:C-10"`, `"stopId":"M100"`, `"isTrain":false`, `"mode":"bus"`} {
			if !strings.Contains(g, want) {
				t.Errorf("tereses stop missing %s in %s", want, g)
			}
		}
	}
}

func TestSimplifyPath(t *testing.T) {
	// A straight line with a 1 m wobble collapses to its ends; a 200 m
	// corner is kept.
	line := [][2]float64{{41.0, 2.0}, {41.001, 2.000005}, {41.002, 2.0}, {41.003, 2.0}}
	if got := simplifyPath(line, railRouteTolerance); len(got) != 2 {
		t.Errorf("straight: %v", got)
	}
	corner := [][2]float64{{41.0, 2.0}, {41.002, 2.0}, {41.002, 2.003}}
	if got := simplifyPath(corner, railRouteTolerance); len(got) != 3 {
		t.Errorf("corner: %v", got)
	}
}

func TestFoldStationName(t *testing.T) {
	for in, want := range map[string]string{"Terrassa - Rambla": "terrassa rambla", "Barcelona-Sants": "barcelona sants", "  Gràcia ": "gracia", "Pl. Catalunya": "pl catalunya"} {
		if got := foldStationName(in); got != want {
			t.Errorf("%q -> %q, want %q", in, got, want)
		}
	}
}

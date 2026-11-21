package main

import "testing"

func TestCombineRailLegs(t *testing.T) {
	const t0 = int64(1_800_000_000)
	leg := func(agency, trip, line, from, fromKey, to, toKey string, board, alight int64, lat, lon float64) railLeg {
		return railLeg{Agency: agency, Trip: trip, Line: line, Dir: 0,
			BoardStop: from, BoardKey: fromKey, BoardName: from, AlightStop: to, AlightKey: toKey, AlightName: to,
			BoardLat: 41.5, BoardLon: 2.4, AlightLat: lat, AlightLon: lon, Board: board, Alight: alight, Stops: 5}
	}
	origins := map[string]railEnd{"renfe\x00MAT": {Agency: "renfe", StopID: "MAT", Name: "Mataró", Lat: 41.5, Lon: 2.4}}
	dests := map[string]railEnd{
		"renfe\x00TER": {Agency: "renfe", StopID: "TER", Name: "Terrassa Est"},
		"fgc\x00TRN":   {Agency: "fgc", StopID: "TRN", Name: "Terrassa Rambla"},
	}
	first := []railLeg{
		// R1 Mataró -> Sants (arr t0+40m) and Mataró -> Pl. Catalunya Renfe (arr t0+35m)
		leg("renfe", "r1a", "R1", "MAT", "renfe:MAT", "SAN", "renfe:SAN", t0+600, t0+2400, 41.379, 2.140),
		leg("renfe", "r1a", "R1", "MAT", "renfe:MAT", "PCR", "renfe:PCR", t0+600, t0+2100, 41.3858, 2.1700),
		// A direct train, slower.
		leg("renfe", "slow", "R7", "MAT", "renfe:MAT", "TER", "renfe:TER", t0+300, t0+9000, 41.56, 2.02),
	}
	second := []railLeg{
		// R4 Sants -> Terrassa leaving 2 min after R1 arrives: too short a change.
		leg("renfe", "r4tight", "R4", "SAN", "renfe:SAN", "TER", "renfe:TER", t0+2520, t0+5000, 41.56, 2.02),
		// R4 leaving 5 min after: fine.
		leg("renfe", "r4", "R4", "SAN", "renfe:SAN", "TER", "renfe:TER", t0+2700, t0+5400, 41.56, 2.02),
		// FGC S1 from its Pl. Catalunya station, about 60 m from Renfe's.
		{Agency: "fgc", Trip: "s1", Line: "S1", BoardStop: "PC", BoardKey: "fgc:PC", BoardName: "Pl. Catalunya", BoardLat: 41.3863, BoardLon: 2.1698,
			AlightStop: "TRN", AlightKey: "fgc:TRN", AlightName: "Terrassa Rambla", Board: t0 + 2400, Alight: t0 + 4800, Stops: 12},
	}
	got := combineRailLegs(first, second, origins, dests, t0, 80)
	if len(got) == 0 {
		t.Fatal("no journeys")
	}
	best := got[0]
	if len(best.Legs) != 2 || best.Legs[1].Trip != "s1" || best.ChangeWalkM <= 0 || best.ChangeWalkM > railChangeWalkMaxM {
		t.Fatalf("best should change to FGC S1 at Pl. Catalunya: %+v", best)
	}
	for _, it := range got {
		for _, l := range it.Legs {
			if l.Trip == "r4tight" {
				t.Errorf("a 2-minute change was accepted: %+v", it)
			}
		}
	}
	// The slow direct train leaves earlier (t0+300 > others leave t0+600-60): it is not dominated.
	foundDirect := false
	for _, it := range got {
		if len(it.Legs) == 1 && it.Legs[0].Trip == "slow" {
			foundDirect = true
		}
	}
	if !foundDirect {
		t.Errorf("the earlier direct train should be kept: %+v", got)
	}
	// Nothing leaves before the requested instant.
	if r := combineRailLegs(first, second, origins, dests, t0+3000, 80); len(r) != 0 {
		t.Errorf("journeys leaving before the request: %+v", r)
	}
}

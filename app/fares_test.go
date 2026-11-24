package main

import (
	"path/filepath"
	"testing"
)

func testFareTable(t *testing.T) {
	t.Helper()
	tbl, err := readFareTable(filepath.Join("..", "src", "data", "fares.json"))
	if err != nil {
		t.Fatal(err)
	}
	old := fares
	fares = tbl
	t.Cleanup(func() { fares = old })
}

func fareLegObj(mode, from, to, board, alight string) *Obj {
	o := O("lineId", "L1", "fromStop", O("name", from), "toStop", O("name", to), "boardAt", board, "alightAt", alight)
	if mode != "" {
		o.Set("mode", mode)
	}
	return o
}

func fareOf(t *testing.T, legs ...*Obj) *Obj {
	t.Helper()
	l := make([]any, len(legs))
	for i, x := range legs {
		l[i] = x
	}
	f, _ := itineraryFare(O("legs", l)).(*Obj)
	return f
}

func TestFareIntraMataroOneLeg(t *testing.T) {
	testFareTable(t)
	f := fareOf(t, fareLegObj("", "A", "B", "2026-11-24T10:00:00.000Z", "2026-11-24T10:15:00.000Z"))
	if f == nil {
		t.Fatal("no fare")
	}
	if p := f.ObjAt("cheapestSingle"); p.Num("price") != 1.7 || p.Str("product") != "mataro_single" {
		t.Errorf("single: %v", p)
	}
	if p := f.ObjAt("perTripWithTen"); p.Num("price") != 0.485 {
		t.Errorf("ten: %v", p)
	}
	var atm1, atmT float64
	for _, x := range f.Arr("options") {
		o := x.(*Obj)
		switch o.Str("product") {
		case "atm_single_1z":
			atm1 = o.Num("price")
		case "atm_t_casual_1z":
			atmT = o.Num("price")
		}
	}
	if atm1 != 2.9 || atmT != 1.3 {
		t.Errorf("atm alternatives %v %v", atm1, atmT)
	}
	if f.Str("note") != "preu orientatiu" || f.Str("validFrom") != "2026-01-15" || f.Str("currency") != "EUR" {
		t.Errorf("labels: %v", f)
	}
}

func TestFareIntraMataroTwoLegsOneTicket(t *testing.T) {
	testFareTable(t)
	f := fareOf(t,
		fareLegObj("", "A", "B", "2026-11-24T10:00:00.000Z", "2026-11-24T10:15:00.000Z"),
		fareLegObj("", "B", "C", "2026-11-24T10:25:00.000Z", "2026-11-24T10:45:00.000Z"))
	if p := f.ObjAt("cheapestSingle"); p.Num("price") != 1.7 || p.Num("tickets") != 1 {
		t.Errorf("one ticket expected: %v", p)
	}
	if f.Get("needsRevalidation") != false {
		t.Error("no revalidation inside 75 min")
	}
	f = fareOf(t,
		fareLegObj("", "A", "B", "2026-11-24T10:00:00.000Z", "2026-11-24T10:15:00.000Z"),
		fareLegObj("", "B", "C", "2026-11-24T11:30:00.000Z", "2026-11-24T11:45:00.000Z"))
	if p := f.ObjAt("cheapestSingle"); p.Num("tickets") != 2 || p.Num("price") != 3.4 {
		t.Errorf("two tickets expected after 75 min: %v", p)
	}
}

func TestFareRailKnownAndUnknownZones(t *testing.T) {
	testFareTable(t)
	f := fareOf(t, fareLegObj("rail", "Mataró", "Barcelona-Sants", "2026-11-24T10:00:00.000Z", "2026-11-24T10:45:00.000Z"))
	if f == nil {
		t.Fatal("no fare for Mataró - Sants")
	}
	if f.ObjAt("zones").Num("count") != 3 || f.ObjAt("cheapestSingle").Num("price") != 5.4 {
		t.Errorf("3 zones, 5.40 expected: %v", f)
	}
	if f.ObjAt("perTripWithTen").Num("price") != 3.47 {
		t.Errorf("T-casual 3 zones per trip: %v", f.ObjAt("perTripWithTen"))
	}
	// Sants -> Mataró: reverse pair, same count.
	if g := fareOf(t, fareLegObj("rail", "Barcelona-Sants", "Mataró", "2026-11-24T10:00:00.000Z", "2026-11-24T10:45:00.000Z")); g == nil || g.ObjAt("zones").Num("count") != 3 {
		t.Errorf("reverse: %v", g)
	}
	if fareOf(t, fareLegObj("rail", "Mataró", "Estació Desconeguda", "2026-11-24T10:00:00.000Z", "2026-11-24T10:45:00.000Z")) != nil {
		t.Error("unknown station must have no fare")
	}
	itin := O("legs", []any{fareLegObj("rail", "Mataró", "Nowhere", "2026-11-24T10:00:00.000Z", "2026-11-24T10:45:00.000Z")})
	if itineraryFare(itin) != nil {
		t.Error("unknown zone must give nil")
	}
}

func fareLegFull(mode, agency, lineCode, fromID, fromName, toID, toName, board, alight string) *Obj {
	o := O(
		"agencyId", agency,
		"lineId", lineCode,
		"lineCode", lineCode,
		"fromStop", O("id", fromID, "name", fromName),
		"toStop", O("id", toID, "name", toName),
		"boardAt", board,
		"alightAt", alight,
	)
	if mode != "" {
		o.Set("mode", mode)
	}
	return o
}

func TestFareAtmFullMatrixAndPrimeSectors(t *testing.T) {
	testFareTable(t)
	// FGC Bellaterra (2C') <-> Pl. Catalunya (1): prime sector counts as 1 zone from zone 1.
	f := fareOf(t, fareLegFull("rail", "fgc", "S2", "BT1", "Bellaterra", "PC1", "Pl. Catalunya",
		"2026-11-24T10:00:00.000Z", "2026-11-24T10:30:00.000Z"))
	if f == nil {
		t.Fatal("expected ATM fare for FGC Bellaterra -> Pl. Catalunya")
	}
	if f.ObjAt("zones").Num("count") != 1 || f.ObjAt("cheapestSingle").Num("price") != 2.9 {
		t.Errorf("prime sector 2C'->1 expected 1 zone / 2.90, got: %v", f)
	}
	// Mataró (3E) -> Girona (outside ATM): no sector -> nil.
	if g := fareOf(t, fareLegFull("rail", "rodalies", "RG1", "79500", "Mataró", "79300", "Girona",
		"2026-11-24T10:00:00.000Z", "2026-11-24T11:30:00.000Z")); g != nil {
		t.Errorf("outside-ATM station must return nil, got: %v", g)
	}
}

func TestFareBoundaryOverrideAppliesOnlyToMultiTrip(t *testing.T) {
	testFareTable(t)
	// Mataró (3E, 79500) <-> Cabrera de Mar - Vilassar de Mar (2E, 79412):
	// Matrix says 2 zones (BS2 = 4.15 €), but ROD_Z1 priority-1 gives TC1 (1.30 €/trip).
	// Use the real planner agencyId ("renfe_rodalies") to verify alias normalization.
	f := fareOf(t, fareLegFull("rail", "renfe_rodalies", "R1", "79500", "Mataró", "79412", "Cabrera de Mar - Vilassar de Mar",
		"2026-11-24T10:00:00.000Z", "2026-11-24T10:05:00.000Z"))
	if f == nil {
		t.Fatal("expected fare for Mataró -> Cabrera de Mar")
	}
	if f.ObjAt("zones").Num("count") != 2 {
		t.Errorf("matrix zones should remain 2, got %v", f.ObjAt("zones"))
	}
	if f.ObjAt("cheapestSingle").Num("price") != 4.15 {
		t.Errorf("single ticket should NOT get boundary override (expected 4.15), got %v", f.ObjAt("cheapestSingle"))
	}
	if f.ObjAt("perTripWithTen").Num("price") != 1.3 {
		t.Errorf("T-casual SHOULD get 1-zone boundary override (expected 1.30), got %v", f.ObjAt("perTripWithTen"))
	}
}

func TestFareOverridesNonIntegratedAerobusAndAirport(t *testing.T) {
	testFareTable(t)
	// Cremallera de Núria (FGC L1): stops sit in sector 7H, MUST NOT be priced with ATM.
	if f := fareOf(t, fareLegFull("rail", "fgc", "L1", "QL", "Queralbs", "NU", "Núria",
		"2026-11-24T10:00:00.000Z", "2026-11-24T10:20:00.000Z")); f != nil {
		t.Errorf("Cremallera de Núria must not get ATM fare, got: %v", f)
	}
	// Rodalies RT1 (not in STI_Barcelona): must return nil with real agencyId "renfe_rodalies".
	if f := fareOf(t, fareLegFull("rail", "renfe_rodalies", "RT1", "79500", "Mataró", "71801", "Barcelona-Sants",
		"2026-11-24T10:00:00.000Z", "2026-11-24T10:45:00.000Z")); f != nil {
		t.Errorf("RT1 (non-STI) must return nil, got: %v", f)
	}
	// Aerobús A1: non-integrated 7.75 € single, no T-casual.
	ab := fareOf(t, fareLegFull("", "amb", "A1", "1", "Pl. Catalunya", "2", "Aeroport T1",
		"2026-11-24T10:00:00.000Z", "2026-11-24T10:35:00.000Z"))
	if ab == nil || ab.ObjAt("cheapestSingle").Num("price") != 7.75 || ab.Get("perTripWithTen") != nil {
		t.Errorf("Aerobús override expected 7.75 single / nil ten, got: %v", ab)
	}
	// Airport Metro L9 Sud: Bitllet Aeroport 5.90 €, T-casual not valid.
	am := fareOf(t, fareLegFull("rail", "tmb", "L9S", "1.901", "Aeroport T1", "1.111", "Zona Universitària",
		"2026-11-24T10:00:00.000Z", "2026-11-24T10:32:00.000Z"))
	if am == nil || am.ObjAt("cheapestSingle").Num("price") != 5.9 || am.Get("perTripWithTen") != nil {
		t.Errorf("Airport metro override expected 5.90 single / nil ten, got: %v", am)
	}
}

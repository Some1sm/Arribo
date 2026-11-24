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

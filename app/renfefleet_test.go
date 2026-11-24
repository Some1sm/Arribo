package main

import (
	"reflect"
	"testing"
	"time"
)

func TestRenfeUsualSeries(t *testing.T) {
	m, err := readRenfeUsualSeries("../src/data/renfe_fleet.json")
	if err != nil {
		t.Fatal(err)
	}
	if got := m["R15"]; !reflect.DeepEqual(got, []string{"448", "449", "470"}) {
		t.Errorf("R15 = %v", got)
	}
	for line, ss := range m {
		for _, s := range ss {
			if s == "452" {
				t.Errorf("%s lists the planned series 452", line)
			}
		}
	}
	renfeFleetOnce.Do(func() {})
	renfeUsual = m
	snap := &rtSnapshot{}
	v := &rtVehicle{LineCode: "R15", Label: "R15-15012"}
	o := trainJSON(reportOperators[0], snap, v, time.Now())
	if !reflect.DeepEqual(o.Get("usualSeries"), []any{"448", "449", "470"}) {
		t.Errorf("trainJSON usualSeries = %v", o.Get("usualSeries"))
	}
	if o := trainJSON(reportOperators[0], snap, &rtVehicle{LineCode: "R99"}, time.Now()); o.Has("usualSeries") {
		t.Errorf("a line the table does not list gets no usualSeries")
	}
}

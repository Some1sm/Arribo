package main

import (
	"testing"
	"time"
)

const geotrenSample = `{"total_count": 2, "results": [
 {"id": "6c4b|6a2d", "lin": "S1", "tipus_unitat": "112", "ut": "1f2cc5fd027c",
  "ocupacio_mi_percent": "39", "ocupacio_mi_tram": "2", "ocupacio_ri_percent": "41", "ocupacio_m1_percent": "30", "ocupacio_m2_percent": "x"},
 {"id": "6c4b|682d", "lin": "S2", "tipus_unitat": "213", "ut": ""}]}`

func TestParseGeotren(t *testing.T) {
	at := time.Unix(1795546731, 0)
	units, err := parseGeotren([]byte(geotrenSample), at)
	if err != nil {
		t.Fatal(err)
	}
	u, ok := units["1f2cc5fd027c"]
	if len(units) != 1 || !ok || u.Series != "112" || len(u.Cars) != 3 || u.Cars[0].Car != "M1" || u.Cars[2].Car != "RI" {
		t.Fatalf("units: %+v", units)
	}
	o := fgcUnitJSON(units, "1f2cc5fd027c", at.Add(time.Minute))
	if o == nil || o.Get("series") != "112" || o.Get("occupancyPercent") != 37.0 || len(o.Get("cars").([]any)) != 3 {
		t.Errorf("unit: %s", toJSON(o))
	}
	if fgcUnitJSON(units, "1f2cc5fd027c", at.Add(fgcGeotrenMaxAge+time.Second)) != nil {
		t.Errorf("an old record is not shown")
	}
	if fgcUnitJSON(units, "", at) != nil || fgcUnitJSON(units, "nope", at) != nil {
		t.Errorf("unknown vehicle")
	}
	snap := &rtSnapshot{Units: units}
	v := &rtVehicle{VehicleID: "1f2cc5fd027c", LineCode: "S1", ObservedAt: at.Unix()}
	if j := trainJSON(reportOperators[1], snap, v, at); j.Get("unit") == nil {
		t.Errorf("trainJSON has no unit: %s", toJSON(j))
	}
}

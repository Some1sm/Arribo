package main

import (
	"math"
	"testing"
	"time"
)

func TestDecodeSagalesPolyline(t *testing.T) {
	// Standard Google polyline example: "_p~iF~ps|U_ulLnnqC_mqNvxq`@"
	// -> (38.5, -120.2), (40.7, -120.95), (43.252, -126.453)
	pts := decodeSagalesPolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")
	if len(pts) != 3 {
		t.Fatalf("expected 3 points, got %d", len(pts))
	}
	if math.Abs(pts[0][0]-38.5) > 1e-4 || math.Abs(pts[0][1]-(-120.2)) > 1e-4 {
		t.Errorf("pt0: %v", pts[0])
	}
	if math.Abs(pts[2][0]-43.252) > 1e-4 || math.Abs(pts[2][1]-(-126.453)) > 1e-4 {
		t.Errorf("pt2: %v", pts[2])
	}
}

func TestParseSagalesDeduplicatesVehicleAndReadsPostion(t *testing.T) {
	now := time.UnixMilli(1795555000000)
	// Same bus vehicle.id "0930" appears twice (for current trip and next trip).
	body := []byte(`{
		"linia": {"id":"691","shortName":"691","longName":"Pineda - Calella","color":"c51313","textColor":"ffffff"},
		"ruta": {
			"shapes": "_p~iF~ps|U_ulLnnqC",
			"stops": [
				{"id": 7483, "stopCode": "6801", "stopName": "Pineda", "stopLat": "41.628008", "stopLon": "2.693729", "stopsequence": 1},
				{"id": 280,  "stopCode": "6802", "stopName": "Calella", "stopLat": "41.613000", "stopLon": "2.660000", "stopsequence": 2}
			]
		},
		"bus": {
			"entities": [
				{
					"id": "280",
					"tripUpdate": {"stopTimeUpdate": [{"stopId":"280","realTime":true,"arrival":{"delay":180,"time":1795558000000}}]},
					"vehicle": {
						"currentStatus": "IN_TRANSIT_TO",
						"stopId": "280",
						"timestamp": 1795554990000,
						"postion": {"latitude": 41.625, "longitude": 2.679, "bearing": 279, "speed": 5.2},
						"trip": {"tripId": "LATER_TRIP", "directionId": "0", "headSign": "Calella"},
						"vehicle": {"id": "0930"}
					}
				},
				{
					"id": "280",
					"tripUpdate": {"stopTimeUpdate": [{"stopId":"280","realTime":true,"arrival":{"delay":120,"time":1795555300000}}]},
					"vehicle": {
						"currentStatus": "IN_TRANSIT_TO",
						"stopId": "280",
						"timestamp": 1795554995000,
						"postion": {"latitude": 41.6251, "longitude": 2.6792, "bearing": 280, "speed": 5.5},
						"trip": {"tripId": "ACTIVE_TRIP", "directionId": "0", "headSign": "Calella"},
						"vehicle": {"id": "0930"}
					}
				}
			]
		}
	}`)
	meta, code, name, color, _, buses, preds, err := parseSagalesResponse(691, 0, "", map[string]string{"280": "Calella"}, body, now)
	if err != nil {
		t.Fatal(err)
	}
	if code != "691" || name != "Pineda - Calella" || color != "#C51313" {
		t.Errorf("meta fields: code=%q name=%q color=%q", code, name, color)
	}
	if meta == nil || len(meta.Stops) != 2 || len(meta.Coords) != 2 {
		t.Fatalf("unexpected route meta: %+v", meta)
	}
	if len(buses) != 1 {
		t.Fatalf("expected 1 deduplicated bus for vehicle 0930, got %d", len(buses))
	}
	if buses[0].TripID != "ACTIVE_TRIP" || buses[0].DelaySec == nil || *buses[0].DelaySec != 120 {
		t.Errorf("expected ACTIVE_TRIP with delay 120, got %+v", buses[0])
	}
	if math.Abs(buses[0].Lat-41.6251) > 1e-6 || buses[0].StopName != "Calella" {
		t.Errorf("postion/stopName mismatch: %+v", buses[0])
	}
	if len(preds) != 2 || preds[0].ArriveMs >= preds[1].ArriveMs {
		t.Errorf("expected 2 sorted predictions, got %+v", preds)
	}
}

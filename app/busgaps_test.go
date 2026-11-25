package main

import (
	"path/filepath"
	"testing"
	"time"
)

func TestBusGapStoreGPSAndPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bus_gaps.json")
	st := newBusGapStore(path)
	t0 := time.Date(2026, 11, 25, 18, 0, 0, 0, madrid)

	// Two buses so feedWide is false (bus 2 reports while bus 1 is silent).
	st.observeGPS(movAgencyID, "1102", "C-10", "1", "Metro La Pau", 41.423, 2.206, float64(t0.UnixMilli()))
	st.observeGPS(movAgencyID, "1105", "e11.1", "1", "Pl. Tereses", 41.540, 2.444, float64(t0.Add(60*time.Second).UnixMilli()))
	st.observeGPS(movAgencyID, "1105", "e11.1", "1", "Pl. Tereses", 41.535, 2.440, float64(t0.Add(120*time.Second).UnixMilli()))
	// Bus 1102 returns after 3 minutes (180 s >= 90 s gap threshold).
	st.observeGPS(movAgencyID, "1102", "C-10", "1", "Francesc Macià", 41.448, 2.243, float64(t0.Add(180*time.Second).UnixMilli()))

	now := float64(t0.Add(5 * time.Minute).UnixMilli())
	res := st.hotspots(movAgencyID, "gps", "", "", 7, now)
	totals := res.ObjAt("totals")
	if totals.Num("mapped") != 1 || totals.Num("vehicles") != 1 {
		t.Fatalf("expected 1 mapped Moventis GPS gap, got %s", toJSON(totals))
	}
	cells := res.Arr("cells")
	if len(cells) != 1 || jsString(cells[0].(*Obj).Get("stopName")) != "Metro La Pau" {
		t.Fatalf("unexpected cell: %s", toJSON(cells))
	}

	// Verify disk persistence across reload.
	st.save(true)
	reloaded := newBusGapStore(path)
	res2 := reloaded.hotspots(movAgencyID, "gps", "C-10", "", 7, now)
	if res2.ObjAt("totals").Num("mapped") != 1 {
		t.Fatalf("expected persisted C-10 gap after reload, got %s", toJSON(res2.ObjAt("totals")))
	}
}

func TestBusGapStorePerStopArrivalDropout(t *testing.T) {
	st := newBusGapStore(filepath.Join(t.TempDir(), "bus_gaps.json"))
	static := &movStatic{
		Lines: map[int]movLine{53: {ID: 53, Code: "C-10"}},
		Routes: map[int][]movRoute{
			53: {{
				LineID: 53, Trayecto: 2, Dest: "MATARÓ",
				Stops: []movStop{{ID: 7192, Name: "Francesc Macià/Maria Cristina", Lat: 41.4476, Lon: 2.2426}},
			}},
		},
	}
	t0 := time.Date(2026, 11, 25, 18, 0, 0, 0, madrid)

	// Poll 1: live bus is 12 min away (720 s -> expected 18:12).
	st.observeMovStopArrivals(static, 7192, []movStopETA{
		{LineID: 53, Dest: "Mataró", EtaSec: []float64{720}},
	}, t0)

	// Poll 2 (4 min later, 18:04 — bus should still be 8 min away!): live prediction vanished!
	st.observeMovStopArrivals(static, 7192, []movStopETA{
		{LineID: 53, Dest: "(C10) BCN - MATARÓ (PER LA NII)", Sched: []string{"18:12", "18:57"}},
	}, t0.Add(4*time.Minute))

	now := float64(t0.Add(5 * time.Minute).UnixMilli())
	res := st.hotspots(movAgencyID, "stop", "", "", 7, now)
	if res.ObjAt("totals").Num("mapped") != 1 {
		t.Fatalf("expected 1 per-stop signal loss, got %s", toJSON(res.ObjAt("totals")))
	}
	cell := res.Arr("cells")[0].(*Obj)
	if jsString(cell.Get("stopName")) != "Francesc Macià/Maria Cristina" {
		t.Fatalf("expected Francesc Macià/Maria Cristina, got %s", toJSON(cell))
	}
	// GPS mode must remain separate (0 GPS gaps).
	gpsRes := st.hotspots(movAgencyID, "gps", "", "", 7, now)
	if gpsRes.ObjAt("totals").Num("mapped") != 0 {
		t.Fatalf("stop dropout leaked into gps mode: %s", toJSON(gpsRes.ObjAt("totals")))
	}
}

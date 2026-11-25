package main

import (
	"errors"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Answers captured from moventis.es on 2026-11-23 (C-10, line 53).
const (
	movTestPlaceholder = `[{"idLinea":"A","desc_linea":"A","trayectos":{"A":{"0A":{"minutos":"' ''","adaptada":"A","real":"N","hora":"A","tiempo":"A h  min"}}},"incidencias":null,"selected":0}]`
	movTestTimetable   = `[{"idLinea":53,"desc_linea":"C-10","trayectos":{"(C10) BCN - MATARÓ (PER LA NII)":{"00044":{"minutos":"44' 00''","adaptada":null,"real":"N","hora":"22:08","tiempo":"00 h 44 min"}}},"incidencias":null,"selected":1}]`
	movTestTwoBuses    = `[{"idLinea":53,"desc_linea":"C-10","trayectos":{"Mataró":[{"minutos":"26 min 42.3781659 s","adaptada":null,"real":"S"},{"minutos":"37 min 05.0064306 s","adaptada":null,"real":"S"}]},"incidencias":null,"selected":1}]`
	movTestMixed       = `[{"idLinea":53,"desc_linea":"C-10","trayectos":{"Mataró":[{"minutos":"00 min 45.0624534 s","adaptada":null,"real":"S"}],"(C10) BCN - MATARÓ (PER LA NII)":{"00049":{"minutos":"49' 00''","adaptada":null,"real":"N","hora":"22:14","tiempo":"00 h 49 min"}}},"incidencias":null,"selected":1},{"idLinea":59,"desc_linea":"C-30","trayectos":{"Vilassar de Mar":[{"minutos":"37 min 59.3 s","adaptada":null,"real":"S"}]},"incidencias":null,"selected":0}]`
)

func movTestRoutes(t *testing.T) []movRoute {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "moventis_c10_trayectos.json"))
	if err != nil {
		t.Fatal(err)
	}
	routes, err := parseMovRoutes(53, b)
	if err != nil {
		t.Fatal(err)
	}
	return routes
}

func TestMovParseRoutes(t *testing.T) {
	routes := movTestRoutes(t)
	if len(routes) != 2 {
		t.Fatalf("routes: %d", len(routes))
	}
	var toMataro *movRoute
	for i := range routes {
		if routes[i].Trayecto == 2 {
			toMataro = &routes[i]
		}
	}
	if toMataro == nil || toMataro.Dest != "MATARÓ" || len(toMataro.Stops) < 30 || toMataro.Stops[0].ID != 19946 {
		t.Fatalf("route 2: %+v", toMataro)
	}
	for i := 1; i < len(toMataro.Stops); i++ {
		if toMataro.Stops[i].Km < toMataro.Stops[i-1].Km {
			t.Errorf("stops out of order at %d", i)
		}
	}
	if _, err := parseMovRoutes(53, []byte(`[{"numLinea":"53"}]`)); !errors.Is(err, errMovNoRoutes) {
		t.Errorf("empty answer: %v", err)
	}
}

func TestMovParseStopTimes(t *testing.T) {
	if _, err := parseMovStopTimes([]byte(movTestPlaceholder)); !errors.Is(err, errMovThrottled) {
		t.Errorf("placeholder: %v", err)
	}
	// Timetable-only times are not predictions: no EtaSec, only Sched.
	if e, err := parseMovStopTimes([]byte(movTestTimetable)); err != nil || len(e) != 1 || len(e[0].EtaSec) != 0 || len(e[0].Sched) != 1 || e[0].Sched[0] != "22:08" {
		t.Errorf("timetable-only times: %+v %v", e, err)
	}
	e, err := parseMovStopTimes([]byte(movTestTwoBuses))
	if err != nil || len(e) != 1 || e[0].LineID != 53 || e[0].Dest != "Mataró" || len(e[0].EtaSec) != 2 || math.Abs(e[0].EtaSec[0]-1602.378) > 0.01 {
		t.Errorf("two buses: %+v %v", e, err)
	}
	e, err = parseMovStopTimes([]byte(movTestMixed))
	if err != nil || len(e) != 3 {
		t.Fatalf("mixed: %+v %v", e, err)
	}
	for _, x := range e {
		if x.LineID == 53 && x.Dest == "Mataró" && (len(x.EtaSec) != 1 || math.Abs(x.EtaSec[0]-45.06) > 0.01) {
			t.Errorf("C-10 at the stop: %+v", x)
		}
	}
}

func TestMovSamples(t *testing.T) {
	routes := movTestRoutes(t)
	s := &movStatic{Lines: map[int]movLine{53: {ID: 53, Code: "C-10"}}, Routes: map[int][]movRoute{53: routes}}
	sm := movSamples(s, []int{53})
	seen := map[int]bool{}
	for _, x := range sm {
		if seen[x.StopID] {
			t.Errorf("stop %d asked twice", x.StopID)
		}
		seen[x.StopID] = true
	}
	for _, rt := range routes {
		if !seen[rt.Stops[0].ID] || !seen[rt.Stops[len(rt.Stops)-1].ID] {
			t.Errorf("route %d: first or last stop not sampled", rt.Trayecto)
		}
	}
	// C-10 (about 27 km a direction, 26-minute day-average headway at
	// 22 km/h) is sampled about every 7.6 km: 4 or 5 stops a direction, not
	// the 19 or 20 of the old fixed 1.5 km spacing.
	total := len(routes[0].Stops) + len(routes[1].Stops)
	if len(sm) > 12 || len(sm) < 6 {
		t.Errorf("%d samples of %d stops, want 6..12", len(sm), total)
	}
	for _, rt := range routes {
		spacing := movSpacingKm(53, rt.Stops[len(rt.Stops)-1].Km)
		last := math.Inf(-1)
		for i, st := range rt.Stops {
			if !seen[st.ID] || i == len(rt.Stops)-1 {
				continue
			}
			// a stop may be picked from the window [spacing/2, spacing]
			if i > 0 && st.Km-last < spacing/2 {
				t.Errorf("route %d: stop %d at %.1f km is %.1f km after the previous sample (spacing %.1f)", rt.Trayecto, st.ID, st.Km, st.Km-last, spacing)
			}
			last = st.Km
		}
	}
}

// TestMovSpacingKm: speed x headway x factor, clamped to [1.5 km, route/2].
func TestMovSpacingKm(t *testing.T) {
	cases := []struct {
		line    int
		routeKm float64
		want    float64
	}{
		{53, 27, 22 * 26.0 / 60 * movSpacingFactor}, // C-10
		{47, 32, 40 * 8.0 / 60 * movSpacingFactor},  // e11.1, every 8 minutes
		{68, 38, 19}, // N-80: capped at half the route
		{999, 20, 22 * 15.0 / 60 * movSpacingFactor}, // an unlisted line: the defaults
		{53, 2, movStopSpacingKm},                    // never under 1.5 km
	}
	for _, c := range cases {
		if got := movSpacingKm(c.line, c.routeKm); math.Abs(got-c.want) > 1e-9 {
			t.Errorf("movSpacingKm(%d, %v) = %v, want %v", c.line, c.routeKm, got, c.want)
		}
	}
}

// TestMovEstimate: the probe's C-10 countdowns towards Mataró give one bus,
// just before El Masnou (0:45 from Camil Fabra); the bus 20 minutes from the
// route's second stop has not left its terminus and is not drawn. Positions
// run with the countdown, and never go behind the previous sampled stop.
func TestMovEstimate(t *testing.T) {
	routes := movTestRoutes(t)
	s := &movStatic{Lines: map[int]movLine{53: {ID: 53, Code: "C-10", Color: "#9AFF1F"}}, Routes: map[int][]movRoute{53: routes}}
	at := time.Date(2026, 11, 23, 21, 25, 0, 0, madrid)
	eta := map[int]float64{7187: 1252, 7188: 1602, 7189: 1740, 7190: 1826, 7191: 2018, 7192: 2221, 7193: 2273, 7194: 2453, 7201: 45, 7204: 242, 7205: 279}
	preds := map[[3]int]movPrediction{}
	for stop, e := range eta {
		preds[[3]int{53, 2, stop}] = movPrediction{LineID: 53, Trayecto: 2, StopID: stop, EtaSec: []float64{e}, At: at}
	}
	vs := movEstimate(s, []int{53}, preds, at)
	if len(vs) != 1 {
		t.Fatalf("buses: %s", toJSON(vs))
	}
	v := vs[0].(*Obj)
	if v.Get("stopName") != "C. de Camil Fabra (Laboratoris Alcon-Cusí)" || v.Get("isEstimated") != true || v.Get("positionSource") != "stop_predictions" || v.Get("lineRef") != "moventis:C-10" {
		t.Errorf("bus: %s", toJSON(v))
	}
	// Between St.Bru/Prim (the previous sampled stop) and Camil Fabra.
	if lat := jsNumber(v.Get("lat")); lat < 41.453 || lat > 41.4724 {
		t.Errorf("position: %s", toJSON(v))
	}
	// A minute later the countdown has passed: the bus is at the stop.
	later := movEstimate(s, []int{53}, preds, at.Add(time.Minute))
	if len(later) != 1 || jsNumber(later[0].(*Obj).Get("nextStopEtaSec")) != 0 {
		t.Errorf("a minute later: %s", toJSON(later))
	}
	// Predictions older than movObsMaxAge are not used.
	if old := movEstimate(s, []int{53}, preds, at.Add(movObsMaxAge+time.Minute)); len(old) != 0 {
		t.Errorf("stale predictions used: %s", toJSON(old))
	}
}

// TestMovRouteFor: a prediction at a stop both directions share goes to the
// route whose destination matches.
func TestMovRouteFor(t *testing.T) {
	routes := movTestRoutes(t)
	s := &movStatic{Routes: map[int][]movRoute{53: routes}}
	if rt, ok := s.routeFor(53, 7201, "Mataró"); !ok || rt.Trayecto != 2 {
		t.Errorf("only route through the stop: %+v %v", rt.Trayecto, ok)
	}
	if _, ok := s.routeFor(53, 999999, "Mataró"); ok {
		t.Error("unknown stop matched")
	}
}

func TestMovRouteDest(t *testing.T) {
	cases := map[string]string{
		"(C10) BCN - MATARÓ (PER LA NII)": "MATARÓ",
		"865 MATARÓ-BELLATERRA":           "BELLATERRA",
		"(C30) MATARÓ - VILASSAR DE DALT": "VILASSAR DE DALT",
	}
	for desc, want := range cases {
		if got := movRouteDest(movRoute{Desc: desc}); got != want {
			t.Errorf("%q -> %q, want %q", desc, got, want)
		}
	}
}

func TestMovKML(t *testing.T) {
	kml := []byte(`<kml><Document><Placemark><LineString><coordinates>
	  2.4416,41.5398,0 2.4420,41.5401,0
	  2.4431,41.5409,0</coordinates></LineString></Placemark></Document></kml>`)
	pts := parseMovKML(kml)
	if len(pts) != 3 || pts[0] != [2]float64{41.5398, 2.4416} {
		t.Errorf("points: %v", pts)
	}
	if parseMovKML([]byte(`<kml><name>x</name></kml>`)) != nil {
		t.Error("no coordinates should give nil")
	}
}

// TestMovCatalog: the followed lines go into the line catalog with their
// routes as directions, and "moventis:C-10" opens like a train line.
func TestMovCatalog(t *testing.T) {
	routes := movTestRoutes(t)
	s := &movStatic{Lines: map[int]movLine{53: {ID: 53, Code: "C-10", Name: "MATARO - BARCELONA (PER N-II)", Color: "#9AFF1F"}}, Routes: map[int][]movRoute{53: routes}}
	s.publishCatalog([]int{53})
	defer rtCatalog.Delete(movAgencyID)
	if ops := lineOperators(); len(ops) != len(reportOperators)+1 || ops[len(ops)-1].ID != movAgencyID {
		t.Fatalf("operators: %+v", ops)
	}
	info, op, code, ok := railLineRef("moventis:c-10")
	if !ok || info.ID != movAgencyID || code != "C-10" {
		t.Fatalf("line ref: %v %v %v", info.ID, code, ok)
	}
	prof := op.Profiles["C-10"]
	if prof == nil || len(prof.Directions) != 2 || prof.Directions[0].Headsign != "Barcelona" || prof.Directions[1].Headsign != "Mataró" {
		t.Fatalf("profile: %+v", prof)
	}
	if !prof.Directions[1].GeometryFromStops || len(prof.Directions[1].Stops) < 30 {
		t.Errorf("direction 1: %d stops, from stops %v", len(prof.Directions[1].Stops), prof.Directions[1].GeometryFromStops)
	}
	d := railLineDetails(info, op, code, "1", nil, time.Now())
	if d.Get("mode") != "Bus" || d.Get("lineId") != "moventis:C-10" {
		t.Errorf("line view: mode %v id %v", d.Get("mode"), d.Get("lineId"))
	}
}

// movTestRoute builds a route of stops one km apart, ids from firstID, with
// the stop at km sharedKm replaced by sharedID.
func movTestRoute(line, trayecto, firstID, km, sharedKm, sharedID int) movRoute {
	rt := movRoute{LineID: line, Trayecto: trayecto}
	for k := 0; k <= km; k++ {
		id := firstID + k
		if k == sharedKm {
			id = sharedID
		}
		rt.Stops = append(rt.Stops, movStop{ID: id, Km: float64(k)})
	}
	return rt
}

// TestMovSamplesSharedStop: two lines whose routes share a stop at km 3 (the
// window for the first sample is km 2.2 to 4.4): the shared stop is asked
// instead of the stop further on, once.
func TestMovSamplesSharedStop(t *testing.T) {
	a := movTestRoute(901, 1, 1000, 20, 3, 500)
	b := movTestRoute(902, 1, 2000, 20, 3, 500)
	s := &movStatic{Routes: map[int][]movRoute{901: {a}, 902: {b}}}
	sm := movSamples(s, []int{901, 902})
	count := map[int]int{}
	for _, x := range sm {
		count[x.StopID]++
	}
	if count[500] != 1 {
		t.Errorf("shared stop asked %d times, want 1", count[500])
	}
	for _, id := range []int{1004, 2004, 1002, 2002} {
		if count[id] != 0 {
			t.Errorf("stop %d sampled although the shared stop is in its window", id)
		}
	}
	for _, rt := range []movRoute{a, b} {
		if count[rt.Stops[0].ID] != 1 || count[rt.Stops[len(rt.Stops)-1].ID] != 1 {
			t.Errorf("first or last stop of line %d missing", rt.LineID)
		}
	}
	for id, n := range count {
		if n > 1 {
			t.Errorf("stop %d asked %d times", id, n)
		}
	}
	// With nothing shared the furthest stop of the window wins the tie.
	c := movTestRoute(903, 1, 3000, 20, -1, 0)
	sm = movSamples(&movStatic{Routes: map[int][]movRoute{903: {c}}}, []int{903})
	if len(sm) < 3 || sm[1].StopID != 3004 {
		t.Errorf("tie: want the furthest stop (3004), got %+v", sm)
	}
}

func TestMovNextSched(t *testing.T) {
	at := time.Date(2026, 11, 23, 21, 25, 0, 0, madrid)
	if got := movNextSched([]string{"22:30", "22:08"}, at); !got.Equal(time.Date(2026, 11, 23, 22, 8, 0, 0, madrid)) {
		t.Errorf("same day: %v", got)
	}
	late := time.Date(2026, 11, 23, 23, 50, 0, 0, madrid)
	if got := movNextSched([]string{"00:05"}, late); !got.Equal(time.Date(2026, 11, 24, 0, 5, 0, 0, madrid)) {
		t.Errorf("after midnight: %v", got)
	}
	if !movNextSched([]string{"A", "7:5"}, at).IsZero() {
		t.Error("bad times parsed")
	}
}

func TestMovShouldAsk(t *testing.T) {
	now := time.Date(2026, 11, 23, 13, 0, 0, 0, madrid)
	obs := func(age time.Duration, o map[int]movLineObs) movStopObs {
		return movStopObs{At: now.Add(-age), Lines: o}
	}
	idle := map[int]movLineObs{53: {NextSched: now.Add(90 * time.Minute)}, 57: {}}
	followed := []int{53, 57}
	if movShouldAsk(now, obs(10*time.Minute, idle), true, followed, nil) {
		t.Error("no bus due: should skip")
	}
	if !movShouldAsk(now, movStopObs{}, false, followed, nil) {
		t.Error("never asked: should ask")
	}
	live := map[int]movLineObs{53: {Live: true}, 57: {}}
	if !movShouldAsk(now, obs(10*time.Minute, live), true, followed, nil) {
		t.Error("live bus seen: should ask")
	}
	soon := map[int]movLineObs{53: {NextSched: now.Add(40 * time.Minute)}}
	if !movShouldAsk(now, obs(10*time.Minute, soon), true, followed, nil) {
		t.Error("departure within 60 min: should ask")
	}
	if !movShouldAsk(now, obs(31*time.Minute, idle), true, followed, nil) {
		t.Error("30 minutes unasked: should ask")
	}
	if movShouldAsk(now, obs(29*time.Minute, idle), true, followed, nil) {
		t.Error("29 minutes: still skipped")
	}
}

func TestCleanMovStopName(t *testing.T) {
	cases := map[string]string{
		"Pg. de Prat de la Riba (Estació D¿Ocata)":           "Pg. de Prat de la Riba (Estació d'Ocata)",
		"Pg. de la Riera / Pl. U D¿Octubre":                  "Pg. de la Riera / Pl. U d'Octubre",
		"Camí Ral / Pl. de L´Ajuntament":                     "Camí Ral / Pl. de l'Ajuntament",
		"Baldomer Solà/Torrent D´En Valls":                   "Baldomer Solà/Torrent d'en Valls",
		"Rda. D´O`Donnell (Biblioteca Pompeu Fabra)":         "Rda. d'O'Donnell (Biblioteca Pompeu Fabra)",
		"Rbla. de  Guipúscoa (Metro la Pau)":                 "Rbla. de Guipúscoa (Metro la Pau)",
		"(Torrent de L´Ase) Prat de la Riba/Mare Déu  Núria": "(Torrent de l'Ase) Prat de la Riba/Mare Déu Núria",
	}
	for in, want := range cases {
		if got := cleanMovStopName(in); got != want {
			t.Errorf("cleanMovStopName(%q) = %q, want %q", in, got, want)
		}
	}
}

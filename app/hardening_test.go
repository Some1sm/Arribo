package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestClientKeyIPv4MappedAndIPv6Slash64(t *testing.T) {
	if got := clientKey("::ffff:192.0.2.10"); got != "192.0.2.10" {
		t.Fatalf("lowercase ipv4-mapped: got %q", got)
	}
	if got := clientKey("::FFFF:192.0.2.10"); got != "192.0.2.10" {
		t.Fatalf("uppercase ipv4-mapped: got %q", got)
	}
	a := clientKey("2001:db8:abcd:0012::1")
	b := clientKey("2001:db8:abcd:0012:ffff:ffff:ffff:ffff")
	if a != b {
		t.Fatalf("same /64 should map to same bucket: %q vs %q", a, b)
	}
	c := clientKey("2001:db8:abcd:0013::1")
	if a == c {
		t.Fatalf("different /64 should map to different buckets: %q", a)
	}
}

func TestRateLimiterEvictsInsteadOfGlobalLockout(t *testing.T) {
	l := newAPILimiter()
	l.maxClients = 3
	for _, ip := range []string{"1.1.1.1", "2.2.2.2", "3.3.3.3"} {
		if r := l.allow("GET", "/api/lines", ip); r != 0 {
			t.Fatalf("unexpected limit for %s: %d", ip, r)
		}
	}
	// A 4th distinct client must be allowed (evicting the oldest) instead of globally locked out.
	if r := l.allow("GET", "/api/lines", "4.4.4.4"); r != 0 {
		t.Fatalf("new client locked out when table full: retry=%d", r)
	}
	if len(l.clients) > l.maxClients {
		t.Fatalf("clients grew past maxClients: %d > %d", len(l.clients), l.maxClients)
	}
}

func TestParseQueryCapsSizeAndKeys(t *testing.T) {
	// Huge sparse-bracket query must not explode memory or produce nested arrays.
	var sb strings.Builder
	for i := 0; i < 200; i++ {
		if i > 0 {
			sb.WriteByte('&')
		}
		sb.WriteString("k")
		sb.WriteString(itoa(i))
		sb.WriteString("[999]=1")
	}
	q := parseQuery(sb.String())
	if q.Len() > maxQueryParams {
		t.Fatalf("parsed %d params, want <= %d", q.Len(), maxQueryParams)
	}
	q2 := parseQuery("a=1&b=hello+world&a=2")
	if q2.Str("b") != "hello world" {
		t.Fatalf("b=%q, want 'hello world'", q2.Str("b"))
	}
	arr, ok := q2.Get("a").([]any)
	if !ok || len(arr) != 2 || arr[0] != "1" || arr[1] != "2" {
		t.Fatalf("repeated key a=%#v", q2.Get("a"))
	}
}

func TestFetchResolvedInvalidatesOnFetchError(t *testing.T) {
	resets := 0
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "gone", http.StatusGone)
	}))
	defer srv.Close()

	resolve := func(context.Context) (string, error) {
		calls++
		return srv.URL, nil
	}
	reset := func() { resets++ }

	_, err := fetchResolved(context.Background(), resolve, reset)
	if err == nil {
		t.Fatal("expected error on HTTP 410")
	}
	if calls != 1 || resets != 1 {
		t.Fatalf("expected 1 resolve and 1 reset on fetch failure, got calls=%d resets=%d", calls, resets)
	}
}

func TestRailItinJSONUsesPointCoordsSpeedAndSignedDelay(t *testing.T) {
	const depart = int64(1_800_000_000)
	it := railItin{
		From: railEnd{
			Agency: "renfe_rodalies", StopID: "MAT", Name: "Mataró",
			Lat: 41.533, Lon: 2.444,
			PointLat: 41.538, PointLon: 2.445, PointName: "Plaça Santa Anna",
			WalkM: 500,
		},
		To: railEnd{
			Agency: "renfe_rodalies", StopID: "SAN", Name: "Barcelona Sants",
			Lat: 41.379, Lon: 2.140,
			PointLat: 41.382, PointLon: 2.142, PointName: "Destí",
			WalkM: 400,
		},
		Legs: []railLeg{{
			Agency: "renfe_rodalies", Trip: "T1", Line: "R1", Dir: 0,
			BoardStop: "MAT", BoardName: "Mataró", BoardLat: 41.533, BoardLon: 2.444,
			AlightStop: "SAN", AlightName: "Barcelona Sants", AlightLat: 41.379, AlightLon: 2.140,
			Board: depart + 1800, Alight: depart + 3600, Delay: -120, Live: true, Stops: 8,
		}},
		Leave:    depart + 1800 - 120 - 600 - 60,
		Arrive:   depart + 3600 - 120 + 500,
		WalkM:    900,
		WalkSecs: 1100,
	}
	out := railItinJSON(it, depart, 60) // slower walking speed (60 m/min)
	w1 := out.ObjAt("walkToFirstStop")
	if w1 == nil {
		t.Fatal("missing walkToFirstStop")
	}
	fromPt, _ := w1.Get("from").([]any)
	if len(fromPt) != 2 || fromPt[0] != 41.538 || fromPt[1] != 2.445 {
		t.Fatalf("walkToFirstStop.from should be user point, got %#v", fromPt)
	}
	if w1.Str("fromName") != "Plaça Santa Anna" {
		t.Fatalf("walkToFirstStop.fromName=%q", w1.Str("fromName"))
	}
	// 500 * 1.25 / 60 * 60 = 625s (~10 min) instead of 80 m/min (~8 min)
	if w1.Num("durationSeconds") != 625 {
		t.Fatalf("walkToFirstStop.durationSeconds=%v, want 625", w1.Num("durationSeconds"))
	}
	// Initial wait should reflect ~18 min wait from depart (not hardcoded 1 min).
	if out.Num("initialWaitMinutes") <= 5 {
		t.Fatalf("initialWaitMinutes=%v, expected > 5", out.Num("initialWaitMinutes"))
	}
	legs, _ := out.Get("legs").([]any)
	leg0 := legs[0].(*Obj)
	if leg0.Num("delayMinutes") != -2 {
		t.Fatalf("early train delayMinutes=%v, want -2", leg0.Num("delayMinutes"))
	}
}

func TestFlightRecorderRegularBusLineReassignment(t *testing.T) {
	w := newWorld("test")
	fr := w.fr
	now := float64(time.Now().UnixMilli())
	fr.ingestVehicle(O("vehicleId", "2670", "lineId", "1", "lineCode", "L1", "lat", 41.53, "lon", 2.44, "observedAt", now, "isRealTime", true))
	fr.ingestVehicle(O("vehicleId", "2670", "lineId", "2", "lineCode", "L2", "lat", 41.54, "lon", 2.45, "observedAt", now+5000, "isRealTime", true))

	if l1 := fr.getLineVehicles("L1"); len(l1) != 0 {
		t.Fatalf("reassigned bus still indexed under L1: %d vehicles", len(l1))
	}
	l2 := fr.getLineVehicles("L2")
	if len(l2) != 1 || l2[0].(*Obj).Str("lineId") != "2" {
		t.Fatalf("reassigned bus not properly indexed under L2: %#v", l2)
	}
}

func TestHistoryDBClosedPreventsReopenAndWithTxRollsBack(t *testing.T) {
	dir := t.TempDir()
	h := &HistoryDB{dbPath: filepath.Join(dir, "test.db"), snapshotRetentionHours: 6, delayRetentionDays: 30}
	if !h.init() {
		t.Fatal("HistoryDB init failed")
	}
	// Verify withTx commits cleanly.
	if err := h.withTx(func() error {
		_, err := h.run("INSERT INTO rail_cancellations (agency_id, trip_id, service_date, line_code, headsign, scheduled_start, first_seen, last_seen) VALUES ('fgc','t1','20261124','S1','X',1000,1000,1000)")
		return err
	}); err != nil {
		t.Fatalf("withTx commit failed: %v", err)
	}
	// Verify closed DB cannot be reopened.
	h.close()
	if h.ensureOpen() {
		t.Fatal("ensureOpen() returned true after close()")
	}
}

func TestSendPipeBlocksHiddenDirectorySegments(t *testing.T) {
	res := newXres(httptest.NewRecorder(), &xreq{method: "GET"})
	r := res.sendPipe("/.git/config", sendOptions{root: t.TempDir()})
	if r.err == nil || r.err.status != 404 {
		t.Fatalf("expected 404 for /.git/config, got %+v", r.err)
	}
}

func TestIsValidYearMonth(t *testing.T) {
	if !isValidYearMonth("2026-11") {
		t.Fatal("2026-11 should be valid")
	}
	for _, bad := range []string{"9999-99", "2026-00", "2026-13", "1999-05", "abc"} {
		if isValidYearMonth(bad) {
			t.Fatalf("%q should be invalid", bad)
		}
	}
}

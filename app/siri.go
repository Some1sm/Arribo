package main

// Port of src/mataroSiriClient.js: the Avanza SIRI SOAP client with its
// 20 s cache, 10 min stale fallback, circuit breaker and request coalescing.
//
// The source returns its cached array itself (fresh cache, coalesced joiners)
// and callers mutate both the vehicle objects and, in one place, the array.
// Cache entries therefore hold a *[]any so that every holder sees the same
// array, and the vehicle objects are shared *Obj values.

import (
	"errors"
	"fmt"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

type siriCacheEntry struct {
	ts   float64
	data *[]any
}

type siriFlight struct {
	done chan struct{}
	val  *[]any
}

// SiriClient is one process's client (the worker's talks SOAP, the server's
// goes through the worker over RPC).
type SiriClient struct {
	w                     *World
	hostname, path        string
	accountID, accountKey string
	cache                 map[string]*siriCacheEntry
	inflight              map[string]*siriFlight
	cacheTtlMs            float64
	staleFallbackTtlMs    float64
	lastWarnTime          float64
	consecutiveFailures   float64
	circuitOpenUntil      float64
	circuitCooldownMs     float64
	lastVehicleSuccessAt  any
	lastArrivalsSuccessAt any
	lastFailureAt         any
	lastError             any
	vehicleDeliveryStatus any
	rejectedFixes         float64
	// rpc is called with the world unlocked; it returns the worker's answer.
	rpc func(op string, args *Obj) (any, error)
	// soap replaces the network call in tests.
	soap func(action, body string) (int, string, error)
}

func newSiriClient(w *World) *SiriClient {
	id := os.Getenv("MATARO_SIRI_ACCOUNT_ID")
	if id == "" {
		id = "Mataro"
	}
	key := os.Getenv("MATARO_SIRI_ACCOUNT_KEY")
	if key == "" {
		key = "Mataro*WS"
	}
	return &SiriClient{
		w:                  w,
		hostname:           "sirimataro.avanzagrupo.com",
		path:               "/Siri/SiriWS.asmx",
		accountID:          id,
		accountKey:         key,
		cache:              map[string]*siriCacheEntry{},
		inflight:           map[string]*siriFlight{},
		cacheTtlMs:         20000,
		staleFallbackTtlMs: 10 * 60 * 1000,
		circuitCooldownMs:  30000,
	}
}

const siriMaxCacheEntries = 256

func (c *SiriClient) cacheEntry(key string) *siriCacheEntry { return c.cache[key] }

func (c *SiriClient) setCache(key string, entry *siriCacheEntry) {
	if _, exists := c.cache[key]; !exists && len(c.cache) >= siriMaxCacheEntries {
		// Evict expired entries first, then the oldest entry.
		now := float64(nowMs())
		oldestKey, oldestTs := "", math.Inf(1)
		for k, v := range c.cache {
			if now-v.ts >= c.staleFallbackTtlMs {
				delete(c.cache, k)
			} else if v.ts < oldestTs {
				oldestKey, oldestTs = k, v.ts
			}
		}
		if len(c.cache) >= siriMaxCacheEntries && oldestKey != "" {
			delete(c.cache, oldestKey)
		}
	}
	c.cache[key] = entry
}

func (c *SiriClient) setRpcBackend(fn func(op string, args *Obj) (any, error)) { c.rpc = fn }

func (c *SiriClient) isValidMataroCoord(lat, lon float64) bool {
	return mataroAgency.Bounds.contains(lat, lon)
}

// observationTimestamp is Date.parse(value) when plausible, else null.
func (c *SiriClient) observationTimestamp(value any) any {
	s, isStr := value.(string)
	if !isStr {
		return nil
	}
	ms, ok := parseDateJS(s)
	if !ok {
		return nil
	}
	t := float64(ms)
	now := float64(nowMs())
	if t > 0 && t <= now+60000 && t >= now-c.staleFallbackTtlMs {
		return t
	}
	return nil
}

func (c *SiriClient) isCircuitOpen() bool { return float64(nowMs()) < c.circuitOpenUntil }

func (c *SiriClient) recordSuccess(kind string) {
	c.consecutiveFailures = 0
	c.circuitOpenUntil = 0
	c.lastError = nil
	if kind == "arrivals" {
		c.lastArrivalsSuccessAt = float64(nowMs())
	} else {
		c.lastVehicleSuccessAt = float64(nowMs())
	}
}

func (c *SiriClient) getUpstreamStatus() *Obj {
	now := float64(nowMs())
	var until any
	if c.isCircuitOpen() {
		until = c.circuitOpenUntil
	}
	return O(
		"timestamp", now,
		"circuitOpen", c.isCircuitOpen(),
		"circuitOpenUntil", until,
		"consecutiveFailures", c.consecutiveFailures,
		"cooldownMs", c.circuitCooldownMs,
		"lastVehicleSuccessAt", c.lastVehicleSuccessAt,
		"lastArrivalsSuccessAt", c.lastArrivalsSuccessAt,
		"lastFailureAt", c.lastFailureAt,
		"lastError", c.lastError,
		"vehicleDeliveryStatus", c.vehicleDeliveryStatus,
		"rejectedFixes", c.rejectedFixes,
	)
}

func (c *SiriClient) recordFailure(errMsg string) {
	c.consecutiveFailures++
	c.lastFailureAt = float64(nowMs())
	now := float64(nowMs())
	if c.consecutiveFailures >= 2 {
		c.circuitOpenUntil = now + c.circuitCooldownMs
		if now-c.lastWarnTime > 60000 {
			if errMsg == "" {
				errMsg = "upstream unavailable"
			}
			log.Printf("[SIRI] Circuit breaker tripped (%s). Pausing SOAP calls for 30s to serve instant cache / dead-reckoning in 0ms.", errMsg)
			c.lastWarnTime = now
		}
	}
}

var errSiriTimeout = errors.New("SIRI request timeout")

// nodeErrMessage gives a Go network error the wording Node would use for
// a transport failure (getaddrinfo / connect / read codes, never the URL).
func nodeErrMessage(err error) string {
	var ne net.Error
	var dns *net.DNSError
	switch {
	case errors.Is(err, errSiriTimeout):
		return err.Error()
	case errors.As(err, &dns):
		// Node resolves through getaddrinfo: a missing name is ENOTFOUND,
		// anything else (no server, SERVFAIL) is EAI_AGAIN.
		if dns.IsNotFound {
			return "getaddrinfo ENOTFOUND " + dns.Name
		}
		return "getaddrinfo EAI_AGAIN " + dns.Name
	case errors.As(err, &ne) && ne.Timeout():
		return "SIRI request timeout"
	case errors.Is(err, syscall.ECONNRESET):
		return "read ECONNRESET"
	}
	for _, c := range []struct {
		errno syscall.Errno
		code  string
	}{{syscall.ECONNREFUSED, "ECONNREFUSED"}, {syscall.ENETUNREACH, "ENETUNREACH"}, {syscall.EHOSTUNREACH, "EHOSTUNREACH"}, {syscall.ETIMEDOUT, "ETIMEDOUT"}} {
		if errors.Is(err, c.errno) {
			msg := "connect " + c.code
			var op *net.OpError
			if errors.As(err, &op) && op.Addr != nil {
				msg += " " + op.Addr.String()
			}
			return msg
		}
	}
	// Without the url.Error wrapper: Node's message never names the URL.
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err.Error()
	}
	return err.Error()
}

// callSoap posts one envelope the way https.request does (3.5 s idle timeout).
// It runs with the world unlocked.
func (c *SiriClient) callSoap(action, soapXML string) (int, string, error) {
	if c.soap != nil {
		return c.soap(action, soapXML)
	}
	req, err := http.NewRequest("POST", "https://"+c.hostname+c.path, strings.NewReader(soapXML))
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Content-Type", "text/xml; charset=utf-8")
	req.Header.Set("SOAPAction", "http://tempuri.org/"+action)
	req.Header.Set("User-Agent", "MataroBus/2.4.0 (Android; com.geoactio.matarobus)")
	req.ContentLength = int64(len(soapXML))
	resp, err := nodeRequestClient(c.hostname, srcDataDir(), 3500*time.Millisecond).Do(req)
	if err != nil {
		return 0, "", errors.New(nodeErrMessage(err))
	}
	defer resp.Body.Close()
	body, err := readBoundedBody(resp.Body, defaultMaxBodyBytes)
	if err != nil {
		return 0, "", errors.New(nodeErrMessage(err))
	}
	return resp.StatusCode, body, nil
}

type siriClass struct {
	ok         bool
	err        string
	statusFlag any
}

var (
	reSiriFault       = jsRe(`(?i)<(?:[\w.-]+:)?Fault(?:[\s>])`)
	reSiriItems       = jsRe(`(?i)<(?:[\w.-]+:)?(?:MonitoredStopVisit|VehicleActivity)(?:[\s>])`)
	reSiriEmptyAns1   = jsRe(`(?i)<(?:[\w.-]+:)?Answer\b[^>]*/>`)
	reSiriEmptyAns2   = jsRe(`(?i)<(?:[\w.-]+:)?Answer\b[^>]*>\s*</(?:[\w.-]+:)?Answer>`)
	reSiriErrCond     = jsRe(`(?i)<(?:[\w.-]+:)?ErrorCondition(?:[\s>])([\s\S]*?)</(?:[\w.-]+:)?ErrorCondition>`)
	reSiriAuth        = regexp.MustCompile(`(?i)invalid user|password|unauthori[sz]ed|credential`)
	reSiriActivity    = jsRe(`(?i)<(?:[\w.-]+:)?VehicleActivity(?:[\s>])([\s\S]*?)</(?:[\w.-]+:)?VehicleActivity>`)
	reSiriVisit       = jsRe(`(?i)<(?:[\w.-]+:)?MonitoredStopVisit(?:[\s>])([\s\S]*?)</(?:[\w.-]+:)?MonitoredStopVisit>`)
	reSiriDuration    = regexp.MustCompile(`PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?`)
	reSiriHexRef      = regexp.MustCompile(`&#x([0-9a-fA-F]+);`)
	reSiriDecRef      = regexp.MustCompile(`&#(\d+);`)
	reSiriUnsafeRef   = regexp.MustCompile(`[^A-Za-z0-9_.\-]`)
	siriTagMu         sync.Mutex
	siriTagRes        = map[string]*regexp.Regexp{}
	siriDeliveryMu    sync.Mutex
	siriDeliveryRegex = map[string]*regexp.Regexp{}
)

func (c *SiriClient) classifyDelivery(status int, xml, deliveryTag string) siriClass {
	if status != 200 {
		return siriClass{err: "http_" + numToString(float64(status))}
	}
	if xml == "" {
		return siriClass{err: "malformed"}
	}
	trimmed := jsTrim(xml)
	if trimmed == "" {
		return siriClass{err: "malformed"}
	}
	if reTestI(reSiriFault, trimmed) {
		return siriClass{err: "soap_fault"}
	}
	siriDeliveryMu.Lock()
	dre := siriDeliveryRegex[deliveryTag]
	if dre == nil {
		dre = jsRe(`(?i)<(?:[\w.-]+:)?` + deliveryTag + `(?:[\s>])`)
		siriDeliveryRegex[deliveryTag] = dre
	}
	siriDeliveryMu.Unlock()
	hasDelivery := reTestI(dre, trimmed)
	hasItems := reTestI(reSiriItems, trimmed)
	emptyAnswer := reTestI(reSiriEmptyAns1, trimmed) || reTestI(reSiriEmptyAns2, trimmed)
	emptyTs, hasEmptyTs := c.extractTag(trimmed, "ResponseTimestamp")
	if !hasDelivery && !hasItems && emptyAnswer && hasEmptyTs && emptyTs != "" && !strings.HasPrefix(emptyTs, "0001-01-01") {
		return siriClass{ok: true}
	}
	if !hasDelivery && !hasItems {
		return siriClass{err: "malformed"}
	}
	if m := reFind(reSiriErrCond, trimmed, true); m != nil {
		desc, _ := c.extractTag(m.g(1), "Description")
		if reTestI(reSiriAuth, desc) {
			return siriClass{err: "auth"}
		}
		return siriClass{err: "upstream_error"}
	}
	if respTs, ok := c.extractTag(trimmed, "ResponseTimestamp"); ok && respTs != "" && strings.HasPrefix(respTs, "0001-01-01") {
		return siriClass{err: "upstream_error"}
	}
	var flag any
	if st, ok := c.extractTag(trimmed, "Status"); ok {
		switch jsLower(st) {
		case "true":
			flag = true
		case "false":
			flag = false
		}
	}
	return siriClass{ok: true, statusFlag: flag}
}

// parseDurationMinutes reads "PT2M", "-PT5M", "PT30S"; NaN when unknown.
func (c *SiriClient) parseDurationMinutes(dur string) float64 {
	if dur == "" {
		return math.NaN()
	}
	sign := 1.0
	str := dur
	if strings.HasPrefix(str, "-") {
		sign = -1
		str = str[1:]
	}
	m := reSiriDuration.FindStringSubmatch(str)
	if m == nil {
		return math.NaN()
	}
	part := func(s string) float64 {
		if s == "" {
			s = "0"
		}
		return parseIntJS(s)
	}
	return sign * jsRound(part(m[1])*60+part(m[2])+part(m[3])/60)
}

// extractTag returns the decoded, trimmed content of the first <tag>, and
// false where the source returns null.
func (c *SiriClient) extractTag(xml, tag string) (string, bool) {
	siriTagMu.Lock()
	re := siriTagRes[tag]
	if re == nil {
		re = jsRe(`(?i)<(?:[\w.-]+:)?` + tag + `(?:\s[^>]*)?>([\s\S]*?)</(?:[\w.-]+:)?` + tag + `>`)
		siriTagRes[tag] = re
	}
	siriTagMu.Unlock()
	m := reFind(re, xml, true)
	if m == nil {
		return "", false
	}
	return decodeXMLEntities(jsTrim(m.g(1))), true
}

// tagS is extractTag(...) || ” (null and "" both read as "").
func tagS(v string, _ bool) string { return v }

func decodeXMLEntities(s string) string {
	from := func(code float64, raw string) string {
		if code <= 0x10FFFF {
			return string(rune(int(code)))
		}
		return raw
	}
	s = reSiriHexRef.ReplaceAllStringFunc(s, func(raw string) string {
		return from(parseIntRadix16(raw[3:len(raw)-1]), raw)
	})
	s = reSiriDecRef.ReplaceAllStringFunc(s, func(raw string) string {
		return from(parseIntJS(raw[2:len(raw)-1]), raw)
	})
	s = strings.ReplaceAll(s, "&lt;", "<")
	s = strings.ReplaceAll(s, "&gt;", ">")
	s = strings.ReplaceAll(s, "&quot;", `"`)
	s = strings.ReplaceAll(s, "&apos;", "'")
	return strings.ReplaceAll(s, "&amp;", "&")
}

// parseIntRadix16 is parseInt(h, 16) for a string of hex digits.
func parseIntRadix16(h string) float64 {
	v := 0.0
	for i := 0; i < len(h); i++ {
		d := h[i]
		var n byte
		switch {
		case d >= '0' && d <= '9':
			n = d - '0'
		case d >= 'a' && d <= 'f':
			n = d - 'a' + 10
		default:
			n = d - 'A' + 10
		}
		v = v*16 + float64(n)
	}
	return v
}

func xmlEscape(v string) string {
	v = strings.ReplaceAll(v, "&", "&amp;")
	v = strings.ReplaceAll(v, "<", "&lt;")
	v = strings.ReplaceAll(v, ">", "&gt;")
	v = strings.ReplaceAll(v, `"`, "&quot;")
	return strings.ReplaceAll(v, "'", "&apos;")
}

func assertSafeRef(v, name string) error {
	if v != "" && reSiriUnsafeRef.MatchString(v) {
		return fmt.Errorf("[SIRI] Invalid characters in %s: %s", name, jsSlice(v, 0, 40))
	}
	return nil
}

// coalesce runs fn once per key while it is pending; joiners wait for the
// same array. fn runs with the world locked and may await.
func (c *SiriClient) coalesce(key string, fn func() *[]any) *[]any {
	if f := c.inflight[key]; f != nil {
		c.w.await(func() { <-f.done })
		return f.val
	}
	f := &siriFlight{done: make(chan struct{})}
	c.inflight[key] = f
	defer func() {
		if c.inflight[key] == f {
			delete(c.inflight, key)
		}
		close(f.done)
	}()
	f.val = fn()
	return f.val
}

func (c *SiriClient) staleVehicles(cached *siriCacheEntry) *[]any {
	out := make([]any, 0, len(*cached.data))
	for _, x := range *cached.data {
		v := asObj(x).Clone()
		v.Set("isEstimated", true)
		v.Set("isRealTime", false)
		v.Set("delayBadgeText", "⚡ En ruta (Estimat)")
		v.Set("statusText", "⚡ Estimació per pèrdua temporal de senyal")
		out = append(out, v)
	}
	return &out
}

func (c *SiriClient) staleArrivals(cached *siriCacheEntry) *[]any {
	out := make([]any, 0, len(*cached.data))
	for _, x := range *cached.data {
		a := asObj(x)
		v := a.Clone()
		fr := O()
		if f, ok := a.Get("freshness").(*Obj); ok {
			fr = f.Clone()
		}
		fr.Set("fallback", true)
		v.Set("freshness", fr)
		v.Set("isEstimated", true)
		v.Set("isRealTime", false)
		v.Set("delayBadgeText", "⚡ En ruta (Estimat)")
		out = append(out, v)
	}
	return &out
}

func emptyArr() *[]any { a := []any{}; return &a }

func (c *SiriClient) redact(msg string) string {
	if c.accountKey == "" {
		return msg
	}
	return strings.ReplaceAll(msg, c.accountKey, "[REDACTED]")
}

func (c *SiriClient) noteError(err error) {
	if c.lastError == nil {
		if strings.HasPrefix(err.Error(), "SIRI ") {
			c.lastError = err.Error()[5:]
		} else {
			c.lastError = "network_error"
		}
	}
}

func (c *SiriClient) logTransport(call string, ref string, msg string) {
	safe := c.redact(msg)
	now := float64(nowMs())
	if strings.Contains(safe, "timeout") || strings.Contains(safe, "ECONNRESET") || strings.Contains(safe, "ECONNREFUSED") {
		if now-c.lastWarnTime > 60000 {
			log.Printf("[SIRI] Avanza SIRI server transient issue (%s). Using live cache & dead-reckoning fallback.", safe)
			c.lastWarnTime = now
		}
	} else {
		log.Printf("[SIRI Error] %s(%s): %s", call, ref, safe)
	}
}

// soapRoundTrip runs callSoap with the world unlocked.
func (c *SiriClient) soapRoundTrip(action, envelope string) (int, string, error) {
	var status int
	var body string
	var err error
	c.w.await(func() { status, body, err = c.callSoap(action, envelope) })
	return status, body, err
}

// getLiveVehicles is the line's vehicle list (lineRef "" = all lines).
func (c *SiriClient) getLiveVehicles(lineRef string) (*[]any, error) {
	if err := assertSafeRef(lineRef, "lineRef"); err != nil {
		return nil, err
	}
	key := "veh_" + lineRef
	cached := c.cache[key]
	now := float64(nowMs())
	if cached != nil && now-cached.ts < c.cacheTtlMs {
		return cached.data, nil
	}
	if f := c.inflight[key]; f != nil {
		c.w.await(func() { <-f.done })
		return f.val, nil
	}
	if c.isCircuitOpen() {
		if cached != nil && now-cached.ts < c.staleFallbackTtlMs {
			return c.staleVehicles(cached), nil
		}
		return emptyArr(), nil
	}
	if c.rpc != nil {
		return c.coalesce(key, func() *[]any {
			var res any
			var err error
			rpc := c.rpc
			c.w.await(func() { res, err = rpc("getMataroLiveVehicles", O("lineRef", lineRef)) })
			if err != nil {
				c.recordFailure(err.Error())
			} else if arr, ok := res.([]any); ok {
				c.recordSuccess("vehicles")
				p := &arr
				c.setCache(key, &siriCacheEntry{ts: float64(nowMs()), data: p})
				return p
			}
			if cached != nil && now-cached.ts < c.staleFallbackTtlMs {
				return c.staleVehicles(cached)
			}
			return emptyArr()
		}), nil
	}
	return c.coalesce(key, func() *[]any {
		ts := isoString(nowMs())
		envelope := `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/" xmlns:siri="http://www.siri.org.uk/siri">
  <soapenv:Header/>
  <soapenv:Body>
    <tem:GetVehicleMonitoring>
      <tem:request>
        <ServiceRequestInfo>
          <siri:RequestTimestamp>` + ts + `</siri:RequestTimestamp>
          <siri:AccountId>` + xmlEscape(c.accountID) + `</siri:AccountId>
          <siri:AccountKey>` + xmlEscape(c.accountKey) + `</siri:AccountKey>
        </ServiceRequestInfo>
        <Request version="2.0">
          <siri:RequestTimestamp>` + ts + `</siri:RequestTimestamp>
          <siri:VehicleMonitoringRef></siri:VehicleMonitoringRef>
          <siri:LineRef>` + xmlEscape(lineRef) + `</siri:LineRef>
        </Request>
      </tem:request>
    </tem:GetVehicleMonitoring>
  </soapenv:Body>
</soapenv:Envelope>`
		vehicles, err := c.parseVehicles(lineRef, ts, envelope)
		if err != nil {
			c.noteError(err)
			c.recordFailure(err.Error())
			c.logTransport("GetVehicleMonitoring", lineRef, err.Error())
			if cached != nil && float64(nowMs())-cached.ts < c.staleFallbackTtlMs {
				return c.staleVehicles(cached)
			}
			return emptyArr()
		}
		c.recordSuccess("vehicles")
		p := &vehicles
		c.setCache(key, &siriCacheEntry{ts: float64(nowMs()), data: p})
		return p
	}), nil
}

func (c *SiriClient) parseVehicles(lineRef, ts, envelope string) ([]any, error) {
	status, body, err := c.soapRoundTrip("GetVehicleMonitoring", envelope)
	if err != nil {
		return nil, err
	}
	cls := c.classifyDelivery(status, body, "VehicleMonitoringDelivery")
	if !cls.ok {
		c.lastError = cls.err
		return nil, errors.New("SIRI " + cls.err)
	}
	c.vehicleDeliveryStatus = cls.statusFlag
	c.lastError = nil

	vehicles := []any{}
	for _, am := range reFindAll(reSiriActivity, body, true) {
		item := am.g(1)
		latRaw, hasLat := c.extractTag(item, "Latitude")
		lonRaw, hasLon := c.extractTag(item, "Longitude")
		lat, lon := math.NaN(), math.NaN()
		if hasLat {
			lat = parseFloatJS(latRaw)
		}
		if hasLon {
			lon = parseFloatJS(lonRaw)
		}
		valid := c.isValidMataroCoord(lat, lon)
		if !valid && (hasLat || hasLon) {
			c.rejectedFixes++
		}
		line := tagS(c.extractTag(item, "LineRef"))
		if line == "" {
			line = lineRef
		}
		lineName := tagS(c.extractTag(item, "PublishedLineName"))
		dirName := tagS(c.extractTag(item, "DirectionName"))
		origin := tagS(c.extractTag(item, "OriginName"))
		dest := tagS(c.extractTag(item, "DestinationName"))
		vehRef := tagS(c.extractTag(item, "VehicleRef"))
		if vehRef == "" {
			vehRef = "Bus"
		}
		bearingS := tagS(c.extractTag(item, "Bearing"))
		if bearingS == "" {
			bearingS = "0"
		}
		bearing := parseIntJS(bearingS)
		velRaw, hasVel := c.extractTag(item, "Velocity")
		velocity := math.NaN()
		if hasVel {
			velocity = parseFloatJS(velRaw)
		}
		hasSpeed := isFinite(velocity) && velocity >= 0
		var speedKmh any
		if hasSpeed {
			speedKmh = jsRound(velocity * 3.6)
		}
		delayRaw, hasDelayTag := c.extractTag(item, "Delay")
		delayMins := math.NaN()
		if hasDelayTag {
			delayMins = c.parseDurationMinutes(delayRaw)
		}
		hasDelay := isFinite(delayMins)
		recRaw, hasRec := c.extractTag(item, "RecordedAtTime")
		recordedAt := ts
		if hasRec && recRaw != "" {
			recordedAt = recRaw
		}
		var recArg any
		if hasRec {
			recArg = recRaw
		}
		observedAt := c.observationTimestamp(recArg)
		if !valid {
			continue
		}
		var delayV any
		var delayFmt string
		if hasDelay {
			delayV = delayMins
			switch {
			case delayMins > 0:
				delayFmt = "+" + numToString(delayMins) + " min retard"
			case delayMins < 0:
				delayFmt = numToString(delayMins) + " min avançat"
			default:
				delayFmt = "Puntual"
			}
		} else {
			delayFmt = "Sense dades de retard"
		}
		vehicles = append(vehicles, O(
			"vehicleId", vehRef,
			"lineId", line,
			"lineName", lineName,
			"directionName", dirName,
			"origin", origin,
			"destination", dest,
			"lat", jsRound(lat*1000000)/1000000,
			"lon", jsRound(lon*1000000)/1000000,
			"bearing", math.Mod(bearing+360, 360),
			"speedKmh", speedKmh,
			"hasSpeed", hasSpeed,
			"delayMins", delayV,
			"hasDelay", hasDelay,
			"delayFormatted", delayFmt,
			"recordedAt", recordedAt,
			"isEstimated", false,
			"freshness", O("source", "live", "fetchedAt", float64(nowMs()), "observedAt", observedAt),
			"timestamp", float64(nowMs()),
		))
	}
	return vehicles, nil
}

func (c *SiriClient) normalizeStopId(stopID string) string {
	if stopID == "" {
		return ""
	}
	s := jsTrim(stopID)
	n := parseIntJS(s)
	if !math.IsNaN(n) && n > 0 && n < 1000 {
		return numToString(1000 + n)
	}
	return s
}

// getStopArrivals is the stop's countdown list. bypassCache and direct are
// the source's options.
func (c *SiriClient) getStopArrivals(stopID, lineRef string) ([]any, error) {
	p, err := c.getStopArrivalsOpt(stopID, lineRef, false, false)
	if err != nil {
		return nil, err
	}
	return *p, nil
}

func (c *SiriClient) getStopArrivalsOpt(stopID, lineRef string, bypassCache, direct bool) (*[]any, error) {
	norm := c.normalizeStopId(stopID)
	if err := assertSafeRef(norm, "stopId"); err != nil {
		return nil, err
	}
	if err := assertSafeRef(lineRef, "lineRef"); err != nil {
		return nil, err
	}
	key := "stop_" + norm + "_" + lineRef
	cached := c.cache[key]
	now := float64(nowMs())
	if !bypassCache && cached != nil && now-cached.ts < c.cacheTtlMs {
		return cached.data, nil
	}
	if !bypassCache {
		if f := c.inflight[key]; f != nil {
			c.w.await(func() { <-f.done })
			return f.val, nil
		}
	}
	if c.isCircuitOpen() {
		if cached != nil && now-cached.ts < c.staleFallbackTtlMs {
			return c.staleArrivals(cached), nil
		}
		return emptyArr(), nil
	}
	if !direct && c.rpc != nil {
		return c.coalesce(key, func() *[]any {
			var res any
			var err error
			rpc := c.rpc
			c.w.await(func() {
				res, err = rpc("getMataroStopArrivals", O("stopId", norm, "lineRef", lineRef, "bypassCache", bypassCache))
			})
			if err != nil {
				c.noteError(err)
				c.recordFailure(err.Error())
			} else if arr, ok := res.([]any); ok {
				c.recordSuccess("arrivals")
				p := &arr
				c.setCache(key, &siriCacheEntry{ts: float64(nowMs()), data: p})
				return p
			}
			if cached != nil && now-cached.ts < c.staleFallbackTtlMs {
				return c.staleArrivals(cached)
			}
			return emptyArr()
		}), nil
	}
	return c.coalesce(key, func() *[]any {
		ts := isoString(nowMs())
		envelope := `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <soap:Body>
    <GetStopMonitoring xmlns="http://tempuri.org/">
      <request>
        <ServiceRequestInfo xmlns="">
          <RequestTimestamp xmlns="http://www.siri.org.uk/siri">` + ts + `</RequestTimestamp>
          <AccountId xmlns="http://www.siri.org.uk/siri">` + xmlEscape(c.accountID) + `</AccountId>
          <AccountKey xmlns="http://www.siri.org.uk/siri">` + xmlEscape(c.accountKey) + `</AccountKey>
        </ServiceRequestInfo>
        <Request xmlns="">
          <RequestTimestamp xmlns="http://www.siri.org.uk/siri">` + ts + `</RequestTimestamp>
          <MonitoringRef xmlns="http://www.siri.org.uk/siri">` + xmlEscape(norm) + `</MonitoringRef>
          <LineRef xmlns="http://www.siri.org.uk/siri">` + xmlEscape(lineRef) + `</LineRef>
        </Request>
      </request>
    </GetStopMonitoring>
  </soap:Body>
</soap:Envelope>`
		arrivals, err := c.parseArrivals(envelope)
		if err != nil {
			c.noteError(err)
			c.recordFailure(err.Error())
			c.logTransport("GetStopMonitoring", stopID, err.Error())
			if cached != nil && float64(nowMs())-cached.ts < c.staleFallbackTtlMs {
				return c.staleArrivals(cached)
			}
			return emptyArr()
		}
		c.recordSuccess("arrivals")
		p := &arrivals
		c.setCache(key, &siriCacheEntry{ts: float64(nowMs()), data: p})
		return p
	}), nil
}

func (c *SiriClient) parseArrivals(envelope string) ([]any, error) {
	status, body, err := c.soapRoundTrip("GetStopMonitoring", envelope)
	if err != nil {
		return nil, err
	}
	cls := c.classifyDelivery(status, body, "StopMonitoringDelivery")
	if !cls.ok {
		c.lastError = cls.err
		return nil, errors.New("SIRI " + cls.err)
	}
	c.lastError = nil

	var arrivals []*Obj
	for _, vm := range reFindAll(reSiriVisit, body, true) {
		item := vm.g(1)
		line := tagS(c.extractTag(item, "LineRef"))
		lineName := tagS(c.extractTag(item, "PublishedLineName"))
		dirName := tagS(c.extractTag(item, "DirectionName"))
		dest := tagS(c.extractTag(item, "DestinationName"))
		vehRef := tagS(c.extractTag(item, "VehicleRef"))
		dist := tagS(c.extractTag(item, "DistanceFromStop"))
		expectedArr := tagS(c.extractTag(item, "ExpectedArrivalTime"))
		hasExpected := expectedArr != ""
		aimedArr := tagS(c.extractTag(item, "AimedArrivalTime"))
		if aimedArr == "" {
			aimedArr = expectedArr
		}

		var delayMins any
		if hasExpected && aimedArr != "" && expectedArr != "" {
			exp, ok1 := parseDateJS(expectedArr)
			aim, ok2 := parseDateJS(aimedArr)
			if ok1 && ok2 {
				delayMins = jsRound(float64(exp-aim) / 60000)
			}
		} else if raw, ok := c.extractTag(item, "Delay"); ok {
			if p := c.parseDurationMinutes(raw); isFinite(p) {
				delayMins = p
			}
		}
		var badge, dstatus string
		switch d, _ := delayMins.(float64); {
		case delayMins == nil:
			badge, dstatus = "Horari previst", "scheduled"
		case d >= 2:
			badge, dstatus = "+"+numToString(d)+" min retard", "delayed"
		case d <= -1:
			badge, dstatus = numToString(math.Abs(d))+" min avançat", "early"
		default:
			badge, dstatus = "Puntual", "on-time"
		}

		latRaw, hasLat := c.extractTag(item, "Latitude")
		lonRaw, hasLon := c.extractTag(item, "Longitude")
		lat, lon := math.NaN(), math.NaN()
		if hasLat {
			lat = parseFloatJS(latRaw)
		}
		if hasLon {
			lon = parseFloatJS(lonRaw)
		}
		var busCoords any
		if c.isValidMataroCoord(lat, lon) {
			busCoords = O("lat", jsRound(lat*1000000)/1000000, "lon", jsRound(lon*1000000)/1000000)
		} else if hasLat || hasLon {
			c.rejectedFixes++
		}

		minutesAway := 0.0
		formatted := "--:--"
		valid := false
		ref := expectedArr
		if ref == "" {
			ref = aimedArr
		}
		if ref != "" {
			arrMs, ok := parseDateJS(ref)
			if ok && float64(arrMs) >= float64(nowMs())-3600000 {
				diffMin := jsRound(float64(arrMs-nowMs()) / 60000)
				if diffMin >= -2 {
					minutesAway = math.Max(0, diffMin)
					formatted = formatTimeToTimezone(arrMs, true)
					if formatted != "--:--" {
						valid = true
					}
				}
			}
		}
		if !valid {
			continue
		}
		recRaw, hasRec := c.extractTag(item, "RecordedAtTime")
		var recArg any
		if hasRec {
			recArg = recRaw
		}
		source := "timetable"
		if hasExpected {
			source = "live"
		}
		arrivals = append(arrivals, O(
			"lineId", line,
			"lineName", lineName,
			"directionName", dirName,
			"destination", dest,
			"vehicleId", vehRef,
			"distanceFromStop", dist,
			"departureTime", formatted,
			"freshness", O("source", source, "fetchedAt", float64(nowMs()), "observedAt", c.observationTimestamp(recArg)),
			"expectedIso", expectedArr,
			"aimedIso", aimedArr,
			"minutesAway", minutesAway,
			"formattedStatus", formattedMinutes(minutesAway),
			"delayMins", delayMins,
			"delayBadgeText", badge,
			"delayStatus", dstatus,
			"isRealTime", hasExpected,
			"busCoords", busCoords,
		))
	}
	sort.SliceStable(arrivals, func(i, j int) bool { return arrivals[i].Num("minutesAway") < arrivals[j].Num("minutesAway") })
	out := make([]any, len(arrivals))
	for i, a := range arrivals {
		out[i] = a
	}
	return out, nil
}

// nodeUTF8 decodes bytes like Buffer#toString('utf8') (WHATWG: one U+FFFD
// per maximal invalid subsequence).
func nodeUTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	sb.Grow(len(b) + 8)
	needed, seen := 0, 0
	cp := rune(0)
	lower, upper := byte(0x80), byte(0xBF)
	for i := 0; i < len(b); {
		c := b[i]
		if needed == 0 {
			switch {
			case c <= 0x7F:
				sb.WriteByte(c)
			case c >= 0xC2 && c <= 0xDF:
				needed, cp = 1, rune(c&0x1F)
			case c >= 0xE0 && c <= 0xEF:
				if c == 0xE0 {
					lower = 0xA0
				} else if c == 0xED {
					upper = 0x9F
				}
				needed, cp = 2, rune(c&0xF)
			case c >= 0xF0 && c <= 0xF4:
				if c == 0xF0 {
					lower = 0x90
				} else if c == 0xF4 {
					upper = 0x8F
				}
				needed, cp = 3, rune(c&0x7)
			default:
				sb.WriteRune(utf8.RuneError)
			}
			i++
			continue
		}
		if c < lower || c > upper {
			needed, seen, cp = 0, 0, 0
			lower, upper = 0x80, 0xBF
			sb.WriteRune(utf8.RuneError)
			continue // reprocess this byte
		}
		lower, upper = 0x80, 0xBF
		cp = cp<<6 | rune(c&0x3F)
		seen++
		i++
		if seen == needed {
			sb.WriteRune(cp)
			needed, seen, cp = 0, 0, 0
		}
	}
	if needed != 0 {
		sb.WriteRune(utf8.RuneError)
	}
	return sb.String()
}

package main

// Ports of src/core/httpProtection.js, src/core/serviceStatus.js,
// src/core/http/boundedBody.js and src/core/http/verifiedTls.js.

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// ---------------------------------------------------------------- headers

var cspHeader = strings.Join([]string{
	"default-src 'self'",
	"script-src 'self' https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
	"script-src-attr 'none'",
	"style-src 'self' 'unsafe-inline' https://unpkg.com/leaflet@1.9.4/dist/leaflet.css https://fonts.googleapis.com",
	"font-src 'self' https://fonts.gstatic.com",
	"img-src 'self' data: blob: https://*.basemaps.cartocdn.com https://unpkg.com/leaflet@1.9.4/dist/images/",
	"connect-src 'self'",
	"worker-src 'self'",
	"media-src 'self' blob: data:",
	"object-src 'none'",
	"base-uri 'self'",
	"frame-ancestors 'none'",
	"form-action 'self'",
}, "; ")

func setSecurityHeaders(h http.Header) {
	h.Set("Content-Security-Policy", cspHeader)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
	h.Set("X-Frame-Options", "DENY")
}

// ---------------------------------------------------------------- trusted proxies

var reDigitsOnly = regexp.MustCompile(`^\d+$`)

// parseTrustedProxies is trustedProxies(): IP addresses or CIDRs, comma separated.
func parseTrustedProxies(value string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, part := range strings.Split(value, ",") {
		entry := jsTrim(part)
		if entry == "" {
			continue
		}
		fields := strings.Split(entry, "/")
		addr, err := netip.ParseAddr(fields[0])
		if err != nil || addr.Zone() != "" || len(fields) > 2 {
			return nil, errors.New("TRUSTED_PROXIES must contain IP addresses or CIDRs")
		}
		bits := addr.BitLen()
		if len(fields) == 2 {
			n, err := strconv.Atoi(fields[1])
			if !reDigitsOnly.MatchString(fields[1]) || err != nil || n > bits {
				return nil, errors.New("TRUSTED_PROXIES must contain IP addresses or CIDRs")
			}
			bits = n
		}
		p, err := addr.Prefix(bits)
		if err != nil {
			return nil, errors.New("TRUSTED_PROXIES must contain IP addresses or CIDRs")
		}
		out = append(out, p)
	}
	return out, nil
}

func trustedAddr(trust []netip.Prefix, a netip.Addr) bool {
	for _, p := range trust {
		if p.Contains(a) {
			return true
		}
		// proxy-addr also matches IPv4-mapped IPv6 against IPv4 ranges.
		if a.Is4In6() && p.Addr().Is4() && p.Contains(a.Unmap()) {
			return true
		}
	}
	return false
}

// requestIP is Express req.ip: the socket address, or with a trust list the
// first untrusted address walking X-Forwarded-For from the right.
func requestIP(r *http.Request, trust []netip.Prefix) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if len(trust) == 0 {
		return host
	}
	addrs := []string{host}
	if xff := r.Header.Values("X-Forwarded-For"); len(xff) > 0 {
		parts := strings.Split(strings.Join(xff, ","), ",")
		for i := len(parts) - 1; i >= 0; i-- {
			if p := strings.TrimSpace(parts[i]); p != "" {
				addrs = append(addrs, p)
			}
		}
	}
	for i := 0; i < len(addrs)-1; i++ {
		a, err := netip.ParseAddr(addrs[i])
		if err != nil || !trustedAddr(trust, a) {
			return addrs[i]
		}
	}
	return addrs[len(addrs)-1]
}

// clientKey folds IPv4-mapped IPv6 to IPv4 and groups IPv6 clients by /64
// prefix so a single IPv6 allocation cannot exhaust the rate-limiter table.
func clientKey(ip string) string {
	key := ip
	if key == "" {
		return "unknown"
	}
	if a, err := netip.ParseAddr(key); err == nil {
		a = a.WithZone("").Unmap()
		if a.Is4() {
			return a.String()
		}
		if a.Is6() {
			p := netip.PrefixFrom(a, 64).Masked()
			return "[" + p.Addr().String() + "/64]"
		}
	}
	return key
}

// ---------------------------------------------------------------- rate limiter

type limiterState struct {
	until                    float64
	total, analytics, mapped int
}

type apiLimiter struct {
	mu             sync.Mutex
	windowMs       float64
	limit          int
	analyticsLimit int
	mapLimit       int
	maxClients     int
	clients        map[string]*limiterState
	order          []string // insertion order, for the sweep
	lastSweep      float64
}

func envNumberOr(name string, def float64) float64 {
	n := stringToNumber(os.Getenv(name))
	if os.Getenv(name) == "" || math.IsNaN(n) || n == 0 {
		return def
	}
	return n
}

func newAPILimiter() *apiLimiter {
	analyticsDefault := 12.0
	if os.Getenv("BENCHMARK_MODE") == "true" {
		analyticsDefault = 120
	}
	return &apiLimiter{
		windowMs:       60000,
		limit:          120,
		analyticsLimit: int(envNumberOr("RATE_LIMIT_ANALYTICS_MAX", analyticsDefault)),
		mapLimit:       int(envNumberOr("RATE_LIMIT_MAP_MAX", 60)),
		maxClients:     10000,
		clients:        map[string]*limiterState{},
	}
}

var (
	reHealthPath    = regexp.MustCompile(`(?i)^/(api/)?health/?$`)
	reMapPath       = regexp.MustCompile(`(?i)^/(api/)?analytics/gps-gaps(/|$)`)
	reAnalyticsPath = regexp.MustCompile(`(?i)^/(api/)?(analytics|retards)(/|$)`)
)

// allow returns 0 when the request may proceed, else the Retry-After seconds.
func (l *apiLimiter) allow(method, pathname, key string) int {
	if (method != "GET" && method != "HEAD") || reHealthPath.MatchString(pathname) {
		return 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := float64(nowMs())
	if now-l.lastSweep >= l.windowMs || (len(l.clients) >= l.maxClients && now-l.lastSweep >= 1000) {
		kept := l.order[:0]
		for _, k := range l.order {
			if st, ok := l.clients[k]; ok && st.until <= now {
				delete(l.clients, k)
				continue
			}
			if _, ok := l.clients[k]; ok {
				kept = append(kept, k)
			}
		}
		l.order = kept
		l.lastSweep = now
	}
	retry := func(until float64) int {
		return int(math.Max(1, math.Ceil((until-now)/1000)))
	}
	st := l.clients[key]
	if st == nil || st.until <= now {
		if st == nil && len(l.clients) >= l.maxClients {
			// Evict the oldest tracked client rather than locking out all new users.
			for len(l.order) > 0 && len(l.clients) >= l.maxClients {
				oldest := l.order[0]
				l.order = l.order[1:]
				delete(l.clients, oldest)
			}
		}
		if st == nil {
			l.order = append(l.order, key)
		}
		st = &limiterState{until: now + l.windowMs}
		l.clients[key] = st
	}
	isMap := reMapPath.MatchString(pathname)
	isAnalytics := !isMap && reAnalyticsPath.MatchString(pathname)
	if st.total >= l.limit || (isAnalytics && st.analytics >= l.analyticsLimit) || (isMap && st.mapped >= l.mapLimit) {
		return retry(st.until)
	}
	st.total++
	if isAnalytics {
		st.analytics++
	}
	if isMap {
		st.mapped++
	}
	return 0
}

// ---------------------------------------------------------------- serviceStatus

func serviceStatus(worker *Obj, reports any, catalogReady, shuttingDown bool, now float64) *Obj {
	age := func(v any) any {
		f, ok := toF(v)
		if ok && isFinite(f) && f > 0 && f <= now {
			return now - f
		}
		return nil
	}
	metrics := worker.ObjAt("metrics")
	upstream := metrics.ObjAt("upstream")
	fleetAge := age(upstream.Get("lastVehicleSuccessAt"))
	noticeAge := age(metrics.Get("noticesUpdatedAt"))
	canary := metrics.ObjAt("upstreamCanary")
	var canaryAge any = nil
	if canary != nil && truthy(canary.Get("checkedAt")) {
		canaryAge = age(canary.Get("checkedAt"))
	}
	canaryFailed := canary != nil && !truthy(canary.Get("ok")) && canaryAge != nil && canaryAge.(float64) < 15*60*1000
	fleetAnomaly := or(metrics.Get("fleetAnomaly"), nil)
	if isUndef(fleetAnomaly) {
		fleetAnomaly = nil
	}
	ready := catalogReady && truthy(worker.Get("isHealthy")) && truthy(worker.Get("isRunning")) && !shuttingDown
	degraded := fleetAge == nil || fleetAge.(float64) > 60000 || canaryFailed || truthy(fleetAnomaly)
	status := "ready"
	switch {
	case shuttingDown:
		status = "stopping"
	case !ready:
		status = "starting"
	case degraded:
		status = "degraded"
	}
	var canaryOk, canaryErr, canaryAt any = nil, nil, nil
	if canary != nil {
		canaryOk = truthy(canary.Get("ok"))
		canaryErr = or(canary.Get("error"), nil)
		canaryAt = or(canary.Get("checkedAt"), nil)
	}
	return O(
		"ready", ready,
		"status", status,
		"fleet", O(
			"fetchAgeMs", fleetAge,
			"observationAgeMs", age(metrics.Get("lastObservationAt")),
			"fresh", fleetAge != nil && fleetAge.(float64) <= 60000,
			"anomaly", fleetAnomaly,
		),
		"arrivals", O("fetchAgeMs", age(upstream.Get("lastArrivalsSuccessAt"))),
		"notices", O("ageMs", noticeAge, "fresh", noticeAge != nil && noticeAge.(float64) <= 600000),
		"upstream", O("canaryOk", canaryOk, "canaryError", canaryErr, "canaryCheckedAt", canaryAt),
		"reports", reports,
	)
}

// ---------------------------------------------------------------- bounded body

const defaultMaxBodyBytes = 4 * 1024 * 1024

// readBoundedBody reads at most maxBytes; a larger body is an error.
func readBoundedBody(r io.Reader, maxBytes int64) (string, error) {
	b, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return "", err
	}
	if int64(len(b)) > maxBytes {
		return "", fmt.Errorf("upstream response larger than %d bytes", maxBytes)
	}
	return nodeUTF8(b), nil
}

// ---------------------------------------------------------------- outbound TLS

var chainRepairHosts = map[string]bool{"mataro.avanzagrupo.com": true}

var (
	repairOnce   sync.Once
	repairClient *http.Client
	repairErr    error
)

// newTransport is a non-keep-alive transport (each poll opens a connection,
// like Node's default agent), verifying with the given roots (nil = system).
func newTransport(roots *x509.CertPool) *http.Transport {
	return &http.Transport{
		Proxy:               nil,
		DisableKeepAlives:   true,
		TLSHandshakeTimeout: 10 * time.Second,
		TLSClientConfig:     &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12},
		ForceAttemptHTTP2:   false,
	}
}

var defaultHTTPClient = &http.Client{Transport: newTransport(nil)}

// clientFor returns an HTTP client that trusts the system store plus, for the
// one portal that serves an incomplete chain, the vendored Sectigo CAs.
func clientFor(host, dataDir string) *http.Client {
	if !chainRepairHosts[strings.ToLower(host)] {
		return defaultHTTPClient
	}
	if dataDir == "" {
		dataDir = filepath.Join(appRoot, "src", "data")
	}
	repairOnce.Do(func() {
		pool, err := x509.SystemCertPool()
		if err != nil || pool == nil {
			pool = x509.NewCertPool()
		}
		for _, f := range []string{"sectigo-root-r46.pem", "sectigo-ov-r36-intermediate.pem"} {
			b, err := os.ReadFile(filepath.Join(dataDir, "certs", f))
			if err != nil {
				repairErr = err
				log.Printf("[TLS] Failed to read vendored CA %s: %v", f, err)
				return
			}
			if !pool.AppendCertsFromPEM(b) {
				repairErr = fmt.Errorf("bad PEM in %s", f)
				log.Printf("[TLS] Failed to parse vendored CA %s", f)
				return
			}
		}
		repairPool = pool
		repairClient = &http.Client{Transport: newTransport(pool)}
	})
	if repairClient == nil {
		return defaultHTTPClient
	}
	return repairClient
}

var repairPool *x509.CertPool

// idleConn applies Node's socket `timeout` option: the deadline moves forward
// on every read and write, so only an idle socket times out.
type idleConn struct {
	net.Conn
	idle time.Duration
}

func (c *idleConn) Read(b []byte) (int, error) {
	_ = c.Conn.SetDeadline(time.Now().Add(c.idle))
	return c.Conn.Read(b)
}

func (c *idleConn) Write(b []byte) (int, error) {
	_ = c.Conn.SetDeadline(time.Now().Add(c.idle))
	return c.Conn.Write(b)
}

// nodeRequestClient behaves like https.request/https.get with a `timeout`
// option: no redirects are followed, no Accept-Encoding is sent, and the
// timeout is an idle-socket timeout rather than a total deadline.
func nodeRequestClient(host, dataDir string, idle time.Duration) *http.Client {
	var roots *x509.CertPool
	if chainRepairHosts[strings.ToLower(host)] {
		clientFor(host, dataDir)
		roots = repairPool
	}
	dialer := &net.Dialer{Timeout: idle}
	tr := newTransport(roots)
	tr.DisableCompression = true
	tr.TLSHandshakeTimeout = 0
	tr.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		c, err := dialer.DialContext(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		return &idleConn{Conn: c, idle: idle}, nil
	}
	return &http.Client{
		Transport: tr,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// describeChainFailure turns a request failure into the log line Node writes.
// Node names a host only when the error object carries one: getaddrinfo
// errors (hostname) and certificate name mismatches (host); everything else
// is "the portal". A request timeout is req.destroy(), which Node reports as
// ECONNRESET ("socket hang up").
func describeChainFailure(err error) string {
	host := "the portal"
	code := "UNKNOWN"
	var dns *net.DNSError
	var hn x509.HostnameError
	var ua x509.UnknownAuthorityError
	var inv x509.CertificateInvalidError
	var ne net.Error
	switch {
	case errors.As(err, &dns):
		if dns.Name != "" {
			host = dns.Name
		}
		code = "EAI_AGAIN"
		if dns.IsNotFound {
			code = "ENOTFOUND"
		}
	case errors.As(err, &hn):
		if hn.Host != "" {
			host = hn.Host
		}
		code = "ERR_TLS_CERT_ALTNAME_INVALID"
	case errors.As(err, &ua):
		code = "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
	case errors.As(err, &inv) && inv.Reason == x509.Expired:
		code = "CERT_HAS_EXPIRED"
		if inv.Cert != nil && time.Now().Before(inv.Cert.NotBefore) {
			code = "CERT_NOT_YET_VALID"
		}
	case errors.As(err, &ne) && ne.Timeout(), errors.Is(err, context.DeadlineExceeded), errors.Is(err, syscall.ECONNRESET):
		code = "ECONNRESET"
	case errors.Is(err, syscall.ECONNREFUSED):
		code = "ECONNREFUSED"
	case errors.Is(err, syscall.ENETUNREACH):
		code = "ENETUNREACH"
	case errors.Is(err, syscall.EHOSTUNREACH):
		code = "EHOSTUNREACH"
	case errors.Is(err, syscall.ETIMEDOUT):
		code = "ETIMEDOUT"
	case errors.Is(err, syscall.EPIPE):
		code = "EPIPE"
	}
	switch code {
	case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
		return host + ": certificate is no longer issued by the vendored Sectigo root (" + code + "). The portal has likely rotated to a new CA — re-vendor the chain."
	case "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID":
		return host + ": certificate is outside its validity window (" + code + "). Check whether a vendored CA in src/data/certs/ has expired."
	}
	return host + ": TLS request failed (" + code + ")."
}

package main

// The parts of Express 4.22.3 and its middleware that server.js relies on,
// reproduced for net/http:
//
//   - res.json / res.send (express/lib/response.js): Content-Type with
//     charset, Content-Length, weak body ETag (etag 1.8.1), 304 through
//     req.fresh (fresh 0.5.2), HEAD without body;
//   - send 0.19.2 / serve-static 1.16.3 for express.static and res.sendFile:
//     stat ETag, Last-Modified, Cache-Control, Accept-Ranges, conditional
//     GET, single byte ranges (range-parser 1.2.1), directory redirects;
//   - compression 1.8.2 (negotiator 0.6.4): br (quality 4), gzip, deflate,
//     1 KB threshold, Vary: Accept-Encoding, no-transform, HEAD;
//   - cors 2.8.6 defaults and vary 1.1.2;
//   - path-to-regexp 0.1.13 route patterns (case-insensitive, optional
//     trailing slash) with decode_param's 400 on a malformed escape.
//
// Handlers run holding the server world's lock (the event loop). They only
// build the response in memory; compression and the network write happen in
// flush, after the lock is released, as Node hands both to libuv/zlib.

import (
	"compress/gzip"
	"compress/zlib"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"net/http"
	"os"
	pathpkg "path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/andybalholm/brotli"
)

// ---------------------------------------------------------------- request

type xreq struct {
	r         *http.Request
	method    string
	url       string // req.originalUrl: the raw request target
	pathname  string // parseurl(req).pathname, still percent-encoded
	query     *Obj
	params    *Obj
	ip        string
	requestID string
	routePath any // req.route.path; nil while no route matched
	apiLogged bool
	start     time.Time
}

// Node drops repeated values of these request headers and joins the rest
// with ", " (IncomingMessage._addHeaderLine).
var nodeDropDuplicate = map[string]bool{
	"age": true, "authorization": true, "content-length": true, "content-type": true,
	"etag": true, "expires": true, "from": true, "host": true, "if-modified-since": true,
	"if-unmodified-since": true, "last-modified": true, "location": true,
	"max-forwards": true, "proxy-authorization": true, "referer": true,
	"retry-after": true, "server": true, "user-agent": true,
}

// header is req.headers[name] ("" when absent).
func (q *xreq) header(name string) string {
	vals := q.r.Header.Values(name)
	if len(vals) == 0 {
		return ""
	}
	if nodeDropDuplicate[strings.ToLower(name)] {
		return vals[0]
	}
	return strings.Join(vals, ", ")
}

func (q *xreq) hasHeader(name string) bool { return len(q.r.Header.Values(name)) > 0 }

// splitTarget is parseurl's pathname/query split of a raw request target.
func splitTarget(target string) (pathname, query string, hasQuery bool) {
	if !strings.HasPrefix(target, "/") {
		// Absolute-form target: url.parse keeps only the path.
		if i := strings.Index(target, "://"); i >= 0 {
			rest := target[i+3:]
			if j := strings.IndexByte(rest, '/'); j >= 0 {
				target = rest[j:]
			} else {
				target = "/"
			}
		}
	}
	if i := strings.IndexByte(target, '#'); i >= 0 {
		target = target[:i]
	}
	if i := strings.IndexByte(target, '?'); i >= 0 {
		return target[:i], target[i+1:], true
	}
	return target, "", false
}

// ---------------------------------------------------------------- errors

// httpErr is an error carrying err.status, as http-errors and decode_param
// produce. Plain Go errors have no status (the error handler answers 500).
type httpErr struct {
	status int
	name   string
	msg    string
}

func (e *httpErr) Error() string { return e.msg }

var httpErrNames = map[int]string{
	400: "BadRequestError", 403: "ForbiddenError", 404: "NotFoundError",
	412: "PreconditionFailedError", 416: "RangeNotSatisfiableError", 500: "InternalServerError",
}

func newHTTPErr(status int) *httpErr {
	name := httpErrNames[status]
	if name == "" {
		name = "Error"
	}
	return &httpErr{status: status, name: name, msg: http.StatusText(status)}
}

// jsPanic is a JavaScript exception surfacing from ported code (a TypeError
// in the source).
type jsPanic struct{ v any }

func (p *jsPanic) Error() string { return fmt.Sprint(p.v) }

func errName(err error) string {
	var he *httpErr
	if errors.As(err, &he) {
		return he.name
	}
	var jp *jsPanic
	if errors.As(err, &jp) {
		return "TypeError"
	}
	return "Error"
}

// tryJS runs f, turning a panic into a returned error (a thrown exception).
func tryJS(f func()) (err error) {
	defer func() {
		if r := recover(); r != nil {
			if e, ok := r.(error); ok && errors.Is(e, http.ErrAbortHandler) {
				panic(r)
			}
			err = &jsPanic{v: r}
		}
	}()
	f()
	return nil
}

// ---------------------------------------------------------------- response

type fileBody struct {
	path string
	off  int64
	n    int64
}

type xres struct {
	w        http.ResponseWriter
	h        http.Header
	req      *xreq
	status   int
	ended    bool
	body     []byte
	file     *fileBody
	compress bool // compression() runs before this response's handler
	endLen   int  // compression's `length` (-1 = undefined)
	sse      *sseClient
}

func newXres(w http.ResponseWriter, q *xreq) *xres {
	return &xres{w: w, h: w.Header(), req: q, status: 200, endLen: -1}
}

func (res *xres) headersSent() bool { return res.ended || res.sse != nil }

// end is res.end(chunk): chunk nil means no body argument.
func (res *xres) end(chunk []byte) {
	if res.ended {
		return
	}
	if res.compress && res.h.Get("Content-Length") == "" {
		res.endLen = len(chunk)
	}
	res.ended = true
	res.body = chunk
}

// setContentType is res.set('Content-Type', v): a charset is added for
// types mime 1.6 gives one.
func (res *xres) setContentType(v string) {
	if !reCharsetParam.MatchString(v) {
		if cs := mimeCharset(strings.TrimSpace(strings.SplitN(v, ";", 2)[0])); cs != "" {
			v += "; charset=" + strings.ToLower(cs)
		}
	}
	res.h.Set("Content-Type", v)
}

var reCharsetParam = regexp.MustCompile(`;\s*charset\s*=`)

// send is res.send(string).
func (res *xres) send(chunk []byte) {
	if res.h.Get("Content-Type") == "" {
		res.setContentType("text/html")
	}
	res.h.Set("Content-Type", setCharset(res.h.Get("Content-Type"), "utf-8"))
	generateETag := res.h.Get("ETag") == ""
	res.h.Set("Content-Length", strconv.Itoa(len(chunk)))
	if generateETag {
		res.h.Set("ETag", bodyETag(chunk))
	}
	if res.fresh() {
		res.status = 304
	}
	if res.status == 204 || res.status == 304 {
		res.h.Del("Content-Type")
		res.h.Del("Content-Length")
		res.h.Del("Transfer-Encoding")
		chunk = []byte{}
	}
	if res.req.method == "HEAD" {
		res.end(nil)
	} else {
		res.end(chunk)
	}
}

// json is res.json(obj).
func (res *xres) json(v any) {
	body := toJSON(v)
	if res.h.Get("Content-Type") == "" {
		res.setContentType("application/json")
	}
	res.send(body)
}

// fresh is req.fresh.
func (res *xres) fresh() bool {
	if res.req.method != "GET" && res.req.method != "HEAD" {
		return false
	}
	if (res.status >= 200 && res.status < 300) || res.status == 304 {
		return freshCheck(res.req, res.h.Get("ETag"), res.h.Get("Last-Modified"))
	}
	return false
}

var reNoCacheDirective = regexp.MustCompile(`(?:^|,)\s*?no-cache\s*?(?:,|$)`)

func freshCheck(q *xreq, etag, lastModified string) bool {
	modifiedSince := q.header("If-Modified-Since")
	noneMatch := q.header("If-None-Match")
	if modifiedSince == "" && noneMatch == "" {
		return false
	}
	if cc := q.header("Cache-Control"); cc != "" && reNoCacheDirective.MatchString(cc) {
		return false
	}
	if noneMatch != "" && noneMatch != "*" {
		if etag == "" {
			return false
		}
		stale := true
		for _, m := range parseTokenList(noneMatch) {
			if m == etag || m == "W/"+etag || "W/"+m == etag {
				stale = false
				break
			}
		}
		if stale {
			return false
		}
	}
	if modifiedSince != "" {
		if lastModified == "" || !(parseHTTPDate(lastModified) <= parseHTTPDate(modifiedSince)) {
			return false
		}
	}
	return true
}

func parseTokenList(str string) []string {
	var list []string
	start, end := 0, 0
	for i := 0; i < len(str); i++ {
		switch str[i] {
		case ' ':
			if start == end {
				start, end = i+1, i+1
			}
		case ',':
			if start != end {
				list = append(list, str[start:end])
			}
			start, end = i+1, i+1
		default:
			end = i + 1
		}
	}
	if start != end {
		list = append(list, str[start:end])
	}
	return list
}

// parseHTTPDate is Date.parse for the dates HTTP carries (NaN otherwise).
func parseHTTPDate(s string) float64 {
	if s == "" {
		return math.NaN()
	}
	if t, err := http.ParseTime(s); err == nil {
		return float64(t.UnixMilli())
	}
	if ms, ok := parseDateJS(s); ok {
		return float64(ms)
	}
	return math.NaN()
}

func bodyETag(b []byte) string {
	if len(b) == 0 {
		return `W/"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"`
	}
	sum := sha1.Sum(b)
	hash := base64.StdEncoding.EncodeToString(sum[:])[:27]
	return `W/"` + strconv.FormatInt(int64(len(b)), 16) + "-" + hash + `"`
}

func statETag(fi os.FileInfo) string {
	return `W/"` + strconv.FormatInt(fi.Size(), 16) + "-" + strconv.FormatInt(fi.ModTime().UnixMilli(), 16) + `"`
}

// setCharset is express utils.setCharset (content-type parse + format).
func setCharset(typ, charset string) string {
	if typ == "" {
		return typ
	}
	parts := strings.Split(typ, ";")
	media := strings.ToLower(strings.TrimSpace(parts[0]))
	params := map[string]string{}
	for _, p := range parts[1:] {
		kv := strings.SplitN(p, "=", 2)
		if len(kv) != 2 {
			continue
		}
		k := strings.ToLower(strings.TrimSpace(kv[0]))
		v := strings.TrimSpace(kv[1])
		if len(v) >= 2 && v[0] == '"' && v[len(v)-1] == '"' {
			v = v[1 : len(v)-1]
		}
		params[k] = v
	}
	params["charset"] = charset
	names := make([]string, 0, len(params))
	for k := range params {
		names = append(names, k)
	}
	sort.Strings(names)
	out := media
	for _, k := range names {
		v := params[k]
		if !reToken.MatchString(v) {
			v = `"` + strings.ReplaceAll(strings.ReplaceAll(v, `\`, `\\`), `"`, `\"`) + `"`
		}
		out += "; " + k + "=" + v
	}
	return out
}

var reToken = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")

// vary appends a field to the Vary header (vary 1.1.2).
func (res *xres) vary(field string) {
	header := strings.Join(res.h.Values("Vary"), ", ")
	if header == "*" {
		return
	}
	val := header
	vals := parseVaryList(strings.ToLower(header))
	if field == "*" || indexOfStr(vals, "*") >= 0 {
		res.h.Set("Vary", "*")
		return
	}
	for _, f := range parseVaryList(field) {
		fl := strings.ToLower(f)
		if indexOfStr(vals, fl) == -1 {
			vals = append(vals, fl)
			if val != "" {
				val += ", " + f
			} else {
				val = f
			}
		}
	}
	if val != "" {
		res.h.Set("Vary", val)
	}
}

func parseVaryList(header string) []string {
	var list []string
	start, end := 0, 0
	for i := 0; i < len(header); i++ {
		switch header[i] {
		case ' ':
			if start == end {
				start, end = i+1, i+1
			}
		case ',':
			list = append(list, header[start:end])
			start, end = i+1, i+1
		default:
			end = i + 1
		}
	}
	return append(list, header[start:end])
}

func indexOfStr(list []string, s string) int {
	for i, x := range list {
		if x == s {
			return i
		}
	}
	return -1
}

// ---------------------------------------------------------------- mime 1.6

var mimeTypes = map[string]string{
	"html": "text/html", "htm": "text/html", "css": "text/css", "js": "application/javascript",
	"mjs": "application/javascript", "json": "application/json", "map": "application/json",
	"webmanifest": "application/manifest+json", "txt": "text/plain", "csv": "text/csv",
	"svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
	"gif": "image/gif", "ico": "image/x-icon", "webp": "image/webp", "woff": "application/font-woff",
	"woff2": "application/font-woff2", "xml": "application/xml",
}

var reMimeExt = regexp.MustCompile(`^.*[./\\]`)

func mimeLookup(p string) string {
	ext := strings.ToLower(reMimeExt.ReplaceAllString(p, ""))
	if t, ok := mimeTypes[ext]; ok {
		return t
	}
	return "application/octet-stream"
}

var reMimeCharset = regexp.MustCompile(`^text/|^application/(javascript|json)`)

func mimeCharset(t string) string {
	if reMimeCharset.MatchString(t) {
		return "UTF-8"
	}
	return ""
}

// ---------------------------------------------------------------- send

type sendOptions struct {
	root     string  // "" for res.sendFile's absolute path
	maxAgeMs float64 // Cache-Control max-age when none is set
	// onHeaders is the 'headers' event (express.static's setHeaders).
	onHeaders func(res *xres, path string)
	// directory handles the 'directory' event; nil makes it an error.
	directory func(res *xres)
}

// sendResult says how a send pipe ended.
type sendResult struct {
	file bool     // the 'file' event fired
	err  *httpErr // the 'error' event (always listened for here)
	dir  bool     // the 'directory' event fired
}

var reUpPath = regexp.MustCompile(`(?:^|[\\/])\.\.(?:[\\/]|$)`)

func (res *xres) sendPipe(rawPath string, o sendOptions) sendResult {
	p, ok := decodeURIComponentJS(rawPath)
	if !ok || strings.Contains(p, "\x00") {
		return sendResult{err: newHTTPErr(400)}
	}
	var parts []string
	if o.root != "" {
		if p != "" {
			p = pathpkg.Clean("./" + p)
		}
		if reUpPath.MatchString(p) {
			return sendResult{err: newHTTPErr(403)}
		}
		parts = strings.Split(p, "/")
		p = pathpkg.Join(o.root, p)
	} else {
		if reUpPath.MatchString(p) {
			return sendResult{err: newHTTPErr(403)}
		}
		parts = strings.Split(pathpkg.Clean(p), "/")
	}
	for _, part := range parts {
		if len(part) > 1 && part[0] == '.' {
			last := parts[len(parts)-1]
			if last != "" && last[0] == '.' {
				return sendResult{err: newHTTPErr(404)}
			}
			break
		}
	}
	hasTrailingSlash := strings.HasSuffix(rawPath, "/")
	if hasTrailingSlash {
		ip := pathpkg.Join(p, "index.html")
		fi, err := os.Stat(ip)
		if err != nil {
			return sendResult{err: statError(err)}
		}
		if fi.IsDir() {
			return sendResult{err: newHTTPErr(404)}
		}
		return res.sendStat(ip, fi, o)
	}
	fi, err := os.Stat(p)
	if err != nil {
		return sendResult{err: statError(err)}
	}
	if fi.IsDir() {
		if o.directory != nil {
			if hasTrailingSlash {
				return sendResult{dir: true, err: newHTTPErr(404)}
			}
			o.directory(res)
			return sendResult{dir: true}
		}
		return sendResult{dir: true}
	}
	return res.sendStat(p, fi, o)
}

func statError(err error) *httpErr {
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) || errors.Is(err, syscall.ENAMETOOLONG) {
		return newHTTPErr(404)
	}
	return newHTTPErr(500)
}

var reBytesRange = regexp.MustCompile(`^ *bytes=`)

// sendStat is SendStream.send after the 'file' event.
func (res *xres) sendStat(p string, fi os.FileInfo, o sendOptions) sendResult {
	out := sendResult{file: true}
	if o.onHeaders != nil {
		o.onHeaders(res, p)
	}
	if res.h.Get("Accept-Ranges") == "" {
		res.h.Set("Accept-Ranges", "bytes")
	}
	if res.h.Get("Cache-Control") == "" {
		res.h.Set("Cache-Control", "public, max-age="+strconv.FormatInt(int64(math.Floor(o.maxAgeMs/1000)), 10))
	}
	if res.h.Get("Last-Modified") == "" {
		res.h.Set("Last-Modified", fi.ModTime().UTC().Format(http.TimeFormat))
	}
	if res.h.Get("ETag") == "" {
		res.h.Set("ETag", statETag(fi))
	}
	if res.h.Get("Content-Type") == "" {
		t := mimeLookup(p)
		if cs := mimeCharset(t); cs != "" {
			t += "; charset=" + cs
		}
		res.h.Set("Content-Type", t)
	}
	q := res.req
	if q.header("If-Match") != "" || q.header("If-Unmodified-Since") != "" || q.header("If-None-Match") != "" || q.header("If-Modified-Since") != "" {
		if res.preconditionFailure() {
			out.err = newHTTPErr(412)
			return out
		}
		cachable := (res.status >= 200 && res.status < 300) || res.status == 304
		if cachable && freshCheck(q, res.h.Get("ETag"), res.h.Get("Last-Modified")) {
			for _, k := range []string{"Content-Encoding", "Content-Language", "Content-Length", "Content-Range", "Content-Type"} {
				res.h.Del(k)
			}
			res.status = 304
			res.end(nil)
			return out
		}
	}
	length := fi.Size()
	offset := int64(0)
	if rng := q.header("Range"); reBytesRange.MatchString(rng) {
		ranges, code := parseRange(length, rng)
		if code != -2 && !res.rangeFresh() {
			code = -2
		}
		if code == -1 {
			res.h.Set("Content-Range", "bytes */"+strconv.FormatInt(length, 10))
			out.err = newHTTPErr(416)
			return out
		}
		if code != -2 && len(ranges) == 1 {
			res.status = 206
			res.h.Set("Content-Range", "bytes "+strconv.FormatInt(ranges[0][0], 10)+"-"+strconv.FormatInt(ranges[0][1], 10)+"/"+strconv.FormatInt(length, 10))
			offset = ranges[0][0]
			length = ranges[0][1] - ranges[0][0] + 1
		}
	}
	res.h.Set("Content-Length", strconv.FormatInt(length, 10))
	if q.method == "HEAD" {
		res.end(nil)
		return out
	}
	res.ended = true
	res.file = &fileBody{path: p, off: offset, n: length}
	return out
}

func (res *xres) preconditionFailure() bool {
	q := res.req
	if match := q.header("If-Match"); match != "" {
		etag := res.h.Get("ETag")
		if etag == "" {
			return true
		}
		if match == "*" {
			return false
		}
		for _, m := range parseTokenList(match) {
			if m == etag || m == "W/"+etag || "W/"+m == etag {
				return false
			}
		}
		return true
	}
	unmodified := parseHTTPDate(q.header("If-Unmodified-Since"))
	if !math.IsNaN(unmodified) {
		lm := parseHTTPDate(res.h.Get("Last-Modified"))
		return math.IsNaN(lm) || lm > unmodified
	}
	return false
}

func (res *xres) rangeFresh() bool {
	ifRange := res.req.header("If-Range")
	if ifRange == "" {
		return true
	}
	if strings.Contains(ifRange, `"`) {
		etag := res.h.Get("ETag")
		return etag != "" && strings.Contains(ifRange, etag)
	}
	return parseHTTPDate(res.h.Get("Last-Modified")) <= parseHTTPDate(ifRange)
}

// parseRange is range-parser 1.2.1 with { combine: true }. code is -2 for
// an unparsable header, -1 for unsatisfiable, 0 otherwise.
func parseRange(size int64, str string) ([][2]int64, int) {
	index := strings.IndexByte(str, '=')
	if index == -1 {
		return nil, -2
	}
	type rng struct {
		start, end float64
		index      int
	}
	var ranges []rng
	fsize := float64(size)
	for _, part := range strings.Split(str[index+1:], ",") {
		r := strings.Split(part, "-")
		start := parseIntJS(r[0])
		end := math.NaN()
		if len(r) > 1 {
			end = parseIntJS(r[1])
		}
		if math.IsNaN(start) {
			start = fsize - end
			end = fsize - 1
		} else if math.IsNaN(end) {
			end = fsize - 1
		}
		if end > fsize-1 {
			end = fsize - 1
		}
		if math.IsNaN(start) || math.IsNaN(end) || start > end || start < 0 {
			continue
		}
		ranges = append(ranges, rng{start, end, len(ranges)})
	}
	if len(ranges) < 1 {
		return nil, -1
	}
	ordered := append([]rng(nil), ranges...)
	sort.SliceStable(ordered, func(a, b int) bool { return ordered[a].start < ordered[b].start })
	j := 0
	for i := 1; i < len(ordered); i++ {
		r := ordered[i]
		cur := &ordered[j]
		if r.start > cur.end+1 {
			j++
			ordered[j] = r
		} else if r.end > cur.end {
			cur.end = r.end
			if r.index < cur.index {
				cur.index = r.index
			}
		}
	}
	ordered = ordered[:j+1]
	sort.SliceStable(ordered, func(a, b int) bool { return ordered[a].index < ordered[b].index })
	out := make([][2]int64, len(ordered))
	for i, r := range ordered {
		out[i] = [2]int64{int64(r.start), int64(r.end)}
	}
	return out, 0
}

// directoryRedirect is serve-static's redirect listener.
func directoryRedirect(res *xres) {
	pathname, query, hasQuery := splitTarget(res.req.url)
	loc := collapseLeadingSlashes(pathname + "/")
	if hasQuery {
		loc += "?" + query
	}
	loc = encodeURL(loc)
	doc := "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Redirecting</title>\n</head>\n<body>\n<pre>Redirecting to " + escapeHTML(loc) + "</pre>\n</body>\n</html>\n"
	res.status = 301
	res.h.Set("Content-Type", "text/html; charset=UTF-8")
	res.h.Set("Content-Length", strconv.Itoa(len(doc)))
	res.h.Set("Content-Security-Policy", "default-src 'none'")
	res.h.Set("X-Content-Type-Options", "nosniff")
	res.h.Set("Location", loc)
	res.end([]byte(doc))
}

func collapseLeadingSlashes(s string) string {
	i := 0
	for i < len(s) && s[i] == '/' {
		i++
	}
	if i > 1 {
		return "/" + s[i:]
	}
	return s
}

func isHex(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

// encodeURL is encodeurl 2.0.0.
func encodeURL(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '%' {
			if i+2 < len(s) && isHex(s[i+1]) && isHex(s[i+2]) {
				b.WriteByte(c)
				continue
			}
			b.WriteString("%25")
			continue
		}
		allowed := c == 0x21 || (c >= 0x23 && c <= 0x3B) || c == 0x3D || (c >= 0x3F && c <= 0x5F) ||
			(c >= 0x61 && c <= 0x7A) || c == 0x7C || c == 0x7E
		if allowed {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func escapeHTML(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#39;")
	return r.Replace(s)
}

// ---------------------------------------------------------------- compression

var reNoTransform = regexp.MustCompile(`(?i)(?:^|,)\s*?no-transform\s*?(?:,|$)`)
var reCompressibleFallback = regexp.MustCompile(`(?i)^text/|\+(?:json|text|xml)$`)
var reExtractType = regexp.MustCompile(`^\s*([^;\s]*)(?:;|\s|$)`)

var compressibleDB = map[string]bool{
	"application/json": true, "text/html": true, "text/csv": true, "text/css": true,
	"application/javascript": true, "application/manifest+json": true, "text/plain": true,
	"image/svg+xml": true, "application/xml": true,
}

func compressible(t string) bool {
	if t == "" {
		return false
	}
	m := reExtractType.FindStringSubmatch(t)
	if m == nil {
		return false
	}
	mt := strings.ToLower(m[1])
	if v, ok := compressibleDB[mt]; ok {
		return v
	}
	return reCompressibleFallback.MatchString(mt)
}

type encSpec struct {
	encoding string
	q        float64
	i        int
}

var reSimpleEncoding = regexp.MustCompile(`^\s*([^\s;]+)\s*(?:;(.*))?$`)

// negotiateEncoding is negotiator 0.6.4's encodings(available, preferred)[0]
// with compression's SUPPORTED and PREFERRED lists.
func negotiateEncoding(accept string) string {
	available := []string{"br", "gzip", "deflate", "identity"}
	preferred := []string{"br", "gzip"}
	var accepts []encSpec
	hasIdentity := false
	minQuality := 1.0
	parts := strings.Split(accept, ",")
	for i, raw := range parts {
		m := reSimpleEncoding.FindStringSubmatch(jsTrim(raw))
		if m == nil {
			continue
		}
		q := 1.0
		if m[2] != "" {
			for _, p := range strings.Split(m[2], ";") {
				kv := strings.Split(jsTrim(p), "=")
				if kv[0] == "q" {
					if len(kv) > 1 {
						q = parseFloatJS(kv[1])
					} else {
						q = math.NaN()
					}
					break
				}
			}
		}
		spec := encSpec{m[1], q, i}
		accepts = append(accepts, spec)
		if strings.EqualFold(spec.encoding, "identity") || spec.encoding == "*" {
			hasIdentity = true
		}
		qq := spec.q
		if qq == 0 || math.IsNaN(qq) {
			qq = 1
		}
		minQuality = math.Min(minQuality, qq)
	}
	if !hasIdentity {
		accepts = append(accepts, encSpec{"identity", minQuality, len(parts)})
	}
	type prio struct {
		encoding string
		i, o, s  int
		q        float64
	}
	var prios []prio
	for idx, enc := range available {
		best := prio{encoding: enc, o: -1, q: 0, s: 0}
		for _, a := range accepts {
			s := 0
			if strings.EqualFold(a.encoding, enc) {
				s = 1
			} else if a.encoding != "*" {
				continue
			}
			spec := prio{encoding: enc, i: idx, o: a.i, q: a.q, s: s}
			d := float64(best.s - spec.s)
			if d == 0 {
				d = best.q - spec.q
				if math.IsNaN(d) {
					d = 0
				}
				if d == 0 {
					d = float64(best.o - spec.o)
				}
			}
			if d < 0 {
				best = spec
			}
		}
		if best.q > 0 {
			prios = append(prios, best)
		}
	}
	if len(prios) == 0 {
		return ""
	}
	pref := func(e string) int { return indexOfStr(preferred, e) }
	sort.SliceStable(prios, func(x, y int) bool {
		a, b := prios[x], prios[y]
		if a.q != b.q {
			return a.q > b.q
		}
		ap, bp := pref(a.encoding), pref(b.encoding)
		if ap == -1 && bp == -1 {
			if a.s != b.s {
				return a.s > b.s
			}
			if a.o != b.o {
				return a.o < b.o
			}
			return a.i < b.i
		}
		if ap != -1 && bp != -1 {
			return ap < bp
		}
		return ap != -1
	})
	return prios[0].encoding
}

// compressionMethod is compression's onHeaders decision ("" = none).
func (res *xres) compressionMethod() string {
	if !compressible(res.h.Get("Content-Type")) {
		return ""
	}
	if cc := res.h.Get("Cache-Control"); cc != "" && reNoTransform.MatchString(cc) {
		return ""
	}
	res.vary("Accept-Encoding")
	if cl := res.h.Get("Content-Length"); cl != "" {
		if n := stringToNumber(cl); n < 1024 {
			return ""
		}
	}
	if res.endLen >= 0 && res.endLen < 1024 {
		return ""
	}
	if enc := res.h.Get("Content-Encoding"); enc != "" && enc != "identity" {
		return ""
	}
	if res.req.method == "HEAD" {
		return ""
	}
	method := negotiateEncoding(res.req.header("Accept-Encoding"))
	if res.req.header("Accept-Encoding") == "" {
		method = "identity"
	}
	if method == "" || method == "identity" {
		return ""
	}
	return method
}

var brotliPool = sync.Pool{New: func() any {
	return brotli.NewWriterOptions(io.Discard, brotli.WriterOptions{Quality: 4, LGWin: 22})
}}
var gzipPool = sync.Pool{New: func() any {
	w, _ := gzip.NewWriterLevel(io.Discard, gzip.DefaultCompression)
	return w
}}

type flushWriter interface {
	io.Writer
	Close() error
}

// flush writes the response built by the handler, outside the world lock.
func (res *xres) flush() error {
	if !res.ended {
		return nil
	}
	method := ""
	if res.compress {
		method = res.compressionMethod()
	}
	if method != "" {
		res.h.Set("Content-Encoding", method)
		res.h.Del("Content-Length")
	}
	res.w.WriteHeader(res.status)
	if res.req.method == "HEAD" || (res.body == nil && res.file == nil) {
		return nil
	}
	var out io.Writer = res.w
	var closer flushWriter
	switch method {
	case "br":
		bw := brotliPool.Get().(*brotli.Writer)
		bw.Reset(res.w)
		defer brotliPool.Put(bw)
		out, closer = bw, bw
	case "gzip":
		gw := gzipPool.Get().(*gzip.Writer)
		gw.Reset(res.w)
		defer gzipPool.Put(gw)
		out, closer = gw, gw
	case "deflate":
		zw, _ := zlib.NewWriterLevel(res.w, zlib.DefaultCompression)
		out, closer = zw, zw
	}
	var err error
	if res.file != nil {
		err = copyFileRegion(out, res.file)
	} else {
		_, err = out.Write(res.body)
	}
	if closer != nil {
		if cerr := closer.Close(); err == nil {
			err = cerr
		}
	}
	return err
}

func copyFileRegion(w io.Writer, fb *fileBody) error {
	f, err := os.Open(fb.path)
	if err != nil {
		return err
	}
	defer f.Close()
	if fb.off > 0 {
		if _, err := f.Seek(fb.off, io.SeekStart); err != nil {
			return err
		}
	}
	_, err = io.CopyN(w, f, fb.n)
	return err
}

// ---------------------------------------------------------------- cors 2.8.6

// cors applies the default options; true when it answered a preflight.
func (res *xres) cors() bool {
	res.h.Set("Access-Control-Allow-Origin", "*")
	if strings.ToUpper(res.req.method) != "OPTIONS" {
		return false
	}
	res.h.Set("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE")
	res.vary("Access-Control-Request-Headers")
	if allowed := res.req.header("Access-Control-Request-Headers"); allowed != "" {
		res.h.Set("Access-Control-Allow-Headers", allowed)
	}
	res.status = 204
	res.h.Set("Content-Length", "0")
	res.end(nil)
	return true
}

// ---------------------------------------------------------------- routes

// route is one compiled path-to-regexp 0.1.13 pattern.
type route struct {
	path string
	re   *regexp.Regexp
	keys []string
	star bool // the '*' fast path
}

var reRouteToken = regexp.MustCompile(`/:(\w+)|\*|\.`)

// compileRoute supports the pattern forms server.js uses: literal segments,
// '/:name' parameters, '*' and '.'.
func compileRoute(p string) *route {
	r := &route{path: p}
	if p == "*" {
		r.star = true
		return r
	}
	var b strings.Builder
	b.WriteString("(?i)^")
	last := 0
	for _, m := range reRouteToken.FindAllStringSubmatchIndex(p, -1) {
		b.WriteString(regexp.QuoteMeta(p[last:m[0]]))
		tok := p[m[0]:m[1]]
		switch {
		case tok == "*":
			b.WriteString("(.*)")
			r.keys = append(r.keys, "0")
		case tok == ".":
			b.WriteString(`\.`)
		default:
			b.WriteString(`(?:/([^/]+?))`)
			r.keys = append(r.keys, p[m[2]:m[3]])
		}
		last = m[1]
	}
	b.WriteString(regexp.QuoteMeta(p[last:]))
	if strings.HasSuffix(p, "/") {
		b.WriteString("?$")
	} else {
		b.WriteString("/?$")
	}
	r.re = regexp.MustCompile(b.String())
	return r
}

// decodeParam is express's decode_param.
func decodeParam(v string) (string, *httpErr) {
	if v == "" {
		return v, nil
	}
	d, ok := decodeURIComponentJS(v)
	if !ok {
		return "", &httpErr{status: 400, name: "URIError", msg: "Failed to decode param '" + v + "'"}
	}
	return d, nil
}

// matchRoute tests a pathname; params come back decoded.
func (r *route) matchPath(pathname string) (*Obj, bool, *httpErr) {
	if r.star {
		d, err := decodeParam(pathname)
		if err != nil {
			return nil, true, err
		}
		return O("0", d), true, nil
	}
	m := r.re.FindStringSubmatchIndex(pathname)
	if m == nil {
		return nil, false, nil
	}
	params := O()
	for i, k := range r.keys {
		s, e := m[2+2*i], m[3+2*i]
		if s < 0 {
			if !params.Has(k) {
				params.Set(k, Undefined)
			}
			continue
		}
		d, err := decodeParam(pathname[s:e])
		if err != nil {
			return nil, true, err
		}
		params.Set(k, d)
	}
	return params, true, nil
}

// useMatches is app.use(prefix) matching: '^/prefix/?(?=/|$)', i.
func useMatches(prefix, pathname string) bool {
	if len(pathname) < len(prefix) || !strings.EqualFold(pathname[:len(prefix)], prefix) {
		return false
	}
	rest := pathname[len(prefix):]
	return rest == "" || rest[0] == '/'
}

// ---------------------------------------------------------------- misc

func randomUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

var stdoutMu sync.Mutex

// consoleLog is console.log of one line.
func consoleLog(line []byte) {
	stdoutMu.Lock()
	defer stdoutMu.Unlock()
	os.Stdout.Write(append(line, '\n'))
}

// consoleError is console.error of one line.
func consoleError(line []byte) {
	stdoutMu.Lock()
	defer stdoutMu.Unlock()
	os.Stderr.Write(append(line, '\n'))
}

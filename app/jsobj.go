package main

// JavaScript value semantics for the parts of Arribo that build their
// responses dynamically. The Node implementation spreads, extends and
// serializes plain objects; reproducing its JSON exactly needs:
//
//   - insertion-ordered keys, with integer-like keys first in ascending order
//     (ECMAScript OrdinaryOwnPropertyKeys),
//   - a distinction between a missing key / undefined (omitted by
//     JSON.stringify) and null (kept),
//   - JSON.stringify's number formatting and string escaping.
//
// Values held in an Obj are: nil (null), Undefined, bool, float64, int, int64,
// string, *Obj, []any, or any type with a MarshalJS method or one handled by
// writeJSON. Numbers are float64 unless an integer type is clearer.

import (
	"bytes"
	"math"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

type undefinedT struct{}

// Undefined is JavaScript's undefined: a key holding it is skipped by
// JSON.stringify, and inside an array it serializes as null.
var Undefined = undefinedT{}

// Obj is an insertion-ordered JavaScript object. Entries live in one slice:
// most objects have a handful of keys, where a scan beats a map and costs a
// fraction of the memory. Objects past objIndexMin keys also get a map index.
type Obj struct {
	kvs   []objKV
	index map[string]int32
	nIdx  int32 // keys that are array indices (they enumerate first)
}

type objKV struct {
	k string
	v any
}

const objIndexMin = 16

func (o *Obj) find(k string) int {
	if o.index != nil {
		if i, ok := o.index[k]; ok {
			return int(i)
		}
		return -1
	}
	for i := range o.kvs {
		if o.kvs[i].k == k {
			return i
		}
	}
	return -1
}

func (o *Obj) buildIndex() {
	if len(o.kvs) <= objIndexMin {
		o.index = nil
		return
	}
	o.index = make(map[string]int32, len(o.kvs))
	for i := range o.kvs {
		o.index[o.kvs[i].k] = int32(i)
	}
}

// each visits own entries in ECMAScript order (as Keys), without allocating
// when no key is an array index.
func (o *Obj) each(f func(k string, v any)) {
	if o == nil {
		return
	}
	if o.nIdx == 0 {
		for i := range o.kvs {
			f(o.kvs[i].k, o.kvs[i].v)
		}
		return
	}
	for _, k := range o.Keys() {
		f(k, o.kvs[o.find(k)].v)
	}
}

// O builds an object from key/value pairs: O("a", 1, "b", "x").
func O(kv ...any) *Obj {
	o := &Obj{}
	if len(kv) > 1 {
		o.kvs = make([]objKV, 0, len(kv)/2)
	}
	for i := 0; i+1 < len(kv); i += 2 {
		o.Set(kv[i].(string), kv[i+1])
	}
	return o
}

func (o *Obj) Set(k string, v any) *Obj {
	v = canonNumber(v)
	if i := o.find(k); i >= 0 {
		o.kvs[i].v = v
		return o
	}
	o.kvs = append(o.kvs, objKV{k, v})
	if isArrayIndex(k) {
		o.nIdx++
	}
	if o.index != nil {
		o.index[k] = int32(len(o.kvs) - 1)
	} else if len(o.kvs) > objIndexMin {
		o.buildIndex()
	}
	return o
}

// Get returns Undefined for a missing key, like a JavaScript property read.
func (o *Obj) Get(k string) any {
	if o == nil {
		return Undefined
	}
	if i := o.find(k); i >= 0 {
		return o.kvs[i].v
	}
	return Undefined
}

func (o *Obj) Has(k string) bool {
	if o == nil {
		return false
	}
	return o.find(k) >= 0
}

func (o *Obj) Delete(k string) {
	if o == nil {
		return
	}
	i := o.find(k)
	if i < 0 {
		return
	}
	o.kvs = append(o.kvs[:i:i], o.kvs[i+1:]...)
	if isArrayIndex(k) {
		o.nIdx--
	}
	if o.index != nil {
		o.buildIndex()
	}
}

// Keys returns own keys in ECMAScript order (Object.keys), including keys
// whose value is Undefined.
func (o *Obj) Keys() []string {
	if o == nil {
		return nil
	}
	if o.nIdx == 0 {
		ks := make([]string, len(o.kvs))
		for i := range o.kvs {
			ks[i] = o.kvs[i].k
		}
		return ks
	}
	var ints []string
	var strs []string
	for i := range o.kvs {
		if k := o.kvs[i].k; isArrayIndex(k) {
			ints = append(ints, k)
		} else {
			strs = append(strs, k)
		}
	}
	sort.Slice(ints, func(i, j int) bool {
		a, _ := strconv.ParseUint(ints[i], 10, 64)
		b, _ := strconv.ParseUint(ints[j], 10, 64)
		return a < b
	})
	return append(ints, strs...)
}

func (o *Obj) Len() int {
	if o == nil {
		return 0
	}
	return len(o.kvs)
}

// Clone is a shallow copy: { ...o } (its insertion order is o's key order).
func (o *Obj) Clone() *Obj {
	c := &Obj{}
	if o == nil {
		return c
	}
	c.kvs = make([]objKV, 0, len(o.kvs))
	o.each(func(k string, v any) { c.kvs = append(c.kvs, objKV{k, v}) })
	c.nIdx = o.nIdx
	c.buildIndex()
	return c
}

// Spread copies every own key of src into o, in src's key order: { ...o, ...src }.
func (o *Obj) Spread(src *Obj) *Obj {
	if src == nil {
		return o
	}
	src.each(func(k string, v any) { o.Set(k, v) })
	return o
}

func isArrayIndex(k string) bool {
	if k == "" || len(k) > 10 {
		return false
	}
	if k == "0" {
		return true
	}
	if k[0] < '1' || k[0] > '9' {
		return false
	}
	for i := 1; i < len(k); i++ {
		if k[i] < '0' || k[i] > '9' {
			return false
		}
	}
	n, err := strconv.ParseUint(k, 10, 64)
	return err == nil && n < 4294967295
}

// ---------------------------------------------------------------------------
// Typed reads with JavaScript coercion.

func (o *Obj) Str(k string) string     { return jsString(o.Get(k)) }
func (o *Obj) Num(k string) float64    { return jsNumber(o.Get(k)) }
func (o *Obj) Bool(k string) bool      { return truthy(o.Get(k)) }
func (o *Obj) ObjAt(k string) *Obj     { v, _ := o.Get(k).(*Obj); return v }
func (o *Obj) Arr(k string) []any      { v, _ := o.Get(k).([]any); return v }
func (o *Obj) IsNullish(k string) bool { return isNullish(o.Get(k)) }
func (o *Obj) IsUndef(k string) bool   { _, u := o.Get(k).(undefinedT); return u }

func isNullish(v any) bool {
	if v == nil {
		return true
	}
	_, u := v.(undefinedT)
	return u
}

func isUndef(v any) bool {
	_, u := v.(undefinedT)
	return u
}

// truthy is JavaScript ToBoolean.
func truthy(v any) bool {
	switch x := v.(type) {
	case nil, undefinedT:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case int:
		return x != 0
	case int64:
		return x != 0
	case string:
		return x != ""
	default:
		return true
	}
}

// or is JavaScript a || b.
func or(a, b any) any {
	if truthy(a) {
		return a
	}
	return b
}

// coalesce is JavaScript a ?? b.
func coalesce(a, b any) any {
	if isNullish(a) {
		return b
	}
	return a
}

func toF(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	}
	return 0, false
}

// jsNumber is JavaScript Number(v).
func jsNumber(v any) float64 {
	switch x := v.(type) {
	case nil:
		return 0
	case undefinedT:
		return math.NaN()
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case string:
		return stringToNumber(x)
	case []any:
		if len(x) == 0 {
			return 0
		}
		if len(x) == 1 {
			return jsNumber(jsString(x[0]))
		}
		return math.NaN()
	default:
		return math.NaN()
	}
}

func isJSWhite(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

func jsTrim(s string) string { return strings.TrimFunc(s, isJSWhite) }

// stringToNumber is ECMAScript StringToNumber.
func stringToNumber(s string) float64 {
	t := jsTrim(s)
	if t == "" {
		return 0
	}
	if len(t) > 2 && t[0] == '0' {
		base := 0
		switch t[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			n := new(big.Int)
			if _, ok := n.SetString(t[2:], base); !ok {
				return math.NaN()
			}
			f, _ := new(big.Float).SetInt(n).Float64()
			return f
		}
	}
	switch t {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	// StrDecimalLiteral: digits, optional fraction, optional exponent. Go's
	// ParseFloat also accepts "inf", "nan", hex floats and underscores; refuse those.
	for _, c := range t {
		if !(c >= '0' && c <= '9' || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
			return math.NaN()
		}
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		if ne, ok := err.(*strconv.NumError); ok && ne.Err == strconv.ErrRange {
			return f
		}
		return math.NaN()
	}
	return f
}

// parseFloatJS is JavaScript parseFloat(String(v)).
func parseFloatJS(v any) float64 {
	if f, ok := toF(v); ok {
		// parseFloat(String(n)) round-trips every finite number.
		return f
	}
	s := strings.TrimLeftFunc(jsString(v), isJSWhite)
	// Longest prefix that is a StrDecimalLiteral.
	i := 0
	if i < len(s) && (s[i] == '+' || s[i] == '-') {
		i++
	}
	if strings.HasPrefix(s[i:], "Infinity") {
		if s[0] == '-' {
			return math.Inf(-1)
		}
		return math.Inf(1)
	}
	start := i
	digits := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
		digits++
	}
	if i < len(s) && s[i] == '.' {
		i++
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
			digits++
		}
	}
	if digits == 0 {
		return math.NaN()
	}
	end := i
	if i < len(s) && (s[i] == 'e' || s[i] == 'E') {
		j := i + 1
		if j < len(s) && (s[j] == '+' || s[j] == '-') {
			j++
		}
		k := j
		for k < len(s) && s[k] >= '0' && s[k] <= '9' {
			k++
		}
		if k > j {
			end = k
		}
	}
	_ = start
	f, err := strconv.ParseFloat(s[:end], 64)
	if err != nil {
		if ne, ok := err.(*strconv.NumError); ok && ne.Err == strconv.ErrRange {
			return f
		}
		return math.NaN()
	}
	return f
}

// parseIntJS is JavaScript parseInt(String(v), 10). NaN when no digits.
func parseIntJS(v any) float64 {
	var s string
	if f, ok := toF(v); ok {
		s = numToString(f)
	} else {
		s = jsString(v)
	}
	s = strings.TrimLeftFunc(s, isJSWhite)
	neg := false
	if s != "" && (s[0] == '+' || s[0] == '-') {
		neg = s[0] == '-'
		s = s[1:]
	}
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == 0 {
		return math.NaN()
	}
	f, _ := strconv.ParseFloat(s[:i], 64)
	if neg {
		f = -f
	}
	return f
}

// parseIntOr is `parseInt(x, 10) || def`.
func parseIntOr(v any, def float64) float64 {
	n := parseIntJS(v)
	if math.IsNaN(n) || n == 0 {
		return def
	}
	return n
}

func isFinite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

// numberIsFinite is Number.isFinite(v): true only for finite numbers.
func numberIsFinite(v any) bool {
	f, ok := toF(v)
	return ok && isFinite(f)
}

// jsRound is Math.round: halves round toward +Infinity.
func jsRound(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return x
	}
	r := math.Floor(x)
	if x-r >= 0.5 {
		r++
	}
	if r == 0 {
		return 0 // never -0: JSON would differ only in Go
	}
	return r
}

func jsRoundTo(x float64, factor float64) float64 { return jsRound(x*factor) / factor }

// toFixed is Number.prototype.toFixed(digits): exact decimal value of the
// double, ties rounded away from zero ("pick the larger n").
func toFixed(x float64, digits int) string {
	if math.IsNaN(x) {
		return "NaN"
	}
	if math.Abs(x) >= 1e21 {
		return numToString(x)
	}
	neg := x < 0
	if neg {
		x = -x
	}
	r := new(big.Rat).SetFloat64(x)
	scale := new(big.Rat).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(digits)), nil))
	r.Mul(r, scale)
	r.Add(r, big.NewRat(1, 2))
	n := new(big.Int).Quo(r.Num(), r.Denom()) // floor for non-negative
	s := n.String()
	if digits > 0 {
		for len(s) <= digits {
			s = "0" + s
		}
		s = s[:len(s)-digits] + "." + s[len(s)-digits:]
	}
	if neg { // the spec keeps the sign even when the digits round to zero
		s = "-" + s
	}
	return s
}

// numToString is JavaScript Number::toString (also JSON number output).
func numToString(f float64) string {
	if math.IsNaN(f) {
		return "NaN"
	}
	if math.IsInf(f, 1) {
		return "Infinity"
	}
	if math.IsInf(f, -1) {
		return "-Infinity"
	}
	if f == 0 {
		return "0"
	}
	sign := ""
	if f < 0 {
		sign = "-"
		f = -f
	}
	e := strconv.FormatFloat(f, 'e', -1, 64) // d.ddde±xx
	mant, expStr, _ := strings.Cut(e, "e")
	digits := strings.Replace(mant, ".", "", 1)
	exp, _ := strconv.Atoi(expStr)
	k := len(digits)
	n := exp + 1 // decimal point position
	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}
	es := "+"
	if n-1 < 0 {
		es = "-"
	}
	ex := n - 1
	if ex < 0 {
		ex = -ex
	}
	if k == 1 {
		return sign + digits + "e" + es + strconv.Itoa(ex)
	}
	return sign + digits[:1] + "." + digits[1:] + "e" + es + strconv.Itoa(ex)
}

// jsString is JavaScript String(v).
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case undefinedT:
		return "undefined"
	case bool:
		if x {
			return "true"
		}
		return "false"
	case string:
		return x
	case float64:
		return numToString(x)
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if isNullish(e) {
				parts[i] = ""
			} else {
				parts[i] = jsString(e)
			}
		}
		return strings.Join(parts, ",")
	case []string:
		return strings.Join(x, ",")
	case *Obj:
		return "[object Object]"
	}
	return "[object Object]"
}

// strOr is `String(v || def)`.
func strOr(v any, def string) string {
	if truthy(v) {
		return jsString(v)
	}
	return def
}

func padStart(s string, n int, pad string) string {
	for utf8.RuneCountInString(s) < n {
		s = pad + s
	}
	return s
}

func pad2(n int) string {
	if n < 0 {
		return "-" + padStart(strconv.Itoa(-n), 1, "0")
	}
	return padStart(strconv.Itoa(n), 2, "0")
}

// ---------------------------------------------------------------------------
// JSON.stringify

// JSMarshaler lets a typed value write its own JSON (as JSON.stringify would
// produce it for the equivalent plain object).
type JSMarshaler interface {
	WriteJSON(b *bytes.Buffer)
}

func toJSON(v any) []byte {
	var b bytes.Buffer
	writeJSON(&b, v)
	return b.Bytes()
}

func writeJSON(b *bytes.Buffer, v any) {
	switch x := v.(type) {
	case nil, undefinedT:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			b.WriteString("null")
		} else {
			b.WriteString(numToString(x))
		}
	case int:
		b.WriteString(strconv.Itoa(x))
	case int64:
		b.WriteString(strconv.FormatInt(x, 10))
	case string:
		writeJSONString(b, x)
	case *Obj:
		if x == nil {
			b.WriteString("null")
			return
		}
		b.WriteByte('{')
		first := true
		x.each(func(k string, val any) {
			if isUndef(val) {
				return
			}
			if !first {
				b.WriteByte(',')
			}
			first = false
			writeJSONString(b, k)
			b.WriteByte(':')
			writeJSON(b, val)
		})
		b.WriteByte('}')
	case []any:
		if x == nil {
			b.WriteString("[]")
			return
		}
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			writeJSON(b, e)
		}
		b.WriteByte(']')
	case []string:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			writeJSONString(b, e)
		}
		b.WriteByte(']')
	case []float64:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			writeJSON(b, e)
		}
		b.WriteByte(']')
	case []int:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(strconv.Itoa(e))
		}
		b.WriteByte(']')
	case [][]float64:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			writeJSON(b, e)
		}
		b.WriteByte(']')
	case []*Obj:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			writeJSON(b, e)
		}
		b.WriteByte(']')
	case JSMarshaler:
		x.WriteJSON(b)
	case rawJSON:
		b.Write(x)
	default:
		panic("writeJSON: unsupported type")
	}
}

// rawJSON is already-serialized JSON, inserted verbatim.
type rawJSON []byte

const hexDigits = "0123456789abcdef"

// writeJSONString escapes like JSON.stringify (QuoteJSONString): only the
// quote, backslash, control characters and lone surrogates.
func writeJSONString(b *bytes.Buffer, s string) {
	b.WriteByte('"')
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			switch c {
			case '"':
				b.WriteString(`\"`)
			case '\\':
				b.WriteString(`\\`)
			case '\b':
				b.WriteString(`\b`)
			case '\f':
				b.WriteString(`\f`)
			case '\n':
				b.WriteString(`\n`)
			case '\r':
				b.WriteString(`\r`)
			case '\t':
				b.WriteString(`\t`)
			default:
				if c < 0x20 {
					b.WriteString(`\u00`)
					b.WriteByte(hexDigits[c>>4])
					b.WriteByte(hexDigits[c&0xf])
				} else {
					b.WriteByte(c)
				}
			}
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			// Invalid UTF-8 cannot come from a JavaScript string; emit U+FFFD
			// as Node's decoder would have.
			b.WriteString("�")
		} else {
			b.WriteString(s[i : i+size])
		}
		i += size
	}
	b.WriteByte('"')
}

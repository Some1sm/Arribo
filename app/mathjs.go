package main

// Transcendental functions as V8 computes them. Kept behind one seam so the
// differential harness can measure (and, if needed, replace with an fdlibm
// port) any last-bit disagreement with Node.

import (
	"bytes"
	"math"
	"regexp"
	"strings"
	"time"
)

func jsSin(x float64) float64      { return math.Sin(x) }
func jsCos(x float64) float64      { return math.Cos(x) }
func jsAtan2(y, x float64) float64 { return math.Atan2(y, x) }
func jsExp(x float64) float64      { return math.Exp(x) }

// jsPow is Math.pow / **. y == 2 is exact multiplication in V8.
func jsPow(x, y float64) float64 {
	if y == 2 {
		return x * x
	}
	if y == 1 {
		return x
	}
	if y == 0 {
		return 1
	}
	return math.Pow(x, y)
}

// ---------------------------------------------------------------------------
// Date

// JSDate is a JavaScript Date. Ms is NaN for an Invalid Date.
type JSDate struct{ Ms float64 }

func (d JSDate) Valid() bool { return !math.IsNaN(d.Ms) }

func (d JSDate) WriteJSON(b *bytes.Buffer) {
	if !d.Valid() {
		b.WriteString("null")
		return
	}
	writeJSONString(b, isoString(int64(d.Ms)))
}

func (d JSDate) ms() int64 { return int64(d.Ms) }

func dateNow() JSDate { return JSDate{float64(nowMs())} }

func timeClip(t float64) float64 {
	if !isFinite(t) || math.Abs(t) > 8.64e15 {
		return math.NaN()
	}
	return math.Trunc(t) + 0 // +0 turns -0 into 0
}

// newDate is `new Date(v)` with one argument.
func newDate(v any) JSDate {
	switch x := v.(type) {
	case JSDate:
		return x
	case *JSDate:
		return *x
	case string:
		if ms, ok := parseDateJS(x); ok {
			return JSDate{float64(ms)}
		}
		return JSDate{math.NaN()}
	case nil:
		return JSDate{0}
	case undefinedT:
		return JSDate{math.NaN()}
	case bool:
		if x {
			return JSDate{1}
		}
		return JSDate{0}
	}
	return JSDate{timeClip(jsNumber(v))}
}

func dateFromMs(ms int64) JSDate { return JSDate{float64(ms)} }

var _ = time.Now

// ---------------------------------------------------------------------------
// JavaScript regular-expression whitespace.

// jsWS is the character class JavaScript's \s matches.
const jsWS = `[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`
const jsNotWS = `[^\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

// jsRe compiles a pattern written with JavaScript's \s / \S meaning.
func jsRe(p string) *regexp.Regexp {
	var b strings.Builder
	inClass := false
	for i := 0; i < len(p); i++ {
		c := p[i]
		if c == '\\' && i+1 < len(p) {
			n := p[i+1]
			switch {
			case n == 's' && !inClass:
				b.WriteString(jsWS)
			case n == 'S' && !inClass:
				b.WriteString(jsNotWS)
			case n == 's' && inClass:
				b.WriteString(jsWS[1 : len(jsWS)-1])
			default:
				b.WriteByte(c)
				b.WriteByte(n)
			}
			i++
			continue
		}
		if c == '[' {
			inClass = true
		} else if c == ']' {
			inClass = false
		}
		b.WriteByte(c)
	}
	return regexp.MustCompile(b.String())
}

package main

// JavaScript Map semantics and a few string/regex helpers the tracker needs.
// A Map keeps pure insertion order (unlike an object, whose integer-like keys
// sort first), and re-setting a key keeps its position.

import (
	"regexp"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

type JSMap struct {
	keys []string
	vals map[string]any
}

func newJSMap() *JSMap { return &JSMap{vals: map[string]any{}} }

func (m *JSMap) Set(k string, v any) {
	if _, ok := m.vals[k]; !ok {
		m.keys = append(m.keys, k)
	}
	m.vals[k] = v
}

func (m *JSMap) Get(k string) (any, bool) {
	v, ok := m.vals[k]
	return v, ok
}

func (m *JSMap) Has(k string) bool {
	_, ok := m.vals[k]
	return ok
}

func (m *JSMap) Delete(k string) bool {
	if _, ok := m.vals[k]; !ok {
		return false
	}
	delete(m.vals, k)
	for i, key := range m.keys {
		if key == k {
			m.keys = append(m.keys[:i:i], m.keys[i+1:]...)
			break
		}
	}
	return true
}

func (m *JSMap) Len() int { return len(m.keys) }

// Keys returns a snapshot of the keys in insertion order. Iterating a snapshot
// while deleting matches JavaScript's Map iteration for the deletions the
// tracker performs (it only ever deletes the entry being visited or earlier).
func (m *JSMap) Keys() []string { return append([]string(nil), m.keys...) }

func (m *JSMap) Clear() {
	m.keys = nil
	m.vals = map[string]any{}
}

// deepClone is structuredClone for the JSON-like values that cross between the
// worker and server worlds.
func deepClone(v any) any {
	switch x := v.(type) {
	case *Obj:
		if x == nil {
			return x
		}
		// Same insertion order as x.
		c := &Obj{kvs: make([]objKV, len(x.kvs)), nIdx: x.nIdx}
		for i, e := range x.kvs {
			c.kvs[i] = objKV{e.k, deepClone(e.v)}
		}
		c.buildIndex()
		return c
	case []any:
		if x == nil {
			return x
		}
		c := make([]any, len(x))
		for i, e := range x {
			c[i] = deepClone(e)
		}
		return c
	case []*Obj:
		c := make([]*Obj, len(x))
		for i, e := range x {
			c[i], _ = deepClone(e).(*Obj)
		}
		return c
	case []string:
		return append([]string(nil), x...)
	}
	return v
}

// jsonRoundTrip is JSON.parse(JSON.stringify(v)).
func jsonRoundTrip(v any) any {
	out, err := parseJSON(toJSON(v))
	if err != nil {
		return nil
	}
	return out
}

// stripMarks is s.normalize('NFD').replace(/[̀-ͯ]/g, ”).
func stripMarks(s string) string {
	s = norm.NFD.String(s)
	return strings.Map(func(r rune) rune {
		if r >= 0x300 && r <= 0x36f {
			return -1
		}
		return r
	}, s)
}

// foldSafe prepares text for a regexp compiled with (?i). JavaScript's
// case-insensitive matching (without the u flag) never lets a non-ASCII
// character match an ASCII letter, but Go's Unicode folding lets U+017F (long
// s) match "s" and U+212A (Kelvin sign) match "k". Each is swapped for a
// character of the same UTF-8 length that folds to nothing in our patterns, so
// match offsets still index the original string.
func foldSafe(s string) string {
	if !strings.ContainsRune(s, 0x17F) && !strings.ContainsRune(s, 0x212A) {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch r {
		case 0x17F:
			b.WriteRune(0x1A1) // same 2-byte length
		case 0x212A:
			b.WriteRune(0x2100) // same 3-byte length
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// reTestI is /re/i.test(s) for a pattern compiled with (?i).
func reTestI(re *regexp.Regexp, s string) bool { return re.MatchString(foldSafe(s)) }

// reMatchI is s.match(/re/i) (no g flag) for a pattern compiled with (?i):
// the submatches as strings, "" with ok=false for a group that did not take
// part. Returns nil when there is no match.
type reMatch struct {
	groups []string
	set    []bool
	start  int
	end    int
}

func (m *reMatch) g(i int) string { return m.groups[i] }
func (m *reMatch) has(i int) bool { return m.set[i] }

func reFind(re *regexp.Regexp, s string, insensitive bool) *reMatch {
	probe := s
	if insensitive {
		probe = foldSafe(s)
	}
	idx := re.FindStringSubmatchIndex(probe)
	if idx == nil {
		return nil
	}
	return makeMatch(s, idx)
}

func reFindAll(re *regexp.Regexp, s string, insensitive bool) []*reMatch {
	probe := s
	if insensitive {
		probe = foldSafe(s)
	}
	var out []*reMatch
	for _, idx := range re.FindAllStringSubmatchIndex(probe, -1) {
		out = append(out, makeMatch(s, idx))
	}
	return out
}

func makeMatch(s string, idx []int) *reMatch {
	n := len(idx) / 2
	m := &reMatch{groups: make([]string, n), set: make([]bool, n), start: idx[0], end: idx[1]}
	for i := 0; i < n; i++ {
		if idx[2*i] >= 0 {
			m.groups[i] = s[idx[2*i]:idx[2*i+1]]
			m.set[i] = true
		}
	}
	return m
}

// reReplaceAll is s.replace(/re/g, repl) with a literal replacement.
func reReplaceAll(re *regexp.Regexp, s, repl string, insensitive bool) string {
	if !insensitive {
		return re.ReplaceAllLiteralString(s, repl)
	}
	probe := foldSafe(s)
	var b strings.Builder
	last := 0
	for _, idx := range re.FindAllStringIndex(probe, -1) {
		b.WriteString(s[last:idx[0]])
		b.WriteString(repl)
		last = idx[1]
	}
	b.WriteString(s[last:])
	return b.String()
}

// reReplaceFirst is s.replace(/re/, repl) (no g flag) with a literal replacement.
func reReplaceFirst(re *regexp.Regexp, s, repl string, insensitive bool) string {
	probe := s
	if insensitive {
		probe = foldSafe(s)
	}
	idx := re.FindStringIndex(probe)
	if idx == nil {
		return s
	}
	return s[:idx[0]] + repl + s[idx[1]:]
}

// jsSplitRe is s.split(re) where re may hold capture groups: JavaScript puts
// each match's captures between the pieces (undefined for a group that did
// not take part). Our patterns never match the empty string.
func jsSplitRe(re *regexp.Regexp, s string, insensitive bool) []any {
	probe := s
	if insensitive {
		probe = foldSafe(s)
	}
	var out []any
	last := 0
	for _, idx := range re.FindAllStringSubmatchIndex(probe, -1) {
		if idx[1] == idx[0] {
			continue
		}
		out = append(out, s[last:idx[0]])
		for g := 1; g < len(idx)/2; g++ {
			if idx[2*g] >= 0 {
				out = append(out, s[idx[2*g]:idx[2*g+1]])
			} else {
				out = append(out, Undefined)
			}
		}
		last = idx[1]
	}
	out = append(out, s[last:])
	return out
}

// jsSplitStrings is jsSplitRe for a pattern without capture groups.
func jsSplitStrings(re *regexp.Regexp, s string, insensitive bool) []string {
	parts := jsSplitRe(re, s, insensitive)
	out := make([]string, len(parts))
	for i, p := range parts {
		out[i], _ = p.(string)
	}
	return out
}

// decodeRuneAt returns the rune at byte offset i (utf8.RuneError, 0 at the end).
func decodeRuneAt(s string, i int) (rune, int) {
	if i >= len(s) {
		return utf8.RuneError, 0
	}
	return utf8.DecodeRuneInString(s[i:])
}

func isASCIIWord(b byte) bool {
	return b == '_' || (b >= '0' && b <= '9') || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

// jsWordBoundary is \b at byte offset i (ASCII word characters, as in a
// JavaScript regexp without the u flag; a non-ASCII byte is never a word char).
func jsWordBoundary(s string, i int) bool {
	before := i > 0 && isASCIIWord(s[i-1])
	after := i < len(s) && isASCIIWord(s[i])
	return before != after
}

// jsIncludesStr is String.prototype.includes.
func jsIncludesStr(s, sub string) bool { return strings.Contains(s, sub) }

// stringsSortedUnique keeps first-seen order (Array.from(new Set(xs))).
func uniqueStrings(xs []string) []string {
	seen := make(map[string]bool, len(xs))
	out := make([]string, 0, len(xs))
	for _, x := range xs {
		if !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}

func stringsToAny(xs []string) []any {
	out := make([]any, len(xs))
	for i, x := range xs {
		out[i] = x
	}
	return out
}

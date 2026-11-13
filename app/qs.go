package main

// Port of qs 6.16.2 parse() with the options Express 4.22 passes for its
// default "extended" query parser: { allowPrototypes: true, arrayLimit: 1000 }
// (depth 5, parameterLimit 1000, duplicates 'combine', strictMerge true).
// req.query values are therefore strings, arrays ([]any) and objects (*Obj),
// exactly as the handlers in server.js see them.

import (
	"math"
	"regexp"
	"strings"
	"unicode/utf8"
)

const qsArrayLimit = 1000
const qsParameterLimit = 1000
const qsDepth = 5

// qsArr is a JavaScript array while parsing: it can have holes.
type qsArr struct {
	v       []any
	present []bool
}

func (a *qsArr) set(i int, x any) {
	for len(a.v) <= i {
		a.v = append(a.v, nil)
		a.present = append(a.present, false)
	}
	a.v[i] = x
	a.present[i] = true
}

func (a *qsArr) push(x any) {
	a.v = append(a.v, x)
	a.present = append(a.present, true)
}

// appendConcat is one argument of Array.prototype.concat: an array's
// elements (holes kept), or the value itself.
func (a *qsArr) appendConcat(x any) {
	if arr, ok := x.(*qsArr); ok {
		a.v = append(a.v, arr.v...)
		a.present = append(a.present, arr.present...)
		return
	}
	a.push(x)
}

// qsParser holds qs's side channels (overflow and conflict marks).
type qsParser struct {
	overflow map[any]float64
	conflict map[any]float64
}

func isQsContainer(v any) bool {
	switch v.(type) {
	case *Obj, *qsArr:
		return true
	}
	return false
}

func qsTruthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case string:
		return x != ""
	case undefinedT:
		return false
	}
	return true
}

func (p *qsParser) isOverflow(v any) bool {
	if o, ok := v.(*Obj); ok {
		_, has := p.overflow[o]
		return has
	}
	return false
}

func (p *qsParser) isConflict(v any) bool {
	switch v.(type) {
	case *Obj, *qsArr:
		_, has := p.conflict[v]
		return has
	}
	return false
}

func (p *qsParser) markOverflow(o *Obj, max float64) *Obj {
	p.overflow[o] = max
	return o
}

func (p *qsParser) arrayToObject(a *qsArr) *Obj {
	o := O()
	for i, x := range a.v {
		if a.present[i] && !isUndef(x) {
			o.Set(itoa(i), x)
		}
	}
	return o
}

func (p *qsParser) limitedPair(first, second any) any {
	pair := &qsArr{}
	pair.push(first)
	pair.push(second)
	if 2 > qsArrayLimit {
		return p.markOverflow(p.arrayToObject(pair), 1)
	}
	return pair
}

func maxNumericIndex(o *Obj, min float64) float64 {
	max := min
	for _, k := range o.Keys() {
		n := parseIntJS(k)
		if numToString(n) == k && n > max {
			max = n
		}
	}
	return max
}

// qsKeys is Object.keys for a parse value.
func qsKeys(v any) []string {
	switch x := v.(type) {
	case *Obj:
		return x.Keys()
	case *qsArr:
		var ks []string
		for i := range x.v {
			if x.present[i] {
				ks = append(ks, itoa(i))
			}
		}
		return ks
	}
	return nil
}

func qsGet(v any, k string) any {
	switch x := v.(type) {
	case *Obj:
		return x.Get(k)
	case *qsArr:
		i := int(parseIntJS(k))
		if i >= 0 && i < len(x.v) && x.present[i] {
			return x.v[i]
		}
	}
	return Undefined
}

func (p *qsParser) combine(a, b any) any {
	if ao, ok := a.(*Obj); ok && p.isOverflow(ao) {
		var bValues []any
		var bPresent []bool
		if ba, ok := b.(*qsArr); ok {
			bValues, bPresent = ba.v, ba.present
		} else {
			bValues, bPresent = []any{b}, []bool{true}
		}
		newIndex := p.overflow[ao]
		for i := range bValues {
			newIndex++
			if bPresent[i] {
				ao.Set(numToString(newIndex), bValues[i])
			} else {
				ao.Set(numToString(newIndex), Undefined)
			}
		}
		p.overflow[ao] = newIndex
		return ao
	}
	result := &qsArr{}
	result.appendConcat(a)
	result.appendConcat(b)
	if len(result.v) > qsArrayLimit {
		return p.markOverflow(p.arrayToObject(result), float64(len(result.v)-1))
	}
	return result
}

func (p *qsParser) merge(target, source any) any {
	if !qsTruthy(source) {
		return target
	}
	if !isQsContainer(source) {
		switch t := target.(type) {
		case *qsArr:
			next := len(t.v)
			if next >= qsArrayLimit {
				all := &qsArr{}
				all.appendConcat(t)
				all.appendConcat(source)
				return p.markOverflow(p.arrayToObject(all), float64(next))
			}
			t.set(next, source)
		case *Obj:
			if p.isOverflow(t) {
				newIndex := p.overflow[t] + 1
				t.Set(numToString(newIndex), source)
				p.overflow[t] = newIndex
			} else if p.isConflict(t) {
				next := p.conflict[t] + 1
				t.Set(numToString(next), source)
				p.conflict[t] = next
			} else {
				pair := p.limitedPair(t, source)
				if arr, ok := pair.(*qsArr); ok {
					p.conflict[arr] = 1
				}
				return pair
			}
		default:
			return p.limitedPair(target, source)
		}
		return target
	}

	if !isQsContainer(target) {
		if so, ok := source.(*Obj); ok && p.isOverflow(so) {
			result := O("0", target)
			for _, k := range so.Keys() {
				old := parseIntJS(k)
				result.Set(numToString(old+1), so.Get(k))
			}
			return p.markOverflow(result, p.overflow[so]+1)
		}
		combined := &qsArr{}
		combined.push(target)
		combined.appendConcat(source)
		if len(combined.v) > qsArrayLimit {
			return p.markOverflow(p.arrayToObject(combined), float64(len(combined.v)-1))
		}
		return combined
	}

	tArr, tIsArr := target.(*qsArr)
	sArr, sIsArr := source.(*qsArr)
	mergeTarget := target
	if tIsArr && !sIsArr {
		mt := p.arrayToObject(tArr)
		if p.isConflict(tArr) {
			p.conflict[mt] = float64(len(tArr.v) - 1)
		}
		mergeTarget = mt
	}
	if tIsArr && sIsArr {
		n := len(sArr.v)
		for i := 0; i < n; i++ {
			if !sArr.present[i] {
				continue
			}
			item := sArr.v[i]
			if i < len(tArr.v) && tArr.present[i] {
				ti := tArr.v[i]
				if isQsContainer(ti) && isQsContainer(item) {
					tArr.v[i] = p.merge(ti, item)
				} else {
					tArr.push(item)
				}
			} else {
				tArr.set(i, item)
			}
		}
		if len(tArr.v) > qsArrayLimit {
			return p.markOverflow(p.arrayToObject(tArr), float64(len(tArr.v)-1))
		}
		return tArr
	}

	acc := mergeTarget.(*Obj)
	for _, key := range qsKeys(source) {
		value := qsGet(source, key)
		if acc.Has(key) {
			acc.Set(key, p.merge(acc.Get(key), value))
		} else {
			acc.Set(key, value)
		}
		if p.isOverflow(source) && !p.isOverflow(acc) {
			p.overflow[acc] = maxNumericIndex(acc, p.overflow[source])
		}
		if p.isOverflow(acc) {
			n := parseIntJS(key)
			if numToString(n) == key && n >= 0 && n > p.overflow[acc] {
				p.overflow[acc] = n
			}
		}
		if p.isConflict(acc) {
			n := parseIntJS(key)
			if numToString(n) == key && n > p.conflict[acc] {
				p.conflict[acc] = n
			}
		}
	}
	return acc
}

// decodeURIComponentJS reports false where JavaScript throws URIError.
func decodeURIComponentJS(s string) (string, bool) {
	if !strings.Contains(s, "%") {
		return s, true
	}
	unhex := func(c byte) int {
		switch {
		case c >= '0' && c <= '9':
			return int(c - '0')
		case c >= 'a' && c <= 'f':
			return int(c-'a') + 10
		case c >= 'A' && c <= 'F':
			return int(c-'A') + 10
		}
		return -1
	}
	octet := func(i int) int {
		if i+2 >= len(s) || s[i] != '%' {
			return -1
		}
		h, l := unhex(s[i+1]), unhex(s[i+2])
		if h < 0 || l < 0 {
			return -1
		}
		return h<<4 | l
	}
	var b strings.Builder
	for i := 0; i < len(s); {
		if s[i] != '%' {
			b.WriteByte(s[i])
			i++
			continue
		}
		first := octet(i)
		if first < 0 {
			return "", false
		}
		i += 3
		if first < 0x80 {
			b.WriteByte(byte(first))
			continue
		}
		n := 0
		for m := 0x80; m != 0 && first&m != 0; m >>= 1 {
			n++
		}
		if n == 1 || n > 4 {
			return "", false
		}
		buf := []byte{byte(first)}
		for j := 1; j < n; j++ {
			o := octet(i)
			if o < 0 || o&0xC0 != 0x80 {
				return "", false
			}
			buf = append(buf, byte(o))
			i += 3
		}
		if !utf8.Valid(buf) {
			return "", false
		}
		b.Write(buf)
	}
	return b.String(), true
}

// qsDecode is qs's utils.decode for utf-8.
func qsDecode(s string) string {
	if !strings.Contains(s, "%") {
		if !strings.Contains(s, "+") {
			return s
		}
		return strings.ReplaceAll(s, "+", " ")
	}
	plain := strings.ReplaceAll(s, "+", " ")
	if d, ok := decodeURIComponentJS(plain); ok {
		return d
	}
	return plain
}

var reQsOpen = regexp.MustCompile(`(?i)%5B`)
var reQsClose = regexp.MustCompile(`(?i)%5D`)

func (p *qsParser) parseValues(str string) *Obj {
	obj := O()
	clean := reQsClose.ReplaceAllLiteralString(reQsOpen.ReplaceAllLiteralString(str, "["), "]")
	parts := strings.Split(clean, "&")
	if len(parts) > qsParameterLimit {
		parts = parts[:qsParameterLimit]
	}
	for _, part := range parts {
		bracketEqualsPos := strings.Index(part, "]=")
		pos := strings.Index(part, "=")
		if bracketEqualsPos != -1 {
			pos = bracketEqualsPos + 1
		}
		var key string
		var val any
		if pos == -1 {
			key = qsDecode(part)
			val = ""
		} else {
			key = qsDecode(part[:pos])
			val = qsDecode(part[pos+1:])
		}
		if obj.Has(key) {
			obj.Set(key, p.combine(obj.Get(key), val))
		} else {
			obj.Set(key, val)
		}
	}
	return obj
}

func qsSplitKey(key string) []string {
	var segs []string
	first := strings.Index(key, "[")
	parent := key
	if first >= 0 {
		parent = key[:first]
	}
	if parent != "" {
		segs = append(segs, parent)
	}
	n := len(key)
	open := first
	collected := 0
	for open >= 0 && collected < qsDepth {
		level := 1
		i := open + 1
		closeAt := -1
		for i < n && closeAt < 0 {
			switch key[i] {
			case '[':
				level++
			case ']':
				level--
				if level == 0 {
					closeAt = i
				}
			}
			i++
		}
		if closeAt < 0 {
			return append(segs, "["+key[open:]+"]")
		}
		segs = append(segs, key[open:closeAt+1])
		collected++
		next := strings.Index(key[closeAt+1:], "[")
		if next < 0 {
			open = -1
		} else {
			open = closeAt + 1 + next
		}
	}
	if open >= 0 {
		segs = append(segs, "["+key[open:]+"]")
	}
	return segs
}

func (p *qsParser) parseObject(chain []string, val any) any {
	leaf := val
	for i := len(chain) - 1; i >= 0; i-- {
		root := chain[i]
		var obj any
		if root == "[]" {
			if p.isOverflow(leaf) {
				obj = leaf
			} else {
				obj = p.combine(&qsArr{}, leaf)
			}
		} else {
			o := O()
			cleanRoot := root
			if len(root) >= 2 && root[0] == '[' && root[len(root)-1] == ']' {
				cleanRoot = root[1 : len(root)-1]
			}
			decodedRoot := cleanRoot
			index := parseIntJS(decodedRoot)
			valid := !math.IsNaN(index) && root != decodedRoot && numToString(index) == decodedRoot && index >= 0
			switch {
			case valid && index < qsArrayLimit:
				arr := &qsArr{}
				arr.set(int(index), leaf)
				obj = arr
			case valid:
				o.Set(numToString(index), leaf)
				p.markOverflow(o, index)
				obj = o
			default:
				if decodedRoot != "__proto__" {
					o.Set(decodedRoot, leaf)
				}
				obj = o
			}
		}
		leaf = obj
	}
	return leaf
}

func (p *qsParser) finalize(v any) any {
	switch x := v.(type) {
	case *qsArr:
		out := []any{}
		for i, e := range x.v {
			if x.present[i] && !isUndef(e) {
				out = append(out, p.finalize(e))
			}
		}
		return out
	case *Obj:
		for _, k := range x.Keys() {
			x.Set(k, p.finalize(x.Get(k)))
		}
		return x
	}
	return v
}

// parseQuery is req.query for the raw query string (after '?').
func parseQuery(str string) *Obj {
	if str == "" {
		return O()
	}
	p := &qsParser{overflow: map[any]float64{}, conflict: map[any]float64{}}
	temp := p.parseValues(str)
	var obj any = O()
	for _, key := range temp.Keys() {
		if key == "" {
			continue
		}
		newObj := p.parseObject(qsSplitKey(key), temp.Get(key))
		obj = p.merge(obj, newObj)
	}
	return p.finalize(obj).(*Obj)
}

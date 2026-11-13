package main

// JSON.parse into ordered JavaScript values (*Obj, []any, float64, string,
// bool, nil). encoding/json's maps lose key order, which JSON.stringify of a
// parsed-and-returned document would keep.
//
// Parsed documents are often kept (datasets, worker results in caches), so
// the parser stores them compactly; the values are the same either way:
//   - object keys and short strings are interned per document (every row of a
//     result repeats the same keys),
//   - small non-negative integers share one boxed float64 (boxedInts),
//   - arrays and objects are allocated at their final size from a scratch
//     stack, without append's spare capacity.

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strconv"
)

type jsonParser struct {
	dec    *json.Decoder
	intern map[string]string
	vals   []any   // scratch stack of array elements
	kvs    []objKV // scratch stack of object entries
}

// internMaxLen bounds interned string values: ids, codes and enum-like
// strings repeat; long free text rarely does.
const internMaxLen = 64

func parseJSON(b []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	p := &jsonParser{dec: dec, intern: map[string]string{}}
	v, err := p.value()
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("unexpected trailing data")
	}
	return v, nil
}

func (p *jsonParser) str(s string) string {
	if c, ok := p.intern[s]; ok {
		return c
	}
	p.intern[s] = s
	return s
}

func (p *jsonParser) value() (any, error) {
	tok, err := p.dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			base := len(p.kvs)
			for p.dec.More() {
				kt, err := p.dec.Token()
				if err != nil {
					return nil, err
				}
				k, ok := kt.(string)
				if !ok {
					return nil, errors.New("object key is not a string")
				}
				k = p.str(k)
				v, err := p.value()
				if err != nil {
					return nil, err
				}
				p.kvs = append(p.kvs, objKV{k, v})
			}
			if _, err := p.dec.Token(); err != nil {
				return nil, err
			}
			entries := p.kvs[base:]
			o := &Obj{kvs: make([]objKV, 0, len(entries))}
			for _, e := range entries {
				o.Set(e.k, e.v) // a repeated key keeps its first position and takes the last value
			}
			clear(entries)
			p.kvs = p.kvs[:base]
			return o, nil
		case '[':
			base := len(p.vals)
			for p.dec.More() {
				v, err := p.value()
				if err != nil {
					return nil, err
				}
				p.vals = append(p.vals, v)
			}
			if _, err := p.dec.Token(); err != nil {
				return nil, err
			}
			arr := make([]any, len(p.vals)-base)
			copy(arr, p.vals[base:])
			clear(p.vals[base:])
			p.vals = p.vals[:base]
			return arr, nil
		}
		return nil, errors.New("unexpected delimiter")
	case json.Number:
		f, err := strconv.ParseFloat(string(t), 64)
		if err != nil {
			if ne, ok := err.(*strconv.NumError); ok && ne.Err == strconv.ErrRange {
				return f, nil
			}
			return nil, err
		}
		return boxNumber(f), nil
	case string:
		if len(t) <= internMaxLen {
			return p.str(t), nil
		}
		return t, nil
	case bool, nil:
		return t, nil
	}
	return nil, errors.New("unexpected token")
}

// boxedInts holds float64(0..len-1) already boxed, so small integers stored
// as any share one allocation instead of eight bytes each.
var boxedInts = func() [1024]any {
	var t [1024]any
	for i := range t {
		t[i] = float64(i)
	}
	return t
}()

// boxNumber returns f as an any, shared for small non-negative integers
// (not -0, which must stay distinct).
func boxNumber(f float64) any {
	if f >= 0 && f < float64(len(boxedInts)) && f == math.Trunc(f) && !(f == 0 && math.Signbit(f)) {
		return boxedInts[int(f)]
	}
	return f
}

// canonNumber swaps a boxed small integer for its shared box (see boxNumber),
// so values kept in objects do not each hold their own allocation.
func canonNumber(v any) any {
	if f, ok := v.(float64); ok && f >= 0 && f < float64(len(boxedInts)) && f == math.Trunc(f) && !(f == 0 && math.Signbit(f)) {
		return boxedInts[int(f)]
	}
	return v
}

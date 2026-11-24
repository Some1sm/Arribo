package main

import (
	"net/url"
	"strings"
	"unicode/utf8"
)

const (
	maxQueryBytes  = 4096
	maxQueryParams = 64
)

// parseQuery parses flat query parameters with strict size and key-count caps.
// Repeated keys are kept as []any, matching Express's scalar/array convention
// without nested sparse-array allocation vectors.
func parseQuery(str string) *Obj {
	out := O()
	if str == "" {
		return out
	}
	if len(str) > maxQueryBytes {
		str = str[:maxQueryBytes]
	}
	if strings.HasPrefix(str, "?") {
		str = str[1:]
	}
	count := 0
	for len(str) > 0 && count < maxQueryParams {
		var part string
		if i := strings.IndexByte(str, '&'); i >= 0 {
			part = str[:i]
			str = str[i+1:]
		} else {
			part = str
			str = ""
		}
		if part == "" {
			continue
		}
		count++
		rawK, rawV := part, ""
		if eq := strings.IndexByte(part, '='); eq >= 0 {
			rawK = part[:eq]
			rawV = part[eq+1:]
		}
		k, err := url.QueryUnescape(rawK)
		if err != nil {
			k = rawK
		}
		v, err := url.QueryUnescape(rawV)
		if err != nil {
			v = rawV
		}
		if !out.Has(k) {
			out.Set(k, v)
		} else if list, ok := out.Get(k).([]any); ok {
			out.Set(k, append(list, v))
		} else {
			out.Set(k, []any{out.Get(k), v})
		}
	}
	return out
}

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

package main

// String.prototype.toUpperCase / toLowerCase (root locale). Go's unicode
// tables are an older Unicode version and have no multi-rune mappings, so
// every code point where V8 differs is listed in jscase_table.go, generated
// from the Node release the app ran on. toLowerCase's one context rule,
// Final_Sigma, is applied here.

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

func jsUpper(s string) string {
	ascii := true
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			ascii = false
			break
		}
	}
	if ascii {
		return strings.ToUpper(s)
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		r, n := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && n <= 1 {
			b.WriteByte(s[i])
			i++
			continue
		}
		if m, ok := jsUpperTable[r]; ok {
			b.WriteString(m)
		} else {
			b.WriteRune(unicode.ToUpper(r))
		}
		i += n
	}
	return b.String()
}

func jsLower(s string) string {
	ascii := true
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			ascii = false
			break
		}
	}
	if ascii {
		return strings.ToLower(s)
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		r, n := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && n <= 1 {
			b.WriteByte(s[i])
			i++
			continue
		}
		switch {
		case r == 0x03A3:
			if finalSigma(s, i, n) {
				b.WriteRune(0x03C2)
			} else {
				b.WriteRune(0x03C3)
			}
		default:
			if m, ok := jsLowerTable[r]; ok {
				b.WriteString(m)
			} else {
				b.WriteRune(unicode.ToLower(r))
			}
		}
		i += n
	}
	return b.String()
}

// finalSigma: a cased letter (then case-ignorables) before, and no cased
// letter (after case-ignorables) following.
func finalSigma(s string, i, n int) bool {
	before := false
	for j := i; j > 0; {
		r, sz := utf8.DecodeLastRuneInString(s[:j])
		j -= sz
		if caseIgnorable(r) {
			continue
		}
		before = isCased(r)
		break
	}
	if !before {
		return false
	}
	for j := i + n; j < len(s); {
		r, sz := utf8.DecodeRuneInString(s[j:])
		j += sz
		if caseIgnorable(r) {
			continue
		}
		return !isCased(r)
	}
	return true
}

func isCased(r rune) bool {
	return unicode.IsUpper(r) || unicode.IsLower(r) || unicode.IsTitle(r) ||
		unicode.Is(unicode.Other_Lowercase, r) || unicode.Is(unicode.Other_Uppercase, r)
}

func caseIgnorable(r rune) bool {
	switch r {
	case '\'', '.', ':', '^', '`', 0x00B7, 0x0387, 0x055F, 0x05F4, 0x2018, 0x2019, 0x2024, 0x2027,
		0xFE13, 0xFE52, 0xFE55, 0xFF07, 0xFF0E, 0xFF1A:
		return true
	}
	return unicode.In(r, unicode.Mn, unicode.Me, unicode.Cf, unicode.Lm, unicode.Sk)
}

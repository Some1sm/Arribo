package main

// The part of scripts/scrape_maresme_timetables.js the worker's nightly
// drift check runs: scrapeSeasons and diffAgainstShipped. Only the fields
// the diff compares are built (schedules, dayStopTravelSec, dayTrips for
// the three day types); the stop-name notes are informational and dropped.
// Where the script would throw a TypeError on malformed input, this returns
// an error, which the drift check treats the same way.

import (
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

func scraperOutputPath() string { return filepath.Join(srcDataDir(), "mataro_schedules.seasons.json") }
func scraperCurrentPath() string { return filepath.Join(srcDataDir(), "mataro_schedules.json") }

const scraperUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

var errTypeError = errors.New("Cannot read properties of undefined")

// fetchTimetablePage downloads a page and decodes it as ISO-8859-1.
func fetchTimetablePage(u string) (string, error) {
	for hops := 0; hops < 20; hops++ {
		pu, err := url.Parse(u)
		if err != nil {
			return "", err
		}
		client := nodeRequestClient(pu.Hostname(), srcDataDir(), 30*time.Second)
		req, err := http.NewRequest("GET", u, nil)
		if err != nil {
			return "", err
		}
		req.Header.Set("User-Agent", scraperUserAgent)
		res, err := client.Do(req)
		if err != nil {
			return "", err
		}
		if loc := res.Header.Get("Location"); res.StatusCode >= 300 && res.StatusCode < 400 && loc != "" {
			res.Body.Close()
			next, err := pu.Parse(loc)
			if err != nil {
				return "", err
			}
			u = next.String()
			continue
		}
		if res.StatusCode != 200 {
			res.Body.Close()
			return "", errors.New("HTTP " + strconv.Itoa(res.StatusCode) + " for " + u)
		}
		b, err := io.ReadAll(res.Body)
		res.Body.Close()
		if err != nil {
			return "", err
		}
		r := make([]rune, len(b))
		for i, c := range b {
			r[i] = rune(c)
		}
		return string(r), nil
	}
	return "", errors.New("too many redirects for " + u)
}

var scraperEntities = map[string]string{
	"&aacute;": "á", "&eacute;": "é", "&egrave;": "è", "&agrave;": "à", "&iacute;": "í",
	"&oacute;": "ó", "&ograve;": "ò", "&uacute;": "ú", "&ntilde;": "ñ", "&ccedil;": "ç",
	"&Aacute;": "Á", "&Eacute;": "É", "&Iacute;": "Í", "&Oacute;": "Ó", "&Uacute;": "Ú",
	"&nbsp;": " ", "&middot;": "·", "&ocute;": "ó", "&quot;": "\"", "&amp;": "&",
}

var (
	reEntity      = regexp.MustCompile(`&[a-zA-Z]+;|&#\d+;`)
	reNumEntity   = regexp.MustCompile(`^&#(\d+);$`)
	reTag         = regexp.MustCompile(`<[^>]+>`)
	reIsTime      = regexp.MustCompile(`^\d{1,2}:\d{2}$`)
	reSlotArray   = regexp.MustCompile(`\bs(\d\d)([abc])\s*=\s*new Array\(([^)]*)\)`)
	reQuoted      = regexp.MustCompile(`^'(.*)'$`)
	reFirstOrigin = regexp.MustCompile(`(?i)<td colspan="2" class="tc">[\s\S]*?</select></td>\s*<td colspan="4">([^<]*)</td>`)
)

func decodeEntities(s string) string {
	return reEntity.ReplaceAllStringFunc(s, func(m string) string {
		if v, ok := scraperEntities[m]; ok {
			return v
		}
		if n := reNumEntity.FindStringSubmatch(m); n != nil {
			x, _ := strconv.ParseFloat(n[1], 64)
			return string(rune(uint16(math.Mod(x, 65536))))
		}
		return m
	})
}

func stripTagsText(s string) string { return jsTrim(decodeEntities(reTag.ReplaceAllString(s, ""))) }

func scrapeToSec(v any) float64 {
	s, ok := v.(string)
	if !ok || !reIsTime.MatchString(s) {
		return nan
	}
	p := strings.SplitN(s, ":", 2)
	h, _ := strconv.Atoi(p[0])
	m, _ := strconv.Atoi(p[1])
	return float64(h*3600 + m*60)
}

// parseSlotArrays: column -> slot (a/b/c) -> cells, kept in place.
func parseSlotArrays(html string) map[string]map[string][]string {
	cols := map[string]map[string][]string{}
	for _, m := range reSlotArray.FindAllStringSubmatch(html, -1) {
		col := m[1]
		if cols[col] == nil {
			cols[col] = map[string][]string{}
		}
		parts := strings.Split(m[3], ",")
		for i, x := range parts {
			parts[i] = reQuoted.ReplaceAllString(jsTrim(x), "$1")
		}
		cols[col][m[2]] = parts
	}
	return cols
}

func parseFirstOriginName(html string) any {
	m := reFirstOrigin.FindStringSubmatch(html)
	if m == nil {
		return nil
	}
	return stripTagsText(m[1])
}

func normName(v any) string {
	s := ""
	if truthy(v) {
		s = jsString(v)
	}
	s = stripMarks(s)
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r + 32)
		}
	}
	return b.String()
}

func medianOffsetSec(from, to []string) any {
	n := len(from)
	if len(to) < n {
		n = len(to)
	}
	var diffs []float64
	for i := 0; i < n; i++ {
		a, b := scrapeToSec(from[i]), scrapeToSec(to[i])
		if isFinite(a) && isFinite(b) {
			d := b - a
			if d < -43200 {
				d += 86400
			}
			diffs = append(diffs, d)
		}
	}
	if len(diffs) == 0 {
		return nil
	}
	sort.Float64s(diffs)
	mid := len(diffs) >> 1
	if len(diffs)%2 == 1 {
		return diffs[mid]
	}
	return jsRound((diffs[mid-1] + diffs[mid]) / 2)
}

func directionsOf(line *Obj) (*Obj, error) {
	if line == nil {
		return nil, errTypeError
	}
	d, ok := line.Get("directions").(*Obj)
	if !ok {
		return nil, errTypeError
	}
	return d, nil
}

func realDirectionKeys(line *Obj) ([]string, error) {
	dirs, err := directionsOf(line)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, k := range dirs.Keys() {
		if k == "21" {
			continue
		}
		d, _ := dirs.Get(k).(*Obj)
		if d != nil && truthy(d.Get("_invalid")) {
			continue
		}
		if d == nil && dirs.Get(k) == nil {
			return nil, errTypeError
		}
		out = append(out, k)
	}
	return out, nil
}

func stopsOf(dir *Obj) ([]any, error) {
	if dir == nil {
		return nil, errTypeError
	}
	s, ok := dir.Get("stops").([]any)
	if !ok {
		return nil, errTypeError
	}
	return s, nil
}

type scrapeBlocks struct {
	offsets map[string]int
	order   []string
	err     string
}

func resolveBlocks(line *Obj, colCount int, firstOrigin any) (scrapeBlocks, error) {
	keys, err := realDirectionKeys(line)
	if err != nil {
		return scrapeBlocks{}, err
	}
	if len(keys) != 2 {
		return scrapeBlocks{err: "expected 2 real directions, found " + itoa(len(keys))}, nil
	}
	dirs, _ := directionsOf(line)
	a, b := keys[0], keys[1]
	da, _ := dirs.Get(a).(*Obj)
	db, _ := dirs.Get(b).(*Obj)
	sa, err := stopsOf(da)
	if err != nil {
		return scrapeBlocks{}, err
	}
	sb, err := stopsOf(db)
	if err != nil {
		return scrapeBlocks{}, err
	}
	counts := map[string]int{a: len(sa), b: len(sb)}
	if colCount != counts[a]+counts[b] {
		return scrapeBlocks{err: "column count " + itoa(colCount) + " != " + itoa(counts[a]) + " + " + itoa(counts[b]) + " stops"}, nil
	}
	originName := func(d *Obj) (any, error) {
		o, ok := d.Get("originStop").(*Obj)
		if !ok {
			return nil, errTypeError
		}
		return o.Get("name"), nil
	}
	na, err := originName(da)
	if err != nil {
		return scrapeBlocks{}, err
	}
	target := normName(firstOrigin)
	first := ""
	if normName(na) == target {
		first = a
	} else {
		nb, err := originName(db)
		if err != nil {
			return scrapeBlocks{}, err
		}
		if normName(nb) == target {
			first = b
		} else {
			return scrapeBlocks{err: "header origin \"" + jsString(firstOrigin) + "\" matches neither direction (" +
				a + "=" + jsString(na) + ", " + b + "=" + jsString(nb) + ")"}, nil
		}
	}
	second := a
	if first == a {
		second = b
	}
	return scrapeBlocks{offsets: map[string]int{first: 0, second: counts[first]}, order: []string{first, second}}, nil
}

func scrapeToTimeStr(sec float64) string {
	s := math.Mod(math.Mod(sec, 86400)+86400, 86400)
	h := math.Floor(s / 3600)
	m := math.Floor(math.Mod(s, 3600) / 60)
	return pad2f(h) + ":" + pad2f(m)
}

func colPad(n int) string { return padStart(itoa(n), 2, "0") }

var scrapeDays = []struct{ slot, day string }{{"a", "weekday"}, {"b", "saturday"}, {"c", "sunday"}}

// buildSeasonDiffFields returns, per direction key, the fields the diff
// compares; or a layout error message.
func buildSeasonDiffFields(html string, line *Obj) (*Obj, string, error) {
	cols := parseSlotArrays(html)
	blocks, err := resolveBlocks(line, len(cols), parseFirstOriginName(html))
	if err != nil {
		return nil, "", err
	}
	if blocks.err != "" {
		return nil, blocks.err, nil
	}
	dirs, _ := directionsOf(line)
	out := O()
	for _, dirKey := range blocks.order {
		src, _ := dirs.Get(dirKey).(*Obj)
		offset := blocks.offsets[dirKey]
		stops, _ := stopsOf(src)
		schedules, stopTravel, dayTrips := O(), O(), O()
		cell := func(i int, slot string) ([]string, bool) {
			c, ok := cols[colPad(offset+i)]
			if !ok {
				return nil, false
			}
			v, ok := c[slot]
			return v, ok
		}
		stopID := func(i int) (string, error) {
			s, ok := stops[i].(*Obj)
			if !ok {
				return "", errTypeError
			}
			return jsString(s.Get("id")), nil
		}
		for _, sd := range scrapeDays {
			slot, day := sd.slot, sd.day
			if _, ok := cols[colPad(offset)]; !ok {
				return nil, "", errTypeError
			}
			originCol, hasOrigin := cell(0, slot)
			rowCount := 0
			if hasOrigin {
				rowCount = len(originCol)
			}
			for i := range stops {
				if c, ok := cell(i, slot); ok && len(c) > rowCount {
					rowCount = len(c)
				}
			}
			if rowCount == 0 {
				continue
			}
			type trip struct {
				s     []any
				first float64
			}
			var trips []trip
			for k := 0; k < rowCount; k++ {
				raw := make([]any, len(stops))
				anyTime := false
				for i := range stops {
					var v any = Undefined
					if c, ok := cell(i, slot); ok && k < len(c) {
						v = c[k]
					}
					if sec := scrapeToSec(v); isFinite(sec) {
						raw[i] = sec
						anyTime = true
					} else {
						raw[i] = nil
					}
				}
				if !anyTime {
					continue
				}
				rollover := 0.0
				var prev any = nil
				s := make([]any, 0, len(stops))
				for i := range stops {
					val := raw[i]
					if val == nil {
						s = append(s, nil)
						continue
					}
					cur := val.(float64) + rollover
					if prev != nil && cur < prev.(float64) {
						rollover += 86400
						cur += 86400
					}
					if prev != nil && cur < prev.(float64) {
						if prev.(float64)-cur > 60 {
							id, err := stopID(i)
							if err != nil {
								return nil, "", err
							}
							return nil, day + " trip times decrease at stop " + id + " (" + numToString(prev.(float64)) + "s -> " + numToString(cur) + "s); column block is misaligned", nil
						}
						cur = prev.(float64)
					}
					prev = cur
					s = append(s, cur)
				}
				first := nan
				for _, x := range s {
					if x != nil {
						first = x.(float64)
						break
					}
				}
				trips = append(trips, trip{s, first})
			}
			sort.SliceStable(trips, func(i, j int) bool { return trips[i].first < trips[j].first })
			tripList := make([]any, len(trips))
			var departures []any
			for i, t := range trips {
				tripList[i] = O("s", t.s)
				if len(t.s) > 0 && t.s[0] != nil {
					departures = append(departures, scrapeToTimeStr(t.s[0].(float64)))
				}
			}
			dayTrips.Set(day, tripList)
			if len(departures) == 0 {
				continue
			}
			stopMap := O()
			for i := range stops {
				id, err := stopID(i)
				if err != nil {
					return nil, "", err
				}
				if i == 0 {
					stopMap.Set(id, 0.0)
					continue
				}
				target, ok := cell(i, slot)
				if !ok {
					continue
				}
				from := originCol
				if off := medianOffsetSec(from, target); off != nil {
					stopMap.Set(id, off)
				}
			}
			if len(stops) == 0 {
				return nil, "", errTypeError
			}
			lastID, err := stopID(len(stops) - 1)
			if err != nil {
				return nil, "", err
			}
			if !stopMap.Has(lastID) {
				continue
			}
			prevOff := -1.0
			for i := range stops {
				id, _ := stopID(i)
				if !stopMap.Has(id) {
					continue
				}
				v := stopMap.Num(id)
				if v < prevOff {
					return nil, day + " offsets decrease at stop " + id + " (" + numToString(prevOff) + "s -> " + numToString(v) + "s); column block is misaligned", nil
				}
				prevOff = v
			}
			schedules.Set(day, departures)
			stopTravel.Set(day, stopMap)
		}
		out.Set(dirKey, O("schedules", schedules, "dayStopTravelSec", stopTravel, "dayTrips", dayTrips))
	}
	return out, "", nil
}

// scrapeSeasons returns {seasons} or {error}; a download failure is an error.
func scrapeSeasons(current any, fetch func(string) (string, error)) (*Obj, error) {
	cur, _ := current.(*Obj)
	seasons := O()
	for _, s := range []struct{ url, name string }{{"hivern", "winter"}, {"estiu", "summer"}} {
		season := O()
		seasons.Set(s.name, season)
		for L := 1; L <= 8; L++ {
			html, err := fetch("https://maresme.net/matarobus/" + s.url + "/index.php?l=es&id=" + itoa(L))
			if err != nil {
				return nil, err
			}
			var line *Obj
			if cur != nil {
				line, _ = cur.Get(itoa(L)).(*Obj)
			}
			dirs, layoutErr, err := buildSeasonDiffFields(html, line)
			if err != nil {
				return nil, err
			}
			if layoutErr != "" {
				return O("error", "L"+itoa(L)+" "+s.name+": "+layoutErr), nil
			}
			season.Set(itoa(L), O("directions", dirs))
		}
	}
	return O("seasons", seasons), nil
}

func objOrEmpty(v any) *Obj {
	if o, ok := v.(*Obj); ok {
		return o
	}
	return O()
}

// getOr is (o[k] || {}) / (o[k] || []) for a value that may not be an object.
func fieldOf(v any, k string) any {
	if o, ok := v.(*Obj); ok {
		return o.Get(k)
	}
	return Undefined
}

func listOrEmpty(v any) []any {
	if truthy(v) {
		if l, ok := v.([]any); ok {
			return l
		}
	}
	return nil
}

func diffAgainstShipped(shippedSeasons, freshSeasons any) ([]any, error) {
	if isNullish(shippedSeasons) || isNullish(freshSeasons) {
		return nil, errTypeError
	}
	var diffs []any
	for _, season := range []string{"winter", "summer"} {
		shippedSeason := fieldOf(shippedSeasons, season)
		if !truthy(shippedSeason) {
			shippedSeason = O()
		}
		freshSeason := fieldOf(freshSeasons, season)
		if !truthy(freshSeason) {
			freshSeason = O()
		}
		for L := 1; L <= 8; L++ {
			sl := fieldOf(shippedSeason, itoa(L))
			fl := fieldOf(freshSeason, itoa(L))
			if !truthy(sl) || !truthy(fl) {
				diffs = append(diffs, O("season", season, "line", float64(L), "field", "line", "diff", "Missing line"))
				continue
			}
			flo, _ := fl.(*Obj)
			keys, _ := realDirectionKeys(flo)
			for _, dirKey := range keys {
				sDir := fieldOf(or(fieldOf(sl, "directions"), O()), dirKey)
				fDir := fieldOf(or(fieldOf(fl, "directions"), O()), dirKey)
				if !truthy(sDir) || !truthy(fDir) {
					diffs = append(diffs, O("season", season, "line", float64(L), "dir", dirKey, "field", "direction", "diff", "Missing direction"))
					continue
				}
				for _, day := range []string{"weekday", "saturday", "sunday"} {
					sSch := listOrEmpty(fieldOf(or(fieldOf(sDir, "schedules"), O()), day))
					fSch := listOrEmpty(fieldOf(or(fieldOf(fDir, "schedules"), O()), day))
					if len(sSch) != len(fSch) || !allStrictEq(sSch, fSch) {
						diffs = append(diffs, O("season", season, "line", float64(L), "dir", dirKey, "day", day, "field", "schedules",
							"diff", "departures: "+itoa(len(sSch))+" shipped vs "+itoa(len(fSch))+" fresh"))
					}
					sMap := objOrEmpty(or(fieldOf(or(fieldOf(sDir, "dayStopTravelSec"), O()), day), O()))
					fMap := objOrEmpty(or(fieldOf(or(fieldOf(fDir, "dayStopTravelSec"), O()), day), O()))
					sKeys, fKeys := sMap.Keys(), fMap.Keys()
					sort.Strings(sKeys)
					sort.Strings(fKeys)
					same := len(sKeys) == len(fKeys)
					for i := 0; same && i < len(sKeys); i++ {
						same = sKeys[i] == fKeys[i] && strictEq(sMap.Get(sKeys[i]), fMap.Get(sKeys[i]))
					}
					if !same {
						diffs = append(diffs, O("season", season, "line", float64(L), "dir", dirKey, "day", day, "field", "dayStopTravelSec", "diff", "stop travel offsets differ"))
					}
					sTrips := listOrEmpty(fieldOf(or(fieldOf(sDir, "dayTrips"), O()), day))
					fTrips := listOrEmpty(fieldOf(or(fieldOf(fDir, "dayTrips"), O()), day))
					if len(sTrips) != len(fTrips) {
						diffs = append(diffs, O("season", season, "line", float64(L), "dir", dirKey, "day", day, "field", "dayTrips",
							"diff", "trip count: "+itoa(len(sTrips))+" shipped vs "+itoa(len(fTrips))+" fresh"))
						continue
					}
					tripDiff := false
					for t := range sTrips {
						if isNullish(sTrips[t]) || isNullish(fTrips[t]) {
							return nil, errTypeError
						}
						st := listOrEmpty(fieldOf(sTrips[t], "s"))
						ft := listOrEmpty(fieldOf(fTrips[t], "s"))
						if len(st) != len(ft) || !allStrictEq(st, ft) {
							tripDiff = true
							break
						}
					}
					if tripDiff {
						diffs = append(diffs, O("season", season, "line", float64(L), "dir", dirKey, "day", day, "field", "dayTrips", "diff", "trip stop times differ"))
					}
				}
			}
		}
	}
	return diffs, nil
}

func allStrictEq(a, b []any) bool {
	for i := range a {
		if i >= len(b) || !strictEq(a[i], b[i]) {
			return false
		}
	}
	return true
}

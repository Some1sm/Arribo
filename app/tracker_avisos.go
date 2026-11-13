package main

// Port of mataroTracker.js lines 79-805: Avanza notices (fetching, validity
// windows, affected lines, season windows) and stop cancellations.

import (
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

var gridLabel = map[string]string{
	"saturday": "horari de dissabtes",
	"sunday":   "horari de diumenges i festius",
}

func (t *MataroTracker) setAvisosRpcBackend(backend func() (*Obj, error)) {
	t.avisosRpcBackend = backend
}

func (t *MataroTracker) setAvisosCache(avisos []any, ts float64) {
	t.avisosCache = avisos
	t.hasAvisos = true
	t.avisosGen++
	t.avisosCacheTime = ts
}

// syncAvisos installs the list the worker world published.
func (t *MataroTracker) syncAvisos(avisos any, timestamp float64) {
	cloned := deepClone(avisos)
	if list, ok := cloned.([]any); ok {
		t.setAvisosCache(list, timestamp)
	} else if isNullish(cloned) {
		// A missing list leaves the cache falsy, so the next read refreshes.
		t.setAvisosCache(nil, timestamp)
		t.hasAvisos = false
	} else {
		// Only arrays are ever sent; anything else reads as an empty list.
		t.setAvisosCache([]any{}, timestamp)
	}
	if list, ok := avisos.([]any); ok {
		for _, a := range list {
			ao, _ := a.(*Obj)
			if ao == nil {
				continue
			}
			v := parseAvisoValidity(ao.Get("title"), ao.Get("description"), nowMs())
			registerSeasonNotice(ao.Get("title"), ao.Get("description"), v)
		}
	}
	t.invalidateLineDetailsCache()
}

// detectAffectedLines returns the lines ('1'..'8') a notice names explicitly.
// It reproduces
//
//	/\b(?:linies|linias|lineas|linia|linea|l)\s*-?\s*([1-8](?:\s*(?:,|\bi\b|\by\b)\s*[1-8])*)(?![0-9])/g
//
// by hand, because Go's regexp has no lookahead.
func detectAffectedLines(text any) []string {
	s := jsLower(stripMarks(strOr(jsStringOrEmpty(text), "")))
	s = reParenGroup.ReplaceAllLiteralString(s, " ")
	found := map[string]bool{}
	pos := 0
	for pos < len(s) {
		start, end, group := matchAffectedAt(s, pos)
		if start < 0 {
			break
		}
		for i := 0; i < len(group); i++ {
			if group[i] >= '1' && group[i] <= '8' {
				found[string(group[i])] = true
			}
		}
		pos = end
		_ = start
	}
	out := make([]string, 0, len(found))
	for d := range found {
		out = append(out, d)
	}
	sort.Strings(out)
	return out
}

var reParenGroup = regexp.MustCompile(`\([^)]*\)`)

func jsStringOrEmpty(v any) any {
	// String(text || '')
	if !truthy(v) {
		return ""
	}
	return jsString(v)
}

var affectedPrefixes = []string{"linies", "linias", "lineas", "linia", "linea", "l"}

func skipJSWhite(s string, i int) int {
	for i < len(s) {
		r, n := decodeRuneAt(s, i)
		if n == 0 || !isJSWhite(r) {
			break
		}
		i += n
	}
	return i
}

// matchAffectedAt finds the first match starting at or after from.
func matchAffectedAt(s string, from int) (int, int, string) {
	for p := from; p < len(s); p++ {
		if !jsWordBoundary(s, p) {
			continue
		}
		for _, pre := range affectedPrefixes {
			if !strings.HasPrefix(s[p:], pre) {
				continue
			}
			q := skipJSWhite(s, p+len(pre))
			if q < len(s) && s[q] == '-' {
				q = skipJSWhite(s, q+1)
			}
			if q >= len(s) || s[q] < '1' || s[q] > '8' {
				continue
			}
			d := q
			ends := []int{q + 1}
			e := q + 1
			for {
				x := skipJSWhite(s, e)
				ok := false
				if x < len(s) {
					switch {
					case s[x] == ',':
						ok = true
					case (s[x] == 'i' || s[x] == 'y') && jsWordBoundary(s, x) && jsWordBoundary(s, x+1):
						ok = true
					}
				}
				if !ok {
					break
				}
				y := skipJSWhite(s, x+1)
				if y >= len(s) || s[y] < '1' || s[y] > '8' {
					break
				}
				e = y + 1
				ends = append(ends, e)
			}
			for j := len(ends) - 1; j >= 0; j-- {
				end := ends[j]
				if end < len(s) && s[end] >= '0' && s[end] <= '9' {
					continue
				}
				return p, end, s[d:end]
			}
		}
	}
	return -1, -1, ""
}

// getServiceCalendarInfo states which timetable the boards are using.
func (t *MataroTracker) getServiceCalendarInfo(ms int64) *Obj {
	c := getDateComponents(ms)
	dayType := resolveDayType(ms).DayType
	holiday := holidayInfo(ms)
	season := resolveSeason(ms)

	var name string
	if getServiceOverride(ms) != "" {
		name = "Horari especial"
	} else if holiday != nil {
		if truthy(holiday.Get("name")) {
			name = "Festiu (" + jsString(holiday.Get("name")) + ")"
		} else {
			name = "Festiu"
		}
	} else if c.IsSunday {
		name = "Diumenge"
	} else if c.IsSaturday {
		name = "Dissabte"
	} else {
		name = "Feiner"
	}

	var grid string
	if dayType == "weekday" {
		if season.Season == "summer" {
			grid = "horari d'estiu"
		} else {
			grid = "horari d'hivern"
		}
	} else if g, ok := gridLabel[dayType]; ok {
		grid = g
	} else {
		grid = "undefined"
	}
	known := ""
	if !season.Known {
		known = " (no verificat)"
	}
	return O(
		"serviceId", dayType,
		"dayType", dayType,
		"season", season.Season,
		"seasonKnown", season.Known,
		"name", name,
		"isWeekend", c.IsWeekend,
		"isHoliday", holiday != nil,
		"calendarTag", name+" · "+grid+known,
		"dateFormatted", pad2(c.Day)+"/"+pad2(c.Month)+"/"+strconv.Itoa(c.Year),
	)
}

// avisosList returns this.avisosCache || [].
func (t *MataroTracker) avisosList() []any {
	if t.hasAvisos {
		return t.avisosCache
	}
	return []any{}
}

// fetchAvisos returns the cached notices, refreshing them when stale. The
// caller holds the world lock; it is released while the network or the RPC
// is in flight.
func (t *MataroTracker) fetchAvisos() []any {
	if t.hasAvisos && float64(nowMs())-t.avisosCacheTime < t.avisosCacheTtlMs {
		return t.avisosCache
	}
	if inf := t.avisosInflight; inf != nil {
		t.w.await(func() { <-inf.done })
		v, _ := inf.val.([]any)
		return v
	}
	inf := &inflight{done: make(chan struct{})}
	t.avisosInflight = inf
	var result []any
	if t.avisosRpcBackend == nil {
		result = t.fetchAvisosDirect()
	} else {
		previousGen := t.avisosGen
		var res *Obj
		var err error
		backend := t.avisosRpcBackend
		t.w.await(func() { res, err = backend() })
		if err == nil && res != nil && t.avisosGen == previousGen {
			t.syncAvisos(res.Get("avisos"), res.Num("timestamp"))
		}
		result = t.avisosList()
	}
	inf.val = result
	t.avisosInflight = nil
	close(inf.done)
	return result
}

const avisosURL = "https://mataro.avanzagrupo.com/ca/avisos"

var (
	reTabPane      = regexp.MustCompile(`(?i)<div class="tab-pane`)
	reWarningTitle = jsRe(`(?i)<h2 class="warning-title">([\s\S]*?)</h2>`)
	reAnyTag       = regexp.MustCompile(`<[^>]+>`)
	reWarnDetail   = jsRe(`(?i)class="warning-detail"[^>]*>([\s\S]*?)(?:</div>\s*</div>|</div>\s*<button|$)`)
	reH2Block      = jsRe(`(?i)<h2[\s\S]*?</h2>`)
	reBrTag        = jsRe(`(?i)<br\s*/?>`)
	rePClose       = regexp.MustCompile(`(?i)</p>`)
	reIsWarning    = regexp.MustCompile(`(?i)tall|corte|anul|desvi|obres|obras|afectaci`)
	avisoEntities  = []struct {
		re   *regexp.Regexp
		repl string
	}{
		{regexp.MustCompile(`(?i)&nbsp;`), " "},
		{regexp.MustCompile(`(?i)&ccedil;`), "ç"},
		{regexp.MustCompile(`(?i)&eacute;`), "é"},
		{regexp.MustCompile(`(?i)&egrave;`), "è"},
		{regexp.MustCompile(`(?i)&agrave;`), "à"},
		{regexp.MustCompile(`(?i)&iacute;`), "í"},
		{regexp.MustCompile(`(?i)&oacute;`), "ó"},
		{regexp.MustCompile(`(?i)&ograve;`), "ò"},
		{regexp.MustCompile(`(?i)&uacute;`), "ú"},
		{regexp.MustCompile(`(?i)&middot;`), "·"},
	}
)

// parseAvisosHTML turns the portal page into notices.
func parseAvisosHTML(data string) []any {
	avisos := []any{}
	panes := jsSplitStrings(reTabPane, data, true)
	if len(panes) > 0 {
		panes = panes[1:]
	}
	for idx, pane := range panes {
		tm := reFind(reWarningTitle, pane, true)
		if tm == nil {
			continue
		}
		title := jsTrim(reAnyTag.ReplaceAllLiteralString(tm.g(1), ""))

		var descHTML string
		if dm := reFind(reWarnDetail, pane, true); dm != nil {
			descHTML = jsTrim(dm.g(1))
		} else {
			descHTML = jsTrim(reReplaceFirst(reH2Block, pane, "", true))
		}

		plain := reReplaceAll(reBrTag, descHTML, "\n", true)
		plain = reReplaceAll(rePClose, plain, "\n\n", true)
		for _, e := range avisoEntities {
			plain = reReplaceAll(e.re, plain, e.repl, true)
		}
		plain = jsTrim(reAnyTag.ReplaceAllLiteralString(plain, ""))

		lines := detectAffectedLines(title + "\n" + plain)
		isWarning := reTestI(reIsWarning, title+" "+plain)
		hasExplicit := len(lines) > 0
		validity := parseAvisoValidity(title, plain, nowMs())
		registerSeasonNotice(title, plain, validity)

		affected := any("Informació General")
		if hasExplicit {
			parts := make([]string, len(lines))
			for i, l := range lines {
				parts[i] = "L" + l
			}
			affected = strings.Join(parts, ", ")
		}
		desc := plain
		if desc == "" {
			desc = title
		}
		severity := "info"
		if isWarning {
			severity = "warning"
		}
		avisos = append(avisos, O(
			"id", "aviso_"+strconv.Itoa(idx+1),
			"title", title,
			"description", desc,
			"linesAffected", stringsToAny(lines),
			"affectedLines", affected,
			"agency", "Mataró Bus (Avanza)",
			"severity", severity,
			"isSpecific", hasExplicit,
			"url", avisosURL,
			"expiresAt", validity.expiryISO(),
			"active", !validity.IsExpired,
		))
	}
	return avisos
}

// fetchAvisosDirect is _fetchAvisos: the portal, then the bundled fallback.
func (t *MataroTracker) fetchAvisosDirect() []any {
	now := float64(nowMs())
	if t.hasAvisos && now-t.avisosCacheTime < t.avisosCacheTtlMs {
		return t.avisosCache
	}

	var online []any
	t.w.await(func() { online = fetchAvisosOnline() })
	if len(online) > 0 {
		t.setAvisosCache(online, now)
		return online
	}

	p := filepath.Join(appRoot, "data", "cities", "mataro", "mataro_avisos.json")
	if b, err := os.ReadFile(p); err == nil {
		raw, err := parseJSON(b)
		if err == nil {
			ro, _ := raw.(*Obj)
			if msgs, ok := ro.Get("message").([]any); ok {
				fallback := make([]any, 0, len(msgs))
				for _, m := range msgs {
					a, _ := m.(*Obj)
					title := or(a.Get("title_ca"), or(a.Get("title_es"), "Avís Mataró Bus"))
					desc := or(a.Get("text_ca"), or(a.Get("text_es"), ""))
					validity := parseAvisoValidity(title, desc, nowMs())
					registerSeasonNotice(title, desc, validity)
					fallback = append(fallback, O(
						"id", jsString(a.Get("id")),
						"title", title,
						"description", desc,
						"agency", "Mataró Bus (Avanza)",
						"linesAffected", []any{"1", "2", "3", "4", "5", "6", "7", "8"},
						"affectedLines", "Totes les línies",
						"severity", "info",
						"url", avisosURL,
						"expiresAt", validity.expiryISO(),
						"active", !validity.IsExpired,
					))
				}
				t.setAvisosCache(fallback, now)
				return fallback
			}
		}
	}
	return t.avisosList()
}

// fetchAvisosOnline downloads and parses the portal page; nil on any failure.
func fetchAvisosOnline() []any {
	client := nodeRequestClient("mataro.avanzagrupo.com", srcDataDir(), 6000*time.Millisecond)
	req, err := http.NewRequest("GET", avisosURL, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	req.Header.Set("Cookie", "GUEST_LANGUAGE_ID=ca_ES")
	resp, err := client.Do(req)
	if err != nil {
		var ne interface{ Timeout() bool }
		if errors.As(err, &ne) && ne.Timeout() {
			return nil
		}
		log.Printf("[MataroTracker] Avisos fetch failed — %s", describeChainFailure("mataro.avanzagrupo.com", err))
		return nil
	}
	defer resp.Body.Close()
	data, err := readBoundedBody(resp.Body, defaultMaxBodyBytes)
	if err != nil {
		log.Printf("[MataroTracker] Avisos fetch failed — %s", err.Error())
		return nil
	}
	return parseAvisosHTML(data)
}

// registerSeasonNotice feeds a seasonal-timetable notice to the season calendar.
func registerSeasonNotice(title, description any, v *AvisoValidity) bool {
	text := jsLower(stripMarks(jsString(title) + " " + jsString(description)))
	isSummer := reSummerWord.MatchString(text)
	isWinter := reWinterWord.MatchString(text)
	if isSummer == isWinter {
		return false
	}
	if v == nil || !v.HasStart || !v.HasExpiry {
		return false
	}
	from := madridDateKey(v.StartsAt)
	to := madridDateKey(v.Expiry)
	if years := reYear20xx.FindAllString(text, -1); years != nil {
		hit := false
		for _, y := range years {
			if y == from[:4] {
				hit = true
				break
			}
		}
		if !hit {
			return false
		}
	}
	season := "winter"
	if isSummer {
		season = "summer"
	}
	return registerSeasonWindow(from, to, season, jsTrim(jsString(or(title, ""))))
}

var (
	reSummerWord = regexp.MustCompile(`\b(estiu|verano)\b`)
	reWinterWord = regexp.MustCompile(`\b(hivern|invierno)\b`)
	reYear20xx   = regexp.MustCompile(`\b20\d\d\b`)
)

type avisoWindow struct{ start, end int64 }

// AvisoValidity is parseAvisoValidity's result.
type AvisoValidity struct {
	IsOngoing      bool
	StartsAt       int64
	HasStart       bool
	Expiry         int64
	HasExpiry      bool
	IsExpired      bool
	IsFuture       bool
	IsEffectiveNow bool
	Windows        []avisoWindow
}

func (v *AvisoValidity) expiryISO() any {
	if !v.HasExpiry {
		return nil
	}
	return isoString(v.Expiry)
}

func (v *AvisoValidity) startISO() any {
	if !v.HasStart {
		return nil
	}
	return isoString(v.StartsAt)
}

var avisoMonths = map[string]int{
	"gener": 1, "enero": 1,
	"febrer": 2, "febrero": 2,
	"marc": 3, "març": 3, "marzo": 3,
	"abril": 4,
	"maig":  5, "mayo": 5,
	"juny": 6, "junio": 6,
	"juliol": 7, "julio": 7,
	"agost": 8, "agosto": 8,
	"setembre": 9, "septiembre": 9,
	"octubre":  10,
	"novembre": 11, "noviembre": 11,
	"desembre": 12, "diciembre": 12,
}

// Object.keys(MONTHS).join('|'), in the source's insertion order.
const avisoMonthAlt = "gener|enero|febrer|febrero|marc|març|marzo|abril|maig|mayo|juny|junio|juliol|julio|agost|agosto|setembre|septiembre|octubre|novembre|noviembre|desembre|diciembre"

const avisoOF = `(?:de\s+|d')`

// The text is lowercased before matching, so the source's i flag changes
// nothing and is left off (it would also let Go fold U+017F into "s").
var (
	reAvisoOngoing  = jsRe(`fins(?:\s+a)?\s+nou\s+av[ií]s|fins\s+nova\s+ordre|hasta\s+nuevo\s+aviso`)
	reApostrophes   = regexp.MustCompile("[’‘´ʼ`]")
	reMultiDayHours = jsRe(`(\d{1,2})\s*(?:i|y|,)\s*(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{2,4}))?[^0-9\n\r]*?de\s+(\d{1,2})(?:[.:](\d{2}))?\s+a\s+(\d{1,2})(?:[.:](\d{2}))?`)
	reDateTime      = jsRe(`(?:(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{2,4}))?|(\d{1,2})\s+(?:de\s+|d')([a-zç]+)(?:\s+de\s+(\d{4}))?)[^0-9\n\r]*?de\s+(\d{1,2})(?:[.:](\d{2}))?\s+a\s+(\d{1,2})(?:[.:](\d{2}))?(?:[^\n\r]*?i\s+de\s+(\d{1,2})(?:[.:](\d{2}))?\s+a\s+(\d{1,2})(?:[.:](\d{2}))?)?`)
	reRangeNumeric  = jsRe(`(?:del|des de|des del)\s+(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{2,4}))?\s+(?:al|fins al|fins el|fins a|fins|a|fins les|hasta el)\s+(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{2,4}))?`)
	reNamedRange    = jsRe(`(?:del|des de|des del)\s+(\d{1,2})(?:\s+` + avisoOF + `(` + avisoMonthAlt + `))?\s+(?:al|fins al|fins el|fins a|hasta el)\s+(\d{1,2})\s+` + avisoOF + `(` + avisoMonthAlt + `)(?:\s+de\s+(\d{4}))?`)
	reUntilNumeric  = jsRe(`(?:fins al|fins el|fins a|fins|fins les|hasta el)\s+(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{2,4}))?`)
	reUntilNamed    = jsRe(`(?:fins al|fins el|fins a|fins|hasta el)\s+(\d{1,2})\s+` + avisoOF + `(` + avisoMonthAlt + `)(?:\s+de\s+(\d{4}))?`)
	reStandaloneDMY = regexp.MustCompile(`\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})\b`)
	reAvisoTime     = jsRe(`(?:a|fins a|fins les|fins a les)\s+(\d{1,2})[.:](\d{2})\s*(?:h|hores)?`)
)

func atoiJS(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

func ongoingValidity() *AvisoValidity {
	return &AvisoValidity{IsOngoing: true, IsEffectiveNow: true, Windows: []avisoWindow{}}
}

// parseAvisoValidity reads the service windows a notice states. title and
// description default to ” when undefined, like the source's parameters.
func parseAvisoValidity(title, description any, refMs int64) *AvisoValidity {
	if isUndef(title) {
		title = ""
	}
	if isUndef(description) {
		description = ""
	}
	text := jsLower(jsString(title) + " " + jsString(description))
	text = reApostrophes.ReplaceAllLiteralString(text, "'")
	currentYear := getDateComponents(refMs).Year

	if reAvisoOngoing.MatchString(text) {
		return ongoingValidity()
	}

	var windows []avisoWindow
	hasSpecificHourOnDate := func(y, m, d int) bool {
		for _, w := range windows {
			sc := getDateComponents(w.start)
			ec := getDateComponents(w.end)
			if sc.Year == y && sc.Month == m && sc.Day == d && !(sc.Hour == 0 && ec.Hour == 23 && ec.Minute == 59) {
				return true
			}
		}
		return false
	}
	optInt := func(m *reMatch, i, def int) int {
		if m.has(i) && m.g(i) != "" {
			return atoiJS(m.g(i))
		}
		return def
	}
	year2 := func(m *reMatch, i, cur int) int {
		y := cur
		if m.has(i) && m.g(i) != "" {
			y = atoiJS(m.g(i))
		}
		if y < 100 {
			y += 2000
		}
		return y
	}

	// 1. Two dates sharing hours: '14 i 15/09/2026 de 14.00 a 18.00'
	for _, mm := range reFindAll(reMultiDayHours, text, false) {
		d1, d2, m := atoiJS(mm.g(1)), atoiJS(mm.g(2)), atoiJS(mm.g(3))
		y := year2(mm, 4, currentYear)
		hS, minS := atoiJS(mm.g(5)), optInt(mm, 6, 0)
		hE, minE := atoiJS(mm.g(7)), optInt(mm, 8, 0)
		for _, d := range []int{d1, d2} {
			if m >= 1 && m <= 12 && d >= 1 && d <= 31 {
				windows = append(windows, avisoWindow{
					localTimeToUtcDate(y, m-1, d, hS, minS, 0),
					localTimeToUtcDate(y, m-1, d, hE, minE, 0),
				})
			}
		}
	}

	// 2. A date with hour interval(s).
	for _, mm := range reFindAll(reDateTime, text, false) {
		var day, month, year int
		if mm.has(1) && mm.g(1) != "" {
			day = atoiJS(mm.g(1))
			month = atoiJS(mm.g(2))
			year = year2(mm, 3, currentYear)
		} else {
			day = atoiJS(mm.g(4))
			month = avisoMonths[jsLower(mm.g(5))]
			year = optInt(mm, 6, currentYear)
		}
		if month == 0 || day < 1 || day > 31 {
			continue
		}
		sH1, sM1 := atoiJS(mm.g(7)), optInt(mm, 8, 0)
		eH1, eM1 := atoiJS(mm.g(9)), optInt(mm, 10, 0)
		windows = append(windows, avisoWindow{
			localTimeToUtcDate(year, month-1, day, sH1, sM1, 0),
			localTimeToUtcDate(year, month-1, day, eH1, eM1, 0),
		})
		if mm.has(11) && mm.g(11) != "" && mm.has(13) && mm.g(13) != "" {
			sH2, sM2 := atoiJS(mm.g(11)), optInt(mm, 12, 0)
			eH2, eM2 := atoiJS(mm.g(13)), optInt(mm, 14, 0)
			windows = append(windows, avisoWindow{
				localTimeToUtcDate(year, month-1, day, sH2, sM2, 0),
				localTimeToUtcDate(year, month-1, day, eH2, eM2, 0),
			})
		}
	}

	// 3. Numeric date ranges: 'del 01/09 al 02/09'
	for _, mm := range reFindAll(reRangeNumeric, text, false) {
		sDay, sMonth := atoiJS(mm.g(1)), atoiJS(mm.g(2))
		sYear := year2(mm, 3, currentYear)
		eDay, eMonth := atoiJS(mm.g(4)), atoiJS(mm.g(5))
		eYear := year2(mm, 6, currentYear)
		if sMonth >= 1 && sMonth <= 12 && sDay >= 1 && sDay <= 31 && eMonth >= 1 && eMonth <= 12 && eDay >= 1 && eDay <= 31 {
			windows = append(windows, avisoWindow{
				localTimeToUtcDate(sYear, sMonth-1, sDay, 0, 0, 0),
				localTimeToUtcDate(eYear, eMonth-1, eDay, 23, 59, 59),
			})
		}
	}

	// 4. Named month ranges: 'del 1 al 2 de setembre'
	for _, mm := range reFindAll(reNamedRange, text, false) {
		sDay := atoiJS(mm.g(1))
		eDay := atoiJS(mm.g(3))
		eMonth := avisoMonths[jsLower(mm.g(4))]
		sMonth := eMonth
		if mm.has(2) && mm.g(2) != "" {
			sMonth = avisoMonths[jsLower(mm.g(2))]
		}
		eYear := optInt(mm, 5, currentYear)
		sYear := eYear
		if sMonth != 0 && eMonth != 0 && sDay >= 1 && sDay <= 31 && eDay >= 1 && eDay <= 31 {
			windows = append(windows, avisoWindow{
				localTimeToUtcDate(sYear, sMonth-1, sDay, 0, 0, 0),
				localTimeToUtcDate(eYear, eMonth-1, eDay, 23, 59, 59),
			})
		}
	}

	// 5. 'fins al 02/09'
	for _, mm := range reFindAll(reUntilNumeric, text, false) {
		day, month := atoiJS(mm.g(1)), atoiJS(mm.g(2))
		year := year2(mm, 3, currentYear)
		if month >= 1 && month <= 12 && day >= 1 && day <= 31 && !hasSpecificHourOnDate(year, month, day) {
			windows = append(windows, avisoWindow{
				localTimeToUtcDate(year, month-1, day, 0, 0, 0),
				localTimeToUtcDate(year, month-1, day, 23, 59, 59),
			})
		}
	}

	// 6. 'fins al 2 de setembre de 2026'
	for _, mm := range reFindAll(reUntilNamed, text, false) {
		day := atoiJS(mm.g(1))
		month := avisoMonths[jsLower(mm.g(2))]
		year := optInt(mm, 3, currentYear)
		if month != 0 && day >= 1 && day <= 31 && !hasSpecificHourOnDate(year, month, day) {
			windows = append(windows, avisoWindow{
				localTimeToUtcDate(year, month-1, day, 0, 0, 0),
				localTimeToUtcDate(year, month-1, day, 23, 59, 59),
			})
		}
	}

	// 7. Standalone full dates: '05/09/2026'
	for _, mm := range reFindAll(reStandaloneDMY, text, false) {
		day, month, year := atoiJS(mm.g(1)), atoiJS(mm.g(2)), atoiJS(mm.g(3))
		if month >= 1 && month <= 12 && day >= 1 && day <= 31 && !hasSpecificHourOnDate(year, month, day) {
			windows = append(windows, avisoWindow{
				localTimeToUtcDate(year, month-1, day, 0, 0, 0),
				localTimeToUtcDate(year, month-1, day, 23, 59, 59),
			})
		}
	}

	var lastTime *reMatch
	if all := reFindAll(reAvisoTime, text, false); len(all) > 0 {
		lastTime = all[len(all)-1]
	}

	if len(windows) == 0 {
		return ongoingValidity()
	}

	sort.SliceStable(windows, func(i, j int) bool { return windows[i].start < windows[j].start })
	byEnd := append([]avisoWindow(nil), windows...)
	sort.SliceStable(byEnd, func(i, j int) bool { return byEnd[i].end > byEnd[j].end })
	expiry := byEnd[0].end

	if lastTime != nil {
		allDay := true
		for _, w := range windows {
			if getDateComponents(w.start).Hour != 0 || getDateComponents(w.end).Hour != 23 {
				allDay = false
				break
			}
		}
		if allDay {
			endH, endM := atoiJS(lastTime.g(1)), atoiJS(lastTime.g(2))
			if endH >= 0 && endH <= 23 && endM >= 0 && endM <= 59 {
				e := getDateComponents(expiry)
				expiry = localTimeToUtcDate(e.Year, e.Month-1, e.Day, endH, endM, 0)
			}
		}
	}

	startsAt := windows[0].start
	isExpired := expiry < refMs
	isFuture := startsAt > refMs
	isEffectiveNow := false
	if !isExpired && !isFuture {
		for _, w := range windows {
			if refMs >= w.start && refMs <= w.end {
				isEffectiveNow = true
				break
			}
		}
	}
	return &AvisoValidity{
		StartsAt: startsAt, HasStart: true,
		Expiry: expiry, HasExpiry: true,
		IsExpired: isExpired, IsFuture: isFuture, IsEffectiveNow: isEffectiveNow,
		Windows: windows,
	}
}

// getDisruptions returns the active notices, or a line's active warnings.
// It marks expired cached notices inactive, as the source does.
func (t *MataroTracker) getDisruptions(lineID any) []any {
	all := t.fetchAvisos()
	now := nowMs()
	active := []any{}
	for _, x := range all {
		a, _ := x.(*Obj)
		if a == nil {
			continue
		}
		if a.Get("active") == false {
			continue
		}
		if truthy(a.Get("expiresAt")) && newDate(a.Get("expiresAt")).Ms < float64(now) {
			a.Set("active", false)
			continue
		}
		if parseAvisoValidity(a.Get("title"), a.Get("description"), now).IsExpired {
			a.Set("active", false)
			continue
		}
		active = append(active, a)
	}
	if !truthy(lineID) {
		return active
	}
	cleanID := t.normalizeLineId(lineID)
	out := []any{}
	for _, x := range active {
		a := x.(*Obj)
		if a.Get("severity") != "warning" {
			continue
		}
		la, ok := a.Get("linesAffected").([]any)
		if !ok {
			continue
		}
		for _, l := range la {
			if s, ok := l.(string); ok && s == cleanID {
				out = append(out, a)
				break
			}
		}
	}
	return out
}

var (
	reNormPlaca   = regexp.MustCompile(`\b(?:placa|plaza)\b`)
	reNormAv      = regexp.MustCompile(`\b(?:avinguda|avenida)\b`)
	reNormCarrer  = regexp.MustCompile(`\b(?:carrer|calle)\b`)
	reNormPasseig = regexp.MustCompile(`\b(?:passeig|paseo)\b`)
	reNormPtge    = regexp.MustCompile(`\b(?:passatge|pasaje)\b`)
	reNonAlnum    = regexp.MustCompile(`[^a-z0-9]`)
	reJSWhiteRun  = jsRe(`\s+`)

	reLineBlock  = regexp.MustCompile(`(?i)(?:l[íi]nia|l[ií]nea)` + jsWS + `*([1-8])`)
	reAdrMatch   = regexp.MustCompile(`(?i)(?:adre[cçs]a|direcci[oó]n)` + jsWS + `*([^\n\r,]+)`)
	reProvStop   = regexp.MustCompile(`(?i)parada` + jsWS + `+provisional` + jsWS + `*:` + jsWS + `*([^\n\r]+)`)
	reParenNote  = regexp.MustCompile(`\(([^)]+)\)`)
	reParenFirst = regexp.MustCompile(`\([^)]+\)`)
	reCancStops  = regexp.MustCompile(`(?i)parad[ae]s?(?:\(es\))?` + jsWS + `*anul[^:\n\r]*:` + jsWS + `*([^\n\r]+)`)
	reCancSplit  = regexp.MustCompile(`(?i)(?:,` + jsWS + `*|` + jsWS + `+i` + jsWS + `+|` + jsWS + `+y` + jsWS + `+|` + jsWS + `+e` + jsWS + `+|;` + jsWS + `*)`)
)

func cancNormName(v any) string {
	s := ""
	if truthy(v) {
		s = jsString(v)
	}
	s = jsLower(stripMarks(s))
	s = reNormPlaca.ReplaceAllLiteralString(s, "pl")
	s = reNormAv.ReplaceAllLiteralString(s, "av")
	s = reNormCarrer.ReplaceAllLiteralString(s, "c")
	s = reNormPasseig.ReplaceAllLiteralString(s, "pg")
	s = reNormPtge.ReplaceAllLiteralString(s, "ptge")
	s = reNonAlnum.ReplaceAllLiteralString(s, " ")
	s = reJSWhiteRun.ReplaceAllLiteralString(s, " ")
	return jsTrim(s)
}

var cancStopwords = map[string]bool{"de": true, "d": true, "la": true, "les": true, "el": true, "els": true, "i": true, "y": true, "en": true, "a": true, "del": true, "dels": true}

func tokenOverlapRatio(a, b string) float64 {
	set := func(s string) map[string]bool {
		m := map[string]bool{}
		for _, t := range strings.Split(s, " ") {
			if t != "" && !cancStopwords[t] {
				m[t] = true
			}
		}
		return m
	}
	setA, setB := set(a), set(b)
	if len(setA) == 0 || len(setB) == 0 {
		return 0
	}
	common := 0
	for t := range setA {
		if setB[t] {
			common++
		}
	}
	return float64(common) / float64(max(len(setA), len(setB)))
}

// getStopCancellations reads cancelled and provisional stops for a line out of
// the active warnings.
func (t *MataroTracker) getStopCancellations(lineID any, avisos []any, nowAt float64) *Obj {
	lID := reLeadingLInsens.ReplaceAllLiteralString(jsString(lineID), "")
	lineSched := getLineSchedule(lID, "")
	cancellations := []any{}
	provisional := []any{}
	unmatched := []any{}
	result := O("cancellations", cancellations, "provisional", provisional, "unmatchedStops", unmatched)
	if lineSched == nil || lineSched.Directions == nil {
		return result
	}
	if nowAt != nowAt {
		// A date that does not parse makes the calendar lookups throw in the
		// source; no caller passes one.
		return result
	}
	now := int64(nowAt)

	for _, x := range avisos {
		aviso, _ := x.(*Obj)
		if aviso == nil {
			continue
		}
		if aviso.Get("severity") != "warning" || aviso.Get("active") == false {
			continue
		}
		if truthy(aviso.Get("expiresAt")) && newDate(aviso.Get("expiresAt")).Ms < float64(now) {
			continue
		}
		validity := parseAvisoValidity(aviso.Get("title"), aviso.Get("description"), now)
		if validity.IsExpired {
			continue
		}
		if validity.IsFuture || !validity.IsEffectiveNow {
			continue
		}
		desc := jsString(or(aviso.Get("description"), or(aviso.Get("descriptionHtml"), "")))
		blocks := jsSplitRe(reLineBlock, desc, true)
		for i := 1; i < len(blocks); i += 2 {
			if jsTrim(jsString(blocks[i])) != lID {
				continue
			}
			block := ""
			if i+1 < len(blocks) {
				block = jsString(or(blocks[i+1], ""))
			}

			var matchedDirKeys []string
			if adr := reFind(reAdrMatch, block, true); adr != nil && adr.g(1) != "" {
				targetDest := cancNormName(adr.g(1))
				for _, dk := range lineSched.DirKeys {
					dir := lineSched.Directions[dk]
					termName := ""
					if len(dir.Stops) > 0 {
						termName = cancNormName(dir.Stops[len(dir.Stops)-1].Name)
					}
					dirName := cancNormName(dir.DirectionName)
					if strings.Contains(termName, targetDest) || strings.Contains(targetDest, termName) ||
						strings.HasSuffix(dirName, targetDest) || strings.Contains(dirName, targetDest) ||
						tokenOverlapRatio(termName, targetDest) >= 0.5 {
						matchedDirKeys = append(matchedDirKeys, dk)
					}
				}
				if len(matchedDirKeys) == 0 {
					matchedDirKeys = append([]string(nil), lineSched.DirKeys...)
					unmatched = append(unmatched, O(
						"noticeId", aviso.Get("id"),
						"address", adr.g(1),
						"reason", `Direction address "`+adr.g(1)+`" did not match any direction of Line `+lID+`; scoped to all directions.`,
					))
				}
			} else {
				matchedDirKeys = append([]string(nil), lineSched.DirKeys...)
			}

			for _, pm := range reFindAll(reProvStop, block, true) {
				fullProv := jsTrim(pm.g(1))
				note := ""
				if nm := reParenNote.FindStringSubmatch(fullProv); nm != nil {
					note = jsTrim(nm[1])
				}
				name := jsTrim(reReplaceFirst(reParenFirst, fullProv, "", false))
				provisional = append(provisional, O(
					"provisional", true,
					"name", name,
					"note", note,
					"lineId", lID,
					"noticeId", aviso.Get("id"),
					"title", aviso.Get("title"),
				))
			}

			if cm := reFind(reCancStops, block, true); cm != nil && cm.g(1) != "" {
				var rawNames []string
				for _, s := range jsSplitStrings(reCancSplit, cm.g(1), true) {
					if s = jsTrim(s); s != "" {
						rawNames = append(rawNames, s)
					}
				}
				for _, rawName := range rawNames {
					normTarget := cancNormName(rawName)
					matchedAny := false
					for _, dk := range matchedDirKeys {
						stops := lineSched.Directions[dk].Stops
						var found *SchedStop
						for _, s := range stops {
							if cancNormName(s.Name) == normTarget {
								found = s
								break
							}
						}
						if found == nil {
							for _, s := range stops {
								sn := cancNormName(s.Name)
								if strings.Contains(sn, normTarget) || strings.Contains(normTarget, sn) {
									found = s
									break
								}
							}
						}
						if found == nil {
							for _, s := range stops {
								if tokenOverlapRatio(cancNormName(s.Name), normTarget) >= 0.6 {
									found = s
									break
								}
							}
						}
						if found != nil {
							matchedAny = true
							cancellations = append(cancellations, O(
								"stopId", found.ID,
								"dirKey", dk,
								"noticeId", aviso.Get("id"),
								"title", aviso.Get("title"),
								"from", validity.startISO(),
								"to", validity.expiryISO(),
							))
						}
					}
					if !matchedAny {
						unmatched = append(unmatched, O(
							"noticeId", aviso.Get("id"),
							"name", rawName,
							"lineId", lID,
							"reason", `Stop "`+rawName+`" not found on Line `+lID,
						))
					}
				}
			}
		}
	}
	result.Set("cancellations", cancellations)
	result.Set("provisional", provisional)
	result.Set("unmatchedStops", unmatched)
	return result
}

var reLeadingLInsens = regexp.MustCompile(`^[lL]`)

// getCancelledStopsForLine maps cancelled stop id -> notice title.
func (t *MataroTracker) getCancelledStopsForLine(lineID any, avisos []any, nowAt float64, direction any) *JSMap {
	data := t.getStopCancellations(lineID, avisos, nowAt)
	cancelled := newJSMap()
	lID := reLeadingLInsens.ReplaceAllLiteralString(jsString(lineID), "")
	lineSched := getLineSchedule(lID, "")
	targetDirKey := ""
	if !isNullish(direction) {
		targetDirKey = resolveDirectionKey(lineSched, jsString(direction))
	}
	for _, x := range data.Arr("cancellations") {
		c := x.(*Obj)
		if targetDirKey != "" && c.Str("dirKey") != targetDirKey {
			continue
		}
		cancelled.Set(c.Str("stopId"), c.Get("title"))
	}
	return cancelled
}

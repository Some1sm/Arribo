package main

// Ports of src/core/time/holidayCalendar.js and src/data/seasonCalendar.js.

import (
	"encoding/json"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// holidayCalendar

type holidayEntry struct {
	Date   string `json:"date"`
	Name   string `json:"name"`
	Source string `json:"source"`
}

type serviceOverride struct {
	Date    string `json:"date"`
	DayType string `json:"dayType"`
}

type holidayYear struct {
	Regional         []holidayEntry    `json:"regional"`
	Local            []holidayEntry    `json:"local"`
	ServiceOverrides []serviceOverride `json:"serviceOverrides"`
	hasRegional      bool
	hasLocal         bool
	hasOverrides     bool
}

func (h *holidayYear) UnmarshalJSON(b []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	if v, ok := raw["regional"]; ok {
		if err := json.Unmarshal(v, &h.Regional); err == nil && h.Regional != nil {
			h.hasRegional = true
		}
	}
	if v, ok := raw["local"]; ok {
		if err := json.Unmarshal(v, &h.Local); err == nil && h.Local != nil {
			h.hasLocal = true
		}
	}
	if v, ok := raw["serviceOverrides"]; ok {
		if err := json.Unmarshal(v, &h.ServiceOverrides); err == nil && h.ServiceOverrides != nil {
			h.hasOverrides = true
		}
	}
	return nil
}

var (
	holidaysData  map[string]*holidayYear
	holidayCache  = map[int]map[string]bool{}
	holidayCacheM sync.Mutex
)

func loadHolidays(path string) {
	b, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("[HolidayCalendar] Could not load holidays.json: %v", err)
		}
		return
	}
	var file struct {
		Years map[string]*holidayYear `json:"years"`
	}
	if err := json.Unmarshal(b, &file); err != nil {
		log.Printf("[HolidayCalendar] Could not load holidays.json: %v", err)
		return
	}
	holidaysData = file.Years
}

func easterSunday(year int) (int, int) {
	a := year % 19
	b := year / 100
	c := year % 100
	d := b / 4
	e := b % 4
	f := (b + 8) / 25
	g := (b - f + 1) / 3
	h := (19*a + b - d - g + 15) % 30
	i := c / 4
	k := c % 4
	l := (32 + 2*e + 2*i - h - k) % 7
	m := (a + 11*h + 22*l) / 451
	month := (h + l - 7*m + 114) / 31
	day := ((h + l - 7*m + 114) % 31) + 1
	return month, day
}

func shiftMonthDay(month, day, days int) (int, int) {
	t := time.Date(2000, time.Month(month), day, 0, 0, 0, 0, time.UTC).AddDate(0, 0, days)
	return int(t.Month()), t.Day()
}

func ymd(y, m, d int) string {
	return strconv.Itoa(y) + "-" + pad2(m) + "-" + pad2(d)
}

func fallbackHolidayDatesForYear(year int) map[string]bool {
	em, ed := easterSunday(year)
	mm, md := shiftMonthDay(em, ed, 1)
	gm, gd := shiftMonthDay(em, ed, -2)
	set := map[string]bool{}
	for _, md2 := range [][2]int{{1, 1}, {1, 6}, {5, 1}, {8, 15}, {10, 12}, {11, 1}, {12, 6}, {12, 8}, {12, 25}, {12, 26}, {9, 11}, {6, 24}} {
		set[ymd(year, md2[0], md2[1])] = true
	}
	set[ymd(year, gm, gd)] = true
	set[ymd(year, em, ed)] = true
	set[ymd(year, mm, md)] = true
	return set
}

func holidaysForYear(year int) map[string]bool {
	holidayCacheM.Lock()
	defer holidayCacheM.Unlock()
	if s, ok := holidayCache[year]; ok {
		return s
	}
	if y := holidaysData[strconv.Itoa(year)]; y != nil {
		set := map[string]bool{}
		for _, h := range y.Regional {
			set[h.Date] = true
		}
		for _, h := range y.Local {
			set[h.Date] = true
		}
		holidayCache[year] = set
		return set
	}
	set := fallbackHolidayDatesForYear(year)
	holidayCache[year] = set
	return set
}

type holidayStatus struct{ regionalKnown, localKnown, known bool }

func holidayYearStatus(year int) holidayStatus {
	y := holidaysData[strconv.Itoa(year)]
	var s holidayStatus
	if y != nil {
		s.regionalKnown = y.hasRegional && len(y.Regional) == 12
		s.localKnown = y.hasLocal && len(y.Local) == 2
	}
	s.known = s.regionalKnown && s.localKnown
	return s
}

func getHolidayCoverage(ms int64) *Obj {
	c := getDateComponents(ms)
	cur := holidayYearStatus(c.Year)
	var warning any = nil
	if !cur.regionalKnown {
		warning = "Festius oficials " + strconv.Itoa(c.Year) + " no configurats"
	} else if !cur.localKnown {
		warning = "Festius locals de Mataró " + strconv.Itoa(c.Year) + " no configurats"
	} else if c.Month >= 12 && !holidayYearStatus(c.Year+1).known {
		warning = "Festius " + strconv.Itoa(c.Year+1) + " pendents de configurar"
	}
	return O("year", c.Year, "regionalKnown", cur.regionalKnown, "localKnown", cur.localKnown, "known", cur.known, "warning", warning)
}

func isHolidayKnown(ms int64) bool {
	return holidayYearStatus(getDateComponents(ms).Year).known
}

func isHoliday(ms int64) bool {
	c := getDateComponents(ms)
	return holidaysForYear(c.Year)[ymd(c.Year, c.Month, c.Day)]
}

// holidayInfo returns nil when the date is not a modelled holiday.
func holidayInfo(ms int64) *Obj {
	c := getDateComponents(ms)
	key := ymd(c.Year, c.Month, c.Day)
	if !holidaysForYear(c.Year)[key] {
		return nil
	}
	if y := holidaysData[strconv.Itoa(c.Year)]; y != nil {
		for _, scope := range []string{"regional", "local"} {
			list := y.Regional
			if scope == "local" {
				list = y.Local
			}
			for _, h := range list {
				if h.Date == key {
					var name any = nil
					if h.Name != "" {
						name = h.Name
					}
					return O("date", key, "name", name, "scope", scope)
				}
			}
		}
	}
	return O("date", key, "name", nil, "scope", "computed")
}

// getServiceOverride returns "" when there is none.
func getServiceOverride(ms int64) string {
	c := getDateComponents(ms)
	y := holidaysData[strconv.Itoa(c.Year)]
	if y == nil || !y.hasOverrides {
		return ""
	}
	key := ymd(c.Year, c.Month, c.Day)
	for _, o := range y.ServiceOverrides {
		if o.Date == key {
			return o.DayType
		}
	}
	return ""
}

func madridDate(ms int64) string {
	c := getDateComponents(ms)
	return ymd(c.Year, c.Month, c.Day)
}

// ---------------------------------------------------------------------------
// seasonCalendar

const dataKnownFrom = "2026-01-01"

type seasonWindow struct {
	From         string
	To           string
	Season       string
	Source       string
	Title        any // string or nil (notice windows only)
	WeekdaysOnly bool
	isConfig     bool
}

func (w *seasonWindow) toObj() *Obj {
	if w == nil {
		return nil
	}
	if w.isConfig {
		return O("from", w.From, "to", w.To, "season", w.Season, "source", w.Source, "weekdaysOnly", w.WeekdaysOnly)
	}
	return O("from", w.From, "to", w.To, "season", w.Season, "source", w.Source, "title", w.Title)
}

var summerWindows = []*seasonWindow{
	{From: "2026-07-27", To: "2026-08-23", Season: "summer", Source: `notice 1505 "HORARIS ESTIU 2026"`, WeekdaysOnly: true, isConfig: true},
}

var (
	noticeWindowsMu sync.RWMutex
	noticeWindows   []*seasonWindow
)

func madridDateKey(ms int64) string {
	c := getDateComponents(ms)
	return strconv.Itoa(c.Year) + "-" + pad2(c.Month) + "-" + pad2(c.Day)
}

func within(key, from, to string) bool { return key >= from && key <= to }

// registerSeasonWindow records a window learned from a live operator notice.
func registerSeasonWindow(from, to, season, title string) bool {
	if from == "" || to == "" {
		return false
	}
	if season != "summer" && season != "winter" {
		return false
	}
	noticeWindowsMu.Lock()
	defer noticeWindowsMu.Unlock()
	for _, w := range noticeWindows {
		if w.From == from && w.To == to && w.Season == season {
			return false
		}
	}
	w := &seasonWindow{From: from, To: to, Season: season, Source: "notice", Title: nil}
	if title != "" {
		w.Source = `notice "` + title + `"`
		w.Title = title
	}
	noticeWindows = append(noticeWindows, w)
	return true
}

func noticeWindowCount() int {
	noticeWindowsMu.RLock()
	defer noticeWindowsMu.RUnlock()
	return len(noticeWindows)
}

type SeasonResolution struct {
	Season string
	Source string
	Known  bool
	Window *seasonWindow
}

func resolveSeason(ms int64) SeasonResolution {
	key := madridDateKey(ms)
	noticeWindowsMu.RLock()
	var covering []*seasonWindow
	for _, w := range noticeWindows {
		if within(key, w.From, w.To) {
			covering = append(covering, w)
		}
	}
	noticeWindowsMu.RUnlock()
	if len(covering) > 1 {
		return SeasonResolution{Season: "winter", Source: "ambiguous notice windows", Known: false}
	}
	if len(covering) == 1 {
		w := covering[0]
		return SeasonResolution{Season: w.Season, Source: w.Source, Known: true, Window: w}
	}
	for _, w := range summerWindows {
		if within(key, w.From, w.To) {
			return SeasonResolution{Season: "summer", Source: w.Source, Known: true, Window: w}
		}
	}
	return SeasonResolution{Season: "winter", Source: "default (no summer window covers this date)", Known: key >= dataKnownFrom}
}

func getSeasonOutlook(ms int64) *Obj {
	c := getDateComponents(ms)
	yearStr := strconv.Itoa(c.Year)
	dateKey := madridDateKey(ms)
	has := false
	for _, w := range summerWindows {
		if w.Season == "summer" && (strings.HasPrefix(w.From, yearStr) || strings.HasPrefix(w.To, yearStr)) {
			has = true
		}
	}
	noticeWindowsMu.RLock()
	for _, w := range noticeWindows {
		if w.Season == "summer" && (strings.HasPrefix(w.From, yearStr) || strings.HasPrefix(w.To, yearStr)) {
			has = true
		}
	}
	noticeWindowsMu.RUnlock()
	var warning any = nil
	if !has && dateKey >= yearStr+"-06-01" {
		warning = "Horari d'estiu " + yearStr + " no configurat"
	}
	return O("nextSummerConfigured", has, "warning", warning)
}

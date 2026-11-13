package main

// Port of src/core/time/timeEngine.js and calendarEngine.js.
// Instants are epoch milliseconds (int64). All wall-clock work is
// Europe/Madrid, read from the embedded tz database.

import (
	"math"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	_ "time/tzdata"
)

var madrid *time.Location

func init() {
	loc, err := time.LoadLocation("Europe/Madrid")
	if err != nil {
		panic(err)
	}
	madrid = loc
}

// ---------------------------------------------------------------------------
// Clock. Tests (and the differential harness) can freeze or offset it with
// ARRIBO_FAKE_EPOCH_MS (start instant) and ARRIBO_FAKE_RATE (0 = frozen).

var (
	clockOnce   sync.Once
	clockBase   int64
	clockStart  time.Time
	clockRate   float64
	clockFaked  bool
	processBorn = time.Now()
)

func nowMs() int64 {
	clockOnce.Do(func() {
		if v := os.Getenv("ARRIBO_FAKE_EPOCH_MS"); v != "" {
			if n, err := strconv.ParseInt(v, 10, 64); err == nil {
				clockFaked = true
				clockBase = n
				clockStart = time.Now()
				clockRate = 1
				if r := os.Getenv("ARRIBO_FAKE_RATE"); r != "" {
					if f, err := strconv.ParseFloat(r, 64); err == nil {
						clockRate = f
					}
				}
			}
		}
	})
	if clockFaked {
		return clockBase + int64(float64(time.Since(clockStart).Milliseconds())*clockRate)
	}
	return time.Now().UnixMilli()
}

func madridTime(ms int64) time.Time { return time.UnixMilli(ms).In(madrid) }

// ---------------------------------------------------------------------------
// timeEngine

// timeStringToMinutes: "HH:MM[:SS]" -> minutes since midnight, 0 when unparseable.
func timeStringToMinutes(s string) float64 {
	if s == "" {
		return 0
	}
	p := strings.Split(s, ":")
	return numOr0(partNum(p, 0))*60 + numOr0(partNum(p, 1))
}

func timeStringToSeconds(s string) float64 {
	if s == "" {
		return 0
	}
	p := strings.Split(s, ":")
	return numOr0(partNum(p, 0))*3600 + numOr0(partNum(p, 1))*60 + numOr0(partNum(p, 2))
}

func partNum(p []string, i int) float64 {
	if i >= len(p) {
		return math.NaN() // undefined || 0
	}
	return stringToNumber(p[i])
}

func numOr0(f float64) float64 {
	if math.IsNaN(f) || f == 0 {
		return 0
	}
	return f
}

// minutesToTimeString: minutes -> "HH:MM" (hours not wrapped).
// Arithmetic stays in doubles, as in JS, so absurd inputs format the same.
func minutesToTimeString(total float64) string {
	n := math.Max(0, jsRound(numOr0(total)))
	h := math.Floor(n / 60)
	m := math.Mod(n, 60)
	return pad2f(h) + ":" + pad2f(m)
}

// secondsToTimeString: seconds -> "HH:MM:SS", hours wrapped at 24.
func secondsToTimeString(total float64) string {
	n := math.Max(0, math.Floor(numOr0(total)))
	h := math.Mod(math.Floor(n/3600), 24)
	m := math.Floor(math.Mod(n, 3600) / 60)
	s := math.Mod(n, 60)
	return pad2f(h) + ":" + pad2f(m) + ":" + pad2f(s)
}

// pad2f is String(n).padStart(2, '0') for a double.
func pad2f(f float64) string { return padStart(numToString(f), 2, "0") }

// NetworkTime is getNetworkTime(): wall-clock fields in Madrid.
type NetworkTime struct {
	Ms         int64
	Year       int
	Month      int // 0-indexed
	Month1     int
	Day        int
	Hour       int
	Minute     int
	Second     int
	CurrentSec int
	DateStr    string
	TimeStr    string
	DayOfWeek  int
}

func getNetworkTime(ms int64) NetworkTime {
	t := madridTime(ms)
	nt := NetworkTime{
		Ms:        ms,
		Year:      t.Year(),
		Month:     int(t.Month()) - 1,
		Month1:    int(t.Month()),
		Day:       t.Day(),
		Hour:      t.Hour(),
		Minute:    t.Minute(),
		Second:    t.Second(),
		DayOfWeek: int(t.Weekday()),
	}
	nt.CurrentSec = nt.Hour*3600 + nt.Minute*60 + nt.Second
	nt.DateStr = strconv.Itoa(nt.Year) + pad2(nt.Month1) + pad2(nt.Day)
	nt.TimeStr = pad2(nt.Hour) + ":" + pad2(nt.Minute)
	return nt
}

// dateUTC is Date.UTC(y, monthIndex, d, h, mi, s) with overflow normalization.
func dateUTC(y, mon, d, h, mi, s int) int64 {
	// Date.UTC reads a year of 0..99 as 1900..1999.
	if y >= 0 && y <= 99 {
		y += 1900
	}
	return time.Date(y, time.Month(mon+1), d, h, mi, s, 0, time.UTC).UnixMilli()
}

// localTimeToUtcDate converts a Madrid wall-clock time to an instant using the
// same five-step fixed-point correction as the JavaScript (which differs from
// time.Date for nonexistent spring-forward times).
func localTimeToUtcDate(y, mon, d, h, mi, s int) int64 {
	target := dateUTC(y, mon, d, h, mi, s)
	guess := target
	for i := 0; i < 5; i++ {
		t := madridTime(guess)
		inv := dateUTC(t.Year(), int(t.Month())-1, t.Day(), t.Hour(), t.Minute(), t.Second())
		diff := inv - target
		if diff == 0 {
			break
		}
		guess -= diff
	}
	return guess
}

// formatTimeToTimezone: "HH:MM" in Madrid, or "--:--" for no/invalid/pre-2000 dates.
func formatTimeToTimezone(ms int64, ok bool) string {
	if !ok {
		return "--:--"
	}
	if time.UnixMilli(ms).UTC().Year() < 2000 {
		return "--:--"
	}
	t := madridTime(ms)
	return pad2(t.Hour()) + ":" + pad2(t.Minute())
}

// isoString is Date.prototype.toISOString().
func isoString(ms int64) string {
	t := time.UnixMilli(ms).UTC()
	y := t.Year()
	var ys string
	if y >= 0 && y <= 9999 {
		ys = padStart(strconv.Itoa(y), 4, "0")
	} else if y < 0 {
		ys = "-" + padStart(strconv.Itoa(-y), 6, "0")
	} else {
		ys = "+" + padStart(strconv.Itoa(y), 6, "0")
	}
	return ys + "-" + pad2(int(t.Month())) + "-" + pad2(t.Day()) + "T" + pad2(t.Hour()) + ":" + pad2(t.Minute()) + ":" + pad2(t.Second()) + "." + padStart(strconv.Itoa(t.Nanosecond()/1e6), 3, "0") + "Z"
}

// parseDateJS is Date.parse for the forms this codebase produces or receives:
// ISO 8601 (date-only = UTC, date-time without offset = local Madrid time),
// with optional fraction and offset. ok=false for anything else.
func parseDateJS(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	// Date-only forms are UTC.
	for _, layout := range []string{"2006-01-02", "2006-01", "2006"} {
		if len(s) == len(layout) {
			if t, err := time.ParseInLocation(layout, s, time.UTC); err == nil {
				return t.UnixMilli(), true
			}
		}
	}
	norm := s
	if i := strings.IndexByte(norm, ' '); i == 10 {
		norm = norm[:10] + "T" + norm[11:]
	}
	hasZone := strings.HasSuffix(norm, "Z") || strings.HasSuffix(norm, "z")
	if !hasZone && len(norm) > 19 {
		tail := norm[19:]
		if i := strings.LastIndexAny(tail, "+-"); i >= 0 {
			hasZone = true
		}
	}
	if !hasZone && len(norm) >= 16 && len(norm) > 10 && norm[10] == 'T' {
		// Local time (container TZ is Europe/Madrid).
		for _, layout := range []string{"2006-01-02T15:04:05.999999999", "2006-01-02T15:04:05", "2006-01-02T15:04"} {
			if t, err := time.ParseInLocation(layout, norm, madrid); err == nil {
				return t.UnixMilli(), true
			}
		}
		return 0, false
	}
	n := strings.Replace(norm, "z", "Z", 1)
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04Z07:00", "2006-01-02T15:04:05.999999999Z0700", "2006-01-02T15:04:05Z0700"} {
		if t, err := time.Parse(layout, n); err == nil {
			return t.UnixMilli(), true
		}
	}
	return 0, false
}

// ---------------------------------------------------------------------------
// calendarEngine

type DateComponents struct {
	DateStr    string
	MMDD       string
	Year       int
	Month      int // 1-12
	MonthIndex int
	Day        int
	DayOfWeek  int
	Hour       int
	Minute     int
	Second     int
	TimeStr    string
	IsWeekend  bool
	IsSunday   bool
	IsSaturday bool
	IsWeekday  bool
	IsAugust   bool
}

func getDateComponents(ms int64) DateComponents {
	t := madridTime(ms)
	c := DateComponents{
		Year:   t.Year(),
		Month:  int(t.Month()),
		Day:    t.Day(),
		Hour:   t.Hour(),
		Minute: t.Minute(),
		Second: t.Second(),
	}
	c.MonthIndex = c.Month - 1
	c.DayOfWeek = int(time.Date(c.Year, t.Month(), c.Day, 0, 0, 0, 0, time.UTC).Weekday())
	c.IsSunday = c.DayOfWeek == 0
	c.IsSaturday = c.DayOfWeek == 6
	c.IsWeekend = c.IsSunday || c.IsSaturday
	c.IsWeekday = c.DayOfWeek >= 1 && c.DayOfWeek <= 5
	c.IsAugust = c.Month == 8
	c.DateStr = strconv.Itoa(c.Year) + pad2(c.Month) + pad2(c.Day)
	c.MMDD = pad2(c.Month) + pad2(c.Day)
	c.TimeStr = pad2(c.Hour) + ":" + pad2(c.Minute)
	return c
}

// serviceCalendarInfoBase is calendarEngine.getServiceCalendarInfo.
func serviceCalendarInfoBase(ms int64) *Obj {
	c := getDateComponents(ms)
	dayType := "weekday"
	name := "Feiner"
	if c.IsSunday {
		dayType, name = "sunday", "Diumenge"
	} else if c.IsSaturday {
		dayType, name = "saturday", "Dissabte"
	}
	return O(
		"serviceId", dayType,
		"dayType", dayType,
		"name", name,
		"isWeekend", c.IsWeekend,
		"calendarTag", name,
		"dateFormatted", pad2(c.Day)+"/"+pad2(c.Month)+"/"+strconv.Itoa(c.Year),
	)
}

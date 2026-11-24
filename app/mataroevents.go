package main

// Dated Mataró Bus diversions and stop closures (plan step 5.2) from the
// checked-in src/data/mataro_events.json. While its window is open, an event
// is served as a notice shaped like Avanza's (same keys) plus
// "source": "calendar", "startsAt" and "confidence", so the line view, its
// banner and /api/disruptions show it with no new client code; the stops it
// names are marked closed ("Desviada") in the line view.
//
// The events are added where the server reads notices (getDisruptions and
// the line view), never into the worker's Avanza notice list, so they are not
// re-parsed for validity from their text and nothing is stored in history.

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type mataroEvent struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Start       string   `json:"start"` // Madrid local "YYYY-MM-DD HH:MM"
	End         string   `json:"end"`   // exclusive
	Lines       []string `json:"lines"`
	Stops       []string `json:"stops"`
	Description string   `json:"description"`
	Source      string   `json:"source"`
	Confidence  string   `json:"confidence"`

	startMs, endMs int64
}

var (
	mataroEventsOnce sync.Once
	mataroEventList  []mataroEvent
)

// parseMadridMinute reads "YYYY-MM-DD HH:MM" as Europe/Madrid local time
// (a time that does not exist in spring, or that does not parse, is refused).
func parseMadridMinute(s string) (int64, bool) {
	t, err := time.Parse("2006-01-02 15:04", s)
	if err != nil {
		return 0, false
	}
	ms := localTimeToUtcDate(t.Year(), int(t.Month())-1, t.Day(), t.Hour(), t.Minute(), 0)
	back := time.UnixMilli(ms).In(madrid)
	if back.Hour() != t.Hour() || back.Minute() != t.Minute() {
		return 0, false
	}
	return ms, true
}

func readMataroEvents(path string) ([]mataroEvent, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var f struct {
		Events []mataroEvent `json:"events"`
	}
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, err
	}
	out := make([]mataroEvent, 0, len(f.Events))
	for _, e := range f.Events {
		s, ok1 := parseMadridMinute(e.Start)
		en, ok2 := parseMadridMinute(e.End)
		if !ok1 || !ok2 || en <= s || e.ID == "" || e.Title == "" {
			log.Printf("[Events] Skipping event %q: bad id, title or window", e.ID)
			continue
		}
		e.startMs, e.endMs = s, en
		out = append(out, e)
	}
	return out, nil
}

func mataroEvents() []mataroEvent {
	mataroEventsOnce.Do(func() {
		list, err := readMataroEvents(filepath.Join(srcDataDir(), "mataro_events.json"))
		if err != nil {
			if !os.IsNotExist(err) {
				log.Printf("[Events] Could not load mataro_events.json: %v", err)
			}
			return
		}
		mataroEventList = list
	})
	return mataroEventList
}

func (e *mataroEvent) activeAt(ms int64) bool { return ms >= e.startMs && ms < e.endMs }

func (e *mataroEvent) hasLine(lineID string) bool {
	for _, l := range e.Lines {
		if l == lineID {
			return true
		}
	}
	return false
}

func (e *mataroEvent) notice() *Obj {
	affected := any("Informació General")
	if len(e.Lines) > 0 {
		parts := make([]string, len(e.Lines))
		for i, l := range e.Lines {
			parts[i] = "L" + l
		}
		affected = strings.Join(parts, ", ")
	}
	return O(
		"id", "calendar_"+e.ID,
		"title", e.Title,
		"description", e.Description,
		"linesAffected", stringsToAny(e.Lines),
		"affectedLines", affected,
		"agency", "Ajuntament de Mataró",
		"severity", "warning",
		"isSpecific", len(e.Lines) > 0,
		"url", strOrNil(e.Source),
		"expiresAt", isoString(e.endMs),
		"active", true,
		"source", "calendar",
		"startsAt", isoString(e.startMs),
		"confidence", strOrNil(e.Confidence),
	)
}

// calendarNotices is the events open at ms as notices: for a line (lineID
// not ""), those naming it, as getDisruptions does for Avanza's warnings;
// otherwise all of them.
func calendarNotices(lineID string, ms int64) []any {
	out := []any{}
	for i := range mataroEvents() {
		e := &mataroEventList[i]
		if !e.activeAt(ms) || (lineID != "" && !e.hasLine(lineID)) {
			continue
		}
		out = append(out, e.notice())
	}
	return out
}

// calendarClosedStops is the stops of a line closed by an event open at ms
// (stop id -> event title). An event with no lines closes its stops on every
// line.
func calendarClosedStops(lineID string, ms int64) map[string]string {
	var out map[string]string
	for i := range mataroEvents() {
		e := &mataroEventList[i]
		if !e.activeAt(ms) || len(e.Stops) == 0 || (len(e.Lines) > 0 && !e.hasLine(lineID)) {
			continue
		}
		if out == nil {
			out = map[string]string{}
		}
		for _, s := range e.Stops {
			if _, seen := out[s]; !seen {
				out[s] = e.Title
			}
		}
	}
	return out
}

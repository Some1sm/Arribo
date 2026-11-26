package main

// Rolling 24-hour per-stop schedule cache for Moventis lines
// (DATA_DIR/moventis/schedules.json).
//
// Every GetTiemposParada response (both background poller and interactive stop
// clicks) returns today's scheduled departure times ("real":"N", "hora":"HH:MM").
// Previously those were discarded after 30 seconds. This cache merges them by
// (lineID, stopID, dayType) and expires each stop on a staggered 20–24 h TTL
// (deterministic per stopID) so schedules drop off and refresh gradually across
// the day instead of all expiring at once, while never mixing weekday,
// Saturday, and Sunday timetables.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	movSchedMinTTL  = 20 * time.Hour
	movSchedJitterM = 240 // 0..239 min -> staggered 20h..24h expiry
	movSchedSaveGap = 2 * time.Minute
)

// movSchedEntry stores scheduled "HH:MM" departures by destination for one
// (lineID, stopID, dayType).
type movSchedEntry struct {
	ByDest    map[string][]string `json:"byDest"`
	FetchedAt time.Time           `json:"fetchedAt"`
	ExpiresAt time.Time           `json:"expiresAt"`
}

type movSchedStore struct {
	mu       sync.Mutex
	path     string
	entries  map[string]*movSchedEntry // "lineID:stopID:dayType"
	dirty    bool
	lastSave time.Time
}

type movSchedFile struct {
	UpdatedAt time.Time                 `json:"updatedAt"`
	Entries   map[string]*movSchedEntry `json:"entries"`
}

func newMovSchedStore(dir string) *movSchedStore {
	s := &movSchedStore{
		entries: map[string]*movSchedEntry{},
	}
	if dir != "" {
		s.path = filepath.Join(dir, "schedules.json")
		s.load()
	}
	return s
}

// movDayType classifies a Madrid-local timestamp so weekday, Saturday, and
// Sunday/holiday schedules never bleed into each other.
func movDayType(now time.Time) string {
	if isHoliday(now.UnixMilli()) {
		return "sun"
	}
	switch now.In(madrid).Weekday() {
	case time.Saturday:
		return "sat"
	case time.Sunday:
		return "sun"
	default:
		return "wkd"
	}
}

func movSchedKey(lineID, stopID int, dayType string) string {
	return strconv.Itoa(lineID) + ":" + strconv.Itoa(stopID) + ":" + dayType
}

// movSchedTTL returns a deterministic 20–24 h TTL per stop so cached
// schedules expire gradually over the day instead of all at once.
func movSchedTTL(stopID int) time.Duration {
	if stopID < 0 {
		stopID = -stopID
	}
	jitter := time.Duration((stopID*37)%movSchedJitterM) * time.Minute
	return movSchedMinTTL + jitter
}

func (s *movSchedStore) load() {
	if s.path == "" {
		return
	}
	b, err := os.ReadFile(s.path)
	if err != nil {
		return
	}
	var f movSchedFile
	if err := json.Unmarshal(b, &f); err != nil || f.Entries == nil {
		return
	}
	now := time.Now()
	for k, e := range f.Entries {
		if e != nil && len(e.ByDest) > 0 && now.Before(e.ExpiresAt) {
			s.entries[k] = e
		}
	}
}

func (s *movSchedStore) save(force bool) {
	if s == nil || s.path == "" {
		return
	}
	s.mu.Lock()
	if !s.dirty || (!force && time.Since(s.lastSave) < movSchedSaveGap) {
		s.mu.Unlock()
		return
	}
	now := time.Now()
	cp := make(map[string]*movSchedEntry, len(s.entries))
	for k, e := range s.entries {
		if e == nil || now.After(e.ExpiresAt) {
			delete(s.entries, k)
			continue
		}
		bd := make(map[string][]string, len(e.ByDest))
		for d, times := range e.ByDest {
			bd[d] = append([]string(nil), times...)
		}
		cp[k] = &movSchedEntry{ByDest: bd, FetchedAt: e.FetchedAt, ExpiresAt: e.ExpiresAt}
	}
	s.dirty = false
	s.lastSave = now
	s.mu.Unlock()

	b, err := json.Marshal(movSchedFile{UpdatedAt: now, Entries: cp})
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(s.path), 0o755)
	tmp := s.path + ".tmp"
	if os.WriteFile(tmp, b, 0o644) == nil {
		_ = os.Rename(tmp, s.path)
	}
}

// record merges any scheduled ("real":"N") departures from a GetTiemposParada
// response into the rolling cache. Existing times for the same dayType are
// merged so repeated observations over the day accumulate the full day's
// timetable, while expired entries are replaced cleanly.
func (s *movSchedStore) record(stopID int, etas []movStopETA, now time.Time) {
	if s == nil || stopID <= 0 || len(etas) == 0 {
		return
	}
	dt := movDayType(now)
	changed := false
	s.mu.Lock()
	for _, e := range etas {
		if e.LineID <= 0 || len(e.Sched) == 0 {
			continue
		}
		k := movSchedKey(e.LineID, stopID, dt)
		ent := s.entries[k]
		if ent == nil || now.After(ent.ExpiresAt) {
			ent = &movSchedEntry{
				ByDest:    map[string][]string{},
				FetchedAt: now,
				ExpiresAt: now.Add(movSchedTTL(stopID)),
			}
			s.entries[k] = ent
		}
		dest := strings.TrimSpace(e.Dest)
		seen := map[string]bool{}
		for _, t := range ent.ByDest[dest] {
			seen[t] = true
		}
		added := false
		for _, t := range e.Sched {
			t = strings.TrimSpace(t)
			if t != "" && !seen[t] {
				seen[t] = true
				ent.ByDest[dest] = append(ent.ByDest[dest], t)
				added = true
			}
		}
		if added {
			sort.Strings(ent.ByDest[dest])
			ent.FetchedAt = now
			changed = true
		}
	}
	if changed {
		s.dirty = true
	}
	s.mu.Unlock()
	if changed {
		s.save(false)
	}
}

// lookup returns cached scheduled departures (by destination) for
// (lineID, stopID) on now's dayType, or nil if absent or expired.
func (s *movSchedStore) lookup(lineID, stopID int, now time.Time) map[string][]string {
	if s == nil || lineID <= 0 || stopID <= 0 {
		return nil
	}
	k := movSchedKey(lineID, stopID, movDayType(now))
	s.mu.Lock()
	defer s.mu.Unlock()
	ent := s.entries[k]
	if ent == nil {
		return nil
	}
	if now.After(ent.ExpiresAt) {
		delete(s.entries, k)
		s.dirty = true
		return nil
	}
	out := make(map[string][]string, len(ent.ByDest))
	for d, times := range ent.ByDest {
		out[d] = append([]string(nil), times...)
	}
	return out
}

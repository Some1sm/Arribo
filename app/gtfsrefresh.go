package main

// Keeps each GTFS-RT operator's imported timetable fresh (phase 2, slice 3b
// of docs/catalonia-review/REPORT.md): download the operator's static GTFS
// zip and run the gtfs-import code on it into <gtfsDir>/<agency_id>.db, at
// start-up when the file is missing or stale and then whenever it gets
// stale again. Runs only with the pollers (ARRIBO_GTFSRT=1), one import at
// a time to keep the memory peak to one feed.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

const (
	gtfsStaleAfter   = 20 * time.Hour // re-import a timetable older than this
	gtfsCheckEvery   = time.Hour      // how often staleness is checked
	gtfsMaxZipBytes  = 128 << 20
	gtfsDownloadTime = 5 * time.Minute
)

// gtfsDir is where imported timetables live: ARRIBO_GTFS_DIR, else
// <DATA_DIR>/gtfs (DATA_DIR defaults as for the history database).
func gtfsDir() string {
	if d := os.Getenv("ARRIBO_GTFS_DIR"); d != "" {
		return d
	}
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = filepath.Join(appRoot, "data")
	}
	return filepath.Join(dataDir, "gtfs")
}

func gtfsTimetablePath(agencyID string) string {
	return filepath.Join(gtfsDir(), agencyID+".db")
}

// gtfsStale reports whether the timetable is missing or older than maxAge.
func gtfsStale(path string, maxAge time.Duration) bool {
	fi, err := os.Stat(path)
	return err != nil || time.Since(fi.ModTime()) > maxAge
}

// downloadFile streams url into path (via path.tmp and a rename), at most
// gtfsMaxZipBytes. Errors never include the URL or headers.
func downloadFile(ctx context.Context, url, path string) error {
	return downloadFileHeaders(ctx, url, path, nil)
}

func downloadFileHeaders(ctx context.Context, url, path string, headers map[string]string) error {
	ctx, cancel := context.WithTimeout(ctx, gtfsDownloadTime)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return errors.New("bad request")
	}
	req.Header.Set("User-Agent", "arribo-gtfs/1")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return errors.New(nodeErrMessage(err))
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	n, err := io.Copy(f, io.LimitReader(res.Body, gtfsMaxZipBytes+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil && n > gtfsMaxZipBytes {
		err = errors.New("zip too large")
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

// refreshTimetable downloads and imports one operator's static GTFS.
func refreshTimetable(ctx context.Context, src rtSource) error {
	return refreshTimetableWithZip(ctx, src, "")
}

func refreshTimetableWithZip(ctx context.Context, src rtSource, sharedZip string) error {
	if err := os.MkdirAll(gtfsDir(), 0o755); err != nil {
		return err
	}
	var bbox *bboxFilter
	if src.staticBBox != "" {
		b, err := parseBBox(src.staticBBox)
		if err != nil {
			return err
		}
		bbox = b
	}
	db := gtfsTimetablePath(src.AgencyID)
	zipPath := sharedZip
	if zipPath == "" {
		zipPath = db + ".zip"
		defer os.Remove(zipPath)
		if err := downloadFileHeaders(ctx, src.staticURL, zipPath, src.staticHeaders); err != nil {
			return fmt.Errorf("download: %w", err)
		}
	}
	return importGTFSContext(ctx, src.AgencyID, zipPath, db, bbox, src.staticBBox, src.staticRouteFilter)
}

// runTimetableRefresher imports stale timetables now and keeps checking
// until ctx ends. Sources sharing the same staticURL (e.g. NAP 2059 for
// tus_sabadell, rubibus, and atm_urban) download the zip once per pass.
func runTimetableRefresher(ctx context.Context, srcs []rtSource) {
	check := func() {
		var due []rtSource
		urlCounts := map[string]int{}
		for _, src := range srcs {
			if src.staticURL == "" || ctx.Err() != nil {
				continue
			}
			p := gtfsTimetablePath(src.AgencyID)
			if !gtfsStale(p, gtfsStaleAfter) && gtfsImportCurrent(p, src.staticBBox, src.staticRouteFilter) {
				continue
			}
			due = append(due, src)
			urlCounts[src.staticURL]++
		}
		sharedZips := map[string]string{}
		defer func() {
			for _, zp := range sharedZips {
				_ = os.Remove(zp)
			}
		}()
		for _, src := range due {
			if ctx.Err() != nil {
				return
			}
			start := time.Now()
			zipPath := ""
			if urlCounts[src.staticURL] > 1 {
				if existing, ok := sharedZips[src.staticURL]; ok {
					zipPath = existing
				} else {
					if err := os.MkdirAll(gtfsDir(), 0o755); err != nil {
						log.Printf("[GTFS] %s: timetable refresh failed: %v", src.AgencyID, err)
						continue
					}
					zp := gtfsTimetablePath(src.AgencyID) + ".shared.zip"
					if err := downloadFileHeaders(ctx, src.staticURL, zp, src.staticHeaders); err != nil {
						log.Printf("[GTFS] %s: timetable refresh failed: download: %v", src.AgencyID, err)
						continue
					}
					sharedZips[src.staticURL] = zp
					zipPath = zp
				}
			}
			if err := refreshTimetableWithZip(ctx, src, zipPath); err != nil {
				log.Printf("[GTFS] %s: timetable refresh failed: %v", src.AgencyID, err)
				continue
			}
			log.Printf("[GTFS] %s: timetable imported in %v", src.AgencyID, time.Since(start).Round(time.Millisecond))
		}
	}
	check()
	t := time.NewTicker(gtfsCheckEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			check()
		}
	}
}

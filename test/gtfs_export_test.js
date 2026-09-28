'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { exportGtfs } = require('../scripts/export_gtfs');

function parseCsv(content) {
  const lines = content.trim().split(/\r?\n/);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseCsvLine(lines[i]);
    const row = {};
    header.forEach((h, idx) => {
      row[h] = values[idx] ?? '';
    });
    rows.push(row);
  }
  return rows;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        out.push(cur);
        cur = '';
      } else {
        cur += c;
      }
    }
  }
  out.push(cur);
  return out;
}

function timeToSec(timeStr) {
  const [h, m, s] = timeStr.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-gtfs-test-'));

try {
  // 1. Run export into temporary scratch directory
  const summary = exportGtfs(scratch);

  assert.equal(summary.agencyCount, 1, 'Agency count should be 1');
  assert.equal(summary.routesCount, 8, 'Routes count should be 8');
  assert(summary.stopsCount > 100, `Stops count should be > 100, got ${summary.stopsCount}`);
  assert(summary.tripsCount > 1000, `Trips count should be > 1000, got ${summary.tripsCount}`);
  assert(summary.stopTimesCount > 10000, `Stop times count should be > 10000, got ${summary.stopTimesCount}`);

  // 2. Validate existence of all 8 GTFS tables
  const expectedFiles = [
    'agency.txt',
    'routes.txt',
    'stops.txt',
    'calendar.txt',
    'calendar_dates.txt',
    'trips.txt',
    'stop_times.txt',
    'feed_info.txt'
  ];
  for (const f of expectedFiles) {
    const p = path.join(scratch, f);
    assert(fs.existsSync(p), `Missing GTFS file: ${f}`);
    assert(fs.statSync(p).size > 0, `GTFS file ${f} is empty`);
  }

  // 3. Validate agency.txt
  const agencyRows = parseCsv(fs.readFileSync(path.join(scratch, 'agency.txt'), 'utf8'));
  assert.equal(agencyRows.length, 1);
  assert.equal(agencyRows[0].agency_id, 'MAT_1');
  assert.equal(agencyRows[0].agency_timezone, 'Europe/Madrid');

  // 4. Validate routes.txt
  const routeRows = parseCsv(fs.readFileSync(path.join(scratch, 'routes.txt'), 'utf8'));
  assert.equal(routeRows.length, 8);
  const routeIds = new Set(routeRows.map(r => r.route_id));
  for (let l = 1; l <= 8; l++) {
    assert(routeIds.has(String(l)), `Route ${l} must exist in routes.txt`);
  }

  // 5. Validate stops.txt
  const stopRows = parseCsv(fs.readFileSync(path.join(scratch, 'stops.txt'), 'utf8'));
  assert(stopRows.length >= 150, `Expected >= 150 stops, got ${stopRows.length}`);
  const stopIds = new Set();
  for (const s of stopRows) {
    assert(s.stop_id, 'stop_id must be non-empty');
    assert(s.stop_name, `stop_name must be non-empty for ${s.stop_id}`);
    const lat = Number(s.stop_lat);
    const lon = Number(s.stop_lon);
    assert(Number.isFinite(lat) && lat >= 41.45 && lat <= 41.65, `Stop ${s.stop_id} lat out of Mataró bounds: ${lat}`);
    assert(Number.isFinite(lon) && lon >= 2.30 && lon <= 2.55, `Stop ${s.stop_id} lon out of Mataró bounds: ${lon}`);
    stopIds.add(s.stop_id);
  }

  // 6. Validate calendar.txt & calendar_dates.txt
  const calendarRows = parseCsv(fs.readFileSync(path.join(scratch, 'calendar.txt'), 'utf8'));
  const serviceIds = new Set(calendarRows.map(c => c.service_id));
  assert(serviceIds.has('winter_weekday'), 'winter_weekday must exist');
  assert(serviceIds.has('summer_weekday'), 'summer_weekday must exist');

  const calendarDateRows = parseCsv(fs.readFileSync(path.join(scratch, 'calendar_dates.txt'), 'utf8'));
  assert(calendarDateRows.length > 0, 'calendar_dates.txt must contain exceptions');
  for (const cd of calendarDateRows) {
    assert(serviceIds.has(cd.service_id), `calendar_dates service_id ${cd.service_id} must exist in calendar.txt`);
    assert(['1', '2'].includes(cd.exception_type), `exception_type must be 1 or 2, got ${cd.exception_type}`);
    assert(/^\d{8}$/.test(cd.date), `date must be YYYYMMDD, got ${cd.date}`);
  }

  // 7. Validate trips.txt
  const tripRows = parseCsv(fs.readFileSync(path.join(scratch, 'trips.txt'), 'utf8'));
  assert(tripRows.length >= 1000, `Expected >= 1000 trips, got ${tripRows.length}`);
  const tripIds = new Set();
  for (const tr of tripRows) {
    assert(tr.trip_id, 'trip_id must be non-empty');
    assert(!tripIds.has(tr.trip_id), `Duplicate trip_id found: ${tr.trip_id}`);
    tripIds.add(tr.trip_id);
    assert(routeIds.has(tr.route_id), `Trip ${tr.trip_id} route_id ${tr.route_id} must exist in routes.txt`);
    assert(serviceIds.has(tr.service_id), `Trip ${tr.trip_id} service_id ${tr.service_id} must exist in calendar.txt`);
    assert(['0', '1'].includes(tr.direction_id), `Trip ${tr.trip_id} direction_id must be 0 or 1, got ${tr.direction_id}`);
  }

  // 8. Validate stop_times.txt referential integrity & non-decreasing times
  const stopTimeRows = parseCsv(fs.readFileSync(path.join(scratch, 'stop_times.txt'), 'utf8'));
  assert(stopTimeRows.length >= 10000, `Expected >= 10000 stop_times, got ${stopTimeRows.length}`);

  const tripStopTimes = new Map();
  for (const st of stopTimeRows) {
    assert(tripIds.has(st.trip_id), `stop_time trip_id ${st.trip_id} must exist in trips.txt`);
    assert(stopIds.has(st.stop_id), `stop_time stop_id ${st.stop_id} must exist in stops.txt`);
    assert(/^\d{2}:\d{2}:\d{2}$/.test(st.arrival_time), `Invalid arrival_time: ${st.arrival_time}`);
    assert(/^\d{2}:\d{2}:\d{2}$/.test(st.departure_time), `Invalid departure_time: ${st.departure_time}`);

    if (!tripStopTimes.has(st.trip_id)) {
      tripStopTimes.set(st.trip_id, []);
    }
    tripStopTimes.get(st.trip_id).push(st);
  }

  // Check every trip has >= 2 stop_times and times are non-decreasing
  for (const [tripId, times] of tripStopTimes.entries()) {
    assert(times.length >= 2, `Trip ${tripId} has ${times.length} stop_times (must have >= 2)`);

    for (let i = 0; i < times.length; i++) {
      const seq = Number(times[i].stop_sequence);
      assert.equal(seq, i + 1, `Trip ${tripId} stop_sequence must be 1-indexed sequential (got ${seq} at index ${i})`);

      const arrSec = timeToSec(times[i].arrival_time);
      const depSec = timeToSec(times[i].departure_time);
      assert(arrSec <= depSec, `Trip ${tripId} stop ${times[i].stop_id} arrival > departure (${times[i].arrival_time} > ${times[i].departure_time})`);

      if (i > 0) {
        const prevDepSec = timeToSec(times[i - 1].departure_time);
        assert(prevDepSec <= arrSec, `Trip ${tripId} decreasing times from stop ${times[i - 1].stop_id} (${times[i - 1].departure_time}) to stop ${times[i].stop_id} (${times[i].arrival_time})`);
      }
    }
  }

  // Check every trip in trips.txt has stop_times
  for (const tripId of tripIds) {
    assert(tripStopTimes.has(tripId), `Trip ${tripId} defined in trips.txt has zero stop_times`);
  }

  // 9. Validate feed_info.txt
  const feedInfoRows = parseCsv(fs.readFileSync(path.join(scratch, 'feed_info.txt'), 'utf8'));
  assert.equal(feedInfoRows.length, 1);
  assert.equal(feedInfoRows[0].feed_publisher_name, 'Arribo! Transit Platform');
  assert.equal(feedInfoRows[0].feed_lang, 'ca');

  console.log('RESULT: test/gtfs_export_test.js passed (all 9 referential integrity & GTFS checks verified).');
} finally {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
}

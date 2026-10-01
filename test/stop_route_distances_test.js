'use strict';

/**
 * test/stop_route_distances_test.js
 *
 * Each stop's distance fields are measured along the drawn route and its
 * travel time is the published one (scripts/stop_route_distances.js). They
 * used to be straight lines (8-28 % short of the route) and an 8 m/s estimate
 * (67 s to Ronda Barceló where the timetable says 120 s), plus a made-up dwell.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { haversine } = require('../scripts/stop_route_distances');

const files = {
  legacy: require('../src/data/mataro_schedules.json'),
  ...Object.fromEntries(Object.entries(require('../src/data/mataro_schedules.seasons.json').seasons))
};

const check = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'stop_route_distances.js'), '--check'], { encoding: 'utf8' });
assert.equal(check.status, 0, `the timetable files match the route and the timetable:\n${check.stdout}${check.stderr}`);
assert.ok(!/note:/.test(check.stdout), `no stop is far from its route:\n${check.stdout}`);
console.log('  ✓ scripts/stop_route_distances.js --check: nothing to change');

let directions = 0;
for (const [name, grid] of Object.entries(files)) {
  for (const [lineId, line] of Object.entries(grid)) {
    if (lineId === '_meta') continue;
    for (const [dirKey, dir] of Object.entries(line.directions)) {
      if (dir._invalid) continue; // known-corrupt legacy duplicates, refused at load
      directions++;
      const offsets = (dir.dayStopTravelSec && dir.dayStopTravelSec.weekday) || dir.stopTravelSecMap;
      dir.stops.forEach((s, i) => {
        assert.equal(s.dwellSec, undefined, `${name} L${lineId} ${dirKey} ${s.name}: no invented dwell`);
        assert.equal(s.travelSec, offsets[s.id], `${name} L${lineId} ${dirKey} ${s.name}: travelSec is the published offset`);
        if (i === 0) return assert.equal(s.cumulativeMeters, 0);
        const straight = haversine([dir.stops[i - 1].lat, dir.stops[i - 1].lon], [s.lat, s.lon]);
        assert.ok(s.segmentMeters >= straight * 0.95 - 10, `${name} L${lineId} ${dirKey} ${s.name}: ${s.segmentMeters} m along the route is not shorter than ${Math.round(straight)} m straight`);
      });
      const last = dir.stops[dir.stops.length - 1].cumulativeMeters;
      assert.ok(last <= dir.totalDistanceMeters && last >= dir.totalDistanceMeters * 0.9,
        `${name} L${lineId} ${dirKey}: ${last} m between the end stops, route drawn ${dir.totalDistanceMeters} m`);
    }
  }
}
const l1 = files.winter['1'].directions['11'];
assert.equal(l1.stops[1].name, 'Ronda Barceló');
assert.equal(l1.stops[1].travelSec, 120);
assert.equal(l1.stops[l1.stops.length - 1].cumulativeMeters, 7600, 'L1 Rodalies -> Hospital: 7,600 m along the route (straight lines said 6,054)');
console.log(`  ✓ ${directions} directions: along-route distances within 10 % of the drawn route, published travel times, no dwell`);
console.log('🎉 ALL STOP ROUTE DISTANCE ASSERTIONS PASSED!');

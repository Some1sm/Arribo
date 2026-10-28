'use strict';

const assert = require('node:assert/strict');
const bridge = require('../src/core/WorkerBridge');
bridge.start = () => {};
const ingestionDaemon = require('../src/ingestionDaemon');
const app = require('../server');
const http = require('node:http');

async function testDriftScheduleTiming() {
  console.log('📌 Testing drift schedule timing at 04:1x Europe/Madrid...');

  let checkCalled = 0;
  const originalCheck = ingestionDaemon.checkScheduleDrift;
  ingestionDaemon.checkScheduleDrift = async () => {
    checkCalled++;
    return { drift: false, checkedAt: new Date().toISOString(), differencesCount: 0 };
  };

  try {
    ingestionDaemon.lastDriftDate = null;

    // 03:30 Madrid (UTC 01:30 in Sept) -> should NOT trigger
    const at0330 = Date.UTC(2026, 8, 24, 1, 30, 0);
    ingestionDaemon.checkScheduleDriftSchedule(at0330);
    assert.equal(checkCalled, 0, 'Must not trigger at 03:30');

    // 04:15 Madrid (UTC 02:15 in Sept) -> MUST trigger
    const at0415 = Date.UTC(2026, 8, 24, 2, 15, 0);
    ingestionDaemon.checkScheduleDriftSchedule(at0415);
    assert.equal(checkCalled, 1, 'Must trigger at 04:15');

    // 04:18 Madrid same day -> MUST NOT trigger twice on the same date
    const at0418 = Date.UTC(2026, 8, 24, 2, 18, 0);
    ingestionDaemon.checkScheduleDriftSchedule(at0418);
    assert.equal(checkCalled, 1, 'Must not trigger twice on the same day');

    // 04:12 Madrid NEXT day (2026-09-25) -> MUST trigger again
    const atNextDay0412 = Date.UTC(2026, 8, 25, 2, 12, 0);
    ingestionDaemon.checkScheduleDriftSchedule(atNextDay0412);
    assert.equal(checkCalled, 2, 'Must trigger again on the next day');

    console.log('  ✓ Drift schedule timing operates strictly at 04:1x Madrid time without double-checks');
  } finally {
    ingestionDaemon.checkScheduleDrift = originalCheck;
  }
}

async function testHealthEndpointDrift() {
  console.log('📌 Testing /api/health schedule.drift contract...');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;

  const getHealth = () => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/api/health`, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });

  try {
    // 1. Initial / cold state: schedule.drift is null
    bridge.workerMetrics = {};
    const cold = await getHealth();
    assert.equal(cold.schedule.drift, null, 'Cold schedule.drift must be null');

    // 2. Populated drift status
    const mockDrift = {
      drift: false,
      checkedAt: '2026-09-28T04:15:00.000Z',
      differencesCount: 0
    };
    bridge.workerMetrics = { scheduleDrift: mockDrift };
    const withDrift = await getHealth();
    assert.deepEqual(withDrift.schedule.drift, mockDrift, 'schedule.drift must match workerMetrics.scheduleDrift');

    console.log('  ✓ /api/health exposes schedule.drift accurately');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

// Renders a shipped season grid back into the page shape maresme.net serves:
// one column per stop of both directions, one sNN{a,b,c} array per column and
// day type, and the first direction's origin named in the header cell.
const scraper = require('../scripts/scrape_maresme_timetables');
const shippedSeasons = JSON.parse(require('node:fs').readFileSync(scraper.OUTPUT_PATH, 'utf8')).seasons;
const currentGrid = JSON.parse(require('node:fs').readFileSync(scraper.CURRENT_PATH, 'utf8'));
const SEASON_OF = { hivern: 'winter', estiu: 'summer' };

function renderPage(seasonName, lineId, { dropLastColumn = false } = {}) {
  const line = shippedSeasons[seasonName][lineId];
  const order = scraper.realDirectionKeys(currentGrid[lineId]);
  const hhmm = sec => {
    const s = ((sec % 86400) + 86400) % 86400;
    return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
  };
  const arrays = [];
  let col = 0;
  for (const dirKey of order) {
    const dir = line.directions[dirKey];
    dir.stops.forEach((_, i) => {
      const name = String(col++).padStart(2, '0');
      for (const [slot, day] of [['a', 'weekday'], ['b', 'saturday'], ['c', 'sunday']]) {
        const cells = (dir.dayTrips[day] || []).map(t => (t.s[i] === null ? "'-----'" : `'${hhmm(t.s[i])}'`));
        arrays.push(`s${name}${slot} = new Array(${cells.join(',')});`);
      }
    });
  }
  if (dropLastColumn) arrays.splice(-3, 3);
  const origin = line.directions[order[0]].originStop.name;
  return `<td colspan="2" class="tc"><select name="s00"></select></td><td colspan="4">${origin}</td>\n<script>\n${arrays.join('\n')}\n</script>`;
}

function fakeMaresme(tweak = {}) {
  return async url => {
    const [, urlSeason, lineId] = url.match(/matarobus\/(\w+)\/index\.php\?l=es&id=(\d)/);
    const seasonName = SEASON_OF[urlSeason];
    if (tweak.page) {
      const html = tweak.page(seasonName, lineId);
      if (html) return html;
    }
    return renderPage(seasonName, lineId);
  };
}

async function testDriftCheckEndToEnd() {
  console.log('📌 Testing checkScheduleDrift against offline maresme.net pages...');
  ingestionDaemon.scheduleDrift = null;

  // 1. The published grid equals the shipped file: no drift.
  const same = await ingestionDaemon.checkScheduleDrift({ fetchPage: fakeMaresme() });
  assert.equal(same.drift, false, 'identical grids must not report drift');
  assert.equal(same.differencesCount, 0);
  assert.equal(same.layoutError, undefined);
  assert.deepEqual(ingestionDaemon.scheduleDrift, same, 'the result is kept for /api/health');

  // 2. One published time moves a minute: drift, counted.
  const original = shippedSeasons.winter['4'].directions['11'].dayTrips.weekday[0].s[2];
  shippedSeasons.winter['4'].directions['11'].dayTrips.weekday[0].s[2] = original + 60;
  let moved;
  try {
    moved = await ingestionDaemon.checkScheduleDrift({ fetchPage: fakeMaresme() });
  } finally {
    shippedSeasons.winter['4'].directions['11'].dayTrips.weekday[0].s[2] = original;
  }
  assert.equal(moved.drift, true, 'a changed published time is drift');
  assert(moved.differencesCount >= 1, `expected differences, got ${moved.differencesCount}`);
  assert.equal(moved.layoutError, undefined);

  // 3. A stop column appears or disappears (a new stop): drift with layoutError,
  //    not a silent failure.
  const reshaped = await ingestionDaemon.checkScheduleDrift({
    fetchPage: fakeMaresme({ page: (s, l) => (s === 'winter' && l === '1' ? renderPage(s, l, { dropLastColumn: true }) : null) })
  });
  assert.equal(reshaped.drift, true, 'a grid whose shape changed is drift');
  assert.match(reshaped.layoutError, /^L1 winter: column count \d+ != \d+ \+ \d+ stops$/);

  // 4. The site is unreachable: no verdict, the previous result stays.
  const unreachable = await ingestionDaemon.checkScheduleDrift({ fetchPage: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(unreachable, null, 'a fetch failure is not a drift verdict');
  assert.deepEqual(ingestionDaemon.scheduleDrift, reshaped, 'the last real result is kept');

  console.log('  ✓ Drift check scrapes both seasons, counts changed grids, flags reshaped grids, ignores fetch failures');
}

async function main() {
  await testDriftScheduleTiming();
  await testHealthEndpointDrift();
  await testDriftCheckEndToEnd();
  console.log('\n🎉 ALL SCHEDULE DRIFT TESTS PASSED!\n');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

'use strict';
/**
 * test/calendar_and_notices_test.js
 *
 * Which timetable a day runs, how the stop view names it, and what the
 * operator's notices say.
 *
 *  1. Summer is a season, not a day type: an August weekday runs the summer
 *     weekday grid (69 L1 trips on 5 Aug 2026), not the Saturday one (37), and
 *     a weekday after the summer window runs the winter weekday grid.
 *  2. Catalan dates elide "de" before a vowel ("23 d'agost"). The real summer
 *     notice parsed with no dates, so it never expired and never set the season.
 *  3. Season windows are read as Europe/Madrid dates on any host, an old
 *     notice cannot declare next year's summer, and the HTTP process learns the
 *     windows from the notices the worker sends it.
 *  4. Only an explicit line reference marks a line as affected.
 *  5. The stop view's service-day label follows holidays and the season.
 */

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const tracker = require('../src/mataroTracker');
const tripMatcher = require('../src/core/schedule/tripMatcher');
const seasonCalendar = require('../src/data/seasonCalendar');
const mataroSchedules = require('../src/data/mataroSchedules');

const madrid = (iso) => new Date(`${iso}+02:00`);
const ok = (msg) => console.log(`  ✓ ${msg}`);

// The real notices, as the portal publishes them (abridged).
const SUMMER_TITLE = 'HORARIS ESTIU 2026';
const SUMMER_TEXT = "Del 27 de juliol fins al 23 d'agost, els autobusos circularan amb horari d'estiu. Només feiners. Els caps de setmana, els horaris no canvien.";
const SANT_BENET = 'TALL CARRER SANT BENET. 06/10\nDIMARTS, 06/10/2026, DE 10.00 A 12.00 HORES\nLÍNIA 4, DIRECCIÓ HOSPITAL\nParada anul·lada: Miquel Biada\nParada provisional: Ronda República (L5)\nLÍNIA 7, DIRECCIÓ PLAÇA DE LES TERESES\nParada anul·lada: Miquel Biada\nParada provisional: Ronda República (L5)';
const MONTSERRAT = 'TALL CARRER MONTSERRAT. 05/10\nDILLUNS, 05/10/2026, DE 14 A 18 HORES\nLÍNIA 2, ADREÇA HOSPITAL\nParada anul·lada: Lepant\nLÍNIA 5, ADREÇA HOSPITAL\nParada anul·lada: Lepant';
const IRONMAN = 'IRONMAN BARCELONA. 04/10\nDIUMENGE, 04/10/2026, DES D’INICI SERVEI FINS A LES 18.30 HORES APROXIMADAMENT\nLÍNIA 2, DIRECCIÓ RODALIES - HOSPITAL\nLÍNIA 3, DIRECCIÓ HOSPITAL\nLÍNIA 5, DIRECCIÓ RODALIES - HOSPITAL\nLÍNIA 8, DIRECCIÓ RODALIES - GALÍCIA';

console.log('--- 1. Summer is a season, not a day type ---');
{
  const aug5 = madrid('2026-08-05T10:00:00');
  assert.strictEqual(tripMatcher.resolveDayType(aug5).dayType, 'weekday');
  assert.strictEqual(tracker.getServiceCalendarInfo(aug5).dayType, 'weekday', 'the tracker and the matcher agree');
  const summer = mataroSchedules.getDirectionSchedule('1', '11', 'weekday', seasonCalendar.resolveSeason(aug5).season);
  assert.strictEqual(summer.departures.length, 69, 'L1 Rodalies -> Hospital runs the 69-trip summer weekday grid on 5 Aug 2026');
  const aug26 = madrid('2026-08-26T10:00:00');
  assert.strictEqual(tripMatcher.resolveDayType(aug26).dayType, 'weekday');
  const after = mataroSchedules.getDirectionSchedule('1', '11', 'weekday', seasonCalendar.resolveSeason(aug26).season);
  assert.strictEqual(after.departures.length, 76, 'after the summer window L1 runs the 76-trip winter weekday grid');
  assert.strictEqual(tripMatcher.resolveDayType(madrid('2026-08-08T10:00:00')).dayType, 'saturday', 'an August Saturday is still a Saturday');
  assert.strictEqual(tripMatcher.resolveDayType(madrid('2026-08-15T10:00:00')).dayType, 'sunday', "L'Assumpció runs the holiday grid");
  ok('August weekdays run the summer weekday grid; Saturdays and holidays are unchanged');
}

console.log("--- 2. Catalan month names after d' ---");
{
  const v = tracker.parseAvisoValidity(SUMMER_TITLE, SUMMER_TEXT, madrid('2026-07-01T10:00:00'));
  assert.strictEqual(v.isOngoing, false, 'the summer notice has dates');
  assert.strictEqual(v.startsAt.toISOString(), '2026-07-26T22:00:00.000Z', 'starts 27 Jul 00:00 Madrid');
  assert.strictEqual(v.expiry.toISOString(), '2026-08-23T21:59:59.000Z', 'ends 23 Aug 23:59:59 Madrid');
  assert.strictEqual(tracker.parseAvisoValidity(SUMMER_TITLE, SUMMER_TEXT, madrid('2026-10-01T10:00:00')).isExpired, true, 'it has expired by October');

  const cases = [
    ["Del 3 d'agost al 7 d'agost", '2026-08-03', '2026-08-07'],
    ['Fins al 15 d’octubre de 2026', '2026-10-15', '2026-10-15'],
    ['Del 1 al 5 d´abril', '2026-04-01', '2026-04-05'],
    ["Tall del carrer el 12 d'octubre de 9 a 14 hores", '2026-10-12', '2026-10-12']
  ];
  for (const [text, from, to] of cases) {
    const r = tracker.parseAvisoValidity('Avís', text, madrid('2026-01-02T10:00:00'));
    assert.strictEqual(r.isOngoing, false, `${text}: has dates`);
    assert.strictEqual(seasonCalendar.madridDateKey(r.startsAt), from, `${text}: from`);
    assert.strictEqual(seasonCalendar.madridDateKey(r.expiry), to, `${text}: to`);
  }
  const timed = tracker.parseAvisoValidity('Avís', "Del 12 al 13 d'octubre, fins a les 14.30 hores", madrid('2026-10-01T10:00:00'));
  assert.strictEqual(timed.expiry.toISOString(), '2026-10-13T12:30:00.000Z', 'a stated end hour is Madrid time');
  assert.strictEqual(tracker.parseAvisoValidity('T-MOBILITAT', 'T-MOBILITAT').isOngoing, true, 'a notice with no dates is still ongoing');
  ok("d'agost / d’octubre / d´abril parse; a stated end hour is Madrid time");
}

console.log('--- 3. Season windows from notices ---');
{
  seasonCalendar.clearNoticeWindows();
  const v = tracker.parseAvisoValidity(SUMMER_TITLE, SUMMER_TEXT, madrid('2026-07-01T10:00:00'));
  assert.strictEqual(tracker.registerSeasonNotice(SUMMER_TITLE, SUMMER_TEXT, v), true);
  const w = seasonCalendar._noticeWindows[0];
  assert.deepStrictEqual([w.from, w.to, w.season], ['2026-07-27', '2026-08-23', 'summer']);
  assert.strictEqual(seasonCalendar.resolveSeason(madrid('2026-08-05T10:00:00')).source, 'notice "HORARIS ESTIU 2026"');

  seasonCalendar.clearNoticeWindows();
  const stale = tracker.parseAvisoValidity(SUMMER_TITLE, SUMMER_TEXT, madrid('2027-01-10T10:00:00'));
  assert.strictEqual(tracker.registerSeasonNotice(SUMMER_TITLE, SUMMER_TEXT, stale), false,
    'a 2026 notice still on the portal in 2027 does not declare a summer 2027');

  seasonCalendar.clearNoticeWindows();
  const cache = tracker.avisosCache;
  const cacheTime = tracker.avisosCacheTime;
  tracker.syncAvisos([{ id: 'aviso_1', title: SUMMER_TITLE, description: SUMMER_TEXT, linesAffected: [], severity: 'info' }], Date.now());
  assert.strictEqual(seasonCalendar._noticeWindows.length, 1, 'the HTTP process learns the window from the notices it is sent');
  tracker.avisosCache = cache;
  tracker.avisosCacheTime = cacheTime;
  seasonCalendar.clearNoticeWindows();

  // The same parse on hosts that do not run in Madrid time.
  const probe = `
    const t = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'mataroTracker'))});
    const sc = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'data', 'seasonCalendar'))});
    const ref = new Date('2026-07-01T08:00:00Z');
    const v = t.parseAvisoValidity(${JSON.stringify(SUMMER_TITLE)}, ${JSON.stringify(SUMMER_TEXT)}, ref);
    t.registerSeasonNotice(${JSON.stringify(SUMMER_TITLE)}, ${JSON.stringify(SUMMER_TEXT)}, v);
    const timed = t.parseAvisoValidity('Avís', "Del 12 al 13 d'octubre, fins a les 14.30 hores", ref);
    process.stdout.write('RESULT ' + JSON.stringify([sc._noticeWindows[0].from, sc._noticeWindows[0].to, timed.expiry.toISOString()]));
  `;
  for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
    const r = spawnSync(process.execPath, ['-e', probe], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    const line = (r.stdout || '').split('RESULT ')[1];
    assert.ok(line, `TZ=${tz}: probe ran (${(r.stderr || '').slice(-300)})`);
    assert.deepStrictEqual(JSON.parse(line), ['2026-07-27', '2026-08-23', '2026-10-13T12:30:00.000Z'], `TZ=${tz}`);
  }
  ok('windows registered as Madrid dates on UTC/New York/Tokyo hosts; stale-year notices ignored; HTTP process synced');
}

console.log('--- 4. Lines named by a notice ---');
{
  assert.deepStrictEqual(tracker.detectAffectedLines(SANT_BENET), ['4', '7'], 'a provisional stop "(L5)" does not affect L5');
  assert.deepStrictEqual(tracker.detectAffectedLines(MONTSERRAT), ['2', '5']);
  assert.deepStrictEqual(tracker.detectAffectedLines(IRONMAN), ['2', '3', '5', '8']);
  assert.deepStrictEqual(tracker.detectAffectedLines('T-MOBILITAT'), []);
  for (const text of ["Tall del carrer del 4 al 6 d'octubre", 'Obres fins al 3/10', 'Carrer Sant Pere, del 1 al 2 de setembre', 'Carrer Hospital 7', 'Línia 12 de Moventis']) {
    assert.deepStrictEqual(tracker.detectAffectedLines(text), [], `no line in "${text}"`);
  }
  assert.deepStrictEqual(tracker.detectAffectedLines('Les línies 4, 5 i 7 es desvien'), ['4', '5', '7']);
  assert.deepStrictEqual(tracker.detectAffectedLines('L1 i L2 sense servei'), ['1', '2']);
  assert.deepStrictEqual(tracker.detectAffectedLines('Líneas 3 y 6'), ['3', '6']);
  ok('only explicit line references count');
}

console.log('--- 5. Service-day label ---');
{
  const oct1 = tracker.getServiceCalendarInfo(madrid('2026-10-01T10:00:00'));
  assert.strictEqual(oct1.calendarTag, "Feiner · horari d'hivern");
  assert.strictEqual(oct1.dateFormatted, '01/10/2026');
  assert.strictEqual(oct1.frequency, undefined, 'no invented frequency');
  const oct12 = tracker.getServiceCalendarInfo(madrid('2026-10-12T10:00:00'));
  assert.strictEqual(oct12.dayType, 'sunday');
  assert.strictEqual(oct12.calendarTag, "Festiu (Festa Nacional d'Espanya) · horari de diumenges i festius");
  assert.strictEqual(tracker.getServiceCalendarInfo(madrid('2026-08-05T10:00:00')).calendarTag, "Feiner · horari d'estiu");
  assert.strictEqual(tracker.getServiceCalendarInfo(madrid('2026-10-03T10:00:00')).calendarTag, 'Dissabte · horari de dissabtes');
  assert.strictEqual(tracker.getServiceCalendarInfo(madrid('2026-08-15T10:00:00')).calendarTag, "Festiu (L'Assumpció) · horari de diumenges i festius");
  ok('weekday/holiday/summer/Saturday labels match the grid the boards use');
}

console.log('\n🎉 ALL CALENDAR AND NOTICE ASSERTIONS PASSED!');
process.exit(0);

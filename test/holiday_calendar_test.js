const assert = require('assert');
const holidayCalendar = require('../src/core/time/holidayCalendar');
const seasonCalendar = require('../src/data/seasonCalendar');
const tripMatcher = require('../src/core/schedule/tripMatcher');

async function runTests() {
  console.log('🧪 Running Holiday Calendar & Season Outlook Tests...\n');

  // 1. 8 Dec 2026 is a holiday (La Immaculada)
  console.log('Test 1: 8 Dec 2026 is recognised as a holiday');
  const immaculada2026 = Date.UTC(2026, 11, 8, 12, 0, 0); // 8 Dec 2026 12:00 UTC (13:00 Madrid)
  assert.strictEqual(holidayCalendar.isHoliday(immaculada2026), true, '8 Dec 2026 must be a holiday');
  console.log('✓ 8 Dec 2026 recognised as holiday.');

  // 2. 6 Dec 2026 is recognized as Dia de la Constitució
  console.log('Test 2: 6 Dec 2026 is recognized as Dia de la Constitució');
  const constitucio2026 = Date.UTC(2026, 11, 6, 12, 0, 0);
  assert.strictEqual(holidayCalendar.isHoliday(constitucio2026), true, '6 Dec 2026 must be a holiday');
  const holidaysData = require('../src/data/holidays.json');
  const dec6Entry = holidaysData.years['2026'].regional.find(h => h.date === '2026-12-06');
  assert.ok(dec6Entry, '2026-12-06 entry must exist in holidays.json');
  assert.strictEqual(dec6Entry.name, 'Dia de la Constitució', '6 Dec must be named Dia de la Constitució');
  console.log('✓ 6 Dec 2026 correctly labelled Dia de la Constitució.');

  // 3. Local holiday from JSON resolves to Sunday service
  console.log('Test 3: Local holiday (Les Santes 27 July 2026) resolves to Sunday service');
  const santes2026 = Date.UTC(2026, 6, 27, 10, 0, 0); // 27 July 2026 (Monday) 12:00 Madrid
  assert.strictEqual(holidayCalendar.isHoliday(santes2026), true, 'Les Santes (27 July 2026) must be a holiday');
  const dayTypeResolved = tripMatcher.resolveDayType(santes2026);
  assert.strictEqual(dayTypeResolved.dayType, 'sunday', 'Les Santes Monday must resolve to sunday service bucket');
  assert.strictEqual(dayTypeResolved.isHoliday, true, 'isHoliday flag must be true');
  console.log('✓ Les Santes (27 July 2026) correctly resolves to Sunday timetable.');

  // 4. Year missing from JSON falls back and reports isHolidayKnown === false
  console.log('Test 4: Year missing from JSON (e.g. 2035) falls back and reports isHolidayKnown === false');
  const futureDate = Date.UTC(2035, 0, 1, 12, 0, 0);
  assert.strictEqual(holidayCalendar.isHolidayKnown(futureDate), false, '2035 is not in holidays.json');
  assert.strictEqual(holidayCalendar.isHoliday(futureDate), true, 'Any Nou 2035 still resolves via computus/fallback');
  const knownDate2026 = Date.UTC(2026, 4, 1, 12, 0, 0);
  assert.strictEqual(holidayCalendar.isHolidayKnown(knownDate2026), true, '2026 is in holidays.json');
  console.log('✓ Fallback computus works and distinguishes known vs unknown data years.');

  // 5. Midnight / DST edges: 00:30 Madrid on a holiday is still that date
  console.log('Test 5: Midnight and DST edges (00:30 Madrid on holiday, 25 Oct 2026 & 29 Mar 2026)');
  // 1 Jan 2026 00:30 Madrid (UTC+1, so 2025-12-31 23:30 UTC)
  const jan1_0030 = Date.UTC(2025, 11, 31, 23, 30, 0);
  assert.strictEqual(holidayCalendar.madridDate(jan1_0030), '2026-01-01');
  assert.strictEqual(holidayCalendar.isHoliday(jan1_0030), true, '00:30 Madrid on 1 Jan is 1 Jan holiday');

  // Fall DST transition edge: Sunday 25 Oct 2026 (clocks turn back 03:00 -> 02:00 Madrid)
  const oct25_0030 = Date.UTC(2026, 9, 24, 22, 30, 0); // UTC+2 before transition
  assert.strictEqual(holidayCalendar.madridDate(oct25_0030), '2026-10-25');
  const oct25_0230_after = Date.UTC(2026, 9, 25, 1, 30, 0); // UTC+1 after transition
  assert.strictEqual(holidayCalendar.madridDate(oct25_0230_after), '2026-10-25');

  // Spring DST transition edge: Sunday 29 Mar 2026 (clocks turn forward 02:00 -> 03:00 Madrid)
  const mar29_0030 = Date.UTC(2026, 2, 28, 23, 30, 0); // UTC+1 before transition
  assert.strictEqual(holidayCalendar.madridDate(mar29_0030), '2026-03-29');
  const mar29_0330 = Date.UTC(2026, 2, 29, 1, 30, 0); // UTC+2 after transition
  assert.strictEqual(holidayCalendar.madridDate(mar29_0330), '2026-03-29');
  console.log('✓ Midnight and DST transitions preserve calendar dates safely.');

  // 6. Season outlook
  console.log('Test 6: Season outlook warnings for unconfigured upcoming summers');
  // 2027-06-15 (after June 1st of 2027 with no summer window configured)
  const june2027 = Date.UTC(2027, 5, 15, 12, 0, 0);
  const outlook2027 = seasonCalendar.getSeasonOutlook(june2027);
  assert.strictEqual(outlook2027.nextSummerConfigured, false, 'Summer 2027 is not configured yet');
  assert.strictEqual(outlook2027.warning, "Horari d'estiu 2027 no configurat", 'Warning must alert about unconfigured summer');

  // 2026-09-27 (summer 2026 was configured)
  const sept2026 = Date.UTC(2026, 8, 27, 12, 0, 0);
  const outlook2026 = seasonCalendar.getSeasonOutlook(sept2026);
  assert.strictEqual(outlook2026.nextSummerConfigured, true, 'Summer 2026 is configured in SUMMER_WINDOWS');
  assert.strictEqual(outlook2026.warning, null, 'No warning when summer is configured');
  console.log('✓ Season outlook correctly flags missing summer windows from June 1st.');

  console.log('\n✅ ALL HOLIDAY CALENDAR & SEASON OUTLOOK TESTS PASSED!\n');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});

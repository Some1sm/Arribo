'use strict';

const assert = require('node:assert');
const holidayCalendar = require('../src/core/time/holidayCalendar');

const d = (y, m, day) => new Date(Date.UTC(y, m - 1, day, 10, 0, 0));

// 2026 assertions
assert.strictEqual(holidayCalendar.isHoliday(d(2026, 12, 6)), false, '2026-12-06 should not be a holiday (Sunday)');
assert.strictEqual(holidayCalendar.isHoliday(d(2026, 11, 1)), false, '2026-11-01 should not be a holiday (Sunday)');
assert.strictEqual(holidayCalendar.isHoliday(d(2026, 12, 8)), true, '2026-12-08 should be a holiday');
assert.strictEqual(holidayCalendar.isHoliday(d(2026, 5, 25)), true, '2026-05-25 should be a local holiday');

// 2027 assertions
assert.strictEqual(holidayCalendar.isHoliday(d(2027, 8, 15)), false, '2027-08-15 should not be a holiday (Sunday)');
assert.strictEqual(holidayCalendar.isHoliday(d(2027, 12, 26)), false, '2027-12-26 should not be a holiday (Sunday)');
assert.strictEqual(holidayCalendar.isHoliday(d(2027, 12, 6)), true, '2027-12-06 should be a holiday');

// Coverage checks
const cov2026 = holidayCalendar.getHolidayCoverage(d(2026, 9, 28));
assert.strictEqual(cov2026.regionalKnown, true);
assert.strictEqual(cov2026.localKnown, true);
assert.strictEqual(cov2026.known, true);
assert.strictEqual(cov2026.warning, null);

const covNov2026 = holidayCalendar.getHolidayCoverage(d(2026, 11, 15));
assert.strictEqual(covNov2026.warning, 'Festius 2027 pendents de configurar');

const cov2027 = holidayCalendar.getHolidayCoverage(d(2027, 3, 1));
assert.strictEqual(cov2027.regionalKnown, true);
assert.strictEqual(cov2027.localKnown, false);
assert.strictEqual(cov2027.known, false);
assert.strictEqual(cov2027.warning, 'Festius locals de Mataró 2027 no configurats');

assert.strictEqual(holidayCalendar.isHolidayKnown(d(2027, 3, 1)), false);
assert.strictEqual(holidayCalendar.isHolidayKnown(d(2026, 3, 1)), true);

const cov2035 = holidayCalendar.getHolidayCoverage(d(2035, 1, 15));
assert.strictEqual(cov2035.regionalKnown, false);
assert.strictEqual(cov2035.known, false);
assert.strictEqual(cov2035.warning, 'Festius oficials 2035 no configurats');

console.log('✅ HOLIDAY COVERAGE TESTS PASSED');

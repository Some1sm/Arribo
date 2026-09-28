'use strict';

const assert = require('assert');
const mataroSchedules = require('../src/data/mataroSchedules');

console.log('🧪 Running Service Window Tests...');

// 1. L1 Weekday Service Window
const w1 = mataroSchedules.getServiceWindow('1', 'weekday');
assert.ok(w1, 'L1 weekday service window must exist');
// 05:25 - 15m = 05:10 = 18600s
assert.strictEqual(w1.startSec, 18600, 'L1 weekday window start must be 05:10 (18600s)');
// Last arrival at 23:05 + 20m = 23:25 = 84300s
assert.strictEqual(w1.endSec, 84300, 'L1 weekday window end must be 23:25 (84300s)');
console.log('✓ L1 weekday service window matches published timetable (05:10 - 23:25)');

// 2. L6 Sunday Service Window (afternoon-only)
const w6Sunday = mataroSchedules.getServiceWindow('6', 'sunday');
assert.ok(w6Sunday, 'L6 Sunday service window must exist');
// 14:00 - 15m = 13:45 = 49500s
assert.strictEqual(w6Sunday.startSec, 49500, 'L6 Sunday window start must be 13:45 (49500s)');
// Last arrival at 22:35 + 20m = 22:55 = 82500s
assert.strictEqual(w6Sunday.endSec, 82500, 'L6 Sunday window end must be 22:55 (82500s)');
console.log('✓ L6 Sunday afternoon-only window matches published timetable (13:45 - 22:55)');

// 3. Non-existent line returns null
const wUnknown = mataroSchedules.getServiceWindow('99', 'weekday');
assert.strictEqual(wUnknown, null, 'Unknown line must return null');
console.log('✓ Unknown line returns null safely');

console.log('\n✅ ALL SERVICE WINDOW TESTS PASSED!\n');

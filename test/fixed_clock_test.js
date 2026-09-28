'use strict';

const assert = require('node:assert');
const fixedClock = require('./helpers/fixed_clock.cjs');

const targetIso = '2026-09-23T08:00:00.000Z';
const targetMs = Date.parse(targetIso);

const realNowBefore = Date.now();
const uninstall = fixedClock.install(targetIso);

// 1. Date.now() within 2s of pinned instant
const installedNow = Date.now();
assert.ok(Math.abs(installedNow - targetMs) < 2000, `Date.now() (${installedNow}) should be within 2s of ${targetMs}`);

// 2. new Date() equals it within 2s
const d = new Date();
assert.ok(Math.abs(d.getTime() - targetMs) < 2000, `new Date() (${d.getTime()}) should be within 2s of ${targetMs}`);

// 3. new Date(0).getTime() === 0
const d0 = new Date(0);
assert.strictEqual(d0.getTime(), 0, 'new Date(0).getTime() should be 0');

// 4. Date.UTC(2026, 0, 1) is unchanged
assert.strictEqual(Date.UTC(2026, 0, 1), 1767225600000, 'Date.UTC(2026, 0, 1) should match standard UTC timestamp');

// 5. new Date() instanceof Date is true while installed
assert.ok(new Date() instanceof Date, 'new Date() should be instanceof Date');

// 6. after uninstall(), Date.now() is within 2s of real time
uninstall();
const realNowAfter = Date.now();
assert.ok(Math.abs(realNowAfter - realNowBefore) < 2000, 'Date.now() after uninstall should be within 2s of real time');

console.log('✅ fixed_clock_test passed');

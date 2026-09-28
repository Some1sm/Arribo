'use strict';

require('./helpers/fixed_clock.cjs').install('2026-09-29T08:00:00Z');

const assert = require('node:assert/strict');
const siriClient = require('../src/mataroSiriClient');
siriClient.circuitOpenUntil = Date.now() + 3600000;

const tracker = require('../src/mataroTracker');

const notice = {
  id: 'aviso_2',
  title: 'TALL CARRER MONTSERRAT. 29/09',
  severity: 'warning',
  active: true,
  linesAffected: ['2', '5'],
  expiresAt: '2026-09-29T12:15:00.000Z',
  url: 'https://mataro.avanzagrupo.com/ca/avisos',
  description: 'TALL CARRER MONTSERRAT \n\n\n\nDIMARTS, 29/09/2026, DE 9:15 A 14:15 HORES\n\n\n\nLÍNIA 2, ADREÇA HOSPITAL\n\n\n\nParada anul·lada: Lepant\n\n\n\nLÍNIA 5, ADREÇA HOSPITAL\n\n\n\nParada anul·lada: Lepant\n\n\n\n \n\n\n\nAmb motiu de descàrrega, aquestes línies modifiquen el recorregut, anul·lant aquestes parades.'
};

let callCount = 0;
const origGetStopCancellations = tracker.getStopCancellations.bind(tracker);
tracker.getStopCancellations = function(...args) {
  callCount++;
  return origGetStopCancellations(...args);
};

const pairs = [
  ['1016', '1001'],
  ['1058', '1073']
];

const windowStart = Date.parse('2026-09-29T07:15:00Z');
const windowEnd = Date.parse('2026-09-29T12:15:00Z');

async function main() {
  try {
    for (const [from, to] of pairs) {
      callCount = 0;
      const plan = await tracker.planJourney(from, to, { avisos: [notice] });

      assert.ok(
        callCount <= 600,
        `getStopCancellations called ${callCount} times for ${from}->${to}; the planner must not re-parse notices per departure`
      );

      assert.ok(
        Array.isArray(plan.itineraries) && plan.itineraries.length >= 1,
        `plan for ${from}->${to} must contain itineraries`
      );

      for (const itin of plan.itineraries) {
        for (const leg of (itin.legs || [])) {
          const isAffectedLine = ['2', '5'].includes(String(leg.lineId));
          const isLepant = String(leg.fromStop?.id) === '1059';
          const boardTs = Date.parse(leg.boardAt);
          const inWindow = Number.isFinite(boardTs) && boardTs >= windowStart && boardTs <= windowEnd;
          assert.ok(
            !(isAffectedLine && isLepant && inWindow),
            `Leg on line ${leg.lineId} should not board at cancelled stop Lepant (1059) between ${new Date(windowStart).toISOString()} and ${new Date(windowEnd).toISOString()}`
          );
        }
      }
    }

    console.log('✅ PLANNER CANCELLATION PERFORMANCE TEST PASSED');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

main();

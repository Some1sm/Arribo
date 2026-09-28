const assert = require('assert');
const mataroTracker = require('../src/mataroTracker');
const timeEngine = require('../src/core/time/timeEngine');

// Pin test times using timeEngine.localTimeToUtcDate (Europe/Madrid)
const atMadrid = (y, m, d, h, min, s = 0) => timeEngine.localTimeToUtcDate(y, m - 1, d, h, min, s);

const AVISO_3 = {
  id: 'aviso_3',
  title: 'TALL CARRER SANT BENET. 28/09',
  linesAffected: ['4', '5', '7'],
  severity: 'warning',
  active: true,
  expiresAt: '2026-09-28T21:59:59.000Z',
  description: `TALL CARRER SANT BENET 

DILLUNS, 28/09/2026, DE 9 A 17 HORES

LÍNIA 4, ADREÇA HOSPITAL 

Parada anul·lada: Miquel Biada

Parada provisional: Ronda República (L5)

LÍNIA 7, ADREÇA PLAÇA DE LES TERESES 

Parada anul·lada: Miquel Biada

Parada provisional: Ronda República (L5)

Amb motiu de mudança, aquestes línies modifiquen el recorregut, anul·lant aquestes parades. Els horaris es poden veure afectats. Preguem que disculpin les molèsties.`
};

const AVISO_2 = {
  id: 'aviso_2',
  title: 'TALL CARRER MONTSERRAT. 29/09',
  linesAffected: ['2', '5'],
  severity: 'warning',
  active: true,
  expiresAt: '2026-09-29T12:15:00.000Z',
  description: `TALL CARRER MONTSERRAT 

DIMARTS, 29/09/2026, DE 9:15 A 14:15 HORES

LÍNIA 2, ADREÇA HOSPITAL

Parada anul·lada: Lepant

LÍNIA 5, ADREÇA HOSPITAL

Parada anul·lada: Lepant

Amb motiu de descàrrega, aquestes línies modifiquen el recorregut, anul·lant aquestes parades. Els horaris es poden veure afectats. Preguem que disculpin les molèsties.`
};

const AVISO_7 = {
  id: 'aviso_7',
  title: 'T-MOBILITAT',
  description: 'T-MOBILITAT',
  severity: 'info',
  active: true,
  expiresAt: null,
  linesAffected: []
};

const AVISO_UNMATCHED = {
  id: 'aviso_unmatched',
  title: 'OBRES FANTASMA',
  linesAffected: ['4'],
  severity: 'warning',
  active: true,
  expiresAt: null,
  description: `LÍNIA 4, ADREÇA HOSPITAL\nParada anul·lada: Parada Totalment Inexistent Desconeguda`
};

async function runTests() {
  console.log('🧪 Running Service Disruptions & Stop Cancellations Tests...\n');

  // Test 1: Notice 28/09 active at 10:00 Madrid
  console.log('Test 1: Notice 28/09 at 10:00 Madrid (direction-scoped cancellations)');
  const t1000 = atMadrid(2026, 9, 28, 10, 0);

  // L4 towards Hospital (dir 11) has Miquel Biada (1107) cancelled
  const l4Res = mataroTracker.getStopCancellations('4', [AVISO_3], t1000);
  assert.ok(l4Res.cancellations.some(c => c.stopId === '1107' && c.dirKey === '11'), 'L4 dir 11 must have Miquel Biada cancelled');
  assert.ok(!l4Res.cancellations.some(c => c.dirKey === '12'), 'L4 other direction (dir 12) must NOT have cancellations');
  console.log('✓ L4 direction towards Hospital has Miquel Biada cancelled; other direction does not.');

  // L7 towards Pl. Tereses (dir 11) has Miquel Biada (1107) cancelled
  const l7Res = mataroTracker.getStopCancellations('7', [AVISO_3], t1000);
  assert.ok(l7Res.cancellations.some(c => c.stopId === '1107' && c.dirKey === '11'), 'L7 dir 11 must have Miquel Biada cancelled');
  assert.ok(!l7Res.cancellations.some(c => c.dirKey === '12'), 'L7 other direction (dir 12) must NOT have cancellations');
  console.log('✓ L7 direction towards Pl. Tereses has Miquel Biada cancelled; other direction does not.');

  // L5 must NOT have cancellations from this notice
  const l5Aviso3 = mataroTracker.getStopCancellations('5', [AVISO_3], t1000);
  assert.strictEqual(l5Aviso3.cancellations.length, 0, 'L5 must NOT have any cancellations from AVISO_3');
  console.log('✓ L5 receives no cancellations from notice mentioning provisional stop for L5.');

  // Test 2: Same notice at 08:59 and 17:01 Madrid (outside window 9-17)
  console.log('\nTest 2: Window boundaries (08:59 and 17:01 Madrid) produce no cancellations');
  const t0859 = atMadrid(2026, 9, 28, 8, 59);
  const t1701 = atMadrid(2026, 9, 28, 17, 1);
  assert.strictEqual(mataroTracker.getStopCancellations('4', [AVISO_3], t0859).cancellations.length, 0, 'At 08:59 notice is not yet effective');
  assert.strictEqual(mataroTracker.getStopCancellations('4', [AVISO_3], t1701).cancellations.length, 0, 'At 17:01 notice is expired');
  console.log('✓ Outside the 9-17 window, zero cancellations are produced.');

  // Test 3: Provisional stop parsed
  console.log('\nTest 3: Provisional stop parsing');
  assert.ok(l4Res.provisional.some(p => p.name.includes('República') && p.note.includes('L5')), 'Provisional stop Ronda República (L5) must be attached');
  console.log('✓ Provisional stop Ronda República (L5) parsed and attached.');

  // Test 4: Notice 29/09 at 12:00 Madrid (Lepant cancelled on L2 & L5 towards Hospital only)
  console.log('\nTest 4: Notice 29/09 at 12:00 Madrid (Lepant cancelled direction Hospital only)');
  const t1200_29 = atMadrid(2026, 9, 29, 12, 0);

  const l2Res = mataroTracker.getStopCancellations('2', [AVISO_2], t1200_29);
  assert.ok(l2Res.cancellations.some(c => c.stopId === '1059' && c.dirKey === '12'), 'L2 dir 12 (towards Hospital) must cancel Lepant (1059)');
  assert.ok(!l2Res.cancellations.some(c => c.dirKey === '11'), 'L2 dir 11 must not cancel Lepant');

  const l5Res = mataroTracker.getStopCancellations('5', [AVISO_2], t1200_29);
  assert.ok(l5Res.cancellations.some(c => c.stopId === '1059' && c.dirKey === '11'), 'L5 dir 11 (towards Hospital) must cancel Lepant (1059)');
  assert.ok(!l5Res.cancellations.some(c => c.dirKey === '12'), 'L5 dir 12 must not cancel Lepant');
  console.log('✓ Lepant (1059) cancelled only on direction Hospital for L2 and L5.');

  // Test 5: Unmatched stop appears in unmatchedStops without crash
  console.log('\nTest 5: Unmatched stop resilience');
  const unRes = mataroTracker.getStopCancellations('4', [AVISO_UNMATCHED], t1000);
  assert.strictEqual(unRes.cancellations.length, 0, 'No cancellations when stop name is unknown');
  assert.ok(unRes.unmatchedStops.some(u => u.name.includes('Inexistent')), 'Unknown stop must be listed in unmatchedStops');
  console.log('✓ Unknown stop safely recorded in unmatchedStops.');

  // Test 6: "Hospital" as direction word must not cancel Hospital stops (1001, 1073)
  console.log('\nTest 6: "Hospital" address/direction word does not cancel Hospital stops');
  assert.ok(!l2Res.cancellations.some(c => c.stopId === '1001' || c.stopId === '1073'), 'Hospital stops must not be cancelled by ADREÇA HOSPITAL');
  assert.ok(!l4Res.cancellations.some(c => c.stopId === '1001' || c.stopId === '1073'), 'Hospital stops must not be cancelled on L4');
  assert.ok(!l5Res.cancellations.some(c => c.stopId === '1001' || c.stopId === '1073'), 'Hospital stops must not be cancelled on L5');
  console.log('✓ Hospital stops remain uncancelled.');

  // Test 7: Notice with no lines produces no cancellations and no unmatched stops
  console.log('\nTest 7: Notice without lines (T-MOBILITAT)');
  const res7 = mataroTracker.getStopCancellations('4', [AVISO_7], t1000);
  assert.strictEqual(res7.cancellations.length, 0);
  assert.strictEqual(res7.unmatchedStops.length, 0);
  console.log('✓ Non-disruption notice produces zero cancellations.');

  // Test 8: Backwards compatibility of getCancelledStopsForLine wrapper
  console.log('\nTest 8: Backward-compatible getCancelledStopsForLine');
  // L4 dir 11 -> returns Map with 1107 -> title
  const oldMap11 = mataroTracker.getCancelledStopsForLine('4', [AVISO_3], t1000, '11');
  assert.strictEqual(oldMap11.has('1107'), true, 'dir 11 should have 1107');
  // L4 dir 12 -> returns empty Map
  const oldMap12 = mataroTracker.getCancelledStopsForLine('4', [AVISO_3], t1000, '12');
  assert.strictEqual(oldMap12.has('1107'), false, 'dir 12 should not have 1107');
  console.log('✓ getCancelledStopsForLine wrapper behaves correctly with direction.');

  // Test 9: Planner cancellation integration (Miquel Biada on L4 towards Hospital)
  console.log('\nTest 9: Planner integration with cancelled stops');
  const plan10 = await mataroTracker.planJourney('Miquel Biada', 'Hospital de Mataró', {
    departureDate: '2026-09-28',
    departureTime: '10:00',
    avisos: [AVISO_3]
  });
  // At 10:00, no departure on L4 during the 9-17 disruption window may be offered from Miquel Biada
  const boardsL4DuringWindow10 = plan10.itineraries.some(it =>
    it.legs.some(l => l.lineCode === 'L4' && (l.fromStop.id === '1107' || l.fromStop.name.includes('Miquel Biada')) &&
      new Date(l.boardAt).getTime() < new Date('2026-09-28T15:00:00.000Z').getTime())
  );
  assert.strictEqual(boardsL4DuringWindow10, false, 'No itinerary may offer boarding L4 at Miquel Biada during notice window');
  console.log('✓ At 10:00, boarding L4 at cancelled Miquel Biada is successfully blocked.');

  const plan18 = await mataroTracker.planJourney('Miquel Biada', 'Hospital de Mataró', {
    departureDate: '2026-09-28',
    departureTime: '18:00',
    avisos: [AVISO_3]
  });
  const boardsL4At18 = plan18.itineraries.some(it =>
    it.legs.some(l => l.lineCode === 'L4' && (l.fromStop.id === '1107' || l.fromStop.name.includes('Miquel Biada')))
  );
  assert.strictEqual(boardsL4At18, true, 'At 18:00, boarding L4 at Miquel Biada must be offered after notice expires');
  console.log('✓ At 18:00, boarding L4 at Miquel Biada is offered.');

  // Test 10: Active disruption notice attached to itinerary
  console.log('\nTest 10: Active disruption notice attached to affected itineraries');
  const planNotices = await mataroTracker.planJourney('Pl. Tereses', 'Hospital de Mataró', {
    departureDate: '2026-09-28',
    departureTime: '10:00',
    avisos: [AVISO_3]
  });
  const l4Itin = planNotices.itineraries.find(it => it.legs.some(l => l.lineCode === 'L4'));
  assert.ok(l4Itin, 'Plan should include an L4 option from Pl. Tereses');
  assert.ok(Array.isArray(l4Itin.notices) && l4Itin.notices.length > 0, 'L4 itinerary must have active notices attached');
  assert.strictEqual(l4Itin.notices[0].id, 'aviso_3', 'Attached notice id must match aviso_3');
  assert.ok(l4Itin.notices[0].url.includes('avanzagrupo'), 'Attached notice must include url');
  console.log('✓ Active disruption notice successfully attached to affected itinerary.');

  console.log('\n✅ ALL SERVICE DISRUPTION TESTS PASSED!\n');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});

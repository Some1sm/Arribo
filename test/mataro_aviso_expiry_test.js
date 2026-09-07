const assert = require('assert');
const mataroTracker = require('../src/mataroTracker');

console.log('🧪 Running Mataró Bus Aviso Expiry & Active Filtering Unit Tests...\n');

// Reference date: Monday, September 7, 2026 14:47:00
const refDate = new Date('2026-09-07T14:47:00+02:00');

// Test 1: Stale aviso from 01/09 al 02/09 (Queralbs cut)
{
  const title = 'TALL CARRER QUERALBS. DEL 01/09 AL 02/09';
  const desc = 'Tall provisional per treballs a la xarxa d aigua';
  const res = mataroTracker.parseAvisoValidity(title, desc, refDate);
  assert.strictEqual(res.isExpired, true, '01/09 al 02/09 must be marked expired on 07/09');
  assert(res.expiry instanceof Date, 'Must extract expiry date');
  console.log('✓ Test 1 Passed: Past numeric date range (01/09 al 02/09) marked expired');
}

// Test 2: Cirera festival aviso ending 05/09/2026 22:30
{
  const title = 'TALL CARRER QUERALBS. DEL 01/09 AL 02/09';
  const desc = 'FESTES DE CIRERA DISSABTE, 05/09/2026 DE 19.00 A 19.30 HORES I DE 22.00 A 22.30 HORES LÍNIA 1 - LÍNIA 2 - LÍNIA 4';
  const res = mataroTracker.parseAvisoValidity(title, desc, refDate);
  assert.strictEqual(res.isExpired, true, 'Festival ending 05/09 22:30 must be expired on 07/09');
  assert.strictEqual(res.expiry.getDate(), 5);
  assert.strictEqual(res.expiry.getMonth(), 8); // September (0-indexed)
  assert.strictEqual(res.expiry.getHours(), 22);
  assert.strictEqual(res.expiry.getMinutes(), 30);
  console.log('✓ Test 2 Passed: Event with end time (05/09/2026 22:30) correctly parsed and marked expired');
}

// Test 3: Active future aviso (10/09 al 15/09)
{
  const title = 'OBRES A RONDA CERDANYOLA DEL 10/09 AL 15/09';
  const desc = 'Afectacio temporal linia 2';
  const res = mataroTracker.parseAvisoValidity(title, desc, refDate);
  assert.strictEqual(res.isExpired, false, '10/09 al 15/09 must be active on 07/09');
  assert.strictEqual(res.expiry.getDate(), 15);
  console.log('✓ Test 3 Passed: Future date range correctly identified as active');
}

// Test 4: Ongoing notice ('fins a nou avís')
{
  const title = 'CANVI DE RECORREGUT PER OBRES';
  const desc = 'Afectacio línia 3 fins a nou avís';
  const res = mataroTracker.parseAvisoValidity(title, desc, refDate);
  assert.strictEqual(res.isOngoing, true);
  assert.strictEqual(res.isExpired, false);
  console.log('✓ Test 4 Passed: Ongoing notice (fins a nou avis) recognized without false expiration');
}

// Test 5: General information notices without expiration dates
{
  const title = 'HORARIS ESTIU 2026';
  const desc = 'Consulta els nous horaris a la web oficial';
  const res = mataroTracker.parseAvisoValidity(title, desc, refDate);
  assert.strictEqual(res.isOngoing, true);
  assert.strictEqual(res.isExpired, false);
  console.log('✓ Test 5 Passed: General info notice kept active');
}

// Test 6: Named month date ranges ('fins al 2 de setembre de 2026')
{
  const title = 'DESVIAMENT PROVISIONAL';
  const desc = 'Fins al 2 de setembre de 2026';
  const res = mataroTracker.parseAvisoValidity(title, desc, refDate);
  assert.strictEqual(res.isExpired, true, '2 de setembre de 2026 must be expired on 07/09');
  console.log('✓ Test 6 Passed: Named Catalan month date correctly evaluated');
}

// Test 7: getCancelledStopsForLine ignores expired avisos
{
  const expiredAvisos = [
    {
      title: 'TALL CARRER QUERALBS. DEL 01/09 AL 02/09',
      description: 'LÍNIA 1 Parades anul·lades: Tereses, Queralbs',
      severity: 'warning',
      active: false,
      expiresAt: '2026-09-05T20:30:00.000Z'
    }
  ];
  const cancelled = mataroTracker.getCancelledStopsForLine('1', expiredAvisos);
  assert.strictEqual(cancelled.size, 0, 'Expired aviso must NOT cancel any stops');
  console.log('✓ Test 7 Passed: getCancelledStopsForLine safely ignores expired avisos');
}

// Test 8: Live getDisruptions excludes expired Queralbs notice
async function testLiveFiltering() {
  const activeDisruptions = await mataroTracker.getDisruptions();
  const hasQueralbs = activeDisruptions.some(d => (d.title || '').includes('QUERALBS'));
  assert.strictEqual(hasQueralbs, false, 'Expired Queralbs notice must NOT be returned in live disruptions');

  const l1Disruptions = await mataroTracker.getDisruptions('1');
  const hasL1Queralbs = l1Disruptions.some(d => (d.title || '').includes('QUERALBS'));
  assert.strictEqual(hasL1Queralbs, false, 'Expired Queralbs notice must NOT be in L1 disruptions');

  console.log('✓ Test 8 Passed: Live getDisruptions cleanly strips expired disruptions from API output');
  console.log('\n✅ ALL AVISO EXPIRATION TESTS PASSED PERFECTLY!\n');
}

testLiveFiltering().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

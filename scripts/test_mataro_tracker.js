const mataroTracker = require('../src/mataroTracker');

async function test() {
  console.log('Testing mataroTracker.getLines()...');
  const lines = mataroTracker.getLines();
  console.log('Lines found:', lines.length);
  lines.forEach(l => console.log(` - ${l.code}: ${l.name} (${l.color}) -> ${l.directions.length} directions`));

  console.log('\nTesting mataroTracker.getLineDetails("8", "0")...');
  const line8 = await mataroTracker.getLineDetails('8', '0');
  console.log('Line 8 details:');
  console.log(` - Name: ${line8.name} (${line8.directionName})`);
  console.log(` - Total Stops: ${line8.totalStops}`);
  console.log(` - Polyline points: ${line8.polyline.length}`);
  console.log(` - Active Buses: ${line8.activeBuses.length}`);
  if (line8.activeBuses.length > 0) {
    console.log('Sample Active Bus:', JSON.stringify(line8.activeBuses[0], null, 2));
  }

  console.log('\nTesting mataroTracker.getTargetStopETA("8", "1132", "0")...');
  const eta = await mataroTracker.getTargetStopETA('8', '1132', '0');
  console.log('Target Stop ETA:', JSON.stringify(eta, null, 2).substring(0, 1000));
}

test().catch(console.error);

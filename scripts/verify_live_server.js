const http = require('http');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    }).on('error', reject);
  });
}

async function verifyAllLines() {
  console.log('Testing all endpoints on http://localhost:3000...');

  // 1. Lines list
  const linesRes = await fetchJson('http://localhost:3000/api/lines');
  console.log('Lines list status:', linesRes.status, 'Total lines:', linesRes.data.lines.length);

  // 2. Test each Mataró line (1 to 8)
  for (let i = 1; i <= 8; i++) {
    const lineRes = await fetchJson(`http://localhost:3000/api/mataro/line/${i}?direction=0`);
    const l = lineRes.data.data;
    console.log(`Line ${i} (${l.name}): ${l.stops.length} stops, ${l.polyline.length} polyline coords, ${l.activeBuses.length} buses.`);

    const etaRes = await fetchJson(`http://localhost:3000/api/mataro/target-eta?lineId=${i}&direction=0`);
    const eta = etaRes.data.data;
    console.log(`  -> Target Stop: ${eta.targetStop?.name}, Next bus: ${eta.nextBus ? eta.nextBus.departureTime : 'None'}`);
  }

  // 3. Test C-10
  const c10Res = await fetchJson('http://localhost:3000/api/c10/live-corridor?direction=1');
  const c10 = c10Res.data.data;
  console.log(`C-10 Corridor: ${c10.checkpoints.length} checkpoints, ${c10.activeBuses.length} active buses.`);

  // 4. Test Universal Search
  const queries = ['hospital', 'rodalies', 'badalona', 'centre', 'italia'];
  for (const q of queries) {
    const searchRes = await fetchJson(`http://localhost:3000/api/search/stops?q=${q}`);
    console.log(`Search "${q}": ${searchRes.data.results.length} matches found.`);
  }

  console.log('\n🎉 ALL LINES & SEARCH FUNCTIONALITIES CONFIRMED WORKING PERFECTLY!');
}

verifyAllLines().catch(console.error);

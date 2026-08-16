const https = require('https');

async function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

(async () => {
  console.log('Testing Direction 0 for line 680 (N82)...');
  const d0 = await get('https://www.sagales.com/real-time-bus/680/0');
  console.log('D0 directionTravel in root:', d0.directionTravel);
  console.log('D0 entities count:', d0.bus?.entities?.length);
  d0.bus?.entities?.forEach((e, idx) => {
    console.log(`[D0 Entity ${idx}] ID: ${e.vehicle?.vehicle?.id}, trip.directionId: ${e.tripUpdate?.trip?.directionId || e.vehicle?.trip?.directionId}, headSign: ${e.tripUpdate?.trip?.headSign}`);
  });

  console.log('\nTesting Direction 1 for line 680 (N82)...');
  const d1 = await get('https://www.sagales.com/real-time-bus/680/1');
  console.log('D1 directionTravel in root:', d1.directionTravel);
  console.log('D1 entities count:', d1.bus?.entities?.length);
  d1.bus?.entities?.forEach((e, idx) => {
    console.log(`[D1 Entity ${idx}] ID: ${e.vehicle?.vehicle?.id}, trip.directionId: ${e.tripUpdate?.trip?.directionId || e.vehicle?.trip?.directionId}, headSign: ${e.tripUpdate?.trip?.headSign}`);
  });
})();

const http = require('http');
const app = require('../server');

const server = app.listen(3999, async () => {
  console.log('Server started on 3999. Benchmarking line switching calls...');

  async function bench(url) {
    const t0 = Date.now();
    try {
      const res = await new Promise((resolve, reject) => {
        http.get('http://localhost:3999' + url, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, data: JSON.parse(data) });
            } catch (err) {
              resolve({ status: res.statusCode, raw: data });
            }
          });
        }).on('error', reject);
      });
      const t1 = Date.now();
      console.log(`[${t1 - t0}ms] ${url} (Status ${res.status})`);
      return res;
    } catch(e) {
      const t1 = Date.now();
      console.log(`[${t1 - t0}ms] ${url} (FAILED: ${e.message})`);
    }
  }

  // Test various lines
  await bench('/api/lines');
  await bench('/api/line/c10?direction=1');
  await bench('/api/line/c10/target-eta?direction=1');
  await bench('/api/line/1?direction=0');
  await bench('/api/line/1/target-eta?direction=0');
  await bench('/api/line/n80?direction=0');
  await bench('/api/line/n80/target-eta?direction=0');
  await bench('/api/line/r1?direction=0');
  await bench('/api/line/r1/target-eta?direction=0');
  await bench('/api/line/b25?direction=0');
  await bench('/api/line/b25/target-eta?direction=0');
  await bench('/api/line/m1?direction=0');
  await bench('/api/line/m1/target-eta?direction=0');
  await bench('/api/line/603?direction=0');
  await bench('/api/line/603/target-eta?direction=0');
  const cataloniaTracker = require('../src/cataloniaTracker');
  await cataloniaTracker.init();
  const sampleCatId = cataloniaTracker.routes[0]?.id || 'cat_0001';
  await bench(`/api/line/${sampleCatId}?direction=0`);
  await bench(`/api/line/${sampleCatId}/target-eta?direction=0`);

  const ingestionDaemon = require('../src/ingestionDaemon');
  ingestionDaemon.stop();
  server.close();
  process.exit(0);
});

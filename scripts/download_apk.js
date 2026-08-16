const https = require('https');
const http = require('http');
const fs = require('fs');

async function getUrl(url) {
  return new Promise((resolve) => {
    const isHttps = url.startsWith('https:');
    const client = isHttps ? https : http;
    const req = client.get(url, {
      rejectUnauthorized: false,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 10000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(getUrl(res.headers.location));
      }
      let chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) });
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
  });
}

async function run() {
  console.log('Searching APK mirrors for com.geoactio.matarobus...');
  // Try apkpure direct download endpoint
  const res1 = await getUrl('https://d.apkpure.net/b/APK/com.geoactio.matarobus?version=latest');
  console.log('apkpure response:', res1.status, 'len:', res1.buffer ? res1.buffer.length : 0);

  if (res1.buffer && res1.buffer.length > 50000) {
    fs.writeFileSync('scripts/matarobus.apk', res1.buffer);
    console.log('🎉 Successfully downloaded matarobus.apk! Size:', res1.buffer.length);
  }
}

run().catch(console.error);

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('path');
const fs = require('fs');

const tmpRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'arribo-sse-'));
process.env.DATA_DIR = path.join(tmpRoot, 'data');
process.env.DB_PATH = path.join(tmpRoot, 'history.db');
process.env.REPORTS_DIR = path.join(tmpRoot, 'reports');
process.env.PORT = '0';

const app = require('../server');
const workerBridge = require('../src/core/WorkerBridge');

function getStream(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/fleet/events' }, (res) => {
      res.chunks = [];
      res.on('data', (c) => res.chunks.push(c));
      res.once('error', reject);
      resolve(res);
    });
    req.on('error', reject);
  });
}

function waitFor(res, substring, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const text = Buffer.concat(res.chunks).toString('utf8');
      if (text.includes(substring)) return resolve(text);
      if (Date.now() - started > timeoutMs) return reject(new Error(`Timed out waiting for "${substring}". Got: ${text.slice(0, 300)}`));
      res.once('data', check);
    };
    check();
  });
}

(async () => {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;

  try {
    // 1. HEAD rejected without opening a stream
    const headStatus = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/fleet/events', method: 'HEAD' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(headStatus, 405);

    // 2. New client gets explicit waiting state before first worker update
    const res = await getStream(port);
    assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.match(res.headers['cache-control'], /no-store|no-cache/);
    await waitFor(res, 'event: waiting');

    // 3. Worker-side fleet_update is broadcast as a full snapshot
    workerBridge.emit('fleet_update', { timestamp: 12345, vehicles: [{ vehicleId: 'mataro_1_999', lineId: '1', lat: 41.5, lon: 2.44 }] });
    const text = await waitFor(res, 'mataro_1_999');
    assert.match(text, /event: fleet/);
    assert.match(text, /"timestamp":12345/);

    // 4. A second client connected later receives the latest snapshot immediately
    const late = await getStream(port);
    await waitFor(late, 'mataro_1_999');

    // 5. Empty fleet update reaches clients (removals must propagate)
    workerBridge.emit('fleet_update', { timestamp: 12346, vehicles: [] });
    await waitFor(late, '"vehicles":[]');
    res.destroy();
    late.destroy();
    console.log('PASS: SSE snapshots, late-join replay, waiting state, HEAD rejection all verified');
  } finally {
    workerBridge.removeAllListeners('fleet_update');
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    workerBridge.shutdown?.().catch(() => {});
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

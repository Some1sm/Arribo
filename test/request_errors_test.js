// Malformed or unexpected requests get an answer: never a hung connection,
// never Express's HTML error page with a stack trace.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('path');
const fs = require('fs');

const tmpRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'arribo-reqerr-'));
process.env.DATA_DIR = path.join(tmpRoot, 'data');
process.env.DB_PATH = path.join(tmpRoot, 'history.db');
process.env.REPORTS_DIR = path.join(tmpRoot, 'reports');
process.env.PORT = '0';

const app = require('../server');
const workerBridge = require('../src/core/WorkerBridge');
const trackerRegistry = require('../src/core/TrackerRegistry');

function get(port, urlPath, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${timeoutMs} ms: ${urlPath}`)));
    req.on('error', reject);
  });
}

(async () => {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;

  try {
    // 1. ?q[]= and ?q[k]= arrive as an array / object: an empty search, not a hang.
    for (const p of ['/api/search/stops?q[]=a', '/api/search/stops?q[a]=b']) {
      const r = await get(port, p);
      assert.equal(r.status, 200, p);
      assert.deepEqual(JSON.parse(r.body).results, [], p);
    }

    // 2. An async handler that throws answers 500 JSON instead of hanging.
    const original = trackerRegistry.searchStopsAndLines;
    trackerRegistry.searchStopsAndLines = () => { throw new Error('boom'); };
    try {
      const r = await get(port, '/api/search/stops?q=rambla');
      assert.equal(r.status, 500);
      assert.match(r.type, /application\/json/);
      assert.deepEqual(JSON.parse(r.body), { success: false, error: 'Internal server error' });
    } finally {
      trackerRegistry.searchStopsAndLines = original;
    }

    // 3. An undecodable path parameter keeps its 400, as JSON with no stack trace.
    const bad = await get(port, '/api/vehicle/%E0%A4%A/trail');
    assert.equal(bad.status, 400);
    assert.match(bad.type, /application\/json/);
    assert.doesNotMatch(bad.body, /URIError|node_modules|at /);

    // 4. app.get(name) is still Express's settings getter.
    assert.equal(typeof app.get('env'), 'string');

    console.log('PASS: array queries, async throws, bad path params and the settings getter all answer correctly');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    workerBridge.shutdown?.().catch(() => {});
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

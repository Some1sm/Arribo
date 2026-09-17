const assert = require('node:assert/strict');
const { test } = require('node:test');
const { securityHeaders, createApiLimiter, trustedProxies } = require('../src/core/httpProtection');

function mockReq({ method = 'GET', path = '/api/lines', ip = '10.0.0.1' } = {}) {
  return { method, path, url: path, originalUrl: path, ip, socket: { remoteAddress: ip }, headers: {} };
}

function mockRes() {
  const headers = {};
  return {
    statusCode: null,
    headers,
    body: null,
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

function runMiddleware(mw, req) {
  const res = mockRes();
  let passed = false;
  mw(req, res, () => { passed = true; });
  return { passed, status: res.statusCode, headers: res.headers };
}

test('security headers set core directives', () => {
  const { headers } = runMiddleware(securityHeaders, mockReq());
  const csp = headers['content-security-policy'];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src-attr 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /connect-src 'self'/);
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.equal(headers['x-frame-options'], 'DENY');
});

test('limiter enforces analytics budget separately and health is exempt', () => {
  let clock = 1000000;
  const limiter = createApiLimiter({ now: () => clock, limit: 3, analyticsLimit: 2, windowMs: 60000 });
  const run = (path, ip = '10.0.0.1') => runMiddleware(limiter, mockReq({ path, ip }));

  assert.equal(run('/api/health').passed, true, 'health exempt');
  assert.equal(run('/api/health').passed, true, 'health exempt under load');

  assert.equal(run('/api/analytics/ranking').passed, true);
  assert.equal(run('/api/retards/ranking').passed, true);
  assert.equal(run('/api/analytics/export/csv').passed, false, 'third analytics hit limited');
  const limited = run('/api/analytics/ranking');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) >= 1);

  assert.equal(run('/api/lines').passed, true, 'general budget still has room');
  assert.equal(run('/api/lines').passed, false, 'shared general budget enforced (3 total incl. analytics)');

  clock += 60001;
  assert.equal(run('/api/lines').passed, true, 'window expiry resets');
  assert.equal(run('/api/retards/termometre').passed, true, 'analytics budget also resets');
});

test('limiter normalizes IPv6-mapped clients and isolates distinct IPs', () => {
  const limiter = createApiLimiter({ limit: 1, analyticsLimit: 1, now: () => 5000 });
  assert.equal(runMiddleware(limiter, mockReq({ ip: '::ffff:10.1.1.5' })).passed, true);
  assert.equal(runMiddleware(limiter, mockReq({ ip: '10.1.1.5' })).passed, false, 'IPv4-mapped IPv6 shares the IPv4 bucket');
  assert.equal(runMiddleware(limiter, mockReq({ ip: '10.1.1.6' })).passed, true, 'different IP independent');
});

test('limiter bounds its client store under unbounded source addresses', () => {
  let clock = 0;
  const limiter = createApiLimiter({ limit: 999, analyticsLimit: 999, now: () => ++clock, maxClients: 50 });
  let accepted = 0;
  for (let i = 0; i < 5000; i++) {
    const ip = `10.${Math.floor(i / 250) % 250}.${i % 250}.${(i * 7) % 250}`;
    if (runMiddleware(limiter, mockReq({ ip })).passed) accepted++;
  }
  assert.ok(accepted <= 51, `store bounded (accepted ${accepted})`);
});

test('non-GET/HEAD requests bypass the limiter', () => {
  const limiter = createApiLimiter({ limit: 1, analyticsLimit: 1, now: () => 7000 });
  assert.equal(runMiddleware(limiter, mockReq({ method: 'POST', path: '/api/lines' })).passed, true);
  assert.equal(runMiddleware(limiter, mockReq({ method: 'OPTIONS', path: '/api/lines' })).passed, true);
});

test('trustedProxies parses valid CIDRs and rejects malformed entries', () => {
  assert.deepEqual(trustedProxies(' 10.0.0.0/8 , 2001:db8::/32 '), ['10.0.0.0/8', '2001:db8::/32']);
  assert.deepEqual(trustedProxies(''), []);
  assert.deepEqual(trustedProxies('127.0.0.1'), ['127.0.0.1']);
  assert.throws(() => trustedProxies('not-an-ip'), /TRUSTED_PROXIES/);
  assert.throws(() => trustedProxies('10.0.0.0/99'), /TRUSTED_PROXIES/);
  assert.throws(() => trustedProxies('10.0.0.0/8/9'), /TRUSTED_PROXIES/);
});

test('real Express app: headers on responses, 429 JSON shape, health exempt', async () => {
  const express = require('express');
  const app = express();
  let server;
  app.use(securityHeaders);
  app.use('/api', createApiLimiter({ limit: 100, analyticsLimit: 10 }));
  app.get('/api/lines', (req, res) => res.json({ ok: true }));
  app.get('/api/analytics/ranking', (req, res) => res.json({ ok: true }));
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  const port = await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1');
    server.once('listening', () => resolve(server.address().port));
    server.once('error', reject);
  });

  const request = (path, method = 'GET') => new Promise((resolve, reject) => {
    const req = require('node:http').request({ host: '127.0.0.1', port, path, method, headers: { Connection: 'close' } }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });

  try {
    const home = await request('/');
    assert.equal(home.status, 404);
    assert.ok(home.headers['content-security-policy'], 'CSP also on error responses');
    assert.equal(home.headers['x-content-type-options'], 'nosniff');

    const api = await request('/api/lines');
    assert.equal(api.status, 200);
    assert.ok(api.headers['content-security-policy']);

    let last = null;
    for (let i = 0; i < 15; i++) last = await request('/api/analytics/ranking');
    assert.equal(last.status, 429);
    assert.equal(JSON.parse(last.body).success, false);
    assert.ok(last.headers['retry-after']);
    assert.equal(last.headers['cache-control'], 'no-store');

    const health = await request('/api/health');
    assert.equal(health.status, 200, 'health stays reachable while others limited');

    const head = await request('/api/lines', 'HEAD');
    assert.equal(head.status, 200, 'HEAD still served');
  } finally {
    server.closeAllConnections?.();
    server.close();
    await new Promise(resolve => server.on('close', resolve));
  }
});

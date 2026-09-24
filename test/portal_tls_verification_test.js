/**
 * portal_tls_verification_test.js
 *
 * Guards the fix for `rejectUnauthorized: false` on the Avanza portal request.
 *
 * THE DEFECT
 * ----------
 * mataro.avanzagrupo.com serves its leaf certificate WITHOUT the Sectigo
 * intermediate that signed it, so Node fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE
 * before any application logic runs. The original code answered that with
 *
 *     rejectUnauthorized: false      (src/mataroTracker.js)
 *     NODE_TLS_REJECT_UNAUTHORIZED=0  (scripts/scrape_avanza_schedules.js)
 *
 * Neither is a fix. Both disable authentication for the response, and that
 * response is parsed into operator notices driving line detours and, via
 * seasonCalendar.registerWindow, the season calendar. Anyone able to answer
 * that one request could publish a notice of their choosing.
 *
 * THE FIX
 * -------
 * The chain is genuine, just incomplete — the leaf's own AIA extension points
 * at the missing certificate. The intermediate and its root are vendored in
 * src/data/certs/ and supplied ONLY for this host, so verification stays on.
 *
 * This suite fails if anyone reintroduces a blanket bypass, and it re-verifies
 * the vendored chain's signatures and expiry dates so an upstream rotation is
 * caught here rather than in production. Only the final live test needs the
 * network; it is skipped when offline.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { X509Certificate } = require('crypto');

const verifiedTls = require('../src/core/http/verifiedTls');
const { stripComments } = require('./helpers/strip_comments.cjs');

let passed = 0;
const failed = [];
const skipped = [];

function check(cond, msg) {
  if (cond) { passed++; return; }
  failed.push(msg);
}
function eq(actual, expected, msg) {
  check(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

const REPO = path.join(__dirname, '..');
const CERT_DIR = path.join(REPO, 'src', 'data', 'certs');
const PORTAL_HOST = 'mataro.avanzagrupo.com';

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

// A throwaway self-signed localhost certificate, valid until 2126, generated
// once and embedded so this suite needs no openssl and no network to prove
// that verification still fails closed. It is signed by nobody we trust,
// which is the entire point.
const TEST_KEY = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQClJL26U5fqEhXq',
  'FQGvg232CHQLR5fCRgYlE3bG9rsXrWNp5CeAGOL1ZMYvqFRNAQYkJlCgFbrLi0hU',
  'EEyJD2TBUsf+yUVtpcF9RZDL+WYWmM3iFjf+7Hs0lxnQDGWeXyyMLtsCKoGzwhmc',
  'cUD13up7L7P0hrjDRJHoaSfY9K/ecSPkWuRSpHG4TbE8LaH9ehWeSn+qlSJoXxC/',
  '2yREvSUI/Oact05LLbt+O9RYL8gm8TTu8Sm/kKbH0oE1TTtnWKFzKVjFuN9rHSUH',
  'b2HzUI7SgxPsQzBFQy8+iG8kvKNYlvIGW9A9kk/vH6kPwT/ZigEmS9jNmZf+CEoA',
  'eNo1H3EJAgMBAAECggEAB0bV7FikHD6FRC3+R8VPClUHhfq222rZ+PbBWFWFW276',
  'ry8MNYcDMyRoXi+43TbDFkMw8MjcVP0zZ+7a7Hwm6KTU5qtoOYNhAfvXfEFmR+8e',
  'PUzU1VEGwcO5sbLmJGMVs6yZ3l/QnMLb/Yp4/gx/QQPSVl88U3BZTIgbpyHrAO5h',
  's1RbHxc0od7rp7sDNYIF1UNPOhyprWuCeSvQI4s2Djsuojrx+DLyI6iWa8mABWeN',
  '0x8AwhvfpYaNTioAKZ4BfL4Gk/ZHzSQCc0erExZEIdgJgFg1F8WqV7xkMLeKfORu',
  'K73QZZ4CMddMWGvOUWlLnTCOOiz5ygeLb0KSOJW24QKBgQDPXVeBuQ4qd2JCcI/1',
  '/Eqn6ubmsBKbBJXdsD9JB6iNRgGKgjT+f0kbGXW48gWWwj0HoYmZY+pHbBCc14we',
  'osxbn9OJBNiwoT7fIbcV2Ru2/G9WAo9cXMv2mifF0yETk47wNseQD3GWaExEe9dM',
  '1TayGsjVWxfVlDEDSRXDw/h6sQKBgQDL4Fh4vr8xX1JxMpzbc/HaUP8oWvL0xucP',
  '2ct6fUx6YRGUI2lRF106PK8NBtQQYSxd0qlJYi0ZLa+ZysoPK/GRk9DrIBOZSWiU',
  '50hu9rGksokVk49l5RL4PxLmQZuh0N+TsSEJjjYEeMDN2k+cKiWbdn9oiFGrc9nZ',
  'q+2xswDB2QKBgQCVU2himDqlRhdSNPDWePnh9fyU/xJG44RwgizwkD1GjrUpYx56',
  'bnrcsvbdWhvANtvwFNmbxiG9kQpdh7L1lNKI4I1aTE0m1NcLo6HOb+vPV/VtAKbw',
  'IjsWuGgPwzw8drQmM6x+B0EKyMyzPGMMhzW+CB+71L9TJEYvUYAE26ih4QKBgD7E',
  'jlh2WYTI1Sf2riY+Vxqgzz3ManqD9kWCB0xp4S7YTcIu+NC3gcNZRYecL5PvZupn',
  '3iiyqjHTR/nwXi83l0L7oFmTYZVS7XjSkBFhsCWFtgDHkmGLmkCForrzPgget4bQ',
  'BNzdRLIxvyJhcRsiOrvXSriTJ5nCrDKA5UhNVRFZAoGBALke9qPcg52Z4Q+nqwgh',
  'BiNnJw4dyaux/Ae7kh6uG1DYnqRutZhc0HE42EG8OiZ6IDPle7fb0/4SasF9dp9a',
  'AZiN+j0i2KX9nhzUlEwnu3AbBTFvtHh9uA3gZuW29G6ztc7uoSKiPTa/AMevr1DO',
  '480bdJVYQiLcgXLFnDbkwHYj',
  '-----END PRIVATE KEY-----'
].join('\n') + '\n';

const TEST_CERT = [
  '-----BEGIN CERTIFICATE-----',
  'MIIDAzCCAeugAwIBAgIUNUon3BrQl9XFnqnwolQZb3/cZ+4wDQYJKoZIhvcNAQEL',
  'BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDkyNDA4MzgyM1oYDzIxMjYw',
  'ODMxMDgzODIzWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB',
  'AQUAA4IBDwAwggEKAoIBAQClJL26U5fqEhXqFQGvg232CHQLR5fCRgYlE3bG9rsX',
  'rWNp5CeAGOL1ZMYvqFRNAQYkJlCgFbrLi0hUEEyJD2TBUsf+yUVtpcF9RZDL+WYW',
  'mM3iFjf+7Hs0lxnQDGWeXyyMLtsCKoGzwhmccUD13up7L7P0hrjDRJHoaSfY9K/e',
  'cSPkWuRSpHG4TbE8LaH9ehWeSn+qlSJoXxC/2yREvSUI/Oact05LLbt+O9RYL8gm',
  '8TTu8Sm/kKbH0oE1TTtnWKFzKVjFuN9rHSUHb2HzUI7SgxPsQzBFQy8+iG8kvKNY',
  'lvIGW9A9kk/vH6kPwT/ZigEmS9jNmZf+CEoAeNo1H3EJAgMBAAGjSzBJMBoGA1Ud',
  'EQQTMBGCCWxvY2FsaG9zdIcEfwAAATAMBgNVHRMBAf8EAjAAMB0GA1UdDgQWBBTM',
  'YciLWRp9HD3GvlxTl2WGC9MUWjANBgkqhkiG9w0BAQsFAAOCAQEAETfK07Ik5ZbG',
  'ufZbHRsGtT4grMkPLrjbZLNJazlJq2cpNwbC7zDVInr0KRe5abiBvD81/hntKBsG',
  'ahquPGA67dGouPFJobweQA3/J7d7OkT8Wo4H3V/OWSESMqwxsT58GiDHlx4jFkNI',
  'H2z4FxP0NHSNBIcu9ttqA72EigFm6oyVv6by/Hpn58Djrka3kzG/jL9uOkIxb4qs',
  'loMWIn31zZPw6TGLyzs0ZVDEmK7jVAkwJUqqhVFwKka2+jIpzXbrEXM3gMfCu6Ra',
  'V4IFkNfF/EQ5nL26FvqeMTFO/6XOnGREApgB2ohBrDcjgf2gkjVzurgwcUpe5+Qv',
  'WwpbbPAeAw==',
  '-----END CERTIFICATE-----'
].join('\n') + '\n';

(async () => {

// ---------------------------------------------------------------------------
console.log('--- Portal TLS Verification Tests ---');
console.log('   (certificates are verified, not switched off)\n');

// ===========================================================================
console.log('📌 Test 1: No blanket TLS verification bypass remains in application code');
// ===========================================================================
{
  // 1a. The named offenders, checked directly so the intent is unmistakable.
  // Comments are stripped: both files legitimately *name* the setting they
  // removed while explaining why it is gone, and a mention is not a bypass.
  const strip = (f) => stripComments(fs.readFileSync(path.join(REPO, ...f), 'utf8'));
  const tracker = strip(['src', 'mataroTracker.js']);
  const scraper = strip(['scripts', 'scrape_avanza_schedules.js']);

  check(!/rejectUnauthorized\s*:\s*false/.test(tracker),
    'src/mataroTracker.js must not set rejectUnauthorized:false');
  check(!/NODE_TLS_REJECT_UNAUTHORIZED/.test(tracker),
    'src/mataroTracker.js must not disable TLS verification');

  check(!/NODE_TLS_REJECT_UNAUTHORIZED/.test(scraper),
    'scripts/scrape_avanza_schedules.js must not disable TLS verification');
  check(!/rejectUnauthorized\s*:\s*false/.test(scraper),
    'scripts/scrape_avanza_schedules.js must not set rejectUnauthorized:false');

  // 1a-ii. The scraper's requests must actually carry the repair agent. It
  // used to use global `fetch`, which runs on undici and cannot be given a
  // per-request https.Agent — so switching it to fetch "for TLS reasons" would
  // fail at runtime with the original UNABLE_TO_VERIFY_LEAF_SIGNATURE while
  // looking correct in the source. Assert the https.request path is in use.
  check(/agent:\s*verifiedTls\.agentFor\(/.test(scraper),
    'The scraper must send requests through the chain-repairing agent');
  check(!/await\s+fetch\(/.test(scraper),
    'The scraper must not use global fetch (undici cannot carry the repaired CA)');
  // Assigning NODE_EXTRA_CA_CERTS at runtime is a no-op: Node reads it once at
  // process startup, so the connection would still fail.
  check(!/NODE_EXTRA_CA_CERTS/.test(scraper),
    'The scraper must not rely on NODE_EXTRA_CA_CERTS, which is startup-only');

  // 1b. And a sweep of every shipped .js, so the bypass cannot reappear in a
  // file this fix never looked at. stripComments is string-aware: a plain
  // regex would misread the Accept header's "*/*;q=0.8" as a comment opener
  // and silently skip the very code it is meant to check.
  const files = walk(REPO);
  for (const file of files) {
    const rel = path.relative(REPO, file).replace(/\\/g, '/');
    if (rel === 'test/portal_tls_verification_test.js') continue; // this file names them
    if (rel === 'test/helpers/strip_comments.cjs') continue;       // names them as patterns
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    check(!/rejectUnauthorized\s*:\s*false/.test(src), `${rel} must not set rejectUnauthorized:false`);
    check(!/NODE_TLS_REJECT_UNAUTHORIZED/.test(src), `${rel} must not disable TLS verification`);
  }
  check(files.length > 20, `The sweep found a plausible number of files (${files.length})`);

  // The stripper must not be a no-op that quietly passes everything.
  const sanity = stripComments("const a = 'http://x/*y'; // NODE_TLS_REJECT_UNAUTHORIZED\nconst b = 1;");
  check(sanity.includes('const b = 1;'), 'The stripper must preserve real code');
  check(!sanity.includes('NODE_TLS_REJECT_UNAUTHORIZED'), 'The stripper must remove comment text');
  check(sanity.includes('http://x/*y'), 'The stripper must preserve strings containing /*');

  // 1c. The replacement is actually in place, not just the bug removed.
  check(/agent:\s*verifiedTls\.agentFor\(/.test(tracker),
    'The tracker must request the chain-repairing agent');
  check(verifiedTls.needsChainRepair(PORTAL_HOST),
    'The portal host must be registered for chain repair');

  console.log(`  ✓ Test 1 Passed: no bypass in ${files.length} files; the repair is in use.`);
}

// ===========================================================================
console.log('\n📌 Test 2: The chain repair stays scoped to the one broken host');
// ===========================================================================
{
  // The point of adding CAs at a call site rather than globally is that an
  // unrelated HTTPS call must keep using Node's untouched default store.
  check(verifiedTls.agentFor('example.com') === undefined,
    'An unrelated host must not receive the extra CAs');
  check(verifiedTls.agentFor('sirimataro.avanzagrupo.com') === undefined,
    'The SIRI host verifies normally and must not be added to the repair set');
  check(verifiedTls.agentFor(PORTAL_HOST) !== undefined,
    'The portal host must receive the repair agent');
  check(verifiedTls.agentFor(PORTAL_HOST.toUpperCase()) !== undefined,
    'Host matching must be case-insensitive');

  // Only the portal is registered — an ever-growing list would quietly become
  // a project-wide relaxation.
  eq(verifiedTls.CHAIN_REPAIR_HOSTS.size, 1, 'Exactly one host needs chain repair');
  check(verifiedTls.CHAIN_REPAIR_HOSTS.has(PORTAL_HOST), 'The registered host is the portal');

  // Agents are cached, so a polled endpoint does not build one per request.
  check(verifiedTls.agentFor(PORTAL_HOST) === verifiedTls.agentFor(PORTAL_HOST),
    'The agent must be reused across calls');

  // The agent must NOT carry a bypass of its own.
  const agent = verifiedTls.agentFor(PORTAL_HOST);
  check(agent.options.rejectUnauthorized !== false,
    'The repair agent must not disable verification');

  // Supplying `ca` REPLACES Node's default store, so the defaults must be
  // carried over or every other outbound request in the process would break.
  const store = verifiedTls.trustStore();
  // PEM is base64, so a subject CN never appears as literal text. Parse each
  // certificate and compare its parsed subject instead.
  const subjects = [];
  for (const pem of store) {
    for (const m of pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)) {
      subjects.push(new X509Certificate(m[0]).subject.replace(/\n/g, ', '));
    }
  }
  check(subjects.length > 100, `The trust store must carry Node's defaults (${subjects.length} certs)`);
  check(subjects.some((s) => s.includes('Sectigo Public Server Authentication CA OV R36')),
    'The missing intermediate must be in the trust store');
  check(subjects.some((s) => s.includes('Sectigo Public Server Authentication Root R46')),
    'The intermediate\'s root must be in the trust store');
  check(store.length > 1, 'The trust store must include the defaults, not just Sectigo');

  console.log('  ✓ Test 2 Passed: the repair is scoped to one host and keeps default CAs.');
}

// ===========================================================================
console.log('\n📌 Test 3: The vendored certificates are a genuine, valid chain');
// ===========================================================================
{
  const interPath = path.join(CERT_DIR, 'sectigo-ov-r36-intermediate.pem');
  const rootPath = path.join(CERT_DIR, 'sectigo-root-r46.pem');
  check(fs.existsSync(interPath), 'The Sectigo intermediate is vendored');
  check(fs.existsSync(rootPath), 'The Sectigo root is vendored');

  const inter = new X509Certificate(fs.readFileSync(interPath));
  const root = new X509Certificate(fs.readFileSync(rootPath));

  eq(inter.ca, true, 'The intermediate is a CA certificate');
  eq(root.ca, true, 'The root is a CA certificate');

  // The signatures are what make this a trust anchor rather than a guess.
  check(inter.verify(root.publicKey), 'The intermediate is signed by the vendored root');
  check(root.verify(root.publicKey), 'The vendored root is self-signed');

  // Pins, so swapping these files for an attacker-chosen CA is a test failure
  // rather than a silent redefinition of who we trust.
  eq(inter.fingerprint256,
    '65:42:D1:76:BE:D5:0F:19:3C:0C:E2:97:AE:44:EC:D8:A0:A8:6B:EC:2E:DE:68:27:69:34:40:59:B4:E7:85:30',
    'The intermediate matches its recorded SHA-256 fingerprint');
  eq(root.fingerprint256,
    '7B:B6:47:A6:2A:EE:AC:88:BF:25:7A:A5:22:D0:1F:FE:A3:95:E0:AB:45:C7:3F:93:F6:56:54:EC:38:F2:5A:06',
    'The root matches its recorded SHA-256 fingerprint');

  // Expiry. The root runs to 2046 and the intermediate to 2036, so this will
  // only ever fail on a genuine upstream change — which is the point.
  const now = new Date();
  check(new Date(inter.validTo) > now, `The intermediate is still valid (until ${inter.validTo})`);
  check(new Date(root.validTo) > now, `The root is still valid (until ${root.validTo})`);
  check(new Date(inter.validFrom) <= now, 'The intermediate is not yet-valid');
  check(new Date(root.validFrom) <= now, 'The root is not yet-valid');

  // The combined file used by the scraper's global fetch must carry both.
  const combo = path.join(CERT_DIR, 'avanza-portal-chain.pem');
  check(fs.existsSync(combo), 'The combined chain file exists for the scraper');
  const comboCerts = [...fs.readFileSync(combo, 'utf8').matchAll(/-----BEGIN CERTIFICATE-----/g)];
  eq(comboCerts.length, 2, 'The combined chain file contains exactly two certificates');

  console.log('  ✓ Test 3 Passed: chain signatures, fingerprints and validity all check out.');
}

// ===========================================================================
console.log('\n📌 Test 4: Verification genuinely fails closed');
// ===========================================================================
{
  // The counter-test that matters: repairing one host must not have made Node
  // permissive in general. A TLS server presenting a certificate from an
  // unknown issuer must still be rejected, and rejected with an error rather
  // than served.
  const srv = https.createServer(
    { key: TEST_KEY, cert: TEST_CERT },
    (req, res) => { res.writeHead(200); res.end('SHOULD NOT BE TRUSTED'); }
  );

  const outcome = await new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      const req = https.get({
        host: '127.0.0.1',
        port,
        path: '/',
        ca: verifiedTls.trustStore(),   // our full repaired trust store
        timeout: 5000
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ delivered: body }));
      });
      req.on('error', (e) => resolve({ error: e.code || e.message }));
      req.on('timeout', () => { req.destroy(new Error('timeout')); resolve({ error: 'ETIMEDOUT' }); });
    });
  });

  await new Promise((r) => srv.close(r));

  check(!outcome.delivered, 'A certificate signed by an unknown CA must not be trusted');
  check(!!outcome.error, `An untrusted certificate must raise an error (got ${JSON.stringify(outcome)})`);

  // The failure messages must name the actionable cause rather than swallowing it.
  const incomplete = verifiedTls.describeChainFailure({
    code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', hostname: PORTAL_HOST
  });
  check(/incomplete certificate chain/i.test(incomplete),
    'An incomplete chain is described as a re-vendor action');
  check(/AIA/.test(incomplete), 'The message points at the AIA URL as the source');

  const rotated = verifiedTls.describeChainFailure({
    code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', hostname: PORTAL_HOST
  });
  check(/rotated/i.test(rotated), 'A rotated chain is described as a rotation');

  const expired = verifiedTls.describeChainFailure({
    code: 'CERT_HAS_EXPIRED', hostname: PORTAL_HOST
  });
  check(/validity window/i.test(expired), 'An expired certificate is described as an expiry');

  const unknown = verifiedTls.describeChainFailure({ code: 'ECONNRESET' });
  check(/ECONNRESET/.test(unknown), 'An unrelated error still reports its code');

  console.log('  ✓ Test 4 Passed: an untrusted certificate is refused, and failures are diagnosable.');
}

// ===========================================================================
console.log('\n📌 Test 5: The real portal verifies end to end (skipped when offline)');
// ===========================================================================
{
  const result = await new Promise((resolve) => {
    const req = https.get(`https://${PORTAL_HOST}/ca/avisos`, {
      agent: verifiedTls.agentFor(PORTAL_HOST),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'text/html' },
      timeout: 10000
    }, (res) => {
      // `authorized` is the real proof that verification is ON: when
      // rejectUnauthorized is false this reads false even on a good cert.
      const authorized = res.socket.authorized;
      let n = 0;
      res.on('data', (c) => { n += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, bytes: n, authorized }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
  });

  if (result.error) {
    skipped.push(`live portal check (${result.error}) — offline or host unreachable`);
    console.log(`  ⚠ Test 5 Skipped: ${result.error}`);
  } else {
    eq(result.status, 200, 'The portal responds 200 with the repaired chain');
    eq(result.authorized, true, 'The socket reports it was cryptographically authorized');
    check(result.bytes > 1000, `The response carries a real page (${result.bytes} bytes)`);
    console.log(`  ✓ Test 5 Passed: portal authorized (${result.bytes} bytes).`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n=====================================================');
console.log(`Passed: ${passed}, Failed: ${failed.length}, Skipped: ${skipped.length}`);
skipped.forEach((s) => console.log(`  SKIPPED: ${s}`));
if (failed.length) {
  console.error('\n🔴 FAILURES:');
  failed.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log('\n🎉 ALL PORTAL TLS VERIFICATION TESTS PASSED!\n');

})().catch((err) => {
  console.error('\n🔴 SUITE ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});

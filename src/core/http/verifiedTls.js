/**
 * verifiedTls.js — outbound HTTPS that does not have to be switched off.
 *
 * WHY THIS EXISTS
 * ---------------
 * `mataro.avanzagrupo.com` (the Liferay portal that publishes official
 * notices, and that the timetable scraper reads) serves its leaf certificate
 * WITHOUT the Sectigo intermediate that signed it. Node cannot build a chain
 * from a leaf alone, so verification fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE
 * before any application code runs.
 *
 * The original workaround was `rejectUnauthorized: false`, which is not a fix —
 * it disables authentication for the response entirely. On this endpoint that
 * response is parsed into operator notices that then drive line detours and
 * the season calendar (see seasonCalendar.registerWindow). Anyone able to
 * answer this one request could therefore publish a notice of their choosing.
 *
 * The chain is genuinely valid, just incomplete. The leaf's own AIA extension
 * points at the missing intermediate:
 *
 *   CA Issuers - URI: http://crt.sectigo.com/SectigoPublicServerAuthenticationCAOVR36.crt
 *
 * so we vendor the intermediate and its root, and supply them ONLY for this
 * host. Chain of trust, verified at the time of writing:
 *
 *   *.avanzagrupo.com                     (leaf, served by the portal)
 *     └─ Sectigo Public Server Authentication CA OV R36   [vendored, 2021-03-22 → 2036-03-21]
 *          └─ Sectigo Public Server Authentication Root R46 [vendored, 2021-03-22 → 2046-03-22]
 *
 * Both PEMs live in src/data/certs/ and are checked by
 * test/portal_tls_verification_test.js, which re-verifies the signatures and
 * the expiry dates on every run. A rotation upstream breaks that test loudly
 * rather than silently failing at runtime in production.
 *
 * NOT A BLANKET DISABLE
 * ---------------------
 * This adds two CAs to Node's normal trust store. It never removes one, and it
 * never sets rejectUnauthorized:false anywhere. Hosts that do not need the
 * repair keep using Node's default store unchanged, so this cannot weaken
 * anything else. The two additions are scoped to a single host at the call
 * site rather than applied globally, precisely so the blast radius stays at
 * one misconfigured endpoint.
 *
 * FAILING CLOSED
 * --------------
 * If the portal ever rotates to a chain we do not hold, the request fails with
 * a normal TLS error and the caller falls back to the last known notices. That
 * is the correct trade: a stale notice is better than a forged one, and
 * `describeChainFailure` turns the failure into an actionable message naming
 * the host and the cert error instead of a bare ECONNRESET.
 */

'use strict';

const fs = require('fs');
const https = require('https');
const tls = require('tls');
const path = require('path');

const CERT_DIR = path.join(__dirname, '..', '..', 'data', 'certs');

/**
 * Hosts whose chain is incomplete upstream. Keyed by hostname so adding
 * another misconfigured portal is a one-line change and cannot accidentally
 * widen the set of hosts that get the extra CAs.
 */
const CHAIN_REPAIR_HOSTS = new Set(['mataro.avanzagrupo.com']);

const AGENTS = new Map();

function readCert(fileName) {
  const full = path.join(CERT_DIR, fileName);
  return fs.readFileSync(full, 'utf8');
}

// Node verifies a chain against this list INSTEAD of the built-in store when
// `ca` is set, so the defaults must be carried over explicitly. Omitting them
// would break every other outbound HTTPS call in the process. `tls.rootCertificates`
// is Node's default store as PEM strings; `https.globalAgent.options.ca` is
// undefined and is NOT a source for it.
const SECTIGO_CA = [
  readCert('sectigo-root-r46.pem'),
  readCert('sectigo-ov-r36-intermediate.pem')
].join('\n');

/**
 * The default Node trust store plus the vendored Sectigo chain.
 * @returns {string[]} PEM strings accepted by https.Agent's `ca` option.
 */
function trustStore() {
  return [...tls.rootCertificates, SECTIGO_CA];
}

/**
 * An https.Agent that trusts the vendored chain, for `hostname` only.
 *
 * @param {string} hostname
 * @returns {https.Agent|undefined} undefined when the host needs no repair, so
 *   the caller can simply use the default agent.
 */
function agentFor(hostname) {
  if (!CHAIN_REPAIR_HOSTS.has(String(hostname || '').toLowerCase())) return undefined;
  const cached = AGENTS.get(hostname);
  if (cached) return cached;
  // keepAlive is deliberately off: avisos are polled every 5 minutes, so a
  // pooled socket would mostly sit idle holding a file descriptor.
  const agent = new https.Agent({ ca: trustStore(), keepAlive: false });
  AGENTS.set(hostname, agent);
  return agent;
}

/**
 * True when this host's chain is repaired rather than merely trusted by default.
 * Exported so the regression test can assert the repair stays scoped.
 * @param {string} hostname
 * @returns {boolean}
 */
function needsChainRepair(hostname) {
  return CHAIN_REPAIR_HOSTS.has(String(hostname || '').toLowerCase());
}

/**
 * Turns a TLS failure into something an operator can act on. The overwhelmingly
 * likely cause after this file was written is a certificate rotation upstream.
 *
 * @param {Error & {code?: string, hostname?: string}} err
 * @returns {string}
 */
function describeChainFailure(err) {
  const code = (err && err.code) || 'UNKNOWN';
  const host = (err && (err.hostname || err.host)) || 'the portal';
  switch (code) {
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return `${host}: still serving an incomplete certificate chain (${code}). Re-vendor the intermediate in src/data/certs/ from the leaf's AIA URL.`;
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return `${host}: certificate is no longer issued by the vendored Sectigo root (${code}). The portal has likely rotated to a new CA — re-vendor the chain.`;
    case 'CERT_HAS_EXPIRED':
    case 'CERT_NOT_YET_VALID':
      return `${host}: certificate is outside its validity window (${code}). Check whether a vendored CA in src/data/certs/ has expired.`;
    default:
      return `${host}: TLS request failed (${code}).`;
  }
}

module.exports = {
  CHAIN_REPAIR_HOSTS,
  SECTIGO_CA,
  agentFor,
  needsChainRepair,
  describeChainFailure,
  trustStore
};

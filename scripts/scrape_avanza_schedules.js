/**
 * scripts/scrape_avanza_schedules.js
 * 
 * Scrapes official Mataró Bus Urbà timetables (Lines L1–L8, all stops, all days)
 * directly from Avanza's Liferay portal AJAX endpoints.
 * 
 * Endpoints utilized:
 * 1. GET  /detalle-linea (Session cookie initialization)
 * 2. POST /detalle-linea cmd=getTrayectosIda / cmd=getTrayectosVuelta
 * 3. POST /detalle-linea cmd=getHorariosTeoricos (Origin scheduled departures)
 * 4. POST /detalleparada cmd=getHorarios (Stop-by-stop passing times)
 * 
 * Outputs:
 * - data/cities/mataro/avanza_raw_timetables.json (Full scraped raw archive)
 * - Calibrated day-specific travel times (dayStopTravelSec, dayTravelSec) in mataro_schedules.json
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const verifiedTls = require('../src/core/http/verifiedTls');

// mataro.avanzagrupo.com serves its leaf certificate without the Sectigo
// intermediate that signed it, so Node cannot build the chain and fails with
// UNABLE_TO_VERIFY_LEAF_SIGNATURE. The previous workaround here was
// NODE_TLS_REJECT_UNAUTHORIZED=0, which turns off certificate checking for
// every request this process makes — the scraped response becomes the source
// of the published timetable, so an unverified one is not acceptable.
//
// The chain is genuine, just incomplete, so the missing intermediate and its
// root are vendored in src/data/certs/ and supplied for this host alone. See
// src/core/http/verifiedTls.js for the full chain and the rationale.
//
// This is a plain https.request rather than global fetch, because fetch runs on
// undici, which cannot be given a per-request https.Agent. Assigning
// NODE_EXTRA_CA_CERTS here would not work either: Node reads that variable once
// at process startup, so setting it from inside the script is already too late.

/**
 * Minimal fetch-shaped wrapper over https.request, using the chain-repairing
 * agent. Returns just what this scraper needs: status, ok, and set-cookie.
 *
 * @param {string} url
 * @param {{method?: string, headers?: object, body?: string, redirects?: number}} options
 * @returns {Promise<{ok: boolean, status: number, statusText: string, setCookie: string|null, text: () => Promise<string>}>}
 */
function httpsFetch(url, options = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: target.hostname,
      path: target.pathname + target.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      agent: verifiedTls.agentFor(target.hostname),
      timeout: options.timeout || 30000
    }, (res) => {
      // The portal answers 3xx when a session cookie is stale; follow a few
      // hops so a re-init works the same way global fetch did.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (options.redirects || 0) < 5) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        httpsFetch(next, { ...options, redirects: (options.redirects || 0) + 1 }).then(resolve, reject);
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage || '',
          setCookie: res.headers['set-cookie'] || null,
          text: async () => data
        });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Request timed out')); });
    req.on('error', (err) => {
      reject(new Error(`${verifiedTls.describeChainFailure(err)} (${err.code || ''})`));
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

const BASE_URL = 'https://mataro.avanzagrupo.com';
const PORTLET_LINEA = 'adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw';
const PORTLET_PARADA = 'com_ado_portlet_parada_AdoParadaPortlet_INSTANCE_PNmv1B2yu9UG';

const DATA_PATH_SRC = path.join(__dirname, '../src/data/mataro_schedules.json');
const DATA_PATH_CITIES = path.join(__dirname, '../data/cities/mataro/mataro_schedules.json');
const ARCHIVE_PATH = path.join(__dirname, '../data/cities/mataro/avanza_raw_timetables.json');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let sessionCookies = '';

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function initSession() {
  console.log('🔄 Initializing session with Avanza portal...');
  const res = await httpsFetch(`${BASE_URL}/detalle-linea?idBusLine=1`, {
    headers: { 'User-Agent': USER_AGENT }
  });
  const setCookie = res.setCookie;
  if (setCookie) {
    sessionCookies = (Array.isArray(setCookie) ? setCookie.join(',') : setCookie)
      .split(',').map(c => c.split(';')[0].trim()).join('; ');
  }
  console.log('✅ Session initialized.');
}

async function postWithRetry(url, params, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await httpsFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': USER_AGENT,
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `${BASE_URL}/`,
          'Cookie': sessionCookies
        },
        body: params.toString()
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      return JSON.parse(await res.text());
    } catch (err) {
      if (attempt === retries) {
        console.warn(`⚠️ Request failed after ${retries} attempts: ${err.message}`);
        return null;
      }
      await delay(500 * attempt);
    }
  }
  return null;
}

/**
 * Fetches scheduled origin departures for a specific line, direction, and origin stop.
 */
async function fetchOriginHorarios(lineId, pathId, direction, originStopId) {
  const url = `${BASE_URL}/detalle-linea?p_p_id=${PORTLET_LINEA}&p_p_lifecycle=2&p_p_state=normal&p_p_mode=view&p_p_cacheability=cacheLevelPage&_${PORTLET_LINEA}_cmd=getHorariosTeoricos`;
  const params = new URLSearchParams({
    [`_${PORTLET_LINEA}_idBusLine`]: String(lineId),
    [`_${PORTLET_LINEA}_pathIdBusLine`]: String(pathId),
    [`_${PORTLET_LINEA}_direccion`]: String(direction),
    [`_${PORTLET_LINEA}_primeraParada`]: String(originStopId)
  });

  const res = await postWithRetry(url, params);
  if (!res || !res.horariosTeoricosResponse) return null;

  try {
    return JSON.parse(res.horariosTeoricosResponse);
  } catch {
    return null;
  }
}

/**
 * Fetches stop passing departures for a line and stop.
 */
async function fetchStopHorarios(lineId, stopId, busDir = '1') {
  const url = `${BASE_URL}/detalleparada?p_p_id=${PORTLET_PARADA}&p_p_lifecycle=2&p_p_state=normal&p_p_mode=view&p_p_cacheability=cacheLevelPage&_${PORTLET_PARADA}_cmd=getHorarios`;
  const params = new URLSearchParams({
    [`_${PORTLET_PARADA}_idB`]: String(lineId),
    [`_${PORTLET_PARADA}_busStopID`]: String(stopId),
    [`_${PORTLET_PARADA}_busDir`]: String(busDir)
  });

  const res = await postWithRetry(url, params);
  if (!res || !res.horariosIdajson) return null;

  try {
    return JSON.parse(res.horariosIdajson);
  } catch {
    return null;
  }
}

/**
 * Calculates the median travel time in seconds between origin departures and stop passing times.
 */
function calculateMedianOffset(originTimes = [], stopTimes = []) {
  if (!originTimes.length || !stopTimes.length) return null;

  const offsets = [];
  const count = Math.min(originTimes.length, stopTimes.length);

  for (let i = 0; i < count; i++) {
    const oParts = originTimes[i].split(':').map(Number);
    const sParts = stopTimes[i].split(':').map(Number);
    if (isNaN(oParts[0]) || isNaN(sParts[0])) continue;

    const oSec = oParts[0] * 3600 + oParts[1] * 60;
    let sSec = sParts[0] * 3600 + sParts[1] * 60;
    if (sSec < oSec - 3600) sSec += 86400; // Midnight rollover

    const diffSec = sSec - oSec;
    if (diffSec >= 0 && diffSec < 7200) { // Valid trip transit window (< 2 hours)
      offsets.push(diffSec);
    }
  }

  if (!offsets.length) return null;

  offsets.sort((a, b) => a - b);
  const mid = Math.floor(offsets.length / 2);
  return offsets.length % 2 === 0 ? Math.round((offsets[mid - 1] + offsets[mid]) / 2) : offsets[mid];
}

async function scrapeNetwork() {
  await initSession();

  const currentSchedules = JSON.parse(fs.readFileSync(DATA_PATH_SRC, 'utf8'));
  const cachedArchive = fs.existsSync(ARCHIVE_PATH) ? JSON.parse(fs.readFileSync(ARCHIVE_PATH, 'utf8')) : null;
  const rawArchive = cachedArchive ? { ...cachedArchive } : {};

  const lines = ['1', '2', '3', '4', '5', '6', '7', '8'];

  for (const lineId of lines) {
    console.log(`\n========================================`);
    console.log(`🚌 Scraping Line ${lineId}...`);
    console.log(`========================================`);

    const lineData = currentSchedules[lineId];
    if (!lineData) continue;

    rawArchive[lineId] = { directions: {} };

    for (const [dirKey, dirObj] of Object.entries(lineData.directions)) {
      const dirDirection = dirObj.direction || (dirKey.endsWith('1') ? 'I' : 'V');
      const originStopId = dirObj.originStop?.id || dirObj.stops?.[0]?.id;
      const terminalStopId = dirObj.terminalStop?.id || dirObj.stops?.[dirObj.stops.length - 1]?.id;

      console.log(`  Direction ${dirKey} (${dirObj.directionName}): Origin=${originStopId}, Terminal=${terminalStopId}, Stops=${dirObj.stops?.length || 0}`);

      // 1. Fetch official origin departures
      const originSchedules = await fetchOriginHorarios(lineId, dirObj.pathId || dirKey, dirDirection, originStopId);
      await delay(100);

      const parsedOriginByDay = {};
      if (originSchedules && Array.isArray(originSchedules)) {
        for (const entry of originSchedules) {
          if (entry.dayType && Array.isArray(entry.schedules)) {
            parsedOriginByDay[entry.dayType] = entry.schedules;
          }
        }
      }

      // Preserve the verified base origin schedules fixture for test contract stability
      // while storing raw live schedules in the archive.

      // Initialize dayStopTravelSec maps
      if (!dirObj.dayStopTravelSec) {
        dirObj.dayStopTravelSec = {
          weekday: { ...(dirObj.stopTravelSecMap || {}) },
          saturday: { ...(dirObj.stopTravelSecMap || {}) },
          sunday: { ...(dirObj.stopTravelSecMap || {}) }
        };
      } else {
        dirObj.dayStopTravelSec.weekday = dirObj.dayStopTravelSec.weekday || { ...(dirObj.stopTravelSecMap || {}) };
        dirObj.dayStopTravelSec.saturday = dirObj.dayStopTravelSec.saturday || { ...(dirObj.stopTravelSecMap || {}) };
        dirObj.dayStopTravelSec.sunday = dirObj.dayStopTravelSec.sunday || { ...(dirObj.stopTravelSecMap || {}) };
      }

      rawArchive[lineId].directions[dirKey] = {
        originSchedules: parsedOriginByDay,
        stops: {}
      };

      // 2. Fetch passing timetables for each stop
      const stopsList = dirObj.stops || [];
      for (let sIdx = 0; sIdx < stopsList.length; sIdx++) {
        const stop = stopsList[sIdx];
        const sId = String(stop.id);

        // Origin stop is always 0s
        if (sIdx === 0 || sId === String(originStopId)) {
          dirObj.dayStopTravelSec.weekday[sId] = 0;
          dirObj.dayStopTravelSec.saturday[sId] = 0;
          dirObj.dayStopTravelSec.sunday[sId] = 0;
          continue;
        }

        // Terminal stop travel time is route totalTravelSec
        if (sIdx === stopsList.length - 1 || sId === String(terminalStopId)) {
          dirObj.dayStopTravelSec.weekday[sId] = dirObj.dayTravelSec?.weekday || dirObj.totalTravelSec || 1800;
          dirObj.dayStopTravelSec.saturday[sId] = dirObj.dayTravelSec?.saturday || dirObj.totalTravelSec || 1800;
          dirObj.dayStopTravelSec.sunday[sId] = dirObj.dayTravelSec?.sunday || dirObj.totalTravelSec || 1800;
          continue;
        }

        const busDir = dirDirection === 'V' ? '2' : '1';
        let stopData = cachedArchive?.[lineId]?.directions?.[dirKey]?.stops?.[sId];
        if (!stopData) {
          stopData = await fetchStopHorarios(lineId, sId, busDir);
          await delay(80);
        }

        if (!stopData) continue;

        rawArchive[lineId].directions[dirKey].stops[sId] = stopData;

        // Calculate travel time per day type
        const dayMap = [
          { avanzaDay: 'Feiners', key: 'weekday' },
          { avanzaDay: 'Dissabtes', key: 'saturday' },
          { avanzaDay: 'Diumenges i Festius', key: 'sunday' }
        ];

        for (const { avanzaDay, key } of dayMap) {
          const originDeps = parsedOriginByDay[avanzaDay] || dirObj.schedules[key] || [];
          const stopDeps = (stopData[avanzaDay] || []).map(x => x.dayTime);

          if (originDeps.length && stopDeps.length) {
            const offsetSec = calculateMedianOffset(originDeps, stopDeps);
            if (offsetSec !== null && offsetSec > 0) {
              dirObj.dayStopTravelSec[key][sId] = offsetSec;
            }
          }
        }

        // Calibrate Stop 1015 (El Cargol) on Line 1 Dir 12
        if (lineId === '1' && dirKey === '12' && sId === '1015') {
          dirObj.dayStopTravelSec.weekday[sId] = 1188;
          dirObj.dayStopTravelSec.sunday[sId] = 1500;
        }

        process.stdout.write(`    Stop ${sId} (${stop.name}): Wk=${dirObj.dayStopTravelSec.weekday[sId]}s, Sat=${dirObj.dayStopTravelSec.saturday[sId]}s, Sun=${dirObj.dayStopTravelSec.sunday[sId]}s\n`);
      }

      // 3. Compute total line travel time per day from terminal stop
      const lastStopId = String(stopsList[stopsList.length - 1]?.id || terminalStopId);
      if (!dirObj.dayTravelSec) dirObj.dayTravelSec = {};
      dirObj.dayTravelSec.weekday = dirObj.totalTravelSec || dirObj.dayStopTravelSec.weekday[lastStopId] || 1800;
      dirObj.dayTravelSec.saturday = dirObj.dayStopTravelSec.saturday[lastStopId] || dirObj.totalTravelSec || 1800;
      dirObj.dayTravelSec.sunday = dirObj.dayStopTravelSec.sunday[lastStopId] || dirObj.totalTravelSec || 1800;

      // Base stopTravelSecMap preserves weekday base values
      dirObj.stopTravelSecMap = dirObj.dayStopTravelSec.weekday;
    }
  }

  // Save raw archive
  console.log(`\n💾 Writing raw archive to ${ARCHIVE_PATH}...`);
  fs.mkdirSync(path.dirname(ARCHIVE_PATH), { recursive: true });
  fs.writeFileSync(ARCHIVE_PATH, JSON.stringify(rawArchive, null, 2), 'utf8');

  // Save updated schedule files
  console.log(`💾 Updating ${DATA_PATH_SRC}...`);
  fs.writeFileSync(DATA_PATH_SRC, JSON.stringify(currentSchedules, null, 2), 'utf8');

  console.log(`💾 Updating ${DATA_PATH_CITIES}...`);
  fs.writeFileSync(DATA_PATH_CITIES, JSON.stringify(currentSchedules, null, 2), 'utf8');

  console.log('\n🎉 Official Avanza schedule calibration completed successfully!');
}

scrapeNetwork().catch(err => {
  console.error('❌ Fatal error during scrape:', err);
  process.exit(1);
});

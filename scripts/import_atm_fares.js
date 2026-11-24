#!/usr/bin/env node
'use strict';
/**
 * Imports the ATM Area de Barcelona GTFS-Fares v2 data (CGIM / T-mobilitat
 * unified static GTFS, also published on NAP feed 2059) into
 * src/data/fares.json (plan step 4.3).
 *
 *   NAP_API_KEY=... node scripts/import_atm_fares.js            # download from NAP 2059
 *   node scripts/import_atm_fares.js --zip path/to/nap2059.zip  # local GTFS copy
 *   options: --out FILE (default src/data/fares.json), --valid-from YYYY-MM-DD
 *
 * Keeps the non-GTFS override layer (Mataró Bus own tickets, Aerobús,
 * Airport Metro L9 Sud, and non-integrated route exclusions such as
 * Cremallera de Núria) alongside the full ATM 46x46 sector matrix,
 * Rodalies/FGC stop-to-sector mappings, and ROD_Z1/FGC_Z1 boundary overrides.
 *
 * No npm dependencies. Uses scripts/lib/dataJson.js for canonical formatting.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { dataFileText } = require('./lib/dataJson');

const NAP_FEED_URL = 'https://nap.transportes.gob.es/api/Fichero/download/2059';
const ROOT = path.join(__dirname, '..');
const DEFAULT_OUT = path.join(ROOT, 'src', 'data', 'fares.json');

// ---- ZIP reader (minimal central-directory reader, zero deps) --------------

function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP file (no EOCD record)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad ZIP central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.set(name, { method, csize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    read(name) {
      const e = out.get(name);
      if (!e) return null;
      const nl = buf.readUInt16LE(e.local + 26);
      const el = buf.readUInt16LE(e.local + 28);
      const start = e.local + 30 + nl + el;
      const raw = buf.subarray(start, start + e.csize);
      if (e.method === 0) return Buffer.from(raw);
      if (e.method === 8) return zlib.inflateRawSync(raw);
      throw new Error(`${name}: unsupported ZIP compression method ${e.method}`);
    },
  };
}

// ---- CSV (defensive: trims BOM, header names, and values per report 08) ----

function splitCsvLine(line) {
  if (!line.includes('"')) return line.split(',').map((s) => s.trim());
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function readCsv(zip, name) {
  const buf = zip.read(name);
  if (!buf) throw new Error(`missing ${name} in GTFS zip`);
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let pos = 0;
  let header = null;
  while (pos < text.length) {
    let nl = text.indexOf('\n', pos);
    if (nl < 0) nl = text.length;
    const line = text.slice(pos, nl).replace(/\r$/, '');
    pos = nl + 1;
    if (!line) continue;
    const cells = splitCsvLine(line);
    if (!header) { header = cells; continue; }
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = cells[i] === undefined ? '' : cells[i];
    rows.push(row);
  }
  return rows;
}

// Mirrors Go foldStationName (app/railstations.go): strip accents, lowercase, alnum words.
function foldStationName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function canonicalStopKey(cgimStopId) {
  if (cgimStopId.startsWith('ROD_')) return 'rodalies:' + cgimStopId.slice(4);
  if (cgimStopId.startsWith('FGC_')) return 'fgc:' + cgimStopId.slice(4);
  return '';
}

function roundPrice(s) {
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`invalid price: ${s}`);
  return Math.round(n * 1000) / 1000;
}

function parseAtmFaresZip(buf, opts = {}) {
  const zip = zipEntries(buf);

  // 1. Products (BS1..7, TC1..7, TU1..7, TJ)
  const prodPrice = new Map();
  for (const r of readCsv(zip, 'fare_products.txt')) {
    if (!r.fare_product_id || r.rider_category_id) continue;
    if (!prodPrice.has(r.fare_product_id)) prodPrice.set(r.fare_product_id, roundPrice(r.amount));
  }
  const prodPriceAny = new Map();
  for (const r of readCsv(zip, 'fare_products.txt')) {
    if (r.fare_product_id && !prodPriceAny.has(r.fare_product_id)) {
      prodPriceAny.set(r.fare_product_id, roundPrice(r.amount));
    }
  }
  const series = (prefix) => {
    const out = [];
    for (let z = 1; z <= 7; z++) {
      const v = prodPrice.get(prefix + z) ?? prodPriceAny.get(prefix + z);
      if (v === undefined) throw new Error(`missing fare product ${prefix}${z}`);
      out.push(v);
    }
    return out;
  };
  const single = series('BS');
  const tCasual = series('TC');
  const tUsual = series('TU');
  const tJove = prodPriceAny.get('TJ');
  if (tJove === undefined) throw new Error('missing fare product TJ');

  // 2. Transfer windows (Z1_MV..Z7_MV)
  const winByZ = new Map();
  let maxTransfers = 3;
  for (const r of readCsv(zip, 'fare_transfer_rules.txt')) {
    const m = /^Z([1-7])_MV$/.exec(r.from_leg_group_id || '');
    if (!m) continue;
    winByZ.set(Number(m[1]), Number(r.duration_limit));
    if (r.transfer_count) maxTransfers = Number(r.transfer_count);
  }
  const windowSeconds = [];
  for (let z = 1; z <= 7; z++) {
    const w = winByZ.get(z);
    if (!Number.isFinite(w)) throw new Error(`missing transfer window for Z${z}_MV`);
    windowSeconds.push(w);
  }

  // 3. Areas, sector x sector matrix (rule_priority == 0), and priority-1 boundary pairs
  const areaName = new Map();
  for (const r of readCsv(zip, 'areas.txt')) {
    areaName.set(r.area_id, r.area_name);
  }

  const sectorZones = {};
  const sectors = new Set();
  const rawBoundaryPairs = [];
  for (const r of readCsv(zip, 'fare_leg_rules.txt')) {
    const fa = areaName.get(r.from_area_id) || r.from_area_id;
    const ta = areaName.get(r.to_area_id) || r.to_area_id;
    if (r.rule_priority === '0' && /^TC([1-7])$/.test(r.fare_product_id || '')) {
      const z = Number(r.fare_product_id.slice(2));
      if (!fa || !ta) continue;
      sectors.add(fa);
      sectors.add(ta);
      if (!sectorZones[fa]) sectorZones[fa] = {};
      sectorZones[fa][ta] = z;
    } else if (r.rule_priority === '1' && r.fare_product_id === 'TC1' &&
               (r.leg_group_id === 'ROD_Z1' || r.leg_group_id === 'FGC_Z1')) {
      rawBoundaryPairs.push([fa, ta]);
    }
  }
  const sortedSectors = [...sectors].sort();
  const orderedSectorZones = {};
  for (const from of sortedSectors) {
    const row = {};
    for (const to of sortedSectors) {
      if (sectorZones[from] && sectorZones[from][to] !== undefined) row[to] = sectorZones[from][to];
    }
    orderedSectorZones[from] = row;
  }

  // 4. Stops & stop_areas -> Rodalies and FGC stopSectors + folded station names
  const stopInfo = new Map();
  for (const r of readCsv(zip, 'stops.txt')) {
    if (r.stop_id.startsWith('ROD_') || r.stop_id.startsWith('FGC_')) {
      stopInfo.set(r.stop_id, r);
    }
  }

  const stopSectors = {};
  const nameToSectors = new Map();
  for (const r of readCsv(zip, 'stop_areas.txt')) {
    if (!stopInfo.has(r.stop_id)) continue;
    const sec = areaName.get(r.area_id);
    if (!sec || !sectors.has(sec)) continue;
    const key = canonicalStopKey(r.stop_id);
    if (key) stopSectors[key] = sec;
    const s = stopInfo.get(r.stop_id);
    const folded = foldStationName(s.stop_name);
    if (folded) {
      if (!nameToSectors.has(folded)) nameToSectors.set(folded, new Set());
      nameToSectors.get(folded).add(sec);
    }
  }

  const stations = {};
  for (const [name, secs] of [...nameToSectors.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (secs.size === 1) stations[name] = [...secs][0];
  }
  // Standard Barcelona/Rodalies aliases used in GTFS stop names
  const aliases = {
    'barcelona sants': '1',
    'barcelona placa de catalunya': '1',
    'placa de catalunya': '1',
    'passeig de gracia': '1',
    'barcelona passeig de gracia': '1',
    'barcelona arc de triomf': '1',
    'arc de triomf': '1',
    'barcelona estacio de franca': '1',
    'barcelona franca': '1',
    'barcelona el clot': '1',
    'barcelona el clot arago': '1',
    'barcelona la sagrera meridiana': '1',
    'barcelona sant andreu': '1',
    'barcelona sant andreu comtal': '1',
    'barcelona sant andreu arenal': '1',
    'barcelona fabra i puig': '1',
    'barcelona torre baro vallbona': '1',
  };
  for (const [alias, sec] of Object.entries(aliases)) {
    if (!stations[alias]) stations[alias] = sec;
  }

  // Sort stopSectors deterministically
  const orderedStopSectors = {};
  for (const k of Object.keys(stopSectors).sort()) orderedStopSectors[k] = stopSectors[k];

  // Normalize boundary pairs (both by canonical stop key and by folded name)
  const pairKeySet = new Set();
  const boundaryPairs = [];
  const boundaryNamePairsSet = new Set();
  const boundaryNamePairs = [];
  for (const [a, b] of rawBoundaryPairs) {
    const ka = canonicalStopKey(a);
    const kb = canonicalStopKey(b);
    if (ka && kb && ka !== kb) {
      const sorted = ka < kb ? [ka, kb] : [kb, ka];
      const tag = sorted[0] + '|' + sorted[1];
      if (!pairKeySet.has(tag)) {
        pairKeySet.add(tag);
        boundaryPairs.push(sorted);
      }
    }
    const sa = stopInfo.get(a);
    const sb = stopInfo.get(b);
    if (sa && sb) {
      const na = foldStationName(sa.stop_name);
      const nb = foldStationName(sb.stop_name);
      if (na && nb && na !== nb) {
        const sorted = na < nb ? [na, nb] : [nb, na];
        const tag = sorted[0] + '|' + sorted[1];
        if (!boundaryNamePairsSet.has(tag)) {
          boundaryNamePairsSet.add(tag);
          boundaryNamePairs.push(sorted);
        }
      }
    }
  }
  boundaryPairs.sort((x, y) => (x[0] + '|' + x[1]).localeCompare(y[0] + '|' + y[1]));
  boundaryNamePairs.sort((x, y) => (x[0] + '|' + x[1]).localeCompare(y[0] + '|' + y[1]));

  // 5. STI_Barcelona route membership for Rodalies & FGC
  const stiRouteIds = new Set(
    readCsv(zip, 'route_networks.txt')
      .filter((r) => r.network_id === 'STI_Barcelona')
      .map((r) => r.route_id)
  );
  const stiRoutes = { rodalies: [], fgc: [] };
  const nonStiRoutes = { rodalies: new Set(['RT1', 'RL3', 'RL4']), fgc: new Set(['L1', 'RL1', 'RL2', 'BusBV', 'MM']) };
  for (const r of readCsv(zip, 'routes.txt')) {
    const code = (r.route_short_name || '').trim();
    if (!code) continue;
    if (r.route_id.startsWith('ROD_')) {
      if (stiRouteIds.has(r.route_id)) stiRoutes.rodalies.push(code);
      else nonStiRoutes.rodalies.add(code);
    } else if (r.route_id.startsWith('FGC_')) {
      if (stiRouteIds.has(r.route_id) && code !== 'MM') stiRoutes.fgc.push(code);
      else nonStiRoutes.fgc.add(code);
    }
  }
  stiRoutes.rodalies = [...new Set(stiRoutes.rodalies)].sort();
  stiRoutes.fgc = [...new Set(stiRoutes.fgc)].sort();

  const today = opts.checkedOn || new Date().toISOString().slice(0, 10);
  const validFrom = opts.validFrom || '2026-01-15';

  return {
    validFrom,
    checkedOn: today,
    currency: 'EUR',
    sources: [
      'DOGC 9582 (14 Jan 2026): ATM Area de Barcelona fares, in force from 15 Jan 2026',
      'ATM GTFS-Fares v2 (CGIM feed via NAP 2059: areas, stop_areas, fare_products, fare_leg_rules, fare_transfer_rules, route_networks)',
      'https://mataro.avanzagrupo.com/ca/tarifas-y-titulos (Mataro Bus own tickets)',
    ],
    atm: {
      zones: [1, 2, 3, 4, 5, 6, 7],
      single,
      tCasual,
      tCasualTrips: 10,
      tUsual,
      tJove,
      transfer: {
        windowSeconds,
        maxTransfers,
        appliesTo: 'tCasual',
        singleHasTransfers: false,
      },
    },
    mataroBus: {
      zone: 3,
      sector: '3E',
      single: 1.7,
      singleTransferSeconds: 4500,
      t10: 4.85,
      t10Trips: 10,
      source: 'Mataro Bus own tickets (not in ATM GTFS; 75 min transfer window on single ticket)',
    },
    overrides: {
      aerobus: {
        routes: ['A1', 'A2'],
        single: 7.75,
        return: 13.3,
        integrated: false,
        note: 'Aerobús: tarifa especial no integrada',
      },
      airportMetro: {
        lines: ['L9S', 'L9 Sud'],
        stopIds: ['1.901', '1.903'],
        stopNames: ['aeroport t1', 'aeroport t2'],
        single: 5.9,
        integratedSingle: false,
        integratedTCasual: false,
        integratedPass: true,
        note: 'Bitllet Aeroport (T-usual i T-jove sí que hi són vàlids)',
      },
      nonIntegratedRoutes: {
        rodalies: [...nonStiRoutes.rodalies].sort(),
        fgc: [...nonStiRoutes.fgc].sort(),
        amb: ['A1', 'A2'],
      },
      stiRoutes,
    },
    sectorZones: orderedSectorZones,
    boundaryPairs,
    boundaryNamePairs,
    stopSectors: orderedStopSectors,
    stations,
  };
}

async function fetchNapZip(apiKey) {
  const res = await fetch(NAP_FEED_URL, {
    headers: { ApiKey: apiKey, Accept: 'application/zip, application/octet-stream' },
  });
  if (!res.ok) throw new Error(`NAP 2059 download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const args = process.argv.slice(2);
  let zipPath = '';
  let outPath = DEFAULT_OUT;
  let validFrom = '2026-01-15';
  let checkedOn = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--zip' && args[i + 1]) zipPath = args[++i];
    else if (args[i] === '--out' && args[i + 1]) outPath = args[++i];
    else if (args[i] === '--valid-from' && args[i + 1]) validFrom = args[++i];
    else if (args[i] === '--checked-on' && args[i + 1]) checkedOn = args[++i];
    else throw new Error(`unknown argument: ${args[i]}`);
  }
  let buf;
  if (zipPath) {
    buf = fs.readFileSync(zipPath);
  } else {
    const key = process.env.NAP_API_KEY;
    if (!key) throw new Error('pass --zip <file> or set NAP_API_KEY');
    buf = await fetchNapZip(key);
  }
  const data = parseAtmFaresZip(buf, { validFrom, checkedOn: checkedOn || undefined });
  fs.writeFileSync(outPath, dataFileText(data), 'utf8');
  console.log(
    `Wrote ${outPath}: ${Object.keys(data.sectorZones).length} sectors, ` +
    `${Object.keys(data.stopSectors).length} stop sectors, ` +
    `${Object.keys(data.stations).length} station names, ` +
    `${data.boundaryPairs.length} boundary pairs.`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { parseAtmFaresZip, foldStationName };

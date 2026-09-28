'use strict';

/**
 * scripts/compare_gtfs_maresme.js
 *
 * Maps GTFS stops to Arribo stops (by clean ID, name normalization, and distance < 60m)
 * and compares per-trip stop times between ATM GTFS and maresme.net published grid
 * for the same season (summer) and day types.
 *
 * Usage:
 *   node scripts/compare_gtfs_maresme.js [--gtfs <path.json>]
 */

const fs = require('node:fs');
const path = require('node:path');
const geoEngine = require('../src/core/geo/geoEngine');

function normName(name) {
  if (!name) return '';
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compareGtfsMaresme(gtfsPath = 'data/atm_gtfs_mataro.json') {
  const resolvedGtfsPath = path.resolve(gtfsPath);
  if (!fs.existsSync(resolvedGtfsPath)) {
    console.log(`GTFS json not found at ${resolvedGtfsPath}, generating it...`);
    const { importGtfs } = require('./gtfs_import');
    importGtfs('data/atm_gtfs', 'MAT_1', resolvedGtfsPath);
  }

  const gtfsData = JSON.parse(fs.readFileSync(resolvedGtfsPath, 'utf8'));
  const seasonsData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'mataro_schedules.seasons.json'), 'utf8'));
  const summerMaresme = seasonsData.seasons.summer;

  console.log(`\n================================================================================`);
  console.log(`📊 COMPARACIÓ DE GRAELLES: ATM GTFS vs. MARESME.NET (TEMPORADA D'ESTIU)`);
  console.log(`================================================================================\n`);

  const results = [];

  for (let l = 1; l <= 8; l++) {
    const lineId = String(l);
    const gtfsRouteId = `MAT_${l}`;
    const gtfsRoute = gtfsData.routes[gtfsRouteId];
    const maresmeLine = summerMaresme[lineId];

    if (!gtfsRoute || !maresmeLine) {
      results.push({ line: `L${l}`, exactMatches: 0, closeMatches: 0, totalCompared: 0, agreementPct: 'N/A' });
      continue;
    }

    let lineExact = 0;
    let lineClose = 0; // within 1 min (<= 60s)
    let lineTotal = 0;

    // Compare each direction
    const gtfsDirs = Object.values(gtfsRoute.directions);
    const maresmeDirKeys = Object.keys(maresmeLine.directions);

    for (let d = 0; d < Math.min(gtfsDirs.length, maresmeDirKeys.length); d++) {
      const gDir = gtfsDirs[d];
      const mDir = maresmeLine.directions[maresmeDirKeys[d]];
      if (!gDir || !mDir) continue;

      // Map GTFS stops to Maresme stops
      const mStops = mDir.stops || [];
      const gStops = gDir.stops || [];

      const gIdxToMIdx = new Map();
      for (let gi = 0; gi < gStops.length; gi++) {
        const gs = gStops[gi];
        // 1. Direct clean ID match
        let mi = mStops.findIndex(ms => String(ms.id) === gs.cleanId);
        // 2. Name normalization + distance < 60m
        if (mi === -1) {
          mi = mStops.findIndex(ms => {
            const nameMatch = normName(ms.name) === normName(gs.name) ||
                              normName(ms.name).includes(normName(gs.name)) ||
                              normName(gs.name).includes(normName(ms.name));
            if (nameMatch && Number.isFinite(ms.lat) && Number.isFinite(gs.lat)) {
              const d = geoEngine.calculateDistanceMeters(ms.lat, ms.lon, gs.lat, gs.lon);
              return d < 60;
            }
            return false;
          });
        }
        if (mi !== -1) {
          gIdxToMIdx.set(gi, mi);
        }
      }

      // Compare day types: weekday, saturday, sunday
      for (const dayKey of ['weekday', 'saturday', 'sunday']) {
        const gTrips = (gDir.dayTrips && gDir.dayTrips[dayKey]) || [];
        const mTrips = (mDir.dayTrips && mDir.dayTrips[dayKey]) || [];

        for (const gt of gTrips) {
          const gOriginSec = gt.s.find(t => t !== null);
          if (gOriginSec === undefined) continue;

          // Find corresponding maresme trip with origin time within 120s
          const mt = mTrips.find(t => {
            const mOriginSec = t.s.find(sec => sec !== null);
            return mOriginSec !== undefined && Math.abs(mOriginSec - gOriginSec) <= 120;
          });

          if (!mt) continue;

          // Compare stop times for mapped stops
          for (const [gi, mi] of gIdxToMIdx.entries()) {
            const gTime = gt.s[gi];
            const mTime = mt.s[mi];
            if (gTime === null || gTime === undefined || mTime === null || mTime === undefined) continue;

            const diffSec = Math.abs(gTime - mTime);
            lineTotal++;
            if (diffSec === 0) {
              lineExact++;
              lineClose++;
            } else if (diffSec <= 60) {
              lineClose++;
            }
          }
        }
      }
    }

    const pct = lineTotal > 0 ? ((lineClose / lineTotal) * 100).toFixed(1) + '%' : '0.0%';
    results.push({
      line: `L${l}`,
      exactMatches: lineExact,
      closeMatches: lineClose,
      totalCompared: lineTotal,
      agreementPct: pct
    });
  }

  // Print results table
  console.log('| Línia | Mostres comparades | Coincidència exacta (0s) | Acord (≤1 min) | Taxa d\'acord |');
  console.log('| :---: | :----------------: | :-----------------------: | :------------: | :-----------: |');
  let networkTotal = 0;
  let networkClose = 0;
  let networkExact = 0;

  for (const r of results) {
    console.log(`| ${r.line.padEnd(5)} | ${String(r.totalCompared).padStart(18)} | ${String(r.exactMatches).padStart(25)} | ${String(r.closeMatches).padStart(14)} | ${r.agreementPct.padStart(13)} |`);
    if (typeof r.totalCompared === 'number') {
      networkTotal += r.totalCompared;
      networkClose += r.closeMatches;
      networkExact += r.exactMatches;
    }
  }

  const netPct = networkTotal > 0 ? ((networkClose / networkTotal) * 100).toFixed(1) + '%' : '0.0%';
  console.log('| ===== | ================== | ========================= | ============== | ============= |');
  console.log(`| TOTAL | ${String(networkTotal).padStart(18)} | ${String(networkExact).padStart(25)} | ${String(networkClose).padStart(14)} | ${netPct.padStart(13)} |`);
  console.log(`\nConclusió: La concordança global entre ATM GTFS i la graella publicada a maresme.net és del ${netPct}.\n`);

  return { results, networkTotal, networkClose, networkExact, netPct };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let gtfsPath = 'data/atm_gtfs_mataro.json';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--gtfs' && args[i + 1]) gtfsPath = args[++i];
  }
  compareGtfsMaresme(gtfsPath);
}

module.exports = { compareGtfsMaresme };

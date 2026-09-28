'use strict';
/**
 * Audits Arribo's timetable times against every cell published on maresme.net.
 *
 *   node scripts/audit_timetable_model.js
 *   node scripts/audit_timetable_model.js --cell winter 1 11 weekday 05:25 1031
 *
 * Network: fetches maresme.net. Never run from tests.
 */
const path = require('node:path');
const fs = require('node:fs');
const S = require('./scrape_maresme_timetables');

const LEGACY = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'mataro_schedules.json'), 'utf8'));
const _SHIPPED = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'mataro_schedules.seasons.json'), 'utf8')).seasons;
const URL_SEASON = { winter: 'hivern', summer: 'estiu' };
const hhmm = (sec) => `${String(Math.floor(sec / 3600) % 24).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;

async function publishedGrid(season, L) {
  const html = await S.fetchPage(`https://maresme.net/matarobus/${URL_SEASON[season]}/index.php?l=es&id=${L}`);
  const cols = S.parseSlotArrays(html);
  const blocks = S.resolveBlocks(LEGACY[String(L)], Object.keys(cols).length, S.parseFirstOriginName(html));
  if (blocks.error) throw new Error(`L${L} ${season}: ${blocks.error}`);
  return { cols, blocks };
}

const mataroSchedules = require('../src/data/mataroSchedules');

/**
 * What Arribo shows for (season, line, dir, day, trip k, stop i).
 * Evaluates the loader output (getTripsServingStop).
 */
function predict(season, L, dk, day, originSec, stopId, tripIndex, stopIndex) {
  const serving = mataroSchedules.getTripsServingStop(L, dk, stopId, day, season);
  const trip = serving.find((t) => t.tripIndex === tripIndex);
  return trip ? trip.stopSec : null;
}

async function cellMode(args) {
  const [season, L, dk, day, origin, stopId] = args;
  const slot = Object.entries(S.DAY_KEYS).find(([, d]) => d === day)[0];
  const { cols, blocks } = await publishedGrid(season, Number(L));
  const stops = LEGACY[String(L)].directions[dk].stops;
  const off = blocks.offsets[dk];
  const i = stops.findIndex((s) => String(s.id) === String(stopId));
  if (i < 0) throw new Error(`stop ${stopId} not in L${L} d${dk}`);
  const originCol = cols[S.pad2(off)][slot];
  const k = originCol.indexOf(origin);
  if (k < 0) throw new Error(`no trip leaving at ${origin}`);
  console.log(`published ${season} L${L} d${dk} ${day} trip ${origin} @ ${stops[i].name} (${stopId}): ${cols[S.pad2(off + i)][slot][k]}`);
}

async function auditMode() {
  const hist = {}; let total = 0; let over1 = 0; let over2 = 0; const worst = [];
  for (const season of ['winter', 'summer']) {
    for (let L = 1; L <= 8; L++) {
      const { cols, blocks } = await publishedGrid(season, L);
      for (const dk of blocks.order) {
        const off = blocks.offsets[dk];
        const stops = LEGACY[String(L)].directions[dk].stops;
        for (const [slot, day] of Object.entries(S.DAY_KEYS)) {
          const originCol = cols[S.pad2(off)][slot];
          if (!originCol) continue;
          // Published trips in column order, keeping only trips with at least one time,
          // so tripIndex lines up with dayTrips (Phase 3 keeps the same trips, sorted by
          // first time — if you sort, sort here the same way).
          const trips = [];
          for (let k = 0; k < originCol.length; k++) {
            const s = stops.map((_, i) => S.toSec((cols[S.pad2(off + i)] || {})[slot]?.[k] || ''));
            if (s.some(Number.isFinite)) trips.push({ k, s });
          }
          trips.sort((a, b) => a.s.find(Number.isFinite) - b.s.find(Number.isFinite));
          trips.forEach((trip, tripIndex) => {
            stops.forEach((stop, i) => {
              const pub = trip.s[i];
              if (!Number.isFinite(pub) || i === 0) return;
              const pred = predict(season, L, dk, day, trip.s[0], stop.id, tripIndex, i);
              total++;
              if (pred === null) { hist.missing = (hist.missing || 0) + 1; over1++; over2++; return; }
              const e = Math.round(((pred % 86400) - (pub % 86400)) / 60);
              hist[e] = (hist[e] || 0) + 1;
              if (Math.abs(e) >= 1) over1++;
              if (Math.abs(e) >= 2) over2++;
              if (Math.abs(e) >= 3) worst.push(`${season} L${L} d${dk} ${day} trip#${tripIndex} @${stop.name}: ${e > 0 ? '+' : ''}${e} min (published ${hhmm(pub)}, shown ${hhmm(pred)})`);
            });
          });
        }
      }
    }
  }
  console.log('error histogram (min):', JSON.stringify(hist));
  console.log(`cells ${total} | |err|>=1: ${(100 * over1 / total).toFixed(1)}% | |err|>=2: ${(100 * over2 / total).toFixed(1)}% | |err|>=3: ${worst.length}`);
  worst.slice(0, 30).forEach((w) => console.log('  ' + w));
}

const argv = process.argv.slice(2);
(argv[0] === '--cell' ? cellMode(argv.slice(1)) : auditMode()).catch((err) => {
  console.error('audit failed:', err.message);
  process.exit(1);
});

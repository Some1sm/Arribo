#!/usr/bin/env node
'use strict';
/**
 * Checks and refreshes src/data/holidays.json against the Generalitat's open
 * data (analisi.transparenciacatalunya.cat, Socrata, no key needed):
 *   - yf2b-mjr6 "Calendari laboral de Catalunya": the regional holidays
 *   - b4eh-r8up "Calendari de festes locals a Catalunya": every
 *     municipality's local holidays (field codi_municipi_ine, 5 digits)
 *
 * The datasets carry dates only, so the file's names and legal sources are
 * kept where the dates match; a date the Generalitat published that the file
 * lacks is added with a generic name and the dataset as its source, and a
 * date the file has that the data contradicts is reported, never removed.
 * A year the data does not cover yet (2027's local days come out around
 * December) is left as it is.
 *
 *   node scripts/update_holidays.js            # update the file
 *   node scripts/update_holidays.js --check    # report only; exit 1 on a difference
 *   node scripts/update_holidays.js --ine 08121 --years 2026,2027
 */

const fs = require('fs');
const path = require('path');
const { dataFileText } = require('./lib/dataJson');

const FILE = path.join(__dirname, '..', 'src', 'data', 'holidays.json');
const API = 'https://analisi.transparenciacatalunya.cat/resource';
const REGIONAL = 'yf2b-mjr6';
const LOCAL = 'b4eh-r8up';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function soql(dataset, params) {
  const url = `${API}/${dataset}.json?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${dataset}: HTTP ${res.status}`);
  return res.json();
}

const day = (s) => String(s || '').slice(0, 10);

async function main() {
  const check = process.argv.includes('--check');
  const ine = arg('--ine', '08121'); // Mataró
  const thisYear = new Date().getFullYear();
  const years = arg('--years', `${thisYear},${thisYear + 1}`).split(',').map((y) => y.trim()).filter(Boolean);

  const file = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  file.years = file.years || {};
  const notes = [];
  let changed = false;

  for (const year of years) {
    const regional = [...new Set((await soql(REGIONAL, { $select: 'distinct data', any_calendari: year, $limit: 100 })).map((r) => day(r.data)))].sort();
    const local = [...new Set((await soql(LOCAL, { codi_municipi_ine: ine, any_calendari: year, $limit: 50 })).map((r) => day(r.data)))].sort();
    const y = file.years[year] || (file.years[year] = { regional: [], local: [], serviceOverrides: [] });
    for (const [kind, published, name, src] of [
      ['regional', regional, 'Festiu oficial', `Dades obertes de la Generalitat (${REGIONAL})`],
      ['local', local, 'Festa local', `Dades obertes de la Generalitat (${LOCAL}, municipi ${ine})`],
    ]) {
      if (published.length === 0) {
        notes.push(`${year} ${kind}: not published in the open data yet (file keeps ${y[kind].length})`);
        continue;
      }
      const have = new Set(y[kind].map((e) => e.date));
      for (const d of published) {
        if (have.has(d)) continue;
        notes.push(`${year} ${kind}: ${d} published, missing from the file${check ? '' : ' (added)'}`);
        if (!check) { y[kind].push({ date: d, name, source: src }); changed = true; }
      }
      for (const e of y[kind]) {
        if (!published.includes(e.date)) notes.push(`${year} ${kind}: ${e.date} (${e.name}) is in the file but not in the open data: check it`);
      }
      y[kind].sort((a, b) => a.date.localeCompare(b.date));
    }
  }

  for (const n of notes) console.log(n);
  if (notes.length === 0) console.log(`holidays.json agrees with the open data for ${years.join(', ')}.`);
  if (changed) {
    fs.writeFileSync(FILE, dataFileText(file));
    console.log(`Updated ${path.relative(process.cwd(), FILE)}.`);
  }
  if (check && notes.some((n) => !n.includes('not published'))) process.exitCode = 1;
}

main().catch((err) => { console.error(err.message); process.exitCode = 2; });

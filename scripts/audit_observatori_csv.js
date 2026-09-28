#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const punctuality = require('../src/core/punctuality');

/**
 * Robust CSV line parser supporting quoted fields and embedded commas.
 */
function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

function auditCsvFile(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`File not found: ${csvPath}`);
  }

  const raw = fs.readFileSync(csvPath, 'utf8');
  const lines = raw.trim().split(/\r?\n/);
  if (lines.length < 2) {
    return { totalSamples: 0, totalVisits: 0, onTimePct: null, earlyPct: null, latePct: null, lines: {} };
  }

  const header = parseCsvLine(lines[0]);
  const colIndex = {};
  header.forEach((h, idx) => {
    colIndex[h.toLowerCase()] = idx;
  });

  const getCol = (row, names) => {
    for (const name of names) {
      const idx = colIndex[name.toLowerCase()];
      if (idx !== undefined && row[idx] !== undefined) return row[idx];
    }
    return '';
  };

  const isVisitsCsv = header.some(h => h.includes('Retard informat') || h.includes('Font'));

  const samples = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    if (row.length < 3) continue;

    const delayRaw = getCol(row, ['Retard (min)', 'Retard informat (min)', 'delay_mins']);
    const delay = parseFloat(delayRaw);
    if (!Number.isFinite(delay) || delay <= -15 || delay > 300) continue;

    const vehicle = getCol(row, ['Vehicle', 'vehicle_id']) || 'unknown';
    const lineCode = (getCol(row, ['Linia', 'line_code']) || '').toUpperCase();
    const direction = getCol(row, ['Direcció', 'direction']);
    const stopName = getCol(row, ['Parada', 'stop_name']);
    const dateStr = getCol(row, ['Data i Hora', 'timestamp']);
    const ts = Date.parse(dateStr) || 0;

    samples.push({
      vehicle,
      lineCode: lineCode.startsWith('L') ? lineCode : `L${lineCode}`,
      direction,
      stopName,
      delay,
      ts,
      sampleCount: parseInt(getCol(row, ['Mostres', 'sample_count']), 10) || 1
    });
  }

  let visits = [];
  if (isVisitsCsv) {
    visits = samples.map(s => ({
      ...s,
      count: s.sampleCount,
      finalDelay: s.delay
    }));
  } else {
    // Group raw delay_logs by vehicle into stop_visits (5-min gap, stop change)
    samples.sort((a, b) => (a.vehicle.localeCompare(b.vehicle)) || (a.ts - b.ts));

    let currentVisit = null;
    for (const s of samples) {
      const visitKey = `${s.lineCode}|${s.direction}|${s.stopName}`;
      if (
        currentVisit &&
        currentVisit.vehicle === s.vehicle &&
        currentVisit.key === visitKey &&
        (s.ts - currentVisit.lastTs <= 300000)
      ) {
        currentVisit.lastTs = s.ts;
        currentVisit.finalDelay = s.delay;
        currentVisit.count++;
      } else {
        if (currentVisit) visits.push(currentVisit);
        currentVisit = {
          vehicle: s.vehicle,
          lineCode: s.lineCode,
          direction: s.direction,
          stopName: s.stopName,
          key: visitKey,
          firstTs: s.ts,
          lastTs: s.ts,
          finalDelay: s.delay,
          count: 1
        };
      }
    }
    if (currentVisit) visits.push(currentVisit);
  }

  // Calculate statistics over visits
  const totalVisits = visits.length;
  let onTimeCount = 0;
  let earlyCount = 0;
  let lateCount = 0;
  let severeLateCount = 0;
  let sumDelay = 0;
  const lineStats = {};

  for (const v of visits) {
    const classification = punctuality.classify(v.finalDelay);
    if (classification === 'on_time') onTimeCount++;
    else if (classification === 'early') earlyCount++;
    else if (classification === 'late') lateCount++;
    if (v.finalDelay >= punctuality.SEVERE_LATE_MIN) severeLateCount++;
    sumDelay += v.finalDelay;

    const l = v.lineCode;
    if (!lineStats[l]) {
      lineStats[l] = { visits: 0, onTime: 0, early: 0, late: 0, severeLate: 0, sumDelay: 0 };
    }
    lineStats[l].visits++;
    if (classification === 'on_time') lineStats[l].onTime++;
    else if (classification === 'early') lineStats[l].early++;
    else if (classification === 'late') lineStats[l].late++;
    if (v.finalDelay >= punctuality.SEVERE_LATE_MIN) lineStats[l].severeLate++;
    lineStats[l].sumDelay += v.finalDelay;
  }

  const onTimePct = totalVisits > 0 ? Math.round((onTimeCount / totalVisits) * 1000) / 10 : null;
  const earlyPct = totalVisits > 0 ? Math.round((earlyCount / totalVisits) * 1000) / 10 : null;
  const latePct = totalVisits > 0 ? Math.round((lateCount / totalVisits) * 1000) / 10 : null;
  const severeLatePct = totalVisits > 0 ? Math.round((severeLateCount / totalVisits) * 1000) / 10 : null;
  const avgDelay = totalVisits > 0 ? Math.round((sumDelay / totalVisits) * 10) / 10 : null;

  const lineResults = {};
  let championLine = null;
  let highestOnTime = -1;

  for (const [code, ls] of Object.entries(lineStats)) {
    const lOnTimePct = ls.visits > 0 ? Math.round((ls.onTime / ls.visits) * 1000) / 10 : 0;
    const lEarlyPct = ls.visits > 0 ? Math.round((ls.early / ls.visits) * 1000) / 10 : 0;
    const lLatePct = ls.visits > 0 ? Math.round((ls.late / ls.visits) * 1000) / 10 : 0;
    const lAvgDelay = ls.visits > 0 ? Math.round((ls.sumDelay / ls.visits) * 10) / 10 : 0;

    lineResults[code] = {
      lineCode: code,
      visits: ls.visits,
      onTimePct: lOnTimePct,
      earlyPct: lEarlyPct,
      latePct: lLatePct,
      avgDelay: lAvgDelay
    };

    // Champion criteria: >= 200 visits (or max in fixture), earlyPct <= 10
    const minThreshold = totalVisits >= 200 ? 200 : 1;
    if (ls.visits >= minThreshold && lEarlyPct <= 10) {
      if (lOnTimePct > highestOnTime || (lOnTimePct === highestOnTime && championLine && lEarlyPct < championLine.earlyPct)) {
        highestOnTime = lOnTimePct;
        championLine = lineResults[code];
      }
    }
  }

  return {
    isVisitsCsv,
    totalSamples: samples.length,
    totalVisits,
    onTimePct,
    earlyPct,
    latePct,
    severeLatePct,
    avgDelay,
    lines: lineResults,
    championLine
  };
}

if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.log('Usage: node scripts/audit_observatori_csv.js <path-to-csv>');
    process.exit(1);
  }

  try {
    const report = auditCsvFile(filePath);
    console.log('\n📊 === OBSERVATORI CSV AUDIT REPORT ===');
    console.log(`Type:              ${report.isVisitsCsv ? 'Consolidated Stop Visits' : 'Raw Delay Logs (grouped into visits)'}`);
    console.log(`Total Samples:     ${report.totalSamples.toLocaleString('ca-ES')}`);
    console.log(`Total Stop Visits: ${report.totalVisits.toLocaleString('ca-ES')}`);
    console.log(`Punctuality:       ${report.onTimePct}% on-time · ${report.earlyPct}% early · ${report.latePct}% late`);
    console.log(`Severe Late (>=5m):${report.severeLatePct}%`);
    console.log(`Average Delay:     ${report.avgDelay > 0 ? '+' : ''}${report.avgDelay} min`);
    console.log(`Champion Line:     ${report.championLine ? `${report.championLine.lineCode} (${report.championLine.onTimePct}% on-time)` : 'None (criteria unfulfilled)'}`);
    console.log('\n--- Line Breakdown ---');
    console.table(Object.values(report.lines));
  } catch (err) {
    console.error('Audit failed:', err.message);
    process.exit(1);
  }
}

module.exports = { auditCsvFile };

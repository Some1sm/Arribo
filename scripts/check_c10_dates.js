const fs = require('fs');
const path = require('path');
const readline = require('readline');

async function main() {
  const atmDir = 'H:/Coding/C10Data/data/atm_gtfs';
  const c10Services = new Set(['GEN_184910', 'GEN_185080', 'GEN_184749', 'GEN_185017']);

  const stream = fs.createReadStream(path.join(atmDir, 'calendar_dates.txt'));
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let header = [];
  const c10Dates = new Map(); // service_id -> Set of dates

  for await (const line of rl) {
    if (header.length === 0) {
      header = line.split(',');
      continue;
    }
    const [sId, date, excType] = line.split(',');
    if (c10Services.has(sId) && excType === '1') {
      if (!c10Dates.has(sId)) {
        c10Dates.set(sId, new Set());
      }
      c10Dates.get(sId).add(date);
    }
  }

  console.log('Calendar dates summary for C10 services:');
  for (const [sId, dates] of c10Dates.entries()) {
    const sorted = [...dates].sort();
    console.log(`Service ${sId}: ${dates.size} active dates (from ${sorted[0]} to ${sorted[sorted.length - 1]})`);
    // Sample dates
    console.log(`  Sample August 2026 dates:`, sorted.filter(d => d.startsWith('202608')).slice(0, 10));
  }

  // Check which service operates today: 20260816 (Sunday)
  const todayStr = '20260816';
  console.log(`\nWhich service operates on today (${todayStr})?`);
  for (const [sId, dates] of c10Dates.entries()) {
    if (dates.has(todayStr)) {
      console.log(`  👉 Service ${sId} IS ACTIVE on ${todayStr}!`);
    }
  }
}

main().catch(console.error);

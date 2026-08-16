const fs = require('fs');
const path = require('path');
const readline = require('readline');

async function getActiveServices(dateStr) {
  const atmDir = 'H:/Coding/C10Data/data/atm_gtfs';
  const active = new Set();
  const inactive = new Set();

  // 1. Check calendar_dates.txt
  const stream = fs.createReadStream(path.join(atmDir, 'calendar_dates.txt'));
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let header = [];
  for await (const line of rl) {
    if (header.length === 0) {
      header = line.split(',');
      continue;
    }
    const [sId, date, excType] = line.split(',');
    if (date === dateStr) {
      if (excType === '1') active.add(sId);
      if (excType === '2') inactive.add(sId);
    }
  }

  // 2. Check calendar.txt for regular day of week
  const dateObj = new Date(
    parseInt(dateStr.substring(0, 4)),
    parseInt(dateStr.substring(4, 6)) - 1,
    parseInt(dateStr.substring(6, 8))
  );
  const dayOfWeek = dateObj.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayName = days[dayOfWeek];

  const calLines = fs.readFileSync(path.join(atmDir, 'calendar.txt'), 'utf8').split('\n');
  const calHeader = calLines[0].split(',');
  const dayIdx = calHeader.indexOf(dayName);
  const startIdx = calHeader.indexOf('start_date');
  const endIdx = calHeader.indexOf('end_date');

  for (let i = 1; i < calLines.length; i++) {
    const line = calLines[i].trim();
    if (!line) continue;
    const p = line.split(',');
    const sId = p[0];
    if (inactive.has(sId)) continue;
    if (p[dayIdx] === '1' && dateStr >= p[startIdx] && dateStr <= p[endIdx]) {
      active.add(sId);
    }
  }

  return active;
}

async function main() {
  const today = '20260816'; // Sunday
  const monday = '20260817'; // Monday

  const sundayServices = await getActiveServices(today);
  console.log(`Active services for Sunday ${today}:`, [...sundayServices].filter(s => s.startsWith('GEN_')));

  const mondayServices = await getActiveServices(monday);
  console.log(`Active services for Monday ${monday}:`, [...mondayServices].filter(s => s.startsWith('GEN_')));
}

main().catch(console.error);

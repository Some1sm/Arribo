const fs = require('fs');
const path = require('path');
const readline = require('readline');

async function main() {
  const projectDir = 'H:/Coding/C10Data';
  const dataDir = path.join(projectDir, 'data');
  const atmDir = path.join(dataDir, 'atm_gtfs');
  const ambDir = path.join(dataDir, 'amb_gtfs');

  if (!fs.existsSync(atmDir)) fs.mkdirSync(atmDir, { recursive: true });
  if (!fs.existsSync(ambDir)) fs.mkdirSync(ambDir, { recursive: true });

  const scratchAtm = 'C:/Users/ceper/.gemini/antigravity/brain/646bbb25-2441-4428-8c81-ef161d0f8e1d/scratch/atm_gtfs';
  const scratchAmb = 'C:/Users/ceper/.gemini/antigravity/brain/646bbb25-2441-4428-8c81-ef161d0f8e1d/scratch/amb_gtfs';

  // Copy files from scratch to project directory
  if (fs.existsSync(scratchAtm)) {
    for (const file of fs.readdirSync(scratchAtm)) {
      if (file.endsWith('.txt')) {
        fs.copyFileSync(path.join(scratchAtm, file), path.join(atmDir, file));
      }
    }
  }
  if (fs.existsSync(scratchAmb)) {
    for (const file of fs.readdirSync(scratchAmb)) {
      if (file.endsWith('.txt')) {
        fs.copyFileSync(path.join(scratchAmb, file), path.join(ambDir, file));
      }
    }
  }
  console.log('ATM files copied:', fs.readdirSync(atmDir));
  console.log('AMB files copied:', fs.readdirSync(ambDir));

  // Now search ATM routes.txt for C10 or C-10 or Casas
  console.log('\n--- ATM ROUTES FOR C10 / CASAS / MATARO ---');
  const routesContent = fs.readFileSync(path.join(atmDir, 'routes.txt'), 'utf8').split('\n');
  console.log('Header:', routesContent[0]);
  const matchingRoutes = [];
  for (const line of routesContent) {
    const lower = line.toLowerCase();
    if (lower.includes('c10') || lower.includes('c-10') || lower.includes('casas') || (lower.includes('matar') && lower.includes('barcelona'))) {
      console.log(line);
      matchingRoutes.push(line);
    }
  }

  // Search ATM agency.txt for Casas or Moventis
  console.log('\n--- ATM AGENCY.TXT ---');
  const agencyContent = fs.readFileSync(path.join(atmDir, 'agency.txt'), 'utf8').split('\n');
  for (const line of agencyContent) {
    if (line.toLowerCase().includes('casas') || line.toLowerCase().includes('moventis') || line.toLowerCase().includes('empresa')) {
      console.log(line);
    }
  }

  // Search ATM stops.txt for "Itàlia" / "Italia" / Mataró
  console.log('\n--- ATM STOPS FOR ITALIA / MATARO ---');
  const stopsStream = fs.createReadStream(path.join(atmDir, 'stops.txt'));
  const rl = readline.createInterface({ input: stopsStream, crlfDelay: Infinity });

  let header = '';
  let foundStops = [];
  for await (const line of rl) {
    if (!header) {
      header = line;
      console.log('Stops header:', header);
      continue;
    }
    const lower = line.toLowerCase();
    if (lower.includes('itàlia') || lower.includes('italia')) {
      console.log('Stop match:', line);
      foundStops.push(line);
    }
  }
  console.log(`Found ${foundStops.length} stops matching 'italia'.`);
}

main().catch(console.error);

const mouteClient = require('../src/mouteClient');
const fs = require('fs');

async function main() {
  const stopsDir1 = JSON.parse(fs.readFileSync('H:/Coding/C10Data/data/c10_matched_stops_dir1.json', 'utf8'));

  console.log('--- Inspecting all stops for active C10 at 13:03 ---');
  for (const s of stopsDir1) {
    if (!s.mouteStopId) continue;
    try {
      const data = await mouteClient.getNextDepartures(s.mouteStopId, true, 'ca_ES');
      if (data && data.sortides && data.sortides.sortida) {
        const sortides = Array.isArray(data.sortides.sortida) ? data.sortides.sortida : [data.sortides.sortida];
        const c10Deps = sortides.filter(dep => dep.liniaId === '02498' || (dep.descripcioLinia && dep.descripcioLinia.includes('C10')));
        if (c10Deps.length > 0) {
          const first = c10Deps[0];
          console.log(`Seq ${s.seq} (${s.name}, MouTe: ${s.mouteStopId}): Time=${first.hora}:${first.minuts.toString().padStart(2, '0')} | RT=${first.realtime} | Trip=${first.tripId}`);
        }
      }
    } catch (e) {
      // ignore
    }
  }
}

main().catch(console.error);

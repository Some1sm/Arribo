const corridorTracker = require('../src/corridorTracker');
const mouteClient = require('../src/mouteClient');

async function test() {
  console.log('Comparing live stops output across both directions at 14:29...');
  
  const stopsToCheckDir0 = [
    { name: "Mataró Pl. Itàlia", id: '10037202', seq: 2, gtfs: 'GEN_184749_2' },
    { name: "Mataró Porta Laietana", id: '10037205', seq: 7, gtfs: 'GEN_184749_7' },
    { name: "Vilassar de Mar", id: '10038038', seq: 15, gtfs: 'GEN_184749_15' },
    { name: "Premià de Mar", id: '10038471', seq: 20, gtfs: 'GEN_184749_20' },
    { name: "Montgat Rodalies", id: '10027798', seq: 29, gtfs: 'GEN_184749_29' },
    { name: "Badalona Pompeu Fabra", id: '10025777', seq: 34, gtfs: 'GEN_184749_34' }
  ];

  for (const st of stopsToCheckDir0) {
    const raw = await mouteClient.getNextDepartures(st.id, true, 'ca_ES');
    const lineas = raw?.parada?.lineas?.linia;
    const c10Raw = Array.isArray(lineas) ? lineas.find(l => l.nomLinia === 'C10' || l.nomLinia === 'C-10') : (lineas?.nomLinia === 'C10' ? lineas : null);
    const rawProxim = c10Raw?.proximosAutobuses?.proximoAutobus;
    const sortides = raw?.sortides?.sortida;

    const parsed = corridorTracker.parseDepartures(raw, st.gtfs, '0', st.id, st.seq);
    console.log(`\n=== Stop: ${st.name} (${st.id}) ===`);
    console.log(`Raw Mou-te proximosAutobuses:`, rawProxim);
    console.log(`Raw Mou-te sortides:`, Array.isArray(sortides) ? sortides.slice(0, 2) : sortides);
    console.log(`Our parsed next bus:`, parsed[0]?.departureTime, `| Status: ${parsed[0]?.formattedStatus} | Sched: ${parsed[0]?.scheduledTime} | Delay: ${parsed[0]?.delayBadgeText}`);
  }
}

test().catch(console.error);

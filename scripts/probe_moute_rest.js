const mouteClient = require('../src/mouteClient');

async function probe() {
  const endpoints = [
    'infrastructure/nextdeparturesNEW?paradaId=10037202&useRealTime=true&language=ca_ES',
    'infrastructure/line?idLinia=02498',
    'infrastructure/lineNEW?idLinia=02498',
    'infrastructure/lines?network=cat',
    'infrastructure/vehiclepositions',
    'infrastructure/vehicles',
    'infrastructure/vehiclesNEW?idLinia=02498',
    'infrastructure/tracking?idLinia=02498',
    'infrastructure/tracking?tripId=02498%20_131162900_001_3272703_1_15145680',
    'infrastructure/realtime?idLinia=02498',
    'infrastructure/realtimeNEW?idLinia=02498',
    'infrastructure/tripupdates',
    'infrastructure/tripupdatesNEW?idLinia=02498',
    'infrastructure/siri-vm',
    'infrastructure/sirivm',
    'infrastructure/stops?idLinia=02498',
    'infrastructure/stopsNEW?idLinia=02498',
    'infrastructure/search?query=C10'
  ];

  console.log('--- Probing Mou-te REST Endpoints ---');
  for (const ep of endpoints) {
    try {
      const res = await mouteClient.fetchWithAuth(ep, false);
      if (res) {
        console.log(`✅ [200 OK] ${ep} ->`, JSON.stringify(res).substring(0, 250));
      } else {
        console.log(`⚪ [Empty/Null] ${ep}`);
      }
    } catch (e) {
      console.log(`❌ [Error] ${ep} -> ${e.message}`);
    }
  }
}

probe().catch(console.error);

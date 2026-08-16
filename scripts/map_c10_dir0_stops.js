const fs = require('fs');
const crypto = require('crypto');

function getAuthHeader() {
  const timestamp = Date.now().toString();
  const substr = timestamp.substring(0, 7);
  return crypto.createHash('md5').update('mouteapi' + substr).digest('hex');
}

async function queryMouTe(endpoint) {
  const at = getAuthHeader();
  const url = `https://mou-te.gencat.cat/MouteAPI/rest/${endpoint}`;

  const res = await fetch(url, {
    headers: {
      'AT': at,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept': 'application/json, text/plain, */*'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function main() {
  const c10Data = JSON.parse(fs.readFileSync('H:/Coding/C10Data/data/c10_route_stops.json', 'utf8'));
  const dir0Stops = c10Data.directions['0'].stops; // Mataró -> Barcelona

  console.log(`Matching ${dir0Stops.length} stops from GTFS with Mou-te API (Direction 0: Mataró -> Barcelona)...`);

  const matchedStops = [];

  for (const s of dir0Stops) {
    if (!s.lat || !s.lon) {
      console.log(`Skipping stop without coords: ${s.name}`);
      continue;
    }
    try {
      const data = await queryMouTe(`infrastructure/nearbyotp?coordX=${s.lon}&coordY=${s.lat}&radius=150&language=ca_ES`);
      const transports = data.transports || [];
      const best = transports[0];
      if (best) {
        matchedStops.push({
          seq: s.seq,
          gtfsStopId: s.stopId,
          code: s.code,
          name: s.name,
          lat: s.lat,
          lon: s.lon,
          mouteStopId: best.id,
          mouteDesc: best.desc,
          distance: best.distance
        });
        console.log(`[${s.seq.toString().padStart(2)}] GTFS: "${s.name}" -> Mou-te ID: ${best.id} ("${best.desc}", ${best.distance}m)`);
      } else {
        console.log(`[${s.seq.toString().padStart(2)}] GTFS: "${s.name}" -> No nearby Mou-te stop found within 150m!`);
        matchedStops.push({
          seq: s.seq,
          gtfsStopId: s.stopId,
          code: s.code,
          name: s.name,
          lat: s.lat,
          lon: s.lon,
          mouteStopId: null
        });
      }
    } catch (err) {
      console.error(`Error querying stop ${s.name}:`, err.message);
    }
    await new Promise(r => setTimeout(r, 100));
  }

  fs.writeFileSync('H:/Coding/C10Data/data/c10_matched_stops_dir0.json', JSON.stringify(matchedStops, null, 2));
  console.log(`\nSaved ${matchedStops.length} matched stops to H:/Coding/C10Data/data/c10_matched_stops_dir0.json`);
}

main().catch(console.error);

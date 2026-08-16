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
  // Load GTFS C10 stops
  const c10Data = JSON.parse(fs.readFileSync('H:/Coding/C10Data/data/c10_route_stops.json', 'utf8'));
  const dir1Stops = c10Data.directions['1'].stops; // Barcelona -> Mataró

  console.log(`Matching ${dir1Stops.length} stops from GTFS with Mou-te API...`);

  const matchedStops = [];

  for (const s of dir1Stops) {
    if (!s.lat || !s.lon) {
      console.log(`Skipping stop without coords: ${s.name}`);
      continue;
    }
    try {
      // Query nearbyotp
      const data = await queryMouTe(`infrastructure/nearbyotp?coordX=${s.lon}&coordY=${s.lat}&radius=150&language=ca_ES`);
      const transports = data.transports || [];
      // Find transport matching stop or closest
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
    // Small delay to be polite
    await new Promise(r => setTimeout(r, 100));
  }

  fs.writeFileSync('H:/Coding/C10Data/data/c10_matched_stops_dir1.json', JSON.stringify(matchedStops, null, 2));
  console.log(`\nSaved ${matchedStops.length} matched stops to H:/Coding/C10Data/data/c10_matched_stops_dir1.json`);
}

main().catch(console.error);

const fs = require('fs');
const path = require('path');
const geoEngine = require('../../src/core/geo/geoEngine');
const scheduleSynthesizer = require('../../src/core/schedule/scheduleSynthesizer');

const schedules = JSON.parse(fs.readFileSync(path.join(__dirname, 'mataro_authoritative_schedules.json'), 'utf8'));
const routesData = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/cities/mataro/mataro_routes_full.json'), 'utf8'));
const linesData = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/cities/mataro/mataro_lineas.json'), 'utf8')).message;
const stopsData = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/cities/mataro/mataro_paradas.json'), 'utf8')).message;

const stopsMap = new Map();
stopsData.forEach(s => {
  stopsMap.set(String(s.id), s);
});

console.log('================================================================');
console.log('MATARÓ BUS LINES 1-8 COMPREHENSIVE SCHEDULE & TOPOGRAPHY ANALYSIS');
console.log('================================================================\n');

for (const line of linesData) {
  const lId = String(line.id);
  const lSched = schedules[lId];
  const lRoutes = routesData[lId] || [];

  console.log(`\n### LINE ${lId}: ${line.name} (Color: ${line.color})`);

  for (let rIdx = 0; rIdx < lRoutes.length; rIdx++) {
    const route = lRoutes[rIdx];
    const pathId = String(route.id);
    const dirInfo = lSched.directions[pathId] || {};
    const daySchedules = dirInfo.schedules || {};

    const polyCoords = (route.coords || []).map(c => ({ lat: parseFloat(c.Latitude), lon: parseFloat(c.Longitude) }));
    const totalDistMeters = geoEngine.calculateRouteTotalDistance(polyCoords);

    // Calculate stop runtimes
    const stopTravelTimes = scheduleSynthesizer.estimateStopTravelTimes(route.stops || [], {
      speedMps: 4.8, // ~17.3 km/h urban speed
      dwellSecPerStop: 25,
      defaultSegmentMeters: 300
    });

    const totalTravelSec = stopTravelTimes.length > 0 ? stopTravelTimes[stopTravelTimes.length - 1].travelSec : 0;
    const totalTravelMins = Math.round(totalTravelSec / 60);

    console.log(`\n#### Direction ${rIdx}: [Path ${pathId}] ${route.name}`);
    console.log(`- Origin: [${route.stops[0]?.id}] ${route.stops[0]?.name}`);
    console.log(`- Destination: [${route.stops[route.stops.length - 1]?.id}] ${route.stops[route.stops.length - 1]?.name}`);
    console.log(`- Stops Count: ${route.stops?.length || 0}`);
    console.log(`- Route Polyline Points: ${polyCoords.length}`);
    console.log(`- Total Distance: ${(totalDistMeters / 1000).toFixed(2)} km (${Math.round(totalDistMeters)} m)`);
    console.log(`- Total Runtime: ~${totalTravelMins} min (${totalTravelSec} sec)`);

    console.log(`\n- **Authoritative Departures**:`);
    for (const [dayType, deps] of Object.entries(daySchedules)) {
      console.log(`  - **${dayType}** (${deps.length} trips):`);
      console.log(`    - First: ${deps[0]} | Last: ${deps[deps.length - 1]}`);
      console.log(`    - Departures: ${deps.join(', ')}`);
    }

    console.log(`\n- **Stop Sequence & Topography**:`);
    route.stops.forEach((s, idx) => {
      const st = stopTravelTimes[idx] || {};
      console.log(`    ${String(idx + 1).padStart(2, '0')}. [${s.id}] ${s.name.padEnd(35, ' ')} | +${String(st.travelMinutes || 0).padStart(2, ' ')}m (${String(st.travelSec || 0).padStart(4, ' ')}s) | ${(st.cumulativeMeters || 0)}m`);
    });
  }
}

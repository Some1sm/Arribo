const st = require('../src/sagalesTracker');
const geoUtils = require('../src/geoUtils');

(async () => {
  const details = await st.getLineDetails('n82', '0');
  const stops = details.stops;
  console.log('Total stops on N82 Dir 0:', stops.length);
  stops.forEach((s, idx) => {
    let dist = 0;
    for (let i = 1; i <= idx; i++) {
      dist += geoUtils.calculateDistanceMeters(stops[i-1].lat, stops[i-1].lon, stops[i].lat, stops[i].lon);
    }
    const travelSec = Math.round((dist / 10.0) + (idx * 30));
    const travelMin = Math.round(travelSec / 60);
    console.log(`Stop #${idx+1} [${s.code}] ${s.name} (${s.city}): +${travelMin} min (dist: ${(dist/1000).toFixed(1)} km)`);
  });
})();

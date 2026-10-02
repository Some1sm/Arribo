/**
 * src/core/geo/gapClusters.js
 *
 * Groups GPS gaps into hotspots by distance between the points where the
 * signal was lost. A fixed grid split neighbours that sat either side of an
 * invisible grid line (two losses 20 m apart became two circles, and a real
 * dead zone never reached the "recurrent" threshold).
 *
 * Leader clustering on the running centroid: a point joins the nearest
 * hotspot whose centre is within RADIUS_M, else starts one; then hotspots
 * whose centres ended up within RADIUS_M of each other merge. Measuring to the
 * centre (not to the nearest member) stops a street of losses every 80 m from
 * chaining into one kilometre-long "spot": a hotspot spans at most ~2 radii.
 */

const RADIUS_M = 100;

function distanceM(lat1, lon1, lat2, lon2) {
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * @param {Array<object>} points  each with numeric `lat` and `lon` (any other fields kept)
 * @param {number} [radiusM]
 * @returns {Array<{lat:number, lon:number, members:Array<object>}>}
 */
function clusterPoints(points, radiusM = RADIUS_M) {
  const clusters = [];
  const add = (c, p) => {
    c.members.push(p);
    const n = c.members.length;
    c.lat += (p.lat - c.lat) / n;
    c.lon += (p.lon - c.lon) / n;
  };
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    let best = null;
    let bestD = Infinity;
    for (const c of clusters) {
      const d = distanceM(p.lat, p.lon, c.lat, c.lon);
      if (d <= radiusM && d < bestD) { best = c; bestD = d; }
    }
    if (best) add(best, p);
    else clusters.push({ lat: p.lat, lon: p.lon, members: [p] });
  }
  // Merge hotspots whose centres drifted within reach of each other.
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        if (distanceM(clusters[i].lat, clusters[i].lon, clusters[j].lat, clusters[j].lon) <= radiusM) {
          const [keep, gone] = clusters[i].members.length >= clusters[j].members.length ? [i, j] : [j, i];
          for (const p of clusters[gone].members) add(clusters[keep], p);
          clusters.splice(gone, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return clusters;
}

module.exports = { clusterPoints, distanceM, RADIUS_M };

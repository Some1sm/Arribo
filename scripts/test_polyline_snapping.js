const fs = require('fs');

function calculateDistance(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 111320;
  const dLon = (lon2 - lon1) * 111320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

function calculateBearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2 - lon1) * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180);
  const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
            Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos((lon2 - lon1) * Math.PI / 180);
  const brng = Math.atan2(y, x) * 180 / Math.PI;
  return Math.round((brng + 360) % 360);
}

// Find closest vertex or projection on polyline
function snapToPolyline(lat, lon, polyline) {
  if (!polyline || polyline.length === 0) return { lat, lon, index: 0, bearing: 0 };
  if (polyline.length === 1) return { lat: polyline[0][0], lon: polyline[0][1], index: 0, bearing: 0 };

  let minDistance = Infinity;
  let bestPoint = { lat: polyline[0][0], lon: polyline[0][1], index: 0, bearing: 0 };

  for (let i = 0; i < polyline.length - 1; i++) {
    const p1 = polyline[i];
    const p2 = polyline[i + 1];

    const x1 = p1[1], y1 = p1[0];
    const x2 = p2[1], y2 = p2[0];
    const px = lon, py = lat;

    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;

    let t = 0;
    if (lenSq > 0) {
      t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
    }

    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    const dist = calculateDistance(lat, lon, projY, projX);

    if (dist < minDistance) {
      minDistance = dist;
      bestPoint = {
        lat: projY,
        lon: projX,
        index: i,
        t,
        bearing: calculateBearing(p1[0], p1[1], p2[0], p2[1]),
        distanceMeters: dist
      };
    }
  }

  return bestPoint;
}

// Extract subpath along polyline from point A to point B
function getSubpath(polyline, startLat, startLon, endLat, endLon) {
  if (!polyline || polyline.length < 2) return [[startLat, startLon], [endLat, endLon]];

  const snapStart = snapToPolyline(startLat, startLon, polyline);
  const snapEnd = snapToPolyline(endLat, endLon, polyline);

  let fromIdx = snapStart.index;
  let toIdx = snapEnd.index;

  const subpath = [];
  subpath.push([snapStart.lat, snapStart.lon]);

  if (fromIdx <= toIdx) {
    for (let i = fromIdx + 1; i <= toIdx; i++) {
      subpath.push(polyline[i]);
    }
  } else {
    for (let i = fromIdx; i >= toIdx + 1; i--) {
      subpath.push(polyline[i]);
    }
  }

  subpath.push([snapEnd.lat, snapEnd.lon]);
  return subpath;
}

// Given a subpath and a progress (0.0 to 1.0), compute the exact (lat, lon, bearing)
function interpolateAlongSubpath(subpath, progress) {
  if (!subpath || subpath.length === 0) return null;
  if (subpath.length === 1 || progress <= 0) return { lat: subpath[0][0], lon: subpath[0][1], bearing: 0 };
  if (progress >= 1) {
    const last = subpath[subpath.length - 1];
    const prev = subpath[subpath.length - 2];
    return { lat: last[0], lon: last[1], bearing: calculateBearing(prev[0], prev[1], last[0], last[1]) };
  }

  // Calculate cumulative segment lengths
  const segLengths = [];
  let totalLength = 0;

  for (let i = 0; i < subpath.length - 1; i++) {
    const d = calculateDistance(subpath[i][0], subpath[i][1], subpath[i + 1][0], subpath[i + 1][1]);
    segLengths.push(d);
    totalLength += d;
  }

  if (totalLength === 0) return { lat: subpath[0][0], lon: subpath[0][1], bearing: 0 };

  const targetDist = progress * totalLength;
  let accumulated = 0;

  for (let i = 0; i < segLengths.length; i++) {
    const segLen = segLengths[i];
    if (accumulated + segLen >= targetDist || i === segLengths.length - 1) {
      const segProgress = segLen > 0 ? (targetDist - accumulated) / segLen : 0;
      const p1 = subpath[i];
      const p2 = subpath[i + 1];
      const lat = p1[0] + segProgress * (p2[0] - p1[0]);
      const lon = p1[1] + segProgress * (p2[1] - p1[1]);
      const bearing = calculateBearing(p1[0], p1[1], p2[0], p2[1]);
      return { lat, lon, bearing };
    }
    accumulated += segLen;
  }

  const last = subpath[subpath.length - 1];
  return { lat: last[0], lon: last[1], bearing: 0 };
}

// Test with Mataro Line 1
const routes = JSON.parse(fs.readFileSync('data/mataro_routes_full.json', 'utf8'));
const line1Coords = routes['1'][0].coords.map(c => [parseFloat(c.Latitude), parseFloat(c.Longitude)]);
console.log('Line 1 polyline vertices:', line1Coords.length);

const s1 = line1Coords[0];
const s50 = line1Coords[Math.min(50, line1Coords.length - 1)];

console.log('Extracting subpath between vertex 0 and 50...');
const sub = getSubpath(line1Coords, s1[0], s1[1], s50[0], s50[1]);
console.log('Subpath vertices count:', sub.length);

for (let p = 0; p <= 1.0; p += 0.25) {
  const pt = interpolateAlongSubpath(sub, p);
  console.log(`Progress ${(p * 100).toFixed(0)}%: Lat ${pt.lat.toFixed(5)}, Lon ${pt.lon.toFixed(5)}, Bearing ${pt.bearing}°`);
}

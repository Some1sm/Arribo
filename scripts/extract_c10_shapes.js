const fs = require('fs');
const readline = require('readline');
const path = require('path');

async function extractC10Shapes() {
  console.log('Extracting C10 shapes from atm_gtfs...');
  const shapesFile = path.join(__dirname, '..', 'data', 'atm_gtfs', 'shapes.txt');
  const tripsFile = path.join(__dirname, '..', 'data', 'atm_gtfs', 'trips.txt');
  const routesFile = path.join(__dirname, '..', 'data', 'atm_gtfs', 'routes.txt');

  if (!fs.existsSync(shapesFile) || !fs.existsSync(tripsFile)) {
    console.log('shapes.txt or trips.txt not found, checking if archive exists');
    return;
  }

  // 1. Find C10 route_id
  const routeLines = fs.readFileSync(routesFile, 'utf8').split('\n');
  const c10RouteIds = [];
  routeLines.forEach(l => {
    if (l.includes('C-10') || l.includes('C10')) {
      const parts = l.split(',');
      c10RouteIds.push(parts[0]);
      console.log('Found C10 route:', l);
    }
  });

  // 2. Find shape_ids for C10 trips
  const tripLines = fs.readFileSync(tripsFile, 'utf8').split('\n');
  const shapeIds = new Set();
  const shapeByDir = {};

  tripLines.forEach(l => {
    const parts = l.split(',');
    if (c10RouteIds.includes(parts[0])) {
      const shapeId = parts[parts.length - 1]?.trim();
      const dir = parts[parts.length - 3]?.trim();
      if (shapeId) {
        shapeIds.add(shapeId);
        if (!shapeByDir[dir]) shapeByDir[dir] = shapeId;
      }
    }
  });

  console.log('Shape IDs for C-10:', Array.from(shapeIds), 'By Dir:', shapeByDir);

  // 3. Extract points from shapes.txt
  const fileStream = fs.createReadStream(shapesFile);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const shapePoints = {};
  for (const sId of shapeIds) shapePoints[sId] = [];

  for await (const line of rl) {
    const parts = line.split(',');
    const sId = parts[0]?.trim();
    if (shapeIds.has(sId)) {
      const lat = parseFloat(parts[1]);
      const lon = parseFloat(parts[2]);
      const seq = parseInt(parts[3], 10);
      shapePoints[sId].push({ lat, lon, seq });
    }
  }

  for (const sId of Object.keys(shapePoints)) {
    shapePoints[sId].sort((a, b) => a.seq - b.seq);
    console.log(`Shape ${sId}: ${shapePoints[sId].length} points`);
  }

  fs.writeFileSync('data/c10_shapes.json', JSON.stringify({ shapeByDir, shapePoints }, null, 2));
  console.log('Saved data/c10_shapes.json successfully!');
}

extractC10Shapes().catch(console.error);

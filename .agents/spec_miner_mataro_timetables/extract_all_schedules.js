const fs = require('fs');
const https = require('https');
const querystring = require('querystring');
const path = require('path');

function postRequest(params) {
  return new Promise((resolve, reject) => {
    const postData = querystring.stringify(params);
    const options = {
      hostname: 'mataro.avanzagrupo.com',
      port: 443,
      path: '/detalle-linea?p_p_id=adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw&p_p_lifecycle=2&p_p_state=normal&p_p_mode=view&p_p_cacheability=cacheLevelPage&_adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_cmd=' + params.cmd,
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Content-Length': Buffer.byteLength(postData),
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      timeout: 15000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });

    req.write(postData);
    req.end();
  });
}

async function extractAllMataroSchedules() {
  const routesData = JSON.parse(fs.readFileSync('data/cities/mataro/mataro_routes_full.json', 'utf8'));
  const linesData = JSON.parse(fs.readFileSync('data/cities/mataro/mataro_lineas.json', 'utf8')).message;
  
  const authoritativeSchedules = {};

  for (const line of linesData) {
    const lineId = String(line.id);
    console.log(`\n========================================`);
    console.log(`Processing Line ${lineId}: ${line.name}`);
    console.log(`========================================`);

    authoritativeSchedules[lineId] = {
      lineId,
      lineName: line.name,
      color: line.color,
      directions: {}
    };

    // Get trayectos for Ida and Vuelta
    let trayIda = [];
    let trayVuelta = [];
    try {
      const resIda = await postRequest({
        cmd: 'getTrayectosIda',
        _adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_idBusLine: lineId,
        _adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_direccion: 'I'
      });
      if (resIda && resIda.trayectosResponse) {
        trayIda = JSON.parse(resIda.trayectosResponse);
      }
    } catch (e) {
      console.warn(`  Warning getTrayectosIda Line ${lineId}:`, e.message);
    }

    try {
      const resVuelta = await postRequest({
        cmd: 'getTrayectosVuelta',
        _adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_idBusLine: lineId,
        _adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_direccion: 'V'
      });
      if (resVuelta && resVuelta.trayectosResponse) {
        trayVuelta = JSON.parse(resVuelta.trayectosResponse);
      }
    } catch (e) {
      console.warn(`  Warning getTrayectosVuelta Line ${lineId}:`, e.message);
    }

    const allTrayectos = [...trayIda, ...trayVuelta];
    const seenPaths = new Set();

    // Map each trayecto with local route data to get origin stop
    const localRoutes = routesData[lineId] || [];

    for (const tray of allTrayectos) {
      const pathId = String(tray.pathIdBusLine);
      const dirKey = `${pathId}_${tray.direction}`;
      if (seenPaths.has(dirKey)) continue;
      seenPaths.add(dirKey);

      // Find origin stop from local route data matching pathId or direction
      const matchingLocalRoute = localRoutes.find(r => String(r.id) === pathId) || localRoutes[0];
      const originStop = matchingLocalRoute && matchingLocalRoute.stops && matchingLocalRoute.stops[0] ? matchingLocalRoute.stops[0] : null;
      const originStopId = originStop ? String(originStop.id) : '';

      console.log(`  Querying Schedule: Path ${pathId} (${tray.pathIdDescription}), Dir: ${tray.direction}, Origin: ${originStop ? `[${originStop.id}] ${originStop.name}` : 'Unknown'}`);

      try {
        const hRes = await postRequest({
          cmd: 'getHorariosTeoricos',
          _adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_idBusLine: lineId,
          _adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_pathIdBusLine: pathId,
          _adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_direccion: tray.direction,
          _adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_primeraParada: originStopId
        });

        let daySchedules = [];
        if (hRes && hRes.horariosTeoricosResponse) {
          daySchedules = JSON.parse(hRes.horariosTeoricosResponse);
        }

        const scheduleByDay = {};
        daySchedules.forEach(ds => {
          scheduleByDay[ds.dayType] = ds.schedules || [];
          console.log(`    - ${ds.dayType}: ${ds.schedules ? ds.schedules.length : 0} departures. Sample: [${(ds.schedules || []).slice(0, 5).join(', ')} ... ${(ds.schedules || []).slice(-3).join(', ')}]`);
        });

        authoritativeSchedules[lineId].directions[pathId] = {
          pathIdBusLine: pathId,
          direction: tray.direction,
          directionName: tray.pathIdDescription,
          originStop: originStop ? { id: String(originStop.id), name: originStop.name } : null,
          terminalStop: matchingLocalRoute && matchingLocalRoute.stops ? { id: String(matchingLocalRoute.stops[matchingLocalRoute.stops.length - 1].id), name: matchingLocalRoute.stops[matchingLocalRoute.stops.length - 1].name } : null,
          stopsCount: matchingLocalRoute && matchingLocalRoute.stops ? matchingLocalRoute.stops.length : 0,
          schedules: scheduleByDay
        };
      } catch (e) {
        console.error(`    Error fetching schedule for path ${pathId}:`, e.message);
      }
    }
  }

  const outPath = path.join(__dirname, 'mataro_authoritative_schedules.json');
  fs.writeFileSync(outPath, JSON.stringify(authoritativeSchedules, null, 2), 'utf8');
  console.log(`\nSuccessfully exported all Mataro authoritative schedules to ${outPath}`);
}

extractAllMataroSchedules().catch(console.error);

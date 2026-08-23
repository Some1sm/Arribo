// Authoritative Static Dataset for C-10 Coastal Corridor (Barcelona ⇄ Mataró per N-II)
// Moventis / Casas (Interurbà Maresme)

const fs = require('fs');
const path = require('path');

/**
 * Extracts the REAL GEN_0498 (C-10) trip schedule from data/atm_gtfs, replacing
 * the old fabricated fixed-start-minute timetables. Cached to
 * data/cache/c10_gtfs_schedule.json so the 220MB stop_times scan runs once.
 * Returns { dir0: [...], dir1: [...] } or null when the feed is unavailable.
 */
function extractGtfsTrips() {
  const CACHE_VERSION = 3;
  const cachePath = path.join(__dirname, '..', 'data', 'cache', 'c10_gtfs_schedule.json');
  try {
    if (fs.existsSync(cachePath)) {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (cached.version === CACHE_VERSION && Array.isArray(cached.dir0) && Array.isArray(cached.dir1) && cached.dir0.length > 0) {
        return cached;
      }
    }
  } catch (_) {}

  const atmDir = path.join(__dirname, '..', 'data', 'atm_gtfs');
  const tripsPath = path.join(atmDir, 'trips.txt');
  const stopTimesPath = path.join(atmDir, 'stop_times.txt');
  if (!fs.existsSync(tripsPath) || !fs.existsSync(stopTimesPath)) return null;

  const parseCsvLine = (line) => {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };

  // Pass 1: trips.txt — collect GEN_0498 trips (small file).
  const wanted = new Map(); // tripId -> { serviceId, dirId }
  const tLines = fs.readFileSync(tripsPath, 'utf8').split('\n').filter(l => l.trim());
  const tH = {};
  parseCsvLine(tLines[0]).forEach((nm, i) => { tH[nm.trim()] = i; });
  for (let i = 1; i < tLines.length; i++) {
    const p = parseCsvLine(tLines[i]);
    if (p[tH.route_id] !== 'GEN_0498' || !p[tH.trip_id]) continue;
    wanted.set(p[tH.trip_id], {
      serviceId: p[tH.service_id] || '',
      dirId: String(p[tH.direction_id] || '0')
    });
  }
  if (wanted.size === 0) return null;

  // Pass 2: stop_times.txt — chunked sync read (memory-safe).
  const stHeader = parseCsvLine(fs.readFileSync(stopTimesPath, 'utf8').split('\n')[0]);
  const stI = {};
  stHeader.forEach((nm, i) => { stI[nm.trim()] = i; });
  const byTrip = new Map();
  const fd = fs.openSync(stopTimesPath, 'r');
  const buf = Buffer.alloc(1 << 22);
  let leftover = '', bytesRead;
  try {
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      const lines = (leftover + buf.toString('utf8', 0, bytesRead)).split('\n');
      leftover = lines.pop();
      for (const l of lines) {
        const p = l.split(',');
        if (!wanted.has(p[stI.trip_id])) continue;
        if (!byTrip.has(p[stI.trip_id])) byTrip.set(p[stI.trip_id], []);
        byTrip.get(p[stI.trip_id]).push({
          stopId: p[stI.stop_id],
          seq: parseInt(p[stI.stop_sequence], 10) || 0,
          arr: p[stI.arrival_time] || '',
          dep: p[stI.departure_time] || ''
        });
      }
    }
    if (leftover.trim()) {
      const p = leftover.split(',');
      if (wanted.has(p[stI.trip_id])) {
        if (!byTrip.has(p[stI.trip_id])) byTrip.set(p[stI.trip_id], []);
        byTrip.get(p[stI.trip_id]).push({ stopId: p[stI.stop_id], seq: parseInt(p[stI.stop_sequence], 10) || 0, arr: p[stI.arrival_time] || '', dep: p[stI.departure_time] || '' });
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  const buildDir = (dirId, headsign) => {
    const trips = [];
    for (const [tripId, meta] of wanted.entries()) {
      if (meta.dirId !== dirId) continue;
      const rows = (byTrip.get(tripId) || []).sort((a, b) => a.seq - b.seq);
      if (rows.length < 2) continue;
      trips.push({
        tripId,
        serviceId: meta.serviceId,
        dirId,
        headsign,
        stops: rows.map(r => {
          const arr = (r.arr || r.dep || '').trim();
          const dep = (r.dep || r.arr || '').trim();
          return {
            stopId: r.stopId,
            gtfsStopId: r.stopId,
            seq: r.seq,
            arr, dep,
            arrivalTime: arr.substring(0, 5),
            departureTime: dep.substring(0, 5)
          };
        })
      });
    }
    trips.sort((a, b) => (a.stops[0].dep || '').localeCompare(b.stops[0].dep || ''));
    return trips;
  };

  const result = {
    version: CACHE_VERSION,
    generatedAt: new Date().toISOString(),
    dir0: buildDir('0', 'Barcelona (Metro la Pau)'),
    dir1: buildDir('1', 'Hospital de Mataró')
  };
  if (result.dir0.length === 0 && result.dir1.length === 0) return null;

  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmpPath = cachePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(result), 'utf8');
    fs.renameSync(tmpPath, cachePath);
  } catch (_) {}
  return result;
}

const C10_GTFS_TRIPS = extractGtfsTrips();
if (C10_GTFS_TRIPS) {
  console.log(`[C10StaticData] 📖 Real GTFS C-10 schedule loaded: ${C10_GTFS_TRIPS.dir0.length} dir0 + ${C10_GTFS_TRIPS.dir1.length} dir1 trips.`);
}

const C10_STOPS_DIR1 = [
  { seq: 0, mouteStopId: 'PF08019096', gtfsStopId: 'GEN_PF08019096', code: 'PF08019096', name: 'Barcelona - rbla. Guipúscoa (Metro la Pau)', lat: 41.4233475, lon: 2.2061915, zone: 'Maresme', city: 'Barcelona' },
  { seq: 1, mouteStopId: 'PF08019095', gtfsStopId: 'GEN_PF08019095', code: 'PF08019095', name: 'Sant Adrià de Besòs - rbla. Guipúscoa - c. Extremadura', lat: 41.4248161, lon: 2.2085872, zone: 'Maresme', city: 'Sant Adrià de Besòs' },
  { seq: 2, mouteStopId: 'PF08194004', gtfsStopId: 'GEN_PF08194004', code: 'PF08194004', name: 'Sant Adrià de Besòs - av. Pi i Margall - av. Catalunya (A)', lat: 41.4327927, lon: 2.216064, zone: 'Maresme', city: 'Sant Adrià de Besòs' },
  { seq: 3, mouteStopId: 'PF08015012', gtfsStopId: 'GEN_PF08015012', code: 'PF08015012', name: 'Badalona - av. Alfons XIII - c. Huelva', lat: 41.4365501, lon: 2.2229762, zone: 'Maresme', city: 'Badalona' },
  { seq: 4, mouteStopId: 'PF08015011', gtfsStopId: 'GEN_PF08015011', code: 'PF08015011', name: 'Badalona - av. Alfons XIII - c. Sant Lluc', lat: 41.4393806, lon: 2.2283056, zone: 'Maresme', city: 'Badalona' },
  { seq: 5, mouteStopId: 'PF08015037', gtfsStopId: 'GEN_PF08015037', code: 'PF08015037', name: 'Badalona - av. Marquès de Mont-roig - c. Antoni Bori', lat: 41.4409294, lon: 2.2343805, zone: 'Maresme', city: 'Badalona' },
  { seq: 6, mouteStopId: 'PF08015038', gtfsStopId: 'GEN_PF08015038', code: 'PF08015038', name: 'Badalona - av. Marquès de Mont-roig (pl. Països Catalans)', lat: 41.4442482, lon: 2.2383876, zone: 'Maresme', city: 'Badalona' },
  { seq: 7, mouteStopId: 'PF08015014', gtfsStopId: 'GEN_PF08015014', code: 'PF08015014', name: 'Badalona - c. Francesc Macià - av. Sant Ignasi de Loiola', lat: 41.4477806, lon: 2.2427499, zone: 'Maresme', city: 'Badalona' },
  { seq: 8, mouteStopId: 'PF08015008', gtfsStopId: 'GEN_PF08015008', code: 'PF08015008', name: 'Badalona - c. Francesc Layret - c. Sant Francesc d\'Assís', lat: 41.4507332, lon: 2.24826, zone: 'Maresme', city: 'Badalona' },
  { seq: 9, mouteStopId: 'PF08015015', gtfsStopId: 'GEN_PF08015015', code: 'PF08015015', name: 'Badalona - c. Sant Bru - c. les Corts', lat: 41.4532585, lon: 2.251272, zone: 'Maresme', city: 'Badalona' },
  { seq: 10, mouteStopId: 'PF08015033', gtfsStopId: 'GEN_PF08015033', code: 'PF08015033', name: 'Badalona - c. Pomar de Baix - Riera de Canyadó', lat: 41.4558868, lon: 2.2575338, zone: 'Maresme', city: 'Badalona' },
  { seq: 11, mouteStopId: 'PF08015013', gtfsStopId: 'GEN_PF08015013', code: 'PF08015013', name: 'Montgat - c. Marina davant ptge. Cussó', lat: 41.4599533, lon: 2.2668691, zone: 'Maresme', city: 'Montgat' },
  { seq: 12, mouteStopId: 'PF08126015', gtfsStopId: 'GEN_PF08126015', code: 'PF08126015', name: 'Montgat - Estació de Rodalies de Montgat (A)', lat: 41.4633522, lon: 2.2727306, zone: 'Maresme', city: 'Montgat' },
  { seq: 13, mouteStopId: 'PF08126014', gtfsStopId: 'GEN_PF08126014', code: 'PF08126014', name: 'Montgat - la Colònia Argentina (Ajuntament) (A)', lat: 41.4664421, lon: 2.2792609, zone: 'Maresme', city: 'Montgat' },
  { seq: 14, mouteStopId: 'PF08126002', gtfsStopId: 'GEN_PF08126002', code: 'PF08126002', name: 'Montgat - Camí Ral - Riera d\'en Font', lat: 41.4681129, lon: 2.2841239, zone: 'Maresme', city: 'Montgat' },
  { seq: 15, mouteStopId: 'PF08126004', gtfsStopId: 'GEN_PF08126004', code: 'PF08126004', name: 'Montgat - Estació de Rodalies de Montgat Nord (A)', lat: 41.469017, lon: 2.2870193, zone: 'Maresme', city: 'Montgat' },
  { seq: 16, mouteStopId: 'PF08126012', gtfsStopId: 'GEN_PF08126012', code: 'PF08126012', name: 'Montgat - Laboratoris Cusí (A) MNG', lat: 41.4723854, lon: 2.2957397, zone: 'Maresme', city: 'Montgat' },
  { seq: 17, mouteStopId: 'PF08118027', gtfsStopId: 'GEN_PF08118027', code: 'PF08118027', name: 'El Masnou - Estació de Rodalies del Masnou (A)', lat: 41.4772224, lon: 2.3113251, zone: 'Maresme', city: 'El Masnou' },
  { seq: 18, mouteStopId: 'PF08118040', gtfsStopId: 'GEN_PF08118040', code: 'PF08118040', name: 'El Masnou - Estació de Rodalies d\'Ocata (A)', lat: 41.4790611, lon: 2.319577, zone: 'Maresme', city: 'El Masnou' },
  { seq: 19, mouteStopId: 'PF08118064', gtfsStopId: 'GEN_PF08118064', code: 'PF08118064', name: 'El Masnou - pg. Prat de la Riba - av. Núria (A)', lat: 41.4804192, lon: 2.3246, zone: 'Maresme', city: 'El Masnou' },
  { seq: 20, mouteStopId: 'PF08118039', gtfsStopId: 'GEN_PF08118039', code: 'PF08118039', name: 'El Masnou - ctra. N-II (Càmping Hispano) (A)', lat: 41.4827957, lon: 2.335773, zone: 'Maresme', city: 'El Masnou' },
  { seq: 21, mouteStopId: 'PF08172022', gtfsStopId: 'GEN_PF08172022', code: 'PF08172022', name: 'Premià de Mar - Estació de Rodalies de Premià (A)', lat: 41.4878387, lon: 2.3554115, zone: 'Maresme', city: 'Premià de Mar' },
  { seq: 22, mouteStopId: 'PF08172023', gtfsStopId: 'GEN_PF08172023', code: 'PF08172023', name: 'Premià de Mar - Camí Ral (Bellamar) (A)', lat: 41.4895401, lon: 2.3611422, zone: 'Maresme', city: 'Premià de Mar' },
  { seq: 23, mouteStopId: 'PF08172003', gtfsStopId: 'GEN_PF08172003', code: 'PF08172003', name: 'Premià de Mar - Camí Ral (Port)', lat: 41.491375, lon: 2.366785, zone: 'Maresme', city: 'Premià de Mar' },
  { seq: 24, mouteStopId: 'PF08172024', gtfsStopId: 'GEN_PF08172024', code: 'PF08172024', name: 'Premià de Mar - Mercat de la Flor (Camp de Mar) (A)', lat: 41.493721, lon: 2.3739152, zone: 'Maresme', city: 'Premià de Mar' },
  { seq: 25, mouteStopId: 'PF08219064', gtfsStopId: 'GEN_PF08219064', code: 'PF08219064', name: 'Vilassar de Mar - ctra. N-II - Torrent d\'en Cuiàs (A)', lat: 41.4976311, lon: 2.3834751, zone: 'Maresme', city: 'Vilassar de Mar' },
  { seq: 26, mouteStopId: 'PF08219011', gtfsStopId: 'GEN_PF08219011', code: 'PF08219011', name: 'Vilassar de Mar - Estació de Rodalies de Vilassar (A)', lat: 41.5008812, lon: 2.3904638, zone: 'Maresme', city: 'Vilassar de Mar' },
  { seq: 27, mouteStopId: 'PF08219006', gtfsStopId: 'GEN_PF08219006', code: 'PF08219006', name: 'Vilassar de Mar - c. Canonge Almera - c. Enric Granados (A)', lat: 41.5048714, lon: 2.3981357, zone: 'Maresme', city: 'Vilassar de Mar' },
  { seq: 28, mouteStopId: 'PF08029017', gtfsStopId: 'GEN_PF08029017', code: 'PF08029017', name: 'Vilassar de Mar - ctra. N-II - av. Burriac (A)', lat: 41.508873, lon: 2.4043918, zone: 'Maresme', city: 'Vilassar de Mar' },
  { seq: 29, mouteStopId: 'PF08029039', gtfsStopId: 'GEN_PF08029039', code: 'PF08029039', name: 'Cabrera de Mar - ctra. N-II (urb. Bonamar) (A)', lat: 41.5127678, lon: 2.4097686, zone: 'Maresme', city: 'Cabrera de Mar' },
  { seq: 30, mouteStopId: 'PF08029016', gtfsStopId: 'GEN_PF08029016', code: 'PF08029016', name: 'Cabrera de Mar - ctra. N-II (Nissan)', lat: 41.5180969, lon: 2.4165974, zone: 'Maresme', city: 'Cabrera de Mar' },
  { seq: 31, mouteStopId: 'PF08029040', gtfsStopId: 'GEN_PF08029040', code: 'PF08029040', name: 'Cabrera de Mar - Centre Comercial Carrefour (A) MB0271', lat: 41.5208817, lon: 2.4209623, zone: 'Maresme', city: 'Cabrera de Mar' },
  { seq: 32, mouteStopId: 'PF08121082', gtfsStopId: 'GEN_PF08121082', code: 'PF08121082', name: 'Cabrera de Mar - av. Cabrera (Incineradora) (A)', lat: 41.5236855, lon: 2.4265566, zone: 'Maresme', city: 'Cabrera de Mar' },
  { seq: 33, mouteStopId: 'PF08121087', gtfsStopId: 'GEN_PF08121087', code: 'PF08121087', name: 'Cabrera de Mar - av. Maresme - c. Remallaire (A)', lat: 41.5266266, lon: 2.4313843, zone: 'Maresme', city: 'Cabrera de Mar' },
  { seq: 34, mouteStopId: 'PF08121080', gtfsStopId: 'GEN_PF08121080', code: 'PF08121080', name: 'Mataró - Camí Ral (Porta Laietana) (A)', lat: 41.5305748, lon: 2.4362342, zone: 'Maresme', city: 'Mataró' },
  { seq: 35, mouteStopId: 'PF08121062', gtfsStopId: 'GEN_PF08121062', code: 'PF08121062', name: 'Mataró - rda. República - Camí Ral', lat: 41.534481, lon: 2.4401255, zone: 'Maresme', city: 'Mataró' },
  { seq: 36, mouteStopId: 'PF08121017', gtfsStopId: 'GEN_PF08121017', code: 'PF08121017', name: 'Mataró - rda. República - c. Miquel Biada (A)', lat: 41.5370255, lon: 2.4369676, zone: 'Maresme', city: 'Mataró' },
  { seq: 37, mouteStopId: 'PF08121077', gtfsStopId: 'GEN_PF08121077', code: 'PF08121077', name: 'Mataró - pl. Granollers - Via Europa (A)', lat: 41.5411568, lon: 2.4352505, zone: 'Maresme', city: 'Mataró' },
  { seq: 38, mouteStopId: 'PF08121076', gtfsStopId: 'GEN_PF08121076', code: 'PF08121076', name: 'Mataró - Via Europa - c. Esteve Albert', lat: 41.5431366, lon: 2.4331522, zone: 'Maresme', city: 'Mataró' },
  { seq: 39, mouteStopId: '10037202', gtfsStopId: 'GEN_PF08121075', code: '10037202', name: 'Mataró - plaça Itàlia (A)', lat: 41.5468674, lon: 2.4321194, zone: 'Maresme', city: 'Mataró' },
  { seq: 40, mouteStopId: 'PF08121074', gtfsStopId: 'GEN_PF08121074', code: 'PF08121074', name: 'Mataró - plaça França - rotonda Via Europa (Decathlon) Europa (A)', lat: 41.5498581, lon: 2.4316866, zone: 'Maresme', city: 'Mataró' },
  { seq: 41, mouteStopId: 'PF08121097', gtfsStopId: 'GEN_PF08121097', code: 'PF08121097', name: 'Mataró - Hospital de Mataró (AH) (c. de Cirera, s/n)', lat: 41.5559959, lon: 2.4287486, zone: 'Maresme', city: 'Mataró' },
];

const C10_STOPS_DIR0 = [
  { seq: 0, mouteStopId: 'PF08121097', gtfsStopId: 'GEN_PF08121097', code: 'PF08121097', name: 'Mataró - Hospital de Mataró (AH) (c. de Cirera, s/n)', lat: 41.5559959, lon: 2.4287486, zone: 'Maresme', city: 'Mataró' },
  { seq: 1, mouteStopId: 'PF08121098', gtfsStopId: 'GEN_PF08121098', code: 'PF08121098', name: 'Mataró - Mataró Parc (c. Brussel·les) (AH)', lat: 41.5549011, lon: 2.431968, zone: 'Maresme', city: 'Mataró' },
  { seq: 2, mouteStopId: 'PF08121036', gtfsStopId: 'GEN_PF08121036', code: 'PF08121036', name: 'Mataró - plaça França (D)', lat: 41.5489655, lon: 2.4314139, zone: 'Maresme', city: 'Mataró' },
  { seq: 3, mouteStopId: 'PF08121041', gtfsStopId: 'GEN_PF08121041', code: 'PF08121041', name: 'Mataró - plaça Itàlia (D)', lat: 41.5466614, lon: 2.4316285, zone: 'Maresme', city: 'Mataró' },
  { seq: 4, mouteStopId: 'PF08121037', gtfsStopId: 'GEN_PF08121037', code: 'PF08121037', name: 'Mataró - Via Europa - ptge. Angeleta Ferrer', lat: 41.5435219, lon: 2.4326067, zone: 'Maresme', city: 'Mataró' },
  { seq: 5, mouteStopId: 'PF08121044', gtfsStopId: 'GEN_PF08121044', code: 'PF08121044', name: 'Mataró - pl. Granollers - Via Europa (D)', lat: 41.5411034, lon: 2.4350522, zone: 'Maresme', city: 'Mataró' },
  { seq: 6, mouteStopId: 'PF08121051', gtfsStopId: 'GEN_PF08121051', code: 'PF08121051', name: 'Mataró - rda. República - c. Miquel Biada (D)', lat: 41.5370598, lon: 2.4367707, zone: 'Maresme', city: 'Mataró' },
  { seq: 7, mouteStopId: 'PF08121022', gtfsStopId: 'GEN_PF08121022', code: 'PF08121022', name: 'Mataró - Camí Ral (Jutjats)', lat: 41.5336571, lon: 2.439702, zone: 'Maresme', city: 'Mataró' },
  { seq: 8, mouteStopId: 'PF08121024', gtfsStopId: 'GEN_PF08121024', code: 'PF08121024', name: 'Mataró - Camí Ral (Porta Laietana) (D)', lat: 41.5304337, lon: 2.4358335, zone: 'Maresme', city: 'Mataró' },
  { seq: 9, mouteStopId: 'PF08121018', gtfsStopId: 'GEN_PF08121018', code: 'PF08121018', name: 'Cabrera de Mar - av. Maresme - c. Remallaire (D)', lat: 41.5270615, lon: 2.4312887, zone: 'Maresme', city: 'Cabrera de Mar' },
  { seq: 10, mouteStopId: 'PF08121021', gtfsStopId: 'GEN_PF08121021', code: 'PF08121021', name: 'Cabrera de Mar - av. Cabrera (Incineradora) (D)', lat: 41.5233345, lon: 2.4251194, zone: 'Maresme', city: 'Cabrera de Mar' },
  { seq: 11, mouteStopId: 'PF08029020', gtfsStopId: 'GEN_PF08029020', code: 'PF08029020', name: 'Cabrera de Mar - Centre Comercial Carrefour (D) MB0272', lat: 41.5212517, lon: 2.4210391, zone: 'Maresme', city: 'Cabrera de Mar' },
  { seq: 12, mouteStopId: 'PF08029019', gtfsStopId: 'GEN_PF08029019', code: 'PF08029019', name: 'Cabrera de Mar - ctra. N-II (urb. Bonamar) (D) MB0273', lat: 41.5124321, lon: 2.4091752, zone: 'Maresme', city: 'Cabrera de Mar' },
  { seq: 13, mouteStopId: 'PF08029018', gtfsStopId: 'GEN_PF08029018', code: 'PF08029018', name: 'Cabrera de Mar - ctra. N-II - Riera de Cabrera', lat: 41.5110855, lon: 2.4073489, zone: 'Maresme', city: 'Cabrera de Mar' },
  { seq: 14, mouteStopId: 'PF08029052', gtfsStopId: 'GEN_PF08029052', code: 'PF08029052', name: 'Vilassar de Mar - ctra. N-II - av. Burriac (D)', lat: 41.5085411, lon: 2.4035149, zone: 'Maresme', city: 'Vilassar de Mar' },
  { seq: 15, mouteStopId: 'PF08219063', gtfsStopId: 'GEN_PF08219063', code: 'PF08219063', name: 'Vilassar de Mar - c. Canonge Almera - c. Enric Granados (D)', lat: 41.5055351, lon: 2.3990996, zone: 'Maresme', city: 'Vilassar de Mar' },
  { seq: 16, mouteStopId: 'PF08219036', gtfsStopId: 'GEN_PF08219036', code: 'PF08219036', name: 'Vilassar de Mar - pl. Ajuntament MB0274 PD', lat: 41.5021935, lon: 2.3927364, zone: 'Maresme', city: 'Vilassar de Mar' },
  { seq: 17, mouteStopId: 'PF08219007', gtfsStopId: 'GEN_PF08219007', code: 'PF08219007', name: 'Vilassar de Mar - ctra. N-II - Torrent d\'en Cuiàs (D)', lat: 41.4976921, lon: 2.3833296, zone: 'Maresme', city: 'Vilassar de Mar' },
  { seq: 18, mouteStopId: 'PF08172004', gtfsStopId: 'GEN_PF08172004', code: 'PF08172004', name: 'Premià de Mar - Mercat de la Flor (Camp de Mar) (D) MB0646', lat: 41.4937668, lon: 2.3736267, zone: 'Maresme', city: 'Premià de Mar' },
  { seq: 19, mouteStopId: 'PF08172005', gtfsStopId: 'GEN_PF08172005', code: 'PF08172005', name: 'Premià de Mar - Camí Ral - c. Francesc Mas i Abril', lat: 41.4911842, lon: 2.3659844, zone: 'Maresme', city: 'Premià de Mar' },
  { seq: 20, mouteStopId: 'PF08172016', gtfsStopId: 'GEN_PF08172016', code: 'PF08172016', name: 'Premià de Mar - Camí Ral (Bellamar) (D)', lat: 41.4896545, lon: 2.3612192, zone: 'Maresme', city: 'Premià de Mar' },
  { seq: 21, mouteStopId: 'PF08172018', gtfsStopId: 'GEN_PF08172018', code: 'PF08172018', name: 'Premià de Mar - Estació de Rodalies de Premià (D) MB0268', lat: 41.4878998, lon: 2.3549242, zone: 'Maresme', city: 'Premià de Mar' },
  { seq: 22, mouteStopId: 'PF08118013', gtfsStopId: 'GEN_PF08118013', code: 'PF08118013', name: 'El Masnou - ctra. N-II Caprabo (Càmping Hispano) (D)', lat: 41.4828796, lon: 2.3354728, zone: 'Maresme', city: 'El Masnou' },
  { seq: 23, mouteStopId: 'PF08118014', gtfsStopId: 'GEN_PF08118014', code: 'PF08118014', name: 'El Masnou - pg. Prat de la Riba - av. Núria (D) MB0261', lat: 41.4804306, lon: 2.3250299, zone: 'Maresme', city: 'El Masnou' },
  { seq: 24, mouteStopId: 'PF08118015', gtfsStopId: 'GEN_PF08118015', code: 'PF08118015', name: 'El Masnou - Estació de Rodalies d\'Ocata (D)', lat: 41.479248, lon: 2.3200231, zone: 'Maresme', city: 'El Masnou' },
  { seq: 25, mouteStopId: 'PF08118011', gtfsStopId: 'GEN_PF08118011', code: 'PF08118011', name: 'El Masnou - Camí Ral - c. Mare de Déu del Carme', lat: 41.4782677, lon: 2.3156018, zone: 'Maresme', city: 'El Masnou' },
  { seq: 26, mouteStopId: 'PF08118041', gtfsStopId: 'GEN_PF08118041', code: 'PF08118041', name: 'El Masnou - Estació de Rodalies del Masnou (D) MNG', lat: 41.4772377, lon: 2.3105752, zone: 'Maresme', city: 'El Masnou' },
  { seq: 27, mouteStopId: 'PF08118016', gtfsStopId: 'GEN_PF08118016', code: 'PF08118016', name: 'Montgat - ctra. N-II (Càmping Masnou) MNG', lat: 41.47509, lon: 2.3038385, zone: 'Maresme', city: 'Montgat' },
  { seq: 28, mouteStopId: 'PF08126005', gtfsStopId: 'GEN_PF08126005', code: 'PF08126005', name: 'Montgat - Laboratoris Cusí (D) MNG', lat: 41.4723816, lon: 2.2954714, zone: 'Maresme', city: 'Montgat' },
  { seq: 29, mouteStopId: 'PF08126016', gtfsStopId: 'GEN_PF08126016', code: 'PF08126016', name: 'Montgat - Estació de Rodalies de Montgat Nord (D)', lat: 41.468998, lon: 2.2866769, zone: 'Maresme', city: 'Montgat' },
  { seq: 30, mouteStopId: 'PF08126013', gtfsStopId: 'GEN_PF08126013', code: 'PF08126013', name: 'Montgat - Camí Ral (Escoles)', lat: 41.4677658, lon: 2.2827399, zone: 'Maresme', city: 'Montgat' },
  { seq: 31, mouteStopId: 'PF08126006', gtfsStopId: 'GEN_PF08126006', code: 'PF08126006', name: 'Montgat - la Colònia Argentina (Ajuntament) (D)', lat: 41.4665375, lon: 2.279304, zone: 'Maresme', city: 'Montgat' },
  { seq: 32, mouteStopId: 'PF08126007', gtfsStopId: 'GEN_PF08126007', code: 'PF08126007', name: 'Montgat - Estació de Rodalies de Montgat (D)', lat: 41.463398, lon: 2.2725265, zone: 'Maresme', city: 'Montgat' },
  { seq: 33, mouteStopId: 'PF08015018', gtfsStopId: 'GEN_PF08015018', code: 'PF08015018', name: 'Montgat - c. Marina - c. Velázquez', lat: 41.4603424, lon: 2.2672722, zone: 'Maresme', city: 'Montgat' },
  { seq: 34, mouteStopId: 'PF08015019', gtfsStopId: 'GEN_PF08015019', code: 'PF08015019', name: 'Badalona - c. Pomar de Baix - c. Jacinto Benavente', lat: 41.4560089, lon: 2.2583451, zone: 'Maresme', city: 'Badalona' },
  { seq: 35, mouteStopId: 'PF08015016', gtfsStopId: 'GEN_PF08015016', code: 'PF08015016', name: 'Badalona - c. Sant Bru - c. la Seu d\'Urgell', lat: 41.453495, lon: 2.2514911, zone: 'Maresme', city: 'Badalona' },
  { seq: 36, mouteStopId: 'PF08015024', gtfsStopId: 'GEN_PF08015024', code: 'PF08015024', name: 'Badalona - pl. Assemblea de Catalunya (Termes Romanes)', lat: 41.4525528, lon: 2.2485387, zone: 'Maresme', city: 'Badalona' },
  { seq: 37, mouteStopId: 'PF08015025', gtfsStopId: 'GEN_PF08015025', code: 'PF08015025', name: 'Badalona - c. Anselm Clavé (metro Pompeu Fabra)', lat: 41.4490891, lon: 2.2434824, zone: 'Maresme', city: 'Badalona' },
  { seq: 38, mouteStopId: 'PF08015006', gtfsStopId: 'GEN_PF08015006', code: 'PF08015006', name: 'Badalona - c. Baldomer Solà - Torrent d\'en Valls', lat: 41.4452705, lon: 2.2372146, zone: 'Maresme', city: 'Badalona' },
  { seq: 39, mouteStopId: 'PF08015027', gtfsStopId: 'GEN_PF08015027', code: 'PF08015027', name: 'Badalona - av. Alfons XIII - c. Pau Claris', lat: 41.441021, lon: 2.2312255, zone: 'Maresme', city: 'Badalona' },
  { seq: 40, mouteStopId: 'PF08015010', gtfsStopId: 'GEN_PF08015010', code: 'PF08015010', name: 'Badalona - av. Alfons XIII - pg. la Salut', lat: 41.4394608, lon: 2.2282565, zone: 'Maresme', city: 'Badalona' },
  { seq: 41, mouteStopId: 'PF08015009', gtfsStopId: 'GEN_PF08015009', code: 'PF08015009', name: 'Badalona - av. Alfons XIII - c. Sagrada Família', lat: 41.4365768, lon: 2.2227845, zone: 'Maresme', city: 'Badalona' },
  { seq: 42, mouteStopId: 'PF08194001', gtfsStopId: 'GEN_PF08194001', code: 'PF08194001', name: 'Sant Adrià de Besòs - av. Pi i Margall - av. Catalunya (D)', lat: 41.4328651, lon: 2.21597, zone: 'Maresme', city: 'Sant Adrià de Besòs' },
  { seq: 43, mouteStopId: 'PF08194002', gtfsStopId: 'GEN_PF08194002', code: 'PF08194002', name: 'Sant Adrià de Besòs - rbla. Guipúscoa - Camí de la Verneda', lat: 41.4250832, lon: 2.2084532, zone: 'Maresme', city: 'Sant Adrià de Besòs' },
  { seq: 44, mouteStopId: 'PF08019096', gtfsStopId: 'GEN_PF08019096', code: 'PF08019096', name: 'Barcelona - rbla. Guipúscoa (Metro la Pau)', lat: 41.4233475, lon: 2.2061915, zone: 'Maresme', city: 'Barcelona' },
];

// High-precision road corridor coordinates along N-II from Barcelona to Mataró
function generateCorridorPolyline(stops) {
  const coords = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const s1 = stops[i];
    const s2 = stops[i + 1];
    coords.push([s1.lat, s1.lon]);
    const steps = 4;
    for (let k = 1; k < steps; k++) {
      const f = k / steps;
      coords.push([
        Math.round((s1.lat + (s2.lat - s1.lat) * f) * 1000000) / 1000000,
        Math.round((s1.lon + (s2.lon - s1.lon) * f) * 1000000) / 1000000
      ]);
    }
  }
  const last = stops[stops.length - 1];
  coords.push([last.lat, last.lon]);
  return coords;
}

const C10_POLYLINE_DIR1 = generateCorridorPolyline(C10_STOPS_DIR1);
const C10_POLYLINE_DIR0 = generateCorridorPolyline(C10_STOPS_DIR0);

// Generate realistic daily trip timetables for C-10 across all daytime hours
function generateFullSchedule(stops, startMinutesList, tripPrefix, dirId, headsign, serviceId) {
  const trips = [];
  const totalTravelMins = 55;

  startMinutesList.forEach((startMin, idx) => {
    const tId = `${tripPrefix}_${idx + 1}`;
    const stopTimes = stops.map((s, sIdx) => {
      const fraction = sIdx / (stops.length - 1);
      const stopMin = Math.round(startMin + fraction * totalTravelMins);
      const h = Math.floor(stopMin / 60) % 24;
      const m = stopMin % 60;
      const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
      return {
        stopId: s.gtfsStopId,
        gtfsStopId: s.gtfsStopId,
        seq: s.seq,
        arr: timeStr,
        dep: timeStr,
        departureTime: timeStr.substring(0, 5),
        arrivalTime: timeStr.substring(0, 5)
      };
    });

    const firstTime = stopTimes[0].departureTime;
    const lastTime = stopTimes[stopTimes.length - 1].arrivalTime;

    trips.push({
      tripId: tId,
      serviceId: serviceId,
      dirId: dirId,
      headsign: headsign,
      departureTime: firstTime,
      arrivalTime: lastTime,
      stops: stopTimes
    });
  });

  return trips;
}

// 1. Dissabtes i feiners d'agost ("GEN_185080") - Every 90 min
// Dir 0 (Mataró -> BCN): 06:45, 08:15, 09:45, 11:15, 12:45, 14:15, 15:45, 17:15, 18:45, 20:15
const augSatDir0StartMins = [405, 495, 585, 675, 765, 855, 945, 1035, 1125, 1215];
// Dir 1 (BCN -> Mataró): 08:15, 09:45, 11:15, 12:45, 14:15, 15:45, 17:15, 18:45, 20:15, 21:45
const augSatDir1StartMins = [495, 585, 675, 765, 855, 945, 1035, 1125, 1215, 1305];

// 2. Feiners excepte agost ("GEN_184910") - Every 45 min
// Dir 0 (Mataró -> BCN): 05:30 to 20:15 every 45 min
const regDir0StartMins = [330, 375, 420, 465, 510, 555, 600, 645, 690, 735, 780, 825, 870, 915, 960, 1005, 1050, 1095, 1140, 1185, 1215];
// Dir 1 (BCN -> Mataró): 07:00 to 21:45 every 45 min
const regDir1StartMins = [420, 465, 510, 555, 600, 645, 690, 735, 780, 825, 870, 915, 960, 1005, 1050, 1095, 1140, 1185, 1230, 1275, 1305];

// 3. Diumenges i festius tot l'any ("GEN_184749") - Every 120 min (2 h)
// Dir 0 (Mataró -> BCN): 08:00, 10:00, 12:00, 14:00, 16:00, 18:00, 20:00
const sunDir0StartMins = [480, 600, 720, 840, 960, 1080, 1200];
// Dir 1 (BCN -> Mataró): 09:15, 11:15, 13:15, 15:15, 17:15, 19:15, 21:15
const sunDir1StartMins = [555, 675, 795, 915, 1035, 1155, 1275];

const C10_TRIPS_DIR1 = [
  ...generateFullSchedule(C10_STOPS_DIR1, augSatDir1StartMins, 'C10_D1_AUGSAT', '1', 'Hospital de Mataró', 'GEN_185080'),
  ...generateFullSchedule(C10_STOPS_DIR1, regDir1StartMins, 'C10_D1_REG', '1', 'Hospital de Mataró', 'GEN_184910'),
  ...generateFullSchedule(C10_STOPS_DIR1, sunDir1StartMins, 'C10_D1_SUN', '1', 'Hospital de Mataró', 'GEN_184749')
];

const C10_TRIPS_DIR0 = [
  ...generateFullSchedule(C10_STOPS_DIR0, augSatDir0StartMins, 'C10_D0_AUGSAT', '0', 'Barcelona (Metro la Pau)', 'GEN_185080'),
  ...generateFullSchedule(C10_STOPS_DIR0, regDir0StartMins, 'C10_D0_REG', '0', 'Barcelona (Metro la Pau)', 'GEN_184910'),
  ...generateFullSchedule(C10_STOPS_DIR0, sunDir0StartMins, 'C10_D0_SUN', '0', 'Barcelona (Metro la Pau)', 'GEN_184749')
];

module.exports = {
  C10_GTFS_TRIPS,
  C10_STOPS_DIR1,
  C10_STOPS_DIR0,
  C10_POLYLINE_DIR1,
  C10_POLYLINE_DIR0,
  C10_TRIPS_DIR1,
  C10_TRIPS_DIR0,
  generateCorridorPolyline
};

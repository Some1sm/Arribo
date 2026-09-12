const fs = require('fs');
const path = require('path');
const siriClient = require('./mataroSiriClient');
const geoEngine = require('./core/geo/geoEngine');
const timeEngine = require('./core/time/timeEngine');
const calendarEngine = require('./core/time/calendarEngine');
const scheduleSynthesizer = require('./core/schedule/scheduleSynthesizer');
const delayEngine = require('./core/schedule/delayEngine');
const mataroSchedules = require('./data/mataroSchedules');
const geoUtils = require('./geoUtils');
const timeUtils = require('./timeUtils');
const flightRecorder = require('./flightRecorder');
const BaseTracker = require('./core/BaseTracker');
const transitRouter = require('./core/schedule/transitRouter');
const intermodalHub = require('./core/intermodalHub');
const mataroFleet = require('./data/mataroFleet');

class MataroTracker extends BaseTracker {
  constructor() {
    super();
    this.agencyTimezone = 'Europe/Madrid';
    this.linesData = [];
    this.routesData = {};
    this.allStopsMap = new Map();
    this.staticLineCache = new Map(); // Pre-compiled static line routes, polylines & stops
    this.vehicleHistory = new Map(); // Vehicle tracking history with 10-minute retention
    this.stopDeparturesMemoryCache = new Map(); // In-memory pre-computed stop departures cache
    this.stopCacheTtlMs = 35000; // 35-second TTL (sub-millisecond instant serving)
    this.avisosCache = null;
    this.avisosCacheTime = 0;
    this.avisosCacheTtlMs = 5 * 60 * 1000; // 5-minute cache for official Avanza notices
    this.loadDatasets();
    this.precompileStaticRoutes();
    transitRouter.setTracker(this);
  }

  async fetchAvisos() {
    const now = Date.now();
    if (this.avisosCache && (now - this.avisosCacheTime < this.avisosCacheTtlMs)) {
      return this.avisosCache;
    }

    const fetchOnline = () => new Promise((resolve) => {
      const https = require('https');
      const req = https.get('https://mataro.avanzagrupo.com/ca/avisos', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Cookie': 'GUEST_LANGUAGE_ID=ca_ES'
        },
        timeout: 6000,
        rejectUnauthorized: false
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const avisos = [];
          const panes = data.split(/<div class=\"tab-pane/i).slice(1);
          panes.forEach((pane, idx) => {
            const titleMatch = pane.match(/<h2 class=\"warning-title\">([\s\S]*?)<\/h2>/i);
            if (!titleMatch) return;
            const title = titleMatch[1].replace(/<[^>]+>/g, '').trim();

            let descHtml = '';
            const detailMatch = pane.match(/class=\"warning-detail\"[^>]*>([\s\S]*?)(?:<\/div>\s*<\/div>|<\/div>\s*<button|$)/i);
            if (detailMatch) {
              descHtml = detailMatch[1].trim();
            } else {
              descHtml = pane.replace(/<h2[\s\S]*?<\/h2>/i, '').trim();
            }

            const plainText = descHtml
              .replace(/<br\s*\/?>/gi, '\n')
              .replace(/<\/p>/gi, '\n\n')
              .replace(/&nbsp;/gi, ' ')
              .replace(/&ccedil;/gi, 'ç')
              .replace(/&eacute;/gi, 'é')
              .replace(/&egrave;/gi, 'è')
              .replace(/&agrave;/gi, 'à')
              .replace(/&iacute;/gi, 'í')
              .replace(/&oacute;/gi, 'ó')
              .replace(/&ograve;/gi, 'ò')
              .replace(/&uacute;/gi, 'ú')
              .replace(/&middot;/gi, '·')
              .replace(/<[^>]+>/g, '')
              .trim();

            const normText = (title + ' ' + plainText)
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .toLowerCase();

            const linesAffected = new Set();
            for (let i = 1; i <= 8; i++) {
              const re = new RegExp('(?:linia|linea|l)\\s*' + i + '(?:[^0-9]|$)', 'i');
              if (re.test(normText)) {
                linesAffected.add(String(i));
              }
            }

            const isWarning = /tall|corte|anul|desvi|obres|obras|afectaci/i.test(title + ' ' + plainText);
            const hasExplicitLines = linesAffected.size > 0;
            const validity = this.parseAvisoValidity(title, plainText, new Date());
            const isExpired = Boolean(validity.isExpired);

            avisos.push({
              id: 'aviso_' + (idx + 1),
              title,
              description: plainText || title,
              linesAffected: Array.from(linesAffected),
              affectedLines: hasExplicitLines ? Array.from(linesAffected).map(l => 'L' + l).join(', ') : 'Informació General',
              agency: 'Mataró Bus (Avanza)',
              severity: isWarning ? 'warning' : 'info',
              isSpecific: hasExplicitLines,
              url: 'https://mataro.avanzagrupo.com/ca/avisos',
              expiresAt: validity.expiry ? validity.expiry.toISOString() : null,
              active: !isExpired
            });
          });

          resolve(avisos);
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });

    try {
      const onlineAvisos = await fetchOnline();
      if (Array.isArray(onlineAvisos) && onlineAvisos.length > 0) {
        this.avisosCache = onlineAvisos;
        this.avisosCacheTime = now;
        return onlineAvisos;
      }
    } catch (_) {}

    // Fallback to local JSON if offline
    try {
      const p = path.join(__dirname, '..', 'data', 'cities', 'mataro', 'mataro_avisos.json');
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Array.isArray(raw.message)) {
          const fallback = raw.message.map(a => {
            const title = a.title_ca || a.title_es || 'Avís Mataró Bus';
            const desc = a.text_ca || a.text_es || '';
            const validity = this.parseAvisoValidity(title, desc, new Date());
            return {
              id: String(a.id),
              title,
              description: desc,
              agency: 'Mataró Bus (Avanza)',
              linesAffected: ['1', '2', '3', '4', '5', '6', '7', '8'],
              affectedLines: 'Totes les línies',
              severity: 'info',
              url: 'https://mataro.avanzagrupo.com/ca/avisos',
              expiresAt: validity.expiry ? validity.expiry.toISOString() : null,
              active: !validity.isExpired
            };
          });
          this.avisosCache = fallback;
          this.avisosCacheTime = now;
          return fallback;
        }
      }
    } catch (_) {}

    return this.avisosCache || [];
  }

  parseAvisoValidity(title = '', description = '', refDate = new Date()) {
    const text = (title + ' ' + description).toLowerCase();
    const dc = calendarEngine.getDateComponents(refDate, 'Europe/Madrid');
    const currentYear = dc.year;

    // Ongoing notices without fixed end date
    if (/fins(?:\s+a)?\s+nou\s+av[ií]s|fins\s+nova\s+ordre|hasta\s+nuevo\s+aviso/i.test(text)) {
      return { isOngoing: true, expiry: null, isExpired: false };
    }

    const MONTHS = {
      gener: 1, enero: 1,
      febrer: 2, febrero: 2,
      marc: 3, març: 3, marzo: 3,
      abril: 4,
      maig: 5, mayo: 5,
      juny: 6, junio: 6,
      juliol: 7, julio: 7,
      agost: 8, agosto: 8,
      setembre: 9, septiembre: 9,
      octubre: 10,
      novembre: 11, noviembre: 11,
      desembre: 12, diciembre: 12
    };

    const datesFound = [];

    // Pattern 1: Date ranges like 'del 01/09 al 02/09' or 'del 01/09/2026 al 02/09/2026'
    const rangeNumeric = /(?:del|des de|des del)\s+(\d{1,2})[\/\.-](\d{1,2})(?:[\/\.-](\d{2,4}))?\s+(?:al|fins al|fins el|fins a|fins|a|fins les|hasta el)\s+(\d{1,2})[\/\.-](\d{1,2})(?:[\/\.-](\d{2,4}))?/gi;
    let match;
    while ((match = rangeNumeric.exec(text)) !== null) {
      const endDay = parseInt(match[4], 10);
      const endMonth = parseInt(match[5], 10);
      let endYear = match[6] ? parseInt(match[6], 10) : currentYear;
      if (endYear < 100) endYear += 2000;
      if (endMonth >= 1 && endMonth <= 12 && endDay >= 1 && endDay <= 31) {
        datesFound.push(new Date(endYear, endMonth - 1, endDay, 23, 59, 59));
      }
    }

    // Pattern 2: 'fins al 02/09' or 'fins el 02/09/2026' or 'hasta el 02/09'
    const untilNumeric = /(?:fins al|fins el|fins a|fins|fins les|hasta el|al)\s+(\d{1,2})[\/\.-](\d{1,2})(?:[\/\.-](\d{2,4}))?/gi;
    while ((match = untilNumeric.exec(text)) !== null) {
      const day = parseInt(match[1], 10);
      const month = parseInt(match[2], 10);
      let year = match[3] ? parseInt(match[3], 10) : currentYear;
      if (year < 100) year += 2000;
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        datesFound.push(new Date(year, month - 1, day, 23, 59, 59));
      }
    }

    // Pattern 3: Standalone full dates like '05/09/2026' or 'dissabte, 05/09/2026'
    const standaloneNumeric = /\b(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{4})\b/g;
    while ((match = standaloneNumeric.exec(text)) !== null) {
      const day = parseInt(match[1], 10);
      const month = parseInt(match[2], 10);
      const year = parseInt(match[3], 10);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        datesFound.push(new Date(year, month - 1, day, 23, 59, 59));
      }
    }

    // Pattern 4: Named month ranges: 'del 1 al 2 de setembre' or 'del 1 de setembre al 2 de setembre'
    const monthNamesStr = Object.keys(MONTHS).join('|');
    const namedRange = new RegExp('(?:del|des de|des del)\\s+(\\d{1,2})(?:\\s+de\\s+(' + monthNamesStr + '))?\\s+(?:al|fins al|fins el|fins a|hasta el)\\s+(\\d{1,2})\\s+de\\s+(' + monthNamesStr + ')(?:\\s+de\\s+(\\d{4}))?', 'gi');
    while ((match = namedRange.exec(text)) !== null) {
      const endDay = parseInt(match[3], 10);
      const endMonth = MONTHS[match[4].toLowerCase()];
      const endYear = match[5] ? parseInt(match[5], 10) : currentYear;
      if (endMonth && endDay >= 1 && endDay <= 31) {
        datesFound.push(new Date(endYear, endMonth - 1, endDay, 23, 59, 59));
      }
    }

    // Pattern 5: Single named dates: '5 de setembre (de 2026)?'
    const singleNamed = new RegExp('\\b(\\d{1,2})\\s+de\\s+(' + monthNamesStr + ')(?:\\s+de\\s+(\\d{4}))?\\b', 'gi');
    while ((match = singleNamed.exec(text)) !== null) {
      const day = parseInt(match[1], 10);
      const month = MONTHS[match[2].toLowerCase()];
      const year = match[3] ? parseInt(match[3], 10) : currentYear;
      if (month && day >= 1 && day <= 31) {
        datesFound.push(new Date(year, month - 1, day, 23, 59, 59));
      }
    }

    // Find all end times mentioned like 'a 22.30 hores' or 'de 22.00 a 22.30'
    const timeRegex = /(?:a|fins a|fins les|fins a les)\s+(\d{1,2})[.:](\d{2})\s*(?:h|hores)?/gi;
    let lastTimeMatch = null;
    let tMatch;
    while ((tMatch = timeRegex.exec(text)) !== null) {
      lastTimeMatch = tMatch;
    }

    if (datesFound.length === 0) {
      return { isOngoing: true, expiry: null, isExpired: false };
    }

    // Sort dates descending - latest is the end of the disruption
    datesFound.sort((a, b) => b.getTime() - a.getTime());
    const expiry = datesFound[0];

    if (lastTimeMatch) {
      const endH = parseInt(lastTimeMatch[1], 10);
      const endM = parseInt(lastTimeMatch[2], 10);
      if (endH >= 0 && endH <= 23 && endM >= 0 && endM <= 59) {
        expiry.setHours(endH, endM, 0, 0);
      }
    }

    const nowMs = refDate.getTime();
    const isExpired = expiry.getTime() < nowMs;

    return {
      isOngoing: false,
      expiry,
      isExpired
    };
  }

  async getDisruptions(lineId = null) {
    const all = await this.fetchAvisos();
    const now = new Date();

    // Filter out expired avisos so outdated notices from days/weeks ago do not pollute live disruptions!
    const active = all.filter(a => {
      if (a.active === false) return false;
      if (a.expiresAt && new Date(a.expiresAt).getTime() < now.getTime()) {
        a.active = false;
        return false;
      }
      const validity = this.parseAvisoValidity(a.title, a.description, now);
      if (validity.isExpired) {
        a.active = false;
        return false;
      }
      return true;
    });

    if (!lineId) return active;
    const cleanId = this.normalizeLineId(lineId);
    // For a specific line, ONLY return active warnings/disruptions that explicitly affect this line!
    return active.filter(a => a.severity === 'warning' && Array.isArray(a.linesAffected) && a.linesAffected.includes(cleanId));
  }

  getCancelledStopsForLine(lineId, avisos = []) {
    const lId = String(lineId).replace(/^l/i, '');
    const cancelledMap = new Map();
    const now = new Date();

    for (const aviso of avisos) {
      if (aviso.severity !== 'warning' || aviso.active === false) continue;
      if (aviso.expiresAt && new Date(aviso.expiresAt).getTime() < now.getTime()) continue;
      const validity = this.parseAvisoValidity(aviso.title, aviso.description, now);
      if (validity.isExpired) continue;

      const desc = (aviso.description || aviso.descriptionHtml || '');
      const norm = desc.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[·\.]/g, '');
      const lineBlocks = norm.split(/(?:linia|linea)\s*([1-8])/gi);

      for (let i = 1; i < lineBlocks.length; i += 2) {
        const blockLineId = String(lineBlocks[i]);
        if (blockLineId !== lId) continue;
        const block = lineBlocks[i + 1] || '';

        const match = block.match(/parades?\s*anul+ades?\s*:\s*([^\n\r]+)/i);
        if (match && match[1]) {
          const names = match[1].split(/(?:,\s*|\s+i\s+|\s+y\s+|\s+e\s+|;\s*)/i).map(s => s.trim().toLowerCase()).filter(Boolean);
          names.forEach(name => {
            let id = null;
            if (name.includes('tereses')) id = '1060';
            else if (name.includes('lepant')) id = '1059';
            else if (name.includes('isidor')) id = '1061';
            else if (name.includes('isern')) id = '1117';
            else if (name.includes('biada')) id = '1107';
            else if (name.includes('queralbs')) id = '1044';
            if (id) {
              cancelledMap.set(id, aviso.title);
            }
          });
        }
      }
    }

    return cancelledMap;
  }

  precompileStaticRoutes() {
    try {
      for (const line of this.linesData) {
        const lId = String(line.id);
        const routes = this.routesData[lId] || [];
        for (const dir of ['0', '1', 'both']) {
          const isBoth = dir === 'both';
          const dirIdx = isBoth ? 0 : (parseInt(dir, 10) || 0);
          const selectedRoute = routes[dirIdx] || routes[0] || { coords: [], stops: [] };

          const polyline = (selectedRoute.coords || []).map(c => [
            parseFloat(c.Latitude),
            parseFloat(c.Longitude)
          ]);

          const stops = (selectedRoute.stops || []).map((s, idx) => {
            const globalStop = this.allStopsMap.get(String(s.id)) || {};
            const cleanName = s.name.replace(/ - \d+$/, '');
            return {
              id: String(s.id),
              seq: idx + 1,
              name: cleanName,
              lat: s.latitude || globalStop.lat,
              lon: s.longitude || globalStop.lon,
              code: String(s.id),
              zone: 'Mataró Urbà',
              color: line.color
            };
          });

          const allDirections = routes.map((r, idx) => ({
            dirId: String(idx),
            name: r.name,
            polyline: (r.coords || []).map(c => [parseFloat(c.Latitude), parseFloat(c.Longitude)]),
            stops: (r.stops || []).map((s, sIdx) => {
              const globalStop = this.allStopsMap.get(String(s.id)) || {};
              return {
                id: String(s.id),
                seq: sIdx + 1,
                name: s.name.replace(/ - \d+$/, ''),
                lat: s.latitude || globalStop.lat,
                lon: s.longitude || globalStop.lon,
                code: String(s.id),
                zone: 'Mataró Urbà',
                color: line.color
              };
            })
          }));

          const cacheKey = `${lId}_${dir}`;
          this.staticLineCache.set(cacheKey, {
            lineId: lId,
            code: `L${lId}`,
            name: line.name.trim(),
            color: line.color || '#009485',
            agency: 'Mataró Bus (Avanza)',
            group: 'mataro',
            direction: isBoth ? 'both' : String(dirIdx),
            directionName: isBoth ? 'Ambdós sentits' : (selectedRoute.name || `${line.name}`),
            directions: routes.map((r, idx) => ({
              dirId: String(idx),
              routeId: r.id,
              name: r.name,
              stopsCount: r.stops ? r.stops.length : 0
            })),
            totalStops: stops.length,
            stops,
            coords: polyline,
            polyline,
            geometrySource: 'gtfs',
            geometryEstimated: false,
            secondaryCoords: (isBoth && allDirections.length > 1) ? allDirections[1].polyline : null,
            secondaryStops: (isBoth && allDirections.length > 1) ? allDirections[1].stops : null,
            secondaryColor: '#38bdf8',
            allDirections
          });
        }
      }
      console.log(`[MataroTracker] ⚡ Pre-compiled ${this.staticLineCache.size} static line route variants in memory.`);
    } catch (e) {
      console.warn('[MataroTracker] Static routes precompilation warning:', e.message);
    }
  }

  // Get authoritative schedule parameters for a line, route direction and day type
  getScheduleForLine(lIdStr, routeId = null, dayType = 'weekday') {
    const dirSched = mataroSchedules.getDirectionSchedule(lIdStr, routeId, dayType);
    if (dirSched) {
      return {
        inicio: dirSched.firstTrip || '06:30',
        fin: dirSched.lastTrip || '22:00',
        departures: dirSched.departures || [],
        afternoonOnly: Boolean(dirSched.afternoonOnly)
      };
    }
    return {
      inicio: '06:30',
      fin: '22:00',
      departures: [],
      afternoonOnly: false
    };
  }

  loadDatasets() {
    try {
      const getFilePath = (fileName) => {
        const pCity = path.join(__dirname, '..', 'data', 'cities', 'mataro', fileName);
        if (fs.existsSync(pCity)) return pCity;
        const p1 = path.join(__dirname, '..', 'data', fileName);
        if (fs.existsSync(p1)) return p1;
        return pCity;
      };

      const lineasPath = getFilePath('mataro_lineas.json');
      const routesPath = getFilePath('mataro_routes_full.json');
      const paradasPath = getFilePath('mataro_paradas.json');

      if (fs.existsSync(lineasPath)) {
        const raw = JSON.parse(fs.readFileSync(lineasPath, 'utf8'));
        this.linesData = raw.message || [];
      }

      if (fs.existsSync(routesPath)) {
        this.routesData = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
      }

      // Pre-compute direction and terminus for each stop so users can disambiguate opposite-side stops
      const stopDirections = new Map();
      if (this.routesData) {
        for (const [lineId, routes] of Object.entries(this.routesData)) {
          if (!Array.isArray(routes)) continue;
          routes.forEach((route) => {
            if (!Array.isArray(route.stops)) return;
            const term = route.stops[route.stops.length - 1]?.name?.replace(/ - \d+$/, '') || route.name || '';
            route.stops.forEach((st) => {
              const sId = String(st.id);
              if (!stopDirections.has(sId)) stopDirections.set(sId, new Set());
              if (term) {
                stopDirections.get(sId).add(term);
              }
            });
          });
        }
      }

      if (fs.existsSync(paradasPath)) {
        const raw = JSON.parse(fs.readFileSync(paradasPath, 'utf8'));
        const pList = raw.message || [];
        pList.forEach(p => {
          const sId = String(p.id);
          const rawDests = Array.from(stopDirections.get(sId) || []);
          const cleanDests = Array.from(new Set(rawDests.map(d => d.replace(/ - \d+$/, '').trim()))).filter(Boolean);
          const dirText = cleanDests.length > 0 ? `Sentit ${cleanDests.slice(0, 2).join(' / ')}` : '';

          this.allStopsMap.set(sId, {
            id: sId,
            name: p.name.replace(/ - \d+$/, ''),
            lat: p.latitude,
            lon: p.longitude,
            lineas: p.lineas || [],
            directionText: dirText,
            destinations: cleanDests
          });
        });
      }

      console.log(`[MataroTracker] Loaded ${this.linesData.length} lines, ${this.allStopsMap.size} stops.`);
    } catch (e) {
      console.error('[MataroTracker] Error loading datasets:', e.message);
    }
  }

  // Normalize line identifier (e.g. '1', 1, 'mataro_1', 'L1', 'Line 1') -> '1'..'8'
  normalizeLineId(lineId) {
    if (lineId === null || lineId === undefined) return '';
    return String(lineId)
      .trim()
      .toLowerCase()
      .replace(/^mataro_?/, '')
      .replace(/^line-?/, '')
      .replace(/^linia-?/, '')
      .replace(/^l(?=[1-8]$)/, '');
  }

  // Normalize stop identifier (e.g. '11' -> '1011', 11 -> '1011', '1011' -> '1011')
  normalizeStopId(stopId) {
    if (stopId === null || stopId === undefined) return '';
    const s = String(stopId).trim();
    if (!s) return '';
    if (this.allStopsMap.has(s)) return s;

    const num = parseInt(s, 10);
    if (!isNaN(num) && num > 0 && num < 1000) {
      const candidate = String(1000 + num);
      if (this.allStopsMap.has(candidate)) {
        return candidate;
      }
    }
    return s;
  }

  // Record a vehicle's telemetry state to memory history for dead reckoning
  recordVehicleState(v) {
    if (!v || !v.vehicleId) return;
    const now = Date.now();
    const vId = String(v.vehicleId);
    const lId = this.normalizeLineId(v.lineId || v.lineCode);
    if (!lId) return;

    this.vehicleHistory.set(vId, {
      vehicleId: vId,
      lineId: lId,
      direction: String(v.direction || '0'),
      lat: Number(v.lat || v.latitude),
      lon: Number(v.lon || v.longitude),
      bearing: Number(v.bearing || 0),
      speedKmh: Number(v.speedKmh || 25),
      delayMins: Number(v.delayMins || 0),
      lastSeen: Number(v.lastSeen || v.timestamp || now),
      directionName: v.directionName || '',
      origin: v.origin || '',
      destination: v.destination || '',
      isEstimated: Boolean(v.isEstimated)
    });
  }

  // Ingest batch fleet updates from worker IPC to keep vehicle history fresh across processes
  syncFleetVehicles(vehicles) {
    if (!Array.isArray(vehicles)) return;
    const now = Date.now();
    for (const v of vehicles) {
      if (!v || !v.vehicleId) continue;
      const isMataro = (v.agency || '').includes('Mataró') || (v.lineCode || '').startsWith('L');
      if (!isMataro) continue;
      this.recordVehicleState({
        ...v,
        lastSeen: v.lastSeen || now
      });
    }
  }

  // 1. Get all Mataro urban lines (L1..L8)
  getLines() {
    return this.linesData.map(l => {
      const routes = this.routesData[l.id] || [];
      return {
        id: String(l.id),
        code: `L${l.id}`,
        name: l.name.trim(),
        color: l.color || '#009485',
        agency: 'Mataró Bus',
        group: 'mataro',
        mode: 'Urbà Mataró',
        directions: routes.map((r, idx) => ({
          dirId: String(idx),
          routeId: r.id,
          name: r.name,
          stopsCount: r.stops ? r.stops.length : 0
        }))
      };
    });
  }

  resolveLineConfig(lineId) {
    const cleanId = this.normalizeLineId(lineId);
    return this.linesData.find(l => String(l.id).toLowerCase() === cleanId) || null;
  }
  // Get Mataró bus stops closest to coordinates (lat, lon)
  getNearbyStops(lat, lon, radiusMeters = 800, limit = 6) {
    const userLat = parseFloat(lat);
    const userLon = parseFloat(lon);
    if (isNaN(userLat) || isNaN(userLon)) return [];

    const candidates = [];
    this.allStopsMap.forEach((stop) => {
      if (!stop.lat || !stop.lon) return;
      const dist = geoEngine.calculateDistanceMeters(userLat, userLon, stop.lat, stop.lon);
      if (dist <= radiusMeters) {
        candidates.push({
          id: stop.id,
          code: stop.id,
          name: stop.name,
          lat: stop.lat,
          lon: stop.lon,
          lines: (stop.lineas || []).map(l => ({ id: String(l.id), code: `L${l.id}`, name: l.name })),
          distanceMeters: Math.round(dist),
          walkingMinutes: Math.max(1, Math.round(dist / 80))
        });
      }
    });

    candidates.sort((a, b) => a.distanceMeters - b.distanceMeters);
    return candidates.slice(0, limit);
  }

  // Get nearby stops enriched with the next upcoming departures
  async getNearbyStopsWithDepartures(lat, lon, radiusMeters = 800, limit = 5) {
    const stops = this.getNearbyStops(lat, lon, radiusMeters, limit);
    const results = await Promise.all(stops.map(async (stop) => {
      try {
        const depData = await this.getStopDepartures(stop.id);
        const upcoming = (depData?.departures || []).slice(0, 3);
        return {
          ...stop,
          departures: upcoming,
          totalDepartures: depData?.departures?.length || 0
        };
      } catch (e) {
        return {
          ...stop,
          departures: [],
          totalDepartures: 0
        };
      }
    }));
    return results;
  }


  // Deterministically match a SIRI live vehicle to route index (0 = Anada, 1 = Tornada)
  matchVehicleToRouteIndex(vehicle, routes) {
    if (!routes || routes.length <= 1) return 0;
    
    const cleanDir = (vehicle.directionName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const cleanDest = (vehicle.destination || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    // 1. Exact string match against route name (e.g. "hospitalrodalies")
    for (let i = 0; i < routes.length; i++) {
      const cleanR = (routes[i].name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (cleanDir && cleanR && cleanDir === cleanR) return i;
    }

    // 2. Match route destination part (e.g. route "Hospital - Rodalies" has destination "Rodalies")
    for (let i = 0; i < routes.length; i++) {
      const parts = (routes[i].name || '').split('-');
      const destPart = (parts[1] || parts[0] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (cleanDest && destPart && (destPart.includes(cleanDest) || cleanDest.includes(destPart))) {
        return i;
      }
    }

    // 3. Substring match
    for (let i = 0; i < routes.length; i++) {
      const cleanR = (routes[i].name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (cleanDir && cleanR && (cleanDir.includes(cleanR) || cleanR.includes(cleanDir))) return i;
    }

    return 0;
  }

  // 2. Get full details for a line & direction (stops, route polyline, and live/estimated buses)
  async getLineDetails(lineId, direction = '0') {
    const lId = this.normalizeLineId(lineId) || '1';
    const isBoth = direction === 'both';
    const dirIdx = isBoth ? 0 : (parseInt(direction, 10) || 0);
    const cacheKey = `${lId}_${direction}`;
    const staticTemplate = this.staticLineCache.get(cacheKey) || this.staticLineCache.get(`${lId}_0`);

    const lineInfo = this.linesData.find(l => String(l.id) === lId) || { id: lId, name: `Línia ${lId}`, color: '#009485' };
    const routes = this.routesData[lId] || [];
    const selectedRoute = routes[dirIdx] || routes[0] || { coords: [], stops: [] };
    const polyline = staticTemplate ? staticTemplate.polyline : (selectedRoute.coords || []).map(c => [parseFloat(c.Latitude), parseFloat(c.Longitude)]);
    const stops = staticTemplate ? staticTemplate.stops : [];
    const allDirections = staticTemplate ? staticTemplate.allDirections : [];

    // Fetch Live Buses via SIRI
    let liveVehicles = [];
    try {
      liveVehicles = await siriClient.getLiveVehicles(lId);
    } catch (_) {}

    // Strict validation: Filter out out-of-area vehicles and erroneous test/depot artifacts
    if (Array.isArray(liveVehicles)) {
      liveVehicles = liveVehicles.filter(v => {
        const lat = v.lat || v.latitude;
        const lon = v.lon || v.longitude;
        if (!lat || !lon) return false;
        // Mataró urban bounding box: 41.48 to 41.62 N, 2.36 to 2.52 E
        if (lat < 41.48 || lat > 41.62 || lon < 2.36 || lon > 2.52) return false;
        // Exclude dummy vehicleId 'Bus' if far from Mataró route (> 1.5km from any route stop)
        if (String(v.vehicleId).toLowerCase() === 'bus') {
          const isNear = routes.some(r => (r.coords || []).some(c => geoUtils.calculateDistanceMeters(lat, lon, parseFloat(c.Latitude), parseFloat(c.Longitude)) < 1500));
          if (!isNear) return false;
        }
        return true;
      });
    }

    if (!liveVehicles || liveVehicles.length === 0) {
      const frVehs = flightRecorder.getLineVehicles(`L${lId}`);
      const mataroVehs = (frVehs || []).filter(v => (v.agency || '').includes('Mataró') || String(v.lineId) === lId);
      if (mataroVehs.length > 0) {
        liveVehicles = mataroVehs;
      }
    }

    // Fallback: If still empty, check this.vehicleHistory for active/recent buses (up to 10 mins)
    if (!liveVehicles || liveVehicles.length === 0) {
      const now = Date.now();
      const histVehs = [];
      for (const [vId, hist] of this.vehicleHistory.entries()) {
        if (String(hist.lineId) === String(lId) && (now - hist.lastSeen) <= 600000) {
          histVehs.push({
            vehicleId: hist.vehicleId,
            lineId: hist.lineId,
            directionName: hist.directionName,
            origin: hist.origin,
            destination: hist.destination,
            lat: hist.lat,
            lon: hist.lon,
            bearing: hist.bearing,
            speedKmh: hist.speedKmh,
            delayMins: hist.delayMins,
            isEstimated: true,
            isRealTime: false,
            timestamp: hist.lastSeen
          });
        }
      }
      if (histVehs.length > 0) {
        liveVehicles = histVehs;
      }
    }

    // Apply Deterministic Direction Matching & Road-Snapping with 10-minute dead reckoning
    let processedBuses = [];
    if (isBoth && routes.length > 1) {
      const vehs0 = liveVehicles.filter(v => this.matchVehicleToRouteIndex(v, routes) === 0);
      const vehs1 = liveVehicles.filter(v => this.matchVehicleToRouteIndex(v, routes) === 1);

      const buses0 = this.processBusesWithDeadReckoning(vehs0, routes[0], allDirections[0]?.stops || stops, '0', liveVehicles);
      const buses1 = this.processBusesWithDeadReckoning(vehs1, routes[1], allDirections[1]?.stops || stops, '1', liveVehicles);

      processedBuses = [...buses0, ...buses1];
    } else {
      const vehsForDir = routes.length > 1
        ? liveVehicles.filter(v => this.matchVehicleToRouteIndex(v, routes) === dirIdx)
        : liveVehicles;

      processedBuses = this.processBusesWithDeadReckoning(vehsForDir, selectedRoute, stops, String(dirIdx), liveVehicles);
    }

    // Strict deduplication by vehicleId (Live GPS strictly takes precedence over estimated dead-reckoning)
    const uniqueBusesMap = new Map();
    processedBuses.forEach(b => {
      const vId = String(b.vehicleId || b.tripId);
      if (!uniqueBusesMap.has(vId)) {
        uniqueBusesMap.set(vId, b);
      } else {
        const existing = uniqueBusesMap.get(vId);
        if (existing.isEstimated && !b.isEstimated) {
          uniqueBusesMap.set(vId, b);
        }
      }
    });
    processedBuses = Array.from(uniqueBusesMap.values()).map(b => {
      const fleetInfo = mataroFleet.getVehicleFleetInfo(b.vehicleId || b.tripId);
      return {
        ...b,
        propulsion: fleetInfo.propulsion,
        isElectric: fleetInfo.isElectric,
        isHybrid: fleetInfo.isHybrid,
        propulsionBadge: fleetInfo.propulsionBadge || `${fleetInfo.badgeIcon} ${fleetInfo.badgeText}`,
        propulsionIcon: fleetInfo.badgeIcon,
        propulsionClass: fleetInfo.badgeClass,
        modelName: fleetInfo.modelName,
        isAccessible: fleetInfo.isAccessible
      };
    });

    // Synthesize missing scheduled vehicles for trips operating without GPS telemetry
    const { syntheticBuses, fleetStatus } = this.synthesizeMissingScheduledBuses(
      lId,
      direction,
      routes,
      allDirections,
      processedBuses,
      new Date(),
      liveVehicles
    );

    if (syntheticBuses.length > 0) {
      processedBuses = [...processedBuses, ...syntheticBuses];
    }

    const hasLiveGps = processedBuses.some(b => !b.isEstimated);
    const isOnlyEstimated = processedBuses.length > 0 && processedBuses.every(b => b.isEstimated);
    const disruptions = await this.getDisruptions(lId);
    const cancelledStopsMap = this.getCancelledStopsForLine(lId, disruptions);

    const stopsWithStatus = (stops || []).map(s => {
      const sId = String(s.id);
      const isCancelled = cancelledStopsMap.has(sId);
      return {
        ...s,
        isCancelled,
        cancelledReason: isCancelled ? cancelledStopsMap.get(sId) : null
      };
    });

    return {
      ...(staticTemplate || {}),
      lineId: lId,
      code: `L${lId}`,
      name: lineInfo.name.trim(),
      color: lineInfo.color,
      agency: 'Mataró Bus (Avanza)',
      group: 'mataro',
      direction: isBoth ? 'both' : String(dirIdx),
      directionName: isBoth ? 'Ambdós sentits' : (selectedRoute.name || `${lineInfo.name}`),
      directions: routes.map((r, idx) => ({
        dirId: String(idx),
        routeId: r.id,
        name: r.name,
        stopsCount: r.stops ? r.stops.length : 0
      })),
      totalStops: stopsWithStatus.length,
      stops: stopsWithStatus,
      coords: polyline,
      polyline,
      geometrySource: 'gtfs',
      geometryEstimated: false,
      secondaryCoords: (isBoth && allDirections.length > 1) ? allDirections[1].polyline : null,
      secondaryStops: (isBoth && allDirections.length > 1) ? allDirections[1].stops : null,
      secondaryColor: '#38bdf8',
      allDirections,
      activeBuses: processedBuses,
      totalActiveBuses: processedBuses.length,
      totalVehiclesInCircuit: processedBuses.length,
      fleetStatus,
      isRealTime: hasLiveGps,
      isEstimated: isOnlyEstimated,
      isScheduleBaseline: processedBuses.length === 0,
      lastSyncTimestamp: Date.now(),
      disruptions
    };
  }

  // Dead-Zone Position Estimation (Dead-Reckoning along Polyline)
  processBusesWithDeadReckoning(liveBuses, route, stops, dirId = '0', allLineLiveVehicles = liveBuses) {
    const now = Date.now();
    const result = [];
    const polyCoords = (route.coords || []).map(c => ({ lat: parseFloat(c.Latitude), lon: parseFloat(c.Longitude) }));

    // 1. Process active live buses
    liveBuses.forEach(b => {
      // Snap raw GPS strictly to road polyline
      const snapped = geoEngine.snapPointToPolyline(b.lat, b.lon, polyCoords);
      const roadLat = Math.round(snapped.lat * 1000000) / 1000000;
      const roadLon = Math.round(snapped.lon * 1000000) / 1000000;
      const roadBearing = snapped.bearing || b.bearing || 0;

      // Record to vehicle history
      this.vehicleHistory.set(String(b.vehicleId), {
        vehicleId: b.vehicleId,
        lineId: b.lineId,
        direction: dirId,
        lat: roadLat,
        lon: roadLon,
        bearing: roadBearing,
        speedKmh: b.speedKmh,
        delayMins: b.delayMins,
        lastSeen: now,
        directionName: b.directionName,
        origin: b.origin,
        destination: b.destination
      });

      // Calculate progress and segment along stops
      const segInfo = this.findNearestSegment(roadLat, roadLon, stops, polyCoords);

      // Sanity check for terminal layovers / ghost buses (e.g. parked with velocity 0 at terminus)
      const isTerminal = (b.speedKmh <= 3 || b.speedKmh === undefined) && (segInfo.totalProgress > 92 || segInfo.totalProgress < 8);
      const isEst = Boolean(b.isEstimated);
      const isGhostDelay = !isEst && isTerminal && b.delayMins > 10;
      const cleanDelayMins = isGhostDelay ? 0 : Math.min(25, Math.max(-10, b.delayMins || 0));
      const cleanDelayFormatted = isEst
        ? '⚡ Estimació en circuit'
        : (isGhostDelay 
            ? 'Regulant a capçalera' 
            : (cleanDelayMins > 0 ? `+${cleanDelayMins} min retard` : (cleanDelayMins < 0 ? `${cleanDelayMins} min avançat` : 'Puntual')));
      const statusText = isEst
        ? '⚡ Estimació per pèrdua temporal de senyal'
        : (isGhostDelay ? '⏱️ Regulant a capçalera' : '🟢 Senyal GPS Actiu');

      result.push({
        tripId: `mataro_${b.vehicleId}`,
        vehicleId: b.vehicleId,
        lineId: b.lineId,
        lineName: b.lineName || (route && route.name) || `Línia ${b.lineId}`,
        direction: dirId,
        _snapDist: snapped.dist,
        lat: roadLat,
        lon: roadLon,
        latitude: roadLat,
        longitude: roadLon,
        bearing: roadBearing,
        compass: geoUtils.bearingToCompassName(roadBearing),
        speedKmh: b.speedKmh,
        delayMins: cleanDelayMins,
        delayFormatted: cleanDelayFormatted,
        delayBadgeText: isEst ? '⚡ En ruta (Estimat)' : cleanDelayFormatted,
        isEstimated: isEst,
        isRealTime: !isEst,
        recordedAt: b.recordedAt || new Date().toISOString(),
        timestamp: b.timestamp || now,
        origin: b.origin || '',
        destination: b.destination || '',
        statusText,
        fromStop: segInfo.fromStop,
        toStop: segInfo.toStop,
        fromSeq: segInfo.fromSeq,
        toSeq: segInfo.toSeq,
        totalProgress: segInfo.totalProgress,
        coordinatesFormatted: `${roadLat.toFixed(5)}° N, ${roadLon.toFixed(5)}° E`,
        secondsToNextStop: segInfo.secondsToNextStop,
        distanceToNextMeters: segInfo.distanceToNextMeters,
        fromCoords: { lat: roadLat, lon: roadLon },
        toCoords: segInfo.toCoords,
        segStartSec: Math.floor(now / 1000) - 10,
        segEndSec: Math.floor(now / 1000) + Math.max(15, segInfo.secondsToNextStop),
        isTerminalLayover: isTerminal || isGhostDelay
      });
    });

    // 2. Dead-Reckoning: Check if any recently tracked vehicles lost signal in dead zones (10-minute / 600s window)
    for (const [vId, hist] of this.vehicleHistory.entries()) {
      if (String(hist.lineId) !== String(route.id_linea)) continue;
      if (String(hist.direction) !== String(dirId)) continue; // Only dead-reckon on the matching direction
      const elapsedSec = (now - hist.lastSeen) / 1000;

      // If vehicle is live on ANY direction of this line, do not dead-reckon it
      const isCurrentlyActive = (allLineLiveVehicles || liveBuses).some(b => String(b.vehicleId) === String(vId));
      if (!isCurrentlyActive && elapsedSec >= 15 && elapsedSec <= 600) {
        const estPos = geoEngine.extrapolatePolylinePosition(hist, elapsedSec, hist.speedKmh || 30, polyCoords);
        if (estPos) {
          const segInfo = this.findNearestSegment(estPos.lat, estPos.lon, stops, polyCoords);
          const elapsedMin = Math.floor(elapsedSec / 60);
          const elapsedText = elapsedMin > 0 ? `${elapsedMin} min` : `${Math.round(elapsedSec)}s`;

          result.push({
            tripId: `mataro_${vId}`,
            vehicleId: vId,
            lineId: hist.lineId,
            lineName: (route && route.name) || `Línia ${hist.lineId}`,
            direction: dirId,
            lat: estPos.lat,
            lon: estPos.lon,
            latitude: estPos.lat,
            longitude: estPos.lon,
            bearing: estPos.bearing,
            compass: geoUtils.bearingToCompassName(estPos.bearing),
            speedKmh: Math.max(15, Math.min(45, hist.speedKmh || 30)),
            delayMins: hist.delayMins || 0,
            delayFormatted: hist.delayMins > 0 ? `+${hist.delayMins} min retard` : 'Puntual',
            isEstimated: true,
            isRealTime: false,
            recordedAt: new Date(hist.lastSeen).toISOString(),
            timestamp: hist.lastSeen,
            origin: hist.origin || '',
            destination: hist.destination || '',
            statusText: `⚡ Estimació de posició (${elapsedText} sense GPS)`,
            fromStop: segInfo.fromStop,
            toStop: segInfo.toStop,
            fromSeq: segInfo.fromSeq,
            toSeq: segInfo.toSeq,
            totalProgress: segInfo.totalProgress,
            coordinatesFormatted: `${estPos.lat.toFixed(5)}° N, ${estPos.lon.toFixed(5)}° E (Est.)`,
            secondsToNextStop: Math.max(10, segInfo.secondsToNextStop),
            distanceToNextMeters: segInfo.distanceToNextMeters,
            fromCoords: segInfo.fromCoords,
            toCoords: segInfo.toCoords,
            segStartSec: Math.floor(now / 1000) - 10,
            segEndSec: Math.floor(now / 1000) + Math.max(15, segInfo.secondsToNextStop),
            isTerminalLayover: false
          });
        }
      }
    }

    return result;
  }

  // Find nearest stop segment and progress
  findNearestSegment(lat, lon, stops, polyCoords) {
    if (!stops || stops.length === 0) {
      return { fromStop: 'Mataró', toStop: 'Destí', fromSeq: 1, toSeq: 1, totalProgress: 50, secondsToNextStop: 60, distanceToNextMeters: 300 };
    }

    let minIdx = 0;
    let minDist = Infinity;

    for (let i = 0; i < stops.length; i++) {
      const sLat = stops[i].latitude !== undefined ? parseFloat(stops[i].latitude) : stops[i].lat;
      const sLon = stops[i].longitude !== undefined ? parseFloat(stops[i].longitude) : stops[i].lon;
      const d = geoUtils.calculateDistanceMeters(lat, lon, sLat, sLon);
      if (!isNaN(d) && d < minDist) {
        minDist = d;
        minIdx = i;
      }
    }

    const fromIdx = Math.max(0, Math.min(stops.length - 2, minIdx));
    const toIdx = Math.min(stops.length - 1, fromIdx + 1);
    const s1 = stops[fromIdx];
    const s2 = stops[toIdx];
    const s1Lat = s1.latitude !== undefined ? parseFloat(s1.latitude) : s1.lat;
    const s1Lon = s1.longitude !== undefined ? parseFloat(s1.longitude) : s1.lon;
    const s2Lat = s2.latitude !== undefined ? parseFloat(s2.latitude) : s2.lat;
    const s2Lon = s2.longitude !== undefined ? parseFloat(s2.longitude) : s2.lon;

    const distToNext = Math.round(geoUtils.calculateDistanceMeters(lat, lon, s2Lat, s2Lon));
    const totalProgress = Math.round((toIdx / Math.max(1, stops.length - 1)) * 100);
    const secondsToNext = Math.max(15, Math.round((distToNext / 30) * 3.6));

    return {
      fromStop: s1.name,
      toStop: s2.name,
      fromSeq: s1.seq || fromIdx + 1,
      toSeq: s2.seq || toIdx + 1,
      totalProgress,
      distanceToNextMeters: distToNext,
      secondsToNextStop: secondsToNext,
      fromCoords: { lat: s1Lat, lon: s1Lon },
      toCoords: { lat: s2Lat, lon: s2Lon }
    };
  }

  /**
   * Calculates currently active scheduled trips for a line and synthesizes
   * theoretical "ghost" vehicles ONLY for genuinely missing trips that lack
   * live GPS tracking. Strictly enforces anti-bunching spatial distance separation
   * (>= 1,500m on same lane, >= 800m cross-lane), direction fleet caps, whole-line
   * fleet caps, and terminal turnaround recognition.
   * 
   * @param {string} lId Line identifier (e.g. '1'..'8')
   * @param {string} direction '0', '1', or 'both'
   * @param {Array} routes Array of route objects with coords
   * @param {Array} allDirections Array of direction metadata with stops/polyline
   * @param {Array} existingBuses Currently processed buses (live GPS + dead-reckoned)
   * @param {Date} [dateObj=new Date()] Reference date
   * @param {Array} [allLineLiveVehicles=[]] All raw live vehicles for this line across both directions
   * @returns {{ syntheticBuses: Array, fleetStatus: object }}
   */
  synthesizeMissingScheduledBuses(lId, direction, routes, allDirections, existingBuses = [], dateObj = new Date(), allLineLiveVehicles = []) {
    const isBoth = direction === 'both';
    const dateComp = calendarEngine.getDateComponents(dateObj, this.agencyTimezone);
    const dayType = dateComp.isSunday ? 'sunday' : (dateComp.isSaturday ? 'saturday' : 'weekday');
    const nowSec = (dateComp.hour || 0) * 3600 + (dateComp.minute || 0) * 60 + (dateComp.second || 0);
    const nowMs = dateObj.getTime();

    // 1. Gather all known line buses (both directions) for cross-direction and anti-bunching checks
    const allKnownBuses = [...existingBuses];
    (allLineLiveVehicles || []).forEach(lv => {
      const vId = String(lv.vehicleId || lv.tripId);
      if (!allKnownBuses.some(b => String(b.vehicleId || b.tripId) === vId)) {
        allKnownBuses.push(lv);
      }
    });

    const dirIndices = isBoth ? ['0', '1'] : [String(direction === '1' ? '1' : '0')];
    const syntheticBuses = [];
    let totalScheduledTrips = 0;
    let liveGpsCount = 0;

    // 2. Pre-calculate active scheduled trips (both in transit AND terminal layovers) across the whole line
    let totalScheduledForWholeLine = 0;
    const allLineActiveTripsByDir = { '0': [], '1': [] };

    ['0', '1'].forEach(dKey => {
      const s = mataroSchedules.getDirectionSchedule(lId, dKey, dayType);
      if (!s || !Array.isArray(s.departures)) return;
      const travelSec = s.totalTravelSec || (s.totalTravelMinutes * 60) || 1800;
      const oppDKey = dKey === '0' ? '1' : '0';
      const oppS = mataroSchedules.getDirectionSchedule(lId, oppDKey, dayType);
      const oppLiveBuses = allKnownBuses.filter(b => String(b.direction) === oppDKey && !b.isEstimated);
      const liveBusesForThisDir = allKnownBuses.filter(b => String(b.direction) === dKey && !b.isEstimated);
      const trips = [];
      let foundLayover = false;

      s.departures.forEach(depTime => {
        const depSec = timeEngine.timeStringToSeconds(depTime);
        const arrSec = depSec + travelSec;

        // A. Trip is currently in transit along the route:
        // Normally within scheduled window (nowSec < arrSec).
        // If nowSec >= arrSec, only retain trip if a live GPS bus is still circulating on this direction to claim it.
        const hasDelayedLiveBus = liveBusesForThisDir.length > 0 && liveBusesForThisDir.some(b => {
          return b.totalProgress === undefined || b.totalProgress >= 60;
        });

        if (nowSec >= depSec && (nowSec < arrSec || (nowSec < arrSec + 480 && hasDelayedLiveBus))) {
          const elapsedSec = nowSec - depSec;
          const progress = Math.max(0.01, Math.min(0.99, elapsedSec / travelSec));
          trips.push({ depTime, depSec, arrSec, elapsedSec, progress, isTerminalLayover: false, paired: false });
        }
        // B. Trip is the upcoming departure in terminal layover/regulation at origin
        else if (nowSec < depSec && !foundLayover) {
          let layoverStartSec = depSec - 600;
          let oppStillInTransit = false;
          if (oppS && Array.isArray(oppS.departures)) {
            const oppTravelSec = oppS.totalTravelSec || (oppS.totalTravelMinutes * 60) || 1800;
            const prevArrSec = oppS.departures
              .map(d => timeEngine.timeStringToSeconds(d) + oppTravelSec)
              .filter(a => a <= depSec && a >= depSec - 1200)
              .pop();
            if (prevArrSec) {
              layoverStartSec = Math.max(depSec - 900, prevArrSec);
              const prevDepSec = prevArrSec - oppTravelSec;
              const theoreticalOppProgress = (nowSec - prevDepSec) / oppTravelSec;
              oppStillInTransit = oppLiveBuses.some(b => {
                const bProg = (b.totalProgress !== undefined ? b.totalProgress : 50) / 100;
                const diff = Math.abs(theoreticalOppProgress - bProg);
                const notYetAtTerminal = (b.totalProgress !== undefined ? b.totalProgress : 50) < 85;
                return diff <= 0.70 && notYetAtTerminal;
              });
            }
          }

          if (nowSec >= layoverStartSec && !oppStillInTransit) {
            foundLayover = true;
            trips.push({ depTime, depSec, arrSec, elapsedSec: 0, progress: 0, isTerminalLayover: true, paired: false });
          }
        }
      });

      allLineActiveTripsByDir[dKey] = trips;
      totalScheduledForWholeLine += trips.length;
    });

    // Dynamically compute scheduled active fleet capacity directly from the timetable schedule (zero hardcoded tables)
    const lineMaxFleet = mataroSchedules.getScheduledFleetRequirement(lId, dayType, nowSec);
    totalScheduledForWholeLine = Math.min(totalScheduledForWholeLine, lineMaxFleet);

    const totalLiveOnWholeLine = allKnownBuses.filter(b => !b.isEstimated).length;
    // Whole-line cap: strictly capped by physical line fleet minus live GPS buses
    const maxSyntheticForLine = Math.max(0, totalScheduledForWholeLine - totalLiveOnWholeLine);

    dirIndices.forEach(dirKey => {
      const dirIdx = parseInt(dirKey, 10) || 0;
      const sched = mataroSchedules.getDirectionSchedule(lId, dirKey, dayType);
      if (!sched || !Array.isArray(sched.departures) || sched.departures.length === 0) return;

      const routeObj = routes[dirIdx] || routes[0];
      if (!routeObj) return;

      const rawCoords = (routeObj.coords || []).map(c => ({
        lat: parseFloat(c.Latitude !== undefined ? c.Latitude : (c.lat || 0)),
        lon: parseFloat(c.Longitude !== undefined ? c.Longitude : (c.lon || 0))
      })).filter(c => !isNaN(c.lat) && !isNaN(c.lon) && (c.lat !== 0 || c.lon !== 0));

      if (rawCoords.length < 2) return;

      const distTable = geoEngine.buildPolylineDistanceTable(rawCoords);
      if (distTable.total <= 0) return;

      const activeTripsForDir = allLineActiveTripsByDir[dirKey] || [];
      totalScheduledTrips += activeTripsForDir.length;
      const originPt = rawCoords[0];

      // Identify live/existing buses on this direction
      const busesOnDir = existingBuses.filter(b => String(b.direction) === dirKey);
      busesOnDir.forEach(b => {
        if (!b.isEstimated) liveGpsCount++;
      });
      const liveBusesOnDir = busesOnDir.filter(b => !b.isEstimated);

      // Direction cap: if this direction already has at least as many live GPS buses as active trips,
      // all trips for this direction are already covered by physical live GPS buses!
      if (liveBusesOnDir.length >= activeTripsForDir.length) {
        return;
      }

      // If whole-line fleet cap reached, do not synthesize further
      if (syntheticBuses.length >= maxSyntheticForLine) {
        return;
      }

      // 1. Pair live buses on this direction to active trips:
      // (a) First pair stationary buses at the origin terminal (< 350m) to terminal layover trip
      // (b) Then pair in-transit buses to their closest in-transit trip by route progress
      liveBusesOnDir.forEach(bus => {
        const busLat = bus.lat || bus.latitude;
        const busLon = bus.lon || bus.longitude;
        if (!busLat || !busLon) return;

        const distToOrigin = geoEngine.calculateDistanceMeters(busLat, busLon, originPt.lat, originPt.lon);
        const layoverTrip = activeTripsForDir.find(t => t.isTerminalLayover && !t.paired);
        if (layoverTrip && distToOrigin < 350) {
          layoverTrip.paired = true;
          return;
        }

        const snap = geoEngine.snapPointToPolyline(busLat, busLon, rawCoords);
        const segDist = distTable.cum[snap.index] + geoEngine.calculateDistanceMeters(rawCoords[snap.index].lat, rawCoords[snap.index].lon, snap.lat, snap.lon);
        const busProgress = distTable.total > 0 ? Math.max(0, Math.min(1, segDist / distTable.total)) : 0;

        let bestTripIdx = -1;
        let minDiff = Infinity;
        for (let i = 0; i < activeTripsForDir.length; i++) {
          if (activeTripsForDir[i].paired || activeTripsForDir[i].isTerminalLayover) continue;
          const diff = Math.abs(activeTripsForDir[i].progress - busProgress);
          // Enforce maximum progress diff tolerance of 0.40 to prevent delayed buses from stealing future trips
          if (diff < minDiff && diff <= 0.40) {
            minDiff = diff;
            bestTripIdx = i;
          }
        }

        if (bestTripIdx !== -1) {
          activeTripsForDir[bestTripIdx].paired = true;
        }
      });

      // 2. Cross-Direction Pairing:
      // If an incoming bus on the opposite direction is completing its trip at this terminal
      // (progress >= 85% and within 400m of the terminal), it will take the layover/turnaround trip!
      const oppDirKey = dirKey === '0' ? '1' : '0';
      const oppBuses = allKnownBuses.filter(b => String(b.direction) === oppDirKey && !b.isEstimated);

      activeTripsForDir.forEach(trip => {
        if (trip.paired) return;
        if (trip.isTerminalLayover || trip.progress <= 0.20) {
          const incomingBus = oppBuses.find(b => {
            const bLat = b.lat || b.latitude;
            const bLon = b.lon || b.longitude;
            if (!bLat || !bLon) return false;
            const d = geoEngine.calculateDistanceMeters(originPt.lat, originPt.lon, bLat, bLon);
            const isNearTerminal = d < 400;
            const isAtEnd = b.totalProgress !== undefined ? b.totalProgress >= 85 : d < 400;
            return isAtEnd && isNearTerminal;
          });
          if (incomingBus) {
            trip.paired = true;
          }
        }
      });

      // Synthesize ghost buses ONLY for genuinely missing trips that respect headway and spatial separation
      const maxSyntheticForDir = Math.max(0, activeTripsForDir.length - liveBusesOnDir.length);

      for (const trip of activeTripsForDir) {
        if (trip.paired) continue;
        if (!trip.isTerminalLayover && nowSec >= trip.arrSec) continue;
        if (syntheticBuses.length >= maxSyntheticForLine) break;
        if (syntheticBuses.filter(b => b.direction === String(dirKey)).length >= maxSyntheticForDir) break;

        let lat, lon, bearing, totalProgress, speedKmh, statusText, formattedStatus, delayBadgeText, fromStop, toStop, fromSeq, toSeq;

        if (trip.isTerminalLayover) {
          // Terminal layover vehicle: stationary at capçalera waiting to depart
          lat = Math.round(originPt.lat * 1000000) / 1000000;
          lon = Math.round(originPt.lon * 1000000) / 1000000;
          bearing = rawCoords.length > 1
            ? (geoEngine.calculateBearing(rawCoords[0].lat, rawCoords[0].lon, rawCoords[1].lat, rawCoords[1].lon) || 0)
            : 0;
          totalProgress = 0;
          speedKmh = 0;
          statusText = `🅿️ Capçalera / Regulació (Sortida: ${trip.depTime})`;
          formattedStatus = `Sortida ${trip.depTime}`;
          delayBadgeText = '⚡ Estimat (Regulant)';
          fromStop = sched.originStop?.name || 'Capçalera';
          toStop = `Sortida a les ${trip.depTime}`;
          fromSeq = 1;
          toSeq = 2;

          // Anti-stacking at terminal: do not place two buses at the exact same terminal (< 150m)
          const allCurrentBuses = [...allKnownBuses, ...syntheticBuses];
          const hasClashAtTerminal = allCurrentBuses.some(b => {
            const bLat = b.lat || b.latitude;
            const bLon = b.lon || b.longitude;
            if (!bLat || !bLon) return false;
            return geoEngine.calculateDistanceMeters(lat, lon, bLat, bLon) < 150;
          });
          if (hasClashAtTerminal) continue;
        } else {
          // In-transit vehicle along polyline
          const targetDist = trip.progress * distTable.total;
          const pt = geoEngine.pointAtDistance(rawCoords, distTable, targetDist);
          if (!pt) continue;

          lat = Math.round(pt.lat * 1000000) / 1000000;
          lon = Math.round(pt.lon * 1000000) / 1000000;
          bearing = pt.bearing || 0;
          totalProgress = Math.round(trip.progress * 100);
          speedKmh = 20;
          statusText = `⚡ Posició estimada segons horari (Sortida: ${trip.depTime})`;
          formattedStatus = `Teòric (${trip.depTime})`;
          delayBadgeText = '⚡ Estimat (sense GPS)';

          const stopsForDir = (allDirections && allDirections[dirIdx]?.stops) || sched.stops || [];
          const segInfo = this.findNearestSegment(lat, lon, stopsForDir, rawCoords);
          fromStop = segInfo.fromStop;
          toStop = segInfo.toStop;
          fromSeq = segInfo.fromSeq;
          toSeq = segInfo.toSeq;

          // Anti-bunching and spatial headway guard:
          // Same-direction buses must have at least 15% route progress separation and >= 500m distance.
          // Opposite-direction buses must not be placed right on top of each other (< 250m).
          const allCurrentBuses = [...allKnownBuses, ...syntheticBuses];
          let bunched = false;

          for (const existing of allCurrentBuses) {
            const exLat = existing.lat || existing.latitude;
            const exLon = existing.lon || existing.longitude;
            if (!exLat || !exLon) continue;

            const dist = geoEngine.calculateDistanceMeters(lat, lon, exLat, exLon);
            const isSameDirection = String(existing.direction) === String(dirKey);

            if (isSameDirection) {
              if (existing.totalProgress !== undefined) {
                const progDiff = Math.abs(trip.progress - (existing.totalProgress / 100));
                if (progDiff < 0.15) {
                  bunched = true;
                  break;
                }
              }
              if (dist < 500) {
                bunched = true;
                break;
              }
            } else {
              if (dist < 250) {
                bunched = true;
                break;
              }
            }
          }

          if (bunched) {
            continue;
          }
        }

        const depTimeClean = trip.depTime.replace(':', '');
        const vId = `EST_${lId}_${depTimeClean}`;

        syntheticBuses.push({
          tripId: `mataro_ghost_${lId}_${dirKey}_${depTimeClean}`,
          vehicleId: vId,
          lineId: String(lId),
          lineName: sched.lineName || `Línia ${lId}`,
          direction: String(dirKey),
          directionName: sched.directionName,
          origin: sched.originStop?.name || '',
          destination: sched.terminalStop?.name || sched.directionName,
          lat,
          lon,
          latitude: lat,
          longitude: lon,
          bearing,
          compass: geoUtils.bearingToCompassName(bearing),
          speedKmh,
          delayMins: 0,
          delayFormatted: trip.isTerminalLayover ? 'A l\'hora' : 'Horari teòric',
          delayBadgeText,
          departureTime: trip.depTime,
          isEstimated: true,
          isRealTime: false,
          isGhostVehicle: true,
          isTerminalLayover: Boolean(trip.isTerminalLayover),
          statusText,
          formattedStatus,
          recordedAt: new Date(nowMs).toISOString(),
          timestamp: nowMs,
          fromStop,
          toStop,
          fromSeq,
          toSeq,
          totalProgress,
          propulsion: 'diesel',
          isElectric: false,
          isHybrid: false,
          propulsionBadge: '🕒 Horari Teòric',
          propulsionIcon: '⚡',
          propulsionClass: 'estimated',
          modelName: 'Flota Mataró Bus (Sense GPS)'
        });
      }
    });

    const effScheduled = Math.min(lineMaxFleet, isBoth ? totalScheduledForWholeLine : totalScheduledTrips);
    const fleetStatus = {
      scheduledVehicles: effScheduled,
      liveGpsVehicles: liveGpsCount,
      estimatedVehicles: syntheticBuses.length,
      fleetCoveragePct: effScheduled > 0
        ? Math.min(100, Math.round((liveGpsCount / effScheduled) * 100))
        : 100
    };

    return { syntheticBuses, fleetStatus };
  }

  // BaseTracker interface implementation
  async fetchLiveVehicles(lineId = '') {
    const lId = this.normalizeLineId(lineId);
    const details = await this.getLineDetails(lId || '1', 'both');
    return details && Array.isArray(details.activeBuses) ? details.activeBuses : [];
  }

  async fetchStopArrivals(stopId, lineId = '', direction = '0') {
    const sId = this.normalizeStopId(stopId);
    const deps = await this.getStopDepartures(sId, lineId, direction);
    return deps && Array.isArray(deps.departures) ? deps.departures : [];
  }

  // Estimate arrival ETA to stopId from active live vehicles along the route
  async estimateArrivalsForStop(stopId, lineId = '', existingArrivals = []) {
    const sId = this.normalizeStopId(stopId);
    const cleanLineId = lineId ? this.normalizeLineId(lineId) : '';
    const existingVehicleIds = new Set(existingArrivals.map(a => a.vehicleId).filter(Boolean));
    const estimatedArrivals = [];

    // Determine relevant lines serving this stop
    let targetLineIds = [];
    if (cleanLineId) {
      targetLineIds = [cleanLineId];
    } else {
      const stopInfo = this.allStopsMap.get(sId);
      if (stopInfo && stopInfo.lineas && stopInfo.lineas.length > 0) {
        targetLineIds = stopInfo.lineas.map(l => String(l.id));
      }
    }

    if (targetLineIds.length === 0) {
      targetLineIds = this.linesData.map(l => String(l.id));
    }

    const now = Date.now();
    const netNow = timeEngine.getNetworkTime(this.agencyTimezone, new Date(now));
    const currentSec = netNow.hour * 3600 + netNow.minute * 60 + netNow.second;
    const dateComp = calendarEngine.getDateComponents(new Date(now), this.agencyTimezone);
    const dayType = dateComp.isSunday ? 'sunday' : (dateComp.isSaturday ? 'saturday' : 'weekday');

    for (const lId of targetLineIds) {
      const routes = this.routesData[lId] || [];
      if (routes.length === 0) continue;

      let liveVehicles = [];
      try {
        liveVehicles = await siriClient.getLiveVehicles(lId);
      } catch (e) {
        // Fallback below
      }

      if (!liveVehicles || liveVehicles.length === 0) {
        const frVehs = flightRecorder.getLineVehicles(`L${lId}`);
        const mataroVehs = (frVehs || []).filter(v => (v.agency || '').includes('Mataró') || String(v.lineId) === lId);
        if (mataroVehs.length > 0) {
          liveVehicles = mataroVehs;
        } else {
          for (const [vId, hist] of this.vehicleHistory.entries()) {
            if (String(hist.lineId) === String(lId) && (now - hist.lastSeen) <= 600000) {
              liveVehicles.push({
                vehicleId: hist.vehicleId,
                lineId: hist.lineId,
                direction: hist.direction,
                directionName: hist.directionName,
                origin: hist.origin,
                destination: hist.destination,
                lat: hist.lat,
                lon: hist.lon,
                bearing: hist.bearing,
                speedKmh: hist.speedKmh,
                delayMins: hist.delayMins,
                isEstimated: true,
                isRealTime: false,
                timestamp: hist.lastSeen
              });
            }
          }
        }
      }
      if (!liveVehicles || liveVehicles.length === 0) continue;

      const lineInfo = this.linesData.find(l => String(l.id) === lId) || { name: `Línia ${lId}` };

      // Find which routes contain this stop
      routes.forEach((route, routeIdx) => {
        const routeStops = route.stops || [];
        const targetStopIdx = routeStops.findIndex(s => String(s.id) === sId);
        if (targetStopIdx === -1) return; // This route direction does not visit this stop

        const dirSched = mataroSchedules.getDirectionSchedule(lId, String(route.id || routeIdx), dayType);
        const lastTripSec = dirSched && dirSched.lastTrip ? timeEngine.timeStringToSeconds(dirSched.lastTrip) : 22 * 3600 + 35 * 60;

        // If service for today has ended (past last trip + 20m grace period), do not synthesize arrivals
        if (currentSec > lastTripSec + 1200) {
          return;
        }

        const targetStopObj = routeStops[targetStopIdx];
        const routePolyCoords = (route.coords || []).map(c => ({ lat: parseFloat(c.Latitude), lon: parseFloat(c.Longitude) }));

        // Check each live vehicle on the line
        liveVehicles.forEach(veh => {
          if (existingVehicleIds.has(veh.vehicleId)) return; // Already reported by SIRI

          const vehRouteIdx = this.matchVehicleToRouteIndex(veh, routes);
          const isSameDirection = (vehRouteIdx === routeIdx);

          // ONLY estimate ETA for physically approaching upstream vehicles on the same route direction
          if (!isSameDirection) return;

          // Project forward along route polyline if telemetry was recorded earlier
          let effectiveLat = veh.lat;
          let effectiveLon = veh.lon;
          const elapsedSec = Math.max(0, (now - (veh.timestamp || veh.lastSeen || now)) / 1000);
          if (elapsedSec > 15 && elapsedSec <= 600) {
            const extrapolated = geoEngine.extrapolatePolylinePosition(veh, elapsedSec, veh.speedKmh || 25, routePolyCoords);
            if (extrapolated) {
              effectiveLat = extrapolated.lat;
              effectiveLon = extrapolated.lon;
            }
          }

          const snapped = geoEngine.snapPointToPolyline(effectiveLat, effectiveLon, routePolyCoords);
          const vehNearestStop = this.findNearestSegment(snapped.lat, snapped.lon, routeStops, routePolyCoords);
          const vehStopIdx = Math.max(0, (vehNearestStop.fromSeq || 1) - 1);
          const isUpstreamDirect = (vehStopIdx <= targetStopIdx);

          if (!isUpstreamDirect) return; // Bus has passed this stop on this run; do not fabricate synthetic multi-hop loops!

          const targetLat = targetStopObj.latitude !== undefined ? parseFloat(targetStopObj.latitude) : targetStopObj.lat;
          const targetLon = targetStopObj.longitude !== undefined ? parseFloat(targetStopObj.longitude) : targetStopObj.lon;

          const remainingStops = targetStopIdx - vehStopIdx;
          const remainingMeters = geoEngine.calculatePolylineDistanceBetween(routePolyCoords, snapped.lat, snapped.lon, targetLat || effectiveLat, targetLon || effectiveLon);
          const speedMps = Math.max(4.5, (veh.speedKmh || 22) / 3.6);
          let transitTravelSec = Math.round(remainingMeters / speedMps) + (remainingStops * 25);

          // If vehicle is parked/regulating at origin terminal:
          if (vehStopIdx === 0 && (veh.speedKmh === 0 || veh.speedKmh <= 5)) {
            if (dirSched && Array.isArray(dirSched.departures)) {
              const nextTrip = dirSched.departures.find(t => timeEngine.timeStringToSeconds(t) >= currentSec - 60);
              if (nextTrip) {
                const nextSec = timeEngine.timeStringToSeconds(nextTrip);
                const regWaitSec = Math.max(0, nextSec - currentSec);
                transitTravelSec = Math.max(transitTravelSec, regWaitSec + transitTravelSec);
              }
            }
          }

          const minutesAway = Math.max(0, Math.round(transitTravelSec / 60));

          // Bound within 45 minutes
          if (minutesAway <= 45) {
            const arrDate = new Date(now + minutesAway * 60000);
            const formattedTime = timeUtils.formatTimeToTimezone(arrDate, this.agencyTimezone);
            const badge = veh.isEstimated
              ? `⚡ En ruta (Estimat)`
              : (veh.delayMins > 0 ? `+${veh.delayMins} min retard` : `⚡ En ruta (Bus #${veh.vehicleId})`);

            estimatedArrivals.push({
              lineId: lId,
              lineName: lineInfo.name,
              directionName: route.name,
              destination: route.name,
              vehicleId: veh.vehicleId,
              distanceFromStop: `${Math.round(remainingMeters)}m`,
              departureTime: formattedTime,
              expectedIso: arrDate.toISOString(),
              aimedIso: arrDate.toISOString(),
              minutesAway,
              formattedStatus: minutesAway === 0 ? 'Imminent' : (minutesAway === 1 ? '1 min' : `${minutesAway} min`),
              delayMins: veh.delayMins || 0,
              delayBadgeText: badge,
              delayStatus: 'estimated',
              isRealTime: false,
              isEstimated: true,
              isUpstreamDirect: true,
              busCoords: { lat: effectiveLat, lon: effectiveLon }
            });

            existingVehicleIds.add(veh.vehicleId);
          }
        });
      });
    }

    return estimatedArrivals;
  }

  findRoutesServingStop(stopId, lineId = '') {
    const sId = this.normalizeStopId(stopId);
    const cleanLineId = lineId ? this.normalizeLineId(lineId) : '';
    const results = [];

    const linesToCheck = cleanLineId ? [cleanLineId] : Object.keys(this.routesData);
    for (const lId of linesToCheck) {
      const routes = this.routesData[lId] || [];
      const lineInfo = this.linesData.find(l => String(l.id) === lId) || { id: lId, name: `Línia ${lId}` };
      for (const r of routes) {
        if ((r.stops || []).some(s => String(s.id) === sId)) {
          results.push({
            ...r,
            id_linea: lId,
            lineName: lineInfo.name.trim()
          });
        }
      }
    }

    if (results.length === 0 && cleanLineId && this.routesData[cleanLineId]) {
      const lineInfo = this.linesData.find(l => String(l.id) === String(cleanLineId)) || { id: cleanLineId, name: `Línia ${cleanLineId}` };
      const defaultRoute = this.routesData[cleanLineId][0];
      if (defaultRoute) {
        results.push({
          ...defaultRoute,
          id_linea: String(cleanLineId),
          lineName: lineInfo.name.trim()
        });
      }
    }

    return results;
  }

  // 3. Get Real-Time & Estimated Departures for a stop (up to 120 mins)
  async getStopDepartures(stopId, lineId = '', direction = '0', options = {}) {
    if (typeof direction === 'object' && direction !== null) {
      options = direction;
      direction = '0';
    }
    const sId = this.normalizeStopId(stopId);
    const cleanLineId = lineId ? this.normalizeLineId(lineId) : '';
    const dirKey = String(direction || '0');
    const lIdKey = cleanLineId || '';
    const limitKey = String(options.limit || 10);
    const dateKey = options.targetDate || options.dateObj ? String(options.targetDate || options.dateObj) : '';
    const cacheKey = `${sId}_${lIdKey}_${dirKey}_${limitKey}_${dateKey}`;

    // Fast-path: Instant 0ms memory cache return if fresh
    if (!options.skipCache && this.stopDeparturesMemoryCache.has(cacheKey)) {
      const cached = this.stopDeparturesMemoryCache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.stopCacheTtlMs) {
        return cached.data;
      }
    }

    const stopInfo = this.allStopsMap.get(sId) || { id: sId, name: `Parada ${sId}` };
    
    // 1. Query Official Real-Time SIRI Departures
    let liveArrivals = [];
    if (!options.skipSiri) {
      try {
        liveArrivals = await siriClient.getStopArrivals(sId, cleanLineId);
      } catch (e) {
        console.warn(`[getStopDepartures] SIRI query error for stop ${sId}:`, e.message);
      }
    }

    // 2. Query Circuit Position Estimations for Active Vehicles
    let estimatedArrivals = [];
    try {
      estimatedArrivals = await this.estimateArrivalsForStop(sId, cleanLineId, liveArrivals);
    } catch (e) {
      console.warn(`[getStopDepartures] Circuit estimation error for stop ${sId}:`, e.message);
    }

    // 3. Combine and deduplicate
    const combined = [...liveArrivals, ...estimatedArrivals];
    
    // Filter to 120-minute window and sort chronologically, ignoring invalid/malformed times
    const sorted = combined
      .filter(d => {
        if (d.minutesAway === undefined || d.minutesAway === null || d.minutesAway > 120) return false;
        if (!d.departureTime || d.departureTime === '--:--') return false;
        if (d.isRealTime && d.departureTime === '00:00' && d.minutesAway === 0) {
          if (!d.expectedIso || d.expectedIso.startsWith('0001-') || d.expectedIso.startsWith('1970-')) return false;
        }
        return true;
      })
      .sort((a, b) => a.minutesAway - b.minutesAway);

    const cleanStopName = (stopInfo.name || '').toLowerCase().trim();
    const routesForStop = this.findRoutesServingStop(sId, lineId);

    const targetDate = options.dateObj ? new Date(options.dateObj) :
      (options.targetDate ? new Date(options.targetDate) :
      (options.referenceDate ? new Date(options.referenceDate) : new Date()));

    const dateCompToday = calendarEngine.getDateComponents(targetDate, this.agencyTimezone);
    const dayTypeToday = dateCompToday.isSunday ? 'sunday' : (dateCompToday.isSaturday ? 'saturday' : 'weekday');

    const tomorrow = new Date(targetDate.getTime() + 24 * 3600 * 1000);
    const dateCompTomorrow = calendarEngine.getDateComponents(tomorrow, this.agencyTimezone);
    const dayTypeTomorrow = dateCompTomorrow.isSunday ? 'sunday' : (dateCompTomorrow.isSaturday ? 'saturday' : 'weekday');

    const filteredDepartures = [];

    for (const dep of sorted) {
      const vId = dep.vehicleId ? String(dep.vehicleId).trim() : null;
      const destName = (dep.destination || '').toLowerCase().trim();
      const isTerminatingHere = destName && (destName === cleanStopName || cleanStopName.startsWith(destName) || cleanStopName.includes(destName));

      // Terminal Turnaround & Regulating Transition:
      // If an incoming vehicle is arriving at this terminal stop, transfer its live telemetry
      // to the outbound route departing FROM this terminal stop so riders see the departing run.
      if (isTerminatingHere) {
        const outboundRoute = routesForStop.find(r => 
          String(r.id_linea) === String(dep.lineId) && 
          (r.stops || []).findIndex(s => String(s.id) === sId) === 0
        );
        if (outboundRoute) {
          const arrTime = dep.departureTime || timeUtils.formatTimeToTimezone(new Date(), this.agencyTimezone);
          const dirKey = String(outboundRoute.id || '0');
          const dirSched = mataroSchedules.getDirectionSchedule(String(dep.lineId), dirKey, dayTypeToday);

          // Find outbound scheduled departure time associated with this vehicle turnaround
          let nextDepTime = arrTime;
          let scheduledDepTime = null;
          let delayMins = 0;

          if (dirSched && Array.isArray(dirSched.departures)) {
            const arrSec = timeEngine.timeStringToSeconds(arrTime);
            // Search for outbound scheduled trip associated with this turnaround (check up to 5 min before arrival or anywhere after)
            const foundTrip = dirSched.departures.find(t => timeEngine.timeStringToSeconds(t) >= arrSec - 300);
            if (foundTrip) {
              scheduledDepTime = foundTrip;
              const schedSec = timeEngine.timeStringToSeconds(scheduledDepTime);
              if (arrSec > schedSec) {
                // Bus is delayed and arrives AFTER scheduled departure time!
                // DOMAIN INVARIANT: A bus can NEVER depart before it arrives!
                // Add minimum 1-min turnaround buffer for passenger alighting/boarding.
                const minDepSec = arrSec + 60;
                nextDepTime = timeEngine.minutesToTimeString(Math.round(minDepSec / 60));
                delayMins = Math.round((minDepSec - schedSec) / 60);
              } else {
                nextDepTime = scheduledDepTime;
                delayMins = 0;
              }
            }
          }

          // Ensure strict HH:MM formatting without seconds
          const cleanArrTime = String(arrTime).replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1');
          const cleanDepTime = String(nextDepTime).replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1');
          const cleanSchedDepTime = scheduledDepTime ? String(scheduledDepTime).replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1') : cleanDepTime;

          dep.destination = outboundRoute.name;
          dep.directionId = String(outboundRoute.id || '0');
          dep.arrivalTime = cleanArrTime;
          dep.departureTime = cleanDepTime;
          dep.scheduledTime = cleanSchedDepTime;
          dep.scheduledDepartureTime = cleanSchedDepTime;
          dep.delayMins = delayMins;
          dep.delayMinutes = delayMins;
          dep.isRegulating = true;
          dep.delayStatus = delayMins >= 2 ? 'delayed' : 'regulating';
          dep.delayBadgeText = delayMins >= 2 ? `+${delayMins} min retard` : '⏱️ Regulació';

          // Ensure minutesAway accounts for outbound departure time
          const arrSecVal = timeEngine.timeStringToSeconds(cleanArrTime);
          const depSecVal = timeEngine.timeStringToSeconds(cleanDepTime);
          const depMinDelta = Math.max(0, Math.round((depSecVal - arrSecVal) / 60));
          dep.minutesAway = Math.max(0, (dep.minutesAway || 0) + depMinDelta);
          dep.formattedStatus = (dep.minutesAway <= 0) ? 'En regulació' : `${dep.minutesAway} min`;

          dep.statusText = (timeEngine.timeStringToSeconds(cleanArrTime) < timeEngine.timeStringToSeconds(cleanDepTime))
            ? `🅿️ Regulant (Arribada: ${cleanArrTime} • Sortida: ${cleanDepTime})`
            : `🅿️ Regulant a capçalera (Sortida: ${cleanDepTime})`;
        }
      }

      // 1. Same vehicleId deduplication within 7 minutes (e.g. terminal arrival + departure turnaround)
      if (vId) {
        const existingIdx = filteredDepartures.findIndex(x => 
          x.vehicleId && String(x.vehicleId).trim() === vId && Math.abs(x.minutesAway - dep.minutesAway) <= 7
        );

        if (existingIdx !== -1) {
          const existing = filteredDepartures[existingIdx];
          const existingDest = (existing.destination || '').toLowerCase().trim();
          const existingTerminating = existingDest && (existingDest === cleanStopName || cleanStopName.startsWith(existingDest));

          // Prefer the outbound departure (going to the next destination) over the terminating arrival
          if (existingTerminating && !isTerminatingHere) {
            filteredDepartures[existingIdx] = dep;
          } else if (existing.isEstimated && dep.isRealTime) {
            filteredDepartures[existingIdx] = dep;
          }
          continue;
        }
      }

      // 2. Duplicate line + destination within 3 minutes (prefer real-time over estimated)
      const closeMatchIdx = filteredDepartures.findIndex(x =>
        String(x.lineId) === String(dep.lineId) &&
        (x.destination || '').toLowerCase().trim() === destName &&
        Math.abs(x.minutesAway - dep.minutesAway) <= 3
      );

      if (closeMatchIdx !== -1) {
        const match = filteredDepartures[closeMatchIdx];
        if (match.isEstimated && dep.isRealTime) {
          filteredDepartures[closeMatchIdx] = dep;
        }
        continue;
      }

      filteredDepartures.push(dep);
    }

    // 4. Merge full daily scheduled timetable departures for this stop using scheduleSynthesizer
    let allSynthesizedDepartures = [];
    const assignedLive = new Set();

    routesForStop.forEach(r => {
      const lIdStr = String(r.id_linea || lineId || '1');
      const dirKey = String(r.id || '0');
      const stopIdx = (r.stops || []).findIndex(s => String(s.id) === sId);
      const isTerminus = (stopIdx === (r.stops.length - 1)) && r.stops.length > 1;
      const isOrigin = (stopIdx === 0);

      // If this stop is the TERMINAL end of this route direction (and not a circular loop),
      // do not compile departures for it because buses terminate at this stop.
      if (isTerminus && !isOrigin) {
        return;
      }

      const dirSchedToday = mataroSchedules.getDirectionSchedule(lIdStr, dirKey, dayTypeToday);
      const dirSchedTomorrow = mataroSchedules.getDirectionSchedule(lIdStr, dirKey, dayTypeTomorrow);

      let stopTravelSec = mataroSchedules.getStopTravelTime(lIdStr, dirKey, sId);
      if (stopTravelSec === 0 && r.stops && r.stops.length > 0) {
        const travelTimes = scheduleSynthesizer.estimateStopTravelTimes(r.stops, {
          speedMps: 4.8,
          dwellSecPerStop: 25,
          defaultSegmentMeters: 300
        });
        stopTravelSec = scheduleSynthesizer.getTravelTimeToStop(travelTimes, sId);
      }

      // Assign live departures to their matching route variant without cloning
      const liveForRoute = filteredDepartures.filter(d => {
        if (String(d.lineId) !== lIdStr) return false;
        const destLower = String(d.destination || '').toLowerCase();
        const rNameLower = String(r.name || '').toLowerCase();
        const liveKey = d.vehicleId ? `veh_${d.vehicleId}` : `time_${d.departureTime}`;
        if (assignedLive.has(liveKey)) return false;

        // If this live departure was tagged as regulating for this specific direction
        if (d.isRegulating && d.directionId && d.directionId === dirKey) {
          assignedLive.add(liveKey);
          return true;
        }

        if (routesForStop.length > 1) {
          const rKeywords = rNameLower.split(/[\s\-–\(\)\/]+/).filter(w => w.length > 3);
          const dKeywords = destLower.split(/[\s\-–\(\)\/]+/).filter(w => w.length > 3);
          const matchesAffinity = rKeywords.some(k => destLower.includes(k)) || dKeywords.some(k => rNameLower.includes(k));
          const hasBetterOther = routesForStop.some(otherR => otherR.id !== r.id && otherR.name.toLowerCase().split(/[\s\-–\(\)\/]+/).some(k => k.length > 3 && destLower.includes(k)));
          if (!matchesAffinity && hasBetterOther) {
            return false;
          }
        }

        assignedLive.add(liveKey);
        return true;
      });

      const compiledForRoute = scheduleSynthesizer.compileStopDepartures({
        baseDeparturesToday: dirSchedToday ? dirSchedToday.departures : [],
        baseDeparturesTomorrow: dirSchedTomorrow ? dirSchedTomorrow.departures : [],
        stopTravelSec,
        liveDepartures: liveForRoute,
        limit: options.limit !== undefined ? Number(options.limit) : 10,
        minCountBeforeMorning: options.minCountBeforeMorning !== undefined ? Number(options.minCountBeforeMorning) : 5,
        maxMorningCount: options.maxMorningCount !== undefined ? Number(options.maxMorningCount) : 10,
        duplicateWindowMinutes: 8,
        dateObj: targetDate,
        timezone: this.agencyTimezone,
        lineId: lIdStr,
        lineCode: lIdStr,
        lineName: r.lineName || `Línia ${lIdStr}`,
        destination: r.name || dirSchedToday?.directionName || `Línia ${lIdStr}`,
        directionId: dirKey,
        isTrain: false
      });

      allSynthesizedDepartures.push(...compiledForRoute);
    });

    if (allSynthesizedDepartures.length === 0 && filteredDepartures.length > 0) {
      allSynthesizedDepartures = filteredDepartures.map(d => delayEngine.standardizeDeparture(d));
    }

    allSynthesizedDepartures.sort((a, b) => {
      if (a.isToday !== b.isToday) {
        return a.isToday ? -1 : 1;
      }
      return (a.minutesAway || 0) - (b.minutesAway || 0);
    });

    // Authoritative global deduplication by vehicleId and by (lineId, departureTime, isToday)
    const seenDepKeys = new Set();
    const seenVehicleIds = new Set();
    const finalDepartures = [];
    for (const dep of allSynthesizedDepartures) {
      const vId = dep.vehicleId ? String(dep.vehicleId).trim() : null;
      if (vId) {
        if (seenVehicleIds.has(vId)) continue;
        seenVehicleIds.add(vId);
      }

      const key = `${dep.lineId}_${dep.departureTime}_${dep.isToday}`;
      if (!seenDepKeys.has(key)) {
        seenDepKeys.add(key);
        finalDepartures.push(dep);
      }
    }

    let intermodal = null;
    if (!options.skipIntermodal) {
      try {
        intermodal = await intermodalHub.getConnectionsForStop(sId, {
          stopName: stopInfo.name,
          lat: stopInfo.lat,
          lon: stopInfo.lon
        });
      } catch (_) {}
    }

    const result = {
      stop: {
        id: sId,
        name: stopInfo.name,
        lat: stopInfo.lat,
        lon: stopInfo.lon,
        zone: 'Mataró Urbà'
      },
      departures: finalDepartures,
      totalDepartures: finalDepartures.length,
      isHub: intermodal ? Boolean(intermodal.isHub) : false,
      hub: intermodal?.hub || null,
      intermodalConnections: intermodal?.connections || []
    };

    // Store in memory cache for sub-millisecond retrieval
    this.stopDeparturesMemoryCache.set(cacheKey, {
      timestamp: Date.now(),
      data: result
    });

    // Bounded garbage collection for memory cache (cap to active stops)
    if (this.stopDeparturesMemoryCache.size > 200) {
      const now = Date.now();
      for (const [k, v] of this.stopDeparturesMemoryCache.entries()) {
        if (now - v.timestamp > 60000) {
          this.stopDeparturesMemoryCache.delete(k);
        }
      }
    }

    return result;
  }

  // 3b. Warm all stops cache for a line in a fast background pass
  async warmLineStopsCache(lineId) {
    try {
      const lId = this.normalizeLineId(lineId) || '1';
      const routes = this.routesData[lId] || [];
      const stopIds = new Set();
      routes.forEach(r => {
        (r.stops || []).forEach(s => {
          if (s.id) stopIds.add(String(s.id));
        });
      });

      const promises = Array.from(stopIds).map(sId => 
        this.getStopDepartures(sId, lId, '0', { skipCache: true, skipSiri: true }).catch(() => null)
      );
      await Promise.allSettled(promises);
    } catch (e) {
      // Non-blocking warming
    }
  }

  // 4. Get Target Stop ETA
  async getTargetStopETA(lineId, stopId = null, direction = '0') {
    const lId = this.normalizeLineId(lineId) || '1';
    const lineInfo = this.linesData.find(l => String(l.id) === lId) || { id: lId, name: `Línia ${lId}`, color: '#009485' };
    const routes = this.routesData[lId] || [];
    const dirIdx = parseInt(direction, 10) || 0;
    const selectedRoute = routes[dirIdx] || routes[0] || { stops: [] };

    const routeStops = selectedRoute.stops || [];
    let chosenStop = null;

    if (stopId) {
      const normalizedStop = this.normalizeStopId(stopId);
      chosenStop = routeStops.find(s => String(s.id) === normalizedStop) || this.allStopsMap.get(normalizedStop);
    }

    if (!chosenStop && routeStops.length > 0) {
      chosenStop = routeStops[0];
    }

    if (!chosenStop) {
      return { targetStop: null, nextBus: null, upcomingDepartures: [] };
    }

    const sId = String(chosenStop.id);
    const stopDepartures = await this.getStopDepartures(sId, lId, String(dirIdx), { skipIntermodal: true });
    const deps = stopDepartures.departures || [];
    const nextBus = deps.length > 0 ? deps[0] : null;

    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
    const dateCompTomorrow = calendarEngine.getDateComponents(tomorrow, this.agencyTimezone);
    const dayTypeTomorrow = dateCompTomorrow.isSunday ? 'sunday' : (dateCompTomorrow.isSaturday ? 'saturday' : 'weekday');

    const dirSchedTomorrow = mataroSchedules.getDirectionSchedule(lId, selectedRoute?.id || String(dirIdx), dayTypeTomorrow);
    const stopTravelSec = mataroSchedules.getStopTravelTime(lId, selectedRoute?.id || String(dirIdx), sId);

    let firstTimeTomorrow = '06:30';
    if (dirSchedTomorrow && dirSchedTomorrow.firstTrip) {
      if (stopTravelSec > 0) {
        const [hStr, mStr] = dirSchedTomorrow.firstTrip.split(':');
        const passSec = parseInt(hStr, 10) * 3600 + parseInt(mStr, 10) * 60 + stopTravelSec;
        const passH = Math.floor(passSec / 3600) % 24;
        const passM = Math.floor((passSec % 3600) / 60);
        firstTimeTomorrow = `${String(passH).padStart(2, '0')}:${String(passM).padStart(2, '0')}`;
      } else {
        firstTimeTomorrow = dirSchedTomorrow.firstTrip;
      }
    }

    const isOperating = deps.some(d => d.isRealTime || d.isEstimated);
    const dateCompNow = calendarEngine.getDateComponents(now, this.agencyTimezone);
    const isNight = dateCompNow.hour >= 22 || dateCompNow.hour < 6;

    return {
      line: {
        id: lId,
        code: String(lId),
        name: lineInfo.name.trim(),
        color: lineInfo.color
      },
      targetStop: {
        id: sId,
        mouteStopId: sId,
        name: chosenStop.name.replace(/ - \d+$/, ''),
        lat: chosenStop.latitude || chosenStop.lat,
        lon: chosenStop.longitude || chosenStop.lon,
        zone: 'Mataró Urbà',
        seq: routeStops.findIndex(s => String(s.id) === sId) + 1
      },
      direction: String(dirIdx),
      directionName: selectedRoute.name || lineInfo.name,
      nextBus,
      upcomingDepartures: deps,
      serviceStatus: {
        isOperating,
        period: isNight ? 'night' : 'day',
        firstServiceTomorrow: firstTimeTomorrow,
        statusText: isOperating 
          ? 'Servei en funcionament' 
          : (nextBus ? `Servei programat • Proper servei a les ${nextBus.departureTime}` : `Servei fora d'horari • Represa demà a les ${firstTimeTomorrow}`)
      }
    };
  }

  // 4. In-Memory Journey Planner ("Com anar-hi")
  async planJourney(origin, destination, options = {}) {
    return transitRouter.planJourney(origin, destination, options);
  }

  // 5. Intermodal Multimodal Connections for Hubs (Rodalies R1 & Moventis e11)
  async getIntermodalConnections(stopId, options = {}) {
    return intermodalHub.getConnectionsForStop(stopId, options);
  }

  // 6. Dynamic Traffic Congestion & Slowdown Heatmap for Route Polylines
  async getLineCongestion(lineId, direction = '0') {
    const lId = String(lineId).replace(/^l/i, '');
    const dirIdx = parseInt(direction, 10) || 0;
    const routes = this.routesData[lId] || [];
    const route = routes[dirIdx] || routes[0];
    if (!route || !route.coords || route.coords.length < 2) {
      return { lineId: lId, direction: String(dirIdx), segments: [] };
    }

    // Retrieve active vehicles on this line
    const frVehicles = flightRecorder.getLineVehicles(`L${lId}`) || [];
    let liveBuses = [];
    try {
      liveBuses = await this.fetchLiveVehicles(lId);
    } catch (_) {}
    const combinedVehicles = [...frVehicles, ...(liveBuses || [])];

    const polyline = (route.coords || []).map(c => [
      parseFloat(c.Latitude),
      parseFloat(c.Longitude)
    ]);

    const stops = route.stops || [];
    const segmentCount = Math.max(4, Math.min(12, stops.length - 1 || 8));
    const step = Math.floor(polyline.length / segmentCount);
    const segments = [];

    for (let i = 0; i < segmentCount; i++) {
      const startIdx = i * step;
      const endIdx = (i === segmentCount - 1) ? polyline.length : Math.min(polyline.length, (i + 1) * step + 1);
      const coords = polyline.slice(startIdx, endIdx);
      if (coords.length < 2) continue;

      const midCoord = coords[Math.floor(coords.length / 2)];
      let segmentSpeed = 26; // Default fluid speed
      let segmentDelay = 0;
      let vehicleFound = false;

      for (const v of combinedVehicles) {
        const vLat = v.lat !== undefined ? v.lat : v.latitude;
        const vLon = v.lon !== undefined ? v.lon : v.longitude;
        if (vLat === undefined || vLon === undefined) continue;

        const dist = geoEngine.calculateDistanceMeters(vLat, vLon, midCoord[0], midCoord[1]);
        if (dist < 500) {
          const spd = Number(v.speedKmh !== undefined ? v.speedKmh : v.speed);
          if (Number.isFinite(spd) && spd >= 0) {
            segmentSpeed = spd;
            segmentDelay = Number(v.delayMinutes !== undefined ? v.delayMinutes : (v.delayMins || 0));
            vehicleFound = true;
            break;
          }
        }
      }

      let status = 'fluid';
      let color = '#10b981'; // Green
      let label = 'Fluid';

      if (segmentSpeed < 10 || segmentDelay >= 4) {
        status = 'congested';
        color = '#ef4444'; // Red
        label = 'Congestió';
      } else if (segmentSpeed < 20 || segmentDelay >= 2) {
        status = 'moderate';
        color = '#f59e0b'; // Amber
        label = 'Trànsit Dens';
      }

      segments.push({
        segmentIndex: i,
        status,
        color,
        label,
        avgSpeedKmh: Math.round(segmentSpeed),
        delayMins: Math.round(segmentDelay),
        hasLiveVehicle: vehicleFound,
        coords
      });
    }

    return {
      lineId: lId,
      lineCode: `L${lId}`,
      direction: String(dirIdx),
      segmentsCount: segments.length,
      segments
    };
  }
}

module.exports = new MataroTracker();

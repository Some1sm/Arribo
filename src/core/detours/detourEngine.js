/**
 * src/core/detours/detourEngine.js
 * 
 * Autonomous Transit Detour & Road Cut Trajectory Synthesizer
 * Parses official service notices for cancelled/provisional stops,
 * calculates detour waypoints, and synthesizes road-following detour polylines.
 */

const { fetchRoadRoute } = require('../geo/osrmClient');
const path = require('path');
const fs = require('fs');

class DetourEngine {
  constructor() {
    this.paradasMap = new Map();
    this.detourCache = new Map(); // cacheKey -> DetourData
    this.loadParadas();
  }

  loadParadas() {
    try {
      const p = path.join(__dirname, '..', '..', '..', 'data', 'cities', 'mataro', 'mataro_paradas.json');
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        const list = raw.message || [];
        list.forEach(item => {
          const cleanName = (item.name || '').replace(/ - \d+$/, '').trim();
          this.paradasMap.set(String(item.id), {
            id: String(item.id),
            name: cleanName,
            lat: Number(item.latitude),
            lon: Number(item.longitude),
            rawName: item.name
          });
        });
      }
    } catch (e) {
      console.warn('[DetourEngine] Error loading paradas:', e.message);
    }
  }

  /**
   * Fuzzy matches a stop name from notice text to an official Mataró stop.
   * @param {string} query
   * @returns {{ id: string, name: string, lat: number, lon: number }|null}
   */
  matchStopByName(query) {
    if (!query || typeof query !== 'string') return null;
    const q = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const stopWords = ['placa', 'pl.', 'pl', 'carrer', 'c.', 'ronda', 'rda.', 'rda', 'av.', 'avinguda', 'amb', 'empresa', 'casas', 'direccio', 'de', 'la', 'el', 'els', 'les', 'i', 'y', 'amb', 'con'];
    const keywords = q.split(/[\s,\-\(\)\/]+/).filter(w => w.length >= 3 && !stopWords.includes(w));

    let best = null;
    let bestScore = 0;

    for (const [id, s] of this.paradasMap.entries()) {
      const sName = (s.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      let score = 0;

      if (sName === q) score += 20;
      else if (sName.includes(q) || q.includes(sName)) score += 10;

      for (const kw of keywords) {
        if (sName.includes(kw)) score += 5;
      }

      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }

    return (best && bestScore >= 5) ? best : null;
  }

  /**
   * Parses structured detours from notice text and title.
   * Extracts affected lines, directions, cancelled stops, and provisional stops.
   * 
   * @param {string} text
   * @param {string} title
   * @returns {Array<object>}
   */
  parseNoticeDetourSections(text, title = '') {
    const fullText = (title + '\n' + text);
    const sections = [];

    // Split text by line blocks like "LÍNIA 2, DIRECCIÓ HOSPITAL" or "LÍNIA 4"
    const lineBlocks = fullText.split(/(?:LÍNIA|LINIA|LÍNEA|LINEA)\s*([1-8])/gi);

    for (let i = 1; i < lineBlocks.length; i += 2) {
      const lineNum = lineBlocks[i];
      const blockContent = lineBlocks[i + 1] || '';

      // Extract direction affinity
      let dirKeyword = 'both';
      if (/direcci[oó]\s*hospital/i.test(blockContent)) dirKeyword = 'hospital';
      else if (/direcci[oó]\s*rodalies/i.test(blockContent)) dirKeyword = 'rodalies';
      else if (/direcci[oó]\s*cerdanyola/i.test(blockContent)) dirKeyword = 'cerdanyola';
      else if (/direcci[oó]\s*cirera/i.test(blockContent)) dirKeyword = 'cirera';

      // Extract cancelled stops
      const cancelledMatches = blockContent.match(/parades?\s*anul[·\.]*lades?:\s*([^\n\r]+)/i);
      const cancelledNames = [];
      if (cancelledMatches && cancelledMatches[1]) {
        cancelledMatches[1].split(/(?:,\s*|\s+i\s+|\s+y\s+|\s+e\s+|;\s*)/i).map(s => s.trim()).filter(Boolean).forEach(s => {
          cancelledNames.push(s);
        });
      }

      // Extract provisional stops
      const provMatches = blockContent.match(/parades?\s*provisionals?:\s*([^\n\r]+)/i);
      const provNames = [];
      if (provMatches && provMatches[1]) {
        provMatches[1].split(/(?:;\s*|,\s*(?=[A-ZÀ-ÿ]))/i).map(s => s.trim()).filter(Boolean).forEach(s => {
          provNames.push(s);
        });
      }

      const cancelledStops = cancelledNames
        .map(n => this.matchStopByName(n))
        .filter(Boolean);

      const provisionalStops = provNames
        .map(n => {
          const match = this.matchStopByName(n);
          if (match) return { ...match, isProvisional: true };
          return null;
        })
        .filter(Boolean);

      if (cancelledStops.length > 0) {
        sections.push({
          lineId: String(lineNum),
          dirKeyword,
          title,
          cancelledStops,
          provisionalStops,
          rawDescription: blockContent.trim()
        });
      }
    }

    return sections;
  }

  /**
   * Synthesizes detour trajectory geometry and updated stop sequence for an active line & direction.
   * 
   * @param {string} lineId
   * @param {string} direction '0' | '1' | 'both'
   * @param {Array<object>} routeStops
   * @param {Array<object>} avisos
   * @returns {Promise<object|null>} Detour data with road-following polyline or null
   */
  async getLineDetour(lineId, direction, routeStops = [], avisos = []) {
    const lId = String(lineId).replace(/^l/i, '');
    const dirStr = String(direction || '0');
    const cacheKey = `${lId}_${dirStr}_${avisos.length}`;

    if (this.detourCache.has(cacheKey)) {
      return this.detourCache.get(cacheKey);
    }

    if (!Array.isArray(avisos) || avisos.length === 0 || !Array.isArray(routeStops) || routeStops.length < 2) {
      return null;
    }

    let activeSection = null;

    for (const aviso of avisos) {
      if (aviso.severity !== 'warning') continue;
      const sections = this.parseNoticeDetourSections(aviso.description, aviso.title);
      const match = sections.find(sec => {
        if (sec.lineId !== lId) return false;
        // Direction matching
        if (sec.dirKeyword === 'both') return true;
        const dirName = (routeStops[0]?.name + ' ' + routeStops[routeStops.length - 1]?.name).toLowerCase();
        if (sec.dirKeyword === 'hospital' && dirName.includes('hospital')) return true;
        if (sec.dirKeyword === 'rodalies' && dirName.includes('rodalies')) return true;
        return true;
      });

      if (match) {
        activeSection = match;
        break;
      }
    }

    if (!activeSection || activeSection.cancelledStops.length === 0) {
      this.detourCache.set(cacheKey, null);
      return null;
    }

    // Identify cancelled stops in current route
    const cancelledStopIds = new Set(activeSection.cancelledStops.map(s => String(s.id)));
    const cancelledIdxs = [];
    routeStops.forEach((s, idx) => {
      if (cancelledStopIds.has(String(s.id))) {
        cancelledIdxs.push(idx);
      }
    });

    if (cancelledIdxs.length === 0) {
      this.detourCache.set(cacheKey, null);
      return null;
    }

    const firstCancelledIdx = Math.min(...cancelledIdxs);
    const lastCancelledIdx = Math.max(...cancelledIdxs);

    const entryStop = routeStops[Math.max(0, firstCancelledIdx - 1)];
    const exitStop = routeStops[Math.min(routeStops.length - 1, lastCancelledIdx + 1)];

    // Build OSRM detour waypoints: [entryStop, ...provisionalStops, exitStop]
    const waypoints = [
      { lat: Number(entryStop.lat || entryStop.latitude), lon: Number(entryStop.lon || entryStop.longitude), name: entryStop.name },
      ...activeSection.provisionalStops.map(p => ({ lat: Number(p.lat), lon: Number(p.lon), name: p.name })),
      { lat: Number(exitStop.lat || exitStop.latitude), lon: Number(exitStop.lon || exitStop.longitude), name: exitStop.name }
    ];

    let detourPolyline = [];
    try {
      const roadCoords = await fetchRoadRoute(waypoints, { timeoutMs: 5000 });
      if (Array.isArray(roadCoords) && roadCoords.length > 0) {
        detourPolyline = roadCoords;
      }
    } catch (_) {}

    const detourResult = {
      hasDetour: true,
      title: activeSection.title || 'Desviament de recorregut',
      reason: activeSection.rawDescription || '',
      cancelledStops: activeSection.cancelledStops,
      provisionalStops: activeSection.provisionalStops,
      cancelledStopIds: Array.from(cancelledStopIds),
      detourPolyline,
      entryStop: { id: String(entryStop.id), name: entryStop.name, lat: entryStop.lat, lon: entryStop.lon },
      exitStop: { id: String(exitStop.id), name: exitStop.name, lat: exitStop.lat, lon: exitStop.lon }
    };

    this.detourCache.set(cacheKey, detourResult);
    return detourResult;
  }
}

module.exports = new DetourEngine();

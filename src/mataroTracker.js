const fs = require('fs');
const path = require('path');
const siriClient = require('./mataroSiriClient');
const geoEngine = require('./core/geo/geoEngine');
const timeEngine = require('./core/time/timeEngine');
const calendarEngine = require('./core/time/calendarEngine');
const scheduleSynthesizer = require('./core/schedule/scheduleSynthesizer');
const delayEngine = require('./core/schedule/delayEngine');
const mataroSchedules = require('./data/mataroSchedules');
const seasonCalendar = require('./data/seasonCalendar');
const geoUtils = require('./geoUtils');
const timeUtils = require('./timeUtils');
const flightRecorder = require('./flightRecorder');
const BaseTracker = require('./core/BaseTracker');
const transitRouter = require('./core/schedule/transitRouter');
const mataroFleet = require('./data/mataroFleet');
const verifiedTls = require('./core/http/verifiedTls');

/**
 * Resolve the timetable bucket for a moment. August weekdays run the reduced
 * summer "Dissabtes" timetable, so they must NOT be treated as ordinary
 * weekdays. This is the same rule tripMatcher.resolveDayType() applies (and
 * that test/trip_matcher_test.js asserts): the tracker's ghost synthesizer and
 * the trip matcher must agree on the bucket or a physical bus is looked up in
 * a different trip list than the one it was synthesized from.
 * All date math stays in calendarEngine (Europe/Madrid).
 */
function resolveDayType(dateObj, timeZone) {
  const c = calendarEngine.getDateComponents(dateObj, timeZone);
  let dayType = 'weekday';
  if (c.isSunday) dayType = 'sunday';
  else if (c.isSaturday || (c.isWeekday && c.isAugust)) dayType = 'saturday';
  return dayType;
}

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
    this._lineDetailsCache = new Map();
    this._lineDetailsInflight = new Map();
    this._lineCacheGen = 0;
    this.loadDatasets();
    this.precompileStaticRoutes();
    transitRouter.setTracker(this);
  }

  setAvisosRpcBackend(backend) {
    this._avisosRpcBackend = backend;
  }

  syncAvisos(avisos, timestamp) {
    this.avisosCache = structuredClone(avisos);
    this.avisosCacheTime = timestamp;
    this.invalidateLineDetailsCache();
  }

  async fetchAvisos() {
    if (this.avisosCache && Date.now() - this.avisosCacheTime < this.avisosCacheTtlMs) {
      return this.avisosCache;
    }
    if (!this._avisosInflight) {
      this._avisosInflight = (async () => {
        if (!this._avisosRpcBackend) return this._fetchAvisos();
        const previousCache = this.avisosCache;
        try {
          const result = await this._avisosRpcBackend();
          if (this.avisosCache === previousCache) this.syncAvisos(result.avisos, result.timestamp);
        } catch {}
        return this.avisosCache || [];
      })().finally(() => { this._avisosInflight = null; });
    }
    return this._avisosInflight;
  }

  async _fetchAvisos() {
    const now = Date.now();
    if (this.avisosCache && (now - this.avisosCacheTime < this.avisosCacheTtlMs)) {
      return this.avisosCache;
    }

    const AVISOS_URL = 'https://mataro.avanzagrupo.com/ca/avisos';

    const fetchOnline = () => new Promise((resolve) => {
      const https = require('https');
      const req = https.get(AVISOS_URL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Cookie': 'GUEST_LANGUAGE_ID=ca_ES'
        },
        timeout: 6000,
        // The portal serves its leaf without the Sectigo intermediate that
        // signed it, so Node cannot verify the chain. We supply the missing
        // certificates for this host instead of switching verification off:
        // these notices drive line detours and the season calendar, so an
        // unauthenticated response would let a third party publish them.
        agent: verifiedTls.agentFor('mataro.avanzagrupo.com')
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
            this.registerSeasonNotice(title, plainText, validity);

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
      // A TLS failure here means the portal's certificate chain no longer
      // matches what src/data/certs/ holds — most likely an upstream rotation.
      // Falling back to the cached notices is the right behaviour, but staying
      // silent about it would leave a stale board looking healthy, so name the
      // cause once per failure rather than swallowing it.
      req.on('error', (err) => {
        console.warn(`[MataroTracker] Avisos fetch failed — ${verifiedTls.describeChainFailure(err)}`);
        resolve(null);
      });
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });

    try {
      const onlineAvisos = await fetchOnline();
      if (Array.isArray(onlineAvisos) && onlineAvisos.length > 0) {
        this.avisosCache = onlineAvisos;
        this.avisosCacheTime = now;
        return onlineAvisos;
      }
    } catch {}

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
            this.registerSeasonNotice(title, desc, validity);
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
    } catch {}

    return this.avisosCache || [];
  }

  /**
   * Feeds a seasonal-timetable notice to the season calendar.
   *
   * The operator announces the reduced summer grid as a notice carrying its own
   * service window ("HORARIS ESTIU 2026 — Del 27 de juliol fins al 23
   * d'agost"), which parseAvisoValidity already turns into a start/end pair.
   * Registering it here means the loader does not depend on anyone maintaining
   * a hardcoded switch date that the operator may move without telling us.
   *
   * Only an explicit seasonal word counts. A notice that merely mentions a date
   * is a diversion or a cancellation, not a timetable change, and registering
   * one as a season would swap the whole network's grid over a road closure.
   *
   * The window bounds are read back as HOST-LOCAL calendar parts on purpose:
   * parseAvisoValidity built them from the operator's own wording ("27 de
   * juliol") using local Date construction, so reading them back the same way
   * round-trips the stated date exactly. The query side of the comparison is
   * Europe/Madrid, which is a different question and is handled in
   * seasonCalendar.
   */
  registerSeasonNotice(title, description, validity) {
    const text = (title + ' ' + description).normalize('NFD')
      .replace(/[̀-ͯ]/g, '').toLowerCase();
    const isSummer = /\b(estiu|verano)\b/.test(text);
    const isWinter = /\b(hivern|invierno)\b/.test(text);
    // Both words, or neither: ambiguous, so register nothing.
    if (isSummer === isWinter) return false;
    if (!validity || !validity.startsAt || !validity.expiry) return false;

    const d = validity.startsAt;
    const e = validity.expiry;
    const key = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    return seasonCalendar.registerWindow({
      from: key(d),
      to: key(e),
      season: isSummer ? 'summer' : 'winter',
      title: String(title || '').trim()
    });
  }

  parseAvisoValidity(title = '', description = '', refDate = new Date()) {
    const text = (title + ' ' + description).toLowerCase();
    const dc = calendarEngine.getDateComponents(refDate, 'Europe/Madrid');
    const currentYear = dc.year;

    // Ongoing notices without fixed end date
    if (/fins(?:\s+a)?\s+nou\s+av[ií]s|fins\s+nova\s+ordre|hasta\s+nuevo\s+aviso/i.test(text)) {
      return {
        isOngoing: true,
        startsAt: null,
        expiry: null,
        isExpired: false,
        isFuture: false,
        isEffectiveNow: true,
        effectiveWindows: []
      };
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
    const monthNamesStr = Object.keys(MONTHS).join('|');

    const windows = [];

    // Helper to check if a specific date already has a specific-hour window
    const hasSpecificHourOnDate = (y, m, d) => windows.some(w => {
      return w.start.getFullYear() === y && w.start.getMonth() === (m - 1) && w.start.getDate() === d &&
        !(w.start.getHours() === 0 && w.end.getHours() === 23 && w.end.getMinutes() === 59);
    });

    // 1. Two dates connected by 'i' or 'y' sharing hours: e.g. '14 i 15/09/2026 de 14.00 a 18.00'
    const multiDaySharedHoursRegex = /(\d{1,2})\s*(?:i|y|,)\s*(\d{1,2})[\/\.-](\d{1,2})(?:[\/\.-](\d{2,4}))?[^0-9\n\r]*?de\s+(\d{1,2})[.:](\d{2})\s+a\s+(\d{1,2})[.:](\d{2})/gi;
    let mm;
    while ((mm = multiDaySharedHoursRegex.exec(text)) !== null) {
      const d1 = parseInt(mm[1], 10);
      const d2 = parseInt(mm[2], 10);
      const m = parseInt(mm[3], 10);
      let y = mm[4] ? parseInt(mm[4], 10) : currentYear;
      if (y < 100) y += 2000;
      const hStart = parseInt(mm[5], 10), minStart = parseInt(mm[6], 10);
      const hEnd = parseInt(mm[7], 10), minEnd = parseInt(mm[8], 10);

      for (const d of [d1, d2]) {
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
          windows.push({
            start: new Date(y, m - 1, d, hStart, minStart, 0),
            end: new Date(y, m - 1, d, hEnd, minEnd, 0)
          });
        }
      }
    }

    // 2. Specific date with time interval(s):
    // e.g. '14/09/2026, de 14.00 a 18.00' or '05/09/2026 de 19.00 a 19.30 hores i de 22.00 a 22.30 hores'
    const dateTimeRegex = /(?:(\d{1,2})[\/\.-](\d{1,2})(?:[\/\.-](\d{2,4}))?|(\d{1,2})\s+de\s+([a-zç]+)(?:\s+de\s+(\d{4}))?)[^0-9\n\r]*?de\s+(\d{1,2})[.:](\d{2})\s+a\s+(\d{1,2})[.:](\d{2})(?:[^\n\r]*?i\s+de\s+(\d{1,2})[.:](\d{2})\s+a\s+(\d{1,2})[.:](\d{2}))?/gi;
    while ((mm = dateTimeRegex.exec(text)) !== null) {
      let day, month, year;
      if (mm[1]) {
        day = parseInt(mm[1], 10);
        month = parseInt(mm[2], 10);
        year = mm[3] ? parseInt(mm[3], 10) : currentYear;
        if (year < 100) year += 2000;
      } else {
        day = parseInt(mm[4], 10);
        month = MONTHS[mm[5].toLowerCase()];
        year = mm[6] ? parseInt(mm[6], 10) : currentYear;
      }
      if (!month || day < 1 || day > 31) continue;

      const startH1 = parseInt(mm[7], 10), startM1 = parseInt(mm[8], 10);
      const endH1 = parseInt(mm[9], 10), endM1 = parseInt(mm[10], 10);
      windows.push({
        start: new Date(year, month - 1, day, startH1, startM1, 0),
        end: new Date(year, month - 1, day, endH1, endM1, 0)
      });

      if (mm[11] && mm[12] && mm[13] && mm[14]) {
        const startH2 = parseInt(mm[11], 10), startM2 = parseInt(mm[12], 10);
        const endH2 = parseInt(mm[13], 10), endM2 = parseInt(mm[14], 10);
        windows.push({
          start: new Date(year, month - 1, day, startH2, startM2, 0),
          end: new Date(year, month - 1, day, endH2, endM2, 0)
        });
      }
    }

    // 3. Date ranges without specific hours: e.g. 'del 01/09 al 02/09'
    const rangeNumeric = /(?:del|des de|des del)\s+(\d{1,2})[\/\.-](\d{1,2})(?:[\/\.-](\d{2,4}))?\s+(?:al|fins al|fins el|fins a|fins|a|fins les|hasta el)\s+(\d{1,2})[\/\.-](\d{1,2})(?:[\/\.-](\d{2,4}))?/gi;
    while ((mm = rangeNumeric.exec(text)) !== null) {
      const sDay = parseInt(mm[1], 10), sMonth = parseInt(mm[2], 10);
      let sYear = mm[3] ? parseInt(mm[3], 10) : currentYear;
      if (sYear < 100) sYear += 2000;

      const eDay = parseInt(mm[4], 10), eMonth = parseInt(mm[5], 10);
      let eYear = mm[6] ? parseInt(mm[6], 10) : currentYear;
      if (eYear < 100) eYear += 2000;

      if (sMonth >= 1 && sMonth <= 12 && sDay >= 1 && sDay <= 31 && eMonth >= 1 && eMonth <= 12 && eDay >= 1 && eDay <= 31) {
        windows.push({
          start: new Date(sYear, sMonth - 1, sDay, 0, 0, 0),
          end: new Date(eYear, eMonth - 1, eDay, 23, 59, 59)
        });
      }
    }

    // 4. Named month ranges: 'del 1 al 2 de setembre'
    const namedRange = new RegExp('(?:del|des de|des del)\\s+(\\d{1,2})(?:\\s+de\\s+(' + monthNamesStr + '))?\\s+(?:al|fins al|fins el|fins a|hasta el)\\s+(\\d{1,2})\\s+de\\s+(' + monthNamesStr + ')(?:\\s+de\\s+(\\d{4}))?', 'gi');
    while ((mm = namedRange.exec(text)) !== null) {
      const sDay = parseInt(mm[1], 10);
      const eDay = parseInt(mm[3], 10);
      const eMonth = MONTHS[mm[4].toLowerCase()];
      const sMonth = mm[2] ? MONTHS[mm[2].toLowerCase()] : eMonth;
      const eYear = mm[5] ? parseInt(mm[5], 10) : currentYear;
      const sYear = eYear;
      if (sMonth && eMonth && sDay >= 1 && sDay <= 31 && eDay >= 1 && eDay <= 31) {
        windows.push({
          start: new Date(sYear, sMonth - 1, sDay, 0, 0, 0),
          end: new Date(eYear, eMonth - 1, eDay, 23, 59, 59)
        });
      }
    }

    // 5. 'fins al 02/09' or 'fins al 2 de setembre' (until date)
    const untilNumeric = /(?:fins al|fins el|fins a|fins|fins les|hasta el)\s+(\d{1,2})[\/\.-](\d{1,2})(?:[\/\.-](\d{2,4}))?/gi;
    while ((mm = untilNumeric.exec(text)) !== null) {
      const day = parseInt(mm[1], 10), month = parseInt(mm[2], 10);
      let year = mm[3] ? parseInt(mm[3], 10) : currentYear;
      if (year < 100) year += 2000;
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && !hasSpecificHourOnDate(year, month, day)) {
        windows.push({
          start: new Date(year, month - 1, day, 0, 0, 0),
          end: new Date(year, month - 1, day, 23, 59, 59)
        });
      }
    }

    // 6. Named month until date: 'fins al 2 de setembre de 2026'
    const untilNamed = new RegExp('(?:fins al|fins el|fins a|fins|hasta el)\\s+(\\d{1,2})\\s+de\\s+(' + monthNamesStr + ')(?:\\s+de\\s+(\\d{4}))?', 'gi');
    while ((mm = untilNamed.exec(text)) !== null) {
      const day = parseInt(mm[1], 10);
      const month = MONTHS[mm[2].toLowerCase()];
      const year = mm[3] ? parseInt(mm[3], 10) : currentYear;
      if (month && day >= 1 && day <= 31 && !hasSpecificHourOnDate(year, month, day)) {
        windows.push({
          start: new Date(year, month - 1, day, 0, 0, 0),
          end: new Date(year, month - 1, day, 23, 59, 59)
        });
      }
    }

    // 7. Standalone full dates: '05/09/2026'
    const standaloneNumeric = /\b(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{4})\b/g;
    while ((mm = standaloneNumeric.exec(text)) !== null) {
      const day = parseInt(mm[1], 10), month = parseInt(mm[2], 10), year = parseInt(mm[3], 10);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && !hasSpecificHourOnDate(year, month, day)) {
        windows.push({
          start: new Date(year, month - 1, day, 0, 0, 0),
          end: new Date(year, month - 1, day, 23, 59, 59)
        });
      }
    }

    // Check for any standalone time mention like 'a 22.30 hores' or 'de 22.00 a 22.30'
    const timeRegex = /(?:a|fins a|fins les|fins a les)\s+(\d{1,2})[.:](\d{2})\s*(?:h|hores)?/gi;
    let lastTimeMatch = null;
    let tMatch;
    while ((tMatch = timeRegex.exec(text)) !== null) {
      lastTimeMatch = tMatch;
    }

    if (windows.length === 0) {
      return {
        isOngoing: true,
        startsAt: null,
        expiry: null,
        isExpired: false,
        isFuture: false,
        isEffectiveNow: true,
        effectiveWindows: []
      };
    }

    // Sort windows chronologically by start time
    windows.sort((a, b) => a.start.getTime() - b.start.getTime());

    // Find latest end
    const latestWindow = [...windows].sort((a, b) => b.end.getTime() - a.end.getTime())[0];
    const expiry = new Date(latestWindow.end.getTime());

    if (lastTimeMatch && windows.every(w => w.start.getHours() === 0 && w.end.getHours() === 23)) {
      const endH = parseInt(lastTimeMatch[1], 10);
      const endM = parseInt(lastTimeMatch[2], 10);
      if (endH >= 0 && endH <= 23 && endM >= 0 && endM <= 59) {
        expiry.setHours(endH, endM, 0, 0);
      }
    }

    const startsAt = windows[0].start;
    const nowMs = refDate.getTime();
    const isExpired = expiry.getTime() < nowMs;
    const isFuture = startsAt !== null && startsAt.getTime() > nowMs;

    let isEffectiveNow = false;
    if (!isExpired && !isFuture) {
      isEffectiveNow = windows.some(w => nowMs >= w.start.getTime() && nowMs <= w.end.getTime());
    }

    return {
      isOngoing: false,
      startsAt,
      expiry,
      isExpired,
      isFuture,
      isEffectiveNow,
      effectiveWindows: windows
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

  getCancelledStopsForLine(lineId, avisos = [], targetDate = new Date()) {
    const lId = String(lineId).replace(/^l/i, '');
    const cancelledMap = new Map();
    const now = (targetDate instanceof Date && !isNaN(targetDate.getTime()))
      ? targetDate
      : (typeof targetDate === 'string' || typeof targetDate === 'number' ? new Date(targetDate) : new Date());

    for (const aviso of avisos) {
      if (aviso.severity !== 'warning' || aviso.active === false) continue;
      if (aviso.expiresAt && new Date(aviso.expiresAt).getTime() < now.getTime()) continue;
      const validity = this.parseAvisoValidity(aviso.title, aviso.description, now);
      if (validity.isExpired) continue;
      // Do NOT cancel stops if the disruption has not started yet or is not effective at this date/time
      if (validity.isFuture || !validity.isEffectiveNow) continue;

      const desc = (aviso.description || aviso.descriptionHtml || '');
      const norm = desc.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[·\.]/g, '');
      const lineBlocks = norm.split(/(?:linia|linea)\s*([1-8])/gi);

      for (let i = 1; i < lineBlocks.length; i += 2) {
        const blockLineId = String(lineBlocks[i]);
        if (blockLineId !== lId) continue;
        const block = lineBlocks[i + 1] || '';

        const match = block.match(/parad[ae]s?\s*anul+[a-z]*\s*:\s*([^\n\r]+)/i);
        if (match && match[1]) {
          const names = match[1].split(/(?:,\s*|\s+i\s+|\s+y\s+|\s+e\s+|;\s*)/i).map(s => s.trim().toLowerCase()).filter(Boolean);
          names.forEach(name => {
            const matchedIds = [];
            if (name.includes('tereses')) matchedIds.push('1060');
            if (name.includes('lepant')) matchedIds.push('1059');
            if (name.includes('isidor')) matchedIds.push('1061');
            if (name.includes('isern')) matchedIds.push('1117');
            if (name.includes('biada')) matchedIds.push('1107');
            if (name.includes('queralbs')) matchedIds.push('1044');
            if (name.includes('hospital')) matchedIds.push('1001', '1073');
            if (name.includes('caminet')) matchedIds.push('1012');
            if (name.includes('muralla')) matchedIds.push('1013');
            if (name.includes('santa anna')) matchedIds.push('1014');

            matchedIds.forEach(id => {
              cancelledMap.set(id, aviso.title);
            });
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
        for (const [, routes] of Object.entries(this.routesData)) {
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

  // Returns true if the vehicle corresponds to an actual physical bus (live GPS or dead-reckoned)
  // rather than a purely synthetic timetable ghost bus (EST_*)
  isPhysicalVehicle(b) {
    if (!b) return false;
    if (b.isGhostVehicle) return false;
    const vId = String(b.vehicleId || b.tripId || '');
    if (vId.startsWith('EST_') || vId.includes('ghost')) return false;
    return true;
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
    const vId = String(v.vehicleId);
    // Never record synthetic timetable ghost buses into physical vehicle history
    if (vId.startsWith('EST_') || v.isGhostVehicle || v.isTheoretical) return;

    const now = Date.now();
    const lId = this.normalizeLineId(v.lineId || v.lineCode);
    if (!lId) return;

    const speedNum = Number(v.speedKmh);
    const delayNum = Number(v.delayMins);
    const observedAtNum = Number(v.observedAt);

    this.vehicleHistory.set(vId, {
      vehicleId: vId,
      lineId: lId,
      direction: String(v.direction !== undefined ? v.direction : '0'),
      lat: Number(v.lat || v.latitude),
      lon: Number(v.lon || v.longitude),
      bearing: Number(v.bearing || 0),
      // Missing speed/delay stay UNKNOWN (null) — never fabricated to 25/0.
      speedKmh: Number.isFinite(speedNum) ? speedNum : null,
      hasSpeed: v.hasSpeed !== undefined ? Boolean(v.hasSpeed) : Number.isFinite(speedNum),
      delayMins: Number.isFinite(delayNum) ? delayNum : null,
      hasDelay: v.hasDelay !== undefined ? Boolean(v.hasDelay) : Number.isFinite(delayNum),
      // Ingest clock.
      lastSeen: Number(v.lastSeen || v.timestamp || now),
      // Observation clock: the last REAL upstream fix, distinct from lastSeen
      // (which any derived re-emission would refresh). Null when unknown.
      observedAt: Number.isFinite(observedAtNum) && observedAtNum > 0
        ? observedAtNum
        : (v.freshness && Number(v.freshness.observedAt)) || null,
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
      const vId = String(v.vehicleId);
      if (vId.startsWith('EST_') || v.isGhostVehicle || v.isTheoretical) continue;
      const isMataro = (v.agency || '').includes('Mataró') || (v.lineCode || '').startsWith('L');
      if (!isMataro) continue;
      this.recordVehicleState({
        ...v,
        lastSeen: v.lastSeen || now
      });
    }
    this.invalidateLineDetailsCache();
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
      } catch {
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

    if (vehicle.direction !== undefined && vehicle.direction !== null && vehicle.direction !== '') {
      const parsedDir = parseInt(vehicle.direction, 10);
      if (!isNaN(parsedDir) && parsedDir >= 0 && parsedDir < routes.length) return parsedDir;
    }
    
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

    // 4. Spatial / Geometric Fallback: Match against route polylines using GPS position and bearing
    const vLat = vehicle.lat !== undefined ? vehicle.lat : vehicle.latitude;
    const vLon = vehicle.lon !== undefined ? vehicle.lon : vehicle.longitude;
    if (vLat && vLon) {
      let bestIdx = 0;
      let minDistance = Infinity;

      for (let i = 0; i < routes.length; i++) {
        const coords = (routes[i].coords || []).map(c => ({
          lat: parseFloat(c.Latitude !== undefined ? c.Latitude : (c.lat || 0)),
          lon: parseFloat(c.Longitude !== undefined ? c.Longitude : (c.lon || 0))
        })).filter(c => !isNaN(c.lat) && !isNaN(c.lon) && (c.lat !== 0 || c.lon !== 0));

        if (coords.length < 2) continue;

        const snap = geoEngine.snapPointToPolyline(vLat, vLon, coords);
        let dist = snap.dist;

        // If vehicle bearing is available, penalize opposite direction travel along the polyline
        const vBearing = vehicle.bearing;
        if (vBearing !== undefined && vBearing !== null && snap.bearing !== undefined) {
          const bearingDiff = Math.abs((vBearing - snap.bearing + 540) % 360 - 180);
          if (bearingDiff > 100) {
            // Bus is traveling opposite to this route polyline flow
            dist += 1200;
          }
        }

        if (dist < minDistance) {
          minDistance = dist;
          bestIdx = i;
        }
      }

      return bestIdx;
    }

    return 0;
  }

  /**
   * Trajectory Continuity & Identity Stitching:
   * Avanza SIRI occasionally drops <VehicleRef>, sending anonymous tags like <VehicleRef>Bus</VehicleRef>.
   * This method inspects incoming live vehicles, identifies anonymous pings, and matches them to
   * active physical vehicles from vehicleHistory on this line seen within the last 90 seconds.
   * By restoring the physical vehicle ID to the live GPS fix:
   * 1. The live bus displays with its true vehicle fleet ID (e.g. #2683).
   * 2. Dead-reckoning recognises the vehicle as actively transmitting live GPS and skips creating a duplicate clone.
   * 3. Legitimate bus bunching (multiple physical buses running close together) is fully preserved without coarse distance suppression.
   *
   * @param {Array} liveVehicles Raw live telemetry vehicles
   * @param {string} lineId Normalized line ID (e.g. '1')
   * @param {Array} routes Array of route objects for this line
   * @param {Date|number} [referenceDate=new Date()] Reference date/time for evaluation
   * @returns {Array} Stitched live vehicles array
   */
  stitchAnonymousVehicles(liveVehicles, lineId, routes, referenceDate = new Date()) {
    if (!Array.isArray(liveVehicles) || liveVehicles.length === 0) {
      return liveVehicles || [];
    }

    const isAnonymous = (v) => {
      if (!v) return true;
      const rawId = v.vehicleId !== undefined && v.vehicleId !== null ? String(v.vehicleId).trim() : '';
      if (!rawId) return true;
      const lower = rawId.toLowerCase();
      return lower === 'bus' || lower === 'vehicle' || lower === 'unknown';
    };

    const hasAnonymous = liveVehicles.some(isAnonymous);
    if (!hasAnonymous) {
      return liveVehicles;
    }

    const now = (referenceDate instanceof Date)
      ? referenceDate.getTime()
      : (typeof referenceDate === 'number' ? referenceDate : Date.now());

    // 1. Identify all active physical vehicle IDs already transmitting in this batch
    const activeKnownIds = new Set();
    liveVehicles.forEach(v => {
      if (!isAnonymous(v)) {
        activeKnownIds.add(String(v.vehicleId).trim());
      }
    });

    // 2. Collect eligible candidate vehicles from vehicleHistory (seen within 90s, same line, not synthetic, not already transmitting)
    const eligibleCandidates = [];
    for (const [vId, hist] of this.vehicleHistory.entries()) {
      const cleanVid = String(vId).trim();
      if (!cleanVid || isAnonymous({ vehicleId: cleanVid })) continue;
      if (cleanVid.startsWith('EST_') || hist.isGhostVehicle || hist.isTheoretical) continue;
      if (String(hist.lineId) !== String(lineId)) continue;
      if (activeKnownIds.has(cleanVid)) continue;

      const elapsedSec = (now - (hist.lastSeen || 0)) / 1000;
      if (Math.abs(elapsedSec) <= 90) {
        eligibleCandidates.push({
          vehicleId: cleanVid,
          direction: hist.direction,
          lat: hist.lat,
          lon: hist.lon,
          bearing: hist.bearing,
          speedKmh: hist.speedKmh,
          delayMins: hist.delayMins,
          lineName: hist.lineName,
          directionName: hist.directionName,
          origin: hist.origin,
          destination: hist.destination,
          elapsedSec: Math.max(0, elapsedSec)
        });
      }
    }

    if (eligibleCandidates.length === 0) {
      return liveVehicles;
    }

    // 3. For each anonymous vehicle, find the best matching candidate along the route polyline
    const claimedCandidates = new Set();

    liveVehicles.forEach(anon => {
      if (!isAnonymous(anon)) return;

      const anonLat = anon.lat !== undefined ? anon.lat : anon.latitude;
      const anonLon = anon.lon !== undefined ? anon.lon : anon.longitude;
      if (!anonLat || !anonLon) return;

      // Determine route/direction of anonymous fix
      const anonDirIdx = this.matchVehicleToRouteIndex(anon, routes);

      let bestCandidate = null;
      let bestScore = Infinity;

      for (const candidate of eligibleCandidates) {
        if (claimedCandidates.has(candidate.vehicleId)) continue;

        const dist = geoEngine.calculateDistanceMeters(candidate.lat, candidate.lon, anonLat, anonLon);
        // Plausible movement window: bus traveling at max 72 km/h (20 m/s) + buffer for GPS jitter
        const maxPlausibleDist = Math.max(400, (candidate.elapsedSec + 15) * 22);
        if (dist > maxPlausibleDist) continue;

        // Direction alignment score
        const dirMatch = (candidate.direction !== undefined && candidate.direction !== null)
          ? (String(candidate.direction) === String(anonDirIdx))
          : true;

        // Score prioritizing direction match and closest distance
        const score = dist + (dirMatch ? 0 : 2500);

        if (score < bestScore) {
          bestScore = score;
          bestCandidate = candidate;
        }
      }

      if (bestCandidate) {
        claimedCandidates.add(bestCandidate.vehicleId);
        activeKnownIds.add(bestCandidate.vehicleId);

        // Stitch identity onto the live vehicle
        anon.vehicleId = bestCandidate.vehicleId;
        anon.stitchedFromHistory = true;
        if (!anon.lineName && bestCandidate.lineName) anon.lineName = bestCandidate.lineName;
        if (!anon.directionName && bestCandidate.directionName) anon.directionName = bestCandidate.directionName;
        if (!anon.origin && bestCandidate.origin) anon.origin = bestCandidate.origin;
        if (!anon.destination && bestCandidate.destination) anon.destination = bestCandidate.destination;

        // Update vehicleHistory with the fresh live GPS fix
        this.vehicleHistory.set(String(bestCandidate.vehicleId), {
          ...this.vehicleHistory.get(bestCandidate.vehicleId),
          vehicleId: bestCandidate.vehicleId,
          lineId: String(lineId),
          direction: String(anonDirIdx),
          lat: anonLat,
          lon: anonLon,
          bearing: anon.bearing !== undefined ? anon.bearing : bestCandidate.bearing,
          speedKmh: anon.speedKmh !== undefined ? anon.speedKmh : bestCandidate.speedKmh,
          delayMins: anon.delayMins !== undefined ? anon.delayMins : bestCandidate.delayMins,
          lastSeen: now,
          directionName: anon.directionName || bestCandidate.directionName,
          origin: anon.origin || bestCandidate.origin,
          destination: anon.destination || bestCandidate.destination
        });

        // Clean up dummy 'Bus' / 'bus' entry if present in vehicleHistory
        this.vehicleHistory.delete('Bus');
        this.vehicleHistory.delete('bus');
      }
    });

    return liveVehicles;
  }

  async getLineDetails(lineId, direction = '0', options = {}) {
    if (typeof direction === 'object' && direction !== null) {
      options = direction;
      direction = '0';
    }
    const lId = this.normalizeLineId(lineId) || '1';
    if (!/^[1-8]$/.test(lId) || !options || Object.getPrototypeOf(options) !== Object.prototype || Object.keys(options).length) {
      return this._computeLineDetails(lineId, direction, options);
    }
    const dirKey = direction === 'both' ? 'both' : String(parseInt(direction, 10) || 0);
    const now = Date.now();
    const bucket = Math.floor(now / 1000);
    const generation = this._lineCacheGen;
    const source = siriClient.cache.get(`veh_${lId}`);
    const sourceFresh = source && now - source.ts < siriClient.cacheTtlMs;
    const key = `${lId}_${dirKey}`;
    const cached = this._lineDetailsCache.get(key);
    if (sourceFresh && cached && cached.bucket === bucket && cached.source === source && cached.generation === generation) {
      return structuredClone(cached.result);
    }
    const inflightKey = `${key}_${bucket}_${generation}`;
    let pending = this._lineDetailsInflight.get(inflightKey);
    if (!pending || pending.source !== source) {
      const promise = Promise.resolve().then(() => this._computeLineDetails(lId, dirKey)).then(result => {
        if (generation === this._lineCacheGen && bucket === Math.floor(Date.now() / 1000) && source === siriClient.cache.get(`veh_${lId}`)) {
          this._lineDetailsCache.set(key, { result, source: siriClient.cache.get(`veh_${lId}`), bucket, generation });
          if (this._lineDetailsCache.size > 24) this._lineDetailsCache.delete(this._lineDetailsCache.keys().next().value);
        }
        return result;
      }).finally(() => {
        if (this._lineDetailsInflight.get(inflightKey)?.promise === promise) this._lineDetailsInflight.delete(inflightKey);
      });
      pending = { promise, source };
      this._lineDetailsInflight.set(inflightKey, pending);
    }
    return structuredClone(await pending.promise);
  }

  invalidateLineDetailsCache() {
    this._lineCacheGen++;
    this._lineDetailsCache.clear();
  }

  async _computeLineDetails(lineId, direction = '0', options = {}) {
    if (typeof direction === 'object' && direction !== null) {
      options = direction;
      direction = '0';
    }
    const lId = this.normalizeLineId(lineId) || '1';
    const isBoth = direction === 'both';
    const dirIdx = isBoth ? 0 : (parseInt(direction, 10) || 0);
    const cacheKey = `${lId}_${direction}`;
    const staticTemplate = this.staticLineCache.get(cacheKey) || this.staticLineCache.get(`${lId}_0`);

    const targetDate = (options instanceof Date || typeof options === 'string' || typeof options === 'number')
      ? new Date(options)
      : (options.dateObj ? new Date(options.dateObj) :
        (options.targetDate ? new Date(options.targetDate) :
        (options.referenceDate ? new Date(options.referenceDate) : new Date())));

    const lineInfo = this.linesData.find(l => String(l.id) === lId) || { id: lId, name: `Línia ${lId}`, color: '#009485' };
    const routes = this.routesData[lId] || [];
    const selectedRoute = routes[dirIdx] || routes[0] || { coords: [], stops: [] };
    const polyline = staticTemplate ? staticTemplate.polyline : (selectedRoute.coords || []).map(c => [parseFloat(c.Latitude), parseFloat(c.Longitude)]);
    const stops = staticTemplate ? staticTemplate.stops : [];
    const allDirections = staticTemplate ? staticTemplate.allDirections : [];

    // Fetch Live Buses via SIRI
    let liveVehicles = [];
    if (!options.skipSiri) {
      try {
        liveVehicles = await siriClient.getLiveVehicles(lId);
      } catch {}
    }

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

    // Operational Hours Gate: Compute line scheduled fleet requirement dynamically from timetable
    const targetDateComp = calendarEngine.getDateComponents(targetDate, this.agencyTimezone);
    const targetDayType = resolveDayType(targetDate, this.agencyTimezone);
    const targetDateSec = (targetDateComp.hour || 0) * 3600 + (targetDateComp.minute || 0) * 60 + (targetDateComp.second || 0);
    const lineMaxFleet = mataroSchedules.getScheduledFleetRequirement(lId, targetDayType, targetDateSec);

    // If line has 0 scheduled fleet (service ended for the day), residual telemetry or stale ghosts must NEVER circulate
    if (lineMaxFleet > 0) {
      if (!liveVehicles || liveVehicles.length === 0) {
        const frVehs = flightRecorder.getLineVehicles(`L${lId}`);
        const mataroVehs = (frVehs || []).filter(v => (v.agency || '').includes('Mataró') || String(v.lineId) === lId);
        if (mataroVehs.length > 0) {
          liveVehicles = mataroVehs;
        }
      }

      // Trajectory Continuity & Identity Stitching:
      // Restore dropped fleet IDs on live GPS fixes before direction assignment and dead-reckoning
      if (Array.isArray(liveVehicles) && liveVehicles.length > 0) {
        this.stitchAnonymousVehicles(liveVehicles, lId, routes, targetDate);
      }

      // Fallback: If still empty, check this.vehicleHistory for active/recent buses (strict 90s window, §7.6)
      if (!liveVehicles || liveVehicles.length === 0) {
        const now = targetDate.getTime();
        const histVehs = [];
        for (const [, hist] of this.vehicleHistory.entries()) {
          if (String(hist.lineId) === String(lId) && (now - hist.lastSeen) <= 90000) {
            // This is a re-emission of our OWN previous output. It is flagged
            // estimated and carries the real underlying fix time (observedAt)
            // rather than the re-emit moment, so it can never be mistaken for a
            // fresh observation further down the pipeline (D1).
            const histObservedAt = Number(hist.observedAt) || null;
            histVehs.push({
              vehicleId: hist.vehicleId,
              lineId: hist.lineId,
              direction: hist.direction,
              directionName: hist.directionName,
              origin: hist.origin,
              destination: hist.destination,
              lat: hist.lat,
              lon: hist.lon,
              bearing: hist.bearing,
              speedKmh: Number.isFinite(hist.speedKmh) ? hist.speedKmh : null,
              hasSpeed: hist.hasSpeed !== undefined ? Boolean(hist.hasSpeed) : Number.isFinite(hist.speedKmh),
              delayMins: Number.isFinite(hist.delayMins) ? hist.delayMins : null,
              hasDelay: hist.hasDelay !== undefined ? Boolean(hist.hasDelay) : Number.isFinite(hist.delayMins),
              isEstimated: true,
              isRealTime: false,
              observedAt: histObservedAt,
              freshness: { source: 'position', fetchedAt: now, observedAt: histObservedAt },
              timestamp: hist.lastSeen
            });
          }
        }
        if (histVehs.length > 0) {
          liveVehicles = histVehs;
        }
      }
    } else {
      liveVehicles = [];
    }

    // Apply Deterministic Direction Matching & Road-Snapping with 10-minute dead reckoning
    // Always process live vehicles for all directions to establish full line fleet ground truth
    const isMultiDir = routes.length > 1;
    liveVehicles.forEach(v => {
      if (v.direction === undefined || v.direction === null || v.direction === '') {
        v.direction = String(isMultiDir ? this.matchVehicleToRouteIndex(v, routes) : 0);
      }
    });

    const vehs0 = isMultiDir ? liveVehicles.filter(v => String(v.direction) === '0') : liveVehicles;
    const vehs1 = isMultiDir ? liveVehicles.filter(v => String(v.direction) === '1') : [];

    const stops0 = (allDirections && allDirections[0]?.stops) || routes[0]?.stops || stops;
    const stops1 = (allDirections && allDirections[1]?.stops) || routes[1]?.stops || stops;

    const buses0 = this.processBusesWithDeadReckoning(vehs0, routes[0] || selectedRoute, stops0, '0', liveVehicles, targetDate);
    const buses1 = isMultiDir ? this.processBusesWithDeadReckoning(vehs1, routes[1], stops1, '1', liveVehicles, targetDate) : [];

    let allLineProcessedBuses = [...buses0, ...buses1];

    // Strict deduplication by vehicleId (Live GPS strictly takes precedence over estimated dead-reckoning)
    const uniqueBusesMap = new Map();
    allLineProcessedBuses.forEach(b => {
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
    allLineProcessedBuses = Array.from(uniqueBusesMap.values()).map(b => {
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

    // Synthesize missing scheduled vehicles for trips operating without GPS telemetry across the whole line
    const { syntheticBuses, fleetStatus } = this.synthesizeMissingScheduledBuses(
      lId,
      direction,
      routes,
      allDirections,
      allLineProcessedBuses,
      targetDate,
      liveVehicles
    );

    let processedBuses = isBoth
      ? allLineProcessedBuses
      : allLineProcessedBuses.filter(b => String(b.direction) === String(dirIdx));

    if (syntheticBuses.length > 0) {
      processedBuses = [...processedBuses, ...syntheticBuses];
    }

    // Fleet Ceiling Guard: Physical buses (live GPS & dead-reckoned) strictly take priority over synthetic ghost buses.
    // The combined fleet can never exceed the line's scheduled capacity at this hour (both whole-line and per-direction).
    const maxFleetLimit = isBoth ? lineMaxFleet : (lineMaxFleet === 0 ? 0 : Math.max(1, Math.ceil(lineMaxFleet / Math.max(1, routes.length))));
    if (maxFleetLimit === 0) {
      processedBuses = [];
    } else if (processedBuses.length > maxFleetLimit) {
      const physicalBuses = processedBuses.filter(b => this.isPhysicalVehicle(b));
      const syntheticVehicles = processedBuses.filter(b => !this.isPhysicalVehicle(b));
      const cappedPhysical = physicalBuses.slice(0, maxFleetLimit);
      const remainingSlots = Math.max(0, maxFleetLimit - cappedPhysical.length);
      processedBuses = [...cappedPhysical, ...syntheticVehicles.slice(0, remainingSlots)];
    }

    const hasLiveGps = maxFleetLimit > 0 && processedBuses.some(b => !b.isEstimated);
    const isOnlyEstimated = maxFleetLimit > 0 && processedBuses.length > 0 && processedBuses.every(b => b.isEstimated);
    const disruptions = await this.getDisruptions(lId);
    const cancelledStopsMap = this.getCancelledStopsForLine(lId, disruptions, targetDate);

    const stopsWithStatus = (stops || []).map(s => {
      const sId = String(s.id);
      const isCancelled = cancelledStopsMap.has(sId);
      return {
        ...s,
        isCancelled,
        cancelledReason: isCancelled ? cancelledStopsMap.get(sId) : null
      };
    });

    const allDirsWithStatus = (allDirections || []).map(dir => ({
      ...dir,
      stops: (dir.stops || []).map(s => {
        const sId = String(s.id);
        const isCancelled = cancelledStopsMap.has(sId);
        return {
          ...s,
          isCancelled,
          cancelledReason: isCancelled ? cancelledStopsMap.get(sId) : null
        };
      })
    }));

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
      secondaryCoords: (isBoth && allDirsWithStatus.length > 1) ? allDirsWithStatus[1].polyline : null,
      secondaryStops: (isBoth && allDirsWithStatus.length > 1) ? allDirsWithStatus[1].stops : null,
      secondaryColor: '#38bdf8',
      allDirections: allDirsWithStatus,
      activeBuses: processedBuses,
      totalActiveBuses: processedBuses.length,
      fleetStatus: (lineMaxFleet === 0 || maxFleetLimit === 0) ? {
        scheduledVehicles: 0,
        liveGpsVehicles: 0,
        estimatedVehicles: 0,
        fleetCoveragePct: 100
      } : fleetStatus,
      isRealTime: hasLiveGps,
      isEstimated: isOnlyEstimated,
      isScheduleBaseline: processedBuses.length === 0,
      lastSyncTimestamp: Date.now(),
      disruptions
    };
  }

  // Dead-Zone Position Estimation (Dead-Reckoning along Polyline)
  processBusesWithDeadReckoning(liveBuses, route, stops, dirId = '0', allLineLiveVehicles = liveBuses, targetDate = new Date()) {
    const now = (targetDate && typeof targetDate.getTime === 'function') ? targetDate.getTime() : Date.now();
    const result = [];
    const polyCoords = (route.coords || []).map(c => ({ lat: parseFloat(c.Latitude), lon: parseFloat(c.Longitude) }));

    // 1. Process active live buses
    liveBuses.forEach(b => {
      // Snap raw GPS strictly to road polyline
      const snapped = geoEngine.snapPointToPolyline(b.lat, b.lon, polyCoords);
      const roadLat = Math.round(snapped.lat * 1000000) / 1000000;
      const roadLon = Math.round(snapped.lon * 1000000) / 1000000;
      const roadBearing = snapped.bearing || b.bearing || 0;

      // Speed: a missing measurement stays UNKNOWN (null). A measured 0 (bus
      // genuinely stopped) stays 0 and remains distinguishable from "no data".
      const speedNum = Number(b.speedKmh);
      const hasSpeed = b.hasSpeed !== undefined ? Boolean(b.hasSpeed) : Number.isFinite(speedNum);
      const speedKmh = hasSpeed && Number.isFinite(speedNum) ? speedNum : null;

      // Record to vehicle history (drives the dead-reckoning fallback below).
      this.vehicleHistory.set(String(b.vehicleId), {
        vehicleId: b.vehicleId,
        lineId: b.lineId,
        direction: dirId,
        lat: roadLat,
        lon: roadLon,
        bearing: roadBearing,
        speedKmh,
        hasSpeed,
        delayMins: b.delayMins !== undefined && Number.isFinite(Number(b.delayMins)) ? Number(b.delayMins) : null,
        lastSeen: now,
        // Observation clock: the real fix time, when the feed supplied one.
        // Null when unknown — never the re-emit moment.
        observedAt: (b.freshness && Number(b.freshness.observedAt)) || Number(b.observedAt) || null,
        directionName: b.directionName,
        origin: b.origin,
        destination: b.destination
      });

      // Calculate progress and segment along stops
      const segInfo = this.findNearestSegment(roadLat, roadLon, stops, polyCoords);

      // Sanity check for terminal layovers / ghost buses (e.g. parked at terminus).
      // Keyed on a REAL speed measurement: an unknown speed is not a confirmed
      // measurement, so it is treated as "not confirmed moving" here rather
      // than silently defaulting to a fabricated 25 km/h (D3).
      const isTerminal = (hasSpeed ? speedKmh <= 3 : true) &&
        ((segInfo.totalProgress > 92 && segInfo.distanceToNextMeters <= 50) || segInfo.totalProgress < 8);
      // GPS Freshness Invariant: A vehicle is ONLY live GPS if its fix was observed within the last 45 seconds (§7.6)
      const busAgeSec = Math.max(0, (now - (b.timestamp || b.lastSeen || now)) / 1000);
      const isStaleFix = busAgeSec > 45;
      const isEst = Boolean(b.isEstimated) || isStaleFix;
      // Delay: "not reported by the feed" stays UNKNOWN (null) and is flagged,
      // so it is never coerced to a measured 0 (which would read as punctual).
      const hasDelay = b.hasDelay !== undefined
        ? Boolean(b.hasDelay)
        : Number.isFinite(Number(b.delayMins));
      const rawDelayMins = hasDelay ? Number(b.delayMins) : null;
      const isGhostDelay = !isEst && isTerminal && rawDelayMins !== null && rawDelayMins > 10;
      // A reported delay is clamped to a plausible band; an unreported one is
      // NOT invented (stays null and is advertised as unknown).
      const cleanDelayMins = isGhostDelay
        ? 0
        : (rawDelayMins === null ? null : Math.max(-15, Math.min(300, rawDelayMins)));
      const cleanDelayFormatted = !hasDelay || cleanDelayMins === null
        ? 'Sense dades de retard'
        : (isEst
            ? '⚡ Estimació en circuit'
            : (isGhostDelay
                ? 'Regulant a capçalera'
                : (cleanDelayMins > 0 ? `+${cleanDelayMins} min retard` : (cleanDelayMins < 0 ? `${cleanDelayMins} min avançat` : 'Puntual'))));
      const statusText = isEst
        ? (isStaleFix ? `⚡ Estimació (${Math.round(busAgeSec)}s sense GPS)` : '⚡ Estimació per pèrdua temporal de senyal')
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
        speedKmh,
        hasSpeed,
        delayMins: cleanDelayMins,
        hasDelay: hasDelay && cleanDelayMins !== null,
        delayFormatted: cleanDelayFormatted,
        delayBadgeText: isEst ? '⚡ En ruta (Estimat)' : cleanDelayFormatted,
        isEstimated: isEst,
        isRealTime: !isEst,
        freshness: b.freshness || (isEst ? { source: 'position', fetchedAt: now, observedAt: null } : undefined),
        // Real observation time, threaded so the daemon/recorder can keep a
        // distinct observation clock (D2). Null when unknown.
        observedAt: (b.freshness && Number(b.freshness.observedAt)) || Number(b.observedAt) || null,
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

    // 2. Dead-Reckoning: Check if any recently tracked vehicles lost signal in dead zones (strict 90s window, §7.6)
    for (const [vId, hist] of this.vehicleHistory.entries()) {
      if (String(vId).startsWith('EST_') || hist.isGhostVehicle || hist.isTheoretical) {
        this.vehicleHistory.delete(vId);
        continue;
      }
      if (String(hist.lineId) !== String(route.id_linea)) continue;
      if (String(hist.direction) !== String(dirId)) continue; // Only dead-reckon on the matching direction
      const elapsedSec = (now - hist.lastSeen) / 1000;

      if (elapsedSec > 90) {
        this.vehicleHistory.delete(vId);
        continue;
      }

      // If vehicle is live on ANY direction of this line, do not dead-reckon it
      const isCurrentlyActive = (allLineLiveVehicles || liveBuses).some(b => String(b.vehicleId) === String(vId));
      // Only project a position when we have a REAL speed measurement. An
      // unknown speed is not a confirmed measurement, so we do not invent a
      // motion vector for it (D3).
      const histHasSpeed = Number.isFinite(hist.speedKmh);
      if (!isCurrentlyActive && histHasSpeed && elapsedSec >= 1 && elapsedSec <= 90) {
        const estPos = geoEngine.extrapolatePolylinePosition(hist, elapsedSec, hist.speedKmh, polyCoords);
        if (estPos) {
          // Anti-bunching & duplicate guard: Never dead-reckon if an active physical bus on this direction is within 600m
          const isBunchedWithPhysical = (allLineLiveVehicles || liveBuses).some(b => {
            const bDir = (b.direction !== undefined && b.direction !== null && b.direction !== '') ? String(b.direction) : null;
            if (bDir !== null && bDir !== String(dirId)) return false;
            const bLat = b.lat || b.latitude;
            const bLon = b.lon || b.longitude;
            if (!bLat || !bLon) return false;
            return geoEngine.calculateDistanceMeters(estPos.lat, estPos.lon, bLat, bLon) < 600;
          });
          if (isBunchedWithPhysical) continue;

          const segInfo = this.findNearestSegment(estPos.lat, estPos.lon, stops, polyCoords);
          const elapsedMin = Math.floor(elapsedSec / 60);
          const elapsedText = elapsedMin > 0 ? `${elapsedMin} min` : `${Math.round(elapsedSec)}s`;

          // Carry the real underlying fix time (never the re-emit moment) so a
          // re-ingest of this estimate cannot refresh the observation clock (D1).
          const histObservedAt = Number(hist.observedAt) || null;
          const histHasDelay = Number.isFinite(hist.delayMins);

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
            speedKmh: Math.max(15, Math.min(45, hist.speedKmh)),
            hasSpeed: true,
            delayMins: histHasDelay ? hist.delayMins : null,
            hasDelay: histHasDelay,
            delayFormatted: histHasDelay ? (hist.delayMins > 0 ? `+${hist.delayMins} min retard` : 'Puntual') : 'Sense dades de retard',
            isEstimated: true,
            isRealTime: false,
            observedAt: histObservedAt,
            freshness: { source: 'position', fetchedAt: now, observedAt: histObservedAt },
            recordedAt: new Date(histObservedAt || hist.lastSeen).toISOString(),
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
    const dayType = resolveDayType(dateObj, this.agencyTimezone);
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

    // Also include recently active physical vehicles from vehicleHistory (seen within 90s)
    // so momentary network drops cannot falsely deplete the known physical fleet.
    // Only check vehicleHistory when evaluating real-time live conditions (within 2 min of wall clock).
    const isLiveEvaluation = Math.abs(Date.now() - nowMs) <= 120000;
    if (isLiveEvaluation) {
      for (const [vId, hist] of this.vehicleHistory.entries()) {
        if (String(hist.lineId) !== String(lId)) continue;
        if (String(vId).startsWith('EST_') || hist.isGhostVehicle || hist.isTheoretical) continue;
        const elapsed = (nowMs - (hist.lastSeen || nowMs)) / 1000;
        if (elapsed >= 0 && elapsed <= 90) {
          if (!allKnownBuses.some(b => String(b.vehicleId || b.tripId) === String(vId))) {
            allKnownBuses.push({
              vehicleId: hist.vehicleId,
              tripId: `mataro_${hist.vehicleId}`,
              lineId: hist.lineId,
              direction: hist.direction,
              lat: hist.lat,
              lon: hist.lon,
              latitude: hist.lat,
              longitude: hist.lon,
              isEstimated: true,
              isRealTime: false,
              timestamp: hist.lastSeen
            });
          }
        }
      }
    }

    allKnownBuses.forEach(b => {
      if ((b.direction === undefined || b.direction === null || b.direction === '') && routes && routes.length > 1) {
        b.direction = String(this.matchVehicleToRouteIndex(b, routes));
      }
    });

    const dirIdx = isBoth ? 0 : (parseInt(direction, 10) || 0);
    const allDirKeys = (routes && routes.length > 1) ? ['0', '1'] : ['0'];

    // 2. Pre-calculate active scheduled trips (both in transit AND terminal layovers) across the whole line
    let totalScheduledForWholeLine = 0;
    const allLineActiveTripsByDir = { '0': [], '1': [] };

    allDirKeys.forEach(dKey => {
      const s = mataroSchedules.getDirectionSchedule(lId, dKey, dayType);
      if (!s || !Array.isArray(s.departures)) return;
      const travelSec = s.totalTravelSec || (s.totalTravelMinutes * 60) || 1800;
      const oppDKey = dKey === '0' ? '1' : '0';
      const oppS = mataroSchedules.getDirectionSchedule(lId, oppDKey, dayType);
      const oppPhysicalBuses = allKnownBuses.filter(b => String(b.direction) === oppDKey && this.isPhysicalVehicle(b));
      const physicalBusesForThisDir = allKnownBuses.filter(b => String(b.direction) === dKey && this.isPhysicalVehicle(b));
      const trips = [];
      let foundLayover = false;

      s.departures.forEach(depTime => {
        const depSec = timeEngine.timeStringToSeconds(depTime);
        const arrSec = depSec + travelSec;

        // A. Trip is currently in transit along the route:
        // Normally within scheduled window (nowSec < arrSec).
        // If nowSec >= arrSec, only retain trip if a physical bus is still circulating on this direction to claim it.
        const hasDelayedLiveBus = physicalBusesForThisDir.length > 0 && physicalBusesForThisDir.some(b => {
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
              oppStillInTransit = oppPhysicalBuses.some(b => {
                const bProg = (b.totalProgress !== undefined ? b.totalProgress : 50) / 100;
                const diff = Math.abs(theoreticalOppProgress - bProg);
                const notYetAtTerminal = (b.totalProgress !== undefined ? b.totalProgress : 50) < 85;
                return theoreticalOppProgress <= 1.20 && diff <= 0.35 && notYetAtTerminal;
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

    const totalLiveOnWholeLine = allKnownBuses.filter(b => !b.isEstimated && this.isPhysicalVehicle(b)).length;
    const totalPhysicalOnWholeLine = allKnownBuses.filter(b => this.isPhysicalVehicle(b)).length;
    // Whole-line cap: strictly capped by physical line fleet minus all active physical vehicles (live GPS or dead-reckoned)
    const maxSyntheticForLine = Math.max(0, totalScheduledForWholeLine - totalPhysicalOnWholeLine);

    // 3. Pair live buses on each direction to active trips
    allDirKeys.forEach(dirKey => {
      const dirIndex = parseInt(dirKey, 10) || 0;
      const routeObj = routes[dirIndex] || routes[0];
      if (!routeObj) return;

      const rawCoords = (routeObj.coords || []).map(c => ({
        lat: parseFloat(c.Latitude !== undefined ? c.Latitude : (c.lat || 0)),
        lon: parseFloat(c.Longitude !== undefined ? c.Longitude : (c.lon || 0))
      })).filter(c => !isNaN(c.lat) && !isNaN(c.lon) && (c.lat !== 0 || c.lon !== 0));
      if (rawCoords.length < 2) return;

      const distTable = geoEngine.buildPolylineDistanceTable(rawCoords);
      if (distTable.total <= 0) return;

      const activeTripsForDir = allLineActiveTripsByDir[dirKey] || [];
      const originPt = rawCoords[0];
      const physicalBusesOnDir = allKnownBuses.filter(b => String(b.direction) === dirKey && this.isPhysicalVehicle(b));

      // (a) First pair stationary buses at the origin terminal (< 350m) to terminal layover trip
      // (b) Then pair in-transit buses to their closest in-transit trip by route progress
      physicalBusesOnDir.forEach(bus => {
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

      // Cross-Direction Pairing:
      // If an incoming bus on the opposite direction is completing its trip at this terminal
      // (progress >= 85% and within 400m of the terminal), it will take the layover/turnaround trip!
      const oppDirKey = dirKey === '0' ? '1' : '0';
      const oppPhysicalBuses = allKnownBuses.filter(b => String(b.direction) === oppDirKey && this.isPhysicalVehicle(b));

      activeTripsForDir.forEach(trip => {
        if (trip.paired) return;
        if (trip.isTerminalLayover || trip.progress <= 0.20) {
          const incomingBus = oppPhysicalBuses.find(b => {
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
    });

    // 4. Collect and prioritize all unserved candidate trips across the entire line
    const candidateTrips = [];
    allDirKeys.forEach(dirKey => {
      const dirIndex = parseInt(dirKey, 10) || 0;
      const sched = mataroSchedules.getDirectionSchedule(lId, dirKey, dayType);
      if (!sched || !Array.isArray(sched.departures) || sched.departures.length === 0) return;

      const routeObj = routes[dirIndex] || routes[0];
      if (!routeObj) return;

      const rawCoords = (routeObj.coords || []).map(c => ({
        lat: parseFloat(c.Latitude !== undefined ? c.Latitude : (c.lat || 0)),
        lon: parseFloat(c.Longitude !== undefined ? c.Longitude : (c.lon || 0))
      })).filter(c => !isNaN(c.lat) && !isNaN(c.lon) && (c.lat !== 0 || c.lon !== 0));
      if (rawCoords.length < 2) return;

      const distTable = geoEngine.buildPolylineDistanceTable(rawCoords);
      if (distTable.total <= 0) return;

      const activeTripsForDir = allLineActiveTripsByDir[dirKey] || [];
      const physicalBusesOnDir = allKnownBuses.filter(b => String(b.direction) === dirKey && this.isPhysicalVehicle(b));
      const maxFleetForDir = Math.max(1, Math.ceil(lineMaxFleet / Math.max(1, allDirKeys.length)));
      const maxSyntheticForDir = Math.max(0, Math.min(activeTripsForDir.length, maxFleetForDir) - physicalBusesOnDir.length);

      activeTripsForDir.forEach(trip => {
        if (trip.paired) return;
        if (!trip.isTerminalLayover && nowSec >= trip.arrSec) return;

        candidateTrips.push({
          trip,
          dirKey,
          dirIndex,
          sched,
          routeObj,
          rawCoords,
          distTable,
          maxSyntheticForDir,
          originPt: rawCoords[0]
        });
      });
    });

    // Priority sort across the line: in-transit trips first (already active on route), then terminal layovers
    candidateTrips.sort((a, b) => {
      const prioA = a.trip.isTerminalLayover ? 1 : 0;
      const prioB = b.trip.isTerminalLayover ? 1 : 0;
      if (prioA !== prioB) return prioA - prioB;
      return a.trip.depSec - b.trip.depSec;
    });

    // 5. Synthesize ghost buses up to the line fleet cap
    const allSyntheticBuses = [];
    for (const cand of candidateTrips) {
      if (allSyntheticBuses.length >= maxSyntheticForLine) break;

      const synthOnThisDir = allSyntheticBuses.filter(b => b.direction === String(cand.dirKey)).length;
      if (synthOnThisDir >= cand.maxSyntheticForDir) continue;

      const { trip, dirKey, dirIndex, sched, rawCoords, distTable, originPt } = cand;
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
        const allCurrentBuses = [...allKnownBuses, ...allSyntheticBuses];
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

        const stopsForDir = (allDirections && allDirections[dirIndex]?.stops) || sched.stops || [];
        const segInfo = this.findNearestSegment(lat, lon, stopsForDir, rawCoords);
        fromStop = segInfo.fromStop;
        toStop = segInfo.toStop;
        fromSeq = segInfo.fromSeq;
        toSeq = segInfo.toSeq;

        // Anti-bunching and spatial headway guard:
        // Same-direction buses must have at least 18% route progress separation and >= 700m distance.
        // Opposite-direction buses must not be placed right on top of each other (< 250m).
        const allCurrentBuses = [...allKnownBuses, ...allSyntheticBuses];
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
              if (progDiff < 0.18) {
                bunched = true;
                break;
              }
            }
            if (dist < 700) {
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
      // Include the direction so two opposite runs sharing a departure minute
      // get distinct vehicleIds (isBusSelected keys on vehicleId, so a shared
      // id would make the two ghosts indistinguishable). Matches tripId below.
      const vId = `EST_${lId}_${dirKey}_${depTimeClean}`;

      allSyntheticBuses.push({
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

    const syntheticBuses = isBoth
      ? allSyntheticBuses
      : allSyntheticBuses.filter(b => String(b.direction) === String(dirIdx));

    let fleetStatus;
    if (isBoth) {
      const effScheduled = Math.min(lineMaxFleet, totalScheduledForWholeLine);
      fleetStatus = {
        scheduledVehicles: effScheduled,
        liveGpsVehicles: totalLiveOnWholeLine,
        estimatedVehicles: allSyntheticBuses.length,
        fleetCoveragePct: effScheduled > 0
          ? Math.min(100, Math.round((totalLiveOnWholeLine / effScheduled) * 100))
          : 100
      };
    } else {
      const dirKey = String(dirIdx);
      const activeTripsForDir = allLineActiveTripsByDir[dirKey] || [];
      const liveBusesOnDir = allKnownBuses.filter(b => String(b.direction) === dirKey && !b.isEstimated && this.isPhysicalVehicle(b));
      const effScheduled = activeTripsForDir.length;
      fleetStatus = {
        scheduledVehicles: effScheduled,
        liveGpsVehicles: liveBusesOnDir.length,
        estimatedVehicles: syntheticBuses.length,
        fleetCoveragePct: effScheduled > 0
          ? Math.min(100, Math.round((liveBusesOnDir.length / effScheduled) * 100))
          : 100
      };
    }

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

  // A bus within this many metres BEYOND a stop has served it, and must not be
  // offered as still approaching. Snapping a position to the route polyline
  // errs by under 10m, so the tolerance keeps a bus standing AT the stop
  // reading as imminent rather than flipping to "already gone".
  static PASSED_STOP_TOLERANCE_M = 30;

  // Estimate arrival ETA to stopId from active live vehicles along the route
  async estimateArrivalsForStop(stopId, lineId = '', existingArrivals = [], options = {}) {
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

    const targetDate = options.dateObj ? new Date(options.dateObj) :
      (options.targetDate ? new Date(options.targetDate) :
      (options.referenceDate ? new Date(options.referenceDate) : new Date()));
    const now = targetDate.getTime();
    const netNow = timeEngine.getNetworkTime(this.agencyTimezone, targetDate);
    const currentSec = netNow.hour * 3600 + netNow.minute * 60 + netNow.second;
    const dayType = resolveDayType(targetDate, this.agencyTimezone);

    for (const lId of targetLineIds) {
      const routes = this.routesData[lId] || [];
      if (routes.length === 0) continue;

      let liveVehicles = [];
      try {
        const lineDetails = await this.getLineDetails(lId, 'both', options);
        if (lineDetails && Array.isArray(lineDetails.activeBuses)) {
          liveVehicles = lineDetails.activeBuses;
        }
      } catch {}

      if (!liveVehicles || liveVehicles.length === 0) {
        if (!options.skipSiri) {
          try {
            liveVehicles = await siriClient.getLiveVehicles(lId);
            if (Array.isArray(liveVehicles) && liveVehicles.length > 0) {
              this.stitchAnonymousVehicles(liveVehicles, lId, routes, targetDate);
            }
          } catch {}
        }

        if (!liveVehicles || liveVehicles.length === 0) {
          const frVehs = flightRecorder.getLineVehicles(`L${lId}`);
          const mataroVehs = (frVehs || []).filter(v => (v.agency || '').includes('Mataró') || String(v.lineId) === lId);
          if (mataroVehs.length > 0) {
            liveVehicles = mataroVehs;
          } else {
            for (const [, hist] of this.vehicleHistory.entries()) {
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
      }
      if (!liveVehicles || liveVehicles.length === 0) continue;

      const lineInfo = this.linesData.find(l => String(l.id) === lId) || { name: `Línia ${lId}` };

      // Find which routes contain this stop
      routes.forEach((route, routeIdx) => {
        const routeStops = route.stops || [];
        const targetStopIdx = routeStops.findIndex(s => String(s.id) === sId);
        if (targetStopIdx === -1) return; // This route direction does not visit this stop

        const dirSched = mataroSchedules.getDirectionSchedule(lId, String(route.id || routeIdx), dayType);
        const routeTravelSec = dirSched?.totalTravelSec || (dirSched?.totalTravelMinutes * 60) || 1800;
        const lastTripDepSec = dirSched && dirSched.departures && dirSched.departures.length > 0
          ? timeEngine.timeStringToSeconds(dirSched.departures[dirSched.departures.length - 1])
          : (dirSched && dirSched.lastTrip ? timeEngine.timeStringToSeconds(dirSched.lastTrip) : 0);
        const lastTripArrivalSec = lastTripDepSec + routeTravelSec;

        // If service for this route direction has ended (past last trip arrival + 15m delay grace period), do not synthesize arrivals
        if (lastTripDepSec > 0 && currentSec > lastTripArrivalSec + 900) {
          return;
        }

        const targetStopObj = routeStops[targetStopIdx];
        const routePolyCoords = (route.coords || []).map(c => ({ lat: parseFloat(c.Latitude), lon: parseFloat(c.Longitude) }));

        const targetLat = targetStopObj.latitude !== undefined ? parseFloat(targetStopObj.latitude) : targetStopObj.lat;
        const targetLon = targetStopObj.longitude !== undefined ? parseFloat(targetStopObj.longitude) : targetStopObj.lon;

        // Along-route progress, in metres from the start of this direction, is
        // what decides whether a bus has already served this stop. Stop indices
        // cannot: the NEAREST stop is the one a bus is approaching OR the one it
        // just left, so a nearest-stop index cannot tell those apart. A rider saw
        // one bus listed 2 min out at Pl. Fiveller while the same bus was
        // arriving at La Coma, the very next stop along the road.
        const hasRouteGeometry = routePolyCoords.length >= 2;
        const routeStart = hasRouteGeometry ? routePolyCoords[0] : null;
        const targetStopAlong = hasRouteGeometry
          ? geoEngine.calculatePolylineDistanceBetween(
            routePolyCoords, routeStart.lat, routeStart.lon,
            Number.isFinite(parseFloat(targetLat)) ? parseFloat(targetLat) : routeStart.lat,
            Number.isFinite(parseFloat(targetLon)) ? parseFloat(targetLon) : routeStart.lon
          )
          : null;
        const alongRouteOf = (lat, lon) => geoEngine.calculatePolylineDistanceBetween(
          routePolyCoords, routeStart.lat, routeStart.lon, lat, lon
        );

        // Check each live vehicle on the line
        liveVehicles.forEach(veh => {
          if (existingVehicleIds.has(veh.vehicleId)) return; // Already reported by SIRI

          const vehRouteIdx = this.matchVehicleToRouteIndex(veh, routes);
          const isSameDirection = (veh.direction !== undefined && veh.direction !== null && String(veh.direction) === String(route.id || routeIdx)) || (vehRouteIdx === routeIdx);

          // ONLY estimate ETA for physically approaching upstream vehicles on the same route direction
          if (!isSameDirection) return;

          // Project forward along route polyline if telemetry was recorded earlier
          let effectiveLat = veh.lat || veh.latitude;
          let effectiveLon = veh.lon || veh.longitude;
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

          // Signed remaining distance: positive while the stop is still ahead of
          // the bus, negative once the bus is beyond it. The old nearest-stop
          // test let a bus that had just left the stop through, and the distance
          // to the stop was then measured BACKWARDS, producing a confident
          // positive ETA at a stop already served.
          let remainingMeters;
          let remainingStops;
          if (hasRouteGeometry) {
            const busAlong = alongRouteOf(snapped.lat, snapped.lon);
            remainingMeters = targetStopAlong - busAlong;
            remainingStops = Math.max(0, targetStopIdx - vehStopIdx);
          } else {
            // No usable geometry for this direction: keep the previous
            // nearest-stop behaviour rather than dropping every estimate.
            remainingStops = Math.max(0, targetStopIdx - vehStopIdx);
            remainingMeters = (vehStopIdx <= targetStopIdx)
              ? geoEngine.calculatePolylineDistanceBetween(
                routePolyCoords, snapped.lat, snapped.lon,
                Number.isFinite(targetLat) ? targetLat : effectiveLat,
                Number.isFinite(targetLon) ? targetLon : effectiveLon
              )
              : 0;
          }

          const isUpstreamDirect = hasRouteGeometry
            ? remainingMeters > -MataroTracker.PASSED_STOP_TOLERANCE_M
            : vehStopIdx <= targetStopIdx;

          if (!isUpstreamDirect) return; // Bus has passed this stop on this run; do not fabricate synthetic multi-hop loops!

          const speedMps = Math.max(4.5, (veh.speedKmh || 22) / 3.6);
          let transitTravelSec = Math.round(Math.max(0, remainingMeters) / speedMps) + (remainingStops * 25);

          // If vehicle is parked/regulating at origin terminal:
          if (vehStopIdx === 0 && (veh.speedKmh === 0 || veh.speedKmh <= 5 || veh.isTerminalLayover)) {
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
            const isVehDelayed = (veh.delayMins !== undefined && veh.delayMins !== null && Number(veh.delayMins) >= 2);
            const badge = isVehDelayed
              ? `+${Number(veh.delayMins)} min retard`
              : (veh.isEstimated
                  ? (veh.delayBadgeText || `⚡ En ruta (Estimat)`)
                  : (veh.delayMins > 0 ? `+${veh.delayMins} min retard` : `⚡ En ruta (Bus #${veh.vehicleId})`));

            const termStopObj = routeStops[routeStops.length - 1];
            const rawDest = termStopObj?.name || route.name;
            const resolvedDest = (rawDest || '').trim().replace(/\s*-\s*\d+\s*$/, '').trim();

            estimatedArrivals.push({
              lineId: lId,
              lineName: lineInfo.name,
              directionId: String(route.id || routeIdx),
              directionName: route.name,
              destination: resolvedDest,
              vehicleId: veh.vehicleId,
              distanceFromStop: `${Math.round(remainingMeters)}m`,
              departureTime: formattedTime,
              expectedIso: arrDate.toISOString(),
              aimedIso: arrDate.toISOString(),
              minutesAway,
              formattedStatus: minutesAway === 0 ? 'Imminent' : (minutesAway === 1 ? '1 min' : `${minutesAway} min`),
              delayMins: veh.delayMins || 0,
              delayBadgeText: badge,
              delayStatus: isVehDelayed ? 'delayed' : 'estimated',
              isRealTime: false,
              isEstimated: true,
              freshness: { source: 'position', fetchedAt: now, observedAt: veh.freshness?.observedAt || null },
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
      estimatedArrivals = await this.estimateArrivalsForStop(sId, cleanLineId, liveArrivals, options);
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

    const dayTypeToday = resolveDayType(targetDate, this.agencyTimezone);

    const tomorrow = new Date(targetDate.getTime() + 24 * 3600 * 1000);
    const dayTypeTomorrow = resolveDayType(tomorrow, this.agencyTimezone);

    const filteredDepartures = [];

    for (const dep of sorted) {
      const vId = dep.vehicleId ? String(dep.vehicleId).trim() : null;
      const destName = (dep.destination || '').toLowerCase().trim();
      const isLastStopOfRoute = routesForStop.some(r =>
        String(r.id_linea) === String(dep.lineId) &&
        (r.stops || []).length > 1 &&
        String(r.stops[r.stops.length - 1].id) === sId &&
        (String(r.id) === String(dep.directionId) || (r.name || '').toLowerCase() === destName || destName.includes((r.stops[r.stops.length - 1].name || '').toLowerCase()))
      );
      const isTerminatingHere = isLastStopOfRoute || (destName && (
        destName === cleanStopName ||
        cleanStopName.startsWith(destName) ||
        cleanStopName.includes(destName) ||
        destName.includes(cleanStopName)
      ));

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
            // Bound the forward search to a plausible headway for THIS line and
            // direction (D9). An unbounded `.find(t => t >= arrSec - 300)` would
            // attach a very late arrival to a distant NEXT departure (e.g. a bus
            // 35 min late binding to the run after next) and then, because
            // arrSec <= schedSec for that distant trip, report delayMins = 0
            // ("Regulació / Puntual") for the wrong trip. We derive the headway
            // from the real departure list: the turnaround can legitimately be
            // the next scheduled run, which is at most one headway away.
            const departures = dirSched.departures
              .map(t => timeEngine.timeStringToSeconds(t))
              .filter(s => Number.isFinite(s))
              .sort((a, b) => a - b);
            let headwaySec = 0;
            for (let i = 1; i < departures.length; i++) {
              headwaySec = Math.max(headwaySec, departures[i] - departures[i - 1]);
            }
            // Fall back to a conservative bound if the schedule is degenerate.
            if (!(headwaySec > 0)) headwaySec = 30 * 60;
            // The matched turnaround may sit up to 5 min before the arrival, so
            // allow the headway plus that lookback as the search window.
            const maxForwardSec = headwaySec + 300;
            const candidate = dirSched.departures.find(t => {
              const sec = timeEngine.timeStringToSeconds(t);
              if (!Number.isFinite(sec) || sec < arrSec - 300) return false;
              // Reject a distant departure: a turnaround is either within the
              // lookback before the arrival or the next run within one headway.
              return (sec - arrSec) <= maxForwardSec;
            });
            const foundTrip = candidate;
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
          dep.arrivalMinutesAway = Math.max(0, dep.minutesAway || 0);
          dep.minutesAway = Math.max(0, (dep.minutesAway || 0) + depMinDelta);
          dep.departureMinutesAway = dep.minutesAway;
          dep.formattedStatus = (dep.arrivalMinutesAway <= 0) ? 'En regulació' : `${dep.minutesAway} min`;

          dep.statusText = (timeEngine.timeStringToSeconds(cleanArrTime) < timeEngine.timeStringToSeconds(cleanDepTime))
            ? `🅿️ Regulant (Arribada: ${cleanArrTime} • Sortida: ${cleanDepTime})`
            : `🅿️ Regulant a capçalera (Sortida: ${cleanDepTime})`;
        }
      } else {
        // Downstream Stop Handling:
        // Check if the assigned vehicle for this departure is currently in regulation/layover
        // at the origin terminal of this route variant.
        const cleanDest = (destName || '').replace(/^sentit\s+/, '').replace(/\s*-\s*\d+$/, '').trim();
        const matchingRoute = routesForStop.find(r => {
          if (String(r.id_linea) !== String(dep.lineId)) return false;
          if (dep.directionId !== undefined && dep.directionId !== null && String(r.id) === String(dep.directionId)) return true;
          const rName = (r.name || '').toLowerCase();
          const termName = (r.stops?.[r.stops.length - 1]?.name || '').toLowerCase().replace(/\s*-\s*\d+$/, '').trim();
          return termName.includes(cleanDest) || cleanDest.includes(termName) || rName.endsWith(cleanDest) || rName.includes(`- ${cleanDest}`) || rName === cleanDest;
        }) || routesForStop.find(r => String(r.id_linea) === String(dep.lineId));

        if (matchingRoute && Array.isArray(matchingRoute.stops) && matchingRoute.stops.length > 1) {
          const stopIdx = matchingRoute.stops.findIndex(s => String(s.id) === sId);
          if (stopIdx > 0) {
            const originStop = matchingRoute.stops[0];
            const originStopName = (originStop.name || 'Capçalera').split(/[\-\(\,]/)[0].trim();
            const lIdStr = String(dep.lineId);
            const dirKey = String(matchingRoute.id || '0');

            let stopTravelSec = mataroSchedules.getStopTravelTime(lIdStr, dirKey, sId, dayTypeToday);
            if (stopTravelSec <= 0) {
              const travelTimes = scheduleSynthesizer.estimateStopTravelTimes(matchingRoute.stops, {
                speedMps: 4.8,
                dwellSecPerStop: 25,
                defaultSegmentMeters: 300
              });
              stopTravelSec = scheduleSynthesizer.getTravelTimeToStop(travelTimes, sId);
            }

            let rawAimed = dep.scheduledTime || null;
            if (!rawAimed && dep.aimedIso && typeof dep.aimedIso === 'string') {
              if (dep.aimedIso.includes('T') && !dep.aimedIso.startsWith('0001-') && !dep.aimedIso.startsWith('1970-')) {
                const formatted = timeEngine.formatTimeToTimezone(dep.aimedIso, this.agencyTimezone);
                if (formatted && formatted !== '--:--') rawAimed = formatted;
              }
            }
            if (!rawAimed) rawAimed = dep.departureTime;
            const aimedClean = rawAimed ? String(rawAimed).replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1') : null;

            const dirSched = mataroSchedules.getDirectionSchedule(lIdStr, dirKey, dayTypeToday);
            let originDepTime = null;
            let originDepSec = null;

            if (aimedClean && dirSched && Array.isArray(dirSched.departures) && dirSched.departures.length > 0) {
              const aimedSec = timeEngine.timeStringToSeconds(aimedClean);
              const estOriginDepSec = aimedSec - stopTravelSec;
              let bestTrip = null;
              let minDiff = Infinity;
              for (const trip of dirSched.departures) {
                const tSec = timeEngine.timeStringToSeconds(trip);
                const diff = Math.abs(tSec - estOriginDepSec);
                if (diff < minDiff) {
                  minDiff = diff;
                  bestTrip = trip;
                }
              }
              if (bestTrip && minDiff <= 600) {
                originDepTime = bestTrip;
                originDepSec = timeEngine.timeStringToSeconds(bestTrip);
              }
            }

            const netNowToday = timeEngine.getNetworkTime(this.agencyTimezone, targetDate);
            const currentSecNow = netNowToday.hour * 3600 + netNowToday.minute * 60 + netNowToday.second;

            // Check if vehicle is physically at origin terminal or has not departed yet
            let isPhysicallyAtOrigin = false;
            let distToOrigin = Infinity;
            const vehCoordLat = dep.busCoords?.lat || dep.latitude || dep.lat;
            const vehCoordLon = dep.busCoords?.lon || dep.longitude || dep.lon;
            const origStopLat = originStop.latitude || originStop.lat;
            const origStopLon = originStop.longitude || originStop.lon;

            if (vehCoordLat && vehCoordLon && origStopLat && origStopLon) {
              distToOrigin = geoEngine.calculateDistanceMeters(
                vehCoordLat,
                vehCoordLon,
                origStopLat,
                origStopLon
              );
            } else if (vId) {
              const vehHist = this.vehicleHistory.get(vId);
              const histAgeMs = (vehHist && vehHist.timestamp) ? (targetDate.getTime() - vehHist.timestamp) : Infinity;
              // Only consider GPS history if it is fresh (within 90s)
              if (vehHist && histAgeMs <= 90000 && origStopLat && origStopLon) {
                distToOrigin = geoEngine.calculateDistanceMeters(
                  vehHist.lat || vehHist.latitude,
                  vehHist.lon || vehHist.longitude,
                  origStopLat,
                  origStopLon
                );
              }
            }

            const vehSpeed = dep.speedKmh !== undefined ? dep.speedKmh : (vId && this.vehicleHistory.get(vId)?.speedKmh);
            if (distToOrigin <= 350 && (vehSpeed <= 10 || vehSpeed === undefined || dep.isTerminalLayover)) {
              isPhysicallyAtOrigin = true;
            }

            // A vehicle is regulating at the origin terminal if:
            // Case 1 (Upcoming departure: secUntilOriginDep >= 0):
            //   The departure from origin has NOT occurred yet.
            //   Within turnaround window (<= 600s), the vehicle is regulating at origin waiting to depart,
            //   UNLESS GPS coordinates explicitly show the vehicle is far away (> 400m) still completing a prior trip.
            // Case 2 (Past scheduled departure: secUntilOriginDep < 0 and >= -300s):
            //   The scheduled departure time from origin has already passed. The vehicle can ONLY be regulating
            //   if GPS explicitly confirms it is still physically stalled at the origin terminal (isPhysicallyAtOrigin).
            //   If it has departed or coordinates are unknown, it is circulating in transit!
            const secUntilOriginDep = originDepSec !== null ? (originDepSec - currentSecNow) : Infinity;
            let isRegulatingAtOrigin = false;

            if (secUntilOriginDep <= 600 && secUntilOriginDep >= 0) {
              if (distToOrigin !== Infinity) {
                isRegulatingAtOrigin = isPhysicallyAtOrigin || distToOrigin <= 400;
              } else {
                isRegulatingAtOrigin = true;
              }
            } else if (secUntilOriginDep < 0 && secUntilOriginDep >= -300) {
              isRegulatingAtOrigin = isPhysicallyAtOrigin;
            }

            if (isRegulatingAtOrigin) {
              dep.isRegulating = true;
              dep.isOriginRegulating = true;
              dep.originTerminalName = originStopName;
              if (originDepTime) {
                dep.originDepartureTime = originDepTime;
              }

              // DOMAIN INVARIANT: A bus regulating at origin terminal before scheduled departure
              // can NEVER arrive early ("avançat") at downstream stops!
              const rawDelay = dep.delayMinutes !== undefined ? dep.delayMinutes : (dep.delayMins !== undefined ? dep.delayMins : 0);
              if (rawDelay < 0 || dep.delayStatus === 'early') {
                dep.delayMins = 0;
                dep.delayMinutes = 0;
                if (aimedClean) {
                  dep.departureTime = aimedClean;
                  const aimedSec = timeEngine.timeStringToSeconds(aimedClean);
                  dep.minutesAway = Math.max(0, Math.round((aimedSec - currentSecNow) / 60));
                  dep.formattedStatus = `${dep.minutesAway} min`;
                }
              }

              dep.delayStatus = (dep.delayMins && dep.delayMins >= 2) ? 'delayed' : 'regulating';
              dep.delayBadgeText = (dep.delayMins && dep.delayMins >= 2)
                ? `+${dep.delayMins} min retard`
                : `⏱️ Regulant a ${originStopName}`;
              dep.comparisonText = aimedClean
                ? (originDepTime
                    ? `Horari teòric: ${aimedClean} • Regulant a ${originStopName} (sortida: ${originDepTime})`
                    : `Horari teòric: ${aimedClean} • Regulant a ${originStopName}`)
                : `Regulant a ${originStopName}`;
              dep.statusText = originDepTime
                ? `⏱️ Regulant a ${originStopName} (sortida: ${originDepTime})`
                : `⏱️ Regulant a ${originStopName}`;
            }
          }
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

    // 3.5 Downstream Stop Propagation of Origin Terminal Regulating & Turnaround Departures:
    // If this stop is a downstream stop on any serving route variant (stopIdx > 0),
    // check if the route's origin terminal has an active regulating or turnaround departure.
    // SIRI often doesn't broadcast downstream predictions for buses still at the terminal,
    // so we project the origin terminal departure downstream with route travel time.
    if (!options.isDownstreamCheck) {
      for (const r of routesForStop) {
        const stopIdx = (r.stops || []).findIndex(s => String(s.id) === sId);
        if (stopIdx <= 0) continue; // Skip origin stop (cannot propagate to itself)

        const originStop = r.stops[0];
        if (!originStop) continue;
        const originStopId = String(originStop.id);
        const lIdStr = String(r.id_linea || lineId || '1');
        const dirKey = String(r.id || '0');

        try {
          const originBoard = await this.getStopDepartures(originStopId, lIdStr, dirKey, {
            ...options,
            isDownstreamCheck: true
          });

          if (originBoard && Array.isArray(originBoard.departures)) {
            let stopTravelSec = mataroSchedules.getStopTravelTime(lIdStr, dirKey, sId, dayTypeToday);
            if (stopTravelSec <= 0 && r.stops && r.stops.length > 0) {
              const travelTimes = scheduleSynthesizer.estimateStopTravelTimes(r.stops, {
                speedMps: 4.8,
                dwellSecPerStop: 25,
                defaultSegmentMeters: 300
              });
              stopTravelSec = scheduleSynthesizer.getTravelTimeToStop(travelTimes, sId);
            }

            const netNowToday = timeEngine.getNetworkTime(this.agencyTimezone, targetDate);
            const currentSecNow = netNowToday.hour * 3600 + netNowToday.minute * 60 + netNowToday.second;
            const originStopName = (originStop.name || 'Capçalera').split(/[\-\(\,]/)[0].trim();

            for (const origDep of originBoard.departures) {
              if (String(origDep.lineId) !== lIdStr) continue;

              const isMatchDir = String(origDep.directionId) === dirKey ||
                (origDep.destination && r.name && origDep.destination.toLowerCase().includes(r.name.toLowerCase()));
              if (!isMatchDir) continue;

              // Only propagate live regulating, real-time, or estimated departures
              if (!origDep.isRegulating && !origDep.isRealTime && !origDep.isEstimated) continue;

              const vId = origDep.vehicleId ? String(origDep.vehicleId).trim() : null;
              const alreadyHas = filteredDepartures.some(d => {
                if (vId && d.vehicleId && String(d.vehicleId).trim() === vId) return true;
                return false;
              });
              if (alreadyHas) continue;

              const origDepSec = timeEngine.timeStringToSeconds(origDep.departureTime);
              const secUntilOrigDep = origDepSec - currentSecNow;
              // Downstream terminal propagation applies strictly to imminent or currently regulating departures (within 10m or delayed up to 5m)
              if (secUntilOrigDep > 600 || secUntilOrigDep < -300) continue;

              const estPassingSec = origDepSec + stopTravelSec;
              const minsAway = Math.max(0, Math.round((estPassingSec - currentSecNow) / 60));

              // If vehicle already passed this stop (> 90 seconds ago), do not show
              if (currentSecNow > estPassingSec + 90) continue;
              if (minsAway > 90) continue;

              const schedDepSec = origDep.scheduledTime ? timeEngine.timeStringToSeconds(origDep.scheduledTime) : origDepSec;
              const schedPassingSec = schedDepSec + stopTravelSec;
              const formattedDepTime = timeEngine.minutesToTimeString(Math.round(estPassingSec / 60));
              const formattedSchedTime = timeEngine.minutesToTimeString(Math.round(schedPassingSec / 60));

              const delayMins = origDep.delayMins !== undefined
                ? origDep.delayMins
                : Math.max(0, Math.round((estPassingSec - schedPassingSec) / 60));

              const delayStatus = delayMins >= 2 ? 'delayed' : 'regulating';
              const delayBadgeText = delayMins >= 2 ? `+${delayMins} min retard` : `⏱️ Regulant a ${originStopName}`;
              const depDate = new Date(targetDate.getTime() + minsAway * 60000);
              const depIso = depDate.toISOString();

              const termStopObj = (r.stops || [])[r.stops.length - 1];
              const resolvedDest = termStopObj?.name
                ? termStopObj.name.replace(/\s*-\s*\d+$/, '').trim()
                : (r.name || origDep.destination);

              filteredDepartures.push({
                ...origDep,
                destination: resolvedDest,
                directionId: dirKey,
                departureTime: formattedDepTime,
                time: formattedDepTime,
                scheduledTime: formattedSchedTime,
                scheduledDepartureTime: formattedSchedTime,
                departureDate: depIso,
                expectedIso: depIso,
                aimedIso: depIso,
                minutesAway: minsAway,
                departureMinutesAway: minsAway,
                arrivalMinutesAway: null,
                formattedStatus: minsAway === 0 ? 'Imminent' : (minsAway === 1 ? '1 min' : `${minsAway} min`),
                delayMins,
                delayMinutes: delayMins,
                delayStatus,
                delayBadgeText,
                isRegulating: true,
                isOriginRegulating: true,
                originTerminalName: originStopName,
                originDepartureTime: origDep.departureTime,
                statusText: `⏱️ Regulant a ${originStopName} (sortida: ${origDep.departureTime})`,
                comparisonText: `Horari teòric: ${formattedSchedTime} • Regulant a ${originStopName} (sortida: ${origDep.departureTime})`
              });
            }
          }
        } catch {}
      }
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

      let stopTravelSec = mataroSchedules.getStopTravelTime(lIdStr, dirKey, sId, dayTypeToday);
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

      // Terminal Turnaround & Regulating Enrichment for Scheduled Departures:
      // If this stop is the origin terminal of this route, find the incoming route of the same line that terminates here.
      // For any departure without an arrivalTime, calculate its incoming scheduled trip arrival and layover interval.
      if (isOrigin) {
        const incomingTerminatingRoute = routesForStop.find(otherR =>
          String(otherR.id_linea) === lIdStr &&
          String(otherR.id) !== dirKey &&
          (otherR.stops || []).length > 1 &&
          String(otherR.stops[otherR.stops.length - 1].id) === sId
        );

        if (incomingTerminatingRoute) {
          const inSched = mataroSchedules.getDirectionSchedule(lIdStr, String(incomingTerminatingRoute.id), dayTypeToday);
          const inTravelSec = inSched?.totalTravelSec || 0;
          const netNowToday = timeEngine.getNetworkTime(this.agencyTimezone, targetDate);
          const currentSecNow = netNowToday.hour * 3600 + netNowToday.minute * 60 + netNowToday.second;

          if (inSched && Array.isArray(inSched.departures) && inTravelSec > 0) {
            compiledForRoute.forEach(cd => {
              if (!cd.arrivalTime && cd.departureTime && cd.departureTime !== '--:--') {
                const depSecVal = timeEngine.timeStringToSeconds(cd.departureTime);
                if (depSecVal > 0) {
                  const candidateTrips = inSched.departures
                    .map(t => {
                      const aSec = timeEngine.timeStringToSeconds(t) + inTravelSec;
                      return { t, arrSec: aSec, arrTime: timeEngine.minutesToTimeString(Math.round(aSec / 60)) };
                    })
                    .filter(x => x.arrSec <= depSecVal + 60 && x.arrSec >= depSecVal - 1800);

                  const bestInbound = candidateTrips[candidateTrips.length - 1];
                  if (bestInbound) {
                    const cleanInArr = String(bestInbound.arrTime).replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1');
                    const inArrSec = timeEngine.timeStringToSeconds(cleanInArr);
                    // Only flag as actively regulating if current time is within the active layover window
                    // (from 5 minutes before scheduled arrival up to 3 minutes after departure)
                    const isCurrentLayover = currentSecNow >= (inArrSec - 300) && currentSecNow <= (depSecVal + 180);
                    if (isCurrentLayover) {
                      cd.arrivalTime = cleanInArr;
                      cd.isRegulating = true;
                      cd.isTerminalLayover = true;
                      if (cd.delayStatus === 'scheduled') {
                        cd.delayStatus = 'regulating';
                        cd.delayBadgeText = '⏱️ Regulació';
                      }
                      cd.arrivalMinutesAway = Math.round((inArrSec - currentSecNow) / 60);
                      cd.departureMinutesAway = cd.minutesAway;
                      cd.statusText = currentSecNow >= inArrSec
                        ? `🅿️ A la parada (Sortida: ${cd.departureTime})`
                        : `🅿️ Regulant (Arribada: ${cleanInArr} • Sortida: ${cd.departureTime})`;
                    }
                  }
                }
              }
            });
          }
        }
      }

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

    const result = {
      stop: {
        id: sId,
        name: stopInfo.name,
        lat: stopInfo.lat,
        lon: stopInfo.lon,
        zone: 'Mataró Urbà'
      },
      departures: finalDepartures,
      totalDepartures: finalDepartures.length
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
    } catch {
      // Non-blocking warming
    }
  }

  // 4. Get Target Stop ETA
  async getTargetStopETA(lineId, stopId = null, direction = '0', options = {}) {
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
    const stopDepartures = await this.getStopDepartures(sId, lId, String(dirIdx), options);
    const deps = stopDepartures.departures || [];
    const nextBus = deps.length > 0 ? deps[0] : null;

    const now = options.dateObj ? new Date(options.dateObj) : (options.targetDate ? new Date(options.targetDate) : new Date());
    const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
    const dayTypeTomorrow = resolveDayType(tomorrow, this.agencyTimezone);

    const dirSchedTomorrow = mataroSchedules.getDirectionSchedule(lId, selectedRoute?.id || String(dirIdx), dayTypeTomorrow);
    const stopTravelSec = mataroSchedules.getStopTravelTime(lId, selectedRoute?.id || String(dirIdx), sId, dayTypeTomorrow);

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
    } catch {}
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

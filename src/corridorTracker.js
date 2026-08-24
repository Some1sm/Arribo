const fs = require('fs');
const path = require('path');
const mouteClient = require('./mouteClient');
const geoEngine = require('./core/geo/geoEngine');

/**
 * Validates an OSRM-generated polyline actually passes near every stop
 * (guards against a bad route replacing known-good shapes).
 */
function osrmCoversStops(coords, stops, thresholdM = 250) {
  if (!Array.isArray(coords) || coords.length < 10) return false;
  let covered = 0;
  for (const s of stops) {
    let best = Infinity;
    for (const c of coords) {
      const dLat = (s.lat - c[0]) * 111320;
      const dLon = (s.lon - c[1]) * 111320 * Math.cos(s.lat * Math.PI / 180);
      const d = Math.sqrt(dLat * dLat + dLon * dLon);
      if (d < best) best = d;
    }
    if (best <= thresholdM) covered++;
  }
  return covered / stops.length >= 0.95;
}
const timeEngine = require('./core/time/timeEngine');
const calendarEngine = require('./core/time/calendarEngine');
const delayEngine = require('./core/schedule/delayEngine');
const delayMemory = require('./core/realtime/delayMemory');
const geoUtils = require('./geoUtils');
const timeUtils = require('./timeUtils');
const https = require('https');
const BaseTracker = require('./core/BaseTracker');
const {
  C10_STOPS_DIR1,
  C10_STOPS_DIR0,
  C10_POLYLINE_DIR1,
  C10_POLYLINE_DIR0,
  C10_TRIPS_DIR1,
  C10_TRIPS_DIR0
} = require('./c10StaticData');

function timeToSec(timeStr) {
  return timeEngine.timeToSec(timeStr);
}

function secToTime(totalSec) {
  return timeEngine.secToTime(totalSec);
}

function formatDateToYYYYMMDD(date, tz = 'Europe/Madrid') {
  return timeEngine.getNetworkTime(tz, date).dateStr;
}

function timeToMin(timeStr) {
  return timeEngine.timeToMin(timeStr);
}

class CorridorTracker extends BaseTracker {
  constructor() {
    super();
    this.agencyTimezone = 'Europe/Madrid';
    this.dataDir = path.join(__dirname, '..', 'data');
    // AMB v2 realtime supplementary source for C-10 stops (the operator's own
    // app tracks C-10 buses there; Mou-te often lacks realtime for them).
    this._ambApiKey = process.env.AMB_API_KEY || '28EbLJtP0A6CtrWeXp6zE1zy3kp4RzmnaA2sy8JM';
    this._ambRealtimeCache = new Map(); // ambStopCode -> { timestamp, times }
    this._ambCodeByStop = new Map();    // c10 stopId -> AMB stop code
    this.stopsDir1 = [...C10_STOPS_DIR1];
    this.stopsDir0 = [...C10_STOPS_DIR0];
    this.routePolylineDir1 = [...C10_POLYLINE_DIR1];
    this.routePolylineDir0 = [...C10_POLYLINE_DIR0];
    this.stopsMapDir1 = new Map();
    this.stopsMapDir0 = new Map();
    this.stopsDir1.forEach(s => this.stopsMapDir1.set(s.gtfsStopId, s));
    this.stopsDir0.forEach(s => this.stopsMapDir0.set(s.gtfsStopId, s));
    this.fullSchedule = { dir1: [...C10_TRIPS_DIR1], dir0: [...C10_TRIPS_DIR0] };
    this.calendarLoaded = false;
    this.calendarExceptions = new Map();
    this.calendarWeekly = [];
    this.loadData();

    // Target stop definitions
    this.targetStop = {
      name: "Plaça d'Itàlia (Mataró)",
      googleMapsUrl: "https://maps.app.goo.gl/ScnubXtht3oSKDCk6",
      coords: { lat: 41.5468674, lon: 2.4321194 },
      dir1: {
        mouteStopId: 'PF08121075',
        gtfsStopId: 'GEN_PF08121075',
        code: '121',
        name: "pl. Itàlia (A)",
        seq: 39,
        directionName: "Cap a Mataró (Hospital de Mataró)"
      },
      dir0: {
        mouteStopId: 'PF08121041',
        gtfsStopId: 'GEN_PF08121041',
        code: '8371',
        name: "pl. Itàlia (D)",
        seq: 3,
        directionName: "Cap a Barcelona (Metro la Pau)"
      }
    };

    // Checkpoint stops along the corridor with accurate GTFS stop IDs
    this.checkpointsDir1 = [
      { id: 'PF08019096', name: 'Barcelona - Metro la Pau', zone: 'AMB', seq: 0, gtfsStopId: 'GEN_PF08019096' },
      { id: 'PF08015014', name: 'Badalona - Pompeu Fabra', zone: 'AMB', seq: 7, gtfsStopId: 'GEN_PF08015014' },
      { id: 'PF08126015', name: 'Montgat - Estació Rodalies', zone: 'AMB (Boundary)', seq: 12, gtfsStopId: 'GEN_PF08126015' },
      { id: 'PF08118027', name: 'El Masnou - Estació', zone: 'Maresme', seq: 17, gtfsStopId: 'GEN_PF08118027' },
      { id: 'PF08172022', name: 'Premià de Mar - Estació', zone: 'Maresme', seq: 21, gtfsStopId: 'GEN_PF08172022' },
      { id: 'PF08219011', name: 'Vilassar de Mar - Estació', zone: 'Maresme', seq: 26, gtfsStopId: 'GEN_PF08219011' },
      { id: 'PF08121080', name: 'Mataró - Porta Laietana', zone: 'Maresme', seq: 34, gtfsStopId: 'GEN_PF08121080' },
      { id: 'PF08121077', name: 'Mataró - Pl. Granollers', zone: 'Maresme', seq: 37, gtfsStopId: 'GEN_PF08121077' },
      { id: 'PF08121075', name: "Mataró - Pl. d'Itàlia", zone: 'Maresme', seq: 39, gtfsStopId: 'GEN_PF08121075' }
    ];

    this.checkpointsDir0 = [
      { id: 'PF08121041', name: "Mataró - Pl. d'Itàlia", zone: 'Maresme', seq: 3, gtfsStopId: 'GEN_PF08121041' },
      { id: 'PF08121044', name: 'Mataró - Pl. Granollers', zone: 'Maresme', seq: 5, gtfsStopId: 'GEN_PF08121044' },
      { id: 'PF08121024', name: 'Mataró - Porta Laietana', zone: 'Maresme', seq: 8, gtfsStopId: 'GEN_PF08121024' },
      { id: 'PF08219036', name: 'Vilassar de Mar - Estació', zone: 'Maresme', seq: 16, gtfsStopId: 'GEN_PF08219036' },
      { id: 'PF08172018', name: 'Premià de Mar - Estació', zone: 'Maresme', seq: 21, gtfsStopId: 'GEN_PF08172018' },
      { id: 'PF08118041', name: 'El Masnou - Estació', zone: 'Maresme', seq: 26, gtfsStopId: 'GEN_PF08118041' },
      { id: 'PF08126007', name: 'Montgat - Estació Rodalies', zone: 'AMB (Boundary)', seq: 32, gtfsStopId: 'GEN_PF08126007' },
      { id: 'PF08015025', name: 'Badalona - Pompeu Fabra', zone: 'AMB', seq: 37, gtfsStopId: 'GEN_PF08015025' },
      { id: 'PF08019096', name: 'Barcelona - Metro la Pau', zone: 'AMB', seq: 44, gtfsStopId: 'GEN_PF08019096' }
    ];

    this.liveTrackingCache = new Map(); // dir -> { data, timestamp }
  }

  loadData() {
    try {
      const c10Static = require('./c10StaticData');
      this.stopsDir1 = c10Static.C10_STOPS_DIR1.map(s => ({
        ...s,
        id: s.mouteStopId || s.gtfsStopId,
        code: s.code || s.mouteStopId
      }));
      this.stopsDir0 = c10Static.C10_STOPS_DIR0.map(s => ({
        ...s,
        id: s.mouteStopId || s.gtfsStopId,
        code: s.code || s.mouteStopId
      }));
      this.routePolylineDir1 = [...c10Static.C10_POLYLINE_DIR1];
      this.routePolylineDir0 = [...c10Static.C10_POLYLINE_DIR0];
      // Prefer the REAL GTFS schedule (GEN_0498) over the fabricated
      // fixed-start-minute timetables — service-day filtering depends on the
      // feed's service_ids, and Sunday/holiday times must match the operator.
      const gtfsTrips = c10Static.C10_GTFS_TRIPS;
      this.fullSchedule = {
        dir1: (gtfsTrips && gtfsTrips.dir1.length > 0) ? gtfsTrips.dir1 : [...c10Static.C10_TRIPS_DIR1],
        dir0: (gtfsTrips && gtfsTrips.dir0.length > 0) ? gtfsTrips.dir0 : [...c10Static.C10_TRIPS_DIR0]
      };

      // Load authoritative high-resolution road shapes from SQLite shapes database
      const shapesDbPath = path.join(this.dataDir, 'shapes.db');
      if (fs.existsSync(shapesDbPath)) {
        try {
          const sqlite = require('node:sqlite');
          const shapesDb = new sqlite.DatabaseSync(shapesDbPath);
          const stmt = shapesDb.prepare('SELECT coords FROM shapes WHERE shape_id = ?');
          const row1 = stmt.get('GEN_24222');
          if (row1?.coords) {
            this.routePolylineDir1 = JSON.parse(row1.coords);
          }
          const row0 = stmt.get('GEN_22906');
          if (row0?.coords) {
            this.routePolylineDir0 = JSON.parse(row0.coords);
          }
        } catch (err) {
          console.warn('[CorridorTracker] Could not load high-res shapes from SQLite:', err.message);
        }
      }

      this.stopsMapDir1 = new Map();
      this.stopsDir1.forEach(s => this.stopsMapDir1.set(s.gtfsStopId, s));
      this.stopsMapDir0 = new Map();
      this.stopsDir0.forEach(s => this.stopsMapDir0.set(s.gtfsStopId, s));

      console.log(`[CorridorTracker] Authoritatively loaded C-10 (${this.stopsDir1.length} stops dir 1, ${this.stopsDir0.length} stops dir 0, ${this.fullSchedule.dir1.length + this.fullSchedule.dir0.length} trips)!`);
    } catch (e) {
      console.error('[CorridorTracker] Error loading static C-10 datasets:', e.message);
    }
  }

  ensureCalendarLoaded() {
    if (this.calendarLoaded) return;
    this.calendarLoaded = true;
    this.loadCalendarSync();
  }

  async init() {
    this.ensureCalendarLoaded();
    await this.ensureOsrmPolylines();
  }

  /**
   * One-shot (memoised) upgrade of the hardcoded highway shapes to an OSRM
   * road path through every N-II town stop. Safe to call repeatedly; runs at
   * most once per process, lazily on first route request.
   */
  ensureOsrmPolylines() {
    if (!this._osrmPolylineUpgrade) {
      this._osrmPolylineUpgrade = (async () => {
      try {
        const { fetchRoadRoute } = require('./core/geo/osrmClient');
        for (const dir of ['1', '0']) {
          const attr = dir === '1' ? 'routePolylineDir1' : 'routePolylineDir0';
          const stopList = dir === '1' ? this.stopsDir1 : this.stopsDir0;
          if (!Array.isArray(this[attr]) || this[attr].length < 10 || stopList.length < 2) continue;
          const osrm = await fetchRoadRoute(stopList.map(s => ({ lat: s.lat, lon: s.lon })));
          if (osrm && osrmCoversStops(osrm, stopList)) {
            console.log(`[CorridorTracker] dir ${dir}: using OSRM road geometry through all stops (${osrm.length} pts).`);
            this[attr] = osrm;
            this._polylineUpgraded = this._polylineUpgraded || {};
            this._polylineUpgraded[dir] = true;
          }
        }
      } catch (e) {
        console.warn('[CorridorTracker] OSRM polyline upgrade skipped:', e.message);
      }
      })();
    }
    return this._osrmPolylineUpgrade;
  }

  loadCalendarSync() {
    const atmDir = path.join(this.dataDir, 'atm_gtfs');
    if (!fs.existsSync(atmDir)) return;

    // GTFS service IDs change whenever the feed is regenerated. Derive them
    // from the C-10 schedule we just loaded instead of relying only on the
    // service IDs from one historical feed version.
    const c10Services = new Set([
      ...(this.fullSchedule?.dir0 || []),
      ...(this.fullSchedule?.dir1 || [])
    ].map(trip => trip.serviceId).filter(Boolean));

    if (c10Services.size === 0) {
      ['GEN_184910', 'GEN_185080', 'GEN_184749', 'GEN_185017'].forEach(id => c10Services.add(id));
    }

    const datesFile = path.join(atmDir, 'calendar_dates.txt');
    if (fs.existsSync(datesFile)) {
      const lines = fs.readFileSync(datesFile, 'utf8').split('\n');
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const [sId, dateStr, excType] = line.split(',');
        if (c10Services.has(sId)) {
          if (!this.calendarExceptions.has(dateStr)) {
            this.calendarExceptions.set(dateStr, { active: new Set(), inactive: new Set() });
          }
          const entry = this.calendarExceptions.get(dateStr);
          if (excType === '1') entry.active.add(sId);
          if (excType === '2') entry.inactive.add(sId);
        }
      }
    }

    const calFile = path.join(atmDir, 'calendar.txt');
    if (fs.existsSync(calFile)) {
      const lines = fs.readFileSync(calFile, 'utf8').split('\n');
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const p = line.split(',');
        if (c10Services.has(p[0])) {
          this.calendarWeekly.push({
            serviceId: p[0],
            monday: p[1] === '1',
            tuesday: p[2] === '1',
            wednesday: p[3] === '1',
            thursday: p[4] === '1',
            friday: p[5] === '1',
            saturday: p[6] === '1',
            sunday: p[7] === '1',
            startDate: p[8],
            endDate: p[9]
          });
        }
      }
    }
  }

  getDateComponents(dateObj = new Date()) {
    return calendarEngine.getDateComponents(dateObj, this.agencyTimezone);
  }

  getServiceCalendarInfo(dateObj = new Date()) {
    const { isAugust, isSaturday, isSunday, year, month, day } = this.getDateComponents(dateObj);
    const dateFormatted = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;

    if (isSunday) {
      return {
        serviceId: 'GEN_184749',
        name: 'Diumenges i festius',
        frequency: 'Cada 120 minuts (2 hores)',
        frequencyMinutes: 120,
        isAugustSeason: isAugust,
        isWeekend: true,
        calendarTag: 'Diumenges i festius (cada 2h)',
        periodLabel: 'Festius',
        dateFormatted
      };
    }

    if (isSaturday || (this.getDateComponents(dateObj).isWeekday && isAugust)) {
      return {
        serviceId: 'GEN_185080',
        name: isSaturday ? 'Dissabtes' : "Feiners d'Agost",
        frequency: 'Cada 90 minuts (1h 30m)',
        frequencyMinutes: 90,
        isAugustSeason: isAugust,
        isWeekend: isSaturday,
        calendarTag: isAugust ? "Horari d'estiu (Agost: cada 90 min)" : 'Dissabtes (cada 90 min)',
        periodLabel: isAugust ? 'Estiu (Agost)' : 'Dissabte',
        dateFormatted
      };
    }

    return {
      serviceId: 'GEN_184910',
      name: "Feiners de dilluns a divendres (resta de l'any)",
      frequency: 'Cada 45 minuts',
      frequencyMinutes: 45,
      isAugustSeason: false,
      isWeekend: false,
      calendarTag: 'Feiners habituals (cada 45 min)',
      periodLabel: 'Feiners',
      dateFormatted
    };
  }

  isServiceActiveOnDate(serviceId, dateObj = new Date()) {
    this.ensureCalendarLoaded();
    return calendarEngine.isServiceActiveOnDate(serviceId, this.calendarWeekly, this.calendarExceptions, dateObj, this.agencyTimezone);
  }

  getStops(direction = '1') {
    return direction === '0' ? this.stopsDir0 : this.stopsDir1;
  }

  computeScheduledMatch(liveTimeStr, isRealtime, stopGtfsId, direction, stopMouteId = null, stopSeq = null) {
    const isDir1 = direction === '1';
    const scheduleTrips = isDir1 ? (this.fullSchedule?.dir1 || []) : (this.fullSchedule?.dir0 || []);
    const stopsList = isDir1 ? this.stopsDir1 : this.stopsDir0;
    const now = new Date();
    const todaysTrips = scheduleTrips.filter(trip => this.isServiceActiveOnDate(trip.serviceId, now));

    let resolvedGtfsId = stopGtfsId;
    let resolvedSeq = stopSeq;
    if (!resolvedGtfsId || resolvedSeq === null) {
      const match = stopsList.find(s => 
        (stopMouteId && s.mouteStopId === stopMouteId) || 
        (stopGtfsId && s.gtfsStopId === stopGtfsId) ||
        (stopSeq !== null && s.seq === stopSeq)
      );
      if (match) {
        resolvedGtfsId = match.gtfsStopId;
        resolvedSeq = match.seq;
      }
    }

    const liveMin = timeToMin(liveTimeStr);
    let bestTrip = null;
    let minDiff = Infinity;
    let scheduledTime = liveTimeStr;

    for (const trip of todaysTrips) {
      let stopTime = null;
      if (resolvedGtfsId) {
        stopTime = trip.stops.find(s => s.stopId === resolvedGtfsId);
      }
      if (!stopTime && resolvedSeq !== null) {
        stopTime = trip.stops.find(s => s.seq === resolvedSeq) || trip.stops[resolvedSeq];
      }

      if (stopTime) {
        const schedStr = (stopTime.arr || stopTime.dep || '').substring(0, 5);
        if (schedStr) {
          const schedMin = timeToMin(schedStr);
          const diff = Math.abs(liveMin - schedMin);
          // Tight window: with 45-120 min headways a loose window (the old 55 min)
          // made a live departure steal the identity of a DIFFERENT trip (e.g. a
          // 17:00 live time matching the 16:07 trip), which then suppressed that
          // trip from the departures board entirely.
          if (diff < minDiff && diff <= 25) {
            minDiff = diff;
            bestTrip = trip;
            scheduledTime = schedStr;
          }
        }
      }
    }

    const schedMin = timeToMin(scheduledTime);
    const delayMinutes = isRealtime ? liveMin - schedMin : 0;
    const delayInfo = delayEngine.computeDelayStatus(delayMinutes, isRealtime, {
      scheduledTime,
      punctualStyle: 'long'
    });

    return {
      scheduledTime,
      bestTrip,
      realtimeTime: liveTimeStr,
      delayMinutes: delayInfo.delayMinutes,
      delayStatus: delayInfo.delayStatus,
      delayBadgeText: delayInfo.delayBadgeText,
      comparisonText: delayInfo.comparisonText
    };
  }

  parseDepartures(data, stopGtfsId = null, direction = '1', stopMouteId = null, stopSeq = null) {
    const isDir1 = direction === '1';
    const scheduleTrips = isDir1 ? (this.fullSchedule?.dir1 || []) : (this.fullSchedule?.dir0 || []);
    const stopsList = isDir1 ? this.stopsDir1 : this.stopsDir0;
    const stopsMap = isDir1 ? this.stopsMapDir1 : this.stopsMapDir0;
    const oppositeScheduleTrips = isDir1 ? (this.fullSchedule?.dir0 || []) : (this.fullSchedule?.dir1 || []);
    const now = new Date();
    const networkNow = timeUtils.getNetworkTime(this.agencyTimezone, now);
    const currentSec = networkNow.currentSec;
    const todaysTrips = scheduleTrips.filter(trip => this.isServiceActiveOnDate(trip.serviceId, now));
    const oppositeTrips = oppositeScheduleTrips.filter(t => this.isServiceActiveOnDate(t.serviceId, now));

    const sortides = data && data.sortides && data.sortides.sortida
      ? (Array.isArray(data.sortides.sortida) ? data.sortides.sortida : [data.sortides.sortida])
      : [];

    const results = [];
    const seenTodayTripKeys = new Set();
    const seenFinalTimes = new Set();

    // Dynamically discover all line IDs associated with C-10 in this stop's Mou-te catalog
    const rawLines = data?.parada?.lineas?.linia;
    const linesInStop = Array.isArray(rawLines) ? rawLines : (rawLines ? [rawLines] : []);
    const matchingLineIds = new Set(['02498', '02256', 'C10', 'c10']);
    linesInStop.forEach(l => {
      const nom = (l.nomLinia || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const desc = (l.descripcioLinia || '').toLowerCase();
      if (nom === 'c10' || nom === '02498' || nom === '02256' || (desc.includes('mataró') && desc.includes('n-ii')) || desc.includes('c-10') || desc.includes('c10')) {
        matchingLineIds.add(String(l.idLinia));
      }
    });

    for (const s of sortides) {
      const isC10 = matchingLineIds.has(String(s.liniaId)) || s.liniaId === '02498' || s.liniaId === '02256' || s.liniaId === 'C10' || s.nomLinia === 'C-10' || (s.descripcioLinia && s.descripcioLinia.includes('C10'));
      if (!isC10) {
        continue; // Discard any non-C10 departures from shared stops
      }

      // Number.isFinite guards: 0/1 are legal values (January -> month index 0,
      // midnight hour 0, minute 0) and must not be treated as falsy fallbacks.
      const parsedYear = parseInt(s.any, 10);
      const parsedMes = parseInt(s.mes, 10);
      const parsedDay = parseInt(s.dia, 10);
      const parsedHour = parseInt(s.hora, 10);
      const parsedMinute = parseInt(s.minuts, 10);
      const year = Number.isFinite(parsedYear) ? parsedYear : networkNow.year;
      const month = Number.isFinite(parsedMes) ? parsedMes - 1 : networkNow.month;
      const day = Number.isFinite(parsedDay) ? parsedDay : networkNow.day;
      const hour = Number.isFinite(parsedHour) ? parsedHour : 0;
      const minute = Number.isFinite(parsedMinute) ? parsedMinute : 0;

      const depUtcDate = timeUtils.localTimeToUtcDate(year, month, day, hour, minute, 0, this.agencyTimezone);
      const diffMs = depUtcDate.getTime() - now.getTime();
      const diffMinutes = Math.round(diffMs / 60000);
      const isToday = (year === networkNow.year && month === networkNow.month && day === networkNow.day);

      const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
      const isRealtime = Boolean(s.realtime);

      const delayInfo = this.computeScheduledMatch(timeStr, isRealtime, stopGtfsId, direction, stopMouteId, stopSeq);
      
      let matchedVehicleId = s.tripId || null;
      let matchedCoords = null;
      if (delayInfo.bestTrip) {
        const activeBus = this.interpolateBusPosition(delayInfo.bestTrip, currentSec, stopsMap, stopsList, oppositeTrips);
        if (activeBus && !activeBus.isTerminalLayover) {
          const busFromSeq = activeBus.fromSeq || 0;
          if (stopSeq === null || stopSeq >= busFromSeq) {
            matchedVehicleId = activeBus.vehicleId || activeBus.tripId;
            matchedCoords = { lat: activeBus.lat, lon: activeBus.lon };
          }
        }
      }

      if (isToday) {
        seenTodayTripKeys.add(`${delayInfo.scheduledTime}_${s.direccioId || ''}`);
        seenTodayTripKeys.add(`${delayInfo.scheduledTime}`);
      }

      const depIso = depUtcDate.toISOString();

      results.push({
        lineId: s.liniaId || '02498',
        lineName: 'C-10',
        tripId: s.tripId || delayInfo.bestTrip?.tripId,
        vehicleId: matchedVehicleId,
        busCoords: matchedCoords,
        destination: s.direccio || (s.direccioId === 'R' ? 'Hospital de Mataró' : 'Barcelona'),
        directionId: s.direccioId,
        departureTime: timeStr,
        departureDate: depIso,
        expectedIso: depIso,
        aimedIso: delayInfo.scheduledTime ? new Date(now.getTime() + (diffMinutes - (delayInfo.delayMinutes || 0)) * 60000).toISOString() : depIso,
        minutesAway: diffMinutes,
        isRealtime: isRealtime,
        isToday: isToday,
        scheduledTime: delayInfo.scheduledTime,
        delayMinutes: delayInfo.delayMinutes,
        delayStatus: delayInfo.delayStatus,
        delayBadgeText: delayInfo.delayBadgeText,
        comparisonText: delayInfo.comparisonText,
        formattedStatus: diffMinutes <= 0
          ? 'Imminent'
          : diffMinutes === 1
          ? '1 min'
          : `${diffMinutes} min`
      });
    }

    // CRITICAL: If an active trip is currently in transit today and this stop has dropped from Mou-te due to delay,
    // ensure the active trip is preserved ONLY if it is physically active and has NOT passed this stop yet!
    const stopsListCurrent = isDir1 ? this.stopsDir1 : this.stopsDir0;

    for (const trip of todaysTrips) {
      const stopEntry = trip.stops.find(s => (stopGtfsId && s.stopId === stopGtfsId) || (stopSeq !== null && s.seq === stopSeq));
      if (stopEntry) {
        const schedTime = (stopEntry.arr || stopEntry.dep || '').substring(0, 5);
        const tripKey = `${schedTime}_${isDir1 ? 'R' : 'A'}`;

        if (!seenTodayTripKeys.has(tripKey) && !seenTodayTripKeys.has(schedTime)) {
          const stopSchedSec = timeUtils.timeToSec(stopEntry.dep || stopEntry.arr);
          const thisStopSeq = stopSeq !== null ? stopSeq : (stopEntry.seq || 0);

          // 1. Check if this trip is actively in transit right now
          const activeBusPos = this.interpolateBusPosition(trip, currentSec, stopsMap, stopsListCurrent, oppositeTrips);
          
          if (activeBusPos && !activeBusPos.isTerminalLayover) {
            // Bus is in transit - inject if it hasn't passed this stop yet
            if (thisStopSeq >= activeBusPos.fromSeq) {
              const baseDelaySec = Math.max(0, currentSec - stopSchedSec + 120);
              const estimatedArrivalSec = Math.max(currentSec + 60, stopSchedSec + baseDelaySec);
              const diffSec = estimatedArrivalSec - currentSec;
              const diffMin = Math.max(1, Math.ceil(diffSec / 60));
              const estTimeStr = secToTime(estimatedArrivalSec).substring(0, 5);
              const delayMin = Math.max(0, Math.round((estimatedArrivalSec - stopSchedSec) / 60));

              if (delayMin <= 45) {
                results.push({
                  lineId: '02498',
                  lineName: 'C-10',
                  tripId: trip.tripId,
                  destination: isDir1 ? 'Hospital de Mataró' : 'Barcelona (Metro la Pau)',
                  directionId: isDir1 ? 'R' : 'A',
                  departureTime: estTimeStr,
                  departureDate: new Date(now.getTime() + diffSec * 1000).toISOString(),
                  expectedIso: new Date(now.getTime() + diffSec * 1000).toISOString(),
                  aimedIso: new Date(now.getTime() + (stopSchedSec - currentSec) * 1000).toISOString(),
                  minutesAway: diffMin,
                  isRealtime: true,
                  isToday: true,
                  scheduledTime: schedTime,
                  delayMinutes: delayMin,
                  delayStatus: delayMin >= 2 ? 'delayed' : 'on_time',
                  delayBadgeText: delayMin >= 2 ? `+${delayMin} min retard` : "A l'hora (Puntual)",
                  comparisonText: `Teòric: ${schedTime} (${delayMin >= 2 ? `+${delayMin} min retard` : "A l'hora"})`,
                  formattedStatus: diffMin <= 0 ? 'Imminent' : `${diffMin} min`
                });
                seenTodayTripKeys.add(tripKey);
                seenTodayTripKeys.add(schedTime);
              }
            }
          } else if (stopSchedSec >= currentSec - 60) {
            // 2. Scheduled upcoming departure for today (starts later or approaching per timetable)
            const diffSec = stopSchedSec - currentSec;
            const diffMin = Math.max(0, Math.round(diffSec / 60));

            // Include upcoming departures within 240 minutes
            if (diffMin <= 240) {
              const depUtcDate = new Date(now.getTime() + diffSec * 1000);
              const depIso = depUtcDate.toISOString();

              results.push({
                lineId: '02498',
                lineName: 'C-10',
                tripId: trip.tripId,
                destination: isDir1 ? 'Hospital de Mataró' : 'Barcelona (Metro la Pau)',
                directionId: isDir1 ? 'R' : 'A',
                departureTime: schedTime,
                departureDate: depIso,
                expectedIso: depIso,
                aimedIso: depIso,
                minutesAway: diffMin,
                isRealtime: false,
                isToday: true,
                scheduledTime: schedTime,
                delayMinutes: 0,
                delayStatus: 'scheduled',
                delayBadgeText: 'Programat',
                comparisonText: `Horari teòric: ${schedTime}`,
                formattedStatus: diffMin === 0 ? 'Imminent' : `${diffMin} min`
              });
              seenTodayTripKeys.add(tripKey);
              seenTodayTripKeys.add(schedTime);
            }
          }
        }
      }
    }

    results.sort((a, b) => new Date(a.departureDate).getTime() - new Date(b.departureDate).getTime());

    // Deduplicate results by departureTime and direction
    const dedupedResults = [];
    const seenTimes = new Set();
    for (const r of results) {
      const key = `${r.departureTime}_${r.directionId || ''}_${r.isToday}`;
      if (!seenTimes.has(key)) {
        seenTimes.add(key);
        dedupedResults.push(r);
      }
    }

    const hasToday = dedupedResults.some(r => r.isToday);
    if (!hasToday && dedupedResults.length > 0) {
      dedupedResults[0].isFirstOfDay = true;
      dedupedResults[0].isNextService = true;
      dedupedResults[0].delayBadgeText = '🌅 1r Servei del matí';
      dedupedResults[0].comparisonText = `📅 Pas teòric previst demà a les ${dedupedResults[0].departureTime}`;
    }

    return dedupedResults;
  }

  async getTargetStopETA(direction = '1', customStopId = null, targetDate = null) {
    const isDir1 = direction === '1';
    const defaultStopConfig = isDir1 ? this.targetStop.dir1 : this.targetStop.dir0;
    const stopsList = isDir1 ? this.stopsDir1 : this.stopsDir0;
    const now = (targetDate && !isNaN(new Date(targetDate).getTime())) ? new Date(targetDate) : new Date();
    const calendarInfo = this.getServiceCalendarInfo(now);

    let targetStopObj = null;
    if (customStopId) {
      targetStopObj = stopsList.find(s =>
        s.mouteStopId === customStopId ||
        s.gtfsStopId === customStopId ||
        s.code === customStopId ||
        (s.name && s.name.toLowerCase() === customStopId.toLowerCase())
      );
    }

    if (!targetStopObj) {
      targetStopObj = {
        name: defaultStopConfig.name,
        code: defaultStopConfig.code,
        mouteStopId: defaultStopConfig.mouteStopId,
        gtfsStopId: defaultStopConfig.gtfsStopId,
        seq: defaultStopConfig.seq,
        lat: this.targetStop.coords.lat,
        lon: this.targetStop.coords.lon
      };
    }

    const stopId = targetStopObj.mouteStopId || defaultStopConfig.mouteStopId;
    const gtfsStopId = targetStopObj.gtfsStopId || defaultStopConfig.gtfsStopId;
    const stopSeq = targetStopObj.seq !== undefined ? targetStopObj.seq : defaultStopConfig.seq;

    let allDepartures = [];
    try {
      const data = await mouteClient.getNextDepartures(stopId, true, 'ca_ES');
      allDepartures = this.parseDepartures(data, gtfsStopId, direction, stopId, stopSeq);
    } catch (err) {
      console.warn(`[CorridorTracker] Mou-te API transient issue (${err.message}). Using GTFS schedule fallback.`);
      allDepartures = this.parseDepartures(null, gtfsStopId, direction, stopId, stopSeq);
    }

    const filtered = allDepartures.filter(d => {
      if (isDir1) {
        return d.destination.toLowerCase().includes('mataró') || d.directionId === 'R' || d.directionId === '1';
      } else {
        return d.destination.toLowerCase().includes('barcelona') || d.directionId === 'A' || d.directionId === '0';
      }
    });

    let departuresToUse = filtered;
    if (departuresToUse.length === 0) {
      // If Mou-te single-pole only returned opposite direction, generate from GTFS schedule for this direction
      const scheduleTrips = isDir1 ? (this.fullSchedule?.dir1 || []) : (this.fullSchedule?.dir0 || []);
      const networkNow = timeUtils.getNetworkTime(this.agencyTimezone, now);
      const todaysTrips = scheduleTrips.filter(trip => this.isServiceActiveOnDate(trip.serviceId, now));

      for (const trip of todaysTrips) {
        const stopEntry = trip.stops.find(s => s.stopId === gtfsStopId || s.seq === stopSeq);
        if (stopEntry) {
          const timeStr = (stopEntry.dep || stopEntry.arr || '').substring(0, 5);
          const [h, m] = timeStr.split(':').map(Number);
          const depUtcDate = timeUtils.localTimeToUtcDate(networkNow.year, networkNow.month, networkNow.day, h, m, 0, this.agencyTimezone);
          const diffMs = depUtcDate.getTime() - now.getTime();
          const diffMin = Math.round(diffMs / 60000);

          if (diffMin >= -5 && diffMin <= 180) {
            const depIso = depUtcDate.toISOString();
            departuresToUse.push({
              lineId: '02498',
              lineName: 'C-10',
              destination: isDir1 ? 'Hospital de Mataró' : 'Barcelona (Metro la Pau)',
              directionId: isDir1 ? 'R' : 'A',
              departureTime: timeStr,
              departureDate: depIso,
              expectedIso: depIso,
              aimedIso: depIso,
              minutesAway: diffMin,
              isRealtime: false,
              isToday: true,
              scheduledTime: timeStr,
              delayMinutes: 0,
              delayStatus: 'scheduled',
              delayBadgeText: 'Horari teòric',
              comparisonText: `Horari teòric: ${timeStr}`,
              formattedStatus: diffMin <= 0 ? 'Imminent' : `${diffMin} min`
            });
          }
        }
      }
      departuresToUse.sort((a, b) => a.minutesAway - b.minutesAway);
    }

    if (departuresToUse.length === 0) {
      // If no departures left today, get full schedule of tomorrow
      const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
      const networkTomorrow = timeUtils.getNetworkTime(this.agencyTimezone, tomorrow);
      const scheduleTrips = isDir1 ? (this.fullSchedule?.dir1 || []) : (this.fullSchedule?.dir0 || []);
      const tomorrowsTrips = scheduleTrips.filter(trip => this.isServiceActiveOnDate(trip.serviceId, tomorrow));
      tomorrowsTrips.sort((a, b) => timeToSec(a.stops[0].dep) - timeToSec(b.stops[0].dep));

      if (tomorrowsTrips.length > 0) {
        tomorrowsTrips.forEach((trip, tIdx) => {
          const stopEntry = trip.stops.find(s => s.stopId === gtfsStopId || s.seq === stopSeq) || trip.stops[0];
          if (stopEntry) {
            const timeStr = (stopEntry.dep || stopEntry.arr || '').substring(0, 5);
            const [h, m] = timeStr.split(':').map(Number);
            const depUtcDate = timeUtils.localTimeToUtcDate(networkTomorrow.year, networkTomorrow.month, networkTomorrow.day, h, m, 0, this.agencyTimezone);
            const diffMs = depUtcDate.getTime() - now.getTime();
            const diffMin = Math.max(1, Math.round(diffMs / 60000));
            const depIso = depUtcDate.toISOString();
            const isFirst = tIdx === 0;

            departuresToUse.push({
              lineId: '02498',
              lineName: 'C-10',
              destination: isDir1 ? 'Hospital de Mataró' : 'Barcelona (Metro la Pau)',
              directionId: isDir1 ? 'R' : 'A',
              departureTime: timeStr,
              departureDate: depIso,
              expectedIso: depIso,
              aimedIso: depIso,
              minutesAway: diffMin,
              isRealtime: false,
              isToday: false,
              isFirstOfDay: isFirst,
              isNextService: isFirst,
              scheduledTime: timeStr,
              delayMinutes: 0,
              delayStatus: 'scheduled',
              delayBadgeText: isFirst ? '🌅 1r Servei del matí' : 'Programat',
              comparisonText: isFirst ? `📅 Pas teòric previst demà a les ${timeStr}` : `📅 Horari teòric: ${timeStr}`,
              formattedStatus: `${timeStr}`
            });
          }
        });
      }
    }

    const nextBus = departuresToUse.find(d => d.minutesAway >= -2) || departuresToUse[0] || null;
    if (nextBus && (!nextBus.isToday || nextBus.isNextService)) {
      nextBus.delayBadgeText = '🌅 1r Servei del matí';
    }

    const firstTimeTomorrow = departuresToUse[0]?.departureTime || (isDir1 ? '08:15' : '06:45');

    return {
      targetStop: {
        name: targetStopObj.name,
        stopName: targetStopObj.name,
        code: targetStopObj.code,
        mouteStopId: stopId,
        gtfsStopId: gtfsStopId,
        seq: stopSeq,
        coords: {
          lat: targetStopObj.lat || this.targetStop.coords.lat,
          lon: targetStopObj.lon || this.targetStop.coords.lon
        },
        direction: direction,
        directionName: isDir1 ? 'Sentit Mataró' : 'Sentit Barcelona',
        googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${targetStopObj.lat || this.targetStop.coords.lat},${targetStopObj.lon || this.targetStop.coords.lon}`
      },
      nextBus: nextBus,
      upcomingDepartures: departuresToUse,
      allDepartures: departuresToUse,
      calendarInfo: calendarInfo,
      serviceStatus: {
        isOperating: departuresToUse.some(d => d.isToday && (d.isRealtime || d.minutesAway <= 120)),
        period: (() => { const dc = calendarEngine.getDateComponents(new Date(), 'Europe/Madrid'); return (dc.hour >= 22 || dc.hour < 6) ? 'night' : 'day'; })(),
        firstServiceTomorrow: firstTimeTomorrow,
        statusText: departuresToUse.some(d => d.isToday && (d.isRealtime || d.minutesAway <= 120))
          ? `Servei en funcionament • ${calendarInfo.calendarTag}`
          : `Servei fora d'horari • Represa demà a les ${firstTimeTomorrow}`
      },
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Maps a C-10 stop to its AMB stop code via geographic proximity against
   * data/cache/stops.json (AMB_* stops carry the AMB API's codes). Memoised.
   */
  ambCodeForStop(stopObj) {
    const key = String(stopObj.id || stopObj.mouteStopId || stopObj.gtfsStopId);
    if (this._ambCodeByStop.has(key)) return this._ambCodeByStop.get(key);
    let code = null;
    try {
      if (Number.isFinite(stopObj.lat) && Number.isFinite(stopObj.lon)) {
        const stopsPath = path.join(this.dataDir, 'cache', 'stops.json');
        if (!this._ambCatalogStops) {
          this._ambCatalogStops = [];
          if (fs.existsSync(stopsPath)) {
            JSON.parse(fs.readFileSync(stopsPath, 'utf8')).forEach(s => {
              if (String(s.id || '').startsWith('AMB_') && Number.isFinite(s.lat)) {
                this._ambCatalogStops.push({ code: String(s.code || s.id.replace('AMB_', '')), lat: s.lat, lon: s.lon });
              }
            });
          }
        }
        let best = null;
        for (const s of this._ambCatalogStops) {
          const d = Math.hypot((s.lat - stopObj.lat) * 111320, (s.lon - stopObj.lon) * 111320 * Math.cos(stopObj.lat * Math.PI / 180));
          if (d < 60 && (!best || d < best.d)) best = { code: s.code, d };
        }
        if (best) code = best.code;
      }
    } catch (_) {}
    this._ambCodeByStop.set(key, code);
    return code;
  }

  /**
   * Fetches AMB v2 realtime arrivals for an AMB stop code (30s cache).
   * Returns the raw times array or [].
   */
  fetchAmbRealtime(ambStopCode) {
    const now = Date.now();
    const cached = this._ambRealtimeCache.get(ambStopCode);
    if (cached && (now - cached.timestamp < 30000)) return Promise.resolve(cached.times);
    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.ambmobilitat.cat',
        path: `/v2/bus/stops/${encodeURIComponent(ambStopCode)}/realtimes`,
        method: 'GET',
        headers: {
          'x-api-key': this._ambApiKey,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/json'
        },
        timeout: 5000
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          let times = [];
          try {
            const j = JSON.parse(data);
            times = (res.statusCode === 200 && Array.isArray(j?.times)) ? j.times : [];
          } catch (_) {}
          this._ambRealtimeCache.set(ambStopCode, { timestamp: now, times });
          resolve(times);
        });
      });
      req.on('timeout', () => { req.destroy(); resolve([]); });
      req.on('error', () => resolve([]));
      req.end();
    });
  }

  /**
   * Merges AMB v2 realtime C-10 arrivals into a departures board. Realtime
   * entries replace scheduled ones within ±4 minutes; otherwise they are
   * appended (the operator app can track buses the GTFS timetable omits).
   */
  /** Scheduled origin→terminus duration for a C-10 trip (purge policy input). */
  runDurationForTrip(tripId, isDir1) {
    try {
      const trips = isDir1 ? (this.fullSchedule?.dir1 || []) : (this.fullSchedule?.dir0 || []);
      const t = trips.find(x => x.trip && String(x.trip.tripId) === String(tripId))
        || trips.find(x => String(x.tripId || '') === String(tripId));
      const stops = t?.trip?.stops || t?.stops;
      if (!Array.isArray(stops) || stops.length < 2) return null;
      const first = stops[0], last = stops[stops.length - 1];
      const s0 = timeToSec(first.dep || first.arr), s1 = timeToSec(last.dep || last.arr);
      if (!Number.isFinite(s0) || !Number.isFinite(s1)) return null;
      return Math.max(0, s1 - s0);
    } catch (_) { return null; }
  }

  async mergeAmbRealtimeDepartures(departures, stopObj, isDir1) {
    try {
      const ambCode = this.ambCodeForStop(stopObj);
      if (!ambCode) return departures;
      const times = await this.fetchAmbRealtime(ambCode);
      const c10Times = times.filter(t => /^c\s*-?\s*10$/i.test(String(t.lineCode || '')));
      if (c10Times.length === 0) return departures;

      const now = Date.now();
      // Candidate pool: existing board entries the realtime buses may correspond
      // to. A realtime-tracked bus IS one of the scheduled trips (possibly
      // delayed), so each AMB entry REPLACES its nearest scheduled entry —
      // never appends a duplicate next to it. C-10 headways are 45-90 min,
      // so nearest-match within 40 min is unambiguous; beyond that, append.
      const pool = departures.filter(d =>
        d.isToday !== false &&
        Number.isFinite(d.minutesAway) &&
        !/AMB/.test(d.delayBadgeText || '') &&
        d.departureTime !== '--:--'
      );
      const matched = new Set();

      // Process realtime entries in chronological order for stable matching
      c10Times.sort((a, b) => Number(a.time) - Number(b.time));
      for (const t of c10Times) {
        const arrMs = Number(t.time) > 1e11 ? Number(t.time) : now + Number(t.arrivalTime || 0) * 1000;
        if (!Number.isFinite(arrMs) || arrMs < now - 5 * 60000) continue;
        const diffMin = Math.max(0, Math.round((arrMs - now) / 60000));
        const clockStr = timeUtils.formatTimeToTimezone(new Date(arrMs), this.agencyTimezone);
        if (clockStr === '--:--') continue;

        // Destination sanity: dir1 heads to Mataró, dir0 to Barcelona
        const dest = String(t.destination || '');
        const destIsMataro = /matar/i.test(dest);
        if (isDir1 !== destIsMataro) continue;

        // Nearest unmatched candidate (any distance up to 40 min)
        let best = null;
        for (const cand of pool) {
          if (matched.has(cand)) continue;
          const d = Math.abs((cand.minutesAway || 0) - diffMin);
          if (d <= 40 && (!best || d < best.d)) best = { cand, d };
        }

        if (best) {
          matched.add(best.cand);
          const existing = best.cand;
          const schedRef = existing.scheduledTime || existing.departureTime;
          // Real delay vs the replaced entry's OFFICIAL scheduled time
          // (aimedIso = GTFS schedule; expectedIso may already be realtime)
          const schedIso = existing.aimedIso || existing.expectedIso;
          const schedMs = Date.parse(schedIso);
          const delayMin = Number.isFinite(schedMs) ? Math.round((arrMs - schedMs) / 60000) : 0;
          const delayInfo = delayEngine.computeDelayStatus(delayMin, true, {
            scheduledTime: schedRef
          });
          existing.expectedIso = new Date(arrMs).toISOString();
          existing.departureTime = clockStr;
          existing.minutesAway = diffMin;
          existing.isRealTime = true;
          existing.delayMinutes = delayMin;
          existing.delayMins = delayMin;
          existing.scheduledTime = schedRef;
          existing.delayStatus = delayInfo.delayStatus;
          existing.delayFormatted = delayInfo.delayFormatted;
          existing.delayBadgeText = delayMin >= 2
            ? `🔴 Temps real (AMB) · +${delayMin} min retard`
            : '🔴 Temps real (AMB) · A l\'hora';
          existing.comparisonText = `🔴 Temps real AMB (horari teòric: ${schedRef}${delayMin > 0 ? `, +${delayMin} min de retard` : ''})`;
          existing.formattedStatus = diffMin === 0 ? 'Imminent' : `${diffMin} min`;
          // Persist the observation (delay memory): downstream stops without
          // realtime coverage will propagate this known delay via tripId.
          if (existing.tripId) {
            delayMemory.record([{
              agency: 'amb',
              lineCode: 'C-10',
              lineId: 'c10',
              direction: isDir1 ? '1' : '0',
              tripId: existing.tripId,
              stopId: String(stopObj.gtfsStopId || stopObj.mouteStopId || stopObj.id || ''),
              stopName: stopObj.name || null,
              scheduledMs: schedMs,
              actualMs: arrMs,
              delayMins: delayMin,
              runDurationSecs: this.runDurationForTrip(existing.tripId, isDir1)
            }]);
          }
        } else {
          departures.push({
            lineId: '02498',
            lineName: 'C-10',
            tripId: t.tripId || null,
            destination: isDir1 ? 'Hospital de Mataró' : 'Barcelona (Metro la Pau)',
            directionId: isDir1 ? 'R' : 'A',
            departureTime: clockStr,
            expectedIso: new Date(arrMs).toISOString(),
            aimedIso: new Date(arrMs).toISOString(),
            minutesAway: diffMin,
            isRealTime: true,
            isToday: true,
            delayMinutes: 0,
            delayStatus: 'on_time',
            delayBadgeText: '🔴 Temps real (AMB)',
            comparisonText: `🔴 Temps real AMB (${clockStr})`,
            formattedStatus: diffMin === 0 ? 'Imminent' : `${diffMin} min`
          });
        }
      }
      departures.sort((a, b) => (a.minutesAway || 0) - (b.minutesAway || 0));
    } catch (_) { /* realtime is best-effort */ }
    return departures;
  }

  /**
   * Today's active GTFS trips serving BOTH stops of a direction, as
   * [{trip, secAtUp, secAtDown}] sorted by secAtUp. Used for realtime
   * propagation: the schedule delta between the two stops.
   */
  gtfsTripsServingBoth(dir, upGtfsId, downGtfsId, dateObj = new Date()) {
    const isDir1 = String(dir) === '1';
    const trips = isDir1 ? (this.fullSchedule?.dir1 || []) : (this.fullSchedule?.dir0 || []);
    const out = [];
    for (const trip of trips) {
      if (!this.isServiceActiveOnDate(trip.serviceId, dateObj)) continue;
      const up = trip.stops.find(s => s.stopId === upGtfsId);
      if (!up) continue;
      const down = trip.stops.find(s => s.stopId === downGtfsId);
      if (!down) continue;
      const secAtUp = timeToSec(up.dep || up.arr);
      const secAtDown = timeToSec(down.dep || down.arr);
      if (!Number.isFinite(secAtUp) || !Number.isFinite(secAtDown)) continue;
      out.push({ trip, secAtUp, secAtDown });
    }
    out.sort((a, b) => a.secAtUp - b.secAtUp);
    return out;
  }

  /**
   * Propagates AMB v2 realtime arrivals from upstream stops to this stop.
   * A bus tracked in realtime at an upstream stop U will reach this stop S
   * after U; the estimated arrival = realtimeAtU + (schedAtS - schedAtU)
   * using the matched official trip's own stop-to-stop deltas.
   *
   * Checks the 6 nearest upstream stops (C-10 travel time ~2-3 min/stop, so
   * this covers buses arriving within ~20 min of S). Estimates never
   * duplicate an existing board entry within ±3 min.
   */
  async propagateUpstreamAmbRealtime(departures, stopObj, isDir1) {
    try {
      const stopsList = isDir1 ? this.stopsDir1 : this.stopsDir0;
      const seq = Number(stopObj.seq);
      if (!Number.isFinite(seq) || seq === 0) return departures;
      const downGtfsId = stopObj.gtfsStopId || stopObj.mouteStopId;

      const now = Date.now();
      const netNow = timeUtils.getNetworkTime(this.agencyTimezone, new Date(now));
      const nowSec = netNow.hour * 3600 + netNow.minute * 60 + netNow.second;
      const secToTimeStr = (sec) => `${String(Math.floor(sec / 3600) % 24).padStart(2, '0')}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}`;

      let added = 0;
      for (let k = 1; k <= 6 && added < 3; k++) {
        const up = stopsList[seq - k];
        if (!up) break;
        const upGtfsId = up.gtfsStopId || up.mouteStopId;
        const ambCode = this.ambCodeForStop(up);
        if (!ambCode) continue;

        const times = await this.fetchAmbRealtime(ambCode);
        const c10Times = times.filter(t => /^c\s*-?\s*10$/i.test(String(t.lineCode || '')));
        if (c10Times.length === 0) continue;

        for (const t of c10Times) {
          if (added >= 3) break;
          const arrMs = Number(t.time) > 1e11 ? Number(t.time) : now + Number(t.arrivalTime || 0) * 1000;
          if (!Number.isFinite(arrMs) || arrMs < now - 5 * 60000) continue;

          // Destination sanity
          const destIsMataro = /matar/i.test(String(t.destination || ''));
          if (isDir1 !== destIsMataro) continue;

          // Match the bus to an official trip serving both U and S
          const rtSecAtUp = Math.round((arrMs - (now - nowSec * 1000)) / 1000) % 86400;
          const pairs = this.gtfsTripsServingBoth(isDir1 ? '1' : '0', upGtfsId, downGtfsId, new Date(now));
          let bestTrip = null, bestDiff = Infinity;
          for (const p of pairs) {
            let d = Math.abs(p.secAtUp - rtSecAtUp);
            if (d > 43200) d = 86400 - d; // midnight wrap
            if (d < bestDiff) { bestDiff = d; bestTrip = p; }
          }
          if (!bestTrip || bestDiff > 40 * 60) continue; // no plausible official trip

          // Schedule delta from the matched trip → estimated arrival at S
          let estSec = rtSecAtUp + (bestTrip.secAtDown - bestTrip.secAtUp);
          let estIsToday = true;
          if (estSec < nowSec - 300 && estSec < 12 * 3600) { estSec += 86400; estIsToday = false; }
          const diffMin = Math.round((estSec - nowSec) / 60);
          if (diffMin < -1 || diffMin > 360) continue;
          const passTimeStr = secToTimeStr(estSec);

          // Never duplicate: skip if the board already has this time covered
          const covered = departures.some(d =>
            d.isToday !== false &&
            Number.isFinite(d.minutesAway) &&
            Math.abs((d.minutesAway || 0) - diffMin) <= 3
          );
          if (covered) continue;

          const depIso = timeUtils.localTimeToUtcDate(netNow.year, netNow.month, netNow.day + (estIsToday ? 0 : 1), Math.floor(estSec / 3600) % 24, Math.floor(estSec / 60) % 60, 0, this.agencyTimezone).toISOString();
          departures.push({
            lineId: '02498',
            lineName: 'C-10',
            tripId: bestTrip.trip.tripId,
            destination: isDir1 ? 'Hospital de Mataró' : 'Barcelona (Metro la Pau)',
            directionId: isDir1 ? 'R' : 'A',
            departureTime: passTimeStr,
            expectedIso: depIso,
            aimedIso: depIso,
            minutesAway: Math.max(1, diffMin),
            isRealTime: false,
            isEstimated: true,
            isToday: estIsToday,
            isFirstOfDay: false,
            delayStatus: bestDiff > 5 * 60 ? 'delayed' : 'on_time',
            delayMinutes: Math.max(0, Math.round((rtSecAtUp - bestTrip.secAtUp) / 60)),
            delayBadgeText: `📍 Estimat (temps real AMB)`,
            comparisonText: `📍 Estimat: temps real a ${up.name} + horari oficial fins a aquesta parada`,
            formattedStatus: diffMin === 0 ? 'Imminent' : `${diffMin} min`
          });
          added++;
        }
      }
      if (added > 0) departures.sort((a, b) => (a.minutesAway || 0) - (b.minutesAway || 0));
    } catch (_) { /* propagation is best-effort */ }
    return departures;
  }

  async getStopDepartures(stopId, direction = '1', targetDate = null) {
    let isDir1 = direction === '1';
    let stopsList = isDir1 ? this.stopsDir1 : this.stopsDir0;
    let stopObj = stopsList.find(s => s.mouteStopId === stopId || s.gtfsStopId === stopId || s.id === stopId) || null;
    if (!stopObj) {
      // Auto-resolve: the client may pass direction='both' (ambdós sentits) or
      // a stale direction hint. Find which direction actually owns this stop —
      // otherwise reverse-direction stops resolve to nothing and fall through
      // to the "next service tomorrow" block.
      const otherList = isDir1 ? this.stopsDir0 : this.stopsDir1;
      const alt = otherList.find(s => s.mouteStopId === stopId || s.gtfsStopId === stopId || s.id === stopId);
      if (alt) {
        isDir1 = !isDir1;
        stopsList = otherList;
        stopObj = alt;
      }
    }
    const gtfsStopId = stopObj ? stopObj.gtfsStopId : null;
    const seq = stopObj && stopObj.seq !== undefined ? stopObj.seq : null;
    const now = (targetDate && !isNaN(new Date(targetDate).getTime())) ? new Date(targetDate) : new Date();
    const calendarInfo = this.getServiceCalendarInfo(now);

    let departures = [];
    try {
      const data = await mouteClient.getNextDepartures(stopId, true, 'ca_ES');
      departures = this.parseDepartures(data, gtfsStopId, direction, stopId, seq);
    } catch (err) {
      console.warn(`[CorridorTracker] Mou-te API transient issue for stop ${stopId} (${err.message}). Using GTFS schedule fallback.`);
      departures = this.parseDepartures(null, gtfsStopId, direction, stopId, seq);
    }

    if (departures.length === 0) {
      const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
      const networkTomorrow = timeUtils.getNetworkTime(this.agencyTimezone, tomorrow);
      const scheduleTrips = isDir1 ? (this.fullSchedule?.dir1 || []) : (this.fullSchedule?.dir0 || []);
      const tomorrowsTrips = scheduleTrips.filter(trip => this.isServiceActiveOnDate(trip.serviceId, tomorrow));
      tomorrowsTrips.sort((a, b) => timeToSec(a.stops[0].dep) - timeToSec(b.stops[0].dep));

      if (tomorrowsTrips.length > 0) {
        tomorrowsTrips.forEach((trip, tIdx) => {
          const stopEntry = trip.stops.find(s => s.stopId === gtfsStopId || s.seq === seq) || trip.stops[0];
          if (stopEntry) {
            const timeStr = (stopEntry.dep || stopEntry.arr || '').substring(0, 5);
            const [h, m] = timeStr.split(':').map(Number);
            const depUtcDate = timeUtils.localTimeToUtcDate(networkTomorrow.year, networkTomorrow.month, networkTomorrow.day, h, m, 0, this.agencyTimezone);
            const diffMs = depUtcDate.getTime() - now.getTime();
            const diffMin = Math.max(1, Math.round(diffMs / 60000));
            const depIso = depUtcDate.toISOString();
            const isFirst = tIdx === 0;

            departures.push({
              lineId: '02498',
              lineName: 'C-10',
              destination: isDir1 ? 'Hospital de Mataró' : 'Barcelona (Metro la Pau)',
              directionId: isDir1 ? 'R' : 'A',
              departureTime: timeStr,
              departureDate: depIso,
              expectedIso: depIso,
              aimedIso: depIso,
              minutesAway: diffMin,
              isRealtime: false,
              isToday: false,
              isFirstOfDay: isFirst,
              isNextService: isFirst,
              scheduledTime: timeStr,
              delayMinutes: 0,
              delayStatus: 'scheduled',
              delayBadgeText: isFirst ? '🌅 1r Servei del matí' : 'Programat',
              comparisonText: isFirst ? `📅 Pas teòric previst demà a les ${timeStr}` : `📅 Horari teòric: ${timeStr}`,
              formattedStatus: `${timeStr}`
            });
          }
        });
      }
    }

    // Supplementary AMB v2 realtime: the operator app tracks C-10 buses there
    // even when Mou-te has no realtime for the stop.
    departures = await this.mergeAmbRealtimeDepartures(departures, stopObj || {}, isDir1);
    // Propagate those realtime arrivals to downstream stops without their own
    // realtime, using the official schedule's stop-to-stop deltas.
    departures = await this.propagateUpstreamAmbRealtime(departures, stopObj || {}, isDir1);
    // Delay memory: buses observed (and persisted) upstream keep showing
    // their known delay at stops beyond the realtime-covered stretch.
    departures = await delayMemory.applyKnownDelays(departures, {
      lineId: 'c10',
      direction: isDir1 ? '1' : '0'
    }, {
      badgeKnown: '⏱ Retard conegut',
      formatClock: (ms) => timeUtils.formatTimeToTimezone(new Date(ms), this.agencyTimezone)
    });

    return {
      stopId: stopId,
      stopName: stopObj.name || '',
      departures: departures,
      calendarInfo: calendarInfo,
      lastUpdated: new Date().toISOString()
    };
  }

  interpolateBusPosition(trip, currentSec, stopsMap, stopsList, oppositeTrips = []) {
    const stops = trip.stops;
    if (!stops || stops.length < 2) return null;

    const firstDep = timeToSec(stops[0].dep);
    const lastArr = timeToSec(stops[stops.length - 1].arr);

    // Determine when the next turnaround departure from this terminal starts
    let turnaroundDepartureSec = lastArr + 300; // default 5 mins
    if (oppositeTrips && oppositeTrips.length > 0) {
      const nextOpposite = oppositeTrips.find(t => {
        const depSec = timeToSec(t.stops[0].dep);
        return depSec >= lastArr - 120;
      });
      if (nextOpposite) {
        turnaroundDepartureSec = timeToSec(nextOpposite.stops[0].dep);
      }
    }

    // Trip is inactive if before first departure or after turnaround departure
    if (currentSec < firstDep - 60 || currentSec >= turnaroundDepartureSec) {
      return null;
    }

    // If the bus has reached the terminal stop and is in layover/turnaround:
    if (currentSec >= lastArr && currentSec < turnaroundDepartureSec) {
      const termStop = stops[stops.length - 1];
      const termStopData = stopsMap.get(termStop.stopId) || stopsList[stopsList.length - 1] || {};
      if (termStopData.lat && termStopData.lon) {
        const minsLeft = Math.max(1, Math.ceil((turnaroundDepartureSec - currentSec) / 60));
        const depTimeStr = secToTime(turnaroundDepartureSec).substring(0, 5);
        return {
          tripId: trip.tripId,
          tripStartTime: (trip.stops[0]?.dep || trip.stops[0]?.arr || '').substring(0, 5),
          isTerminalLayover: true,
          headsign: trip.headsign,
          fromStop: termStopData.name || 'Terminal de línia',
          toStop: `Sortida tornada a les ${depTimeStr}`,
          fromSeq: termStop.seq,
          toSeq: termStop.seq,
          progressInSegment: 1,
          totalProgress: 100,
          lat: Math.round(termStopData.lat * 1000000) / 1000000,
          lon: Math.round(termStopData.lon * 1000000) / 1000000,
          coordinatesFormatted: `${termStopData.lat.toFixed(5)}° N, ${termStopData.lon.toFixed(5)}° E`,
          bearing: 0,
          compass: { code: 'P', label: '🅿️ Regulació' },
          speedKmh: 0,
          distanceToNextMeters: 0,
          segmentDistanceMeters: 0,
          fromCoords: { lat: termStopData.lat, lon: termStopData.lon },
          toCoords: { lat: termStopData.lat, lon: termStopData.lon },
          segStartSec: lastArr,
          segEndSec: turnaroundDepartureSec,
          secondsToNextStop: 0,
          currentSegmentTime: `Arribat a les ${secToTime(lastArr).substring(0, 5)} • Sortida tornada a les ${depTimeStr} (en ~${minsLeft} min)`,
          allStops: []
        };
      }
    }

    for (let i = 0; i < stops.length - 1; i++) {
      const s1 = stops[i];
      const s2 = stops[i + 1];
      const t1 = timeToSec(s1.dep);
      const t2 = timeToSec(s2.arr);

      // Match segment if current time is within [t1, t2) or if it's the final stop segment
      if (currentSec >= t1 && (currentSec < t2 || i === stops.length - 2)) {
        const segDuration = Math.max(1, t2 - t1);
        const progress = Math.max(0, Math.min(1, (currentSec - t1) / segDuration));

        const stop1Data = stopsMap.get(s1.stopId) || stopsList[i] || {};
        const stop2Data = stopsMap.get(s2.stopId) || stopsList[i + 1] || {};

        if (stop1Data.lat && stop2Data.lat) {
          const interp = geoEngine.interpolateCoordinate(stop1Data.lat, stop1Data.lon, stop2Data.lat, stop2Data.lon, progress);
          const lat = interp.lat;
          const lon = interp.lon;

          const bearing = geoEngine.calculateBearing(stop1Data.lat, stop1Data.lon, stop2Data.lat, stop2Data.lon);
          const compass = geoEngine.bearingToCompassName(bearing);
          const distToNext = Math.round(geoEngine.calculateDistanceMeters(lat, lon, stop2Data.lat, stop2Data.lon));
          const segDist = Math.round(geoEngine.calculateDistanceMeters(stop1Data.lat, stop1Data.lon, stop2Data.lat, stop2Data.lon));
          const speedKmh = segDuration > 0 ? Math.min(85, Math.max(15, Math.round((segDist / segDuration) * 3.6))) : 40;

          // Build lightweight allStops array for client-side multi-segment smooth gliding
          const allStopsFormatted = stops.map((st, idx) => {
            const stData = stopsMap.get(st.stopId) || stopsList[idx] || {};
            return {
              seq: st.seq,
              name: stData.name || '',
              lat: stData.lat,
              lon: stData.lon,
              depSec: timeToSec(st.dep),
              arrSec: timeToSec(st.arr)
            };
          }).filter(st => st.lat && st.lon);

        return {
          tripId: trip.tripId,
          tripStartTime: (trip.stops[0]?.dep || trip.stops[0]?.arr || '').substring(0, 5),
          vehicleId: `c10_${trip.tripId}`,
          headsign: trip.headsign,
          fromStop: stop1Data.name || 'Parada anterior',
          toStop: stop2Data.name || 'Propera parada',
          fromSeq: s1.seq,
          toSeq: s2.seq,
          progressInSegment: progress,
          totalProgress: Math.min(100, Math.max(0, Math.round(((s1.seq + progress) / stops.length) * 100))),
          lat: Math.round(lat * 1000000) / 1000000,
          lon: Math.round(lon * 1000000) / 1000000,
          coordinatesFormatted: `${lat.toFixed(5)}° N, ${lon.toFixed(5)}° E`,
          bearing: bearing,
          compass: compass,
          speedKmh: speedKmh,
          distanceToNextMeters: distToNext,
          segmentDistanceMeters: segDist,
          fromCoords: { lat: stop1Data.lat, lon: stop1Data.lon },
          toCoords: { lat: stop2Data.lat, lon: stop2Data.lon },
          segStartSec: t1,
          segEndSec: t2,
          secondsToNextStop: Math.max(0, t2 - currentSec),
          currentSegmentTime: `${secToTime(t1).substring(0, 5)} ➔ ${secToTime(t2).substring(0, 5)}`,
          // Official scheduled departure from the trip's first stop — the hour
          // this bus started its current direction.
          tripStartTime: (trip.stops[0].dep || trip.stops[0].arr || '').substring(0, 5),
          allStops: allStopsFormatted,
          isDeadReckoned: true,
          isEstimated: true,
          statusText: '⚡ Estimació de Posició (Dead-Reckoning)'
        };
        }
      }
    }

    return null;
  }

  async getCorridorLiveTracking(direction = '1') {
    const cached = this.liveTrackingCache.get(direction);
    const nowMs = Date.now();
    if (cached && (nowMs - cached.timestamp < 15000)) {
      return cached.data;
    }

    const isDir1 = direction === '1';
    const checkpoints = isDir1 ? this.checkpointsDir1 : this.checkpointsDir0;
    const scheduleTrips = isDir1 ? (this.fullSchedule?.dir1 || []) : (this.fullSchedule?.dir0 || []);
    const stopsMap = isDir1 ? this.stopsMapDir1 : this.stopsMapDir0;
    const stopsList = isDir1 ? this.stopsDir1 : this.stopsDir0;

    const now = new Date();
    const networkNow = timeUtils.getNetworkTime(this.agencyTimezone, now);
    const currentSec = networkNow.currentSec;

    const todaysTrips = scheduleTrips.filter(trip => this.isServiceActiveOnDate(trip.serviceId, now));
    todaysTrips.sort((a, b) => timeToSec(a.stops[0].dep) - timeToSec(b.stops[0].dep));

    const oppositeScheduleTrips = isDir1 ? (this.fullSchedule?.dir0 || []) : (this.fullSchedule?.dir1 || []);
    const oppositeTrips = oppositeScheduleTrips.filter(trip => this.isServiceActiveOnDate(trip.serviceId, now));
    oppositeTrips.sort((a, b) => timeToSec(a.stops[0].dep) - timeToSec(b.stops[0].dep));

    const activeBuses = [];
    for (const trip of todaysTrips) {
      const busPos = this.interpolateBusPosition(trip, currentSec, stopsMap, stopsList, oppositeTrips);
      if (busPos) {
        activeBuses.push(busPos);
      }
    }

    const primaryBus = activeBuses[0] || null;
    const primaryActiveTrip = primaryBus ? todaysTrips.find(t => t.tripId === primaryBus.tripId) : null;
    const nextUpcomingTrip = todaysTrips.find(t => timeToSec(t.stops[t.stops.length - 1].arr) >= currentSec) || todaysTrips[0] || null;
    const targetTripToTrack = primaryActiveTrip || nextUpcomingTrip;

    const checkpointResults = checkpoints.map(cp => {
      const stopEntry = targetTripToTrack?.stops?.find(s => s.stopId === cp.gtfsStopId || s.seq === cp.seq);
      const stopSchedTime = stopEntry ? (stopEntry.dep || stopEntry.arr || '').substring(0, 5) : null;
      let next = null;

      if (primaryBus && targetTripToTrack && cp.seq <= primaryBus.fromSeq) {
        next = {
          lineId: '02498',
          lineName: 'C-10',
          destination: isDir1 ? 'Hospital de Mataró' : 'Barcelona (Metro la Pau)',
          departureTime: stopSchedTime || '--:--',
          scheduledTime: stopSchedTime || '--:--',
          delayMinutes: 0,
          delayStatus: 'passed',
          delayBadgeText: 'Passat ✓',
          isRealtime: true,
          isPassed: true,
          minutesAway: -1,
          formattedStatus: 'Passat ✓'
        };
      } else if (stopSchedTime) {
        const [h, m] = stopSchedTime.split(':').map(Number);
        const schedSec = h * 3600 + m * 60;
        const diffSec = schedSec - currentSec;
        const diffMin = Math.max(1, Math.round(diffSec / 60));
        const depIso = new Date(now.getTime() + diffSec * 1000).toISOString();

        next = {
          lineId: '02498',
          lineName: 'C-10',
          destination: isDir1 ? 'Hospital de Mataró' : 'Barcelona (Metro la Pau)',
          departureTime: stopSchedTime,
          departureDate: depIso,
          expectedIso: depIso,
          aimedIso: depIso,
          minutesAway: diffMin,
          isRealtime: false,
          isToday: true,
          scheduledTime: stopSchedTime,
          delayMinutes: 0,
          delayStatus: 'scheduled',
          delayBadgeText: 'Horari teòric',
          formattedStatus: `${diffMin} min`
        };
      }

      return {
        id: cp.id,
        gtfsStopId: cp.gtfsStopId,
        name: cp.name,
        zone: cp.zone,
        seq: cp.seq,
        nextBus: next
      };
    });


    // Ensure the road-snapped polyline upgrade has run before serving coords.
    await this.ensureOsrmPolylines();
    const polyline = isDir1 ? this.routePolylineDir1 : this.routePolylineDir0;
    const geometrySource = this._polylineUpgraded?.[isDir1 ? '1' : '0'] ? 'osrm' : 'gtfs';
    const geometryEstimated = Boolean(this._polylineUpgraded?.[isDir1 ? '1' : '0']);

    const result = {
      direction: direction,
      currentSec: currentSec,
      activeServiceCount: todaysTrips.length,
      checkpoints: checkpointResults,
      activeBuses: activeBuses,
      stops: stopsList,
      routePolyline: polyline,
      coords: polyline,
      geometrySource,
      geometryEstimated,
      trackedTripId: targetTripToTrack?.tripId || null,
      calendarInfo: this.getServiceCalendarInfo(now),
      targetStop: this.targetStop,
      lastUpdated: new Date().toISOString()
    };

    this.liveTrackingCache.set(direction, { data: result, timestamp: Date.now() });
    return result;
  }
}

module.exports = new CorridorTracker();

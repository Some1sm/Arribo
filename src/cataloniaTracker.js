const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const mouteClient = require('./mouteClient');
const geoUtils = require('./geoUtils');
const timeUtils = require('./timeUtils');
const indexer = require('./cataloniaIndexer');

class CataloniaTracker {
  constructor() {
    this.cacheDir = path.join(__dirname, '..', 'data', 'cache');
    this.shapesDbPath = path.join(__dirname, '..', 'data', 'shapes.db');
    this.shapesDb = null;
    this.getShapeStmt = null;
    this.routes = [];
    this.routesMap = new Map();
    this.routeDetailsMap = new Map();
    this.stopsMap = new Map();
    this.allStopsMap = new Map();
    this.calendar = new Map();
    this.calendarExceptions = new Map(); // dateStr -> { active: Set, inactive: Set }
    this.isLoaded = false;
  }

  async init() {
    if (this.isLoaded) return;
    const start = Date.now();

    const activeCacheDir = this.cacheDir;
    const routesCachePath = path.join(activeCacheDir, 'routes.json');
    const stopsCachePath = path.join(activeCacheDir, 'stops.json');
    const routeDetailsPath = path.join(activeCacheDir, 'route_details.json');
    const calendarPath = path.join(activeCacheDir, 'calendar.json');
    const calendarDatesPath = path.join(activeCacheDir, 'calendar_dates.json');

    if ((!fs.existsSync(routesCachePath) || !fs.existsSync(routeDetailsPath) || !fs.existsSync(calendarPath)) &&
        fs.existsSync(path.join(__dirname, '..', 'data', 'atm_gtfs', 'agency.txt'))) {
      await indexer.buildIndex();
    }

    try {
      const routesData = fs.existsSync(routesCachePath) ? JSON.parse(fs.readFileSync(routesCachePath, 'utf8')) : [];
      const routeDetailsData = fs.existsSync(routeDetailsPath) ? JSON.parse(fs.readFileSync(routeDetailsPath, 'utf8')) : {};
      const stopsData = fs.existsSync(stopsCachePath) ? JSON.parse(fs.readFileSync(stopsCachePath, 'utf8')) : [];
      const calData = fs.existsSync(calendarPath) ? JSON.parse(fs.readFileSync(calendarPath, 'utf8')) : {};
      const calDatesData = fs.existsSync(calendarDatesPath) ? JSON.parse(fs.readFileSync(calendarDatesPath, 'utf8')) : {};

      this.routes = routesData;

      // Connect to SQLite shapes DB on demand
      if (fs.existsSync(this.shapesDbPath)) {
        try {
          this.shapesDb = new DatabaseSync(this.shapesDbPath);
          this.getShapeStmt = this.shapesDb.prepare('SELECT coords FROM shapes WHERE shape_id = ?');
        } catch (e) {
          console.warn('[CataloniaTracker] SQLite shapes init error:', e.message);
        }
      }

      // Load calendar maps
      Object.entries(calData).forEach(([sId, cal]) => {
        this.calendar.set(sId, cal);
      });

      Object.entries(calDatesData).forEach(([dStr, exc]) => {
        this.calendarExceptions.set(dStr, {
          active: new Set(exc.active || []),
          inactive: new Set(exc.inactive || [])
        });
      });

      routesData.forEach(r => {
        this.routesMap.set(r.id, r);
        this.routesMap.set(r.code.toLowerCase(), r);
        this.routesMap.set(r.routeId.toLowerCase(), r);
        this.routesMap.set(`cat_${r.code.toLowerCase()}`, r);
      });

      Object.entries(routeDetailsData).forEach(([rId, details]) => {
        this.routeDetailsMap.set(rId, details);
        this.routeDetailsMap.set(details.code.toLowerCase(), details);
        this.routeDetailsMap.set(details.routeId.toLowerCase(), details);
        this.routeDetailsMap.set(`cat_${details.code.toLowerCase()}`, details);
      });

      stopsData.forEach(s => {
        this.stopsMap.set(String(s.id), s);
        this.stopsMap.set(String(s.code), s);
      });

      // Index stops for global stop search
      routesData.forEach(r => {
        const details = this.routeDetailsMap.get(r.id);
        if (details && details.stopsByDirection) {
          Object.values(details.stopsByDirection).forEach(stops => {
            stops.forEach(s => {
              if (!this.allStopsMap.has(s.id)) {
                this.allStopsMap.set(s.id, {
                  ...s,
                  lineId: r.id,
                  lineCode: r.code,
                  lineColor: r.color,
                  agency: r.agency,
                  group: r.group
                });
              }
            });
          });
        }
      });

      this.isLoaded = true;
      console.log(`[CataloniaTracker] Loaded ${this.routes.length} Catalonia bus routes & ${this.stopsMap.size} stops in ${Date.now() - start}ms!`);
    } catch(err) {
      console.error('[CataloniaTracker] Failed to load caches, rebuilding index:', err.message);
      await indexer.buildIndex();
      return this.init();
    }
  }

  getLines() {
    return this.routes;
  }

  resolveLine(lineId) {
    const key = String(lineId).toLowerCase().replace('line-', '').replace('linia-', '');
    return this.routeDetailsMap.get(key) || this.routeDetailsMap.get(lineId) || this.routeDetailsMap.get(`cat_${key}`);
  }

  getDateComponents(dateObj = new Date()) {
    const d = (dateObj instanceof Date && !isNaN(dateObj.getTime()))
      ? dateObj
      : (typeof dateObj === 'string' ? new Date(dateObj) : new Date());

    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Madrid',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    const parts = formatter.formatToParts(d);
    let year = 2026, month = 8, day = 20, hour = 0, minute = 0;
    for (const p of parts) {
      if (p.type === 'year') year = parseInt(p.value, 10);
      if (p.type === 'month') month = parseInt(p.value, 10);
      if (p.type === 'day') day = parseInt(p.value, 10);
      if (p.type === 'hour') hour = parseInt(p.value, 10);
      if (p.type === 'minute') minute = parseInt(p.value, 10);
    }
    const utcDate = new Date(Date.UTC(year, month - 1, day));
    const dayOfWeek = utcDate.getUTCDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday
    const dateStr = `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
    const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

    return { year, month, day, hour, minute, dayOfWeek, dateStr, timeStr };
  }

  isServiceActiveOnDate(serviceId, dateObj = new Date()) {
    const { dateStr, dayOfWeek } = this.getDateComponents(dateObj);

    if (this.calendarExceptions.has(dateStr)) {
      const entry = this.calendarExceptions.get(dateStr);
      if (entry.active.has(serviceId)) return true;
      if (entry.inactive.has(serviceId)) return false;
    }

    const cal = this.calendar.get(serviceId);
    if (!cal) return false;

    if (dateStr < cal.startDate || dateStr > cal.endDate) return false;

    const dayKeys = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayKey = dayKeys[dayOfWeek];
    return !!cal[dayKey];
  }

  getScheduledDeparturesForDate(route, dirIdx, dateObj = new Date()) {
    const schedules = route.schedulesByDirection?.[dirIdx] || [];
    if (schedules.length === 0) return [];

    const { dateStr, timeStr, hour, minute } = this.getDateComponents(dateObj);
    const nowMinutes = hour * 60 + minute;

    // Filter trips active on this date
    const activeTrips = schedules.filter(trip => this.isServiceActiveOnDate(trip.serviceId, dateObj));

    return activeTrips.map(trip => {
      const [tH, tM] = trip.departureTime.split(':').map(Number);
      const tripMinutes = tH * 60 + tM;
      const minsAway = tripMinutes - nowMinutes;

      return {
        tripId: trip.tripId,
        serviceId: trip.serviceId,
        departureTime: trip.departureTime,
        minsAway,
        isPast: minsAway < -2,
        isToday: true
      };
    });
  }

  getShapeCoords(shapeId) {
    if (!shapeId || !this.getShapeStmt) return null;
    try {
      const row = this.getShapeStmt.get(shapeId);
      if (row?.coords) {
        return JSON.parse(row.coords);
      }
    } catch (e) {
      // ignore
    }
    return null;
  }

  async getLineDetails(lineId, direction = '0') {
    await this.init();
    const route = this.resolveLine(lineId);
    if (!route) throw new Error(`Catalonia Bus Line ${lineId} not found`);

    const stops0 = route.stopsByDirection?.['0'] || [];
    const stops1 = route.stopsByDirection?.['1'] || [];

    if (direction === 'both' && (stops0.length > 0 && stops1.length > 0)) {
      const details0 = await this.getLineDetails(lineId, '0');
      const details1 = await this.getLineDetails(lineId, '1');
      const shape0 = route.directions[0]?.shapeId;
      const shape1 = route.directions[1]?.shapeId;
      const coords0 = this.getShapeCoords(shape0) || details0.stops.map(s => [s.lat, s.lon]);
      const coords1 = this.getShapeCoords(shape1) || details1.stops.map(s => [s.lat, s.lon]);
      return {
        ...details0,
        direction: 'both',
        coords: coords0,
        polyline: coords0,
        secondaryStops: details1.stops,
        secondaryCoords: coords1,
        secondaryColor: '#38bdf8',
        allDirections: [
          { dirId: '0', name: route.directions[0]?.name || 'Sentit 1', stops: details0.stops, coords: coords0 },
          { dirId: '1', name: route.directions[1]?.name || 'Sentit 2', stops: details1.stops, coords: coords1 }
        ],
        activeBuses: [...(details0.activeBuses || []), ...(details1.activeBuses || [])],
        totalActiveBuses: (details0.activeBuses?.length || 0) + (details1.activeBuses?.length || 0)
      };
    }

    const dirIdx = String(direction === 'both' ? '0' : direction);
    let stops = route.stopsByDirection?.[dirIdx] || route.stopsByDirection?.['0'] || Object.values(route.stopsByDirection || {})[0] || [];
    if (stops.length === 0) {
      const parts = (route.name || route.code).split(/ - | ⇄ | ➔ | -/);
      const startName = parts[0]?.trim() || route.code;
      const endName = parts[1]?.trim() || parts[0]?.trim() || 'Destí';
      stops = [
        { id: `${route.id}_stop_1`, code: `${route.code}_1`, name: `${startName} (Origen)`, lat: 41.5365, lon: 2.4304, seq: 1, zone: 'Catalunya' },
        { id: `${route.id}_stop_2`, code: `${route.code}_2`, name: `${endName} (Destí)`, lat: 41.5543, lon: 2.4332, seq: 2, zone: 'Catalunya' }
      ];
    }
    const dirMeta = route.directions.find(d => String(d.dirId) === dirIdx) || route.directions[0] || { name: 'Cap a Destí' };
    const polylineCoords = this.getShapeCoords(dirMeta.shapeId) || stops.map(s => [s.lat, s.lon]);

    // Check scheduled service for today
    const now = new Date();
    const todaysTrips = this.getScheduledDeparturesForDate(route, dirIdx, now);
    const upcomingTrips = todaysTrips.filter(t => !t.isPast);

    let isOperating = todaysTrips.length > 0 && upcomingTrips.length > 0;
    let statusText = 'Sense servei programat avui';
    let nextOperatingDayText = 'Sense servei avui';

    if (todaysTrips.length > 0) {
      if (upcomingTrips.length > 0) {
        isOperating = true;
        statusText = `🟢 En servei segons horari (${upcomingTrips.length} sortides pendents avui)`;
        nextOperatingDayText = `Avui a les ${upcomingTrips[0].departureTime}`;
      } else {
        isOperating = false;
        statusText = 'Servei finalitzat per avui';
        nextOperatingDayText = 'Demà';
      }
    } else {
      // Find next active day in the upcoming week
      for (let dayOffset = 1; dayOffset <= 7; dayOffset++) {
        const nextDate = new Date(now.getTime() + dayOffset * 86400000);
        const nextTrips = this.getScheduledDeparturesForDate(route, dirIdx, nextDate);
        if (nextTrips.length > 0) {
          const daysOfWeek = ['Diumenge', 'Dilluns', 'Dimarts', 'Dimecres', 'Dijous', 'Divendres', 'Dissabte'];
          const dowName = daysOfWeek[nextDate.getDay()];
          nextOperatingDayText = `${dowName} a les ${nextTrips[0].departureTime}`;
          break;
        }
      }
    }

    // Checkpoints
    const stepInterval = Math.max(1, Math.floor(stops.length / 8));
    const checkpoints = stops.filter((s, i) => i === 0 || i === stops.length - 1 || i % stepInterval === 0).map(s => ({
      id: s.id,
      name: s.name,
      seq: s.seq,
      zone: s.zone,
      isPassed: false,
      hasBus: false,
      etaMinutes: 0
    }));

    return {
      id: route.id,
      code: route.code,
      name: route.name,
      color: route.color,
      agency: route.agency,
      group: route.group,
      mode: route.mode,
      operatorWebsite: route.operatorWebsite || null,
      operatorNotice: route.operatorNotice || null,
      direction: dirIdx,
      directions: route.directions,
      stops,
      coords: polylineCoords,
      polyline: polylineCoords,
      activeBuses: [], // No fake synthetic ghost buses!
      checkpoints,
      totalActiveBuses: 0,
      disruptions: [],
      totalDisruptions: 0,
      serviceStatus: {
        isOperating,
        statusText,
        nextOperatingDayText,
        totalTripsToday: todaysTrips.length,
        remainingTripsToday: upcomingTrips.length
      }
    };
  }

  async getStopDepartures(stopId, lineId, direction = '0') {
    await this.init();
    const route = this.resolveLine(lineId);
    if (!route) throw new Error(`Line ${lineId} not found`);

    const dirIdx = String(direction === 'both' ? '0' : direction);
    const stops = route.stopsByDirection?.[dirIdx] || route.stopsByDirection?.['0'] || [];
    const dirMeta = route.directions.find(d => String(d.dirId) === dirIdx) || route.directions[0] || { name: 'Cap a Destí' };

    const stopObj = stops.find(s => String(s.id) === String(stopId) || String(s.code) === String(stopId)) || this.stopsMap.get(String(stopId)) || {
      id: stopId,
      code: stopId,
      name: `Parada ${stopId}`,
      lat: 41.3851,
      lon: 2.1734
    };

    const targetStopId = stopObj.id || stopObj.mouteStopId || stopObj.code;
    const departures = [];

    // 1. Try real-time Mou-te API
    try {
      const depRes = await mouteClient.getNextDepartures(targetStopId, true);
      const rawList = Array.isArray(depRes?.sortides?.sortida) ? depRes.sortides.sortida : (depRes?.sortides?.sortida ? [depRes.sortides.sortida] : []);
      const routeCodeUpper = String(route.code).toUpperCase();

      rawList.forEach(item => {
        const itemLine = String(item.linia || item.nomLinia || '').toUpperCase();
        if (itemLine.includes(routeCodeUpper) || routeCodeUpper.includes(itemLine)) {
          const arrMins = parseInt(item.tempsMinuts || item.minuts || '0', 10);
          const timeStr = item.horaReal || item.horaTeorica || '--:--';
          departures.push({
            lineId: route.id,
            lineCode: route.code,
            lineName: route.code,
            destination: item.destinacio || dirMeta.name,
            departureTime: timeStr,
            minutesAway: arrMins,
            etaFormatted: arrMins <= 1 ? 'Imminent' : `${arrMins} min`,
            formattedStatus: arrMins <= 1 ? 'Imminent' : `${arrMins} min`,
            isRealTime: !!item.esTempsReal,
            isEstimated: !item.esTempsReal,
            delayMins: parseInt(item.retard || '0', 10),
            delayStatus: item.retard ? 'delayed' : 'ontime',
            delayBadgeText: item.retard ? `+${item.retard} min retard` : 'Puntual'
          });
        }
      });
    } catch(e) {
      console.warn(`[CataloniaTracker] getStopDepartures Mou-te fetch failed:`, e.message);
    }

    // 2. If no real-time departures, load authoritative GTFS timetable
    if (departures.length === 0) {
      const now = new Date();
      const scheduledTrips = this.getScheduledDeparturesForDate(route, dirIdx, now);
      const upcoming = scheduledTrips.filter(t => !t.isPast);

      upcoming.slice(0, 10).forEach(t => {
        departures.push({
          lineId: route.id,
          lineCode: route.code,
          lineName: route.code,
          destination: dirMeta.name,
          departureTime: t.departureTime,
          minutesAway: t.minsAway,
          etaFormatted: t.minsAway <= 1 ? 'Imminent' : (t.minsAway < 60 ? `${t.minsAway} min` : t.departureTime),
          formattedStatus: t.minsAway <= 1 ? 'Imminent' : (t.minsAway < 60 ? `${t.minsAway} min` : t.departureTime),
          isRealTime: false,
          isEstimated: false,
          isToday: true,
          delayMins: 0,
          delayStatus: 'scheduled',
          delayBadgeText: 'Horari teòric'
        });
      });

      // If no trips remain today (e.g. at night), load tomorrow's schedule (or next active day)
      if (departures.length === 0) {
        for (let dayOffset = 1; dayOffset <= 7; dayOffset++) {
          const nextDate = new Date(now.getTime() + dayOffset * 86400000);
          const nextTrips = this.getScheduledDeparturesForDate(route, dirIdx, nextDate);
          if (nextTrips.length > 0) {
            const isTomorrow = dayOffset === 1;
            const daysOfWeek = ['Dg.', 'Dl.', 'Dt.', 'Dc.', 'Dj.', 'Dv.', 'Ds.'];
            const dowName = daysOfWeek[nextDate.getDay()];
            const prefix = isTomorrow ? 'Demà' : dowName;

            nextTrips.slice(0, 10).forEach((t, idx) => {
              departures.push({
                lineId: route.id,
                lineCode: route.code,
                lineName: route.code,
                destination: dirMeta.name,
                departureTime: t.departureTime,
                minutesAway: null,
                etaFormatted: idx === 0 ? `🌅 ${t.departureTime}` : t.departureTime,
                formattedStatus: `${prefix} ${t.departureTime}`,
                isRealTime: false,
                isEstimated: false,
                isToday: false,
                isFirstOfDay: idx === 0,
                delayMins: 0,
                delayStatus: 'scheduled',
                delayBadgeText: idx === 0 ? (isTomorrow ? '1r pas previst demà' : `1r pas ${dowName}`) : 'Programat'
              });
            });
            break;
          }
        }
      }
    }

    return {
      stop: {
        id: stopObj.id,
        code: stopObj.code,
        name: stopObj.name,
        lat: stopObj.lat,
        lon: stopObj.lon,
        seq: stopObj.seq || 1,
        zone: stopObj.zone || 'Catalunya'
      },
      lineId: route.id,
      lineCode: route.code,
      direction: dirIdx,
      departures: departures.slice(0, 10),
      totalDepartures: departures.length,
      operatorWebsite: route.operatorWebsite || null,
      operatorNotice: route.operatorNotice || null
    };
  }

  async getTargetStopETA(lineId, stopId = null, direction = '0') {
    return this.getTargetStopEta(lineId, direction, stopId);
  }

  async getTargetStopEta(lineId, direction = '0', stopId = null) {
    await this.init();
    const route = this.resolveLine(lineId);
    if (!route) throw new Error(`Catalonia Bus Line ${lineId} not found`);

    const dirIdx = String(direction === 'both' ? '0' : direction);
    let stops = route.stopsByDirection?.[dirIdx] || route.stopsByDirection?.['0'] || Object.values(route.stopsByDirection || {})[0] || [];
    if (stops.length === 0) {
      const parts = (route.name || route.code).split(/ - | ⇄ | ➔ | -/);
      const startName = parts[0]?.trim() || route.code;
      const endName = parts[1]?.trim() || parts[0]?.trim() || 'Destí';
      stops = [
        { id: `${route.id}_stop_1`, code: `${route.code}_1`, name: `${startName} (Origen)`, lat: 41.5365, lon: 2.4304, seq: 1, zone: 'Catalunya' },
        { id: `${route.id}_stop_2`, code: `${route.code}_2`, name: `${endName} (Destí)`, lat: 41.5543, lon: 2.4332, seq: 2, zone: 'Catalunya' }
      ];
    }
    const dirMeta = route.directions.find(d => String(d.dirId) === dirIdx) || route.directions[0] || { name: 'Cap a Destí' };

    const targetStop = (stopId ? stops.find(s => String(s.id) === String(stopId) || String(s.code) === String(stopId)) : null) || stops[0] || {
      id: 'default',
      code: '0000',
      name: 'Parada Destí',
      lat: 41.3851,
      lon: 2.1734
    };

    const targetStopId = targetStop.id || targetStop.mouteStopId || targetStop.code;

    // 1. Fetch live departures from Mou-te for this stop
    let liveArrivals = [];
    try {
      const depRes = await mouteClient.getNextDepartures(targetStopId, true);
      const rawList = Array.isArray(depRes?.sortides?.sortida) ? depRes.sortides.sortida : (depRes?.sortides?.sortida ? [depRes.sortides.sortida] : []);
      const routeCodeUpper = String(route.code).toUpperCase();

      rawList.forEach(item => {
        const itemLine = String(item.linia || item.nomLinia || '').toUpperCase();
        if (itemLine.includes(routeCodeUpper) || routeCodeUpper.includes(itemLine)) {
          const arrMins = parseInt(item.tempsMinuts || item.minuts || '0', 10);
          liveArrivals.push({
            time: item.horaTeorica || item.horaReal || '--:--',
            timeFormatted: item.horaReal || item.horaTeorica || '--:--',
            minsAway: arrMins,
            etaFormatted: arrMins <= 1 ? 'Imminent' : `${arrMins} min`,
            destination: item.destinacio || dirMeta.name,
            isRealTime: !!item.esTempsReal,
            isToday: true,
            delayText: item.retard ? `+${item.retard} min retard` : 'Puntual',
            delayMins: parseInt(item.retard || '0', 10),
            delayBadgeClass: 'ontime'
          });
        }
      });

      const dedupedArrivals = [];
      const seenTimes = new Set();
      liveArrivals.forEach(arr => {
        const key = `${arr.time}_${arr.destination}`;
        if (!seenTimes.has(key)) {
          seenTimes.add(key);
          dedupedArrivals.push(arr);
        }
      });
      liveArrivals = dedupedArrivals;
    } catch(e) {
      console.warn(`[CataloniaTracker] Mou-te live departure fetch for stop ${targetStopId} failed:`, e.message);
    }

    // 2. If no real-time arrivals found, load authoritative GTFS timetable
    if (liveArrivals.length === 0) {
      const now = new Date();
      const scheduledTrips = this.getScheduledDeparturesForDate(route, dirIdx, now);
      const upcoming = scheduledTrips.filter(t => !t.isPast);

      upcoming.forEach(t => {
        liveArrivals.push({
          time: t.departureTime,
          timeFormatted: t.departureTime,
          minsAway: t.minsAway,
          etaFormatted: t.minsAway <= 1 ? 'Imminent' : (t.minsAway < 60 ? `${t.minsAway} min` : t.departureTime),
          destination: dirMeta.name,
          isRealTime: false,
          isToday: true,
          delayText: 'Horari teòric',
          delayMins: 0,
          delayBadgeClass: 'scheduled'
        });
      });

      // If no trips remain today (e.g. at night), load tomorrow's schedule (or next active day)
      if (liveArrivals.length === 0) {
        for (let dayOffset = 1; dayOffset <= 7; dayOffset++) {
          const nextDate = new Date(now.getTime() + dayOffset * 86400000);
          const nextTrips = this.getScheduledDeparturesForDate(route, dirIdx, nextDate);
          if (nextTrips.length > 0) {
            const isTomorrow = dayOffset === 1;
            const daysOfWeek = ['Dg.', 'Dl.', 'Dt.', 'Dc.', 'Dj.', 'Dv.', 'Ds.'];
            const dowName = daysOfWeek[nextDate.getDay()];
            const prefix = isTomorrow ? 'Demà' : dowName;

            nextTrips.forEach((t, idx) => {
              liveArrivals.push({
                time: t.departureTime,
                timeFormatted: `${prefix} a les ${t.departureTime}`,
                minsAway: null,
                etaFormatted: idx === 0 ? `🌅 ${t.departureTime}` : t.departureTime,
                destination: dirMeta.name,
                isRealTime: false,
                isToday: false,
                isFirstOfDay: idx === 0,
                delayText: idx === 0 ? (isTomorrow ? '1r pas previst demà' : `1r pas ${dowName}`) : 'Programat',
                delayMins: 0,
                delayBadgeClass: 'scheduled'
              });
            });
            break;
          }
        }
      }
    }

    const hasService = liveArrivals.length > 0;
    const primaryArrival = hasService ? liveArrivals[0] : null;

    const nextBus = primaryArrival ? {
      lineId: route.id,
      lineCode: route.code,
      lineName: route.code,
      destination: primaryArrival.destination || dirMeta.name,
      departureTime: primaryArrival.time,
      minutesAway: primaryArrival.minsAway,
      formattedStatus: primaryArrival.timeFormatted || primaryArrival.etaFormatted || `${primaryArrival.minsAway} min`,
      isRealtime: primaryArrival.isRealTime,
      isToday: primaryArrival.isToday !== false,
      isFirstOfDay: !!primaryArrival.isFirstOfDay,
      delayMinutes: primaryArrival.delayMins || 0,
      delayStatus: primaryArrival.isRealTime ? (primaryArrival.delayMins > 0 ? 'delayed' : 'ontime') : 'scheduled',
      delayBadgeText: primaryArrival.isRealTime ? (primaryArrival.delayMins > 0 ? `+${primaryArrival.delayMins} min retard` : 'Temps real') : (primaryArrival.isToday === false ? '🌅 1r Servei del matí' : 'Horari teòric')
    } : {
      lineId: route.id,
      lineCode: route.code,
      lineName: route.code,
      destination: dirMeta.name,
      departureTime: '--:--',
      minutesAway: null,
      formattedStatus: 'Sense servei programat',
      isRealtime: false,
      isToday: false,
      delayMinutes: 0,
      delayStatus: 'scheduled',
      delayBadgeText: 'Sense servei'
    };

    const upcomingDepartures = liveArrivals.map(arr => ({
      lineId: route.id,
      lineCode: route.code,
      lineName: route.code,
      destination: arr.destination || dirMeta.name,
      departureTime: arr.time,
      timeFormatted: arr.timeFormatted || arr.time,
      minutesAway: arr.minsAway,
      formattedStatus: arr.timeFormatted || arr.etaFormatted || (arr.minsAway !== null ? `${arr.minsAway} min` : arr.time),
      isRealtime: arr.isRealTime,
      isToday: arr.isToday !== false,
      isFirstOfDay: !!arr.isFirstOfDay,
      delayMinutes: arr.delayMins || 0,
      delayStatus: arr.isRealTime ? (arr.delayMins > 0 ? 'delayed' : 'ontime') : 'scheduled',
      delayBadgeText: arr.isRealTime ? 'Temps real' : (arr.isToday === false ? 'Programat' : 'Horari teòric')
    }));

    return {
      lineId: route.id,
      lineCode: route.code,
      lineName: route.name,
      lineColor: route.color,
      agency: route.agency,
      group: route.group,
      operatorWebsite: route.operatorWebsite || null,
      operatorNotice: route.operatorNotice || null,
      targetStop: {
        id: targetStop.id,
        code: targetStop.code,
        name: targetStop.name,
        lat: targetStop.lat,
        lon: targetStop.lon,
        seq: targetStop.seq || 1,
        zone: targetStop.zone || 'Catalunya'
      },
      nextBus,
      upcomingDepartures,
      eta: primaryArrival ? {
        minutes: primaryArrival.minsAway,
        formatted: primaryArrival.isToday === false ? `🌅 ${primaryArrival.time}` : primaryArrival.etaFormatted,
        time: primaryArrival.timeFormatted,
        isImminent: primaryArrival.minsAway !== null && primaryArrival.minsAway <= 2,
        isRealTime: primaryArrival.isRealTime,
        statusText: primaryArrival.isRealTime ? '🟢 Temps Real (Mou-te)' : (primaryArrival.isToday === false ? '⏱️ Represa al matí (Horari oficial)' : '⏱️ Horari Teòric')
      } : {
        minutes: null,
        formatted: 'Sense servei',
        time: '--:--',
        isImminent: false,
        isRealTime: false,
        statusText: '⏱️ Sense sortides programades'
      },
      closestBus: null,
      departures: liveArrivals.slice(0, 8),
      totalDepartures: liveArrivals.length
    };
  }
}

module.exports = new CataloniaTracker();

const fs = require('fs');
const path = require('path');
const mouteClient = require('./mouteClient');
const geoUtils = require('./geoUtils');
const timeUtils = require('./timeUtils');

function timeToSec(timeStr) {
  return timeUtils.timeToSec(timeStr);
}

function secToTime(totalSec) {
  return timeUtils.secToTime(totalSec);
}

function formatDateToYYYYMMDD(date, tz = 'Europe/Madrid') {
  return timeUtils.getNetworkTime(tz, date).dateStr;
}

function timeToMin(timeStr) {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

class CorridorTracker {
  constructor() {
    this.agencyTimezone = 'Europe/Madrid';
    this.dataDir = path.join(__dirname, '..', 'data');
    this.calendarExceptions = new Map();
    this.calendarWeekly = [];
    this.loadData();

    // Target stop definitions
    this.targetStop = {
      name: "Plaça d'Itàlia (Mataró)",
      googleMapsUrl: "https://maps.app.goo.gl/ScnubXtht3oSKDCk6",
      coords: { lat: 41.5468674, lon: 2.4321194 },
      dir1: {
        mouteStopId: '10037202',
        gtfsStopId: 'GEN_PF08121075',
        code: '121',
        name: "pl. Itàlia (A)",
        seq: 39,
        directionName: "Cap a Mataró (Hospital de Mataró)"
      },
      dir0: {
        mouteStopId: '10037202',
        gtfsStopId: 'GEN_PF08121041',
        code: '8371',
        name: "pl. Itàlia (D)",
        seq: 3,
        directionName: "Cap a Barcelona (Metro la Pau)"
      }
    };

    // Checkpoint stops along the corridor with accurate GTFS stop IDs
    this.checkpointsDir1 = [
      { id: '10008500', name: 'Barcelona - Metro la Pau', zone: 'AMB', seq: 0, gtfsStopId: 'GEN_PF08019096' },
      { id: '10025777', name: 'Badalona - Pompeu Fabra', zone: 'AMB', seq: 7, gtfsStopId: 'GEN_PF08015014' },
      { id: '10027798', name: 'Montgat - Estació Rodalies', zone: 'AMB (Boundary)', seq: 12, gtfsStopId: 'GEN_PF08126015' },
      { id: '10038038', name: 'El Masnou - Estació', zone: 'Maresme', seq: 17, gtfsStopId: 'GEN_PF08118027' },
      { id: '10038471', name: 'Premià de Mar - Estació', zone: 'Maresme', seq: 21, gtfsStopId: 'GEN_PF08172022' },
      { id: '10037286', name: 'Vilassar de Mar - Estació', zone: 'Maresme', seq: 26, gtfsStopId: 'GEN_PF08219011' },
      { id: '10037205', name: 'Mataró - Porta Laietana', zone: 'Maresme', seq: 34, gtfsStopId: 'GEN_PF08121080' },
      { id: '10026784', name: 'Mataró - Pl. Granollers', zone: 'Maresme', seq: 37, gtfsStopId: 'GEN_PF08121077' },
      { id: '10037202', name: "Mataró - Pl. d'Itàlia", zone: 'Maresme', seq: 39, gtfsStopId: 'GEN_PF08121075' }
    ];

    this.checkpointsDir0 = [
      { id: '10037202', name: "Mataró - Pl. d'Itàlia", zone: 'Maresme', seq: 3, gtfsStopId: 'GEN_PF08121041' },
      { id: '10026784', name: 'Mataró - Pl. Granollers', zone: 'Maresme', seq: 5, gtfsStopId: 'GEN_PF08121044' },
      { id: '10037205', name: 'Mataró - Porta Laietana', zone: 'Maresme', seq: 8, gtfsStopId: 'GEN_PF08121024' },
      { id: '10037286', name: 'Vilassar de Mar - Estació', zone: 'Maresme', seq: 21, gtfsStopId: 'GEN_PF08172018' },
      { id: '10038471', name: 'Premià de Mar - Estació', zone: 'Maresme', seq: 21, gtfsStopId: 'GEN_PF08172018' },
      { id: '10038038', name: 'El Masnou - Estació', zone: 'Maresme', seq: 26, gtfsStopId: 'GEN_PF08118041' },
      { id: '10027798', name: 'Montgat - Estació Rodalies', zone: 'AMB (Boundary)', seq: 32, gtfsStopId: 'GEN_PF08126007' },
      { id: '10025777', name: 'Badalona - Pompeu Fabra', zone: 'AMB', seq: 37, gtfsStopId: 'GEN_PF08015025' },
      { id: '10008500', name: 'Barcelona - Metro la Pau', zone: 'AMB', seq: 44, gtfsStopId: 'GEN_PF08019096' }
    ];
  }

  loadData() {
    try {
      const atmDir = path.join(this.dataDir, 'atm_gtfs');
      if (fs.existsSync(atmDir)) {
        const stopsPath = path.join(atmDir, 'stops.txt');
        const tripsPath = path.join(atmDir, 'trips.txt');
        const stopTimesPath = path.join(atmDir, 'stop_times.txt');

        if (fs.existsSync(stopsPath) && fs.existsSync(tripsPath) && fs.existsSync(stopTimesPath)) {
          const stopsMap = new Map();
          fs.readFileSync(stopsPath, 'utf8').split('\n').slice(1).filter(Boolean).forEach(l => {
            const p = l.split(',');
            const sId = p[0];
            const mId = sId.replace('GEN_PF', '').replace(/^0+/, '');
            stopsMap.set(sId, {
              gtfsStopId: sId,
              mouteStopId: mId,
              name: (p[2] || '').replace(/"/g, '').replace(/ - \d+$/, ''),
              lat: parseFloat(p[4]),
              lon: parseFloat(p[5]),
              city: 'Maresme'
            });
          });

          const trips = fs.readFileSync(tripsPath, 'utf8').split('\n').slice(1).filter(l => l.startsWith('GEN_0498,'));
          const stopTimes = fs.readFileSync(stopTimesPath, 'utf8').split('\n').slice(1).filter(Boolean);

          const getStopsForTrip = (tripId) => {
            return stopTimes
              .filter(l => l.startsWith(tripId + ','))
              .map(l => {
                const p = l.split(',');
                const sObj = stopsMap.get(p[3]);
                return {
                  ...sObj,
                  seq: parseInt(p[4], 10),
                  arr: p[1],
                  dep: p[2]
                };
              })
              .sort((a, b) => a.seq - b.seq);
          };

          const trip0 = trips.find(t => t.split(',')[4] === '0') || trips[0];
          const trip1 = trips.find(t => t.split(',')[4] === '1') || trips[0];

          if (trip1) this.stopsDir1 = getStopsForTrip(trip1.split(',')[1]);
          if (trip0) this.stopsDir0 = getStopsForTrip(trip0.split(',')[1]);

          // Build full schedule from trips
          const schedDir1 = [];
          const schedDir0 = [];
          trips.forEach(t => {
            const p = t.split(',');
            const tId = p[1];
            const dir = p[4] || '0';
            const sId = p[9] || '';
            const tTimes = stopTimes.filter(l => l.startsWith(tId + ',')).map(l => l.split(',')).sort((a,b) => parseInt(a[4],10) - parseInt(b[4],10));
            if (tTimes.length > 0) {
              const depTime = tTimes[0][2];
              const arrTime = tTimes[tTimes.length - 1][1];
              const entry = {
                tripId: tId,
                serviceId: sId,
                departureTime: depTime.substring(0, 5),
                arrivalTime: arrTime.substring(0, 5),
                stops: tTimes.map(st => ({ gtfsStopId: st[3], departureTime: st[2].substring(0, 5) }))
              };
              if (dir === '1') schedDir1.push(entry);
              else schedDir0.push(entry);
            }
          });

          this.fullSchedule = { dir1: schedDir1, dir0: schedDir0 };
          this.stopsMapDir1 = new Map();
          this.stopsDir1.forEach(s => this.stopsMapDir1.set(s.gtfsStopId, s));
          this.stopsMapDir0 = new Map();
          this.stopsDir0.forEach(s => this.stopsMapDir0.set(s.gtfsStopId, s));

          this.loadCalendarSync();
          console.log(`[CorridorTracker] Dynamically loaded C-10 (${this.stopsDir1.length} stops dir 1, ${this.stopsDir0.length} stops dir 0) from ATM GTFS!`);
          return;
        }
      }
    } catch (e) {
      console.error('[CorridorTracker] Error loading dynamic GTFS:', e.message);
    }
  }

  loadCalendarSync() {
    const atmDir = path.join(this.dataDir, 'atm_gtfs');
    if (!fs.existsSync(atmDir)) return;

    const c10Services = new Set(['GEN_184910', 'GEN_185080', 'GEN_184749', 'GEN_185017']);

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

  isServiceActiveOnDate(serviceId, dateObj) {
    const dateStr = formatDateToYYYYMMDD(dateObj);

    if (this.calendarExceptions.has(dateStr)) {
      const entry = this.calendarExceptions.get(dateStr);
      if (entry.active.has(serviceId)) return true;
      if (entry.inactive.has(serviceId)) return false;
    }

    const mmdd = dateStr.substring(4, 8);
    const dayOfWeek = dateObj.getDay();
    const isSunday = dayOfWeek === 0;
    const isSaturday = dayOfWeek === 6;
    const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
    const isAugust = dateObj.getMonth() === 7;

    // 1. Regular all-year Sundays & holidays
    if (serviceId === 'GEN_184749') {
      return isSunday;
    }

    // 2. Summer Sundays & holidays (Green departures between 15/06 and 15/09)
    if (serviceId === 'GEN_185017') {
      const isSummerSeason = mmdd >= '0615' && mmdd <= '0915';
      return isSunday && isSummerSeason;
    }

    // 3. Saturdays and August weekdays ("Dissabtes i feiners d'agost")
    if (serviceId === 'GEN_185080') {
      return isSaturday || (isWeekday && isAugust);
    }

    // 4. Regular weekdays (non-August) ("Feiners de dilluns a divendres")
    if (serviceId === 'GEN_184910') {
      return isWeekday && !isAugust;
    }

    const weekly = this.calendarWeekly.find(w => w.serviceId === serviceId);
    if (weekly) {
      if (dateStr >= weekly.startDate && dateStr <= weekly.endDate) {
        const dayKeys = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        return weekly[dayKeys[dayOfWeek]] === true;
      }
    }

    return false;
  }

  getStops(direction = '1') {
    return direction === '0' ? this.stopsDir0 : this.stopsDir1;
  }

  computeScheduledMatch(liveTimeStr, isRealtime, stopGtfsId, direction, stopMouteId = null, stopSeq = null) {
    const isDir1 = direction === '1';
    const scheduleTrips = isDir1 ? this.fullSchedule.dir1 : this.fullSchedule.dir0;
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
          if (diff < minDiff && diff <= 55) {
            minDiff = diff;
            bestTrip = trip;
            scheduledTime = schedStr;
          }
        }
      }
    }

    const schedMin = timeToMin(scheduledTime);
    const delayMinutes = isRealtime ? liveMin - schedMin : 0;

    let delayStatus = 'scheduled';
    let delayBadgeText = 'Programat';

    if (isRealtime) {
      if (delayMinutes >= 2) {
        delayStatus = 'delayed';
        delayBadgeText = `+${delayMinutes} min retard`;
      } else if (delayMinutes <= -2) {
        delayStatus = 'early';
        delayBadgeText = `${Math.abs(delayMinutes)} min avançat`;
      } else {
        delayStatus = 'on_time';
        delayBadgeText = "A l'hora (Puntual)";
      }
    }

    return {
      scheduledTime,
      realtimeTime: liveTimeStr,
      delayMinutes,
      delayStatus,
      delayBadgeText,
      comparisonText: isRealtime
        ? `Teòric: ${scheduledTime} (${delayBadgeText})`
        : `Horari teòric: ${scheduledTime}`
    };
  }

  parseDepartures(data, stopGtfsId = null, direction = '1', stopMouteId = null, stopSeq = null) {
    const isDir1 = direction === '1';
    const scheduleTrips = isDir1 ? this.fullSchedule.dir1 : this.fullSchedule.dir0;
    const stopsList = isDir1 ? this.stopsDir1 : this.stopsDir0;
    const now = new Date();
    const networkNow = timeUtils.getNetworkTime(this.agencyTimezone, now);
    const currentSec = networkNow.currentSec;
    const todaysTrips = scheduleTrips.filter(trip => this.isServiceActiveOnDate(trip.serviceId, now));

    const sortides = data && data.sortides && data.sortides.sortida
      ? (Array.isArray(data.sortides.sortida) ? data.sortides.sortida : [data.sortides.sortida])
      : [];

    const results = [];
    const seenTodayTripKeys = new Set();

    for (const s of sortides) {
      const isC10 = s.liniaId === '02498' || s.liniaId === 'C10' || (s.descripcioLinia && s.descripcioLinia.includes('C10'));
      if (!isC10 && s.liniaId !== undefined) {
        if (s.liniaId !== '02498') continue;
      }

      const year = parseInt(s.any) || networkNow.year;
      const month = (parseInt(s.mes) - 1) || networkNow.month;
      const day = parseInt(s.dia) || networkNow.day;
      const hour = parseInt(s.hora) || 0;
      const minute = parseInt(s.minuts) || 0;

      const depUtcDate = timeUtils.localTimeToUtcDate(year, month, day, hour, minute, 0, this.agencyTimezone);
      const diffMs = depUtcDate.getTime() - now.getTime();
      const diffMinutes = Math.round(diffMs / 60000);
      const isToday = (year === networkNow.year && month === networkNow.month && day === networkNow.day);

      const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
      const isRealtime = Boolean(s.realtime);

      const delayInfo = this.computeScheduledMatch(timeStr, isRealtime, stopGtfsId, direction, stopMouteId, stopSeq);
      
      if (isToday) {
        seenTodayTripKeys.add(`${delayInfo.scheduledTime}_${s.direccioId || ''}`);
        seenTodayTripKeys.add(`${delayInfo.scheduledTime}`);
      }

      const depIso = depUtcDate.toISOString();

      results.push({
        lineId: s.liniaId || '02498',
        lineName: 'C-10',
        tripId: s.tripId,
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
    const stopsMap = isDir1 ? this.stopsMapDir1 : this.stopsMapDir0;
    const stopsListCurrent = isDir1 ? this.stopsDir1 : this.stopsDir0;
    const oppositeScheduleTrips = isDir1 ? this.fullSchedule.dir0 : this.fullSchedule.dir1;
    const oppositeTrips = oppositeScheduleTrips.filter(t => this.isServiceActiveOnDate(t.serviceId, now));

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

    const hasToday = results.some(r => r.isToday);
    if (!hasToday && results.length > 0) {
      results[0].isFirstOfDay = true;
      results[0].isNextService = true;
      results[0].delayBadgeText = '🌅 1r Servei del matí';
      results[0].comparisonText = `📅 Pas teòric previst demà a les ${results[0].departureTime}`;
    }

    return results;
  }

  async getTargetStopETA(direction = '1', customStopId = null) {
    const isDir1 = direction === '1';
    const defaultStopConfig = isDir1 ? this.targetStop.dir1 : this.targetStop.dir0;
    const stopsList = isDir1 ? this.stopsDir1 : this.stopsDir0;

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
      const scheduleTrips = isDir1 ? this.fullSchedule.dir1 : this.fullSchedule.dir0;
      const now = new Date();
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

          if (diffMin >= -5 && diffMin <= 120) {
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
      const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
      const networkTomorrow = timeUtils.getNetworkTime(this.agencyTimezone, tomorrow);
      const scheduleTrips = isDir1 ? this.fullSchedule.dir1 : this.fullSchedule.dir0;
      const tomorrowsTrips = scheduleTrips.filter(trip => this.isServiceActiveOnDate(trip.serviceId, tomorrow));
      tomorrowsTrips.sort((a, b) => timeToSec(a.stops[0].dep) - timeToSec(b.stops[0].dep));

      if (tomorrowsTrips.length > 0) {
        tomorrowsTrips.forEach((trip, tIdx) => {
          const stopEntry = trip.stops.find(s => s.stopId === gtfsStopId || s.seq === stopSeq) || trip.stops[0];
          if (stopEntry) {
            const timeStr = (stopEntry.dep || stopEntry.arr || '').substring(0, 5);
            const [h, m] = timeStr.split(':').map(Number);
            const depUtcDate = timeUtils.localTimeToUtcDate(networkTomorrow.year, networkTomorrow.month, networkTomorrow.day, h, m, 0, this.agencyTimezone);
            const diffMs = depUtcDate.getTime() - Date.now();
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
      upcomingDepartures: departuresToUse.slice(0, 8),
      allDepartures: departuresToUse,
      serviceStatus: {
        isOperating: departuresToUse.some(d => d.isToday && (d.isRealtime || d.minutesAway <= 120)),
        period: (new Date().getHours() >= 22 || new Date().getHours() < 6) ? 'night' : 'day',
        firstServiceTomorrow: firstTimeTomorrow,
        statusText: departuresToUse.some(d => d.isToday && (d.isRealtime || d.minutesAway <= 120))
          ? 'Servei en funcionament'
          : `Servei fora d'horari • Represa demà a les ${firstTimeTomorrow}`
      },
      lastUpdated: new Date().toISOString()
    };
  }

  async getStopDepartures(stopId, direction = '1') {
    const isDir1 = direction === '1';
    const stopsList = direction === '0' ? this.stopsDir0 : this.stopsDir1;
    const stopObj = stopsList.find(s => s.mouteStopId === stopId) || {};
    const gtfsStopId = stopObj.gtfsStopId || null;
    const seq = stopObj.seq !== undefined ? stopObj.seq : null;

    let departures = [];
    try {
      const data = await mouteClient.getNextDepartures(stopId, true, 'ca_ES');
      departures = this.parseDepartures(data, gtfsStopId, direction, stopId, seq);
    } catch (err) {
      console.warn(`[CorridorTracker] Mou-te API transient issue for stop ${stopId} (${err.message}). Using GTFS schedule fallback.`);
      departures = this.parseDepartures(null, gtfsStopId, direction, stopId, seq);
    }

    if (departures.length === 0) {
      const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
      const networkTomorrow = timeUtils.getNetworkTime(this.agencyTimezone, tomorrow);
      const scheduleTrips = isDir1 ? this.fullSchedule.dir1 : this.fullSchedule.dir0;
      const tomorrowsTrips = scheduleTrips.filter(trip => this.isServiceActiveOnDate(trip.serviceId, tomorrow));
      tomorrowsTrips.sort((a, b) => timeToSec(a.stops[0].dep) - timeToSec(b.stops[0].dep));

      if (tomorrowsTrips.length > 0) {
        tomorrowsTrips.forEach((trip, tIdx) => {
          const stopEntry = trip.stops.find(s => s.stopId === gtfsStopId || s.seq === seq) || trip.stops[0];
          if (stopEntry) {
            const timeStr = (stopEntry.dep || stopEntry.arr || '').substring(0, 5);
            const [h, m] = timeStr.split(':').map(Number);
            const depUtcDate = timeUtils.localTimeToUtcDate(networkTomorrow.year, networkTomorrow.month, networkTomorrow.day, h, m, 0, this.agencyTimezone);
            const diffMs = depUtcDate.getTime() - Date.now();
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

    return {
      stopId: stopId,
      stopName: stopObj.name || '',
      departures: departures,
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
          const lat = stop1Data.lat + progress * (stop2Data.lat - stop1Data.lat);
          const lon = stop1Data.lon + progress * (stop2Data.lon - stop1Data.lon);

          const bearing = geoUtils.calculateBearing(stop1Data.lat, stop1Data.lon, stop2Data.lat, stop2Data.lon);
          const compass = geoUtils.bearingToCompassName(bearing);
          const distToNext = Math.round(geoUtils.calculateDistanceMeters(lat, lon, stop2Data.lat, stop2Data.lon));
          const segDist = Math.round(geoUtils.calculateDistanceMeters(stop1Data.lat, stop1Data.lon, stop2Data.lat, stop2Data.lon));
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
            allStops: allStopsFormatted
          };
        }
      }
    }

    return null;
  }

  async getCorridorLiveTracking(direction = '1') {
    const isDir1 = direction === '1';
    const checkpoints = isDir1 ? this.checkpointsDir1 : this.checkpointsDir0;
    const scheduleTrips = isDir1 ? this.fullSchedule.dir1 : this.fullSchedule.dir0;
    const stopsMap = isDir1 ? this.stopsMapDir1 : this.stopsMapDir0;
    const stopsList = isDir1 ? this.stopsDir1 : this.stopsDir0;

    const now = new Date();
    const networkNow = timeUtils.getNetworkTime(this.agencyTimezone, now);
    const currentSec = networkNow.currentSec;

    const todaysTrips = scheduleTrips.filter(trip => this.isServiceActiveOnDate(trip.serviceId, now));
    todaysTrips.sort((a, b) => timeToSec(a.stops[0].dep) - timeToSec(b.stops[0].dep));

    const oppositeScheduleTrips = isDir1 ? this.fullSchedule.dir0 : this.fullSchedule.dir1;
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

    const promises = checkpoints.map(async cp => {
      try {
        const data = await mouteClient.getNextDepartures(cp.id, true, 'ca_ES');
        const deps = this.parseDepartures(data, cp.gtfsStopId, direction, cp.id, cp.seq);

        let next = null;

        if (primaryBus && targetTripToTrack) {
          // If an active bus is traveling:
          const stopEntry = targetTripToTrack.stops.find(s => s.stopId === cp.gtfsStopId || s.seq === cp.seq);
          const stopSchedTime = stopEntry ? (stopEntry.dep || stopEntry.arr || '').substring(0, 5) : null;

          if (cp.seq <= primaryBus.fromSeq) {
            // 1. Upstream checkpoint already passed by the active bus
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
          } else {
            // 2. Downstream checkpoint upcoming for this active bus
            const matchedDep = deps.find(d => d.tripId === targetTripToTrack.tripId || d.scheduledTime === stopSchedTime);
            if (matchedDep) {
              next = matchedDep;
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
          }
        } else if (targetTripToTrack) {
          // No bus currently active on corridor: track next scheduled trip consistently
          const stopEntry = targetTripToTrack.stops.find(s => s.stopId === cp.gtfsStopId || s.seq === cp.seq);
          if (stopEntry) {
            const timeStr = (stopEntry.dep || stopEntry.arr || '').substring(0, 5);
            const [h, m] = timeStr.split(':').map(Number);
            const schedSec = h * 3600 + m * 60;
            const diffSec = schedSec - currentSec;
            const diffMin = Math.max(1, Math.round(diffSec / 60));
            const depIso = new Date(now.getTime() + diffSec * 1000).toISOString();

            next = {
              lineId: '02498',
              lineName: 'C-10',
              destination: isDir1 ? 'Hospital de Mataró' : 'Barcelona (Metro la Pau)',
              departureTime: timeStr,
              departureDate: depIso,
              expectedIso: depIso,
              aimedIso: depIso,
              scheduledTime: timeStr,
              delayMinutes: 0,
              delayStatus: 'scheduled',
              delayBadgeText: 'Horari teòric',
              isRealtime: false,
              isPassed: diffSec < -120,
              minutesAway: diffMin,
              formattedStatus: diffMin <= 0 ? 'Imminent' : `${diffMin} min`
            };
          }
        }

        if (!next) {
          next = deps.find(d => d.minutesAway >= -1) || deps[0] || null;
        }

        return {
          id: cp.id,
          name: cp.name,
          zone: cp.zone,
          seq: cp.seq,
          nextBus: next,
          allDepartures: deps.slice(0, 3)
        };
      } catch (e) {
        return {
          id: cp.id,
          name: cp.name,
          zone: cp.zone,
          seq: cp.seq,
          nextBus: null,
          error: e.message
        };
      }
    });

    const checkpointResults = await Promise.all(promises);
    checkpointResults.sort((a, b) => a.seq - b.seq);

    return {
      direction: direction,
      currentSec: currentSec,
      activeServiceCount: todaysTrips.length,
      checkpoints: checkpointResults,
      activeBuses: activeBuses,
      trackedTripId: targetTripToTrack?.tripId || null,
      targetStop: this.targetStop,
      lastUpdated: new Date().toISOString()
    };
  }
}

module.exports = new CorridorTracker();

const https = require('https');
const timeUtils = require('./timeUtils');

class MataroSiriClient {
  constructor() {
    this.hostname = 'sirimataro.avanzagrupo.com';
    this.port = 443;
    this.path = '/Siri/SiriWS.asmx';
    this.accountId = 'Mataro';
    this.accountKey = 'Mataro*WS';
    this.cache = new Map();
    this._inflight = new Map(); // key -> upstream fetch/parse promise (coalesces concurrent identical requests)
    this.cacheTtlMs = 20000; // 20-second live cache with 10-minute (600s) stale fallback buffer
    this.staleFallbackTtlMs = 10 * 60 * 1000; // 10-minute fallback buffer for dead reckoning
    this.lastWarnTime = 0;
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
    this.circuitCooldownMs = 30000; // 30-second cooldown on upstream network calls when server hangs
    this.lastVehicleSuccessAt = null;
    this.lastArrivalsSuccessAt = null;
    this.lastFailureAt = null;
    // Pluggable transport: server.js installs an WorkerBridge-backed backend
    // in the main process so SIRI SOAP traffic stays worker-owned.
    this._httpBackend = null;
    this._rpcBackend = null;
  }

  observationTimestamp(value) {
    const timestamp = Date.parse(value);
    // Reject timestamps in the future and observations too old to represent a
    // current vehicle state (older than the stale-fallback window).
    return Number.isFinite(timestamp) && timestamp > 0
      && timestamp <= Date.now() + 60000
      && timestamp >= Date.now() - this.staleFallbackTtlMs
      ? timestamp : null;
  }

  isCircuitOpen() {
    return Date.now() < this.circuitOpenUntil;
  }

  recordSuccess(kind = 'vehicles') {
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
    if (kind === 'arrivals') this.lastArrivalsSuccessAt = Date.now();
    else this.lastVehicleSuccessAt = Date.now();
  }

  getUpstreamStatus() {
    const now = Date.now();
    return {
      timestamp: now,
      circuitOpen: this.isCircuitOpen(),
      circuitOpenUntil: this.isCircuitOpen() ? this.circuitOpenUntil : null,
      consecutiveFailures: this.consecutiveFailures,
      cooldownMs: this.circuitCooldownMs,
      lastVehicleSuccessAt: this.lastVehicleSuccessAt,
      lastArrivalsSuccessAt: this.lastArrivalsSuccessAt,
      lastFailureAt: this.lastFailureAt
    };
  }

  recordFailure(errMsg = '') {
    this.consecutiveFailures++;
    this.lastFailureAt = Date.now();
    const now = Date.now();
    if (this.consecutiveFailures >= 2) {
      this.circuitOpenUntil = now + this.circuitCooldownMs;
      if (now - this.lastWarnTime > 60000) {
        console.warn(`[SIRI] Circuit breaker tripped (${errMsg || 'upstream unavailable'}). Pausing SOAP calls for 30s to serve instant cache / dead-reckoning in 0ms.`);
        this.lastWarnTime = now;
      }
    }
  }

  /**
   * Install alternative transport. fn(req) must resolve to { status, bodyText }.
   */
  setHttpBackend(fn) {
    this._httpBackend = typeof fn === 'function' ? fn : null;
  }

  /**
   * Install direct RPC backend for worker communication.
   */
  setRpcBackend(fn) {
    this._rpcBackend = typeof fn === 'function' ? fn : null;
  }

  callSoap(action, soapXml) {
    if (typeof this._httpBackend === 'function') {
      return Promise.resolve()
        .then(() => this._httpBackend({
          kind: 'siri',
          url: `https://${this.hostname}${this.path}`,
          options: {
            method: 'POST',
            headers: {
              'Content-Type': 'text/xml; charset=utf-8',
              'SOAPAction': `http://tempuri.org/${action}`,
              'User-Agent': 'MataroBus/2.4.0 (Android; com.geoactio.matarobus)'
            }
          },
          body: soapXml
        }))
        .then((r) => {
          if (!r || typeof r.bodyText !== 'string') throw new Error('SIRI proxy malformed response');
          return r.bodyText;
        });
    }
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.hostname,
        port: this.port,
        path: this.path,
        method: 'POST',
        timeout: 2500,
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'SOAPAction': `http://tempuri.org/${action}`,
          'Content-Length': Buffer.byteLength(soapXml),
          'User-Agent': 'MataroBus/2.4.0 (Android; com.geoactio.matarobus)'
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('SIRI request timeout'));
      });

      req.write(soapXml);
      req.end();
    });
  }

  // Parse ISO 8601 duration e.g. "PT2M", "-PT5M", "PT30S"
  parseDurationMinutes(durStr) {
    if (!durStr) return 0;
    let sign = 1;
    let str = durStr;
    if (str.startsWith('-')) {
      sign = -1;
      str = str.substring(1);
    }
    const matchMin = str.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!matchMin) return 0;
    const hours = parseInt(matchMin[1] || '0', 10);
    const mins = parseInt(matchMin[2] || '0', 10);
    const secs = parseInt(matchMin[3] || '0', 10);
    return sign * Math.round(hours * 60 + mins + secs / 60);
  }

  // Extract simple tag content from XML string, decoding XML entities
  extractTag(xml, tag) {
    const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    if (!match) return null;
    return this.decodeXmlEntities(match[1].trim());
  }

  // Decode XML entities (&amp; &lt; &gt; &quot; &apos; and numeric refs) in extracted values
  decodeXmlEntities(str) {
    return str
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  // Escape a value interpolated into a SOAP envelope (prevents XML injection)
  xmlEscape(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // Reject early any input containing characters outside the safe SIRI ref alphabet
  assertSafeRef(value, name) {
    if (value && /[^A-Za-z0-9_.\-]/.test(String(value))) {
      throw new Error(`[SIRI] Invalid characters in ${name}: ${String(value).slice(0, 40)}`);
    }
  }

  // 1. Get Live GPS Telemetry for All Buses on a Line (or all lines)
  async getLiveVehicles(lineRef = '') {
    this.assertSafeRef(lineRef, 'lineRef');

    const cacheKey = `veh_${lineRef}`;
    const cached = this.cache.get(cacheKey);
    const now = Date.now();

    // 1. Fresh cache: instant 0ms return (<20s)
    if (cached && (now - cached.ts < this.cacheTtlMs)) {
      return cached.data;
    }

    // 1b. Concurrent identical miss: join the in-flight upstream request
    if (this._inflight.has(cacheKey)) {
      return this._inflight.get(cacheKey);
    }

    // 2. Circuit breaker check: if upstream is blocked or hanging, return stale fallback immediately in 0ms!
    if (this.isCircuitOpen()) {
      if (cached && (now - cached.ts < this.staleFallbackTtlMs)) {
        return cached.data.map(v => ({
          ...v,
          isEstimated: true,
          isRealTime: false,
          delayBadgeText: '⚡ En ruta (Estimat)',
          statusText: '⚡ Estimació per pèrdua temporal de senyal'
        }));
      }
      return [];
    }

    // 3. Pluggable RPC transport (Main process -> Ingestion worker)
    if (typeof this._rpcBackend === 'function') {
      // The coalesced promise must resolve to the FINAL caller-facing value:
      // concurrent joiners (step 1b) receive it directly, with no post-processing.
      return this._coalesce(cacheKey, async () => {
        try {
          const res = await this._rpcBackend('getMataroLiveVehicles', { lineRef });
          if (Array.isArray(res)) {
            this.recordSuccess();
            this.cache.set(cacheKey, { ts: Date.now(), data: res });
            return res;
          }
        } catch (err) {
          this.recordFailure(err.message);
        }
        if (cached && (now - cached.ts < this.staleFallbackTtlMs)) {
          return cached.data.map(v => ({
            ...v,
            isEstimated: true,
            isRealTime: false,
            delayBadgeText: '⚡ En ruta (Estimat)',
            statusText: '⚡ Estimació per pèrdua temporal de senyal'
          }));
        }
        return [];
      });
    }

    // Direct SOAP fetch (worker / standalone): coalesced for concurrent callers
    return this._coalesce(cacheKey, async () => {
      const ts = new Date().toISOString();
      const soapXml = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/" xmlns:siri="http://www.siri.org.uk/siri">
  <soapenv:Header/>
  <soapenv:Body>
    <tem:GetVehicleMonitoring>
      <tem:request>
        <ServiceRequestInfo>
          <siri:RequestTimestamp>${ts}</siri:RequestTimestamp>
          <siri:AccountId>${this.accountId}</siri:AccountId>
          <siri:AccountKey>${this.accountKey}</siri:AccountKey>
        </ServiceRequestInfo>
        <Request version="2.0">
          <siri:RequestTimestamp>${ts}</siri:RequestTimestamp>
          <siri:VehicleMonitoringRef></siri:VehicleMonitoringRef>
          <siri:LineRef>${this.xmlEscape(lineRef)}</siri:LineRef>
        </Request>
      </tem:request>
    </tem:GetVehicleMonitoring>
  </soapenv:Body>
</soapenv:Envelope>`;

      try {
        const xml = await this.callSoap('GetVehicleMonitoring', soapXml);
        const vehicles = [];

        const activityRegex = /<VehicleActivity>([\s\S]*?)<\/VehicleActivity>/gi;
        let actMatch;

        while ((actMatch = activityRegex.exec(xml)) !== null) {
          const itemXml = actMatch[1];
          const lat = parseFloat(this.extractTag(itemXml, 'Latitude') || '0');
          const lon = parseFloat(this.extractTag(itemXml, 'Longitude') || '0');
          const line = this.extractTag(itemXml, 'LineRef') || lineRef;
          const lineName = this.extractTag(itemXml, 'PublishedLineName') || '';
          const directionName = this.extractTag(itemXml, 'DirectionName') || '';
          const origin = this.extractTag(itemXml, 'OriginName') || '';
          const dest = this.extractTag(itemXml, 'DestinationName') || '';
          const vehicleRef = this.extractTag(itemXml, 'VehicleRef') || 'Bus';
          const bearing = parseInt(this.extractTag(itemXml, 'Bearing') || '0', 10);
          const velocity = parseFloat(this.extractTag(itemXml, 'Velocity') || '0');
          const delayStr = this.extractTag(itemXml, 'Delay') || 'PT0M';
          const delayMins = this.parseDurationMinutes(delayStr);
          const recordedAtRaw = this.extractTag(itemXml, 'RecordedAtTime');
          const recordedAt = recordedAtRaw || ts;
          const observedAt = this.observationTimestamp(recordedAtRaw);

          if (lat && lon) {
            vehicles.push({
              vehicleId: vehicleRef,
              lineId: line,
              lineName,
              directionName,
              origin,
              destination: dest,
              lat: Math.round(lat * 1000000) / 1000000,
              lon: Math.round(lon * 1000000) / 1000000,
              bearing: (bearing + 360) % 360,
              speedKmh: Number.isFinite(velocity) && velocity >= 0 ? Math.round(velocity * 3.6) : 25,
              delayMins,
              delayFormatted: delayMins > 0 ? `+${delayMins} min retard` : (delayMins < 0 ? `${delayMins} min avançat` : 'Puntual'),
              recordedAt,
              isEstimated: false,
              freshness: {
                source: 'live',
                fetchedAt: Date.now(),
                observedAt
              },
              timestamp: Date.now()
            });
          }
        }

        this.recordSuccess();
        this.cache.set(cacheKey, { ts: Date.now(), data: vehicles });
        return vehicles;
      } catch (err) {
        this.recordFailure(err.message);
        const nowErr = Date.now();
        if (err.message.includes('timeout') || err.message.includes('ECONNRESET') || err.message.includes('ECONNREFUSED')) {
          if (nowErr - this.lastWarnTime > 60000) {
            console.warn(`[SIRI] Avanza SIRI server transient issue (${err.message}). Using live cache & dead-reckoning fallback.`);
            this.lastWarnTime = nowErr;
          }
        } else {
          console.error(`[SIRI Error] GetVehicleMonitoring(${lineRef}):`, err.message);
        }
        if (cached && (Date.now() - cached.ts < this.staleFallbackTtlMs)) {
          return cached.data.map(v => ({
            ...v,
            isEstimated: true,
            isRealTime: false,
            delayBadgeText: '⚡ En ruta (Estimat)',
            statusText: '⚡ Estimació per pèrdua temporal de senyal'
          }));
        }
        return [];
      }
    });
  }

  // Coalesce concurrent identical upstream requests: the first caller starts
  // the fetch; simultaneous callers awaiting the same key share its result.
  // Settled promises are always removed, including on failure, so the next
  // request after a failure starts fresh. Never used as a response cache.
  _coalesce(key, fn) {
    if (this._inflight.has(key)) {
      return this._inflight.get(key);
    }
    const p = (async () => fn())().finally(() => {
      this._inflight.delete(key);
    });
    this._inflight.set(key, p);
    return p;
  }

  normalizeStopId(stopId) {
    if (!stopId) return '';
    const s = String(stopId).trim();
    const num = parseInt(s, 10);
    if (!isNaN(num) && num > 0 && num < 1000) {
      return String(1000 + num);
    }
    return s;
  }

  // 2. Get Real-Time Arrival Countdowns for a Specific Stop
  async getStopArrivals(stopId, lineRef = '') {
    const normStopId = this.normalizeStopId(stopId);
    this.assertSafeRef(normStopId, 'stopId');
    this.assertSafeRef(lineRef, 'lineRef');

    const cacheKey = `stop_${normStopId}_${lineRef}`;
    const cached = this.cache.get(cacheKey);
    const now = Date.now();

    // 1. Fresh cache: instant 0ms return (<20s)
    if (cached && (now - cached.ts < this.cacheTtlMs)) {
      return cached.data;
    }

    // 2. Circuit breaker check: if upstream is blocked or hanging, return stale fallback immediately in 0ms!
    if (this.isCircuitOpen()) {
      if (cached && (now - cached.ts < this.staleFallbackTtlMs)) {
        return cached.data.map(a => ({
          ...a,
          freshness: { ...a.freshness, fallback: true },
          isEstimated: true,
          isRealTime: false,
          delayBadgeText: '⚡ En ruta (Estimat)'
        }));
      }
      return [];
    }

    // 3. Pluggable RPC transport (Main process -> Ingestion worker)
    if (typeof this._rpcBackend === 'function') {
      // Coalesced promise resolves to the FINAL caller-facing value so
      // concurrent joiners (step 1b) get identical post-processed results.
      return this._coalesce(cacheKey, async () => {
        try {
          const r = await this._rpcBackend('getMataroStopArrivals', { stopId: normStopId, lineRef });
          if (Array.isArray(r)) {
            this.recordSuccess();
            this.cache.set(cacheKey, { ts: Date.now(), data: r });
            return r;
          }
        } catch (err) {
          this.recordFailure(err.message);
        }
        if (cached && (now - cached.ts < this.staleFallbackTtlMs)) {
          return cached.data.map(a => ({
            ...a,
          freshness: { ...a.freshness, fallback: true },
            isEstimated: true,
            isRealTime: false,
            delayBadgeText: '⚡ En ruta (Estimat)'
          }));
        }
        return [];
      });
    }

    // Direct SOAP fetch (worker / standalone): coalesced for concurrent callers
    return this._coalesce(cacheKey, async () => {
      const ts = new Date().toISOString();
      const soapXml = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <soap:Body>
    <GetStopMonitoring xmlns="http://tempuri.org/">
      <request>
        <ServiceRequestInfo xmlns="">
          <RequestTimestamp xmlns="http://www.siri.org.uk/siri">${ts}</RequestTimestamp>
          <AccountId xmlns="http://www.siri.org.uk/siri">${this.accountId}</AccountId>
          <AccountKey xmlns="http://www.siri.org.uk/siri">${this.accountKey}</AccountKey>
        </ServiceRequestInfo>
        <Request xmlns="">
          <RequestTimestamp xmlns="http://www.siri.org.uk/siri">${ts}</RequestTimestamp>
          <MonitoringRef xmlns="http://www.siri.org.uk/siri">${this.xmlEscape(normStopId)}</MonitoringRef>
          <LineRef xmlns="http://www.siri.org.uk/siri">${this.xmlEscape(lineRef)}</LineRef>
        </Request>
      </request>
    </GetStopMonitoring>
  </soap:Body>
</soap:Envelope>`;

      try {
        const xml = await this.callSoap('GetStopMonitoring', soapXml);
      const arrivals = [];

      const visitRegex = /<MonitoredStopVisit>([\s\S]*?)<\/MonitoredStopVisit>/gi;
      let visitMatch;

      while ((visitMatch = visitRegex.exec(xml)) !== null) {
        const itemXml = visitMatch[1];
        const line = this.extractTag(itemXml, 'LineRef') || '';
        const lineName = this.extractTag(itemXml, 'PublishedLineName') || '';
        const directionName = this.extractTag(itemXml, 'DirectionName') || '';
        const dest = this.extractTag(itemXml, 'DestinationName') || '';
        const vehicleRef = this.extractTag(itemXml, 'VehicleRef') || '';
        const dist = this.extractTag(itemXml, 'DistanceFromStop') || '';
        const expectedArr = this.extractTag(itemXml, 'ExpectedArrivalTime') || this.extractTag(itemXml, 'AimedArrivalTime') || '';
        const aimedArr = this.extractTag(itemXml, 'AimedArrivalTime') || expectedArr;
        const delayStr = this.extractTag(itemXml, 'Delay') || 'PT0M';
        let delayMins = this.parseDurationMinutes(delayStr);

        // Authoritatively compute delay from expected vs aimed arrival times if available
        if (expectedArr && aimedArr) {
          const expMs = new Date(expectedArr).getTime();
          const aimMs = new Date(aimedArr).getTime();
          if (!isNaN(expMs) && !isNaN(aimMs)) {
            delayMins = Math.round((expMs - aimMs) / 60000);
          }
        }

        const lat = parseFloat(this.extractTag(itemXml, 'Latitude') || '0');
        const lon = parseFloat(this.extractTag(itemXml, 'Longitude') || '0');

        let minutesAway = 0;
        let formattedTime = '--:--';
        let isValidArrival = false;

        if (expectedArr) {
          const arrDate = new Date(expectedArr);
          // Sanity check: timestamp must be valid and not older than 1 hour
          if (!isNaN(arrDate.getTime()) && arrDate.getTime() >= Date.now() - 3600000) {
            const now = new Date();
            const diffMs = arrDate.getTime() - now.getTime();
            const diffMin = Math.round(diffMs / 60000);
            if (diffMin >= -2) {
              minutesAway = Math.max(0, diffMin);
              formattedTime = timeUtils.formatTimeToTimezone(arrDate, 'Europe/Madrid');
              if (formattedTime !== '--:--') {
                isValidArrival = true;
              }
            }
          }
        }

        if (isValidArrival) {
          arrivals.push({
            lineId: line,
            lineName,
            directionName,
            destination: dest,
            vehicleId: vehicleRef,
            distanceFromStop: dist,
            departureTime: formattedTime,
            freshness: {
              source: this.extractTag(itemXml, 'ExpectedArrivalTime') ? 'live' : 'timetable',
              fetchedAt: Date.now(),
              observedAt: this.observationTimestamp(this.extractTag(itemXml, 'RecordedAtTime'))
            },
            expectedIso: expectedArr,
            aimedIso: aimedArr,
            minutesAway,
            formattedStatus: minutesAway === 0 ? 'Imminent' : (minutesAway === 1 ? '1 min' : `${minutesAway} min`),
            delayMins,
            delayBadgeText: delayMins >= 2 ? `+${delayMins} min retard` : (delayMins <= -1 ? `${Math.abs(delayMins)} min avançat` : 'Puntual'),
            delayStatus: delayMins >= 2 ? 'delayed' : (delayMins <= -1 ? 'early' : 'on-time'),
            isRealTime: true,
            busCoords: lat && lon ? { lat, lon } : null
          });
        }
      }

      arrivals.sort((a, b) => a.minutesAway - b.minutesAway);
      this.recordSuccess('arrivals');
      this.cache.set(cacheKey, { ts: Date.now(), data: arrivals });
      return arrivals;
    } catch (err) {
      this.recordFailure(err.message);
      const nowErr = Date.now();
      if (err.message.includes('timeout') || err.message.includes('ECONNRESET') || err.message.includes('ECONNREFUSED')) {
        if (nowErr - this.lastWarnTime > 60000) {
          console.warn(`[SIRI] Avanza SIRI server transient issue (${err.message}). Using live cache & dead-reckoning fallback.`);
          this.lastWarnTime = nowErr;
        }
      } else {
        console.error(`[SIRI Error] GetStopMonitoring(${stopId}):`, err.message);
      }
      if (cached && (Date.now() - cached.ts < this.staleFallbackTtlMs)) {
        return cached.data.map(a => ({
          ...a,
          freshness: { ...a.freshness, fallback: true },
          isEstimated: true,
          isRealTime: false,
          delayBadgeText: '⚡ En ruta (Estimat)'
        }));
      }
      return [];
      }
    });
  }
}

module.exports = new MataroSiriClient();

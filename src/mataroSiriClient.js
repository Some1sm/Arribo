const https = require('https');

class MataroSiriClient {
  constructor() {
    this.hostname = 'sirimataro.avanzagrupo.com';
    this.port = 443;
    this.path = '/Siri/SiriWS.asmx';
    this.accountId = 'Mataro';
    this.accountKey = 'Mataro*WS';
    this.cache = new Map();
    this.cacheTtlMs = 12000; // 12-second live cache
  }

  callSoap(action, soapXml) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.hostname,
        port: this.port,
        path: this.path,
        method: 'POST',
        rejectUnauthorized: false,
        timeout: 6000,
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

  // Extract simple tag content from XML string
  extractTag(xml, tag) {
    const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return match ? match[1].trim() : null;
  }

  // 1. Get Live GPS Telemetry for All Buses on a Line (or all lines)
  async getLiveVehicles(lineRef = '') {
    const cacheKey = `veh_${lineRef}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.cacheTtlMs) {
      return cached.data;
    }

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
          <siri:LineRef>${lineRef}</siri:LineRef>
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
        const recordedAt = this.extractTag(itemXml, 'RecordedAtTime') || ts;

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
            speedKmh: Math.round(velocity * 3.6) || (velocity > 0 ? Math.round(velocity) : 25),
            delayMins,
            delayFormatted: delayMins > 0 ? `+${delayMins} min retard` : (delayMins < 0 ? `${delayMins} min avançat` : 'Puntual'),
            recordedAt,
            isEstimated: false,
            timestamp: Date.now()
          });
        }
      }

      this.cache.set(cacheKey, { ts: Date.now(), data: vehicles });
      return vehicles;
    } catch (err) {
      console.error(`[SIRI Error] GetVehicleMonitoring(${lineRef}):`, err.message);
      return cached ? cached.data : [];
    }
  }

  // 2. Get Real-Time Arrival Countdowns for a Specific Stop
  async getStopArrivals(stopId, lineRef = '') {
    const cacheKey = `stop_${stopId}_${lineRef}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.cacheTtlMs) {
      return cached.data;
    }

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
          <MonitoringRef xmlns="http://www.siri.org.uk/siri">${stopId}</MonitoringRef>
          <LineRef xmlns="http://www.siri.org.uk/siri">${lineRef}</LineRef>
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
        const delayMins = this.parseDurationMinutes(delayStr);

        const lat = parseFloat(this.extractTag(itemXml, 'Latitude') || '0');
        const lon = parseFloat(this.extractTag(itemXml, 'Longitude') || '0');

        let minutesAway = 0;
        let formattedTime = '--:--';

        if (expectedArr) {
          const arrDate = new Date(expectedArr);
          const now = new Date();
          const diffMs = arrDate.getTime() - now.getTime();
          minutesAway = Math.max(0, Math.round(diffMs / 60000));
          formattedTime = arrDate.toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hour12: false });
        }

        arrivals.push({
          lineId: line,
          lineName,
          directionName,
          destination: dest,
          vehicleId: vehicleRef,
          distanceFromStop: dist,
          departureTime: formattedTime,
          expectedIso: expectedArr,
          aimedIso: aimedArr,
          minutesAway,
          formattedStatus: minutesAway === 0 ? 'Imminent' : (minutesAway === 1 ? '1 min' : `${minutesAway} min`),
          delayMins,
          delayBadgeText: delayMins > 0 ? `+${delayMins} min retard` : (delayMins < 0 ? `${delayMins} min avançat` : 'Puntual'),
          delayStatus: delayMins > 2 ? 'delayed' : (delayMins < -1 ? 'early' : 'on-time'),
          isRealTime: true,
          busCoords: lat && lon ? { lat, lon } : null
        });
      }

      arrivals.sort((a, b) => a.minutesAway - b.minutesAway);
      this.cache.set(cacheKey, { ts: Date.now(), data: arrivals });
      return arrivals;
    } catch (err) {
      console.error(`[SIRI Error] GetStopMonitoring(${stopId}):`, err.message);
      return cached ? cached.data : [];
    }
  }
}

module.exports = new MataroSiriClient();

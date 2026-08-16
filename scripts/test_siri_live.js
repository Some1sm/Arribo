const https = require('https');
const fs = require('fs');

function callSiri(soapAction, soapXml) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'sirimataro.avanzagrupo.com',
      port: 443,
      path: '/Siri/SiriWS.asmx',
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': `http://tempuri.org/${soapAction}`,
        'Content-Length': Buffer.byteLength(soapXml),
        'User-Agent': 'MataroBus/2.4.0'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });

    req.on('error', reject);
    req.write(soapXml);
    req.end();
  });
}

async function testAll() {
  const ts = new Date().toISOString();

  console.log('=== TEST 1: StopPointsDiscovery ===');
  const stopDiscoveryXml = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <soap:Body>
    <StopPointsDiscovery xmlns="http://tempuri.org/">
      <request>
        <ServiceRequestInfo xmlns="">
          <RequestTimestamp xmlns="http://www.siri.org.uk/siri">${ts}</RequestTimestamp>
          <AccountId xmlns="http://www.siri.org.uk/siri">Mataro</AccountId>
          <AccountKey xmlns="http://www.siri.org.uk/siri">Mataro*WS</AccountKey>
        </ServiceRequestInfo>
        <Request xmlns="">
          <RequestTimestamp xmlns="http://www.siri.org.uk/siri">${ts}</RequestTimestamp>
          <Circle xmlns="http://www.siri.org.uk/siri">
            <Latitude>41.5381</Latitude>
            <Longitude>2.4447</Longitude>
            <Precision>15000</Precision>
          </Circle>
          <LineRef xmlns="http://www.siri.org.uk/siri"></LineRef>
          <StopPointsDetailLevel xmlns="http://www.siri.org.uk/siri">full</StopPointsDetailLevel>
        </Request>
      </request>
    </StopPointsDiscovery>
  </soap:Body>
</soap:Envelope>`;

  const r1 = await callSiri('StopPointsDiscovery', stopDiscoveryXml);
  console.log('StopPointsDiscovery Status:', r1.status, 'Length:', r1.data.length);
  fs.writeFileSync('scripts/siri_stops.xml', r1.data);
  console.log('Sample StopPointsDiscovery:\n', r1.data.substring(0, 1200));

  console.log('\n=== TEST 2: GetVehicleMonitoring (All Lines) ===');
  const vehicleXml = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/" xmlns:siri="http://www.siri.org.uk/siri">
  <soapenv:Header/>
  <soapenv:Body>
    <tem:GetVehicleMonitoring>
      <tem:request>
        <ServiceRequestInfo>
          <siri:RequestTimestamp>${ts}</siri:RequestTimestamp>
          <siri:AccountId>Mataro</siri:AccountId>
          <siri:AccountKey>Mataro*WS</siri:AccountKey>
        </ServiceRequestInfo>
        <Request version="2.0">
          <siri:RequestTimestamp>${ts}</siri:RequestTimestamp>
          <siri:VehicleMonitoringRef></siri:VehicleMonitoringRef>
          <siri:LineRef></siri:LineRef>
        </Request>
      </tem:request>
    </tem:GetVehicleMonitoring>
  </soapenv:Body>
</soapenv:Envelope>`;

  const r2 = await callSiri('GetVehicleMonitoring', vehicleXml);
  console.log('GetVehicleMonitoring Status:', r2.status, 'Length:', r2.data.length);
  fs.writeFileSync('scripts/siri_vehicles.xml', r2.data);
  console.log('Sample GetVehicleMonitoring:\n', r2.data.substring(0, 2000));

  console.log('\n=== TEST 3: GetStopMonitoring (e.g. Stop 1) ===');
  const stopMonitoringXml = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <soap:Body>
    <GetStopMonitoring xmlns="http://tempuri.org/">
      <request>
        <ServiceRequestInfo xmlns="">
          <RequestTimestamp xmlns="http://www.siri.org.uk/siri">${ts}</RequestTimestamp>
          <AccountId xmlns="http://www.siri.org.uk/siri">Mataro</AccountId>
          <AccountKey xmlns="http://www.siri.org.uk/siri">Mataro*WS</AccountKey>
        </ServiceRequestInfo>
        <Request xmlns="">
          <RequestTimestamp xmlns="http://www.siri.org.uk/siri">${ts}</RequestTimestamp>
          <MonitoringRef xmlns="http://www.siri.org.uk/siri">1</MonitoringRef>
          <LineRef xmlns="http://www.siri.org.uk/siri"></LineRef>
        </Request>
      </request>
    </GetStopMonitoring>
  </soap:Body>
</soap:Envelope>`;

  const r3 = await callSiri('GetStopMonitoring', stopMonitoringXml);
  console.log('GetStopMonitoring Status:', r3.status, 'Length:', r3.data.length);
  fs.writeFileSync('scripts/siri_stop_monitoring.xml', r3.data);
  console.log('Sample GetStopMonitoring:\n', r3.data.substring(0, 1500));
}

testAll().catch(console.error);

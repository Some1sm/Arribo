const https = require('https');
const http = require('http');

function callSiri(lineRef) {
  return new Promise((resolve) => {
    const ts = new Date().toISOString();
    const soapXml = `<?xml version="1.0" encoding="utf-8"?>
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
          <siri:LineRef>${lineRef}</siri:LineRef>
        </Request>
      </tem:request>
    </tem:GetVehicleMonitoring>
  </soapenv:Body>
</soapenv:Envelope>`;

    const options = {
      hostname: 'sirimataro.avanzagrupo.com',
      port: 443,
      path: '/Siri/SiriWS.asmx',
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'http://tempuri.org/GetVehicleMonitoring',
        'Content-Length': Buffer.byteLength(soapXml),
        'User-Agent': 'MataroBus/2.4.0'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ lineRef, status: res.statusCode, len: data.length, data }));
    });
    req.on('error', (e) => resolve({ lineRef, err: e.message }));
    req.write(soapXml);
    req.end();
  });
}

function probeLocactio(path) {
  return new Promise((resolve) => {
    const req = http.get(`http://matarobus.locactio.com/${path}`, { headers: { 'User-Agent': 'MataroBus/2.4.0' }, timeout: 4000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ path, status: res.statusCode, len: data.length, body: data.substring(0, 300) }));
    });
    req.on('error', (e) => resolve({ path, err: e.message }));
  });
}

async function run() {
  console.log('Testing SIRI with line references...');
  const testLines = ['1', '2', '3', '4', '5', '6', '7', '8', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', '01', '02', '03', '04', '05'];
  for (const l of testLines) {
    const res = await callSiri(l);
    if (res.data && res.data.includes('<VehicleActivity>')) {
      console.log(`🎉 ACTIVE BUSES ON LINE ${l}! Length: ${res.len}`);
      console.log(res.data);
    } else {
      console.log(`Line ${l}: len=${res.len} (no active vehicles)`);
    }
  }

  console.log('\nTesting matarobus.locactio.com...');
  const paths = [
    'index.php',
    'index.php/api/getLineas',
    'index.php/api/getParadas',
    'index.php/api/getTiempos',
    'api/lineas',
    'api/paradas'
  ];
  for (const p of paths) {
    const r = await probeLocactio(p);
    console.log(`locactio /${p} -> [${r.status}] ${r.body || r.err}`);
  }
}

run().catch(console.error);

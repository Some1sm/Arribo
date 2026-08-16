const https = require('https');

function callSiri(soapAction, soapBody) {
  return new Promise((resolve, reject) => {
    const postData = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/" xmlns:siri="http://www.siri.org.uk/siri">
  <soapenv:Header/>
  <soapenv:Body>
    ${soapBody}
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
        'SOAPAction': `http://tempuri.org/${soapAction}`,
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'MataroBus/2.4.0'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function run() {
  console.log('Testing 1: GetVehicleMonitoring (Live Buses GPS)...');
  const now = new Date().toISOString();
  
  const vehicleBody = `
    <tem:GetVehicleMonitoring>
      <tem:request>
        <siri:RequestTimestamp>${now}</siri:RequestTimestamp>
        <siri:AccountId>Mataro</siri:AccountId>
        <siri:AccountKey>Mataro*WS</siri:AccountKey>
        <siri:VehicleMonitoringRef></siri:VehicleMonitoringRef>
        <siri:LineRef></siri:LineRef>
      </tem:request>
    </tem:GetVehicleMonitoring>
  `;

  const vRes = await callSiri('GetVehicleMonitoring', vehicleBody);
  console.log('VehicleMonitoring Status:', vRes.status);
  console.log('VehicleMonitoring Response Sample:\n', vRes.data.substring(0, 2500));

  console.log('\nTesting 2: StopPointsDiscovery (All Stops Catalog)...');
  const stopsBody = `
    <tem:StopPointsDiscovery>
      <tem:request>
        <siri:RequestTimestamp>${now}</siri:RequestTimestamp>
        <siri:AccountId>Mataro</siri:AccountId>
        <siri:AccountKey>Mataro*WS</siri:AccountKey>
      </tem:request>
    </tem:StopPointsDiscovery>
  `;
  const sRes = await callSiri('StopPointsDiscovery', stopsBody);
  console.log('StopPointsDiscovery Status:', sRes.status);
  console.log('StopPointsDiscovery Response Sample:\n', sRes.data.substring(0, 1500));
}

run().catch(console.error);

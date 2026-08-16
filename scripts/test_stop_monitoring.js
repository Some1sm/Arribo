const https = require('https');

function getStopMonitoring(stopRef, lineRef = '') {
  return new Promise((resolve) => {
    const ts = new Date().toISOString();
    const soapXml = `<?xml version="1.0" encoding="utf-8"?>
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
          <MonitoringRef xmlns="http://www.siri.org.uk/siri">${stopRef}</MonitoringRef>
          <LineRef xmlns="http://www.siri.org.uk/siri">${lineRef}</LineRef>
        </Request>
      </request>
    </GetStopMonitoring>
  </soap:Body>
</soap:Envelope>`;

    const options = {
      hostname: 'sirimataro.avanzagrupo.com',
      port: 443,
      path: '/Siri/SiriWS.asmx',
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'http://tempuri.org/GetStopMonitoring',
        'Content-Length': Buffer.byteLength(soapXml),
        'User-Agent': 'MataroBus/2.4.0'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ stopRef, status: res.statusCode, len: data.length, data }));
    });
    req.on('error', (e) => resolve({ stopRef, err: e.message }));
    req.write(soapXml);
    req.end();
  });
}

async function run() {
  console.log('Testing GetStopMonitoring for various stop refs...');
  const testStops = ['1058', '1060', '1122', '1051', '1128', '1132', '1', '2', '3', '100', '101'];
  for (const s of testStops) {
    const res = await getStopMonitoring(s);
    if (res.data && res.data.includes('<MonitoredStopVisit>')) {
      console.log(`🎉 DEPARTURES FOUND AT STOP ${s}! Length: ${res.len}`);
      console.log(res.data);
    } else {
      console.log(`Stop ${s}: len=${res.len}`);
    }
  }
}

run().catch(console.error);

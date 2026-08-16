const fs = require('fs');

async function testMouTeAPI() {
  const baseUrl = 'https://mou-te.gencat.cat/MouteAPI/rest/';

  const endpoints = [
    `infrastructure/nextdeparturesNEW?paradaId=GEN_PF08121075&useRealTime=true&language=ca`,
    `infrastructure/nextdeparturesNEW?paradaId=GEN_PF08121041&useRealTime=true&language=ca`,
    `infrastructure/line/itineraries?liniaId=GEN_0498`,
    `infrastructure/line/info?liniaId=GEN_0498`,
    `infrastructure/stop/info?paradaId=GEN_PF08121075`,
    `infrastructure/stop/info?paradaId=GEN_PF08121041`,
    `infrastructure/departures?language=ca&liniaId=GEN_0498&paradaId=GEN_PF08121075&useRealTime=true`
  ];

  for (const ep of endpoints) {
    const url = baseUrl + ep;
    console.log(`\nFetching: ${url}`);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/json, text/plain, */*'
        }
      });
      console.log(`Status: ${res.status}, Type: ${res.headers.get('content-type')}`);
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        console.log('JSON Response:', JSON.stringify(json, null, 2).substring(0, 1500));
      } catch (e) {
        console.log('Raw text:', text.substring(0, 500));
      }
    } catch (err) {
      console.error('Error fetching', url, err.message);
    }
  }
}

testMouTeAPI();

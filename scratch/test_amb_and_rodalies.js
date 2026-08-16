const fs = require('fs');
const mouteClient = require('../src/mouteClient');

(async () => {
  console.log('--- Testing AMB GTFS Routes & Real-time Integration ---');
  
  // 1. Check stops for Rodalies station (Mataró Rodalies: 10037210 or 10037211 or Barcelona Sants: 10008500)
  console.log('\n1. Testing Rodalies real-time at Mataró / Sants via Mou-te...');
  try {
    const deps = await mouteClient.getNextDepartures('10037210', true);
    console.log('Mataró Station departures:', deps ? (deps.departures ? deps.departures.length : Object.keys(deps)) : 'null');
    if (deps && deps.departures) {
      console.log('Sample departure:', deps.departures.slice(0, 3));
    }
  } catch(e) {
    console.error('Mou-te Rodalies test error:', e.message);
  }

  // 2. Check TUSGSAL stop (Badalona Pompeu Fabra: 10025777)
  console.log('\n2. Testing TUSGSAL real-time at Badalona Pompeu Fabra (10025777)...');
  try {
    const depsTusgsal = await mouteClient.getNextDepartures('10025777', true);
    console.log('Badalona Pompeu Fabra departures:', depsTusgsal ? (depsTusgsal.departures ? depsTusgsal.departures.length : Object.keys(depsTusgsal)) : 'null');
    if (depsTusgsal && depsTusgsal.departures) {
      console.log('Sample TUSGSAL lines serving stop:', [...new Set(depsTusgsal.departures.map(d => d.lineLabel || d.lineId))]);
    }
  } catch(e) {
    console.error('Mou-te TUSGSAL test error:', e.message);
  }

  // 3. Check Avanza Baix Llobregat (Castelldefels / Aeroport)
  console.log('\n3. Testing Avanza Baix Llobregat...');
  try {
    const depsAvanza = await mouteClient.getNextDepartures('10026030', true); // Castelldefels
    console.log('Avanza departures:', depsAvanza ? (depsAvanza.departures ? depsAvanza.departures.length : Object.keys(depsAvanza)) : 'null');
  } catch(e) {
    console.error('Mou-te Avanza test error:', e.message);
  }
})();

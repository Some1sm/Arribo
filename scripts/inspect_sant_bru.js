const fs = require('fs');
const http = require('http');
const https = require('https');
const corridorTracker = require('../src/corridorTracker');
const mouteClient = require('../src/mouteClient');

async function test() {
  console.log('Inspecting stop 10026351 (c. Sant Bru - c. les Corts) in Badalona at 14:31...');

  // 1. GTFS Timetable for the 14:15 trip (GEN_1811104, service GEN_185017)
  const fullSchedule = JSON.parse(fs.readFileSync('H:/Coding/C10Data/data/c10_full_schedule.json', 'utf8'));
  const trip1415 = fullSchedule.dir1.find(t => t.tripId === 'GEN_1811104');
  console.log('\n--- 1. GTFS Full Schedule for 14:15 Trip ---');
  trip1415.stops.forEach(s => {
    if (s.seq >= 6 && s.seq <= 12) {
      console.log(`Seq ${s.seq} (${s.stopId}): arr=${s.arr}, dep=${s.dep}`);
    }
  });

  // 2. Mou-te API raw response
  console.log('\n--- 2. Mou-te API for 10026351 ---');
  try {
    const mouteData = await mouteClient.getNextDepartures('10026351', true, 'ca_ES');
    console.log('Mou-te Sortides:', JSON.stringify(mouteData.sortides, null, 2));
    const parsed = corridorTracker.parseDepartures(mouteData, null, '1', '10026351', 9);
    console.log('Our Parsed:', parsed.slice(0, 3));
  } catch (e) {
    console.error('Mou-te error:', e.message);
  }

  // 3. Check AMB GTFS stop times if available
  try {
    const ambStopTimes = fs.readFileSync('C:/Users/ceper/.gemini/antigravity/brain/646bbb25-2441-4428-8c81-ef161d0f8e1d/scratch/amb_gtfs/stop_times.txt', 'utf8');
    const lines = ambStopTimes.split('\n').filter(l => l.includes('10026351') || l.includes('Sant Bru'));
    console.log('\n--- 3. AMB GTFS stop_times matches: ---');
    console.log(lines.slice(0, 5).join('\n'));
  } catch (e) {
    console.log('AMB GTFS search:', e.message);
  }
}

test().catch(console.error);

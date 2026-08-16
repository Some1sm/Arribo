const fs = require('fs');

const stopsDir1 = JSON.parse(fs.readFileSync('H:/Coding/C10Data/data/c10_matched_stops_dir1.json', 'utf8'));
const stopsDir0 = JSON.parse(fs.readFileSync('H:/Coding/C10Data/data/c10_matched_stops_dir0.json', 'utf8'));

function isStopMaresme(stop) {
  // If longitude is available, Montgat/Masnou border is at lon 2.289
  if (stop.lon) {
    return stop.lon >= 2.289;
  }
  const name = (stop.name || '').toLowerCase();
  if (name.includes('mataró') || name.includes('cabrera') || name.includes('vilassar') || 
      name.includes('premià') || name.includes('masnou') || name.includes('itàlia') ||
      name.includes('frança') || name.includes('granollers') || name.includes('ocata')) {
    return true;
  }
  return false;
}

console.log('=== Direction 1 (BCN -> Mataro) ===');
stopsDir1.forEach((s, idx) => {
  const m = isStopMaresme(s);
  console.log(`[${idx}] #${s.seq} ${s.name} -> ${m ? 'Maresme' : 'AMB'} (lon: ${s.lon})`);
});

console.log('\n=== Direction 0 (Mataro -> BCN) ===');
stopsDir0.forEach((s, idx) => {
  const m = isStopMaresme(s);
  console.log(`[${idx}] #${s.seq} ${s.name} -> ${m ? 'Maresme' : 'AMB'} (lon: ${s.lon})`);
});

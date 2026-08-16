const fs = require('fs');

const stopsDir1 = JSON.parse(fs.readFileSync('H:/Coding/C10Data/data/c10_matched_stops_dir1.json', 'utf8'));
const stopsDir0 = JSON.parse(fs.readFileSync('H:/Coding/C10Data/data/c10_matched_stops_dir0.json', 'utf8'));

function getStopZone(stop) {
  const name = (stop.name || '').toLowerCase();
  
  if (name.includes('mataró') || name.includes('cabrera') || name.includes('vilassar') || 
      name.includes('premià') || name.includes('masnou') || name.includes('itàlia') ||
      name.includes('bonamar') || name.includes('burriac') || name.includes('camí ral') ||
      name.includes('frança') || name.includes('porta laietana') || name.includes('granollers') ||
      name.includes('sant simó') || name.includes('rondó') || name.includes('cirera') ||
      name.includes('la riera') || name.includes('ocata') || name.includes('bellamar') ||
      name.includes('palomares') || name.includes('santa anna') || name.includes('la pineda')) {
    return 'Maresme';
  }
  
  if (name.includes('barcelona') || name.includes('badalona') || name.includes('sant adrià') || 
      name.includes('la pau') || name.includes('pompeu fabra') || name.includes('macià') ||
      name.includes('martí pujol') || name.includes('sant bru') || name.includes('alfons xiii') ||
      name.includes('guida') || name.includes('pep ventura') || name.includes('montgat')) {
    return 'AMB';
  }
  
  // Geographic fallback based on Montgat coastal boundary (lon ~ 2.285)
  if (stop.lon && stop.lon > 2.285) {
    return 'Maresme';
  }
  return 'AMB';
}

console.log('=== Direction 1 (Barcelona -> Mataro) ===');
stopsDir1.forEach((s, idx) => {
  const z = getStopZone(s);
  console.log(`[${idx}] #${s.seq} ${s.name} -> ${z}`);
});

console.log('\n=== Direction 0 (Mataro -> Barcelona) ===');
stopsDir0.forEach((s, idx) => {
  const z = getStopZone(s);
  console.log(`[${idx}] #${s.seq} ${s.name} -> ${z}`);
});

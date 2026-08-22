const fs = require('fs');
const html = fs.readFileSync('C:/Users/ceper/.gemini/antigravity/brain/f508c74c-7181-4f16-8e5b-b6e1f5a72f88/.system_generated/steps/85/content.md', 'utf8');

// Find all pdf links, schedule strings, hours, etc.
const pdfRegex = /href=["']([^"']+\.pdf)["']/gi;
let m;
console.log('--- PDF Links ---');
while ((m = pdfRegex.exec(html)) !== null) {
  console.log(m[1]);
}

// Find any timetable blocks or hours
const timeRegex = /\b\d{1,2}:\d{2}\b/g;
const times = html.match(timeRegex) || [];
console.log('--- Sample Times Found (' + times.length + ' total) ---');
console.log(times.slice(0, 30));

// Check text content snippet
const lines = html.split('\n').filter(l => l.includes('Horari') || l.includes('horario') || l.includes('Feiners') || l.includes('Dissabte') || l.includes('Diumenge') || l.includes('14:04') || l.includes('sortida') || l.includes('frecuencia') || l.includes('freqüència'));
console.log('--- Relevant Lines ---');
lines.slice(0, 40).forEach(l => console.log(l.trim()));

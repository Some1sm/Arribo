const fs = require('fs');
const html = fs.readFileSync('C:/Users/ceper/.gemini/antigravity/brain/f508c74c-7181-4f16-8e5b-b6e1f5a72f88/.system_generated/steps/85/content.md', 'utf8');

const idx = html.indexOf('function getHorariosTeoricos');
if (idx !== -1) {
  console.log(html.substring(idx, idx + 2000));
} else {
  console.log('Not found');
}

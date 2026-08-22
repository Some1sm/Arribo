const fs = require('fs');
const html = fs.readFileSync('C:/Users/ceper/.gemini/antigravity/brain/f508c74c-7181-4f16-8e5b-b6e1f5a72f88/.system_generated/steps/85/content.md', 'utf8');

const scriptRegex = /<script[\s\S]*?<\/script>/gi;
let m;
while ((m = scriptRegex.exec(html)) !== null) {
  if (m[0].includes('getHorariosTeoricos') || m[0].includes('pathIdBusLine')) {
    console.log('=== MATCHED SCRIPT ===');
    console.log(m[0]);
  }
}

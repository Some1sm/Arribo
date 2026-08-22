const fs = require('fs');
const html = fs.readFileSync('C:/Users/ceper/.gemini/antigravity/brain/f508c74c-7181-4f16-8e5b-b6e1f5a72f88/.system_generated/steps/85/content.md', 'utf8');

const regex = /pathIdBusLine[a-zA-Z0-9_]*\s*=\s*[^;]+/g;
let m;
while ((m = regex.exec(html)) !== null) {
  console.log(m[0]);
}

// Also search for all AJAX endpoints or portlet cmd in html
const cmdRegex = /_cmd=([a-zA-Z0-9_]+)/g;
while ((m = cmdRegex.exec(html)) !== null) {
  console.log('cmd: ' + m[1]);
}

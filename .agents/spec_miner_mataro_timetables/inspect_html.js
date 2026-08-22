const fs = require('fs');
const html = fs.readFileSync('C:/Users/ceper/.gemini/antigravity/brain/f508c74c-7181-4f16-8e5b-b6e1f5a72f88/.system_generated/steps/73/content.md', 'utf8');
const regex = /href=["']([^"']+)["']/gi;
let m;
const links = new Set();
while ((m = regex.exec(html)) !== null) {
  links.add(m[1]);
}
console.log('All links found:');
Array.from(links).forEach(l => console.log(l));

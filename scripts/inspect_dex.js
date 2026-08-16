const fs = require('fs');
const path = require('path');

function searchFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const text = buf.toString('utf8');
  // Extract all strings
  const strRegex = /[a-zA-Z0-9_\-\.\:\/\?\=\&\%\#]{4,150}/g;
  const matches = buf.toString('binary').match(strRegex) || [];

  const urls = matches.filter(s => s.startsWith('http://') || s.startsWith('https://'));
  const apis = matches.filter(s => s.includes('/api/') || s.includes('geoactio') || s.includes('matarobus'));
  const auths = matches.filter(s => s.includes('Basic ') || s.includes('Token ') || s.includes('user') || s.includes('pass'));

  return { filePath, urls: Array.from(new Set(urls)), apis: Array.from(new Set(apis)), auths: Array.from(new Set(auths)) };
}

function walkDir(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const f of files) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isDirectory()) {
      walkDir(full, fileList);
    } else {
      fileList.push(full);
    }
  }
  return fileList;
}

const allFiles = walkDir('scripts/apk_extracted');
console.log('Total extracted files:', allFiles.length);

for (const f of allFiles) {
  if (f.endsWith('.dex') || f.includes('assets') || f.includes('config') || f.endsWith('.json') || f.endsWith('.xml') || f.endsWith('.properties')) {
    const res = searchFile(f);
    if (res.urls.length > 0 || res.apis.length > 0) {
      console.log(`\n======================================================`);
      console.log(`FILE: ${f}`);
      if (res.urls.length) console.log('URLs:', res.urls);
      if (res.apis.length) console.log('APIs / Geoactio / Mataro:', res.apis.slice(0, 40));
    }
  }
}

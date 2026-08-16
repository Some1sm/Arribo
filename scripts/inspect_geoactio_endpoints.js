const fs = require('fs');

const dex = fs.readFileSync('scripts/apk_extracted/classes.dex').toString('latin1');

const regex = /(?:index\.php\/api\/[a-zA-Z0-9_\/]+|\/api\/[a-zA-Z0-9_\/]+)/g;
const matches = dex.match(regex) || [];
console.log('API Endpoints found in DEX:', Array.from(new Set(matches)));

// Let's also look for Retrofit interface methods (@GET, @POST) or URL strings in classes.dex
const urlStrings = dex.match(/[a-zA-Z0-9_\-]+\.php\/[a-zA-Z0-9_\/]+/g) || [];
console.log('PHP URL paths in DEX:', Array.from(new Set(urlStrings)));

// Let's search for headers in Retrofit
const headerStrings = dex.match(/(?:Header|Headers|user|pass|auth|token)[a-zA-Z0-9_\-:\s"']{3,60}/gi) || [];
console.log('Header samples:', Array.from(new Set(headerStrings)).slice(0, 30));

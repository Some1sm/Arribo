const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// An APK is a standard ZIP file. Let's read the zip directory or strings from classes.dex
const apkBuf = fs.readFileSync('scripts/matarobus.apk');
console.log('APK Buffer Size:', apkBuf.length);

// Extract all ASCII/UTF-8 strings of length >= 4 from the entire APK
const strRegex = /[a-zA-Z0-9_\-\.\:\/\?\=\&\%\#]{4,120}/g;
const allText = apkBuf.toString('binary');
const matches = allText.match(strRegex) || [];

console.log('Total extracted string tokens:', matches.length);

const geoactioMatches = matches.filter(s => s.toLowerCase().includes('geoactio') || s.toLowerCase().includes('matarobus') || s.toLowerCase().includes('mataro'));
console.log('\n--- Geoactio / Matarobus references ---');
console.log(Array.from(new Set(geoactioMatches)).slice(0, 50));

const apiMatches = matches.filter(s => s.startsWith('http://') || s.startsWith('https://') || s.includes('/api/'));
console.log('\n--- API / HTTP URLs in APK ---');
console.log(Array.from(new Set(apiMatches)));

// Search for user/pass headers or auth constants
const headerMatches = matches.filter(s => s.toLowerCase().includes('user') || s.toLowerCase().includes('pass') || s.toLowerCase().includes('auth') || s.toLowerCase().includes('token'));
console.log('\n--- Potential Auth Tokens / Keys ---');
console.log(Array.from(new Set(headerMatches)).slice(0, 60));

// Check current guides; historical architecture is deliberately not a contract.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const scripts = require('../package.json').scripts;
let failures = 0;
function fail(file, message) { console.error(`${file}: ${message}`); failures++; }
for (const file of ['README.md', 'AGENTS.md', 'OPERATIONS.md']) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  for (const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    if (!fs.existsSync(path.resolve(root, path.dirname(file), target))) fail(file, `Missing link: ${target}`);
  }
  for (const match of text.matchAll(/\bnpm run ([\w:-]+)/g)) {
    if (!Object.hasOwn(scripts, match[1])) fail(file, `Unknown npm script: ${match[1]}`);
  }
  for (const match of text.matchAll(/\bnode (scripts\/[\w.-]+\.js)/g)) {
    if (!fs.existsSync(path.join(root, match[1]))) fail(file, `Missing script: ${match[1]}`);
  }
}
console.log(`Documentation check: ${failures} errors`);
process.exitCode = failures ? 1 : 0;

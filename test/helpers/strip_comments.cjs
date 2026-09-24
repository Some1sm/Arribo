// A string-aware comment stripper for the test sweep. A naive regex is not
// enough: this repo has an Accept header containing "*/*;q=0.8", whose "*/*"
// reads as a comment opener and silently swallows real code. That produced a
// false PASS on the original scan, so the stripper has to understand strings.
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    // Line comment
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    // Block comment
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // Single/double-quoted string, honouring backslash escapes
    if (c === '"' || c === "'") {
      const quote = c;
      out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    // Template literal (no ${} interpolation handling needed for this use)
    if (c === '`') {
      out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === '`') { i++; break; }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

module.exports = { stripComments };
if (require.main === module) {
  const fs = require('fs');
  const t = fs.readFileSync('src/mataroTracker.js', 'utf8');
  const s = stripComments(t);
  console.log('stripped has agentFor:', s.includes('verifiedTls.agentFor'));
  console.log('stripped has rejectUnauthorized:false:', /rejectUnauthorized\s*:\s*false/.test(s));
  console.log('stripped has NODE_TLS_REJECT_UNAUTHORIZED:', /NODE_TLS_REJECT_UNAUTHORIZED/.test(s));
  console.log('Accept header intact:', s.includes('*/*;q=0.8'));
}

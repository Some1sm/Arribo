// Upstream bodies are read whole up to a cap, refused past it, and decoded once
// so a UTF-8 character split across chunks survives.
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { readBoundedBody } = require('../src/core/http/boundedBody');
const siriClient = require('../src/mataroSiriClient');

(async () => {
  // 1. "Llàntia" with the two bytes of "à" in different chunks.
  const bytes = Buffer.from('La Llàntia', 'utf8');
  const split = bytes.indexOf(0xc3) + 1;
  const ok = new PassThrough();
  const read = readBoundedBody(ok, 1024);
  ok.write(bytes.subarray(0, split));
  ok.end(bytes.subarray(split));
  assert.equal(await read, 'La Llàntia');

  // 2. Past the cap: rejected, and the stream is destroyed (the upstream stops sending).
  const big = new PassThrough();
  const refused = readBoundedBody(big, 10);
  big.write(Buffer.alloc(8));
  big.write(Buffer.alloc(8));
  await assert.rejects(refused, /larger than 10 bytes/);
  assert.equal(big.destroyed, true);

  // 3. An out-of-range character reference in a SIRI value is kept, not thrown.
  assert.equal(siriClient.decodeXmlEntities('A&#99999999;B &#xE0; &lt;b&gt;'), 'A&#99999999;B à <b>');

  console.log('PASS: bounded upstream bodies (split UTF-8, cap, destroy) and safe SIRI entity decoding');
})().catch((error) => { console.error(error); process.exitCode = 1; });

'use strict';
/**
 * src/core/http/boundedBody.js
 *
 * Reads an upstream response body as UTF-8 text, refusing anything larger than
 * maxBytes. Without a cap, a misbehaving or hostile upstream could keep
 * streaming until the 400 MB container runs out of memory. Measured on
 * 2026-10-28: SIRI answers are a few KB, the Avanza notices page 190 KB.
 *
 * The chunks are joined before decoding, so a multi-byte character split
 * across two chunks ("Llàntia") is not garbled, as `data += chunk` would.
 */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

function readBoundedBody(res, maxBytes = DEFAULT_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        res.destroy();
        reject(new Error(`upstream response larger than ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

module.exports = { readBoundedBody, DEFAULT_MAX_BYTES };

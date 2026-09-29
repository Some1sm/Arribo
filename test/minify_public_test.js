'use strict';

/**
 * test/minify_public_test.js
 *
 * The Docker image serves esbuild-minified copies of public/js and public/css
 * (scripts/minify_public.js). On a temporary copy of public/, verifies that every
 * file shrinks, every script still parses, every top-level name the pages share
 * survives unrenamed, HTML/sw.js/manifest stay byte-identical, and that the
 * source public/ directory is refused.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { minifyPublicDir } = require('../scripts/minify_public');

const SOURCE = path.join(__dirname, '..', 'public');
const TOP_LEVEL = /^(?:async\s+)?(?:class|function\*?|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

function assets(root) {
  const out = [];
  for (const [folder, ext] of [['js', '.js'], ['css', '.css']]) {
    for (const name of fs.readdirSync(path.join(root, folder)).sort()) {
      if (name.endsWith(ext)) out.push(path.join(folder, name));
    }
  }
  return out;
}

function hasWord(code, name) {
  const escaped = name.replace(/\$/g, '\\$');
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(code);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-minify-'));
try {
  const copy = path.join(scratch, 'public');
  fs.cpSync(SOURCE, copy, { recursive: true });

  const files = assets(SOURCE);
  const result = minifyPublicDir(copy);
  assert.equal(result.files, files.length, 'every js/css asset must be minified');
  assert.ok(result.bytesAfter < result.bytesBefore, 'minified total must be smaller');

  for (const rel of files) {
    const original = fs.readFileSync(path.join(SOURCE, rel), 'utf8');
    const minified = fs.readFileSync(path.join(copy, rel), 'utf8');
    assert.ok(minified.length < original.length, `${rel} must shrink`);
    if (rel.endsWith('.js')) {
      new vm.Script(minified, { filename: rel });
      for (const [, name] of original.matchAll(TOP_LEVEL)) {
        assert.ok(hasWord(minified, name), `${rel} must keep top-level name ${name}`);
      }
    }
  }

  for (const rel of ['index.html', 'plan.html', 'dades.html', 'sw.js', 'manifest.webmanifest']) {
    assert.ok(
      fs.readFileSync(path.join(copy, rel)).equals(fs.readFileSync(path.join(SOURCE, rel))),
      `${rel} must stay byte-identical`
    );
  }

  assert.throws(() => minifyPublicDir(SOURCE), /refusing to minify the source public\/ directory/);

  console.log(`✓ ${result.files} assets minified: ${result.bytesBefore} -> ${result.bytesAfter} bytes`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

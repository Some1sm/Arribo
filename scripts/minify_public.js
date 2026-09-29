'use strict';

/**
 * scripts/minify_public.js
 *
 * Minifies a COPY of public/ in place: every *.js directly inside <dir>/js and
 * every *.css directly inside <dir>/css. HTML files, sw.js and the manifest are
 * left untouched. The repository's own public/ directory is refused, so the
 * readable sources are never overwritten. Used by the Dockerfile asset stage.
 *
 * esbuild's transform API keeps top-level names (classes, functions, globals)
 * unrenamed, which the pages rely on because they share them across scripts.
 *
 * Usage: node scripts/minify_public.js <publicDir>
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const SOURCE_PUBLIC = path.resolve(__dirname, '..', 'public');

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function listTargets(root) {
  const targets = [];
  for (const [folder, ext] of [['js', '.js'], ['css', '.css']]) {
    const dir = path.join(root, folder);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.endsWith(ext)) targets.push(path.join(dir, name));
    }
  }
  return targets;
}

function minifyPublicDir(dir) {
  const root = path.resolve(dir);
  if (samePath(root, SOURCE_PUBLIC)) {
    throw new Error('refusing to minify the source public/ directory; pass a copy');
  }
  const targets = listTargets(root);
  if (targets.length === 0) throw new Error('no js/css files found to minify');

  let bytesBefore = 0;
  let bytesAfter = 0;
  for (const file of targets) {
    const source = fs.readFileSync(file, 'utf8');
    const loader = file.endsWith('.css') ? 'css' : 'js';
    const { code } = esbuild.transformSync(source, {
      loader,
      minify: true,
      charset: 'utf8',
      legalComments: 'none'
    });
    if (loader === 'js') new vm.Script(code, { filename: file });
    fs.writeFileSync(file, code);
    bytesBefore += Buffer.byteLength(source);
    bytesAfter += Buffer.byteLength(code);
  }
  return { files: targets.length, bytesBefore, bytesAfter };
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: node scripts/minify_public.js <publicDir>');
    process.exit(2);
  }
  try {
    const { files, bytesBefore, bytesAfter } = minifyPublicDir(dir);
    console.log(`[minify] ${files} files: ${bytesBefore} -> ${bytesAfter} bytes`);
  } catch (err) {
    console.error(`[minify] ${err.message}`);
    process.exit(1);
  }
}

module.exports = { minifyPublicDir };

/**
 * test/design_system_test.js
 *
 * The Arribo! design system's foundation in public/css/style.css (UI_GUIDE.md).
 *  1. Every var(--name) the app uses without a fallback is defined. Undefined
 *     names painted nothing (the methodology card had no background).
 *  2. The pairs the system promises are legible: text-primary/secondary/muted
 *     on every surface, on-action on action, the brand and status colours as
 *     text on bg-surface, each line's ink on its colour: 4.5:1 or better, in
 *     both themes.
 *  3. One radius scale and one header-nav style (no per-destination hues).
 *  4. A ratchet: hard-coded colours outside the token blocks, light-theme
 *     overrides and inline style attributes may only go down. When a change
 *     removes some, lower the ceilings here in the same commit.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const ok = msg => console.log(`  ✓ ${msg}`);
const css = read('public/css/style.css');
const sources = ['public/index.html', 'public/plan.html', 'public/dades.html',
  ...fs.readdirSync(path.join(root, 'public/js')).filter(f => f.endsWith('.js')).map(f => `public/js/${f}`)];

const CEILING = { hex: 382, rgba: 521, lightRules: 45, inlineStyles: 753 };

console.log('🧪 Testing the design system foundation...');

// ── token blocks ──────────────────────────────────────────────────────
const block = (opener) => {
  const at = css.indexOf(opener);
  assert.ok(at >= 0, `missing ${opener}`);
  const end = css.indexOf('\n}\n', at);
  const vars = {};
  for (const m of css.slice(at, end).matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)) vars[m[1]] = m[2].trim();
  return vars;
};
const dark = block(':root,\n[data-theme="dark"] {');
const light = block('[data-theme="light"] {');
const consts = block('/* Constants */\n:root {');
const resolve = (theme, value, depth = 0) => {
  const m = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  if (!m || depth > 8) return value;
  const next = theme[m[1]] ?? consts[m[1]] ?? dark[m[1]];
  assert.ok(next, `unresolvable ${m[1]}`);
  return resolve(theme, next, depth + 1);
};
const tok = (theme, name) => resolve(theme, theme[name] ?? consts[name]);

// 1. No undefined custom properties.
{
  const defined = new Set([...css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map(m => m[1]));
  const missing = {};
  for (const f of ['public/css/style.css', ...sources]) {
    for (const m of read(f).matchAll(/var\((--[a-zA-Z0-9-]+)\s*(,)?/g)) {
      if (!defined.has(m[1]) && !m[2]) missing[m[1]] = `${f}`;
    }
  }
  assert.deepEqual(missing, {}, 'every var() without a fallback is defined in style.css');
  ok('every var(--name) used without a fallback is defined');
}

// 2. Contrast.
{
  const hex = h => { const x = h.replace('#', ''); const f = x.length === 3 ? x.split('').map(c => c + c).join('') : x.slice(0, 6); return [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16) / 255); };
  const lum = h => { const [r, g, b] = hex(h).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const pairs = [];
  for (const [name, theme] of [['dark', dark], ['light', light]]) {
    for (const fg of ['--text-primary', '--text-secondary', '--text-muted']) {
      for (const bg of ['--bg-main', '--bg-surface', '--bg-surface-elevated']) pairs.push([name, theme, fg, bg]);
    }
    pairs.push([name, theme, '--on-action', '--action'], [name, theme, '--on-action', '--action-hover']);
    for (const fg of ['--brand', '--status-estimated', '--status-scheduled', '--status-regulating', '--danger']) pairs.push([name, theme, fg, '--bg-surface']);
  }
  for (const [name, theme, fg, bg] of pairs) {
    const r = ratio(tok(theme, fg), tok(theme, bg));
    assert.ok(r >= 4.5, `${name}: ${fg} on ${bg} is ${r.toFixed(2)}:1`);
  }
  for (let n = 1; n <= 8; n++) {
    const r = ratio(consts[`--on-line-${n}`], consts[`--line-${n}`]);
    assert.ok(r >= 4.5, `L${n} ink is ${r.toFixed(2)}:1`);
  }
  ok(`${pairs.length} token pairs and 8 line inks are 4.5:1 or better in both themes`);
}

// 3. One radius scale, one nav style, flat primary buttons.
{
  assert.deepEqual(['--radius-xs', '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--radius-full'].map(n => consts[n]),
    ['4px', '6px', '8px', '12px', '16px', '9999px']);
  assert.ok(!/\.btn-header-nav\.(map|planner|journalism|incidents)-btn/.test(css), 'no per-destination header nav colours');
  for (const theme of [dark, light]) assert.equal(theme['--btn-primary-bg'], 'var(--action)', 'primary buttons are a flat action fill');
  ok('radius scale 4/6/8/12/16/full; header nav has one style; primary buttons are flat');
}

// 4. Ratchet.
{
  const start = css.indexOf(':root,\n[data-theme="dark"] {');
  const end = css.indexOf('\n}\n', css.indexOf('/* Constants */')) + 3;
  const rest = css.slice(0, start) + css.slice(end);
  const now = {
    hex: (rest.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length,
    rgba: (rest.match(/rgba?\(/g) || []).length,
    lightRules: (rest.match(/\[data-theme="light"\]/g) || []).length,
    inlineStyles: sources.reduce((n, f) => n + read(f).split('style="').length - 1, 0)
  };
  for (const k of Object.keys(CEILING)) {
    assert.ok(now[k] <= CEILING[k], `${k}: ${now[k]} is above the ceiling ${CEILING[k]}; use a token or a class`);
  }
  ok(`ratchet holds: ${now.hex} hex, ${now.rgba} rgba, ${now.lightRules} light overrides, ${now.inlineStyles} inline styles`);
}

console.log('🎉 ALL DESIGN SYSTEM ASSERTIONS PASSED!');

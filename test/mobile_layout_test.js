/**
 * test/mobile_layout_test.js
 *
 * Phone-width layout rules that broke without anyone noticing (reported from a
 * phone on 2 Oct 2026). Each was checked in a browser at 412 px; these
 * assertions keep the rules that fix them from being deleted again.
 *  1. Header links shrink to 29px icon circles under 768px; their text label
 *     must be hidden there, or it covers the icons. The rule was removed as
 *     "unused" in faf972c (28 Sep).
 *  2. The hero glow fades to transparent at its own box edges (closest-side),
 *     so no hard green rectangle shows behind the bus.
 *  3. The hero badge wraps on phones instead of running out of the card.
 *  4. Filter pills fill their rows: the GPS map's nine line pills in one row,
 *     the incident filters in an even grid ("Totes les línies", then 4 + 4).
 *  5. The delay investigation's grid column can shrink below its content
 *     (minmax(0, 1fr)) and the trip meta line may break, so the panel stays
 *     inside the screen.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const ok = msg => console.log(`  ✓ ${msg}`);
const css = read('public/css/style.css');
const obs = read('public/js/observatori.js');

// Every @media block with this query, concatenated (a query can appear many
// times in style.css; a rule may sit in any of them).
const mediaBlock = (query) => {
  const blocks = [];
  let at = css.indexOf(`@media ${query} {`);
  while (at >= 0) {
    let depth = 0;
    for (let i = css.indexOf('{', at); i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) { blocks.push(css.slice(at, i + 1)); break; }
    }
    at = css.indexOf(`@media ${query} {`, at + 1);
  }
  assert.ok(blocks.length, `missing @media ${query}`);
  return blocks.join('\n');
};
const rule = (scope, selector) => {
  const re = new RegExp(`(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const m = re.exec(scope);
  return m ? m[2] : null;
};

console.log('🧪 Testing phone-width layout rules...');

// 1. Header labels hidden where the links are icon circles.
{
  const m = mediaBlock('(max-width: 768px)');
  assert.ok(/width:\s*29px/.test(rule(m, '.btn-header-nav') || ''), 'header links are 29px circles under 768px');
  assert.ok(/display:\s*none/.test(rule(m, '.btn-header-nav span:not(.nav-icon)') || ''), 'and their labels are hidden there');
  ok('header links are icon-only circles on phones, labels hidden');
}

// 2. Hero glow.
{
  const r = rule(css, '.landing-hero-card::before');
  assert.ok(/radial-gradient\(closest-side,/.test(r), 'the glow fades out at its own edges');
  ok('hero glow fades to its edges (no visible rectangle)');
}

// 3. Hero badge wraps on phones.
{
  const r = rule(mediaBlock('(max-width: 640px)'), '.landing-hero-badge');
  assert.ok(/white-space:\s*normal/.test(r) && !/white-space:\s*nowrap/.test(r), 'the badge wraps');
  ok('hero badge wraps inside the card on phones');
}

// 4. Filter pills.
{
  assert.ok(/#gps-gaps-lines\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*auto repeat\(8, minmax\(0, 1fr\)\)/.test(css), 'GPS line pills: one row of nine on phones');
  assert.ok(/\.incident-filter-options\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/.test(css), 'incident line pills: an even 4-column grid on phones');
  assert.ok(/\.incident-filter-options--lines \.incident-filter-pill:first-child\s*\{\s*grid-column:\s*1 \/ -1/.test(css), '"Totes les línies" takes the first row');
  assert.ok(obs.includes('incident-filter-options incident-filter-options--lines') && obs.includes('incident-filter-options incident-filter-options--period'), 'the incident filters use the classes');
  assert.ok(!/<span style="width:8px; height:8px; border-radius:50%; background:\$\{color\}/.test(obs), 'line dots use .line-dot-N, not inline colours');
  ok('filter pills fill even rows on phones (GPS lines in one row; incidents 1 + 4 + 4)');
}

// 5. Investigation panel stays inside the screen.
{
  assert.ok(/grid-template-columns:\s*minmax\(0, 1fr\)/.test(rule(css, '.drilldown-layout') || ''), 'the investigation column can shrink');
  assert.ok(!/white-space:\s*nowrap/.test(rule(css, '.drilldown-trip-meta') || ''), 'the trip meta line can break');
  ok('delay investigation fits the screen (shrinkable column, breakable meta)');
}

console.log('🎉 ALL MOBILE LAYOUT ASSERTIONS PASSED!');

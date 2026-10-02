/**
 * test/bus_icon_test.js
 *
 * The bus drawings.
 *  1. The front-view icon is gone everywhere (markers, counters, header marks,
 *     favicons, the PWA icon); the side view replaces it, so the map's
 *     scaleX(-1) for westbound buses is visible.
 *  2. No stroke of the small icon crosses a wheel (the windscreen pillar once
 *     ran through the front wheel).
 *  3. The landing hero's illustration is a 3-door Volvo 7900: rear door behind
 *     the rear axle, middle door between the axles, front door ahead of the
 *     front axle, none overlapping a wheel; a MATARÓ destination sign; colours
 *     only from the --bus-* tokens, defined in both themes.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const ok = msg => console.log(`  ✓ ${msg}`);
const files = ['public/index.html', 'public/plan.html', 'public/dades.html', 'public/manifest.webmanifest',
  ...fs.readdirSync(path.join(root, 'public/js')).filter(f => f.endsWith('.js')).map(f => `public/js/${f}`)];

console.log('🧪 Testing the bus drawings...');

// 1. Old icon gone, new icon in the shared constants.
{
  for (const f of files) assert.ok(!read(f).includes('M19 17h2l.64-2.54'), `${f} still draws the front-view bus`);
  const side = 'M4.7 17.5H3.4A1.4 1.4 0 0 1 2 16.1V6.4';
  assert.ok(/const CANONICAL_BUS_ICON_SVG = '[^']*M4\.7 17\.5H3\.4/.test(read('public/js/app.js')), 'app.js counter icon is the side view');
  assert.ok(/const CANONICAL_BUS_ICON_INNER_SVG = '[^']*M4\.7 17\.5H3\.4/.test(read('public/js/map.js')), 'map.js marker icon is the side view');
  assert.ok(read('public/manifest.webmanifest').includes(side), 'the PWA icon is the side view');
  assert.ok(read('public/js/map.js').includes('scaleX(${isHeadingWest ? -1 : 1})'), 'westbound markers still mirror the icon');
  ok('the front-view bus is gone; markers, counters, marks and icons draw the side view');
}

// 2. Small icon geometry: wheels at (7,17.5) and (17,17.5), r 2.3.
{
  const icon = /const CANONICAL_BUS_ICON_INNER_SVG = '([^']*)'/.exec(read('public/js/map.js'))[1];
  const wheels = [...icon.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map(m => m.slice(1).map(Number));
  assert.deepEqual(wheels, [[7, 17.5, 2.3], [17, 17.5, 2.3]]);
  // Every vertical stroke "Mx yvh" must end above the wheel tops (y 15.2) or sit outside them.
  for (const m of icon.matchAll(/M([\d.]+) ([\d.]+)v([\d.]+)/g)) {
    const [x, y, h] = m.slice(1).map(Number);
    for (const [cx, cy, r] of wheels) {
      const crosses = Math.abs(x - cx) < r && y + h > cy - r;
      assert.ok(!crosses, `stroke at x=${x} (y ${y}-${y + h}) runs into the wheel at x=${cx}`);
    }
  }
  ok('no stroke of the small icon crosses a wheel');
}

// 3. Hero illustration.
{
  const html = read('public/index.html');
  const svg = /<svg class="bus-illustration landing-hero-bus"[\s\S]*?<\/svg>/.exec(html);
  assert.ok(svg, 'the hero has the bus illustration');
  const s = svg[0];
  assert.ok(html.indexOf(s) < html.indexOf('class="landing-hero-title"'), 'it sits above the hero title');
  assert.ok(/role="img" aria-label="Autobús urbà de Mataró"/.test(s), 'it is labelled for screen readers');
  assert.ok(/>MATARÓ<\/text>/.test(s), 'the destination sign reads MATARÓ');
  assert.ok(!/(fill|stroke)="#[0-9a-f]{3,6}"/i.test(s), 'colours come from tokens');
  const css = read('public/css/style.css');
  for (const name of new Set([...s.matchAll(/var\((--bus-[a-z-]+)\)/g)].map(m => m[1]))) {
    assert.equal(css.split(`${name}:`).length - 1, 2, `${name} is defined once per theme`);
  }
  const wheels = [...s.matchAll(/<circle cx="(\d+)" cy="88" r="15"/g)].map(m => Number(m[1]));
  assert.deepEqual(wheels, [90, 226], 'rear and front axle');
  const doors = [...s.matchAll(/<rect x="(\d+)" y="22" width="(\d+)" height="64"/g)].map(m => [Number(m[1]), Number(m[1]) + Number(m[2])]);
  assert.equal(doors.length, 3, 'three doors');
  const [rear, middle, front] = doors.sort((a, b) => a[0] - b[0]);
  assert.ok(rear[1] < wheels[0] - 15, 'the rear door is behind the rear axle');
  assert.ok(middle[0] > wheels[0] + 15 && middle[1] < wheels[1] - 15, 'the middle door is between the axles');
  assert.ok(front[0] > wheels[1] + 15, 'the front door is ahead of the front axle');
  ok('hero: 3-door Volvo 7900 with a MATARÓ sign, doors clear of the wheels, token colours in both themes');
}

console.log('🎉 ALL BUS DRAWING ASSERTIONS PASSED!');

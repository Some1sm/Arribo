/**
 * ESLint flat config for Arribo!.
 *
 * Deliberately conservative: correctness rules that catch real defects
 * (unreachable code, duplicate keys, NaN comparisons) rather than style
 * churn. The repo has no build step, so this is advisory tooling only —
 * `npm run lint` reports, `npm run test:syntax` remains the hard gate.
 */
const globals = require('globals');

/** Rules that are effectively always bugs and carry no style opinion. */
const correctness = {
  'no-const-assign': 'error',
  'no-dupe-args': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-class-members': 'error',
  'no-self-assign': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-unreachable': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-obj-calls': 'error',
  'no-sparse-arrays': 'error',
  'no-unsafe-negation': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-fallthrough': 'error',
  'no-undef': 'error',
  'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }]
};

module.exports = [
  { ignores: ['node_modules/**', 'data/**', 'public/sw.js', '.agents/**'] },

  // Server + worker + shared core: CommonJS on Node.
  {
    files: ['server.js', 'src/**/*.js', 'scripts/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: correctness
  },

  // Browser bundle: classic scripts, no module syntax, relies on DOM globals.
  {
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // Leaflet is loaded as a classic script from unpkg and sets window.L.
        // map.js guards on `typeof L === 'undefined'` before first use.
        L: 'readonly',
        // Cross-file globals in the classic-script bundle. These are NOT
        // properties of `window`; they resolve through the shared global
        // lexical scope, which means they only work while the HTML script
        // order is preserved (app.js defines MATARO_ZONES, map.js defines
        // TransitMap via an explicit window assignment).
        MATARO_ZONES: 'readonly',
        TransitMap: 'readonly',
        // map.js also owns these two; networkMap.js subclasses TransitMap and
        // reuses its snapping helper and bus-icon markup rather than forking
        // them, so it reads them from the same shared lexical scope.
        snapStopToPolyline: 'readonly',
        CANONICAL_BUS_ICON_INNER_SVG: 'readonly'
      }
    },
    rules: correctness
  }
];

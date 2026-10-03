'use strict';

/**
 * src/core/geo/gapBuses.js
 *
 * Which buses lose GPS the most, and whether that points at the bus or at the
 * street. A bus is compared with the other buses on the same lines, per stop
 * served: a bus that drives the same streets as its colleagues but loses the
 * signal far more often points at its own equipment; one that loses it as
 * often as they do points at coverage.
 *
 *   expected = Σ over its lines (its stop visits × that line's losses per visit)
 *   ratio    = its losses / expected
 *   pValue   = P(X ≥ losses) for X ~ Poisson(expected): how likely the excess is by chance
 *
 * "suspect" needs 4+ losses, 1.5× the expected count and p < 0.05; "watch" is
 * 1.5× or more without that certainty (it can still be chance); under
 * 3 losses (or with no stop visits to compare) there is too little to say.
 */

const MIN_GAPS = 4;
const MIN_RATIO = 1.5;
const MAX_P = 0.05;

/** P(X ≥ n) for X ~ Poisson(lambda). */
function poissonTail(n, lambda) {
  if (n <= 0) return 1;
  if (!(lambda > 0)) return 0;
  let term = Math.exp(-lambda);
  let below = term;
  for (let k = 1; k < n; k++) {
    term *= lambda / k;
    below += term;
  }
  return Math.max(0, Math.min(1, 1 - below));
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/**
 * @param gaps   [{ id, vehicleId, lineCode, gapSec, shared }]  shared: other buses lost GPS at the same spot
 * @param visits [{ vehicleId, lineCode, n }]                    stop visits per bus and line in the same window
 * @returns { buses: [...], inService, withoutLoss }
 */
function rankBuses(gaps = [], visits = []) {
  const isFleet = id => /\d/.test(String(id || ''));
  const gs = gaps.filter(g => isFleet(g.vehicleId));
  const vs = visits.filter(v => isFleet(v.vehicleId) && v.n > 0);

  const lineGaps = new Map();
  const lineVisits = new Map();
  for (const g of gs) lineGaps.set(g.lineCode, (lineGaps.get(g.lineCode) || 0) + 1);
  for (const v of vs) lineVisits.set(v.lineCode, (lineVisits.get(v.lineCode) || 0) + v.n);
  const lineRate = l => (lineVisits.get(l) ? (lineGaps.get(l) || 0) / lineVisits.get(l) : 0);

  const byBus = new Map();
  const bus = id => {
    if (!byBus.has(id)) byBus.set(id, { gaps: [], visits: new Map() });
    return byBus.get(id);
  };
  for (const g of gs) bus(g.vehicleId).gaps.push(g);
  for (const v of vs) bus(v.vehicleId).visits.set(v.lineCode, (bus(v.vehicleId).visits.get(v.lineCode) || 0) + v.n);

  const buses = [];
  for (const [vehicleId, b] of byBus) {
    if (!b.gaps.length) continue;
    const visitCount = [...b.visits.values()].reduce((s, n) => s + n, 0);
    const expected = [...b.visits].reduce((s, [l, n]) => s + n * lineRate(l), 0);
    const n = b.gaps.length;
    const ratio = expected > 0 ? n / expected : null;
    const pValue = expected > 0 ? poissonTail(n, expected) : null;
    const verdict = n < 3 || ratio === null
      ? 'few'
      : n >= MIN_GAPS && ratio >= MIN_RATIO && pValue < MAX_P ? 'suspect'
        : ratio >= MIN_RATIO ? 'watch' : 'normal';
    buses.push({
      vehicleId,
      lines: [...new Set([...b.gaps.map(g => g.lineCode), ...b.visits.keys()])].sort(),
      gaps: n,
      visits: visitCount,
      per100: visitCount ? Math.round((1000 * n) / visitCount) / 10 : null,
      expected: Math.round(expected * 10) / 10,
      ratio: ratio === null ? null : Math.round(ratio * 10) / 10,
      pValue: pValue === null ? null : Math.round(pValue * 1000) / 1000,
      sharedPct: Math.round((100 * b.gaps.filter(g => g.shared).length) / n),
      medianGapSec: median(b.gaps.map(g => g.gapSec)),
      verdict
    });
  }
  const rank = { suspect: 0, watch: 1, normal: 2, few: 3 };
  // Suspects first, the furthest above their colleagues on top; then the most losses.
  buses.sort((a, b) => rank[a.verdict] - rank[b.verdict]
    || (a.verdict === 'suspect' ? (b.ratio || 0) - (a.ratio || 0) : b.gaps - a.gaps || (b.ratio || 0) - (a.ratio || 0)));

  const inService = new Set(vs.map(v => v.vehicleId));
  return {
    buses,
    inService: inService.size,
    withoutLoss: [...inService].filter(id => !byBus.get(id) || !byBus.get(id).gaps.length).length
  };
}

module.exports = { rankBuses, poissonTail, MIN_GAPS, MIN_RATIO, MAX_P };

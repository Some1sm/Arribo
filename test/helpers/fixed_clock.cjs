'use strict';
// Pins "now" for a test process while letting time keep flowing, so code that
// measures ages (now - observedAt) still behaves. Only affects THIS process;
// a forked worker keeps the real clock.
const RealDate = Date;

function install(isoInstant) {
  const fixed = RealDate.parse(isoInstant);
  if (!Number.isFinite(fixed)) throw new Error(`fixed_clock: invalid instant ${isoInstant}`);
  const offset = fixed - RealDate.now();
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }
    static now() { return RealDate.now() + offset; }
  }
  FixedDate.parse = RealDate.parse;
  FixedDate.UTC = RealDate.UTC;
  globalThis.Date = FixedDate;
  return function uninstall() { globalThis.Date = RealDate; };
}

module.exports = { install };

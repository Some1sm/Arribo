'use strict';

/**
 * One definition of punctuality for the whole platform (Arribo! Mataró Bus L1–L8).
 * A bus more than one minute early is NOT on time: a rider arriving at the published time misses it.
 */
const EARLY_LIMIT_MIN = -1;   // delay < -1  → early
const LATE_LIMIT_MIN = 3;     // delay > 3   → late
const SEVERE_LATE_MIN = 5;    // delay >= 5  → severely late
const VALID_DELAY_MIN = -15;  // delay <= -15 is upstream sentinel / unplausible (E8)

function classify(delayMins) {
  if (!Number.isFinite(delayMins)) return 'unknown';
  if (delayMins < EARLY_LIMIT_MIN) return 'early';
  if (delayMins > LATE_LIMIT_MIN) return 'late';
  return 'on_time';
}

// SQL fragments for punctual classifications and sanity bounds
const VALID_DELAY_SQL = `delay_mins > ${VALID_DELAY_MIN}`;
const ON_TIME_SQL = `(delay_mins >= ${EARLY_LIMIT_MIN} AND delay_mins <= ${LATE_LIMIT_MIN})`;
const EARLY_SQL = `(delay_mins < ${EARLY_LIMIT_MIN} AND ${VALID_DELAY_SQL})`;
const LATE_SQL = `(delay_mins > ${LATE_LIMIT_MIN})`;
const SEVERE_LATE_SQL = `(delay_mins >= ${SEVERE_LATE_MIN})`;

module.exports = {
  EARLY_LIMIT_MIN,
  LATE_LIMIT_MIN,
  SEVERE_LATE_MIN,
  VALID_DELAY_MIN,
  VALID_DELAY_SQL,
  ON_TIME_SQL,
  EARLY_SQL,
  LATE_SQL,
  SEVERE_LATE_SQL,
  classify
};

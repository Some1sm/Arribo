/**
 * src/timeUtils.js
 * 
 * Backward compatibility facade re-exporting from src/core/time/timeEngine.js and calendarEngine.js
 */

const timeEngine = require('./core/time/timeEngine');
const calendarEngine = require('./core/time/calendarEngine');

module.exports = {
  ...timeEngine,
  ...calendarEngine
};

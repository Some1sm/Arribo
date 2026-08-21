/**
 * src/geoUtils.js
 * 
 * Backward compatibility facade re-exporting from src/core/geo/geoEngine.js
 */

const geoEngine = require('./core/geo/geoEngine');

module.exports = {
  ...geoEngine
};

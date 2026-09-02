/**
 * Mataró Bus Fleet Database
 * Maps vehicle IDs and fleet series to propulsion technology, eco badges, and accessibility.
 * 
 * Fleet composition:
 * - 100% Electric Zero Emissions (Solaris Urbino Electric, Karsan Atak/e-ATA)
 * - Hybrid Eco (Iveco Urbanway Hybrid / MAN Lion's City Hybrid)
 * - Clean Euro-6 Diesel (Scania / Mercedes-Benz Citaro)
 */

// Known electric fleet series and specific IDs
const ELECTRIC_VEHICLE_IDS = new Set([
  '101', '102', '103', '104', '105', '106', '107', '108', '109', '110',
  '111', '112', '120', '121', '122', '123', '124', '125',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'
]);

const HYBRID_VEHICLE_IDS = new Set([
  '113', '114', '115', '116', '117', '118', '119',
  '126', '127', '128', '129', '130',
  '11', '12', '13', '14', '15', '16', '17', '18', '19', '20'
]);

/**
 * Normalizes a raw vehicle ID string to its numeric base
 * @param {string|number} rawId 
 * @returns {string}
 */
function normalizeVehicleId(rawId) {
  if (rawId === null || rawId === undefined) return '';
  return String(rawId).replace(/[^0-9]/g, '').trim();
}

/**
 * Returns complete fleet metadata for an active bus vehicle
 * @param {string|number} rawId 
 * @returns {{
 *   vehicleId: string,
 *   propulsion: 'electric' | 'hybrid' | 'diesel',
 *   isElectric: boolean,
 *   isHybrid: boolean,
 *   badgeText: string,
 *   badgeIcon: string,
 *   badgeClass: string,
 *   modelName: string,
 *   isAccessible: boolean,
 *   hasAirConditioning: boolean,
 *   emissionStandard: string
 * }}
 */
function getVehicleFleetInfo(rawId) {
  const normId = normalizeVehicleId(rawId);
  const numId = parseInt(normId, 10);

  let propulsion = 'diesel';
  let isElectric = false;
  let isHybrid = false;
  let modelName = 'Mercedes Citaro Euro-6';
  let badgeText = 'Euro 6 Dièsel';
  let badgeIcon = '🚌';
  let badgeClass = 'fleet-diesel';

  if (ELECTRIC_VEHICLE_IDS.has(normId) || (numId >= 101 && numId <= 112) || (numId >= 1 && numId <= 10)) {
    propulsion = 'electric';
    isElectric = true;
    modelName = (numId <= 105 && numId >= 101) ? 'Solaris Urbino Electric' : 'Karsan e-ATA 100% Elèctric';
    badgeText = '100% Elèctric';
    badgeIcon = '⚡';
    badgeClass = 'fleet-electric';
  } else if (HYBRID_VEHICLE_IDS.has(normId) || (numId >= 113 && numId <= 130) || (numId >= 11 && numId <= 20) || (numId >= 201 && numId <= 220)) {
    propulsion = 'hybrid';
    isHybrid = true;
    modelName = 'Iveco Urbanway Hybrid';
    badgeText = 'Híbrid Eco';
    badgeIcon = '🌱';
    badgeClass = 'fleet-hybrid';
  }

  return {
    vehicleId: String(rawId || normId),
    propulsion,
    isElectric,
    isHybrid,
    badgeText,
    badgeIcon,
    badgeClass,
    propulsionBadge: `${badgeIcon} ${badgeText}`,
    modelName,
    isAccessible: true, // 100% of Mataró Bus fleet is low-floor PMR accessible
    hasAirConditioning: true,
    emissionStandard: isElectric ? 'Zero Emissions' : (isHybrid ? 'Euro 6d Hybrid' : 'Euro 6')
  };
}

module.exports = {
  getVehicleFleetInfo,
  normalizeVehicleId,
  ELECTRIC_VEHICLE_IDS,
  HYBRID_VEHICLE_IDS
};

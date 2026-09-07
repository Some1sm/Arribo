/**
 * Mataró Bus Fleet Database
 * Maps vehicle IDs and fleet series to propulsion technology, eco badges, and accessibility.
 * 
 * Fleet reality:
 * - Mataró Bus Urbà (CTSA / Avanza) operates NO 100% electric buses in active commercial service.
 * - Fleet consists of Eco Hybrids (Iveco Urbanway Hybrid / MAN Lion's City Hybrid, introduced 2019-2021)
 *   and Diesel buses (Mercedes-Benz Citaro C2 / Scania Euro-6, along with legacy reserve units).
 */

// Legacy/placeholder set kept for backwards compatibility (no 100% electric buses in service)
const ELECTRIC_VEHICLE_IDS = new Set();

// Known Eco Hybrid fleet series and specific vehicle IDs
const HYBRID_VEHICLE_IDS = new Set([
  '113', '114', '115', '116', '117', '118', '119',
  '126', '127', '128', '129', '130',
  '11', '12', '13', '14', '15', '16', '17', '18', '19', '20',
  '201', '202', '203', '204', '205', '206', '207', '208', '209', '210',
  '211', '212', '213', '214', '215', '216', '217', '218', '219', '220'
]);

// Known newer Euro-6 diesel vehicles
const EURO6_DIESEL_IDS = new Set([
  '101', '102', '103', '104', '105', '106', '107', '108', '109', '110', '111', '112',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'
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
 *   propulsion: 'hybrid' | 'diesel',
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
  let modelName = 'Autobús Urbà Dièsel';
  let badgeText = 'Autobús Dièsel';
  let badgeIcon = '🚌';
  let badgeClass = 'fleet-diesel';
  let emissionStandard = 'Dièsel Convencional';

  if (HYBRID_VEHICLE_IDS.has(normId) || (numId >= 113 && numId <= 130) || (numId >= 201 && numId <= 220)) {
    propulsion = 'hybrid';
    isHybrid = true;
    modelName = (numId >= 201) ? 'MAN Lion\'s City Hybrid' : 'Iveco Urbanway Hybrid';
    badgeText = 'Híbrid Eco';
    badgeIcon = '🌱';
    badgeClass = 'fleet-hybrid';
    emissionStandard = 'Euro 6d Hybrid';
  } else if (EURO6_DIESEL_IDS.has(normId) || (numId >= 101 && numId <= 112) || (numId >= 1 && numId <= 10)) {
    propulsion = 'diesel';
    modelName = 'Mercedes Citaro C2 / Scania';
    badgeText = 'Dièsel Euro 6';
    badgeIcon = '🚌';
    badgeClass = 'fleet-diesel';
    emissionStandard = 'Euro 6';
  } else {
    // Legacy reserve or unclassified diesel units
    propulsion = 'diesel';
    modelName = 'Autobús Dièsel Convencional';
    badgeText = 'Autobús Dièsel';
    badgeIcon = '🚌';
    badgeClass = 'fleet-diesel';
    emissionStandard = 'Dièsel';
  }

  return {
    vehicleId: String(rawId || normId),
    propulsion,
    isElectric: false, // Mataró Bus has no 100% electric commercial buses
    isHybrid,
    badgeText,
    badgeIcon,
    badgeClass,
    propulsionBadge: `${badgeIcon} ${badgeText}`,
    modelName,
    isAccessible: true, // 100% of Mataró Bus urban fleet is low-floor PMR accessible
    hasAirConditioning: true,
    emissionStandard
  };
}

module.exports = {
  getVehicleFleetInfo,
  normalizeVehicleId,
  ELECTRIC_VEHICLE_IDS,
  HYBRID_VEHICLE_IDS,
  EURO6_DIESEL_IDS
};

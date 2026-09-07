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
// Mataró Bus (CTSA / Avanza) fleet reality:
// - 80% of daily commercial operational fleet consists of Volvo 7900 Hybrid (B5LH Euro 6d)
// - Numbered in the 2600 series: 2668 to 2699 (and 2-digit calcas 68 to 99)
// - Legacy series: 113-130, 201-220
const HYBRID_VEHICLE_IDS = new Set([
  '113', '114', '115', '116', '117', '118', '119',
  '126', '127', '128', '129', '130',
  '11', '12', '13', '14', '15', '16', '17', '18', '19', '20',
  '201', '202', '203', '204', '205', '206', '207', '208', '209', '210',
  '211', '212', '213', '214', '215', '216', '217', '218', '219', '220',
  // Official Avanza Mataró 2600 Series Hybrid Units (Volvo 7900 Hybrid):
  '2668', '2669', '2670', '2671', '2672', '2673', '2674', '2675', '2676', '2677',
  '2678', '2679', '2680', '2681', '2682', '2683', '2684', '2685', '2686', '2687',
  '2688', '2689', '2690', '2691', '2692', '2693', '2694', '2695', '2696', '2697', '2698', '2699',
  // Short 2-digit calcas matching the 2600 series:
  '68', '69', '70', '71', '72', '73', '74', '75', '76', '77',
  '78', '79', '80', '81', '82', '83', '84', '85', '86', '87',
  '88', '89', '90', '91', '92', '93', '94', '95', '96', '97', '98', '99'
]);

// Known Euro-6 diesel vehicles:
// - 2650 to 2667 (and short numbers 50-67): Scania N320UB / Mercedes Citaro C2
const EURO6_DIESEL_IDS = new Set([
  '101', '102', '103', '104', '105', '106', '107', '108', '109', '110', '111', '112',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10',
  // Official Avanza Mataró 2600 Series Euro-6 Diesel Units:
  '2650', '2651', '2652', '2653', '2654', '2655', '2656', '2657', '2658', '2659',
  '2660', '2661', '2662', '2663', '2664', '2665', '2666', '2667',
  // Short 2-digit calcas:
  '50', '51', '52', '53', '54', '55', '56', '57', '58', '59',
  '60', '61', '62', '63', '64', '65', '66', '67'
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

  if (
    HYBRID_VEHICLE_IDS.has(normId) ||
    (numId >= 2668 && numId <= 2699) ||
    (numId >= 68 && numId <= 99) ||
    (numId >= 113 && numId <= 130) ||
    (numId >= 201 && numId <= 220)
  ) {
    propulsion = 'hybrid';
    isHybrid = true;
    modelName = (numId >= 2668 || (numId >= 68 && numId <= 99))
      ? 'Volvo 7900 Hybrid (B5LH)'
      : ((numId >= 201) ? 'MAN Lion\'s City Hybrid' : 'Iveco Urbanway Hybrid');
    badgeText = 'Híbrid Eco';
    badgeIcon = '🌱';
    badgeClass = 'fleet-hybrid';
    emissionStandard = 'Euro 6d Hybrid';
  } else if (
    EURO6_DIESEL_IDS.has(normId) ||
    (numId >= 2650 && numId <= 2667) ||
    (numId >= 50 && numId <= 67) ||
    (numId >= 101 && numId <= 112) ||
    (numId >= 1 && numId <= 10)
  ) {
    propulsion = 'diesel';
    modelName = (numId >= 2666 && numId <= 2667)
      ? 'Scania N320UB Castrosua'
      : 'Mercedes Citaro C2 / Scania';
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

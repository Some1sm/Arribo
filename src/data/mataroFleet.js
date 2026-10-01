/**
 * Mataró Bus fleet: what is known about each bus, and from where.
 *
 * Only sourced facts are stated. The previous version also named models for
 * the non-hybrid buses ("Mercedes Citaro C2 / Scania", "Scania N320UB
 * Castrosua"), invented legacy series (1-20, 101-130, 201-220 as MAN/Iveco
 * hybrids, two-digit "calcas") and claimed air conditioning; none of it had a
 * source, and its own header contradicted its list. A rider sees these chips
 * on the map, so an unknown is left out, not guessed.
 *
 * Sources:
 *  - Ajuntament de Mataró, 5 Jul 2024 ("El 80 % de la flota operativa de
 *    Mataró Bus ja és híbrida..."): 20 of 30 buses are hybrid, 12 m Volvo
 *    7900 H, Euro VI.
 *  - Mataró Bus fleet page (mataro.avanzagrupo.com/ca/informacio/flota):
 *    33 buses, about 61 % hybrid (20), all accessible with a ramp.
 *  - The live feed: the hybrids are fleet numbers 2668-2687 (20 numbers; 2683
 *    is filmed as a Volvo 7900 Hybrid on L2 in 2023), the other buses 2650-2667.
 *
 * Not known, so not stated: the make, model and propulsion of buses 2650-2667,
 * air conditioning, and anything about a number outside these ranges.
 */

// Hybrid fleet numbers (Volvo 7900 Hybrid, Euro VI).
const HYBRID_FIRST = 2668;
const HYBRID_LAST = 2687;
const HYBRID_VEHICLE_IDS = new Set(
  Array.from({ length: HYBRID_LAST - HYBRID_FIRST + 1 }, (_, i) => String(HYBRID_FIRST + i))
);
// Kept for API compatibility: Mataró Bus runs no fully electric bus.
const ELECTRIC_VEHICLE_IDS = new Set();

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
 * Fleet facts for a bus. Unknown facts are null and the UI shows nothing for them.
 * @param {string|number} rawId
 * @returns {{
 *   vehicleId: string,
 *   propulsion: 'hybrid' | null,
 *   isElectric: boolean,
 *   isHybrid: boolean,
 *   badgeText: string|null,
 *   badgeIcon: string|null,
 *   badgeClass: string|null,
 *   propulsionBadge: string|null,
 *   modelName: string|null,
 *   isAccessible: boolean,
 *   hasAirConditioning: null,
 *   emissionStandard: string|null
 * }}
 */
function getVehicleFleetInfo(rawId) {
  const normId = normalizeVehicleId(rawId);
  const isHybrid = HYBRID_VEHICLE_IDS.has(normId);
  return {
    vehicleId: String(rawId || normId),
    propulsion: isHybrid ? 'hybrid' : null,
    isElectric: false,
    isHybrid,
    badgeText: isHybrid ? 'Híbrid Eco' : null,
    badgeIcon: isHybrid ? '🌱' : null,
    badgeClass: isHybrid ? 'fleet-hybrid' : null,
    propulsionBadge: isHybrid ? '🌱 Híbrid Eco' : null,
    modelName: isHybrid ? 'Volvo 7900 Hybrid' : null,
    // The operator states every bus is accessible with a ramp.
    isAccessible: true,
    hasAirConditioning: null,
    emissionStandard: isHybrid ? 'Euro VI' : null
  };
}

module.exports = {
  getVehicleFleetInfo,
  normalizeVehicleId,
  ELECTRIC_VEHICLE_IDS,
  HYBRID_VEHICLE_IDS
};

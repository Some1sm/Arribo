/**
 * Saved and recent journeys for the Arribo! planner (window.TransitJourneys).
 * Device-local only; never stores live departure predictions.
 */
(function (global) {
  'use strict';

  const SAVED_KEY = 'saved_journeys';
  const RECENT_KEY = 'recent_searches';
  const SAVED_LIMIT = 20;
  const RECENT_LIMIT = 10;

  function store() { return global.TransitStore; }

  function normalizeEndpoint(endpoint) {
    if (!endpoint || typeof endpoint !== 'object') return null;
    const lat = endpoint.lat == null || endpoint.lat === '' ? NaN : Number(endpoint.lat);
    const lon = endpoint.lon == null || endpoint.lon === '' ? NaN : Number(endpoint.lon);
    return {
      query: String(endpoint.query || '').slice(0, 120),
      stopId: endpoint.stopId ? String(endpoint.stopId).slice(0, 24) : null,
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
      name: String(endpoint.name || endpoint.query || '').slice(0, 120)
    };
  }

  function walkingSettings(options = {}) {
    const speed = Number(options.walkingSpeed), distance = Number(options.maxWalkingDistance);
    return {
      walkingSpeed: Number.isFinite(speed) && speed >= 30 && speed <= 120 ? speed : 80,
      maxWalkingDistance: Number.isFinite(distance) && distance >= 50 && distance <= 5000 ? distance : 2000
    };
  }

  function identity(saved) {
    return [saved.from.query, saved.to.query, saved.from.stopId || (saved.from.lat ?? ''), saved.to.stopId || (saved.to.lat ?? '')].join('>');
  }

  function sameEndpoint(a, b) {
    return a.query === b.query && (a.stopId || null) === (b.stopId || null) && (a.lat ?? null) === (b.lat ?? null) && (a.lon ?? null) === (b.lon ?? null);
  }

  const TransitJourneys = {
    SAVED_LIMIT,
    RECENT_LIMIT,

    listSaved() { return store().read(SAVED_KEY, [], entry => entry.from && entry.to && normalizeEndpoint(entry.from) && normalizeEndpoint(entry.to), SAVED_LIMIT); },

    save(from, to, label, options = {}) {
      const entry = {
        id: `j_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        from: normalizeEndpoint(from),
        to: normalizeEndpoint(to),
        label: String(label || `${from.name || from.query} → ${to.name || to.query}`).slice(0, 80),
        preference: ['fastest', 'least_walking', 'direct_only'].includes(options.preference) ? options.preference : 'fastest',
        departureDate: typeof options.departureDate === 'string' ? options.departureDate.slice(0, 10) : null,
        departureTime: typeof options.departureTime === 'string' ? options.departureTime.slice(0, 5) : null,
        ...walkingSettings(options),
        usedAt: Date.now(),
        savedAt: Date.now()
      };
      if (!entry.from || !entry.to) return null;
      const list = this.listSaved().filter(saved => !sameEndpoint(saved.from, entry.from) || !sameEndpoint(saved.to, entry.to));
      return store().write(SAVED_KEY, [entry, ...list], SAVED_LIMIT)[0];
    },

    remove(id) {
      if (typeof id !== 'string') return;
      store().write(SAVED_KEY, this.listSaved().filter(entry => entry.id !== id), SAVED_LIMIT);
    },

    rename(id, label) {
      const clean = String(label || '').trim().slice(0, 80);
      if (!clean) return;
      store().write(SAVED_KEY, this.listSaved().map(entry => entry.id === id ? { ...entry, label: clean } : entry), SAVED_LIMIT);
    },

    clearSaved() { store().write(SAVED_KEY, [], SAVED_LIMIT); },

    addRecent(from, to, preference, options = {}) {
      const entry = {
        id: `r_${Date.now().toString(36)}`,
        from: normalizeEndpoint(from),
        to: normalizeEndpoint(to),
        preference: ['fastest', 'least_walking', 'direct_only'].includes(preference) ? preference : 'fastest',
        ...walkingSettings(options),
        usedAt: Date.now()
      };
      if (!entry.from || !entry.to) return;
      const rest = this.listRecent().filter(saved => !sameEndpoint(saved.from, entry.from) || !sameEndpoint(saved.to, entry.to));
      store().write(RECENT_KEY, [entry, ...rest], RECENT_LIMIT);
    },

    listRecent() { return store().read(RECENT_KEY, [], entry => entry.from && entry.to && normalizeEndpoint(entry.from) && normalizeEndpoint(entry.to), RECENT_LIMIT); },

    clearRecent() { store().write(RECENT_KEY, [], RECENT_LIMIT); },

    clearAll() { this.clearSaved(); this.clearRecent(); },

    identity
  };

  global.TransitJourneys = Object.freeze(TransitJourneys);
})(typeof window !== 'undefined' ? window : globalThis);

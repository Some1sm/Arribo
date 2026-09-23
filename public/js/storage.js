/**
 * Safe versioned localStorage wrapper for Arribo! (window.TransitStore).
 * Never throws on disabled/broken storage; validates and bounds entries.
 */
(function (global) {
  'use strict';

  const PREFIX = 'arribo_store_v1:';

  function available() {
    try {
      const probe = `${PREFIX}__probe`;
      global.localStorage.setItem(probe, '1');
      global.localStorage.removeItem(probe);
      return true;
    } catch { return false; }
  }

  const memory = new Map();
  const usable = available();

  function readRaw(key) {
    if (memory.has(key)) return memory.get(key);
    if (!usable) return null;
    try { return global.localStorage.getItem(PREFIX + key); } catch { return null; }
  }

  function writeRaw(key, value) {
    if (!usable) { memory.set(key, value); return; }
    try { global.localStorage.setItem(PREFIX + key, value); } catch { memory.set(key, value); }
  }

  function remove(key) {
    memory.delete(key);
    if (!usable) return;
    try { global.localStorage.removeItem(PREFIX + key); } catch {}
  }

  function read(key, fallback, validate, maxEntries = 50) {
    let parsed;
    try { parsed = JSON.parse(readRaw(key) || 'null'); } catch { parsed = null; }
    if (!Array.isArray(parsed)) return fallback;
    const valid = parsed.filter(entry => {
      if (typeof entry !== 'object' || entry === null || typeof entry.id !== 'string' || !entry.id) return false;
      try { return validate ? validate(entry) !== false : true; } catch { return false; }
    });
    return valid.slice(0, maxEntries);
  }

  function write(key, entries, limit = 50) {
    const bounded = entries.slice(0, limit);
    try { writeRaw(key, JSON.stringify(bounded)); } catch {}
    return bounded;
  }

  const TransitStore = { available, read, write, remove };
  global.TransitStore = Object.freeze(TransitStore);
})(typeof window !== 'undefined' ? window : globalThis);

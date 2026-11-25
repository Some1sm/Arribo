(() => {
  'use strict';

  const esc = (v) => (window.TransitUtils ? window.TransitUtils.esc(v) : String(v ?? ''));
  const t = (key, vars, fallback) => (window.ArriboI18n ? window.ArriboI18n.t(key, vars) : (fallback || key));

  let cachedCatalog = null;

  function linkify(text) {
    const safe = esc(text);
    return safe.replace(/https?:\/\/[^\s)]+/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  }

  function realtimeLabel(op) {
    const rt = op?.realtime || (op?.id === 'mataro' ? 'gps' : '');
    switch (rt) {
      case 'gps': return t('sources.tierGps', null, 'GPS en temps real');
      case 'gtfsrt': return t('sources.tierGtfsrt', null, 'GTFS-RT en temps real');
      case 'predictions': return t('sources.tierPred', null, 'Previsions en temps real');
      case 'estimated': return t('sources.tierEst', null, 'Posició estimada');
      case 'unofficial': return t('sources.tierUnofficial', null, 'Temps real (no oficial)');
      default: return t('sources.tierSchedule', null, 'Horari GTFS');
    }
  }

  function render() {
    const grid = document.getElementById('sources-operators-grid');
    const summary = document.getElementById('sources-summary-pill');
    if (!grid || !cachedCatalog) return;

    const ops = Array.isArray(cachedCatalog.operators) ? cachedCatalog.operators : [];
    const lines = Array.isArray(cachedCatalog.lines) ? cachedCatalog.lines : [];
    const counts = new Map();
    for (const l of lines) {
      const id = l?.agencyId || 'mataro';
      counts.set(id, (counts.get(id) || 0) + 1);
    }

    if (summary) {
      summary.textContent = t('sources.summary', { ops: ops.length, lines: lines.length }, `${ops.length} operadors · ${lines.length} línies`);
    }

    if (ops.length === 0) {
      grid.innerHTML = `<div class="source-card"><p class="source-card-attribution">${esc(t('sources.empty', null, 'Cap operador actiu.'))}</p></div>`;
      return;
    }

    grid.innerHTML = ops.map((op) => {
      const n = counts.get(op.id) || 0;
      const attr = (typeof op.attribution === 'string' && op.attribution.trim()) || op.name || '';
      const updated = op.dataUpdatedAt ? `<span class="source-card-updated">${esc(t('sources.updated', { date: op.dataUpdatedAt }, `Actualitzat ${op.dataUpdatedAt}`))}</span>` : '';
      const lineBadge = n > 0 ? `<span class="source-card-lines">${esc(t(n === 1 ? 'landing.linesOne' : 'landing.linesMany', { n }, `${n} línies`))}</span>` : '';
      return `
        <article class="source-card">
          <div class="source-card-header">
            <h3 class="source-card-title">${esc(op.name || op.id)}</h3>
            <span class="source-card-tier">${esc(realtimeLabel(op))}</span>
          </div>
          <p class="source-card-attribution">${linkify(attr)}</p>
          <div class="source-card-meta">${lineBadge}${updated}</div>
        </article>`;
    }).join('');
  }

  function initTheme() {
    const saved = window.TransitUtils?.getSavedTheme?.() || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    const btn = document.getElementById('btn-page-theme-toggle');
    btn?.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      const next = cur === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      window.TransitUtils?.saveTheme?.(next);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    fetch('/api/lines')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        cachedCatalog = data;
        render();
        window.TransitUtils?.renderFooterSources?.(data.operators);
      })
      .catch(() => {
        const grid = document.getElementById('sources-operators-grid');
        if (grid) grid.innerHTML = `<div class="source-card"><p class="source-card-attribution">${esc(t('sources.loadError', null, 'No s’han pogut carregar les fonts de dades.'))}</p></div>`;
      });
  });

  document.addEventListener('arribo:lang', render);
})();

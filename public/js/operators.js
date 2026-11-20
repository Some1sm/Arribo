/* Dades: per-operator punctuality for trains (Rodalies, FGC).
 * Reads /api/analytics/operators. Hidden while no train data is collected
 * (the GTFS-RT pollers are opt-in), so Mataró-only deployments look as before.
 * Classes and design tokens only: no inline styles (design_system_test). */
(function () {
  'use strict';
  const esc = (window.TransitUtils && window.TransitUtils.esc) || (s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const section = document.getElementById('operators-section');
  const body = document.getElementById('operators-body');
  const updated = document.getElementById('operators-updated');
  if (!section || !body) return;

  let hours = 24;
  let loadSeq = 0;
  let lastOps = [];

  // Network scope: 'all', 'mataro' (the bus reports) or a train operator's
  // id. Kept in the URL (?xarxa=) so a scoped Dades can be shared.
  const scopeWrap = document.getElementById('dades-scope-wrap');
  const scopeDock = document.getElementById('dades-scope');
  let scope = (() => {
    try { return new URLSearchParams(window.location.search).get('xarxa') || 'all'; } catch { return 'all'; }
  })();

  function applyScope(ops) {
    const ids = ops.map(o => o.id);
    if (scope !== 'all' && scope !== 'mataro' && !ids.includes(scope)) scope = 'all';
    document.body.dataset.dadesScope = scope === 'all' ? 'all' : (scope === 'mataro' ? 'bus' : 'rail');
    if (!scopeDock || !scopeWrap) return;
    const items = [['all', 'Tot'], ['mataro', 'Mataró Bus'], ...ops.map(o => [o.id, o.shortName || o.name])];
    scopeDock.innerHTML = items.map(([v, label]) => {
      const on = v === scope;
      return `<button type="button" class="pill${on ? ' is-active' : ''}" aria-pressed="${on}" data-dades-scope="${esc(v)}">${esc(label)}</button>`;
    }).join('');
    scopeWrap.hidden = false;
  }

  function setScope(v) {
    scope = v;
    try {
      const url = new URL(window.location.href);
      if (v === 'all') url.searchParams.delete('xarxa'); else url.searchParams.set('xarxa', v);
      history.replaceState(null, '', url);
    } catch { /* the scope still applies to this view */ }
    render();
  }

  function render() {
    applyScope(lastOps);
    const shown = scope === 'all' || scope === 'mataro' ? lastOps : lastOps.filter(o => o.id === scope);
    body.innerHTML = shown.map(card).join('');
    if (openLine && !shown.some(o => o.id === openLine.agency)) openLine = null;
    if (openLine && lastLineHtml && lastLineHtml.key === lineKey()) {
      const host = document.getElementById(`op-line-detail-${openLine.agency}`);
      if (host) host.innerHTML = lastLineHtml.html;
    }
  }

  // Line drill-down: one open line at a time, kept across refreshes.
  let openLine = null;
  let lineSeq = 0;
  let lastLineHtml = null; // { key, html }: the open line's last detail, restored on re-render
  const lineKey = () => (openLine ? `${openLine.agency}:${openLine.line}:${hours}` : '');

  function hourStrip(rows, onTimeMax) {
    if (!rows.length) return '';
    const max = Math.max(5, ...rows.map(r => Math.abs(Number(r.avgDelay) || 0)));
    const w = 100 / 24;
    const bars = rows.map(r => {
      const hr = Number(r.hour);
      const d = Number(r.avgDelay) || 0;
      const h = Math.max(2, (Math.abs(d) / max) * 100);
      const cls = d > 15 ? 'op-seg-severe' : d > onTimeMax ? 'op-seg-late' : d < -1 ? 'op-seg-early' : 'op-seg-ontime';
      return `<rect class="op-seg ${cls}" x="${(hr * w + w * 0.15).toFixed(3)}" y="${(100 - h).toFixed(3)}" width="${(w * 0.7).toFixed(3)}" height="${h.toFixed(3)}"><title>${esc(`${r.hour}h: ${fmtMin(r.avgDelay)} de mitjana, ${r.visits} passos`)}</title></rect>`;
    }).join('');
    return `<figure class="op-hours"><svg class="op-hours-svg" role="img" aria-label="Retard mitjà per hora del dia" viewBox="0 0 100 100" preserveAspectRatio="none">${bars}</svg><figcaption><span>0 h</span><span>Retard mitjà per hora</span><span>23 h</span></figcaption></figure>`;
  }

  function lineDetailHtml(d) {
    if (!d.visits) return `<p class="op-empty">${esc(`Encara no hi ha passos de la línia ${d.line} en aquest període.`)}</p>`;
    const rows = d.stations.map(s => `<tr${s.onProfile === false ? ' class="op-off-profile"' : ''}><th scope="row">${esc(s.station)}</th><td class="${delayClass(s.avgDelay)}">${esc(fmtMin(s.avgDelay))}</td><td>${esc(fmtPct(s.onTimePct))}</td><td>${esc(fmtMin(s.maxDelay))}</td><td>${s.visits}</td></tr>`).join('');
    const order = d.stationOrder === 'line' ? "en l'ordre de la línia" : 'de més a menys retard';
    return `<div class="op-line-detail-head"><h5><span class="line-badge" data-line="${esc(`${d.agencyId}:${d.line}`)}">${esc(d.line)}</span> ${esc(`${d.visits} passos`)}</h5><button type="button" class="btn btn-ghost btn-sm" data-op-line-close>Tanca</button></div>
      ${hourStrip(d.byHour || [], d.onTimeMaxMins || 5)}
      <div class="op-table-wrap"><table class="op-table"><caption>${esc(`Per estació (${order})`)}</caption><thead><tr><th scope="col">Estació</th><th scope="col">Retard mitjà</th><th scope="col">Puntualitat</th><th scope="col">Màxim</th><th scope="col">Passos</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  async function loadLine() {
    if (!openLine) return;
    const seq = ++lineSeq;
    const { agency, line } = openLine;
    const host = document.getElementById(`op-line-detail-${agency}`);
    if (host && !host.innerHTML) host.innerHTML = '<p class="op-empty">Carregant…</p>';
    try {
      const res = await fetch(`/api/analytics/operators/line?agency=${encodeURIComponent(agency)}&line=${encodeURIComponent(line)}&hours=${hours}`, { cache: 'no-store' });
      const data = await res.json();
      if (seq !== lineSeq || !openLine || openLine.agency !== agency || openLine.line !== line) return;
      const el = document.getElementById(`op-line-detail-${agency}`);
      if (!el) return;
      el.innerHTML = data.success ? lineDetailHtml(data) : '<p class="op-empty">No s\'ha pogut carregar aquesta línia.</p>';
      if (data.success) lastLineHtml = { key: lineKey(), html: el.innerHTML };
    } catch {
      if (seq !== lineSeq) return;
      const el = document.getElementById(`op-line-detail-${agency}`);
      if (el) el.innerHTML = '<p class="op-empty">No s\'ha pogut carregar aquesta línia.</p>';
    }
  }

  body.addEventListener('click', ev => {
    if (ev.target.closest('[data-op-line-close]')) {
      openLine = null;
      lineSeq++;
      render();
      return;
    }
    const btn = ev.target.closest('[data-op-line]');
    if (!btn) return;
    const next = { agency: btn.dataset.opAgency, line: btn.dataset.opLine };
    openLine = openLine && openLine.agency === next.agency && openLine.line === next.line ? null : next;
    render();
    loadLine();
  });

  scopeDock?.addEventListener('click', ev => {
    const btn = ev.target.closest('[data-dades-scope]');
    if (btn) setScope(btn.dataset.dadesScope);
  });

  const fmtMin = v => (v === null || v === undefined) ? '—' : `${v > 0 ? '+' : ''}${String(v).replace('.', ',')} min`;
  const fmtPct = v => (v === null || v === undefined) ? '—' : `${String(v).replace('.', ',')} %`;
  const delayClass = v => v === null || v === undefined ? '' : v > 15 ? 'op-severe' : v > 5 ? 'op-late' : v < -1 ? 'op-early' : 'op-ontime';
  // KpiTile verdict modifiers: only for figures that are themselves a verdict.
  const delayVerdict = v => v === null || v === undefined ? '' : v > 15 ? ' is-bad' : v > 5 ? ' is-warn' : v >= -1 ? ' is-good' : '';

  // Stacked bar of the delay buckets as SVG (widths are attributes, not styles).
  function bucketBar(op) {
    const b = op.buckets || {};
    const parts = [
      ['early', b.early, 'Avançat (> 1 min)'],
      ['ontime', b.onTime, `Puntual (≤ ${op.onTimeMaxMins} min)`],
      ['late', b.late15, `${op.onTimeMaxMins + 1}–15 min`],
      ['late30', b.late30, '16–30 min'],
      ['late60', b.late60, '31–60 min'],
      ['severe', b.lateOver60, '> 60 min']
    ];
    const total = parts.reduce((n, p) => n + (p[1] || 0), 0);
    if (!total) return '';
    let x = 0;
    const rects = parts.filter(p => p[1] > 0).map(([cls, n, label]) => {
      const w = (n / total) * 100;
      const r = `<rect class="op-seg op-seg-${cls}" x="${x.toFixed(3)}%" y="0" width="${w.toFixed(3)}%" height="100%"><title>${esc(label)}: ${n}</title></rect>`;
      x += w;
      return r;
    }).join('');
    const legend = parts.map(([cls, n, label]) => `<li><span class="op-dot op-seg-${cls}" aria-hidden="true"></span>${esc(label)} <strong>${Math.round(((n || 0) / total) * 100)} %</strong></li>`).join('');
    return `<svg class="op-bar" role="img" aria-label="Distribució dels retards" preserveAspectRatio="none" viewBox="0 0 100 10">${rects}</svg><ul class="op-legend">${legend}</ul>`;
  }

  function feedLine(op) {
    const f = op.feed;
    if (!f) return '<p class="op-feed"><span class="chip chip-estimated">Recollida en directe aturada: es mostren les dades ja registrades.</span></p>';
    const bits = [];
    if (f.vehiclesNow !== undefined) bits.push(`${f.vehiclesNow} trens en directe`);
    if (f.fetchAgeSec !== undefined) bits.push(`dades de fa ${f.fetchAgeSec} s`);
    const err = f.vehiclesError || f.tripUpdatesError;
    const chip = err
      ? `<span class="chip chip-danger">${esc(bits.concat(`Error del canal: ${err}`).join(' · '))}</span>`
      : `<span class="chip chip-live">${esc(bits.join(' · ') || 'Canal en directe')}</span>`;
    const dropped = f.implausibleDropped ? ` <span class="op-muted">${esc(`${f.implausibleDropped} valors impossibles descartats des de l'arrencada`)}</span>` : '';
    return `<p class="op-feed">${chip}${dropped}</p>`;
  }

  function linesTable(op) {
    if (!op.lines || !op.lines.length) return '';
    const rows = op.lines.map(l => `<tr><th scope="row"><button type="button" class="op-line-btn" data-op-agency="${esc(op.id)}" data-op-line="${esc(l.line)}" aria-expanded="${openLine && openLine.agency === op.id && openLine.line === l.line}" title="Detall de la línia ${esc(l.line)}"><span class="line-badge" data-line="${esc(`${op.id}:${l.line}`)}">${esc(l.line)}</span></button></th><td class="${delayClass(l.avgDelay)}">${esc(fmtMin(l.avgDelay))}</td><td>${esc(fmtPct(l.onTimePct))}</td><td>${esc(fmtMin(l.maxDelay))}</td><td>${l.visits}</td></tr>`).join('');
    return `<div class="op-table-wrap"><table class="op-table"><caption>Per línia (de més a menys retard mitjà; toca una línia per veure-la per estació i per hora)</caption><thead><tr><th scope="col">Línia</th><th scope="col">Retard mitjà</th><th scope="col">Puntualitat</th><th scope="col">Màxim</th><th scope="col">Passos</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function stationsList(op) {
    if (!op.worstStations || !op.worstStations.length) return '';
    const items = op.worstStations.map(s => `<li><span class="op-station">${esc(s.station)}</span><span class="${delayClass(s.avgDelay)}">${esc(fmtMin(s.avgDelay))}</span><span class="op-muted">${s.visits} passos</span></li>`).join('');
    return `<div class="op-stations"><h4>Estacions amb més retard</h4><ol>${items}</ol></div>`;
  }

  function card(op) {
    const empty = !op.visits;
    return `<article class="card-inset op-operator" aria-labelledby="op-${esc(op.id)}">
      <header class="op-card-head">
        <h4 id="op-${esc(op.id)}" class="op-name">${esc(op.name)}</h4>
        <span class="chip chip-scheduled" title="${esc(op.source)}">Previsió en temps real de l'operador</span>
      </header>
      ${empty ? '<p class="op-empty">Encara no hi ha passos registrats en aquest període.</p>' : `
      <div class="op-kpis">
        <div class="kpi"><span class="kpi-label">Puntualitat (≤ ${op.onTimeMaxMins} min)</span><span class="kpi-value">${esc(fmtPct(op.onTimePct))}</span></div>
        <div class="kpi"><span class="kpi-label">Retard mitjà</span><span class="kpi-value${delayVerdict(op.avgDelay)}">${esc(fmtMin(op.avgDelay))}</span></div>
        <div class="kpi"><span class="kpi-label">Retard màxim</span><span class="kpi-value">${esc(fmtMin(op.maxDelay))}</span></div>
        <div class="kpi"><span class="kpi-label">Passos per estació</span><span class="kpi-value">${op.visits}</span></div>
        <div class="kpi"><span class="kpi-label">Trens</span><span class="kpi-value">${op.trips}</span></div>
      </div>
      ${bucketBar(op)}
      ${linesTable(op)}
      <div class="op-line-detail" id="op-line-detail-${esc(op.id)}" aria-live="polite"></div>
      ${stationsList(op)}`}
      <details class="op-source"><summary>D'on surt aquest retard?</summary><p>${esc(op.source)}</p></details>
      ${feedLine(op)}
    </article>`;
  }

  async function load() {
    const seq = ++loadSeq;
    try {
      const res = await fetch(`/api/analytics/operators?hours=${hours}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (seq !== loadSeq) return;
      const ops = Array.isArray(data.operators) ? data.operators : [];
      const active = ops.some(o => o.visits > 0 || o.feed);
      section.hidden = !active;
      if (!active) {
        if (scopeWrap) scopeWrap.hidden = true;
        delete document.body.dataset.dadesScope;
        return;
      }
      lastOps = ops;
      render();
      loadLine();
      if (updated) updated.textContent = new Date(data.generatedAt || Date.now()).toLocaleTimeString('ca-ES', { hour: '2-digit', minute: '2-digit' });
    } catch {
      if (seq !== loadSeq) return;
      if (!section.hidden) body.innerHTML = '<p class="op-empty">No s\'han pogut carregar les dades dels trens.</p>';
    }
  }

  section.addEventListener('click', ev => {
    const btn = ev.target.closest('[data-op-hours]');
    if (!btn) return;
    hours = Number(btn.dataset.opHours) || 24;
    section.querySelectorAll('[data-op-hours]').forEach(b => {
      const on = b === btn;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    load();
  });

  // Line colours (GTFS route_color / route_text_color) for the badges, from the catalog.
  fetch('/api/lines').then(r => (r.ok ? r.json() : null)).then(j => {
    if (j && Array.isArray(j.lines)) window.TransitUtils?.applyLineColors?.(j.lines);
  }).catch(() => {});

  load();
  setInterval(() => { if (!document.hidden) load(); }, 120000);
})();

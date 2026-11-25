/* Dades: per-operator punctuality for trains (Rodalies, FGC).
 * Reads /api/analytics/operators. Hidden while no train data is collected
 * (the GTFS-RT pollers are opt-in), so Mataró-only deployments look as before.
 * Classes and design tokens only: no inline styles (design_system_test). */
(function () {
  'use strict';
  const esc = (window.TransitUtils && window.TransitUtils.esc) || (s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const t = (key, vars) => (window.ArriboI18n ? window.ArriboI18n.t(key, vars) : key);
  const list = xs => (window.ArriboI18n ? window.ArriboI18n.list(xs) : (xs.length <= 1 ? (xs[0] || '') : `${xs.slice(0, -1).join(', ')} i ${xs[xs.length - 1]}`));
  const lang = () => (window.ArriboI18n ? window.ArriboI18n.lang : 'ca');
  const locale = () => (lang() === 'en' ? 'en-GB' : (lang() === 'es' ? 'es-ES' : 'ca-ES'));
  const dec = v => (lang() === 'en' ? String(v) : String(v).replace('.', ','));

  const section = document.getElementById('operators-section');
  const body = document.getElementById('operators-body');
  const updated = document.getElementById('operators-updated');
  if (!section || !body) return;

  let hours = 24;
  let loadSeq = 0;
  let lastOps = [];
  let lastGeneratedAt = null;

  // Network scope: 'all', 'mataro' (the bus reports) or a train operator's
  // id. Kept in the URL (?xarxa=) so a scoped Dades can be shared.
  const scopeWrap = document.getElementById('dades-scope-wrap');
  const scopeDock = document.getElementById('dades-scope');
  let announcedScope = null; // the scope id last announced to the report (arribo:scope)
  let scope = (() => {
    try { return new URLSearchParams(window.location.search).get('xarxa') || 'all'; } catch { return 'all'; }
  })();

  // Moventis (/api/moventis): followed when enabled; its own Dades scope
  // ("est": estimated buses, no delays yet).
  let movEnabled = false;
  let opsLoaded = false; // the train operators' answer has arrived (applyScope then knows every id)
  fetch('/api/moventis').then(r => (r.ok ? r.json() : null)).then(j => {
    movEnabled = Boolean(j && j.enabled);
    // Not before the train operators are known: an early call would drop a
    // train scope asked for in the URL (?xarxa=fgc).
    if (movEnabled && opsLoaded) {
      if (lastOps.length) render();
      else applyScope([]);
    }
  }).catch(() => {});

  function applyScope(ops) {
    const ids = ops.map(o => o.id).concat(movEnabled ? ['moventis'] : []);
    if (scope !== 'all' && scope !== 'mataro' && !ids.includes(scope)) scope = 'all';
    const nextDadesScope = scope === 'all' ? 'all' : (scope === 'mataro' ? 'bus' : (scope === 'moventis' ? 'est' : 'rail'));
    const prevDadesScope = document.body.dataset.dadesScope;
    document.body.dataset.dadesScope = nextDadesScope;
    // Also between two train operators: the report shows the one chosen.
    if (prevDadesScope !== nextDadesScope || announcedScope !== scope) {
      announcedScope = scope;
      document.dispatchEvent(new CustomEvent('arribo:scope', { detail: { scope, dadesScope: nextDadesScope } }));
    }
    if (!scopeDock || !scopeWrap) return;
    const items = [['all', t('ops.scopeAll')], ['mataro', 'Mataró Bus'], ...ops.map(o => [o.id, o.shortName || o.name]), ...(movEnabled ? [['moventis', 'Moventis']] : [])];
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

  const TIER_CHIPS = {
    measured: 'chip-live',
    predicted: 'chip-estimated',
    timetable: 'chip-scheduled'
  };
  const KNOWN_METHODS = new Set(['gps', 'operator_delay', 'operator_prediction']);

  function tierBadge(tier, title) {
    const mod = TIER_CHIPS[tier];
    if (!mod) return '';
    const tip = title ? ` title="${esc(title)}"` : '';
    return `<span class="chip chip-plain ${mod}" data-tier="${esc(tier)}"${tip}>${esc(t(`tier.${tier}`))}</span>`;
  }

  function methodLine(method) {
    if (!KNOWN_METHODS.has(method)) return '';
    return `<p class="op-method" data-method="${esc(method)}">${esc(t(`tier.method.${method}`))}</p>`;
  }

  function renderTierGroup(tier, ops, headingKey, noteKey) {
    if (!ops.length) return '';
    const headingId = `op-tier-heading-${tier}`;
    return `<section class="op-tier-group" data-tier-group="${esc(tier)}" aria-labelledby="${headingId}">
      <header class="op-tier-group-head">
        <h4 id="${headingId}" class="op-tier-group-title">${esc(t(headingKey))}</h4>
        ${tierBadge(tier)}
      </header>
      ${noteKey ? `<p class="op-tier-group-note">${esc(t(noteKey))}</p>` : ''}
      <div class="op-grid">${ops.map(card).join('')}</div>
    </section>`;
  }

  function render() {
    applyScope(lastOps);
    const shown = scope === 'all' || scope === 'mataro' ? lastOps : lastOps.filter(o => o.id === scope);
    const predicted = shown.filter(o => o.tier === 'predicted');
    const timetable = shown.filter(o => o.tier === 'timetable');
    const measured = shown.filter(o => o.tier !== 'predicted' && o.tier !== 'timetable');
    const needsGrouping = predicted.length > 0 || (timetable.length > 0 && measured.length > 0);
    body.classList.toggle('op-grid-grouped', needsGrouping);
    if (needsGrouping) {
      body.innerHTML = [
        renderTierGroup('measured', measured, 'tier.groupMeasured', ''),
        renderTierGroup('predicted', predicted, 'tier.groupPredicted', 'tier.predictedNote'),
        renderTierGroup('timetable', timetable, 'tier.groupTimetable', '')
      ].join('');
    } else {
      body.innerHTML = shown.map(card).join('');
    }
    if (openLine && !shown.some(o => o.id === openLine.agency && o.tier !== 'timetable')) openLine = null;
    if (openLine && lastLineData && lastLineData.key === lineKey()) {
      const host = document.getElementById(`op-line-detail-${openLine.agency}`);
      if (host) host.innerHTML = lineDetailHtml(lastLineData.data);
    }
    applyBarHeights(body);
    loadTrends();
  }

  // Daily trend (the history kept beyond the 30-day raw retention,
  // /api/analytics/operators/history): one chart per operator card and one
  // for the open line. Days without data are drawn as gaps, never as zero.
  let trendDays = 30;
  const trendData = new Map(); // "<agency>:<line>:<days>" -> { at, data }
  const trendPending = new Set();
  const trendFailed = new Set(); // keys whose last load failed (retried on the next refresh)
  const TREND_TTL_MS = 5 * 60 * 1000;
  const trendKey = (agency, line) => `${agency}:${line || ''}:${trendDays}`;

  function dayList(from, to) {
    const out = [];
    const d = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    for (let i = 0; d <= end && i < 400; i++) {
      out.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  }

  const fmtDay = iso => new Date(`${iso}T12:00:00Z`).toLocaleDateString(locale(), { day: 'numeric', month: 'short', timeZone: 'UTC' });

  function trendHtml(d, failed) {
    const pills = [30, 90].map(n => `<button type="button" class="pill${n === trendDays ? ' is-active' : ''}" aria-pressed="${n === trendDays}" data-op-trend-days="${n}">${esc(t('ops.trendDays', { n }))}</button>`).join('');
    const pillGroup = `<div class="op-trend-pills" role="group" aria-label="${esc(t('ops.trendPeriod'))}">${pills}</div>`;
    const title = t('ops.trendTitle', { max: d ? d.onTimeMaxMins : 5 });
    if (!d || !d.firstDate || !d.total) {
      const msg = !d ? t(failed ? 'ops.loadError' : 'ops.loading') : t('ops.trendEmpty');
      return `<div class="hourly-chart-header"><h5 class="hourly-chart-title">${esc(title)}</h5>${pillGroup}</div><p class="op-empty">${esc(msg)}</p>`;
    }
    const start = d.firstDate > d.from ? d.firstDate : d.from;
    const days = dayList(start, d.to);
    const byDate = new Map((d.daily || []).map(r => [r.date, r]));
    const dense = days.length > 31;
    const dayLabel = (day, i) => {
      const dt = new Date(`${day}T12:00:00Z`);
      if (day === d.to) return t('ops.trendToday');
      if (dense && dt.getUTCDay() !== 1) return ''; // dense: Mondays only
      return i === 0 || dt.getUTCDate() === 1 ? `${dt.getUTCDate()}/${dt.getUTCMonth() + 1}` : String(dt.getUTCDate());
    };
    const cols = days.map((day, i) => {
      const r = byDate.get(day);
      if (!r) return { tone: 'none', h: 4, val: '—', label: dayLabel(day, i), tip: t('ops.trendNoData', { day: fmtDay(day) }) };
      const pct = Number(r.onTimePct) || 0;
      const tip = t(r.partialReason === 'first_day' ? 'ops.trendTooltipFirst' : (r.partial ? 'ops.trendTooltipPartial' : 'ops.trendTooltip'), { day: fmtDay(day), pct: fmtPct(r.onTimePct), avg: fmtMin(r.avgDelay), visits: r.visits })
        + (typeof r.cancelled === 'number' ? ` · ${t('ops.trendCancelled', { n: r.cancelled })}` : '');
      return { tone: pct >= 90 ? 'good' : pct >= 75 ? 'mid' : 'bad', partial: r.partial, h: Math.max(6, pct), val: `${Math.round(pct)}%`, label: dayLabel(day, i), tip };
    });
    const tot = d.total;
    const summary = t('ops.trendSummary', { pct: fmtPct(tot.onTimePct), avg: fmtMin(tot.avgDelay), days: tot.daysWithData, visits: tot.visits })
      + (typeof tot.cancelled === 'number' ? ` · ${t('ops.trendSummaryCancelled', { n: tot.cancelled })}` : '');
    const notes = [];
    if (d.firstDate > d.from) notes.push(t('ops.trendSince', { day: fmtDay(d.firstDate) }));
    // Cancellations were collected later than visits: said, so earlier days are not read as none.
    if (d.cancellationsSince && d.cancellationsSince > start) notes.push(t('ops.trendCancelSince', { day: fmtDay(d.cancellationsSince) }));
    if (days.some(day => byDate.get(day)?.partial)) notes.push(t('ops.trendPartialNote'));
    const since = notes.length ? `<p class="op-muted op-trend-note">${esc(notes.join(' '))}</p>` : '';
    return columnChart({
      title,
      legend: [['good', t('ops.trendBandGood')], ['mid', t('ops.trendBandMid')], ['bad', t('ops.trendBandBad')], ['none', t('ops.trendBandNone')]],
      cols,
      dense,
      trend: true,
      aria: t('ops.trendAria', { summary }),
      extra: `<div class="op-trend-sub"><p class="op-trend-summary">${esc(summary)}</p>${pillGroup}</div>`
    }) + since;
  }


  function fillTrend(agency, line) {
    const host = document.getElementById(line ? `op-trend-line-${agency}` : `op-trend-${agency}`);
    if (!host || (line && host.dataset.line !== line)) return;
    const hit = trendData.get(trendKey(agency, line));
    host.innerHTML = trendHtml(hit ? hit.data : null, trendFailed.has(trendKey(agency, line)));
    applyBarHeights(host);
  }

  async function loadTrend(agency, line) {
    const key = trendKey(agency, line);
    const hit = trendData.get(key);
    fillTrend(agency, line);
    if ((hit && Date.now() - hit.at < TREND_TTL_MS) || trendPending.has(key)) return;
    trendPending.add(key);
    try {
      const q = `agency=${encodeURIComponent(agency)}${line ? `&line=${encodeURIComponent(line)}` : ''}&days=${trendDays}`;
      const res = await fetch(`/api/analytics/operators/history?${q}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !data || !data.success) throw new Error(`HTTP ${res.status}`);
      trendFailed.delete(key);
      trendData.set(key, { at: Date.now(), data });
      if (trendData.size > 40) trendData.delete(trendData.keys().next().value);
    } catch {
      // A stale chart stays as it was; one never loaded says it failed.
      if (!trendData.has(key)) trendFailed.add(key);
    }
    trendPending.delete(key);
    if (key === trendKey(agency, line)) fillTrend(agency, line);
  }

  function loadTrends() {
    const shown = scope === 'all' || scope === 'mataro' ? lastOps : lastOps.filter(o => o.id === scope);
    shown.filter(o => o.tier !== 'timetable' && o.hasHistory !== false).forEach(o => loadTrend(o.id, ''));
    if (openLine) {
      const op = lastOps.find(o => o.id === openLine.agency);
      if (!op || op.hasHistory !== false) loadTrend(openLine.agency, openLine.line);
    }
  }

  // Line drill-down: one open line at a time, kept across refreshes.
  let openLine = null;
  let lineSeq = 0;
  let lastLineData = null; // { key, data }: the open line's last payload, re-rendered on scope or language change
  const lineKey = () => (openLine ? `${openLine.agency}:${openLine.line}:${hours}` : '');

  // Column chart in the component Mataró's hourly delay chart uses
  // (.hourly-chart-*: value above each bar, label under it, gradient fill),
  // so the train charts read like the bus ones. Colours are classes
  // (op-fill-good / mid / bad / none) and heights are set after rendering
  // from data-bar-h (applyBarHeights): no inline style attributes.
  function columnChart({ title, legend, cols, aria, dense, extra, trend }) {
    const legendHtml = legend.map(([tone, label]) => `<div class="hourly-legend-item"><span class="hourly-legend-dot op-fill-${tone}" aria-hidden="true"></span><span>${esc(label)}</span></div>`).join('');
    const colsHtml = cols.map(c => `<div class="hourly-bar-col" title="${esc(c.tip)}"><div class="hourly-bar-track"><span class="hourly-bar-val">${esc(c.val)}</span><div class="hourly-bar-fill op-fill-${c.tone}${c.partial ? ' is-partial' : ''}" data-bar-h="${Math.round(c.h)}"></div></div><span class="hourly-bar-label">${esc(c.label)}</span></div>`).join('');
    return `<div class="hourly-chart-header"><h5 class="hourly-chart-title">${esc(title)}</h5><div class="hourly-chart-legend">${legendHtml}</div></div>
      ${extra || ''}
      <div class="hourly-chart-container op-chart${dense ? ' is-dense' : ''}${trend ? ' is-trend' : ''}" role="img" aria-label="${esc(aria)}">${colsHtml}</div>`;
  }

  function applyBarHeights(root) {
    root?.querySelectorAll('[data-bar-h]').forEach(el => { el.style.height = `${el.dataset.barH}%`; });
  }

  // Average delay by hour of the day for one line. Tones by the hour's
  // average delay: up to 2 min, 2 to the rail on-time bound, beyond it.
  function hourStrip(rows, onTimeMax) {
    if (!rows.length) return '';
    const byHour = new Map(rows.map(r => [Number(r.hour), r]));
    // In service-day order (from 04 h, after-midnight trains last), the
    // span between the first and the last hour with data on that order:
    // the night hours with no trains are not drawn as gaps.
    const serviceOrder = hr => (hr + 20) % 24;
    const ordered = rows.map(r => serviceOrder(Number(r.hour)));
    const first = Math.min(...ordered);
    const last = Math.max(...ordered);
    const max = Math.max(2, ...rows.map(r => Math.abs(Number(r.avgDelay) || 0)));
    const cols = [];
    for (let k = first; k <= last; k++) {
      const hr = (k + 4) % 24;
      const r = byHour.get(hr);
      if (!r) {
        cols.push({ tone: 'none', h: 4, val: '—', label: `${hr}h`, tip: t('ops.hourNoData', { hour: hr }) });
        continue;
      }
      const d = Number(r.avgDelay) || 0;
      const tone = d > onTimeMax ? 'bad' : d > 2 ? 'mid' : 'good';
      cols.push({ tone, h: Math.max(6, (Math.abs(d) / max) * 100), val: `${d > 0 ? '+' : d < 0 ? '−' : ''}${dec(Math.abs(d))}m`, label: `${hr}h`, tip: t('ops.hourTooltip', { hour: hr, avg: fmtMin(r.avgDelay), visits: r.visits }) });
    }
    return columnChart({
      title: t('ops.hourStripCaption'),
      legend: [['good', t('ops.hourBandGood')], ['mid', t('ops.hourBandMid', { max: onTimeMax })], ['bad', t('ops.hourBandBad', { max: onTimeMax })]],
      cols,
      aria: t('ops.hourStripAria')
    });
  }


  function lineDetailHtml(d) {
    if (!d.visits) return `<p class="op-empty">${esc(t('ops.lineEmpty', { line: d.line }))}</p>`;
    const rows = d.stations.map(s => `<tr${s.onProfile === false ? ' class="op-off-profile"' : ''}><th scope="row">${esc(s.station)}</th><td class="${delayClass(s.avgDelay)}">${esc(fmtMin(s.avgDelay))}</td><td>${esc(fmtPct(s.onTimePct))}</td><td>${esc(fmtMin(s.maxDelay))}</td><td>${s.visits}</td></tr>`).join('');
    const order = d.stationOrder === 'line' ? t('ops.orderLine') : t('ops.orderDelay');
    return `<div class="op-line-detail-head"><h5><span class="line-badge" data-line="${esc(`${d.agencyId}:${d.line}`)}">${esc(d.line)}</span> ${esc(t('ops.visitsCount', { n: d.visits }))}</h5><button type="button" class="btn btn-ghost btn-sm" data-op-line-close>${esc(t('ops.close'))}</button></div>
      ${hourStrip(d.byHour || [], d.onTimeMaxMins || 5)}
      <div class="op-trend-block" id="op-trend-line-${esc(d.agencyId)}" data-line="${esc(d.line)}">${trendHtml(trendData.get(trendKey(d.agencyId, d.line))?.data || null)}</div>
      <div class="op-table-wrap"><table class="op-table"><caption>${esc(t('ops.byStationCaption', { order }))}</caption><thead><tr><th scope="col">${esc(t('ops.colStation'))}</th><th scope="col">${esc(t('ops.colAvgDelay'))}</th><th scope="col">${esc(t('ops.colPunctuality'))}</th><th scope="col">${esc(t('ops.colMax'))}</th><th scope="col">${esc(t('ops.colVisits'))}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  async function loadLine() {
    if (!openLine) return;
    const seq = ++lineSeq;
    const { agency, line } = openLine;
    const host = document.getElementById(`op-line-detail-${agency}`);
    if (host && !host.innerHTML) host.innerHTML = `<p class="op-empty">${esc(t('ops.loading'))}</p>`;
    try {
      const res = await fetch(`/api/analytics/operators/line?agency=${encodeURIComponent(agency)}&line=${encodeURIComponent(line)}&hours=${hours}`, { cache: 'no-store' });
      const data = await res.json();
      if (seq !== lineSeq || !openLine || openLine.agency !== agency || openLine.line !== line) return;
      const el = document.getElementById(`op-line-detail-${agency}`);
      if (!el) return;
      el.innerHTML = data.success ? lineDetailHtml(data) : `<p class="op-empty">${esc(t('ops.lineError'))}</p>`;
      applyBarHeights(el);
      if (data.success) {
        lastLineData = { key: lineKey(), data };
        loadTrend(agency, line);
      }
    } catch {
      if (seq !== lineSeq) return;
      const el = document.getElementById(`op-line-detail-${agency}`);
      if (el) el.innerHTML = `<p class="op-empty">${esc(t('ops.lineError'))}</p>`;
    }
  }

  body.addEventListener('click', ev => {
    const days = ev.target.closest('[data-op-trend-days]');
    if (days) {
      trendDays = Number(days.dataset.opTrendDays) === 90 ? 90 : 30;
      loadTrends();
      return;
    }
    if (ev.target.closest('[data-op-line-close]')) {
      openLine = null;
      lastLineData = null;
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

  const fmtMin = v => (v === null || v === undefined) ? '—' : `${v > 0 ? '+' : ''}${dec(v)} min`;
  const fmtPct = v => (v === null || v === undefined) ? '—' : (lang() === 'en' ? `${v}%` : `${dec(v)} %`);
  const delayClass = v => v === null || v === undefined ? '' : v > 15 ? 'op-severe' : v > 5 ? 'op-late' : v < -1 ? 'op-early' : 'op-ontime';
  // KpiTile verdict modifiers: only for figures that are themselves a verdict.
  const delayVerdict = v => v === null || v === undefined ? '' : v > 15 ? ' is-bad' : v > 5 ? ' is-warn' : v >= -1 ? ' is-good' : '';

  // Stacked bar of the delay buckets as SVG (widths are attributes, not styles).
  function bucketBar(op) {
    const b = op.buckets || {};
    const parts = [
      ['early', b.early, t('ops.bucketEarly')],
      ['ontime', b.onTime, t('ops.bucketOnTime', { max: op.onTimeMaxMins })],
      ['late', b.late15, t('ops.bucketLate15', { from: op.onTimeMaxMins + 1 })],
      ['late30', b.late30, t('ops.bucketLate30')],
      ['late60', b.late60, t('ops.bucketLate60')],
      ['severe', b.lateOver60, t('ops.bucketSevere')]
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
    const pctSuffix = lang() === 'en' ? '%' : ' %';
    const legend = parts.map(([cls, n, label]) => `<li><span class="op-dot op-seg-${cls}" aria-hidden="true"></span>${esc(label)} <strong>${Math.round(((n || 0) / total) * 100)}${pctSuffix}</strong></li>`).join('');
    return `<svg class="op-bar" role="img" aria-label="${esc(t('ops.distAria'))}" preserveAspectRatio="none" viewBox="0 0 100 10">${rects}</svg><ul class="op-legend">${legend}</ul>`;
  }

  function feedLine(op) {
    const f = op.feed;
    if (!f) return `<p class="op-feed"><span class="chip chip-estimated">${esc(t('ops.feedPaused'))}</span></p>`;
    const bits = [];
    if (f.vehiclesNow !== undefined) bits.push(t('ops.feedLiveTrains', { n: f.vehiclesNow }));
    if (f.fetchAgeSec !== undefined) bits.push(t('ops.feedAgeSec', { n: f.fetchAgeSec }));
    const err = f.vehiclesError || f.tripUpdatesError;
    const chip = err
      ? `<span class="chip chip-danger">${esc(bits.concat(t('ops.feedError', { err })).join(' · '))}</span>`
      : `<span class="chip chip-live">${esc(bits.join(' · ') || t('ops.feedLive'))}</span>`;
    const dropped = f.implausibleDropped ? ` <span class="op-muted">${esc(t('ops.feedDropped', { n: f.implausibleDropped }))}</span>` : '';
    return `<p class="op-feed">${chip}${dropped}</p>`;
  }

  function linesTable(op) {
    if (!op.lines || !op.lines.length) return '';
    // Cancellations per line, when the server reports them (railcancel.go).
    const hasCancel = op.lines.some(l => typeof l.cancelled === 'number');
    const rows = op.lines.map(l => `<tr><th scope="row"><button type="button" class="op-line-btn" data-op-agency="${esc(op.id)}" data-op-line="${esc(l.line)}" aria-expanded="${openLine && openLine.agency === op.id && openLine.line === l.line}" title="${esc(t('ops.lineDetailTitle', { line: l.line }))}"><span class="line-badge" data-line="${esc(`${op.id}:${l.line}`)}">${esc(l.line)}</span></button></th><td class="${delayClass(l.avgDelay)}">${esc(fmtMin(l.avgDelay))}</td><td>${esc(fmtPct(l.onTimePct))}</td><td>${esc(fmtMin(l.maxDelay))}</td><td>${l.visits}</td>${hasCancel ? `<td class="${l.cancelled > 0 ? 'op-severe' : ''}">${Number(l.cancelled) || 0}</td>` : ''}</tr>`).join('');
    return `<div class="op-table-wrap"><table class="op-table"><caption>${esc(t('ops.linesCaption'))}</caption><thead><tr><th scope="col">${esc(t('ops.colLine'))}</th><th scope="col">${esc(t('ops.colAvgDelay'))}</th><th scope="col">${esc(t('ops.colPunctuality'))}</th><th scope="col">${esc(t('ops.colMax'))}</th><th scope="col">${esc(t('ops.colVisits'))}</th>${hasCancel ? `<th scope="col" title="${esc(t('ops.kpiCancelledTitle'))}">${esc(t('ops.colCancelled'))}</th>` : ''}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function stationsList(op) {
    if (!op.worstStations || !op.worstStations.length) return '';
    const items = op.worstStations.map(s => `<li><span class="op-station">${esc(s.station)}</span><span class="${delayClass(s.avgDelay)}">${esc(fmtMin(s.avgDelay))}</span><span class="op-muted">${esc(t('ops.visitsCount', { n: s.visits }))}</span></li>`).join('');
    return `<div class="op-stations"><h4>${esc(t('ops.worstStationsTitle'))}</h4><ol>${items}</ol></div>`;
  }

  function card(op) {
    const isTimetable = op.tier === 'timetable';
    const empty = !op.visits;
    const badge = tierBadge(op.tier, op.source);
    const method = methodLine(op.method);
    const fallbackChip = badge || isTimetable
      ? ''
      : `<span class="chip chip-scheduled" title="${esc(op.source)}">${esc(t('ops.realtimeForecast'))}</span>`;
    return `<article class="card-inset op-operator" aria-labelledby="op-${esc(op.id)}"${op.tier ? ` data-operator-tier="${esc(op.tier)}"` : ''}>
      <header class="op-card-header">
        <div class="op-card-head">
          <div class="op-head-title">
            <h4 id="op-${esc(op.id)}" class="op-name">${esc(op.name)}</h4>
            ${badge}
          </div>
          ${fallbackChip}
        </div>
        ${method}
      </header>
      ${isTimetable ? `<p class="op-empty" data-tier-empty="timetable">${esc(t('tier.noRealtime'))}</p>` : (empty ? `<p class="op-empty">${esc(t('ops.noVisitsPeriod'))}</p>` : `
      <div class="op-kpis">
        <div class="kpi"><span class="kpi-label">${esc(t('ops.kpiPunctuality', { max: op.onTimeMaxMins }))}</span><span class="kpi-value">${esc(fmtPct(op.onTimePct))}</span></div>
        <div class="kpi"><span class="kpi-label">${esc(t('ops.kpiAvgDelay'))}</span><span class="kpi-value${delayVerdict(op.avgDelay)}">${esc(fmtMin(op.avgDelay))}</span></div>
        <div class="kpi"><span class="kpi-label">${esc(t('ops.kpiMaxDelay'))}</span><span class="kpi-value">${esc(fmtMin(op.maxDelay))}</span></div>
        <div class="kpi"><span class="kpi-label">${esc(t('ops.kpiVisits'))}</span><span class="kpi-value">${op.visits}</span></div>
        <div class="kpi"><span class="kpi-label">${esc(t('ops.kpiTrains'))}</span><span class="kpi-value">${op.trips}</span></div>
        ${typeof op.cancelled === 'number' ? `<div class="kpi" title="${esc(t('ops.kpiCancelledTitle'))}"><span class="kpi-label">${esc(t('ops.kpiCancelled'))}</span><span class="kpi-value${op.cancelled > 0 ? ' is-bad' : ''}">${op.cancelled}</span></div>` : ''}
      </div>
      ${bucketBar(op)}
      <div class="op-trend-block" id="op-trend-${esc(op.id)}">${trendHtml(trendData.get(trendKey(op.id, ''))?.data || null)}</div>
      ${linesTable(op)}
      <div class="op-line-detail" id="op-line-detail-${esc(op.id)}" aria-live="polite"></div>
      ${stationsList(op)}`)}
      ${op.source ? `<details class="op-source"><summary>${esc(t('ops.sourceQuestion'))}</summary><p>${esc(op.source)}</p></details>` : ''}
      ${isTimetable ? '' : feedLine(op)}
    </article>`;
  }

  // Catalog operators (/api/lines), for their short names in the page header.
  let catalogOps = null;

  // With train data the page header names every network shown and says where
  // each figure comes from; without it the static Mataró wording stays.
  function wordHeader(ops) {
    const withData = new Set(ops.filter(o => o.visits > 0 || o.feed || o.tier === 'timetable').map(o => o.id));
    if (!withData.size) return;
    const named = (catalogOps || []).filter(o => o.trackable !== false || withData.has(o.id));
    if (!named.length) return;
    const short = o => o.shortName || o.name;
    const buses = named.filter(o => o.trackable !== false).map(short);
    const trains = named.filter(o => o.trackable === false).map(short);
    const eyebrow = document.getElementById('dades-eyebrow');
    if (eyebrow) eyebrow.textContent = t('ops.headerEyebrow', { ops: named.map(short).join(' · ') });
    const intro = document.getElementById('dades-intro');
    if (intro && trains.length) {
      intro.textContent = t('ops.headerIntro', { buses: list(buses), trains: list(trains) });
    }
    document.title = t('dades.pageTitleMulti');
  }

  function updateTimestamp() {
    if (updated && lastGeneratedAt) {
      updated.textContent = new Date(lastGeneratedAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
    }
  }

  async function load() {
    const seq = ++loadSeq;
    try {
      const res = await fetch(`/api/analytics/operators?hours=${hours}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (seq !== loadSeq) return;
      const ops = Array.isArray(data.operators) ? data.operators : [];
      const active = ops.some(o => o.visits > 0 || o.feed || o.tier === 'timetable');
      opsLoaded = true;
      section.hidden = !active;
      if (!active && movEnabled) {
        // No train data, but Moventis is followed: the scope selector still
        // offers it (the train section stays hidden).
        lastOps = [];
        applyScope([]);
        return;
      }
      if (!active) {
        if (scopeWrap) scopeWrap.hidden = true;
        if (document.body.dataset.dadesScope !== undefined) {
          delete document.body.dataset.dadesScope;
          announcedScope = null;
          document.dispatchEvent(new CustomEvent('arribo:scope', { detail: { scope: 'mataro', dadesScope: '' } }));
        }
        return;
      }
      lastOps = ops;
      lastGeneratedAt = data.generatedAt || Date.now();
      render();
      wordHeader(ops);
      loadLine();
      updateTimestamp();
    } catch {
      if (seq !== loadSeq) return;
      if (!section.hidden) body.innerHTML = `<p class="op-empty">${esc(t('ops.loadError'))}</p>`;
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

  // One period for the whole page: the report toolbar's (24 h, 48 h, 7 days).
  document.addEventListener('arribo:dades-hours', ev => {
    const h = Number(ev.detail?.hours);
    if (![24, 48, 168].includes(h) || h === hours) return;
    hours = h;
    load();
  });

  document.addEventListener('arribo:lang', () => {
    if (!lastOps.length) return;
    render();
    wordHeader(lastOps);
    updateTimestamp();
  });

  // Line colours (GTFS route_color / route_text_color) for the badges, from the catalog.
  fetch('/api/lines').then(r => (r.ok ? r.json() : null)).then(j => {
    if (j && Array.isArray(j.lines)) window.TransitUtils?.applyLineColors?.(j.lines);
    if (j && Array.isArray(j.operators)) { catalogOps = j.operators; if (lastOps.length) wordHeader(lastOps); }
  }).catch(() => {});

  load();
  setInterval(() => { if (!document.hidden) load(); }, 120000);
})();

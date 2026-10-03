/**
 * Arribo! Mataró — Observatori de Retards i Puntualitat
 * Standalone analytics controller managing historical telemetry,
 * peak congestion analysis, school rush profiling, termòmetre, and incident deep-dives.
 */

class ObservatoriApp {
  constructor() {
    this.currentHours = 24;
    this.currentTab = 'journalism'; // 'journalism' | 'termometre' | 'incidents'
    this.filterText = '';
    this.sorts = {
      mostDelayed: { key: 'avgDelay', asc: false },
      worstStops: { key: 'avgDelay', asc: false },
      agencies: { key: 'totalSamples', asc: false }
    };
    this.worstStopsLimit = 10;
    this.groupByLine = false;
    this.stopFilterMode = 'bottlenecks'; // 'bottlenecks' | 'all'
    this.currentReport = null;
    this.termometreData = null;
    this.lastIncidentData = null;
    this._incidentCache = new Map();
    this._currentIncidentLine = 'all';
    this._currentIncidentHours = 168;
    this._currentIncidentMode = 'top';
    this.availableLines = [];

    this.init();
  }

  esc(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  init() {
    this.initTheme();
    this.initUrlState();
    this.bindEvents();
    this.loadActiveTab();
    this.fetchLinesMetadata();
    this.fetchDataHealth();
    this.initGpsGaps();
  }

  initTheme() {
    const savedTheme = localStorage.getItem('arribo_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    const themeBtn = document.getElementById('btn-page-theme-toggle');
    themeBtn?.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('arribo_theme', next);
    });
  }

  initUrlState() {
    const params = new URLSearchParams(window.location.search);
    const h = parseInt(params.get('h') || '', 10);
    if ([24, 48, 168].includes(h)) {
      this.currentHours = h;
    }

    const tab = params.get('tab');
    if (tab === 'termometre' || tab === 'incidents' || tab === 'monthly') {
      this.currentTab = tab;
    }
    const month = params.get('month');
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      this._currentMonthlyMonth = month;
    }

    const q = params.get('q');
    if (q) {
      this.filterText = q;
      const input = document.getElementById('journalism-search-input');
      if (input) input.value = q;
    }

    if (params.get('grouped') === '1') {
      this.groupByLine = true;
    }

    const stopsMode = params.get('stops');
    if (stopsMode === 'all' || stopsMode === 'bottlenecks') {
      this.stopFilterMode = stopsMode;
    }

    // Set initial active tab button UI
    document.querySelectorAll('#journalism-timeframe-tabs button').forEach(btn => {
      btn.classList.remove('active');
      const dataTab = btn.getAttribute('data-tab');
      const dataHours = parseInt(btn.getAttribute('data-hours') || '0', 10);
      if (this.currentTab === 'termometre' && dataTab === 'termometre') {
        btn.classList.add('active');
      } else if (this.currentTab === 'incidents' && dataTab === 'incidents') {
        btn.classList.add('active');
      } else if (this.currentTab === 'monthly' && dataTab === 'monthly') {
        btn.classList.add('active');
      } else if (this.currentTab === 'journalism' && dataHours === this.currentHours) {
        btn.classList.add('active');
      }
    });
  }

  updateUrl() {
    const params = new URLSearchParams();
    if (this.currentTab === 'termometre') {
      params.set('tab', 'termometre');
    } else if (this.currentTab === 'incidents') {
      params.set('tab', 'incidents');
      if (this._currentIncidentLine && this._currentIncidentLine !== 'all') {
        params.set('line', this._currentIncidentLine);
      }
    } else if (this.currentTab === 'monthly') {
      params.set('tab', 'monthly');
      if (this._currentMonthlyMonth) {
        params.set('month', this._currentMonthlyMonth);
      }
    } else {
      if (this.currentHours !== 24) {
        params.set('h', String(this.currentHours));
      }
    }

    if (this.filterText && this.currentTab === 'journalism') {
      params.set('q', this.filterText);
    }

    if (this.groupByLine && this.currentTab === 'journalism') {
      params.set('grouped', '1');
    }

    if (this.stopFilterMode && this.stopFilterMode !== 'bottlenecks' && this.currentTab === 'journalism') {
      params.set('stops', this.stopFilterMode);
    }

    const newUrl = `${window.location.pathname}${params.toString() ? '?' + params.toString() : ''}`;
    window.history.replaceState({}, '', newUrl);
  }

  async fetchLinesMetadata() {
    try {
      const res = await fetch('/api/lines').then(r => r.json());
      if (res && res.success && Array.isArray(res.lines)) {
        this.availableLines = res.lines;
      }
    } catch {
      // Non-critical fallback
    }
  }

  async fetchDataHealth() {
    try {
      const res = await fetch('/api/data-health').then(r => r.json());
      if (res && res.success) {
        this.renderDataHealth(res);
      } else {
        this.renderDataHealth(null);
      }
    } catch {
      this.renderDataHealth(null);
    }
  }

  // ==========================================
  // GPS LOSS MAP: where buses stop reporting
  // ==========================================

  /**
   * "On perden el GPS" belongs to the punctuality report (24 h / 48 h /
   * 7 dies), not to the Termòmetre, Top Incidents or monthly tabs.
   */
  showGpsGaps(show) {
    const section = document.getElementById('gps-gaps-section');
    if (!section) return;
    section.style.display = show ? '' : 'none';
    // Leaflet measured the map while it was hidden: size it again.
    if (show && this.gpsGapMap) this.gpsGapMap.invalidateSize({ pan: false });
  }

  initGpsGaps() {
    const section = document.getElementById('gps-gaps-section');
    if (!section) return;
    this.gpsGapDays = 7;
    this.gpsGapLine = 'all';
    this.gpsGapVehicle = '';
    this.gpsGapHide = '';
    this.gpsGapMarkers = [];
    section.addEventListener('click', (e) => {
      const dayBtn = e.target.closest('[data-gps-days]');
      const lineBtn = e.target.closest('[data-gps-line]');
      const item = e.target.closest('[data-gps-cell]');
      const busBtn = e.target.closest('[data-gps-bus]');
      const hideBtn = e.target.closest('[data-gps-hide]');
      if (e.target.closest('[data-gps-close]')) {
        this.clearGpsGapSelection();
      } else if (e.target.closest('[data-gps-retry]')) {
        this.loadGpsGaps();
      } else if (hideBtn) {
        // The map without the buses the ranking flags, to see the places alone.
        this.gpsGapHide = hideBtn.dataset.gpsHide || '';
        this.gpsGapVehicle = '';
        section.querySelectorAll('[data-gps-hide]').forEach(b => b.classList.toggle('active', b === hideBtn));
        this.loadGpsGaps();
      } else if (e.target.closest('[data-gps-bus-clear]') || busBtn) {
        // One bus's losses on the map; the same bus again (or its chip) shows all.
        const id = busBtn ? busBtn.dataset.gpsBus : '';
        this.gpsGapVehicle = id && id !== this.gpsGapVehicle ? id : '';
        this.loadGpsGaps();
        if (this.gpsGapVehicle) document.getElementById('gps-gaps-map')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else if (dayBtn) {
        this.gpsGapDays = Number(dayBtn.dataset.gpsDays) || 7;
        section.querySelectorAll('[data-gps-days]').forEach(b => b.classList.toggle('active', b === dayBtn));
        this.loadGpsGaps();
      } else if (lineBtn) {
        this.gpsGapLine = lineBtn.dataset.gpsLine || 'all';
        this.gpsGapVehicle = '';
        section.querySelectorAll('[data-gps-line]').forEach(b => b.classList.toggle('active', b === lineBtn));
        this.loadGpsGaps();
      } else if (item) {
        this.focusGpsGapCell(Number(item.dataset.gpsCell));
      }
    });
    // The map and its tiles load only once the section is about to be seen.
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        if (entries.some(en => en.isIntersecting)) {
          io.disconnect();
          this.loadGpsGaps();
        }
      }, { rootMargin: '200px' });
      io.observe(section);
    } else {
      this.loadGpsGaps();
    }
  }

  async loadGpsGaps() {
    const reqId = (this._gpsGapReq = (this._gpsGapReq || 0) + 1);
    clearTimeout(this._gpsGapRetry);
    const summary = document.getElementById('gps-gaps-summary');
    const bus = this.gpsGapVehicle ? `&vehicle=${encodeURIComponent(this.gpsGapVehicle)}` : (this.gpsGapHide ? `&hide=${this.gpsGapHide}` : '');
    const url = `/api/analytics/gps-gaps?days=${this.gpsGapDays}&line=${encodeURIComponent(this.gpsGapLine)}${bus}`;
    // A choice seen in the last minute (the server caches as long) is redrawn
    // without asking again: going back and forth between buses costs nothing.
    if (!this.gpsGapResponses) this.gpsGapResponses = new Map();
    const seen = this.gpsGapResponses.get(url);
    if (seen && Date.now() - seen.at < 60000) {
      this.renderGpsGaps(seen.data);
      return;
    }
    if (summary) summary.textContent = 'Carregant pèrdues de senyal...';
    // Quick clicks send one request, for the last choice.
    await new Promise(resolve => setTimeout(resolve, 200));
    if (reqId !== this._gpsGapReq) return;
    let data = null;
    let retryAfter = 0;
    try {
      const r = await fetch(url);
      if (r.status === 429) retryAfter = Math.min(60, Math.max(1, Number(r.headers.get('Retry-After')) || 10));
      const res = await r.json();
      data = res && res.success ? res : null;
    } catch {
      data = null;
    }
    if (reqId !== this._gpsGapReq) return; // a newer filter choice superseded this one
    if (data) {
      this.gpsGapResponses.set(url, { data, at: Date.now() });
      if (this.gpsGapResponses.size > 24) this.gpsGapResponses.delete(this.gpsGapResponses.keys().next().value);
      this.renderGpsGaps(data);
      return;
    }
    // A refused or failed request keeps what is on screen (the map, the list
    // and the buses to click), says so, and tries again.
    if (!this._gpsGapShown) this.renderGpsGaps(null);
    const kept = this._gpsGapShown ? ' El mapa encara mostra la consulta anterior.' : '';
    if (summary) {
      summary.innerHTML = retryAfter
        ? this.esc(`Massa consultes seguides: es torna a carregar sol en ${retryAfter} s.${kept}`)
        : `${this.esc(`No s'han pogut carregar les pèrdues de senyal.${kept}`)} <button type="button" class="observatori-pill-btn gps-bus-clear" data-gps-retry>Torna-ho a provar</button>`;
    }
    if (retryAfter) {
      this._gpsGapRetry = setTimeout(() => {
        if (reqId === this._gpsGapReq) this.loadGpsGaps();
      }, retryAfter * 1000);
    }
  }

  gpsGapTileUrl() {
    const isDark = (document.documentElement.getAttribute('data-theme') || 'dark') === 'dark';
    const cartoKey = 'cb1_2e4m_1_e5f70f18572ed17fe4483c7e';
    return isDark
      ? `https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png?key=${cartoKey}`
      : `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=${cartoKey}`;
  }

  ensureGpsGapMap() {
    if (this.gpsGapMap) return this.gpsGapMap;
    const el = document.getElementById('gps-gaps-map');
    if (!el || typeof L === 'undefined') return null;
    const map = L.map(el, { preferCanvas: true }).setView([41.5405, 2.4445], 14);
    this.gpsGapTiles = L.tileLayer(this.gpsGapTileUrl(), {
      attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      subdomains: 'abcd',
      maxZoom: 19
    }).addTo(map);
    this.gpsGapLayer = L.layerGroup().addTo(map);
    this.gpsGapPathLayer = L.layerGroup().addTo(map);
    this.gpsGapPathCache = new Map();
    this.gpsGapPassCache = new Map();
    // A click on the map background clears the selected hotspot.
    map.on('click', () => this.clearGpsGapSelection());
    new MutationObserver(() => this.gpsGapTiles.setUrl(this.gpsGapTileUrl()))
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.gpsGapMap = map;
    return map;
  }

  lineChip(code) {
    const n = /^L([1-8])$/.exec(String(code || '').toUpperCase());
    return n
      ? `<span class="line-chip line-chip-${n[1]}">L${n[1]}</span>`
      : `<span class="line-chip">${this.esc(code)}</span>`;
  }

  /**
   * A selected hotspot (its circle or its row) shows its detail beside the
   * map, never over it, and the streets its buses drove without GPS (cut
   * from each line's route by the server). A click on the map background or
   * the detail's close button clears both.
   */
  gpsGapMarkerStyle(c, selected) {
    const colour = c.recurrent ? '#f43f5e' : '#f59e0b';
    const ring = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || colour;
    return selected
      ? { color: ring, weight: 3, fillColor: colour, fillOpacity: 0.75 }
      : { color: colour, weight: 2, fillColor: colour, fillOpacity: c.recurrent ? 0.5 : 0.28 };
  }

  clearGpsGapSelection() {
    this._gpsGapPathReq = (this._gpsGapPathReq || 0) + 1;
    const was = this.gpsGapSelected;
    this.gpsGapSelected = null;
    if (this.gpsGapPathLayer) this.gpsGapPathLayer.clearLayers();
    const marker = this.gpsGapMarkers && this.gpsGapMarkers[was];
    if (marker && this.gpsGapCells && this.gpsGapCells[was]) marker.setStyle(this.gpsGapMarkerStyle(this.gpsGapCells[was], false));
    document.querySelectorAll('#gps-gaps-list [data-gps-cell].active').forEach(b => b.classList.remove('active'));
    const detail = document.getElementById('gps-gaps-detail');
    if (detail && !detail.hidden) {
      detail.hidden = true;
      detail.innerHTML = '';
      // The map is as tall as its column: it shrinks back with the detail.
      if (this.gpsGapMap) this.gpsGapMap.invalidateSize({ pan: false });
    }
  }

  selectGpsGapCell(i) {
    const c = this.gpsGapCells && this.gpsGapCells[i];
    const detail = document.getElementById('gps-gaps-detail');
    if (!c || !detail) return;
    this.clearGpsGapSelection();
    this.gpsGapSelected = i;
    const marker = this.gpsGapMarkers[i];
    if (marker) marker.setStyle(this.gpsGapMarkerStyle(c, true)).bringToFront();
    document.querySelector(`#gps-gaps-list [data-gps-cell="${i}"]`)?.classList.add('active');
    detail.innerHTML = this.gpsGapDetailHtml(c);
    detail.hidden = false;
    if (this.gpsGapMap) this.gpsGapMap.invalidateSize({ pan: false });
    this.showGpsGapPaths(c, detail);
    this.showGpsGapPasses(c, detail);
  }

  gpsGapDetailHtml(c) {
    const back = Math.round(L.latLng(c.lat, c.lon).distanceTo(L.latLng(c.regainedLat, c.regainedLon)));
    const last = new Date(c.lastTs).toLocaleString('ca-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `<div class="gps-gaps-popup">
      <div class="gps-gaps-popup-head">
        <strong>${c.stopName ? `Prop de ${this.esc(c.stopName)}` : 'Punt sense parada propera'}</strong>
        <span class="gps-gaps-popup-tag${c.recurrent ? ' recurrent' : ''}">${c.recurrent ? 'Punt recurrent' : 'Pèrdua puntual'}</span>
      </div>
      <button type="button" class="btn-icon gps-gaps-detail-close" data-gps-close aria-label="Tanca el detall">&times;</button>
      <dl class="gps-gaps-popup-stats">
        <dt>Pèrdues</dt><dd>${c.count} · ${c.vehicles} ${c.vehicles === 1 ? 'bus' : 'busos'}</dd>
        <dt>Sense senyal</dt><dd>${this.esc(this.fmtGapDuration(c.medianGapSec))}${c.count > 1 ? ' de mediana' : ''}</dd>
        ${c.count > 1 ? `<dt>La més llarga</dt><dd>${this.esc(this.fmtGapDuration(c.maxGapSec))}</dd>` : ''}
        <dt>El recupera</dt><dd>a ${back} m</dd>
        <dt>Última</dt><dd>${this.esc(last)}</dd>
      </dl>
      <div class="gps-gaps-popup-lines">${c.lines.map(code => this.lineChip(code)).join('')}</div>
      <div class="gps-gaps-popup-route" data-gps-route><p>Buscant el recorregut sense GPS…</p></div>
      <div class="gps-gaps-popup-route gps-gaps-passes" data-gps-passes><p>Buscant qui més hi passa…</p></div>
    </div>`;
  }

  /**
   * Who else drove past the selected hotspot, and whether they kept GPS
   * (historyDb.getGpsGapPasses). Most passes with signal means the place
   * has coverage and the losses belong to the buses that had them; most
   * passes without it, from different buses, means the place.
   */
  async showGpsGapPasses(cell, detail) {
    const box = detail && detail.querySelector('[data-gps-passes]');
    const ids = cell.gapIds || [];
    if (!box || !ids.length) return;
    const key = `${this.gpsGapDays}|${ids.join(',')}`;
    let data = this.gpsGapPassCache.get(key);
    if (!data) {
      try {
        const res = await fetch(`/api/analytics/gps-gaps/passes?days=${this.gpsGapDays}&ids=${ids.join(',')}`).then(r => r.json());
        data = res && res.success ? res : null;
      } catch {
        data = null;
      }
      if (data) {
        this.gpsGapPassCache.set(key, data);
        if (this.gpsGapPassCache.size > 40) this.gpsGapPassCache.delete(this.gpsGapPassCache.keys().next().value);
      }
    }
    if (!box.isConnected) return; // another hotspot was picked meanwhile
    if (!data) {
      box.innerHTML = "<p>No s'ha pogut carregar qui més hi passa ara mateix: torna a tocar el punt d'aquí a uns segons.</p>";
      return;
    }
    const t = data.totals;
    if (!t || !t.buses) {
      box.innerHTML = "<p>No hi ha altres passades registrades per comparar.</p>";
      return;
    }
    const passes = t.lost + t.gpsPasses;
    const losers = data.buses.filter(b => b.lost);
    const clean = data.buses.filter(b => !b.lost && b.gpsPasses);
    const cleanPasses = clean.reduce((s, b) => s + b.gpsPasses, 0);
    const period = this.gpsGapDays === 1 ? 'les últimes 24 h' : `${this.gpsGapDays} dies`;
    const repeat = losers.find(b => b.lost >= 2 && b.lost / (b.lost + b.gpsPasses) >= 0.5);
    let verdict;
    if (passes < 8) {
      verdict = 'Encara hi ha poques passades per saber si és el lloc o els busos.';
    } else if (t.lost / passes >= 0.5 && t.lossBuses >= 2) {
      verdict = 'La majoria de passades hi perden el senyal, i de busos diferents: apunta a la cobertura del lloc.';
    } else if (t.lost / passes <= 0.25 && t.cleanBuses >= 3) {
      verdict = `${t.gpsPasses} de ${passes} passades hi tenen senyal: no és un lloc sense cobertura. `
        + (repeat
          ? `El bus ${repeat.vehicleId} l'hi perd ${repeat.lost} de ${repeat.lost + repeat.gpsPasses} vegades: apunta a l'equip del bus.`
          : 'Les pèrdues són puntuals, de busos que normalment hi passen amb senyal.');
    } else {
      verdict = 'Hi ha passades amb senyal i sense: pot ser el lloc o els busos.';
    }
    const cleanList = clean.slice(0, 10).map(b => `${this.esc(b.vehicleId)} (${b.gpsPasses})`).join(', ');
    box.innerHTML = `<h5>Qui més hi passa</h5>
      <p>En ${period} hi han passat <strong>${t.buses}</strong> busos: <strong>${t.cleanBuses}</strong> sempre amb senyal (${cleanPasses} passades)${t.lossBuses ? ` i ${t.lossBuses} l'hi han perdut` : ''}.</p>
      ${losers.length ? `<ul class="gps-gaps-popup-paths">${losers.map(b => `<li><span>${b.lines.slice(0, 2).map(code => this.lineChip(code)).join('')}<span>${this.esc(b.vehicleId)}</span><b>sense senyal ${b.lost} de ${b.lost + b.gpsPasses}</b></span></li>`).join('')}</ul>` : ''}
      ${clean.length ? `<p>Sempre amb senyal: ${cleanList}${clean.length > 10 ? ` i ${clean.length - 10} més` : ''}.</p>` : ''}
      <p class="gps-gaps-passes-verdict">${this.esc(verdict)}</p>
      ${(cell.count || 0) > ids.length ? `<p>Es compten les ${ids.length} pèrdues més recents d'aquest punt.</p>` : ''}`;
  }

  async showGpsGapPaths(cell, detail) {
    const token = (this._gpsGapPathReq = (this._gpsGapPathReq || 0) + 1);
    this.gpsGapPathLayer.clearLayers();
    const ids = (cell.gapIds || []).filter(id => !this.gpsGapPathCache.has(id));
    let failed = false;
    if (ids.length) {
      try {
        const res = await fetch(`/api/analytics/gps-gaps/paths?ids=${ids.join(',')}`).then(r => r.json());
        failed = !(res && res.success);
        for (const p of (res && res.paths) || []) this.gpsGapPathCache.set(p.id, p);
      } catch {
        failed = true;
      }
    }
    if (token !== this._gpsGapPathReq) return;
    const placed = (cell.gapIds || []).map(id => this.gpsGapPathCache.get(id)).filter(p => p && Array.isArray(p.path));
    // A bus that hardly moved while silent drove no street worth drawing.
    const paths = placed.filter(p => p.lengthM >= 25);
    const stood = placed.length - paths.length;
    const css = getComputedStyle(document.documentElement);
    const casing = css.getPropertyValue('--bg-surface').trim() || '#12131a';
    const colourOf = (code) => {
      const n = /^L([1-8])$/.exec(code || '');
      return (n && css.getPropertyValue(`--line-${n[1]}`).trim()) || css.getPropertyValue('--status-estimated').trim() || '#f59e0b';
    };
    // Lines share streets (L6 and L8 run together through Parc Central): one
    // stripe width per line, widest underneath, so a shared street shows
    // every line's colour instead of only the last one drawn.
    const lineOrder = [...new Set(paths.map(p => p.lineCode))]
      .sort((a, b) => paths.filter(p => p.lineCode === b).length - paths.filter(p => p.lineCode === a).length);
    const widthOf = (code) => [8, 4, 2][Math.min(2, lineOrder.indexOf(code))];
    const style = { lineCap: 'round', lineJoin: 'round', interactive: false };
    this.gpsGapPathParts = new Map();
    const part = (p, layer, base) => {
      layer.gpsBase = base;
      if (!this.gpsGapPathParts.has(p.id)) this.gpsGapPathParts.set(p.id, []);
      this.gpsGapPathParts.get(p.id).push(layer.addTo(this.gpsGapPathLayer));
    };
    for (const p of paths) part(p, L.polyline(p.path, { ...style, color: casing, weight: widthOf(lineOrder[0]) + 4, opacity: 0.9 }), 0.9);
    for (const code of lineOrder) {
      for (const p of paths.filter(q => q.lineCode === code)) part(p, L.polyline(p.path, { ...style, color: colourOf(code), weight: widthOf(code), opacity: 0.95 }), 0.95);
    }
    // Where each bus's GPS came back.
    for (const p of paths) {
      part(p, L.circleMarker(p.path[p.path.length - 1], { radius: 5, color: casing, weight: 2, fillColor: colourOf(p.lineCode), fillOpacity: 1, interactive: false }), 1);
    }
    const note = detail && detail.querySelector('[data-gps-route]');
    if (note) {
      // One row per loss: which bus, when, how long, and the street it drove.
      const rows = (cell.gapIds || []).map(id => this.gpsGapPathCache.get(id)).filter(Boolean)
        .sort((a, b) => (b.lostTs || 0) - (a.lostTs || 0));
      const hhmm = ts => (Number.isFinite(ts) ? new Date(ts).toLocaleTimeString('ca-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' }) : '');
      const drawn = p => Array.isArray(p.path) && p.lengthM >= 25;
      const what = p => (!Array.isArray(p.path) ? 'no situat' : drawn(p) ? `${p.lengthM} m` : 'aturat');
      const row = p => {
        const inner = `${this.lineChip(p.lineCode)}<span>${p.vehicleId ? `${this.esc(p.vehicleId)} · ` : ''}${this.esc(hhmm(p.lostTs))} · ${this.esc(this.fmtGapDuration(p.gapSec))}</span><b>${this.esc(what(p))}</b>`;
        return drawn(p) ? `<li><button type="button" data-gps-path="${p.id}">${inner}</button></li>` : `<li><span>${inner}</span></li>`;
      };
      const hint = paths.length
        ? "Toca un bus per veure només el seu tram; el punt és on torna el GPS."
        : (stood ? '' : "No s'ha pogut situar a la ruta de la línia.");
      note.innerHTML = rows.length
        ? `<ul class="gps-gaps-popup-paths">${rows.map(row).join('')}</ul>${hint ? `<p>${hint}</p>` : ''}`
        : failed
          ? "<p>No s'ha pogut carregar el recorregut ara mateix: torna a tocar el punt d'aquí a uns segons.</p>"
          : "<p>No s'ha pogut situar a la ruta de la línia.</p>";
      // The rows name every line: the chip row above them would repeat it.
      const chips = detail.querySelector('.gps-gaps-popup-lines');
      if (chips) chips.hidden = rows.length > 0;
      this._gpsGapPathPicked = null;
      note.onclick = (e) => {
        const btn = e.target.closest('[data-gps-path]');
        if (!btn) return;
        const id = Number(btn.dataset.gpsPath);
        const on = this._gpsGapPathPicked === id ? null : id;
        this._gpsGapPathPicked = on;
        note.querySelectorAll('[data-gps-path]').forEach(b => b.classList.toggle('active', Number(b.dataset.gpsPath) === on));
        for (const [pid, layers] of this.gpsGapPathParts) {
          const shown = on === null || pid === on;
          for (const layer of layers) {
            layer.setStyle(layer instanceof L.CircleMarker
              ? { opacity: shown ? 1 : 0.12, fillOpacity: shown ? 1 : 0.12 }
              : { opacity: shown ? layer.gpsBase : 0.12 });
          }
        }
        if (on !== null) for (const layer of this.gpsGapPathParts.get(on) || []) layer.bringToFront();
      };
    }
    // Nothing covers the map now: fit the streets and the circle if any of
    // them is out of view.
    const map = this.gpsGapMap;
    if (!map) return;
    const bounds = L.latLngBounds([[cell.lat, cell.lon], ...paths.flatMap(p => p.path)]);
    if (!map.getBounds().pad(-0.05).contains(bounds)) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 });
  }

  /**
   * Which buses lose GPS the most (src/core/geo/gapBuses.js): each against
   * the other buses on its lines, per 100 stops served. Far above its
   * colleagues on the same streets points at the bus's equipment; losing it
   * where the others lose it too points at coverage.
   */
  renderGpsGapBuses(data) {
    const block = document.getElementById('gps-gaps-buses-block');
    const list = document.getElementById('gps-gaps-buses');
    const foot = document.getElementById('gps-gaps-buses-foot');
    if (!block || !list) return;
    const buses = (data && data.buses) || [];
    block.hidden = !buses.length;
    if (!buses.length) return;
    const dec = x => String(x).replace('.', ',');
    const tags = {
      suspect: ['recurrent', 'Possible problema del bus'],
      watch: ['', 'Per sobre, pot ser atzar'],
      normal: ['calm', 'Com els companys'],
      few: ['calm', 'Poques dades']
    };
    list.innerHTML = buses.slice(0, 10).map(b => {
      const [cls, label] = tags[b.verdict] || tags.few;
      const facts = [
        `<strong>${b.gaps}</strong> ${b.gaps === 1 ? 'pèrdua' : 'pèrdues'}${b.visits ? ` en ${b.visits} parades (${dec(b.per100)} per 100)` : ''}`,
        b.ratio !== null ? `<strong>${dec(b.ratio)}×</strong> els companys de línia` : '',
        `${b.sharedPct}% on altres busos també el perden`
      ].filter(Boolean).join(' · ');
      const on = this.gpsGapVehicle === b.vehicleId;
      const off = (data.hidden || []).includes(b.vehicleId);
      return `<li><button type="button" class="gps-bus-row${on ? ' active' : ''}${off ? ' is-hidden' : ''}" data-gps-bus="${this.esc(b.vehicleId)}" aria-pressed="${on}"${off ? ' title="Amagat del mapa"' : ''}>
        <span class="gps-bus-id">${this.esc(b.vehicleId)}</span>
        <span class="gps-bus-head">${b.lines.map(code => this.lineChip(code)).join('')}<span class="gps-gaps-popup-tag${cls ? ` ${cls}` : ''}">${label}</span></span>
        <span class="gps-bus-facts">${facts}</span>
      </button></li>`;
    }).join('');
    const fleet = (data && data.fleet) || {};
    if (foot) {
      foot.textContent = `${fleet.inService || 0} busos han fet servei en aquest període i ${fleet.withoutLoss || 0} no han perdut el senyal cap vegada. "Possible problema del bus" vol dir 4 pèrdues o més, 1,5 vegades les dels companys i poc probable per atzar (p < 0,05). Toca un bus per veure només les seves pèrdues al mapa.`;
    }
  }

  fmtGapDuration(sec) {
    if (!Number.isFinite(sec)) return '--';
    if (sec < 60) return `${sec} s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s ? `${m} min ${s} s` : `${m} min`;
  }

  renderGpsGaps(data) {
    const summary = document.getElementById('gps-gaps-summary');
    const list = document.getElementById('gps-gaps-list');
    const empty = document.getElementById('gps-gaps-empty');
    const map = this.ensureGpsGapMap();
    if (this.gpsGapLayer) this.gpsGapLayer.clearLayers();
    this.gpsGapMarkers = [];
    this.clearGpsGapSelection();
    this.gpsGapCells = [];
    if (!summary || !list || !empty) return;
    this.renderGpsGapBuses(data);

    if (!data) {
      summary.textContent = "No s'han pogut carregar les pèrdues de senyal.";
      list.innerHTML = '';
      empty.textContent = 'Sense dades';
      empty.hidden = false;
      return;
    }

    this._gpsGapShown = true;
    const t = data.totals || {};
    const cells = Array.isArray(data.cells) ? data.cells : [];
    const period = data.days === 1 ? 'les últimes 24 h' : `els últims ${data.days} dies`;
    const onLine = data.lineCode ? ` a la ${this.esc(data.lineCode)}` : '';
    const left = [];
    if (t.atTerminal) left.push(`${t.atTerminal} a capçalera`);
    if (t.feedWide) left.push(`${t.feedWide} talls de tot el canal`);
    const leftTxt = left.length ? ` No s'hi compten ${left.join(' ni ')}.` : '';

    // The picked bus, as a chip that shows every bus again.
    const busChip = data.vehicleId
      ? `<button type="button" class="observatori-pill-btn active gps-bus-clear" data-gps-bus-clear aria-label="Mostra tots els busos">Bus ${this.esc(data.vehicleId)} ×</button> `
      : '';
    if (!t.mapped) {
      summary.innerHTML = busChip + this.esc(`Cap pèrdua de senyal registrada${data.lineCode ? ` a la ${data.lineCode}` : ''} en ${period}.${leftTxt}`);
      list.innerHTML = '';
      empty.textContent = "Encara no hi ha pèrdues de senyal per mostrar en aquest període.";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    this.gpsGapCells = cells;
    const recurrent = cells.filter(c => c.recurrent).length;
    // One bus: "recurrent" needs two buses, so say where instead.
    const picked = (data.buses || []).find(b => b.vehicleId === data.vehicleId);
    const busWhere = `En ${cells.length} ${cells.length === 1 ? 'lloc' : 'llocs diferents'}${picked ? `; el ${picked.sharedPct}% on altres busos també el perden` : ''}.`;
    summary.innerHTML = busChip + (data.vehicleId
      ? `<strong>${t.mapped}</strong> pèrdues de senyal${onLine} en ${period}; durada mediana <strong>${this.esc(this.fmtGapDuration(t.medianGapSec))}</strong>. `
      : `<strong>${t.mapped}</strong> pèrdues de senyal${onLine} en ${period}, de ${t.vehicles} busos; durada mediana <strong>${this.esc(this.fmtGapDuration(t.medianGapSec))}</strong>. `)
      + (data.vehicleId ? busWhere : recurrent
        ? `<strong>${t.recurrentShare}%</strong> es concentren en ${recurrent} ${recurrent === 1 ? 'punt recurrent' : 'punts recurrents'}.`
        : 'Cap punt es repeteix prou encara per ser recurrent.')
      + this.esc(leftTxt)
      + ((data.hidden || []).length
        ? ` Amagats del mapa: ${data.hidden.length} ${data.hidden.length === 1 ? 'bus' : 'busos'} (${data.hidden.map(id => this.esc(id)).join(', ')}).`
        : '');

    // The list first: the map column stretches to its height, so the map is
    // sized and fitted after it.
    list.innerHTML = cells.slice(0, 8).map((c, i) => `
      <li>
        <button type="button" class="gps-gaps-item" data-gps-cell="${i}">
          <span class="gps-gaps-rank${c.recurrent ? ' recurrent' : ''}">${i + 1}</span>
          <span class="gps-gaps-item-main">
            <strong>${c.stopName ? `Prop de ${this.esc(c.stopName)}` : 'Sense parada propera'}</strong>
            <span>${c.lines.map(code => this.lineChip(code)).join(' ')} ${c.vehicles} ${c.vehicles === 1 ? 'bus' : 'busos'} · mediana ${this.esc(this.fmtGapDuration(c.medianGapSec))}</span>
          </span>
          <span class="gps-gaps-item-count">${c.count}<small>${c.count === 1 ? 'pèrdua' : 'pèrdues'}</small></span>
        </button>
      </li>`).join('');

    if (map) {
      // Straight from where the signal went to where it came back: the bus
      // drove the street in between with no GPS.
      for (const g of (data.gaps || [])) {
        L.polyline([[g.lostLat, g.lostLon], [g.regainedLat, g.regainedLon]], {
          color: '#fbbf24', weight: 2.5, opacity: 0.7, dashArray: '4 6', interactive: false
        }).addTo(this.gpsGapLayer);
      }
      // Smallest first, so the busiest points are drawn on top.
      for (let i = cells.length - 1; i >= 0; i--) {
        const c = cells[i];
        this.gpsGapMarkers[i] = L.circleMarker([c.lat, c.lon], {
          radius: Math.min(26, 6 + 4 * Math.sqrt(c.count)),
          ...this.gpsGapMarkerStyle(c, false)
        }).addTo(this.gpsGapLayer);
        this.gpsGapMarkers[i].on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          this.selectGpsGapCell(i);
        });
      }
      map.invalidateSize();
      if (cells.length) map.fitBounds(cells.map(c => [c.lat, c.lon]), { padding: [30, 30], maxZoom: 16 });
    }

  }

  focusGpsGapCell(i) {
    const marker = this.gpsGapMarkers[i];
    if (!marker || !this.gpsGapMap) return;
    document.getElementById('gps-gaps-map')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    this.gpsGapMap.setView(marker.getLatLng(), 16);
    this.selectGpsGapCell(i);
  }

  renderDataHealth(data) {
    const grid = document.getElementById('data-health-grid');
    if (!grid) return;
    const timeEl = document.getElementById('data-health-timestamp');
    if (timeEl) {
      timeEl.textContent = new Date().toLocaleTimeString('ca-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    const items = [];
    let fleetHtml = '';

    // One compact row per check: status dot, title, badge, one-line detail.
    // The tone travels with the item so the summary line can count it.
    const TONE = { 'status-success': 'ok', 'status-warning': 'warn', 'status-danger': 'bad', 'status-neutral': 'none' };
    const makeItem = (title, badgeClass, badgeText, description) => ({
      tone: TONE[badgeClass] || 'none',
      html: `
      <div class="data-health-item dh-${TONE[badgeClass] || 'none'}">
        <div class="data-health-header">
          <span class="data-health-title"><span class="dh-dot" aria-hidden="true"></span><span>${this.esc(title)}</span></span>
          <span class="data-health-badge ${badgeClass}">${this.esc(badgeText)}</span>
        </div>
        <p class="data-health-desc">${description}</p>
      </div>`
    });

    // 1. Canari SIRI (upstreamCanary)
    if (!data || data.upstreamCanary === null || data.upstreamCanary === undefined) {
      items.push(makeItem('Canari SIRI', 'status-neutral', 'Sense dades', 'No s&#039;ha obtingut cap comprovació recent del canari.'));
    } else if (data.upstreamCanary.ok === true) {
      const ageStr = data.upstreamCanary.checkedAt ? `fa ${Math.round(Math.max(0, Date.now() - data.upstreamCanary.checkedAt) / 1000)} s` : 'recentment';
      items.push(makeItem('Canari SIRI', 'status-success', 'Operatiu', `El canal SIRI respon (${ageStr}).`));
    } else {
      items.push(makeItem('Canari SIRI', 'status-danger', 'Incidència', `Error en la consulta del canari: ${this.esc(data.upstreamCanary.error || 'sense resposta')}`));
    }

    // 2. Connexió operador (lastError)
    const ERROR_TEXT = {
      malformed: "resposta buida o incompleta de l'operador",
      auth: 'credencials SIRI rebutjades',
      soap_fault: "error intern del servidor de l'operador",
      upstream_error: "l'operador ha retornat un error",
      network_error: "sense connexió amb el servidor de l'operador",
      timeout: "l'operador no ha respost a temps"
    };
    const describeError = (code) => ERROR_TEXT[code] || (/^http_\d+$/.test(String(code)) ? `l'operador ha respost amb HTTP ${String(code).slice(5)}` : String(code));
    if (!data || !data.upstreamKnown) {
      items.push(makeItem('Connexió operador', 'status-neutral', 'Sense dades', 'Sense registres d&#039;errors recents de l&#039;operador.'));
    } else if (data.lastError === null || data.lastError === undefined) {
      items.push(makeItem('Connexió operador', 'status-success', 'Sense errors', 'Cap error recent de l&#039;operador.'));
    } else {
      const ageMin = data.lastErrorAt ? Math.max(1, Math.round((Date.now() - data.lastErrorAt) / 60000)) : null;
      const when = ageMin === null ? '' : `fa ${ageMin} min: `;
      const what = this.esc(describeError(data.lastError));
      if (data.circuitOpen) {
        items.push(makeItem('Connexió operador', 'status-danger', 'Error', `Últim error ${when}${what}. Consultes en pausa durant 30 s.`));
      } else if (ageMin !== null && ageMin >= 10) {
        items.push(makeItem('Connexió operador', 'status-neutral', 'Recuperat', `Últim error ${when}${what}. Des d&#039;aleshores l&#039;operador respon correctament.`));
      } else {
        items.push(makeItem('Connexió operador', 'status-warning', 'Error recent', `Últim error ${when}${what}.`));
      }
    }

    // 3. Anomalia de flota (fleetAnomaly)
    if (!data || data.fleetAnomaly === null || data.fleetAnomaly === undefined) {
      items.push(makeItem('Anomalia de flota', 'status-neutral', 'Sense dades', 'Sense avaluació d&#039;anomalies de flota.'));
    } else if (data.fleetAnomaly.detected === true) {
      items.push(makeItem('Anomalia de flota', 'status-warning', 'Anomalia', this.esc(data.fleetAnomaly.message || 'Desviació en la flota activa detectada.')));
    } else {
      items.push(makeItem('Anomalia de flota', 'status-success', 'Normal', 'Cap anomalia de flota a la xarxa.'));
    }

    // 4. Flota en servei (fleet): its own full-width row with one chip per line.
    if (!data || data.fleet === null || data.fleet === undefined) {
      const empty = makeItem('Flota en servei', 'status-neutral', 'Sense dades', 'Sense dades de vehicles actius per línia.');
      items.push({ tone: empty.tone, html: '' });
      fleetHtml = `<div class="dh-fleet">${empty.html}</div>`;
    } else {
      const { totalLiveGps = 0, totalEstimated = 0, totalScheduled = 0, complete = true, lines = [] } = data.fleet;
      const totalBuses = Number.isFinite(data.fleet.totalScheduledBuses) ? data.fleet.totalScheduledBuses : totalScheduled;
      const isOk = totalBuses > 0 && totalLiveGps >= Math.ceil(totalBuses * 0.7);
      const badgeClass = totalBuses > 0 ? (isOk ? 'status-success' : 'status-warning') : 'status-neutral';
      const badgeText = `${totalLiveGps} GPS · ${totalEstimated} estimats`;
      const REASON = {
        terminal_ghost: 'capçalera ocupada',
        line_cap: 'límit de flota de la línia',
        direction_allowance: 'bus real fora del seu horari',
        colocated: 'bus real a menys de 100 m',
        no_position: 'sense posició al traçat'
      };
      const chips = lines.map(l => {
        const colour = this.getLineColor(l.lineCode);
        const code = `<span class="dh-line-code" style="background:${colour}; color:${this.chipInk(colour)};">${this.esc(l.lineCode)}</span>`;
        if (l.available === false) return `<div class="dh-line">${code}<span class="dh-line-count">sense dades</span></div>`;
        const buses = Number.isFinite(l.scheduledBuses) ? l.scheduledBuses : l.scheduledVehicles;
        const shown = l.liveGpsVehicles + (l.estimatedVehicles ?? 0);
        const gap = buses - shown;
        let note = '';
        if (gap > 0) {
          const reasons = Object.entries(l.notDrawn || {})
            .filter(([k, n]) => k !== 'terminal_bus' && n > 0)
            .map(([k, n]) => `${REASON[k] || k}${n > 1 ? ` ×${n}` : ''}`);
          note = `<span class="dh-line-note">${gap} sense dibuixar${reasons.length ? `: ${this.esc(reasons.join(', '))}` : ''}</span>`;
        }
        return `<div class="dh-line${gap > 0 ? ' has-gap' : ''}">${code}<span class="dh-line-count">${l.liveGpsVehicles}+${l.estimatedVehicles ?? 0}/${buses}</span>${note}</div>`;
      }).join('');
      const note = complete ? '' : ' Algunes línies no tenen dades.';
      const fleetItem = makeItem('Flota en servei', badgeClass, badgeText,
        `${totalLiveGps + totalEstimated} autobusos al mapa; l&#039;horari en necessita ${totalBuses}.${note} Per línia: amb GPS + estimats / necessaris. Un bus que acaba un trajecte i torna a sortir de la mateixa capçalera compta una sola vegada.`);
      items.push({ tone: fleetItem.tone, html: '' });
      fleetHtml = `<div class="dh-fleet">${fleetItem.html}${chips ? `<div class="dh-lines">${chips}</div>` : ''}</div>`;
    }

    // 5. Deriva horària (scheduleDrift)
    if (!data || data.scheduleDrift === null || data.scheduleDrift === undefined) {
      items.push(makeItem('Deriva horària', 'status-neutral', 'Sense dades', 'Sense comprovació de deriva entre operador i graella.'));
    } else if (data.scheduleDrift.drift === true) {
      items.push(makeItem('Deriva horària', 'status-warning', 'Desviació', `Detectada diferència de ${data.scheduleDrift.differencesCount || 1} sortides respecte a la graella.`));
    } else {
      items.push(makeItem('Deriva horària', 'status-success', 'Sincronitzat', 'Horaris de l&#039;operador coincidents amb la graella oficial.'));
    }

    // 6. Temporada de servei (season)
    if (!data || data.season === null || data.season === undefined) {
      items.push(makeItem('Temporada de servei', 'status-neutral', 'Sense dades', 'Sense dades de temporada oficial.'));
    } else if (data.season.seasonKnown) {
      const label = data.season.season === 'summer' ? "Horari d'estiu" : "Horari d'hivern";
      const src = String(data.season.seasonSource || '');
      const srcText = src.startsWith('default')
        ? 'Horari d&#039;hivern per defecte: cap període d&#039;estiu cobreix avui.'
        : (src.startsWith('notice')
          ? `Segons l&#039;avís de l&#039;operador ${this.esc(src.replace(/^notice\s*/, ''))}.`
          : `Temporada vigent segons ${this.esc(src || 'configuració')}.`);
      items.push(makeItem('Temporada de servei', 'status-success', label, srcText));
    } else {
      items.push(makeItem('Temporada de servei', 'status-warning', 'No verificada', `Graella de temporada (${this.esc(data.season.season)}) sense verificar per l&#039;any actual.`));
    }

    // 7. Previsió de temporada (seasonOutlook)
    if (!data || data.seasonOutlook === null || data.seasonOutlook === undefined) {
      items.push(makeItem('Previsió estiu', 'status-neutral', 'Sense dades', 'Sense dades sobre la previsió d&#039;horari d&#039;estiu.'));
    } else if (!data.seasonOutlook.warning) {
      items.push(makeItem('Previsió estiu', 'status-success', 'Configurat', 'Proper període d&#039;estiu configurat al calendari.'));
    } else {
      items.push(makeItem('Previsió estiu', 'status-warning', 'Atenció', this.esc(data.seasonOutlook.warning)));
    }

    // 8. Festius oficials (holidaysKnownForYear)
    if (!data || data.holidaysKnownForYear === null || data.holidaysKnownForYear === undefined) {
      items.push(makeItem('Festius oficials', 'status-neutral', 'Sense dades', 'Sense verificació del calendari laboral de l&#039;any.'));
    } else if (data.holidaysKnownForYear === true) {
      if (data.holidayCoverage && data.holidayCoverage.warning) {
        items.push(makeItem('Festius oficials', 'status-warning', 'Atenció', this.esc(data.holidayCoverage.warning)));
      } else {
        items.push(makeItem('Festius oficials', 'status-success', 'Verificat', 'Festius de Catalunya i locals de Mataró verificats.'));
      }
    } else {
      items.push(makeItem('Festius oficials', 'status-warning', 'Incomplet', this.esc((data.holidayCoverage && data.holidayCoverage.warning) || 'Calendari de festius incomplet') + '. En aquests dies es pot mostrar l&#039;horari de feiner.'));
    }

    // 9. Frescor dels informes (reportFreshness)
    if (!data || data.reportFreshness === null || data.reportFreshness === undefined || !Array.isArray(data.reportFreshness)) {
      items.push(makeItem('Frescor informes', 'status-neutral', 'Sense dades', 'Sense informació d&#039;actualització dels informes.'));
    } else if (data.reportFreshness.length > 0 && data.reportFreshness.every(r => r.fresh)) {
      items.push(makeItem('Frescor informes', 'status-success', 'Al dia', 'Informes de 24 h, 48 h i 7 dies actualitzats.'));
    } else {
      items.push(makeItem('Frescor informes', 'status-warning', 'Regenerant', 'Alguns informes s&#039;estan actualitzant en segon pla.'));
    }

    // Summary line: the one thing to read first.
    const count = tone => items.filter(i => i.tone === tone).length;
    const problems = count('warn') + count('bad');
    const unknown = count('none');
    const summaryTone = count('bad') ? 'bad' : (problems ? 'warn' : (unknown === items.length ? 'none' : 'ok'));
    const summaryText = summaryTone === 'none'
      ? 'Encara no hi ha dades de l&#039;estat del servei.'
      : problems
        ? `${problems} ${problems === 1 ? 'indicador necessita' : 'indicadors necessiten'} atenció.`
        : 'Tot correcte.';
    const unknownText = unknown && summaryTone !== 'none' ? ` ${unknown} sense dades.` : '';
    grid.innerHTML = `
      <p class="dh-summary dh-${summaryTone}"><span class="dh-dot" aria-hidden="true"></span>${summaryText}${unknownText}</p>
      <div class="dh-list">${items.map(i => i.html).join('')}</div>
      ${fleetHtml}`;
  }

  bindEvents() {
    // Refresh Button
    document.getElementById('btn-observatori-refresh')?.addEventListener('click', (e) => {
      e.preventDefault();
      this._incidentCache?.clear();
      this.loadActiveTab(true);
      this.fetchDataHealth();
    });

    // Timeframe tabs (24h, 48h, 7 dies, Termòmetre, Incidents)
    document.querySelectorAll('#journalism-timeframe-tabs button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelectorAll('#journalism-timeframe-tabs button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const dataTab = btn.getAttribute('data-tab');
        if (dataTab === 'termometre') {
          this.currentTab = 'termometre';
          this.updateUrl();
          this.loadTermometre(24);
        } else if (dataTab === 'incidents') {
          this.currentTab = 'incidents';
          this.updateUrl();
          this.openDelayIncidentsTab('all');
        } else if (dataTab === 'monthly') {
          this.currentTab = 'monthly';
          this.updateUrl();
          this.loadMonthlyReport(this._currentMonthlyMonth);
        } else {
          this.currentTab = 'journalism';
          this.currentHours = parseInt(btn.getAttribute('data-hours') || '24', 10);
          this.updateUrl();
          this.loadJournalismReport(this.currentHours);
        }
      });
    });

    // Search input
    const searchInput = document.getElementById('journalism-search-input');
    searchInput?.addEventListener('input', (e) => {
      this.filterText = e.target.value;
      this.updateUrl();
      if (this.currentReport && this.currentTab === 'journalism') {
        this.renderJournalismReport(this.currentReport);
      }
    });

    // Event delegation for table sorting and pagination
    const mainContainer = document.querySelector('.observatori-page-container');
    mainContainer?.addEventListener('click', (e) => {
      // Sorting
      const sortTh = e.target.closest('[data-sort-table][data-sort-key]');
      if (sortTh) {
        e.preventDefault();
        const tableKey = sortTh.getAttribute('data-sort-table');
        const colKey = sortTh.getAttribute('data-sort-key');
        this.handleJournalismSort(tableKey, colKey);
        return;
      }

      // Worst stops limits
      const limitBtn = e.target.closest('[data-worst-limit]');
      if (limitBtn) {
        e.preventDefault();
        const limit = parseInt(limitBtn.getAttribute('data-worst-limit') || '10', 10);
        this.setWorstStopsLimit(limit);
        return;
      }

      // Stop filter mode toggle (bottlenecks vs all)
      const stopModeBtn = e.target.closest('[data-toggle-stop-mode]');
      if (stopModeBtn) {
        e.preventDefault();
        const mode = stopModeBtn.getAttribute('data-toggle-stop-mode');
        if (mode === 'all' || mode === 'bottlenecks') {
          this.stopFilterMode = mode;
          this.updateUrl();
          if (this.currentReport && this.currentTab === 'journalism') {
            this.renderJournalismReport(this.currentReport);
          }
        }
        return;
      }

      // Incident pills: hours
      const hoursPill = e.target.closest('[data-incident-hours]');
      if (hoursPill) {
        e.preventDefault();
        const h = parseInt(hoursPill.dataset.incidentHours, 10) || 168;
        this.openDelayIncidentsView(this._currentIncidentLine || 'all', h, this._currentIncidentMode || 'top');
        return;
      }

      // Incident pills: line
      const linePill = e.target.closest('[data-incident-line]');
      if (linePill) {
        e.preventDefault();
        const line = linePill.dataset.incidentLine;
        this.openDelayIncidentsView(line, this._currentIncidentHours || 168, this._currentIncidentMode || 'top');
        return;
      }

      // Incident mode tabs (top vs investigation vs trips)
      const tabBtn = e.target.closest('[data-incident-tab]');
      if (tabBtn) {
        e.preventDefault();
        const mode = tabBtn.dataset.incidentTab;
        this._currentIncidentMode = mode;
        if (this.lastIncidentData) {
          this.renderDelayIncidentsView(this.lastIncidentData, this._currentIncidentLine || 'all', this._currentIncidentHours || 168, mode);
        } else {
          this.openDelayIncidentsView(this._currentIncidentLine || 'all', this._currentIncidentHours || 168, mode);
        }
        return;
      }

      // Locate stop on main map
      const locateBtn = e.target.closest('[data-locate-stop]');
      if (locateBtn) {
        e.preventDefault();
        const stopName = locateBtn.dataset.locateStop;
        const stopId = locateBtn.dataset.locateStopId;
        const lineCode = locateBtn.dataset.locateLine;
        const cleanLine = String(lineCode || '').toLowerCase().replace(/^l/, '');
        const targetStop = stopId || stopName;
        window.location.href = `/?line=${encodeURIComponent(lineCode)}&stop=${encodeURIComponent(targetStop)}#l${cleanLine}`;
        return;
      }

      // Investigate incident: open forensic drill-down panel
      const investigateBtn = e.target.closest('[data-investigate-stop]');
      if (investigateBtn) {
        e.preventDefault();
        const line = investigateBtn.dataset.investigateLine;
        const stop = investigateBtn.dataset.investigateStop;
        const vehicle = investigateBtn.dataset.investigateVehicle || '';
        const at = investigateBtn.dataset.investigateAt ? Number(investigateBtn.dataset.investigateAt) : undefined;
        this.openIncidentDrilldown(line, stop, at, vehicle);
        return;
      }

      // Copy anomalies report to clipboard
      const copyBtn = e.target.closest('#btn-copy-anomalies-report');
      if (copyBtn) {
        e.preventDefault();
        this.copyAnomaliesReport();
        return;
      }

      // Copy investigation report to clipboard
      const copyInvBtn = e.target.closest('#btn-copy-investigation-report');
      if (copyInvBtn) {
        e.preventDefault();
        this.copyInvestigationReport();
        return;
      }

      // Stop Heatmap: click cell to open stop drilldown menu with that hour highlighted
      const heatCell = e.target.closest('.stop-heat-cell[data-stop-idx]');
      if (heatCell) {
        e.preventDefault();
        const stopIdx = parseInt(heatCell.dataset.stopIdx, 10);
        const hour = parseInt(heatCell.dataset.hour, 10);
        this.openStopHourlyDrilldown(stopIdx, hour);
        return;
      }

      // Stop Heatmap: click stop row header to open stop drilldown menu
      const stopHeader = e.target.closest('.stop-heatmap tbody th[data-stop-idx]');
      if (stopHeader) {
        e.preventDefault();
        const stopIdx = parseInt(stopHeader.dataset.stopIdx, 10);
        this.openStopHourlyDrilldown(stopIdx, null);
        return;
      }

      // Stop Heatmap: click column header to open hourly summary ranking
      const colHeader = e.target.closest('.stop-heatmap thead th[data-hour]');
      if (colHeader) {
        e.preventDefault();
        const hour = parseInt(colHeader.dataset.hour, 10);
        this.openHourSummaryDrilldown(hour);
        return;
      }

      // Inside drilldown modal: click another hour to switch highlight
      const selectHourRow = e.target.closest('[data-select-drilldown-hour]');
      if (selectHourRow) {
        e.preventDefault();
        const h = parseInt(selectHourRow.dataset.selectDrilldownHour, 10);
        if (this._activeDrilldownStopIdx !== undefined && this._activeDrilldownStopIdx !== null) {
          this.openStopHourlyDrilldown(this._activeDrilldownStopIdx, h);
        }
        return;
      }

      // Inside hour summary modal: click a stop to switch to that stop's detail
      const switchStopRow = e.target.closest('[data-switch-stop-idx]');
      if (switchStopRow) {
        e.preventDefault();
        const stopIdx = parseInt(switchStopRow.dataset.switchStopIdx, 10);
        const h = parseInt(switchStopRow.dataset.switchHour, 10);
        this.openStopHourlyDrilldown(stopIdx, h);
        return;
      }

      // Close drilldown modal
      if (e.target.closest('#stop-drilldown-close-btn') || e.target.id === 'stop-drilldown-modal-backdrop') {
        e.preventDefault();
        this.closeStopHourlyDrilldown();
        return;
      }
    });

    // Checkbox toggle: group stops by line
    mainContainer?.addEventListener('change', (e) => {
      const target = e.target;
      if (target && target.id === 'observatori-group-by-line') {
        this.groupByLine = !!target.checked;
        this.updateUrl();
        if (this.currentReport && this.currentTab === 'journalism') {
          this.renderJournalismReport(this.currentReport);
        }
      }
    });

    // Global backdrop click and Escape key listeners for the drilldown modal
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.closeStopHourlyDrilldown();
      }
    });

    document.addEventListener('click', (e) => {
      if (e.target.id === 'stop-drilldown-modal-backdrop') {
        e.preventDefault();
        this.closeStopHourlyDrilldown();
      }
    });

    // Keyboard support for sort headers and heatmap cells
    mainContainer?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        const sortTh = e.target.closest('[data-sort-table][data-sort-key]');
        if (sortTh) {
          e.preventDefault();
          const tableKey = sortTh.getAttribute('data-sort-table');
          const colKey = sortTh.getAttribute('data-sort-key');
          this.handleJournalismSort(tableKey, colKey);
          return;
        }

        const heatCell = e.target.closest('.stop-heat-cell[data-stop-idx]');
        if (heatCell) {
          e.preventDefault();
          const stopIdx = parseInt(heatCell.dataset.stopIdx, 10);
          const hour = parseInt(heatCell.dataset.hour, 10);
          this.openStopHourlyDrilldown(stopIdx, hour);
          return;
        }

        const stopHeader = e.target.closest('.stop-heatmap tbody th[data-stop-idx]');
        if (stopHeader) {
          e.preventDefault();
          const stopIdx = parseInt(stopHeader.dataset.stopIdx, 10);
          this.openStopHourlyDrilldown(stopIdx, null);
          return;
        }

        const colHeader = e.target.closest('.stop-heatmap thead th[data-hour]');
        if (colHeader) {
          e.preventDefault();
          const hour = parseInt(colHeader.dataset.hour, 10);
          this.openHourSummaryDrilldown(hour);
          return;
        }

        const selectHourRow = e.target.closest('[data-select-drilldown-hour]');
        if (selectHourRow) {
          e.preventDefault();
          const h = parseInt(selectHourRow.dataset.selectDrilldownHour, 10);
          if (this._activeDrilldownStopIdx !== undefined && this._activeDrilldownStopIdx !== null) {
            this.openStopHourlyDrilldown(this._activeDrilldownStopIdx, h);
          }
          return;
        }
      }
    });
  }

  loadActiveTab(force = false) {
    if (this.currentTab === 'termometre') {
      this.loadTermometre(24, force);
    } else if (this.currentTab === 'incidents') {
      this.openDelayIncidentsTab(this._currentIncidentLine || 'all', force);
    } else if (this.currentTab === 'monthly') {
      this.loadMonthlyReport(this._currentMonthlyMonth, force);
    } else {
      this.loadJournalismReport(this.currentHours, force);
    }
  }

  // ==========================================
  // 1. JOURNALISM & HISTORICAL DELAY REPORT
  // ==========================================

  async loadJournalismReport(hours = 24, force = false) {
    this.currentHours = hours;
    const contentContainer = document.getElementById('journalism-content-container');
    const termometreContainer = document.getElementById('journalism-termometre-container');
    const incidentsContainer = document.getElementById('journalism-incidents-container');
    const searchBarWrap = document.getElementById('journalism-search-bar-wrap');

    if (searchBarWrap) searchBarWrap.style.display = 'block';
    this.showGpsGaps(true);
    if (contentContainer) contentContainer.style.display = 'block';
    if (termometreContainer) termometreContainer.style.display = 'none';
    if (incidentsContainer) incidentsContainer.style.display = 'none';
    const monthlyContainer = document.getElementById('journalism-monthly-container');
    if (monthlyContainer) monthlyContainer.style.display = 'none';

    if (!this.currentReport || force) {
      if (contentContainer) {
        contentContainer.innerHTML = '<div style="text-align:center; padding:3rem; color:var(--text-muted);"><span class="loading-spinner-inline"></span> Carregant informe de retards i puntualitat del servidor central...</div>';
      }
    }

    try {
      const [res] = await Promise.allSettled([
        fetch(`/api/analytics/journalism?hours=${hours}`).then(r => r.json())
      ]);

      const journalismData = res.status === 'fulfilled' && res.value?.success ? (res.value.report || res.value) : null;

      if (journalismData) {
        this.currentReport = journalismData;
        this.renderJournalismReport(journalismData);
      } else {
        if (contentContainer) {
          contentContainer.innerHTML = '<div style="text-align:center; padding:3rem; color:var(--text-muted);">No hi ha prou dades de retards registrades encara. El servidor està capturant la telemetria contínua.</div>';
        }
      }
    } catch (err) {
      if (contentContainer) {
        contentContainer.innerHTML = `<div style="text-align:center; padding:3rem; color:var(--danger);">Error en carregar informe de periodisme: ${this.esc(err.message)}</div>`;
      }
    }
  }

  handleJournalismSort(tableKey, columnKey) {
    if (!this.sorts) this.sorts = {};
    const current = this.sorts[tableKey] || { key: null, asc: false };
    if (current.key === columnKey) {
      current.asc = !current.asc;
    } else {
      current.key = columnKey;
      current.asc = columnKey === 'lineCode' || columnKey === 'agency' || columnKey === 'stopName' || columnKey === 'overallRank';
    }
    this.sorts[tableKey] = current;
    if (this.currentReport) {
      this.renderJournalismReport(this.currentReport);
    }
  }

  setWorstStopsLimit(limit) {
    this.worstStopsLimit = Number(limit) || 10;
    if (this.currentReport) {
      this.renderJournalismReport(this.currentReport);
    }
  }

  renderJournalismReport(report) {
    const container = document.getElementById('journalism-content-container');
    if (!container) return;

    this.currentReport = report;
    const filterText = (this.filterText || '').trim().toLowerCase();
    const norm = (str) => String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const cleanFilter = norm(filterText);

    const s = report.summary || {};
    const isAllStopsMode = this.stopFilterMode === 'all';
    const allStopsSource = (report.allStopDelays && report.allStopDelays.length > 0)
      ? report.allStopDelays
      : (report.rankingWorstStops || []);
    const bottlenecksSource = (report.rankingWorstStops && report.rankingWorstStops.length > 0)
      ? report.rankingWorstStops
      : allStopsSource.filter(s => s.isBottleneck);

    // Calculate full matching stops vs bottleneck matching stops for contextual notice
    let matchingAllStops = allStopsSource.filter(st => (st.arrivalCount || 0) > 0);
    if (filterText) {
      matchingAllStops = matchingAllStops.filter(st =>
        (st.stopName && (st.stopName.toLowerCase().includes(filterText) || norm(st.stopName).includes(cleanFilter))) ||
        (st.lineCode && (st.lineCode.toLowerCase().includes(filterText) || norm(st.lineCode).includes(cleanFilter))) ||
        (st.agency && (st.agency.toLowerCase().includes(filterText) || norm(st.agency).includes(cleanFilter)))
      );
    }
    const matchingTotalCount = matchingAllStops.length;
    const matchingBottleneckCount = matchingAllStops.filter(s => s.isBottleneck).length;
    const matchingPunctualCount = Math.max(0, matchingTotalCount - matchingBottleneckCount);

    const activeStopsSource = isAllStopsMode ? allStopsSource : bottlenecksSource;

    let mostDelayed = [...(report.rankingMostDelayed || [])].filter(l => (l.sampleCount || 0) > 0 || (l.avgDelay || 0) > 0);
    let worstStops = [...activeStopsSource]
      .filter(st => (st.arrivalCount || 0) > 0)
      .map((st, idx) => ({ ...st, overallRank: idx + 1 }));
    let agencies = [...(report.agencyStats || [])].filter(a => (a.totalSamples || 0) > 0);

    // Filter by search text
    if (filterText) {
      mostDelayed = mostDelayed.filter(l =>
        (l.lineCode && (l.lineCode.toLowerCase().includes(filterText) || norm(l.lineCode).includes(cleanFilter))) ||
        (l.agency && (l.agency.toLowerCase().includes(filterText) || norm(l.agency).includes(cleanFilter))) ||
        (l.name && (l.name.toLowerCase().includes(filterText) || norm(l.name).includes(cleanFilter)))
      );
      worstStops = worstStops.filter(st =>
        (st.stopName && (st.stopName.toLowerCase().includes(filterText) || norm(st.stopName).includes(cleanFilter))) ||
        (st.lineCode && (st.lineCode.toLowerCase().includes(filterText) || norm(st.lineCode).includes(cleanFilter))) ||
        (st.agency && (st.agency.toLowerCase().includes(filterText) || norm(st.agency).includes(cleanFilter)))
      );
      agencies = agencies.filter(a =>
        (a.agency && (a.agency.toLowerCase().includes(filterText) || norm(a.agency).includes(cleanFilter)))
      );
    }

    // Sort list
    const applySort = (list, sortConfig) => {
      if (!sortConfig || !sortConfig.key) return list;
      const { key, asc } = sortConfig;
      return list.sort((a, b) => {
        let valA = a[key];
        let valB = b[key];
        if (typeof valA === 'string') {
          return asc ? valA.localeCompare(valB) : valB.localeCompare(valA);
        }
        valA = Number(valA) || 0;
        valB = Number(valB) || 0;
        return asc ? valA - valB : valB - valA;
      });
    };

    mostDelayed = applySort(mostDelayed, this.sorts.mostDelayed);
    worstStops = applySort(worstStops, this.sorts.worstStops);
    agencies = applySort(agencies, this.sorts.agencies);

    const getSortIndicator = (tableKey, colKey) => {
      const cur = this.sorts[tableKey];
      if (cur && cur.key === colKey) {
        return cur.asc ? '<span style="color:var(--brand-primary); margin-left:4px;">▲</span>' : '<span style="color:var(--brand-primary); margin-left:4px;">▼</span>';
      }
      return '<span style="opacity:0.3; margin-left:4px;">↕</span>';
    };

    let html = `
      <!-- Pre-generated Cache Banner -->
      ${report.meta?.generatedAt ? `
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem; background:rgba(0,148,133,0.08); border:1px solid rgba(0,148,133,0.22); border-radius:10px; padding:0.6rem 0.95rem; margin-bottom:1.25rem; font-size:0.78rem;">
          <div style="display:flex; align-items:center; gap:0.4rem; color:var(--text-primary);">
            <span>⚡</span>
            <span><strong>Informe pregenerat</strong>: compilat a les <strong>${new Date(report.meta.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong> (actualització automàtica cada 30 min)</span>
          </div>
          <div style="display:flex; align-items:center; gap:0.6rem;">
            <span style="color:var(--brand-primary); font-weight:700; font-size:0.75rem;">⏱️ Càrrega instantània</span>
          </div>
        </div>
      ` : ''}

      <!-- KPI Stats Grid -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:0.85rem; margin-bottom:1.5rem;">
        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:1rem;">
          <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase;">Passos per Parada</div>
          <div style="font-size:1.75rem; font-weight:700; color:var(--brand-primary); margin-top:0.25rem;">${(s.totalRecordedArrivals || 0).toLocaleString('ca-ES')}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${s.monitoredLinesCount || 0} línies monitorades${s.hoursAnalyzed ? ` • darreres ${s.hoursAnalyzed} h` : ''}${s.totalSamples ? ` (${s.totalSamples.toLocaleString('ca-ES')} mostres individuals)` : ''}</div>
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:1rem;">
          <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase;">Puntualitat Global</div>
          <div style="font-size:1.75rem; font-weight:700; color:${s.networkPunctualityPct === null || s.networkPunctualityPct === undefined ? 'var(--text-muted)' : (s.networkPunctualityPct >= 85 ? 'var(--accent-live)' : 'var(--accent-warning)')}; margin-top:0.25rem;">${s.networkPunctualityPct === null || s.networkPunctualityPct === undefined ? '—' : `${Number(s.networkPunctualityPct).toLocaleString('ca-ES')}%`}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${s.networkPunctualityPct === null || s.networkPunctualityPct === undefined ? 'Sense passos: la puntualitat no es mesura' : `${Number(s.networkPunctualityPct).toLocaleString('ca-ES')}% puntual · ${Number(s.earlyPct || 0).toLocaleString('ca-ES')}% avançat · ${Number(s.latePct || 0).toLocaleString('ca-ES')}% tard`}</div>
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:1rem;">
          <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase;">Retard Mitjà Xarxa</div>
          <div style="font-size:1.75rem; font-weight:700; color:var(--accent-scheduled); margin-top:0.25rem;">${s.networkAvgDelay === null || s.networkAvgDelay === undefined ? '—' : `${Number(s.networkAvgDelay) > 0 ? '+' : ''}${s.networkAvgDelay} min`}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">Mitjana de totes les mostres del període</div>
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:1rem;">
          <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase;">Retard Màxim Registrat</div>
          <div style="font-size:1.75rem; font-weight:700; color:var(--accent-danger); margin-top:0.25rem;">${s.networkMaxDelay === null || s.networkMaxDelay === undefined ? '—' : `${Number(s.networkMaxDelay) > 0 ? '+' : ''}${s.networkMaxDelay} min`}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${s.networkMaxDelay === null || s.networkMaxDelay === undefined ? 'Sense mostres: no hi ha màxim' : 'Afectació puntual extrema'}</div>
        </div>
      </div>

      <!-- Sampling honesty: extrapolated rows are part of the KPIs above -->
      ${(() => {
        const sb = s.samplingBreakdown;
        if (!sb || !sb.totalSamples || !(sb.nonRealtimeSamples > 0)) return '';
        return `
        <div style="background:rgba(56,189,248,0.06); border:1px solid rgba(56,189,248,0.22); border-radius:10px; padding:0.7rem 0.95rem; margin-bottom:1.25rem; font-size:0.76rem; color:var(--text-secondary); line-height:1.5;">
          <strong style="color:var(--accent-scheduled);">Mostres, no viatges.</strong>
          Aquests KPIs es calculen sobre <strong>${sb.totalSamples.toLocaleString()} mostres individuals</strong> (un registre per senyal de vehicle, no pas viatges).
          D'aquestes, <strong>${sb.nonRealtimeSamples.toLocaleString()} (${sb.nonRealtimePct}%)</strong> són posicions extrapolades
          (dead-reckoning, <code>is_realtime = 0</code>) i no GPS fresc: s'hi inclouen perquè el retard registrat és real,
          però no són una observació directa de la posició del vehicle.
        </div>`;
      })()}

      <!-- Operator delay vs. Arribo's own passing time, on the operator's trip -->
      ${(() => {
        const comp = s.delayMeasurementComparison;
        // A report cached by an older build lacks the operator_trip fields; skip the panel until it is regenerated.
        if (!comp || !comp.hasData || !comp.comparedVisits || comp.method !== 'operator_trip') return '';
        const signed = v => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${Number(v).toLocaleString('ca-ES')} min`);
        const pctStr = v => (v === null || v === undefined ? '—' : `${Number(v).toLocaleString('ca-ES')}%`);
        const tone = v => (v === null || v === undefined ? 'var(--text-muted)' : v >= 75 ? 'var(--accent-live)' : v >= 60 ? 'var(--accent-warning)' : 'var(--accent-danger)');
        const num = v => (Number(v) || 0).toLocaleString('ca-ES');
        const lines = Array.isArray(comp.byLine) ? comp.byLine : [];
        const hours = (Array.isArray(comp.byHour) ? comp.byHour : []).filter(h => h.comparedVisits >= 20);
        return `
        <div style="background:rgba(16,185,129,0.06); border:1px solid rgba(16,185,129,0.25); border-radius:10px; padding:0.8rem 1rem; margin-bottom:1.25rem; font-size:0.78rem; color:var(--text-secondary); line-height:1.5;">
          <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:0.5rem; margin-bottom:0.35rem;">
            <strong style="color:var(--accent-live); font-size:0.84rem;">🎯 Contrast: retard informat vs. pas mesurat</strong>
            <span style="font-size:0.75rem; font-family:var(--font-mono); font-weight:600; background:rgba(16,185,129,0.15); color:${tone(comp.agreementPct)}; padding:0.15rem 0.5rem; border-radius:9999px;">
              ${pctStr(comp.agreementPct)} d'acord (≤1 min)
            </span>
          </div>
          <div>
            Sobre <strong>${num(comp.comparedVisits)} passos per parada</strong>, comparem el retard que informa l'operador
            amb l'hora a què el GPS mostra que el bus ha passat per la parada, mesurada contra l'horari publicat del mateix viatge.
            L'acord diu que el nostre rellotge i el de l'operador coincideixen; no prova que el bus fes aquell viatge (això ho mira la línia següent).
            Retard mitjà informat: <strong>${signed(comp.operatorAvgDelay)}</strong> ·
            mesurat per Arribo!: <strong>${signed(comp.measuredAvgDelay)}</strong> ·
            diferència mitjana: <strong>${signed(comp.biasMins)}</strong>.
          </div>
          <div style="margin-top:0.35rem;">
            <strong>Viatge confirmat de forma independent: ${pctStr(comp.tripConfirmedPct)}</strong>
            (${num(comp.tripConfirmedVisits)} de ${num(comp.tripCheckedVisits)} passos):
            el viatge programat més proper a l'hora de pas és el mateix que indica l'operador.
            La resta són busos amb més retard que mig interval entre busos; per a aquests només l'operador sap quin viatge fan,
            i el contrast es fa sobre el viatge que indica.
          </div>
          ${lines.length ? `
          <div class="observatori-table-wrapper" style="margin-top:0.6rem;">
            <table class="observatori-table">
              <thead>
                <tr>
                  <th class="sticky-col">Línia</th>
                  <th>Passos</th>
                  <th>Acord ≤1 min</th>
                  <th>Diferència mitjana</th>
                  <th>Viatge confirmat</th>
                </tr>
              </thead>
              <tbody>
                ${lines.map(l => {
                  const colour = this.getLineColor(l.lineCode);
                  return `
                <tr>
                  <td class="sticky-col"><span class="observatori-line-badge" style="background:${colour}; color:${this.chipInk(colour)};">${this.esc(l.lineCode)}</span></td>
                  <td>${num(l.comparedVisits)}</td>
                  <td style="font-weight:700; color:${tone(l.agreementPct)};">${pctStr(l.agreementPct)}</td>
                  <td>${signed(l.biasMins)}</td>
                  <td>${pctStr(l.tripConfirmedPct)}</td>
                </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>` : ''}
          ${hours.length ? `
          <div style="margin-top:0.6rem;">
            <div style="font-weight:600; color:var(--text-primary); margin-bottom:0.3rem;">Acord per franja horària</div>
            <div style="display:flex; flex-wrap:wrap; gap:0.35rem;">
              ${hours.map(h => `
              <span title="${num(h.comparedVisits)} passos" style="font-family:var(--font-mono); font-size:0.72rem; padding:0.15rem 0.45rem; border-radius:6px; background:var(--bg-elevated); border:1px solid var(--border-subtle); color:${tone(h.agreementPct)};">
                ${this.esc(h.hour)}h ${pctStr(h.agreementPct)}
              </span>`).join('')}
            </div>
          </div>` : ''}
        </div>`;
      })()}

      <!-- Hourly Delay Distribution & School Congestion Profile -->
      ${(() => {
        const hourly = report.hourlyDelays || [];
        const peakHours = report.peakHours || [];
        if (hourly.length === 0 && peakHours.length === 0) return '';

        const serviceHours = hourly.filter(h => {
          const n = parseInt(h.hour, 10);
          return n >= 6 && n <= 23;
        });
        const maxHDelay = Math.max(2, ...serviceHours.map(h => Number(h.avgDelay) || 0));

        return `
        <div class="hourly-delays-section" style="margin-bottom:1.5rem;">
          <div class="hourly-chart-header">
            <h4 class="hourly-chart-title">
              <span>Distribució Horària (Hores amb Més Retards)</span>
            </h4>
            <div class="hourly-chart-legend">
              <div class="hourly-legend-item">
                <span class="hourly-legend-dot" style="background:#10b981;"></span>
                <span>Puntual (&lt;1.5m)</span>
              </div>
              <div class="hourly-legend-item">
                <span class="hourly-legend-dot" style="background:#f59e0b;"></span>
                <span>Moderat (1.5–3.5m)</span>
              </div>
              <div class="hourly-legend-item">
                <span class="hourly-legend-dot" style="background:#ef4444;"></span>
                <span>Crític (&gt;3.5m)</span>
              </div>
            </div>
          </div>

          <!-- Congestion Bar Chart -->
          <div class="hourly-chart-container" title="Retard mitjà per franja horària">
            ${serviceHours.map(h => {
              const dVal = Number(h.avgDelay) || 0;
              const pctHeight = Math.max(6, Math.min(100, Math.round((dVal / maxHDelay) * 100)));
              const barBg = dVal >= 3.5 
                ? 'linear-gradient(180deg, #ef4444 0%, #b91c1c 100%)' 
                : (dVal >= 1.5 
                    ? 'linear-gradient(180deg, #f59e0b 0%, #b45309 100%)' 
                    : (dVal > 0 
                        ? 'linear-gradient(180deg, #10b981 0%, #047857 100%)' 
                        : 'rgba(255, 255, 255, 0.08)'));
              const delayLabel = dVal > 0 ? `+${dVal}m` : (h.sampleCount > 0 ? '0m' : '-');
              const tooltip = `${h.timeWindow} • Retard mitjà: +${dVal} min • ${h.latePercentage}% viatges tardans (${h.sampleCount} expedicions)`;
              return `
                <div class="hourly-bar-col" title="${this.esc(tooltip)}">
                  <div class="hourly-bar-track">
                    <span class="hourly-bar-val">${delayLabel}</span>
                    <div class="hourly-bar-fill" style="height:${pctHeight}%; background:${barBg};"></div>
                  </div>
                  <span class="hourly-bar-label">${h.hour}h</span>
                </div>
              `;
            }).join('')}
          </div>

          <!-- Peak Hours Ranking & Critical Bottlenecks -->
          ${peakHours.length > 0 ? `
            <div style="font-size:0.85rem; font-weight:700; color:var(--text-secondary); margin-top:0.75rem;">
              Franges amb Més Retards:
            </div>
            <div class="peak-hours-grid" style="margin-top:0.5rem;">
              ${peakHours.slice(0, 3).map((ph, idx) => {
                return `
                <div class="peak-hour-card">
                  <div class="peak-hour-header">
                    <div class="peak-hour-time">
                      <span>${this.esc(ph.timeWindow)}</span>
                      <span style="font-size:0.7rem; color:var(--brand-primary); font-weight:700;">#${idx + 1}</span>
                    </div>
                  </div>

                  <div class="peak-hour-metrics">
                    <div class="peak-hour-stat">
                      <span class="stat-label">Retard Mitjà</span>
                      <strong class="stat-val ${ph.avgDelay >= 3 ? 'severe' : 'warning'}">+${ph.avgDelay} min</strong>
                    </div>
                    <div class="peak-hour-stat">
                      <span class="stat-label">% Afectats</span>
                      <strong class="stat-val">${ph.latePercentage}%</strong>
                    </div>
                    <div class="peak-hour-stat">
                      <span class="stat-label">Expedicions</span>
                      <strong class="stat-val">${(ph.sampleCount || 0).toLocaleString()}</strong>
                    </div>
                  </div>

                  ${ph.worstStopsDuringHour && ph.worstStopsDuringHour.length > 0 ? `
                    <div class="peak-hour-bottlenecks">
                      <span class="bottlenecks-title">Colls d'ampolla en aquesta hora:</span>
                      <div class="bottlenecks-list">
                        ${ph.worstStopsDuringHour.map(bs => `
                          <div class="bottleneck-item">
                            <span class="bottleneck-stop" title="${this.esc(bs.stopName)}">${this.esc(bs.stopName)}</span>
                            <span class="bottleneck-line" style="background:var(--brand-primary);">${this.esc(bs.lineCode)}</span>
                            <span class="bottleneck-delay">+${bs.avgDelay}m</span>
                          </div>
                        `).join('')}
                      </div>
                    </div>
                  ` : ''}
                </div>
              `;
              }).join('')}
            </div>
          ` : ''}
        </div>
        `;
      })()}

      <!-- Ranking: Lines with Most Delays -->
      <div class="observatori-table-container" style="margin-bottom:1.5rem;">
        <div class="observatori-table-header-row">
          <h4 class="observatori-table-title">
            <span>Línies Més Afectades per Retards</span>
            <span class="observatori-table-subtitle">(${mostDelayed.length} línies actives analitzades)</span>
          </h4>
          <span class="observatori-table-subtitle">Clica a les capçaleres per ordenar ↕</span>
        </div>
        ${mostDelayed.length === 0 ? '<div style="color:var(--text-muted); font-size:0.85rem; padding:0.8rem; background:var(--bg-elevated); border-radius:8px;">Cap línia coincideix amb el filtre o no hi ha retards suficients.</div>' : `
          <div class="observatori-table-scroll-hint" aria-hidden="true">
            <span class="scroll-hint-icon">↔</span>
            <span>Desplaça en horitzontal per veure totes les dades</span>
            <span class="scroll-hint-chevron">›</span>
          </div>
          <div class="observatori-table-wrapper">
            <table class="observatori-table">
              <thead>
                <tr>
                  <th class="sticky-col" data-sort-table="mostDelayed" data-sort-key="lineCode" role="button" tabindex="0">Línia ${getSortIndicator('mostDelayed', 'lineCode')}</th>
                  <th data-sort-table="mostDelayed" data-sort-key="avgDelay" role="button" tabindex="0">Retard Mitjà ${getSortIndicator('mostDelayed', 'avgDelay')}</th>
                  <th data-sort-table="mostDelayed" data-sort-key="onTimePercentage" role="button" tabindex="0">% Puntual ${getSortIndicator('mostDelayed', 'onTimePercentage')}</th>
                  <th class="observatori-col-desktop" data-sort-table="mostDelayed" data-sort-key="maxDelay" role="button" tabindex="0">Retard Màxim ${getSortIndicator('mostDelayed', 'maxDelay')}</th>
                  <th class="observatori-col-desktop" data-sort-table="mostDelayed" data-sort-key="sampleCount" role="button" tabindex="0">Passos per parada ${getSortIndicator('mostDelayed', 'sampleCount')}</th>
                  <th class="observatori-col-desktop" data-sort-table="mostDelayed" data-sort-key="agency" role="button" tabindex="0">Operador ${getSortIndicator('mostDelayed', 'agency')}</th>
                </tr>
              </thead>
              <tbody>
                ${mostDelayed.map((l, i) => {
                  const avgStr = Number(l.avgDelay) > 0 ? `+${l.avgDelay} min` : (Number(l.avgDelay) < 0 ? `${l.avgDelay} min` : '0.0 min');
                  const maxStr = Number(l.maxDelay) > 0 ? `+${l.maxDelay} min` : `${l.maxDelay || 0} min`;
                  const onTime = Number(l.onTimePercentage || 0);
                  const isL95 = (l.lineCode || '').toUpperCase() === 'L95';
                  return `
                  <tr>
                    <td class="sticky-col" style="font-weight:700; color:var(--text-primary);">
                      <div class="observatori-line-cell">
                        <span class="observatori-rank-num">#${i + 1}</span>
                        <span class="observatori-line-badge" style="background:var(--brand-primary);">${this.esc(l.lineCode)}</span>
                        <span class="observatori-line-name" title="${this.esc(l.name)}">${this.esc(l.name)}</span>
                      </div>
                    </td>
                    <td style="font-weight:700; color:${Number(l.avgDelay) > 0 ? 'var(--accent-danger)' : 'var(--accent-live)'}; white-space:nowrap;">
                      ${avgStr}
                    </td>
                    <td style="white-space:nowrap;">
                      <div style="display:flex; flex-direction:column; gap:0.2rem;">
                        <div style="display:flex; align-items:center; gap:0.4rem;">
                          <span style="font-weight:600; color:${onTime >= 85 ? 'var(--accent-live)' : 'var(--accent-warning)'}; min-width:34px;">${onTime.toLocaleString('ca-ES')}%</span>
                          <div style="flex:1; max-width:60px; height:5px; background:var(--bg-main); border-radius:3px; overflow:hidden;">
                            <div style="width:${onTime}%; height:100%; background:${onTime >= 85 ? 'var(--accent-live)' : 'var(--accent-warning)'};"></div>
                          </div>
                        </div>
                        <div style="font-size:0.68rem; color:var(--text-muted);">
                          ${onTime.toLocaleString('ca-ES')}% puntual · ${(Number(l.earlyPercentage) || 0).toLocaleString('ca-ES')}% avançat · ${(Number(l.latePercentage) || 0).toLocaleString('ca-ES')}% tard
                        </div>
                      </div>
                    </td>
                    <td class="observatori-col-desktop" style="color:var(--text-muted); white-space:nowrap;">${maxStr}</td>
                    <td class="observatori-col-desktop" style="color:var(--text-muted);">${(l.sampleCount || 0).toLocaleString('ca-ES')}</td>
                    <td class="observatori-col-desktop" style="color:var(--text-muted); font-size:0.75rem;">
                      ${this.esc(l.agency || 'Mataró Bus')}
                      ${isL95 ? '<span style="color:var(--accent-scheduled); font-size:0.7rem; display:block;">ℹ️ L95 exprés: trànsit C-31/C-32</span>' : ''}
                    </td>
                  </tr>
                `;}).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>

      <!-- Ranking: Bottleneck Stops & Stop Heatmap -->
      ${(() => {
        const worstLimit = this.worstStopsLimit || 10;
        const totalWorst = worstStops.length;
        const displayedWorstStops = worstStops.slice(0, worstLimit);
        const hasMoreWorst = totalWorst > worstLimit;
        const isGroupedByLine = !!this.groupByLine;

        let stopNoticeHtml = '';
        if (!isAllStopsMode && matchingPunctualCount > 0) {
          const lineNotice = filterText ? "d'aquesta línia" : 'a la xarxa';
          stopNoticeHtml = `
            <div class="observatori-filter-notice" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.6rem; background:rgba(0,148,133,0.08); border:1px solid rgba(0,148,133,0.25); border-radius:10px; padding:0.65rem 0.95rem; margin-bottom:1rem; font-size:0.8rem;">
              <div style="display:flex; align-items:center; gap:0.55rem; color:var(--text-primary);">
                <span style="font-size:1.15rem; flex-shrink:0;">ℹ️</span>
                <div>
                  <strong>Només es mostren colls d'ampolla</strong> (retard &ge; 1.5 min o &ge; 20% greus).
                  <span style="color:var(--text-muted); margin-left:0.25rem;">Les altres <strong>${matchingPunctualCount}</strong> parades ${lineNotice} han funcionat amb puntualitat (&lt; 1.5 min).</span>
                </div>
              </div>
              <button type="button" class="observatori-action-btn btn-secondary btn-sm" data-toggle-stop-mode="all">
                <span>🔓</span>
                <span>Veure totes les parades (${matchingTotalCount})</span>
              </button>
            </div>
          `;
        } else if (isAllStopsMode) {
          stopNoticeHtml = `
            <div class="observatori-filter-notice" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.6rem; background:rgba(2,132,199,0.08); border:1px solid rgba(56,189,248,0.25); border-radius:10px; padding:0.65rem 0.95rem; margin-bottom:1rem; font-size:0.8rem;">
              <div style="display:flex; align-items:center; gap:0.55rem; color:var(--text-primary);">
                <span style="font-size:1.15rem; flex-shrink:0;">📋</span>
                <div>
                  <strong>Mostrant totes les ${worstStops.length} parades actives</strong> (inclou parades puntuals i colls d'ampolla).
                  <span style="color:var(--text-muted); margin-left:0.25rem;">${matchingBottleneckCount} són colls d'ampolla.</span>
                </div>
              </div>
              <button type="button" class="observatori-action-btn btn-secondary btn-sm" data-toggle-stop-mode="bottlenecks">
                <span>⚠️</span>
                <span>Només colls d'ampolla (${matchingBottleneckCount})</span>
              </button>
            </div>
          `;
        }

        const renderStopRow = (st) => {
          const sAvg = Number(st.avgDelay) || 0;
          const sAvgStr = sAvg > 0 ? `+${st.avgDelay} min` : (sAvg < 0 ? `${st.avgDelay} min` : '0.0 min');
          const sMaxStr = Number(st.maxDelay) > 0 ? `+${st.maxDelay} min` : `${st.maxDelay || 0} min`;
          const lColor = this.getLineColor(st.lineCode);
          const badgeTextColor = this.chipInk(lColor);
          const isSevereStop = sAvg >= 1.5 || (st.severeLatePct || 0) >= 20;
          const avgDelayColor = sAvg >= 1.5 ? 'var(--accent-danger)' : (sAvg >= 0.8 ? 'var(--accent-warning)' : 'var(--accent-live)');
          return `
          <tr>
            <td class="sticky-col" style="font-weight:600; color:var(--text-primary);">
              <div class="observatori-stop-cell">
                <span class="observatori-rank-num ${isSevereStop && st.overallRank <= 3 ? 'rank-' + st.overallRank : ''}" title="Rànquing: #${st.overallRank}">#${st.overallRank}</span>
                <span class="observatori-stop-name" title="${this.esc(st.stopName)}">${this.esc(st.stopName)}</span>
                <span class="observatori-mobile-only" style="background:${lColor}; color:${badgeTextColor}; padding:0.1rem 0.35rem; border-radius:4px; font-size:0.7rem; font-weight:800; margin-left:0.25rem;">${this.esc(st.lineCode)}</span>
              </div>
            </td>
            <td class="observatori-col-desktop" style="font-weight:700; white-space:nowrap; text-align:center;">
              <span class="observatori-line-badge" style="background:${lColor}; color:${badgeTextColor}; font-size:0.72rem; padding:0.12rem 0.45rem; border-radius:4px;">${this.esc(st.lineCode)}</span>
            </td>
            <td class="observatori-col-desktop" style="color:var(--text-muted); white-space:nowrap;">${this.esc(st.agency)}</td>
            <td style="font-weight:700; color:${avgDelayColor}; white-space:nowrap;">${sAvgStr}</td>
            <td style="white-space:nowrap; text-align:center;">
              ${st.severeLatePct > 0 ? `
                <span style="background:${st.severeLatePct >= 30 ? 'rgba(239,68,68,0.2)' : (st.severeLatePct >= 20 ? 'rgba(245,158,11,0.15)' : 'rgba(255,255,255,0.06)')}; color:${st.severeLatePct >= 30 ? 'var(--accent-danger)' : (st.severeLatePct >= 20 ? 'var(--accent-warning)' : 'var(--text-muted)')}; padding:0.15rem 0.45rem; border-radius:6px; font-weight:600;">${st.severeLatePct}%</span>
              ` : '<span style="color:var(--accent-live); font-weight:600; font-size:0.75rem;">0%</span>'}
            </td>
            <td style="white-space:nowrap;">
              ${st.criticalHour && st.criticalHour !== '--' && Number(st.criticalHourAvgDelay) >= 1.5 ? `
                <div class="bottleneck-hour-badge" title="Retard mitjà en aquesta franja: +${st.criticalHourAvgDelay} min">
                  <span class="badge-time">${this.esc(st.criticalHour)}</span>
                  <span class="badge-delay">(+${st.criticalHourAvgDelay}m)</span>
                </div>
              ` : (isSevereStop ? '<span style="color:var(--text-muted); font-size:0.75rem;">Uniforme</span>' : '<span style="color:var(--accent-live); font-size:0.75rem; font-weight:600;">✓ Puntual</span>')}
            </td>
            <td class="observatori-col-desktop" style="color:var(--text-muted); white-space:nowrap;">${sMaxStr}</td>
          </tr>
        `;};

        let tableBodyHtml = '';
        if (!isGroupedByLine) {
          tableBodyHtml = displayedWorstStops.map(st => renderStopRow(st)).join('');
        } else {
          const lineGroups = new Map();
          for (const st of displayedWorstStops) {
            const lCode = st.lineCode || 'Altres';
            if (!lineGroups.has(lCode)) {
              lineGroups.set(lCode, []);
            }
            lineGroups.get(lCode).push(st);
          }

          const sortedLineCodes = Array.from(lineGroups.keys()).sort((a, b) => {
            const numA = parseInt(a.replace(/\D/g, ''), 10);
            const numB = parseInt(b.replace(/\D/g, ''), 10);
            if (!isNaN(numA) && !isNaN(numB) && numA !== numB) return numA - numB;
            return a.localeCompare(b);
          });

          tableBodyHtml = sortedLineCodes.map(lineCode => {
            const lineStops = lineGroups.get(lineCode);
            const lColor = this.getLineColor(lineCode);
            const badgeTextColor = this.chipInk(lColor);
            const lineMatch = (this.availableLines || []).find(l => String(l.code || l.id).toUpperCase() === String(lineCode).toUpperCase());
            const lineTitle = lineMatch?.name || `Línia ${lineCode}`;
            const lineAvg = (lineStops.reduce((sum, s) => sum + (Number(s.avgDelay) || 0), 0) / lineStops.length).toFixed(1);
            const slowestStop = lineStops.reduce((prev, curr) => (prev.overallRank < curr.overallRank ? prev : curr), lineStops[0]);

            return `
              <tr class="observatori-group-header-row">
                <td colspan="7">
                  <div class="observatori-group-header-content">
                    <div class="observatori-group-header-left">
                      <span class="observatori-line-badge" style="background:${lColor}; color:${badgeTextColor}; font-weight:800; font-size:0.75rem; padding:0.15rem 0.45rem; border-radius:4px;">${this.esc(lineCode)}</span>
                      <span style="font-weight:700; color:var(--text-primary); font-size:0.83rem;">${this.esc(lineTitle)}</span>
                      <span style="font-size:0.72rem; color:var(--text-muted); font-weight:500;">(${lineStops.length} ${lineStops.length === 1 ? 'parada' : 'parades'})</span>
                    </div>
                    <div class="observatori-group-header-right">
                      <span>Retard mitjà: <strong style="color:${Number(lineAvg) >= 3 ? 'var(--accent-danger)' : 'var(--accent-warning)'};">+${lineAvg} min</strong></span>
                      <span style="border-left:1px solid var(--border-subtle); padding-left:0.6rem;">Parada més lenta: <strong style="color:var(--brand-primary);">#${slowestStop.overallRank}</strong> (${this.esc(slowestStop.stopName)})</span>
                    </div>
                  </div>
                </td>
              </tr>
              ${lineStops.map(st => renderStopRow(st)).join('')}
            `;
          }).join('');
        }

        return `
        <div class="observatori-table-container" style="margin-bottom:1.5rem;">
          ${stopNoticeHtml}
          <div class="observatori-table-header-row">
            <h4 class="observatori-table-title">
              <span>${isAllStopsMode ? 'Totes les Parades per Retard Mitjà' : "Colls d'Ampolla: Parades amb Més Retard"}</span>
              <span class="observatori-table-subtitle">(Mostrant ${displayedWorstStops.length} de ${totalWorst})</span>
            </h4>
            <div class="observatori-filter-toolbar">
              <div class="observatori-mode-toggle-group">
                <button type="button" class="observatori-pill-btn ${!isAllStopsMode ? 'active' : ''}" data-toggle-stop-mode="bottlenecks" title="Mostra exclusivament les parades amb retards significatius">⚠️ Colls d'ampolla</button>
                <button type="button" class="observatori-pill-btn ${isAllStopsMode ? 'active' : ''}" data-toggle-stop-mode="all" title="Mostra el 100% de les parades registrades, incloent-hi les puntuals">📋 Totes les parades</button>
              </div>
              <label class="observatori-group-toggle" title="Agrupa les parades per línia d'autobús o desmarca per veure l'ordre real">
                <input type="checkbox" id="observatori-group-by-line" ${isGroupedByLine ? 'checked' : ''}>
                <span>Agrupar per línia</span>
              </label>
              <div class="observatori-filter-group" aria-label="Filtre de parades">
                <span class="observatori-filter-label">FILTRE:</span>
                <button type="button" class="observatori-pill-btn ${worstLimit === 10 ? 'active' : ''}" data-worst-limit="10">Top 10</button>
                <button type="button" class="observatori-pill-btn ${worstLimit === 25 ? 'active' : ''}" data-worst-limit="25">Top 25</button>
                <button type="button" class="observatori-pill-btn ${worstLimit >= 9999 ? 'active' : ''}" data-worst-limit="9999">Totes (${totalWorst})</button>
              </div>
            </div>
          </div>
          ${totalWorst === 0 ? `<div style="color:var(--text-muted); font-size:0.85rem; padding:0.8rem; background:var(--bg-elevated); border-radius:8px;">${isAllStopsMode ? 'Cap parada coincideix amb el filtre.' : 'Sense punts negres registrats o cap parada coincideix amb el filtre.'}</div>` : `
            <div class="observatori-table-scroll-hint" aria-hidden="true">
              <span class="scroll-hint-icon">↔</span>
              <span>Desplaça en horitzontal per veure totes les dades</span>
              <span class="scroll-hint-chevron">›</span>
            </div>
            <div class="observatori-table-wrapper">
              <table class="observatori-table">
                <thead>
                  <tr>
                    <th class="sticky-col" data-sort-table="worstStops" data-sort-key="overallRank" role="button" tabindex="0">${isAllStopsMode ? 'Rànquing / Parada' : 'Rànquing / Parada (Punt Negre)'} ${getSortIndicator('worstStops', 'overallRank')}</th>
                    <th class="observatori-col-desktop" data-sort-table="worstStops" data-sort-key="lineCode" role="button" tabindex="0">Línia ${getSortIndicator('worstStops', 'lineCode')}</th>
                    <th class="observatori-col-desktop" data-sort-table="worstStops" data-sort-key="agency" role="button" tabindex="0">Operador ${getSortIndicator('worstStops', 'agency')}</th>
                    <th data-sort-table="worstStops" data-sort-key="avgDelay" role="button" tabindex="0">Retard Mitjà ${getSortIndicator('worstStops', 'avgDelay')}</th>
                    <th data-sort-table="worstStops" data-sort-key="severeLatePct" role="button" tabindex="0">% Retards Greus ${getSortIndicator('worstStops', 'severeLatePct')}</th>
                    <th data-sort-table="worstStops" data-sort-key="criticalHourAvgDelay" role="button" tabindex="0">Hora Crítica (Punta) ${getSortIndicator('worstStops', 'criticalHourAvgDelay')}</th>
                    <th class="observatori-col-desktop" data-sort-table="worstStops" data-sort-key="maxDelay" role="button" tabindex="0">Retard Màx. ${getSortIndicator('worstStops', 'maxDelay')}</th>
                  </tr>
                </thead>
                <tbody>
                  ${tableBodyHtml}
                </tbody>
              </table>
            </div>
            ${hasMoreWorst ? `
              <div style="display:flex; justify-content:center; align-items:center; gap:0.6rem; padding:0.75rem; background:var(--bg-elevated); border-top:1px solid var(--border-subtle); border-radius:0 0 10px 10px;">
                <button type="button" class="btn-primary observatori-action-btn" data-worst-limit="${worstLimit + 15}">
                  ⬇️ Mostra'n 15 més (${displayedWorstStops.length} de ${totalWorst})
                </button>
                <button type="button" class="btn-secondary observatori-action-btn" data-worst-limit="9999">
                  Totes (${totalWorst})
                </button>
              </div>
            ` : ''}
          `}
          ${this.renderStopHeatmap(displayedWorstStops)}
        </div>
        `;
      })()}

      <!-- Ranking: Operators Performance -->
      <div class="observatori-table-container" style="margin-bottom:1.5rem;">
        <div class="observatori-table-header-row">
          <h4 class="observatori-table-title">
            <span style="display:flex; align-items:center; gap:0.4rem;">Comparativa per Empresa Operadora</span>
          </h4>
          <span class="observatori-table-subtitle">Clica a les capçaleres per ordenar ↕</span>
        </div>
        ${agencies.length === 0 ? '<div style="color:var(--text-muted); font-size:0.85rem; padding:0.8rem; background:var(--bg-elevated); border-radius:8px;">Recopilant mostres d\'operadors...</div>' : `
          <div class="observatori-table-scroll-hint" aria-hidden="true">
            <span class="scroll-hint-icon">↔</span>
            <span>Desplaça en horitzontal per veure totes les dades</span>
            <span class="scroll-hint-chevron">›</span>
          </div>
          <div class="observatori-table-wrapper">
            <table class="observatori-table">
            <thead>
              <tr>
                <th class="sticky-col" data-sort-table="agencies" data-sort-key="agency" role="button" tabindex="0">Empresa ${getSortIndicator('agencies', 'agency')}</th>
                <th class="observatori-col-desktop" data-sort-table="agencies" data-sort-key="linesCount" role="button" tabindex="0">Línies ${getSortIndicator('agencies', 'linesCount')}</th>
                <th class="observatori-col-desktop" data-sort-table="agencies" data-sort-key="totalSamples" role="button" tabindex="0">Passos per parada ${getSortIndicator('agencies', 'totalSamples')}</th>
                <th data-sort-table="agencies" data-sort-key="avgDelay" role="button" tabindex="0">Retard Mitjà ${getSortIndicator('agencies', 'avgDelay')}</th>
                <th data-sort-table="agencies" data-sort-key="onTimePct" role="button" tabindex="0">Índex de Puntualitat ${getSortIndicator('agencies', 'onTimePct')}</th>
              </tr>
            </thead>
            <tbody>
              ${agencies.map(a => {
                const aAvg = Number(a.avgDelay) > 0 ? `+${a.avgDelay} min` : (Number(a.avgDelay) < 0 ? `${a.avgDelay} min` : '0.0 min');
                const onTime = a.onTimePct !== undefined && a.onTimePct !== null ? Number(a.onTimePct) : null;
                return `
                <tr>
                  <td class="sticky-col" style="font-weight:700; color:var(--text-primary);">${this.esc(a.agency)}</td>
                  <td class="observatori-col-desktop" style="color:var(--text-muted); text-align:center;">${a.linesCount || 0}</td>
                  <td class="observatori-col-desktop" style="color:var(--text-muted);">${(a.totalVisits || a.totalSamples || 0).toLocaleString('ca-ES')}</td>
                  <td style="font-weight:700; color:${Number(a.avgDelay) > 0 ? 'var(--accent-danger)' : 'var(--accent-live)'}; white-space:nowrap;">${aAvg}</td>
                  <td style="white-space:nowrap;">
                    <span style="font-weight:700; color:${onTime === null ? 'var(--text-muted)' : (onTime >= 85 ? 'var(--accent-live)' : 'var(--accent-warning)')};">${onTime === null ? '—' : `${onTime.toLocaleString('ca-ES')}%`}</span>
                    <span style="font-size:0.7rem; color:var(--text-muted); margin-left:0.3rem;">puntual${a.earlyPct ? ` · ${Number(a.earlyPct).toLocaleString('ca-ES')}% avançat` : ''}${a.latePct ? ` · ${Number(a.latePct).toLocaleString('ca-ES')}% tard` : ''}</span>
                  </td>
                </tr>
              `;}).join('')}
            </tbody>
          </table>
        </div>
      `}
      </div>

    `;

    container.innerHTML = html;
    this.initObservatoriTableScrolls();
  }

  // ==========================================
  // 2. STOP DELAY HEATMAP MATRIX & DRILLDOWNS
  // ==========================================

  getLineColor(code) {
    const match = (this.availableLines || []).find(l => String(l.code || l.id).toUpperCase() === String(code).toUpperCase());
    return match?.color || 'var(--brand-primary)';
  }

  // Text ink for a line-colour chip. Luminance-aware, so pale lines (L5/L6/L7)
  // get dark text instead of the 1.19-1.66:1 white they used to carry. Falls
  // back to white when the colour is a var() we cannot measure.
  chipInk(lineColour) {
    return window.TransitUtils?.chipTextColor?.(lineColour) || '#fff';
  }

  renderStopHeatmap(stops) {
    if (!stops.length) return '';
    if (!stops.every(stop => Array.isArray(stop.hourly))) return '<p>Detall horari pendent de la propera actualització.</p>';

    this._heatmapStops = stops;
    const hasData = h => stops.some(s => (s.hourly?.[h]?.sampleCount || 0) > 0);
    let visibleHours = Array.from({ length: 24 }, (_, h) => h).filter(hasData);
    if (!visibleHours.length) {
      visibleHours = Array.from({ length: 17 }, (_, i) => i + 6);
    }
    this._heatmapVisibleHours = visibleHours;

    const cell = (bucket, stopIdx, h) => {
      const b = bucket || { sampleCount: 0 };
      const label = b.sampleCount ? `${b.avgDelay} min; ${b.sampleCount} mostres; màxim ${b.maxDelay} min; ${b.severeLatePct}% amb retard ≥5 min` : 'Sense dades';
      const level = !b.sampleCount ? 'empty' : b.avgDelay >= 5 ? 'late' : b.avgDelay >= 3 ? 'moderate' : 'regular';
      return `<td class="stop-heat-cell heat-${level}" data-stop-idx="${stopIdx}" data-hour="${h}" role="button" tabindex="0" title="${this.esc(label)} (Clica per obrir el menú de detall)"><span aria-label="${this.esc(label)}">${b.sampleCount ? b.avgDelay : '—'}</span>${b.sampleCount > 0 && b.sampleCount < 5 ? '<small> *</small>' : ''}</td>`;
    };

    return `<section class="stop-hourly-section"><h4>Retard per parada i hora</h4>
      <p>Observacions registrades, no viatges únics ni causes de congestió. Hora local: Europe/Madrid. Valors en minuts. * Menys de 5 mostres. <strong>Clica a qualsevol franja horària o parada per obrir el menú de detall.</strong></p>
      <p class="stop-heat-legend"><span class="heat-regular">Menys de 3 min</span> <span class="heat-moderate">3–5 min</span> <span class="heat-late">5 min o més</span> <span>— Sense dades</span></p>
      <div class="observatori-table-wrapper stop-heatmap-wrapper"><table class="observatori-table stop-heatmap"><caption>Retard mitjà per hora (clica a una franja per al detall)</caption><thead><tr><th scope="col">Parada / línia</th>${visibleHours.map(h => `<th scope="col" data-hour="${h}" role="button" tabindex="0" title="Clica per veure el resum de les ${String(h).padStart(2, '0')}:00h">${String(h).padStart(2, '0')}</th>`).join('')}</tr></thead>
      <tbody>${stops.map((stop, stopIdx) => `<tr><th scope="row" data-stop-idx="${stopIdx}" role="button" tabindex="0" title="Clica per veure el menú de detall de ${this.esc(stop.stopName)}">${this.esc(stop.stopName)} / ${this.esc(stop.lineCode)}</th>${visibleHours.map(h => cell(stop.hourly?.[h], stopIdx, h)).join('')}</tr>`).join('')}</tbody></table></div>
      
      <!-- Single Drilldown Modal Menu -->
      <div class="modal-backdrop" id="stop-drilldown-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="stop-drilldown-modal-title" style="display:none;">
        <div class="modal-card stop-drilldown-modal" id="stop-drilldown-modal-content"></div>
      </div>
    </section>`;
  }

  openStopHourlyDrilldown(stopIdx, selectedHour = null) {
    const stops = this._heatmapStops || [];
    const stop = stops[stopIdx];
    if (!stop) return;

    this._activeDrilldownStopIdx = stopIdx;
    this._activeDrilldownHour = selectedHour !== null ? parseInt(selectedHour, 10) : null;

    const backdrop = document.getElementById('stop-drilldown-modal-backdrop');
    const content = document.getElementById('stop-drilldown-modal-content');
    if (!backdrop || !content) return;

    const visibleHours = this._heatmapVisibleHours || Array.from({ length: 24 }, (_, i) => i);
    const selH = this._activeDrilldownHour;
    const selectedBucket = selH !== null ? stop.hourly?.[selH] : null;
    const lColor = this.getLineColor(stop.lineCode);

    content.innerHTML = `
      <button type="button" class="modal-close-btn" id="stop-drilldown-close-btn" aria-label="Tancar finestra">&times;</button>
      <div class="stop-drilldown-header">
        <div style="display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;">
          <span class="stop-drilldown-line-badge" style="background:${lColor};">${this.esc(stop.lineCode)}</span>
          <h3 class="stop-drilldown-title" id="stop-drilldown-modal-title">${this.esc(stop.stopName)}</h3>
        </div>
        <p class="stop-drilldown-subtitle">
          Detall horari complet • ${stop.arrivalCount} observacions analitzades • Retard mitjà global: <strong>+${stop.avgDelay} min</strong> • Retard màxim: <strong>+${stop.maxDelay || 0} min</strong>
        </p>
      </div>

      ${selH !== null && selectedBucket ? `
        <div class="drilldown-hour-highlight">
          <div class="drilldown-kpi">
            <span class="drilldown-kpi-label">Franja Horària</span>
            <strong class="drilldown-kpi-val">${String(selH).padStart(2, '0')}:00 - ${String(selH).padStart(2, '0')}:59</strong>
          </div>
          <div class="drilldown-kpi">
            <span class="drilldown-kpi-label">Retard Mitjà</span>
            <strong class="drilldown-kpi-val ${selectedBucket.avgDelay >= 5 ? 'severe' : selectedBucket.avgDelay >= 3 ? 'warning' : 'ok'}">
              ${selectedBucket.sampleCount ? `+${selectedBucket.avgDelay} min` : 'Sense dades'}
            </strong>
          </div>
          <div class="drilldown-kpi">
            <span class="drilldown-kpi-label">Mostres Registrades</span>
            <strong class="drilldown-kpi-val">${selectedBucket.sampleCount || 0}</strong>
          </div>
          <div class="drilldown-kpi">
            <span class="drilldown-kpi-label">Retard Màxim</span>
            <strong class="drilldown-kpi-val">${selectedBucket.maxDelay !== null ? `+${selectedBucket.maxDelay} min` : '—'}</strong>
          </div>
          <div class="drilldown-kpi">
            <span class="drilldown-kpi-label">Viatges Retard &ge; 5m</span>
            <strong class="drilldown-kpi-val ${selectedBucket.severeLatePct >= 30 ? 'severe' : selectedBucket.severeLatePct >= 15 ? 'warning' : 'ok'}">
              ${selectedBucket.severeLatePct !== null ? `${selectedBucket.severeLatePct}%` : '—'}
            </strong>
          </div>
        </div>
      ` : ''}

      <div style="font-size:0.78rem; color:var(--text-muted); margin-bottom:0.4rem; display:flex; justify-content:space-between; align-items:center;">
        <span>Clica a qualsevol franja per canviar l'anàlisi destacada</span>
        <span>* Menys de 5 mostres</span>
      </div>

      <div class="observatori-table-wrapper" style="max-height: 48vh; overflow:auto;">
        <table class="observatori-table stop-drilldown-table">
          <thead>
            <tr>
              <th>Hora</th>
              <th>Mostres</th>
              <th>Mitjana (min)</th>
              <th>Màxim (min)</th>
              <th>Retard &ge; 5 min</th>
            </tr>
          </thead>
          <tbody>
            ${stop.hourly.filter(b => visibleHours.includes(parseInt(b.hour, 10))).map(b => {
              const bHour = parseInt(b.hour, 10);
              const isSelected = selH !== null && bHour === selH;
              return `
                <tr class="${isSelected ? 'drilldown-selected-row' : ''}" data-select-drilldown-hour="${bHour}" role="button" tabindex="0" title="Clica per seleccionar les ${b.hour}:00h">
                  <th scope="row" style="font-weight:700;">${b.hour}:00 ${isSelected ? '•' : ''}</th>
                  <td>${b.sampleCount}${b.sampleCount > 0 && b.sampleCount < 5 ? ' *' : ''}</td>
                  <td style="font-weight:${isSelected ? '800' : '600'}; color:${b.avgDelay >= 5 ? 'var(--accent-danger)' : b.avgDelay >= 3 ? 'var(--accent-warning)' : 'var(--text-primary)'};">
                    ${b.avgDelay !== null ? `+${b.avgDelay} min` : '—'}
                  </td>
                  <td>${b.maxDelay !== null ? `+${b.maxDelay} min` : '—'}</td>
                  <td>${b.severeLatePct !== null ? `${b.severeLatePct}%` : '—'}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    backdrop.style.display = 'flex';
    requestAnimationFrame(() => {
      backdrop.classList.add('active');
    });
    document.body.style.overflow = 'hidden';
  }

  openHourSummaryDrilldown(hour) {
    const stops = this._heatmapStops || [];
    const h = parseInt(hour, 10);
    const stopsAtHour = stops.map((s, idx) => ({ ...s, stopIdx: idx, bucket: s.hourly?.[h] }))
      .filter(s => (s.bucket?.sampleCount || 0) > 0)
      .sort((a, b) => (b.bucket.avgDelay || 0) - (a.bucket.avgDelay || 0));

    const backdrop = document.getElementById('stop-drilldown-modal-backdrop');
    const content = document.getElementById('stop-drilldown-modal-content');
    if (!backdrop || !content) return;

    content.innerHTML = `
      <button type="button" class="modal-close-btn" id="stop-drilldown-close-btn" aria-label="Tancar finestra">&times;</button>
      <div class="stop-drilldown-header">
        <div style="display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;">
          <span class="stop-drilldown-line-badge" style="background:var(--brand-primary);">⏰ ${String(h).padStart(2, '0')}:00h</span>
          <h3 class="stop-drilldown-title" id="stop-drilldown-modal-title">Franja Horària ${String(h).padStart(2, '0')}:00 - ${String(h).padStart(2, '0')}:59</h3>
        </div>
        <p class="stop-drilldown-subtitle">
          Comparativa de retards a totes les parades a aquesta hora • ${stopsAtHour.length} parades registrades amb servei
        </p>
      </div>

      <div style="font-size:0.78rem; color:var(--text-muted); margin-bottom:0.4rem;">
        Clica a qualsevol parada per obrir el seu menú horari complet
      </div>

      <div class="observatori-table-wrapper" style="max-height: 55vh; overflow:auto;">
        <table class="observatori-table stop-drilldown-table">
          <thead>
            <tr>
              <th style="width:40px; text-align:center;">#</th>
              <th>Parada / Línia</th>
              <th>Mostres</th>
              <th>Retard Mitjà</th>
              <th>Retard Màxim</th>
              <th>Retard &ge; 5 min</th>
            </tr>
          </thead>
          <tbody>
            ${stopsAtHour.length === 0 ? `
              <tr><td colspan="6" style="text-align:center; padding:1.5rem; color:var(--text-muted);">Sense dades d'expedicions en aquesta franja horària.</td></tr>
            ` : stopsAtHour.map((s, idx) => {
              const b = s.bucket;
              const lColor = this.getLineColor(s.lineCode);
              return `
                <tr data-switch-stop-idx="${s.stopIdx}" data-switch-hour="${h}" role="button" tabindex="0" style="cursor:pointer;" title="Clica per obrir el detall complet de ${this.esc(s.stopName)}">
                  <td style="font-weight:700; color:var(--text-muted); text-align:center;">${idx + 1}</td>
                  <td style="font-weight:600; color:var(--text-primary);">
                    <div style="display:flex; align-items:center; gap:0.4rem;">
                      <span style="background:${lColor}; color:${this.chipInk(lColor)}; padding:0.1rem 0.35rem; border-radius:4px; font-size:0.7rem; font-weight:800;">${this.esc(s.lineCode)}</span>
                      <span>${this.esc(s.stopName)}</span>
                    </div>
                  </td>
                  <td>${b.sampleCount}${b.sampleCount > 0 && b.sampleCount < 5 ? ' *' : ''}</td>
                  <td style="font-weight:700; color:${b.avgDelay >= 5 ? 'var(--accent-danger)' : b.avgDelay >= 3 ? 'var(--accent-warning)' : 'var(--text-primary)'};">
                    ${b.avgDelay !== null ? `+${b.avgDelay} min` : '—'}
                  </td>
                  <td>${b.maxDelay !== null ? `+${b.maxDelay} min` : '—'}</td>
                  <td>${b.severeLatePct !== null ? `${b.severeLatePct}%` : '—'}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    backdrop.style.display = 'flex';
    requestAnimationFrame(() => {
      backdrop.classList.add('active');
    });
    document.body.style.overflow = 'hidden';
  }

  closeStopHourlyDrilldown() {
    const backdrop = document.getElementById('stop-drilldown-modal-backdrop');
    if (backdrop) {
      backdrop.classList.remove('active');
      setTimeout(() => {
        backdrop.style.display = 'none';
      }, 200);
    }
    document.body.style.overflow = '';
  }

  initObservatoriTableScrolls() {
    requestAnimationFrame(() => {
      const wrappers = document.querySelectorAll('.observatori-table-wrapper');
      wrappers.forEach(wrapper => {
        const updateScrollState = () => {
          const maxScroll = wrapper.scrollWidth - wrapper.clientWidth;
          const canScroll = maxScroll > 4;

          const parentContainer = wrapper.closest('.observatori-table-container');
          const hint = parentContainer ? parentContainer.querySelector('.observatori-table-scroll-hint') : null;

          if (canScroll) {
            wrapper.classList.toggle('has-scroll-left', wrapper.scrollLeft > 5);
            wrapper.classList.toggle('has-scroll-right', wrapper.scrollLeft < maxScroll - 5);
            wrapper.classList.toggle('is-scrolled', wrapper.scrollLeft > 5);
            if (hint) {
              hint.style.display = (window.innerWidth <= 768) ? 'inline-flex' : 'none';
            }
          } else {
            wrapper.classList.remove('has-scroll-left', 'has-scroll-right', 'is-scrolled');
            if (hint) {
              hint.style.display = 'none';
            }
          }

          const maxScrollY = wrapper.scrollHeight - wrapper.clientHeight;
          if (maxScrollY > 4) {
            wrapper.classList.toggle('is-scrolled-vertical', wrapper.scrollTop > 5);
          } else {
            wrapper.classList.remove('is-scrolled-vertical');
          }
        };

        if (wrapper._observatoriScrollHandler) {
          wrapper.removeEventListener('scroll', wrapper._observatoriScrollHandler);
        }
        wrapper._observatoriScrollHandler = updateScrollState;
        wrapper.addEventListener('scroll', updateScrollState, { passive: true });

        updateScrollState();
      });
    });
  }

  // ==========================================
  // 3. EL TERMÒMETRE SCORECARD & INFOGRAPHIC
  // ==========================================

  async loadTermometre(hours = 24, force = false) {
    const termometreContainer = document.getElementById('journalism-termometre-container');
    const contentContainer = document.getElementById('journalism-content-container');
    const incidentsContainer = document.getElementById('journalism-incidents-container');
    const searchBarWrap = document.getElementById('journalism-search-bar-wrap');

    if (searchBarWrap) searchBarWrap.style.display = 'none';
    if (contentContainer) contentContainer.style.display = 'none';
    if (incidentsContainer) incidentsContainer.style.display = 'none';
    const monthlyContainer = document.getElementById('journalism-monthly-container');
    if (monthlyContainer) monthlyContainer.style.display = 'none';
    if (termometreContainer) {
      termometreContainer.style.display = 'block';
      this.showGpsGaps(false);
      if (!this.termometreData || force) {
        termometreContainer.innerHTML = '<div style="text-align:center; padding:3rem;"><span class="loading-spinner-inline"></span> Generant la fitxa del Termòmetre...</div>';
      }
    }

    try {
      const res = await fetch(`/api/analytics/termometre?hours=${hours}`).then(r => r.json());
      if (res && res.success && res.termometre) {
        this.termometreData = res.termometre;
        this.renderTermometreScorecard(res.termometre);
      } else {
        if (termometreContainer) {
          termometreContainer.innerHTML = '<div style="color:var(--danger); text-align:center; padding:2rem;">No s\'ha pogut generar el Termòmetre.</div>';
        }
      }
    } catch {
      if (termometreContainer) {
        termometreContainer.innerHTML = '<div style="color:var(--danger); text-align:center; padding:2rem;">Error de connexió al carregar el Termòmetre.</div>';
      }
    }
  }

  renderTermometreScorecard(t) {
    const container = document.getElementById('journalism-termometre-container');
    if (!container || !t) return;

    // An empty window is NOT a perfect score. The API sends explicit nulls and
    // noData:true; the old renderer substituted its own placeholder scorecard
    // (grade "A", L1 at 95%, "Pl. Tereses", 08:00-09:00 peak) and the share and
    // PNG exporters published those invented numbers as real measurements.
    // A payload that grades a scorecard while analysing zero trips is
    // self-contradictory, so it is treated as no-data too — that also covers a
    // report cache written before this contract existed.
    if (t.noData || t.grade === null || t.grade === undefined || (t.totalTripsAnalyzed || 0) === 0) {
      this._renderTermometreNoData(container, t);
      return;
    }

    // Two forms of the same grade colour, deliberately. gradeColorCss drives
    // the in-page badge and must follow the theme (the old hexes were 1.8-2.1:1
    // on the light surface). gradeColorSvg feeds the downloadable SVG further
    // down, which is a standalone dark-navy image where CSS custom properties
    // do not resolve — a var() there would paint as black/nothing.
    const isGradeA = t.grade && t.grade.startsWith('A');
    const isGradeB = t.grade && t.grade.startsWith('B');
    const isGradeC = t.grade && t.grade.startsWith('C');
    const gradeColorCss = isGradeA ? 'var(--accent-live)' : (isGradeB ? 'var(--accent-scheduled)' : (isGradeC ? 'var(--accent-warning)' : 'var(--accent-danger)'));
    const gradeColor = isGradeA ? '#10b981' : (isGradeB ? '#38bdf8' : (isGradeC ? '#f59e0b' : '#ef4444'));
    // A missing sub-value stays missing. Each `—` below means "not measured",
    // which is different from a measured 0.
    const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);
    const mins = (v) => (v === null || v === undefined ? '—' : `+${v} min`);
    const championPct = t.championLine && t.championLine.onTimePct !== null && t.championLine.onTimePct !== undefined
      ? `${t.championLine.onTimePct}%` : '—';

    container.innerHTML = `
      <div class="termometre-scorecard" id="termometre-card-root">
        <div class="termometre-header">
          <div>
            <span style="font-size:0.75rem; font-weight:800; color:var(--accent-scheduled); text-transform:uppercase; letter-spacing:0.5px;">Observatori Cívic de Mobilitat</span>
            <h3 style="font-size:1.35rem; font-weight:800; color:var(--text-primary); margin:0.2rem 0;">El Termòmetre del Bus Mataró</h3>
            <span style="font-size:0.78rem; color:var(--text-muted);">Auditoria independent basada en mostres reals de telemetria GPS</span>
          </div>
          <div class="termometre-grade-badge" style="border-color:${gradeColorCss}; background:rgba(16,185,129,0.12);">
            <div>
              <div style="font-size:0.65rem; font-weight:800; color:var(--text-muted); text-transform:uppercase;">Nota Global</div>
              <div class="termometre-grade-letter" style="color:${gradeColorCss};">${this.esc(t.grade)}</div>
            </div>
          </div>
        </div>

        <div class="termometre-metrics-grid">
          <div class="termometre-metric-tile" style="border-left:3px solid var(--accent-live);">
            <span class="termometre-metric-label">Línia Més Puntual</span>
            <span class="termometre-metric-val" style="color:var(--accent-live);">
              ${t.championLine ? this.esc(t.championLine.code) : '—'} (${championPct} puntual)
            </span>
            <span style="font-size:0.72rem; color:var(--text-muted);">Retard mitjà: ${t.championLine ? mins(t.championLine.avgDelay) : '—'}</span>
          </div>

          <div class="termometre-metric-tile" style="border-left:3px solid var(--accent-danger);">
            <span class="termometre-metric-label">Punt Negre / Retards</span>
            <span class="termometre-metric-val" style="color:var(--accent-danger); font-size:1rem;">
              ${t.worstBottleneck ? this.esc(t.worstBottleneck.stopName) : '—'}
            </span>
            <span style="font-size:0.72rem; color:var(--text-muted);">${t.worstBottleneck ? this.esc(t.worstBottleneck.lineCode || '') : ''} • ${t.worstBottleneck ? mins(t.worstBottleneck.avgDelay) : '—'} retard mitjà</span>
          </div>

          <div class="termometre-metric-tile" style="border-left:3px solid var(--accent-warning);">
            <span class="termometre-metric-label">Franja de Major Congestió</span>
            <span class="termometre-metric-val" style="color:var(--accent-warning);">
              ${t.peakHour ? this.esc(t.peakHour) : '—'}
            </span>
            <span style="font-size:0.72rem; color:var(--text-muted);">${t.peakHour ? mins(t.peakHourDelay) : '—'} de retard mitjà a la xarxa</span>
          </div>

          <div class="termometre-metric-tile" style="border-left:3px solid var(--accent-scheduled);">
            <span class="termometre-metric-label">Puntualitat Global</span>
            <span class="termometre-metric-val" style="color:var(--accent-scheduled);">
              ${pct(t.punctualityPct)}
            </span>
            <span style="font-size:0.72rem; color:var(--text-muted);">${(t.totalTripsAnalyzed || 0).toLocaleString('ca-ES')} passos per parada</span>
          </div>
        </div>

        <div class="termometre-actions-row">
          <div style="font-size:0.75rem; color:var(--text-muted);">
            Dades de les darreres ${t.timeframeHours || 24} hores
          </div>
          <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
            <button type="button" class="btn-primary btn-termometre-action" id="btn-termometre-share">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              <span>Copiar Resum per Xarxes</span>
            </button>
            <button type="button" class="btn-secondary btn-termometre-action" id="btn-termometre-download">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              <span>Descarregar Fitxa</span>
            </button>
          </div>
        </div>
      </div>
    `;

    document.getElementById('btn-termometre-share')?.addEventListener('click', (e) => {
      e.preventDefault();
      const shareText = `🌡️ El Termòmetre del Bus a Mataró (${t.timeframeHours || 24}h)\n\n` +
        `• Nota Global: ${t.grade} (${pct(t.punctualityPct)} puntualitat)\n` +
        `• 🏆 Línia més puntual: ${t.championLine ? t.championLine.code : '—'} (${championPct})\n` +
        `• ⚠️ Punt negre: ${t.worstBottleneck ? t.worstBottleneck.stopName : '—'} (${t.worstBottleneck ? mins(t.worstBottleneck.avgDelay) : '—'})\n` +
        `• ⏱️ Hora punta: ${t.peakHour || '—'}\n` +
        `• Passos per parada analitzats: ${(t.totalTripsAnalyzed || 0).toLocaleString('ca-ES')}\n\n` +
        `Font: Arribo! Mataró — Dades obertes i telemetria ciutadana.`;

      if (navigator.clipboard) {
        navigator.clipboard.writeText(shareText).then(() => {
          alert("Resum copiat al porta-retalls! Ja el pots enganxar a Twitter, Telegram o premsa.");
        });
      } else {
        prompt("Copia el resum:", shareText);
      }
    });

    document.getElementById('btn-termometre-download')?.addEventListener('click', (e) => {
      e.preventDefault();
      const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 420" width="800" height="420" style="background:#0f172a; font-family:sans-serif;">
  <rect width="800" height="420" fill="#0f172a" rx="16"/>
  <text x="40" y="50" fill="#38bdf8" font-size="14" font-weight="bold" letter-spacing="1">OBSERVATORI CÍVIC DE MOBILITAT</text>
  <text x="40" y="85" fill="#ffffff" font-size="26" font-weight="bold">🌡️ El Termòmetre del Bus Mataró</text>
  <text x="40" y="110" fill="#94a3b8" font-size="13">Informe de puntualitat i retards (${t.timeframeHours || 24}h)</text>

  <rect x="660" y="35" width="95" height="75" rx="10" fill="#1e293b" stroke="${gradeColor}" stroke-width="2"/>
  <text x="707" y="58" fill="#94a3b8" font-size="11" text-anchor="middle" font-weight="bold">NOTA</text>
  <text x="707" y="96" fill="${gradeColor}" font-size="34" text-anchor="middle" font-weight="bold">${this.esc(t.grade)}</text>

  <rect x="40" y="140" width="345" height="100" rx="10" fill="#1e293b" stroke="#10b981" stroke-width="1.5"/>
  <text x="60" y="170" fill="#10b981" font-size="13" font-weight="bold">🏆 LÍNIA MÉS PUNTUAL</text>
  <text x="60" y="202" fill="#ffffff" font-size="20" font-weight="bold">${t.championLine ? this.esc(t.championLine.code) : '—'} (${championPct} puntual)</text>
  <text x="60" y="225" fill="#94a3b8" font-size="12">Retard mitjà: ${t.championLine ? mins(t.championLine.avgDelay) : '—'}</text>

  <rect x="415" y="140" width="345" height="100" rx="10" fill="#1e293b" stroke="#ef4444" stroke-width="1.5"/>
  <text x="435" y="170" fill="#ef4444" font-size="13" font-weight="bold">⚠️ PUNT NEGRE / RETARDS</text>
  <text x="435" y="202" fill="#ffffff" font-size="18" font-weight="bold">${t.worstBottleneck ? this.esc(t.worstBottleneck.stopName) : '—'}</text>
  <text x="435" y="225" fill="#94a3b8" font-size="12">${t.worstBottleneck ? this.esc(t.worstBottleneck.lineCode || '') : ''} • ${t.worstBottleneck ? mins(t.worstBottleneck.avgDelay) : '—'} retard mitjà</text>

  <rect x="40" y="260" width="345" height="100" rx="10" fill="#f59e0b" stroke="#1.5"/>
  <text x="60" y="290" fill="#f59e0b" font-size="13" font-weight="bold">⏱️ HORA PUNTA CONGESTIÓ</text>
  <text x="60" y="322" fill="#ffffff" font-size="20" font-weight="bold">${t.peakHour ? this.esc(t.peakHour) : '—'}</text>
  <text x="60" y="345" fill="#94a3b8" font-size="12">${t.peakHour ? mins(t.peakHourDelay) : '—'} de retard mitjà a la xarxa</text>

  <rect x="415" y="260" width="345" height="100" rx="10" fill="#1e293b" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="435" y="290" fill="#38bdf8" font-size="13" font-weight="bold">🌐 PUNTUALITAT GLOBAL</text>
  <text x="435" y="322" fill="#ffffff" font-size="20" font-weight="bold">${pct(t.punctualityPct)} (${(t.totalTripsAnalyzed || 0).toLocaleString()} mostres)</text>
  <text x="435" y="345" fill="#94a3b8" font-size="12">Mitjana xarxa: ${mins(t.networkAvgDelay)} retard</text>

  <text x="40" y="395" fill="#64748b" font-size="12">Arribo! Mataró • Dades oficials en temps real • Avanza / Ajuntament de Mataró</text>
</svg>`;
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `termometre-bus-mataro-${t.timeframeHours || 24}h.svg`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  /**
   * Honest empty state: no grade, no invented champion line, no invented
   * bottleneck, no invented peak hour, and the share/PNG buttons are withheld
   * because there is nothing true to export.
   */
  _renderTermometreNoData(container, t) {
    const hours = (t && t.timeframeHours) || 24;
    container.innerHTML = `
      <div class="termometre-scorecard" id="termometre-card-root">
        <div class="termometre-header">
          <div>
            <span style="font-size:0.75rem; font-weight:800; color:var(--accent-scheduled); text-transform:uppercase; letter-spacing:0.5px;">Observatori Cívic de Mobilitat</span>
            <h3 style="font-size:1.35rem; font-weight:800; color:var(--text-primary); margin:0.2rem 0;">El Termòmetre del Bus Mataró</h3>
            <span style="font-size:0.78rem; color:var(--text-muted);">Dades de les darreres ${hours} hores</span>
          </div>
          <div class="termometre-grade-badge" style="border-color:var(--border-subtle); background:rgba(148,163,184,0.08);">
            <div>
              <div style="font-size:0.65rem; font-weight:800; color:var(--text-muted); text-transform:uppercase;">Nota Global</div>
              <div class="termometre-grade-letter" style="color:var(--text-muted);">—</div>
            </div>
          </div>
        </div>

        <div style="margin:1.25rem 0; padding:1rem 1.1rem; background:rgba(251,191,36,0.07); border:1px solid rgba(251,191,36,0.25); border-radius:10px; font-size:0.82rem; line-height:1.5; color:var(--text-secondary);">
          <strong style="color:var(--accent-warning);">Sense dades per puntuar.</strong>
          No hi ha cap mostra de retard registrada en aquesta finestra temporal, així que no hi ha nota global,
          ni línia més puntual, ni punt negre, ni hora punta. Aquest Termòmetre no es publica ni s'exporta
          fins que hi hagi mostres reals: sense mostres, la puntualitat no es mesura.
        </div>

        <div class="termometre-metrics-grid">
          <div class="termometre-metric-tile" style="border-left:3px solid var(--border-subtle);">
            <span class="termometre-metric-label">Línia Més Puntual</span>
            <span class="termometre-metric-val" style="color:var(--text-muted);">—</span>
            <span style="font-size:0.72rem; color:var(--text-muted);">Sense mostres</span>
          </div>
          <div class="termometre-metric-tile" style="border-left:3px solid var(--border-subtle);">
            <span class="termometre-metric-label">Punt Negre / Retards</span>
            <span class="termometre-metric-val" style="color:var(--text-muted); font-size:1rem;">—</span>
            <span style="font-size:0.72rem; color:var(--text-muted);">Sense mostres</span>
          </div>
          <div class="termometre-metric-tile" style="border-left:3px solid var(--border-subtle);">
            <span class="termometre-metric-label">Franja de Major Congestió</span>
            <span class="termometre-metric-val" style="color:var(--text-muted);">—</span>
            <span style="font-size:0.72rem; color:var(--text-muted);">Sense mostres</span>
          </div>
          <div class="termometre-metric-tile" style="border-left:3px solid var(--border-subtle);">
            <span class="termometre-metric-label">Puntualitat Global</span>
            <span class="termometre-metric-val" style="color:var(--text-muted);">—</span>
            <span style="font-size:0.72rem; color:var(--text-muted);">0 passos per parada</span>
          </div>
        </div>
      </div>
    `;
  }

  // ==========================================
  // 4. TOP INCIDENTS (+25M) DEEP-DIVE
  // ==========================================

  openDelayIncidentsTab(lineCode = 'all', force = false) {
    const incidentsContainer = document.getElementById('journalism-incidents-container');
    const termometreContainer = document.getElementById('journalism-termometre-container');
    const contentContainer = document.getElementById('journalism-content-container');
    const searchBarWrap = document.getElementById('journalism-search-bar-wrap');

    if (searchBarWrap) searchBarWrap.style.display = 'none';
    if (contentContainer) contentContainer.style.display = 'none';
    if (termometreContainer) termometreContainer.style.display = 'none';
    const monthlyContainer = document.getElementById('journalism-monthly-container');
    if (monthlyContainer) monthlyContainer.style.display = 'none';
    if (incidentsContainer) incidentsContainer.style.display = 'block';
    this.showGpsGaps(false);

    const hours = this._currentIncidentHours || 168;
    this.openDelayIncidentsView(lineCode, hours, this._currentIncidentMode || 'top', 0, force);
  }

  async openDelayIncidentsView(lineCode = 'all', hours = 168, viewMode = 'top', retryCount = 0, forceRefresh = false) {
    this._currentIncidentLine = lineCode;
    this._currentIncidentHours = hours;
    this._currentIncidentMode = viewMode;

    const container = document.getElementById('journalism-incidents-container');
    if (!container) return;

    const cacheKey = `${lineCode}:${hours}`;
    if (!forceRefresh && retryCount === 0 && this._incidentCache) {
      const cached = this._incidentCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp < 45000)) {
        this.lastIncidentData = cached.data;
        this.renderDelayIncidentsView(cached.data, lineCode, hours, viewMode);
        return;
      }
    }

    const cleanLabel = (lineCode === 'all' || lineCode === 'ALL') ? 'tota la xarxa' : lineCode;
    const retryMsg = retryCount > 0 ? ' (sincronitzant amb el procés de fons...)' : '';
    container.innerHTML = `
      <div style="text-align:center; padding:3rem 1rem; color:var(--text-muted);">
        <span class="loading-spinner-inline" style="width:24px; height:24px; border-width:3px; margin-bottom:0.75rem;"></span>
        <div style="font-weight:700; font-size:0.95rem; color:var(--text-primary); margin-top:0.5rem;">Analitzant telemetria històrica...</div>
        <div style="font-size:0.8rem; margin-top:0.25rem;">Cercant incidents crítics i traçant trajectòries per a ${cleanLabel}${retryMsg}</div>
      </div>
    `;

    try {
      const cleanLine = encodeURIComponent(lineCode);
      const res = await fetch(`/api/analytics/incidents?line=${cleanLine}&hours=${hours}&limit=30&minDelay=5`).then(r => r.json());
      if (res && res.success) {
        if (this._incidentCache) {
          this._incidentCache.set(cacheKey, { data: res, timestamp: Date.now() });
        }
        this.lastIncidentData = res;
        this.renderDelayIncidentsView(res, lineCode, hours, viewMode);
      } else {
        if (retryCount === 0) {
          setTimeout(() => this.openDelayIncidentsView(lineCode, hours, viewMode, 1, forceRefresh), 2000);
          return;
        }
        this.renderIncidentErrorState(container, lineCode, hours, viewMode);
      }
    } catch {
      if (retryCount === 0) {
        setTimeout(() => this.openDelayIncidentsView(lineCode, hours, viewMode, 1, forceRefresh), 2000);
        return;
      }
      this.renderIncidentErrorState(container, lineCode, hours, viewMode);
    }
  }

  async openIncidentDrilldown(lineCode, stopName, at, vehicleId = '') {
    const panel = document.getElementById('incident-drilldown-panel');
    const content = document.getElementById('drilldown-content');
    const summary = document.getElementById('drilldown-summary');
    if (!panel || !content || !summary) return;
    panel.style.display = 'block';
    content.innerHTML = '<span style="color:var(--text-muted);">Carregant investigació…</span>';
    summary.innerHTML = '';
    panel.scrollIntoView({ behavior: 'smooth' });
    try {
      const params = new URLSearchParams({ line: lineCode, stop: stopName });
      if (at > 0) params.set('at', String(at));
      // The vehicle is what makes the episode a single bus. Sending it is what
      // stops the drill-down from resolving to a neighbour that touched the
      // same stop inside the window.
      if (vehicleId) params.set('vehicle', vehicleId);
      const res = await fetch(`/api/analytics/incidents/inspect?${params}`);
      const data = await res.json();
      if (!data || data.found === false) {
        content.innerHTML = `<span style="color:var(--accent-danger);">No es poden carregar mostres en aquesta finestra. ${data?.error || ''}</span>`;
        summary.innerHTML = `<p style="color:var(--text-muted); font-size:0.82rem;">Cap mostra amb retard ≥5 minuts en els darrers 60 minuts per ${this.esc(lineCode)} @ ${this.esc(stopName)}.</p>`;
        return;
      }
      const ep = data.episode || {};
      const ev = ep.evidence || {};
      // The bus's whole run around the clicked delay (server: episode.run), grouped
      // by trip. The clicked stop alone often holds a single sample, which read as
      // "the bus only sent one GPS ping" when it had reported all along its route.
      const run = ep.run && Array.isArray(ep.run.stops) && ep.run.stops.length ? ep.run : null;
      const trips = run && Array.isArray(run.trips) ? run.trips : [];
      const sum = run ? (run.summary || {}) : {};
      const bus = Array.isArray(ep.distinctVehicles) && ep.distinctVehicles.length === 1 ? ep.distinctVehicles[0] : '';
      const signed = v => (Number(v) > 0 ? `+${v}` : String(v));
      const hhmm = t => String(t || '').slice(0, 5);
      const range = sum.fromTime && sum.toTime ? ` (${hhmm(sum.fromTime)}–${hhmm(sum.toTime)})` : '';
      const stopsWord = n => (n === 1 ? '1 parada' : `${n} parades`);

      // What happened, in one plain sentence. Token colours only (light + dark).
      let headline;
      const dh = ep.deadheadReturn || null;
      // Catalan elision: "d'Euskadi", "de Rodalies".
      const afterStop = name => (/^[aeiouàèéíïòóúüh]/i.test(String(name || '')) ? `d'${this.esc(name)}` : `de ${this.esc(name)}`);
      if (ep.verdict === 'deadhead_return' && dh) {
        headline = { tone: 'var(--accent-warning)', title: 'Tornada sense servei', text: `Aquest registre no és un pas real. Després ${afterStop(dh.lastServedStop)} (${this.esc(dh.lastServedTime)}) el bus ${this.esc(dh.vehicleId)} va deixar de fer servei i va tornar sense passatgers fins a ${this.esc(dh.resumeStop)}, on consta a les ${this.esc(dh.resumeTime)}. Mentre tornava, el sistema de l'operador va continuar anotant parades que el bus no servia.` };
      } else if (ep.tripRelink) {
        headline = { tone: 'var(--accent-warning)', title: 'Viatge reassignat pel SAE', text: `A ${this.esc(ep.tripRelink.stopName)} el retard passa de +${ep.tripRelink.delayBefore} a ${ep.tripRelink.delayAfter} min de cop: cap autobús pot recuperar tant de temps entre dues parades. El sistema de l'operador tenia el bus assignat a un viatge que no feia, i el retard anterior es mesurava contra aquell viatge. No és un retard real verificable.` };
      } else if (ep.verdict === 'delay_jump' && ep.delayJump) {
        const jp = ep.delayJump;
        headline = { tone: 'var(--accent-warning)', title: 'Salt de retard impossible', text: `El sistema de l'operador va passar el bus ${this.esc(jp.vehicleId)} de ${signed(jp.delayBefore)} min a ${this.esc(jp.beforeStop)} (${this.esc(jp.beforeTime)}) a ${signed(jp.delayAfter)} min a ${this.esc(jp.jumpStop)} (${this.esc(jp.jumpTime)}), només ${jp.elapsedMins} min després. Un retard no pot créixer més de pressa que passa el temps: el sistema el va assignar a una expedició anterior a la que feia (ja feta, o d'un altre bus), i el retard es mesurava contra aquella. Aquests registres no compten com a retard del servei.` };
      } else if (!run) {
        headline = { tone: 'var(--text-muted)', title: 'Recorregut no disponible', text: 'Aquestes mostres no tenen un únic identificador de bus, així que no es pot reconstruir el seu recorregut.' };
      } else {
        const who = bus ? `El bus ${this.esc(bus)}` : 'El bus';
        const byPattern = {
          sustained: { tone: 'var(--accent-danger)', title: 'Retard sostingut', text: `${who} va circular entre ${signed(sum.minDelay)} i ${signed(sum.maxDelay)} min de retard durant ${stopsWord(sum.stopCount)}${range}. Un retard estable al llarg del recorregut és un retard real del servei.` },
          building: { tone: 'var(--accent-danger)', title: 'Retard creixent', text: `${who} va passar de ${signed(sum.firstDelay)} a ${signed(sum.lastDelay)} min de retard en ${stopsWord(sum.stopCount)}${range}: va perdent temps al llarg del recorregut.` },
          recovering: { tone: 'var(--accent-warning)', title: 'Retard que es recupera', text: `${who} va baixar de ${signed(sum.firstDelay)} a ${signed(sum.lastDelay)} min de retard en ${stopsWord(sum.stopCount)}${range}.` },
          variable: { tone: 'var(--accent-warning)', title: 'Retard variable', text: `${who} va tenir entre ${signed(sum.minDelay)} i ${signed(sum.maxDelay)} min de retard en ${stopsWord(sum.stopCount)}${range}, sense una tendència clara.` },
          isolated: { tone: 'var(--text-secondary)', title: 'Registre aïllat', text: `${who} només consta en aquesta parada en aquest viatge. Pot ser un valor puntual de l'operador: cal prudència.` }
        };
        headline = byPattern[sum.pattern] || byPattern.variable;
      }

      // The trip right after the clicked one, when the bus joined it mid-route: that
      // is why a large delay "disappears" from one stop to the next.
      const clickedTripIdx = trips.findIndex(t => t.isClickedTrip);
      const nextTrip = clickedTripIdx >= 0 ? trips[clickedTripIdx + 1] : null;
      const shortTurn = nextTrip && nextTrip.joinedMidRoute ? nextTrip : null;
      const shortTurnNote = shortTurn
        ? `<div class="drilldown-callout">
            <strong>Per què el retard desapareix després?</strong>
            En girar, el bus no va començar el viatge següent${shortTurn.towards ? ` cap a ${this.esc(shortTurn.towards)}` : ''} des de l'inici: la primera parada on consta és <strong>${this.esc(run.stops[shortTurn.startIndex].stopName)}</strong>.
            Les ${shortTurn.joinedMidRoute.skippedCount} parades anteriors d'aquell viatge${shortTurn.joinedMidRoute.firstSkipped ? ` (${this.esc(shortTurn.joinedMidRoute.firstSkipped)} → ${this.esc(shortTurn.joinedMidRoute.lastSkipped)})` : ''} no consten servides per aquest bus.
            Això apunta a un escurçament del recorregut per recuperar l'horari: el retard no es va recuperar, el bus es va saltar part del trajecte.
          </div>`
        : '';

      // A deadhead return in the shown run: why the bus starts again so soon, why the
      // records in between do not count, and the wait it left on the skipped trip.
      const dhGap = dh && dh.unservedGap ? dh.unservedGap : null;
      const deadheadNote = dh
        ? `<div class="drilldown-callout">
            <strong>El bus es va saltar un viatge</strong>
            Després ${afterStop(dh.lastServedStop)} (${this.esc(dh.lastServedTime)}, ${signed(dh.lastServedDelay)} min) el bus no va fer el viatge ${dh.skippedDeparture ? `de les ${this.esc(dh.skippedDeparture)} ` : ''}${this.esc(dh.skippedFrom)} → ${this.esc(dh.skippedTo)}, que dura ${dh.oppositeTripMinutes} min: ${dh.returnMinutes} min després ja començava un altre viatge a ${this.esc(dh.resumeStop)} (${this.esc(dh.resumeTime)}).
            Els registres d'entremig (${dh.phantoms.map(p => `${this.esc(p.stopName)} ${signed(p.delayMins)} min`).join(', ')}) els va anotar el sistema de l'operador mentre el bus tornava sense passatgers: no són passos reals i no compten en els rànquings.
            ${dhGap ? `A ${this.esc(dhGap.stopName)} no consta cap bus a les dades de l'operador entre les ${this.esc(dhGap.fromTime)} i les ${this.esc(dhGap.toTime)} (${dhGap.minutes} min${dhGap.plannedHeadwayMinutes ? `; l'horari en preveu un cada ${dhGap.plannedHeadwayMinutes} min` : ''}). Un bus sense equip de seguiment no constaria en aquestes dades.` : ''}
          </div>`
        : '';

      // Where the delay came from: back to the last stop without delay (often several
      // trips earlier), with the places where it grew most. Not for a record that is
      // not a real delay (deadhead return, trip relink).
      const origin = run && run.origin && ep.verdict !== 'deadhead_return' && ep.verdict !== 'delay_jump' && !ep.tripRelink ? run.origin : null;
      const originPlace = e => {
        const span = `${this.esc(hhmm(e.fromTime))}–${this.esc(hhmm(e.toTime))}, ${signed(e.fromDelay)} → ${signed(e.toDelay)} min`;
        if (e.kind === 'between') return `entre ${this.esc(e.previousStop)} i ${this.esc(e.stopName)} (${span})`;
        if (e.kind === 'turn') return `en girar, de ${this.esc(e.previousStop)} a ${this.esc(e.stopName)} (${span})`;
        return `a ${this.esc(e.stopName)} (${span})`;
      };
      const originNote = origin && (origin.tripsBefore > 0 || origin.events.length)
        ? `<div class="drilldown-callout drilldown-origin">
            <strong>D'on ve el retard</strong>
            ${origin.onTime
              ? `L'últim registre sense retard és a les ${this.esc(hhmm(origin.onTime.time))} a ${this.esc(origin.onTime.stopName)} (${signed(origin.onTime.delayMins)} min)${origin.tripsBefore > 0 ? `, ${origin.tripsBefore === 1 ? 'al viatge anterior' : `${origin.tripsBefore} viatges abans`}` : ''}.`
              : `Al primer registre disponible, a les ${this.esc(hhmm(origin.since.time))}, ja anava amb ${signed(origin.since.delayMins)} min.`}
            ${origin.tripsBefore > 0 ? "El retard passa d'un viatge a l'altre: el temps a les capçaleres no n'ha recuperat prou." : ''}
            ${origin.events.length ? `On va créixer més: ${origin.events.map(originPlace).join('; ')}.` : 'No hi ha cap salt concret: es va acumulant a poc a poc.'}
            <button type="button" class="btn-secondary btn-sm drilldown-jump">Veure-ho a la taula</button>
          </div>`
        : '';

      // Evidence, in Catalan. The server's English verdictLabel stays in the API
      // for other consumers; the panel shows its own wording keyed on ep.verdict.
      const verdicts = {
        corroborated: ['var(--accent-live)', 'Confirmat', 'Bus identificat, amb posicions GPS guardades o horaris enviats per l\'operador que ho corroboren.'],
        derived_only: ['var(--accent-regulating)', 'Dada de l\'operador', 'El retard és el que envia l\'operador. No hi ha cap altra font independent per a aquest moment.'],
        poll_inflated: ['var(--accent-warning)', 'Mostres repetides', 'El mateix bus registrat moltes vegades seguides: compta com un sol cas.'],
        unverifiable: ['var(--accent-danger)', 'No verificable', 'No hi ha identificador de bus ni cap altra evidència.'],
        telemetry_anomaly: ['var(--text-muted)', 'Fora de servei', 'Registre de nit o a cotxeres: no és un retard de servei.'],
        trip_relink: ['var(--accent-warning)', 'Viatge reassignat pel SAE', 'El retard es mesurava contra un viatge que el bus no feia.'],
        delay_jump: ['var(--accent-warning)', 'Salt de retard impossible', 'El retard va pujar més de pressa que el rellotge: es mesurava contra una expedició que el bus no feia.'],
        deadhead_return: ['var(--accent-warning)', 'Tornada sense servei', 'Anotat mentre el bus tornava sense passatgers: no és un pas real per aquesta parada.']
      };
      const [vTone, vTitle, vText] = verdicts[ep.verdict] || ['var(--text-primary)', 'Sense veredicte', ''];
      const busCell = Array.isArray(ep.distinctVehicles) && ep.distinctVehicles.length
        ? ep.distinctVehicles.map(v => `<span class="drilldown-bus-chip">${this.esc(v)}</span>`).join(' ')
        : ev.vehicleIdGapExplained
          ? '<span class="drilldown-fact-note">Sense identificador: són mostres anteriors al 19/09/2026, quan encara no es guardava</span>'
          : '<span style="color:var(--accent-danger);">L\'operador no va enviar l\'identificador del bus</span>';
      const keptHours = Number(ev.snapshotRetentionHours) || 2;
      const endTs = ep.tripKey && Number.isFinite(Number(ep.tripKey.endTs)) ? Number(ep.tripKey.endTs) : null;
      const olderThanKept = endTs !== null && (Date.now() - endTs) > keptHours * 3600 * 1000;
      const gpsCell = ev.snapshotTrailPoints >= 2
        ? `<span style="color:var(--accent-live);">${ev.snapshotTrailPoints} posicions al voltant d'aquest moment</span>`
        : olderThanKept
          ? `<span>Ja no disponibles</span><span class="drilldown-fact-note">Només es guarden ${keptHours} h.</span>`
          : '<span style="color:var(--accent-warning);">Cap posició guardada al voltant d\'aquest moment</span>';
      summary.innerHTML = `
        <dl class="drilldown-facts">
          <div class="drilldown-fact"><dt>Veredicte</dt><dd><strong style="color:${vTone};">${vTitle}</strong><span class="drilldown-fact-note">${vText}</span></dd></div>
          <div class="drilldown-fact"><dt>Bus</dt><dd>${busCell}</dd></div>
          ${ep.vehicleAmbiguous ? '<div class="drilldown-fact"><dt>Atenció</dt><dd style="color:var(--accent-warning);">Mostres sense identificador: podrien ser de més d\'un autobús</dd></div>' : ''}
          <div class="drilldown-fact"><dt>Hora teòrica</dt><dd>${this._timesProvenanceLabel(ep.timesProvenance || ev.timesProvenance)}</dd></div>
          <div class="drilldown-fact"><dt>Posicions GPS guardades</dt><dd>${gpsCell}</dd></div>
        </dl>
      `;

      const runRows = run
        ? run.stops
        : (ep.rawRows || []).map(r => ({
          stopName: r.stopName, direction: r.direction, time: String(r.formattedDate || '').slice(11, 19),
          delayMins: r.delayMins, isRealTime: r.isRealTime, scheduledTime: r.scheduledTime, actualTime: r.actualTime,
          timesProvenance: r.timesProvenance, isClicked: true, newTrip: false
        }));
      // One header row per trip: where it was going, when, and how its delay moved.
      const tripByStart = new Map(trips.map((t, i) => [t.startIndex, { ...t, order: i }]));
      const tripHeader = (idx) => {
        const t = tripByStart.get(idx);
        if (!t) return '';
        if (t.isDeadhead) {
          return `
          <tr class="drilldown-trip-row is-deadhead${t.isClickedTrip ? ' is-clicked-trip' : ''}">
            <th colspan="5" scope="colgroup">
              <span class="drilldown-trip-name">Tornada sense servei</span>
              <span class="drilldown-trip-meta">${this.esc(hhmm(t.fromTime))}–${this.esc(hhmm(t.toTime))}</span>
              <span class="drilldown-trip-join">El bus tornava sense passatgers: aquests registres no són passos reals.</span>
            </th>
          </tr>`;
        }
        const delays = t.firstDelay === t.lastDelay ? `${signed(t.firstDelay)} min` : `${signed(t.firstDelay)} → ${signed(t.lastDelay)} min`;
        const join = t.joinedMidRoute
          ? `<span class="drilldown-trip-join">S'hi incorpora a mig recorregut: no consta a les ${t.joinedMidRoute.skippedCount} parades anteriors${t.joinedMidRoute.firstSkipped ? ` (${this.esc(t.joinedMidRoute.firstSkipped)} → ${this.esc(t.joinedMidRoute.lastSkipped)})` : ''}.</span>`
          : '';
        return `
          <tr class="drilldown-trip-row${t.isClickedTrip ? ' is-clicked-trip' : ''}">
            <th colspan="5" scope="colgroup">
              <span class="drilldown-trip-name">${t.order > 0 ? 'Nou viatge' : 'Viatge'}${t.towards ? ` cap a ${this.esc(t.towards)}` : ''}</span>
              <span class="drilldown-trip-meta">${this.esc(hhmm(t.fromTime))}–${this.esc(hhmm(t.toTime))} · ${delays}</span>
              ${join}
            </th>
          </tr>`;
      };
      // One row per stop visit, five fixed columns (see .drilldown-samples-table).
      const rowsHtml = runRows.map((s, idx) => {
        const header = tripHeader(idx);
        const times = s.scheduledTime && s.actualTime
          ? `${this.esc(hhmm(s.scheduledTime))} → ${this.esc(hhmm(s.actualTime))}${s.timesProvenance === 'derived_timetable_backfill' ? ' ≈' : ''}`
          : '—';
        const delayClass = s.phantom ? 'is-phantom' : (s.delayMins >= 20 ? 'is-high' : (s.delayMins >= 5 ? 'is-mid' : 'is-low'));
        const rowClass = [s.isClicked ? 'is-clicked' : '', s.phantom ? 'is-phantom' : '', s.originStart ? 'is-origin-start' : ''].filter(Boolean).join(' ');
        return `${header}
          <tr class="${rowClass}">
            <td class="drilldown-cell-time"${s.lastTime && s.lastTime !== s.time ? ` title="Primer registre camí d'aquesta parada: ${this.esc(hhmm(s.time))}"` : ''}>${this.esc(hhmm(s.lastTime || s.time))}</td>
            <td class="drilldown-cell-delay"><span class="drilldown-delay ${delayClass}">${signed(s.delayMins)} min</span>${s.delayGrowth ? ` <span class="drilldown-growth" title="El retard va créixer ${s.delayGrowth} min en aquest punt">▲${s.delayGrowth}</span>` : ''}</td>
            <td class="drilldown-cell-stop">${this.esc(s.stopName || '—')}${s.isClicked ? ' <span class="drilldown-clicked-tag">consultada</span>' : ''}${s.originStart ? ' <span class="drilldown-origin-tag">sense retard</span>' : ''}</td>
            <td class="drilldown-cell-times">${times}</td>
            <td class="drilldown-cell-src">${s.isRealTime ? 'GPS' : 'Estimat'}</td>
          </tr>`;
      }).join('');
      const tripLink = this._matchIncidentTrip(ep);
      const clicked = runRows.find(s => s.isClicked) || null;
      content.innerHTML = `
        <div class="drilldown-headline" style="--tone:${headline.tone};">
          <div class="drilldown-headline-title">${headline.title}</div>
          <p class="drilldown-headline-text">${headline.text}</p>
        </div>
        ${originNote}
        ${shortTurnNote}
        ${deadheadNote}
        <p class="drilldown-context">
          Parada consultada: <strong>${this.esc(clicked ? clicked.stopName : (data.stopName || stopName))}</strong>${clicked && clicked.time ? ` a les ${this.esc(hhmm(clicked.time))}` : ''} · ${ep.verdict === 'deadhead_return' ? `retard anotat: ${signed(ep.peakDelayMins)} min, que no és un pas real` : ep.verdict === 'delay_jump' ? `retard anotat: ${signed(ep.peakDelayMins)} min, mesurat contra una expedició que el bus no feia` : `retard màxim en aquesta parada: ${signed(ep.peakDelayMins)} min`}.${run ? ` A sota, tot el que va registrar aquest bus entre les ${this.esc(hhmm(runRows[0].time))} i les ${this.esc(hhmm(runRows[runRows.length - 1].time))}.` : ''}
        </p>
        ${tripLink}
        <div class="drilldown-table-scroll">
          <table class="drilldown-samples-table">
            <thead>
              <tr>
                <th scope="col">Pas</th>
                <th scope="col">Retard</th>
                <th scope="col">Parada</th>
                <th scope="col">Teòric → Real</th>
                <th scope="col">Senyal</th>
              </tr>
            </thead>
            <tbody>${rowsHtml || '<tr><td colspan="5" style="color:var(--text-muted);">Cap mostra</td></tr>'}</tbody>
          </table>
        </div>
        <p class="drilldown-legend">El retard es mesura per viatge: quan el bus comença un viatge nou es torna a comptar. «Pas»: l'hora del darrer registre del bus abans de passar per la parada, és a dir, quan hi va arribar (el primer registre, camí de la parada, és a l'indicador en passar-hi el ratolí). «Teòric → Real»: l'operador només envia el retard; l'hora teòrica és la de l'horari publicat per a aquell viatge i la real és la teòrica més el retard. «Senyal»: GPS si la posició era recent, Estimat si el bus havia perdut el senyal uns segons. «▲»: minuts de retard que el bus va guanyar en aquell punt.</p>
      `;
      // Show the clicked trip from its header row, directly under the sticky column header.
      const scroller = content.querySelector('.drilldown-table-scroll');
      const anchorRow = content.querySelector('tr.is-clicked-trip') || content.querySelector('tr.is-clicked');
      const headRow = content.querySelector('.drilldown-samples-table thead tr');
      if (scroller && anchorRow) scroller.scrollTop = Math.max(0, anchorRow.offsetTop - (headRow ? headRow.offsetHeight : 0));
      // "Veure-ho a la taula": scroll up to where the delay began, with its trip header.
      let originRow = content.querySelector('tr.is-origin-start') || content.querySelector('.drilldown-samples-table tbody tr');
      if (originRow && originRow.previousElementSibling && originRow.previousElementSibling.classList.contains('drilldown-trip-row')) originRow = originRow.previousElementSibling;
      const jump = content.querySelector('.drilldown-jump');
      if (jump && scroller && originRow) {
        jump.addEventListener('click', () => {
          scroller.scrollTop = Math.max(0, originRow.offsetTop - (headRow ? headRow.offsetHeight : 0));
        });
      }
    } catch (e) {
      content.innerHTML = `<span style="color:var(--accent-danger);">Error carregant la investigació: ${this.esc(e.message)}</span>`;
    }
  }

  /**
   * Find the Expedicions & Trajectòries card that describes this same episode,
   * and offer a jump to it. The drill-down and the trips tab are two different
   * aggregations of the same delay_logs rows -- one groups by a 5-minute gap
   * per bus, the other builds a stop-by-stop trajectory per bus -- so an
   * operator investigating a delay had no way to get from one to the other
   * without matching times by eye.
   *
   * Matching is deliberately strict: same vehicle, and the trip's window must
   * overlap the episode's. A loose match would link the wrong bus's card, which
   * is worse than offering no link.
   */
  _matchIncidentTrip(ep) {
    const key = ep && ep.tripKey;
    const trips = this.lastIncidentData && Array.isArray(this.lastIncidentData.incidentTrips)
      ? this.lastIncidentData.incidentTrips
      : null;
    if (!key || !trips || !trips.length) return '';
    if (!key.vehicleId) return '';

    // Match on the NUMERIC start, never on the display string. startTime is a
    // localized en-GB string and Date.parse cannot read it back --
    // Date.parse('24/09/2026, 12:05:00') is NaN -- so parsing it here silently
    // matched nothing and the link never rendered. The server sends startTs /
    // endTs for exactly this reason. A trip predating that field simply does
    // not link, which is the safe direction to fail in.
    const tripStart = (t) => (Number.isFinite(t.startTs) ? t.startTs : null);
    const match = trips.find(t => {
      if (t.vehicleId !== key.vehicleId) return false;
      if (String(t.lineCode || '').replace(/^L/i, '') !== String(key.lineCode || '').replace(/^L/i, '')) return false;
      const s = tripStart(t);
      if (s === null) return false;
      // The cluster window runs to endTs, but a trip still logging samples
      // after the episode began has an endTs at or after it, so a 10-minute
      // slack absorbs that without letting an hours-apart trip match.
      return s <= key.endTs + 10 * 60000 && s >= key.startTs - 10 * 60000;
    });
    if (!match) return '';

    const stops = (match.stopProgression && match.stopProgression.length
      ? match.stopProgression
      : (match.stopsTraversed || []).map(s => ({ stopName: s, delayMins: null, isRecovered: false })));
    const flow = stops.map((st, i, arr) => {
      const d = st.delayMins;
      const badge = d != null
        ? `<span class="drilldown-trip-delay ${st.isRecovered ? 'is-recovered' : (d >= 10 ? 'is-high' : 'is-mid')}">${st.isRecovered ? `${d > 0 ? `+${d}` : d}m ✓` : `+${d}m`}</span>`
        : '';
      return `<span class="drilldown-trip-stop${st.isRecovered ? ' is-recovered' : ''}" title="${this.esc(st.stopName)}${d != null ? ` (${st.isRecovered ? 'Recuperat' : 'Retard'}: +${d} min)` : ''}">${this.esc(st.stopName)}${badge}</span>${i < arr.length - 1 ? '<span class="drilldown-trip-arrow">→</span>' : ''}`;
    }).join('');

    return `
      <div class="drilldown-trip-card">
        <div class="drilldown-trip-head">
          <span class="drilldown-trip-label">Expedició &amp; trajectòria corresponent</span>
          <span class="drilldown-trip-meta">${this.esc(match.lineCode || '')} · bus ${this.esc(match.vehicleId)} · inici ${this.esc(match.startTime || '')}${this._clockOf(match.endMomentTs) ? ` · fi ${this._clockOf(match.endMomentTs)}` : ''} · ${match.sampleCount || 0} mostres</span>
        </div>
        <div class="drilldown-trip-flow">${flow || '<span style="color:var(--text-muted);">Sense parades reconstruïdes</span>'}</div>
        ${this._trajectoryOutcome(match) ? `<p class="drilldown-trip-outcome">${this._trajectoryOutcome(match)}</p>` : ''}
        <button type="button" class="btn-locate-incident-stop" data-incident-tab="trips" title="Obre la pestanya Expedicions &amp; Trajectòries">
          <span>Veure a Expedicions &amp; Trajectòries</span>
        </button>
      </div>`;
  }

  /** HH:MM (Madrid) of an epoch-ms timestamp, '' when it is not one. */
  _clockOf(ts) {
    const n = Number(ts);
    return Number.isFinite(n) && n > 0
      ? new Date(n).toLocaleTimeString('ca-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      : '';
  }

  /**
   * How a delayed trip's trajectory ended, in one sentence. The card used to show
   * only where the delay started; a trajectory that stops (end of line, signal
   * lost) looked like a recovery nobody had drawn, and a trip change was drawn
   * as a recovery.
   */
  _trajectoryOutcome(t) {
    const sg = n => (Number(n) > 0 ? `+${Number(n)}` : String(Number(n)));
    const stop = this.esc(t.endStop || t.lastStop || '');
    const end = this._clockOf(t.endMomentTs);
    const next = t.nextTrip && Number.isFinite(Number(t.nextTrip.ts)) ? t.nextTrip : null;
    switch (t.endReason) {
      case 'recovered':
        return `Recuperat a ${stop}${end ? ` a les ${end}` : ''}: ${sg(t.endDelayMins)} min.`;
      case 'trip_change': {
        const gap = next && Number.isFinite(Number(t.endMomentTs)) ? Math.round((Number(next.ts) - Number(t.endMomentTs)) / 60000) : null;
        return `El retard no es va recuperar en ruta. Després de ${stop}${end ? ` (${end}, ${sg(t.endDelayMins)} min)` : ''}${gap !== null && gap >= 2 ? ` hi ha ${gap} min sense registres i` : ''} el bus consta ja en un altre viatge${next ? `, a ${this.esc(next.stopName)} a les ${this._clockOf(next.ts)} amb ${sg(next.delayMins)} min` : ''}.`;
      }
      case 'end_of_line':
        return `Arriba a ${stop} (final de línia)${end ? ` a les ${end}` : ''} amb ${sg(t.endDelayMins)} min de retard.${next ? ` Torna a sortir a les ${this._clockOf(next.ts)} des de ${this.esc(next.stopName)} amb ${sg(next.delayMins)} min.` : ''}`;
      case 'signal_lost':
        return `Sense registres des de les ${end || '--:--'} (darrera parada: ${stop}, ${sg(t.endDelayMins)} min): no se sap si el bus va recuperar el retard.`;
      case 'ongoing':
        return 'Encara en curs.';
      case 'relinked':
        return "El sistema de l'operador va reassignar el bus a un altre viatge: el retard no es va recuperar.";
      case 'deadhead_return':
        return 'El bus va deixar de servir el viatge: el retard no es va recuperar.';
      default:
        return '';
    }
  }

  /** Plain-Catalan label for the server-side times_provenance classification. */
  _timesProvenanceLabel(provenance) {
    switch (provenance) {
      case 'observed': return '<span style="color:var(--accent-live);">Enviada per l\'operador</span>';
      case 'derived_timetable': return '<span style="color:var(--text-secondary);">Calculada per Arribo! amb l\'horari publicat i el retard que envia l\'operador (l\'operador no envia l\'hora teòrica)</span>';
      case 'derived_timetable_backfill': return '<span style="color:var(--accent-warning);">Aproximada a posteriori amb l\'horari publicat (menys fiable)</span>';
      case 'mixed': return '<span style="color:var(--text-secondary);">Diverses fonts: vegeu la columna «Teòric → Real»</span>';
      default: return '<span style="color:var(--text-muted);">No disponible</span>';
    }
  }

  _renderIncidentDataQualityBanner(s) {
    const q = s.dataQuality || {};
    if (!q.totalRawRows && !q.rowsWithoutVehicleId) return '';
    return `
      <div style="background:rgba(251,191,36,0.07); border:1px solid rgba(251,191,36,0.25); border-radius:12px; padding:0.85rem 1rem; margin-bottom:1.25rem;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:0.75rem; flex-wrap:wrap;">
          <div>
            <div style="font-size:0.78rem; font-weight:800; color:var(--accent-warning);">Què compten exactament aquestes xifres</div>
            <div style="font-size:0.76rem; color:var(--text-secondary); margin-top:0.2rem; line-height:1.5;">
              Els KPIs de mostres (${this._fmtCount(s.rawSamplesOverThreshold ?? s.totalRecordedIncidents)} mostres) són
              <strong>mostres raw</strong>: un mateix autobús hi apareix cada 20 s.${s.worstBasis === 'visits' ? ' El punt negre i la franja es compten en <strong>passos per parada</strong> (un bus a una parada, una vegada).' : ''} Les taules de dalt, en canvi, mostren
              <strong>episodis deduplicats</strong>${s.listedCommercialEpisodes !== undefined ? ` (${this._fmtCount(s.listedCommercialEpisodes)} de servei, arrodonits al límit de ${s.commercialEpisodeLimit})` : ''}:
              no són xifres comparables entre elles.
            </div>
            <div style="font-size:0.76rem; color:var(--text-secondary); margin-top:0.35rem; line-height:1.5;">
              ${q.episodesNote ? this.esc(q.episodesNote) : ''}
            </div>
            ${(s.nonRealtimeSampleCount || 0) > 0 ? `
              <div style="font-size:0.76rem; color:var(--text-secondary); margin-top:0.35rem; line-height:1.5;">
                D'aquestes mostres, <strong>${this._fmtCount(s.nonRealtimeSampleCount)} (${s.nonRealtimeSamplePct}%)</strong> són
                posicions extrapolades (dead-reckoning) i no GPS fresc. S'inclouen perquè el retard registrat és real, però no són una observació directa de la posició.
              </div>
            ` : ''}
          </div>
          <div style="font-size:0.74rem; color:var(--text-muted); text-align:right;">
            ${this._fmtCount(q.totalRawRows)} mostres raw<br>
            ${this._fmtCount(q.rowsWithoutVehicleId)} sense vehicle<br>
            ${this._fmtCount(q.rowsWithoutProvenance)} sense horari<br>
            ${this._fmtCount(q.distinctEpisodes)} episodis de retard${q.episodeGapMinutes ? ` (≤${q.episodeGapMinutes} min)` : ''}
          </div>
        </div>
      </div>
    `;
  }

  _fmtCount(n) {
    return (Number(n) || 0).toLocaleString('ca-ES');
  }

  renderIncidentErrorState(container, lineCode, hours, viewMode) {
    container.innerHTML = `
      <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:12px; padding:2.5rem 1.5rem; text-align:center; color:var(--text-muted); max-width:540px; margin:2rem auto;">
        <div style="font-size:2rem; margin-bottom:0.6rem;">⏱️</div>
        <div style="font-weight:700; font-size:1.05rem; color:var(--text-primary); margin-bottom:0.4rem;">El servidor està processant les dades de ${hours}h</div>
        <p style="font-size:0.82rem; margin:0 0 1.25rem 0; line-height:1.45;">
          Quan es calculen informes de 7 dies o es reindexa la telemetria històrica en segon pla, pot trigar uns instants a sincronitzar.
        </p>
        <button type="button" class="btn-primary" id="btn-retry-incidents-tab">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          <span>Reintentar ara</span>
        </button>
      </div>
    `;
    document.getElementById('btn-retry-incidents-tab')?.addEventListener('click', (e) => {
      e.preventDefault();
      const cacheKey = `${lineCode}:${hours}`;
      this._incidentCache?.delete(cacheKey);
      this.openDelayIncidentsView(lineCode, hours, viewMode, 0, true);
    });
  }

  renderDelayIncidentsView(data, selectedLine = 'all', selectedHours = 168, activeTab = 'top') {
    const container = document.getElementById('journalism-incidents-container');
    if (!container || !data) return;
    this.lastIncidentData = data;

    const s = data.summary || {};
    const topList = data.topIncidents || [];
    const investigationList = data.investigationIncidents || [];
    const anomaliesList = data.telemetryAnomalies || [];
    const tripsList = data.incidentTrips || [];
    const activeLineNorm = String(selectedLine || 'all').toUpperCase();
    const linesCatalog = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'];

    const getLineColor = (code) => {
      const match = (this.availableLines || []).find(l => String(l.code || l.id).toUpperCase() === String(code).toUpperCase());
      return match?.color || 'var(--brand-primary)';
    };

    const formatBusBadge = (vehicleId) => {
      if (!vehicleId) return '';
      const clean = String(vehicleId)
        .replace(/^mataro_\w+_/i, '')
        .replace(/^c10_\w+_/i, '')
        .replace(/^AMB-/i, '')
        .trim();
      if (!clean || clean.toLowerCase() === 'bus') return '';
      return `<span class="bus-id-badge" title="Identificador de vehicle oficial: ${this.esc(vehicleId)}">[ #${this.esc(clean)} ]</span>`;
    };

    // The headline maximum is the true maximum over the whole window. The
    // commercial tier is only delays < 25 min, so when every recorded delay sits
    // in the investigation tier the commercial figure is UNKNOWN (null) — it must
    // not be coerced to 0, which used to render "+0 min" as the maximum service
    // delay while real 30-minute delays were on screen.
    // An empty window reports null, and null is not zero. `Number(null) || 0`
    // turned "no delays recorded" into a headline of "0 min" - a claim that the
    // worst service delay in the window was zero minutes, which is exactly the
    // fabricated-confidence reading this panel exists to eliminate.
    const trueMaxDelay = (s.maxDelayMins === null || s.maxDelayMins === undefined
      || !Number.isFinite(Number(s.maxDelayMins))) ? null : Number(s.maxDelayMins);
    const commercialMax = (s.maxCommercialDelayMins === null || s.maxCommercialDelayMins === undefined
      || !Number.isFinite(Number(s.maxCommercialDelayMins)))
      ? null : Number(s.maxCommercialDelayMins);
    const maxFromInvestigation = s.maxDelayIsFromInvestigationTier === true
      || (commercialMax === null && trueMaxDelay !== null && trueMaxDelay >= 25);
    // A window can hold only mid-range delays: then the commercial max is
    // measured, the investigation tier is empty, and maxFromInvestigation is
    // false. It can also hold no delays at all. Either way the "else" caption
    // must not interpolate a null into "+null min".
    const commercialMaxCaption = commercialMax === null
      ? (trueMaxDelay === null ? 'sense mostres registrades' : 'no mesurat en aquesta finestra')
      : `+${commercialMax} min`;
    const maxDelayValue = trueMaxDelay === null
      ? '—'
      : `${trueMaxDelay > 0 ? '+' : ''}${trueMaxDelay} min`;

    container.innerHTML = `
      <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:1.1rem; margin-bottom:1.25rem;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:0.75rem;">
          <div>
            <span style="font-size:0.75rem; font-weight:800; color:var(--accent-scheduled); text-transform:uppercase; letter-spacing:0.5px;">Observatori de Mobilitat • Anàlisi de Causes</span>
            <h3 style="font-size:1.35rem; font-weight:800; color:var(--text-primary); margin:0.2rem 0;">Investigador d'Incidents de Trànsit &amp; Auditoria de Telemetria</h3>
            <p style="font-size:0.78rem; color:var(--text-muted); margin:0; max-width:740px; line-height:1.45;">
              Auditoria de retards per telemetria GPS. Els retards de servei comercial (${s.minDelayThreshold || 5}–24 min) es presenten al rànquing de trànsit regular. Els desfasaments extrems (&ge; 25 min) es classifiquen en una taula separada com a horaris no normals pendents d'investigació per resoldre la seva causa real.
            </p>
          </div>
        </div>

        <!-- Filter Controls Row -->
        <div class="incident-filters">
          <!-- Timeframe selector -->
          <div class="incident-filter-row">
            <span class="incident-filter-label">Període:</span>
            <div class="incident-filter-options incident-filter-options--period">
              <button type="button" class="incident-filter-pill ${Number(selectedHours) === 24 ? 'active' : ''}" data-incident-hours="24">24 hores</button>
              <button type="button" class="incident-filter-pill ${Number(selectedHours) === 48 ? 'active' : ''}" data-incident-hours="48">48 hores</button>
              <button type="button" class="incident-filter-pill ${Number(selectedHours) === 168 ? 'active' : ''}" data-incident-hours="168">7 dies</button>
            </div>
          </div>

          <!-- Line selector -->
          <div class="incident-filter-row">
            <span class="incident-filter-label">Línia:</span>
            <div class="incident-filter-options incident-filter-options--lines">
              <button type="button" class="incident-filter-pill ${activeLineNorm === 'ALL' ? 'active' : ''}" data-incident-line="all">Totes les línies</button>
              ${linesCatalog.map(lCode => {
                const isActive = activeLineNorm === lCode;
                const n = /^L([1-8])$/.exec(lCode);
                return `
                  <button type="button" class="incident-filter-pill ${isActive ? 'active' : ''}" data-incident-line="${lCode}">
                    <span class="line-dot${n ? ` line-dot-${n[1]}` : ''}"></span>
                    <span>${lCode}</span>
                  </button>
                `;
              }).join('')}
            </div>
          </div>
        </div>
      </div>

      <!-- KPI Summary Cards -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:0.75rem; margin-bottom:1.25rem;">
        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:0.9rem;">
          <div style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase;">Retard Màxim de Servei</div>
          <div style="font-size:1.6rem; font-weight:800; color:${trueMaxDelay === null ? 'var(--text-muted)' : 'var(--accent-danger)'}; margin-top:0.2rem;">${maxDelayValue}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${this._fmtCount(s.rawSamplesOverThreshold ?? s.totalRecordedIncidents)} mostres raw &ge; ${s.minDelayThreshold || 5}m • ${topList.length} episodis al rànquing</div>
          ${maxFromInvestigation ? `
            <div style="font-size:0.72rem; color:var(--accent-danger); margin-top:0.2rem; line-height:1.4;">
              Aquest màxim prové de la taula «Horaris No Habituals» (&ge; 25 min). En aquesta finestra no hi ha cap retard de servei comercial (${s.minDelayThreshold || 5}–24 min), de manera que el màxim comercial no està mesurat.
            </div>
          ` : `
            <div style="font-size:0.72rem; color:var(--text-muted); margin-top:0.2rem;">Màxim del servei comercial (${s.minDelayThreshold || 5}–24 min): ${commercialMaxCaption} • ${investigationList.length} en investigació</div>
          `}
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:0.9rem;">
          <div style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase;">Punt Negre (Més Afectat)</div>
          <div style="font-size:1.05rem; font-weight:700; color:var(--brand-primary); margin-top:0.25rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${this.esc(s.worstStop || 'Cap')}">${this.esc(s.worstStop || 'Cap')}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${this._fmtCount(s.worstStopCount || 0)} ${s.worstBasis === 'visits' ? (s.worstStopCount === 1 ? 'pas' : 'passos') : (s.worstStopCount === 1 ? 'mostra raw' : 'mostres raw')} amb retard &ge; ${s.minDelayThreshold || 5} min</div>
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:0.9rem;">
          <div style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase;">Franja amb Més Retards</div>
          <div style="font-size:1.15rem; font-weight:700; color:var(--accent-warning); margin-top:0.25rem;">${s.worstHour || '--:00'}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${s.worstHourLatePct !== null && s.worstHourLatePct !== undefined ? `${s.worstHourLatePct}% dels passos amb retard &ge; ${s.minDelayThreshold || 5} min · ` : ''}${s.worstHourTag || 'Horari regular'}</div>
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:0.9rem;">
          <div style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase;">Horaris No Habituals</div>
          <div style="font-size:1.15rem; font-weight:700; color:var(--accent-danger); margin-top:0.25rem;">${investigationList.length} en investigació</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${anomaliesList.length} anomalies de cotxeres/SAE</div>
        </div>
      </div>

      <!-- Sub-Tab Mode Switcher -->
      <div class="incident-view-mode-tabs-container" role="tablist" aria-label="Mode d'anàlisi d'incidents">
        <button type="button" class="incident-view-mode-tab ${activeTab === 'top' ? 'active' : ''}" data-incident-tab="top" role="tab" aria-selected="${activeTab === 'top'}">
          <span><span class="incident-tab-title">Rànquing d'Incidents de Servei</span> <span class="incident-tab-meta">(${s.minDelayThreshold || 5}–24 min) (${topList.length})</span></span>
        </button>
        <button type="button" class="incident-view-mode-tab ${activeTab === 'investigation' ? 'active' : ''}" data-incident-tab="investigation" role="tab" aria-selected="${activeTab === 'investigation'}">
          <span><span class="incident-tab-title">Horaris No Habituals</span> <span class="incident-tab-meta">(&ge; 25 min) (${investigationList.length})</span></span>
        </button>
        <button type="button" class="incident-view-mode-tab ${activeTab === 'trips' ? 'active' : ''}" data-incident-tab="trips" role="tab" aria-selected="${activeTab === 'trips'}">
          <span><span class="incident-tab-title">Expedicions &amp; Trajectòries</span> <span class="incident-tab-meta">(${tripsList.length})</span></span>
        </button>
      </div>

      <!-- View Content Partition -->
      ${activeTab === 'top' ? `
        <!-- Table 1: Top Delays Table (Peak per Trip 0-24m) -->
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px; margin-bottom:0.6rem;">
          <div style="font-size:0.78rem; color:var(--text-muted); display:flex; align-items:center; gap:6px;">
            <span>Mostrant incidents de servei comercial (${s.minDelayThreshold || 5}–24 min). S'agrupen els senyals cada 20 s del mateix viatge i parada per evitar duplicats.</span>
          </div>
          ${investigationList.length > 0 ? `
            <div style="font-size:0.75rem; color:var(--accent-danger); font-weight:700;">
              ${investigationList.length} expedicions amb retard extrem (&ge; 25 m) mogudes a la taula inferior d'investigació.
            </div>
          ` : ''}
        </div>

        ${topList.length === 0 ? `
          <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:10px; padding:2rem; text-align:center; color:var(--text-muted);">
            No s'han registrat retards comercials (${s.minDelayThreshold || 5}–24 min) per a la selecció actual (${selectedHours}h).
          </div>
        ` : `
          <div class="observatori-table-wrapper">
            <table class="observatori-table">
              <thead>
                <tr>
                  <th style="width:45px; text-align:center;">#</th>
                  <th>Retard</th>
                  <th>Línia</th>
                  <th>Parada Afectada</th>
                  <th>Data i Hora</th>
                  <th>Context Horari</th>
                  <th style="text-align:center; cursor:help;" title="Tipus de senyal: GPS directe o Estimat">Senyal</th>
                  <th style="text-align:center;">Mapa</th>
                </tr>
              </thead>
              <tbody>
                ${topList.map((inc, i) => {
                  const lColor = getLineColor(inc.lineCode);
                  const delayClass = inc.delayMins >= 20 ? 'var(--accent-danger)' : (inc.delayMins >= 10 ? 'var(--accent-warning)' : 'var(--accent-scheduled)');
                  const signalTooltip = inc.isRealTime
                    ? 'Senyal GPS directe: Telemetria transmesa en temps real pel vehicle físic.'
                    : 'Estimació per estima (dead-reckoning): Autobús físic amb GPS que ha perdut la cobertura temporalment (túnels, carrers estrets o caiguda de xarxa). La posició i el retard es calculen avançant la darrera velocitat i retard coneguts (màxim 90 segons). Mai s\'aplica a autobusos sense GPS.';
                  return `
                    <tr>
                      <td style="font-weight:700; color:var(--text-muted); text-align:center;">${inc.rank || (i + 1)}</td>
                      <td style="font-weight:800; color:${delayClass}; white-space:nowrap;">+${inc.delayMins} min</td>
                      <td>
                        <div style="display:inline-flex; align-items:center; gap:5px; flex-wrap:wrap;">
                          <span style="background:${lColor}; color:${this.chipInk(lColor)}; padding:0.15rem 0.45rem; border-radius:5px; font-weight:800; font-size:0.75rem;">${this.esc(inc.lineCode)}</span>
                          ${formatBusBadge(inc.vehicleId)}
                        </div>
                      </td>
                      <td style="font-weight:600; color:var(--text-primary);">
                        ${this.esc(inc.stopName)}
                      </td>
                      <td style="color:var(--text-secondary); white-space:nowrap; font-size:0.8rem;">
                        ${this.esc(inc.formattedDate || '')}
                      </td>
                      <td style="white-space:nowrap; font-size:0.78rem;">
                        <span style="color:var(--text-muted);">${this.esc(inc.trafficTag || '')}</span>
                      </td>
                      <td style="text-align:center; white-space:nowrap;">
                        <span class="signal-badge ${inc.isRealTime ? 'gps' : 'estimated'}" title="${this.esc(signalTooltip)}">
                          <span class="dot"></span>
                          <span>${inc.isRealTime ? 'GPS' : 'Estimat'}</span>
                        </span>
                      </td>
                      <td style="text-align:center; white-space:nowrap;">
                        <button type="button" class="btn-locate-incident-stop" data-locate-line="${this.esc(inc.lineCode)}" data-locate-stop="${this.esc(inc.stopName)}" data-locate-stop-id="${this.esc(inc.stopId || '')}" title="Veure aquesta parada al mapa">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
                          <span>Mapa</span>
                        </button>
                        <button type="button" class="btn-investigate-incident" data-investigate-line="${this.esc(inc.lineCode)}" data-investigate-stop="${this.esc(inc.stopName)}" data-investigate-vehicle="${this.esc(inc.vehicleId || '')}" data-investigate-at="${inc.timestamp || ''}" title="Investigar aquest retard: veure les mostres originals que el contenen">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                          <span>Investigar</span>
                        </button>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        `}

        <!-- Data-quality banner: what the "Top incidents" numbers actually count -->
        ${this._renderIncidentDataQualityBanner(s)}

        <!-- Forensic drill-down panel (populated on click) -->
        <div id="incident-drilldown-panel" class="drilldown-panel" style="display:none;">
          <div class="drilldown-layout">
            <div class="drilldown-main">
              <h3 class="drilldown-title">Investigació del retard</h3>
              <div id="drilldown-content">Selecciona un retard de la taula per a investigar-lo.</div>
            </div>
            <aside class="drilldown-aside" aria-label="Evidència">
              <h4 class="drilldown-aside-title">Evidència</h4>
              <div id="drilldown-summary"></div>
            </aside>
          </div>
        </div>

        <!-- Table 2: Dedicated Table for Non-Normal Schedules Under Investigation (>= 25 min) -->
        <div style="margin-top:2.5rem; border-top:2px solid rgba(244, 63, 94, 0.35); padding-top:1.5rem;" id="section-investigation-incidents">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:0.75rem; margin-bottom:0.85rem;">
            <div>
              <div style="display:inline-flex; align-items:center; gap:6px; background:rgba(244, 63, 94, 0.15); color:var(--accent-danger); padding:3px 8px; border-radius:6px; font-size:0.72rem; font-weight:800; text-transform:uppercase; letter-spacing:0.4px;">
                <span>Pendent d'Investigació • Horaris No Habituals (&ge; 25 min)</span>
              </div>
              <h4 style="font-size:1.15rem; font-weight:800; color:var(--text-primary); margin:0.35rem 0 0.2rem 0;">
                Horaris No Habituals &amp; Desfasaments Extrems (&ge; 25 min) (${investigationList.length})
              </h4>
              <p style="font-size:0.78rem; color:var(--text-muted); margin:0; max-width:760px; line-height:1.45;">
                Aquests registres presenten un retard de 25 minuts o més. No es consideren retencions habituals de trànsit de la ciutat, sinó <strong>horaris no normals o possibles incidències de seguiment/telemetria</strong> (com ara autobusos aturats fora de servei en capçalera amb el SAE encès, talls excepcionals de carrer o desfasaments de torn). Estan pendents d'investigació per resoldre la seva causa real.
              </p>
            </div>
            ${investigationList.length > 0 ? `
              <button type="button" class="btn-report-action btn-report-investigation" id="btn-copy-investigation-report" title="Copiar informe dels casos en investigació">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                <span>Copiar informe d'investigació</span>
              </button>
            ` : ''}
          </div>

          ${investigationList.length === 0 ? `
            <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:10px; padding:1.5rem; text-align:center; color:var(--text-muted); font-size:0.85rem;">
              Cap horari no habitual ni desfasament extrem (&ge; 25 min) detectat en aquest període (${selectedHours}h).
            </div>
          ` : `
            <div class="observatori-table-wrapper">
              <table class="observatori-table">
                <thead>
                  <tr>
                    <th style="width:45px; text-align:center;">#</th>
                    <th>Retard Transmès</th>
                    <th>Línia</th>
                    <th>Parada Afectada</th>
                    <th>Data i Hora</th>
                    <th>Estat / Diagnòstic</th>
                    <th style="text-align:center; cursor:help;" title="Tipus de senyal: GPS directe o Estimat">Senyal</th>
                    <th style="text-align:center;">Mapa</th>
                  </tr>
                </thead>
                <tbody>
                  ${investigationList.map((inc, i) => {
                    const lColor = getLineColor(inc.lineCode);
                    const signalTooltip = inc.isRealTime
                      ? 'Senyal GPS directe: Telemetria transmesa en temps real pel vehicle físic.'
                      : 'Estimació per estima (dead-reckoning) per pèrdua temporal de senyal.';
                    return `
                      <tr>
                        <td style="font-weight:700; color:var(--text-muted); text-align:center;">${inc.rank || (i + 1)}</td>
                        <td style="font-weight:800; color:var(--accent-danger); white-space:nowrap;">+${inc.delayMins} min</td>
                        <td>
                          <div style="display:inline-flex; align-items:center; gap:5px; flex-wrap:wrap;">
                            <span style="background:${lColor}; color:${this.chipInk(lColor)}; padding:0.15rem 0.45rem; border-radius:5px; font-weight:800; font-size:0.75rem;">${this.esc(inc.lineCode)}</span>
                            ${formatBusBadge(inc.vehicleId)}
                          </div>
                        </td>
                        <td style="font-weight:600; color:var(--text-primary);">
                          ${this.esc(inc.stopName)}
                        </td>
                        <td style="color:var(--text-secondary); white-space:nowrap; font-size:0.8rem;">
                          ${this.esc(inc.formattedDate || '')}
                        </td>
                        <td style="white-space:nowrap; font-size:0.78rem;">
                          <span style="background:rgba(244,63,94,0.15); color:var(--accent-danger); padding:0.2rem 0.5rem; border-radius:6px; font-weight:700; font-size:0.72rem; display:inline-flex; align-items:center; gap:4px;">
                            Pendent d'investigació
                          </span>
                        </td>
                        <td style="text-align:center; white-space:nowrap;">
                          <span class="signal-badge ${inc.isRealTime ? 'gps' : 'estimated'}" title="${this.esc(signalTooltip)}">
                            <span class="dot"></span>
                            <span>${inc.isRealTime ? 'GPS' : 'Estimat'}</span>
                          </span>
                        </td>
                        <td style="text-align:center; white-space:nowrap;">
                          <button type="button" class="btn-locate-incident-stop" data-locate-line="${this.esc(inc.lineCode)}" data-locate-stop="${this.esc(inc.stopName)}" data-locate-stop-id="${this.esc(inc.stopId || '')}" title="Veure aquesta parada al mapa">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
                            <span>Mapa</span>
                          </button>
                          <button type="button" class="btn-investigate-incident" data-investigate-line="${this.esc(inc.lineCode)}" data-investigate-stop="${this.esc(inc.stopName)}" data-investigate-vehicle="${this.esc(inc.vehicleId || '')}" data-investigate-at="${inc.timestamp || ''}" title="Investigar aquest retard: veure les mostres originals que el contenen">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                            <span>Investigar</span>
                          </button>
                        </td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          `}
        </div>

        <!-- Table 3: Anomaly & SAE Desync Audit Table for Operator/Municipality -->
        <div style="margin-top:2.5rem; border-top:2px dashed var(--border-subtle); padding-top:1.5rem;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:0.75rem; margin-bottom:0.85rem;">
            <div>
              <div style="display:inline-flex; align-items:center; gap:6px; background:rgba(245, 158, 11, 0.15); color:var(--accent-warning); padding:3px 8px; border-radius:6px; font-size:0.72rem; font-weight:800; text-transform:uppercase; letter-spacing:0.4px;">
                <span>Auditoria Operador &amp; Ajuntament</span>
              </div>
              <h4 style="font-size:1.15rem; font-weight:800; color:var(--text-primary); margin:0.35rem 0 0.2rem 0;">
                Anomalies de Telemetria SAE &amp; Sortida de Cotxeres (${anomaliesList.length})
              </h4>
              <p style="font-size:0.78rem; color:var(--text-muted); margin:0; max-width:740px; line-height:1.45;">
                Aquests registres no corresponen a retencions de trànsit de la ciutat, sinó a <strong>desfasaments de telemetria generats pel sistema SAE (CAD/AVL) d'Avanza</strong> fora de l'horari publicat de cada línia (sortides i tornades a cotxeres) o amb 10 min o més durant la primera mitja hora de servei de la línia (un bus que comença torn assignat a una expedició anterior). També hi apareixen els <strong>viatges reassignats pel SAE</strong> (🔀): trams on el retard desapareix de cop perquè el sistema tenia el bus assignat a un viatge que no feia, i els <strong>salts de retard impossibles</strong> (⏫): el retard puja més de pressa que passa el temps perquè el sistema passa el bus a una expedició anterior. Es publiquen aquí per facilitar l'auditoria i la seva correcció per part de l'Ajuntament de Mataró.
              </p>
            </div>
            ${anomaliesList.length > 0 ? `
              <button type="button" class="btn-report-action btn-report-anomalies btn-copy-anomalies" id="btn-copy-anomalies-report" title="Copiar resum d'anomalies per a informe o reclamació a l'Ajuntament / Avanza">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                <span>Copiar informe d'anomalies</span>
              </button>
            ` : ''}
          </div>

          ${anomaliesList.length === 0 ? `
            <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:10px; padding:1.5rem; text-align:center; color:var(--text-muted); font-size:0.85rem;">
              Cap anomalia d'arrencada o manteniment detectada en el període seleccionat (${selectedHours}h).
            </div>
          ` : `
            <div class="observatori-table-wrapper">
              <table class="observatori-table">
                <thead>
                  <tr>
                    <th style="width:45px; text-align:center;">#</th>
                    <th>Retard Transmès</th>
                    <th>Línia</th>
                    <th>Parada / Punt d'observació</th>
                    <th>Data i Hora</th>
                    <th>Diagnòstic / Causa Probable</th>
                    <th style="text-align:center; cursor:help;" title="Tipus de senyal: GPS directe o Estimat">Senyal</th>
                    <th style="text-align:center;">Mapa</th>
                  </tr>
                </thead>
                <tbody>
                  ${anomaliesList.map((inc, i) => {
                    const lColor = getLineColor(inc.lineCode);
                    const isStartup = inc.anomalyType === 'startup_sae';
                    const isRelink = inc.anomalyType === 'trip_relink' || inc.anomalyType === 'deadhead_return' || inc.anomalyType === 'delay_jump';
                    const isMaintenance = inc.anomalyType === 'maintenance' || (!isStartup && !isRelink);
                    const badgeBg = (isStartup || isRelink) ? 'rgba(245, 158, 11, 0.15)' : 'rgba(147, 51, 234, 0.15)';
                    const badgeColor = (isStartup || isRelink) ? 'var(--accent-warning)' : 'var(--accent-regulating)';
                    const signalTooltip = inc.isRealTime
                      ? 'Senyal GPS directe transmès pel vehicle físic.'
                      : 'Estimació per estima (dead-reckoning) per pèrdua temporal de senyal.';
                    return `
                      <tr>
                        <td style="font-weight:700; color:var(--text-muted); text-align:center;">${inc.rank || (i + 1)}</td>
                        <td style="font-weight:800; color:var(--accent-warning); white-space:nowrap;">+${inc.delayMins} min</td>
                        <td>
                          <div style="display:inline-flex; align-items:center; gap:5px; flex-wrap:wrap;">
                            <span style="background:${lColor}; color:${this.chipInk(lColor)}; padding:0.15rem 0.45rem; border-radius:5px; font-weight:800; font-size:0.75rem;">${this.esc(inc.lineCode)}</span>
                            ${formatBusBadge(inc.vehicleId)}
                          </div>
                        </td>
                        <td style="font-weight:600; color:var(--text-primary);">
                          ${isMaintenance ? `
                            <span style="color:var(--text-muted); font-size:0.85rem;" title="Sense parada comercial (proves o manteniment a cotxeres)">—</span>
                          ` : `
                            ${this.esc(inc.stopName)}
                          `}
                        </td>
                        <td style="color:var(--text-secondary); white-space:nowrap; font-size:0.8rem;">
                          ${this.esc(inc.formattedDate || '')}
                        </td>
                        <td style="white-space:nowrap; font-size:0.78rem;">
                          <span style="background:${badgeBg}; color:${badgeColor}; padding:0.2rem 0.5rem; border-radius:6px; font-weight:700; font-size:0.72rem; display:inline-flex; align-items:center; gap:4px;">
                            ${this.esc(inc.diagnosticBadge || inc.trafficTag || 'Anomalia SAE')}
                          </span>
                        </td>
                        <td style="text-align:center; white-space:nowrap;">
                          <span class="signal-badge ${inc.isRealTime ? 'gps' : 'estimated'}" title="${this.esc(signalTooltip)}">
                            <span class="dot"></span>
                            <span>${inc.isRealTime ? 'GPS' : 'Estimat'}</span>
                          </span>
                        </td>
                        <td style="text-align:center; white-space:nowrap;">
                          ${isMaintenance ? `
                            <span style="color:var(--text-muted); font-size:0.85rem;" title="No aplica (operació de cotxeres)">—</span>
                          ` : `
                            <button type="button" class="btn-locate-incident-stop" data-locate-line="${this.esc(inc.lineCode)}" data-locate-stop="${this.esc(inc.stopName)}" data-locate-stop-id="${this.esc(inc.stopId || '')}" title="Veure aquesta parada al mapa">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
                              <span>Mapa</span>
                            </button>
                            <button type="button" class="btn-investigate-incident" data-investigate-line="${this.esc(inc.lineCode)}" data-investigate-stop="${this.esc(inc.stopName)}" data-investigate-vehicle="${this.esc(inc.vehicleId || '')}" data-investigate-at="${inc.timestamp || ''}" title="Investigar aquest retard: veure les mostres originals que el contenen">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                              <span>Investigar</span>
                            </button>
                          `}
                        </td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          `}
        </div>
      ` : activeTab === 'investigation' ? `
        <!-- Mode: Standalone Investigation Table Focus -->
        <div style="margin-bottom:1.5rem;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:0.75rem; margin-bottom:0.85rem;">
            <div>
              <div style="display:inline-flex; align-items:center; gap:6px; background:rgba(244, 63, 94, 0.15); color:var(--accent-danger); padding:3px 8px; border-radius:6px; font-size:0.72rem; font-weight:800; text-transform:uppercase; letter-spacing:0.4px;">
                <span>Pendent d'Investigació • Horaris No Habituals (&ge; 25 min)</span>
              </div>
              <h4 style="font-size:1.25rem; font-weight:800; color:var(--text-primary); margin:0.35rem 0 0.2rem 0;">
                Horaris No Habituals &amp; Desfasaments Extrems (&ge; 25 min) (${investigationList.length})
              </h4>
              <p style="font-size:0.8rem; color:var(--text-muted); margin:0; max-width:760px; line-height:1.45;">
                Aquests registres presenten un retard de 25 minuts o més. No es consideren retencions habituals de trànsit de la ciutat, sinó <strong>horaris no normals o possibles incidències de seguiment/telemetria</strong> (com ara autobusos aturats fora de servei en capçalera amb el SAE encès, talls excepcionals de carrer o desfasaments de torn). Estan pendents d'investigació per resoldre la seva causa real.
              </p>
            </div>
            ${investigationList.length > 0 ? `
              <button type="button" class="btn-report-action btn-report-investigation" id="btn-copy-investigation-report" title="Copiar informe dels casos en investigació">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                <span>Copiar informe d'investigació</span>
              </button>
            ` : ''}
          </div>

          ${investigationList.length === 0 ? `
            <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:10px; padding:2rem; text-align:center; color:var(--text-muted); font-size:0.85rem;">
              Cap horari no habitual ni desfasament extrem (&ge; 25 min) detectat en aquest període (${selectedHours}h).
            </div>
          ` : `
            <div class="observatori-table-wrapper">
              <table class="observatori-table">
                <thead>
                  <tr>
                    <th style="width:45px; text-align:center;">#</th>
                    <th>Retard Transmès</th>
                    <th>Línia</th>
                    <th>Parada Afectada</th>
                    <th>Data i Hora</th>
                    <th>Estat / Diagnòstic</th>
                    <th style="text-align:center; cursor:help;" title="Tipus de senyal: GPS directe o Estimat">Senyal</th>
                    <th style="text-align:center;">Mapa</th>
                  </tr>
                </thead>
                <tbody>
                  ${investigationList.map((inc, i) => {
                    const lColor = getLineColor(inc.lineCode);
                    const signalTooltip = inc.isRealTime
                      ? 'Senyal GPS directe transmès pel vehicle físic.'
                      : 'Estimació per estima (dead-reckoning) per pèrdua temporal de senyal.';
                    return `
                      <tr>
                        <td style="font-weight:700; color:var(--text-muted); text-align:center;">${inc.rank || (i + 1)}</td>
                        <td style="font-weight:800; color:var(--accent-danger); white-space:nowrap;">+${inc.delayMins} min</td>
                        <td>
                          <div style="display:inline-flex; align-items:center; gap:5px; flex-wrap:wrap;">
                            <span style="background:${lColor}; color:${this.chipInk(lColor)}; padding:0.15rem 0.45rem; border-radius:5px; font-weight:800; font-size:0.75rem;">${this.esc(inc.lineCode)}</span>
                            ${formatBusBadge(inc.vehicleId)}
                          </div>
                        </td>
                        <td style="font-weight:600; color:var(--text-primary);">
                          ${this.esc(inc.stopName)}
                        </td>
                        <td style="color:var(--text-secondary); white-space:nowrap; font-size:0.8rem;">
                          ${this.esc(inc.formattedDate || '')}
                        </td>
                        <td style="white-space:nowrap; font-size:0.78rem;">
                          <span style="background:rgba(244,63,94,0.15); color:var(--accent-danger); padding:0.2rem 0.5rem; border-radius:6px; font-weight:700; font-size:0.72rem; display:inline-flex; align-items:center; gap:4px;">
                            Pendent d'investigació
                          </span>
                        </td>
                        <td style="text-align:center; white-space:nowrap;">
                          <span class="signal-badge ${inc.isRealTime ? 'gps' : 'estimated'}" title="${this.esc(signalTooltip)}">
                            <span class="dot"></span>
                            <span>${inc.isRealTime ? 'GPS' : 'Estimat'}</span>
                          </span>
                        </td>
                        <td style="text-align:center; white-space:nowrap;">
                          <button type="button" class="btn-locate-incident-stop" data-locate-line="${this.esc(inc.lineCode)}" data-locate-stop="${this.esc(inc.stopName)}" data-locate-stop-id="${this.esc(inc.stopId || '')}" title="Veure aquesta parada al mapa">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
                            <span>Mapa</span>
                          </button>
                          <button type="button" class="btn-investigate-incident" data-investigate-line="${this.esc(inc.lineCode)}" data-investigate-stop="${this.esc(inc.stopName)}" data-investigate-vehicle="${this.esc(inc.vehicleId || '')}" data-investigate-at="${inc.timestamp || ''}" title="Investigar aquest retard: veure les mostres originals que el contenen">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                            <span>Investigar</span>
                          </button>
                        </td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          `}
        </div>

        <!-- Forensic drill-down panel for this tab (populated by the Investigar buttons) -->
        <div id="incident-drilldown-panel" class="drilldown-panel" style="display:none;">
          <div class="drilldown-layout">
            <div class="drilldown-main">
              <h3 class="drilldown-title">Investigació del retard</h3>
              <div id="drilldown-content">Selecciona un retard de la taula per a investigar-lo.</div>
            </div>
            <aside class="drilldown-aside" aria-label="Evidència">
              <h4 class="drilldown-aside-title">Evidència</h4>
              <div id="drilldown-summary"></div>
            </aside>
          </div>
        </div>
      ` : `
        <!-- Mode 2: Clustered Trips & Trajectories -->
        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:10px; padding:0.85rem 1rem; margin-bottom:1rem; font-size:0.8rem; line-height:1.5;">
          <div style="display:flex; align-items:flex-start; gap:0.65rem;">
            <div style="flex:1;">
              <div style="font-weight:700; color:var(--text-primary); margin-bottom:0.25rem;">
                Com funcionen les expedicions i trajectòries?
              </div>
              <div style="color:var(--text-secondary); margin-bottom:0.6rem;">
                Cada targeta reconstrueix el recorregut continu d'un <strong>autobús físic individual</strong> (separat per identificador de vehicle), seguint cronològicament com evoluciona el seu retard parada a parada al llarg del servei:
              </div>
              <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:0.6rem; font-size:0.76rem; color:var(--text-muted);">
                <div style="background:var(--bg-surface); padding:0.55rem 0.75rem; border-radius:6px; border:1px solid var(--border-subtle);">
                  <strong style="color:var(--text-primary); display:block; margin-bottom:2px;">Bus ID individual</strong>
                  Cada vehicle es monitoritza per separat; no es barregen diferents autobusos que circulin alhora per la mateixa línia.
                </div>
                <div style="background:var(--bg-surface); padding:0.55rem 0.75rem; border-radius:6px; border:1px solid var(--border-subtle);">
                  <strong style="color:var(--text-primary); display:block; margin-bottom:2px;">Progressió parada a parada</strong>
                  Permet veure exactament a quina parada s'origina la retenció i com el bus va recuperant temps de trajecte.
                </div>
                <div style="background:var(--bg-surface); padding:0.55rem 0.75rem; border-radius:6px; border:1px solid var(--border-subtle);">
                  <strong style="color:var(--text-primary); display:block; margin-bottom:2px;">Normalització de l'horari</strong>
                  Si la seqüència s'acaba abans del final de la línia, indica que el vehicle ja ha absorbit el retard (&lt;3 min) o ha finalitzat el torn.
                </div>
              </div>
            </div>
          </div>
        </div>

        ${tripsList.length === 0 ? `
          <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:10px; padding:2rem; text-align:center; color:var(--text-muted);">
            No s'han detectat expedicions amb retard greu continuat en aquest període.
          </div>
        ` : `
          <div style="display:flex; flex-direction:column; gap:0.75rem;">
            ${tripsList.map(trip => {
              const lColor = getLineColor(trip.lineCode);
              const typeBadgeClass = (trip.incidentType === 'maintenance' || trip.incidentType === 'trip_relink')
                ? 'incident-badge-maintenance'
                : (trip.isMovingTraffic ? 'incident-badge-traffic' : 'incident-badge-layover');
              return `
                <div class="trip-card">
                  <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
                    <div style="display:flex; align-items:center; gap:0.5rem;">
                      <span style="background:${lColor}; color:${this.chipInk(lColor)}; padding:0.2rem 0.55rem; border-radius:6px; font-weight:800; font-size:0.8rem;">${this.esc(trip.lineCode)}</span>
                      <strong style="color:var(--text-primary); font-size:0.9rem;">Expedició del ${this.esc(trip.startTime)}</strong>
                      ${formatBusBadge(trip.vehicleId)}
                      <span style="color:var(--text-muted); font-size:0.78rem;">(durada activa: ~${trip.durationMinutes || 1} min)</span>
                    </div>
                    <div style="display:flex; align-items:center; gap:0.5rem;">
                      <span class="${typeBadgeClass}" style="padding:0.2rem 0.5rem; border-radius:6px; font-size:0.74rem; font-weight:700;">
                        ${this.esc(trip.incidentTypeLabel)}
                      </span>
                      <span style="background:rgba(239,68,68,0.15); color:var(--accent-danger); padding:0.2rem 0.55rem; border-radius:6px; font-size:0.78rem; font-weight:800;">
                        Màx: +${trip.maxDelayMins} min
                      </span>
                    </div>
                  </div>

                  <!-- Trajectory flow -->
                  <div class="trip-trajectory-flow">
                    <span style="font-weight:700; color:var(--text-muted); margin-right:0.25rem;">Trajectòria:</span>
                    ${(trip.stopProgression && trip.stopProgression.length > 0 
                      ? trip.stopProgression 
                      : (trip.stopsTraversed || []).map(s => ({ stopName: s, delayMins: null, isRecovered: false }))
                    ).map((st, sIdx, arr) => {
                      const dMins = st.delayMins;
                      let delayBadge = '';
                      if (dMins != null) {
                        const delayText = st.isRecovered
                          ? `${dMins > 0 ? `+${dMins}` : dMins}m ✓`
                          : `${dMins > 0 ? `+${dMins}` : dMins}m`;
                        const chipClass = st.isRecovered ? 'delay-low' : (st.belowThreshold ? 'delay-ok' : (dMins >= 10 ? 'delay-high' : 'delay-mid'));
                        delayBadge = `<span class="delay-chip ${chipClass}">${delayText}</span>`;
                      }
                      return `
                        <span class="stop-step ${st.isRecovered ? 'is-recovered' : ''} ${st.belowThreshold && !st.isRecovered ? 'is-below-threshold' : ''}" title="${this.esc(st.stopName)}${dMins != null ? ` (${st.isRecovered ? 'Recuperat' : 'Retard'}: +${dMins} min)` : ''}">
                          <span class="stop-node ${st.isRecovered ? 'recovered' : (st.belowThreshold ? 'ok' : (dMins >= 10 ? 'critical' : 'delayed'))}"></span>
                          <span class="stop-name">${this.esc(st.stopName)}</span>
                          ${delayBadge}
                        </span>
                        ${sIdx < arr.length - 1 ? '<span class="step-arrow">→</span>' : ''}
                      `;
                    }).join('')}${({
                      end_of_line: `<span class="trajectory-end">🏁 Final de línia</span>`,
                      recovered: `<span class="trajectory-end is-recovered">✅ Recuperat</span>`,
                      trip_change: `<span class="trajectory-end">🔀 Canvi de viatge</span>`,
                      relinked: `<span class="trajectory-end">🔀 Viatge reassignat pel SAE</span>`,
                      deadhead_return: `<span class="trajectory-end">↩️ Tornada sense servei</span>`,
                      signal_lost: `<span class="trajectory-end">📡 Sense més dades</span>`,
                      ongoing: `<span class="trajectory-end">⏳ En curs</span>`
                    })[trip.endReason] || ''}
                  </div>

                  ${trip.relink ? `
                  <div style="margin-top:0.5rem; font-size:0.76rem; color:var(--accent-warning); line-height:1.45;">
                    El sistema de l'operador tenia aquest bus assignat a un viatge anterior: a ${this.esc(trip.relink.stopName)} el retard passa de +${trip.relink.delayBefore} a ${trip.relink.delayAfter} min de cop, cosa físicament impossible. No és un retard real verificable.
                  </div>` : ''}

                  ${trip.deadhead ? `
                  <div style="margin-top:0.5rem; font-size:0.76rem; color:var(--accent-warning); line-height:1.45;">
                    Després ${/^[aeiouàèéíïòóúüh]/i.test(trip.deadhead.lastServedStop) ? 'd\'' : 'de '}${this.esc(trip.deadhead.lastServedStop)} el bus va tornar sense passatgers a ${this.esc(trip.deadhead.resumeStop)} en ${trip.deadhead.returnMinutes} min i no va fer el viatge cap a ${this.esc(trip.deadhead.towards)}, que dura ${trip.deadhead.oppositeTripMinutes} min. El retard no es va recuperar: el bus es va saltar un viatge.
                  </div>` : ''}

                  <!-- Context and action footer -->
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-top:0.6rem; font-size:0.75rem; color:var(--text-muted); flex-wrap:wrap; gap:0.4rem;">
                    <div>
                      <span>${this.esc(trip.trafficTag || '')} • ${trip.sampleCount} mostres registrades (${trip.incidentType === 'maintenance' ? 'proves o encesa a cotxeres' : (trip.isMovingTraffic ? `recorregut per ${trip.stopsCount} parades` : 'aturat a parada / regulant capçalera')})</span>
                    </div>
                    ${trip.incidentType !== 'maintenance' ? `
                      <button type="button" class="btn-locate-incident-stop" data-locate-line="${this.esc(trip.lineCode)}" data-locate-stop="${this.esc(trip.firstStop || trip.stopsTraversed[0])}" title="Veure aquesta parada al mapa">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
                        <span>Veure parada</span>
                      </button>
                    ` : ''}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `}
      `}
    `;
  }

  copyAnomaliesReport() {
    if (!this.lastIncidentData || !Array.isArray(this.lastIncidentData.telemetryAnomalies)) return;
    const list = this.lastIncidentData.telemetryAnomalies;
    if (list.length === 0) return;

    let text = `INFORME D'ANOMALIES DE TELEMETRIA SAE — ARRIBO! MATARÓ\n`;
    text += `Període: Darreres ${this._currentIncidentHours || 168}h | Línia: ${this._currentIncidentLine || 'Totes'}\n`;
    text += `Data d'extracció: ${new Date().toLocaleString('ca-ES')}\n`;
    text += `Total anomalies detectades: ${list.length}\n\n`;
    text += `Descripció: Aquests registres corresponen a desfasaments transmesos pel sistema SAE (CAD/AVL) d'Avanza (habitualment per assignació d'autobusos que inicien torn a expedicions anteriors no cobertes o arrencada a cotxeres amb consola encesa abans de sortida). No reflecteixen retencions de trànsit reals a la ciutat. També inclou els viatges reassignats pel SAE: trams on el retard desapareix de cop perquè el sistema tenia el bus assignat a un viatge que no feia. I les tornades sense servei: parades anotades mentre un bus tornava sense passatgers a l'inici de la línia després de saltar-se un viatge. I els salts de retard impossibles: el retard puja més de pressa que passa el temps perquè el sistema passa el bus a una expedició anterior.\n\n`;
    text += `Llistat d'incidències per auditar amb Avanza / Ajuntament de Mataró:\n`;

    list.forEach((item, idx) => {
      const sig = item.isRealTime ? 'GPS' : 'Estimat (dead-reckoning)';
      const isMaint = item.anomalyType === 'maintenance' || (item.anomalyType !== 'startup_sae' && item.anomalyType !== 'trip_relink' && item.anomalyType !== 'deadhead_return' && item.anomalyType !== 'delay_jump');
      const stopInfo = isMaint ? 'Cotxeres / Manteniment' : `Parada: "${item.stopName}"`;
      const busTag = item.vehicleId && !item.vehicleId.toLowerCase().endsWith('bus') ? ` | Bus #${item.vehicleId.replace(/^mataro_\w+_/i, '')}` : '';
      text += `${idx + 1}. [${item.lineCode}] ${item.formattedDate} — ${stopInfo} | Retard transmès: +${item.delayMins} min | Causa: ${item.trafficTag || item.diagnosticBadge || 'Anomalia'}${busTag} | Senyal: ${sig}\n`;
    });

    text += `\nGenerat per Arribo! Mataró (https://arribo.cat) a partir del feed oficial SIRI d'Avanza.`;

    const finish = () => {
      const btn = document.getElementById('btn-copy-anomalies-report');
      if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = '<span>✅ Copiat al porta-retalls!</span>';
        setTimeout(() => { btn.innerHTML = orig; }, 3000);
      }
    };

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(finish).catch(() => {
        prompt('Copia el text següent per a la teva reclamació:', text);
      });
    } else {
      prompt('Copia el text següent per a la teva reclamació:', text);
    }
  }

  copyInvestigationReport() {
    if (!this.lastIncidentData || !Array.isArray(this.lastIncidentData.investigationIncidents)) return;
    const list = this.lastIncidentData.investigationIncidents;
    if (list.length === 0) return;

    let text = `INFORME D'HORARIS NO HABITUALS & DESFASAMENTS EXTREMS (≥25 MIN) — ARRIBO! MATARÓ\n`;
    text += `Període: Darreres ${this._currentIncidentHours || 168}h | Línia: ${this._currentIncidentLine || 'Totes'}\n`;
    text += `Data d'extracció: ${new Date().toLocaleString('ca-ES')}\n`;
    text += `Total expedicions en investigació: ${list.length}\n\n`;
    text += `Descripció: Aquests registres corresponen a horaris no normals o desfasaments extrems de telemetria (de 25 minuts o més) pendents d'investigació per resoldre la causa real (busos aturats fora de servei, anomalies de servidor o desfasaments de torn).\n\n`;
    text += `Llistat d'expedicions en investigació:\n`;

    list.forEach((item, idx) => {
      const sig = item.isRealTime ? 'GPS' : 'Estimat (dead-reckoning)';
      const busTag = item.vehicleId && !item.vehicleId.toLowerCase().endsWith('bus') ? ` | Bus #${item.vehicleId.replace(/^mataro_\w+_/i, '')}` : '';
      text += `${idx + 1}. [${item.lineCode}] ${item.formattedDate} — Parada: "${item.stopName}" | Retard transmès: +${item.delayMins} min${busTag} | Senyal: ${sig}\n`;
    });

    text += `\nGenerat per Arribo! Mataró (https://arribo.cat) — Telemetria de transport públic.`;

    const finish = () => {
      const btn = document.getElementById('btn-copy-investigation-report');
      if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = '<span>✅ Copiat al porta-retalls!</span>';
        setTimeout(() => { btn.innerHTML = orig; }, 3000);
      }
    };

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(finish).catch(() => {
        prompt('Copia el resum per a la investigació:', text);
      });
    } else {
      prompt('Copia el resum per a la investigació:', text);
    }
  }

  // ==========================================
  // 5. MONTHLY AJUNTAMENT REPORT (Plan 9.4)
  // ==========================================

  async loadMonthlyReport(month = null, force = false) {
    this.currentTab = 'monthly';
    const contentContainer = document.getElementById('journalism-content-container');
    const termometreContainer = document.getElementById('journalism-termometre-container');
    const incidentsContainer = document.getElementById('journalism-incidents-container');
    const monthlyContainer = document.getElementById('journalism-monthly-container');
    const searchBarWrap = document.getElementById('journalism-search-bar-wrap');

    if (searchBarWrap) searchBarWrap.style.display = 'none';
    if (contentContainer) contentContainer.style.display = 'none';
    if (termometreContainer) termometreContainer.style.display = 'none';
    if (incidentsContainer) incidentsContainer.style.display = 'none';
    if (monthlyContainer) {
      monthlyContainer.style.display = 'block';
      this.showGpsGaps(false);
      if (!this._monthlyData || force || (month && month !== this._currentMonthlyMonth)) {
        monthlyContainer.innerHTML = '<div style="text-align:center; padding:3rem; color:var(--text-muted);"><span class="loading-spinner-inline"></span> Carregant informe mensual per a l\'Ajuntament...</div>';
      }
    }

    try {
      const qMonth = month || this._currentMonthlyMonth || '';
      const url = qMonth ? `/api/analytics/report/monthly?month=${encodeURIComponent(qMonth)}` : '/api/analytics/report/monthly';
      const res = await fetch(url).then(r => r.json());
      if (res && res.success) {
        this._monthlyData = res;
        this._currentMonthlyMonth = res.month;
        this.renderMonthlyReport(res);
      } else {
        if (monthlyContainer) {
          monthlyContainer.innerHTML = `<div style="text-align:center; padding:2rem; color:var(--text-danger);">Error carregant l'informe mensual: ${this.esc(res?.error || 'Servei no disponible')}</div>`;
        }
      }
    } catch (e) {
      if (monthlyContainer) {
        monthlyContainer.innerHTML = `<div style="text-align:center; padding:2rem; color:var(--text-danger);">Error de connexió en carregar l'informe mensual: ${this.esc(e.message)}</div>`;
      }
    }
  }

  renderMonthlyReport(data) {
    const monthlyContainer = document.getElementById('journalism-monthly-container');
    if (!monthlyContainer) return;

    const s = data.summary || {};
    const lines = data.linesPunctuality || [];
    const hourly = data.hourlyPunctuality || [];
    const worst = data.worstStops || [];
    const cov = data.dataCoverage || {};

    const genDate = data.generationTimestamp
      ? new Date(data.generationTimestamp).toLocaleString('ca-ES', { timeZone: 'Europe/Madrid' })
      : '--';

    const linesRows = lines.map(l => {
      const badgeColor = this.getLineColor(l.lineCode) || '#1976d2';
      return `
        <tr>
          <td><span class="line-badge" style="background:${badgeColor}; color:#fff; padding:2px 8px; border-radius:4px; font-weight:bold;">${this.esc(l.lineCode)}</span></td>
          <td style="text-align:right;">${l.visitCount.toLocaleString('ca-ES')}</td>
          <td style="text-align:right; font-weight:bold; color:var(--color-on-time, #2e7d32);">${l.onTimePct}%</td>
          <td style="text-align:right; color:var(--color-early, #1976d2);">${l.earlyPct}%</td>
          <td style="text-align:right; color:var(--color-late, #f57c00);">${l.latePct}%</td>
          <td style="text-align:right; color:var(--color-severe, #d32f2f);">${l.severeLatePct}%</td>
          <td style="text-align:right;">${l.avgDelayMins > 0 ? '+' : ''}${l.avgDelayMins} m</td>
          <td style="text-align:right;">${l.maxDelayMins} m</td>
        </tr>
      `;
    }).join('');

    const hourlyRows = hourly.map(h => {
      return `
        <tr>
          <td><strong>${this.esc(h.hourLabel)}</strong></td>
          <td style="text-align:right;">${h.visitCount.toLocaleString('ca-ES')}</td>
          <td style="text-align:right; font-weight:bold; color:var(--color-on-time, #2e7d32);">${h.onTimePct}%</td>
          <td style="text-align:right; color:var(--color-early, #1976d2);">${h.earlyPct}%</td>
          <td style="text-align:right; color:var(--color-late, #f57c00);">${h.latePct}%</td>
          <td style="text-align:right; color:var(--color-severe, #d32f2f);">${h.severeLatePct}%</td>
          <td style="text-align:right;">${h.avgDelayMins > 0 ? '+' : ''}${h.avgDelayMins} m</td>
        </tr>
      `;
    }).join('');

    const worstRows = worst.length > 0 ? worst.map((w, idx) => {
      return `
        <tr>
          <td style="text-align:center;">${idx + 1}</td>
          <td><strong>${this.esc(w.stopName)}</strong></td>
          <td><span style="font-size:0.8rem; color:var(--text-secondary);">${this.esc(w.linesServed || '')}</span></td>
          <td style="text-align:right;">${w.visitCount.toLocaleString('ca-ES')}</td>
          <td style="text-align:right; font-weight:bold; color:var(--color-on-time, #2e7d32);">${w.onTimePct}%</td>
          <td style="text-align:right; color:var(--color-late, #f57c00);">${w.latePct}%</td>
          <td style="text-align:right; color:var(--color-severe, #d32f2f);">${w.severeLatePct}%</td>
          <td style="text-align:right; font-weight:bold; color:var(--color-severe, #d32f2f);">${w.avgDelayMins > 0 ? '+' : ''}${w.avgDelayMins} m</td>
        </tr>
      `;
    }).join('') : `<tr><td colspan="8" style="text-align:center; padding:1rem; color:var(--text-muted); font-style:italic;">Cap parada no supera el llindar de 50 passos consolidats en aquest mes.</td></tr>`;

    monthlyContainer.innerHTML = `
      <div class="monthly-report-wrapper">
        <div class="monthly-report-header">
          <div class="monthly-report-title">
            <div style="font-size:0.75rem; text-transform:uppercase; letter-spacing:0.05em; color:var(--brand-primary); font-weight:700; margin-bottom:0.25rem;">
              Ajuntament de Mataró • Servei de Mobilitat Urbana
            </div>
            <h2>Informe Mensual de Puntualitat i Qualitat de Servei</h2>
            <div class="monthly-report-meta">
              <span><strong>Mes d'anàlisi:</strong> ${this.esc(data.month)}</span>
              <span><strong>Versió de dades:</strong> <code>${this.esc(data.dataVersion || 'v3.0')}</code></span>
              <span><strong>Generat:</strong> ${this.esc(genDate)}</span>
              <span><strong>Base:</strong> Passos consolidats per parada (${this.esc(s.basis || 'stop_visits')})</span>
            </div>
          </div>
          <div class="monthly-report-controls">
            <span class="monthly-controls-label" style="font-size:0.8rem; color:var(--text-secondary);">Selecciona mes:</span>
            <input type="month" id="monthly-report-month-input" class="monthly-report-month-input" value="${this.esc(data.month)}">
            <button type="button" class="btn-print-report" id="btn-print-monthly-report" title="Imprimir informe en format A4 o desar com a PDF">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>
              <span>Imprimir / PDF</span>
            </button>
          </div>
        </div>

        <!-- Global KPIs -->
        <h4 style="margin:1rem 0 0.5rem 0; font-size:0.95rem; color:var(--text-primary);">1. Resum Global de Puntualitat de la Xarxa</h4>
        <div class="monthly-kpi-grid">
          <div class="monthly-kpi-card">
            <div class="kpi-val">${(s.totalVisits || 0).toLocaleString('ca-ES')}</div>
            <div class="kpi-lbl">${s.basis === 'delay_logs' ? 'Mostres avaluades (sense passos consolidats)' : 'Passos avaluats (stop_visits)'}</div>
          </div>
          <div class="monthly-kpi-card">
            <div class="kpi-val" style="color:var(--color-on-time, #2e7d32);">${s.onTimePct ?? '--'}%</div>
            <div class="kpi-lbl">Puntualitat global (-1 a +3 min)</div>
          </div>
          <div class="monthly-kpi-card">
            <div class="kpi-val" style="color:var(--color-early, #1976d2);">${s.earlyPct ?? '--'}%</div>
            <div class="kpi-lbl">Passos avançats (&lt; -1 min)</div>
          </div>
          <div class="monthly-kpi-card">
            <div class="kpi-val" style="color:var(--color-late, #f57c00);">${s.latePct ?? '--'}%</div>
            <div class="kpi-lbl">Passos amb retard (&gt; 3 min)</div>
          </div>
          <div class="monthly-kpi-card">
            <div class="kpi-val" style="color:var(--color-severe, #d32f2f);">${s.severeLatePct ?? '--'}%</div>
            <div class="kpi-lbl">Retards greus (&ge; 5 min)</div>
          </div>
          <div class="monthly-kpi-card">
            <div class="kpi-val">${cov.coveragePct ?? '--'}%</div>
            <div class="kpi-lbl">Cobertura dades (${cov.activeFeedHours || 0}h / ${cov.scheduledServiceHours || 0}h)</div>
          </div>
        </div>

        <!-- Per Line Breakdown -->
        <h4 style="margin:1.5rem 0 0.5rem 0; font-size:0.95rem; color:var(--text-primary);">2. Puntualitat i Retards per Línia (L1–L8)</h4>
        <table class="monthly-report-table">
          <thead>
            <tr>
              <th>Línia</th>
              <th style="text-align:right;">Passos</th>
              <th style="text-align:right;">Puntual %</th>
              <th style="text-align:right;">Avançat %</th>
              <th style="text-align:right;">Retard %</th>
              <th style="text-align:right;">Greu &ge;5m %</th>
              <th style="text-align:right;">Retard Mitjà</th>
              <th style="text-align:right;">Retard Màxim</th>
            </tr>
          </thead>
          <tbody>
            ${linesRows}
          </tbody>
        </table>

        <!-- Per Hour Breakdown -->
        <h4 style="margin:1.5rem 0 0.5rem 0; font-size:0.95rem; color:var(--text-primary);">3. Puntualitat per Franja Horària Operativa</h4>
        <table class="monthly-report-table">
          <thead>
            <tr>
              <th>Franja Horària</th>
              <th style="text-align:right;">Passos</th>
              <th style="text-align:right;">Puntual %</th>
              <th style="text-align:right;">Avançat %</th>
              <th style="text-align:right;">Retard %</th>
              <th style="text-align:right;">Greu &ge;5m %</th>
              <th style="text-align:right;">Retard Mitjà</th>
            </tr>
          </thead>
          <tbody>
            ${hourlyRows}
          </tbody>
        </table>

        <!-- Worst Stops (>= 50 visits) -->
        <h4 style="margin:1.5rem 0 0.5rem 0; font-size:0.95rem; color:var(--text-primary);">4. Parades amb Major Retard Acumulat (mínim 50 passos)</h4>
        <table class="monthly-report-table">
          <thead>
            <tr>
              <th style="text-align:center;">#</th>
              <th>Parada</th>
              <th>Línies</th>
              <th style="text-align:right;">Passos</th>
              <th style="text-align:right;">Puntual %</th>
              <th style="text-align:right;">Retard %</th>
              <th style="text-align:right;">Greu &ge;5m %</th>
              <th style="text-align:right;">Retard Mitjà</th>
            </tr>
          </thead>
          <tbody>
            ${worstRows}
          </tbody>
        </table>

        <!-- Methodology & Audit Invariants -->
        <div class="monthly-methodology-box">
          <strong style="display:block; margin-bottom:0.35rem; color:var(--text-primary);">Metodologia de Càlcul i Criteris d'Auditoria:</strong>
          <p style="margin:0; line-height:1.5; color:var(--text-secondary); font-size:0.82rem;">
            ${this.esc(data.methodology)}
          </p>
        </div>
      </div>
    `;

    // Bind controls
    document.getElementById('monthly-report-month-input')?.addEventListener('change', (e) => {
      const newMonth = e.target.value;
      if (newMonth && /^\d{4}-\d{2}$/.test(newMonth)) {
        this._currentMonthlyMonth = newMonth;
        this.updateUrl();
        this.loadMonthlyReport(newMonth);
      }
    });

    document.getElementById('btn-print-monthly-report')?.addEventListener('click', () => {
      window.print();
    });
  }
}

// Instantiate standalone Observatori application on DOM load
window.addEventListener('DOMContentLoaded', () => {
  window.observatoriApp = new ObservatoriApp();
  // Provenance only; never blocks or fails the page.
  window.TransitUtils?.showSeasonPill();
});

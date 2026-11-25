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
    this.lineCode = ''; // exact line filter for Mataró's reports (?linia=), set by the line pills
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

  t(key, vars) {
    return window.ArriboI18n ? window.ArriboI18n.t(key, vars) : key;
  }

  lang() {
    return (window.ArriboI18n && window.ArriboI18n.lang) || 'ca';
  }

  locale() {
    const l = this.lang();
    return l === 'en' ? 'en-GB' : (l === 'es' ? 'es-ES' : 'ca-ES');
  }

  dec(x) {
    return this.lang() === 'en' ? String(x) : String(x).replace('.', ',');
  }

  _afterStop(name) {
    const escaped = this.esc(name);
    const l = this.lang();
    if (l === 'en') return escaped;
    if (l === 'es') return `de ${escaped}`;
    return /^[aeiouàèéíïòóúüh]/i.test(String(name || '')) ? `d'${escaped}` : `de ${escaped}`;
  }

  init() {
    window.TransitPwa?.init?.();
    this.initTheme();
    this.initUrlState();
    this.bindEvents();
    this.loadActiveTab();
    this.fetchLinesMetadata();
    this.fetchDataHealth();
    this.initGpsGaps();
  }

  initTheme() {
    const savedTheme = window.TransitUtils?.getStoredTheme
      ? window.TransitUtils.getStoredTheme()
      : (localStorage.getItem('arribo_theme') || 'dark');
    document.documentElement.setAttribute('data-theme', savedTheme);
    const themeBtn = document.getElementById('btn-page-theme-toggle');
    themeBtn?.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      if (window.TransitUtils?.setStoredTheme) {
        window.TransitUtils.setStoredTheme(next);
      } else {
        localStorage.setItem('arribo_theme', next);
      }
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

    const linia = params.get('linia');
    if (linia && /^[A-Za-z0-9]{1,6}$/.test(linia)) this.lineCode = linia.toUpperCase();

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
      const dataTab = btn.getAttribute('data-tab');
      const dataHours = parseInt(btn.getAttribute('data-hours') || '0', 10);
      const isActive =
        (this.currentTab === 'termometre' && dataTab === 'termometre') ||
        (this.currentTab === 'incidents' && dataTab === 'incidents') ||
        (this.currentTab === 'monthly' && dataTab === 'monthly') ||
        (this.currentTab === 'journalism' && !dataTab && dataHours === this.currentHours);
      btn.classList.toggle('active', isActive);
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
  }

  isLineFilterActive() {
    const scope = document.body?.dataset?.dadesScope;
    return !scope || scope === 'bus';
  }

  onScopeChange() {
    const active = this.isLineFilterActive();
    if (this._lastLineFilterActive !== active) {
      this._lastLineFilterActive = active;
      this.renderLineFilter();
      this.updateUrl();
    }
    // A train operator has only the report: leave the bus-only tabs for it.
    if ((document.body.dataset.dadesScope === 'rail' || document.body.dataset.dadesScope === 'est') && this.currentTab !== 'journalism') {
      document.querySelector(`#journalism-timeframe-tabs [data-hours="${this.currentHours || 24}"]`)?.click();
      return;
    }
    // Sync the GPS/signal-loss section with the active network scope.
    this.syncGpsGapScope();
    // Any scope change re-renders the report: under "Tot" it lists the trains beside Mataró.
    if (this.currentReport && this.currentTab === 'journalism') {
      this.renderJournalismReport(this.currentReport);
    } else if (this._lastDataHealth !== undefined) {
      this.renderDataHealth(this._lastDataHealth);
    }
  }

  updateUrl() {
    const params = new URLSearchParams();
    try {
      const xarxa = new URLSearchParams(window.location.search).get('xarxa');
      if (xarxa) params.set('xarxa', xarxa);
    } catch { /* ignore */ }
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

    if (this.lineCode && this.isLineFilterActive() && this.currentTab === 'journalism') {
      params.set('linia', this.lineCode);
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

  /**
   * The line pills above Mataró's report: "Totes" plus one per trackable
   * catalog line (a SegmentedControl). Hidden with fewer than two lines.
   */
  renderLineFilter() {
    const dock = document.getElementById('journalism-line-filter');
    if (!dock) return;
    const lines = (this.availableLines || []).filter(l => l && l.trackable !== false && l.code);
    dock.hidden = lines.length < 2 || this.currentTab !== 'journalism';
    if (dock.hidden) return;
    if (this.lineCode && !lines.some(l => String(l.code).toUpperCase() === this.lineCode)) this.lineCode = '';
    const items = [{ code: '', label: this.t('dades.allLines') }, ...lines.map(l => ({ code: String(l.code).toUpperCase(), label: String(l.code) }))];
    dock.innerHTML = items.map(i => {
      const on = i.code === this.lineCode;
      return `<button type="button" class="pill${on ? ' is-active' : ''}" aria-pressed="${on}" data-line-code="${this.esc(i.code)}">${this.esc(i.label)}</button>`;
    }).join('');
  }

  async fetchLinesMetadata() {
    try {
      const res = await fetch('/api/lines').then(r => r.json());
      if (res && res.success && Array.isArray(res.lines)) {
        this.availableLines = res.lines;
        this.renderLineFilter();
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
   * 7 dies), not to the Termòmetre, Top Incidents or monthly tabs. It sits
   * below the delays and above the operator comparison, which hides with it.
   */
  showGpsGaps(show) {
    const operators = document.getElementById('journalism-operators-container');
    if (operators) operators.style.display = show ? '' : 'none';
    const section = document.getElementById('gps-gaps-section');
    if (!section) return;
    section.style.display = show ? '' : 'none';
    // Leaflet measured the map while it was hidden: size it again.
    if (show && this.gpsGapMap) this.gpsGapMap.invalidateSize({ pan: false });
  }

  /**
   * The map has no period buttons of its own: it follows the report's
   * 24 h / 48 h / 7 dies tab (1, 2 or 7 days). A change reloads it only once
   * it has been loaded; before that the first load picks the period up.
   */
  setGpsGapPeriod(hours) {
    const days = Math.min(30, Math.max(1, Math.round((Number(hours) || 24) / 24)));
    if (days === this.gpsGapDays) return;
    this.gpsGapDays = days;
    this.gpsGapVehicle = '';
    if (this._gpsGapReq) this.loadGpsGaps();
  }

  gpsGapScopeAgency() {
    try {
      const x = new URLSearchParams(window.location.search).get('xarxa') || '';
      if (x && x !== 'all') return x;
    } catch { /* ignore */ }
    return null;
  }

  syncGpsGapScope() {
    const locked = this.gpsGapScopeAgency();
    const target = locked || this.gpsGapAgency || 'mataro';
    const agencyChanged = this.gpsGapAgency !== target;
    this.gpsGapAgency = target;
    if (agencyChanged) {
      this.gpsGapLine = 'all';
      this.gpsGapVehicle = '';
      this.gpsGapHide = '';
      if (this.gpsGapAgency !== 'moventis') this.gpsGapMode = 'gps';
    }
    if (this._gpsGapReq && (agencyChanged || !this._gpsGapData)) {
      this.loadGpsGaps();
    } else if (this._gpsGapData) {
      this.syncGpsGapControls(this._gpsGapData);
    }
  }

  initGpsGaps() {
    const section = document.getElementById('gps-gaps-section');
    if (!section) return;
    this.gpsGapDays = Math.min(30, Math.max(1, Math.round((Number(this.currentHours) || 24) / 24)));
    this.gpsGapAgency = this.gpsGapScopeAgency() || 'mataro';
    this.gpsGapMode = 'gps';
    this.gpsGapLine = 'all';
    this.gpsGapVehicle = '';
    this.gpsGapHide = '';
    this.gpsGapMin = 1;
    this.gpsGapMarkers = [];
    section.addEventListener('click', (e) => {
      const agencyBtn = e.target.closest('[data-gps-agency]');
      const modeBtn = e.target.closest('[data-gps-mode]');
      const lineBtn = e.target.closest('[data-gps-line]');
      const item = e.target.closest('[data-gps-cell]');
      const busBtn = e.target.closest('[data-gps-bus]');
      const hideBtn = e.target.closest('[data-gps-hide]');
      if (e.target.closest('[data-gps-close]')) {
        this.clearGpsGapSelection();
      } else if (e.target.closest('[data-gps-retry]')) {
        this.loadGpsGaps();
      } else if (agencyBtn) {
        const nextAgency = agencyBtn.dataset.gpsAgency || 'mataro';
        if (nextAgency !== this.gpsGapAgency) {
          this.gpsGapAgency = nextAgency;
          this.gpsGapLine = 'all';
          this.gpsGapVehicle = '';
          this.gpsGapHide = '';
          if (nextAgency !== 'moventis') this.gpsGapMode = 'gps';
          this.loadGpsGaps();
        }
      } else if (modeBtn) {
        const nextMode = modeBtn.dataset.gpsMode === 'stop' ? 'stop' : 'gps';
        if (nextMode !== this.gpsGapMode) {
          this.gpsGapMode = nextMode;
          this.gpsGapVehicle = '';
          this.loadGpsGaps();
        }
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
      } else if (lineBtn) {
        this.gpsGapLine = lineBtn.dataset.gpsLine || 'all';
        this.gpsGapVehicle = '';
        section.querySelectorAll('[data-gps-line]').forEach(b => b.classList.toggle('active', b === lineBtn));
        this.loadGpsGaps();
      } else if (item) {
        this.focusGpsGapCell(Number(item.dataset.gpsCell));
      }
    });
    // Minimum losses at one spot: filters the loaded answer, no new request.
    // Dragging redraws; letting go also refits the map to what is left.
    const minInput = document.getElementById('gps-gaps-min');
    if (minInput) {
      minInput.addEventListener('input', () => {
        this.gpsGapMin = Number(minInput.value) || 1;
        if (this._gpsGapData) this.renderGpsGaps(this._gpsGapData, { fit: false });
      });
      minInput.addEventListener('change', () => {
        if (this._gpsGapData) this.renderGpsGaps(this._gpsGapData);
      });
    }
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
    const agency = this.gpsGapAgency || 'mataro';
    const agencyQ = agency && agency !== 'mataro' ? `&agency=${encodeURIComponent(agency)}` : '';
    const modeQ = agency === 'moventis' && this.gpsGapMode === 'stop' ? '&mode=stop' : '';
    const bus = this.gpsGapVehicle ? `&vehicle=${encodeURIComponent(this.gpsGapVehicle)}` : (this.gpsGapHide && agency === 'mataro' ? `&hide=${this.gpsGapHide}` : '');
    const url = `/api/analytics/gps-gaps?days=${this.gpsGapDays}&line=${encodeURIComponent(this.gpsGapLine)}${agencyQ}${modeQ}${bus}`;
    // A choice seen in the last minute (the server caches as long) is redrawn
    // without asking again: going back and forth between buses costs nothing.
    if (!this.gpsGapResponses) this.gpsGapResponses = new Map();
    const seen = this.gpsGapResponses.get(url);
    if (seen && Date.now() - seen.at < 60000) {
      this.renderGpsGaps(seen.data);
      return;
    }
    if (summary) summary.textContent = this.t('dades.gpsLoading');
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
    const kept = this._gpsGapShown ? this.t('dades.gpsKeptPrev') : '';
    if (summary) {
      summary.innerHTML = retryAfter
        ? this.esc(this.t('dades.gpsRateLimited', { s: retryAfter, kept }))
        : `${this.esc(this.t('dades.gpsLoadError', { kept }))} <button type="button" class="observatori-pill-btn gps-bus-clear" data-gps-retry>${this.esc(this.t('dades.gpsRetry'))}</button>`;
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
    const ag = this.gpsGapAgency || 'mataro';
    if (ag !== 'mataro') {
      return `<span class="line-chip" data-line="${this.esc(`${ag}:${code}`)}">${this.esc(code)}</span>`;
    }
    const n = /^L([1-8])$/.exec(String(code || '').toUpperCase());
    return n
      ? `<span class="line-chip line-chip-${n[1]}">L${n[1]}</span>`
      : `<span class="line-chip">${this.esc(code)}</span>`;
  }

  isGpsGapRailAgency(agency = this.gpsGapAgency) {
    return agency === 'renfe_rodalies' || agency === 'fgc';
  }

  syncGpsGapControls(data) {
    const agency = (data && data.agency) || this.gpsGapAgency || 'mataro';
    const mode = (data && data.signalMode) || this.gpsGapMode || 'gps';
    const isRail = this.isGpsGapRailAgency(agency);
    const agencies = Array.isArray(data?.availableAgencies) ? data.availableAgencies : [];
    const locked = this.gpsGapScopeAgency();

    const agWrap = document.getElementById('gps-gaps-agency');
    if (agWrap) {
      if (!locked && agencies.length > 1) {
        agWrap.hidden = false;
        agWrap.innerHTML = agencies.map(a => `<button type="button" class="observatori-pill-btn${a.id === agency ? ' active' : ''}" data-gps-agency="${this.esc(a.id)}">${this.esc(a.name)}</button>`).join('');
      } else {
        agWrap.hidden = true;
      }
    }

    const activeAgencyMeta = agencies.find(a => a.id === agency);
    const supportsStop = Boolean(activeAgencyMeta?.supportsStopMode || agency === 'moventis');
    const modeWrap = document.getElementById('gps-gaps-mode');
    if (modeWrap) {
      modeWrap.hidden = !supportsStop;
      modeWrap.querySelectorAll('[data-gps-mode]').forEach(b => {
        b.classList.toggle('active', b.dataset.gpsMode === (supportsStop ? mode : 'gps'));
      });
    }

    const title = document.getElementById('gps-gaps-title');
    if (title) title.textContent = this.t(isRail ? 'dades.gpsTitleRail' : 'dades.gpsTitle');
    const subtitle = document.getElementById('gps-gaps-subtitle');
    if (subtitle) {
      subtitle.textContent = this.t(supportsStop && mode === 'stop' ? 'dades.gpsStopSubtitle' : (isRail ? 'dades.gpsSubtitleRail' : 'dades.gpsSubtitle'));
    }
    const legRec = document.getElementById('gps-gaps-legend-recurrent');
    if (legRec) legRec.textContent = this.t(isRail ? 'dades.gpsLegendRecurrentRail' : 'dades.gpsLegendRecurrent');
    const busTitle = document.getElementById('gps-gaps-buses-title');
    if (busTitle) busTitle.textContent = this.t(isRail ? 'dades.gpsTrainsTitle' : 'dades.gpsBusesTitle');
    const busIntro = document.getElementById('gps-gaps-buses-intro');
    if (busIntro) busIntro.textContent = this.t(isRail ? 'dades.gpsTrainsIntro' : 'dades.gpsBusesIntro');

    const hideWrap = document.getElementById('gps-gaps-hide');
    if (hideWrap) {
      hideWrap.hidden = agency !== 'mataro';
    }

    const linesWrap = document.getElementById('gps-gaps-lines');
    if (linesWrap) {
      const isMataro = agency === 'mataro';
      linesWrap.classList.toggle('is-dynamic-lines', !isMataro);
      const rawLines = isMataro
        ? ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8']
        : (Array.isArray(data?.lines) ? data.lines.slice(0, 18) : []);
      const curLine = String(this.gpsGapLine || 'all');
      const pills = [`<button type="button" class="observatori-pill-btn${curLine === 'all' ? ' active' : ''}" data-gps-line="all">${this.esc(this.t('dades.gpsAllLines'))}</button>`]
        .concat(rawLines.map(c => `<button type="button" class="observatori-pill-btn${curLine.toUpperCase() === String(c).toUpperCase() ? ' active' : ''}" data-gps-line="${this.esc(c)}">${this.esc(c)}</button>`));
      linesWrap.innerHTML = pills.join('');
    }
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
    if ((this.gpsGapAgency || 'mataro') === 'mataro') {
      this.showGpsGapPaths(c, detail);
      this.showGpsGapPasses(c, detail);
    }
  }

  gpsGapDetailHtml(c) {
    const isMataro = (this.gpsGapAgency || 'mataro') === 'mataro';
    const isRail = this.isGpsGapRailAgency();
    const isStopMode = this._gpsGapData?.signalMode === 'stop';
    const back = Math.round(L.latLng(c.lat, c.lon).distanceTo(L.latLng(c.regainedLat, c.regainedLon)));
    const last = new Date(c.lastTs).toLocaleString(this.locale(), { timeZone: 'Europe/Madrid', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const unitWord = isStopMode
      ? this.t(c.vehicles === 1 ? 'dades.gpsStopTripOne' : 'dades.gpsStopTripMany')
      : this.t(isRail ? (c.vehicles === 1 ? 'dades.gpsTrainOne' : 'dades.gpsTrainMany') : (c.vehicles === 1 ? 'dades.gpsBusOne' : 'dades.gpsBusMany'));
    return `<div class="gps-gaps-popup">
      <div class="gps-gaps-popup-head">
        <strong>${c.stopName ? this.esc(this.t('dades.gpsNearStop', { stop: c.stopName })) : this.esc(this.t('dades.gpsNoNearStop'))}</strong>
        <span class="gps-gaps-popup-tag${c.recurrent ? ' recurrent' : ''}">${this.esc(this.t(c.recurrent ? 'dades.gpsTagRecurrent' : 'dades.gpsTagSingle'))}</span>
      </div>
      <button type="button" class="btn-icon gps-gaps-detail-close" data-gps-close aria-label="${this.esc(this.t('dades.gpsCloseDetail'))}">&times;</button>
      <dl class="gps-gaps-popup-stats">
        <dt>${this.esc(this.t('dades.gpsDtLosses'))}</dt><dd>${c.count} · ${c.vehicles} ${this.esc(unitWord)}</dd>
        <dt>${this.esc(this.t('dades.gpsDtNoSignal'))}</dt><dd>${this.esc(this.fmtGapDuration(c.medianGapSec))}${c.count > 1 ? this.esc(this.t('dades.gpsMedianSuffix')) : ''}</dd>
        ${c.count > 1 ? `<dt>${this.esc(this.t('dades.gpsDtLongest'))}</dt><dd>${this.esc(this.fmtGapDuration(c.maxGapSec))}</dd>` : ''}
        ${!isStopMode ? `<dt>${this.esc(this.t('dades.gpsDtRegains'))}</dt><dd>${this.esc(this.t('dades.gpsRegainsM', { m: back }))}</dd>` : ''}
        <dt>${this.esc(this.t('dades.gpsDtLast'))}</dt><dd>${this.esc(last)}</dd>
      </dl>
      <div class="gps-gaps-popup-lines">${c.lines.map(code => this.lineChip(code)).join('')}</div>
      ${isMataro ? `<div class="gps-gaps-popup-route" data-gps-route><p>${this.esc(this.t('dades.gpsSearchingRoute'))}</p></div>
      <div class="gps-gaps-popup-route gps-gaps-passes" data-gps-passes><p>${this.esc(this.t('dades.gpsSearchingPasses'))}</p></div>` : ''}
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
      box.innerHTML = `<p>${this.esc(this.t('dades.gpsPassesError'))}</p>`;
      return;
    }
    const t = data.totals;
    if (!t || !t.buses) {
      box.innerHTML = `<p>${this.esc(this.t('dades.gpsPassesNone'))}</p>`;
      return;
    }
    const passes = t.lost + t.gpsPasses;
    const losers = data.buses.filter(b => b.lost);
    const clean = data.buses.filter(b => !b.lost && b.gpsPasses);
    const cleanPasses = clean.reduce((s, b) => s + b.gpsPasses, 0);
    const period = this.gpsGapDays === 1 ? this.t('dades.gpsPeriod24h') : this.t('dades.gpsPeriodDays', { n: this.gpsGapDays });
    const repeat = losers.find(b => b.lost >= 2 && b.lost / (b.lost + b.gpsPasses) >= 0.5);
    let verdict;
    if (passes < 8) {
      verdict = this.t('dades.gpsVerdictFew');
    } else if (t.lost / passes >= 0.5 && t.lossBuses >= 2) {
      verdict = this.t('dades.gpsVerdictPlace');
    } else if (t.lost / passes <= 0.25 && t.cleanBuses >= 3) {
      verdict = this.t('dades.gpsVerdictCleanHead', { ok: t.gpsPasses, total: passes })
        + (repeat
          ? this.t('dades.gpsVerdictBusEquip', { id: repeat.vehicleId, lost: repeat.lost, total: repeat.lost + repeat.gpsPasses })
          : this.t('dades.gpsVerdictSingle'));
    } else {
      verdict = this.t('dades.gpsVerdictMixed');
    }
    const cleanList = clean.slice(0, 10).map(b => `${this.esc(b.vehicleId)} (${b.gpsPasses})`).join(', ');
    const lostPart = t.lossBuses ? this.esc(this.t('dades.gpsPassesSummaryLost', { n: t.lossBuses })) : '';
    const morePart = clean.length > 10 ? this.esc(this.t('dades.gpsPassesMore', { n: clean.length - 10 })) : '';
    box.innerHTML = `<h5>${this.esc(this.t('dades.gpsPassesTitle'))}</h5>
      <p>${this.t('dades.gpsPassesSummary', { period: this.esc(period), buses: t.buses, clean: t.cleanBuses, passes: cleanPasses, lost: lostPart })}</p>
      ${losers.length ? `<ul class="gps-gaps-popup-paths">${losers.map(b => `<li><span>${b.lines.slice(0, 2).map(code => this.lineChip(code)).join('')}<span>${this.esc(b.vehicleId)}</span><b>${this.esc(this.t('dades.gpsPassesLostOf', { lost: b.lost, total: b.lost + b.gpsPasses }))}</b></span></li>`).join('')}</ul>` : ''}
      ${clean.length ? `<p>${this.t('dades.gpsPassesAlways', { list: cleanList, more: morePart })}</p>` : ''}
      <p class="gps-gaps-passes-verdict">${this.esc(verdict)}</p>
      ${(cell.count || 0) > ids.length ? `<p>${this.esc(this.t('dades.gpsPassesRecentNote', { n: ids.length }))}</p>` : ''}`;
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
        for (const p of (res && res.paths) || []) {
          this.gpsGapPathCache.set(p.id, p);
          if (this.gpsGapPathCache.size > 200) {
            this.gpsGapPathCache.delete(this.gpsGapPathCache.keys().next().value);
          }
        }
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
      const hhmm = ts => (Number.isFinite(ts) ? new Date(ts).toLocaleTimeString(this.locale(), { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' }) : '');
      const drawn = p => Array.isArray(p.path) && p.lengthM >= 25;
      const what = p => (!Array.isArray(p.path) ? this.t('dades.gpsPathNotPlaced') : drawn(p) ? `${p.lengthM} m` : this.t('dades.gpsPathStopped'));
      const row = p => {
        const inner = `${this.lineChip(p.lineCode)}<span>${p.vehicleId ? `${this.esc(p.vehicleId)} · ` : ''}${this.esc(hhmm(p.lostTs))} · ${this.esc(this.fmtGapDuration(p.gapSec))}</span><b>${this.esc(what(p))}</b>`;
        return drawn(p) ? `<li><button type="button" data-gps-path="${p.id}">${inner}</button></li>` : `<li><span>${inner}</span></li>`;
      };
      const hint = paths.length
        ? this.t('dades.gpsPathHint')
        : (stood ? '' : this.t('dades.gpsPathNotFound'));
      note.innerHTML = rows.length
        ? `<ul class="gps-gaps-popup-paths">${rows.map(row).join('')}</ul>${hint ? `<p>${this.esc(hint)}</p>` : ''}`
        : failed
          ? `<p>${this.esc(this.t('dades.gpsPathLoadError'))}</p>`
          : `<p>${this.esc(this.t('dades.gpsPathNotFound'))}</p>`;
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
   * Which buses lose GPS the most (app/geo.go): each against
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
    const isRail = this.isGpsGapRailAgency((data && data.agency) || this.gpsGapAgency);
    const tags = {
      suspect: ['recurrent', this.t(isRail ? 'dades.gpsTrainTagSuspect' : 'dades.gpsBusTagSuspect')],
      watch: ['', this.t('dades.gpsBusTagWatch')],
      normal: ['calm', this.t('dades.gpsBusTagNormal')],
      few: ['calm', this.t('dades.gpsBusTagFew')]
    };
    list.innerHTML = buses.slice(0, 10).map(b => {
      const [cls, label] = tags[b.verdict] || tags.few;
      const lossWord = this.t(b.gaps === 1 ? 'dades.gpsLossOne' : 'dades.gpsLossMany');
      const facts = [
        `<strong>${b.gaps}</strong> ${this.esc(lossWord)}${b.visits ? this.esc(this.t('dades.gpsBusInStops', { visits: b.visits, per100: this.dec(b.per100) })) : ''}`,
        b.ratio !== null ? this.t('dades.gpsBusRatio', { ratio: this.esc(this.dec(b.ratio)) }) : '',
        this.esc(this.t(isRail ? 'dades.gpsTrainShared' : 'dades.gpsBusShared', { pct: b.sharedPct }))
      ].filter(Boolean).join(' · ');
      const on = this.gpsGapVehicle === b.vehicleId;
      const off = (data.hidden || []).includes(b.vehicleId);
      return `<li><button type="button" class="gps-bus-row${on ? ' active' : ''}${off ? ' is-hidden' : ''}" data-gps-bus="${this.esc(b.vehicleId)}" aria-pressed="${on}"${off ? ` title="${this.esc(this.t('dades.gpsBusHiddenTitle'))}"` : ''}>
        <span class="gps-bus-id">${this.esc(b.vehicleId)}</span>
        <span class="gps-bus-head">${b.lines.map(code => this.lineChip(code)).join('')}<span class="gps-gaps-popup-tag${cls ? ` ${cls}` : ''}">${this.esc(label)}</span></span>
        <span class="gps-bus-facts">${facts}</span>
      </button></li>`;
    }).join('');
    const fleet = (data && data.fleet) || {};
    if (foot) {
      foot.textContent = this.t(isRail ? 'dades.gpsTrainFoot' : 'dades.gpsBusFoot', { inService: fleet.inService || 0, withoutLoss: fleet.withoutLoss || 0 });
    }
  }

  fmtGapDuration(sec) {
    if (!Number.isFinite(sec)) return '--';
    if (sec < 60) return `${sec} s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s ? `${m} min ${s} s` : `${m} min`;
  }

  /**
   * The minimum-losses slider runs from 1 to the busiest point of the loaded
   * answer, so its range follows the period, line and bus filters. A choice
   * above the new maximum is lowered to it; hidden while no point repeats.
   */
  syncGpsGapMin(cells) {
    const group = document.getElementById('gps-gaps-min-group');
    const input = document.getElementById('gps-gaps-min');
    const out = document.getElementById('gps-gaps-min-value');
    const max = cells.reduce((m, c) => Math.max(m, c.count || 0), 1);
    this.gpsGapMin = Math.min(Math.max(1, this.gpsGapMin || 1), max);
    if (!group || !input) return;
    group.hidden = max < 2;
    input.max = String(max);
    input.value = String(this.gpsGapMin);
    if (out) out.textContent = `${this.gpsGapMin}+`;
    input.setAttribute('aria-valuetext', this.t('dades.gpsMinAria', { n: this.gpsGapMin }));
  }

  renderGpsGaps(data, { fit = true, forceBuses = false } = {}) {
    const summary = document.getElementById('gps-gaps-summary');
    const list = document.getElementById('gps-gaps-list');
    const empty = document.getElementById('gps-gaps-empty');
    const map = this.ensureGpsGapMap();
    if (this.gpsGapLayer) this.gpsGapLayer.clearLayers();
    this.gpsGapMarkers = [];
    this.clearGpsGapSelection();
    this.gpsGapCells = [];
    if (!summary || !list || !empty) return;
    // The slider only refilters: the bus ranking does not depend on it.
    if (forceBuses || data !== this._gpsGapData) this.renderGpsGapBuses(data);
    this._gpsGapData = data;
    this.syncGpsGapControls(data);
    this.syncGpsGapMin(data && Array.isArray(data.cells) ? data.cells : []);

    if (!data) {
      summary.textContent = this.t('dades.gpsLoadError', { kept: '' });
      list.innerHTML = '';
      empty.textContent = this.t('dades.gpsNoDataShort');
      empty.hidden = false;
      return;
    }

    this._gpsGapShown = true;
    const isStopMode = data.signalMode === 'stop';
    const isRail = this.isGpsGapRailAgency((data && data.agency) || this.gpsGapAgency);
    const t = data.totals || {};
    const allCells = Array.isArray(data.cells) ? data.cells : [];
    const min = this.gpsGapMin || 1;
    const cells = min > 1 ? allCells.filter(c => c.count >= min) : allCells;
    const period = data.days === 1 ? this.t('dades.gpsPeriod24h') : this.t('dades.gpsPeriodLastDays', { n: data.days });
    const onLine = data.lineCode ? this.t('dades.gpsOnLine', { line: this.esc(data.lineCode) }) : '';
    const left = [];
    if (t.atTerminal) left.push(this.t('dades.gpsExcludedTerminal', { n: t.atTerminal }));
    if (t.feedWide) left.push(this.t('dades.gpsExcludedFeed', { n: t.feedWide }));
    const leftTxt = left.length ? this.t('dades.gpsExcludedText', { items: left.join(this.t('dades.gpsExcludedJoin')) }) : '';

    // The picked bus, as a chip that shows every bus again.
    const busChip = data.vehicleId
      ? `<button type="button" class="observatori-pill-btn active gps-bus-clear" data-gps-bus-clear aria-label="${this.esc(this.t('dades.gpsShowAllBusesAria'))}">${this.esc(this.t('dades.gpsBusChip', { id: data.vehicleId }))}</button> `
      : '';
    if (!t.mapped) {
      const onLineRaw = data.lineCode ? this.t('dades.gpsOnLine', { line: data.lineCode }) : '';
      summary.innerHTML = busChip + this.esc(this.t(isStopMode ? 'dades.gpsStopEmpty' : 'dades.gpsEmptySummary', { onLine: onLineRaw, period, left: leftTxt }));
      list.innerHTML = '';
      empty.textContent = this.t(isStopMode ? 'dades.gpsStopEmptyMap' : 'dades.gpsEmptyMap');
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    this.gpsGapCells = cells;
    const recurrent = allCells.filter(c => c.recurrent).length;
    // One bus: "recurrent" needs two buses, so say where instead.
    const picked = (data.buses || []).find(b => b.vehicleId === data.vehicleId);
    const busWhere = this.esc(this.t('dades.gpsBusWhere', {
      n: allCells.length,
      spots: this.t(allCells.length === 1 ? 'dades.gpsSpotOne' : 'dades.gpsSpotMany'),
      shared: picked ? this.t('dades.gpsBusWhereShared', { pct: picked.sharedPct }) : ''
    }));
    summary.innerHTML = busChip + (data.vehicleId
      ? this.t('dades.gpsSummaryBus', { mapped: t.mapped, onLine, period: this.esc(period), median: this.esc(this.fmtGapDuration(t.medianGapSec)) })
      : this.t(isStopMode ? 'dades.gpsStopSummaryAll' : (isRail ? 'dades.gpsSummaryAllRail' : 'dades.gpsSummaryAll'), { mapped: t.mapped, onLine, period: this.esc(period), vehicles: t.vehicles, median: this.esc(this.fmtGapDuration(t.medianGapSec)) }))
      + (data.vehicleId ? busWhere : recurrent
        ? this.t('dades.gpsRecurrentShare', { share: t.recurrentShare, n: recurrent, word: this.esc(this.t(recurrent === 1 ? 'dades.gpsRecurrentOne' : 'dades.gpsRecurrentMany')) })
        : this.esc(this.t('dades.gpsNoRecurrent')))
      + this.esc(leftTxt)
      + (min > 1
        ? this.esc(cells.length === 1
          ? this.t('dades.gpsSliderSingle', { min, total: allCells.length })
          : this.t('dades.gpsSliderMany', { shown: cells.length, min, total: allCells.length }))
        : '')
      + ((data.hidden || []).length
        ? this.esc(this.t('dades.gpsHiddenNote', {
          n: data.hidden.length,
          word: this.t(isRail ? (data.hidden.length === 1 ? 'dades.gpsTrainOne' : 'dades.gpsTrainMany') : (data.hidden.length === 1 ? 'dades.gpsBusOne' : 'dades.gpsBusMany')),
          ids: data.hidden.join(', ')
        }))
        : '');

    // The list first: the map column stretches to its height, so the map is
    // sized and fitted after it.
    list.innerHTML = cells.slice(0, 8).map((c, i) => `
      <li>
        <button type="button" class="gps-gaps-item" data-gps-cell="${i}">
          <span class="gps-gaps-rank${c.recurrent ? ' recurrent' : ''}">${i + 1}</span>
          <span class="gps-gaps-item-main">
            <strong>${c.stopName ? this.esc(this.t('dades.gpsNearStop', { stop: c.stopName })) : this.esc(this.t('dades.gpsListNoNearStop'))}</strong>
            <span>${c.lines.map(code => this.lineChip(code)).join(' ')} ${c.vehicles} ${this.esc(this.t(isStopMode ? (c.vehicles === 1 ? 'dades.gpsStopTripOne' : 'dades.gpsStopTripMany') : (isRail ? (c.vehicles === 1 ? 'dades.gpsTrainOne' : 'dades.gpsTrainMany') : (c.vehicles === 1 ? 'dades.gpsBusOne' : 'dades.gpsBusMany'))))} · ${this.esc(this.t('dades.gpsListMedian', { val: this.fmtGapDuration(c.medianGapSec) }))}</span>
          </span>
          <span class="gps-gaps-item-count">${c.count}<small>${this.esc(this.t(c.count === 1 ? 'dades.gpsLossOne' : 'dades.gpsLossMany'))}</small></span>
        </button>
      </li>`).join('');

    if (map) {
      // Straight from where the signal went to where it came back: the bus
      // drove the street in between with no GPS (skipped in per-stop mode).
      const shown = new Set(cells.map(c => allCells.indexOf(c)));
      if (!isStopMode) {
        for (const g of (data.gaps || [])) {
          if (min > 1 && !shown.has(g.cell)) continue;
          if (g.lostLat === g.regainedLat && g.lostLon === g.regainedLon) continue;
          L.polyline([[g.lostLat, g.lostLon], [g.regainedLat, g.regainedLon]], {
            color: '#fbbf24', weight: 2.5, opacity: 0.7, dashArray: '4 6', interactive: false
          }).addTo(this.gpsGapLayer);
        }
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
      if (fit && cells.length) map.fitBounds(cells.map(c => [c.lat, c.lon]), { padding: [30, 30], maxZoom: 16 });
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
    this._lastDataHealth = data;
    if (document.body.dataset.dadesScope === 'est') {
      this.renderMovHealth(this.moventisData);
      return;
    }
    const railOp = this.railOpInScope();
    if (railOp) {
      this.renderRailHealth(railOp);
      return;
    }
    const grid = document.getElementById('data-health-grid');
    if (!grid) return;
    const timeEl = document.getElementById('data-health-timestamp');
    if (timeEl) {
      timeEl.textContent = new Date().toLocaleTimeString(this.locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
    const noData = this.t('dades.dhNoData');

    // 1. Canari SIRI (upstreamCanary)
    const canaryTitle = this.t('dades.dhCanaryTitle');
    if (!data || data.upstreamCanary === null || data.upstreamCanary === undefined) {
      items.push(makeItem(canaryTitle, 'status-neutral', noData, this.esc(this.t('dades.dhCanaryNoData'))));
    } else if (data.upstreamCanary.ok === true) {
      const ageStr = data.upstreamCanary.checkedAt ? this.t('dades.dhAgoSec', { n: Math.round(Math.max(0, Date.now() - data.upstreamCanary.checkedAt) / 1000) }) : this.t('dades.dhRecently');
      items.push(makeItem(canaryTitle, 'status-success', this.t('dades.dhCanaryOk'), this.esc(this.t('dades.dhCanaryOkDesc', { age: ageStr }))));
    } else {
      items.push(makeItem(canaryTitle, 'status-danger', this.t('dades.dhCanaryFail'), this.esc(this.t('dades.dhCanaryFailDesc', { err: data.upstreamCanary.error || this.t('dades.dhNoResponse') }))));
    }

    // 2. Connexió operador (lastError)
    const connTitle = this.t('dades.dhConnTitle');
    const ERROR_TEXT = {
      malformed: this.t('dades.dhErrMalformed'),
      auth: this.t('dades.dhErrAuth'),
      soap_fault: this.t('dades.dhErrSoap'),
      upstream_error: this.t('dades.dhErrUpstream'),
      network_error: this.t('dades.dhErrNetwork'),
      timeout: this.t('dades.dhErrTimeout')
    };
    const describeError = (code) => ERROR_TEXT[code] || (/^http_\d+$/.test(String(code)) ? this.t('dades.dhErrHttp', { code: String(code).slice(5) }) : String(code));
    if (!data || !data.upstreamKnown) {
      items.push(makeItem(connTitle, 'status-neutral', noData, this.esc(this.t('dades.dhConnNoData'))));
    } else if (data.lastError === null || data.lastError === undefined) {
      items.push(makeItem(connTitle, 'status-success', this.t('dades.dhConnOk'), this.esc(this.t('dades.dhConnOkDesc'))));
    } else {
      const ageMin = data.lastErrorAt ? Math.max(1, Math.round((Date.now() - data.lastErrorAt) / 60000)) : null;
      const when = ageMin === null ? '' : this.t('dades.dhAgoMinPrefix', { n: ageMin });
      const what = describeError(data.lastError);
      if (data.circuitOpen) {
        items.push(makeItem(connTitle, 'status-danger', this.t('dades.dhConnCircuitBadge'), this.esc(this.t('dades.dhConnCircuitDesc', { when, what }))));
      } else if (ageMin !== null && ageMin >= 10) {
        items.push(makeItem(connTitle, 'status-neutral', this.t('dades.dhConnRecoveredBadge'), this.esc(this.t('dades.dhConnRecoveredDesc', { when, what }))));
      } else {
        items.push(makeItem(connTitle, 'status-warning', this.t('dades.dhConnRecentBadge'), this.esc(this.t('dades.dhConnRecentDesc', { when, what }))));
      }
    }

    // 3. Anomalia de flota (fleetAnomaly)
    const anomTitle = this.t('dades.dhAnomalyTitle');
    if (!data || data.fleetAnomaly === null || data.fleetAnomaly === undefined) {
      items.push(makeItem(anomTitle, 'status-neutral', noData, this.esc(this.t('dades.dhAnomalyNoData'))));
    } else if (data.fleetAnomaly.detected === true) {
      items.push(makeItem(anomTitle, 'status-warning', this.t('dades.dhAnomalyBadge'), this.esc(data.fleetAnomaly.message || this.t('dades.dhAnomalyDefault'))));
    } else {
      items.push(makeItem(anomTitle, 'status-success', this.t('dades.dhNormalBadge'), this.esc(this.t('dades.dhAnomalyOkDesc'))));
    }

    // 4. Flota en servei (fleet): its own full-width row with one chip per line.
    const fleetTitle = this.t('dades.dhFleetTitle');
    if (!data || data.fleet === null || data.fleet === undefined) {
      const empty = makeItem(fleetTitle, 'status-neutral', noData, this.esc(this.t('dades.dhFleetNoData')));
      items.push({ tone: empty.tone, html: '' });
      fleetHtml = `<div class="dh-fleet">${empty.html}</div>`;
    } else {
      const { totalLiveGps = 0, totalEstimated = 0, totalScheduled = 0, complete = true, lines = [] } = data.fleet;
      const totalBuses = Number.isFinite(data.fleet.totalScheduledBuses) ? data.fleet.totalScheduledBuses : totalScheduled;
      const isOk = totalBuses > 0 && totalLiveGps >= Math.ceil(totalBuses * 0.7);
      const badgeClass = totalBuses > 0 ? (isOk ? 'status-success' : 'status-warning') : 'status-neutral';
      const badgeText = this.t('dades.dhFleetBadge', { gps: totalLiveGps, est: totalEstimated });
      const REASON = {
        terminal_ghost: this.t('dades.dhReasonTerminal'),
        line_cap: this.t('dades.dhReasonLineCap'),
        direction_allowance: this.t('dades.dhReasonDirAllow'),
        colocated: this.t('dades.dhReasonColocated'),
        no_position: this.t('dades.dhReasonNoPos')
      };
      const chips = lines.map(l => {
        const colour = this.getLineColor(l.lineCode);
        const code = `<span class="dh-line-code" style="background:${colour}; color:${this.chipInk(colour)};">${this.esc(l.lineCode)}</span>`;
        if (l.available === false) return `<div class="dh-line">${code}<span class="dh-line-count">${this.esc(this.t('dades.dhFleetLineNoData'))}</span></div>`;
        const buses = Number.isFinite(l.scheduledBuses) ? l.scheduledBuses : l.scheduledVehicles;
        const shown = l.liveGpsVehicles + (l.estimatedVehicles ?? 0);
        const gap = buses - shown;
        let note = '';
        if (gap > 0) {
          const reasons = Object.entries(l.notDrawn || {})
            .filter(([k, n]) => k !== 'terminal_bus' && n > 0)
            .map(([k, n]) => `${REASON[k] || k}${n > 1 ? ` ×${n}` : ''}`);
          note = `<span class="dh-line-note">${this.esc(this.t('dades.dhFleetNotDrawn', { n: gap }))}${reasons.length ? `: ${this.esc(reasons.join(', '))}` : ''}</span>`;
        }
        return `<div class="dh-line${gap > 0 ? ' has-gap' : ''}">${code}<span class="dh-line-count">${l.liveGpsVehicles}+${l.estimatedVehicles ?? 0}/${buses}</span>${note}</div>`;
      }).join('');
      const note = complete ? '' : this.t('dades.dhFleetIncomplete');
      const fleetItem = makeItem(fleetTitle, badgeClass, badgeText,
        this.esc(this.t('dades.dhFleetDesc', { shown: totalLiveGps + totalEstimated, need: totalBuses, note })));
      items.push({ tone: fleetItem.tone, html: '' });
      fleetHtml = `<div class="dh-fleet">${fleetItem.html}${chips ? `<div class="dh-lines">${chips}</div>` : ''}</div>`;
    }

    // 5. Deriva horària (scheduleDrift)
    const driftTitle = this.t('dades.dhDriftTitle');
    if (!data || data.scheduleDrift === null || data.scheduleDrift === undefined) {
      items.push(makeItem(driftTitle, 'status-neutral', noData, this.esc(this.t('dades.dhDriftNoData'))));
    } else if (data.scheduleDrift.drift === true && data.scheduleDrift.layoutError) {
      items.push(makeItem(driftTitle, 'status-warning', this.t('dades.dhDriftLayoutBadge'), this.esc(this.t('dades.dhDriftLayoutDesc', { err: data.scheduleDrift.layoutError }))));
    } else if (data.scheduleDrift.drift === true) {
      items.push(makeItem(driftTitle, 'status-warning', this.t('dades.dhDriftWarnBadge'), this.esc(this.t('dades.dhDriftWarnDesc', { n: data.scheduleDrift.differencesCount || 1 }))));
    } else {
      items.push(makeItem(driftTitle, 'status-success', this.t('dades.dhDriftOkBadge'), this.esc(this.t('dades.dhDriftOkDesc'))));
    }

    // 6. Temporada de servei (season)
    const seasonTitle = this.t('dades.dhSeasonTitle');
    if (!data || data.season === null || data.season === undefined) {
      items.push(makeItem(seasonTitle, 'status-neutral', noData, this.esc(this.t('dades.dhSeasonNoData'))));
    } else if (data.season.seasonKnown) {
      const label = data.season.season === 'summer' ? this.t('dades.dhSeasonSummer') : this.t('dades.dhSeasonWinter');
      const src = String(data.season.seasonSource || '');
      const localizedSrc = src === 'calendar' ? this.t('dades.dhSeasonSourceCalendar') : src;
      const srcText = src.startsWith('default')
        ? this.t('dades.dhSeasonDefaultWinter')
        : (src.startsWith('notice')
          ? this.t('dades.dhSeasonNotice', { src: src.replace(/^notice\s*/, '') })
          : this.t('dades.dhSeasonConfig', { src: localizedSrc || this.t('dades.dhSeasonConfigFallback') }));
      items.push(makeItem(seasonTitle, 'status-success', label, this.esc(srcText)));
    } else {
      items.push(makeItem(seasonTitle, 'status-warning', this.t('dades.dhSeasonUnverifiedBadge'), this.esc(this.t('dades.dhSeasonUnverifiedDesc', { season: data.season.season }))));
    }

    // 7. Previsió de temporada (seasonOutlook)
    const outlookTitle = this.t('dades.dhOutlookTitle');
    if (!data || data.seasonOutlook === null || data.seasonOutlook === undefined) {
      items.push(makeItem(outlookTitle, 'status-neutral', noData, this.esc(this.t('dades.dhOutlookNoData'))));
    } else if (!data.seasonOutlook.warning) {
      items.push(makeItem(outlookTitle, 'status-success', this.t('dades.dhOutlookOkBadge'), this.esc(this.t('dades.dhOutlookOkDesc'))));
    } else {
      items.push(makeItem(outlookTitle, 'status-warning', this.t('dades.dhAttentionBadge'), this.esc(data.seasonOutlook.warning)));
    }

    // 8. Festius oficials (holidaysKnownForYear)
    const holTitle = this.t('dades.dhHolidaysTitle');
    if (!data || data.holidaysKnownForYear === null || data.holidaysKnownForYear === undefined) {
      items.push(makeItem(holTitle, 'status-neutral', noData, this.esc(this.t('dades.dhHolidaysNoData'))));
    } else if (data.holidaysKnownForYear === true) {
      if (data.holidayCoverage && data.holidayCoverage.warning) {
        items.push(makeItem(holTitle, 'status-warning', this.t('dades.dhAttentionBadge'), this.esc(data.holidayCoverage.warning)));
      } else {
        items.push(makeItem(holTitle, 'status-success', this.t('dades.dhVerifiedBadge'), this.esc(this.t('dades.dhHolidaysOkDesc'))));
      }
    } else {
      const warn = (data.holidayCoverage && data.holidayCoverage.warning) || this.t('dades.dhHolidaysIncompleteDefault');
      items.push(makeItem(holTitle, 'status-warning', this.t('dades.dhIncompleteBadge'), this.esc(warn + this.t('dades.dhHolidaysIncompleteSuffix'))));
    }

    // 9. Frescor dels informes (reportFreshness)
    const freshTitle = this.t('dades.dhFreshTitle');
    if (!data || data.reportFreshness === null || data.reportFreshness === undefined || !Array.isArray(data.reportFreshness)) {
      items.push(makeItem(freshTitle, 'status-neutral', noData, this.esc(this.t('dades.dhFreshNoData'))));
    } else if (data.reportFreshness.length > 0 && data.reportFreshness.every(r => r.fresh)) {
      items.push(makeItem(freshTitle, 'status-success', this.t('dades.dhFreshOkBadge'), this.esc(this.t('dades.dhFreshOkDesc'))));
    } else {
      items.push(makeItem(freshTitle, 'status-warning', this.t('dades.dhFreshWarnBadge'), this.esc(this.t('dades.dhFreshWarnDesc'))));
    }

    // Summary line: the one thing to read first.
    const count = tone => items.filter(i => i.tone === tone).length;
    const problems = count('warn') + count('bad');
    const unknown = count('none');
    const summaryTone = count('bad') ? 'bad' : (problems ? 'warn' : (unknown === items.length ? 'none' : 'ok'));
    const summaryText = summaryTone === 'none'
      ? this.t('dades.dhSummaryNone')
      : problems
        ? this.t(problems === 1 ? 'dades.dhSummaryWarnOne' : 'dades.dhSummaryWarnMany', { n: problems })
        : this.t('dades.dhSummaryOk');
    const unknownText = unknown && summaryTone !== 'none' ? this.t('dades.dhSummaryUnknown', { n: unknown }) : '';
    grid.innerHTML = `
      <p class="dh-summary dh-${summaryTone}"><span class="dh-dot" aria-hidden="true"></span>${this.esc(summaryText + unknownText)}</p>
      <div class="dh-list">${items.map(i => i.html).join('')}</div>
      ${fleetHtml}`;
  }

  onLangChange() {
    this.renderLineFilter();
    if (this._lastDataHealth !== undefined) {
      this.renderDataHealth(this._lastDataHealth);
    }
    if (this._gpsGapData !== undefined) {
      const sel = this.gpsGapSelected;
      this.renderGpsGaps(this._gpsGapData, { fit: false, forceBuses: true });
      if (sel !== null && sel !== undefined) this.selectGpsGapCell(sel);
    }
    if (this.currentTab === 'journalism') {
      if (this.currentReport) {
        const modalState = this._activeModal ? { ...this._activeModal } : null;
        this.renderJournalismReport(this.currentReport);
        if (modalState) {
          if (modalState.type === 'stop') this.openStopHourlyDrilldown(modalState.stopIdx, modalState.hour);
          else if (modalState.type === 'hour') this.openHourSummaryDrilldown(modalState.hour);
        }
      } else if (this._journalismStatus) {
        const contentContainer = document.getElementById('journalism-content-container');
        if (this._journalismStatus.type === 'empty') {
          this._setStatusMessage(contentContainer, this.t('dades.noReportData'));
        } else if (this._journalismStatus.type === 'error') {
          this._setStatusMessage(contentContainer, this.t('dades.reportLoadError', { err: this._journalismStatus.err }), true);
        }
      }
    } else if (this.currentTab === 'termometre') {
      if (this.termometreData) this.renderTermometreScorecard(this.termometreData);
    } else if (this.currentTab === 'incidents') {
      if (this.lastIncidentData) {
        this.renderDelayIncidentsView(this.lastIncidentData, this._currentIncidentLine || 'all', this._currentIncidentHours || 168, this._currentIncidentMode || 'top');
        if (this._lastIncidentInspect) {
          this._renderIncidentDrilldown(this._lastIncidentInspect.data, this._lastIncidentInspect.lineCode, this._lastIncidentInspect.stopName, false);
        }
      }
    } else if (this.currentTab === 'monthly') {
      if (this._monthlyData) this.renderMonthlyReport(this._monthlyData);
    }
  }

  bindEvents() {
    document.addEventListener('arribo:lang', () => this.onLangChange());
    // The Moventis scope follows the scraper's state (every minute while shown).
    setInterval(async () => {
      if (document.hidden || document.body.dataset.dadesScope !== 'est') return;
      const h = this.currentHours || 24;
      const m = await fetch(`/api/moventis?hours=${encodeURIComponent(h)}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
      if (!m || document.body.dataset.dadesScope !== 'est') return;
      this.moventisData = m;
      this.renderMovHealth(m);
      if (this.currentTab === 'journalism') {
        if (this.currentReport) {
          this.renderJournalismReport(this.currentReport);
        } else {
          const container = document.getElementById('journalism-content-container');
          if (container) this.renderMoventisScope(container, m);
        }
      }
    }, 60000);
    document.addEventListener('arribo:scope', () => this.onScopeChange());

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
        document.querySelectorAll('#journalism-timeframe-tabs button').forEach(b => {
          const on = b === btn;
          b.classList.toggle('active', on);
          b.classList.toggle('is-active', on);
          b.setAttribute('aria-selected', on ? 'true' : 'false');
        });

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

    // Line pills (exact line filter, alongside the text search)
    document.getElementById('journalism-line-filter')?.addEventListener('click', (e) => {
      const pill = e.target.closest('[data-line-code]');
      if (!pill) return;
      this.lineCode = pill.getAttribute('data-line-code') || '';
      this.updateUrl();
      this.renderLineFilter();
      if (this.currentReport && this.currentTab === 'journalism') {
        this.renderJournalismReport(this.currentReport);
      }
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

      // Copy the edge-case debug table as tab-separated text
      const copyEdgeBtn = e.target.closest('#btn-copy-edge-cases');
      if (copyEdgeBtn) {
        e.preventDefault();
        this.copyEdgeCases();
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

  _setStatusMessage(el, msg, isError = false) {
    if (!el) return;
    el.innerHTML = `<div style="text-align:center; padding:3rem; color:${isError ? 'var(--danger)' : 'var(--text-muted)'};">${this.esc(msg)}</div>`;
  }

  async loadJournalismReport(hours = 24, force = false) {
    this.currentHours = hours;
    document.dispatchEvent(new CustomEvent('arribo:dades-hours', { detail: { hours } }));
    const contentContainer = document.getElementById('journalism-content-container');
    const termometreContainer = document.getElementById('journalism-termometre-container');
    const incidentsContainer = document.getElementById('journalism-incidents-container');
    const searchBarWrap = document.getElementById('journalism-search-bar-wrap');

    if (searchBarWrap) searchBarWrap.style.display = 'block';
    this.renderLineFilter();
    this.showGpsGaps(true);
    this.setGpsGapPeriod(hours);
    if (contentContainer) contentContainer.style.display = 'block';
    if (termometreContainer) termometreContainer.style.display = 'none';
    if (incidentsContainer) incidentsContainer.style.display = 'none';
    const monthlyContainer = document.getElementById('journalism-monthly-container');
    if (monthlyContainer) monthlyContainer.style.display = 'none';

    if (!this.currentReport || force) {
      if (contentContainer) {
        contentContainer.innerHTML = `<div style="text-align:center; padding:3rem; color:var(--text-muted);"><span class="loading-spinner-inline"></span> ${this.esc(this.t('dades.loadingServerReport'))}</div>`;
      }
    }

    try {
      const [res, net] = await Promise.allSettled([
        fetch(`/api/analytics/journalism?hours=${hours}`).then(r => r.json()),
        // The trains' figures in the same shapes (networkreport.go); optional.
        fetch(`/api/analytics/network?hours=${hours}`).then(r => (r.ok ? r.json() : null))
      ]);
      this.networkReport = net.status === 'fulfilled' && net.value?.success ? net.value : null;
      // Moventis (scraped predictions, estimated buses + timetable-matched delays): its Dades scope.
      this.moventisData = await fetch(`/api/moventis?hours=${encodeURIComponent(hours)}`).then(r => (r.ok ? r.json() : null)).catch(() => null);

      const journalismData = res.status === 'fulfilled' && res.value?.success ? (res.value.report || res.value) : null;

      if (journalismData) {
        this._journalismStatus = null;
        this.currentReport = journalismData;
        this.renderJournalismReport(journalismData);
      } else {
        this._journalismStatus = { type: 'empty' };
        this.clearOperatorComparison();
        this._setStatusMessage(contentContainer, this.t('dades.noReportData'));
      }
    } catch (err) {
      this._journalismStatus = { type: 'error', err: err.message };
      this.clearOperatorComparison();
      this._setStatusMessage(contentContainer, this.t('dades.reportLoadError', { err: err.message }), true);
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

  // The other operators to list beside Mataró: only with the network scope
  // "Tot" (operators.js sets body[data-dades-scope]) and with observations.
  networkOpsInScope() {
    if (document.body.dataset.dadesScope !== 'all') return [];
    const ops = (this.networkReport?.operators || []).filter(o => (o.agencyStats?.totalVisits || 0) > 0);
    if (this.moventisData?.delays?.summary?.observations > 0) {
      const movRep = this.moventisReportFor(this.moventisData);
      ops.push({
        ...movRep.railOp,
        agencyStats: movRep.agencyStats[0],
        rankingMostDelayed: movRep.rankingMostDelayed,
        allStopDelays: movRep.allStopDelays
      });
    }
    return ops;
  }

  // A train operator's delay by hour of the day, in the hourly chart's
  // component (.hourly-chart-*), coloured by its own rule: up to 2 min,
  // up to its on-time bound, beyond. Heights are set after rendering
  // (data-bar-h), so no inline styles.
  renderRailHourly(op, inner = false) {
    const rows = (op.hourlyDelays || []).filter(h => h.visitCount > 0);
    if (!rows.length) return '';
    const byHour = new Map(rows.map(h => [Number(h.hour), h]));
    const max = Math.max(2, ...rows.map(h => Math.abs(Number(h.avgDelay) || 0)));
    const on = op.onTimeMaxMins || 5;
    // The hours trains are scheduled in this period (from the operator's
    // timetable) and any hour with data; a scheduled hour without data is
    // a "—" gap, an hour with nothing scheduled is left out. In service-day
    // order: from 04 h, after-midnight trains last.
    const scheduled = Array.isArray(op.scheduledHours) ? op.scheduledHours.map(Number) : null;
    const shown = scheduled
      ? [...new Set([...scheduled, ...byHour.keys()])]
      : (() => { const hs = [...byHour.keys()]; const a = Math.min(...hs); const b = Math.max(...hs); return Array.from({ length: b - a + 1 }, (_, i) => a + i); })();
    const serviceOrder = hr => (hr + 20) % 24; // 04 h first
    shown.sort((a, b) => serviceOrder(a) - serviceOrder(b));
    const cols = [];
    for (const hr of shown) {
      const h = byHour.get(hr);
      const label = `${String(hr).padStart(2, '0')}h`;
      if (!h) {
        cols.push(`<div class="hourly-bar-col" title="${this.esc(this.t('ops.hourNoData', { hour: hr }))}"><div class="hourly-bar-track"><span class="hourly-bar-val">—</span><div class="hourly-bar-fill op-fill-none" data-bar-h="4"></div></div><span class="hourly-bar-label">${label}</span></div>`);
        continue;
      }
      const d = Number(h.avgDelay) || 0;
      const tone = d > on ? 'bad' : d > 2 ? 'mid' : 'good';
      const tip = this.t('dades.railHourTip', { win: h.timeWindow, d, pct: h.latePercentage ?? 0, n: h.visitCount });
      cols.push(`<div class="hourly-bar-col" title="${this.esc(tip)}"><div class="hourly-bar-track"><span class="hourly-bar-val">${d > 0 ? '+' : ''}${d}m</span><div class="hourly-bar-fill op-fill-${tone}" data-bar-h="${Math.round(Math.max(6, (Math.abs(d) / max) * 100))}"></div></div><span class="hourly-bar-label">${label}</span></div>`);
    }
    const legend = [['good', this.t('ops.hourBandGood')], ['mid', this.t('ops.hourBandMid', { max: on })], ['bad', this.t('ops.hourBandBad', { max: on })]]
      .map(([tone, text]) => `<div class="hourly-legend-item"><span class="hourly-legend-dot op-fill-${tone}" aria-hidden="true"></span><span>${this.esc(text)}</span></div>`).join('');
    const title = inner ? this.t('dades.hourlyTitle') : this.t('dades.hourlyTitleOp', { op: op.shortName || op.agency });
    const body = `<div class="hourly-chart-header"><h4 class="hourly-chart-title"><span>${this.esc(title)}</span></h4><div class="hourly-chart-legend">${legend}</div></div>
      <div class="hourly-chart-container op-chart" role="img" aria-label="${this.esc(title)}">${cols.join('')}</div>`;
    return inner ? body : `<div class="hourly-delays-section dades-rail-hourly">${body}</div>`;
  }

  // The train operator the network scope names (Rodalies, FGC), with its
  // figures from /api/analytics/network; null for "Tot" and "Mataró Bus".
  railOpInScope() {
    if (document.body.dataset.dadesScope !== 'rail') return null;
    let id = '';
    try { id = new URLSearchParams(window.location.search).get('xarxa') || ''; } catch { /* none */ }
    return (this.networkReport?.operators || []).find(o => o.agencyId === id) || null;
  }

  // A train operator's figures in the shape of Mataró's report, so the page
  // draws every operator with the same blocks. Peak hours: the three hours
  // with most average delay among those with a real share of the visits,
  // with their worst stations from the per-hour cells.
  railReportFor(op) {
    const st = op.agencyStats || {};
    const stops = op.allStopDelays || [];
    const hourly = op.hourlyDelays || [];
    const total = hourly.reduce((n, h) => n + (h.visitCount || 0), 0);
    const minVisits = Math.max(20, total * 0.02);
    const peakHours = hourly
      .filter(h => h.visitCount >= minVisits && h.avgDelay !== null && h.avgDelay !== undefined)
      .sort((a, b) => b.avgDelay - a.avgDelay)
      .slice(0, 3)
      .map(h => ({
        ...h,
        sampleCount: h.visitCount,
        latePercentage: h.latePercentage ?? 0,
        severeFrom: op.onTimeMaxMins || 5,
        worstStopsDuringHour: stops
          .map(x => ({ x, c: (x.hourly || [])[Number(h.hour)] }))
          .filter(e => e.c && e.c.sampleCount >= 2 && e.c.avgDelay !== null)
          .sort((a, b) => b.c.avgDelay - a.c.avgDelay)
          .slice(0, 3)
          .map(e => ({ stopName: e.x.stopName, lineCode: e.x.lineCode, agencyId: op.agencyId, avgDelay: e.c.avgDelay, arrivalCount: e.c.sampleCount }))
      }));
    return {
      isRail: true,
      railOp: op,
      summary: {
        totalRecordedArrivals: st.totalVisits || 0,
        totalStopVisits: st.totalVisits || 0,
        monitoredLinesCount: st.linesCount || 0,
        hoursAnalyzed: this.currentHours,
        networkPunctualityPct: st.onTimePct,
        earlyPct: st.earlyPct,
        latePct: st.latePct,
        networkAvgDelay: st.avgDelay,
        networkMaxDelay: st.maxDelay
      },
      hourlyDelays: [],
      peakHours,
      rankingMostDelayed: op.rankingMostDelayed || [],
      allStopDelays: stops,
      rankingWorstStops: stops.filter(x => x.isBottleneck),
      agencyStats: [{ ...st, onTimeMaxMins: op.onTimeMaxMins, tier: op.tier }]
    };
  }

  // The operator header above the toolbar: Mataró Bus, or the train
  // operator the scope names (name, data tier, method).
  updateScopeHeader(op) {
    const name = document.getElementById('mataro-bus-title');
    const head = document.getElementById('mataro-bus-tier-header');
    if (!name || !head) return;
    const chip = head.querySelector('[data-tier]');
    const method = head.querySelector('.op-method');
    const tier = op ? (op.tier || 'measured') : 'measured';
    const methodKey = op ? `tier.method.${op.method}` : 'tier.method.gps';
    name.textContent = op ? op.agency : 'Mataró Bus';
    if (chip) {
      chip.dataset.tier = tier;
      chip.classList.remove('chip-live', 'chip-estimated', 'chip-scheduled');
      chip.classList.add(tier === 'predicted' ? 'chip-estimated' : (tier === 'timetable' ? 'chip-scheduled' : 'chip-live'));
      chip.setAttribute('data-i18n', `tier.${tier}`);
      chip.textContent = this.t(`tier.${tier}`);
    }
    if (method) {
      method.dataset.method = op ? op.method : 'gps';
      method.setAttribute('data-i18n', methodKey);
      method.textContent = this.t(methodKey);
    }
  }

  // The data-status panel for Moventis: the scraper's own checks.
  renderMovHealth(m) {
    const grid = document.getElementById('data-health-grid');
    if (!grid) return;
    const timeEl = document.getElementById('data-health-timestamp');
    if (timeEl) timeEl.textContent = new Date().toLocaleTimeString(this.locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const TONE = { 'status-success': 'ok', 'status-warning': 'warn', 'status-danger': 'bad', 'status-neutral': 'none' };
    const item = (title, badgeClass, badge, desc) => ({
      tone: TONE[badgeClass],
      html: `<div class="data-health-item dh-${TONE[badgeClass]}"><div class="data-health-header"><span class="data-health-title"><span class="dh-dot" aria-hidden="true"></span><span>${this.esc(title)}</span></span><span class="data-health-badge ${badgeClass}">${this.esc(badge)}</span></div><p class="data-health-desc">${this.esc(desc)}</p></div>`
    });
    const items = [];
    if (!m || !m.enabled) {
      items.push(item(this.t('dades.mhConnTitle'), 'status-neutral', this.t('dades.rhFeedOff'), this.t('dades.mhOffDesc')));
    } else {
      const st = m.status || {};
      const age = st.lastOkAt ? Math.round((Date.now() - st.lastOkAt) / 1000) : null;
      items.push(age === null
        ? item(this.t('dades.mhConnTitle'), 'status-neutral', this.t('dades.dhNoData'), this.t('dades.mhConnNone'))
        : (st.lastError && age > 300
          ? item(this.t('dades.mhConnTitle'), 'status-danger', this.t('dades.rhFeedErr'), this.t('dades.mhConnErr', { err: st.lastError }))
          : item(this.t('dades.mhConnTitle'), age <= 300 ? 'status-success' : 'status-warning', age <= 300 ? this.t('dades.rhFeedOk') : this.t('dades.rhFreshLate'), this.t('dades.mhConnDesc', { n: age }))));
      const backoff = Number(st.backoffSec) || 0;
      items.push(backoff > 0
        ? item(this.t('dades.mhLimitTitle'), 'status-warning', this.t('dades.mhLimitWait'), this.t('dades.mhLimitWaitDesc', { n: backoff, t: st.throttled || 0 }))
        : item(this.t('dades.mhLimitTitle'), 'status-success', this.t('dades.mhLimitOk'), this.t('dades.mhLimitOkDesc', { gap: st.requestGapSec || 11, t: st.throttled || 0 })));
      const stops = Number(st.sampledStops) || 0;
      const cycleMin = Math.max(1, Math.round(((st.lastCycleSec || stops * (st.requestGapSec || 11)) / 60)));
      items.push(stops > 0
        ? item(this.t('dades.mhStopsTitle'), 'status-success', String(stops), this.t('dades.mhStopsDesc', { min: cycleMin }))
        : item(this.t('dades.mhStopsTitle'), 'status-neutral', this.t('dades.dhNoData'), this.t('dades.mhLoading')));
      const lines = m.lines || [];
      const missing = lines.filter(l => !(l.routes || []).length);
      items.push(!lines.length
        ? item(this.t('dades.mhRoutesTitle'), 'status-neutral', this.t('dades.dhNoData'), this.t('dades.mhLoading'))
        : missing.length
        ? item(this.t('dades.mhRoutesTitle'), 'status-warning', `${lines.length - missing.length}/${lines.length}`, this.t('dades.mhRoutesMissing', { lines: missing.map(l => l.code).join(', ') }))
        : item(this.t('dades.mhRoutesTitle'), 'status-success', `${lines.length}/${lines.length}`, this.t('dades.mhRoutesOk')));
      const n = (m.vehicles || []).length;
      items.push(item(this.t('dades.mhBusesTitle'), n > 0 ? 'status-success' : 'status-neutral', String(n), this.t(n > 0 ? 'dades.mhBusesDesc' : 'dades.mhBusesNone')));
      items.push(item(this.t('dades.rhTierTitle'), 'status-neutral', this.t('tier.predicted'), this.t('tier.method.stop_predictions')));
    }
    const problems = items.filter(i => i.tone === 'warn' || i.tone === 'bad').length;
    const tone = items.some(i => i.tone === 'bad') ? 'bad' : (problems ? 'warn' : 'ok');
    const summary = problems ? this.t(problems === 1 ? 'dades.dhSummaryWarnOne' : 'dades.dhSummaryWarnMany', { n: problems }) : this.t('dades.dhSummaryOk');
    grid.innerHTML = `<p class="dh-summary dh-${tone}"><span class="dh-dot" aria-hidden="true"></span>${this.esc(summary)}</p><div class="dh-list${items.length % 3 === 0 ? ' dh-cols-3' : ''}">${items.map(i => i.html).join('')}</div>`;
  }

  // Moventis figures (/api/moventis?hours=H) shaped like Mataró's & Rodalies's
  // report so /dades?xarxa=moventis renders the same full dashboard: KPIs,
  // hourly bar chart, top peak congestion hours, sortable line ranking,
  // bottleneck/all-stops table and 24-hour stop heatmap.
  moventisReportFor(m) {
    const delays = m?.delays || {};
    const sum = delays.summary || {};
    const onMax = Number(sum.onTimeMaxMins) || 3;
    const lineMeta = new Map((m?.lines || []).map(l => [l.code, l]));
    const byHourRaw = new Map((delays.byHour || []).map(h => [Number(h.hour), h]));
    const hourlyDelays = Array.from({ length: 24 }, (_, hr) => {
      const hh = String(hr).padStart(2, '0');
      const next = String((hr + 1) % 24).padStart(2, '0');
      const r = byHourRaw.get(hr);
      return {
        hour: hh,
        timeWindow: r?.timeWindow || `${hh}:00 - ${next}:00`,
        visitCount: r ? (Number(r.observations) || 0) : 0,
        sampleCount: r ? (Number(r.observations) || 0) : 0,
        avgDelay: r ? Number(r.avgDelayMins) : null,
        maxDelay: r && r.maxDelayMins !== undefined ? Number(r.maxDelayMins) : null,
        onTimePercentage: r && r.onTimePct !== undefined ? Number(r.onTimePct) : null,
        earlyPercentage: r && r.earlyPct !== undefined ? Number(r.earlyPct) : null,
        latePercentage: r && r.latePct !== undefined ? Number(r.latePct) : null,
        severeLatePercentage: r && r.severeLatePct !== undefined ? Number(r.severeLatePct) : null
      };
    });

    const stops = (delays.byStop || []).map(s => ({
      stopId: String(s.stopId || ''),
      stopName: s.stopName || `Parada ${s.stopId}`,
      lineCode: s.lineCode,
      agency: 'Moventis',
      agencyId: 'moventis',
      arrivalCount: Number(s.observations) || 0,
      visitCount: Number(s.observations) || 0,
      sampleCount: Number(s.observations) || 0,
      avgDelay: Number(s.avgDelayMins) || 0,
      maxDelay: Number(s.maxDelayMins) || 0,
      onTimePct: s.onTimePct !== undefined ? Number(s.onTimePct) : null,
      severeLatePct: Number(s.severeLatePct) || 0,
      isBottleneck: Boolean(s.isBottleneck),
      criticalHour: s.criticalHour || '--',
      criticalHourAvgDelay: Number(s.criticalHourAvgDelay) || 0,
      hourly: Array.isArray(s.hourly) ? s.hourly : null
    }));

    const totalHourly = hourlyDelays.reduce((n, h) => n + (h.visitCount || 0), 0);
    const minVisits = Math.max(5, totalHourly * 0.02);
    const peakHours = hourlyDelays
      .filter(h => h.visitCount >= minVisits && h.avgDelay !== null && h.avgDelay !== undefined)
      .sort((a, b) => b.avgDelay - a.avgDelay)
      .slice(0, 3)
      .map(h => ({
        ...h,
        sampleCount: h.visitCount,
        latePercentage: h.latePercentage ?? 0,
        severeFrom: onMax,
        worstStopsDuringHour: stops
          .map(x => ({ x, c: (x.hourly || [])[Number(h.hour)] }))
          .filter(e => e.c && e.c.sampleCount >= 1 && e.c.avgDelay !== null && e.c.avgDelay > 0)
          .sort((a, b) => b.c.avgDelay - a.c.avgDelay)
          .slice(0, 3)
          .map(e => ({ stopName: e.x.stopName, lineCode: e.x.lineCode, agencyId: 'moventis', avgDelay: e.c.avgDelay, arrivalCount: e.c.sampleCount }))
      }));

    const rankingMostDelayed = (delays.byLine || []).map(l => ({
      lineCode: l.lineCode,
      name: l.lineName || lineMeta.get(l.lineCode)?.name || 'Moventis',
      agency: 'Moventis',
      agencyId: 'moventis',
      visitCount: Number(l.observations) || 0,
      sampleCount: Number(l.observations) || 0,
      avgDelay: Number(l.avgDelayMins) || 0,
      maxDelay: Number(l.maxDelayMins) || 0,
      onTimePercentage: Number(l.onTimePct) || 0,
      earlyPercentage: Number(l.earlyPct) || 0,
      latePercentage: Number(l.latePct) || 0
    }));

    const movOp = {
      agencyId: 'moventis',
      agency: 'Moventis',
      shortName: 'Moventis',
      mode: 'bus',
      tier: 'predicted',
      method: 'stop_predictions',
      onTimeMaxMins: onMax,
      hourlyDelays
    };

    const obsCount = Number(sum.observations) || 0;
    const linesCount = Number(sum.linesCount) || rankingMostDelayed.length;
    return {
      isRail: true,
      isMoventis: true,
      railOp: movOp,
      summary: {
        totalRecordedArrivals: obsCount,
        totalStopVisits: obsCount,
        monitoredLinesCount: linesCount,
        hoursAnalyzed: sum.hours || this.currentHours || 24,
        networkPunctualityPct: sum.onTimePct,
        earlyPct: sum.earlyPct ?? 0,
        latePct: sum.latePct ?? 0,
        networkAvgDelay: sum.avgDelayMins,
        networkMaxDelay: sum.maxDelayMins
      },
      hourlyDelays: [],
      peakHours,
      rankingMostDelayed,
      allStopDelays: stops,
      rankingWorstStops: stops.filter(x => x.isBottleneck),
      agencyStats: [{
        agency: 'Moventis',
        agencyId: 'moventis',
        mode: 'bus',
        totalVisits: obsCount,
        totalSamples: obsCount,
        linesCount,
        avgDelay: sum.avgDelayMins,
        maxDelay: sum.maxDelayMins,
        onTimePct: sum.onTimePct,
        earlyPct: sum.earlyPct ?? 0,
        latePct: sum.latePct ?? 0,
        onTimeMaxMins: onMax,
        tier: 'predicted'
      }]
    };
  }

  // Delay distribution bucket bar + 7-day daily punctuality trend + live
  // followed lines table, appended below the core report for Moventis.
  renderMoventisExtras(m) {
    const delays = m?.delays || {};
    const sum = delays.summary || {};
    const onMax = Number(sum.onTimeMaxMins) || 3;
    const b = sum.buckets || {};
    const parts = [
      ['early', Number(b.early) || 0, this.t('ops.bucketEarly')],
      ['ontime', Number(b.onTime) || 0, this.t('ops.bucketOnTime', { max: onMax })],
      ['late', Number(b.late15) || 0, this.t('ops.bucketLate15', { from: onMax + 1 })],
      ['late30', Number(b.late30) || 0, this.t('ops.bucketLate30')],
      ['late60', Number(b.late60) || 0, this.t('ops.bucketLate60')],
      ['severe', Number(b.lateOver60) || 0, this.t('ops.bucketSevere')]
    ];
    const bucketTotal = parts.reduce((n, p) => n + p[1], 0);
    let bucketHtml = '';
    if (bucketTotal > 0) {
      let x = 0;
      const rects = parts.filter(p => p[1] > 0).map(([cls, n, label]) => {
        const w = (n / bucketTotal) * 100;
        const r = `<rect class="op-seg op-seg-${cls}" x="${x.toFixed(3)}%" y="0" width="${w.toFixed(3)}%" height="100%"><title>${this.esc(label)}: ${n}</title></rect>`;
        x += w;
        return r;
      }).join('');
      const pctSuffix = this.lang() === 'en' ? '%' : ' %';
      const legend = parts.map(([cls, n, label]) => `<li><span class="op-dot op-seg-${cls}" aria-hidden="true"></span>${this.esc(label)} <strong>${Math.round((n / bucketTotal) * 100)}${pctSuffix}</strong></li>`).join('');
      bucketHtml = `<svg class="op-bar" role="img" aria-label="${this.esc(this.t('ops.distAria'))}" preserveAspectRatio="none" viewBox="0 0 100 10">${rects}</svg><ul class="op-legend">${legend}</ul>`;
    }

    const daily = Array.isArray(delays.daily) ? delays.daily : [];
    let dailyHtml = '';
    if (daily.length > 0) {
      const todayIso = new Date().toISOString().slice(0, 10);
      const fmtDay = iso => new Date(`${iso}T12:00:00Z`).toLocaleDateString(this.locale(), { day: 'numeric', month: 'short', timeZone: 'UTC' });
      const cols = daily.map(r => {
        const pct = Number(r.onTimePct) || 0;
        const tone = pct >= 85 ? 'good' : pct >= 65 ? 'mid' : 'bad';
        const dt = new Date(`${r.date}T12:00:00Z`);
        const lbl = r.date === todayIso ? this.t('ops.trendToday') : `${dt.getUTCDate()}/${dt.getUTCMonth() + 1}`;
        const avgStr = `${Number(r.avgDelayMins) > 0 ? '+' : ''}${this.dec(Number(r.avgDelayMins || 0).toFixed(1))} min`;
        const tip = this.t('ops.trendTooltip', { day: fmtDay(r.date), pct: `${this.dec(pct.toFixed(1))}%`, avg: avgStr, visits: r.observations });
        return `<div class="hourly-bar-col" title="${this.esc(tip)}"><div class="hourly-bar-track"><span class="hourly-bar-val">${Math.round(pct)}%</span><div class="hourly-bar-fill op-fill-${tone}" data-bar-h="${Math.round(Math.max(6, pct))}"></div></div><span class="hourly-bar-label">${this.esc(lbl)}</span></div>`;
      }).join('');
      const trendTitle = this.t('dades.movDailyTitle', { max: onMax });
      dailyHtml = `<div class="op-trend-block"><div class="hourly-chart-header"><h5 class="hourly-chart-title">${this.esc(trendTitle)}</h5></div><div class="hourly-chart-container op-chart is-trend" role="img" aria-label="${this.esc(trendTitle)}">${cols}</div></div>`;
    }

    const distCard = (bucketHtml || dailyHtml) ? `
      <div class="observatori-table-container dades-mov-section">
        <div class="observatori-table-header-row"><h4 class="observatori-table-title"><span>${this.esc(this.t('dades.movDistTitle'))}</span></h4></div>
        <div class="dades-mov-dist-body">${bucketHtml}${dailyHtml}</div>
      </div>` : '';

    return distCard + this.renderMoventisLinesTableHtml(m);
  }

  renderMoventisLinesTableHtml(m) {
    const lines = m?.lines || [];
    const counts = new Map();
    for (const v of m?.vehicles || []) counts.set(v.lineCode, (counts.get(v.lineCode) || 0) + 1);
    const byLine = new Map();
    for (const r of m?.delays?.byLine || []) byLine.set(r.lineCode, r);
    const fmtSignedMin = v => {
      if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
      const n = Number(v);
      return `${n > 0 ? '+' : ''}${this.dec(n.toFixed(1))} min`;
    };
    const fmtPct = v => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : `${this.dec(Number(v).toFixed(1))}%`);
    const rows = lines.map(l => {
      const routes = l.routes || [];
      const n = counts.get(l.code) || 0;
      const dl = byLine.get(l.code);
      return `<tr><td class="sticky-col"><span class="observatori-line-badge" data-line="${this.esc(`moventis:${l.code}`)}">${this.esc(l.code)}</span> <span class="dades-mov-name">${this.esc(l.name || '')}</span></td>
        <td>${routes.length ? this.esc([...new Set(routes.map(r => r.dest).filter(Boolean))].join(' · ')) : `<span class="dades-mov-muted">${this.esc(this.t('dades.movNoRoutes'))}</span>`}</td>
        <td>${routes.reduce((a, r) => a + (r.stops || 0), 0)}</td>
        <td>${n}</td>
        <td>${dl ? this.esc(fmtSignedMin(dl.avgDelayMins)) : '—'}</td>
        <td>${dl ? this.esc(`${fmtPct(dl.onTimePct)} (${dl.observations})`) : '—'}</td>
        <td>${l.lineRef && routes.length ? `<a class="btn-secondary dades-mov-open" href="/#l${this.esc(l.lineRef)}">${this.esc(this.t('dades.movOpen'))}</a>` : ''}</td></tr>`;
    }).join('');
    return `
      <div class="observatori-table-container dades-mov-section">
        <div class="observatori-table-header-row"><h4 class="observatori-table-title"><span>${this.esc(this.t('dades.movLinesTitle'))}</span></h4></div>
        ${lines.length ? `<div class="observatori-table-wrapper"><table class="observatori-table"><thead><tr>
          <th class="sticky-col">${this.esc(this.t('dades.colLine'))}</th><th>${this.esc(this.t('dades.movColRoutes'))}</th><th>${this.esc(this.t('dades.movColStops'))}</th><th>${this.esc(this.t('dades.movColBuses'))}</th><th>${this.esc(this.t('dades.movColAvgDelay'))}</th><th>${this.esc(this.t('dades.movColOnTime'))}</th><th></th>
        </tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="dades-mov-muted">${this.esc(this.t('dades.movNoLines'))}</p>`}
      </div>`;
  }

  // Fallback warming view while Moventis has 0 delay observations in the period.
  renderMoventisScope(container, m) {
    container.innerHTML = `
      <p class="dades-rail-scope-note">${this.esc(this.t('dades.movScopeNote'))}</p>
      <p class="dades-mov-muted">${this.esc(this.t('dades.movDelayWarming'))}</p>
      ${this.renderMoventisLinesTableHtml(m)}`;
  }

  // The data-status panel for a train operator, from its live feed: the
  // same rows as Mataró's (dot, title, badge, one line), its own checks.
  renderRailHealth(op) {
    const grid = document.getElementById('data-health-grid');
    if (!grid) return;
    const timeEl = document.getElementById('data-health-timestamp');
    if (timeEl) timeEl.textContent = new Date().toLocaleTimeString(this.locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const TONE = { 'status-success': 'ok', 'status-warning': 'warn', 'status-danger': 'bad', 'status-neutral': 'none' };
    const item = (title, badgeClass, badge, desc) => ({
      tone: TONE[badgeClass],
      html: `<div class="data-health-item dh-${TONE[badgeClass]}"><div class="data-health-header"><span class="data-health-title"><span class="dh-dot" aria-hidden="true"></span><span>${this.esc(title)}</span></span><span class="data-health-badge ${badgeClass}">${this.esc(badge)}</span></div><p class="data-health-desc">${this.esc(desc)}</p></div>`
    });
    const f = op.feed;
    const items = [];
    if (!f) {
      items.push(item(this.t('dades.rhFeedTitle'), 'status-neutral', this.t('dades.rhFeedOff'), this.t('dades.rhFeedOffDesc')));
    } else {
      const err = f.vehiclesError || f.tripUpdatesError;
      items.push(err
        ? item(this.t('dades.rhFeedTitle'), 'status-danger', this.t('dades.rhFeedErr'), this.t('dades.rhFeedErrDesc', { err }))
        : item(this.t('dades.rhFeedTitle'), 'status-success', this.t('dades.rhFeedOk'), this.t('dades.rhFeedOkDesc')));
      const age = Number(f.fetchAgeSec);
      const bound = Number(op.staleAfterSec) || 180;
      items.push(Number.isFinite(age)
        ? (age <= bound
          ? item(this.t('dades.rhFreshTitle'), 'status-success', this.t('dades.rhFreshOk'), this.t('dades.rhFreshDesc', { n: age, max: bound }))
          : item(this.t('dades.rhFreshTitle'), 'status-warning', this.t('dades.rhFreshLate'), this.t('dades.rhFreshDesc', { n: age, max: bound })))
        : item(this.t('dades.rhFreshTitle'), 'status-neutral', this.t('dades.dhNoData'), this.t('dades.rhFreshNone')));
      const n = Number(f.vehiclesNow) || 0;
      items.push(n > 0
        ? item(this.t('dades.rhTrainsTitle'), 'status-success', String(n), this.t('dades.rhTrainsDesc', { n }))
        : item(this.t('dades.rhTrainsTitle'), 'status-neutral', '0', this.t('dades.rhTrainsNone')));
      const dropped = Number(f.implausibleDropped) || 0;
      items.push(item(this.t('dades.rhDroppedTitle'), dropped > 0 ? 'status-warning' : 'status-success', String(dropped), this.t('dades.rhDroppedDesc')));
    }
    const cancelled = op.agencyStats?.cancelled;
    if (typeof cancelled === 'number') {
      // Cancellations describe the service, not our data: shown, not counted as a fault.
      items.push(item(this.t('dades.rhCancelTitle'), 'status-neutral', String(cancelled), this.t('dades.rhCancelDesc', { h: this.currentHours })));
    }
    items.push(item(this.t('dades.rhTierTitle'), 'status-success', this.t(`tier.${op.tier || 'measured'}`), this.t(`tier.method.${op.method}`)));
    const problems = items.filter(i => i.tone === 'warn' || i.tone === 'bad').length;
    const tone = items.some(i => i.tone === 'bad') ? 'bad' : (problems ? 'warn' : 'ok');
    const summary = problems ? this.t(problems === 1 ? 'dades.dhSummaryWarnOne' : 'dades.dhSummaryWarnMany', { n: problems }) : this.t('dades.dhSummaryOk');
    grid.innerHTML = `<p class="dh-summary dh-${tone}"><span class="dh-dot" aria-hidden="true"></span>${this.esc(summary)}</p><div class="dh-list${items.length % 3 === 0 ? ' dh-cols-3' : ''}">${items.map(i => i.html).join('')}</div>`;
  }

  clearOperatorComparison() {
    const operators = document.getElementById('journalism-operators-container');
    if (operators) operators.innerHTML = '';
  }

  renderJournalismReport(report) {
    const container = document.getElementById('journalism-content-container');
    if (!container) return;

    if (!report.isRail && document.body.dataset.dadesScope === 'est') {
      this.currentReport = report;
      this.updateScopeHeader({ agency: 'Moventis', tier: 'predicted', method: 'stop_predictions' });
      this.renderMovHealth(this.moventisData);
      this._railHealthShown = true;
      if (this.moventisData?.delays?.summary?.observations > 0) {
        report = this.moventisReportFor(this.moventisData);
      } else {
        this.renderMoventisScope(container, this.moventisData);
        return;
      }
    }
    if (!report.isRail) {
      this.currentReport = report;
      const railOp = this.railOpInScope();
      this.updateScopeHeader(railOp);
      if (railOp) {
        report = this.railReportFor(railOp);
        this.renderRailHealth(railOp);
      } else if (document.body.dataset.dadesScope === 'rail') {
        // A train scope without its figures (the request failed): say so,
        // never show Mataró's report under a train operator's name.
        this._setStatusMessage(container, this.t('dades.railNoData'), true);
        return;
      } else if (this._railHealthShown) {
        if (this._lastDataHealth !== undefined) this.renderDataHealth(this._lastDataHealth);
      }
      this._railHealthShown = !!railOp;
    }
    const loc = this.locale();
    const filterText = (this.filterText || '').trim().toLowerCase();
    const norm = (str) => String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const cleanFilter = norm(filterText);
    // Exact line from the line pills, applied only while the Mataró Bus line selector is active.
    const lineFilter = this.isLineFilterActive() ? (this.lineCode || '').toUpperCase() : '';
    const onLine = x => !lineFilter || String(x?.lineCode || '').toUpperCase() === lineFilter;

    const s = report.summary || {};
    const isAllStopsMode = this.stopFilterMode === 'all';
    // Network scope "Tot": the blocks below list every operator, Mataró's
    // report plus the trains' figures in the same shapes, each row naming
    // its operator (each keeps its own on-time rule).
    const netOps = this.networkOpsInScope();
    const byDelay = (a, b) => (Number(b.avgDelay) || 0) - (Number(a.avgDelay) || 0);
    const railStops = netOps.flatMap(o => o.allStopDelays || []);
    const busAllStops = (report.allStopDelays && report.allStopDelays.length > 0)
      ? report.allStopDelays
      : (report.rankingWorstStops || []);
    const allStopsSource = netOps.length ? [...busAllStops, ...railStops].sort(byDelay) : busAllStops;
    const busBottlenecks = (report.rankingWorstStops && report.rankingWorstStops.length > 0)
      ? report.rankingWorstStops
      : busAllStops.filter(st => st.isBottleneck);
    const bottlenecksSource = netOps.length ? [...busBottlenecks, ...railStops.filter(st => st.isBottleneck)].sort(byDelay) : busBottlenecks;

    // Calculate full matching stops vs bottleneck matching stops for contextual notice
    let matchingAllStops = allStopsSource.filter(st => (st.arrivalCount || 0) > 0);
    if (filterText) {
      matchingAllStops = matchingAllStops.filter(st =>
        (st.stopName && (st.stopName.toLowerCase().includes(filterText) || norm(st.stopName).includes(cleanFilter))) ||
        (st.lineCode && (st.lineCode.toLowerCase().includes(filterText) || norm(st.lineCode).includes(cleanFilter))) ||
        (st.agency && (st.agency.toLowerCase().includes(filterText) || norm(st.agency).includes(cleanFilter)))
      );
    }
    matchingAllStops = matchingAllStops.filter(onLine);
    const matchingTotalCount = matchingAllStops.length;
    const matchingBottleneckCount = matchingAllStops.filter(st => st.isBottleneck).length;
    const matchingPunctualCount = Math.max(0, matchingTotalCount - matchingBottleneckCount);

    const activeStopsSource = isAllStopsMode ? allStopsSource : bottlenecksSource;

    let mostDelayed = [...(report.rankingMostDelayed || []), ...netOps.flatMap(o => (o.rankingMostDelayed || []).map(l => ({ ...l, name: l.name || o.agency })))]
      .filter(l => (l.sampleCount || 0) > 0 || (l.avgDelay || 0) > 0);
    if (netOps.length) mostDelayed.sort(byDelay);
    let worstStops = [...activeStopsSource]
      .filter(st => (st.arrivalCount || 0) > 0)
      .map((st, idx) => ({ ...st, overallRank: idx + 1 }));
    let agencies = [...(report.agencyStats || []).map(a => ({ onTimeMaxMins: 3, tier: 'measured', ...a })),
      ...netOps.map(o => ({ ...o.agencyStats, onTimeMaxMins: o.onTimeMaxMins, tier: o.tier }))]
      .filter(a => (a.totalSamples || 0) > 0);

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
    if (lineFilter) {
      mostDelayed = mostDelayed.filter(onLine);
      worstStops = worstStops.filter(onLine);
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

    const compiledTime = report.meta?.generatedAt
      ? new Date(report.meta.generatedAt).toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' })
      : '';

    let html = `
      ${report.isMoventis ? `<p class="dades-rail-scope-note">${this.esc(this.t('dades.movScopeNote'))}</p>` : (report.isRail ? `<p class="dades-rail-scope-note">${this.esc(this.t('dades.railScopeNote', { op: report.railOp.shortName || report.railOp.agency }))}</p>` : '')}
      <!-- Pre-generated Cache Banner -->
      ${report.meta?.generatedAt ? `
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem; background:rgba(0,148,133,0.08); border:1px solid rgba(0,148,133,0.22); border-radius:10px; padding:0.6rem 0.95rem; margin-bottom:1.25rem; font-size:0.78rem;">
          <div style="display:flex; align-items:center; gap:0.4rem; color:var(--text-primary);">
            <span>⚡</span>
            <span><strong>${this.esc(this.t('dades.cacheTitle'))}</strong>${this.t('dades.cacheDesc', { time: this.esc(compiledTime) })}</span>
          </div>
          <div style="display:flex; align-items:center; gap:0.6rem;">
            <span style="color:var(--brand-primary); font-weight:700; font-size:0.75rem;">${this.esc(this.t('dades.cacheInstant'))}</span>
          </div>
        </div>
      ` : ''}

      <!-- KPI Stats Grid -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:0.85rem; margin-bottom:1.5rem;">
        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:1rem;">
          <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase;">${this.esc(this.t('dades.kpiVisits'))}</div>
          <div style="font-size:1.75rem; font-weight:700; color:var(--brand-primary); margin-top:0.25rem;">${(s.totalRecordedArrivals || 0).toLocaleString(loc)}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${this.esc(this.t('dades.kpiMonitoredLines', { n: s.monitoredLinesCount || 0 }))}${s.hoursAnalyzed ? this.esc(this.t('dades.kpiLastHours', { h: s.hoursAnalyzed })) : ''}${s.totalSamples ? this.esc(this.t('dades.kpiIndivSamples', { n: s.totalSamples.toLocaleString(loc) })) : ''}</div>
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:1rem;">
          <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase;">${this.esc(this.t('dades.kpiPunctuality'))}</div>
          <div style="font-size:1.75rem; font-weight:700; color:${s.networkPunctualityPct === null || s.networkPunctualityPct === undefined ? 'var(--text-muted)' : (s.networkPunctualityPct >= 85 ? 'var(--accent-live)' : 'var(--accent-warning)')}; margin-top:0.25rem;">${s.networkPunctualityPct === null || s.networkPunctualityPct === undefined ? '—' : `${Number(s.networkPunctualityPct).toLocaleString(loc)}%`}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${s.networkPunctualityPct === null || s.networkPunctualityPct === undefined ? this.esc(this.t('dades.kpiNoVisits')) : this.esc(this.t('dades.kpiPunctBreakdown', { onTime: Number(s.networkPunctualityPct).toLocaleString(loc), early: Number(s.earlyPct || 0).toLocaleString(loc), late: Number(s.latePct || 0).toLocaleString(loc) }))}</div>
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:1rem;">
          <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase;">${this.esc(this.t('dades.kpiAvgDelay'))}</div>
          <div style="font-size:1.75rem; font-weight:700; color:var(--accent-scheduled); margin-top:0.25rem;">${s.networkAvgDelay === null || s.networkAvgDelay === undefined ? '—' : `${Number(s.networkAvgDelay) > 0 ? '+' : ''}${s.networkAvgDelay} min`}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${this.esc(this.t('dades.kpiAvgDelaySub'))}</div>
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:1rem;">
          <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase;">${this.esc(this.t('dades.kpiMaxDelay'))}</div>
          <div style="font-size:1.75rem; font-weight:700; color:var(--accent-danger); margin-top:0.25rem;">${s.networkMaxDelay === null || s.networkMaxDelay === undefined ? '—' : `${Number(s.networkMaxDelay) > 0 ? '+' : ''}${s.networkMaxDelay} min`}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${s.networkMaxDelay === null || s.networkMaxDelay === undefined ? this.esc(this.t('dades.kpiMaxDelayEmpty')) : this.esc(this.t('dades.kpiMaxDelaySub'))}</div>
        </div>
      </div>

      <!-- Sampling honesty: extrapolated rows are part of the KPIs above -->
      ${(() => {
        const sb = s.samplingBreakdown;
        if (!sb || !sb.totalSamples || !(sb.nonRealtimeSamples > 0)) return '';
        return `
        <div style="background:rgba(56,189,248,0.06); border:1px solid rgba(56,189,248,0.22); border-radius:10px; padding:0.7rem 0.95rem; margin-bottom:1.25rem; font-size:0.76rem; color:var(--text-secondary); line-height:1.5;">
          <strong style="color:var(--accent-scheduled);">${this.esc(this.t('dades.samplingTitle'))}</strong>
          ${this.t('dades.samplingText', {
            total: this.esc(sb.totalSamples.toLocaleString(loc)),
            nonRt: this.esc(sb.nonRealtimeSamples.toLocaleString(loc)),
            pct: this.esc(sb.nonRealtimePct)
          })}
        </div>`;
      })()}

      <!-- Operator delay vs. Arribo's own passing time, on the operator's trip -->
      ${(() => {
        const comp = s.delayMeasurementComparison;
        // A report cached by an older build lacks the operator_trip fields; skip the panel until it is regenerated.
        if (!comp || !comp.hasData || !comp.comparedVisits || comp.method !== 'operator_trip') return '';
        const signed = v => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${Number(v).toLocaleString(loc)} min`);
        const pctStr = v => (v === null || v === undefined ? '—' : `${Number(v).toLocaleString(loc)}%`);
        const tone = v => (v === null || v === undefined ? 'var(--text-muted)' : v >= 75 ? 'var(--accent-live)' : v >= 60 ? 'var(--accent-warning)' : 'var(--accent-danger)');
        const num = v => (Number(v) || 0).toLocaleString(loc);
        const lines = (Array.isArray(comp.byLine) ? comp.byLine : []).filter(onLine);
        const hours = (Array.isArray(comp.byHour) ? comp.byHour : []).filter(h => h.comparedVisits >= 20);
        return `
        <div style="background:rgba(16,185,129,0.06); border:1px solid rgba(16,185,129,0.25); border-radius:10px; padding:0.8rem 1rem; margin-bottom:1.25rem; font-size:0.78rem; color:var(--text-secondary); line-height:1.5;">
          <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:0.5rem; margin-bottom:0.35rem;">
            <strong style="color:var(--accent-live); font-size:0.84rem;">${this.esc(this.t('dades.contrastTitle'))}</strong>
            <span style="font-size:0.75rem; font-family:var(--font-mono); font-weight:600; background:rgba(16,185,129,0.15); color:${tone(comp.agreementPct)}; padding:0.15rem 0.5rem; border-radius:9999px;">
              ${this.esc(this.t('dades.contrastAgree', { pct: pctStr(comp.agreementPct) }))}
            </span>
          </div>
          ${netOps.length ? `<p class="dades-bus-only-note">${this.esc(this.t('dades.contrastBusOnly'))}</p>` : ''}
          <div>
            ${this.t('dades.contrastBody', {
              visits: this.esc(num(comp.comparedVisits)),
              opAvg: this.esc(signed(comp.operatorAvgDelay)),
              measAvg: this.esc(signed(comp.measuredAvgDelay)),
              bias: this.esc(signed(comp.biasMins))
            })}
          </div>
          <div style="margin-top:0.35rem;">
            <strong>${this.esc(this.t('dades.contrastTripConf', { pct: pctStr(comp.tripConfirmedPct) }))}</strong>
            ${this.esc(this.t('dades.contrastTripConfRest', { conf: num(comp.tripConfirmedVisits), checked: num(comp.tripCheckedVisits) }))}
          </div>
          ${lines.length ? `
          <div class="observatori-table-wrapper" style="margin-top:0.6rem;">
            <table class="observatori-table">
              <thead>
                <tr>
                  <th class="sticky-col">${this.esc(this.t('dades.contrastColLine'))}</th>
                  <th>${this.esc(this.t('dades.contrastColVisits'))}</th>
                  <th>${this.esc(this.t('dades.contrastColAgree'))}</th>
                  <th>${this.esc(this.t('dades.contrastColBias'))}</th>
                  <th>${this.esc(this.t('dades.contrastColConfirmed'))}</th>
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
            <div style="font-weight:600; color:var(--text-primary); margin-bottom:0.3rem;">${this.esc(this.t('dades.contrastByHour'))}</div>
            <div style="display:flex; flex-wrap:wrap; gap:0.35rem;">
              ${hours.map(h => `
              <span title="${this.esc(this.t('dades.contrastVisitsTip', { n: num(h.comparedVisits) }))}" style="font-family:var(--font-mono); font-size:0.72rem; padding:0.15rem 0.45rem; border-radius:6px; background:var(--bg-elevated); border:1px solid var(--border-subtle); color:${tone(h.agreementPct)};">
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
        if (!report.railOp && hourly.length === 0 && peakHours.length === 0) return '';

        const serviceHours = hourly.filter(h => {
          const n = parseInt(h.hour, 10);
          return n >= 6 && n <= 23;
        });
        const maxHDelay = Math.max(2, ...serviceHours.map(h => Number(h.avgDelay) || 0));

        return `
        <div class="hourly-delays-section" style="margin-bottom:1.5rem;">
          ${report.railOp ? this.renderRailHourly(report.railOp, true) : `<div class="hourly-chart-header">
            <h4 class="hourly-chart-title">
              <span>${this.esc(this.t('dades.hourlyTitle'))}</span>
            </h4>
            <div class="hourly-chart-legend">
              <div class="hourly-legend-item">
                <span class="hourly-legend-dot" style="background:#10b981;"></span>
                <span>${this.esc(this.t('dades.hourlyLegendOnTime'))}</span>
              </div>
              <div class="hourly-legend-item">
                <span class="hourly-legend-dot" style="background:#f59e0b;"></span>
                <span>${this.esc(this.t('dades.hourlyLegendMod'))}</span>
              </div>
              <div class="hourly-legend-item">
                <span class="hourly-legend-dot" style="background:#ef4444;"></span>
                <span>${this.esc(this.t('dades.hourlyLegendCrit'))}</span>
              </div>
            </div>
          </div>

          <!-- Congestion Bar Chart -->
          <div class="hourly-chart-container" title="${this.esc(this.t('dades.hourlyChartTitle'))}">
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
              const tooltip = this.t('dades.hourlyBarTip', { win: h.timeWindow, d: dVal, pct: h.latePercentage, n: h.sampleCount });
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

          `}
          <!-- Peak Hours Ranking & Critical Bottlenecks -->
          ${peakHours.length > 0 ? `
            <div style="font-size:0.85rem; font-weight:700; color:var(--text-secondary); margin-top:0.75rem;">
              ${this.esc(this.t('dades.peakHoursHeading'))}
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
                      <span class="stat-label">${this.esc(this.t('dades.peakAvgDelay'))}</span>
                      <strong class="stat-val ${ph.avgDelay >= (ph.severeFrom ?? 3) ? 'severe' : 'warning'}">+${ph.avgDelay} min</strong>
                    </div>
                    <div class="peak-hour-stat">
                      <span class="stat-label">${this.esc(this.t('dades.peakAffected'))}</span>
                      <strong class="stat-val">${ph.latePercentage}%</strong>
                    </div>
                    <div class="peak-hour-stat">
                      <span class="stat-label">${this.esc(this.t('dades.peakTrips'))}</span>
                      <strong class="stat-val">${(ph.sampleCount || 0).toLocaleString(loc)}</strong>
                    </div>
                  </div>

                  ${ph.worstStopsDuringHour && ph.worstStopsDuringHour.length > 0 ? `
                    <div class="peak-hour-bottlenecks">
                      <span class="bottlenecks-title">${this.esc(this.t('dades.peakBottlenecks'))}</span>
                      <div class="bottlenecks-list">
                        ${ph.worstStopsDuringHour.map(bs => `
                          <div class="bottleneck-item">
                            <span class="bottleneck-stop" title="${this.esc(bs.stopName)}">${this.esc(bs.stopName)}</span>
                            <span class="bottleneck-line"${bs.agencyId && bs.agencyId !== 'mataro' ? ` data-line="${this.esc(`${bs.agencyId}:${bs.lineCode}`)}"` : ' style="background:var(--brand-primary);"'}>${this.esc(bs.lineCode)}</span>
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

      ${netOps.map(o => this.renderRailHourly(o)).join('')}

      <!-- Ranking: Lines with Most Delays -->
      <div class="observatori-table-container" style="margin-bottom:1.5rem;">
        <div class="observatori-table-header-row">
          <h4 class="observatori-table-title">
            <span>${this.esc(this.t('dades.linesTitle'))}</span>
            <span class="observatori-table-subtitle">${this.esc(this.t('dades.linesSubtitle', { n: mostDelayed.length }))}</span>
          </h4>
          <span class="observatori-table-subtitle">${this.esc(this.t('dades.clickToSort'))}</span>
        </div>
        ${mostDelayed.length === 0 ? `<div style="color:var(--text-muted); font-size:0.85rem; padding:0.8rem; background:var(--bg-elevated); border-radius:8px;">${this.esc(this.t('dades.linesEmpty'))}</div>` : `
          <div class="observatori-table-scroll-hint" aria-hidden="true">
            <span class="scroll-hint-icon">↔</span>
            <span>${this.esc(this.t('dades.scrollHint'))}</span>
            <span class="scroll-hint-chevron">›</span>
          </div>
          <div class="observatori-table-wrapper">
            <table class="observatori-table">
              <thead>
                <tr>
                  <th class="sticky-col" data-sort-table="mostDelayed" data-sort-key="lineCode" role="button" tabindex="0">${this.esc(this.t('dades.colLine'))} ${getSortIndicator('mostDelayed', 'lineCode')}</th>
                  <th data-sort-table="mostDelayed" data-sort-key="avgDelay" role="button" tabindex="0">${this.esc(this.t('dades.colAvgDelay'))} ${getSortIndicator('mostDelayed', 'avgDelay')}</th>
                  <th data-sort-table="mostDelayed" data-sort-key="onTimePercentage" role="button" tabindex="0">${this.esc(this.t('dades.colOnTimePct'))} ${getSortIndicator('mostDelayed', 'onTimePercentage')}</th>
                  <th class="observatori-col-desktop" data-sort-table="mostDelayed" data-sort-key="maxDelay" role="button" tabindex="0">${this.esc(this.t('dades.colMaxDelay'))} ${getSortIndicator('mostDelayed', 'maxDelay')}</th>
                  <th class="observatori-col-desktop" data-sort-table="mostDelayed" data-sort-key="sampleCount" role="button" tabindex="0">${this.esc(this.t('dades.colVisits'))} ${getSortIndicator('mostDelayed', 'sampleCount')}</th>
                  <th class="observatori-col-desktop" data-sort-table="mostDelayed" data-sort-key="agency" role="button" tabindex="0">${this.esc(this.t('dades.colOperator'))} ${getSortIndicator('mostDelayed', 'agency')}</th>
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
                        <span class="observatori-line-badge"${l.agencyId && l.agencyId !== 'mataro' ? ` data-line="${this.esc(`${l.agencyId}:${l.lineCode}`)}"` : ' style="background:var(--brand-primary);"'}>${this.esc(l.lineCode)}</span>
                        <span class="observatori-line-name" title="${this.esc(l.name)}">${this.esc(l.name)}</span>
                      </div>
                    </td>
                    <td style="font-weight:700; color:${Number(l.avgDelay) > 0 ? 'var(--accent-danger)' : 'var(--accent-live)'}; white-space:nowrap;">
                      ${avgStr}
                    </td>
                    <td style="white-space:nowrap;">
                      <div style="display:flex; flex-direction:column; gap:0.2rem;">
                        <div style="display:flex; align-items:center; gap:0.4rem;">
                          <span style="font-weight:600; color:${onTime >= 85 ? 'var(--accent-live)' : 'var(--accent-warning)'}; min-width:34px;">${onTime.toLocaleString(loc)}%</span>
                          <div style="flex:1; max-width:60px; height:5px; background:var(--bg-main); border-radius:3px; overflow:hidden;">
                            <div style="width:${onTime}%; height:100%; background:${onTime >= 85 ? 'var(--accent-live)' : 'var(--accent-warning)'};"></div>
                          </div>
                        </div>
                        <div style="font-size:0.68rem; color:var(--text-muted);">
                          ${this.esc(this.t('dades.kpiPunctBreakdown', { onTime: onTime.toLocaleString(loc), early: (Number(l.earlyPercentage) || 0).toLocaleString(loc), late: (Number(l.latePercentage) || 0).toLocaleString(loc) }))}
                        </div>
                      </div>
                    </td>
                    <td class="observatori-col-desktop" style="color:var(--text-muted); white-space:nowrap;">${maxStr}</td>
                    <td class="observatori-col-desktop" style="color:var(--text-muted);">${(l.sampleCount || 0).toLocaleString(loc)}</td>
                    <td class="observatori-col-desktop" style="color:var(--text-muted); font-size:0.75rem;">
                      ${this.esc(l.agency || 'Mataró Bus')}
                      ${isL95 ? `<span style="color:var(--accent-scheduled); font-size:0.7rem; display:block;">${this.esc(this.t('dades.l95Note'))}</span>` : ''}
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
          const lineNotice = (filterText || lineFilter) ? this.t('dades.stopsNoticeLine') : this.t('dades.stopsNoticeNet');
          stopNoticeHtml = `
            <div class="observatori-filter-notice" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.6rem; background:rgba(0,148,133,0.08); border:1px solid rgba(0,148,133,0.25); border-radius:10px; padding:0.65rem 0.95rem; margin-bottom:1rem; font-size:0.8rem;">
              <div style="display:flex; align-items:center; gap:0.55rem; color:var(--text-primary);">
                <span style="font-size:1.15rem; flex-shrink:0;">ℹ️</span>
                <div>
                  ${this.t('dades.stopsNoticeBottlenecks')}
                  <span style="color:var(--text-muted); margin-left:0.25rem;">${this.t('dades.stopsNoticePunctual', { n: matchingPunctualCount, scope: this.esc(lineNotice) })}</span>
                </div>
              </div>
              <button type="button" class="observatori-action-btn btn-secondary btn-sm" data-toggle-stop-mode="all">
                <span>🔓</span>
                <span>${this.esc(this.t('dades.stopsViewAllBtn', { n: matchingTotalCount }))}</span>
              </button>
            </div>
          `;
        } else if (isAllStopsMode) {
          stopNoticeHtml = `
            <div class="observatori-filter-notice" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.6rem; background:rgba(2,132,199,0.08); border:1px solid rgba(56,189,248,0.25); border-radius:10px; padding:0.65rem 0.95rem; margin-bottom:1rem; font-size:0.8rem;">
              <div style="display:flex; align-items:center; gap:0.55rem; color:var(--text-primary);">
                <span style="font-size:1.15rem; flex-shrink:0;">📋</span>
                <div>
                  ${this.t('dades.stopsNoticeAll', { n: worstStops.length })}
                  <span style="color:var(--text-muted); margin-left:0.25rem;">${this.esc(this.t('dades.stopsNoticeAllCount', { n: matchingBottleneckCount }))}</span>
                </div>
              </div>
              <button type="button" class="observatori-action-btn btn-secondary btn-sm" data-toggle-stop-mode="bottlenecks">
                <span>⚠️</span>
                <span>${this.esc(this.t('dades.stopsOnlyBottlenecksBtn', { n: matchingBottleneckCount }))}</span>
              </button>
            </div>
          `;
        }

        const renderStopRow = (st) => {
          const sAvg = Number(st.avgDelay) || 0;
          const sAvgStr = sAvg > 0 ? `+${st.avgDelay} min` : (sAvg < 0 ? `${st.avgDelay} min` : '0.0 min');
          const sMaxStr = Number(st.maxDelay) > 0 ? `+${st.maxDelay} min` : `${st.maxDelay || 0} min`;
          const lColor = this.getLineColor(st.lineCode, st.agencyId);
          const badgeTextColor = this.chipInk(lColor);
          const isSevereStop = sAvg >= 1.5 || (st.severeLatePct || 0) >= 20;
          const avgDelayColor = sAvg >= 1.5 ? 'var(--accent-danger)' : (sAvg >= 0.8 ? 'var(--accent-warning)' : 'var(--accent-live)');
          return `
          <tr>
            <td class="sticky-col" style="font-weight:600; color:var(--text-primary);">
              <div class="observatori-stop-cell">
                <span class="observatori-rank-num ${isSevereStop && st.overallRank <= 3 ? 'rank-' + st.overallRank : ''}" title="${this.esc(this.t('dades.rankTitle', { n: st.overallRank }))}">#${st.overallRank}</span>
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
                <div class="bottleneck-hour-badge" title="${this.esc(this.t('dades.criticalHourTip', { d: st.criticalHourAvgDelay }))}">
                  <span class="badge-time">${this.esc(st.criticalHour)}</span>
                  <span class="badge-delay">(+${st.criticalHourAvgDelay}m)</span>
                </div>
              ` : (isSevereStop ? `<span style="color:var(--text-muted); font-size:0.75rem;">${this.esc(this.t('dades.stopsUniform'))}</span>` : `<span style="color:var(--accent-live); font-size:0.75rem; font-weight:600;">${this.esc(this.t('dades.stopsPunctual'))}</span>`)}
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
            // Grouped per operator and line: codes repeat across operators.
            const lCode = `${st.agencyId || 'mataro'}|${st.lineCode || this.t('dades.stopsOther')}`;
            if (!lineGroups.has(lCode)) {
              lineGroups.set(lCode, []);
            }
            lineGroups.get(lCode).push(st);
          }

          // Mataró's lines first, then each operator's; numeric within one.
          const sortedLineCodes = Array.from(lineGroups.keys()).sort((ka, kb) => {
            const [agA, a] = ka.split('|');
            const [agB, b] = kb.split('|');
            if (agA !== agB) return agA === 'mataro' ? -1 : (agB === 'mataro' ? 1 : agA.localeCompare(agB));
            const numA = parseInt(a.replace(/\D/g, ''), 10);
            const numB = parseInt(b.replace(/\D/g, ''), 10);
            if (!isNaN(numA) && !isNaN(numB) && numA !== numB) return numA - numB;
            return a.localeCompare(b);
          });

          tableBodyHtml = sortedLineCodes.map(groupKey => {
            const lineStops = lineGroups.get(groupKey);
            const [groupAgency, lineCode] = groupKey.split('|');
            const lColor = this.getLineColor(lineCode, groupAgency);
            const badgeTextColor = this.chipInk(lColor);
            const lineMatch = (this.availableLines || []).find(l => (l.agencyId || 'mataro') === groupAgency && String(l.code || l.id).toUpperCase() === String(lineCode).toUpperCase());
            const lineTitle = lineMatch?.name || this.t('dades.lineNameFallback', { code: lineCode });
            const lineAvg = (lineStops.reduce((sum, st) => sum + (Number(st.avgDelay) || 0), 0) / lineStops.length).toFixed(1);
            const slowestStop = lineStops.reduce((prev, curr) => (prev.overallRank < curr.overallRank ? prev : curr), lineStops[0]);

            return `
              <tr class="observatori-group-header-row">
                <td colspan="7">
                  <div class="observatori-group-header-content">
                    <div class="observatori-group-header-left">
                      <span class="observatori-line-badge" style="background:${lColor}; color:${badgeTextColor}; font-weight:800; font-size:0.75rem; padding:0.15rem 0.45rem; border-radius:4px;">${this.esc(lineCode)}</span>
                      <span style="font-weight:700; color:var(--text-primary); font-size:0.83rem;">${this.esc(lineTitle)}</span>
                      <span style="font-size:0.72rem; color:var(--text-muted); font-weight:500;">(${lineStops.length} ${this.esc(this.t(lineStops.length === 1 ? 'dades.stopOne' : 'dades.stopMany'))})</span>
                    </div>
                    <div class="observatori-group-header-right">
                      <span>${this.esc(this.t('dades.groupAvgDelay'))} <strong style="color:${Number(lineAvg) >= 3 ? 'var(--accent-danger)' : 'var(--accent-warning)'};">+${lineAvg} min</strong></span>
                      <span style="border-left:1px solid var(--border-subtle); padding-left:0.6rem;">${this.esc(this.t('dades.groupSlowest'))} <strong style="color:var(--brand-primary);">#${slowestStop.overallRank}</strong> (${this.esc(slowestStop.stopName)})</span>
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
              <span>${this.esc(this.t(isAllStopsMode ? 'dades.stopsTitleAll' : 'dades.stopsTitleBottlenecks'))}</span>
              <span class="observatori-table-subtitle">${this.esc(this.t('dades.showingOf', { shown: displayedWorstStops.length, total: totalWorst }))}</span>
            </h4>
            <div class="observatori-filter-toolbar">
              <div class="observatori-mode-toggle-group">
                <button type="button" class="observatori-pill-btn ${!isAllStopsMode ? 'active' : ''}" data-toggle-stop-mode="bottlenecks" title="${this.esc(this.t('dades.btnBottlenecksTitle'))}">${this.esc(this.t('dades.btnBottlenecks'))}</button>
                <button type="button" class="observatori-pill-btn ${isAllStopsMode ? 'active' : ''}" data-toggle-stop-mode="all" title="${this.esc(this.t('dades.btnAllStopsTitle'))}">${this.esc(this.t('dades.btnAllStops'))}</button>
              </div>
              <label class="observatori-group-toggle" title="${this.esc(this.t('dades.groupByLineTitle'))}">
                <input type="checkbox" id="observatori-group-by-line" ${isGroupedByLine ? 'checked' : ''}>
                <span>${this.esc(this.t('dades.groupByLine'))}</span>
              </label>
              <div class="observatori-filter-group" aria-label="${this.esc(this.t('dades.stopsFilterAria'))}">
                <span class="observatori-filter-label">${this.esc(this.t('dades.filterLabel'))}</span>
                <button type="button" class="observatori-pill-btn ${worstLimit === 10 ? 'active' : ''}" data-worst-limit="10">Top 10</button>
                <button type="button" class="observatori-pill-btn ${worstLimit === 25 ? 'active' : ''}" data-worst-limit="25">Top 25</button>
                <button type="button" class="observatori-pill-btn ${worstLimit >= 9999 ? 'active' : ''}" data-worst-limit="9999">${this.esc(this.t('dades.allCount', { n: totalWorst }))}</button>
              </div>
            </div>
          </div>
          ${totalWorst === 0 ? `<div style="color:var(--text-muted); font-size:0.85rem; padding:0.8rem; background:var(--bg-elevated); border-radius:8px;">${this.esc(this.t(isAllStopsMode ? 'dades.stopsEmptyAll' : 'dades.stopsEmptyBottlenecks'))}</div>` : `
            <div class="observatori-table-scroll-hint" aria-hidden="true">
              <span class="scroll-hint-icon">↔</span>
              <span>${this.esc(this.t('dades.scrollHint'))}</span>
              <span class="scroll-hint-chevron">›</span>
            </div>
            <div class="observatori-table-wrapper">
              <table class="observatori-table">
                <thead>
                  <tr>
                    <th class="sticky-col" data-sort-table="worstStops" data-sort-key="overallRank" role="button" tabindex="0">${this.esc(this.t(isAllStopsMode ? 'dades.colRankStop' : 'dades.colRankStopBottleneck'))} ${getSortIndicator('worstStops', 'overallRank')}</th>
                    <th class="observatori-col-desktop" data-sort-table="worstStops" data-sort-key="lineCode" role="button" tabindex="0">${this.esc(this.t('dades.colLine'))} ${getSortIndicator('worstStops', 'lineCode')}</th>
                    <th class="observatori-col-desktop" data-sort-table="worstStops" data-sort-key="agency" role="button" tabindex="0">${this.esc(this.t('dades.colOperator'))} ${getSortIndicator('worstStops', 'agency')}</th>
                    <th data-sort-table="worstStops" data-sort-key="avgDelay" role="button" tabindex="0">${this.esc(this.t('dades.colAvgDelay'))} ${getSortIndicator('worstStops', 'avgDelay')}</th>
                    <th data-sort-table="worstStops" data-sort-key="severeLatePct" role="button" tabindex="0">${this.esc(this.t('dades.colSeverePct'))} ${getSortIndicator('worstStops', 'severeLatePct')}</th>
                    <th data-sort-table="worstStops" data-sort-key="criticalHourAvgDelay" role="button" tabindex="0">${this.esc(this.t('dades.colCriticalHour'))} ${getSortIndicator('worstStops', 'criticalHourAvgDelay')}</th>
                    <th class="observatori-col-desktop" data-sort-table="worstStops" data-sort-key="maxDelay" role="button" tabindex="0">${this.esc(this.t('dades.colMaxShort'))} ${getSortIndicator('worstStops', 'maxDelay')}</th>
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
                  ${this.esc(this.t('dades.showMore15', { shown: displayedWorstStops.length, total: totalWorst }))}
                </button>
                <button type="button" class="btn-secondary observatori-action-btn" data-worst-limit="9999">
                  ${this.esc(this.t('dades.allCount', { n: totalWorst }))}
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
            <span style="display:flex; align-items:center; gap:0.4rem;">${this.esc(this.t('dades.opCompTitle') || 'Comparativa per Empresa Operadora')}</span>
          </h4>
          <span class="observatori-table-subtitle">${this.esc(this.t('dades.clickToSort'))}</span>
        </div>
        ${agencies.length === 0 ? `<div style="color:var(--text-muted); font-size:0.85rem; padding:0.8rem; background:var(--bg-elevated); border-radius:8px;">${this.esc(this.t('dades.opCompEmpty'))}</div>` : `
          <div class="observatori-table-scroll-hint" aria-hidden="true">
            <span class="scroll-hint-icon">↔</span>
            <span>${this.esc(this.t('dades.scrollHint'))}</span>
            <span class="scroll-hint-chevron">›</span>
          </div>
          <div class="observatori-table-wrapper">
            <table class="observatori-table">
            <thead>
              <tr>
                <th class="sticky-col" data-sort-table="agencies" data-sort-key="agency" role="button" tabindex="0">${this.esc(this.t('dades.colCompany'))} ${getSortIndicator('agencies', 'agency')}</th>
                <th class="observatori-col-desktop" data-sort-table="agencies" data-sort-key="linesCount" role="button" tabindex="0">${this.esc(this.t('dades.colLinesCount'))} ${getSortIndicator('agencies', 'linesCount')}</th>
                <th class="observatori-col-desktop" data-sort-table="agencies" data-sort-key="totalSamples" role="button" tabindex="0">${this.esc(this.t('dades.colVisits'))} ${getSortIndicator('agencies', 'totalSamples')}</th>
                <th data-sort-table="agencies" data-sort-key="avgDelay" role="button" tabindex="0">${this.esc(this.t('dades.colAvgDelay'))} ${getSortIndicator('agencies', 'avgDelay')}</th>
                <th data-sort-table="agencies" data-sort-key="onTimePct" role="button" tabindex="0">${this.esc(this.t('dades.colPunctualityIndex'))} ${getSortIndicator('agencies', 'onTimePct')}</th>
              </tr>
            </thead>
            <tbody>
              ${agencies.map(a => {
                const aAvg = Number(a.avgDelay) > 0 ? `+${a.avgDelay} min` : (Number(a.avgDelay) < 0 ? `${a.avgDelay} min` : '0.0 min');
                const onTime = a.onTimePct !== undefined && a.onTimePct !== null ? Number(a.onTimePct) : null;
                const tier = a.tier || 'measured';
                const tierChipCls = tier === 'predicted' ? 'chip-estimated' : (tier === 'timetable' ? 'chip-scheduled' : 'chip-live');
                return `
                <tr>
                  <td class="sticky-col" style="font-weight:700; color:var(--text-primary);">${this.esc(a.agency)} <span class="chip chip-plain ${tierChipCls} op-inline-chip" data-tier="${this.esc(tier)}">${this.esc(this.t(`tier.${tier}`))}</span>${netOps.length ? `<span class="dades-op-rule">${this.esc(this.t('dades.opRule', { n: a.onTimeMaxMins }))}</span>` : ''}</td>
                  <td class="observatori-col-desktop" style="color:var(--text-muted); text-align:center;">${a.linesCount || 0}</td>
                  <td class="observatori-col-desktop" style="color:var(--text-muted);">${(a.totalVisits || a.totalSamples || 0).toLocaleString(loc)}</td>
                  <td style="font-weight:700; color:${Number(a.avgDelay) > 0 ? 'var(--accent-danger)' : 'var(--accent-live)'}; white-space:nowrap;">${aAvg}</td>
                  <td style="white-space:nowrap;">
                    <span style="font-weight:700; color:${onTime === null ? 'var(--text-muted)' : (onTime >= 85 ? 'var(--accent-live)' : 'var(--accent-warning)')};">${onTime === null ? '—' : `${onTime.toLocaleString(loc)}%`}</span>
                    <span style="font-size:0.7rem; color:var(--text-muted); margin-left:0.3rem;">${this.esc(this.t('dades.opOnTimeWord'))}${a.earlyPct ? this.esc(this.t('dades.opEarlyPart', { n: Number(a.earlyPct).toLocaleString(loc) })) : ''}${a.latePct ? this.esc(this.t('dades.opLatePart', { n: Number(a.latePct).toLocaleString(loc) })) : ''}</span>
                  </td>
                </tr>
              `;}).join('')}
            </tbody>
          </table>
        </div>
      `}
      </div>

    `;

    // The operator comparison goes below the GPS map, in its own container.
    const operatorsAt = html.indexOf('<!-- Ranking: Operators Performance -->');
    const operators = document.getElementById('journalism-operators-container');
    if (operators && operatorsAt >= 0) {
      operators.innerHTML = html.slice(operatorsAt);
      html = html.slice(0, operatorsAt);
    }
    if (report.isMoventis) {
      html += this.renderMoventisExtras(this.moventisData);
    }
    container.innerHTML = html;
    container.querySelectorAll('[data-bar-h]').forEach(el => { el.style.height = `${el.dataset.barH}%`; });
    this.initObservatoriTableScrolls();
  }

  // ==========================================
  // 2. STOP DELAY HEATMAP MATRIX & DRILLDOWNS
  // ==========================================

  // A line's colour by code within its operator: FGC's L6 is not Mataró's L6.
  getLineColor(code, agencyId = 'mataro') {
    const match = (this.availableLines || []).find(l => (l.agencyId || 'mataro') === (agencyId || 'mataro')
      && String(l.code || l.id).toUpperCase() === String(code).toUpperCase());
    if (match?.color) return match.color;
    if (agencyId === 'moventis') {
      const mov = (this.moventisData?.lines || []).find(l => String(l.code || '').toUpperCase() === String(code).toUpperCase());
      if (mov?.color) return mov.color;
    }
    return 'var(--brand-primary)';
  }

  // Text ink for a line-colour chip. Luminance-aware, so pale lines (L5/L6/L7)
  // get dark text instead of the 1.19-1.66:1 white they used to carry. Falls
  // back to white when the colour is a var() we cannot measure.
  chipInk(lineColour) {
    return window.TransitUtils?.chipTextColor?.(lineColour) || '#fff';
  }

  renderStopHeatmap(stops) {
    if (!stops.length) return '';
    if (!stops.every(stop => Array.isArray(stop.hourly))) return `<p>${this.esc(this.t('dades.heatPending'))}</p>`;

    this._heatmapStops = stops;
    const hasData = h => stops.some(s => (s.hourly?.[h]?.sampleCount || 0) > 0);
    let visibleHours = Array.from({ length: 24 }, (_, h) => h).filter(hasData);
    if (!visibleHours.length) {
      visibleHours = Array.from({ length: 17 }, (_, i) => i + 6);
    }
    this._heatmapVisibleHours = visibleHours;

    const cell = (bucket, stopIdx, h) => {
      const b = bucket || { sampleCount: 0 };
      const label = b.sampleCount
        ? this.t('dades.heatCellLabel', { avg: b.avgDelay, n: b.sampleCount, max: b.maxDelay, severe: b.severeLatePct })
        : this.t('dades.dhNoData');
      const level = !b.sampleCount ? 'empty' : b.avgDelay >= 5 ? 'late' : b.avgDelay >= 3 ? 'moderate' : 'regular';
      return `<td class="stop-heat-cell heat-${level}" data-stop-idx="${stopIdx}" data-hour="${h}" role="button" tabindex="0" title="${this.esc(this.t('dades.heatCellTip', { label }))}"><span aria-label="${this.esc(label)}">${b.sampleCount ? b.avgDelay : '—'}</span>${b.sampleCount > 0 && b.sampleCount < 5 ? '<small> *</small>' : ''}</td>`;
    };

    return `<section class="stop-hourly-section"><h4>${this.esc(this.t('dades.heatTitle'))}</h4>
      <p>${this.t('dades.heatDesc')}</p>
      <p class="stop-heat-legend"><span class="heat-regular">${this.esc(this.t('dades.heatLegendLow'))}</span> <span class="heat-moderate">${this.esc(this.t('dades.heatLegendMid'))}</span> <span class="heat-late">${this.esc(this.t('dades.heatLegendHigh'))}</span> <span>${this.esc(this.t('dades.heatLegendEmpty'))}</span></p>
      <div class="observatori-table-wrapper stop-heatmap-wrapper"><table class="observatori-table stop-heatmap"><caption>${this.esc(this.t('dades.heatCaption'))}</caption><thead><tr><th scope="col">${this.esc(this.t('dades.heatColStopLine'))}</th>${visibleHours.map(h => `<th scope="col" data-hour="${h}" role="button" tabindex="0" title="${this.esc(this.t('dades.heatColHourTip', { h: String(h).padStart(2, '0') }))}">${String(h).padStart(2, '0')}</th>`).join('')}</tr></thead>
      <tbody>${stops.map((stop, stopIdx) => `<tr><th scope="row" data-stop-idx="${stopIdx}" role="button" tabindex="0" title="${this.esc(this.t('dades.heatRowStopTip', { stop: stop.stopName }))}">${this.esc(stop.stopName)} / ${this.esc(stop.lineCode)}</th>${visibleHours.map(h => cell(stop.hourly?.[h], stopIdx, h)).join('')}</tr>`).join('')}</tbody></table></div>
      
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
    this._activeModal = { type: 'stop', stopIdx, hour: this._activeDrilldownHour };

    const backdrop = document.getElementById('stop-drilldown-modal-backdrop');
    const content = document.getElementById('stop-drilldown-modal-content');
    if (!backdrop || !content) return;

    const visibleHours = this._heatmapVisibleHours || Array.from({ length: 24 }, (_, i) => i);
    const selH = this._activeDrilldownHour;
    const selectedBucket = selH !== null ? stop.hourly?.[selH] : null;
    const lColor = this.getLineColor(stop.lineCode, stop.agencyId);

    content.innerHTML = `
      <button type="button" class="modal-close-btn" id="stop-drilldown-close-btn" aria-label="${this.esc(this.t('dades.modalCloseAria'))}">&times;</button>
      <div class="stop-drilldown-header">
        <div style="display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;">
          <span class="stop-drilldown-line-badge" style="background:${lColor};">${this.esc(stop.lineCode)}</span>
          <h3 class="stop-drilldown-title" id="stop-drilldown-modal-title">${this.esc(stop.stopName)}</h3>
        </div>
        <p class="stop-drilldown-subtitle">
          ${this.t('dades.modalStopSub', { count: this.esc(stop.arrivalCount), avg: this.esc(stop.avgDelay), max: this.esc(stop.maxDelay || 0) })}
        </p>
      </div>

      ${selH !== null && selectedBucket ? `
        <div class="drilldown-hour-highlight">
          <div class="drilldown-kpi">
            <span class="drilldown-kpi-label">${this.esc(this.t('dades.modalHourRange'))}</span>
            <strong class="drilldown-kpi-val">${String(selH).padStart(2, '0')}:00 - ${String(selH).padStart(2, '0')}:59</strong>
          </div>
          <div class="drilldown-kpi">
            <span class="drilldown-kpi-label">${this.esc(this.t('dades.modalAvgDelay'))}</span>
            <strong class="drilldown-kpi-val ${selectedBucket.avgDelay >= 5 ? 'severe' : selectedBucket.avgDelay >= 3 ? 'warning' : 'ok'}">
              ${selectedBucket.sampleCount ? `+${selectedBucket.avgDelay} min` : this.esc(this.t('dades.dhNoData'))}
            </strong>
          </div>
          <div class="drilldown-kpi">
            <span class="drilldown-kpi-label">${this.esc(this.t('dades.modalSamples'))}</span>
            <strong class="drilldown-kpi-val">${selectedBucket.sampleCount || 0}</strong>
          </div>
          <div class="drilldown-kpi">
            <span class="drilldown-kpi-label">${this.esc(this.t('dades.modalMaxDelay'))}</span>
            <strong class="drilldown-kpi-val">${selectedBucket.maxDelay !== null ? `+${selectedBucket.maxDelay} min` : '—'}</strong>
          </div>
          <div class="drilldown-kpi">
            <span class="drilldown-kpi-label">${this.esc(this.t('dades.modalSevereTrips'))}</span>
            <strong class="drilldown-kpi-val ${selectedBucket.severeLatePct >= 30 ? 'severe' : selectedBucket.severeLatePct >= 15 ? 'warning' : 'ok'}">
              ${selectedBucket.severeLatePct !== null ? `${selectedBucket.severeLatePct}%` : '—'}
            </strong>
          </div>
        </div>
      ` : ''}

      <div style="font-size:0.78rem; color:var(--text-muted); margin-bottom:0.4rem; display:flex; justify-content:space-between; align-items:center;">
        <span>${this.esc(this.t('dades.modalClickHourHint'))}</span>
        <span>${this.esc(this.t('dades.modalLessThan5'))}</span>
      </div>

      <div class="observatori-table-wrapper" style="max-height: 48vh; overflow:auto;">
        <table class="observatori-table stop-drilldown-table">
          <thead>
            <tr>
              <th>${this.esc(this.t('dades.modalColHour'))}</th>
              <th>${this.esc(this.t('dades.modalColSamples'))}</th>
              <th>${this.esc(this.t('dades.modalColAvgMin'))}</th>
              <th>${this.esc(this.t('dades.modalColMaxMin'))}</th>
              <th>${this.esc(this.t('dades.modalColSevere'))}</th>
            </tr>
          </thead>
          <tbody>
            ${stop.hourly.filter(b => visibleHours.includes(parseInt(b.hour, 10))).map(b => {
              const bHour = parseInt(b.hour, 10);
              const isSelected = selH !== null && bHour === selH;
              return `
                <tr class="${isSelected ? 'drilldown-selected-row' : ''}" data-select-drilldown-hour="${bHour}" role="button" tabindex="0" title="${this.esc(this.t('dades.modalSelectHourTip', { h: b.hour }))}">
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
    this._activeModal = { type: 'hour', hour: h };
    const stopsAtHour = stops.map((s, idx) => ({ ...s, stopIdx: idx, bucket: s.hourly?.[h] }))
      .filter(s => (s.bucket?.sampleCount || 0) > 0)
      .sort((a, b) => (b.bucket.avgDelay || 0) - (a.bucket.avgDelay || 0));

    const backdrop = document.getElementById('stop-drilldown-modal-backdrop');
    const content = document.getElementById('stop-drilldown-modal-content');
    if (!backdrop || !content) return;

    const padH = String(h).padStart(2, '0');
    content.innerHTML = `
      <button type="button" class="modal-close-btn" id="stop-drilldown-close-btn" aria-label="${this.esc(this.t('dades.modalCloseAria'))}">&times;</button>
      <div class="stop-drilldown-header">
        <div style="display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;">
          <span class="stop-drilldown-line-badge" style="background:var(--brand-primary);">⏰ ${padH}:00h</span>
          <h3 class="stop-drilldown-title" id="stop-drilldown-modal-title">${this.esc(this.t('dades.modalHourTitle', { h: padH }))}</h3>
        </div>
        <p class="stop-drilldown-subtitle">
          ${this.esc(this.t('dades.modalHourSub', { n: stopsAtHour.length }))}
        </p>
      </div>

      <div style="font-size:0.78rem; color:var(--text-muted); margin-bottom:0.4rem;">
        ${this.esc(this.t('dades.modalClickStopHint'))}
      </div>

      <div class="observatori-table-wrapper" style="max-height: 55vh; overflow:auto;">
        <table class="observatori-table stop-drilldown-table">
          <thead>
            <tr>
              <th style="width:40px; text-align:center;">#</th>
              <th>${this.esc(this.t('dades.heatColStopLine'))}</th>
              <th>${this.esc(this.t('dades.modalColSamples'))}</th>
              <th>${this.esc(this.t('dades.colAvgDelay'))}</th>
              <th>${this.esc(this.t('dades.colMaxDelay'))}</th>
              <th>${this.esc(this.t('dades.modalColSevere'))}</th>
            </tr>
          </thead>
          <tbody>
            ${stopsAtHour.length === 0 ? `
              <tr><td colspan="6" style="text-align:center; padding:1.5rem; color:var(--text-muted);">${this.esc(this.t('dades.modalHourEmpty'))}</td></tr>
            ` : stopsAtHour.map((s, idx) => {
              const b = s.bucket;
              const lColor = this.getLineColor(s.lineCode);
              return `
                <tr data-switch-stop-idx="${s.stopIdx}" data-switch-hour="${h}" role="button" tabindex="0" style="cursor:pointer;" title="${this.esc(this.t('dades.modalOpenStopTip', { stop: s.stopName }))}">
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
    this._activeModal = null;
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
    this.renderLineFilter();
    if (contentContainer) contentContainer.style.display = 'none';
    if (incidentsContainer) incidentsContainer.style.display = 'none';
    const monthlyContainer = document.getElementById('journalism-monthly-container');
    if (monthlyContainer) monthlyContainer.style.display = 'none';
    if (termometreContainer) {
      termometreContainer.style.display = 'block';
      this.showGpsGaps(false);
      if (!this.termometreData || force) {
        termometreContainer.innerHTML = `<div style="text-align:center; padding:3rem;"><span class="loading-spinner-inline"></span> ${this.esc(this.t('dades.termLoading'))}</div>`;
      }
    }

    try {
      const res = await fetch(`/api/analytics/termometre?hours=${hours}`).then(r => r.json());
      if (res && res.success && res.termometre) {
        this.termometreData = res.termometre;
        this.renderTermometreScorecard(res.termometre);
      } else {
        if (termometreContainer) {
          termometreContainer.innerHTML = `<div style="color:var(--danger); text-align:center; padding:2rem;">${this.esc(this.t('dades.termGenError'))}</div>`;
        }
      }
    } catch {
      if (termometreContainer) {
        termometreContainer.innerHTML = `<div style="color:var(--danger); text-align:center; padding:2rem;">${this.esc(this.t('dades.termConnError'))}</div>`;
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
    const loc = this.locale();
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
    const visitsFmt = (t.totalTripsAnalyzed || 0).toLocaleString(loc);

    container.innerHTML = `
      <div class="termometre-scorecard" id="termometre-card-root">
        <div class="termometre-header">
          <div>
            <span style="font-size:0.75rem; font-weight:800; color:var(--accent-scheduled); text-transform:uppercase; letter-spacing:0.5px;">${this.esc(this.t('dades.termEyebrow'))}</span>
            <h3 style="font-size:1.35rem; font-weight:800; color:var(--text-primary); margin:0.2rem 0;">${this.esc(this.t('dades.termTitle'))}</h3>
            <span style="font-size:0.78rem; color:var(--text-muted);">${this.esc(this.t('dades.termSubtitle'))}</span>
          </div>
          <div class="termometre-grade-badge" style="border-color:${gradeColorCss}; background:rgba(16,185,129,0.12);">
            <div>
              <div style="font-size:0.65rem; font-weight:800; color:var(--text-muted); text-transform:uppercase;">${this.esc(this.t('dades.termGradeLabel'))}</div>
              <div class="termometre-grade-letter" style="color:${gradeColorCss};">${this.esc(t.grade)}</div>
            </div>
          </div>
        </div>

        <div class="termometre-metrics-grid">
          <div class="termometre-metric-tile" style="border-left:3px solid var(--accent-live);">
            <span class="termometre-metric-label">${this.esc(this.t('dades.termChampLabel'))}</span>
            <span class="termometre-metric-val" style="color:var(--accent-live);">
              ${t.championLine ? this.esc(t.championLine.code) : '—'} (${championPct} ${this.esc(this.t('dades.termPunctualWord'))})
            </span>
            <span style="font-size:0.72rem; color:var(--text-muted);">${this.esc(this.t('dades.termAvgDelayLabel', { val: t.championLine ? mins(t.championLine.avgDelay) : '—' }))}</span>
          </div>

          <div class="termometre-metric-tile" style="border-left:3px solid var(--accent-danger);">
            <span class="termometre-metric-label">${this.esc(this.t('dades.termWorstLabel'))}</span>
            <span class="termometre-metric-val" style="color:var(--accent-danger); font-size:1rem;">
              ${t.worstBottleneck ? this.esc(t.worstBottleneck.stopName) : '—'}
            </span>
            <span style="font-size:0.72rem; color:var(--text-muted);">${t.worstBottleneck ? this.esc(t.worstBottleneck.lineCode || '') : ''} • ${this.esc(this.t('dades.termAvgDelaySuffix', { val: t.worstBottleneck ? mins(t.worstBottleneck.avgDelay) : '—' }))}</span>
          </div>

          <div class="termometre-metric-tile" style="border-left:3px solid var(--accent-warning);">
            <span class="termometre-metric-label">${this.esc(this.t('dades.termPeakLabel'))}</span>
            <span class="termometre-metric-val" style="color:var(--accent-warning);">
              ${t.peakHour ? this.esc(t.peakHour) : '—'}
            </span>
            <span style="font-size:0.72rem; color:var(--text-muted);">${this.esc(this.t('dades.termPeakNetSuffix', { val: t.peakHour ? mins(t.peakHourDelay) : '—' }))}</span>
          </div>

          <div class="termometre-metric-tile" style="border-left:3px solid var(--accent-scheduled);">
            <span class="termometre-metric-label">${this.esc(this.t('dades.termGlobalLabel'))}</span>
            <span class="termometre-metric-val" style="color:var(--accent-scheduled);">
              ${pct(t.punctualityPct)}
            </span>
            <span style="font-size:0.72rem; color:var(--text-muted);">${this.esc(this.t('dades.termVisitsLabel', { n: visitsFmt }))}</span>
          </div>
        </div>

        <div class="termometre-actions-row">
          <div style="font-size:0.75rem; color:var(--text-muted);">
            ${this.esc(this.t('dades.termLastHours', { h: t.timeframeHours || 24 }))}
          </div>
          <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
            <button type="button" class="btn-primary btn-termometre-action" id="btn-termometre-share">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              <span>${this.esc(this.t('dades.termShareBtn'))}</span>
            </button>
            <button type="button" class="btn-secondary btn-termometre-action" id="btn-termometre-download">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              <span>${this.esc(this.t('dades.termDownloadBtn'))}</span>
            </button>
          </div>
        </div>
      </div>
    `;

    document.getElementById('btn-termometre-share')?.addEventListener('click', (e) => {
      e.preventDefault();
      const shareText = this.t('dades.termShareText', {
        h: t.timeframeHours || 24,
        grade: t.grade,
        pct: pct(t.punctualityPct),
        champ: t.championLine ? t.championLine.code : '—',
        champPct: championPct,
        worst: t.worstBottleneck ? t.worstBottleneck.stopName : '—',
        worstDelay: t.worstBottleneck ? mins(t.worstBottleneck.avgDelay) : '—',
        peak: t.peakHour || '—',
        visits: visitsFmt
      });

      if (navigator.clipboard) {
        navigator.clipboard.writeText(shareText).then(() => {
          alert(this.t('dades.termShareAlert'));
        });
      } else {
        prompt(this.t('dades.termSharePrompt'), shareText);
      }
    });

    document.getElementById('btn-termometre-download')?.addEventListener('click', (e) => {
      e.preventDefault();
      const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 420" width="800" height="420" style="background:#0f172a; font-family:sans-serif;">
  <rect width="800" height="420" fill="#0f172a" rx="16"/>
  <text x="40" y="50" fill="#38bdf8" font-size="14" font-weight="bold" letter-spacing="1">${this.esc(this.t('dades.termSvgEyebrow'))}</text>
  <text x="40" y="85" fill="#ffffff" font-size="26" font-weight="bold">${this.esc(this.t('dades.termSvgTitle'))}</text>
  <text x="40" y="110" fill="#94a3b8" font-size="13">${this.esc(this.t('dades.termSvgSub', { h: t.timeframeHours || 24 }))}</text>

  <rect x="660" y="35" width="95" height="75" rx="10" fill="#1e293b" stroke="${gradeColor}" stroke-width="2"/>
  <text x="707" y="58" fill="#94a3b8" font-size="11" text-anchor="middle" font-weight="bold">${this.esc(this.t('dades.termSvgGrade'))}</text>
  <text x="707" y="96" fill="${gradeColor}" font-size="34" text-anchor="middle" font-weight="bold">${this.esc(t.grade)}</text>

  <rect x="40" y="140" width="345" height="100" rx="10" fill="#1e293b" stroke="#10b981" stroke-width="1.5"/>
  <text x="60" y="170" fill="#10b981" font-size="13" font-weight="bold">${this.esc(this.t('dades.termSvgChamp'))}</text>
  <text x="60" y="202" fill="#ffffff" font-size="20" font-weight="bold">${t.championLine ? this.esc(t.championLine.code) : '—'} (${championPct} ${this.esc(this.t('dades.termPunctualWord'))})</text>
  <text x="60" y="225" fill="#94a3b8" font-size="12">${this.esc(this.t('dades.termAvgDelayLabel', { val: t.championLine ? mins(t.championLine.avgDelay) : '—' }))}</text>

  <rect x="415" y="140" width="345" height="100" rx="10" fill="#1e293b" stroke="#ef4444" stroke-width="1.5"/>
  <text x="435" y="170" fill="#ef4444" font-size="13" font-weight="bold">${this.esc(this.t('dades.termSvgWorst'))}</text>
  <text x="435" y="202" fill="#ffffff" font-size="18" font-weight="bold">${t.worstBottleneck ? this.esc(t.worstBottleneck.stopName) : '—'}</text>
  <text x="435" y="225" fill="#94a3b8" font-size="12">${t.worstBottleneck ? this.esc(t.worstBottleneck.lineCode || '') : ''} • ${this.esc(this.t('dades.termAvgDelaySuffix', { val: t.worstBottleneck ? mins(t.worstBottleneck.avgDelay) : '—' }))}</text>

  <rect x="40" y="260" width="345" height="100" rx="10" fill="#f59e0b" stroke="#1.5"/>
  <text x="60" y="290" fill="#f59e0b" font-size="13" font-weight="bold">${this.esc(this.t('dades.termSvgPeak'))}</text>
  <text x="60" y="322" fill="#ffffff" font-size="20" font-weight="bold">${t.peakHour ? this.esc(t.peakHour) : '—'}</text>
  <text x="60" y="345" fill="#94a3b8" font-size="12">${this.esc(this.t('dades.termPeakNetSuffix', { val: t.peakHour ? mins(t.peakHourDelay) : '—' }))}</text>

  <rect x="415" y="260" width="345" height="100" rx="10" fill="#1e293b" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="435" y="290" fill="#38bdf8" font-size="13" font-weight="bold">${this.esc(this.t('dades.termSvgGlobal'))}</text>
  <text x="435" y="322" fill="#ffffff" font-size="20" font-weight="bold">${pct(t.punctualityPct)} (${this.esc(this.t('dades.termSvgSamples', { n: visitsFmt }))})</text>
  <text x="435" y="345" fill="#94a3b8" font-size="12">${this.esc(this.t('dades.termSvgNetAvg', { val: mins(t.networkAvgDelay) }))}</text>

  <text x="40" y="395" fill="#64748b" font-size="12">${this.esc(this.t('dades.termSvgFooter'))}</text>
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
            <span style="font-size:0.75rem; font-weight:800; color:var(--accent-scheduled); text-transform:uppercase; letter-spacing:0.5px;">${this.esc(this.t('dades.termEyebrow'))}</span>
            <h3 style="font-size:1.35rem; font-weight:800; color:var(--text-primary); margin:0.2rem 0;">${this.esc(this.t('dades.termTitle'))}</h3>
            <span style="font-size:0.78rem; color:var(--text-muted);">${this.esc(this.t('dades.termLastHours', { h: hours }))}</span>
          </div>
          <div class="termometre-grade-badge" style="border-color:var(--border-subtle); background:rgba(148,163,184,0.08);">
            <div>
              <div style="font-size:0.65rem; font-weight:800; color:var(--text-muted); text-transform:uppercase;">${this.esc(this.t('dades.termGradeLabel'))}</div>
              <div class="termometre-grade-letter" style="color:var(--text-muted);">—</div>
            </div>
          </div>
        </div>

        <div style="margin:1.25rem 0; padding:1rem 1.1rem; background:rgba(251,191,36,0.07); border:1px solid rgba(251,191,36,0.25); border-radius:10px; font-size:0.82rem; line-height:1.5; color:var(--text-secondary);">
          <strong style="color:var(--accent-warning);">${this.esc(this.t('dades.termNoDataTitle'))}</strong>
          ${this.esc(this.t('dades.termNoDataText'))}
        </div>

        <div class="termometre-metrics-grid">
          <div class="termometre-metric-tile" style="border-left:3px solid var(--border-subtle);">
            <span class="termometre-metric-label">${this.esc(this.t('dades.termChampLabel'))}</span>
            <span class="termometre-metric-val" style="color:var(--text-muted);">—</span>
            <span style="font-size:0.72rem; color:var(--text-muted);">${this.esc(this.t('dades.termNoSamples'))}</span>
          </div>
          <div class="termometre-metric-tile" style="border-left:3px solid var(--border-subtle);">
            <span class="termometre-metric-label">${this.esc(this.t('dades.termWorstLabel'))}</span>
            <span class="termometre-metric-val" style="color:var(--text-muted); font-size:1rem;">—</span>
            <span style="font-size:0.72rem; color:var(--text-muted);">${this.esc(this.t('dades.termNoSamples'))}</span>
          </div>
          <div class="termometre-metric-tile" style="border-left:3px solid var(--border-subtle);">
            <span class="termometre-metric-label">${this.esc(this.t('dades.termPeakLabel'))}</span>
            <span class="termometre-metric-val" style="color:var(--text-muted);">—</span>
            <span style="font-size:0.72rem; color:var(--text-muted);">${this.esc(this.t('dades.termNoSamples'))}</span>
          </div>
          <div class="termometre-metric-tile" style="border-left:3px solid var(--border-subtle);">
            <span class="termometre-metric-label">${this.esc(this.t('dades.termGlobalLabel'))}</span>
            <span class="termometre-metric-val" style="color:var(--text-muted);">—</span>
            <span style="font-size:0.72rem; color:var(--text-muted);">${this.esc(this.t('dades.termZeroVisits'))}</span>
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
    this.renderLineFilter();
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

    const cleanLabel = (lineCode === 'all' || lineCode === 'ALL') ? this.t('dades.incWholeNetwork') : lineCode;
    const retryMsg = retryCount > 0 ? this.t('dades.incRetrying') : '';
    container.innerHTML = `
      <div style="text-align:center; padding:3rem 1rem; color:var(--text-muted);">
        <span class="loading-spinner-inline" style="width:24px; height:24px; border-width:3px; margin-bottom:0.75rem;"></span>
        <div style="font-weight:700; font-size:0.95rem; color:var(--text-primary); margin-top:0.5rem;">${this.esc(this.t('dades.incLoadingTitle'))}</div>
        <div style="font-size:0.8rem; margin-top:0.25rem;">${this.esc(this.t('dades.incLoadingSub', { target: cleanLabel, retry: retryMsg }))}</div>
      </div>
    `;

    try {
      const cleanLine = encodeURIComponent(lineCode);
      const res = await fetch(`/api/analytics/incidents?line=${cleanLine}&hours=${hours}&limit=30&minDelay=5`).then(r => r.json());
      if (res && res.success) {
        if (this._incidentCache) {
          this._incidentCache.set(cacheKey, { data: res, timestamp: Date.now() });
          if (this._incidentCache.size > 30) {
            this._incidentCache.delete(this._incidentCache.keys().next().value);
          }
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
    this._lastIncidentInspect = null;
    panel.style.display = 'block';
    content.innerHTML = `<span style="color:var(--text-muted);">${this.esc(this.t('dades.invLoading'))}</span>`;
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
        content.innerHTML = `<span style="color:var(--accent-danger);">${this.esc(this.t('dades.invLoadError', { err: data?.error || '' }))}</span>`;
        summary.innerHTML = `<p style="color:var(--text-muted); font-size:0.82rem;">${this.esc(this.t('dades.invNoSamples60', { line: lineCode, stop: stopName }))}</p>`;
        return;
      }
      this._lastIncidentInspect = { data, lineCode, stopName };
      this._renderIncidentDrilldown(data, lineCode, stopName, false);
    } catch (e) {
      content.innerHTML = `<span style="color:var(--accent-danger);">${this.esc(this.t('dades.invError', { err: e.message }))}</span>`;
    }
  }

  _renderIncidentDrilldown(data, lineCode, stopName, scrollIntoView = true) {
    const panel = document.getElementById('incident-drilldown-panel');
    const content = document.getElementById('drilldown-content');
    const summary = document.getElementById('drilldown-summary');
    if (!panel || !content || !summary || !data) return;
    panel.style.display = 'block';
    if (scrollIntoView) panel.scrollIntoView({ behavior: 'smooth' });

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
    const stopsWord = n => (n === 1 ? this.t('dades.invStopOne') : this.t('dades.invStopMany', { n }));

    // What happened, in one plain sentence. Token colours only (light + dark).
    let headline;
    const dh = ep.deadheadReturn || null;
    if (ep.verdict === 'deadhead_return' && dh) {
      headline = {
        tone: 'var(--accent-warning)',
        title: this.esc(this.t('dades.invDeadheadTitle')),
        text: this.t('dades.invDeadheadText', {
          after: this._afterStop(dh.lastServedStop),
          lastTime: this.esc(dh.lastServedTime),
          bus: this.esc(dh.vehicleId),
          resumeStop: this.esc(dh.resumeStop),
          resumeTime: this.esc(dh.resumeTime)
        })
      };
    } else if (ep.verdict === 'backward_leg' && ep.backwardLeg) {
      const bl = ep.backwardLeg;
      headline = {
        tone: 'var(--accent-warning)',
        title: this.esc(this.t('dades.invBackwardTitle')),
        text: this.t('dades.invBackwardText', {
          after: this._afterStop(bl.lastServedStop),
          lastTime: this.esc(hhmm(bl.lastServedTime)),
          lastDelay: signed(bl.lastServedDelay),
          bus: this.esc(bl.vehicleId),
          lowestStop: this.esc(bl.lowestStop),
          steps: bl.stepsBack,
          visits: bl.visitCount,
          from: this.esc(hhmm(bl.fromTime)),
          to: this.esc(hhmm(bl.toTime))
        })
      };
    } else if (ep.tripRelink) {
      headline = {
        tone: 'var(--accent-warning)',
        title: this.esc(this.t('dades.invRelinkTitle')),
        text: this.t('dades.invRelinkText', {
          stop: this.esc(ep.tripRelink.stopName),
          before: ep.tripRelink.delayBefore,
          after: ep.tripRelink.delayAfter
        })
      };
    } else if (ep.verdict === 'delay_jump' && ep.delayJump) {
      const jp = ep.delayJump;
      headline = {
        tone: 'var(--accent-warning)',
        title: this.esc(this.t('dades.invJumpTitle')),
        text: this.t('dades.invJumpText', {
          bus: this.esc(jp.vehicleId),
          beforeDelay: signed(jp.delayBefore),
          beforeStop: this.esc(jp.beforeStop),
          beforeTime: this.esc(jp.beforeTime),
          afterDelay: signed(jp.delayAfter),
          jumpStop: this.esc(jp.jumpStop),
          jumpTime: this.esc(jp.jumpTime),
          elapsed: jp.elapsedMins
        })
      };
    } else if (!run) {
      headline = {
        tone: 'var(--text-muted)',
        title: this.esc(this.t('dades.invNoRunTitle')),
        text: this.esc(this.t('dades.invNoRunText'))
      };
    } else {
      const who = bus ? this.t('dades.invBus', { bus: this.esc(bus) }) : this.t('dades.invTheBus');
      const byPattern = {
        sustained: { tone: 'var(--accent-danger)', title: this.esc(this.t('dades.invPatSustainedTitle')), text: this.t('dades.invPatSustainedText', { who, min: signed(sum.minDelay), max: signed(sum.maxDelay), stops: this.esc(stopsWord(sum.stopCount)), range: this.esc(range) }) },
        building: { tone: 'var(--accent-danger)', title: this.esc(this.t('dades.invPatBuildingTitle')), text: this.t('dades.invPatBuildingText', { who, first: signed(sum.firstDelay), last: signed(sum.lastDelay), stops: this.esc(stopsWord(sum.stopCount)), range: this.esc(range) }) },
        recovering: { tone: 'var(--accent-warning)', title: this.esc(this.t('dades.invPatRecoveringTitle')), text: this.t('dades.invPatRecoveringText', { who, first: signed(sum.firstDelay), last: signed(sum.lastDelay), stops: this.esc(stopsWord(sum.stopCount)), range: this.esc(range) }) },
        variable: { tone: 'var(--accent-warning)', title: this.esc(this.t('dades.invPatVariableTitle')), text: this.t('dades.invPatVariableText', { who, min: signed(sum.minDelay), max: signed(sum.maxDelay), stops: this.esc(stopsWord(sum.stopCount)), range: this.esc(range) }) },
        isolated: { tone: 'var(--text-secondary)', title: this.esc(this.t('dades.invPatIsolatedTitle')), text: this.t('dades.invPatIsolatedText', { who }) }
      };
      headline = byPattern[sum.pattern] || byPattern.variable;
    }

    // The trip right after the clicked one, when the bus joined it mid-route: that
    // is why a large delay "disappears" from one stop to the next.
    const clickedTripIdx = trips.findIndex(t => t.isClickedTrip);
    const nextTrip = clickedTripIdx >= 0 ? trips[clickedTripIdx + 1] : null;
    const shortTurn = nextTrip && nextTrip.joinedMidRoute ? nextTrip : null;
    const shortTurnNote = shortTurn ? this._shortTurnNote(shortTurn, run.stops[shortTurn.startIndex].stopName) : '';

    // A deadhead return in the shown run: why the bus starts again so soon, why the
    // records in between do not count, and the wait it left on the skipped trip.
    const dhGap = dh && dh.unservedGap ? dh.unservedGap : null;
    const deadheadNote = dh
      ? `<div class="drilldown-callout">
          <strong>${this.esc(this.t('dades.invSkippedTitle'))}</strong>
          ${this.t('dades.invSkippedBody', {
            after: this._afterStop(dh.lastServedStop),
            lastTime: this.esc(dh.lastServedTime),
            lastDelay: signed(dh.lastServedDelay),
            dep: dh.skippedDeparture ? this.esc(this.t('dades.invSkippedDep', { time: dh.skippedDeparture })) : '',
            from: this.esc(dh.skippedFrom),
            to: this.esc(dh.skippedTo),
            opp: dh.oppositeTripMinutes,
            ret: dh.returnMinutes,
            resumeStop: this.esc(dh.resumeStop),
            resumeTime: this.esc(dh.resumeTime),
            phantoms: dh.phantoms.map(p => `${this.esc(p.stopName)} ${signed(p.delayMins)} min`).join(', ')
          })}
          ${dhGap ? this.esc(this.t('dades.invSkippedGap', {
            stop: dhGap.stopName,
            from: dhGap.fromTime,
            to: dhGap.toTime,
            mins: dhGap.minutes,
            headway: dhGap.plannedHeadwayMinutes ? this.t('dades.invSkippedHeadway', { n: dhGap.plannedHeadwayMinutes }) : ''
          })) : ''}
        </div>`
      : '';

    // Where the delay came from: back to the last stop without delay (often several
    // trips earlier), with the places where it grew most. Not for a record that is
    // not a real delay (deadhead return, trip relink).
    const origin = run && run.origin && ep.verdict !== 'deadhead_return' && ep.verdict !== 'delay_jump' && ep.verdict !== 'backward_leg' && !ep.tripRelink ? run.origin : null;
    const originPlace = e => {
      const span = `${this.esc(hhmm(e.fromTime))}–${this.esc(hhmm(e.toTime))}, ${signed(e.fromDelay)} → ${signed(e.toDelay)} min`;
      if (e.kind === 'between') return this.t('dades.invOriginBetween', { prev: this.esc(e.previousStop), stop: this.esc(e.stopName), span });
      if (e.kind === 'turn') return this.t('dades.invOriginTurn', { prev: this.esc(e.previousStop), stop: this.esc(e.stopName), span });
      return this.t('dades.invOriginAt', { stop: this.esc(e.stopName), span });
    };
    const originNote = origin && (origin.tripsBefore > 0 || origin.events.length)
      ? `<div class="drilldown-callout drilldown-origin">
          <strong>${this.esc(this.t('dades.invOriginTitle'))}</strong>
          ${origin.onTime
            ? this.t('dades.invOriginLastOnTime', {
                time: this.esc(hhmm(origin.onTime.time)),
                stop: this.esc(origin.onTime.stopName),
                delay: signed(origin.onTime.delayMins),
                before: origin.tripsBefore > 0 ? this.esc(origin.tripsBefore === 1 ? this.t('dades.invOriginPrevTrip') : this.t('dades.invOriginTripsBefore', { n: origin.tripsBefore })) : ''
              })
            : this.esc(this.t('dades.invOriginFirstAvail', { time: hhmm(origin.since.time), delay: signed(origin.since.delayMins) }))}
          ${origin.tripsBefore > 0 ? this.esc(this.t('dades.invOriginCascade')) : ''}
          ${origin.events.length ? this.t('dades.invOriginGrew', { places: origin.events.map(originPlace).join('; ') }) : this.esc(this.t('dades.invOriginGradual'))}
          <button type="button" class="btn-secondary btn-sm drilldown-jump">${this.esc(this.t('dades.invOriginJump'))}</button>
        </div>`
      : '';

    // Evidence, localized. The server's English verdictLabel stays in the API
    // for other consumers; the panel shows its own wording keyed on ep.verdict.
    const verdicts = {
      corroborated: ['var(--accent-live)', this.t('dades.verdictCorroborated'), this.t('dades.verdictCorroboratedText')],
      derived_only: ['var(--accent-regulating)', this.t('dades.verdictDerived'), this.t('dades.verdictDerivedText')],
      poll_inflated: ['var(--accent-warning)', this.t('dades.verdictPoll'), this.t('dades.verdictPollText')],
      unverifiable: ['var(--accent-danger)', this.t('dades.verdictUnverifiable'), this.t('dades.verdictUnverifiableText')],
      telemetry_anomaly: ['var(--text-muted)', this.t('dades.verdictAnomaly'), this.t('dades.verdictAnomalyText')],
      trip_relink: ['var(--accent-warning)', this.t('dades.verdictRelink'), this.t('dades.verdictRelinkText')],
      delay_jump: ['var(--accent-warning)', this.t('dades.verdictJump'), this.t('dades.verdictJumpText')],
      deadhead_return: ['var(--accent-warning)', this.t('dades.verdictDeadhead'), this.t('dades.verdictDeadheadText')],
      backward_leg: ['var(--accent-warning)', this.t('dades.verdictBackward'), this.t('dades.verdictBackwardText')]
    };
    const [vTone, vTitle, vText] = verdicts[ep.verdict] || ['var(--text-primary)', this.t('dades.verdictNone'), ''];
    const busCell = Array.isArray(ep.distinctVehicles) && ep.distinctVehicles.length
      ? ep.distinctVehicles.map(v => `<span class="drilldown-bus-chip">${this.esc(v)}</span>`).join(' ')
      : ev.vehicleIdGapExplained
        ? `<span class="drilldown-fact-note">${this.esc(this.t('dades.invBusGapPre'))}</span>`
        : `<span style="color:var(--accent-danger);">${this.esc(this.t('dades.invBusNoId'))}</span>`;
    const keptHours = Number(ev.snapshotRetentionHours) || 2;
    const endTs = ep.tripKey && Number.isFinite(Number(ep.tripKey.endTs)) ? Number(ep.tripKey.endTs) : null;
    const olderThanKept = endTs !== null && (Date.now() - endTs) > keptHours * 3600 * 1000;
    const gpsCell = ev.snapshotTrailPoints >= 2
      ? `<span style="color:var(--accent-live);">${this.esc(this.t('dades.invGpsPoints', { n: ev.snapshotTrailPoints }))}</span>`
      : olderThanKept
        ? `<span>${this.esc(this.t('dades.invGpsExpired'))}</span><span class="drilldown-fact-note">${this.esc(this.t('dades.invGpsKept', { h: keptHours }))}</span>`
        : `<span style="color:var(--accent-warning);">${this.esc(this.t('dades.invGpsNone'))}</span>`;
    summary.innerHTML = `
      <dl class="drilldown-facts">
        <div class="drilldown-fact"><dt>${this.esc(this.t('dades.invDtVerdict'))}</dt><dd><strong style="color:${vTone};">${this.esc(vTitle)}</strong><span class="drilldown-fact-note">${this.esc(vText)}</span></dd></div>
        <div class="drilldown-fact"><dt>${this.esc(this.t('dades.invDtBus'))}</dt><dd>${busCell}</dd></div>
        ${ep.vehicleAmbiguous ? `<div class="drilldown-fact"><dt>${this.esc(this.t('dades.invDtWarn'))}</dt><dd style="color:var(--accent-warning);">${this.esc(this.t('dades.invAmbiguous'))}</dd></div>` : ''}
        <div class="drilldown-fact"><dt>${this.esc(this.t('dades.invDtSchedTime'))}</dt><dd>${this._timesProvenanceLabel(ep.timesProvenance || ev.timesProvenance)}</dd></div>
        <div class="drilldown-fact"><dt>${this.esc(this.t('dades.invDtGps'))}</dt><dd>${gpsCell}</dd></div>
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
            <span class="drilldown-trip-name">${this.esc(this.t(t.phantomKind === 'backward' ? 'dades.invBackwardTitle' : 'dades.invDeadheadTitle'))}</span>
            <span class="drilldown-trip-meta">${this.esc(hhmm(t.fromTime))}–${this.esc(hhmm(t.toTime))}</span>
            <span class="drilldown-trip-join">${this.esc(this.t(t.phantomKind === 'backward' ? 'dades.invTripBackwardDesc' : 'dades.invTripDeadheadDesc'))}</span>
          </th>
        </tr>`;
      }
      const delays = t.firstDelay === t.lastDelay ? `${signed(t.firstDelay)} min` : `${signed(t.firstDelay)} → ${signed(t.lastDelay)} min`;
      const join = t.joinedMidRoute
        ? `<span class="drilldown-trip-join">${this.esc(this.t('dades.invTripJoined', {
            n: t.joinedMidRoute.skippedCount,
            span: t.joinedMidRoute.firstSkipped ? ` (${t.joinedMidRoute.firstSkipped} → ${t.joinedMidRoute.lastSkipped})` : ''
          }))}</span>`
        : '';
      return `
        <tr class="drilldown-trip-row${t.isClickedTrip ? ' is-clicked-trip' : ''}">
          <th colspan="5" scope="colgroup">
            <span class="drilldown-trip-name">${this.esc(this.t(t.order > 0 ? 'dades.invTripNew' : 'dades.invTripFirst'))}${t.towards ? this.esc(this.t('dades.invTripTowards', { dest: t.towards })) : ''}</span>
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
          <td class="drilldown-cell-time"${s.lastTime && s.lastTime !== s.time ? ` title="${this.esc(this.t('dades.invFirstRegTip', { time: hhmm(s.time) }))}"` : ''}>${this.esc(hhmm(s.lastTime || s.time))}</td>
          <td class="drilldown-cell-delay"><span class="drilldown-delay ${delayClass}">${signed(s.delayMins)} min</span>${s.delayGrowth ? ` <span class="drilldown-growth" title="${this.esc(this.t('dades.invGrowthTip', { n: s.delayGrowth }))}">▲${s.delayGrowth}</span>` : ''}</td>
          <td class="drilldown-cell-stop">${this.esc(s.stopName || '—')}${s.isClicked ? ` <span class="drilldown-clicked-tag">${this.esc(this.t('dades.invTagClicked'))}</span>` : ''}${s.originStart ? ` <span class="drilldown-origin-tag">${this.esc(this.t('dades.invTagOrigin'))}</span>` : ''}</td>
          <td class="drilldown-cell-times">${times}</td>
          <td class="drilldown-cell-src">${this.esc(this.t(s.isRealTime ? 'dades.sigGps' : 'dades.sigEst'))}</td>
        </tr>`;
    }).join('');
    const tripLink = this._matchIncidentTrip(ep);
    const clicked = runRows.find(s => s.isClicked) || null;
    const ctxDetail = ep.verdict === 'deadhead_return'
      ? this.t('dades.invContextDeadhead', { d: signed(ep.peakDelayMins) })
      : ep.verdict === 'delay_jump'
        ? this.t('dades.invContextJump', { d: signed(ep.peakDelayMins) })
        : ep.verdict === 'backward_leg'
          ? this.t('dades.invContextBackward', { d: signed(ep.peakDelayMins) })
          : this.t('dades.invContextMax', { d: signed(ep.peakDelayMins) });
    content.innerHTML = `
      <div class="drilldown-headline" style="--tone:${headline.tone};">
        <div class="drilldown-headline-title">${headline.title}</div>
        <p class="drilldown-headline-text">${headline.text}</p>
      </div>
      ${originNote}
      ${shortTurnNote}
      ${deadheadNote}
      <p class="drilldown-context">
        ${this.t('dades.invContextStop', {
          stop: this.esc(clicked ? clicked.stopName : (data.stopName || stopName)),
          at: clicked && clicked.time ? this.esc(this.t('dades.invContextAt', { time: hhmm(clicked.time) })) : '',
          detail: this.esc(ctxDetail),
          below: run ? this.esc(this.t('dades.invContextBelow', { from: hhmm(runRows[0].time), to: hhmm(runRows[runRows.length - 1].time) })) : ''
        })}
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
          <tbody>${rowsHtml || `<tr><td colspan="5" style="color:var(--text-muted);">${this.esc(this.t('dades.invNoRows'))}</td></tr>`}</tbody>
        </table>
      </div>
      <p class="drilldown-legend">${this.esc(this.t('dades.invLegend'))}</p>
    `;
    const thKeys = ['dades.invColPass', 'dades.invColDelay', 'dades.invColStop', 'dades.invColTimes', 'dades.invColSignal'];
    content.querySelectorAll('.drilldown-samples-table thead th[scope="col"]').forEach((th, idx) => {
      if (thKeys[idx]) th.textContent = this.t(thKeys[idx]);
    });
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
      return `<span class="drilldown-trip-stop${st.isRecovered ? ' is-recovered' : ''}" title="${this.esc(st.stopName)}${d != null ? ` (${this.esc(this.t(st.isRecovered ? 'dades.matchTripRecovered' : 'dades.matchTripDelay'))}: +${d} min)` : ''}">${this.esc(st.stopName)}${badge}</span>${i < arr.length - 1 ? '<span class="drilldown-trip-arrow">→</span>' : ''}`;
    }).join('');

    const endClock = this._clockOf(match.endMomentTs);
    const metaText = window.ArriboI18n
      ? this.t('dades.matchTripMeta', {
        line: match.lineCode || '',
        bus: match.vehicleId,
        start: match.startTime || '',
        end: endClock ? this.t('dades.matchTripEnd', { time: endClock }) : '',
        n: match.sampleCount || 0
      })
      : `${match.lineCode || ''} · bus ${match.vehicleId} · inici ${match.startTime || ''}${endClock ? ` · fi ${endClock}` : ''} · ${match.sampleCount || 0} mostres`;
    return `
      <div class="drilldown-trip-card">
        <div class="drilldown-trip-head">
          <span class="drilldown-trip-label">${this.esc(this.t('dades.matchTripLabel'))}</span>
          <span class="drilldown-trip-meta">${this.esc(metaText)}</span>
        </div>
        <div class="drilldown-trip-flow">${flow || `<span style="color:var(--text-muted);">${this.esc(this.t('dades.matchTripNoStops'))}</span>`}</div>
        ${this._trajectoryOutcome(match) ? `<p class="drilldown-trip-outcome">${this._trajectoryOutcome(match)}</p>` : ''}
        <button type="button" class="btn-locate-incident-stop" data-incident-tab="trips" title="${this.esc(this.t('dades.matchTripBtnTitle'))}">
          <span>${this.esc(this.t('dades.matchTripBtn'))}</span>
        </button>
      </div>`;
  }

  /** HH:MM (Madrid) of an epoch-ms timestamp, '' when it is not one. */
  _clockOf(ts) {
    const n = Number(ts);
    return Number.isFinite(n) && n > 0
      ? new Date(n).toLocaleTimeString(this.locale(), { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
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
    const rawStop = t.endStop || t.lastStop || '';
    const stop = this.esc(rawStop);
    const end = this._clockOf(t.endMomentTs);
    const next = t.nextTrip && Number.isFinite(Number(t.nextTrip.ts)) ? t.nextTrip : null;
    const atEnd = end ? this.esc(this.t('dades.invContextAt', { time: end })) : '';
    switch (t.endReason) {
      case 'recovered':
        return this.t('dades.outRecovered', { stop, at: atEnd, delay: sg(t.endDelayMins) });
      case 'trip_change': {
        const gap = next && Number.isFinite(Number(t.endMomentTs)) ? Math.round((Number(next.ts) - Number(t.endMomentTs)) / 60000) : null;
        return this.t('dades.outTripChange', {
          after: this._afterStop(rawStop),
          at: end ? ` (${end}, ${sg(t.endDelayMins)} min)` : '',
          gap: gap !== null && gap >= 2 ? this.esc(this.t('dades.outTripChangeGap', { n: gap })) : '',
          next: next ? this.t('dades.outTripChangeNext', { stop: this.esc(next.stopName), time: this._clockOf(next.ts), delay: sg(next.delayMins) }) : ''
        });
      }
      case 'end_of_line':
        return this.t('dades.outEndOfLine', {
          stop,
          at: atEnd,
          delay: sg(t.endDelayMins),
          next: next ? this.t('dades.outEndOfLineNext', { time: this._clockOf(next.ts), stop: this.esc(next.stopName), delay: sg(next.delayMins) }) : ''
        });
      case 'signal_lost':
        return this.t('dades.outSignalLost', { end: end || '--:--', stop, delay: sg(t.endDelayMins) });
      case 'ongoing':
        return this.esc(this.t('dades.outOngoing'));
      case 'relinked':
        return this.esc(this.t('dades.outRelinked'));
      case 'deadhead_return':
        return this.esc(this.t('dades.outDeadhead'));
      case 'backward_leg':
        return this.t('dades.outBackward', { stop, at: atEnd });
      default:
        return '';
    }
  }

  /**
   * "Per què el retard desapareix després?": a bus that joins its next trip mid-route has no
   * records for that trip's first stops. That alone does not say why: a short-turn, a GPS
   * signal loss that made the operator's system reassign the bus, and a stalled operator
   * feed all look the same. The server checks the silence between the two trips
   * (joinedMidRoute.evidence) and this says only what that found.
   */
  _shortTurnNote(trip, firstStop) {
    const j = trip.joinedMidRoute;
    const ev = j.evidence || { signal: 'unknown', gaps: [], snapshots: 0 };
    const skipped = this.t('dades.stSkipped', {
      n: j.skippedCount,
      span: j.firstSkipped ? ` (${this.esc(j.firstSkipped)} → ${this.esc(j.lastSkipped)})` : ''
    });
    const range = this._clockOf(ev.fromTs) && this._clockOf(ev.toTs)
      ? this.t('dades.stRangeBetween', { from: this._clockOf(ev.fromTs), to: this._clockOf(ev.toTs) })
      : this.t('dades.stRangeFallback');
    const gap = (ev.gaps || []).find(g => !g.feedWide && !g.atTerminal) || (ev.gaps || [])[0];
    let why;
    switch (ev.signal) {
      case 'lost':
        why = this.t('dades.stWhyLost', {
          range: this.esc(range),
          gap: gap ? ` (${gap.gapSec} s${gap.stopName ? this.t('dades.stWhyLostNear', { stop: this.esc(gap.stopName) }) : ''})` : ''
        });
        break;
      case 'feed_stalled':
        why = this.esc(this.t('dades.stWhyStalled', { rangeCap: `${range.charAt(0).toUpperCase()}${range.slice(1)}` }));
        break;
      case 'terminal':
        why = this.esc(this.t('dades.stWhyTerminal', { range }));
        break;
      case 'kept':
        why = this.esc(this.t('dades.stWhyKept', { range, n: ev.snapshots }));
        break;
      default:
        why = this.esc(this.t('dades.stWhyUnknown'));
    }
    return `<div class="drilldown-callout">
            <strong>${this.esc(this.t('dades.stTitle'))}</strong>
            ${this.t('dades.stIntro', {
              towards: trip.towards ? this.esc(this.t('dades.invTripTowards', { dest: trip.towards })) : '',
              stop: this.esc(firstStop)
            })} ${skipped}
            ${why}
          </div>`;
  }

  /** Localized label for the server-side times_provenance classification. */
  _timesProvenanceLabel(provenance) {
    switch (provenance) {
      case 'observed': return `<span style="color:var(--accent-live);">${this.esc(this.t('dades.provObserved'))}</span>`;
      case 'derived_timetable': return `<span style="color:var(--text-secondary);">${this.esc(this.t('dades.provDerived'))}</span>`;
      case 'derived_timetable_backfill': return `<span style="color:var(--accent-warning);">${this.esc(this.t('dades.provBackfill'))}</span>`;
      case 'mixed': return `<span style="color:var(--text-secondary);">${this.esc(this.t('dades.provMixed'))}</span>`;
      default: return `<span style="color:var(--text-muted);">${this.esc(this.t('dades.provNone'))}</span>`;
    }
  }

  _renderIncidentDataQualityBanner(s) {
    const q = s.dataQuality || {};
    if (!q.totalRawRows && !q.rowsWithoutVehicleId) return '';
    return `
      <div style="background:rgba(251,191,36,0.07); border:1px solid rgba(251,191,36,0.25); border-radius:12px; padding:0.85rem 1rem; margin-bottom:1.25rem;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:0.75rem; flex-wrap:wrap;">
          <div>
            <div style="font-size:0.78rem; font-weight:800; color:var(--accent-warning);">${this.esc(this.t('dades.dqTitle'))}</div>
            <div style="font-size:0.76rem; color:var(--text-secondary); margin-top:0.2rem; line-height:1.5;">
              ${this.t('dades.dqBody', {
                raw: this.esc(this._fmtCount(s.rawSamplesOverThreshold ?? s.totalRecordedIncidents)),
                worst: s.worstBasis === 'visits' ? this.t('dades.dqWorstVisits') : '',
                listed: s.listedCommercialEpisodes !== undefined ? this.esc(this.t('dades.dqListed', { n: this._fmtCount(s.listedCommercialEpisodes), limit: s.commercialEpisodeLimit })) : ''
              })}
            </div>
            <div style="font-size:0.76rem; color:var(--text-secondary); margin-top:0.35rem; line-height:1.5;">
              ${q.episodesNote ? this.esc(q.episodesNote) : ''}
            </div>
            ${(s.nonRealtimeSampleCount || 0) > 0 ? `
              <div style="font-size:0.76rem; color:var(--text-secondary); margin-top:0.35rem; line-height:1.5;">
                ${this.t('dades.dqNonRt', { n: this.esc(this._fmtCount(s.nonRealtimeSampleCount)), pct: this.esc(s.nonRealtimeSamplePct) })}
              </div>
            ` : ''}
          </div>
          <div style="font-size:0.74rem; color:var(--text-muted); text-align:right;">
            ${this.esc(this.t('dades.dqRawCount', { n: this._fmtCount(q.totalRawRows) }))}<br>
            ${this.esc(this.t('dades.dqNoVeh', { n: this._fmtCount(q.rowsWithoutVehicleId) }))}<br>
            ${this.esc(this.t('dades.dqNoProv', { n: this._fmtCount(q.rowsWithoutProvenance) }))}<br>
            ${this.esc(this.t('dades.dqEpisodes', { n: this._fmtCount(q.distinctEpisodes), gap: q.episodeGapMinutes ? this.t('dades.dqGapMin', { m: q.episodeGapMinutes }) : '' }))}
          </div>
        </div>
      </div>
    `;
  }

  _fmtCount(n) {
    return (Number(n) || 0).toLocaleString(this.locale());
  }

  renderIncidentErrorState(container, lineCode, hours, viewMode) {
    container.innerHTML = `
      <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:12px; padding:2.5rem 1.5rem; text-align:center; color:var(--text-muted); max-width:540px; margin:2rem auto;">
        <div style="font-size:2rem; margin-bottom:0.6rem;">⏱️</div>
        <div style="font-weight:700; font-size:1.05rem; color:var(--text-primary); margin-bottom:0.4rem;">${this.esc(this.t('dades.incErrTitle', { h: hours }))}</div>
        <p style="font-size:0.82rem; margin:0 0 1.25rem 0; line-height:1.45;">
          ${this.esc(this.t('dades.incErrText'))}
        </p>
        <button type="button" class="btn-primary" id="btn-retry-incidents-tab">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          <span>${this.esc(this.t('dades.incErrRetry'))}</span>
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
      return `<span class="bus-id-badge" title="${this.esc(this.t('dades.incVehBadgeTitle', { id: vehicleId }))}">[ #${this.esc(clean)} ]</span>`;
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
      ? (trueMaxDelay === null ? this.t('dades.incCommMaxEmpty') : this.t('dades.incCommMaxUnmeasured'))
      : `+${commercialMax} min`;
    const maxDelayValue = trueMaxDelay === null
      ? '—'
      : `${trueMaxDelay > 0 ? '+' : ''}${trueMaxDelay} min`;
    const minThr = s.minDelayThreshold || 5;
    const worstUnit = s.worstBasis === 'visits'
      ? this.t(s.worstStopCount === 1 ? 'dades.incVisitOne' : 'dades.incVisitMany')
      : this.t(s.worstStopCount === 1 ? 'dades.incRawOne' : 'dades.incRawMany');
    const worstStopLabel = s.worstStop || this.t('dades.incNone');

    container.innerHTML = `
      <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:1.1rem; margin-bottom:1.25rem;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:0.75rem;">
          <div>
            <span style="font-size:0.75rem; font-weight:800; color:var(--accent-scheduled); text-transform:uppercase; letter-spacing:0.5px;">${this.esc(this.t('dades.incEyebrow'))}</span>
            <h3 style="font-size:1.35rem; font-weight:800; color:var(--text-primary); margin:0.2rem 0;">${this.esc(this.t('dades.incTitle'))}</h3>
            <p style="font-size:0.78rem; color:var(--text-muted); margin:0; max-width:740px; line-height:1.45;">
              ${this.esc(this.t('dades.incIntro', { min: minThr }))}
            </p>
          </div>
        </div>

        <!-- Filter Controls Row -->
        <div class="incident-filters">
          <!-- Timeframe selector -->
          <div class="incident-filter-row">
            <span class="incident-filter-label">${this.esc(this.t('dades.incFilterPeriod'))}</span>
            <div class="incident-filter-options incident-filter-options--period">
              <button type="button" class="incident-filter-pill ${Number(selectedHours) === 24 ? 'active' : ''}" data-incident-hours="24">${this.esc(this.t('dades.incPeriod24h'))}</button>
              <button type="button" class="incident-filter-pill ${Number(selectedHours) === 48 ? 'active' : ''}" data-incident-hours="48">${this.esc(this.t('dades.incPeriod48h'))}</button>
              <button type="button" class="incident-filter-pill ${Number(selectedHours) === 168 ? 'active' : ''}" data-incident-hours="168">${this.esc(this.t('dades.incPeriod7d'))}</button>
            </div>
          </div>

          <!-- Line selector -->
          <div class="incident-filter-row">
            <span class="incident-filter-label">${this.esc(this.t('dades.incFilterLine'))}</span>
            <div class="incident-filter-options incident-filter-options--lines">
              <button type="button" class="incident-filter-pill ${activeLineNorm === 'ALL' ? 'active' : ''}" data-incident-line="all">${this.esc(this.t('dades.incAllLines'))}</button>
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
          <div style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase;">${this.esc(this.t('dades.incKpiMax'))}</div>
          <div style="font-size:1.6rem; font-weight:800; color:${trueMaxDelay === null ? 'var(--text-muted)' : 'var(--accent-danger)'}; margin-top:0.2rem;">${maxDelayValue}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${this.esc(this.t('dades.incKpiMaxSub', { raw: this._fmtCount(s.rawSamplesOverThreshold ?? s.totalRecordedIncidents), min: minThr, ep: topList.length }))}</div>
          ${maxFromInvestigation ? `
            <div style="font-size:0.72rem; color:var(--accent-danger); margin-top:0.2rem; line-height:1.4;">
              ${this.esc(this.t('dades.incKpiMaxInvNote', { min: minThr }))}
            </div>
          ` : `
            <div style="font-size:0.72rem; color:var(--text-muted); margin-top:0.2rem;">${this.esc(this.t('dades.incKpiMaxCommNote', { min: minThr, cap: commercialMaxCaption, inv: investigationList.length }))}</div>
          `}
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:0.9rem;">
          <div style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase;">${this.esc(this.t('dades.incKpiWorstStop'))}</div>
          <div style="font-size:1.05rem; font-weight:700; color:var(--brand-primary); margin-top:0.25rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${this.esc(worstStopLabel)}">${this.esc(worstStopLabel)}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${this.esc(this.t('dades.incKpiWorstStopSub', { n: this._fmtCount(s.worstStopCount || 0), unit: worstUnit, min: minThr }))}</div>
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:0.9rem;">
          <div style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase;">${this.esc(this.t('dades.incKpiWorstHour'))}</div>
          <div style="font-size:1.15rem; font-weight:700; color:var(--accent-warning); margin-top:0.25rem;">${s.worstHour || '--:00'}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${s.worstHourLatePct !== null && s.worstHourLatePct !== undefined ? this.esc(this.t('dades.incKpiWorstHourPct', { pct: s.worstHourLatePct, min: minThr })) : ''}${this.esc(s.worstHourTag || this.t('dades.incRegularSched'))}</div>
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:0.9rem;">
          <div style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase;">${this.esc(this.t('dades.incKpiUnusual'))}</div>
          <div style="font-size:1.15rem; font-weight:700; color:var(--accent-danger); margin-top:0.25rem;">${this.esc(this.t('dades.incInInvCount', { n: investigationList.length }))}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${this.esc(this.t('dades.incAnomaliesCount', { n: anomaliesList.length }))}</div>
        </div>
      </div>

      <!-- Sub-Tab Mode Switcher -->
      <div class="incident-view-mode-tabs-container" role="tablist" aria-label="${this.esc(this.t('dades.incTabAria'))}">
        <button type="button" class="incident-view-mode-tab ${activeTab === 'top' ? 'active' : ''}" data-incident-tab="top" role="tab" aria-selected="${activeTab === 'top'}">
          <span><span class="incident-tab-title">${this.esc(this.t('dades.incTabTop'))}</span> <span class="incident-tab-meta">(${minThr}–24 min) (${topList.length})</span></span>
        </button>
        <button type="button" class="incident-view-mode-tab ${activeTab === 'investigation' ? 'active' : ''}" data-incident-tab="investigation" role="tab" aria-selected="${activeTab === 'investigation'}">
          <span><span class="incident-tab-title">${this.esc(this.t('dades.incTabInv'))}</span> <span class="incident-tab-meta">(&ge; 25 min) (${investigationList.length})</span></span>
        </button>
        <button type="button" class="incident-view-mode-tab ${activeTab === 'trips' ? 'active' : ''}" data-incident-tab="trips" role="tab" aria-selected="${activeTab === 'trips'}">
          <span><span class="incident-tab-title">${this.esc(this.t('dades.incTabTrips'))}</span> <span class="incident-tab-meta">(${tripsList.length})</span></span>
        </button>
      </div>

      <!-- View Content Partition -->
      ${activeTab === 'top' ? `
        <!-- Table 1: Top Delays Table (Peak per Trip 0-24m) -->
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px; margin-bottom:0.6rem;">
          <div style="font-size:0.78rem; color:var(--text-muted); display:flex; align-items:center; gap:6px;">
            <span>${this.esc(this.t('dades.incTopNote', { min: minThr }))}</span>
          </div>
          ${investigationList.length > 0 ? `
            <div style="font-size:0.75rem; color:var(--accent-danger); font-weight:700;">
              ${this.esc(this.t('dades.incTopMoved', { n: investigationList.length }))}
            </div>
          ` : ''}
        </div>

        ${topList.length === 0 ? `
          <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:10px; padding:2rem; text-align:center; color:var(--text-muted);">
            ${this.esc(this.t('dades.incTopEmpty', { min: minThr, h: selectedHours }))}
          </div>
        ` : `
          <div class="observatori-table-wrapper">
            <table class="observatori-table">
              <thead>
                <tr>
                  <th style="width:45px; text-align:center;">#</th>
                  <th>${this.esc(this.t('dades.incColDelay'))}</th>
                  <th>${this.esc(this.t('dades.colLine'))}</th>
                  <th>${this.esc(this.t('dades.incColStop'))}</th>
                  <th>${this.esc(this.t('dades.incColDateTime'))}</th>
                  <th>${this.esc(this.t('dades.incColContext'))}</th>
                  <th style="text-align:center; cursor:help;" title="${this.esc(this.t('dades.incColSignalTip'))}">${this.esc(this.t('dades.incColSignal'))}</th>
                  <th style="text-align:center;">${this.esc(this.t('dades.incColMap'))}</th>
                </tr>
              </thead>
              <tbody>
                ${topList.map((inc, i) => {
                  const lColor = getLineColor(inc.lineCode);
                  const delayClass = inc.delayMins >= 20 ? 'var(--accent-danger)' : (inc.delayMins >= 10 ? 'var(--accent-warning)' : 'var(--accent-scheduled)');
                  const signalTooltip = inc.isRealTime
                    ? this.t('dades.incSigTipGps')
                    : this.t('dades.incSigTipEst');
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
                          <span>${this.esc(this.t(inc.isRealTime ? 'dades.sigGps' : 'dades.sigEst'))}</span>
                        </span>
                      </td>
                      <td style="text-align:center; white-space:nowrap;">
                        <button type="button" class="btn-locate-incident-stop" data-locate-line="${this.esc(inc.lineCode)}" data-locate-stop="${this.esc(inc.stopName)}" data-locate-stop-id="${this.esc(inc.stopId || '')}" title="${this.esc(this.t('dades.incLocateTip'))}">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
                          <span>${this.esc(this.t('dades.incBtnMap'))}</span>
                        </button>
                        <button type="button" class="btn-investigate-incident" data-investigate-line="${this.esc(inc.lineCode)}" data-investigate-stop="${this.esc(inc.stopName)}" data-investigate-vehicle="${this.esc(inc.vehicleId || '')}" data-investigate-at="${inc.timestamp || ''}" title="${this.esc(this.t('dades.incBtnInvTip'))}">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                          <span>${this.esc(this.t('dades.incBtnInv'))}</span>
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
              <h3 class="drilldown-title">${this.esc(this.t('dades.invPanelTitle'))}</h3>
              <div id="drilldown-content">${this.esc(this.t('dades.invPanelPrompt'))}</div>
            </div>
            <aside class="drilldown-aside" aria-label="${this.esc(this.t('dades.invAsideAria'))}">
              <h4 class="drilldown-aside-title">${this.esc(this.t('dades.invAsideTitle'))}</h4>
              <div id="drilldown-summary"></div>
            </aside>
          </div>
        </div>

        <!-- Table 2: Dedicated Table for Non-Normal Schedules Under Investigation (>= 25 min) -->
        <div style="margin-top:2.5rem; border-top:2px solid rgba(244, 63, 94, 0.35); padding-top:1.5rem;" id="section-investigation-incidents">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:0.75rem; margin-bottom:0.85rem;">
            <div>
              <div style="display:inline-flex; align-items:center; gap:6px; background:rgba(244, 63, 94, 0.15); color:var(--accent-danger); padding:3px 8px; border-radius:6px; font-size:0.72rem; font-weight:800; text-transform:uppercase; letter-spacing:0.4px;">
                <span>${this.esc(this.t('dades.incInvBadge'))}</span>
              </div>
              <h4 style="font-size:1.15rem; font-weight:800; color:var(--text-primary); margin:0.35rem 0 0.2rem 0;">
                ${this.esc(this.t('dades.incInvTitle', { n: investigationList.length }))}
              </h4>
              <p style="font-size:0.78rem; color:var(--text-muted); margin:0; max-width:760px; line-height:1.45;">
                ${this.t('dades.incInvDesc')}
              </p>
            </div>
            ${investigationList.length > 0 ? `
              <button type="button" class="btn-report-action btn-report-investigation" id="btn-copy-investigation-report" title="${this.esc(this.t('dades.incInvCopyTip'))}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                <span>${this.esc(this.t('dades.incInvCopyBtn'))}</span>
              </button>
            ` : ''}
          </div>

          ${investigationList.length === 0 ? `
            <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:10px; padding:1.5rem; text-align:center; color:var(--text-muted); font-size:0.85rem;">
              ${this.esc(this.t('dades.incInvEmpty', { h: selectedHours }))}
            </div>
          ` : `
            <div class="observatori-table-wrapper">
              <table class="observatori-table">
                <thead>
                  <tr>
                    <th style="width:45px; text-align:center;">#</th>
                    <th>${this.esc(this.t('dades.incColDelaySent'))}</th>
                    <th>${this.esc(this.t('dades.colLine'))}</th>
                    <th>${this.esc(this.t('dades.incColStop'))}</th>
                    <th>${this.esc(this.t('dades.incColDateTime'))}</th>
                    <th>${this.esc(this.t('dades.incColStatus'))}</th>
                    <th style="text-align:center; cursor:help;" title="${this.esc(this.t('dades.incColSignalTip'))}">${this.esc(this.t('dades.incColSignal'))}</th>
                    <th style="text-align:center;">${this.esc(this.t('dades.incColMap'))}</th>
                  </tr>
                </thead>
                <tbody>
                  ${investigationList.map((inc, i) => {
                    const lColor = getLineColor(inc.lineCode);
                    const signalTooltip = inc.isRealTime
                      ? this.t('dades.incSigTipGps')
                      : this.t('dades.incSigTipEstShort');
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
                            ${this.esc(this.t('dades.incStatusPending'))}
                          </span>
                        </td>
                        <td style="text-align:center; white-space:nowrap;">
                          <span class="signal-badge ${inc.isRealTime ? 'gps' : 'estimated'}" title="${this.esc(signalTooltip)}">
                            <span class="dot"></span>
                            <span>${this.esc(this.t(inc.isRealTime ? 'dades.sigGps' : 'dades.sigEst'))}</span>
                          </span>
                        </td>
                        <td style="text-align:center; white-space:nowrap;">
                          <button type="button" class="btn-locate-incident-stop" data-locate-line="${this.esc(inc.lineCode)}" data-locate-stop="${this.esc(inc.stopName)}" data-locate-stop-id="${this.esc(inc.stopId || '')}" title="${this.esc(this.t('dades.incLocateTip'))}">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
                            <span>${this.esc(this.t('dades.incBtnMap'))}</span>
                          </button>
                          <button type="button" class="btn-investigate-incident" data-investigate-line="${this.esc(inc.lineCode)}" data-investigate-stop="${this.esc(inc.stopName)}" data-investigate-vehicle="${this.esc(inc.vehicleId || '')}" data-investigate-at="${inc.timestamp || ''}" title="${this.esc(this.t('dades.incBtnInvTip'))}">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                            <span>${this.esc(this.t('dades.incBtnInv'))}</span>
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
                <span>${this.esc(this.t('dades.incAnomBadge'))}</span>
              </div>
              <h4 style="font-size:1.15rem; font-weight:800; color:var(--text-primary); margin:0.35rem 0 0.2rem 0;">
                ${this.esc(this.t('dades.incAnomTitle', { n: anomaliesList.length }))}
              </h4>
              <p style="font-size:0.78rem; color:var(--text-muted); margin:0; max-width:740px; line-height:1.45;">
                ${this.t('dades.incAnomDesc')}
              </p>
            </div>
            ${anomaliesList.length > 0 ? `
              <button type="button" class="btn-report-action btn-report-anomalies btn-copy-anomalies" id="btn-copy-anomalies-report" title="${this.esc(this.t('dades.incAnomCopyTip'))}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                <span>${this.esc(this.t('dades.incAnomCopyBtn'))}</span>
              </button>
            ` : ''}
          </div>

          ${anomaliesList.length === 0 ? `
            <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:10px; padding:1.5rem; text-align:center; color:var(--text-muted); font-size:0.85rem;">
              ${this.esc(this.t('dades.incAnomEmpty', { h: selectedHours }))}
            </div>
          ` : `
            <div class="observatori-table-wrapper">
              <table class="observatori-table">
                <thead>
                  <tr>
                    <th style="width:45px; text-align:center;">#</th>
                    <th>${this.esc(this.t('dades.incColDelaySent'))}</th>
                    <th>${this.esc(this.t('dades.colLine'))}</th>
                    <th>${this.esc(this.t('dades.incColStopPoint'))}</th>
                    <th>${this.esc(this.t('dades.incColDateTime'))}</th>
                    <th>${this.esc(this.t('dades.incColDiag'))}</th>
                    <th style="text-align:center; cursor:help;" title="${this.esc(this.t('dades.incColSignalTip'))}">${this.esc(this.t('dades.incColSignal'))}</th>
                    <th style="text-align:center;">${this.esc(this.t('dades.incColMap'))}</th>
                  </tr>
                </thead>
                <tbody>
                  ${anomaliesList.map((inc, i) => {
                    const lColor = getLineColor(inc.lineCode);
                    const isStartup = inc.anomalyType === 'startup_sae';
                    const isRelink = inc.anomalyType === 'trip_relink' || inc.anomalyType === 'deadhead_return' || inc.anomalyType === 'delay_jump' || inc.anomalyType === 'backward_leg';
                    const isMaintenance = inc.anomalyType === 'maintenance' || (!isStartup && !isRelink);
                    const badgeBg = (isStartup || isRelink) ? 'rgba(245, 158, 11, 0.15)' : 'rgba(147, 51, 234, 0.15)';
                    const badgeColor = (isStartup || isRelink) ? 'var(--accent-warning)' : 'var(--accent-regulating)';
                    const signalTooltip = inc.isRealTime
                      ? this.t('dades.incSigTipGpsShort')
                      : this.t('dades.incSigTipEstShort');
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
                            <span style="color:var(--text-muted); font-size:0.85rem;" title="${this.esc(this.t('dades.incMaintNoStopTip'))}">—</span>
                          ` : `
                            ${this.esc(inc.stopName)}
                          `}
                        </td>
                        <td style="color:var(--text-secondary); white-space:nowrap; font-size:0.8rem;">
                          ${this.esc(inc.formattedDate || '')}
                        </td>
                        <td style="white-space:nowrap; font-size:0.78rem;">
                          <span style="background:${badgeBg}; color:${badgeColor}; padding:0.2rem 0.5rem; border-radius:6px; font-weight:700; font-size:0.72rem; display:inline-flex; align-items:center; gap:4px;">
                            ${this.esc(inc.diagnosticBadge || inc.trafficTag || this.t('dades.incAnomFallback'))}
                          </span>
                        </td>
                        <td style="text-align:center; white-space:nowrap;">
                          <span class="signal-badge ${inc.isRealTime ? 'gps' : 'estimated'}" title="${this.esc(signalTooltip)}">
                            <span class="dot"></span>
                            <span>${this.esc(this.t(inc.isRealTime ? 'dades.sigGps' : 'dades.sigEst'))}</span>
                          </span>
                        </td>
                        <td style="text-align:center; white-space:nowrap;">
                          ${isMaintenance ? `
                            <span style="color:var(--text-muted); font-size:0.85rem;" title="${this.esc(this.t('dades.incMaintNaTip'))}">—</span>
                          ` : `
                            <button type="button" class="btn-locate-incident-stop" data-locate-line="${this.esc(inc.lineCode)}" data-locate-stop="${this.esc(inc.stopName)}" data-locate-stop-id="${this.esc(inc.stopId || '')}" title="${this.esc(this.t('dades.incLocateTip'))}">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
                              <span>${this.esc(this.t('dades.incBtnMap'))}</span>
                            </button>
                            <button type="button" class="btn-investigate-incident" data-investigate-line="${this.esc(inc.lineCode)}" data-investigate-stop="${this.esc(inc.stopName)}" data-investigate-vehicle="${this.esc(inc.vehicleId || '')}" data-investigate-at="${inc.timestamp || ''}" title="${this.esc(this.t('dades.incBtnInvTip'))}">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                              <span>${this.esc(this.t('dades.incBtnInv'))}</span>
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
                <span>${this.esc(this.t('dades.incInvBadge'))}</span>
              </div>
              <h4 style="font-size:1.25rem; font-weight:800; color:var(--text-primary); margin:0.35rem 0 0.2rem 0;">
                ${this.esc(this.t('dades.incInvTitle', { n: investigationList.length }))}
              </h4>
              <p style="font-size:0.8rem; color:var(--text-muted); margin:0; max-width:760px; line-height:1.45;">
                ${this.t('dades.incInvDesc')}
              </p>
            </div>
            ${investigationList.length > 0 ? `
              <button type="button" class="btn-report-action btn-report-investigation" id="btn-copy-investigation-report" title="${this.esc(this.t('dades.incInvCopyTip'))}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                <span>${this.esc(this.t('dades.incInvCopyBtn'))}</span>
              </button>
            ` : ''}
          </div>

          ${investigationList.length === 0 ? `
            <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:10px; padding:2rem; text-align:center; color:var(--text-muted); font-size:0.85rem;">
              ${this.esc(this.t('dades.incInvEmpty', { h: selectedHours }))}
            </div>
          ` : `
            <div class="observatori-table-wrapper">
              <table class="observatori-table">
                <thead>
                  <tr>
                    <th style="width:45px; text-align:center;">#</th>
                    <th>${this.esc(this.t('dades.incColDelaySent'))}</th>
                    <th>${this.esc(this.t('dades.colLine'))}</th>
                    <th>${this.esc(this.t('dades.incColStop'))}</th>
                    <th>${this.esc(this.t('dades.incColDateTime'))}</th>
                    <th>${this.esc(this.t('dades.incColStatus'))}</th>
                    <th style="text-align:center; cursor:help;" title="${this.esc(this.t('dades.incColSignalTip'))}">${this.esc(this.t('dades.incColSignal'))}</th>
                    <th style="text-align:center;">${this.esc(this.t('dades.incColMap'))}</th>
                  </tr>
                </thead>
                <tbody>
                  ${investigationList.map((inc, i) => {
                    const lColor = getLineColor(inc.lineCode);
                    const signalTooltip = inc.isRealTime
                      ? this.t('dades.incSigTipGpsShort')
                      : this.t('dades.incSigTipEstShort');
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
                            ${this.esc(this.t('dades.incStatusPending'))}
                          </span>
                        </td>
                        <td style="text-align:center; white-space:nowrap;">
                          <span class="signal-badge ${inc.isRealTime ? 'gps' : 'estimated'}" title="${this.esc(signalTooltip)}">
                            <span class="dot"></span>
                            <span>${this.esc(this.t(inc.isRealTime ? 'dades.sigGps' : 'dades.sigEst'))}</span>
                          </span>
                        </td>
                        <td style="text-align:center; white-space:nowrap;">
                          <button type="button" class="btn-locate-incident-stop" data-locate-line="${this.esc(inc.lineCode)}" data-locate-stop="${this.esc(inc.stopName)}" data-locate-stop-id="${this.esc(inc.stopId || '')}" title="${this.esc(this.t('dades.incLocateTip'))}">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
                            <span>${this.esc(this.t('dades.incBtnMap'))}</span>
                          </button>
                          <button type="button" class="btn-investigate-incident" data-investigate-line="${this.esc(inc.lineCode)}" data-investigate-stop="${this.esc(inc.stopName)}" data-investigate-vehicle="${this.esc(inc.vehicleId || '')}" data-investigate-at="${inc.timestamp || ''}" title="${this.esc(this.t('dades.incBtnInvTip'))}">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                            <span>${this.esc(this.t('dades.incBtnInv'))}</span>
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
              <h3 class="drilldown-title">${this.esc(this.t('dades.invPanelTitle'))}</h3>
              <div id="drilldown-content">${this.esc(this.t('dades.invPanelPrompt'))}</div>
            </div>
            <aside class="drilldown-aside" aria-label="${this.esc(this.t('dades.invAsideAria'))}">
              <h4 class="drilldown-aside-title">${this.esc(this.t('dades.invAsideTitle'))}</h4>
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
                ${this.esc(this.t('dades.incTripsHowTitle'))}
              </div>
              <div style="color:var(--text-secondary); margin-bottom:0.6rem;">
                ${this.t('dades.incTripsHowIntro')}
              </div>
              <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:0.6rem; font-size:0.76rem; color:var(--text-muted);">
                <div style="background:var(--bg-surface); padding:0.55rem 0.75rem; border-radius:6px; border:1px solid var(--border-subtle);">
                  <strong style="color:var(--text-primary); display:block; margin-bottom:2px;">${this.esc(this.t('dades.incTripsCard1Title'))}</strong>
                  ${this.esc(this.t('dades.incTripsCard1Text'))}
                </div>
                <div style="background:var(--bg-surface); padding:0.55rem 0.75rem; border-radius:6px; border:1px solid var(--border-subtle);">
                  <strong style="color:var(--text-primary); display:block; margin-bottom:2px;">${this.esc(this.t('dades.incTripsCard2Title'))}</strong>
                  ${this.esc(this.t('dades.incTripsCard2Text'))}
                </div>
                <div style="background:var(--bg-surface); padding:0.55rem 0.75rem; border-radius:6px; border:1px solid var(--border-subtle);">
                  <strong style="color:var(--text-primary); display:block; margin-bottom:2px;">${this.esc(this.t('dades.incTripsCard3Title'))}</strong>
                  ${this.esc(this.t('dades.incTripsCard3Text'))}
                </div>
              </div>
            </div>
          </div>
        </div>

        ${tripsList.length === 0 ? `
          <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:10px; padding:2rem; text-align:center; color:var(--text-muted);">
            ${this.esc(this.t('dades.incTripsEmpty'))}
          </div>
        ` : `
          <div style="display:flex; flex-direction:column; gap:0.75rem;">
            ${tripsList.map(trip => {
              const lColor = getLineColor(trip.lineCode);
              const typeBadgeClass = (trip.incidentType === 'maintenance' || trip.incidentType === 'trip_relink')
                ? 'incident-badge-maintenance'
                : (trip.isMovingTraffic ? 'incident-badge-traffic' : 'incident-badge-layover');
              const tripKind = trip.incidentType === 'maintenance'
                ? this.t('dades.incTripMaint')
                : (trip.isMovingTraffic ? this.t('dades.incTripMoving', { n: trip.stopsCount }) : this.t('dades.incTripStopped'));
              const endReasonBadges = {
                end_of_line: `<span class="trajectory-end">${this.esc(this.t('dades.endEndOfLine'))}</span>`,
                recovered: `<span class="trajectory-end is-recovered">${this.esc(this.t('dades.endRecovered'))}</span>`,
                trip_change: `<span class="trajectory-end">${this.esc(this.t('dades.endTripChange'))}</span>`,
                relinked: `<span class="trajectory-end">${this.esc(this.t('dades.endRelinked'))}</span>`,
                deadhead_return: `<span class="trajectory-end">${this.esc(this.t('dades.endDeadhead'))}</span>`,
                backward_leg: `<span class="trajectory-end">${this.esc(this.t('dades.endBackward'))}</span>`,
                signal_lost: `<span class="trajectory-end">${this.esc(this.t('dades.endSignalLost'))}</span>`,
                ongoing: `<span class="trajectory-end">${this.esc(this.t('dades.endOngoing'))}</span>`
              };
              return `
                <div class="trip-card">
                  <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
                    <div style="display:flex; align-items:center; gap:0.5rem;">
                      <span style="background:${lColor}; color:${this.chipInk(lColor)}; padding:0.2rem 0.55rem; border-radius:6px; font-weight:800; font-size:0.8rem;">${this.esc(trip.lineCode)}</span>
                      <strong style="color:var(--text-primary); font-size:0.9rem;">${this.esc(this.t('dades.incTripHead', { start: trip.startTime }))}</strong>
                      ${formatBusBadge(trip.vehicleId)}
                      <span style="color:var(--text-muted); font-size:0.78rem;">${this.esc(this.t('dades.incTripDur', { min: trip.durationMinutes || 1 }))}</span>
                    </div>
                    <div style="display:flex; align-items:center; gap:0.5rem;">
                      <span class="${typeBadgeClass}" style="padding:0.2rem 0.5rem; border-radius:6px; font-size:0.74rem; font-weight:700;">
                        ${this.esc(trip.incidentTypeLabel)}
                      </span>
                      <span style="background:rgba(239,68,68,0.15); color:var(--accent-danger); padding:0.2rem 0.55rem; border-radius:6px; font-size:0.78rem; font-weight:800;">
                        ${this.esc(this.t('dades.incTripMax', { d: trip.maxDelayMins }))}
                      </span>
                    </div>
                  </div>

                  <!-- Trajectory flow -->
                  <div class="trip-trajectory-flow">
                    <span style="font-weight:700; color:var(--text-muted); margin-right:0.25rem;">${this.esc(this.t('dades.incTripTraj'))}</span>
                    ${(trip.stopProgression && trip.stopProgression.length > 0
                      ? trip.stopProgression
                      : (trip.stopsTraversed || []).map(stName => ({ stopName: stName, delayMins: null, isRecovered: false }))
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
                      const stopTitle = dMins != null
                        ? `${st.stopName} (${this.t(st.isRecovered ? 'dades.matchTripRecovered' : 'dades.matchTripDelay')}: +${dMins} min)`
                        : st.stopName;
                      return `
                        <span class="stop-step ${st.isRecovered ? 'is-recovered' : ''} ${st.belowThreshold && !st.isRecovered ? 'is-below-threshold' : ''}" title="${this.esc(stopTitle)}">
                          <span class="stop-node ${st.isRecovered ? 'recovered' : (st.belowThreshold ? 'ok' : (dMins >= 10 ? 'critical' : 'delayed'))}"></span>
                          <span class="stop-name">${this.esc(st.stopName)}</span>
                          ${delayBadge}
                        </span>
                        ${sIdx < arr.length - 1 ? '<span class="step-arrow">→</span>' : ''}
                      `;
                    }).join('')}${endReasonBadges[trip.endReason] || ''}
                  </div>

                  ${trip.relink ? `
                  <div style="margin-top:0.5rem; font-size:0.76rem; color:var(--accent-warning); line-height:1.45;">
                    ${this.esc(this.t('dades.incTripRelinkNote', { stop: trip.relink.stopName, before: trip.relink.delayBefore, after: trip.relink.delayAfter }))}
                  </div>` : ''}

                  ${trip.backwardLeg ? `
                  <div class="trajectory-note">
                    ${this.esc(this.t('dades.incTripBackwardNote', { after: this._afterStop(trip.backwardLeg.lastServedStop), steps: trip.backwardLeg.stepsBack, lowest: trip.backwardLeg.lowestStop }))}
                  </div>` : ''}

                  ${trip.deadhead ? `
                  <div style="margin-top:0.5rem; font-size:0.76rem; color:var(--accent-warning); line-height:1.45;">
                    ${this.esc(this.t('dades.incTripDeadheadNote', { after: this._afterStop(trip.deadhead.lastServedStop), resume: trip.deadhead.resumeStop, ret: trip.deadhead.returnMinutes, towards: trip.deadhead.towards, opp: trip.deadhead.oppositeTripMinutes }))}
                  </div>` : ''}

                  <!-- Context and action footer -->
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-top:0.6rem; font-size:0.75rem; color:var(--text-muted); flex-wrap:wrap; gap:0.4rem;">
                    <div>
                      <span>${this.esc(this.t('dades.incTripFooter', { tag: trip.trafficTag || '', n: trip.sampleCount, kind: tripKind }))}</span>
                    </div>
                    ${trip.incidentType !== 'maintenance' ? `
                      <button type="button" class="btn-locate-incident-stop" data-locate-line="${this.esc(trip.lineCode)}" data-locate-stop="${this.esc(trip.firstStop || trip.stopsTraversed[0])}" title="${this.esc(this.t('dades.incLocateTip'))}">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
                        <span>${this.esc(this.t('dades.incViewStop'))}</span>
                      </button>
                    ` : ''}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `}
      `}

      ${this._renderEdgeCaseTable(data)}
    `;
  }

  /** "02/10 18:23" (Madrid) of an epoch-ms timestamp, '' when it is not one. */
  _stampOf(ts) {
    const n = Number(ts);
    return Number.isFinite(n) && n > 0
      ? new Date(n).toLocaleString(this.locale(), { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).replace(',', '')
      : '';
  }

  /** The kinds in the edge-case table: label and one-line meaning. */
  _edgeCaseKinds() {
    return {
      relink: [this.t('dades.ecRelink'), this.t('dades.ecRelinkDesc')],
      deadhead_return: [this.t('dades.ecDeadhead'), this.t('dades.ecDeadheadDesc')],
      delay_jump: [this.t('dades.ecJump'), this.t('dades.ecJumpDesc')],
      backward_leg: [this.t('dades.ecBackward'), this.t('dades.ecBackwardDesc')],
      trip_change: [this.t('dades.ecTripChange'), this.t('dades.ecTripChangeDesc')]
    };
  }

  /** The detail column of one edge case, as plain text. */
  _edgeCaseDetail(c) {
    const d = c.detail || {};
    switch (c.kind) {
      case 'relink': return this.t('dades.ecDetRelink', { samples: d.samples || 0, stops: d.stops || 0 });
      case 'deadhead_return': return this.t('dades.ecDetDeadhead', { ret: d.returnMinutes, opp: d.oppositeTripMinutes, records: d.records || 0 });
      case 'delay_jump': return this.t('dades.ecDetJump', { elapsed: d.elapsedMins, samples: d.samples || 0 });
      case 'backward_leg': return this.t('dades.ecDetBackward', { steps: d.stepsBack, visits: d.visits });
      case 'trip_change': return this.t('dades.ecDetTripChange', { mins: d.silentMinutes });
      default: return '';
    }
  }

  /** The signal column: did the bus lose GPS in the silence that needs explaining? */
  _edgeCaseSignal(c) {
    switch (c.signal) {
      case 'lost': return this.t('dades.ecSigLost', { sec: c.signalGapSec });
      case 'feed_stalled': return this.t('dades.ecSigStalled');
      case 'terminal': return this.t('dades.ecSigTerminal');
      case 'kept': return this.t('dades.ecSigKept');
      default: return this.t('dades.ecSigUnknown');
    }
  }

  /** The GPS column: positions stored around the case, or why there are none. */
  _edgeCaseGps(c, keptHours) {
    if (c.gpsPoints > 0) return this.t('dades.ecGpsPoints', { n: c.gpsPoints });
    return c.gpsExpired ? this.t('dades.ecGpsExpired', { h: keptHours }) : this.t('dades.ecGpsNone');
  }

  /**
   * The debug table at the bottom of the incidents view: every moment where the
   * operator's data does not fit what a bus can do, one row each, with how many
   * stored GPS positions surround it and a button to investigate. Styles live in
   * classes (the design-system ratchet counts inline styles).
   */
  _renderEdgeCaseTable(data) {
    const list = Array.isArray(data && data.edgeCases) ? data.edgeCases : [];
    const kinds = this._edgeCaseKinds();
    const keptHours = Number(data && data.snapshotRetentionHours) || 6;
    const counts = Object.keys(kinds).map(k => [k, list.filter(c => c.kind === k).length]);
    const chips = counts.map(([k, n]) => `<span class="edge-kind edge-kind-${k}" title="${this.esc(kinds[k][1])}">${this.esc(kinds[k][0])} <strong>${n}</strong></span>`).join('');
    const rows = list.map(c => {
      const [label, meaning] = kinds[c.kind] || [c.kind, ''];
      const delay = c.delayBefore === null ? '—' : (c.delayAfter === null || c.delayAfter === c.delayBefore ? `+${c.delayBefore}` : `+${c.delayBefore} → ${c.delayAfter > 0 ? '+' : ''}${c.delayAfter}`);
      return `
        <tr>
          <td><span class="edge-kind edge-kind-${this.esc(c.kind)}" title="${this.esc(meaning)}">${this.esc(label)}</span></td>
          <td>${this.esc(c.lineCode)}</td>
          <td>${this.esc(c.vehicleId || '—')}</td>
          <td class="edge-when">${this.esc(this._stampOf(c.fromTs))} → ${this.esc(this._stampOf(c.toTs))}</td>
          <td>${this.esc(c.fromStop || '—')} → ${this.esc(c.toStop || '—')}</td>
          <td class="edge-delay">${this.esc(delay)} min</td>
          <td>${this.esc(this._edgeCaseDetail(c))}</td>
          <td class="edge-gps ${c.gpsPoints > 0 ? 'has-gps' : ''}">${this.esc(this._edgeCaseGps(c, keptHours))}</td>
          <td class="edge-signal edge-signal-${this.esc(c.signal || 'unknown')}">${this.esc(this._edgeCaseSignal(c))}</td>
          <td>
            <button type="button" class="btn-investigate-incident" data-investigate-line="${this.esc(c.lineCode)}" data-investigate-stop="${this.esc(c.stop)}" data-investigate-vehicle="${this.esc(c.vehicleId)}" data-investigate-at="${c.at || ''}" title="${this.esc(this.t('dades.ecInvTip'))}">
              <span>${this.esc(this.t('dades.incBtnInv'))}</span>
            </button>
          </td>
        </tr>`;
    }).join('');
    const capText = list.length >= 150 ? this.t('dades.ecNoteCap') : '';
    return `
      <section class="edge-cases" id="edge-cases-table" aria-labelledby="edge-cases-title">
        <div class="edge-cases-head">
          <div>
            <h4 id="edge-cases-title">${this.esc(this.t('dades.ecTitle'))}</h4>
            <p class="edge-cases-note">${this.esc(this.t('dades.ecNote', { h: keptHours, cap: capText }))}</p>
          </div>
          ${list.length ? `<button type="button" class="btn-secondary btn-sm" id="btn-copy-edge-cases" title="${this.esc(this.t('dades.ecCopyTip'))}">${this.esc(this.t('dades.ecCopyBtn'))}</button>` : ''}
        </div>
        <div class="edge-kinds">${chips}</div>
        ${list.length === 0 ? `<p class="edge-cases-note">${this.esc(this.t('dades.ecEmpty'))}</p>` : `
        <div class="observatori-table-wrapper">
          <table class="observatori-table edge-cases-table">
            <thead>
              <tr><th scope="col">${this.esc(this.t('dades.ecColCase'))}</th><th scope="col">${this.esc(this.t('dades.colLine'))}</th><th scope="col">${this.esc(this.t('dades.ecColBus'))}</th><th scope="col">${this.esc(this.t('dades.ecColWhen'))}</th><th scope="col">${this.esc(this.t('dades.ecColStops'))}</th><th scope="col">${this.esc(this.t('dades.incColDelay'))}</th><th scope="col">${this.esc(this.t('dades.ecColDetail'))}</th><th scope="col">${this.esc(this.t('dades.ecColGps'))}</th><th scope="col">${this.esc(this.t('dades.incColSignal'))}</th><th scope="col"></th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`}
      </section>`;
  }

  /** Copy the edge-case table as tab-separated text. */
  copyEdgeCases() {
    const list = this.lastIncidentData && Array.isArray(this.lastIncidentData.edgeCases) ? this.lastIncidentData.edgeCases : [];
    if (!list.length) return;
    const kinds = this._edgeCaseKinds();
    const keptHours = Number(this.lastIncidentData.snapshotRetentionHours) || 6;
    const lines = [this.t('dades.ecTsvHeaders')];
    for (const c of list) {
      lines.push([
        (kinds[c.kind] || [c.kind])[0], c.lineCode, c.vehicleId, this._stampOf(c.fromTs), this._stampOf(c.toTs), c.fromStop, c.toStop,
        c.delayBefore === null ? '' : c.delayBefore, c.delayAfter === null ? '' : c.delayAfter, this._edgeCaseDetail(c), this._edgeCaseGps(c, keptHours), this._edgeCaseSignal(c)
      ].join('\t'));
    }
    const text = lines.join('\n');
    const btn = document.getElementById('btn-copy-edge-cases');
    const done = () => {
      if (!btn) return;
      const orig = btn.textContent;
      btn.textContent = this.t('dades.copied');
      setTimeout(() => { btn.textContent = orig; }, 2500);
    };
    const promptMsg = this.t('dades.copyTablePrompt');
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(done).catch(() => prompt(promptMsg, text));
    } else {
      prompt(promptMsg, text);
    }
  }

  copyAnomaliesReport() {
    if (!this.lastIncidentData || !Array.isArray(this.lastIncidentData.telemetryAnomalies)) return;
    const list = this.lastIncidentData.telemetryAnomalies;
    if (list.length === 0) return;

    const lineLabel = (!this._currentIncidentLine || this._currentIncidentLine === 'all')
      ? this.t('dades.allLines')
      : this._currentIncidentLine;
    let text = `${this.t('dades.repAnomHead')}\n`;
    text += `${this.t('dades.repPeriodLine', { h: this._currentIncidentHours || 168, line: lineLabel })}\n`;
    text += `${this.t('dades.repExtracted', { date: new Date().toLocaleString(this.locale()) })}\n`;
    text += `${this.t('dades.repAnomTotal', { n: list.length })}\n\n`;
    text += `${this.t('dades.repAnomDesc')}\n\n`;
    text += `${this.t('dades.repAnomList')}\n`;

    list.forEach((item, idx) => {
      const sig = item.isRealTime ? this.t('dades.sigGps') : this.t('dades.repSigEst');
      const isMaint = item.anomalyType === 'maintenance' || (item.anomalyType !== 'startup_sae' && item.anomalyType !== 'trip_relink' && item.anomalyType !== 'deadhead_return' && item.anomalyType !== 'delay_jump' && item.anomalyType !== 'backward_leg');
      const stopInfo = isMaint ? this.t('dades.repAnomMaint') : this.t('dades.repAnomStop', { stop: item.stopName });
      const busTag = item.vehicleId && !item.vehicleId.toLowerCase().endsWith('bus') ? ` | Bus #${item.vehicleId.replace(/^mataro_\w+_/i, '')}` : '';
      text += `${this.t('dades.repAnomItem', {
        idx: idx + 1,
        line: item.lineCode,
        date: item.formattedDate,
        stopInfo,
        delay: item.delayMins,
        cause: item.trafficTag || item.diagnosticBadge || this.t('dades.incAnomFallback'),
        busTag,
        sig
      })}\n`;
    });

    text += `\n${this.t('dades.repAnomFoot')}`;

    const finish = () => {
      const btn = document.getElementById('btn-copy-anomalies-report');
      if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = `<span>${this.esc(this.t('dades.copiedClip'))}</span>`;
        setTimeout(() => { btn.innerHTML = orig; }, 3000);
      }
    };
    const promptMsg = this.t('dades.copyAnomPrompt');

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(finish).catch(() => {
        prompt(promptMsg, text);
      });
    } else {
      prompt(promptMsg, text);
    }
  }

  copyInvestigationReport() {
    if (!this.lastIncidentData || !Array.isArray(this.lastIncidentData.investigationIncidents)) return;
    const list = this.lastIncidentData.investigationIncidents;
    if (list.length === 0) return;

    const lineLabel = (!this._currentIncidentLine || this._currentIncidentLine === 'all')
      ? this.t('dades.allLines')
      : this._currentIncidentLine;
    let text = `${this.t('dades.repInvHead')}\n`;
    text += `${this.t('dades.repPeriodLine', { h: this._currentIncidentHours || 168, line: lineLabel })}\n`;
    text += `${this.t('dades.repExtracted', { date: new Date().toLocaleString(this.locale()) })}\n`;
    text += `${this.t('dades.repInvTotal', { n: list.length })}\n\n`;
    text += `${this.t('dades.repInvDesc')}\n\n`;
    text += `${this.t('dades.repInvList')}\n`;

    list.forEach((item, idx) => {
      const sig = item.isRealTime ? this.t('dades.sigGps') : this.t('dades.repSigEst');
      const busTag = item.vehicleId && !item.vehicleId.toLowerCase().endsWith('bus') ? ` | Bus #${item.vehicleId.replace(/^mataro_\w+_/i, '')}` : '';
      text += `${this.t('dades.repInvItem', {
        idx: idx + 1,
        line: item.lineCode,
        date: item.formattedDate,
        stop: item.stopName,
        delay: item.delayMins,
        busTag,
        sig
      })}\n`;
    });

    text += `\n${this.t('dades.repInvFoot')}`;

    const finish = () => {
      const btn = document.getElementById('btn-copy-investigation-report');
      if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = `<span>${this.esc(this.t('dades.copiedClip'))}</span>`;
        setTimeout(() => { btn.innerHTML = orig; }, 3000);
      }
    };
    const promptMsg = this.t('dades.copyInvPrompt');

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(finish).catch(() => {
        prompt(promptMsg, text);
      });
    } else {
      prompt(promptMsg, text);
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
    this.renderLineFilter();
    if (contentContainer) contentContainer.style.display = 'none';
    if (termometreContainer) termometreContainer.style.display = 'none';
    if (incidentsContainer) incidentsContainer.style.display = 'none';
    if (monthlyContainer) {
      monthlyContainer.style.display = 'block';
      this.showGpsGaps(false);
      if (!this._monthlyData || force || (month && month !== this._currentMonthlyMonth)) {
        monthlyContainer.innerHTML = `<div style="text-align:center; padding:3rem; color:var(--text-muted);"><span class="loading-spinner-inline"></span> ${this.esc(this.t('dades.mLoading'))}</div>`;
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
          monthlyContainer.innerHTML = `<div style="text-align:center; padding:2rem; color:var(--text-danger);">${this.esc(this.t('dades.mLoadError', { err: res?.error || this.t('dades.mUnavailable') }))}</div>`;
        }
      }
    } catch (e) {
      if (monthlyContainer) {
        monthlyContainer.innerHTML = `<div style="text-align:center; padding:2rem; color:var(--text-danger);">${this.esc(this.t('dades.mConnError', { err: e.message }))}</div>`;
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
    const loc = this.locale();

    const genDate = data.generationTimestamp
      ? new Date(data.generationTimestamp).toLocaleString(loc, { timeZone: 'Europe/Madrid' })
      : '--';

    const linesRows = lines.map(l => {
      const badgeColor = this.getLineColor(l.lineCode) || '#1976d2';
      return `
        <tr>
          <td><span class="line-badge" style="background:${badgeColor}; color:#fff; padding:2px 8px; border-radius:4px; font-weight:bold;">${this.esc(l.lineCode)}</span></td>
          <td style="text-align:right;">${l.visitCount.toLocaleString(loc)}</td>
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
          <td style="text-align:right;">${h.visitCount.toLocaleString(loc)}</td>
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
          <td style="text-align:right;">${w.visitCount.toLocaleString(loc)}</td>
          <td style="text-align:right; font-weight:bold; color:var(--color-on-time, #2e7d32);">${w.onTimePct}%</td>
          <td style="text-align:right; color:var(--color-late, #f57c00);">${w.latePct}%</td>
          <td style="text-align:right; color:var(--color-severe, #d32f2f);">${w.severeLatePct}%</td>
          <td style="text-align:right; font-weight:bold; color:var(--color-severe, #d32f2f);">${w.avgDelayMins > 0 ? '+' : ''}${w.avgDelayMins} m</td>
        </tr>
      `;
    }).join('') : `<tr><td colspan="8" style="text-align:center; padding:1rem; color:var(--text-muted); font-style:italic;">${this.esc(this.t('dades.mWorstEmpty'))}</td></tr>`;

    monthlyContainer.innerHTML = `
      <div class="monthly-report-wrapper">
        <div class="monthly-report-header">
          <div class="monthly-report-title">
            <div style="font-size:0.75rem; text-transform:uppercase; letter-spacing:0.05em; color:var(--brand-primary); font-weight:700; margin-bottom:0.25rem;">
              ${this.esc(this.t('dades.mEyebrow'))}
            </div>
            <h2>${this.esc(this.t('dades.mTitle'))}</h2>
            <div class="monthly-report-meta">
              <span><strong>${this.esc(this.t('dades.mMetaMonth'))}</strong> ${this.esc(data.month)}</span>
              <span><strong>${this.esc(this.t('dades.mMetaVersion'))}</strong> <code>${this.esc(data.dataVersion || 'v3.0')}</code></span>
              <span><strong>${this.esc(this.t('dades.mMetaGenerated'))}</strong> ${this.esc(genDate)}</span>
              <span><strong>${this.esc(this.t('dades.mMetaBasis'))}</strong> ${this.esc(this.t('dades.mMetaBasisVal', { basis: s.basis || 'stop_visits' }))}</span>
            </div>
          </div>
          <div class="monthly-report-controls">
            <label for="monthly-report-month-input" class="monthly-controls-label" style="font-size:0.8rem; color:var(--text-secondary);">${this.esc(this.t('dades.mSelectMonth'))}</label>
            <input type="month" id="monthly-report-month-input" class="monthly-report-month-input" value="${this.esc(data.month)}">
            <button type="button" class="btn-print-report" id="btn-print-monthly-report" title="${this.esc(this.t('dades.mPrintTip'))}">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>
              <span>${this.esc(this.t('dades.mPrintBtn'))}</span>
            </button>
          </div>
        </div>

        <!-- Global KPIs -->
        <h4 style="margin:1rem 0 0.5rem 0; font-size:0.95rem; color:var(--text-primary);">${this.esc(this.t('dades.mSec1'))}</h4>
        <div class="monthly-kpi-grid">
          <div class="monthly-kpi-card">
            <div class="kpi-val">${(s.totalVisits || 0).toLocaleString(loc)}</div>
            <div class="kpi-lbl">${this.esc(this.t(s.basis === 'delay_logs' ? 'dades.mKpiSamplesFallback' : 'dades.mKpiVisits'))}</div>
          </div>
          <div class="monthly-kpi-card">
            <div class="kpi-val" style="color:var(--color-on-time, #2e7d32);">${s.onTimePct ?? '--'}%</div>
            <div class="kpi-lbl">${this.esc(this.t('dades.mKpiPunctuality'))}</div>
          </div>
          <div class="monthly-kpi-card">
            <div class="kpi-val" style="color:var(--color-early, #1976d2);">${s.earlyPct ?? '--'}%</div>
            <div class="kpi-lbl">${this.esc(this.t('dades.mKpiEarly'))}</div>
          </div>
          <div class="monthly-kpi-card">
            <div class="kpi-val" style="color:var(--color-late, #f57c00);">${s.latePct ?? '--'}%</div>
            <div class="kpi-lbl">${this.esc(this.t('dades.mKpiLate'))}</div>
          </div>
          <div class="monthly-kpi-card">
            <div class="kpi-val" style="color:var(--color-severe, #d32f2f);">${s.severeLatePct ?? '--'}%</div>
            <div class="kpi-lbl">${this.esc(this.t('dades.mKpiSevere'))}</div>
          </div>
          <div class="monthly-kpi-card">
            <div class="kpi-val">${cov.coveragePct ?? '--'}%</div>
            <div class="kpi-lbl">${this.esc(this.t('dades.mKpiCoverage', { active: cov.activeFeedHours || 0, sched: cov.scheduledServiceHours || 0 }))}</div>
          </div>
        </div>

        <!-- Per Line Breakdown -->
        <h4 style="margin:1.5rem 0 0.5rem 0; font-size:0.95rem; color:var(--text-primary);">${this.esc(this.t('dades.mSec2'))}</h4>
        <div class="observatori-table-wrapper">
        <table class="monthly-report-table">
          <thead>
            <tr>
              <th>${this.esc(this.t('dades.colLine'))}</th>
              <th style="text-align:right;">${this.esc(this.t('dades.mColVisits'))}</th>
              <th style="text-align:right;">${this.esc(this.t('dades.mColOnTime'))}</th>
              <th style="text-align:right;">${this.esc(this.t('dades.mColEarly'))}</th>
              <th style="text-align:right;">${this.esc(this.t('dades.mColLate'))}</th>
              <th style="text-align:right;">${this.esc(this.t('dades.mColSevere'))}</th>
              <th style="text-align:right;">${this.esc(this.t('dades.colAvgDelay'))}</th>
              <th style="text-align:right;">${this.esc(this.t('dades.colMaxDelay'))}</th>
            </tr>
          </thead>
          <tbody>
            ${linesRows}
          </tbody>
        </table>
        </div>

        <!-- Per Hour Breakdown -->
        <h4 style="margin:1.5rem 0 0.5rem 0; font-size:0.95rem; color:var(--text-primary);">${this.esc(this.t('dades.mSec3'))}</h4>
        <div class="observatori-table-wrapper">
        <table class="monthly-report-table">
          <thead>
            <tr>
              <th>${this.esc(this.t('dades.mColHour'))}</th>
              <th style="text-align:right;">${this.esc(this.t('dades.mColVisits'))}</th>
              <th style="text-align:right;">${this.esc(this.t('dades.mColOnTime'))}</th>
              <th style="text-align:right;">${this.esc(this.t('dades.mColEarly'))}</th>
              <th style="text-align:right;">${this.esc(this.t('dades.mColLate'))}</th>
              <th style="text-align:right;">${this.esc(this.t('dades.mColSevere'))}</th>
              <th style="text-align:right;">${this.esc(this.t('dades.colAvgDelay'))}</th>
            </tr>
          </thead>
          <tbody>
            ${hourlyRows}
          </tbody>
        </table>
        </div>

        <!-- Worst Stops (>= 50 visits) -->
        <h4 style="margin:1.5rem 0 0.5rem 0; font-size:0.95rem; color:var(--text-primary);">${this.esc(this.t('dades.mSec4'))}</h4>
        <div class="observatori-table-wrapper">
        <table class="monthly-report-table">
          <thead>
            <tr>
              <th style="text-align:center;">#</th>
              <th>${this.esc(this.t('dades.mColStop'))}</th>
              <th>${this.esc(this.t('dades.mColLines'))}</th>
              <th style="text-align:right;">${this.esc(this.t('dades.mColVisits'))}</th>
              <th style="text-align:right;">${this.esc(this.t('dades.mColOnTime'))}</th>
              <th style="text-align:right;">${this.esc(this.t('dades.mColLate'))}</th>
              <th style="text-align:right;">${this.esc(this.t('dades.mColSevere'))}</th>
              <th style="text-align:right;">${this.esc(this.t('dades.colAvgDelay'))}</th>
            </tr>
          </thead>
          <tbody>
            ${worstRows}
          </tbody>
        </table>
        </div>

        <!-- Methodology & Audit Invariants -->
        <div class="monthly-methodology-box">
          <strong style="display:block; margin-bottom:0.35rem; color:var(--text-primary);">${this.esc(this.t('dades.mMethTitle'))}</strong>
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

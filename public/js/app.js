// Arribo! - Plataforma de Telemetria i Seguiment d'Autobusos en Temps Real
// Suport universal per a totes les línies d'autobús urbà i interurbà de Catalunya

const MATARO_ZONES = [
  { id: 'tereses', name: 'Pl. de les Tereses / Centre', icon: '🏛️', desc: 'Línies L1, L2, L3, L4, L5, L7, L8', lat: 41.5392, lon: 2.4445 },
  { id: 'rodalies', name: 'Estació Rodalies Renfe', icon: '🚆', desc: 'Línies L1, L2, L3, L4, L5, L8', lat: 41.5327, lon: 2.4440 },
  { id: 'hospital', name: 'Hospital de Mataró', icon: '🏥', desc: 'Línies L1, L2, L3, L4, L5, L6, L7, L8', lat: 41.5562, lon: 2.4355 },
  { id: 'parc_central', name: 'Parc Central / Geganta', icon: '🌳', desc: 'Línies L1, L2, L3, L5, L6, L7', lat: 41.5430, lon: 2.4390 },
  { id: 'boet', name: "Pla d'en Boet / Camí del Mig", icon: '🏭', desc: 'Línies L1, L2, L6, L8', lat: 41.5320, lon: 2.4300 },
  { id: 'cerdanyola', name: 'Cerdanyola / Puig i Cadafalch', icon: '🏢', desc: 'Línies L2, L5, L6, L7', lat: 41.5390, lon: 2.4280 },
  { id: 'rocafonda', name: 'Rocafonda / El Palau', icon: '🏘️', desc: 'Línies L1, L3, L4, L6', lat: 41.5470, lon: 2.4530 },
  { id: 'molins', name: 'Els Molins / Torner', icon: '🏞️', desc: 'Línies L1, L2, L3, L4, L7', lat: 41.5510, lon: 2.4430 },
  { id: 'llantia', name: 'La Llàntia / Via Europa', icon: '🏫', desc: 'Línies L1, L2, L5, L8', lat: 41.5480, lon: 2.4320 }
];

const CANONICAL_BUS_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1.5px; margin-right:3px; display:inline-block;"><path d="M19 17h2l.64-2.54a6 6 0 0 0 .36-2V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v6.46a6 6 0 0 0 .36 2L3 17h2"/><path d="M7 17v2a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-2"/><path d="M14 17v2a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-2"/><circle cx="6.5" cy="12.5" r="1.5"/><circle cx="17.5" cy="12.5" r="1.5"/><line x1="2" y1="9" x2="22" y2="9"/></svg>';

class TransitApp {
  constructor() {
    this.activeLineId = null;
    this.activeDirection = '1';

    this.availableLines = [];
    this.activeLineData = null;
    
    try { this.targetStopsByLine = JSON.parse(localStorage.getItem('bad_amb_target_stops') || '{}') || {}; } catch (_) { this.targetStopsByLine = {}; }
    this.favoriteStops = this.loadFavoriteStops();
    this.currentNearbyStops = [];
    this.activeNearbyZone = null;

    this.lineCache = new Map(); // LRU bounded to max 8 active routes
    this.stopDeparturesCache = new Map(); // Client-side SWR stop departures cache
    this.targetEtaCache = new Map(); // Client-side SWR target stop ETA cache
    this.TARGET_ETA_TTL_MS = 60000; // 60s target ETA cache TTL
    this.activeRequestSeq = 0; // Monotonic request sequence ID to prevent race conditions
    this.allStops = [];
    this.activeBuses = [];
    this.selectedVehicleId = null;

    this.landingFilter = 'all';
    this.landingSearch = '';
    this.LANDING_SEARCH_CAP = 60; // max cards rendered per group during active search
    this.expandedGroups = new Set(); // Group IDs expanded by user on landing page

    this.pollInterval = 20;
    this.secondsRemaining = this.pollInterval;
    this.pollTimer = null;
    this.searchDebounceTimer = null;
    this.landingSearchDebounceTimer = null;
    
    try { this.soundEnabled = localStorage.getItem('c10_sound') === 'true'; } catch (_) { this.soundEnabled = false; }
    this.audioContext = null;
    this.lastAlertedTrip = null;

    // Inactive Tab Deep Sleep (Page Visibility API)
    this.isTabVisible = typeof document !== 'undefined' ? !document.hidden : true;
    this.animFrameId = null;

    // Trains UI display flag: trains remain fully operational in backend/tests, but hidden from the general transit UI
    this.showTrainsInUI = false;

    // Feature States: Traffic Congestion, Proximity Alarm & Journey Planner
    this.isTrafficVisible = false;
    this.activeProximityAlarm = null;
    this.alarmWatchId = null;
    this._plannerOriginCoords = null;
    this._plannerDestCoords = null;
    this.stopsViewMode = 'schematic';
    this.pendingFocusBusId = null;
    this.pendingFocusStopId = null;
    this.pendingSearchQuery = null;

    // Theme Management (Light / Dark Mode)
    this.currentTheme = this.getInitialTheme();
    this.initTheme();

    this.mapController = null;
    this.registerServiceWorker();
    this.init();
  }

  registerServiceWorker() {
    window.TransitPwa?.init();
  }

  ensureViewModeControlsExist() {
    // Ensure Stops Card Header Pills exist
    const headerRow = document.querySelector('.stops-card-header-row');
    if (headerRow && !document.getElementById('stops-view-mode-pills')) {
      const pillsDiv = document.createElement('div');
      pillsDiv.className = 'stops-view-mode-pills';
      pillsDiv.id = 'stops-view-mode-pills';
      pillsDiv.setAttribute('role', 'tablist');
      pillsDiv.setAttribute('aria-label', 'Mode de visualització de parades');
      pillsDiv.innerHTML = `
        <button type="button" class="btn-map-control btn-stops-view-mode ${this.stopsViewMode === 'schematic' ? 'active' : ''}" id="btn-stops-mode-schematic" data-mode="schematic" role="tab" aria-selected="${this.stopsViewMode === 'schematic'}" title="Veure termòmetre esquemàtic estil metro amb posició de busos en viu">
          <span>🚇 Termòmetre</span>
        </button>
        <button type="button" class="btn-map-control btn-stops-view-mode ${this.stopsViewMode === 'list' ? 'active' : ''}" id="btn-stops-mode-list" data-mode="list" role="tab" aria-selected="${this.stopsViewMode === 'list'}" title="Veure llista detallada de parades">
          <span>📋 Llista</span>
        </button>
      `;
      pillsDiv.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-stops-view-mode');
        if (!btn) return;
        e.preventDefault();
        const mode = btn.getAttribute('data-mode') || 'schematic';
        this.setStopsViewMode(mode);
      });
      const dirPills = document.getElementById('stops-card-dir-pills');
      if (dirPills) {
        headerRow.insertBefore(pillsDiv, dirPills);
      } else {
        headerRow.appendChild(pillsDiv);
      }
    }

    // 3. Ensure Stops Schematic Scroll container exists
    const browserCard = document.querySelector('.stops-browser-card');
    if (browserCard && !document.getElementById('stops-schematic-scroll')) {
      const schematicDiv = document.createElement('div');
      schematicDiv.className = 'stops-schematic-scroll';
      schematicDiv.id = 'stops-schematic-scroll';
      schematicDiv.style.display = this.stopsViewMode === 'schematic' ? 'block' : 'none';
      browserCard.appendChild(schematicDiv);
    }
  }

  loadFavoriteStops(...args) { return window.TransitStopFeatures.loadFavoriteStops.apply(this, args); }

  saveFavoriteStops(...args) { return window.TransitStopFeatures.saveFavoriteStops.apply(this, args); }

  isFavoriteStop(...args) { return window.TransitStopFeatures.isFavoriteStop.apply(this, args); }

  toggleFavoriteStop(...args) { return window.TransitStopFeatures.toggleFavoriteStop.apply(this, args); }

  updateHeaderFavoritesBadge(...args) { return window.TransitStopFeatures.updateHeaderFavoritesBadge.apply(this, args); }

  // LRU Bounded Cache to prevent unbounded memory growth
  setLineCache(key, data) {
    if (this.lineCache.has(key)) {
      this.lineCache.delete(key);
    } else if (this.lineCache.size >= 8) {
      // Evict oldest cached route topology
      const oldestKey = this.lineCache.keys().next().value;
      this.lineCache.delete(oldestKey);
    }
    this.lineCache.set(key, data);
  }

  setTargetEtaCache(key, data) {
    if (this.targetEtaCache.has(key)) {
      this.targetEtaCache.delete(key);
    } else if (this.targetEtaCache.size >= 32) {
      const oldestKey = this.targetEtaCache.keys().next().value;
      this.targetEtaCache.delete(oldestKey);
    }
    this.targetEtaCache.set(key, { ts: Date.now(), data });
  }

  getInitialTheme() {
    if (typeof window !== 'undefined' && window.TransitUtils && typeof window.TransitUtils.getStoredTheme === 'function') {
      return window.TransitUtils.getStoredTheme();
    }
    const saved = localStorage.getItem('arribo_theme') || localStorage.getItem('bad_amb_theme');
    if (saved === 'light' || saved === 'dark') return saved;
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
    return 'dark';
  }

  initTheme() {
    document.documentElement.setAttribute('data-theme', this.currentTheme);
    this.updateThemeButton();
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        const hasSaved = localStorage.getItem('arribo_theme') || localStorage.getItem('bad_amb_theme');
        if (!hasSaved) {
          this.setTheme(e.matches ? 'dark' : 'light', false);
        }
      });
    }
  }

  setTheme(theme, save = true) {
    this.currentTheme = theme;
    if (save && typeof window !== 'undefined' && window.TransitUtils && typeof window.TransitUtils.setStoredTheme === 'function') {
      window.TransitUtils.setStoredTheme(theme);
    } else {
      document.documentElement.setAttribute('data-theme', theme);
      if (save) {
        localStorage.setItem('arribo_theme', theme);
        localStorage.setItem('bad_amb_theme', theme);
      }
    }
    this.updateThemeButton();
    if (this.mapController) {
      this.mapController.setTheme(theme);
    }
  }

  toggleTheme() {
    this.setTheme(this.currentTheme === 'dark' ? 'light' : 'dark');
  }

  updateThemeButton() {
    const btn = document.getElementById('btn-theme-toggle');
    if (btn) {
      btn.setAttribute('aria-label', `Canviar a mode ${this.currentTheme === 'dark' ? 'clar' : 'fosc'}`);
      btn.setAttribute('title', `Canviar a mode ${this.currentTheme === 'dark' ? 'clar' : 'fosc'}`);
    }
  }

  async init() {
    console.log('🚀 Initializing Arribo! Multi-Line Universal Engine...');

    try {
      // 1. Initialize Map
      this.mapController = new C10Map('map-container');
      this.mapController.setTheme(this.currentTheme);

      // 2. Load Available Lines & Determine Initial Route from URL hash
      await this.fetchLines();
      this.parseUrlHash();

      // 3. Setup DOM Listeners, Landing Page & Controls
      this.setupEventListeners();
      this.setupLandingControls();
      this.setupMapResizeControls();
      this.setupAudio();

      // 4. Initial Route or Landing View Routing
      if (this.activeLineId) {
        // Validate the hash-resolved line actually exists — otherwise show a
        // friendly 'not found' popup instead of an eternal loading screen.
        const lineObj = this.availableLines.find(l => 
          String(l.id).toLowerCase() === String(this.activeLineId).toLowerCase() || 
          String(l.code).toLowerCase() === String(this.activeLineId).toLowerCase()
        );
        if (!lineObj) {
          this.showLineNotFoundModal(this.activeLineId);
          this.activeLineId = null;
          this.showLandingView();
          this.renderLandingLines();
        } else {
          this.showActiveLineView();
          await this.refreshAllData(true);
        }
      } else {
        this.showLandingView();
        this.renderLandingLines();
      }

      // 5. Start Polling & Animation Glider Loop
      this.startAutoRefresh();
      this.startAnimationLoop();
      this.setupFleetStream();
    } catch (err) {
      console.error('Fatal initialization error:', err);
    }
  }

  parseUrlHash() {
    let rawHash = window.location.hash.replace(/^#/, '').trim();
    let queryPart = '';

    // Extract query parameters if appended to the hash (e.g. #l1?bus=2675 or #l1&bus=2675)
    if (rawHash.includes('?') || rawHash.includes('&')) {
      const sep = rawHash.includes('?') ? '?' : '&';
      const parts = rawHash.split(sep);
      rawHash = parts[0];
      queryPart = parts.slice(1).join('&');
    }

    const searchStr = queryPart || window.location.search.replace(/^\?/, '');
    const params = new URLSearchParams(searchStr);
    const lineParam = params.get('line') || params.get('lineId') || params.get('linia');
    const busParam = params.get('bus') || params.get('vehicle') || params.get('vehicleId');
    const stopParam = params.get('stop') || params.get('stopId');
    const dirParam = params.get('dir') || params.get('direction');
    const qParam = params.get('q') || params.get('cerca');

    if (busParam) this.pendingFocusBusId = String(busParam).trim();
    if (stopParam) this.pendingFocusStopId = String(stopParam).trim();
    if (dirParam) this.pendingDirection = String(dirParam).trim();
    if (qParam) this.pendingSearchQuery = String(qParam).trim();

    if (!rawHash && lineParam) {
      rawHash = String(lineParam).trim();
    }

    const hash = rawHash.toLowerCase().trim();
    if (!hash || ['home', 'inici', 'lines', 'linies', 'totes', 'index'].includes(hash)) {
      this.activeLineId = null;
      return;
    }

    if (hash.startsWith('mataro-l') || hash.startsWith('mataro-')) {
      const match = hash.match(/mataro-?l?(\d+)/);
      if (match && match[1]) {
        this.activeLineId = match[1];
        return;
      }
    }

    if (hash.startsWith('l') && /^\d+$/.test(hash.replace('l', ''))) {
      this.activeLineId = hash.replace('l', '');
      return;
    }

    if (/^\d+$/.test(hash)) {
      this.activeLineId = hash;
      return;
    }

    const cleanHash = hash.replace(/^#/, '').replace(/^line-/, '').replace(/^linia-/, '').replace(/^l(?=[a-zA-Z0-9])/, '');

    const matchedLine = this.availableLines.find(l => 
      String(l.id).toLowerCase() === hash || 
      String(l.code).toLowerCase() === hash || 
      String(l.code).toLowerCase() === cleanHash ||
      String(l.id).toLowerCase() === cleanHash ||
      String(l.id).toLowerCase().includes(`_${cleanHash}`)
    );

    if (matchedLine) {
      this.activeLineId = String(matchedLine.id);
    } else if (hash) {
      this.activeLineId = hash;
    } else {
      this.activeLineId = null;
    }
  }

  // ==========================================
  // VIEW SWITCHING (LANDING HUB VS ACTIVE LINE)
  // ==========================================

  /**
   * Popup for a line ID that doesn't exist (bad URL hash). Offers a button
   * back to the full line catalog.
   */
  showLineNotFoundModal(lineId) {
    if (document.getElementById('line-not-found-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'line-not-found-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);';
    const lang = (navigator.language || 'ca').startsWith('es') ? 'es' : 'ca';
    const texts = lang === 'es'
      ? { title: 'Línea no encontrada', body: `La línea «${lineId}» no existe o ya no está disponible.`, btn: 'Ver todas las líneas' }
      : { title: 'Línia no trobada', body: `La línia «${lineId}» no existeix o ja no està disponible.`, btn: 'Veure totes les línies' };
    overlay.innerHTML = `
      <div role="dialog" aria-modal="true" style="max-width:420px;width:calc(100% - 40px);padding:28px;border-radius:16px;text-align:center;background:var(--bg-card, #1a1d24);border:1px solid var(--border-subtle, rgba(255,255,255,0.1));box-shadow:0 20px 60px rgba(0,0,0,0.5);">
        <div style="font-size:40px;margin-bottom:12px;">🚏</div>
        <h2 style="margin:0 0 8px;font-size:20px;color:var(--text-primary, #fff);">${this.esc(texts.title)}</h2>
        <p style="margin:0 0 20px;color:var(--text-secondary, #9aa0aa);font-size:14px;line-height:1.5;">${this.esc(texts.body)}</p>
        <button id="line-not-found-back" style="padding:10px 22px;border:none;border-radius:10px;cursor:pointer;font-weight:600;font-size:14px;background:var(--accent, #3b82f6);color:#fff;">${texts.btn}</button>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#line-not-found-back').addEventListener('click', () => {
      overlay.remove();
      window.location.hash = '';
      history.replaceState(null, '', window.location.pathname);
      this.showLandingView();
      this.renderLandingLines();
    });
  }

  showLandingView() {
    const landingView = document.getElementById('view-landing');
    const activeLineView = document.getElementById('view-active-line');

    if (landingView) {
      landingView.classList.add('active');
      landingView.removeAttribute('style');
    }
    if (activeLineView) {
      activeLineView.classList.remove('active');
      activeLineView.removeAttribute('style');
    }

    // Reset Header to Arribo! Brand State
    const badge = document.getElementById('header-line-badge');
    const modeBadge = document.getElementById('header-mode-badge');
    const subtitle = document.getElementById('header-subtitle');

    if (badge) {
      badge.innerHTML = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M19 17h2l.64-2.54a6 6 0 0 0 .36-2V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v6.46a6 6 0 0 0 .36 2L3 17h2"/>
        <path d="M7 17v2a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-2"/>
        <path d="M14 17v2a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-2"/>
        <circle cx="6.5" cy="12.5" r="1.5"/>
        <circle cx="17.5" cy="12.5" r="1.5"/>
        <line x1="2" y1="9" x2="22" y2="9"/>
      </svg>`;
      badge.removeAttribute('style');
    }
    if (modeBadge) {
      modeBadge.textContent = 'Temps Real';
      modeBadge.className = 'header-mode-badge universal';
    }
    if (subtitle) {
      subtitle.textContent = 'Mataró Bus Urbà en directe';
    }

    document.title = "Arribo! | Telemetria i Seguiment d'Autobusos en Temps Real";
  }

  showActiveLineView() {
    this.ensureViewModeControlsExist();
    const landingView = document.getElementById('view-landing');
    const activeLineView = document.getElementById('view-active-line');

    if (landingView) {
      landingView.classList.remove('active');
      landingView.removeAttribute('style');
    }
    if (activeLineView) {
      activeLineView.classList.add('active');
      activeLineView.removeAttribute('style');
    }

    if (this.mapController) {
      this.mapController.invalidateSize();
      setTimeout(() => {
        this.mapController?.invalidateSize();
        this.mapController?.fitRouteBounds();
      }, 100);
      setTimeout(() => {
        this.mapController?.invalidateSize();
        this.mapController?.fitRouteBounds();
      }, 350);
    }
  }

  navigateToLanding() {
    this.activeLineId = null;
    if (window.location.hash) {
      window.history.pushState(null, '', window.location.pathname);
    }
    this.showLandingView();
    this.renderLandingLines();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ==========================================
  // 1. UNIVERSAL LINE NAVIGATION & CONTROLLER
  // ==========================================

  async fetchLines() {
    const defaultEmergencyLines = [
      { id: '1', code: 'L1', name: 'Línia 1 - Circular Mataró', color: '#ff00ff', agency: 'Mataró Bus (Avanza)', group: 'mataro', directions: [{ dirId: '0', name: 'Circular' }] },
      { id: '2', code: 'L2', name: 'Línia 2 - Circular Mataró', color: '#804000', agency: 'Mataró Bus (Avanza)', group: 'mataro', directions: [{ dirId: '0', name: 'Circular' }] },
      { id: '3', code: 'L3', name: 'Línia 3 - Camí de la Serra - Rocafonda', color: '#808080', agency: 'Mataró Bus (Avanza)', group: 'mataro', directions: [{ dirId: '0', name: 'Sentit Anada' }, { dirId: '1', name: 'Sentit Tornada' }] },
      { id: '4', code: 'L4', name: 'Línia 4 - Cirera - Molins', color: '#ff0000', agency: 'Mataró Bus (Avanza)', group: 'mataro', directions: [{ dirId: '0', name: 'Sentit Anada' }, { dirId: '1', name: 'Sentit Tornada' }] },
      { id: '5', code: 'L5', name: 'Línia 5 - Estació Rodalies - Hospital de Mataró', color: '#00ea00', agency: 'Mataró Bus (Avanza)', group: 'mataro', directions: [{ dirId: '0', name: 'Cap a Hospital' }, { dirId: '1', name: 'Cap a Estació' }] },
      { id: '6', code: 'L6', name: 'Línia 6 - Ctra. de Cirera - Institut Català Salut', color: '#febf01', agency: 'Mataró Bus (Avanza)', group: 'mataro', directions: [{ dirId: '0', name: 'Sentit Anada' }, { dirId: '1', name: 'Sentit Tornada' }] },
      { id: '7', code: 'L7', name: 'Línia 7 - Pl. de les Tereses - Cerdanyola', color: '#80ffff', agency: 'Mataró Bus (Avanza)', group: 'mataro', directions: [{ dirId: '0', name: 'Sentit Anada' }, { dirId: '1', name: 'Sentit Tornada' }] },
      { id: '8', code: 'L8', name: 'Línia 8 - Estació Rodalies - Galícia', color: '#008040', agency: 'Mataró Bus (Avanza)', group: 'mataro', directions: [{ dirId: '0', name: 'Cap a Galícia' }, { dirId: '1', name: 'Cap a Estació' }] }
    ];

    const cachedLinesStr = localStorage.getItem('arribo_lines_cache');
    if (cachedLinesStr) {
      try {
        const cached = JSON.parse(cachedLinesStr);
        if (Array.isArray(cached) && cached.length > 0) {
          this.availableLines = cached;
        }
      } catch (_) {}
    }

    if (!this.availableLines || this.availableLines.length === 0) {
      this.availableLines = defaultEmergencyLines;
    }

    // Fast non-blocking fetch to update the catalog in background
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      const res = await fetch('/api/lines', { signal: controller.signal });
      clearTimeout(timeoutId);

      if (res.ok) {
        const json = await res.json();
        if (json.success && Array.isArray(json.lines) && json.lines.length > 0) {
          this.availableLines = json.lines;
          try {
            localStorage.setItem('arribo_lines_cache', JSON.stringify(json.lines));
          } catch (_) {}
          if (!this.activeLineId) {
            this.renderLandingLines();
          }
        }
      }
    } catch (e) {
      console.warn('[TransitApp] /api/lines background sync notice:', e.message);
    }
  }

  switchLine(lineId, direction = null) {
    this.activeLineId = String(lineId);
    this.selectedVehicleId = null;
    this.mapController?.clearVehicleTrail();

    const lineObj = this.availableLines.find(l => 
      String(l.id).toLowerCase() === String(lineId).toLowerCase() || 
      String(l.code).toLowerCase() === String(lineId).toLowerCase()
    );
    if (direction !== null) {
      this.activeDirection = String(direction);
    } else if (lineObj?.directions?.length > 0) {
      this.activeDirection = String(lineObj.directions[0].dirId !== undefined ? lineObj.directions[0].dirId : '0');
    } else {
      this.activeDirection = '0';
    }

    const hash = this.activeLineId === 'c10' ? '#c10' : `#l${this.activeLineId}`;
    if (window.location.hash !== hash) {
      window.history.pushState(null, '', hash);
    }

    this.showActiveLineView();

    // Instant optimistic render if line header info exists
    if (lineObj) {
      this.updateHeaderBrand(lineObj);
      this.renderLineBanner(lineObj);
      this.renderDirectionButtons(lineObj.directions || [], this.activeDirection);
    }

    const routeKey = `${this.activeLineId}_${this.activeDirection}`;
    const cached = this.lineCache.get(routeKey);
    let activeTargetId = null;
    if (cached) {
      this.activeLineData = cached;
      this.allStops = cached.stops || [];
      const savedStopId = this.targetStopsByLine[routeKey] || null;
      activeTargetId = savedStopId || this.allStops[0]?.id || null;
      this.populateSelect('target-stop-select', this.allStops, activeTargetId);
      this.renderRouteTimeline(cached, activeTargetId);
      this.renderStopsBrowser(cached, this.activeLineId);
    } else {
      this.mapController?.clearAll();
      this.activeLineData = null;
    }

    // Instant SWR Target Card render from client cache if available (<0ms)
    const etaCacheKey = activeTargetId ? `${routeKey}_${activeTargetId}` : null;
    const cachedEta = etaCacheKey ? this.targetEtaCache.get(etaCacheKey) : null;
    if (cachedEta && (Date.now() - cachedEta.ts < this.TARGET_ETA_TTL_MS)) {
      this.renderTargetCard(cachedEta.data, cached || lineObj);
    } else {
      const activeStop = this.allStops.find(s => String(s.id || s.mouteStopId || s.code) === String(activeTargetId)) || this.allStops[0];
      const stopName = activeStop?.name || 'Parada seleccionada';
      const stopCode = activeStop?.code || activeStop?.id || '...';
      const destName = lineObj?.directions?.[0]?.name || lineObj?.name || 'Destí';
      this.renderTargetCardLoading(cached || lineObj, stopName, stopCode, destName);
    }

    this.secondsRemaining = this.pollInterval;
    this.updateCountdownLabel();
    this.refreshAllData(true);
    // Restart the glider animation loop: it self-suspends on the Landing view,
    // so navigating Landing -> Line needs an idempotent kick (cancels any prior rAF).
    this.startAnimationLoop();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  switchDirection(dirId) {
    if (!dirId || dirId === this.activeDirection) return;
    this.activeDirection = String(dirId);
    this.selectedVehicleId = null;
    this.mapController?.clearVehicleTrail();

    // 1. Immediately toggle active and loading classes on all direction buttons & tabs (0ms response)
    const dirButtons = document.querySelectorAll('.btn-direction, .btn-stops-dir-tab');
    dirButtons.forEach(btn => {
      const bDir = btn.getAttribute('data-dir-id') || btn.getAttribute('data-direction');
      const isMatch = String(bDir) === String(dirId);
      btn.classList.toggle('active', isMatch);
      if (isMatch) {
        btn.classList.add('loading');
      } else {
        btn.classList.remove('loading');
      }
    });

    // 2. Instant Optimistic Render from cached route data if available
    const lId = this.activeLineId;
    const routeKey = `${lId}_${this.activeDirection}`;
    const cached = this.lineCache.get(routeKey);
    if (cached) {
      this.activeLineData = cached;
      const isBoth = this.activeDirection === 'both' || cached.direction === 'both';
      if (isBoth && cached.allDirections && cached.allDirections.length > 1) {
        const merged = [];
        for (const dir of cached.allDirections) {
          for (const s of (dir.stops || [])) {
            const last = merged[merged.length - 1];
            if (!last || String(last.id || last.mouteStopId || last.code) !== String(s.id || s.mouteStopId || s.code)) {
              merged.push(s);
            }
          }
        }
        this.allStops = merged.map((s, idx) => ({ ...s, seq: idx + 1 }));
      } else {
        this.allStops = cached.stops || [];
      }

      const savedStopId = this.targetStopsByLine[routeKey] || null;
      const isSavedValid = savedStopId && this.allStops.some(s => String(s.id || s.mouteStopId || s.code) === String(savedStopId));
      const activeTargetId = isSavedValid ? savedStopId : (this.allStops[0]?.id || this.allStops[0]?.mouteStopId || this.allStops[0]?.code || null);

      this.updateHeaderBrand(cached);
      this.renderLineBanner(cached);
      this.populateSelect('target-stop-select', cached, activeTargetId);
      this.renderRouteTimeline(cached, activeTargetId);
      this.renderStopsBrowser(cached, lId);

      const lineColor = cached.color || '#009485';
      const coords = cached.coords || cached.polyline || cached.allDirections?.[0]?.coords || cached.allDirections?.[0]?.polyline || [];
      const secondaryCoords = isBoth ? (cached.secondaryCoords || cached.allDirections?.[1]?.coords || cached.allDirections?.[1]?.polyline || null) : null;
      const secondaryStops = isBoth ? (cached.secondaryStops || cached.allDirections?.[1]?.stops || null) : null;
      const secondaryColor = isBoth ? (cached.secondaryColor || '#38bdf8') : '#38bdf8';

      this.mapController.renderStops(
        cached.stops || [],
        activeTargetId,
        (s) => this.inspectStop(s.id || s.mouteStopId, s.name),
        true,
        lineColor,
        coords,
        secondaryCoords,
        secondaryStops,
        secondaryColor,
        lId,
        this.activeDirection,
        cached.geometryEstimated === undefined ? null : { estimated: Boolean(cached.geometryEstimated), source: String(cached.geometrySource || '') }
      );
    } else if (this.activeLineData) {
      const etaMins = document.getElementById('target-countdown');
      if (etaMins) {
        etaMins.innerHTML = '<span class="loading-spinner-inline" style="width:22px; height:22px; border-width:3px; margin-right:6px;"></span>';
      }
    }

    // 3. Fetch fresh data
    this.refreshAllData(true).finally(() => {
      document.querySelectorAll('.btn-direction.loading, .btn-stops-dir-tab.loading').forEach(b => b.classList.remove('loading'));
    });
  }

  getContrastColor(hex) {
    if (!hex) return '#ffffff';
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    const r = parseInt(c.substring(0, 2), 16) || 0;
    const g = parseInt(c.substring(2, 4), 16) || 0;
    const b = parseInt(c.substring(4, 6), 16) || 0;
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 160 ? '#0f172a' : '#ffffff';
  }

  hexToRgb(hex) {
    if (!hex) return '0, 148, 133';
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    const num = parseInt(c, 16);
    return `${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}`;
  }

  // ==========================================
  // LANDING PAGE LINE CATALOG RENDERING
  // ==========================================

  setupLandingControls() {
    const heroInput = document.getElementById('landing-hero-search-input');
    const clearBtn = document.getElementById('btn-landing-search-clear');
    const filterTabs = document.querySelectorAll('#landing-filter-tabs .landing-filter-tab');
    const container = document.getElementById('landing-lines-container');
    const favGrid = document.getElementById('landing-favorites-grid');
    const nearbyGrid = document.getElementById('landing-nearby-grid');
    const zoneGrid = document.getElementById('zone-picker-grid');
    const dropdown = document.getElementById('landing-search-results-dropdown');

    heroInput?.addEventListener('input', (e) => {
      const rawVal = e.target.value;
      const q = rawVal.trim();
      if (clearBtn) clearBtn.style.display = rawVal ? 'block' : 'none';
      clearTimeout(this.landingSearchDebounceTimer);

      if (q.length < 1) {
        if (dropdown) {
          dropdown.classList.remove('active');
          dropdown.innerHTML = '';
        }
        this.landingSearch = '';
        this.landingSearchResults = null;
        this.renderLandingLines();
        return;
      }

      this.landingSearchDebounceTimer = setTimeout(async () => {
        this.landingSearch = q;
        try {
          const res = await fetch(`/api/search/stops?q=${encodeURIComponent(q)}`).then(r => r.json());
          if (res.success && Array.isArray(res.results)) {
            this.landingSearchResults = res.results;
            if (dropdown) {
              this.renderSearchResults(res.results, dropdown, heroInput);
            }
          }
        } catch (err) {
          console.error('[LandingSearch] Search error:', err);
        }
        this.renderLandingLines();
      }, 200);
    });

    heroInput?.addEventListener('focus', () => {
      if (heroInput.value.trim().length >= 1 && this.landingSearchResults && dropdown) {
        this.renderSearchResults(this.landingSearchResults, dropdown, heroInput);
      }
    });

    heroInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && dropdown) {
        dropdown.classList.remove('active');
      }
    });

    document.addEventListener('click', (e) => {
      if (heroInput && dropdown && !heroInput.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.classList.remove('active');
      }
    });

    clearBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      if (heroInput) {
        heroInput.value = '';
        heroInput.focus();
      }
      if (dropdown) {
        dropdown.classList.remove('active');
        dropdown.innerHTML = '';
      }
      clearBtn.style.display = 'none';
      this.landingSearch = '';
      this.landingSearchResults = null;
      this.renderLandingLines();
    });

    filterTabs.forEach(tab => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        filterTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.landingFilter = tab.getAttribute('data-filter') || 'all';
        this.renderLandingLines();
      });
    });

    // Action buttons: Nearby Stops GPS & Mataró Zones
    document.getElementById('btn-hero-geo')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.handleNearbyStopsRequest();
    });

    document.getElementById('btn-hero-zones')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.openZonePicker();
    });

    document.getElementById('btn-nearby-change-zone')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.openZonePicker();
    });

    document.getElementById('btn-nearby-close')?.addEventListener('click', (e) => {
      e.preventDefault();
      const sec = document.getElementById('landing-nearby-section');
      if (sec) sec.style.display = 'none';
    });

    document.getElementById('btn-header-favorites')?.addEventListener('click', (e) => {
      e.preventDefault();
      if (this.activeLineId) {
        this.navigateToLanding();
      }
      const favSection = document.getElementById('landing-favorites-section');
      if (favSection && this.favoriteStops.length > 0) {
        favSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        this.openZonePicker();
      }
    });

    document.getElementById('zone-picker-close-btn')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.closeZonePicker();
    });

    document.getElementById('zone-picker-modal-backdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'zone-picker-modal-backdrop') {
        this.closeZonePicker();
      }
    });

    // Favorites Grid Event Delegation
    favGrid?.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.btn-fav-remove');
      if (removeBtn) {
        e.stopPropagation();
        e.preventDefault();
        const stopId = removeBtn.getAttribute('data-stop-id');
        this.toggleFavoriteStop(stopId);
        return;
      }

      const card = e.target.closest('.landing-fav-card');
      if (card) {
        e.preventDefault();
        const stopId = card.getAttribute('data-stop-id');
        const stopName = card.getAttribute('data-stop-name');
        if (stopId) {
          this.inspectStop(stopId, stopName);
        }
      }
    });

    // Nearby Grid Event Delegation
    nearbyGrid?.addEventListener('click', (e) => {
      const card = e.target.closest('.landing-nearby-card');
      if (card) {
        e.preventDefault();
        const stopId = card.getAttribute('data-stop-id');
        const stopName = card.getAttribute('data-stop-name');
        if (stopId) {
          this.inspectStop(stopId, stopName);
        }
      }
    });

    // Zone Picker Grid Event Delegation
    zoneGrid?.addEventListener('click', (e) => {
      const card = e.target.closest('.zone-card');
      if (card) {
        e.preventDefault();
        const lat = parseFloat(card.getAttribute('data-lat'));
        const lon = parseFloat(card.getAttribute('data-lon'));
        const name = card.getAttribute('data-name');
        if (!isNaN(lat) && !isNaN(lon)) {
          this.closeZonePicker();
          this.loadNearbyStops(lat, lon, name);
        }
      }
    });

    // Single delegated click listener on container (eliminates thousands of closure allocations)
    container?.addEventListener('click', (e) => {
      const stopCard = e.target.closest('.landing-stop-card');
      if (stopCard) {
        e.preventDefault();
        const lineId = stopCard.getAttribute('data-line-id') || '1';
        const stopId = stopCard.getAttribute('data-stop-id');
        const stopName = stopCard.getAttribute('data-stop-name');
        const lat = parseFloat(stopCard.getAttribute('data-lat'));
        const lon = parseFloat(stopCard.getAttribute('data-lon'));
        if (dropdown) dropdown.classList.remove('active');
        this.switchLine(lineId);
        if (stopId) {
          this.setTargetStop(stopId);
          if (lat && lon) {
            this.mapController.focusTargetStop(lat, lon);
          }
          this.inspectStop(stopId, stopName);
        }
        return;
      }

      const card = e.target.closest('.landing-line-card');
      if (card) {
        e.preventDefault();
        const lineId = card.getAttribute('data-line-id');
        if (lineId) {
          if (dropdown) dropdown.classList.remove('active');
          this.switchLine(lineId);
        }
        return;
      }

      const expandBtn = e.target.closest('.btn-expand-landing-group');
      if (expandBtn) {
        e.preventDefault();
        const gId = expandBtn.getAttribute('data-group-id');
        if (gId) {
          this.expandedGroups.add(gId);
          this.renderLandingLines();
        }
      }
    });
  }

  renderLandingLines() {
    this.renderLandingFavorites();
    this.updateHeaderFavoritesBadge();

    const container = document.getElementById('landing-lines-container');
    if (!container) return;

    const q = (this.landingSearch || '').trim().toLowerCase();
    const activeFilter = this.landingFilter || 'all';

    const filterFn = (l) => {
      if (activeFilter !== 'all') {
        const matchId = String(l.id).toLowerCase() === activeFilter.toLowerCase() ||
                        String(l.code).toLowerCase() === `l${activeFilter}`.toLowerCase();
        if (!matchId) return false;
      }
      if (!q) return true;
      const code = (l.code || String(l.id)).toLowerCase();
      const name = (l.name || '').toLowerCase();
      const agency = (l.agency || '').toLowerCase();
      return code.includes(q) || name.includes(q) || agency.includes(q) || ('línia ' + code).includes(q) || ('linia ' + code).includes(q);
    };

    const linesToRender = this.availableLines.filter(filterFn);

    let stopsToRender = [];
    if (q && Array.isArray(this.landingSearchResults)) {
      stopsToRender = this.landingSearchResults.filter(r => !r.isLine && (r.type === 'stop' || r.stopId));
      if (!this.showTrainsInUI) {
        stopsToRender = stopsToRender.filter(r => !r.isTrain && !r.lineCode?.startsWith('R') && !r.agency?.toLowerCase().includes('rodalies') && !r.agency?.toLowerCase().includes('renfe'));
      }
      if (activeFilter !== 'all') {
        stopsToRender = stopsToRender.filter(s => {
          const lId = String(s.lineId || '').toLowerCase();
          const lCode = String(s.lineCode || '').toLowerCase();
          return lId === activeFilter.toLowerCase() || lCode === `l${activeFilter}`.toLowerCase();
        });
      }
    }

    if (linesToRender.length === 0 && stopsToRender.length === 0) {
      container.innerHTML = `
        <div style="padding: 3rem 1rem; text-align: center; color: var(--text-muted); background:var(--bg-card-gradient); border-radius:var(--radius-lg); border:1px solid var(--border-subtle);">
          <div style="width:36px; height:36px; border-radius:50%; background:rgba(148,163,184,0.12); color:var(--text-muted); display:flex; align-items:center; justify-content:center; margin:0 auto 0.75rem auto; font-size:1rem; font-weight:800;">?</div>
          <div style="font-size:1.1rem; font-weight: 700; color: #fff; margin-bottom: 0.35rem;">Cap línia ni parada trobada</div>
          <div style="font-size: 0.85rem; max-width:450px; margin:0 auto;">No hi ha cap resultat per a "${this.esc(this.landingSearch)}". Prova cercant per línia (ex: L1, L2, L3, 5, 8) o parada (ex: Hospital, Rodalies, Tereses).</div>
        </div>
      `;
      return;
    }

    let html = '';
    if (linesToRender.length > 0) {
      html += `
        <div class="landing-group-section">
          <div class="landing-group-header">
            <h3>Mataró Bus Urbà</h3>
            <span class="landing-group-badge">${linesToRender.length} línia${linesToRender.length === 1 ? '' : 'es'}</span>
          </div>
          <div class="landing-lines-grid">
            ${linesToRender.map(l => {
              const contrast = this.getContrastColor(l.color);
              const dirCount = l.directions ? `${l.directions.length} sentits` : 'En servei';
              return `
                <div class="landing-line-card" data-line-id="${this.esc(l.id)}" title="Fes clic per seguir la línia ${this.esc(l.code)} en directe">
                  <span class="landing-line-badge" style="background:${this.esc(l.color)}; color:${contrast};">${this.esc(l.code)}</span>
                  <div class="landing-line-info">
                    <div class="landing-line-title">${this.esc(l.name)}</div>
                    <div class="landing-line-operator">
                      <span>${this.esc(l.agency || 'Mataró Bus')}</span>
                      <span>•</span>
                      <span>${dirCount}</span>
                    </div>
                  </div>
                  <span class="landing-line-arrow">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
                  </span>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }

    if (stopsToRender.length > 0) {
      html += `
        <div class="landing-group-section" style="${linesToRender.length > 0 ? 'margin-top:1.5rem;' : ''}">
          <div class="landing-group-header">
            <h3>Parades trobades</h3>
            <span class="landing-group-badge">${stopsToRender.length} parada${stopsToRender.length === 1 ? '' : 'es'}</span>
          </div>
          <div class="landing-lines-grid">
            ${stopsToRender.map(s => {
              const contrast = this.getContrastColor(s.lineColor || '#009485');
              return `
                <div class="landing-line-card landing-stop-card" data-stop-id="${this.esc(s.stopId || s.code)}" data-stop-name="${this.esc(s.stopName || s.name)}" data-line-id="${this.esc(s.lineId || '1')}" data-lat="${this.esc(s.lat || '')}" data-lon="${this.esc(s.lon || '')}" title="Veure arribades a ${this.esc(s.stopName || s.name)}">
                  <span class="landing-line-badge" style="background:${this.esc(s.lineColor || '#009485')}; color:${contrast};">${this.esc(s.lineCode || 'Bus')}</span>
                  <div class="landing-line-info">
                    <div class="landing-line-title">${this.esc(s.stopName || s.name)}</div>
                    <div class="landing-line-operator">
                      <span>${this.esc(s.zone || 'Mataró Urbà')}${s.code ? ` • Codi: #${this.esc(s.code)}` : ''}</span>
                      ${s.directionText ? `<span>• ${this.esc(s.directionText)}</span>` : ''}
                    </div>
                  </div>
                  <span class="landing-line-arrow">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
                  </span>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }

    container.innerHTML = html;
  }
  renderLandingFavorites() {
    const section = document.getElementById('landing-favorites-section');
    const grid = document.getElementById('landing-favorites-grid');
    const badge = document.getElementById('fav-stops-count-badge');
    if (!section || !grid) return;

    if (!this.favoriteStops || this.favoriteStops.length === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';
    if (badge) badge.textContent = `${this.favoriteStops.length} parada${this.favoriteStops.length === 1 ? '' : 'es'}`;

    grid.innerHTML = this.favoriteStops.map(stop => {
      const linePills = (stop.lines && stop.lines.length > 0)
        ? stop.lines.map(l => `<span class="line-badge-sm" style="font-size:0.7rem; padding:1px 6px; background:var(--c10-primary);">${this.esc(l.code || l.id || l)}</span>`).join('')
        : '<span class="line-badge-sm" style="font-size:0.7rem; padding:1px 6px; background:var(--c10-primary);">L1..L8</span>';

      return `
        <div class="landing-fav-card" data-stop-id="${this.esc(stop.id)}" data-stop-name="${this.esc(stop.name)}">
          <div class="landing-fav-card-header">
            <div>
              <div class="landing-fav-title">${this.esc(stop.name)}</div>
              <div class="landing-fav-code">Codi #${this.esc(stop.code || stop.id)}</div>
            </div>
            <button type="button" class="btn-fav-remove" data-stop-id="${this.esc(stop.id)}" title="Treure de preferides">&times;</button>
          </div>
          <div class="landing-fav-lines">${linePills}</div>
          <div class="landing-fav-arrivals" id="fav-arrivals-${this.esc(stop.id)}">
            <div style="font-size:0.75rem; color:var(--text-muted); display:flex; align-items:center; gap:4px;">
              <span class="loading-spinner-inline" style="width:10px;height:10px;border-width:1.5px;"></span> Carregant arribades en directe...
            </div>
          </div>
        </div>
      `;
    }).join('');

    for (const stop of this.favoriteStops) {
      this.fetchAndRenderFavArrivals(stop.id);
    }
  }

  async fetchAndRenderFavArrivals(stopId) {
    const el = document.getElementById(`fav-arrivals-${stopId}`);
    if (!el) return;

    try {
      const res = await fetch(`/api/mataro/stop/${stopId}/departures`).then(r => r.json());
      const deps = res?.data?.departures || [];

      if (!document.getElementById(`fav-arrivals-${stopId}`)) return;

      if (deps.length === 0) {
        el.innerHTML = '<div style="font-size:0.75rem; color:var(--text-muted);">Sense busos previstos en els propers minuts</div>';
        return;
      }

      const topDeps = deps.slice(0, 2);
      el.innerHTML = topDeps.map(d => {
        const lineCode = d.lineId ? `L${String(d.lineId).replace(/^L/i, '')}` : 'Bus';
        const lineObj = this.availableLines?.find(l => String(l.id) === String(d.lineId) || String(l.code) === lineCode);
        const lineColor = lineObj?.color || d.lineColor || '#0ea5e9';
        const contrastColor = this.getContrastColor(lineColor);

        const minsAway = d.minutesAway !== undefined && d.minutesAway !== null ? d.minutesAway : null;
        const minsText = minsAway !== null
          ? (minsAway <= 0 ? 'Ara' : (minsAway === 1 ? '1 min' : `${minsAway} min`))
          : (d.departureTime || '--:--');

        // Clean delay badge without duplicated emojis or wrapping
        let delayBadge = '';
        if (d.isRealTime) {
          const rawText = String(d.delayBadgeText || '').replace(/^[🟢⏱️⚠️]\s*/, '').trim();
          if (rawText.toLowerCase().includes('regulaci') || (d.delayBadgeText && d.delayBadgeText.includes('⏱️'))) {
            delayBadge = `<span class="fav-status-badge status-regulation">Regulació</span>`;
          } else if (rawText.toLowerCase().includes('retard') || (d.delayMinutes && d.delayMinutes > 2)) {
            delayBadge = `<span class="fav-status-badge status-delay">+${d.delayMinutes || 3}m</span>`;
          } else {
            delayBadge = `<span class="fav-status-badge status-ontime">Puntual</span>`;
          }
        } else {
          delayBadge = `<span class="fav-status-badge status-scheduled">Teòric</span>`;
        }

        const cleanDest = (d.destination || 'Destí').replace(/^Cap a\s+/i, '').trim();

        return `
          <div class="landing-fav-arrival-pill">
            <div class="fav-arrival-route">
              <span class="fav-line-chip" style="background:${this.esc(lineColor)}; color:${contrastColor};">${this.esc(lineCode)}</span>
              <span class="fav-dest-text" title="${this.esc(cleanDest)}">${this.esc(cleanDest)}</span>
            </div>
            ${delayBadge}
            <span class="fav-countdown-badge ${minsAway !== null && minsAway <= 1 ? 'countdown-now' : ''}">${this.esc(minsText)}</span>
          </div>
        `;
      }).join('');
    } catch (_) {
      if (document.getElementById(`fav-arrivals-${stopId}`)) {
        el.innerHTML = '<div style="font-size:0.75rem; color:var(--text-muted);">Horari disponible en consultar</div>';
      }
    }
  }

  handleNearbyStopsRequest(...args) { return window.TransitStopFeatures.handleNearbyStopsRequest.apply(this, args); }

  openZonePicker(...args) { return window.TransitStopFeatures.openZonePicker.apply(this, args); }

  closeZonePicker(...args) { return window.TransitStopFeatures.closeZonePicker.apply(this, args); }

  loadNearbyStops(...args) { return window.TransitStopFeatures.loadNearbyStops.apply(this, args); }

  resolveBusForDeparture(dep, stopSeq = null, stopId = null, depIndex = 0) {
    const buses = this.activeLineData?.activeBuses || [];
    if (buses.length === 0 || !dep) return null;

    // A departure can only be linked to a physical bus if it has active telemetry
    const isLive = Boolean(dep.isRealTime || dep.isEstimated || dep.vehicleId || dep.tripId || dep.busCoords);
    if (!isLive) return null;

    // Resolve stop sequence from stops array if not given
    if (stopSeq === null && stopId && this.activeLineData?.stops) {
      const sIndex = this.activeLineData.stops.findIndex(s => 
        String(s.id) === String(stopId) || 
        String(s.gtfsStopId) === String(stopId) || 
        String(s.code) === String(stopId) ||
        String(s.mouteStopId) === String(stopId)
      );
      if (sIndex !== -1) {
        stopSeq = this.activeLineData.stops[sIndex].seq || (sIndex + 1);
      }
    }

    // 1. If explicit vehicleId / tripId is provided on departure:
    if (dep?.vehicleId || dep?.tripId) {
      const targetId = String(dep.vehicleId || dep.tripId).trim();
      const explicitBus = buses.find(b => this.mapController?.isBusSelected(b, targetId));
      if (explicitBus) {
        return explicitBus;
      }
    }

    // 2. If coordinates are provided, find matching bus
    if (dep?.busCoords?.lat && dep?.busCoords?.lon) {
      const coordBus = buses.find(b => 
        Math.abs(b.lat - dep.busCoords.lat) < 0.001 && 
        Math.abs(b.lon - dep.busCoords.lon) < 0.001
      );
      if (coordBus) {
        return coordBus;
      }
    }

    // 3. Find upstream approaching buses strictly ordered by proximity to target stop
    if (stopSeq !== null) {
      const upstreamBuses = buses.filter(b => {
        const bSeq = b.fromSeq || b.currentStopSeq || 0;
        return bSeq <= stopSeq;
      }).sort((a, b) => {
        const aSeq = a.fromSeq || a.currentStopSeq || 0;
        const bSeq = b.fromSeq || b.currentStopSeq || 0;
        return bSeq - aSeq; // Closest upstream bus first
      });

      if (depIndex < upstreamBuses.length) {
        return upstreamBuses[depIndex];
      }
    }

    return null;
  }

  focusBusOnMap(vehicleId, coords = null, stopSeq = null, stopId = null, depIndex = 0) {
    const buses = this.activeLineData?.activeBuses || [];
    let targetBus = null;

    if (this.activeLineData) {
      targetBus = this.resolveBusForDeparture(
        { vehicleId, busCoords: coords }, 
        stopSeq, 
        stopId, 
        depIndex
      );
    }

    if (targetBus) {
      vehicleId = targetBus.vehicleId || targetBus.tripId;
      coords = { lat: targetBus.lat, lon: targetBus.lon };
    } else if (!vehicleId && !coords && buses.length > 0) {
      targetBus = buses[0];
      vehicleId = targetBus.vehicleId || targetBus.tripId;
      coords = { lat: targetBus.lat, lon: targetBus.lon };
    }

    if (!vehicleId && !coords) {
      if (stopId && this.allStops) {
        const sObj = this.allStops.find(s => String(s.id || s.mouteStopId || s.code) === String(stopId));
        if (sObj?.lat && sObj?.lon) {
          this.mapController?.focusTargetStop(sObj.lat, sObj.lon);
        }
      } else {
        this.mapController?.fitRouteBounds();
      }
      const mapSection = document.getElementById('map-container') || document.querySelector('.explorer-grid');
      if (mapSection) {
        mapSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }
    this.selectedVehicleId = vehicleId;

    // If stop modal is currently open, close it cleanly
    const stopModal = document.getElementById('stop-modal-backdrop');
    if (stopModal && stopModal.classList.contains('active')) {
      stopModal.classList.remove('active');
    }

    // Highlight marker and zoom/pan to it
    this.mapController?.highlightBus(vehicleId, true, coords);
    this.mapController?.openBusPopup(vehicleId);

    // Fetch and render historical GPS breadcrumb trail for this bus
    if (vehicleId) {
      const requestedVehicleId = vehicleId;
      fetch(`/api/vehicle/${encodeURIComponent(vehicleId)}/trail`)
        .then(r => r.json())
        .then(res => {
          // Discard stale trail responses if user switched vehicle or line meanwhile
          if (this.selectedVehicleId !== requestedVehicleId || !this.activeLineId) return;
          if (res.success && res.trail && res.trail.length > 1) {
            const lineColor = this.activeLineData?.color || '#38bdf8';
            this.mapController?.renderVehicleTrail(res.trail, lineColor);
          }
        })
        .catch(() => {});
    }

    // Scroll viewport to map container smoothly
    const mapSection = document.getElementById('map-container') || document.querySelector('.explorer-grid');
    if (mapSection) {
      mapSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Refresh telemetry cockpit selection
    if (this.activeLineData) {
      this.renderTelemetryCockpit(this.activeLineData);
    }
  }

  // ==========================================
  // 2. DATA REFRESH ENGINE (POLYMORPHIC)
  // ==========================================

  async refreshAllData(shouldFitBounds = false) {
    if (this._isRefreshingData) return;
    this._isRefreshingData = true;
    this.secondsRemaining = this.fleetStreamOk ? 60 : this.pollInterval;
    this.updateCountdownLabel();
    try {
      const reqSeq = ++this.activeRequestSeq;
      const lId = this.activeLineId;
      const dir = this.activeDirection;
      if (!lId) return;

      const routeKey = `${lId}_${dir}`;
      const savedStopId = this.targetStopsByLine[routeKey] || null;

      // 0. Instant Optimistic Render from in-memory cache if available
      const cached = this.lineCache.get(routeKey);
      if (cached && !this.activeLineData) {
        this.activeLineData = cached;
        this.allStops = cached.stops || [];
        this.updateHeaderBrand(cached);
        this.renderLineBanner(cached);
        this.populateSelect('target-stop-select', this.allStops, savedStopId || this.allStops[0]?.id);
      }

      // 1. Kick off Line details and Target ETA in parallel
      const linePromise = fetch(`/api/line/${lId}?direction=${dir}`).then(r => r.json()).catch(() => ({ success: false }));
      const etaPromise = fetch(`/api/line/${lId}/target-eta?direction=${dir}${savedStopId ? `&stopId=${savedStopId}` : ''}`).then(r => r.json()).catch(() => ({ success: false }));

      // 2. Process Line details immediately (<5ms)
      const lineRes = await linePromise;

      // Guard: Discard stale responses only if user navigated to a different line or direction
      if (this.activeLineId !== lId || this.activeDirection !== dir) {
        return;
      }

      let activeTargetId = null;
      let lData = null;
      if (lineRes.success && lineRes.data) {
        lData = lineRes.data;
        this.activeLineData = lData;
        const isBoth = this.activeDirection === 'both' || lData.direction === 'both';

        // Set this.allStops properly to include all stops for accurate lookups and inspections
        if (isBoth && lData.allDirections && lData.allDirections.length > 1) {
          const merged = [];
          for (const dir of lData.allDirections) {
            for (const s of (dir.stops || [])) {
              const last = merged[merged.length - 1];
              // Avoid inserting duplicate consecutive turnaround stops
              if (!last || String(last.id || last.mouteStopId || last.code) !== String(s.id || s.mouteStopId || s.code)) {
                merged.push(s);
              }
            }
          }
          this.allStops = merged.map((s, idx) => ({ ...s, seq: idx + 1 }));
        } else if (isBoth && lData.secondaryStops && lData.secondaryStops.length > 0) {
          const merged = [...(lData.stops || [])];
          for (const s of lData.secondaryStops) {
            const last = merged[merged.length - 1];
            if (!last || String(last.id || last.mouteStopId || last.code) !== String(s.id || s.mouteStopId || s.code)) {
              merged.push(s);
            }
          }
          this.allStops = merged.map((s, idx) => ({ ...s, seq: idx + 1 }));
        } else {
          this.allStops = lData.stops || [];
        }

        this.activeBuses = lData.activeBuses || [];
        this.setLineCache(routeKey, lData);

        // Validate if savedStopId is in current route's stops; if not (or if not set), default to the 1st stop
        const isSavedValid = savedStopId && this.allStops.some(s => String(s.id || s.mouteStopId || s.code) === String(savedStopId));
        activeTargetId = isSavedValid 
          ? savedStopId 
          : (this.allStops[0]?.id || this.allStops[0]?.mouteStopId || this.allStops[0]?.code || null);

        // 1. Update Header, Banner & Directions immediately
        this.updateHeaderBrand(lData);
        this.renderLineBanner(lData);
        this.renderDisruptionsBanner(lData);

        const lineMeta = this.availableLines.find(l => String(l.id) === String(lId)) || lData;
        this.renderDirectionButtons(lineMeta.directions || lData.directions || [], this.activeDirection);
        this.populateSelect('target-stop-select', lData, activeTargetId);
        this.renderTelemetryCockpit(lData);
        this.renderRouteTimeline(lData, activeTargetId);
        this.renderStopsBrowser(lData, lId);

        // 2. Render Map Route & Bus Markers immediately
        this.updateActiveBusesCount(this.activeBuses.length, lData);
        const lineColor = lData.color || '#009485';
        const coords = lData.coords || lData.polyline || lData.allDirections?.[0]?.coords || lData.allDirections?.[0]?.polyline || [];
        const secondaryCoords = isBoth ? (lData.secondaryCoords || lData.allDirections?.[1]?.coords || lData.allDirections?.[1]?.polyline || null) : null;
        const secondaryStops = isBoth ? (lData.secondaryStops || lData.allDirections?.[1]?.stops || null) : null;
        const secondaryColor = isBoth ? (lData.secondaryColor || '#38bdf8') : '#38bdf8';
        const primaryStopsForMap = lData.stops || [];

        this.mapController.renderStops(
          primaryStopsForMap, 
          activeTargetId, 
          (s) => this.inspectStop(s.id || s.mouteStopId, s.name), 
          shouldFitBounds, 
          lineColor, 
          coords,
          secondaryCoords,
          secondaryStops,
          secondaryColor,
          lId,
          dir,
          lData.geometryEstimated === undefined ? null : { estimated: Boolean(lData.geometryEstimated), source: String(lData.geometrySource || '') }
        );
        this.mapController.updateBusMarkers(
          this.activeBuses, 
          lineColor, 
          secondaryColor, 
          this.selectedVehicleId,
          (bus) => {
            this.selectedVehicleId = bus.tripId || bus.vehicleId;
            this.renderTelemetryCockpit(lData);
            this.mapController?.highlightBus(this.selectedVehicleId, false);
          },
          lId
        );

        // 2.1 Process pending shared link focus (bus, stop, or search query)
        this.processPendingSharedFocus(lData);
      }

      // 3. Asynchronously handle Target Stop ETA without delaying map transition
      etaPromise.then(etaRes => {
        if (this.activeLineId !== lId || this.activeDirection !== dir) return;
        const lineContext = this.activeLineData || lData;
        if (etaRes && etaRes.success && etaRes.data) {
          const targetStopId = activeTargetId || etaRes.data.targetStop?.id || savedStopId;
          if (targetStopId) {
            this.setTargetEtaCache(`${routeKey}_${targetStopId}`, etaRes.data);
          }
          this.renderTargetCard(etaRes.data, lineContext);
          this.renderTelemetryCockpit(lineContext, etaRes.data);
          this.checkArrivalAlerts(lineContext, activeTargetId);
        } else {
          // Fallback if target-eta returned unready or error
          const fallbackStop = this.allStops.find(s => String(s.id || s.mouteStopId || s.code) === String(activeTargetId)) || this.allStops[0];
          if (fallbackStop) {
            this.renderTargetCard({
              targetStop: fallbackStop,
              nextBus: null,
              upcomingDepartures: []
            }, lineContext);
          }
        }
      }).catch(err => {
        console.error('Target ETA async handler error:', err);
      });

      this.secondsRemaining = this.fleetStreamOk ? 60 : this.pollInterval;
      this.updateCountdownLabel();
    } catch (err) {
      console.error('Data refresh error:', err);
    } finally {
      this._isRefreshingData = false;
    }
  }

  updateHeaderBrand(lData) {
    const code = lData.code || lData.id || 'C-10';
    const mapTitle = document.getElementById('map-line-title');
    if (mapTitle) {
      mapTitle.textContent = `Traçat ${code} i parades en temps real`;
    }
  }

  renderLineBanner(lData) {
    const badge = document.getElementById('active-line-badge');
    const city = document.getElementById('active-line-city-name');
    const title = document.getElementById('active-line-title');

    const code = lData.code || lData.id || 'C-10';
    const color = lData.color || '#009485';
    const calTag = lData.calendarInfo?.calendarTag || lData.serviceStatus?.calendarTag || '';

    if (badge) {
      badge.textContent = code;
      badge.style.background = color;
      badge.style.color = this.getContrastColor(color);
    }

    if (city) {
      const text = calTag ? `${lData.agency || 'Xarxa de Transport'} • 📅 ${calTag}` : (lData.agency || 'Xarxa de Transport');
      if (lData.operatorWebsite) {
        city.innerHTML = `${this.esc(text)} • <a href="${this.safeUrl(lData.operatorWebsite)}" target="_blank" rel="noopener noreferrer" class="line-website-link" style="color:var(--brand-primary, #38bdf8); text-decoration:underline; font-weight:600; cursor:pointer;" title="Consultar horaris PDF oficials">📄 Web PDF oficial ↗</a>`;
      } else {
        city.textContent = text;
      }
    }

    if (title) {
      const name = lData.name || '';
      if (!name || name.toLowerCase() === code.toLowerCase()) {
        title.textContent = code;
      } else if (name.toLowerCase().startsWith(code.toLowerCase())) {
        title.textContent = name;
      } else {
        title.textContent = `${code} — ${name}`;
      }
    }

    // Render 24h Delay & Reliability Telemetry Metric
    this.renderLineDelayStats(lData);
  }

  async renderLineDelayStats(lData) {
    const pillEl = document.getElementById('line-stat-pill');
    const delayValEl = document.getElementById('line-stat-delay-val');
    const avgValEl = document.getElementById('line-stat-avg-val');
    const statsContainer = document.getElementById('line-selector-stats');
    if (!delayValEl) return;

    if (statsContainer) {
      statsContainer._currentLineQuery = lData?.code || lData?.id || this.activeLineId || 'C-10';
      if (!statsContainer._boundClick) {
        statsContainer._boundClick = true;
        statsContainer.addEventListener('click', () => {
          this.openJournalismModal(24, statsContainer._currentLineQuery);
        });
        statsContainer.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            this.openJournalismModal(24, statsContainer._currentLineQuery);
          }
        });
      }
    }

    let stats = lData?.delayStats || null;
    const lId = lData?.id || lData?.code || 'c10';

    if (!stats) {
      try {
        const res = await fetch(`/api/line/${encodeURIComponent(lId)}/stats`).then(r => r.json());
        // Discard stale response if the user switched lines while fetching
        if (String(this.activeLineId || '').toLowerCase() !== String(lId).toLowerCase()) return;
        if (res.success && res.stats) {
          stats = res.stats;
        }
      } catch (err) {
        // Silently continue
      }
    }

    const latePct = (stats && typeof stats.latePct === 'number') ? stats.latePct : 0;
    const avgDelay = (stats && typeof stats.avgDelayMins === 'number' && stats.totalSamples > 0) ? `${stats.avgDelayMins} min` : '-- min';

    delayValEl.textContent = `${latePct}%`;
    if (avgValEl) avgValEl.textContent = avgDelay;

    if (pillEl) {
      pillEl.classList.remove('moderate', 'severe');
      if (latePct > 25) {
        pillEl.classList.add('severe');
      } else if (latePct > 10) {
        pillEl.classList.add('moderate');
      }
    }
  }

  /**
   * HTML-escapes an upstream/user-derived string so it can never break out of
   * its element context when interpolated into innerHTML templates.
   */
  esc(value) {
    if (typeof window !== 'undefined' && window.TransitUtils && typeof window.TransitUtils.esc === 'function') {
      return window.TransitUtils.esc(value);
    }
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  timeStringToSeconds(value) {
    if (typeof window !== 'undefined' && window.TransitUtils && typeof window.TransitUtils.timeStringToSeconds === 'function') {
      return window.TransitUtils.timeStringToSeconds(value);
    }
    if (!value || typeof value !== 'string' || !value.includes(':')) return 0;
    const [h, m] = value.split(':').map(Number);
    return (isNaN(h) || isNaN(m)) ? 0 : (h * 3600 + m * 60);
  }

  /**
   * Strips seconds from a time string (e.g. '11:53:00' -> '11:53').
   * @param {string} value
   * @returns {string}
   */
  formatTimeHHMM(value) {
    if (typeof window !== 'undefined' && window.TransitUtils && typeof window.TransitUtils.formatTimeHHMM === 'function') {
      return window.TransitUtils.formatTimeHHMM(value);
    }
    if (!value || typeof value !== 'string') return value || '--:--';
    return value.replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1');
  }

  /**
   * Sanitizes a URL for safe use inside href/src attributes.
   * Only absolute http(s) URLs and same-origin relative paths are allowed;
   * everything else (e.g. javascript:, data:) returns '#'.
   */
  safeUrl(value) {
    const str = String(value || '').trim();
    if (/^https?:\/\//i.test(str)) return this.esc(str);
    if (/^\//.test(str) && !str.startsWith('//')) return this.esc(str);
    return '#';
  }

  /**
   * Makes a string safe for interpolation inside a single-quoted JS string
   * within an inline on* handler attribute (strips quote/backslash/angle chars).
   */
  jsSafe(value) {
    return String(value === null || value === undefined ? '' : value).replace(/['"\\<>`]/g, '');
  }

  decodeHtml(str) {
    if (!str) return '';
    const txt = document.createElement('textarea');
    txt.innerHTML = str;
    return txt.value
      .replace(/&nbsp;/gi, ' ')
      .replace(/&middot;/gi, '·')
      .replace(/&#39;/g, "'")
      .replace(/<[^>]*>?/gm, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  renderDisruptionsBanner(lData) {
    const banner = document.getElementById('route-disruption-banner');
    const titleEl = document.getElementById('disruption-banner-title');
    const descEl = document.getElementById('disruption-banner-desc');
    const chipCount = document.getElementById('incidents-count-text');

    const lId = String(lData.lineId || lData.id || this.activeLineId || '');
    const disruptions = (lData.disruptions || []).filter(d => 
      this.isDisruptionActive(d) &&
      d.severity === 'warning' && (
        (Array.isArray(d.linesAffected) && d.linesAffected.includes(lId)) ||
        (!d.linesAffected || d.linesAffected.length === 0)
      )
    );

    if (chipCount) {
      chipCount.textContent = disruptions.length > 0 ? `${disruptions.length} Avisos` : 'Avisos';
    }

    if (!banner || !titleEl || !descEl) return;

    if (disruptions.length > 0) {
      const d = disruptions[0];
      titleEl.textContent = `⚠️ Avís de servei: ${this.decodeHtml(d.title)}`;
      descEl.textContent = this.decodeHtml(d.description || d.affectedStops || 'Afectacions al recorregut habitual d\'aquesta línia.');

      const btn = document.getElementById('btn-view-disruption-details');
      if (btn) {
        btn.textContent = 'Veure detall';
        btn.onclick = (e) => {
          e.preventDefault();
          this.openDisruptionsModal();
        };
      }
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }
  }

  isDisruptionActive(d) {
    if (!d) return false;
    if (d.active === false) return false;
    const now = Date.now();
    if (d.expiresAt) {
      const expTime = new Date(d.expiresAt).getTime();
      if (!isNaN(expTime) && expTime < now) return false;
    }

    const text = ((d.title || '') + ' ' + (d.description || '')).toLowerCase();
    if (/fins(?:\s+a)?\s+nou\s+av[ií]s|hasta\s+nuevo\s+aviso/i.test(text)) {
      return true;
    }

    const currentYear = new Date().getFullYear();
    const dates = [];

    // 'del 01/09 al 02/09'
    const rangeRegex = /(?:del|des de|des del)\s+(\d{1,2})[\/\.-](\d{1,2})(?:[\/\.-](\d{2,4}))?\s+(?:al|fins al|fins el|fins a|fins|a|fins les|hasta el)\s+(\d{1,2})[\/\.-](\d{1,2})(?:[\/\.-](\d{2,4}))?/gi;
    let m;
    while ((m = rangeRegex.exec(text)) !== null) {
      const day = parseInt(m[4], 10);
      const month = parseInt(m[5], 10);
      let year = m[6] ? parseInt(m[6], 10) : currentYear;
      if (year < 100) year += 2000;
      dates.push(new Date(year, month - 1, day, 23, 59, 59));
    }

    // '05/09/2026'
    const standaloneRegex = /\b(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{4})\b/g;
    while ((m = standaloneRegex.exec(text)) !== null) {
      const day = parseInt(m[1], 10);
      const month = parseInt(m[2], 10);
      const year = parseInt(m[3], 10);
      dates.push(new Date(year, month - 1, day, 23, 59, 59));
    }

    // Time check like 'a 22.30 hores'
    const timeRegex = /(?:a|fins a|fins les|fins a les)\s+(\d{1,2})[.:](\d{2})\s*(?:h|hores)?/gi;
    let lastTime = null;
    while ((m = timeRegex.exec(text)) !== null) {
      lastTime = m;
    }

    if (dates.length > 0) {
      dates.sort((a, b) => b.getTime() - a.getTime());
      const expiry = dates[0];
      if (lastTime) {
        const h = parseInt(lastTime[1], 10);
        const min = parseInt(lastTime[2], 10);
        if (h >= 0 && h <= 23 && min >= 0 && min <= 59) {
          expiry.setHours(h, min, 0, 0);
        }
      }
      if (expiry.getTime() < now) {
        return false;
      }
    }

    return true;
  }

  async openDisruptionsModal(filterQuery = '') {
    const backdrop = document.getElementById('disruptions-modal-backdrop');
    const container = document.getElementById('disruptions-list-container');
    const searchInput = document.getElementById('disruptions-search-input');
    if (!backdrop || !container) return;

    backdrop.classList.add('active');
    if (searchInput && filterQuery) {
      searchInput.value = filterQuery;
    }

    try {
      container.innerHTML = '<div style="text-align:center; padding:2rem; color:var(--text-muted);">Carregant avisos de servei en temps real...</div>';
      const res = await fetch('/api/disruptions').then(r => r.json());
      const disruptions = (res.disruptions || []).filter(d => this.isDisruptionActive(d));

      this.renderDisruptionsList(disruptions, searchInput ? searchInput.value : '');

      if (searchInput) {
        searchInput.oninput = (e) => {
          this.renderDisruptionsList(disruptions, e.target.value);
        };
      }
    } catch(err) {
      container.innerHTML = `<div style="text-align:center; padding:2rem; color:var(--text-muted);">Error en carregar incidències: ${this.esc(err.message)}</div>`;
    }
  }

  renderDisruptionsList(disruptions, query = '') {
    const container = document.getElementById('disruptions-list-container');
    if (!container) return;

    const q = (query || '').toLowerCase().trim();
    const filtered = disruptions.filter(d => {
      if (!this.isDisruptionActive(d)) return false;
      if (!q) return true;
      return (d.title || '').toLowerCase().includes(q) ||
             (d.affectedLines || '').toLowerCase().includes(q) ||
             (d.affectedCities || '').toLowerCase().includes(q) ||
             (d.description || '').toLowerCase().includes(q);
    });

    if (filtered.length === 0) {
      container.innerHTML = '<div style="text-align:center; padding:2rem; color:var(--text-muted);">No s\'ha trobat cap incidència amb aquest filtre.</div>';
      return;
    }

    container.innerHTML = filtered.map(d => `
      <div class="disruption-item-card">
        <div class="disruption-header-row">
          <span class="disruption-title">⚠️ ${this.esc(this.decodeHtml(d.title))}</span>
          ${d.affectedCities ? `<span class="disruption-tag">📍 ${this.esc(this.decodeHtml(d.affectedCities.trim()))}</span>` : ''}
        </div>
        ${d.affectedLines ? `<div class="disruption-lines-badge">${CANONICAL_BUS_ICON_SVG} ${this.esc(this.decodeHtml(d.affectedLines))}</div>` : ''}
        ${d.affectedStops ? `<div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:0.4rem;">🚏 ${this.esc(this.decodeHtml(d.affectedStops))}</div>` : ''}
        <div class="disruption-body-text">${this.esc(this.decodeHtml(d.description))}</div>
      </div>
    `).join('');
  }

  // ==========================================
  // 1.5 JOURNALISM & HISTORICAL DELAY ANALYTICS
  // ==========================================

  openJournalismModal(hours = 24, initialFilter = null) {
    const params = new URLSearchParams();
    if (hours && Number(hours) !== 24) params.set('h', String(hours));
    if (initialFilter) params.set('q', String(initialFilter));
    const qs = params.toString() ? '?' + params.toString() : '';
    window.location.href = `/dades${qs}`;
  }

  closeJournalismModal() {
    // Extracted to standalone /dades page
  }

  handleJournalismSort(tableKey, columnKey) {
    if (!this.journalismSorts) {
      this.journalismSorts = {};
    }
    const current = this.journalismSorts[tableKey] || { key: null, asc: false };
    if (current.key === columnKey) {
      current.asc = !current.asc;
    } else {
      current.key = columnKey;
      current.asc = columnKey === 'lineCode' || columnKey === 'agency' || columnKey === 'stopName' || columnKey === 'overallRank';
    }
    this.journalismSorts[tableKey] = current;
    if (this.currentJournalismReport) {
      this.renderJournalismReport(this.currentJournalismReport);
    }
  }

  setWorstStopsLimit(limit) {
    this.journalismWorstStopsLimit = Number(limit) || 10;
    if (this.currentJournalismReport) {
      this.renderJournalismReport(this.currentJournalismReport);
    }
  }

  renderJournalismReport(report) {
    const container = document.getElementById('journalism-content-container');
    if (!container) return;

    this.currentJournalismReport = report;
    if (!this.journalismSorts) {
      this.journalismSorts = {
        mostDelayed: { key: 'avgDelay', asc: false },
        worstStops: { key: 'avgDelay', asc: false },
        agencies: { key: 'totalSamples', asc: false }
      };
    }
    const filterText = (this.journalismFilterText || '').trim().toLowerCase();
    const norm = (str) => String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const cleanFilter = norm(filterText);

    const s = report.summary || {};
    const isAllStopsMode = this.journalismStopFilterMode === 'all';
    const allStopsSource = (report.allStopDelays && report.allStopDelays.length > 0)
      ? report.allStopDelays
      : (report.rankingWorstStops || []);
    const bottlenecksSource = (report.rankingWorstStops && report.rankingWorstStops.length > 0)
      ? report.rankingWorstStops
      : allStopsSource.filter(s => s.isBottleneck);

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

    // Apply text search filtering (with punctuation-agnostic matching e.g. c10 matches C-10)
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

    // Helper sort function
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

    mostDelayed = applySort(mostDelayed, this.journalismSorts.mostDelayed);
    worstStops = applySort(worstStops, this.journalismSorts.worstStops);
    agencies = applySort(agencies, this.journalismSorts.agencies);

    const getSortIndicator = (tableKey, colKey) => {
      const cur = this.journalismSorts[tableKey];
      if (cur && cur.key === colKey) {
        return cur.asc ? '<span style="color:var(--brand-primary); margin-left:4px;">▲</span>' : '<span style="color:var(--brand-primary); margin-left:4px;">▼</span>';
      }
      return '<span style="opacity:0.3; margin-left:4px;">↕</span>';
    };

    let html = `
      <!-- Pre-generated 30-min Cache Banner -->
      ${report.meta?.generatedAt ? `
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem; background:rgba(0,148,133,0.08); border:1px solid rgba(0,148,133,0.22); border-radius:10px; padding:0.55rem 0.85rem; margin-bottom:1.1rem; font-size:0.76rem;">
          <div style="display:flex; align-items:center; gap:0.4rem; color:var(--text-primary);">
            <span>⚡</span>
            <span><strong>Informe pregenerat</strong>: compilat a les <strong>${new Date(report.meta.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong> (actualització automàtica cada 30 min)</span>
          </div>
          <div style="display:flex; align-items:center; gap:0.6rem;">
            <span style="color:var(--brand-primary); font-weight:600; font-size:0.72rem;">⏱️ Càrrega instantània</span>
          </div>
        </div>
      ` : ''}

      <!-- KPI Stats Grid -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:0.75rem; margin-bottom:1.25rem;">
        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:0.9rem;">
          <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase;">Arribades Analitzades</div>
          <div style="font-size:1.6rem; font-weight:700; color:var(--brand-primary); margin-top:0.2rem;">${(s.totalRecordedArrivals || 0).toLocaleString()}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${s.monitoredLinesCount || 0} línies monitorades</div>
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:0.9rem;">
          <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase;">Puntualitat Global</div>
          <div style="font-size:1.6rem; font-weight:700; color:${s.networkPunctualityPct >= 85 ? '#10b981' : '#f59e0b'}; margin-top:0.2rem;">${s.networkPunctualityPct || 100}%</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">Arribades en &le; 3 min de marge</div>
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:0.9rem;">
          <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase;">Retard Mitjà Xarxa</div>
          <div style="font-size:1.6rem; font-weight:700; color:#38bdf8; margin-top:0.2rem;">${Number(s.networkAvgDelay) > 0 ? '+' : ''}${s.networkAvgDelay || 0} min</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">Puntualitat de referència</div>
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:0.9rem;">
          <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase;">Retard Màxim Registrat</div>
          <div style="font-size:1.6rem; font-weight:700; color:#ef4444; margin-top:0.2rem;">${Number(s.networkMaxDelay) > 0 ? '+' : ''}${s.networkMaxDelay || 0} min</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">Afectació puntual extrema</div>
        </div>
      </div>

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
        <div class="hourly-delays-section">
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

          <!-- 24-Hour / Service Hours Congestion Bar Chart -->
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
            <div style="font-size:0.8rem; font-weight:700; color:var(--text-secondary); margin-top:0.25rem;">
              Franges amb Més Retards:
            </div>
            <div class="peak-hours-grid">
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
                      <span class="bottlenecks-title">📍 Colls d'ampolla en aquesta hora:</span>
                      <div class="bottlenecks-list">
                        ${ph.worstStopsDuringHour.map(bs => `
                          <div class="bottleneck-item">
                            <span class="bottleneck-stop" title="${this.esc(bs.stopName)}">📍 ${this.esc(bs.stopName)}</span>
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

      <!-- Ranking: Most Delayed Lines -->
      <div class="observatori-table-container">
        <div class="observatori-table-header-row">
          <h4 class="observatori-table-title">
            <span style="display:flex; align-items:center; gap:0.4rem;">🚨 Línies amb Més Retard Acumulat</span>
          </h4>
          <span class="observatori-table-subtitle">Clica a les capçaleres per ordenar ↕</span>
        </div>
        ${mostDelayed.length === 0 ? '<div style="color:var(--text-muted); font-size:0.85rem; padding:0.8rem; background:var(--bg-elevated); border-radius:8px;">Sense retards registrats o cap línia coincideix amb el filtre.</div>' : `
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
                    <th class="observatori-col-desktop" data-sort-table="mostDelayed" data-sort-key="agency" role="button" tabindex="0">Operador ${getSortIndicator('mostDelayed', 'agency')}</th>
                    <th data-sort-table="mostDelayed" data-sort-key="avgDelay" role="button" tabindex="0">Retard Mitjà ${getSortIndicator('mostDelayed', 'avgDelay')}</th>
                    <th class="observatori-col-desktop" data-sort-table="mostDelayed" data-sort-key="maxDelay" role="button" tabindex="0">Retard Màx. ${getSortIndicator('mostDelayed', 'maxDelay')}</th>
                    <th data-sort-table="mostDelayed" data-sort-key="latePercentage" role="button" tabindex="0">% Expedicions Tardanes ${getSortIndicator('mostDelayed', 'latePercentage')}</th>
                    <th style="text-align:center; min-width:105px;">Incidents</th>
                  </tr>
                </thead>
                <tbody>
                  ${mostDelayed.map((l, i) => {
                    const avgStr = Number(l.avgDelay) > 0 ? `+${l.avgDelay} min` : (Number(l.avgDelay) < 0 ? `${l.avgDelay} min` : '0.0 min');
                    const maxStr = Number(l.maxDelay) > 0 ? `+${l.maxDelay} min` : `${l.maxDelay || 0} min`;
                    return `
                    <tr data-open-line="${this.esc(l.lineId || l.lineCode)}" style="cursor:pointer;" title="Clica per veure la línia ${this.esc(l.lineCode)} al mapa">
                      <td class="sticky-col" style="font-weight:700; color:var(--brand-primary);">
                        <div class="observatori-line-cell">
                          <div>
                            <span style="background:${this.esc(l.color || 'var(--brand-primary)')}; color:#fff; padding:0.15rem 0.45rem; border-radius:6px; font-size:0.75rem; display:inline-block; font-weight:800;">${this.esc(l.lineCode)}</span>
                          </div>
                          ${l.name && l.name !== l.lineCode ? `<span class="observatori-line-name" title="${this.esc(l.name)}">${this.esc(l.name)}</span>` : ''}
                          <span class="observatori-line-agency observatori-mobile-only">${this.esc(l.agency)}</span>
                        </div>
                      </td>
                      <td class="observatori-col-desktop" style="color:var(--text-muted); white-space:nowrap;">${this.esc(l.agency)}</td>
                      <td style="font-weight:700; color:${Number(l.avgDelay) > 0 ? '#ef4444' : '#10b981'}; white-space:nowrap;">${avgStr}</td>
                      <td class="observatori-col-desktop" style="color:var(--text-muted); white-space:nowrap;">${maxStr}</td>
                      <td style="white-space:nowrap; text-align:center;">
                        <span style="background:rgba(239,68,68,0.15); color:#f87171; padding:0.15rem 0.45rem; border-radius:6px; font-weight:600;">${l.latePercentage}%</span>
                      </td>
                      <td style="white-space:nowrap; text-align:center;">
                        <button type="button" class="btn-locate-incident-stop" data-inspect-line="${this.esc(l.lineCode || l.lineId)}" title="Investigar retards i incidents crítics de ${this.esc(l.lineCode)}">
                          <span>🔍 Investigar</span>
                        </button>
                      </td>
                    </tr>
                  `;}).join('')}
                </tbody>
              </table>
            </div>
          `}
        </div>

        <!-- Ranking: Worst Stops (Bottlenecks) -->
        ${(() => {
          const worstLimit = this.journalismWorstStopsLimit || 10;
          const totalWorst = worstStops.length;
          const displayedWorstStops = worstStops.slice(0, worstLimit);
          const hasMoreWorst = totalWorst > worstLimit;
          const isGroupedByLine = !!this.journalismGroupByLine;

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
            const isLight = lColor === '#ffcc00' || lColor === '#febf01';
            const badgeTextColor = isLight ? '#000' : '#fff';
            const isSevereStop = sAvg >= 1.5 || (st.severeLatePct || 0) >= 20;
            const avgDelayColor = sAvg >= 1.5 ? '#ef4444' : (sAvg >= 0.8 ? '#f59e0b' : '#10b981');
            return `
            <tr>
              <td class="sticky-col" style="font-weight:600; color:var(--text-primary);">
                <div class="observatori-stop-cell">
                  <span class="observatori-rank-num ${isSevereStop && st.overallRank <= 3 ? 'rank-' + st.overallRank : ''}" title="Rànquing: #${st.overallRank}">#${st.overallRank}</span>
                  <span style="color:${isSevereStop ? '#f59e0b' : '#10b981'}; flex-shrink:0;">${isSevereStop ? '📍' : '✓'}</span>
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
                  <span style="background:${st.severeLatePct >= 30 ? 'rgba(239,68,68,0.2)' : (st.severeLatePct >= 20 ? 'rgba(245,158,11,0.15)' : 'rgba(255,255,255,0.06)')}; color:${st.severeLatePct >= 30 ? '#f87171' : (st.severeLatePct >= 20 ? '#fbbf24' : 'var(--text-muted)')}; padding:0.15rem 0.45rem; border-radius:6px; font-weight:600;">${st.severeLatePct}%</span>
                ` : '<span style="color:#10b981; font-weight:600; font-size:0.75rem;">0%</span>'}
              </td>
              <td style="white-space:nowrap;">
                ${st.criticalHour && st.criticalHour !== '--' && Number(st.criticalHourAvgDelay) >= 1.5 ? `
                  <div class="bottleneck-hour-badge" title="Retard mitjà en aquesta franja: +${st.criticalHourAvgDelay} min">
                    <span class="badge-time">${this.esc(st.criticalHour)}</span>
                    <span class="badge-delay">(+${st.criticalHourAvgDelay}m)</span>
                  </div>
                ` : (isSevereStop ? '<span style="color:var(--text-muted); font-size:0.75rem;">Uniforme</span>' : '<span style="color:#10b981; font-size:0.75rem; font-weight:600;">✓ Puntual</span>')}
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
              const isLight = lColor === '#ffcc00' || lColor === '#febf01';
              const badgeTextColor = isLight ? '#000' : '#fff';
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
                        <span>Retard mitjà: <strong style="color:${Number(lineAvg) >= 3 ? '#ef4444' : '#f59e0b'};">+${lineAvg} min</strong></span>
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
          <div class="observatori-table-container">
            ${stopNoticeHtml}
            <div class="observatori-table-header-row">
              <h4 class="observatori-table-title">
                <span>${isAllStopsMode ? '📍 Totes les Parades per Retard Mitjà' : "📍 Colls d'Ampolla: Parades amb Més Retard"}</span>
                <span class="observatori-table-subtitle">(Mostrant ${displayedWorstStops.length} de ${totalWorst}${isGroupedByLine ? ' • Agrupat per línia' : ''})</span>
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
        <div class="observatori-table-container">
          <div class="observatori-table-header-row">
            <h4 class="observatori-table-title">
              <span style="display:flex; align-items:center; gap:0.4rem;">🏢 Comparativa per Empresa Operadora</span>
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
                  <th class="observatori-col-desktop" data-sort-table="agencies" data-sort-key="totalSamples" role="button" tabindex="0">Mostres ${getSortIndicator('agencies', 'totalSamples')}</th>
                  <th data-sort-table="agencies" data-sort-key="avgDelay" role="button" tabindex="0">Retard Mitjà ${getSortIndicator('agencies', 'avgDelay')}</th>
                  <th data-sort-table="agencies" data-sort-key="onTimePct" role="button" tabindex="0">Índex de Puntualitat ${getSortIndicator('agencies', 'onTimePct')}</th>
                </tr>
              </thead>
              <tbody>
                ${agencies.map((a, i) => `
                  <tr>
                    <td class="sticky-col" style="font-weight:600;">
                      <div class="observatori-agency-cell">
                        <span class="observatori-agency-name" title="${this.esc(a.agency)}">${this.esc(a.agency)}</span>
                        <span class="observatori-agency-sub observatori-mobile-only">${a.linesCount} línies • ${Number(a.totalSamples || 0).toLocaleString()} mostres</span>
                      </div>
                    </td>
                    <td class="observatori-col-desktop" style="color:var(--text-muted); white-space:nowrap; text-align:center;">${a.linesCount}</td>
                    <td class="observatori-col-desktop" style="color:var(--text-muted); white-space:nowrap;">${Number(a.totalSamples || 0).toLocaleString()}</td>
                    <td style="font-weight:700; color:${a.avgDelay > 3 ? '#ef4444' : '#10b981'}; white-space:nowrap;">+${a.avgDelay} min</td>
                    <td style="white-space:nowrap; text-align:center;">
                      <span style="background:${a.onTimePct >= 85 ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)'}; color:${a.onTimePct >= 85 ? '#34d399' : '#fbbf24'}; padding:0.15rem 0.45rem; border-radius:6px; font-weight:600;">${a.onTimePct}%</span>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>

      <!-- 3-Day Route Snapshot & Resilience Engine Card -->
      ${report.snapshotInfo ? `
        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:1.1rem; margin-top:1.5rem;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:0.5rem; margin-bottom:0.75rem;">
            <div>
              <div style="display:flex; align-items:center; gap:0.4rem; font-weight:700; font-size:0.92rem; color:var(--brand-primary);">
                <span>📦</span>
                <span>Captura Diària de Rutes (Històric 3 Dies)</span>
              </div>
              <p style="font-size:0.75rem; color:var(--text-muted); margin-top:0.2rem;">
                Totes les línies, parades i geometries (incloent e11.1, e11.2, C-10, Mataró Bus, Moventis, Sagalés i AMB) es capturen diàriament per garantir la continuïtat del servei fins i tot en cas de caiguda de l'API.
              </p>
            </div>
            <span style="background:rgba(16,185,129,0.15); color:#10b981; font-size:0.72rem; padding:0.25rem 0.55rem; border-radius:6px; font-weight:600;">
              🛡️ Resiliència Offline Activa (3 Dies)
            </span>
          </div>

          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:0.6rem; margin-top:0.6rem;">
            ${(report.snapshotInfo.snapshots || []).map(snap => `
              <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:8px; padding:0.65rem;">
                <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.78rem; font-weight:700;">
                  <span>📅 ${snap.date}</span>
                  <span style="color:var(--brand-primary); font-size:0.7rem;">${(snap.sizeBytes / 1024).toFixed(0)} KB</span>
                </div>
                <div style="font-size:0.72rem; color:var(--text-muted); margin-top:0.3rem;">
                  ${snap.summary.totalRoutes} línies • ${snap.summary.totalStops} parades troncals
                </div>
              </div>
            `).join('')}
          </div>

          ${report.snapshotInfo.diff ? `
            <div style="margin-top:0.75rem; font-size:0.74rem; color:var(--text-muted); display:flex; align-items:center; gap:0.4rem; border-top:1px solid var(--border-subtle); padding-top:0.6rem;">
              <span>🔍 Estat dels canvis:</span>
              <strong style="color:var(--text-primary);">${report.snapshotInfo.diff.status || 'Estable (Sense canvis en traçats ni parades en les darreres 72h)'}</strong>
            </div>
          ` : ''}
        </div>
      ` : ''}
    `;

    container.innerHTML = html;
    this.initObservatoriTableScrolls();
  }

  getLineColor(code) {
    const match = (this.availableLines || []).find(l => String(l.code || l.id).toUpperCase() === String(code).toUpperCase());
    return match?.color || 'var(--brand-primary)';
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
                  <th scope="row" style="font-weight:700;">${b.hour}:00 ${isSelected ? '📍' : ''}</th>
                  <td>${b.sampleCount}${b.sampleCount > 0 && b.sampleCount < 5 ? ' *' : ''}</td>
                  <td style="font-weight:${isSelected ? '800' : '600'}; color:${b.avgDelay >= 5 ? '#ef4444' : b.avgDelay >= 3 ? '#f59e0b' : 'var(--text-primary)'};">
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
                      <span style="background:${lColor}; color:#fff; padding:0.1rem 0.35rem; border-radius:4px; font-size:0.7rem; font-weight:800;">${this.esc(s.lineCode)}</span>
                      <span>${this.esc(s.stopName)}</span>
                    </div>
                  </td>
                  <td>${b.sampleCount}${b.sampleCount > 0 && b.sampleCount < 5 ? ' *' : ''}</td>
                  <td style="font-weight:700; color:${b.avgDelay >= 5 ? '#ef4444' : b.avgDelay >= 3 ? '#f59e0b' : 'var(--text-primary)'};">
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

      const journalismContainer = document.getElementById('journalism-content-container');
      if (journalismContainer && !journalismContainer._hasDrilldownListener) {
        journalismContainer._hasDrilldownListener = true;
        journalismContainer.addEventListener('click', (e) => {
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

          const switchStopRow = e.target.closest('[data-switch-stop-idx]');
          if (switchStopRow) {
            e.preventDefault();
            const stopIdx = parseInt(switchStopRow.dataset.switchStopIdx, 10);
            const h = parseInt(switchStopRow.dataset.switchHour, 10);
            this.openStopHourlyDrilldown(stopIdx, h);
            return;
          }

          if (e.target.closest('#stop-drilldown-close-btn') || e.target.id === 'stop-drilldown-modal-backdrop') {
            e.preventDefault();
            this.closeStopHourlyDrilldown();
            return;
          }
        });
      }
    });
  }

  getDirectionsForLine(lineId, lineData) {
    if (lineData && Array.isArray(lineData.directions) && lineData.directions.length > 0) {
      return lineData.directions;
    }
    const meta = this.availableLines.find(l => String(l.id) === String(lineId));
    if (meta && Array.isArray(meta.directions) && meta.directions.length > 0) {
      return meta.directions;
    }
    if (String(lineId) === 'c10') {
      return [
        { dirId: '1', name: "Cap a Mataró (Hospital / Pl. d'Itàlia)" },
        { dirId: '0', name: "Cap a Barcelona (Metro la Pau)" }
      ];
    }
    return [];
  }

  renderDirectionButtons(directions, currentDir) {
    const container = document.getElementById('direction-toggle-group');
    const toolbarContainer = document.getElementById('stops-card-dir-toolbar');
    const cardPillsContainer = document.getElementById('stops-card-dir-pills');

    const resolvedDirs = (directions && directions.length > 0) 
      ? directions 
      : this.getDirectionsForLine(this.activeLineId, this.activeLineData);

    if (container) {
      if (!resolvedDirs || resolvedDirs.length === 0) {
        container.innerHTML = `
          <button type="button" class="btn-direction active" data-dir-id="1">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m9 18 6-6-6-6"/></svg>
            <span>Sentit Únic / Circular</span>
          </button>
        `;
      } else {
        let html = resolvedDirs.map((d, i) => {
          const dirId = String(d.dirId || d.id);
          const isActive = dirId === String(currentDir);
          return `
            <button type="button" class="btn-direction ${isActive ? 'active' : ''}" data-dir-id="${dirId}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="${i === 0 ? 'm9 18 6-6-6-6' : 'm15 18-6-6 6-6'}"/></svg>
              <span>${this.esc(d.name)}</span>
            </button>
          `;
        }).join('');

        const isBothActive = String(currentDir) === 'both';
        html += `
          <button type="button" class="btn-direction ${isBothActive ? 'active' : ''}" data-dir-id="both" title="Mostrar tots dos sentits al mapa">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
            <span>Ambdós sentits</span>
          </button>
        `;

        container.innerHTML = html;
      }
    }

    if (toolbarContainer) {
      if (!resolvedDirs || resolvedDirs.length === 0) {
        toolbarContainer.style.display = 'none';
        toolbarContainer.innerHTML = '';
      } else {
        let tabsHtml = resolvedDirs.map((d, i) => {
          const dirId = String(d.dirId || d.id);
          const isActive = dirId === String(currentDir);
          const icon = i === 0 ? '➔' : '⬅';
          return `
            <button type="button" class="btn-stops-dir-tab ${isActive ? 'active' : ''}" data-dir-id="${dirId}" title="Veure parades de ${this.esc(d.name)}">
              <span>${icon} ${this.esc(d.name)}</span>
            </button>
          `;
        }).join('');

        const isBothActive = String(currentDir) === 'both';
        tabsHtml += `
          <button type="button" class="btn-stops-dir-tab ${isBothActive ? 'active' : ''}" data-dir-id="both" title="Veure parades de tots dos sentits dividides en blocs">
            <span>⇄ Ambdós sentits</span>
          </button>
        `;

        toolbarContainer.style.display = 'flex';
        toolbarContainer.innerHTML = tabsHtml;
      }
    }

    if (cardPillsContainer) {
      cardPillsContainer.innerHTML = '';
    }
  }

  renderTargetCardLoading(lData, stopName = 'Parada seleccionada', stopCode = '...', destName = null) {
    const titleEl = document.getElementById('target-stop-title');
    const codeEl = document.getElementById('target-stop-code');
    const dirSubEl = document.getElementById('target-direction-sub');
    const etaBigEl = document.getElementById('eta-big-display');
    const etaClockEl = document.getElementById('eta-clock-display');
    const etaPillEl = document.getElementById('eta-status-pill');
    const etaStatusText = document.getElementById('eta-status-text');
    const lineTagEl = document.getElementById('target-line-tag');
    const destEl = document.getElementById('next-bus-dest');
    const opEl = document.getElementById('target-operator-name');
    const depContainer = document.getElementById('departures-list-container');
    const depBadge = document.getElementById('dep-count-badge');

    if (titleEl) titleEl.textContent = stopName;
    if (codeEl) codeEl.textContent = stopCode;
    if (dirSubEl) dirSubEl.textContent = lData?.directions?.[0]?.name || 'Sincronitzant horaris...';
    if (lineTagEl && lData) {
      lineTagEl.textContent = lData.code || lData.id || 'C-10';
      if (lData.color) lineTagEl.style.color = lData.color;
    }
    if (destEl) destEl.textContent = destName || lData?.directions?.[0]?.name || 'Sincronitzant...';
    if (opEl && lData) opEl.textContent = lData.agency || 'Operador de Transport';

    if (etaBigEl) {
      etaBigEl.innerHTML = `<span class="eta-loading-box"><span class="loading-spinner-inline"></span> Sincronitzant...</span>`;
    }
    if (etaClockEl) {
      etaClockEl.innerHTML = `<span class="cockpit-val-loading"><span class="loading-spinner-inline" style="width:10px;height:10px;border-width:1.5px;"></span> Calculant proper pas en temps real...</span>`;
    }
    if (etaPillEl && etaStatusText) {
      etaPillEl.className = 'eta-status-pill';
      etaPillEl.style.background = 'rgba(255,255,255,0.06)';
      etaPillEl.style.color = 'var(--text-secondary)';
      etaStatusText.innerHTML = `<span class="loading-spinner-inline" style="width:10px;height:10px;border-width:1.5px;margin-right:4px;"></span> Sincronitzant GPS`;
    }
    if (depContainer) {
      depContainer.innerHTML = `
        <div class="departures-loading-placeholder">
          <span class="loading-spinner-inline"></span>
          Sincronitzant properes sortides i horaris oficials...
        </div>
      `;
    }
    if (depBadge) {
      depBadge.textContent = '...';
    }
  }

  getCurrentTargetStop() {
    if (this.currentTargetStop && (this.currentTargetStop.lat || this.currentTargetStop.id || this.currentTargetStop.code)) {
      if (this.currentTargetStop.lat && this.currentTargetStop.lon) return this.currentTargetStop;
    }
    const routeKey = `${this.activeLineId}_${this.activeDirection}`;
    const savedStopId = this.targetStopsByLine[routeKey] || this.targetStopsByLine[this.activeLineId];
    const selectVal = document.getElementById('target-stop-select')?.value;
    const targetId = savedStopId || selectVal || this.currentTargetStop?.id || this.currentTargetStop?.code;

    if (targetId) {
      const match = (this.activeLineData?.stops || []).find(s => 
        String(s.id) === String(targetId) || String(s.code) === String(targetId) || String(s.mouteStopId) === String(targetId)
      ) || (this.allStops || []).find(s => 
        String(s.id) === String(targetId) || String(s.code) === String(targetId) || String(s.mouteStopId) === String(targetId)
      );
      if (match) return match;
    }

    if (this.activeLineData?.targetStop) {
      return this.activeLineData.targetStop;
    }

    if (this.activeLineData?.stops && this.activeLineData.stops.length > 0) {
      return this.activeLineData.stops[0];
    }

    return this.currentTargetStop || null;
  }

  renderTargetCard(data, lData) {
    const titleEl = document.getElementById('target-stop-title');
    const codeEl = document.getElementById('target-stop-code');
    const dirSubEl = document.getElementById('target-direction-sub');
    const etaBigEl = document.getElementById('eta-big-display');
    const etaClockEl = document.getElementById('eta-clock-display');
    const etaPillEl = document.getElementById('eta-status-pill');
    const etaStatusText = document.getElementById('eta-status-text');
    const lineTagEl = document.getElementById('target-line-tag');
    const destEl = document.getElementById('next-bus-dest');
    const opEl = document.getElementById('target-operator-name');
    const mapsLinkEl = document.getElementById('target-maps-link');

    const stop = data.targetStop || {};
    this.currentTargetStop = stop;
    this.currentTargetStopData = data;
    this.currentTargetLineData = lData;
    const next = data.nextBus || (data.upcomingDepartures && data.upcomingDepartures[0]) || null;

    if (titleEl) titleEl.textContent = stop.name || 'Parada';
    if (codeEl) codeEl.textContent = stop.code || stop.id || '--';
    if (dirSubEl) {
      if (data.calendarInfo?.calendarTag) {
        dirSubEl.innerHTML = `${data.directionName || 'En servei'} • <span style="color:#38bdf8; font-weight:600;">📅 ${data.calendarInfo.calendarTag}</span>`;
      } else {
        dirSubEl.textContent = data.directionName || 'En servei';
      }
    }

    if (lineTagEl && lData) {
      lineTagEl.textContent = lData.code || lData.id || 'C-10';
      if (lData.color) lineTagEl.style.color = lData.color;
    }

    if (destEl) destEl.textContent = next?.destination || data.directionName || 'Destí';
    if (opEl && lData) opEl.textContent = lData.agency || 'Operador de Transport';

    // Synchronize target-stop-select dropdown to match the target stop code/id
    const targetSelect = document.getElementById('target-stop-select');
    if (targetSelect && (stop.id || stop.code)) {
      const matchOpt = Array.from(targetSelect.options).find(opt => 
        String(opt.value) === String(stop.id) || 
        String(opt.value) === String(stop.code) ||
        String(opt.value) === String(stop.mouteStopId)
      );
      if (matchOpt && targetSelect.value !== matchOpt.value) {
        targetSelect.value = matchOpt.value;
      }
    }

    if (mapsLinkEl) {
      if (stop.lat && stop.lon) {
        mapsLinkEl.href = `https://www.google.com/maps/search/?api=1&query=${stop.lat},${stop.lon}`;
      } else {
        const query = encodeURIComponent((stop.name || 'Mataró') + ' Mataró');
        mapsLinkEl.href = `https://www.google.com/maps/search/?api=1&query=${query}`;
      }
    }

    // Update target stop quick actions
    const planAction = document.getElementById('btn-target-plan-from');
    if (planAction) {
      planAction.href = `/plan?from=${encodeURIComponent(stop.name || '')}`;
      planAction.title = `Planificar ruta des de ${stop.name || 'aquesta parada'}`;
    }
    this.updateTargetFavButton(stop.id || stop.code);

    this.renderEtaDisplay(next, etaBigEl, etaClockEl, etaPillEl, etaStatusText);
    this.renderDeparturesInto('departures-list-container', 'dep-count-badge', data.upcomingDepartures || []);
  }

  updateTargetFavButton(stopId) {
    const favBtn = document.getElementById('btn-target-toggle-fav');
    if (!favBtn) return;
    const currentId = stopId || this.currentTargetStop?.id || this.currentTargetStop?.code || this.getCurrentTargetStop()?.id;
    const isFav = currentId ? this.isFavoriteStop(currentId) : false;
    favBtn.classList.toggle('is-favorite', isFav);
    favBtn.setAttribute('aria-pressed', isFav ? 'true' : 'false');
    const starEl = document.getElementById('target-fav-star');
    if (starEl) {
      starEl.textContent = isFav ? '⭐' : '☆';
    }
    const textEl = document.getElementById('target-fav-text');
    if (textEl) {
      textEl.textContent = 'Preferida';
    }
    favBtn.title = isFav ? 'Aquesta parada és a les teves preferides (fes clic per treure-la)' : 'Afegir aquesta parada a les teves preferides';
  }

  renderEtaDisplay(next, etaBigEl, etaClockEl, etaPillEl, etaStatusText) {
    if (next) {
      const rawClock = (next.expectedIso && !next.expectedIso.startsWith('0001-') && !next.expectedIso.startsWith('1970-'))
        ? new Date(next.expectedIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
        : (next.departureTime || '--:--');
      const clockTime = this.formatTimeHHMM(rawClock);

      // A departure is ONLY the first service of tomorrow / morning resumption if explicitly tomorrow & not live/estimated
      const isTomorrow = next.isToday === false && !next.isRealTime && !next.isEstimated;
      const isFirstMorning = isTomorrow && (next.isFirstOfDay === true || next.isNextService === true);
      const isFirstToday = next.isToday === true && (next.isFirstOfDay === true || next.isNextService === true) && !next.isRealTime && !next.isEstimated;

      if (isFirstMorning) {
        if (etaBigEl) etaBigEl.textContent = `🌅 ${clockTime}`;
        if (etaClockEl) etaClockEl.textContent = `1r pas previst demà: ${clockTime}`;
        if (etaPillEl && etaStatusText) {
          etaPillEl.className = 'eta-status-pill scheduled';
          etaStatusText.textContent = 'Represa al matí';
        }
      } else if (isFirstToday && (next.minutesAway === undefined || next.minutesAway > 180)) {
        if (etaBigEl) etaBigEl.textContent = `🌅 ${clockTime}`;
        if (etaClockEl) etaClockEl.textContent = `1r servei d'avui: ${clockTime}`;
        if (etaPillEl && etaStatusText) {
          etaPillEl.className = 'eta-status-pill scheduled';
          etaStatusText.textContent = '1r Servei';
        }
      } else {
        const mins = next.minutesAway;
        const minsDisplay = (mins !== undefined && mins !== null)
          ? (mins <= 0 ? 'Imminent' : (mins === 1 ? '1 min' : `${mins} min`))
          : (next.formattedStatus || clockTime);

        const rawSched = next.aimedIso
          ? new Date(next.aimedIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
          : (next.departureTime || null);
        const schedTime = rawSched ? this.formatTimeHHMM(rawSched) : null;
        const isDiff = schedTime && schedTime !== clockTime && (next.isRealTime || next.isEstimated);

        if (etaBigEl) etaBigEl.textContent = minsDisplay;
        
        if (etaClockEl) {
          if (isDiff) {
            etaClockEl.innerHTML = `Hora estimada: <strong>${clockTime}</strong> <span class="eta-sched-tag" title="Horari oficial programat">(Oficial: <strong>${schedTime}</strong>)</span>`;
          } else {
            etaClockEl.textContent = `Hora estimada: ${clockTime}`;
          }
        }

        if (etaPillEl && etaStatusText) {
          etaPillEl.className = 'eta-status-pill';
          // Freshness provenance: when the upstream prediction is stale
          // (fallback data or old observation), say so in plain text instead
          // of presenting it as a live countdown.
          const fresh = window.TransitUtils?.freshness?.(next);
          const isStaleLive = Boolean(fresh?.stale && next.isRealTime);
          if (fresh) etaPillEl.title = fresh.label;
          if (next.delayStatus === 'regulating' || next.isRegulating || next.isTerminalLayover) {
            etaPillEl.classList.add('regulating');
            etaStatusText.textContent = next.originTerminalName ? `Regulant a ${next.originTerminalName}` : 'Regulant a capçalera';
            if (next.originTerminalName && next.originDepartureTime) {
              if (etaClockEl) {
                etaClockEl.innerHTML = `Arribada aquí: <strong>${this.formatTimeHHMM(next.departureTime)}</strong> <span style="color:var(--accent-regulating); font-weight:700; margin-left:6px;">(Surt de ${this.esc(next.originTerminalName)}: <strong>${this.formatTimeHHMM(next.originDepartureTime)}</strong>)</span>`;
              }
            } else if (next.arrivalTime && next.departureTime) {
              const cleanArr = this.formatTimeHHMM(next.arrivalTime);
              const cleanDep = this.formatTimeHHMM(next.departureTime);
              const aSec = this.timeStringToSeconds(cleanArr);
              const dSec = this.timeStringToSeconds(cleanDep);
              if (aSec < dSec) {
                if (etaClockEl) {
                  etaClockEl.innerHTML = `Sortida prevista: <strong>${cleanDep}</strong> <span style="color:var(--accent-regulating); font-weight:700; margin-left:6px;">(Arribada: <strong>${cleanArr}</strong>)</span>`;
                }
              } else {
                if (etaClockEl) {
                  etaClockEl.innerHTML = `Sortida prevista: <strong>${cleanDep}</strong>`;
                }
              }
            }
          } else if (next.delayStatus === 'delayed') {
            etaPillEl.classList.add('delayed');
            const cleanDelay = (next.delayBadgeText || '+2 min').replace(/retard/gi, '').trim();
            etaStatusText.textContent = `Retard (${cleanDelay})`;
          } else if (next.delayStatus === 'early') {
            etaPillEl.classList.add('early');
            const cleanEarly = (next.delayBadgeText || '-2 min').replace(/avançat/gi, '').trim();
            etaStatusText.textContent = `Avançat (${cleanEarly})`;
          } else if (next.isEstimated) {
            etaPillEl.classList.add('estimated');
            etaStatusText.textContent = 'Estimació en Circuit';
          } else if (next.isRealTime) {
            etaPillEl.classList.add(isStaleLive ? 'estimated' : 'live');
            etaStatusText.textContent = isStaleLive ? (fresh.label || 'Última previsió coneguda') : 'Temps Real Actiu';
          } else {
            etaPillEl.classList.add('scheduled');
            etaStatusText.textContent = 'Horari Teòric';
          }
        }
      }
    } else {
      if (etaBigEl) etaBigEl.textContent = 'Sense bus';
      if (etaClockEl) etaClockEl.textContent = 'Cap servei en els propers 90 min';
      if (etaPillEl && etaStatusText) {
        etaPillEl.className = 'eta-status-pill scheduled';
        etaStatusText.textContent = 'Sense circulacions';
      }
    }
  }

  renderDeparturesInto(containerId, badgeId, departures) {
    const container = document.getElementById(containerId);
    const badge = document.getElementById(badgeId);
    if (!container) return;

    if (badge) badge.textContent = `${departures.length} sortides`;

    if (!departures || departures.length === 0) {
      container.innerHTML = `
        <div class="departure-item" style="justify-content: center; color: var(--text-muted); font-size: 0.8rem; padding: 1.25rem;">
          No hi ha més sortides previstes properament.
        </div>
      `;
      return;
    }

    const targetStopSeq = this.activeLineData?.targetStop?.seq || null;
    const targetStopId = this.targetStopId || this.activeLineData?.targetStop?.id || null;
    const targetStop = (this.activeLineData?.stops || []).find(s => String(s.id) === String(targetStopId)) || this.activeLineData?.targetStop || null;
    const cancelledBanner = targetStop?.isCancelled ? `
      <div style="background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.4); border-radius:8px; padding:0.65rem 0.9rem; margin-bottom:0.85rem; font-size:0.82rem; color:#fca5a5; display:flex; align-items:center; gap:8px;">
        <span style="font-size:1.1rem;">⚠️</span>
        <div><strong>Parada fora de servei:</strong> Aquesta parada està temporalment anul·lada per obres / desviament. Els autobusos d'aquesta línia no s'aturen aquí.</div>
      </div>
    ` : '';

    const itemsHtml = departures.map((dep, idx) => {
      const rawTime = (dep.expectedIso && !dep.expectedIso.startsWith('0001-') && !dep.expectedIso.startsWith('1970-'))
        ? new Date(dep.expectedIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
        : (dep.departureTime || '--:--');
      const clockTime = this.formatTimeHHMM(String(rawTime).replace(/^[A-Za-zÀ-ÿ\.]+\s*(a\s*les\s*)?/i, '').trim());

      const rawSched = dep.scheduledTime ||
        ((dep.aimedIso && !dep.isEstimated && !dep.aimedIso.startsWith('0001-') && !dep.aimedIso.startsWith('1970-'))
          ? new Date(dep.aimedIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
          : (dep.isRealTime && dep.scheduledTime ? dep.scheduledTime : null));
      const schedTime = rawSched ? this.formatTimeHHMM(String(rawSched).replace(/^[A-Za-zÀ-ÿ\.]+\s*(a\s*les\s*)?/i, '').trim()) : null;

      const isTomorrow = dep.isToday === false && !dep.isRealTime && !dep.isEstimated;
      const isFirstMorning = isTomorrow && (dep.isFirstOfDay === true || idx === 0) && !dep.isRealTime && !dep.isEstimated;
      const isFirstToday = dep.isToday === true && dep.isFirstOfDay === true && !dep.isRealTime && !dep.isEstimated;
      const isDiff = schedTime && schedTime !== clockTime && !dep.isEstimated;
      const rawDelayMins = dep.delayMins !== undefined && dep.delayMins !== null ? Number(dep.delayMins) : 0;
      const delayText = rawDelayMins >= 2
        ? `+${rawDelayMins} min retard`
        : (rawDelayMins <= -1 ? `${Math.abs(rawDelayMins)} min avançat` : 'Puntual');

      const isLiveOrEstimated = Boolean(dep.isRealTime || dep.isEstimated || dep.vehicleId);
      const matchedBus = isLiveOrEstimated ? this.resolveBusForDeparture(dep, targetStopSeq, targetStopId, idx) : null;
      const resolvedVehicleId = matchedBus?.vehicleId || matchedBus?.tripId || (dep.isRealTime ? dep.vehicleId : '');
      const resolvedLat = matchedBus?.lat || (dep.isRealTime ? dep.busCoords?.lat : '');
      const resolvedLon = matchedBus?.lon || (dep.isRealTime ? dep.busCoords?.lon : '');
      const hasActiveBus = Boolean(matchedBus && (resolvedVehicleId || (resolvedLat && resolvedLon)));

      const minsText = isFirstMorning
        ? `🌅 Demà ${clockTime}`
        : (isTomorrow
            ? `Demà ${clockTime}`
            : (isFirstToday && (dep.minutesAway === undefined || dep.minutesAway > 180)
                ? `🌅 ${clockTime}`
                : ((dep.minutesAway !== undefined && dep.minutesAway >= 0 && dep.minutesAway <= 180)
                    ? (dep.minutesAway <= 0 ? 'Ara' : (dep.minutesAway === 1 ? '1 min' : `${dep.minutesAway} min`))
                    : `${clockTime}`)));

      const isRegulating = Boolean(dep.delayStatus === 'regulating' || dep.isRegulating || dep.isTerminalLayover || dep.arrivalTime);
      const arrTime = dep.arrivalTime ? this.formatTimeHHMM(String(dep.arrivalTime).trim()) : null;
      let depTime = (dep.departureTime && dep.departureTime !== '--:--') ? this.formatTimeHHMM(String(dep.departureTime).trim()) : clockTime;

      // Invariant: Departure time can NEVER be earlier than arrival time
      let hasValidLayoverInterval = false;
      let layoverMins = 0;
      let arrMinsAway = null;
      let depMinsAway = (dep.minutesAway !== undefined && dep.minutesAway !== null) ? Number(dep.minutesAway) : null;

      if (arrTime && depTime && depTime !== '--:--' && arrTime !== '--:--') {
        let aSec = this.timeStringToSeconds(arrTime);
        let dSec = this.timeStringToSeconds(depTime);
        if (dSec < aSec && aSec > 22 * 3600 && dSec < 3 * 3600) {
          dSec += 86400; // Midnight rollover
        }
        if (dSec < aSec) {
          depTime = arrTime;
        } else if (dSec >= aSec) {
          hasValidLayoverInterval = true;
          layoverMins = Math.round((dSec - aSec) / 60);
        }

        if (dep.arrivalMinutesAway !== undefined && dep.arrivalMinutesAway !== null) {
          arrMinsAway = Number(dep.arrivalMinutesAway);
        } else if (depMinsAway !== null && hasValidLayoverInterval) {
          arrMinsAway = depMinsAway - layoverMins;
        }
      }

      const isApproachingTerminal = isRegulating && arrMinsAway !== null && arrMinsAway > 0;
      const isParkedAtTerminal = isRegulating && arrMinsAway !== null && arrMinsAway <= 0;

      const tagLabel = isParkedAtTerminal
        ? ''
        : ((isFirstMorning || isFirstToday)
            ? '🌅 1r Servei'
            : (isTomorrow ? 'Programat' : (dep.isEstimated ? '⚡ En ruta' : (dep.isRealTime ? '🟢 Temps Real' : 'Programat'))));

      let regBadgeText = '';
      let regBadgeTitle = '';
      if (isRegulating) {
        if (isParkedAtTerminal) {
          regBadgeText = '🅿️ A la parada';
          regBadgeTitle = arrTime ? `Autobús a la parada des de les ${arrTime}` : 'Autobús a la parada en regulació';
        } else if (isApproachingTerminal) {
          regBadgeText = '⏱️ En camí';
          regBadgeTitle = `Arribada a capçalera prevista a les ${arrTime}${arrMinsAway !== null ? ` (${arrMinsAway <= 0 ? 'Ara' : (arrMinsAway === 1 ? '1 min' : `${arrMinsAway} min`)})` : ''}`;
        } else if (dep.originTerminalName) {
          regBadgeText = '⏱️ En regulació';
          regBadgeTitle = `Autobús regulant a ${dep.originTerminalName}${dep.originDepartureTime ? ` (sortida: ${dep.originDepartureTime})` : ''}`;
        } else {
          regBadgeText = '⏱️ En regulació';
          regBadgeTitle = 'Autobús en regulació de línia';
        }
        if (schedTime && isDiff) {
          regBadgeTitle += ` • Horari oficial teòric: ${schedTime}`;
        }
      }

      let pillLabel;
      if (isRegulating) {
        if (rawDelayMins >= 2) {
          pillLabel = delayText;
        } else if (rawDelayMins <= -1) {
          pillLabel = `${Math.abs(rawDelayMins)} min avançat`;
        } else {
          pillLabel = '⏱️ Regulació';
        }
      } else if (isFirstMorning || isFirstToday) {
        pillLabel = '1r Servei';
      } else if (isTomorrow) {
        pillLabel = 'Programat';
      } else if (dep.isEstimated) {
        const hasExplicitDelay = Boolean(dep.delayBadgeText && (dep.delayBadgeText.includes('retard') || dep.delayBadgeText.includes('avançat')));
        const estDelayBadge = hasExplicitDelay ? dep.delayBadgeText : delayText;
        pillLabel = rawDelayMins >= 2 ? estDelayBadge : '⚡ En ruta';
      } else {
        pillLabel = dep.delayBadgeText || 'Puntual';
      }

      const pillClass = isRegulating
        ? (rawDelayMins >= 2 ? 'delayed' : (rawDelayMins <= -1 ? 'early' : 'regulating'))
        : ((isTomorrow || isFirstToday) ? 'scheduled' : (rawDelayMins >= 2 ? 'delayed' : (rawDelayMins <= -1 ? 'early' : (dep.delayStatus || 'on-time'))));

      const cleanDest = (dep.destination || 'Destí').replace(/^Cap a\s+/i, '').trim() || 'Destí';
      let subtextHtml = '';
      let subtextTitle = '';

      if (isRegulating) {
        if (hasValidLayoverInterval) {
          if (isApproachingTerminal) {
            subtextHtml = `<span>⏱️ Arribada ${arrTime}${arrMinsAway !== null ? ` (${arrMinsAway <= 0 ? 'Ara' : (arrMinsAway === 1 ? '1 min' : `${arrMinsAway} min`)})` : ''}${layoverMins > 0 ? ` • Regulació: ${layoverMins} min` : ''}</span>`;
            subtextTitle = `Regulació a capçalera: Arribada prevista a les ${arrTime}${arrMinsAway !== null ? ` (en ${arrMinsAway <= 0 ? '0' : arrMinsAway} min)` : ''}${layoverMins > 0 ? ` • Pausa de regulació de ${layoverMins} min` : ''} • Sortida cap a ${cleanDest} a les ${depTime}${depMinsAway !== null ? ` (en ${depMinsAway} min)` : ''}${schedTime && isDiff ? ` [Horari oficial: ${schedTime}]` : ''}`;
          } else {
            subtextHtml = `<span>⏱️ A la parada des de les ${arrTime}${layoverMins > 0 ? ` • Regulació: ${layoverMins} min` : ''}</span>`;
            subtextTitle = `Regulació a capçalera: Autobús a la parada des de les ${arrTime}${layoverMins > 0 ? ` • Pausa de regulació de ${layoverMins} min` : ''} • Sortida cap a ${cleanDest} a les ${depTime}${depMinsAway !== null ? ` (en ${depMinsAway} min)` : ''}${schedTime && isDiff ? ` [Horari oficial: ${schedTime}]` : ''}`;
          }
        } else if (dep.originTerminalName) {
          subtextHtml = `<span>⏱️ Regulant a ${this.esc(dep.originTerminalName)}${dep.originDepartureTime ? ` • Surt a les ${this.esc(dep.originDepartureTime)}` : ''}</span>`;
          subtextTitle = `Autobús en regulació a ${dep.originTerminalName}${dep.originDepartureTime ? ` (sortida d'origen a les ${dep.originDepartureTime})` : ''} • Arribada prevista aquí a les ${depTime}${depMinsAway !== null ? ` (en ${depMinsAway} min)` : ''}${schedTime && isDiff ? ` [Horari oficial: ${schedTime}]` : ''}`;
        } else {
          subtextHtml = `<span>⏱️ En regulació a capçalera • Sortida a les ${depTime}</span>`;
          subtextTitle = `Autobús en regulació a capçalera • Sortida prevista a les ${depTime}${depMinsAway !== null ? ` (en ${depMinsAway} min)` : ''}${schedTime && isDiff ? ` [Horari oficial: ${schedTime}]` : ''}`;
        }
      } else if (isFirstMorning) {
        subtextHtml = `<span>📅 Primer autobús del matí (Demà a les ${clockTime})</span>`;
        subtextTitle = `Primer autobús del matí de demà a les ${clockTime}`;
      } else if (isFirstToday) {
        subtextHtml = `<span>📅 Primer servei d'avui (a les ${clockTime})</span>`;
        subtextTitle = `Primer servei programat d'avui a les ${clockTime}`;
      } else if (isTomorrow) {
        subtextHtml = `<span>📅 Horari teòric: <strong class="sched-strong">Demà a les ${clockTime}</strong></span>`;
        subtextTitle = `Sortida programada per a demà a les ${clockTime}`;
      } else if (dep.isRealTime) {
        if (schedTime && isDiff) {
          subtextHtml = `<span>📅 Horari teòric: <strong class="sched-strong">${schedTime}</strong> <span class="dep-delay-note ${rawDelayMins >= 2 ? 'delay' : (rawDelayMins <= -1 ? 'early' : 'on-time')}">(${delayText})</span></span>`;
          subtextTitle = `Temps real SIRI Avanza • Horari programat: ${schedTime} (${delayText})`;
        } else {
          subtextHtml = `<span>🟢 Arribada en temps real (SIRI Avanza)</span>`;
          subtextTitle = `Arribada transmesa en temps real pel sistema SIRI Avanza`;
        }
      } else if (dep.isEstimated) {
        subtextHtml = `<span>⚡ Estimació de pas segons telemetria GPS</span>`;
        subtextTitle = `Estimació calculada segons telemetria GPS`;
      } else {
        subtextHtml = `<span>📅 Horari teòric programat</span>`;
        subtextTitle = `Horari teòric programat`;
      }

      const linePrefix = dep.lineId ? `Línia ${dep.lineId}: ` : (this.activeLineId ? `Línia ${this.activeLineId}: ` : '');
      const etaSuffix = minsText ? `, ${minsText}` : '';

      return `
        <div class="departure-item ${idx === 0 ? 'highlight-next' : ''} ${hasActiveBus ? 'clickable-bus-dep' : ''}"
             data-vehicle-id="${this.esc(resolvedVehicleId)}"
             data-bus-lat="${this.esc(resolvedLat)}"
             data-bus-lon="${this.esc(resolvedLon)}"
             data-stop-seq="${targetStopSeq || ''}"
             data-stop-id="${targetStopId || ''}"
             data-dep-index="${idx}"
             ${hasActiveBus ? 'tabindex="0" role="button"' : 'role="listitem"'}
             aria-label="${hasActiveBus ? `Localitzar al mapa: ${linePrefix}sortida de les ${depTime} cap a ${this.esc(cleanDest)}${etaSuffix}` : `${linePrefix}Sortida de les ${depTime} cap a ${this.esc(cleanDest)}${etaSuffix}`}"
             title="${hasActiveBus ? 'Fes clic per localitzar aquest autobús en directe al mapa' : ''}">
          <div class="dep-time-group">
            <div class="dep-time-row">
              <span class="dep-clock">${depTime}</span>
              ${isRegulating
                ? `<span class="dep-regulating-pill" title="${this.esc(regBadgeTitle)}">${regBadgeText}</span>`
                : (isDiff ? `<span class="dep-sched-pill" title="Horari oficial teòric: ${schedTime}">Oficial: ${schedTime}</span>` : '')}
              ${(!isParkedAtTerminal && tagLabel) ? `<span class="dep-tag-sub ${(isFirstMorning || isFirstToday) ? 'first-service' : ''}" title="${this.esc(tagLabel)}">${tagLabel}</span>` : ''}
            </div>
            <div class="dep-dest" title="Cap a ${this.esc(cleanDest)}">
              Cap a <strong>${this.esc(cleanDest)}</strong>
            </div>
            <div class="dep-time-sub" title="${this.esc(subtextTitle)}">
              ${subtextHtml}
            </div>
          </div>
          <div class="dep-status">
            <span class="dep-mins" style="${(isFirstMorning || isFirstToday) ? 'color:#fbbf24;' : (isTomorrow ? 'color:#94a3b8;' : '')}">${minsText}</span>
            <span class="dep-delay-pill ${pillClass}" title="${this.esc((dep.isEstimated && rawDelayMins >= 2) ? pillLabel : (dep.delayBadgeText || pillLabel))}">
              ${this.esc(pillLabel)}
            </span>
            ${hasActiveBus ? `
              <span class="dep-map-cta">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polygon points="12 8 8 12 12 16 12 8"/></svg>
                Veure al mapa
              </span>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');

    const footerHint = departures.length > 5 ? `
      <div class="dep-scroll-footer" style="text-align: center; padding: 0.6rem 0.5rem; font-size: 0.72rem; color: var(--text-muted); border-top: 1px dashed var(--border-subtle); margin-top: 0.25rem;">
        📜 Mostrant tot l'horari teòric oficial del dia • Desplaça per consultar totes les sortides
      </div>
    ` : '';

    container.innerHTML = cancelledBanner + itemsHtml + footerHint;
  }

  // ==========================================
  // 4. TELEMETRY COCKPIT & VEHICLE SWITCHER
  // ==========================================

  renderTelemetryCockpit(lineData, targetData = null) {
    this._lastCockpitLineData = lineData;
    this._lastCockpitTargetData = targetData;
    const buses = lineData.activeBuses || [];
    const bar = document.getElementById('telemetry-vehicles-bar');
    const chipsContainer = document.getElementById('telemetry-vehicles-chips');

    if (buses.length > 0) {
      if (bar) bar.style.display = 'flex';

      const activeBus = buses.find(b => String(b.tripId || b.vehicleId) === String(this.selectedVehicleId)) || buses[0];
      this.selectedVehicleId = activeBus.tripId || activeBus.vehicleId;

      if (chipsContainer) {
        chipsContainer.innerHTML = buses.map((b, idx) => {
          const isSelected = String(b.tripId || b.vehicleId) === String(this.selectedVehicleId);
          const isGhost = Boolean(b.isGhostVehicle || (b.vehicleId && String(b.vehicleId).startsWith('EST_')) || b.isTheoretical);
          const label = isGhost ? `Estimat (${b.departureTime || 'Horari'})` : (b.vehicleId ? `Bus #${b.vehicleId}` : `Bus ${idx + 1}`);
          const isParked = b.isTerminalLayover;
          const chipClass = `telemetry-bus-chip ${isSelected ? 'active' : ''} ${isGhost ? 'ghost-chip' : ''}`;
          return `
            <button type="button" class="${chipClass}" data-bus-trip="${b.tripId || b.vehicleId}">
              <span>${isGhost ? '⚡' : (isParked ? '🅿️' : '🚌')}</span>
              <span>${label}</span>
              <span style="font-size:0.68rem; opacity:0.8;">(${b.toStop || b.destination || 'En línia'})</span>
            </button>
          `;
        }).join('');

        if (!chipsContainer._hasChipDelegation) {
          chipsContainer._hasChipDelegation = true;
          chipsContainer.addEventListener('click', (e) => {
            const btn = e.target.closest('.telemetry-bus-chip');
            if (!btn) return;
            e.preventDefault();
            this.selectedVehicleId = btn.getAttribute('data-bus-trip');
            if (this._lastCockpitLineData) {
              this.renderTelemetryCockpit(this._lastCockpitLineData, this._lastCockpitTargetData);
            }
            this.mapController?.highlightBus(this.selectedVehicleId, true);
          });
        }
      }

      this.renderTelemetryFields(activeBus, lineData, targetData);
    } else {
      if (bar) bar.style.display = 'none';
      this.renderTelemetryFields(null, lineData, targetData);
    }
  }

  renderTelemetryFields(b, lineData, targetData = null) {
    const coordsEl = document.getElementById('telemetry-coords');
    const bearingEl = document.getElementById('telemetry-bearing');
    const speedEl = document.getElementById('telemetry-speed');
    const segmentEl = document.getElementById('telemetry-segment');
    const etaNextEl = document.getElementById('telemetry-eta-next');
    const tripStartEl = document.getElementById('telemetry-trip-start');
    const progressFill = document.getElementById('telemetry-progress-bar');
    const progressText = document.getElementById('telemetry-progress-text');
    const statusBadge = document.getElementById('telemetry-status-badge');
    const radarDot = document.getElementById('telemetry-radar-dot');
    const ghostNoticeEl = document.getElementById('telemetry-ghost-notice');

    const isGhostBus = Boolean(b && (b.isGhostVehicle || (b.vehicleId && String(b.vehicleId).startsWith('EST_')) || b.isTheoretical));

    if (ghostNoticeEl) {
      ghostNoticeEl.style.display = isGhostBus ? 'flex' : 'none';
    }

    if (!b) {
      const nextTime = targetData?.nextBus?.departureTime || lineData?.serviceStatus?.firstServiceTomorrow || '06:45';
      const targetName = targetData?.targetStop?.name || 'Parada';
      if (coordsEl) coordsEl.textContent = 'Sense autobusos en ruta';
      if (bearingEl) bearingEl.textContent = '--';
      if (speedEl) speedEl.textContent = '0 km/h (Parat)';
      if (segmentEl) segmentEl.textContent = 'Circuit fora d\'horari';
      if (etaNextEl) etaNextEl.textContent = `Pas per ${targetName}: ${nextTime}`;
      if (tripStartEl) tripStartEl.textContent = '--';
      if (progressFill) progressFill.style.width = '0%';
      if (progressText) progressText.textContent = '0%';
      if (statusBadge) { 
        statusBadge.textContent = '🌙 Servei Nocturn / Inactiu'; 
        statusBadge.className = 'telemetry-status-badge night'; 
      }
      if (radarDot) radarDot.className = 'telemetry-live-radar night';
      return;
    }

    const isGhost = isGhostBus;
    const isEst = Boolean(b.isEstimated);

    if (coordsEl) coordsEl.textContent = isGhost
      ? `⚡ Posició teòrica (${b.lat.toFixed(5)}°, ${b.lon.toFixed(5)}°)`
      : (b.coordinatesFormatted || `${b.lat.toFixed(5)}° N, ${b.lon.toFixed(5)}° E`);
    if (bearingEl) bearingEl.textContent = `${b.compass?.label || 'N/A'} (${b.bearing || 0}°)`;
    if (speedEl) speedEl.textContent = isGhost ? `~20 km/h (Estimat)` : `${b.speedKmh || 32} km/h`;
    if (segmentEl) segmentEl.textContent = `${b.fromStop || 'Origen'} ➔ ${b.toStop || 'Destí'}`;
    if (etaNextEl) etaNextEl.textContent = b.secondsToNextStop ? `~${Math.round(b.secondsToNextStop / 60)} min (${b.toStop})` : `${b.toStop || 'En trajecte'}`;
    if (tripStartEl) tripStartEl.textContent = b.departureTime || b.tripStartTime || '--';
    
    const prog = Math.min(100, Math.max(0, b.totalProgress || 0));
    if (progressFill) progressFill.style.width = `${prog}%`;
    if (progressText) progressText.textContent = `${prog}%`;

    if (statusBadge) {
      if (isGhost) {
        statusBadge.textContent = '⚡ Horari Oficial Teòric (Sense GPS)';
        statusBadge.className = 'telemetry-status-badge ghost';
      } else {
        statusBadge.textContent = b.statusText || (b.isTerminalLayover ? '🅿️ En Regulació' : isEst ? '⚡ Estimació Zona Cobertura' : '🟢 Senyal GPS Actiu');
        statusBadge.className = `telemetry-status-badge ${isEst ? 'estimated' : ''}`;
      }
    }

    if (radarDot) {
      radarDot.className = `telemetry-live-radar ${isGhost ? 'ghost' : (isEst ? 'dead-zone' : '')}`;
    }
  }

  // ==========================================
  // 5. ROUTE PROGRESSION TIMELINE (UNIVERSAL)
  // ==========================================

  renderRouteTimeline(lineData, activeTargetId) {
    const container = document.getElementById('corridor-timeline-container');
    const titleEl = document.getElementById('corridor-title-text');

    if (titleEl) {
      titleEl.textContent = `Recorregut ${lineData.code || lineData.id || ''}: ${lineData.name || ''}`;
    }

    if (!container) return;

    const isBoth = this.activeDirection === 'both' || lineData.direction === 'both';
    const allDirs = (isBoth && lineData.allDirections && lineData.allDirections.length > 1) 
      ? lineData.allDirections 
      : ((isBoth && lineData.secondaryStops && lineData.secondaryStops.length > 0)
          ? [
              { dirId: '1', name: lineData.directionName || 'Sentit 1', stops: lineData.stops || [] },
              { dirId: '0', name: 'Sentit 2', stops: lineData.secondaryStops || [] }
            ]
          : null);

    const routeKey = `${lineData.id || this.activeLineId}_${this.activeDirection}`;

    if (isBoth && allDirs && allDirs.length > 1) {
      container.classList.add('multi-dir-grid');
      const activeBuses = lineData.activeBuses || [];
      const existingTracks = container.querySelectorAll('.corridor-timeline-track');
      const savedScrolls = Array.from(existingTracks).map(t => t.scrollLeft);

      // In-place DOM update when tracking the same multi-direction route
      if (existingTracks.length === allDirs.length && container.dataset.routeKey === routeKey) {
        allDirs.forEach((d, dIdx) => {
          const track = existingTracks[dIdx];
          if (!track) return;
          const dirStops = d.stops || [];
          const dirBuses = activeBuses.filter(b => String(b.direction) === String(d.dirId) || (b.destination && b.destination.toLowerCase().includes(d.name.toLowerCase().substring(0, 8))));
          const primaryBus = dirBuses[0] || null;
          const stepEls = track.querySelectorAll('.corridor-step');
          if (stepEls.length !== dirStops.length) return;

          dirStops.forEach((s, idx) => {
            const stepEl = stepEls[idx];
            if (!stepEl) return;
            const sId = String(s.id || s.mouteStopId || s.code);
            const isTarget = sId === String(activeTargetId);
            const busOnStop = dirBuses.find(b => b.fromSeq === s.seq || b.toSeq === s.seq);
            const isPassed = primaryBus && s.seq < (primaryBus.fromSeq || 0);

            let nodeClass = 'step-node';
            let iconContent = `${s.seq || idx + 1}`;

            if (busOnStop) {
              nodeClass += ' has-bus';
              iconContent = '🚌';
            } else if (isPassed) {
              nodeClass += ' passed';
              iconContent = '✓';
            } else if (isTarget) {
              nodeClass += ' target';
              iconContent = '⭐';
            }

            const expectedClass = `corridor-step ${isPassed ? 'passed' : ''}`;
            if (stepEl.className !== expectedClass) stepEl.className = expectedClass;

            const nodeEl = stepEl.querySelector('.step-node');
            if (nodeEl) {
              if (nodeEl.className !== nodeClass) nodeEl.className = nodeClass;
              const span = nodeEl.querySelector('span');
              if (span && span.textContent !== iconContent) span.textContent = iconContent;
            }
          });
          this.updateTimelineScrollButtons(track);
        });
        return;
      }

      container.dataset.routeKey = routeKey;
      container.innerHTML = allDirs.map((d, dIdx) => {
        const dirStops = d.stops || [];
        const dirBuses = activeBuses.filter(b => String(b.direction) === String(d.dirId) || (b.destination && b.destination.toLowerCase().includes(d.name.toLowerCase().substring(0, 8))));
        const primaryBus = dirBuses[0] || null;

        return `
          <div class="timeline-dir-section">
            <div class="timeline-dir-header">
              <div class="timeline-dir-header-title">
                <span class="timeline-dir-icon">${dIdx === 0 ? '➔' : '⬅'}</span>
                <strong>${this.esc(d.name)}</strong>
                <span class="timeline-dir-badge">${dirStops.length} parades</span>
              </div>
              <button type="button" class="btn-timeline-select-dir" data-dir-id="${d.dirId}" title="Veure i fixar només ${this.esc(d.name)}">
                <span>Veure només aquest sentit</span>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
            </div>
            <div class="corridor-timeline-wrapper">
              <button type="button" class="btn-timeline-scroll btn-timeline-scroll-left" title="Desplaçar a l'esquerra" aria-label="Desplaçar a l'esquerra">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
              </button>
              <div class="corridor-timeline-track">
                ${dirStops.map((s, idx) => {
                  const sId = String(s.id || s.mouteStopId || s.code);
                  const isTarget = sId === String(activeTargetId);
                  const busOnStop = dirBuses.find(b => b.fromSeq === s.seq || b.toSeq === s.seq);
                  const isPassed = primaryBus && s.seq < (primaryBus.fromSeq || 0);

                  let nodeClass = 'step-node';
                  let iconContent = `${s.seq || idx + 1}`;

                  if (busOnStop) {
                    nodeClass += ' has-bus';
                    iconContent = '🚌';
                  } else if (isPassed) {
                    nodeClass += ' passed';
                    iconContent = '✓';
                  } else if (isTarget) {
                    nodeClass += ' target';
                    iconContent = '⭐';
                  }

                  return `
                    <div class="corridor-step ${isPassed ? 'passed' : ''}" data-target-id="${sId}" style="cursor:pointer;" title="Fixar ${this.esc(s.name)} com a parada principal">
                      <div class="${nodeClass}">
                        <span>${iconContent}</span>
                      </div>
                      <div class="step-info">
                        <span class="step-name">${this.esc(s.name)}</span>
                        <span class="step-zone">#${s.seq || idx + 1} • ${s.zone || 'Parada'}</span>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
              <button type="button" class="btn-timeline-scroll btn-timeline-scroll-right" title="Desplaçar a la dreta" aria-label="Desplaçar a la dreta">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
            </div>
          </div>
        `;
      }).join('');

      const newTracks = container.querySelectorAll('.corridor-timeline-track');
      newTracks.forEach((t, idx) => {
        if (savedScrolls[idx]) t.scrollLeft = savedScrolls[idx];
        this.updateTimelineScrollButtons(t);
      });
    } else {
      container.classList.remove('multi-dir-grid');
      const stops = lineData.stops || [];
      if (stops.length === 0) return;

      const activeBuses = lineData.activeBuses || [];
      const primaryBus = activeBuses[0] || null;

      const existingTrack = container.querySelector('.corridor-timeline-track');
      const existingSteps = existingTrack ? existingTrack.querySelectorAll('.corridor-step') : [];

      // In-place DOM update when tracking the same line & direction (zero DOM destruction, preserves scrollLeft completely)
      if (existingTrack && existingSteps.length === stops.length && container.dataset.routeKey === routeKey) {
        stops.forEach((s, idx) => {
          const stepEl = existingSteps[idx];
          if (!stepEl) return;
          const sId = String(s.id || s.mouteStopId || s.code);
          const isTarget = sId === String(activeTargetId);
          const busOnStop = activeBuses.find(b => b.fromSeq === s.seq || b.toSeq === s.seq);
          const isPassed = primaryBus && s.seq < (primaryBus.fromSeq || 0);

          let nodeClass = 'step-node';
          let iconContent = `${s.seq || idx + 1}`;

          if (busOnStop) {
            nodeClass += ' has-bus';
            iconContent = '🚌';
          } else if (isPassed) {
            nodeClass += ' passed';
            iconContent = '✓';
          } else if (isTarget) {
            nodeClass += ' target';
            iconContent = '⭐';
          }

          const expectedClass = `corridor-step ${isPassed ? 'passed' : ''}`;
          if (stepEl.className !== expectedClass) stepEl.className = expectedClass;

          const nodeEl = stepEl.querySelector('.step-node');
          if (nodeEl) {
            if (nodeEl.className !== nodeClass) nodeEl.className = nodeClass;
            const span = nodeEl.querySelector('span');
            if (span && span.textContent !== iconContent) span.textContent = iconContent;
          }
        });
        this.updateTimelineScrollButtons(existingTrack);
        return;
      }

      // Initial or route-change render: preserve prior scroll position if any
      const savedScroll = existingTrack ? existingTrack.scrollLeft : 0;
      container.dataset.routeKey = routeKey;
      container.innerHTML = `
        <div class="corridor-timeline-wrapper">
          <button type="button" class="btn-timeline-scroll btn-timeline-scroll-left" title="Desplaçar a l'esquerra" aria-label="Desplaçar a l'esquerra">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div class="corridor-timeline-track">
            ${stops.map((s, idx) => {
              const sId = String(s.id || s.mouteStopId || s.code);
              const isTarget = sId === String(activeTargetId);
              const busOnStop = activeBuses.find(b => b.fromSeq === s.seq || b.toSeq === s.seq);
              const isPassed = primaryBus && s.seq < (primaryBus.fromSeq || 0);

              let nodeClass = 'step-node';
              let iconContent = `${s.seq || idx + 1}`;

              if (busOnStop) {
                nodeClass += ' has-bus';
                iconContent = '🚌';
              } else if (isPassed) {
                nodeClass += ' passed';
                iconContent = '✓';
              } else if (isTarget) {
                nodeClass += ' target';
                iconContent = '⭐';
              }

              return `
                <div class="corridor-step ${isPassed ? 'passed' : ''}" data-target-id="${sId}" style="cursor:pointer;" title="Fixar ${this.esc(s.name)} com a parada principal">
                  <div class="${nodeClass}">
                    <span>${iconContent}</span>
                  </div>
                  <div class="step-info">
                    <span class="step-name">${this.esc(s.name)}</span>
                    <span class="step-zone">#${s.seq || idx + 1} • ${s.zone || 'Parada'}</span>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
          <button type="button" class="btn-timeline-scroll btn-timeline-scroll-right" title="Desplaçar a la dreta" aria-label="Desplaçar a la dreta">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
      `;

      const newTrack = container.querySelector('.corridor-timeline-track');
      if (newTrack) {
        if (savedScroll > 0) newTrack.scrollLeft = savedScroll;
        this.updateTimelineScrollButtons(newTrack);
      }
    }
  }

  updateTimelineScrollButtons(track) {
    if (!track) return;
    const wrapper = track.closest('.corridor-timeline-wrapper');
    if (!wrapper) return;
    const leftBtn = wrapper.querySelector('.btn-timeline-scroll-left');
    const rightBtn = wrapper.querySelector('.btn-timeline-scroll-right');
    const canScroll = track.scrollWidth > track.clientWidth + 2;
    if (leftBtn) {
      const atStart = track.scrollLeft <= 5 || !canScroll;
      leftBtn.classList.toggle('is-disabled', atStart);
    }
    if (rightBtn) {
      const atEnd = Math.ceil(track.scrollLeft + track.clientWidth) >= (track.scrollWidth - 5) || !canScroll;
      rightBtn.classList.toggle('is-disabled', atEnd);
    }
  }

  // ==========================================
  // 6. STOPS BROWSER & SELECTOR (UNIVERSAL)
  // ==========================================

  populateSelect(selectId, lineDataOrStops, selectedId) {
    const select = document.getElementById(selectId);
    if (!select) return;

    if (lineDataOrStops && typeof lineDataOrStops === 'object' && !Array.isArray(lineDataOrStops)) {
      const lineData = lineDataOrStops;
      const isBoth = this.activeDirection === 'both' || lineData.direction === 'both';
      const allDirs = (isBoth && lineData.allDirections && lineData.allDirections.length > 1) 
        ? lineData.allDirections 
        : ((isBoth && lineData.secondaryStops && lineData.secondaryStops.length > 0)
            ? [
                { dirId: '1', name: lineData.directionName || 'Sentit 1', stops: lineData.stops || [] },
                { dirId: '0', name: 'Sentit 2', stops: lineData.secondaryStops || [] }
              ]
            : null);

      if (isBoth && allDirs) {
        select.innerHTML = allDirs.map(d => {
          const dirName = d.name || `Sentit ${d.dirId}`;
          const options = (d.stops || []).map(s => {
            const id = String(s.mouteStopId || s.id || s.code);
            const isSel = id === String(selectedId);
            return `<option value="${id}" ${isSel ? 'selected' : ''}>#${s.seq || ''} ${this.esc(s.name)}</option>`;
          }).join('');
          return `<optgroup label="${this.esc(dirName)}">${options}</optgroup>`;
        }).join('');
        return;
      }

      const stops = lineData.stops || [];
      select.innerHTML = stops.map(s => {
        const id = String(s.mouteStopId || s.id || s.code);
        const isSel = id === String(selectedId);
        return `<option value="${id}" ${isSel ? 'selected' : ''}>#${s.seq || ''} ${this.esc(s.name)}</option>`;
      }).join('');
      return;
    }

    const stops = Array.isArray(lineDataOrStops) ? lineDataOrStops : [];
    select.innerHTML = stops.map(s => {
      const id = String(s.mouteStopId || s.id || s.code);
      const isSel = id === String(selectedId);
      return `<option value="${id}" ${isSel ? 'selected' : ''}>#${s.seq || ''} ${this.esc(s.name)}</option>`;
    }).join('');
  }

  setStopsViewMode(mode) {
    this.stopsViewMode = mode;
    const listBtn = document.getElementById('btn-stops-mode-list');
    const schematicBtn = document.getElementById('btn-stops-mode-schematic');
    const listScroll = document.getElementById('stops-list-scroll');
    const schematicScroll = document.getElementById('stops-schematic-scroll');
    const searchInput = document.getElementById('stop-search-input');

    if (mode === 'schematic') {
      listBtn?.classList.remove('active');
      listBtn?.setAttribute('aria-selected', 'false');
      schematicBtn?.classList.add('active');
      schematicBtn?.setAttribute('aria-selected', 'true');
      if (listScroll) listScroll.style.display = 'none';
      if (schematicScroll) schematicScroll.style.display = 'block';
      if (searchInput) {
        searchInput.style.display = 'block';
        searchInput.placeholder = "🔍 Cercar parada al termòmetre (ex: Tereses, 1016, Hospital)...";
        if (searchInput.value) this.filterSchematicStops(searchInput.value.toLowerCase().trim());
      }
      this.renderSchematicThermometer(this.activeLineData, this.activeLineId);
    } else {
      schematicBtn?.classList.remove('active');
      schematicBtn?.setAttribute('aria-selected', 'false');
      listBtn?.classList.add('active');
      listBtn?.setAttribute('aria-selected', 'true');
      if (schematicScroll) schematicScroll.style.display = 'none';
      if (listScroll) listScroll.style.display = 'block';
      if (searchInput) {
        searchInput.style.display = 'block';
        searchInput.placeholder = "🔍 Filtrar llista de parades...";
        if (searchInput.value) this.filterListStops(searchInput.value.toLowerCase().trim());
      }
    }
  }

  filterSchematicStops(q) {
    const blocks = document.querySelectorAll('#stops-schematic-scroll .schematic-stop-block');
    const clearBtn = document.getElementById('btn-clear-stop-search');
    if (clearBtn) clearBtn.style.display = q ? 'flex' : 'none';

    if (!q) {
      blocks.forEach(b => {
        b.classList.remove('schematic-match', 'schematic-dimmed');
      });
      return;
    }

    let firstMatch = null;
    blocks.forEach(block => {
      const name = (block.querySelector('.schematic-stop-name')?.textContent || '').toLowerCase();
      const meta = (block.querySelector('.schematic-stop-meta')?.textContent || '').toLowerCase();
      const stopId = String(block.querySelector('.schematic-station-item')?.getAttribute('data-stop-id') || '').toLowerCase();
      
      const isMatch = name.includes(q) || meta.includes(q) || stopId.includes(q);
      if (isMatch) {
        block.classList.add('schematic-match');
        block.classList.remove('schematic-dimmed');
        if (!firstMatch) firstMatch = block;
      } else {
        block.classList.remove('schematic-match');
        block.classList.add('schematic-dimmed');
      }
    });

    if (firstMatch) {
      firstMatch.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  filterListStops(q) {
    const clearBtn = document.getElementById('btn-clear-stop-search');
    if (clearBtn) clearBtn.style.display = q ? 'flex' : 'none';

    const sections = document.querySelectorAll('#stops-list-scroll .stops-dir-section');
    if (sections.length > 0) {
      sections.forEach(sec => {
        let visibleInSec = 0;
        sec.querySelectorAll('.stop-row-item').forEach(row => {
          const text = row.textContent.toLowerCase();
          const matches = !q || text.includes(q);
          row.style.display = matches ? 'flex' : 'none';
          if (matches) visibleInSec++;
        });
        sec.style.display = (visibleInSec > 0 || !q) ? 'flex' : 'none';
      });
    } else {
      document.querySelectorAll('#stops-list-scroll .stop-row-item').forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = (!q || text.includes(q)) ? 'flex' : 'none';
      });
    }
  }

  shareLiveBus(vehicleId) {
    if (!vehicleId) return;
    const line = this.activeLineData || {};
    const lineCode = line.code || (this.activeLineId ? `L${this.activeLineId}` : '');
    const lineHash = this.activeLineId === 'c10' ? 'c10' : `l${this.activeLineId}`;
    
    // Dynamically derive current origin and pathname (works on 87.106.33.66:3000, localhost, or domain)
    const origin = window.location.origin || `${window.location.protocol}//${window.location.host}`;
    const shareUrl = `${origin}${window.location.pathname}#${lineHash}?bus=${encodeURIComponent(vehicleId)}`;

    const shareTitle = `Arribo! — Bus #${vehicleId} (${lineCode})`;
    const shareText = `Segueix en directe el Bus #${vehicleId} de la línia ${lineCode} a Mataró:`;

    if (navigator.share && /mobile|android|iphone|ipad/i.test(navigator.userAgent)) {
      navigator.share({
        title: shareTitle,
        text: shareText,
        url: shareUrl
      }).then(() => {
        this.showToast(`✅ Enllaç compartit`);
      }).catch((err) => {
        if (err.name !== 'AbortError') {
          this.copyToClipboard(shareUrl, `📋 Enllaç copiat: Bus #${vehicleId}`);
        }
      });
    } else {
      this.copyToClipboard(shareUrl, `📋 Enllaç copiat al porta-retalls!`);
    }
  }

  copyToClipboard(text, successMsg = '📋 Enllaç copiat al porta-retalls!') {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text)
        .then(() => this.showToast(successMsg))
        .catch(() => this.fallbackCopyText(text, successMsg));
    } else {
      this.fallbackCopyText(text, successMsg);
    }
  }

  fallbackCopyText(text, successMsg) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      this.showToast(successMsg);
    } catch (_) {
      prompt('Copia aquest enllaç de seguiment en directe:', text);
    }
  }

  showToast(message, duration = 3500) {
    let toast = document.getElementById('app-toast-container');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'app-toast-container';
      toast.className = 'app-toast-container';
      document.body.appendChild(toast);
    }
    const item = document.createElement('div');
    item.className = 'app-toast-item';
    item.innerHTML = `
      <span class="app-toast-msg">${this.esc(message)}</span>
      <button type="button" class="app-toast-close" aria-label="Tancar">✕</button>
    `;
    item.querySelector('.app-toast-close')?.addEventListener('click', () => {
      item.classList.add('hide');
      setTimeout(() => item.remove(), 250);
    });
    toast.appendChild(item);
    requestAnimationFrame(() => item.classList.add('show'));
    setTimeout(() => {
      if (item.parentNode) {
        item.classList.remove('show');
        item.classList.add('hide');
        setTimeout(() => item.remove(), 300);
      }
    }, duration);
  }

  processPendingSharedFocus(lData) {
    if (this.pendingDirection && this.pendingDirection !== this.activeDirection) {
      const targetDir = this.pendingDirection;
      this.pendingDirection = null;
      this.switchLine(this.activeLineId, targetDir);
      return;
    }

    if (this.pendingFocusBusId) {
      const busId = this.pendingFocusBusId;
      this.pendingFocusBusId = null;
      setTimeout(() => {
        const found = (this.activeBuses || []).find(b => 
          String(b.vehicleId || b.tripId || '').trim() === String(busId).trim() ||
          String(b.vehicleId || '').replace(/[^0-9]/g, '') === String(busId).replace(/[^0-9]/g, '')
        );
        if (found) {
          const vId = found.vehicleId || found.tripId;
          this.focusBusOnMap(vId, { lat: found.lat, lon: found.lon });
          this.mapController?.openBusPopup(vId);
          this.highlightSchematicBus(vId);
          this.showToast(`🚌 Seguint en directe el Bus #${vId} (${lData?.code || 'Línia'})`);
        } else {
          this.showToast(`ℹ️ Bus #${busId} no localitzat en circulació en aquest moment`);
        }
      }, 400);
    }

    if (this.pendingFocusStopId) {
      const rawTarget = this.pendingFocusStopId;
      const targetQuery = rawTarget.toLowerCase().trim();
      this.pendingFocusStopId = null;
      setTimeout(() => {
        const stopObj = (this.allStops || []).find(s => 
          String(s.id || '').toLowerCase() === targetQuery ||
          String(s.code || '').toLowerCase() === targetQuery ||
          String(s.name || '').toLowerCase() === targetQuery ||
          String(s.name || '').toLowerCase().includes(targetQuery) ||
          targetQuery.includes(String(s.name || '').toLowerCase())
        );

        const sId = stopObj ? String(stopObj.id || stopObj.code) : rawTarget;
        const sName = stopObj?.name || rawTarget;
        this.setTargetStop(sId);

        if (stopObj && stopObj.lat && stopObj.lon) {
          this.mapController?.focusTargetStop(stopObj.lat, stopObj.lon);
          this.inspectStop(sId, sName);
        }

        const sBlock = document.querySelector(`.schematic-stop-block [data-stop-id="${sId}"]`);
        if (sBlock) {
          sBlock.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 400);
    }

    if (this.pendingSearchQuery) {
      const q = this.pendingSearchQuery;
      this.pendingSearchQuery = null;
      const searchInput = document.getElementById('stop-search-input');
      if (searchInput) {
        searchInput.value = q;
        if (this.stopsViewMode === 'schematic') {
          this.filterSchematicStops(q);
        } else {
          this.filterListStops(q);
        }
      }
    }
  }

  highlightSchematicBus(busId) {
    if (!busId) return;
    const chips = document.querySelectorAll(`.schematic-bus-chip[data-vehicle-id="${busId}"]`);
    if (chips.length > 0) {
      chips.forEach(chip => {
        chip.classList.add('spotlight-active');
        chip.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      setTimeout(() => {
        chips.forEach(chip => chip.classList.remove('spotlight-active'));
      }, 6000);
    }
  }

  renderSingleSchematicTrack({ stops, dirName, dirId, lineColor, lineCode, activeVehicles, currentTargetId, isHubStop, isBoth, dirIndex }) {
    if (!stops || stops.length === 0) {
      return `
        <div class="schematic-dir-section" id="schematic-group-${dirId}">
          <div class="stops-dir-header" style="border-left-color:${this.esc(lineColor)};">
            <strong class="stops-dir-name">${this.esc(dirName)}</strong>
          </div>
          <div style="text-align:center; padding:1.5rem; color:var(--text-muted); font-size:0.8rem;">Sense parades per a aquest sentit</div>
        </div>
      `;
    }

    // Map each vehicle to its nearest stop or segment along this direction
    const dockedBusesByStop = new Map();
    const transitBusesBySegment = new Map();

    activeVehicles.forEach(b => {
      const bLat = parseFloat(b.latitude ?? b.lat);
      const bLon = parseFloat(b.longitude ?? b.lon);
      if (!Number.isFinite(bLat) || !Number.isFinite(bLon)) return;

      let closestIdx = -1;
      let minDistance = Infinity;

      for (let i = 0; i < stops.length; i++) {
        const s = stops[i];
        const sLat = parseFloat(s.latitude ?? s.lat ?? (s.coords && s.coords.lat));
        const sLon = parseFloat(s.longitude ?? s.lon ?? (s.coords && s.coords.lon));
        if (!Number.isFinite(sLat) || !Number.isFinite(sLon)) continue;

        const dLat = (bLat - sLat) * 111320;
        const dLon = (bLon - sLon) * 111320 * Math.cos(bLat * Math.PI / 180);
        const dist = Math.sqrt(dLat * dLat + dLon * dLon);

        if (dist < minDistance) {
          minDistance = dist;
          closestIdx = i;
        }
      }

      if (closestIdx !== -1) {
        if (minDistance <= 70) {
          // Bus is docked at stop
          if (!dockedBusesByStop.has(closestIdx)) dockedBusesByStop.set(closestIdx, []);
          dockedBusesByStop.get(closestIdx).push({ ...b, dist: minDistance });
        } else {
          // Bus is progressing along segment between stops
          const segIdx = (closestIdx < stops.length - 1) ? closestIdx : Math.max(0, closestIdx - 1);
          if (!transitBusesBySegment.has(segIdx)) transitBusesBySegment.set(segIdx, []);
          transitBusesBySegment.get(segIdx).push({ ...b, dist: minDistance });
        }
      }
    });

    const dirIcon = dirIndex === 0 ? '➔' : (dirIndex === 1 ? '⬅' : '⇄');

    let html = `
      <div class="schematic-dir-section" id="schematic-group-${dirId}">
        <div class="stops-dir-header" style="border-left-color:${this.esc(lineColor)};">
          <div class="stops-dir-header-info">
            <div class="stops-dir-header-title-row">
              <span class="stops-dir-icon">${dirIcon}</span>
              <strong class="stops-dir-name">${this.esc(dirName)}</strong>
              <span class="stops-dir-count-pill">${stops.length} parades</span>
              <span class="schematic-bus-active-count">
                ${CANONICAL_BUS_ICON_SVG} ${activeVehicles.length} ${activeVehicles.length === 1 ? 'bus actiu' : 'busos actius'}
              </span>
            </div>
          </div>
          ${isBoth ? `
            <button type="button" class="btn-select-dir-view" data-dir-id="${dirId}" title="Seleccionar i filtrar només aquest sentit">
              <span>Filtrar aquest sentit</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          ` : ''}
        </div>

        <div class="schematic-spine-wrapper">
          <div class="schematic-spine-line" style="background:${this.esc(lineColor)};"></div>
    `;

    stops.forEach((s, idx) => {
      const sId = String(s.mouteStopId || s.id || s.code);
      const isTarget = sId === String(currentTargetId);
      const hub = isHubStop(s);
      const isFirst = idx === 0;
      const isLast = idx === stops.length - 1;
      const isTerminus = isFirst || isLast;
      const isCancelled = Boolean(s.isCancelled);

      const dockedBuses = dockedBusesByStop.get(idx) || [];
      const transitBuses = transitBusesBySegment.get(idx) || [];

      html += `
        <div class="schematic-stop-block">
          <div class="schematic-station-item ${isTarget ? 'is-target' : ''} ${hub ? 'is-hub' : ''} ${isTerminus ? 'is-terminus' : ''}" data-stop-id="${this.esc(sId)}" data-stop-name="${this.esc(s.name)}" data-dir-id="${dirId}">
            <div class="schematic-node-col">
              <div class="schematic-node-circle ${hub ? 'hub-circle' : ''} ${isTarget ? 'target-circle' : ''} ${isCancelled ? 'cancelled-circle' : ''}" style="border-color:${this.esc(lineColor)};">
                ${hub ? `<span class="schematic-node-hub-icon">${hub.icon}</span>` : `<span class="schematic-node-num">${idx + 1}</span>`}
              </div>
            </div>

            <div class="schematic-content-col">
              <div class="schematic-stop-name-row">
                <span class="schematic-stop-name ${isCancelled ? 'is-cancelled' : ''}">${this.esc(s.name)}</span>
                ${isTarget ? '<span class="schematic-target-badge">⭐ Parada seleccionada</span>' : ''}
                ${isCancelled ? '<span class="schematic-cancelled-badge">❌ Anul·lada</span>' : ''}
              </div>

              ${hub ? `
                <div class="schematic-hub-badge">
                  <span>${hub.icon}</span>
                  <span>${this.esc(hub.label)}</span>
                </div>
              ` : ''}

              <div class="schematic-stop-meta">
                <span>#${this.esc(s.code || sId)}</span>
                ${s.zone ? `<span>• ${this.esc(s.zone)}</span>` : ''}
              </div>

              ${dockedBuses.length > 0 ? `
                <div class="schematic-docked-buses-container">
                  ${dockedBuses.map(b => {
                    const delayClass = (b.delayMins > 3) ? 'delay-late' : (b.delayMins > 0 ? 'delay-warning' : 'delay-on-time');
                    const badgeText = b.delayBadgeText || (b.delayMins > 0 ? `+${b.delayMins} min` : 'A l\'hora');
                    const isHybrid = Boolean(b.isHybrid || b.propulsion === 'hybrid');
                    const ecoClass = isHybrid ? 'is-hybrid' : 'is-diesel';
                    const ecoBadge = b.propulsionBadge || (isHybrid ? 'Híbrid Eco' : 'Dièsel');
                    return `
                      <div class="schematic-bus-chip docked ${delayClass}" data-vehicle-id="${this.esc(b.vehicleId)}" data-lat="${b.latitude || b.lat}" data-lon="${b.longitude || b.lon}" title="Fes clic per centrar aquest bus al mapa">
                        <span class="schematic-bus-pulse-dot"></span>
                        <strong class="schematic-bus-id">#${this.esc(b.vehicleId)}</strong>
                        <span class="schematic-bus-badge">${this.esc(badgeText)}</span>
                        <span class="schematic-bus-eco ${ecoClass}">${this.esc(ecoBadge)}</span>
                        <button type="button" class="btn-share-bus" data-share-bus="${this.esc(b.vehicleId)}" title="Compartir enllaç en directe del Bus #${this.esc(b.vehicleId)}">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                        </button>
                      </div>
                    `;
                  }).join('')}
                </div>
              ` : ''}
            </div>
          </div>

          ${!isLast ? `
            <div class="schematic-segment-row">
              <div class="schematic-segment-line" style="background:${this.esc(lineColor)};"></div>
              <div class="schematic-segment-buses">
                ${transitBuses.map(b => {
                  const delayClass = (b.delayMins > 3) ? 'delay-late' : (b.delayMins > 0 ? 'delay-warning' : 'delay-on-time');
                  const badgeText = b.delayBadgeText || (b.delayMins > 0 ? `+${b.delayMins} min` : 'A l\'hora');
                  const speedText = b.speedKmh ? `${Math.round(b.speedKmh)} km/h` : 'En trànsit';
                  const isHybrid = Boolean(b.isHybrid || b.propulsion === 'hybrid');
                  const ecoClass = isHybrid ? 'is-hybrid' : 'is-diesel';
                  const ecoBadge = b.propulsionBadge || (isHybrid ? 'Híbrid Eco' : 'Dièsel');
                  return `
                    <div class="schematic-bus-chip in-transit ${delayClass}" data-vehicle-id="${this.esc(b.vehicleId)}" data-lat="${b.latitude || b.lat}" data-lon="${b.longitude || b.lon}" title="Fes clic per centrar aquest bus al mapa">
                      <span class="schematic-transit-arrow">↓</span>
                      <strong class="schematic-bus-id">#${this.esc(b.vehicleId)}</strong>
                      <span class="schematic-bus-speed">${this.esc(speedText)}</span>
                      <span class="schematic-bus-badge">${this.esc(badgeText)}</span>
                      <span class="schematic-bus-eco ${ecoClass}">${this.esc(ecoBadge)}</span>
                      <button type="button" class="btn-share-bus" data-share-bus="${this.esc(b.vehicleId)}" title="Compartir enllaç en directe del Bus #${this.esc(b.vehicleId)}">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                      </button>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>
          ` : ''}
        </div>
      `;
    });

    html += `
        </div>
      </div>
    `;

    return html;
  }

  renderSchematicThermometer(lineDataOrStops, lineKey) {
    const container = document.getElementById('stops-schematic-scroll');
    if (!container) return;

    const isLineDataObject = lineDataOrStops && typeof lineDataOrStops === 'object' && !Array.isArray(lineDataOrStops);
    const lineData = isLineDataObject ? lineDataOrStops : (this.activeLineData || null);
    const isBoth = this.activeDirection === 'both' || lineData?.direction === 'both';
    const currentTargetId = this.targetStopsByLine[lineKey] || this.targetStopsByLine[`${lineKey}_${this.activeDirection}`] || '';
    const lineColor = (lineData?.lineColor || lineData?.color || '#009485');
    const secondaryColor = (lineData?.secondaryColor || '#38bdf8');
    const allActiveVehicles = Array.isArray(this.activeBuses) ? this.activeBuses : (lineData?.activeBuses || []);

    const isHubStop = (s) => {
      const name = (s.name || '').toLowerCase();
      const code = String(s.code || s.id || '');
      if (name.includes('rodalies') || code === '1016' || code === '1015') return { type: 'train', icon: '🚆', label: 'Rodalies Renfe R1/RG1' };
      if (name.includes('hospital') || code === '1001') return { type: 'hospital', icon: '🏥', label: 'Hospital de Mataró' };
      if (name.includes('tereses') || code === '1060') return { type: 'hub', icon: '🏛️', label: 'Centre / Connexions Urbanes' };
      if (name.includes('mataró parc') || name.includes('mataro parc')) return { type: 'mall', icon: '🛍️', label: 'Mataró Parc Comercial' };
      if (name.includes('estació d\'autobusos') || name.includes('estacio d\'autobusos')) return { type: 'bus', icon: '🚌', label: 'Estació d\'Autobusos' };
      return null;
    };

    // Check if both directions are present
    const allDirs = (isBoth && lineData) ? (
      (lineData.allDirections && lineData.allDirections.length > 1)
        ? lineData.allDirections
        : (lineData.secondaryStops && lineData.secondaryStops.length > 0
            ? [
                { dirId: '0', name: lineData.directionName || 'Sentit 1', stops: lineData.stops || [] },
                { dirId: '1', name: 'Sentit 2', stops: lineData.secondaryStops || [] }
              ]
            : null)
    ) : null;

    if (isBoth && allDirs && allDirs.length > 1) {
      // Split vehicles accurately across directions
      const busesByDir = new Map();
      allDirs.forEach(d => busesByDir.set(String(d.dirId !== undefined ? d.dirId : (d.id !== undefined ? d.id : '0')), []));

      allActiveVehicles.forEach(b => {
        const bLat = parseFloat(b.latitude ?? b.lat);
        const bLon = parseFloat(b.longitude ?? b.lon);

        // 1. Direct direction ID match
        if (b.direction !== undefined && b.direction !== null && String(b.direction).trim() !== '') {
          const strDir = String(b.direction).trim();
          const matchDir = allDirs.find(d => String(d.dirId !== undefined ? d.dirId : d.id).trim() === strDir);
          if (matchDir) {
            const mId = String(matchDir.dirId !== undefined ? matchDir.dirId : matchDir.id);
            busesByDir.get(mId)?.push(b);
            return;
          }
        }

        // 2. Destination matching
        if (b.destination) {
          const dest = b.destination.toLowerCase().trim();
          const matchDir = allDirs.find(d => {
            if (!d.name) return false;
            const dName = d.name.toLowerCase().trim();
            return dName.includes(dest) || dest.includes(dName.substring(0, 8));
          });
          if (matchDir) {
            const mId = String(matchDir.dirId !== undefined ? matchDir.dirId : matchDir.id);
            busesByDir.get(mId)?.push(b);
            return;
          }
        }

        // 3. Proximity fallback
        if (Number.isFinite(bLat) && Number.isFinite(bLon)) {
          let bestDirId = String(allDirs[0].dirId !== undefined ? allDirs[0].dirId : allDirs[0].id);
          let bestDist = Infinity;
          allDirs.forEach(d => {
            const currentDirId = String(d.dirId !== undefined ? d.dirId : d.id);
            (d.stops || []).forEach(s => {
              const sLat = parseFloat(s.latitude ?? s.lat ?? (s.coords && s.coords.lat));
              const sLon = parseFloat(s.longitude ?? s.lon ?? (s.coords && s.coords.lon));
              if (!Number.isFinite(sLat) || !Number.isFinite(sLon)) return;
              const dLat = (bLat - sLat) * 111320;
              const dLon = (bLon - sLon) * 111320 * Math.cos(bLat * Math.PI / 180);
              const dist = Math.sqrt(dLat * dLat + dLon * dLon);
              if (dist < bestDist) {
                bestDist = dist;
                bestDirId = currentDirId;
              }
            });
          });
          busesByDir.get(bestDirId)?.push(b);
        } else {
          const firstDirId = String(allDirs[0].dirId !== undefined ? allDirs[0].dirId : allDirs[0].id);
          busesByDir.get(firstDirId)?.push(b);
        }
      });

      const totalStops = allDirs.reduce((acc, d) => acc + (d.stops?.length || 0), 0);

      let html = `
        <div class="schematic-container" style="--schematic-line-color:${this.esc(lineColor)};">
          <div class="schematic-header-summary">
            <div style="display:flex; align-items:center; gap:8px;">
              <span class="schematic-line-tag" style="background:${this.esc(lineColor)};">
                ${this.esc(lineData?.code || lineKey || 'Línia')}
              </span>
              <span class="schematic-dir-title">⇄ Ambdós sentits (${allDirs.length} recorreguts, ${totalStops} parades)</span>
            </div>
            <span class="schematic-bus-active-count">
              ${CANONICAL_BUS_ICON_SVG} ${allActiveVehicles.length} ${allActiveVehicles.length === 1 ? 'bus actiu' : 'busos actius'}
            </span>
          </div>

          <!-- Direction Jump Navigator Bar for Schematic -->
          <div class="stops-directions-nav" style="margin-bottom:0.85rem;">
            <span class="stops-nav-label">Anar a:</span>
            <div class="stops-nav-buttons">
              ${allDirs.map((d, idx) => {
                const dirId = String(d.dirId !== undefined ? d.dirId : (d.id !== undefined ? d.id : idx));
                const dirIcon = idx === 0 ? '➔' : '⬅';
                return `
                  <button type="button" class="btn-dir-jump" data-dir-target="schematic-group-${dirId}" title="Desplaçar a les parades de ${this.esc(d.name)}">
                    <span>${dirIcon} ${this.esc(d.name)}</span>
                    <span class="btn-dir-jump-badge">${(d.stops || []).length} parades</span>
                  </button>
                `;
              }).join('')}
            </div>
          </div>
      `;

      allDirs.forEach((d, dIdx) => {
        const dirId = String(d.dirId !== undefined ? d.dirId : (d.id !== undefined ? d.id : dIdx));
        const dirBuses = busesByDir.get(dirId) || [];
        const dirColor = (dIdx === 0) ? lineColor : secondaryColor;
        html += this.renderSingleSchematicTrack({
          stops: d.stops || [],
          dirName: d.name,
          dirId,
          lineColor: dirColor,
          lineCode: lineData?.code || lineKey,
          activeVehicles: dirBuses,
          currentTargetId,
          isHubStop,
          isBoth: true,
          dirIndex: dIdx
        });
      });

      html += `</div>`;
      container.innerHTML = html;
      return;
    }

    // Single direction fallback
    const stops = Array.isArray(lineDataOrStops) ? lineDataOrStops : (lineData?.stops || this.allStops || []);
    if (!stops || stops.length === 0) {
      container.innerHTML = '<div style="text-align:center; padding:2rem; color:var(--text-muted);">Sense parades disponibles</div>';
      return;
    }

    const dirName = lineData?.directionName || 'Recorregut de la línia';
    const dirId = String(lineData?.direction !== undefined ? lineData.direction : (this.activeDirection || '1'));

    let html = `
      <div class="schematic-container" style="--schematic-line-color:${this.esc(lineColor)};">
        <div class="schematic-header-summary">
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="schematic-line-tag" style="background:${this.esc(lineColor)};">
              ${this.esc(lineData?.code || lineKey || 'Línia')}
            </span>
            <span class="schematic-dir-title">${this.esc(dirName)}</span>
          </div>
          <span class="schematic-bus-active-count">
            ${CANONICAL_BUS_ICON_SVG} ${allActiveVehicles.length} ${allActiveVehicles.length === 1 ? 'bus actiu' : 'busos actius'}
          </span>
        </div>
    `;

    html += this.renderSingleSchematicTrack({
      stops,
      dirName,
      dirId,
      lineColor,
      lineCode: lineData?.code || lineKey,
      activeVehicles: allActiveVehicles,
      currentTargetId,
      isHubStop,
      isBoth: false,
      dirIndex: 0
    });

    html += `</div>`;
    container.innerHTML = html;

    const searchInput = document.getElementById('stop-search-input');
    if (searchInput && searchInput.value) {
      this.filterSchematicStops(searchInput.value.toLowerCase().trim());
    }
  }

  renderStopsBrowser(lineDataOrStops, lineKey) {
    this.ensureViewModeControlsExist();
    // If schematic view mode is active, refresh the thermometer
    if (this.stopsViewMode === 'schematic') {
      this.renderSchematicThermometer(lineDataOrStops, lineKey);
    }

    const container = document.getElementById('stops-list-scroll');
    const totalEl = document.getElementById('stops-total-count');
    if (!container) return;

    // Handle either lineData object or flat stops array
    const isLineDataObject = lineDataOrStops && typeof lineDataOrStops === 'object' && !Array.isArray(lineDataOrStops);
    const lineData = isLineDataObject ? lineDataOrStops : null;
    const isBoth = this.activeDirection === 'both' || lineData?.direction === 'both';
    const currentTargetId = this.targetStopsByLine[lineKey] || this.targetStopsByLine[`${lineKey}_${this.activeDirection}`] || '';

    // If "both directions" is active and we have direction definitions
    const allDirs = (isBoth && lineData) ? (
      (lineData.allDirections && lineData.allDirections.length > 1)
        ? lineData.allDirections
        : (lineData.secondaryStops && lineData.secondaryStops.length > 0
            ? [
                { dirId: '1', name: lineData.directionName || 'Sentit 1', stops: lineData.stops || [] },
                { dirId: '0', name: 'Sentit 2', stops: lineData.secondaryStops || [] }
              ]
            : null)
    ) : null;

    if (isBoth && allDirs && allDirs.length > 1) {
      const totalStops = allDirs.reduce((acc, d) => acc + (d.stops?.length || 0), 0);
      if (totalEl) {
        totalEl.textContent = `${totalStops} (${allDirs.map(d => d.stops?.length || 0).join(' + ')})`;
      }

      // Render top direction jump bar + both direction sections stacked one below the other
      let html = `
        <div class="stops-directions-nav" id="stops-directions-nav">
          <span class="stops-nav-label">Anar a:</span>
          <div class="stops-nav-buttons">
            ${allDirs.map((d, idx) => `
              <button type="button" class="btn-dir-jump" data-dir-target="stops-group-${d.dirId}" title="Desplaçar a les parades de ${this.esc(d.name)}">
                <span>${idx === 0 ? '➔' : '⬅'} ${this.esc(d.name)}</span>
                <span class="btn-dir-jump-badge">${d.stops?.length || 0}</span>
              </button>
            `).join('')}
          </div>
        </div>
      `;

      html += allDirs.map((d, dIdx) => {
        const dirStops = d.stops || [];
        const dirIcon = dIdx === 0 ? '➔' : '⬅';
        return `
          <div class="stops-dir-section" id="stops-group-${d.dirId}" data-dir-id="${d.dirId}">
            <div class="stops-dir-header">
              <div class="stops-dir-header-info">
                <div class="stops-dir-header-title-row">
                  <span class="stops-dir-icon">${dirIcon}</span>
                  <strong class="stops-dir-name">${this.esc(d.name)}</strong>
                  <span class="stops-dir-count-pill">${dirStops.length} parades</span>
                </div>
              </div>
              <button type="button" class="btn-select-dir-view" data-dir-id="${d.dirId}" title="Seleccionar i filtrar només les parades d'aquest sentit">
                <span>Filtrar aquest sentit</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
            </div>
            
            <div class="stops-dir-items-list">
              ${dirStops.map((s, i) => {
                const id = String(s.mouteStopId || s.id || s.code);
                const isTarget = id === String(currentTargetId);
                const isCancelled = Boolean(s.isCancelled);
                return `
                  <div class="stop-row-item ${isTarget ? 'target-stop' : ''} ${isCancelled ? 'cancelled-stop' : ''}" data-stop-id="${id}" data-stop-name="${this.esc(s.name)}" data-dir-id="${d.dirId}">
                    <div class="stop-row-left">
                      <span class="stop-seq-badge ${isCancelled ? 'cancelled' : ''}">#${i + 1}</span>
                      <div>
                        <div class="stop-row-name">
                          <span style="${isCancelled ? 'text-decoration:line-through; color:#f87171;' : ''}">${this.esc(s.name)}</span>
                          ${isTarget ? '⭐' : ''}
                          ${isCancelled ? '<span class="stop-status-badge cancelled" style="margin-left:6px; background:rgba(239,68,68,0.25); color:#fca5a5; font-size:0.65rem; font-weight:800; padding:1px 6px; border-radius:4px; display:inline-block;">❌ Fora de servei</span>' : ''}
                        </div>
                        <div class="stop-row-zone">${this.esc(s.zone || 'Parada')} ${s.code ? `• Codi: ${this.esc(s.code)}` : ''}</div>
                      </div>
                    </div>
                    <button type="button" class="btn-icon btn-inspect-stop" style="width:34px; height:34px;" title="Veure arribades" data-stop-id="${id}" data-stop-name="${this.esc(s.name)}">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
                    </button>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        `;
      }).join('');

      container.innerHTML = html;
    } else {
      // Single direction mode
      const stops = Array.isArray(lineDataOrStops) ? lineDataOrStops : (lineData?.stops || []);
      if (totalEl) totalEl.textContent = stops.length;

      container.innerHTML = stops.map((s, i) => {
        const id = String(s.mouteStopId || s.id || s.code);
        const isTarget = id === String(currentTargetId);
        const isCancelled = Boolean(s.isCancelled);
        return `
          <div class="stop-row-item ${isTarget ? 'target-stop' : ''} ${isCancelled ? 'cancelled-stop' : ''}" data-stop-id="${id}" data-stop-name="${this.esc(s.name)}">
            <div class="stop-row-left">
              <span class="stop-seq-badge ${isCancelled ? 'cancelled' : ''}">#${i + 1}</span>
              <div>
                <div class="stop-row-name">
                  <span style="${isCancelled ? 'text-decoration:line-through; color:#f87171;' : ''}">${this.esc(s.name)}</span>
                  ${isTarget ? '⭐' : ''}
                  ${isCancelled ? '<span class="stop-status-badge cancelled" style="margin-left:6px; background:rgba(239,68,68,0.25); color:#fca5a5; font-size:0.65rem; font-weight:800; padding:1px 6px; border-radius:4px; display:inline-block;">❌ Fora de servei</span>' : ''}
                </div>
                <div class="stop-row-zone">${this.esc(s.zone || 'Parada')} ${s.code ? `• Codi: ${this.esc(s.code)}` : ''}</div>
              </div>
            </div>
            <button type="button" class="btn-icon btn-inspect-stop" style="width:34px; height:34px;" title="Veure arribades" data-stop-id="${id}" data-stop-name="${this.esc(s.name)}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </div>
        `;
      }).join('');
    }
  }

  setTargetStop(stopId) {
    const routeKey = `${this.activeLineId}_${this.activeDirection}`;
    const rawTarget = String(stopId || '').toLowerCase().trim();
    const foundStop = (this.allStops || []).find(s => 
      String(s.id || s.mouteStopId || s.code || '').toLowerCase() === rawTarget ||
      String(s.name || '').toLowerCase() === rawTarget ||
      String(s.name || '').toLowerCase().includes(rawTarget)
    );
    const resolvedId = foundStop ? String(foundStop.id || foundStop.code) : String(stopId);

    this.targetStopsByLine[routeKey] = resolvedId;
    this.targetStopsByLine[this.activeLineId] = resolvedId;
    localStorage.setItem('bad_amb_target_stops', JSON.stringify(this.targetStopsByLine));

    // Instant SWR Target Card render from client cache if available (<0ms)
    const etaCacheKey = `${routeKey}_${resolvedId}`;
    const cachedEta = this.targetEtaCache.get(etaCacheKey);
    if (cachedEta && (Date.now() - cachedEta.ts < this.TARGET_ETA_TTL_MS)) {
      this.renderTargetCard(cachedEta.data, this.activeLineData);
    } else {
      const stopObj = foundStop || this.allStops.find(s => String(s.id || s.mouteStopId || s.code) === resolvedId);
      if (stopObj) {
        const destName = this.activeLineData?.directions?.[0]?.name || this.activeLineData?.name || 'Destí';
        this.renderTargetCardLoading(this.activeLineData, stopObj.name, stopObj.code || stopObj.id, destName);
      }
    }

    this.refreshAllData(false);
  }

  // ==========================================
  // 7. STOP INSPECTION MODAL (UNIVERSAL)
  // ==========================================

  async inspectStop(stopId, stopName, stopSeq = null) {
    const modal = document.getElementById('stop-modal-backdrop');
    const titleEl = document.getElementById('modal-stop-title');
    const subEl = document.getElementById('modal-stop-subtitle');
    const listEl = document.getElementById('modal-departures-list');
    const countBadge = document.getElementById('modal-departures-count-badge');
    const setTargetBtn = document.getElementById('modal-set-target-btn');
    const mapsLink = document.getElementById('modal-maps-link');

    const prevBtn = document.getElementById('modal-prev-stop-btn');
    const prevName = document.getElementById('modal-prev-stop-name');
    const nextBtn = document.getElementById('modal-next-stop-btn');
    const nextName = document.getElementById('modal-next-stop-name');
    const seqBadge = document.getElementById('modal-stop-seq-badge');

    if (!modal) return;

    let stopsList = this.allStops || [];
    let currIndex = -1;

    if (stopSeq !== null && stopSeq !== undefined && Number.isInteger(stopSeq) && stopSeq >= 1 && stopSeq <= stopsList.length) {
      currIndex = stopSeq - 1;
    } else {
      currIndex = stopsList.findIndex(s => String(s.id || s.mouteStopId || s.code) === String(stopId));
    }

    if (currIndex === -1 && this.availableLines) {
      for (const line of this.availableLines) {
        for (const dir of (line.directions || [])) {
          const idx = (dir.stops || []).findIndex(s => String(s.id || s.mouteStopId || s.code) === String(stopId));
          if (idx !== -1) {
            stopsList = dir.stops;
            currIndex = idx;
            // Remember which direction owns this stop so that in 'ambdós'
            // mode the departures fetch targets the correct direction.
            this._resolvedStopDirection = String(dir.dirId || dir.id || '');
            break;
          }
        }
        if (currIndex !== -1) break;
      }
    }

    const totalStops = stopsList.length;
    const currStop = currIndex >= 0 ? stopsList[currIndex] : null;

    const displayName = stopName || currStop?.name || 'Parada';
    const displayCode = stopId || currStop?.code || currStop?.id || '--';

    if (titleEl) titleEl.textContent = displayName;
    if (subEl) subEl.textContent = `Codi identificador: ${displayCode}`;

    // SWR Cache Lookup for Instant 0ms Rendering
    const stopCacheKey = `${this.activeLineId}_${this.activeDirection}_${stopId}`;
    const cachedEntry = this.stopDeparturesCache.get(stopCacheKey);

    if (cachedEntry && cachedEntry.data) {
      // 0ms Instant Optimistic Render from memory cache
      this.renderModalDepartures(cachedEntry.data, stopId, currIndex, stopsList);
    } else {
      if (countBadge) countBadge.innerHTML = '<span class="loading-spinner-inline" style="width:10px;height:10px;border-width:1.5px;"></span>';
      if (listEl) listEl.innerHTML = '<div class="departures-loading-placeholder"><span class="loading-spinner-inline"></span> Sincronitzant properes sortides i horaris oficials...</div>';
    }

    if (seqBadge) {
      seqBadge.textContent = currIndex >= 0 ? `Parada #${currIndex + 1} / ${totalStops}` : 'Parada';
    }

    let prevStop = null;
    let prevSeq = null;
    let nextStop = null;
    let nextSeq = null;

    if (totalStops > 1 && currIndex >= 0) {
      // Find previous distinct stop
      for (let i = 1; i < totalStops; i++) {
        const pIdx = (currIndex - i + totalStops) % totalStops;
        const cand = stopsList[pIdx];
        if (cand && String(cand.id || cand.mouteStopId || cand.code) !== String(stopId)) {
          prevStop = cand;
          prevSeq = pIdx + 1;
          break;
        }
      }

      // Find next distinct stop
      for (let i = 1; i < totalStops; i++) {
        const nIdx = (currIndex + i) % totalStops;
        const cand = stopsList[nIdx];
        if (cand && String(cand.id || cand.mouteStopId || cand.code) !== String(stopId)) {
          nextStop = cand;
          nextSeq = nIdx + 1;
          break;
        }
      }
    }

    if (prevBtn && prevName) {
      if (prevStop) {
        prevBtn.disabled = false;
        prevName.textContent = prevStop.name.length > 14 ? `${prevStop.name.substring(0, 13)}…` : prevStop.name;
        prevBtn.onclick = (e) => {
          e.preventDefault();
          const pId = prevStop.id || prevStop.mouteStopId || prevStop.code;
          this.inspectStop(pId, prevStop.name, prevSeq);
          if (prevStop.lat && prevStop.lon) this.mapController.focusTargetStop(prevStop.lat, prevStop.lon);
        };
      } else {
        prevBtn.disabled = true;
        prevName.textContent = 'Capçalera';
        prevBtn.onclick = null;
      }
    }

    if (nextBtn && nextName) {
      if (nextStop) {
        nextBtn.disabled = false;
        nextName.textContent = nextStop.name.length > 14 ? `${nextStop.name.substring(0, 13)}…` : nextStop.name;
        nextBtn.onclick = (e) => {
          e.preventDefault();
          const nId = nextStop.id || nextStop.mouteStopId || nextStop.code;
          this.inspectStop(nId, nextStop.name, nextSeq);
          if (nextStop.lat && nextStop.lon) this.mapController.focusTargetStop(nextStop.lat, nextStop.lon);
        };
      } else {
        nextBtn.disabled = true;
        nextName.textContent = 'Terminus';
        nextBtn.onclick = null;
      }
    }

    modal.classList.add('active');

    if (setTargetBtn) {
      setTargetBtn.onclick = () => {
        this.setTargetStop(stopId);
        modal.classList.remove('active');
      };
    }

    const favBtn = document.getElementById('modal-toggle-fav-btn');
    const footerFavBtn = document.getElementById('modal-footer-fav-btn');
    const updateFavBtnState = () => {
      const isFav = this.isFavoriteStop(stopId);
      if (favBtn) {
        favBtn.classList.toggle('is-favorite', isFav);
        const starIcon = favBtn.querySelector('#modal-star-icon') || favBtn.querySelector('.star-icon');
        const starLabel = favBtn.querySelector('#modal-star-label') || favBtn.querySelector('.star-label');
        if (starIcon) starIcon.textContent = isFav ? '⭐' : '☆';
        if (starLabel) starLabel.textContent = isFav ? 'Preferida' : 'Preferida';
        favBtn.setAttribute('title', isFav ? 'Treure de parades preferides' : 'Afegir a parades preferides');
      }
      if (footerFavBtn) {
        footerFavBtn.classList.toggle('is-favorite', isFav);
        const footerIcon = footerFavBtn.querySelector('#modal-footer-fav-icon') || footerFavBtn.querySelector('.fav-action-icon');
        const footerText = footerFavBtn.querySelector('#modal-footer-fav-text');
        if (footerIcon) footerIcon.textContent = isFav ? '⭐' : '☆';
        if (footerText) footerText.textContent = isFav ? 'Preferida' : 'Afegir a Preferides';
        footerFavBtn.setAttribute('title', isFav ? 'Treure de parades preferides' : 'Afegir a parades preferides');
      }
    };

    updateFavBtnState();

    const handleFavToggle = (e) => {
      e.preventDefault();
      this.toggleFavoriteStop(stopId, displayName);
      updateFavBtnState();
    };

    if (favBtn) {
      favBtn.onclick = handleFavToggle;
    }
    if (footerFavBtn) {
      footerFavBtn.onclick = handleFavToggle;
    }

    // Silent background fetch / SWR revalidation
    try {
      let fetchDirection = this.activeDirection || '0';
      if (String(fetchDirection) === 'both' && this._resolvedStopDirection) {
        fetchDirection = this._resolvedStopDirection;
      }
      const endpoint = this.activeLineId
        ? `/api/line/${this.activeLineId}/stop/${stopId}/departures?direction=${fetchDirection}`
        : `/api/mataro/stop/${stopId}/departures`;
      const res = await fetch(endpoint).then(r => r.json());

      if (res.success && res.data) {
        // Save to cache for subsequent 0ms opens (bounded LRU-style, cap 50)
        if (this.stopDeparturesCache.size >= 50) {
          const oldestKey = this.stopDeparturesCache.keys().next().value;
          if (oldestKey !== undefined) this.stopDeparturesCache.delete(oldestKey);
        }
        this.stopDeparturesCache.set(stopCacheKey, { ts: Date.now(), data: res.data });

        // If modal is still open and displaying this stop, update seamlessly
        if (modal.classList.contains('active') && subEl && subEl.textContent.includes(String(displayCode))) {
          this.renderModalDepartures(res.data, stopId, currIndex, stopsList);
        }
      }
    } catch (e) {
      console.error('Stop departures fetch error:', e);
      if (!cachedEntry && listEl) {
        listEl.innerHTML = '<div style="color:var(--danger); font-size:0.85rem;">Error en carregar les sortides.</div>';
      }
    }
  }

  renderModalDepartures(data, stopId, currIndex, stopsList) {
    const listEl = document.getElementById('modal-departures-list');
    const countBadge = document.getElementById('modal-departures-count-badge');
    const mapsLink = document.getElementById('modal-maps-link');
    if (!listEl) return;

    const deps = data?.departures || [];
    const stopObj = data?.stop || {};

    if (countBadge) countBadge.textContent = `${deps.length} sortides`;

    if (mapsLink && stopObj.lat && stopObj.lon) {
      mapsLink.href = `https://www.google.com/maps/search/?api=1&query=${stopObj.lat},${stopObj.lon}`;
    }

    if (deps.length === 0) {
      listEl.innerHTML = '<div style="color:var(--text-muted); font-size:0.85rem; padding:0.5rem;">Sense arribades previstes en els propers 120 min.</div>';
      return;
    }

    const currStop = (currIndex >= 0 && stopsList) ? stopsList[currIndex] : null;
    const stopSeq = currStop?.seq || (currIndex >= 0 ? currIndex + 1 : null);

    const cancelledBanner = currStop?.isCancelled ? `
      <div style="background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.4); border-radius:8px; padding:0.65rem 0.9rem; margin-bottom:0.85rem; font-size:0.82rem; color:#fca5a5; display:flex; align-items:center; gap:8px;">
        <span style="font-size:1.1rem;">⚠️</span>
        <div><strong>Parada fora de servei:</strong> Aquesta parada està temporalment anul·lada per obres / desviament. Els autobusos d'aquesta línia no s'aturen aquí.</div>
      </div>
    ` : '';

    const modalItemsHtml = deps.map((d, idx) => {
      const rawTime = (d.expectedIso && !d.expectedIso.startsWith('0001-') && !d.expectedIso.startsWith('1970-'))
        ? new Date(d.expectedIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
        : (d.departureTime || '--:--');
      const estTime = this.formatTimeHHMM(String(rawTime).replace(/^[A-Za-zÀ-ÿ\.]+\s*(a\s*les\s*)?/i, '').trim());

      const rawSched = d.scheduledTime ||
        ((d.aimedIso && !d.isEstimated && !d.aimedIso.startsWith('0001-') && !d.aimedIso.startsWith('1970-'))
          ? new Date(d.aimedIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
          : (d.isRealTime && d.scheduledTime ? d.scheduledTime : null));
      const schedTime = rawSched ? this.formatTimeHHMM(String(rawSched).replace(/^[A-Za-zÀ-ÿ\.]+\s*(a\s*les\s*)?/i, '').trim()) : null;

      const isTomorrow = d.isToday === false && !d.isRealTime && !d.isEstimated;
      const isFirstMorning = isTomorrow && (d.isFirstOfDay === true || idx === 0) && !d.isRealTime && !d.isEstimated;
      const isFirstToday = d.isToday === true && d.isFirstOfDay === true && !d.isRealTime && !d.isEstimated;

      const isDiff = schedTime && schedTime !== estTime && !d.isEstimated;
      const rawDelayMins = d.delayMins !== undefined && d.delayMins !== null ? Number(d.delayMins) : 0;
      const delayText = rawDelayMins >= 2
        ? `+${rawDelayMins} min retard`
        : (rawDelayMins <= -1 ? `${Math.abs(rawDelayMins)} min avançat` : 'Puntual');

      const isLiveOrEstimated = Boolean(d.isRealTime || d.isEstimated || d.vehicleId);
      const matchedBus = isLiveOrEstimated ? this.resolveBusForDeparture(d, stopSeq, stopId, idx) : null;
      const resolvedVehicleId = matchedBus?.vehicleId || matchedBus?.tripId || (d.isRealTime ? d.vehicleId : '');
      const resolvedLat = matchedBus?.lat || (d.isRealTime ? d.busCoords?.lat : '');
      const resolvedLon = matchedBus?.lon || (d.isRealTime ? d.busCoords?.lon : '');
      const hasActiveBus = Boolean(matchedBus && (resolvedVehicleId || (resolvedLat && resolvedLon)));

      const minsText = isFirstMorning
        ? `🌅 Demà ${estTime}`
        : (isTomorrow
            ? `Demà ${estTime}`
            : (isFirstToday && (d.minutesAway === undefined || d.minutesAway > 180)
                ? `🌅 ${estTime}`
                : ((d.minutesAway !== undefined && d.minutesAway >= 0 && d.minutesAway <= 180)
                    ? (d.minutesAway <= 0 ? 'Ara' : (d.minutesAway === 1 ? '1 min' : `${d.minutesAway} min`))
                    : `${estTime}`)));

      const isRegulating = Boolean(d.delayStatus === 'regulating' || d.isRegulating || d.isTerminalLayover || d.arrivalTime);
      const arrTime = d.arrivalTime ? this.formatTimeHHMM(String(d.arrivalTime).trim()) : null;
      let depTime = (d.departureTime && d.departureTime !== '--:--') ? this.formatTimeHHMM(String(d.departureTime).trim()) : estTime;

      // Invariant: Departure time can NEVER be earlier than arrival time
      let hasValidLayoverInterval = false;
      let layoverMins = 0;
      let arrMinsAway = null;
      let depMinsAway = (d.minutesAway !== undefined && d.minutesAway !== null) ? Number(d.minutesAway) : null;

      if (arrTime && depTime && depTime !== '--:--' && arrTime !== '--:--') {
        let aSec = this.timeStringToSeconds(arrTime);
        let dSec = this.timeStringToSeconds(depTime);
        if (dSec < aSec && aSec > 22 * 3600 && dSec < 3 * 3600) {
          dSec += 86400; // Midnight rollover
        }
        if (dSec < aSec) {
          depTime = arrTime;
        } else if (dSec >= aSec) {
          hasValidLayoverInterval = true;
          layoverMins = Math.round((dSec - aSec) / 60);
        }

        if (d.arrivalMinutesAway !== undefined && d.arrivalMinutesAway !== null) {
          arrMinsAway = Number(d.arrivalMinutesAway);
        } else if (depMinsAway !== null && hasValidLayoverInterval) {
          arrMinsAway = depMinsAway - layoverMins;
        }
      }

      const isApproachingTerminal = isRegulating && arrMinsAway !== null && arrMinsAway > 0;
      const isParkedAtTerminal = isRegulating && arrMinsAway !== null && arrMinsAway <= 0;

      const tagLabel = isParkedAtTerminal
        ? ''
        : ((isFirstMorning || isFirstToday)
            ? '🌅 1r Servei'
            : (isTomorrow ? 'Programat' : (d.isEstimated ? '⚡ En ruta' : (d.isRealTime ? '🟢 Temps Real' : 'Programat'))));

      let regBadgeText = '';
      let regBadgeTitle = '';
      if (isRegulating) {
        if (isParkedAtTerminal) {
          regBadgeText = '🅿️ A la parada';
          regBadgeTitle = arrTime ? `Autobús a la parada des de les ${arrTime}` : 'Autobús a la parada en regulació';
        } else if (isApproachingTerminal) {
          regBadgeText = '⏱️ En camí';
          regBadgeTitle = `Arribada a capçalera prevista a les ${arrTime}${arrMinsAway !== null ? ` (${arrMinsAway <= 0 ? 'Ara' : (arrMinsAway === 1 ? '1 min' : `${arrMinsAway} min`)})` : ''}`;
        } else if (d.originTerminalName) {
          regBadgeText = '⏱️ En regulació';
          regBadgeTitle = `Autobús regulant a ${d.originTerminalName}${d.originDepartureTime ? ` (sortida: ${d.originDepartureTime})` : ''}`;
        } else {
          regBadgeText = '⏱️ En regulació';
          regBadgeTitle = 'Autobús en regulació de línia';
        }
        if (schedTime && isDiff) {
          regBadgeTitle += ` • Horari oficial teòric: ${schedTime}`;
        }
      }

      let pillLabel;
      if (isRegulating) {
        if (rawDelayMins >= 2) {
          pillLabel = delayText;
        } else if (rawDelayMins <= -1) {
          pillLabel = `${Math.abs(rawDelayMins)} min avançat`;
        } else {
          pillLabel = '⏱️ Regulació';
        }
      } else if (isFirstMorning || isFirstToday) {
        pillLabel = '1r Servei';
      } else if (isTomorrow) {
        pillLabel = 'Programat';
      } else if (d.isEstimated) {
        const hasExplicitDelay = Boolean(d.delayBadgeText && (d.delayBadgeText.includes('retard') || d.delayBadgeText.includes('avançat')));
        const estDelayBadge = hasExplicitDelay ? d.delayBadgeText : delayText;
        pillLabel = rawDelayMins >= 2 ? estDelayBadge : '⚡ En ruta';
      } else {
        pillLabel = d.delayBadgeText || 'Puntual';
      }

      const pillClass = isRegulating
        ? (rawDelayMins >= 2 ? 'delayed' : (rawDelayMins <= -1 ? 'early' : 'regulating'))
        : ((isTomorrow || isFirstToday) ? 'scheduled' : (rawDelayMins >= 2 ? 'delayed' : (rawDelayMins <= -1 ? 'early' : (d.delayStatus || 'on-time'))));

      const cleanDest = (d.destination || 'Destí').replace(/^Cap a\s+/i, '').trim() || 'Destí';
      let subtextHtml = '';
      let subtextTitle = '';

      if (isRegulating) {
        if (hasValidLayoverInterval) {
          if (isApproachingTerminal) {
            subtextHtml = `<span>⏱️ Arribada ${arrTime}${arrMinsAway !== null ? ` (${arrMinsAway <= 0 ? 'Ara' : (arrMinsAway === 1 ? '1 min' : `${arrMinsAway} min`)})` : ''}${layoverMins > 0 ? ` • Regulació: ${layoverMins} min` : ''}</span>`;
            subtextTitle = `Regulació a capçalera: Arribada prevista a les ${arrTime}${arrMinsAway !== null ? ` (en ${arrMinsAway <= 0 ? '0' : arrMinsAway} min)` : ''}${layoverMins > 0 ? ` • Pausa de regulació de ${layoverMins} min` : ''} • Sortida cap a ${cleanDest} a les ${depTime}${depMinsAway !== null ? ` (en ${depMinsAway} min)` : ''}${schedTime && isDiff ? ` [Horari oficial: ${schedTime}]` : ''}`;
          } else {
            subtextHtml = `<span>⏱️ A la parada des de les ${arrTime}${layoverMins > 0 ? ` • Regulació: ${layoverMins} min` : ''}</span>`;
            subtextTitle = `Regulació a capçalera: Autobús a la parada des de les ${arrTime}${layoverMins > 0 ? ` • Pausa de regulació de ${layoverMins} min` : ''} • Sortida cap a ${cleanDest} a les ${depTime}${depMinsAway !== null ? ` (en ${depMinsAway} min)` : ''}${schedTime && isDiff ? ` [Horari oficial: ${schedTime}]` : ''}`;
          }
        } else if (d.originTerminalName) {
          subtextHtml = `<span>⏱️ Regulant a ${this.esc(d.originTerminalName)}${d.originDepartureTime ? ` • Surt a les ${this.esc(d.originDepartureTime)}` : ''}</span>`;
          subtextTitle = `Autobús en regulació a ${d.originTerminalName}${d.originDepartureTime ? ` (sortida d'origen a les ${d.originDepartureTime})` : ''} • Arribada prevista aquí a les ${depTime}${depMinsAway !== null ? ` (en ${depMinsAway} min)` : ''}${schedTime && isDiff ? ` [Horari oficial: ${schedTime}]` : ''}`;
        } else {
          subtextHtml = `<span>⏱️ En regulació a capçalera • Sortida a les ${depTime}</span>`;
          subtextTitle = `Autobús en regulació a capçalera • Sortida prevista a les ${depTime}${depMinsAway !== null ? ` (en ${depMinsAway} min)` : ''}${schedTime && isDiff ? ` [Horari oficial: ${schedTime}]` : ''}`;
        }
      } else if (isFirstMorning) {
        subtextHtml = `<span>📅 Primer autobús del matí (Demà a les ${estTime})</span>`;
        subtextTitle = `Primer autobús del matí de demà a les ${estTime}`;
      } else if (isFirstToday) {
        subtextHtml = `<span>📅 Primer servei d'avui (a les ${estTime})</span>`;
        subtextTitle = `Primer servei programat d'avui a les ${estTime}`;
      } else if (isTomorrow) {
        subtextHtml = `<span>📅 Horari teòric: <strong class="sched-strong">Demà a les ${estTime}</strong></span>`;
        subtextTitle = `Sortida programada per a demà a les ${estTime}`;
      } else if (d.isRealTime) {
        if (schedTime && isDiff) {
          subtextHtml = `<span>📅 Horari teòric: <strong class="sched-strong">${schedTime}</strong> <span class="dep-delay-note ${rawDelayMins >= 2 ? 'delay' : (rawDelayMins <= -1 ? 'early' : 'on-time')}">(${delayText})</span></span>`;
          subtextTitle = `Temps real SIRI Avanza • Horari programat: ${schedTime} (${delayText})`;
        } else {
          subtextHtml = `<span>🟢 Arribada en temps real (SIRI Avanza)</span>`;
          subtextTitle = `Arribada transmesa en temps real pel sistema SIRI Avanza`;
        }
      } else if (d.isEstimated) {
        subtextHtml = `<span>⚡ Estimació de pas segons telemetria GPS</span>`;
        subtextTitle = `Estimació calculada segons telemetria GPS`;
      } else {
        subtextHtml = `<span>📅 Horari teòric programat</span>`;
        subtextTitle = `Horari teòric programat`;
      }

      const linePrefix = d.lineId ? `Línia ${d.lineId}: ` : '';
      const etaSuffix = minsText ? `, ${minsText}` : '';

      return `
        <div class="departure-item ${idx === 0 ? 'highlight-next' : ''} ${hasActiveBus ? 'clickable-bus-dep' : ''}"
             data-vehicle-id="${this.esc(resolvedVehicleId)}"
             data-bus-lat="${this.esc(resolvedLat)}"
             data-bus-lon="${this.esc(resolvedLon)}"
             data-stop-seq="${stopSeq || ''}"
             data-stop-id="${this.esc(stopId || '')}"
             data-dep-index="${idx}"
             ${hasActiveBus ? 'tabindex="0" role="button"' : 'role="listitem"'}
             aria-label="${hasActiveBus ? `Localitzar al mapa: ${linePrefix}sortida de les ${depTime} cap a ${this.esc(cleanDest)}${etaSuffix}` : `${linePrefix}Sortida de les ${depTime} cap a ${this.esc(cleanDest)}${etaSuffix}`}"
             title="${hasActiveBus ? 'Fes clic per localitzar aquest autobús en directe al mapa' : ''}">
          <div class="dep-time-group">
            <div class="dep-time-row">
              <span class="dep-clock">${depTime}</span>
              ${isRegulating
                ? `<span class="dep-regulating-pill" title="${this.esc(regBadgeTitle)}">${regBadgeText}</span>`
                : (isDiff ? `<span class="dep-sched-pill" title="Horari oficial teòric: ${schedTime}">Oficial: ${schedTime}</span>` : '')}
              ${(!isParkedAtTerminal && tagLabel) ? `<span class="dep-tag-sub ${(isFirstMorning || isFirstToday) ? 'first-service' : ''}" title="${this.esc(tagLabel)}">${tagLabel}</span>` : ''}
            </div>
            
            <div class="dep-dest" title="Cap a ${this.esc(cleanDest)}">
              ${d.lineId ? `<span class="line-badge-sm" style="font-size:0.68rem; padding:1px 5px; margin-right:4px; background:var(--c10-primary);">${this.esc(d.lineId)}</span>` : ''}
              Cap a <strong>${this.esc(cleanDest)}</strong>
            </div>

            <div class="dep-time-sub" title="${this.esc(subtextTitle)}">
              ${subtextHtml}
            </div>
          </div>

          <div class="dep-status">
            <span class="dep-mins" style="${(isFirstMorning || isFirstToday) ? 'color:#fbbf24;' : (isTomorrow ? 'color:#94a3b8;' : '')}">${minsText}</span>
            <span class="dep-delay-pill ${pillClass}" title="${this.esc((d.isEstimated && rawDelayMins >= 2) ? pillLabel : (d.delayBadgeText || pillLabel))}">${this.esc(pillLabel)}</span>
            ${hasActiveBus ? `
              <span class="dep-map-cta">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polygon points="12 8 8 12 12 16 12 8"/></svg>
                Veure al mapa
              </span>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');

    const modalFooterHint = deps.length > 5 ? `
      <div class="dep-scroll-footer" style="text-align: center; padding: 0.6rem 0.5rem; font-size: 0.72rem; color: var(--text-muted); border-top: 1px dashed var(--border-subtle); margin-top: 0.25rem;">
        📜 Mostrant tot l'horari teòric oficial del dia • Desplaça per consultar totes les sortides
      </div>
    ` : '';

    listEl.innerHTML = modalItemsHtml + modalFooterHint;

    // Configure Proximity Wake-Up Alarm Button
    const alarmBtn = document.getElementById('modal-proximity-alarm-btn');
    const alarmBtnText = document.getElementById('modal-alarm-btn-text');
    if (alarmBtn && alarmBtnText) {
      const isAlarmActive = this.activeProximityAlarm && this.activeProximityAlarm.stopId === String(stopId);
      alarmBtn.classList.toggle('active', Boolean(isAlarmActive));
      alarmBtnText.textContent = isAlarmActive ? 'Alarma Activada ⏰' : "Avisa'm en arribar";
      alarmBtn.onclick = (e) => {
        e.preventDefault();
        this.toggleProximityAlarm({
          id: String(stopId),
          name: currStop?.name || stopObj?.name || 'Parada',
          lat: stopObj?.lat || currStop?.lat,
          lon: stopObj?.lon || currStop?.lon
        });
      };
    }
  }

  // ==========================================
  // 8. LINE EXPLORER MODAL & GLOBAL SEARCH
  // ==========================================

  openLinePicker() {
    const backdrop = document.getElementById('line-picker-modal-backdrop');
    const input = document.getElementById('line-picker-search-input');
    if (!backdrop) return;
    this.linePickerSearch = '';
    if (input) input.value = '';
    this.renderLinePicker();
    backdrop.classList.add('active');
    setTimeout(() => input?.focus(), 50);
  }

  closeLinePicker() {
    const backdrop = document.getElementById('line-picker-modal-backdrop');
    if (backdrop) backdrop.classList.remove('active');
  }

  renderLinePicker() {
    const container = document.getElementById('line-picker-container');
    if (!container) return;

    const q = (this.linePickerSearch || '').trim().toLowerCase();
    const cityFilter = this.linePickerFilter || 'all';

    const filterFn = (l) => {
      if (cityFilter !== 'all') {
        const matchId = String(l.id).toLowerCase() === cityFilter.toLowerCase() ||
                        String(l.code).toLowerCase() === `l${cityFilter}`.toLowerCase();
        if (!matchId) return false;
      }
      if (!q) return true;
      const code = (l.code || String(l.id)).toLowerCase();
      const name = (l.name || '').toLowerCase();
      const agency = (l.agency || '').toLowerCase();
      return code.includes(q) || name.includes(q) || agency.includes(q) || ('línia ' + code).includes(q) || ('linia ' + code).includes(q);
    };

    const linesToRender = this.availableLines.filter(filterFn);

    if (linesToRender.length === 0) {
      container.innerHTML = `
        <div style="padding: 2.5rem 1rem; text-align: center; color: var(--text-muted);">
          <div style="font-size: 2rem; margin-bottom: 0.5rem;">🔍</div>
          <div style="font-weight: 700; color: #fff; margin-bottom: 0.25rem;">Cap línia trobada</div>
          <div style="font-size: 0.85rem;">Prova amb una altra cerca (ex: L1, L2, L3, 5, 8)...</div>
        </div>
      `;
      return;
    }

    let html = `
      <div class="line-category-group">
        <div class="line-category-title">
          <span>📍 Mataró Bus Urbà (${linesToRender.length})</span>
        </div>
        <div class="line-grid">
          ${linesToRender.map(l => {
            const isActive = String(l.id) === String(this.activeLineId);
            const contrast = this.getContrastColor(l.color);
            return `
              <div class="line-grid-card ${isActive ? 'active' : ''}" data-line-id="${this.esc(l.id)}">
                <div class="line-card-left">
                  <span class="line-card-badge" style="background:${l.color}; color:${contrast};">${l.code}</span>
                  <div class="line-card-details">
                    <div class="line-card-name">${this.esc(l.code)}: ${this.esc(l.name)}</div>
                    <div class="line-card-sub">
                      <span>${l.agency || 'Mataró Bus'}</span>
                      <span>•</span>
                      <span>${l.directions ? `${l.directions.length} sentits` : 'En servei'}</span>
                    </div>
                  </div>
                </div>
                <span class="line-card-arrow">➔</span>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;

    container.innerHTML = html;
  }

  setupLinePicker() {
    const pickerContainer = document.getElementById('line-picker-container');
    pickerContainer?.addEventListener('click', (e) => {
      const card = e.target.closest('.line-grid-card');
      if (card) {
        e.preventDefault();
        const lineId = card.getAttribute('data-line-id');
        if (lineId) {
          this.closeLinePicker();
          this.switchLine(lineId);
        }
      }
    });

    document.getElementById('open-line-picker-btn')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.openLinePicker();
    });

    document.getElementById('line-selector-current-info')?.addEventListener('click', (e) => {
      if (e.target.closest('a')) {
        return; // Allow clicking links inside (e.g. PDF link) without opening picker
      }
      e.preventDefault();
      this.openLinePicker();
    });

    document.getElementById('line-picker-close-btn')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.closeLinePicker();
    });

    document.getElementById('line-picker-modal-backdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'line-picker-modal-backdrop') {
        this.closeLinePicker();
      }
    });

    const input = document.getElementById('line-picker-search-input');
    if (input) {
      input.addEventListener('input', () => {
        this.linePickerSearch = input.value;
        this.renderLinePicker();
      });
    }

    const filterTabsContainer = document.getElementById('line-picker-filter-tabs');
    if (filterTabsContainer) {
      filterTabsContainer.addEventListener('wheel', (e) => {
        if (e.deltaY !== 0) {
          e.preventDefault();
          filterTabsContainer.scrollLeft += e.deltaY;
        }
      }, { passive: false });
    }

    document.querySelectorAll('.line-filter-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelectorAll('.line-filter-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.linePickerFilter = tab.getAttribute('data-city') || 'all';
        this.renderLinePicker();
      });
    });

    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.openLinePicker();
      } else if (e.key === 'Escape') {
        this.closeLinePicker();
      }
    });
  }

  setupGlobalSearch() {
    const input = document.getElementById('global-search-input');
    const dropdown = document.getElementById('search-results-dropdown');
    if (!input || !dropdown) return;

    input.addEventListener('input', () => {
      clearTimeout(this.searchDebounceTimer);
      const q = input.value.trim();

      if (q.length < 1) {
        dropdown.classList.remove('active');
        dropdown.innerHTML = '';
        return;
      }

      this.searchDebounceTimer = setTimeout(async () => {
        try {
          const res = await fetch(`/api/search/stops?q=${encodeURIComponent(q)}`).then(r => r.json());
          if (res.success && res.results) {
            this.renderSearchResults(res.results, dropdown, input);
          }
        } catch (e) {
          console.error('Search error:', e);
        }
      }, 250);
    });

    document.addEventListener('click', (e) => {
      if (!input.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.classList.remove('active');
      }
    });
  }

  renderSearchResults(results, dropdown, input) {
    let itemsToRender = results;
    if (!this.showTrainsInUI) {
      itemsToRender = results.filter(r => !r.isTrain && !r.lineCode?.startsWith('R') && !r.agency?.toLowerCase().includes('rodalies') && !r.agency?.toLowerCase().includes('renfe'));
    }

    if (itemsToRender.length === 0) {
      dropdown.innerHTML = '<div style="padding:0.75rem 1rem; color:var(--text-muted); font-size:0.8rem;">Cap línia ni parada trobada.</div>';
      dropdown.classList.add('active');
      return;
    }

    dropdown.innerHTML = itemsToRender.map(r => {
      if (r.isLine) {
        return `
          <div class="search-result-item line-item" data-type="line" data-line-id="${this.esc(r.lineId)}" style="border-left:3px solid ${this.esc(r.lineColor)};">
            <div class="search-result-left">
              <span class="search-result-badge" style="background:${this.esc(r.lineColor)};">${this.esc(r.lineCode)}</span>
              <div class="search-result-info">
                <div class="search-result-name">${this.esc(r.lineName)}</div>
                <div class="search-result-zone">${this.esc(r.zone || r.agency || 'Línia de transport')}</div>
              </div>
            </div>
            <span class="search-result-action">Canviar ➔</span>
          </div>
        `;
      }
      return `
        <div class="search-result-item stop-item" data-type="stop" data-line-id="${this.esc(r.lineId)}" data-stop-id="${this.esc(r.stopId)}" data-name="${this.esc(r.stopName || '')}" data-lat="${this.esc(r.lat || '')}" data-lon="${this.esc(r.lon || '')}">
          <div class="search-result-left">
            <span class="search-result-badge" style="background:${this.esc(r.lineColor)};">${this.esc(r.lineCode)}</span>
            <div class="search-result-info">
              <div class="search-result-name">${this.esc(r.stopName)}</div>
              <div class="search-result-zone">${this.esc(r.zone)}${r.code ? ` • Codi: ${this.esc(r.code)}` : ''}</div>
            </div>
          </div>
          <span class="search-result-action">Veure ➔</span>
        </div>
      `;
    }).join('');

    dropdown.classList.add('active');

    if (!dropdown._hasItemDelegation) {
      dropdown._hasItemDelegation = true;
      dropdown.addEventListener('click', async (e) => {
        const item = e.target.closest('.search-result-item');
        if (!item) return;
        e.preventDefault();
        const type = item.getAttribute('data-type');
        const lineId = item.getAttribute('data-line-id');
        dropdown.classList.remove('active');
        if (input) {
          input.value = '';
        }
        const searchInput = document.getElementById('global-search-input');
        if (searchInput) searchInput.value = '';
        const heroInput = document.getElementById('landing-hero-search-input');
        if (heroInput) heroInput.value = '';
        const clearBtn = document.getElementById('btn-landing-search-clear');
        if (clearBtn) clearBtn.style.display = 'none';
        const landingDropdown = document.getElementById('landing-search-results-dropdown');
        if (landingDropdown) landingDropdown.classList.remove('active');
        const globalDropdown = document.getElementById('search-results-dropdown');
        if (globalDropdown) globalDropdown.classList.remove('active');
        this.landingSearch = '';
        this.landingSearchResults = null;

        if (type === 'line') {
          this.switchLine(lineId);
          return;
        }

        const stopId = item.getAttribute('data-stop-id');
        const stopName = item.getAttribute('data-name');
        const lat = parseFloat(item.getAttribute('data-lat'));
        const lon = parseFloat(item.getAttribute('data-lon'));

        this.switchLine(lineId);
        if (stopId) {
          this.setTargetStop(stopId);
          if (lat && lon) {
            this.mapController.focusTargetStop(lat, lon);
          }
          this.inspectStop(stopId, stopName);
        }
      });
    }
  }

  // ==========================================
  // 9. EVENT LISTENERS & MAP CONTROLS
  // ==========================================

  setupEventListeners() {
    this.setupPageVisibility();

    // Delegated handler replacing inline onclick attributes (CSP compliance)
    document.addEventListener('click', (e) => {
      const websiteLink = e.target.closest('.line-website-link');
      if (websiteLink) {
        e.stopPropagation();
        return;
      }
      const sortHeader = e.target.closest('[data-sort-table]');
      if (sortHeader) {
        this.handleJournalismSort(sortHeader.dataset.sortTable, sortHeader.dataset.sortKey);
        return;
      }
      const limitButton = e.target.closest('[data-worst-limit]');
      if (limitButton) {
        this.setWorstStopsLimit(Number(limitButton.dataset.worstLimit));
        return;
      }
      const stopModeButton = e.target.closest('[data-toggle-stop-mode]');
      if (stopModeButton) {
        e.preventDefault();
        const mode = stopModeButton.getAttribute('data-toggle-stop-mode');
        if (mode === 'all' || mode === 'bottlenecks') {
          this.journalismStopFilterMode = mode;
          if (this.currentJournalismReport) {
            this.renderJournalismReport(this.currentJournalismReport);
          }
        }
        return;
      }
      const inspectBtn = e.target.closest('[data-inspect-line]');
      if (inspectBtn) {
        e.preventDefault();
        e.stopPropagation();
        this.openDelayIncidentsTab(inspectBtn.dataset.inspectLine);
        return;
      }
      const lineRow = e.target.closest('[data-open-line]');
      if (lineRow) {
        this.closeJournalismModal();
        this.switchLine(lineRow.dataset.openLine);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const sortHeader = e.target.closest?.('[data-sort-table]');
      if (sortHeader) {
        e.preventDefault();
        this.handleJournalismSort(sortHeader.dataset.sortTable, sortHeader.dataset.sortKey);
      }
    });

    // Timeline Horizontal Interaction (Mouse Wheel, Drag-to-Scroll, Arrow Navigation)
    const timelineContainer = document.getElementById('corridor-timeline-container');
    if (timelineContainer) {
      // 1. Mouse wheel horizontal scrolling (translates deltaY to scrollLeft)
      timelineContainer.addEventListener('wheel', (e) => {
        const track = e.target.closest('.corridor-timeline-track');
        if (!track) return;
        if (e.deltaY !== 0 && Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
          e.preventDefault();
          track.scrollLeft += e.deltaY * 1.2;
        }
      }, { passive: false });

      // 2. Mouse Drag-to-Scroll (Fluid pan)
      let isDragging = false;
      let startX = 0;
      let startScroll = 0;
      let activeTrack = null;

      timelineContainer.addEventListener('mousedown', (e) => {
        const track = e.target.closest('.corridor-timeline-track');
        if (!track || e.target.closest('button')) return;
        isDragging = true;
        activeTrack = track;
        startX = e.pageX;
        startScroll = track.scrollLeft;
        this._timelineDragged = false;
        track.classList.add('is-dragging');
      });

      window.addEventListener('mousemove', (e) => {
        if (!isDragging || !activeTrack) return;
        const dx = e.pageX - startX;
        if (Math.abs(dx) > 4) {
          this._timelineDragged = true;
          e.preventDefault();
        }
        activeTrack.scrollLeft = startScroll - dx;
      });

      window.addEventListener('mouseup', () => {
        if (isDragging && activeTrack) {
          activeTrack.classList.remove('is-dragging');
        }
        isDragging = false;
        activeTrack = null;
        setTimeout(() => { this._timelineDragged = false; }, 60);
      });

      // 3. Update arrow button states on scroll
      timelineContainer.addEventListener('scroll', (e) => {
        const track = e.target.closest('.corridor-timeline-track');
        if (track) this.updateTimelineScrollButtons(track);
      }, { capture: true, passive: true });
    }

    // Dynamic Direction buttons delegation
    const dirGroup = document.getElementById('direction-toggle-group');
    if (dirGroup) {
      dirGroup.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-direction');
        if (!btn) return;
        e.preventDefault();
        const dirId = btn.getAttribute('data-dir-id') || btn.getAttribute('data-direction');
        if (dirId && dirId !== this.activeDirection) {
          this.switchDirection(dirId);
        }
      });
    }

    // Global Event Delegation Dispatcher (AGENTS.md §8 compliant)
    document.addEventListener('click', (e) => {
      // 0. Timeline scroll navigation buttons (< and >)
      const timelineScrollBtn = e.target.closest('.btn-timeline-scroll');
      if (timelineScrollBtn) {
        e.preventDefault();
        const wrapper = timelineScrollBtn.closest('.corridor-timeline-wrapper');
        const track = wrapper?.querySelector('.corridor-timeline-track');
        if (track) {
          const isLeft = timelineScrollBtn.classList.contains('btn-timeline-scroll-left');
          track.scrollBy({ left: isLeft ? -260 : 260, behavior: 'smooth' });
        }
        return;
      }

      // 1. Corridor Steps Timeline delegation
      const step = e.target.closest('.corridor-step');
      if (step) {
        if (this._timelineDragged) {
          return;
        }
        e.preventDefault();
        const targetId = step.getAttribute('data-target-id');
        if (targetId) {
          this.setTargetStop(targetId);
        }
        return;
      }

      // 2. Direction selection action buttons delegation (from Stops Browser, Header Pills, Toolbar & Timeline)
      const dirBtn = e.target.closest('.btn-select-dir-view, .btn-timeline-select-dir, .btn-stops-card-pill, .btn-stops-dir-tab');
      if (dirBtn) {
        e.preventDefault();
        const dirId = dirBtn.getAttribute('data-dir-id');
        if (dirId && dirId !== this.activeDirection) {
          this.switchDirection(dirId);
        }
        return;
      }

      // 3. Direction Jump Navigator Buttons delegation (smooth scroll inside stops browser)
      const jumpBtn = e.target.closest('.btn-dir-jump');
      if (jumpBtn) {
        e.preventDefault();
        const targetId = jumpBtn.getAttribute('data-dir-target');
        if (targetId) {
          const targetEl = document.getElementById(targetId);
          if (targetEl) {
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
        return;
      }

      // 4. Click departure item to focus bus on map delegation
      const depItem = e.target.closest('.departure-item.clickable-bus-dep');
      if (depItem) {
        e.preventDefault();
        const vId = depItem.getAttribute('data-vehicle-id');
        const lat = parseFloat(depItem.getAttribute('data-bus-lat'));
        const lon = parseFloat(depItem.getAttribute('data-bus-lon'));
        const stopSeq = parseInt(depItem.getAttribute('data-stop-seq'), 10) || null;
        const stopId = depItem.getAttribute('data-stop-id') || null;
        const depIdx = parseInt(depItem.getAttribute('data-dep-index'), 10) || 0;
        const coords = (lat && lon && !isNaN(lat) && !isNaN(lon)) ? { lat, lon } : null;

        this.focusBusOnMap(vId, coords, stopSeq, stopId, depIdx);
        return;
      }
    });

    // Keyboard activation for clickable departure cards
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        if (e.target.closest?.('input, textarea, select, button, a')) return;
        const depItem = e.target.closest?.('.departure-item.clickable-bus-dep');
        if (depItem) {
          e.preventDefault();
          depItem.click();
        }
      }
    });

    // Stops Browser List delegation
    const stopsList = document.getElementById('stops-list-scroll');
    if (stopsList) {
      stopsList.addEventListener('click', (e) => {
        // If clicking a direction action button or jump button, skip
        if (e.target.closest('.btn-select-dir-view') || e.target.closest('.btn-dir-jump')) return;
        
        const row = e.target.closest('.stop-row-item');
        if (!row) return;
        e.preventDefault();
        const stopId = row.getAttribute('data-stop-id');
        const stopName = row.getAttribute('data-stop-name');
        if (stopId) {
          this.inspectStop(stopId, stopName);
        }
      });
    }

    // Stops View Mode Switcher (List vs Schematic Thermometer)
    const modePills = document.getElementById('stops-view-mode-pills');
    if (modePills) {
      modePills.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-stops-view-mode');
        if (!btn) return;
        e.preventDefault();
        const mode = btn.getAttribute('data-mode') || 'schematic';
        this.setStopsViewMode(mode);
      });
    }


    // Schematic Thermometer container delegation (AGENTS.md §8 compliant)
    const schematicContainer = document.getElementById('stops-schematic-scroll');
    if (schematicContainer) {
      schematicContainer.addEventListener('click', (e) => {
        // Share bus button clicked
        const shareBtn = e.target.closest('[data-share-bus]');
        if (shareBtn) {
          e.preventDefault();
          e.stopPropagation();
          const busId = shareBtn.getAttribute('data-share-bus');
          this.shareLiveBus(busId);
          return;
        }

        // Bus chip clicked -> focus bus on map
        const busChip = e.target.closest('.schematic-bus-chip');
        if (busChip) {
          e.preventDefault();
          const vId = busChip.getAttribute('data-vehicle-id');
          const lat = parseFloat(busChip.getAttribute('data-lat'));
          const lon = parseFloat(busChip.getAttribute('data-lon'));
          if (lat && lon && !isNaN(lat) && !isNaN(lon)) {
            this.focusBusOnMap(vId, { lat, lon });
          }
          return;
        }

        // Station node clicked -> inspect stop departures
        const node = e.target.closest('.schematic-station-item');
        if (node) {
          e.preventDefault();
          const stopId = node.getAttribute('data-stop-id');
          const stopName = node.getAttribute('data-stop-name');
          if (stopId) {
            this.inspectStop(stopId, stopName);
          }
        }
      });
    }

    // Target Stop Dropdown
    document.getElementById('target-stop-select')?.addEventListener('change', (e) => {
      if (e.target.value) this.setTargetStop(e.target.value);
    });

    // Target Stop Quick Action Buttons
    document.getElementById('btn-target-focus-map')?.addEventListener('click', (e) => {
      e.preventDefault();
      const stopObj = this.getCurrentTargetStop();

      // 1. Smoothly scroll directly down to the interactive map
      const mapCard = document.getElementById('map-card');
      if (mapCard) {
        mapCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }

      // 2. Focus and highlight stop on Leaflet map
      if (stopObj && stopObj.lat && stopObj.lon) {
        this.mapController?.focusTargetStop(stopObj.lat, stopObj.lon, stopObj.id || stopObj.code);
      } else if (this.mapController) {
        this.mapController.invalidateSize();
      }
    });

    document.getElementById('btn-target-toggle-fav')?.addEventListener('click', (e) => {
      e.preventDefault();
      const stopObj = this.getCurrentTargetStop();
      const sId = stopObj?.id || stopObj?.code;
      const sName = stopObj?.name || document.getElementById('target-stop-title')?.textContent || `Parada ${sId}`;
      if (sId) {
        this.toggleFavoriteStop(sId, sName, [this.activeLineId || 'L1']);
        this.updateTargetFavButton(sId);
      }
    });

    // Refresh Button
    document.getElementById('btn-refresh')?.addEventListener('click', (e) => { 
      e.preventDefault(); 
      this.refreshAllData(false); 
    });

    // Sound Alarm Button
    document.getElementById('btn-sound')?.addEventListener('click', (e) => { 
      e.preventDefault(); 
      this.toggleSound(); 
    });

    // Light / Dark Theme Toggle Button
    document.getElementById('btn-theme-toggle')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.toggleTheme();
    });

    // Modal Close Button & Backdrop
    document.getElementById('modal-close-btn')?.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('stop-modal-backdrop')?.classList.remove('active');
    });

    document.getElementById('stop-modal-backdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'stop-modal-backdrop') {
        e.target.classList.remove('active');
      }
    });

    // Filter Stops Browser Input (supporting both Thermometer and List modes)
    const searchInput = document.getElementById('stop-search-input');
    const clearSearchBtn = document.getElementById('btn-clear-stop-search');

    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const q = (e.target.value || '').toLowerCase().trim();
        if (this.stopsViewMode === 'schematic') {
          this.filterSchematicStops(q);
        } else {
          this.filterListStops(q);
        }
      });

      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          searchInput.value = '';
          if (this.stopsViewMode === 'schematic') {
            this.filterSchematicStops('');
          } else {
            this.filterListStops('');
          }
        }
      });
    }

    if (clearSearchBtn) {
      clearSearchBtn.addEventListener('click', () => {
        if (searchInput) {
          searchInput.value = '';
          searchInput.focus();
          if (this.stopsViewMode === 'schematic') {
            this.filterSchematicStops('');
          } else {
            this.filterListStops('');
          }
        }
      });
    }

    // Back to Landing / Home Navigation via Logo and Buttons
    const logoGroup = document.getElementById('header-logo-group');
    if (logoGroup) {
      logoGroup.addEventListener('click', (e) => {
        e.preventDefault();
        this.navigateToLanding();
      });
      logoGroup.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.navigateToLanding();
        }
      });
    }

    document.getElementById('btn-back-to-landing')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.navigateToLanding();
    });

    // Footer Quick Links
    document.getElementById('footer-link-home')?.addEventListener('click', (e) => { 
      e.preventDefault(); 
      this.navigateToLanding(); 
    });
    document.getElementById('footer-link-lines')?.addEventListener('click', (e) => { 
      e.preventDefault(); 
      this.navigateToLanding(); 
    });
    document.getElementById('footer-link-incidents')?.addEventListener('click', (e) => { 
      e.preventDefault(); 
      this.openDisruptionsModal(''); 
    });
    document.getElementById('footer-link-journalism')?.addEventListener('click', (e) => { 
      e.preventDefault(); 
      this.openJournalismModal(24); 
    });

    // Window Hashchange & Popstate (Browser Back/Forward Navigation)
    const handleRouteNav = () => {
      this.parseUrlHash();
      if (this.activeLineId) {
        this.showActiveLineView();
        this.refreshAllData(true);
      } else {
        this.showLandingView();
        this.renderLandingLines();
      }
    };

    window.addEventListener('hashchange', handleRouteNav);

    this.setupGlobalSearch();
    this.setupLinePicker();
    this.setupMapResizeControls();
    this.setupDisruptionsModal();
    this.setupJournalismModal();
    this.setupPlannerEvents();
    this.setupTrafficEvents();
    this.setupProximityAlarmEvents();
    this.setupTermometreEvents();
    this.setupDelayIncidentsEvents();
  }

  // ==========================================
  // DISRUPTIONS & SERVICE ALERTS MODAL
  // ==========================================

  setupDisruptionsModal() {
    const openBtn = document.getElementById('btn-open-incidents');
    const bannerBtn = document.getElementById('btn-view-disruption-details');
    const backdrop = document.getElementById('disruptions-modal-backdrop');
    const closeBtn = document.getElementById('disruptions-modal-close-btn');

    openBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      this.openDisruptionsModal('');
    });

    bannerBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      const code = this.activeLineData?.code || this.activeLineData?.id || '';
      this.openDisruptionsModal(code);
    });

    closeBtn?.addEventListener('click', () => {
      backdrop?.classList.remove('active');
    });

    backdrop?.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        backdrop.classList.remove('active');
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && backdrop?.classList.contains('active')) {
        backdrop.classList.remove('active');
      }
    });
  }

  // ==========================================
  // JOURNALISM & HISTORICAL DELAY MODAL
  // ==========================================

  setupJournalismModal() {
    const openBtn = document.getElementById('btn-open-journalism');
    openBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      window.location.href = '/dades';
    });
  }

  // ==========================================
  // MAP RESIZE CONTROLS
  // ==========================================

  setupMapResizeControls() {
    const expandWidthBtn = document.getElementById('btn-map-expand-width');
    const expandLabel = document.getElementById('map-expand-label') || expandWidthBtn?.querySelector('span');
    const mapContainer = document.getElementById('map-container');
    const explorerGrid = document.querySelector('.explorer-grid');
    const resizeBar = document.getElementById('map-resize-bar');

    const animateResize = (durationMs = 400) => {
      const startTime = performance.now();
      const tick = (now) => {
        this.mapController?.invalidateSize();
        if (now - startTime < durationMs) {
          requestAnimationFrame(tick);
        } else {
          this.mapController?.invalidateSize();
        }
      };
      requestAnimationFrame(tick);
    };

    let isExpanded = false;
    expandWidthBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      isExpanded = !isExpanded;

      const performToggle = () => {
        explorerGrid?.classList.toggle('expanded-width', isExpanded);
        expandWidthBtn.classList.toggle('active', isExpanded);
        if (expandLabel) {
          expandLabel.textContent = isExpanded ? 'Normal' : 'Ample';
        }
        expandWidthBtn.title = isExpanded ? 'Reduir mapa a la vista estàndard' : 'Ampliar mapa a tota l\'amplada';
        if (mapContainer) {
          mapContainer.style.height = isExpanded ? '560px' : '';
        }
      };

      if (typeof document.startViewTransition === 'function' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const transition = document.startViewTransition(() => {
          performToggle();
        });
        animateResize(480);
        transition.finished.finally(() => {
          this.mapController?.invalidateSize();
        });
      } else {
        performToggle();
        animateResize(480);
      }
    });

    mapContainer?.addEventListener('transitionend', () => {
      this.mapController?.invalidateSize();
    });

    explorerGrid?.addEventListener('transitionend', () => {
      this.mapController?.invalidateSize();
    });

    if (resizeBar && mapContainer) {
      let isDragging = false;
      let startY = 0;
      let startHeight = 0;

      const onStart = (e) => {
        isDragging = true;
        startY = (e.touches && e.touches.length > 0) ? e.touches[0].clientY : e.clientY;
        startHeight = mapContainer.offsetHeight;
        resizeBar.classList.add('dragging');
        document.body.style.cursor = 'ns-resize';
      };

      const onMove = (e) => {
        if (!isDragging) return;
        const clientY = (e.touches && e.touches.length > 0) ? e.touches[0].clientY : e.clientY;
        if (typeof clientY !== 'number') return;
        
        const delta = clientY - startY;
        const newHeight = Math.max(260, Math.min(800, startHeight + delta));
        mapContainer.style.height = `${newHeight}px`;
        this.mapController?.invalidateSize();
      };

      const onEnd = () => {
        if (isDragging) {
          isDragging = false;
          resizeBar.classList.remove('dragging');
          document.body.style.cursor = '';
          this.mapController?.invalidateSize();
        }
      };

      resizeBar.addEventListener('mousedown', onStart);
      resizeBar.addEventListener('touchstart', onStart, { passive: true });

      window.addEventListener('mousemove', onMove);
      window.addEventListener('touchmove', onMove, { passive: true });

      window.addEventListener('mouseup', onEnd);
      window.addEventListener('touchend', onEnd);
      window.addEventListener('touchcancel', onEnd);
    }
  }

  // ==========================================
  // 10. ANIMATION, AUDIO & UTILITIES (LOW-RAM OPTIMIZED)
  // ==========================================

  setupPageVisibility() {
    this.isTabVisible = typeof document !== 'undefined' ? !document.hidden : true;
    document.addEventListener('visibilitychange', () => {
      const wasVisible = this.isTabVisible;
      this.isTabVisible = !document.hidden;

      if (this.isTabVisible && !wasVisible) {
        // User returned to tab: resume animation loop and perform fresh fetch immediately
        this.startAnimationLoop();
        this.setupFleetStream();
        if (this.activeLineId) {
          this.refreshAllData(false);
        }
      } else if (!this.isTabVisible) {
        // User switched to another of their 15 tabs: cancel RAF loop immediately to free up GPU & CPU RAM
        if (this.animFrameId) {
          cancelAnimationFrame(this.animFrameId);
          this.animFrameId = null;
        }
        // Suspend the SSE stream while hidden: the browser reopens it on
        // return with a full fresh snapshot.
        this.closeFleetStream();
      }
    });
  }

  startAnimationLoop() {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }

    const step = () => {
      // Deep Sleep: Stop 60fps loop if tab is hidden or user is on the Landing Page (no map buses active)
      if (!this.isTabVisible || !this.activeLineId) {
        this.animFrameId = null;
        return;
      }
      const nowSec = Date.now() / 1000;
      if (this.mapController) {
        this.mapController.stepBusAnimation(nowSec);
      }
      this.animFrameId = requestAnimationFrame(step);
    };

    if (this.isTabVisible && this.activeLineId) {
      this.animFrameId = requestAnimationFrame(step);
    }
  }

  // ==========================================
  // 9b. LIVE FLEET STREAM (SSE) WITH POLLING FALLBACK
  // ==========================================

  setupFleetStream() {
    if (typeof EventSource === 'undefined') return; // older browsers: keep polling
    if (this.fleetSource) return;

    try {
      this.fleetSource = new EventSource('/api/fleet/events');
    } catch (_) {
      this.fleetSource = null;
      return;
    }

    this.fleetSource.addEventListener('fleet', (ev) => {
      let snapshot;
      try {
        snapshot = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      if (!snapshot || !Array.isArray(snapshot.vehicles)) return;
      this.fleetStreamOk = true;
      this.stopFleetPolling();
      this.applyFleetSnapshot(snapshot);
    });

    this.fleetSource.addEventListener('waiting', () => {
      // Stream is up but the worker has not produced a fleet snapshot yet.
      this.fleetStreamOk = true;
    });

    this.fleetSource.onerror = () => {
      // EventSource auto-reconnects; degrade to polling while disconnected.
      this.fleetStreamOk = false;
      this.startFleetPolling();
    };
  }

  closeFleetStream() {
    if (this.fleetSource) {
      try { this.fleetSource.close(); } catch (_) {}
      this.fleetSource = null;
    }
    this.fleetStreamOk = false;
  }

  applyFleetSnapshot(snapshot) {
    const lId = this.activeLineId;
    if (!lId || !this.isTabVisible) return;

    const dir = this.activeDirection;
    const buses = snapshot.vehicles.filter(v =>
      String(v.lineId) === String(lId) &&
      (dir === 'both' || v.direction === undefined || String(v.direction) === String(dir))
    );

    const lineData = this.activeLineData;
    if (lineData && Array.isArray(lineData.activeBuses)) {
      lineData.activeBuses = buses;
    }
    this.activeBuses = buses;

    const lineColor = lineData?.color || '#009485';
    this.mapController?.updateBusMarkers(buses, lineColor, '#38bdf8', this.selectedVehicleId, null, lId);
    this.updateActiveBusesCount(buses.length, lineData);
  }

  startFleetPolling() {
    if (this.fleetPollTimer || !this.activeLineId) return;
    this.fleetPollTimer = setInterval(() => {
      if (!this.isTabVisible) return;
      this.refreshAllData(false);
    }, this.pollInterval * 1000);
  }

  stopFleetPolling() {
    if (this.fleetPollTimer) {
      clearInterval(this.fleetPollTimer);
      this.fleetPollTimer = null;
    }
  }

  startAutoRefresh() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      // Inactive Tab Sleep: Pause polling while tab is hidden to prevent continuous JSON parsing & memory churning
      if (!this.isTabVisible) {
        return;
      }
      // While the SSE fleet stream is delivering snapshots, stretch the REST
      // refresh to a slow static-data cadence; the stream keeps vehicles live.
      const effectiveInterval = this.fleetStreamOk ? 60 : this.pollInterval;
      this.secondsRemaining--;
      if (this.secondsRemaining <= 0) {
        this.secondsRemaining = effectiveInterval;
        this.updateCountdownLabel();
        this.refreshAllData(false);
      } else {
        this.updateCountdownLabel();
      }
    }, 1000);
  }

  updateCountdownLabel() {
    const label = document.getElementById('countdown-label');
    if (label) {
      label.textContent = `Actualització en ${this.secondsRemaining}s`;
    }
  }

  updateActiveBusesCount(count, lData = null) {
    const headerEl = document.getElementById('header-active-buses-text');
    const mapEl = document.getElementById('map-bus-counter-tag');

    // Count physical live GPS vs estimated/theoretical buses directly from the active bus list
    const buses = (lData && Array.isArray(lData.activeBuses)) ? lData.activeBuses : (this.activeBuses || []);
    let liveFromBuses = 0;
    let estFromBuses = 0;
    for (const b of buses) {
      if (b.isGhostVehicle || b.isEstimated || (b.vehicleId && String(b.vehicleId).startsWith('EST_'))) {
        estFromBuses++;
      } else {
        liveFromBuses++;
      }
    }

    const live = liveFromBuses;
    const est = estFromBuses;
    const total = live + est;

    if (total > 0) {
      if (live > 0 && est > 0) {
        if (headerEl) headerEl.innerHTML = `🟢 <strong>${live}</strong> GPS + ⚡ <strong>${est}</strong> est. (de ${total})`;
        if (mapEl) mapEl.innerHTML = `🟢 ${live} amb GPS + ⚡ ${est} estimat${est === 1 ? '' : 's'} (${total} en servei)`;
        return;
      } else if (live > 0 && est === 0) {
        if (headerEl) headerEl.innerHTML = `🟢 <strong>${live}</strong> en directe (100% flota amb GPS)`;
        if (mapEl) mapEl.innerHTML = `🟢 ${live} bus${live === 1 ? '' : 'os'} en directe (100% GPS)`;
        return;
      } else if (live === 0 && est > 0) {
        if (headerEl) headerEl.innerHTML = `⚡ <strong>${est}</strong> estimat${est === 1 ? '' : 's'} (sense GPS)`;
        if (mapEl) mapEl.innerHTML = `⚡ ${est} bus${est === 1 ? '' : 'os'} estimats segons horari (sense GPS)`;
        return;
      }
    }

    if (headerEl) {
      headerEl.innerHTML = `🌙 <strong>0</strong> busos en servei ara`;
    }
    if (mapEl) {
      mapEl.innerHTML = `🌙 Sense busos en servei ara mateix`;
    }
  }

  setupAudio() {
    this.updateSoundIcons();
  }

  toggleSound() {
    this.soundEnabled = !this.soundEnabled;
    localStorage.setItem('c10_sound', this.soundEnabled);
    this.updateSoundIcons();
    if (this.soundEnabled) this.playChime();
  }

  updateSoundIcons() {
    const on = document.getElementById('sound-icon-on');
    const off = document.getElementById('sound-icon-off');
    if (on && off) {
      on.style.display = this.soundEnabled ? 'block' : 'none';
      off.style.display = this.soundEnabled ? 'none' : 'block';
    }
  }

  playChime() {
    try {
      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = this.audioContext;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.3);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    } catch (e) {
      console.warn('Audio play error:', e);
    }
  }

  checkArrivalAlerts(lineData, activeTargetId) {
    if (!this.soundEnabled) return;
    const buses = lineData.activeBuses || [];
    const approaching = buses.some(b => String(b.toStopId || b.nextStopId) === String(activeTargetId) && b.secondsToNextStop && b.secondsToNextStop <= 180);

    if (approaching && this.lastAlertedTrip !== activeTargetId) {
      this.lastAlertedTrip = activeTargetId;
      this.playChime();
    }
  }

  // ==========================================
  // JOURNEY PLANNER ("COM ANAR-HI")
  // ==========================================

  setupPlannerEvents() {
    const modal = document.getElementById('planner-modal-backdrop');
    const openBtns = [document.getElementById('btn-header-planner'), document.getElementById('btn-hero-planner')];
    const closeBtn = document.getElementById('planner-modal-close-btn');
    const swapBtn = document.getElementById('btn-planner-swap');
    const submitBtn = document.getElementById('btn-planner-submit');
    const originInput = document.getElementById('planner-origin-input');
    const destInput = document.getElementById('planner-dest-input');
    const originGeoBtn = document.getElementById('btn-planner-origin-geo');
    const resultsContainer = document.getElementById('planner-results-container');

    openBtns.forEach(b => {
      if (b && b.tagName !== 'A') {
        b.addEventListener('click', (e) => {
          e.preventDefault();
          if (modal) modal.classList.add('active');
        });
      }
    });

    closeBtn?.addEventListener('click', () => {
      if (modal) modal.classList.remove('active');
    });

    const backToPlannerBtn = document.getElementById('btn-itinerary-back-to-planner');
    const closeItineraryBtn = document.getElementById('btn-itinerary-close');
    const floatingBar = document.getElementById('itinerary-floating-bar');

    backToPlannerBtn?.addEventListener('click', () => {
      if (modal) modal.classList.add('active');
    });

    closeItineraryBtn?.addEventListener('click', () => {
      if (floatingBar) floatingBar.classList.remove('active');
      const busCounter = document.getElementById('map-bus-counter-tag');
      if (busCounter) busCounter.style.display = '';
      const mapTitle = document.getElementById('map-line-title');
      if (mapTitle && this._savedMapTitle) mapTitle.textContent = this._savedMapTitle;
      if (this.mapController && typeof this.mapController.clearItinerary === 'function') {
        this.mapController.clearItinerary();
      }
      this.refreshAllData(false);
    });

    modal?.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.remove('active');
    });

    swapBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      if (originInput && destInput) {
        const tmp = originInput.value;
        originInput.value = destInput.value;
        destInput.value = tmp;
        const tmpCoords = this._plannerOriginCoords;
        this._plannerOriginCoords = this._plannerDestCoords;
        this._plannerDestCoords = tmpCoords;
      }
    });

    originGeoBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      if (!navigator.geolocation) {
        alert("La geolocalització no està disponible al teu navegador.");
        return;
      }
      originGeoBtn.textContent = '⌛ ...';
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          this._plannerOriginCoords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
          if (originInput) originInput.value = '📍 La meva ubicació actual';
          originGeoBtn.textContent = '📍 GPS';
        },
        () => {
          originGeoBtn.textContent = '📍 GPS';
          alert("No s'ha pogut obtenir la teva ubicació GPS.");
        },
        { timeout: 8000 }
      );
    });

    submitBtn?.addEventListener('click', async (e) => {
      e.preventDefault();
      const origin = originInput?.value?.trim();
      const dest = destInput?.value?.trim();
      if (!origin || !dest) {
        alert("Si us plau, indica tant l'origen com la destinació.");
        return;
      }

      if (resultsContainer) {
        resultsContainer.innerHTML = '<div style="text-align:center; padding:2rem;"><span class="loading-spinner-inline"></span> Calculant la millor combinació de trajecte...</div>';
      }

      const fromQuery = originInput?.dataset?.stopId || origin.replace(/\s*\([^)]*\)$/, '').trim();
      const toQuery = destInput?.dataset?.stopId || dest.replace(/\s*\([^)]*\)$/, '').trim();
      let url = `/api/mataro/plan?from=${encodeURIComponent(fromQuery)}&to=${encodeURIComponent(toQuery)}&fromName=${encodeURIComponent(origin)}&toName=${encodeURIComponent(dest)}`;
      if (originInput?.dataset?.lat && originInput?.dataset?.lon) {
        url += `&fromLat=${originInput.dataset.lat}&fromLon=${originInput.dataset.lon}`;
      } else if (this._plannerOriginCoords && origin.includes('ubicació')) {
        url += `&fromLat=${this._plannerOriginCoords.lat}&fromLon=${this._plannerOriginCoords.lon}`;
      }
      if (destInput?.dataset?.lat && destInput?.dataset?.lon) {
        url += `&toLat=${destInput.dataset.lat}&toLon=${destInput.dataset.lon}`;
      } else if (this._plannerDestCoords && dest.includes('ubicació')) {
        url += `&toLat=${this._plannerDestCoords.lat}&toLon=${this._plannerDestCoords.lon}`;
      }

      try {
        const fetchRes = await fetch(url);
        if (!fetchRes.ok) {
          let serverMsg = `El servidor d'Arribo! ha retornat error HTTP ${fetchRes.status}.`;
          try {
            const errBody = await fetchRes.json();
            if (errBody.error) serverMsg = errBody.error;
          } catch (_) {}
          throw new Error(serverMsg);
        }

        const res = await fetchRes.json();
        if (!res.success || !res.itineraries || res.itineraries.length === 0) {
          if (resultsContainer) {
            resultsContainer.innerHTML = `
              <div style="text-align:center; padding:2rem; color:var(--text-secondary);">
                <div style="font-size:1.8rem; margin-bottom:0.4rem;">🔍</div>
                <div style="font-weight:700; color:var(--text-primary); margin-bottom:0.25rem;">Cap ruta trobada</div>
                <div style="font-size:0.85rem; max-width:340px; margin:0 auto;">${this.esc(res.message || res.error || 'No s\'ha trobat cap combinació directa o amb 1 sol transbordament.')}</div>
                <div style="font-size:0.75rem; color:var(--text-muted); margin-top:0.4rem;">Consell: prova de triar la parada o carrer directament del menú desplegable.</div>
              </div>
            `;
          }
          return;
        }

        this.renderPlannerResults(res.itineraries, res.originStop, res.destStop);
      } catch (err) {
        let errTitle = "No s'ha pogut connectar amb el servei";
        let errDetail = "No s'ha pogut obtenir la planificació del servidor d'Arribo!.";

        if (!navigator.onLine) {
          errTitle = "Sense connexió a Internet";
          errDetail = "El teu dispositiu no té connexió. Revisa el Wi-Fi o les dades mòbils.";
        } else if (err.name === 'TypeError' && String(err.message).toLowerCase().includes('fetch')) {
          errTitle = "Servidor d'Arribo! no disponible";
          errDetail = "El navegador no ha pogut contactar amb el servidor local/API d'Arribo!. Comprova que el servei estigui actiu.";
        } else if (err.message) {
          errDetail = err.message;
        }

        if (resultsContainer) {
          resultsContainer.innerHTML = `
            <div style="padding:1.5rem; text-align:center; color:var(--text-secondary); background:rgba(239, 68, 68, 0.06); border:1px solid rgba(239, 68, 68, 0.2); border-radius:10px; margin:1rem 0;">
              <div style="font-size:1.8rem; margin-bottom:0.4rem;">⚠️</div>
              <div style="font-weight:700; color:#ef4444; margin-bottom:0.25rem;">${this.esc(errTitle)}</div>
              <div style="font-size:0.85rem; line-height:1.4; max-width:340px; margin:0 auto;">${this.esc(errDetail)}</div>
            </div>
          `;
        }
      }
    });

    this.setupPlannerAutocomplete(originInput, 'planner-origin-dropdown', () => {
      this._plannerOriginCoords = null;
    });
    this.setupPlannerAutocomplete(destInput, 'planner-dest-dropdown', () => {
      this._plannerDestCoords = null;
    });
  }

  setupPlannerAutocomplete(inputEl, dropdownId, onSelect) {
    if (!inputEl) return;
    const dropdown = document.getElementById(dropdownId);
    if (!dropdown) return;
    let debounceTimer = null;

    const closeDropdown = () => {
      dropdown.style.display = 'none';
    };

    inputEl.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      delete inputEl.dataset.stopId;
      delete inputEl.dataset.direction;
      delete inputEl.dataset.lat;
      delete inputEl.dataset.lon;
      const q = inputEl.value.trim().toLowerCase();
      if (!q || q.length < 2) {
        closeDropdown();
        dropdown.innerHTML = '';
        return;
      }

      debounceTimer = setTimeout(async () => {
        const seen = new Set();
        const matches = [];

        const pois = [
          { name: 'Estació Rodalies Mataró (Renfe)', id: '1016', directionText: 'Intercanviador Tren / Bus' },
          { name: 'Plaça de les Tereses (Centre)', id: '1060', directionText: 'Centre Urbà' },
          { name: 'Hospital de Mataró', id: '1001', directionText: 'Zona Hospitalària' },
          { name: 'Mataró Parc (Centre Comercial)', id: '1002', directionText: 'Centre Comercial' },
          { name: 'TecnoCampus Mataró', id: '1080', directionText: 'Campus Universitari' },
          { name: 'Parc Central', id: '1015', directionText: 'Parc Central' }
        ];

        for (const poi of pois) {
          if (poi.name.toLowerCase().includes(q)) {
            matches.push({ name: poi.name, id: poi.id, isPoi: true, directionText: poi.directionText });
            seen.add(poi.id);
          }
        }

        try {
          const res = await fetch(`/api/search/stops?q=${encodeURIComponent(q)}`).then(r => r.json());
          const stops = Array.isArray(res.stops) 
            ? res.stops 
            : (Array.isArray(res.results) 
                ? res.results.filter(r => r.type === 'stop').map(r => ({ id: r.stopId || r.code, name: r.stopName, code: r.code || r.stopId, directionText: r.directionText, lat: r.lat, lon: r.lon })) 
                : []);

          for (const s of stops) {
            const sId = String(s.id || s.code || '');
            const sName = String(s.name || s.stopName || '');
            if (!seen.has(sId)) {
              seen.add(sId);
              matches.push({ name: sName, id: sId, directionText: s.directionText || '', lat: s.lat, lon: s.lon, type: 'stop' });
              if (matches.length >= 6) break;
            }
          }

          if (Array.isArray(res.streets)) {
            for (const st of res.streets.slice(0, 4)) {
              matches.push({
                name: st.name,
                id: st.id,
                isStreet: true,
                lat: st.lat,
                lon: st.lon,
                nearestId: st.nearestStop?.id,
                subtitle: st.subtitle,
                cityName: st.cityName,
                type: 'street'
              });
            }
          }
        } catch (_) {}

        if (matches.length === 0) {
          closeDropdown();
          return;
        }

        dropdown.innerHTML = matches.map(m => {
          if (m.isStreet) {
            return `
              <div class="planner-dropdown-item" data-id="${this.esc(m.id)}" data-name="${this.esc(m.name)}" data-type="street" data-lat="${m.lat}" data-lon="${m.lon}" data-nearest-id="${this.esc(m.nearestId || '')}">
                <div style="display:flex; flex-direction:column; gap:2px;">
                  <span style="display:flex; align-items:center; gap:6px;"><span style="color:#f59e0b;">🛣️</span> <strong>${this.esc(m.name)}</strong></span>
                  <span style="font-size:0.75rem; color:var(--text-muted); padding-left:1.35rem;">${this.esc(m.subtitle || `Carrer a ${m.cityName || 'Mataró'}`)}</span>
                </div>
                <span style="font-size:0.72rem; color:#f59e0b; background:rgba(245,158,11,0.12); padding:2px 6px; border-radius:4px; font-weight:600;">Carrer</span>
              </div>
            `;
          }
          return `
            <div class="planner-dropdown-item" data-id="${this.esc(m.id)}" data-name="${this.esc(m.name)}" data-direction="${this.esc(m.directionText || '')}" data-lat="${m.lat || ''}" data-lon="${m.lon || ''}">
              <div style="display:flex; flex-direction:column; gap:2px;">
                <span style="display:flex; align-items:center; gap:6px;"><span>${m.isPoi ? '📍' : '🚏'}</span> <strong>${this.esc(m.name)}</strong></span>
                ${m.directionText ? `
                  <span style="font-size:0.75rem; color:#38bdf8; font-weight:600; padding-left:1.35rem;">➔ ${this.esc(m.directionText)}</span>
                ` : ''}
              </div>
              <span style="font-size:0.75rem; color:var(--text-muted); font-family:var(--font-mono);">#${this.esc(m.id)}</span>
            </div>
          `;
        }).join('');
        dropdown.style.display = 'block';
      }, 120);
    });

    dropdown.addEventListener('click', (e) => {
      const item = e.target.closest('.planner-dropdown-item');
      if (!item) return;
      const isStreet = item.getAttribute('data-type') === 'street';
      const id = item.getAttribute('data-id');
      const name = item.getAttribute('data-name');
      const direction = item.getAttribute('data-direction');
      const lat = item.getAttribute('data-lat');
      const lon = item.getAttribute('data-lon');
      const nearestId = item.getAttribute('data-nearest-id');

      if (isStreet) {
        inputEl.value = name;
        inputEl.dataset.stopId = nearestId || '';
        inputEl.dataset.lat = lat || '';
        inputEl.dataset.lon = lon || '';
        delete inputEl.dataset.direction;
      } else {
        inputEl.value = direction ? `${name} (${direction})` : name;
        inputEl.dataset.stopId = id;
        inputEl.dataset.direction = direction || '';
        if (lat && lon) {
          inputEl.dataset.lat = lat;
          inputEl.dataset.lon = lon;
        } else {
          delete inputEl.dataset.lat;
          delete inputEl.dataset.lon;
        }
      }
      closeDropdown();
      if (onSelect) onSelect({ id, name, direction, isStreet, lat, lon });
    });

    // Global listeners registered once for all planner autocomplete instances
    if (!this._plannerAutocompleteGlobalBound) {
      this._plannerAutocompleteGlobalBound = true;
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.planner-input-wrapper, .planner-input-group, .planner-dropdown')) {
          document.querySelectorAll('.planner-dropdown').forEach(dd => {
            dd.classList.remove('active');
          });
        }
      });

      window.addEventListener('blur', () => {
        document.querySelectorAll('.planner-dropdown').forEach(dd => {
          dd.classList.remove('active');
        });
      });

      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          document.querySelectorAll('.planner-dropdown').forEach(dd => {
            dd.classList.remove('active');
          });
        }
      });
    }

    // Close on blur (delayed so click events on dropdown items register first)
    inputEl.addEventListener('blur', () => {
      setTimeout(closeDropdown, 220);
    });

    // Close on Escape key
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeDropdown();
      }
    });
  }

  renderPlannerResults(itineraries, originStop, destStop) {
    const container = document.getElementById('planner-results-container');
    if (!container) return;

    this._lastPlannedItineraries = itineraries;
    this._lastPlannerOrigin = originStop;
    this._lastPlannerDest = destStop;

    if (!Array.isArray(itineraries) || itineraries.length === 0) {
      container.innerHTML = '<div style="text-align:center; padding:2rem; color:var(--text-muted);">No s\'ha trobat cap combinació de trajecte.</div>';
      return;
    }

    const origName = originStop ? originStop.name : '';
    const destName = destStop ? destStop.name : '';

    container.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; padding:0 4px;">
        <span style="font-size:0.8rem; font-weight:700; color:var(--text-muted);">${itineraries.length} ${itineraries.length === 1 ? 'OPCIÓ' : 'OPCIONS'}:</span>
        <a href="/plan?from=${encodeURIComponent(origName)}&to=${encodeURIComponent(destName)}" target="_blank" class="maps-link" style="font-size:0.75rem; text-decoration:none; display:inline-flex; align-items:center; gap:4px;" title="Obrir planificador a pantalla completa">
          <span>↗️ Pàgina completa</span>
        </a>
      </div>
    ` + itineraries.map((it, idx) => {
      const isDirect = it.type === 'direct';
      const firstLeg = it.legs[0];
      const waitMin = Number.isFinite(firstLeg?.nextDepartureMins) 
        ? firstLeg.nextDepartureMins 
        : (Number.isFinite(it.nextDepartureMinutes) 
            ? it.nextDepartureMinutes 
            : (Number.isFinite(it.nextDepartureMins) ? it.nextDepartureMins : null));
      const waitText = Number.isFinite(waitMin) ? ` • Surt en ${waitMin} min` : '';

      return `
        <div class="planner-itinerary-card" data-itinerary-idx="${idx}" style="cursor:pointer;" title="Fes clic per veure la ruta al mapa">
          <div class="planner-card-header">
            <div class="planner-total-duration">
              <span>⏱️ ~${it.totalDurationMins} min</span>
              <span style="font-size:0.85rem; font-weight:600; color:var(--text-secondary);">${waitText}</span>
            </div>
            <span class="${isDirect ? 'planner-tag-direct' : 'planner-tag-transfer'}">
              ${isDirect ? '✓ Ruta Directa' : '🔄 1 Transbordament'}
            </span>
          </div>

          <div class="planner-legs-flow">
            ${it.walkToFirstStop && it.walkToFirstStop.distanceMeters > 15 ? `
              <div style="display:flex; align-items:center; gap:8px; padding:3px 0 5px 0; color:var(--text-secondary); font-size:0.8rem; border-bottom:1px dashed var(--border-subtle); margin-bottom:5px;">
                <span style="font-size:1rem; line-height:1;">🚶</span>
                <div>
                  <span>Caminar des de <strong>${this.esc((it.walkToFirstStop.fromName && !/^\d+$/.test(it.walkToFirstStop.fromName.trim())) ? it.walkToFirstStop.fromName : (origName || 'l\'origen'))}</strong></span>
                  <span style="font-size:0.75rem; color:var(--text-muted); margin-left:4px;">(~${it.walkToFirstStop.walkingMinutes} min • ${it.walkToFirstStop.distanceMeters} m)</span>
                </div>
              </div>
            ` : ''}

            ${it.legs.map((leg, lIdx) => {
              const destText = leg.destination || (leg.toStop && leg.toStop.name) || '';
              return `
              ${lIdx > 0 && it.transferWalk && it.transferWalk.distanceMeters > 15 ? `
                <div style="display:flex; align-items:center; gap:8px; padding:3px 0 5px 0; color:var(--text-muted); font-size:0.78rem; margin-bottom:4px;">
                  <span>🔄🚶</span>
                  <span>Enllaç a peu fins a <strong>${this.esc(leg.fromStop.name)}</strong> (~${it.transferWalk.walkingMinutes} min • ${it.transferWalk.distanceMeters} m)</span>
                </div>
              ` : ''}
              <div class="planner-leg-item">
                <div>
                  <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; margin-bottom:2px;">
                    <div style="display:flex; align-items:center; gap:6px;">
                      <span class="planner-leg-badge" style="background:${leg.lineColor || '#009485'};">
                        ${this.esc(leg.lineCode)}
                      </span>
                      <span style="font-size:0.82rem; font-weight:700; color:var(--text-primary);">
                        ${destText ? `Cap a ${this.esc(destText)}` : ''}
                      </span>
                    </div>
                    ${leg.departureTime && leg.departureTime !== 'En breu' ? `
                      <span style="font-size:0.72rem; font-weight:700; color:${leg.isRealTime ? '#10b981' : '#f59e0b'}; background:${leg.isRealTime ? 'rgba(16,185,129,0.12)' : 'rgba(245,158,11,0.12)'}; padding:2px 5px; border-radius:4px;">
                        🕐 ${this.esc(leg.departureTime)}${leg.isRealTime ? ' • En viu' : ' • Horari'}
                      </span>
                    ` : ''}
                  </div>
                  <div style="font-size:0.82rem; color:var(--text-secondary); margin-top:2px;">
                    🟢 Pujar a: <strong>${this.esc(leg.fromStop.name)}</strong>
                  </div>
                  <div style="font-size:0.82rem; color:var(--text-secondary);">
                    ${lIdx === it.legs.length - 1 ? '🏁' : '🔄'} Baixar a: <strong>${this.esc(leg.toStop.name)}</strong> (${leg.stopCount || leg.stopsCount} parades, ~${Math.round(leg.travelTimeMins || leg.durationMinutes || 0)} min)
                  </div>
                </div>
              </div>
            `;
            }).join('')}

            ${it.walkFromLastStop && it.walkFromLastStop.distanceMeters > 15 ? `
              <div style="display:flex; align-items:center; gap:8px; padding:5px 0 2px 0; color:var(--text-secondary); font-size:0.8rem; border-top:1px dashed var(--border-subtle); margin-top:5px;">
                <span style="font-size:1rem; line-height:1;">🚶</span>
                <div>
                  <span>Caminar fins a <strong>${this.esc((it.walkFromLastStop.toName && !/^\d+$/.test(it.walkFromLastStop.toName.trim())) ? it.walkFromLastStop.toName : (destName || 'la destinació'))}</strong></span>
                  <span style="font-size:0.75rem; color:var(--text-muted); margin-left:4px;">(~${it.walkFromLastStop.walkingMinutes} min • ${it.walkFromLastStop.distanceMeters} m)</span>
                </div>
              </div>
            ` : ''}
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; margin-top:0.75rem; border-top:1px solid var(--border-subtle); padding-top:0.6rem;">
            <span style="font-size:0.75rem; color:var(--text-muted); font-weight:600;">Fes clic per veure al mapa</span>
            <button type="button" class="btn-primary btn-view-itinerary-map" data-itinerary-idx="${idx}" style="padding:0.35rem 0.8rem; font-size:0.82rem;">
              <span>🗺️ Veure ruta al mapa</span>
            </button>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.planner-itinerary-card').forEach(card => {
      card.addEventListener('click', () => {
        const idx = parseInt(card.getAttribute('data-itinerary-idx'), 10);
        const origName = this._lastPlannerOrigin ? this._lastPlannerOrigin.name : (document.getElementById('planner-origin-input')?.value || '');
        const destName = this._lastPlannerDest ? this._lastPlannerDest.name : (document.getElementById('planner-dest-input')?.value || '');
        // Navigate directly to the dedicated /plan page without confusion!
        window.location.href = `/plan?from=${encodeURIComponent(origName)}&to=${encodeURIComponent(destName)}&itin=${idx}`;
      });
    });
  }

  showItineraryOnMap(itinerary) {
    if (!itinerary) return;

    // 1. Close the modal
    const modal = document.getElementById('planner-modal-backdrop');
    if (modal) modal.classList.remove('active');

    // 2. Render on Map
    if (this.mapController && typeof this.mapController.renderItinerary === 'function') {
      this.mapController.renderItinerary(itinerary);
    }

    // 3. Update map header title and hide bus counter tag
    const mapTitle = document.getElementById('map-line-title');
    const busCounter = document.getElementById('map-bus-counter-tag');
    if (mapTitle) {
      if (!this._savedMapTitle) this._savedMapTitle = mapTitle.textContent;
      mapTitle.textContent = `🧭 Itinerari: ${itinerary.originStop?.name || 'Origen'} ➔ ${itinerary.destStop?.name || 'Destinació'}`;
    }
    if (busCounter) busCounter.style.display = 'none';

    // 4. Show floating guidance bar on the map
    const bar = document.getElementById('itinerary-floating-bar');
    const titleText = document.getElementById('itinerary-summary-text');
    const stepsContainer = document.getElementById('itinerary-bar-steps');

    if (bar && titleText && stepsContainer) {
      titleText.textContent = `${itinerary.legs.map(l => l.lineCode).join(' ➔ ')} (~${itinerary.totalDurationMins} min)`;

      stepsContainer.innerHTML = itinerary.legs.map((leg) => {
        return `
          <div class="itinerary-step-chip">
            <span class="planner-leg-badge" style="background:${leg.lineColor || '#0ea5e9'}; padding:1px 5px; font-size:10px;">${this.esc(leg.lineCode)}</span>
            <span>${this.esc(leg.fromStop.name)} ➔ ${this.esc(leg.toStop.name)}</span>
          </div>
        `;
      }).join('<span style="color:var(--text-muted); font-size:0.8rem;">➔</span>');

      bar.classList.add('active');
    }
  }

  // ==========================================
  // TRAFFIC CONGESTION HEATMAP
  // ==========================================

  setupTrafficEvents() {
    const trafficBtn = document.getElementById('btn-map-toggle-traffic');
    if (!trafficBtn) return;

    trafficBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      this.isTrafficVisible = !this.isTrafficVisible;
      trafficBtn.classList.toggle('active', this.isTrafficVisible);

      if (!this.isTrafficVisible) {
        this.mapController?.toggleTrafficHeatmap(false);
        return;
      }

      if (!this.activeLineId) {
        this.mapController?.toggleTrafficHeatmap(false);
        trafficBtn.classList.remove('active');
        return;
      }

      try {
        const res = await fetch(`/api/mataro/line/${this.activeLineId}/traffic?direction=${this.activeDirection || '0'}`).then(r => r.json());
        if (res.success && Array.isArray(res.segments)) {
          this.mapController?.toggleTrafficHeatmap(true, res.segments);
        }
      } catch (err) {
        console.warn('Traffic fetch error:', err);
      }
    });
  }

  // ==========================================
  // PROXIMITY & WAKE-UP ALARM
  // ==========================================

  setupProximityAlarmEvents() {
    const dismissBtn = document.getElementById('btn-alarm-dismiss');
    dismissBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      this.dismissProximityAlert();
    });
  }

  toggleProximityAlarm(stop) {
    if (!stop || !stop.id) return;
    const sId = String(stop.id);

    if (this.activeProximityAlarm && this.activeProximityAlarm.stopId === sId) {
      this.clearProximityAlarm();
      const alarmBtn = document.getElementById('modal-proximity-alarm-btn');
      const alarmBtnText = document.getElementById('modal-alarm-btn-text');
      if (alarmBtn) alarmBtn.classList.remove('active');
      if (alarmBtnText) alarmBtnText.textContent = "Avisa'm en arribar";
      return;
    }

    if (typeof Notification !== 'undefined' && Notification.permission !== 'granted' && Notification.permission !== 'denied') {
      Notification.requestPermission();
    }

    this.activeProximityAlarm = {
      stopId: sId,
      stopName: stop.name || 'Parada',
      lat: stop.lat,
      lon: stop.lon
    };

    const alarmBtn = document.getElementById('modal-proximity-alarm-btn');
    const alarmBtnText = document.getElementById('modal-alarm-btn-text');
    if (alarmBtn) alarmBtn.classList.add('active');
    if (alarmBtnText) alarmBtnText.textContent = 'Alarma Activada ⏰';

    if (navigator.geolocation) {
      this.alarmWatchId = navigator.geolocation.watchPosition(
        (pos) => {
          if (!this.activeProximityAlarm) return;
          const userLat = pos.coords.latitude;
          const userLon = pos.coords.longitude;
          if (stop.lat && stop.lon) {
            const dist = this.calculateDistMeters(userLat, userLon, stop.lat, stop.lon);
            if (dist < 350) {
              this.triggerProximityAlert(this.activeProximityAlarm);
            }
          }
        },
        () => {},
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
      );
    }
  }

  calculateDistMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  triggerProximityAlert(stop) {
    if (navigator.vibrate) {
      try {
        navigator.vibrate([400, 200, 400, 200, 800, 200, 800]);
      } catch (_) {}
    }

    this.playChime();

    const alertModal = document.getElementById('alarm-alert-backdrop');
    const stopNameEl = document.getElementById('alarm-alert-stop-name');
    if (stopNameEl) stopNameEl.textContent = stop.stopName || stop.name || 'La teva parada';
    if (alertModal) alertModal.style.display = 'flex';

    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification("Arribo! Mataró: Propera Parada!", {
          body: `Estàs arribant a ${stop.stopName || stop.name}! Prepara't per baixar.`,
          icon: '/favicon.ico'
        });
      } catch (_) {}
    }

    this.clearProximityAlarm();
  }

  dismissProximityAlert() {
    const alertModal = document.getElementById('alarm-alert-backdrop');
    if (alertModal) alertModal.style.display = 'none';
  }

  clearProximityAlarm() {
    if (this.alarmWatchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(this.alarmWatchId);
      this.alarmWatchId = null;
    }
    this.activeProximityAlarm = null;
  }

  // ==========================================
  // "EL TERMÒMETRE DEL BUS" SCORECARD & SHARE
  // ==========================================

  setupTermometreEvents() {
    // Extracted to /dades (ObservatoriApp)
  }

  // ==========================================
  // "INVESTIGADOR D'INCIDENTS CRÍTICS" DEEP-DIVE
  // ==========================================

  setupDelayIncidentsEvents() {
    // Extracted to /dades (ObservatoriApp)
  }

  openDelayIncidentsTab(lineCode = 'all') {
    const incidentsTab = document.getElementById('btn-observatori-incidents');
    const timeframeTabs = document.getElementById('journalism-timeframe-tabs');
    const incidentsContainer = document.getElementById('journalism-incidents-container');
    const termometreContainer = document.getElementById('journalism-termometre-container');
    const contentContainer = document.getElementById('journalism-content-container');
    const searchBarWrap = document.getElementById('journalism-search-bar-wrap');

    timeframeTabs?.querySelectorAll('.line-filter-tab').forEach(t => t.classList.remove('active'));
    incidentsTab?.classList.add('active');

    if (searchBarWrap) searchBarWrap.style.display = 'none';
    if (contentContainer) contentContainer.style.display = 'none';
    if (termometreContainer) termometreContainer.style.display = 'none';
    if (incidentsContainer) incidentsContainer.style.display = 'block';

    const hours = this.currentJournalismHours || 168;
    this.openDelayIncidentsView(lineCode, hours, 'top');
  }

  async openDelayIncidentsView(lineCode = 'all', hours = 168, viewMode = 'top') {
    this._currentIncidentLine = lineCode;
    this._currentIncidentHours = hours;
    this._currentIncidentMode = viewMode;

    const container = document.getElementById('journalism-incidents-container');
    if (!container) return;

    const cleanLabel = (lineCode === 'all' || lineCode === 'ALL') ? 'tota la xarxa' : lineCode;
    container.innerHTML = `
      <div style="text-align:center; padding:3rem 1rem; color:var(--text-muted);">
        <span class="loading-spinner-inline" style="width:24px; height:24px; border-width:3px; margin-bottom:0.75rem;"></span>
        <div style="font-weight:700; font-size:0.95rem; color:var(--text-primary); margin-top:0.5rem;">Analitzant telemetria històrica...</div>
        <div style="font-size:0.8rem; margin-top:0.25rem;">Cercant incidents crítics i traçant trajectòries per a ${cleanLabel}</div>
      </div>
    `;

    try {
      const cleanLine = encodeURIComponent(lineCode);
      const res = await fetch(`/api/analytics/incidents?line=${cleanLine}&hours=${hours}&limit=30&minDelay=5`).then(r => r.json());
      if (res && res.success) {
        this._lastIncidentData = res;
        this.renderDelayIncidentsView(res, lineCode, hours, viewMode);
      } else {
        container.innerHTML = `<div style="padding:2rem; text-align:center; color:#ef4444;">Error en carregar les dades d'incidents.</div>`;
      }
    } catch (err) {
      container.innerHTML = `<div style="padding:2rem; text-align:center; color:#ef4444;">Error de connexió al carregar incidents.</div>`;
    }
  }

  renderDelayIncidentsView(data, selectedLine = 'all', selectedHours = 168, activeTab = 'top') {
    const container = document.getElementById('journalism-incidents-container');
    if (!container || !data) return;

    const s = data.summary || {};
    const topList = data.topIncidents || [];
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

    container.innerHTML = `
      <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:1.1rem; margin-bottom:1.25rem;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:0.75rem;">
          <div>
            <span style="font-size:0.75rem; font-weight:800; color:#38bdf8; text-transform:uppercase; letter-spacing:0.5px;">Observatori de Mobilitat • Anàlisi de Causes</span>
            <h3 style="font-size:1.35rem; font-weight:800; color:#fff; margin:0.2rem 0;">Investigador d'Incidents Crítics & Top Retards</h3>
            <p style="font-size:0.78rem; color:var(--text-muted); margin:0; max-width:680px;">
              Auditoria de retards extrems (&ge; 5 min) detectats per telemetria GPS. Permet investigar si els retards màxims (+25 min) corresponen a retencions de trànsit reals en moviment o a autobusos regulant a capçalera.
            </p>
          </div>
        </div>

        <!-- Filter Controls Row -->
        <div style="display:flex; flex-direction:column; gap:0.65rem; margin-top:1rem; padding-top:0.85rem; border-top:1px solid var(--border-subtle);">
          <!-- Timeframe selector -->
          <div style="display:flex; align-items:center; gap:0.4rem; flex-wrap:wrap;">
            <span style="font-size:0.75rem; font-weight:700; color:var(--text-muted); min-width:60px;">Període:</span>
            <button type="button" class="incident-filter-pill ${Number(selectedHours) === 24 ? 'active' : ''}" data-incident-hours="24">⏱️ 24 hores</button>
            <button type="button" class="incident-filter-pill ${Number(selectedHours) === 48 ? 'active' : ''}" data-incident-hours="48">📅 48 hores</button>
            <button type="button" class="incident-filter-pill ${Number(selectedHours) === 168 ? 'active' : ''}" data-incident-hours="168">🗓️ 7 dies</button>
          </div>

          <!-- Line selector -->
          <div style="display:flex; align-items:center; gap:0.4rem; flex-wrap:wrap;">
            <span style="font-size:0.75rem; font-weight:700; color:var(--text-muted); min-width:60px;">Línia:</span>
            <button type="button" class="incident-filter-pill ${activeLineNorm === 'ALL' ? 'active' : ''}" data-incident-line="all">🌐 Totes les línies</button>
            ${linesCatalog.map(lCode => {
              const isActive = activeLineNorm === lCode;
              const color = getLineColor(lCode);
              return `
                <button type="button" class="incident-filter-pill ${isActive ? 'active' : ''}" data-incident-line="${lCode}">
                  <span style="width:8px; height:8px; border-radius:50%; background:${color}; display:inline-block;"></span>
                  <span>${lCode}</span>
                </button>
              `;
            }).join('')}
          </div>
        </div>
      </div>

      <!-- KPI Summary Cards -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:0.75rem; margin-bottom:1.25rem;">
        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:0.9rem;">
          <div style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase;">Retard Màxim Registrat</div>
          <div style="font-size:1.6rem; font-weight:800; color:#ef4444; margin-top:0.2rem;">+${s.maxDelayMins || 0} min</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${(s.totalRecordedIncidents || 0).toLocaleString()} mostres amb retard &ge; 5m</div>
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:0.9rem;">
          <div style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase;">Punt Negre (Més Afectat)</div>
          <div style="font-size:1.05rem; font-weight:700; color:var(--brand-primary); margin-top:0.25rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${this.esc(s.worstStop || 'Cap')}">📍 ${this.esc(s.worstStop || 'Cap')}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${s.worstStopCount || 0} afectacions registrades</div>
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:0.9rem;">
          <div style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase;">Franja amb Més Retards</div>
          <div style="font-size:1.15rem; font-weight:700; color:#f59e0b; margin-top:0.25rem;">⏰ ${s.worstHour || '--:00'}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${s.worstHourTag || 'Horari regular'}</div>
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:0.9rem;">
          <div style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase;">Naturalesa de les Incidències</div>
          <div style="font-size:1.05rem; font-weight:700; color:#38bdf8; margin-top:0.25rem;">${s.movingPct || 0}% Trànsit actiu</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${s.stationaryCount || 0} regulacions • ${s.maintenanceCount || 0} cotxeres / proves</div>
        </div>
      </div>

      <!-- Sub-Tab Mode Switcher -->
      <div style="display:flex; gap:0.5rem; border-bottom:1px solid var(--border-subtle); padding-bottom:0.75rem; margin-bottom:1rem;">
        <button type="button" class="incident-view-mode-tab ${activeTab === 'top' ? 'active' : ''}" data-incident-tab="top">
          <span>📋 Rànquing d'Incidents per Expedició (${topList.length})</span>
        </button>
        <button type="button" class="incident-view-mode-tab ${activeTab === 'trips' ? 'active' : ''}" data-incident-tab="trips">
          <span>${CANONICAL_BUS_ICON_SVG} Expedicions & Trajectòries Afectades (${tripsList.length})</span>
        </button>
      </div>

      <!-- Mode 1: Top Delays Table (Peak per Trip) -->
      ${activeTab === 'top' ? `
        ${topList.length === 0 ? `
          <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:10px; padding:2rem; text-align:center; color:var(--text-muted);">
            No s'han registrat retards greus (&ge; 5 min) per a la selecció actual (${selectedHours}h).
          </div>
        ` : `
          <div style="font-size:0.78rem; color:var(--text-muted); margin-bottom:0.6rem; display:flex; align-items:center; gap:6px;">
            <span>ℹ️</span>
            <span>Mostrant el pic de retard màxim de cada expedició afectada (s'agrupen els senyals cada 20s d'un mateix viatge per evitar duplicats).</span>
          </div>
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
                  <th style="text-align:center; cursor:help;" title="Tipus de senyal: 🟢 GPS (dades directes en temps real) o ⚡ Estimat (bus físic amb pèrdua temporal de cobertura, projectat per estima dead-reckoning fins a 90s)">Senyal ℹ️</th>
                  <th style="text-align:center;">Mapa</th>
                </tr>
              </thead>
              <tbody>
                ${topList.map((inc, i) => {
                  const lColor = getLineColor(inc.lineCode);
                  const delayClass = inc.delayMins >= 20 ? '#ef4444' : (inc.delayMins >= 10 ? '#f59e0b' : '#38bdf8');
                  const signalTooltip = inc.isRealTime
                    ? '🟢 Senyal GPS directe: Telemetria transmesa en temps real pel vehicle físic.'
                    : '⚡ Estimació per estima (dead-reckoning): Autobús físic amb GPS que ha perdut la cobertura temporalment (túnels, carrers estrets o caiguda de xarxa). La posició i el retard es calculen avançant la darrera velocitat i retard coneguts (màxim 90 segons). Mai s\'aplica a autobusos sense GPS.';
                  return `
                    <tr>
                      <td style="font-weight:700; color:var(--text-muted); text-align:center;">${inc.rank || (i + 1)}</td>
                      <td style="font-weight:800; color:${delayClass}; white-space:nowrap;">+${inc.delayMins} min</td>
                      <td>
                        <div style="display:inline-flex; align-items:center; gap:5px; flex-wrap:wrap;">
                          <span style="background:${lColor}; color:#fff; padding:0.15rem 0.45rem; border-radius:5px; font-weight:800; font-size:0.75rem;">${this.esc(inc.lineCode)}</span>
                          ${formatBusBadge(inc.vehicleId)}
                        </div>
                      </td>
                      <td style="font-weight:600; color:var(--text-primary);">
                        <span style="color:#38bdf8; margin-right:4px;">📍</span>${this.esc(inc.stopName)}
                      </td>
                      <td style="color:var(--text-secondary); white-space:nowrap; font-size:0.8rem;">
                        ${this.esc(inc.formattedDate || '')}
                      </td>
                      <td style="white-space:nowrap; font-size:0.78rem;">
                        <span>${inc.trafficIcon || '⏱️'}</span>
                        <span style="color:var(--text-muted); margin-left:3px;">${this.esc(inc.trafficTag || '')}</span>
                      </td>
                      <td style="text-align:center; white-space:nowrap;">
                        <span style="background:${inc.isRealTime ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)'}; color:${inc.isRealTime ? '#10b981' : '#fbbf24'}; padding:0.15rem 0.45rem; border-radius:5px; font-size:0.7rem; font-weight:700; cursor:help; display:inline-flex; align-items:center; gap:2px;" title="${this.esc(signalTooltip)}">
                          ${inc.isRealTime ? '🟢 GPS' : '⚡ Estimat'}
                        </span>
                      </td>
                      <td style="text-align:center; white-space:nowrap;">
                        <button type="button" class="btn-locate-incident-stop" data-locate-line="${this.esc(inc.lineCode)}" data-locate-stop="${this.esc(inc.stopName)}" title="Veure aquesta parada al mapa">
                          <span>📍 Mapa</span>
                        </button>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        `}
      ` : `
        <!-- Mode 2: Clustered Trips & Trajectories -->
        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:10px; padding:0.85rem 1rem; margin-bottom:1rem; font-size:0.8rem; line-height:1.5;">
          <div style="display:flex; align-items:flex-start; gap:0.65rem;">
            <span style="font-size:1.15rem; line-height:1; margin-top:2px;">ℹ️</span>
            <div style="flex:1;">
              <div style="font-weight:700; color:var(--text-primary); margin-bottom:0.25rem;">
                Com funcionen les expedicions i trajectòries?
              </div>
              <div style="color:var(--text-secondary); margin-bottom:0.6rem;">
                Cada targeta reconstrueix el recorregut continu d'un <strong>autobús físic individual</strong> (separat per identificador de vehicle), seguint cronològicament com evoluciona el seu retard parada a parada al llarg del servei:
              </div>
              <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:0.6rem; font-size:0.76rem; color:var(--text-muted);">
                <div style="background:var(--bg-surface); padding:0.55rem 0.75rem; border-radius:6px; border:1px solid var(--border-subtle);">
                  <strong style="color:var(--text-primary); display:block; margin-bottom:2px;">${CANONICAL_BUS_ICON_SVG} Bus ID individual</strong>
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
              const typeBadgeClass = trip.incidentType === 'maintenance'
                ? 'incident-badge-maintenance'
                : (trip.isMovingTraffic ? 'incident-badge-traffic' : 'incident-badge-layover');
              return `
                <div class="trip-card">
                  <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
                    <div style="display:flex; align-items:center; gap:0.5rem;">
                      <span style="background:${lColor}; color:#fff; padding:0.2rem 0.55rem; border-radius:6px; font-weight:800; font-size:0.8rem;">${this.esc(trip.lineCode)}</span>
                      <strong style="color:var(--text-primary); font-size:0.9rem;">Expedició del ${this.esc(trip.startTime)}</strong>
                      ${formatBusBadge(trip.vehicleId)}
                      <span style="color:var(--text-muted); font-size:0.78rem;">(durada activa: ~${trip.durationMinutes || 1} min)</span>
                    </div>
                    <div style="display:flex; align-items:center; gap:0.5rem;">
                      <span class="${typeBadgeClass}" style="padding:0.2rem 0.5rem; border-radius:6px; font-size:0.74rem; font-weight:700;">
                        ${this.esc(trip.incidentTypeLabel)}
                      </span>
                      <span style="background:rgba(239,68,68,0.15); color:#ef4444; padding:0.2rem 0.55rem; border-radius:6px; font-size:0.78rem; font-weight:800;">
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
                      let pillClass = st.isRecovered ? 'trip-stop-pill pill-recovered' : 'trip-stop-pill';
                      if (dMins != null) {
                        const delayClass = st.isRecovered
                          ? 'delay-recovered'
                          : (dMins >= 10 ? 'delay-severe' : 'delay-moderate');
                        const delayText = st.isRecovered
                          ? `${dMins > 0 ? `+${dMins}` : dMins}m ✓`
                          : `+${dMins}`;
                        delayBadge = `<span class="trip-stop-delay ${delayClass}">${delayText}</span>`;
                      }
                      return `
                        <span class="${pillClass}" title="${this.esc(st.stopName)}${dMins != null ? ` (${st.isRecovered ? 'Recuperat' : 'Retard'}: +${dMins} min)` : ''}">
                          <span>${st.isRecovered ? '🟢' : '📍'}</span>
                          <span>${this.esc(st.stopName)}</span>
                          ${delayBadge}
                        </span>
                        ${sIdx < arr.length - 1 ? '<span class="trip-arrow">➔</span>' : ''}
                      `;
                    }).join('')}
                  </div>

                  <!-- Context and action footer -->
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-top:0.6rem; font-size:0.75rem; color:var(--text-muted); flex-wrap:wrap; gap:0.4rem;">
                    <div>
                      <span>${trip.trafficIcon || '⏱️'}</span>
                      <span>${this.esc(trip.trafficTag || '')} • ${trip.sampleCount} mostres registrades (${trip.incidentType === 'maintenance' ? 'proves o encesa a cotxeres' : (trip.isMovingTraffic ? `recorregut per ${trip.stopsCount} parades en retenció` : 'aturat a parada / regulant capçalera')})</span>
                    </div>
                    <button type="button" class="btn-locate-incident-stop" data-locate-line="${this.esc(trip.lineCode)}" data-locate-stop="${this.esc(trip.firstStop || trip.stopsTraversed[0])}">
                      <span>📍 Veure parada al mapa</span>
                    </button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `}
      `}
    `;
  }

  jumpToIncidentStop(lineId, stopName) {
    const backdrop = document.getElementById('journalism-modal-backdrop');
    backdrop?.classList.remove('active');

    const cleanId = String(lineId || '').replace(/^L/i, '');
    this.switchLine(cleanId);

    setTimeout(() => {
      let targetStop = (this.allStops || []).find(s => s.name?.toLowerCase() === stopName?.toLowerCase());
      if (!targetStop && this.allStopsMap) {
        for (const s of this.allStopsMap.values()) {
          if (s.name?.toLowerCase() === stopName?.toLowerCase()) {
            targetStop = s;
            break;
          }
        }
      }
      if (targetStop && targetStop.lat && targetStop.lon) {
        this.mapController?.focusTargetStop(targetStop.lat, targetStop.lon);
        this.openStopDetailsModal(targetStop);
      }
    }, 300);
  }

  renderTermometreScorecard(t) {
    const container = document.getElementById('journalism-termometre-container');
    if (!container || !t) return;

    const gradeColor = (t.grade && t.grade.startsWith('A')) ? '#10b981' : ((t.grade && t.grade.startsWith('B')) ? '#38bdf8' : ((t.grade && t.grade.startsWith('C')) ? '#f59e0b' : '#ef4444'));

    container.innerHTML = `
      <div class="termometre-scorecard" id="termometre-card-root">
        <div class="termometre-header">
          <div>
            <span style="font-size:0.75rem; font-weight:800; color:#38bdf8; text-transform:uppercase; letter-spacing:0.5px;">Observatori Cívic de Mobilitat</span>
            <h3 style="font-size:1.35rem; font-weight:800; color:#fff; margin:0.2rem 0;">🌡️ El Termòmetre del Bus Mataró</h3>
            <span style="font-size:0.78rem; color:var(--text-muted);">Auditoria independent basada en mostres reals de telemetria GPS</span>
          </div>
          <div class="termometre-grade-badge" style="border-color:${gradeColor}; background:rgba(16,185,129,0.12);">
            <div>
              <div style="font-size:0.65rem; font-weight:800; color:var(--text-muted); text-transform:uppercase;">Nota Global</div>
              <div class="termometre-grade-letter" style="color:${gradeColor};">${this.esc(t.grade || 'A')}</div>
            </div>
          </div>
        </div>

        <div class="termometre-metrics-grid">
          <div class="termometre-metric-tile" style="border-left:3px solid #10b981;">
            <span class="termometre-metric-label">🏆 Línia Més Puntual</span>
            <span class="termometre-metric-val" style="color:#10b981;">
              ${this.esc(t.championLine?.code || 'L1')} (${t.championLine?.onTimePct || 95}% puntual)
            </span>
            <span style="font-size:0.72rem; color:var(--text-muted);">Retard mitjà: ${t.championLine?.avgDelay || 0.8} min</span>
          </div>

          <div class="termometre-metric-tile" style="border-left:3px solid #ef4444;">
            <span class="termometre-metric-label">⚠️ Punt Negre / Retards</span>
            <span class="termometre-metric-val" style="color:#ef4444; font-size:1rem;">
              ${this.esc(t.worstBottleneck?.stopName || 'Pl. Tereses')}
            </span>
            <span style="font-size:0.72rem; color:var(--text-muted);">${this.esc(t.worstBottleneck?.lineCode || '')} • +${t.worstBottleneck?.avgDelay || 3.2} min retard mitjà</span>
          </div>

          <div class="termometre-metric-tile" style="border-left:3px solid #f59e0b;">
            <span class="termometre-metric-label">⏱️ Franja de Major Congestió</span>
            <span class="termometre-metric-val" style="color:#f59e0b;">
              ${this.esc(t.peakHour || '08:00 - 09:00')}
            </span>
            <span style="font-size:0.72rem; color:var(--text-muted);">Punt màxim de retards a la xarxa</span>
          </div>

          <div class="termometre-metric-tile" style="border-left:3px solid #38bdf8;">
            <span class="termometre-metric-label">🌐 Puntualitat Global</span>
            <span class="termometre-metric-val" style="color:#38bdf8;">
              ${t.punctualityPct || 92}%
            </span>
            <span style="font-size:0.72rem; color:var(--text-muted);">${(t.totalTripsAnalyzed || 0).toLocaleString()} expedicions analitzades</span>
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
        `• Nota Global: ${t.grade} (${t.punctualityPct}% puntualitat)\n` +
        `• 🏆 Línia més puntual: ${t.championLine?.code} (${t.championLine?.onTimePct}%)\n` +
        `• ⚠️ Punt negre: ${t.worstBottleneck?.stopName} (+${t.worstBottleneck?.avgDelay} min)\n` +
        `• ⏱️ Hora punta: ${t.peakHour}\n` +
        `• Expedicions analitzades: ${(t.totalTripsAnalyzed || 0).toLocaleString()}\n\n` +
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
  <text x="707" y="96" fill="${gradeColor}" font-size="34" text-anchor="middle" font-weight="bold">${t.grade}</text>
  
  <rect x="40" y="140" width="345" height="100" rx="10" fill="#1e293b" stroke="#10b981" stroke-width="1.5"/>
  <text x="60" y="170" fill="#10b981" font-size="13" font-weight="bold">🏆 LÍNIA MÉS PUNTUAL</text>
  <text x="60" y="202" fill="#ffffff" font-size="20" font-weight="bold">${t.championLine?.code || 'L1'} (${t.championLine?.onTimePct || 95}% puntual)</text>
  <text x="60" y="225" fill="#94a3b8" font-size="12">Retard mitjà: ${t.championLine?.avgDelay || 0.8} min</text>
  
  <rect x="415" y="140" width="345" height="100" rx="10" fill="#1e293b" stroke="#ef4444" stroke-width="1.5"/>
  <text x="435" y="170" fill="#ef4444" font-size="13" font-weight="bold">⚠️ PUNT NEGRE / RETARDS</text>
  <text x="435" y="202" fill="#ffffff" font-size="18" font-weight="bold">${t.worstBottleneck?.stopName || 'Pl. Tereses'}</text>
  <text x="435" y="225" fill="#94a3b8" font-size="12">${t.worstBottleneck?.lineCode || ''} • +${t.worstBottleneck?.avgDelay || 3.2} min retard mitjà</text>
  
  <rect x="40" y="260" width="345" height="100" rx="10" fill="#1e293b" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="60" y="290" fill="#f59e0b" font-size="13" font-weight="bold">⏱️ HORA PUNTA CONGESTIÓ</text>
  <text x="60" y="322" fill="#ffffff" font-size="20" font-weight="bold">${t.peakHour || '08:00 - 09:00'}</text>
  <text x="60" y="345" fill="#94a3b8" font-size="12">Punt màxim de retards a la xarxa</text>
  
  <rect x="415" y="260" width="345" height="100" rx="10" fill="#1e293b" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="435" y="290" fill="#38bdf8" font-size="13" font-weight="bold">🌐 PUNTUALITAT GLOBAL</text>
  <text x="435" y="322" fill="#ffffff" font-size="20" font-weight="bold">${t.punctualityPct || 92}% (${(t.totalTripsAnalyzed || 0).toLocaleString()} viatges)</text>
  <text x="435" y="345" fill="#94a3b8" font-size="12">Mitjana xarxa: ${t.networkAvgDelay || 1.1} min retard</text>
  
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
}

// Instantiate global application
window.addEventListener('DOMContentLoaded', () => {
  window.transitApp = new TransitApp();
});

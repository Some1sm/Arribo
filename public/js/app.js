// Arribo! - Plataforma de Telemetria i Seguiment d'Autobusos en Temps Real
// Suport universal per a totes les línies d'autobús urbà i interurbà de Catalunya

class TransitApp {
  constructor() {
    this.activeLineId = null;
    this.activeDirection = '1';

    this.availableLines = [];
    this.activeLineData = null;
    
    this.targetStopsByLine = JSON.parse(localStorage.getItem('bad_amb_target_stops') || '{}');
    this.lineCache = new Map(); // LRU bounded to max 8 active routes
    this.stopDeparturesCache = new Map(); // Client-side SWR stop departures cache
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
    
    this.soundEnabled = localStorage.getItem('c10_sound') === 'true';
    this.audioContext = null;
    this.lastAlertedTrip = null;

    // Inactive Tab Deep Sleep (Page Visibility API)
    this.isTabVisible = typeof document !== 'undefined' ? !document.hidden : true;
    this.animFrameId = null;

    // Trains UI display flag: trains remain fully operational in backend/tests, but hidden from the general transit UI
    this.showTrainsInUI = false;

    // Theme Management (Light / Dark Mode)
    this.currentTheme = this.getInitialTheme();
    this.initTheme();

    this.mapController = null;
    this.init();
  }

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

  getInitialTheme() {
    const saved = localStorage.getItem('bad_amb_theme');
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
        if (!localStorage.getItem('bad_amb_theme')) {
          this.setTheme(e.matches ? 'dark' : 'light', false);
        }
      });
    }
  }

  setTheme(theme, save = true) {
    this.currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    if (save) {
      localStorage.setItem('bad_amb_theme', theme);
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
    } catch (err) {
      console.error('Fatal initialization error:', err);
    }
  }

  parseUrlHash() {
    const hash = window.location.hash.toLowerCase().replace('#', '').trim();
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
      badge.textContent = '🚌';
      badge.style.background = 'var(--c10-primary)';
      badge.style.color = '#ffffff';
      badge.style.fontSize = '1.25rem';
    }
    if (modeBadge) {
      modeBadge.textContent = 'Temps Real';
      modeBadge.className = 'header-mode-badge universal';
    }
    if (subtitle) {
      subtitle.textContent = 'Telemetria de busos en directe a Catalunya';
    }

    document.title = "Arribo! | Telemetria i Seguiment d'Autobusos en Temps Real";
  }

  showActiveLineView() {
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
      this.renderTargetCardLoading(lineObj, 'Carregant parada...');
    }

    const routeKey = `${this.activeLineId}_${this.activeDirection}`;
    const cached = this.lineCache.get(routeKey);
    if (cached) {
      this.activeLineData = cached;
      this.allStops = cached.stops || [];
      const savedStopId = this.targetStopsByLine[routeKey] || null;
      const activeTargetId = savedStopId || this.allStops[0]?.id || null;
      this.populateSelect('target-stop-select', this.allStops, activeTargetId);
      this.renderRouteTimeline(cached, activeTargetId);
      this.renderStopsBrowser(cached, this.activeLineId);
    } else {
      this.mapController?.clearAll();
      this.activeLineData = null;
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

    heroInput?.addEventListener('input', (e) => {
      const q = e.target.value;
      if (clearBtn) clearBtn.style.display = q ? 'block' : 'none';
      clearTimeout(this.landingSearchDebounceTimer);
      this.landingSearchDebounceTimer = setTimeout(() => {
        this.landingSearch = q;
        this.renderLandingLines();
      }, 150);
    });

    clearBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      if (heroInput) {
        heroInput.value = '';
        heroInput.focus();
      }
      clearBtn.style.display = 'none';
      this.landingSearch = '';
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

    // Single delegated click listener on container (eliminates thousands of closure allocations)
    container?.addEventListener('click', (e) => {
      const card = e.target.closest('.landing-line-card');
      if (card) {
        e.preventDefault();
        const lineId = card.getAttribute('data-line-id');
        if (lineId) {
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

    if (linesToRender.length === 0) {
      container.innerHTML = `
        <div style="padding: 3rem 1rem; text-align: center; color: var(--text-muted); background:var(--bg-card-gradient); border-radius:var(--radius-lg); border:1px solid var(--border-subtle);">
          <div style="font-size: 2.2rem; margin-bottom: 0.5rem;">🔍</div>
          <div style="font-size:1.1rem; font-weight: 700; color: #fff; margin-bottom: 0.35rem;">Cap línia trobada</div>
          <div style="font-size: 0.85rem; max-width:450px; margin:0 auto;">No hi ha cap resultat per a "${this.esc(this.landingSearch)}". Prova cercant per línia (ex: L1, L2, L3, 5, 8) o parada.</div>
        </div>
      `;
      return;
    }

    let html = `
      <div class="landing-group-section">
        <div class="landing-group-header">
          <h3><span>📍</span> Mataró Bus Urbà</h3>
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

    container.innerHTML = html;
  }

  resolveBusForDeparture(dep, stopSeq = null, stopId = null, depIndex = 0) {
    const buses = this.activeLineData?.activeBuses || [];
    if (buses.length === 0) return null;

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
        const busSeq = explicitBus.fromSeq || explicitBus.currentStopSeq || null;
        // Check if this vehicle has already passed this stop on this run
        if (stopSeq !== null && busSeq !== null && busSeq > stopSeq) {
          // Bus already passed the stop! Find an upstream approaching bus (before the stop in sequence)
          const upstreamBuses = buses.filter(b => {
            const bSeq = b.fromSeq || b.currentStopSeq || 0;
            return bSeq <= stopSeq;
          }).sort((a, b) => (b.fromSeq || b.currentStopSeq || 0) - (a.fromSeq || a.currentStopSeq || 0));

          if (upstreamBuses.length > 0) {
            const pickedIdx = Math.min(depIndex, upstreamBuses.length - 1);
            return upstreamBuses[pickedIdx];
          }
        }
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
        const busSeq = coordBus.fromSeq || coordBus.currentStopSeq || null;
        if (stopSeq === null || busSeq === null || busSeq <= stopSeq) {
          return coordBus;
        }
      }
    }

    // 3. Find all upstream approaching buses (stop sequence is ahead of bus)
    if (stopSeq !== null) {
      const upstreamBuses = buses.filter(b => {
        const bSeq = b.fromSeq || b.currentStopSeq || 0;
        return bSeq <= stopSeq;
      }).sort((a, b) => (b.fromSeq || b.currentStopSeq || 0) - (a.fromSeq || a.currentStopSeq || 0));

      if (upstreamBuses.length > 0) {
        const pickedIdx = Math.min(depIndex, upstreamBuses.length - 1);
        return upstreamBuses[pickedIdx];
      }
    }

    // 4. Fallback: if all buses are downstream or stopSeq is unknown, pick nearest
    return buses[Math.min(depIndex, buses.length - 1)] || buses[0];
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
      if (lineRes.success && lineRes.data) {
        const lData = lineRes.data;
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
      }

      // 3. Asynchronously handle Target Stop ETA without delaying map transition
      etaPromise.then(etaRes => {
        if (etaRes.success && etaRes.data && this.activeLineId === lId && this.activeDirection === dir) {
          this.renderTargetCard(etaRes.data, this.activeLineData);
          this.renderTelemetryCockpit(this.activeLineData, etaRes.data);
          this.checkArrivalAlerts(this.activeLineData, activeTargetId);
        }
      });

      this.secondsRemaining = this.pollInterval;
      this.updateCountdownLabel();
    } catch (err) {
      console.error('Data refresh error:', err);
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
        city.innerHTML = `${this.esc(text)} • <a href="${this.safeUrl(lData.operatorWebsite)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" style="color:var(--brand-primary, #38bdf8); text-decoration:underline; font-weight:600; cursor:pointer;" title="Consultar horaris PDF oficials">📄 Web PDF oficial ↗</a>`;
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
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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
      const disruptions = res.disruptions || [];

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
        ${d.affectedLines ? `<div class="disruption-lines-badge">🚌 ${this.esc(this.decodeHtml(d.affectedLines))}</div>` : ''}
        ${d.affectedStops ? `<div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:0.4rem;">🚏 ${this.esc(this.decodeHtml(d.affectedStops))}</div>` : ''}
        <div class="disruption-body-text">${this.esc(this.decodeHtml(d.description))}</div>
      </div>
    `).join('');
  }

  // ==========================================
  // 1.5 JOURNALISM & HISTORICAL DELAY ANALYTICS
  // ==========================================

  async openJournalismModal(hours = 24, initialFilter = null) {
    const backdrop = document.getElementById('journalism-modal-backdrop');
    const container = document.getElementById('journalism-content-container');
    const searchInput = document.getElementById('journalism-search-input');
    if (!backdrop || !container) return;

    if (initialFilter !== null && initialFilter !== undefined) {
      this.journalismFilterText = initialFilter;
      if (searchInput) searchInput.value = initialFilter;
    } else if (searchInput) {
      this.journalismFilterText = searchInput.value || '';
    }

    backdrop.classList.add('active');
    if (!this.currentJournalismReport) {
      container.innerHTML = '<div style="text-align:center; padding:2rem; color:var(--text-muted);">Carregant informe de retards i puntualitat del servidor central...</div>';
    }

    try {
      const [res, snapshotRes] = await Promise.allSettled([
        fetch(`/api/analytics/journalism?hours=${hours}`).then(r => r.json()),
        fetch(`/api/routes/snapshots`).then(r => r.json())
      ]);

      const journalismData = res.status === 'fulfilled' && res.value?.success ? res.value.report : null;
      const snapshotsData = snapshotRes.status === 'fulfilled' && snapshotRes.value?.success ? snapshotRes.value : null;

      if (journalismData) {
        journalismData.snapshotInfo = snapshotsData;
        this.renderJournalismReport(journalismData);
        if (initialFilter && searchInput) {
          searchInput.focus();
        }
      } else {
        container.innerHTML = '<div style="text-align:center; padding:2rem; color:var(--text-muted);">No hi ha prou dades de retards registrades encara. El servidor està capturant la telemetria contínua.</div>';
      }
    } catch(err) {
      container.innerHTML = `<div style="text-align:center; padding:2rem; color:var(--danger);">Error en carregar informe de periodisme: ${this.esc(err.message)}</div>`;
    }
  }

  closeJournalismModal() {
    const backdrop = document.getElementById('journalism-modal-backdrop');
    if (backdrop) backdrop.classList.remove('active');
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
      current.asc = columnKey === 'lineCode' || columnKey === 'agency' || columnKey === 'stopName';
    }
    this.journalismSorts[tableKey] = current;
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
    let mostDelayed = [...(report.rankingMostDelayed || [])].filter(l => (l.sampleCount || 0) > 0 || (l.avgDelay || 0) > 0);
    let worstStops = [...(report.rankingWorstStops || [])].filter(st => (st.arrivalCount || 0) > 0);
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
          <div style="font-size:1.6rem; font-weight:700; color:#38bdf8; margin-top:0.2rem;">+${s.networkAvgDelay || 0} min</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">Puntualitat de referència</div>
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:0.9rem;">
          <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase;">Retard Màxim Registrat</div>
          <div style="font-size:1.6rem; font-weight:700; color:#ef4444; margin-top:0.2rem;">+${s.networkMaxDelay || 0} min</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">Afectació puntual extrema</div>
        </div>
      </div>

      <!-- Ranking: Most Delayed Lines -->
      <div style="margin-bottom:1.5rem;">
        <h4 style="font-size:0.95rem; font-weight:700; margin-bottom:0.6rem; display:flex; align-items:center; justify-content:space-between;">
          <span style="display:flex; align-items:center; gap:0.4rem;">🚨 Línies amb Més Retard Acumulat</span>
          <span style="font-size:0.75rem; font-weight:400; color:var(--text-muted);">Clica a les capçaleres per ordenar ↕</span>
        </h4>
        ${mostDelayed.length === 0 ? '<div style="color:var(--text-muted); font-size:0.85rem; padding:0.8rem; background:var(--bg-elevated); border-radius:8px;">Sense retards registrats o cap línia coincideix amb el filtre.</div>' : `
          <div style="border:1px solid var(--border-subtle); border-radius:10px; overflow:hidden;">
            <table style="width:100%; border-collapse:collapse; font-size:0.83rem; text-align:left;">
              <thead>
                <tr style="background:var(--bg-surface); border-bottom:1px solid var(--border-subtle); color:var(--text-muted); font-size:0.72rem; text-transform:uppercase;">
                  <th onclick="window.transitApp.handleJournalismSort('mostDelayed', 'lineCode')" style="padding:0.6rem 0.8rem; cursor:pointer; user-select:none;">Línia ${getSortIndicator('mostDelayed', 'lineCode')}</th>
                  <th onclick="window.transitApp.handleJournalismSort('mostDelayed', 'agency')" style="padding:0.6rem 0.8rem; cursor:pointer; user-select:none;">Operador ${getSortIndicator('mostDelayed', 'agency')}</th>
                  <th onclick="window.transitApp.handleJournalismSort('mostDelayed', 'avgDelay')" style="padding:0.6rem 0.8rem; cursor:pointer; user-select:none;">Retard Mitjà ${getSortIndicator('mostDelayed', 'avgDelay')}</th>
                  <th onclick="window.transitApp.handleJournalismSort('mostDelayed', 'maxDelay')" style="padding:0.6rem 0.8rem; cursor:pointer; user-select:none;">Retard Màx. ${getSortIndicator('mostDelayed', 'maxDelay')}</th>
                  <th onclick="window.transitApp.handleJournalismSort('mostDelayed', 'latePercentage')" style="padding:0.6rem 0.8rem; cursor:pointer; user-select:none;">% Expedicions Tardanes ${getSortIndicator('mostDelayed', 'latePercentage')}</th>
                </tr>
              </thead>
              <tbody>
                ${mostDelayed.map((l, i) => `
                  <tr onclick="window.transitApp.closeJournalismModal(); window.transitApp.switchLine('${this.jsSafe(l.lineId || l.lineCode)}');" style="border-bottom:1px solid var(--border-subtle); background:${i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)'}; cursor:pointer;" title="Clica per veure la línia ${this.esc(l.lineCode)} al mapa">
                    <td style="padding:0.6rem 0.8rem; font-weight:700; color:var(--brand-primary);">
                      <span style="background:${this.esc(l.color || 'var(--brand-primary)')}; color:#fff; padding:0.15rem 0.45rem; border-radius:6px; margin-right:0.4rem; font-size:0.75rem; display:inline-block;">${this.esc(l.lineCode)}</span>
                      <span style="font-size:0.78rem; color:var(--text-secondary); font-weight:500;">${l.name && l.name !== l.lineCode ? this.esc(l.name) : ''}</span>
                    </td>
                    <td style="padding:0.6rem 0.8rem; color:var(--text-muted);">${this.esc(l.agency)}</td>
                    <td style="padding:0.6rem 0.8rem; font-weight:700; color:#ef4444;">+${l.avgDelay} min</td>
                    <td style="padding:0.6rem 0.8rem; color:var(--text-muted);">+${l.maxDelay} min</td>
                    <td style="padding:0.6rem 0.8rem;">
                      <span style="background:rgba(239,68,68,0.15); color:#f87171; padding:0.15rem 0.45rem; border-radius:6px; font-weight:600;">${l.latePercentage}%</span>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>

      <!-- Ranking: Worst Stops (Bottlenecks) -->
      <div style="margin-bottom:1.5rem;">
        <h4 style="font-size:0.95rem; font-weight:700; margin-bottom:0.6rem; display:flex; align-items:center; justify-content:space-between;">
          <span style="display:flex; align-items:center; gap:0.4rem;">📍 Colls d'Ampolla: Parades amb Més Retard</span>
          <span style="font-size:0.75rem; font-weight:400; color:var(--text-muted);">Clica a les capçaleres per ordenar ↕</span>
        </h4>
        ${worstStops.length === 0 ? '<div style="color:var(--text-muted); font-size:0.85rem; padding:0.8rem; background:var(--bg-elevated); border-radius:8px;">Sense punts negres registrats o cap parada coincideix amb el filtre.</div>' : `
          <div style="border:1px solid var(--border-subtle); border-radius:10px; overflow:hidden;">
            <table style="width:100%; border-collapse:collapse; font-size:0.83rem; text-align:left;">
              <thead>
                <tr style="background:var(--bg-surface); border-bottom:1px solid var(--border-subtle); color:var(--text-muted); font-size:0.72rem; text-transform:uppercase;">
                  <th onclick="window.transitApp.handleJournalismSort('worstStops', 'stopName')" style="padding:0.6rem 0.8rem; cursor:pointer; user-select:none;">Parada (Punt Negre) ${getSortIndicator('worstStops', 'stopName')}</th>
                  <th onclick="window.transitApp.handleJournalismSort('worstStops', 'lineCode')" style="padding:0.6rem 0.8rem; cursor:pointer; user-select:none;">Línia ${getSortIndicator('worstStops', 'lineCode')}</th>
                  <th onclick="window.transitApp.handleJournalismSort('worstStops', 'agency')" style="padding:0.6rem 0.8rem; cursor:pointer; user-select:none;">Operador ${getSortIndicator('worstStops', 'agency')}</th>
                  <th onclick="window.transitApp.handleJournalismSort('worstStops', 'avgDelay')" style="padding:0.6rem 0.8rem; cursor:pointer; user-select:none;">Retard Mitjà ${getSortIndicator('worstStops', 'avgDelay')}</th>
                  <th onclick="window.transitApp.handleJournalismSort('worstStops', 'maxDelay')" style="padding:0.6rem 0.8rem; cursor:pointer; user-select:none;">Retard Màx. ${getSortIndicator('worstStops', 'maxDelay')}</th>
                  <th onclick="window.transitApp.handleJournalismSort('worstStops', 'severeLatePct')" style="padding:0.6rem 0.8rem; cursor:pointer; user-select:none;">% Retards Greus ${getSortIndicator('worstStops', 'severeLatePct')}</th>
                </tr>
              </thead>
              <tbody>
                ${worstStops.map((st, i) => `
                  <tr style="border-bottom:1px solid var(--border-subtle); background:${i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)'};">
                    <td style="padding:0.6rem 0.8rem; font-weight:600; color:var(--text-primary);">
                      <div style="display:flex; align-items:center; gap:0.4rem;">
                        <span style="color:#f59e0b;">📍</span>
                        <span>${this.esc(st.stopName)}</span>
                      </div>
                    </td>
                    <td style="padding:0.6rem 0.8rem; font-weight:700; color:var(--brand-primary);">${this.esc(st.lineCode)}</td>
                    <td style="padding:0.6rem 0.8rem; color:var(--text-muted);">${this.esc(st.agency)}</td>
                    <td style="padding:0.6rem 0.8rem; font-weight:700; color:#ef4444;">+${st.avgDelay} min</td>
                    <td style="padding:0.6rem 0.8rem; color:var(--text-muted);">+${st.maxDelay} min</td>
                    <td style="padding:0.6rem 0.8rem;">
                      <span style="background:${st.severeLatePct >= 30 ? 'rgba(239,68,68,0.2)' : 'rgba(245,158,11,0.15)'}; color:${st.severeLatePct >= 30 ? '#f87171' : '#fbbf24'}; padding:0.15rem 0.45rem; border-radius:6px; font-weight:600;">${st.severeLatePct}%</span>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>

      <!-- Ranking: Operators Performance -->
      <div style="margin-bottom:1.5rem;">
        <h4 style="font-size:0.95rem; font-weight:700; margin-bottom:0.6rem; display:flex; align-items:center; justify-content:space-between;">
          <span style="display:flex; align-items:center; gap:0.4rem;">🏢 Comparativa per Empresa Operadora</span>
          <span style="font-size:0.75rem; font-weight:400; color:var(--text-muted);">Clica a les capçaleres per ordenar ↕</span>
        </h4>
        ${agencies.length === 0 ? '<div style="color:var(--text-muted); font-size:0.85rem; padding:0.8rem; background:var(--bg-elevated); border-radius:8px;">Recopilant mostres d\'operadors...</div>' : `
          <div style="border:1px solid var(--border-subtle); border-radius:10px; overflow:hidden;">
            <table style="width:100%; border-collapse:collapse; font-size:0.83rem; text-align:left;">
              <thead>
                <tr style="background:var(--bg-surface); border-bottom:1px solid var(--border-subtle); color:var(--text-muted); font-size:0.72rem; text-transform:uppercase;">
                  <th onclick="window.transitApp.handleJournalismSort('agencies', 'agency')" style="padding:0.6rem 0.8rem; cursor:pointer; user-select:none;">Empresa ${getSortIndicator('agencies', 'agency')}</th>
                  <th onclick="window.transitApp.handleJournalismSort('agencies', 'linesCount')" style="padding:0.6rem 0.8rem; cursor:pointer; user-select:none;">Línies ${getSortIndicator('agencies', 'linesCount')}</th>
                  <th onclick="window.transitApp.handleJournalismSort('agencies', 'totalSamples')" style="padding:0.6rem 0.8rem; cursor:pointer; user-select:none;">Mostres ${getSortIndicator('agencies', 'totalSamples')}</th>
                  <th onclick="window.transitApp.handleJournalismSort('agencies', 'avgDelay')" style="padding:0.6rem 0.8rem; cursor:pointer; user-select:none;">Retard Mitjà ${getSortIndicator('agencies', 'avgDelay')}</th>
                  <th onclick="window.transitApp.handleJournalismSort('agencies', 'onTimePct')" style="padding:0.6rem 0.8rem; cursor:pointer; user-select:none;">Índex de Puntualitat ${getSortIndicator('agencies', 'onTimePct')}</th>
                </tr>
              </thead>
              <tbody>
                ${agencies.map((a, i) => `
                  <tr style="border-bottom:1px solid var(--border-subtle); background:${i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)'};">
                    <td style="padding:0.6rem 0.8rem; font-weight:600;">${this.esc(a.agency)}</td>
                    <td style="padding:0.6rem 0.8rem; color:var(--text-muted);">${a.linesCount}</td>
                    <td style="padding:0.6rem 0.8rem; color:var(--text-muted);">${a.totalSamples}</td>
                    <td style="padding:0.6rem 0.8rem; font-weight:700; color:${a.avgDelay > 3 ? '#ef4444' : '#10b981'};">+${a.avgDelay} min</td>
                    <td style="padding:0.6rem 0.8rem;">
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

  renderTargetCardLoading(lData, stopName = 'Parada seleccionada') {
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
    if (codeEl) codeEl.textContent = '...';
    if (dirSubEl) dirSubEl.textContent = 'Sincronitzant horaris...';
    if (lineTagEl && lData) {
      lineTagEl.textContent = lData.code || lData.id || 'C-10';
      if (lData.color) lineTagEl.style.color = lData.color;
    }
    if (destEl) destEl.textContent = 'Sincronitzant...';
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
    const next = data.nextBus || null;

    if (titleEl) titleEl.textContent = stop.name || 'Parada';
    if (codeEl) codeEl.textContent = stop.code || stop.id || '--';
    if (dirSubEl) {
      if (data.calendarInfo?.calendarTag) {
        dirSubEl.innerHTML = `${data.directionName || 'En servei'} • <span style="color:#38bdf8; font-weight:600;">📅 ${data.calendarInfo.calendarTag}</span>`;
      } else {
        dirSubEl.textContent = data.directionName || 'En servei';
      }
    }

    if (lineTagEl) {
      lineTagEl.textContent = lData.code || lData.id || 'C-10';
      if (lData.color) lineTagEl.style.color = lData.color;
    }

    if (destEl) destEl.textContent = next?.destination || data.directionName || 'Destí';
    if (opEl) opEl.textContent = lData.agency || 'Operador de Transport';

    if (mapsLinkEl && stop.lat && stop.lon) {
      mapsLinkEl.href = `https://www.google.com/maps/search/?api=1&query=${stop.lat},${stop.lon}`;
    }

    this.renderEtaDisplay(next, etaBigEl, etaClockEl, etaPillEl, etaStatusText);
    this.renderDeparturesInto('departures-list-container', 'dep-count-badge', data.upcomingDepartures || []);
  }

  renderEtaDisplay(next, etaBigEl, etaClockEl, etaPillEl, etaStatusText) {
    if (next) {
      const clockTime = (next.expectedIso && !next.expectedIso.startsWith('0001-') && !next.expectedIso.startsWith('1970-'))
        ? new Date(next.expectedIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
        : (next.departureTime || '--:--');

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

        const schedTime = next.aimedIso
          ? new Date(next.aimedIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
          : (next.departureTime || null);
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
          if (next.delayStatus === 'regulating' || next.isRegulating || next.isTerminalLayover) {
            etaPillEl.classList.add('regulating');
            etaStatusText.textContent = 'Regulant a capçalera';
          } else if (next.delayStatus === 'delayed') {
            etaPillEl.classList.add('delayed');
            const cleanDelay = (next.delayBadgeText || '+2 min').replace(/retard/gi, '').trim();
            etaStatusText.textContent = `Retard (${cleanDelay})`;
          } else if (next.delayStatus === 'early') {
            etaPillEl.classList.add('early');
            const cleanEarly = (next.delayBadgeText || '-2 min').replace(/avançat/gi, '').trim();
            etaStatusText.textContent = `Avançat (${cleanEarly})`;
          } else {
            etaPillEl.classList.add('live');
            etaStatusText.textContent = next.isRealTime ? 'Temps Real Actiu' : (next.isEstimated ? 'Estimació en Circuit' : 'Horari Teòric');
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

    const itemsHtml = departures.map((dep, idx) => {
      const rawTime = (dep.expectedIso && !dep.expectedIso.startsWith('0001-') && !dep.expectedIso.startsWith('1970-'))
        ? new Date(dep.expectedIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
        : (dep.departureTime || '--:--');
      const clockTime = String(rawTime).replace(/^[A-Za-zÀ-ÿ\.]+\s*(a\s*les\s*)?/i, '').trim();

      const rawSched = dep.scheduledTime ||
        ((dep.aimedIso && !dep.isEstimated && !dep.aimedIso.startsWith('0001-') && !dep.aimedIso.startsWith('1970-'))
          ? new Date(dep.aimedIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
          : (dep.isRealTime && dep.scheduledTime ? dep.scheduledTime : null));
      const schedTime = rawSched ? String(rawSched).replace(/^[A-Za-zÀ-ÿ\.]+\s*(a\s*les\s*)?/i, '').trim() : null;

      const isTomorrow = dep.isToday === false && !dep.isRealTime && !dep.isEstimated;
      const isFirstMorning = isTomorrow && (dep.isFirstOfDay === true || idx === 0) && !dep.isRealTime && !dep.isEstimated;
      const isFirstToday = dep.isToday === true && dep.isFirstOfDay === true && !dep.isRealTime && !dep.isEstimated;
      const isDiff = schedTime && schedTime !== clockTime && !dep.isEstimated;
      const rawDelayMins = dep.delayMins !== undefined && dep.delayMins !== null ? Number(dep.delayMins) : 0;
      const delayText = rawDelayMins >= 2
        ? `+${rawDelayMins} min retard`
        : (rawDelayMins <= -2 ? `${Math.abs(rawDelayMins)} min avançat` : 'Puntual');

      const matchedBus = this.resolveBusForDeparture(dep, targetStopSeq, targetStopId, idx);
      const resolvedVehicleId = matchedBus?.vehicleId || matchedBus?.tripId || dep.vehicleId || '';
      const resolvedLat = matchedBus?.lat || dep.busCoords?.lat || '';
      const resolvedLon = matchedBus?.lon || dep.busCoords?.lon || '';
      const hasActiveBus = Boolean(resolvedVehicleId || (resolvedLat && resolvedLon) || dep.tripId || dep.isRealTime || dep.isEstimated || (this.activeLineData?.activeBuses?.length > 0 && dep.minutesAway <= 60));

      const minsText = isFirstMorning
        ? `🌅 Demà ${clockTime}`
        : (isTomorrow
            ? `Demà ${clockTime}`
            : (isFirstToday && (dep.minutesAway === undefined || dep.minutesAway > 180)
                ? `🌅 ${clockTime}`
                : ((dep.minutesAway !== undefined && dep.minutesAway >= 0 && dep.minutesAway <= 180)
                    ? (dep.minutesAway <= 0 ? 'Ara' : (dep.minutesAway === 1 ? '1 min' : `${dep.minutesAway} min`))
                    : `${clockTime}`)));

      const isRegulating = Boolean(dep.delayStatus === 'regulating' || dep.isRegulating || dep.isTerminalLayover);
      const tagLabel = isRegulating
        ? '⏱️ En Regulació'
        : ((isFirstMorning || isFirstToday)
          ? '🌅 1r Servei'
          : (isTomorrow ? 'Programat' : (dep.isEstimated ? '⚡ En ruta' : (dep.isRealTime ? '🟢 Temps Real' : 'Programat'))));

      const pillLabel = isRegulating
        ? (dep.delayBadgeText || '⏱️ Regulació')
        : ((isFirstMorning || isFirstToday)
          ? '1r Servei'
          : (isTomorrow ? 'Programat' : (dep.isEstimated ? '⚡ En ruta' : (dep.delayBadgeText || 'Puntual'))));

      const pillClass = isRegulating
        ? 'regulating'
        : ((isTomorrow || isFirstToday) ? 'scheduled' : (rawDelayMins >= 2 ? 'delayed' : (rawDelayMins <= -2 ? 'early' : (dep.delayStatus || 'on-time'))));

      return `
        <div class="departure-item ${idx === 0 ? 'highlight-next' : ''} ${hasActiveBus ? 'clickable-bus-dep' : ''}"
             data-vehicle-id="${this.esc(resolvedVehicleId)}"
             data-bus-lat="${this.esc(resolvedLat)}"
             data-bus-lon="${this.esc(resolvedLon)}"
             data-stop-seq="${targetStopSeq || ''}"
             data-stop-id="${targetStopId || ''}"
             data-dep-index="${idx}"
             title="${hasActiveBus ? 'Fes clic per localitzar aquest autobús en directe al mapa' : ''}">
          <div class="dep-time-group">
            <div class="dep-time-row">
              <span class="dep-clock">${clockTime}</span>
              ${isDiff ? `<span class="dep-sched-pill" title="Horari oficial teòric">Oficial: ${schedTime}</span>` : ''}
              <span class="dep-tag-sub ${(isFirstMorning || isFirstToday) ? 'first-service' : ''}">${tagLabel}</span>
            </div>
            <div class="dep-dest">
              Cap a <strong>${this.esc((dep.destination || 'Destí').replace(/^Cap a\s+/i, ''))}</strong>
            </div>
            <div class="dep-time-sub">
              ${isFirstMorning
                ? `<span>📅 Primer autobús del matí (Demà a les ${clockTime})</span>`
                : (isFirstToday
                    ? `<span>📅 Primer servei d'avui (a les ${clockTime})</span>`
                    : (isTomorrow
                        ? `<span>📅 Horari teòric: <strong class="sched-strong">Demà a les ${clockTime}</strong></span>`
                        : (dep.isRealTime
                            ? (schedTime && isDiff
                                ? `<span>📅 Horari teòric: <strong class="sched-strong">${schedTime}</strong> <span class="dep-delay-note ${rawDelayMins >= 2 ? 'delay' : (rawDelayMins <= -2 ? 'early' : 'on-time')}">(${delayText})</span></span>`
                                : `<span>🟢 Arribada en temps real (SIRI Avanza)</span>`)
                            : (dep.isEstimated
                                ? `<span>⚡ Estimació de pas segons telemetria GPS</span>`
                                : `<span>📅 Horari teòric programat</span>`))))}
            </div>
          </div>
          <div class="dep-status">
            <span class="dep-mins" style="${(isFirstMorning || isFirstToday) ? 'color:#fbbf24;' : (isTomorrow ? 'color:#94a3b8;' : '')}">${minsText}</span>
            <span class="dep-delay-pill ${pillClass}">
              ${pillLabel}
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

    container.innerHTML = itemsHtml + footerHint;
  }

  // ==========================================
  // 4. TELEMETRY COCKPIT & VEHICLE SWITCHER
  // ==========================================

  renderTelemetryCockpit(lineData, targetData = null) {
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
          const label = b.vehicleId ? `Bus #${b.vehicleId}` : `Bus ${idx + 1}`;
          const isParked = b.isTerminalLayover;
          return `
            <button type="button" class="telemetry-bus-chip ${isSelected ? 'active' : ''}" data-bus-trip="${b.tripId || b.vehicleId}">
              <span>${isParked ? '🅿️' : '🚌'}</span>
              <span>${label}</span>
              <span style="font-size:0.68rem; opacity:0.8;">(${b.toStop || b.destination || 'En línia'})</span>
            </button>
          `;
        }).join('');

        chipsContainer.querySelectorAll('.telemetry-bus-chip').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            this.selectedVehicleId = btn.getAttribute('data-bus-trip');
            this.renderTelemetryCockpit(lineData, targetData);
            this.mapController?.highlightBus(this.selectedVehicleId, true);
          });
        });
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

    const isEst = Boolean(b.isEstimated);

    if (coordsEl) coordsEl.textContent = b.coordinatesFormatted || `${b.lat.toFixed(5)}° N, ${b.lon.toFixed(5)}° E`;
    if (bearingEl) bearingEl.textContent = `${b.compass?.label || 'N/A'} (${b.bearing || 0}°)`;
    if (speedEl) speedEl.textContent = `${b.speedKmh || 32} km/h`;
    if (segmentEl) segmentEl.textContent = `${b.fromStop || 'Origen'} ➔ ${b.toStop || 'Destí'}`;
    if (etaNextEl) etaNextEl.textContent = b.secondsToNextStop ? `~${Math.round(b.secondsToNextStop / 60)} min (${b.toStop})` : `${b.toStop || 'En trajecte'}`;
    if (tripStartEl) tripStartEl.textContent = b.tripStartTime || '--';
    
    const prog = Math.min(100, Math.max(0, b.totalProgress || 0));
    if (progressFill) progressFill.style.width = `${prog}%`;
    if (progressText) progressText.textContent = `${prog}%`;

    if (statusBadge) {
      statusBadge.textContent = b.statusText || (b.isTerminalLayover ? '🅿️ En Regulació' : isEst ? '⚡ Estimació Zona Cobertura' : '🟢 Senyal GPS Actiu');
      statusBadge.className = `telemetry-status-badge ${isEst ? 'estimated' : ''}`;
    }

    if (radarDot) {
      radarDot.className = `telemetry-live-radar ${isEst ? 'dead-zone' : ''}`;
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

    if (isBoth && allDirs && allDirs.length > 1) {
      container.classList.add('multi-dir-grid');
      const activeBuses = lineData.activeBuses || [];
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
          </div>
        `;
      }).join('');
    } else {
      container.classList.remove('multi-dir-grid');
      const stops = lineData.stops || [];
      if (stops.length === 0) return;

      const activeBuses = lineData.activeBuses || [];
      const primaryBus = activeBuses[0] || null;

      container.innerHTML = `
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
      `;
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

  renderStopsBrowser(lineDataOrStops, lineKey) {
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
                return `
                  <div class="stop-row-item ${isTarget ? 'target-stop' : ''}" data-stop-id="${id}" data-stop-name="${this.esc(s.name)}" data-dir-id="${d.dirId}">
                    <div class="stop-row-left">
                      <span class="stop-seq-badge">#${i + 1}</span>
                      <div>
                        <div class="stop-row-name">${this.esc(s.name)} ${isTarget ? '⭐' : ''}</div>
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
        return `
          <div class="stop-row-item ${isTarget ? 'target-stop' : ''}" data-stop-id="${id}" data-stop-name="${this.esc(s.name)}">
            <div class="stop-row-left">
              <span class="stop-seq-badge">#${i + 1}</span>
              <div>
                <div class="stop-row-name">${this.esc(s.name)} ${isTarget ? '⭐' : ''}</div>
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
    this.targetStopsByLine[routeKey] = String(stopId);
    this.targetStopsByLine[this.activeLineId] = String(stopId);
    localStorage.setItem('bad_amb_target_stops', JSON.stringify(this.targetStopsByLine));
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

    // Silent background fetch / SWR revalidation
    try {
      let fetchDirection = this.activeDirection;
      if (String(fetchDirection) === 'both' && this._resolvedStopDirection) {
        fetchDirection = this._resolvedStopDirection;
      }
      const endpoint = `/api/line/${this.activeLineId}/stop/${stopId}/departures?direction=${fetchDirection}`;
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

    const modalItemsHtml = deps.map((d, idx) => {
      const rawTime = (d.expectedIso && !d.expectedIso.startsWith('0001-') && !d.expectedIso.startsWith('1970-'))
        ? new Date(d.expectedIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
        : (d.departureTime || '--:--');
      const estTime = String(rawTime).replace(/^[A-Za-zÀ-ÿ\.]+\s*(a\s*les\s*)?/i, '').trim();

      const rawSched = d.scheduledTime ||
        ((d.aimedIso && !d.isEstimated && !d.aimedIso.startsWith('0001-') && !d.aimedIso.startsWith('1970-'))
          ? new Date(d.aimedIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
          : (d.isRealTime && d.scheduledTime ? d.scheduledTime : null));
      const schedTime = rawSched ? String(rawSched).replace(/^[A-Za-zÀ-ÿ\.]+\s*(a\s*les\s*)?/i, '').trim() : null;

      const isTomorrow = d.isToday === false && !d.isRealTime && !d.isEstimated;
      const isFirstMorning = isTomorrow && (d.isFirstOfDay === true || idx === 0) && !d.isRealTime && !d.isEstimated;
      const isFirstToday = d.isToday === true && d.isFirstOfDay === true && !d.isRealTime && !d.isEstimated;

      const isDiff = schedTime && schedTime !== estTime && !d.isEstimated;
      const rawDelayMins = d.delayMins !== undefined && d.delayMins !== null ? Number(d.delayMins) : 0;
      const delayText = rawDelayMins >= 2
        ? `+${rawDelayMins} min retard`
        : (rawDelayMins <= -2 ? `${Math.abs(rawDelayMins)} min avançat` : 'Puntual');

      const matchedBus = this.resolveBusForDeparture(d, stopSeq, stopId, idx);
      const resolvedVehicleId = matchedBus?.vehicleId || matchedBus?.tripId || d.vehicleId || '';
      const resolvedLat = matchedBus?.lat || d.busCoords?.lat || '';
      const resolvedLon = matchedBus?.lon || d.busCoords?.lon || '';
      const hasActiveBus = Boolean(resolvedVehicleId || (resolvedLat && resolvedLon) || d.tripId || d.isRealTime || d.isEstimated || (this.activeLineData?.activeBuses?.length > 0 && d.minutesAway <= 60));

      const minsText = isFirstMorning
        ? `🌅 Demà ${estTime}`
        : (isTomorrow
            ? `Demà ${estTime}`
            : (isFirstToday && (d.minutesAway === undefined || d.minutesAway > 180)
                ? `🌅 ${estTime}`
                : ((d.minutesAway !== undefined && d.minutesAway >= 0 && d.minutesAway <= 180)
                    ? (d.minutesAway <= 0 ? 'Ara' : (d.minutesAway === 1 ? '1 min' : `${d.minutesAway} min`))
                    : `${estTime}`)));

      const tagLabel = (isFirstMorning || isFirstToday)
        ? '🌅 1r Servei'
        : (isTomorrow ? 'Programat' : (d.isEstimated ? '⚡ En ruta' : (d.isRealTime ? '🟢 Temps Real' : 'Programat')));

      const pillLabel = (isFirstMorning || isFirstToday)
        ? '1r Servei'
        : (isTomorrow ? 'Programat' : (d.isEstimated ? '⚡ En ruta' : (d.delayBadgeText || 'Puntual')));

      const pillClass = (isTomorrow || isFirstToday) ? 'scheduled' : (rawDelayMins >= 2 ? 'delayed' : (rawDelayMins <= -2 ? 'early' : (d.delayStatus || 'on-time')));

      return `
        <div class="departure-item ${idx === 0 ? 'highlight-next' : ''} ${hasActiveBus ? 'clickable-bus-dep' : ''}"
             data-vehicle-id="${this.esc(resolvedVehicleId)}"
             data-bus-lat="${this.esc(resolvedLat)}"
             data-bus-lon="${this.esc(resolvedLon)}"
             data-stop-seq="${stopSeq || ''}"
             data-stop-id="${this.esc(stopId || '')}"
             data-dep-index="${idx}"
             title="${hasActiveBus ? 'Fes clic per localitzar aquest autobús en directe al mapa' : ''}">
          <div class="dep-time-group">
            <div class="dep-time-row">
              <span class="dep-clock">${estTime}</span>
              ${isDiff ? `<span class="dep-sched-pill" title="Horari oficial teòric">Oficial: ${schedTime}</span>` : ''}
              <span class="dep-tag-sub ${(isFirstMorning || isFirstToday) ? 'first-service' : ''}">${tagLabel}</span>
            </div>
            
            <div class="dep-dest">
              ${d.lineId ? `<span class="line-badge-sm" style="font-size:0.68rem; padding:1px 5px; margin-right:4px; background:var(--c10-primary);">${this.esc(d.lineId)}</span>` : ''}
              Cap a <strong>${this.esc((d.destination || 'Destí').replace(/^Cap a\s+/i, ''))}</strong>
            </div>

            <div class="dep-time-sub">
              ${isFirstMorning ? `
                <span>📅 Primer autobús del matí (Demà a les ${estTime})</span>
              ` : (isFirstToday ? `
                <span>📅 Primer servei d'avui (a les ${estTime})</span>
              ` : (isTomorrow ? `
                <span>📅 Horari teòric: <strong class="sched-strong">Demà a les ${estTime}</strong></span>
              ` : (d.isRealTime ? (
                schedTime && isDiff
                  ? `<span>📅 Horari teòric: <strong class="sched-strong">${schedTime}</strong> <span class="dep-delay-note ${rawDelayMins >= 2 ? 'delay' : (rawDelayMins <= -2 ? 'early' : 'on-time')}">(${delayText})</span></span>`
                  : `<span>🟢 Arribada en temps real (SIRI Avanza)</span>`
              ) : (d.isEstimated ? `
                <span>⚡ Estimació de pas segons telemetria GPS</span>
              ` : `<span>📅 Horari teòric programat</span>`))))}
            </div>
          </div>

          <div class="dep-status">
            <span class="dep-mins" style="${isFirstMorning ? 'color:#fbbf24;' : (isTomorrow ? 'color:#94a3b8;' : '')}">${minsText}</span>
            <span class="dep-delay-pill ${pillClass}" title="${this.esc(d.delayBadgeText || pillLabel)}">${this.esc(pillLabel)}</span>
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

    dropdown.querySelectorAll('.search-result-item').forEach(item => {
      item.addEventListener('click', async (e) => {
        e.preventDefault();
        const type = item.getAttribute('data-type');
        const lineId = item.getAttribute('data-line-id');
        dropdown.classList.remove('active');
        input.value = '';

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
    });
  }

  // ==========================================
  // 9. EVENT LISTENERS & MAP CONTROLS
  // ==========================================

  setupEventListeners() {
    this.setupPageVisibility();

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

    // Corridor Steps Timeline delegation
    document.addEventListener('click', (e) => {
      const step = e.target.closest('.corridor-step');
      if (step) {
        e.preventDefault();
        const targetId = step.getAttribute('data-target-id');
        if (targetId) {
          this.setTargetStop(targetId);
        }
      }
    });

    // Direction selection action buttons delegation (from Stops Browser, Header Pills, Toolbar & Timeline)
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-select-dir-view, .btn-timeline-select-dir, .btn-stops-card-pill, .btn-stops-dir-tab');
      if (btn) {
        e.preventDefault();
        const dirId = btn.getAttribute('data-dir-id');
        if (dirId && dirId !== this.activeDirection) {
          this.switchDirection(dirId);
        }
      }
    });

    // Direction Jump Navigator Buttons delegation (smooth scroll inside stops browser)
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-dir-jump');
      if (btn) {
        e.preventDefault();
        const targetId = btn.getAttribute('data-dir-target');
        if (targetId) {
          const targetEl = document.getElementById(targetId);
          if (targetEl) {
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
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

    // Target Stop Dropdown
    document.getElementById('target-stop-select')?.addEventListener('change', (e) => {
      if (e.target.value) this.setTargetStop(e.target.value);
    });

    // Click departure item to focus bus on map delegation
    document.addEventListener('click', (e) => {
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

    // Filter Stops Browser Input with smart multi-direction section support
    document.getElementById('stop-search-input')?.addEventListener('input', (e) => {
      const q = (e.target.value || '').toLowerCase().trim();
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
    });

    // Back to Landing / Home Navigation Buttons
    document.getElementById('btn-header-home')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.navigateToLanding();
    });

    document.getElementById('header-logo-group')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.navigateToLanding();
    });

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
    const backdrop = document.getElementById('journalism-modal-backdrop');
    const closeBtn = document.getElementById('journalism-modal-close-btn');

    openBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      this.openJournalismModal(24);
    });

    closeBtn?.addEventListener('click', () => {
      backdrop?.classList.remove('active');
    });

    backdrop?.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        backdrop.classList.remove('active');
      }
    });

    document.querySelectorAll('#journalism-timeframe-tabs button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelectorAll('#journalism-timeframe-tabs button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const hours = parseInt(btn.getAttribute('data-hours') || '24', 10);
        this.openJournalismModal(hours);
      });
    });

    const searchInput = document.getElementById('journalism-search-input');
    searchInput?.addEventListener('input', (e) => {
      this.journalismFilterText = e.target.value;
      if (this.currentJournalismReport) {
        this.renderJournalismReport(this.currentJournalismReport);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && backdrop?.classList.contains('active')) {
        backdrop.classList.remove('active');
      }
    });
  }

  // ==========================================
  // MAP RESIZE CONTROLS
  // ==========================================

  setupMapResizeControls() {
    const expandHeightBtn = document.getElementById('btn-map-expand-height');
    const heightLabel = document.getElementById('map-height-label');
    const expandWidthBtn = document.getElementById('btn-map-expand-width');
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

    let isTall = false;
    expandHeightBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      isTall = !isTall;
      if (mapContainer) {
        mapContainer.style.height = isTall ? '580px' : '380px';
      }
      if (heightLabel) heightLabel.textContent = isTall ? 'Normal' : 'Gran';
      animateResize(380);
    });

    let isFullWidth = false;
    expandWidthBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      isFullWidth = !isFullWidth;
      explorerGrid?.classList.toggle('expanded-width', isFullWidth);
      expandWidthBtn.classList.toggle('active', isFullWidth);
      animateResize(380);
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
        if (this.activeLineId) {
          this.refreshAllData(false);
        }
      } else if (!this.isTabVisible) {
        // User switched to another of their 15 tabs: cancel RAF loop immediately to free up GPU & CPU RAM
        if (this.animFrameId) {
          cancelAnimationFrame(this.animFrameId);
          this.animFrameId = null;
        }
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

  startAutoRefresh() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      // Inactive Tab Sleep: Pause polling while tab is hidden to prevent continuous JSON parsing & memory churning
      if (!this.isTabVisible) {
        return;
      }
      this.secondsRemaining--;
      if (this.secondsRemaining <= 0) {
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
    if (headerEl) {
      if (count > 0) {
        const isEst = lData?.isEstimated || (this.activeBuses.length > 0 && this.activeBuses.every(b => b.isEstimated));
        headerEl.innerHTML = isEst 
          ? `⚡ <strong>${count}</strong> estimat${count === 1 ? '' : 's'}` 
          : `🟢 <strong>${count}</strong> en directe`;
      } else {
        headerEl.innerHTML = `🕒 <strong>0</strong> busos (horari teòric)`;
      }
    }
    if (mapEl) {
      if (count > 0) {
        const isEst = lData?.isEstimated || (this.activeBuses.length > 0 && this.activeBuses.every(b => b.isEstimated));
        mapEl.innerHTML = isEst
          ? `⚡ ${count} bus${count === 1 ? '' : 'os'} (estimat)`
          : `🟢 ${count} bus${count === 1 ? '' : 'os'} en directe`;
      } else {
        mapEl.innerHTML = `🕒 Horari programat (sense GPS)`;
      }
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
}

// Instantiate global application
window.addEventListener('DOMContentLoaded', () => {
  window.transitApp = new TransitApp();
});

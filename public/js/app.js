// Bad AMB Bus Tracker - Unified Multi-Page Application Controller
// Page 1: Interurbà (Line C-10 Barcelona ⇄ Mataró)
// Page 2: Urbà Mataró (Lines L1 to L8 Avanza)

class TransitApp {
  constructor() {
    this.currentPage = 'c10'; // 'c10' | 'mataro'
    this.activeMataroLineId = '1'; // '1'..'8'
    this.c10Direction = '1'; // '1' (to Mataró) | '0' (to Barcelona)
    this.mataroDirection = '0'; // '0' | '1'

    this.availableLines = [];
    this.activeLineData = null;
    
    this.targetStopsByLine = JSON.parse(localStorage.getItem('bad_amb_target_stops') || '{}');
    this.allStops = [];
    this.activeBuses = [];
    this.selectedVehicleIdByPage = { c10: null, mataro: null };

    this.pollInterval = 15;
    this.secondsRemaining = this.pollInterval;
    this.pollTimer = null;
    this.searchDebounceTimer = null;
    
    this.soundEnabled = localStorage.getItem('c10_sound') === 'true';
    this.audioContext = null;
    this.lastAlertedTrip = null;

    this.mapController = null;
    this.init();
  }

  async init() {
    console.log('🚀 Initializing Bad AMB Bus Tracker Mobile-First Engine...');

    try {
      // 1. Initialize Map
      this.mapController = new C10Map('map-container');

      // 2. Determine initial page from URL hash & sync DOM views
      this.parseUrlHash();
      this.syncPageViewsDOM();

      // 3. Setup DOM Listeners & Controls
      this.setupEventListeners();
      this.setupMapResizeControls();
      this.setupAudio();

      // 4. Load Available Lines & Render Navigation
      await this.fetchLines();

      // 5. Initial Data Fetch
      await this.refreshAllData(true);

      // 6. Start Polling & Animation Glider Loop
      this.startAutoRefresh();
      this.startAnimationLoop();
    } catch (err) {
      console.error('Fatal initialization error:', err);
    }
  }

  parseUrlHash() {
    const hash = window.location.hash.toLowerCase();
    if (hash.startsWith('#mataro')) {
      this.currentPage = 'mataro';
      const lineMatch = hash.match(/#mataro-?l?(\d+)/);
      if (lineMatch && lineMatch[1]) {
        this.activeMataroLineId = lineMatch[1];
      }
    } else {
      this.currentPage = 'c10';
    }
  }

  syncPageViewsDOM() {
    const pageId = this.currentPage;

    // Update Tab Buttons
    document.querySelectorAll('.nav-tab-btn').forEach(btn => {
      const isTarget = btn.getAttribute('data-page') === pageId;
      btn.classList.toggle('active', isTarget);
    });

    // Toggle Page Views
    const viewC10 = document.getElementById('view-c10');
    const viewMataro = document.getElementById('view-mataro');
    if (viewC10) viewC10.classList.toggle('active', pageId === 'c10');
    if (viewMataro) viewMataro.classList.toggle('active', pageId === 'mataro');

    // Update Header Brand & Selector Card
    this.updateHeaderBrand();
    this.updateLineSelectorCard();
  }

  // ==========================================
  // 1. PAGE NAVIGATION & TABS
  // ==========================================

  switchPage(pageId, mataroLineId = null) {
    this.currentPage = pageId;
    if (mataroLineId) {
      this.activeMataroLineId = String(mataroLineId);
    }

    // Update URL hash without page reload
    const newHash = pageId === 'mataro' ? `#mataro-l${this.activeMataroLineId}` : '#c10';
    if (window.location.hash !== newHash) {
      window.history.replaceState(null, '', newHash);
    }

    this.syncPageViewsDOM();

    // Refresh Data & Fit Map Bounds for the new page
    this.refreshAllData(true);
  }

  async fetchLines() {
    try {
      const res = await fetch('/api/lines');
      const json = await res.json();
      if (json.success && json.lines) {
        this.availableLines = json.lines;
        this.updateHeaderBrand();
        this.updateLineSelectorCard();
      }
    } catch (e) {
      console.error('Error fetching lines:', e);
    }
  }

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

    // Group lines by network / city
    const mataroLines = this.availableLines.filter(l => l.id !== 'c10');
    const maresmeLines = this.availableLines.filter(l => l.id === 'c10');

    const filterFn = (l) => {
      if (!q) return true;
      const code = (l.code || String(l.id)).toLowerCase();
      const name = (l.name || '').toLowerCase();
      const agency = (l.agency || '').toLowerCase();
      return code.includes(q) || name.includes(q) || agency.includes(q) || ('línia ' + code).includes(q) || ('linia ' + code).includes(q);
    };

    const filteredMataro = (cityFilter === 'all' || cityFilter === 'mataro') ? mataroLines.filter(filterFn) : [];
    const filteredMaresme = (cityFilter === 'all' || cityFilter === 'maresme') ? maresmeLines.filter(filterFn) : [];

    if (filteredMataro.length === 0 && filteredMaresme.length === 0) {
      container.innerHTML = `
        <div style="padding: 2.5rem 1rem; text-align: center; color: var(--text-muted);">
          <div style="font-size: 2rem; margin-bottom: 0.5rem;">🔍</div>
          <div style="font-weight: 700; color: #fff; margin-bottom: 0.25rem;">Cap línia trobada</div>
          <div style="font-size: 0.8rem;">No hi ha cap resultat per "${this.linePickerSearch}". Prova cercant per número (ex: 1, 7, C10) o destí.</div>
        </div>
      `;
      return;
    }

    let html = '';

    // Category 1: Mataró Urbà
    if (filteredMataro.length > 0) {
      html += `
        <div class="line-category-group">
          <div class="line-category-title">
            <span>📍 Xarxa Urbana de Mataró (${filteredMataro.length})</span>
          </div>
          <div class="line-grid">
            ${filteredMataro.map(l => {
              const isActive = this.currentPage === 'mataro' && String(l.id) === String(this.activeMataroLineId);
              const contrast = this.getContrastColor(l.color);
              return `
                <div class="line-grid-card ${isActive ? 'active' : ''}" data-line-id="${l.id}" data-page="mataro">
                  <div class="line-card-left">
                    <span class="line-card-badge" style="background:${l.color}; color:${contrast};">${l.code}</span>
                    <div class="line-card-details">
                      <div class="line-card-name">Línia ${l.code}: ${l.name}</div>
                      <div class="line-card-sub">
                        <span>📍 Mataró Bus</span>
                        <span>•</span>
                        <span>${l.directions ? l.directions.length : 2} sentits</span>
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
    }

    // Category 2: Maresme Interurbà
    if (filteredMaresme.length > 0) {
      html += `
        <div class="line-category-group">
          <div class="line-category-title">
            <span>🌊 Corredors Interurbans del Maresme (${filteredMaresme.length})</span>
          </div>
          <div class="line-grid">
            ${filteredMaresme.map(l => {
              const isActive = this.currentPage === 'c10';
              const contrast = this.getContrastColor(l.color);
              return `
                <div class="line-grid-card ${isActive ? 'active' : ''}" data-line-id="c10" data-page="c10">
                  <div class="line-card-left">
                    <span class="line-card-badge" style="background:${l.color}; color:${contrast};">${l.code}</span>
                    <div class="line-card-details">
                      <div class="line-card-name">${l.code}: ${l.name}</div>
                      <div class="line-card-sub">
                        <span>🌊 Casas / Moventis</span>
                        <span>•</span>
                        <span>Corredor N-II</span>
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
    }

    container.innerHTML = html;

    // Attach click listeners to cards
    container.querySelectorAll('.line-grid-card').forEach(card => {
      card.addEventListener('click', (e) => {
        e.preventDefault();
        const page = card.getAttribute('data-page');
        const lineId = card.getAttribute('data-line-id');
        this.closeLinePicker();

        if (page === 'c10') {
          this.switchPage('c10');
        } else {
          this.switchPage('mataro', lineId);
        }
      });
    });
  }

  setupLinePicker() {
    // Open Triggers
    document.getElementById('open-line-picker-btn')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.openLinePicker();
    });
    document.getElementById('open-line-picker-btn-c10')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.openLinePicker();
    });

    // Close Trigger
    document.getElementById('line-picker-close-btn')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.closeLinePicker();
    });

    // Backdrop click
    document.getElementById('line-picker-modal-backdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'line-picker-modal-backdrop') {
        this.closeLinePicker();
      }
    });

    // Search input
    const input = document.getElementById('line-picker-search-input');
    if (input) {
      input.addEventListener('input', () => {
        this.linePickerSearch = input.value;
        this.renderLinePicker();
      });
    }

    // Filter tabs
    const tabs = document.querySelectorAll('.line-filter-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.linePickerFilter = tab.getAttribute('data-city') || 'all';
        this.renderLinePicker();
      });
    });

    // Keyboard Shortcuts (Cmd/Ctrl + K or ESC)
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.openLinePicker();
      } else if (e.key === 'Escape') {
        this.closeLinePicker();
      }
    });
  }

  updateLineSelectorCard() {
    const badge = document.getElementById('mataro-active-line-badge');
    const title = document.getElementById('line-selector-active-title');
    const city = document.getElementById('line-selector-city-name');

    if (this.currentPage === 'c10') {
      if (badge) {
        badge.textContent = 'C10';
        badge.style.background = '#009485';
        badge.style.color = '#fff';
      }
      if (title) title.textContent = 'C-10 — Barcelona ⇄ Mataró (per N-II)';
      if (city) city.textContent = 'Corredor Interurbà Maresme';
    } else {
      const lineObj = this.availableLines.find(l => String(l.id) === String(this.activeMataroLineId)) || { code: `${this.activeMataroLineId}`, color: '#ff00ff', name: `Línia ${this.activeMataroLineId}` };
      if (badge) {
        badge.textContent = lineObj.code;
        badge.style.background = lineObj.color;
        badge.style.color = this.getContrastColor(lineObj.color);
      }
      if (title) title.textContent = `Línia ${lineObj.code} — ${lineObj.name}`;
      if (city) city.textContent = 'Xarxa Urbana de Mataró';
    }
  }

  switchMataroLine(lineId) {
    this.activeMataroLineId = String(lineId);
    this.mataroDirection = '0';
    window.history.replaceState(null, '', `#mataro-l${lineId}`);
    
    this.updateHeaderBrand();
    this.updateLineSelectorCard();
    this.refreshAllData(true);
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

  updateHeaderBrand() {
    const badge = document.getElementById('header-line-badge');
    const modeBadge = document.getElementById('header-mode-badge');
    const subtitle = document.getElementById('header-subtitle');
    const mapTitle = document.getElementById('map-line-title');

    if (this.currentPage === 'c10') {
      if (badge) {
        badge.textContent = 'C10';
        badge.style.background = '#009485';
        badge.style.color = '#ffffff';
      }
      if (modeBadge) {
        modeBadge.textContent = 'Interurbà';
        modeBadge.className = 'header-mode-badge interurba';
        modeBadge.style.background = 'rgba(0, 148, 133, 0.2)';
        modeBadge.style.color = '#2dd4bf';
        modeBadge.style.borderColor = 'rgba(0, 148, 133, 0.45)';
        modeBadge.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.25)';
      }
      if (subtitle) subtitle.textContent = 'Barcelona ↔ Badalona ↔ Maresme ↔ Mataró (per N-II)';
      if (mapTitle) mapTitle.textContent = 'Traçat del Corredor C-10 i parades';
    } else {
      const lineObj = this.availableLines.find(l => String(l.id) === String(this.activeMataroLineId)) || { code: `${this.activeMataroLineId}`, color: '#00ea00', name: `Línia ${this.activeMataroLineId}` };
      if (badge) {
        badge.textContent = lineObj.code;
        badge.style.background = lineObj.color;
        badge.style.color = this.getContrastColor(lineObj.color);
      }
      if (modeBadge) {
        modeBadge.textContent = 'Urbà Mataró';
        modeBadge.className = 'header-mode-badge urba';
        modeBadge.style.background = `rgba(${this.hexToRgb(lineObj.color)}, 0.22)`;
        modeBadge.style.color = '#ffffff';
        modeBadge.style.borderColor = lineObj.color;
        modeBadge.style.boxShadow = `0 0 12px rgba(${this.hexToRgb(lineObj.color)}, 0.35)`;
      }
      if (subtitle) subtitle.textContent = `Xarxa Urbana • Línia ${lineObj.code}: ${lineObj.name}`;
      if (mapTitle) mapTitle.textContent = `Traçat Línia ${lineObj.code} i parades`;
    }
  }

  // ==========================================
  // 2. DATA REFRESH ENGINE
  // ==========================================

  async refreshAllData(shouldFitBounds = false) {
    this.setLiveStatus('syncing');

    try {
      if (this.currentPage === 'c10') {
        await this.refreshC10Data(shouldFitBounds);
      } else {
        await this.refreshMataroData(shouldFitBounds);
      }

      this.setLiveStatus('online');
      this.secondsRemaining = this.pollInterval;
      this.updateCountdownLabel();
    } catch (err) {
      console.error('Data refresh error:', err);
      this.setLiveStatus('offline');
    }
  }

  // Refresh Interurbà (C-10)
  async refreshC10Data(shouldFitBounds = false) {
    const targetStopId = this.targetStopsByLine['c10'] || null;

    // Update active class on C-10 direction buttons without rebuilding DOM
    const dirBtn1 = document.getElementById('c10-dir-btn-1');
    const dirBtn0 = document.getElementById('c10-dir-btn-0');
    const dirBtnBoth = document.getElementById('c10-dir-btn-both');
    if (dirBtn1) dirBtn1.classList.toggle('active', this.c10Direction === '1');
    if (dirBtn0) dirBtn0.classList.toggle('active', this.c10Direction === '0');
    if (dirBtnBoth) dirBtnBoth.classList.toggle('active', this.c10Direction === 'both');

    if (this.c10Direction === 'both') {
      const [eta1, stops1, corr1, stops0, corr0] = await Promise.all([
        fetch(`/api/c10/target-eta?direction=1${targetStopId ? `&stopId=${targetStopId}` : ''}`).then(r => r.json()),
        fetch(`/api/c10/stops?direction=1`).then(r => r.json()),
        fetch(`/api/c10/live-corridor?direction=1`).then(r => r.json()),
        fetch(`/api/c10/stops?direction=0`).then(r => r.json()),
        fetch(`/api/c10/live-corridor?direction=0`).then(r => r.json())
      ]);

      this.allStops = stops1.stops || [];
      const secondaryStops = stops0.stops || [];
      this.activeBuses = [...(corr1.data?.activeBuses || []), ...(corr0.data?.activeBuses || [])];

      this.populateSelect('c10-target-stop-select', this.allStops, targetStopId || '10037202');
      this.renderStopsBrowser(this.allStops, 'c10');

      if (eta1.success && eta1.data) {
        this.renderC10TargetCard(eta1.data);
      }

      if (corr1.success && corr1.data) {
        this.renderC10Telemetry(corr1.data);
        this.renderC10CorridorTimeline(corr1.data);
      }
      this.updateActiveBusesCount(this.activeBuses.length);

      const activeTargetId = targetStopId || (eta1.data?.targetStop?.mouteStopId || '10037202');
      const p1Coords = this.allStops.map(s => [s.lat, s.lon]).filter(p => p[0] && p[1]);
      const p0Coords = secondaryStops.map(s => [s.lat, s.lon]).filter(p => p[0] && p[1]);

      this.mapController.renderStops(this.allStops, activeTargetId, (s) => this.inspectStop(s.mouteStopId, s.name), shouldFitBounds, '#009485', p1Coords, p0Coords, secondaryStops, '#f59e0b');
      this.mapController.updateBusMarkers(this.activeBuses, '#009485');
      return;
    }

    // 1. Target ETA
    const etaRes = await fetch(`/api/c10/target-eta?direction=${this.c10Direction}${targetStopId ? `&stopId=${targetStopId}` : ''}`).then(r => r.json());

    // 2. Stops Catalog
    const stopsRes = await fetch(`/api/c10/stops?direction=${this.c10Direction}`).then(r => r.json());

    // 3. Live Corridor Telemetry
    const corridorRes = await fetch(`/api/c10/live-corridor?direction=${this.c10Direction}`).then(r => r.json());

    if (stopsRes.success) {
      this.allStops = stopsRes.stops || [];
      this.populateSelect('c10-target-stop-select', this.allStops, targetStopId || '10037202');
      this.renderStopsBrowser(this.allStops, 'c10');
    }

    if (etaRes.success && etaRes.data) {
      this.renderC10TargetCard(etaRes.data);
    }

    if (corridorRes.success && corridorRes.data) {
      this.activeBuses = corridorRes.data.activeBuses || [];
      this.renderC10Telemetry(corridorRes.data);
      this.renderC10CorridorTimeline(corridorRes.data);
      this.updateActiveBusesCount(corridorRes.data.totalActiveBuses || 0);
      this.checkArrivalAlerts(corridorRes.data, 'c10');
    }

    // Map Render
    const activeTargetId = targetStopId || (etaRes.data?.targetStop?.mouteStopId || '10037202');
    this.mapController.renderStops(this.allStops, activeTargetId, (s) => this.inspectStop(s.mouteStopId, s.name), shouldFitBounds, '#009485');
    this.mapController.updateBusMarkers(this.activeBuses, '#009485');
  }

  // Refresh Urbà Mataró (1..8)
  async refreshMataroData(shouldFitBounds = false) {
    const lId = this.activeMataroLineId;
    const targetStopId = this.targetStopsByLine[lId] || null;

    const queryDir = this.mataroDirection === 'both' ? 'both' : this.mataroDirection;
    const etaQueryDir = this.mataroDirection === 'both' ? '0' : this.mataroDirection;

    // 1. Line details with SIRI live telemetry & dead-zone estimation
    const lineRes = await fetch(`/api/mataro/line/${lId}?direction=${queryDir}`).then(r => r.json());

    // 2. Target Stop ETA
    const etaRes = await fetch(`/api/mataro/target-eta?lineId=${lId}&direction=${etaQueryDir}${targetStopId ? `&stopId=${targetStopId}` : ''}`).then(r => r.json());

    if (lineRes.success && lineRes.data) {
      const lData = lineRes.data;
      this.activeLineData = lData;
      this.allStops = lData.stops || [];
      this.activeBuses = lData.activeBuses || [];

      // Direction buttons for Mataró Line
      const lineObj = this.availableLines.find(l => String(l.id) === String(lId));
      if (lineObj && lineObj.directions) {
        this.renderDirectionButtons('mataro-direction-toggle-group', lineObj.directions.map(d => ({ id: d.dirId, name: d.name })), this.mataroDirection);
      }

      // Populate Target Select & Browser
      const activeTargetId = targetStopId || (etaRes.data?.targetStop?.id || this.allStops[0]?.id);
      this.populateSelect('mataro-target-stop-select', this.allStops, activeTargetId);
      this.renderStopsBrowser(this.allStops, lId);

      // Render Telemetry & Timeline
      this.renderMataroTelemetry(lData);
      this.renderMataroTimeline(lData, activeTargetId);
      this.updateActiveBusesCount(lData.totalActiveBuses || 0);

      // Map Render with High-Res Road Polyline
      if (this.mataroDirection === 'both' && lData.allDirections && lData.allDirections.length > 1) {
        const d0 = lData.allDirections[0];
        const d1 = lData.allDirections[1];
        this.mapController.renderStops(d0.stops || this.allStops, activeTargetId, (s) => this.inspectStop(s.id, s.name), shouldFitBounds, lData.color, d0.polyline, d1.polyline, d1.stops, '#38bdf8');
        this.mapController.updateBusMarkers(this.activeBuses, lData.color, '#38bdf8');
      } else {
        this.mapController.renderStops(this.allStops, activeTargetId, (s) => this.inspectStop(s.id, s.name), shouldFitBounds, lData.color, lData.polyline);
        this.mapController.updateBusMarkers(this.activeBuses, lData.color);
      }
    }

    if (etaRes.success && etaRes.data) {
      this.renderMataroTargetCard(etaRes.data);
    }
  }

  renderDirectionButtons(containerId, directions, currentDir) {
    const container = document.getElementById(containerId);
    if (!container || !directions || directions.length === 0) return;

    let html = directions.map((d, i) => {
      const isActive = String(d.id) === String(currentDir);
      return `
        <button type="button" class="btn-direction ${isActive ? 'active' : ''}" data-dir-id="${d.id}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="${i === 0 ? 'm9 18 6-6-6-6' : 'm15 18-6-6 6-6'}"/></svg>
          <span>${d.name}</span>
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

  // ==========================================
  // 3. UI RENDERING FOR INTERURBÀ (C-10)
  // ==========================================

  renderC10TargetCard(data) {
    const titleEl = document.getElementById('c10-target-stop-title');
    const codeEl = document.getElementById('c10-target-stop-code');
    const dirSubEl = document.getElementById('c10-target-direction-sub');
    const etaBigEl = document.getElementById('c10-eta-big-display');
    const etaClockEl = document.getElementById('c10-eta-clock-display');
    const etaPillEl = document.getElementById('c10-eta-status-pill');
    const etaStatusText = document.getElementById('c10-eta-status-text');
    const destEl = document.getElementById('c10-next-bus-dest');
    const mapsLinkEl = document.getElementById('c10-target-maps-link');

    const stop = data.targetStop || {};
    const next = data.nextBus || null;

    if (titleEl) titleEl.textContent = stop.name || "Plaça d'Itàlia (Mataró)";
    if (codeEl) codeEl.textContent = stop.code || '121';
    if (dirSubEl) dirSubEl.textContent = data.directionName || 'Sentit Mataró';
    if (destEl) destEl.textContent = next?.destination || data.directionName || 'Hospital de Mataró';

    if (mapsLinkEl && stop.lat && stop.lon) {
      mapsLinkEl.href = `https://www.google.com/maps/search/?api=1&query=${stop.lat},${stop.lon}`;
    }

    this.renderEtaDisplay(next, etaBigEl, etaClockEl, etaPillEl, etaStatusText);
    this.renderDeparturesInto('c10-departures-list-container', 'c10-dep-count-badge', data.upcomingDepartures || []);
  }

  renderC10Telemetry(corridorData) {
    const buses = corridorData.activeBuses || [];
    const bar = document.getElementById('c10-telemetry-vehicles-bar');
    const chipsContainer = document.getElementById('c10-telemetry-vehicles-chips');

    if (buses.length > 0) {
      if (bar) bar.style.display = 'flex';
      
      const selectedId = this.selectedVehicleIdByPage['c10'];
      const activeBus = buses.find(b => String(b.tripId || b.vehicleId) === String(selectedId)) || buses[0];
      this.selectedVehicleIdByPage['c10'] = activeBus.tripId || activeBus.vehicleId;

      if (chipsContainer) {
        chipsContainer.innerHTML = buses.map((b, idx) => {
          const isSelected = String(b.tripId || b.vehicleId) === String(this.selectedVehicleIdByPage['c10']);
          const label = b.vehicleId ? `Bus #${b.vehicleId}` : `Bus ${idx + 1}`;
          const isParked = b.isTerminalLayover;
          return `
            <button type="button" class="telemetry-bus-chip ${isSelected ? 'active' : ''}" data-bus-trip="${b.tripId || b.vehicleId}">
              <span>${isParked ? '🅿️' : '🚌'}</span>
              <span>${label}</span>
              <span style="font-size:0.68rem; opacity:0.8;">(${b.fromStop ? b.toStop : 'En servei'})</span>
            </button>
          `;
        }).join('');

        chipsContainer.querySelectorAll('.telemetry-bus-chip').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            const tripId = btn.getAttribute('data-bus-trip');
            this.selectedVehicleIdByPage['c10'] = tripId;
            this.renderC10Telemetry(corridorData);
          });
        });
      }

      this.renderC10TelemetryFields(activeBus);
    } else {
      if (bar) bar.style.display = 'none';
      this.renderC10TelemetryFields(null);
    }
  }

  renderC10TelemetryFields(b) {
    const coordsEl = document.getElementById('c10-telemetry-coords');
    const bearingEl = document.getElementById('c10-telemetry-bearing');
    const speedEl = document.getElementById('c10-telemetry-speed');
    const segmentEl = document.getElementById('c10-telemetry-segment');
    const etaNextEl = document.getElementById('c10-telemetry-eta-next');
    const progressFill = document.getElementById('c10-telemetry-progress-bar');
    const progressText = document.getElementById('c10-telemetry-progress-text');
    const statusBadge = document.getElementById('c10-telemetry-status-badge');

    if (!b) {
      if (coordsEl) coordsEl.textContent = 'Sense vehicle actiu';
      if (bearingEl) bearingEl.textContent = '--';
      if (speedEl) speedEl.textContent = '0 km/h';
      if (segmentEl) segmentEl.textContent = 'Corredor N-II';
      if (etaNextEl) etaNextEl.textContent = '--';
      if (progressFill) progressFill.style.width = '0%';
      if (progressText) progressText.textContent = '0%';
      if (statusBadge) statusBadge.textContent = '⚪ Sense dades';
      return;
    }

    if (coordsEl) coordsEl.textContent = b.coordinatesFormatted || `${b.lat.toFixed(5)}° N, ${b.lon.toFixed(5)}° E`;
    if (bearingEl) bearingEl.textContent = `${b.compass?.label || 'N/A'} (${b.bearing || 0}°)`;
    if (speedEl) speedEl.textContent = `${b.speedKmh || 35} km/h`;
    if (segmentEl) segmentEl.textContent = `${b.fromStop} ➔ ${b.toStop}`;
    if (etaNextEl) etaNextEl.textContent = b.secondsToNextStop ? `~${Math.round(b.secondsToNextStop / 60)} min (${b.toStop})` : `${b.toStop}`;
    
    const prog = Math.min(100, Math.max(0, b.totalProgress || 0));
    if (progressFill) progressFill.style.width = `${prog}%`;
    if (progressText) progressText.textContent = `${prog}%`;

    if (statusBadge) {
      statusBadge.textContent = b.statusText || (b.isTerminalLayover ? '🅿️ En Regulació' : '🟢 Senyal GPS Actiu');
      statusBadge.className = 'telemetry-status-badge';
    }
  }

  renderC10CorridorTimeline(corridorData) {
    const container = document.getElementById('c10-corridor-timeline-container');
    const checkpoints = corridorData.checkpoints || [];
    if (!container || checkpoints.length === 0) return;

    const currentTargetId = this.targetStopsByLine['c10'] || '10037202';

    container.innerHTML = checkpoints.map((cp, idx) => {
      const isTarget = Boolean(currentTargetId && cp.id === currentTargetId);
      const isPassed = cp.isPassed;
      const hasBus = cp.hasBus;

      let nodeClass = 'step-node';
      let iconContent = `${idx + 1}`;

      if (hasBus) {
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
        <div class="corridor-step" data-target-id="${cp.id}" style="cursor:pointer;" title="Fixar ${cp.name} com a parada principal">
          <div class="${nodeClass}">
            <span>${iconContent}</span>
          </div>
          <div class="step-info">
            <span class="step-name">${cp.name}</span>
            <span class="step-eta">${cp.etaMinutes === 0 ? 'Ara' : `${cp.etaMinutes} min`}</span>
            <span class="step-zone">${cp.zone}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  // ==========================================
  // 4. UI RENDERING FOR URBÀ MATARÓ (1..8)
  // ==========================================

  renderMataroTargetCard(data) {
    const titleEl = document.getElementById('mataro-target-stop-title');
    const codeEl = document.getElementById('mataro-target-stop-code');
    const dirSubEl = document.getElementById('mataro-target-direction-sub');
    const etaBigEl = document.getElementById('mataro-eta-big-display');
    const etaClockEl = document.getElementById('mataro-eta-clock-display');
    const etaPillEl = document.getElementById('mataro-eta-status-pill');
    const etaStatusText = document.getElementById('mataro-eta-status-text');
    const lineTagEl = document.getElementById('mataro-next-bus-line-tag');
    const destEl = document.getElementById('mataro-next-bus-dest');
    const mapsLinkEl = document.getElementById('mataro-target-maps-link');

    const stop = data.targetStop || {};
    const next = data.nextBus || null;

    if (titleEl) titleEl.textContent = stop.name || 'Parada Mataró';
    if (codeEl) codeEl.textContent = stop.code || stop.id || '--';
    if (dirSubEl) dirSubEl.textContent = data.directionName || 'En servei';
    if (lineTagEl) {
      lineTagEl.textContent = `Línia ${this.activeMataroLineId}`;
      if (data.line?.color) lineTagEl.style.color = data.line.color;
    }
    if (destEl) destEl.textContent = next?.destination || data.directionName || 'Destí';

    if (mapsLinkEl && stop.lat && stop.lon) {
      mapsLinkEl.href = `https://www.google.com/maps/search/?api=1&query=${stop.lat},${stop.lon}`;
    }

    this.renderEtaDisplay(next, etaBigEl, etaClockEl, etaPillEl, etaStatusText);
    this.renderDeparturesInto('mataro-departures-list-container', 'mataro-dep-count-badge', data.upcomingDepartures || []);
  }

  renderMataroTelemetry(lineData) {
    const buses = lineData.activeBuses || [];
    const bar = document.getElementById('mataro-telemetry-vehicles-bar');
    const chipsContainer = document.getElementById('mataro-telemetry-vehicles-chips');

    if (buses.length > 0) {
      if (bar) bar.style.display = 'flex';

      const selectedId = this.selectedVehicleIdByPage['mataro'];
      const activeBus = buses.find(b => String(b.tripId || b.vehicleId) === String(selectedId)) || buses[0];
      this.selectedVehicleIdByPage['mataro'] = activeBus.tripId || activeBus.vehicleId;

      if (chipsContainer) {
        chipsContainer.innerHTML = buses.map((b, idx) => {
          const isSelected = String(b.tripId || b.vehicleId) === String(this.selectedVehicleIdByPage['mataro']);
          const label = b.vehicleId ? `Bus #${b.vehicleId}` : `Bus ${idx + 1}`;
          const isParked = b.isTerminalLayover;
          return `
            <button type="button" class="telemetry-bus-chip ${isSelected ? 'active' : ''}" data-bus-trip="${b.tripId || b.vehicleId}">
              <span>${isParked ? '🅿️' : '🚌'}</span>
              <span>${label}</span>
              <span style="font-size:0.68rem; opacity:0.8;">(${b.toStop || 'En línia'})</span>
            </button>
          `;
        }).join('');

        chipsContainer.querySelectorAll('.telemetry-bus-chip').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            const tripId = btn.getAttribute('data-bus-trip');
            this.selectedVehicleIdByPage['mataro'] = tripId;
            this.renderMataroTelemetry(lineData);
          });
        });
      }

      this.renderMataroTelemetryFields(activeBus, lineData);
    } else {
      if (bar) bar.style.display = 'none';
      this.renderMataroTelemetryFields(null, lineData);
    }
  }

  renderMataroTelemetryFields(b, lineData) {
    const coordsEl = document.getElementById('mataro-telemetry-coords');
    const bearingEl = document.getElementById('mataro-telemetry-bearing');
    const speedEl = document.getElementById('mataro-telemetry-speed');
    const segmentEl = document.getElementById('mataro-telemetry-segment');
    const etaNextEl = document.getElementById('mataro-telemetry-eta-next');
    const progressFill = document.getElementById('mataro-telemetry-progress-bar');
    const progressText = document.getElementById('mataro-telemetry-progress-text');
    const statusBadge = document.getElementById('mataro-telemetry-status-badge');
    const radarDot = document.getElementById('mataro-telemetry-radar-dot');

    if (!b) {
      if (coordsEl) coordsEl.textContent = 'Sense vehicle actiu';
      if (bearingEl) bearingEl.textContent = '--';
      if (speedEl) speedEl.textContent = '0 km/h';
      if (segmentEl) segmentEl.textContent = lineData.name;
      if (etaNextEl) etaNextEl.textContent = '--';
      if (progressFill) progressFill.style.width = '0%';
      if (progressText) progressText.textContent = '0%';
      if (statusBadge) { statusBadge.textContent = '⚪ Sense dades'; statusBadge.className = 'telemetry-status-badge'; }
      if (radarDot) radarDot.className = 'telemetry-live-radar';
      return;
    }

    const isEst = Boolean(b.isEstimated);

    if (coordsEl) coordsEl.textContent = b.coordinatesFormatted || `${b.lat.toFixed(5)}° N, ${b.lon.toFixed(5)}° E`;
    if (bearingEl) bearingEl.textContent = `${b.compass?.label || 'N/A'} (${b.bearing || 0}°)`;
    if (speedEl) speedEl.textContent = `${b.speedKmh || 30} km/h`;
    if (segmentEl) segmentEl.textContent = `${b.fromStop} ➔ ${b.toStop}`;
    if (etaNextEl) etaNextEl.textContent = b.secondsToNextStop ? `~${Math.round(b.secondsToNextStop / 60)} min (${b.toStop})` : `${b.toStop}`;
    
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

  renderMataroTimeline(lineData, activeTargetId) {
    const container = document.getElementById('mataro-corridor-timeline-container');
    const stops = lineData.stops || [];
    if (!container || stops.length === 0) return;

    const stepInterval = Math.max(1, Math.floor(stops.length / 8));
    const checkpoints = stops.filter((s, i) => i === 0 || i === stops.length - 1 || i % stepInterval === 0 || s.id === activeTargetId);

    const activeBus = lineData.activeBuses[0] || null;

    container.innerHTML = checkpoints.map((s, idx) => {
      const isTarget = String(s.id) === String(activeTargetId);
      const isPassed = activeBus && s.seq < (activeBus.fromSeq || 0);
      const hasBus = activeBus && (s.seq === activeBus.fromSeq || s.seq === activeBus.toSeq);

      let nodeClass = 'step-node';
      let iconContent = `${idx + 1}`;

      if (hasBus) {
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
        <div class="corridor-step" data-target-id="${s.id}" style="cursor:pointer;" title="Fixar ${s.name} com a parada principal">
          <div class="${nodeClass}">
            <span>${iconContent}</span>
          </div>
          <div class="step-info">
            <span class="step-name">${s.name}</span>
            <span class="step-zone">#${s.seq} Mataró</span>
          </div>
        </div>
      `;
    }).join('');
  }

  // ==========================================
  // 5. HELPER RENDERING METHODS
  // ==========================================

  renderEtaDisplay(next, etaBigEl, etaClockEl, etaPillEl, etaStatusText) {
    if (next) {
      if (etaBigEl) etaBigEl.textContent = next.formattedStatus || `${next.minutesAway} min`;
      if (etaClockEl) etaClockEl.textContent = `Hora estimada: ${next.departureTime || '--:--'}`;

      if (etaPillEl && etaStatusText) {
        etaPillEl.className = 'eta-status-pill';
        if (next.delayStatus === 'delayed') {
          etaPillEl.classList.add('delayed');
          etaStatusText.textContent = `⚠️ Retard (${next.delayBadgeText || '+2 min'})`;
        } else if (next.delayStatus === 'early') {
          etaPillEl.classList.add('early');
          etaStatusText.textContent = `⚡ Avançat (${next.delayBadgeText || '-2 min'})`;
        } else {
          etaPillEl.classList.add('live');
          etaStatusText.textContent = next.isRealTime ? '🟢 Temps Real Actiu' : '📅 Horari Teòric';
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

    if (badge) badge.textContent = `${departures.length} properes`;

    if (!departures || departures.length === 0) {
      container.innerHTML = `
        <div class="departure-item" style="justify-content: center; color: var(--text-muted); font-size: 0.8rem; padding: 1.25rem;">
          No hi ha més sortides previstes properament.
        </div>
      `;
      return;
    }

    container.innerHTML = departures.slice(0, 6).map((dep, idx) => `
      <div class="departure-item ${idx === 0 ? 'highlight-next' : ''}">
        <div class="dep-time-group">
          <span class="dep-clock">${dep.departureTime}</span>
          <span class="dep-dest">Cap a <strong>${dep.destination || 'Destí'}</strong></span>
        </div>
        <div class="dep-status">
          <span class="dep-mins">${dep.minutesAway === 0 ? 'Ara' : `${dep.minutesAway} min`}</span>
          <span class="dep-delay-pill ${dep.delayStatus || 'on-time'}">
            ${dep.delayBadgeText || 'Puntual'}
          </span>
        </div>
      </div>
    `).join('');
  }

  populateSelect(selectId, stops, selectedId) {
    const select = document.getElementById(selectId);
    if (!select) return;

    select.innerHTML = stops.map(s => {
      const id = String(s.mouteStopId || s.id || s.code);
      const isSel = id === String(selectedId);
      return `<option value="${id}" ${isSel ? 'selected' : ''}>#${s.seq || ''} ${s.name}</option>`;
    }).join('');
  }

  renderStopsBrowser(stops, lineKey) {
    const container = document.getElementById('stops-list-scroll');
    const totalEl = document.getElementById('stops-total-count');
    if (!container) return;

    if (totalEl) totalEl.textContent = stops.length;

    const currentTargetId = this.targetStopsByLine[lineKey] || '';

    container.innerHTML = stops.map((s, i) => {
      const id = String(s.mouteStopId || s.id || s.code);
      const isTarget = id === String(currentTargetId);
      return `
        <div class="stop-row-item ${isTarget ? 'target-stop' : ''}" data-stop-id="${id}" data-stop-name="${s.name.replace(/"/g, '&quot;')}">
          <div class="stop-row-left">
            <span class="stop-seq-badge">#${s.seq || i + 1}</span>
            <div>
              <div class="stop-row-name">${s.name} ${isTarget ? '⭐' : ''}</div>
              <div class="stop-row-zone">${s.zone || 'Parada'} ${s.code ? `• Codi: ${s.code}` : ''}</div>
            </div>
          </div>
          <button type="button" class="btn-icon btn-inspect-stop" style="width:34px; height:34px;" title="Veure arribades" data-stop-id="${id}" data-stop-name="${s.name.replace(/"/g, '&quot;')}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
      `;
    }).join('');
  }

  // ==========================================
  // 6. STOP INSPECTION & TARGET SELECTION
  // ==========================================

  async inspectStop(stopId, stopName) {
    const modal = document.getElementById('stop-modal-backdrop');
    const titleEl = document.getElementById('modal-stop-title');
    const subEl = document.getElementById('modal-stop-subtitle');
    const listEl = document.getElementById('modal-departures-list');
    const setTargetBtn = document.getElementById('modal-set-target-btn');
    const mapsLink = document.getElementById('modal-maps-link');

    if (!modal) return;

    if (titleEl) titleEl.textContent = stopName || 'Parada';
    if (subEl) subEl.textContent = `Codi identificador: ${stopId}`;
    if (listEl) listEl.innerHTML = '<div style="color:var(--text-muted); font-size:0.85rem; padding:0.5rem;">Consultant temps real...</div>';

    modal.classList.add('active');

    if (setTargetBtn) {
      setTargetBtn.onclick = () => {
        this.setTargetStop(stopId);
        modal.classList.remove('active');
      };
    }

    try {
      const endpoint = this.currentPage === 'c10'
        ? `/api/c10/stop/${stopId}/departures?direction=${this.c10Direction}`
        : `/api/mataro/stop/${stopId}/departures?lineId=${this.activeMataroLineId}`;

      const res = await fetch(endpoint).then(r => r.json());
      if (res.success && res.data) {
        const deps = res.data.departures || [];
        const stopObj = res.data.stop || {};

        if (mapsLink && stopObj.lat && stopObj.lon) {
          mapsLink.href = `https://www.google.com/maps/search/?api=1&query=${stopObj.lat},${stopObj.lon}`;
        }

        if (deps.length === 0) {
          listEl.innerHTML = '<div style="color:var(--text-muted); font-size:0.85rem; padding:0.5rem;">Sense arribades previstes en els propers 60 min.</div>';
          return;
        }

        listEl.innerHTML = deps.slice(0, 5).map(d => `
          <div class="departure-item">
            <div class="dep-time-group">
              <span class="dep-clock">${d.departureTime}</span>
              <span class="dep-dest">Cap a <strong>${d.destination || 'Destí'}</strong></span>
            </div>
            <div class="dep-status">
              <span class="dep-mins">${d.minutesAway === 0 ? 'Imminent' : `${d.minutesAway} min`}</span>
              <span class="dep-delay-pill ${d.delayStatus || 'on-time'}">${d.delayBadgeText || 'Puntual'}</span>
            </div>
          </div>
        `).join('');
      }
    } catch (e) {
      console.error('Stop departures fetch error:', e);
      if (listEl) listEl.innerHTML = '<div style="color:var(--danger); font-size:0.85rem;">Error en carregar les sortides.</div>';
    }
  }

  setTargetStop(stopId) {
    const key = this.currentPage === 'c10' ? 'c10' : this.activeMataroLineId;
    this.targetStopsByLine[key] = String(stopId);
    localStorage.setItem('bad_amb_target_stops', JSON.stringify(this.targetStopsByLine));
    this.refreshAllData(false);
  }

  // ==========================================
  // 7. GLOBAL UNIVERSAL SEARCH
  // ==========================================

  setupGlobalSearch() {
    const input = document.getElementById('global-search-input');
    const dropdown = document.getElementById('search-results-dropdown');
    if (!input || !dropdown) return;

    input.addEventListener('input', () => {
      clearTimeout(this.searchDebounceTimer);
      const q = input.value.trim();

      if (q.length < 2) {
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
    if (results.length === 0) {
      dropdown.innerHTML = '<div style="padding:0.75rem 1rem; color:var(--text-muted); font-size:0.8rem;">Cap parada trobada.</div>';
      dropdown.classList.add('active');
      return;
    }

    dropdown.innerHTML = results.map(r => `
      <div class="search-result-item" data-line-id="${r.lineId}" data-stop-id="${r.stopId}" data-name="${r.stopName.replace(/"/g, '&quot;')}" data-lat="${r.lat}" data-lon="${r.lon}">
        <div class="search-result-left">
          <span class="search-result-badge" style="background:${r.lineColor};">${r.lineCode}</span>
          <div>
            <div class="search-result-name">${r.stopName}</div>
            <div class="search-result-zone">${r.zone} • Codi: ${r.code}</div>
          </div>
        </div>
        <span style="font-size:0.75rem; color:var(--c10-primary); font-weight:700;">Veure ➔</span>
      </div>
    `).join('');

    dropdown.classList.add('active');

    dropdown.querySelectorAll('.search-result-item').forEach(item => {
      item.addEventListener('click', async (e) => {
        e.preventDefault();
        const lineId = item.getAttribute('data-line-id');
        const stopId = item.getAttribute('data-stop-id');
        const stopName = item.getAttribute('data-name');
        const lat = parseFloat(item.getAttribute('data-lat'));
        const lon = parseFloat(item.getAttribute('data-lon'));

        dropdown.classList.remove('active');
        input.value = '';

        if (lineId === 'c10') {
          this.switchPage('c10');
        } else {
          this.switchPage('mataro', lineId);
        }

        this.setTargetStop(stopId);

        if (lat && lon) {
          this.mapController.focusTargetStop(lat, lon);
        }

        this.inspectStop(stopId, stopName);
      });
    });
  }

  // ==========================================
  // 8. ROBUST EVENT LISTENERS & EVENT DELEGATION
  // ==========================================

  setupEventListeners() {
    // Top Navigation Tabs (Support Click & Fast Touch)
    const tabC10 = document.getElementById('tab-c10');
    const tabMataro = document.getElementById('tab-mataro');

    if (tabC10) {
      tabC10.addEventListener('click', (e) => { e.preventDefault(); this.switchPage('c10'); });
    }
    if (tabMataro) {
      tabMataro.addEventListener('click', (e) => { e.preventDefault(); this.switchPage('mataro'); });
    }

    // C-10 Direction buttons delegation
    const c10DirGroup = document.getElementById('c10-direction-toggle-group');
    if (c10DirGroup) {
      c10DirGroup.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-direction');
        if (!btn) return;
        e.preventDefault();
        const dirId = btn.getAttribute('data-direction');
        if (dirId && dirId !== this.c10Direction) {
          this.c10Direction = dirId;
          this.refreshAllData(true);
        }
      });
    }

    // Mataró Direction buttons delegation
    const mataroDirGroup = document.getElementById('mataro-direction-toggle-group');
    if (mataroDirGroup) {
      mataroDirGroup.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-direction');
        if (!btn) return;
        e.preventDefault();
        const dirId = btn.getAttribute('data-dir-id');
        if (dirId && dirId !== this.mataroDirection) {
          this.mataroDirection = dirId;
          this.refreshAllData(true);
        }
      });
    }

    // Mataró Line Selector Dropdown change
    document.getElementById('mataro-line-select-dropdown')?.addEventListener('change', (e) => {
      if (e.target.value) {
        this.switchMataroLine(e.target.value);
      }
    });

    // Corridor Steps Timeline delegation (Interurbà & Mataró)
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

    // Stops Browser List delegation
    const stopsList = document.getElementById('stops-list-scroll');
    if (stopsList) {
      stopsList.addEventListener('click', (e) => {
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

    // Footer Links
    document.getElementById('footer-link-c10')?.addEventListener('click', (e) => { e.preventDefault(); this.switchPage('c10'); });
    document.getElementById('footer-link-mataro')?.addEventListener('click', (e) => { e.preventDefault(); this.switchPage('mataro'); });

    // Refresh Button
    document.getElementById('btn-refresh')?.addEventListener('click', (e) => { e.preventDefault(); this.refreshAllData(false); });

    // Sound Alarm Button
    document.getElementById('btn-sound')?.addEventListener('click', (e) => { e.preventDefault(); this.toggleSound(); });

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

    // Target Stop Dropdowns
    document.getElementById('c10-target-stop-select')?.addEventListener('change', (e) => {
      if (e.target.value) this.setTargetStop(e.target.value);
    });

    document.getElementById('mataro-target-stop-select')?.addEventListener('change', (e) => {
      if (e.target.value) this.setTargetStop(e.target.value);
    });

    // Filter Stops Browser Input
    document.getElementById('stop-search-input')?.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('#stops-list-scroll .stop-row-item').forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(q) ? 'flex' : 'none';
      });
    });

    // Window Popstate (Back/Forward URL Navigation)
    window.addEventListener('hashchange', () => {
      this.parseUrlHash();
      this.switchPage(this.currentPage, this.activeMataroLineId);
    });

    this.setupGlobalSearch();
    this.setupLinePicker();
  }

  setupMapResizeControls() {
    const expandHeightBtn = document.getElementById('btn-map-expand-height');
    const heightLabel = document.getElementById('map-height-label');
    const expandWidthBtn = document.getElementById('btn-map-expand-width');
    const mapContainer = document.getElementById('map-container');
    const explorerGrid = document.querySelector('.explorer-grid');
    const resizeBar = document.getElementById('map-resize-bar');

    let isTall = false;
    expandHeightBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      isTall = !isTall;
      mapContainer.style.height = isTall ? '580px' : '380px';
      if (heightLabel) heightLabel.textContent = isTall ? 'Normal' : 'Gran';
      this.mapController.invalidateSize();
    });

    let isFullWidth = false;
    expandWidthBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      isFullWidth = !isFullWidth;
      explorerGrid?.classList.toggle('expanded-width', isFullWidth);
      expandWidthBtn.classList.toggle('active', isFullWidth);
      this.mapController.invalidateSize();
    });

    // Safe, non-intrusive drag resize
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
        this.mapController.invalidateSize();
      };

      const onEnd = () => {
        if (isDragging) {
          isDragging = false;
          resizeBar.classList.remove('dragging');
          document.body.style.cursor = '';
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
  // 9. ANIMATION, AUDIO & UTILITIES
  // ==========================================

  startAnimationLoop() {
    const step = () => {
      const nowSec = Date.now() / 1000;
      if (this.mapController) {
        this.mapController.stepBusAnimation(nowSec);
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  startAutoRefresh() {
    this.pollTimer = setInterval(() => {
      this.secondsRemaining--;
      if (this.secondsRemaining <= 0) {
        this.refreshAllData(false);
      } else {
        this.updateCountdownLabel();
      }
    }, 1000);
  }

  updateCountdownLabel() {
    document.querySelectorAll('.countdown-label-text').forEach(el => {
      el.textContent = `Actualització en ${this.secondsRemaining}s`;
    });
  }

  setLiveStatus(status) {
    const dot = document.querySelector('#live-indicator .live-dot');
    const text = document.getElementById('live-text');
    if (!dot || !text) return;

    if (status === 'online') {
      dot.style.background = '#10b981';
      text.textContent = 'En directe';
    } else if (status === 'syncing') {
      dot.style.background = '#38bdf8';
      text.textContent = 'Sincronitzant...';
    } else {
      dot.style.background = '#ef4444';
      text.textContent = 'Desconnectat';
    }
  }

  updateActiveBusesCount(count) {
    const headerEl = document.getElementById('header-active-buses-text');
    const mapEl = document.getElementById('map-bus-counter-tag');
    if (headerEl) headerEl.innerHTML = `<strong>${count}</strong> bus${count === 1 ? '' : 'os'}`;
    if (mapEl) mapEl.textContent = `🚌 ${count} actiu${count === 1 ? '' : 's'}`;
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

  checkArrivalAlerts(corridorData, lineKey) {
    if (!this.soundEnabled) return;
    const targetStopId = this.targetStopsByLine[lineKey] || '10037202';
    const targetCp = (corridorData.checkpoints || []).find(c => c.id === targetStopId);

    if (targetCp && targetCp.etaMinutes <= 3 && targetCp.etaMinutes > 0 && targetCp.hasBus) {
      if (this.lastAlertedTrip !== targetStopId) {
        this.lastAlertedTrip = targetStopId;
        this.playChime();
      }
    }
  }

  hexToRgb(hex) {
    if (!hex) return '0, 148, 133';
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    const num = parseInt(c, 16);
    return `${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}`;
  }
}

// Instantiate global app
window.addEventListener('DOMContentLoaded', () => {
  window.c10App = new TransitApp();
});

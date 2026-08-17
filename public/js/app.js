// Bad AMB Bus Tracker - Unified Dynamic Multi-Line Platform Controller
// Universal architecture supporting C-10, Mataró Urbà (L1..L8), and all regional lines

class TransitApp {
  constructor() {
    this.activeLineId = 'c10';
    this.activeDirection = '1';

    this.availableLines = [];
    this.activeLineData = null;
    
    this.targetStopsByLine = JSON.parse(localStorage.getItem('bad_amb_target_stops') || '{}');
    this.allStops = [];
    this.activeBuses = [];
    this.selectedVehicleId = null;

    this.pollInterval = 15;
    this.secondsRemaining = this.pollInterval;
    this.pollTimer = null;
    this.searchDebounceTimer = null;
    
    this.soundEnabled = localStorage.getItem('c10_sound') === 'true';
    this.audioContext = null;
    this.lastAlertedTrip = null;

    // Trains UI display flag: trains remain fully operational in backend/tests, but hidden from the general transit UI
    this.showTrainsInUI = false;

    // Theme Management (Light / Dark Mode)
    this.currentTheme = this.getInitialTheme();
    this.initTheme();

    this.mapController = null;
    this.init();
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
    console.log('🚀 Initializing Bad AMB Bus Tracker Universal Engine...');

    try {
      // 1. Initialize Map
      this.mapController = new C10Map('map-container');
      this.mapController.setTheme(this.currentTheme);

      // 2. Load Available Lines & Determine Initial Route from URL hash
      await this.fetchLines();
      this.parseUrlHash();

      // 3. Setup DOM Listeners & Controls
      this.setupEventListeners();
      this.setupMapResizeControls();
      this.setupAudio();

      // 4. Initial Data Fetch
      await this.refreshAllData(true);

      // 5. Start Polling & Animation Glider Loop
      this.startAutoRefresh();
      this.startAnimationLoop();
    } catch (err) {
      console.error('Fatal initialization error:', err);
    }
  }

  parseUrlHash() {
    const hash = window.location.hash.toLowerCase().replace('#', '').trim();
    if (!hash) {
      this.activeLineId = 'c10';
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

    const matchedLine = this.availableLines.find(l => 
      String(l.id).toLowerCase() === hash || 
      String(l.code).toLowerCase() === hash || 
      String(l.id).toLowerCase() === hash.replace('line-', '')
    );

    if (matchedLine) {
      this.activeLineId = String(matchedLine.id);
    } else {
      this.activeLineId = 'c10';
    }
  }

  // ==========================================
  // 1. UNIVERSAL LINE NAVIGATION & CONTROLLER
  // ==========================================

  async fetchLines() {
    try {
      const res = await fetch('/api/lines');
      const json = await res.json();
      if (json.success && json.lines) {
        this.availableLines = json.lines;
      }
    } catch (e) {
      console.error('Error fetching lines:', e);
    }
  }

  switchLine(lineId, direction = null) {
    this.activeLineId = String(lineId);
    this.selectedVehicleId = null;

    const lineObj = this.availableLines.find(l => String(l.id) === String(lineId));
    if (direction !== null) {
      this.activeDirection = String(direction);
    } else if (lineObj?.directions?.length > 0) {
      this.activeDirection = String(lineObj.directions[0].dirId || '1');
    } else {
      this.activeDirection = '1';
    }

    const hash = this.activeLineId === 'c10' ? '#c10' : `#l${this.activeLineId}`;
    if (window.location.hash !== hash) {
      window.history.replaceState(null, '', hash);
    }

    this.mapController?.clearAllBusMarkers();
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

  hexToRgb(hex) {
    if (!hex) return '0, 148, 133';
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    const num = parseInt(c, 16);
    return `${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}`;
  }

  // ==========================================
  // 2. DATA REFRESH ENGINE (POLYMORPHIC)
  // ==========================================

  async refreshAllData(shouldFitBounds = false) {
    this.setLiveStatus('syncing');

    try {
      const lId = this.activeLineId;
      const targetStopId = this.targetStopsByLine[lId] || null;
      const dir = this.activeDirection;

      // 1. Unified Line details & active buses
      const lineRes = await fetch(`/api/line/${lId}?direction=${dir}`).then(r => r.json());

      // 2. Unified Target Stop ETA
      const etaRes = await fetch(`/api/line/${lId}/target-eta?direction=${dir}${targetStopId ? `&stopId=${targetStopId}` : ''}`).then(r => r.json());

      if (lineRes.success && lineRes.data) {
        const lData = lineRes.data;
        this.activeLineData = lData;
        this.allStops = lData.stops || [];
        this.activeBuses = lData.activeBuses || [];

        // 1. Update Header & Banner
        this.updateHeaderBrand(lData);
        this.renderLineBanner(lData);

        // 2. Render Direction Buttons
        const lineMeta = this.availableLines.find(l => String(l.id) === String(lId)) || lData;
        this.renderDirectionButtons(lineMeta.directions || lData.directions || [], this.activeDirection);

        // 3. Render Target Card
        const activeTargetId = targetStopId || (etaRes.data?.targetStop?.id || etaRes.data?.targetStop?.mouteStopId || this.allStops[0]?.id || this.allStops[0]?.mouteStopId);
        this.populateSelect('target-stop-select', this.allStops, activeTargetId);
        
        if (etaRes.success && etaRes.data) {
          this.renderTargetCard(etaRes.data, lData);
        }

        // 4. Render Cockpit & Telemetry
        this.renderTelemetryCockpit(lData, etaRes.data);

        // 5. Render Route Progression Timeline
        this.renderRouteTimeline(lData, activeTargetId);

        // 6. Render Stops Browser
        this.renderStopsBrowser(this.allStops, lId);

        // 7. Update Map
        this.updateActiveBusesCount(this.activeBuses.length);
        const lineColor = lData.color || '#009485';
        const isBoth = this.activeDirection === 'both' || lData.direction === 'both';
        const coords = lData.coords || lData.polyline || lData.allDirections?.[0]?.coords || lData.allDirections?.[0]?.polyline || [];
        const secondaryCoords = isBoth ? (lData.secondaryCoords || lData.allDirections?.[1]?.coords || lData.allDirections?.[1]?.polyline || null) : null;
        const secondaryStops = isBoth ? (lData.secondaryStops || lData.allDirections?.[1]?.stops || null) : null;
        const secondaryColor = isBoth ? (lData.secondaryColor || '#38bdf8') : '#38bdf8';

        this.mapController.renderStops(
          this.allStops, 
          activeTargetId, 
          (s) => this.inspectStop(s.id || s.mouteStopId, s.name), 
          shouldFitBounds, 
          lineColor, 
          coords,
          secondaryCoords,
          secondaryStops,
          secondaryColor
        );
        this.mapController.updateBusMarkers(
          this.activeBuses, 
          lineColor, 
          secondaryColor, 
          this.selectedVehicleId,
          (bus) => {
            this.selectedVehicleId = bus.tripId || bus.vehicleId;
            this.renderTelemetryCockpit(lData, etaRes.data);
            this.mapController?.highlightBus(this.selectedVehicleId, false);
          },
          lId
        );
        this.checkArrivalAlerts(lData, activeTargetId);
      }

      this.setLiveStatus('online');
      this.secondsRemaining = this.pollInterval;
      this.updateCountdownLabel();
    } catch (err) {
      console.error('Data refresh error:', err);
      this.setLiveStatus('offline');
    }
  }

  updateHeaderBrand(lData) {
    const badge = document.getElementById('header-line-badge');
    const modeBadge = document.getElementById('header-mode-badge');
    const subtitle = document.getElementById('header-subtitle');
    const mapTitle = document.getElementById('map-line-title');

    const code = lData.code || lData.id || 'C-10';
    const color = lData.color || '#009485';
    const isInterurban = lData.id === 'c10' || code.startsWith('C-') || code.startsWith('E');

    if (badge) {
      badge.textContent = code;
      badge.style.background = color;
      badge.style.color = this.getContrastColor(color);
    }

    if (modeBadge) {
      modeBadge.textContent = isInterurban ? 'Interurbà' : 'Urbà Mataró';
      modeBadge.className = `header-mode-badge ${isInterurban ? 'interurba' : 'urba'}`;
      modeBadge.style.background = `rgba(${this.hexToRgb(color)}, 0.22)`;
      modeBadge.style.color = '#ffffff';
      modeBadge.style.borderColor = color;
      modeBadge.style.boxShadow = `0 2px 8px rgba(0, 0, 0, 0.25)`;
    }

    if (subtitle) {
      subtitle.textContent = `${lData.agency || 'Transport'} • ${lData.name || code}`;
    }

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

    if (badge) {
      badge.textContent = code;
      badge.style.background = color;
      badge.style.color = this.getContrastColor(color);
    }

    if (city) {
      city.textContent = lData.agency || 'Xarxa de Transport';
    }

    if (title) {
      title.textContent = `${code} — ${lData.name || ''}`;
    }
  }

  renderDirectionButtons(directions, currentDir) {
    const container = document.getElementById('direction-toggle-group');
    if (!container) return;

    if (!directions || directions.length === 0) {
      container.innerHTML = `
        <button type="button" class="btn-direction active" data-dir-id="1">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m9 18 6-6-6-6"/></svg>
          <span>Sentit Únic / Circular</span>
        </button>
      `;
      return;
    }

    let html = directions.map((d, i) => {
      const dirId = String(d.dirId || d.id);
      const isActive = dirId === String(currentDir);
      return `
        <button type="button" class="btn-direction ${isActive ? 'active' : ''}" data-dir-id="${dirId}">
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
  // 3. TARGET CARD & HERO ETA (UNIVERSAL)
  // ==========================================

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
    if (dirSubEl) dirSubEl.textContent = data.directionName || 'En servei';

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
      const clockTime = next.expectedIso
        ? new Date(next.expectedIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
        : (next.departureTime || '--:--');

      // A departure is ONLY the first service of tomorrow / morning resumption if explicitly tomorrow & not live/estimated
      const isTomorrowFirst = (next.isToday === false || next.isFirstOfDay === true) && !next.isRealTime && !next.isEstimated;
      if (isTomorrowFirst) {
        if (etaBigEl) etaBigEl.textContent = `🌅 ${clockTime}`;
        if (etaClockEl) etaClockEl.textContent = `1r pas previst demà: ${clockTime}`;
        if (etaPillEl && etaStatusText) {
          etaPillEl.className = 'eta-status-pill scheduled';
          etaStatusText.textContent = 'Represa al matí';
        }
      } else {
        const mins = next.minutesAway;
        const minsDisplay = (mins !== undefined && mins !== null)
          ? (mins <= 0 ? 'Imminent' : (mins === 1 ? '1 min' : `${mins} min`))
          : (next.formattedStatus || clockTime);

        if (etaBigEl) etaBigEl.textContent = minsDisplay;
        if (etaClockEl) etaClockEl.textContent = `Hora estimada: ${clockTime}`;

        if (etaPillEl && etaStatusText) {
          etaPillEl.className = 'eta-status-pill';
          if (next.delayStatus === 'delayed') {
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

    if (badge) badge.textContent = `${departures.length} properes`;

    if (!departures || departures.length === 0) {
      container.innerHTML = `
        <div class="departure-item" style="justify-content: center; color: var(--text-muted); font-size: 0.8rem; padding: 1.25rem;">
          No hi ha més sortides previstes properament.
        </div>
      `;
      return;
    }

    container.innerHTML = departures.slice(0, 8).map((dep, idx) => {
      const clockTime = dep.expectedIso
        ? new Date(dep.expectedIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
        : (dep.departureTime || '--:--');

      const isTomorrow = dep.isToday === false && !dep.isRealTime && !dep.isEstimated;
      const isFirstMorning = (dep.isFirstOfDay === true || (idx === 0 && isTomorrow)) && !dep.isRealTime && !dep.isEstimated;

      const minsText = isFirstMorning
        ? `🌅 Demà ${dep.departureTime || clockTime}`
        : (isTomorrow
            ? `Demà ${dep.departureTime || clockTime}`
            : ((dep.minutesAway !== undefined && dep.minutesAway >= 0 && dep.minutesAway <= 180)
                ? (dep.minutesAway <= 0 ? 'Ara' : (dep.minutesAway === 1 ? '1 min' : `${dep.minutesAway} min`))
                : `${clockTime}`));

      const tagLabel = isFirstMorning
        ? '🌅 1r Servei'
        : (isTomorrow ? 'Programat' : (dep.isEstimated ? '⚡ Estimat' : '🟢 Temps Real'));

      const pillLabel = isFirstMorning
        ? '1r Servei'
        : (isTomorrow ? 'Programat' : (dep.isEstimated ? `⚡ Estimat ${dep.vehicleId ? `#${dep.vehicleId}` : ''}` : (dep.delayBadgeText || 'Puntual')));

      const pillClass = isTomorrow ? 'scheduled' : (dep.delayStatus || 'on-time');

      return `
        <div class="departure-item ${idx === 0 ? 'highlight-next' : ''}">
          <div class="dep-time-group">
            <div class="dep-time-row">
              <span class="dep-clock">${clockTime}</span>
              <span class="dep-tag-sub ${isFirstMorning ? 'first-service' : ''}">${tagLabel}</span>
            </div>
            <div class="dep-dest">
              Cap a <strong>${dep.destination || 'Destí'}</strong>
            </div>
            <div class="dep-time-sub">
              ${isFirstMorning
                ? `<span>📅 Primer autobús del matí (${dep.departureTime || clockTime})</span>`
                : (isTomorrow ? `<span>📅 Horari teòric: ${dep.departureTime || clockTime}</span>` : `<span>📅 Horari previst</span>`)}
            </div>
          </div>
          <div class="dep-status">
            <span class="dep-mins" style="${isFirstMorning ? 'color:#fbbf24;' : (isTomorrow ? 'color:#94a3b8;' : '')}">${minsText}</span>
            <span class="dep-delay-pill ${pillClass}">
              ${pillLabel}
            </span>
          </div>
        </div>
      `;
    }).join('');
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
    const zonePill = document.getElementById('corridor-zone-pill');

    if (titleEl) {
      titleEl.textContent = `Recorregut ${lineData.code || lineData.id || ''}: ${lineData.name || ''}`;
    }

    if (zonePill) {
      zonePill.textContent = lineData.agency || 'Xarxa de Transport';
    }

    const stops = lineData.stops || [];
    if (!container || stops.length === 0) return;

    const stepInterval = Math.max(1, Math.floor(stops.length / 9));
    const checkpoints = stops.filter((s, i) => i === 0 || i === stops.length - 1 || i % stepInterval === 0 || String(s.id || s.mouteStopId) === String(activeTargetId));
    const activeBus = lineData.activeBuses?.[0] || null;

    container.innerHTML = checkpoints.map((s, idx) => {
      const sId = String(s.id || s.mouteStopId || s.code);
      const isTarget = sId === String(activeTargetId);
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
        <div class="corridor-step" data-target-id="${sId}" style="cursor:pointer;" title="Fixar ${s.name} com a parada principal">
          <div class="${nodeClass}">
            <span>${iconContent}</span>
          </div>
          <div class="step-info">
            <span class="step-name">${s.name}</span>
            <span class="step-zone">#${s.seq || idx + 1} • ${s.zone || 'Parada'}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  // ==========================================
  // 6. STOPS BROWSER & SELECTOR (UNIVERSAL)
  // ==========================================

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

  setTargetStop(stopId) {
    this.targetStopsByLine[this.activeLineId] = String(stopId);
    localStorage.setItem('bad_amb_target_stops', JSON.stringify(this.targetStopsByLine));
    this.refreshAllData(false);
  }

  // ==========================================
  // 7. STOP INSPECTION MODAL (UNIVERSAL)
  // ==========================================

  async inspectStop(stopId, stopName) {
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
    let currIndex = stopsList.findIndex(s => String(s.id || s.mouteStopId || s.code) === String(stopId));

    if (currIndex === -1 && this.availableLines) {
      for (const line of this.availableLines) {
        for (const dir of (line.directions || [])) {
          const idx = (dir.stops || []).findIndex(s => String(s.id || s.mouteStopId || s.code) === String(stopId));
          if (idx !== -1) {
            stopsList = dir.stops;
            currIndex = idx;
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
    if (countBadge) countBadge.textContent = 'Consultant...';
    if (listEl) listEl.innerHTML = '<div style="color:var(--text-muted); font-size:0.85rem; padding:0.5rem;">Consultant temps real i horaris...</div>';

    if (seqBadge) {
      seqBadge.textContent = currIndex >= 0 ? `Parada #${currIndex + 1} / ${totalStops}` : 'Parada';
    }

    let prevStop = null;
    let nextStop = null;

    if (totalStops > 1 && currIndex >= 0) {
      prevStop = currIndex > 0 ? stopsList[currIndex - 1] : stopsList[totalStops - 1];
      nextStop = currIndex < totalStops - 1 ? stopsList[currIndex + 1] : stopsList[0];
    }

    if (prevBtn && prevName) {
      if (prevStop) {
        prevBtn.disabled = false;
        prevName.textContent = prevStop.name.length > 14 ? `${prevStop.name.substring(0, 13)}…` : prevStop.name;
        prevBtn.onclick = (e) => {
          e.preventDefault();
          const pId = prevStop.id || prevStop.mouteStopId || prevStop.code;
          this.inspectStop(pId, prevStop.name);
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
          this.inspectStop(nId, nextStop.name);
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

    try {
      const endpoint = `/api/line/${this.activeLineId}/stop/${stopId}/departures?direction=${this.activeDirection}`;
      const res = await fetch(endpoint).then(r => r.json());

      if (res.success && res.data) {
        const deps = res.data.departures || [];
        const stopObj = res.data.stop || {};

        if (countBadge) countBadge.textContent = `${deps.length} sortides`;

        if (mapsLink && stopObj.lat && stopObj.lon) {
          mapsLink.href = `https://www.google.com/maps/search/?api=1&query=${stopObj.lat},${stopObj.lon}`;
        }

        if (deps.length === 0) {
          listEl.innerHTML = '<div style="color:var(--text-muted); font-size:0.85rem; padding:0.5rem;">Sense arribades previstes en els propers 120 min.</div>';
          return;
        }

        listEl.innerHTML = deps.slice(0, 10).map((d, idx) => {
          const estTime = d.expectedIso
            ? new Date(d.expectedIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
            : (d.departureTime || '--:--');

          const schedTime = d.aimedIso
            ? new Date(d.aimedIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
            : (d.isEstimated ? estTime : null);

          const isTomorrow = d.isToday === false && !d.isRealTime && !d.isEstimated;
          const isFirstMorning = (d.isFirstOfDay === true || (idx === 0 && isTomorrow)) && !d.isRealTime && !d.isEstimated;

          const isDiff = schedTime && schedTime !== estTime;
          const delayText = d.delayMins !== undefined && d.delayMins !== 0
            ? (d.delayMins > 0 ? `+${d.delayMins} min retard` : `${d.delayMins} min avançat`)
            : 'Puntual';

          const minsText = isFirstMorning
            ? `🌅 Demà ${d.departureTime || estTime}`
            : (isTomorrow
                ? `Demà ${d.departureTime || estTime}`
                : ((d.minutesAway !== undefined && d.minutesAway >= 0 && d.minutesAway <= 180)
                    ? (d.minutesAway <= 0 ? 'Imminent' : (d.minutesAway === 1 ? '1 min' : `${d.minutesAway} min`))
                    : `${estTime}`));

          const tagLabel = isFirstMorning
            ? '🌅 1r Servei'
            : (isTomorrow ? 'Programat' : (d.isEstimated ? '⚡ Estimat' : '🟢 Temps Real'));

          const pillLabel = isFirstMorning
            ? '1r Servei'
            : (isTomorrow ? 'Programat' : (d.isEstimated ? `⚡ Estimat ${d.vehicleId ? `#${d.vehicleId}` : ''}` : (d.delayBadgeText || 'Puntual')));

          const pillClass = isTomorrow ? 'scheduled' : (d.delayStatus || 'on-time');

          return `
            <div class="departure-item ${idx === 0 ? 'highlight-next' : ''}">
              <div class="dep-time-group">
                <div class="dep-time-row">
                  <span class="dep-clock">${estTime}</span>
                  <span class="dep-tag-sub ${isFirstMorning ? 'first-service' : ''}">${tagLabel}</span>
                </div>
                
                <div class="dep-dest">
                  ${d.lineId ? `<span class="line-badge-sm" style="font-size:0.68rem; padding:1px 5px; margin-right:4px; background:var(--c10-primary);">${d.lineId}</span>` : ''}
                  Cap a <strong>${d.destination || 'Destí'}</strong>
                </div>

                <div class="dep-time-sub">
                  ${isFirstMorning ? `
                    <span>📅 Primer autobús del matí (${d.departureTime || estTime})</span>
                  ` : (isTomorrow ? `
                    <span>📅 Horari teòric: <strong class="dep-sched-time">${d.departureTime || estTime}</strong></span>
                  ` : (schedTime ? `
                    <span>📅 Horari teòric: <strong class="dep-sched-time">${schedTime}</strong></span>
                    ${isDiff ? `<span>•</span> <span style="color:${d.delayMins > 2 ? '#f87171' : '#34d399'}; font-weight:600;">${delayText}</span>` : `<span>•</span> <span style="color:#34d399; font-weight:600;">Puntual</span>`}
                  ` : ''))}
                </div>
              </div>

              <div class="dep-status">
                <span class="dep-mins" style="${isFirstMorning ? 'color:#fbbf24;' : (isTomorrow ? 'color:#94a3b8;' : '')}">${minsText}</span>
                <span class="dep-delay-pill ${pillClass}" title="${d.delayBadgeText || pillLabel}">${pillLabel}</span>
              </div>
            </div>
          `;
        }).join('');
      }
    } catch (e) {
      console.error('Stop departures fetch error:', e);
      if (listEl) listEl.innerHTML = '<div style="color:var(--danger); font-size:0.85rem;">Error en carregar les sortides.</div>';
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

    // Group definitions (Organized by Bus Transit Networks)
    const groups = [
      { id: 'moventis', name: '🌊 Moventis / Casas (Maresme & L\'Hospitalet)', icon: '🌊', filter: l => (l.group === 'moventis' || String(l.id) === 'c10' || (l.agency && (l.agency.includes('Moventis') || l.agency.includes('Casas')))) && (!l.isTrain && l.group !== 'rodalies') },
      { id: 'mataro', name: '📍 Mataró Bus Urbà (L1..L8)', icon: '📍', filter: l => (l.group === 'mataro' || (!l.group && !l.isTrain && !String(l.id).startsWith('amb_') && !String(l.id).startsWith('rodalies_') && !String(l.id).startsWith('n') && String(l.id) !== 'c10')) && (!l.isTrain && l.group !== 'rodalies') },
      { id: 'tusgsal', name: '🟡 DIREXIS TUSGSAL (Barcelonès Nord & NitBus)', icon: '🟡', filter: l => (l.group === 'tusgsal' || (l.agency && l.agency.includes('TUSGSAL'))) && (!l.isTrain && l.group !== 'rodalies') },
      { id: 'avanza', name: '🔵 Avanza (Baix Llobregat & Exprés)', icon: '🔵', filter: l => (l.group === 'avanza' || (l.agency && l.agency.includes('Avanza'))) && (!l.isTrain && l.group !== 'rodalies') },
      { id: 'monbus', name: '🟠 Monbus & Aerobús', icon: '🟠', filter: l => (l.group === 'monbus' || (l.agency && (l.agency.includes('Monbus') || l.agency.includes('Aerobús')))) && (!l.isTrain && l.group !== 'rodalies') },
      { id: 'sagales', name: '🦉 Sagalés (NitBus & Costa)', icon: '🦉', filter: l => (l.group === 'sagales' || (l.agency && l.agency.includes('Sagalés')) || ['n82', 'n83', '603', 'n70', 'n71', 'n73'].includes(String(l.id).toLowerCase())) && (!l.isTrain && l.group !== 'rodalies') },
      { id: 'soler', name: '🟢 Soler i Sauret (Baix Llobregat)', icon: '🟢', filter: l => (l.group === 'soler' || (l.agency && l.agency.includes('Soler'))) && (!l.isTrain && l.group !== 'rodalies') },
      { id: 'baixbus', name: '🟣 Baixbus / DIREXIS TGO', icon: '🟣', filter: l => (l.group === 'baixbus' || (l.agency && l.agency.includes('TGO'))) && (!l.isTrain && l.group !== 'rodalies') }
    ];

    if (this.showTrainsInUI) {
      groups.unshift({ id: 'rodalies', name: '🚆 Rodalies de Catalunya (Trens)', icon: '🚆', filter: l => l.group === 'rodalies' || l.isTrain || String(l.id).startsWith('rodalies_') });
    }

    const filterFn = (l) => {
      if (!q) return true;
      const code = (l.code || String(l.id)).toLowerCase();
      const name = (l.name || '').toLowerCase();
      const agency = (l.agency || '').toLowerCase();
      return code.includes(q) || name.includes(q) || agency.includes(q) || ('línia ' + code).includes(q) || ('linia ' + code).includes(q);
    };

    let totalRendered = 0;
    let html = '';
    const isNight = new Date().getHours() >= 22 || new Date().getHours() < 6;

    groups.forEach(g => {
      if (cityFilter !== 'all' && cityFilter !== g.id) return;
      const groupLines = this.availableLines.filter(g.filter).filter(filterFn);
      if (groupLines.length === 0) return;

      totalRendered += groupLines.length;

      html += `
        <div class="line-category-group">
          <div class="line-category-title">
            <span>${g.name} (${groupLines.length})</span>
          </div>
          <div class="line-grid">
            ${groupLines.map(l => {
              const isActive = String(l.id) === String(this.activeLineId);
              const contrast = this.getContrastColor(l.color);
              return `
                <div class="line-grid-card ${isActive ? 'active' : ''}" data-line-id="${l.id}">
                  <div class="line-card-left">
                    <span class="line-card-badge" style="background:${l.color}; color:${contrast};">${l.code}</span>
                    <div class="line-card-details">
                      <div class="line-card-name">${l.isTrain ? `Tren ${l.code}` : l.code}: ${l.name}</div>
                      <div class="line-card-sub">
                        <span>${l.agency || g.name}</span>
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
    });

    if (totalRendered === 0) {
      container.innerHTML = `
        <div style="padding: 2.5rem 1rem; text-align: center; color: var(--text-muted);">
          <div style="font-size: 2rem; margin-bottom: 0.5rem;">🔍</div>
          <div style="font-weight: 700; color: #fff; margin-bottom: 0.25rem;">Cap línia trobada</div>
          <div style="font-size: 0.8rem;">No hi ha cap resultat per "${this.linePickerSearch}". Prova cercant per codi (ex: R1, B25, L80, N82, A1, C10, 1).</div>
        </div>
      `;
      return;
    }

    container.innerHTML = html;

    container.querySelectorAll('.line-grid-card').forEach(card => {
      card.addEventListener('click', (e) => {
        e.preventDefault();
        const lineId = card.getAttribute('data-line-id');
        this.closeLinePicker();
        this.switchLine(lineId);
      });
    });
  }

  setupLinePicker() {
    document.getElementById('open-line-picker-btn')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.openLinePicker();
    });

    document.querySelector('.logo-group')?.addEventListener('click', (e) => {
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
    let itemsToRender = results;
    if (!this.showTrainsInUI) {
      itemsToRender = results.filter(r => !r.isTrain && !r.lineCode?.startsWith('R') && !r.agency?.toLowerCase().includes('rodalies') && !r.agency?.toLowerCase().includes('renfe'));
    }

    if (itemsToRender.length === 0) {
      dropdown.innerHTML = '<div style="padding:0.75rem 1rem; color:var(--text-muted); font-size:0.8rem;">Cap parada trobada.</div>';
      dropdown.classList.add('active');
      return;
    }

    dropdown.innerHTML = itemsToRender.map(r => `
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

        this.switchLine(lineId);
        this.setTargetStop(stopId);

        if (lat && lon) {
          this.mapController.focusTargetStop(lat, lon);
        }

        this.inspectStop(stopId, stopName);
      });
    });
  }

  // ==========================================
  // 9. EVENT LISTENERS & MAP CONTROLS
  // ==========================================

  setupEventListeners() {
    // Dynamic Direction buttons delegation
    const dirGroup = document.getElementById('direction-toggle-group');
    if (dirGroup) {
      dirGroup.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-direction');
        if (!btn) return;
        e.preventDefault();
        const dirId = btn.getAttribute('data-dir-id') || btn.getAttribute('data-direction');
        if (dirId && dirId !== this.activeDirection) {
          this.activeDirection = dirId;
          this.refreshAllData(true);
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

    // Target Stop Dropdown
    document.getElementById('target-stop-select')?.addEventListener('change', (e) => {
      if (e.target.value) this.setTargetStop(e.target.value);
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

    // Filter Stops Browser Input
    document.getElementById('stop-search-input')?.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('#stops-list-scroll .stop-row-item').forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(q) ? 'flex' : 'none';
      });
    });

    // Footer Quick Links
    document.getElementById('footer-link-c10')?.addEventListener('click', (e) => { 
      e.preventDefault(); 
      this.switchLine('c10'); 
    });
    document.getElementById('footer-link-mataro')?.addEventListener('click', (e) => { 
      e.preventDefault(); 
      this.switchLine('1'); 
    });

    // Window Hashchange (Browser Back/Forward Navigation)
    window.addEventListener('hashchange', () => {
      this.parseUrlHash();
      this.refreshAllData(true);
    });

    this.setupGlobalSearch();
    this.setupLinePicker();
    this.setupConnectionMenu();
  }

  // ==========================================
  // CONNECTION MENU & DIAGNOSTICS
  // ==========================================

  setupConnectionMenu() {
    const liveBtn = document.getElementById('live-indicator');
    const wrapper = document.getElementById('live-indicator-wrapper');
    const dropdown = document.getElementById('connection-menu-dropdown');
    const testBtn = document.getElementById('btn-test-connection');

    if (!liveBtn || !dropdown) return;

    liveBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isActive = dropdown.classList.toggle('active');
      wrapper?.classList.toggle('active', isActive);
      liveBtn.setAttribute('aria-expanded', String(isActive));

      if (isActive) {
        this.updateConnectionMenuDetails();
      }
    });

    testBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      this.testApiConnection();
    });

    // Close on click outside
    document.addEventListener('click', (e) => {
      if (dropdown.classList.contains('active') && !dropdown.contains(e.target) && !liveBtn.contains(e.target)) {
        dropdown.classList.remove('active');
        wrapper?.classList.remove('active');
        liveBtn.setAttribute('aria-expanded', 'false');
      }
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && dropdown.classList.contains('active')) {
        dropdown.classList.remove('active');
        wrapper?.classList.remove('active');
        liveBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  updateConnectionMenuDetails() {
    const lineEl = document.getElementById('conn-line-name');
    const provEl = document.getElementById('conn-provider-name');
    const hostEl = document.getElementById('conn-api-host');

    const lCode = this.activeLineData?.code || this.activeLineId.toUpperCase();
    const provName = this.getProviderNameForLine(this.activeLineId);
    const hostName = this.getProviderHostForLine(this.activeLineId);

    if (lineEl) lineEl.textContent = lCode;
    if (provEl) provEl.textContent = provName;
    if (hostEl) hostEl.textContent = hostName;
  }

  getProviderNameForLine(lineId) {
    const clean = String(lineId).toLowerCase();
    if (clean === 'c10' || clean === 'c-10') return 'Generalitat Mou-te & ATM';
    if (['1','2','3','4','5','6','7','8'].includes(clean)) return 'Mataró Bus Urbà (Avanza)';
    if (['c11','c12','c14','c20','c30','e11.1','e11.2','e13','n80','c10'].includes(clean)) return 'Moventis / Casas (Interurbà)';
    if (clean.startsWith('n8') || clean === '551' || clean === '553' || clean === '554') return 'Sagalés Real-Time Feeds';
    if (clean.startsWith('r') || clean.startsWith('rg') || clean.startsWith('rt')) return 'Rodalies de Catalunya';
    return 'Àrea Metropolitana (AMB Mobilitat)';
  }

  getProviderHostForLine(lineId) {
    const clean = String(lineId).toLowerCase();
    if (clean === 'c10' || clean === 'c-10' || ['c11','c12','c14','c20','c30','e11.1','e11.2','e13','n80'].includes(clean)) {
      return 'moute.gencat.cat';
    }
    if (['1','2','3','4','5','6','7','8'].includes(clean)) {
      return 'sirimataro.avanzagrupo.com';
    }
    if (clean.startsWith('n8') || clean === '551' || clean === '553' || clean === '554') {
      return 'www.sagales.com';
    }
    return 'api.ambmobilitat.cat';
  }

  async testApiConnection() {
    const testBtn = document.getElementById('btn-test-connection');
    const spinIcon = document.getElementById('test-icon-spin');
    const btnText = document.getElementById('btn-test-conn-text');
    const latencyEl = document.getElementById('conn-latency-val');
    const testedEl = document.getElementById('conn-last-tested');
    const badgeEl = document.getElementById('conn-menu-badge');
    const dotEl = document.getElementById('conn-menu-dot');
    const diagBox = document.getElementById('conn-diagnostic-box');
    const diagText = document.getElementById('conn-diagnostic-text');

    if (testBtn) testBtn.disabled = true;
    if (spinIcon) spinIcon.classList.add('spinning');
    if (btnText) btnText.textContent = 'Provant connexió...';
    if (diagBox) {
      diagBox.className = 'conn-diagnostic-box';
      if (diagText) diagText.textContent = 'Realitzant petició de diagnòstic amb la passarel·la en temps real...';
    }

    try {
      const resp = await fetch(`/api/diagnostics/test?lineId=${encodeURIComponent(this.activeLineId)}`);
      const data = await resp.json();

      if (testedEl) testedEl.textContent = data.testedAt || new Date().toLocaleTimeString();
      if (latencyEl) latencyEl.textContent = `${data.latencyMs || 0} ms`;

      if (data.success) {
        if (badgeEl) {
          badgeEl.className = data.status === 'slow' ? 'conn-badge slow' : 'conn-badge';
          badgeEl.textContent = data.status === 'slow' ? 'Lenta' : 'En directe';
        }
        if (dotEl) {
          dotEl.className = data.status === 'slow' ? 'live-dot warning' : 'live-dot';
        }
        if (diagBox) diagBox.className = 'conn-diagnostic-box success';
        if (diagText) diagText.innerHTML = `✅ <strong>Connexió satisfactòria</strong>: ${data.message}`;
      } else {
        if (badgeEl) {
          badgeEl.className = 'conn-badge offline';
          badgeEl.textContent = 'Sense connexió';
        }
        if (dotEl) {
          dotEl.className = 'live-dot offline';
        }
        if (diagBox) diagBox.className = 'conn-diagnostic-box error';
        if (diagText) diagText.innerHTML = `⚠️ <strong>Error d'accés a l'API</strong>: ${data.message || data.error}`;
      }
    } catch (err) {
      if (latencyEl) latencyEl.textContent = 'Temps esgotat';
      if (testedEl) testedEl.textContent = new Date().toLocaleTimeString();
      if (badgeEl) {
        badgeEl.className = 'conn-badge offline';
        badgeEl.textContent = 'Error';
      }
      if (diagBox) diagBox.className = 'conn-diagnostic-box error';
      if (diagText) diagText.innerHTML = `❌ <strong>No s'ha pogut contactar amb el servidor</strong>: ${err.message}`;
    } finally {
      if (testBtn) testBtn.disabled = false;
      if (spinIcon) spinIcon.classList.remove('spinning');
      if (btnText) btnText.textContent = 'Tornar a provar connexió';
    }
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
  // 10. ANIMATION, AUDIO & UTILITIES
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
    const label = document.getElementById('countdown-label');
    if (label) {
      label.textContent = `Actualització en ${this.secondsRemaining}s`;
    }
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

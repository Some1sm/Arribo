// Bad AMB Bus Tracker - Unified Multi-Line Application Controller (C-10 + Mataró Bus L1..L8)

class TransitApp {
  constructor() {
    this.activeLineId = localStorage.getItem('bad_amb_active_line') || 'c10';
    this.currentDirection = localStorage.getItem('bad_amb_direction') || '1';
    this.availableLines = [];
    this.activeLineData = null;
    
    this.targetStopsByLine = JSON.parse(localStorage.getItem('bad_amb_target_stops') || '{}');
    this.allStops = [];
    this.activeBuses = [];
    this.pollInterval = 15; // 15 seconds refresh
    this.secondsRemaining = this.pollInterval;
    this.pollTimer = null;
    this.clockTimer = null;
    this.searchDebounceTimer = null;
    
    this.soundEnabled = localStorage.getItem('c10_sound') === 'true';
    this.audioContext = null;
    this.lastAlertedTrip = null;

    this.mapController = null;
    this.init();
  }

  async init() {
    console.log('🚀 Initializing Bad AMB Bus Tracker (C-10 + Mataró Bus L1..L8)...');

    // 1. Initialize Map
    this.mapController = new C10Map('map-container');

    // 2. Setup DOM Listeners & Controls
    this.setupEventListeners();
    this.setupMapResizeControls();
    this.setupAudio();

    // 3. Load Available Lines
    await this.fetchLines();

    // 4. Initial Line & Telemetry Refresh
    await this.refreshAllData(true);

    // 5. Start Auto-Polling & Glider Animation
    this.startAutoRefresh();
    this.startAnimationLoop();
  }

  // ==========================================
  // 1. LINES & SELECTION
  // ==========================================

  async fetchLines() {
    try {
      const res = await fetch('/api/lines');
      const json = await res.json();
      if (json.success && json.lines) {
        this.availableLines = json.lines;
        this.renderLinePills();
      }
    } catch (e) {
      console.error('Error fetching lines:', e);
    }
  }

  renderLinePills() {
    const container = document.getElementById('line-pills-container');
    if (!container) return;

    container.innerHTML = this.availableLines.map(l => {
      const isActive = String(l.id) === String(this.activeLineId);
      const isC10 = l.id === 'c10';
      return `
        <button class="line-pill-btn ${isActive ? 'active' : ''}" data-line-id="${l.id}" style="${isActive ? `border-color:${l.color}; background:rgba(${this.hexToRgb(l.color)}, 0.18);` : ''}">
          <span class="line-pill-code" style="background:${l.color};">${l.code}</span>
          <span>${isC10 ? 'Barcelona ⇄ Mataró' : l.name}</span>
        </button>
      `;
    }).join('');

    container.querySelectorAll('.line-pill-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const lineId = btn.getAttribute('data-line-id');
        this.switchLine(lineId);
      });
    });
  }

  async switchLine(lineId) {
    if (this.activeLineId === lineId) return;
    this.activeLineId = lineId;
    localStorage.setItem('bad_amb_active_line', lineId);

    // Update Pills UI
    this.renderLinePills();

    // Reset Direction to 0 or 1
    const lineObj = this.availableLines.find(l => String(l.id) === String(lineId));
    if (lineObj && lineObj.directions && lineObj.directions.length > 0) {
      this.currentDirection = lineObj.directions[0].dirId || '0';
    }

    // Refresh UI & Map
    await this.refreshAllData(true);
  }

  // ==========================================
  // 2. DATA REFRESH ENGINE (C-10 vs MATARÓ BUS)
  // ==========================================

  async refreshAllData(shouldFitBounds = false) {
    this.setLiveStatus('syncing');

    try {
      if (this.activeLineId === 'c10') {
        await this.refreshC10Data(shouldFitBounds);
      } else {
        await this.refreshMataroLineData(shouldFitBounds);
      }

      this.setLiveStatus('online');
      this.secondsRemaining = this.pollInterval;
      this.updateCountdownLabel();
    } catch (err) {
      console.error('Data refresh error:', err);
      this.setLiveStatus('offline');
    }
  }

  // Refresh C-10 Corridor Data
  async refreshC10Data(shouldFitBounds = false) {
    const targetStopId = this.targetStopsByLine['c10'] || null;

    // 1. Fetch Target ETA
    const etaUrl = `/api/c10/target-eta?direction=${this.currentDirection}${targetStopId ? `&stopId=${targetStopId}` : ''}`;
    const etaRes = await fetch(etaUrl).then(r => r.json());

    // 2. Fetch Stops
    const stopsRes = await fetch(`/api/c10/stops?direction=${this.currentDirection}`).then(r => r.json());

    // 3. Fetch Live Corridor Telemetry
    const corridorRes = await fetch(`/api/c10/live-corridor?direction=${this.currentDirection}`).then(r => r.json());

    if (stopsRes.success) {
      this.allStops = stopsRes.stops || [];
      this.populateTargetStopSelect(this.allStops, targetStopId || '10037202');
      this.renderStopsBrowser(this.allStops);
    }

    if (etaRes.success && etaRes.data) {
      this.renderTargetStopCard(etaRes.data);
    }

    if (corridorRes.success && corridorRes.data) {
      this.activeBuses = corridorRes.data.activeBuses || [];
      this.renderTelemetryInspector(corridorRes.data);
      this.renderCorridorTimeline(corridorRes.data);
      this.updateActiveBusesCount(corridorRes.data.totalActiveBuses || 0);
      this.checkArrivalAlerts(corridorRes.data);
    }

    // Update Header
    this.updateHeaderBrand('C-10', '#009485', 'Barcelona ↔ Badalona ↔ Maresme ↔ Mataró', 'Maresme Directe');
    this.updateDirectionButtons([
      { id: '1', name: "Cap a Mataró (Hospital / Pl. d'Itàlia)" },
      { id: '0', name: 'Cap a Barcelona (Metro la Pau)' }
    ]);

    // Map Render
    const activeTargetId = targetStopId || (etaRes.data?.targetStop?.mouteStopId || '10037202');
    this.mapController.renderStops(this.allStops, activeTargetId, (s) => this.inspectStop(s.mouteStopId, s.name), shouldFitBounds, '#009485');
    this.mapController.updateBusMarkers(this.activeBuses, '#009485');
  }

  // Refresh Mataró Bus (L1..L8) Data
  async refreshMataroLineData(shouldFitBounds = false) {
    const lId = this.activeLineId;
    const targetStopId = this.targetStopsByLine[lId] || null;

    // 1. Fetch Line Details (Stops, Polyline, Active Buses with Dead-Zone Estimation)
    const lineUrl = `/api/mataro/line/${lId}?direction=${this.currentDirection}`;
    const lineRes = await fetch(lineUrl).then(r => r.json());

    // 2. Fetch Target ETA
    const etaUrl = `/api/mataro/target-eta?lineId=${lId}&direction=${this.currentDirection}${targetStopId ? `&stopId=${targetStopId}` : ''}`;
    const etaRes = await fetch(etaUrl).then(r => r.json());

    if (lineRes.success && lineRes.data) {
      const lData = lineRes.data;
      this.activeLineData = lData;
      this.allStops = lData.stops || [];
      this.activeBuses = lData.activeBuses || [];

      // Header Brand
      this.updateHeaderBrand(lData.code, lData.color, `Mataró Bus Urbà • ${lData.name}`, 'Mataró Urbà');

      // Direction Buttons
      const lineObj = this.availableLines.find(l => String(l.id) === String(lId));
      if (lineObj && lineObj.directions) {
        this.updateDirectionButtons(lineObj.directions.map(d => ({ id: d.dirId, name: d.name })));
      }

      // Populate Select & Browser
      const activeTargetId = targetStopId || (etaRes.data?.targetStop?.id || (this.allStops[0]?.id));
      this.populateTargetStopSelect(this.allStops, activeTargetId);
      this.renderStopsBrowser(this.allStops);

      // Render Telemetry & Timeline
      this.renderMataroTelemetryInspector(lData);
      this.renderMataroTimeline(lData, activeTargetId);
      this.updateActiveBusesCount(lData.totalActiveBuses || 0);

      // Map Render with High-Res Polyline
      this.mapController.renderStops(this.allStops, activeTargetId, (s) => this.inspectStop(s.id, s.name), shouldFitBounds, lData.color, lData.polyline);
      this.mapController.updateBusMarkers(this.activeBuses, lData.color);
    }

    if (etaRes.success && etaRes.data) {
      this.renderTargetStopCard(etaRes.data);
    }
  }

  // ==========================================
  // 3. UI RENDERING COMPONENTS
  // ==========================================

  updateHeaderBrand(code, color, subtitle, tag) {
    const badge = document.getElementById('line-badge');
    const sub = document.getElementById('app-subtitle');
    const tagBadge = document.getElementById('line-tag-badge');
    const mapTitle = document.getElementById('map-line-title');

    if (badge) {
      badge.textContent = code;
      badge.style.background = color;
    }
    if (sub) sub.textContent = subtitle;
    if (tagBadge) tagBadge.textContent = tag;
    if (mapTitle) mapTitle.textContent = `Traçat línia ${code} i parades`;
  }

  updateDirectionButtons(directions) {
    const container = document.getElementById('direction-toggle-group');
    if (!container || !directions || directions.length === 0) return;

    container.innerHTML = directions.map((d, i) => {
      const isActive = String(d.id) === String(this.currentDirection);
      return `
        <button class="btn-direction ${isActive ? 'active' : ''}" data-direction="${d.id}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="${i === 0 ? 'm9 18 6-6-6-6' : 'm15 18-6-6 6-6'}"/></svg>
          <span>${d.name}</span>
        </button>
      `;
    }).join('');

    container.querySelectorAll('.btn-direction').forEach(btn => {
      btn.addEventListener('click', () => {
        const dir = btn.getAttribute('data-direction');
        this.switchDirection(dir);
      });
    });
  }

  switchDirection(dir) {
    if (this.currentDirection === dir) return;
    this.currentDirection = dir;
    localStorage.setItem('bad_amb_direction', dir);
    this.refreshAllData(true);
  }

  // Target Stop Hero Card
  renderTargetStopCard(data) {
    const titleEl = document.getElementById('target-stop-title');
    const codeEl = document.getElementById('target-stop-code');
    const dirSubEl = document.getElementById('target-direction-sub');
    const etaBigEl = document.getElementById('eta-big-display');
    const etaClockEl = document.getElementById('eta-clock-display');
    const etaPillEl = document.getElementById('eta-status-pill');
    const etaStatusText = document.getElementById('eta-status-text');
    const lineTagEl = document.getElementById('next-bus-line-tag');
    const destEl = document.getElementById('next-bus-dest');
    const operatorEl = document.getElementById('next-bus-operator');
    const mapsLinkEl = document.getElementById('target-maps-link');

    const stop = data.targetStop || {};
    const next = data.nextBus || null;

    if (titleEl) titleEl.textContent = stop.name || 'Parada Seleccionada';
    if (codeEl) codeEl.textContent = stop.code || stop.id || '--';
    if (dirSubEl) dirSubEl.textContent = data.directionName || 'En servei';

    if (lineTagEl) {
      lineTagEl.textContent = data.line?.code || (this.activeLineId === 'c10' ? 'C-10' : `L${this.activeLineId}`);
      if (data.line?.color) lineTagEl.style.color = data.line.color;
    }

    if (destEl) destEl.textContent = next?.destination || data.directionName || 'En ruta';
    if (operatorEl) operatorEl.textContent = this.activeLineId === 'c10' ? 'Empresa Casas (Moventis)' : 'Mataró Bus (Avanza)';

    if (mapsLinkEl && stop.lat && stop.lon) {
      mapsLinkEl.href = `https://www.google.com/maps/search/?api=1&query=${stop.lat},${stop.lon}`;
    }

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

    // Render Departures List
    this.renderDeparturesList(data.upcomingDepartures || []);
  }

  renderDeparturesList(departures) {
    const container = document.getElementById('departures-list-container');
    const badge = document.getElementById('dep-count-badge');
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

  // Telemetry Inspector for C-10
  renderTelemetryInspector(corridorData) {
    const b = (corridorData.activeBuses && corridorData.activeBuses[0]) || null;
    this.updateTelemetryFields(b, 'C-10 Corredor N-II');
  }

  // Telemetry Inspector for Mataró Bus (with Dead-Zone Radar Indicator)
  renderMataroTelemetryInspector(lineData) {
    const b = (lineData.activeBuses && lineData.activeBuses[0]) || null;
    this.updateTelemetryFields(b, lineData.name);
  }

  updateTelemetryFields(bus, routeTitle) {
    const coordsEl = document.getElementById('telemetry-coords');
    const bearingEl = document.getElementById('telemetry-bearing');
    const speedEl = document.getElementById('telemetry-speed');
    const segmentEl = document.getElementById('telemetry-segment');
    const etaNextEl = document.getElementById('telemetry-eta-next');
    const progressFill = document.getElementById('telemetry-progress-bar');
    const progressText = document.getElementById('telemetry-progress-text');
    const statusBadge = document.getElementById('telemetry-status-badge');
    const radarDot = document.getElementById('telemetry-radar-dot');

    if (!bus) {
      if (coordsEl) coordsEl.textContent = 'Sense vehicle actiu';
      if (bearingEl) bearingEl.textContent = '--';
      if (speedEl) speedEl.textContent = '0 km/h';
      if (segmentEl) segmentEl.textContent = routeTitle;
      if (etaNextEl) etaNextEl.textContent = '--';
      if (progressFill) progressFill.style.width = '0%';
      if (progressText) progressText.textContent = '0%';
      if (statusBadge) {
        statusBadge.textContent = '⚪ Sense dades';
        statusBadge.className = 'telemetry-status-badge';
      }
      if (radarDot) radarDot.className = 'telemetry-live-radar';
      return;
    }

    const isEst = Boolean(bus.isEstimated);

    if (coordsEl) coordsEl.textContent = bus.coordinatesFormatted || `${bus.lat.toFixed(5)}° N, ${bus.lon.toFixed(5)}° E`;
    if (bearingEl) bearingEl.textContent = `${bus.compass?.label || bus.compass?.code || 'N/A'} (${bus.bearing || 0}°)`;
    if (speedEl) speedEl.textContent = `${bus.speedKmh || 35} km/h`;
    if (segmentEl) segmentEl.textContent = `${bus.fromStop} ➔ ${bus.toStop}`;
    if (etaNextEl) etaNextEl.textContent = bus.secondsToNextStop ? `~${Math.round(bus.secondsToNextStop / 60)} min (${bus.toStop})` : `${bus.toStop}`;
    
    const prog = Math.min(100, Math.max(0, bus.totalProgress || 0));
    if (progressFill) progressFill.style.width = `${prog}%`;
    if (progressText) progressText.textContent = `${prog}%`;

    if (statusBadge) {
      statusBadge.textContent = bus.statusText || (isEst ? '⚡ Estimació Zona Cobertura' : '🟢 Senyal GPS Actiu');
      statusBadge.className = `telemetry-status-badge ${isEst ? 'estimated' : ''}`;
    }

    if (radarDot) {
      radarDot.className = `telemetry-live-radar ${isEst ? 'dead-zone' : ''}`;
    }
  }

  // Corridor Timeline for C-10
  renderCorridorTimeline(corridorData) {
    const container = document.getElementById('corridor-timeline-container');
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
        <div class="corridor-step" onclick="window.c10App.setTargetStop('${cp.id}')" style="cursor:pointer;" title="Fixar ${cp.name} com a parada principal">
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

  // Route Timeline for Mataró Bus
  renderMataroTimeline(lineData, activeTargetId) {
    const container = document.getElementById('corridor-timeline-container');
    const stops = lineData.stops || [];
    if (!container || stops.length === 0) return;

    // Pick top key checkpoints (max 10 for clean timeline view)
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
        <div class="corridor-step" onclick="window.c10App.setTargetStop('${s.id}')" style="cursor:pointer;" title="Fixar ${s.name} com a parada principal">
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

  // Populate Target Stop Select
  populateTargetStopSelect(stops, selectedId) {
    const select = document.getElementById('target-stop-select');
    if (!select) return;

    select.innerHTML = stops.map(s => {
      const id = String(s.mouteStopId || s.id || s.code);
      const isSel = id === String(selectedId);
      return `<option value="${id}" ${isSel ? 'selected' : ''}>#${s.seq || ''} ${s.name}</option>`;
    }).join('');
  }

  // Stops Browser List
  renderStopsBrowser(stops) {
    const container = document.getElementById('stops-list-scroll');
    const totalEl = document.getElementById('stops-total-count');
    if (!container) return;

    if (totalEl) totalEl.textContent = stops.length;

    const currentTargetId = this.targetStopsByLine[this.activeLineId] || '';

    container.innerHTML = stops.map((s, i) => {
      const id = String(s.mouteStopId || s.id || s.code);
      const isTarget = id === String(currentTargetId);
      return `
        <div class="stop-row-item ${isTarget ? 'target-stop' : ''}" onclick="window.c10App.inspectStop('${id}', '${s.name.replace(/'/g, "\\'")}')">
          <div class="stop-row-left">
            <span class="stop-seq-badge">#${s.seq || i + 1}</span>
            <div>
              <div class="stop-row-name">${s.name} ${isTarget ? '⭐' : ''}</div>
              <div class="stop-row-zone">${s.zone || 'Parada'} ${s.code ? `• Codi: ${s.code}` : ''}</div>
            </div>
          </div>
          <button class="btn-icon" style="width:28px; height:28px;" title="Veure arribades" onclick="event.stopPropagation(); window.c10App.inspectStop('${id}', '${s.name.replace(/'/g, "\\'")}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
      `;
    }).join('');
  }

  // ==========================================
  // 4. STOP INSPECTION & TARGET SELECTION
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
      const endpoint = this.activeLineId === 'c10'
        ? `/api/c10/stop/${stopId}/departures?direction=${this.currentDirection}`
        : `/api/mataro/stop/${stopId}/departures?lineId=${this.activeLineId}`;

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
    this.targetStopsByLine[this.activeLineId] = String(stopId);
    localStorage.setItem('bad_amb_target_stops', JSON.stringify(this.targetStopsByLine));
    this.refreshAllData(false);
  }

  // ==========================================
  // 5. GLOBAL SEARCH ENGINE
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
      item.addEventListener('click', async () => {
        const lineId = item.getAttribute('data-line-id');
        const stopId = item.getAttribute('data-stop-id');
        const stopName = item.getAttribute('data-name');
        const lat = parseFloat(item.getAttribute('data-lat'));
        const lon = parseFloat(item.getAttribute('data-lon'));

        dropdown.classList.remove('active');
        input.value = '';

        // Switch to the line and target the stop
        await this.switchLine(lineId);
        this.setTargetStop(stopId);

        if (lat && lon) {
          this.mapController.focusTargetStop(lat, lon);
        }

        this.inspectStop(stopId, stopName);
      });
    });
  }

  // ==========================================
  // 6. EVENT LISTENERS & MAP UTILITIES
  // ==========================================

  setupEventListeners() {
    // Refresh Button
    document.getElementById('btn-refresh')?.addEventListener('click', () => {
      this.refreshAllData(false);
    });

    // Sound Alarm Button
    document.getElementById('btn-sound')?.addEventListener('click', () => {
      this.toggleSound();
    });

    // Modal Close
    document.getElementById('modal-close-btn')?.addEventListener('click', () => {
      document.getElementById('stop-modal-backdrop')?.classList.remove('active');
    });

    document.getElementById('stop-modal-backdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'stop-modal-backdrop') {
        e.target.classList.remove('active');
      }
    });

    // Target Stop Dropdown Select
    document.getElementById('target-stop-select')?.addEventListener('change', (e) => {
      if (e.target.value) {
        this.setTargetStop(e.target.value);
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

    // Setup Universal Global Search
    this.setupGlobalSearch();
  }

  setupMapResizeControls() {
    const expandHeightBtn = document.getElementById('btn-map-expand-height');
    const heightLabel = document.getElementById('map-height-label');
    const expandWidthBtn = document.getElementById('btn-map-expand-width');
    const mapCard = document.getElementById('map-card');
    const mapContainer = document.getElementById('map-container');
    const explorerGrid = document.querySelector('.explorer-grid');
    const resizeBar = document.getElementById('map-resize-bar');

    // Height Toggle
    let isTall = false;
    expandHeightBtn?.addEventListener('click', () => {
      isTall = !isTall;
      mapContainer.style.height = isTall ? '580px' : '380px';
      if (heightLabel) heightLabel.textContent = isTall ? 'Normal' : 'Gran';
      this.mapController.invalidateSize();
    });

    // Width Toggle
    let isFullWidth = false;
    expandWidthBtn?.addEventListener('click', () => {
      isFullWidth = !isFullWidth;
      explorerGrid?.classList.toggle('expanded-width', isFullWidth);
      expandWidthBtn.classList.toggle('active', isFullWidth);
      this.mapController.invalidateSize();
    });

    // Draggable Resizer Bar
    if (resizeBar && mapContainer) {
      let isDragging = false;
      let startY = 0;
      let startHeight = 0;

      const onMouseDown = (e) => {
        isDragging = true;
        startY = e.clientY || e.touches[0].clientY;
        startHeight = mapContainer.offsetHeight;
        resizeBar.classList.add('dragging');
        document.body.style.cursor = 'ns-resize';
      };

      const onMouseMove = (e) => {
        if (!isDragging) return;
        const currentY = e.clientY || (e.touches && e.touches[0].clientY);
        const delta = currentY - startY;
        const newHeight = Math.max(260, Math.min(800, startHeight + delta));
        mapContainer.style.height = `${newHeight}px`;
        this.mapController.invalidateSize();
      };

      const onMouseUp = () => {
        if (isDragging) {
          isDragging = false;
          resizeBar.classList.remove('dragging');
          document.body.style.cursor = '';
        }
      };

      resizeBar.addEventListener('mousedown', onMouseDown);
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);

      resizeBar.addEventListener('touchstart', onMouseDown, { passive: true });
      window.addEventListener('touchmove', onMouseMove, { passive: true });
      window.addEventListener('touchend', onMouseUp);
    }
  }

  // ==========================================
  // 7. ANIMATION, AUDIO & UTILITIES
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
    const el = document.getElementById('countdown-label');
    if (el) el.textContent = `Actualització en ${this.secondsRemaining}s`;
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
    const statusCount = document.getElementById('active-bus-status-count');
    const statusText = document.getElementById('active-bus-status-text');

    if (headerEl) headerEl.innerHTML = `<strong>${count}</strong> bus${count === 1 ? '' : 'os'} en ruta`;
    if (mapEl) mapEl.textContent = `🚌 ${count} actiu${count === 1 ? '' : 's'}`;
    if (statusCount) statusCount.textContent = `${count} actiu${count === 1 ? '' : 's'}`;
    if (statusText) {
      statusText.textContent = count > 0
        ? `S'han detectat ${count} vehicles transmetent posició GPS en temps real o estimació.`
        : `Cap vehicle en circulació detectat actualment en aquest sentit.`;
    }
  }

  setupAudio() {
    this.updateSoundIcons();
  }

  toggleSound() {
    this.soundEnabled = !this.soundEnabled;
    localStorage.setItem('c10_sound', this.soundEnabled);
    this.updateSoundIcons();
    if (this.soundEnabled) {
      this.playChime();
    }
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
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.3); // A5
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

  checkArrivalAlerts(corridorData) {
    if (!this.soundEnabled) return;
    const targetStopId = this.targetStopsByLine[this.activeLineId] || '10037202';
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

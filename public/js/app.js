// Main Application Controller for C-10 Real-Time Tracker

class C10App {
  constructor() {
    this.currentDirection = '1'; // '1' = to Mataró (Pl. Itàlia), '0' = to Barcelona
    this.refreshInterval = 20; // seconds
    this.countdownTimer = 20;
    this.pollingTimer = null;
    this.countdownInterval = null;
    this.isSoundEnabled = false;
    this.hasAlertedForTrip = new Set();

    this.stopsData = [];
    this.targetEtaData = null;
    this.corridorData = null;
    this.mapInstance = null;
    this.selectedTargetStopId = localStorage.getItem('c10_target_stop_id') || null;

    this.initElements();
    this.bindEvents();
    this.initApp();
  }

  initElements() {
    this.dirBtn1 = document.getElementById('dir-btn-1');
    this.dirBtn0 = document.getElementById('dir-btn-0');
    this.btnRefresh = document.getElementById('btn-refresh');
    this.btnSound = document.getElementById('btn-sound');
    this.soundIconOff = document.getElementById('sound-icon-off');
    this.soundIconOn = document.getElementById('sound-icon-on');
    this.countdownLabel = document.getElementById('countdown-label');
    this.liveIndicator = document.getElementById('live-indicator');
    this.liveText = document.getElementById('live-text');

    // Hero ETA elements
    this.targetStopTitle = document.getElementById('target-stop-title');
    this.targetStopCode = document.getElementById('target-stop-code');
    this.targetDirectionSub = document.getElementById('target-direction-sub');
    this.targetStopSelect = document.getElementById('target-stop-select');
    this.targetMapsLink = document.getElementById('target-maps-link');
    this.etaBigDisplay = document.getElementById('eta-big-display');
    this.etaClockDisplay = document.getElementById('eta-clock-display');
    this.etaStatusPill = document.getElementById('eta-status-pill');
    this.etaStatusText = document.getElementById('eta-status-text');
    this.etaSchedTime = document.getElementById('eta-sched-time');
    this.etaRealtimeTime = document.getElementById('eta-realtime-time');
    this.etaDelayBadge = document.getElementById('eta-delay-badge');
    this.nextBusDest = document.getElementById('next-bus-dest');
    this.depCountBadge = document.getElementById('dep-count-badge');
    this.departuresListContainer = document.getElementById('departures-list-container');

    // Corridor & Stops list elements
    this.corridorTimelineContainer = document.getElementById('corridor-timeline-container');
    this.stopSearchInput = document.getElementById('stop-search-input');
    this.stopsListScroll = document.getElementById('stops-list-scroll');
    this.stopsTotalCount = document.getElementById('stops-total-count');
    this.activeBusStatusText = document.getElementById('active-bus-status-text');
    this.activeBusStatusCount = document.getElementById('active-bus-status-count');

    // Header & Map active buses chips
    this.headerActiveBusesText = document.getElementById('header-active-buses-text');
    this.headerActiveBusesChip = document.getElementById('header-active-buses-chip');
    this.mapBusCounterTag = document.getElementById('map-bus-counter-tag');

    // Telemetry Inspector elements
    this.telemetryCard = document.getElementById('telemetry-card');
    this.telemetryStatusBadge = document.getElementById('telemetry-status-badge');
    this.telemetryCoords = document.getElementById('telemetry-coords');
    this.telemetryBearing = document.getElementById('telemetry-bearing');
    this.telemetrySpeed = document.getElementById('telemetry-speed');
    this.telemetrySegment = document.getElementById('telemetry-segment');
    this.telemetryEtaNext = document.getElementById('telemetry-eta-next');
    this.telemetryProgressBar = document.getElementById('telemetry-progress-bar');
    this.telemetryProgressText = document.getElementById('telemetry-progress-text');

    // Map controls & resize elements
    this.mapContainer = document.getElementById('map-container');
    this.mapCard = document.getElementById('map-card');
    this.mapResizeBar = document.getElementById('map-resize-bar');
    this.btnMapExpandHeight = document.getElementById('btn-map-expand-height');
    this.mapHeightLabel = document.getElementById('map-height-label');
    this.btnMapExpandWidth = document.getElementById('btn-map-expand-width');
    this.explorerGrid = document.querySelector('.explorer-grid');

    // Modal elements
    this.stopModalBackdrop = document.getElementById('stop-modal-backdrop');
    this.modalCloseBtn = document.getElementById('modal-close-btn');
    this.modalStopTitle = document.getElementById('modal-stop-title');
    this.modalStopSubtitle = document.getElementById('modal-stop-subtitle');
    this.modalDeparturesList = document.getElementById('modal-departures-list');
    this.modalSetTargetBtn = document.getElementById('modal-set-target-btn');
    this.modalMapsLink = document.getElementById('modal-maps-link');
  }

  bindEvents() {
    this.dirBtn1.addEventListener('click', () => this.switchDirection('1'));
    this.dirBtn0.addEventListener('click', () => this.switchDirection('0'));

    if (this.targetStopSelect) {
      this.targetStopSelect.addEventListener('change', (e) => {
        if (e.target.value) {
          this.setTargetStop(e.target.value);
        }
      });
    }

    if (this.modalSetTargetBtn) {
      this.modalSetTargetBtn.addEventListener('click', () => {
        if (this.currentInspectedStop && this.currentInspectedStop.mouteStopId) {
          this.setTargetStop(this.currentInspectedStop.mouteStopId);
          this.closeModal();
        }
      });
    }

    this.btnRefresh.addEventListener('click', () => {
      this.btnRefresh.style.transform = 'rotate(360deg)';
      setTimeout(() => this.btnRefresh.style.transform = 'none', 500);
      this.fetchAllData();
    });

    this.btnSound.addEventListener('click', () => this.toggleSound());

    this.stopSearchInput.addEventListener('input', (e) => this.filterStops(e.target.value));

    this.modalCloseBtn.addEventListener('click', () => this.closeModal());
    this.stopModalBackdrop.addEventListener('click', (e) => {
      if (e.target === this.stopModalBackdrop) this.closeModal();
    });

    this.initMapResizeHandlers();
  }

  setTargetStop(stopId) {
    this.selectedTargetStopId = stopId;
    localStorage.setItem('c10_target_stop_id', stopId);
    if (this.targetStopSelect) {
      this.targetStopSelect.value = stopId;
    }
    this.fetchAllData(false);
  }

  initMapResizeHandlers() {
    if (!this.mapResizeBar || !this.mapContainer) return;

    // 1. Drag resize handler (mouse & touch)
    let isDragging = false;
    let startY = 0;
    let startHeight = 0;

    const onPointerDown = (clientY) => {
      isDragging = true;
      startY = clientY;
      startHeight = this.mapContainer.offsetHeight;
      this.mapResizeBar.classList.add('dragging');
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
    };

    const onPointerMove = (clientY) => {
      if (!isDragging) return;
      const deltaY = clientY - startY;
      const newHeight = Math.max(260, Math.min(850, startHeight + deltaY));
      this.mapContainer.style.height = `${newHeight}px`;
      if (this.mapInstance) {
        this.mapInstance.invalidateSize();
      }
    };

    const onPointerUp = () => {
      if (isDragging) {
        isDragging = false;
        this.mapResizeBar.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        if (this.mapInstance) {
          this.mapInstance.invalidateSize();
        }
      }
    };

    // Mouse events
    this.mapResizeBar.addEventListener('mousedown', (e) => {
      e.preventDefault();
      onPointerDown(e.clientY);
    });
    window.addEventListener('mousemove', (e) => onPointerMove(e.clientY));
    window.addEventListener('mouseup', onPointerUp);

    // Touch events for mobile/tablet
    this.mapResizeBar.addEventListener('touchstart', (e) => {
      if (e.touches.length > 0) {
        onPointerDown(e.touches[0].clientY);
      }
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      if (isDragging && e.touches.length > 0) {
        onPointerMove(e.touches[0].clientY);
      }
    }, { passive: true });
    window.addEventListener('touchend', onPointerUp);

    // 2. Quick Expand / Compact Height Toggle
    if (this.btnMapExpandHeight) {
      this.btnMapExpandHeight.addEventListener('click', () => {
        const currentH = this.mapContainer.offsetHeight;
        if (currentH < 550) {
          this.mapContainer.style.height = '620px';
          this.mapHeightLabel.textContent = 'Compact';
        } else {
          this.mapContainer.style.height = '380px';
          this.mapHeightLabel.textContent = 'Gran';
        }
        setTimeout(() => {
          if (this.mapInstance) this.mapInstance.invalidateSize();
        }, 50);
      });
    }

    // 3. Quick Full Width Toggle
    if (this.btnMapExpandWidth && this.explorerGrid) {
      this.btnMapExpandWidth.addEventListener('click', () => {
        this.explorerGrid.classList.toggle('expanded-width');
        this.btnMapExpandWidth.classList.toggle('active');
        setTimeout(() => {
          if (this.mapInstance) this.mapInstance.invalidateSize();
        }, 50);
      });
    }

    // 4. ResizeObserver for automatic map canvas responsiveness
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => {
        if (this.mapInstance) {
          this.mapInstance.invalidateSize();
        }
      });
      ro.observe(this.mapContainer);
    }
  }

  async initApp() {
    // Initialize Map
    if (window.C10Map) {
      this.mapInstance = new window.C10Map('map-container');
    }

    // Load initial data with fitBounds = true
    await this.fetchAllData(true);

    // Start auto refresh loops
    this.startAutoRefresh();
  }

  async switchDirection(dir) {
    if (this.currentDirection === dir) return;
    this.currentDirection = dir;

    const corridorTitle = document.getElementById('corridor-title-text');
    const zonePill1 = document.getElementById('zone-pill-1');
    const zonePill2 = document.getElementById('zone-pill-2');

    if (dir === '1') {
      this.dirBtn1.classList.add('active');
      this.dirBtn0.classList.remove('active');
      this.targetDirectionSub.textContent = 'Sentit Mataró (Hospital / Pl. Itàlia)';
      if (corridorTitle) corridorTitle.textContent = 'Seguiment en ruta pel Corredor N-II (Barcelona → Mataró)';
      if (zonePill1) { zonePill1.textContent = 'Àrea AMB (Fins a Montgat)'; zonePill1.className = 'zone-tag amb'; }
      if (zonePill2) { zonePill2.textContent = 'Zona Maresme (El Masnou - Mataró)'; zonePill2.className = 'zone-tag maresme'; }
    } else {
      this.dirBtn0.classList.add('active');
      this.dirBtn1.classList.remove('active');
      this.targetDirectionSub.textContent = 'Sentit Barcelona (Metro la Pau)';
      if (corridorTitle) corridorTitle.textContent = 'Seguiment en ruta pel Corredor N-II (Mataró → Barcelona)';
      if (zonePill1) { zonePill1.textContent = 'Zona Maresme (Mataró - El Masnou)'; zonePill1.className = 'zone-tag maresme'; }
      if (zonePill2) { zonePill2.textContent = 'Àrea AMB (Montgat - Barcelona)'; zonePill2.className = 'zone-tag amb'; }
    }

    // Explicit direction switch: reset stops and fit bounds
    if (this.mapInstance) {
      this.mapInstance.lastStopsFingerprint = null;
    }
    await this.fetchAllData(true);
  }

  async fetchAllData(shouldFitBounds = false) {
    this.setLoadingState(true);
    const logTime = new Date().toLocaleTimeString();
    const dirName = this.currentDirection === '1' ? 'Sentit 1: Cap a Mataró' : 'Sentit 0: Cap a Barcelona';

    try {
      console.group(`%c🚌 [C-10 Live API Refresh] %c${logTime} — ${dirName}`, 'background:#009485; color:#fff; padding:2px 6px; border-radius:4px; font-weight:bold;', 'color:#38bdf8; font-weight:bold;');

      // 1. Fetch Target Stop ETA
      const targetQueryParam = this.selectedTargetStopId ? `&stopId=${encodeURIComponent(this.selectedTargetStopId)}` : '';
      console.log(`%c[1/3] GET /api/c10/target-eta?direction=${this.currentDirection}${targetQueryParam}`, 'color:#a78bfa; font-weight:bold;');
      const etaRes = await fetch(`/api/c10/target-eta?direction=${this.currentDirection}${targetQueryParam}`);
      const etaJson = await etaRes.json();
      if (etaJson.success) {
        this.targetEtaData = etaJson.data;
        console.log('  📍 Target Stop ETA Result:', {
          targetStop: this.targetEtaData.targetStop?.name,
          nextBus: this.targetEtaData.nextBus?.departureTime,
          scheduledTime: this.targetEtaData.nextBus?.scheduledTime,
          delayBadge: this.targetEtaData.nextBus?.delayBadgeText,
          status: this.targetEtaData.nextBus?.formattedStatus,
          isRealtime: this.targetEtaData.nextBus?.isRealtime,
          allDeparturesCount: this.targetEtaData.upcomingDepartures?.length
        }, this.targetEtaData);
        this.renderTargetETA();
      }

      // 2. Fetch All Stops on Route
      console.log(`%c[2/3] GET /api/c10/stops?direction=${this.currentDirection}`, 'color:#a78bfa; font-weight:bold;');
      const stopsRes = await fetch(`/api/c10/stops?direction=${this.currentDirection}`);
      const stopsJson = await stopsRes.json();
      if (stopsJson.success) {
        this.stopsData = stopsJson.stops;
        console.log(`  🚏 Stops Loaded (${this.stopsData.length} parades):`, this.stopsData);
        
        // Populate Target Stop dropdown selector
        if (this.targetStopSelect && this.stopsData.length > 0) {
          const currentTargetId = this.targetEtaData?.targetStop?.mouteStopId || this.selectedTargetStopId;
          this.targetStopSelect.innerHTML = this.stopsData.map(s => `
            <option value="${s.mouteStopId}" ${s.mouteStopId === currentTargetId ? 'selected' : ''}>
              ${s.seq + 1}. ${s.name}${s.code ? ` (${s.code})` : ''}
            </option>
          `).join('');
        }

        this.renderStopsList(this.stopsData);
        if (this.mapInstance) {
          this.mapInstance.renderStops(
            this.stopsData,
            this.targetEtaData?.targetStop?.mouteStopId,
            (stop) => this.inspectStop(stop.mouteStopId, stop.name),
            shouldFitBounds
          );
        }
      }

      // 3. Fetch Live Corridor Checkpoints & Active Buses
      console.log(`%c[3/3] GET /api/c10/live-corridor?direction=${this.currentDirection}`, 'color:#a78bfa; font-weight:bold;');
      const corridorRes = await fetch(`/api/c10/live-corridor?direction=${this.currentDirection}`);
      const corridorJson = await corridorRes.json();
      if (corridorJson.success) {
        this.corridorData = corridorJson.data;
        const activeCount = this.corridorData.activeBuses ? this.corridorData.activeBuses.length : 0;
        console.log(`  🛣️ Live Corridor Checkpoints (${this.corridorData.checkpoints?.length || 0} nodes, %c${activeCount} busos actius en ruta%c):`, 'color:#34d399; font-weight:bold;', 'color:inherit;', {
          activeBuses: this.corridorData.activeBuses,
          checkpoints: this.corridorData.checkpoints
        });
        this.renderCorridorTimeline();
        if (this.mapInstance && this.corridorData.activeBuses) {
          this.mapInstance.updateBusMarkers(this.corridorData.activeBuses);
        }
      }

      // 4. Refresh open stop modal if currently open
      if (this.currentInspectedStop && this.stopModalBackdrop.classList.contains('active')) {
        console.log(`  🔍 Re-fetching inspected stop modal: ${this.currentInspectedStop.stopName} (${this.currentInspectedStop.mouteStopId})`);
        this.inspectStop(this.currentInspectedStop.mouteStopId, this.currentInspectedStop.stopName, true);
      }

      console.groupEnd();
      this.checkArrivalAlerts();
      this.setLiveStatus(true);
    } catch (err) {
      console.error('❌ Error fetching tracker data:', err);
      console.groupEnd();
      this.setLiveStatus(false);
    } finally {
      this.setLoadingState(false);
      this.countdownTimer = this.refreshInterval;
    }
  }

  renderTargetETA() {
    if (!this.targetEtaData) return;

    const { targetStop, nextBus, upcomingDepartures } = this.targetEtaData;

    this.targetStopTitle.textContent = targetStop.name;
    this.targetStopCode.textContent = targetStop.code || '--';
    if (this.targetDirectionSub) {
      this.targetDirectionSub.textContent = targetStop.directionName || (this.currentDirection === '1' ? 'Sentit Mataró' : 'Sentit Barcelona');
    }
    if (this.targetMapsLink && targetStop.googleMapsUrl) {
      this.targetMapsLink.href = targetStop.googleMapsUrl;
    }

    if (nextBus) {
      this.etaBigDisplay.textContent = nextBus.formattedStatus;
      this.etaClockDisplay.textContent = `Hora estimada: ${nextBus.departureTime}`;
      this.nextBusDest.textContent = nextBus.destination;

      // Populate schedule comparison box
      if (this.etaSchedTime) this.etaSchedTime.textContent = nextBus.scheduledTime || nextBus.departureTime;
      if (this.etaRealtimeTime) this.etaRealtimeTime.textContent = nextBus.departureTime;
      if (this.etaDelayBadge) {
        this.etaDelayBadge.textContent = nextBus.delayBadgeText || 'Programat';
        this.etaDelayBadge.className = `sched-delay-badge ${nextBus.delayStatus || 'scheduled'}`;
      }

      if (nextBus.minutesAway <= 5 && nextBus.minutesAway >= 0) {
        this.etaBigDisplay.classList.add('live');
      } else {
        this.etaBigDisplay.classList.remove('live');
      }

      if (nextBus.isRealtime) {
        this.etaStatusPill.className = 'eta-status-pill realtime';
        this.etaStatusText.textContent = 'En directe (GPS)';
      } else {
        this.etaStatusPill.className = 'eta-status-pill scheduled';
        this.etaStatusText.textContent = 'Horari programat';
      }
    } else {
      this.etaBigDisplay.textContent = 'Sense servei';
      this.etaClockDisplay.textContent = 'No hi ha més sortides avui';
      if (this.etaSchedTime) this.etaSchedTime.textContent = '--:--';
      if (this.etaRealtimeTime) this.etaRealtimeTime.textContent = '--:--';
      if (this.etaDelayBadge) {
        this.etaDelayBadge.textContent = 'Sense servei';
        this.etaDelayBadge.className = 'sched-delay-badge scheduled';
      }
      this.etaStatusPill.className = 'eta-status-pill scheduled';
      this.etaStatusText.textContent = 'Finalitzat';
    }

    // Render Upcoming Departures List
    this.depCountBadge.textContent = `${upcomingDepartures.length} properes`;
    this.departuresListContainer.innerHTML = '';

    if (upcomingDepartures.length === 0) {
      this.departuresListContainer.innerHTML = `
        <div style="text-align:center; padding: 1.5rem; color:var(--text-muted); font-size:0.85rem;">
          No queden més sortides programades per avui.
        </div>
      `;
      return;
    }

    upcomingDepartures.forEach(dep => {
      const isSoon = dep.minutesAway <= 10 && dep.minutesAway >= 0;
      const item = document.createElement('div');
      item.className = 'departure-item';
      item.innerHTML = `
        <div class="dep-time-group">
          <span class="dep-clock">${dep.departureTime}</span>
          <div>
            <div class="dep-dest" title="${dep.destination}">${dep.destination}</div>
            <div class="dep-sched-tag">Teòric: <strong>${dep.scheduledTime || dep.departureTime}</strong></div>
          </div>
        </div>
        <div class="dep-status">
          <span class="dep-mins ${isSoon ? 'soon' : ''}">${dep.formattedStatus}</span>
          <div style="display:flex; align-items:center; gap:0.35rem; margin-top:3px;">
            <span class="dep-delay-pill ${dep.delayStatus || 'scheduled'}">${dep.delayBadgeText || 'Programat'}</span>
            <span class="dep-type-badge">${dep.isRealtime ? '🟢 GPS' : '📅 Teòric'}</span>
          </div>
        </div>
      `;
      this.departuresListContainer.appendChild(item);
    });
  }

  renderCorridorTimeline() {
    if (!this.corridorData || !this.corridorData.checkpoints) return;

    const activeBuses = this.corridorData.activeBuses || [];
    const count = activeBuses.length;

    // 1. Update Header Chip
    if (this.headerActiveBusesText && this.headerActiveBusesChip) {
      if (count > 0) {
        this.headerActiveBusesText.innerHTML = `<strong>${count}</strong> ${count === 1 ? 'bus' : 'busos'} en ruta`;
        this.headerActiveBusesChip.classList.add('has-active');
      } else {
        this.headerActiveBusesText.innerHTML = `<strong>0</strong> busos en ruta`;
        this.headerActiveBusesChip.classList.remove('has-active');
      }
    }

    // 2. Update Map Header Tag
    if (this.mapBusCounterTag) {
      this.mapBusCounterTag.textContent = `🚌 ${count} ${count === 1 ? 'bus actiu' : 'busos actius'}`;
    }

    // 3. Update Corridor Section Banner & Telemetry Inspector
    if (this.activeBusStatusText && this.activeBusStatusCount) {
      if (count > 0) {
        const primaryBus = activeBuses[0];

        if (primaryBus.isTerminalLayover) {
          this.activeBusStatusText.innerHTML = `🅿️ <strong>Bus a la terminal (${primaryBus.fromStop}):</strong> En pausa i regulació de capçalera per iniciar el proper servei.`;
          this.activeBusStatusCount.textContent = `1 bus a terminal`;

          if (this.telemetryCoords) this.telemetryCoords.textContent = primaryBus.coordinatesFormatted;
          if (this.telemetryBearing) this.telemetryBearing.textContent = '🅿️ Estacionat a Capçalera';
          if (this.telemetrySpeed) this.telemetrySpeed.textContent = '0 km/h (Aturat a terminal)';
          if (this.telemetrySegment) this.telemetrySegment.innerHTML = `🅿️ Terminal: <strong>${primaryBus.fromStop}</strong>`;
          if (this.telemetryEtaNext) this.telemetryEtaNext.textContent = '🅿️ En espera de sortida';
          if (this.telemetryProgressBar && this.telemetryProgressText) {
            this.telemetryProgressBar.style.width = '100%';
            this.telemetryProgressText.textContent = '100% (Completat)';
          }
          if (this.telemetryStatusBadge) {
            this.telemetryStatusBadge.textContent = '🅿️ En Regulació a Capçalera';
            this.telemetryStatusBadge.className = 'telemetry-status-badge';
            this.telemetryStatusBadge.style.background = 'rgba(59, 130, 246, 0.15)';
            this.telemetryStatusBadge.style.color = '#60a5fa';
            this.telemetryStatusBadge.style.borderColor = 'rgba(59, 130, 246, 0.35)';
          }
        } else {
          this.activeBusStatusText.innerHTML = `🚌 <strong>${count} bus en trajecte:</strong> Entre <em>${primaryBus.fromStop}</em> i <em>${primaryBus.toStop}</em> (${primaryBus.totalProgress}% completat) • Propera parada en ~${Math.round(primaryBus.secondsToNextStop / 60)} min`;
          this.activeBusStatusCount.textContent = `${count} bus actiu`;

          // Populate Live GPS Telemetry Inspector
          if (this.telemetryCoords) {
            this.telemetryCoords.textContent = primaryBus.coordinatesFormatted || `${primaryBus.lat?.toFixed(5)}° N, ${primaryBus.lon?.toFixed(5)}° E`;
          }
          if (this.telemetryBearing) {
            this.telemetryBearing.textContent = `${primaryBus.compass?.label || 'NE'} (${primaryBus.bearing || 0}°)`;
          }
          if (this.telemetrySpeed) {
            this.telemetrySpeed.textContent = `~${primaryBus.speedKmh || 38} km/h`;
          }
          if (this.telemetrySegment) {
            this.telemetrySegment.innerHTML = `${primaryBus.fromStop} <span style="color:#38bdf8;">➔</span> ${primaryBus.toStop}`;
          }
          if (this.telemetryEtaNext) {
            const minsNext = Math.max(0, Math.round(primaryBus.secondsToNextStop / 60));
            this.telemetryEtaNext.textContent = `~${minsNext} min (${primaryBus.distanceToNextMeters || 0} m)`;
          }
          if (this.telemetryProgressBar && this.telemetryProgressText) {
            this.telemetryProgressBar.style.width = `${primaryBus.totalProgress || 0}%`;
            this.telemetryProgressText.textContent = `${primaryBus.totalProgress || 0}%`;
          }
          if (this.telemetryStatusBadge) {
            this.telemetryStatusBadge.textContent = '🟢 Senyal GPS Actiu';
            this.telemetryStatusBadge.className = 'telemetry-status-badge';
            this.telemetryStatusBadge.style.background = '';
            this.telemetryStatusBadge.style.color = '';
            this.telemetryStatusBadge.style.borderColor = '';
          }
        }
      } else {
        const nextDep = this.targetEtaData?.nextBus?.departureTime || '--:--';
        const nextDiff = this.targetEtaData?.nextBus?.formattedStatus || '';
        this.activeBusStatusText.innerHTML = `ℹ️ <strong>0 busos circulant ara mateix pel corredor.</strong> Propera sortida programada: <strong>${nextDep}</strong> (${nextDiff})`;
        this.activeBusStatusCount.textContent = `0 busos en ruta`;

        // Telemetry idle state
        if (this.telemetryCoords) this.telemetryCoords.textContent = 'Cap vehicle en moviment';
        if (this.telemetryBearing) this.telemetryBearing.textContent = '--';
        if (this.telemetrySpeed) this.telemetrySpeed.textContent = '0 km/h (Aturat a cotxeres / terminal)';
        if (this.telemetrySegment) this.telemetrySegment.textContent = `Esperant propera sortida de ${nextDep}`;
        if (this.telemetryEtaNext) this.telemetryEtaNext.textContent = nextDiff || '--';
        if (this.telemetryProgressBar && this.telemetryProgressText) {
          this.telemetryProgressBar.style.width = '0%';
          this.telemetryProgressText.textContent = '0%';
        }
        if (this.telemetryStatusBadge) {
          this.telemetryStatusBadge.textContent = '⚪ En Espera';
          this.telemetryStatusBadge.className = 'telemetry-status-badge idle';
        }
      }
    }

    this.corridorTimelineContainer.innerHTML = '';

    const currentTargetMouteId = this.targetEtaData?.targetStop?.mouteStopId || this.selectedTargetStopId;

    this.corridorData.checkpoints.forEach((cp, index) => {
      const step = document.createElement('div');
      step.className = 'corridor-step';

      const isTarget = Boolean(currentTargetMouteId && cp.id === currentTargetMouteId);
      const isPassed = cp.nextBus?.isPassed || false;
      const hasBus = activeBuses.some(b => b.toSeq >= cp.seq - 1 && b.fromSeq <= cp.seq);
      const etaTime = cp.nextBus ? cp.nextBus.departureTime : 'Sense dades';
      const delayTag = cp.nextBus ? `<span class="dep-delay-pill ${isPassed ? 'passed' : (cp.nextBus.delayStatus || 'scheduled')}">${cp.nextBus.delayBadgeText || 'Programat'}</span>` : '';
      const schedSub = cp.nextBus ? `<span style="font-size:0.68rem; color:var(--text-muted); display:block; margin-top:2px;">Teòric: ${cp.nextBus.scheduledTime || cp.nextBus.departureTime}</span>` : '';

      step.innerHTML = `
        <div class="step-node ${isTarget ? 'target' : ''} ${hasBus ? 'has-bus' : isPassed ? 'passed' : ''}" title="${cp.name}">
          ${hasBus ? '🚌' : isPassed ? '✓' : isTarget ? '⭐' : index + 1}
        </div>
        <div class="step-info">
          <span class="step-name">${cp.name.replace(' - ', '<br>')}</span>
          <span class="step-eta" style="${isPassed ? 'color:#34d399;' : ''}">${etaTime}</span>
          ${schedSub}
          <div style="margin-top:2px;">${delayTag}</div>
          <span class="step-zone" style="margin-top:2px;">${cp.zone}</span>
        </div>
      `;

      this.corridorTimelineContainer.appendChild(step);
    });
  }

  renderStopsList(stops) {
    this.stopsTotalCount.textContent = stops.length;
    this.stopsListScroll.innerHTML = '';

    const currentTargetMouteId = this.targetEtaData?.targetStop?.mouteStopId || this.selectedTargetStopId;

    stops.forEach((stop, index) => {
      const isTarget = stop.mouteStopId === currentTargetMouteId;
      const isMaresme = stop.lon ? stop.lon >= 2.289 : (stop.name && (stop.name.toLowerCase().includes('mataró') || stop.name.toLowerCase().includes('itàlia') || stop.name.toLowerCase().includes('masnou') || stop.name.toLowerCase().includes('premià') || stop.name.toLowerCase().includes('vilassar') || stop.name.toLowerCase().includes('cabrera')));

      const row = document.createElement('div');
      row.className = `stop-row-item ${isTarget ? 'target-stop' : ''}`;
      row.innerHTML = `
        <div class="stop-row-left">
          <span class="stop-seq-badge">#${stop.seq}</span>
          <div>
            <div class="stop-row-name">${isTarget ? '⭐ ' : ''}${stop.name}</div>
            <div class="stop-row-zone">${isMaresme ? 'Zona Maresme' : 'Zona AMB'}${stop.code ? ` • Codi: ${stop.code}` : ''}</div>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:0.4rem;">
          <button class="stop-item-fav-btn ${isTarget ? 'is-target' : ''}" title="${isTarget ? 'Parada principal actual' : 'Fixar com a parada principal'}" data-stop-id="${stop.mouteStopId}">
            ${isTarget ? '⭐' : '☆'}
          </button>
          <button class="stop-view-btn" style="background:transparent; border:none; color:var(--c10-primary); font-weight:700; font-size:0.8rem; cursor:pointer;">
            Veure ➔
          </button>
        </div>
      `;

      // Favorite star button handler
      const favBtn = row.querySelector('.stop-item-fav-btn');
      if (favBtn) {
        favBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (stop.mouteStopId) {
            this.setTargetStop(stop.mouteStopId);
          }
        });
      }

      row.addEventListener('click', () => {
        if (stop.mouteStopId) {
          this.inspectStop(stop.mouteStopId, stop.name);
        }
        if (this.mapInstance && stop.lat && stop.lon) {
          this.mapInstance.focusTargetStop(stop.lat, stop.lon);
        }
      });

      this.stopsListScroll.appendChild(row);
    });
  }

  filterStops(query) {
    const q = query.toLowerCase().trim();
    if (!q) {
      this.renderStopsList(this.stopsData);
      return;
    }

    const filtered = this.stopsData.filter(s =>
      s.name.toLowerCase().includes(q) ||
      (s.code && s.code.toString().includes(q))
    );
    this.renderStopsList(filtered);
  }

  async inspectStop(mouteStopId, stopName, isSilentRefresh = false) {
    this.currentInspectedStop = { mouteStopId, stopName };
    this.modalStopTitle.textContent = stopName;
    this.modalStopSubtitle.textContent = `ID de sistema: ${mouteStopId}`;

    const currentTargetMouteId = this.targetEtaData?.targetStop?.mouteStopId || this.selectedTargetStopId;
    const isTarget = mouteStopId === currentTargetMouteId;

    if (this.modalSetTargetBtn) {
      if (isTarget) {
        this.modalSetTargetBtn.innerHTML = '⭐ Parada Principal Actual';
        this.modalSetTargetBtn.style.opacity = '0.7';
      } else {
        this.modalSetTargetBtn.innerHTML = '⭐ Fixar com a Parada Principal';
        this.modalSetTargetBtn.style.opacity = '1';
      }
    }

    const matchedStop = this.stopsData.find(s => s.mouteStopId === mouteStopId);
    if (this.modalMapsLink && matchedStop && matchedStop.lat && matchedStop.lon) {
      this.modalMapsLink.href = `https://www.google.com/maps/search/?api=1&query=${matchedStop.lat},${matchedStop.lon}`;
      this.modalMapsLink.style.display = 'inline-flex';
    } else if (this.modalMapsLink) {
      this.modalMapsLink.style.display = 'none';
    }
    
    if (!isSilentRefresh) {
      this.modalDeparturesList.innerHTML = '<div style="color:var(--text-muted); padding:10px;">Consultant temps en directe...</div>';
      this.stopModalBackdrop.classList.add('active');
    }

    try {
      const res = await fetch(`/api/c10/stop/${mouteStopId}/departures?direction=${this.currentDirection}`);
      const json = await res.json();

      if (json.success && json.data && json.data.departures) {
        const departures = json.data.departures;
        console.log(`%c🚏 [Stop Departures Modal] %c${stopName} (${mouteStopId}) -> ${departures.length} sortides trobades:`, 'color:#ec4899; font-weight:bold;', 'color:inherit;', departures);
        this.modalDeparturesList.innerHTML = '';

        if (departures.length === 0) {
          this.modalDeparturesList.innerHTML = '<div style="color:var(--text-muted); padding:10px;">No s\'han trobat sortides properes per a aquesta parada.</div>';
          return;
        }

        departures.slice(0, 8).forEach(dep => {
          const item = document.createElement('div');
          item.className = 'departure-item';
          item.innerHTML = `
            <div class="dep-time-group">
              <span class="dep-clock">${dep.departureTime}</span>
              <div>
                <div class="dep-dest">${dep.destination}</div>
                <div class="dep-sched-tag">Teòric: <strong>${dep.scheduledTime || dep.departureTime}</strong></div>
              </div>
            </div>
            <div class="dep-status">
              <span class="dep-mins ${dep.minutesAway <= 10 ? 'soon' : ''}">${dep.formattedStatus}</span>
              <div style="display:flex; align-items:center; gap:0.35rem; margin-top:3px;">
                <span class="dep-delay-pill ${dep.delayStatus || 'scheduled'}">${dep.delayBadgeText || 'Programat'}</span>
                <span class="dep-type-badge">${dep.isRealtime ? '🟢 GPS' : '📅 Teòric'}</span>
              </div>
            </div>
          `;
          this.modalDeparturesList.appendChild(item);
        });
      }
    } catch (e) {
      if (!isSilentRefresh) {
        this.modalDeparturesList.innerHTML = '<div style="color:#ef4444; padding:10px;">Error consultant la parada.</div>';
      }
    }
  }

  closeModal() {
    this.currentInspectedStop = null;
    this.stopModalBackdrop.classList.remove('active');
  }

  startAutoRefresh() {
    // Countdown timer & animation ticker (ticks every second)
    this.countdownInterval = setInterval(() => {
      this.countdownTimer--;

      // Advance bus position continuously along the route
      if (this.mapInstance) {
        const now = new Date();
        const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
        this.mapInstance.stepBusAnimation(nowSec);
      }

      if (this.countdownTimer <= 0) {
        this.countdownTimer = this.refreshInterval;
        this.fetchAllData();
      }
      this.countdownLabel.textContent = `Actualització en ${this.countdownTimer}s`;
    }, 1000);
  }

  setLiveStatus(isOnline) {
    if (isOnline) {
      this.liveIndicator.style.borderColor = 'rgba(16, 185, 129, 0.3)';
      this.liveText.textContent = 'En directe';
    } else {
      this.liveIndicator.style.borderColor = 'rgba(239, 68, 68, 0.5)';
      this.liveText.textContent = 'Reintentant connexió...';
    }
  }

  setLoadingState(isLoading) {
    if (isLoading) {
      this.btnRefresh.classList.add('loading');
    } else {
      this.btnRefresh.classList.remove('loading');
    }
  }

  toggleSound() {
    this.isSoundEnabled = !this.isSoundEnabled;
    if (this.isSoundEnabled) {
      this.soundIconOff.style.display = 'none';
      this.soundIconOn.style.display = 'block';
      this.playChime();
    } else {
      this.soundIconOff.style.display = 'block';
      this.soundIconOn.style.display = 'none';
    }
  }

  playChime() {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, audioCtx.currentTime); // D5
      osc.frequency.setValueAtTime(880, audioCtx.currentTime + 0.15); // A5

      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.4);

      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.start();
      osc.stop(audioCtx.currentTime + 0.45);
    } catch (e) {
      console.warn('AudioContext not permitted yet:', e.message);
    }
  }

  checkArrivalAlerts() {
    if (!this.isSoundEnabled || !this.targetEtaData || !this.targetEtaData.nextBus) return;

    const nextBus = this.targetEtaData.nextBus;
    if (nextBus.minutesAway <= 5 && nextBus.minutesAway >= 0) {
      const key = `${nextBus.tripId}_${nextBus.departureTime}`;
      if (!this.hasAlertedForTrip.has(key)) {
        this.hasAlertedForTrip.add(key);
        this.playChime();
        if (Notification && Notification.permission === 'granted') {
          const stopName = this.targetEtaData?.targetStop?.name || 'la parada seleccionada';
          new Notification('🚌 Bus C-10 Arribant!', {
            body: `El bus C-10 arribarà a ${stopName} en ${nextBus.formattedStatus}! (${nextBus.departureTime})`
          });
        }
      }
    }
  }
}

// Bootstrap application on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  window.c10App = new C10App();
});

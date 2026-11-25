(function (global) {
  'use strict';
  global.TransitStopFeatures = {
  loadFavoriteStops() {
    try {
      const raw = localStorage.getItem('arribo_mataro_fav_stops');
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(stop => stop && stop.id).slice(0, 100) : [];
    } catch {
      return [];
    }
  },

  saveFavoriteStops() {
    try {
      localStorage.setItem('arribo_mataro_fav_stops', JSON.stringify(this.favoriteStops));
    } catch {}
    this.updateHeaderFavoritesBadge();
    this.updateTargetFavButton?.();
  },

  isFavoriteStop(stopId) {
    if (!stopId) return false;
    const sId = String(stopId).trim();
    return this.favoriteStops.some(s => String(s.id).trim() === sId || String(s.code).trim() === sId);
  },

  toggleFavoriteStop(stopId, stopName = '', lines = []) {
    if (!stopId) return;
    const sId = String(stopId).trim();
    const idx = this.favoriteStops.findIndex(s => String(s.id).trim() === sId || String(s.code).trim() === sId);

    if (idx >= 0) {
      this.favoriteStops.splice(idx, 1);
    } else {
      this.favoriteStops.push({
        id: sId,
        code: sId,
        name: stopName || (global.ArriboI18n ? global.ArriboI18n.t('stopFeat.stopFallback', { id: sId }) : `Parada ${sId}`),
        lines: lines || [],
        addedAt: Date.now()
      });
    }

    this.saveFavoriteStops();
    this.renderLandingFavorites();
  },

  updateHeaderFavoritesBadge() {
    const badge = document.getElementById('header-favs-count-text');
    if (badge) {
      const count = this.favoriteStops.length;
      const t = (k, v, fb) => (global.ArriboI18n ? global.ArriboI18n.t(k, v) : fb);
      badge.textContent = count > 0 ? t('stopFeat.favCount', { n: count }, `Preferides (${count})`) : t('stopFeat.favLabel', null, 'Preferides');
    }
  },

  handleNearbyStopsRequest() {
    const t = (k, v, fb) => (global.ArriboI18n ? global.ArriboI18n.t(k, v) : fb);
    const geoBtn = document.getElementById('btn-hero-geo');
    if (geoBtn?.disabled) return;
    const originalHtml = geoBtn ? geoBtn.innerHTML : '';

    if (geoBtn) {
      geoBtn.disabled = true;
      geoBtn.innerHTML = `<span class="loading-spinner-inline" style="width:12px;height:12px;"></span> <span>${this.esc(t('stopFeat.locating', null, 'Localitzant...'))}</span>`;
    }

    const restoreBtn = () => {
      if (geoBtn) {
        geoBtn.disabled = false;
        geoBtn.innerHTML = originalHtml;
      }
    };

    const fallbackToZonePicker = () => {
      restoreBtn();
      this.openZonePicker();
    };

    if (typeof navigator !== 'undefined' && 'geolocation' in navigator && window.isSecureContext !== false) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          restoreBtn();
          const { latitude, longitude } = pos.coords;
          // Inside the area the operators serve (from the line catalog); Mataró's box until one is known.
          const area = window.TransitUtils?.serviceArea?.();
          if (area ? area.contains(latitude, longitude) : (latitude >= 41.45 && latitude <= 41.60 && longitude >= 2.35 && longitude <= 2.52)) {
            this.loadNearbyStops(latitude, longitude, t('stopFeat.yourGps', null, 'La teva posició GPS 📍'));
          } else {
            this.openZonePicker();
          }
        },
        (err) => {
          console.log('[Geo] Geolocation skipped/denied:', err?.message || err);
          fallbackToZonePicker();
        },
        { timeout: 5000, maximumAge: 60000, enableHighAccuracy: false }
      );
    } else {
      fallbackToZonePicker();
    }
  },

  formatZoneRadius(meters) {
    const m = Math.round(Number(meters) || 800);
    return m >= 1000 ? `${(m / 1000).toFixed(m % 1000 === 0 ? 0 : 1)} km` : `${m} m`;
  },

  openZonePicker() {
    const modal = document.getElementById('zone-picker-modal-backdrop');
    if (!modal) return;
    modal.classList.add('active');

    const defaultLat = this.activeNearbyZone?.lat ?? 41.5396;
    const defaultLon = this.activeNearbyZone?.lon ?? 2.4445;
    const defaultRadius = this.activeNearbyZone?.radius ?? 800;
    const defaultLabel = this.activeNearbyZone?.baseLabel || 'Mataró';

    this._zonePickerState = {
      lat: defaultLat,
      lon: defaultLon,
      radius: defaultRadius,
      label: defaultLabel
    };

    const slider = document.getElementById('zone-radius-slider');
    const valEl = document.getElementById('zone-radius-value');
    const pillsWrap = document.getElementById('zone-radius-pills');
    const cityWrap = document.getElementById('zone-city-chips');
    const applyBtn = document.getElementById('btn-zone-picker-apply');
    const gpsBtn = document.getElementById('btn-zone-picker-gps');

    const syncRadiusUI = (r) => {
      this._zonePickerState.radius = r;
      if (slider) slider.value = String(r);
      if (valEl) valEl.textContent = global.TransitStopFeatures.formatZoneRadius(r);
      pillsWrap?.querySelectorAll('.zone-radius-pill').forEach(btn => {
        btn.classList.toggle('active', Number(btn.getAttribute('data-radius')) === r);
      });
      if (this._zoneCircle) {
        this._zoneCircle.setRadius(r);
      }
    };

    const setCenter = (lat, lon, label, pan = true) => {
      this._zonePickerState.lat = lat;
      this._zonePickerState.lon = lon;
      if (label !== undefined) this._zonePickerState.label = label;
      if (this._zoneMarker) this._zoneMarker.setLatLng([lat, lon]);
      if (this._zoneCircle) this._zoneCircle.setLatLng([lat, lon]);
      if (pan && this._zoneMap) {
        const zoom = this._zonePickerState.radius >= 3000 ? 12 : (this._zonePickerState.radius >= 1500 ? 13 : 14);
        this._zoneMap.setView([lat, lon], Math.max(this._zoneMap.getZoom(), zoom), { animate: true });
      }
      global.TransitStopFeatures.scheduleZonePreview.call(this);
    };

    // Bind controls once
    if (!this._zonePickerBound) {
      this._zonePickerBound = true;
      slider?.addEventListener('input', () => {
        const r = Number(slider.value) || 800;
        syncRadiusUI(r);
        global.TransitStopFeatures.scheduleZonePreview.call(this);
      });
      pillsWrap?.addEventListener('click', (e) => {
        const pill = e.target.closest('.zone-radius-pill');
        if (!pill) return;
        const r = Number(pill.getAttribute('data-radius')) || 800;
        syncRadiusUI(r);
        if (this._zoneMap && this._zoneCircle) {
          this._zoneMap.fitBounds(this._zoneCircle.getBounds(), { padding: [24, 24], maxZoom: 15 });
        }
        global.TransitStopFeatures.scheduleZonePreview.call(this);
      });
      cityWrap?.addEventListener('click', (e) => {
        const chip = e.target.closest('.zone-city-chip');
        if (!chip || chip.id === 'btn-zone-picker-gps') return;
        const lat = parseFloat(chip.getAttribute('data-lat'));
        const lon = parseFloat(chip.getAttribute('data-lon'));
        const name = chip.getAttribute('data-name') || '';
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          cityWrap.querySelectorAll('.zone-city-chip').forEach(c => c.classList.toggle('active', c === chip));
          setCenter(lat, lon, name, true);
        }
      });
      gpsBtn?.addEventListener('click', () => {
        const t = (k, v, fb) => (global.ArriboI18n ? global.ArriboI18n.t(k, v) : fb);
        if (!navigator?.geolocation || window.isSecureContext === false) return;
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            setCenter(pos.coords.latitude, pos.coords.longitude, t('stopFeat.yourGps', null, 'GPS 📍'), true);
          },
          () => {},
          { timeout: 5000, maximumAge: 60000, enableHighAccuracy: false }
        );
      });
      applyBtn?.addEventListener('click', () => {
        const st = this._zonePickerState;
        if (!st) return;
        const t = (k, v, fb) => (global.ArriboI18n ? global.ArriboI18n.t(k, v) : fb);
        const base = st.label || t('zones.customArea', null, 'Zona seleccionada');
        this.closeZonePicker();
        this.loadNearbyStops(st.lat, st.lon, base, st.radius);
      });
    }

    syncRadiusUI(defaultRadius);

    // Initialize or refresh the Leaflet map after modal becomes visible
    requestAnimationFrame(() => {
      const mapEl = document.getElementById('zone-picker-map');
      if (!mapEl || typeof L === 'undefined') return;
      const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
      const cartoKey = 'cb1_2e4m_1_e5f70f18572ed17fe4483c7e';
      const tileUrl = isDark
        ? `https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png?key=${cartoKey}`
        : `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=${cartoKey}`;

      if (!this._zoneMap) {
        this._zoneMap = L.map(mapEl, { zoomControl: true, attributionControl: false }).setView([defaultLat, defaultLon], 13);
        this._zoneTileLayer = L.tileLayer(tileUrl, { subdomains: 'abcd', maxZoom: 19 }).addTo(this._zoneMap);
        this._zoneTileTheme = isDark ? 'dark' : 'light';
        this._zoneCircle = L.circle([defaultLat, defaultLon], {
          radius: defaultRadius,
          color: '#007a5a',
          weight: 2,
          fillColor: '#10b981',
          fillOpacity: 0.16
        }).addTo(this._zoneMap);
        this._zoneStopsLayer = L.layerGroup().addTo(this._zoneMap);
        this._zoneMarker = L.marker([defaultLat, defaultLon], { draggable: true }).addTo(this._zoneMap);
        this._zoneMarker.on('dragend', () => {
          const ll = this._zoneMarker.getLatLng();
          const t = (k, v, fb) => (global.ArriboI18n ? global.ArriboI18n.t(k, v) : fb);
          cityWrap?.querySelectorAll('.zone-city-chip').forEach(c => c.classList.remove('active'));
          setCenter(ll.lat, ll.lng, t('zones.customArea', null, 'Zona al mapa'), false);
        });
        this._zoneMap.on('click', (ev) => {
          const t = (k, v, fb) => (global.ArriboI18n ? global.ArriboI18n.t(k, v) : fb);
          cityWrap?.querySelectorAll('.zone-city-chip').forEach(c => c.classList.remove('active'));
          setCenter(ev.latlng.lat, ev.latlng.lng, t('zones.customArea', null, 'Zona al mapa'), false);
        });
      } else {
        if (this._zoneTileTheme !== (isDark ? 'dark' : 'light')) {
          this._zoneTileLayer.setUrl(tileUrl);
          this._zoneTileTheme = isDark ? 'dark' : 'light';
        }
        this._zoneMarker.setLatLng([defaultLat, defaultLon]);
        this._zoneCircle.setLatLng([defaultLat, defaultLon]).setRadius(defaultRadius);
        this._zoneMap.setView([defaultLat, defaultLon], defaultRadius >= 3000 ? 12 : 13, { animate: false });
      }
      const recenter = () => {
        if (!this._zoneMap) return;
        this._zoneMap.invalidateSize({ animate: false });
        if (this._zoneCircle) {
          this._zoneMap.fitBounds(this._zoneCircle.getBounds(), { padding: [28, 28], maxZoom: 15, animate: false });
        }
      };
      setTimeout(recenter, 60);
      setTimeout(recenter, 260);
      global.TransitStopFeatures.scheduleZonePreview.call(this);
    });
  },

  scheduleZonePreview() {
    clearTimeout(this._zonePreviewTimer);
    this._zonePreviewTimer = setTimeout(() => global.TransitStopFeatures.refreshZonePreview.call(this), 180);
  },

  async refreshZonePreview() {
    const st = this._zonePickerState;
    const pill = document.getElementById('zone-preview-pill');
    if (!st || !pill) return;
    const fmtRadius = global.TransitStopFeatures.formatZoneRadius;
    const t = (k, v, fb) => (global.ArriboI18n ? global.ArriboI18n.t(k, v) : fb);
    pill.textContent = t('zones.previewLoading', null, 'Cercant parades a l\'àrea...');
    this._zonePreviewReq ||= new window.TransitRequest();
    try {
      const res = await this._zonePreviewReq.json(
        `/api/stops/nearby?lat=${st.lat.toFixed(5)}&lon=${st.lon.toFixed(5)}&radius=${Math.round(st.radius)}&limit=40&departures=false`
      );
      const stops = res?.stops || [];
      const lineSet = new Set();
      this._zoneStopsLayer?.clearLayers();
      for (const s of stops) {
        for (const l of (s.lines || [])) {
          lineSet.add(l.id || l.code || String(l));
        }
        if (this._zoneStopsLayer && Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon))) {
          const c = s.lines?.[0]?.color || '#10b981';
          L.circleMarker([Number(s.lat), Number(s.lon)], {
            radius: 5,
            color: '#ffffff',
            weight: 1.5,
            fillColor: c,
            fillOpacity: 0.95
          }).bindTooltip(`${s.name} (${s.distanceMeters} m)`).addTo(this._zoneStopsLayer);
        }
      }
      if (stops.length === 0) {
        pill.textContent = t('zones.previewEmpty', { r: fmtRadius(st.radius) }, `Cap parada dins de ${fmtRadius(st.radius)}`);
      } else {
        pill.textContent = t(
          'zones.previewFound',
          { stops: stops.length, lines: lineSet.size, r: fmtRadius(st.radius) },
          `${stops.length} parades · ${lineSet.size} línies dins de ${fmtRadius(st.radius)}`
        );
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;
      pill.textContent = t('zones.previewEmpty', { r: fmtRadius(st.radius) }, `Cap parada dins de ${fmtRadius(st.radius)}`);
    }
  },

  closeZonePicker() {
    const modal = document.getElementById('zone-picker-modal-backdrop');
    if (modal) modal.classList.remove('active');
  },
  async loadNearbyStops(lat, lon, label, radius = 800) {
    const t = (k, v, fb) => (global.ArriboI18n ? global.ArriboI18n.t(k, v) : fb);
    const fmtRadius = global.TransitStopFeatures.formatZoneRadius;
    const rad = Math.max(100, Math.min(10000, Math.round(Number(radius) || 800)));
    const baseLabel = label || t('stopFeat.nearbyDefault', null, 'A prop');
    const resolvedLabel = `${baseLabel} · ${fmtRadius(rad)}`;
    const section = document.getElementById('landing-nearby-section');
    const titleEl = document.getElementById('nearby-zone-title');
    const grid = document.getElementById('landing-nearby-grid');
    if (!section || !grid) return;

    this.activeNearbyZone = { lat, lon, radius: rad, baseLabel, label: resolvedLabel };
    if (titleEl) titleEl.textContent = resolvedLabel;
    section.style.display = 'block';
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });

    grid.innerHTML = `
      <div style="grid-column: 1 / -1; padding: 2rem; text-align: center; color: var(--text-muted);">
        <span class="loading-spinner-inline" style="width:16px;height:16px;margin-bottom:0.5rem;"></span>
        <div>${this.esc(t('stopFeat.loadingNearby', null, 'Cercant parades properes i horaris en directe...'))}</div>
      </div>
    `;

    this.nearbyRequest ||= new window.TransitRequest();
    try {
      const res = await this.nearbyRequest.json(`/api/stops/nearby?lat=${lat}&lon=${lon}&radius=${rad}&limit=24`);
      const stops = res?.stops || [];

      if (stops.length === 0) {
        grid.innerHTML = `
          <div style="grid-column: 1 / -1; padding: 2rem; text-align: center; color: var(--text-muted); background:var(--bg-surface-elevated); border-radius:var(--radius-sm);">
            <div style="font-size:1.6rem; margin-bottom:0.4rem;">🚏</div>
            <div style="font-weight:700; color:var(--text-primary); margin-bottom:0.25rem;">${this.esc(t('stopFeat.noneNearbyTitle', { r: fmtRadius(rad) }, `Cap parada dins de ${fmtRadius(rad)}`))}</div>
            <div style="font-size:0.82rem;">${this.esc(t('stopFeat.noneNearbyHint', null, 'Amplia el radi o tria un altre punt al mapa per consultar les parades.'))}</div>
          </div>
        `;
        return;
      }

      this.currentNearbyStops = stops;
      const uniqueLines = new Map();
      for (const s of stops) {
        for (const l of (s.lines || [])) {
          const lid = l.id || l.code || String(l);
          if (!uniqueLines.has(lid)) {
            uniqueLines.set(lid, {
              id: lid,
              code: l.code || lid,
              color: l.color || null,
              textColor: l.textColor || null
            });
          }
        }
      }
      const summaryHtml = uniqueLines.size > 0
        ? `<div class="nearby-lines-summary">
            <span class="nearby-lines-summary-label">${this.esc(t('zones.linesInArea', { n: uniqueLines.size }, `${uniqueLines.size} línies a l'àrea:`))}</span>
            <div class="nearby-lines-summary-pills">${Array.from(uniqueLines.values()).map(l => {
              const bg = l.color || 'var(--action)';
              const fg = l.color && window.TransitUtils?.contrastInk
                ? window.TransitUtils.contrastInk(l.color, l.textColor)
                : 'var(--on-action)';
              return `<button type="button" class="line-badge-sm nearby-line-jump" data-nearby-line-id="${this.esc(l.id)}" style="background:${this.esc(bg)}; color:${this.esc(fg)};">${this.esc(l.code)}</button>`;
            }).join('')}</div>
          </div>`
        : '';

      grid.innerHTML = summaryHtml + stops.map(s => {
        const linePills = (s.lines && s.lines.length > 0)
          ? s.lines.map(l => {
              const bg = l.color || 'var(--action)';
              const fg = l.color && window.TransitUtils?.contrastInk
                ? window.TransitUtils.contrastInk(l.color, l.textColor)
                : 'var(--on-action)';
              const lid = l.id || l.code || String(l);
              return `<button type="button" class="line-badge-sm nearby-line-jump" data-nearby-line-id="${this.esc(lid)}" style="background:${this.esc(bg)}; color:${this.esc(fg)};">${this.esc(l.code || l.id || l)}</button>`;
            }).join('')
          : '<span class="line-badge-sm" style="background:var(--action); color:var(--on-action);">Bus</span>';

        const arrivalsHtml = (s.departures && s.departures.length > 0)
          ? s.departures.map(d => {
              const lineCode = d.lineId ? `L${String(d.lineId).replace(/^L/i, '')}` : 'Bus';
              const minsAway = d.minutesAway !== undefined && d.minutesAway !== null ? d.minutesAway : null;
              const minsText = minsAway !== null
                ? (minsAway <= 0 ? t('common.now', null, 'Ara') : (minsAway === 1 ? '1 min' : `${minsAway} min`))
                : (d.departureTime || '--:--');

              return `
                <div class="landing-fav-arrival-pill">
                  <span><strong>${this.esc(lineCode)}</strong> ${this.esc(t('stopFeat.towards', null, 'cap a'))} ${this.esc((d.destination || t('common.destination', null, 'Destí')).replace(/^Cap a\s+/i, ''))}</span>
                  <strong style="color:${minsAway !== null && minsAway <= 3 ? 'var(--accent-live)' : 'var(--text-primary)'};">${this.esc(minsText)}</strong>
                </div>
              `;
            }).join('')
          : `<div style="font-size:0.75rem; color:var(--text-muted);">${this.esc(t('stopFeat.clickFull', null, 'Fes clic per veure sortides completes'))}</div>`;

        const agencyTag = s.agency ? `<span class="nearby-agency-tag">${this.esc(s.agency)}</span>` : '';
        const distLabel = s.distanceMeters >= 1000 ? `${(s.distanceMeters / 1000).toFixed(1)} km` : `${s.distanceMeters} m`;

        return `
          <div class="landing-nearby-card" role="button" tabindex="0" data-stop-id="${this.esc(s.id)}" data-stop-name="${this.esc(s.name)}" ${s.lineId ? `data-line-id="${this.esc(s.lineId)}"` : ''}>
            <div class="landing-nearby-card-header">
              <div>
                <div class="landing-nearby-title">${this.esc(s.name)}</div>
                <div class="landing-nearby-code">${agencyTag}<span>${this.esc(t('stopFeat.code', { code: s.code || s.id }, `Codi #${s.code || s.id}`))}</span></div>
              </div>
              <span class="nearby-dist-badge">🚶 ${this.esc(distLabel)} • ${this.esc(s.walkingMinutes)} min</span>
            </div>
            <div class="landing-nearby-lines">${linePills}</div>
            <div class="landing-fav-arrivals">${arrivalsHtml}</div>
          </div>
        `;
      }).join('');
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('Nearby stops fetch error:', err);
      grid.innerHTML = `<div style="color:var(--danger); padding:1rem; text-align:center;">${this.esc(t('stopFeat.nearbyError', null, 'Error en carregar les parades properes.'))}</div>`;
    }
  },



  };
})(window);

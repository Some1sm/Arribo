(function (global) {
  'use strict';
  global.TransitStopFeatures = {
  loadFavoriteStops() {
    try {
      const raw = localStorage.getItem('arribo_mataro_fav_stops');
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(stop => stop && stop.id).slice(0, 100) : [];
    } catch (_) {
      return [];
    }
  },

  saveFavoriteStops() {
    try {
      localStorage.setItem('arribo_mataro_fav_stops', JSON.stringify(this.favoriteStops));
    } catch (_) {}
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
        name: stopName || `Parada ${sId}`,
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
      badge.textContent = count > 0 ? `Preferides (${count})` : 'Preferides';
    }
  },

  handleNearbyStopsRequest() {
    const geoBtn = document.getElementById('btn-hero-geo');
    const originalHtml = geoBtn ? geoBtn.innerHTML : '';

    if (geoBtn) {
      geoBtn.innerHTML = '<span class="loading-spinner-inline" style="width:12px;height:12px;"></span> <span>Localitzant...</span>';
    }

    const fallbackToZonePicker = () => {
      if (geoBtn) geoBtn.innerHTML = originalHtml;
      this.openZonePicker();
    };

    if (typeof navigator !== 'undefined' && 'geolocation' in navigator && window.isSecureContext !== false) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (geoBtn) geoBtn.innerHTML = originalHtml;
          const { latitude, longitude } = pos.coords;
          if (latitude >= 41.45 && latitude <= 41.60 && longitude >= 2.35 && longitude <= 2.52) {
            this.loadNearbyStops(latitude, longitude, 'La teva posició GPS 📍');
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

  openZonePicker() {
    const modal = document.getElementById('zone-picker-modal-backdrop');
    const grid = document.getElementById('zone-picker-grid');
    if (!modal || !grid) return;

    grid.innerHTML = MATARO_ZONES.map(z => `
      <div class="zone-card" data-zone-id="${this.esc(z.id)}" data-lat="${z.lat}" data-lon="${z.lon}" data-name="${this.esc(z.name)}">
        <div class="zone-card-icon">${z.icon}</div>
        <div class="zone-card-info">
          <div class="zone-card-title">${this.esc(z.name)}</div>
          <div class="zone-card-desc">${this.esc(z.desc)}</div>
        </div>
      </div>
    `).join('');

    modal.classList.add('active');
  },

  closeZonePicker() {
    const modal = document.getElementById('zone-picker-modal-backdrop');
    if (modal) modal.classList.remove('active');
  },
  async loadNearbyStops(lat, lon, label = 'A prop') {
    const section = document.getElementById('landing-nearby-section');
    const titleEl = document.getElementById('nearby-zone-title');
    const grid = document.getElementById('landing-nearby-grid');
    if (!section || !grid) return;

    this.activeNearbyZone = { lat, lon, label };
    if (titleEl) titleEl.textContent = label;
    section.style.display = 'block';
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });

    grid.innerHTML = `
      <div style="grid-column: 1 / -1; padding: 2rem; text-align: center; color: var(--text-muted);">
        <span class="loading-spinner-inline" style="width:16px;height:16px;margin-bottom:0.5rem;"></span>
        <div>Cercant parades properes i horaris en directe...</div>
      </div>
    `;

    this.nearbyRequest ||= new window.TransitRequest();
    try {
      const res = await this.nearbyRequest.json(`/api/mataro/stops/nearby?lat=${lat}&lon=${lon}&radius=800&limit=6`);
      const stops = res?.stops || [];

      if (stops.length === 0) {
        grid.innerHTML = `
          <div style="grid-column: 1 / -1; padding: 2rem; text-align: center; color: var(--text-muted); background:var(--bg-surface-elevated); border-radius:var(--radius-md);">
            <div style="font-size:1.6rem; margin-bottom:0.4rem;">🚏</div>
            <div style="font-weight:700; color:var(--text-primary); margin-bottom:0.25rem;">Cap parada a menys de 800m</div>
            <div style="font-size:0.82rem;">Tria un altre barri o zona de Mataró per consultar les parades.</div>
          </div>
        `;
        return;
      }

      this.currentNearbyStops = stops;
      grid.innerHTML = stops.map(s => {
        const linePills = (s.lines && s.lines.length > 0)
          ? s.lines.map(l => `<span class="line-badge-sm" style="font-size:0.7rem; padding:1px 6px; background:var(--c10-primary);">${this.esc(l.code || l.id || l)}</span>`).join('')
          : '<span class="line-badge-sm" style="font-size:0.7rem; padding:1px 6px; background:var(--c10-primary);">L1..L8</span>';

        const arrivalsHtml = (s.departures && s.departures.length > 0)
          ? s.departures.map(d => {
              const lineCode = d.lineId ? `L${String(d.lineId).replace(/^L/i, '')}` : 'Bus';
              const minsAway = d.minutesAway !== undefined && d.minutesAway !== null ? d.minutesAway : null;
              const minsText = minsAway !== null
                ? (minsAway <= 0 ? 'Ara' : (minsAway === 1 ? '1 min' : `${minsAway} min`))
                : (d.departureTime || '--:--');

              return `
                <div class="landing-fav-arrival-pill">
                  <span><strong>${this.esc(lineCode)}</strong> cap a ${this.esc((d.destination || 'Destí').replace(/^Cap a\s+/i, ''))}</span>
                  <strong style="color:${minsAway !== null && minsAway <= 3 ? '#10b981' : 'var(--text-primary)'};">${minsText}</strong>
                </div>
              `;
            }).join('')
          : '<div style="font-size:0.75rem; color:var(--text-muted);">Fes clic per veure sortides completes</div>';

        return `
          <div class="landing-nearby-card" data-stop-id="${this.esc(s.id)}" data-stop-name="${this.esc(s.name)}">
            <div class="landing-nearby-card-header">
              <div>
                <div class="landing-nearby-title">${this.esc(s.name)}</div>
                <div class="landing-nearby-code">Codi #${this.esc(s.code || s.id)}</div>
              </div>
              <span class="nearby-dist-badge">🚶 ${s.distanceMeters}m • ${s.walkingMinutes} min</span>
            </div>
            <div class="landing-nearby-lines">${linePills}</div>
            <div class="landing-fav-arrivals">${arrivalsHtml}</div>
          </div>
        `;
      }).join('');
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('Nearby stops fetch error:', err);
      grid.innerHTML = '<div style="color:var(--danger); padding:1rem; text-align:center;">Error en carregar les parades properes.</div>';
    }
  },



  };
})(window);

// Leaflet Map Module for Multi-Line Transit Platform (C-10 + Mataró Bus)
// Features: Road-Snapping, Polyline Subpath Following, Bearing Rotation, and Glider Animations

/**
 * HTML-escapes upstream-derived strings (stop names, destinations, IDs) before
 * they are interpolated into Leaflet tooltips/popup HTML.
 */
function escHtml(value) {
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

function mapT(key, vars, fallback) {
  if (typeof window !== 'undefined' && window.ArriboI18n && typeof window.ArriboI18n.t === 'function') {
    return window.ArriboI18n.t(key, vars);
  }
  return fallback !== undefined ? fallback : key;
}

function mapFmtMeters(meters) {
  const n = Math.round(Number(meters) || 0);
  const lang = (typeof window !== 'undefined' && window.ArriboI18n && window.ArriboI18n.lang) || 'ca';
  try {
    return `${new Intl.NumberFormat(lang).format(n)} m`;
  } catch {
    return `${n} m`;
  }
}

const CANONICAL_BUS_ICON_INNER_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; vertical-align:middle;"><path d="M4.7 17.5H3.4A1.4 1.4 0 0 1 2 16.1V6.4A1.4 1.4 0 0 1 3.4 5H17.5A4.5 4.5 0 0 1 22 9.5v6.6a1.4 1.4 0 0 1-1.4 1.4h-1.3"/><path d="M9.3 17.5h5.4"/><path d="M2 11.6h20"/><path d="M7.5 5v6.6M12.5 5v6.6M17.6 5.2v6.4"/><circle cx="7" cy="17.5" r="2.3"/><circle cx="17" cy="17.5" r="2.3"/></svg>';
// Trains (GTFS-RT, Rodalies / FGC) get their own front-view drawing, so a
// train on a rail line never looks like a bus.
const TRAIN_ICON_INNER_SVG = '<svg class="train-icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 10h14"/><path d="M12 3v7"/><circle cx="9" cy="13.5" r="0.7"/><circle cx="15" cy="13.5" r="0.7"/><path d="M8 21l2-4"/><path d="M16 21l-2-4"/></svg>';
const METRO_ICON_INNER_SVG = '<svg class="metro-icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 22 12 12 22 2 12"/><path d="M8.5 15.5V8.5l3.5 4.2 3.5-4.2v7"/></svg>';
const TRAM_ICON_INNER_SVG = '<svg class="tram-icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6M12 3v3"/><rect x="5" y="6" width="14" height="12" rx="2.5"/><path d="M5 12h14"/><circle cx="9" cy="15" r="0.7"/><circle cx="15" cy="15" r="0.7"/><path d="M8 21l1.5-3M16 21l-1.5-3"/></svg>';
const vehicleIconForMode = (mode) => (mode === 'metro' ? METRO_ICON_INNER_SVG : (mode === 'tram' ? TRAM_ICON_INNER_SVG : (mode === 'rail' ? TRAIN_ICON_INNER_SVG : CANONICAL_BUS_ICON_INNER_SVG)));
if (typeof window !== 'undefined') window.vehicleIconForMode = vehicleIconForMode;


/**
 * Projects a stop position onto the nearest vertex of a route polyline using a
 * local equirectangular approximation. Returns [lat, lon] of the nearest
 * polyline vertex if within maxSnapM metres, otherwise null (keep true coords).
 * Pure helper — does not mutate any stop objects.
 */
function snapStopToPolyline(stopLat, stopLon, polyCoords, maxSnapM = 120) {
  if (!Array.isArray(polyCoords) || polyCoords.length < 10) return null;
  let bestD2 = Infinity;
  let bestLat = null;
  let bestLon = null;
  for (let i = 0; i < polyCoords.length; i++) {
    const p = polyCoords[i];
    if (!p || typeof p[0] !== 'number' || typeof p[1] !== 'number') continue;
    const meanLat = (stopLat + p[0]) / 2;
    const dLat = (p[0] - stopLat) * 111320;
    const dLon = (p[1] - stopLon) * 111320 * Math.cos(meanLat * Math.PI / 180);
    const d2 = dLat * dLat + dLon * dLon;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestLat = p[0];
      bestLon = p[1];
    }
  }
  if (bestLat === null || Math.sqrt(bestD2) > maxSnapM) return null;
  return [bestLat, bestLon];
}

class TransitMap {
  constructor(containerId) {
    this.containerId = containerId;
    this.map = null;
    this.stopMarkers = [];
    this.busMarkersMap = new Map(); // tripId -> { marker, busData, subpath, currentBearing }
    this.routePolyline = null;
    this.secondaryRoutePolyline = null;
    this.vehicleTrailPolyline = null;
    this.activePolylineCoords = []; // Array of [lat, lon]
    this.tileLayer = null;
    this.renderer = null;
    this.resizeObserver = null;
    this.trafficLayerGroup = null;
    this.isTrafficEnabled = false;
    this.currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    this._lastLocHintState = null;
    this._lastGeometryInfo = null;
    this._lastItinerary = null;
    this.initMap();
  }

  initMap() {
    if (typeof L === 'undefined') {
      console.warn('Leaflet not loaded yet.');
      return;
    }

    // Centered along the coastal corridor / Mataró
    this.map = L.map(this.containerId, {
      zoomControl: true,
      scrollWheelZoom: true,
      preferCanvas: true, // Use lightweight HTML5 Canvas renderer for polylines and vectors (saves ~40MB DOM/GPU RAM)
      fadeAnimation: true,
      zoomAnimation: true
    }).setView(window.TransitUtils?.serviceArea?.()?.center || [41.54, 2.44], window.TransitUtils?.serviceArea?.()?.zoom || 13);

    this.trafficLayerGroup = L.layerGroup().addTo(this.map);
    this.itineraryLayerGroup = L.layerGroup().addTo(this.map);
    this.updateTileLayer();
    this.setupResizeObserver();
    this.requestUserLocation();

    document.addEventListener('arribo:lang', () => this.onLangChange());

    // Delegated handler replacing inline onclick in map popups (CSP compliance)
    this.map.on('popupopen', (e) => {
      const root = e.popup.getElement();
      if (!root || root._arriboPopupBound) return;
      root._arriboPopupBound = true;
      root.addEventListener('click', (ev) => {
        const shareBtn = ev.target.closest('[data-share-vehicle]');
        if (shareBtn && window.transitApp?.shareLiveBus) {
          window.transitApp.shareLiveBus(shareBtn.dataset.shareVehicle);
        }
      });
    });
  }

  onLangChange() {
    if (this._lastGeometryInfo) {
      this.updateRouteSourceBadge(this._lastGeometryInfo);
    }
    const locBadge = document.getElementById('user-location-badge');
    if (this._lastLocHintState && locBadge && locBadge.style.display !== 'none') {
      this.showLocationPermissionHint(this._lastLocHintState);
    }
    if (this.isItineraryMode && this._lastItinerary && !window.planApp) {
      this.renderItinerary(this._lastItinerary, { fitBounds: false });
    }
    for (const [, obj] of this.busMarkersMap.entries()) {
      if (obj.marker && obj.busData && obj.popupCtx) {
        obj.marker.setPopupContent(this.buildBusPopupHtml(obj.busData, obj.popupCtx));
      }
    }
  }

  /**
   * Requests the browser's geolocation and shows the user's position on the
   * map as a pulsing blue dot. If permission is denied or geolocation is
   * unavailable, shows a small hint badge in the map corner (dismissible).
   */
  requestUserLocation() {
    if (!this.map) return;
    // Respect a previous manual dismissal of the hint bubble.
    try {
      if (sessionStorage.getItem('arribo_loc_hint_dismissed') === '1') return;
    } catch {}
    if (!navigator.geolocation || !window.isSecureContext) {
      // Geolocation only works in secure contexts (HTTPS or localhost).
      this.showLocationPermissionHint(!window.isSecureContext ? 'insecure' : 'unsupported');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        this.hideLocationPermissionHint();
        this.renderUserLocationMarker(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
      },
      (err) => {
        // PERMISSION_DENIED = 1, POSITION_UNAVAILABLE = 2, TIMEOUT = 3.
        // Note: after an explicit denial browsers NEVER re-prompt from JS;
        // the user must unblock the site via the padlock in the address bar.
        this.showLocationPermissionHint(err && err.code === 1 ? 'denied' : 'error');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  renderUserLocationMarker(lat, lon, accuracyMeters = 0) {
    if (!this.map) return;
    if (this.userLocationMarker) {
      this.userLocationMarker.setLatLng([lat, lon]);
      if (this.userLocationAccuracyCircle) this.userLocationAccuracyCircle.setLatLng([lat, lon]);
      return;
    }
    const icon = L.divIcon({
      html: '<div class="user-location-dot"><div class="user-location-pulse"></div></div>',
      className: 'user-location-marker',
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    });
    this.userLocationMarker = L.marker([lat, lon], {
      icon,
      zIndexOffset: 6000,
      interactive: false,
      keyboard: false
    }).addTo(this.map);
    if (Number.isFinite(accuracyMeters) && accuracyMeters > 0) {
      this.userLocationAccuracyCircle = L.circle([lat, lon], {
        radius: Math.min(accuracyMeters, 500),
        color: '#3b82f6',
        weight: 1,
        opacity: 0.35,
        fillColor: '#3b82f6',
        fillOpacity: 0.08,
        interactive: false
      }).addTo(this.map);
    }
  }

  showLocationPermissionHint(state = 'denied') {
    if (!this.map || !this.map.getContainer()) return;
    this._lastLocHintState = state;
    let badge = document.getElementById('user-location-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'user-location-badge';
      badge.className = 'user-location-badge';
      badge.setAttribute('role', 'status');
      const container = this.map.getContainer();
      container.appendChild(badge);
      // Delegated clicks: message area = retry, ✕ button = dismiss for this session.
      badge.addEventListener('click', (e) => {
        if (e.target && e.target.closest('.user-location-badge-close')) {
          try { sessionStorage.setItem('arribo_loc_hint_dismissed', '1'); } catch {}
          badge.style.display = 'none';
          this._lastLocHintState = null;
          return;
        }
        badge.style.display = 'none';
        this.requestUserLocation();
      });
    }
    const messages = {
      denied: mapT('map.loc.denied', null, '📍 Ubicació blocada: permet-la des del candau 🔒 de la barra d\'adreces del navegador'),
      insecure: mapT('map.loc.insecure', null, '📍 La geolocalització només funciona per HTTPS o localhost'),
      unsupported: mapT('map.loc.unsupported', null, '📍 El teu navegador no suporta geolocalització'),
      error: mapT('map.loc.error', null, '📍 Clica aquí per activar la teva ubicació al mapa')
    };
    const msg = messages[state] || messages.error;
    const closeAria = escHtml(mapT('map.loc.closeAria', null, 'Tanca l\'avís'));
    badge.innerHTML = `<span class="user-location-badge-msg">${escHtml(msg)}</span>` +
      `<button type="button" class="user-location-badge-close" aria-label="${closeAria}">✕</button>`;
    badge.style.display = 'flex';
  }

  hideLocationPermissionHint() {
    this._lastLocHintState = null;
    const badge = document.getElementById('user-location-badge');
    if (badge) badge.style.display = 'none';
  }

  setupResizeObserver() {
    const el = document.getElementById(this.containerId);
    if (!el || typeof ResizeObserver === 'undefined') return;

    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect && entry.contentRect.width > 0 && entry.contentRect.height > 0) {
          if (this.map) {
            this.map.invalidateSize({ pan: false, debounceMoveend: true });
          }
        }
      }
    });
    this.resizeObserver.observe(el);
  }

  updateTileLayer() {
    if (!this.map) return;
    if (this.tileLayer) {
      this.map.removeLayer(this.tileLayer);
    }
    const isDark = this.currentTheme === 'dark';
    const cartoKey = 'cb1_2e4m_1_e5f70f18572ed17fe4483c7e';
    const tileUrl = isDark
      ? `https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png?key=${cartoKey}`
      : `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=${cartoKey}`;

    this.tileLayer = L.tileLayer(tileUrl, {
      attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      subdomains: 'abcd',
      maxZoom: 19,
      keepBuffer: 2,         // Keep at most 2 tile buffers outside viewport to prevent unbounded RAM growth
      updateWhenIdle: true,  // Don't thrash raster tile allocations during rapid panning
      updateInterval: 150
    }).addTo(this.map);
  }

  setTheme(theme) {
    if (this.currentTheme === theme) return;
    this.currentTheme = theme;
    this.updateTileLayer();
  }

  // Distance in meters between two lat/lon points
  calculateDistanceMeters(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * 111320;
    const dLon = (lon2 - lon1) * 111320 * Math.cos((lat1 * Math.PI) / 180);
    return Math.sqrt(dLat * dLat + dLon * dLon);
  }

  // Bearing angle in degrees between two lat/lon points (0 = North, 90 = East)
  calculateBearing(lat1, lon1, lat2, lon2) {
    const y = Math.sin((lon2 - lon1) * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180);
    const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
              Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos((lon2 - lon1) * Math.PI / 180);
    const brng = Math.atan2(y, x) * 180 / Math.PI;
    return Math.round((brng + 360) % 360);
  }

  // Snap any coordinate strictly to the closest point on the road polyline.
  // When hintIndex >= 0 on long polylines, checks a local window first for O(1)
  // 60 FPS animation snapping before falling back to a full scan.
  snapToPolyline(lat, lon, polyline = this.activePolylineCoords, hintIndex = -1) {
    if (!polyline || polyline.length === 0) return { lat, lon, index: 0, bearing: 0 };
    if (polyline.length === 1) return { lat: polyline[0][0], lon: polyline[0][1], index: 0, bearing: 0 };

    const cosLat = Math.cos(lat * Math.PI / 180) || 0.75;
    const scanRange = (start, end) => {
      let minSq = Infinity;
      let bestIdx = start;
      let bestLat = polyline[start][0];
      let bestLon = polyline[start][1];
      let bestT = 0;

      for (let i = start; i <= end; i++) {
        const p1 = polyline[i];
        const p2 = polyline[i + 1];
        const x1 = p1[1], y1 = p1[0];
        const x2 = p2[1], y2 = p2[0];
        const dx = x2 - x1;
        const dy = y2 - y1;
        const lenSq = dx * dx + dy * dy;

        let t = 0;
        if (lenSq > 0) {
          t = Math.max(0, Math.min(1, ((lon - x1) * dx + (lat - y1) * dy) / lenSq));
        }
        const projX = x1 + t * dx;
        const projY = y1 + t * dy;
        const dLat = lat - projY;
        const dLon = (lon - projX) * cosLat;
        const sq = dLat * dLat + dLon * dLon;
        if (sq < minSq) {
          minSq = sq;
          bestIdx = i;
          bestLat = projY;
          bestLon = projX;
          bestT = t;
        }
      }
      const distM = Math.sqrt(minSq) * 111320;
      const bp1 = polyline[bestIdx];
      const bp2 = polyline[bestIdx + 1];
      return {
        lat: bestLat,
        lon: bestLon,
        index: bestIdx,
        t: bestT,
        bearing: this.calculateBearing(bp1[0], bp1[1], bp2[0], bp2[1]),
        distanceMeters: distM
      };
    };

    const maxSeg = polyline.length - 2;
    if (hintIndex >= 0 && polyline.length > 60) {
      const lo = Math.max(0, hintIndex - 15);
      const hi = Math.min(maxSeg, hintIndex + 30);
      const local = scanRange(lo, hi);
      if (local.distanceMeters < 60) {
        return local;
      }
    }
    return scanRange(0, maxSeg);
  }

  // Extract the exact sequence of road vertices between point A and point B along the polyline
  extractSubpath(polyline, startLat, startLon, endLat, endLon) {
    if (!polyline || polyline.length < 2) return [[startLat, startLon], [endLat, endLon]];

    const snapStart = this.snapToPolyline(startLat, startLon, polyline);
    const snapEnd = this.snapToPolyline(endLat, endLon, polyline);

    const subpath = [];
    subpath.push([snapStart.lat, snapStart.lon]);

    const fromIdx = snapStart.index;
    const toIdx = snapEnd.index;

    if (fromIdx <= toIdx) {
      for (let i = fromIdx + 1; i <= toIdx; i++) {
        subpath.push(polyline[i]);
      }
    } else {
      for (let i = fromIdx; i >= toIdx + 1; i--) {
        subpath.push(polyline[i]);
      }
    }

    subpath.push([snapEnd.lat, snapEnd.lon]);
    return subpath;
  }



  // Create directional arrows along a polyline
  createDirectionalArrows(polylineCoords, color, spacingM = 800) {
    if (!polylineCoords || polylineCoords.length < 2) return [];
    const arrows = [];
    let accumulated = 0;

    for (let i = 0; i < polylineCoords.length - 1; i++) {
      const p1 = polylineCoords[i];
      const p2 = polylineCoords[i + 1];
      const d = this.calculateDistanceMeters(p1[0], p1[1], p2[0], p2[1]);
      accumulated += d;

      // Place an arrow roughly every `spacingM` meters along the route. The
      // single-line map uses the 800 m default; the all-lines network map widens
      // it so eight routes at once do not bury the map in arrow DOM nodes.
      if (accumulated >= spacingM) {
        accumulated = 0;
        const midLat = (p1[0] + p2[0]) / 2;
        const midLon = (p1[1] + p2[1]) / 2;
        const bearing = this.calculateBearing(p1[0], p1[1], p2[0], p2[1]);

        const arrowHtml = `
          <div style="
            transform: rotate(${bearing}deg);
            color: ${color};
            font-size: 13px;
            font-weight: 900;
            line-height: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            text-shadow: 0 0 3px #000, 0 0 6px #000;
            pointer-events: none;
            user-select: none;
          ">▲</div>
        `;

        const icon = L.divIcon({
          html: arrowHtml,
          className: 'polyline-dir-arrow',
          iconSize: [14, 14],
          iconAnchor: [7, 7]
        });

        const marker = L.marker([midLat, midLon], { icon, interactive: false }).addTo(this.map);
        arrows.push(marker);
      }
    }
    return arrows;
  }

  // Render stops and road polyline on map (with support for both directions simultaneously)
  renderStops(stops, targetStopId = '', onStopClick = null, shouldFitBounds = false, lineColor = '#009485', customPolyline = null, secondaryPolyline = null, secondaryStops = null, secondaryColor = '#38bdf8', lineId = '', direction = '', geometryInfo = null) {
    if (!this.map || this.isItineraryMode) return;
    this.updateRouteSourceBadge(geometryInfo);

    // NOTE: targetStopId intentionally excluded from fingerprint so clicking a new
    // target stop toggles styling on cached markers instead of rebuilding them all.
    const stopsFingerprint = `${lineId}_${direction}_${stops.length}_${lineColor}_${customPolyline ? customPolyline.length : 0}_${secondaryPolyline ? secondaryPolyline.length : 0}`;
    const alreadyRendered = this.lastStopsFingerprint === stopsFingerprint && this.stopMarkers.length > 0;

    if (!alreadyRendered) {
      // Clean up previous bus markers & trail from previous line
      this.clearAllBusMarkers();
      this.clearVehicleTrail();

      // Clean up previous markers & polylines
      this.stopMarkers.forEach(m => this.map.removeLayer(m));
      this.stopMarkers = [];

      if (this.secondaryStopMarkers) {
        this.secondaryStopMarkers.forEach(m => this.map.removeLayer(m));
        this.secondaryStopMarkers = [];
      } else {
        this.secondaryStopMarkers = [];
      }

      if (this.directionalArrowMarkers) {
        this.directionalArrowMarkers.forEach(m => this.map.removeLayer(m));
        this.directionalArrowMarkers = [];
      } else {
        this.directionalArrowMarkers = [];
      }

      if (this.routePolyline) {
        this.map.removeLayer(this.routePolyline);
        this.routePolyline = null;
      }

      if (this.secondaryRoutePolyline) {
        this.map.removeLayer(this.secondaryRoutePolyline);
        this.secondaryRoutePolyline = null;
      }

      const latLngs = [];

      // 1. Render Primary Direction Stops
      stops.forEach((stop, index) => {
        if (!stop.lat || !stop.lon) return;

        // Display coords: snap marker onto road polyline when close enough.
        // latLngs keeps true coords so bounds/polyline fallback stay faithful.
        const snapped = snapStopToPolyline(stop.lat, stop.lon, customPolyline, 120);
        const markerLatLng = snapped || [stop.lat, stop.lon];
        const latLng = [stop.lat, stop.lon];
        latLngs.push(latLng);

        const stopIdentifier = String(stop.mouteStopId || stop.id || stop.code || '');
        const isTarget = stopIdentifier === String(targetStopId);
        const isCancelled = Boolean(stop.isCancelled);

        const markerHtml = isCancelled ? `
          <div class="stop-marker-dot cancelled" style="
            width: 20px;
            height: 20px;
            background: linear-gradient(135deg, #ef4444 0%, #b91c1c 100%);
            border: 2px solid #ffffff;
            border-radius: 50%;
            box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.45), 0 0 14px rgba(239, 68, 68, 0.9);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
            color: #ffffff;
            font-weight: 900;
          ">✕</div>
        ` : `
          <div class="stop-marker-dot" style="
            width: ${isTarget ? '22px' : '14px'};
            height: ${isTarget ? '22px' : '14px'};
            background-color: ${isTarget ? lineColor : '#06b6d4'};
            border: 2px solid #ffffff;
            border-radius: 50%;
            box-shadow: 0 0 10px ${isTarget ? lineColor : 'rgba(0,0,0,0.5)'};
            cursor: pointer;
            transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), filter 0.2s ease;
            ${isTarget ? 'animation: pulse-dot 1.5s infinite;' : ''}
          "></div>
        `;

        const customIcon = L.divIcon({
          html: markerHtml,
          className: `c10-stop-marker ${isCancelled ? 'cancelled' : ''}`,
          iconSize: [isCancelled ? 20 : (isTarget ? 22 : 14), isCancelled ? 20 : (isTarget ? 22 : 14)],
          iconAnchor: [isCancelled ? 10 : (isTarget ? 11 : 7), isCancelled ? 10 : (isTarget ? 11 : 7)]
        });

        const marker = L.marker(markerLatLng, { icon: customIcon }).addTo(this.map);

        // Hover tooltip
        const tooltipHtml = isCancelled ? `
          <div style="display:flex; flex-direction:column; gap:2px;">
            <div style="display:flex; align-items:center; gap:6px;">
              <span style="background:#ef4444; color:#fff; font-size:10px; font-weight:800; padding:1px 5px; border-radius:3px;">${escHtml(mapT('map.stop.outOfService', null, '❌ FORA DE SERVEI'))}</span>
              <span style="text-decoration:line-through; color:#f87171; font-weight:700;">${escHtml(stop.name)}</span>
            </div>
            <div style="font-size:10px; color:#cbd5e1;">${escHtml(mapT('map.stop.cancelledDesc', null, 'Parada anul·lada temporalment per obres/tall'))}</div>
          </div>
        ` : `
          <div style="display:flex; align-items:center; gap:6px;">
            <span style="background:${lineColor}; color:#fff; font-size:10px; font-weight:800; padding:1px 5px; border-radius:3px;">#${stop.seq || index + 1}</span>
            <span>${escHtml(stop.name)}</span>
          </div>
        `;

        marker.bindTooltip(tooltipHtml, {
          direction: 'top',
          offset: [0, -8],
          className: 'stop-hover-tooltip',
          opacity: 0.95
        });

        // Click directly on stop marker to open departures modal
        marker.on('click', () => {
          if (onStopClick) {
            onStopClick(stop);
          } else {
            window.transitApp?.inspectStop(stopIdentifier, stop.name);
          }
        });

        marker._stopMeta = { id: stopIdentifier, lineColor, isCancelled };
        const dotRoot = marker.getElement();
        marker._dotEl = dotRoot ? dotRoot.querySelector('.stop-marker-dot') : null;
        this.stopMarkers.push(marker);
      });

      // 2. Render Secondary Direction Stops (if showing both directions)
      if (secondaryStops && secondaryStops.length > 0) {
        const primaryStopIds = new Set(stops.map(s => String(s.mouteStopId || s.id || s.code || '')));
        const primaryCoords = new Set(stops.map(s => `${(s.lat || 0).toFixed(5)},${(s.lon || 0).toFixed(5)}`));

        secondaryStops.forEach((stop, index) => {
          if (!stop.lat || !stop.lon) return;
          const stopIdentifier = String(stop.mouteStopId || stop.id || stop.code || '');
          const coordKey = `${stop.lat.toFixed(5)},${stop.lon.toFixed(5)}`;

          // Snap secondary-direction markers onto THEIR OWN direction polyline
          // (never the primary one — that dragged opposite-direction stops
          // across the road when 'Ambdós sentits' was selected).
          const secSnapped = secondaryPolyline
            ? snapStopToPolyline(stop.lat, stop.lon, secondaryPolyline, 120)
            : null;

          // Avoid rendering duplicate marker on top of an identical primary stop
          if (primaryStopIds.has(stopIdentifier) && primaryCoords.has(coordKey)) {
            return;
          }

          const markerHtml = `
            <div class="stop-marker-dot secondary" style="
              width: 12px;
              height: 12px;
              background-color: ${secondaryColor};
              border: 1.5px solid #ffffff;
              border-radius: 50%;
              box-shadow: 0 0 8px ${secondaryColor};
              cursor: pointer;
              transition: transform 0.2s ease;
            "></div>
          `;

          const customIcon = L.divIcon({
            html: markerHtml,
            className: 'c10-stop-marker secondary',
            iconSize: [12, 12],
            iconAnchor: [6, 6]
          });

          const marker = L.marker(secSnapped || [stop.lat, stop.lon], { icon: customIcon }).addTo(this.map);

          marker.bindTooltip(`
            <div style="display:flex; align-items:center; gap:6px;">
              <span style="background:${secondaryColor}; color:#fff; font-size:10px; font-weight:800; padding:1px 5px; border-radius:3px;">${escHtml(mapT('map.stop.dir2', null, 'Sentit 2'))}</span>
              <span>${escHtml(stop.name)}</span>
            </div>
          `, {
            direction: 'top',
            offset: [0, -6],
            className: 'stop-hover-tooltip',
            opacity: 0.95
          });

          marker.on('click', () => {
            if (onStopClick) {
              onStopClick(stop);
            } else {
              window.transitApp?.inspectStop(stopIdentifier, stop.name);
            }
          });

          this.secondaryStopMarkers.push(marker);
        });
      }

      // 3. Save polyline coordinates
      this.activePolylineCoords = (customPolyline && customPolyline.length > 1) ? customPolyline : latLngs;

      // 4. Draw Primary Route Polyline
      if (this.activePolylineCoords.length > 1) {
        this.routePolyline = L.polyline(this.activePolylineCoords, {
          color: lineColor || '#009485',
          weight: 4.5,
          opacity: 0.9,
          lineCap: 'round',
          lineJoin: 'round'
        }).addTo(this.map);

        // Add Directional Arrow Chevrons
        const primaryArrows = this.createDirectionalArrows(this.activePolylineCoords, lineColor || '#009485');
        this.directionalArrowMarkers.push(...primaryArrows);
      }

      // 5. Draw Secondary Route Polyline (if both directions active)
      if (secondaryPolyline && secondaryPolyline.length > 1) {
        this.secondaryRoutePolyline = L.polyline(secondaryPolyline, {
          color: secondaryColor || '#38bdf8',
          weight: 4,
          opacity: 0.85,
          dashArray: '8, 8',
          lineCap: 'round',
          lineJoin: 'round'
        }).addTo(this.map);

        // Add Directional Arrow Chevrons for secondary direction
        const secondaryArrows = this.createDirectionalArrows(secondaryPolyline, secondaryColor || '#38bdf8');
        this.directionalArrowMarkers.push(...secondaryArrows);
      }

      // 6. Fit Map Bounds
      if (shouldFitBounds || !this._hasFittedInitialBounds) {
        this._hasFittedInitialBounds = true;
        this.fitRouteBounds();
      }

      this.lastStopsFingerprint = stopsFingerprint;
    }

    // Toggle target styling in place on cached markers (no marker rebuild)
    this.applyStopTargetStyles(targetStopId);
  }

  // Dynamic Congestion & Traffic Heatmap Rendering
  renderCongestionHeatmap(segments) {
    if (!this.map || !this.trafficLayerGroup) return;
    this.trafficLayerGroup.clearLayers();
    if (!Array.isArray(segments) || segments.length === 0) return;

    segments.forEach(seg => {
      if (!seg.coords || seg.coords.length < 2) return;
      const poly = L.polyline(seg.coords, {
        color: seg.color || '#10b981',
        weight: 6,
        opacity: 0.85,
        lineCap: 'round',
        lineJoin: 'round'
      });
      poly.bindTooltip(`<strong>${escHtml(seg.label)}</strong> • ${seg.avgSpeedKmh} km/h`, {
        sticky: true,
        className: 'traffic-tooltip'
      });
      this.trafficLayerGroup.addLayer(poly);
    });
  }

  clearCongestionHeatmap() {
    if (this.trafficLayerGroup) {
      this.trafficLayerGroup.clearLayers();
    }
  }

  toggleTrafficHeatmap(enable, segments = []) {
    this.isTrafficEnabled = Boolean(enable);
    if (!this.isTrafficEnabled) {
      this.clearCongestionHeatmap();
    } else if (segments && segments.length > 0) {
      this.renderCongestionHeatmap(segments);
    }
  }

  renderItinerary(itinerary, opts = {}) {
    if (!this.map || !itinerary || !Array.isArray(itinerary.legs)) return;
    this.isItineraryMode = true;
    this._lastItinerary = itinerary;

    // Clear standard line layers & stops
    this.clearAll();
    if (this.itineraryLayerGroup) {
      this.itineraryLayerGroup.clearLayers();
    }

    const allPoints = [];

    // 1. Render each leg with sliced polyline and intermediate stops
    itinerary.legs.forEach((leg, legIdx) => {
      const rawColor = leg.lineColor || leg.color || (legIdx === 0 ? '#0ea5e9' : '#10b981');
      const legColor = (typeof rawColor === 'string' && /^#[0-9a-fA-F]{3,8}$|^rgba?\([0-9,.\s%]+\)$/.test(rawColor.trim()))
        ? rawColor.trim()
        : (legIdx === 0 ? '#0ea5e9' : '#10b981');
      const rawPoly = Array.isArray(leg.polyline) ? leg.polyline : [];
      const polyline = rawPoly.filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));

      if (polyline.length > 1) {
        allPoints.push(...polyline);

        // Draw casing / shadow under the line
        const casing = L.polyline(polyline, {
          color: '#000000',
          weight: 8,
          opacity: 0.45,
          lineCap: 'round',
          lineJoin: 'round'
        });
        this.itineraryLayerGroup.addLayer(casing);

        // Core leg polyline
        const line = L.polyline(polyline, {
          color: legColor,
          weight: 5.5,
          opacity: 0.95,
          lineCap: 'round',
          lineJoin: 'round'
        });
        const stopsN = leg.stopsCount || leg.stopCount || 0;
        const legTooltip = mapT(stopsN === 1 ? 'map.itin.legTooltipOne' : 'map.itin.legTooltipMany', {
          line: `<strong>${escHtml(leg.lineCode)}</strong>`,
          dest: escHtml(leg.destination || ''),
          n: stopsN,
          min: leg.durationMinutes || leg.travelTimeMins || 0
        });
        line.bindTooltip(legTooltip, {
          sticky: true,
          className: 'stop-hover-tooltip'
        });
        this.itineraryLayerGroup.addLayer(line);

        // Direction chevrons
        const arrows = this.createDirectionalArrows(polyline, legColor);
        arrows.forEach(a => this.itineraryLayerGroup.addLayer(a));
      }

      // Intermediate stops (subtle waypoint dots)
      if (Array.isArray(leg.intermediateStops)) {
        leg.intermediateStops.slice(1, -1).forEach(s => {
          const sLat = parseFloat(s.lat || s.latitude);
          const sLon = parseFloat(s.lon || s.longitude);
          if (Number.isFinite(sLat) && Number.isFinite(sLon)) {
            allPoints.push([sLat, sLon]);
            const dot = L.circleMarker([sLat, sLon], {
              radius: 4.5,
              fillColor: '#ffffff',
              fillOpacity: 0.9,
              color: legColor,
              weight: 2
            });
            dot.bindTooltip(`<strong>${escHtml(s.name)}</strong><br><span style="font-size:11px; color:var(--text-secondary);">${escHtml(leg.lineCode)}</span>`, {
              direction: 'top',
              offset: [0, -4],
              className: 'stop-hover-tooltip'
            });
            this.itineraryLayerGroup.addLayer(dot);
          }
        });
      }
    });

    // 2. Render origin walking leg if starting from street/coordinate
    if (itinerary.walkToFirstStop && itinerary.walkToFirstStop.distanceMeters > 5) {
      const walkFrom = itinerary.walkToFirstStop.from;
      const walkTo = itinerary.walkToFirstStop.to;
      if (Array.isArray(walkFrom) && Array.isArray(walkTo) &&
          Number.isFinite(walkFrom[0]) && Number.isFinite(walkFrom[1]) &&
          Number.isFinite(walkTo[0]) && Number.isFinite(walkTo[1])) {
        allPoints.push(walkFrom, walkTo);
        const walkLine = L.polyline(itinerary.walkToFirstStop.polyline || [walkFrom, walkTo], {
          color: '#38bdf8',
          weight: 4,
          opacity: 0.9,
          dashArray: '6, 8',
          lineCap: 'round'
        });
        const origApprox = Boolean(itinerary.walkToFirstStop.approximate);
        const origDist = mapFmtMeters(itinerary.walkToFirstStop.distanceMeters);
        const origMin = itinerary.walkToFirstStop.walkingMinutes;
        walkLine.bindTooltip(mapT(origApprox ? 'map.itin.walkOriginApprox' : 'map.itin.walkOrigin', { dist: origDist, min: origMin }), {
          sticky: true,
          className: 'stop-hover-tooltip'
        });
        this.itineraryLayerGroup.addLayer(walkLine);

        // Origin Address Pin (Compact dot marker to prevent overlapping the bus stop badge)
        const origPinIcon = L.divIcon({
          className: 'custom-itinerary-pin',
          html: `
            <div style="display:flex; align-items:center; justify-content:center; width:28px; height:28px; border-radius:50%; background:#0284c7; border:2.5px solid #ffffff; box-shadow:0 3px 12px rgba(0,0,0,0.55); cursor:pointer;">
              <span style="font-size:14px; line-height:1;">📍</span>
            </div>
          `,
          iconSize: [28, 28],
          iconAnchor: [14, 14]
        });
        const mOrig = L.marker(walkFrom, { icon: origPinIcon, zIndexOffset: 2500 });
        const origPinHeader = mapT('map.itin.originPin', {
          name: escHtml(itinerary.walkToFirstStop.fromName || mapT('map.itin.originFallback', null, 'Punt d\'origen'))
        });
        const origPinMeta = mapT(origApprox ? 'map.itin.walkPinMetaApprox' : 'map.itin.walkPinMeta', { dist: origDist, min: origMin });
        mOrig.bindTooltip(`${origPinHeader}<br><span style="color:#94a3b8; font-size:11px;">${escHtml(origPinMeta)}</span>`, {
          direction: 'top',
          offset: [0, -12],
          className: 'stop-hover-tooltip'
        });
        this.itineraryLayerGroup.addLayer(mOrig);
      }
    }

    // 3. Render walking transfer dashed path if applicable
    if (itinerary.transferWalk && itinerary.transferWalk.distanceMeters > 5) {
      const walkFrom = itinerary.transferWalk.from;
      const walkTo = itinerary.transferWalk.to;
      if (Array.isArray(walkFrom) && Array.isArray(walkTo) &&
          Number.isFinite(walkFrom[0]) && Number.isFinite(walkFrom[1]) &&
          Number.isFinite(walkTo[0]) && Number.isFinite(walkTo[1])) {
        allPoints.push(walkFrom, walkTo);
        const walkLine = L.polyline(itinerary.transferWalk.polyline || [walkFrom, walkTo], {
          color: '#f59e0b',
          weight: 4,
          opacity: 0.9,
          dashArray: '6, 8',
          lineCap: 'round'
        });
        const trApprox = Boolean(itinerary.transferWalk.approximate);
        walkLine.bindTooltip(mapT(trApprox ? 'map.itin.walkTransferApprox' : 'map.itin.walkTransfer', {
          dist: mapFmtMeters(itinerary.transferWalk.distanceMeters),
          min: itinerary.transferWalk.walkingMinutes
        }), {
          sticky: true,
          className: 'stop-hover-tooltip'
        });
        this.itineraryLayerGroup.addLayer(walkLine);
      }
    }

    // 4. Render destination walking leg if ending at street/coordinate
    if (itinerary.walkFromLastStop && itinerary.walkFromLastStop.distanceMeters > 5) {
      const walkFrom = itinerary.walkFromLastStop.from;
      const walkTo = itinerary.walkFromLastStop.to;
      if (Array.isArray(walkFrom) && Array.isArray(walkTo) &&
          Number.isFinite(walkFrom[0]) && Number.isFinite(walkFrom[1]) &&
          Number.isFinite(walkTo[0]) && Number.isFinite(walkTo[1])) {
        allPoints.push(walkFrom, walkTo);
        const walkLine = L.polyline(itinerary.walkFromLastStop.polyline || [walkFrom, walkTo], {
          color: '#f59e0b',
          weight: 4,
          opacity: 0.9,
          dashArray: '6, 8',
          lineCap: 'round'
        });
        const destApprox = Boolean(itinerary.walkFromLastStop.approximate);
        const destDist = mapFmtMeters(itinerary.walkFromLastStop.distanceMeters);
        const destMin = itinerary.walkFromLastStop.walkingMinutes;
        walkLine.bindTooltip(mapT(destApprox ? 'map.itin.walkDestApprox' : 'map.itin.walkDest', { dist: destDist, min: destMin }), {
          sticky: true,
          className: 'stop-hover-tooltip'
        });
        this.itineraryLayerGroup.addLayer(walkLine);

        // Destination Address Pin (Compact dot marker to prevent overlapping the bus stop badge)
        const destPinIcon = L.divIcon({
          className: 'custom-itinerary-pin',
          html: `
            <div style="display:flex; align-items:center; justify-content:center; width:28px; height:28px; border-radius:50%; background:#ef4444; border:2.5px solid #ffffff; box-shadow:0 3px 12px rgba(0,0,0,0.55); cursor:pointer;">
              <span style="font-size:14px; line-height:1;">🏁</span>
            </div>
          `,
          iconSize: [28, 28],
          iconAnchor: [14, 14]
        });
        const mDest = L.marker(walkTo, { icon: destPinIcon, zIndexOffset: 2500 });
        const destPinHeader = mapT('map.itin.destPin', {
          name: escHtml(itinerary.walkFromLastStop.toName || mapT('map.itin.destFallback', null, 'Punt de destinació'))
        });
        const destPinMeta = mapT(destApprox ? 'map.itin.walkPinMetaApprox' : 'map.itin.walkPinMeta', { dist: destDist, min: destMin });
        mDest.bindTooltip(`${destPinHeader}<br><span style="color:#94a3b8; font-size:11px;">${escHtml(destPinMeta)}</span>`, {
          direction: 'top',
          offset: [0, -12],
          className: 'stop-hover-tooltip'
        });
        this.itineraryLayerGroup.addLayer(mDest);
      }
    }

    // 5. Render Major Turn Points: Boarding, Transfer(s), Destination
    this._itineraryBadgeMarkers = [];
    const legs = itinerary.legs;
    const firstLeg = legs[0];
    const lastLeg = legs[legs.length - 1];
    const liveLabel = escHtml(mapT('map.itin.live', null, '🟢 En viu'));
    const schedLabel = escHtml(mapT('map.itin.timetable', null, '📅 Horari'));

    // 🟢 Origin / Boarding Marker
    if (firstLeg && firstLeg.fromStop) {
      const oLat = parseFloat(firstLeg.fromStop.lat || firstLeg.fromStop.latitude);
      const oLon = parseFloat(firstLeg.fromStop.lon || firstLeg.fromStop.longitude);
      if (Number.isFinite(oLat) && Number.isFinite(oLon)) {
        allPoints.push([oLat, oLon]);
        const originColor = (firstLeg.lineColor || firstLeg.color || '#10b981');
        const safeOriginColor = (typeof originColor === 'string' && /^#[0-9a-fA-F]{3,8}$|^rgba?\([0-9,.\s%]+\)$/.test(originColor.trim()))
          ? originColor.trim() : '#10b981';

        const depTimeHtml = firstLeg.departureTime && firstLeg.departureTime !== 'En breu'
          ? `<span style="font-size:11px; font-weight:800; color:#10b981; background:rgba(16,185,129,0.15); padding:1px 5px; border-radius:4px; margin-left:auto;">🕐 ${escHtml(firstLeg.departureTime)}</span>`
          : '';
        const rtBadge = firstLeg.isRealTime
          ? `<span style="font-size:10px; color:#10b981; font-weight:700;">${liveLabel}</span>`
          : `<span style="font-size:10px; color:#94a3b8;">${schedLabel}</span>`;

        const originIcon = L.divIcon({
          className: 'custom-itinerary-marker',
          html: `
            <div class="itinerary-node-badge node-origin" style="--node-color:${safeOriginColor}; min-width:185px;">
              <span class="node-icon">🟢</span>
              <div class="node-label">
                <div class="node-action" style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
                  <span>${escHtml(mapT('map.itin.boardLine', { line: firstLeg.lineCode }, `Pujar a ${firstLeg.lineCode}`))}</span>
                  ${depTimeHtml}
                </div>
                <div class="node-name" style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
                  <span>${escHtml(firstLeg.fromStop.name)}</span>
                  ${rtBadge}
                </div>
              </div>
            </div>
          `,
          iconSize: [185, 42],
          iconAnchor: [20, 21]
        });
        const m = L.marker([oLat, oLon], { icon: originIcon, zIndexOffset: 2000 });
        this.itineraryLayerGroup.addLayer(m);
        this._itineraryBadgeMarkers.push({ marker: m, anchorX: 20, anchorY: 21 });
      }
    }

    // 🔄 Transfer Marker(s)
    for (let i = 0; i < legs.length - 1; i++) {
      const curLeg = legs[i];
      const nextLeg = legs[i + 1];
      const tStop = curLeg.toStop || nextLeg.fromStop;
      if (tStop) {
        const tLat = parseFloat(tStop.lat || tStop.latitude);
        const tLon = parseFloat(tStop.lon || tStop.longitude);
        if (Number.isFinite(tLat) && Number.isFinite(tLon)) {
          allPoints.push([tLat, tLon]);

          const tDepTimeHtml = nextLeg.departureTime && nextLeg.departureTime !== 'En breu'
            ? `<span style="font-size:11px; font-weight:800; color:#f59e0b; background:rgba(245,158,11,0.15); padding:1px 5px; border-radius:4px; margin-left:auto;">🕐 ${escHtml(nextLeg.departureTime)}</span>`
            : '';
          const tRtBadge = nextLeg.isRealTime
            ? `<span style="font-size:10px; color:#10b981; font-weight:700;">${liveLabel}</span>`
            : `<span style="font-size:10px; color:#94a3b8;">${schedLabel}</span>`;

          const transferIcon = L.divIcon({
            className: 'custom-itinerary-marker',
            html: `
              <div class="itinerary-node-badge node-transfer" style="--node-color:#f59e0b; min-width:195px;">
                <span class="node-icon">🔄</span>
                <div class="node-label">
                  <div class="node-action" style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
                    <span>${escHtml(mapT('map.itin.boardLine', { line: nextLeg.lineCode }, `Pujar a ${nextLeg.lineCode}`))}</span>
                    ${tDepTimeHtml}
                  </div>
                  <div class="node-name" style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
                    <span>${escHtml(tStop.name)}</span>
                    ${tRtBadge}
                  </div>
                </div>
              </div>
            `,
            iconSize: [195, 42],
            iconAnchor: [20, 21]
          });
          const m = L.marker([tLat, tLon], { icon: transferIcon, zIndexOffset: 2000 });
          this.itineraryLayerGroup.addLayer(m);
          this._itineraryBadgeMarkers.push({ marker: m, anchorX: 20, anchorY: 21 });
        }
      }
    }

    // 🏁 Destination Alighting Marker
    if (lastLeg && lastLeg.toStop) {
      const dLat = parseFloat(lastLeg.toStop.lat || lastLeg.toStop.latitude);
      const dLon = parseFloat(lastLeg.toStop.lon || lastLeg.toStop.longitude);
      if (Number.isFinite(dLat) && Number.isFinite(dLon)) {
        allPoints.push([dLat, dLon]);
        const destIcon = L.divIcon({
          className: 'custom-itinerary-marker',
          html: `
            <div class="itinerary-node-badge node-destination" style="--node-color:#ef4444">
              <span class="node-icon">🏁</span>
              <div class="node-label">
                <div class="node-action">${escHtml(mapT('map.itin.alightLine', { line: lastLeg.lineCode }, `Baixar de ${lastLeg.lineCode}`))}</div>
                <div class="node-name">${escHtml(lastLeg.toStop.name)}</div>
              </div>
            </div>
          `,
          iconSize: [160, 36],
          iconAnchor: [20, 18]
        });
        const m = L.marker([dLat, dLon], { icon: destIcon, zIndexOffset: 2000 });
        this.itineraryLayerGroup.addLayer(m);
        this._itineraryBadgeMarkers.push({ marker: m, anchorX: 20, anchorY: 18 });
      }
    }

    if (!this._itineraryZoomBound && this.map) {
      this._itineraryZoomBound = true;
      this.map.on('zoomend', () => this.layoutItineraryBadges());
    }

    // 6. Fit bounds
    if (opts.fitBounds !== false && allPoints.length > 1) {
      const bounds = L.latLngBounds(allPoints);
      if (bounds && bounds.isValid()) {
        this.map.fitBounds(bounds, { padding: [60, 60], maxZoom: 16 });
      }
    }

    requestAnimationFrame(() => this.layoutItineraryBadges());
  }

  layoutItineraryBadges() {
    if (!this.map || !Array.isArray(this._itineraryBadgeMarkers) || this._itineraryBadgeMarkers.length === 0) return;
    const compact = this.map.getZoom() <= 10;
    const pad = 8;
    const placed = [];

    const overlapArea = (a, b) => {
      const ox = Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l));
      const oy = Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
      return ox * oy;
    };

    for (const item of this._itineraryBadgeMarkers) {
      const root = item.marker?.getElement?.();
      const el = root ? root.querySelector('.itinerary-node-badge') : null;
      if (!el) continue;

      el.classList.toggle('is-compact', compact);
      const p = this.map.latLngToContainerPoint(item.marker.getLatLng());
      const w = el.offsetWidth || 190;
      const h = el.offsetHeight || 42;
      const stepY = h + 10;
      const leftX = -(w - item.anchorX * 2);

      const candidates = [
        [0, 0],
        [0, -stepY],
        [0, stepY],
        [leftX, 0],
        [leftX, -stepY],
        [leftX, stepY],
        [0, -stepY * 2],
        [0, stepY * 2],
        [leftX, -stepY * 2],
        [leftX, stepY * 2],
      ];

      let best = candidates[0];
      let bestScore = Infinity;
      let bestBox = null;

      for (const cand of candidates) {
        const l = p.x - item.anchorX + cand[0] - pad;
        const t = p.y - item.anchorY + cand[1] - pad;
        const box = { l, t, r: l + w + pad * 2, b: t + h + pad * 2 };
        let area = 0;
        for (const other of placed) {
          area += overlapArea(box, other);
        }
        if (area === 0) {
          best = cand;
          bestBox = box;
          break;
        }
        if (area < bestScore) {
          bestScore = area;
          best = cand;
          bestBox = box;
        }
      }

      el.style.setProperty('--badge-dx', `${Math.round(best[0])}px`);
      el.style.setProperty('--badge-dy', `${Math.round(best[1])}px`);
      if (bestBox) placed.push(bestBox);
    }
  }

  clearItinerary() {
    this.isItineraryMode = false;
    this._lastItinerary = null;
    this._itineraryBadgeMarkers = [];
    if (this.itineraryLayerGroup) {
      this.itineraryLayerGroup.clearLayers();
    }
  }

  // Applies/removes target styling on the cached stop markers by mutating the
  // existing marker DOM instead of tearing down and rebuilding every marker.
  applyStopTargetStyles(targetStopId = '') {
    if (!this.stopMarkers || this.stopMarkers.length === 0) return;
    const targetStr = String(targetStopId || '');
    this.stopMarkers.forEach(marker => {
      if (!marker || !marker._stopMeta) return;
      const meta = marker._stopMeta;
      const root = marker.getElement();
      let dot = (marker._dotEl && root && root.contains(marker._dotEl)) ? marker._dotEl : null;
      if (!dot && root) dot = root.querySelector('.stop-marker-dot');
      marker._dotEl = dot || null;
      if (!dot) return;

      if (meta.isCancelled) {
        dot.style.background = 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)';
        dot.style.border = '2px solid #ffffff';
        dot.style.boxShadow = '0 0 0 3px rgba(220, 38, 38, 0.45), 0 0 14px rgba(239, 68, 68, 0.9)';
        dot.style.width = '20px';
        dot.style.height = '20px';
        return;
      }

      const isTarget = !!targetStr && meta.id === targetStr;
      dot.classList.toggle('target', isTarget);
      dot.style.width = isTarget ? '22px' : '14px';
      dot.style.height = isTarget ? '22px' : '14px';
      dot.style.backgroundColor = isTarget ? meta.lineColor : '#06b6d4';
      dot.style.boxShadow = isTarget ? `0 0 10px ${meta.lineColor}` : '0 0 10px rgba(0,0,0,0.5)';
      dot.style.animation = isTarget ? 'pulse-dot 1.5s infinite' : '';
    });
  }

  fitRouteBounds(attempt = 0) {
    if (!this.map) return;
    if (this._fitBoundsTimer) {
      clearTimeout(this._fitBoundsTimer);
      this._fitBoundsTimer = null;
    }
    this.map.invalidateSize({ pan: false });
    const size = this.map.getSize();
    if (!size || size.x === 0 || size.y === 0) {
      if (attempt < 20) {
        this._fitBoundsTimer = setTimeout(() => this.fitRouteBounds(attempt + 1), 100);
      }
      return;
    }

    const boundsGroup = [];
    if (this.routePolyline && this.routePolyline.getLatLngs() && this.routePolyline.getLatLngs().length > 0) {
      boundsGroup.push(this.routePolyline);
    }
    if (this.secondaryRoutePolyline && this.secondaryRoutePolyline.getLatLngs() && this.secondaryRoutePolyline.getLatLngs().length > 0) {
      boundsGroup.push(this.secondaryRoutePolyline);
    }

    if (boundsGroup.length > 0) {
      const group = new L.featureGroup(boundsGroup);
      try {
        this.map.fitBounds(group.getBounds(), { padding: [35, 35], maxZoom: 15 });
      } catch {}
    } else if (this.activePolylineCoords && this.activePolylineCoords.length > 0) {
      try {
        this.map.fitBounds(L.latLngBounds(this.activePolylineCoords), { padding: [35, 35], maxZoom: 15 });
      } catch {}
    }
  }



  clearAll() {
    if (!this.map) return;
    this.clearAllBusMarkers();
    this.clearVehicleTrail();
    this.stopMarkers.forEach(m => this.map.removeLayer(m));
    this.stopMarkers = [];
    if (this.secondaryStopMarkers) {
      this.secondaryStopMarkers.forEach(m => this.map.removeLayer(m));
      this.secondaryStopMarkers = [];
    }
    if (this.directionalArrowMarkers) {
      this.directionalArrowMarkers.forEach(m => this.map.removeLayer(m));
      this.directionalArrowMarkers = [];
    }
    if (this.routePolyline) {
      this.map.removeLayer(this.routePolyline);
      this.routePolyline = null;
    }
    if (this.secondaryRoutePolyline) {
      this.map.removeLayer(this.secondaryRoutePolyline);
      this.secondaryRoutePolyline = null;
    }
    this.lastStopsFingerprint = null;
    this._hasFittedInitialBounds = false;
    this.updateRouteSourceBadge(null);
  }

  /**
   * Shows/hides the 'estimated route' badge inside the map container.
   * geometryInfo: { estimated: bool, source: string } | null
   */
  updateRouteSourceBadge(geometryInfo) {
    if (!this.map) return;
    this._lastGeometryInfo = geometryInfo;
    let badge = document.getElementById('route-source-badge');
    if (!badge && this.map.getContainer()) {
      badge = document.createElement('div');
      badge.id = 'route-source-badge';
      badge.className = 'route-source-badge';
      this.map.getContainer().appendChild(badge);
    }
    if (!badge) return;
    if (geometryInfo && geometryInfo.estimated) {
      badge.textContent = mapT('map.routeEst.badge', null, '⚠️ Traçat estimat');
      badge.title = mapT('map.routeEst.title', null, "Aquest traçat està calculat (OSRM o interpolació entre parades) i pot no coincidir exactament amb la ruta real de l'operador.");
      badge.style.display = 'block';
    } else {
      badge.style.display = 'none';
    }
  }

  clearAllBusMarkers() {
    if (!this.map) return;
    this.clearVehicleTrail();
    for (const [, obj] of this.busMarkersMap.entries()) {
      if (obj.marker) {
        this.map.removeLayer(obj.marker);
      }
    }
    this.busMarkersMap.clear();
    this.selectedVehicleId = null;
    this.lastStopsFingerprint = null;
    this._hasFittedInitialBounds = false;
  }

  // Stable identity for a vehicle marker across the REST and SSE sources.
  // REST vehicles carry both `tripId: 'mataro_<id>'` and `vehicleId`, while SSE
  // vehicles carry only `vehicleId`; keying on tripId made the marker identity
  // flip between sources and forced a destroy/recreate (popup close + LERP
  // teleport) on every REST/SSE alternation. Prefer a real vehicleId; fall
  // back to tripId only for theoretical EST_ vehicles which have no real id.
  busMarkerKey(bus) {
    const vehId = String(bus?.vehicleId || '').trim();
    if (vehId && !vehId.startsWith('EST_')) return vehId;
    const tripId = String(bus?.tripId || '').trim();
    if (tripId) return tripId;
    return vehId || `${bus?.lat}_${bus?.lon}`;
  }

  isBusSelected(bus, selectedId = this.selectedVehicleId) {
    if (!selectedId || !bus) return false;
    const s = String(selectedId).trim();
    return String(bus.tripId || '').trim() === s || 
           String(bus.vehicleId || '').trim() === s || 
           String(bus.id || '').trim() === s;
  }

  highlightBus(selectedVehicleId, shouldPan = false, coords = null) {
    this.selectedVehicleId = selectedVehicleId;
    let targetLatLng = null;

    for (const [, obj] of this.busMarkersMap.entries()) {
      const isSel = this.isBusSelected(obj.busData, selectedVehicleId);
      const el = obj.marker.getElement();
      if (el) {
        const wrapEl = el.querySelector('.live-bus-marker-wrap');
        if (wrapEl) {
          wrapEl.classList.toggle('selected', isSel);
          const ringEl = el.querySelector('.bus-selection-ring');
          if (ringEl) ringEl.style.display = isSel ? 'block' : 'none';
        }
        obj.marker.setZIndexOffset(isSel ? 5000 : 2000);
      }
      if (isSel) {
        targetLatLng = obj.marker.getLatLng();
      }
    }

    if (!targetLatLng && coords && coords.lat && coords.lon) {
      targetLatLng = L.latLng(coords.lat, coords.lon);
    }

    if (shouldPan && targetLatLng && this.map) {
      const currentZoom = this.map.getZoom();
      this.map.setView(targetLatLng, Math.max(currentZoom, 15), { animate: true, duration: 0.6 });
    }
  }

  openBusPopup(selectedVehicleId) {
    if (!selectedVehicleId) return;
    const s = String(selectedVehicleId).trim();
    for (const [, obj] of this.busMarkersMap.entries()) {
      if (this.isBusSelected(obj.busData, s)) {
        obj.marker.openPopup();
        break;
      }
    }
  }

  /**
   * Builds the bus popup card shared by the single-line map and the all-lines
   * network map, so both render the exact same telemetry-honest card instead of
   * two templates that can drift apart.
   *
   * ctx: { isGhost, isEst, isSecDir, busColor, snapped, bearingAngle, lineCode, showLineLink }
   *   isSecDir marks a bus running the return direction (its popup says
   *   "Sentit contrari" rather than claiming a destination).
   *   showLineLink appends an "Obre la línia L<n>" button, handled by event
   *   delegation in each map's own `popupopen` listener.
   */
  buildBusPopupHtml(bus, ctx = {}) {
    // A train (GTFS-RT) gets the train popup: what its operator reported,
    // with rail's punctuality rule, never the bus wording.
    if (bus && bus.positionSource === 'gtfsrt' && typeof window.buildTrainPopupHtml === 'function') {
      return window.buildTrainPopupHtml(bus, { name: bus.agency, attribution: bus.attribution });
    }
    const isGhost = Boolean(ctx.isGhost);
    const isEst = Boolean(ctx.isEst);
    const isSecDir = Boolean(ctx.isSecDir);
    const busColor = ctx.busColor;
    const snapped = ctx.snapped || { lat: Number(bus.lat), lon: Number(bus.lon) };
    const bearingAngle = Math.round(Number(ctx.bearingAngle) || 0);

      const compassLabel = bus.compass?.label || 'N/A';
      const coordsText = `${snapped.lat.toFixed(5)}°, ${snapped.lon.toFixed(5)}°`;

      const lineBadge = bus.lineCode || bus.lineId || ctx.lineCode || '';
      const fromStop = bus.fromStop ? escHtml(bus.fromStop) : '';
    const toStop = bus.toStop ? escHtml(bus.toStop) : (bus.destination ? escHtml(bus.destination) : '');
    const progressNum = Math.max(0, Math.min(100, Math.round(Number(bus.totalProgress) || 0)));
    // Speed telemetry honesty: only print a km/h figure when the field is an
    // actual finite measurement. Synthetic/estimated vehicles have no observed
    // speed -> show "—" flagged as estimated; a real vehicle with no speed ->
    // show unknown. Never invent a range.
    // NOTE: mataroSiriClient.js:319 still fabricates `speedKmh: 25` when the
    // upstream <Velocity> is missing/unparseable, so a reported 25 is not yet
    // distinguishable from a real reading. That is the remaining source-side fix.
    const hasMeasuredSpeed = bus.speedKmh !== undefined && bus.speedKmh !== null && Number.isFinite(Number(bus.speedKmh));
    let speedValue;
    if (isGhost) {
      speedValue = mapT('map.popup.speedTimetable', null, '— (Horari teòric)');
    } else if (isEst && !hasMeasuredSpeed) {
      speedValue = mapT('map.popup.speedEst', null, '— (Estimat)');
    } else if (hasMeasuredSpeed) {
      speedValue = `${Math.round(Number(bus.speedKmh))} km/h`;
    } else if (bus.isTerminalLayover) {
      speedValue = mapT('map.popup.speedStopped', null, '0 km/h (Aturat)');
    } else {
      speedValue = mapT('map.popup.speedNoData', null, '— (Sense dada)');
    }

    let delayClass = 'on-time';
    let delayBadgeText = bus.delayFormatted || mapT('map.popup.onTime', null, 'Puntual');
    const dMins = Number(bus.delayMins !== undefined ? bus.delayMins : (bus.delayMinutes !== undefined ? bus.delayMinutes : 0));

    // A special service has no timetable: there is no delay to state.
    const isSpecial = Boolean(bus.isSpecialService);
    if (isSpecial) {
      delayClass = 'layover';
      delayBadgeText = mapT('map.popup.specialService', null, 'Servei especial');
    } else if (isGhost) {
      delayClass = 'ghost';
      delayBadgeText = mapT('map.popup.noGpsTimetable', null, '⚡ Sense GPS (Horari)');
    } else if (bus.isTerminalLayover || bus.delayStatus === 'regulating') {
      delayClass = 'layover';
      delayBadgeText = mapT('map.popup.regulating', null, 'Regulant');
    } else if (bus.delayStatus === 'delayed' || dMins >= 2) {
      delayClass = dMins >= 5 ? 'critical' : 'delayed';
      delayBadgeText = mapT('map.popup.delayLate', { n: dMins }, `+${dMins} min retard`);
    } else if (bus.delayStatus === 'early' || dMins <= -1) {
      delayClass = 'early';
      delayBadgeText = mapT('map.popup.delayEarly', { n: dMins }, `${dMins} min avançat`);
    } else if (String(delayBadgeText).toLowerCase().includes('puntual')) {
      delayClass = 'on-time';
      delayBadgeText = mapT('map.popup.onTime', null, 'Puntual');
    }

    const hasChips = Boolean(bus.isAccessible || bus.isElectric || bus.isHybrid || bus.propulsion || bus.modelName || bus.tripStartTime);
    const layoverSubtitle = isGhost
      ? mapT('map.popup.layoverNoGps', null, 'Capçalera / Regulació (Sense GPS)')
      : mapT('map.popup.layoverTitle', null, 'Capçalera / Regulació');
    const noGpsBadgeText = mapT('map.popup.noGpsBadge', null, '⚡ Sense GPS');
    const speedLabel = escHtml(mapT('map.popup.speedLabel', null, 'Velocitat'));
    const statusLabel = escHtml(mapT('map.popup.statusLabel', null, 'Estat'));
    const shareBusLabel = escHtml(mapT('map.popup.shareBus', null, "Compartir seguiment d'aquest bus"));
    const layoverDepHtml = bus.departureTime
      ? mapT('map.popup.layoverGhostDep', { time: escHtml(bus.departureTime) })
      : '';
    const ghostDepHtml = bus.departureTime
      ? mapT('map.popup.ghostDep', { time: escHtml(bus.departureTime) })
      : '';
    const statusValSubtitle = isSpecial
      ? (bus.destination
          ? mapT('map.popup.specialServiceTo', { dest: escHtml(bus.destination) }, `Servei especial · ${escHtml(bus.destination)}`)
          : mapT('map.popup.specialService', null, 'Servei especial'))
      : isGhost
      ? mapT('map.popup.officialNoGps', null, 'Horari Oficial (Sense GPS)')
      : (isSecDir
          ? mapT('map.popup.oppositeDir', null, 'Sentit contrari')
          : (bus.destination
              ? mapT('map.popup.destPrefix', { dest: escHtml(bus.destination) }, `Dest: ${escHtml(bus.destination)}`)
              : mapT('map.popup.inService', null, 'En servei')));
    const statusBadgeText = isGhost
      ? noGpsBadgeText
      : (isEst ? mapT('map.popup.statusEstimated', null, 'Estimació') : mapT('map.popup.statusLive', null, 'En directe'));
    const sourceTagText = isGhost
      ? mapT('map.popup.sourceGhost', null, '⚡ Horari Oficial (Sense GPS)')
      : (isEst
          ? mapT('map.popup.sourceDeadReckoning', null, 'Estimació per estima (GPS perdut)')
          : mapT('map.popup.sourceLiveGps', null, 'GPS Directe (SIRI)'));

    const popupHtml = bus.isTerminalLayover ? `
      <div class="map-popup-card">
        <div class="map-popup-header">
          <div class="map-popup-title-group">
            <div class="map-popup-bus-icon ${isGhost ? 'ghost' : 'layover'}">
              <span>${isGhost ? '⚡' : '🅿️'}</span>
            </div>
            <div class="map-popup-title-text">
              <div class="map-popup-title">
                ${lineBadge ? `<span class="map-popup-line-pill" style="background:${busColor || '#3b82f6'};">${escHtml(lineBadge)}</span>` : ''}
                <span class="map-popup-bus-id">Bus ${bus.vehicleId ? `#${escHtml(bus.vehicleId)}` : ''}</span>
              </div>
              <div class="map-popup-subtitle" title="${escHtml(layoverSubtitle)}">${escHtml(layoverSubtitle)}</div>
            </div>
          </div>
          <div class="map-popup-header-status">
            <span class="map-popup-status-badge ${isGhost ? 'ghost' : 'layover'}">
              <span class="status-pulse-dot"></span>
              <span>${escHtml(isGhost ? noGpsBadgeText : mapT('map.popup.stoppedBadge', null, 'Aturat'))}</span>
            </span>
          </div>
        </div>

        ${isGhost ? `
        <div class="map-popup-ghost-notice">
          <span class="ghost-icon">⚡</span>
          <span>${mapT('map.popup.layoverGhostNotice', { dep: layoverDepHtml })}</span>
        </div>` : ''}

        <div class="map-popup-route-ribbon">
          <div class="map-popup-route-stop from">
            <span class="map-popup-stop-dot"></span>
            <span class="map-popup-stop-name">${((bus.totalProgress >= 90 && bus.toStop) ? toStop : fromStop) || escHtml(mapT('map.popup.terminusFallback', null, 'Capçalera de Línia'))}</span>
          </div>
          <div class="map-popup-route-badge-layover">${bus.departureTime ? escHtml(mapT('map.popup.departureTime', { time: bus.departureTime })) : escHtml(mapT('map.popup.servicePause', null, 'Pausa de servei'))}</div>
        </div>

        <div class="map-popup-metrics-grid">
          <div class="map-popup-metric-tile" title="${escHtml(mapT('map.popup.speedTitle', { val: '0 km/h' }))}">
            <div class="map-popup-metric-header">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
              <span>${speedLabel}</span>
            </div>
            <div class="map-popup-metric-val"><span>0 km/h</span></div>
          </div>
          <div class="map-popup-metric-tile" title="${escHtml(mapT('map.popup.statusTitle', { val: mapT('map.popup.regulatingSchedule', null, 'Regulant horari') }))}">
            <div class="map-popup-metric-header">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              <span>${statusLabel}</span>
            </div>
            <div class="map-popup-metric-val layover"><span>${escHtml(mapT('map.popup.regulatingSchedule', null, 'Regulant horari'))}</span></div>
          </div>
        </div>

        <div class="map-popup-coords-footer">
          <div class="coords-item">
            <span class="radar-dot"></span>
            <span>${coordsText}</span>
          </div>
          <span class="source-tag">${escHtml(mapT('map.popup.terminusTag', null, 'Capçalera'))}</span>
        </div>

        <button type="button" class="map-popup-btn-share" data-share-vehicle="${escHtml(bus.vehicleId)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
          </svg>
          <span>${shareBusLabel}</span>
        </button>
      </div>
    ` : `
      <div class="map-popup-card">
        <div class="map-popup-header">
          <div class="map-popup-title-group">
            <div class="map-popup-bus-icon ${isGhost ? 'ghost' : ''}" style="border-color:${isGhost ? 'rgba(245, 158, 11, 0.5)' : (busColor ? busColor + '66' : 'rgba(14, 165, 233, 0.3)')}; color:${isGhost ? '#fbbf24' : (busColor || '#38bdf8')};">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4.7 17.5H3.4A1.4 1.4 0 0 1 2 16.1V6.4A1.4 1.4 0 0 1 3.4 5H17.5A4.5 4.5 0 0 1 22 9.5v6.6a1.4 1.4 0 0 1-1.4 1.4h-1.3"/>
                <path d="M9.3 17.5h5.4"/>
                <path d="M2 11.6h20"/>
                <path d="M7.5 5v6.6M12.5 5v6.6M17.6 5.2v6.4"/>
                <circle cx="7" cy="17.5" r="2.3"/>
                <circle cx="17" cy="17.5" r="2.3"/>
              </svg>
            </div>
            <div class="map-popup-title-text">
              <div class="map-popup-title">
                ${lineBadge ? `<span class="map-popup-line-pill" style="background:${busColor || 'var(--c10-primary)'};">${escHtml(lineBadge)}</span>` : ''}
                <span class="map-popup-bus-id">Bus ${bus.vehicleId ? `#${escHtml(bus.vehicleId)}` : ''}</span>
              </div>
              <div class="map-popup-subtitle" title="${bus.destination ? escHtml(bus.destination) : ''}">
                ${statusValSubtitle}
              </div>
            </div>
          </div>

          <div class="map-popup-header-status">
            <span class="map-popup-status-badge ${isGhost ? 'ghost' : (isEst ? 'estimated' : 'live')}">
              <span class="status-pulse-dot"></span>
              <span>${escHtml(statusBadgeText)}</span>
            </span>
          </div>
        </div>

        ${isGhost ? `
        <div class="map-popup-ghost-notice">
          <span class="ghost-icon">⚡</span>
          <span>${mapT('map.popup.ghostNotice', { dep: ghostDepHtml })}</span>
        </div>` : ''}

        ${bus.offRoute ? `
        <div class="map-popup-offroute-notice">
          <span class="ghost-icon">↯</span>
          <span>${mapT('map.popup.offRouteNotice', { m: Number(bus.offRouteM) || mapT('map.popup.offRouteFallback', null, 'més de 75') })}</span>
        </div>` : ''}

        ${(fromStop && toStop) ? `
        <div class="map-popup-route-ribbon">
          <div class="map-popup-route-stop from">
            <span class="map-popup-stop-dot"></span>
            <span class="map-popup-stop-name" title="${fromStop}">${fromStop}</span>
          </div>
          <div class="map-popup-route-connector">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
          </div>
          <div class="map-popup-route-stop to">
            <span class="map-popup-stop-dot dest" style="background:${busColor || 'var(--c10-primary-light)'}; box-shadow:0 0 6px ${busColor || 'var(--c10-primary-light)'};"></span>
            <span class="map-popup-stop-name" title="${toStop}">${toStop}</span>
          </div>
        </div>` : (toStop || fromStop ? `
        <div class="map-popup-route-ribbon single">
          <div class="map-popup-route-stop from">
            <span class="map-popup-stop-dot dest" style="background:${busColor || 'var(--c10-primary-light)'};"></span>
            <span class="map-popup-stop-name">${toStop || fromStop}</span>
          </div>
        </div>` : '')}

        <div class="map-popup-metrics-grid">
          <div class="map-popup-metric-tile" title="${escHtml(mapT('map.popup.speedTitle', { val: speedValue }))}">
            <div class="map-popup-metric-header">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
              <span>${speedLabel}</span>
            </div>
            <div class="map-popup-metric-val"><span>${escHtml(speedValue)}</span></div>
          </div>

          <div class="map-popup-metric-tile" title="${escHtml(mapT('map.popup.statusTitle', { val: delayBadgeText }))}">
            <div class="map-popup-metric-header">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              <span>${statusLabel}</span>
            </div>
            <div class="map-popup-metric-val ${delayClass}"><span>${escHtml(delayBadgeText)}</span></div>
          </div>

          <div class="map-popup-metric-tile" title="${escHtml(mapT('map.popup.headingTitle', { compass: compassLabel, deg: bearingAngle }))}">
            <div class="map-popup-metric-header">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 19 21 12 17 5 21 12 2"/></svg>
              <span>${escHtml(mapT('map.popup.headingLabel', null, 'Rumb'))}</span>
            </div>
            <div class="map-popup-metric-val map-popup-compass-val">
              <svg class="map-popup-compass-arrow" style="transform: rotate(${bearingAngle}deg);" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="12 2 19 21 12 17 5 21 12 2"/>
              </svg>
              <span class="map-popup-compass-text">${escHtml(compassLabel)} <span class="map-popup-bearing-deg">(${bearingAngle}°)</span></span>
            </div>
          </div>

          ${isSpecial ? '' : `
          <div class="map-popup-metric-tile" title="${escHtml(mapT('map.popup.progressTitle', { pct: progressNum }))}">
            <div class="map-popup-metric-header">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
              <span>${escHtml(mapT('map.popup.progressLabel', null, 'Progrés'))}</span>
            </div>
            <div class="map-popup-metric-val"><span>${progressNum}%</span></div>
            <div class="map-popup-progress-track">
              <div class="map-popup-progress-fill" style="width: ${progressNum}%;"></div>
            </div>
          </div>
          `}
        </div>

        ${(hasChips || isGhost) ? `
        <div class="map-popup-fleet-chips">
          ${isGhost ? `<span class="map-popup-chip ghost" title="${escHtml(mapT('map.popup.chipNoGpsTitle', null, 'Vehicle sense telemetria GPS'))}"><span class="chip-icon">⚡</span> ${escHtml(mapT('map.popup.chipNoGps', null, 'Sense senyal GPS'))}</span>` : ''}
          ${bus.isAccessible ? `<span class="map-popup-chip pmr" title="${escHtml(mapT('map.popup.chipPmrTitle', null, 'Vehicle Adaptat PMR'))}"><span class="chip-icon">♿</span> ${escHtml(mapT('map.popup.chipPmr', null, 'Adaptat PMR'))}</span>` : ''}
          ${bus.isElectric 
            ? `<span class="map-popup-chip electric"><span class="chip-icon">⚡</span> ${escHtml(mapT('map.popup.chipElectric', null, '100% Elèctric'))}</span>` 
            : (bus.isHybrid 
              ? `<span class="map-popup-chip hybrid"><span class="chip-icon">🌱</span> ${escHtml(mapT('map.popup.chipHybrid', null, 'Híbrid Eco'))}</span>` 
              : (bus.propulsion ? `<span class="map-popup-chip propulsion"><span class="chip-icon">${CANONICAL_BUS_ICON_INNER_SVG}</span> ${escHtml(bus.propulsion)}</span>` : ''))}
          ${bus.modelName ? `<span class="map-popup-chip model" title="${escHtml(bus.modelName)}"><span class="chip-icon">🚍</span> ${escHtml(bus.modelName)}</span>` : ''}
          ${bus.tripStartTime || bus.departureTime ? `<span class="map-popup-chip start-time"><span class="chip-icon">🕐</span> ${escHtml(mapT('map.popup.chipDeparture', { time: bus.tripStartTime || bus.departureTime }))}</span>` : ''}
        </div>` : ''}

        <div class="map-popup-coords-footer">
          <div class="coords-item">
            <span class="radar-dot ${isGhost ? 'ghost' : (isEst ? 'estimated' : '')}"></span>
            <span>${coordsText}</span>
          </div>
          <span class="source-tag">${escHtml(sourceTagText)}</span>
        </div>

        <button type="button" class="map-popup-btn-share" data-share-vehicle="${escHtml(bus.vehicleId)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
          </svg>
          <span>${shareBusLabel}</span>
        </button>

        ${ctx.showLineLink && lineBadge ? `
        <button type="button" class="map-popup-btn-share" data-open-line="${escHtml(lineBadge)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="3 11 22 2 13 21 11 13 3 11"></polygon>
          </svg>
          <span>${escHtml(mapT('map.popup.openLine', { line: lineBadge }, `Obre la línia ${lineBadge}`))}</span>
        </button>` : ''}
      </div>
    `;

    return popupHtml;
  }

  // Update active bus markers and attach road subpaths
  updateBusMarkers(activeBuses, lineColor = '#009485', secondaryColor = '#38bdf8', selectedVehicleId = null, onBusClick = null, lineId = null) {
    if (!this.map || this.isItineraryMode) {
      if (this.isItineraryMode && this.busMarkersMap.size > 0) this.clearAllBusMarkers();
      return;
    }

    if (lineId && this.currentLineId && String(this.currentLineId) !== String(lineId)) {
      this.clearAllBusMarkers();
    }
    if (lineId) {
      this.currentLineId = String(lineId);
    }

    if (selectedVehicleId !== null) {
      this.selectedVehicleId = selectedVehicleId;
    }

    if (!activeBuses || activeBuses.length === 0) {
      for (const [, obj] of this.busMarkersMap.entries()) {
        if (obj.marker) this.map.removeLayer(obj.marker);
      }
      this.busMarkersMap.clear();
      return;
    }

    const now = Date.now();
    const currentTripIds = new Set(activeBuses.map(b => this.busMarkerKey(b)));
    const activePhysicalVehIds = new Set(activeBuses.map(b => String(b.vehicleId || '').trim()).filter(Boolean));
    const activeDirsWithLiveGps = new Set(activeBuses.filter(b => !b.isEstimated).map(b => String(b.direction)));

    // Handle missing buses with strict 90s dead-reckoning hold buffer (§7.6)
    // Physical vehicle deduplication: a vehicleId can only have 1 marker on the map.
    for (const [tId, obj] of this.busMarkersMap.entries()) {
      if (!currentTripIds.has(tId)) {
        const elapsedSec = (now - (obj.lastUpdated || now)) / 1000;
        const objVehId = String(obj.busData?.vehicleId || '').trim();

        // Invariant 1: If a physical vehicleId is already present in current incoming activeBuses under any key,
        // purge this stale entry immediately if its key differs, so we NEVER display duplicate markers for the same bus!
        const isVehHandledByActiveKey = Boolean(objVehId && activePhysicalVehIds.has(objVehId));

        // Invariant 2: Stale marker proximity guard. If marker is within 800m of ANY active live bus on the same line,
        // it is a phantom duplicate resulting from position jitter or reconnection -> purge immediately.
        let isNearLiveBus = false;
        if (obj.marker && obj.marker.getLatLng) {
          const mPos = obj.marker.getLatLng();
          isNearLiveBus = activeBuses.some(b => {
            const bLat = b.lat !== undefined ? b.lat : b.latitude;
            const bLon = b.lon !== undefined ? b.lon : b.longitude;
            if (bLat === undefined || bLon === undefined) return false;
            return this.calculateDistanceMeters(mPos.lat, mPos.lng, Number(bLat), Number(bLon)) < 800;
          });
        }

        // Invariant 3: If a live GPS bus is active on this direction and this was an estimated marker, purge it!
        const isDirectionCovered = Boolean(obj.busData?.isEstimated && obj.busData?.direction !== undefined && activeDirsWithLiveGps.has(String(obj.busData.direction)));

        // A ghost/theoretical marker is merged back into `activeBuses` at the
        // app layer (see applyFleetSnapshot), so it normally stays in
        // currentTripIds and never reaches here. It only falls through when the
        // REST timetable genuinely stops listing it, so it must NOT be purged
        // merely for being absent from an SSE frame (which is physical-only).
        // Give ghosts the same 90s hold buffer as every other marker: genuine
        // expiry is caught by `elapsedSec > 90`, and the live-recovery purges
        // (isVehHandledByActiveKey / isNearLiveBus / isDirectionCovered) still
        // fire immediately when a real bus takes over.
        if (elapsedSec > 90 || isVehHandledByActiveKey || isNearLiveBus || isDirectionCovered) {
          this.map.removeLayer(obj.marker);
          this.busMarkersMap.delete(tId);
        } else {
          // Transition marker visually to Estimated (Amber)
          if (obj.busData) obj.busData.isEstimated = true;
          const pinEl = obj.marker.getElement()?.querySelector('.live-bus-pin');
          if (pinEl) {
            pinEl.style.background = 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)';
          }
          const dotEl = obj.marker.getElement()?.querySelector('.bus-status-dot');
          if (dotEl) {
            dotEl.className = 'bus-status-dot estimated';
          }
        }
      }
    }

    const secondaryCoords = (this.secondaryRoutePolyline) ? this.secondaryRoutePolyline.getLatLngs().map(p => [p.lat, p.lng]) : null;

    (activeBuses || []).forEach(bus => {
      const bLat = bus.lat !== undefined ? bus.lat : bus.latitude;
      const bLon = bus.lon !== undefined ? bus.lon : bus.longitude;
      if (bLat === undefined || bLon === undefined || bLat === null || bLon === null) return;
      bus.lat = Number(bLat);
      bus.lon = Number(bLon);

      const isSelected = this.isBusSelected(bus, this.selectedVehicleId);
      let isSecDir = (String(bus.direction) === '1' || bus.direction === 1) && secondaryCoords && secondaryCoords.length > 1;
      
      // Proximity check fallback: If bus.direction is not explicit, determine closest polyline
      if (!isSecDir && secondaryCoords && secondaryCoords.length > 1 && this.activePolylineCoords && this.activePolylineCoords.length > 1) {
        if (bus.direction === undefined || bus.direction === null || bus.direction === '') {
          const snapPrimary = this.snapToPolyline(bus.lat, bus.lon, this.activePolylineCoords);
          const snapSecondary = this.snapToPolyline(bus.lat, bus.lon, secondaryCoords);
          if (snapSecondary.distanceMeters < snapPrimary.distanceMeters) {
            isSecDir = true;
          }
        }
      }

      const targetPolyline = isSecDir ? secondaryCoords : (this.activePolylineCoords || []);
      const busColor = isSecDir ? secondaryColor : lineColor;

      // 1. Street-Snapping: Snap raw GPS strictly to the target road polyline,
      // except a bus the server found off its route (bus.offRoute): it stays
      // where its GPS puts it, and its glide does not follow the route either.
      // A train (GTFS-RT) is drawn where its operator reported it, never
      // snapped: a line drawn from stations alone is only an approximation.
      const markerKey = this.busMarkerKey(bus);
      const followRoute = !bus.offRoute && bus.positionSource !== 'gtfsrt' && targetPolyline && targetPolyline.length > 1;
      let snapped = { lat: bus.lat, lon: bus.lon, bearing: bus.bearing || 0 };
      if (followRoute) {
        const prevSeg = this.busMarkersMap.get(markerKey)?._segIdx ?? -1;
        snapped = this.snapToPolyline(bus.lat, bus.lon, targetPolyline, prevSeg);
      }

      const isGhost = Boolean(bus.isGhostVehicle || (bus.vehicleId && String(bus.vehicleId).startsWith('EST_')) || bus.isTheoretical);
      const isEst = Boolean(bus.isEstimated);
      const reportedBearing = (bus.bearing !== undefined && bus.bearing !== null && Number.isFinite(Number(bus.bearing))) ? Number(bus.bearing) : null;
      const roadBearing = (snapped.bearing !== undefined && snapped.bearing !== null && Number.isFinite(Number(snapped.bearing))) ? Number(snapped.bearing) : null;
      const bearingAngle = Math.round(reportedBearing !== null ? reportedBearing : (roadBearing !== null ? roadBearing : 0));
      const popupCtx = {
        isGhost,
        isEst,
        isSecDir,
        busColor,
        snapped,
        bearingAngle,
        lineCode: this.currentLineId,
        showLineLink: false
      };

      const pinBaseColor = isGhost
        ? '#0f172a'
        : (isEst
            ? '#f59e0b'
            : (bus.isTerminalLayover
                ? '#1d4ed8'
                : (busColor || '#10b981')));
      const pinBg = isGhost
        ? 'rgba(15, 23, 42, 0.88)'
        : (isEst
            ? 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)'
            : (bus.isTerminalLayover 
                ? 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)'
                : (busColor || 'linear-gradient(135deg, #10b981 0%, #059669 100%)')));
      const pinInk = isGhost
        ? '#fbbf24'
        : (window.TransitUtils?.contrastInk ? window.TransitUtils.contrastInk(pinBaseColor) : '#ffffff');

      // Invariant: Enforce physical vehicle uniqueness across markers
      if (bus.vehicleId && !String(bus.vehicleId).startsWith('EST_')) {
        const vIdStr = String(bus.vehicleId).trim();
        for (const [existingKey, existingObj] of this.busMarkersMap.entries()) {
          if (existingKey !== markerKey && String(existingObj.busData?.vehicleId || '').trim() === vIdStr) {
            this.map.removeLayer(existingObj.marker);
            this.busMarkersMap.delete(existingKey);
            continue;
          }
          // Immediate ghost purge on live GPS recovery:
          // If this incoming bus has live GPS, immediately remove any ghost marker on the same direction
          // or within 1,200m to eliminate reconnection duplication!
          if (!bus.isEstimated && existingKey !== markerKey) {
            const exData = existingObj.busData;
            const isExGhost = Boolean(exData?.isGhostVehicle || String(exData?.vehicleId || '').startsWith('EST_'));
            if (isExGhost && (String(exData?.direction) === String(bus.direction) || this.calculateDistanceMeters(snapped.lat, snapped.lon, Number(exData?.lat || 0), Number(exData?.lon || 0)) < 1200)) {
              this.map.removeLayer(existingObj.marker);
              this.busMarkersMap.delete(existingKey);
            }
          }
        }
      }

      if (this.busMarkersMap.has(markerKey)) {
        const obj = this.busMarkersMap.get(markerKey);
        obj.busData = bus;
        obj.popupCtx = popupCtx;
        obj.targetLat = snapped.lat;
        obj.targetLon = snapped.lon;
        obj._segIdx = snapped.index ?? -1;
        obj.targetBearing = bearingAngle;
        obj.reportedBearing = reportedBearing;
        obj.targetPolyline = followRoute ? targetPolyline : null;
        obj.lastUpdated = now;
        if (obj.marker.isPopupOpen?.()) {
          obj.marker.setPopupContent(this.buildBusPopupHtml(bus, popupCtx));
        }

        if (bus.isTerminalLayover) {
          obj.marker.setLatLng([snapped.lat, snapped.lon]);
        }

        // Dynamically update pin background, selection state, and status dot
        // (uses cached DOM refs captured at marker creation; lazy re-query fallback)
        const el = obj.marker.getElement();
        if (el) {
          const wrapEl = obj.wrapEl || (obj.wrapEl = el.querySelector('.live-bus-marker-wrap'));
          if (wrapEl) {
            wrapEl.classList.toggle('selected', isSelected);
            wrapEl.classList.toggle('ghost-bus', isGhost);
            const ringEl = obj.ringEl || (obj.ringEl = el.querySelector('.bus-selection-ring'));
            if (ringEl) ringEl.style.display = isSelected ? 'block' : 'none';
          }
          const pinEl = obj.pinEl || (obj.pinEl = el.querySelector('.live-bus-pin'));
          if (pinEl) {
            pinEl.style.background = pinBg;
            pinEl.style.color = pinInk;
          }
          const dotEl = obj.dotEl || (obj.dotEl = el.querySelector('.bus-status-dot'));
          if (dotEl) {
            dotEl.className = `bus-status-dot ${isGhost ? 'ghost' : (isEst ? 'estimated' : 'live')}`;
          }
          const iconInner = obj.iconEl || (obj.iconEl = el.querySelector('.bus-icon-inner'));
          if (iconInner) {
            const vMode = bus.mode || (bus.positionSource === 'gtfsrt' ? 'rail' : (bus.positionSource === 'metro_predictions' ? 'metro' : 'bus'));
            const iconKey = isGhost ? 'ghost' : (bus.isTerminalLayover ? 'layover' : vMode);
            if (obj._lastIconKey !== iconKey) {
              obj._lastIconKey = iconKey;
              iconInner.innerHTML = isGhost ? '⚡' : (bus.isTerminalLayover ? '🅿️' : vehicleIconForMode(vMode));
            }
          }
          obj.marker.setZIndexOffset(isSelected ? 5000 : (isGhost ? 1500 : 2000));
        }
      } else {
        const isHeadingWest = bearingAngle > 180 && bearingAngle < 360;
        const busHtml = bus.isTerminalLayover ? `
          <div class="live-bus-marker-wrap ${isSelected ? 'selected' : ''} ${isGhost ? 'ghost-bus' : ''}">
            <div class="bus-selection-ring" style="${isSelected ? '' : 'display:none;'}"></div>
            <div class="live-bus-pin" style="background: ${isGhost ? 'rgba(15, 23, 42, 0.88)' : 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)'}; color: ${pinInk};">
              <span class="bus-icon-inner">${isGhost ? '⚡' : '🅿️'}</span>
              ${isGhost ? `<span class="bus-status-dot ghost"></span>` : ''}
            </div>
          </div>
        ` : `
          <div class="live-bus-marker-wrap ${isSelected ? 'selected' : ''} ${isGhost ? 'ghost-bus' : ''} ${(bus.positionSource === 'gtfsrt' || bus.positionSource === 'metro_predictions') ? 'is-train' : ''}">
            <div class="bus-selection-ring" style="${isSelected ? '' : 'display:none;'}"></div>
            <div class="bus-heading-cone" style="transform: rotate(${bearingAngle}deg);">
              <div class="bus-heading-arrow"></div>
            </div>
            <div class="live-bus-pin" style="background: ${pinBg}; color: ${pinInk};">
              <span class="bus-icon-inner" style="transform: scaleX(${isHeadingWest ? -1 : 1});">${isGhost ? '⚡' : vehicleIconForMode(bus.mode || (bus.positionSource === 'gtfsrt' ? 'rail' : (bus.positionSource === 'metro_predictions' ? 'metro' : 'bus')))}</span>
              <span class="bus-status-dot ${isGhost ? 'ghost' : (isEst ? 'estimated' : 'live')}"></span>
            </div>
          </div>
        `;

        const busIcon = L.divIcon({
          html: busHtml,
          className: 'c10-live-bus-icon',
          iconSize: [44, 44],
          iconAnchor: [22, 22]
        });

        const marker = L.marker([snapped.lat, snapped.lon], {
          icon: busIcon,
          zIndexOffset: isSelected ? 5000 : (isGhost ? 1500 : 2000)
        }).addTo(this.map);

        const busRoot = marker.getElement();
        const vModeInit = bus.mode || (bus.positionSource === 'gtfsrt' ? 'rail' : (bus.positionSource === 'metro_predictions' ? 'metro' : 'bus'));
        const entry = {
          marker,
          busData: bus,
          popupCtx,
          targetLat: snapped.lat,
          targetLon: snapped.lon,
          _segIdx: snapped.index ?? -1,
          targetBearing: bearingAngle,
          reportedBearing: reportedBearing,
          currentBearing: bearingAngle,
          isFacingWest: isHeadingWest,
          lastUpdated: now,
          targetPolyline: followRoute ? targetPolyline : null,
          _lastIconKey: isGhost ? 'ghost' : (bus.isTerminalLayover ? 'layover' : vModeInit),
          wrapEl: busRoot ? busRoot.querySelector('.live-bus-marker-wrap') : null,
          ringEl: busRoot ? busRoot.querySelector('.bus-selection-ring') : null,
          pinEl: busRoot ? busRoot.querySelector('.live-bus-pin') : null,
          dotEl: busRoot ? busRoot.querySelector('.bus-status-dot') : null,
          coneEl: busRoot ? busRoot.querySelector('.bus-heading-cone') : null,
          iconEl: busRoot ? busRoot.querySelector('.bus-icon-inner') : null
        };
        marker.bindPopup(() => this.buildBusPopupHtml(entry.busData, entry.popupCtx), {
          className: 'arribo-bus-popup',
          minWidth: 290,
          maxWidth: 350,
          maxHeight: 520,
          autoPan: true,
          autoPanPadding: [20, 20],
          closeButton: true
        });
        if (onBusClick) {
          marker.on('click', () => onBusClick(entry.busData));
        }
        this.busMarkersMap.set(markerKey, entry);
      }
    });
  }

  // Smooth continuous client-side gliding with dt-scaled LERP, local segment hint, and anti-flicker hysteresis
  stepBusAnimation(nowSec) {
    if (!this.busMarkersMap || this.busMarkersMap.size === 0) return;
    const ts = Number.isFinite(nowSec) ? nowSec : (performance.now() / 1000);
    const dt = this._lastAnimSec ? Math.min(0.06, Math.max(0.004, ts - this._lastAnimSec)) : 0.0167;
    this._lastAnimSec = ts;
    const posAlpha = 1 - Math.exp(-5.0 * dt);
    const rotAlpha = 1 - Math.exp(-7.5 * dt);

    for (const [, obj] of this.busMarkersMap.entries()) {
      const bus = obj.busData;
      if (!bus || !obj.marker) continue;

      const currentPos = obj.marker.getLatLng();
      if (!currentPos) continue;

      // 1. If parked in terminal layover, stay at terminal without per-frame DOM writes
      if (bus.isTerminalLayover) {
        if (Math.abs(currentPos.lat - bus.lat) > 0.000002 || Math.abs(currentPos.lng - bus.lon) > 0.000002) {
          obj.marker.setLatLng([bus.lat, bus.lon]);
        }
        continue;
      }

      const targetLat = obj.targetLat !== undefined ? obj.targetLat : bus.lat;
      const targetLon = obj.targetLon !== undefined ? obj.targetLon : bus.lon;
      const targetBearing = obj.targetBearing !== undefined ? obj.targetBearing : (bus.bearing || 0);

      // 2. Smooth dt-scaled exponential position LERP
      const dLat = targetLat - currentPos.lat;
      const dLon = targetLon - currentPos.lng;
      const distDeg = Math.sqrt(dLat * dLat + dLon * dLon);

      if (distDeg > 0.005) {
        obj.marker.setLatLng([targetLat, targetLon]);
      } else if (distDeg > 0.000002) {
        const smoothLat = currentPos.lat + dLat * posAlpha;
        const smoothLon = currentPos.lng + dLon * posAlpha;

        if (obj.targetPolyline && obj.targetPolyline.length > 2 && distDeg < 0.003) {
          const snappedStep = this.snapToPolyline(smoothLat, smoothLon, obj.targetPolyline, obj._segIdx ?? -1);
          if (snappedStep && snappedStep.distanceMeters < 40) {
            obj._segIdx = snappedStep.index;
            obj.marker.setLatLng([snappedStep.lat, snappedStep.lon]);
            if (obj.reportedBearing === null || obj.reportedBearing === undefined) {
              if (snappedStep.bearing !== undefined && Number.isFinite(snappedStep.bearing)) {
                obj.targetBearing = snappedStep.bearing;
              }
            }
          } else {
            obj.marker.setLatLng([smoothLat, smoothLon]);
          }
        } else {
          obj.marker.setLatLng([smoothLat, smoothLon]);
        }
      }

      // 3. Smooth shortest-angle rotation interpolation for DOM direction cone (skip Canvas circleMarkers)
      if (targetBearing !== null && typeof obj.marker.getElement === 'function') {
        let currentBearing = obj.currentBearing !== undefined ? obj.currentBearing : targetBearing;
        const delta = (targetBearing - currentBearing + 540) % 360 - 180;
        if (Math.abs(delta) >= 0.5 || obj._lastRenderedAngle === undefined) {
          currentBearing = (currentBearing + delta * rotAlpha + 360) % 360;
          obj.currentBearing = currentBearing;
          const roundedAngle = Math.round(currentBearing);
          const el = obj.marker.getElement();
          if (el) {
            if (roundedAngle !== obj._lastRenderedAngle) {
              obj._lastRenderedAngle = roundedAngle;
              const cone = obj.coneEl || (obj.coneEl = el.querySelector('.bus-heading-cone'));
              if (cone) {
                cone.style.transform = `rotate(${roundedAngle}deg)`;
              }
            }

            // Anti-flicker hysteresis for bus icon facing direction:
            // Switch to West when pointing West (200°-340°), East when pointing East (20°-160°);
            // preserve prior facing in north (340°-20°) and south (160°-200°) deadbands.
            if (currentBearing >= 200 && currentBearing <= 340) {
              obj.isFacingWest = true;
            } else if (currentBearing >= 20 && currentBearing <= 160) {
              obj.isFacingWest = false;
            }

            if (obj.isFacingWest !== obj._lastRenderedWest) {
              obj._lastRenderedWest = obj.isFacingWest;
              const icon = obj.iconEl || (obj.iconEl = el.querySelector('.bus-icon-inner'));
              if (icon) {
                icon.style.transform = `scaleX(${obj.isFacingWest ? -1 : 1})`;
              }
            }
          }
        }
      }
    }
  }

  renderVehicleTrail(trailPoints = [], color = '#00f2fe') {
    this.clearVehicleTrail();
    if (!this.map || !Array.isArray(trailPoints) || trailPoints.length < 2) return;

    // Filter valid coordinates
    const validPoints = trailPoints.filter(p => p && typeof p.lat === 'number' && typeof p.lon === 'number');
    if (validPoints.length < 2) return;

    // Segment points to avoid connecting round trips or teleport jumps
    const segments = [];
    let currentSegment = [[validPoints[0].lat, validPoints[0].lon]];

    for (let i = 1; i < validPoints.length; i++) {
      const prev = validPoints[i - 1];
      const curr = validPoints[i];

      // Approximate distance between consecutive sampled points (degrees)
      const dLat = curr.lat - prev.lat;
      const dLon = curr.lon - prev.lon;
      const distSq = dLat * dLat + dLon * dLon;

      // If jump is greater than ~2km (0.02 deg), start a new segment (new trip / turn-around)
      if (distSq > 0.0004) {
        if (currentSegment.length > 1) {
          segments.push(currentSegment);
        }
        currentSegment = [[curr.lat, curr.lon]];
      } else {
        currentSegment.push([curr.lat, curr.lon]);
      }
    }
    if (currentSegment.length > 1) {
      segments.push(currentSegment);
    }

    if (segments.length === 0) return;

    // Show only the most recent trip segment or all clean segments
    const latestSegment = segments[segments.length - 1];
    this.vehicleTrailPolyline = L.polyline(latestSegment, {
      color: color || '#38bdf8',
      weight: 4,
      opacity: 0.85,
      dashArray: '6, 6',
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(this.map);
  }

  clearVehicleTrail() {
    if (this.vehicleTrailPolyline && this.map) {
      this.map.removeLayer(this.vehicleTrailPolyline);
      this.vehicleTrailPolyline = null;
    }
  }

  focusTargetStop(lat, lon, stopId = null) {
    if (!this.map || !lat || !lon) return;
    this.map.flyTo([lat, lon], 16, { duration: 1.0 });
    this.invalidateSize();

    // After flight/scroll settles, highlight the target marker & open its tooltip
    setTimeout(() => {
      this.invalidateSize();
      if (this.stopMarkers && this.stopMarkers.length > 0) {
        const match = this.stopMarkers.find(m => {
          if (stopId && m._stopMeta?.id && String(m._stopMeta.id) === String(stopId)) return true;
          const ll = m.getLatLng();
          return Math.abs(ll.lat - lat) < 0.0006 && Math.abs(ll.lng - lon) < 0.0006;
        });
        if (match) {
          try { match.openTooltip(); } catch {}
          const dot = match._dotEl || (match.getElement() ? match.getElement().querySelector('.stop-marker-dot') : null);
          if (dot) {
            dot.style.transform = 'scale(2.2)';
            dot.style.boxShadow = '0 0 16px var(--c10-primary, #009485)';
            dot.style.transition = 'transform 0.4s ease, box-shadow 0.4s ease';
            setTimeout(() => {
              if (dot) {
                dot.style.transform = '';
                dot.style.boxShadow = '';
              }
            }, 3000);
          }
        }
      }
    }, 450);
  }



  invalidateSize(options = { pan: false, debounceMoveend: true }) {
    if (!this.map || !this.map._loaded) return;
    
    const container = this.map.getContainer ? this.map.getContainer() : document.getElementById(this.containerId);
    if (!container || !container.isConnected || container.offsetParent === null || container.clientWidth === 0 || container.clientHeight === 0) {
      return;
    }

    try {
      this.map.invalidateSize(options);
      if (this.renderer && typeof this.renderer._update === 'function') {
        this.renderer._update();
      }
      if (this.routePolyline && typeof this.routePolyline.redraw === 'function') {
        this.routePolyline.redraw();
      }
      if (this.secondaryRoutePolyline && typeof this.secondaryRoutePolyline.redraw === 'function') {
        this.secondaryRoutePolyline.redraw();
      }
      if (this.vehicleTrailPolyline && typeof this.vehicleTrailPolyline.redraw === 'function') {
        this.vehicleTrailPolyline.redraw();
      }
    } catch {
      // Benign layout timing exception during rapid container transitions
    }
  }
}

window.TransitMap = TransitMap;

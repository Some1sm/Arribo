// All-lines network map for the landing screen.
//
// Subclasses TransitMap so the network map is literally the same renderer as the
// single-line map: same tile layer, same theme handling, same resize observer,
// same road-snapping / subpath / glide maths, same bus-pin markup, same popup.
// Only the geometry model differs — TransitMap holds ONE route (a primary and a
// secondary polyline for its two directions), whereas this map holds EIGHT, and
// snaps each bus to its own line's polyline rather than to a single shared one.
//
// Nothing here re-implements drawing that map.js already owns.

/** Matches TransitMap.busMarkerKey's identity, scoped by line so two lines can
 *  never collide on one map. */
function networkBusMarkerKey(bus) {
  const id = String(bus.vehicleId || bus.tripId || '').trim();
  const line = String(bus.lineCode || bus.lineId || '').toUpperCase();
  return `${line}|${id}`;
}

class NetworkMap extends TransitMap {
  initMap() {
    if (typeof L === 'undefined') {
      console.warn('Leaflet not loaded yet.');
      return;
    }

    // Same options as TransitMap.initMap — preferCanvas is a hard invariant
    // (AGENTS.md: preserve the Leaflet canvas renderer).
    this.map = L.map(this.containerId, {
      zoomControl: true,
      scrollWheelZoom: true,
      preferCanvas: true,
      fadeAnimation: true,
      zoomAnimation: true
    }).setView([41.54, 2.44], 13);

    // Line geometry, stops and buses live in their own groups so a single line
    // can be re-rendered without touching the others.
    this.routeLayer = L.layerGroup().addTo(this.map);
    this.stopLayer = L.layerGroup().addTo(this.map);
    this.busLayer = L.layerGroup().addTo(this.map);

    this.lineGeometries = new Map();   // code -> { color, name, primary, secondary }
    this.lineCatalog = [];
    this.busesByLine = new Map();      // code -> Map(markerKey -> bus)
    // createDirectionalArrows() pushes into this; TransitMap only initialises it
    // inside renderStops(), which this map never calls.
    this.directionalArrowMarkers = [];
    this.hasFittedNetworkBounds = false;
    this.networkSeq = 0;

    this.updateTileLayer();
    this.setupResizeObserver();

    // NOTE: requestUserLocation() is deliberately NOT called. TransitMap calls
    // it in initMap and its hint badge uses the fixed DOM id
    // 'user-location-badge' (map.js), so a second instance would emit a
    // duplicate id and re-prompt for geolocation. The single-line map already
    // owns that affordance.

    this.map.on('popupopen', (e) => {
      const root = e.popup.getElement();
      if (!root) return;
      root.addEventListener('click', (ev) => {
        const shareBtn = ev.target.closest('[data-share-vehicle]');
        if (shareBtn && window.transitApp?.shareLiveBus) {
          window.transitApp.shareLiveBus(shareBtn.dataset.shareVehicle);
          return;
        }
        const lineBtn = ev.target.closest('[data-open-line]');
        if (lineBtn) {
          const code = String(lineBtn.dataset.openLine || '').trim();
          if (code && window.transitApp?.openLineFromNetwork) {
            window.transitApp.openLineFromNetwork(code);
          }
        }
      });
    });
  }

  // ---------------------------------------------------------------- catalog

  /**
   * Adopts the app's existing line catalog so colours come from /api/lines
   * (with the app's emergency defaults) instead of a second hardcoded palette
   * that could drift from the single-line map.
   */
  setLineCatalog(lines) {
    if (!Array.isArray(lines) || lines.length === 0) return;
    this.lineCatalog = lines.map(l => ({
      code: String(l.code || l.id || '').toUpperCase(),
      name: l.name || '',
      color: l.color || '#009485'
    })).filter(l => l.code);

    this.geometriesLoaded = false;
    this.renderLegend();
  }

  renderLegend() {
    const host = document.getElementById('network-map-legend');
    if (!host) return;
    host.textContent = '';
    for (const line of this.lineCatalog) {
      const pill = document.createElement('span');
      pill.className = 'network-map-legend-item';
      const dot = document.createElement('span');
      dot.className = 'network-map-legend-dot';
      dot.style.background = line.color;
      pill.appendChild(dot);
      pill.appendChild(document.createTextNode(line.code));
      host.appendChild(pill);
    }
  }

  // -------------------------------------------------------------- geometry

  /**
   * Stores one line's geometry and draws it. Idempotent: a second call for the
   * same line updates the stored coordinates (the bus markers re-snap against
   * them) but does not stack duplicate polylines or stop dots on the map.
   */
  loadLineGeometry(lineCode, payload) {
    if (!this.map || !payload) return;
    const code = String(lineCode).toUpperCase();
    const catalogEntry = this.lineCatalog.find(l => l.code === code);
    const color = payload.color || catalogEntry?.color || '#009485';
    const name = payload.name || catalogEntry?.name || '';

    const primary = normalizeCoords(payload.coords || payload.polyline);
    const secondary = normalizeCoords(payload.secondaryCoords || payload.secondaryPolyline);

    const alreadyDrawn = this.lineGeometries.has(code);
    this.lineGeometries.set(code, { color, name, primary, secondary });
    if (alreadyDrawn) return;

    this.drawLineGeometry(code, color, primary, secondary, payload.stops, payload.secondaryStops);
  }

  drawLineGeometry(code, color, primary, secondary, stops, secondaryStops) {
    // Arrows are far denser than a single route needs; 2 km keeps eight routes
    // legible instead of burying the map in arrow nodes.
    for (const coords of [primary, secondary]) {
      if (!coords || coords.length < 2) continue;
      this.directionalArrowMarkers.push(...this.createDirectionalArrows(coords, color, 2000));
    }

    // Same styling as TransitMap.renderStops: solid outbound leg, dashed
    // return leg. The return leg keeps the LINE's own colour here (not the
    // single-line map's #38bdf8 fallback) so one colour always means one line.
    if (primary && primary.length > 1) {
      L.polyline(primary, {
        color, weight: 4.5, opacity: 0.9, lineCap: 'round', lineJoin: 'round'
      }).addTo(this.routeLayer);
    }
    if (secondary && secondary.length > 1) {
      L.polyline(secondary, {
        color, weight: 4, opacity: 0.85, dashArray: '8, 8', lineCap: 'round', lineJoin: 'round'
      }).addTo(this.routeLayer);
    }

    // Stops as small dots in the line colour, snapped onto their own polyline.
    const addStops = (list, coords) => {
      if (!Array.isArray(list)) return;
      for (const stop of list) {
        const lat = Number(stop?.lat ?? stop?.latitude);
        const lon = Number(stop?.lon ?? stop?.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        let pos = [lat, lon];
        if (coords && coords.length > 1) {
          const snapped = snapStopToPolyline(lat, lon, coords, 120);
          if (snapped) pos = snapped;
        }
        L.circleMarker(pos, {
          radius: 3.5,
          color,
          weight: 1.5,
          opacity: 0.9,
          fillColor: color,
          fillOpacity: 0.55,
          interactive: false
        }).addTo(this.stopLayer);
      }
    };
    addStops(stops, primary);
    addStops(secondaryStops, secondary);
  }

  /**
   * Frames the whole network. Called once by the app after the first full load
   * of all eight lines — fitting while lines are still arriving would frame
   * whichever line happened to land first.
   */
  fitToNetwork() {
    if (!this.map) return;
    const bounds = this.routeLayer.getBounds();
    if (!bounds || !bounds.isValid()) return;
    this.hasFittedNetworkBounds = true;
    this.map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
  }

  // ----------------------------------------------------------------- buses

  /**
   * Replaces the buses for one line. `buses` is that line's `activeBuses` from
   * /api/line/L{n}?direction=both, which already includes timetable ghosts.
   */
  applyLineVehicles(lineCode, buses) {
    if (!this.map) return;
    const code = String(lineCode).toUpperCase();
    this.busesByLine.set(code, Array.isArray(buses) ? buses.slice() : []);
    this.redrawLineBuses(code);
  }

  /**
   * SSE top-up. The fleet stream is physical-only (flightRecorder never ingests
   * ghosts), so this merges fresh GPS/dead-reckoned positions over whatever the
   * last per-line REST refresh established, and never removes a ghost.
   */
  applyVehicleSnapshot(vehicles) {
    if (!this.map || !Array.isArray(vehicles) || vehicles.length === 0) return;
    const byLine = new Map();
    for (const v of vehicles) {
      const code = String(v?.lineCode || v?.lineId || '').toUpperCase();
      if (!code) continue;
      if (!byLine.has(code)) byLine.set(code, []);
      byLine.get(code).push(v);
    }
    for (const [code, list] of byLine.entries()) {
      const previous = this.busesByLine.get(code) || [];
      const incomingKeys = new Set(list.map(networkBusMarkerKey));
      // Carry over ghosts the physical-only stream cannot know about.
      const carriedGhosts = previous.filter(b => isGhostBus(b) && !incomingKeys.has(networkBusMarkerKey(b)));
      this.busesByLine.set(code, [...list, ...carriedGhosts]);
      this.redrawLineBuses(code);
    }
  }

  /** Rebuilds the marker set for a single line, leaving the other 7 untouched. */
  redrawLineBuses(code) {
    const geom = this.lineGeometries.get(code);
    if (!geom) return;
    const buses = this.busesByLine.get(code) || [];
    const now = Date.now();
    const liveKeys = new Set();

    for (const bus of buses) {
      const key = networkBusMarkerKey(bus);
      if (!key.endsWith('|') && key !== '|') liveKeys.add(key);

      const bLat = bus.lat !== undefined ? bus.lat : bus.latitude;
      const bLon = bus.lon !== undefined ? bus.lon : bus.longitude;
      if (bLat === undefined || bLon === undefined || bLat === null || bLon === null) continue;
      const lat = Number(bLat);
      const lon = Number(bLon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      // Each bus snaps to ITS OWN line's polyline — the whole reason this
      // cannot be TransitMap.updateBusMarkers.
      const isReturn = String(bus.direction) === '1' || bus.direction === 1;
      const targetPolyline = (isReturn && geom.secondary && geom.secondary.length > 1)
        ? geom.secondary
        : (geom.primary && geom.primary.length > 1 ? geom.primary : []);

      let snapped = { lat, lon, bearing: bus.bearing || 0 };
      if (targetPolyline.length > 1) {
        snapped = this.snapToPolyline(lat, lon, targetPolyline);
      }

      const isGhost = isGhostBus(bus);
      const isEst = Boolean(bus.isEstimated);
      const reportedBearing = (bus.bearing !== undefined && bus.bearing !== null && Number.isFinite(Number(bus.bearing)))
        ? Number(bus.bearing)
        : null;
      const roadBearing = (snapped.bearing !== undefined && snapped.bearing !== null && Number.isFinite(Number(snapped.bearing)))
        ? Number(snapped.bearing)
        : null;
      const bearingAngle = Math.round(reportedBearing !== null ? reportedBearing : (roadBearing !== null ? roadBearing : 0));
      const isHeadingWest = bearingAngle > 180 && bearingAngle < 360;

      const popupHtml = this.buildBusPopupHtml(bus, {
        isGhost,
        isEst,
        isSecDir: isReturn && geom.secondary && geom.secondary.length > 1,
        busColor: geom.color,
        snapped,
        bearingAngle,
        lineCode: code,
        showLineLink: true
      });

      const pinBg = isGhost
        ? 'rgba(15, 23, 42, 0.88)'
        : (isEst
            ? 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)'
            : (bus.isTerminalLayover
                ? 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)'
                : `linear-gradient(135deg, ${geom.color} 0%, ${shade(geom.color, -18)} 100%)`));

      const existing = this.busMarkersMap.get(key);
      if (existing) {
        existing.busData = bus;
        existing.targetLat = snapped.lat;
        existing.targetLon = snapped.lon;
        existing.targetBearing = bearingAngle;
        existing.reportedBearing = reportedBearing;
        existing.targetPolyline = targetPolyline;
        existing.lastUpdated = now;
        existing.marker.setPopupContent(popupHtml);
        if (bus.isTerminalLayover) {
          existing.marker.setLatLng([snapped.lat, snapped.lon]);
        }
        const el = existing.marker.getElement();
        if (el) {
          const wrapEl = existing.wrapEl || (existing.wrapEl = el.querySelector('.live-bus-marker-wrap'));
          if (wrapEl) wrapEl.classList.toggle('ghost-bus', isGhost);
          const pinEl = existing.pinEl || (existing.pinEl = el.querySelector('.live-bus-pin'));
          if (pinEl) pinEl.style.background = pinBg;
          const dotEl = existing.dotEl || (existing.dotEl = el.querySelector('.bus-status-dot'));
          if (dotEl) dotEl.className = `bus-status-dot ${isGhost ? 'ghost' : (isEst ? 'estimated' : 'live')}`;
        }
        continue;
      }

      // Identical markup to TransitMap.updateBusMarkers, so both maps share
      // every existing .live-bus-* CSS rule with no new styles.
      const busHtml = `
        <div class="live-bus-marker-wrap ${isGhost ? 'ghost-bus' : ''}">
          <div class="bus-selection-ring" style="display:none;"></div>
          <div class="bus-heading-cone" style="transform: rotate(${bearingAngle}deg);">
            <div class="bus-heading-arrow"></div>
          </div>
          <div class="live-bus-pin" style="background: ${pinBg};">
            <span class="bus-icon-inner" style="transform: scaleX(${isHeadingWest ? -1 : 1});">${isGhost ? '⚡' : CANONICAL_BUS_ICON_INNER_SVG}</span>
            <span class="bus-status-dot ${isGhost ? 'ghost' : (isEst ? 'estimated' : 'live')}"></span>
          </div>
        </div>
      `;

      const marker = L.marker([snapped.lat, snapped.lon], {
        icon: L.divIcon({
          html: busHtml,
          className: 'c10-live-bus-icon',
          iconSize: [44, 44],
          iconAnchor: [22, 22]
        }),
        zIndexOffset: isGhost ? 1500 : 2000
      }).addTo(this.busLayer);

      marker.bindPopup(popupHtml, {
        className: 'arribo-bus-popup',
        minWidth: 290,
        maxWidth: 350,
        maxHeight: 520,
        autoPan: true,
        autoPanPadding: [20, 20],
        closeButton: true
      });

      const busRoot = marker.getElement();
      this.busMarkersMap.set(key, {
        marker,
        busData: bus,
        targetLat: snapped.lat,
        targetLon: snapped.lon,
        targetBearing: bearingAngle,
        reportedBearing,
        currentBearing: bearingAngle,
        isFacingWest: isHeadingWest,
        lastUpdated: now,
        subpath: null,
        targetPolyline,
        wrapEl: busRoot ? busRoot.querySelector('.live-bus-marker-wrap') : null,
        ringEl: busRoot ? busRoot.querySelector('.bus-selection-ring') : null,
        pinEl: busRoot ? busRoot.querySelector('.live-bus-pin') : null,
        dotEl: busRoot ? busRoot.querySelector('.bus-status-dot') : null,
        coneEl: busRoot ? busRoot.querySelector('.bus-heading-cone') : null,
        iconEl: busRoot ? busRoot.querySelector('.bus-icon-inner') : null
      });
    }

    // Drop markers for buses this line no longer reports.
    for (const [key, obj] of Array.from(this.busMarkersMap.entries())) {
      if (String(key).split('|')[0] !== code) continue;
      if (liveKeys.has(key)) continue;
      if (now - (obj.lastUpdated || now) <= 90000) continue;   // same 90 s hold as the single-line map
      this.busLayer.removeLayer(obj.marker);
      this.busMarkersMap.delete(key);
    }
  }

  /** Live/estimated split across every line, for the header badge. */
  fleetCounts() {
    let live = 0;
    let estimated = 0;
    for (const buses of this.busesByLine.values()) {
      for (const b of buses) {
        if (isGhostBus(b) || b.isEstimated) estimated++;
        else live++;
      }
    }
    return { live, estimated, total: live + estimated };
  }

  destroy() {
    if (this.resizeObserver) {
      try { this.resizeObserver.disconnect(); } catch {}
      this.resizeObserver = null;
    }
    if (this.map) {
      try { this.map.remove(); } catch {}
      this.map = null;
    }
    this.busMarkersMap.clear();
    this.lineGeometries.clear();
    this.busesByLine.clear();
  }
}

// -------------------------------------------------------------- helpers

function isGhostBus(bus) {
  return Boolean(bus && (bus.isGhostVehicle || bus.isTheoretical ||
    (bus.vehicleId && String(bus.vehicleId).startsWith('EST_'))));
}

/** Coerces a route payload into [[lat, lon], ...], preserving zero coordinates. */
function normalizeCoords(coords) {
  if (!Array.isArray(coords)) return [];
  const out = [];
  for (const p of coords) {
    if (!p) continue;
    const lat = Number(Array.isArray(p) ? p[0] : p.lat);
    const lon = Number(Array.isArray(p) ? p[1] : p.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) out.push([lat, lon]);
  }
  return out;
}

/**
 * Darkens/lightens a #rrggbb colour so a bus pin can carry a two-stop gradient
 * in its line's own colour. Returns the input unchanged if it is not hex, so a
 * CSS variable or rgb() from the catalog can never produce a broken gradient.
 */
function shade(hex, percent) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return hex;
  const num = parseInt(m[1], 16);
  const clamp = (v) => Math.max(0, Math.min(255, v));
  const r = clamp(Math.round(((num >> 16) & 0xff) * (1 + percent / 100)));
  const g = clamp(Math.round(((num >> 8) & 0xff) * (1 + percent / 100)));
  const b = clamp(Math.round((num & 0xff) * (1 + percent / 100)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

if (typeof window !== 'undefined') {
  window.NetworkMap = NetworkMap;
}

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

/**
 * Canonical line key: always 'L<n>', from either shape.
 *
 * The two sources disagree. /api/line/L<n>?direction=both returns activeBuses
 * carrying only a bare `lineId` ("2") and no `lineCode`, while the fleet stream
 * returns `lineCode` ("L2"). Keying markers off the raw field therefore minted
 * TWO different keys for one physical bus — "2|2686" from REST and "L2|2686"
 * from SSE — which drew every bus twice, left the stale-marker purge comparing
 * a key prefix that never matched, and made the line filter hide every bus.
 * Normalising here is what makes both sources address the same marker.
 */
function canonicalLineCode(value) {
  const m = /^L?(\d+)$/i.exec(String(value ?? '').trim());
  return m ? `L${m[1]}` : '';
}

/** Matches TransitMap.busMarkerKey's identity, scoped by line so two lines can
 *  never collide on one map. */
function networkBusMarkerKey(bus) {
  const id = String(bus.vehicleId || bus.tripId || '').trim();
  return `${canonicalLineCode(bus.lineCode || bus.lineId)}|${id}`;
}

// Most lines the legend lists one by one; beyond, one entry per operator.
const NETWORK_LEGEND_MAX = 16;

/**
 * Whether a polyline's path crosses the bounds: its box first (cheap), then
 * each segment, so a line whose box covers the view but whose path does not
 * enter it is not counted. Segments are tested against the rectangle in plain
 * lat/lon, which is exact enough at map scale.
 */
function pathCrossesBounds(layer, bounds) {
  if (!layer || typeof layer.getBounds !== 'function' || typeof layer.getLatLngs !== 'function') return false;
  const box = layer.getBounds();
  if (!box.isValid() || !bounds.intersects(box)) return false;
  const s = bounds.getSouth(); const n = bounds.getNorth();
  const w = bounds.getWest(); const e = bounds.getEast();
  const inside = (p) => p.lat >= s && p.lat <= n && p.lng >= w && p.lng <= e;
  // Liang-Barsky clip of segment a-b against the rectangle.
  const crosses = (a, b) => {
    let t0 = 0; let t1 = 1;
    const dx = b.lng - a.lng; const dy = b.lat - a.lat;
    const edges = [[-dx, a.lng - w], [dx, e - a.lng], [-dy, a.lat - s], [dy, n - a.lat]];
    for (const [p, q] of edges) {
      if (p === 0) { if (q < 0) return false; continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
    return true;
  };
  const parts = layer.getLatLngs();
  const lists = parts.length && Array.isArray(parts[0]) ? parts : [parts];
  for (const pts of lists) {
    for (let i = 0; i < pts.length; i++) {
      if (inside(pts[i])) return true;
      if (i > 0 && crosses(pts[i - 1], pts[i])) return true;
    }
  }
  return false;
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
    }).setView(window.TransitUtils?.serviceArea?.()?.center || [41.54, 2.44], window.TransitUtils?.serviceArea?.()?.zoom || 13);

    // Line geometry, stops and buses live in their own groups so a single line
    // can be re-rendered without touching the others.
    //
    // routeLayer MUST be a featureGroup, not a layerGroup: fitToNetwork() calls
    // getBounds() on it, and L.LayerGroup has no getBounds() — only
    // L.FeatureGroup adds it. As a plain layerGroup, every fit threw a
    // TypeError, and because fitToNetwork() is the statement right before
    // updateNetworkMapBadge() in both app.js call sites, the throw silently ate
    // the badge write: the map filtered instantly while the count kept the
    // previous line until the next 30s REST sweep or 20s SSE frame.
    // Rodalies / FGC line paths (/api/network/rail-routes), added first so
    // Mataró's bus routes, stops and every vehicle draw on top of them.
    this.operatorNames = this.operatorNames || new Map();
    // Dedicated non-interactive Canvas for the ~780 static route polylines so
    // mouse moves never hit-test polylines and vehicle updates never redraw routes.
    this.routeCanvas = L.canvas({ padding: 0.5, tolerance: 0 });
    // Dedicated interactive Canvas for all regional/metropolitan buses, trains,
    // metro and trams (1,000+ pins rendered in ~1 ms/frame with zero DOM nodes).
    this.vehicleCanvas = createVehicleCanvas({ padding: 0.5, tolerance: 6 });
    // The legend lists the lines in view: redo it after every pan or zoom.
    this.map.on('moveend', () => this.renderLegend());
    this.railRouteLayer = L.featureGroup().addTo(this.map);
    this.railRoutes = [];              // [{ agencyId, code, mode, polyline, bounds }]
    this.allBusRoutesShown = false;    // when true, show all bus polylines even at zoom < 11
    this.routeLayer = L.featureGroup().addTo(this.map);
    this.stopLayer = L.layerGroup().addTo(this.map);
    this.busLayer = L.layerGroup().addTo(this.map);
    // Rodalies / FGC / TMB Metro / TRAM vehicles from /api/trains on vehicleCanvas.
    this.trainLayer = L.layerGroup().addTo(this.map);
    this.trainMarkers = new Map();     // train id -> { marker, data, op, lineRef, stale, pinBg }
    // Moventis / AMB / Sagalés / Generalitat buses from /api/moventis on vehicleCanvas.
    this.movLayer = L.layerGroup().addTo(this.map);
    this.movMarkers = new Map();       // bus id -> { marker, data, isLiveGps, pinBg }
    this.movFeed = null;
    this.trainColors = new Map();      // "<agencyId>:<line code>" -> line colour (from the catalog)
    this.trainLineRefs = new Map();    // "<agencyId>:<line code>" -> lineRef, for lines the line view can open
    this.trainFeed = null;             // last /api/trains body with enabled:true, else null
    this.trainsShown = true;

    this.lineGeometries = new Map();   // code -> { color, name, primary, secondary }
    // Per-line layer groups, so filtering one line out is a remove() on two
    // groups rather than a rebuild of the whole map.
    this.lineLayers = new Map();       // code -> { routes, stops, arrows }
    this.lineCatalog = [];
    this.busesByLine = new Map();      // code -> Map(markerKey -> bus)
    this.lineFilter = 'all';
    // createDirectionalArrows() pushes into this; TransitMap only initialises it
    // inside renderStops(), which this map never calls.
    this.directionalArrowMarkers = [];
    this.hasFittedNetworkBounds = false;
    this.networkSeq = 0;

    this.updateTileLayer();
    this.setupResizeObserver();

    // Bus markers are 44 px DOM icons; at the regional zoom the trains need
    // they piled up over Mataró. A zoom class on the container lets the CSS
    // shrink them when zoomed out and grow them back close in (no per-marker
    // work, no inline styles).
    const applyZoomClass = () => {
      const z = this.map.getZoom();
      const el = this.map.getContainer();
      el.classList.toggle('net-z-region', z <= 10);
      el.classList.toggle('net-z-far', z >= 11 && z <= 12);
      el.classList.toggle('net-z-mid', z === 13);
      const r = vehicleRadiusForZoom(z);
      if (r !== this._vehRadius) {
        this._vehRadius = r;
        for (const obj of this.trainMarkers.values()) obj.marker.setRadius(r);
        for (const obj of this.movMarkers.values()) obj.marker.setRadius(r);
        for (const obj of this.busMarkersMap.values()) obj.marker.setRadius(r);
      }
    };
    this.map.on('zoomend', () => {
      applyZoomClass();
      this.applyLineVisibility();
      this.renderRailRoutes();
    });
    this._routeMoveTimer = null;
    this.map.on('moveend', () => {
      if (this._routeMoveTimer) clearTimeout(this._routeMoveTimer);
      this._routeMoveTimer = setTimeout(() => {
        this._routeMoveTimer = null;
        this.renderRailRoutes();
      }, 120);
    });
    applyZoomClass();

    // NOTE: requestUserLocation() is deliberately NOT called. TransitMap calls
    // it in initMap and its hint badge uses the fixed DOM id
    // 'user-location-badge' (map.js), so a second instance would emit a
    // duplicate id and re-prompt for geolocation. The single-line map already
    // owns that affordance.

    this.map.on('popupopen', (e) => {
      const root = e.popup.getElement();
      if (!root || root._arriboPopupBound) return;
      root._arriboPopupBound = true;
      root.addEventListener('click', (ev) => {
        const shareBtn = ev.target.closest('[data-share-vehicle]');
        if (shareBtn && window.transitApp?.shareLiveBus) {
          window.transitApp.shareLiveBus(shareBtn.dataset.shareVehicle);
          return;
        }
        const railBtn = ev.target.closest('[data-open-rail-line]');
        if (railBtn && window.transitApp?.switchLine) {
          window.transitApp.switchLine(railBtn.dataset.openRailLine);
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
      code: canonicalLineCode(l.code || l.id) || String(l.code || l.id || '').toUpperCase(),
      name: l.name || '',
      color: l.color || '#009485'
    })).filter(l => l.code);

    this.geometriesLoaded = false;
    this.renderLegend();
  }

  // ---------------------------------------------------------------- trains

  /** Line colours for the trains, from the full catalog (trackable or not). */
  setTrainCatalog(lines) {
    this.trainColors.clear();
    this.trainLineRefs.clear();
    for (const l of Array.isArray(lines) ? lines : []) {
      if (l && l.agencyId && l.openable && l.lineRef) this.trainLineRefs.set(`${l.agencyId}:${l.code || l.id}`, l.lineRef);
      if (!l || !l.agencyId || typeof l.color !== 'string') continue;
      if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(l.color.trim())) continue;
      this.trainColors.set(`${l.agencyId}:${l.code || l.id}`, l.color.trim());
    }
    this.renderTrains();
  }

  /**
   * Draws the train lines' paths (/api/network/rail-routes "lines"), thin and
   * in each line's own colour, under everything else. They follow the
   * trains' visibility and the operator/line filter.
   */
  setRailRoutes(lines) {
    if (!this.map || !this.railRouteLayer) return;
    this.railRouteLayer.clearLayers();
    this.railRoutes = [];
    for (const l of Array.isArray(lines) ? lines : []) {
      const path = Array.isArray(l?.path) ? l.path.filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) : [];
      if (path.length < 2 || !l.agencyId || !l.code) continue;
      // Same fallback as the vehicle pin, so a colourless line matches its buses
      // and stands out from the basemap streets.
      const color = typeof l.color === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(l.color) ? l.color : '#007a5a';
      // A path joined from the stations (no shape in the timetable) is dashed.
      const polyline = L.polyline(path, {
        renderer: this.routeCanvas,
        color,
        weight: 2.5,
        opacity: 0.7,
        smoothFactor: 1.8,
        dashArray: l.fromStops ? '6 6' : null,
        interactive: false
      });
      const mode = typeof l.mode === 'string' && l.mode ? l.mode : (l.agencyId === 'renfe_rodalies' || l.agencyId === 'fgc' ? 'rail' : 'bus');
      this.railRoutes.push({ agencyId: l.agencyId, code: l.code, mode, polyline, bounds: polyline.getBounds() });
    }
    this.renderRailRoutes();
  }

  setAllBusRoutesShown(show) {
    this.allBusRoutesShown = Boolean(show);
    this.applyLineVisibility();
    this.renderRailRoutes();
  }

  /** Puts each non-Mataró line's path on the map when the filter allows it;
   *  the "Hide trains" toggle hides only rail lines (Rodalies/FGC), leaving
   *  Moventis, AMB, Sagalés, Girona, TMB and TRAM routes visible.
   *  When viewing the full Catalonia map without a specific operator/line filter,
   *  bus route polylines are zoom-gated (>= 11) and viewport-clipped so pan/zoom
   *  stays 60 fps while all live vehicle pins remain visible at every zoom,
   *  unless the user enables "Show bus routes" (`allBusRoutesShown`). */
  renderRailRoutes() {
    if (!this.railRouteLayer) return;
    // Paths are static: they show without a live train feed too.
    const filterOpen = this.railFilterOpen();
    const f = this.mapFilter || { kind: 'all' };
    const specificFilter = f.kind === 'op' || f.kind === 'rail';
    const showAllBus = specificFilter || this.allBusRoutesShown;
    const zoom = this.map ? this.map.getZoom() : 12;
    const viewBounds = this.map ? this.map.getBounds().pad(0.35) : null;
    for (const r of this.railRoutes || []) {
      const isTrain = r.mode === 'rail';
      const isBus = r.mode === 'bus';
      let want = filterOpen && (!isTrain || this.trainsShown) && this.isRailLineVisible(r.agencyId, r.code, r.mode);
      if (want && isBus && !showAllBus) {
        if (zoom < 11) {
          want = false;
        } else if (viewBounds && r.bounds && !viewBounds.intersects(r.bounds)) {
          want = false;
        }
      }
      const has = this.railRouteLayer.hasLayer(r.polyline);
      if (want && !has) this.railRouteLayer.addLayer(r.polyline);
      if (!want && has) this.railRouteLayer.removeLayer(r.polyline);
    }
    this.renderLegend();
  }

  /** Whether a train/metro/tram/bus line passes the map filter (all, mode, operator, or line). */
  isRailLineVisible(agencyId, code, mode = null) {
    const f = this.mapFilter || { kind: 'all' };
    if (f.kind === 'all') return true;
    if (f.kind === 'mode') return mode ? mode === f.mode : true;
    if (f.kind === 'op') return f.agencyId === agencyId;
    if (f.kind === 'rail') return f.agencyId === agencyId && f.code === code;
    return false; // a Mataró bus line is selected
  }

  /** Takes an /api/trains body; null (or enabled:false) clears the layer. */
  applyTrains(feed) {
    this.trainFeed = feed && feed.enabled && Array.isArray(feed.trains) ? feed : null;
    this.renderTrains();
  }

  setTrainsShown(shown) {
    this.trainsShown = Boolean(shown);
    this.renderTrains();
    this.renderRailRoutes();
  }

  /** Whether the filter lets any rail/metro/tram/catalog line through: everything, a mode, a train operator, or a train line. */
  railFilterOpen() {
    const f = this.mapFilter || { kind: 'all' };
    return f.kind === 'all' || f.kind === 'mode' || f.kind === 'rail' || (f.kind === 'op' && f.agencyId !== 'mataro');
  }

  /** Trains are drawn when shown and the filter is not on Mataró's buses alone. */
  trainsVisible() {
    return Boolean(this.trainFeed) && this.trainsShown && this.railFilterOpen();
  }

  renderTrains() {
    if (!this.map || !this.trainLayer) return;
    const trains = this.trainFeed ? this.trainFeed.trains.slice(0, MAX_TRAIN_MARKERS) : [];
    const css = getComputedStyle(document.documentElement);
    const token = (name) => css.getPropertyValue(name).trim();
    const neutral = token('--text-muted');
    const ring = token('--bg-surface');
    const liveDot = token('--accent-live');
    const estDot = token('--accent-warning');
    const radius = this._vehRadius || vehicleRadiusForZoom(this.map.getZoom());
    const operators = new Map((this.trainFeed?.operators || []).map(o => [o.id, o]));
    const seen = new Set();

    for (const t of trains) {
      const lat = Number(t?.lat ?? t?.latitude);
      const lon = Number(t?.lon ?? t?.longitude);
      if (t?.lat === null || t?.lon === null || !Number.isFinite(lat) || !Number.isFinite(lon) || !t.id) continue;
      // An operator or line filter keeps only its own trains (the rest are removed below).
      const tMode = t.mode || (t.agencyId === 'tmb' ? 'metro' : 'rail');
      if (!this.isRailLineVisible(t.agencyId, t.lineCode, tMode)) continue;
      seen.add(t.id);
      const lineColor = this.trainColors.get(`${t.agencyId}:${t.lineCode}`) || neutral;
      const stale = Boolean(t.stale);
      const pinBg = stale ? ring : lineColor;
      const pinInk = stale ? neutral : (window.TransitUtils?.contrastInk ? window.TransitUtils.contrastInk(lineColor) : ring);
      const dotColor = stale ? neutral : (t.isEstimated ? estDot : liveDot);
      const op = operators.get(t.agencyId);
      const lineRef = this.trainLineRefs.get(`${t.agencyId}:${t.lineCode}`);
      const existing = this.trainMarkers.get(t.id);
      if (existing) {
        existing.data = t;
        existing.op = op;
        existing.lineRef = lineRef;
        existing.marker.setLatLng([lat, lon]);
        if (existing.stale !== stale || existing.pinBg !== pinBg || existing.dotColor !== dotColor) {
          existing.marker.setStyle({
            color: stale ? neutral : ring,
            fillColor: pinBg,
            fillOpacity: stale ? 0.55 : 0.96,
            dashArray: stale ? '3 3' : null,
            _ink: pinInk,
            _dotColor: dotColor,
            _ringColor: ring,
            _stale: stale,
            _label: t.lineCode || ''
          });
          existing.stale = stale;
          existing.pinBg = pinBg;
          existing.dotColor = dotColor;
        }
        if (existing.marker.isPopupOpen()) {
          existing.marker.setPopupContent(buildTrainPopupHtml(t, op, lineRef));
        }
        continue;
      }
      const entry = { marker: null, data: t, op, lineRef, stale, pinBg, dotColor };
      const marker = L.circleMarker([lat, lon], {
        renderer: this.vehicleCanvas,
        radius,
        color: stale ? neutral : ring,
        weight: 2,
        opacity: 0.95,
        fillColor: pinBg,
        fillOpacity: stale ? 0.55 : 0.96,
        dashArray: stale ? '3 3' : null,
        _shape: 'rail',
        _ink: pinInk,
        _dotColor: dotColor,
        _ringColor: ring,
        _stale: stale,
        _label: t.lineCode || ''
      });
      marker.bindPopup(() => buildTrainPopupHtml(entry.data, entry.op, entry.lineRef), {
        className: 'arribo-bus-popup',
        minWidth: 290,
        maxWidth: 350,
        autoPan: true,
        autoPanPadding: [20, 20],
        closeButton: true
      });
      marker.addTo(this.trainLayer);
      entry.marker = marker;
      this.trainMarkers.set(t.id, entry);
    }
    for (const [id, obj] of Array.from(this.trainMarkers.entries())) {
      if (seen.has(id)) continue;
      this.trainLayer.removeLayer(obj.marker);
      this.trainMarkers.delete(id);
    }
    const onMap = this.map.hasLayer(this.trainLayer);
    if (this.trainsVisible() && !onMap) this.map.addLayer(this.trainLayer);
    if (!this.trainsVisible() && onMap) this.map.removeLayer(this.trainLayer);
  }

  /** Takes an /api/moventis body; null (or enabled:false) clears the layer. */
  applyMoventis(feed) {
    this.movFeed = feed && feed.enabled && Array.isArray(feed.vehicles) ? feed : null;
    this.renderMoventis();
  }

  /** Regional and metropolitan buses (Moventis, AMB, Sagalés, Generalitat) drawn
   *  on vehicleCanvas for smooth 60 FPS panning/zooming with lazy popups. */
  renderMoventis() {
    if (!this.map || !this.movLayer) return;
    const buses = this.movFeed ? this.movFeed.vehicles.slice(0, MAX_MOV_MARKERS) : [];
    const css = getComputedStyle(document.documentElement);
    const token = (name) => css.getPropertyValue(name).trim();
    const neutral = token('--text-muted');
    const ring = token('--bg-surface');
    const liveDot = token('--accent-live');
    const estDot = token('--accent-warning');
    const radius = this._vehRadius || vehicleRadiusForZoom(this.map.getZoom());
    const hex = v => (typeof v === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? v : null);
    const seen = new Set();
    for (const b of buses) {
      const lat = Number(b?.lat);
      const lon = Number(b?.lon);
      if (!b || !b.id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (!this.isRailLineVisible(b.agencyId, b.lineCode, b.mode || 'bus')) continue;
      seen.add(b.id);
      const isLiveGps = Boolean(b.isRealTime && !b.isEstimated);
      const pinBg = hex(b.color) || neutral;
      const pinInk = window.TransitUtils?.contrastInk ? window.TransitUtils.contrastInk(pinBg) : ring;
      const dotColor = isLiveGps ? liveDot : estDot;
      const existing = this.movMarkers.get(b.id);
      if (existing) {
        existing.data = b;
        existing.marker.setLatLng([lat, lon]);
        if (existing.isLiveGps !== isLiveGps || existing.pinBg !== pinBg) {
          existing.marker.setStyle({
            fillColor: pinBg,
            _ink: pinInk,
            _dotColor: dotColor,
            _ringColor: ring,
            _label: b.lineCode || ''
          });
          existing.isLiveGps = isLiveGps;
          existing.pinBg = pinBg;
        }
        if (existing.marker.isPopupOpen()) {
          existing.marker.setPopupContent(buildMoventisPopupHtml(b, this.movFeed));
        }
        continue;
      }
      const entry = { marker: null, data: b, isLiveGps, pinBg };
      const marker = L.circleMarker([lat, lon], {
        renderer: this.vehicleCanvas,
        radius,
        color: ring,
        weight: 2,
        opacity: 0.95,
        fillColor: pinBg,
        fillOpacity: 0.96,
        _shape: 'bus',
        _ink: pinInk,
        _dotColor: dotColor,
        _ringColor: ring,
        _label: b.lineCode || ''
      });
      marker.bindPopup(() => buildMoventisPopupHtml(entry.data, this.movFeed), {
        className: 'arribo-bus-popup',
        minWidth: 290,
        maxWidth: 350,
        autoPan: true,
        autoPanPadding: [20, 20],
        closeButton: true
      });
      marker.addTo(this.movLayer);
      entry.marker = marker;
      this.movMarkers.set(b.id, entry);
    }
    for (const [id, obj] of Array.from(this.movMarkers.entries())) {
      if (seen.has(id)) continue;
      this.movLayer.removeLayer(obj.marker);
      this.movMarkers.delete(id);
    }
  }

  /** Trains drawn now: total and how many have a position older than the live window. */
  trainCounts() {
    if (!this.trainsVisible()) return { total: 0, stale: 0, available: Boolean(this.trainFeed) };
    let stale = 0;
    let total = 0;
    for (const t of this.trainFeed.trains.slice(0, MAX_TRAIN_MARKERS)) {
      const tMode = t?.mode || (t?.agencyId === 'tmb' ? 'metro' : 'rail');
      if (!t || !t.id || !Number.isFinite(Number(t.lat)) || !this.isRailLineVisible(t.agencyId, t.lineCode, tMode)) continue;
      total++;
      if (t.stale) stale++;
    }
    // inView: the feed was cut to the map's area (?bbox=), so these are the trains in view.
    return { total, stale, available: true, inView: Array.isArray(this.trainFeed?.bbox) };
  }

  /**
   * The legend lists what the map shows: the lines drawn inside the visible
   * area (Mataró's and every other operator's paths), redone after each pan
   * or zoom. Up to NETWORK_LEGEND_MAX lines are listed one by one; past that
   * (zoomed out over Catalonia) one entry per operator with its line count.
   * Hidden when no line is in view. Batched to one run per frame.
   */
  renderLegend() {
    if (this._legendFrame) return;
    const run = () => { this._legendFrame = 0; this.renderLegendNow(); };
    if (typeof requestAnimationFrame === 'function') this._legendFrame = requestAnimationFrame(run);
    else run();
  }

  renderLegendNow() {
    const host = document.getElementById('network-map-legend');
    if (!host) return;
    const view = this.map && typeof this.map.getBounds === 'function' ? this.map.getBounds() : null;
    // A line is in view when its path crosses the visible area, not merely
    // its bounding box (a long line's box covers views it never enters).
    const inView = (layer) => !view || pathCrossesBounds(layer, view);
    const entries = []; // { group, code, color }
    const seen = new Set();
    const push = (group, code, color) => {
      const key = `${group}:${code}`;
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({ group, code, color });
    };
    for (const line of this.lineCatalog) {
      const layers = this.lineLayers.get(line.code);
      if (!layers || !this.isLineVisible(line.code) || !this.routeLayer?.hasLayer(layers.routes)) continue;
      let shown = false;
      layers.routes.eachLayer((pl) => { if (!shown && inView(pl)) shown = true; });
      if (shown) push('mataro', line.code, line.color);
    }
    const zoom = this.map && typeof this.map.getZoom === 'function' ? this.map.getZoom() : 12;
    for (const r of this.railRoutes || []) {
      if (!this.railRouteLayer?.hasLayer(r.polyline)) continue;
      if (view) {
        if (r.bounds && r.bounds.isValid() && !view.intersects(r.bounds)) continue;
        // Exact segment clipping only when zoomed in and still listing individual lines;
        // once past NETWORK_LEGEND_MAX we group by operator, so bbox intersection is instant.
        if (zoom >= 12 && entries.length <= NETWORK_LEGEND_MAX && !pathCrossesBounds(r.polyline, view)) continue;
      }
      push(r.agencyId, r.code, r.polyline.options.color);
    }
    host.textContent = '';
    host.hidden = entries.length === 0;
    const add = (color, text) => {
      const pill = document.createElement('span');
      pill.className = 'network-map-legend-item';
      const dot = document.createElement('span');
      dot.className = 'network-map-legend-dot';
      dot.style.background = color;
      pill.appendChild(dot);
      pill.appendChild(document.createTextNode(text));
      host.appendChild(pill);
    };
    if (entries.length <= NETWORK_LEGEND_MAX) {
      for (const e of entries) add(e.color, e.code);
      return;
    }
    const groups = new Map(); // operator -> { color, n }, in first-seen order
    for (const e of entries) {
      const g = groups.get(e.group) || { color: e.color, n: 0 };
      g.n++;
      groups.set(e.group, g);
    }
    for (const [id, g] of groups) add(g.color, `${this.operatorNames.get(id) || id} · ${g.n}`);
  }

  /** Operator id -> short name, for the legend's per-operator entries. */
  setOperatorNames(ops) {
    this.operatorNames = new Map();
    for (const o of Array.isArray(ops) ? ops : []) {
      if (o && o.id) this.operatorNames.set(String(o.id), o.shortName || o.name || String(o.id));
    }
    this.renderLegend();
  }

  // -------------------------------------------------------------- geometry

  /**
   * Stores one line's geometry and draws it. Idempotent: a second call for the
   * same line updates the stored coordinates (the bus markers re-snap against
   * them) but does not stack duplicate polylines or stop dots on the map.
   */
  loadLineGeometry(lineCode, payload) {
    if (!this.map || !payload) return;
    const code = canonicalLineCode(lineCode);
    if (!code) return;
    const catalogEntry = this.lineCatalog.find(l => l.code === code);
    const color = payload.color || catalogEntry?.color || '#009485';
    const name = payload.name || catalogEntry?.name || '';

    const primary = normalizeCoords(payload.coords || payload.polyline);
    const secondary = normalizeCoords(payload.secondaryCoords || payload.secondaryPolyline);

    const alreadyDrawn = this.lineGeometries.has(code);
    this.lineGeometries.set(code, { color, name, primary, secondary });
    if (alreadyDrawn) return;

    this.drawLineGeometry(code, color, primary, secondary, payload.stops, payload.secondaryStops);
    // A line can finish loading after the visitor has already filtered down to
    // another one; it must not reappear just because its data arrived late.
    this.applyLineVisibility();
  }

  drawLineGeometry(code, color, primary, secondary, stops, secondaryStops) {
    // Each line owns its own pair of groups so the filter can drop a whole
    // line without touching the other seven.
    //
    // `routes` is a featureGroup so routeLayer.getBounds() can recurse into it:
    // FeatureGroup unions each child's getBounds(), and a child that is only a
    // LayerGroup has no getBounds at all, so the outer group would silently
    // report empty bounds and the map would never frame the network.
    const routes = L.featureGroup().addTo(this.routeLayer);
    const stopsGroup = L.layerGroup();
    const arrows = [];

    // Unified styling matching every other Catalonia bus & rail line on the
    // homepage network map (thin routeCanvas polylines; no oversized stop dots
    // or arrow clutter on the overview map).
    if (primary && primary.length > 1) {
      L.polyline(primary, {
        renderer: this.routeCanvas,
        color,
        weight: 2.5,
        opacity: 0.7,
        smoothFactor: 1.8,
        interactive: false
      }).addTo(routes);
    }
    if (secondary && secondary.length > 1) {
      L.polyline(secondary, {
        renderer: this.routeCanvas,
        color,
        weight: 2.2,
        opacity: 0.55,
        dashArray: '6 6',
        smoothFactor: 1.8,
        interactive: false
      }).addTo(routes);
    }

    this.lineLayers.set(code, { routes, stops: stopsGroup, arrows });
    this.applyLineVisibility();
    this.renderLegend();
  }

  // ----------------------------------------------------------------- filter

  /**
   * Filters the map to a single line. `filter` is the landing filter-tab value:
   * 'all' or a bare line number ('1'…'8'); a full code ('L3') also works.
   * The map is never torn down — buses, geometry and popup state all survive,
   * so switching back is instant and no refetch is needed.
   */
  setLineFilter(filter) {
    const raw = String(filter ?? 'all').trim();
    // "all"; a transport mode ("mode:rail", "mode:metro", "mode:tram", "mode:bus");
    // an operator ("op:mataro", "op:fgc"); a rail/catalog line by its
    // lineRef ("renfe_rodalies:R1"); or a Mataró line id ("3", "L3").
    let f = { kind: 'all' };
    if (raw.startsWith('mode:') && raw.length > 5) {
      f = { kind: 'mode', mode: raw.slice(5) };
    } else if (raw.startsWith('op:') && raw.length > 3) {
      f = { kind: 'op', agencyId: raw.slice(3) };
    } else if (window.TransitUtils?.isRailLineId?.(raw)) {
      const i = raw.indexOf(':');
      f = { kind: 'rail', agencyId: raw.slice(0, i), code: raw.slice(i + 1) };
    } else if (raw && raw !== 'all') {
      f = { kind: 'bus', code: canonicalLineCode(raw) || raw.toUpperCase() };
    }
    this.mapFilter = f;
    // lineFilter keeps its meaning for the bus code paths: one Mataró line
    // code, or 'all' when no single bus line is picked.
    this.lineFilter = f.kind === 'bus' ? f.code : 'all';
    this.applyLineVisibility();
    this.renderLegend();
    this.renderTrains();
    this.renderMoventis();
    this.renderRailRoutes();
  }

  /** Whether a Mataró bus line passes the map filter. */
  isLineVisible(code) {
    const f = this.mapFilter || { kind: 'all' };
    if (f.kind === 'all') return true;
    if (f.kind === 'mode') return f.mode === 'bus';
    if (f.kind === 'op') return f.agencyId === 'mataro';
    if (f.kind === 'bus') return canonicalLineCode(code) === f.code;
    return false; // a train line is selected
  }

  /** Shows or hides every layer and bus marker that the filter excludes. */
  applyLineVisibility() {
    if (!this.map) return;
    const f = this.mapFilter || { kind: 'all' };
    const specificFilter = f.kind === 'op' || f.kind === 'bus' || this.allBusRoutesShown;
    const zoom = this.map.getZoom();

    for (const [code, layers] of this.lineLayers.entries()) {
      const visible = this.isLineVisible(code) && (specificFilter || zoom >= 11);
      if (visible) {
        this.routeLayer.addLayer(layers.routes);
      } else {
        this.routeLayer.removeLayer(layers.routes);
      }
    }

    // Bus markers are added/removed individually: they already live in one
    // shared group, and a bus that is filtered out must not stay clickable.
    for (const [key, obj] of this.busMarkersMap.entries()) {
      const code = String(key).split('|')[0];
      const visible = this.isLineVisible(code);
      const attached = this.busLayer.hasLayer(obj.marker);
      if (visible && !attached) this.busLayer.addLayer(obj.marker);
      else if (!visible && attached) this.busLayer.removeLayer(obj.marker);
    }
  }

  /**
   * Frames whatever is currently visible. Called once by the app after the first
   * full load of all eight lines — fitting while lines are still arriving would
   * frame whichever line happened to land first. routeLayer only reports the
   * bounds of groups still attached to it, so a filtered map frames the lines
   * actually on screen.
   */
  fitToNetwork() {
    if (!this.map) return;
    // Framing the network is cosmetic. If the layer cannot report bounds, skip
    // the re-frame instead of throwing: callers do real work immediately after
    // this call (updating the fleet badge), and a cosmetic failure must not
    // abort it.
    // The visible bus routes and the visible train paths together, so a
    // train operator or line filter frames its own track.
    let bounds = null;
    for (const layer of [this.routeLayer, this.railRouteLayer]) {
      if (typeof layer?.getBounds !== 'function') continue;
      const b = layer.getBounds();
      if (!b || !b.isValid()) continue;
      bounds = bounds ? bounds.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast());
    }
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
    const code = canonicalLineCode(lineCode);
    if (!code) return;
    this.busesByLine.set(code, Array.isArray(buses) ? buses.slice() : []);
    this.redrawLineBuses(code);
  }

  /**
   * SSE top-up. The fleet stream is physical-only, so it can describe neither
   * timetable ghosts nor dead-reckoned buses. Treating it as a REPLACEMENT
   * wiped every estimated bus seconds after the per-line REST refresh delivered
   * it, so amber pins flickered and vanished. Merge instead: incoming vehicles
   * win on identity, and anything the stream cannot represent is carried over
   * until the next REST refresh supersedes it.
   */
  applyVehicleSnapshot(vehicles) {
    if (!this.map || !Array.isArray(vehicles) || vehicles.length === 0) return;
    const byLine = new Map();
    for (const v of vehicles) {
      const code = canonicalLineCode(v?.lineCode || v?.lineId);
      if (!code) continue;
      if (!byLine.has(code)) byLine.set(code, []);
      byLine.get(code).push(v);
    }
    for (const [code, list] of byLine.entries()) {
      // A special service (Bus Focs on Les Santes nights...) is in no line
      // catalog and has no drawn route: give it a bare geometry entry so its
      // buses are drawn where their GPS puts them.
      if (!this.lineGeometries.has(code) && list.some(v => v && v.isSpecialService)) {
        this.lineGeometries.set(code, { color: SPECIAL_SERVICE_COLOR, name: '', primary: [], secondary: [] });
      }
      const previous = this.busesByLine.get(code) || [];
      const incomingKeys = new Set(list.map(networkBusMarkerKey));
      const carried = previous.filter(b =>
        isStreamBlindBus(b) &&
        !incomingKeys.has(networkBusMarkerKey(b)) &&
        isCarriedEntryValid(b));
      this.busesByLine.set(code, [...list, ...carried]);
      this.redrawLineBuses(code);
    }
  }

  /** Rebuilds the Canvas marker set for a single Mataró line, matching the
   *  unified vehicleCanvas pin style used by every other operator on the map. */
  redrawLineBuses(code) {
    const geom = this.lineGeometries.get(code);
    if (!geom) return;
    const buses = this.busesByLine.get(code) || [];
    const now = Date.now();
    const liveKeys = new Set();
    const css = getComputedStyle(document.documentElement);
    const token = (name) => css.getPropertyValue(name).trim();
    const ring = token('--bg-surface');
    const liveDot = token('--accent-live');
    const estDot = token('--accent-warning');
    const neutral = token('--text-muted');
    const radius = this._vehRadius || vehicleRadiusForZoom(this.map.getZoom());

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

      // A bus the server found off its route stays where its GPS puts it.
      const followRoute = !bus.offRoute && targetPolyline.length > 1;
      let snapped = { lat, lon, bearing: bus.bearing || 0 };
      if (followRoute) {
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

      const pinBg = isGhost ? ring : (geom.color || neutral);
      const pinInk = isGhost
        ? estDot
        : (window.TransitUtils?.contrastInk ? window.TransitUtils.contrastInk(pinBg) : ring);
      const dotColor = (isGhost || isEst) ? estDot : liveDot;
      const popupOpts = {
        isGhost,
        isEst,
        isSecDir: isReturn && geom.secondary && geom.secondary.length > 1,
        busColor: geom.color,
        snapped,
        bearingAngle,
        lineCode: code,
        showLineLink: !bus.isSpecialService
      };

      const existing = this.busMarkersMap.get(key);
      if (existing) {
        existing.busData = bus;
        existing.popupOpts = popupOpts;
        existing.targetLat = snapped.lat;
        existing.targetLon = snapped.lon;
        existing.targetBearing = bearingAngle;
        existing.reportedBearing = reportedBearing;
        existing.targetPolyline = followRoute ? targetPolyline : null;
        existing.lastUpdated = now;
        if (bus.isTerminalLayover) {
          existing.marker.setLatLng([snapped.lat, snapped.lon]);
        }
        if (existing.isGhost !== isGhost || existing.isEst !== isEst || existing.pinBg !== pinBg) {
          existing.marker.setStyle({
            color: isGhost ? estDot : ring,
            fillColor: pinBg,
            fillOpacity: isGhost ? 0.85 : 0.96,
            dashArray: isGhost ? '3 3' : null,
            _ink: pinInk,
            _dotColor: dotColor,
            _ringColor: ring,
            _stale: isGhost,
            _label: code
          });
          existing.isGhost = isGhost;
          existing.isEst = isEst;
          existing.pinBg = pinBg;
        }
        if (existing.marker.isPopupOpen()) {
          existing.marker.setPopupContent(this.buildBusPopupHtml(bus, popupOpts));
        }
        continue;
      }

      const entry = {
        marker: null,
        busData: bus,
        popupOpts,
        isGhost,
        isEst,
        pinBg,
        targetLat: snapped.lat,
        targetLon: snapped.lon,
        targetBearing: bearingAngle,
        reportedBearing,
        currentBearing: bearingAngle,
        isFacingWest: isHeadingWest,
        lastUpdated: now,
        subpath: null,
        targetPolyline: followRoute ? targetPolyline : null,
        wrapEl: null,
        ringEl: null,
        pinEl: null,
        dotEl: null,
        coneEl: null,
        iconEl: null
      };

      const marker = L.circleMarker([snapped.lat, snapped.lon], {
        renderer: this.vehicleCanvas,
        radius,
        color: isGhost ? estDot : ring,
        weight: 2,
        opacity: 0.95,
        fillColor: pinBg,
        fillOpacity: isGhost ? 0.85 : 0.96,
        dashArray: isGhost ? '3 3' : null,
        _shape: 'bus',
        _ink: pinInk,
        _dotColor: dotColor,
        _ringColor: ring,
        _stale: isGhost,
        _label: code
      });
      // A filtered-out line keeps its buses in busMarkersMap — they are still
      // animating and must be there when the filter comes back — but they are
      // not attached to the map, so they are neither visible nor clickable.
      if (this.isLineVisible(code)) marker.addTo(this.busLayer);

      marker.bindPopup(() => this.buildBusPopupHtml(entry.busData, entry.popupOpts), {
        className: 'arribo-bus-popup',
        minWidth: 290,
        maxWidth: 350,
        maxHeight: 520,
        autoPan: true,
        autoPanPadding: [20, 20],
        closeButton: true
      });

      entry.marker = marker;
      this.busMarkersMap.set(key, entry);
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

  /**
   * Live/estimated split for the header badge. Counts only the lines currently
   * on screen, so the badge never claims buses the visitor cannot see. This is
   * a visibility count, not a clamp: the totals still come from the real fleet.
   */
  fleetCounts() {
    let live = 0;
    let estimated = 0;
    for (const [code, buses] of this.busesByLine.entries()) {
      if (!this.isLineVisible(code)) continue;
      for (const b of buses) {
        if (isGhostBus(b) || b.isEstimated) estimated++;
        else live++;
      }
    }
    for (const obj of this.movMarkers.values()) {
      if (obj.isLiveGps) live++;
      else estimated++;
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
    this.trainMarkers.clear();
    this.movMarkers.clear();
    this.lineGeometries.clear();
    this.lineLayers.clear();
    this.busesByLine.clear();
  }
}

// -------------------------------------------------------------- helpers

/** Bound on train markers, far above the ~350 trains/metro/trams feeds report. */
const MAX_TRAIN_MARKERS = 1500;
/** Bound on Canvas regional/metropolitan bus markers (Canvas draws 2,000 in ~2 ms). */
const MAX_MOV_MARKERS = 2000;

function vehicleRadiusForZoom(z) {
  if (z <= 10) return 5;
  if (z <= 12) return 6.5;
  if (z === 13) return 9;
  return 11;
}

/**
 * Custom Leaflet Canvas renderer for network-map vehicle pins: draws circular
 * bus pins and rounded-square rail/metro/tram pins with crisp rings, status
 * dots (z >= 11), and centred line codes (z >= 13) in a single Canvas pass.
 */
function createVehicleCanvas(options) {
  const VehicleCanvas = L.Canvas.extend({
    _updateCircle(layer) {
      if (!this._drawing || layer._empty()) return;
      const p = layer._point;
      const ctx = this._ctx;
      const r = Math.max(Math.round(layer._radius), 1);
      const opts = layer.options;
      ctx.save();
      ctx.beginPath();
      if (opts._shape === 'rail' && r >= 5) {
        const s = r * 1.9;
        const x = p.x - s / 2;
        const y = p.y - s / 2;
        const cr = Math.max(2, Math.round(r * 0.45));
        ctx.moveTo(x + cr, y);
        ctx.arcTo(x + s, y, x + s, y + s, cr);
        ctx.arcTo(x + s, y + s, x, y + s, cr);
        ctx.arcTo(x, y + s, x, y, cr);
        ctx.arcTo(x, y, x + s, y, cr);
        ctx.closePath();
      } else {
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2, false);
      }
      if (opts.fill) {
        ctx.globalAlpha = opts.fillOpacity;
        ctx.fillStyle = opts.fillColor || opts.color;
        ctx.fill();
      }
      if (opts.stroke && opts.weight !== 0) {
        if (ctx.setLineDash && opts.dashArray) {
          ctx.setLineDash(Array.isArray(opts.dashArray) ? opts.dashArray : String(opts.dashArray).split(/\s+|,/).map(Number));
        }
        ctx.globalAlpha = opts.opacity;
        ctx.lineWidth = opts.weight;
        ctx.strokeStyle = opts.color;
        ctx.stroke();
        if (ctx.setLineDash && opts.dashArray) ctx.setLineDash([]);
      }
      // Line code inside the pin when zoomed in enough to read cleanly.
      if (r >= 9 && opts._label) {
        const txt = String(opts._label).slice(0, 4);
        ctx.globalAlpha = 1;
        ctx.fillStyle = opts._ink || opts.color;
        ctx.font = `700 ${txt.length >= 4 ? 7 : 8.5}px system-ui, -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(txt, p.x, p.y + 0.5);
      }
      // Status indicator dot at bottom-right rim (live GPS vs estimated vs stale).
      if (r >= 6 && opts._dotColor) {
        const dr = r >= 9 ? 3.2 : 2.3;
        const dx = p.x + r * 0.68;
        const dy = p.y + r * 0.68;
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(dx, dy, dr, 0, Math.PI * 2, false);
        ctx.fillStyle = opts._dotColor;
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = opts._ringColor || opts.color;
        ctx.stroke();
      }
      ctx.restore();
    }
  });
  return new VehicleCanvas(options);
}

function netT(key, vars, fallback) {
  return window.ArriboI18n ? window.ArriboI18n.t(key, vars) : fallback;
}

function formatAge(sec) {
  if (!Number.isFinite(sec)) return null;
  if (sec < 60) {
    const n = Math.round(sec);
    return netT('trainPopup.ageSec', { n }, `fa ${n} s`);
  }
  if (sec < 3600) {
    const n = Math.round(sec / 60);
    return netT('trainPopup.ageMin', { n }, `fa ${n} min`);
  }
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return netT('trainPopup.ageHourMin', { h, m }, `fa ${h} h ${m} min`);
}

/**
 * Popup for one train. Every statement is about what the operator's feed
 * reported: how old the position is, the delay and where it comes from, or
 * that there is none. StatusChip and LineBadge from the design system; the
 * badge's colour comes from the catalog through data-line.
 */
function buildTrainPopupHtml(t, op, lineRef) {
  // Same card as the bus popup (map.js buildBusPopupHtml: header, route
  // ribbon, metric tiles, footer, buttons), filled with what the operator
  // reported for this train. Colours come from data-line, not inline styles.
  const esc = (v) => window.TransitUtils.esc(v);
  const lineKey = t.lineCode ? `${t.agencyId}:${t.lineCode}` : '';
  const age = formatAge(Number(t.ageSec));
  const known = !(t.ageSec === null || t.ageSec === undefined);
  const badgeCls = !known || t.stale ? 'ghost' : 'live';
  const badgeText = !known ? netT('trainPopup.posUnknown', null, 'Hora de la posició desconeguda')
    : (t.stale ? netT('trainPopup.badgeStale', null, 'Posició antiga') : netT('map.popup.statusLive', null, 'En directe'));
  let delayText;
  let delayCls = '';
  let delayNote = '';
  if (t.delayDiscarded) {
    delayText = netT('trainPopup.delayDiscarded', null, 'Retard descartat');
    delayNote = netT('trainPopup.delayDiscardedNote', null, "L'operador ha publicat un retard impossible (més de 10 min d'avançament o més de 3 h de retard).");
  } else if (Number.isFinite(t.delayMins)) {
    const m = t.delayMins;
    delayCls = m > 15 ? 'critical' : (m > 5 ? 'delayed' : (m < -1 ? 'early' : 'on-time'));
    delayText = m === 0 ? netT('trainPopup.onTime', null, "A l'hora") : `${m > 0 ? '+' : '−'}${Math.abs(m)} min`;
    delayNote = t.delaySource === 'timetable'
      ? netT('trainPopup.delayNoteTimetable', null, "Calculat amb l'hora prevista de l'operador i el seu horari oficial.")
      : netT('trainPopup.delayNoteOperator', null, "Retard publicat per l'operador.");
  } else {
    delayText = netT('trainPopup.noDelay', null, 'Sense dada de retard');
  }
  const source = t.delaySource === 'timetable' ? netT('trainPopup.srcTimetable', null, "Amb l'horari oficial")
    : (Number.isFinite(t.delayMins) ? netT('trainPopup.srcFeed', null, "Publicat per l'operador") : '--');
  const name = op?.name || t.agencyId;
  const short = op?.shortName || name;
  const tile = (icon, label, value, cls = '') => `
          <div class="map-popup-metric-tile">
            <div class="map-popup-metric-header">${icon}<span>${esc(label)}</span></div>
            <div class="map-popup-metric-val ${cls}"><span>${esc(value)}</span></div>
          </div>`;
  const icClock = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
  const icPin = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';
  const icOp = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="3" width="16" height="16" rx="2"/><path d="M4 11h16M12 3v8M8 19l-2 3M16 19l2 3"/></svg>';
  const icSrc = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v12H5.17L4 17.17V4z"/></svg>';
  const tMode = t.mode || (t.agencyId === 'tmb' ? 'metro' : 'rail');
  const modeLabel = tMode === 'metro'
    ? netT('trainPopup.metro', null, 'Metro')
    : (tMode === 'tram' ? netT('trainPopup.tram', null, 'Tramvia') : netT('trainPopup.train', null, 'Tren'));
  const headerIcon = window.vehicleIconForMode ? window.vehicleIconForMode(tMode) : TRAIN_ICON_INNER_SVG;
  return `
      <div class="map-popup-card train-popup-card"${lineKey ? ` data-line="${esc(lineKey)}"` : ''}>
        <div class="map-popup-header">
          <div class="map-popup-title-group">
            <div class="map-popup-bus-icon is-train"${lineKey ? ` data-line="${esc(lineKey)}"` : ''}>
              ${headerIcon}
            </div>
            <div class="map-popup-title-text">
              <div class="map-popup-title">
                ${t.lineCode ? `<span class="map-popup-line-pill" data-line="${esc(lineKey)}">${esc(t.lineCode)}</span>` : ''}
                <span class="map-popup-bus-id">${esc(modeLabel)}${t.label ? ` ${esc(t.label)}` : ''}</span>
              </div>
              <div class="map-popup-subtitle">${esc(name)}</div>
            </div>
          </div>
          <div class="map-popup-header-status">
            <span class="map-popup-status-badge ${badgeCls}"><span class="status-pulse-dot"></span><span>${esc(badgeText)}</span></span>
          </div>
        </div>

        ${t.stopName ? `
        <div class="map-popup-route-ribbon single">
          <div class="map-popup-route-stop from">
            <span class="map-popup-stop-dot dest"></span>
            <span class="map-popup-stop-name">${esc(t.currentStatus === 'STOPPED_AT' ? netT('trainPopup.atStop', null, 'A') : netT('trainPopup.towards', null, 'Cap a'))} ${esc(t.stopName)}${t.platform ? ` · ${esc(netT('dep.platform', { n: t.platform }, `Via ${t.platform}`))}${t.platformSource === 'renfe_visor_unofficial' ? ` (${esc(netT('trainPopup.unofficialTag', null, 'font no oficial'))})` : ''}` : ''}</span>
          </div>
        </div>` : ''}

        <div class="map-popup-metrics-grid">
          ${tile(icClock, netT('trainPopup.tileStatus', null, 'Estat'), delayText, delayCls)}
          ${tile(icPin, netT('trainPopup.tilePosition', null, 'Posició'), known ? age : '--')}
          ${tile(icOp, netT('trainPopup.tileOperator', null, 'Operador'), short)}
          ${tile(icSrc, netT('trainPopup.tileSource', null, 'Font del retard'), source)}
        </div>

        ${delayNote ? `<div class="train-popup-note">${esc(delayNote)}</div>` : ''}

        ${t.unit && (t.unit.series || Number.isFinite(t.unit.occupancyPercent)) ? `<div class="train-popup-note">${esc([
          t.unit.series
            ? (Number(t.unit.coupledCount) > 1
              ? netT('trainPopup.unitCoupled', { n: t.unit.coupledCount, series: t.unit.series }, `${t.unit.coupledCount} × sèrie ${t.unit.series}`)
              : netT('trainPopup.unitSeries', { series: t.unit.series }, `Unitat de la sèrie ${t.unit.series}`))
            : '',
          t.unit.manufacturer ? t.unit.manufacturer : '',
          Number.isFinite(t.unit.occupancyPercent) ? netT('trainPopup.unitOccupancy', { pct: t.unit.occupancyPercent }, `Ocupació segons FGC: ${t.unit.occupancyPercent}%`) : '',
          t.unit.unofficial ? netT('trainPopup.unofficialTag', null, 'font no oficial') : '',
        ].filter(Boolean).join(' · '))}</div>` : ''}
        ${typeof t.wheelchairAccessible === 'boolean' ? `<div class="train-popup-note">${esc([
          netT(t.wheelchairAccessible ? 'trainPopup.wheelchairYes' : 'trainPopup.wheelchairNo', null, t.wheelchairAccessible ? 'Tren accessible per a cadira de rodes' : 'Tren no accessible per a cadira de rodes'),
          t.wheelchairSource === 'renfe_visor_unofficial' ? netT('trainPopup.unofficialTag', null, 'font no oficial') : '',
        ].filter(Boolean).join(' · '))}</div>` : ''}
        ${(!t.unit?.series && Array.isArray(t.usualSeries) && t.usualSeries.length) ? `<div class="train-popup-note">${esc(netT('trainPopup.usualSeries', { list: t.usualSeries.join(', ') }, `Sèries habituals en aquesta línia: ${t.usualSeries.join(', ')}. No se sap quina unitat fa aquest tren.`))}</div>` : ''}

        ${op?.attribution ? `
        <div class="map-popup-coords-footer">
          <span class="source-tag">${esc(op.attribution)}</span>
        </div>` : ''}

        ${lineRef ? `
        <button type="button" class="map-popup-btn-share" data-open-rail-line="${esc(lineRef)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"></polygon></svg>
          <span>${esc(netT('trainPopup.openLine', { code: t.lineCode }, `Obre la línia ${t.lineCode}`))}</span>
        </button>` : ''}
      </div>`;
}
window.buildTrainPopupHtml = buildTrainPopupHtml;

/** A Moventis bus's popup, in the bus popup's card: line, operator, next
 *  stop and when it gets there, and that the position is estimated. */
function buildMoventisPopupHtml(b, feed) {
  const esc = (v) => window.TransitUtils.esc(v);
  const isLiveGps = Boolean(b.isRealTime && !b.isEstimated);
  const isGpsExtrap = b.positionSource === 'gps_extrapolated';
  const eta = Number(b.nextStopEtaSec);
  const age = Number(b.predictionAgeSec);
  const mins = s => (s < 60 ? netT('movPopup.lessThanMin', null, 'menys d’1 min') : netT('movPopup.minutes', { n: Math.round(s / 60) }, `${Math.round(s / 60)} min`));
  const tile = (label, value) => `
          <div class="map-popup-metric-tile">
            <div class="map-popup-metric-header"><span>${esc(label)}</span></div>
            <div class="map-popup-metric-val"><span>${esc(value)}</span></div>
          </div>`;
  const badgeCls = isLiveGps ? 'live' : 'ghost';
  const badgeLabel = isLiveGps ? netT('movPopup.liveGps', null, 'GPS en temps real') : netT('movPopup.estimated', null, 'Posició estimada');
  const ageLabel = (isLiveGps || isGpsExtrap) ? netT('movPopup.tileGpsAge', null, 'Últim GPS fa') : netT('movPopup.tileAge', null, 'Previsió de fa');
  const noteText = isLiveGps
    ? netT('movPopup.noteGps', null, "Posició GPS en temps real de l'operador.")
    : (isGpsExtrap
      ? netT('movPopup.noteGpsExtrap', null, "Posició estimada al llarg del recorregut a partir de l'últim GPS real rebut.")
      : netT('movPopup.note', null, "Posició estimada a partir de les previsions d'arribada que Moventis publica per a cada parada: no és una posició GPS."));
  const pillBg = (typeof b.color === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(b.color)) ? b.color : '#007a5a';
  const pillInk = window.TransitUtils?.contrastInk ? window.TransitUtils.contrastInk(pillBg, b.textColor) : '#ffffff';
  const lineRef = b.lineRef || (b.agencyId && b.lineCode ? `${b.agencyId}:${b.lineCode}` : '');
  const attribution = b.attribution || feed?.attribution || '';
  return `
      <div class="map-popup-card moventis-popup-card">
        <div class="map-popup-header">
          <div class="map-popup-title-group">
            <div class="map-popup-bus-icon">${CANONICAL_BUS_ICON_INNER_SVG}</div>
            <div class="map-popup-title-text">
              <div class="map-popup-title">
                <span class="map-popup-line-pill" style="background: ${esc(pillBg)}; color: ${esc(pillInk)};">${esc(b.lineCode)}</span>
                <span class="map-popup-bus-id">${esc(netT('movPopup.bus', null, 'Bus'))}</span>
              </div>
              <div class="map-popup-subtitle">${esc(b.lineName || b.agency || 'Moventis')}</div>
            </div>
          </div>
          <div class="map-popup-header-status">
            <span class="map-popup-status-badge ${badgeCls}"><span class="status-pulse-dot"></span><span>${esc(badgeLabel)}</span></span>
          </div>
        </div>
        ${b.stopName ? `
        <div class="map-popup-route-ribbon single">
          <div class="map-popup-route-stop from">
            <span class="map-popup-stop-dot dest"></span>
            <span class="map-popup-stop-name">${esc(netT('trainPopup.towards', null, 'Cap a'))} ${esc(b.stopName)}</span>
          </div>
        </div>` : ''}
        <div class="map-popup-metrics-grid">
          ${tile(netT('movPopup.tileNext', null, 'Propera parada'), Number.isFinite(eta) ? mins(eta) : '--')}
          ${tile(netT('movPopup.tileDest', null, 'Destinació'), b.destination || '--')}
          ${tile(netT('trainPopup.tileOperator', null, 'Operador'), b.agency || 'Moventis')}
          ${tile(ageLabel, Number.isFinite(age) ? mins(age) : '--')}
        </div>
        <div class="train-popup-note">${esc(noteText)}</div>
        ${attribution ? `
        <div class="map-popup-coords-footer">
          <span class="source-tag">${esc(attribution)}</span>
        </div>` : ''}
        ${lineRef ? `
        <button type="button" class="map-popup-btn-share" data-open-rail-line="${esc(lineRef)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"></polygon></svg>
          <span>${esc(netT('trainPopup.openLine', { code: b.lineCode }, `Obre la línia ${b.lineCode}`))}</span>
        </button>` : ''}
      </div>`;
}

/** Staleness backstop for entries carried across a physical-only SSE snapshot.
 *  Comfortably longer than this map's 30 s REST cadence, so a carried entry
 *  always gets a chance to be superseded by a real per-line refresh. */
const CARRIED_ENTRY_TTL_MS = 150000;

/** Neutral slate for a special service: it has no catalog colour. */
const SPECIAL_SERVICE_COLOR = '#64748b';

function isGhostBus(bus) {
  return Boolean(bus && (bus.isGhostVehicle || bus.isTheoretical ||
    (bus.vehicleId && String(bus.vehicleId).startsWith('EST_'))));
}

/**
 * Buses the physical-only SSE stream cannot describe, so they must survive it:
 * timetable ghosts, and dead-reckoned buses whose position is an extrapolation.
 * Both are drawn distinctly and both exist only in the per-line payload.
 */
function isStreamBlindBus(bus) {
  return isGhostBus(bus) || Boolean(bus && bus.isEstimated);
}

function carriedEntryAgeMs(bus) {
  const raw = bus.lastUpdate ?? bus.lastSeen ?? bus.observedAt ?? bus.recordedAt ?? bus.timestamp;
  if (raw === undefined || raw === null || raw === '') return NaN;
  const t = typeof raw === 'number' ? raw : Date.parse(raw);
  return Number.isFinite(t) ? t : NaN;
}

/** An unparseable stamp is kept rather than dropped, so one malformed field
 *  cannot strobe an estimated bus off the map. */
function isCarriedEntryValid(bus) {
  const t = carriedEntryAgeMs(bus);
  return !Number.isFinite(t) || (Date.now() - t) <= CARRIED_ENTRY_TTL_MS;
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

if (typeof window !== 'undefined') {
  window.NetworkMap = NetworkMap;
}

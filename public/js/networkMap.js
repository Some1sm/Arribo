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
    this.railRouteLayer = L.featureGroup().addTo(this.map);
    this.railRoutes = [];              // [{ agencyId, code, polyline }]
    this.routeLayer = L.featureGroup().addTo(this.map);
    this.stopLayer = L.layerGroup().addTo(this.map);
    this.busLayer = L.layerGroup().addTo(this.map);
    // Rodalies / FGC trains from /api/trains: their own layer of canvas
    // circle markers (no DOM per train), drawn at the positions the
    // operators reported, never snapped or animated.
    this.trainLayer = L.layerGroup().addTo(this.map);
    this.trainMarkers = new Map();     // train id -> { marker, popupHtml }
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
    };
    this.map.on('zoomend', applyZoomClass);
    applyZoomClass();

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
    const neutral = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim();
    for (const l of Array.isArray(lines) ? lines : []) {
      const path = Array.isArray(l?.path) ? l.path.filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) : [];
      if (path.length < 2 || !l.agencyId || !l.code) continue;
      const color = typeof l.color === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(l.color) ? l.color : neutral;
      // A path joined from the stations (no shape in the timetable) is dashed.
      const polyline = L.polyline(path, { color, weight: 3, opacity: 0.7, dashArray: l.fromStops ? '6 6' : null, interactive: false });
      this.railRoutes.push({ agencyId: l.agencyId, code: l.code, polyline });
    }
    this.renderRailRoutes();
  }

  /** Puts each train line's path on the map when trains are shown and the filter allows it. */
  renderRailRoutes() {
    if (!this.railRouteLayer) return;
    // Paths are static: they show without a live train feed too.
    const show = this.trainsShown && this.railFilterOpen();
    for (const r of this.railRoutes || []) {
      const want = show && this.isRailLineVisible(r.agencyId, r.code);
      const has = this.railRouteLayer.hasLayer(r.polyline);
      if (want && !has) this.railRouteLayer.addLayer(r.polyline);
      if (!want && has) this.railRouteLayer.removeLayer(r.polyline);
    }
  }

  /** Whether a train line passes the map filter (all, its operator, or the line itself). */
  isRailLineVisible(agencyId, code) {
    const f = this.mapFilter || { kind: 'all' };
    if (f.kind === 'all') return true;
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

  /** Whether the filter lets any train through: everything, a train operator, or a train line. */
  railFilterOpen() {
    const f = this.mapFilter || { kind: 'all' };
    return f.kind === 'all' || f.kind === 'rail' || (f.kind === 'op' && f.agencyId !== 'mataro');
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
    const operators = new Map((this.trainFeed?.operators || []).map(o => [o.id, o]));
    const seen = new Set();

    for (const t of trains) {
      const lat = Number(t?.lat ?? t?.latitude);
      const lon = Number(t?.lon ?? t?.longitude);
      if (t?.lat === null || t?.lon === null || !Number.isFinite(lat) || !Number.isFinite(lon) || !t.id) continue;
      // An operator or line filter keeps only its own trains (the rest are removed below).
      if (!this.isRailLineVisible(t.agencyId, t.lineCode)) continue;
      seen.add(t.id);
      const lineColor = this.trainColors.get(`${t.agencyId}:${t.lineCode}`) || neutral;
      // A position the operator has stopped updating is drawn hollow and
      // dashed, in the neutral colour: it is old, not live.
      const style = t.stale
        ? { radius: 6, color: neutral, weight: 2, dashArray: '3 3', fillColor: ring, fillOpacity: 0.6, opacity: 0.9 }
        : { radius: 6, color: ring, weight: 2, dashArray: null, fillColor: lineColor, fillOpacity: 0.95, opacity: 1 };
      const popupHtml = buildTrainPopupHtml(t, operators.get(t.agencyId), this.trainLineRefs.get(`${t.agencyId}:${t.lineCode}`));
      const existing = this.trainMarkers.get(t.id);
      if (existing) {
        existing.marker.setLatLng([lat, lon]);
        existing.marker.setStyle(style);
        if (existing.popupHtml !== popupHtml) {
          existing.marker.setPopupContent(popupHtml);
          existing.popupHtml = popupHtml;
        }
        continue;
      }
      const marker = L.circleMarker([lat, lon], style);
      marker.bindPopup(popupHtml, { className: 'arribo-bus-popup', minWidth: 290, maxWidth: 350, autoPan: true, autoPanPadding: [20, 20], closeButton: true });
      marker.addTo(this.trainLayer);
      this.trainMarkers.set(t.id, { marker, popupHtml });
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

  /** Trains drawn now: total and how many have a position older than the live window. */
  trainCounts() {
    if (!this.trainsVisible()) return { total: 0, stale: 0, available: Boolean(this.trainFeed) };
    let stale = 0;
    let total = 0;
    for (const t of this.trainFeed.trains.slice(0, MAX_TRAIN_MARKERS)) {
      if (!t || !t.id || !Number.isFinite(Number(t.lat)) || !this.isRailLineVisible(t.agencyId, t.lineCode)) continue;
      total++;
      if (t.stale) stale++;
    }
    // inView: the feed was cut to the map's area (?bbox=), so these are the trains in view.
    return { total, stale, available: true, inView: Array.isArray(this.trainFeed?.bbox) };
  }

  renderLegend() {
    const host = document.getElementById('network-map-legend');
    if (!host) return;
    host.textContent = '';
    for (const line of this.lineCatalog) {
      const pill = document.createElement('span');
      // Dimmed entries are the ones currently filtered out, so the legend
      // reports what is hidden as well as what is drawn.
      pill.className = `network-map-legend-item${this.isLineVisible(line.code) ? '' : ' is-dimmed'}`;
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
    const stopsGroup = L.layerGroup().addTo(this.stopLayer);

    // Arrows are far denser than a single route needs; 2 km keeps eight routes
    // legible instead of burying the map in arrow nodes. createDirectionalArrows
    // adds them straight to the map, so this records them for the filter to
    // add/remove alongside the rest of their line.
    const arrows = [];
    for (const coords of [primary, secondary]) {
      if (!coords || coords.length < 2) continue;
      arrows.push(...this.createDirectionalArrows(coords, color, 2000));
    }
    this.directionalArrowMarkers.push(...arrows);

    // Same styling as TransitMap.renderStops: solid outbound leg, dashed
    // return leg. The return leg keeps the LINE's own colour here (not the
    // single-line map's #38bdf8 fallback) so one colour always means one line.
    if (primary && primary.length > 1) {
      L.polyline(primary, {
        color, weight: 4.5, opacity: 0.9, lineCap: 'round', lineJoin: 'round'
      }).addTo(routes);
    }
    if (secondary && secondary.length > 1) {
      L.polyline(secondary, {
        color, weight: 4, opacity: 0.85, dashArray: '8, 8', lineCap: 'round', lineJoin: 'round'
      }).addTo(routes);
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
        }).addTo(stopsGroup);
      }
    };
    addStops(stops, primary);
    addStops(secondaryStops, secondary);

    this.lineLayers.set(code, { routes, stops: stopsGroup, arrows });
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
    // "all"; an operator ("op:mataro", "op:fgc"); a train line by its
    // lineRef ("renfe_rodalies:R1"); or a Mataró line id ("3", "L3").
    let f = { kind: 'all' };
    if (raw.startsWith('op:') && raw.length > 3) {
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
    this.renderRailRoutes();
  }

  /** Whether a Mataró bus line passes the map filter. */
  isLineVisible(code) {
    const f = this.mapFilter || { kind: 'all' };
    if (f.kind === 'all') return true;
    if (f.kind === 'op') return f.agencyId === 'mataro';
    if (f.kind === 'bus') return canonicalLineCode(code) === f.code;
    return false; // a train line is selected
  }

  /** Shows or hides every layer and bus marker that the filter excludes. */
  applyLineVisibility() {
    if (!this.map) return;

    for (const [code, layers] of this.lineLayers.entries()) {
      const visible = this.isLineVisible(code);
      if (visible) {
        this.routeLayer.addLayer(layers.routes);
        this.stopLayer.addLayer(layers.stops);
        for (const arrow of layers.arrows) {
          if (!this.map.hasLayer(arrow)) this.map.addLayer(arrow);
        }
      } else {
        // addLayer/removeLayer on the PARENT, not group.remove(): Leaflet's
        // group.remove() detaches from the map but leaves the group listed in
        // its parent, so routeLayer.getBounds() would still include the hidden
        // line and the map would frame buses the visitor cannot see.
        this.routeLayer.removeLayer(layers.routes);
        this.stopLayer.removeLayer(layers.stops);
        for (const arrow of layers.arrows) {
          if (this.map.hasLayer(arrow)) this.map.removeLayer(arrow);
        }
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
        existing.targetPolyline = followRoute ? targetPolyline : null;
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
      });
      // A filtered-out line keeps its buses in busMarkersMap — they are still
      // animating and must be there when the filter comes back — but they are
      // not attached to the map, so they are neither visible nor clickable.
      if (this.isLineVisible(code)) marker.addTo(this.busLayer);

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
        targetPolyline: followRoute ? targetPolyline : null,
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
    this.lineGeometries.clear();
    this.lineLayers.clear();
    this.busesByLine.clear();
  }
}

// -------------------------------------------------------------- helpers

/** Bound on train markers, far above the ~200 trains both feeds report. */
const MAX_TRAIN_MARKERS = 1500;

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
  return `
      <div class="map-popup-card train-popup-card"${lineKey ? ` data-line="${esc(lineKey)}"` : ''}>
        <div class="map-popup-header">
          <div class="map-popup-title-group">
            <div class="map-popup-bus-icon is-train"${lineKey ? ` data-line="${esc(lineKey)}"` : ''}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="16" rx="2"/><path d="M4 11h16M12 3v8"/><circle cx="8.5" cy="15" r="1"/><circle cx="15.5" cy="15" r="1"/><path d="M8 19l-2 3M16 19l2 3"/></svg>
            </div>
            <div class="map-popup-title-text">
              <div class="map-popup-title">
                ${t.lineCode ? `<span class="map-popup-line-pill" data-line="${esc(lineKey)}">${esc(t.lineCode)}</span>` : ''}
                <span class="map-popup-bus-id">${esc(netT('trainPopup.train', null, 'Tren'))}${t.label ? ` ${esc(t.label)}` : ''}</span>
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
            <span class="map-popup-stop-name">${esc(t.currentStatus === 'STOPPED_AT' ? netT('trainPopup.atStop', null, 'A') : netT('trainPopup.towards', null, 'Cap a'))} ${esc(t.stopName)}${t.platform ? ` · ${esc(netT('dep.platform', { n: t.platform }, `Via ${t.platform}`))}` : ''}</span>
          </div>
        </div>` : ''}

        <div class="map-popup-metrics-grid">
          ${tile(icClock, netT('trainPopup.tileStatus', null, 'Estat'), delayText, delayCls)}
          ${tile(icPin, netT('trainPopup.tilePosition', null, 'Posició'), known ? age : '--')}
          ${tile(icOp, netT('trainPopup.tileOperator', null, 'Operador'), short)}
          ${tile(icSrc, netT('trainPopup.tileSource', null, 'Font del retard'), source)}
        </div>

        ${delayNote ? `<div class="train-popup-note">${esc(delayNote)}</div>` : ''}

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

/** Staleness backstop for entries carried across a physical-only SSE snapshot.
 *  Comfortably longer than this map's 30 s REST cadence, so a carried entry
 *  always gets a chance to be superseded by a real per-line refresh. */
const CARRIED_ENTRY_TTL_MS = 150000;

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

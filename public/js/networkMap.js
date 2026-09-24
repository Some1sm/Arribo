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
    }).setView([41.54, 2.44], 13);

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
    this.routeLayer = L.featureGroup().addTo(this.map);
    this.stopLayer = L.layerGroup().addTo(this.map);
    this.busLayer = L.layerGroup().addTo(this.map);

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
      code: canonicalLineCode(l.code || l.id) || String(l.code || l.id || '').toUpperCase(),
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
    // Only 'all' and a real Mataró line code are honoured. An unrecognised
    // value falls back to showing everything, because a blank map with no
    // visible cause is a worse failure than ignoring a bad value.
    this.lineFilter = /^L?[1-8]$/i.test(raw) ? `L${raw.replace(/^L/i, '')}` : 'all';
    this.applyLineVisibility();
    this.renderLegend();
  }

  isLineVisible(code) {
    if (this.lineFilter === 'all') return true;
    return canonicalLineCode(code) === this.lineFilter;
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
    if (typeof this.routeLayer?.getBounds !== 'function') return;
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
    this.lineGeometries.clear();
    this.lineLayers.clear();
    this.busesByLine.clear();
  }
}

// -------------------------------------------------------------- helpers

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

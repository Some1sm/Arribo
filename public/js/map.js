// Leaflet Map Module for Multi-Line Transit Platform (C-10 + Mataró Bus)
// Features: Road-Snapping, Polyline Subpath Following, Bearing Rotation, and Glider Animations

class C10Map {
  constructor(containerId) {
    this.containerId = containerId;
    this.map = null;
    this.stopMarkers = [];
    this.busMarkersMap = new Map(); // tripId -> { marker, busData, subpath, currentBearing }
    this.routePolyline = null;
    this.activePolylineCoords = []; // Array of [lat, lon]
    this.lastStopsFingerprint = null;
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
      scrollWheelZoom: true
    }).setView([41.54, 2.44], 13);

    // High quality modern tile layer (CartoDB Voyager)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      subdomains: 'abcd',
      maxZoom: 19
    }).addTo(this.map);
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

  // Snap any coordinate strictly to the closest point on the road polyline
  snapToPolyline(lat, lon, polyline = this.activePolylineCoords) {
    if (!polyline || polyline.length === 0) return { lat, lon, index: 0, bearing: 0 };
    if (polyline.length === 1) return { lat: polyline[0][0], lon: polyline[0][1], index: 0, bearing: 0 };

    let minDistance = Infinity;
    let bestPoint = { lat: polyline[0][0], lon: polyline[0][1], index: 0, bearing: 0 };

    for (let i = 0; i < polyline.length - 1; i++) {
      const p1 = polyline[i];
      const p2 = polyline[i + 1];

      const x1 = p1[1], y1 = p1[0];
      const x2 = p2[1], y2 = p2[0];
      const px = lon, py = lat;

      const dx = x2 - x1;
      const dy = y2 - y1;
      const lenSq = dx * dx + dy * dy;

      let t = 0;
      if (lenSq > 0) {
        t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
      }

      const projX = x1 + t * dx;
      const projY = y1 + t * dy;
      const dist = this.calculateDistanceMeters(lat, lon, projY, projX);

      if (dist < minDistance) {
        minDistance = dist;
        bestPoint = {
          lat: projY,
          lon: projX,
          index: i,
          t,
          bearing: this.calculateBearing(p1[0], p1[1], p2[0], p2[1]),
          distanceMeters: dist
        };
      }
    }

    return bestPoint;
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

  // Interpolate along the road subpath (following every street curve)
  interpolateAlongSubpath(subpath, progress) {
    if (!subpath || subpath.length === 0) return null;
    if (subpath.length === 1 || progress <= 0) {
      return { lat: subpath[0][0], lon: subpath[0][1], bearing: 0 };
    }
    if (progress >= 1) {
      const last = subpath[subpath.length - 1];
      const prev = subpath[subpath.length - 2] || last;
      return { lat: last[0], lon: last[1], bearing: this.calculateBearing(prev[0], prev[1], last[0], last[1]) };
    }

    const segLengths = [];
    let totalLength = 0;

    for (let i = 0; i < subpath.length - 1; i++) {
      const d = this.calculateDistanceMeters(subpath[i][0], subpath[i][1], subpath[i + 1][0], subpath[i + 1][1]);
      segLengths.push(d);
      totalLength += d;
    }

    if (totalLength === 0) {
      return { lat: subpath[0][0], lon: subpath[0][1], bearing: 0 };
    }

    const targetDist = progress * totalLength;
    let accumulated = 0;

    for (let i = 0; i < segLengths.length; i++) {
      const segLen = segLengths[i];
      if (accumulated + segLen >= targetDist || i === segLengths.length - 1) {
        const segProgress = segLen > 0 ? (targetDist - accumulated) / segLen : 0;
        const p1 = subpath[i];
        const p2 = subpath[i + 1];
        const lat = p1[0] + segProgress * (p2[0] - p1[0]);
        const lon = p1[1] + segProgress * (p2[1] - p1[1]);
        const bearing = this.calculateBearing(p1[0], p1[1], p2[0], p2[1]);
        return { lat, lon, bearing };
      }
      accumulated += segLen;
    }

    const last = subpath[subpath.length - 1];
    return { lat: last[0], lon: last[1], bearing: 0 };
  }

  // Create directional arrows along a polyline
  createDirectionalArrows(polylineCoords, color) {
    if (!polylineCoords || polylineCoords.length < 2) return [];
    const arrows = [];
    let accumulated = 0;
    
    for (let i = 0; i < polylineCoords.length - 1; i++) {
      const p1 = polylineCoords[i];
      const p2 = polylineCoords[i + 1];
      const d = this.calculateDistanceMeters(p1[0], p1[1], p2[0], p2[1]);
      accumulated += d;

      // Place an arrow roughly every 800 meters along the route
      if (accumulated >= 800) {
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
  renderStops(stops, targetStopId = '', onStopClick = null, shouldFitBounds = false, lineColor = '#009485', customPolyline = null, secondaryPolyline = null, secondaryStops = null, secondaryColor = '#38bdf8') {
    if (!this.map) return;

    const stopsFingerprint = `${stops.length}_${targetStopId}_${lineColor}_${customPolyline ? customPolyline.length : 0}_${secondaryPolyline ? secondaryPolyline.length : 0}`;
    const alreadyRendered = this.lastStopsFingerprint === stopsFingerprint && this.stopMarkers.length > 0;

    if (!alreadyRendered) {
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

        const latLng = [stop.lat, stop.lon];
        latLngs.push(latLng);

        const stopIdentifier = String(stop.mouteStopId || stop.id || stop.code || '');
        const isTarget = stopIdentifier === String(targetStopId);
        const isMaresme = stop.zone === 'Zona Maresme' || (stop.lon && stop.lon >= 2.289);

        const markerHtml = `
          <div class="stop-marker-dot" style="
            width: ${isTarget ? '22px' : '14px'};
            height: ${isTarget ? '22px' : '14px'};
            background-color: ${isTarget ? lineColor : isMaresme ? '#06b6d4' : '#f97316'};
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
          className: 'c10-stop-marker',
          iconSize: [isTarget ? 22 : 14, isTarget ? 22 : 14],
          iconAnchor: [isTarget ? 11 : 7, isTarget ? 11 : 7]
        });

        const marker = L.marker(latLng, { icon: customIcon }).addTo(this.map);

        // Hover tooltip
        marker.bindTooltip(`
          <div style="display:flex; align-items:center; gap:6px;">
            <span style="background:${lineColor}; color:#fff; font-size:10px; font-weight:800; padding:1px 5px; border-radius:3px;">#${stop.seq || index + 1}</span>
            <span>${stop.name}</span>
          </div>
        `, {
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
            window.c10App?.inspectStop(stopIdentifier, stop.name);
          }
        });

        this.stopMarkers.push(marker);
      });

      // 2. Render Secondary Direction Stops (if showing both directions)
      if (secondaryStops && secondaryStops.length > 0) {
        secondaryStops.forEach((stop, index) => {
          if (!stop.lat || !stop.lon) return;
          const stopIdentifier = String(stop.mouteStopId || stop.id || stop.code || '');
          const isTarget = stopIdentifier === String(targetStopId);

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

          const marker = L.marker([stop.lat, stop.lon], { icon: customIcon }).addTo(this.map);

          marker.bindTooltip(`
            <div style="display:flex; align-items:center; gap:6px;">
              <span style="background:${secondaryColor}; color:#fff; font-size:10px; font-weight:800; padding:1px 5px; border-radius:3px;">Sentit 2</span>
              <span>${stop.name}</span>
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
              window.c10App?.inspectStop(stopIdentifier, stop.name);
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
      if (shouldFitBounds) {
        const boundsGroup = [];
        if (this.routePolyline) boundsGroup.push(this.routePolyline);
        if (this.secondaryRoutePolyline) boundsGroup.push(this.secondaryRoutePolyline);

        if (boundsGroup.length > 0) {
          const group = new L.featureGroup(boundsGroup);
          this.map.fitBounds(group.getBounds(), { padding: [35, 35] });
        }
      }

      this.lastStopsFingerprint = stopsFingerprint;
    }
  }

  // Draw or update the road polyline on map
  renderPolyline(coords, color = '#009485') {
    if (!this.map || !coords || coords.length < 2) return;
    if (this.routePolyline) {
      this.map.removeLayer(this.routePolyline);
      this.routePolyline = null;
    }
    this.activePolylineCoords = coords;
    this.routePolyline = L.polyline(coords, {
      color: color || '#009485',
      weight: 5,
      opacity: 0.85,
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(this.map);

    try {
      this.map.fitBounds(this.routePolyline.getBounds(), { padding: [30, 30], maxZoom: 15 });
    } catch(e) {}
  }

  // Update active bus markers and attach road subpaths
  // Update active bus markers and attach road subpaths
  updateBusMarkers(activeBuses, lineColor = '#009485', secondaryColor = '#38bdf8') {
    if (!this.map) return;

    const now = Date.now();
    const currentTripIds = new Set(activeBuses.map(b => b.tripId));

    // Handle missing buses with 90-second client-side dead-reckoning hold buffer
    for (const [tId, obj] of this.busMarkersMap.entries()) {
      if (!currentTripIds.has(tId)) {
        const elapsedSec = (now - (obj.lastUpdated || now)) / 1000;
        if (elapsedSec > 90) {
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

    activeBuses.forEach(bus => {
      if (!bus.lat || !bus.lon) return;

      const isSecDir = String(bus.direction) === '1' && secondaryCoords && secondaryCoords.length > 1;
      const targetPolyline = isSecDir ? secondaryCoords : (this.activePolylineCoords || []);
      const busColor = isSecDir ? secondaryColor : lineColor;

      // 1. Street-Snapping: Snap raw GPS strictly to the target road polyline
      let snapped = { lat: bus.lat, lon: bus.lon, bearing: bus.bearing || 0 };
      if (targetPolyline && targetPolyline.length > 1) {
        snapped = this.snapToPolyline(bus.lat, bus.lon, targetPolyline);
      }

      // 2. Extract road subpath between fromCoords and toCoords
      let subpath = null;
      if (bus.fromCoords && bus.toCoords && targetPolyline && targetPolyline.length > 1) {
        subpath = this.extractSubpath(targetPolyline, bus.fromCoords.lat, bus.fromCoords.lon, bus.toCoords.lat, bus.toCoords.lon);
      }

      const bearingAngle = snapped.bearing || bus.bearing || 0;
      const compassLabel = bus.compass?.label || 'N/A';
      const speedText = bus.speedKmh ? `${bus.speedKmh} km/h` : (bus.isTerminalLayover ? '0 km/h (Aturat)' : '30-40 km/h');
      const coordsText = `${snapped.lat.toFixed(5)}°, ${snapped.lon.toFixed(5)}°`;
      const isEst = Boolean(bus.isEstimated);

      const popupHtml = bus.isTerminalLayover ? `
        <div class="map-popup-card">
          <div class="map-popup-header">
            <div class="map-popup-title">
              <span>🅿️ Bus en Regulació</span>
            </div>
            <span class="map-popup-badge layover">Capçalera</span>
          </div>

          <div class="map-popup-route" style="color:#60a5fa;">
            <span>📍 ${bus.fromStop}</span>
          </div>

          <div class="map-popup-grid">
            <div class="map-popup-item">
              <span class="map-popup-item-label">Vehicle</span>
              <span class="map-popup-item-val">#${bus.vehicleId || 'Bus'}</span>
            </div>
            <div class="map-popup-item">
              <span class="map-popup-item-label">Estat</span>
              <span class="map-popup-item-val">Aturat</span>
            </div>
          </div>

          <div class="map-popup-coords-footer">
            <span>📍 ${coordsText}</span>
            <span>Regulació</span>
          </div>
        </div>
      ` : `
        <div class="map-popup-card">
          <div class="map-popup-header">
            <div class="map-popup-title">
              <span>🚌 Bus ${bus.vehicleId ? `#${bus.vehicleId}` : ''}</span>
            </div>
            <span class="map-popup-badge ${isEst ? 'estimated' : 'live'}" style="background:${isSecDir ? 'rgba(56, 189, 248, 0.2)' : ''}; color:${isSecDir ? '#38bdf8' : ''};">
              ${isEst ? '⚡ Estimació' : isSecDir ? '🔄 Sentit 2' : '🟢 GPS Directe'}
            </span>
          </div>

          <div class="map-popup-route" style="color:${busColor};">
            <span>${bus.fromStop}</span>
            <span style="opacity:0.6;">➔</span>
            <span>${bus.toStop}</span>
          </div>

          <div class="map-popup-grid">
            <div class="map-popup-item">
              <span class="map-popup-item-label">⚡ Velocitat</span>
              <span class="map-popup-item-val">${speedText}</span>
            </div>
            <div class="map-popup-item">
              <span class="map-popup-item-label">🧭 Rumb</span>
              <span class="map-popup-item-val">${compassLabel} (${bearingAngle}°)</span>
            </div>
            <div class="map-popup-item">
              <span class="map-popup-item-label">📊 Progrés</span>
              <span class="map-popup-item-val">${bus.totalProgress || 0}%</span>
            </div>
            <div class="map-popup-item">
              <span class="map-popup-item-label">🚦 Estat</span>
              <span class="map-popup-item-val">${bus.delayFormatted || 'Puntual'}</span>
            </div>
          </div>

          <div class="map-popup-coords-footer">
            <span>📍 ${coordsText}</span>
            <span>${isEst ? 'Estimació' : 'Temps Real'}</span>
          </div>
        </div>
      `;

      const pinBg = isEst
        ? 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)'
        : (bus.isTerminalLayover 
            ? 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)'
            : (busColor || 'linear-gradient(135deg, #10b981 0%, #059669 100%)'));

      if (this.busMarkersMap.has(bus.tripId)) {
        const obj = this.busMarkersMap.get(bus.tripId);
        obj.busData = bus;
        obj.targetLat = snapped.lat;
        obj.targetLon = snapped.lon;
        obj.targetBearing = bearingAngle;
        obj.subpath = subpath;
        obj.lastUpdated = now;
        obj.marker.setPopupContent(popupHtml);

        if (bus.isTerminalLayover) {
          obj.marker.setLatLng([snapped.lat, snapped.lon]);
        }

        // Dynamically update pin background and status dot to restore live colors immediately upon GPS reconnection
        const el = obj.marker.getElement();
        if (el) {
          const pinEl = el.querySelector('.live-bus-pin');
          if (pinEl) {
            pinEl.style.background = pinBg;
          }
          const dotEl = el.querySelector('.bus-status-dot');
          if (dotEl) {
            dotEl.className = `bus-status-dot ${isEst ? 'estimated' : 'live'}`;
          }
        }
      } else {
        const isHeadingWest = bearingAngle > 180 && bearingAngle < 360;
        const busHtml = bus.isTerminalLayover ? `
          <div class="live-bus-marker-wrap">
            <div class="live-bus-pin" style="background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);">
              <span class="bus-icon-inner">🅿️</span>
            </div>
          </div>
        ` : `
          <div class="live-bus-marker-wrap">
            <div class="bus-heading-cone" style="transform: rotate(${bearingAngle}deg);">
              <div class="bus-heading-arrow"></div>
            </div>
            <div class="live-bus-pin" style="background: ${pinBg};">
              <span class="bus-icon-inner" style="transform: scaleX(${isHeadingWest ? -1 : 1});">🚌</span>
              <span class="bus-status-dot ${isEst ? 'estimated' : 'live'}"></span>
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
          zIndexOffset: 2000
        }).addTo(this.map);

        marker.bindPopup(popupHtml);
        this.busMarkersMap.set(bus.tripId, {
          marker,
          busData: bus,
          targetLat: snapped.lat,
          targetLon: snapped.lon,
          targetBearing: bearingAngle,
          currentBearing: bearingAngle,
          isFacingWest: isHeadingWest,
          lastUpdated: now,
          subpath
        });
      }
    });
  }

  // Smooth continuous client-side gliding with zero rollbacks and anti-flicker hysteresis
  stepBusAnimation(nowSec) {
    for (const [tId, obj] of this.busMarkersMap.entries()) {
      const bus = obj.busData;
      if (!bus || !obj.marker) continue;

      const currentPos = obj.marker.getLatLng();
      if (!currentPos) continue;

      // 1. If parked in terminal layover, stay at terminal
      if (bus.isTerminalLayover) {
        obj.marker.setLatLng([bus.lat, bus.lon]);
        continue;
      }

      const targetLat = obj.targetLat !== undefined ? obj.targetLat : bus.lat;
      const targetLon = obj.targetLon !== undefined ? obj.targetLon : bus.lon;
      const targetBearing = obj.targetBearing !== undefined ? obj.targetBearing : (bus.bearing || 0);

      // 2. Smooth exponential position LERP (smooth forward motion towards validated road coordinate)
      const dLat = targetLat - currentPos.lat;
      const dLon = targetLon - currentPos.lng;
      const distDeg = Math.sqrt(dLat * dLat + dLon * dLon);

      if (distDeg > 0.005) {
        // Large distance (teleport or initial spawn): snap directly
        obj.marker.setLatLng([targetLat, targetLon]);
      } else if (distDeg > 0.000002) {
        // Smooth forward glide (8% step per frame = ~0.8s smooth transition without rollback)
        const smoothLat = currentPos.lat + dLat * 0.08;
        const smoothLon = currentPos.lng + dLon * 0.08;
        obj.marker.setLatLng([smoothLat, smoothLon]);
      }

      // 3. Smooth shortest-angle rotation interpolation for direction cone
      if (targetBearing !== null) {
        let currentBearing = obj.currentBearing !== undefined ? obj.currentBearing : targetBearing;
        let delta = (targetBearing - currentBearing + 540) % 360 - 180;
        currentBearing = (currentBearing + delta * 0.12 + 360) % 360;
        obj.currentBearing = currentBearing;

        const el = obj.marker.getElement();
        if (el) {
          const cone = el.querySelector('.bus-heading-cone');
          if (cone) {
            cone.style.transform = `rotate(${Math.round(currentBearing)}deg)`;
          }

          // Anti-flicker hysteresis for bus emoji facing direction:
          // Only switch to West if strongly pointing West (> 200° and < 340°)
          // Only switch to East if strongly pointing East (< 160° or > 20°)
          // In the deadband zone (160°-200° and 340°-20°), preserve previous facing state to eliminate rapid flipping on curves
          if (currentBearing >= 200 && currentBearing <= 340) {
            obj.isFacingWest = true;
          } else if (currentBearing <= 160 || (currentBearing >= 20 && currentBearing <= 160)) {
            obj.isFacingWest = false;
          }

          const icon = el.querySelector('.bus-icon-inner');
          if (icon) {
            icon.style.transform = `scaleX(${obj.isFacingWest ? -1 : 1})`;
          }
        }
      }
    }
  }

  focusTargetStop(lat, lon) {
    if (!this.map || !lat || !lon) return;
    this.map.flyTo([lat, lon], 15, { duration: 1.2 });
  }

  invalidateSize() {
    if (!this.map) return;
    this.map.invalidateSize();
  }
}

window.C10Map = C10Map;

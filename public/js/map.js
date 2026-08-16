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

  // Render stops and road polyline on map
  renderStops(stops, targetStopId = '', onStopClick = null, shouldFitBounds = false, lineColor = '#009485', customPolyline = null) {
    if (!this.map) return;

    const stopsFingerprint = `${stops.length}_${targetStopId}_${lineColor}_${customPolyline ? customPolyline.length : 0}`;
    const alreadyRendered = this.lastStopsFingerprint === stopsFingerprint && this.stopMarkers.length > 0;

    if (!alreadyRendered) {
      this.stopMarkers.forEach(m => this.map.removeLayer(m));
      this.stopMarkers = [];
      if (this.routePolyline) {
        this.map.removeLayer(this.routePolyline);
      }

      const latLngs = [];

      stops.forEach((stop, index) => {
        if (!stop.lat || !stop.lon) return;

        const latLng = [stop.lat, stop.lon];
        latLngs.push(latLng);

        const stopIdentifier = String(stop.mouteStopId || stop.id || stop.code || '');
        const isTarget = stopIdentifier === String(targetStopId);
        const isMaresme = stop.zone === 'Zona Maresme' || (stop.lon && stop.lon >= 2.289);

        const markerHtml = `
          <div style="
            width: ${isTarget ? '22px' : '14px'};
            height: ${isTarget ? '22px' : '14px'};
            background-color: ${isTarget ? lineColor : isMaresme ? '#06b6d4' : '#f97316'};
            border: 2px solid #ffffff;
            border-radius: 50%;
            box-shadow: 0 0 10px ${isTarget ? lineColor : 'rgba(0,0,0,0.5)'};
            cursor: pointer;
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

        const popupContent = `
          <div style="font-family: sans-serif; min-width: 190px; padding: 6px;">
            <strong style="font-size: 13px; color: #0f172a; display:block; margin-bottom:2px;">${stop.name}</strong>
            ${isTarget ? `<div style="color: ${lineColor}; font-weight: 700; font-size: 11px; margin-bottom: 4px;">⭐ PARADA PRINCIPAL</div>` : ''}
            <div style="font-size: 11px; color: #64748b; margin-bottom: 6px;">
              Seq: <strong>#${stop.seq || index + 1}</strong> • Zona: <strong>${stop.zone || (isMaresme ? 'Maresme' : 'AMB')}</strong>${stop.code ? ` • Codi: <strong>${stop.code}</strong>` : ''}
            </div>
            <div style="display:flex; flex-direction:column; gap:4px;">
              <button onclick="window.c10App.inspectStop('${stopIdentifier}', '${stop.name.replace(/'/g, "\\'")}')" style="width: 100%; background: ${lineColor}; color: #fff; border: none; padding: 5px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; cursor: pointer;">Veure temps d'arribada</button>
              ${!isTarget ? `<button onclick="window.c10App.setTargetStop('${stopIdentifier}')" style="width: 100%; background: #f1f5f9; color: #0f172a; border: 1px solid #cbd5e1; padding: 4px 8px; border-radius: 4px; font-size: 10.5px; font-weight: 600; cursor: pointer;">⭐ Fixar com a parada principal</button>` : ''}
            </div>
          </div>
        `;

        marker.bindPopup(popupContent);

        if (onStopClick) {
          marker.on('click', () => onStopClick(stop));
        }

        this.stopMarkers.push(marker);
      });

      // Save polyline coordinates
      this.activePolylineCoords = (customPolyline && customPolyline.length > 1) ? customPolyline : latLngs;

      if (this.activePolylineCoords.length > 1) {
        this.routePolyline = L.polyline(this.activePolylineCoords, {
          color: lineColor || '#009485',
          weight: 4,
          opacity: 0.85,
          lineCap: 'round',
          lineJoin: 'round'
        }).addTo(this.map);

        if (shouldFitBounds) {
          this.map.fitBounds(this.routePolyline.getBounds(), { padding: [30, 30] });
        }
      }

      this.lastStopsFingerprint = stopsFingerprint;
    }
  }

  // Update active bus markers and attach road subpaths
  updateBusMarkers(activeBuses, lineColor = '#009485') {
    if (!this.map) return;

    const currentTripIds = new Set(activeBuses.map(b => b.tripId));

    // Remove old buses not active anymore
    for (const [tId, obj] of this.busMarkersMap.entries()) {
      if (!currentTripIds.has(tId)) {
        this.map.removeLayer(obj.marker);
        this.busMarkersMap.delete(tId);
      }
    }

    activeBuses.forEach(bus => {
      if (!bus.lat || !bus.lon) return;

      // 1. Street-Snapping: Snap raw GPS strictly to the road polyline
      let snapped = { lat: bus.lat, lon: bus.lon, bearing: bus.bearing || 0 };
      if (this.activePolylineCoords && this.activePolylineCoords.length > 1) {
        snapped = this.snapToPolyline(bus.lat, bus.lon, this.activePolylineCoords);
      }

      // 2. Extract road subpath between fromCoords and toCoords
      let subpath = null;
      if (bus.fromCoords && bus.toCoords && this.activePolylineCoords && this.activePolylineCoords.length > 1) {
        subpath = this.extractSubpath(this.activePolylineCoords, bus.fromCoords.lat, bus.fromCoords.lon, bus.toCoords.lat, bus.toCoords.lon);
      }

      const bearingAngle = snapped.bearing || bus.bearing || 0;
      const compassLabel = bus.compass?.label || '';
      const speedText = bus.speedKmh ? `${bus.speedKmh} km/h` : (bus.isTerminalLayover ? '0 km/h (Aturat)' : '30-40 km/h');
      const coordsText = `${snapped.lat.toFixed(5)}° N, ${snapped.lon.toFixed(5)}° E`;
      const isEst = Boolean(bus.isEstimated);

      const popupHtml = bus.isTerminalLayover ? `
        <div style="font-family: sans-serif; min-width: 220px; padding: 6px;">
          <div style="display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid #e2e8f0; padding-bottom:4px; margin-bottom:6px;">
            <strong style="color:#0f172a; font-size:13px;">🅿️ Bus en Regulació</strong>
            <span style="background:#dbeafe; color:#1d4ed8; font-size:10px; font-weight:700; padding:1px 5px; border-radius:3px;">A CAPÇALERA</span>
          </div>
          <div style="font-size:12px; color:#2563eb; font-weight:700; margin-bottom:4px;">
            📍 ${bus.fromStop}
          </div>
          <div style="font-size:11px; color:#64748b; line-height:1.5;">
            📍 Coord: <strong style="color:#0f172a;">${coordsText}</strong><br>
            ⏱️ Estat: <strong>Aturat en espera</strong><br>
            🔄 Vehicle: <strong>#${bus.vehicleId || 'Bus'}</strong>
          </div>
        </div>
      ` : `
        <div style="font-family: sans-serif; min-width: 210px; padding: 6px;">
          <div style="display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid #e2e8f0; padding-bottom:4px; margin-bottom:6px;">
            <strong style="color:#0f172a; font-size:13px;">🚌 Bus ${bus.vehicleId ? `#${bus.vehicleId}` : ''}</strong>
            <span style="background:${isEst ? '#fef3c7' : '#dcfce7'}; color:${isEst ? '#b45309' : '#15803d'}; font-size:10px; font-weight:700; padding:1px 5px; border-radius:3px;">
              ${isEst ? '⚡ ESTIMACIÓ ZONA' : '🟢 GPS DIRECTE'}
            </span>
          </div>
          <div style="font-size:12px; color:${lineColor}; font-weight:700; margin-bottom:4px;">
            ${bus.fromStop} ➔ ${bus.toStop}
          </div>
          <div style="font-size:11px; color:#64748b; line-height:1.5;">
            📍 Coord: <strong style="color:#0f172a;">${coordsText}</strong><br>
            🧭 Rumb: <strong>${compassLabel} (${bearingAngle}°)</strong><br>
            ⚡ Velocitat: <strong>${speedText}</strong><br>
            ⏱️ Progrés trajecte: <strong>${bus.totalProgress || 0}%</strong><br>
            ${bus.delayFormatted ? `🚦 Puntualitat: <strong>${bus.delayFormatted}</strong>` : ''}
          </div>
        </div>
      `;

      if (this.busMarkersMap.has(bus.tripId)) {
        const obj = this.busMarkersMap.get(bus.tripId);
        obj.busData = bus;
        obj.subpath = subpath;
        obj.currentBearing = bearingAngle;
        obj.marker.setPopupContent(popupHtml);

        if (bus.isTerminalLayover) {
          obj.marker.setLatLng([snapped.lat, snapped.lon]);
        }

        const el = obj.marker.getElement();
        if (el) {
          const pin = el.querySelector('.live-bus-pin');
          if (pin) {
            if (bus.isTerminalLayover) {
              pin.style.background = 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)';
              pin.textContent = '🅿️';
            } else {
              pin.style.transform = `rotate(${bearingAngle}deg)`;
            }
          }
        }
      } else {
        const pinBg = isEst
          ? 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)'
          : (lineColor || 'linear-gradient(135deg, #10b981 0%, #059669 100%)');

        const busHtml = bus.isTerminalLayover ? `
          <div class="live-bus-pin layover" style="
            background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
            color: #fff;
            width: 36px;
            height: 36px;
            border-radius: 50%;
            border: 2.5px solid #ffffff;
            box-shadow: 0 4px 14px rgba(59, 130, 246, 0.7);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 16px;
            position: relative;
          ">
            🅿️
          </div>
        ` : `
          <div class="live-bus-pin" style="
            background: ${pinBg};
            color: #fff;
            width: 36px;
            height: 36px;
            border-radius: 50%;
            border: 2.5px solid #ffffff;
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 16px;
            transition: transform 0.2s ease;
            transform: rotate(${bearingAngle}deg);
            position: relative;
          ">
            🚌
            <span style="
              position: absolute;
              top: -6px;
              right: -6px;
              width: 12px;
              height: 12px;
              background: ${isEst ? '#fbbf24' : '#38bdf8'};
              border: 1.5px solid #fff;
              border-radius: 50%;
              box-shadow: 0 0 8px ${isEst ? '#fbbf24' : '#38bdf8'};
            "></span>
          </div>
        `;

        const busIcon = L.divIcon({
          html: busHtml,
          className: 'c10-live-bus-icon',
          iconSize: [36, 36],
          iconAnchor: [18, 18]
        });

        const marker = L.marker([snapped.lat, snapped.lon], {
          icon: busIcon,
          zIndexOffset: 2000
        }).addTo(this.map);

        marker.bindPopup(popupHtml);
        this.busMarkersMap.set(bus.tripId, {
          marker,
          busData: bus,
          subpath,
          currentBearing: bearingAngle
        });
      }
    });
  }

  // Smooth continuous client-side gliding strictly along road subpath (never cuts through buildings)
  stepBusAnimation(nowSec) {
    for (const [tId, obj] of this.busMarkersMap.entries()) {
      const bus = obj.busData;
      if (!bus) continue;

      let lat = null;
      let lon = null;
      let bearing = null;

      // 1. If parked in terminal layover, stay exactly at terminal
      if (bus.isTerminalLayover) {
        lat = bus.lat;
        lon = bus.lon;
        bearing = bus.bearing || 0;
      }
      // 2. Road Subpath Follower: Glides along the exact road polyline segments (street curves)
      else if (obj.subpath && obj.subpath.length > 1 && bus.segStartSec && bus.segEndSec) {
        const duration = Math.max(1, bus.segEndSec - bus.segStartSec);
        const rawProgress = (nowSec - bus.segStartSec) / duration;
        const progress = Math.max(0, Math.min(0.99, rawProgress));
        
        const pt = this.interpolateAlongSubpath(obj.subpath, progress);
        if (pt) {
          lat = pt.lat;
          lon = pt.lon;
          bearing = pt.bearing;
        }
      }
      // 3. Fallback: Snap current GPS coordinate to polyline
      else if (bus.lat && bus.lon) {
        const snapped = this.snapToPolyline(bus.lat, bus.lon, this.activePolylineCoords);
        lat = snapped.lat;
        lon = snapped.lon;
        bearing = snapped.bearing || bus.bearing || 0;
      }

      if (lat !== null && lon !== null) {
        const currentPos = obj.marker.getLatLng();
        if (currentPos && (Math.abs(currentPos.lat - lat) > 0.000001 || Math.abs(currentPos.lng - lon) > 0.000001)) {
          // Smooth 40% LERP step for continuous organic motion
          const smoothLat = currentPos.lat + (lat - currentPos.lat) * 0.4;
          const smoothLon = currentPos.lng + (lon - currentPos.lng) * 0.4;
          obj.marker.setLatLng([smoothLat, smoothLon]);
        } else if (!currentPos) {
          obj.marker.setLatLng([lat, lon]);
        }

        // Dynamically rotate bus pin to match the street direction
        if (bearing !== null && !bus.isTerminalLayover) {
          const el = obj.marker.getElement();
          if (el) {
            const pin = el.querySelector('.live-bus-pin');
            if (pin) {
              pin.style.transform = `rotate(${bearing}deg)`;
            }
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

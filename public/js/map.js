// Leaflet Map Module for Line C-10 Tracker
class C10Map {
  constructor(containerId) {
    this.containerId = containerId;
    this.map = null;
    this.stopMarkers = [];
    this.busMarkersMap = new Map(); // tripId -> { marker, busData }
    this.routePolyline = null;
    this.lastStopsFingerprint = null;
    this.initMap();
  }

  initMap() {
    if (typeof L === 'undefined') {
      console.warn('Leaflet not loaded yet.');
      return;
    }

    // Centered along the Barcelona <-> Mataró coastal corridor
    this.map = L.map(this.containerId, {
      zoomControl: true,
      scrollWheelZoom: true
    }).setView([41.49, 2.33], 12);

    // High quality modern tile layer (CartoDB Voyager)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      subdomains: 'abcd',
      maxZoom: 19
    }).addTo(this.map);
  }

  renderStops(stops, targetStopMouteId = '10037202', onStopClick = null, shouldFitBounds = false) {
    if (!this.map) return;

    const stopsFingerprint = `${stops.length}_${targetStopMouteId}`;
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

        const isTarget = stop.mouteStopId === targetStopMouteId;
        const isMaresme = stop.lon ? stop.lon >= 2.289 : (stop.name && (stop.name.toLowerCase().includes('mataró') || stop.name.toLowerCase().includes('itàlia') || stop.name.toLowerCase().includes('masnou') || stop.name.toLowerCase().includes('premià') || stop.name.toLowerCase().includes('vilassar')));

        const markerHtml = `
          <div style="
            width: ${isTarget ? '22px' : '14px'};
            height: ${isTarget ? '22px' : '14px'};
            background-color: ${isTarget ? '#009485' : isMaresme ? '#06b6d4' : '#f97316'};
            border: 2px solid #ffffff;
            border-radius: 50%;
            box-shadow: 0 0 10px ${isTarget ? 'rgba(0,148,133,0.9)' : 'rgba(0,0,0,0.5)'};
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
            ${isTarget ? '<div style="color: #009485; font-weight: 700; font-size: 11px; margin-bottom: 4px;">⭐ PARADA PRINCIPAL</div>' : ''}
            <div style="font-size: 11px; color: #64748b; margin-bottom: 6px;">
              Seq: <strong>#${stop.seq}</strong> • Zona: <strong>${isMaresme ? 'Maresme' : 'AMB'}</strong>${stop.code ? ` • Codi: <strong>${stop.code}</strong>` : ''}
            </div>
            <div style="display:flex; flex-direction:column; gap:4px;">
              ${stop.mouteStopId ? `<button onclick="window.c10App.inspectStop('${stop.mouteStopId}', '${stop.name}')" style="width: 100%; background: #009485; color: #fff; border: none; padding: 5px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; cursor: pointer;">Veure temps d'arribada</button>` : ''}
              ${!isTarget && stop.mouteStopId ? `<button onclick="window.c10App.setTargetStop('${stop.mouteStopId}')" style="width: 100%; background: #f1f5f9; color: #0f172a; border: 1px solid #cbd5e1; padding: 4px 8px; border-radius: 4px; font-size: 10.5px; font-weight: 600; cursor: pointer;">⭐ Fixar com a parada principal</button>` : ''}
            </div>
          </div>
        `;

        marker.bindPopup(popupContent);

        if (onStopClick) {
          marker.on('click', () => onStopClick(stop));
        }

        this.stopMarkers.push(marker);
      });

      if (latLngs.length > 1) {
        this.routePolyline = L.polyline(latLngs, {
          color: '#009485',
          weight: 4,
          opacity: 0.85,
          dashArray: '1, 6',
          lineCap: 'round'
        }).addTo(this.map);

        if (shouldFitBounds) {
          this.map.fitBounds(this.routePolyline.getBounds(), { padding: [30, 30] });
        }
      }

      this.lastStopsFingerprint = stopsFingerprint;
    }
  }

  updateBusMarkers(activeBuses) {
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

      const bearingAngle = bus.bearing || 0;
      const compassLabel = bus.compass?.label || '';
      const speedText = bus.speedKmh ? `${bus.speedKmh} km/h` : (bus.isTerminalLayover ? '0 km/h (Aturat)' : '35-45 km/h');
      const coordsText = bus.coordinatesFormatted || `${bus.lat.toFixed(5)}° N, ${bus.lon.toFixed(5)}° E`;

      const popupHtml = bus.isTerminalLayover ? `
        <div style="font-family: sans-serif; min-width: 220px; padding: 6px;">
          <div style="display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid #e2e8f0; padding-bottom:4px; margin-bottom:6px;">
            <strong style="color:#0f172a; font-size:13px;">🅿️ Bus C-10 en Regulació</strong>
            <span style="background:#dbeafe; color:#1d4ed8; font-size:10px; font-weight:700; padding:1px 5px; border-radius:3px;">A CAPÇALERA</span>
          </div>
          <div style="font-size:12px; color:#2563eb; font-weight:700; margin-bottom:4px;">
            📍 ${bus.fromStop}
          </div>
          <div style="font-size:11px; color:#64748b; line-height:1.5;">
            📍 Coord: <strong style="color:#0f172a;">${coordsText}</strong><br>
            ⏱️ Estat: <strong>${bus.currentSegmentTime}</strong><br>
            🔄 Esperant inici del proper viatge de tornada.
          </div>
        </div>
      ` : `
        <div style="font-family: sans-serif; min-width: 210px; padding: 6px;">
          <div style="display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid #e2e8f0; padding-bottom:4px; margin-bottom:6px;">
            <strong style="color:#0f172a; font-size:13px;">🚌 Bus C-10 en directe</strong>
            <span style="background:#dcfce7; color:#15803d; font-size:10px; font-weight:700; padding:1px 5px; border-radius:3px;">GPS RECONSTRUÏT</span>
          </div>
          <div style="font-size:12px; color:#009485; font-weight:700; margin-bottom:4px;">
            ${bus.fromStop} ➔ ${bus.toStop}
          </div>
          <div style="font-size:11px; color:#64748b; line-height:1.5;">
            📍 Coord: <strong style="color:#0f172a;">${coordsText}</strong><br>
            🧭 Rumb: <strong>${compassLabel} (${bearingAngle}°)</strong><br>
            ⚡ Velocitat: <strong>~${speedText}</strong><br>
            ⏱️ Progrés trajecte: <strong>${bus.totalProgress}%</strong>
          </div>
        </div>
      `;

      if (this.busMarkersMap.has(bus.tripId)) {
        const obj = this.busMarkersMap.get(bus.tripId);
        obj.busData = bus;
        obj.marker.setLatLng([bus.lat, bus.lon]);
        obj.marker.setPopupContent(popupHtml);

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
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            color: #fff;
            width: 36px;
            height: 36px;
            border-radius: 50%;
            border: 2.5px solid #ffffff;
            box-shadow: 0 4px 14px rgba(16, 185, 129, 0.7);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 16px;
            transition: transform 0.4s ease;
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
              background: #38bdf8;
              border: 1.5px solid #fff;
              border-radius: 50%;
              box-shadow: 0 0 8px #38bdf8;
            "></span>
          </div>
        `;

        const busIcon = L.divIcon({
          html: busHtml,
          className: 'c10-live-bus-icon',
          iconSize: [36, 36],
          iconAnchor: [18, 18]
        });

        const marker = L.marker([bus.lat, bus.lon], {
          icon: busIcon,
          zIndexOffset: 2000
        }).addTo(this.map);

        marker.bindPopup(popupHtml);
        this.busMarkersMap.set(bus.tripId, { marker, busData: bus });
      }
    });
  }

  // Smooth client-side per-second interpolation across all stops
  stepBusAnimation(nowSec) {
    for (const [tId, obj] of this.busMarkersMap.entries()) {
      const bus = obj.busData;
      if (!bus) continue;

      let lat = null;
      let lon = null;
      let bearing = bus.bearing || 0;

      if (bus.allStops && bus.allStops.length >= 2) {
        for (let i = 0; i < bus.allStops.length - 1; i++) {
          const s1 = bus.allStops[i];
          const s2 = bus.allStops[i + 1];
          if (nowSec >= s1.depSec && (nowSec < s2.arrSec || i === bus.allStops.length - 2)) {
            const segDuration = Math.max(1, s2.arrSec - s1.depSec);
            const progress = Math.max(0, Math.min(1, (nowSec - s1.depSec) / segDuration));
            lat = s1.lat + progress * (s2.lat - s1.lat);
            lon = s1.lon + progress * (s2.lon - s1.lon);
            break;
          }
        }
      }

      if (lat === null && bus.fromCoords && bus.toCoords && bus.segStartSec && bus.segEndSec) {
        const duration = Math.max(1, bus.segEndSec - bus.segStartSec);
        const progress = Math.max(0, Math.min(1, (nowSec - bus.segStartSec) / duration));
        lat = bus.fromCoords.lat + progress * (bus.toCoords.lat - bus.fromCoords.lat);
        lon = bus.fromCoords.lon + progress * (bus.toCoords.lon - bus.fromCoords.lon);
      }

      if (lat !== null && lon !== null) {
        obj.marker.setLatLng([lat, lon]);
      }
    }
  }

  focusTargetStop(lat = 41.5468674, lon = 2.4321194) {
    if (!this.map) return;
    this.map.flyTo([lat, lon], 15, { duration: 1.2 });
  }

  invalidateSize() {
    if (!this.map) return;
    this.map.invalidateSize();
  }
}

window.C10Map = C10Map;

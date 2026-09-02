/**
 * Plan.js — Dedicated Journey Planner Client Controller for Arribo!
 */
class PlannerPageApp {
  constructor() {
    this.mapController = null;
    this.currentItineraries = [];
    this.activeItineraryIndex = 0;
    this.searchAbortController = null;
    this.init();
  }

  async init() {
    this.initTheme();
    this.initMap();
    this.bindEvents();
    this.checkUrlParams();
  }

  initTheme() {
    const savedTheme = localStorage.getItem('transit-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    const btnTheme = document.getElementById('btn-page-theme-toggle');
    if (btnTheme) {
      btnTheme.addEventListener('click', () => {
        const cur = document.documentElement.getAttribute('data-theme') || 'dark';
        const next = cur === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('transit-theme', next);
        if (this.mapController) {
          this.mapController.setTheme(next);
        }
      });
    }
  }

  initMap() {
    try {
      this.mapController = new C10Map('plan-map');
    } catch (err) {
      console.error('Error initializing map:', err);
    }
  }

  bindEvents() {
    const originInput = document.getElementById('page-planner-origin');
    const destInput = document.getElementById('page-planner-dest');
    const searchBtn = document.getElementById('btn-page-planner-search');
    const swapBtn = document.getElementById('btn-page-planner-swap');
    const gpsBtn = document.getElementById('btn-page-planner-gps');

    if (originInput) {
      this.setupAutocomplete(originInput, document.getElementById('page-planner-origin-dropdown'));
      originInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.runSearch(); });
    }

    if (destInput) {
      this.setupAutocomplete(destInput, document.getElementById('page-planner-dest-dropdown'));
      destInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.runSearch(); });
    }

    if (searchBtn) {
      searchBtn.addEventListener('click', () => this.runSearch());
    }

    if (swapBtn) {
      swapBtn.addEventListener('click', () => {
        if (!originInput || !destInput) return;
        const tmp = originInput.value;
        originInput.value = destInput.value;
        destInput.value = tmp;
        if (originInput.value && destInput.value) {
          this.runSearch();
        }
      });
    }

    if (gpsBtn) {
      gpsBtn.addEventListener('click', () => this.handleGpsLocation());
    }

    // Presets
    document.querySelectorAll('.plan-preset-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const stopName = btn.getAttribute('data-stop');
        if (destInput) {
          destInput.value = stopName;
          if (originInput && originInput.value.trim()) {
            this.runSearch();
          } else if (originInput) {
            originInput.focus();
          }
        }
      });
    });
  }

  checkUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const from = params.get('from') || params.get('origin');
    const to = params.get('to') || params.get('dest') || params.get('destination');
    const itin = params.get('itin');
    const itinIdx = itin !== null && !isNaN(parseInt(itin, 10)) ? parseInt(itin, 10) : 0;

    const originInput = document.getElementById('page-planner-origin');
    const destInput = document.getElementById('page-planner-dest');

    if (from && originInput) originInput.value = from;
    if (to && destInput) destInput.value = to;

    if (from && to) {
      this.runSearch(itinIdx);
    }
  }

  setupAutocomplete(inputElem, dropdownElem) {
    if (!inputElem || !dropdownElem) return;
    let debounceTimer = null;

    const closeDropdown = () => {
      dropdownElem.style.display = 'none';
    };

    inputElem.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      delete inputElem.dataset.stopId;
      delete inputElem.dataset.direction;
      const query = inputElem.value.trim();
      if (query.length < 2) {
        closeDropdown();
        return;
      }

      debounceTimer = setTimeout(async () => {
        try {
          const res = await fetch(`/api/search/stops?q=${encodeURIComponent(query)}`);
          if (!res.ok) return;
          const data = await res.json();
          const stops = Array.isArray(data.stops) ? data.stops.slice(0, 8) : [];

          if (stops.length === 0) {
            dropdownElem.innerHTML = '<div class="planner-dropdown-item" style="color:var(--text-muted); cursor:default;">No s\'han trobat parades</div>';
          } else {
            dropdownElem.innerHTML = stops.map(s => `
              <div class="planner-dropdown-item" data-stop-name="${this.esc(s.name)}" data-stop-id="${this.esc(s.id)}" data-direction="${this.esc(s.directionText || '')}">
                <div style="display:flex; flex-direction:column; gap:2px;">
                  <div style="font-weight:700; color:var(--text-primary); font-size:0.9rem;">${this.esc(s.name)}</div>
                  ${s.directionText ? `
                    <div style="font-size:0.75rem; color:#38bdf8; font-weight:600; display:flex; align-items:center; gap:4px;">
                      <span>➔</span> <span>${this.esc(s.directionText)}</span>
                    </div>
                  ` : ''}
                </div>
                <div style="text-align:right; display:flex; flex-direction:column; align-items:flex-end; gap:2px;">
                  <span style="font-size:0.72rem; color:var(--text-secondary); background:rgba(255,255,255,0.06); padding:2px 6px; border-radius:4px; font-family:var(--font-mono);">#${this.esc(s.code || s.id)}</span>
                  <span style="font-size:0.7rem; color:var(--text-muted);">${this.esc(s.zone || 'Mataró')}</span>
                </div>
              </div>
            `).join('');
          }
          dropdownElem.style.display = 'block';
        } catch (err) {
          closeDropdown();
        }
      }, 180);
    });

    dropdownElem.addEventListener('click', (e) => {
      const item = e.target.closest('.planner-dropdown-item');
      if (item && item.dataset.stopName) {
        inputElem.value = item.dataset.direction 
          ? `${item.dataset.stopName} (${item.dataset.direction})` 
          : item.dataset.stopName;
        inputElem.dataset.stopId = item.dataset.stopId || '';
        if (item.dataset.direction) {
          inputElem.dataset.direction = item.dataset.direction;
        }
        closeDropdown();
      }
    });

    // Close when clicking outside
    document.addEventListener('click', (e) => {
      if (!inputElem.contains(e.target) && !dropdownElem.contains(e.target)) {
        closeDropdown();
      }
    });

    // Close when window loses focus (e.g. clicking another app/window)
    window.addEventListener('blur', closeDropdown);

    // Close when switching browser tabs
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) closeDropdown();
    });

    // Close on blur (delayed so click events on dropdown items register first)
    inputElem.addEventListener('blur', () => {
      setTimeout(closeDropdown, 220);
    });

    // Close on Escape key
    inputElem.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeDropdown();
      }
    });
  }

  handleGpsLocation() {
    if (!navigator.geolocation) {
      alert('La geolocalització no està disponible al teu navegador.');
      return;
    }

    const gpsBtn = document.getElementById('btn-page-planner-gps');
    if (gpsBtn) gpsBtn.innerHTML = '<span>⏳...</span>';

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const lat = pos.coords.latitude;
          const lon = pos.coords.longitude;
          const res = await fetch(`/api/search/stops?lat=${lat}&lon=${lon}`);
          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data.stops) && data.stops.length > 0) {
              const nearest = data.stops[0];
              const originInput = document.getElementById('page-planner-origin');
              if (originInput) {
                originInput.value = nearest.name;
              }
            }
          }
        } catch (_) {}
        if (gpsBtn) gpsBtn.innerHTML = '<span>📍 GPS</span>';
      },
      () => {
        alert("No s'ha pogut obtenir la teva ubicació.");
        if (gpsBtn) gpsBtn.innerHTML = '<span>📍 GPS</span>';
      },
      { timeout: 8000, enableHighAccuracy: true }
    );
  }

  async runSearch(targetIndex = 0) {
    const originEl = document.getElementById('page-planner-origin');
    const destEl = document.getElementById('page-planner-dest');
    const originVal = originEl?.value.trim();
    const destVal = destEl?.value.trim();
    const resultsContainer = document.getElementById('page-planner-results');
    if (!resultsContainer) return;

    if (!originVal || !destVal) {
      alert("Si us plau, especifica tant la parada d'origen com la de destinació.");
      return;
    }

    resultsContainer.innerHTML = `
      <div style="text-align:center; padding:3rem 1rem;">
        <div style="font-size:2rem; animation:spin 1s infinite linear; display:inline-block;">⏱️</div>
        <div style="margin-top:0.75rem; font-weight:700; color:var(--text-primary);">Calculant les millors connexions...</div>
      </div>
    `;

    try {
      const fromQuery = originEl?.dataset?.stopId || originVal.replace(/\s*\([^)]*\)$/, '').trim();
      const toQuery = destEl?.dataset?.stopId || destVal.replace(/\s*\([^)]*\)$/, '').trim();
      const res = await fetch(`/api/mataro/plan?from=${encodeURIComponent(fromQuery)}&to=${encodeURIComponent(toQuery)}`);
      const data = await res.json();

      if (!res.ok || !data.success) {
        resultsContainer.innerHTML = `
          <div style="text-align:center; padding:2.5rem 1rem; color:#ef4444;">
            <div style="font-size:2rem; margin-bottom:0.5rem;">⚠️</div>
            <div style="font-weight:700; margin-bottom:0.25rem;">No s'ha pogut calcular la ruta</div>
            <div style="font-size:0.85rem; color:var(--text-secondary);">${this.esc(data.error || 'Verifica els noms de les parades.')}</div>
          </div>
        `;
        return;
      }

      this.currentItineraries = data.itineraries || [];
      if (this.currentItineraries.length === 0) {
        resultsContainer.innerHTML = `
          <div style="text-align:center; padding:2.5rem 1rem; color:var(--text-secondary);">
            <div style="font-size:2rem; margin-bottom:0.5rem;">🔍</div>
            <div style="font-weight:700; margin-bottom:0.25rem;">Cap connexió trobada</div>
            <div style="font-size:0.85rem;">${this.esc(data.message || 'No hi ha combinació directa o amb 1 sol transbordament entre aquestes parades.')}</div>
          </div>
        `;
        if (this.mapController && typeof this.mapController.clearItinerary === 'function') {
          this.mapController.clearItinerary();
        }
        return;
      }

      // Render Itineraries
      this.renderItineraries(this.currentItineraries, data.originStop, data.destStop);

      // Select target itinerary and paint on map
      const selectIdx = (targetIndex >= 0 && targetIndex < this.currentItineraries.length) ? targetIndex : 0;
      this.selectItinerary(selectIdx);

      // Update URL without reload
      const newUrl = `${window.location.pathname}?from=${encodeURIComponent(origin)}&to=${encodeURIComponent(dest)}&itin=${selectIdx}`;
      window.history.replaceState({}, '', newUrl);

    } catch (err) {
      console.error('Plan search error:', err);
      resultsContainer.innerHTML = `
        <div style="text-align:center; padding:2rem 1rem; color:#ef4444;">
          Error de connexió al calcular la ruta.
        </div>
      `;
    }
  }

  renderItineraries(itineraries, originStop, destStop) {
    const container = document.getElementById('page-planner-results');
    if (!container) return;

    container.innerHTML = `
      <div style="font-size:0.82rem; color:var(--text-muted); font-weight:700; margin-bottom:4px;">
        ${itineraries.length} ${itineraries.length === 1 ? 'OPCIÓ TROBADA' : 'OPCIONS TROBADES'}:
      </div>
      ${itineraries.map((it, idx) => {
        const isDirect = it.type === 'direct';
        const firstLeg = it.legs[0];
        const waitMin = Number.isFinite(firstLeg?.nextDepartureMins) 
          ? firstLeg.nextDepartureMins 
          : (Number.isFinite(it.nextDepartureMinutes) 
              ? it.nextDepartureMinutes 
              : (Number.isFinite(it.nextDepartureMins) ? it.nextDepartureMins : null));
        const waitText = Number.isFinite(waitMin) ? ` • Surt en ${waitMin} min` : '';

        return `
          <div class="planner-itinerary-card ${idx === 0 ? 'plan-itinerary-active' : ''}" data-itinerary-index="${idx}" style="cursor:pointer;">
            <div class="planner-card-header">
              <div class="planner-total-duration">
                <span>⏱️ ~${it.totalDurationMins} min</span>
                <span style="font-size:0.85rem; font-weight:600; color:var(--text-secondary);">${waitText}</span>
              </div>
              <span class="${isDirect ? 'planner-tag-direct' : 'planner-tag-transfer'}">
                ${isDirect ? '✓ Ruta Directa' : '🔄 1 Transbordament'}
              </span>
            </div>

            <div class="planner-legs-flow">
              ${it.legs.map((leg, lIdx) => {
                const destText = leg.destination || (leg.toStop && leg.toStop.name) || '';
                return `
                  <div class="planner-leg-item">
                    <div>
                      <div style="display:flex; align-items:center; gap:6px; margin-bottom:2px;">
                        <span class="planner-leg-badge" style="background:${leg.lineColor || '#009485'};">
                          ${this.esc(leg.lineCode)}
                        </span>
                        <span style="font-size:0.85rem; font-weight:700; color:var(--text-primary);">
                          ${destText ? `Cap a ${this.esc(destText)}` : ''}
                        </span>
                      </div>
                      <div style="font-size:0.82rem; color:var(--text-secondary); margin-top:3px;">
                        🟢 Pujar a: <strong>${this.esc(leg.fromStop.name)}</strong>
                      </div>
                      <div style="font-size:0.82rem; color:var(--text-secondary);">
                        ${lIdx === it.legs.length - 1 ? '🏁' : '🔄'} Baixar a: <strong>${this.esc(leg.toStop.name)}</strong> (${leg.stopsCount || leg.stopCount} parades, ~${leg.travelTimeMins || leg.durationMinutes} min)
                      </div>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>

            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:0.75rem; border-top:1px solid var(--border-subtle); padding-top:0.6rem;">
              <span style="font-size:0.75rem; color:var(--text-muted); font-weight:600;">
                ${idx === this.activeItineraryIndex ? '📍 Mostrant al mapa' : 'Fes clic per veure la ruta al mapa'}
              </span>
              <button type="button" class="btn-primary" style="padding:0.35rem 0.75rem; font-size:0.8rem; pointer-events:none;">
                <span>🗺️ Veure ruta</span>
              </button>
            </div>
          </div>
        `;
      }).join('')}
    `;

    // Click on cards
    container.querySelectorAll('.planner-itinerary-card').forEach(card => {
      card.addEventListener('click', () => {
        const idx = parseInt(card.getAttribute('data-itinerary-index'), 10);
        if (!isNaN(idx)) {
          this.selectItinerary(idx);
        }
      });
    });
  }

  selectItinerary(index) {
    if (!this.currentItineraries[index]) return;
    this.activeItineraryIndex = index;

    // Highlight active card
    document.querySelectorAll('.planner-itinerary-card').forEach((c, idx) => {
      if (idx === index) {
        c.classList.add('plan-itinerary-active');
      } else {
        c.classList.remove('plan-itinerary-active');
      }
    });

    const it = this.currentItineraries[index];
    if (this.mapController && typeof this.mapController.renderItinerary === 'function') {
      this.mapController.renderItinerary(it);
    }
  }

  esc(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.plannerApp = new PlannerPageApp();
});

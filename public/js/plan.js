/**
 * Plan.js — Dedicated Journey Planner Client Controller for Arribo!
 */
class PlannerPageApp {
  constructor() {
    window.planApp = this;
    this.mapController = null;
    this.currentItineraries = [];
    this.activeItineraryIndex = 0;
    this.selectedPreference = 'fastest';
    this.timeMode = 'now';
    this.guideSteps = [];
    this.currentGuideStepIdx = 0;
    this.searchAbortController = null;
    this.pollTimer = null;
    this.lastSearchUrl = null;
    this.lastOriginStop = null;
    this.lastDestStop = null;
    this.currentSheetState = 'split';
    this.init();
  }

  async init() {
    this.initTheme();
    this.initMap();
    this.bindEvents();
    this.checkUrlParams();

    // Suspend polling when tab is hidden, resume when visible
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.stopPolling();
      } else if (this.lastSearchUrl && this.currentItineraries.length > 0) {
        this.refreshLiveDepartures();
        this.startPolling();
      }
    });

    // Handle responsive window resize
    window.addEventListener('resize', () => {
      if (window.innerWidth > 768) {
        const form = document.getElementById('plan-search-form');
        const summary = document.getElementById('plan-trip-summary');
        if (form) form.style.display = 'block';
        if (summary) summary.style.display = 'none';
      }
    });
  }

  initTheme() {
    const savedTheme = (window.TransitUtils && typeof window.TransitUtils.getStoredTheme === 'function')
      ? window.TransitUtils.getStoredTheme()
      : (localStorage.getItem('arribo_theme') || localStorage.getItem('transit-theme') || 'dark');
    if (window.TransitUtils && typeof window.TransitUtils.setStoredTheme === 'function') {
      window.TransitUtils.setStoredTheme(savedTheme);
    } else {
      document.documentElement.setAttribute('data-theme', savedTheme);
    }
    const btnTheme = document.getElementById('btn-page-theme-toggle');
    if (btnTheme) {
      btnTheme.addEventListener('click', () => {
        const cur = document.documentElement.getAttribute('data-theme') || 'dark';
        const next = cur === 'dark' ? 'light' : 'dark';
        if (window.TransitUtils && typeof window.TransitUtils.setStoredTheme === 'function') {
          window.TransitUtils.setStoredTheme(next);
        } else {
          document.documentElement.setAttribute('data-theme', next);
          localStorage.setItem('arribo_theme', next);
          localStorage.setItem('transit-theme', next);
        }
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

    // Presets delegation
    const presetsContainer = document.querySelector('.plan-presets');
    if (presetsContainer) {
      presetsContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.plan-preset-chip');
        if (!btn) return;
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
    }

    // Preferences pills delegation
    const prefsGroup = document.getElementById('planner-prefs-group');
    if (prefsGroup) {
      prefsGroup.addEventListener('click', (e) => {
        const pill = e.target.closest('.plan-pref-pill');
        if (!pill) return;
        document.querySelectorAll('.plan-pref-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        this.selectedPreference = pill.dataset.pref || 'fastest';
        if (originInput && originInput.value.trim() && destInput && destInput.value.trim()) {
          this.runSearch();
        }
      });
    }

    // Departure time mode tabs
    const timeTabs = document.getElementById('planner-time-tabs');
    const timeInputs = document.getElementById('planner-time-inputs');
    const timeInputVal = document.getElementById('plan-time-val');
    const dateInputVal = document.getElementById('plan-date-val');

    // Default time & date inputs
    const nowD = new Date();
    if (timeInputVal && !timeInputVal.value) {
      const hh = String(nowD.getHours()).padStart(2, '0');
      const mm = String(nowD.getMinutes()).padStart(2, '0');
      timeInputVal.value = `${hh}:${mm}`;
    }
    if (dateInputVal && !dateInputVal.value) {
      const yyyy = nowD.getFullYear();
      const mm = String(nowD.getMonth() + 1).padStart(2, '0');
      const dd = String(nowD.getDate()).padStart(2, '0');
      dateInputVal.value = `${yyyy}-${mm}-${dd}`;
    }

    if (timeTabs) {
      timeTabs.addEventListener('click', (e) => {
        const tab = e.target.closest('.plan-time-tab');
        if (!tab) return;
        document.querySelectorAll('.plan-time-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.timeMode = tab.dataset.timeMode || 'now';
        if (timeInputs) {
          timeInputs.style.display = this.timeMode === 'future' ? 'block' : 'none';
        }
        if (originInput && originInput.value.trim() && destInput && destInput.value.trim()) {
          this.runSearch();
        }
      });
    }

    if (timeInputVal) {
      timeInputVal.addEventListener('change', () => {
        if (this.timeMode === 'future' && originInput && originInput.value.trim() && destInput && destInput.value.trim()) {
          this.runSearch();
        }
      });
    }
    if (dateInputVal) {
      dateInputVal.addEventListener('change', () => {
        if (this.timeMode === 'future' && originInput && originInput.value.trim() && destInput && destInput.value.trim()) {
          this.runSearch();
        }
      });
    }

    // Guided Navigation Sheet controls
    const btnCloseGuide = document.getElementById('btn-close-nav-guide');
    const btnNavPrev = document.getElementById('btn-nav-prev');
    const btnNavNext = document.getElementById('btn-nav-next');
    const guideModal = document.getElementById('nav-guide-modal');

    if (btnCloseGuide) {
      btnCloseGuide.addEventListener('click', () => this.closeGuidedNavigation());
    }
    if (btnNavPrev) {
      btnNavPrev.addEventListener('click', () => this.prevGuideStep());
    }
    if (btnNavNext) {
      btnNavNext.addEventListener('click', () => this.nextGuideStep());
    }
    if (guideModal) {
      guideModal.addEventListener('click', (e) => {
        if (e.target === guideModal) this.closeGuidedNavigation();
      });
    }

    // Itinerary cards container delegation (AGENTS.md §8 compliant)
    const resultsContainer = document.getElementById('page-planner-results');
    if (resultsContainer) {
      resultsContainer.addEventListener('click', (e) => {
        const btnGuide = e.target.closest('.btn-start-guided-nav');
        if (btnGuide) {
          e.stopPropagation();
          const idx = parseInt(btnGuide.getAttribute('data-itinerary-index'), 10);
          if (!isNaN(idx)) {
            this.startGuidedNavigation(idx);
          }
          return;
        }

        const card = e.target.closest('.planner-itinerary-card');
        if (!card) return;
        const idx = parseInt(card.getAttribute('data-itinerary-index'), 10);
        if (!isNaN(idx)) {
          this.selectItinerary(idx);
        }
      });
    }

    // Mobile Bottom Sheet Toggles
    const btnSheetMap = document.getElementById('btn-sheet-map');
    const btnSheetSplit = document.getElementById('btn-sheet-split');
    const btnSheetRoutes = document.getElementById('btn-sheet-routes');
    const sheetBar = document.getElementById('plan-sheet-bar');
    const floatingRoutesBtn = document.getElementById('btn-floating-routes');

    if (btnSheetMap) {
      btnSheetMap.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setSheetState('peek');
      });
    }

    if (btnSheetSplit) {
      btnSheetSplit.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setSheetState('split');
      });
    }

    if (btnSheetRoutes) {
      btnSheetRoutes.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setSheetState('expanded');
      });
    }

    if (sheetBar) {
      sheetBar.addEventListener('click', (e) => {
        if (e.target.closest('.sheet-toggle-btn')) return;
        if (this.currentSheetState === 'peek') {
          this.setSheetState('split');
        } else if (this.currentSheetState === 'split') {
          this.setSheetState('expanded');
        } else {
          this.setSheetState('split');
        }
      });
    }

    if (floatingRoutesBtn) {
      floatingRoutesBtn.addEventListener('click', () => {
        this.setSheetState('expanded');
      });
    }

    // Edit Trip Summary Button
    const btnTripEdit = document.getElementById('btn-trip-edit');
    const btnExpandSearch = document.getElementById('btn-expand-search');
    if (btnTripEdit) {
      btnTripEdit.addEventListener('click', () => this.toggleSearchForm(true));
    }
    if (btnExpandSearch) {
      btnExpandSearch.addEventListener('click', () => this.toggleSearchForm(true));
    }

    // Fade out scroll hint when scrolled
    const resultsArea = document.getElementById('page-planner-results');
    if (resultsArea) {
      resultsArea.addEventListener('scroll', () => {
        const hint = document.getElementById('plan-scroll-hint');
        if (hint && resultsArea.scrollTop > 30) {
          hint.style.opacity = '0';
        }
      }, { passive: true });
    }
  }

  setSheetState(state) {
    this.currentSheetState = state;
    const sidebar = document.getElementById('plan-sidebar');
    const btnMap = document.getElementById('btn-sheet-map');
    const btnSplit = document.getElementById('btn-sheet-split');
    const btnRoutes = document.getElementById('btn-sheet-routes');
    const floatBtn = document.getElementById('btn-floating-routes');

    if (sidebar) {
      sidebar.classList.remove('sheet-peek', 'sheet-split', 'sheet-expanded');
      sidebar.classList.add(`sheet-${state}`);
    }

    if (btnMap) btnMap.classList.toggle('active', state === 'peek');
    if (btnSplit) btnSplit.classList.toggle('active', state === 'split');
    if (btnRoutes) btnRoutes.classList.toggle('active', state === 'expanded');

    if (floatBtn) {
      floatBtn.style.display = (state === 'peek' && this.currentItineraries.length > 0) ? 'flex' : 'none';
    }

    if (this.mapController && this.mapController.map) {
      setTimeout(() => {
        try {
          this.mapController.map.invalidateSize();
        } catch (_) {}
      }, 320);
    }
  }

  toggleSearchForm(expand) {
    const summary = document.getElementById('plan-trip-summary');
    const form = document.getElementById('plan-search-form');
    if (!summary || !form) return;

    if (expand) {
      summary.style.display = 'none';
      form.style.display = 'block';
      if (window.innerWidth <= 768) {
        this.setSheetState('expanded');
      }
    } else {
      if (this.currentItineraries.length > 0 && window.innerWidth <= 768) {
        summary.style.display = 'flex';
        form.style.display = 'none';
      } else {
        summary.style.display = 'none';
        form.style.display = 'block';
      }
    }
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
      delete inputElem.dataset.lat;
      delete inputElem.dataset.lon;
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
          const stops = Array.isArray(data.stops) ? data.stops.slice(0, 6) : [];
          const streets = Array.isArray(data.streets) ? data.streets.slice(0, 4) : [];

          if (stops.length === 0 && streets.length === 0) {
            dropdownElem.innerHTML = '<div class="planner-dropdown-item" style="color:var(--text-muted); cursor:default;">No s\'han trobat parades ni carrers</div>';
          } else {
            let html = '';

            // 1. Bus Stops
            if (stops.length > 0) {
              html += stops.map(s => `
                <div class="planner-dropdown-item" data-type="stop" data-stop-name="${this.esc(s.name)}" data-stop-id="${this.esc(s.id)}" data-direction="${this.esc(s.directionText || '')}" data-lat="${s.lat || ''}" data-lon="${s.lon || ''}">
                  <div style="display:flex; flex-direction:column; gap:2px;">
                    <div style="font-weight:700; color:var(--text-primary); font-size:0.9rem; display:flex; align-items:center; gap:6px;">
                      <span style="color:#0ea5e9;">🚏</span> <span>${this.esc(s.name)}</span>
                    </div>
                    ${s.directionText ? `
                      <div style="font-size:0.75rem; color:#38bdf8; font-weight:600; display:flex; align-items:center; gap:4px; padding-left:1.35rem;">
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

            // 2. Streets & Addresses
            if (streets.length > 0) {
              html += streets.map(st => `
                <div class="planner-dropdown-item" data-type="street" data-stop-name="${this.esc(st.name)}" data-lat="${st.lat}" data-lon="${st.lon}" data-nearest-id="${this.esc(st.nearestStop?.id || '')}">
                  <div style="display:flex; flex-direction:column; gap:2px;">
                    <div style="font-weight:700; color:var(--text-primary); font-size:0.9rem; display:flex; align-items:center; gap:6px;">
                      <span style="color:#f59e0b;">🛣️</span> <span>${this.esc(st.name)}</span>
                    </div>
                    <div style="font-size:0.75rem; color:var(--text-muted); padding-left:1.35rem;">
                      ${this.esc(st.subtitle || `Carrer a ${st.cityName}`)}
                    </div>
                  </div>
                  <div style="text-align:right;">
                    <span style="font-size:0.72rem; color:#f59e0b; background:rgba(245,158,11,0.12); padding:2px 6px; border-radius:4px; font-weight:600;">Carrer</span>
                  </div>
                </div>
              `).join('');
            }

            dropdownElem.innerHTML = html;
          }
          dropdownElem.style.display = 'block';
        } catch (err) {
          closeDropdown();
        }
      }, 180);
    });

    dropdownElem.addEventListener('click', (e) => {
      const item = e.target.closest('.planner-dropdown-item');
      if (!item || !item.dataset.stopName) return;

      const isStreet = item.dataset.type === 'street';
      if (isStreet) {
        inputElem.value = item.dataset.stopName;
        inputElem.dataset.lat = item.dataset.lat || '';
        inputElem.dataset.lon = item.dataset.lon || '';
        inputElem.dataset.stopId = item.dataset.nearestId || '';
        delete inputElem.dataset.direction;
      } else {
        inputElem.value = item.dataset.direction 
          ? `${item.dataset.stopName} (${item.dataset.direction})` 
          : item.dataset.stopName;
        inputElem.dataset.stopId = item.dataset.stopId || '';
        if (item.dataset.lat && item.dataset.lon) {
          inputElem.dataset.lat = item.dataset.lat;
          inputElem.dataset.lon = item.dataset.lon;
        } else {
          delete inputElem.dataset.lat;
          delete inputElem.dataset.lon;
        }
        if (item.dataset.direction) {
          inputElem.dataset.direction = item.dataset.direction;
        }
      }
      closeDropdown();
    });

    // Global listeners registered once for autocomplete dropdowns
    if (!this._autocompleteGlobalBound) {
      this._autocompleteGlobalBound = true;
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.planner-input-wrapper, .planner-input-group, .planner-dropdown, .plan-search-box')) {
          document.querySelectorAll('.planner-dropdown').forEach(dd => {
            dd.style.display = 'none';
          });
        }
      });

      window.addEventListener('blur', () => {
        document.querySelectorAll('.planner-dropdown').forEach(dd => {
          dd.style.display = 'none';
        });
      });

      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          document.querySelectorAll('.planner-dropdown').forEach(dd => {
            dd.style.display = 'none';
          });
        }
      });
    }

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
                originInput.dataset.stopId = nearest.id;
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
      let url = `/api/mataro/plan?from=${encodeURIComponent(fromQuery)}&to=${encodeURIComponent(toQuery)}&fromName=${encodeURIComponent(originVal)}&toName=${encodeURIComponent(destVal)}&preference=${encodeURIComponent(this.selectedPreference || 'fastest')}`;
      if (this.timeMode === 'future') {
        const timeVal = document.getElementById('plan-time-val')?.value;
        const dateVal = document.getElementById('plan-date-val')?.value;
        if (timeVal) url += `&departureTime=${encodeURIComponent(timeVal)}`;
        if (dateVal) url += `&departureDate=${encodeURIComponent(dateVal)}`;
      }
      if (originEl?.dataset?.lat && originEl?.dataset?.lon) {
        url += `&fromLat=${originEl.dataset.lat}&fromLon=${originEl.dataset.lon}`;
      }
      if (destEl?.dataset?.lat && destEl?.dataset?.lon) {
        url += `&toLat=${destEl.dataset.lat}&toLon=${destEl.dataset.lon}`;
      }
      const res = await fetch(url);
      if (!res.ok) {
        let serverErrorMsg = `El servidor d'Arribo! ha retornat un codi d'error HTTP ${res.status}.`;
        try {
          const errJson = await res.json();
          if (errJson.error) serverErrorMsg = errJson.error;
        } catch (_) {}
        throw new Error(serverErrorMsg);
      }

      const data = await res.json();

      if (!data.success) {
        const errorReason = data.error || data.message || "No s'ha pogut trobar la parada o adreça especificada.";
        resultsContainer.innerHTML = `
          <div style="text-align:center; padding:2.5rem 1rem;">
            <div style="font-size:2.2rem; margin-bottom:0.5rem;">🚏</div>
            <div style="font-weight:700; color:var(--text-primary); font-size:1.05rem; margin-bottom:0.4rem;">Parada o carrer no trobat</div>
            <div style="font-size:0.85rem; color:var(--text-secondary); max-width:340px; margin:0 auto 0.75rem auto; line-height:1.4;">${this.esc(errorReason)}</div>
            <div style="font-size:0.78rem; color:var(--text-muted); line-height:1.4;">Comprova l'ortografia d'origen i destinació, o tria directament una opció suggerida del menú desplegable.</div>
          </div>
        `;
        return;
      }

      this.currentItineraries = data.itineraries || [];
      if (this.currentItineraries.length === 0) {
        resultsContainer.innerHTML = `
          <div style="text-align:center; padding:2.5rem 1rem; color:var(--text-secondary);">
            <div style="font-size:2.2rem; margin-bottom:0.5rem;">🔍</div>
            <div style="font-weight:700; color:var(--text-primary); font-size:1.05rem; margin-bottom:0.4rem;">Cap combinació disponible</div>
            <div style="font-size:0.85rem; max-width:340px; margin:0 auto; line-height:1.4;">${this.esc(data.message || 'No s\'ha trobat cap ruta directa ni amb 1 sol transbordament entre aquestes dues ubicacions actualment.')}</div>
          </div>
        `;
        if (this.mapController && typeof this.mapController.clearItinerary === 'function') {
          this.mapController.clearItinerary();
        }
        return;
      }

      // Save search state and start live polling (refreshes every 15s)
      this.lastSearchUrl = url;
      this.lastOriginStop = data.originStop;
      this.lastDestStop = data.destStop;
      this.startPolling();

      // Update mobile trip summary text
      const sumFrom = document.getElementById('trip-summary-from');
      const sumTo = document.getElementById('trip-summary-to');
      if (sumFrom) sumFrom.textContent = originVal;
      if (sumTo) sumTo.textContent = destVal;

      const routesCountLabel = document.getElementById('label-sheet-routes');
      if (routesCountLabel) {
        routesCountLabel.textContent = `📋 Rutes (${this.currentItineraries.length})`;
      }
      const floatBadge = document.getElementById('floating-routes-badge');
      if (floatBadge) {
        floatBadge.textContent = String(this.currentItineraries.length);
      }

      // Collapse search form on mobile so routes take up the entire sheet
      this.toggleSearchForm(false);

      // On mobile, automatically show the expanded routes view
      if (window.innerWidth <= 768) {
        this.setSheetState('expanded');
      }

      const scrollHint = document.getElementById('plan-scroll-hint');
      if (scrollHint) {
        scrollHint.style.display = this.currentItineraries.length > 1 ? 'flex' : 'none';
        scrollHint.style.opacity = '1';
      }

      // Render Itineraries
      this.renderItineraries(this.currentItineraries, data.originStop, data.destStop);

      // Select target itinerary and paint on map
      const selectIdx = (targetIndex >= 0 && targetIndex < this.currentItineraries.length) ? targetIndex : 0;
      this.selectItinerary(selectIdx);

      // Update URL without reload (uses originVal and destVal)
      const newUrl = `${window.location.pathname}?from=${encodeURIComponent(originVal)}&to=${encodeURIComponent(destVal)}&itin=${selectIdx}`;
      window.history.replaceState({}, '', newUrl);

    } catch (err) {
      console.error('Plan search error:', err);
      let errorTitle = "No s'ha pogut connectar amb el servei";
      let errorDesc = "No s'ha pogut obtenir la planificació del servidor d'Arribo!.";

      if (!navigator.onLine) {
        errorTitle = "Sense connexió a Internet";
        errorDesc = "El teu dispositiu està sense connexió. Comprova la teva xarxa Wi-Fi o dades mòbils.";
      } else if (err.name === 'TypeError' && String(err.message).toLowerCase().includes('fetch')) {
        errorTitle = "Servidor d'Arribo! no disponible";
        errorDesc = "El navegador no ha pogut contactar amb el servidor local/API d'Arribo!. Comprova que el servei estigui en funcionament.";
      } else if (err.message) {
        errorDesc = err.message;
      }

      resultsContainer.innerHTML = `
        <div style="text-align:center; padding:2.5rem 1.2rem; background:rgba(239, 68, 68, 0.06); border:1px solid rgba(239, 68, 68, 0.2); border-radius:12px; margin:1rem 0;">
          <div style="font-size:2.2rem; margin-bottom:0.5rem;">⚠️</div>
          <div style="font-weight:700; color:#ef4444; font-size:1.05rem; margin-bottom:0.4rem;">${this.esc(errorTitle)}</div>
          <div style="font-size:0.85rem; color:var(--text-secondary); max-width:340px; margin:0 auto 1.25rem auto; line-height:1.4;">${this.esc(errorDesc)}</div>
          <button type="button" class="btn-primary" onclick="window.planApp ? window.planApp.runSearch() : null" style="display:inline-flex; align-items:center; gap:6px; font-size:0.85rem; padding:0.45rem 1.1rem; cursor:pointer;">
            <span>🔄 Reintentar connexió</span>
          </button>
        </div>
      `;
    }
  }

  renderItineraries(itineraries, originStop, destStop) {
    const container = document.getElementById('page-planner-results');
    if (!container) return;

    container.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
        <span style="font-size:0.82rem; color:var(--text-muted); font-weight:700;">
          ${itineraries.length} ${itineraries.length === 1 ? 'OPCIÓ TROBADA' : 'OPCIONS TROBADES'}:
        </span>
        <span style="font-size:0.72rem; color:var(--text-muted); display:inline-flex; align-items:center; gap:4px;">
          <span style="width:6px; height:6px; background:#10b981; border-radius:50%; display:inline-block;"></span> Actualitzant en viu
        </span>
      </div>
      ${itineraries.map((it, idx) => {
        const isDirect = it.type === 'direct';
        const firstLeg = it.legs[0];
        const waitMin = Number.isFinite(firstLeg?.nextDepartureMins) 
          ? firstLeg.nextDepartureMins 
          : (Number.isFinite(it.nextDepartureMinutes) 
              ? it.nextDepartureMinutes 
              : (Number.isFinite(it.nextDepartureMins) ? it.nextDepartureMins : null));

        const isRealTime = Boolean(firstLeg?.isRealTime ?? it.isRealTime);
        const waitBadge = isRealTime
          ? `<span style="display:inline-flex; align-items:center; gap:5px; font-size:0.75rem; color:#10b981; font-weight:700; background:rgba(16,185,129,0.12); border:1px solid rgba(16,185,129,0.25); padding:2px 7px; border-radius:4px;">
               <span style="width:6px; height:6px; background:#10b981; border-radius:50%; box-shadow:0 0 6px #10b981;"></span>
               ${Number.isFinite(waitMin) ? `En temps real: ${waitMin} min` : 'En temps real'}
             </span>`
          : `<span style="display:inline-flex; align-items:center; gap:5px; font-size:0.75rem; color:#f59e0b; font-weight:600; background:rgba(245,158,11,0.1); border:1px solid rgba(245,158,11,0.2); padding:2px 7px; border-radius:4px;">
               <span>📅</span> Horari oficial: ${firstLeg?.departureTime || (Number.isFinite(waitMin) ? `${waitMin} min` : 'Teòric')}
             </span>`;

        return `
          <div class="planner-itinerary-card ${idx === this.activeItineraryIndex ? 'plan-itinerary-active' : ''}" data-itinerary-index="${idx}" style="cursor:pointer;">
            <div class="planner-card-header">
              <div class="planner-total-duration" style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                <span>⏱️ ~${it.totalDurationMins} min</span>
                ${waitBadge}
              </div>
              <span class="${isDirect ? 'planner-tag-direct' : 'planner-tag-transfer'}">
                ${isDirect ? '✓ Ruta Directa' : '🔄 1 Transbordament'}
              </span>
            </div>

            <div class="planner-legs-flow">
              ${it.walkToFirstStop && it.walkToFirstStop.distanceMeters > 15 ? `
                <div style="display:flex; align-items:center; gap:8px; padding:4px 0 6px 0; color:var(--text-secondary); font-size:0.83rem; border-bottom:1px dashed var(--border-subtle); margin-bottom:6px;">
                  <span style="font-size:1.1rem; line-height:1;">🚶</span>
                  <div>
                    <span>Caminar des de <strong>${this.esc((it.walkToFirstStop.fromName && !/^\d+$/.test(it.walkToFirstStop.fromName.trim())) ? it.walkToFirstStop.fromName : (originVal || 'l\'origen'))}</strong></span>
                    <span style="font-size:0.75rem; color:var(--text-muted); margin-left:4px;">(~${it.walkToFirstStop.walkingMinutes} min • ${it.walkToFirstStop.distanceMeters} m)</span>
                  </div>
                </div>
              ` : ''}

              ${it.legs.map((leg, lIdx) => {
                const destText = leg.destination || (leg.toStop && leg.toStop.name) || '';
                return `
                  ${lIdx > 0 && it.transferWalk && it.transferWalk.distanceMeters > 15 ? `
                    <div style="display:flex; align-items:center; gap:8px; padding:4px 0 6px 0; color:var(--text-muted); font-size:0.8rem; margin-bottom:4px;">
                      <span>🔄🚶</span>
                      <span>Enllaç a peu fins a <strong>${this.esc(leg.fromStop.name)}</strong> (~${it.transferWalk.walkingMinutes} min • ${it.transferWalk.distanceMeters} m)</span>
                    </div>
                  ` : ''}
                  <div class="planner-leg-item">
                    <div>
                      <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; margin-bottom:3px;">
                        <div style="display:flex; align-items:center; gap:6px;">
                          <span class="planner-leg-badge" style="background:${leg.lineColor || '#009485'};">
                            ${this.esc(leg.lineCode)}
                          </span>
                          <span style="font-size:0.85rem; font-weight:700; color:var(--text-primary);">
                            ${destText ? `Cap a ${this.esc(destText)}` : ''}
                          </span>
                        </div>
                        ${leg.departureTime && leg.departureTime !== 'En breu' ? `
                          <span style="font-size:0.75rem; font-weight:700; color:${leg.isRealTime ? '#10b981' : '#f59e0b'}; background:${leg.isRealTime ? 'rgba(16,185,129,0.12)' : 'rgba(245,158,11,0.12)'}; padding:2px 6px; border-radius:4px;">
                            🕐 ${this.esc(leg.departureTime)}${leg.isRealTime ? ' • En viu' : ' • Horari'}
                          </span>
                        ` : ''}
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

              ${it.walkFromLastStop && it.walkFromLastStop.distanceMeters > 15 ? `
                <div style="display:flex; align-items:center; gap:8px; padding:6px 0 2px 0; color:var(--text-secondary); font-size:0.83rem; border-top:1px dashed var(--border-subtle); margin-top:6px;">
                  <span style="font-size:1.1rem; line-height:1;">🚶</span>
                  <div>
                    <span>Caminar fins a <strong>${this.esc((it.walkFromLastStop.toName && !/^\d+$/.test(it.walkFromLastStop.toName.trim())) ? it.walkFromLastStop.toName : (destVal || 'la destinació'))}</strong></span>
                    <span style="font-size:0.75rem; color:var(--text-muted); margin-left:4px;">(~${it.walkFromLastStop.walkingMinutes} min • ${it.walkFromLastStop.distanceMeters} m)</span>
                  </div>
                </div>
              ` : ''}
            </div>

            <!-- Eco-Impact CO2 Savings Badge (clearly indicated as approximate) -->
            <div class="planner-eco-strip" style="display:flex; align-items:center; gap:6px; margin-top:0.75rem; font-size:0.75rem; color:#10b981; background:rgba(16,185,129,0.08); border:1px solid rgba(16,185,129,0.2); padding:4px 8px; border-radius:5px;">
              <span>🌱</span>
              <span>Estalvi aprox. <strong>${this.esc(it.co2Formatted || (it.co2SavedGrams ? (it.co2SavedGrams >= 1000 ? '~' + it.co2SavedKg + ' kg' : '~' + it.co2SavedGrams + ' g') : '~350 g'))}</strong> CO₂ respecte al cotxe</span>
              <span style="color:var(--text-muted); font-size:0.7rem; margin-left:auto;">(${it.transitDistanceKm || '3.5'} km bus)</span>
            </div>

            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:0.75rem; border-top:1px solid var(--border-subtle); padding-top:0.6rem; gap:8px;">
              <button type="button" class="btn-start-guided-nav" data-itinerary-index="${idx}" title="Iniciar guia interactiva pas a pas d'aquest viatge" style="display:inline-flex; align-items:center; gap:5px; background:linear-gradient(135deg, #0ea5e9, #0284c7); color:#fff; border:none; border-radius:6px; padding:6px 12px; font-size:0.82rem; font-weight:700; cursor:pointer; box-shadow:0 2px 6px rgba(14,165,233,0.3);">
                <span>🚀 Iniciar viatge</span>
              </button>
              <span style="font-size:0.73rem; color:var(--text-muted); font-weight:600; text-align:right;">
                ${idx === this.activeItineraryIndex ? '📍 Mostrant al mapa' : 'Fes clic per veure la ruta'}
              </span>
            </div>
          </div>
        `;
      }).join('')}
    `;

    // Delegated click on container (AGENTS.md §8 compliant)
    if (container && !container._hasItineraryDelegation) {
      container._hasItineraryDelegation = true;
      container.addEventListener('click', (e) => {
        const card = e.target.closest('.planner-itinerary-card');
        if (!card) return;
        const idx = parseInt(card.getAttribute('data-itinerary-index'), 10);
        if (!isNaN(idx)) {
          this.selectItinerary(idx);
        }
      });
    }
  }

  selectItinerary(index, repaintMap = true) {
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

    if (repaintMap) {
      const it = this.currentItineraries[index];
      if (this.mapController && typeof this.mapController.renderItinerary === 'function') {
        this.mapController.renderItinerary(it);
      }
      // On mobile, if sheet was fully expanded, switch to split view so map route is clearly visible
      if (window.innerWidth <= 768 && this.currentSheetState === 'expanded') {
        this.setSheetState('split');
      }
    }
  }

  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      if (document.hidden) return;
      this.refreshLiveDepartures();
    }, 15000);
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async refreshLiveDepartures() {
    if (!this.lastSearchUrl || this.currentItineraries.length === 0) return;
    try {
      const res = await fetch(this.lastSearchUrl);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.success || !Array.isArray(data.itineraries) || data.itineraries.length === 0) return;

      this.currentItineraries = data.itineraries;
      this.lastOriginStop = data.originStop || this.lastOriginStop;
      this.lastDestStop = data.destStop || this.lastDestStop;

      // Re-render itinerary cards with fresh real-time/scheduled data
      this.renderItineraries(this.currentItineraries, this.lastOriginStop, this.lastDestStop);

      // Preserve active card without re-fitting map bounds
      this.selectItinerary(this.activeItineraryIndex, false);
    } catch (_) {}
  }

  startGuidedNavigation(index) {
    const itin = this.currentItineraries[index];
    if (!itin) return;

    this.selectItinerary(index, true);
    this.currentGuideItinerary = itin;
    this.currentGuideStepIdx = 0;

    const originVal = document.getElementById('page-planner-origin')?.value.trim() || 'l\'origen';
    const destVal = document.getElementById('page-planner-dest')?.value.trim() || 'la destinació';

    const steps = [];
    if (itin.walkToFirstStop && itin.walkToFirstStop.distanceMeters > 15) {
      steps.push({
        type: 'walk',
        title: 'Camina fins a la primera parada',
        icon: '🚶',
        desc: `Camina des de <strong>${this.esc(itin.walkToFirstStop.fromName || originVal)}</strong> fins a la parada <strong>${this.esc(itin.legs[0].fromStop.name)}</strong>.`,
        details: `${itin.walkToFirstStop.distanceMeters} metres • aproximadament ${itin.walkToFirstStop.walkingMinutes} minuts`,
        coord: itin.walkToFirstStop.to
      });
    }

    itin.legs.forEach((leg, lIdx) => {
      const isLastLeg = lIdx === itin.legs.length - 1;
      const destName = leg.destination || (leg.toStop && leg.toStop.name) || '';

      steps.push({
        type: 'bus_board',
        title: `Puja a l'autobús ${leg.lineCode}`,
        icon: '🚌',
        lineColor: leg.lineColor || '#009485',
        lineCode: leg.lineCode,
        desc: `Agafa la línia <span class="planner-leg-badge" style="background:${leg.lineColor || '#009485'}; display:inline-block; padding:1px 6px; border-radius:4px; font-weight:700; color:#fff;">${this.esc(leg.lineCode)}</span> a <strong>${this.esc(leg.fromStop.name)}</strong> cap a <strong>${this.esc(destName)}</strong>.`,
        details: `Sortida: ${leg.departureTime || 'En breu'}${leg.isRealTime ? ' • En temps real 🟢' : ' • Horari oficial 📅'}`,
        coord: [leg.fromStop.lat, leg.fromStop.lon]
      });

      steps.push({
        type: 'bus_ride',
        title: `Trajecte de ${leg.stopsCount || leg.stopCount} parades`,
        icon: '🛣️',
        desc: `Viatja a bord del bus durant ${leg.stopsCount || leg.stopCount} parades (~${leg.travelTimeMins || leg.durationMinutes} min).`,
        details: `Prepara't per baixar a: <strong>${this.esc(leg.toStop.name)}</strong>`,
        coord: [leg.toStop.lat, leg.toStop.lon]
      });

      if (!isLastLeg && itin.transferWalk && itin.transferWalk.distanceMeters > 10) {
        steps.push({
          type: 'transfer_walk',
          title: 'Transbordament a peu',
          icon: '🔄',
          desc: `Camina ${itin.transferWalk.distanceMeters} m (~${itin.transferWalk.walkingMinutes} min) des de <strong>${this.esc(leg.toStop.name)}</strong> fins a <strong>${this.esc(itin.legs[lIdx + 1].fromStop.name)}</strong>.`,
          details: `Enllaç amb la línia ${itin.legs[lIdx + 1].lineCode}`,
          coord: itin.transferWalk.to
        });
      }
    });

    if (itin.walkFromLastStop && itin.walkFromLastStop.distanceMeters > 15) {
      steps.push({
        type: 'walk_dest',
        title: 'Arribada a la destinació',
        icon: '🏁',
        desc: `Camina ${itin.walkFromLastStop.distanceMeters} m (~${itin.walkFromLastStop.walkingMinutes} min) des de <strong>${this.esc(itin.walkFromLastStop.fromName)}</strong> fins a <strong>${this.esc(itin.walkFromLastStop.toName || destVal)}</strong>.`,
        details: 'Has completat el teu trajecte amb Arribo! 🎉',
        coord: itin.walkFromLastStop.to
      });
    }

    this.guideSteps = steps;
    const modal = document.getElementById('nav-guide-modal');
    if (modal) modal.style.display = 'flex';
    this.renderCurrentGuideStep();
  }

  renderCurrentGuideStep() {
    if (!this.guideSteps || this.guideSteps.length === 0) return;
    const idx = this.currentGuideStepIdx;
    const total = this.guideSteps.length;
    const step = this.guideSteps[idx];

    const counterEl = document.getElementById('nav-guide-step-counter');
    const fillEl = document.getElementById('nav-guide-progress-fill');
    const bodyEl = document.getElementById('nav-guide-body');
    const prevBtn = document.getElementById('btn-nav-prev');
    const nextBtn = document.getElementById('btn-nav-next');

    if (counterEl) counterEl.textContent = `Pas ${idx + 1} de ${total}`;
    if (fillEl) fillEl.style.width = `${Math.round(((idx + 1) / total) * 100)}%`;

    if (bodyEl) {
      bodyEl.innerHTML = `
        <div class="nav-step-card">
          <div class="nav-step-icon-bubble">${step.icon}</div>
          <div class="nav-step-content">
            <h4 class="nav-step-title">${this.esc(step.title)}</h4>
            <div class="nav-step-desc">${step.desc}</div>
            <div class="nav-step-details">${step.details}</div>
          </div>
        </div>
      `;
    }

    if (prevBtn) {
      prevBtn.disabled = idx === 0;
    }

    if (nextBtn) {
      if (idx === total - 1) {
        nextBtn.innerHTML = '<span>Completar viatge 🎉</span>';
      } else {
        nextBtn.innerHTML = '<span>Següent pas ➔</span>';
      }
    }

    // Pan map to step position if available
    if (step.coord && this.mapController && this.mapController.map) {
      try {
        this.mapController.map.panTo([step.coord[0], step.coord[1]], { animate: true, duration: 0.6 });
      } catch (_) {}
    }
  }

  nextGuideStep() {
    if (this.currentGuideStepIdx < this.guideSteps.length - 1) {
      this.currentGuideStepIdx++;
      this.renderCurrentGuideStep();
    } else {
      this.closeGuidedNavigation();
    }
  }

  prevGuideStep() {
    if (this.currentGuideStepIdx > 0) {
      this.currentGuideStepIdx--;
      this.renderCurrentGuideStep();
    }
  }

  closeGuidedNavigation() {
    const modal = document.getElementById('nav-guide-modal');
    if (modal) modal.style.display = 'none';
  }

  esc(str) {
    if (typeof window !== 'undefined' && window.TransitUtils && typeof window.TransitUtils.esc === 'function') {
      return window.TransitUtils.esc(str);
    }
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.plannerApp = new PlannerPageApp();
});

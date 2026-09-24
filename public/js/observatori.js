/**
 * Arribo! Mataró — Observatori de Retards i Puntualitat
 * Standalone analytics controller managing historical telemetry,
 * peak congestion analysis, school rush profiling, termòmetre, and incident deep-dives.
 */

class ObservatoriApp {
  constructor() {
    this.currentHours = 24;
    this.currentTab = 'journalism'; // 'journalism' | 'termometre' | 'incidents'
    this.filterText = '';
    this.sorts = {
      mostDelayed: { key: 'avgDelay', asc: false },
      worstStops: { key: 'avgDelay', asc: false },
      agencies: { key: 'totalSamples', asc: false }
    };
    this.worstStopsLimit = 10;
    this.groupByLine = false;
    this.stopFilterMode = 'bottlenecks'; // 'bottlenecks' | 'all'
    this.currentReport = null;
    this.termometreData = null;
    this.lastIncidentData = null;
    this._incidentCache = new Map();
    this._currentIncidentLine = 'all';
    this._currentIncidentHours = 168;
    this._currentIncidentMode = 'top';
    this.availableLines = [];

    this.init();
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

  init() {
    this.initTheme();
    this.initUrlState();
    this.bindEvents();
    this.loadActiveTab();
    this.fetchLinesMetadata();
  }

  initTheme() {
    const savedTheme = localStorage.getItem('arribo_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    const themeBtn = document.getElementById('btn-page-theme-toggle');
    themeBtn?.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('arribo_theme', next);
    });
  }

  initUrlState() {
    const params = new URLSearchParams(window.location.search);
    const h = parseInt(params.get('h') || '', 10);
    if ([24, 48, 168].includes(h)) {
      this.currentHours = h;
    }

    const tab = params.get('tab');
    if (tab === 'termometre' || tab === 'incidents') {
      this.currentTab = tab;
    }

    const q = params.get('q');
    if (q) {
      this.filterText = q;
      const input = document.getElementById('journalism-search-input');
      if (input) input.value = q;
    }

    if (params.get('grouped') === '1') {
      this.groupByLine = true;
    }

    const stopsMode = params.get('stops');
    if (stopsMode === 'all' || stopsMode === 'bottlenecks') {
      this.stopFilterMode = stopsMode;
    }

    // Set initial active tab button UI
    document.querySelectorAll('#journalism-timeframe-tabs button').forEach(btn => {
      btn.classList.remove('active');
      const dataTab = btn.getAttribute('data-tab');
      const dataHours = parseInt(btn.getAttribute('data-hours') || '0', 10);
      if (this.currentTab === 'termometre' && dataTab === 'termometre') {
        btn.classList.add('active');
      } else if (this.currentTab === 'incidents' && dataTab === 'incidents') {
        btn.classList.add('active');
      } else if (this.currentTab === 'journalism' && dataHours === this.currentHours) {
        btn.classList.add('active');
      }
    });
  }

  updateUrl() {
    const params = new URLSearchParams();
    if (this.currentTab === 'termometre') {
      params.set('tab', 'termometre');
    } else if (this.currentTab === 'incidents') {
      params.set('tab', 'incidents');
      if (this._currentIncidentLine && this._currentIncidentLine !== 'all') {
        params.set('line', this._currentIncidentLine);
      }
    } else {
      if (this.currentHours !== 24) {
        params.set('h', String(this.currentHours));
      }
    }

    if (this.filterText && this.currentTab === 'journalism') {
      params.set('q', this.filterText);
    }

    if (this.groupByLine && this.currentTab === 'journalism') {
      params.set('grouped', '1');
    }

    if (this.stopFilterMode && this.stopFilterMode !== 'bottlenecks' && this.currentTab === 'journalism') {
      params.set('stops', this.stopFilterMode);
    }

    const newUrl = `${window.location.pathname}${params.toString() ? '?' + params.toString() : ''}`;
    window.history.replaceState({}, '', newUrl);
  }

  async fetchLinesMetadata() {
    try {
      const res = await fetch('/api/lines').then(r => r.json());
      if (res && res.success && Array.isArray(res.lines)) {
        this.availableLines = res.lines;
      }
    } catch {
      // Non-critical fallback
    }
  }

  bindEvents() {
    // Refresh Button
    document.getElementById('btn-observatori-refresh')?.addEventListener('click', (e) => {
      e.preventDefault();
      this._incidentCache?.clear();
      this.loadActiveTab(true);
    });

    // Timeframe tabs (24h, 48h, 7 dies, Termòmetre, Incidents)
    document.querySelectorAll('#journalism-timeframe-tabs button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelectorAll('#journalism-timeframe-tabs button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const dataTab = btn.getAttribute('data-tab');
        if (dataTab === 'termometre') {
          this.currentTab = 'termometre';
          this.updateUrl();
          this.loadTermometre(24);
        } else if (dataTab === 'incidents') {
          this.currentTab = 'incidents';
          this.updateUrl();
          this.openDelayIncidentsTab('all');
        } else {
          this.currentTab = 'journalism';
          this.currentHours = parseInt(btn.getAttribute('data-hours') || '24', 10);
          this.updateUrl();
          this.loadJournalismReport(this.currentHours);
        }
      });
    });

    // Search input
    const searchInput = document.getElementById('journalism-search-input');
    searchInput?.addEventListener('input', (e) => {
      this.filterText = e.target.value;
      this.updateUrl();
      if (this.currentReport && this.currentTab === 'journalism') {
        this.renderJournalismReport(this.currentReport);
      }
    });

    // Event delegation for table sorting and pagination
    const mainContainer = document.querySelector('.observatori-page-container');
    mainContainer?.addEventListener('click', (e) => {
      // Sorting
      const sortTh = e.target.closest('[data-sort-table][data-sort-key]');
      if (sortTh) {
        e.preventDefault();
        const tableKey = sortTh.getAttribute('data-sort-table');
        const colKey = sortTh.getAttribute('data-sort-key');
        this.handleJournalismSort(tableKey, colKey);
        return;
      }

      // Worst stops limits
      const limitBtn = e.target.closest('[data-worst-limit]');
      if (limitBtn) {
        e.preventDefault();
        const limit = parseInt(limitBtn.getAttribute('data-worst-limit') || '10', 10);
        this.setWorstStopsLimit(limit);
        return;
      }

      // Stop filter mode toggle (bottlenecks vs all)
      const stopModeBtn = e.target.closest('[data-toggle-stop-mode]');
      if (stopModeBtn) {
        e.preventDefault();
        const mode = stopModeBtn.getAttribute('data-toggle-stop-mode');
        if (mode === 'all' || mode === 'bottlenecks') {
          this.stopFilterMode = mode;
          this.updateUrl();
          if (this.currentReport && this.currentTab === 'journalism') {
            this.renderJournalismReport(this.currentReport);
          }
        }
        return;
      }

      // Incident pills: hours
      const hoursPill = e.target.closest('[data-incident-hours]');
      if (hoursPill) {
        e.preventDefault();
        const h = parseInt(hoursPill.dataset.incidentHours, 10) || 168;
        this.openDelayIncidentsView(this._currentIncidentLine || 'all', h, this._currentIncidentMode || 'top');
        return;
      }

      // Incident pills: line
      const linePill = e.target.closest('[data-incident-line]');
      if (linePill) {
        e.preventDefault();
        const line = linePill.dataset.incidentLine;
        this.openDelayIncidentsView(line, this._currentIncidentHours || 168, this._currentIncidentMode || 'top');
        return;
      }

      // Incident mode tabs (top vs investigation vs trips)
      const tabBtn = e.target.closest('[data-incident-tab]');
      if (tabBtn) {
        e.preventDefault();
        const mode = tabBtn.dataset.incidentTab;
        this._currentIncidentMode = mode;
        if (this.lastIncidentData) {
          this.renderDelayIncidentsView(this.lastIncidentData, this._currentIncidentLine || 'all', this._currentIncidentHours || 168, mode);
        } else {
          this.openDelayIncidentsView(this._currentIncidentLine || 'all', this._currentIncidentHours || 168, mode);
        }
        return;
      }

      // Locate stop on main map
      const locateBtn = e.target.closest('[data-locate-stop]');
      if (locateBtn) {
        e.preventDefault();
        const stopName = locateBtn.dataset.locateStop;
        const stopId = locateBtn.dataset.locateStopId;
        const lineCode = locateBtn.dataset.locateLine;
        const cleanLine = String(lineCode || '').toLowerCase().replace(/^l/, '');
        const targetStop = stopId || stopName;
        window.location.href = `/?line=${encodeURIComponent(lineCode)}&stop=${encodeURIComponent(targetStop)}#l${cleanLine}`;
        return;
      }

      // Investigate incident: open forensic drill-down panel
      const investigateBtn = e.target.closest('[data-investigate-stop]');
      if (investigateBtn) {
        e.preventDefault();
        const line = investigateBtn.dataset.investigateLine;
        const stop = investigateBtn.dataset.investigateStop;
        const at = investigateBtn.dataset.investigateAt ? Number(investigateBtn.dataset.investigateAt) : undefined;
        this.openIncidentDrilldown(line, stop, at);
        return;
      }

      // Copy anomalies report to clipboard
      const copyBtn = e.target.closest('#btn-copy-anomalies-report');
      if (copyBtn) {
        e.preventDefault();
        this.copyAnomaliesReport();
        return;
      }

      // Copy investigation report to clipboard
      const copyInvBtn = e.target.closest('#btn-copy-investigation-report');
      if (copyInvBtn) {
        e.preventDefault();
        this.copyInvestigationReport();
        return;
      }

      // Stop Heatmap: click cell to open stop drilldown menu with that hour highlighted
      const heatCell = e.target.closest('.stop-heat-cell[data-stop-idx]');
      if (heatCell) {
        e.preventDefault();
        const stopIdx = parseInt(heatCell.dataset.stopIdx, 10);
        const hour = parseInt(heatCell.dataset.hour, 10);
        this.openStopHourlyDrilldown(stopIdx, hour);
        return;
      }

      // Stop Heatmap: click stop row header to open stop drilldown menu
      const stopHeader = e.target.closest('.stop-heatmap tbody th[data-stop-idx]');
      if (stopHeader) {
        e.preventDefault();
        const stopIdx = parseInt(stopHeader.dataset.stopIdx, 10);
        this.openStopHourlyDrilldown(stopIdx, null);
        return;
      }

      // Stop Heatmap: click column header to open hourly summary ranking
      const colHeader = e.target.closest('.stop-heatmap thead th[data-hour]');
      if (colHeader) {
        e.preventDefault();
        const hour = parseInt(colHeader.dataset.hour, 10);
        this.openHourSummaryDrilldown(hour);
        return;
      }

      // Inside drilldown modal: click another hour to switch highlight
      const selectHourRow = e.target.closest('[data-select-drilldown-hour]');
      if (selectHourRow) {
        e.preventDefault();
        const h = parseInt(selectHourRow.dataset.selectDrilldownHour, 10);
        if (this._activeDrilldownStopIdx !== undefined && this._activeDrilldownStopIdx !== null) {
          this.openStopHourlyDrilldown(this._activeDrilldownStopIdx, h);
        }
        return;
      }

      // Inside hour summary modal: click a stop to switch to that stop's detail
      const switchStopRow = e.target.closest('[data-switch-stop-idx]');
      if (switchStopRow) {
        e.preventDefault();
        const stopIdx = parseInt(switchStopRow.dataset.switchStopIdx, 10);
        const h = parseInt(switchStopRow.dataset.switchHour, 10);
        this.openStopHourlyDrilldown(stopIdx, h);
        return;
      }

      // Close drilldown modal
      if (e.target.closest('#stop-drilldown-close-btn') || e.target.id === 'stop-drilldown-modal-backdrop') {
        e.preventDefault();
        this.closeStopHourlyDrilldown();
        return;
      }
    });

    // Checkbox toggle: group stops by line
    mainContainer?.addEventListener('change', (e) => {
      const target = e.target;
      if (target && target.id === 'observatori-group-by-line') {
        this.groupByLine = !!target.checked;
        this.updateUrl();
        if (this.currentReport && this.currentTab === 'journalism') {
          this.renderJournalismReport(this.currentReport);
        }
      }
    });

    // Global backdrop click and Escape key listeners for the drilldown modal
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.closeStopHourlyDrilldown();
      }
    });

    document.addEventListener('click', (e) => {
      if (e.target.id === 'stop-drilldown-modal-backdrop') {
        e.preventDefault();
        this.closeStopHourlyDrilldown();
      }
    });

    // Keyboard support for sort headers and heatmap cells
    mainContainer?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        const sortTh = e.target.closest('[data-sort-table][data-sort-key]');
        if (sortTh) {
          e.preventDefault();
          const tableKey = sortTh.getAttribute('data-sort-table');
          const colKey = sortTh.getAttribute('data-sort-key');
          this.handleJournalismSort(tableKey, colKey);
          return;
        }

        const heatCell = e.target.closest('.stop-heat-cell[data-stop-idx]');
        if (heatCell) {
          e.preventDefault();
          const stopIdx = parseInt(heatCell.dataset.stopIdx, 10);
          const hour = parseInt(heatCell.dataset.hour, 10);
          this.openStopHourlyDrilldown(stopIdx, hour);
          return;
        }

        const stopHeader = e.target.closest('.stop-heatmap tbody th[data-stop-idx]');
        if (stopHeader) {
          e.preventDefault();
          const stopIdx = parseInt(stopHeader.dataset.stopIdx, 10);
          this.openStopHourlyDrilldown(stopIdx, null);
          return;
        }

        const colHeader = e.target.closest('.stop-heatmap thead th[data-hour]');
        if (colHeader) {
          e.preventDefault();
          const hour = parseInt(colHeader.dataset.hour, 10);
          this.openHourSummaryDrilldown(hour);
          return;
        }

        const selectHourRow = e.target.closest('[data-select-drilldown-hour]');
        if (selectHourRow) {
          e.preventDefault();
          const h = parseInt(selectHourRow.dataset.selectDrilldownHour, 10);
          if (this._activeDrilldownStopIdx !== undefined && this._activeDrilldownStopIdx !== null) {
            this.openStopHourlyDrilldown(this._activeDrilldownStopIdx, h);
          }
          return;
        }
      }
    });
  }

  loadActiveTab(force = false) {
    if (this.currentTab === 'termometre') {
      this.loadTermometre(24, force);
    } else if (this.currentTab === 'incidents') {
      this.openDelayIncidentsTab(this._currentIncidentLine || 'all', force);
    } else {
      this.loadJournalismReport(this.currentHours, force);
    }
  }

  // ==========================================
  // 1. JOURNALISM & HISTORICAL DELAY REPORT
  // ==========================================

  async loadJournalismReport(hours = 24, force = false) {
    this.currentHours = hours;
    const contentContainer = document.getElementById('journalism-content-container');
    const termometreContainer = document.getElementById('journalism-termometre-container');
    const incidentsContainer = document.getElementById('journalism-incidents-container');
    const searchBarWrap = document.getElementById('journalism-search-bar-wrap');

    if (searchBarWrap) searchBarWrap.style.display = 'block';
    if (contentContainer) contentContainer.style.display = 'block';
    if (termometreContainer) termometreContainer.style.display = 'none';
    if (incidentsContainer) incidentsContainer.style.display = 'none';

    if (!this.currentReport || force) {
      if (contentContainer) {
        contentContainer.innerHTML = '<div style="text-align:center; padding:3rem; color:var(--text-muted);"><span class="loading-spinner-inline"></span> Carregant informe de retards i puntualitat del servidor central...</div>';
      }
    }

    try {
      const [res, snapshotRes] = await Promise.allSettled([
        fetch(`/api/analytics/journalism?hours=${hours}`).then(r => r.json()),
        fetch(`/api/routes/snapshots`).then(r => r.json())
      ]);

      const journalismData = res.status === 'fulfilled' && res.value?.success ? (res.value.report || res.value) : null;
      const snapshotsData = snapshotRes.status === 'fulfilled' && snapshotRes.value?.success ? snapshotRes.value : null;

      if (journalismData) {
        journalismData.snapshotInfo = snapshotsData;
        this.currentReport = journalismData;
        this.renderJournalismReport(journalismData);
      } else {
        if (contentContainer) {
          contentContainer.innerHTML = '<div style="text-align:center; padding:3rem; color:var(--text-muted);">No hi ha prou dades de retards registrades encara. El servidor està capturant la telemetria contínua.</div>';
        }
      }
    } catch (err) {
      if (contentContainer) {
        contentContainer.innerHTML = `<div style="text-align:center; padding:3rem; color:var(--danger);">Error en carregar informe de periodisme: ${this.esc(err.message)}</div>`;
      }
    }
  }

  handleJournalismSort(tableKey, columnKey) {
    if (!this.sorts) this.sorts = {};
    const current = this.sorts[tableKey] || { key: null, asc: false };
    if (current.key === columnKey) {
      current.asc = !current.asc;
    } else {
      current.key = columnKey;
      current.asc = columnKey === 'lineCode' || columnKey === 'agency' || columnKey === 'stopName' || columnKey === 'overallRank';
    }
    this.sorts[tableKey] = current;
    if (this.currentReport) {
      this.renderJournalismReport(this.currentReport);
    }
  }

  setWorstStopsLimit(limit) {
    this.worstStopsLimit = Number(limit) || 10;
    if (this.currentReport) {
      this.renderJournalismReport(this.currentReport);
    }
  }

  renderJournalismReport(report) {
    const container = document.getElementById('journalism-content-container');
    if (!container) return;

    this.currentReport = report;
    const filterText = (this.filterText || '').trim().toLowerCase();
    const norm = (str) => String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const cleanFilter = norm(filterText);

    const s = report.summary || {};
    const isAllStopsMode = this.stopFilterMode === 'all';
    const allStopsSource = (report.allStopDelays && report.allStopDelays.length > 0)
      ? report.allStopDelays
      : (report.rankingWorstStops || []);
    const bottlenecksSource = (report.rankingWorstStops && report.rankingWorstStops.length > 0)
      ? report.rankingWorstStops
      : allStopsSource.filter(s => s.isBottleneck);

    // Calculate full matching stops vs bottleneck matching stops for contextual notice
    let matchingAllStops = allStopsSource.filter(st => (st.arrivalCount || 0) > 0);
    if (filterText) {
      matchingAllStops = matchingAllStops.filter(st =>
        (st.stopName && (st.stopName.toLowerCase().includes(filterText) || norm(st.stopName).includes(cleanFilter))) ||
        (st.lineCode && (st.lineCode.toLowerCase().includes(filterText) || norm(st.lineCode).includes(cleanFilter))) ||
        (st.agency && (st.agency.toLowerCase().includes(filterText) || norm(st.agency).includes(cleanFilter)))
      );
    }
    const matchingTotalCount = matchingAllStops.length;
    const matchingBottleneckCount = matchingAllStops.filter(s => s.isBottleneck).length;
    const matchingPunctualCount = Math.max(0, matchingTotalCount - matchingBottleneckCount);

    const activeStopsSource = isAllStopsMode ? allStopsSource : bottlenecksSource;

    let mostDelayed = [...(report.rankingMostDelayed || [])].filter(l => (l.sampleCount || 0) > 0 || (l.avgDelay || 0) > 0);
    let worstStops = [...activeStopsSource]
      .filter(st => (st.arrivalCount || 0) > 0)
      .map((st, idx) => ({ ...st, overallRank: idx + 1 }));
    let agencies = [...(report.agencyStats || [])].filter(a => (a.totalSamples || 0) > 0);

    // Filter by search text
    if (filterText) {
      mostDelayed = mostDelayed.filter(l =>
        (l.lineCode && (l.lineCode.toLowerCase().includes(filterText) || norm(l.lineCode).includes(cleanFilter))) ||
        (l.agency && (l.agency.toLowerCase().includes(filterText) || norm(l.agency).includes(cleanFilter))) ||
        (l.name && (l.name.toLowerCase().includes(filterText) || norm(l.name).includes(cleanFilter)))
      );
      worstStops = worstStops.filter(st =>
        (st.stopName && (st.stopName.toLowerCase().includes(filterText) || norm(st.stopName).includes(cleanFilter))) ||
        (st.lineCode && (st.lineCode.toLowerCase().includes(filterText) || norm(st.lineCode).includes(cleanFilter))) ||
        (st.agency && (st.agency.toLowerCase().includes(filterText) || norm(st.agency).includes(cleanFilter)))
      );
      agencies = agencies.filter(a =>
        (a.agency && (a.agency.toLowerCase().includes(filterText) || norm(a.agency).includes(cleanFilter)))
      );
    }

    // Sort list
    const applySort = (list, sortConfig) => {
      if (!sortConfig || !sortConfig.key) return list;
      const { key, asc } = sortConfig;
      return list.sort((a, b) => {
        let valA = a[key];
        let valB = b[key];
        if (typeof valA === 'string') {
          return asc ? valA.localeCompare(valB) : valB.localeCompare(valA);
        }
        valA = Number(valA) || 0;
        valB = Number(valB) || 0;
        return asc ? valA - valB : valB - valA;
      });
    };

    mostDelayed = applySort(mostDelayed, this.sorts.mostDelayed);
    worstStops = applySort(worstStops, this.sorts.worstStops);
    agencies = applySort(agencies, this.sorts.agencies);

    const getSortIndicator = (tableKey, colKey) => {
      const cur = this.sorts[tableKey];
      if (cur && cur.key === colKey) {
        return cur.asc ? '<span style="color:var(--brand-primary); margin-left:4px;">▲</span>' : '<span style="color:var(--brand-primary); margin-left:4px;">▼</span>';
      }
      return '<span style="opacity:0.3; margin-left:4px;">↕</span>';
    };

    let html = `
      <!-- Pre-generated Cache Banner -->
      ${report.meta?.generatedAt ? `
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem; background:rgba(0,148,133,0.08); border:1px solid rgba(0,148,133,0.22); border-radius:10px; padding:0.6rem 0.95rem; margin-bottom:1.25rem; font-size:0.78rem;">
          <div style="display:flex; align-items:center; gap:0.4rem; color:var(--text-primary);">
            <span>⚡</span>
            <span><strong>Informe pregenerat</strong>: compilat a les <strong>${new Date(report.meta.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong> (actualització automàtica cada 30 min)</span>
          </div>
          <div style="display:flex; align-items:center; gap:0.6rem;">
            <span style="color:var(--brand-primary); font-weight:700; font-size:0.75rem;">⏱️ Càrrega instantània</span>
          </div>
        </div>
      ` : ''}

      <!-- KPI Stats Grid -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:0.85rem; margin-bottom:1.5rem;">
        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:1rem;">
          <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase;">Mostres Analitzades</div>
          <div style="font-size:1.75rem; font-weight:700; color:var(--brand-primary); margin-top:0.25rem;">${(s.totalRecordedArrivals || 0).toLocaleString()}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${s.monitoredLinesCount || 0} línies monitorades${s.hoursAnalyzed ? ` • darreres ${s.hoursAnalyzed} h` : ''}</div>
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:1rem;">
          <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase;">Puntualitat Global</div>
          <div style="font-size:1.75rem; font-weight:700; color:${s.networkPunctualityPct === null || s.networkPunctualityPct === undefined ? 'var(--text-muted)' : (s.networkPunctualityPct >= 85 ? '#10b981' : '#f59e0b')}; margin-top:0.25rem;">${s.networkPunctualityPct === null || s.networkPunctualityPct === undefined ? '—' : `${s.networkPunctualityPct}%`}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${s.networkPunctualityPct === null || s.networkPunctualityPct === undefined ? 'Sense mostres: la puntualitat no es mesura' : 'Mostres en &le; 3 min de marge'}</div>
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:1rem;">
          <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase;">Retard Mitjà Xarxa</div>
          <div style="font-size:1.75rem; font-weight:700; color:#38bdf8; margin-top:0.25rem;">${s.networkAvgDelay === null || s.networkAvgDelay === undefined ? '—' : `${Number(s.networkAvgDelay) > 0 ? '+' : ''}${s.networkAvgDelay} min`}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">Mitjana de totes les mostres del període</div>
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:1rem;">
          <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase;">Retard Màxim Registrat</div>
          <div style="font-size:1.75rem; font-weight:700; color:#ef4444; margin-top:0.25rem;">${s.networkMaxDelay === null || s.networkMaxDelay === undefined ? '—' : `${Number(s.networkMaxDelay) > 0 ? '+' : ''}${s.networkMaxDelay} min`}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${s.networkMaxDelay === null || s.networkMaxDelay === undefined ? 'Sense mostres: no hi ha màxim' : 'Afectació puntual extrema'}</div>
        </div>
      </div>

      <!-- Sampling honesty: extrapolated rows are part of the KPIs above -->
      ${(() => {
        const sb = s.samplingBreakdown;
        if (!sb || !sb.totalSamples || !(sb.nonRealtimeSamples > 0)) return '';
        return `
        <div style="background:rgba(56,189,248,0.06); border:1px solid rgba(56,189,248,0.22); border-radius:10px; padding:0.7rem 0.95rem; margin-bottom:1.25rem; font-size:0.76rem; color:var(--text-secondary); line-height:1.5;">
          <strong style="color:#38bdf8;">Mostres, no viatges.</strong>
          Aquests KPIs es calculen sobre <strong>${sb.totalSamples.toLocaleString()} mostres individuals</strong> (un registre per senyal de vehicle, no pas viatges).
          D'aquestes, <strong>${sb.nonRealtimeSamples.toLocaleString()} (${sb.nonRealtimePct}%)</strong> són posicions extrapolades
          (dead-reckoning, <code>is_realtime = 0</code>) i no GPS fresc: s'hi inclouen perquè el retard registrat és real,
          però no són una observació directa de la posició del vehicle.
        </div>`;
      })()}

      <!-- Hourly Delay Distribution & School Congestion Profile -->
      ${(() => {
        const hourly = report.hourlyDelays || [];
        const peakHours = report.peakHours || [];
        if (hourly.length === 0 && peakHours.length === 0) return '';

        const serviceHours = hourly.filter(h => {
          const n = parseInt(h.hour, 10);
          return n >= 6 && n <= 23;
        });
        const maxHDelay = Math.max(2, ...serviceHours.map(h => Number(h.avgDelay) || 0));

        return `
        <div class="hourly-delays-section" style="margin-bottom:1.5rem;">
          <div class="hourly-chart-header">
            <h4 class="hourly-chart-title">
              <span>Distribució Horària (Hores amb Més Retards)</span>
            </h4>
            <div class="hourly-chart-legend">
              <div class="hourly-legend-item">
                <span class="hourly-legend-dot" style="background:#10b981;"></span>
                <span>Puntual (&lt;1.5m)</span>
              </div>
              <div class="hourly-legend-item">
                <span class="hourly-legend-dot" style="background:#f59e0b;"></span>
                <span>Moderat (1.5–3.5m)</span>
              </div>
              <div class="hourly-legend-item">
                <span class="hourly-legend-dot" style="background:#ef4444;"></span>
                <span>Crític (&gt;3.5m)</span>
              </div>
            </div>
          </div>

          <!-- Congestion Bar Chart -->
          <div class="hourly-chart-container" title="Retard mitjà per franja horària">
            ${serviceHours.map(h => {
              const dVal = Number(h.avgDelay) || 0;
              const pctHeight = Math.max(6, Math.min(100, Math.round((dVal / maxHDelay) * 100)));
              const barBg = dVal >= 3.5 
                ? 'linear-gradient(180deg, #ef4444 0%, #b91c1c 100%)' 
                : (dVal >= 1.5 
                    ? 'linear-gradient(180deg, #f59e0b 0%, #b45309 100%)' 
                    : (dVal > 0 
                        ? 'linear-gradient(180deg, #10b981 0%, #047857 100%)' 
                        : 'rgba(255, 255, 255, 0.08)'));
              const delayLabel = dVal > 0 ? `+${dVal}m` : (h.sampleCount > 0 ? '0m' : '-');
              const tooltip = `${h.timeWindow} • Retard mitjà: +${dVal} min • ${h.latePercentage}% viatges tardans (${h.sampleCount} expedicions)`;
              return `
                <div class="hourly-bar-col" title="${this.esc(tooltip)}">
                  <div class="hourly-bar-track">
                    <span class="hourly-bar-val">${delayLabel}</span>
                    <div class="hourly-bar-fill" style="height:${pctHeight}%; background:${barBg};"></div>
                  </div>
                  <span class="hourly-bar-label">${h.hour}h</span>
                </div>
              `;
            }).join('')}
          </div>

          <!-- Peak Hours Ranking & Critical Bottlenecks -->
          ${peakHours.length > 0 ? `
            <div style="font-size:0.85rem; font-weight:700; color:var(--text-secondary); margin-top:0.75rem;">
              Franges amb Més Retards:
            </div>
            <div class="peak-hours-grid" style="margin-top:0.5rem;">
              ${peakHours.slice(0, 3).map((ph, idx) => {
                return `
                <div class="peak-hour-card">
                  <div class="peak-hour-header">
                    <div class="peak-hour-time">
                      <span>${this.esc(ph.timeWindow)}</span>
                      <span style="font-size:0.7rem; color:var(--brand-primary); font-weight:700;">#${idx + 1}</span>
                    </div>
                  </div>

                  <div class="peak-hour-metrics">
                    <div class="peak-hour-stat">
                      <span class="stat-label">Retard Mitjà</span>
                      <strong class="stat-val ${ph.avgDelay >= 3 ? 'severe' : 'warning'}">+${ph.avgDelay} min</strong>
                    </div>
                    <div class="peak-hour-stat">
                      <span class="stat-label">% Afectats</span>
                      <strong class="stat-val">${ph.latePercentage}%</strong>
                    </div>
                    <div class="peak-hour-stat">
                      <span class="stat-label">Expedicions</span>
                      <strong class="stat-val">${(ph.sampleCount || 0).toLocaleString()}</strong>
                    </div>
                  </div>

                  ${ph.worstStopsDuringHour && ph.worstStopsDuringHour.length > 0 ? `
                    <div class="peak-hour-bottlenecks">
                      <span class="bottlenecks-title">Colls d'ampolla en aquesta hora:</span>
                      <div class="bottlenecks-list">
                        ${ph.worstStopsDuringHour.map(bs => `
                          <div class="bottleneck-item">
                            <span class="bottleneck-stop" title="${this.esc(bs.stopName)}">${this.esc(bs.stopName)}</span>
                            <span class="bottleneck-line" style="background:var(--brand-primary);">${this.esc(bs.lineCode)}</span>
                            <span class="bottleneck-delay">+${bs.avgDelay}m</span>
                          </div>
                        `).join('')}
                      </div>
                    </div>
                  ` : ''}
                </div>
              `;
              }).join('')}
            </div>
          ` : ''}
        </div>
        `;
      })()}

      <!-- Ranking: Lines with Most Delays -->
      <div class="observatori-table-container" style="margin-bottom:1.5rem;">
        <div class="observatori-table-header-row">
          <h4 class="observatori-table-title">
            <span>Línies Més Afectades per Retards</span>
            <span class="observatori-table-subtitle">(${mostDelayed.length} línies actives analitzades)</span>
          </h4>
          <span class="observatori-table-subtitle">Clica a les capçaleres per ordenar ↕</span>
        </div>
        ${mostDelayed.length === 0 ? '<div style="color:var(--text-muted); font-size:0.85rem; padding:0.8rem; background:var(--bg-elevated); border-radius:8px;">Cap línia coincideix amb el filtre o no hi ha retards suficients.</div>' : `
          <div class="observatori-table-scroll-hint" aria-hidden="true">
            <span class="scroll-hint-icon">↔</span>
            <span>Desplaça en horitzontal per veure totes les dades</span>
            <span class="scroll-hint-chevron">›</span>
          </div>
          <div class="observatori-table-wrapper">
            <table class="observatori-table">
              <thead>
                <tr>
                  <th class="sticky-col" data-sort-table="mostDelayed" data-sort-key="lineCode" role="button" tabindex="0">Línia ${getSortIndicator('mostDelayed', 'lineCode')}</th>
                  <th data-sort-table="mostDelayed" data-sort-key="avgDelay" role="button" tabindex="0">Retard Mitjà ${getSortIndicator('mostDelayed', 'avgDelay')}</th>
                  <th data-sort-table="mostDelayed" data-sort-key="onTimePercentage" role="button" tabindex="0">% Puntual ${getSortIndicator('mostDelayed', 'onTimePercentage')}</th>
                  <th class="observatori-col-desktop" data-sort-table="mostDelayed" data-sort-key="maxDelay" role="button" tabindex="0">Retard Màxim ${getSortIndicator('mostDelayed', 'maxDelay')}</th>
                  <th class="observatori-col-desktop" data-sort-table="mostDelayed" data-sort-key="sampleCount" role="button" tabindex="0">Mostres ${getSortIndicator('mostDelayed', 'sampleCount')}</th>
                  <th class="observatori-col-desktop" data-sort-table="mostDelayed" data-sort-key="agency" role="button" tabindex="0">Operador ${getSortIndicator('mostDelayed', 'agency')}</th>
                </tr>
              </thead>
              <tbody>
                ${mostDelayed.map((l, i) => {
                  const avgStr = Number(l.avgDelay) > 0 ? `+${l.avgDelay} min` : (Number(l.avgDelay) < 0 ? `${l.avgDelay} min` : '0.0 min');
                  const maxStr = Number(l.maxDelay) > 0 ? `+${l.maxDelay} min` : `${l.maxDelay || 0} min`;
                  const onTime = Number(l.onTimePercentage || 0);
                  const isL95 = (l.lineCode || '').toUpperCase() === 'L95';
                  return `
                  <tr>
                    <td class="sticky-col" style="font-weight:700; color:var(--text-primary);">
                      <div class="observatori-line-cell">
                        <span class="observatori-rank-num">#${i + 1}</span>
                        <span class="observatori-line-badge" style="background:var(--brand-primary);">${this.esc(l.lineCode)}</span>
                        <span class="observatori-line-name" title="${this.esc(l.name)}">${this.esc(l.name)}</span>
                      </div>
                    </td>
                    <td style="font-weight:700; color:${Number(l.avgDelay) > 0 ? '#ef4444' : '#10b981'}; white-space:nowrap;">
                      ${avgStr}
                    </td>
                    <td style="white-space:nowrap;">
                      <div style="display:flex; align-items:center; gap:0.4rem;">
                        <span style="font-weight:600; color:${onTime >= 85 ? '#10b981' : '#f59e0b'}; min-width:34px;">${onTime}%</span>
                        <div style="flex:1; max-width:60px; height:5px; background:var(--bg-main); border-radius:3px; overflow:hidden;">
                          <div style="width:${onTime}%; height:100%; background:${onTime >= 85 ? '#10b981' : '#f59e0b'};"></div>
                        </div>
                      </div>
                    </td>
                    <td class="observatori-col-desktop" style="color:var(--text-muted); white-space:nowrap;">${maxStr}</td>
                    <td class="observatori-col-desktop" style="color:var(--text-muted);">${(l.sampleCount || 0).toLocaleString()}</td>
                    <td class="observatori-col-desktop" style="color:var(--text-muted); font-size:0.75rem;">
                      ${this.esc(l.agency || 'Mataró Bus')}
                      ${isL95 ? '<span style="color:#38bdf8; font-size:0.7rem; display:block;">ℹ️ L95 exprés: trànsit C-31/C-32</span>' : ''}
                    </td>
                  </tr>
                `;}).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>

      <!-- Ranking: Bottleneck Stops & Stop Heatmap -->
      ${(() => {
        const worstLimit = this.worstStopsLimit || 10;
        const totalWorst = worstStops.length;
        const displayedWorstStops = worstStops.slice(0, worstLimit);
        const hasMoreWorst = totalWorst > worstLimit;
        const isGroupedByLine = !!this.groupByLine;

        let stopNoticeHtml = '';
        if (!isAllStopsMode && matchingPunctualCount > 0) {
          const lineNotice = filterText ? "d'aquesta línia" : 'a la xarxa';
          stopNoticeHtml = `
            <div class="observatori-filter-notice" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.6rem; background:rgba(0,148,133,0.08); border:1px solid rgba(0,148,133,0.25); border-radius:10px; padding:0.65rem 0.95rem; margin-bottom:1rem; font-size:0.8rem;">
              <div style="display:flex; align-items:center; gap:0.55rem; color:var(--text-primary);">
                <span style="font-size:1.15rem; flex-shrink:0;">ℹ️</span>
                <div>
                  <strong>Només es mostren colls d'ampolla</strong> (retard &ge; 1.5 min o &ge; 20% greus).
                  <span style="color:var(--text-muted); margin-left:0.25rem;">Les altres <strong>${matchingPunctualCount}</strong> parades ${lineNotice} han funcionat amb puntualitat (&lt; 1.5 min).</span>
                </div>
              </div>
              <button type="button" class="observatori-action-btn btn-secondary btn-sm" data-toggle-stop-mode="all">
                <span>🔓</span>
                <span>Veure totes les parades (${matchingTotalCount})</span>
              </button>
            </div>
          `;
        } else if (isAllStopsMode) {
          stopNoticeHtml = `
            <div class="observatori-filter-notice" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.6rem; background:rgba(2,132,199,0.08); border:1px solid rgba(56,189,248,0.25); border-radius:10px; padding:0.65rem 0.95rem; margin-bottom:1rem; font-size:0.8rem;">
              <div style="display:flex; align-items:center; gap:0.55rem; color:var(--text-primary);">
                <span style="font-size:1.15rem; flex-shrink:0;">📋</span>
                <div>
                  <strong>Mostrant totes les ${worstStops.length} parades actives</strong> (inclou parades puntuals i colls d'ampolla).
                  <span style="color:var(--text-muted); margin-left:0.25rem;">${matchingBottleneckCount} són colls d'ampolla.</span>
                </div>
              </div>
              <button type="button" class="observatori-action-btn btn-secondary btn-sm" data-toggle-stop-mode="bottlenecks">
                <span>⚠️</span>
                <span>Només colls d'ampolla (${matchingBottleneckCount})</span>
              </button>
            </div>
          `;
        }

        const renderStopRow = (st) => {
          const sAvg = Number(st.avgDelay) || 0;
          const sAvgStr = sAvg > 0 ? `+${st.avgDelay} min` : (sAvg < 0 ? `${st.avgDelay} min` : '0.0 min');
          const sMaxStr = Number(st.maxDelay) > 0 ? `+${st.maxDelay} min` : `${st.maxDelay || 0} min`;
          const lColor = this.getLineColor(st.lineCode);
          const isLight = lColor === '#ffcc00' || lColor === '#febf01';
          const badgeTextColor = isLight ? '#000' : '#fff';
          const isSevereStop = sAvg >= 1.5 || (st.severeLatePct || 0) >= 20;
          const avgDelayColor = sAvg >= 1.5 ? '#ef4444' : (sAvg >= 0.8 ? '#f59e0b' : '#10b981');
          return `
          <tr>
            <td class="sticky-col" style="font-weight:600; color:var(--text-primary);">
              <div class="observatori-stop-cell">
                <span class="observatori-rank-num ${isSevereStop && st.overallRank <= 3 ? 'rank-' + st.overallRank : ''}" title="Rànquing: #${st.overallRank}">#${st.overallRank}</span>
                <span class="observatori-stop-name" title="${this.esc(st.stopName)}">${this.esc(st.stopName)}</span>
                <span class="observatori-mobile-only" style="background:${lColor}; color:${badgeTextColor}; padding:0.1rem 0.35rem; border-radius:4px; font-size:0.7rem; font-weight:800; margin-left:0.25rem;">${this.esc(st.lineCode)}</span>
              </div>
            </td>
            <td class="observatori-col-desktop" style="font-weight:700; white-space:nowrap; text-align:center;">
              <span class="observatori-line-badge" style="background:${lColor}; color:${badgeTextColor}; font-size:0.72rem; padding:0.12rem 0.45rem; border-radius:4px;">${this.esc(st.lineCode)}</span>
            </td>
            <td class="observatori-col-desktop" style="color:var(--text-muted); white-space:nowrap;">${this.esc(st.agency)}</td>
            <td style="font-weight:700; color:${avgDelayColor}; white-space:nowrap;">${sAvgStr}</td>
            <td style="white-space:nowrap; text-align:center;">
              ${st.severeLatePct > 0 ? `
                <span style="background:${st.severeLatePct >= 30 ? 'rgba(239,68,68,0.2)' : (st.severeLatePct >= 20 ? 'rgba(245,158,11,0.15)' : 'rgba(255,255,255,0.06)')}; color:${st.severeLatePct >= 30 ? '#f87171' : (st.severeLatePct >= 20 ? '#fbbf24' : 'var(--text-muted)')}; padding:0.15rem 0.45rem; border-radius:6px; font-weight:600;">${st.severeLatePct}%</span>
              ` : '<span style="color:#10b981; font-weight:600; font-size:0.75rem;">0%</span>'}
            </td>
            <td style="white-space:nowrap;">
              ${st.criticalHour && st.criticalHour !== '--' && Number(st.criticalHourAvgDelay) >= 1.5 ? `
                <div class="bottleneck-hour-badge" title="Retard mitjà en aquesta franja: +${st.criticalHourAvgDelay} min">
                  <span class="badge-time">${this.esc(st.criticalHour)}</span>
                  <span class="badge-delay">(+${st.criticalHourAvgDelay}m)</span>
                </div>
              ` : (isSevereStop ? '<span style="color:var(--text-muted); font-size:0.75rem;">Uniforme</span>' : '<span style="color:#10b981; font-size:0.75rem; font-weight:600;">✓ Puntual</span>')}
            </td>
            <td class="observatori-col-desktop" style="color:var(--text-muted); white-space:nowrap;">${sMaxStr}</td>
          </tr>
        `;};

        let tableBodyHtml = '';
        if (!isGroupedByLine) {
          tableBodyHtml = displayedWorstStops.map(st => renderStopRow(st)).join('');
        } else {
          const lineGroups = new Map();
          for (const st of displayedWorstStops) {
            const lCode = st.lineCode || 'Altres';
            if (!lineGroups.has(lCode)) {
              lineGroups.set(lCode, []);
            }
            lineGroups.get(lCode).push(st);
          }

          const sortedLineCodes = Array.from(lineGroups.keys()).sort((a, b) => {
            const numA = parseInt(a.replace(/\D/g, ''), 10);
            const numB = parseInt(b.replace(/\D/g, ''), 10);
            if (!isNaN(numA) && !isNaN(numB) && numA !== numB) return numA - numB;
            return a.localeCompare(b);
          });

          tableBodyHtml = sortedLineCodes.map(lineCode => {
            const lineStops = lineGroups.get(lineCode);
            const lColor = this.getLineColor(lineCode);
            const isLight = lColor === '#ffcc00' || lColor === '#febf01';
            const badgeTextColor = isLight ? '#000' : '#fff';
            const lineMatch = (this.availableLines || []).find(l => String(l.code || l.id).toUpperCase() === String(lineCode).toUpperCase());
            const lineTitle = lineMatch?.name || `Línia ${lineCode}`;
            const lineAvg = (lineStops.reduce((sum, s) => sum + (Number(s.avgDelay) || 0), 0) / lineStops.length).toFixed(1);
            const slowestStop = lineStops.reduce((prev, curr) => (prev.overallRank < curr.overallRank ? prev : curr), lineStops[0]);

            return `
              <tr class="observatori-group-header-row">
                <td colspan="7">
                  <div class="observatori-group-header-content">
                    <div class="observatori-group-header-left">
                      <span class="observatori-line-badge" style="background:${lColor}; color:${badgeTextColor}; font-weight:800; font-size:0.75rem; padding:0.15rem 0.45rem; border-radius:4px;">${this.esc(lineCode)}</span>
                      <span style="font-weight:700; color:var(--text-primary); font-size:0.83rem;">${this.esc(lineTitle)}</span>
                      <span style="font-size:0.72rem; color:var(--text-muted); font-weight:500;">(${lineStops.length} ${lineStops.length === 1 ? 'parada' : 'parades'})</span>
                    </div>
                    <div class="observatori-group-header-right">
                      <span>Retard mitjà: <strong style="color:${Number(lineAvg) >= 3 ? '#ef4444' : '#f59e0b'};">+${lineAvg} min</strong></span>
                      <span style="border-left:1px solid var(--border-subtle); padding-left:0.6rem;">Parada més lenta: <strong style="color:var(--brand-primary);">#${slowestStop.overallRank}</strong> (${this.esc(slowestStop.stopName)})</span>
                    </div>
                  </div>
                </td>
              </tr>
              ${lineStops.map(st => renderStopRow(st)).join('')}
            `;
          }).join('');
        }

        return `
        <div class="observatori-table-container" style="margin-bottom:1.5rem;">
          ${stopNoticeHtml}
          <div class="observatori-table-header-row">
            <h4 class="observatori-table-title">
              <span>${isAllStopsMode ? 'Totes les Parades per Retard Mitjà' : "Colls d'Ampolla: Parades amb Més Retard"}</span>
              <span class="observatori-table-subtitle">(Mostrant ${displayedWorstStops.length} de ${totalWorst})</span>
            </h4>
            <div class="observatori-filter-toolbar">
              <div class="observatori-mode-toggle-group">
                <button type="button" class="observatori-pill-btn ${!isAllStopsMode ? 'active' : ''}" data-toggle-stop-mode="bottlenecks" title="Mostra exclusivament les parades amb retards significatius">⚠️ Colls d'ampolla</button>
                <button type="button" class="observatori-pill-btn ${isAllStopsMode ? 'active' : ''}" data-toggle-stop-mode="all" title="Mostra el 100% de les parades registrades, incloent-hi les puntuals">📋 Totes les parades</button>
              </div>
              <label class="observatori-group-toggle" title="Agrupa les parades per línia d'autobús o desmarca per veure l'ordre real">
                <input type="checkbox" id="observatori-group-by-line" ${isGroupedByLine ? 'checked' : ''}>
                <span>Agrupar per línia</span>
              </label>
              <div class="observatori-filter-group" aria-label="Filtre de parades">
                <span class="observatori-filter-label">FILTRE:</span>
                <button type="button" class="observatori-pill-btn ${worstLimit === 10 ? 'active' : ''}" data-worst-limit="10">Top 10</button>
                <button type="button" class="observatori-pill-btn ${worstLimit === 25 ? 'active' : ''}" data-worst-limit="25">Top 25</button>
                <button type="button" class="observatori-pill-btn ${worstLimit >= 9999 ? 'active' : ''}" data-worst-limit="9999">Totes (${totalWorst})</button>
              </div>
            </div>
          </div>
          ${totalWorst === 0 ? `<div style="color:var(--text-muted); font-size:0.85rem; padding:0.8rem; background:var(--bg-elevated); border-radius:8px;">${isAllStopsMode ? 'Cap parada coincideix amb el filtre.' : 'Sense punts negres registrats o cap parada coincideix amb el filtre.'}</div>` : `
            <div class="observatori-table-scroll-hint" aria-hidden="true">
              <span class="scroll-hint-icon">↔</span>
              <span>Desplaça en horitzontal per veure totes les dades</span>
              <span class="scroll-hint-chevron">›</span>
            </div>
            <div class="observatori-table-wrapper">
              <table class="observatori-table">
                <thead>
                  <tr>
                    <th class="sticky-col" data-sort-table="worstStops" data-sort-key="overallRank" role="button" tabindex="0">${isAllStopsMode ? 'Rànquing / Parada' : 'Rànquing / Parada (Punt Negre)'} ${getSortIndicator('worstStops', 'overallRank')}</th>
                    <th class="observatori-col-desktop" data-sort-table="worstStops" data-sort-key="lineCode" role="button" tabindex="0">Línia ${getSortIndicator('worstStops', 'lineCode')}</th>
                    <th class="observatori-col-desktop" data-sort-table="worstStops" data-sort-key="agency" role="button" tabindex="0">Operador ${getSortIndicator('worstStops', 'agency')}</th>
                    <th data-sort-table="worstStops" data-sort-key="avgDelay" role="button" tabindex="0">Retard Mitjà ${getSortIndicator('worstStops', 'avgDelay')}</th>
                    <th data-sort-table="worstStops" data-sort-key="severeLatePct" role="button" tabindex="0">% Retards Greus ${getSortIndicator('worstStops', 'severeLatePct')}</th>
                    <th data-sort-table="worstStops" data-sort-key="criticalHourAvgDelay" role="button" tabindex="0">Hora Crítica (Punta) ${getSortIndicator('worstStops', 'criticalHourAvgDelay')}</th>
                    <th class="observatori-col-desktop" data-sort-table="worstStops" data-sort-key="maxDelay" role="button" tabindex="0">Retard Màx. ${getSortIndicator('worstStops', 'maxDelay')}</th>
                  </tr>
                </thead>
                <tbody>
                  ${tableBodyHtml}
                </tbody>
              </table>
            </div>
            ${hasMoreWorst ? `
              <div style="display:flex; justify-content:center; align-items:center; gap:0.6rem; padding:0.75rem; background:var(--bg-elevated); border-top:1px solid var(--border-subtle); border-radius:0 0 10px 10px;">
                <button type="button" class="btn-primary observatori-action-btn" data-worst-limit="${worstLimit + 15}">
                  ⬇️ Mostra'n 15 més (${displayedWorstStops.length} de ${totalWorst})
                </button>
                <button type="button" class="btn-secondary observatori-action-btn" data-worst-limit="9999">
                  Totes (${totalWorst})
                </button>
              </div>
            ` : ''}
          `}
          ${this.renderStopHeatmap(displayedWorstStops)}
        </div>
        `;
      })()}

      <!-- Ranking: Operators Performance -->
      <div class="observatori-table-container" style="margin-bottom:1.5rem;">
        <div class="observatori-table-header-row">
          <h4 class="observatori-table-title">
            <span style="display:flex; align-items:center; gap:0.4rem;">Comparativa per Empresa Operadora</span>
          </h4>
          <span class="observatori-table-subtitle">Clica a les capçaleres per ordenar ↕</span>
        </div>
        ${agencies.length === 0 ? '<div style="color:var(--text-muted); font-size:0.85rem; padding:0.8rem; background:var(--bg-elevated); border-radius:8px;">Recopilant mostres d\'operadors...</div>' : `
          <div class="observatori-table-scroll-hint" aria-hidden="true">
            <span class="scroll-hint-icon">↔</span>
            <span>Desplaça en horitzontal per veure totes les dades</span>
            <span class="scroll-hint-chevron">›</span>
          </div>
          <div class="observatori-table-wrapper">
            <table class="observatori-table">
            <thead>
              <tr>
                <th class="sticky-col" data-sort-table="agencies" data-sort-key="agency" role="button" tabindex="0">Empresa ${getSortIndicator('agencies', 'agency')}</th>
                <th class="observatori-col-desktop" data-sort-table="agencies" data-sort-key="linesCount" role="button" tabindex="0">Línies ${getSortIndicator('agencies', 'linesCount')}</th>
                <th class="observatori-col-desktop" data-sort-table="agencies" data-sort-key="totalSamples" role="button" tabindex="0">Mostres ${getSortIndicator('agencies', 'totalSamples')}</th>
                <th data-sort-table="agencies" data-sort-key="avgDelay" role="button" tabindex="0">Retard Mitjà ${getSortIndicator('agencies', 'avgDelay')}</th>
                <th data-sort-table="agencies" data-sort-key="onTimePct" role="button" tabindex="0">Índex de Puntualitat ${getSortIndicator('agencies', 'onTimePct')}</th>
              </tr>
            </thead>
            <tbody>
              ${agencies.map(a => {
                const aAvg = Number(a.avgDelay) > 0 ? `+${a.avgDelay} min` : (Number(a.avgDelay) < 0 ? `${a.avgDelay} min` : '0.0 min');
                return `
                <tr>
                  <td class="sticky-col" style="font-weight:700; color:var(--text-primary);">${this.esc(a.agency)}</td>
                  <td class="observatori-col-desktop" style="color:var(--text-muted); text-align:center;">${a.linesCount || 0}</td>
                  <td class="observatori-col-desktop" style="color:var(--text-muted);">${(a.totalSamples || 0).toLocaleString()}</td>
                  <td style="font-weight:700; color:${Number(a.avgDelay) > 0 ? '#ef4444' : '#10b981'}; white-space:nowrap;">${aAvg}</td>
                  <td style="font-weight:700; color:${a.onTimePct >= 85 ? '#10b981' : '#f59e0b'}; white-space:nowrap;">${a.onTimePct || 100}%</td>
                </tr>
              `;}).join('')}
            </tbody>
          </table>
        </div>
      `}
      </div>

      <!-- Infrastructure Version & Audit Integrity -->
      ${report.snapshotInfo?.snapshots ? `
        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:1.1rem; margin-top:1.5rem;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:0.5rem; margin-bottom:0.75rem;">
            <div>
              <div style="font-size:0.75rem; font-weight:700; color:#38bdf8; text-transform:uppercase;">Integritat de la Xarxa i Canvis Operatius</div>
              <div style="font-size:0.95rem; font-weight:700; color:var(--text-primary); margin-top:0.2rem;">Traçabilitat d'Horaris i Traçats Oficials</div>
            </div>
            <div style="font-size:0.74rem; color:var(--text-muted);">
              Darrera auditoria: <strong>${new Date(report.snapshotInfo.generatedAt || Date.now()).toLocaleDateString()}</strong>
            </div>
          </div>
          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:0.65rem;">
            ${report.snapshotInfo.snapshots.map(snap => `
              <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:8px; padding:0.65rem 0.85rem;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <strong style="font-size:0.82rem; color:var(--text-primary);">${this.esc(snap.provider)}</strong>
                  <span style="font-size:0.7rem; background:rgba(16,185,129,0.15); color:#10b981; padding:1px 6px; border-radius:4px; font-weight:700;">Auditat</span>
                </div>
                <div style="font-size:0.72rem; color:var(--text-muted); margin-top:0.3rem;">
                  ${snap.summary.totalRoutes} línies • ${snap.summary.totalStops} parades troncals
                </div>
              </div>
            `).join('')}
          </div>

          ${report.snapshotInfo.diff ? `
            <div style="margin-top:0.75rem; font-size:0.74rem; color:var(--text-muted); display:flex; align-items:center; gap:0.4rem; border-top:1px solid var(--border-subtle); padding-top:0.6rem;">
              <span>Estat dels canvis:</span>
              <strong style="color:var(--text-primary);">${report.snapshotInfo.diff.status || 'Estable (Sense canvis en traçats ni parades en les darreres 72h)'}</strong>
            </div>
          ` : ''}
        </div>
      ` : ''}
    `;

    container.innerHTML = html;
    this.initObservatoriTableScrolls();
  }

  // ==========================================
  // 2. STOP DELAY HEATMAP MATRIX & DRILLDOWNS
  // ==========================================

  getLineColor(code) {
    const match = (this.availableLines || []).find(l => String(l.code || l.id).toUpperCase() === String(code).toUpperCase());
    return match?.color || 'var(--brand-primary)';
  }

  renderStopHeatmap(stops) {
    if (!stops.length) return '';
    if (!stops.every(stop => Array.isArray(stop.hourly))) return '<p>Detall horari pendent de la propera actualització.</p>';

    this._heatmapStops = stops;
    const hasData = h => stops.some(s => (s.hourly?.[h]?.sampleCount || 0) > 0);
    let visibleHours = Array.from({ length: 24 }, (_, h) => h).filter(hasData);
    if (!visibleHours.length) {
      visibleHours = Array.from({ length: 17 }, (_, i) => i + 6);
    }
    this._heatmapVisibleHours = visibleHours;

    const cell = (bucket, stopIdx, h) => {
      const b = bucket || { sampleCount: 0 };
      const label = b.sampleCount ? `${b.avgDelay} min; ${b.sampleCount} mostres; màxim ${b.maxDelay} min; ${b.severeLatePct}% amb retard ≥5 min` : 'Sense dades';
      const level = !b.sampleCount ? 'empty' : b.avgDelay >= 5 ? 'late' : b.avgDelay >= 3 ? 'moderate' : 'regular';
      return `<td class="stop-heat-cell heat-${level}" data-stop-idx="${stopIdx}" data-hour="${h}" role="button" tabindex="0" title="${this.esc(label)} (Clica per obrir el menú de detall)"><span aria-label="${this.esc(label)}">${b.sampleCount ? b.avgDelay : '—'}</span>${b.sampleCount > 0 && b.sampleCount < 5 ? '<small> *</small>' : ''}</td>`;
    };

    return `<section class="stop-hourly-section"><h4>Retard per parada i hora</h4>
      <p>Observacions registrades, no viatges únics ni causes de congestió. Hora local: Europe/Madrid. Valors en minuts. * Menys de 5 mostres. <strong>Clica a qualsevol franja horària o parada per obrir el menú de detall.</strong></p>
      <p class="stop-heat-legend"><span class="heat-regular">Menys de 3 min</span> <span class="heat-moderate">3–5 min</span> <span class="heat-late">5 min o més</span> <span>— Sense dades</span></p>
      <div class="observatori-table-wrapper stop-heatmap-wrapper"><table class="observatori-table stop-heatmap"><caption>Retard mitjà per hora (clica a una franja per al detall)</caption><thead><tr><th scope="col">Parada / línia</th>${visibleHours.map(h => `<th scope="col" data-hour="${h}" role="button" tabindex="0" title="Clica per veure el resum de les ${String(h).padStart(2, '0')}:00h">${String(h).padStart(2, '0')}</th>`).join('')}</tr></thead>
      <tbody>${stops.map((stop, stopIdx) => `<tr><th scope="row" data-stop-idx="${stopIdx}" role="button" tabindex="0" title="Clica per veure el menú de detall de ${this.esc(stop.stopName)}">${this.esc(stop.stopName)} / ${this.esc(stop.lineCode)}</th>${visibleHours.map(h => cell(stop.hourly?.[h], stopIdx, h)).join('')}</tr>`).join('')}</tbody></table></div>
      
      <!-- Single Drilldown Modal Menu -->
      <div class="modal-backdrop" id="stop-drilldown-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="stop-drilldown-modal-title" style="display:none;">
        <div class="modal-card stop-drilldown-modal" id="stop-drilldown-modal-content"></div>
      </div>
    </section>`;
  }

  openStopHourlyDrilldown(stopIdx, selectedHour = null) {
    const stops = this._heatmapStops || [];
    const stop = stops[stopIdx];
    if (!stop) return;

    this._activeDrilldownStopIdx = stopIdx;
    this._activeDrilldownHour = selectedHour !== null ? parseInt(selectedHour, 10) : null;

    const backdrop = document.getElementById('stop-drilldown-modal-backdrop');
    const content = document.getElementById('stop-drilldown-modal-content');
    if (!backdrop || !content) return;

    const visibleHours = this._heatmapVisibleHours || Array.from({ length: 24 }, (_, i) => i);
    const selH = this._activeDrilldownHour;
    const selectedBucket = selH !== null ? stop.hourly?.[selH] : null;
    const lColor = this.getLineColor(stop.lineCode);

    content.innerHTML = `
      <button type="button" class="modal-close-btn" id="stop-drilldown-close-btn" aria-label="Tancar finestra">&times;</button>
      <div class="stop-drilldown-header">
        <div style="display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;">
          <span class="stop-drilldown-line-badge" style="background:${lColor};">${this.esc(stop.lineCode)}</span>
          <h3 class="stop-drilldown-title" id="stop-drilldown-modal-title">${this.esc(stop.stopName)}</h3>
        </div>
        <p class="stop-drilldown-subtitle">
          Detall horari complet • ${stop.arrivalCount} observacions analitzades • Retard mitjà global: <strong>+${stop.avgDelay} min</strong> • Retard màxim: <strong>+${stop.maxDelay || 0} min</strong>
        </p>
      </div>

      ${selH !== null && selectedBucket ? `
        <div class="drilldown-hour-highlight">
          <div class="drilldown-kpi">
            <span class="drilldown-kpi-label">Franja Horària</span>
            <strong class="drilldown-kpi-val">${String(selH).padStart(2, '0')}:00 - ${String(selH).padStart(2, '0')}:59</strong>
          </div>
          <div class="drilldown-kpi">
            <span class="drilldown-kpi-label">Retard Mitjà</span>
            <strong class="drilldown-kpi-val ${selectedBucket.avgDelay >= 5 ? 'severe' : selectedBucket.avgDelay >= 3 ? 'warning' : 'ok'}">
              ${selectedBucket.sampleCount ? `+${selectedBucket.avgDelay} min` : 'Sense dades'}
            </strong>
          </div>
          <div class="drilldown-kpi">
            <span class="drilldown-kpi-label">Mostres Registrades</span>
            <strong class="drilldown-kpi-val">${selectedBucket.sampleCount || 0}</strong>
          </div>
          <div class="drilldown-kpi">
            <span class="drilldown-kpi-label">Retard Màxim</span>
            <strong class="drilldown-kpi-val">${selectedBucket.maxDelay !== null ? `+${selectedBucket.maxDelay} min` : '—'}</strong>
          </div>
          <div class="drilldown-kpi">
            <span class="drilldown-kpi-label">Viatges Retard &ge; 5m</span>
            <strong class="drilldown-kpi-val ${selectedBucket.severeLatePct >= 30 ? 'severe' : selectedBucket.severeLatePct >= 15 ? 'warning' : 'ok'}">
              ${selectedBucket.severeLatePct !== null ? `${selectedBucket.severeLatePct}%` : '—'}
            </strong>
          </div>
        </div>
      ` : ''}

      <div style="font-size:0.78rem; color:var(--text-muted); margin-bottom:0.4rem; display:flex; justify-content:space-between; align-items:center;">
        <span>Clica a qualsevol franja per canviar l'anàlisi destacada</span>
        <span>* Menys de 5 mostres</span>
      </div>

      <div class="observatori-table-wrapper" style="max-height: 48vh; overflow:auto;">
        <table class="observatori-table stop-drilldown-table">
          <thead>
            <tr>
              <th>Hora</th>
              <th>Mostres</th>
              <th>Mitjana (min)</th>
              <th>Màxim (min)</th>
              <th>Retard &ge; 5 min</th>
            </tr>
          </thead>
          <tbody>
            ${stop.hourly.filter(b => visibleHours.includes(parseInt(b.hour, 10))).map(b => {
              const bHour = parseInt(b.hour, 10);
              const isSelected = selH !== null && bHour === selH;
              return `
                <tr class="${isSelected ? 'drilldown-selected-row' : ''}" data-select-drilldown-hour="${bHour}" role="button" tabindex="0" title="Clica per seleccionar les ${b.hour}:00h">
                  <th scope="row" style="font-weight:700;">${b.hour}:00 ${isSelected ? '•' : ''}</th>
                  <td>${b.sampleCount}${b.sampleCount > 0 && b.sampleCount < 5 ? ' *' : ''}</td>
                  <td style="font-weight:${isSelected ? '800' : '600'}; color:${b.avgDelay >= 5 ? '#ef4444' : b.avgDelay >= 3 ? '#f59e0b' : 'var(--text-primary)'};">
                    ${b.avgDelay !== null ? `+${b.avgDelay} min` : '—'}
                  </td>
                  <td>${b.maxDelay !== null ? `+${b.maxDelay} min` : '—'}</td>
                  <td>${b.severeLatePct !== null ? `${b.severeLatePct}%` : '—'}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    backdrop.style.display = 'flex';
    requestAnimationFrame(() => {
      backdrop.classList.add('active');
    });
    document.body.style.overflow = 'hidden';
  }

  openHourSummaryDrilldown(hour) {
    const stops = this._heatmapStops || [];
    const h = parseInt(hour, 10);
    const stopsAtHour = stops.map((s, idx) => ({ ...s, stopIdx: idx, bucket: s.hourly?.[h] }))
      .filter(s => (s.bucket?.sampleCount || 0) > 0)
      .sort((a, b) => (b.bucket.avgDelay || 0) - (a.bucket.avgDelay || 0));

    const backdrop = document.getElementById('stop-drilldown-modal-backdrop');
    const content = document.getElementById('stop-drilldown-modal-content');
    if (!backdrop || !content) return;

    content.innerHTML = `
      <button type="button" class="modal-close-btn" id="stop-drilldown-close-btn" aria-label="Tancar finestra">&times;</button>
      <div class="stop-drilldown-header">
        <div style="display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;">
          <span class="stop-drilldown-line-badge" style="background:var(--brand-primary);">⏰ ${String(h).padStart(2, '0')}:00h</span>
          <h3 class="stop-drilldown-title" id="stop-drilldown-modal-title">Franja Horària ${String(h).padStart(2, '0')}:00 - ${String(h).padStart(2, '0')}:59</h3>
        </div>
        <p class="stop-drilldown-subtitle">
          Comparativa de retards a totes les parades a aquesta hora • ${stopsAtHour.length} parades registrades amb servei
        </p>
      </div>

      <div style="font-size:0.78rem; color:var(--text-muted); margin-bottom:0.4rem;">
        Clica a qualsevol parada per obrir el seu menú horari complet
      </div>

      <div class="observatori-table-wrapper" style="max-height: 55vh; overflow:auto;">
        <table class="observatori-table stop-drilldown-table">
          <thead>
            <tr>
              <th style="width:40px; text-align:center;">#</th>
              <th>Parada / Línia</th>
              <th>Mostres</th>
              <th>Retard Mitjà</th>
              <th>Retard Màxim</th>
              <th>Retard &ge; 5 min</th>
            </tr>
          </thead>
          <tbody>
            ${stopsAtHour.length === 0 ? `
              <tr><td colspan="6" style="text-align:center; padding:1.5rem; color:var(--text-muted);">Sense dades d'expedicions en aquesta franja horària.</td></tr>
            ` : stopsAtHour.map((s, idx) => {
              const b = s.bucket;
              const lColor = this.getLineColor(s.lineCode);
              return `
                <tr data-switch-stop-idx="${s.stopIdx}" data-switch-hour="${h}" role="button" tabindex="0" style="cursor:pointer;" title="Clica per obrir el detall complet de ${this.esc(s.stopName)}">
                  <td style="font-weight:700; color:var(--text-muted); text-align:center;">${idx + 1}</td>
                  <td style="font-weight:600; color:var(--text-primary);">
                    <div style="display:flex; align-items:center; gap:0.4rem;">
                      <span style="background:${lColor}; color:#fff; padding:0.1rem 0.35rem; border-radius:4px; font-size:0.7rem; font-weight:800;">${this.esc(s.lineCode)}</span>
                      <span>${this.esc(s.stopName)}</span>
                    </div>
                  </td>
                  <td>${b.sampleCount}${b.sampleCount > 0 && b.sampleCount < 5 ? ' *' : ''}</td>
                  <td style="font-weight:700; color:${b.avgDelay >= 5 ? '#ef4444' : b.avgDelay >= 3 ? '#f59e0b' : 'var(--text-primary)'};">
                    ${b.avgDelay !== null ? `+${b.avgDelay} min` : '—'}
                  </td>
                  <td>${b.maxDelay !== null ? `+${b.maxDelay} min` : '—'}</td>
                  <td>${b.severeLatePct !== null ? `${b.severeLatePct}%` : '—'}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    backdrop.style.display = 'flex';
    requestAnimationFrame(() => {
      backdrop.classList.add('active');
    });
    document.body.style.overflow = 'hidden';
  }

  closeStopHourlyDrilldown() {
    const backdrop = document.getElementById('stop-drilldown-modal-backdrop');
    if (backdrop) {
      backdrop.classList.remove('active');
      setTimeout(() => {
        backdrop.style.display = 'none';
      }, 200);
    }
    document.body.style.overflow = '';
  }

  initObservatoriTableScrolls() {
    requestAnimationFrame(() => {
      const wrappers = document.querySelectorAll('.observatori-table-wrapper');
      wrappers.forEach(wrapper => {
        const updateScrollState = () => {
          const maxScroll = wrapper.scrollWidth - wrapper.clientWidth;
          const canScroll = maxScroll > 4;

          const parentContainer = wrapper.closest('.observatori-table-container');
          const hint = parentContainer ? parentContainer.querySelector('.observatori-table-scroll-hint') : null;

          if (canScroll) {
            wrapper.classList.toggle('has-scroll-left', wrapper.scrollLeft > 5);
            wrapper.classList.toggle('has-scroll-right', wrapper.scrollLeft < maxScroll - 5);
            wrapper.classList.toggle('is-scrolled', wrapper.scrollLeft > 5);
            if (hint) {
              hint.style.display = (window.innerWidth <= 768) ? 'inline-flex' : 'none';
            }
          } else {
            wrapper.classList.remove('has-scroll-left', 'has-scroll-right', 'is-scrolled');
            if (hint) {
              hint.style.display = 'none';
            }
          }

          const maxScrollY = wrapper.scrollHeight - wrapper.clientHeight;
          if (maxScrollY > 4) {
            wrapper.classList.toggle('is-scrolled-vertical', wrapper.scrollTop > 5);
          } else {
            wrapper.classList.remove('is-scrolled-vertical');
          }
        };

        if (wrapper._observatoriScrollHandler) {
          wrapper.removeEventListener('scroll', wrapper._observatoriScrollHandler);
        }
        wrapper._observatoriScrollHandler = updateScrollState;
        wrapper.addEventListener('scroll', updateScrollState, { passive: true });

        updateScrollState();
      });
    });
  }

  // ==========================================
  // 3. EL TERMÒMETRE SCORECARD & INFOGRAPHIC
  // ==========================================

  async loadTermometre(hours = 24, force = false) {
    const termometreContainer = document.getElementById('journalism-termometre-container');
    const contentContainer = document.getElementById('journalism-content-container');
    const incidentsContainer = document.getElementById('journalism-incidents-container');
    const searchBarWrap = document.getElementById('journalism-search-bar-wrap');

    if (searchBarWrap) searchBarWrap.style.display = 'none';
    if (contentContainer) contentContainer.style.display = 'none';
    if (incidentsContainer) incidentsContainer.style.display = 'none';
    if (termometreContainer) {
      termometreContainer.style.display = 'block';
      if (!this.termometreData || force) {
        termometreContainer.innerHTML = '<div style="text-align:center; padding:3rem;"><span class="loading-spinner-inline"></span> Generant la fitxa del Termòmetre...</div>';
      }
    }

    try {
      const res = await fetch(`/api/analytics/termometre?hours=${hours}`).then(r => r.json());
      if (res && res.success && res.termometre) {
        this.termometreData = res.termometre;
        this.renderTermometreScorecard(res.termometre);
      } else {
        if (termometreContainer) {
          termometreContainer.innerHTML = '<div style="color:var(--danger); text-align:center; padding:2rem;">No s\'ha pogut generar el Termòmetre.</div>';
        }
      }
    } catch {
      if (termometreContainer) {
        termometreContainer.innerHTML = '<div style="color:var(--danger); text-align:center; padding:2rem;">Error de connexió al carregar el Termòmetre.</div>';
      }
    }
  }

  renderTermometreScorecard(t) {
    const container = document.getElementById('journalism-termometre-container');
    if (!container || !t) return;

    // An empty window is NOT a perfect score. The API sends explicit nulls and
    // noData:true; the old renderer substituted its own placeholder scorecard
    // (grade "A", L1 at 95%, "Pl. Tereses", 08:00-09:00 peak) and the share and
    // PNG exporters published those invented numbers as real measurements.
    // A payload that grades a scorecard while analysing zero trips is
    // self-contradictory, so it is treated as no-data too — that also covers a
    // report cache written before this contract existed.
    if (t.noData || t.grade === null || t.grade === undefined || (t.totalTripsAnalyzed || 0) === 0) {
      this._renderTermometreNoData(container, t);
      return;
    }

    const gradeColor = (t.grade && t.grade.startsWith('A')) ? '#10b981' : ((t.grade && t.grade.startsWith('B')) ? '#38bdf8' : ((t.grade && t.grade.startsWith('C')) ? '#f59e0b' : '#ef4444'));
    // A missing sub-value stays missing. Each `—` below means "not measured",
    // which is different from a measured 0.
    const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);
    const mins = (v) => (v === null || v === undefined ? '—' : `+${v} min`);
    const championPct = t.championLine && t.championLine.onTimePct !== null && t.championLine.onTimePct !== undefined
      ? `${t.championLine.onTimePct}%` : '—';

    container.innerHTML = `
      <div class="termometre-scorecard" id="termometre-card-root">
        <div class="termometre-header">
          <div>
            <span style="font-size:0.75rem; font-weight:800; color:#38bdf8; text-transform:uppercase; letter-spacing:0.5px;">Observatori Cívic de Mobilitat</span>
            <h3 style="font-size:1.35rem; font-weight:800; color:#fff; margin:0.2rem 0;">El Termòmetre del Bus Mataró</h3>
            <span style="font-size:0.78rem; color:var(--text-muted);">Auditoria independent basada en mostres reals de telemetria GPS</span>
          </div>
          <div class="termometre-grade-badge" style="border-color:${gradeColor}; background:rgba(16,185,129,0.12);">
            <div>
              <div style="font-size:0.65rem; font-weight:800; color:var(--text-muted); text-transform:uppercase;">Nota Global</div>
              <div class="termometre-grade-letter" style="color:${gradeColor};">${this.esc(t.grade)}</div>
            </div>
          </div>
        </div>

        <div class="termometre-metrics-grid">
          <div class="termometre-metric-tile" style="border-left:3px solid #10b981;">
            <span class="termometre-metric-label">Línia Més Puntual</span>
            <span class="termometre-metric-val" style="color:#10b981;">
              ${t.championLine ? this.esc(t.championLine.code) : '—'} (${championPct} puntual)
            </span>
            <span style="font-size:0.72rem; color:var(--text-muted);">Retard mitjà: ${t.championLine ? mins(t.championLine.avgDelay) : '—'}</span>
          </div>

          <div class="termometre-metric-tile" style="border-left:3px solid #ef4444;">
            <span class="termometre-metric-label">Punt Negre / Retards</span>
            <span class="termometre-metric-val" style="color:#ef4444; font-size:1rem;">
              ${t.worstBottleneck ? this.esc(t.worstBottleneck.stopName) : '—'}
            </span>
            <span style="font-size:0.72rem; color:var(--text-muted);">${t.worstBottleneck ? this.esc(t.worstBottleneck.lineCode || '') : ''} • ${t.worstBottleneck ? mins(t.worstBottleneck.avgDelay) : '—'} retard mitjà</span>
          </div>

          <div class="termometre-metric-tile" style="border-left:3px solid #f59e0b;">
            <span class="termometre-metric-label">Franja de Major Congestió</span>
            <span class="termometre-metric-val" style="color:#f59e0b;">
              ${t.peakHour ? this.esc(t.peakHour) : '—'}
            </span>
            <span style="font-size:0.72rem; color:var(--text-muted);">${t.peakHour ? mins(t.peakHourDelay) : '—'} de retard mitjà a la xarxa</span>
          </div>

          <div class="termometre-metric-tile" style="border-left:3px solid #38bdf8;">
            <span class="termometre-metric-label">Puntualitat Global</span>
            <span class="termometre-metric-val" style="color:#38bdf8;">
              ${pct(t.punctualityPct)}
            </span>
            <span style="font-size:0.72rem; color:var(--text-muted);">${(t.totalTripsAnalyzed || 0).toLocaleString()} mostres analitzades</span>
          </div>
        </div>

        <div class="termometre-actions-row">
          <div style="font-size:0.75rem; color:var(--text-muted);">
            Dades de les darreres ${t.timeframeHours || 24} hores
          </div>
          <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
            <button type="button" class="btn-primary btn-termometre-action" id="btn-termometre-share">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              <span>Copiar Resum per Xarxes</span>
            </button>
            <button type="button" class="btn-secondary btn-termometre-action" id="btn-termometre-download">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              <span>Descarregar Fitxa</span>
            </button>
          </div>
        </div>
      </div>
    `;

    document.getElementById('btn-termometre-share')?.addEventListener('click', (e) => {
      e.preventDefault();
      const shareText = `🌡️ El Termòmetre del Bus a Mataró (${t.timeframeHours || 24}h)\n\n` +
        `• Nota Global: ${t.grade} (${pct(t.punctualityPct)} puntualitat)\n` +
        `• 🏆 Línia més puntual: ${t.championLine ? t.championLine.code : '—'} (${championPct})\n` +
        `• ⚠️ Punt negre: ${t.worstBottleneck ? t.worstBottleneck.stopName : '—'} (${t.worstBottleneck ? mins(t.worstBottleneck.avgDelay) : '—'})\n` +
        `• ⏱️ Hora punta: ${t.peakHour || '—'}\n` +
        `• Mostres analitzades: ${(t.totalTripsAnalyzed || 0).toLocaleString()}\n\n` +
        `Font: Arribo! Mataró — Dades obertes i telemetria ciutadana.`;

      if (navigator.clipboard) {
        navigator.clipboard.writeText(shareText).then(() => {
          alert("Resum copiat al porta-retalls! Ja el pots enganxar a Twitter, Telegram o premsa.");
        });
      } else {
        prompt("Copia el resum:", shareText);
      }
    });

    document.getElementById('btn-termometre-download')?.addEventListener('click', (e) => {
      e.preventDefault();
      const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 420" width="800" height="420" style="background:#0f172a; font-family:sans-serif;">
  <rect width="800" height="420" fill="#0f172a" rx="16"/>
  <text x="40" y="50" fill="#38bdf8" font-size="14" font-weight="bold" letter-spacing="1">OBSERVATORI CÍVIC DE MOBILITAT</text>
  <text x="40" y="85" fill="#ffffff" font-size="26" font-weight="bold">🌡️ El Termòmetre del Bus Mataró</text>
  <text x="40" y="110" fill="#94a3b8" font-size="13">Informe de puntualitat i retards (${t.timeframeHours || 24}h)</text>

  <rect x="660" y="35" width="95" height="75" rx="10" fill="#1e293b" stroke="${gradeColor}" stroke-width="2"/>
  <text x="707" y="58" fill="#94a3b8" font-size="11" text-anchor="middle" font-weight="bold">NOTA</text>
  <text x="707" y="96" fill="${gradeColor}" font-size="34" text-anchor="middle" font-weight="bold">${this.esc(t.grade)}</text>

  <rect x="40" y="140" width="345" height="100" rx="10" fill="#1e293b" stroke="#10b981" stroke-width="1.5"/>
  <text x="60" y="170" fill="#10b981" font-size="13" font-weight="bold">🏆 LÍNIA MÉS PUNTUAL</text>
  <text x="60" y="202" fill="#ffffff" font-size="20" font-weight="bold">${t.championLine ? this.esc(t.championLine.code) : '—'} (${championPct} puntual)</text>
  <text x="60" y="225" fill="#94a3b8" font-size="12">Retard mitjà: ${t.championLine ? mins(t.championLine.avgDelay) : '—'}</text>

  <rect x="415" y="140" width="345" height="100" rx="10" fill="#1e293b" stroke="#ef4444" stroke-width="1.5"/>
  <text x="435" y="170" fill="#ef4444" font-size="13" font-weight="bold">⚠️ PUNT NEGRE / RETARDS</text>
  <text x="435" y="202" fill="#ffffff" font-size="18" font-weight="bold">${t.worstBottleneck ? this.esc(t.worstBottleneck.stopName) : '—'}</text>
  <text x="435" y="225" fill="#94a3b8" font-size="12">${t.worstBottleneck ? this.esc(t.worstBottleneck.lineCode || '') : ''} • ${t.worstBottleneck ? mins(t.worstBottleneck.avgDelay) : '—'} retard mitjà</text>

  <rect x="40" y="260" width="345" height="100" rx="10" fill="#f59e0b" stroke="#1.5"/>
  <text x="60" y="290" fill="#f59e0b" font-size="13" font-weight="bold">⏱️ HORA PUNTA CONGESTIÓ</text>
  <text x="60" y="322" fill="#ffffff" font-size="20" font-weight="bold">${t.peakHour ? this.esc(t.peakHour) : '—'}</text>
  <text x="60" y="345" fill="#94a3b8" font-size="12">${t.peakHour ? mins(t.peakHourDelay) : '—'} de retard mitjà a la xarxa</text>

  <rect x="415" y="260" width="345" height="100" rx="10" fill="#1e293b" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="435" y="290" fill="#38bdf8" font-size="13" font-weight="bold">🌐 PUNTUALITAT GLOBAL</text>
  <text x="435" y="322" fill="#ffffff" font-size="20" font-weight="bold">${pct(t.punctualityPct)} (${(t.totalTripsAnalyzed || 0).toLocaleString()} mostres)</text>
  <text x="435" y="345" fill="#94a3b8" font-size="12">Mitjana xarxa: ${mins(t.networkAvgDelay)} retard</text>

  <text x="40" y="395" fill="#64748b" font-size="12">Arribo! Mataró • Dades oficials en temps real • Avanza / Ajuntament de Mataró</text>
</svg>`;
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `termometre-bus-mataro-${t.timeframeHours || 24}h.svg`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  /**
   * Honest empty state: no grade, no invented champion line, no invented
   * bottleneck, no invented peak hour, and the share/PNG buttons are withheld
   * because there is nothing true to export.
   */
  _renderTermometreNoData(container, t) {
    const hours = (t && t.timeframeHours) || 24;
    container.innerHTML = `
      <div class="termometre-scorecard" id="termometre-card-root">
        <div class="termometre-header">
          <div>
            <span style="font-size:0.75rem; font-weight:800; color:#38bdf8; text-transform:uppercase; letter-spacing:0.5px;">Observatori Cívic de Mobilitat</span>
            <h3 style="font-size:1.35rem; font-weight:800; color:#fff; margin:0.2rem 0;">El Termòmetre del Bus Mataró</h3>
            <span style="font-size:0.78rem; color:var(--text-muted);">Dades de les darreres ${hours} hores</span>
          </div>
          <div class="termometre-grade-badge" style="border-color:var(--border-subtle); background:rgba(148,163,184,0.08);">
            <div>
              <div style="font-size:0.65rem; font-weight:800; color:var(--text-muted); text-transform:uppercase;">Nota Global</div>
              <div class="termometre-grade-letter" style="color:var(--text-muted);">—</div>
            </div>
          </div>
        </div>

        <div style="margin:1.25rem 0; padding:1rem 1.1rem; background:rgba(251,191,36,0.07); border:1px solid rgba(251,191,36,0.25); border-radius:10px; font-size:0.82rem; line-height:1.5; color:var(--text-secondary);">
          <strong style="color:#f59e0b;">Sense dades per puntuar.</strong>
          No hi ha cap mostra de retard registrada en aquesta finestra temporal, així que no hi ha nota global,
          ni línia més puntual, ni punt negre, ni hora punta. Aquest Termòmetre no es publica ni s'exporta
          fins que hi hagi mostres reals: sense mostres, la puntualitat no es mesura.
        </div>

        <div class="termometre-metrics-grid">
          <div class="termometre-metric-tile" style="border-left:3px solid var(--border-subtle);">
            <span class="termometre-metric-label">Línia Més Puntual</span>
            <span class="termometre-metric-val" style="color:var(--text-muted);">—</span>
            <span style="font-size:0.72rem; color:var(--text-muted);">Sense mostres</span>
          </div>
          <div class="termometre-metric-tile" style="border-left:3px solid var(--border-subtle);">
            <span class="termometre-metric-label">Punt Negre / Retards</span>
            <span class="termometre-metric-val" style="color:var(--text-muted); font-size:1rem;">—</span>
            <span style="font-size:0.72rem; color:var(--text-muted);">Sense mostres</span>
          </div>
          <div class="termometre-metric-tile" style="border-left:3px solid var(--border-subtle);">
            <span class="termometre-metric-label">Franja de Major Congestió</span>
            <span class="termometre-metric-val" style="color:var(--text-muted);">—</span>
            <span style="font-size:0.72rem; color:var(--text-muted);">Sense mostres</span>
          </div>
          <div class="termometre-metric-tile" style="border-left:3px solid var(--border-subtle);">
            <span class="termometre-metric-label">Puntualitat Global</span>
            <span class="termometre-metric-val" style="color:var(--text-muted);">—</span>
            <span style="font-size:0.72rem; color:var(--text-muted);">0 mostres analitzades</span>
          </div>
        </div>
      </div>
    `;
  }

  // ==========================================
  // 4. TOP INCIDENTS (+25M) DEEP-DIVE
  // ==========================================

  openDelayIncidentsTab(lineCode = 'all', force = false) {
    const incidentsContainer = document.getElementById('journalism-incidents-container');
    const termometreContainer = document.getElementById('journalism-termometre-container');
    const contentContainer = document.getElementById('journalism-content-container');
    const searchBarWrap = document.getElementById('journalism-search-bar-wrap');

    if (searchBarWrap) searchBarWrap.style.display = 'none';
    if (contentContainer) contentContainer.style.display = 'none';
    if (termometreContainer) termometreContainer.style.display = 'none';
    if (incidentsContainer) incidentsContainer.style.display = 'block';

    const hours = this._currentIncidentHours || 168;
    this.openDelayIncidentsView(lineCode, hours, this._currentIncidentMode || 'top', 0, force);
  }

  async openDelayIncidentsView(lineCode = 'all', hours = 168, viewMode = 'top', retryCount = 0, forceRefresh = false) {
    this._currentIncidentLine = lineCode;
    this._currentIncidentHours = hours;
    this._currentIncidentMode = viewMode;

    const container = document.getElementById('journalism-incidents-container');
    if (!container) return;

    const cacheKey = `${lineCode}:${hours}`;
    if (!forceRefresh && retryCount === 0 && this._incidentCache) {
      const cached = this._incidentCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp < 45000)) {
        this.lastIncidentData = cached.data;
        this.renderDelayIncidentsView(cached.data, lineCode, hours, viewMode);
        return;
      }
    }

    const cleanLabel = (lineCode === 'all' || lineCode === 'ALL') ? 'tota la xarxa' : lineCode;
    const retryMsg = retryCount > 0 ? ' (sincronitzant amb el procés de fons...)' : '';
    container.innerHTML = `
      <div style="text-align:center; padding:3rem 1rem; color:var(--text-muted);">
        <span class="loading-spinner-inline" style="width:24px; height:24px; border-width:3px; margin-bottom:0.75rem;"></span>
        <div style="font-weight:700; font-size:0.95rem; color:var(--text-primary); margin-top:0.5rem;">Analitzant telemetria històrica...</div>
        <div style="font-size:0.8rem; margin-top:0.25rem;">Cercant incidents crítics i traçant trajectòries per a ${cleanLabel}${retryMsg}</div>
      </div>
    `;

    try {
      const cleanLine = encodeURIComponent(lineCode);
      const res = await fetch(`/api/analytics/incidents?line=${cleanLine}&hours=${hours}&limit=30&minDelay=5`).then(r => r.json());
      if (res && res.success) {
        if (this._incidentCache) {
          this._incidentCache.set(cacheKey, { data: res, timestamp: Date.now() });
        }
        this.lastIncidentData = res;
        this.renderDelayIncidentsView(res, lineCode, hours, viewMode);
      } else {
        if (retryCount === 0) {
          setTimeout(() => this.openDelayIncidentsView(lineCode, hours, viewMode, 1, forceRefresh), 2000);
          return;
        }
        this.renderIncidentErrorState(container, lineCode, hours, viewMode);
      }
    } catch {
      if (retryCount === 0) {
        setTimeout(() => this.openDelayIncidentsView(lineCode, hours, viewMode, 1, forceRefresh), 2000);
        return;
      }
      this.renderIncidentErrorState(container, lineCode, hours, viewMode);
    }
  }

  async openIncidentDrilldown(lineCode, stopName, at) {
    const panel = document.getElementById('incident-drilldown-panel');
    const content = document.getElementById('drilldown-content');
    const summary = document.getElementById('drilldown-summary');
    if (!panel || !content || !summary) return;
    panel.style.display = 'block';
    content.innerHTML = '<span style="color:var(--text-muted);">Carregant investigació…</span>';
    summary.innerHTML = '';
    panel.scrollIntoView({ behavior: 'smooth' });
    try {
      const params = new URLSearchParams({ line: lineCode, stop: stopName });
      if (at > 0) params.set('at', String(at));
      const res = await fetch(`/api/analytics/incidents/inspect?${params}`);
      const data = await res.json();
      if (!data || data.found === false) {
        content.innerHTML = `<span style="color:#fb7185;">No es poden carregar mostres en aquesta finestra. ${data?.error || ''}</span>`;
        summary.innerHTML = `<p style="color:var(--text-muted); font-size:0.82rem;">Cap mostra amb retard ≥5 minuts en els darrers 60 minuts per ${this.esc(lineCode)} @ ${this.esc(stopName)}.</p>`;
        return;
      }
      const ep = data.episode || {};
      const ev = ep.evidence || {};
      const verdictColors = { corroborated: '#34d399', derived_only: '#a78bfa', poll_inflated: '#f59e0b', unverifiable: '#fb7185', telemetry_anomaly: '#94a3b8' };
      const verdictLabel = verdictColors[ep.verdict] || '#fff';
      const vehicleBadge = ep.distinctVehicles.length
        ? ep.distinctVehicles.map(v => `<span style="background:rgba(255,255,255,0.08); padding:2px 6px; border-radius:4px; font-size:0.74rem;">${this.esc(v)}</span>`).join(' ')
        : ev.vehicleIdGapExplained
          ? '<span style="color:#fb7185;">cap vehicle_id — <span style="opacity:0.8;">aquestes files són anteriors a la columna</span></span>'
          : '<span style="color:#fb7185;">cap vehicle_id registrat</span>';
      // Three distinct time provenances, never two: a real upstream observation,
      // a live derivation from the static timetable, and an offline backfilled
      // approximation. The server classifies every row (timesProvenance) so the
      // UI never re-derives the rule with a string comparison.
      const timesBadge = ev.rowsWithObservedTimes > 0
        ? `<span style="color:#34d399;">${ev.rowsWithObservedTimes} mostres amb horari observat pel feed</span>`
          + (ev.rowsWithDerivedTimes > 0 ? ` <span style="color:var(--text-muted);">+ ${ev.rowsWithDerivedTimes} derivades</span>` : '')
          + (ev.rowsWithBackfilledTimes > 0 ? ` <span style="color:var(--text-muted);">+ ${ev.rowsWithBackfilledTimes} reomplenes</span>` : '')
        : ev.rowsWithBackfilledTimes > 0
          ? `<span style="color:#fbbf24;">${ev.rowsWithBackfilledTimes} mostres amb horari <strong>aproximat offline</strong> (no observat)</span>`
          : ev.rowsWithDerivedTimes > 0
            ? `<span style="color:#a78bfa;">${ev.rowsWithDerivedTimes} mostres amb horari <strong>derivat</strong> del horari teòric</span>`
            : '<span style="color:#fb7185;">cap mostra amb horari teòric ni real</span>';
      const snapshotBadge = ev.snapshotTrailPoints >= 2 ? `<span style="color:#34d399;">${ev.snapshotTrailPoints} punts GPS</span>` : '<span style="color:#fb7185;">cap traçal GPS proper</span>';
      summary.innerHTML = `
        <table style="width:100%; border-collapse:collapse; font-size:0.82rem;">
          <tr><td style="color:var(--text-muted); padding:3px 0;">Veïnatge</td><td style="color:${verdictLabel}; font-weight:600;">${this.esc(ep.verdictLabel)}</td></tr>
          <tr><td style="color:var(--text-muted); padding:3px 0;">Vehicles</td><td style="color:var(--text-secondary);">${vehicleBadge}</td></tr>
          <tr><td style="color:var(--text-muted); padding:3px 0;">Horaris</td><td style="color:var(--text-secondary);">${timesBadge}</td></tr>
          <tr><td style="color:var(--text-muted); padding:3px 0;">Traçal</td><td style="color:var(--text-secondary);">${snapshotBadge}</td></tr>
          <tr><td style="color:var(--text-muted); padding:3px 0;">Linies retirades</td><td style="color:${data.dataQuality?.retiredScopeLinesPresent ? '#fb7185' : '#34d399'};">${data.dataQuality?.retiredScopeLinesPresent ? 'Sí — hi ha dades de línies extintes' : 'No'}</td></tr>
          <tr><td style="color:var(--text-muted); padding:3px 0;">Proveniència horària</td><td style="color:var(--text-secondary);">${this._timesProvenanceLabel(ep.timesProvenance || ev.timesProvenance)}</td></tr>
          <tr><td style="color:var(--text-muted); padding:3px 0;">Total mostres raw</td><td style="color:var(--text-secondary);">${data.dataQuality?.totalRawRows || 0} → ${data.dataQuality?.episodesInWindow || 0} episodis</td></tr>
        </table>
        ${ep.timetableCheck?.backfilledFromTimetable ? '<p style="color:#fbbf24; font-size:0.78rem; margin:8px 0 0;">L\'horari teòric i real d\'aquestes mostres s\'ha <strong>aproximat offline</strong> (scripts/backfill_delay_times.js) a partir del quadre horari estàtic, endevinant el sentit de circulació. No és una observació del feed ni una derivació en viu, i per tant <strong>no corrobora</strong> el retard: només hi serveix de contextualització.</p>' : ''}
        ${ep.timetableCheck?.derivedFromTimetable && !ep.timetableCheck?.backfilledFromTimetable ? '<p style="color:#a78bfa; font-size:0.78rem; margin:8px 0 0;">L\'horari teòric i real d\'aquestes mostres s\'ha <strong>derivat</strong> del quadre horari estàtic: el feed upstream només dona el retard, mai l\'hora amb què es compara. Serveix per contextualitzar, però no és una observació independent.</p>' : ''}
        ${ev.vehicleIdNote ? `<p style="color:var(--text-muted); font-size:0.78rem; margin:6px 0 0;">${this.esc(ev.vehicleIdNote)}</p>` : ''}
      `;
      const rawHtml = (ep.rawRows || []).map(r => {
        const vB = r.vehicleId ? this.esc(r.vehicleId) : '<span style="color:#fb7185;">—</span>';
        // Colour comes from the server-side classification (timesProvenance),
        // never from a local string comparison on times_source.
        const tB = !r.hasTimes
          ? '<span style="color:#fb7185;">no</span>'
          : r.timesProvenance === 'derived_timetable_backfill'
            ? `<span style="color:#fbbf24;" title="Aproximació offline del quadre horari (sentit endevinat)">${this.esc((r.scheduledTime || '').slice(0, 5))}→${this.esc((r.actualTime || '').slice(0, 5))} reomplert</span>`
            : r.timesProvenance === 'derived_timetable'
              ? `<span style="color:#a78bfa;" title="Derivat en viu del quadre horari estàtic">${this.esc((r.scheduledTime || '').slice(0, 5))}→${this.esc((r.actualTime || '').slice(0, 5))} derivat</span>`
              : `<span style="color:#34d399;" title="Hora reportada pel feed upstream">${this.esc((r.scheduledTime || '').slice(0, 5))}→${this.esc((r.actualTime || '').slice(0, 5))}</span>`;
        return `<div style="padding:4px 0; border-bottom:1px solid var(--border-subtle); font-size:0.78rem; display:flex; justify-content:space-between; gap:0.5rem; flex-wrap:wrap;">
          <span style="color:var(--text-secondary);">${this.esc(r.formattedDate)}</span>
          <span style="color:${r.delayMins >= 20 ? '#ef4444' : '#f59e0b'}; font-weight:700;">+${r.delayMins} min</span>
          <span style="color:var(--text-muted);">${r.stopName}</span>
          <span>${vB}</span> <span>${tB}</span> <span>${r.isRealTime ? 'GPS' : 'estim'}</span>
        </div>`;
      }).join('');
      content.innerHTML = `
        <div style="margin-bottom:0.6rem;">
          <strong style="color:#fff;">Pics d'aquest episodi:</strong>
          <span style="color:#fff; font-weight:800;"> ${ep.peakDelayMins} min</span>
          <span style="color:var(--text-muted); font-size:0.78rem;"> (${this.esc(ep.start)} → ${this.esc(ep.end)}, ${ep.durationMinutes.toFixed(1)} min)</span>
        </div>
        <div style="margin-bottom:0.6rem; font-size:0.78rem; color:#fbbf24;">
          ⚠️ Aquest episodi agrupa ${ep.rowCount} mostres brutes de registre cada 20 s. El nombre d'"incidents" que apareix al rànquing és el compte de mostres, no de viatges.
        </div>
        <div style="max-height:320px; overflow:auto;">${rawHtml || '<span style="color:var(--text-muted);">Cap mostra</span>'}</div>
      `;
    } catch (e) {
      content.innerHTML = `<span style="color:#ef4444;">Error carregant la investigació: ${this.esc(e.message)}</span>`;
    }
  }

  /** Human label for the server-side times_provenance classification. */
  _timesProvenanceLabel(provenance) {
    switch (provenance) {
      case 'observed': return '<span style="color:#34d399;">Horari observat pel feed upstream</span>';
      case 'derived_timetable': return '<span style="color:#a78bfa;">Derivat del quadre horari (en viu)</span>';
      case 'derived_timetable_backfill': return '<span style="color:#fbbf24;">Aproximació offline del quadre horari</span>';
      case 'mixed': return '<span style="color:var(--text-secondary);">Mixta (consulta les mostres individuals)</span>';
      default: return '<span style="color:var(--text-muted);">Cap horari disponible</span>';
    }
  }

  _renderIncidentDataQualityBanner(s) {
    const q = s.dataQuality || {};
    if (!q.totalRawRows && !q.rowsWithoutVehicleId) return '';
    return `
      <div style="background:rgba(251,191,36,0.07); border:1px solid rgba(251,191,36,0.25); border-radius:12px; padding:0.85rem 1rem; margin-bottom:1.25rem;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:0.75rem; flex-wrap:wrap;">
          <div>
            <div style="font-size:0.78rem; font-weight:800; color:#f59e0b;">Què compten exactament aquestes xifres</div>
            <div style="font-size:0.76rem; color:var(--text-secondary); margin-top:0.2rem; line-height:1.5;">
              Els KPIs (${this._fmtCount(s.rawSamplesOverThreshold ?? s.totalRecordedIncidents)} mostres, ${this._fmtCount(s.worstStopCount)} a ${this.esc(s.worstStop || 'cap parada')}) són
              <strong>mostres raw</strong>: un mateix autobús hi apareix cada 20 s. Les taules de dalt, en canvi, mostren
              <strong>epodis deduplicats</strong>${s.listedCommercialEpisodes !== undefined ? ` (${this._fmtCount(s.listedCommercialEpisodes)} de servei, arrodonits al límit de ${s.commercialEpisodeLimit})` : ''}:
              no són xifres comparables entre elles.
            </div>
            <div style="font-size:0.76rem; color:var(--text-secondary); margin-top:0.35rem; line-height:1.5;">
              ${q.episodesNote ? this.esc(q.episodesNote) : ''}
            </div>
            ${(s.nonRealtimeSampleCount || 0) > 0 ? `
              <div style="font-size:0.76rem; color:var(--text-secondary); margin-top:0.35rem; line-height:1.5;">
                D'aquestes mostres, <strong>${this._fmtCount(s.nonRealtimeSampleCount)} (${s.nonRealtimeSamplePct}%)</strong> són
                posicions extrapolades (dead-reckoning) i no GPS fresc. S'inclouen perquè el retard registrat és real, però no són una observació directa de la posició.
              </div>
            ` : ''}
          </div>
          <div style="font-size:0.74rem; color:var(--text-muted); text-align:right;">
            ${this._fmtCount(q.totalRawRows)} mostres raw<br>
            ${this._fmtCount(q.rowsWithoutVehicleId)} sense vehicle<br>
            ${this._fmtCount(q.rowsWithoutProvenance)} sense horari<br>
            ${this._fmtCount(q.distinctEpisodes)} episodis de retard${q.episodeGapMinutes ? ` (≤${q.episodeGapMinutes} min)` : ''}
          </div>
        </div>
      </div>
    `;
  }

  _fmtCount(n) {
    return (Number(n) || 0).toLocaleString('ca-ES');
  }

  renderIncidentErrorState(container, lineCode, hours, viewMode) {
    container.innerHTML = `
      <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:12px; padding:2.5rem 1.5rem; text-align:center; color:var(--text-muted); max-width:540px; margin:2rem auto;">
        <div style="font-size:2rem; margin-bottom:0.6rem;">⏱️</div>
        <div style="font-weight:700; font-size:1.05rem; color:var(--text-primary); margin-bottom:0.4rem;">El servidor està processant les dades de ${hours}h</div>
        <p style="font-size:0.82rem; margin:0 0 1.25rem 0; line-height:1.45;">
          Quan es calculen informes de 7 dies o es reindexa la telemetria històrica en segon pla, pot trigar uns instants a sincronitzar.
        </p>
        <button type="button" class="btn-primary" id="btn-retry-incidents-tab">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          <span>Reintentar ara</span>
        </button>
      </div>
    `;
    document.getElementById('btn-retry-incidents-tab')?.addEventListener('click', (e) => {
      e.preventDefault();
      const cacheKey = `${lineCode}:${hours}`;
      this._incidentCache?.delete(cacheKey);
      this.openDelayIncidentsView(lineCode, hours, viewMode, 0, true);
    });
  }

  renderDelayIncidentsView(data, selectedLine = 'all', selectedHours = 168, activeTab = 'top') {
    const container = document.getElementById('journalism-incidents-container');
    if (!container || !data) return;
    this.lastIncidentData = data;

    const s = data.summary || {};
    const topList = data.topIncidents || [];
    const investigationList = data.investigationIncidents || [];
    const anomaliesList = data.telemetryAnomalies || [];
    const tripsList = data.incidentTrips || [];
    const activeLineNorm = String(selectedLine || 'all').toUpperCase();
    const linesCatalog = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'];

    const getLineColor = (code) => {
      const match = (this.availableLines || []).find(l => String(l.code || l.id).toUpperCase() === String(code).toUpperCase());
      return match?.color || 'var(--brand-primary)';
    };

    const formatBusBadge = (vehicleId) => {
      if (!vehicleId) return '';
      const clean = String(vehicleId)
        .replace(/^mataro_\w+_/i, '')
        .replace(/^c10_\w+_/i, '')
        .replace(/^AMB-/i, '')
        .trim();
      if (!clean || clean.toLowerCase() === 'bus') return '';
      return `<span class="bus-id-badge" title="Identificador de vehicle oficial: ${this.esc(vehicleId)}">[ #${this.esc(clean)} ]</span>`;
    };

    // The headline maximum is the true maximum over the whole window. The
    // commercial tier is only delays < 25 min, so when every recorded delay sits
    // in the investigation tier the commercial figure is UNKNOWN (null) — it must
    // not be coerced to 0, which used to render "+0 min" as the maximum service
    // delay while real 30-minute delays were on screen.
    // An empty window reports null, and null is not zero. `Number(null) || 0`
    // turned "no delays recorded" into a headline of "0 min" - a claim that the
    // worst service delay in the window was zero minutes, which is exactly the
    // fabricated-confidence reading this panel exists to eliminate.
    const trueMaxDelay = (s.maxDelayMins === null || s.maxDelayMins === undefined
      || !Number.isFinite(Number(s.maxDelayMins))) ? null : Number(s.maxDelayMins);
    const commercialMax = (s.maxCommercialDelayMins === null || s.maxCommercialDelayMins === undefined
      || !Number.isFinite(Number(s.maxCommercialDelayMins)))
      ? null : Number(s.maxCommercialDelayMins);
    const maxFromInvestigation = s.maxDelayIsFromInvestigationTier === true
      || (commercialMax === null && trueMaxDelay !== null && trueMaxDelay >= 25);
    // A window can hold only mid-range delays: then the commercial max is
    // measured, the investigation tier is empty, and maxFromInvestigation is
    // false. It can also hold no delays at all. Either way the "else" caption
    // must not interpolate a null into "+null min".
    const commercialMaxCaption = commercialMax === null
      ? (trueMaxDelay === null ? 'sense mostres registrades' : 'no mesurat en aquesta finestra')
      : `+${commercialMax} min`;
    const maxDelayValue = trueMaxDelay === null
      ? '—'
      : `${trueMaxDelay > 0 ? '+' : ''}${trueMaxDelay} min`;

    container.innerHTML = `
      <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:1.1rem; margin-bottom:1.25rem;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:0.75rem;">
          <div>
            <span style="font-size:0.75rem; font-weight:800; color:#38bdf8; text-transform:uppercase; letter-spacing:0.5px;">Observatori de Mobilitat • Anàlisi de Causes</span>
            <h3 style="font-size:1.35rem; font-weight:800; color:#fff; margin:0.2rem 0;">Investigador d'Incidents de Trànsit &amp; Auditoria de Telemetria</h3>
            <p style="font-size:0.78rem; color:var(--text-muted); margin:0; max-width:740px; line-height:1.45;">
              Auditoria de retards per telemetria GPS. Els retards de servei comercial (${s.minDelayThreshold || 5}–24 min) es presenten al rànquing de trànsit regular. Els desfasaments extrems (&ge; 25 min) es classifiquen en una taula separada com a horaris no normals pendents d'investigació per resoldre la seva causa real.
            </p>
          </div>
        </div>

        <!-- Filter Controls Row -->
        <div style="display:flex; flex-direction:column; gap:0.65rem; margin-top:1rem; padding-top:0.85rem; border-top:1px solid var(--border-subtle);">
          <!-- Timeframe selector -->
          <div style="display:flex; align-items:center; gap:0.4rem; flex-wrap:wrap;">
            <span style="font-size:0.75rem; font-weight:700; color:var(--text-muted); min-width:60px;">Període:</span>
            <button type="button" class="incident-filter-pill ${Number(selectedHours) === 24 ? 'active' : ''}" data-incident-hours="24">24 hores</button>
            <button type="button" class="incident-filter-pill ${Number(selectedHours) === 48 ? 'active' : ''}" data-incident-hours="48">48 hores</button>
            <button type="button" class="incident-filter-pill ${Number(selectedHours) === 168 ? 'active' : ''}" data-incident-hours="168">7 dies</button>
          </div>

          <!-- Line selector -->
          <div style="display:flex; align-items:center; gap:0.4rem; flex-wrap:wrap;">
            <span style="font-size:0.75rem; font-weight:700; color:var(--text-muted); min-width:60px;">Línia:</span>
            <button type="button" class="incident-filter-pill ${activeLineNorm === 'ALL' ? 'active' : ''}" data-incident-line="all">Totes les línies</button>
            ${linesCatalog.map(lCode => {
              const isActive = activeLineNorm === lCode;
              const color = getLineColor(lCode);
              return `
                <button type="button" class="incident-filter-pill ${isActive ? 'active' : ''}" data-incident-line="${lCode}">
                  <span style="width:8px; height:8px; border-radius:50%; background:${color}; display:inline-block;"></span>
                  <span>${lCode}</span>
                </button>
              `;
            }).join('')}
          </div>
        </div>
      </div>

      <!-- KPI Summary Cards -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:0.75rem; margin-bottom:1.25rem;">
        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:0.9rem;">
          <div style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase;">Retard Màxim de Servei</div>
          <div style="font-size:1.6rem; font-weight:800; color:${trueMaxDelay === null ? 'var(--text-muted)' : '#ef4444'}; margin-top:0.2rem;">${maxDelayValue}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${this._fmtCount(s.rawSamplesOverThreshold ?? s.totalRecordedIncidents)} mostres raw &ge; ${s.minDelayThreshold || 5}m • ${topList.length} episodis al rànquing</div>
          ${maxFromInvestigation ? `
            <div style="font-size:0.72rem; color:#fb7185; margin-top:0.2rem; line-height:1.4;">
              Aquest màxim prové de la taula «Horaris No Habituals» (&ge; 25 min). En aquesta finestra no hi ha cap retard de servei comercial (${s.minDelayThreshold || 5}–24 min), de manera que el màxim comercial no està mesurat.
            </div>
          ` : `
            <div style="font-size:0.72rem; color:var(--text-muted); margin-top:0.2rem;">Màxim del servei comercial (${s.minDelayThreshold || 5}–24 min): ${commercialMaxCaption} • ${investigationList.length} en investigació</div>
          `}
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:0.9rem;">
          <div style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase;">Punt Negre (Més Afectat)</div>
          <div style="font-size:1.05rem; font-weight:700; color:var(--brand-primary); margin-top:0.25rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${this.esc(s.worstStop || 'Cap')}">${this.esc(s.worstStop || 'Cap')}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${s.worstStopCount || 0} afectacions registrades</div>
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:0.9rem;">
          <div style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase;">Franja amb Més Retards</div>
          <div style="font-size:1.15rem; font-weight:700; color:#f59e0b; margin-top:0.25rem;">${s.worstHour || '--:00'}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${s.worstHourTag || 'Horari regular'}</div>
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; padding:0.9rem;">
          <div style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase;">Horaris No Habituals</div>
          <div style="font-size:1.15rem; font-weight:700; color:#fb7185; margin-top:0.25rem;">${investigationList.length} en investigació</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${anomaliesList.length} anomalies de cotxeres/SAE</div>
        </div>
      </div>

      <!-- Sub-Tab Mode Switcher -->
      <div class="incident-view-mode-tabs-container" role="tablist" aria-label="Mode d'anàlisi d'incidents">
        <button type="button" class="incident-view-mode-tab ${activeTab === 'top' ? 'active' : ''}" data-incident-tab="top" role="tab" aria-selected="${activeTab === 'top'}">
          <span><span class="incident-tab-title">Rànquing d'Incidents de Servei</span> <span class="incident-tab-meta">(${s.minDelayThreshold || 5}–24 min) (${topList.length})</span></span>
        </button>
        <button type="button" class="incident-view-mode-tab ${activeTab === 'investigation' ? 'active' : ''}" data-incident-tab="investigation" role="tab" aria-selected="${activeTab === 'investigation'}">
          <span><span class="incident-tab-title">Horaris No Habituals</span> <span class="incident-tab-meta">(&ge; 25 min) (${investigationList.length})</span></span>
        </button>
        <button type="button" class="incident-view-mode-tab ${activeTab === 'trips' ? 'active' : ''}" data-incident-tab="trips" role="tab" aria-selected="${activeTab === 'trips'}">
          <span><span class="incident-tab-title">Expedicions &amp; Trajectòries</span> <span class="incident-tab-meta">(${tripsList.length})</span></span>
        </button>
      </div>

      <!-- View Content Partition -->
      ${activeTab === 'top' ? `
        <!-- Table 1: Top Delays Table (Peak per Trip 0-24m) -->
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px; margin-bottom:0.6rem;">
          <div style="font-size:0.78rem; color:var(--text-muted); display:flex; align-items:center; gap:6px;">
            <span>Mostrant incidents de servei comercial (${s.minDelayThreshold || 5}–24 min). S'agrupen els senyals cada 20 s del mateix viatge i parada per evitar duplicats.</span>
          </div>
          ${investigationList.length > 0 ? `
            <div style="font-size:0.75rem; color:#fb7185; font-weight:700;">
              ${investigationList.length} expedicions amb retard extrem (&ge; 25 m) mogudes a la taula inferior d'investigació.
            </div>
          ` : ''}
        </div>

        ${topList.length === 0 ? `
          <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:10px; padding:2rem; text-align:center; color:var(--text-muted);">
            No s'han registrat retards comercials (${s.minDelayThreshold || 5}–24 min) per a la selecció actual (${selectedHours}h).
          </div>
        ` : `
          <div class="observatori-table-wrapper">
            <table class="observatori-table">
              <thead>
                <tr>
                  <th style="width:45px; text-align:center;">#</th>
                  <th>Retard</th>
                  <th>Línia</th>
                  <th>Parada Afectada</th>
                  <th>Data i Hora</th>
                  <th>Context Horari</th>
                  <th style="text-align:center; cursor:help;" title="Tipus de senyal: GPS directe o Estimat">Senyal</th>
                  <th style="text-align:center;">Mapa</th>
                </tr>
              </thead>
              <tbody>
                ${topList.map((inc, i) => {
                  const lColor = getLineColor(inc.lineCode);
                  const delayClass = inc.delayMins >= 20 ? '#ef4444' : (inc.delayMins >= 10 ? '#f59e0b' : '#38bdf8');
                  const signalTooltip = inc.isRealTime
                    ? 'Senyal GPS directe: Telemetria transmesa en temps real pel vehicle físic.'
                    : 'Estimació per estima (dead-reckoning): Autobús físic amb GPS que ha perdut la cobertura temporalment (túnels, carrers estrets o caiguda de xarxa). La posició i el retard es calculen avançant la darrera velocitat i retard coneguts (màxim 90 segons). Mai s\'aplica a autobusos sense GPS.';
                  return `
                    <tr>
                      <td style="font-weight:700; color:var(--text-muted); text-align:center;">${inc.rank || (i + 1)}</td>
                      <td style="font-weight:800; color:${delayClass}; white-space:nowrap;">+${inc.delayMins} min</td>
                      <td>
                        <div style="display:inline-flex; align-items:center; gap:5px; flex-wrap:wrap;">
                          <span style="background:${lColor}; color:#fff; padding:0.15rem 0.45rem; border-radius:5px; font-weight:800; font-size:0.75rem;">${this.esc(inc.lineCode)}</span>
                          ${formatBusBadge(inc.vehicleId)}
                        </div>
                      </td>
                      <td style="font-weight:600; color:var(--text-primary);">
                        ${this.esc(inc.stopName)}
                      </td>
                      <td style="color:var(--text-secondary); white-space:nowrap; font-size:0.8rem;">
                        ${this.esc(inc.formattedDate || '')}
                      </td>
                      <td style="white-space:nowrap; font-size:0.78rem;">
                        <span style="color:var(--text-muted);">${this.esc(inc.trafficTag || '')}</span>
                      </td>
                      <td style="text-align:center; white-space:nowrap;">
                        <span class="signal-badge ${inc.isRealTime ? 'gps' : 'estimated'}" title="${this.esc(signalTooltip)}">
                          <span class="dot"></span>
                          <span>${inc.isRealTime ? 'GPS' : 'Estimat'}</span>
                        </span>
                      </td>
                      <td style="text-align:center; white-space:nowrap;">
                        <button type="button" class="btn-locate-incident-stop" data-locate-line="${this.esc(inc.lineCode)}" data-locate-stop="${this.esc(inc.stopName)}" data-locate-stop-id="${this.esc(inc.stopId || '')}" title="Veure aquesta parada al mapa">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
                          <span>Mapa</span>
                        </button>
                        <button type="button" class="btn-investigate-incident" data-investigate-line="${this.esc(inc.lineCode)}" data-investigate-stop="${this.esc(inc.stopName)}" data-investigate-at="${inc.timestamp || ''}" title="Investigar aquest retard: veure les mostres originals que el contenen">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                          <span>Investigar</span>
                        </button>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        `}

        <!-- Data-quality banner: what the "Top incidents" numbers actually count -->
        ${this._renderIncidentDataQualityBanner(s)}

        <!-- Forensic drill-down panel (populated on click) -->
        <div id="incident-drilldown-panel" style="margin-top:2rem; padding:1.5rem; background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:12px; display:none;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap;">
            <div style="flex:1; min-width:280px;">
              <h3 style="margin:0 0 0.5rem 0; font-size:1.2rem; color:#fff;">Investigació del retard</h3>
              <div id="drilldown-content" style="color:var(--text-secondary); line-height:1.5; font-size:0.84rem;">Selecciona un retard de la taula per a investigar-lo.</div>
            </div>
            <div style="flex:0 0 260px;">
              <h4 style="margin:0 0 0.4rem 0; font-size:0.9rem; color:var(--text-muted);">Evidència</h4>
              <div id="drilldown-summary" style="font-size:0.84rem; color:var(--text-primary);"></div>
            </div>
          </div>
        </div>

        <!-- Table 2: Dedicated Table for Non-Normal Schedules Under Investigation (>= 25 min) -->
        <div style="margin-top:2.5rem; border-top:2px solid rgba(244, 63, 94, 0.35); padding-top:1.5rem;" id="section-investigation-incidents">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:0.75rem; margin-bottom:0.85rem;">
            <div>
              <div style="display:inline-flex; align-items:center; gap:6px; background:rgba(244, 63, 94, 0.15); color:#fb7185; padding:3px 8px; border-radius:6px; font-size:0.72rem; font-weight:800; text-transform:uppercase; letter-spacing:0.4px;">
                <span>Pendent d'Investigació • Horaris No Habituals (&ge; 25 min)</span>
              </div>
              <h4 style="font-size:1.15rem; font-weight:800; color:#fff; margin:0.35rem 0 0.2rem 0;">
                Horaris No Habituals &amp; Desfasaments Extrems (&ge; 25 min) (${investigationList.length})
              </h4>
              <p style="font-size:0.78rem; color:var(--text-muted); margin:0; max-width:760px; line-height:1.45;">
                Aquests registres presenten un retard de 25 minuts o més. No es consideren retencions habituals de trànsit de la ciutat, sinó <strong>horaris no normals o possibles incidències de seguiment/telemetria</strong> (com ara autobusos aturats fora de servei en capçalera amb el SAE encès, talls excepcionals de carrer o desfasaments de torn). Estan pendents d'investigació per resoldre la seva causa real.
              </p>
            </div>
            ${investigationList.length > 0 ? `
              <button type="button" class="btn-report-action btn-report-investigation" id="btn-copy-investigation-report" title="Copiar informe dels casos en investigació">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                <span>Copiar informe d'investigació</span>
              </button>
            ` : ''}
          </div>

          ${investigationList.length === 0 ? `
            <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:10px; padding:1.5rem; text-align:center; color:var(--text-muted); font-size:0.85rem;">
              Cap horari no habitual ni desfasament extrem (&ge; 25 min) detectat en aquest període (${selectedHours}h).
            </div>
          ` : `
            <div class="observatori-table-wrapper">
              <table class="observatori-table">
                <thead>
                  <tr>
                    <th style="width:45px; text-align:center;">#</th>
                    <th>Retard Transmès</th>
                    <th>Línia</th>
                    <th>Parada Afectada</th>
                    <th>Data i Hora</th>
                    <th>Estat / Diagnòstic</th>
                    <th style="text-align:center; cursor:help;" title="Tipus de senyal: GPS directe o Estimat">Senyal</th>
                    <th style="text-align:center;">Mapa</th>
                  </tr>
                </thead>
                <tbody>
                  ${investigationList.map((inc, i) => {
                    const lColor = getLineColor(inc.lineCode);
                    const signalTooltip = inc.isRealTime
                      ? 'Senyal GPS directe: Telemetria transmesa en temps real pel vehicle físic.'
                      : 'Estimació per estima (dead-reckoning) per pèrdua temporal de senyal.';
                    return `
                      <tr>
                        <td style="font-weight:700; color:var(--text-muted); text-align:center;">${inc.rank || (i + 1)}</td>
                        <td style="font-weight:800; color:#fb7185; white-space:nowrap;">+${inc.delayMins} min</td>
                        <td>
                          <div style="display:inline-flex; align-items:center; gap:5px; flex-wrap:wrap;">
                            <span style="background:${lColor}; color:#fff; padding:0.15rem 0.45rem; border-radius:5px; font-weight:800; font-size:0.75rem;">${this.esc(inc.lineCode)}</span>
                            ${formatBusBadge(inc.vehicleId)}
                          </div>
                        </td>
                        <td style="font-weight:600; color:var(--text-primary);">
                          ${this.esc(inc.stopName)}
                        </td>
                        <td style="color:var(--text-secondary); white-space:nowrap; font-size:0.8rem;">
                          ${this.esc(inc.formattedDate || '')}
                        </td>
                        <td style="white-space:nowrap; font-size:0.78rem;">
                          <span style="background:rgba(244,63,94,0.15); color:#fb7185; padding:0.2rem 0.5rem; border-radius:6px; font-weight:700; font-size:0.72rem; display:inline-flex; align-items:center; gap:4px;">
                            Pendent d'investigació
                          </span>
                        </td>
                        <td style="text-align:center; white-space:nowrap;">
                          <span class="signal-badge ${inc.isRealTime ? 'gps' : 'estimated'}" title="${this.esc(signalTooltip)}">
                            <span class="dot"></span>
                            <span>${inc.isRealTime ? 'GPS' : 'Estimat'}</span>
                          </span>
                        </td>
                        <td style="text-align:center; white-space:nowrap;">
                          <button type="button" class="btn-locate-incident-stop" data-locate-line="${this.esc(inc.lineCode)}" data-locate-stop="${this.esc(inc.stopName)}" data-locate-stop-id="${this.esc(inc.stopId || '')}" title="Veure aquesta parada al mapa">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
                            <span>Mapa</span>
                          </button>
                        </td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          `}
        </div>

        <!-- Table 3: Anomaly & SAE Desync Audit Table for Operator/Municipality -->
        <div style="margin-top:2.5rem; border-top:2px dashed var(--border-subtle); padding-top:1.5rem;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:0.75rem; margin-bottom:0.85rem;">
            <div>
              <div style="display:inline-flex; align-items:center; gap:6px; background:rgba(245, 158, 11, 0.15); color:#f59e0b; padding:3px 8px; border-radius:6px; font-size:0.72rem; font-weight:800; text-transform:uppercase; letter-spacing:0.4px;">
                <span>Auditoria Operador &amp; Ajuntament</span>
              </div>
              <h4 style="font-size:1.15rem; font-weight:800; color:#fff; margin:0.35rem 0 0.2rem 0;">
                Anomalies de Telemetria SAE &amp; Sortida de Cotxeres (${anomaliesList.length})
              </h4>
              <p style="font-size:0.78rem; color:var(--text-muted); margin:0; max-width:740px; line-height:1.45;">
                Aquests registres no corresponen a retencions de trànsit de la ciutat, sinó a <strong>desfasaments de telemetria generats pel sistema SAE (CAD/AVL) d'Avanza</strong> a primera hora del matí (arrencada de servei abans de les 06:15) o durant proves nocturnes a cotxeres. Es publiquen aquí per facilitar l'auditoria i la seva correcció per part de l'Ajuntament de Mataró.
              </p>
            </div>
            ${anomaliesList.length > 0 ? `
              <button type="button" class="btn-report-action btn-report-anomalies btn-copy-anomalies" id="btn-copy-anomalies-report" title="Copiar resum d'anomalies per a informe o reclamació a l'Ajuntament / Avanza">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                <span>Copiar informe d'anomalies</span>
              </button>
            ` : ''}
          </div>

          ${anomaliesList.length === 0 ? `
            <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:10px; padding:1.5rem; text-align:center; color:var(--text-muted); font-size:0.85rem;">
              Cap anomalia d'arrencada o manteniment detectada en el període seleccionat (${selectedHours}h).
            </div>
          ` : `
            <div class="observatori-table-wrapper">
              <table class="observatori-table">
                <thead>
                  <tr>
                    <th style="width:45px; text-align:center;">#</th>
                    <th>Retard Transmès</th>
                    <th>Línia</th>
                    <th>Parada / Punt d'observació</th>
                    <th>Data i Hora</th>
                    <th>Diagnòstic / Causa Probable</th>
                    <th style="text-align:center; cursor:help;" title="Tipus de senyal: GPS directe o Estimat">Senyal</th>
                    <th style="text-align:center;">Mapa</th>
                  </tr>
                </thead>
                <tbody>
                  ${anomaliesList.map((inc, i) => {
                    const lColor = getLineColor(inc.lineCode);
                    const isStartup = inc.anomalyType === 'startup_sae';
                    const isMaintenance = inc.anomalyType === 'maintenance' || !isStartup;
                    const badgeBg = isStartup ? 'rgba(245, 158, 11, 0.15)' : 'rgba(147, 51, 234, 0.15)';
                    const badgeColor = isStartup ? '#f59e0b' : '#c084fc';
                    const signalTooltip = inc.isRealTime
                      ? 'Senyal GPS directe transmès pel vehicle físic.'
                      : 'Estimació per estima (dead-reckoning) per pèrdua temporal de senyal.';
                    return `
                      <tr>
                        <td style="font-weight:700; color:var(--text-muted); text-align:center;">${inc.rank || (i + 1)}</td>
                        <td style="font-weight:800; color:#f59e0b; white-space:nowrap;">+${inc.delayMins} min</td>
                        <td>
                          <div style="display:inline-flex; align-items:center; gap:5px; flex-wrap:wrap;">
                            <span style="background:${lColor}; color:#fff; padding:0.15rem 0.45rem; border-radius:5px; font-weight:800; font-size:0.75rem;">${this.esc(inc.lineCode)}</span>
                            ${formatBusBadge(inc.vehicleId)}
                          </div>
                        </td>
                        <td style="font-weight:600; color:var(--text-primary);">
                          ${isMaintenance ? `
                            <span style="color:var(--text-muted); font-size:0.85rem;" title="Sense parada comercial (proves o manteniment a cotxeres)">—</span>
                          ` : `
                            ${this.esc(inc.stopName)}
                          `}
                        </td>
                        <td style="color:var(--text-secondary); white-space:nowrap; font-size:0.8rem;">
                          ${this.esc(inc.formattedDate || '')}
                        </td>
                        <td style="white-space:nowrap; font-size:0.78rem;">
                          <span style="background:${badgeBg}; color:${badgeColor}; padding:0.2rem 0.5rem; border-radius:6px; font-weight:700; font-size:0.72rem; display:inline-flex; align-items:center; gap:4px;">
                            ${this.esc(inc.diagnosticBadge || inc.trafficTag || 'Anomalia SAE')}
                          </span>
                        </td>
                        <td style="text-align:center; white-space:nowrap;">
                          <span class="signal-badge ${inc.isRealTime ? 'gps' : 'estimated'}" title="${this.esc(signalTooltip)}">
                            <span class="dot"></span>
                            <span>${inc.isRealTime ? 'GPS' : 'Estimat'}</span>
                          </span>
                        </td>
                        <td style="text-align:center; white-space:nowrap;">
                          ${isMaintenance ? `
                            <span style="color:var(--text-muted); font-size:0.85rem;" title="No aplica (operació de cotxeres)">—</span>
                          ` : `
                            <button type="button" class="btn-locate-incident-stop" data-locate-line="${this.esc(inc.lineCode)}" data-locate-stop="${this.esc(inc.stopName)}" data-locate-stop-id="${this.esc(inc.stopId || '')}" title="Veure aquesta parada al mapa">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
                              <span>Mapa</span>
                            </button>
                          `}
                        </td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          `}
        </div>
      ` : activeTab === 'investigation' ? `
        <!-- Mode: Standalone Investigation Table Focus -->
        <div style="margin-bottom:1.5rem;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:0.75rem; margin-bottom:0.85rem;">
            <div>
              <div style="display:inline-flex; align-items:center; gap:6px; background:rgba(244, 63, 94, 0.15); color:#fb7185; padding:3px 8px; border-radius:6px; font-size:0.72rem; font-weight:800; text-transform:uppercase; letter-spacing:0.4px;">
                <span>Pendent d'Investigació • Horaris No Habituals (&ge; 25 min)</span>
              </div>
              <h4 style="font-size:1.25rem; font-weight:800; color:#fff; margin:0.35rem 0 0.2rem 0;">
                Horaris No Habituals &amp; Desfasaments Extrems (&ge; 25 min) (${investigationList.length})
              </h4>
              <p style="font-size:0.8rem; color:var(--text-muted); margin:0; max-width:760px; line-height:1.45;">
                Aquests registres presenten un retard de 25 minuts o més. No es consideren retencions habituals de trànsit de la ciutat, sinó <strong>horaris no normals o possibles incidències de seguiment/telemetria</strong> (com ara autobusos aturats fora de servei en capçalera amb el SAE encès, talls excepcionals de carrer o desfasaments de torn). Estan pendents d'investigació per resoldre la seva causa real.
              </p>
            </div>
            ${investigationList.length > 0 ? `
              <button type="button" class="btn-report-action btn-report-investigation" id="btn-copy-investigation-report" title="Copiar informe dels casos en investigació">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                <span>Copiar informe d'investigació</span>
              </button>
            ` : ''}
          </div>

          ${investigationList.length === 0 ? `
            <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:10px; padding:2rem; text-align:center; color:var(--text-muted); font-size:0.85rem;">
              Cap horari no habitual ni desfasament extrem (&ge; 25 min) detectat en aquest període (${selectedHours}h).
            </div>
          ` : `
            <div class="observatori-table-wrapper">
              <table class="observatori-table">
                <thead>
                  <tr>
                    <th style="width:45px; text-align:center;">#</th>
                    <th>Retard Transmès</th>
                    <th>Línia</th>
                    <th>Parada Afectada</th>
                    <th>Data i Hora</th>
                    <th>Estat / Diagnòstic</th>
                    <th style="text-align:center; cursor:help;" title="Tipus de senyal: GPS directe o Estimat">Senyal</th>
                    <th style="text-align:center;">Mapa</th>
                  </tr>
                </thead>
                <tbody>
                  ${investigationList.map((inc, i) => {
                    const lColor = getLineColor(inc.lineCode);
                    const signalTooltip = inc.isRealTime
                      ? 'Senyal GPS directe transmès pel vehicle físic.'
                      : 'Estimació per estima (dead-reckoning) per pèrdua temporal de senyal.';
                    return `
                      <tr>
                        <td style="font-weight:700; color:var(--text-muted); text-align:center;">${inc.rank || (i + 1)}</td>
                        <td style="font-weight:800; color:#fb7185; white-space:nowrap;">+${inc.delayMins} min</td>
                        <td>
                          <div style="display:inline-flex; align-items:center; gap:5px; flex-wrap:wrap;">
                            <span style="background:${lColor}; color:#fff; padding:0.15rem 0.45rem; border-radius:5px; font-weight:800; font-size:0.75rem;">${this.esc(inc.lineCode)}</span>
                            ${formatBusBadge(inc.vehicleId)}
                          </div>
                        </td>
                        <td style="font-weight:600; color:var(--text-primary);">
                          ${this.esc(inc.stopName)}
                        </td>
                        <td style="color:var(--text-secondary); white-space:nowrap; font-size:0.8rem;">
                          ${this.esc(inc.formattedDate || '')}
                        </td>
                        <td style="white-space:nowrap; font-size:0.78rem;">
                          <span style="background:rgba(244,63,94,0.15); color:#fb7185; padding:0.2rem 0.5rem; border-radius:6px; font-weight:700; font-size:0.72rem; display:inline-flex; align-items:center; gap:4px;">
                            Pendent d'investigació
                          </span>
                        </td>
                        <td style="text-align:center; white-space:nowrap;">
                          <span class="signal-badge ${inc.isRealTime ? 'gps' : 'estimated'}" title="${this.esc(signalTooltip)}">
                            <span class="dot"></span>
                            <span>${inc.isRealTime ? 'GPS' : 'Estimat'}</span>
                          </span>
                        </td>
                        <td style="text-align:center; white-space:nowrap;">
                          <button type="button" class="btn-locate-incident-stop" data-locate-line="${this.esc(inc.lineCode)}" data-locate-stop="${this.esc(inc.stopName)}" data-locate-stop-id="${this.esc(inc.stopId || '')}" title="Veure aquesta parada al mapa">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
                            <span>Mapa</span>
                          </button>
                        </td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          `}
        </div>
      ` : `
        <!-- Mode 2: Clustered Trips & Trajectories -->
        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:10px; padding:0.85rem 1rem; margin-bottom:1rem; font-size:0.8rem; line-height:1.5;">
          <div style="display:flex; align-items:flex-start; gap:0.65rem;">
            <div style="flex:1;">
              <div style="font-weight:700; color:var(--text-primary); margin-bottom:0.25rem;">
                Com funcionen les expedicions i trajectòries?
              </div>
              <div style="color:var(--text-secondary); margin-bottom:0.6rem;">
                Cada targeta reconstrueix el recorregut continu d'un <strong>autobús físic individual</strong> (separat per identificador de vehicle), seguint cronològicament com evoluciona el seu retard parada a parada al llarg del servei:
              </div>
              <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:0.6rem; font-size:0.76rem; color:var(--text-muted);">
                <div style="background:var(--bg-surface); padding:0.55rem 0.75rem; border-radius:6px; border:1px solid var(--border-subtle);">
                  <strong style="color:var(--text-primary); display:block; margin-bottom:2px;">Bus ID individual</strong>
                  Cada vehicle es monitoritza per separat; no es barregen diferents autobusos que circulin alhora per la mateixa línia.
                </div>
                <div style="background:var(--bg-surface); padding:0.55rem 0.75rem; border-radius:6px; border:1px solid var(--border-subtle);">
                  <strong style="color:var(--text-primary); display:block; margin-bottom:2px;">Progressió parada a parada</strong>
                  Permet veure exactament a quina parada s'origina la retenció i com el bus va recuperant temps de trajecte.
                </div>
                <div style="background:var(--bg-surface); padding:0.55rem 0.75rem; border-radius:6px; border:1px solid var(--border-subtle);">
                  <strong style="color:var(--text-primary); display:block; margin-bottom:2px;">Normalització de l'horari</strong>
                  Si la seqüència s'acaba abans del final de la línia, indica que el vehicle ja ha absorbit el retard (&lt;3 min) o ha finalitzat el torn.
                </div>
              </div>
            </div>
          </div>
        </div>

        ${tripsList.length === 0 ? `
          <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:10px; padding:2rem; text-align:center; color:var(--text-muted);">
            No s'han detectat expedicions amb retard greu continuat en aquest període.
          </div>
        ` : `
          <div style="display:flex; flex-direction:column; gap:0.75rem;">
            ${tripsList.map(trip => {
              const lColor = getLineColor(trip.lineCode);
              const typeBadgeClass = trip.incidentType === 'maintenance'
                ? 'incident-badge-maintenance'
                : (trip.isMovingTraffic ? 'incident-badge-traffic' : 'incident-badge-layover');
              return `
                <div class="trip-card">
                  <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
                    <div style="display:flex; align-items:center; gap:0.5rem;">
                      <span style="background:${lColor}; color:#fff; padding:0.2rem 0.55rem; border-radius:6px; font-weight:800; font-size:0.8rem;">${this.esc(trip.lineCode)}</span>
                      <strong style="color:var(--text-primary); font-size:0.9rem;">Expedició del ${this.esc(trip.startTime)}</strong>
                      ${formatBusBadge(trip.vehicleId)}
                      <span style="color:var(--text-muted); font-size:0.78rem;">(durada activa: ~${trip.durationMinutes || 1} min)</span>
                    </div>
                    <div style="display:flex; align-items:center; gap:0.5rem;">
                      <span class="${typeBadgeClass}" style="padding:0.2rem 0.5rem; border-radius:6px; font-size:0.74rem; font-weight:700;">
                        ${this.esc(trip.incidentTypeLabel)}
                      </span>
                      <span style="background:rgba(239,68,68,0.15); color:#ef4444; padding:0.2rem 0.55rem; border-radius:6px; font-size:0.78rem; font-weight:800;">
                        Màx: +${trip.maxDelayMins} min
                      </span>
                    </div>
                  </div>

                  <!-- Trajectory flow -->
                  <div class="trip-trajectory-flow">
                    <span style="font-weight:700; color:var(--text-muted); margin-right:0.25rem;">Trajectòria:</span>
                    ${(trip.stopProgression && trip.stopProgression.length > 0 
                      ? trip.stopProgression 
                      : (trip.stopsTraversed || []).map(s => ({ stopName: s, delayMins: null, isRecovered: false }))
                    ).map((st, sIdx, arr) => {
                      const dMins = st.delayMins;
                      let delayBadge = '';
                      if (dMins != null) {
                        const delayText = st.isRecovered
                          ? `${dMins > 0 ? `+${dMins}` : dMins}m ✓`
                          : `+${dMins}m`;
                        const chipClass = st.isRecovered
                          ? 'delay-low'
                          : (dMins >= 10 ? 'delay-high' : 'delay-mid');
                        delayBadge = `<span class="delay-chip ${chipClass}">${delayText}</span>`;
                      }
                      return `
                        <span class="stop-step ${st.isRecovered ? 'is-recovered' : ''}" title="${this.esc(st.stopName)}${dMins != null ? ` (${st.isRecovered ? 'Recuperat' : 'Retard'}: +${dMins} min)` : ''}">
                          <span class="stop-node ${st.isRecovered ? 'recovered' : (dMins >= 10 ? 'critical' : 'delayed')}"></span>
                          <span class="stop-name">${this.esc(st.stopName)}</span>
                          ${delayBadge}
                        </span>
                        ${sIdx < arr.length - 1 ? '<span class="step-arrow">→</span>' : ''}
                      `;
                    }).join('')}
                  </div>

                  <!-- Context and action footer -->
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-top:0.6rem; font-size:0.75rem; color:var(--text-muted); flex-wrap:wrap; gap:0.4rem;">
                    <div>
                      <span>${this.esc(trip.trafficTag || '')} • ${trip.sampleCount} mostres registrades (${trip.incidentType === 'maintenance' ? 'proves o encesa a cotxeres' : (trip.isMovingTraffic ? `recorregut per ${trip.stopsCount} parades en retenció` : 'aturat a parada / regulant capçalera')})</span>
                    </div>
                    ${trip.incidentType !== 'maintenance' ? `
                      <button type="button" class="btn-locate-incident-stop" data-locate-line="${this.esc(trip.lineCode)}" data-locate-stop="${this.esc(trip.firstStop || trip.stopsTraversed[0])}" title="Veure aquesta parada al mapa">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
                        <span>Veure parada</span>
                      </button>
                    ` : ''}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `}
      `}
    `;
  }

  copyAnomaliesReport() {
    if (!this.lastIncidentData || !Array.isArray(this.lastIncidentData.telemetryAnomalies)) return;
    const list = this.lastIncidentData.telemetryAnomalies;
    if (list.length === 0) return;

    let text = `INFORME D'ANOMALIES DE TELEMETRIA SAE — ARRIBO! MATARÓ\n`;
    text += `Període: Darreres ${this._currentIncidentHours || 168}h | Línia: ${this._currentIncidentLine || 'Totes'}\n`;
    text += `Data d'extracció: ${new Date().toLocaleString('ca-ES')}\n`;
    text += `Total anomalies detectades: ${list.length}\n\n`;
    text += `Descripció: Aquests registres corresponen a desfasaments transmesos pel sistema SAE (CAD/AVL) d'Avanza (habitualment per assignació d'autobusos que inicien torn a expedicions anteriors no cobertes o arrencada a cotxeres amb consola encesa abans de sortida). No reflecteixen retencions de trànsit reals a la ciutat.\n\n`;
    text += `Llistat d'incidències per auditar amb Avanza / Ajuntament de Mataró:\n`;

    list.forEach((item, idx) => {
      const sig = item.isRealTime ? 'GPS' : 'Estimat (dead-reckoning)';
      const isMaint = item.anomalyType === 'maintenance' || item.anomalyType !== 'startup_sae';
      const stopInfo = isMaint ? 'Cotxeres / Manteniment' : `Parada: "${item.stopName}"`;
      const busTag = item.vehicleId && !item.vehicleId.toLowerCase().endsWith('bus') ? ` | Bus #${item.vehicleId.replace(/^mataro_\w+_/i, '')}` : '';
      text += `${idx + 1}. [${item.lineCode}] ${item.formattedDate} — ${stopInfo} | Retard transmès: +${item.delayMins} min | Causa: ${item.trafficTag || item.diagnosticBadge || 'Anomalia'}${busTag} | Senyal: ${sig}\n`;
    });

    text += `\nGenerat per Arribo! Mataró (https://arribo.cat) a partir del feed oficial SIRI d'Avanza.`;

    const finish = () => {
      const btn = document.getElementById('btn-copy-anomalies-report');
      if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = '<span>✅ Copiat al porta-retalls!</span>';
        setTimeout(() => { btn.innerHTML = orig; }, 3000);
      }
    };

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(finish).catch(() => {
        prompt('Copia el text següent per a la teva reclamació:', text);
      });
    } else {
      prompt('Copia el text següent per a la teva reclamació:', text);
    }
  }

  copyInvestigationReport() {
    if (!this.lastIncidentData || !Array.isArray(this.lastIncidentData.investigationIncidents)) return;
    const list = this.lastIncidentData.investigationIncidents;
    if (list.length === 0) return;

    let text = `INFORME D'HORARIS NO HABITUALS & DESFASAMENTS EXTREMS (≥25 MIN) — ARRIBO! MATARÓ\n`;
    text += `Període: Darreres ${this._currentIncidentHours || 168}h | Línia: ${this._currentIncidentLine || 'Totes'}\n`;
    text += `Data d'extracció: ${new Date().toLocaleString('ca-ES')}\n`;
    text += `Total expedicions en investigació: ${list.length}\n\n`;
    text += `Descripció: Aquests registres corresponen a horaris no normals o desfasaments extrems de telemetria (de 25 minuts o més) pendents d'investigació per resoldre la causa real (busos aturats fora de servei, anomalies de servidor o desfasaments de torn).\n\n`;
    text += `Llistat d'expedicions en investigació:\n`;

    list.forEach((item, idx) => {
      const sig = item.isRealTime ? 'GPS' : 'Estimat (dead-reckoning)';
      const busTag = item.vehicleId && !item.vehicleId.toLowerCase().endsWith('bus') ? ` | Bus #${item.vehicleId.replace(/^mataro_\w+_/i, '')}` : '';
      text += `${idx + 1}. [${item.lineCode}] ${item.formattedDate} — Parada: "${item.stopName}" | Retard transmès: +${item.delayMins} min${busTag} | Senyal: ${sig}\n`;
    });

    text += `\nGenerat per Arribo! Mataró (https://arribo.cat) — Telemetria de transport públic.`;

    const finish = () => {
      const btn = document.getElementById('btn-copy-investigation-report');
      if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = '<span>✅ Copiat al porta-retalls!</span>';
        setTimeout(() => { btn.innerHTML = orig; }, 3000);
      }
    };

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(finish).catch(() => {
        prompt('Copia el resum per a la investigació:', text);
      });
    } else {
      prompt('Copia el resum per a la investigació:', text);
    }
  }
}

// Instantiate standalone Observatori application on DOM load
window.addEventListener('DOMContentLoaded', () => {
  window.observatoriApp = new ObservatoriApp();
  // Provenance only; never blocks or fails the page.
  window.TransitUtils?.showSeasonPill();
});

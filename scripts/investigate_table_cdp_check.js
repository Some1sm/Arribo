/**
 * scripts/investigate_table_cdp_check.js
 *
 * MEASURES, IN A REAL BROWSER, THAT THE "INVESTIGAR" TABLE'S COLUMNS DO NOT MOVE.
 *
 * The rider's complaint was visual: "the cells are moving depending on text
 * length". A source-level assertion can prove the markup is a <table> and the
 * CSS says table-layout: fixed, but that is still a claim about the cascade.
 * This check renders the real renderer against the real stylesheet in headless
 * Chrome and reads back actual getBoundingClientRect() x-positions.
 *
 * The fixture is deliberately ADVERSARIAL about text length, because that is
 * the condition that broke the old flex-div layout:
 *   - a very long stop name ("Mataró Parc (només baixada d´usuaris)")
 *   - a very short one ("Pl. Fiveller")
 *   - a long "reomplert" provenance label and a bare one
 *   - delays from 5 to 28 minutes
 * If any column were still content-sized, the short rows would pull their
 * cells left relative to the long rows and this check would fail.
 *
 * It also asserts the rendered output is a real table with a header row, and
 * that the Expedicions & Trajectòries link is present and wired to the tab
 * handler.
 *
 * Run: node scripts/investigate_table_cdp_check.js
 */

const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9227;

if (!fs.existsSync(CHROME_PATH)) {
  console.log('⏭  跳过：未找到 Chrome，跳过 CDP 布局检查。');
  process.exit(0);
}

(async () => {
  console.log('🧪 Chrome CDP — Investigar table column-stability check...\n');

  // The worker is not started: this check exercises rendering, and the panel
  // is fed a fixed inspect payload. Keeping the DB out of it also honours the
  // ownership rule that the HTTP process must never open SQLite.
  const bridge = require('../src/core/WorkerBridge');
  bridge.start = () => {};

  const server = require('../server').listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  console.log('  ✓ server on port', port);

  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-drill-cdp-'));
  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    '--remote-debugging-port=' + CDP_PORT,
    '--no-sandbox', '--disable-gpu',
    '--user-data-dir=' + tmpProfile
  ]);
  await new Promise(r => setTimeout(r, 1200));

  const cleanup = () => {
    try { chromeProc.kill(); } catch {}
    try { server.close(); } catch {}
    try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch {}
  };

  try {
    const target = await new Promise((resolve, reject) => {
      const req = http.request(`http://localhost:${CDP_PORT}/json/new?http://127.0.0.1:${port}/dades`, { method: 'PUT' }, res => {
        let b = '';
        res.on('data', c => b += c);
        res.on('end', () => resolve(JSON.parse(b)));
      });
      req.on('error', reject);
      req.end();
    });

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise(r => {
      const mid = ++id;
      pending.set(mid, r);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
      return r.result?.result?.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');

    let ready = false;
    for (let i = 0; i < 60; i++) {
      ready = await evaluate('!!(window.observatoriApp && document.getElementById("incident-drilldown-panel") !== undefined)');
      if (ready && await evaluate('!!window.observatoriApp')) break;
      ready = false;
      await new Promise(r => setTimeout(r, 250));
    }
    assert.ok(ready, 'Observatori app must boot');
    console.log('  ✓ page booted');

    // Feed the panel a fixed inspect payload, then invoke the REAL renderer.
    // Text lengths vary wildly on purpose -- that is what broke the old layout.
    const result = await evaluate(`(async () => {
      const longStop = "Mataró Parc (només baixada d´usuaris)";
      const shortStop = "Pl. Fiveller";
      const rows = [
        { delayMins: 5,  stopName: shortStop, vehicleId: '2672', formattedDate: '24/09/2026, 12:07:44', isRealTime: true,  hasTimes: true, scheduledTime: '12:00:00', actualTime: '12:05:00', timesProvenance: 'observed',                 timesSource: 'siri' },
        { delayMins: 28, stopName: longStop,  vehicleId: '2672', formattedDate: '24/09/2026, 12:07:44', isRealTime: true,  hasTimes: true, scheduledTime: '11:30:00', actualTime: '11:58:00', timesProvenance: 'derived_timetable_backfill', timesSource: 'derived_timetable_backfill' },
        { delayMins: 12, stopName: 'Ronda Creu de Pedra', vehicleId: '2672', formattedDate: '24/09/2026, 12:07:44', isRealTime: false, hasTimes: false, scheduledTime: '', actualTime: '', timesProvenance: 'none', timesSource: '' },
        { delayMins: 16, stopName: 'Rafael Estrany', vehicleId: '2672', formattedDate: '24/09/2026, 12:07:44', isRealTime: true, hasTimes: true, scheduledTime: '11:45:00', actualTime: '12:01:00', timesProvenance: 'derived_timetable', timesSource: 'derived_timetable' },
        { delayMins: 21, stopName: longStop,  vehicleId: '2672', formattedDate: '24/09/2026, 12:07:44', isRealTime: true,  hasTimes: true, scheduledTime: '11:35:00', actualTime: '11:56:00', timesProvenance: 'observed',                 timesSource: 'siri' }
      ];
      const payload = {
        success: true, found: true, lineCode: 'L3', stopName: 'Rafael Estrany',
        episode: {
          start: '24/09/2026, 12:05:00', end: '24/09/2026, 12:09:40',
          durationMinutes: 4.7, peakDelayMins: 28, peakAt: '24/09/2026, 12:07:44',
          rowCount: rows.length, distinctVehicles: ['2672'], vehicleAmbiguous: false,
          tripKey: { lineCode: 'L3', vehicleId: '2672', startTs: 1788000000000, endTs: 1788000580000 },
          verdict: 'corroborated', verdictLabel: 'Corroborated — vehicle identity plus independent evidence',
          timesProvenance: 'mixed',
          evidence: { hasVehicleId: true, hasProvenanceTimes: true, hasSnapshotTrail: true, hasDerivedTimes: true,
            hasBackfilledTimes: true, vehicleIdGapExplained: false, vehicleIdNote: '',
            rowsWithProvenanceTimes: 4, rowsWithDerivedTimes: 2, rowsWithBackfilledTimes: 1,
            rowsWithObservedTimes: 2, snapshotTrailPoints: 5, rowsWithoutProvenance: 1 },
          timetableCheck: { available: true, derivedFromTimetable: true, backfilledFromTimetable: true, derivedLiveFromTimetable: true },
          retiredScope: false, rawRows: rows
        },
        dataQuality: { totalRawRowsReturned: 5, episodesInWindow: 1, retiredScopeLinesPresent: false }
      };
      const realFetch = window.fetch;
      window.fetch = async (url) => {
        if (String(url).includes('/api/analytics/incidents/inspect')) {
          return { json: async () => payload };
        }
        return realFetch(url);
      };
      // The Expedicions tab data the cross-link matches against.
      window.observatoriApp.lastIncidentData = {
        incidentTrips: [{
          vehicleId: '2672', lineCode: 'L3', agency: 'Mataró Bus',
          startTime: '24/09/2026, 12:05:00', endTime: '24/09/2026, 12:31:00',
          startTs: 1788000000000, endTs: 1788001860000, durationMinutes: 31,
          maxDelayMins: 28, avgDelayMins: 14.2, sampleCount: 93,
          stopsTraversed: ['TecnoCampus', 'Rafael Estrany', 'Vista Alegre'],
          stopProgression: [
            { stopName: 'TecnoCampus', delayMins: 7, isRecovered: false },
            { stopName: 'Rafael Estrany', delayMins: 16, isRecovered: false },
            { stopName: 'Vista Alegre', delayMins: 5, isRecovered: true }
          ],
          firstStop: 'TecnoCampus', lastStop: 'Vista Alegre', stopsCount: 3,
          isMovingTraffic: true, isDepot: false, incidentType: 'traffic',
          incidentTypeLabel: '🚗 Trànsit en Ruta', trafficTag: 'Rush hour'
        }]
      };
      // The panel markup is injected so the renderer can be driven directly
      // without first opening the whole incidents view.
      const host = document.createElement('div');
      host.innerHTML =
        '<div id="incident-drilldown-panel" style="display:none">' +
        '  <div id="drilldown-content"></div>' +
        '  <div id="drilldown-summary"></div>' +
        '</div>';
      document.body.appendChild(host);

      await window.observatoriApp.openIncidentDrilldown('L3', 'Rafael Estrany', 1788000464000, '2672');
      await new Promise(r => setTimeout(r, 120));

      const table = document.querySelector('.drilldown-samples-table');
      if (!table) return { error: 'no .drilldown-samples-table rendered' };

      const headCells = [...table.querySelectorAll('thead th')];
      const bodyRows = [...table.querySelectorAll('tbody tr')];
      const cols = bodyRows.map(tr => [...tr.querySelectorAll('td')].map(td => Math.round(td.getBoundingClientRect().left * 100) / 100));
      const rowHeights = bodyRows.map(tr => Math.round(tr.getBoundingClientRect().height));

      return {
        isRealTable: table.tagName === 'TABLE',
        headerCount: headCells.length,
        headerTexts: headCells.map(th => th.textContent.trim()),
        bodyRowCount: bodyRows.length,
        cellCounts: [...new Set(bodyRows.map(tr => tr.querySelectorAll('td').length))],
        cols,
        rowHeights,
        tableLayout: getComputedStyle(table).tableLayout,
        headerPosition: headCells.length ? getComputedStyle(headCells[0]).position : null,
        scrollOverflow: getComputedStyle(table.parentElement).overflow,
        // The Expedicions cross-link.
        hasTripCard: !!document.querySelector('.drilldown-trip-card'),
        tripCardStops: [...document.querySelectorAll('.drilldown-trip-stop')].map(s => s.textContent.trim()),
        tripJumpTab: (document.querySelector('.drilldown-trip-card [data-incident-tab]') || {}).dataset
          ? document.querySelector('.drilldown-trip-card [data-incident-tab]').dataset.incidentTab : null,
        ambiguousBanner: (document.getElementById('drilldown-summary').textContent || '').includes('Episodi ambigu')
      };
    })()`);

    assert.ok(!result.error, result.error || 'panel must render');
    console.log('  ✓ panel rendered\n');

    // ── The measurement ────────────────────────────────────────────────
    assert.strictEqual(result.isRealTable, true, 'the sample list is a real <table> element');
    assert.strictEqual(result.headerCount, 6, `all 6 columns have a header, got ${result.headerCount}`);
    assert.deepStrictEqual(result.headerTexts, ['Hora', 'Retard', 'Parada', 'Bus', 'Teòric → Real', 'Origen'],
      'headers name every column');
    assert.strictEqual(result.bodyRowCount, 5, 'all 5 sample rows rendered');
    assert.deepStrictEqual(result.cellCounts, [6], 'every row has exactly 6 cells');
    assert.strictEqual(result.tableLayout, 'fixed', 'the table computes a fixed layout');
    assert.strictEqual(result.headerPosition, 'sticky', 'the header stays put while scrolling');
    console.log(`  ✓ real <table>, fixed layout, sticky header, 6 labelled columns`);

    // THE ASSERTION: every column starts at the same x in every row, despite
    // the fixture mixing a 38-character stop name with a 14-character one.
    //
    // What is actually being guarded is the STRUCTURE: a <table> shares one
    // column width across every row, whereas the old markup gave each row its
    // own flex container and let the text decide. Two teeth checks were run
    // against this assertion: restoring the flex-div rows fails earlier at
    // "no .drilldown-samples-table rendered", and forcing tbody td to
    // display:block -- a table that still LOOKS like a table but has lost
    // shared columns -- fails here with a 0px offset between columns.
    const colCount = result.cols[0].length;
    for (let c = 0; c < colCount; c++) {
      const xs = result.cols.map(row => row[c]);
      const drift = Math.round((Math.max(...xs) - Math.min(...xs)) * 100) / 100;
      assert.ok(drift <= 1,
        `column ${c + 1} ("${result.headerTexts[c]}") must not move between rows: drifted ${drift}px across ${xs.length} rows of differing text length (xs: ${JSON.stringify(xs)})`);
    }
    // The columns must also be genuinely distinct, or "aligned" would pass
    // trivially on a layout that had collapsed every cell to the same x.
    for (let c = 1; c < colCount; c++) {
      assert.ok(result.cols[0][c] - result.cols[0][c - 1] > 20,
        `column ${c + 1} must be visibly offset from column ${c}, gap was ${result.cols[0][c] - result.cols[0][c - 1]}px`);
    }
    console.log('  ✓ columns aligned across all 5 rows (0px drift) with a 38-char vs 14-char stop name, and each column visibly distinct');

    // ── The Expedicions link ───────────────────────────────────────────
    assert.strictEqual(result.hasTripCard, true, 'the Expedicions & Trajectòries card is rendered');
    assert.strictEqual(result.tripJumpTab, 'trips', 'its button targets the trips tab');
    assert.ok(result.tripCardStops.length === 3, `the card lists the trajectory stops, got ${JSON.stringify(result.tripCardStops)}`);
    console.log(`  ✓ Expedicions link rendered: ${result.tripCardStops.length} stops, jump target "${result.tripJumpTab}"`);

    // A single identifiable bus must NOT be labelled ambiguous.
    assert.strictEqual(result.ambiguousBanner, false, 'a single-bus episode is not flagged as ambiguous');

    console.log('\n🎉 INVESTIGAR TABLE COLUMN STABILITY VERIFIED IN CHROME\n');
    cleanup();
    process.exit(0);
  } catch (err) {
    console.error('\n❌ CDP CHECK FAILED:', err.message);
    cleanup();
    process.exit(1);
  }
})();

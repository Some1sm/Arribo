const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9224;

(async () => {
  console.log('🧪 Starting Chrome CDP Observatori Layout Shift & Filter Matrix Audit...');

  const bridge = require('../src/core/WorkerBridge');
  bridge.start = () => {};
  const reportCacheService = require('../src/reportCacheService');

  // Seed sample report data into cache so 503 never occurs regardless of REPORTS_DIR
  const now = Date.now();
  const mockReport = {
    meta: { generatedAt: new Date(now).toISOString(), generatedTimestamp: now, periodHours: 24 },
    summary: {
      totalRecordedArrivals: 1420,
      networkPunctualityPct: 91,
      networkAvgDelay: '0.8',
      networkMaxDelay: '6.2',
      monitoredLinesCount: 8
    },
    rankingMostDelayed: [
      { lineCode: 'L1', name: 'Línia 1', avgDelay: 2.1, onTimePercentage: 78, maxDelay: 5.5, sampleCount: 240, agency: 'Mataró Bus' },
      { lineCode: 'L2', name: 'Línia 2', avgDelay: 1.6, onTimePercentage: 84, maxDelay: 4.8, sampleCount: 190, agency: 'Mataró Bus' }
    ],
    rankingWorstStops: [
      { stopId: '1001', stopName: 'Hospital de Mataró', lineCode: 'L1', agency: 'Mataró Bus', avgDelay: '3.4', maxDelay: '6.2', severeLatePct: 28, criticalHour: '08:00', criticalHourAvgDelay: '4.1', arrivalCount: 85, isBottleneck: true },
      { stopId: '1002', stopName: 'Rambla', lineCode: 'L2', agency: 'Mataró Bus', avgDelay: '2.5', maxDelay: '5.0', severeLatePct: 22, criticalHour: '13:00', criticalHourAvgDelay: '3.2', arrivalCount: 72, isBottleneck: true }
    ],
    allStopDelays: [
      { stopId: '1001', stopName: 'Hospital de Mataró', lineCode: 'L1', agency: 'Mataró Bus', avgDelay: '3.4', maxDelay: '6.2', severeLatePct: 28, criticalHour: '08:00', criticalHourAvgDelay: '4.1', arrivalCount: 85, isBottleneck: true },
      { stopId: '1002', stopName: 'Rambla', lineCode: 'L2', agency: 'Mataró Bus', avgDelay: '2.5', maxDelay: '5.0', severeLatePct: 22, criticalHour: '13:00', criticalHourAvgDelay: '3.2', arrivalCount: 72, isBottleneck: true },
      { stopId: '1003', stopName: 'Pl. de les Tereses', lineCode: 'L1', agency: 'Mataró Bus', avgDelay: '0.4', maxDelay: '1.2', severeLatePct: 0, criticalHour: '--', criticalHourAvgDelay: '0.4', arrivalCount: 95, isBottleneck: false },
      { stopId: '1004', stopName: 'Estació Rodalies', lineCode: 'L2', agency: 'Mataró Bus', avgDelay: '0.2', maxDelay: '0.8', severeLatePct: 0, criticalHour: '--', criticalHourAvgDelay: '0.2', arrivalCount: 110, isBottleneck: false }
    ],
    agencyStats: [
      { agency: 'Mataró Bus', totalSamples: 1420, avgDelay: '0.8', onTimePercentage: 91 }
    ]
  };
  reportCacheService.updateMemoryCache(24, mockReport);

  const server = require('../server').listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  console.log('  ✓ Test server listening on port', port);

  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-obs-chrome-'));
  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    '--remote-debugging-port=' + CDP_PORT,
    '--no-sandbox',
    '--disable-gpu',
    '--user-data-dir=' + tmpProfile
  ]);
  await new Promise(r => setTimeout(r, 1200));

  const target = await new Promise((resolve, reject) => {
    const req = http.request('http://localhost:' + CDP_PORT + '/json/new?http://127.0.0.1:' + port + '/dades', { method: 'PUT' }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => resolve(JSON.parse(b)));
    });
    req.on('error', reject);
    req.end();
  });

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  function send(method, params = {}) {
    return new Promise(r => {
      const mid = ++id;
      pending.set(mid, r);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  }

  await send('Page.enable');
  await send('Runtime.enable');

  // Wait for #observatori-group-by-line to be present in DOM
  let ready = false;
  for (let i = 0; i < 50; i++) {
    const evalRes = await send('Runtime.evaluate', {
      expression: '!!document.getElementById("observatori-group-by-line")'
    });
    if (evalRes.result?.result?.value === true) {
      ready = true;
      break;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(ready, 'Table header controls must render in DOM');
  console.log('  ✓ Page ready and controls loaded.');

  const getLayout = async () => {
    const res = await send('Runtime.evaluate', {
      expression: `(() => {
        const chk = document.getElementById("observatori-group-by-line");
        const row = chk ? chk.closest(".observatori-table-header-row") : null;
        const title = row ? row.querySelector(".observatori-table-title") : null;
        const toolbar = row ? row.querySelector(".observatori-filter-toolbar") : null;
        const subtitle = title ? title.querySelector(".observatori-table-subtitle") : null;
        return {
          row: row ? { y: row.offsetTop, h: row.offsetHeight } : null,
          title: title ? { y: title.offsetTop, h: title.offsetHeight, w: title.offsetWidth } : null,
          toolbar: toolbar ? { y: toolbar.offsetTop, h: toolbar.offsetHeight, w: toolbar.offsetWidth } : null,
          subtitleText: subtitle ? subtitle.textContent.trim() : null,
          checked: chk ? chk.checked : null
        };
      })()`,
      returnByValue: true
    });
    return res.result?.result?.value;
  };

  const testViewports = [1366, 1200, 1080, 1024, 960, 800, 768, 480, 375];

  for (const w of testViewports) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: 900,
      deviceScaleFactor: 1,
      mobile: w <= 768
    });
    await new Promise(r => setTimeout(r, 60));

    // Measure initial (unticked)
    const before = await getLayout();
    assert.ok(before.row, `Row must exist at ${w}px`);

    // Toggle ticked
    await send('Runtime.evaluate', {
      expression: 'document.getElementById("observatori-group-by-line").click()'
    });
    await new Promise(r => setTimeout(r, 150));

    const afterTicked = await getLayout();
    assert.equal(afterTicked.checked, true, 'Checkbox must be checked');

    // Verify ZERO layout shift
    const toolbarOffsetBefore = before.toolbar.y - before.row.y;
    const toolbarOffsetTicked = afterTicked.toolbar.y - afterTicked.row.y;
    assert.equal(toolbarOffsetTicked, toolbarOffsetBefore,
      `Toolbar wrapped or shifted at ${w}px when ticking! Before: ${toolbarOffsetBefore}px, After: ${toolbarOffsetTicked}px`);
    assert.equal(afterTicked.row.h, before.row.h,
      `Row height changed at ${w}px when ticking! Before: ${before.row.h}px, After: ${afterTicked.row.h}px`);

    // Toggle unticked
    await send('Runtime.evaluate', {
      expression: 'document.getElementById("observatori-group-by-line").click()'
    });
    await new Promise(r => setTimeout(r, 150));

    const afterUnticked = await getLayout();
    assert.equal(afterUnticked.checked, false, 'Checkbox must be unchecked');
    const toolbarOffsetUnticked = afterUnticked.toolbar.y - afterUnticked.row.y;
    assert.equal(toolbarOffsetUnticked, toolbarOffsetBefore,
      `Toolbar wrapped or shifted at ${w}px when unticking!`);
    assert.equal(afterUnticked.row.h, before.row.h,
      `Row height changed at ${w}px when unticking!`);

    console.log(`  ✓ ${w}px: 0px shift (rowH: ${before.row.h}px, toolbarOffset: ${toolbarOffsetBefore}px)`);
  }

  // Also test switching to "all" stops mode and cycling limits
  console.log('\n  --- Testing "Totes les parades" mode with various limits ---');
  await send('Runtime.evaluate', {
    expression: 'document.querySelector("[data-toggle-stop-mode=\\"all\\"]").click()'
  });
  await new Promise(r => setTimeout(r, 200));

  for (const limit of ['10', '25', '9999']) {
    await send('Runtime.evaluate', {
      expression: `document.querySelector('[data-worst-limit="${limit}"]').click()`
    });
    await new Promise(r => setTimeout(r, 150));

    const before = await getLayout();

    // Toggle ticked
    await send('Runtime.evaluate', {
      expression: 'document.getElementById("observatori-group-by-line").click()'
    });
    await new Promise(r => setTimeout(r, 150));

    const afterTicked = await getLayout();
    assert.equal(afterTicked.checked, true);
    assert.equal(afterTicked.toolbar.y - afterTicked.row.y, before.toolbar.y - before.row.y,
      `Layout shift in all-stops limit=${limit} mode!`);
    assert.equal(afterTicked.row.h, before.row.h);

    // Toggle unticked
    await send('Runtime.evaluate', {
      expression: 'document.getElementById("observatori-group-by-line").click()'
    });
    await new Promise(r => setTimeout(r, 150));

    const afterUnticked = await getLayout();
    assert.equal(afterUnticked.checked, false);
    assert.equal(afterUnticked.toolbar.y - afterUnticked.row.y, before.toolbar.y - before.row.y);
    assert.equal(afterUnticked.row.h, before.row.h);

    console.log(`  ✓ All-stops mode limit=${limit}: 0px shift verified across toggle states.`);
  }

  // --- Testing Incident View Mode Tabs Equal Distribution & Responsive Layout ---
  console.log('\n  --- Testing Incident View Mode Tabs: Equal Distribution & Responsive Layout ---');
  await send('Runtime.evaluate', {
    expression: `(() => {
      const mockData = {
        success: true,
        summary: { totalRecordedIncidents: 83, worstStop: 'Estació Rodalies', worstStopCount: 15, worstHour: '08:00' },
        topIncidents: Array(30).fill({ lineCode: 'L1', delayMins: 12, stopName: 'Estació Rodalies', formattedDate: '22/09 08:30' }),
        investigationIncidents: Array(23).fill({ lineCode: 'L2', delayMins: 35, stopName: 'Hospital', formattedDate: '22/09 09:15' }),
        telemetryAnomalies: [],
        incidentTrips: Array(30).fill({ lineCode: 'L1', delayMins: 10, tripId: 'trip_1' })
      };
      window.observatoriApp.openDelayIncidentsTab('all');
      window.observatoriApp.renderDelayIncidentsView(mockData, 'all', 168, 'top');
    })()`
  });
  await new Promise(r => setTimeout(r, 200));

  for (const w of testViewports) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: 900,
      deviceScaleFactor: 1,
      mobile: w <= 768
    });
    await new Promise(r => setTimeout(r, 60));

    const audit = await send('Runtime.evaluate', {
      expression: `(() => {
        const container = document.querySelector('.incident-view-mode-tabs-container');
        if (!container) return { error: 'container not found' };
        const tabs = Array.from(container.querySelectorAll('.incident-view-mode-tab'));
        const cRect = container.getBoundingClientRect();
        return {
          containerWidth: cRect.width,
          flexDir: window.getComputedStyle(container).flexDirection,
          tabCount: tabs.length,
          tabs: tabs.map(t => {
            const r = t.getBoundingClientRect();
            const cs = window.getComputedStyle(t);
            return {
              w: r.width,
              h: r.height,
              flex: cs.flex,
              textAlign: cs.textAlign,
              justifyContent: cs.justifyContent,
              hasTitle: !!t.querySelector('.incident-tab-title'),
              hasMeta: !!t.querySelector('.incident-tab-meta')
            };
          })
        };
      })()`,
      returnByValue: true
    });

    const res = audit.result?.result?.value;
    assert.ok(res && !res.error, `Incident tabs container must exist at ${w}px`);
    assert.equal(res.tabCount, 3, 'Must render 3 incident view mode tabs');
    assert.ok(res.tabs.every(t => t.hasTitle && t.hasMeta), 'Every tab must contain .incident-tab-title and .incident-tab-meta');

    if (w > 768) {
      assert.equal(res.flexDir, 'row', `Desktop ${w}px must use flex-direction: row`);
      // Equal distribution check: all tab widths must be nearly identical (within 1.5px subpixel tolerance)
      const firstW = res.tabs[0].w;
      for (let i = 1; i < res.tabs.length; i++) {
        assert.ok(Math.abs(res.tabs[i].w - firstW) < 1.5,
          `Tabs not equally distributed at ${w}px! Tab 0: ${firstW}px, Tab ${i}: ${res.tabs[i].w}px`);
      }
      assert.ok(res.tabs.every(t => t.textAlign === 'center' && t.justifyContent === 'center'),
        `Tabs at ${w}px must have centered text and justification`);
      console.log(`  ✓ Desktop ${w}px: 3 tabs distributed equally (~${firstW.toFixed(1)}px each), centered alignment`);
    } else {
      assert.equal(res.flexDir, 'column', `Mobile ${w}px must use flex-direction: column`);
      assert.ok(res.tabs.every(t => Math.abs(t.w - (res.containerWidth - 14)) < 2),
        `Mobile tabs at ${w}px must expand to 100% width of container`);
      assert.ok(res.tabs.every(t => t.h >= 32),
        `Mobile tabs at ${w}px must have comfortable touch height >= 32px`);
      console.log(`  ✓ Mobile ${w}px: tabs stacked vertically (w: 100%, touch height >= 32px)`);
    }
  }

  // Interactivity check: clicking tabs toggles aria-selected and view mode
  console.log('  --- Testing Tab Click Interactivity ---');
  await send('Runtime.evaluate', {
    expression: 'document.querySelector(\'[data-incident-tab="investigation"]\').click()'
  });
  await new Promise(r => setTimeout(r, 100));

  const tabState = await send('Runtime.evaluate', {
    expression: `(() => {
      const tabs = Array.from(document.querySelectorAll('.incident-view-mode-tab'));
      return tabs.map(t => ({
        mode: t.dataset.incidentTab,
        selected: t.getAttribute('aria-selected'),
        active: t.classList.contains('active')
      }));
    })()`,
    returnByValue: true
  });

  const states = tabState.result?.result?.value;
  assert.equal(states.find(s => s.mode === 'investigation')?.selected, 'true');
  assert.equal(states.find(s => s.mode === 'investigation')?.active, true);
  assert.equal(states.find(s => s.mode === 'top')?.selected, 'false');
  console.log('  ✓ Tab interactivity: clicking investigation tab activates it correctly.');
  chromeProc.kill();
  server.close();
  try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch {}
  console.log('\n🎉 ALL OBSERVATORI CDP LAYOUT SHIFT AUDITS PASSED PERFECTLY!\n');
  process.exit(0);
})().catch(err => {
  console.error('❌ CDP Layout Shift Test failed:', err);
  process.exit(1);
});

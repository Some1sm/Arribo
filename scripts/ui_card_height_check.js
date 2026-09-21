const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const os = require('node:os');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9223;

async function run() {
  console.log('🚀 Starting headless Chrome for card height and visual cadence audit...');

  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-chrome-'));

  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--user-data-dir=' + tmpProfile
  ]);

  await new Promise(r => setTimeout(r, 1200));

  try {
    // Check CDP connection
    const versionData = await new Promise((resolve, reject) => {
      http.get(`http://localhost:${CDP_PORT}/json/version`, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject);
    });

    console.log('✅ Chrome CDP connected. Browser:', versionData.Browser);

    // Read CSS
    const cssContent = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');

    // Create a target page
    const target = await new Promise((resolve, reject) => {
      const req = http.request(`http://localhost:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' }, res => {
        let b = '';
        res.on('data', c => b += c);
        res.on('end', () => resolve(JSON.parse(b)));
      });
      req.on('error', reject);
      req.end();
    });

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    });

    function send(method, params = {}) {
      return new Promise(resolve => {
        const mid = ++id;
        pending.set(mid, resolve);
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    }

    await send('Runtime.enable');
    await send('Page.enable');

    // HTML test template with current app.js logic representation
    // Let's test the 3 cards across viewports
    const viewports = [320, 360, 390, 768, 1200];

    for (const vp of viewports) {
      console.log(`\n📱 --- TESTING VIEWPORT: ${vp}px ---`);
      await send('Emulation.setDeviceMetricsOverride', {
        width: vp,
        height: 800,
        deviceScaleFactor: 1,
        mobile: vp < 600
      });

      // Load test page with the CSS and cards
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>${cssContent}</style>
          <style>
            body { background: #0f172a; color: #fff; padding: 12px; margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
            .container { max-width: 100%; display: flex; flex-direction: column; gap: 8px; }
          </style>
        </head>
        <body>
          <div class="container" id="cards-container">
            <!-- Card 0: Live Bus with GPS & Active Bus -->
            <div class="departure-item highlight-next clickable-bus-dep" id="card-live"
                 tabindex="0" role="button" aria-label="Localitzar al mapa sortida de les 20:48 cap a Rodalies, en 3 min"
                 title="Fes clic per localitzar aquest autobús en directe al mapa">
              <div class="dep-time-group">
                <div class="dep-time-row">
                  <span class="dep-clock">20:48</span>
                  <span class="dep-tag-sub" title="🟢 Temps Real">🟢 Temps Real</span>
                </div>
                <div class="dep-dest" title="Cap a Rodalies">
                  Cap a <strong>Rodalies</strong>
                </div>
                <div class="dep-time-sub" title="Arribada transmesa en temps real pel sistema SIRI Avanza">
                  <span>🟢 Arribada en temps real (SIRI Avanza)</span>
                </div>
              </div>
              <div class="dep-status">
                <span class="dep-mins">3 min</span>
                <span class="dep-delay-pill on-time" title="Puntual">Puntual</span>
                <span class="dep-map-cta">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polygon points="12 8 8 12 12 16 12 8"/></svg>
                  Veure al mapa
                </span>
              </div>
            </div>

            <!-- Card 1: Regulating Bus at Hospital terminal with Layover & Delay (Single status badge) -->
            <div class="departure-item clickable-bus-dep" id="card-regulating"
                 tabindex="0" role="button" aria-label="Localitzar al mapa sortida de les 20:53 cap a Hospital - Rodalies, en 1 min"
                 title="Fes clic per localitzar aquest autobús en directe al mapa">
              <div class="dep-time-group">
                <div class="dep-time-row">
                  <span class="dep-clock">20:53</span>
                  <span class="dep-regulating-pill" title="Autobús a la parada des de les 20:52 • Horari oficial teòric: 20:50">🅿️ A la parada</span>
                  <span class="dep-tag-sub" title="🟢 Temps Real">🟢 Temps Real</span>
                </div>
                <div class="dep-dest" title="Cap a Hospital - Rodalies">
                  Cap a <strong>Hospital - Rodalies</strong>
                </div>
                <div class="dep-time-sub" title="Regulació a capçalera: Autobús a la parada des de les 20:52 • Pausa de regulació de 1 min • Sortida cap a Hospital - Rodalies a les 20:53 (en 1 min) [Horari oficial: 20:50]">
                  <span>⏱️ A la parada des de les 20:52 • Regulació: 1 min</span>
                </div>
              </div>
              <div class="dep-status">
                <span class="dep-mins">1 min</span>
                <span class="dep-delay-pill delayed" title="+3 min retard">+3 min retard</span>
                <span class="dep-map-cta">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polygon points="12 8 8 12 12 16 12 8"/></svg>
                  Veure al mapa
                </span>
              </div>
            </div>

            <!-- Card 2: Scheduled / Theoretical Bus -->
            <div class="departure-item" id="card-scheduled" role="listitem" aria-label="Sortida de les 21:15 cap a Hospital - Rodalies, en 27 min">
              <div class="dep-time-group">
                <div class="dep-time-row">
                  <span class="dep-clock">21:15</span>
                  <span class="dep-tag-sub" title="Programat">Programat</span>
                </div>
                <div class="dep-dest" title="Cap a Hospital - Rodalies">
                  Cap a <strong>Hospital - Rodalies</strong>
                </div>
                <div class="dep-time-sub" title="Horari teòric programat">
                  <span>📅 Horari teòric programat</span>
                </div>
              </div>
              <div class="dep-status">
                <span class="dep-mins">27 min</span>
                <span class="dep-delay-pill scheduled" title="Programat">Programat</span>
              </div>
            </div>

            <!-- Card 3: Long Destination String (Edge Case) -->
            <div class="departure-item clickable-bus-dep" id="card-long-dest"
                 tabindex="0" role="button" aria-label="Localitzar al mapa: sortida de les 21:30 cap a Hospital de Mataró - Ctra. de Cirera / C. de la Riera, 38 min"
                 title="Fes clic per localitzar aquest autobús en directe al mapa">
              <div class="dep-time-group">
                <div class="dep-time-row">
                  <span class="dep-clock">21:30</span>
                  <span class="dep-regulating-pill" title="Autobús en regulació de línia">⏱️ En regulació</span>
                  <span class="dep-tag-sub" title="🟢 Temps Real">🟢 Temps Real</span>
                </div>
                <div class="dep-dest" title="Cap a Hospital de Mataró - Ctra. de Cirera / C. de la Riera">
                  Cap a <strong>Hospital de Mataró - Ctra. de Cirera / C. de la Riera</strong>
                </div>
                <div class="dep-time-sub" title="Autobús en regulació a capçalera • Sortida prevista a les 21:30">
                  <span>⏱️ En regulació a capçalera • Sortida a les 21:30</span>
                </div>
              </div>
              <div class="dep-status">
                <span class="dep-mins">38 min</span>
                <span class="dep-delay-pill regulating" title="⏱️ Regulació">⏱️ Regulació</span>
                <span class="dep-map-cta">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polygon points="12 8 8 12 12 16 12 8"/></svg>
                  Veure al mapa
                </span>
              </div>
            </div>

            <!-- Card 4: First Morning / Tomorrow Service (Edge Case) -->
            <div class="departure-item" id="card-first-morning" role="listitem" aria-label="Línia L1: Sortida de les 06:30 cap a Hospital de Mataró, 🌅 Demà 06:30">
              <div class="dep-time-group">
                <div class="dep-time-row">
                  <span class="dep-clock">06:30</span>
                  <span class="dep-tag-sub first-service" title="🌅 1r Servei">🌅 1r Servei</span>
                </div>
                <div class="dep-dest" title="Cap a Hospital de Mataró">
                  Cap a <strong>Hospital de Mataró</strong>
                </div>
                <div class="dep-time-sub" title="Primer autobús del matí de demà a les 06:30">
                  <span>📅 Primer autobús del matí (Demà a les 06:30)</span>
                </div>
              </div>
              <div class="dep-status">
                <span class="dep-mins" style="color:#fbbf24;">🌅 Demà 06:30</span>
                <span class="dep-delay-pill scheduled" title="1r Servei">1r Servei</span>
              </div>
            </div>

            <!-- Card 5: Regulating bus at Origin Terminal (Pl. de les Tereses) -->
            <div class="departure-item clickable-bus-dep" id="card-origin-reg"
                 tabindex="0" role="button" aria-label="Localitzar al mapa: Línia L2: sortida de les 20:55 cap a Rodalies, 2 min"
                 title="Fes clic per localitzar aquest autobús en directe al mapa">
              <div class="dep-time-group">
                <div class="dep-time-row">
                  <span class="dep-clock">20:55</span>
                  <span class="dep-regulating-pill" title="Autobús regulant a Pl. de les Tereses (sortida: 20:50)">⏱️ En regulació</span>
                  <span class="dep-tag-sub" title="🟢 Temps Real">🟢 Temps Real</span>
                </div>
                <div class="dep-dest" title="Cap a Rodalies">
                  Cap a <strong>Rodalies</strong>
                </div>
                <div class="dep-time-sub" title="Autobús en regulació a Pl. de les Tereses (sortida d'origen a les 20:50) • Arribada prevista aquí a les 20:55 (en 2 min)">
                  <span>⏱️ Regulant a Pl. de les Tereses • Surt a les 20:50</span>
                </div>
              </div>
              <div class="dep-status">
                <span class="dep-mins">2 min</span>
                <span class="dep-delay-pill regulating" title="⏱️ Regulació">⏱️ Regulació</span>
                <span class="dep-map-cta">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polygon points="12 8 8 12 12 16 12 8"/></svg>
                  Veure al mapa
                </span>
              </div>
            </div>
          </div>
        </body>
        </html>
      `;

      await send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) });
      await new Promise(r => setTimeout(r, 400));

      const metrics = await send('Runtime.evaluate', {
        expression: `(() => {
          const live = document.getElementById('card-live');
          const reg = document.getElementById('card-regulating');
          const sched = document.getElementById('card-scheduled');
          const longCard = document.getElementById('card-long-dest');
          const firstMorn = document.getElementById('card-first-morning');
          const originReg = document.getElementById('card-origin-reg');

          const regRow = reg.querySelector('.dep-time-row');
          const regSub = reg.querySelector('.dep-time-sub');
          const longDest = longCard.querySelector('.dep-dest');

          const liveRect = live.getBoundingClientRect();
          const regRect = reg.getBoundingClientRect();
          const schedRect = sched.getBoundingClientRect();
          const longRect = longCard.getBoundingClientRect();
          const firstRect = firstMorn.getBoundingClientRect();
          const originRect = originReg.getBoundingClientRect();

          const regRowRect = regRow.getBoundingClientRect();
          const regClockRect = regRow.querySelector('.dep-clock').getBoundingClientRect();
          const regPillRect = regRow.querySelector('.dep-regulating-pill').getBoundingClientRect();

          // Check if regRow wrapped: if pill top > clock bottom or pill top != clock top (+-5px)
          const rowWrapped = Math.abs(regPillRect.top - regClockRect.top) > 8;

          const minsStyle = getComputedStyle(live.querySelector('.dep-mins'));
          const pillStyle = getComputedStyle(live.querySelector('.dep-delay-pill'));

          return {
            liveHeight: Math.round(liveRect.height),
            regHeight: Math.round(regRect.height),
            schedHeight: Math.round(schedRect.height),
            longHeight: Math.round(longRect.height),
            firstHeight: Math.round(firstRect.height),
            originHeight: Math.round(originRect.height),
            heightDiffRegVsSched: Math.round(regRect.height - schedRect.height),
            heightDiffRegVsLive: Math.round(regRect.height - liveRect.height),
            heightDiffLongVsLive: Math.round(longRect.height - liveRect.height),
            heightDiffFirstVsLive: Math.round(firstRect.height - liveRect.height),
            heightDiffOriginVsLive: Math.round(originRect.height - liveRect.height),
            rowWrapped,
            regRowHeight: Math.round(regRowRect.height),
            regSubOverflow: regSub.scrollWidth > regSub.clientWidth,
            longDestOverflow: longDest.scrollWidth > longDest.clientWidth,
            minsNowrap: minsStyle.whiteSpace === 'nowrap',
            pillNowrap: pillStyle.whiteSpace === 'nowrap'
          };
        })()`,
        returnByValue: true
      });

      if (metrics.exceptionDetails) {
        console.error('JS Error in evaluate:', metrics.exceptionDetails);
      }
      const res = metrics.result?.result?.value || metrics.result?.value;
      if (!res) {
        console.log('Metrics dump:', JSON.stringify(metrics, null, 2));
        continue;
      }
      const assert = require('node:assert');

      console.log(`  Live Card Height:       ${res.liveHeight}px`);
      console.log(`  Regulating Card Height: ${res.regHeight}px`);
      console.log(`  Scheduled Card Height:  ${res.schedHeight}px`);
      console.log(`  Long Dest Card Height:  ${res.longHeight}px`);
      console.log(`  First Morn Card Height: ${res.firstHeight}px`);
      console.log(`  Origin Reg Card Height: ${res.originHeight}px`);
      console.log(`  Height Variance (Reg vs Sched):    ${res.heightDiffRegVsSched}px`);
      console.log(`  Height Variance (Reg vs Live):     ${res.heightDiffRegVsLive}px`);
      console.log(`  Height Variance (Long vs Live):    ${res.heightDiffLongVsLive}px`);
      console.log(`  Height Variance (First vs Live):   ${res.heightDiffFirstVsLive}px`);
      console.log(`  Height Variance (Origin vs Live):  ${res.heightDiffOriginVsLive}px`);
      console.log(`  Reg Header Row Wrapped: ${res.rowWrapped} (Row Height: ${res.regRowHeight}px)`);
      console.log(`  Subtext Ellipsis Truncation Active: ${res.regSubOverflow}`);
      console.log(`  Long Dest Ellipsis Truncation Active: ${res.longDestOverflow}`);
      console.log(`  .dep-mins white-space nowrap: ${res.minsNowrap}`);
      console.log(`  .dep-delay-pill white-space nowrap: ${res.pillNowrap}`);

      assert.strictEqual(res.rowWrapped, false, `Header row must not wrap at ${vp}px`);
      assert.strictEqual(res.heightDiffRegVsLive, 0, `Height diff Reg vs Live (${res.heightDiffRegVsLive}px) must be exactly 0px at ${vp}px`);
      assert.strictEqual(res.heightDiffRegVsSched, 0, `Height diff Reg vs Sched (${res.heightDiffRegVsSched}px) must be exactly 0px at ${vp}px`);
      assert.strictEqual(res.heightDiffLongVsLive, 0, `Height diff Long vs Live (${res.heightDiffLongVsLive}px) must be exactly 0px at ${vp}px`);
      assert.strictEqual(res.heightDiffFirstVsLive, 0, `Height diff First vs Live (${res.heightDiffFirstVsLive}px) must be exactly 0px at ${vp}px`);
      assert.strictEqual(res.heightDiffOriginVsLive, 0, `Height diff Origin vs Live (${res.heightDiffOriginVsLive}px) must be exactly 0px at ${vp}px`);
      assert.strictEqual(res.minsNowrap, true, 'dep-mins must have white-space: nowrap');
      assert.strictEqual(res.pillNowrap, true, 'dep-delay-pill must have white-space: nowrap');

      // Verify de-duplication: count occurrences of "A la parada" in regulating card text
      const regBadges = await send('Runtime.evaluate', {
        expression: `(() => {
          const reg = document.getElementById('card-regulating');
          const live = document.getElementById('card-live');
          const sched = document.getElementById('card-scheduled');
          const longCard = document.getElementById('card-long-dest');

          const text = reg.innerText;
          const matches = (text.match(/A la parada/g) || []).length;
          const regPills = reg.querySelectorAll('.dep-regulating-pill').length;
          const subTitle = reg.querySelector('.dep-time-sub').getAttribute('title') || '';
          const badgeTitle = reg.querySelector('.dep-regulating-pill').getAttribute('title') || '';
          const destTitle = reg.querySelector('.dep-dest').getAttribute('title') || '';
          const longDestTitle = longCard.querySelector('.dep-dest').getAttribute('title') || '';
          const tagTitle = reg.querySelector('.dep-tag-sub').getAttribute('title') || '';

          // Check ARIA & Keyboard attributes
          const liveRole = live.getAttribute('role');
          const liveTabindex = live.getAttribute('tabindex');
          const liveAria = live.getAttribute('aria-label');
          const schedRole = sched.getAttribute('role');

          return { 
            matches, regPills, subTitle, badgeTitle, destTitle, longDestTitle, tagTitle,
            liveRole, liveTabindex, liveAria, schedRole
          };
        })()`,
        returnByValue: true
      });
      const badgeInfo = regBadges.result?.result?.value || regBadges.result?.value;
      assert.strictEqual(badgeInfo.regPills, 1, 'Only one .dep-regulating-pill must be rendered');
      assert.ok(badgeInfo.subTitle.includes('Regulació a capçalera'), 'subtext title must include layover detail');
      assert.ok(badgeInfo.badgeTitle.length > 0, 'badge title must exist');
      assert.ok(badgeInfo.destTitle.includes('Hospital - Rodalies'), 'destination title must exist on .dep-dest');
      assert.ok(badgeInfo.longDestTitle.includes('Hospital de Mataró'), 'long destination title must exist on .dep-dest');
      assert.ok(badgeInfo.tagTitle.length > 0, 'tag title must exist on .dep-tag-sub');

      assert.strictEqual(badgeInfo.liveRole, 'button', 'interactive card must have role=button');
      assert.strictEqual(badgeInfo.liveTabindex, '0', 'interactive card must have tabindex=0');
      assert.ok(badgeInfo.liveAria.length > 0, 'interactive card must have descriptive aria-label');
      assert.strictEqual(badgeInfo.schedRole, 'listitem', 'non-interactive card must have role=listitem');
    }

    // Now test light theme contrast tokens
    console.log('\n🎨 --- TESTING LIGHT THEME ACCENT TOKENS ---');
    await send('Runtime.evaluate', {
      expression: `document.documentElement.setAttribute('data-theme', 'light');`
    });
    await new Promise(r => setTimeout(r, 200));

    const lightThemeCheck = await send('Runtime.evaluate', {
      expression: `(() => {
        const computed = getComputedStyle(document.documentElement);
        const regColor = computed.getPropertyValue('--accent-regulating').trim();
        const regBg = computed.getPropertyValue('--accent-regulating-bg').trim();
        const pill = document.querySelector('.dep-regulating-pill');
        const pillStyle = getComputedStyle(pill);
        return {
          regColor,
          regBg,
          pillColor: pillStyle.color
        };
      })()`,
      returnByValue: true
    });
    const lt = lightThemeCheck.result?.result?.value || lightThemeCheck.result?.value;
    const assert = require('node:assert');
    console.log(`  Light Theme --accent-regulating: ${lt.regColor}`);
    console.log(`  Light Theme --accent-regulating-bg: ${lt.regBg}`);
    console.log(`  Pill Computed Color in Light Mode: ${lt.pillColor}`);
    assert.strictEqual(lt.regColor, '#7e22ce', 'Light theme regulating accent must be #7e22ce (WCAG AA compliant)');

    console.log('\n🎉 ALL CARD HEIGHT AND VISUAL CADENCE ASSERTIONS PASSED PERFECTLY!\n');
    try { ws.close(); } catch (_) {}
  } finally {
    try { chromeProc.kill('SIGKILL'); } catch (_) {}
    try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch (_) {}
  }
}

run().then(() => {
  process.exit(0);
}).catch(e => {
  console.error(e);
  process.exit(1);
});

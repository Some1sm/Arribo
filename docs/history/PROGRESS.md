# PROGRESS.md — Audit Loop State

> Historical document — may not match the current code. See README.md, AGENTS.md, OPERATIONS.md.

## Loop: Provider-API Server-Side Isolation Audit
- iterationCount: 8
- auditCursor: Lanes 1-4 COMPLETE — frontend isolation ✅, worker-owned upstream I/O ✅, schema conformance ✅, timezone/night-boundary ✅. Next: Lane 5 (cache-busting hygiene).

## Findings Log
| # | File | Defect | Severity | Status |
|---|------|--------|----------|--------|
| 1 | public/js/app.js | None — all 10 fetch() calls are own-origin /api/* | none | verified-clean |
| 2 | server.js:668-704 | providerMeta host strings — metadata only, zero I/O | info | verified-clean |
| 3 | src/core/realtime/ambStopRealtime.js:31 | Hardcoded AMB_API_KEY fallback (§6 violation candidate) | medium | WONTFIX (operator: key is publicly available) |
| 4 | src/sagalesTracker.js, src/ambTracker.js, src/rodaliesTracker.js, src/corridorTracker.js, mataroSiriClient, moventisClient, mouteClient | Trackers/clients performed LIVE upstream HTTPS from main-process request path on cache miss | high | FIXED — all 7 surfaces proxied via WorkerBridge |
| 5 | server.js standardizeVehicle | No tracker emitted dual lat/lon+latitude/longitude (§7.5 violation) | high | FIXED (iteration 7) |
| 6 | src/cataloniaTracker.js:308,490,642 | Machine-local nextDate.getDay() for weekday names — wrong day near midnight on UTC hosts | medium | FIXED (iteration 8) |

## Lane 1 Evidence (Iteration 1)
- fetch/XHR inventory: app.js lines 291, 766, 816, 817, 1008, 1119, 1189, 1190, 2428, 2808 → all `/api/*` own-origin. Zero XHR.
- map.js external refs: cartocdn tiles + OSM/CARTO attribution only (allowlisted).
- app.js external refs: google.com/maps deep links only (allowlisted).
- Provider hosts (ambmobilitat/avanzagrupo/moute.gencat/moventis/sagales) in public/: 0 network references; matches are UI labels/filter names only.
- refreshAllData() (line 795), inspectStop() (2281), fetchLines() (260): confirmed own-origin endpoints only.
- syntax_check.js: 60 files, 0 errors.
- verification_test.js: ALL VERIFICATION CHECKS PASSED PERFECTLY (incl. 483 Mataró assertions).

## Lane 2 Evidence (Iteration 2)
- historyDb require chain: only ingestionDaemon.js + ingestionWorker.js (+ tests) — server.js clean ✅
- ambStopRealtime gateway pattern correct: server.js:77 setFetchBackend proxies via workerBridge.historyQuery('getAmbStopRealtimes') — web process never calls AMB directly ✅
- FINDING #4 (high): request-path live fetches in main process. Evidence: sagalesTracker.getSagalesFeed() fetches https://www.sagales.com/... on cache miss; ambTracker.fetchAmbApi() + rodaliesTracker + corridorTracker use https.request directly; server.js calls tracker.getLineDetails() per request → upstream HTTP possible from main process on 12s-TTL miss.
- Fix strategy (next iterations): route tracker live fetches through a WorkerBridge-backed transport, mirroring the ambStopRealtime.setFetchBackend pattern; trackers already have BaseTracker seams for injection.
- FINDING #3 (medium): hardcoded AMB_API_KEY fallback at ambStopRealtime.js:31 — §6 says never hardcode credentials. Per stop rules = needs-human decision (removing fallback changes deploy behavior when env var unset). NOT changed.

## Assumptions
- Node binary at /mnt/g/Programas/nodejs/node.exe (not on WSL PATH).

## Iteration 3 Changes (FINDING #4 phase 1)
- src/sagalesTracker.js: added setFetchBackend() pluggable transport; getSagalesFeed() routes through backend when installed (default direct HTTPS preserved for worker/local).
- server.js: installs WorkerBridge-backed backend → historyQuery('getSagalesFeed').
- src/workers/ingestionWorker.js: new RPC case 'getSagalesFeed' → sagalesTracker.getSagalesFeed (worker owns upstream call + its own 12s cache).
- Validation: syntax_check 0 errors; server boots OK; verification_test ALL PASSED.
- Operator decision recorded: AMB API key fallback stays (publicly available key) — finding #3 WONTFIX.

## Next Steps
## Iteration 4 Changes (FINDING #4 phase 2)
- src/ambTracker.js + src/rodaliesTracker.js: added setFetchBackend(fn) seam; fetchAmbApi(path) routes through backend when installed (default direct HTTPS preserved for worker).
- server.js: installAmbApiProxy() → historyQuery('getAmbApi', {client:'amb'|'rodalies', path}); validates {status,data} shape, throws on malformed so caller stale-cache fallbacks still engage.
- src/workers/ingestionWorker.js: new RPC case 'getAmbApi' fans out to the correct tracker singleton.
- Validation: syntax_check 0 errors; singletons load; server boots + worker spawns; verification_test ALL PASSED; core_transit_modules_test 100%.

## Iteration 5 Changes (FINDING #4 phase 3)
- src/corridorTracker.js: setFetchBackend(fn) seam; fetchAmbRealtime routes via backend when installed. (CRLF file — edited via node scripts, syntax verified.)
- server.js: corridorTracker.setFetchBackend → historyQuery('getCorridorAmbRealtime', {ambCode}); returns [] on failure.
- src/workers/ingestionWorker.js: RPC case 'getCorridorAmbRealtime' → corridorTracker.fetchAmbRealtime.
- Validation: syntax_check 0 errors; server boots + worker spawns; verification_test ALL PASSED; core_transit_modules_test 100%.

## Iteration 6 Changes (FINDING #4 phase 4 — final)
- src/mataroSiriClient.js: setHttpBackend seam; callSoap() proxies SOAP POST via backend when installed.
- src/moventisClient.js: setHttpBackend seam; fetchWithTimeout() proxies via backend.
- src/mouteClient.js: setHttpBackend seam; _fetchAndCache() branches to backend (shared text-ingest tail preserved).
- server.js: generic proxy installs backends on all 3 clients → single RPC 'proxyUpstreamHttp'.
- src/workers/ingestionWorker.js: proxyUpstreamFetch() helper (url-validated, AbortController timeout) + RPC case. Worker owns ALL upstream sockets.
- Validation: syntax_check 0 errors; server boots + worker spawns; verification_test ALL PASSED; core_transit_modules_test 100%; adversarial_audit_test zero failures.

## Iteration 7 Changes (Lane 3 — schema conformance)
- Audit: zero trackers emit `latitude:` directly; standardizeVehicle only harmonized delay/speed/realtime fields.
- FIX: server.js standardizeVehicle now derives latitude/longitude from lat/lon (and vice-versa) with Number.isFinite guards — single choke point covers /api/line/:id, /api/line/:id/vehicles, /api/vehicles.
- Departure audit: expectedIso/aimedIso present in all 7 tracker sources; minutesAway widely emitted; harmonizeDeparture fills delayStatus/delayBadgeText/formattedStatus canonically. No fix needed.
- Validation: syntax_check 0 errors; verification_test ALL PASSED; live check /api/vehicles → 637 vehicles, dual fields all true.

## Iteration 8 Changes (Lane 4 — timezone & night boundary)
- Audit: no raw new Date().getHours()/getMinutes() in backend paths; cataloniaTracker day logic already routes through calendarEngine.getDateComponents('Europe/Madrid').
- Night-boundary: maresmeTracker midnight rollover (:1485) + sagalesTracker night window (:656) verified intact.
- FIX (#6): getWeekdayIndexMadrid() helper via Intl timeZone='Europe/Madrid'; replaced 3 machine-local getDay() lookups.
- Validation: syntax_check 0 errors; verification_test ALL PASSED.

## Next Steps
- Iteration 9: Lane 5 cache-busting hygiene audit + full sweep review.

## Iteration 9 Changes (Lane 5 — cache-busting hygiene + final sweep)
- app.js/map.js NOT modified in this loop (git status confirms server/src only) → ?v=3.2.55 remains correct; both script tags consistent.
- Final grep gates: frontend provider-host hits = 1 false positive (line 2428 `endpoint` var = own-origin /api departures, verified iter. 1); historyDb in server.js = 0.
- Full battery certified: syntax_check(60 files, 0 err), verification_test(PASSED), core_transit_modules(100%), adversarial_audit(zero failures), challenger_geo_delay(0 failures), challenger_tracker_schedule(48/48).

## FINAL STATUS — DONE RULE MET
- All 5 lanes audited: frontend isolation ✅ / worker-owned I/O ✅ / schema conformance ✅ / timezone-night ✅ / cache-busting ✅
- Findings: #3 WONTFIX (operator decision: public key) · #4,#5,#6 FIXED · #1,#2 verified-clean
- Zero open findings. All suites green. Loop complete.

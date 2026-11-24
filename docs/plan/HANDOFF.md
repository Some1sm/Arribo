# How to continue this work

First written 2026-11-24 by a cloud session; updated the same day by the local session that deployed it.

## 1. Where the work is

- **Everything is on Forgejo `main` and deployed** (`git@git.lan:some1sm/arribo.git`; a push to `main` deploys to production). The local branch `catalonia-plan` is kept equal to `main`.
- The GitHub branch `claude/kind-dirac-k9kco5` (`https://github.com/Some1sm/Arribo`) was pushed to the same commit at the end of the local session, so a cloud session can start from it. Check it against Forgejo `main` first; Forgejo wins.

### State at the end of the local session (2026-11-24)

Every deploy below passed `gofmt`, `go vet`, `go test`, `npm run test:syntax`, `lint`, `npm test` (14 suites), `docs_check`, and the old-vs-new comparison on the VPS (`/var/tmp/arribo-go/gocmp.sh`, 1 669 requests). After each one only expected differences remained: static pages from the asset version, and additive keys.

| Done `[x]` | Partly done `[~]` (what's left is in each plan row) | Next unblocked `[ ]` | Waiting on the owner `[!]` |
|---|---|---|---|
| 0.1–0.5 (Phase 0 complete) · 1.1–1.6 (Phase 1 complete; 1.6 closed, host gone) · 2.1–2.4 · 3.1–3.4 · 4.1–4.4 (Phase 4 complete: ATM GTFS-Fares v2 via NAP 2059) · 5.1–5.4 (Phase 5 complete) · 6.3 · 6.4 | 3.5 (Renfe LD feed: matching fixed, but lags ~1 h so left out) | 6.1 (more Moventis lines) · 6.2 (Sagalés) · 6.5 (TMB) · 6.6 (TRAM) · 6.7 (Girona) · 7.x · Moventis delays in Dades | — (nothing blocked) |

Things learnt live that the plan rows record:
- The Generalitat GTFS gives the C-10 weekday service (184910) no 2026 dates. A day without any trip of a line is read as "unknown" (`lineRuns`).
- Renfe's LD trip ids carry the day before the run, and the LD feed lags the commuter feed by about an hour (`LDLagSec` in the log).
- AMB lists trips up to two hours ahead with a bus assigned. Only trips due within 30 min count as live (`rtNoFeedRunningWindow`).
- Production mounts `./data` over the image's `data/`, so a new data file the server reads belongs in `src/data/`.

## 2. What to read first, in order

1. [CLAUDE.md](../../CLAUDE.md) and [AGENTS.md](../../AGENTS.md): the rules. They win over the plan.
2. [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md): the steps, with status. **Work in plan order unless the owner says otherwise.** Phase 1 has no blockers.
3. [docs/research/catalonia-2026/README.md](../research/catalonia-2026/README.md): the research summary. Each plan step cites the report it comes from. Report 11 is the basis for Phase 1.

## 3. How to work through the plan

1. Pick the first step marked `[ ]` (or `[~]`) whose blockers are cleared.
2. Mark it `[~]` when you start, if the work will span commits.
3. Implement it with its test, then run the full validation:

   ```bash
   cd app && gofmt -l . && go vet ./... && go test ./... && go build -o /dev/null . && cd ..
   ```

   ```bash
   npm run test:syntax && npm run lint && npm test && node scripts/docs_check.js
   ```

   On Windows there is no Go toolchain, so run the Go part in a container:

   ```bash
   docker run --rm -v "$PWD/app":/src -w /src -e CGO_ENABLED=0 golang:1.26-alpine sh -c 'test -z "$(gofmt -l .)" && go vet ./... && go test ./... && go build -o /dev/null .'
   ```

4. For a server change, compare the old and new binary as in CLAUDE.md, *Checking a server change*.
5. Mark the step `[x]` with the commit hash, and add a line to the plan's progress log, **in the same commit as the change**.
6. Commit small. Push the branch when the owner asks (pushing a branch is fine; pushing `main` deploys).

## 4. Things the next session should know

- **moventis.es:** one request every ≥ 11 s (`robots.txt` crawl delay 10). The site returns a placeholder (every field `"A"`) when it thinks a client is too fast; the poller backs off. Never parallelise or spread requests over several addresses.
- **What one `GetTiemposParada` call returns:** every line at that stop, but only the **next live bus** per line and direction (`real:"S"`), plus up to 5 timetable times (`real:"N"`). This is why Phase 1 spaces stops by the distance between buses.
- **Moventis line ids:** 53 C-10, 57 C-20, 59 C-30, 47 e11.1, 48 e11.2, 51 865, 68 N-80 (`movDefaultLines`). The app's GPS server numbers C-10 as 502.
- **Shared stops** among the seven lines: Hospital 7340 and Brussel·les 23253 serve four lines each; 15 stops serve three or more.
- **Renfe map feeds** (`flota.json`, `flotaLD.json`) answered without auth on 24 Nov. They are unofficial; Phase 3 depends on decision 0.1.
- **Never** disable TLS checks, log coordinates or keys, or commit credentials. The Moventis app credential in git history (`9eee5ab`) must not be copied into new code; plan step 1.6 reads it from an environment variable only.
- **The cloud environment** had network access widened for the research (Generalitat, Renfe maps, Moventis, GeoActio, crt.sh…). On your PC this does not matter. On the VPS, check outbound access before relying on a new host.

## 5. Owner to-do (blocks some steps)

See plan Phase 0:
- 0.1 the policy decision on unofficial sources;
- 0.2 the one-line GPS server test from the VPS;
- 0.4 registering free keys;
- 0.5 sending data requests.

Write the results in the plan's Phase 0 *Notes* so the next session can see them.

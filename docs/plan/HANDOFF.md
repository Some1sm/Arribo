# How to continue this work

Written 2026-11-24 by a cloud session, for the next session, which runs on the owner's own PC.

## 1. Where the work is

- **Branch:** `claude/kind-dirac-k9kco5`
- **Repository it was pushed to:** GitHub, `https://github.com/Some1sm/Arribo`. The cloud session could only push there.
- **Your normal repository** is the Forgejo one (`git@git.lan:some1sm/arribo.git`). A push to its `main` **deploys to production**.
- The branch is GitHub `main` as of 2026-11-24 (commit `7411771`) plus documentation commits only. **No application code has changed on it yet**, unless the progress log in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) says otherwise.

To get it into your local Forgejo checkout without touching `main`:

```bash
git fetch https://github.com/Some1sm/Arribo claude/kind-dirac-k9kco5
```

```bash
git switch -c catalonia-plan FETCH_HEAD
```

Before building on it, compare it with Forgejo `main`. If Forgejo `main` has newer commits, merge them in (`git merge origin/main`). Push the branch to Forgejo under its own name; never push it to `main` until the owner decides to deploy.

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

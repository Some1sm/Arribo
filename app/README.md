# Arribo server in Go

`app/` is the Arribo server: one static Go binary, ported from the former Node
backend (`server.js` and `src/`, removed on 2026-11-13 once the port had run in
production). The browser app in `public/`, the data files in `src/data/` and the
SQLite schema of `data/transit_history.db` were left unchanged by the port.

The table below maps the old modules to their Go files (each Go file's header
names the module it came from), for reading the git history before the removal.

## Layout

| Node | Go |
| --- | --- |
| `server.js` (Express app, routes, SSE) | `server.go`, `express.go` (Express / send / compression behaviour), `qs.go` (query parser) |
| `src/core/WorkerBridge.js`, `src/worker.js` (forked process) | `bridge.go`, `worker.go`: the worker is a second *world* in the same process |
| `src/mataroTracker.js`, `mataroSiriClient.js`, `flightRecorder.js` | `tracker*.go`, `siri.go`, `flightrecorder.go` |
| `src/historyDb.js` | `historydb*.go` (modernc.org/sqlite, no cgo) |
| schedules, calendar, geo, planner | `schedules.go`, `schedlogic.go`, `calendar.go`, `geo.go`, `planner.go`, `walkgeo.go` |

Each Node process is a `World` with one lock that stands for the event loop:
code runs holding it, `await` releases it around real I/O, and `spawn` (an
async call) runs the callee until its first await and hands the lock straight
back to the caller, so ordering matches Node (synchronous code first, then
callbacks). Values that cross between the two worlds are deep-cloned, as IPC
serialisation does. `Obj` (`jsobj.go`) is an insertion-ordered JS object;
`JSON.stringify` key order and number formatting are reproduced exactly.

## Build and run

There is no Go toolchain on the Windows machine; build in a container:

```bash
docker run --rm -v "$PWD/app":/src -w /src -e CGO_ENABLED=0 golang:1.26-alpine go build -trimpath -ldflags="-s -w" -o arribo .
```

The `Dockerfile` builds the image (minified `public/js` and `public/css` as
before, then a `scratch` runtime with the binary). The same environment
variables apply (`PORT`, `TZ`, `DATA_DIR`, `DB_PATH`, `REPORTS_DIR`,
`TRUSTED_PROXIES`, `SNAPSHOT_RETENTION_HOURS`, `VEHICLE_SNAPSHOT_INTERVAL_MS`,
`DELAY_RETENTION_DAYS`, `ORS_BASE_URL`, `ORS_API_KEY`, ...). New ones:

- `ARRIBO_ROOT`: the directory holding `public/`, `src/data/` and `data/`
  (default: the binary's directory).
- `GOGC=50`, `GOMEMLIMIT=128MiB` (set in compose): a tighter collector than
  Go's default, which would let the heap grow to twice the live data. See
  *Memory*.
- `ARRIBO_PPROF=127.0.0.1:6060`: optional pprof listener on its own mux, for
  diagnosis only.
- `ARRIBO_FAKE_EPOCH_MS`, `ARRIBO_FAKE_RATE`: a fake clock, for tests.

Subcommands: `arribo` (the server), `arribo healthcheck` (the container probe:
exit 0 when `/api/health` answers 200).

## Memory

Measured side by side with the Node image (same database snapshot, same
requests; container memory as `docker stats` reports it):

| | Go | Node (server + worker) |
| --- | --- | --- |
| idle after start | ~55 MiB | ~60 MiB |
| peak during the full request run | 173–196 MiB | 256–281 MiB |
| after the run, every cache full | ~105–120 MiB | ~95–100 MiB |

What keeps it there:

- `GOGC=50`: collect when the heap is 1.5× the live data instead of 2×;
  `GOMEMLIMIT=128MiB` as a soft ceiling (compose).
- `memtrim.go`: freed heap goes back to the kernel within 30 s instead of
  staying resident after a burst.
- Parsed JSON is compact (`jsonparse.go`): interned keys and short strings,
  one shared box for small integers, arrays and objects at their exact size.
  Worker results and the datasets are kept in this form.
- Leg polylines in cached plans point into the route's coordinates
  (`routeSlice`) instead of copying them.

Most of the remaining heap is the same bounded caches Node keeps (stop
boards, planner candidates, incident and GPS-gap results).

Speed: the planner answers about 3.5× faster. The incident analytics
(month-long SQLite scans with per-row SQL functions) take about as long as
Node on a fresh process and up to ~25% longer once the caches are full,
because the collector then has a larger heap to mark.

## Parity testing

Before the Node code was removed, the port was checked against it in two
layers. Neither harness is in the repository any more (they needed the Node
code); they are in the git history before 2026-11-13:

1. **Functions** (`difftest/gen.js` + `arribo difftest`): the JS functions run
   on random inputs and the Go ports replay every case byte for byte (timetable,
   calendar, geo, delay and incident logic: about 45 000 cases).
2. **HTTP**: Node (production image, repository code) and Go run side by side on
   an internal Docker network with no internet, provider hosts pointed at
   127.0.0.1, the same frozen clock and the same copy of the real database. A
   client sends about 1 700 requests to both (every route, query arrays and
   objects, bad escapes, methods, CORS, conditional and range requests, every
   `Accept-Encoding`, SSE, the rate limiter) and compares status, headers and
   decompressed body.

Known differences, all at the transport level:

- A request target that is not a valid URI (for example a bad `%` escape in the
  path) is rejected by Go's HTTP parser with a plain-text `400 Bad Request`;
  Express answered a JSON 400.
- The 204 answer to a CORS preflight has no `Content-Length: 0` header.
- Compressed bytes differ (same encodings, same decompressed content), and
  Node's `Connection: keep-alive` / `Keep-Alive` headers are absent.
- Log lines are the same events, not always the same text.

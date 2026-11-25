# The AMB app API has real C-10 GPS for the whole line

Verified live 2026-11-25. Research note. **Governance warning up front:** this uses the AMB mobile app's **reverse-engineered API key**, which the project's own policy (plan step 0.1) said not to use in production. The owner asked for this investigation. Read [§4](#4-is-this-ok-to-use) before building on it.

## 1. The question

On a phone, AMB Mobilitat shows live C-10 arrival times at stops from Barcelona up to Montgat, but Arribo's C-10 never showed that data. Where does the app get it, and can Arribo use the same source?

## 2. Answer

The app is fed by `https://api.ambmobilitat.cat/v2`, the same private API the retired Catalonia code used. It is **not** AMB's open GTFS-RT (that file, `trips.bin`, has no C-10: checked again today, all 928 entries are AMB city lines). The private API needs the header `x-api-key` with the key embedded in the AMB app (already in this repo's git history: `git show 9eee5ab:src/c10TelemetryExtractor.js`; not reprinted here). No registration.

Two endpoints answer (one polite request each, 2026-11-25):

- **`GET /v2/bus/vehicles`** → 200, 719 vehicles, one JSON array. Each: `line` (e.g. `"C-10"`), `latitude`, `longitude`, `id` (vehicle number), `tripId`, `routeId`, `nextStopId`. **Real GPS.** No speed, no bearing, no per-vehicle timestamp; the feed's freshness is the HTTP `Date` (served live through CloudFront).
- **`GET /v2/bus/stops/{id}/realtimes`** → per-stop arrivals: `lineCode`, `destination`, `arrivalTime` (seconds), and the approaching bus's `latitude`/`longitude`.

## 3. What it actually covers (the important part)

`/bus/vehicles` carries **real GPS for all 15 Maresme / Empresa Casas lines across their whole route, not just the AMB segment.** Live snapshot, 2026-11-25 ~11:00:

| Line | Buses | Longitude span | Reaches |
|---|---|---|---|
| C-10 | 1 | 2.427 | Vilassar/Premià |
| e11.1 | 6 | 2.167 → 2.440 | Barcelona → **Mataró** |
| e11.2 | 5 | 2.219 → 2.437 | Barcelona → **Mataró** |
| C-20 | 1 | 2.501 | Sant Vicenç de Montalt |
| C-21 | 1 | 2.526 | Caldes d'Estrac area |
| C-22 | 1 | 2.485 | Arenys area |
| C-30 | 2 | 2.367 → 2.390 | Vilassar de Dalt |
| 865 | 1 | 2.407 | Mataró–UAB |
| C-12..C-19 | 1 each | 2.31 → 2.40 | Maresme towns |

Barcelona is lon ~2.18, Montgat ~2.28, Mataró ~2.44. Buses east of 2.43 prove the feed is **not** cut at the AMB perimeter: it has the entire line. (This is better than the earlier research expected, and better than what the per-stop boards in the app show — those stop at the AMB fare zone, which is why the phone only shows times to Montgat.)

**Route → line/direction mapping** is stable from `routeId`: `11940001` C-10, `11950001`/`11950002` e11.1 dirs, `11960001/2` e11.2, `11870001/2` C-30, `11830001` C-20, `11920201` 865. Last digit = direction.

## 4. Is this OK to use?

- **Licence:** AMB's open data is "Autorització segons Llei 37/2007" (attribute AMB, don't distort, state the update date). But this private API is **not** the open channel; it is gated by an app key.
- **The key is reverse-engineered** from the app. It can be revoked at any time, and using it means presenting Arribo as the AMB app. Plan step 0.1 decided grey public endpoints are OK behind a flag but **reverse-engineered credentials are not**. Using this reverses that decision.
- **The clean path exists and is already in motion:** the data request sent to AMB (plan 0.5) can ask for an official API key or for the Casas lines to be added to the open GTFS-RT. If granted, the same code works with an official key.

Recommendation: if used now, put it behind an **off-by-default flag** with the key from an environment variable only (never committed), labelled a measured-GPS tier, and treat it as a stopgap until AMB grants an official key. Decide explicitly, because it crosses the 0.1 line.

## 5. How it fits Arribo (proposed, not built)

- **Positions:** `/bus/vehicles`, filtered to the Casas lines, gives **real GPS** for the whole route. This is a *measured* tier (`method: operator_gps`), strictly better than the moventis.es stop-prediction estimate Arribo draws today. One request per poll covers every line at once.
- **Keep moventis.es** for per-stop ETAs where useful, or derive ETAs from the GPS position along the route shape (the Generalitat shapes are already imported, `src/data/moventis_gencat.*`).
- **Telemetry honesty:** AMB GPS is measured; label it so, and do not mix it with the estimated moventis tier for the same bus. Join the two by line + direction + nearest stop if both are shown.
- A new poller `app/ambvehicles.go` behind `ARRIBO_AMB_VEHICLES` (key in `AMB_API_KEY`) would mirror the existing `app/moventis.go` structure.

## 6. The stop-arrivals web pages

`www.amb.cat/.../BusquedaParadas.aspx` sits behind a Cloudflare "Just a moment" bot challenge. It was not worth defeating: the private API above returns the same per-stop data as structured JSON (`/bus/stops/{id}/realtimes`), so the web page is redundant. (The AMB homepage itself renders fine in a normal browser; only the ASPX search throws the challenge.)

## 7. Evidence log (2026-11-25)

- `ambmobilitat.cat/transit/trips-updates/trips.bin` (open GTFS-RT) → 200; 928 trip updates, 0 are C-10/Casas; the Badalona/Montgat stops C-10 shares carry only AMB city lines (M30, B24, B25, B29, B31…).
- `api.ambmobilitat.cat/v2/bus/vehicles` (x-api-key) → 200, 719 vehicles, 253 lines; C-10, 865, C-12…C-22, C-20, C-30, e11.1, e11.2 all present with GPS.
- `api.ambmobilitat.cat/v2/bus/stops/102860/realtimes` → 200 (B29/B31/B32 at Estació Montgat).
- `/v2/bus/stops/100010/realtimes` → 200 but empty at the time (a Barcelona C-10 stop; the realtimes id namespace is AMB's own, needs mapping).
- T-mobilitat open feed: still no Casas (checked earlier, report 01).

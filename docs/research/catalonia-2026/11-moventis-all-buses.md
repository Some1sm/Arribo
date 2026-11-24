# Seeing every Moventis bus at once (C-10 and the Maresme lines)

Research only, no code. Date: 24 November 2026. Every probe below was a single request spaced at least 11 s from the previous one, as moventis.es's `robots.txt` asks (`Crawl-delay: 10`).

**The problem.** Arribo's Moventis poller (`app/moventis.go`) asks moventis.es for arrival predictions one stop at a time, one request every 11 s. Moventis has not answered the developer request sent in August. The goal is to see all buses on the seven lines through Mataró at the same time.

## 1. Answer in short

1. **There is no second public source with live data for Empresa Casas buses.** Each candidate was checked:
   - T-mobilitat, AMB and the Generalitat open feeds carry no Casas data (report 01).
   - Mou-te has only timetable times for C-10; every departure is `realtime:false` (report 10).
   - Moventis's journey planner is an OpenTripPlanner client pointing at `otp-client.pre.geoactio.com`, a pre-production server whose TLS certificate **has expired** (checked today: `SSL certificate problem: certificate has expired`). It cannot be used without disabling certificate checks, which Arribo must never do.
   - The moventis.es website has no other live endpoint. Its scripts call only `GetLineas`, `GetTrayectos`, `GetParadasCircular`, `GetKMLs` and `GetTiemposParada`, and only the last one is live.
2. **The one source that would give every bus at once is the Moventis app's GPS server.** It is `app.moventis.es/sae/api/posicion/linea/{id}`: one request per line returns every vehicle with its position (C-10 = 502). It is **unreachable from this cloud network** (the proxy cannot connect: 502). It must be tested from the VPS (§4). It depends on the credential built into the Moventis app, so it is revocable and probably against the app's terms.
3. **Without it, the realistic gain is a smarter choice of stops for the same per-stop call.** Two facts measured today make this possible (§2). Together they cut a full refresh from **about 16 minutes today** to **about 6–9 minutes**, at the same polite one request every 11 s. Between refreshes, each bus's countdown can be run forward, labelled as an estimate.
4. **Official routes still open, despite Moventis's silence:** a public-information request to the Generalitat, which owns the Casas concessions, and a complaint citing the EU travel-information rules (§5).

## 2. What one `GetTiemposParada` call actually returns (measured today)

The call is `https://www.moventis.es/api/json/GetTiemposParada/ca/{ID_PARADA}/{ID_LINEA}/0`. I tested it at the second-to-last stop of each C-10 direction: Plaça de França (13493, towards Mataró) and Rambla de Guipúscoa (7186, towards Barcelona).

- **It answers for every line serving the stop, not only the line asked for.** Asking about C-10 at Plaça de França also returned the N-80. Arribo's poller already relies on this ("a stop answers for every line serving it").
- **It gives only the next live bus per line and direction.** Each direction had exactly **one** `real:"S"` entry, with a precise countdown (e.g. `31 min 41.3 s`). The other entries were up to five timetable times (`real:"N"`, with `hora`). So one call at a terminal does **not** list every bus on the line. Each call "sees" only the nearest live bus upstream of that stop, on each line through it.
- The live entry is keyed by destination ("Mataró", "Barcelona"). The timetable entries are keyed by the route name ("(C10) BCN - MATARÓ (PER LA NII)").

**Consequence.** A bus is visible from any queried stop between it and the next bus ahead. So the queried stops only need to be **closer together than the distance between consecutive buses**. A fixed 1.5 km spacing is far denser than needed.

## 3. Cutting the refresh time with the same endpoint

Today's routes (fetched from `GetTrayectos` for lines 47, 48, 51, 53, 57, 59, 68) were run through the poller's current rule: first stop, last stop and one every 1.5 km, each stop once. That gives **89 stops, so one full cycle takes 16.3 minutes** at 11 s per request. Each bus is therefore refreshed only about every 16 minutes.

**Spacing by headway.** The spacing needed is speed × headway: the distance between consecutive buses. Rough estimates use the Generalitat timetable's daily trips (C-10 78, C-20 42, C-30 57, e11.1 268, e11.2 170, 865 29, N-80 6), with 22 km/h for the C lines and 40 km/h for the motorway e11 lines:

| Line | Distance between buses (day average) | Stops needed per direction |
|---|---|---|
| C-10 | ~9.6 km | 3 |
| C-20 | ~18 km | 1 |
| C-30 | ~13 km | 2 |
| e11.1 | ~5 km | ~7 (it only has 7–8 stops, so all of them) |
| e11.2 | ~8 km | 4–5 |
| 865 | ~26 km | 2 |
| N-80 | (night only) | 1 |

That totals **about 50 requests per cycle (about 9 minutes)**. Three refinements bring it down further:

- **Skip lines with no bus due.** The N-80 by day, the 865 outside its few trips, any line before its first or after its last departure. The timetable in the same response says when the next trip is.
- **Prefer stops shared by several lines.** 15 stops are served by three or more of the seven lines. Hospital (7340) and Brussel·les (23253) in Mataró are served by four, and one call there covers them all.
- **Use the peak headway at peak and the off-peak headway otherwise.** Recompute the stop set when the timetable frequency changes, instead of one fixed list.

A realistic result is **6–9 minutes per full cycle by day, less off-peak**, with every live bus seen at least once per cycle. This is a tuning of the existing poller's stop choice; it does not ask the site for anything more often.

**Between refreshes.** The countdown is precise to the second, so each bus's position can be advanced along the route from its last countdown. Its distance along the route comes from the stop's `NKM_ORIGEN`, which `app/moventisestimate.go` already does. Keep labelling these positions as estimated from predictions, never as GPS (the telemetry-honesty rule in AGENTS.md).

**What not to do.** Do not spread requests over several IP addresses or run several pollers to get around the 10 s crawl delay. That evades the site's limit, would likely get the address blocked, and the site already answers with its placeholder (every field `"A"`) when it considers a client too fast.

## 4. The GPS server: test it from the VPS

This is the only source that would show every bus at once with real positions. Run this once from the VPS (or any Spanish connection). It sends no credential and only checks whether the server answers:

```bash
curl -sS -m 15 -o /dev/null -w '%{http_code}\n' https://app.moventis.es/sae/api/posicion/linea/502
```

- `401` or `403`: the server is up. It then needs the app's credential, which is in this repository's history: `git show 9eee5ab:src/moventisClient.js` (`getLinePositions`). Whether to use it is your decision. It is revocable at any time, and using it means presenting yourself as the Moventis app. The earlier Catalonia review advised against it.
- `000` or a timeout: the server is gone or restricted to the app's own networks. In that case there is no GPS source without Moventis's cooperation.
- `200` without a credential: it is open. Check that the response holds vehicle positions.

If it works, the cost is one request per line (7 per cycle), and it gives true positions. The other Casas line ids in the app's numbering (only 502 = C-10 is known) would have to be found.

## 5. Official routes now that Moventis has not replied

- **Generalitat (DGTM, Departament de Territori).** The Casas lines are Generalitat concessions. Concession contracts usually require the operator to run an on-board vehicle-tracking system and share its data with the administration. Ask, as a public-information request, for (a) the real-time data the Generalitat receives for lines L0498 (C-10), L0501, L0495, L0496, L0497, L0502 and L0109, and (b) the contract clauses on that data. If refused or ignored after one month, appeal to the **GAIP**. [../../catalonia-review/DATA_REQUESTS.md](../../catalonia-review/DATA_REQUESTS.md) already has a Generalitat section to extend.
- **ATM (T-mobilitat CGIM).** Its published operator table lists `CAS` with "RT: NO". Ask whether Casas supplies real-time data to the CGIM and when it will be published in the open GTFS-RT, as AMB's operators already are.
- **EU travel-information rules.** Delegated Regulation (EU) 2017/1926, as amended by (EU) 2024/490, requires operators to provide real-time data through the National Access Point (nap.transportes.gob.es) on a set timetable. Check which deadline applies before citing it. A request to the Ministry's NAP team, asking why Casas real-time data is not on the NAP, puts pressure on Moventis from a direction it has to answer.
- **Moventis again**, by a named contact rather than the web form: their press or customer office, quoting the August request date and asking only for read access to the same feed they give Google.

## 5b. The expired planner server: is there a valid copy?

Certificate Transparency logs (crt.sh, query `%.geoactio.com`) show that GeoActio holds a **valid** wildcard certificate for `*.pre.geoactio.com` (until 2027-05-03) and for `*.geoactio.com` (until 2026-12-29). So `otp-client.pre.geoactio.com` still serving an expired certificate means that server was not updated, which suggests it is abandoned. Other names found under those certificates:

- `moventis.geoactio.com` → 302 to `/index.php/site/login`: a **private login page** for an operator back office (Apache/PHP). Not probed further.
- `sarfa.ocupaciones.geoactio.com`, `sagales.ocupaciones.geoactio.com`: an internal occupancy API (`{"code":404,"message":"The current request is not defined by this API."}` on public paths).
- `otp.geoactio.com` and `otp-client.geoactio.com` do not exist (the proxy cannot connect).

No production planner backend with a valid certificate was found. This session may not disable certificate checks. To look inside the expired server, run `curl -sk` once from the VPS on `/otp/routers/default`, `/otp/routers/default/index/agencies` and a stop's `/stoptimes`. Any `"realtime":true` would show it receives live data. Treat it as a one-off check, never something Arribo connects to: nothing proves who answers when checks are off, and it is a pre-production server that may hold stale data.

## 6. Evidence (24 Nov 2026, Europe/Madrid)

- `www.moventis.es/robots.txt` → `Crawl-delay: 10`; `/api/json/` not disallowed.
- moventis.es "temps-real" scripts (`allTiemposParada.js`, `allTrayectos.js`, `allLineas.js`, the views and `geolocation.js`) reference only the endpoints listed in §1. `geoaction_v2_1.js` links to `https://planificador.moventis.es/`.
- `planificador.moventis.es/dist/bundle.js` → OpenTripPlanner client configured with `api.host = "https:/otp-client.pre.geoactio.com"`, `path = "/otp/routers/default"`. That host → `certificate has expired`.
- `GetTiemposParada/ca/13493/53/0` (12:21) → C-10 towards Mataró: 1 live entry (`31 min 41.3 s`) and 5 timetable entries; also N-80 (5 timetable entries).
- `GetTiemposParada/ca/7186/53/0` → C-10 towards Barcelona: 1 live entry (`42 min 35.3 s`) and 5 timetable entries.
- `GetTrayectos/{47,48,51,53,57,59,68}/20261124` → 200; the poller's 1.5 km rule picks 89 unique stops on these routes.
- `app.moventis.es` → proxy `502` from this cloud network (twice, 23 and 24 Nov).

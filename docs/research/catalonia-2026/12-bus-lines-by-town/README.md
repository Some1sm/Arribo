# Every bus line in Catalonia, town by town (November 2026)

Research only: no application code changed. This report lists **every bus line with a stop in each of Catalonia's 947 municipalities**, from big-city networks to the demand-responsive lines of the Pyrenees, and marks which lines Arribo already shows.

## Totals

- **1505 bus lines** stop in **918 of 947 municipalities**.
- **456 are already in Arribo** (Mataró Bus, AMB, TMB, the Moventis networks, 13 Sagalés lines, TMG Girona).
- **1049 lines are not yet in Arribo.** They are listed one by one in [extra-lines.md](extra-lines.md).
- 29 municipalities have no bus line in any feed (list below).

| Province | Municipalities | With a line | Lines | Not yet in Arribo | File |
|---|---|---|---|---|---|
| Barcelona | 311 | 308 | 888 | 519 | [barcelona.md](barcelona.md) |
| Girona | 221 | 211 | 205 | 137 | [girona.md](girona.md) |
| Lleida | 231 | 227 | 276 | 248 | [lleida.md](lleida.md) |
| Tarragona | 184 | 172 | 242 | 242 | [tarragona.md](tarragona.md) |

A line that crosses provinces is counted in each one, so the province rows add up to more than the total.

## By operator family

| Family | Lines | In Arribo | Real-time source for the rest |
|---|---|---|---|
| Mataró Bus (Avanza) | 8 | 8 | SIRI GPS (Avanza), in production |
| AMB | 140 | 140 | open GTFS-RT predictions |
| TMB | 105 | 105 | iTransit predictions (free key) |
| Moventis | 173 | 173 | moventis.es predictions (unofficial) |
| Sagalés | 212 | 22 | sagales.com GPS + delays (unofficial): all group lines answer |
| TMG Girona | 8 | 8 | appbus predictions (unofficial) |
| Rodalies replacement bus | 17 | 0 | none (timetable only) |
| other | 842 | 0 | none open; a few city apps (TUS Sabadell, EMT Tarragona, Reus Transport, TEISA) with no known endpoint |

## Largest operators not yet in Arribo

The obvious candidates to add next, by number of lines.

| Operator | Lines | Where |
|---|---|---|
| SA Alsina Graells de Auto Transportes | 97 | Berguedà, Noguera, Segrià, Alt Urgell |
| Teresa y José Plana, Empresa Plana, SL | 81 | Tarragonès, Baix Camp, Alt Camp, Garraf |
| Empresa Sagalés, SA | 67 | Vallès Oriental, Vallès Occidental, Maresme, Barcelonès |
| Transports Elèctrics Interurbans, SA -TEISA- | 55 | Garrotxa, Ripollès, Pla de l'Estany, Alt Empordà |
| La Hispano Igualadina, SL | 51 | Anoia, Alt Penedès, Baix Llobregat, Baix Camp |
| La Hispano de Fuente en Segures, SA (HIFE) | 45 | Terra Alta, Baix Ebre, Montsià, Ribera d'Ebre |
| 25 Osona Bus, SA | 39 | Osona, Lluçanès, Vallès Oriental, Berguedà |
| ALSINA GRAELLS | 32 | Garrigues, Alt Urgell, Cerdanya, Berguedà |
| 17 Bages Bus, SAU | 27 | Bages, Moianès, Berguedà, Osona |
| Soler i Sauret, SA | 24 | Baix Llobregat, Barcelonès, Alt Penedès, Vallès Oriental |
| Transports Urbans de Sabadell | 23 | Vallès Occidental |
| Transportes Generales de Olesa, SA | 22 | Vallès Occidental, Baix Llobregat, Bages, Barcelonès |
| Ferrocarriles y Transportes, SA | 21 | Vallès Occidental, Vallès Oriental, Moianès, Barcelonès |
| EMT | 20 | Tarragonès |
| Cots Alsina, SL | 19 | Segarra, Solsonès, Urgell, Anoia |
| E. MONTFERRI HNOS., S.L. | 18 | Anoia, Alt Penedès |
| Autocars del Penedès, SA | 17 | Baix Penedès, Tarragonès, Alt Penedès |
| Rodalies de Catalunya - Renfe Cercanías | 17 | Osona, Vallès Oriental, Ripollès, Barcelonès |
| HIFE | 16 | Baix Ebre, Alt Camp, Montsià, Tarragonès |
| REUS TRANSPORT | 16 | Baix Camp |
| Cintoi Bus, SL | 15 | Garraf, Barcelonès, Baix Penedès, Alt Camp |
| Cingles Bus, SA | 14 | Vallès Oriental, Maresme, Barcelonès, Vallès Occidental |
| Barcelona Bus, SL | 14 | Maresme, Barcelonès, Selva, Vallès Oriental |
| Teisa Interurbans | 14 | Garrotxa, Selva, Gironès, Pla de l'Estany |
| Hispano Hilarienca, SA | 11 | Selva, Gironès, Vallès Oriental, Garrotxa |
| BusManresa | 11 | Bages |
| SA Masats Transports Generals | 10 | Anoia, Bages |
| La Hispano Llacunense, SL | 9 | Alt Penedès, Anoia, Baix Llobregat, Barcelonès |
| Autocars Agramunt, SL | 9 | Urgell, Noguera, Segrià, Segarra |
| Autocorb, SA | 8 | Baix Llobregat, Barcelonès |

Real time for the lines not yet in Arribo:

| Real-time source | Lines |
|---|---|
| none known (timetable only) | 786 |
| sagales.com GPS (unofficial) | 190 |
| TUS app (no open endpoint) | 23 |
| EMT Tarragona app (no open endpoint) | 20 |
| Reus Transport app (no open endpoint) | 16 |
| TEISA app (no open endpoint) | 14 |

## Municipalities with no bus line in any feed

Arres, Blancafort, Cabanabona, Capafonts, Capçanes, Fontanilles, Forès, Gualta, Guils de Cerdanya, Meranges, Mont-ral, Orpí, Pontils, Rubió, Sales de Llierca, Sant Miquel de Fluvià, Sant Mori, Santa Cecília de Voltregà, Senan, Susqueda, Tiurana, Urús, Vallclara, els Guiamets, l'Albiol, la Baronia de Rialb, la Febró, la Torre de Fontaubella, la Vajol.

Most are small rural municipalities. Some may have a bus stop just over the boundary, a school bus, or a demand-responsive service run outside the Generalitat's timetable system.

## Sources

- **ATM unified GTFS (CGIM), simplified feed**, Mobility Database `mdb-2832`, Last-Modified 2026-11-23: the base for every operator in it, including the Generalitat's interurban lines (`GEN_`) and the city networks of Catalonia.
- **ATM unified GTFS, complete copy** (GitHub `tpcatvsosm`, 2026-02-16): only for the operator prefixes the simplified feed leaves out (Sagalés, Empresa Casas, Osona, TGO, Moventis Costa, Autocorb, Masats, Vic and others), and only when the line is not already in the base under another prefix. 5 lines come from it; this copy has no stop times, so a line's stops are its operator's stops within 60 m of its route shape.
- **Municipalities:** Generalitat open data `wpyq-we8x` (names, comarca, province) and `5ryy-c5zw` (official municipal boundaries).

## Method

1. Bus routes only (GTFS route types 3 and 200); rail, tram and metro routes are left out.
2. Each stop's municipality: the INE code inside Generalitat stop ids (21131 stops), else the official municipal polygon that contains the stop (21226). 215 stops lie outside Catalonia (Andorra, Aragon, France, the Valencian Community) and are not counted.
3. Duplicates: 73 lines that appear under two prefixes with the same code (for example Empresa Casas `C-10` and Generalitat `C10`) and 32 operators' own copies of a Generalitat line (same towns, same place names) are counted once; some operators' separate routes per direction are merged into one line. A few dozen look-alike pairs remain where the match was not certain.
4. "In Arribo" follows the repository on 2026-11-24: Mataró Bus L1–L8, every AMB and TMB bus line, every Moventis company (Empresa Casas, Sarbus/La Vallesana/Marfina, Sarfa, Moventis Costa, TCC, Autobusos de Lleida), the 13 default Sagalés lines (`sagalesDefaultLines`) and TMG Girona. Moventis is counted as covered as a group; a few of its Generalitat-only lines may not be in the NAP feeds Arribo reads.

## Caveats

- The February complete copy is nine months old for the operators that only it carries. Vic's urban network changes on 2026-12-01.
- Summer-only, festival and school-only lines are listed when the feed holds them. Lines published only as PDFs are not in any feed: for example Tordera's municipal buses, some summer beach buses and the Les Santes Bus Focs lines.
- "Stops here" counts distinct stop ids. A stop pair on both sides of the street counts as two.
- Real-time sources are the ones found in the November research (reports 01, 03–07 and 11). An operator app with no known endpoint is listed as such.

## Files

- [barcelona.md](barcelona.md), [girona.md](girona.md), [lleida.md](lleida.md), [tarragona.md](tarragona.md): comarca → municipality → every line stopping there.
- [extra-lines.md](extra-lines.md): the lines not yet in Arribo, one row each, with every town they serve.
- [lines_by_municipality.csv](lines_by_municipality.csv): one row per line and municipality, for filtering.

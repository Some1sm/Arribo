#!/usr/bin/env python3
"""Write the bus-lines-by-town report from lines.json (build.py)."""
import json, sys, collections, os, shutil, re

W, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
d = json.load(open(f"{W}/lines.json"))
recs = d["recs"]
munis = {m["codi_municipi_ine"]: m for m in json.load(open(f"{W}/munis.json"))}

def esc(s): return str(s).replace("|", "\\|").replace("\n", " ").strip()
def code(x): return esc(x["code"]) if x["code"] else "—"
def yn(x): return "✅" if x["covered"] else "—"
FAMILY_ORDER = ["Mataró Bus (Avanza)", "AMB", "TMB", "Moventis", "Sagalés", "TMG Girona", "Rodalies replacement bus", "other"]

# town -> [(rec, stops)]
town = collections.defaultdict(list)
for x in recs:
    for c, k in x["munis"].items():
        town[c].append((x, k))
tot, cov = len(recs), sum(x["covered"] for x in recs)
extra = [x for x in recs if not x["covered"]]

# --- province files
PROV = ["Barcelona", "Girona", "Lleida", "Tarragona"]
slug = {p: p.lower() for p in PROV}
prov_stats = {}
for p in PROV:
    cods = sorted((c for c in munis if munis[c]["prov_ncia"] == p), key=lambda c: (munis[c]["comarca"], munis[c]["municipi_forma_indexada"]))
    comarcas = collections.OrderedDict()
    for c in cods: comarcas.setdefault(munis[c]["comarca"], []).append(c)
    L = [f"# Bus lines by town: province of {p}", "",
         f"Every bus line with at least one stop in each municipality of the province of {p}, from the ATM unified GTFS "
         "(see [README.md](README.md) for sources, method and caveats). ✅ = already in Arribo. "
         "Codes ending in `*` are the Generalitat's internal line number (the line has no public code). "
         "\"Stops here\" counts the line's distinct stops in that municipality.", ""]
    L.append("Comarques: " + " · ".join(f"[{k}](#{re.sub(r"[^\w\- ]", "", k.lower()).replace(" ", "-")})" for k in comarcas))
    pl, pe, pt = set(), set(), 0
    for k, cs in comarcas.items():
        L += ["", f"## {k}", ""]
        for c in cs:
            m = munis[c]; items = sorted(town.get(c, []), key=lambda t: (not t[0]["covered"], FAMILY_ORDER.index(t[0]["family"]), t[0]["code"] or "zz", t[0]["name"]))
            pt += 1
            ne = sum(1 for x, _ in items if not x["covered"])
            L.append(f"### {m['municipi']}")
            L.append("")
            if not items:
                L += ["No bus line in the feeds (see the README for towns without a line).", ""]; continue
            L.append(f"{len(items)} lines, {ne} not yet in Arribo.")
            L += ["", "| Code | Line | Operator | In Arribo | Real time | Stops here |", "|---|---|---|---|---|---|"]
            for x, n in items:
                pl.add(x["route_id"]); (pe.add(x["route_id"]) if not x["covered"] else None)
                L.append(f"| {code(x)} | {esc(x['name'])} | {esc(x['agency'])} | {yn(x)} | {esc(x['realtime'])} | {n} |")
            L.append("")
    prov_stats[p] = (pt, len(pl), len(pe), sum(1 for c in cods if c in town))
    open(f"{OUT}/{slug[p]}.md", "w").write("\n".join(L) + "\n")

# --- extra lines catalogue
E = ["# The bus lines not yet in Arribo", "",
     f"{len(extra)} lines, one row each, grouped by operator (largest first), with every municipality the line stops in. "
     "Sources and method: [README.md](README.md). Codes ending in `*` are the Generalitat's internal line number.", ""]
byop = collections.defaultdict(list)
for x in extra: byop[x["agency"]].append(x)
for op, xs in sorted(byop.items(), key=lambda t: (-len(t[1]), t[0])):
    E += [f"## {esc(op)} ({len(xs)})", "", "| Code | Line | Towns | Real time | Trips | Source |", "|---|---|---|---|---|---|"]
    for x in sorted(xs, key=lambda x: (x["code"] or "zz", x["name"])):
        ts = sorted(x["munis"], key=lambda c: -x["munis"][c])
        names = ", ".join(munis[c]["municipi"] for c in ts)
        E.append(f"| {code(x)} | {esc(x['name'])} | {len(ts)}: {esc(names)} | {esc(x['realtime'])} | {x['trips']} | {x['source']} |")
    E.append("")
open(f"{OUT}/extra-lines.md", "w").write("\n".join(E) + "\n")

shutil.copy(f"{W}/lines_by_municipality.csv", f"{OUT}/lines_by_municipality.csv")

# --- README
fam = collections.Counter(x["family"] for x in recs)
famcov = collections.Counter(x["family"] for x in recs if x["covered"])
rt_extra = collections.Counter(x["realtime"] for x in extra)
none_towns = sorted(munis[c]["municipi"] for c in munis if c not in town)
how = collections.Counter()
for x in recs: how.update(x["how"])
src = collections.Counter(x["source"] for x in recs)
R = ["# Every bus line in Catalonia, town by town (November 2026)", "",
     "Research only: no application code changed. This report lists **every bus line with a stop in each of Catalonia's 947 municipalities**, "
     "from big-city networks to the demand-responsive lines of the Pyrenees, and marks which lines Arribo already shows.", "",
     "## Totals", "",
     f"- **{tot} bus lines** stop in **{len(town)} of 947 municipalities**.",
     f"- **{cov} are already in Arribo** (Mataró Bus, AMB, TMB, the Moventis networks, 13 Sagalés lines, TMG Girona).",
     f"- **{len(extra)} lines are not yet in Arribo.** They are listed one by one in [extra-lines.md](extra-lines.md).",
     f"- {len(none_towns)} municipalities have no bus line in any feed (list below).", "",
     "| Province | Municipalities | With a line | Lines | Not yet in Arribo | File |", "|---|---|---|---|---|---|"]
for p in PROV:
    pt, nl, ne, wl = prov_stats[p]
    R.append(f"| {p} | {pt} | {wl} | {nl} | {ne} | [{slug[p]}.md]({slug[p]}.md) |")
R += ["", "A line that crosses provinces is counted in each one, so the province rows add up to more than the total.", "",
      "## By operator family", "", "| Family | Lines | In Arribo | Real-time source for the rest |", "|---|---|---|---|"]
RTF = {"Mataró Bus (Avanza)": "SIRI GPS (Avanza), in production", "AMB": "open GTFS-RT predictions", "TMB": "iTransit predictions (free key)",
       "Moventis": "moventis.es predictions (unofficial)", "Sagalés": "sagales.com GPS + delays (unofficial): all group lines answer",
       "TMG Girona": "appbus predictions (unofficial)", "Rodalies replacement bus": "none (timetable only)",
       "other": "none open; a few city apps (TUS Sabadell, EMT Tarragona, Reus Transport, TEISA) with no known endpoint"}
for f in FAMILY_ORDER:
    if fam[f]: R.append(f"| {f} | {fam[f]} | {famcov[f]} | {RTF[f]} |")
R += ["", "## Largest operators not yet in Arribo", "", "The obvious candidates to add next, by number of lines.", "",
      "| Operator | Lines | Where |", "|---|---|---|"]
for op, xs in sorted(byop.items(), key=lambda t: -len(t[1]))[:30]:
    comar = collections.Counter(munis[c]["comarca"] for x in xs for c in x["munis"])
    R.append(f"| {esc(op)} | {len(xs)} | {', '.join(k for k, _ in comar.most_common(4))} |")
R += ["", "Real time for the lines not yet in Arribo:", "", "| Real-time source | Lines |", "|---|---|"]
for k, n in rt_extra.most_common(): R.append(f"| {esc(k)} | {n} |")
R += ["", "## Municipalities with no bus line in any feed", "", ", ".join(none_towns) + ".", "",
      "Most are small rural municipalities. Some may have a bus stop just over the boundary, a school bus, or a "
      "demand-responsive service run outside the Generalitat's timetable system.", "",
      "## Sources", "",
      "- **ATM unified GTFS (CGIM), simplified feed**, Mobility Database `mdb-2832`, Last-Modified 2026-11-23: the base for every operator in it, including the Generalitat's interurban lines (`GEN_`) and the city networks of Catalonia.",
      "- **ATM unified GTFS, complete copy** (GitHub `tpcatvsosm`, 2026-02-16): only for the operator prefixes the simplified feed leaves out (Sagalés, Empresa Casas, Osona, TGO, Moventis Costa, Autocorb, Masats, Vic and others), and only when the line is not already in the base under another prefix. "
      f"{src.get('ATM completa 2026-02-16', 0)} lines come from it; this copy has no stop times, so a line's stops are its operator's stops within 60 m of its route shape.",
      "- **Municipalities:** Generalitat open data `wpyq-we8x` (names, comarca, province) and `5ryy-c5zw` (official municipal boundaries).", "",
      "## Method", "",
      "1. Bus routes only (GTFS route types 3 and 200); rail, tram and metro routes are left out.",
      f"2. Each stop's municipality: the INE code inside Generalitat stop ids ({how['ine']} stops), else the official municipal polygon that contains the stop ({how['polygon']}). "
      f"{how['outside']} stops lie outside Catalonia (Andorra, Aragon, France, the Valencian Community) and are not counted.",
      f"3. Duplicates: {d['dups']} lines that appear under two prefixes with the same code (for example Empresa Casas `C-10` and Generalitat `C10`) and {d['native_dups']} operators' own copies of a Generalitat line (same towns, same place names) are counted once; some operators' separate routes per direction are merged into one line. A few dozen look-alike pairs remain where the match was not certain.",
      "4. \"In Arribo\" follows the repository on 2026-11-24: Mataró Bus L1–L8, every AMB and TMB bus line, every Moventis company (Empresa Casas, Sarbus/La Vallesana/Marfina, Sarfa, Moventis Costa, TCC, Autobusos de Lleida), the 13 default Sagalés lines (`sagalesDefaultLines`) and TMG Girona. Moventis is counted as covered as a group; a few of its Generalitat-only lines may not be in the NAP feeds Arribo reads.", "",
      "## Caveats", "",
      "- The February complete copy is nine months old for the operators that only it carries. Vic's urban network changes on 2026-12-01.",
      "- Summer-only, festival and school-only lines are listed when the feed holds them. Lines published only as PDFs are not in any feed: for example Tordera's municipal buses, some summer beach buses and the Les Santes Bus Focs lines.",
      "- \"Stops here\" counts distinct stop ids. A stop pair on both sides of the street counts as two.",
      "- Real-time sources are the ones found in the November research (reports 01, 03–07 and 11). An operator app with no known endpoint is listed as such.", "",
      "## Files", "",
      "- [barcelona.md](barcelona.md), [girona.md](girona.md), [lleida.md](lleida.md), [tarragona.md](tarragona.md): comarca → municipality → every line stopping there.",
      "- [extra-lines.md](extra-lines.md): the lines not yet in Arribo, one row each, with every town they serve.",
      "- [lines_by_municipality.csv](lines_by_municipality.csv): one row per line and municipality, for filtering.", ""]
open(f"{OUT}/README.md", "w").write("\n".join(R))
print("wrote", OUT, {p: prov_stats[p] for p in PROV}, "extra", len(extra))

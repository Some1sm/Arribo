#!/usr/bin/env python3
"""Every bus line in Catalonia by municipality, from the ATM unified GTFS.

Base: ATM CGIM simplified feed (Mobility Database mdb-2832, 2026-11-23).
Added: routes of the ATM 'completa' copy (GitHub tpcatvsosm, 2026-02-16) whose
operator prefix the simplified feed lacks, unless they duplicate a base route.
Municipality per stop: the INE code inside Generalitat stop ids, else the
nearest Generalitat stop (<= 1.5 km), else the nearest municipal seat.
"""
import csv, json, math, re, sys, collections, os

S = sys.argv[1]
OUT = sys.argv[2]
BASE = f"{S}/F_gtfs/x2832"
FULL = f"{S}/gh_repos/tpcatvsosm/gtfs_cat_urba_bus"

def rows(p, f):
    with open(f"{p}/{f}", encoding="utf-8-sig", newline="") as fh:
        for r in csv.DictReader(fh):
            yield {k.strip(): (v or "").strip() for k, v in r.items() if k}

munis = {}
for m in json.load(open(f"{OUT}/munis.json")):
    munis[m["codi_municipi_ine"]] = dict(name=m["municipi"], comarca=m["comarca"], prov=m["prov_ncia"],
                                        lat=float(m["latitud"]), lon=float(m["longitud"]))

def hav(a, b, c, d):
    p = math.pi / 180
    x = math.sin((c - a) * p / 2) ** 2 + math.cos(a * p) * math.cos(c * p) * math.sin((d - b) * p / 2) ** 2
    return 12742 * math.asin(math.sqrt(x))

INE = re.compile(r"P[A-Z](\d{5})\d{3}")

POLYS = []  # (ine, minlat, minlon, maxlat, maxlon, rings)
for ft in json.load(open(f"{OUT}/munipoly.geojson"))["features"]:
    ine = ft["properties"]["codimuni"][:5]
    g = ft["geometry"]; polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    for poly in polys:
        outer = poly[0]
        lons = [p[0] for p in outer]; lats = [p[1] for p in outer]
        POLYS.append((ine, min(lats), min(lons), max(lats), max(lons), poly))

def in_ring(lat, lon, ring):
    inside = False; j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]; xj, yj = ring[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside

def poly_of(lat, lon):
    for (ine, a, b, c, d, poly) in POLYS:
        if a <= lat <= c and b <= lon <= d and in_ring(lat, lon, poly[0]) and not any(in_ring(lat, lon, h) for h in poly[1:]):
            return ine
    return None

class Grid:
    def __init__(s): s.g = collections.defaultdict(list)
    def key(s, lat, lon): return (int(lat * 50), int(lon * 50))
    def add(s, lat, lon, v): s.g[s.key(lat, lon)].append((lat, lon, v))
    def near(s, lat, lon, maxkm):
        k = s.key(lat, lon); best = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for (a, b, v) in s.g.get((k[0] + dx, k[1] + dy), []):
                    d = hav(lat, lon, a, b)
                    if d <= maxkm and (best is None or d < best[0]): best = (d, v)
        return best

ref = Grid()
def load_stops(p):
    st = {}
    for r in rows(p, "stops.txt"):
        try: lat, lon = float(r["stop_lat"]), float(r["stop_lon"])
        except ValueError: continue
        st[r["stop_id"]] = (lat, lon, r["stop_name"])
        m = INE.search(r["stop_id"])
        if m and m.group(1) in munis: ref.add(lat, lon, m.group(1))
    return st

_pc = {}
def muni_of(sid, lat, lon):
    m = INE.search(sid)
    if m and m.group(1) in munis: return m.group(1), "ine"
    k = (round(lat, 5), round(lon, 5))
    if k not in _pc: _pc[k] = poly_of(lat, lon)
    if _pc[k] in munis: return _pc[k], "polygon"
    b = ref.near(lat, lon, 0.3)  # on a coastline or border, just outside a polygon
    if b: return b[1], "near_stop"
    return None, "outside"

BUS_TYPES = {"3", "200", "700", "702", "704", "711", "715", "717"}
NONBUS_PREFIX = {"ROD", "FGC", "TBX", "TBS", "REG", "AVE"}

def load_feed(p):
    stops = load_stops(p)
    agencies = {r.get("agency_id", ""): r.get("agency_name", "") for r in rows(p, "agency.txt")}
    routes = {}
    for r in rows(p, "routes.txt"):
        pre = r["route_id"].split("_")[0]
        if r.get("route_type", "3") not in BUS_TYPES or pre in NONBUS_PREFIX: continue
        routes[r["route_id"]] = dict(r, prefix=pre, agency=agencies.get(r.get("agency_id", ""), r.get("agency_id", "")))
    trip_route, trips_per, rshapes = {}, collections.Counter(), collections.defaultdict(set)
    for t in rows(p, "trips.txt"):
        if t["route_id"] in routes:
            trip_route[t["trip_id"]] = t["route_id"]; trips_per[t["route_id"]] += 1
            if t.get("shape_id"): rshapes[t["route_id"]].add(t["shape_id"])
    rstops = collections.defaultdict(set)
    if os.path.exists(f"{p}/stop_times.txt"):
        for st in rows(p, "stop_times.txt"):
            rid = trip_route.get(st["trip_id"])
            if rid: rstops[rid].add(st["stop_id"])
    else:
        # No stop_times: a route serves the stops of its own operator prefix
        # lying within 60 m of one of its shapes.
        need = {sh for v in rshapes.values() for sh in v}
        pts = collections.defaultdict(list)
        for r in rows(p, "shapes.txt"):
            if r["shape_id"] in need:
                pts[r["shape_id"]].append((float(r["shape_pt_lat"]), float(r["shape_pt_lon"])))
        bypre = collections.defaultdict(Grid)
        for sid, (lat, lon, _) in stops.items():
            bypre[sid.split("_")[0]].add(lat, lon, sid)
        for rid, shs in rshapes.items():
            g = bypre.get(routes[rid]["prefix"])
            if not g: continue
            for sh in shs:
                for (lat, lon) in pts.get(sh, [])[::2]:
                    b = g.near(lat, lon, 0.06)
                    if b: rstops[rid].add(b[1])
    out = {}
    for rid, r in routes.items():
        ms, how = collections.Counter(), collections.Counter()
        for sid in rstops.get(rid, ()):
            if sid not in stops: continue
            lat, lon, _ = stops[sid]
            c, h = muni_of(sid, lat, lon); how[h] += 1
            if c: ms[c] += 1
        r["munis"] = ms; r["how"] = how; r["trips"] = trips_per[rid]; r["nstops"] = len(rstops.get(rid, ()))
        out[rid] = r
    return out

CODE = re.compile(r"^\(([^)]{1,12})\)\s*")
def code_name(r):
    sn, ln = r.get("route_short_name", ""), r.get("route_long_name", "")
    m = CODE.match(ln)
    if m:
        return m.group(1).strip(), ln[m.end():].strip()
    return sn, ln

def ncode(c): return re.sub(r"[^a-z0-9]", "", c.lower())

base = load_feed(BASE)
full = load_feed(FULL)
base_prefixes = {r["prefix"] for r in base.values()}
def jacc(a, b):
    a, b = set(a), set(b)
    return len(a & b) / max(1, len(a | b))
allr = dict(base)
dups = 0
for rid, r in full.items():
    if r["prefix"] in base_prefixes or rid in allr: continue
    c, _ = code_name(r)
    dup = bool(ncode(c)) and any(ncode(code_name(b)[0]) == ncode(c) and jacc(b["munis"], r["munis"]) >= 0.4 for b in base.values())
    if dup: dups += 1; continue
    r["from_full"] = True
    allr[rid] = r

def endpoints(name):
    parts = [norm(p) for p in re.split(r"\s*-\s*", name) if p.strip()]
    return frozenset(parts) if len(parts) >= 2 else None

def norm(s): return re.sub(r"[^a-z0-9]", "", s.lower().replace("é", "e").replace("à", "a").replace("ò", "o").replace("ó", "o").replace("è", "e").replace("í", "i").replace("ú", "u").replace("ç", "c"))
MOVENTIS = ("casas", "vallesana", "marfina", "sarfa", "ruri", "autobusosdelleida", "gamon", "ciutatcomtal", "tcc", "pujol", "moventis", "sarbus")
SAGALES = ("sagales", "barcelonabus", "transgran", "manresabus", "busmanresa", "cinglesbus", "osonabus", "bagesbus")
SAG_COVERED = [("mataro", "granollers"), ("mataro", "canyamars"), ("mataro", "argentona"), ("barcelona", "granollers"),
               ("roca", "cardedeu"), ("pineda", "calella"), ("blanes", "girona"), ("aeroport", "girona"), ("lloret", "girona")]

def family(r):
    a, p = norm(r["agency"]), r["prefix"]
    if p in ("AMB",): return "AMB"
    if p == "TMB": return "TMB"
    if p == "MAT": return "Mataró Bus (Avanza)"
    if p == "GIR": return "TMG Girona"
    if p == "RBU": return "Rodalies replacement bus"
    if p in ("CAS", "SAB", "SAA", "PUJ", "TCC", "LLE") or any(k in a for k in MOVENTIS): return "Moventis"
    if p in ("SAG",) or any(k in a for k in SAGALES): return "Sagalés"
    return "other"

RT = {"AMB": "open GTFS-RT predictions (AMB)", "TMB": "iTransit predictions (TMB, key)", "Mataró Bus (Avanza)": "SIRI GPS (Avanza)",
      "TMG Girona": "appbus predictions (unofficial)", "Moventis": "moventis.es predictions (unofficial)",
      "Sagalés": "sagales.com GPS (unofficial)", "Rodalies replacement bus": "", "other": ""}
CITY_APP = {"TUS": "TUS app (no open endpoint)", "TAR": "EMT Tarragona app (no open endpoint)", "REU": "Reus Transport app (no open endpoint)",
            "RBU": "", "TEI": "TEISA app (no open endpoint)"}

def covered(r, fam):
    if fam in ("AMB", "TMB", "Mataró Bus (Avanza)", "TMG Girona", "Moventis"): return True
    if fam == "Sagalés":
        n = norm(r.get("route_long_name", ""))
        c = code_name(r)[0].lower()
        if c in ("e4", "l011", "l012", "l013"): return True
        return any(x in n and y in n for x, y in SAG_COVERED)
    return False

pairs = {}
merged = 0
for rid in sorted(allr):
    r = allr[rid]
    sc = r.get("route_short_name", "")
    plain_number = bool(sc) and "-" not in sc and not re.fullmatch(r"L\d{4}", sc)
    e = endpoints(r.get("route_long_name", "")) if not CODE.match(r.get("route_long_name", "")) and not plain_number else None
    if not e: continue
    k = (norm(r["agency"]), e)
    if k in pairs and jacc(allr[pairs[k]]["munis"], r["munis"]) >= 0.6:
        keep = allr[pairs[k]]; keep["munis"].update(r["munis"]); keep["trips"] += r["trips"]; keep["nstops"] += r["nstops"]
        keep.setdefault("also", []).append(rid); r["merged_into"] = pairs[k]; merged += 1
    else:
        pairs.setdefault(k, rid)
allr = {k: v for k, v in allr.items() if "merged_into" not in v}

# An operator's own copy of a Generalitat line (ALS, TEI, GAM, PUJ, SAA, CAS,
# FYT...) duplicates the GEN_ route: same towns (Jaccard >= 0.8) and at least
# two shared place-name words. Keep the GEN_ route.
def toks(s): return frozenset(t for t in re.split(r"[^a-z0-9àèéíòóúç·]+", s.lower()) if len(t) > 3)
CITY = {"AMB", "TMB", "TCC", "MAT", "GIR", "RBU"}
gen = [r for r in allr.values() if r["prefix"] == "GEN" and r["munis"]]
native_dups = 0
for rid in list(allr):
    r = allr[rid]
    if r["prefix"] in CITY or r["prefix"] == "GEN" or not r["munis"]: continue
    A = set(r["munis"]); tr = toks(r.get("route_long_name", ""))
    for g in gen:
        B = set(g["munis"])
        if len(A & B) / len(A | B) >= 0.8 and len(tr & toks(g.get("route_long_name", ""))) >= 2:
            del allr[rid]; native_dups += 1; break

recs = []
for rid, r in allr.items():
    if not r["munis"]: continue
    fam = family(r); c, n = code_name(r)
    rt = RT[fam] or CITY_APP.get(r["prefix"], "") or "none known (timetable only)"
    if r["prefix"] == "GEN" and re.fullmatch(r"L\d{4}", c or r.get("route_short_name", "")): c = (c or r["route_short_name"]) + "*"
    recs.append(dict(route_id=rid, also=r.get("also", []), prefix=r["prefix"], code=c, name=n or r.get("route_long_name", ""), agency=r["agency"],
                     family=fam, covered=covered(r, fam), realtime=rt, trips=r["trips"], nstops=r["nstops"],
                     source="ATM completa 2026-02-16" if r.get("from_full") else "ATM CGIM 2026-11-23",
                     munis=r["munis"], how=r["how"]))

with open(f"{OUT}/lines_by_municipality.csv", "w", newline="", encoding="utf-8") as fh:
    w = csv.writer(fh)
    w.writerow(["province", "comarca", "municipality", "ine", "route_id", "code", "name", "operator", "family", "in_arribo", "realtime", "stops_in_town", "line_stops", "trips", "source"])
    for x in sorted(recs, key=lambda x: x["route_id"]):
        for c, k in x["munis"].most_common():
            m = munis[c]
            w.writerow([m["prov"], m["comarca"], m["name"], c, x["route_id"], x["code"], x["name"], x["agency"], x["family"],
                        "yes" if x["covered"] else "no", x["realtime"], k, x["nstops"], x["trips"], x["source"]])

json.dump(dict(recs=[{k: (dict(v) if isinstance(v, collections.Counter) else v) for k, v in x.items()} for x in recs],
               dups=dups, native_dups=native_dups, base=len(base), full_added=sum(1 for x in recs if x["source"].startswith("ATM completa"))),
          open(f"{OUT}/lines.json", "w"), ensure_ascii=False)
tot = len(recs); cov = sum(x["covered"] for x in recs)
how = collections.Counter(); [how.update(x["how"]) for x in recs]
print(f"bus lines {tot}, in Arribo {cov}, extra {tot-cov}; duplicates skipped {dups}; direction pairs merged {merged}; operator copies of GEN lines {native_dups}; stop->town method {dict(how)}")
print(collections.Counter(x["family"] for x in recs))
print("towns with >=1 line:", len({c for x in recs for c in x["munis"]}), "of", len(munis))

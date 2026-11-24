# Bus lines by town: how the report is built

These two scripts produce [docs/research/catalonia-2026/12-bus-lines-by-town/](../../../docs/research/catalonia-2026/12-bus-lines-by-town/README.md). They are research tools, not part of the server.

Inputs, in a work folder `W` (none of them is committed):

- `W/F_gtfs/x2832/`: the ATM unified GTFS, simplified feed, unzipped (Mobility Database `mdb-2832`, or the T-mobilitat open-data download).
- `W/gh_repos/tpcatvsosm/gtfs_cat_urba_bus/`: the ATM complete feed copy from the GitHub project `tpcatvsosm` (only used for operators the simplified feed leaves out).
- `W/lines/munis.json`: `https://analisi.transparenciacatalunya.cat/resource/wpyq-we8x.json?$limit=5000`
- `W/lines/munipoly.geojson`: `https://analisi.transparenciacatalunya.cat/resource/5ryy-c5zw.geojson?$limit=2000`

Run (Python 3, standard library only):

```bash
python3 scripts/research/bus_lines_by_town/build.py W W/lines
```

```bash
python3 scripts/research/bus_lines_by_town/gen.py W/lines docs/research/catalonia-2026/12-bus-lines-by-town
```

`build.py` writes `lines.json` and `lines_by_municipality.csv`. `gen.py` writes the report files. What counts as "in Arribo" is the `family()` / `covered()` logic in `build.py`. Update it when a new network is added to the server.

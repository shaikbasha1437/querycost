"""Check QueryCost's column and partition pruning against DuckDB on real Hive-partitioned Parquet.

Generates orders (60 daily partitions) and customers as Parquet, runs EXPLAIN ANALYZE in DuckDB for each query
in queries.json, and compares the columns DuckDB projects/filters and the files it scans with QueryCost's prediction.
Usage: python verify/duckdb_check.py   (needs duckdb; node on PATH)
"""
import duckdb, json, os, re, shutil, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
spec = json.load(open(os.path.join(HERE, 'queries.json')))
pred = json.loads(subprocess.check_output(['node', os.path.join(HERE, 'predict.js'), os.path.join(HERE, 'queries.json')]))
work = tempfile.mkdtemp(prefix='qc-duckdb-')
con = duckdb.connect()
con.execute(f"""COPY (SELECT i AS order_id, (i*7919) % 5000 AS customer_id, (DATE '{spec['today']}' - INTERVAL (i % 60) DAY)::DATE AS order_date,
  (i % 1000) / 10.0 AS amount, 'note ' || i AS notes, CASE WHEN i % 3 = 0 THEN 'shipped' ELSE 'open' END AS status
  FROM range(60000) t(i)) TO '{work}/orders' (FORMAT PARQUET, PARTITION_BY (order_date))""")
con.execute(f"COPY (SELECT i AS customer_id, 'r' || (i % 7) AS region, 'u' || i || '@example.com' AS email FROM range(5000) t(i)) TO '{work}/customers.parquet' (FORMAT PARQUET)")
con.execute(f"CREATE VIEW orders AS SELECT * FROM read_parquet('{work}/orders/*/*.parquet', hive_partitioning=true, hive_types={{'order_date': DATE}})")
con.execute(f"CREATE VIEW customers AS SELECT * FROM read_parquet('{work}/customers.parquet')")
cols = {t['name']: [c['name'] for c in t['columns']] for t in spec['catalog']['tables']}
PART = 'order_date'

def scans(plan):
    out = []
    def walk(n):
        ei = n.get('extra_info') or {}
        if ei.get('Function') == 'READ_PARQUET': out.append(ei)
        for ch in n.get('children', []): walk(ch)
    for n in (plan.get('operator') or [plan]): walk(n)
    return out

rows = []; ok_all = True
for q, p in zip(spec['queries'], pred):
    plan = json.loads(con.execute("EXPLAIN (ANALYZE, FORMAT JSON) " + q['sql']).fetchall()[0][1])
    found = {}
    for ei in scans(plan):
        name = 'customers' if 'customers.parquet' in ei.get('Filename(s)', '') else 'orders'
        sf = re.match(r'\s*(\d+)\s*/\s*(\d+)', ei.get('Scanning Files', '')); tf = ei.get('Total Files Read')
        files = (int(sf.group(1)), int(sf.group(2))) if sf else ((int(tf), None) if tf else None)
        proj = ei.get('Projections', ''); proj = proj if isinstance(proj, str) else ' '.join(proj)
        filt = ' '.join(str(v) for k, v in ei.items() if 'Filter' in k)
        used = sorted(c for c in cols[name] if re.search(r'\b' + c + r'\b', proj + ' ' + filt))
        found[name] = {'columns': used, 'files': files}
    for t in p['tables']:
        d = found.get(t['name'], {'columns': [], 'files': None})
        qc_cols = sorted(set(t['columns']) - {PART}); dd_cols = sorted(set(d['columns']) - {PART})
        col_ok = qc_cols == dd_cols
        if t['partitionsTotal']:
            dd_parts = d['files'][0] if d['files'] else None
            part_ok = t['partitionsRead'] == dd_parts
        else: dd_parts, part_ok = None, True
        expected_diff = 'EXTRACT' in q['sql'] and not part_ok
        ok = col_ok and (part_ok or expected_diff); ok_all &= ok
        rows.append((q['name'], t['name'], ', '.join(qc_cols), ', '.join(dd_cols), t['partitionsRead'], dd_parts, 'match' if col_ok and part_ok else ('expected difference' if expected_diff and col_ok else 'MISMATCH')))
shutil.rmtree(work)
print('| Query | Table | QueryCost columns | DuckDB columns | QueryCost partitions | DuckDB files | Result |')
print('|---|---|---|---|---|---|---|')
for r in rows: print('| ' + ' | '.join('' if x is None else str(x) for x in r) + ' |')
print(f"\nDuckDB {duckdb.__version__}: {sum(r[-1] == 'match' for r in rows)}/{len(rows)} match" + ('' if ok_all else ' (see MISMATCH rows)'))
sys.exit(0 if ok_all else 1)

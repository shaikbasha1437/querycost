# QueryCost

**Estimate what a SQL query will cost before you run it, on Snowflake, BigQuery, Databricks SQL, Redshift and Athena, and see how to make it cheaper.**

Live app: https://shaikbasha1437.github.io/querycost/

QueryCost runs entirely in your browser. There is no backend and no account, and your SQL, catalog and settings never leave the page (history stays in `localStorage`; share links keep everything in the URL `#hash`, which browsers do not send to servers).

> **Estimates only.** QueryCost does not connect to your warehouse. It reads your SQL and a catalog you describe (table sizes, columns, partitions), then applies published list prices and simple, documented models. Real bills depend on caching, concurrency, compression, warehouse auto-suspend, discounts and contracts, data skew and engine internals that a static tool cannot see. Use it to compare options and spot expensive patterns, and check important numbers with your warehouse's own tools (for example `bq query --dry_run`, `EXPLAIN`, query history and billing exports).

## What it does

- **Pick a warehouse**: Snowflake, BigQuery, Databricks SQL, Redshift or Athena, each with editable assumptions (edition, warehouse size, on-demand vs. capacity, nodes, and more).
- **Real SQL parsing** with a vendored [node-sql-parser](https://github.com/taozhi8833998/node-sql-parser) 5.4.0, using the closest grammar per engine (BigQuery, Snowflake, Hive for Databricks, Redshift, Athena, then PostgreSQL/Trino as fallbacks). If no grammar parses the query, a banner says so and a regex fallback estimates the tables and columns instead.
- **Catalog**: tables with rows, bytes, columns and types, partition column and granularity, and clustering keys. Import from CSV, from `INFORMATION_SCHEMA` query output (CSV/TSV) or from `CREATE TABLE` DDL; merge or replace; export to CSV. Three ready-made templates (e-commerce, product analytics, finance) with sample queries.
- **Cost per run, per day and per month**, from runs per day or a cron schedule (5-field cron, `@hourly`, `@daily` and so on, with standard day-of-month/day-of-week OR rules).
- **Per-table breakdown**: columns read, partitions read and why, clustering effect, bytes scanned and billed.
- **16 lint rules**, each with a severity, a plain explanation, estimated savings and an automatic rewrite where one is safe.
- **Optimize view**: the original and suggested query side by side with the cost difference; copy the rewrite.
- **Compare chart** across all five warehouses for the same query and schedule.
- **History**, **share links**, and **export** to Markdown, HTML and JSON.
- CodeMirror editor with SQL highlighting, light and dark themes, responsive layout, keyboard support, and an offline-capable PWA.

Every dialog closes with its X, Cancel, Esc, a click on the backdrop, or the browser Back button. If you have unsaved edits you are asked before they are thrown away, required fields never block Cancel, and deletes show an Undo toast.

## How the cost models work

All prices are list prices **as of 2026-10-30**, shown in Settings with a link to the source. You can change any of them.

### Shared scan model

1. **Columns**: only the columns the query references (in SELECT, WHERE, JOIN, GROUP BY, and so on) are read. `SELECT *` reads all of them. Column sizes come from the catalog, or from type widths (INT64/FLOAT64/DATE/TIMESTAMP 8 bytes, NUMERIC 16, BIGNUMERIC 32, BOOL 1, STRING/BYTES 2 + an assumed 24-byte average).
2. **Partitions**: literal filters on the partition column (`=`, `IN`, ranges, `BETWEEN`, `CURRENT_DATE - INTERVAL ...`) are turned into the number of partitions read. Filters inside CTEs and subqueries are pushed to the table they filter. An `OR` with any other column disables pruning. A function around the partition column (`EXTRACT(MONTH ...)`, `FORMAT_DATE`, `YEAR()` ...) disables pruning except for `DATE()`, `CAST(... AS DATE)` and truncation to the partition granularity, plus the extra BigQuery cases below. A filter whose value is not a constant (a subquery, for example) keeps an assumed 25% (editable), because Snowflake, Databricks, Redshift and Athena can prune at run time.
3. **Clustering**: an equality filter on the first clustering key keeps about 10% of blocks, a range keeps 35%, and a filter on a later key keeps 80% (all editable).
4. **Compute time** for the time-billed engines = bytes / throughput, plus extra factors for joins, aggregation, sorting, DISTINCT, window functions, exact COUNT(DISTINCT), many-to-many joins, cross joins and correlated subqueries.

### Per engine

- **BigQuery on-demand**: $6.25 per TiB of bytes billed. Each referenced table is rounded up to the MiB with a 10 MB minimum, and the query has a 10 MB minimum. A table is billed once even if a CTE reads it several times. `LIMIT` does not reduce bytes. An optional 1 TiB/month free tier. **Editions** (Standard $0.04, Enterprise $0.06, Enterprise Plus $0.10 per slot-hour) estimate slot-seconds from bytes. BigQuery also prunes through `EXTRACT(YEAR|DATE FROM col)` and `DATE_TRUNC`/`TIMESTAMP_TRUNC`/`DATETIME_TRUNC` to the partition unit or coarser, and it does **not** prune on subquery or other non-constant filters. QueryCost follows both rules.
- **Snowflake**: credits per hour by warehouse size (XS = 1, doubling up to 6XL = 512) × $/credit by edition (Standard $2, Enterprise $3, Business Critical $4, VPS $6), billed per second with a 60-second minimum when a suspended warehouse resumes. Gen2 warehouses are optional (1.35× credits, faster). Optional idle time before auto-suspend.
- **Databricks SQL**: DBU per hour by warehouse size (2X-Small = 4 ... 4X-Large = 528) × $/DBU (Serverless $0.70, Pro $0.55, Classic $0.22). Pro and Classic also add a cloud VM cost (default $0.312 per DBU-hour, editable).
- **Redshift**: **Serverless** bills RPU-hours ($0.375 per RPU-hour, default base 32 RPU), per second with a 60-second minimum. **Provisioned** RA3 bills node-hours × nodes (ra3.large $0.543 ... ra3.16xlarge $13.04); a single query is charged its share of runtime.
- **Athena**: $5 per TB scanned, each query rounded up to the MB with a 10 MB minimum.

Because of the minimums, a small query on Snowflake, Redshift Serverless or BigQuery can cost the same after a rewrite. The Optimize view says so when it happens.

### Pricing sources (checked 2026-10-30)

| Engine | Source |
|---|---|
| BigQuery | https://cloud.google.com/bigquery/pricing and https://cloud.google.com/bigquery/docs/best-practices-costs |
| Snowflake | https://www.snowflake.com/legal-files/CreditConsumptionTable.pdf, https://www.snowflake.com/en/pricing-options/, https://docs.snowflake.com/en/user-guide/warehouses-overview |
| Databricks SQL | https://www.databricks.com/product/pricing/databricks-sql and https://learn.microsoft.com/en-us/azure/databricks/resources/pricing |
| Redshift | https://aws.amazon.com/redshift/pricing/ and https://docs.aws.amazon.com/redshift/latest/mgmt/serverless-billing.html |
| Athena | https://aws.amazon.com/athena/pricing/ |

Prices vary by region and cloud and change over time. US list prices are used by default.

## Lint rules

| Rule | What it catches | Rewrite |
|---|---|---|
| `select-star` | `SELECT *` reads every column | Lists the table's columns and drops the three widest (review before running) |
| `missing-partition-filter` | No filter on a partitioned table's partition column | Adds a suggested recent-date filter (review it) |
| `non-sargable-partition` | A function on the partition column blocks pruning | `EXTRACT(YEAR ...)`, `YEAR()`, `FORMAT_DATE('%Y-%m', ...)`, `TO_CHAR`, `DATE_FORMAT` → a date range |
| `cross-join` | Cross join or a join with no condition | – |
| `row-explosion` | Many-to-many join on non-unique keys | – |
| `order-without-limit` | A subquery or CTE sorts rows but has no LIMIT, so the sort is wasted | Removes the inner ORDER BY |
| `distinct-large` | DISTINCT over a large result | – |
| `union-distinct` | `UNION` deduplicates when `UNION ALL` might do | `UNION` → `UNION ALL` (only if duplicates are fine) |
| `correlated-subquery` | Subquery re-run per outer row | – |
| `not-in-nullable` | `NOT IN` against a nullable column returns no rows if any NULL appears | Adds `IS NOT NULL` inside the subquery |
| `like-leading-wildcard` | `LIKE '%...'` cannot prune or use search indexes | – |
| `repeated-cte` | A CTE referenced several times may be computed several times | – |
| `count-distinct` | Exact `COUNT(DISTINCT)` on many rows | `APPROX_COUNT_DISTINCT` / `APPROX_DISTINCT` per engine |
| `large-in-list` | Very long `IN (...)` lists | – |
| `implicit-cast-join` | Join keys of different types | – |
| `bq-limit-no-savings` | On BigQuery on-demand, `LIMIT` does not lower bytes billed | `TABLESAMPLE SYSTEM (10 PERCENT)` on the largest table (changes results) |

Savings are estimated by re-running the full estimate on the rewritten query.

## Accuracy checks

See [docs/VERIFICATION.md](docs/VERIFICATION.md):

- **DuckDB**: the column and partition pruning model matches DuckDB's actual Parquet reads on 14 of 14 checks over generated Hive-partitioned data.
- **BigQuery**: the pruning rules were compared with Google's documented `bq query --dry_run` behaviour.
- **Browsers**: end-to-end Playwright tests in Chromium and Firefox.

## Running locally

It is a static site, so any web server works:

```bash
python3 -m http.server 8000   # then open http://localhost:8000/
```

Tests (Node 18+, no dependencies):

```bash
npm test
```

DuckDB check (needs `pip install duckdb pyarrow`):

```bash
python3 verify/duckdb_check.py
```

### Vendored libraries

- `js/vendor/sqlparser/`: node-sql-parser 5.4.0 per-dialect UMD builds (Apache-2.0), copied from the npm package's `umd/` folder.
- `js/vendor/codemirror.js`: CodeMirror 6 with `@codemirror/lang-sql` (MIT), bundled from `scripts/codemirror-entry.js`:

```bash
npm i codemirror @codemirror/lang-sql @codemirror/view @codemirror/state @codemirror/commands @codemirror/language @codemirror/autocomplete @lezer/highlight esbuild
npx esbuild scripts/codemirror-entry.js --bundle --minify --format=iife --global-name=QCEditor --outfile=js/vendor/codemirror.js
```

## Limits

- QueryCost does not see your data. Row counts, sizes, null rates and key uniqueness come from the catalog you enter.
- Runtime for time-billed engines is a rough throughput model. It does not cover caching (result cache, warehouse cache), concurrency, queueing, spilling or skew.
- Snowflake micro-partition pruning is modeled only through the declared partition and clustering columns.
- BigQuery: no BI Engine, no materialized-view rewrites, no storage costs, and no pruning from script variables or `_PARTITIONTIME` pseudo-columns.
- Redshift: no concurrency-scaling or Spectrum charges. Athena: Iceberg/Hive metadata and compression are not modeled beyond column sizes.
- Lint rewrites are suggestions. Review them before running, especially `UNION ALL` and added partition filters.
- Prices are list prices for one region and date. Your contract may differ.

## License

[MIT](LICENSE) © 2026 shaikbasha1437

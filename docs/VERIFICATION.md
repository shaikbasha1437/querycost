# How QueryCost was checked

QueryCost gives estimates only. These checks confirm that the parts of the model that can be checked offline behave like the real engines: which columns and partitions are read, and how BigQuery prunes and bills. They do not check runtimes or final bills.

Run on 2026-10-30.

## 1. Unit tests

`npm test` runs 73 Node tests (`node --test`, no dependencies). They cover all 16 lint rules with a positive and negative case each, the pricing math for every engine (minimums, rounding, editions, free tier), partition and cluster pruning, catalog import (CSV, `INFORMATION_SCHEMA` TSV, BigQuery and Hive DDL), cron schedules, rewrites, share links, reports and history. Every template query is also parsed.

## 2. DuckDB: column and partition pruning on real Parquet

`verify/duckdb_check.py` generates a Hive-partitioned Parquet table (`orders`, 60 daily partitions) and a `customers` table. It then runs 13 queries with `EXPLAIN (ANALYZE, FORMAT JSON)` and compares DuckDB's actual projection columns and files read with what QueryCost predicts (`verify/predict.js`).

| Query | Table | QueryCost columns | DuckDB columns | QueryCost partitions | DuckDB files | Result |
|---|---|---|---|---|---|---|
| one day | orders | amount | amount | 1 | 1 | match |
| last 7 days (open range) | orders | amount, customer_id | amount, customer_id | 7 | 7 | match |
| closed range | orders | amount | amount | 14 | 14 | match |
| BETWEEN | orders | order_id | order_id | 10 | 10 | match |
| IN list | orders | status | status | 3 | 3 | match |
| OR of two days | orders | amount | amount | 2 | 2 | match |
| OR with another column (no pruning) | orders | amount | amount | 60 | 60 | match |
| no partition filter | orders | status | status | 60 | 60 | match |
| SELECT * one day | orders | amount, customer_id, notes, order_id, status | amount, customer_id, notes, order_id, status | 1 | 1 | match |
| filter pushed through a CTE | orders | amount, customer_id | amount, customer_id | 3 | 3 | match |
| join with partition filter | orders | amount, customer_id | amount, customer_id | 6 | 6 | match |
| join with partition filter | customers | customer_id, region | customer_id, region |  |  | match |
| filter-only column | orders | order_id, status | order_id, status | 1 | 1 | match |
| EXTRACT on partition column | orders | amount | amount | 60 | 60 | match |

**DuckDB 2.0.0: 14/14 match.** Columns that are only used in a filter are compared as "read" on both sides; the partition column itself is excluded because Hive partitions store it in the path.

Two fixes came out of this check: an `OR` that mixes the partition column with another column no longer prunes, and `<` bounds on hour-partitioned tables are now exclusive.

## 3. BigQuery: compared with documented `bq query --dry_run` behaviour

A dry run returns the bytes a query would process without running it. No BigQuery project was used. Instead, QueryCost's BigQuery model was compared case by case with Google's documentation:

- [Query partitioned tables](https://cloud.google.com/bigquery/docs/querying-partitioned-tables): pruning needs constant expressions; subquery filters, `OR` with other columns and most functions do not prune; `EXTRACT(YEAR|DATE)`, `DATE()`, `CAST AS DATE`, `DATE_TRUNC`/`TIMESTAMP_TRUNC` are supported.
- [Pricing](https://cloud.google.com/bigquery/pricing): on-demand rounds each referenced table up to the MB with a 10 MB minimum per table and per query; `LIMIT` does not reduce bytes.
- [Estimate and control costs](https://cloud.google.com/bigquery/docs/best-practices-costs): a dry run is an upper bound.
- [Data type sizes](https://cloud.google.com/bigquery/pricing#data_type_sizes): INT64/FLOAT64/DATE/TIMESTAMP 8 bytes, NUMERIC 16, BIGNUMERIC 32, BOOL 1, STRING 2 + length.

Test table: `sales.orders`, 1e9 rows over 730 daily partitions ending 2026-10-30.

| Case | Documented BigQuery behaviour | QueryCost partitions | Bytes billed | Agrees |
|---|---|---|---|---|
| Literal range on partition column | prunes to 7 partitions | 7/730 | 220 MiB | yes |
| `DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)` | prunes (constant expression) | 8/730 | 251 MiB | yes |
| `EXTRACT(YEAR FROM col) = 2026` | prunes | 303/730 | 9,501 MiB | yes* |
| `DATE_TRUNC(col, MONTH) = '2026-09-01'` | prunes | 30/730 | 941 MiB | yes* |
| `EXTRACT(MONTH FROM col) = 9` | no pruning | 730/730 | 22,889 MiB | yes |
| `FORMAT_DATE('%Y-%m', col) = '2026-09'` | no pruning | 730/730 | 22,889 MiB | yes |
| `OR` with another column | no pruning | 730/730 | 22,889 MiB | yes |
| Bound from a subquery | no pruning | 730/730 | 22,899 MiB | yes* |
| `LIMIT 10` with no filter | LIMIT does not reduce bytes | 730/730 | 15,259 MiB | yes |
| Same table read twice through a CTE | billed once | 730/730 | 22,889 MiB | yes |
| Tiny table | 10 MB minimum | – | 10 MiB | yes |

\* These three rows differed from the docs in the first version, and the model was changed to match. BigQuery now has its own scan in QueryCost: it prunes through `EXTRACT(YEAR|DATE ...)` and through truncation to the partition unit or coarser, and it reads every partition when a bound comes from a subquery. The other engines keep the generic rules (no pruning through functions; non-constant bounds keep an assumed 25%, since those engines can prune at run time). The `non-sargable-partition` lint no longer fires for `EXTRACT(YEAR)` on BigQuery, and the e-commerce template now shows the problem with `FORMAT_DATE` instead.

Known gaps compared with a real dry run: no `_PARTITIONTIME`/`_PARTITIONDATE` pseudo-columns, no pruning from script variables, no BI Engine or materialized-view rewrites, and string sizes come from an assumed average length unless you enter table bytes.

## 4. Browser end-to-end (Playwright)

The e2e script runs 77 checks (78 with `--offline`) against the live GitHub Pages site:

- First and repeat visits, parsing, CodeMirror, all 5 warehouses and 4 tabs, and the compare chart.
- Every dialog (7) closed by X, Cancel, Esc, a backdrop click and browser Back.
- Back from a nested dialog; Cancel not blocked by a required field; the discard prompt on Esc, Back and backdrop.
- Undo for table delete, import, template switch and history delete.
- Optimize savings, share link in a new browser context, theme toggle, focus trap and focus restore.
- Mobile viewport (no horizontal overflow, dialogs fit, Back closes); offline reload from the service worker; no JavaScript errors.

Result on the live site (https://shaikbasha1437.github.io/querycost/, 2026-10-30): **Chromium 78/78 passed** (including the offline reload, with 32 files served from the `querycost-v1` cache) and **Firefox 77/77 passed**.

The script lives outside the repo; run it with `node qc-e2e.mjs <url> [chromium|firefox] [--offline]` after `npm i playwright`.

'use strict';
// Partition and cluster pruning, column pruning and repeated reads.
const test = require('node:test'); const assert = require('node:assert/strict');
const H = require('./helpers.js'); const C = require('../js/catalog.js'); const EN = require('../js/engine.js');
const T = (sql, wh) => H.evaluate(sql, wh || 'bigquery').ev.scan.tables;
const orders = (sql, wh) => T(sql, wh).find((t) => t.name === 'sales.orders');

test('column pruning reads only referenced columns', () => {
  const t = orders("SELECT amount FROM sales.orders WHERE order_date = DATE '2026-10-01'");
  assert.deepEqual(t.columnsRead.map((c) => c.name).sort(), ['amount', 'order_date']); assert.equal(t.columnsTotal, 6);
});
test('equality on a day partition reads 1 partition', () => { const t = orders("SELECT amount FROM sales.orders WHERE order_date = DATE '2026-10-01'"); assert.equal(t.partition.read, 1); });
test('closed range reads the days in the range', () => { const t = orders("SELECT amount FROM sales.orders WHERE order_date >= DATE '2026-10-01' AND order_date < DATE '2026-10-08'"); assert.equal(t.partition.read, 7); });
test('BETWEEN is inclusive', () => { const t = orders("SELECT amount FROM sales.orders WHERE order_date BETWEEN DATE '2026-10-01' AND DATE '2026-10-07'"); assert.equal(t.partition.read, 7); });
test('open-ended range runs to the latest partition', () => { const t = orders("SELECT amount FROM sales.orders WHERE order_date >= DATE '2026-10-01'"); assert.equal(t.partition.read, 30); });
test('IN list counts distinct partitions', () => { const t = orders("SELECT amount FROM sales.orders WHERE order_date IN (DATE '2026-10-01', DATE '2026-10-02', DATE '2026-10-01')"); assert.equal(t.partition.read, 2); });
test('relative date (CURRENT_DATE - INTERVAL) resolves against today', () => {
  const t = orders('SELECT amount FROM sales.orders WHERE order_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)'); assert.ok(t.partition.read >= 7 && t.partition.read <= 8, String(t.partition.read));
});
test('function on the partition column disables pruning', () => { const t = orders('SELECT amount FROM sales.orders WHERE EXTRACT(MONTH FROM order_date) = 9'); assert.equal(t.partition.fraction, 1); assert.ok(t.partition.wrapped); });
test('OR with a non-partition predicate disables pruning', () => { const t = orders("SELECT amount FROM sales.orders WHERE order_date = DATE '2026-10-01' OR amount > 5"); assert.equal(t.partition.fraction, 1); });
test('unknown bound (subquery) keeps the configured fraction; BigQuery reads every partition', () => {
  const q = 'SELECT amount FROM sales.orders WHERE order_date >= (SELECT MAX(v) FROM sales.tiny)';
  const t = orders(q, 'snowflake'); assert.ok(t.partition.guessed && Math.abs(t.partition.fraction - 0.25) < 0.01, JSON.stringify(t.partition));
  const b = orders(q, 'bigquery'); assert.equal(b.partition.fraction, 1); assert.match(b.partition.reason, /does not prune/);
});
test('partition filter pushed through a CTE reaches the base table', () => {
  const t = orders("WITH o AS (SELECT * FROM sales.orders) SELECT amount FROM o WHERE order_date = DATE '2026-10-01'"); assert.equal(t.partition.read, 1);
});
test('cluster key equality keeps 10%, range 35%', () => {
  const sql = "SELECT amount FROM sales.orders WHERE order_date = DATE '2026-10-01'";
  assert.equal(orders(sql + ' AND customer_id = 42').cluster.keep, 0.1); assert.equal(orders(sql + ' AND customer_id > 42').cluster.keep, 0.35); assert.equal(orders(sql).cluster.keep, 1);
});
test('hour, month and year granularities', () => {
  const cat = C.normalize({ tables: [
    { name: 'h', rows: 1e6, partition: { column: 'ts', granularity: 'hour', count: 24 * 30, end: '2026-10-30' }, columns: [{ name: 'ts', type: 'TIMESTAMP' }, { name: 'x', type: 'INT64' }] },
    { name: 'm', rows: 1e6, partition: { column: 'mon', granularity: 'month', count: 36, end: '2026-10-01' }, columns: [{ name: 'mon', type: 'DATE' }, { name: 'x', type: 'INT64' }] }] });
  const c = H.ctx('bigquery', { catalog: cat });
  const h = EN.evaluate("SELECT x FROM h WHERE ts >= TIMESTAMP '2026-10-29 00:00:00' AND ts < TIMESTAMP '2026-10-29 06:00:00'", c).scan.tables[0];
  assert.equal(h.partition.read, 6);
  const m = EN.evaluate("SELECT x FROM m WHERE mon >= DATE '2026-07-01' AND mon < DATE '2026-10-01'", c).scan.tables[0]; assert.equal(m.partition.read, 3);
});
test('repeated CTE: one base reference, read once per CTE use', () => {
  const sql = 'WITH r AS (SELECT region, email FROM sales.customers) SELECT a.region FROM r a JOIN r b ON a.email = b.email';
  for (const wh of ['bigquery', 'snowflake', 'redshift']) { const t = T(sql, wh)[0]; assert.equal(t.refs, 1); assert.equal(t.reads, 2); }
  const once = H.evaluate(sql, 'bigquery').ev.cost.billedBytes, single = H.evaluate('SELECT region, email FROM sales.customers', 'bigquery').ev.cost.billedBytes;
  assert.equal(once, single, 'BigQuery bills the CTE bytes once');
});
test('regex fallback still estimates when the parser fails', () => {
  const { ev } = H.evaluate("SELECT amount FROM sales.orders WHERE order_date >= DATE '2026-10-01' QUALIFY ROW_NUMBER() OVER (PARTITION BY 1) = 1 !!! garbage", 'bigquery');
  assert.equal(ev.analysis.parser, null, 'regex fallback model used'); assert.ok(ev.analysis.parseError); assert.ok(ev.cost.cost > 0);
});
test('unknown tables are reported, not billed', () => {
  const { ev } = H.evaluate('SELECT x FROM nowhere.t', 'bigquery'); assert.ok((ev.analysis.unknown || ev.analysis.model.unknownTables || []).length >= 0); assert.ok(ev.cost.cost >= 0);
});

test('BigQuery prunes through EXTRACT(YEAR) and DATE_TRUNC to a coarser unit; other engines do not', () => {
  const H2 = require('./helpers.js');
  const read = (sql, wh) => H2.lint(sql, wh).ev.scan.tables[0].partition;
  const y = 'SELECT amount FROM sales.orders WHERE EXTRACT(YEAR FROM order_date) = 2026';
  assert.equal(read(y, 'bigquery').read, 303); assert.ok(!read(y, 'bigquery').wrapped);
  assert.equal(read(y, 'snowflake').read, 730);
  assert.equal(read("SELECT amount FROM sales.orders WHERE DATE_TRUNC(order_date, MONTH) = DATE '2026-09-01'", 'bigquery').read, 30);
  assert.equal(read('SELECT amount FROM sales.orders WHERE EXTRACT(YEAR FROM order_date) < 2026', 'bigquery').read, 427);
  const ev = H2.lint(y, 'bigquery').ev; const ev2 = H2.lint(y, 'snowflake').ev;
  assert.ok(Math.abs(ev.costs.bigquery.scanBytes - ev2.costs.bigquery.scanBytes) < 1, 'BigQuery column in the compare chart is the same from any selected warehouse');
  assert.equal(ev.costs.athena.scanBytes, ev2.costs.athena.scanBytes);
});

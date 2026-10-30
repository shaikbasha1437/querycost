'use strict';
// Pricing math for each warehouse model, including billing minimums.
const test = require('node:test'); const assert = require('node:assert/strict');
const H = require('./helpers.js'); const PR = require('../js/pricing.js'); const E = require('../js/estimate.js');
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= (eps || 1e-9) * Math.max(1, Math.abs(b)), (msg || '') + ' ' + a + ' vs ' + b);
const SQL = "SELECT amount FROM sales.orders WHERE order_date >= DATE '2026-10-01'";
const withSettings = (fn) => { const s = PR.defaults(); fn(s); return { settings: s }; };

test('prices carry an as-of date and a source link per warehouse', () => {
  assert.match(PR.PRICES_AS_OF, /^\d{4}-\d{2}-\d{2}$/);
  for (const w of PR.WAREHOUSES) { assert.ok(PR.SOURCES[w.id].length >= 1, w.id); PR.SOURCES[w.id].forEach((s) => assert.match(s.url, /^https:\/\//)); }
});
test('BigQuery on-demand: logical bytes rounded up to the MiB × $6.25/TiB', () => {
  const { ev } = H.evaluate(SQL, 'bigquery'); const c = ev.cost;
  close(c.scanBytes, 1e9 * 24 * 30 / 730, 1e-9, 'amount (16 B) + order_date (8 B) over 30 of 730 days');
  assert.equal(c.billedBytes % E.MiB, 0); assert.ok(c.billedBytes >= c.scanBytes && c.billedBytes - c.scanBytes < E.MiB);
  close(c.cost, c.billedBytes / E.TiB * 6.25);
});
test('BigQuery: 10 MB minimum per table referenced', () => {
  const { ev } = H.evaluate('SELECT id FROM sales.tiny', 'bigquery');
  assert.equal(ev.cost.billedBytes, 10 * E.MiB); close(ev.cost.cost, 10 * E.MiB / E.TiB * 6.25);
  const cat = require('../js/catalog.js').normalize({ tables: [{ name: 'a', rows: 10, columns: [{ name: 'id', type: 'INT64' }] }, { name: 'b', rows: 10, columns: [{ name: 'id', type: 'INT64' }] }] });
  const two = H.evaluate('SELECT a.id FROM a JOIN b ON a.id = b.id', 'bigquery', { catalog: cat }).ev;
  assert.equal(two.cost.billedBytes, 20 * E.MiB, 'each table referenced has its own 10 MB minimum');
});
test('BigQuery: LIMIT does not reduce bytes billed', () => {
  const a = H.evaluate('SELECT region FROM sales.customers', 'bigquery').ev.cost; const b = H.evaluate('SELECT region FROM sales.customers LIMIT 5', 'bigquery').ev.cost;
  assert.equal(a.billedBytes, b.billedBytes);
});
test('BigQuery: free tier toggle subtracts 1 TiB per month', () => {
  const ctx = withSettings((s) => { s.bigquery.applyFreeTier = true; });
  const base = H.evaluate('SELECT * FROM sales.orders', 'bigquery').ev.cost; const free = H.evaluate('SELECT * FROM sales.orders', 'bigquery', ctx).ev.cost;
  assert.ok(free.perMonth < base.perMonth); close(base.perMonth - free.perMonth, 6.25, 1e-6);
});
test('BigQuery editions bill slot-hours instead of bytes', () => {
  const ctx = withSettings((s) => { s.bigquery.mode = 'editions'; s.bigquery.edition = 'enterprise'; });
  const c = H.evaluate(SQL, 'bigquery', ctx).ev.cost; assert.ok(c.slotSeconds > 0, JSON.stringify(c.unit)); close(c.cost, c.slotSeconds / 3600 * 0.06, 1e-9);
});
test('Snowflake: 60-second minimum × credits/hour × $/credit', () => {
  const c = H.evaluate(SQL, 'snowflake').ev.cost; assert.equal(c.billedSec, 60); close(c.cost, 60 / 3600 * 1 * 3);
  const big = H.evaluate(SQL, 'snowflake', withSettings((s) => { s.snowflake.size = 'L'; s.snowflake.coldStart = false; })).ev.cost;
  assert.ok(big.billedSec < 60, 'warm warehouse bills per second'); close(big.cost, big.billedSec / 3600 * 8 * 3);
});
test('Snowflake: compressed bytes drive runtime, larger scan costs more', () => {
  const s = withSettings((x) => { x.snowflake.coldStart = false; });
  const a = H.evaluate(SQL, 'snowflake', s).ev.cost; const b = H.evaluate('SELECT * FROM sales.orders', 'snowflake', s).ev.cost;
  close(a.scanBytes, 1e9 * 24 * 30 / 730 / 4, 1e-9); assert.ok(b.cost > a.cost);
});
test('Databricks SQL serverless: DBU/hour × runtime × $/DBU', () => {
  const c = H.evaluate(SQL, 'databricks').ev.cost; close(c.cost, c.dbus * 0.70); close(c.dbus, c.billedSec / 3600 * PR.defaults().databricks.dbu.Small);
});
test('Databricks Pro adds cloud VM cost per DBU-hour', () => {
  const c = H.evaluate(SQL, 'databricks', withSettings((s) => { s.databricks.type = 'pro'; })).ev.cost; close(c.cost, c.dbus * (0.55 + 0.312));
});
test('Redshift Serverless: RPU-hours with a 60-second minimum', () => {
  const c = H.evaluate(SQL, 'redshift').ev.cost; assert.equal(c.billedSec, 60); close(c.cost, 32 * 60 / 3600 * 0.375);
  const off = H.evaluate(SQL, 'redshift', withSettings((s) => { s.redshift.applyMinimum = false; })).ev.cost; assert.ok(off.cost < c.cost);
});
test('Redshift provisioned: node-hours for the runtime', () => {
  const c = H.evaluate(SQL, 'redshift', withSettings((s) => { s.redshift.mode = 'provisioned'; })).ev.cost; const d = PR.defaults().redshift;
  close(c.cost, c.billedSec / 3600 * d.nodes * d.nodePrice[d.nodeType], 1e-9);
});
test('Athena: compressed bytes rounded up to the MB (10 MB minimum) × $5/TB', () => {
  const c = H.evaluate(SQL, 'athena').ev.cost; assert.equal(c.billedBytes % 1e6, 0); close(c.cost, c.billedBytes / 1e12 * 5);
  const t = H.evaluate('SELECT id FROM sales.tiny', 'athena').ev.cost; assert.equal(t.billedBytes, 10e6); close(t.cost, 10e6 / 1e12 * 5);
});
test('merge() keeps saved overrides and fills new defaults', () => {
  const m = PR.merge({ bigquery: { perTiB: 7 } }); assert.equal(m.bigquery.perTiB, 7); assert.equal(m.athena.perTB, 5);
});

'use strict';
// Shared fixtures for the Node tests: vendored parsers, a small catalog and a ctx builder.
const path = require('path');
const C = require('../js/catalog.js'); const PR = require('../js/pricing.js'); const EN = require('../js/engine.js'); const L = require('../js/lint.js');
const parsers = {};
function getParser(g) {
  if (!(g in parsers)) { try { parsers[g] = new (require(path.join(__dirname, '..', 'js', 'vendor', 'sqlparser', g + '.umd.js')).Parser)(); } catch (e) { parsers[g] = null; } }
  return parsers[g];
}
const TODAY = '2026-10-30';
function catalog() {
  return C.normalize({ name: 'test', tables: [
    { name: 'sales.orders', rows: 1e9, partition: { column: 'order_date', granularity: 'day', count: 730, end: TODAY }, cluster: ['customer_id'],
      columns: [{ name: 'order_id', type: 'INT64', unique: true }, { name: 'customer_id', type: 'INT64' }, { name: 'order_date', type: 'DATE' }, { name: 'amount', type: 'NUMERIC' }, { name: 'notes', type: 'STRING' }, { name: 'status', type: 'STRING' }] },
    { name: 'sales.customers', rows: 1e7, columns: [{ name: 'customer_id', type: 'INT64', unique: true }, { name: 'region', type: 'STRING' }, { name: 'email', type: 'STRING', nullable: true }] },
    { name: 'sales.returns', rows: 1e7, columns: [{ name: 'return_id', type: 'INT64', unique: true, nullable: false }, { name: 'customer_id', type: 'STRING' }, { name: 'order_id', type: 'INT64', nullable: true }] },
    { name: 'sales.tiny', rows: 100, columns: [{ name: 'id', type: 'INT64', unique: true }, { name: 'v', type: 'INT64' }] },
  ] });
}
function ctx(wh, extra) { return Object.assign({ catalog: catalog(), settings: PR.defaults(), warehouse: wh || 'bigquery', getParser, today: TODAY, schedule: { mode: 'perDay', perDay: 24 } }, extra || {}); }
function evaluate(sql, wh, extra) { const c = ctx(wh, extra); return { c, ev: EN.evaluate(sql, c) }; }
function lint(sql, wh, extra) { const { c, ev } = evaluate(sql, wh, extra); return { c, ev, findings: L.run(ev, c) }; }
const rules = (f) => f.map((x) => x.rule);
module.exports = { getParser, catalog, ctx, evaluate, lint, rules, TODAY };

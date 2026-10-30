'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const R = require('../js/rewrite.js'); const SH = require('../js/share.js'); const RP = require('../js/report.js'); const ST = require('../js/store.js'); const T = require('../js/templates.js');
const H = require('./helpers.js'); const L = require('../js/lint.js'); const EN = require('../js/engine.js'); const C = require('../js/catalog.js'); const PR = require('../js/pricing.js');

test('sargable: EXTRACT(YEAR) becomes a date range', () => { assert.equal(R.sargable('SELECT a FROM t WHERE EXTRACT(YEAR FROM d) = 2025', 'd', 'date', 'bigquery'), "SELECT a FROM t WHERE d >= DATE '2025-01-01' AND d < DATE '2026-01-01'"); });
test('sargable: DATE_TRUNC month on a timestamp', () => { assert.match(R.sargable("SELECT a FROM t WHERE DATE_TRUNC('month', ts) = DATE '2026-03-01'", 'ts', 'timestamp', 'snowflake'), /ts >= TIMESTAMP '2026-03-01[^']*' AND ts < TIMESTAMP '2026-04-01/); });
test('union ALL, approx count distinct per warehouse, NOT IN guard', () => {
  assert.equal(R.unionAll('SELECT a FROM x UNION SELECT a FROM y'), 'SELECT a FROM x UNION ALL SELECT a FROM y');
  assert.match(R.approxCountDistinct('SELECT COUNT(DISTINCT u) FROM t', 'bigquery'), /APPROX_COUNT_DISTINCT\(u\)/i);
  assert.match(R.approxCountDistinct('SELECT COUNT(DISTINCT u) FROM t', 'athena'), /approx_distinct\(u\)/i);
  assert.match(R.approxCountDistinct('SELECT COUNT(DISTINCT u) FROM t', 'redshift'), /APPROXIMATE COUNT\(DISTINCT u\)/i);
  assert.match(R.notInNotNull('SELECT a FROM x WHERE a NOT IN (SELECT b FROM y)'), /SELECT b FROM y\s+WHERE b IS NOT NULL/);
});
test('inner ORDER BY is removed, outer kept', () => {
  assert.equal(R.dropInnerOrderBy('SELECT * FROM (SELECT a FROM t ORDER BY a) s ORDER BY a'), 'SELECT * FROM (SELECT a FROM t) s ORDER BY a');
});
test('share link round-trips compressed', async () => {
  const data = { v: 1, sql: 'SELECT 1', warehouse: 'athena', schedule: { mode: 'cron', cron: '@daily' }, catalog: H.catalog() };
  const code = await SH.encode(data); assert.match(code, /^[zj][A-Za-z0-9_-]+$/); assert.deepEqual(await SH.decode(code), JSON.parse(JSON.stringify(data)));
});
test('reports: Markdown, HTML and JSON include the disclaimer, costs and findings', () => {
  const { c, ev, findings } = H.lint('SELECT * FROM sales.orders', 'bigquery'); const d = { title: 'Q <1>', ev, findings, ctx: c, optimized: L.optimize(ev, findings, c), now: new Date('2026-10-30T12:00:00Z') };
  const md = RP.toMarkdown(d); assert.match(md, /Estimates only/i); assert.match(md, /missing-partition-filter|partition/i);
  const html = RP.toHTML(d); assert.match(html, /<!doctype html>/i); assert.match(html, /Q &lt;1&gt;/); assert.doesNotMatch(html, /<script/i);
  const j = JSON.parse(RP.toJSON(d)); assert.equal(j.warehouse, 'bigquery'); assert.ok(j.findings.length >= 2);
});
test('history store: add, remove with undo position, clear and restore', () => {
  const s = ST.create(); const a = s.history.add({ name: 'a', sql: '1' }); s.history.add({ name: 'b', sql: '2' }); s.history.add({ name: 'c', sql: '3' });
  const r = s.history.remove(a.id); assert.equal(r.index, 2); s.history.restore(r.item, r.index); assert.deepEqual(s.history.list().map((e) => e.name), ['c', 'b', 'a']);
  const all = s.history.clear(); assert.equal(s.history.list().length, 0); s.history.restoreAll(all); assert.equal(s.history.list().length, 3);
});
test('every template query parses with its grammar and estimates', () => {
  for (const t of T.TEMPLATES) {
    const cat = C.normalize(t.catalog);
    for (const q of t.queries) {
      const ev = EN.evaluate(q.sql, { catalog: cat, settings: PR.defaults(), warehouse: t.warehouse, getParser: H.getParser, today: H.TODAY, schedule: { mode: 'perDay', perDay: 1 } });
      assert.notEqual(ev.analysis.parser, 'fallback', t.id + ': ' + q.name + ' ' + ev.analysis.parseError); assert.ok(ev.cost.cost > 0, q.name);
    }
  }
});

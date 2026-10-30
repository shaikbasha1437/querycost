'use strict';
// Every lint rule: one query that should trigger it and one close variant that should not.
const test = require('node:test'); const assert = require('node:assert/strict');
const H = require('./helpers.js'); const L = require('../js/lint.js');
const inList = (n) => Array.from({ length: n }, (_, i) => i + 1).join(', ');
const CASES = {
  'select-star': ["SELECT * FROM sales.orders WHERE order_date = DATE '2026-10-01'", "SELECT order_id, amount FROM sales.orders WHERE order_date = DATE '2026-10-01'"],
  'missing-partition-filter': ['SELECT amount FROM sales.orders', "SELECT amount FROM sales.orders WHERE order_date >= DATE '2026-10-01'"],
  'non-sargable-partition': ["SELECT amount FROM sales.orders WHERE FORMAT_DATE('%Y-%m', order_date) = '2026-09'", "SELECT amount FROM sales.orders WHERE order_date >= DATE '2026-09-01' AND order_date < DATE '2026-10-01'"],
  'cross-join': ["SELECT o.amount, c.region FROM sales.orders o CROSS JOIN sales.customers c WHERE o.order_date = DATE '2026-10-01'", "SELECT o.amount, c.region FROM sales.orders o JOIN sales.customers c ON o.customer_id = c.customer_id WHERE o.order_date = DATE '2026-10-01'"],
  'row-explosion': ["SELECT o.amount, r.return_id FROM sales.orders o JOIN sales.returns r ON o.customer_id = r.customer_id WHERE o.order_date = DATE '2026-10-01'", "SELECT o.amount, r.return_id FROM sales.orders o JOIN sales.returns r ON o.order_id = r.order_id WHERE o.order_date = DATE '2026-10-01'"],
  'order-without-limit': ['SELECT region, email FROM sales.customers ORDER BY email', 'SELECT region, email FROM sales.customers ORDER BY email LIMIT 100'],
  'distinct-large': ["SELECT DISTINCT customer_id FROM sales.orders WHERE order_date >= DATE '2026-10-01'", 'SELECT DISTINCT v FROM sales.tiny'],
  'union-distinct': ['SELECT customer_id FROM sales.customers UNION DISTINCT SELECT id FROM sales.tiny', 'SELECT customer_id FROM sales.customers UNION ALL SELECT id FROM sales.tiny'],
  'correlated-subquery': ['SELECT c.customer_id, (SELECT MAX(r.return_id) FROM sales.returns r WHERE r.order_id = c.customer_id) AS m FROM sales.customers c', 'SELECT c.customer_id FROM sales.customers c WHERE EXISTS (SELECT 1 FROM sales.returns r WHERE r.order_id = c.customer_id)'],
  'not-in-nullable': ['SELECT customer_id FROM sales.customers WHERE customer_id NOT IN (SELECT order_id FROM sales.returns)', 'SELECT customer_id FROM sales.customers WHERE customer_id NOT IN (SELECT return_id FROM sales.returns)'],
  'like-leading-wildcard': ["SELECT region FROM sales.customers WHERE email LIKE '%@example.com'", "SELECT region FROM sales.customers WHERE email LIKE 'admin%'"],
  'repeated-cte': ['WITH r AS (SELECT region, email FROM sales.customers) SELECT a.region FROM r a JOIN r b ON a.email = b.email', 'WITH r AS (SELECT region, email FROM sales.customers) SELECT region FROM r'],
  'count-distinct': ['SELECT region, COUNT(DISTINCT email) FROM sales.customers GROUP BY region', 'SELECT region, COUNT(*) FROM sales.customers GROUP BY region'],
  'large-in-list': ['SELECT region FROM sales.customers WHERE customer_id IN (' + inList(60) + ')', 'SELECT region FROM sales.customers WHERE customer_id IN (1, 2, 3)'],
  'implicit-cast-join': ['SELECT c.region, r.return_id FROM sales.customers c JOIN sales.returns r ON c.customer_id = r.customer_id', 'SELECT c.region, r.return_id FROM sales.customers c JOIN sales.returns r ON c.customer_id = r.order_id'],
  'bq-limit-no-savings': ['SELECT region, email FROM sales.customers LIMIT 10', 'SELECT region, email FROM sales.customers WHERE customer_id = 5'],
};

test('there are 16 rules and every rule has a case', () => {
  assert.equal(L.RULES.length, 16);
  assert.deepEqual(Object.keys(CASES).sort(), L.RULES.map((r) => r.id || r).sort());
});
for (const [rule, [pos, neg]] of Object.entries(CASES)) {
  test('rule ' + rule + ': flags the bad query and not the good one', () => {
    const p = H.lint(pos, 'bigquery'); const n = H.lint(neg, 'bigquery');
    assert.equal(p.ev.analysis.parser, 'bigquery', 'positive case parses with the real parser');
    const f = p.findings.find((x) => x.rule === rule);
    assert.ok(f, rule + ' should fire; got ' + H.rules(p.findings));
    assert.ok(['high', 'medium', 'low', 'info'].includes(f.severity)); assert.ok(f.message && f.why, 'has message and explanation');
    assert.ok(!H.rules(n.findings).includes(rule), rule + ' should not fire on the fixed query; got ' + H.rules(n.findings));
  });
}
test('bq-limit-no-savings is BigQuery-only', () => {
  for (const wh of ['snowflake', 'databricks', 'redshift', 'athena']) assert.ok(!H.rules(H.lint(CASES['bq-limit-no-savings'][0], wh).findings).includes('bq-limit-no-savings'), wh);
});
test('rules also fire on other warehouses (Snowflake grammar)', () => {
  for (const r of ['missing-partition-filter', 'non-sargable-partition', 'union-distinct', 'like-leading-wildcard']) assert.ok(H.rules(H.lint(CASES[r][0].replace('UNION DISTINCT', 'UNION'), 'snowflake').findings).includes(r), r);
});
test('partition fixes come with a rewrite and real savings', () => {
  const { findings } = H.lint(CASES['non-sargable-partition'][0], 'bigquery'); const f = findings.find((x) => x.rule === 'non-sargable-partition');
  assert.match(f.rewrite, /order_date >= DATE '2026-09-01' AND order_date < DATE '2026-10-01'/);
  assert.ok(f.savings.perRun > 0 && f.savings.pct > 0.5, 'reads only the September partitions: ' + f.savings.pct);
});
test('optimize applies selected fixes in sequence and reports the delta', () => {
  const sql = "SELECT * FROM sales.orders WHERE FORMAT_DATE('%Y-%m', order_date) = '2026-09' AND notes LIKE '%x%'";
  const { c, ev, findings } = H.lint(sql, 'bigquery'); const o = L.optimize(ev, findings, c);
  assert.ok(o.applied.length >= 2, 'applied ' + o.applied.map((a) => a.rule || a));
  assert.doesNotMatch(o.sql, /FORMAT_DATE/); assert.doesNotMatch(o.sql, /SELECT \*/);
  assert.ok(o.after.cost.cost < ev.cost.cost && o.delta.perRun > 0, 'cheaper after fixes');
});

/* QueryCost templates: sample catalogs (sizes are illustrative) with queries that show off each rule. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else (root.QC = root.QC || {}).templates = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // Column spec "name TYPE [width] [u=unique] [nn=not null]"
  const cols = (specs) => specs.map((s) => { const p = s.split(/\s+/); const c = { name: p[0], type: p[1] }; p.slice(2).forEach((x) => { if (x === 'u') { c.unique = true; c.nullable = false; } else if (x === 'nn') c.nullable = false; else if (/^\d/.test(x)) c.width = Number(x); }); return c; });
  const ECOM = {
    id: 'ecommerce', name: 'E-commerce', warehouse: 'bigquery', description: 'Orders, line items, customers, products and returns: 3 years of daily partitions.',
    catalog: { name: 'E-commerce sample', tables: [
      { name: 'shop.orders', rows: 2.4e9, partition: { column: 'order_date', granularity: 'day', count: 1095 }, cluster: ['customer_id', 'status'],
        columns: cols(['order_id INT64 u', 'customer_id INT64 nn', 'order_date DATE nn', 'order_ts TIMESTAMP nn', 'status STRING 10 nn', 'channel STRING 8', 'currency STRING 5', 'amount NUMERIC nn', 'discount NUMERIC', 'shipping_address STRING 120', 'notes STRING 200']) },
      { name: 'shop.order_items', rows: 7.2e9, partition: { column: 'order_date', granularity: 'day', count: 1095 }, cluster: ['product_id'],
        columns: cols(['order_id INT64 nn', 'line_no INT64 nn', 'product_id INT64 nn', 'quantity INT64', 'unit_price NUMERIC', 'order_date DATE nn']) },
      { name: 'shop.customers', rows: 4.5e7, cluster: ['region'], columns: cols(['customer_id INT64 u', 'email STRING 28', 'full_name STRING 20', 'region STRING 8', 'segment STRING 10', 'signup_date DATE', 'referrer_id INT64']) },
      { name: 'shop.products', rows: 2e5, columns: cols(['product_id INT64 u', 'sku STRING 12', 'title STRING 60', 'category STRING 16', 'brand STRING 14', 'price NUMERIC', 'description STRING 600']) },
      { name: 'shop.returns', rows: 1.1e8, partition: { column: 'return_date', granularity: 'day', count: 1095 },
        columns: cols(['return_id INT64 u', 'order_id INT64 nn', 'customer_id INT64', 'return_date DATE nn', 'reason STRING 30', 'refund_amount NUMERIC']) },
    ] },
    queries: [
      { name: 'Revenue by region, last 30 days (healthy)', schedule: { mode: 'cron', cron: '0 6 * * *' }, sql:
`SELECT c.region,
       COUNT(*)      AS orders,
       SUM(o.amount) AS revenue
FROM shop.orders AS o
JOIN shop.customers AS c ON c.customer_id = o.customer_id
WHERE o.order_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
  AND o.status = 'complete'
GROUP BY c.region
ORDER BY revenue DESC` },
      { name: 'Peek at orders with LIMIT', schedule: { mode: 'perDay', perDay: 20 }, sql: 'SELECT *\nFROM shop.orders\nLIMIT 100' },
      { name: 'September revenue with FORMAT_DATE (no pruning)', schedule: { mode: 'cron', cron: '0 * * * *' }, sql:
`SELECT status,
       SUM(amount) AS revenue
FROM shop.orders
WHERE FORMAT_DATE('%Y-%m', order_date) = '2026-09'
GROUP BY status
ORDER BY revenue DESC` },
      { name: 'Customers with no returns (NOT IN)', schedule: { mode: 'perDay', perDay: 1 }, sql:
`SELECT c.customer_id, c.email
FROM shop.customers c
WHERE c.customer_id NOT IN (SELECT customer_id FROM shop.returns)` },
      { name: 'Top products (inner ORDER BY, COUNT DISTINCT)', schedule: { mode: 'cron', cron: '*/30 * * * *' }, sql:
`WITH sold AS (
  SELECT product_id, order_id, quantity * unit_price AS line_total
  FROM shop.order_items
  WHERE order_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
  ORDER BY line_total DESC
)
SELECT p.title,
       COUNT(DISTINCT s.order_id) AS orders,
       SUM(s.line_total) AS revenue
FROM sold s
JOIN shop.products p ON p.product_id = s.product_id
GROUP BY p.title
ORDER BY revenue DESC
LIMIT 50` },
      { name: 'Orders joined to returns by customer (row explosion)', schedule: { mode: 'perDay', perDay: 4 }, sql:
`SELECT o.customer_id,
       SUM(o.amount)        AS spent,
       SUM(r.refund_amount) AS refunded
FROM shop.orders o
JOIN shop.returns r ON r.customer_id = o.customer_id
WHERE o.order_date >= '2026-10-01'
  AND r.return_date >= '2026-10-01'
GROUP BY o.customer_id` },
    ],
  };
  const CLICK = {
    id: 'clickstream', name: 'Clickstream', warehouse: 'snowflake', description: 'Web events, sessions and users: about 400 days of daily partitions, clustered by event and user.',
    catalog: { name: 'Clickstream sample', tables: [
      { name: 'analytics.events', rows: 6e10, partition: { column: 'event_date', granularity: 'day', count: 400 }, cluster: ['event_name', 'user_id'],
        columns: cols(['event_id STRING 36 u', 'user_id STRING 36 nn', 'session_id STRING 36 nn', 'event_name STRING 16 nn', 'event_ts TIMESTAMP nn', 'event_date DATE nn', 'page_url STRING 90', 'referrer STRING 70', 'device STRING 10', 'country STRING 4', 'properties JSON 400']) },
      { name: 'analytics.sessions', rows: 4e9, partition: { column: 'session_date', granularity: 'day', count: 400 }, cluster: ['user_id'],
        columns: cols(['session_id STRING 36 u', 'user_id STRING 36 nn', 'session_date DATE nn', 'started_at TIMESTAMP', 'duration_s INT64', 'landing_page STRING 80', 'utm_source STRING 12', 'utm_campaign STRING 24']) },
      { name: 'analytics.users', rows: 3e8, columns: cols(['user_id STRING 36 u', 'created_at TIMESTAMP', 'country STRING 4', 'plan STRING 8', 'email_hash STRING 64']) },
    ] },
    queries: [
      { name: 'Daily active users, last 7 days', schedule: { mode: 'cron', cron: '0 * * * *' }, sql:
`SELECT event_date,
       COUNT(DISTINCT user_id) AS dau
FROM analytics.events
WHERE event_date >= DATEADD(day, -7, CURRENT_DATE())
GROUP BY event_date
ORDER BY event_date` },
      { name: 'Signup funnel with UNION', schedule: { mode: 'perDay', perDay: 24 }, sql:
`SELECT 'viewed_pricing' AS step, user_id FROM analytics.events
WHERE event_name = 'page_view' AND page_url LIKE '%/pricing%'
  AND event_date >= '2026-10-01'
UNION
SELECT 'signed_up' AS step, user_id FROM analytics.events
WHERE event_name = 'sign_up' AND event_date >= '2026-10-01'` },
      { name: 'Campaign report (repeated CTE, string-cast partition)', schedule: { mode: 'cron', cron: '15 */2 * * *' }, sql:
`WITH oct AS (
  SELECT session_id, user_id, utm_campaign, duration_s
  FROM analytics.sessions
  WHERE CAST(session_date AS VARCHAR) LIKE '2026-10%'
)
SELECT a.utm_campaign,
       COUNT(*) AS sessions,
       (SELECT AVG(b.duration_s) FROM oct b WHERE b.utm_campaign = a.utm_campaign) AS avg_duration
FROM oct a
GROUP BY a.utm_campaign` },
      { name: 'Events per plan (missing partition filter)', schedule: { mode: 'perDay', perDay: 2 }, sql:
`SELECT u.plan, e.event_name, COUNT(*) AS events
FROM analytics.events e
JOIN analytics.users u ON u.user_id = e.user_id
GROUP BY u.plan, e.event_name` },
      { name: 'Sessions × users with no join condition', schedule: { mode: 'perDay', perDay: 1 }, sql:
`SELECT s.session_id, u.plan
FROM analytics.sessions s, analytics.users u
WHERE s.session_date = '2026-10-29'` },
    ],
  };
  const ids = Array.from({ length: 60 }, (_, i) => 4000 + i * 7).join(', ');
  const FIN = {
    id: 'finance', name: 'Finance', warehouse: 'redshift', description: 'General ledger, accounts, invoices, payments and FX rates: monthly ledger partitions over 7 years.',
    catalog: { name: 'Finance sample', tables: [
      { name: 'finance.ledger_entries', rows: 1.2e10, partition: { column: 'posting_month', granularity: 'month', count: 84 }, cluster: ['account_id'],
        columns: cols(['entry_id BIGINT u', 'journal_id BIGINT nn', 'account_id INT nn', 'posting_date DATE nn', 'posting_month DATE nn', 'amount DECIMAL(18,2) nn', 'currency CHAR(3) nn', 'description VARCHAR(256)', 'cost_center VARCHAR(16)', 'created_by VARCHAR(32)']) },
      { name: 'finance.accounts', rows: 25000, columns: cols(['account_id INT u', 'account_code VARCHAR(12) nn', 'account_name VARCHAR(80)', 'account_type VARCHAR(16)', 'parent_account_id INT']) },
      { name: 'finance.fx_rates', rows: 2e6, partition: { column: 'rate_date', granularity: 'day', count: 3650 }, columns: cols(['rate_date DATE nn', 'currency CHAR(3) nn', 'usd_rate DECIMAL(18,8) nn']) },
      { name: 'finance.invoices', rows: 3e8, partition: { column: 'invoice_date', granularity: 'day', count: 2555 }, cluster: ['customer_id'],
        columns: cols(['invoice_id BIGINT u', 'customer_id INT nn', 'invoice_date DATE nn', 'due_date DATE', 'amount DECIMAL(18,2)', 'status VARCHAR(12)', 'currency CHAR(3)']) },
      { name: 'finance.payments', rows: 2.8e8, partition: { column: 'paid_date', granularity: 'day', count: 2555 },
        columns: cols(['payment_id BIGINT u', 'invoice_ref VARCHAR(20)', 'paid_date DATE nn', 'amount DECIMAL(18,2)', 'method VARCHAR(10)']) },
    ] },
    queries: [
      { name: 'Trial balance for one quarter (healthy)', schedule: { mode: 'cron', cron: '0 2 * * *' }, sql:
`SELECT a.account_code, a.account_name, SUM(l.amount) AS balance
FROM finance.ledger_entries l
JOIN finance.accounts a ON a.account_id = l.account_id
WHERE l.posting_month BETWEEN '2026-07-01' AND '2026-09-01'
GROUP BY a.account_code, a.account_name` },
      { name: 'Payments matched to invoices (type mismatch)', schedule: { mode: 'perDay', perDay: 6 }, sql:
`SELECT i.invoice_id, i.amount, p.amount AS paid
FROM finance.invoices i
JOIN finance.payments p ON p.invoice_ref = i.invoice_id
WHERE i.invoice_date >= '2026-01-01'
  AND p.paid_date >= '2026-01-01'` },
      { name: 'Ledger lines for a list of accounts', schedule: { mode: 'perDay', perDay: 12 }, sql:
`SELECT entry_id, account_id, posting_date, amount, description
FROM finance.ledger_entries
WHERE account_id IN (${ids})
  AND posting_month >= '2026-01-01'` },
      { name: 'USD amounts with a correlated FX lookup', schedule: { mode: 'cron', cron: '0 */4 * * 1-5' }, sql:
`SELECT l.entry_id,
       l.amount * (SELECT f.usd_rate FROM finance.fx_rates f
                   WHERE f.currency = l.currency AND f.rate_date = l.posting_date) AS amount_usd
FROM finance.ledger_entries l
WHERE l.posting_month = '2026-10-01'` },
      { name: 'Aging report (YEAR() on partition, full sort)', schedule: { mode: 'perDay', perDay: 1 }, sql:
`SELECT DISTINCT i.customer_id, i.invoice_id, i.due_date, i.amount
FROM finance.invoices i
WHERE YEAR(i.invoice_date) = 2026
  AND i.status <> 'paid'
ORDER BY i.due_date` },
    ],
  };
  const TEMPLATES = [ECOM, CLICK, FIN];
  return { TEMPLATES, byId: (id) => TEMPLATES.find((t) => t.id === id) };
});

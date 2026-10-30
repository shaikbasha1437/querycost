'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const C = require('../js/catalog.js'); const S = require('../js/schedule.js');

test('CSV import groups rows by table with sizes, partition and cluster keys', () => {
  const csv = 'table_name,row_count,total_bytes,column_name,data_type,is_partitioning_column,clustering_ordinal_position\nshop.orders,2400000000,180 GB,order_id,INT64,NO,\nshop.orders,,,order_date,DATE,YES,\nshop.orders,,,customer_id,INT64,NO,1\nshop.customers,5000,,id,INT64,NO,';
  const r = C.importText(csv); assert.equal(r.format, 'delimited'); assert.equal(r.tables.length, 2);
  const o = r.tables.find((t) => t.name === 'shop.orders'); assert.equal(o.rows, 2.4e9); assert.equal(o.columns.length, 3);
  assert.equal(o.partition.column, 'order_date'); assert.deepEqual(o.cluster, ['customer_id']); assert.ok(o.bytes > 1.7e11 && o.bytes < 2e11, String(o.bytes));
});
test('Snowflake INFORMATION_SCHEMA output (TSV, upper-case headers, CLUSTERING_KEY)', () => {
  const tsv = 'TABLE_SCHEMA\tTABLE_NAME\tROW_COUNT\tBYTES\tCLUSTERING_KEY\tCOLUMN_NAME\tDATA_TYPE\tIS_NULLABLE\nANALYTICS\tEVENTS\t900000000\t120000000000\tLINEAR(EVENT_DATE, USER_ID)\tEVENT_DATE\tDATE\tNO\nANALYTICS\tEVENTS\t\t\t\tUSER_ID\tNUMBER\tYES';
  const t = C.importText(tsv).tables[0]; assert.equal(t.name, 'analytics.events'); assert.equal(t.rows, 9e8); assert.deepEqual(t.cluster, ['event_date', 'user_id']);
  assert.equal(t.columns.find((c) => c.name === 'event_date').nullable, false);
});
test('DDL import reads PARTITION BY, CLUSTER BY and guesses rows', () => {
  const r = C.importText('CREATE TABLE demo.events (id INT64 NOT NULL, ts TIMESTAMP, user_id INT64, payload STRING) PARTITION BY DATE(ts) CLUSTER BY user_id;');
  assert.equal(r.format, 'ddl'); const t = r.tables[0]; assert.equal(t.name, 'demo.events'); assert.equal(t.partition.column, 'ts'); assert.deepEqual(t.cluster, ['user_id']); assert.ok(t.rowsGuessed);
  assert.equal(t.columns.find((c) => c.name === 'id').nullable, false);
});
test('Hive/Athena DDL with PARTITIONED BY columns', () => {
  const t = C.importText('CREATE EXTERNAL TABLE logs (msg string, status int) PARTITIONED BY (dt string) STORED AS PARQUET').tables[0];
  assert.equal(t.partition.column, 'dt'); assert.ok(t.columns.some((c) => c.name === 'dt'));
});
test('merge keeps known sizes when re-importing DDL; replace starts over', () => {
  const cat = C.normalize({ tables: [{ name: 'demo.events', rows: 5e9, columns: [{ name: 'id', type: 'INT64' }] }, { name: 'x', rows: 1, columns: [] }] });
  const ddl = C.importText('CREATE TABLE demo.events (id INT64, ts TIMESTAMP)').tables;
  const m = C.merge(cat, ddl, 'merge'); assert.equal(m.tables.length, 2); assert.equal(m.tables[0].rows, 5e9); assert.equal(m.tables[0].columns.length, 2);
  assert.equal(C.merge(cat, ddl, 'replace').tables.length, 1);
});
test('CSV export round-trips', () => {
  const cat = C.normalize({ tables: [{ name: 'a.b', rows: 10, partition: { column: 'd', granularity: 'day', count: 5 }, cluster: ['k'], columns: [{ name: 'd', type: 'DATE' }, { name: 'k', type: 'STRING', unique: true }] }] });
  const back = C.importText(C.toCSV(cat)).tables[0]; assert.equal(back.name, 'a.b'); assert.equal(back.rows, 10); assert.equal(back.partition.column, 'd'); assert.deepEqual(back.cluster, ['k']); assert.ok(back.columns.find((c) => c.name === 'k').unique);
});
test('type widths follow BigQuery data-type sizes', () => { assert.equal(C.typeWidth('INT64'), 8); assert.equal(C.typeWidth('BOOL'), 1); assert.equal(C.typeWidth('NUMERIC'), 16); assert.ok(C.typeWidth('STRING') > 2); });

test('cron: every 15 minutes = 96/day, 2880/30 days', () => { assert.equal(S.countRuns('*/15 * * * *', new Date('2026-11-01T00:00:00Z'), 30), 2880); });
test('cron: weekdays at 06:00 over 30 days', () => { assert.equal(S.countRuns('0 6 * * 1-5', new Date('2026-11-01T00:00:00Z'), 30), 21); });
test('cron macros and names', () => {
  assert.equal(S.countRuns('@hourly', new Date('2026-11-01T00:00:00Z'), 30), 720); assert.equal(S.countRuns('@daily', new Date('2026-11-01T00:00:00Z'), 30), 30);
  assert.equal(S.countRuns('0 0 * * MON', new Date('2026-11-01T00:00:00Z'), 28), 4);
});
test('cron: day-of-month and day-of-week use OR semantics', () => { assert.equal(S.countRuns('0 0 1 * 0', new Date('2026-11-01T00:00:00Z'), 30), 5); });
test('cron: invalid expressions report an error', () => { assert.ok(S.project(1, { mode: 'cron', cron: '61 * * * *' }, new Date()).error); assert.ok(S.project(1, { mode: 'cron', cron: 'nope' }, new Date()).error); });
test('runs per day projects per month as × 30', () => { const p = S.project(0.5, { mode: 'perDay', perDay: 24 }, new Date()); assert.equal(p.runsMonth, 720); assert.equal(p.perMonth, 360); assert.equal(p.perDay, 12); });

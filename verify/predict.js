// Prints QueryCost's prediction (columns read, partitions read) for each query in queries.json, as JSON.
'use strict';
const path = require('path'); const C = require('../js/catalog.js'); const EN = require('../js/engine.js'); const PR = require('../js/pricing.js');
const { getParser } = require('../test/helpers.js');
const spec = require(path.resolve(process.argv[2] || 'queries.json'));
const cat = C.normalize(spec.catalog);
const out = spec.queries.map((q) => {
  const ev = EN.evaluate(q.sql, { catalog: cat, settings: PR.defaults(), warehouse: q.warehouse || 'athena', getParser, today: spec.today, schedule: { mode: 'perDay', perDay: 1 } });
  return { name: q.name, parser: ev.analysis.parser, tables: ev.scan.tables.map((t) => ({ name: t.name, columns: t.columnsRead.map((c) => c.name).sort(), partitionsRead: t.partition.read, partitionsTotal: t.partition.total, reason: t.partition.reason })) };
});
process.stdout.write(JSON.stringify(out, null, 1));

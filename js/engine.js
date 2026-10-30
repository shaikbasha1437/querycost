/* QueryCost engine: parse + analyze + estimate in one call, for every warehouse. */
(function (root, factory) {
  const isNode = typeof require === 'function' && typeof module === 'object';
  const m = factory(isNode ? require('./analyze.js') : root.QC.analyze, isNode ? require('./estimate.js') : root.QC.estimate, isNode ? require('./pricing.js') : root.QC.pricing, isNode ? require('./schedule.js') : root.QC.schedule);
  if (isNode) module.exports = m; else (root.QC = root.QC || {}).engine = m;
})(typeof self !== 'undefined' ? self : this, function (A, E, PR, S) {
  'use strict';
  // ctx: { catalog, settings, warehouse, getParser(grammar), today, schedule }
  function evaluate(sql, ctx) {
    const analysis = A.analyze(sql, ctx.catalog, { warehouse: ctx.warehouse, getParser: ctx.getParser, today: ctx.today });
    // BigQuery prunes through a few more functions than the others, so it gets its own scan.
    const scans = {}; const scanFor = (wh) => { const k = wh === 'bigquery' ? 'bigquery' : 'default'; return scans[k] || (scans[k] = E.scan(analysis, ctx.catalog, ctx.settings, ctx.today, wh)); };
    const scan = scanFor(ctx.warehouse);
    const costs = {};
    PR.WAREHOUSES.forEach((w) => { costs[w.id] = withSchedule(E.cost(scanFor(w.id), ctx.settings, w.id), ctx); });
    return { sql, analysis, scan, costs, cost: costs[ctx.warehouse] };
  }
  function withSchedule(c, ctx) {
    const proj = S.project(c.cost, ctx.schedule, ctx.today ? new Date(ctx.today + 'T00:00:00Z') : new Date());
    c.schedule = proj; c.perDay = proj.perDay; c.perMonth = E.monthly(c, proj, ctx.settings);
    return c;
  }
  // Cost of a scan with tweaked features or table scaling (used for lint savings).
  function costWith(scan, ctx, tweak) {
    const sc = Object.assign({}, scan, { features: Object.assign({}, scan.features, tweak.features || {}), tables: scan.tables.map((t) => {
      const f = tweak.tables && tweak.tables[t.name]; if (!f) return t;
      return Object.assign({}, t, { bytesAfterPartition: t.bytesAfterPartition * f, bytesAfterCluster: t.bytesAfterCluster * f, rowsScanned: t.rowsScanned * f });
    }) });
    if (tweak.noRepeat) sc.tables = sc.tables.map((t) => Object.assign({}, t, { reads: t.refs }));
    return withSchedule(E.cost(sc, ctx.settings, ctx.warehouse), ctx);
  }
  return { evaluate, costWith, withSchedule };
});

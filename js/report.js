/* QueryCost reports: Markdown, standalone HTML and JSON exports of an estimate. */
(function (root, factory) {
  const isNode = typeof require === 'function' && typeof module === 'object';
  const m = factory(isNode ? require('./estimate.js') : root.QC.estimate, isNode ? require('./pricing.js') : root.QC.pricing, isNode ? require('./schedule.js') : root.QC.schedule);
  if (isNode) module.exports = m; else (root.QC = root.QC || {}).report = m;
})(typeof self !== 'undefined' ? self : this, function (E, PR, S) {
  'use strict';
  const money = E.fmtMoney, bytes = E.fmtBytes;
  const whName = (id) => (PR.WAREHOUSES.find((w) => w.id === id) || { name: id }).name;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DISCLAIMER = 'Estimates only. Figures come from the catalog sizes and the editable assumptions listed here, not from the warehouse. Check real usage with your warehouse\'s dry run, query profile or billing data.';
  // data: { title, ev, findings, ctx, optimized? }
  function toJSON(d) {
    const c = d.ev.cost;
    return JSON.stringify({
      generator: 'QueryCost', generatedAt: d.now || new Date().toISOString(), disclaimer: DISCLAIMER, title: d.title || 'Query', warehouse: d.ctx.warehouse,
      sql: d.ev.sql, parser: d.ev.analysis.parser || 'fallback (approximate)', schedule: d.ctx.schedule,
      cost: { perRun: c.cost, perDay: c.perDay, perMonth: c.perMonth, runsPerMonth: c.schedule.runsMonth, steps: c.steps, scanBytes: c.scanBytes, billedBytes: c.billedBytes, runtimeSec: c.runtimeSec },
      comparison: Object.fromEntries(Object.entries(d.ev.costs).map(([k, v]) => [k, { perRun: v.cost, perMonth: v.perMonth }])),
      tables: d.ev.scan.tables.map((t) => ({ name: t.name, columnsRead: t.columnsRead.map((x) => x.name), bytesBeforePruning: t.columnBytes, bytesAfterPartitionPruning: t.bytesAfterPartition, bytesAfterClustering: t.bytesAfterCluster, partitionsRead: t.partition.read, partitionsTotal: t.partition.total, partitionNote: t.partition.reason })),
      unknownTables: d.ev.scan.unknown,
      findings: d.findings.map((f) => ({ rule: f.rule, severity: f.severity, title: f.title, message: f.message, why: f.why, savingsPerRun: f.savings ? f.savings.perRun : null, savingsPerMonth: f.savings ? f.savings.perMonth : null, rewrite: f.rewrite || null })),
      optimized: d.optimized ? { sql: d.optimized.sql, perRun: d.optimized.after.cost.cost, perMonth: d.optimized.after.cost.perMonth, applied: d.optimized.applied.map((f) => f.rule) } : null,
      prices: { asOf: d.ctx.settings.asOf, sources: PR.SOURCES[d.ctx.warehouse] },
      assumptions: d.ctx.settings,
    }, null, 2);
  }
  function toMarkdown(d) {
    const c = d.ev.cost; const L = [];
    L.push('# QueryCost report: ' + (d.title || 'Query'), '', '> ' + DISCLAIMER, '');
    L.push('**Warehouse:** ' + whName(d.ctx.warehouse) + '  ', '**Schedule:** ' + S.describe(d.ctx.schedule) + ' (' + Math.round(c.schedule.runsMonth) + ' runs per 30 days)  ', '**Parser:** ' + (d.ev.analysis.parser ? d.ev.analysis.parser + ' grammar' : 'token fallback (approximate)'), '');
    L.push('| Per run | Per day | Per month |', '|---:|---:|---:|', '| ' + money(c.cost) + ' | ' + money(c.perDay) + ' | ' + money(c.perMonth) + ' |', '');
    L.push('## How the estimate was computed', ''); c.steps.forEach((s) => L.push('- ' + s)); L.push('');
    L.push('## Tables read', '', '| Table | Columns read | Before pruning | After pruning | Partitions |', '|---|---|---:|---:|---|');
    d.ev.scan.tables.forEach((t) => L.push('| ' + t.name + ' | ' + t.columnsRead.map((x) => x.name).join(', ') + ' | ' + bytes(t.columnBytes) + ' | ' + bytes(t.bytesAfterCluster) + ' | ' + (t.partition.total ? t.partition.read + ' of ' + t.partition.total : 'not partitioned') + ' |'));
    if (d.ev.scan.unknown.length) L.push('', 'Not in the catalog (counted as 0 bytes): ' + d.ev.scan.unknown.join(', '));
    L.push('', '## All warehouses', '', '| Warehouse | Per run | Per month |', '|---|---:|---:|');
    PR.WAREHOUSES.forEach((w) => { const x = d.ev.costs[w.id]; L.push('| ' + w.name + ' | ' + money(x.cost) + ' | ' + money(x.perMonth) + ' |'); });
    L.push('', '## Findings', '');
    if (!d.findings.length) L.push('No issues found.');
    d.findings.forEach((f) => { L.push('### [' + f.severity.toUpperCase() + '] ' + f.title, '', f.message, '', f.why); if (f.savings && f.savings.perRun > 0) L.push('', '**Estimated saving:** ' + money(f.savings.perRun) + ' per run, ' + money(f.savings.perMonth) + ' per month' + (f.savings.note ? ' (' + f.savings.note + ')' : '')); L.push(''); });
    L.push('## Query', '', '```sql', d.ev.sql, '```', '');
    if (d.optimized && d.optimized.applied.length) L.push('## Suggested query', '', 'Saves about ' + money(d.optimized.delta.perRun) + ' per run, ' + money(d.optimized.delta.perMonth) + ' per month. Review it: some fixes change results.', '', '```sql', d.optimized.sql, '```', '');
    L.push('## Prices (as of ' + d.ctx.settings.asOf + ')', ''); (PR.SOURCES[d.ctx.warehouse] || []).forEach((s) => L.push('- [' + s.label + '](' + s.url + ')'));
    return L.join('\n') + '\n';
  }
  function toHTML(d) {
    const c = d.ev.cost; const sev = { high: '#d92d20', medium: '#dc6803', low: '#2e90fa', info: '#667085' };
    const rows = d.ev.scan.tables.map((t) => '<tr><td>' + esc(t.name) + '</td><td>' + esc(t.columnsRead.map((x) => x.name).join(', ')) + '</td><td class=n>' + bytes(t.columnBytes) + '</td><td class=n>' + bytes(t.bytesAfterCluster) + '</td><td>' + (t.partition.total ? t.partition.read + ' of ' + t.partition.total : 'not partitioned') + '</td></tr>').join('');
    const comp = PR.WAREHOUSES.map((w) => { const x = d.ev.costs[w.id]; return '<tr><td>' + esc(w.name) + '</td><td class=n>' + money(x.cost) + '</td><td class=n>' + money(x.perMonth) + '</td></tr>'; }).join('');
    const finds = d.findings.map((f) => '<div class=f><span class=sev style="background:' + sev[f.severity] + '">' + f.severity + '</span> <b>' + esc(f.title) + '</b><p>' + esc(f.message) + '</p><p class=why>' + esc(f.why) + '</p>' + (f.savings && f.savings.perRun > 0 ? '<p><b>Estimated saving:</b> ' + money(f.savings.perRun) + ' per run, ' + money(f.savings.perMonth) + ' per month' + (f.savings.note ? ' (' + esc(f.savings.note) + ')' : '') + '</p>' : '') + '</div>').join('') || '<p>No issues found.</p>';
    return '<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>QueryCost report: ' + esc(d.title || 'Query') + '</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:920px;margin:2rem auto;padding:0 1rem;color:#1d2433}table{border-collapse:collapse;width:100%;margin:.5rem 0 1.5rem}td,th{border-bottom:1px solid #e4e7ec;padding:.4rem .5rem;text-align:left;vertical-align:top}.n{text-align:right;font-variant-numeric:tabular-nums}pre{background:#f4f5f7;padding:1rem;border-radius:8px;overflow:auto}.note{background:#fff8e6;border-left:4px solid #f5a524;padding:.6rem 1rem}.big{display:flex;gap:2rem;flex-wrap:wrap}.big div{font-size:1.6rem;font-weight:700}.big small{display:block;font-size:.8rem;font-weight:400;color:#667085}.sev{color:#fff;border-radius:4px;padding:1px 6px;font-size:.75rem;text-transform:uppercase}.f{border:1px solid #e4e7ec;border-radius:8px;padding:.6rem 1rem;margin:.6rem 0}.why{color:#475467}</style></head><body>' +
      '<h1>QueryCost report: ' + esc(d.title || 'Query') + '</h1><p class=note>' + esc(DISCLAIMER) + '</p>' +
      '<p><b>Warehouse:</b> ' + esc(whName(d.ctx.warehouse)) + ' &middot; <b>Schedule:</b> ' + esc(S.describe(d.ctx.schedule)) + ' (' + Math.round(c.schedule.runsMonth) + ' runs per 30 days)</p>' +
      '<div class=big><div>' + money(c.cost) + '<small>per run</small></div><div>' + money(c.perDay) + '<small>per day</small></div><div>' + money(c.perMonth) + '<small>per month</small></div></div>' +
      '<h2>How the estimate was computed</h2><ul>' + c.steps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ul>' +
      '<h2>Tables read</h2><table><tr><th>Table</th><th>Columns read</th><th class=n>Before pruning</th><th class=n>After pruning</th><th>Partitions</th></tr>' + rows + '</table>' +
      '<h2>All warehouses</h2><table><tr><th>Warehouse</th><th class=n>Per run</th><th class=n>Per month</th></tr>' + comp + '</table>' +
      '<h2>Findings</h2>' + finds + '<h2>Query</h2><pre>' + esc(d.ev.sql) + '</pre>' +
      (d.optimized && d.optimized.applied.length ? '<h2>Suggested query</h2><p>Saves about ' + money(d.optimized.delta.perRun) + ' per run, ' + money(d.optimized.delta.perMonth) + ' per month. Review it: some fixes change results.</p><pre>' + esc(d.optimized.sql) + '</pre>' : '') +
      '<h2>Prices (as of ' + esc(d.ctx.settings.asOf) + ')</h2><ul>' + (PR.SOURCES[d.ctx.warehouse] || []).map((s) => '<li><a href="' + esc(s.url) + '">' + esc(s.label) + '</a></li>').join('') + '</ul><p><small>Generated by QueryCost.</small></p></body></html>';
  }
  return { toJSON, toMarkdown, toHTML, DISCLAIMER, esc };
});

/* QueryCost lint rules. Each finding has a severity, an explanation, an estimated saving
   (re-estimated with the same model) and, where it can be done safely in text, a rewrite. */
(function (root, factory) {
  const isNode = typeof require === 'function' && typeof module === 'object';
  const m = factory(isNode ? require('./catalog.js') : root.QC.catalog, isNode ? require('./rewrite.js') : root.QC.rewrite, isNode ? require('./engine.js') : root.QC.engine, isNode ? require('./estimate.js') : root.QC.estimate);
  if (isNode) module.exports = m; else (root.QC = root.QC || {}).lint = m;
})(typeof self !== 'undefined' ? self : this, function (C, R, EN, E) {
  'use strict';
  const SEV = { high: 3, medium: 2, low: 1, info: 0 };
  const RULES = [
    { id: 'select-star', title: 'SELECT * reads every column' },
    { id: 'missing-partition-filter', title: 'No filter on the partition column' },
    { id: 'non-sargable-partition', title: 'Function on the partition column blocks pruning' },
    { id: 'cross-join', title: 'Cross join or join with no condition' },
    { id: 'row-explosion', title: 'Many-to-many join can multiply rows' },
    { id: 'order-without-limit', title: 'ORDER BY without LIMIT' },
    { id: 'distinct-large', title: 'DISTINCT over a large result' },
    { id: 'union-distinct', title: 'UNION removes duplicates (UNION ALL does not)' },
    { id: 'correlated-subquery', title: 'Correlated subquery' },
    { id: 'not-in-nullable', title: 'NOT IN with a nullable column' },
    { id: 'like-leading-wildcard', title: "LIKE '%…' cannot use pruning or indexes" },
    { id: 'repeated-cte', title: 'CTE referenced more than once' },
    { id: 'count-distinct', title: 'Exact COUNT(DISTINCT) on many rows' },
    { id: 'large-in-list', title: 'Large IN list' },
    { id: 'implicit-cast-join', title: 'Join on columns of different types' },
    { id: 'bq-limit-no-savings', title: 'LIMIT does not reduce BigQuery bytes billed' },
  ];
  const TITLE = Object.fromEntries(RULES.map((r) => [r.id, r.title]));
  const DEFAULT_OPTS = { largeRows: 1e7, inListMax: 50, recentDays: 7 };

  // Predicate keeping only recent partitions, in the warehouse's dialect.
  function recentFilter(q, col, type, gran, wh, today, days) {
    const c = q ? q + '.' + col : col; const fam = C.typeFamily(type); const ts = /timestamp|datetime/i.test(type || '');
    const n = gran === 'month' ? 3 : gran === 'year' ? 1 : days; const unit = gran === 'month' ? 'MONTH' : gran === 'year' ? 'YEAR' : 'DAY';
    if (fam === 'string' || fam === 'number' || fam === 'other' || fam === 'unknown') {
      if (gran === 'value') return null;
      const d = new Date(today + 'T00:00:00Z'); if (unit === 'DAY') d.setUTCDate(d.getUTCDate() - n); else if (unit === 'MONTH') d.setUTCMonth(d.getUTCMonth() - n); else d.setUTCFullYear(d.getUTCFullYear() - n);
      const iso = d.toISOString().slice(0, 10);
      return fam === 'number' ? c + ' >= ' + iso.replace(/-/g, '') : c + " >= '" + iso + "'";
    }
    switch (wh) {
      case 'bigquery': return ts ? c + ' >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ' + (unit === 'DAY' ? n : n * (unit === 'MONTH' ? 30 : 365)) + ' DAY)' : c + ' >= DATE_SUB(CURRENT_DATE(), INTERVAL ' + n + ' ' + unit + ')';
      case 'snowflake': return c + ' >= DATEADD(' + unit.toLowerCase() + ', -' + n + ', CURRENT_DATE())';
      case 'databricks': return unit === 'DAY' ? c + ' >= date_sub(current_date(), ' + n + ')' : c + ' >= add_months(current_date(), -' + (unit === 'MONTH' ? n : n * 12) + ')';
      case 'redshift': return c + ' >= DATEADD(' + unit.toLowerCase() + ', -' + n + ', CURRENT_DATE)';
      default: return c + " >= current_date - interval '" + n + "' " + unit.toLowerCase();
    }
  }
  function saving(base, alt) {
    if (!alt) return null; const perRun = base.cost - alt.cost; if (!(perRun > 0)) return { perRun: 0, perMonth: 0 };
    return { perRun, perMonth: Math.max(0, base.perMonth - alt.perMonth), pct: base.cost ? perRun / base.cost : 0 };
  }
  function reeval(sql, ctx) { try { return EN.evaluate(sql, ctx).cost; } catch (e) { return null; } }
  const qualOf = (sql, r) => { const q = R.qualifierFor(sql, r.name, r.alias); return q; };

  // Run all rules. Returns findings sorted by severity then savings.
  function run(ev, ctx, opts) {
    const o = Object.assign({}, DEFAULT_OPTS, opts || {}); const sql = ev.sql; const model = ev.analysis.model; const wh = ctx.warehouse; const base = ev.cost;
    const today = ctx.today || new Date().toISOString().slice(0, 10);
    const out = []; const add = (rule, f) => out.push(Object.assign({ rule, title: TITLE[rule], severity: 'low', savings: null, rewrite: null, fix: null, changesResults: false }, f));
    const tables = ev.scan.tables; const totalRows = tables.reduce((s, t) => s + t.rowsScanned, 0);
    const refsOf = (name) => model.refs.filter((r) => r.kind === 'table' && r.table && r.table.name === name);
    const mainScopes = model.scopes.filter((s) => s.kind === 'main');

    // 1. SELECT *
    tables.forEach((t) => {
      if (!t.allColumns || t.noColumnInfo || t.columnsTotal < 4) return;
      const wide = t.columnsRead.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 3); const dropped = wide.reduce((s, c) => s + c.bytes, 0);
      const factor = t.columnBytes ? (t.columnBytes - dropped) / t.columnBytes : 1;
      const keep = t.columnsRead.map((c) => c.name).filter((n) => !wide.some((w) => w.name === n));
      const ref = refsOf(t.name)[0];
      const fix = (s) => { const toks = R.lex(s); const f = R.findRef(toks, ref.name, ref.alias); if (!f) return null; const blk = R.blockOf(toks, f.start);
        let sel = -1; for (let k = blk.b - 1; k >= blk.a; k--) if (toks[k].d === blk.d && toks[k].lv === 'select') { sel = k; break; }
        if (sel < 0) return null; if (toks.slice(sel, blk.b).some((x) => x.d === blk.d && x.lv === 'join') || toks.slice(sel, blk.b).some((x, i, arr) => x.d === blk.d && x.v === ',' && arr.slice(0, i).some((y) => y.d === blk.d && y.lv === 'from'))) return null;
        let k = sel + 1; if (toks[k] && toks[k].lv === 'distinct') k++; if (!toks[k] || toks[k].v !== '*') return null;
        const list = keep.join(', ') + ' /* dropped: ' + wide.map((w) => w.name).join(', ') + ' */'; return s.slice(0, toks[k].s) + list + s.slice(toks[k].e); };
      const rw = ref ? fix(sql) : null; const alt = EN.costWith(ev.scan, ctx, { tables: { [t.name]: factor } });
      add('select-star', { severity: factor < 0.6 ? 'medium' : 'low', table: t.name, changesResults: true,
        message: 'Every column of ' + t.name + ' is read (' + t.columnsRead.length + ' columns, ' + E.fmtBytes(t.columnBytes) + ' before pruning).',
        why: 'Columnar warehouses bill or spend time per column read. Name the columns you need; the widest here are ' + wide.map((w) => w.name + ' (' + E.fmtBytes(w.bytes) + ')').join(', ') + '.',
        savings: Object.assign(saving(base, alt) || {}, { note: 'if the 3 widest columns are dropped' }), rewrite: rw, fix: rw ? fix : null, fixLabel: 'List columns, drop the widest' });
    });
    // 2. Missing partition filter / 3. non-sargable
    tables.forEach((t) => {
      const tb = refsOf(t.name)[0] && refsOf(t.name)[0].table; if (!tb || !tb.partition) return;
      const pcol = C.column(tb, tb.partition.column);
      if (/^no filter/.test(t.partition.reason || '')) {
        const ref = refsOf(t.name)[0];
        const fix = (s) => { const q = qualOf(s, ref); const multi = model.scopes[ref.scopeId].refIds.length > 1; const p = recentFilter(multi || ref.alias ? q : null, tb.partition.column, pcol && pcol.type, tb.partition.granularity, wh, today, o.recentDays); return p ? R.addPredicateForRef(s, ref.name, ref.alias, p) : null; };
        const rw = fix(sql); const alt = rw ? reeval(rw, ctx) : null;
        add('missing-partition-filter', { severity: t.columnBytes > 10 * E.GiB ? 'high' : 'medium', table: t.name, changesResults: true,
          message: t.name + ' is partitioned by ' + tb.partition.column + ' (' + tb.partition.count + ' ' + tb.partition.granularity + ' partitions) but nothing filters on it, so all partitions are read.',
          why: 'A filter on the partition column lets the engine skip whole partitions before reading. Add the narrowest date window the query really needs.',
          savings: rw ? Object.assign(saving(base, alt) || {}, { note: 'with a last-' + (tb.partition.granularity === 'month' ? '3-months' : tb.partition.granularity === 'year' ? 'year' : o.recentDays + '-days') + ' filter' }) : null,
          rewrite: rw, fix: rw ? fix : null, fixLabel: 'Add a recent-partition filter' });
      } else if (t.partition.wrapped) {
        const kind = pcol && /timestamp|datetime/i.test(pcol.type) ? 'timestamp' : (pcol && C.typeFamily(pcol.type) === 'string' ? 'string' : 'date');
        const fix = (s) => R.sargable(s, tb.partition.column, kind, wh); const rw = fix(sql); const alt = rw ? reeval(rw, ctx) : null;
        add('non-sargable-partition', { severity: 'high', table: t.name,
          message: t.partition.reason.replace(/^filter/, 'The filter') + ' on ' + t.name + ', so all ' + tb.partition.count + ' partitions are read.',
          why: 'Engines prune partitions by comparing the bare column with constants. Compare ' + tb.partition.column + ' to a range instead (for example col >= DATE \'2026-01-01\' AND col < DATE \'2027-01-01\').',
          savings: alt ? saving(base, alt) : null, rewrite: rw, fix: rw ? fix : null, fixLabel: 'Rewrite as a range on ' + tb.partition.column });
      }
    });
    // 4. Cross joins
    model.scopes.forEach((s) => s.joins.forEach((j) => {
      const r = model.refs[j.refId]; if (!r || r.kind === 'other' || /unnest/i.test(r.name)) return;
      if (!(/cross/.test(j.type || '') || !j.hasCondition)) return;
      const left = j.prev.map((id) => model.refs[id].name).join(', ');
      const rowsOf = (ref) => { const t = ref.table && tables.find((x) => x.name === ref.table.name); return t ? t.rowsScanned : null; };
      const rr = rowsOf(r); const lr = j.prev.map((id) => rowsOf(model.refs[id])).reduce((a, b) => (a == null || b == null ? null : a * b), 1);
      const tiny = rr != null && rr <= 1000 || (lr != null && lr <= 1000);
      add('cross-join', { severity: tiny ? 'low' : 'high', message: (j.type === 'comma' ? 'Comma join' : 'Cross join') + ' between ' + left + ' and ' + r.name + ' has no join condition' + (rr != null && lr != null ? ': about ' + Math.round(rr * lr).toLocaleString('en-US') + ' row pairs.' : '.'),
        why: 'Without an ON condition every row pairs with every other row. Add the join keys, or keep it only for a tiny lookup such as a date spine.' });
    }));
    // 5. Many-to-many
    ev.scan.features.explosionPairs.forEach((p) => add('row-explosion', { severity: 'high', message: p.left + ' = ' + p.right + ': the catalog marks neither column unique, so each key can match many rows on both sides.',
      why: 'Many-to-many joins multiply rows before aggregation, which inflates SUM/COUNT results and runtime. Aggregate one side to one row per key first, or join on a unique key.',
      savings: Object.assign(saving(base, EN.costWith(ev.scan, ctx, { features: { explosion: false } })) || {}, { note: 'if one side is pre-aggregated' }) }));
    // 6. ORDER BY without LIMIT
    const inner = R.dropInnerOrderBy(sql);
    if (inner) add('order-without-limit', { severity: 'medium', message: 'A subquery or CTE sorts its rows but has no LIMIT, so the order is thrown away.',
      why: 'Only the outermost ORDER BY decides the final order. Sorting inside a subquery costs time and memory for nothing.',
      savings: saving(base, reeval(inner, ctx)), rewrite: inner, fix: (s) => R.dropInnerOrderBy(s), fixLabel: 'Remove the inner ORDER BY' });
    if (mainScopes.some((s) => s.orderBy && s.limit == null && !s.groupBy && !s.aggregates) && totalRows > o.largeRows / 10) add('order-without-limit', { severity: 'low', message: 'The final result is sorted in full (about ' + Math.round(totalRows).toLocaleString('en-US') + ' input rows) with no LIMIT.',
      why: 'A full sort of a large result is slow and spills memory. If a person or dashboard only reads the top rows, add LIMIT; otherwise sort in the tool that consumes the data.',
      savings: Object.assign(saving(base, EN.costWith(ev.scan, ctx, { features: { sort: false } })) || {}, { note: 'if the sort is dropped' }) });
    // 7. DISTINCT on large sets
    if (model.scopes.some((s) => s.distinct) && totalRows > o.largeRows) add('distinct-large', { severity: 'medium', message: 'SELECT DISTINCT de-duplicates about ' + Math.round(totalRows).toLocaleString('en-US') + ' scanned rows.',
      why: 'DISTINCT shuffles and hashes every row. If duplicates come from a join, fix the join; if you need one row per key, GROUP BY that key; if rows are already unique, drop DISTINCT.',
      savings: Object.assign(saving(base, EN.costWith(ev.scan, ctx, { features: { distinct: model.setOps.some((x) => !/all/.test(x)) } })) || {}, { note: 'without DISTINCT' }) });
    // 8. UNION vs UNION ALL
    if (model.setOps.some((x) => /union/.test(x) && !/all/.test(x))) { const rw = R.unionAll(sql);
      add('union-distinct', { severity: totalRows > o.largeRows ? 'medium' : 'low', changesResults: true, message: 'UNION' + (wh === 'bigquery' ? ' DISTINCT' : '') + ' sorts or hashes all rows to remove duplicates.',
        why: 'If the branches cannot overlap (different dates, sources or keys) or duplicates are fine, UNION ALL skips that work.',
        savings: saving(base, EN.costWith(ev.scan, ctx, { features: { distinct: model.scopes.some((s) => s.distinct) } })), rewrite: rw, fix: rw ? (s) => R.unionAll(s) : null, fixLabel: 'Use UNION ALL' }); }
    // 9. Correlated subqueries
    model.scopes.filter((s) => s.kind === 'subquery' && s.correlated.length && !/exists/.test(s.context || '')).forEach((s) => add('correlated-subquery', { severity: 'medium',
      message: 'A ' + (s.context === 'scalar' ? 'scalar ' : '') + 'subquery refers to the outer query (' + [...new Set(s.correlated.map((c) => c.col))].join(', ') + '), so it may run once per outer row.',
      why: 'Engines decorrelate simple cases, but complex ones become nested loops. Rewrite as a JOIN to a pre-aggregated subquery (GROUP BY the correlation key) or a window function.',
      savings: Object.assign(saving(base, EN.costWith(ev.scan, ctx, { features: { correlated: false } })) || {}, { note: 'as a join' }) }));
    // 10. NOT IN with nullable column
    model.scopes.forEach((s) => s.notIn.forEach((n) => {
      let nullable = null, colLabel = null;
      if (n.scopeId != null) { const sub = model.scopes[n.scopeId]; const op = sub.outputs[0];
        if (op && op.col) { const refs = sub.refIds.map((id) => model.refs[id]).filter((r) => r.table); for (const r of refs) { const c = C.column(r.table, op.col); if (c) { nullable = c.nullable !== false; colLabel = r.table.name + '.' + c.name; break; } } } }
      if (nullable === false) return;
      const rw = R.notInNotNull(sql); if (!rw) return;
      add('not-in-nullable', { severity: 'medium', message: n.left + ' NOT IN (subquery): ' + (colLabel ? colLabel + ' is nullable' : 'the subquery column may be NULL') + '. One NULL makes NOT IN return no rows at all.',
        why: 'NOT IN compares with every value; x NOT IN (1, NULL) is never true. Filter NULLs in the subquery or use NOT EXISTS, which most engines also run as an efficient anti-join.',
        rewrite: rw, fix: (q) => R.notInNotNull(q), fixLabel: 'Add IS NOT NULL in the subquery' });
    }));
    // 11. LIKE with leading wildcard
    model.scopes.forEach((s) => s.likes.filter((l) => /^%./.test(l.pattern)).forEach((l) => add('like-leading-wildcard', { severity: 'low',
      message: l.left + (l.not ? ' NOT' : '') + " LIKE '" + l.pattern + "' starts with a wildcard.",
      why: 'A leading % cannot use clustering, sort keys, zone maps or search indexes, so every value is checked. Anchor the pattern (\'abc%\'), filter on a normalized column, or use the engine\'s search feature (BigQuery SEARCH indexes, Snowflake search optimization).' })));
    // 12. Repeated CTE scans
    Object.entries(model.cteRefCounts || {}).forEach(([name, n]) => {
      if (n < 2) return; const cte = model.ctes[name]; const hasTables = model.refs.some((r) => r.scopeId === cte.scopeId && r.kind === 'table'); if (!hasTables) return;
      const sv = saving(base, EN.costWith(ev.scan, ctx, { noRepeat: true }));
      add('repeated-cte', { severity: sv && sv.perRun > 0 ? 'medium' : 'info', message: 'CTE ' + name + ' is referenced ' + n + ' times.',
        why: (wh === 'snowflake' ? 'Snowflake usually computes a repeated CTE once, but ' : 'BigQuery, Databricks, Redshift and Athena generally inline CTEs, so ') + 'each reference can rescan its tables. If it is expensive, materialize it once (temp table) or restructure so it is read once.' + (wh === 'bigquery' ? ' BigQuery on-demand bills each column once, so the bytes do not double, but slot time does.' : ''),
        savings: sv && sv.perRun > 0 ? Object.assign(sv, { note: 'if computed once' }) : null });
    });
    // 13. COUNT(DISTINCT)
    if (ev.scan.features.countDistinct && totalRows > o.largeRows / 10) { const rw = R.approxCountDistinct(sql, wh);
      add('count-distinct', { severity: totalRows > o.largeRows ? 'medium' : 'low', changesResults: true, message: 'Exact COUNT(DISTINCT) over about ' + Math.round(totalRows).toLocaleString('en-US') + ' rows.',
        why: 'Exact distinct counts must keep every value in memory. HyperLogLog functions are typically within about 1–2% and much cheaper; keep exact counts where precision matters (billing, finance).',
        savings: saving(base, EN.costWith(ev.scan, ctx, { features: { countDistinct: 0 } })), rewrite: rw, fix: rw ? (q) => R.approxCountDistinct(q, wh) : null, fixLabel: 'Use the approximate function' }); }
    // 14. Large IN lists
    model.scopes.forEach((s) => s.inLists.filter((l) => l.count > o.inListMax).forEach((l) => add('large-in-list', { severity: 'low',
      message: l.left + ' IN (…) lists ' + l.count + ' literal values.', why: 'Very long IN lists bloat query text and compile time and are hard to maintain. Put the values in a table (or a query parameter array with UNNEST) and join to it.' })));
    // 15. Implicit casts in joins
    model.scopes.forEach((s) => s.joins.forEach((j) => j.eqPairs.forEach(([a, b]) => {
      const ra = model.refs[a.refId], rb = model.refs[b.refId];
      const ca = ra && ra.table && C.column(ra.table, a.col), cb = rb && rb.table && C.column(rb.table, b.col);
      const explicit = a.fn === 'CAST' || b.fn === 'CAST' || /^(SAFE_CAST|TRY_CAST|TO_CHAR|TO_VARCHAR|STRING)$/.test(a.fn || b.fn || '');
      const fa = ca && C.typeFamily(ca.type), fb = cb && C.typeFamily(cb.type);
      if (!(explicit || (fa && fb && fa !== fb && fa !== 'unknown' && fb !== 'unknown'))) return;
      add('implicit-cast-join', { severity: 'medium', message: 'Join ' + (ca ? ra.table.name + '.' + ca.name + ' (' + ca.type + ')' : a.col) + ' = ' + (cb ? rb.table.name + '.' + cb.name + ' (' + cb.type + ')' : b.col) + (explicit ? ' casts a join key.' : ' compares different types.'),
        why: 'Casting a join key on every row slows hash joins, blocks join-key pruning, and can silently drop matches (e.g. \'007\' vs 7). Store keys with one type, or cast the smaller side once in a CTE.' });
    })));
    // 16. BigQuery: LIMIT does not reduce bytes
    if (wh === 'bigquery' && ctx.settings.bigquery.mode === 'ondemand' && mainScopes.some((s) => s.limit != null) && base.billedBytes > 100 * E.MiB && tables.length) {
      const big = tables.slice().sort((a, b) => b.bytesAfterCluster - a.bytesAfterCluster)[0]; const ref = refsOf(big.name)[0];
      const fix = (s) => R.tableSample(s, ref.name, ref.alias, 10); const rw = fix(sql);
      add('bq-limit-no-savings', { severity: 'medium', changesResults: true, message: 'LIMIT ' + mainScopes.find((s) => s.limit != null).limit + ' still bills all ' + E.fmtBytes(base.billedBytes) + ' on BigQuery.',
        why: 'BigQuery on-demand bills the columns read, not the rows returned. To explore data cheaply use the table preview (free), a partition filter, or TABLESAMPLE SYSTEM (n PERCENT), which reads only a share of storage blocks.',
        savings: Object.assign(saving(base, EN.costWith(ev.scan, ctx, { tables: { [big.name]: 0.1 } })) || {}, { note: 'with a 10% TABLESAMPLE on ' + big.name }), rewrite: rw, fix: rw ? fix : null, fixLabel: 'Sample 10% of ' + big.name });
    }
    out.forEach((f, i) => { f.id = f.rule + '-' + i; });
    return out.sort((a, b) => SEV[b.severity] - SEV[a.severity] || ((b.savings && b.savings.perRun) || 0) - ((a.savings && a.savings.perRun) || 0));
  }
  // Apply the selected fixes in order and re-estimate. Fixes re-locate their targets in the current text.
  function optimize(ev, findings, ctx, selected) {
    let sql = ev.sql; const applied = [], skipped = [];
    findings.filter((f) => f.fix && (!selected || selected.has(f.id))).forEach((f) => { let next = null; try { next = f.fix(sql); } catch (e) { next = null; } if (next && next !== sql) { sql = next; applied.push(f); } else skipped.push(f); });
    const after = applied.length ? EN.evaluate(sql, ctx) : ev;
    return { sql, applied, skipped, after, delta: { perRun: ev.cost.cost - after.cost.cost, perMonth: ev.cost.perMonth - after.cost.perMonth } };
  }
  return { run, optimize, RULES, SEV, recentFilter };
});

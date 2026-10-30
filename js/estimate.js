/* QueryCost estimator: partition and cluster pruning, bytes read per table, and the per-warehouse cost models.
   All results are estimates from catalog sizes and the editable assumptions in pricing.js. */
(function (root, factory) {
  const isNode = typeof require === 'function' && typeof module === 'object';
  const m = factory(isNode ? require('./catalog.js') : root.QC.catalog, isNode ? require('./analyze.js') : root.QC.analyze, isNode ? require('./pricing.js') : root.QC.pricing);
  if (isNode) module.exports = m; else (root.QC = root.QC || {}).estimate = m;
})(typeof self !== 'undefined' ? self : this, function (C, A, PR) {
  'use strict';
  const MiB = 1024 * 1024, GiB = 1024 ** 3, TiB = 1024 ** 4;
  const DAY = 86400000;
  const parseDate = (v) => { const m = String(v == null ? '' : v).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}))?/); if (!m) { const y = String(v).match(/^(\d{4})(\d{2})(\d{2})$/); return y ? Date.UTC(+y[1], +y[2] - 1, +y[3]) : null; } return Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0); };
  const unitMs = { day: DAY, hour: 3600000 };
  // Partition window: list of partition start times (ms) for time-unit partitioning.
  function partitionRange(p, today) {
    const end = parseDate(p.end || today) || parseDate(today);
    const g = p.granularity; const n = p.count;
    const step = (t, k) => { const d = new Date(t); if (g === 'month') d.setUTCMonth(d.getUTCMonth() + k); else if (g === 'year') d.setUTCFullYear(d.getUTCFullYear() + k); else return t + k * unitMs[g]; return d.getTime(); };
    let e = end; if (g === 'month') { const d = new Date(end); e = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); } if (g === 'year') e = Date.UTC(new Date(end).getUTCFullYear(), 0, 1);
    if (g === 'hour') e = end + 23 * 3600000;
    return { start: step(e, -(n - 1)), end: e, step };
  }
  // How many partitions fall in [lo, hi] (ms, inclusive; null = open).
  function countIn(range, lo, hi, g) {
    let k = 0; let t = range.start;
    const bucket = (ms) => { if (ms == null) return null; const d = new Date(ms); if (g === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); if (g === 'year') return Date.UTC(d.getUTCFullYear(), 0, 1); if (g === 'hour') return Math.floor(ms / 3600000) * 3600000; return Math.floor(ms / DAY) * DAY; };
    const L = bucket(lo), H = bucket(hi);
    for (let i = 0; i < 100000 && t <= range.end; i++) { if ((L == null || t >= L) && (H == null || t <= H)) k++; t = range.step(t, 1); }
    return k;
  }
  // Treat DATE(ts) / CAST(ts AS DATE) / *_TRUNC(ts, DAY) as prunable on a time partition; other wrappers are not.
  // BigQuery also prunes through EXTRACT(YEAR|DATE ...) and *_TRUNC to a coarser unit (documented in "Query partitioned tables").
  const GRAN_ORDER = ['hour', 'day', 'week', 'month', 'quarter', 'year'];
  const truncPart = (pred) => String(pred.part || '').toLowerCase().replace(/'/g, '');
  function bqUnwrappable(pred, table) {
    if (!pred.fn) return false;
    if (pred.fn === 'EXTRACT') return /^(year|date)$/.test(truncPart(pred));
    if (/^(DATE_TRUNC|TIMESTAMP_TRUNC|DATETIME_TRUNC)$/.test(pred.fn)) { const p = truncPart(pred); return GRAN_ORDER.includes(p) && GRAN_ORDER.indexOf(p) >= GRAN_ORDER.indexOf(table.partition.granularity === 'value' ? 'year' : table.partition.granularity); }
    return false;
  }
  function prunableWrapper(pred, table, wh) {
    if (!pred.fn) return true;
    const col = C.column(table, pred.column); const isTime = col && /time|date/i.test(col.type);
    if (!isTime) return false;
    if (wh === 'bigquery' && bqUnwrappable(pred, table)) return true;
    if (pred.fn === 'DATE' || (pred.fn === 'CAST' && /^date/.test(pred.castTo || '')) || pred.fn === 'TO_DATE') return table.partition.granularity !== 'hour' || false;
    if (/^(DATE_TRUNC|TIMESTAMP_TRUNC|DATETIME_TRUNC|TRUNC)$/.test(pred.fn)) return String(pred.part || '').toLowerCase().replace(/'/g, '') === table.partition.granularity;
    return false;
  }
  // Fraction of partitions read for one predicate set. Returns { fraction, read, total, reason, wrapped }.
  function partitionFraction(table, preds, today, M, wh) {
    const p = table.partition; if (!p) return { fraction: 1, read: null, total: null, reason: 'not partitioned' };
    const total = p.count; const g = p.granularity; const on = preds.filter((x) => (x.op === 'OR' ? x.parts.every((y) => y && y.column === p.column) : x.column === p.column)); // an OR with any other branch can't prune
    if (!on.length) return { fraction: 1, read: total, total, reason: 'no filter on partition column ' + p.column };
    const wrapped = on.filter((x) => x.op !== 'OR' && x.fn && !prunableWrapper(x, table, wh));
    const usable = on.filter((x) => x.op === 'OR' ? x.parts.every((y) => !y.fn || prunableWrapper(y, table, wh)) : (!x.fn || prunableWrapper(x, table, wh)));
    if (!usable.length) return { fraction: 1, read: total, total, reason: 'filter wraps ' + p.column + ' in ' + wrapped[0].fn + '(), which blocks pruning', wrapped: true };
    const range = g === 'value' ? null : partitionRange(p, today);
    const valMs = (v) => (v && v.kind === 'ms' ? v.value : (v && (v.kind === 'lit' || v.kind === 'rel') ? parseDate(v.value) : null));
    // EXTRACT(YEAR FROM c) = 2026 or DATE_TRUNC(c, MONTH) >= '2026-09-01' -> plain bounds on c (BigQuery only).
    const unwrap = (x) => {
      if (x.fn === 'EXTRACT' && truncPart(x) === 'date') return Object.assign({}, x, { fn: null });
      if (!(wh === 'bigquery' && bqUnwrappable(x, table))) return x;
      const isYear = x.fn === 'EXTRACT'; const unit = isYear ? 'year' : truncPart(x);
      const start = (v) => { if (isYear) { const y = Number(v && v.value); return Number.isFinite(y) ? Date.UTC(y, 0, 1) : null; } return valMs(v); };
      const next = (ms) => { const d = new Date(ms); if (unit === 'year') return Date.UTC(d.getUTCFullYear() + 1, 0, 1); if (unit === 'quarter') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 1); if (unit === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); if (unit === 'week') return ms + 7 * DAY; if (unit === 'hour') return ms + 3600000; return ms + DAY; };
      const ms = (v) => ({ kind: 'ms', value: v });
      const s0 = start(x.values[0]); if (s0 == null) return Object.assign({}, x, { fn: null });
      if (x.op === '=') return Object.assign({}, x, { fn: null, op: 'BETWEEN', values: [ms(s0), ms(next(s0) - 1)] });
      if (x.op === '>=') return Object.assign({}, x, { fn: null, values: [ms(s0)] });
      if (x.op === '>') return Object.assign({}, x, { fn: null, op: '>=', values: [ms(next(s0))] });
      if (x.op === '<') return Object.assign({}, x, { fn: null, op: '<=', values: [ms(s0 - 1)] });
      if (x.op === '<=') return Object.assign({}, x, { fn: null, values: [ms(next(s0) - 1)] });
      if (x.op === 'BETWEEN') { const s1 = start(x.values[1]); return s1 == null ? x : Object.assign({}, x, { fn: null, values: [ms(s0), ms(next(s1) - 1)] }); }
      return x;
    };
    let lo = null, hi = null, set = null, guess = false, reasons = [];
    // BigQuery documents that filters on subqueries or other non-constant expressions do not prune; other engines may prune at run time.
    let bqDynamic = false;
    const dyn = (note) => { if (wh === 'bigquery') { bqDynamic = true; return { frac: 1 }; } guess = true; return note ? { frac: M.unknownRangeKeep, note } : { frac: M.unknownRangeKeep }; };
    const one = (x0) => { // returns {count} for eq/in, or updates bounds
      const x = x0.fn ? unwrap(x0) : x0; const op = x.op;
      if (op === '=' || op === 'IN') {
        const vals = x.values.filter((v) => v && v.kind !== 'subquery');
        if (x.values.some((v) => v && v.kind === 'subquery')) return dyn('IN (subquery) on ' + p.column + ': dynamic pruning assumed');
        if (g === 'value') return { count: Math.min(total, vals.length || 1) };
        const ms = vals.map(valMs);
        if (ms.some((v) => v == null)) return dyn();
        return { count: new Set(ms.map((t) => countIn(range, t, t, g) ? t : null).filter((t) => t != null)).size };
      }
      if (/^(>|>=|<|<=|BETWEEN)$/.test(op)) {
        if (g === 'value') { guess = true; return { frac: M.unknownRangeKeep }; }
        if (op === 'BETWEEN') { const a = valMs(x.values[0]), b = valMs(x.values[1]); if (a == null || b == null) return dyn(); return { lo: a, hi: b }; }
        const v = valMs(x.values[0]); if (v == null) return dyn();
        if (op === '>' && g === 'day') return { lo: v + DAY }; if (op === '>' || op === '>=') return { lo: v };
        if (op === '<') return { hi: v - (g === 'day' ? DAY : 1) }; return { hi: v }; // '<' excludes the bucket that starts at v
      }
      return null;
    };
    let fracMin = 1;
    usable.forEach((x) => {
      if (x.op === 'OR') {
        let sum = 0; x.parts.forEach((y) => { const r = one(y); if (!r) { sum += total; return; } if (r.count != null) sum += r.count; else if (r.frac != null) sum += r.frac * total; else sum += countIn(range, r.lo != null ? r.lo : null, r.hi != null ? r.hi : null, g); });
        fracMin = Math.min(fracMin, Math.min(1, sum / total)); reasons.push('OR filter on ' + p.column); return;
      }
      const r = one(x); if (!r) return;
      if (r.count != null) set = set == null ? r.count : Math.min(set, r.count);
      if (r.frac != null) fracMin = Math.min(fracMin, r.frac);
      if (r.lo != null) lo = lo == null ? r.lo : Math.max(lo, r.lo);
      if (r.hi != null) hi = hi == null ? r.hi : Math.min(hi, r.hi);
    });
    let read = total;
    if (lo != null || hi != null) read = countIn(range, lo, hi, g);
    if (set != null) read = Math.min(read, set);
    read = Math.min(read, Math.round(total * fracMin) || (fracMin < 1 ? 1 : total));
    if (fracMin < 1 && set == null && lo == null && hi == null) read = Math.max(1, Math.round(total * fracMin));
    const fraction = total ? Math.max(0, read) / total : 1;
    return { fraction, read: Math.max(0, read), total, reason: (bqDynamic && fraction === 1 ? 'BigQuery does not prune on a subquery or non-constant filter' : guess ? 'filter bounds not literal: assumed ' + Math.round(M.unknownRangeKeep * 100) + '% kept' : 'pruned by filter on ' + p.column) + (reasons.length ? ' (' + reasons.join(', ') + ')' : ''), guessed: guess };
  }
  // Block pruning from filters on clustering columns (first column matters most).
  function clusterKeep(table, preds, M) {
    if (!table.cluster.length) return { keep: 1, reason: '' };
    const on = (c) => preds.filter((x) => x.column === c && !x.fn && x.op !== 'OR' && !/^NOT|<>|!=/.test(x.op));
    const first = on(table.cluster[0]);
    if (first.length) {
      const eq = first.find((x) => x.op === '=' || x.op === 'IN');
      if (eq) { const k = Math.min(1, M.clusterEqKeep * Math.max(1, eq.op === 'IN' ? eq.values.length : 1)); return { keep: k, reason: 'equality on first cluster column ' + table.cluster[0] }; }
      return { keep: M.clusterRangeKeep, reason: 'range on first cluster column ' + table.cluster[0] };
    }
    const later = table.cluster.slice(1).find((c) => on(c).length);
    return later ? { keep: M.clusterSecondaryKeep, reason: 'filter on later cluster column ' + later + ' only' } : { keep: 1, reason: 'no filter on cluster columns' };
  }
  // Query shape features that drive the runtime heuristic. Row explosion needs uniqueness info in the catalog.
  function features(model) {
    const f = { joins: 0, aggregates: 0, sort: false, distinct: false, windows: 0, cross: false, correlated: false, explosion: false, explosionPairs: [], countDistinct: 0 };
    model.scopes.forEach((s) => {
      f.joins += s.joins.length; f.aggregates += s.aggregates + (s.groupBy ? 1 : 0); if (s.orderBy) f.sort = true; if (s.distinct) f.distinct = true; f.windows += s.windowFns;
      f.countDistinct += (s.countDistinct || []).length;
      s.joins.forEach((j) => {
        const r = model.refs[j.refId]; if (r && r.kind === 'other') return;
        if (/cross/.test(j.type || '') || !j.hasCondition) f.cross = true;
        j.eqPairs.forEach(([a, b]) => { const p = manyToMany(model, a, b); if (p) { f.explosion = true; f.explosionPairs.push(p); } });
      });
      if (s.correlated.length && !/exists/.test(s.context || '')) f.correlated = true;
    });
    if (model.setOps.some((o) => !/all/.test(o))) f.distinct = true;
    return f;
  }
  const hasKeys = (t) => t && t.columns.some((c) => c.unique);
  function manyToMany(model, a, b) {
    const ra = model.refs[a.refId], rb = model.refs[b.refId];
    if (!ra || !rb || ra.kind !== 'table' || rb.kind !== 'table' || !ra.table || !rb.table) return null;
    if (!hasKeys(ra.table) || !hasKeys(rb.table)) return null;
    const ca = C.column(ra.table, a.col), cb = C.column(rb.table, b.col); if (!ca || !cb || ca.unique || cb.unique) return null;
    return { left: ra.table.name + '.' + ca.name, right: rb.table.name + '.' + cb.name, leftRef: ra.id, rightRef: rb.id };
  }
  // How many times a scope is evaluated when engines inline CTEs (each consumer re-runs it).
  function evals(model, sid, depth) {
    const S = model.scopes[sid]; if (!S || (depth || 0) > 8) return 1;
    if (S.kind === 'cte') { const cons = A.consumersOf(model, S); return Math.max(1, cons.reduce((n, r) => n + evals(model, r.scopeId, (depth || 0) + 1), 0)); }
    if (S.parentId != null) return evals(model, S.parentId, (depth || 0) + 1);
    if (S.kind === 'union' && S.outputOf != null) return evals(model, S.outputOf, (depth || 0) + 1);
    return 1;
  }
  // Per-table scan summary (warehouse independent).
  function scan(analysis, catalog, settings, today, wh) {
    const model = analysis.model; const M = settings.model; today = today || new Date().toISOString().slice(0, 10);
    const byTable = new Map(); const unknown = [];
    model.refs.filter((r) => r.kind === 'table').forEach((r) => {
      if (!r.table) { unknown.push(r.name); return; }
      const key = r.table.name; if (!byTable.has(key)) byTable.set(key, { table: r.table, refs: [], cols: new Set(), all: false, best: null, reads: 0 });
      const e = byTable.get(key); e.refs.push(r.id); e.reads += evals(model, r.scopeId);
      const need = A.neededCols(model, r);
      if (need === 'ALL' || !r.table.columns.length) e.all = true; else need.forEach((c) => { if (C.column(r.table, c)) e.cols.add(c); });
      A.predSets(model, r).forEach((ps) => {
        const pf = partitionFraction(r.table, ps, today, M, wh); const ck = clusterKeep(r.table, ps, M);
        const prod = pf.fraction * ck.keep;
        if (!e.best || prod > e.best.prod || (prod === e.best.prod && pf.fraction > e.best.pf.fraction)) e.best = { pf, ck, prod };
      });
    });
    const tables = [...byTable.values()].map((e) => {
      const t = e.table; const scale = C.scaleOf(t);
      const colsRead = e.all ? t.columns.map((c) => c.name) : t.columns.filter((c) => e.cols.has(c.name)).map((c) => c.name);
      const full = C.tableBytes(t);
      const colBytes = !t.columns.length ? full : colsRead.reduce((s, c) => s + C.columnBytes(t, c), 0);
      const pf = e.best.pf, ck = e.best.ck;
      const afterPartition = colBytes * pf.fraction;
      return {
        name: t.name, rows: t.rows, rowsGuessed: t.rowsGuessed, totalBytes: full, compression: t.compression, allColumns: e.all, noColumnInfo: !t.columns.length,
        columnsRead: colsRead.map((c) => ({ name: c, bytes: C.columnBytes(t, c) })), columnsTotal: t.columns.length,
        columnBytes: colBytes, partition: pf, cluster: ck, bytesAfterPartition: afterPartition, bytesAfterCluster: afterPartition * ck.keep,
        rowsScanned: t.rows * pf.fraction * ck.keep, refs: e.refs.length, reads: e.reads, scale,
      };
    });
    return { tables, unknown: [...new Set(unknown)], features: features(model) };
  }
  function workFactor(f, M) {
    let w = 1 + f.joins * M.joinFactor + (f.aggregates ? M.aggFactor : 0) + (f.sort ? M.sortFactor : 0) + (f.distinct ? M.distinctFactor : 0) + (f.windows ? M.windowFactor : 0) + (f.countDistinct ? M.countDistinctFactor : 0);
    if (f.explosion) w *= M.explosionFactor; if (f.cross) w *= M.crossJoinFactor; if (f.correlated) w *= M.correlatedFactor;
    return w;
  }
  const ceilMB = (b) => Math.ceil(b / MiB) * MiB;
  const fmtSec = (s) => (s < 60 ? s.toFixed(1) + ' s' : (s / 60).toFixed(1) + ' min');
  // Cost of one run on one warehouse.
  function cost(sc, settings, wh) {
    const M = settings.model; const work = workFactor(sc.features, M);
    const logical = (useCluster) => sc.tables.reduce((s, t) => s + (useCluster ? t.bytesAfterCluster : t.bytesAfterPartition), 0);
    // Engines that inline CTEs and rescan for self-joins read a table once per reference evaluation; Snowflake reuses CTE results.
    const times = (t) => (wh === 'snowflake' ? t.refs : (t.reads || 1));
    const compressed = (useCluster) => sc.tables.reduce((s, t) => s + times(t) * (useCluster ? t.bytesAfterCluster : t.bytesAfterPartition) / t.compression, 0);
    const out = { warehouse: wh, steps: [], work };
    if (wh === 'bigquery') {
      const B = settings.bigquery;
      const perTable = sc.tables.map((t) => ({ name: t.name, upper: t.bytesAfterPartition, expected: B.useClustering ? t.bytesAfterCluster : t.bytesAfterPartition }));
      const nRefTables = sc.tables.length + sc.unknown.length;
      const billedTable = (b) => Math.max(B.minTableMB * MiB, ceilMB(b));
      let billed = perTable.reduce((s, t) => s + billedTable(t.expected), 0) + sc.unknown.length * B.minTableMB * MiB;
      billed = Math.max(billed, B.minQueryMB * MiB);
      const upper = Math.max(perTable.reduce((s, t) => s + billedTable(t.upper), 0) + sc.unknown.length * B.minTableMB * MiB, B.minQueryMB * MiB);
      out.scanBytes = logical(B.useClustering); out.billedBytes = billed; out.upperBytes = upper;
      if (B.mode === 'editions') {
        const slotSec = (out.scanBytes / GiB) * B.slotSecPerGiB * work; const price = B.slotHour[B.edition];
        out.slotSeconds = slotSec; out.cost = slotSec / 3600 * price; out.unit = 'slot-hours';
        out.steps.push(fmtBytes(out.scanBytes) + ' scanned × ' + B.slotSecPerGiB + ' slot-s/GiB × work ' + work.toFixed(2) + ' = ' + (slotSec / 3600).toFixed(4) + ' slot-hours');
        out.steps.push((slotSec / 3600).toFixed(4) + ' slot-hours × $' + price + '/slot-hour (' + B.edition.replace('_', ' ') + ')');
      } else {
        out.cost = billed / TiB * B.perTiB; out.unit = 'bytes billed';
        out.steps.push('Bytes billed: ' + nRefTables + ' table(s), each rounded up to the MB with a ' + B.minTableMB + ' MB minimum = ' + fmtBytes(billed));
        out.steps.push(fmtBytes(billed) + ' ÷ 1 TiB × $' + B.perTiB + '/TiB');
        if (B.useClustering && upper !== billed) out.steps.push('Dry run would report up to ' + fmtBytes(upper) + ' (cluster pruning only shows up after the query runs)');
      }
      return out;
    }
    if (wh === 'athena') {
      const T = settings.athena; const scanB = compressed(false); const billed = Math.max(T.minMB * 1e6, Math.ceil(scanB / 1e6) * 1e6);
      out.scanBytes = scanB; out.billedBytes = billed; out.cost = billed / 1e12 * T.perTB; out.unit = 'data scanned';
      out.steps.push('Compressed columnar bytes after partition pruning: ' + fmtBytes(scanB) + ' (logical ÷ compression ratio)');
      out.steps.push('Rounded up to the MB, ' + T.minMB + ' MB minimum: ' + fmtBytes(billed, true) + ' × $' + T.perTB + '/TB');
      return out;
    }
    const scanB = compressed(true); out.scanBytes = scanB; const gb = scanB / 1e9;
    const runtime = (gbps) => M.overheadSec + (gb / gbps) * work;
    if (wh === 'snowflake') {
      const S = settings.snowflake; const idx = PR.SF_SIZES.indexOf(S.size); const mult = Math.pow(2, Math.max(0, idx));
      const credits = S.credits[S.size] * (S.gen2 ? S.gen2Multiplier : 1); const gbps = S.gbpsXS * mult * (S.gen2 ? S.gen2Speedup : 1);
      const rt = runtime(gbps); const billedSec = Math.max(rt, S.coldStart ? S.minSeconds : 0) + S.idleSeconds; const price = S.creditPrice[S.edition];
      out.runtimeSec = rt; out.billedSec = billedSec; out.credits = credits * billedSec / 3600; out.cost = out.credits * price; out.unit = 'credits';
      out.steps.push(fmtBytes(scanB) + ' scanned at ~' + gbps.toFixed(2) + ' GB/s (' + S.size + (S.gen2 ? ' Gen2' : '') + ') × work ' + work.toFixed(2) + ' + ' + M.overheadSec + ' s overhead ≈ ' + fmtSec(rt));
      out.steps.push('Billed ' + fmtSec(billedSec) + (S.coldStart && rt < S.minSeconds ? ' (60-second minimum on resume)' : '') + (S.idleSeconds ? ' incl. ' + S.idleSeconds + ' s idle' : ''));
      out.steps.push(credits + ' credits/hour × ' + (billedSec / 3600).toFixed(4) + ' h × $' + price + '/credit (' + S.edition.replace('_', ' ') + ')');
      return out;
    }
    if (wh === 'databricks') {
      const D = settings.databricks; const dbu = D.dbu[D.size]; const gbps = D.gbpsPerDbu * dbu * (D.typeSpeed[D.type] || 1);
      const rt = runtime(gbps); const billedSec = rt + D.idleSeconds; const rate = dbu * D.dbuPrice[D.type] + (D.type === 'serverless' ? 0 : dbu * D.vmPerDbuHour);
      out.runtimeSec = rt; out.billedSec = billedSec; out.dbus = dbu * billedSec / 3600; out.cost = rate * billedSec / 3600; out.unit = 'DBUs';
      out.steps.push(fmtBytes(scanB) + ' scanned at ~' + gbps.toFixed(2) + ' GB/s (' + D.size + ', ' + D.type + ') × work ' + work.toFixed(2) + ' + ' + M.overheadSec + ' s ≈ ' + fmtSec(rt));
      out.steps.push(dbu + ' DBU/hour × $' + D.dbuPrice[D.type] + '/DBU' + (D.type === 'serverless' ? ' (compute included)' : ' + ~$' + (dbu * D.vmPerDbuHour).toFixed(2) + '/hour cloud VMs') + ' × ' + fmtSec(billedSec));
      return out;
    }
    if (wh === 'redshift') {
      const R = settings.redshift;
      if (R.mode === 'provisioned') {
        const gbps = R.nodeGbps[R.nodeType] * R.nodes; const rt = runtime(gbps); const rate = R.nodePrice[R.nodeType] * R.nodes;
        out.runtimeSec = rt; out.billedSec = rt; out.cost = rate * rt / 3600; out.unit = 'node-hours';
        out.steps.push(fmtBytes(scanB) + ' scanned at ~' + gbps.toFixed(2) + ' GB/s (' + R.nodes + '× ' + R.nodeType + ') × work ' + work.toFixed(2) + ' ≈ ' + fmtSec(rt));
        out.steps.push(R.nodes + ' nodes × $' + R.nodePrice[R.nodeType] + '/node-hour × ' + fmtSec(rt) + ' (share of an always-on cluster)');
        return out;
      }
      const gbps = R.gbpsPerRpu * R.rpu; const rt = runtime(gbps); const billedSec = Math.max(rt, R.applyMinimum ? R.minSeconds : 0) + R.idleSeconds;
      out.runtimeSec = rt; out.billedSec = billedSec; out.rpuHours = R.rpu * billedSec / 3600; out.cost = out.rpuHours * R.rpuHour; out.unit = 'RPU-hours';
      out.steps.push(fmtBytes(scanB) + ' scanned at ~' + gbps.toFixed(2) + ' GB/s (' + R.rpu + ' RPU) × work ' + work.toFixed(2) + ' ≈ ' + fmtSec(rt));
      out.steps.push(R.rpu + ' RPU × ' + fmtSec(billedSec) + (R.applyMinimum && rt < R.minSeconds ? ' (60-second minimum)' : '') + ' × $' + R.rpuHour + '/RPU-hour');
      return out;
    }
    throw new Error('Unknown warehouse ' + wh);
  }
  function fmtBytes(b, decimal) {
    if (!Number.isFinite(b)) return '—';
    const base = decimal ? 1000 : 1024; const units = decimal ? ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] : ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    let i = 0; let v = b; while (v >= base && i < units.length - 1) { v /= base; i++; }
    return (v >= 100 || i === 0 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' ' + units[i];
  }
  function fmtMoney(x) {
    if (!Number.isFinite(x)) return '—';
    if (x === 0) return '$0';
    if (x < 0.01) return '$' + x.toFixed(x < 0.0001 ? 6 : 4);
    if (x < 1) return '$' + x.toFixed(3);
    return '$' + x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // Monthly projection with the optional BigQuery free tier (1 TiB/month per billing account).
  function monthly(c, proj, settings) {
    if (c.warehouse === 'bigquery' && settings.bigquery.mode === 'ondemand' && settings.bigquery.applyFreeTier) {
      const bytes = c.billedBytes * proj.runsMonth; const free = settings.bigquery.freeTiB * TiB;
      return Math.max(0, bytes - free) / TiB * settings.bigquery.perTiB;
    }
    return proj.perMonth;
  }
  return { scan, cost, monthly, partitionFraction, clusterKeep, workFactor, features, fmtBytes, fmtMoney, MiB, GiB, TiB };
});

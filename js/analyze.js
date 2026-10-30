/* QueryCost analyzer: turns SQL into a small "query model" (scopes, table references, columns read,
   filter predicates, joins, set operations) used by the estimator and the lint rules.
   Primary path walks a node-sql-parser AST; if no grammar accepts the SQL, a token-based fallback
   builds a coarser model and the result is flagged approximate. */
(function (root, factory) {
  const isNode = typeof require === 'function' && typeof module === 'object';
  const m = factory(isNode ? require('./sqlutil.js') : root.QC.sqlutil, isNode ? require('./catalog.js') : root.QC.catalog);
  if (isNode) module.exports = m; else (root.QC = root.QC || {}).analyze = m;
})(typeof self !== 'undefined' ? self : this, function (U, C) {
  'use strict';
  const JOIN_KW = new Set(['cross', 'natural', 'left', 'right', 'inner', 'full', 'join', 'outer', 'on', 'using', 'where', 'semi', 'anti', 'lateral']);
  const lc = (s) => String(s == null ? '' : s).toLowerCase();
  function colName(n) {
    if (!n) return '';
    const c = n.column;
    if (typeof c === 'string') return lc(U.unquote(c));
    if (c && c.expr) return lc(U.unquote(c.expr.value != null ? c.expr.value : ''));
    return '';
  }
  function fnName(n) {
    if (!n || !n.name) return '';
    if (typeof n.name === 'string') return n.name.toUpperCase();
    const parts = (n.name.name || []).map((x) => x.value);
    if (!parts.length && n.name.schema) parts.push(n.name.schema.value);
    return parts.join('.').toUpperCase();
  }
  const subAst = (n) => (n && n.ast && n.ast.type === 'select' ? n.ast : (n && n.type === 'select' ? n : null));
  const SKIP = new Set(['loc', 'tableList', 'columnList', 'surround', 'collate']);
  // Visit every node of an expression without entering nested SELECTs (reported through onSub).
  function walk(node, visit, onSub, ctx) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((x) => walk(x, visit, onSub, ctx)); return; }
    const sa = subAst(node);
    if (sa) { onSub(sa, ctx || 'scalar'); return; }
    if (visit(node, ctx) === false) return;
    for (const k of Object.keys(node)) { if (SKIP.has(k)) continue; const v = node[k]; if (v && typeof v === 'object') walk(v, visit, onSub, ctx); }
  }
  function literal(n) {
    if (!n) return null;
    if (/string$/.test(n.type) || n.type === 'date' || n.type === 'timestamp' || n.type === 'datetime') return { kind: 'lit', value: String(n.value) };
    if (n.type === 'number') return { kind: 'lit', value: n.value };
    if (n.type === 'bool' || n.type === 'boolean') return { kind: 'lit', value: n.value };
    return null;
  }
  // Compact text for an expression, used for relative-date detection and for showing predicates.
  function text(n) {
    if (n == null) return '';
    if (typeof n !== 'object') return String(n);
    if (Array.isArray(n)) return n.map(text).join(', ');
    switch (n.type) {
      case 'column_ref': return (n.table ? n.table + '.' : '') + colName(n);
      case 'number': return String(n.value);
      case 'single_quote_string': case 'string': case 'double_quote_string': case 'natural_string': return "'" + n.value + "'";
      case 'date': case 'timestamp': case 'datetime': return n.type.toUpperCase() + " '" + n.value + "'";
      case 'function': return fnName(n) + '(' + text(n.args && n.args.value) + ')';
      case 'aggr_func': return n.name + '(' + text(n.args && n.args.expr) + ')';
      case 'binary_expr': return text(n.left) + ' ' + n.operator + ' ' + text(n.right);
      case 'interval': return 'INTERVAL ' + text(n.expr) + ' ' + (n.unit || '');
      case 'cast': return 'CAST(' + text(n.expr) + ' AS ' + ((n.target && n.target[0] && n.target[0].dataType) || '') + ')';
      case 'extract': return 'EXTRACT(' + (n.args && n.args.field) + ' FROM ' + text(n.args && n.args.source) + ')';
      case 'expr_list': return text(n.value);
      default: return n.value != null ? String(n.value) : (n.type || '');
    }
  }
  const REL_RE = /(current_date|current_timestamp|now\s*\(|getdate|sysdate|sysdatetime|current_datetime|localtimestamp|today\s*\()/i;
  // Resolve a relative date expression like DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY) to an ISO date.
  function relDate(t, today) {
    if (!REL_RE.test(t)) return null;
    const d = new Date(today + 'T00:00:00Z');
    const m = t.match(/(-?\d+)\s*'?\s*(day|week|month|year|hour)s?\b/i) || t.match(/\b(day|week|month|year|hour)s?\s*'?\s*,\s*(-?\d+)/i) || t.match(/'\s*(-?\d+)\s+(day|week|month|year|hour)s?\s*'/i);
    let n = 0, unit = 'day';
    if (m) { if (/^\D/.test(m[1])) { unit = m[1].toLowerCase(); n = Number(m[2]); } else { n = Number(m[1]); unit = m[2].toLowerCase(); } }
    else { const k = t.match(/[-+,]\s*(\d+)\s*\)?\s*$/); if (k) n = Number(k[1]); }
    n = Math.abs(n);
    if (unit === 'week') { n *= 7; unit = 'day'; }
    if (unit === 'day') d.setUTCDate(d.getUTCDate() - n);
    else if (unit === 'month') d.setUTCMonth(d.getUTCMonth() - n);
    else if (unit === 'year') d.setUTCFullYear(d.getUTCFullYear() - n);
    else if (unit === 'hour') d.setUTCHours(d.getUTCHours() - n);
    return d.toISOString().slice(0, 10);
  }
  function valueOf(n, today) {
    const l = literal(n); if (l) return l;
    if (n && n.type === 'cast') { const inner = literal(n.expr); if (inner) return inner; }
    if (n && n.type === 'function' && /^(DATE|TIMESTAMP|DATETIME|TO_DATE|TO_TIMESTAMP)$/.test(fnName(n)) && n.args && n.args.value && n.args.value.length === 1) { const inner = literal(n.args.value[0]); if (inner) return inner; }
    if (n && n.type === 'column_ref') return { kind: 'col', value: text(n) };
    if (n && subAst(n)) return { kind: 'subquery' };
    const t = text(n); const r = relDate(t, today);
    return r ? { kind: 'rel', value: r, text: t } : { kind: 'expr', text: t };
  }
  // Pull the column a predicate tests, noting any function or cast wrapped around it.
  function target(n) {
    if (!n) return null;
    if (n.type === 'column_ref' && colName(n) !== '*') return { node: n, fn: null };
    if (n.type === 'cast' && n.expr && n.expr.type === 'column_ref') return { node: n.expr, fn: 'CAST', castTo: lc((n.target && n.target[0] && n.target[0].dataType) || '') };
    if (n.type === 'extract' && n.args && n.args.source && n.args.source.type === 'column_ref') return { node: n.args.source, fn: 'EXTRACT', part: lc(n.args.field) };
    if (n.type === 'function' && n.args && n.args.value) {
      const UNIT = /^(year|quarter|month|week|day|hour|minute|second)$/i;
      const isUnit = (a) => a && ((a.type === 'origin' || a.type === 'default') && UNIT.test(String(a.value)) || (a.type === 'column_ref' && !a.table && UNIT.test(colName(a))));
      const cols = n.args.value.filter((a) => a && a.type === 'column_ref' && !isUnit(a));
      if (cols.length === 1) { const lits = n.args.value.filter((a) => literal(a)).map((a) => lc(literal(a).value)); const u = n.args.value.find(isUnit); return { node: cols[0], fn: fnName(n), part: lits[0] || (u ? lc(u.type === 'column_ref' ? colName(u) : u.value) : '') }; }
    }
    return null;
  }
  const FLIP = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '=': '=', '!=': '!=', '<>': '<>' };
  const splitAnd = (e) => (!e ? [] : (e.type === 'binary_expr' && /^and$/i.test(e.operator) ? splitAnd(e.left).concat(splitAnd(e.right)) : [e]));
  const splitOr = (e) => (e && e.type === 'binary_expr' && /^or$/i.test(e.operator) ? splitOr(e.left).concat(splitOr(e.right)) : [e]);

  function analyzeAst(stmts, cat, opts) {
    const today = opts.today;
    const scopes = []; const refs = []; const ctes = {}; const setOps = []; const unresolved = [];
    function newScope(kind, parent, extra) { const s = Object.assign({ id: scopes.length, kind, parentId: parent ? parent.id : null, refIds: [], joins: [], conjuncts: [], orderBy: false, limit: null, distinct: false, groupBy: false, aggregates: 0, countDistinct: [], windowFns: 0, correlated: [], subqueries: [], outputs: [], starRefs: [], starAll: false, colRefs: [], hasWhere: false, notIn: [], likes: [], inLists: [], name: null, castJoin: [] }, extra || {}); scopes.push(s); return s; }
    function addRef(scope, r) { r.id = refs.length; r.scopeId = scope.id; r.cols = new Set(); r.passCols = new Map(); r.star = false; r.preds = []; refs.push(r); scope.refIds.push(r.id); return r; }
    const scopeRefs = (s) => s.refIds.map((i) => refs[i]);
    const refMatches = (r, q) => { const ql = lc(U.unquote(q)); if (r.alias) return r.alias === ql; const n = r.name || ''; return n === ql || n.split('.').pop() === ql.split('.').pop(); };
    function refHasCol(r, col) {
      if (r.kind === 'table') return r.table ? !!C.column(r.table, col) : null;
      const sub = r.subScopeId != null ? scopes[r.subScopeId] : null;
      if (!sub) return null;
      if (sub.outputs.some((o) => o.name === col)) return true;
      if (sub.starAll || sub.starRefs.length) return sub.refIds.some((id) => refHasCol(refs[id], col) !== false) ? true : false;
      return false;
    }
    // Resolve a column reference to a table reference in this scope or an outer one (correlation).
    function resolve(scope, qual, col) {
      for (let s = scope, depth = 0; s; s = s.parentId != null && s.kind === 'subquery' ? scopes[s.parentId] : null, depth++) {
        const rs = scopeRefs(s);
        if (qual) { const r = rs.find((x) => refMatches(x, qual)); if (r) return { ref: r, outer: depth > 0 }; continue; }
        const known = rs.filter((x) => refHasCol(x, col) === true);
        if (known.length) return { ref: known[0], outer: depth > 0, ambiguous: known.length > 1 };
        if (depth === 0) {
          if (s.outputs.some((o) => o.alias && o.name === col)) return { alias: true };
          const unknown = rs.filter((x) => refHasCol(x, col) === null);
          if (rs.length === 1 && refHasCol(rs[0], col) !== false) return { ref: rs[0], outer: false };
          if (unknown.length === 1 && !s.parentId) return { ref: unknown[0], outer: false, guessed: true };
          if (unknown.length) { const outerHit = findOuter(s, col); if (outerHit) return outerHit; return { ref: unknown[0], outer: false, guessed: true }; }
        }
      }
      return null;
    }
    function findOuter(s, col) { for (let p = s.kind === 'subquery' && s.parentId != null ? scopes[s.parentId] : null, d = 1; p; p = p.kind === 'subquery' && p.parentId != null ? scopes[p.parentId] : null, d++) { const k = scopeRefs(p).filter((x) => refHasCol(x, col) === true); if (k.length) return { ref: k[0], outer: true }; } return null; }

    function analyzeSelect(node, kind, parent, extra) {
      const scope = newScope(kind, parent, extra);
      // CTEs first, so references to them resolve.
      (node.with || []).forEach((w) => {
        const nm = lc(U.unquote(typeof w.name === 'string' ? w.name : (w.name && w.name.value)));
        const ast = subAst(w.stmt) || (w.stmt && w.stmt.ast);
        if (!ast) return;
        ctes[nm] = { name: nm, scopeId: null, refs: 0 };
        const cs = analyzeSelect(ast, 'cte', null, { name: nm });
        ctes[nm].scopeId = cs.id;
      });
      // FROM items and joins.
      const from = Array.isArray(node.from) ? node.from : (node.from ? [node.from] : []);
      let prevRefs = [];
      from.forEach((f, idx) => {
        let alias = f.as ? lc(U.unquote(typeof f.as === 'string' ? f.as : f.as.value)) : null;
        let joinType = f.join ? lc(f.join) : (idx > 0 ? 'comma' : null);
        if (alias && JOIN_KW.has(alias)) { if (alias === 'cross' && from[idx + 1]) from[idx + 1]._cross = true; alias = null; }
        if (f._cross) joinType = 'cross join';
        let r;
        const sa = subAst(f.expr);
        if (sa) { const ds = analyzeSelect(sa, 'derived', scope); r = addRef(scope, { kind: 'derived', name: alias || ('(subquery)'), alias, subScopeId: ds.id }); }
        else if (f.table) {
          const nm = U.normName((f.catalog && f.schema && !String(f.table).includes('.') ? f.catalog + '.' + f.schema + '.' : (f.db && !String(f.table).includes('.') ? f.db + '.' : '')) + f.table);
          if (!f.db && ctes[nm]) { ctes[nm].refs++; r = addRef(scope, { kind: 'cte', name: nm, alias, cteName: nm, subScopeId: ctes[nm].scopeId }); }
          else { const t = C.find(cat, nm); r = addRef(scope, { kind: 'table', name: nm, alias, table: t }); if (!t) unresolved.push(nm); }
        } else if (f.expr) { r = addRef(scope, { kind: 'other', name: alias || 'unnest', alias }); }
        else return;
        if (idx > 0) {
          const j = { refId: r.id, type: joinType, on: f.on || null, using: (f.using || []).map((u) => lc(typeof u === 'string' ? u : u.value)), hasCondition: !!(f.on || (f.using && f.using.length)), eqPairs: [], prev: prevRefs.map((x) => x.id) };
          scope.joins.push(j);
        }
        prevRefs.push(r);
      });
      // Expressions of this scope.
      const cols = []; // {qual, col, ctx, node}
      const visit = (where) => (n) => {
        if (n.type === 'column_ref') { const c = colName(n); if (c === '*') return; cols.push({ qual: n.table ? lc(U.unquote(n.table)) : null, col: c, where }); return; }
        if (n.type === 'aggr_func') { scope.aggregates++; if (/^count$/i.test(n.name) && n.args && /distinct/i.test(n.args.distinct || '')) scope.countDistinct.push({ text: text(n.args.expr), node: n }); if (n.over) scope.windowFns++; }
        if (n.type === 'function' && n.over) scope.windowFns++;
        if (n.type === 'function' && /^(COUNT)$/.test(fnName(n)) && n.args && /distinct/i.test(n.args.distinct || '')) scope.countDistinct.push({ text: text(n.args.value) });
      };
      const onSub = (ctxLabel) => (ast, ctx) => { const sub = analyzeSelect(ast, 'subquery', scope, { context: ctx || ctxLabel }); scope.subqueries.push({ scopeId: sub.id, context: ctx || ctxLabel }); };
      const walkCtx = (expr, where) => {
        // Label IN / EXISTS subqueries so NOT IN and correlation rules know the context.
        walk(expr, (n) => {
          if (n.type === 'binary_expr' && /^(not in|in)$/i.test(n.operator) && n.right && n.right.type === 'expr_list') {
            const sq = (n.right.value || []).map(subAst).find(Boolean);
            if (sq) { walk(n.left, visit(where), onSub('scalar')); const sub = analyzeSelect(sq, 'subquery', scope, { context: lc(n.operator) }); scope.subqueries.push({ scopeId: sub.id, context: lc(n.operator), left: text(n.left), leftNode: n.left }); if (/not/i.test(n.operator)) scope.notIn.push({ scopeId: sub.id, left: text(n.left) }); return false; }
            if (n.right.value && n.right.value.length) scope.inLists.push({ count: n.right.value.length, left: text(n.left) });
          }
          if (n.type === 'unary_expr' && /exists/i.test(n.operator)) { const sq = subAst(n.expr) || (n.expr && n.expr.value && n.expr.value.map(subAst).find(Boolean)); if (sq) { const sub = analyzeSelect(sq, 'subquery', scope, { context: lc(n.operator) }); scope.subqueries.push({ scopeId: sub.id, context: lc(n.operator) }); return false; } }
          if (n.type === 'function') { const fname = (n.name && ((n.name.schema && n.name.schema.value) || (n.name.name && n.name.name[0] && n.name.name[0].value) || n.name)) || ''; // some grammars parse EXISTS (...) as a function
            if (/^exists$/i.test(String(fname))) { const sq = n.args && n.args.value && n.args.value.map(subAst).find(Boolean); if (sq) { const sub = analyzeSelect(sq, 'subquery', scope, { context: 'exists' }); scope.subqueries.push({ scopeId: sub.id, context: 'exists' }); return false; } } }
          if (n.type === 'binary_expr' && /like$/i.test(n.operator) && n.right) { const l = literal(n.right); if (l) scope.likes.push({ pattern: String(l.value), left: text(n.left), not: /not/i.test(n.operator) }); }
          return visit(where)(n);
        }, onSub('scalar'));
      };
      (node.columns || []).forEach((c) => {
        const e = c.expr || c; if (!e) return;
        if (e.type === 'column_ref' && colName(e) === '*') { if (e.table) scope.starRefs.push(lc(U.unquote(e.table))); else scope.starAll = true; return; }
        if (e.type === 'star' || c === '*') { scope.starAll = true; return; }
        const as = c.as ? lc(U.unquote(typeof c.as === 'string' ? c.as : c.as.value)) : null;
        if (e.type === 'column_ref') { scope.outputs.push({ name: as || colName(e), alias: !!as, qual: e.table ? lc(U.unquote(e.table)) : null, col: colName(e) }); return; }
        if (as) scope.outputs.push({ name: as, alias: true, expr: true });
        walkCtx(e, 'select');
      });
      if (node.columns === '*') scope.starAll = true;
      if (node.where) { scope.hasWhere = true; walkCtx(node.where, 'where'); }
      scope.joins.forEach((j) => { if (j.on) walkCtx(j.on, 'join'); });
      if (node.having) walkCtx(node.having, 'having');
      if (node.qualify) walkCtx(node.qualify, 'qualify');
      const gb = node.groupby && (node.groupby.columns || node.groupby);
      if (gb && (Array.isArray(gb) ? gb.length : true)) { scope.groupBy = true; walkCtx(gb, 'group'); }
      if (node.orderby && node.orderby.length) { scope.orderBy = true; walkCtx(node.orderby.map((o) => o.expr), 'order'); }
      const lim = node.limit && node.limit.value && node.limit.value.length ? node.limit.value[node.limit.value.length - 1] : null;
      if (lim && lim.value != null) scope.limit = Number(lim.value);
      if (node.top && node.top.value != null) scope.limit = Number(node.top.value);
      if (node.distinct && (node.distinct === 'DISTINCT' || node.distinct.type === 'DISTINCT')) scope.distinct = true;
      if (node._orderby && node._orderby.length) scope.orderBy = true;
      if (node._limit && node._limit.value && node._limit.value.length) scope.limit = Number(node._limit.value[0].value);
      // Resolve columns.
      const srefs = scopeRefs(scope);
      cols.forEach((c) => {
        if (c.where === 'order' && !c.qual && scope.outputs.some((o) => o.name === c.col)) return;
        const r = resolve(scope, c.qual, c.col);
        if (!r || r.alias) return;
        r.ref.cols.add(c.col);
        if (r.outer) scope.correlated.push({ col: c.col, refId: r.ref.id });
      });
      scope.outputs.forEach((o) => {
        if (o.expr) return;
        const r = resolve(scope, o.qual, o.col);
        if (r && r.ref) { if (r.outer) { r.ref.cols.add(o.col); scope.correlated.push({ col: o.col, refId: r.ref.id }); } else r.ref.passCols.set(o.name, o.col); }
      });
      if (scope.starAll) srefs.forEach((r) => { r.star = true; });
      scope.starRefs.forEach((q) => { const r = srefs.find((x) => refMatches(x, q)); if (r) r.star = true; });
      // Predicates: WHERE conjuncts plus ON conjuncts that touch a single table.
      const addPred = (e, onlyRef) => {
        const p = classify(e);
        if (!p) return;
        const attach = (pp) => {
          if (pp.op === 'OR') { const parts = pp.parts; const ids = new Set(parts.map((x) => x && x.refId)); if (parts.every(Boolean) && ids.size === 1 && !ids.has(undefined)) { pp.refId = parts[0].refId; pp.column = parts[0].column; return pp; } return null; }
          return pp.refId != null ? pp : null;
        };
        const res = attach(p);
        if (res && (onlyRef == null || res.refId === onlyRef)) { refs[res.refId].preds.push(res); scope.conjuncts.push(res); }
      };
      const classify = (e) => {
        if (!e || e.type !== 'binary_expr' && e.type !== 'unary_expr') return null;
        if (e.type === 'binary_expr' && /^or$/i.test(e.operator)) { const parts = splitOr(e).map(classify); return { op: 'OR', parts }; }
        if (e.type !== 'binary_expr') return null;
        let op = String(e.operator).toUpperCase(); let L = e.left, R = e.right;
        let tg = target(L);
        if ((!tg || R && R.type === 'column_ref' && !literal(L)) && FLIP[op] && target(R) && !target(L)) { tg = target(R); R = L; op = FLIP[op]; }
        if (!tg) return null;
        const r = resolve(scope, tg.node.table ? lc(U.unquote(tg.node.table)) : null, colName(tg.node));
        if (!r || !r.ref || r.outer) return null;
        let values = [];
        if (op === 'IN' || op === 'NOT IN') values = (R && R.type === 'expr_list' ? R.value : []).map((v) => valueOf(v, today));
        else if (/BETWEEN/.test(op)) values = (R && R.type === 'expr_list' ? R.value : []).map((v) => valueOf(v, today));
        else values = [valueOf(R, today)];
        return { op, refId: r.ref.id, column: colName(tg.node), fn: tg.fn, part: tg.part || null, castTo: tg.castTo || null, values, text: text(e) };
      };
      splitAnd(node.where).forEach((e) => addPred(e));
      scope.joins.forEach((j) => {
        const conj = splitAnd(j.on);
        conj.forEach((e) => {
          if (e.type === 'binary_expr' && e.operator === '=') {
            const a = target(e.left), b = target(e.right);
            if (a && b) {
              const ra = resolve(scope, a.node.table ? lc(U.unquote(a.node.table)) : null, colName(a.node)), rb = resolve(scope, b.node.table ? lc(U.unquote(b.node.table)) : null, colName(b.node));
              if (ra && rb && ra.ref && rb.ref && ra.ref.id !== rb.ref.id) { j.eqPairs.push([{ refId: ra.ref.id, col: colName(a.node), fn: a.fn }, { refId: rb.ref.id, col: colName(b.node), fn: b.fn }]); return; }
            }
          }
          addPred(e, /left/.test(j.type) ? j.refId : null);
        });
        if (j.using.length) j.prev.slice(-1).forEach((pid) => j.using.forEach((u) => { j.eqPairs.push([{ refId: pid, col: u }, { refId: j.refId, col: u }]); refs[pid].cols.add(u); refs[j.refId].cols.add(u); }));
      });
      // Comma joins linked through WHERE equality count as joined.
      splitAnd(node.where).forEach((e) => {
        if (e.type === 'binary_expr' && e.operator === '=') {
          const a = target(e.left), b = target(e.right);
          if (!a || !b) return;
          const ra = resolve(scope, a.node.table ? lc(U.unquote(a.node.table)) : null, colName(a.node)), rb = resolve(scope, b.node.table ? lc(U.unquote(b.node.table)) : null, colName(b.node));
          if (!ra || !rb || !ra.ref || !rb.ref || ra.ref.id === rb.ref.id || ra.outer || rb.outer) return;
          const j = scope.joins.find((x) => (x.refId === ra.ref.id || x.refId === rb.ref.id) && x.type === 'comma');
          if (j) { j.hasCondition = true; j.eqPairs.push([{ refId: ra.ref.id, col: colName(a.node), fn: a.fn }, { refId: rb.ref.id, col: colName(b.node), fn: b.fn }]); }
        }
      });
      // Set operations (UNION etc.): later branches become sibling scopes.
      let nx = node._next; let first = scope;
      while (nx) { setOps.push(lc(node.set_op && nx === node._next ? node.set_op : (nx._prevOp || ''))); const op = nx.set_op; const b = analyzeSelect(Object.assign({}, nx, { _next: null }), 'union', parent, { outputOf: first.id, name: first.name, context: scope.context }); if (nx._next) nx._next._prevOp = op; nx = nx._next; if (b.orderBy) first.orderBy = true; }
      return scope;
    }
    stmts.forEach((st) => {
      if (st && st.type === 'select') analyzeSelect(st, 'main', null);
      else if (st && (st.type === 'insert' || st.type === 'replace') && st.select) analyzeSelect(subAst(st.select) || st.select, 'main', null, { dml: st.type });
      else if (st && st.type === 'create' && (st.query_expr || st.as)) { const q = subAst(st.query_expr) || subAst(st.as) || (st.query_expr && st.query_expr.ast); if (q) analyzeSelect(q, 'main', null, { dml: 'create' }); }
      else if (st && (st.type === 'update' || st.type === 'delete')) {
        const s = newScope('main', null, { dml: st.type });
        (st.table || st.from || []).forEach((f) => { if (f && f.table) { const nm = U.normName((f.db ? f.db + '.' : '') + f.table); const t = C.find(cat, nm); addRef(s, { kind: 'table', name: nm, alias: f.as ? lc(f.as) : null, table: t }); } });
      }
    });
    return finish({ scopes, refs, ctes, setOps, unresolved: [...new Set(unresolved)], approximate: false });
  }

  function consumersOf(model, s) {
    if (s.kind === 'union' && s.outputOf != null) return consumersOf(model, model.scopes[s.outputOf]);
    if (s.kind === 'cte') return model.refs.filter((r) => r.kind === 'cte' && r.subScopeId === s.id);
    if (s.kind === 'derived') return model.refs.filter((r) => r.kind === 'derived' && r.subScopeId === s.id);
    return [];
  }
  // Map a predicate on an output column of scope S down to the base reference R inside S.
  function mapPred(model, S, p, R) {
    if (p.op === 'OR') { const parts = p.parts.map((x) => mapPred(model, S, Object.assign({}, x), R)); return parts.every(Boolean) ? Object.assign({}, p, { parts, refId: R.id, column: parts[0].column }) : null; }
    const col = mapCol(model, S, p.column, R);
    return col ? Object.assign({}, p, { refId: R.id, column: col, pushed: true }) : null;
  }
  function mapCol(model, S, outName, R) {
    if (R.passCols.has(outName)) return R.passCols.get(outName);
    if (S.outputs.some((o) => o.name === outName)) return null;
    if (R.star) { const has = R.kind === 'table' ? (!R.table || C.column(R.table, outName)) : true; const others = S.refIds.filter((id) => id !== R.id && model.refs[id].star && model.refs[id].table && C.column(model.refs[id].table, outName)); return has && !others.length ? outName : (has && R.table && C.column(R.table, outName) ? outName : null); }
    return null;
  }
  // All the predicate sets that can prune reference R (one per path through CTE/derived consumers).
  function predSets(model, R, depth) {
    const S = model.scopes[R.scopeId]; const cons = consumersOf(model, S);
    if (!cons.length || (depth || 0) > 8) return [R.preds];
    const sets = [];
    cons.forEach((X) => predSets(model, X, (depth || 0) + 1).forEach((xs) => { sets.push(R.preds.concat(xs.map((p) => mapPred(model, S, p, R)).filter(Boolean))); }));
    return sets.length ? sets : [R.preds];
  }
  // Columns of R actually needed, following column pruning through CTEs and derived tables. Returns Set or 'ALL'.
  function neededCols(model, R, depth) {
    const S = model.scopes[R.scopeId]; const cons = consumersOf(model, S);
    const out = new Set(R.cols);
    if (!cons.length || (depth || 0) > 8) { if (R.star) return 'ALL'; R.passCols.forEach((v) => out.add(v)); return out; }
    for (const X of cons) {
      const need = neededCols(model, X, (depth || 0) + 1);
      if (need === 'ALL') { if (R.star) return 'ALL'; R.passCols.forEach((v) => out.add(v)); continue; }
      need.forEach((name) => { const c = mapCol(model, S, name, R); if (c) out.add(c); });
    }
    return out;
  }
  function finish(model) {
    model.refs.forEach((r) => { r.cols = r.cols || new Set(); });
    model.cteRefCounts = Object.fromEntries(Object.values(model.ctes).map((c) => [c.name, c.refs]));
    return model;
  }

  // ---------- Token fallback ----------
  function fallbackModel(sql, cat, opts) {
    const toks = U.sig(U.tokenize(sql)); const today = opts.today;
    const scopes = [{ id: 0, kind: 'main', parentId: null, refIds: [], joins: [], conjuncts: [], orderBy: false, limit: null, distinct: false, groupBy: false, aggregates: 0, countDistinct: [], windowFns: 0, correlated: [], subqueries: [], outputs: [], starRefs: [], starAll: false, hasWhere: false, notIn: [], likes: [], inLists: [], castJoin: [] }];
    const refs = []; const ctes = {}; const unresolved = []; const setOps = [];
    const S = scopes[0]; const kwAt = (i, w) => U.kw(toks[i], w);
    const nameAt = (i) => { let j = i; let name = ''; while (toks[j] && (toks[j].t === 'id' || toks[j].t === 'qid')) { name += toks[j].v; if (toks[j + 1] && toks[j + 1].v === '.' && toks[j + 2] && (toks[j + 2].t === 'id' || toks[j + 2].t === 'qid')) { name += '.'; j += 2; } else { j++; break; } } return { name, next: j }; };
    // CTE names
    toks.forEach((t, i) => { if ((kwAt(i - 1, 'with') || (toks[i - 1] && toks[i - 1].v === ',' && toks[i - 2] && toks[i - 2].v === ')') || kwAt(i - 1, 'recursive')) && (t.t === 'id' || t.t === 'qid') && kwAt(i + 1, 'as') && toks[i + 2] && toks[i + 2].v === '(') ctes[U.normName(t.v)] = { name: U.normName(t.v), scopeId: 0, refs: 0 }; });
    let depth = 0; const depthAt = [];
    toks.forEach((t, i) => { if (t.v === '(') depth++; depthAt[i] = depth; if (t.v === ')') depth--; });
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (U.kw(t, 'union') || U.kw(t, 'intersect') || U.kw(t, 'except')) setOps.push(lc(t.v) + (kwAt(i + 1, 'all') ? ' all' : (kwAt(i + 1, 'distinct') ? ' distinct' : '')));
      if (U.kw(t, 'order') && kwAt(i + 1, 'by') && !toks.slice(Math.max(0, i - 40), i).some((x, k) => U.kw(x, 'over') && depthAt[Math.max(0, i - 40) + k] < depthAt[i])) S.orderBy = true;
      if (U.kw(t, 'limit') && toks[i + 1] && toks[i + 1].t === 'num') S.limit = Number(toks[i + 1].v);
      if (U.kw(t, 'distinct') && kwAt(i - 1, 'select')) S.distinct = true;
      if (U.kw(t, 'group') && kwAt(i + 1, 'by')) S.groupBy = true;
      if (U.kw(t, 'where')) S.hasWhere = true;
      if (U.kw(t, 'over')) S.windowFns++;
      if (/^(count|sum|avg|min|max)$/i.test(t.v) && toks[i + 1] && toks[i + 1].v === '(') { S.aggregates++; if (/^count$/i.test(t.v) && kwAt(i + 2, 'distinct')) S.countDistinct.push({ text: toks[i + 3] ? toks[i + 3].v : '' }); }
      if (U.kw(t, 'like') && toks[i + 1] && toks[i + 1].t === 'str') S.likes.push({ pattern: toks[i + 1].v.slice(1, -1), left: toks[i - 1] ? toks[i - 1].v : '', not: kwAt(i - 1, 'not') });
      if (U.kw(t, 'in') && toks[i + 1] && toks[i + 1].v === '(' && !kwAt(i + 2, 'select')) { let k = i + 2, n = 0; while (toks[k] && toks[k].v !== ')') { if (toks[k].t === 'str' || toks[k].t === 'num') n++; k++; } if (n) S.inLists.push({ count: n, left: toks[i - 1] ? toks[i - 1].v : '' }); }
      if ((U.kw(t, 'from') || U.kw(t, 'join')) && toks[i + 1] && (toks[i + 1].t === 'id' || toks[i + 1].t === 'qid') && !U.isKeyword(toks[i + 1].v)) {
        const { name, next } = nameAt(i + 1); let alias = null; let k = next;
        if (kwAt(k, 'as')) k++;
        if (toks[k] && (toks[k].t === 'id' || toks[k].t === 'qid') && !U.isKeyword(toks[k].v)) alias = lc(U.unquote(toks[k].v));
        const nm = U.normName(name);
        if (ctes[nm]) { ctes[nm].refs++; continue; }
        const tb = C.find(cat, nm); if (!tb) unresolved.push(nm);
        const r = { id: refs.length, scopeId: 0, kind: 'table', name: nm, alias, table: tb, cols: new Set(), passCols: new Map(), star: false, preds: [], tokIndex: i };
        refs.push(r); S.refIds.push(r.id);
        if (U.kw(t, 'join') || (refs.length > 1 && toks[i - 1] && toks[i - 1].v === ',')) {
          const type = kwAt(i - 1, 'cross') ? 'cross join' : (kwAt(i - 1, 'left') || kwAt(i - 2, 'left') ? 'left join' : 'inner join');
          let hasCond = false; for (let q = next; q < toks.length && !U.kw(toks[q], 'join') && !U.kw(toks[q], 'where'); q++) if (U.kw(toks[q], 'on') || U.kw(toks[q], 'using')) { hasCond = true; break; }
          S.joins.push({ refId: r.id, type, hasCondition: hasCond || type === 'cross join' ? hasCond : false, eqPairs: [], prev: [] });
        }
      }
      if (t.v === ',' && depthAt[i] === 0 && refs.length) { /* comma joins handled above via JOIN detection on FROM lists */ }
    }
    // FROM a, b comma joins
    for (let i = 0; i < toks.length; i++) if (toks[i].v === ',' && refs.some((r) => r.tokIndex < i) && toks[i + 1] && (toks[i + 1].t === 'id' || toks[i + 1].t === 'qid')) {
      let k = i - 1; while (k >= 0 && !U.kw(toks[k], 'from') && !U.kw(toks[k], 'select') && !U.kw(toks[k], 'where') && !U.kw(toks[k], 'join')) k--;
      if (k >= 0 && U.kw(toks[k], 'from') && depthAt[k] === depthAt[i]) {
        const { name, next } = nameAt(i + 1); const nm = U.normName(name); if (ctes[nm]) continue;
        let alias = null; let q = next; if (kwAt(q, 'as')) q++; if (toks[q] && toks[q].t === 'id' && !U.isKeyword(toks[q].v)) alias = lc(toks[q].v);
        const tb = C.find(cat, nm); if (!tb) unresolved.push(nm);
        const r = { id: refs.length, scopeId: 0, kind: 'table', name: nm, alias, table: tb, cols: new Set(), passCols: new Map(), star: false, preds: [], tokIndex: i };
        refs.push(r); S.refIds.push(r.id); S.joins.push({ refId: r.id, type: 'comma', hasCondition: false, eqPairs: [], prev: [] });
      }
    }
    const refFor = (qual, col) => {
      if (qual) return refs.find((r) => r.alias === qual || r.name === qual || r.name.split('.').pop() === qual);
      const hits = refs.filter((r) => r.table && C.column(r.table, col)); return hits[0] || (refs.length === 1 ? refs[0] : null);
    };
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.v === '*' && (kwAt(i - 1, 'select') || kwAt(i - 1, 'distinct') || (toks[i - 1] && toks[i - 1].v === ','))) { refs.forEach((r) => { r.star = true; }); S.starAll = true; }
      if (t.v === '*' && toks[i - 1] && toks[i - 1].v === '.' && toks[i - 2]) { const r = refFor(lc(U.unquote(toks[i - 2].v))); if (r) r.star = true; }
      if ((t.t === 'id' || t.t === 'qid') && !(toks[i + 1] && toks[i + 1].v === '(') && !(toks[i + 1] && toks[i + 1].v === '.')) {
        const col = lc(U.unquote(t.v)); const qual = toks[i - 1] && toks[i - 1].v === '.' && toks[i - 2] ? lc(U.unquote(toks[i - 2].v)) : null;
        const r = refFor(qual, col); if (r && r.table && C.column(r.table, col)) r.cols.add(col);
      }
    }
    // Predicates on partition / cluster columns inside WHERE / ON regions.
    let inFilter = false;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (U.kw(t, 'where') || U.kw(t, 'on')) inFilter = true;
      if (U.kw(t, 'group') || U.kw(t, 'order') || U.kw(t, 'having') || U.kw(t, 'limit') || U.kw(t, 'union') || U.kw(t, 'join') || U.kw(t, 'select')) inFilter = false;
      if (!inFilter || !(t.t === 'id' || t.t === 'qid') || (toks[i + 1] && toks[i + 1].v === '.')) continue;
      const col = lc(U.unquote(t.v)); const qual = toks[i - 1] && toks[i - 1].v === '.' && toks[i - 2] ? lc(U.unquote(toks[i - 2].v)) : null;
      const r = refFor(qual, col); if (!r || !r.table) continue;
      const tb = r.table; const interesting = (tb.partition && tb.partition.column === col) || tb.cluster.includes(col); if (!interesting) continue;
      let s = qual ? i - 2 : i; let fn = null; let k = i + 1;
      if (toks[s - 1] && toks[s - 1].v === '(' && toks[s - 2] && toks[s - 2].t === 'id') { fn = toks[s - 2].v.toUpperCase(); let d = 1; while (toks[k] && d) { if (toks[k].v === '(') d++; if (toks[k].v === ')') d--; k++; } }
      if (!toks[k]) continue;
      let op = toks[k].v.toUpperCase(); if (op === 'NOT' && toks[k + 1]) { op = 'NOT ' + toks[k + 1].v.toUpperCase(); k++; }
      const vals = []; const readVal = (j) => { const x = toks[j]; if (!x) return { v: { kind: 'expr', text: '' }, next: j + 1 }; if (x.t === 'str') return { v: { kind: 'lit', value: x.v.slice(1, -1).replace(/''/g, "'") }, next: j + 1 }; if (x.t === 'num') return { v: { kind: 'lit', value: Number(x.v) }, next: j + 1 }; if (/^(date|timestamp)$/i.test(x.v) && toks[j + 1] && toks[j + 1].t === 'str') return { v: { kind: 'lit', value: toks[j + 1].v.slice(1, -1) }, next: j + 2 }; let e = j, d = 0, txt = ''; while (toks[e] && !(d === 0 && (U.kw(toks[e], 'and') || U.kw(toks[e], 'or') || toks[e].v === ')' || U.kw(toks[e], 'group') || U.kw(toks[e], 'order') || U.kw(toks[e], 'limit')))) { if (toks[e].v === '(') d++; if (toks[e].v === ')') d--; txt += toks[e].v + ' '; e++; } const rd = relDate(txt, today); return { v: rd ? { kind: 'rel', value: rd, text: txt.trim() } : { kind: 'expr', text: txt.trim() }, next: e }; };
      if (['=', '>', '>=', '<', '<=', '<>', '!='].includes(op)) vals.push(readVal(k + 1).v);
      else if (op === 'BETWEEN') { const a = readVal(k + 1); vals.push(a.v); if (U.kw(toks[a.next], 'and')) vals.push(readVal(a.next + 1).v); }
      else if (op === 'IN' || op === 'NOT IN') { let j = k + 2; if (U.kw(toks[j], 'select')) vals.push({ kind: 'subquery' }); else while (toks[j] && toks[j].v !== ')') { if (toks[j].v !== ',') vals.push(readVal(j).v); j++; } }
      else continue;
      const p = { op, refId: r.id, column: col, fn, values: vals, text: toks.slice(s, k + 2).map((x) => x.v).join(' ') };
      r.preds.push(p); S.conjuncts.push(p);
    }
    S.notIn = []; for (let i = 0; i < toks.length; i++) if (U.kw(toks[i], 'not') && kwAt(i + 1, 'in') && toks[i + 2] && toks[i + 2].v === '(' && kwAt(i + 3, 'select')) S.notIn.push({ scopeId: null, left: toks[i - 1] ? toks[i - 1].v : '' });
    return finish({ scopes, refs, ctes, setOps, unresolved: [...new Set(unresolved)], approximate: true });
  }

  const DIALECT_GRAMMAR = { bigquery: 'bigquery', snowflake: 'snowflake', databricks: 'hive', redshift: 'redshift', athena: 'athena' };
  const FALLBACK_GRAMMARS = ['postgresql', 'trino', 'bigquery', 'snowflake'];
  // analyze(sql, catalog, { warehouse, getParser(grammar) -> Parser|null, today })
  function analyze(sql, cat, opts) {
    opts = Object.assign({ today: new Date().toISOString().slice(0, 10) }, opts || {});
    const src = String(sql || '');
    const statements = U.splitStatements(src);
    const res = { sql: src, statementCount: statements.length, parser: null, parseError: null, model: null };
    if (!statements.length) { res.model = finish({ scopes: [], refs: [], ctes: {}, setOps: [], unresolved: [], approximate: false }); return res; }
    const primary = DIALECT_GRAMMAR[opts.warehouse] || 'bigquery';
    const tries = [primary].concat(FALLBACK_GRAMMARS.filter((g) => g !== primary));
    for (const g of tries) {
      const P = opts.getParser && opts.getParser(g);
      if (!P) continue;
      try {
        let ast = P.astify(src, { database: g });
        ast = Array.isArray(ast) ? ast : [ast];
        res.model = analyzeAst(ast, cat, opts); res.parser = g; res.fallbackGrammar = g !== primary;
        return res;
      } catch (e) { if (!res.parseError) res.parseError = String(e && e.message || e).split('\n')[0].slice(0, 240); }
    }
    res.model = fallbackModel(src, cat, opts); res.parser = null;
    return res;
  }
  return { analyze, analyzeAst, fallbackModel, predSets, neededCols, consumersOf, relDate, text, DIALECT_GRAMMAR };
});

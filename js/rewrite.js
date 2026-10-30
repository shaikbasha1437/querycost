/* QueryCost rewrite engine: token-based edits that keep the user's formatting and comments.
   Each helper takes SQL text and returns new SQL text (or null when the edit does not apply). */
(function (root, factory) {
  const isNode = typeof require === 'function' && typeof module === 'object';
  const m = factory(isNode ? require('./sqlutil.js') : root.QC.sqlutil);
  if (isNode) module.exports = m; else (root.QC = root.QC || {}).rewrite = m;
})(typeof self !== 'undefined' ? self : this, function (U) {
  'use strict';
  const CLAUSE = ['group', 'having', 'qualify', 'window', 'order', 'limit', 'fetch', 'offset'];
  const SETOP = ['union', 'intersect', 'except', 'minus'];
  // Significant tokens with paren depth and index into the full token list.
  function lex(sql) {
    const all = U.tokenize(sql); const toks = []; let d = 0;
    all.forEach((t) => { if (t.t === 'ws' || t.t === 'comment') return; if (t.v === ')') d--; toks.push(Object.assign({ d, lv: t.t === 'id' ? t.v.toLowerCase() : null }, t)); if (t.v === '(') d++; });
    return toks;
  }
  const isKw = (t, w) => t && t.lv === w;
  const splice = (sql, s, e, text) => sql.slice(0, s) + text + sql.slice(e);
  // Token range [a, b) of the SELECT block that contains token i (same paren level, split at set operators).
  function blockOf(toks, i) {
    const d = toks[i].d; let a = i, b = i;
    while (a > 0 && toks[a - 1].d >= d && !(toks[a - 1].d === d && (SETOP.includes(toks[a - 1].lv) || toks[a - 1].v === ';'))) a--;
    while (a < i && toks[a].d === d && toks[a].v === '(' ) break;
    while (b < toks.length && toks[b].d >= d && !(toks[b].d === d && (SETOP.includes(toks[b].lv) || toks[b].v === ';' || toks[b].v === ')'))) b++;
    // If the block starts with WITH, the SELECT that matters is the last top-level SELECT of this block.
    return { a, b, d };
  }
  // Block range for the paren group whose first token is at index p (the '(').
  function groupBlock(toks, p) { const d = toks[p].d + 1; let b = p + 1; while (b < toks.length && !(toks[b].d === d - 1 && toks[b].v === ')')) b++; return { a: p + 1, b, d }; }
  function chainAt(toks, i) { // dotted name starting at i -> {end, name}
    let j = i, parts = [];
    while (toks[j] && (toks[j].t === 'id' || toks[j].t === 'qid')) { parts.push(toks[j].v); if (toks[j + 1] && toks[j + 1].v === '.' && toks[j + 2] && (toks[j + 2].t === 'id' || toks[j + 2].t === 'qid')) j += 2; else break; }
    return parts.length ? { end: j, name: U.normName(parts.join('.')) } : null;
  }
  // Find the FROM/JOIN occurrence of a table reference. Returns token index of the name's last token and its alias token (if any).
  function findRef(toks, name, alias, nth) {
    let seen = 0;
    for (let i = 0; i < toks.length; i++) {
      const p = toks[i - 1]; if (!p || !(isKw(p, 'from') || isKw(p, 'join') || (p.v === ',' && inFrom(toks, i)))) continue;
      const c = chainAt(toks, i); if (!c || c.name !== name) continue;
      let k = c.end + 1; if (isKw(toks[k], 'as')) k++;
      const al = toks[k] && (toks[k].t === 'id' || toks[k].t === 'qid') && !U.isKeyword(toks[k].v) ? toks[k] : null;
      if ((alias || null) !== (al ? U.normName(al.v) : null) && alias) continue;
      if (seen++ < (nth || 0)) continue;
      return { start: i, end: c.end, aliasTok: al ? k : -1 };
    }
    return null;
  }
  function inFrom(toks, i) { // walk back at the same depth to see if we are in a FROM list
    const d = toks[i].d; for (let k = i - 1; k >= 0; k--) { if (toks[k].d < d) return false; if (toks[k].d > d) continue; if (isKw(toks[k], 'from')) return true; if (['select', 'where', 'on', 'group', 'order', 'having', 'set'].includes(toks[k].lv)) return false; } return false;
  }
  function hasTopOr(toks, a, b, d) { for (let k = a; k < b; k++) if (toks[k].d === d && isKw(toks[k], 'or')) return true; return false; }
  // Add a predicate to the WHERE clause of the block [a, b) at depth d.
  function addPredicateInBlock(sql, toks, blk, pred) {
    const { a, b, d } = blk; let selectIdx = -1;
    for (let k = b - 1; k >= a; k--) if (toks[k].d === d && isKw(toks[k], 'select')) { selectIdx = k; break; }
    if (selectIdx < 0) return null;
    let where = -1, end = b;
    for (let k = selectIdx; k < b; k++) { if (toks[k].d !== d) continue; if (isKw(toks[k], 'where')) where = k; else if (CLAUSE.includes(toks[k].lv) && (where >= 0 || k > selectIdx)) { if (where >= 0 || !isKw(toks[k], 'window') || true) { if (k > where) { end = k; if (where >= 0) break; } } } }
    if (where >= 0) {
      let wEnd = b; for (let k = where + 1; k < b; k++) if (toks[k].d === d && CLAUSE.includes(toks[k].lv)) { wEnd = k; break; }
      const s = toks[where + 1].s, e = toks[wEnd - 1].e; const body = sql.slice(s, e);
      return splice(sql, s, e, hasTopOr(toks, where + 1, wEnd, d) ? '(' + body + ') AND ' + pred : body + '\n  AND ' + pred);
    }
    let ins = b; for (let k = selectIdx + 1; k < b; k++) if (toks[k].d === d && CLAUSE.includes(toks[k].lv)) { ins = k; break; }
    const pos = toks[ins - 1].e;
    return splice(sql, pos, pos, '\nWHERE ' + pred);
  }
  function addPredicateForRef(sql, name, alias, pred) {
    const toks = lex(sql); const r = findRef(toks, name, alias); if (!r) return null;
    return addPredicateInBlock(sql, toks, blockOf(toks, r.start), pred);
  }
  function qualifierFor(sql, name, alias) {
    const toks = lex(sql); const r = findRef(toks, name, alias); if (!r) return null;
    if (r.aliasTok >= 0) return toks[r.aliasTok].v;
    // Unqualified when the block has a single source; else the last name part.
    return name.split('.').pop();
  }
  // Remove ORDER BY from subqueries/CTEs that have no LIMIT/TOP/FETCH (the order is discarded anyway).
  function dropInnerOrderBy(sql) {
    let toks = lex(sql); let changed = false;
    for (let guard = 0; guard < 50; guard++) {
      let done = true;
      for (let p = 0; p < toks.length; p++) {
        if (toks[p].v !== '(' || !(isKw(toks[p + 1], 'select') || isKw(toks[p + 1], 'with'))) continue;
        const blk = groupBlock(toks, p); let ord = -1, lim = false;
        for (let k = blk.a; k < blk.b; k++) { if (toks[k].d !== blk.d) continue; if (isKw(toks[k], 'order') && isKw(toks[k + 1], 'by')) ord = k; if (['limit', 'top', 'fetch', 'offset'].includes(toks[k].lv)) lim = true; }
        if (ord < 0 || lim) continue;
        let end = blk.b; for (let k = ord + 2; k < blk.b; k++) if (toks[k].d === blk.d && SETOP.includes(toks[k].lv)) { end = k; break; }
        const s = toks[ord - 1] ? toks[ord - 1].e : toks[ord].s; sql = splice(sql, s, toks[end - 1].e, ''); changed = true; done = false; toks = lex(sql); break;
      }
      if (done) break;
    }
    return changed ? sql : null;
  }
  function unionAll(sql) {
    const toks = lex(sql); let out = sql; let shift = 0; let changed = false;
    toks.forEach((t, i) => {
      if (!isKw(t, 'union')) return; const n = toks[i + 1];
      if (isKw(n, 'all')) return;
      const s = t.s + shift, e = (isKw(n, 'distinct') ? n.e : t.e) + shift; const rep = t.v === t.v.toUpperCase() ? 'UNION ALL' : 'union all';
      out = splice(out, s, e, rep); shift += rep.length - (e - s); changed = true;
    });
    return changed ? out : null;
  }
  const APPROX = { bigquery: (x) => 'APPROX_COUNT_DISTINCT(' + x + ')', snowflake: (x) => 'APPROX_COUNT_DISTINCT(' + x + ')', databricks: (x) => 'approx_count_distinct(' + x + ')', athena: (x) => 'approx_distinct(' + x + ')', redshift: (x) => 'APPROXIMATE COUNT(DISTINCT ' + x + ')' };
  function approxCountDistinct(sql, wh) {
    const toks = lex(sql); const edits = [];
    for (let i = 0; i < toks.length; i++) {
      if (!isKw(toks[i], 'count') || toks[i + 1].v !== '(' || !isKw(toks[i + 2], 'distinct')) continue;
      if (isKw(toks[i - 1], 'approximate')) continue;
      const d = toks[i + 1].d; let k = i + 3; while (k < toks.length && !(toks[k].v === ')' && toks[k].d === d)) k++;
      if (k >= toks.length) continue; const inner = sql.slice(toks[i + 3].s, toks[k - 1].e);
      if (toks.slice(i + 3, k).some((t) => t.v === ',' && t.d === d + 1)) continue; // multi-column COUNT(DISTINCT a, b)
      edits.push([toks[i].s, toks[k].e, (APPROX[wh] || APPROX.bigquery)(inner)]);
    }
    if (!edits.length) return null;
    for (let j = edits.length - 1; j >= 0; j--) sql = splice(sql, edits[j][0], edits[j][1], edits[j][2]);
    return sql;
  }
  // Add "<col> IS NOT NULL" inside each NOT IN (SELECT col ...) subquery.
  function notInNotNull(sql) {
    let toks = lex(sql); let changed = false;
    for (let i = 0; i < toks.length; i++) {
      if (!(isKw(toks[i], 'not') && isKw(toks[i + 1], 'in') && toks[i + 2] && toks[i + 2].v === '(' && isKw(toks[i + 3], 'select'))) continue;
      const blk = groupBlock(toks, i + 2); let from = -1;
      for (let k = blk.a + 1; k < blk.b; k++) if (toks[k].d === blk.d && isKw(toks[k], 'from')) { from = k; break; }
      if (from < 0) continue; let first = blk.a + 1; if (isKw(toks[first], 'distinct')) first++;
      let colEnd = from; for (let k = first; k < from; k++) if (toks[k].d === blk.d && (isKw(toks[k], 'as') || toks[k].v === ',')) { colEnd = k; break; }
      const col = sql.slice(toks[first].s, toks[colEnd - 1].e);
      if (new RegExp(U.escapeRe(col) + '\\s+is\\s+not\\s+null', 'i').test(sql.slice(toks[blk.a].s, toks[blk.b - 1].e))) continue;
      const next = addPredicateInBlock(sql, toks, blk, col + ' IS NOT NULL'); if (!next) continue;
      sql = next; toks = lex(sql); changed = true;
    }
    return changed ? sql : null;
  }
  // TABLESAMPLE for BigQuery exploration queries.
  function tableSample(sql, name, alias, pct) {
    const toks = lex(sql); const r = findRef(toks, name, alias); if (!r) return null;
    if (isKw(toks[r.end + 1], 'tablesample') || (r.aliasTok >= 0 && isKw(toks[r.aliasTok + 1], 'tablesample'))) return null;
    const pos = (r.aliasTok >= 0 ? toks[r.aliasTok] : toks[r.end]).e;
    return splice(sql, pos, pos, ' TABLESAMPLE SYSTEM (' + pct + ' PERCENT)');
  }
  // Replace "fn(col) = literal" patterns on a time column with a sargable range.
  function dateLit(iso, kind, wh) { return kind === 'string' ? "'" + iso + "'" : (kind === 'timestamp' ? 'TIMESTAMP' : 'DATE') + " '" + iso + (kind === 'timestamp' && wh !== 'bigquery' ? ' 00:00:00' : '') + "'"; }
  function nextPeriod(iso, unit) { const d = new Date(iso + 'T00:00:00Z'); if (unit === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1); else if (unit === 'month') d.setUTCMonth(d.getUTCMonth() + 1); else d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }
  function sargable(sql, col, kind, wh) {
    const c = '((?:[\\w`"\\[\\]]+\\.)*' + U.escapeRe(col) + '[`"\\]]?)';
    const range = (q, startIso, unit) => q + ' >= ' + dateLit(startIso, kind, wh) + ' AND ' + q + ' < ' + dateLit(nextPeriod(startIso, unit), kind, wh);
    const patterns = [
      [new RegExp('EXTRACT\\s*\\(\\s*YEAR\\s+FROM\\s+' + c + '\\s*\\)\\s*=\\s*(\\d{4})', 'ig'), (m, q, y) => range(q, y + '-01-01', 'year')],
      [new RegExp('\\b(?:YEAR)\\s*\\(\\s*' + c + '\\s*\\)\\s*=\\s*(\\d{4})', 'ig'), (m, q, y) => range(q, y + '-01-01', 'year')],
      [new RegExp("DATE_TRUNC\\s*\\(\\s*'?(month|year|day)'?\\s*,\\s*" + c + "\\s*\\)\\s*=\\s*(?:DATE\\s*)?'(\\d{4}-\\d{2}-\\d{2})'", 'ig'), (m, u, q, iso) => range(q, iso, u.toLowerCase())],
      [new RegExp('(?:DATE|TIMESTAMP|DATETIME)_TRUNC\\s*\\(\\s*' + c + "\\s*,\\s*(MONTH|YEAR|DAY)\\s*\\)\\s*=\\s*(?:DATE\\s*|TIMESTAMP\\s*)?'(\\d{4}-\\d{2}-\\d{2})'", 'ig'), (m, q, u, iso) => range(q, iso, u.toLowerCase())],
      [new RegExp("FORMAT_(?:DATE|TIMESTAMP)\\s*\\(\\s*'%Y-%m'\\s*,\\s*" + c + "\\s*\\)\\s*=\\s*'(\\d{4})-(\\d{2})'", 'ig'), (m, q, y, mo) => range(q, y + '-' + mo + '-01', 'month')],
      [new RegExp('(?:TO_CHAR|DATE_FORMAT)\\s*\\(\\s*' + c + "\\s*,\\s*'(?:YYYY-MM|yyyy-MM)'\\s*\\)\\s*=\\s*'(\\d{4})-(\\d{2})'", 'ig'), (m, q, y, mo) => range(q, y + '-' + mo + '-01', 'month')],
      [new RegExp('(?:SUBSTR|SUBSTRING|LEFT)\\s*\\(\\s*' + c + "\\s*,\\s*(?:1\\s*,\\s*)?7\\s*\\)\\s*=\\s*'(\\d{4})-(\\d{2})'", 'ig'), (m, q, y, mo) => range(q, y + '-' + mo + '-01', 'month')],
      [new RegExp('CAST\\s*\\(\\s*' + c + "\\s+AS\\s+(?:STRING|VARCHAR|TEXT)\\s*\\)\\s+LIKE\\s+'(\\d{4})-(\\d{2})%'", 'ig'), (m, q, y, mo) => range(q, y + '-' + mo + '-01', 'month')],
    ];
    let out = sql; patterns.forEach(([re, fn]) => { out = out.replace(re, fn); });
    return out !== sql ? out : null;
  }
  return { lex, findRef, blockOf, addPredicateForRef, addPredicateInBlock, qualifierFor, dropInnerOrderBy, unionAll, approxCountDistinct, notInNotNull, tableSample, sargable, nextPeriod };
});

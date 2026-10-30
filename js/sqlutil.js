/* QueryCost SQL utilities: a small dialect-tolerant tokenizer plus helpers shared by the analyzer,
   the regex fallback and the rewrite engine. No dependencies. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else (root.QC = root.QC || {}).sqlutil = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const KEYWORDS = new Set(('select from where join inner left right full outer cross on using group by order having limit offset union all distinct ' +
    'intersect except minus with as and or not in is null like ilike rlike between case when then else end exists qualify window over partition ' +
    'rows range asc desc nulls first last lateral unnest values insert into update delete merge create table view replace temp temporary top fetch next only ' +
    'true false interval cast try_cast natural semi anti any some escape recursive tablesample sample pivot unpivot struct array').split(' '));

  // Tokens: {t: 'ws'|'comment'|'str'|'qid'|'id'|'num'|'op'|'punct', v, s, e}
  function tokenize(sql) {
    const out = []; const n = sql.length; let i = 0;
    const push = (t, s, e) => out.push({ t, v: sql.slice(s, e), s, e });
    while (i < n) {
      const c = sql[i], d = sql[i + 1];
      if (/\s/.test(c)) { let j = i + 1; while (j < n && /\s/.test(sql[j])) j++; push('ws', i, j); i = j; continue; }
      if ((c === '-' && d === '-') || c === '#' && /^#\s/.test(sql.slice(i, i + 2))) { let j = sql.indexOf('\n', i); if (j < 0) j = n; push('comment', i, j); i = j; continue; }
      if (c === '/' && d === '*') { let j = sql.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; push('comment', i, j); i = j; continue; }
      if (c === "'" || (c === '"' && false)) { let j = i + 1; while (j < n) { if (sql[j] === '\\') { j += 2; continue; } if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; } j++; } push('str', i, Math.min(n, j + 1)); i = j + 1; continue; }
      if (c === '$' && d === '$') { let j = sql.indexOf('$$', i + 2); j = j < 0 ? n : j + 2; push('str', i, j); i = j; continue; }
      if (c === '"' || c === '`' || c === '[') { const close = c === '[' ? ']' : c; let j = i + 1; while (j < n && sql[j] !== close) j++; push('qid', i, Math.min(n, j + 1)); i = j + 1; continue; }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(d || ''))) { let j = i + 1; while (j < n && /[0-9.eE]/.test(sql[j])) { if ((sql[j] === 'e' || sql[j] === 'E') && /[+-]/.test(sql[j + 1] || '')) j++; j++; } push('num', i, j); i = j; continue; }
      if (/[A-Za-z_\u00c0-\uffff@$]/.test(c)) { let j = i + 1; while (j < n && /[A-Za-z0-9_\u00c0-\uffff$]/.test(sql[j])) j++; push('id', i, j); i = j; continue; }
      const three = sql.slice(i, i + 3), two = sql.slice(i, i + 2);
      if (['<=>', '!~*'].includes(three)) { push('op', i, i + 3); i += 3; continue; }
      if (['<=', '>=', '<>', '!=', '||', '::', '=>', '->', '!~', '~*'].includes(two)) { push('op', i, i + 2); i += 2; continue; }
      if ('(),;.'.includes(c)) { push('punct', i, i + 1); i++; continue; }
      push('op', i, i + 1); i++;
    }
    return out;
  }
  const sig = (toks) => toks.filter((t) => t.t !== 'ws' && t.t !== 'comment');
  const unquote = (v) => {
    if (v == null) return '';
    v = String(v);
    if (/^["`\[]/.test(v)) return v.slice(1, -1);
    return v;
  };
  const kw = (tok, word) => tok && tok.t === 'id' && tok.v.toLowerCase() === word;
  const isKeyword = (w) => KEYWORDS.has(String(w).toLowerCase());
  // Normalise a (possibly quoted, dotted) table name to lowercase dot-joined parts.
  function normName(name) {
    return String(name || '').split('.').map((p) => unquote(p.trim()).toLowerCase()).filter(Boolean).join('.');
  }
  // Strip comments, collapse whitespace (used for share/history keys and comparisons).
  function squash(sql) { return sig(tokenize(sql)).map((t) => t.v).join(' '); }
  function stripComments(sql) { return tokenize(sql).filter((t) => t.t !== 'comment').map((t) => t.v).join(''); }
  // Split a script into statements on top-level semicolons.
  function splitStatements(sql) {
    const toks = tokenize(sql); const parts = []; let start = 0;
    toks.forEach((t) => { if (t.t === 'punct' && t.v === ';') { parts.push(sql.slice(start, t.s)); start = t.e; } });
    parts.push(sql.slice(start));
    return parts.map((p) => p.trim()).filter((p) => sig(tokenize(p)).length);
  }
  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  return { tokenize, sig, unquote, kw, isKeyword, normName, squash, stripComments, splitStatements, escapeRe, KEYWORDS };
});

/* QueryCost table catalog: sizes, columns, partitioning and clustering for the tables a query reads.
   Includes importers for CSV/TSV, pasted INFORMATION_SCHEMA-style output (psql/bq pipes too) and CREATE TABLE DDL. */
(function (root, factory) {
  const m = factory(typeof require === 'function' && typeof module === 'object' ? require('./sqlutil.js') : root.QC.sqlutil);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else (root.QC = root.QC || {}).catalog = m;
})(typeof self !== 'undefined' ? self : this, function (U) {
  'use strict';
  const GRANULARITIES = ['day', 'hour', 'month', 'year', 'value'];
  // Logical bytes per value, following BigQuery's data type sizes (STRING/BYTES = 2 + length).
  function typeWidth(type) {
    const t = String(type || '').toLowerCase().trim();
    const n = (re) => { const m = t.match(re); return m ? Number(m[1]) : null; };
    if (/^(bool|boolean|bit)\b/.test(t)) return 1;
    if (/^(tinyint|byteint)\b/.test(t)) return 8;
    if (/^(bignumeric|bigdecimal)/.test(t)) return 32;
    if (/^(numeric|decimal|number|money)/.test(t)) return 16;
    if (/^(int|integer|bigint|smallint|int64|int32|long|short|float|float64|float32|double|real|date|datetime|time|timestamp|timestamp_\w+|timestamptz)\b/.test(t)) return 8;
    if (/^interval/.test(t)) return 16;
    if (/^(char|nchar|character)\b/.test(t)) { const len = n(/\((\d+)\)/); return 2 + (len ? Math.min(len, 64) : 1); }
    if (/^(varchar|nvarchar|string|text|character varying|varchar2|bytes|binary|varbinary|blob|clob)/.test(t)) {
      const len = n(/\((\d+)\)/); return 2 + (len ? Math.max(1, Math.min(Math.round(len / 2), 48)) : 24);
    }
    if (/^(json|jsonb|variant|object|super)/.test(t)) return 96;
    if (/^(array|struct|map|record|repeated)/.test(t)) return 64;
    if (/^(geography|geometry)/.test(t)) return 64;
    if (/^uuid/.test(t)) return 18;
    return 16;
  }
  const typeFamily = (type) => {
    const t = String(type || '').toLowerCase();
    if (/^(bool|boolean|bit)/.test(t)) return 'bool';
    if (/^(tinyint|byteint|int|integer|bigint|smallint|int64|int32|long|short|float|double|real|numeric|decimal|number|bignumeric|money)/.test(t)) return 'number';
    if (/^(date|datetime|time|timestamp)/.test(t)) return 'time';
    if (/^(char|nchar|character|varchar|nvarchar|string|text|uuid)/.test(t)) return 'string';
    return t ? 'other' : 'unknown';
  };
  const clampNum = (v, d, min) => { const x = Number(v); return Number.isFinite(x) && x >= (min == null ? 0 : min) ? x : d; };
  function normColumn(c) {
    const type = String(c.type || '').trim() || 'STRING';
    return { name: U.unquote(String(c.name || '').trim()).toLowerCase(), type, width: clampNum(c.width, typeWidth(type), 0.01), nullable: c.nullable !== false, unique: !!c.unique };
  }
  function normTable(t) {
    const columns = (t.columns || []).map(normColumn).filter((c) => c.name);
    const seen = new Set(); const cols = columns.filter((c) => (seen.has(c.name) ? false : seen.add(c.name)));
    const p = t.partition && t.partition.column ? {
      column: U.unquote(String(t.partition.column)).toLowerCase(),
      granularity: GRANULARITIES.includes(t.partition.granularity) ? t.partition.granularity : 'day',
      count: Math.max(1, Math.round(clampNum(t.partition.count, 365, 1))),
      end: /^\d{4}-\d{2}-\d{2}/.test(t.partition.end || '') ? String(t.partition.end).slice(0, 10) : '',
    } : null;
    return {
      name: U.normName(t.name), rows: Math.round(clampNum(t.rows, 0)), compression: clampNum(t.compression, 4, 1),
      bytes: t.bytes ? clampNum(t.bytes, 0) : 0, partition: p,
      cluster: (t.cluster || []).map((x) => U.unquote(String(x).trim()).toLowerCase()).filter(Boolean),
      columns: cols, note: t.note ? String(t.note) : '', rowsGuessed: !!t.rowsGuessed,
    };
  }
  function normalize(cat) {
    const tables = ((cat && cat.tables) || []).map(normTable).filter((t) => t.name);
    const m = new Map(); tables.forEach((t) => m.set(t.name, t));
    return { name: (cat && cat.name) || 'Custom catalog', tables: [...m.values()] };
  }
  const widthSum = (t) => t.columns.reduce((s, c) => s + c.width, 0);
  // Scale factor so column widths add up to an imported byte total when one was given.
  const scaleOf = (t) => { const w = widthSum(t); return t.bytes && t.rows && w ? t.bytes / (t.rows * w) : 1; };
  function tableBytes(t) { if (t.bytes) return t.bytes; return t.rows * widthSum(t); }
  function columnBytes(t, col) { const c = t.columns.find((x) => x.name === col); return c ? t.rows * c.width * scaleOf(t) : 0; }
  const column = (t, name) => t && t.columns.find((c) => c.name === String(name).toLowerCase());
  // Find a table by the name used in SQL. Exact match first, then a unique suffix match either way.
  function find(cat, name) {
    const n = U.normName(name); if (!n) return null;
    const exact = cat.tables.find((t) => t.name === n); if (exact) return exact;
    const cands = cat.tables.filter((t) => n.endsWith('.' + t.name) || t.name.endsWith('.' + n));
    if (cands.length === 1) return cands[0];
    const last = n.split('.').pop(); const byLast = cat.tables.filter((t) => t.name.split('.').pop() === last);
    return byLast.length === 1 ? byLast[0] : null;
  }

  // ---------- Delimited import (CSV / TSV / pipe tables) ----------
  function splitLine(line, delim) {
    if (delim === '|') return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((s) => s.trim());
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true; else if (ch === delim) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    out.push(cur.trim()); return out;
  }
  function parseDelimited(text) {
    const lines = String(text).replace(/\r/g, '').split('\n').filter((l) => l.trim() && !/^\s*[+|]?[-=+| ]{3,}\s*$/.test(l) && !/^\(\d+ rows?\)$/.test(l.trim()));
    if (!lines.length) return [];
    const head = lines[0];
    const delim = head.includes('\t') ? '\t' : (head.includes('|') ? '|' : (head.split(';').length > head.split(',').length ? ';' : ','));
    const hdr = splitLine(head, delim).map((h) => h.toLowerCase().replace(/^"|"$/g, '').trim());
    return lines.slice(1).map((l) => { const cells = splitLine(l, delim); const o = {}; hdr.forEach((h, i) => { o[h] = cells[i] == null ? '' : cells[i]; }); return o; });
  }
  const ALIASES = {
    table: ['table_name', 'table', 'tablename', 'relname', 'table_id'], schema: ['table_schema', 'schema', 'schema_name', 'dataset', 'dataset_id', 'database', 'nspname'],
    column: ['column_name', 'column', 'field', 'field_path', 'attname'], type: ['data_type', 'type', 'column_type', 'datatype'],
    rows: ['row_count', 'rows', 'num_rows', 'reltuples', 'total_rows', 'numrows'], bytes: ['bytes', 'total_bytes', 'size_bytes', 'total_logical_bytes', 'logical_bytes', 'active_logical_bytes', 'size'],
    width: ['avg_width', 'avg_bytes', 'width', 'avg_col_width', 'avg_size'], nullable: ['is_nullable', 'nullable'],
    isPartition: ['is_partitioning_column', 'partitioning_column', 'is_partition'], clusterPos: ['clustering_ordinal_position', 'cluster_position'],
    partitionColumn: ['partition_column', 'partition_by', 'partitioned_by'], partitionCount: ['partition_count', 'partitions', 'total_partitions', 'num_partitions'],
    granularity: ['partition_granularity', 'granularity', 'partition_type'], cluster: ['cluster_columns', 'clustering_key', 'cluster_by', 'clustering_columns', 'sortkey', 'sort_key'],
    unique: ['is_unique', 'unique', 'primary_key', 'is_primary_key', 'pk'], compression: ['compression', 'compression_ratio'],
  };
  const pick = (row, key) => { for (const a of ALIASES[key]) if (row[a] != null && row[a] !== '') return row[a]; return null; };
  const yes = (v) => /^(y|yes|true|t|1)$/i.test(String(v || '').trim());
  const num = (v) => { if (v == null || v === '') return null; const s = String(v).replace(/[, _]/g, ''); const m = s.match(/^([\d.]+)\s*([kmgtp]i?b?|[kmb])?$/i); if (!m) return Number.isFinite(Number(s)) ? Number(s) : null; const x = Number(m[1]); const u = (m[2] || '').toLowerCase(); const mult = { k: 1e3, m: 1e6, b: 1e9, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, pib: 1024 ** 5 }[u] || 1; return x * mult; };
  function clusterList(v) { return String(v || '').replace(/^\s*linear\s*\(/i, '').replace(/[()]/g, '').split(/[,\s]+/).map((s) => U.unquote(s).toLowerCase()).filter((s) => s && !/^(linear|compound|interleaved)$/.test(s)); }
  // Turns pasted rows into catalog tables. Column-level rows (have a column name) and table-level rows can be mixed.
  function fromRows(rows) {
    const tabs = new Map();
    const get = (name) => { const k = U.normName(name); if (!tabs.has(k)) tabs.set(k, { name: k, rows: 0, columns: [], cluster: [], partition: null, _cpos: [] }); return tabs.get(k); };
    let warnings = 0;
    rows.forEach((r) => {
      const tn = pick(r, 'table'); if (!tn) { warnings++; return; }
      const sch = pick(r, 'schema'); const t = get(sch && !String(tn).includes('.') ? sch + '.' + tn : tn);
      const rc = num(pick(r, 'rows')); if (rc != null) t.rows = rc;
      const by = num(pick(r, 'bytes')); if (by != null && (!pick(r, 'column') || !t.bytes)) t.bytes = by;
      const pc = pick(r, 'partitionColumn'); if (pc) t.partition = Object.assign(t.partition || {}, { column: pc });
      const pn = num(pick(r, 'partitionCount')); if (pn != null) t.partition = Object.assign(t.partition || { column: '' }, { count: pn });
      const gr = pick(r, 'granularity'); if (gr && t.partition) t.partition.granularity = String(gr).toLowerCase().replace(/ly$/, '').replace(/^dai$/, 'day');
      const cl = pick(r, 'cluster'); if (cl) t.cluster = clusterList(cl);
      const cr = num(pick(r, 'compression')); if (cr) t.compression = cr;
      const cn = pick(r, 'column');
      if (cn) {
        const type = pick(r, 'type') || 'STRING'; const w = num(pick(r, 'width'));
        t.columns.push({ name: cn, type, width: w != null ? w : undefined, nullable: pick(r, 'nullable') == null ? true : yes(pick(r, 'nullable')), unique: yes(pick(r, 'unique')) });
        if (yes(pick(r, 'isPartition'))) t.partition = Object.assign({ count: 365 }, t.partition || {}, { column: cn, granularity: (t.partition && t.partition.granularity) || (/date|time/i.test(type) ? 'day' : 'value') });
        const cp = num(pick(r, 'clusterPos')); if (cp) t._cpos.push([cp, cn]);
      }
    });
    const tables = [...tabs.values()].map((t) => {
      if (t._cpos.length) t.cluster = t._cpos.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
      if (t.partition && !t.partition.column) t.partition = null;
      if (!t.rows) { t.rows = 1000000; t.rowsGuessed = true; }
      delete t._cpos; return normTable(t);
    });
    return { tables, warnings };
  }
  function importDelimited(text) { return fromRows(parseDelimited(text)); }

  // ---------- DDL import ----------
  function splitTop(s) { const out = []; let depth = 0, cur = '', q = null; for (const ch of s) { if (q) { cur += ch; if (ch === q) q = null; continue; } if (ch === "'" || ch === '"' || ch === '`') { q = ch; cur += ch; continue; } if (ch === '(' || ch === '<') depth++; if (ch === ')' || ch === '>') depth--; if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; }
  function matchParen(s, open) { let d = 0; for (let i = open; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (!d) return i; } } return s.length; }
  function partFromExpr(expr, cols) {
    const e = expr.trim(); const lower = e.toLowerCase();
    const ids = (e.match(/[`"]?[A-Za-z_][\w$]*[`"]?/g) || []).map((x) => U.unquote(x).toLowerCase());
    const col = ids.find((i) => cols.some((c) => c.name === i)) || ids.find((i) => !/^(date|date_trunc|timestamp_trunc|datetime_trunc|range_bucket|generate_array|day|month|year|hour|days|months|years|hours|identity|bucket|truncate)$/.test(i));
    let gran = 'day';
    if (/\bmonth\b|months\(/.test(lower)) gran = 'month'; else if (/\byear\b|years\(/.test(lower)) gran = 'year'; else if (/\bhour\b|hours\(/.test(lower)) gran = 'hour';
    else if (/range_bucket|bucket\(/.test(lower)) gran = 'value';
    else { const c = cols.find((x) => x.name === col); if (c && !/date|time/i.test(c.type) && !/date|day/.test(lower)) gran = 'value'; }
    return col ? { column: col, granularity: gran, count: { day: 365, hour: 24 * 30, month: 24, year: 5, value: 20 }[gran] } : null;
  }
  function parseDDL(text) {
    const tables = []; const src = U.stripComments(String(text));
    const re = /create\s+(?:or\s+replace\s+)?(?:(?:global|local|transient|temporary|temp|external|volatile|multiset|unlogged)\s+)*table\s+(?:if\s+not\s+exists\s+)?([`"\[\]\w.$-]+(?:\s*\.\s*[`"\[\]\w$-]+)*)\s*\(/gi;
    let m;
    while ((m = re.exec(src))) {
      const open = m.index + m[0].length - 1; const close = matchParen(src, open);
      const body = src.slice(open + 1, close); let rest = src.slice(close + 1); const semi = rest.search(/;|create\s+(?:or\s+replace\s+)?\w*\s*table/i); if (semi >= 0) rest = rest.slice(0, semi);
      const cols = []; const pk = [];
      splitTop(body).forEach((def) => {
        const d = def.trim(); if (!d) return;
        const pkm = d.match(/^(?:constraint\s+\S+\s+)?(primary\s+key|unique)\s*\(([^)]*)\)/i); if (pkm) { pkm[2].split(',').forEach((x) => pk.push(U.unquote(x.trim()).toLowerCase())); return; }
        if (/^(constraint|foreign\s+key|index|key|check|period|partition|cluster|sortkey|distkey|primary)\b/i.test(d)) return;
        const cm = d.match(/^([`"\[]?[^\s`"\]]+[`"\]]?)\s+(.+)$/s); if (!cm) return;
        const name = U.unquote(cm[1]).toLowerCase(); const rest2 = cm[2];
        let type = rest2.match(/^([A-Za-z_][\w ]*?(?:\s*\([^)]*\))?(?:\s*<.*>)?)(?=\s+(?:not|null|default|primary|unique|references|options|comment|encode|collate|generated|identity|autoincrement|check|constraint|masking|with|sortkey|distkey)\b|\s*$)/i);
        type = type ? type[1].trim() : rest2.split(/\s+/)[0];
        cols.push({ name, type, nullable: !/not\s+null|primary\s+key/i.test(rest2), unique: /primary\s+key|\bunique\b/i.test(rest2) });
      });
      pk.forEach((k) => { const c = cols.find((x) => x.name === k); if (c && pk.length === 1) c.unique = true; });
      let partition = null, cluster = [];
      const pb = rest.match(/partition(?:ed)?\s+by\s*(\((?:[^()]|\([^()]*\))*\)|[^\n;]+?)(?=\s+(?:cluster|options|location|stored|tblproperties|row|with|as|comment|sortkey|distkey|lifecycle)\b|\s*$|;)/i);
      if (pb) {
        let expr = pb[1].trim(); if (expr.startsWith('(') && /^\(\s*[`"]?\w+[`"]?\s+[a-z]/i.test(expr)) { // Hive/Athena: PARTITIONED BY (dt string, region string)
          splitTop(expr.slice(1, -1)).forEach((d, i) => { const [n, ...ty] = d.trim().split(/\s+/); const nm = U.unquote(n).toLowerCase(); if (!cols.some((c) => c.name === nm)) cols.push({ name: nm, type: ty.join(' ') || 'STRING', nullable: false }); if (i === 0) partition = { column: nm, granularity: /date|dt|day/i.test(nm) ? 'day' : 'value', count: /date|dt|day/i.test(nm) ? 365 : 20 }; });
        } else partition = partFromExpr(expr.replace(/^\(|\)$/g, ''), cols);
      }
      const cb = rest.match(/(?:cluster\s+by|(?:compound\s+|interleaved\s+)?sortkey|zorder\s+by)\s*(?:linear\s*)?\(?([^)\n;]+)\)?/i);
      if (cb) cluster = clusterList(cb[1]).filter((x) => cols.some((c) => c.name === x));
      tables.push(normTable({ name: m[1].replace(/\s+/g, ''), rows: 1000000, rowsGuessed: true, columns: cols, partition, cluster }));
    }
    return { tables, warnings: tables.length ? 0 : 1 };
  }
  // Auto-detect format: DDL, JSON catalog, or delimited rows.
  function importText(text) {
    const s = String(text || '').trim();
    if (!s) return { tables: [], format: 'empty', warnings: 1 };
    if (/^[{[]/.test(s)) { try { const j = JSON.parse(s); const cat = normalize(Array.isArray(j) ? { tables: j } : j); return { tables: cat.tables, format: 'json', warnings: 0 }; } catch (e) { /* fall through */ } }
    if (/create\s+(?:or\s+replace\s+)?(?:\w+\s+)*table/i.test(s)) return Object.assign(parseDDL(s), { format: 'ddl' });
    return Object.assign(importDelimited(s), { format: 'delimited' });
  }
  // Merge imported tables into a catalog; same-named tables are replaced, but known sizes survive a DDL import.
  function merge(cat, tables, mode) {
    const base = mode === 'replace' ? [] : cat.tables.slice();
    tables.forEach((t) => {
      const i = base.findIndex((x) => x.name === t.name);
      if (i < 0) { base.push(t); return; }
      const old = base[i]; const nt = Object.assign({}, t);
      if (t.rowsGuessed && !old.rowsGuessed) { nt.rows = old.rows; nt.rowsGuessed = false; if (!nt.bytes) nt.bytes = old.bytes; }
      if (!nt.partition && old.partition) nt.partition = old.partition;
      if (!nt.cluster.length && old.cluster.length) nt.cluster = old.cluster;
      nt.columns = t.columns.length ? t.columns.map((c) => { const oc = old.columns.find((x) => x.name === c.name); return oc && c.width === typeWidth(c.type) && oc.type.toLowerCase() === c.type.toLowerCase() ? Object.assign({}, c, { width: oc.width }) : c; }) : old.columns;
      base[i] = normTable(nt);
    });
    return { name: cat.name, tables: base };
  }
  function toCSV(cat) {
    const q = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = ['table_name,row_count,total_bytes,compression,partition_column,partition_granularity,partition_count,cluster_columns,column_name,data_type,avg_width,is_nullable,is_unique'];
    cat.tables.forEach((t) => t.columns.forEach((c, i) => lines.push([t.name, i ? '' : t.rows, i ? '' : (t.bytes || ''), i ? '' : t.compression, i || !t.partition ? '' : t.partition.column, i || !t.partition ? '' : t.partition.granularity, i || !t.partition ? '' : t.partition.count, i ? '' : t.cluster.join(' '), c.name, c.type, c.width, c.nullable ? 'YES' : 'NO', c.unique ? 'YES' : 'NO'].map(q).join(','))));
    return lines.join('\n') + '\n';
  }
  return { typeWidth, typeFamily, normalize, normTable, normColumn, tableBytes, columnBytes, column, find, widthSum, scaleOf, parseDelimited, importDelimited, parseDDL, importText, merge, toCSV, GRANULARITIES };
});

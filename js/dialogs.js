/* QueryCost dialogs: templates, catalog, table editor, import, assumptions, history, share, export and help.
   Every dialog closes with X, Cancel, Esc, a backdrop click or browser Back; edited forms ask before discarding. */
(function (root) {
  'use strict';
  const QC = root.QC; const { h, toast, openModal } = QC.ui; const C = QC.catalog, PR = QC.pricing, T = QC.templates, E = QC.estimate;
  const money = E.fmtMoney, bytes = E.fmtBytes;
  const fmtRows = (n) => Number(n).toLocaleString('en-US');
  const fmtDate = (iso) => { try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return iso; } };

  // ---------- Templates & samples ----------
  function templates(app) {
    let current = app.state.templateId && T.byId(app.state.templateId) ? app.state.templateId : 'ecommerce';
    const grid = h('div', { class: 'tpl-grid', role: 'group', 'aria-label': 'Templates' }); const list = h('div', { class: 'list' });
    const draw = () => {
      grid.textContent = ''; list.textContent = '';
      T.TEMPLATES.forEach((t) => grid.append(h('button', { type: 'button', class: 'tpl', 'aria-pressed': String(t.id === current), onclick: () => { current = t.id; draw(); } },
        h('b', { text: t.name }), h('span', { text: t.description }), h('span', { text: t.catalog.tables.length + ' tables · ' + t.queries.length + ' queries · default ' + PR.WAREHOUSES.find((w) => w.id === t.warehouse).name }))));
      const t = T.byId(current);
      t.queries.forEach((q) => list.append(h('div', { class: 'item' }, h('div', { class: 'meta' }, h('b', { text: q.name }), h('span', { text: q.sql.replace(/\s+/g, ' ').slice(0, 110) + (q.sql.length > 110 ? '…' : '') })),
        h('button', { class: 'btn small primary', type: 'button', text: 'Open', onclick: () => { m.closeNow().then(() => openQuery(app, t, q)); } }))));
    };
    const m = openModal({ title: 'Templates and sample queries', size: 'wide', cancelLabel: 'Close',
      body: [h('p', { class: 'small muted', text: 'Each template has a sample catalog (sizes are illustrative) and queries that show off the estimator and the lint rules. Opening a query also loads its catalog.' }), grid, h('h3', { text: 'Queries' }), list],
      actions: [{ label: 'Load catalog only', onClick: () => { const t = T.byId(current); app.replaceState({ catalog: t.catalog, templateId: t.id }, 'Loaded the ' + t.name + ' catalog'); } }] });
    draw();
  }
  function openQuery(app, t, q) {
    const patch = { sql: q.sql, name: q.name, warehouse: t.warehouse, schedule: Object.assign({}, app.state.schedule, q.schedule), templateId: t.id };
    if (app.state.templateId !== t.id || app.state.catalog.name !== t.catalog.name) patch.catalog = t.catalog;
    app.replaceState(patch, 'Opened "' + q.name + '"');
  }

  // ---------- Catalog ----------
  function catalog(app) {
    const list = h('div', { class: 'list' }); const nameIn = h('input', { class: 'field', type: 'text', value: app.state.catalog.name, 'aria-label': 'Catalog name', onchange: (e) => { const cat = app.state.catalog; app.commitCatalog(Object.assign({}, cat, { name: e.target.value.trim() || 'Custom catalog' })); } });
    const draw = () => {
      list.textContent = ''; const cat = app.state.catalog;
      if (!cat.tables.length) list.append(h('div', { class: 'empty' }, h('b', { text: 'No tables yet' }), h('p', { class: 'small', text: 'Add a table, import CSV / INFORMATION_SCHEMA output / DDL, or load a template.' })));
      cat.tables.forEach((t, i) => list.append(h('div', { class: 'item', 'data-table': t.name },
        h('div', { class: 'meta' }, h('b', { text: t.name }), h('span', { text: fmtRows(t.rows) + ' rows · ' + bytes(C.tableBytes(t)) + ' · ' + t.columns.length + ' columns' + (t.partition ? ' · partitioned by ' + t.partition.column + ' (' + t.partition.count + ' ' + t.partition.granularity + ')' : '') + (t.cluster.length ? ' · clustered by ' + t.cluster.join(', ') : '') + (t.rowsGuessed ? ' · rows guessed' : '') })),
        h('button', { class: 'btn small', type: 'button', text: 'Edit', 'aria-label': 'Edit ' + t.name, onclick: () => table(app, t, null, draw) }),
        h('button', { class: 'btn small danger', type: 'button', text: 'Delete', 'aria-label': 'Delete ' + t.name, onclick: () => {
          const cat2 = app.state.catalog; const removed = cat2.tables[i]; app.commitCatalog(Object.assign({}, cat2, { tables: cat2.tables.filter((_, k) => k !== i) })); draw();
          toast('Deleted ' + removed.name, { action: 'Undo', onAction: () => { const c3 = app.state.catalog; const tb = c3.tables.slice(); tb.splice(Math.min(i, tb.length), 0, removed); app.commitCatalog(Object.assign({}, c3, { tables: tb })); draw(); } });
        } }))));
    };
    openModal({ title: 'Table catalog', size: 'wide', cancelLabel: 'Close',
      body: [h('div', { class: 'row' }, h('label', { class: 'small muted', for: 'catName', text: 'Name' }), Object.assign(nameIn, { id: 'catName' }), h('span', { class: 'small muted grow', text: 'Sizes drive every estimate. Compression ratio converts logical bytes to stored bytes for Snowflake, Databricks, Redshift and Athena.' })), list],
      footLeft: [h('button', { class: 'btn', type: 'button', text: 'Export CSV', onclick: () => QC.ui.download('querycost-catalog.csv', C.toCSV(app.state.catalog), 'text/csv') }),
        h('button', { class: 'btn danger', type: 'button', text: 'Remove all', onclick: () => { const before = app.state.catalog; if (!before.tables.length) return; app.commitCatalog(Object.assign({}, before, { tables: [] })); draw(); toast('Removed all tables', { action: 'Undo', onAction: () => { app.commitCatalog(before); draw(); } }); } })],
      actions: [{ label: 'Import…', close: false, onClick: () => importDialog(app, draw) }, { label: 'Add table', kind: 'primary', close: false, onClick: () => table(app, null, null, draw) }] });
    draw();
  }

  // ---------- Table editor ----------
  function table(app, existing, prefill, onDone) {
    const src = existing || C.normTable(Object.assign({ name: '', rows: 1000000, columns: [] }, prefill || {}));
    const f = { name: src.name, rows: String(src.rows), bytes: src.bytes ? String(src.bytes) : '', compression: String(src.compression || 4), pcol: src.partition ? src.partition.column : '', gran: src.partition ? src.partition.granularity : 'day', pcount: src.partition ? String(src.partition.count) : '365', pend: src.partition && src.partition.end ? src.partition.end : '', cluster: src.cluster.join(', '), note: src.note || '',
      cols: src.columns.length ? src.columns.map((c) => ({ name: c.name, type: c.type, width: String(+c.width.toFixed(2)), nullable: c.nullable, unique: c.unique })) : [{ name: '', type: 'STRING', width: String(C.typeWidth('STRING')), nullable: true, unique: false }] };
    const initial = JSON.stringify(f);
    const err = h('p', { class: 'err', role: 'alert' });
    const inp = (key, label, attrs) => h('label', null, label, h('input', Object.assign({ type: 'text', value: f[key], oninput: (e) => { f[key] = e.target.value; } }, attrs || {})));
    const pcolSel = h('select', { onchange: (e) => { f.pcol = e.target.value; } });
    const fillPcol = () => { pcolSel.textContent = ''; pcolSel.append(h('option', { value: '', text: '(not partitioned)' })); f.cols.filter((c) => c.name.trim()).forEach((c) => pcolSel.append(h('option', { value: c.name.trim().toLowerCase(), text: c.name.trim(), selected: c.name.trim().toLowerCase() === f.pcol }))); if (f.pcol && ![...pcolSel.options].some((o) => o.value === f.pcol)) pcolSel.append(h('option', { value: f.pcol, text: f.pcol, selected: true })); };
    const grid = h('div', { class: 'cols-grid', role: 'group', 'aria-label': 'Columns' });
    const drawCols = () => {
      grid.textContent = ''; ['Column', 'Type', 'Avg bytes', 'Null', 'Unique', ''].forEach((t) => grid.append(h('span', { class: 'h', text: t })));
      f.cols.forEach((c, i) => {
        grid.append(h('input', { type: 'text', value: c.name, 'aria-label': 'Column ' + (i + 1) + ' name', oninput: (e) => { c.name = e.target.value; }, onchange: fillPcol }),
          h('input', { type: 'text', value: c.type, 'aria-label': 'Column ' + (i + 1) + ' type', oninput: (e) => { c.type = e.target.value; }, onchange: (e) => { const w = grid.querySelector('[data-w="' + i + '"]'); if (w && !c.widthEdited) { c.width = String(C.typeWidth(e.target.value)); w.value = c.width; } } }),
          h('input', { type: 'number', min: '0', step: 'any', value: c.width, 'data-w': String(i), 'aria-label': 'Column ' + (i + 1) + ' average bytes', oninput: (e) => { c.width = e.target.value; c.widthEdited = true; } }),
          h('input', { type: 'checkbox', class: 'ck', checked: c.nullable, 'aria-label': 'Column ' + (i + 1) + ' nullable', onchange: (e) => { c.nullable = e.target.checked; } }),
          h('input', { type: 'checkbox', class: 'ck', checked: c.unique, 'aria-label': 'Column ' + (i + 1) + ' unique', onchange: (e) => { c.unique = e.target.checked; } }),
          h('button', { class: 'btn ghost icon-btn small', type: 'button', 'aria-label': 'Remove column ' + (c.name || i + 1), text: '×', onclick: () => { const [rm] = f.cols.splice(i, 1); drawCols(); fillPcol(); toast('Removed column ' + (rm.name || ''), { action: 'Undo', onAction: () => { f.cols.splice(i, 0, rm); drawCols(); fillPcol(); } }); } }));
      });
    };
    drawCols(); fillPcol();
    const body = [
      h('div', { class: 'form' },
        inp('name', 'Table name *', { placeholder: 'dataset.table', autocomplete: 'off', spellcheck: 'false', 'aria-required': 'true' }),
        inp('rows', 'Rows', { inputmode: 'numeric', placeholder: '1000000' }),
        inp('bytes', 'Total size (optional)', { placeholder: 'e.g. 64 GB' }),
        inp('compression', 'Compression ratio', { inputmode: 'decimal' }),
        h('label', null, 'Partition column', pcolSel),
        h('label', null, 'Partition granularity', (() => { const s = h('select', { onchange: (e) => { f.gran = e.target.value; } }); C.GRANULARITIES.forEach((g) => s.append(h('option', { value: g, text: g, selected: g === f.gran }))); return s; })()),
        inp('pcount', 'Partition count', { inputmode: 'numeric' }),
        inp('pend', 'Latest partition (default today)', { placeholder: 'YYYY-MM-DD' }),
        h('label', { class: 'full' }, 'Cluster / sort keys (in order)', h('input', { type: 'text', value: f.cluster, placeholder: 'customer_id, status', oninput: (e) => { f.cluster = e.target.value; } })),
        h('label', { class: 'full' }, 'Note', h('input', { type: 'text', value: f.note, oninput: (e) => { f.note = e.target.value; } }))),
      h('div', { class: 'row' }, h('h3', { class: 'grow', text: 'Columns' }), h('button', { class: 'btn small', type: 'button', text: 'Add column', onclick: () => { f.cols.push({ name: '', type: 'STRING', width: String(C.typeWidth('STRING')), nullable: true, unique: false }); drawCols(); const ins = grid.querySelectorAll('input[type=text]'); ins[ins.length - 2] && ins[ins.length - 2].focus(); } })),
      h('p', { class: 'small muted', text: 'Average bytes per value drive column pruning. Defaults follow BigQuery data-type sizes; mark key columns Unique so QueryCost can spot many-to-many joins.' }),
      grid, err];
    const parseNum = (s) => { const m = String(s).trim().replace(/,/g, '').match(/^([\d.]+(?:e\d+)?)\s*([kmgtp]?i?b?)?$/i); if (!m) return NaN; const u = (m[2] || '').toLowerCase(); const p = { '': 0, k: 1, m: 2, g: 3, t: 4, p: 5 }[u[0] || ''] || 0; const base = u.includes('i') ? 1024 : (u.endsWith('b') ? 1000 : 1000); return Number(m[1]) * Math.pow(u ? base : 1, p); };
    const save = () => {
      const name = C.normTable({ name: f.name }).name; err.textContent = '';
      if (!name) { err.textContent = 'Give the table a name.'; body[0].querySelector('input').focus(); return false; }
      const others = app.state.catalog.tables.filter((t) => !existing || t.name !== existing.name);
      if (others.some((t) => t.name === name)) { err.textContent = 'A table named ' + name + ' already exists.'; return false; }
      const rows = parseNum(f.rows); if (!(rows >= 0)) { err.textContent = 'Rows must be a number.'; return false; }
      const by = f.bytes.trim() ? parseNum(f.bytes) : null; if (f.bytes.trim() && !(by >= 0)) { err.textContent = 'Size must look like 64 GB or 68719476736.'; return false; }
      const t = C.normTable({ name, rows, bytes: by, compression: Number(f.compression) || 4, partition: f.pcol ? { column: f.pcol, granularity: f.gran, count: Number(f.pcount) || 365, end: f.pend.trim() || null } : null,
        cluster: f.cluster.split(/[,\s]+/).filter(Boolean), note: f.note, columns: f.cols.filter((c) => c.name.trim()).map((c) => ({ name: c.name, type: c.type, width: Number(c.width) || undefined, nullable: c.nullable, unique: c.unique })) });
      const cat = app.state.catalog; const tables = cat.tables.slice(); const i = existing ? tables.findIndex((x) => x.name === existing.name) : -1;
      if (i >= 0) tables[i] = t; else tables.push(t);
      app.commitCatalog(Object.assign({}, cat, { tables })); toast((existing ? 'Updated ' : 'Added ') + t.name); onDone && onDone(); return true;
    };
    openModal({ title: existing ? 'Edit ' + existing.name : 'Add table', size: 'wide', body, isDirty: () => JSON.stringify(f) !== initial, actions: [{ label: existing ? 'Save table' : 'Add table', kind: 'primary', onClick: save }] });
  }

  // ---------- Import ----------
  function importDialog(app, onDone) {
    const ta = h('textarea', { class: 'field big', 'aria-label': 'Catalog text to import', spellcheck: 'false', placeholder: 'Paste CSV, INFORMATION_SCHEMA output, CREATE TABLE statements or QueryCost JSON…' });
    const preview = h('div', { class: 'small', 'aria-live': 'polite' }); let parsed = null; let mode = 'merge';
    const update = () => {
      preview.textContent = ''; parsed = null; const text = ta.value.trim(); if (!text) return;
      try { parsed = C.importText(text); } catch (e) { preview.append(h('span', { class: 'err', text: 'Could not read that: ' + e.message })); return; }
      if (!parsed.tables.length) { preview.append(h('span', { class: 'err', text: 'No tables found. Check the header row or DDL.' })); parsed = null; return; }
      preview.append(h('b', { text: parsed.tables.length + ' table' + (parsed.tables.length > 1 ? 's' : '') + ' found (' + parsed.format + '): ' }), parsed.tables.map((t) => t.name + ' (' + t.columns.length + ' cols' + (t.rowsGuessed ? ', rows guessed' : ', ' + fmtRows(t.rows) + ' rows') + ')').join(', '));
    };
    ta.addEventListener('input', QC.ui.debounce(update, 200));
    const file = h('input', { type: 'file', accept: '.csv,.tsv,.txt,.sql,.ddl,.json', 'aria-label': 'Import from file', onchange: async (e) => { const fl = e.target.files[0]; if (!fl) return; ta.value = await fl.text(); update(); } });
    const radios = h('div', { class: 'row small', role: 'radiogroup', 'aria-label': 'Import mode' },
      h('label', null, h('input', { type: 'radio', name: 'impmode', value: 'merge', checked: true, onchange: () => { mode = 'merge'; } }), ' Merge (same-named tables are updated)'),
      h('label', null, h('input', { type: 'radio', name: 'impmode', value: 'replace', onchange: () => { mode = 'replace'; } }), ' Replace the catalog'));
    const help = h('details', { class: 'box small' }, h('summary', { text: 'Accepted formats' }),
      h('p', { text: 'CSV / TSV with a header. Recognised columns include table_name, row_count, total_bytes (or size_bytes), column_name, data_type, avg_width, is_nullable, partition_column, partition_granularity, partition_count, clustering_ordinal_position, cluster_columns, is_unique. One row per column.' }),
      h('pre', { class: 'code', text: 'table_name,row_count,total_bytes,column_name,data_type,is_partitioning_column,clustering_ordinal_position\nshop.orders,2400000000,180 GB,order_id,INT64,NO,\nshop.orders,,,order_date,DATE,YES,\nshop.orders,,,customer_id,INT64,NO,1' }),
      h('p', { text: 'BigQuery: SELECT table_name, column_name, data_type, is_partitioning_column, clustering_ordinal_position FROM dataset.INFORMATION_SCHEMA.COLUMNS, then add row_count / total_bytes from INFORMATION_SCHEMA.TABLE_STORAGE. Snowflake: INFORMATION_SCHEMA.COLUMNS joined to TABLES (ROW_COUNT, BYTES, CLUSTERING_KEY).' }),
      h('p', { text: 'DDL: CREATE TABLE … PARTITION BY / PARTITIONED BY / CLUSTER BY / SORTKEY. Row counts default to 1,000,000 until you edit them.' }));
    openModal({ title: 'Import tables', size: 'wide', body: [h('div', { class: 'row' }, file), ta, preview, radios, help], isDirty: () => !!ta.value.trim(),
      actions: [{ label: 'Import', kind: 'primary', onClick: () => {
        if (!parsed) { update(); if (!parsed) { preview.prepend(h('span', { class: 'err', text: 'Nothing to import yet. ' })); return false; } }
        const before = app.state.catalog; app.commitCatalog(C.merge(before, parsed.tables, mode)); onDone && onDone();
        toast('Imported ' + parsed.tables.length + ' table' + (parsed.tables.length > 1 ? 's' : ''), { action: 'Undo', onAction: () => { app.commitCatalog(before); onDone && onDone(); } });
      } }] });
  }

  // ---------- Assumptions / prices ----------
  function settings(app, focusWh) {
    const work = JSON.parse(JSON.stringify(app.state.settings)); const initial = JSON.stringify(work); const defs = PR.defaults();
    const container = h('div', { class: 'list' });
    const field = (obj, key, label, step) => h('label', null, label, h('input', { type: 'number', step: step || 'any', min: '0', value: String(obj[key]), oninput: (e) => { const v = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(v) && v >= 0) obj[key] = v; } }));
    const section = (id, title, fields, open) => h('details', { class: 'box', open: open, 'data-wh': id }, h('summary', { text: title }), h('div', { class: 'form', style: { marginTop: '8px' } }, fields),
      PR.SOURCES[id] ? h('ul', { class: 'src' }, PR.SOURCES[id].map((s) => h('li', null, h('a', { href: s.url, target: '_blank', rel: 'noopener', text: s.label })))) : null);
    const draw = () => {
      container.textContent = ''; const S = work;
      container.append(h('p', { class: 'small muted', text: 'List prices checked ' + S.asOf + ' (US regions, on-demand). Change them to match your contract or region; estimates update when you save.' }));
      container.append(section('bigquery', 'BigQuery', [field(S.bigquery, 'perTiB', '$ per TiB (on-demand)'), field(S.bigquery, 'minTableMB', 'Min MB per table'), field(S.bigquery, 'minQueryMB', 'Min MB per query'), field(S.bigquery, 'freeTiB', 'Free TiB per month'),
        field(S.bigquery.slotHour, 'standard', '$/slot-hour Standard'), field(S.bigquery.slotHour, 'enterprise', '$/slot-hour Enterprise'), field(S.bigquery.slotHour, 'enterprise_plus', '$/slot-hour Ent. Plus'), field(S.bigquery, 'slotSecPerGiB', 'Slot-seconds per GiB')], focusWh === 'bigquery'));
      container.append(section('snowflake', 'Snowflake', [field(S.snowflake.creditPrice, 'standard', '$/credit Standard'), field(S.snowflake.creditPrice, 'enterprise', '$/credit Enterprise'), field(S.snowflake.creditPrice, 'business_critical', '$/credit Business Critical'), field(S.snowflake.creditPrice, 'vps', '$/credit VPS'),
        field(S.snowflake, 'gbpsXS', 'XS scan GB/s (doubles per size)'), field(S.snowflake, 'minSeconds', 'Minimum seconds on resume'), field(S.snowflake, 'idleSeconds', 'Idle seconds billed per run'), field(S.snowflake, 'gen2Multiplier', 'Gen2 credit multiplier'), field(S.snowflake, 'gen2Speedup', 'Gen2 speed-up')], focusWh === 'snowflake'));
      container.append(section('databricks', 'Databricks SQL', [field(S.databricks.dbuPrice, 'serverless', '$/DBU Serverless'), field(S.databricks.dbuPrice, 'pro', '$/DBU Pro'), field(S.databricks.dbuPrice, 'classic', '$/DBU Classic'), field(S.databricks, 'vmPerDbuHour', 'Cloud VM $ per DBU-hour (Pro/Classic)'),
        field(S.databricks, 'gbpsPerDbu', 'Scan GB/s per DBU'), field(S.databricks, 'idleSeconds', 'Idle seconds billed per run')], focusWh === 'databricks'));
      container.append(section('redshift', 'Redshift', [field(S.redshift, 'rpuHour', '$/RPU-hour (Serverless)'), field(S.redshift, 'minSeconds', 'Minimum seconds'), field(S.redshift, 'gbpsPerRpu', 'Scan GB/s per RPU'), field(S.redshift, 'idleSeconds', 'Idle seconds billed per run'),
        ...Object.keys(S.redshift.nodePrice).map((n) => field(S.redshift.nodePrice, n, '$/hour ' + n))], focusWh === 'redshift'));
      container.append(section('athena', 'Athena', [field(S.athena, 'perTB', '$ per TB scanned'), field(S.athena, 'minMB', 'Minimum MB per query')], focusWh === 'athena'));
      container.append(section('model', 'Estimation model (all warehouses)', [field(S.model, 'overheadSec', 'Overhead seconds'), field(S.model, 'joinFactor', 'Work per join'), field(S.model, 'aggFactor', 'Work for aggregation'), field(S.model, 'sortFactor', 'Work for sort'), field(S.model, 'distinctFactor', 'Work for DISTINCT'), field(S.model, 'windowFactor', 'Work for window functions'), field(S.model, 'countDistinctFactor', 'Work for COUNT(DISTINCT)'),
        field(S.model, 'explosionFactor', '× for row explosion'), field(S.model, 'crossJoinFactor', '× for cross join'), field(S.model, 'correlatedFactor', '× for correlated subquery'), field(S.model, 'unknownRangeKeep', 'Partitions kept, unknown bounds (0–1)'), field(S.model, 'clusterEqKeep', 'Cluster keep, equality (0–1)'), field(S.model, 'clusterRangeKeep', 'Cluster keep, range (0–1)'), field(S.model, 'clusterSecondaryKeep', 'Cluster keep, later key (0–1)')], false));
    };
    draw();
    openModal({ title: 'Prices and assumptions', size: 'wide', body: container, isDirty: () => JSON.stringify(work) !== initial,
      footLeft: h('button', { class: 'btn', type: 'button', text: 'Reset to defaults', onclick: () => { Object.keys(defs).forEach((k) => { work[k] = JSON.parse(JSON.stringify(defs[k])); }); draw(); toast('Defaults restored in the form. Save to apply.'); } }),
      actions: [{ label: 'Save', kind: 'primary', onClick: () => { const before = JSON.parse(JSON.stringify(app.state.settings)); app.setSettings(work); toast('Assumptions saved', { action: 'Undo', onAction: () => app.setSettings(before) }); } }] });
  }

  // ---------- History ----------
  function history(app) {
    const list = h('div', { class: 'list' }); const search = h('input', { class: 'field', type: 'search', placeholder: 'Filter saved queries', 'aria-label': 'Filter saved queries', oninput: () => draw() });
    const draw = () => {
      list.textContent = ''; const q = search.value.trim().toLowerCase(); const all = app.store.history.list(); const items = all.filter((e) => !q || (e.name + ' ' + e.sql).toLowerCase().includes(q));
      if (!items.length) list.append(h('div', { class: 'empty' }, h('b', { text: all.length ? 'No matches' : 'No saved queries yet' }), h('p', { class: 'small', text: all.length ? '' : 'Use "Save to history" (Ctrl+S) to keep a query and its estimate here. History stays in this browser.' })));
      items.forEach((e) => list.append(h('div', { class: 'item', 'data-id': e.id },
        h('div', { class: 'meta' }, h('b', { text: e.name }), h('span', { text: (PR.WAREHOUSES.find((w) => w.id === e.warehouse) || { name: e.warehouse }).name + ' · ' + (e.perMonth != null ? money(e.perMonth) + '/month · ' : '') + fmtDate(e.savedAt) })),
        h('button', { class: 'btn small primary', type: 'button', text: 'Open', 'aria-label': 'Open ' + e.name, onclick: () => m.closeNow().then(() => app.replaceState({ sql: e.sql, name: e.name, warehouse: e.warehouse, schedule: e.schedule || app.state.schedule, catalog: e.catalog || app.state.catalog }, 'Opened "' + e.name + '"')) }),
        h('button', { class: 'btn small danger', type: 'button', text: 'Delete', 'aria-label': 'Delete ' + e.name, onclick: () => { const r = app.store.history.remove(e.id); draw(); if (r) toast('Deleted "' + e.name + '"', { action: 'Undo', onAction: () => { app.store.history.restore(r.item, r.index); draw(); } }); } }))));
    };
    const m = openModal({ title: 'History', size: 'wide', cancelLabel: 'Close', body: [search, list],
      footLeft: h('button', { class: 'btn danger', type: 'button', text: 'Clear all', onclick: () => { const items = app.store.history.clear(); draw(); if (items.length) toast('Cleared ' + items.length + ' saved quer' + (items.length > 1 ? 'ies' : 'y'), { action: 'Undo', onAction: () => { app.store.history.restoreAll(items); draw(); } }); } }),
      actions: [{ label: 'Save current query', kind: 'primary', close: false, onClick: () => { app.saveToHistory(); draw(); } }] });
    draw();
  }

  // ---------- Share ----------
  function share(app) {
    const out = h('input', { class: 'field', type: 'text', readOnly: true, 'aria-label': 'Share link', style: { width: '100%', fontFamily: 'var(--mono)', fontSize: '.8rem' } });
    const info = h('p', { class: 'small muted' }); let incCat = true, incSet = true;
    const build = async () => {
      const s = app.state; const data = { v: 1, name: s.name, sql: s.sql, warehouse: s.warehouse, schedule: s.schedule };
      if (incCat) data.catalog = s.catalog; if (incSet) data.settings = s.settings;
      const enc = await QC.share.encode(data); const url = location.origin + location.pathname + '#s=' + enc; out.value = url;
      info.textContent = url.length.toLocaleString('en-US') + ' characters. Everything is inside the link; nothing is uploaded.' + (url.length > 8000 ? ' Long links may be cut off by some chat apps; try leaving out the catalog.' : '');
    };
    openModal({ title: 'Share link', size: 'narrow', cancelLabel: 'Close', body: [
      h('p', { class: 'small', text: 'Anyone with the link sees this query, warehouse and schedule, plus the options below.' }),
      h('label', { class: 'row small' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { incCat = e.target.checked; build(); } }), 'Include the table catalog'),
      h('label', { class: 'row small' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { incSet = e.target.checked; build(); } }), 'Include prices and assumptions'),
      out, info],
      actions: [{ label: 'Copy link', kind: 'primary', close: false, onClick: async () => { await build(); toast((await QC.ui.copy(out.value)) ? 'Link copied' : 'Copy failed: select the link and copy it'); } }] });
    build();
  }

  // ---------- Export ----------
  function exportReport(app) {
    const v = app.view; if (!v.ev) return;
    const data = () => ({ title: app.state.name || 'Untitled query', ev: v.ev, findings: v.findings, ctx: app.ctx(), optimized: v.opt });
    const slug = (app.state.name || 'query').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'query';
    const row = (label, desc, fn) => h('div', { class: 'item' }, h('div', { class: 'meta' }, h('b', { text: label }), h('span', { text: desc })), fn);
    openModal({ title: 'Export report', size: 'narrow', cancelLabel: 'Close', body: [
      row('Markdown', 'For pull requests, tickets and docs', h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', text: 'Copy', onclick: async () => toast((await QC.ui.copy(QC.report.toMarkdown(data()))) ? 'Markdown copied' : 'Copy failed') }), h('button', { class: 'btn small primary', type: 'button', text: 'Download', onclick: () => QC.ui.download('querycost-' + slug + '.md', QC.report.toMarkdown(data()), 'text/markdown') }))),
      row('HTML', 'A standalone page to share or print', h('button', { class: 'btn small primary', type: 'button', text: 'Download', onclick: () => QC.ui.download('querycost-' + slug + '.html', QC.report.toHTML(data()), 'text/html') })),
      row('JSON', 'Every number, assumption and finding', h('button', { class: 'btn small primary', type: 'button', text: 'Download', onclick: () => QC.ui.download('querycost-' + slug + '.json', QC.report.toJSON(data()), 'application/json') })),
      v.opt && v.opt.applied.length ? row('Suggested query', 'The optimized SQL from the Optimize tab', h('button', { class: 'btn small', type: 'button', text: 'Copy SQL', onclick: async () => toast((await QC.ui.copy(v.opt.sql)) ? 'Suggested query copied' : 'Copy failed') })) : null] });
  }

  // ---------- Help ----------
  function help() {
    const li = (t) => h('li', { text: t });
    openModal({ title: 'About QueryCost', cancelLabel: 'Close', body: [
      h('p', { text: 'QueryCost estimates what a SQL query costs on BigQuery, Snowflake, Databricks SQL, Redshift and Athena, shows what it reads, and suggests cheaper rewrites. It runs entirely in your browser: no sign-in, no server, no warehouse connection.' }),
      h('p', { class: 'notice', text: QC.report.DISCLAIMER }),
      h('h3', { text: 'Models' }),
      h('ul', { class: 'steps' }, li('BigQuery on-demand: logical bytes of the columns read after partition (and optional cluster) pruning, each table rounded up to the MB with a 10 MB minimum, times $/TiB. LIMIT does not reduce bytes. Editions: slot-hours from a slot-seconds-per-GiB heuristic.'),
        li('Snowflake: credits/hour for the warehouse size × estimated runtime (60-second minimum when the warehouse resumes) × $/credit for your edition.'),
        li('Databricks SQL: DBU/hour for the size × runtime × $/DBU (Serverless includes compute; Pro and Classic add cloud VM cost).'),
        li('Redshift: Serverless RPU-hours (60-second minimum) or a provisioned cluster\'s node-hours for the runtime.'),
        li('Athena: compressed bytes scanned, rounded up to the MB with a 10 MB minimum, × $/TB.')),
      h('h3', { text: 'Keyboard' }),
      h('ul', { class: 'steps' }, li('Ctrl/⌘ + Enter: estimate now'), li('Ctrl/⌘ + S: save to history'), li('Esc or browser Back: close the open dialog'), li('Arrow keys: move between warehouses and result tabs')),
      h('p', { class: 'small muted', html: 'Open source under the MIT license. <a href="https://github.com/shaikbasha1437/querycost" target="_blank" rel="noopener">Source on GitHub</a>.' })] });
  }

  QC.dialogs = { templates, catalog, table, importDialog, settings, history, share, exportReport, help };
})(self);

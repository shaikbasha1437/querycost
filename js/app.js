/* QueryCost app: state, estimation loop and the main views (summary, breakdown, findings, optimize, compare). */
(function (root) {
  'use strict';
  const QC = root.QC; const { h, toast } = QC.ui; const E = QC.estimate, PR = QC.pricing, C = QC.catalog, T = QC.templates;
  const money = E.fmtMoney, bytes = E.fmtBytes;
  const store = QC.store.create();
  const FALLBACKS = ['postgresql', 'trino', 'bigquery', 'snowflake'];
  const GRAMMAR = QC.analyze.DIALECT_GRAMMAR;
  const localToday = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  function defaultState() {
    const t = T.byId('ecommerce'); const q = t.queries[2];
    return { v: 1, name: q.name, sql: q.sql, warehouse: t.warehouse, schedule: Object.assign({ perDay: 24, cron: '0 * * * *' }, q.schedule), catalog: C.normalize(t.catalog), settings: PR.defaults(), templateId: t.id };
  }
  function sanitize(s) {
    const d = defaultState(); if (!s || typeof s !== 'object') return d;
    return { v: 1, name: typeof s.name === 'string' ? s.name : '', sql: typeof s.sql === 'string' ? s.sql : d.sql, warehouse: PR.WAREHOUSES.some((w) => w.id === s.warehouse) ? s.warehouse : d.warehouse,
      schedule: Object.assign({ mode: 'perDay', perDay: 1, cron: '0 6 * * *' }, s.schedule || {}), catalog: s.catalog ? C.normalize(s.catalog) : d.catalog, settings: PR.merge(s.settings), templateId: s.templateId || null };
  }
  const state = sanitize(store.load());
  const view = { ev: null, findings: [], opt: null, selected: null, tab: 'breakdown', compare: 'month', lastSql: null, busy: false };
  const persist = QC.ui.debounce(() => store.save(state), 250);
  const snapshot = () => JSON.parse(JSON.stringify({ name: state.name, sql: state.sql, warehouse: state.warehouse, schedule: state.schedule, catalog: state.catalog, settings: state.settings, templateId: state.templateId }));
  function restore(snap) { Object.assign(state, sanitize(snap)); syncInputs(); editor.set(state.sql); persist(); estimate(); }
  // Replace parts of the state, offering Undo.
  function replaceState(patch, msg) {
    const before = snapshot(); Object.assign(state, patch); if (patch.catalog) state.catalog = C.normalize(patch.catalog);
    syncInputs(); if (patch.sql != null) editor.set(state.sql); persist(); estimate();
    toast(msg, { action: 'Undo', onAction: () => restore(before) });
  }

  // ---------- Editor ----------
  const $ = (id) => document.getElementById(id);
  const editorSchema = () => Object.fromEntries(state.catalog.tables.map((t) => [t.name, t.columns.map((c) => c.name)]));
  const editor = root.QCEditor ? root.QCEditor.create($('editor'), { doc: state.sql, dialect: state.warehouse, schema: editorSchema(), label: 'SQL query', placeholder: 'Paste or type a SQL query…',
    onChange: (text) => { state.sql = text; persist(); scheduleEstimate(); },
    keys: [{ key: 'Mod-Enter', run: () => { estimate(); return true; } }, { key: 'Mod-s', run: () => { saveToHistory(); return true; } }] })
    : fallbackEditor();
  function fallbackEditor() { const ta = h('textarea', { class: 'field', style: { width: '100%', height: '100%', fontFamily: 'var(--mono)' }, 'aria-label': 'SQL query' }); ta.value = state.sql; ta.addEventListener('input', () => { state.sql = ta.value; persist(); scheduleEstimate(); }); $('editor').append(ta); return { get: () => ta.value, set: (v) => { ta.value = v; }, setDialect() {}, focus: () => ta.focus() }; }
  const scheduleEstimate = QC.ui.debounce(() => estimate(), 400);

  // ---------- Estimation ----------
  function ctx() { return { catalog: state.catalog, settings: state.settings, warehouse: state.warehouse, getParser: QC.ui.getParser, today: localToday(), schedule: state.schedule }; }
  let runId = 0;
  async function estimate() {
    const id = ++runId; const sql = state.sql;
    $('parseStatus').textContent = 'Loading ' + GRAMMAR[state.warehouse] + ' grammar…';
    await QC.ui.loadGrammar(GRAMMAR[state.warehouse]);
    if (id !== runId) return;
    let ev = QC.engine.evaluate(sql, ctx());
    if (!ev.analysis.parser && sql.trim() && FALLBACKS.some((g) => !QC.ui.getParser(g))) {
      $('parseStatus').textContent = 'Trying other grammars…';
      await Promise.all(FALLBACKS.map((g) => QC.ui.loadGrammar(g)));
      if (id !== runId) return;
      ev = QC.engine.evaluate(sql, ctx());
    }
    view.ev = ev; view.findings = QC.lint.run(ev, ctx());
    if (view.lastSql !== sql || !view.selected) view.selected = new Set(view.findings.filter((f) => f.fix).map((f) => f.id));
    else view.selected = new Set(view.findings.filter((f) => f.fix && (view.selected.has(f.id) || !view.known || !view.known.has(f.id))).map((f) => f.id));
    view.known = new Set(view.findings.map((f) => f.id)); view.lastSql = sql;
    view.opt = QC.lint.optimize(ev, view.findings, ctx(), view.selected);
    render();
  }

  // ---------- Rendering ----------
  function render() { renderPicker(); renderOptions(); renderSchedule(); renderSummary(); renderTabs(); renderPanel(); $('catalogLabel').textContent = state.catalog.name + ' · ' + state.catalog.tables.length + ' tables'; $('asOf').textContent = state.settings.asOf; }
  function renderPicker() {
    const box = $('whPicker'); box.textContent = '';
    PR.WAREHOUSES.forEach((w) => {
      const c = view.ev && view.ev.costs[w.id]; const sel = w.id === state.warehouse;
      box.append(h('button', { type: 'button', class: 'wh', role: 'radio', 'aria-checked': String(sel), tabindex: sel ? '0' : '-1', 'data-wh': w.id, onclick: () => setWarehouse(w.id), onkeydown: pickerKeys },
        h('span', { class: 'dot', style: { background: w.color }, 'aria-hidden': 'true' }), w.name, h('small', { text: c ? money(c.cost) + '/run' : '…' })));
    });
  }
  function pickerKeys(e) {
    const ids = PR.WAREHOUSES.map((w) => w.id); let i = ids.indexOf(state.warehouse);
    if (['ArrowRight', 'ArrowDown'].includes(e.key)) i = (i + 1) % ids.length; else if (['ArrowLeft', 'ArrowUp'].includes(e.key)) i = (i + ids.length - 1) % ids.length; else return;
    e.preventDefault(); setWarehouse(ids[i]); setTimeout(() => { const b = document.querySelector('.wh[data-wh="' + ids[i] + '"]'); b && b.focus(); }, 0);
  }
  function setWarehouse(id) { if (id === state.warehouse) return; state.warehouse = id; editor.setDialect(id, editorSchema()); persist(); renderPicker(); renderOptions(); estimate(); }
  function opt(label, input) { return h('label', null, label, input); }
  function sel(value, options, onchange, aria) { const s = h('select', { 'aria-label': aria, onchange: (e) => onchange(e.target.value) }); options.forEach(([v, l]) => s.append(h('option', { value: v, text: l, selected: String(v) === String(value) }))); return s; }
  function num(value, onchange, aria, attrs) { return h('input', Object.assign({ type: 'number', value: String(value), 'aria-label': aria, onchange: (e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 0) onchange(v); } }, attrs || {})); }
  function check(value, onchange, label) { return h('label', null, h('input', { type: 'checkbox', checked: !!value, onchange: (e) => onchange(e.target.checked) }), label); }
  function upd(fn) { return (v) => { fn(v); persist(); estimate(); }; }
  function renderOptions() {
    const box = $('whOptions'); box.textContent = ''; const S = state.settings;
    if (state.warehouse === 'bigquery') {
      box.append(opt('Pricing', sel(S.bigquery.mode, [['ondemand', 'On-demand ($/TiB)'], ['editions', 'Editions (slot-hours)']], upd((v) => { S.bigquery.mode = v; renderOptions(); }), 'BigQuery pricing model')));
      if (S.bigquery.mode === 'editions') box.append(opt('Edition', sel(S.bigquery.edition, [['standard', 'Standard'], ['enterprise', 'Enterprise'], ['enterprise_plus', 'Enterprise Plus']], upd((v) => { S.bigquery.edition = v; }), 'BigQuery edition')));
      else box.append(check(S.bigquery.applyFreeTier, upd((v) => { S.bigquery.applyFreeTier = v; }), 'Use 1 TiB/month free tier'));
      box.append(check(S.bigquery.useClustering, upd((v) => { S.bigquery.useClustering = v; }), 'Count cluster pruning'));
    } else if (state.warehouse === 'snowflake') {
      box.append(opt('Size', sel(S.snowflake.size, PR.SF_SIZES.map((s) => [s, s + ' · ' + S.snowflake.credits[s] + ' cr/h']), upd((v) => { S.snowflake.size = v; }), 'Snowflake warehouse size')));
      box.append(opt('Edition', sel(S.snowflake.edition, [['standard', 'Standard'], ['enterprise', 'Enterprise'], ['business_critical', 'Business Critical'], ['vps', 'VPS']], upd((v) => { S.snowflake.edition = v; }), 'Snowflake edition')));
      box.append(check(S.snowflake.gen2, upd((v) => { S.snowflake.gen2 = v; }), 'Gen2'));
      box.append(check(S.snowflake.coldStart, upd((v) => { S.snowflake.coldStart = v; }), 'Resumes for this query (60 s min)'));
    } else if (state.warehouse === 'databricks') {
      box.append(opt('Type', sel(S.databricks.type, [['serverless', 'Serverless'], ['pro', 'Pro'], ['classic', 'Classic']], upd((v) => { S.databricks.type = v; }), 'Databricks SQL warehouse type')));
      box.append(opt('Size', sel(S.databricks.size, PR.DBX_SIZES.map((s) => [s, s + ' · ' + S.databricks.dbu[s] + ' DBU/h']), upd((v) => { S.databricks.size = v; }), 'Databricks SQL warehouse size')));
    } else if (state.warehouse === 'redshift') {
      box.append(opt('Deployment', sel(S.redshift.mode, [['serverless', 'Serverless (RPU-hours)'], ['provisioned', 'Provisioned (node-hours)']], upd((v) => { S.redshift.mode = v; renderOptions(); }), 'Redshift deployment')));
      if (S.redshift.mode === 'serverless') { box.append(opt('Base RPU', num(S.redshift.rpu, upd((v) => { S.redshift.rpu = Math.max(4, Math.min(1024, v)); }), 'Base RPU capacity', { min: 4, max: 1024, step: 4 }))); box.append(check(S.redshift.applyMinimum, upd((v) => { S.redshift.applyMinimum = v; }), '60 s minimum')); }
      else { box.append(opt('Node', sel(S.redshift.nodeType, Object.keys(S.redshift.nodePrice).map((n) => [n, n + ' · $' + S.redshift.nodePrice[n] + '/h']), upd((v) => { S.redshift.nodeType = v; }), 'Redshift node type'))); box.append(opt('Nodes', num(S.redshift.nodes, upd((v) => { S.redshift.nodes = Math.max(1, Math.round(v)); }), 'Number of nodes', { min: 1, step: 1 }))); }
    } else {
      box.append(h('span', { class: 'muted', text: '$' + S.athena.perTB + ' per TB scanned · ' + S.athena.minMB + ' MB minimum per query · compressed columnar bytes' }));
    }
    box.append(h('button', { class: 'btn ghost small', type: 'button', text: 'All assumptions…', onclick: () => QC.dialogs.settings(app, state.warehouse) }));
  }
  function renderSchedule() {
    const s = state.schedule; $('schedPerDay').checked = s.mode !== 'cron'; $('schedCron').checked = s.mode === 'cron';
    if (document.activeElement !== $('perDay')) $('perDay').value = String(s.perDay); if (document.activeElement !== $('cron')) $('cron').value = s.cron || '';
    const c = view.ev && view.ev.cost; const info = $('schedInfo');
    if (c && c.schedule.error) { info.textContent = c.schedule.error; info.className = 'hint err'; }
    else if (c) { info.textContent = Math.round(c.schedule.runsMonth).toLocaleString('en-US') + ' runs per 30 days (' + (+c.schedule.runsDay.toFixed(2)) + '/day)'; info.className = 'hint muted'; }
  }
  function renderSummary() {
    const box = $('summary'); box.textContent = ''; const ev = view.ev; if (!ev) return;
    const c = ev.cost; const a = ev.analysis; const w = PR.WAREHOUSES.find((x) => x.id === state.warehouse);
    if (!state.sql.trim()) { box.append(h('div', { class: 'empty' }, h('b', { text: 'Paste a query to get started' }), h('p', { class: 'small', text: 'Or open Templates for sample catalogs and queries.' }))); $('parseStatus').textContent = ''; return; }
    box.append(h('div', { class: 'row' }, h('h2', { class: 'grow', text: w.name + ' estimate' }), h('span', { class: 'small muted', text: 'Prices as of ' + state.settings.asOf })));
    box.append(h('div', { class: 'totals' },
      h('div', { class: 'total main' }, h('span', { text: 'Per run' }), h('b', { text: money(c.cost), 'data-testid': 'per-run' })),
      h('div', { class: 'total' }, h('span', { text: 'Per day' }), h('b', { text: money(c.perDay) })),
      h('div', { class: 'total' }, h('span', { text: 'Per month' }), h('b', { text: money(c.perMonth), 'data-testid': 'per-month' }))));
    const badges = h('div', { class: 'badges' });
    if (a.parser) badges.append(h('span', { class: 'badge ' + (a.fallbackGrammar ? 'warn' : 'good'), text: a.fallbackGrammar ? 'Parsed with ' + a.parser + ' grammar (fallback)' : 'Parsed: ' + a.parser + ' grammar' }));
    else badges.append(h('span', { class: 'badge bad', text: 'Heuristic analysis (approximate)' }));
    if (a.statementCount > 1) badges.append(h('span', { class: 'badge', text: a.statementCount + ' statements' }));
    badges.append(h('span', { class: 'badge', text: 'Reads ' + bytes(c.scanBytes) + (state.warehouse === 'bigquery' || state.warehouse === 'athena' ? '' : ' compressed') }));
    if (c.billedBytes != null) badges.append(h('span', { class: 'badge', text: 'Billed ' + bytes(c.billedBytes, state.warehouse === 'athena') }));
    if (c.runtimeSec != null) badges.append(h('span', { class: 'badge', text: '~' + (c.runtimeSec < 60 ? c.runtimeSec.toFixed(1) + ' s' : (c.runtimeSec / 60).toFixed(1) + ' min') + ' runtime' }));
    const sevs = { high: 0, medium: 0, low: 0 }; view.findings.forEach((f) => { if (sevs[f.severity] != null) sevs[f.severity]++; });
    if (sevs.high) badges.append(h('span', { class: 'badge bad', text: sevs.high + ' high' })); if (sevs.medium) badges.append(h('span', { class: 'badge warn', text: sevs.medium + ' medium' }));
    if (view.opt && view.opt.delta.perMonth > 0.005) badges.append(h('button', { type: 'button', class: 'badge good', style: { cursor: 'pointer' }, text: 'Save ~' + money(view.opt.delta.perMonth) + '/month', onclick: () => selectTab('optimize') }));
    box.append(badges);
    if (!a.parser) box.append(h('div', { class: 'notice', role: 'note' }, h('b', { text: 'No grammar could parse this SQL. ' }), 'QueryCost fell back to token heuristics, so tables, columns and filters are approximate and some rules and rewrites are skipped.' + (a.parseError ? ' Parser said: ' + a.parseError : '')));
    if (ev.scan.unknown.length) box.append(h('div', { class: 'notice info' }, h('span', { text: 'Not in the catalog (counted as 0 bytes): ' + ev.scan.unknown.join(', ') + '. ' }), h('button', { class: 'btn small', type: 'button', text: 'Add to catalog', onclick: () => QC.dialogs.table(app, null, prefillUnknown(ev.scan.unknown[0])) })));
    const guessed = ev.scan.tables.filter((t) => t.rowsGuessed); if (guessed.length) box.append(h('div', { class: 'notice info', text: 'Row counts are guesses for ' + guessed.map((t) => t.name).join(', ') + ' (imported from DDL). Edit them in the catalog for real numbers.' }));
    $('parseStatus').textContent = a.parser ? '' : 'Heuristic mode';
  }
  function prefillUnknown(name) {
    const refs = view.ev.analysis.model.refs.filter((r) => r.kind === 'table' && r.name === name);
    const cols = new Set(); refs.forEach((r) => { r.cols.forEach((c) => cols.add(c)); });
    return { name, rows: 1e6, columns: [...cols].map((c) => ({ name: c, type: 'STRING' })) };
  }
  function renderTabs() {
    const n = view.findings.filter((f) => f.severity !== 'info').length; const fc = $('findCount'); fc.textContent = String(view.findings.length); fc.className = 'count' + (view.findings.some((f) => f.severity === 'high') ? ' hot' : '');
    void n;
    ['breakdown', 'findings', 'optimize', 'compare'].forEach((t) => { const b = $('tab-' + t); const on = t === view.tab; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; $('panel-' + t).hidden = !on; });
  }
  function selectTab(t) { view.tab = t; renderTabs(); renderPanel(); }
  function renderPanel() {
    const p = $('panel-' + view.tab); p.textContent = ''; if (!view.ev) return;
    if (!state.sql.trim()) { p.append(h('p', { class: 'empty', text: 'Nothing to show yet.' })); return; }
    ({ breakdown: renderBreakdown, findings: renderFindings, optimize: renderOptimize, compare: renderCompare })[view.tab](p);
  }
  function renderBreakdown(p) {
    const ev = view.ev; const c = ev.cost;
    p.append(h('h2', { text: 'How this estimate is computed' }), h('ol', { class: 'steps' }, c.steps.map((s) => h('li', { text: s }))));
    if (!ev.scan.tables.length) p.append(h('p', { class: 'muted', text: ev.scan.unknown.length ? 'None of the referenced tables are in the catalog yet.' : 'No tables referenced.' }));
    else {
      const tb = h('table', { class: 'data' }, h('thead', null, h('tr', null, h('th', { text: 'Table' }), h('th', { text: 'Columns read' }), h('th', { class: 'n', text: 'Before pruning' }), h('th', { class: 'n', text: 'After pruning' }), h('th', { text: 'Partitions' }))));
      const body = h('tbody'); tb.append(body);
      ev.scan.tables.forEach((t) => {
        const tableDef = C.find(state.catalog, t.name); const read = new Set(t.columnsRead.map((x) => x.name));
        const chips = h('div', { class: 'chips' }, (tableDef ? tableDef.columns : []).map((col) => h('span', { class: 'chip' + (read.has(col.name) ? '' : ' off'), title: read.has(col.name) ? 'read: ' + bytes(C.columnBytes(tableDef, col.name)) : 'not read', text: col.name })));
        const pct = t.partition.total ? t.partition.read / t.partition.total : 1;
        const after = state.warehouse === 'bigquery' && !state.settings.bigquery.useClustering ? t.bytesAfterPartition : t.bytesAfterCluster;
        body.append(h('tr', null,
          h('td', null, h('b', { text: t.name }), h('div', { class: 'small muted', text: Number(t.rows).toLocaleString('en-US') + ' rows · ' + bytes(t.totalBytes) + ' total' + (t.reads > 1 ? ' · read ' + t.reads + '×' : '') })),
          h('td', null, h('div', { class: 'small muted', text: t.columnsRead.length + ' of ' + t.columnsTotal + ' columns' }), chips),
          h('td', { class: 'n', text: bytes(t.columnBytes) }),
          h('td', { class: 'n' }, bytes(after), t.cluster.keep < 1 ? h('div', { class: 'small muted', text: 'clustering keeps ~' + Math.round(t.cluster.keep * 100) + '%' }) : null),
          h('td', null, t.partition.total ? h('div', null, h('span', { text: t.partition.read + ' of ' + t.partition.total }), h('div', { class: 'meter', role: 'img', 'aria-label': Math.round(pct * 100) + '% of partitions read' }, h('i', { style: { width: Math.max(1, pct * 100) + '%' } }))) : h('span', { class: 'muted', text: 'not partitioned' }),
            h('div', { class: 'small muted', text: t.partition.total ? t.partition.reason : '' }), t.cluster.reason && t.cluster.keep < 1 ? h('div', { class: 'small muted', text: t.cluster.reason }) : null)));
      });
      p.append(h('h2', { text: 'Tables read' }), h('div', { class: 'tbl-wrap' }, tb));
    }
    const S = state.settings; const M = S.model; const w = state.warehouse;
    const lines = [];
    if (w === 'bigquery' && S.bigquery.mode === 'ondemand') lines.push('$' + S.bigquery.perTiB + ' per TiB billed; ' + S.bigquery.minTableMB + ' MB minimum per table referenced and ' + S.bigquery.minQueryMB + ' MB per query; bytes rounded up to the MB', 'Logical (uncompressed) bytes from column widths × rows, as BigQuery bills them', S.bigquery.applyFreeTier ? 'First ' + S.bigquery.freeTiB + ' TiB per month free (monthly figure only)' : 'Free tier not applied');
    if (w === 'bigquery' && S.bigquery.mode === 'editions') lines.push(S.bigquery.slotSecPerGiB + ' slot-seconds per GiB scanned × work factor', '$' + S.bigquery.slotHour[S.bigquery.edition] + ' per slot-hour (' + S.bigquery.edition.replace('_', ' ') + ', pay as you go)');
    if (w !== 'bigquery' && w !== 'athena') lines.push('Runtime = ' + M.overheadSec + ' s overhead + compressed GB ÷ throughput × work factor', 'Work factor ' + c.work.toFixed(2) + ': +' + M.joinFactor + ' per join, +' + M.aggFactor + ' aggregation, +' + M.sortFactor + ' sort, +' + M.distinctFactor + ' distinct, +' + M.windowFactor + ' window, +' + M.countDistinctFactor + ' COUNT(DISTINCT); ×' + M.explosionFactor + ' row explosion, ×' + M.crossJoinFactor + ' cross join, ×' + M.correlatedFactor + ' correlated subquery');
    if (w === 'athena') lines.push('$' + S.athena.perTB + ' per TB (10^12 bytes) of compressed data scanned, ' + S.athena.minMB + ' MB minimum, rounded up to the MB');
    lines.push('Filters with non-literal bounds keep ' + Math.round(M.unknownRangeKeep * 100) + '% of partitions; cluster filters keep ' + Math.round(M.clusterEqKeep * 100) + '% (equality) / ' + Math.round(M.clusterRangeKeep * 100) + '% (range) / ' + Math.round(M.clusterSecondaryKeep * 100) + '% (later key only)');
    p.append(h('details', { class: 'box' }, h('summary', { text: 'Assumptions used' }), h('ul', { class: 'steps' }, lines.map((l) => h('li', { text: l }))), h('button', { class: 'btn small', type: 'button', text: 'Edit assumptions', onclick: () => QC.dialogs.settings(app, w) })));
    p.append(h('div', { class: 'src' }, h('b', { text: 'Price sources (checked ' + S.asOf + '): ' }), h('ul', null, (PR.SOURCES[w] || []).map((s) => h('li', null, h('a', { href: s.url, target: '_blank', rel: 'noopener', text: s.label }))))));
  }
  function savingText(s) { if (!s || s.perRun == null) return null; if (!(s.perRun > 0)) { const c = view.ev && view.ev.cost; const minHit = c && c.billedSec && c.runtimeSec < c.billedSec; return h('span', { class: 'small muted', text: 'No direct cost change on ' + PR.WAREHOUSES.find((w) => w.id === state.warehouse).name + (minHit ? ': the run already fits inside the ' + Math.round(c.billedSec) + '-second billing minimum, so it still helps runtime and shared capacity.' : ' with this model.') }); } return h('span', { class: 'save', text: 'Saves ~' + money(s.perRun) + ' per run · ' + money(s.perMonth) + ' per month' + (s.note ? ' (' + s.note + ')' : '') }); }
  function renderFindings(p) {
    if (!view.findings.length) { p.append(h('div', { class: 'empty' }, h('b', { text: 'No issues found' }), h('p', { class: 'small', text: 'QueryCost checks ' + QC.lint.RULES.length + ' rules. This query passes all of them for the current catalog.' }))); return; }
    view.findings.forEach((f) => {
      const card = h('article', { class: 'finding', 'data-rule': f.rule },
        h('header', null, h('span', { class: 'sev ' + f.severity, text: f.severity }), h('h3', { text: f.title }), f.changesResults ? h('span', { class: 'badge', title: 'This rewrite can change the query result', text: 'changes results' }) : null),
        h('p', { text: f.message }), h('p', { class: 'why', text: f.why }), savingText(f.savings));
      if (f.rewrite) {
        const acts = h('div', { class: 'acts' },
          h('button', { class: 'btn small', type: 'button', text: 'Copy rewrite', onclick: async () => toast((await QC.ui.copy(f.rewrite)) ? 'Rewrite copied' : 'Copy failed') }),
          h('button', { class: 'btn small primary', type: 'button', text: 'Apply to editor', onclick: () => replaceState({ sql: f.rewrite }, 'Applied: ' + (f.fixLabel || f.title)) }));
        card.append(h('details', null, h('summary', { class: 'small', text: 'Show rewrite' + (f.fixLabel ? ': ' + f.fixLabel : '') }), h('pre', { class: 'code', text: f.rewrite })), acts);
      }
      p.append(card);
    });
  }
  function diffMarks(orig, next) {
    const o = new Set(orig.split('\n').map((l) => l.trim())); const pre = h('pre', { class: 'code', 'aria-label': 'Suggested query' });
    next.split('\n').forEach((l, i, arr) => { pre.append(o.has(l.trim()) ? l : h('mark', { class: 'add', text: l })); if (i < arr.length - 1) pre.append('\n'); });
    return pre;
  }
  function renderOptimize(p) {
    const fixes = view.findings.filter((f) => f.fix);
    if (!fixes.length) { p.append(h('div', { class: 'empty' }, h('b', { text: 'No automatic rewrites for this query' }), h('p', { class: 'small', text: view.findings.length ? 'See Findings for manual suggestions.' : 'Nothing to optimize with the current catalog.' }))); return; }
    const o = view.opt; const before = view.ev.cost, after = o.after.cost;
    p.append(h('h2', { text: 'Choose fixes' }), h('div', { class: 'fixlist' }, fixes.map((f) => h('label', null,
      h('input', { type: 'checkbox', checked: view.selected.has(f.id), onchange: (e) => { if (e.target.checked) view.selected.add(f.id); else view.selected.delete(f.id); view.opt = QC.lint.optimize(view.ev, view.findings, ctx(), view.selected); renderSummary(); renderPanel(); } }),
      h('span', null, h('b', { text: f.fixLabel || f.title }), ' ', h('span', { class: 'sev ' + f.severity, text: f.severity }), f.changesResults ? h('span', { class: 'small muted', text: ' · changes results' }) : null)))));
    const d = o.delta; const pct = before.cost ? d.perRun / before.cost : 0;
    p.append(h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'small muted', text: 'Original ' + money(before.cost) + '/run → suggested ' + money(after.cost) + '/run' }),
      h('div', { class: 'delta' + (d.perRun < 0 ? ' neg' : ''), 'data-testid': 'opt-delta', text: (d.perRun >= 0 ? 'Saves ' : 'Costs ') + money(Math.abs(d.perMonth)) + ' per month' + (before.cost ? ' (' + Math.round(Math.abs(pct) * 100) + '%)' : '') })),
      h('button', { class: 'btn', type: 'button', text: 'Copy suggested', onclick: async () => toast((await QC.ui.copy(o.sql)) ? 'Suggested query copied' : 'Copy failed') }),
      h('button', { class: 'btn primary', type: 'button', text: 'Use suggested query', disabled: !o.applied.length, onclick: () => replaceState({ sql: o.sql }, 'Editor now has the suggested query') })));
    if (o.skipped.length) p.append(h('p', { class: 'small muted', text: 'Could not apply: ' + o.skipped.map((f) => f.fixLabel || f.title).join(', ') + '.' }));
    p.append(h('div', { class: 'side' },
      h('div', null, h('h3', null, 'Original', h('span', { class: 'small muted', text: money(before.cost) + '/run' })), h('pre', { class: 'code', text: view.ev.sql, 'aria-label': 'Original query' })),
      h('div', null, h('h3', null, 'Suggested', h('span', { class: 'small muted', text: money(after.cost) + '/run' })), diffMarks(view.ev.sql, o.sql))));
  }
  function renderCompare(p) {
    const ev = view.ev; const key = view.compare === 'run' ? 'cost' : 'perMonth';
    const vals = PR.WAREHOUSES.map((w) => ({ w, v: ev.costs[w.id][key], c: ev.costs[w.id] })); const max = Math.max(...vals.map((x) => x.v), 1e-9);
    const optC = view.opt && view.opt.applied.length ? view.opt.after.costs : null;
    p.append(h('div', { class: 'row' }, h('h2', { class: 'grow', text: 'Same query on every warehouse' }), h('div', { class: 'seg', role: 'group', 'aria-label': 'Period' },
      h('button', { type: 'button', 'aria-pressed': String(view.compare === 'run'), text: 'Per run', onclick: () => { view.compare = 'run'; renderPanel(); } }),
      h('button', { type: 'button', 'aria-pressed': String(view.compare === 'month'), text: 'Per month', onclick: () => { view.compare = 'month'; renderPanel(); } }))));
    const chart = h('div', { class: 'chart', role: 'list' });
    vals.forEach(({ w, v, c }) => {
      const s = state.settings; const cfg = { bigquery: s.bigquery.mode === 'ondemand' ? 'on-demand $' + s.bigquery.perTiB + '/TiB' : s.bigquery.edition.replace('_', ' ') + ' slots', snowflake: s.snowflake.size + ' · ' + s.snowflake.edition.replace('_', ' '), databricks: s.databricks.type + ' · ' + s.databricks.size, redshift: s.redshift.mode === 'serverless' ? s.redshift.rpu + ' RPU serverless' : s.redshift.nodes + '× ' + s.redshift.nodeType, athena: '$' + s.athena.perTB + '/TB' }[w.id];
      chart.append(h('div', { class: 'bar-row' + (w.id === state.warehouse ? ' sel' : ''), role: 'listitem' },
        h('button', { class: 'lbl btn ghost small', type: 'button', title: 'Switch to ' + w.name, onclick: () => setWarehouse(w.id) }, h('span', { class: 'dot', style: { background: w.color, width: '9px', height: '9px', borderRadius: '50%', display: 'inline-block', flex: '0 0 auto' } }), w.name),
        h('div', null, h('div', { class: 'bar-track', role: 'img', 'aria-label': w.name + ': ' + money(v) }, h('div', { class: 'bar', style: { width: Math.max(0.5, (v / max) * 100) + '%', background: w.color } })), h('div', { class: 'small muted', text: cfg + (optC ? ' · optimized ' + money(optC[w.id][key]) : '') })),
        h('span', { class: 'val', text: money(v) })));
    });
    p.append(chart, h('p', { class: 'small muted', text: 'Each warehouse uses its own settings from Assumptions. Runtime-based warehouses (Snowflake, Databricks, Redshift) depend on the runtime heuristic and are the least certain; on-demand bytes pricing (BigQuery, Athena) follows the documented billing rules.' }));
  }

  // ---------- Actions ----------
  function syncInputs() { $('qname').value = state.name || ''; editor.setDialect(state.warehouse, editorSchema()); renderSchedule(); }
  function saveToHistory() {
    if (!state.sql.trim()) { toast('Nothing to save yet'); return; }
    const c = view.ev && view.ev.cost;
    store.history.add({ name: state.name || 'Untitled query', sql: state.sql, warehouse: state.warehouse, schedule: state.schedule, catalog: state.catalog, perRun: c ? c.cost : null, perMonth: c ? c.perMonth : null });
    toast('Saved to history');
  }
  function bind() {
    $('qname').addEventListener('input', (e) => { state.name = e.target.value; persist(); });
    $('btnEstimate').addEventListener('click', () => estimate());
    $('btnSave').addEventListener('click', saveToHistory);
    $('btnClear').addEventListener('click', () => { if (!state.sql) return; replaceState({ sql: '', name: '' }, 'Editor cleared'); editor.focus(); });
    $('btnSamples').addEventListener('click', () => QC.dialogs.templates(app));
    $('btnTemplates').addEventListener('click', () => QC.dialogs.templates(app));
    $('btnCatalog').addEventListener('click', () => QC.dialogs.catalog(app));
    $('btnSettings').addEventListener('click', () => QC.dialogs.settings(app, state.warehouse));
    $('btnHistory').addEventListener('click', () => QC.dialogs.history(app));
    $('btnShare').addEventListener('click', () => QC.dialogs.share(app));
    $('btnExport').addEventListener('click', () => QC.dialogs.exportReport(app));
    $('btnHelp').addEventListener('click', () => QC.dialogs.help(app));
    $('btnTheme').addEventListener('click', () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; try { localStorage.setItem('querycost:theme', t); } catch (e) { /* ignore */ } themeLabel(); });
    const sched = () => { state.schedule = { mode: $('schedCron').checked ? 'cron' : 'perDay', perDay: Math.max(0, Number($('perDay').value) || 0), cron: $('cron').value.trim() }; persist(); estimate(); };
    ['schedPerDay', 'schedCron'].forEach((id) => $(id).addEventListener('change', sched));
    $('perDay').addEventListener('input', () => { $('schedPerDay').checked = true; sched(); });
    $('cron').addEventListener('input', QC.ui.debounce(() => { $('schedCron').checked = true; sched(); }, 300));
    const tabs = ['breakdown', 'findings', 'optimize', 'compare'];
    tabs.forEach((t, i) => { const b = $('tab-' + t); b.addEventListener('click', () => selectTab(t)); b.addEventListener('keydown', (e) => { let j = i; if (e.key === 'ArrowRight') j = (i + 1) % tabs.length; else if (e.key === 'ArrowLeft') j = (i + tabs.length - 1) % tabs.length; else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = tabs.length - 1; else return; e.preventDefault(); selectTab(tabs[j]); $('tab-' + tabs[j]).focus(); }); });
    document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); estimate(); } if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S') && !QC.ui.stack.size) { e.preventDefault(); saveToHistory(); } });
    themeLabel();
  }
  function themeLabel() { const dark = document.documentElement.dataset.theme === 'dark'; $('btnTheme').setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme'); }
  async function openSharedFromHash() {
    const m = location.hash.match(/^#s=(.+)$/); if (!m) return;
    try {
      const data = await QC.share.decode(m[1]);
      try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) { /* ignore */ }
      const patch = { sql: data.sql || '', name: data.name || 'Shared query', warehouse: data.warehouse, schedule: data.schedule || state.schedule };
      if (data.catalog) patch.catalog = data.catalog; if (data.settings) patch.settings = PR.merge(data.settings);
      replaceState(sanitize(Object.assign(snapshot(), patch)), 'Opened a shared query');
    } catch (e) { toast('That share link could not be read'); }
  }
  const app = {
    state, view, store, editor, estimate, replaceState, snapshot, restore, ctx, saveToHistory, sanitize, localToday,
    setCatalog(cat, msg) { replaceState({ catalog: cat }, msg || 'Catalog updated'); },
    commitCatalog(cat) { state.catalog = C.normalize(cat); editor.setDialect(state.warehouse, editorSchema()); persist(); estimate(); },
    setSettings(s) { state.settings = PR.merge(s); persist(); renderOptions(); estimate(); },
  };
  QC.app = app;
  syncInputs(); bind(); estimate().then(openSharedFromHash);
  root.addEventListener('hashchange', openSharedFromHash);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})(self);

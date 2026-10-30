/* QueryCost UI helpers: element builder, toasts with Undo, accessible modals on a history-aware stack,
   downloads, clipboard and the lazy parser loader. */
(function (root) {
  'use strict';
  const QC = root.QC;
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v; else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k in el && typeof v !== 'string' && k !== 'list') el[k] = v; else el.setAttribute(k, v === true ? '' : v);
    });
    kids.flat(Infinity).forEach((c) => { if (c == null || c === false) return; el.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return el;
  }
  // Toasts
  function toast(msg, opts) {
    opts = opts || {}; const box = document.getElementById('toasts');
    const t = h('div', { class: 'toast', role: 'status' }, h('span', { text: msg }));
    let timer;
    const close = () => { clearTimeout(timer); t.remove(); };
    if (opts.action) t.append(h('button', { type: 'button', text: opts.action, onclick: () => { close(); opts.onAction && opts.onAction(); } }));
    t.append(h('button', { type: 'button', 'aria-label': 'Dismiss', text: '×', onclick: close }));
    box.append(t); while (box.children.length > 3) box.firstChild.remove();
    timer = setTimeout(close, opts.timeout || (opts.action ? 8000 : 3500));
    return { close };
  }
  // Modals
  const stack = QC.modal.createModalStack({ history: root.history, confirm: (m) => root.confirm(m) });
  root.addEventListener('popstate', () => stack.onPopState());
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  let seq = 0;
  // openModal({ title, body, actions:[{label, kind, onClick, close}], size, isDirty, confirmText, onClose, cancelLabel })
  function openModal(o) {
    const id = o.id || ('m' + (++seq)); const titleId = id + '-title';
    const prevFocus = document.activeElement;
    const close = () => stack.requestClose(id);
    const closeNow = () => stack.close(id);
    const foot = h('div', { class: 'modal-foot' });
    if (o.footLeft) foot.append(h('div', { class: 'left' }, o.footLeft));
    if (o.cancel !== false) foot.append(h('button', { class: 'btn', type: 'button', 'data-cancel': '', text: o.cancelLabel || 'Cancel', onclick: close }));
    (o.actions || []).forEach((a) => foot.append(h('button', { class: 'btn ' + (a.kind || ''), type: a.submit ? 'submit' : 'button', text: a.label, id: a.id, onclick: async (ev) => { if (a.submit) return; const r = await a.onClick(api, ev); if (r !== false && a.close !== false) closeNow(); } })));
    const dlg = h('div', { class: 'modal ' + (o.size || ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('div', { class: 'modal-head' }, h('h2', { id: titleId, text: o.title }), h('button', { class: 'btn ghost icon-btn', type: 'button', 'aria-label': 'Close', 'data-close': '', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>', onclick: close })),
      h('div', { class: 'modal-body' }, o.body), (o.cancel === false && !(o.actions || []).length) ? null : foot);
    const back = h('div', { class: 'backdrop', 'data-modal': id }, dlg);
    let downOnBackdrop = false;
    back.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === back; });
    back.addEventListener('click', (e) => { if (e.target === back && downOnBackdrop) close(); });
    back.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return; const f = [...dlg.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (!f.length) return; const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    const api = { id, el: dlg, close, closeNow, body: o.body };
    stack.open({ id, isDirty: o.isDirty, confirmText: o.confirmText || 'Discard your unsaved changes?',
      show: () => { document.body.append(back); document.body.style.overflow = 'hidden'; const first = o.initialFocus ? dlg.querySelector(o.initialFocus) : dlg.querySelector('.modal-body ' + FOCUSABLE) || dlg.querySelector(FOCUSABLE); setTimeout(() => first && first.focus(), 0); },
      hide: () => { back.remove(); if (!document.querySelector('.backdrop')) document.body.style.overflow = ''; if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus(); o.onClose && o.onClose(); } });
    return api;
  }
  // Keep focus inside the top dialog even if something outside grabs it.
  document.addEventListener('focusin', (e) => {
    const all = document.querySelectorAll('.backdrop'); if (!all.length) return; const top = all[all.length - 1];
    if (top.contains(e.target) || (e.target.closest && e.target.closest('.toasts, .toast'))) return;
    const f = top.querySelector('.modal-body ' + FOCUSABLE) || top.querySelector(FOCUSABLE); if (f) f.focus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !stack.size) return;
    if (e.target && e.target.closest && e.target.closest('.cm-tooltip-autocomplete')) return;
    e.preventDefault(); const top = stack.top(); if (top) stack.requestClose(top.id);
  });
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type: type || 'text/plain' }));
    const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {
      const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }); ta.value = text; document.body.append(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (x) { ok = false; } ta.remove(); return ok;
    }
  }
  // Lazy parser loading: each UMD sets the NodeSQLParser global; capture it right after it loads.
  const parsers = {}; const loading = {}; let chain = Promise.resolve();
  function loadGrammar(g) {
    if (parsers[g]) return Promise.resolve(parsers[g]);
    if (loading[g]) return loading[g];
    loading[g] = chain = chain.then(() => new Promise((res) => {
      const s = document.createElement('script'); s.src = 'js/vendor/sqlparser/' + g + '.umd.js'; s.async = true;
      s.onload = () => { try { parsers[g] = new root.NodeSQLParser.Parser(); } catch (e) { parsers[g] = null; } res(parsers[g]); };
      s.onerror = () => { delete loading[g]; res(null); };
      document.head.append(s);
    }));
    return loading[g];
  }
  const getParser = (g) => parsers[g] || null;
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  QC.ui = { h, toast, openModal, stack, download, copy, loadGrammar, getParser, debounce };
})(self);

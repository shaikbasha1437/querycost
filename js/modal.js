/* QueryCost modal stack with browser-history integration.
   Every open sheet/overlay pushes a history entry, so the browser or Android Back button closes it
   instead of leaving the page. Closing from the UI pops that entry again. Dirty sheets ask first. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.QC = root.QC || {}).modal = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function createModalStack(opts) {
    const H = opts.history;
    const ask = opts.confirm || (() => true);
    const later = opts.setTimeout || setTimeout;
    const stack = [];
    let expect = 0; // history.back() calls we started ourselves
    let waiters = [];
    const find = (id) => stack.find((m) => m.id === id);
    const ours = (st) => !!(st && st.qcModal);
    function open(m) {
      if (find(m.id)) return false;
      stack.push(m);
      try { H.pushState(Object.assign({}, ours(H.state) ? {} : H.state, { qcModal: m.id, depth: stack.length }), ''); } catch (e) { /* history unavailable: still usable via buttons/Esc */ }
      m.show();
      return true;
    }
    function settle() { const w = waiters; waiters = []; w.forEach((f) => f()); }
    // Close without asking. Resolves after history has settled, so callers can navigate safely.
    function close(id) {
      const m = find(id);
      if (!m) return Promise.resolve(false);
      // Close anything stacked above it too.
      const idx = stack.indexOf(m);
      const removed = stack.splice(idx);
      removed.reverse().forEach((x) => x.hide());
      let pops = 0;
      const st = H.state;
      if (ours(st) && st.depth > idx) pops = st.depth - idx;
      if (!pops) return Promise.resolve(true);
      expect += pops;
      return new Promise((res) => {
        let done = false;
        const fin = () => { if (!done) { done = true; res(true); } };
        waiters.push(fin);
        try { H.go(-pops); } catch (e) { expect = 0; fin(); }
        later(() => { if (!done) { expect = 0; fin(); } }, 600);
      });
    }
    // Close if the user agrees (unsaved changes get a prompt). Resolves to true when closed.
    function requestClose(id) {
      const m = find(id);
      if (!m) return Promise.resolve(false);
      if (m.isDirty && m.isDirty() && !ask(m.confirmText || 'Discard changes?')) return Promise.resolve(false);
      return close(id);
    }
    function onPopState() {
      if (expect > 0) { expect--; if (!expect) settle(); return; }
      // The user pressed Back: close sheets whose history entry is gone.
      const depth = ours(H.state) ? H.state.depth : 0;
      while (stack.length > depth) {
        const m = stack[stack.length - 1];
        if (m.isDirty && m.isDirty() && !ask(m.confirmText || 'Discard changes?')) {
          try { H.pushState({ qcModal: m.id, depth: stack.length }, ''); } catch (e) { /* ignore */ }
          return;
        }
        stack.pop(); m.hide();
      }
    }
    return { open, close, requestClose, onPopState, top: () => stack[stack.length - 1] || null, isOpen: (id) => !!find(id), get size() { return stack.length; } };
  }
  return { createModalStack };
});

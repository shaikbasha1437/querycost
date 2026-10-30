/* QueryCost storage: workspace state and query history in localStorage (falls back to memory). */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else (root.QC = root.QC || {}).store = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const KEY = 'querycost:state', HKEY = 'querycost:history', MAX = 200;
  function memory() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
  function create(storage) {
    let S = storage; try { S = storage || localStorage; S.setItem('querycost:probe', '1'); S.removeItem('querycost:probe'); } catch (e) { S = memory(); }
    const read = (k, d) => { try { const v = S.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
    const write = (k, v) => { try { S.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };
    const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const history = {
      list: () => read(HKEY, []),
      add(entry) { const all = history.list(); const e = Object.assign({ id: uid(), savedAt: new Date().toISOString() }, entry); all.unshift(e); write(HKEY, all.slice(0, MAX)); return e; },
      update(id, patch) { const all = history.list(); const i = all.findIndex((e) => e.id === id); if (i < 0) return null; all[i] = Object.assign({}, all[i], patch, { savedAt: new Date().toISOString() }); write(HKEY, all); return all[i]; },
      remove(id) { const all = history.list(); const i = all.findIndex((e) => e.id === id); if (i < 0) return null; const [item] = all.splice(i, 1); write(HKEY, all); return { item, index: i }; },
      restore(item, index) { const all = history.list().filter((e) => e.id !== item.id); all.splice(Math.min(index, all.length), 0, item); write(HKEY, all.slice(0, MAX)); },
      clear() { const all = history.list(); write(HKEY, []); return all; },
      restoreAll(items) { write(HKEY, items.concat(history.list().filter((e) => !items.some((x) => x.id === e.id))).slice(0, MAX)); },
    };
    return { load: () => read(KEY, null), save: (st) => write(KEY, st), history, raw: S };
  }
  return { create };
});

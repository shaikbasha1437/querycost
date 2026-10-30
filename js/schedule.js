/* QueryCost schedules: runs per day or a cron string (5 fields, optional leading seconds field, @daily-style macros). */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else (root.QC = root.QC || {}).schedule = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MACROS = { '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *' };
  const NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  function field(spec, min, max) {
    const out = new Set();
    String(spec).toLowerCase().split(',').forEach((part) => {
      const m = part.match(/^(\*|\?|[\w]+(?:-[\w]+)?)(?:\/(\d+))?$/);
      if (!m) throw new Error('Bad cron field "' + part + '"');
      const val = (s) => { const v = NAMES[s] != null ? NAMES[s] : Number(s); if (!Number.isInteger(v)) throw new Error('Bad cron value "' + s + '"'); return v; };
      let lo = min, hi = max;
      if (m[1] !== '*' && m[1] !== '?') { const [a, b] = m[1].split('-'); lo = val(a); hi = b != null ? val(b) : (m[2] ? max : lo); }
      const step = m[2] ? Number(m[2]) : 1;
      if (lo < min || hi > max + (max === 6 ? 1 : 0) || lo > hi || step < 1) throw new Error('Cron value out of range in "' + part + '"');
      for (let v = lo; v <= hi; v += step) out.add(max === 6 && v === 7 ? 0 : v);
    });
    return out;
  }
  function parseCron(expr) {
    let s = String(expr || '').trim(); if (MACROS[s.toLowerCase()]) s = MACROS[s.toLowerCase()];
    let parts = s.split(/\s+/); let secs = 1;
    if (parts.length === 6) { secs = field(parts[0], 0, 59).size; parts = parts.slice(1); }
    if (parts.length !== 5) throw new Error('Cron needs 5 fields: minute hour day-of-month month day-of-week');
    return { secs, min: field(parts[0], 0, 59), hour: field(parts[1], 0, 23), dom: field(parts[2], 1, 31), mon: field(parts[3], 1, 12), dow: field(parts[4], 0, 6), domAny: /^[*?]$/.test(parts[2]), dowAny: /^[*?]$/.test(parts[4]) };
  }
  // Count firings in [from, from + days) using standard cron day matching (DOM or DOW when both are restricted).
  function countRuns(expr, from, days) {
    const c = parseCron(expr); const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
    let n = 0; const perDay = c.min.size * c.hour.size * c.secs;
    for (let i = 0; i < days; i++) {
      const d = new Date(start.getTime() + i * 86400000);
      if (!c.mon.has(d.getUTCMonth() + 1)) continue;
      const domOk = c.dom.has(d.getUTCDate()), dowOk = c.dow.has(d.getUTCDay());
      const dayOk = c.domAny && c.dowAny ? true : c.domAny ? dowOk : c.dowAny ? domOk : (domOk || dowOk);
      if (dayOk) n += perDay;
    }
    return n;
  }
  const DAYS_PER_MONTH = 30;
  // schedule: { mode: 'perDay', perDay } | { mode: 'cron', cron }
  function project(perRun, schedule, from) {
    const s = schedule || { mode: 'perDay', perDay: 1 };
    let runsMonth, error = null;
    if (s.mode === 'cron') { try { runsMonth = countRuns(s.cron, from || new Date(), DAYS_PER_MONTH); } catch (e) { error = e.message; runsMonth = 0; } }
    else runsMonth = Math.max(0, Number(s.perDay) || 0) * DAYS_PER_MONTH;
    const runsDay = runsMonth / DAYS_PER_MONTH;
    return { runsDay, runsMonth, perDay: perRun * runsDay, perMonth: perRun * runsMonth, perYear: perRun * runsMonth * 365 / DAYS_PER_MONTH, error };
  }
  function describe(schedule) {
    if (!schedule || schedule.mode !== 'cron') { const n = Number(schedule && schedule.perDay) || 0; return n === 1 ? 'once a day' : n + ' runs a day'; }
    return 'cron "' + schedule.cron + '"';
  }
  return { parseCron, countRuns, project, describe, DAYS_PER_MONTH };
});

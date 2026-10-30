/* QueryCost share links: the query, warehouse, schedule, settings overrides and catalog go into the URL hash
   as deflate-compressed JSON in base64url ("#q=..."). Nothing is sent to a server. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else (root.QC = root.QC || {}).share = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const toB64u = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const fromB64u = (str) => { const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4)); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; };
  async function pipe(bytes, Stream) { const cs = new Stream('deflate-raw'); const out = new Response(new Blob([bytes]).stream().pipeThrough(cs)); return new Uint8Array(await out.arrayBuffer()); }
  async function encode(obj) {
    const raw = new TextEncoder().encode(JSON.stringify(obj));
    if (typeof CompressionStream === 'function') { try { return 'z' + toB64u(await pipe(raw, CompressionStream)); } catch (e) { /* fall through */ } }
    return 'j' + toB64u(raw);
  }
  async function decode(str) {
    if (!str) return null; const kind = str[0]; const bytes = fromB64u(str.slice(1));
    const raw = kind === 'z' ? await pipe(bytes, DecompressionStream) : bytes;
    return JSON.parse(new TextDecoder().decode(raw));
  }
  return { encode, decode, toB64u, fromB64u };
});

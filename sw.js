/* QueryCost service worker: network-first for app files, per-file cache, offline fallback.
   Bump CACHE on each release; old caches are removed on activate. */
const CACHE = 'querycost-v1';
const ASSETS = [
  './', './index.html', './styles.css', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
  './js/vendor/codemirror.js', './js/sqlutil.js', './js/catalog.js', './js/analyze.js', './js/pricing.js', './js/schedule.js', './js/estimate.js',
  './js/engine.js', './js/rewrite.js', './js/lint.js', './js/templates.js', './js/report.js', './js/share.js', './js/modal.js', './js/store.js',
  './js/ui.js', './js/dialogs.js', './js/app.js',
  './js/vendor/sqlparser/bigquery.umd.js', './js/vendor/sqlparser/snowflake.umd.js', './js/vendor/sqlparser/hive.umd.js', './js/vendor/sqlparser/redshift.umd.js',
  './js/vendor/sqlparser/athena.umd.js', './js/vendor/sqlparser/postgresql.umd.js', './js/vendor/sqlparser/trino.umd.js'
];
self.addEventListener('install', (e) => {
  self.skipWaiting();
  // Cache each file on its own so one failed request can't break install.
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(ASSETS.map((a) => c.add(new Request(a, { cache: 'reload' })).catch(() => {})))));
});
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('querycost-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // no-cache: always revalidate with the server, so a new release shows up on the next visit.
  e.respondWith(fetch(req, { cache: 'no-cache' }).then((res) => {
    if (res && res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true })
    .then((r) => r || (req.mode === 'navigate' ? caches.match('./index.html').then((i) => i || caches.match('./')) : undefined))
    .then((r) => r || Response.error())));
});

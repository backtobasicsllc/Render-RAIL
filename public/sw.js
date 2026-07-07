// Render Rail Studio — minimal service worker.
// Network-first so the dashboard is always live data; required for Chrome's Install prompt.
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  // pass everything straight through — the app is live data, never serve it stale
  e.respondWith(fetch(e.request).catch(() =>
    new Response('Offline — Render Rail needs a connection to the server.', { status: 503, headers: { 'Content-Type': 'text/plain' } })
  ));
});

/* Scalp Analyzer — cache v19 + chargement automatique du journal.
   Ce SW injecte journal.js dans index.html pour éviter de modifier le fichier principal. */
const C = 'scalp-v19';
const F = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './plan.js', './journal.js'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(C).then(cache => cache.addAll(F)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== C).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  // Navigation : récupérer le vrai index et ajouter le script après plan.js.
  if (request.mode === 'navigate' || /\/index\.html$/.test(new URL(request.url).pathname)) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (!response.ok) return response;
        const html = await response.text();
        if (html.includes('journal.js')) return new Response(html, { status: response.status, statusText: response.statusText, headers: response.headers });
        const script = '<script src="./journal.js?v=19"></script>';
        const injected = html.replace(/<\/body\s*>/i, script + '</body>');
        if (injected === html) return response;
        const headers = new Headers(response.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');
        headers.set('content-type', 'text/html; charset=utf-8');
        return new Response(injected, { status: response.status, statusText: response.statusText, headers });
      } catch (error) {
        const cached = await caches.match('./index.html');
        return cached || new Response('Scalp Analyzer est hors ligne. Reconnecte-toi pour charger la version à jour.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
});

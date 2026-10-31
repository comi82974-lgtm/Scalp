/* Scalp Analyzer — service worker v33.
   Modules indépendants (communauté + thème) ; moteur d'analyse inchangé. */
const C = 'scalp-v33';
const F = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './plan.js', './lot.js', './journal.js', './journal-dashboard.html', './community.js', './theme.css', './theme.js', './calendar.js'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(C).then(cache => Promise.allSettled(F.map(u => cache.add(new Request(u, { cache: 'reload' }))))));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== C).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if ((request.mode === 'navigate' && !/journal-dashboard\.html$/.test(url.pathname)) || /\/index\.html$/.test(url.pathname)) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: 'no-cache' });
        if (!response.ok) return response;
        const html = await response.text();
        let out = html;
        if (!out.includes('journal.js')) out = out.replace(/<\/body\s*>/i, '<script src="./journal.js?v=23"></script></body>');
        if (!out.includes('community.js')) out = out.replace(/<\/body\s*>/i, '<script src="./community.js?v=2"></script></body>');
        if (!out.includes('theme.css')) out = out.replace(/<\/head\s*>/i, '<link rel="stylesheet" href="./theme.css?v=1"></head>');
        if (!out.includes('theme.js')) out = out.replace(/<\/body\s*>/i, '<script src="./theme.js?v=1"></script></body>');
        if (!out.includes('calendar.js')) out = out.replace(/<\/body\s*>/i, '<script src="./calendar.js?v=1"></script></body>');
        const headers = new Headers(response.headers);
        headers.delete('content-length'); headers.delete('content-encoding');
        headers.set('content-type', 'text/html; charset=utf-8');
        return new Response(out, { status: response.status, statusText: response.statusText, headers });
      } catch (error) {
        const cached = await caches.match('./index.html');
        return cached || new Response('Scalp Analyzer est hors ligne. Reconnecte-toi pour charger la version à jour.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    try {
      const response = await fetch(request, { cache: 'no-cache' });
      if (response.ok && response.type === 'basic') {
        const copy = response.clone();
        caches.open(C).then(c => c.put(request, copy)).catch(() => {});
      }
      return response;
    } catch (error) {
      return (await caches.match(request, { ignoreSearch: true })) || Response.error();
    }
  })());
});

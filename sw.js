/* Scalp Analyzer — service worker v26 : réseau d'abord (les mises à jour s'appliquent seules), cache hors ligne en secours. */
const C = 'scalp-v26';
const F = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './plan.js', './lot.js', './journal.js', './journal-dashboard.html'];

self.addEventListener('install', event => {
  // Un fichier manquant ne doit jamais empêcher l'installation (allSettled au lieu de addAll).
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

  // Page principale : toujours la version du réseau ; journal.js est ajouté s'il n'est pas déjà dans index.html.
  if ((request.mode === 'navigate' && !/journal-dashboard\.html$/.test(url.pathname)) || /\/index\.html$/.test(url.pathname)) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: 'no-cache' });
        if (!response.ok) return response;
        const html = await response.text();
        let out = html;
        if (!html.includes('journal.js')) out = html.replace(/<\/body\s*>/i, '<script src="./journal.js?v=23"></script></body>');
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

  // Tout le reste : réseau d'abord (sans cache HTTP), puis copie en cache, secours hors ligne.
  event.respondWith((async () => {
    try {
      const response = await fetch(request, { cache: 'no-cache' });
      if (response.ok && response.type === 'basic') { const copy = response.clone(); caches.open(C).then(c => c.put(request, copy)).catch(() => {}); }
      return response;
    } catch (error) {
      return (await caches.match(request, { ignoreSearch: true })) || Response.error();
    }
  })());
});

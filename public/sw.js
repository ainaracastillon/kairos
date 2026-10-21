/* Service worker de Kairos: recibe las notificaciones push y abre la app al pulsarlas. */
const SHELL = 'kairos-shell-v1';
self.addEventListener('install', (event) => {
  self.skipWaiting();
  // Copia mínima para que la app instalada abra aunque no haya conexión.
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/styles.css', '/app.js', '/theme.js', '/nozoom.js', '/icons/icon-192.png'])).catch(() => {}));
});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Siempre se usa la versión más reciente de internet; la copia guardada solo si no hay conexión.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin || req.url.includes('/api/')) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (req.mode === 'navigate' || /\.(css|js|png|svg|woff2)$/.test(new URL(req.url).pathname))) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => (await caches.match(req.mode === 'navigate' ? '/' : req)) || Response.error())
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Kairos', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: data.tag,
      renotify: Boolean(data.tag),
      lang: 'es',
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const win of windows) {
        if (!win.url.startsWith(self.location.origin)) continue;
        await win.focus();
        try {
          await win.navigate(url);
        } catch {
          /* la ventana ya está abierta; basta con enfocarla */
        }
        return;
      }
      await self.clients.openWindow(url);
    })()
  );
});

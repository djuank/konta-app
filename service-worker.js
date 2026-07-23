// Service worker: guarda una copia de la app en el dispositivo para que
// abra sin internet una vez que la visitaste la primera vez.
const CACHE_NAME = 'konta-app-v8';
const ARCHIVOS_BASE = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/domain.js',
  './js/schema.js',
  './js/storage.js',
  './js/security.js',
  './js/precios.js',
  './vendor/sql-wasm.js',
  './vendor/sql-wasm.wasm',
  './vendor/chart.umd.js',
  './vendor/tabler/tabler-icons.min.css',
  './vendor/tabler/fonts/tabler-icons.woff2',
  './vendor/tabler/fonts/tabler-icons.woff',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ARCHIVOS_BASE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((nombres) =>
      Promise.all(nombres.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Cache-first: sirve del cache si existe, y de paso lo actualiza en segundo plano.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // Las consultas de precios (CoinGecko, TRM) NUNCA se cachean: si no,
  // al pedir "precio de hoy" el service worker devolvería el de ayer.
  // Van siempre directo a la red, y si falla, falla de verdad para que
  // la app pueda avisar en vez de mostrar un dato viejo como si fuera nuevo.
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const copia = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
          }
          return response;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

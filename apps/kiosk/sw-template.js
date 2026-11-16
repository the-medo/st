const CACHE = 'stapp-shell-__BUILD_ID__';
const FILES = __FILES__;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(FILES.map(path => new Request(path, {cache: 'reload'})));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const prior = await caches.keys();
    await Promise.all(prior.filter(key => key.startsWith('stapp-shell-') && key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const {origin, pathname} = new URL(event.request.url);
  if (event.request.method !== 'GET' || origin !== self.location.origin) return;
  if (pathname === '/') {
    event.respondWith(fetch(event.request).catch(() => caches.open(CACHE).then(cache => cache.match('/'))));
  } else if (pathname.startsWith('/assets/')) {
    event.respondWith(caches.open(CACHE).then(async cache => await cache.match(event.request) || fetch(event.request)));
  }
});

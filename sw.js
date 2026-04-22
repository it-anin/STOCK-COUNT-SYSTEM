const CACHE = 'stock-count-v1';
const ASSETS = [
  './', './index.html', './manifest.json',
  './icon-192.svg', './icon-512.svg',
  './jbm400.ttf', './jbm600.ttf',
  './Inter-Regular.ttf', './Inter-SemiBold.ttf', './Inter-Bold.ttf',
  './libs/papaparse.min.js', './libs/xlsx.full.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // Firestore/Firebase: network only
  if (url.includes('firestore') || url.includes('firebase') || url.includes('googleapis')) return;
  // Static assets: cache first, fallback network
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

const CACHE_NAME = 'papertrail-v2';
const APP_ASSETS = ['./', './index.html', './assets/css/normalize.css', './assets/css/style.css', './assets/js/app.js'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_ASSETS))));
self.addEventListener('fetch', event => { if (event.request.method !== 'GET') return; event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => { const copy = response.clone(); caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)); return response; }).catch(() => caches.match('./index.html')))); });

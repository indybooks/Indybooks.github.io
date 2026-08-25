const CACHE_NAME = 'indybooks-v3';
const ASSETS = [
    './',
    './index.html',
    './manifest.json',
    'https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.map(key => {
                if (key !== CACHE_NAME) return caches.delete(key);
            })
        ))
    );
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request).then(cached => {
            return cached || fetch(event.request).catch(() => caches.match('./index.html'));
        })
    );
});
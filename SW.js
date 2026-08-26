const SUPABASE_URL = 'https://rpgueqafknvrwvrbzixd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_TsTrCMyNceS2QH3b2MbpEg_A6MRkade';
const supabaseClient = supabase.createClient(https://rpgueqafknvrwvrbzixd.supabase.co, sb_publishable_TsTrCMyNceS2QH3b2MbpEg_A6MRkade);
const CACHE_NAME = 'indybooks-v5';
const ASSETS = [
    './',
    './index.html',
    './manifest.json',
    'https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
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

// Bump this on every deploy that touches a precached file. It's the only
// thing that forces a stale cache (and anyone already stuck on it) to clear -
// a browser that never redownloads sw.js never notices index.html changed.
const CACHE_NAME = 'indybooks-v11';
const ASSETS = [
    './',
    './index.html',
    './manifest.json',
    'https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

self.addEventListener('install', event => {
    // cache.addAll() is all-or-nothing: one flaky third-party CDN request
    // fails the whole install, forever, with no retry until the next deploy
    // changes this file. Fetch each asset independently so a single miss
    // (ad blocker, transient network blip) can't sink the rest.
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache =>
            Promise.all(ASSETS.map(url =>
                fetch(url)
                    .then(res => { if (res.ok) return cache.put(url, res); })
                    .catch(err => console.warn('Precache miss for', url, err))
            ))
        )
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

// Navigations (loading index.html itself) go network-first: a fresh deploy
// must be visible on the very next load, not only after a CACHE_NAME bump.
// Everything else (CDN libs, icons) is cache-first since it's either
// versioned in its URL or safe to serve slightly stale.
self.addEventListener('fetch', event => {
    // Never intercept anything but GET. There's nothing to cache for a
    // POST/PUT/PATCH/DELETE anyway (Supabase auth, REST upserts, Storage
    // uploads), and routing one through respondWith()/fetch(event.request)
    // means re-reading the original request's body - which Safari's
    // Service Worker implementation can fail on a large body with
    // "TypeError: Load failed", turning every cross-device audio upload
    // into a guaranteed failure with no way to retry around it. Returning
    // here leaves the event unhandled, so the browser makes the request
    // exactly as if no service worker existed.
    if (event.request.method !== 'GET') return;

    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request)
                .then(res => {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
                    return res;
                })
                .catch(() => caches.match(event.request).then(cached => cached || caches.match('./index.html')))
        );
        return;
    }

    // Falling back to index.html here (as the navigate branch above does) is
    // wrong for a sub-resource request: a <script> or <link> that can't be
    // fetched would get HTML back instead, which throws "Unexpected token
    // '<'" rather than just failing the one asset. Let it fail normally.
    event.respondWith(
        caches.match(event.request).then(cached => cached || fetch(event.request))
    );
});
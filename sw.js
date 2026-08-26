/* =========================================================================
   IndyBooks service worker

   Bump VERSION on every deploy. Cache names are derived from it, so the
   activate handler below deletes anything from an older version.

   The single most important rule in this file: DO NOT intercept audio.
   See shouldBypass() for why.
   ========================================================================= */

const VERSION = 'v5';
const SHELL_CACHE = `indybooks-shell-${VERSION}`;
const CDN_CACHE = `indybooks-cdn-${VERSION}`;
const ART_CACHE = `indybooks-art-${VERSION}`;
const OWNED = [SHELL_CACHE, CDN_CACHE, ART_CACHE];

// Cover images are user-supplied and unbounded, so this cache is trimmed.
const ART_MAX_ENTRIES = 60;

const SHELL_ASSETS = [
  './',
  './index.html',
  './app.js',
  './cloud.js',
  './supabase-config.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
];

// Third-party code the app shell depends on. Cached opportunistically —
// a miss here must never fail the install.
const CDN_HOSTS = new Set(['cdnjs.cloudflare.com', 'cdn.jsdelivr.net']);

// Hosts that must always hit the network. Serving a stale auth token or a
// stale podcast feed is worse than failing. Feed fetching now runs through a
// Supabase Edge Function, which the *.supabase.co rule below already covers,
// so this set is empty — kept as the hook for any future third-party host.
const NETWORK_ONLY_HOSTS = new Set([]);

const AUDIO_EXTENSIONS = /\.(mp3|m4a|m4b|aac|wav|ogg|opus|flac|mp4|webm)(\?|$)/i;

/* ------------------------------------------------------------------ *
 * Install — precache the shell
 * ------------------------------------------------------------------ */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll() is atomic: one 404 rejects the whole install and leaves the
    // old worker in place. That's the behaviour we want for the shell.
    await cache.addAll(SHELL_ASSETS.map((url) => new Request(url, { cache: 'reload' })));
  })());
  // Deliberately NOT calling skipWaiting() here. The new worker waits until
  // the user accepts the update, so we never swap assets under a running
  // playback session.
});

/* ------------------------------------------------------------------ *
 * Activate — drop old versions, enable navigation preload
 * ------------------------------------------------------------------ */

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable();
    }
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith('indybooks-') && !OWNED.includes(n))
        .map((n) => caches.delete(n)),
    );
    await self.clients.claim();
  })());
});

/* ------------------------------------------------------------------ *
 * Update handshake with the page
 * ------------------------------------------------------------------ */

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version: VERSION });
  }
  if (event.data && event.data.type === 'CLEAR_ART_CACHE') {
    event.waitUntil(caches.delete(ART_CACHE));
  }
});

/* ------------------------------------------------------------------ *
 * Fetch routing
 * ------------------------------------------------------------------ */

/**
 * Requests the service worker must not touch.
 *
 * The audio rules matter most. Browsers request media with a `Range` header
 * and expect a 206 Partial Content response. A service worker that answers
 * from cache returns a full 200, which breaks seeking outright on iOS Safari
 * and can make a long audiobook unseekable everywhere else. Passing the
 * request through untouched keeps the browser's own media cache and byte-range
 * machinery in charge, which is what you want for multi-hour files anyway.
 */
function shouldBypass(request, url) {
  if (request.method !== 'GET') return true;
  if (request.headers.has('range')) return true;
  if (request.destination === 'audio' || request.destination === 'video') return true;
  if (AUDIO_EXTENSIONS.test(url.pathname)) return true;
  if (url.protocol === 'blob:' || url.protocol === 'data:') return true;
  if (NETWORK_ONLY_HOSTS.has(url.hostname)) return true;
  // Supabase auth, PostgREST, and realtime must never be served stale.
  // Covers PostgREST, auth, Realtime, and signed Storage URLs in one rule.
  // Storage object paths have no file extension, so the audio-extension test
  // above would not catch them.
  if (url.hostname.endsWith('.supabase.co')) return true;
  if (url.pathname.includes('/storage/v1/object/')) return true;
  if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/rest/')) return true;
  return false;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  let url;
  try { url = new URL(request.url); } catch { return; }

  if (shouldBypass(request, url)) return;   // no respondWith → browser default

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
    return;
  }

  if (CDN_HOSTS.has(url.hostname)) {
    event.respondWith(cacheFirst(request, CDN_CACHE));
    return;
  }

  if (request.destination === 'image') {
    event.respondWith(cacheFirstImage(request));
    return;
  }

  // Anything else: straight to the network, cache nothing.
});

/* ------------------------------------------------------------------ *
 * Strategies
 * ------------------------------------------------------------------ */

/**
 * Navigation: try the network so deploys land immediately, fall back to the
 * cached shell when offline. The app is local-first, so the cached shell is
 * fully usable — the library lives in localStorage and IndexedDB.
 */
async function handleNavigation(event) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const preload = await event.preloadResponse;
    if (preload) {
      cache.put('./index.html', preload.clone()).catch(() => {});
      return preload;
    }
    const fresh = await fetch(event.request);
    cache.put('./index.html', fresh.clone()).catch(() => {});
    return fresh;
  } catch {
    return (await cache.match('./index.html'))
      || (await cache.match('./'))
      || offlineFallback();
  }
}

/** Serve from cache immediately, refresh in the background. */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
      return response;
    })
    .catch(() => null);

  return cached || (await network) || offlineFallback();
}

/** Versioned CDN assets never change under the same URL. */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    // Opaque (status 0) responses from no-cors font/CSS requests are still
    // worth storing — we just can't inspect them.
    if (response && (response.ok || response.type === 'opaque')) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    return offlineFallback();
  }
}

/** Cover art, with a hard cap so a big library can't fill the quota. */
async function cacheFirstImage(request) {
  const cache = await caches.open(ART_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && (response.ok || response.type === 'opaque')) {
      await cache.put(request, response.clone());
      trimCache(ART_CACHE, ART_MAX_ENTRIES);
    }
    return response;
  } catch {
    // A missing cover is cosmetic; a transparent pixel beats a broken icon.
    return transparentPixel();
  }
}

/** cache.keys() preserves insertion order, so the head is the oldest entry. */
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await Promise.all(keys.slice(0, keys.length - maxEntries).map((k) => cache.delete(k)));
}

/* ------------------------------------------------------------------ *
 * Fallbacks
 * ------------------------------------------------------------------ */

function offlineFallback() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Offline</title>'
    + '<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;background:#F8F9FA;'
    + 'color:#2B4C6D;display:grid;place-items:center;height:100vh;margin:0;text-align:center;padding:24px}'
    + 'p{color:#6B7B8C;font-size:14px}</style>'
    + '<div><h1>You are offline</h1><p>Reconnect to load this part of IndyBooks. '
    + 'Anything already downloaded to this device will still play.</p></div>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

function transparentPixel() {
  const gif = Uint8Array.from(
    atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
    (c) => c.charCodeAt(0),
  );
  return new Response(gif, { status: 200, headers: { 'Content-Type': 'image/gif' } });
}

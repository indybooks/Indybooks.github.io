/* =========================================================================
   IndyBooks — Podcast & Audiobook Hub
   Application logic.

   NOTE ON CREDENTIALS: this build ships with NO hardcoded Supabase project
   URL or key. The user supplies their own in the Cloud Sync modal and they
   are stored under namespaced localStorage keys. Never commit real keys to
   a client bundle — even "publishable" keys tie your project to your app.
   ========================================================================= */

'use strict';

/* ------------------------------------------------------------------ *
 * 1. Constants & state
 * ------------------------------------------------------------------ */

const LS = {
  items: 'indybooks_items',
  folders: 'indybooks_folders',
  goodreads: 'indybooks_goodreads',
  supabaseUrl: 'indybooks_supabase_url',
  supabaseKey: 'indybooks_supabase_key',
  prefs: 'indybooks_prefs',
};

// How often we persist / sync while audio is playing.
// `timeupdate` fires ~4x per second; writing to localStorage and hitting the
// network on every one of those events was the single largest perf problem
// in the original build.
const LOCAL_SAVE_INTERVAL_MS = 5000;
const CLOUD_SYNC_INTERVAL_MS = 15000;

const DEFAULT_FOLDERS = ['Indie Mystery', 'Podcasts'];
const RSS_EPISODE_LIMIT = 50;
const SPEED_MIN = 0.5;
const SPEED_MAX = 3.0;
const SLOTH_RATE = 0.5;

const appState = {
  items: [],
  folders: [],
  goodreadsUser: null,
  currentId: null,
  isPlaying: false,
  slothMode: false,
  volume: 1,
  lastSpeed: 1,
};

// Transient runtime state — deliberately kept out of appState so it never
// gets serialised into localStorage or an export file.
const runtime = {
  sleepTimerTimeout: null,
  sleepTimerInterval: null,
  sleepTimerEndsAt: null,
  isSeeking: false,
  objectUrl: null,
  lastLocalSave: 0,
  lastCloudSync: 0,
  searchDebounce: null,
  collapsedFolders: new Set(),
};

/* ------------------------------------------------------------------ *
 * 2. Cached DOM references
 * ------------------------------------------------------------------ */

const dom = {};

function cacheDom() {
  const ids = [
    'library-container', 'mini-player', 'mini-progress', 'mini-cover',
    'mini-title', 'mini-subtitle', 'mini-play-btn', 'sloth-mode-btn',
    'player-modal', 'modal-cover-container', 'modal-title', 'modal-subtitle',
    'modal-org-title', 'modal-time-remaining', 'modal-listened-pct',
    'modal-seek-slider', 'current-time-label', 'total-time-label',
    'modal-play-btn', 'modal-sloth-btn', 'speed-label', 'volume-label',
    'app-volume-slider', 'sleep-timer-label', 'bookmark-count-badge',
    'bookmarks-list', 'sync-status-badge', 'user-status-subtitle',
    'auth-unlogged-view', 'auth-logged-view', 'auth-user-email', 'project-ref',
    'goodreads-unlogged', 'goodreads-logged', 'goodreads-account-display',
    'tag-cloud', 'search-results', 'search-input', 'toast-region',
    'main-audio-element', 'edit-folder-select', 'direct-folder-select',
  ];
  ids.forEach((id) => { dom[id] = document.getElementById(id); });
}

/** @type {HTMLAudioElement} */
let audioEl;

/* ------------------------------------------------------------------ *
 * 3. Utilities
 * ------------------------------------------------------------------ */

/** Escape text before it goes anywhere near innerHTML. */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function uid(prefix) {
  const rand = (crypto && crypto.randomUUID)
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

function formatTime(secs) {
  // Live streams report Infinity; the original code produced "Infinity:NaN".
  if (!Number.isFinite(secs) || secs < 0) return '--:--';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

let toastTimer = null;
/** Non-blocking replacement for alert(), which freezes the main thread. */
function toast(message, tone = 'info') {
  if (!dom['toast-region']) return;
  const el = dom['toast-region'];
  el.textContent = message;
  el.className = `toast toast--${tone} toast--visible`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3600);
}

function findItem(id) {
  return appState.items.find((i) => i.id === id) || null;
}

function currentItem() {
  return appState.currentId ? findItem(appState.currentId) : null;
}

/* ------------------------------------------------------------------ *
 * 4. IndexedDB — persistent storage for locally uploaded audio
 *
 * The original build stored `URL.createObjectURL(file)` in localStorage.
 * Blob URLs are scoped to the document that created them, so every uploaded
 * file became permanently unplayable on the next page load (and leaked
 * memory, since nothing was ever revoked). We keep the Blob itself here.
 * ------------------------------------------------------------------ */

const blobStore = {
  _db: null,
  async open() {
    if (this._db) return this._db;
    this._db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('indybooks-media', 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('files')) {
          req.result.createObjectStore('files');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._db;
  },
  async _tx(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', mode);
      const req = fn(tx.objectStore('files'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  put(id, blob) { return this._tx('readwrite', (s) => s.put(blob, id)); },
  get(id) { return this._tx('readonly', (s) => s.get(id)); },
  remove(id) { return this._tx('readwrite', (s) => s.delete(id)); },
};

/* ------------------------------------------------------------------ *
 * 5. Persistence
 * ------------------------------------------------------------------ */

function loadState() {
  const readJson = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      console.warn(`Could not parse ${key}; falling back to defaults.`);
      return fallback;
    }
  };

  appState.items = readJson(LS.items, []);
  appState.folders = readJson(LS.folders, DEFAULT_FOLDERS.slice());
  appState.goodreadsUser = localStorage.getItem(LS.goodreads) || null;

  const prefs = readJson(LS.prefs, {});
  appState.volume = typeof prefs.volume === 'number' ? prefs.volume : 1;
  appState.slothMode = !!prefs.slothMode;
  appState.lastSpeed = typeof prefs.lastSpeed === 'number' ? prefs.lastSpeed : 1;

  // Guard against malformed persisted data.
  if (!Array.isArray(appState.items)) appState.items = [];
  if (!Array.isArray(appState.folders)) appState.folders = DEFAULT_FOLDERS.slice();
  appState.items.forEach((i) => {
    if (!Array.isArray(i.tags)) i.tags = [];
    if (!Array.isArray(i.bookmarks)) i.bookmarks = [];
    if (typeof i.currentTime !== 'number') i.currentTime = 0;
    if (typeof i.duration !== 'number') i.duration = 0;
  });
}

/** Write to localStorage immediately. Called on discrete user actions. */
function saveState() {
  try {
    // Blob URLs are runtime-only; never persist them.
    const serialisable = appState.items.map((i) => ({ ...i, url: i.local ? '' : i.url }));
    localStorage.setItem(LS.items, JSON.stringify(serialisable));
    localStorage.setItem(LS.folders, JSON.stringify(appState.folders));
    localStorage.setItem(LS.prefs, JSON.stringify({
      volume: appState.volume,
      slothMode: appState.slothMode,
      lastSpeed: appState.lastSpeed,
    }));
    if (appState.goodreadsUser) localStorage.setItem(LS.goodreads, appState.goodreadsUser);
    else localStorage.removeItem(LS.goodreads);
    runtime.lastLocalSave = Date.now();
  } catch (err) {
    console.error('Save failed', err);
    toast('Storage is full. Remove some items or export a backup.', 'error');
  }
}

/** Throttled save, safe to call from high-frequency handlers. */
function saveStateThrottled() {
  if (Date.now() - runtime.lastLocalSave >= LOCAL_SAVE_INTERVAL_MS) saveState();
}
/* ------------------------------------------------------------------ *
 * 6. Cloud sync (delegates to cloud.js)
 * ------------------------------------------------------------------ */

/**
 * If cloud.js or supabase-js failed to load — blocked CDN, offline first
 * visit, ad blocker — fall back to a no-op so the app still runs entirely on
 * localStorage and IndexedDB instead of dying at init.
 */
const Cloud = window.Cloud || (() => {
  console.warn('cloud.js unavailable; running local-only.');
  const noop = () => {};
  return {
    init: () => Promise.resolve(null),
    on: noop, status: () => 'unconfigured', isConfigured: () => false,
    isSignedIn: () => false, currentUser: () => null, projectRef: () => 'unavailable',
    signIn: () => Promise.reject(new Error('Cloud sync is unavailable.')),
    signUp: () => Promise.reject(new Error('Cloud sync is unavailable.')),
    signOut: () => Promise.resolve(),
    pullLibrary: () => Promise.resolve(null),
    upsertItem: noop, upsertItems: noop, deleteItem: noop,
    upsertFolder: noop, deleteFolder: noop, replaceBookmarks: noop,
    trackProgress: noop, flush: () => Promise.resolve(), pendingCount: () => 0,
    canUpload: () => false, uploadAudio: () => Promise.reject(new Error('unavailable')),
    removeAudio: noop, signedUrl: () => Promise.reject(new Error('unavailable')),
    maxUploadBytes: () => 0,
  };
})();

function initCloud() {
  Cloud.on('status', paintSyncStatus);
  Cloud.on('change', onCloudChange);

  Cloud.init().then((signedInUser) => {
    if (signedInUser) {
      updateAuthUI(true);
      pullFromCloud({ quiet: true });
    } else {
      updateAuthUI(false);
    }
    paintSyncStatus(Cloud.status());
  });
}

function onCloudChange(evt) {
  if (evt.reason === 'signed-out') { updateAuthUI(false); return; }
  if (evt.reason === 'auth' && evt.user) { updateAuthUI(true); pullFromCloud({ quiet: true }); return; }
  // A Realtime event means another device changed something. Re-pull rather
  // than patching from the payload, so one code path owns the merge rules.
  if (evt.reason === 'realtime') schedulePull();
}

let pullTimer = null;
function schedulePull() {
  clearTimeout(pullTimer);
  pullTimer = setTimeout(() => pullFromCloud({ quiet: true }), 1200);
}

function paintSyncStatus(state) {
  const badge = dom['sync-status-badge'];
  const map = {
    unconfigured: ['Local', ''],
    'signed-out': ['Local', ''],
    offline: ['Offline', 'badge--offline'],
    pending: [`Syncing${Cloud.pendingCount() ? ` ${Cloud.pendingCount()}` : ''}`, 'badge--pending'],
    synced: ['Synced', 'badge--synced'],
  };
  const [label, cls] = map[state] || map.unconfigured;
  badge.textContent = label;
  badge.className = `badge${cls ? ` ${cls}` : ''}`;
  badge.title = {
    unconfigured: 'Cloud sync is not configured in this build.',
    'signed-out': 'Saved on this device only. Sign in to sync.',
    offline: 'Offline. Changes are queued and will sync when you reconnect.',
    pending: 'Sending changes to the cloud.',
    synced: 'Everything is saved to your account.',
  }[state] || '';
}

async function signIn() {
  const email = document.getElementById('auth-email-input').value.trim();
  const password = document.getElementById('auth-pass-input').value;
  if (!email || !password) { toast('Enter an email and password.', 'error'); return; }
  try {
    await Cloud.signIn(email, password);
    updateAuthUI(true);
    document.getElementById('auth-pass-input').value = '';
    await pullFromCloud({});
    closeModals();
  } catch (err) {
    toast(err.message || 'Could not sign in.', 'error');
  }
}

async function signUp() {
  const email = document.getElementById('auth-email-input').value.trim();
  const password = document.getElementById('auth-pass-input').value;
  if (!email || !password) { toast('Enter an email and password.', 'error'); return; }
  if (password.length < 6) { toast('Use at least 6 characters.', 'error'); return; }
  try {
    await Cloud.signUp(email, password);
    toast('Check your email to confirm the account.', 'success');
  } catch (err) {
    toast(err.message || 'Could not create the account.', 'error');
  }
}

async function signOut() {
  toast('Saving your changes…');
  await Cloud.signOut();
  updateAuthUI(false);
  closeModals();
  toast('Signed out. This device keeps its own copy.');
}

function updateAuthUI(isLoggedIn) {
  const user = Cloud.currentUser();
  const sub = dom['user-status-subtitle'];

  if (isLoggedIn && user) {
    dom['auth-unlogged-view'].classList.add('hidden');
    dom['auth-logged-view'].classList.remove('hidden');
    dom['auth-user-email'].textContent = user.email || '';
    sub.textContent = user.email || 'Signed in';
  } else {
    dom['auth-unlogged-view'].classList.remove('hidden');
    dom['auth-logged-view'].classList.add('hidden');
    sub.textContent = 'Podcast & Audiobook Hub';
  }
  dom['project-ref'].textContent = Cloud.isConfigured() ? Cloud.projectRef() : 'not configured';
  paintSyncStatus(Cloud.status());
}

/**
 * Merge the server's library into the local one.
 *
 * Rules, applied per item:
 *   - present only locally  → kept, and queued for upload
 *   - present only remotely → adopted
 *   - present in both       → server row wins for metadata, but playback
 *                             position takes whichever is further along, so
 *                             listening on a phone is never undone by a
 *                             stale desktop tab
 */
async function pullFromCloud({ quiet = false } = {}) {
  if (!Cloud.isSignedIn()) {
    if (!quiet) toast('Sign in first.', 'error');
    return;
  }
  try {
    const remote = await Cloud.pullLibrary();
    if (!remote) return;

    const byId = new Map(appState.items.map((i) => [i.id, i]));
    const remoteIds = new Set();
    let adopted = 0;

    remote.items.forEach((row) => {
      remoteIds.add(row.id);
      const local = byId.get(row.id);
      if (!local) { byId.set(row.id, row); adopted += 1; return; }
      byId.set(row.id, Object.assign({}, row, {
        currentTime: Math.max(row.currentTime || 0, local.currentTime || 0),
        duration: row.duration || local.duration || 0,
        // Files still only on this device stay playable offline.
        local: local.local && !row.storagePath,
        bookmarks: row.bookmarks.length ? row.bookmarks : (local.bookmarks || []),
      }));
    });

    appState.items = Array.from(byId.values());

    remote.folders.forEach((f) => { if (!appState.folders.includes(f)) appState.folders.push(f); });
    appState.items.forEach((i) => {
      if (i.folder && !appState.folders.includes(i.folder)) appState.folders.push(i.folder);
    });

    // Anything the server has never seen goes up now.
    const unsynced = appState.items.filter((i) => !remoteIds.has(i.id));
    if (unsynced.length) Cloud.upsertItems(unsynced);
    appState.folders.forEach((f) => { if (!remote.folders.includes(f)) Cloud.upsertFolder(f); });

    saveState();
    renderLibrary();
    updateFolderDropdowns();
    if (appState.currentId) { updatePlayerUI(); updateBookmarkBadge(); }

    if (!quiet) {
      toast(adopted || unsynced.length
        ? `Synced. ${adopted} in, ${unsynced.length} out.`
        : 'Already up to date.', 'success');
    }
  } catch (err) {
    console.error('Pull failed', err);
    if (!quiet) toast(err.message || 'Could not reach your library.', 'error');
  }
}

/* ------------------------------------------------------------------ *
 * 7. Library rendering
 * ------------------------------------------------------------------ */

function renderLibrary() {
  const container = dom['library-container'];
  container.innerHTML = '';

  if (appState.items.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon"><i class="fa-solid fa-headphones" aria-hidden="true"></i></div>
        <h2>Your library is empty</h2>
        <p>Add an RSS feed, link an audio URL, or upload files from this device to start listening.</p>
      </div>`;
    return;
  }

  const fragment = document.createDocumentFragment();

  appState.folders.forEach((folder) => {
    const folderItems = appState.items.filter((item) => item.folder === folder);
    const collapsed = runtime.collapsedFolders.has(folder);
    const el = document.createElement('section');
    el.className = 'card';
    el.innerHTML = `
      <button class="folder-head" type="button" data-action="toggle-folder" data-folder="${esc(folder)}"
              aria-expanded="${!collapsed}">
        <span class="folder-head__label">
          <i class="fa-solid fa-folder" aria-hidden="true"></i>
          <span>${esc(folder)}</span>
          <span class="folder-head__count">${folderItems.length}</span>
        </span>
        <span class="folder-head__actions">
          <span class="icon-btn icon-btn--sm" role="button" tabindex="0"
                data-action="delete-folder" data-folder="${esc(folder)}"
                aria-label="Delete folder ${esc(folder)}">
            <i class="fa-solid fa-trash" aria-hidden="true"></i>
          </span>
          <i class="fa-solid fa-chevron-${collapsed ? 'right' : 'down'} folder-head__chevron" aria-hidden="true"></i>
        </span>
      </button>
      <div class="item-list${collapsed ? ' hidden' : ''}">
        ${folderItems.length === 0
          ? '<p class="item-list__empty">Nothing here yet</p>'
          : folderItems.map(renderItemCard).join('')}
      </div>`;
    fragment.appendChild(el);
  });

  const ungrouped = appState.items.filter(
    (item) => !item.folder || !appState.folders.includes(item.folder),
  );
  if (ungrouped.length > 0) {
    const el = document.createElement('section');
    el.className = 'card';
    el.innerHTML = `
      <div class="folder-head folder-head--static">
        <span class="folder-head__label">
          <i class="fa-solid fa-inbox" aria-hidden="true"></i>
          <span>Ungrouped</span>
          <span class="folder-head__count">${ungrouped.length}</span>
        </span>
      </div>
      <div class="item-list">${ungrouped.map(renderItemCard).join('')}</div>`;
    fragment.appendChild(el);
  }

  container.appendChild(fragment);
}

function renderItemCard(item) {
  const hasDuration = Number.isFinite(item.duration) && item.duration > 0;
  const pct = hasDuration ? Math.min(100, Math.round((item.currentTime / item.duration) * 100)) : 0;
  const remaining = hasDuration ? formatTime(item.duration - item.currentTime) : '--:--';
  const isCurrent = appState.currentId === item.id;
  const playable = !!item.url || !!item.local;

  const tags = (item.tags || [])
    .filter(Boolean)
    .map((t) => `<span class="tag">#${esc(t)}</span>`)
    .join('');

  return `
    <div class="item${isCurrent ? ' item--current' : ''}">
      <button class="item__main" type="button" data-action="play" data-id="${esc(item.id)}"
              ${playable ? '' : 'aria-disabled="true"'}>
        <span class="item__cover">
          ${item.cover
            ? `<img src="${esc(item.cover)}" alt="" loading="lazy" decoding="async">`
            : `<i class="fa-solid fa-${item.local ? 'file-audio' : 'music'}" aria-hidden="true"></i>`}
        </span>
        <span class="item__body">
          <span class="item__title">${esc(item.title)}</span>
          <span class="item__meta">
            <span class="progress"><span class="progress__fill" style="width:${pct}%"></span></span>
            <span class="item__stats">${pct}% &middot; ${remaining}</span>
          </span>
          ${tags ? `<span class="item__tags">${tags}</span>` : ''}
        </span>
      </button>
      <button class="icon-btn icon-btn--sm" type="button" data-action="edit" data-id="${esc(item.id)}"
              aria-label="Edit ${esc(item.title)}">
        <i class="fa-solid fa-ellipsis-vertical" aria-hidden="true"></i>
      </button>
    </div>`;
}

function updateFolderDropdowns() {
  const selects = [dom['edit-folder-select'], dom['direct-folder-select']];
  selects.forEach((select) => {
    if (!select) return;
    const previous = select.value;
    // Build once, assign once — the original concatenated innerHTML inside a
    // loop, forcing the browser to reparse the whole select on every folder.
    const options = ['<option value="">(None — Ungrouped)</option>']
      .concat(appState.folders.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`));
    select.innerHTML = options.join('');
    select.value = previous;
  });
}

/* ------------------------------------------------------------------ *
 * 8. Playback
 * ------------------------------------------------------------------ */

function releaseObjectUrl() {
  if (runtime.objectUrl) {
    URL.revokeObjectURL(runtime.objectUrl);
    runtime.objectUrl = null;
  }
}

/**
 * Resolve a playable source, cheapest first:
 *   1. an on-device copy in IndexedDB — instant, works offline
 *   2. a signed Storage URL, for a file uploaded from another device
 *   3. a plain public URL (RSS enclosure or pasted link)
 */
async function resolveSource(item) {
  const blob = await blobStore.get(item.id).catch(() => null);
  if (blob) {
    releaseObjectUrl();
    runtime.objectUrl = URL.createObjectURL(blob);
    return runtime.objectUrl;
  }

  if (item.storagePath) {
    if (!Cloud.isSignedIn()) return null;
    try {
      return await Cloud.signedUrl(item.storagePath);
    } catch (err) {
      console.error('Could not sign Storage URL', err);
      return null;
    }
  }

  return item.url || null;
}

async function playItem(id) {
  const item = findItem(id);
  if (!item) return;

  // Flush progress for the outgoing track before switching.
  if (appState.currentId && appState.currentId !== id) {
    saveState();
    Cloud.flush();
  }

  const src = await resolveSource(item);
  if (!src) {
    if (item.storagePath && !Cloud.isSignedIn()) {
      toast('Sign in to stream this upload from your account.', 'error');
    } else if (item.local || item.storagePath) {
      toast('That file is not available on this device yet.', 'error');
    } else {
      toast('This entry has no audio — it is a reading log only.', 'error');
    }
    return;
  }

  const previousId = appState.currentId;
  appState.currentId = id;

  audioEl.src = src;
  audioEl.playbackRate = appState.slothMode ? SLOTH_RATE : (item.speed || 1.0);
  audioEl.volume = appState.volume;

  // Repaint only the two rows whose highlight changed, instead of rebuilding
  // the entire library DOM the way the original did on every play.
  refreshItemHighlight(previousId, id);
  updatePlayerUI();
  updateBookmarkBadge();
}

function refreshItemHighlight(previousId, nextId) {
  dom['library-container'].querySelectorAll('.item--current').forEach((el) => {
    el.classList.remove('item--current');
  });
  const next = dom['library-container'].querySelector(`[data-action="play"][data-id="${CSS.escape(nextId)}"]`);
  if (next && next.parentElement) next.parentElement.classList.add('item--current');
  void previousId;
}

function onAudioMetadataLoaded() {
  const item = currentItem();
  if (!item) return;
  if (Number.isFinite(audioEl.duration)) item.duration = audioEl.duration;
  const resume = item.currentTime || 0;
  if (resume > 0 && resume < (item.duration - 1)) {
    try { audioEl.currentTime = resume; } catch { /* seek unsupported on some streams */ }
  }
  updateSeekBounds();
  attemptPlay();
}

function attemptPlay() {
  const promise = audioEl.play();
  if (promise && typeof promise.then === 'function') {
    promise
      .then(() => { appState.isPlaying = true; updatePlayPauseUI(); })
      .catch((err) => {
        // Autoplay policies reject silently in the original build, leaving the
        // UI showing a pause icon while nothing was playing.
        appState.isPlaying = false;
        updatePlayPauseUI();
        if (err && err.name !== 'AbortError') {
          toast('Press play to start — your browser blocked autoplay.');
        }
      });
  }
}

function togglePlayPause() {
  if (!appState.currentId) {
    const first = appState.items.find((i) => i.url || i.local);
    if (first) playItem(first.id);
    else toast('Add something to your library first.');
    return;
  }
  if (audioEl.paused) {
    attemptPlay();
  } else {
    audioEl.pause();
    appState.isPlaying = false;
    updatePlayPauseUI();
    saveState();
    Cloud.flush();
  }
}

function onAudioTimeUpdate() {
  const item = currentItem();
  if (!item) return;

  item.currentTime = audioEl.currentTime;
  if (Number.isFinite(audioEl.duration)) item.duration = audioEl.duration;

  updatePlayerProgressUI();
  saveStateThrottled();      // was: full localStorage write ~4x/second
  Cloud.trackProgress(item); // coalesced; was a request ~4x/second
}

/** Auto-advance. The original referenced onAudioEnded() but never defined it. */
function onAudioEnded() {
  const item = currentItem();
  if (item) { item.currentTime = 0; }
  appState.isPlaying = false;
  saveState();
  Cloud.flush();

  const queue = appState.items.filter((i) => i.url || i.local);
  const idx = queue.findIndex((i) => i.id === appState.currentId);
  if (idx > -1 && idx < queue.length - 1) {
    playItem(queue[idx + 1].id);
  } else {
    updatePlayPauseUI();
    toast('Reached the end of your library.');
  }
}

function onAudioError() {
  appState.isPlaying = false;
  updatePlayPauseUI();
  toast('That file could not be loaded. Check the link or your connection.', 'error');
}

function skipTime(seconds) {
  if (!appState.currentId) return;
  const max = Number.isFinite(audioEl.duration) ? audioEl.duration : Infinity;
  // The original clamped against `audioEl.duration || 0`, which snapped live
  // streams and not-yet-loaded files back to zero.
  audioEl.currentTime = Math.max(0, Math.min(max, audioEl.currentTime + seconds));
}

function adjustSpeed(delta) {
  if (appState.slothMode) {
    toast('Turn off Tree Sloth to change speed.');
    return;
  }
  const next = Math.round(Math.max(SPEED_MIN, Math.min(SPEED_MAX, (audioEl.playbackRate || 1) + delta)) * 10) / 10;
  audioEl.playbackRate = next;
  appState.lastSpeed = next;
  const item = currentItem();
  if (item) item.speed = next;
  saveState();
  updateSpeedUI();
}

function toggleSlothMode() {
  appState.slothMode = !appState.slothMode;
  if (appState.slothMode) {
    audioEl.playbackRate = SLOTH_RATE;
  } else {
    const item = currentItem();
    audioEl.playbackRate = (item && item.speed) || appState.lastSpeed || 1.0;
  }
  dom['sloth-mode-btn'].classList.toggle('is-active', appState.slothMode);
  dom['sloth-mode-btn'].setAttribute('aria-pressed', String(appState.slothMode));
  if (dom['modal-sloth-btn']) {
    dom['modal-sloth-btn'].classList.toggle('is-active', appState.slothMode);
    dom['modal-sloth-btn'].setAttribute('aria-pressed', String(appState.slothMode));
  }
  saveState();
  updateSpeedUI();
}

function adjustAppVolume(val) {
  appState.volume = parseFloat(val);
  audioEl.volume = appState.volume;
  dom['volume-label'].textContent = `${Math.round(appState.volume * 100)}%`;
  saveStateThrottled();
}

function seekAudioBar(event) {
  const item = currentItem();
  if (!item || !Number.isFinite(item.duration) || item.duration <= 0) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const point = event.clientX ?? (event.touches && event.touches[0] && event.touches[0].clientX);
  if (point == null) return;
  const pos = Math.max(0, Math.min(1, (point - rect.left) / rect.width));
  audioEl.currentTime = pos * item.duration;
}

/* ------------------------------------------------------------------ *
 * 9. Player UI
 * ------------------------------------------------------------------ */

function updateSeekBounds() {
  const item = currentItem();
  const slider = dom['modal-seek-slider'];
  if (!item || !Number.isFinite(item.duration) || item.duration <= 0) {
    slider.max = 0;
    slider.disabled = true;
    return;
  }
  slider.disabled = false;
  // Set max once per track rather than on every timeupdate tick.
  if (Number(slider.max) !== item.duration) slider.max = item.duration;
}

function updatePlayerProgressUI() {
  const item = currentItem();
  if (!item) return;
  const dur = Number.isFinite(item.duration) && item.duration > 0 ? item.duration : 0;
  const pct = dur ? (audioEl.currentTime / dur) * 100 : 0;

  dom['mini-progress'].style.width = `${pct}%`;
  dom['current-time-label'].textContent = formatTime(audioEl.currentTime);
  dom['total-time-label'].textContent = dur ? formatTime(dur) : '--:--';
  dom['modal-time-remaining'].textContent = `Time remaining: ${dur ? formatTime(dur - audioEl.currentTime) : '--:--'}`;
  dom['modal-listened-pct'].textContent = `${Math.round(pct)}% listened`;

  // Don't fight the user's finger while they are dragging the slider. The
  // original wrote to .value on every tick, so the thumb snapped back.
  if (!runtime.isSeeking) dom['modal-seek-slider'].value = audioEl.currentTime;
}

function updatePlayPauseUI() {
  const icon = appState.isPlaying ? 'pause' : 'play';
  const label = appState.isPlaying ? 'Pause' : 'Play';
  dom['mini-play-btn'].innerHTML = `<i class="fa-solid fa-${icon}" aria-hidden="true"></i>`;
  dom['mini-play-btn'].setAttribute('aria-label', label);
  dom['modal-play-btn'].innerHTML = `<i class="fa-solid fa-${icon}" aria-hidden="true"></i>`;
  dom['modal-play-btn'].setAttribute('aria-label', label);
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = appState.isPlaying ? 'playing' : 'paused';
  }
}

function updateSpeedUI() {
  dom['speed-label'].textContent = `${(audioEl.playbackRate || 1).toFixed(1)}x`;
}

function updatePlayerUI() {
  const item = currentItem();
  updatePlayPauseUI();
  updateSpeedUI();
  dom['volume-label'].textContent = `${Math.round(appState.volume * 100)}%`;
  dom['app-volume-slider'].value = appState.volume;

  if (!item) return;

  dom['mini-title'].textContent = item.title;
  dom['mini-subtitle'].textContent = item.folder || 'Ungrouped';
  dom['modal-title'].textContent = item.title;
  dom['modal-subtitle'].textContent = item.folder || 'IndyBooks audio';
  dom['modal-org-title'].textContent = item.title;

  setCover(dom['mini-cover'], item.cover, 'fa-headphones');
  setCover(dom['modal-cover-container'], item.cover, 'fa-headphones');
  updateMediaSession(item);
}

/** Only touch the DOM when the artwork actually changed — the original
 *  rewrote innerHTML on every UI update, re-fetching and flashing the image. */
function setCover(el, url, fallbackIcon) {
  if (!el) return;
  if (url) {
    if (el.dataset.cover === url) return;
    el.dataset.cover = url;
    el.innerHTML = `<img src="${esc(url)}" alt="" decoding="async">`;
  } else {
    if (el.dataset.cover === '') return;
    el.dataset.cover = '';
    el.innerHTML = `<i class="fa-solid ${fallbackIcon}" aria-hidden="true"></i>`;
  }
}

/** Lock-screen / headset controls. */
function updateMediaSession(item) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: item.title,
    artist: item.folder || 'IndyBooks',
    album: 'IndyBooks',
    artwork: item.cover ? [{ src: item.cover, sizes: '512x512' }] : [],
  });
}

function registerMediaSessionHandlers() {
  if (!('mediaSession' in navigator)) return;
  const set = (action, handler) => {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported */ }
  };
  set('play', () => attemptPlay());
  set('pause', () => { audioEl.pause(); appState.isPlaying = false; updatePlayPauseUI(); });
  set('seekbackward', () => skipTime(-15));
  set('seekforward', () => skipTime(30));
  set('nexttrack', () => onAudioEnded());
}

/* ------------------------------------------------------------------ *
 * 10. Bookmarks
 * ------------------------------------------------------------------ */

function addBookmark() {
  const item = currentItem();
  if (!item) { toast('Start playing something first.'); return; }
  if (!Array.isArray(item.bookmarks)) item.bookmarks = [];
  const stamp = audioEl.currentTime;
  item.bookmarks.push({ id: uid('bm'), time: stamp, title: `Bookmark at ${formatTime(stamp)}` });
  item.bookmarks.sort((a, b) => a.time - b.time);
  saveState();
  Cloud.replaceBookmarks(item);
  updateBookmarkBadge();
  toast(`Bookmarked ${formatTime(stamp)}`, 'success');
}

function deleteBookmark(bookmarkId) {
  const item = currentItem();
  if (!item) return;
  item.bookmarks = (item.bookmarks || []).filter((b) => b.id !== bookmarkId);
  saveState();
  Cloud.replaceBookmarks(item);
  renderBookmarksList();
  updateBookmarkBadge();
}

function updateBookmarkBadge() {
  const item = currentItem();
  const count = item && item.bookmarks ? item.bookmarks.length : 0;
  dom['bookmark-count-badge'].textContent = String(count);
  dom['bookmark-count-badge'].classList.toggle('hidden', count === 0);
}

function renderBookmarksList() {
  const item = currentItem();
  const list = dom['bookmarks-list'];
  if (!item || !item.bookmarks || item.bookmarks.length === 0) {
    list.innerHTML = '<p class="item-list__empty">No bookmarks yet. Tap the bookmark button while listening.</p>';
    return;
  }
  list.innerHTML = item.bookmarks.map((b) => `
    <div class="bookmark">
      <div>
        <p class="bookmark__title">${esc(b.title)}</p>
        <span class="bookmark__time">${formatTime(b.time)}</span>
      </div>
      <div class="bookmark__actions">
        <button class="btn btn--sm btn--primary" type="button" data-action="jump" data-time="${b.time}">Jump</button>
        <button class="icon-btn icon-btn--sm" type="button" data-action="delete-bookmark" data-id="${esc(b.id)}"
                aria-label="Delete ${esc(b.title)}">
          <i class="fa-solid fa-trash" aria-hidden="true"></i>
        </button>
      </div>
    </div>`).join('');
}

/* ------------------------------------------------------------------ *
 * 11. Adding content
 * ------------------------------------------------------------------ */

function newItem(overrides) {
  return Object.assign({
    id: uid('item'),
    title: 'Untitled',
    url: '',
    folder: '',
    cover: '',
    tags: [],
    currentTime: 0,
    duration: 0,
    speed: 1.0,
    bookmarks: [],
    local: false,
    storagePath: null,
  }, overrides);
}

async function handleLocalFiles(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;

  const added = [];
  for (const file of files) {
    const item = newItem({
      id: uid('local'),
      title: file.name.replace(/\.[^/.]+$/, ''),
      tags: ['local'],
      local: true,
    });
    try {
      await blobStore.put(item.id, file);      // survives reload, unlike a blob URL
      appState.items.push(item);
      added.push(item);
    } catch (err) {
      console.error('Could not store file', err);
      toast(`Could not save ${file.name} to this device.`, 'error');
    }
  }

  event.target.value = '';                      // allow re-picking the same file
  if (!added.length) return;
  saveState();
  Cloud.upsertItems(added);
  renderLibrary();
  toast(`Added ${added.length} file${added.length === 1 ? '' : 's'}.`, 'success');

  uploadPending(added);
}

/**
 * Push uploaded audio to Supabase Storage so it reaches other devices.
 *
 * The local IndexedDB copy is kept either way: it plays offline and avoids a
 * signed-URL round-trip. Failure here is not something the user needs to act
 * on, so it downgrades quietly to device-only.
 */
async function uploadPending(items) {
  if (!Cloud.isSignedIn()) {
    if (items.some((i) => i.local)) {
      toast('Saved on this device. Sign in to sync these to your account.');
    }
    return;
  }

  const uploadable = [];
  for (const item of items) {
    const file = await blobStore.get(item.id).catch(() => null);
    if (!file) continue;
    if (!Cloud.canUpload(file)) {
      toast(`${item.title} is too large to sync; it stays on this device.`);
      continue;
    }
    uploadable.push([item, file]);
  }
  if (!uploadable.length) return;

  let done = 0;
  for (const [item, file] of uploadable) {
    try {
      item.storagePath = await Cloud.uploadAudio(item.id, file);
      item.local = true;               // still cached here as well
      Cloud.upsertItem(item);
      done += 1;
      toast(`Uploading ${done} of ${uploadable.length}…`);
    } catch (err) {
      console.error('Upload failed', err);
      toast(`${item.title} could not be uploaded; it stays on this device.`, 'error');
    }
  }

  if (done) {
    saveState();
    renderLibrary();
    toast(`Synced ${done} file${done === 1 ? '' : 's'} to your account.`, 'success');
  }
}

function addAudioFromUrl() {
  const title = document.getElementById('direct-title-input').value.trim();
  const url = document.getElementById('direct-url-input').value.trim();
  const cover = document.getElementById('direct-cover-input').value.trim();
  const folder = dom['direct-folder-select'].value;

  if (!url) { toast('Paste a direct audio link.', 'error'); return; }
  if (!/^https?:\/\//i.test(url)) { toast('Audio links must start with http:// or https://', 'error'); return; }

  const item = newItem({ id: uid('url'), title: title || 'Linked audio', url, cover, folder, tags: ['stream'] });
  appState.items.push(item);
  saveState();
  Cloud.upsertItem(item);
  renderLibrary();
  closeModals();
  ['direct-title-input', 'direct-url-input', 'direct-cover-input'].forEach((id) => {
    document.getElementById(id).value = '';
  });
  toast('Added to your library.', 'success');
}

async function ingestRssFeed() {
  const feedUrl = document.getElementById('rss-url-input').value.trim();
  if (!feedUrl) { toast('Paste an RSS feed URL.', 'error'); return; }

  const button = document.querySelector('[data-action="ingest-rss"]');
  const original = button ? button.textContent : '';
  if (button) { button.disabled = true; button.textContent = 'Importing…'; }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch(
      `https://api.allorigins.win/get?url=${encodeURIComponent(feedUrl)}`,
      { signal: controller.signal },
    );
    if (!res.ok) throw new Error(`Proxy returned ${res.status}`);
    const data = await res.json();
    if (!data || !data.contents) throw new Error('Empty feed response');

    const xml = new DOMParser().parseFromString(data.contents, 'text/xml');
    if (xml.querySelector('parsererror')) throw new Error('Malformed XML');

    const channelTitle = xml.querySelector('channel > title')?.textContent?.trim() || 'Podcast feed';
    const channelImage =
      xml.querySelector('channel > image > url')?.textContent?.trim() ||
      xml.querySelector('channel > *|image')?.getAttribute('href') || '';

    if (!appState.folders.includes(channelTitle)) appState.folders.push(channelTitle);

    // Re-importing a feed used to duplicate every episode.
    const existingUrls = new Set(appState.items.map((i) => i.url).filter(Boolean));
    const added = [];

    Array.from(xml.querySelectorAll('item')).slice(0, RSS_EPISODE_LIMIT).forEach((node) => {
      const enclosure = node.querySelector('enclosure');
      const audioUrl = enclosure ? enclosure.getAttribute('url') : '';
      if (!audioUrl || existingUrls.has(audioUrl)) return;
      existingUrls.add(audioUrl);

      const episodeImage = node.querySelector('*|image')?.getAttribute('href') || channelImage;
      const item = newItem({
        id: uid('rss'),
        title: node.querySelector('title')?.textContent?.trim() || 'Episode',
        url: audioUrl,
        folder: channelTitle,
        cover: episodeImage,
        tags: ['podcast'],
      });
      appState.items.push(item);
      added.push(item);
    });

    saveState();
    Cloud.upsertItems(added);    // one batched request, not one per episode
    renderLibrary();
    updateFolderDropdowns();
    closeModals();
    document.getElementById('rss-url-input').value = '';
    toast(added.length
      ? `Imported ${added.length} episode${added.length === 1 ? '' : 's'} from ${channelTitle}.`
      : 'No new episodes found in that feed.', added.length ? 'success' : 'info');
  } catch (err) {
    console.error(err);
    toast(err.name === 'AbortError'
      ? 'The feed took too long to respond.'
      : 'That feed could not be read. Check the URL and try again.', 'error');
  } finally {
    clearTimeout(timeout);
    if (button) { button.disabled = false; button.textContent = original; }
  }
}

function createFolder() {
  const input = document.getElementById('folder-name-input');
  const name = input.value.trim();
  if (!name) { toast('Give the folder a name.', 'error'); return; }
  if (appState.folders.includes(name)) { toast('That folder already exists.', 'error'); return; }
  appState.folders.push(name);
  Cloud.upsertFolder(name);
  saveState();
  renderLibrary();
  updateFolderDropdowns();
  closeModals();
  input.value = '';
  toast(`Created ${name}.`, 'success');
}

function deleteFolder(name) {
  if (!confirm(`Delete the folder "${name}"? Its items move to Ungrouped.`)) return;
  appState.folders = appState.folders.filter((f) => f !== name);
  Cloud.deleteFolder(name);
  appState.items.forEach((i) => { if (i.folder === name) { i.folder = ''; Cloud.upsertItem(i); } });
  runtime.collapsedFolders.delete(name);
  saveState();
  renderLibrary();
  updateFolderDropdowns();
  toast(`Deleted ${name}.`);
}

async function deleteItem(id) {
  const item = findItem(id);
  if (!item) return;
  if (!confirm(`Remove "${item.title}" from your library?`)) return;

  if (item.local) { try { await blobStore.remove(id); } catch { /* already gone */ } }
  if (appState.currentId === id) {
    audioEl.pause();
    audioEl.removeAttribute('src');
    audioEl.load();
    releaseObjectUrl();
    appState.currentId = null;
    appState.isPlaying = false;
    resetPlayerUI();
  }
  appState.items = appState.items.filter((i) => i.id !== id);
  saveState();
  Cloud.deleteItem(id);
  if (item.storagePath) Cloud.removeAudio(item.storagePath);
  renderLibrary();
  closeModals();
  toast('Removed from your library.');
}

function resetPlayerUI() {
  dom['mini-title'].textContent = 'No audio loaded';
  dom['mini-subtitle'].textContent = 'Tap to choose something to play';
  dom['modal-title'].textContent = 'Select an audio file';
  dom['modal-subtitle'].textContent = 'Ready to listen';
  dom['mini-progress'].style.width = '0%';
  setCover(dom['mini-cover'], '', 'fa-headphones');
  setCover(dom['modal-cover-container'], '', 'fa-headphones');
  updatePlayPauseUI();
  updateBookmarkBadge();
}

function saveItemEdits() {
  const id = document.getElementById('edit-item-id').value;
  const item = findItem(id);
  if (!item) return;
  item.title = document.getElementById('edit-title-input').value.trim() || item.title;
  item.cover = document.getElementById('edit-cover-input').value.trim();
  item.folder = dom['edit-folder-select'].value;
  const raw = document.getElementById('edit-tags-input').value;
  item.tags = raw ? raw.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean) : [];
  saveState();
  Cloud.upsertItem(item);
  renderLibrary();
  if (appState.currentId === item.id) updatePlayerUI();
  closeModals();
  toast('Changes saved.', 'success');
}

/* ------------------------------------------------------------------ *
 * 12. Goodreads
 * ------------------------------------------------------------------ */

function saveGoodreadsAccount() {
  const val = document.getElementById('goodreads-user-id').value.trim();
  if (!val) { toast('Enter your Goodreads profile ID.', 'error'); return; }
  appState.goodreadsUser = val;
  saveState();
  updateGoodreadsUI();
  closeGoodreadsModal();
  toast('Goodreads linked.', 'success');
}

function disconnectGoodreads() {
  appState.goodreadsUser = null;
  saveState();
  updateGoodreadsUI();
  closeGoodreadsModal();
  toast('Goodreads disconnected.');
}

function updateGoodreadsUI() {
  const linked = !!appState.goodreadsUser;
  dom['goodreads-unlogged'].classList.toggle('hidden', linked);
  dom['goodreads-logged'].classList.toggle('hidden', !linked);
  if (linked) dom['goodreads-account-display'].textContent = `Linked ID: ${appState.goodreadsUser}`;
}

/**
 * Parse one CSV row respecting quoted fields.
 * Goodreads titles routinely contain commas ("Book, The: A Novel"), which the
 * original line.split(',') mangled into garbage entries.
 */
function parseCsvRow(row) {
  const out = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i];
    if (inQuotes) {
      if (ch === '"') {
        if (row[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

function importGoodreadsCSV(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const reader = new FileReader();

  reader.onerror = () => toast('Could not read that file.', 'error');
  reader.onload = (e) => {
    const rows = String(e.target.result).split(/\r?\n/).filter((r) => r.trim());
    if (rows.length < 2) { toast('That CSV has no rows to import.', 'error'); return; }

    const header = parseCsvRow(rows[0]).map((h) => h.toLowerCase());
    const titleIdx = header.indexOf('title') > -1 ? header.indexOf('title') : 1;
    const authorIdx = header.indexOf('author');

    const FOLDER = 'Goodreads Books';
    if (!appState.folders.includes(FOLDER)) appState.folders.push(FOLDER);

    const existing = new Set(
      appState.items.filter((i) => i.folder === FOLDER).map((i) => i.title.toLowerCase()),
    );
    const added = [];

    rows.slice(1).forEach((row) => {
      const cols = parseCsvRow(row);
      const title = cols[titleIdx];
      if (!title || existing.has(title.toLowerCase())) return;
      existing.add(title.toLowerCase());
      const author = authorIdx > -1 ? cols[authorIdx] : '';
      const item = newItem({
        id: uid('gr'),
        title: author ? `${title} — ${author}` : title,
        folder: FOLDER,
        tags: ['goodreads', 'reading-goal'],
      });
      appState.items.push(item);
      added.push(item);
    });

    event.target.value = '';
    saveState();
    Cloud.upsertItems(added);
    renderLibrary();
    updateFolderDropdowns();
    closeGoodreadsModal();
    toast(added.length ? `Imported ${added.length} books.` : 'No new books found.', added.length ? 'success' : 'info');
  };
  reader.readAsText(file);
}

/* ------------------------------------------------------------------ *
 * 13. Sleep timer
 * ------------------------------------------------------------------ */

function setSleepTimer(minutes) {
  cancelSleepTimer(true);
  runtime.sleepTimerEndsAt = Date.now() + minutes * 60000;
  runtime.sleepTimerTimeout = setTimeout(() => {
    audioEl.pause();
    appState.isPlaying = false;
    updatePlayPauseUI();
    saveState();
    cancelSleepTimer(true);
    toast('Sleep timer finished. Good night.');
  }, minutes * 60000);

  // Show a live countdown — the label never updated in the original.
  runtime.sleepTimerInterval = setInterval(updateSleepTimerLabel, 1000);
  updateSleepTimerLabel();
  closeModals();
  toast(`Sleeping in ${minutes} minutes.`, 'success');
}

function updateSleepTimerLabel() {
  if (!runtime.sleepTimerEndsAt) { dom['sleep-timer-label'].textContent = 'Sleep timer'; return; }
  const left = Math.max(0, Math.round((runtime.sleepTimerEndsAt - Date.now()) / 1000));
  dom['sleep-timer-label'].textContent = formatTime(left);
}

function cancelSleepTimer(silent = false) {
  clearTimeout(runtime.sleepTimerTimeout);
  clearInterval(runtime.sleepTimerInterval);
  runtime.sleepTimerTimeout = null;
  runtime.sleepTimerInterval = null;
  runtime.sleepTimerEndsAt = null;
  dom['sleep-timer-label'].textContent = 'Sleep timer';
  if (!silent) { closeModals(); toast('Sleep timer cancelled.'); }
}

/* ------------------------------------------------------------------ *
 * 14. Search & tags
 * ------------------------------------------------------------------ */

function buildTagCloud() {
  const cloud = dom['tag-cloud'];
  const counts = new Map();
  appState.items.forEach((i) => {
    (i.tags || []).forEach((t) => counts.set(t, (counts.get(t) || 0) + 1));
  });
  if (counts.size === 0) {
    cloud.innerHTML = '<span class="hint">No tags yet. Add them from any item\u2019s edit screen.</span>';
    return;
  }
  cloud.innerHTML = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([tag, n]) => `<button class="tag tag--button" type="button" data-action="filter-tag" data-tag="${esc(tag)}">#${esc(tag)} <span>${n}</span></button>`)
    .join('');
}

function handleSearch(query) {
  clearTimeout(runtime.searchDebounce);
  runtime.searchDebounce = setTimeout(() => runSearch(query), 150);
}

function runSearch(query) {
  const results = dom['search-results'];
  const q = query.trim().toLowerCase();
  if (!q) { results.innerHTML = ''; return; }

  const bare = q.startsWith('#') ? q.slice(1) : q;
  const matches = appState.items.filter((i) => {
    if (q.startsWith('#')) return (i.tags || []).some((t) => t.toLowerCase().includes(bare));
    return i.title.toLowerCase().includes(q)
      || (i.folder && i.folder.toLowerCase().includes(q))
      || (i.tags || []).some((t) => t.toLowerCase().includes(q));
  });

  results.innerHTML = matches.length === 0
    ? '<p class="item-list__empty">No matches</p>'
    : matches.map((m) => `
      <button class="result" type="button" data-action="play-and-close" data-id="${esc(m.id)}">
        <span class="result__title">${esc(m.title)}</span>
        <span class="result__folder">${esc(m.folder || 'Ungrouped')}</span>
      </button>`).join('');
}

function filterByTag(tag) {
  dom['search-input'].value = `#${tag}`;
  runSearch(`#${tag}`);
}

/* ------------------------------------------------------------------ *
 * 15. Backup
 * ------------------------------------------------------------------ */

function exportLibrary() {
  // Export only real data — the original serialised the whole appState,
  // including a live setTimeout handle and playback flags.
  const payload = {
    schema: 'indybooks.backup',
    version: 2,
    exportedAt: new Date().toISOString(),
    folders: appState.folders,
    goodreadsUser: appState.goodreadsUser,
    items: appState.items.map((i) => ({ ...i, url: i.local ? '' : i.url })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `indybooks-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('Backup downloaded.', 'success');
}

function importLibrary(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(String(e.target.result));
      if (!Array.isArray(data.items)) throw new Error('Not an IndyBooks backup');
      const byId = new Map(appState.items.map((i) => [i.id, i]));
      data.items.forEach((i) => byId.set(i.id, i));
      appState.items = Array.from(byId.values());
      (data.folders || []).forEach((f) => { if (!appState.folders.includes(f)) appState.folders.push(f); });
      saveState();
      renderLibrary();
      updateFolderDropdowns();
      closeModals();
      toast(`Restored ${data.items.length} items.`, 'success');
    } catch (err) {
      console.error(err);
      toast('That file is not an IndyBooks backup.', 'error');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

/* ------------------------------------------------------------------ *
 * 16. Modals
 * ------------------------------------------------------------------ */

function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('is-open');
  el.setAttribute('aria-hidden', 'false');
  const focusable = el.querySelector('input, select, button');
  if (focusable) setTimeout(() => focusable.focus(), 50);
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('is-open');
  el.setAttribute('aria-hidden', 'true');
}

/**
 * Close every dialog. The player sheet is deliberately excluded: it is a
 * slide-up sheet, not a dialog. In the original, closeModals() matched it by
 * its `-modal` id suffix and added `hidden` to it, after which
 * openPlayerModal() — which only toggles the transform — could never show it
 * again. Opening any dialog permanently broke the full-screen player.
 */
function closeModals() {
  document.querySelectorAll('.modal').forEach((m) => {
    m.classList.remove('is-open');
    m.setAttribute('aria-hidden', 'true');
  });
}

function openPlayerModal() {
  const el = dom['player-modal'];
  el.classList.add('is-open');
  el.setAttribute('aria-hidden', 'false');
}

function closePlayerModal() {
  dom['player-modal'].classList.remove('is-open');
  dom['player-modal'].setAttribute('aria-hidden', 'true');
}

function openGoodreadsModal() {
  closeModals();
  openModal('goodreads-modal');
}
function closeGoodreadsModal() { closeModal('goodreads-modal'); }

function openEditModal(id) {
  const item = findItem(id);
  if (!item) return;
  updateFolderDropdowns();
  document.getElementById('edit-item-id').value = item.id;
  document.getElementById('edit-title-input').value = item.title;
  document.getElementById('edit-cover-input').value = item.cover || '';
  dom['edit-folder-select'].value = item.folder || '';
  document.getElementById('edit-tags-input').value = (item.tags || []).join(', ');
  document.querySelector('[data-action="delete-item"]').dataset.id = item.id;
  openModal('edit-item-modal');
}

/* ------------------------------------------------------------------ *
 * 17. Event wiring
 *
 * A single delegated listener replaces ~40 inline onclick attributes. Inline
 * handlers that interpolate item titles/ids into HTML are also an injection
 * vector — a podcast title containing a quote character used to break the
 * markup outright.
 * ------------------------------------------------------------------ */

const actions = {
  'open-search': () => { buildTagCloud(); openModal('search-modal'); },
  'open-auth': () => openModal('auth-modal'),
  'open-settings': () => openModal('settings-modal'),
  'open-add-feed': () => openModal('add-feed-modal'),
  'open-add-url': () => { updateFolderDropdowns(); openModal('add-url-modal'); },
  'open-create-folder': () => openModal('create-folder-modal'),
  'open-sleep-timer': () => openModal('sleep-timer-modal'),
  'open-bookmarks': () => { renderBookmarksList(); openModal('bookmarks-modal'); },
  'open-goodreads': openGoodreadsModal,
  'close-goodreads': closeGoodreadsModal,
  'open-player': openPlayerModal,
  'close-player': closePlayerModal,
  'close-modals': closeModals,

  'play': (el) => playItem(el.dataset.id),
  'play-and-close': (el) => { playItem(el.dataset.id); closeModals(); openPlayerModal(); },
  'edit': (el) => openEditModal(el.dataset.id),
  'delete-item': (el) => deleteItem(el.dataset.id),
  'delete-folder': (el) => deleteFolder(el.dataset.folder),
  'toggle-folder': (el) => {
    const f = el.dataset.folder;
    if (runtime.collapsedFolders.has(f)) runtime.collapsedFolders.delete(f);
    else runtime.collapsedFolders.add(f);
    renderLibrary();
  },
  'toggle-play': togglePlayPause,
  'toggle-sloth': toggleSlothMode,
  'skip-back': () => skipTime(-15),
  'skip-forward': () => skipTime(30),
  'speed-down': () => adjustSpeed(-0.1),
  'speed-up': () => adjustSpeed(0.1),
  'wildcard': playWildcard,
  'add-bookmark': addBookmark,
  'delete-bookmark': (el) => deleteBookmark(el.dataset.id),
  'jump': (el) => { audioEl.currentTime = parseFloat(el.dataset.time); closeModals(); },
  'filter-tag': (el) => filterByTag(el.dataset.tag),

  'sign-in': signIn,
  'sign-up': signUp,
  'sign-out': signOut,
  'sync-now': () => pullFromCloud({}),
  'save-goodreads': saveGoodreadsAccount,
  'disconnect-goodreads': disconnectGoodreads,
  'ingest-rss': ingestRssFeed,
  'add-url': addAudioFromUrl,
  'create-folder': createFolder,
  'save-edits': saveItemEdits,
  'export': exportLibrary,
  'apply-update': applyUpdate,
  'dismiss-update': dismissUpdate,
  'sleep-10': () => setSleepTimer(10),
  'sleep-15': () => setSleepTimer(15),
  'sleep-30': () => setSleepTimer(30),
  'sleep-60': () => setSleepTimer(60),
  'cancel-sleep': () => cancelSleepTimer(false),
};

function playWildcard() {
  const playable = appState.items.filter((i) => i.url || i.local);
  if (playable.length === 0) {
    toast('Nothing playable in your library yet.', 'error');
    return;
  }
  const pick = playable[Math.floor(Math.random() * playable.length)];
  playItem(pick.id);
  openPlayerModal();
}

function bindEvents() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const fn = actions[el.dataset.action];
    if (fn) { e.preventDefault(); fn(el, e); }
  });

  // Keyboard parity for the non-button elements used inside folder headers.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest('[role="button"][data-action]');
    if (!el) return;
    e.preventDefault();
    const fn = actions[el.dataset.action];
    if (fn) fn(el, e);
  });

  // Click a dialog's backdrop to dismiss it.
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('mousedown', (e) => { if (e.target === m) closeModal(m.id); });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = document.querySelector('.modal.is-open');
    if (open) { closeModal(open.id); return; }
    if (dom['player-modal'].classList.contains('is-open')) closePlayerModal();
  });

  document.getElementById('local-audio-input').addEventListener('change', handleLocalFiles);
  document.getElementById('goodreads-csv-file').addEventListener('change', importGoodreadsCSV);
  document.getElementById('import-backup-file').addEventListener('change', importLibrary);
  dom['search-input'].addEventListener('input', (e) => handleSearch(e.target.value));
  dom['app-volume-slider'].addEventListener('input', (e) => adjustAppVolume(e.target.value));

  // Seek slider: track drag state so timeupdate stops overwriting the thumb.
  const slider = dom['modal-seek-slider'];
  ['mousedown', 'touchstart', 'keydown'].forEach((evt) => {
    slider.addEventListener(evt, () => { runtime.isSeeking = true; }, { passive: true });
  });
  slider.addEventListener('input', () => {
    runtime.isSeeking = true;
    dom['current-time-label'].textContent = formatTime(parseFloat(slider.value));
  });
  slider.addEventListener('change', () => {
    audioEl.currentTime = parseFloat(slider.value);
    runtime.isSeeking = false;
  });
  ['mouseup', 'touchend'].forEach((evt) => {
    slider.addEventListener(evt, () => { runtime.isSeeking = false; }, { passive: true });
  });

  document.getElementById('mini-progress-track').addEventListener('click', seekAudioBar);

  audioEl.addEventListener('timeupdate', onAudioTimeUpdate);
  audioEl.addEventListener('loadedmetadata', onAudioMetadataLoaded);
  audioEl.addEventListener('ended', onAudioEnded);
  audioEl.addEventListener('error', onAudioError);
  audioEl.addEventListener('play', () => { appState.isPlaying = true; updatePlayPauseUI(); });
  audioEl.addEventListener('pause', () => { appState.isPlaying = false; updatePlayPauseUI(); });

  // Flush progress when the app is backgrounded or closed — mobile browsers
  // frequently kill the tab without firing anything else.
  const flush = () => { saveState(); Cloud.flush(); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', releaseObjectUrl);
}

/* ------------------------------------------------------------------ *
 * 18. Init
 * ------------------------------------------------------------------ */

function init() {
  cacheDom();
  audioEl = dom['main-audio-element'];
  loadState();

  audioEl.volume = appState.volume;
  audioEl.playbackRate = appState.slothMode ? SLOTH_RATE : appState.lastSpeed;
  audioEl.preload = 'metadata';

  renderLibrary();
  updateFolderDropdowns();
  updateGoodreadsUI();
  updateAuthUI(false);
  resetPlayerUI();
  updateSpeedUI();
  dom['app-volume-slider'].value = appState.volume;
  dom['volume-label'].textContent = `${Math.round(appState.volume * 100)}%`;
  dom['sloth-mode-btn'].classList.toggle('is-active', appState.slothMode);

  bindEvents();
  registerMediaSessionHandlers();
  initCloud();
  registerServiceWorker();
  watchConnection();
  handleLaunchShortcut();
}

/* ------------------------------------------------------------------ *
 * 19. Service worker
 * ------------------------------------------------------------------ */

let waitingWorker = null;

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Service workers require a secure context; opening index.html straight off
  // disk silently fails registration, so don't bother trying.
  if (location.protocol === 'file:') {
    console.info('Service worker skipped: serve over http(s) to enable offline use.');
    return;
  }

  navigator.serviceWorker.register('sw.js').then((reg) => {
    // A worker may already be waiting from a previous visit.
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg.waiting);

    reg.addEventListener('updatefound', () => {
      const incoming = reg.installing;
      if (!incoming) return;
      incoming.addEventListener('statechange', () => {
        // `controller` is null on the very first install — that's a fresh
        // cache, not an update, and shouldn't nag the user to reload.
        if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdateBanner(incoming);
        }
      });
    });

    // Pick up deploys made while the tab sat open.
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch((err) => {
    console.warn('Service worker registration failed', err);
  });

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

function showUpdateBanner(worker) {
  waitingWorker = worker;
  const banner = document.getElementById('update-banner');
  if (banner) banner.classList.add('is-visible');
}

function applyUpdate() {
  const banner = document.getElementById('update-banner');
  if (banner) banner.classList.remove('is-visible');
  if (!waitingWorker) { location.reload(); return; }
  // Flush progress before the reload triggered by controllerchange.
  saveState();
  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
}

function dismissUpdate() {
  const banner = document.getElementById('update-banner');
  if (banner) banner.classList.remove('is-visible');
}

function watchConnection() {
  const paint = () => {
    document.body.classList.toggle('is-offline', !navigator.onLine);
  };
  window.addEventListener('online', () => { paint(); toast('Back online.', 'success'); });
  window.addEventListener('offline', () => {
    paint();
    toast('Offline. Downloaded files still play.');
  });
  paint();
}

/** Support the app shortcuts declared in manifest.json. */
function handleLaunchShortcut() {
  const action = new URLSearchParams(location.search).get('action');
  if (action === 'wildcard') playWildcard();
  else if (action === 'add-feed') openModal('add-feed-modal');
  if (action) history.replaceState(null, '', location.pathname);
}

// The original used window.onload, which waits on every image and stylesheet.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

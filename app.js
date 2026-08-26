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

let supabaseClient = null;
let currentUser = null;

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
    'auth-unlogged-view', 'auth-logged-view', 'auth-user-email',
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
 * 6. Supabase cloud sync
 * ------------------------------------------------------------------ */

function initSupabaseFromStorage() {
  const url = localStorage.getItem(LS.supabaseUrl);
  const key = localStorage.getItem(LS.supabaseKey);
  if (url && key && window.supabase) {
    try {
      supabaseClient = window.supabase.createClient(url, key);
      checkSupabaseSession();
    } catch (err) {
      console.error('Supabase init failed', err);
      toast('Saved Supabase settings are invalid. Re-enter them in Cloud Sync.', 'error');
    }
  }
}

function saveSupabaseConfig() {
  const url = document.getElementById('supabase-url-input').value.trim();
  const key = document.getElementById('supabase-key-input').value.trim();
  if (!url || !key) { toast('Enter both a project URL and an anon key.', 'error'); return; }
  if (!/^https:\/\/.+/i.test(url)) { toast('Project URL must start with https://', 'error'); return; }
  if (!window.supabase) { toast('Supabase library did not load. Check your connection.', 'error'); return; }
  try {
    supabaseClient = window.supabase.createClient(url, key);
    localStorage.setItem(LS.supabaseUrl, url);
    localStorage.setItem(LS.supabaseKey, key);
    toast('Supabase connected. Sign in to sync.', 'success');
  } catch (err) {
    console.error(err);
    toast('Could not connect with those credentials.', 'error');
  }
}

async function checkSupabaseSession() {
  if (!supabaseClient) return;
  try {
    const { data } = await supabaseClient.auth.getSession();
    if (data && data.session) {
      currentUser = data.session.user;
      updateAuthUI(true);
      fetchUserLibrary(currentUser.id);
    }
  } catch (err) {
    console.error('Session check failed', err);
  }
}

async function supabaseSignUp() {
  if (!supabaseClient) { toast('Connect a Supabase project first.', 'error'); return; }
  const email = document.getElementById('auth-email-input').value.trim();
  const password = document.getElementById('auth-pass-input').value;
  if (!email || !password) { toast('Enter an email and password.', 'error'); return; }
  const { error } = await supabaseClient.auth.signUp({ email, password });
  if (error) toast(error.message, 'error');
  else toast('Check your email for the confirmation link.', 'success');
}

async function supabaseSignIn() {
  if (!supabaseClient) { toast('Connect a Supabase project first.', 'error'); return; }
  const email = document.getElementById('auth-email-input').value.trim();
  const password = document.getElementById('auth-pass-input').value;
  if (!email || !password) { toast('Enter an email and password.', 'error'); return; }
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) { toast(error.message, 'error'); return; }
  currentUser = data.user;
  updateAuthUI(true);
  await fetchUserLibrary(currentUser.id);
  closeModals();
  toast('Signed in and syncing.', 'success');
}

async function supabaseSignOut() {
  if (supabaseClient) await supabaseClient.auth.signOut();
  currentUser = null;
  updateAuthUI(false);
  closeModals();
  toast('Signed out. Your library stays on this device.');
}

function updateAuthUI(isLoggedIn) {
  const badge = dom['sync-status-badge'];
  const sub = dom['user-status-subtitle'];
  if (isLoggedIn && currentUser) {
    dom['auth-unlogged-view'].classList.add('hidden');
    dom['auth-logged-view'].classList.remove('hidden');
    dom['auth-user-email'].textContent = currentUser.email || '';
    badge.textContent = 'Synced';
    badge.classList.add('badge--synced');
    sub.textContent = `Cloud account: ${currentUser.email || 'signed in'}`;
  } else {
    dom['auth-unlogged-view'].classList.remove('hidden');
    dom['auth-logged-view'].classList.add('hidden');
    badge.textContent = 'Local';
    badge.classList.remove('badge--synced');
    sub.textContent = 'Podcast & Audiobook Hub';
  }
}

/**
 * Merge cloud records into the local library rather than replacing it.
 * The original implementation overwrote appState.items outright, silently
 * destroying any item that had not yet reached the server.
 */
async function fetchUserLibrary(userId) {
  if (!supabaseClient || !userId) return;
  const { data, error } = await supabaseClient
    .from('media_items')
    .select('*, bookmarks(*)')
    .eq('user_id', userId);

  if (error) { toast('Could not load your cloud library.', 'error'); return; }
  if (!data) return;

  const localById = new Map(appState.items.map((i) => [i.id, i]));

  data.forEach((row) => {
    const local = localById.get(row.id);
    const merged = {
      id: row.id,
      title: row.title,
      url: row.audio_url || '',
      folder: row.folder || '',
      cover: row.cover_url || '',
      tags: Array.isArray(row.tags) ? row.tags : [],
      // Whichever side has heard more of the file wins.
      currentTime: Math.max(row.current_time || 0, local ? local.currentTime : 0),
      duration: row.duration || (local ? local.duration : 0) || 0,
      speed: row.speed || 1.0,
      bookmarks: Array.isArray(row.bookmarks)
        ? row.bookmarks.map((b) => ({ id: b.id, time: b.time, title: b.formatted_time || `Bookmark at ${formatTime(b.time)}` }))
        : (local ? local.bookmarks : []),
      local: local ? !!local.local : false,
    };
    localById.set(row.id, merged);
  });

  appState.items = Array.from(localById.values());
  appState.items.forEach((i) => {
    if (i.folder && !appState.folders.includes(i.folder)) appState.folders.push(i.folder);
  });

  saveState();
  renderLibrary();
  updateFolderDropdowns();
}

function toCloudRow(item) {
  return {
    id: item.id,
    user_id: currentUser.id,
    title: item.title,
    type: 'audiobook',
    audio_url: item.local ? '' : item.url,
    cover_url: item.cover,
    folder: item.folder,
    tags: item.tags || [],
    current_time: item.currentTime,
    duration: item.duration,
    speed: item.speed,
  };
}

async function saveStateToCloud(item) {
  if (!supabaseClient || !currentUser || !item) return;
  try {
    await supabaseClient.from('media_items').upsert(toCloudRow(item));
  } catch (err) {
    console.error('Cloud upsert failed', err);
  }
}

/** Batched variant — one request instead of one per imported episode. */
async function saveManyToCloud(items) {
  if (!supabaseClient || !currentUser || !items.length) return;
  try {
    await supabaseClient.from('media_items').upsert(items.map(toCloudRow));
  } catch (err) {
    console.error('Cloud batch upsert failed', err);
  }
}

async function syncPlaybackProgress(force = false) {
  if (!supabaseClient || !currentUser) return;
  if (!force && Date.now() - runtime.lastCloudSync < CLOUD_SYNC_INTERVAL_MS) return;
  const item = currentItem();
  if (!item) return;
  runtime.lastCloudSync = Date.now();
  try {
    await supabaseClient
      .from('media_items')
      .update({ current_time: item.currentTime, duration: item.duration })
      .eq('id', item.id);
  } catch (err) {
    console.error('Progress sync failed', err);
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

async function resolveSource(item) {
  if (item.local) {
    const blob = await blobStore.get(item.id);
    if (!blob) return null;
    releaseObjectUrl();
    runtime.objectUrl = URL.createObjectURL(blob);
    return runtime.objectUrl;
  }
  return item.url || null;
}

async function playItem(id) {
  const item = findItem(id);
  if (!item) return;

  // Flush progress for the outgoing track before switching.
  if (appState.currentId && appState.currentId !== id) {
    saveState();
    syncPlaybackProgress(true);
  }

  const src = await resolveSource(item);
  if (!src) {
    toast(item.local
      ? 'That file is no longer stored on this device. Upload it again.'
      : 'This entry has no audio URL — it is a reading log only.', 'error');
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
    syncPlaybackProgress(true);
  }
}

function onAudioTimeUpdate() {
  const item = currentItem();
  if (!item) return;

  item.currentTime = audioEl.currentTime;
  if (Number.isFinite(audioEl.duration)) item.duration = audioEl.duration;

  updatePlayerProgressUI();
  saveStateThrottled();      // was: full localStorage write ~4x/second
  syncPlaybackProgress();    // was: network request ~4x/second
}

/** Auto-advance. The original referenced onAudioEnded() but never defined it. */
function onAudioEnded() {
  const item = currentItem();
  if (item) { item.currentTime = 0; }
  appState.isPlaying = false;
  saveState();
  syncPlaybackProgress(true);

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
  saveBookmarksToCloud(item);
  updateBookmarkBadge();
  toast(`Bookmarked ${formatTime(stamp)}`, 'success');
}

function deleteBookmark(bookmarkId) {
  const item = currentItem();
  if (!item) return;
  item.bookmarks = (item.bookmarks || []).filter((b) => b.id !== bookmarkId);
  saveState();
  saveBookmarksToCloud(item);
  renderBookmarksList();
  updateBookmarkBadge();
}

/** The original read bookmarks from Supabase but never wrote them back. */
async function saveBookmarksToCloud(item) {
  if (!supabaseClient || !currentUser || !item) return;
  try {
    await supabaseClient.from('bookmarks').delete().eq('media_item_id', item.id);
    if (item.bookmarks.length) {
      await supabaseClient.from('bookmarks').insert(
        item.bookmarks.map((b) => ({
          media_item_id: item.id,
          user_id: currentUser.id,
          time: b.time,
          formatted_time: b.title,
        })),
      );
    }
  } catch (err) {
    console.error('Bookmark sync failed', err);
  }
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
  saveManyToCloud(added);
  renderLibrary();
  toast(`Added ${added.length} file${added.length === 1 ? '' : 's'}.`, 'success');
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
  saveStateToCloud(item);
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
    saveManyToCloud(added);      // one batched request, not one per episode
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
  appState.items.forEach((i) => { if (i.folder === name) i.folder = ''; });
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
  if (supabaseClient && currentUser) {
    try { await supabaseClient.from('media_items').delete().eq('id', id); } catch { /* offline */ }
  }
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
  saveStateToCloud(item);
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
    saveManyToCloud(added);
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

  'save-supabase': saveSupabaseConfig,
  'sign-in': supabaseSignIn,
  'sign-up': supabaseSignUp,
  'sign-out': supabaseSignOut,
  'sync-now': () => { if (currentUser) fetchUserLibrary(currentUser.id); },
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
  const flush = () => { saveState(); syncPlaybackProgress(true); };
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
  initSupabaseFromStorage();
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

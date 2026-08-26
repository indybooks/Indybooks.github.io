/* =========================================================================
   IndyBooks cloud layer

   Wraps Supabase behind a small interface so app.js never touches the client
   directly. Three things this handles that a thin wrapper wouldn't:

   1. An offline outbox. Every write is queued in localStorage and replayed
      when the connection returns, so the app stays usable on a train.
   2. Coalesced progress updates. Playback position changes ~4x/second; only
      the newest value per item is ever sent.
   3. Supabase Storage for uploaded audio, with short-lived signed URLs, so
      "local" files actually reach other devices.

   Everything degrades: with no config, no session, or no network, the app
   runs entirely on localStorage + IndexedDB and syncs later.
   ========================================================================= */

window.Cloud = (function () {
  'use strict';

  const CFG = window.SUPABASE_CONFIG || {};
  const OUTBOX_KEY = 'indybooks_outbox';
  const PROGRESS_FLUSH_MS = 15000;
  const OUTBOX_RETRY_MS = 30000;

  /* Column names live here so a schema rename is a one-line change.
     See schema.sql section 7 regarding POSITION. */
  const COL = {
    POSITION: 'current_time',
    DURATION: 'duration',
    UPDATED: 'updated_at',
  };

  let client = null;
  let user = null;
  let realtimeChannel = null;
  let outbox = [];
  let pendingProgress = new Map();
  let flushTimer = null;
  let retryTimer = null;
  let listeners = { change: [], status: [] };

  /* ---------------------------------------------------------------- *
   * Setup
   * ---------------------------------------------------------------- */

  function isConfigured() {
    return !!(CFG.url && CFG.publishableKey && window.supabase);
  }

  function init() {
    outbox = readOutbox();
    if (!isConfigured()) {
      if (CFG.url && !window.supabase) {
        console.warn('Supabase library failed to load; running in local-only mode.');
      }
      emitStatus();
      return Promise.resolve(null);
    }

    client = window.supabase.createClient(CFG.url, CFG.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      // The default is 10 events/sec, which is plenty for a personal library
      // and keeps us well clear of the quota.
      realtime: { params: { eventsPerSecond: 4 } },
    });

    client.auth.onAuthStateChange((event, session) => {
      const next = session ? session.user : null;
      const changed = (next && next.id) !== (user && user.id);
      user = next;
      if (changed) {
        teardownRealtime();
        if (user) setupRealtime();
      }
      emitStatus();
      emit('change', { reason: event === 'SIGNED_OUT' ? 'signed-out' : 'auth', user });
    });

    flushTimer = setInterval(flushProgress, PROGRESS_FLUSH_MS);
    retryTimer = setInterval(() => { if (navigator.onLine) drainOutbox(); }, OUTBOX_RETRY_MS);
    window.addEventListener('online', () => { drainOutbox(); flushProgress(); });

    return client.auth.getSession()
      .then(({ data }) => {
        user = data && data.session ? data.session.user : null;
        if (user) setupRealtime();
        emitStatus();
        return user;
      })
      .catch((err) => { console.warn('Session lookup failed', err); return null; });
  }

  /* ---------------------------------------------------------------- *
   * Events
   * ---------------------------------------------------------------- */

  function on(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); }
  function emit(type, payload) { (listeners[type] || []).forEach((fn) => { try { fn(payload); } catch (e) { console.error(e); } }); }

  /**
   * 'unconfigured' — no project set, pure local mode
   * 'signed-out'   — configured but nobody signed in
   * 'offline'      — signed in, no connection
   * 'pending'      — signed in, queued writes waiting
   * 'synced'       — everything is up at the server
   */
  function status() {
    if (!isConfigured()) return 'unconfigured';
    if (!user) return 'signed-out';
    if (!navigator.onLine) return 'offline';
    if (outbox.length || pendingProgress.size) return 'pending';
    return 'synced';
  }
  function emitStatus() { emit('status', status()); }

  /* ---------------------------------------------------------------- *
   * Auth
   * ---------------------------------------------------------------- */

  async function signUp(email, password) {
    requireClient();
    const { error } = await client.auth.signUp({ email, password });
    if (error) throw error;
  }

  async function signIn(email, password) {
    requireClient();
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    user = data.user;
    setupRealtime();
    emitStatus();
    return user;
  }

  async function signOut() {
    if (!client) return;
    // Push anything queued before we lose the credentials that authorise it.
    await drainOutbox();
    await flushProgress();
    teardownRealtime();
    await client.auth.signOut();
    user = null;
    emitStatus();
  }

  function requireClient() {
    if (!client) throw new Error('Cloud sync is not configured for this build.');
  }

  function currentUser() { return user; }
  function isSignedIn() { return !!user; }

  /* ---------------------------------------------------------------- *
   * Realtime — keeps a second device in step
   * ---------------------------------------------------------------- */

  function setupRealtime() {
    if (!client || !user || !CFG.realtime || realtimeChannel) return;
    realtimeChannel = client
      .channel(`indybooks:${user.id}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'media_items', filter: `user_id=eq.${user.id}` },
        (payload) => emit('change', { reason: 'realtime', table: 'media_items', payload }))
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'folders', filter: `user_id=eq.${user.id}` },
        (payload) => emit('change', { reason: 'realtime', table: 'folders', payload }))
      .subscribe();
  }

  function teardownRealtime() {
    if (realtimeChannel && client) client.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }

  /* ---------------------------------------------------------------- *
   * Outbox — writes survive a dead connection
   * ---------------------------------------------------------------- */

  function readOutbox() {
    try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); }
    catch { return []; }
  }

  function writeOutbox() {
    try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox)); }
    catch (err) { console.warn('Outbox could not be persisted', err); }
  }

  /**
   * Queue an operation, collapsing anything it supersedes. Editing one item
   * fifty times offline should replay as one write, not fifty.
   */
  function enqueue(op, key, payload) {
    outbox = outbox.filter((e) => !(e.op === op && e.key === key));
    if (op === 'deleteItem') {
      // A delete makes every earlier write for that item irrelevant.
      outbox = outbox.filter((e) => e.key !== key);
    }
    outbox.push({ op, key, payload, queuedAt: Date.now() });
    writeOutbox();
    emitStatus();
    if (navigator.onLine && user) drainOutbox();
  }

  const OPS = {
    upsertItem: (p) => client.from('media_items').upsert(p),
    deleteItem: (p) => client.from('media_items').delete().eq('id', p.id),
    upsertFolder: (p) => client.from('folders').upsert(p, { onConflict: 'user_id,name' }),
    deleteFolder: (p) => client.from('folders').delete().eq('user_id', p.user_id).eq('name', p.name),
    replaceBookmarks: async (p) => {
      await client.from('bookmarks').delete().eq('media_item_id', p.itemId);
      if (!p.rows.length) return { error: null };
      return client.from('bookmarks').insert(p.rows);
    },
  };

  let draining = false;
  async function drainOutbox() {
    if (draining || !client || !user || !outbox.length || !navigator.onLine) return;
    draining = true;
    try {
      while (outbox.length) {
        const entry = outbox[0];
        const run = OPS[entry.op];
        if (!run) { outbox.shift(); continue; }
        const { error } = await run(entry.payload) || {};
        if (error) {
          // A rejected write (bad column, RLS denial) will never succeed on
          // retry, so drop it rather than blocking the queue forever.
          if (isPermanent(error)) {
            console.error('Dropping unsendable write', entry.op, error.message);
            outbox.shift();
            writeOutbox();
            continue;
          }
          break; // transient — leave it queued
        }
        outbox.shift();
        writeOutbox();
      }
    } catch (err) {
      console.warn('Outbox drain interrupted', err);
    } finally {
      draining = false;
      emitStatus();
    }
  }

  function isPermanent(error) {
    const code = String(error.code || '');
    // 42xxx = SQL/schema errors, 23xxx = constraint violations,
    // PGRST = PostgREST request problems, 42501 = RLS denial.
    return code.startsWith('42') || code.startsWith('23') || code.startsWith('PGRST');
  }

  function pendingCount() { return outbox.length + pendingProgress.size; }

  /* ---------------------------------------------------------------- *
   * Reads
   * ---------------------------------------------------------------- */

  async function pullLibrary() {
    if (!client || !user) return null;

    const [itemsRes, foldersRes] = await Promise.all([
      client.from('media_items').select('*, bookmarks(*)').eq('user_id', user.id),
      client.from('folders').select('name').eq('user_id', user.id),
    ]);

    if (itemsRes.error) throw itemsRes.error;

    const items = (itemsRes.data || []).map(fromRow);
    // A missing folders table shouldn't break the whole pull.
    const folders = foldersRes.error ? [] : (foldersRes.data || []).map((f) => f.name);
    if (foldersRes.error) console.warn('Folder table unavailable', foldersRes.error.message);

    return { items, folders };
  }

  function fromRow(row) {
    return {
      id: row.id,
      title: row.title,
      url: row.audio_url || '',
      storagePath: row.storage_path || null,
      folder: row.folder || '',
      cover: row.cover_url || '',
      tags: Array.isArray(row.tags) ? row.tags : [],
      currentTime: row[COL.POSITION] || 0,
      duration: row[COL.DURATION] || 0,
      speed: row.speed || 1.0,
      updatedAt: row[COL.UPDATED] || null,
      bookmarks: Array.isArray(row.bookmarks)
        ? row.bookmarks
            .map((b) => ({ id: b.id, time: b.time, title: b.formatted_time || '' }))
            .sort((a, b) => a.time - b.time)
        : [],
      // Cloud-backed audio is not device-local even if it was uploaded here.
      local: false,
    };
  }

  function toRow(item) {
    const row = {
      id: item.id,
      user_id: user.id,
      title: item.title,
      type: 'audiobook',
      audio_url: item.storagePath ? '' : (item.url || ''),
      storage_path: item.storagePath || null,
      cover_url: item.cover || '',
      folder: item.folder || '',
      tags: item.tags || [],
      speed: item.speed || 1.0,
    };
    row[COL.POSITION] = item.currentTime || 0;
    row[COL.DURATION] = item.duration || 0;
    return row;
  }

  /* ---------------------------------------------------------------- *
   * Writes
   * ---------------------------------------------------------------- */

  function upsertItem(item) {
    if (!user) return;
    enqueue('upsertItem', item.id, toRow(item));
  }

  function upsertItems(items) {
    if (!user || !items.length) return;
    // One request for a bulk import, not one per episode.
    enqueue('upsertItem', `batch:${Date.now()}`, items.map(toRow));
  }

  function deleteItem(id) {
    if (!user) return;
    enqueue('deleteItem', id, { id });
  }

  function upsertFolder(name) {
    if (!user) return;
    enqueue('upsertFolder', name, { user_id: user.id, name });
  }

  function deleteFolder(name) {
    if (!user) return;
    enqueue('deleteFolder', name, { user_id: user.id, name });
  }

  function replaceBookmarks(item) {
    if (!user) return;
    enqueue('replaceBookmarks', item.id, {
      itemId: item.id,
      rows: (item.bookmarks || []).map((b) => ({
        media_item_id: item.id,
        user_id: user.id,
        time: b.time,
        formatted_time: b.title || null,
      })),
    });
  }

  /**
   * Playback position. Called several times a second, so we only keep the
   * latest value per item and send it on a timer.
   */
  function trackProgress(item) {
    if (!user) return;
    pendingProgress.set(item.id, {
      [COL.POSITION]: item.currentTime || 0,
      [COL.DURATION]: item.duration || 0,
    });
  }

  async function flushProgress() {
    if (!client || !user || !pendingProgress.size || !navigator.onLine) return;
    const batch = Array.from(pendingProgress.entries());
    pendingProgress.clear();
    try {
      await Promise.all(batch.map(([id, patch]) =>
        client.from('media_items').update(patch).eq('id', id)));
    } catch (err) {
      // Put it back so the next tick retries.
      batch.forEach(([id, patch]) => { if (!pendingProgress.has(id)) pendingProgress.set(id, patch); });
      console.warn('Progress flush failed', err);
    }
    emitStatus();
  }

  /** Push everything now — used on pause, track end, and page hide. */
  async function flush() {
    await flushProgress();
    await drainOutbox();
  }

  /* ---------------------------------------------------------------- *
   * Storage — uploaded audio
   * ---------------------------------------------------------------- */

  function canUpload(file) {
    return !!(client && user && file.size <= (CFG.maxUploadBytes || Infinity));
  }

  /**
   * Upload to '<user_id>/<item_id>'. The Storage policies in schema.sql key
   * off that first path segment, so the path is what enforces ownership.
   */
  async function uploadAudio(itemId, file, onProgress) {
    requireClient();
    if (!user) throw new Error('Sign in to upload.');
    const path = `${user.id}/${itemId}`;
    if (onProgress) onProgress(0);
    const { error } = await client.storage
      .from(CFG.audioBucket || 'audio')
      .upload(path, file, {
        upsert: true,
        contentType: file.type || 'application/octet-stream',
        cacheControl: '3600',
      });
    if (error) throw error;
    if (onProgress) onProgress(1);
    return path;
  }

  async function removeAudio(storagePath) {
    if (!client || !user || !storagePath) return;
    try { await client.storage.from(CFG.audioBucket || 'audio').remove([storagePath]); }
    catch (err) { console.warn('Storage delete failed', err); }
  }

  // Signed URLs are cached until shortly before they expire, so switching
  // between chapters doesn't re-sign on every play.
  const signedCache = new Map();

  async function signedUrl(storagePath) {
    requireClient();
    const hit = signedCache.get(storagePath);
    if (hit && hit.expires > Date.now() + 60000) return hit.url;

    const ttl = CFG.signedUrlTtlSeconds || 3600;
    const { data, error } = await client.storage
      .from(CFG.audioBucket || 'audio')
      .createSignedUrl(storagePath, ttl);
    if (error) throw error;

    signedCache.set(storagePath, { url: data.signedUrl, expires: Date.now() + ttl * 1000 });
    return data.signedUrl;
  }

  /* ---------------------------------------------------------------- *
   * Feed fetching
   *
   * A browser cannot fetch most podcast feeds directly — they carry no CORS
   * headers. Previously the app called a public third-party proxy, which saw
   * every feed URL any user imported and offered no availability guarantee.
   * This routes through an Edge Function in your own project instead.
   * ---------------------------------------------------------------- */

  async function fetchFeed(url, signal) {
    requireClient();
    if (!user) throw new Error('Sign in to import feeds.');

    const { data, error } = await client.functions.invoke('fetch-feed', {
      body: { url },
      ...(signal ? { signal } : {}),
    });

    if (error) {
      // functions.invoke surfaces the HTTP failure but keeps the JSON body on
      // the response, which is where the useful message lives.
      let detail = error.message || 'Feed fetch failed.';
      try {
        const body = await error.context?.json?.();
        if (body && body.error) detail = body.error;
      } catch { /* no JSON body */ }
      throw new Error(detail);
    }
    if (!data || !data.contents) throw new Error('The feed came back empty.');
    return data;
  }

  function canFetchFeeds() { return !!(client && user); }

  /* ---------------------------------------------------------------- *
   * Public interface
   * ---------------------------------------------------------------- */

  return {
    init, on, status, isConfigured, isSignedIn, currentUser,
    projectRef: () => (CFG.url || '').replace(/^https?:\/\//, '').split('.')[0],
    signIn, signUp, signOut,
    pullLibrary,
    upsertItem, upsertItems, deleteItem,
    upsertFolder, deleteFolder,
    replaceBookmarks,
    trackProgress, flush, pendingCount,
    canUpload, uploadAudio, removeAudio, signedUrl,
    fetchFeed, canFetchFeeds,
    maxUploadBytes: () => CFG.maxUploadBytes || Infinity,
  };
})();

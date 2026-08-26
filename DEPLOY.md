# Deploying IndyBooks without an app store

Everything here is free except a domain name, which is optional.

---

## 1. One-time Supabase setup

**Run the schema.** Paste `schema.sql` into the Supabase SQL editor, or commit it
under `supabase/migrations/` and let the GitHub integration apply it.

Then verify RLS is actually on. The app ships a publishable key, so these
policies are the entire security model:

```sql
select relname, relrowsecurity from pg_class
where relname in ('media_items','bookmarks','folders');
-- all three must show relrowsecurity = true
```

**Deploy the feed fetcher.**

```bash
supabase functions deploy fetch-feed
```

Before deploying, edit `ALLOWED_ORIGINS` at the top of
`supabase/functions/fetch-feed/index.ts` to list the origins you will actually
serve from. That list is what stops other sites from routing their traffic
through your project's compute.

Leave JWT verification on (the default). The function is not an open proxy —
only signed-in users of your project can call it.

---

## 2. Hosting

The app is static files plus Supabase, so any static host works. Both options
below give you HTTPS, which the service worker requires.

### Cloudflare Pages

1. Connect your GitHub repo.
2. Build command: none. Output directory: `/` (or wherever these files sit).
3. Deploy. You get `https://<project>.pages.dev`.

### GitHub Pages

Settings → Pages → deploy from branch. You get
`https://<user>.github.io/<repo>/`.

**A note on paths.** All references in `index.html`, `manifest.json` and
`sw.js` are relative, so a subdirectory deploy works. But if you serve from a
subdirectory, the service worker's scope is limited to that subdirectory —
which is correct behaviour, just be aware the app must always be opened at
that path.

### Pick your origin and keep it

All user data — the library index, downloaded audio, the auth session — is
keyed to the origin. Moving from `pages.dev` to a custom domain later looks
like every user losing their local library. Their cloud data survives and
re-syncs on sign-in, but downloads and any local-only items do not. Decide the
final hostname before you share the link.

---

## 3. Installing

**Android / desktop Chrome or Edge** — an install card appears automatically.
Chromium fires `beforeinstallprompt` and the app captures it.

**iOS** — Safari implements no install prompt, so the app shows guided
instructions instead: Share → Add to Home Screen. Two things to know:

- It has to be **Safari**. In-app browsers (Instagram, Facebook, Slack) hide
  Add to Home Screen; the app detects this and says so.
- Installing to the home screen is what unlocks the better storage behaviour,
  so it's worth pushing users through it rather than letting them bookmark.

Both are re-offerable from Settings → Add to home screen if someone dismisses
the card.

---

## 4. Storage durability

The app calls `navigator.storage.persist()` on every launch, which asks the
browser not to evict its data under storage pressure. Safari requires the
request each launch rather than once, which is why it isn't a one-off.

Settings shows current usage, available quota, and whether protection was
granted.

**This is not a guarantee on any engine.** Reports conflict on whether iOS
home-screen web apps are exempt from Safari's cap on script-writable storage
for unused sites; Apple's documentation is thin. Test it yourself: install the
app, download an audiobook, leave it untouched for two weeks, and see what
survives.

Design around the uncertainty rather than betting on it. With cloud sync on,
an eviction costs downloaded audio and playback position, not the library.

---

## 5. Updating

Push to your repo. The host redeploys, the service worker notices on next
launch, and the user gets a "new version is ready" banner. Nothing swaps
under a running playback session until they tap Reload.

Bump `VERSION` in `sw.js` whenever you change any precached file
(`index.html`, `app.js`, `cloud.js`, `supabase-config.js`, the icons). That
constant is the only thing driving cache eviction — forget it and users keep
the old files.

---

## 6. Optional: a self-hosted Android APK

If you want a real installable file without Google Play:

```bash
npm install -g @bubblewrap/cli
bubblewrap init --manifest https://your-host/manifest.json
bubblewrap build
```

Host `assetlinks.json` at `/.well-known/assetlinks.json` with your signing key
fingerprint, or the app shows a browser URL bar.

Publish the signed APK to GitHub Releases. Users can point **Obtainium** at
the repo to get automatic updates, which is the piece plain APK hosting
otherwise lacks. Play's target-API deadlines don't apply here, since those are
a Play policy rather than an Android requirement.

---

## Checklist

- [ ] `schema.sql` run; all three tables report `relrowsecurity = true`
- [ ] `ALLOWED_ORIGINS` edited in the Edge Function
- [ ] `supabase functions deploy fetch-feed`
- [ ] Static host connected, HTTPS confirmed
- [ ] Final hostname decided before sharing the link
- [ ] Install tested on Android Chrome and iOS Safari
- [ ] RSS import tested end to end while signed in
- [ ] Storage readout shows "protected" after install

/* =========================================================================
   Supabase configuration — the one file to edit per environment.

   The values below are SAFE to commit and to ship in a browser bundle. A
   `sb_publishable_...` key is designed for client-side use: it identifies the
   project and nothing more. It carries no privileges of its own.

   That means Row Level Security is the ONLY thing protecting your data. If
   RLS is off on any table, this key grants the whole internet read and write
   access to it. Run schema.sql before going live.

   NEVER put these in this file (or any client file):
     - the service_role / secret key
     - the direct Postgres connection string
       (postgresql://postgres:...@db.<ref>.supabase.co:5432/postgres)
   Both bypass RLS completely. They belong in server-side or CI secrets only.
   ========================================================================= */

window.SUPABASE_CONFIG = {
  url: 'https://rpgueqafknvrwvrbzixd.supabase.co',
  publishableKey: 'sb_publishable_TsTrCMyNceS2QH3b2MbpEg_A6MRkade',

  // Private Storage bucket that holds uploaded audio.
  audioBucket: 'audio',

  // Signed playback URLs expire; long enough for an audiobook sitting, short
  // enough that a leaked URL stops working.
  signedUrlTtlSeconds: 60 * 60 * 6,

  // Files above this size stay on-device only. Uploading a 900 MB .m4b over a
  // phone connection is rarely what the user wants.
  maxUploadBytes: 200 * 1024 * 1024,

  // Push cross-device updates over Realtime.
  realtime: true,
};

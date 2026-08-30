-- =========================================================================
-- IndyBooks — Supabase schema, RLS, Storage, and Realtime setup
--
-- Run this in the Supabase SQL editor, or commit it to supabase/migrations/
-- so the GitHub integration applies it on deploy.
--
-- READ THIS FIRST -------------------------------------------------------
-- The app ships a publishable key in the browser. That key has no
-- privileges of its own, so the RLS policies below are the entire security
-- model. Every table here has RLS enabled and every policy is scoped to
-- auth.uid(). If you disable RLS on any of these tables, that publishable
-- key becomes public read/write access to all of your users' data.
--
-- Verify with:  select relname, relrowsecurity from pg_class
--               where relname in ('media_items','bookmarks','folders');
-- Both rows must show relrowsecurity = true.
-- -----------------------------------------------------------------------

-- =========================================================================
-- 1. Tables
-- =========================================================================

-- Folders are their own table so an empty folder survives a device wipe.
create table if not exists public.folders (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.media_items (
  -- Client-generated text ids (e.g. 'url_lx8k2p_a91f') let the app create
  -- items offline and reconcile later without a server round-trip.
  id            text primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  title         text not null default 'Untitled',
  type          text not null default 'audiobook',
  audio_url     text default '',
  -- Set when the audio lives in Supabase Storage instead of at a public URL.
  storage_path  text,
  cover_url     text default '',
  folder        text default '',
  tags          text[] not null default '{}',
  -- NOTE: current_time is a reserved SQL keyword, so it must be double-quoted
  -- in every hand-written query. It is kept for compatibility with the
  -- existing table; see the optional rename in section 6.
  "current_time" double precision not null default 0,
  duration      double precision not null default 0,
  speed         double precision not null default 1.0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.bookmarks (
  id              uuid primary key default gen_random_uuid(),
  media_item_id   text not null references public.media_items (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  time            double precision not null,
  formatted_time  text,
  created_at      timestamptz not null default now()
);

-- =========================================================================
-- 2. Indexes
-- =========================================================================

create index if not exists media_items_user_idx    on public.media_items (user_id);
create index if not exists media_items_folder_idx  on public.media_items (user_id, folder);
create index if not exists media_items_updated_idx on public.media_items (user_id, updated_at desc);
create index if not exists bookmarks_item_idx      on public.bookmarks (media_item_id);
create index if not exists bookmarks_user_idx      on public.bookmarks (user_id);
create index if not exists folders_user_idx        on public.folders (user_id);

-- =========================================================================
-- 3. updated_at maintenance
-- =========================================================================

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists media_items_touch on public.media_items;
create trigger media_items_touch
  before update on public.media_items
  for each row execute function public.touch_updated_at();

drop trigger if exists folders_touch on public.folders;
create trigger folders_touch
  before update on public.folders
  for each row execute function public.touch_updated_at();

-- =========================================================================
-- 4. Row Level Security
-- =========================================================================

alter table public.media_items enable row level security;
alter table public.bookmarks   enable row level security;
alter table public.folders     enable row level security;

-- Separate policies per command rather than one FOR ALL, so that INSERT is
-- checked with WITH CHECK and cannot be used to write rows owned by someone
-- else. (A FOR ALL policy with only USING lets inserts through unchecked.)

-- media_items ------------------------------------------------------------
drop policy if exists media_items_select on public.media_items;
create policy media_items_select on public.media_items
  for select using (auth.uid() = user_id);

drop policy if exists media_items_insert on public.media_items;
create policy media_items_insert on public.media_items
  for insert with check (auth.uid() = user_id);

drop policy if exists media_items_update on public.media_items;
create policy media_items_update on public.media_items
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists media_items_delete on public.media_items;
create policy media_items_delete on public.media_items
  for delete using (auth.uid() = user_id);

-- bookmarks --------------------------------------------------------------
drop policy if exists bookmarks_select on public.bookmarks;
create policy bookmarks_select on public.bookmarks
  for select using (auth.uid() = user_id);

drop policy if exists bookmarks_insert on public.bookmarks;
create policy bookmarks_insert on public.bookmarks
  for insert with check (auth.uid() = user_id);

drop policy if exists bookmarks_update on public.bookmarks;
create policy bookmarks_update on public.bookmarks
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists bookmarks_delete on public.bookmarks;
create policy bookmarks_delete on public.bookmarks
  for delete using (auth.uid() = user_id);

-- folders ----------------------------------------------------------------
drop policy if exists folders_select on public.folders;
create policy folders_select on public.folders
  for select using (auth.uid() = user_id);

drop policy if exists folders_insert on public.folders;
create policy folders_insert on public.folders
  for insert with check (auth.uid() = user_id);

drop policy if exists folders_update on public.folders;
create policy folders_update on public.folders
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists folders_delete on public.folders;
create policy folders_delete on public.folders
  for delete using (auth.uid() = user_id);

-- =========================================================================
-- 5. Storage — uploaded audio
--
-- Private bucket. Object keys are '<user_id>/<item_id>', and the policies
-- below compare the first path segment to auth.uid(), so one user can never
-- read or overwrite another's file. Playback uses short-lived signed URLs.
-- =========================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'audio', 'audio', false, 209715200,
  array['audio/mpeg','audio/mp4','audio/aac','audio/m4a','audio/x-m4b','audio/m4b',
        'audio/wav','audio/ogg','audio/opus','audio/flac','audio/webm']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists audio_read on storage.objects;
create policy audio_read on storage.objects
  for select to authenticated
  using (bucket_id = 'audio' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists audio_insert on storage.objects;
create policy audio_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'audio' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists audio_update on storage.objects;
create policy audio_update on storage.objects
  for update to authenticated
  using (bucket_id = 'audio' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists audio_delete on storage.objects;
create policy audio_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'audio' and (storage.foldername(name))[1] = auth.uid()::text);

-- =========================================================================
-- 6. Realtime
--
-- Realtime respects RLS, so each client only receives its own rows.
-- =========================================================================

do $$
begin
  alter publication supabase_realtime add table public.media_items;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.folders;
exception when duplicate_object then null;
end $$;

-- Needed for Realtime UPDATE payloads to carry the old row, which the client
-- uses to detect which fields actually changed.
alter table public.media_items replica identity full;

-- =========================================================================
-- 7. Optional: escape the reserved keyword
--
-- "current_time" works over the REST API but has to be quoted in every piece
-- of hand-written SQL. If you'd rather avoid that, run the rename below and
-- change POSITION in cloud.js from 'current_time' to 'position_seconds'.
-- =========================================================================

-- alter table public.media_items rename column "current_time" to position_seconds;

-- =========================================================================
-- 8. Verification
-- =========================================================================

-- select relname, relrowsecurity from pg_class
--   where relname in ('media_items','bookmarks','folders');
-- select tablename, policyname, cmd from pg_policies
--   where schemaname = 'public' order by tablename, cmd;
-- select id, public from storage.buckets where id = 'audio';

-- bot-link v1 · 0053_room_drafts (lane ROOMTOOL-SERVER; docs/protocol/room-drafts.md). A chat asks for a new room; a
-- signed-in person confirms it on /create/<id> with the chat's code and a passkey. Until then the draft is this one row:
-- no room, no member, no invite, in no list, and nothing is sent to anyone about it.
-- 1. room_drafts, a new table. The reference to accounts takes a brief lock on it while the empty table is made.
-- 2. human_checks gains the action 'confirm_room' (target: the draft), the passkey step of a confirm. MERGE NOTE: keep
--    every action of 0042 and 0040. Additive: the previous binary never writes it. The rewrite checks human_checks'
--    rows under its lock; the sweeper keeps that table to the checks of the last few minutes.
create table room_drafts (
  id            uuid primary key,                -- the client's UUIDv7 (idempotency key, like a join request's)
  status        text not null default 'open' check (status in ('open', 'confirmed', 'rejected', 'closed')),
  room_name     text not null,
  room_purpose  text not null default '',
  -- the asking chat's proposal: exactly the fields of a join request
  member_id     uuid not null,
  name          text not null,
  job           text not null default '',
  app           text not null,
  app_name      text,
  machine       text not null default '',
  folder        text not null default '',
  turn          text not null,
  session_id    text,
  ed25519_pk    bytea not null check (length(ed25519_pk) = 32),
  x25519_pk     bytea not null check (length(x25519_pk) = 32),
  match_code    text not null check (match_code ~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$'),
  request_hash  bytea not null,
  caller_ip     text not null,                    -- the caps' caller key, for the caps only: an IPv4 address, an IPv6 /56
  claimed_by    uuid references accounts (id) on delete cascade,
  wrong_codes   int not null default 0 check (wrong_codes between 0 and 5),
  room_id       uuid,                             -- the room made at confirm
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  decided_at    timestamptz
);
create index room_drafts_open_ip on room_drafts (caller_ip, expires_at) where status = 'open';
create index room_drafts_open_expiry on room_drafts (expires_at) where status = 'open';
create index room_drafts_claimed on room_drafts (claimed_by) where status = 'open';
create unique index room_drafts_open_key on room_drafts (ed25519_pk) where status = 'open'; -- one open draft per key

alter table human_checks drop constraint if exists human_checks_action_check;
alter table human_checks add constraint human_checks_action_check check (action in
  ('approve_join','approve_person','approve_device','webauthn_register','admin','passkey_remove',
   'device_remove','passkey_reset_cancel','passkey_reset_finish','account_delete','confirm_room'));

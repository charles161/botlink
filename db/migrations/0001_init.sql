-- bot-link v1 · 0001_init
-- Postgres 15+ (local PG16 now; Supabase Postgres later). Plain SQL, applied in one transaction by the
-- server's embedded runner (records the version in schema_migrations, which the runner owns).
-- Invariants are enforced HERE (constraints, partial unique indexes, triggers), not only in Go.
-- All times come from Postgres now(); the app clock is never used for TTLs, leases or freshness.

-- ───────────────────────────────────────────────────────────── people

create table accounts (
  id            uuid primary key,
  email         text not null check (email = lower(email) and length(email) between 3 and 254),
  display_name  text not null check (length(display_name) between 1 and 80),
  avatar_url    text check (avatar_url is null or length(avatar_url) <= 500),
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
-- one account per verified email
create unique index accounts_email_uq on accounts (email);

create table identities (                       -- GitHub / Google / dev stub; Supabase later
  provider    text not null check (provider in ('github','google','dev','supabase')),
  subject     text not null check (length(subject) between 1 and 200),
  account_id  uuid not null references accounts (id) on delete cascade,
  email       text not null,
  created_at  timestamptz not null default now(),
  primary key (provider, subject)
);
create index identities_account on identities (account_id);

create table oauth_states (                     -- PKCE + CSRF state for the OAuth round trip (shared by all copies)
  state_hash   bytea primary key check (length(state_hash) = 32),
  provider     text not null check (provider in ('github','google')),
  verifier     text not null,
  return_to    text not null default '/' check (return_to like '/%' and return_to not like '//%'),
  expires_at   timestamptz not null
);

create table web_sessions (
  token_hash    bytea primary key check (length(token_hash) = 32),   -- sha256(cookie value)
  account_id    uuid not null references accounts (id) on delete cascade,
  csrf_token    text not null check (length(csrf_token) >= 32),
  uv_at         timestamptz,                     -- last WebAuthn user-verification (approve step-up)
  user_agent    text not null default '' check (length(user_agent) <= 300),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null
);
create index web_sessions_account on web_sessions (account_id);
create index web_sessions_expiry on web_sessions (expires_at);

create table devices (                          -- browser device keys (sign roster entries)
  id           uuid primary key,
  account_id   uuid not null references accounts (id) on delete cascade,
  ed25519_pk   bytea not null unique check (length(ed25519_pk) = 32),
  label        text not null check (length(label) between 1 and 80),
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz
);
create index devices_account on devices (account_id) where revoked_at is null;

create table webauthn_credentials (             -- step-up only (Touch ID / Face ID on approve); not a login method
  id            bytea primary key,
  account_id    uuid not null references accounts (id) on delete cascade,
  public_key    bytea not null,
  sign_count    bigint not null default 0,
  aaguid        bytea,
  transports    text[] not null default '{}',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index webauthn_account on webauthn_credentials (account_id);

create table human_checks (                     -- one challenge per approve click; single use
  id            uuid primary key,
  session_hash  bytea not null references web_sessions (token_hash) on delete cascade,
  account_id    uuid not null references accounts (id) on delete cascade,
  action        text not null check (action in
                  ('approve_join','approve_person','approve_device','webauthn_register')),
  target_id     uuid,
  challenge     bytea not null check (length(challenge) = 32),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  used_at       timestamptz,
  check ((action = 'webauthn_register') = (target_id is null))
);
create index human_checks_expiry on human_checks (expires_at) where used_at is null;

-- ───────────────────────────────────────────────────────────── rooms + roster

create table rooms (
  id                uuid primary key,             -- client-generated (UUIDv7), = idempotency key
  owner_account_id  uuid not null references accounts (id),
  name              text not null check (name ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  purpose           text not null default '' check (length(purpose) <= 140),
  genesis_hash      bytea not null check (length(genesis_hash) = 32),  -- sha256(genesis entry bytes)
  roster_head_seq   int not null default 0 check (roster_head_seq >= 0),
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
create unique index rooms_owner_name_uq on rooms (owner_account_id, name) where deleted_at is null;

create table room_people (                      -- derived from the roster (genesis, person_add, person_remove)
  room_id     uuid not null references rooms (id) on delete cascade,
  account_id  uuid not null references accounts (id),
  role        text not null check (role in ('owner','person')),
  added_at    timestamptz not null default now(),
  removed_at  timestamptz,
  primary key (room_id, account_id),
  check (role = 'person' or removed_at is null)  -- the owner can't be removed
);
create unique index room_people_one_owner on room_people (room_id) where role = 'owner';
create index room_people_account on room_people (account_id) where removed_at is null;

create table room_signers (                     -- derived: which device keys may sign roster entries, per room
  room_id     uuid not null references rooms (id) on delete cascade,
  ed25519_pk  bytea not null check (length(ed25519_pk) = 32),
  account_id  uuid not null references accounts (id),
  added_seq   int not null,
  removed_seq int,
  primary key (room_id, ed25519_pk),
  check (removed_seq is null or removed_seq > added_seq)
);

create table roster_entries (                   -- the signed, hash-chained log (crypto/ENVELOPE.md §5); never updated
  room_id     uuid not null references rooms (id) on delete cascade,
  seq         int not null check (seq >= 0),
  op          text not null check (op in ('genesis','device_add','device_remove','person_add','person_remove',
                                           'member_add','member_rekey','member_remove')),
  entry       bytea not null check (length(entry) <= 4096),     -- exact signed bytes
  entry_hash  bytea not null check (length(entry_hash) = 32),
  prev_hash   bytea check (prev_hash is null or length(prev_hash) = 32),
  signer_pk   bytea not null check (length(signer_pk) = 32),
  sig         bytea not null check (length(sig) = 64),
  created_at  timestamptz not null default now(),
  primary key (room_id, seq),
  check ((seq = 0) = (prev_hash is null)),
  check ((seq = 0) = (op = 'genesis'))
);

-- ───────────────────────────────────────────────────────────── invites + requests

create table invites (
  id                  uuid primary key,
  room_id             uuid not null references rooms (id) on delete cascade,
  kind                text not null check (kind in ('chat','person')),
  account_id          uuid not null references accounts (id),  -- chat: whose chats it admits; person: the owner who made it
  code                text not null unique check (code ~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]+$'),
  expires_at          timestamptz not null,
  off                 boolean not null default false,
  use_count           int not null default 0 check (use_count >= 0),
  used_by_account_id  uuid references accounts (id),           -- person invites: set once
  used_at             timestamptz,
  created_at          timestamptz not null default now(),
  check ((kind = 'chat' and length(code) = 10) or (kind = 'person' and length(code) = 16)),
  check (kind = 'person' or used_by_account_id is null),
  check ((used_by_account_id is null) = (used_at is null))
);
-- exactly one reusable chat invite per person per room (renew = new code on the same row)
create unique index invites_one_chat_per_person on invites (room_id, account_id) where kind = 'chat';

create table person_requests (                  -- a friend who redeemed a person invite; the owner approves
  id              uuid primary key,
  room_id         uuid not null references rooms (id) on delete cascade,
  invite_id       uuid not null unique references invites (id),  -- single-use person invite: at most one request
  account_id      uuid not null references accounts (id),
  device_pk       bytea not null check (length(device_pk) = 32),
  status          text not null default 'pending' check (status in ('pending','approved','rejected','expired')),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  decided_at      timestamptz,
  decided_by      uuid references accounts (id),
  check ((status = 'pending') = (decided_at is null))
);
create unique index person_requests_one_pending on person_requests (room_id, account_id) where status = 'pending';

create table join_requests (                    -- a chat asking to join (kind=join) or to move a member to a new machine (kind=claim)
  id              uuid primary key,             -- client-generated (UUIDv7) = idempotency key
  kind            text not null check (kind in ('join','claim')),
  room_id         uuid not null references rooms (id) on delete cascade,
  invite_id       uuid references invites (id),
  for_account_id  uuid not null references accounts (id),  -- the only person who may approve it
  member_id       uuid not null,                -- join: the new member's id (pre-assigned); claim: the member being moved
  name            text not null check (name ~ '^[a-z0-9][a-z0-9-]{0,23}$'),
  job             text not null default '' check (length(job) <= 140),
  app             text not null check (app in ('claude-code','codex','cursor','other')),
  machine         text not null default '' check (length(machine) <= 64),
  folder          text not null default '' check (length(folder) <= 200),
  turn            text not null check (turn in ('wake','listening','on_turn')),
  session_id      text check (session_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  ed25519_pk      bytea not null check (length(ed25519_pk) = 32),
  x25519_pk       bytea not null check (length(x25519_pk) = 32),
  match_code      text not null check (match_code ~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$'),
  request_hash    bytea not null check (length(request_hash) = 32),
  status          text not null default 'pending' check (status in ('pending','approved','rejected','expired','cancelled')),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  decided_at      timestamptz,
  decided_by      uuid references accounts (id),
  check (kind = 'claim' or invite_id is not null),
  check ((status = 'pending') = (decided_at is null))
);
create unique index join_requests_pending_name on join_requests (room_id, name) where status = 'pending' and kind = 'join';
create unique index join_requests_pending_member on join_requests (member_id) where status = 'pending';
create unique index join_requests_pending_key on join_requests (ed25519_pk) where status = 'pending';
create unique index join_requests_pending_code on join_requests (for_account_id, match_code) where status = 'pending';
create index join_requests_expiry on join_requests (expires_at) where status = 'pending';

-- ───────────────────────────────────────────────────────────── members

create table members (
  id                uuid primary key,
  room_id           uuid not null references rooms (id) on delete cascade,
  account_id        uuid not null references accounts (id),
  name              text not null check (name ~ '^[a-z0-9][a-z0-9-]{0,23}$'),
  app               text not null check (app in ('claude-code','codex','cursor','other')),
  job               text not null default '' check (length(job) <= 140),
  folder            text not null default '' check (length(folder) <= 200),
  machine           text not null default '' check (length(machine) <= 64),
  turn              text not null check (turn in ('always_on','wake','listening','on_turn')),
  ed25519_pk        bytea not null check (length(ed25519_pk) = 32),
  x25519_pk         bytea not null check (length(x25519_pk) = 32),
  key_epoch         int not null default 1 check (key_epoch >= 1),
  -- ONE holder at a time: a single column, changed only by compare-and-set (holder_epoch)
  holder_session    text check (holder_session ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  holder_epoch      bigint not null default 0,
  handover_env      text check (handover_env is null or length(handover_env) <= 8192),
  push_url          text check (push_url is null or (length(push_url) <= 500 and push_url ~ '^https?://')),
  push_secret       bytea check (push_secret is null or length(push_secret) = 32),
  push_verified_at  timestamptz,
  last_poll_at      timestamptz,                -- stamped by inbox lease long-polls (presence, any copy)
  last_wait_at      timestamptz,                -- stamped by watch's wait long-polls
  joined_at         timestamptz not null default now(),
  removed_at        timestamptz,
  check (turn <> 'always_on' or (push_url is not null and push_secret is not null and push_verified_at is not null))
);
create unique index members_room_name_uq on members (room_id, name) where removed_at is null;
create unique index members_key_uq on members (ed25519_pk) where removed_at is null;
create index members_room on members (room_id) where removed_at is null;
create index members_account on members (account_id) where removed_at is null;

-- ───────────────────────────────────────────────────────────── messages + per-recipient deliveries

create table messages (                         -- metadata only; kept 30 days
  id            uuid primary key,               -- client-generated UUIDv7 = idempotency key
  room_id       uuid not null references rooms (id) on delete cascade,
  from_member   uuid not null references members (id),
  scope         text not null check (scope in ('member','room')),
  to_member     uuid references members (id),
  in_reply_to   uuid,
  request_hash  bytea not null check (length(request_hash) = 32),  -- sha256(raw POST body): same id + same bytes = retry
  recipients    int not null check (recipients >= 1),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  check ((scope = 'member') = (to_member is not null)),
  check (expires_at > created_at)
);
create index messages_room_time on messages (room_id, created_at desc);
create index messages_retention on messages (created_at);

create table deliveries (                       -- one row per recipient: its sealed copy, its lifecycle, its lease
  seq           bigserial primary key,
  message_id    uuid not null references messages (id) on delete cascade,
  member_id     uuid not null references members (id) on delete cascade,
  key_epoch     int not null,                   -- recipient key epoch the copy was sealed to
  envelope      text check (envelope is null or length(envelope) <= 65536),  -- NULL once purged
  state         text not null default 'queued'
                check (state in ('queued','shown','done','stuck','needs_resend','expired')),
  stuck_reason  text check (stuck_reason is null or stuck_reason in
                  ('attempts','wakes','undecryptable','bad_signature','cannot_wake')),
  lease_until   timestamptz,
  attempts      int not null default 0 check (attempts >= 0),   -- leases taken
  wakes         int not null default 0 check (wakes >= 0),      -- wakes caused (watch's wait)
  shown_at      timestamptz,
  done_at       timestamptz,
  purge_after   timestamptz,                    -- shown + 24 h
  expires_at    timestamptz not null,           -- copied from messages for the sweeper
  updated_at    timestamptz not null default now(),
  unique (message_id, member_id),
  check (state not in ('queued','stuck') or envelope is not null),
  check (lease_until is null or state = 'queued'),
  check ((state = 'stuck') = (stuck_reason is not null)),
  check (state <> 'shown' or shown_at is not null),
  check (state <> 'done' or done_at is not null)
);
create index deliveries_inbox on deliveries (member_id, seq) where state = 'queued';
create index deliveries_recent on deliveries (member_id, seq) where state in ('shown','done') and envelope is not null;
create index deliveries_expiry on deliveries (expires_at) where state in ('queued','stuck','needs_resend');
create index deliveries_purge on deliveries (purge_after) where envelope is not null and purge_after is not null;

-- Lifecycle is monotonic: queued → shown → done; queued → stuck|needs_resend|expired;
-- stuck → queued (human retry) | needs_resend (rekey) | expired; needs_resend → expired.
create function deliveries_state_guard() returns trigger language plpgsql as $$
begin
  if new.state = old.state then
    return new;
  end if;
  if (old.state, new.state) in (('queued','shown'), ('queued','done'), ('queued','stuck'), ('queued','needs_resend'),
                                ('queued','expired'), ('shown','done'), ('stuck','queued'), ('stuck','expired'),
                                ('stuck','needs_resend'), ('needs_resend','expired')) then
    new.updated_at := now();
    return new;
  end if;
  raise exception 'illegal delivery state change % -> %', old.state, new.state using errcode = '23514';
end $$;
create trigger deliveries_state_guard before update of state on deliveries
  for each row execute function deliveries_state_guard();

-- ───────────────────────────────────────────────────────────── notices, attention, push outbox

create table notices (                          -- server-generated, content-free notes to a member (outside E2E; shown as server data)
  id          bigserial primary key,
  member_id   uuid not null references members (id) on delete cascade,
  kind        text not null check (kind in ('needs_resend','expired_unread','roster_changed','rejected_by_recipient')),
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  acked_at    timestamptz
);
create index notices_open on notices (member_id, id) where acked_at is null;
create unique index notices_one_roster_changed on notices (member_id) where kind = 'roster_changed' and acked_at is null;

create table attention (                        -- "What needs you" items for a person on the dashboard (deduped while open)
  id           uuid primary key,
  account_id   uuid not null references accounts (id) on delete cascade,
  room_id      uuid references rooms (id) on delete cascade,
  kind         text not null check (kind in ('stuck','needs_you','cannot_wake','new_device')),
  subject_id   uuid not null,                   -- member id, or device id for new_device
  data         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz
);
create unique index attention_open_uq on attention (account_id, kind, subject_id) where resolved_at is null;

create table push_jobs (                        -- transactional outbox for always-on members
  id               bigserial primary key,
  member_id        uuid not null references members (id) on delete cascade,
  message_id       uuid not null references messages (id) on delete cascade,
  tries            int not null default 0 check (tries >= 0),
  next_attempt_at  timestamptz not null default now(),
  done             boolean not null default false,
  failed           boolean not null default false,
  last_error       text check (last_error is null or length(last_error) <= 300),
  created_at       timestamptz not null default now(),
  unique (member_id, message_id),
  check (not failed or done)
);
create index push_jobs_due on push_jobs (next_attempt_at) where not done;

-- ───────────────────────────────────────────────────────────── replay protection + rate limits

create table request_nonces (
  key_pk   bytea not null check (length(key_pk) = 32),
  nonce    text not null check (nonce ~ '^[0-9a-f]{32}$'),
  seen_at  timestamptz not null default now(),
  primary key (key_pk, nonce)
);
create index request_nonces_age on request_nonces (seen_at);

create table rate_counters (                    -- fixed-window counters shared by all copies
  bucket        text not null,                  -- e.g. 'send:m:<member>:1m', 'invite_fail:ip:<ip>:1h'
  window_start  timestamptz not null,
  count         int not null default 0,
  primary key (bucket, window_start)
);
create index rate_counters_age on rate_counters (window_start);

-- ───────────────────────────────────────────────────────────── wake bus (NOTIFY on commit, never before)
-- Channels (payload ≤ 64 bytes): bl_inbox <member_id> · bl_join <join_request_id> · bl_session <member_id>
--                                bl_dash <account_id> · bl_push ''
-- Each server copy holds ONE dedicated LISTEN connection on all five channels (SPEC §8).

create function notify_inbox() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or (new.state = 'queued' and old.state is distinct from 'queued') then
    perform pg_notify('bl_inbox', new.member_id::text);
  end if;
  return null;
end $$;
create trigger deliveries_notify after insert or update of state on deliveries
  for each row execute function notify_inbox();

create function notify_member() returns trigger language plpgsql as $$
begin
  if new.holder_session is distinct from old.holder_session or new.holder_epoch <> old.holder_epoch then
    perform pg_notify('bl_session', new.id::text);
  end if;
  if new.removed_at is not null and old.removed_at is null then
    perform pg_notify('bl_inbox', new.id::text);    -- open polls of a removed member return 410
    perform pg_notify('bl_session', new.id::text);
  end if;
  return null;
end $$;
create trigger members_notify after update on members
  for each row execute function notify_member();

create function notify_join() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    perform pg_notify('bl_join', new.id::text);
  end if;
  perform pg_notify('bl_dash', new.for_account_id::text);
  return null;
end $$;
create trigger join_requests_notify after insert or update of status on join_requests
  for each row execute function notify_join();

create function notify_person_request() returns trigger language plpgsql as $$
declare owner uuid;
begin
  select owner_account_id into owner from rooms where id = new.room_id;
  perform pg_notify('bl_dash', owner::text);
  perform pg_notify('bl_dash', new.account_id::text);
  return null;
end $$;
create trigger person_requests_notify after insert or update of status on person_requests
  for each row execute function notify_person_request();

create function notify_attention() returns trigger language plpgsql as $$
begin
  perform pg_notify('bl_dash', new.account_id::text);
  return null;
end $$;
create trigger attention_notify after insert or update on attention
  for each row execute function notify_attention();

create function notify_roster() returns trigger language plpgsql as $$
declare acct uuid;
begin
  for acct in select account_id from room_people where room_id = new.room_id and removed_at is null loop
    perform pg_notify('bl_dash', acct::text);
  end loop;
  return null;
end $$;
create trigger roster_entries_notify after insert on roster_entries
  for each row execute function notify_roster();

create function notify_push() returns trigger language plpgsql as $$
begin
  perform pg_notify('bl_push', '');
  return null;
end $$;
create function notify_notice() returns trigger language plpgsql as $$
begin
  perform pg_notify('bl_inbox', new.member_id::text);
  return null;
end $$;
create trigger notices_notify after insert or update of data on notices
  for each row execute function notify_notice();

create trigger push_jobs_notify after insert on push_jobs
  for each row execute function notify_push();

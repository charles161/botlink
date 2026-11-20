-- bot-link v1 · 0042_passkey_reset (owner: server). Prod-readiness blocker 5: a lost passkey or laptop.
-- 1. passkey_resets: a signed-in person with no usable passkey asks to reset; after a waiting period (config, 72 h) the
--    browser that asked sets up a new passkey and, in the same transaction, every old passkey of the account is removed
--    and every other sign-in ends. One open reset per account. Kept after it ends, for the record and the rate limit.
-- 2. account_events: what happened to an account's locks (reset started / cancelled / completed, a browser removed).
-- 3. human_checks: three new actions. device_remove (target: the device) asserts a passkey every time;
--    passkey_reset_cancel asserts any passkey of the account; passkey_reset_finish registers the new passkey.
-- Additive only: the previous binary never reads these tables and never issues these actions.

create table passkey_resets (
  id            uuid primary key,
  account_id    uuid not null references accounts (id) on delete cascade,
  session_hash  bytea not null check (length(session_hash) = 32),  -- the sign-in that asked; only it can finish (no FK: the row outlives it)
  user_agent    text not null default '' check (length(user_agent) <= 300),
  created_at    timestamptz not null default now(),
  ready_at      timestamptz not null,
  cancelled_at  timestamptz,
  cancelled_by  text check (cancelled_by in ('passkey', 'session')),
  completed_at  timestamptz,
  check (ready_at > created_at),
  check (cancelled_at is null or completed_at is null),
  check ((cancelled_at is null) = (cancelled_by is null))
);
create unique index passkey_resets_one_open on passkey_resets (account_id) where cancelled_at is null and completed_at is null;
create index passkey_resets_account on passkey_resets (account_id, created_at);

create table account_events (
  id          bigserial primary key,
  account_id  uuid not null references accounts (id) on delete cascade,
  kind        text not null check (kind in ('passkey_reset_started', 'passkey_reset_cancelled', 'passkey_reset_completed', 'device_removed')),
  data        jsonb not null default '{}'::jsonb,
  at          timestamptz not null default now()
);
create index account_events_account on account_events (account_id, at desc);

alter table human_checks drop constraint if exists human_checks_action_check;
alter table human_checks add constraint human_checks_action_check check (action in
  ('approve_join','approve_person','approve_device','webauthn_register','admin','passkey_remove',
   'device_remove','passkey_reset_cancel','passkey_reset_finish','account_delete'));
alter table human_checks drop constraint if exists human_checks_check;
alter table human_checks add constraint human_checks_check check
  ((action in ('webauthn_register','admin','passkey_remove','passkey_reset_cancel','passkey_reset_finish','account_delete')) = (target_id is null));

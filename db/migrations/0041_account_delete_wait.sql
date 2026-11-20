-- bot-link v1 · 0041_account_delete_wait (lane ACCOUNT, security re-review of fix-all, 16 Nov 2026). Account delete
-- waits: an ask (passkey, typed email) records a pending delete; it can be finished only after a wait
-- (BOTLINK_ACCOUNT_DELETE_DELAY, 72 h) and before it lapses (BOTLINK_ACCOUNT_DELETE_WINDOW, 7 days later), with a fresh
-- passkey. Meanwhile every signed-in page of the account shows it and any sign-in of the account can cancel it. Closes
-- "a thief with a passkey on a stolen laptop deletes at once" and "an account with no passkey is deleted on day 0".
-- One open ask per account. Rows go with the account when the delete finishes. Additive only.
create table if not exists account_deletes (
  id            uuid primary key,
  account_id    uuid not null references accounts (id) on delete cascade,
  session_hash  bytea not null check (length(session_hash) = 32),  -- the sign-in that asked (no FK: it may end first)
  user_agent    text not null default '' check (length(user_agent) <= 300),
  created_at    timestamptz not null default now(),
  ready_at      timestamptz not null,
  lapses_at     timestamptz not null,
  cancelled_at  timestamptz,
  cancelled_by  text check (cancelled_by in ('session', 'passkey', 'passkey_reset', 'lapsed')),
  check (ready_at >= created_at),
  check (lapses_at > ready_at),
  check ((cancelled_at is null) = (cancelled_by is null))
);
create unique index if not exists account_deletes_one_open on account_deletes (account_id) where cancelled_at is null;

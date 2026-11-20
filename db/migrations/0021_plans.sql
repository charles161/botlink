-- bot-link v1 · 0021_plans (owner: lane D1). Plans, live limits with per-account snapshots (only up), temporary
-- boosts, a change log, over-limit records, a credits ledger, daily usage, and payment gateway state.
-- Additive only: no existing table changes, so the previous binary keeps working on this schema.
--
-- Rules (CONTRACT-PLANS.md, SPEC §9):
--   * plans holds the live numbers an admin edits. account_plan_limits holds each account's snapshot of a plan;
--     a plan raise lifts every snapshot of that plan (greatest), a lowering touches no snapshot and first writes
--     the old numbers for every existing account that had none, so only accounts created afterwards get the lower
--     numbers.
--   * account_raises: per-account raises (the server refuses a lower value). limit_boosts: temporary raises with an
--     end date. Effective = max(snapshot, raise, active boost), capped by today's hard caps (the ceiling).
--   * account_billing: the account's paid plan and until when. No row = Free. A paid plan lasts until paid_until
--     (Postgres now()), then the account is on Free: no job needed, every server copy agrees.
--   * Every row is in Postgres; no in-memory state that copies must agree on (SPEC §8).

create table plans (
  id                          text primary key check (id ~ '^[a-z][a-z0-9_]{0,31}$'),
  name                        text not null check (length(name) between 1 and 40),
  rooms                       int not null check (rooms between 1 and 10000),
  agents_per_room             int not null check (agents_per_room between 1 and 10000),
  people_per_room             int not null check (people_per_room between 1 and 10000),
  history_days                int not null check (history_days between 1 and 10000),
  for_sale                    boolean not null default false,
  price_month_usd_cents       int not null default 0 check (price_month_usd_cents >= 0),
  price_year_month_usd_cents  int not null default 0 check (price_year_month_usd_cents >= 0),
  sort                        int not null default 0,
  updated_at                  timestamptz not null default now()
);

-- Free and Pro: decided by Charles (12 Nov 2026). Pro's numbers are today's hard caps. Team: stored, not for sale;
-- 100/50/25 was proposed and its history days are undecided (30 is a placeholder).
insert into plans (id, name, rooms, agents_per_room, people_per_room, history_days, for_sale, price_month_usd_cents, price_year_month_usd_cents, sort) values
  ('free', 'Free', 3,   5,  4,  7,  false, 0,    0,    0),
  ('pro',  'Pro',  20,  20, 10, 30, true,  1500, 1200, 1),
  ('team', 'Team', 100, 50, 25, 30, false, 0,    0,    2);

create table account_plan_limits (
  account_id       uuid not null references accounts (id) on delete cascade,
  plan_id          text not null references plans (id),
  rooms            int not null,
  agents_per_room  int not null,
  people_per_room  int not null,
  history_days     int not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (account_id, plan_id)
);
create index account_plan_limits_plan on account_plan_limits (plan_id);

create table account_raises (
  account_id       uuid primary key references accounts (id) on delete cascade,
  rooms            int check (rooms between 1 and 10000),
  agents_per_room  int check (agents_per_room between 1 and 10000),
  people_per_room  int check (people_per_room between 1 and 10000),
  history_days     int check (history_days between 1 and 10000),
  updated_at       timestamptz not null default now()
);

create table limit_boosts (
  id          uuid primary key,
  account_id  uuid not null references accounts (id) on delete cascade,
  limit_key   text not null check (limit_key in ('rooms','agents_per_room','people_per_room','history_days')),
  value       int not null check (value between 1 and 10000),
  starts_at   timestamptz not null default now(),
  ends_at     timestamptz not null,
  reason      text not null check (length(reason) between 1 and 300),
  created_by  uuid references accounts (id) on delete set null,
  created_at  timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index limit_boosts_account on limit_boosts (account_id, ends_at);

-- Every change: who, when, what, from, to, why.
create table limit_changes (
  id                bigserial primary key,
  at                timestamptz not null default now(),
  actor_kind        text not null check (actor_kind in ('admin','payment','system')),
  actor_account_id  uuid references accounts (id) on delete set null,
  target            text not null check (target in ('plan','account','boost','credits','account_plan')),
  plan_id           text references plans (id),
  account_id        uuid references accounts (id) on delete cascade,
  limit_key         text not null check (length(limit_key) between 1 and 40),
  from_value        text check (from_value is null or length(from_value) <= 80),
  to_value          text check (to_value is null or length(to_value) <= 80),
  reason            text not null check (length(reason) between 1 and 300)
);
create index limit_changes_at on limit_changes (at desc);
create index limit_changes_account on limit_changes (account_id, at desc);

-- An action took an account over a plan limit: allowed (count mode) or refused (block mode).
create table limit_events (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  account_id  uuid not null references accounts (id) on delete cascade,
  limit_key   text not null check (limit_key in ('rooms','agents_per_room','people_per_room')),
  room_id     uuid references rooms (id) on delete cascade,
  used        int not null,
  value       int not null,
  refused     boolean not null default false
);
create index limit_events_at on limit_events (at desc);

-- Credits: grants (admin, free), top-ups (bought), usage (debits), refunds (a refunded pack takes its credits back).
-- What a credit buys is not decided; usage debits stay off until a unit price is set in config.
create table credit_ledger (
  id                bigserial primary key,
  account_id        uuid not null references accounts (id) on delete cascade,
  at                timestamptz not null default now(),
  kind              text not null check (kind in ('grant','topup','usage','refund')),
  amount            bigint not null,
  reason            text not null check (length(reason) between 1 and 300),
  actor_account_id  uuid references accounts (id) on delete set null,
  ref               text check (ref is null or length(ref) <= 200),   -- idempotency key (payment, refund, usage day)
  check ((kind in ('grant','topup') and amount > 0) or (kind in ('usage','refund') and amount < 0))
);
create unique index credit_ledger_ref_uq on credit_ledger (ref) where ref is not null;
create index credit_ledger_account on credit_ledger (account_id, id desc);

-- Daily usage per account from metadata only (UTC days). Recomputed while the source rows exist; final once the day
-- is over (then it may be debited, once, if a unit price is set).
create table usage_daily (
  account_id     uuid not null references accounts (id) on delete cascade,
  day            date not null,
  messages_sent  int not null default 0,
  chats_active   int not null default 0,
  wakes          int not null default 0,
  credits_used   bigint not null default 0,
  final          boolean not null default false,
  updated_at     timestamptz not null default now(),
  primary key (account_id, day)
);

-- Payment state per account. No row = Free, never paid.
create table account_billing (
  account_id            uuid primary key references accounts (id) on delete cascade,
  plan_id               text not null default 'free' references plans (id),
  paid_until            timestamptz,
  status                text not null default 'none'
                        check (status in ('none','active','on_hold','past_due','paused','cancelled','expired','failed')),
  billing_interval      text check (billing_interval in ('month','year')),
  cancel_at_period_end  boolean not null default false,
  gateway               text check (gateway in ('fake','dodo')),
  customer_id           text check (customer_id is null or length(customer_id) <= 200),
  subscription_id       text check (subscription_id is null or length(subscription_id) <= 200),
  last_event_at         timestamptz,       -- event time of the newest subscription event applied (ordering)
  updated_at            timestamptz not null default now()
);
create index account_billing_sub on account_billing (gateway, subscription_id);
create index account_billing_customer on account_billing (gateway, customer_id);

create table billing_checkouts (
  id           uuid primary key,
  account_id   uuid not null references accounts (id) on delete cascade,
  gateway      text not null check (gateway in ('fake','dodo')),
  product      text not null check (product in ('pro_monthly','pro_yearly','credits_pack')),
  session_id   text check (session_id is null or length(session_id) <= 200),
  created_at   timestamptz not null default now(),
  paid_at      timestamptz
);
create index billing_checkouts_account on billing_checkouts (account_id, created_at desc);

-- Every verified gateway event, once (idempotency and replay protection by event id).
create table billing_events (
  gateway      text not null check (gateway in ('fake','dodo')),
  event_id     text not null check (length(event_id) between 1 and 200),
  type         text not null check (length(type) <= 80),
  event_at     timestamptz,
  account_id   uuid references accounts (id) on delete set null,
  applied      boolean not null,
  note         text check (note is null or length(note) <= 200),
  received_at  timestamptz not null default now(),
  primary key (gateway, event_id)
);

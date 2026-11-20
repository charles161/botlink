-- bot-link v1 · 0047_storage_total (owner: fix-all lane LIMITS, blocker 8 follow-up). A server-wide total of stored
-- message bytes, so a handful of accounts cannot fill the disk together (config BOTLINK_STORAGE_TOTAL_MB refuses a
-- send in every limits mode). One row, folded by the sweeper in the same statement that folds account_storage_log
-- into account_storage; the live total = this row + every pending delta in account_storage_log.
-- account_storage and account_storage_log have no foreign key to accounts on purpose: an account row deleted or
-- tombstoned never blocks or breaks the triggers, and its counter reaches 0 as its copies go.
create table if not exists storage_total (
  one         boolean primary key default true check (one),
  bytes       bigint not null default 0,
  updated_at  timestamptz not null default now()
);
insert into storage_total (one, bytes) select true, coalesce(sum(bytes), 0) from account_storage
  on conflict (one) do nothing;

-- The admin's stop for an abusive account (security review finding 3; plans.SetSendsRefused): while set, its sends
-- get 403 sends_refused. Nullable, no default: no table rewrite.
alter table accounts add column if not exists sends_refused_at timestamptz;

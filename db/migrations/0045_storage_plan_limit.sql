-- bot-link v1 · 0045_storage_plan_limit (owner: fix-all lane LIMITS, blocker 8). A fifth plan limit, storage_mb: how
-- many MB of messages one account's chats may have stored on the server at once (CONTRACT-PLANS.md, SPEC §9). It fits
-- the plans system of 0021: a plan number, a per-account snapshot (only up), raises and boosts, over-limit records.
-- A server-wide safety ceiling per account (config BOTLINK_STORAGE_CEILING_MB) refuses in every mode; it is not here.
-- Additive only: new nullable or defaulted columns and wider checks, so the previous binary keeps working.

alter table plans add column if not exists storage_mb int not null default 256 check (storage_mb between 1 and 10000);
update plans set storage_mb = case id when 'free' then 256 when 'pro' then 1024 when 'team' then 1024 else storage_mb end;

-- NULL in a snapshot written before this migration = the plan's number (a lowering fills it first, plans/admin.go).
alter table account_plan_limits add column if not exists storage_mb int check (storage_mb between 1 and 10000);
alter table account_raises add column if not exists storage_mb int check (storage_mb between 1 and 10000);

alter table limit_boosts drop constraint if exists limit_boosts_limit_key_check;
alter table limit_boosts add constraint limit_boosts_limit_key_check
  check (limit_key in ('rooms','agents_per_room','people_per_room','history_days','storage_mb'));
alter table limit_events drop constraint if exists limit_events_limit_key_check;
alter table limit_events add constraint limit_events_limit_key_check
  check (limit_key in ('rooms','agents_per_room','people_per_room','storage_mb'));
alter table limit_reached_days drop constraint if exists limit_reached_days_limit_key_check;
alter table limit_reached_days add constraint limit_reached_days_limit_key_check
  check (limit_key in ('rooms','agents_per_room','people_per_room','storage_mb'));

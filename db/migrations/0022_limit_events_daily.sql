-- bot-link v1 · 0022_limit_events_daily (owner: lane D1). Over-limit records are bounded: one row per account, limit,
-- room, UTC day and outcome (allowed in count mode / refused in block mode), with a count of attempts. Before this,
-- block mode wrote one row per refused attempt (an owner retrying room creation could add hundreds a minute).
alter table limit_events add column if not exists day date not null default ((now() at time zone 'UTC')::date);
alter table limit_events add column if not exists attempts int not null default 1 check (attempts >= 1);
create unique index if not exists limit_events_daily_uq on limit_events
  (account_id, limit_key, coalesce(room_id, '00000000-0000-0000-0000-000000000000'::uuid), day, refused);

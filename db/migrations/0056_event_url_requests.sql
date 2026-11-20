-- bot-link v1 · 0056_event_url_requests (lane EVENTURL-SERVER; docs/protocol/event-url-approval.md, SPEC §6.13). An event
-- address that cannot echo bot-link's check value (a routine's trigger answers 200 and nothing else) is made usable by
-- the member's person, who approves it on the dashboard with a passkey. Until then the ask is one row here: no
-- subscription, no event job, and nothing is sent to the address.
-- 1. event_url_requests, a new table. The reference to members takes a brief lock on it while the empty table is made.
-- 2. event_subscriptions.approved_by: 'person' when the member's person approved the address (it never proved itself);
--    null when the address echoed the check. approved_at: when the person last approved it. Nullable columns with no
--    default rewrite nothing; the CHECK reads the table once (a few rows per member) under the lock_timeout below.
-- 3. event_url_refusals, a new table: the member's person stopped an approved address or turned a request for it down;
--    for 24 hours a plain subscribe of that member to that address sends it nothing, not even the check. Keyed by the
--    address without its query (events.URLKey), so another ?key= on the same trigger is the same address. No reference
--    to members on purpose: a reference takes a share lock on the member row, and a Stop or a no (which write here)
--    would then deadlock against an approval or a subscribe that holds that row (found by TestEventURLRaces). Rows go
--    with the account's delete and when their 24 hours are over (the sweeper).
-- 4. human_checks gains the action 'approve_event_url' (target: the request). MERGE NOTE: keep every action of 0055,
--    0053, 0042 and 0040. Additive: the previous binary never writes it. The rewrite checks human_checks' rows under its
--    lock; the sweeper keeps that table to the checks of the last few minutes.
-- The lock_timeout makes this fail fast (the deploy stops before the switch) instead of queueing every request on these
-- tables behind a long transaction that holds one of them.
set local lock_timeout = '3s';

create table event_url_requests (
  id              uuid primary key,                                     -- UUIDv7, made by the server
  member_id       uuid not null references members (id) on delete cascade,
  key_epoch       int not null,                                         -- the asking chat's keys: a move ends the request
  url             text not null check (length(url) <= 500 and url ~ '^https?://'),
  name            text not null check (name = 'message.received'),      -- the card describes this event only
  urgent_only     boolean not null default false,
  secret          bytea not null check (length(secret) between 24 and 64), -- becomes the subscription's secret
  ttl_s           int not null check (ttl_s between 300 and 7776000),   -- the subscription's time once approved
  status          text not null default 'waiting' check (status in ('waiting', 'approved', 'rejected')),
  subscription_id text check (subscription_id is null or subscription_id ~ '^sub_[0-9a-f]{24}$'), -- made by the approval
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,                                 -- 24 hours: nobody approved it → deleted
  decided_at      timestamptz,
  check ((status = 'waiting') = (decided_at is null)),
  check ((status = 'approved') = (subscription_id is not null))
);
-- the same ask while one waits gets the same request
create unique index event_url_requests_waiting_key on event_url_requests (member_id, key_epoch, url, name, urgent_only) where status = 'waiting';
create index event_url_requests_member on event_url_requests (member_id);
create index event_url_requests_waiting_expiry on event_url_requests (expires_at) where status = 'waiting';

alter table event_subscriptions add column approved_by text check (approved_by = 'person');
alter table event_subscriptions add column approved_at timestamptz;
alter table event_subscriptions add constraint event_subscriptions_approved_check check ((approved_by is null) = (approved_at is null));

create table event_url_refusals (
  member_id   uuid not null,
  url_key     text not null check (length(url_key) <= 500 and url_key ~ '^https?://'),
  reason      text not null check (reason in ('stopped', 'rejected')),
  created_at  timestamptz not null default now(),
  until       timestamptz not null,
  primary key (member_id, url_key)
);
create index event_url_refusals_until on event_url_refusals (until);

alter table human_checks drop constraint if exists human_checks_action_check;
alter table human_checks add constraint human_checks_action_check check (action in
  ('approve_join','approve_person','approve_device','webauthn_register','admin','passkey_remove',
   'device_remove','passkey_reset_cancel','passkey_reset_finish','account_delete','confirm_room','approve_joins',
   'approve_event_url'));

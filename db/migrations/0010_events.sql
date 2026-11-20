-- bot-link v1 · 0010_events (owner: server). bot-link Events (SPEC §6.13), the webhook mode of MCP Events (SEP-3415):
-- a member subscribes a URL to content-free events and bot-link POSTs each one as a Standard Webhooks message
-- (webhook-id / webhook-timestamp / webhook-signature, HMAC-SHA256). This is the wake path that needs no listener process on the member's computer:
-- whatever sits behind the URL (a cloud agent's trigger, a harness that speaks MCP Events, `botlink events serve`)
-- gives the chat a turn. Events never carry message text: the sealed copy still waits in the inbox.
-- Additive only: the previous binary keeps working on this schema until it restarts (it just never emits).

create table event_subscriptions (
  -- MCP Events (SEP-3415): the id is derived from the subscription's key (member, url, event name, arguments), so
  -- subscribing again with the same key refreshes the same row. One row per event name.
  id            text primary key check (id ~ '^sub_[0-9a-f]{24}$'),
  member_id     uuid not null references members (id) on delete cascade,
  key_epoch     int not null,                     -- the member's key_epoch at subscribe: a moved member's old subscriptions stop
  url           text not null check (length(url) <= 500 and url ~ '^https?://'),
  name          text not null,                    -- event name: message.received | roster.changed
  urgent_only   boolean not null default false,   -- argument: skip quiet (fyi) messages
  secret        bytea not null check (length(secret) between 24 and 64),
  prev_secret   bytea check (prev_secret is null or length(prev_secret) between 24 and 64),
  prev_until    timestamptz,                      -- a refresh replaced the secret: sign with both until then
  created_at    timestamptz not null default now(),
  refreshed_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  verified_at   timestamptz,                      -- the URL echoed the signed verification challenge
  last_ok_at    timestamptz,                      -- last 2xx
  last_error    text check (last_error is null or length(last_error) <= 300),
  failed_since  timestamptz,
  fails         int not null default 0,           -- events in a row that ran out of tries
  disabled_at   timestamptz                       -- too many failures in a row: off until the next refresh
);
create index event_subscriptions_member on event_subscriptions (member_id);

create table event_jobs (                         -- transactional outbox, one row per (subscription, event)
  id               bigserial primary key,
  subscription_id  text not null references event_subscriptions (id) on delete cascade,
  event_id         uuid not null default gen_random_uuid(),   -- webhook-id: the same on every retry
  type             text not null,
  message_id       uuid references messages (id) on delete cascade,
  data             jsonb not null default '{}'::jsonb,
  tries            int not null default 0 check (tries >= 0),
  next_attempt_at  timestamptz not null default now(),
  done             boolean not null default false,
  failed           boolean not null default false,
  last_error       text check (last_error is null or length(last_error) <= 300),
  created_at       timestamptz not null default now(),
  check (not failed or done)
);
create index event_jobs_due on event_jobs (next_attempt_at) where not done;
create index event_jobs_subscription on event_jobs (subscription_id);
create index event_jobs_message on event_jobs (message_id) where message_id is not null;

-- A copy for a member (a message, a self-test, a re-send) → one job per live subscription of that member. The job
-- becomes due when the copy does (deliveries.not_before: the wake test is held back so the chat's turn can end).
-- Hello messages (intro) never wake anybody (SPEC §6.4a); quiet ones skip urgent_only subscriptions.
create function emit_message_event() returns trigger language plpgsql as $$
declare msg record;
begin
  select m.quiet, m.intro into msg from messages m where m.id = new.message_id;
  if not found or msg.intro then
    return null;
  end if;
  insert into event_jobs (subscription_id, type, message_id, next_attempt_at)
  select s.id, 'message.received', new.message_id, coalesce(new.not_before, now())
  from event_subscriptions s join members mem on mem.id = s.member_id
  where s.member_id = new.member_id and s.disabled_at is null and s.verified_at is not null and s.expires_at > now()
    and mem.removed_at is null and s.key_epoch = mem.key_epoch
    and s.name = 'message.received'
    and not (s.urgent_only and msg.quiet);
  return null;
end $$;
create trigger deliveries_emit_event after insert on deliveries
  for each row execute function emit_message_event();

-- The member list changed (a join, a leave, a removal, a move): content-free, off unless subscribed to.
create function emit_roster_event() returns trigger language plpgsql as $$
begin
  if new.kind <> 'roster_changed' then
    return null;
  end if;
  insert into event_jobs (subscription_id, type, data)
  select s.id, 'roster.changed', jsonb_build_object('head_seq', new.data -> 'head_seq')
  from event_subscriptions s join members mem on mem.id = s.member_id
  where s.member_id = new.member_id and s.disabled_at is null and s.verified_at is not null and s.expires_at > now()
    and mem.removed_at is null and s.key_epoch = mem.key_epoch
    and s.name = 'roster.changed';
  return null;
end $$;
-- insert OR update: while a member hasn't read the note, further changes update the same open note (store.RosterChanged)
create trigger notices_emit_event after insert or update of data on notices
  for each row execute function emit_roster_event();

-- The events worker shares the push worker's bell.
create trigger event_jobs_notify after insert on event_jobs
  for each row execute function notify_push();

-- bot-link v1 · 0012_wake_controls (owner: server). Security review 12 Nov 2026 (wake and cost abuse; Victor's points
-- 7 and 9): a member could wake another person's chat (a full resume, on that person's account) 30 times a minute,
-- and nothing let a person quiet one member or all of their chats. Three controls, all on WAKES only: the copy still
-- waits and is read on the chat's next turn.
--   deliveries.no_wake   this copy wakes nobody (muted sender, paused person, or over the sender's wake budget)
--   accounts.wakes_paused_at   "Pause all my chats": nothing wakes this person's chats until they resume
--   mutes                a person's chats are not woken by one member (any room it is in)
-- Additive only: the previous binary keeps working on this schema until it restarts (no_wake defaults to false).
alter table deliveries add column if not exists no_wake boolean not null default false;
alter table accounts add column if not exists wakes_paused_at timestamptz;

create table if not exists mutes (
  account_id  uuid not null references accounts (id) on delete cascade,  -- whose chats are not woken
  member_id   uuid not null references members (id) on delete cascade,   -- by this member
  created_at  timestamptz not null default now(),
  primary key (account_id, member_id)
);

-- event subscriptions wake a chat from outside: a copy that wakes nobody makes no event
create or replace function emit_message_event() returns trigger language plpgsql as $$
declare msg record;
begin
  if new.no_wake then
    return null;
  end if;
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

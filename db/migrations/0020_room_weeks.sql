-- bot-link v1 · 0020_room_weeks (owner: metrics). The numbers that decide the company (KILL-CRITERIA.md) are weekly
-- and run for months, but messages are deleted after 30 days (sweeper). Without this table week-4 retention and the
-- month-6 numbers could not be computed at all.
--
-- 1. room_week_senders: per ISO week (Monday, UTC), per room, per person whose chat sent a conversation message that
--    week (scope member or room; no join hellos, no self-tests): the first and last time and how many. Metadata only:
--    no text, no sealed copy, no names. Kept as long as the room (rooms are soft-deleted). Filled by a trigger on
--    messages, backfilled from the messages still kept. Read by deploy/metrics/*.sql.
-- 2. metric_org(email): the "organisation" of an address for counting domains honestly. A well-known free-mail domain
--    is not an organisation: two people at gmail.com are two people, so a free-mail address counts as its own
--    organisation (the whole address); any other address counts as its domain. Returns a key to count distinct
--    values of; the queries never output it. To change the list, add a migration that replaces the function.
-- Additive only: the previous binary keeps working on this schema until it restarts.

create table if not exists room_week_senders (
  week        date not null,                                     -- Monday of the ISO week, UTC
  room_id     uuid not null references rooms (id) on delete cascade,
  account_id  uuid not null,                                     -- the person whose chat sent
  first_at    timestamptz not null,
  last_at     timestamptz not null,
  messages    int not null default 1 check (messages >= 1),
  primary key (week, room_id, account_id),
  check (last_at >= first_at)
);
create index if not exists room_week_senders_room on room_week_senders (room_id, week);
create index if not exists room_week_senders_account on room_week_senders (account_id, first_at);

create or replace function record_room_week() returns trigger language plpgsql as $$
begin
  insert into room_week_senders (week, room_id, account_id, first_at, last_at)
  select (date_trunc('week', new.created_at at time zone 'UTC'))::date, new.room_id, m.account_id, new.created_at, new.created_at
  from members m where m.id = new.from_member
  on conflict (week, room_id, account_id) do update set
    first_at = least(room_week_senders.first_at, excluded.first_at),
    last_at  = greatest(room_week_senders.last_at, excluded.last_at),
    messages = room_week_senders.messages + 1;
  return null;
end $$;

drop trigger if exists messages_room_week on messages;
create trigger messages_room_week after insert on messages
  for each row when (new.scope in ('member', 'room') and not new.intro) execute function record_room_week();

insert into room_week_senders (week, room_id, account_id, first_at, last_at, messages)
select (date_trunc('week', msg.created_at at time zone 'UTC'))::date, msg.room_id, m.account_id,
       min(msg.created_at), max(msg.created_at), count(*)
from messages msg join members m on m.id = msg.from_member
where msg.scope in ('member', 'room') and not msg.intro
group by 1, 2, 3
on conflict do nothing;

create or replace function metric_org(email text) returns text language sql immutable parallel safe as $$
  select case when split_part(lower(email), '@', 2) in (
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'msn.com',
    'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'ymail.com', 'rocketmail.com', 'icloud.com', 'me.com', 'mac.com',
    'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.de', 'gmx.net', 'web.de', 'mail.com',
    'zoho.com', 'yandex.com', 'yandex.ru', 'mail.ru', 'qq.com', '163.com', '126.com', 'fastmail.com', 'hey.com',
    'tutanota.com', 'tuta.io', 'rediffmail.com', 'naver.com', 'hanmail.net', 'seznam.cz', 'libero.it',
    'orange.fr', 'free.fr', 't-online.de', 'comcast.net', 'att.net', 'verizon.net')
  then lower(email) else split_part(lower(email), '@', 2) end
$$;

-- 3. metric_answers(t0, t1): every cross-person message answered inside [t0, t1), with whether the answer came while
--    the recipient's chat was idle. The same definition as THE ONE NUMBER in deploy/metrics/launch.sql (read its
--    header for the rule and its limits), for any window and any room; the weekly series and the funnel use it. Reads
--    messages, deliveries and push_jobs metadata (never the sealed copy), so only windows inside the last 30 days are
--    complete. One row per answered message: count distinct room_id.
create or replace function metric_answers(t0 timestamptz, t1 timestamptz)
returns table (room_id uuid, idle boolean) language sql stable as $$
  with msgs as (
    select x.id, x.room_id, x.from_member, x.in_reply_to, x.created_at from messages x
    where x.scope in ('member', 'room') and not x.intro and x.created_at >= t0 and x.created_at < t1
  )
  select m.room_id,
         (d.wakes > 0
          or exists (select 1 from push_jobs pj where pj.message_id = m.id and pj.member_id = b.id and pj.done and not pj.failed)
          or (b.wake_verified_at >= m.created_at and b.wake_verified_at <= r.created_at))
  from msgs m
  join members a on a.id = m.from_member
  join deliveries d on d.message_id = m.id
  join members b on b.id = d.member_id
  join msgs r on r.room_id = m.room_id and r.from_member = b.id and r.created_at > m.created_at
  where r.created_at < least(m.created_at + interval '24 hours', t1)
    and a.account_id <> b.account_id
    and (r.in_reply_to = m.id or exists (select 1 from deliveries rd where rd.message_id = r.id and rd.member_id = a.id))
$$;

-- bot-link v1 · activation by sign-up week (KILL-CRITERIA.md). The last 26 ISO weeks (Monday, UTC), oldest first.
-- Of the accounts created in a week, how many reached each step within 7 days of their own sign-up. Metadata only,
-- counts only. Read-only. No variables:
--
--   psql "$BOTLINK_DATABASE_URL" -f db/metrics/activation.sql
--
-- Columns (each step counts an account once; steps are not required in order)
--   signup_week       Monday of the week the accounts were created
--   accounts          accounts created that week
--   in_room           created a room or was added to one as a person (room_people.added_at)
--   chat_approved     one of their chats joined a room (a member row exists only after its person approved it)
--   first_message     one of their chats sent a conversation message, or a chat of another person sent one into a
--                     room one of their chats was in (after it joined). From room_week_senders (migration 0020),
--                     which keeps per week the first and last send of each person in each room: "received" is
--                     counted when that span overlaps [their chat joined, sign-up + 7 days) (can overcount when
--                     the other person's sends that week fell only before and after that window).
--   between_people    they and another person both sent in the same room within 7 days of the sign-up: a room
--                     between people, the durable rule (no idle-answer condition; see weekly.sql)
--   complete          false while the youngest accounts of the week are under 7 days old (the counts can still grow)
with weeks as (
  select w::date as week, (w::timestamp at time zone 'UTC') as ws, (w::timestamp at time zone 'UTC') + interval '7 days' as we
  from generate_series(date_trunc('week', now() at time zone 'UTC') - interval '25 weeks',
                       date_trunc('week', now() at time zone 'UTC'), interval '7 days') w
),
cohort as (
  select a.id, a.created_at, a.created_at + interval '7 days' as c7, w.week
  from accounts a join weeks w on a.created_at >= w.ws and a.created_at < w.we
),
steps as (
  select c.week, c.id,
    exists (select 1 from room_people rp where rp.account_id = c.id and rp.added_at < c.c7) as in_room,
    exists (select 1 from members m where m.account_id = c.id and m.joined_at < c.c7) as chat_approved,
    (exists (select 1 from room_week_senders s where s.account_id = c.id and s.first_at < c.c7)
     or exists (select 1 from members m join room_week_senders s on s.room_id = m.room_id
                where m.account_id = c.id and m.joined_at < c.c7 and s.account_id <> c.id
                  and s.first_at < c.c7 and s.last_at >= m.joined_at)) as first_message,
    exists (select 1 from room_week_senders mine join room_week_senders other on other.room_id = mine.room_id
            where mine.account_id = c.id and mine.first_at < c.c7 and other.account_id <> c.id
              and other.first_at < c.c7 and other.last_at >= c.created_at) as between_people
  from cohort c
)
select
  w.week as signup_week,
  count(s.id) as accounts,
  count(s.id) filter (where s.in_room) as in_room,
  count(s.id) filter (where s.chat_approved) as chat_approved,
  count(s.id) filter (where s.first_message) as first_message,
  count(s.id) filter (where s.between_people) as between_people,
  now() >= w.we + interval '7 days' as complete
from weeks w left join steps s on s.week = w.week
group by w.week, w.we
order by w.week;

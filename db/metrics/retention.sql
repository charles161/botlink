-- bot-link v1 · retention of rooms between people, by cohort week (KILL-CRITERIA.md). The last 26 cohorts, oldest
-- first. Metadata only, counts only. Read-only. No variables:
--
--   psql "$BOTLINK_DATABASE_URL" -f db/metrics/retention.sql
--
-- A room's cohort week N is the first ISO week (Monday, UTC) in which the chats of 2+ people sent conversation
-- messages in it (it became a room between people; room_week_senders, migration 0020, kept past the 30-day message
-- deletion). It is back in week N+1 (N+4) when any of its chats sent a conversation message in that week.
--
-- Columns
--   cohort_week     Monday of week N
--   rooms           rooms whose cohort week is N
--   week1_back      of those, rooms with a message in week N+1; NULL until week N+1 has ended
--   week1_pct       100 * week1_back / rooms (NULL as above, or when rooms = 0)
--   week4_back      of those, rooms with a message in week N+4; NULL until week N+4 has ended
--   week4_pct       100 * week4_back / rooms (NULL as above)
with weeks as (
  select w::date as week, (w::timestamp at time zone 'UTC') as ws
  from generate_series(date_trunc('week', now() at time zone 'UTC') - interval '25 weeks',
                       date_trunc('week', now() at time zone 'UTC'), interval '7 days') w
),
between_weeks as (
  select s.room_id, s.week from room_week_senders s group by s.room_id, s.week having count(*) >= 2
),
cohort as (
  select b.room_id, min(b.week) as week from between_weeks b group by b.room_id
),
back as (
  select c.week, c.room_id,
         exists (select 1 from room_week_senders s where s.room_id = c.room_id and s.week = c.week + 7) as wk1,
         exists (select 1 from room_week_senders s where s.room_id = c.room_id and s.week = c.week + 28) as wk4
  from cohort c where c.week >= (select min(week) from weeks)
)
select
  w.week as cohort_week,
  count(b.room_id) as rooms,
  case when now() >= w.ws + interval '14 days' then count(b.room_id) filter (where b.wk1) end as week1_back,
  case when now() >= w.ws + interval '14 days' and count(b.room_id) > 0
       then round(100.0 * count(b.room_id) filter (where b.wk1) / count(b.room_id), 1) end as week1_pct,
  case when now() >= w.ws + interval '35 days' then count(b.room_id) filter (where b.wk4) end as week4_back,
  case when now() >= w.ws + interval '35 days' and count(b.room_id) > 0
       then round(100.0 * count(b.room_id) filter (where b.wk4) / count(b.room_id), 1) end as week4_pct
from weeks w left join back b on b.week = w.week
group by w.week, w.ws
order by w.week;

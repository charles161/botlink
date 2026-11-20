-- bot-link v1 · weekly series (KILL-CRITERIA.md). One row per ISO week (Monday, UTC), the last 26 weeks, oldest first.
-- Metadata only, counts only: never an email address or a domain name. Read-only. No variables:
--
--   psql "$BOTLINK_DATABASE_URL" -f db/metrics/weekly.sql
--
-- A room is "active" in a week when a chat sent a conversation message in it that week (scope member or room; no join
-- hellos, no self-tests), from room_week_senders (migration 0020: kept after messages are deleted at 30 days).
-- The room's people that week: the persons of its members that joined before the week ended and were not removed
-- before it started.
--
-- Columns
--   week                        Monday of the ISO week (UTC)
--   rooms_active                rooms with a conversation message that week
--   rooms_2plus_people          of those, rooms whose chats belong to 2+ people (two different accounts)
--   rooms_2plus_domains         of those, rooms whose people's email addresses span 2+ domains
--   rooms_2plus_domains_split_freemail
--                               the same, but an address at a well-known free-mail domain counts as its own domain
--                               (metric_org, migration 0020): two people at gmail.com are two people and ONE domain in
--                               rooms_2plus_domains, two "domains" here. So rooms_2plus_domains <= this <= 2plus_people.
--   rooms_between_people        active rooms where the chats of 2+ people sent messages that week (both sides talked).
--                               Kept forever; the durable stand-in for "rooms between people".
--   rooms_between_people_2plus_domains
--                               of rooms_between_people, those whose people span 2+ email domains (strict rule)
--   cross_domain_pct            100 * rooms_between_people_2plus_domains / rooms_between_people (NULL when 0)
--   rooms_activated             THE ONE NUMBER's rule for that week, any room: chats of two different people exchanged
--                               messages and one answered while idle (metric_answers, same rule as launch.sql).
--                               NULL when the week started more than 30 days ago (its messages are deleted).
--   rooms_activated_2plus_domains
--                               of rooms_activated, those whose people span 2+ email domains (strict). NULL as above.
--   week_complete               false for the current, unfinished week
with weeks as (
  select w::date as week, (w::timestamp at time zone 'UTC') as ws, (w::timestamp at time zone 'UTC') + interval '7 days' as we
  from generate_series(date_trunc('week', now() at time zone 'UTC') - interval '25 weeks',
                       date_trunc('week', now() at time zone 'UTC'), interval '7 days') w
),
active as (
  select s.week, s.room_id, count(*) as senders
  from room_week_senders s where s.week >= (select min(week) from weeks)
  group by s.week, s.room_id
),
people as ( -- per active room-week: people, raw domains, organisations
  select ac.week, ac.room_id, ac.senders,
         count(distinct m.account_id) as people,
         count(distinct split_part(a.email, '@', 2)) as domains,
         count(distinct metric_org(a.email)) as orgs
  from active ac
  join weeks w on w.week = ac.week
  join members m on m.room_id = ac.room_id and m.joined_at < w.we and (m.removed_at is null or m.removed_at >= w.ws)
  join accounts a on a.id = m.account_id
  group by ac.week, ac.room_id, ac.senders
),
activated as (
  select w.week, x.room_id
  from weeks w cross join lateral (select distinct ma.room_id from metric_answers(w.ws, w.we) ma where ma.idle) x
  where w.ws >= now() - interval '30 days'
)
select
  w.week,
  (select count(*) from active ac where ac.week = w.week) as rooms_active,
  (select count(*) from people p where p.week = w.week and p.people >= 2) as rooms_2plus_people,
  (select count(*) from people p where p.week = w.week and p.domains >= 2) as rooms_2plus_domains,
  (select count(*) from people p where p.week = w.week and p.orgs >= 2) as rooms_2plus_domains_split_freemail,
  (select count(*) from active ac where ac.week = w.week and ac.senders >= 2) as rooms_between_people,
  (select count(*) from people p where p.week = w.week and p.senders >= 2 and p.domains >= 2) as rooms_between_people_2plus_domains,
  (select case when count(*) filter (where p.senders >= 2) = 0 then null
               else round(100.0 * count(*) filter (where p.senders >= 2 and p.domains >= 2) / count(*) filter (where p.senders >= 2), 1) end
     from people p where p.week = w.week) as cross_domain_pct,
  case when w.ws >= now() - interval '30 days' then (select count(*) from activated x where x.week = w.week) end as rooms_activated,
  case when w.ws >= now() - interval '30 days' then (select count(*) from activated x join people p on p.week = x.week and p.room_id = x.room_id
                                                      where x.week = w.week and p.domains >= 2) end as rooms_activated_2plus_domains,
  now() >= w.we as week_complete
from weeks w
order by w.week;

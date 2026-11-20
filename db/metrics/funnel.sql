-- bot-link v1 · the funnel for one window (KILL-CRITERIA.md): sign-ups → rooms → invites → requests → approvals →
-- first messages → rooms between people → idle answers, plus the cross-domain share and the week after. Metadata only,
-- counts only: never an email address or a domain name. Read-only.
--
--   launch week:  psql "$BOTLINK_DATABASE_URL" -v since='2026-11-24 15:00+00' -v until='2026-12-01 15:00+00' -f db/metrics/funnel.sql
--   day 30:       psql "$BOTLINK_DATABASE_URL" -v since='2026-11-24 15:00+00' -v until='2026-12-24 15:00+00' -f db/metrics/funnel.sql
--
-- The window is [since, until). "Window rooms" are rooms created inside it (our own earlier test rooms don't count);
-- every room step below counts window rooms only, so the steps narrow like a funnel. A conversation message is scope
-- member or room, no join hellos, no self-tests (room_week_senders, migration 0020).
--
-- Columns
--   signups                       accounts created in the window
--   rooms_created                 window rooms
--   person_invites_made           person invites (one person inviting another into a room) made in window rooms
--   person_requests               people who used such an invite (asked to come in)
--   people_approved               of those, approved by the room's owner inside the window
--   chat_join_requests            chats asking to join a window room (join requests, kind join)
--   chat_joins_approved           approved inside the window
--   rooms_first_message           window rooms with a conversation message before `until`
--   rooms_2plus_people            window rooms whose chats (joined before `until`) belong to 2+ people
--   rooms_between_people          window rooms where the chats of 2+ people sent messages before `until`
--   rooms_between_people_2plus_domains
--                                 of those, rooms whose people span 2+ email domains (strict: two gmail.com addresses
--                                 are one domain)
--   rooms_between_people_2plus_domains_split_freemail
--                                 the same, a free-mail address counting as its own domain (metric_org, 0020)
--   cross_domain_pct              100 * rooms_between_people_2plus_domains / rooms_between_people (NULL when 0)
--   rooms_idle_answer             THE ONE NUMBER: window rooms where chats of two people exchanged messages and one
--                                 answered while idle inside the window (metric_answers, the rule of launch.sql). NULL
--                                 when `since` is more than 30 days ago (messages are deleted after 30 days).
--   back_next_week                of rooms_between_people, rooms with a conversation message in [until, until + 7 days);
--                                 NULL until that week has passed
--   back_next_week_pct            100 * back_next_week / rooms_between_people
with p as (
  select :'since'::timestamptz as t0, :'until'::timestamptz as t1
),
wr as (
  select r.id from rooms r, p where r.created_at >= p.t0 and r.created_at < p.t1
),
firsts as ( -- each person's first send in each window room, before until
  select s.room_id, s.account_id, min(s.first_at) as first_at
  from room_week_senders s join wr on wr.id = s.room_id, p
  where s.first_at < p.t1
  group by s.room_id, s.account_id
),
shape as ( -- window rooms' people (chats joined before until)
  select m.room_id, count(distinct m.account_id) as people,
         count(distinct split_part(a.email, '@', 2)) as domains, count(distinct metric_org(a.email)) as orgs
  from members m join wr on wr.id = m.room_id join accounts a on a.id = m.account_id, p
  where m.joined_at < p.t1
  group by m.room_id
),
between_rooms as (
  select f.room_id from firsts f group by f.room_id having count(*) >= 2
)
select
  (select t0 from p) as since,
  (select t1 from p) as until,
  (select count(*) from accounts a, p where a.created_at >= p.t0 and a.created_at < p.t1) as signups,
  (select count(*) from wr) as rooms_created,
  (select count(*) from invites i join wr on wr.id = i.room_id, p
     where i.kind = 'person' and i.created_at >= p.t0 and i.created_at < p.t1) as person_invites_made,
  (select count(*) from person_requests pr join wr on wr.id = pr.room_id, p
     where pr.created_at >= p.t0 and pr.created_at < p.t1) as person_requests,
  (select count(*) from person_requests pr join wr on wr.id = pr.room_id, p
     where pr.status = 'approved' and pr.decided_at >= p.t0 and pr.decided_at < p.t1) as people_approved,
  (select count(*) from join_requests j join wr on wr.id = j.room_id, p
     where j.kind = 'join' and j.created_at >= p.t0 and j.created_at < p.t1) as chat_join_requests,
  (select count(*) from join_requests j join wr on wr.id = j.room_id, p
     where j.kind = 'join' and j.status = 'approved' and j.decided_at >= p.t0 and j.decided_at < p.t1) as chat_joins_approved,
  (select count(distinct f.room_id) from firsts f) as rooms_first_message,
  (select count(*) from shape where people >= 2) as rooms_2plus_people,
  (select count(*) from between_rooms) as rooms_between_people,
  (select count(*) from between_rooms b join shape s on s.room_id = b.room_id where s.domains >= 2) as rooms_between_people_2plus_domains,
  (select count(*) from between_rooms b join shape s on s.room_id = b.room_id where s.orgs >= 2)
     as rooms_between_people_2plus_domains_split_freemail,
  (select case when count(*) = 0 then null
               else round(100.0 * count(*) filter (where s.domains >= 2) / count(*), 1) end
     from between_rooms b join shape s on s.room_id = b.room_id) as cross_domain_pct,
  (select case when p.t0 < now() - interval '30 days' then null
               else (select count(distinct ma.room_id) from metric_answers(p.t0, p.t1) ma join wr on wr.id = ma.room_id where ma.idle) end
     from p) as rooms_idle_answer,
  (select case when now() < p.t1 + interval '7 days' then null
               else (select count(*) from between_rooms b where exists (
                       select 1 from room_week_senders s where s.room_id = b.room_id
                         and s.last_at >= p.t1 and s.first_at < p.t1 + interval '7 days')) end
     from p) as back_next_week,
  (select case when now() < p.t1 + interval '7 days' or (select count(*) from between_rooms) = 0 then null
               else round(100.0 * (select count(*) from between_rooms b where exists (
                       select 1 from room_week_senders s where s.room_id = b.room_id
                         and s.last_at >= p.t1 and s.first_at < p.t1 + interval '7 days'))
                    / (select count(*) from between_rooms), 1) end
     from p) as back_next_week_pct;

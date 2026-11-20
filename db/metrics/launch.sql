-- bot-link v1 · launch numbers (LAUNCH-PLAN §4) as ONE saved query. Metadata only: the server stores no message text,
-- and this query reads no envelope column. Read-only; safe to run against prod with a read-only role.
--
--   psql "$BOTLINK_DATABASE_URL" -v since='2026-11-17 15:00+00' -f deploy/metrics.sql   (includes this file)
--   psql "$BOTLINK_DATABASE_URL" -v since='2026-11-17 15:00+00' -f db/metrics/launch.sql
--   (psql -x for one column per line)
--
-- :'since' = the launch moment (the HN post). The window is [since, since + 7 days).
--
-- Scope: "launch rooms" = rooms created inside the window (so our own pre-launch test rooms don't count; to drop
-- internal accounts created after launch too, add `and a.email not like '%@yourdomain'` where accounts are joined).
-- A member counts for a room if it joined before the window ended, even if it left later.
--
-- Columns
--   approved_joins            join requests (kind join) approved inside the window, any room
--   launch_rooms              rooms created inside the window
--   rooms_2plus_people        launch rooms with chats (members) of 2+ different accounts
--   rooms_2plus_apps          launch rooms with chats from 2+ apps (app, or app_name for app = 'other': OpenCode ≠ T3 Code)
--   median_msgs_two_person_room_first_7d
--                             median over rooms_2plus_people of the messages sent in each room's own first 7 days
--                             (rooms with 0 messages count as 0). Messages = scope member|room, no join hellos (intro),
--                             no self-tests (scope self).
--   day7_retention_pct        two-person launch rooms with a message in the window AND a message on days 7..13 after
--                             since, as a % of those with a message in the window. NULL until since + 14 days has passed.
--   rooms_between_people      THE ONE NUMBER (target 40, alarm < 10). See below.
--   rooms_between_people_any_answer
--                             same, without the "while idle" condition (diagnostic: people talk, but wakes don't work?)
--
-- THE ONE NUMBER: a launch room where chats of two different people exchanged messages and at least one answered while
-- idle, inside the window. Approximated from metadata as: some message M (inside the window) from member A to member B
-- (B has a copy of M: a deliveries row), A.account <> B.account, and B answered: B sent a message R into the same room
-- within 24 h after M (and inside the window) that is either a reply to M (R.in_reply_to = M.id; set by the `reply`
-- tool) or has a copy for A. "While idle" is approximated per copy, from what the server observed for B's copy of M:
--   (a) deliveries.wakes > 0: a wake path counted a wake for that copy before it was read. Bumped by `POST /me/wait`
--       (watch resuming the chat, a listener's command) and by an accepted bot-link Event (SPEC §6.13; 0010);
--   (b) push_jobs(B, M) done and not failed: B is always_on and its server accepted the push;
--   (c) members.wake_verified_at of B falls between M and R: some copy was shown to B by a woken run (ack woken: true,
--       e.g. Claude Code's idle Stop waiter, which leases instead of calling wait) in that interval (0006 / 0008).
-- Limits of the approximation: (c) keeps only the latest woken read per member, so an earlier idle answer can be
-- overwritten by a later wake outside [M, R] (undercount); a wake counted while the chat was in fact open and the human
-- then answered counts as idle (overcount, small: watch skips live sessions). Messages are deleted after 30 days and
-- event_jobs after 2 days (sweeper), so run this within 30 days of since; (a) does not depend on event_jobs.
with p as (
  select :'since'::timestamptz as t0,
         :'since'::timestamptz + interval '7 days' as t7,
         :'since'::timestamptz + interval '14 days' as t14
),
launch_rooms as (
  select r.id, r.created_at from rooms r, p where r.created_at >= p.t0 and r.created_at < p.t7
),
msgs as ( -- conversation messages only
  select m.id, m.room_id, m.from_member, m.in_reply_to, m.created_at
  from messages m where m.scope in ('member', 'room') and not m.intro
),
room_members as (
  select mb.room_id, mb.account_id, case when mb.app = 'other' then coalesce('other:' || lower(mb.app_name), 'other') else mb.app end as app
  from members mb join launch_rooms lr on lr.id = mb.room_id, p
  where mb.joined_at < p.t7
),
shape as (
  select room_id, count(distinct account_id) as people, count(distinct app) as apps from room_members group by room_id
),
two_person as (
  select lr.id, lr.created_at from launch_rooms lr join shape s on s.room_id = lr.id where s.people >= 2
),
two_person_msgs as (
  select tp.id, count(m.id) as n_first_7d
  from two_person tp left join msgs m on m.room_id = tp.id and m.created_at < tp.created_at + interval '7 days'
  group by tp.id
),
retention as (
  select count(*) filter (where wk1) as active_week1, count(*) filter (where wk1 and wk2) as active_both
  from (
    select tp.id,
           exists (select 1 from msgs m where m.room_id = tp.id and m.created_at >= p.t0 and m.created_at < p.t7) as wk1,
           exists (select 1 from msgs m where m.room_id = tp.id and m.created_at >= p.t7 and m.created_at < p.t14) as wk2
    from two_person tp, p
  ) x
),
answered as ( -- (room, idle?) for every cross-person message B answered
  select m.room_id,
         (d.wakes > 0
          or exists (select 1 from push_jobs pj where pj.message_id = m.id and pj.member_id = b.id and pj.done and not pj.failed)
          or (b.wake_verified_at >= m.created_at and b.wake_verified_at <= r.created_at)) as idle
  from msgs m
  join launch_rooms lr on lr.id = m.room_id
  join members a on a.id = m.from_member
  join deliveries d on d.message_id = m.id
  join members b on b.id = d.member_id
  join msgs r on r.room_id = m.room_id and r.from_member = b.id and r.created_at > m.created_at
  cross join p
  where m.created_at >= p.t0 and m.created_at < p.t7
    and r.created_at < least(m.created_at + interval '24 hours', p.t7)
    and a.account_id <> b.account_id
    and (r.in_reply_to = m.id or exists (select 1 from deliveries rd where rd.message_id = r.id and rd.member_id = a.id))
)
select
  (select t0 from p) as since,
  (select t7 from p) as until,
  (select count(*) from join_requests j, p where j.kind = 'join' and j.status = 'approved'
     and j.decided_at >= p.t0 and j.decided_at < p.t7) as approved_joins,
  (select count(*) from launch_rooms) as launch_rooms,
  (select count(*) from shape where people >= 2) as rooms_2plus_people,
  (select count(*) from shape where apps >= 2) as rooms_2plus_apps,
  (select percentile_cont(0.5) within group (order by n_first_7d) from two_person_msgs) as median_msgs_two_person_room_first_7d,
  (select case when now() < p.t14 or r.active_week1 = 0 then null
               else round(100.0 * r.active_both / r.active_week1, 1) end from retention r, p) as day7_retention_pct,
  (select count(distinct room_id) from answered where idle) as rooms_between_people,
  (select count(distinct room_id) from answered) as rooms_between_people_any_answer;

-- bot-link v1 · 0005_app_name_presence (owner: server). Live bugs 2026-11-06 (items 5 + 7).
-- 1. app_name: which app a chat runs in when it isn't Claude Code / Codex / Cursor (OpenCode, T3 Code, …). Unsigned
--    display data like job / folder / machine: the signed roster keeps app ∈ {claude-code, codex, cursor, other}
--    (ENVELOPE §5.2), because a new enum value there would make every deployed client reject the room's member list.
--    The joining client sends it (detected, or the model's own answer); the server only bounds it.
alter table join_requests add column app_name text check (app_name is null or (app = 'other' and char_length(app_name) between 1 and 40
  and app_name !~ '[[:cntrl:]]'));
alter table members add column app_name text check (app_name is null or (app = 'other' and char_length(app_name) between 1 and 40
  and app_name !~ '[[:cntrl:]]'));

-- 2. presence (SPEC §6.9): a member is "listening now" while its chat makes any inbox / wait / presence call within
--    90 s. presence_live is the flag the dashboard shows; it flips on a call (false → true) and in the sweeper
--    (true → false after 90 s). Only a flip NOTIFYs the room's people, never each heartbeat.
alter table members add column last_seen_at timestamptz;
alter table members add column presence_live boolean not null default false;

create function notify_presence() returns trigger language plpgsql as $$
declare acct uuid;
begin
  for acct in select account_id from room_people where room_id = new.room_id and removed_at is null loop
    perform pg_notify('bl_dash', acct::text);
  end loop;
  return null;
end $$;
create trigger members_presence_notify after update of presence_live on members
  for each row when (old.presence_live is distinct from new.presence_live) execute function notify_presence();

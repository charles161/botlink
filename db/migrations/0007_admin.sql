-- bot-link v1 · 0007_admin (owner: server). Release r2 item 7: the owner-only, read-only admin area (/admin).
-- 1. web_sessions.admin_until: an admin (BOTLINK_ADMIN_EMAILS) who passed the human check has the admin area open in
--    THIS session until this time (30 min). In Postgres, not memory, so every server copy agrees (SPEC §8).
-- 2. human_checks gains the action 'admin' (no target): the challenge that unlocks it, issued only behind the admin
--    gate (POST /app/v1/admin/human-check), consumed in the unlock transaction like an approve's.
alter table web_sessions add column admin_until timestamptz;

alter table human_checks drop constraint if exists human_checks_action_check;
alter table human_checks add constraint human_checks_action_check check (action in
  ('approve_join','approve_person','approve_device','webauthn_register','admin'));
alter table human_checks drop constraint if exists human_checks_check;
alter table human_checks add constraint human_checks_check check ((action in ('webauthn_register','admin')) = (target_id is null));

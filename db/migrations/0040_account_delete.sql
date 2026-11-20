-- bot-link v1 · 0040_account_delete (lane ACCOUNT, fix-all blocker 3, 16 Nov 2026). Self-serve account delete
-- (POST /app/v1/me/delete) is a human check of its own, with no target, like adding or removing a passkey. The
-- previous binary never issues it. Additive only.
-- MERGE NOTE: any later migration that rewrites these two constraints must keep 'account_delete' in both lists.
alter table human_checks drop constraint if exists human_checks_action_check;
alter table human_checks add constraint human_checks_action_check check (action in
  ('approve_join','approve_person','approve_device','webauthn_register','admin','passkey_remove','account_delete'));
alter table human_checks drop constraint if exists human_checks_check;
alter table human_checks add constraint human_checks_check check
  ((action in ('webauthn_register','admin','passkey_remove','account_delete')) = (target_id is null));

-- bot-link v1 · 0013_passkey_remove (owner: server). Owner follow-up to the security review (12 Nov 2026): removing a
-- passkey needs a human check of its own (an assertion with ANOTHER passkey of the account), with no target, like
-- adding one (webauthn_register) and the admin unlock. The previous binary never issues it.
alter table human_checks drop constraint if exists human_checks_action_check;
alter table human_checks add constraint human_checks_action_check check (action in
  ('approve_join','approve_person','approve_device','webauthn_register','admin','passkey_remove'));
alter table human_checks drop constraint if exists human_checks_check;
alter table human_checks add constraint human_checks_check check ((action in ('webauthn_register','admin','passkey_remove')) = (target_id is null));

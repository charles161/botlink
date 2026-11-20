-- bot-link v1 · 0055_approve_joins (lane BATCH-SERVER; SPEC §6.4 step 7a, docs/protocol/join-and-approval.md §4a). A
-- person ticks up to 5 waiting chats of one room and approves them with one human check. The check names the room
-- (target_id) and is bound to exactly the ticked set of join request ids.
-- 1. human_checks.targets_digest: sha256 of the sorted, lower-case request ids (humancheck.TargetsDigest), set for
--    'approve_joins' only and for every such check. Adding a nullable column with no default rewrites nothing.
-- 2. human_checks gains the action 'approve_joins' (target: the room). MERGE NOTE: keep every action of 0053, 0042 and
--    0040. Additive: the previous binary never writes it. The rewrite and the new check read human_checks' rows under
--    its lock; the sweeper keeps that table to the checks of the last few minutes.
-- The lock_timeout makes this fail fast (the deploy stops before the switch) instead of queueing every human check
-- behind a long transaction that holds the table.
set local lock_timeout = '3s';
alter table human_checks add column targets_digest bytea;

alter table human_checks drop constraint if exists human_checks_action_check;
alter table human_checks add constraint human_checks_action_check check (action in
  ('approve_join','approve_person','approve_device','webauthn_register','admin','passkey_remove',
   'device_remove','passkey_reset_cancel','passkey_reset_finish','account_delete','confirm_room','approve_joins'));

alter table human_checks add constraint human_checks_targets_digest_check check
  ((action = 'approve_joins') = (targets_digest is not null) and (targets_digest is null or length(targets_digest) = 32));

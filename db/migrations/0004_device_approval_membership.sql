-- bot-link v1 · 0004_device_approval_membership (owner: server). Founder requests items 1 and 3.
-- 1. devices.approved_at: a browser a human approved (certify with a human check), or the account's first browser.
--    New rooms add every approved browser right after genesis (SPEC §6.2), so a second browser approved once can
--    sign in rooms created later. A browser that was never approved (registered before the account had rooms, or
--    one that only signs in rooms it created itself) is NOT approved and is never auto-added.
-- 2. attention kinds member_joined / member_left: membership changes are security events every person in the
--    room sees on the dashboard immediately (SPEC §6.10a).
alter table devices add column approved_at timestamptz;

-- Backfill: a browser that already signs in a room it didn't create, or that was the account's first browser.
update devices d set approved_at = d.created_at
where d.revoked_at is null and (
  not exists (select 1 from devices e where e.account_id = d.account_id and e.created_at < d.created_at)
  or exists (select 1 from room_signers s where s.ed25519_pk = d.ed25519_pk and s.added_seq > 0 and s.removed_seq is null)
);

alter table attention drop constraint attention_kind_check;
alter table attention add constraint attention_kind_check
  check (kind in ('stuck','needs_you','cannot_wake','new_device','member_joined','member_left'));

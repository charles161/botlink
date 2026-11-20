-- bot-link v1 · 0002_server_indexes (owner: server). Indexes only; no contract change.
-- Lookups the server does per member/state that 0001's partial indexes don't cover.

-- stuck copies per member (roster "stuck" flag, unstick, rekey → needs_resend)
create index deliveries_stuck on deliveries (member_id) where state = 'stuck';
-- needs_resend / stuck / queued copies of one member with an old key epoch (rekey)
create index deliveries_member_epoch on deliveries (member_id, key_epoch) where state in ('queued','stuck');
-- activity log and retention by sender
create index messages_from on messages (from_member);
-- open attention per member subject (resolve on remove / unstick)
create index attention_subject_open on attention (subject_id) where resolved_at is null;
-- person requests per room (needs-you for owners)
create index person_requests_room_pending on person_requests (room_id) where status = 'pending';
-- pending join requests per room (cap of 10)
create index join_requests_room_pending on join_requests (room_id) where status = 'pending';

-- WebAuthn: authenticator flags (backup eligible/state) must be stored to validate later assertions.
alter table webauthn_credentials add column flags smallint not null default 0;

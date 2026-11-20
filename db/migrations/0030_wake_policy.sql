-- bot-link v1 · 0030_wake_policy (lane F, 2026-11-12). The client holds another person's message while no human is
-- with the chat (SPEC §7.3a), but the server still woke the chat for it: one model turn each time, on the recipient's
-- account, caused by someone else. A member's client now declares its wake policy ("other people's chats do not wake
-- me, except these members"); quietFor then makes such a copy no_wake. Only members that declared it are affected:
-- old clients keep today's behaviour.
--   wake_policies          one row per member that declared it; applies only while the member keeps the key it had
--                          when it declared (a chat that takes the member over with a new key declares again)
--   deliveries.wake_held   this copy did not wake its chat because the recipient holds other people's messages
--                          (what the send response reported to the sender; never set for a mute alone)
-- Additive only: the previous binary keeps working on this schema (it never reads either).
create table if not exists wake_policies (
  member_id       uuid primary key references members (id) on delete cascade,
  key_epoch       int not null,
  except_members  uuid[] not null default '{}',   -- members of the room that may still wake it (its human's "while away")
  since           timestamptz not null default now(),   -- when this key's policy started holding
  updated_at      timestamptz not null default now()
);

alter table deliveries add column if not exists wake_held boolean not null default false;

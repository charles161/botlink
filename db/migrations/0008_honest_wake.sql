-- bot-link v1 · 0008_honest_wake (owner: server). Release r3 "honest wake" (founder live bug 2026-11-06: a Codex
-- desktop chat was promised idle delivery and shown "listening now" though nothing could wake it: join sets
-- up a wake path and runs a wake test). Additive only: the r2 binary keeps working on this schema until it restarts.
-- 1. messages.intro: the join hello a client sends to the room by itself (SPEC §6.4a). Plaintext metadata the server
--    acts on: intro copies never count as a wake (wait), never make an idle waiter fire, never produce an
--    expired_unread notice; they ride along with the recipient's next batch. Old clients never send it: false.
alter table messages add column if not exists intro boolean not null default false;

-- 2. deliveries.not_before: the wake test (SPEC §6.4a) is held back for a few seconds so the joining chat's turn can
--    end first; until then the copy is invisible to lease, wait and count. Null (every other copy): due now.
alter table deliveries add column if not exists not_before timestamptz;

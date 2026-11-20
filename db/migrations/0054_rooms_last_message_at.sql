-- bot-link v1 · 0054_rooms_last_message_at (lane LASTMSG, 17 Nov 2026). The rooms home shows "Last message 5 min ago"
-- per room. rooms.last_message_at: when the server accepted the newest conversation message of the room (scope member
-- or room, not a join hello: the messages room_week_senders counts, 0020). Set by POST /api/v1/messages in the
-- transaction that accepts the message; it only moves forward. Room level only: no sender, no count, no per-member state.
-- A nullable column with no default changes only the catalog (no table rewrite, no scan). No backfill: a room that
-- exists shows its time once its next message passes. The lock_timeout makes this fail fast instead of queueing every
-- request on rooms behind a long transaction that holds it.
-- Additive: the previous binary never reads or writes it.
set local lock_timeout = '3s';
alter table rooms add column if not exists last_message_at timestamptz;

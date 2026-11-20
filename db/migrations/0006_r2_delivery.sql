-- bot-link v1 · 0006_r2_delivery (owner: server). Release r2 ("after the join, it just works"), onboarding feedback
-- 2026-11-06 items 4-6. CONTRACT-CHANGES 2026-11-06 · R2.
-- 1. messages.quiet: the sender marked the message as needing no answer (intent fyi: intros, notes). Plaintext
--    metadata the server can act on (the intent itself stays sealed). Quiet copies never make a Stop hook block a
--    turn and never wake an idle chat on their own (wait/lease with urgent_only skip them); they ride along with the
--    next batch. Old clients never send it: false.
alter table messages add column quiet boolean not null default false;

-- 2. scope 'self': a member's self-test (SPEC §6.4a): a message from the member to itself, sealed to its own key,
--    that has to travel the real path (queued → woken → shown) before the chat promises idle delivery. Never in the
--    room's activity, never counted as a send.
alter table messages drop constraint messages_scope_check;
alter table messages add constraint messages_scope_check check (scope in ('member','room','self'));
alter table messages drop constraint messages_check;
alter table messages add constraint messages_check check ((scope in ('member','self')) = (to_member is not null));
alter table messages add constraint messages_self_check check (scope <> 'self' or to_member = from_member);

-- 3. presence from real behaviour (SPEC §6.9): wake_verified_at = the last time a copy was shown to this member's
--    chat by a woken run (watch resume, listener command, Claude Code's idle waiter) or within 3 minutes of a wake
--    counting it. "wakes in seconds" needs it; a listener alone is "listener on · wake not checked yet".
alter table members add column wake_verified_at timestamptz;

-- 4. self_label: what the member says about its own availability ("always on, server chat"), ≤ 60 characters,
--    unsigned display data like job: shown next to the computed label, never instead of it.
alter table members add column self_label text check (self_label is null or (char_length(self_label) between 1 and 60
  and self_label !~ '[[:cntrl:]]'));

-- 5. match codes are 6 characters (item 9): ~30 bits instead of 20 against a lookalike join request. Shown
--    grouped as K7Q-2MX; stored without the dash. Requests still pending from before keep their 4-character code.
alter table join_requests drop constraint join_requests_match_code_check;
alter table join_requests add constraint join_requests_match_code_check
  check (match_code ~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$' or match_code ~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$');

-- bot-link v1 · 0009_claim_approval (owner: server). Critical fix H1 (a field test 2026-11-07, T10): moving a member
-- to another chat on the same computer needs the person's approval in the browser, like a move to a new computer.
-- Additive only: the previous binary keeps working on this schema until it restarts.
-- join_requests.move_to: for kind = 'claim', where the member moves: 'chat' (another chat on the same computer, made
-- with the member's own key by POST /api/v1/me/claim) or 'machine' (a new computer, made with an invite). Null: a join,
-- or a claim request made before this migration (always a new computer).
alter table join_requests add column if not exists move_to text check (move_to is null or move_to in ('chat', 'machine'));

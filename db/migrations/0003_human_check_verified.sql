-- bot-link v1 · 0003_human_check_verified (owner: server). FINDINGS F6.
-- A human check that passed its outside checks (Turnstile, WebAuthn) is marked verified, so the dashboard can retry
-- the SAME approve after 409 roster_conflict (re-sign at the new head) without asking the person again: a Turnstile
-- token is single-use at Cloudflare and a WebAuthn assertion can't be replayed. The proof stays single-use
-- (used_at is still set inside the approve transaction) and bound to the same session, account, action and target.
alter table human_checks add column verified_at timestamptz;

-- bot-link v1 · 0043_reset_browser_passkey_place (owner: server). Security review of fix-all (16 Nov 2026), lane RECOVER.
-- 1. passkey_resets.browser_hash: a reset belongs to the BROWSER that asked (sha256 of a random token kept in an
--    HttpOnly cookie there), not to one sign-in: after the 72 h wait that browser signs in again (a new session) and
--    finishes; no other browser can, however fresh its sign-in.
-- 2. Where a passkey lives, as far as the server can tell: the browser key the sign-in said it uses
--    (web_sessions.device_id, declared by the dashboard; a hint, never a permission) and its user agent, recorded when
--    a passkey is made and each time it answers. Removing a browser offers to remove the passkeys made or last used
--    there. Passkeys made before this have no record.
-- 3. accounts.had_passkey_at: an account that ever had a passkey never falls back to "a fresh sign-in instead of a
--    passkey", even if it somehow has none left; it needs a reset.
-- Additive only: the previous binary ignores these columns.

alter table passkey_resets add column browser_hash bytea check (browser_hash is null or length(browser_hash) = 32);

alter table web_sessions add column device_id uuid;

alter table webauthn_credentials
  add column created_device_id uuid,
  add column created_user_agent text not null default '' check (length(created_user_agent) <= 300),
  add column last_used_device_id uuid,
  add column last_used_user_agent text not null default '' check (length(last_used_user_agent) <= 300);

alter table accounts add column had_passkey_at timestamptz;
update accounts a set had_passkey_at = c.first from
  (select account_id, min(created_at) as first from webauthn_credentials group by account_id) c
  where c.account_id = a.id and a.had_passkey_at is null;

-- 4. human_checks.credential_id: the passkey that answered a check, kept with it, so a removal retried with the same
--    check (a member-list conflict) still knows which passkey it must never remove.
alter table human_checks add column credential_id bytea;

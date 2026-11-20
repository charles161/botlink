-- bot-link v1 · 0052_account_wait_guards (fix-all, last builder; third security pass at 9f90062).
-- 1. A pending account delete is cancelled by itself when a browser of the account is removed or when "sign out other
--    browsers" is used (either one means something is wrong; the person can ask again after a pause).
-- 2. account_events: "sign out other browsers" is recorded (signed_out_others), and so is removing a passkey that was
--    the account's first one from a sign-in made before it (first_passkey_removed, its first 72 h only).
-- MERGE NOTE: keep every kind of 0049 and every cancelled_by of 0041. Additive only: the previous binary never
-- writes the new values.
alter table account_deletes drop constraint if exists account_deletes_cancelled_by_check;
alter table account_deletes add constraint account_deletes_cancelled_by_check check (cancelled_by in
  ('session', 'passkey', 'passkey_reset', 'lapsed', 'browser_removed', 'signed_out'));
alter table account_events drop constraint if exists account_events_kind_check;
alter table account_events add constraint account_events_kind_check check (kind in
  ('passkey_reset_started', 'passkey_reset_cancelled', 'passkey_reset_completed', 'device_removed',
   'account_delete_asked', 'account_delete_cancelled', 'account_delete_finished',
   'signed_out_others', 'first_passkey_removed'));

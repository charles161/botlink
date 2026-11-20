-- bot-link v1 · 0049_account_delete_events (lane ACCOUNT, with 0041). Asking, cancelling and finishing an account
-- delete are recorded in account_events (lane RECOVER's table, 0042). This widens its kinds; it has to run after
-- 0042, which a 0041 file cannot (versions apply in name order). Additive only.
-- MERGE NOTE: any later migration that rewrites account_events_kind_check must keep these kinds.
alter table account_events drop constraint if exists account_events_kind_check;
alter table account_events add constraint account_events_kind_check check (kind in
  ('passkey_reset_started', 'passkey_reset_cancelled', 'passkey_reset_completed', 'device_removed',
   'account_delete_asked', 'account_delete_cancelled', 'account_delete_finished'));

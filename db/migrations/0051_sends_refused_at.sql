-- bot-link v1 · 0051_sends_refused_at (fix-all, last builder; security re-review, migration hygiene). 0047 gained this
-- column after an earlier 0047 existed on a branch; a database that ran the earlier 0047 never got it, and every send
-- would then fail. Adding it again here, idempotently, removes that doubt. 0047 is left as it is.
alter table accounts add column if not exists sends_refused_at timestamptz;

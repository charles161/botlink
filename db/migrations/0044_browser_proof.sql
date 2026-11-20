-- bot-link v1 · 0044_browser_proof (owner: server). Re-review of fix-all (16 Nov 2026), lane RECOVER.
-- A sign-in's browser label (web_sessions.device_id, migration 0043) was a bare claim: a thief's session on a stolen
-- laptop could claim the person's own browser, and passkeys it then added showed as "made in this browser". From now
-- on a label needs proof: a single-use challenge (5 minutes, bound to the session that asked) signed with that
-- browser's own device key (context "botlink-browser-proof-v1"). Labels and passkey places recorded from the
-- unproved claims are dropped: those passkeys show as "place unknown".

create table browser_proofs (
  id            uuid primary key,
  session_hash  bytea not null references web_sessions (token_hash) on delete cascade,
  challenge     bytea not null check (length(challenge) = 32),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  used_at       timestamptz
);
create index browser_proofs_session on browser_proofs (session_hash);

update web_sessions set device_id = null where device_id is not null;
update webauthn_credentials set created_device_id = null, last_used_device_id = null
  where created_device_id is not null or last_used_device_id is not null;

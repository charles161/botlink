-- bot-link v1 · 0046_account_storage (owner: fix-all lane LIMITS, blocker 8). Bytes each account has stored on the
-- server, so one account cannot fill the disk.
--
-- What counts: every copy of a message (a deliveries row) is charged to the account of the member who SENT it: 256
-- bytes for the row while it exists (row, indexes, its share of the message row; kept until the message is deleted
-- after 30 days) plus the sealed copy's bytes while the server still holds them. The sender decides how much is
-- stored (size, count and fan-out), and charging the reader would let anyone fill a stranger's quota.
--
-- How it is counted: triggers on deliveries, so every path that adds, empties or deletes a copy is counted (send,
-- self-test, reply, read and purge, expiry, rekey, member removal, room and message deletion), also by the previous
-- binary. A trigger only appends a signed delta to account_storage_log (no row is updated, so two transactions that
-- touch two accounts in opposite order can never deadlock on a counter). The sweeper folds the log into
-- account_storage once a minute. Bytes used = account_storage.bytes + the sum of the account's pending deltas.

alter table deliveries add column if not exists charge_account uuid;  -- nullable, no default: no table rewrite

create table if not exists account_storage (
  account_id  uuid primary key,
  bytes       bigint not null default 0,
  updated_at  timestamptz not null default now()
);

create table if not exists account_storage_log (
  account_id  uuid not null,
  delta       bigint not null,
  at          timestamptz not null default now()
);
create index if not exists account_storage_log_account on account_storage_log (account_id);

-- Copies stored before this migration are NOT charged (security review finding 4: a backfill rewrote every row
-- under the migration's exclusive lock while the old binary served). Their charge_account stays NULL, every trigger
-- and query below skips NULL, and they leave within 30 days through the existing sweep. Until then the counters
-- undercount by exactly those copies. Adding the nullable column without a default changes only the catalog.

create or replace function deliveries_storage_charge() returns trigger language plpgsql as $$
begin
  if new.charge_account is null then
    select mb.account_id into new.charge_account
      from messages m join members mb on mb.id = m.from_member where m.id = new.message_id;
  end if;
  return new;
end $$;

create or replace function deliveries_storage_log() returns trigger language plpgsql as $$
declare
  d bigint;
begin
  if tg_op = 'INSERT' then
    if new.charge_account is not null then
      insert into account_storage_log (account_id, delta) values (new.charge_account, 256 + coalesce(octet_length(new.envelope), 0));
    end if;
  elsif tg_op = 'DELETE' then
    if old.charge_account is not null then
      insert into account_storage_log (account_id, delta) values (old.charge_account, -(256 + coalesce(octet_length(old.envelope), 0)));
    end if;
  else
    d := coalesce(octet_length(new.envelope), 0) - coalesce(octet_length(old.envelope), 0);
    if d <> 0 and new.charge_account is not null then
      insert into account_storage_log (account_id, delta) values (new.charge_account, d);
    end if;
  end if;
  return null;
end $$;

drop trigger if exists deliveries_storage_charge on deliveries;
create trigger deliveries_storage_charge before insert on deliveries
  for each row execute function deliveries_storage_charge();
drop trigger if exists deliveries_storage_ins on deliveries;
create trigger deliveries_storage_ins after insert on deliveries
  for each row execute function deliveries_storage_log();
drop trigger if exists deliveries_storage_upd on deliveries;
create trigger deliveries_storage_upd after update of envelope on deliveries
  for each row when (old.envelope is distinct from new.envelope) execute function deliveries_storage_log();
drop trigger if exists deliveries_storage_del on deliveries;
create trigger deliveries_storage_del after delete on deliveries
  for each row execute function deliveries_storage_log();

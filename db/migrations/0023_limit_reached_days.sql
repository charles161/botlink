-- bot-link v1 · 0023_limit_reached_days (owner: lane D1). The first time an account goes over a plan limit on a UTC
-- day (count or block mode). One row per account, limit and day, so the analytics event limit_reached is sent at most
-- once per account, limit and day, by any server copy (the insert that creates the row sends it).
create table if not exists limit_reached_days (
  account_id  uuid not null references accounts (id) on delete cascade,
  limit_key   text not null check (limit_key in ('rooms','agents_per_room','people_per_room')),
  day         date not null,
  primary key (account_id, limit_key, day)
);

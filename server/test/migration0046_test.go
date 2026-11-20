package test

// Security review finding 4: migration 0046 must not rewrite deliveries (it runs in one transaction holding an
// exclusive lock while the old binary serves). Copies stored before it stay uncounted (charge_account NULL) and
// leave within 30 days through the normal sweep; reading and deleting them never drives a counter negative.

import (
	"context"
	"fmt"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	db "github.com/charles161/botlink/db"
	"github.com/charles161/botlink/server/internal/migrate"
	"github.com/charles161/botlink/server/internal/plans"
)

func TestMigration0046RewritesNoCopy(t *testing.T) {
	ctx := context.Background()
	name := fmt.Sprintf("bltest_m46_%d_%d", os.Getpid(), dbSeq.Add(1))
	if err := adminExec("create database " + name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = adminExec(fmt.Sprintf("drop database if exists %s with (force)", name)) })
	pool, err := pgxpool.New(ctx, clusterURL+"/"+name)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	ms, err := migrate.Load(db.Migrations)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `create table schema_migrations (version text primary key, applied_at timestamptz not null default now())`); err != nil {
		t.Fatal(err)
	}
	for _, m := range ms {
		if m.Version >= "0046" {
			break
		}
		if _, err := pool.Exec(ctx, m.SQL); err != nil {
			t.Fatalf("%s: %v", m.Version, err)
		}
		if _, err := pool.Exec(ctx, `insert into schema_migrations (version) values ($1)`, m.Version); err != nil {
			t.Fatal(err)
		}
	}
	// a database that already holds copies: 1 account, 1 room, 2 members, 300 messages, one copy each
	seed := `
	insert into accounts (id, email, display_name) values ('00000000-0000-7000-8000-000000000001', 'a@x.dev', 'A');
	insert into rooms (id, owner_account_id, name, genesis_hash) values ('00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-000000000001', 'r', decode(repeat('00', 32), 'hex'));
	insert into members (id, room_id, account_id, name, app, turn, ed25519_pk, x25519_pk) values
	  ('00000000-0000-7000-8000-0000000000b1', '00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-000000000001', 's', 'other', 'on_turn', decode(repeat('01', 32), 'hex'), decode(repeat('02', 32), 'hex')),
	  ('00000000-0000-7000-8000-0000000000b2', '00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-000000000001', 'r', 'other', 'on_turn', decode(repeat('03', 32), 'hex'), decode(repeat('04', 32), 'hex'));
	insert into messages (id, room_id, from_member, scope, to_member, request_hash, recipients, expires_at)
	  select gen_random_uuid(), '00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-0000000000b1', 'member',
	         '00000000-0000-7000-8000-0000000000b2', decode(repeat('05', 32), 'hex'), 1, now() + interval '1 day' from generate_series(1, 300);
	insert into deliveries (message_id, member_id, key_epoch, envelope, expires_at)
	  select id, '00000000-0000-7000-8000-0000000000b2', 1, repeat('e', 300), now() + interval '1 day' from messages;`
	if _, err := pool.Exec(ctx, seed); err != nil {
		t.Fatal(err)
	}
	snapshot := func() string {
		var s string
		if err := pool.QueryRow(ctx, `select string_agg(ctid::text || '/' || xmin::text, ',' order by seq) from deliveries`).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	before := snapshot()
	if _, err := migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if after := snapshot(); after != before {
		t.Fatal("migrations 0046+ rewrote rows of deliveries")
	}
	if n := count1(t, pool, `select count(*) from deliveries where charge_account is not null`); n != 0 {
		t.Fatalf("old copies charged: %d", n)
	}
	// the old copies are read, purged and deleted: nothing is logged, nothing goes negative
	for _, q := range []string{
		`update deliveries set state = 'shown', shown_at = now(), purge_after = now() where seq % 2 = 0`,
		`update deliveries set envelope = null where state = 'shown'`,
		`update deliveries set state = 'expired', envelope = null where state = 'queued' and seq % 3 = 0`,
		`delete from messages where id in (select message_id from deliveries where seq % 5 = 0)`,
	} {
		if _, err := pool.Exec(ctx, q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	if n := count1(t, pool, `select count(*) from account_storage_log`); n != 0 {
		t.Fatalf("old copies logged %d deltas", n)
	}
	if _, err := plans.CompactStorage(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if n := count1(t, pool, `select count(*) from account_storage where bytes < 0`); n != 0 {
		t.Fatal("a counter went negative")
	}
	if tot, err := plans.StorageUsedTotal(ctx, pool); err != nil || tot != 0 {
		t.Fatalf("total %d %v", tot, err)
	}
	// a copy stored after the migration is counted
	if _, err := pool.Exec(ctx, `insert into messages (id, room_id, from_member, scope, to_member, request_hash, recipients, expires_at)
	  values ('00000000-0000-7000-8000-0000000000c1', '00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-0000000000b1', 'member',
	          '00000000-0000-7000-8000-0000000000b2', decode(repeat('05', 32), 'hex'), 1, now() + interval '1 day');
	  insert into deliveries (message_id, member_id, key_epoch, envelope, expires_at)
	  values ('00000000-0000-7000-8000-0000000000c1', '00000000-0000-7000-8000-0000000000b2', 1, repeat('e', 300), now() + interval '1 day')`); err != nil {
		t.Fatal(err)
	}
	if tot, _ := plans.StorageUsedTotal(ctx, pool); tot != plans.StorageOverhead+300 {
		t.Fatalf("new copy: total %d", tot)
	}
}

func count1(t *testing.T, pool *pgxpool.Pool, sql string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), sql).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

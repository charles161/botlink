// Package migrate applies the embedded SQL migrations (db/migrations/*.sql) in order, each in one
// transaction, recording versions in schema_migrations. An advisory lock serialises copies starting at once.
package migrate

import (
	"context"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/charles161/botlink/db"
)

const lockKey = 7_316_220_001 // arbitrary, fixed

type Migration struct {
	Version string // file name without .sql, e.g. "0001_init"
	SQL     string
}

func Load(fsys fs.FS) ([]Migration, error) {
	ents, err := fs.ReadDir(fsys, "migrations")
	if err != nil {
		return nil, err
	}
	var out []Migration
	for _, e := range ents {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		b, err := fs.ReadFile(fsys, "migrations/"+e.Name())
		if err != nil {
			return nil, err
		}
		out = append(out, Migration{Version: strings.TrimSuffix(e.Name(), ".sql"), SQL: string(b)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Version < out[j].Version })
	return out, nil
}

// Up applies every pending embedded migration. Returns the versions applied now.
func Up(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	ms, err := Load(db.Migrations)
	if err != nil {
		return nil, err
	}
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `select pg_advisory_lock($1)`, int64(lockKey)); err != nil {
		return nil, err
	}
	defer conn.Exec(context.Background(), `select pg_advisory_unlock($1)`, int64(lockKey)) //nolint:errcheck
	if _, err := conn.Exec(ctx, `create table if not exists schema_migrations (
		version text primary key, applied_at timestamptz not null default now())`); err != nil {
		return nil, err
	}
	applied := map[string]bool{}
	rows, err := conn.Query(ctx, `select version from schema_migrations`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		applied[v] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var done []string
	for _, m := range ms {
		if applied[m.Version] {
			continue
		}
		err := pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, m.SQL); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, `insert into schema_migrations(version) values ($1)`, m.Version)
			return err
		})
		if err != nil {
			return done, fmt.Errorf("migration %s: %w", m.Version, err)
		}
		done = append(done, m.Version)
	}
	return done, nil
}

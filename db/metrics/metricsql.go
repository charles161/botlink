// Package metricsql runs the saved metrics queries (db/metrics/*.sql, the files people run with psql) from Go,
// for the admin metrics view (GET /app/v1/admin/metrics). The SQL files are the single source: psql variables
// (:'since', :'until') become $1, $2.
//
// Guarantees, each checked by server/internal/adminapi/metrics_test.go:
//   - every query runs in a READ ONLY transaction with a statement timeout, and is rolled back;
//   - a result may hold only numbers, booleans, times and NULL: a text value (an email address, a domain, a name)
//     is an error, never an answer;
//   - no query names a column that holds sealed text or keys.
package metricsql

import (
	"context"
	"embed"
	"fmt"
	"math/big"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed *.sql
var Files embed.FS

// Query names (file names without .sql).
const (
	Launch     = "launch"
	Weekly     = "weekly"
	Activation = "activation"
	Retention  = "retention"
	Funnel     = "funnel"
)

// Timeout bounds each query (they scan the whole history of small tables; seconds at launch scale).
const Timeout = 20 * time.Second

// Row is one result row: column name → int64 | float64 | bool | time.Time | nil.
type Row map[string]any

var (
	comment = regexp.MustCompile(`(?m)--.*$`)
	psqlVar = regexp.MustCompile(`:'[A-Za-z_]+'`)
)

// SQL returns the query with comments removed and psql variables turned into positional parameters, and the
// variables it needs, in order.
func SQL(name string) (string, []string, error) {
	b, err := Files.ReadFile(name + ".sql")
	if err != nil {
		return "", nil, err
	}
	q := comment.ReplaceAllString(string(b), "")
	var vars []string
	for i, v := range []string{"since", "until"} {
		tok := ":'" + v + "'"
		if strings.Contains(q, tok) {
			if len(vars) != i {
				return "", nil, fmt.Errorf("metrics %s: uses :'%s' without the variables before it", name, v)
			}
			vars = append(vars, v)
			q = strings.ReplaceAll(q, tok, fmt.Sprintf("$%d", i+1))
		}
	}
	if psqlVar.MatchString(q) || strings.Contains(q, `\`) {
		return "", nil, fmt.Errorf("metrics %s: unknown psql variable or meta-command", name)
	}
	return strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(q), ";")), vars, nil
}

// Run executes one saved query read-only. args are the values of its variables (since, until) in order.
func Run(ctx context.Context, pool *pgxpool.Pool, name string, args ...any) ([]Row, error) {
	q, vars, err := SQL(name)
	if err != nil {
		return nil, err
	}
	if len(args) != len(vars) {
		return nil, fmt.Errorf("metrics %s: needs %d values (%v), got %d", name, len(vars), vars, len(args))
	}
	return RunSQL(ctx, pool, name, q, args...)
}

// RunSQL runs one query the way Run does: read-only transaction, statement timeout, numbers only.
func RunSQL(ctx context.Context, pool *pgxpool.Pool, name, q string, args ...any) ([]Row, error) {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // read only: nothing to keep
	if _, err := tx.Exec(ctx, fmt.Sprintf("set local statement_timeout = %d", Timeout.Milliseconds())); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("metrics %s: %w", name, err)
	}
	defer rows.Close()
	fields := rows.FieldDescriptions()
	out := []Row{}
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return nil, err
		}
		r := make(Row, len(vals))
		for i, v := range vals {
			nv, err := number(v)
			if err != nil {
				return nil, fmt.Errorf("metrics %s: column %s: %w", name, fields[i].Name, err)
			}
			r[fields[i].Name] = nv
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// number keeps a value only if it is a number, a boolean, a time or NULL.
func number(v any) (any, error) {
	switch x := v.(type) {
	case nil:
		return nil, nil
	case bool, time.Time:
		return x, nil
	case int16:
		return int64(x), nil
	case int32:
		return int64(x), nil
	case int64:
		return x, nil
	case float32:
		return float64(x), nil
	case float64:
		return x, nil
	case pgtype.Numeric:
		if !x.Valid {
			return nil, nil
		}
		f, err := x.Float64Value()
		if err != nil || !f.Valid {
			return nil, fmt.Errorf("numeric value not representable")
		}
		return f.Float64, nil
	case *big.Int:
		f, _ := new(big.Float).SetInt(x).Float64()
		return f, nil
	}
	return nil, fmt.Errorf("a metrics query may return only numbers, booleans and times (got %T)", v)
}

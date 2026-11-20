package test

import (
	"context"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/charles161/botlink/server/internal/store"
)

// Every column of accounts, and every column elsewhere that names an account (an account_id, a reference to accounts,
// or "account" in its name), must be in store.AccountDeleteFate and store.AccountExportFate with a decision. A lane that
// adds one fails here until it says what delete and export do with it. "removed" entries must hold no row of a
// deleted account; "exported: <section>" entries must name a section the export has.
func TestAccountDataListed(t *testing.T) {
	w := newAcctWorld(t, paywallOn) // every section the export can have, so the paid tables' fates are checked too
	c := w.c
	rows, err := c.Pool.Query(context.Background(), `
		select distinct c.table_name || '.' || c.column_name from information_schema.columns c
		where c.table_schema = 'public' and (c.column_name like '%account%' or c.table_name = 'accounts'
		  or exists (select 1 from information_schema.key_column_usage k
		             join information_schema.constraint_column_usage u on u.constraint_name = k.constraint_name and u.table_schema = 'public'
		             join information_schema.table_constraints tc on tc.constraint_name = k.constraint_name and tc.constraint_type = 'FOREIGN KEY'
		             where k.table_schema = 'public' and k.table_name = c.table_name and k.column_name = c.column_name and u.table_name = 'accounts'))
		order by 1`)
	if err != nil {
		t.Fatal(err)
	}
	var cols []string
	for rows.Next() {
		var s string
		_ = rows.Scan(&s)
		cols = append(cols, s)
	}
	rows.Close()
	if len(cols) < 40 {
		t.Fatalf("schema query found only %d columns: %v", len(cols), cols)
	}
	live := map[string]bool{}
	fate := regexp.MustCompile(`^(removed|anonymised|kept)\b`)
	for _, col := range cols {
		live[col] = true
		if d, ok := store.AccountDeleteFate[col]; !ok || !fate.MatchString(d) {
			t.Errorf("%s: account delete does not say what it does with it (store.AccountDeleteFate)", col)
		}
		if e, ok := store.AccountExportFate[col]; !ok || !(strings.HasPrefix(e, "exported: ") || strings.HasPrefix(e, "not exported: ")) {
			t.Errorf("%s: account export does not say whether it carries it (store.AccountExportFate)", col)
		}
	}
	for _, m := range []map[string]string{store.AccountDeleteFate, store.AccountExportFate} {
		var stale []string
		for k := range m {
			if !live[k] {
				stale = append(stale, k)
			}
		}
		sort.Strings(stale)
		if len(stale) > 0 {
			t.Errorf("listed but not in the schema (remove or rename): %v", stale)
		}
	}

	// exported entries name a section the export really has
	ex := w.dana.Do("GET", "/app/v1/me/export", nil)
	if ex.Status != 200 {
		t.Fatalf("export: %s", ex)
	}
	sect := regexp.MustCompile(`^exported: ([a-z_]+)(?:\.([a-z_]+))?`)
	for col, e := range store.AccountExportFate {
		m := sect.FindStringSubmatch(e)
		if m == nil {
			continue
		}
		v, ok := ex.J[m[1]]
		if ok && m[2] != "" {
			g, _ := v.(map[string]any)
			_, ok = g[m[2]]
		}
		if !ok {
			t.Errorf("%s: export has no section %q", col, strings.TrimPrefix(m[0], "exported: "))
		}
	}

	// removed entries hold no row of the deleted account
	exec(t, c, `insert into passkey_resets (id, account_id, session_hash, user_agent, ready_at, cancelled_at, cancelled_by)
		values (gen_random_uuid(), $1, decode(repeat('ab', 32), 'hex'), 'Mozilla/5.0', now() + interval '3 days', now(), 'session')`, w.eve.AccountID)
	askDelete(t, w.dana)
	if r := w.dana.Do("POST", "/app/v1/me/delete", deleteBody(w.dana.Email, w.dana.Check("account_delete", ""), leaveEntry(w))); r.Status != 200 {
		t.Fatalf("delete: %s", r)
	}
	for col, d := range store.AccountDeleteFate {
		if !strings.HasPrefix(d, "removed") || strings.HasPrefix(col, "accounts.") {
			continue
		}
		tbl, column, _ := strings.Cut(col, ".")
		extra := ""
		if tbl == "credit_ledger" {
			extra = " and kind in ('grant','usage')"
		}
		if n := count(t, c, `select count(*) from `+tbl+` where `+column+` = $1`+extra, w.dana.AccountID); n != 0 {
			t.Errorf("%s: %d rows of the deleted account left, the list says removed", col, n)
		}
	}
	if n := count(t, c, `select count(*) from passkey_resets where account_id = $1`, w.eve.AccountID); n != 1 {
		t.Error("another account's reset record was touched")
	}
}

func leaveEntry(w *acctWorld) map[string]any {
	w.dana.Sync(w.shared)
	e := w.shared.Log.Build("person_remove", w.dana.Dev, map[string]any{"account": w.dana.AccountID})
	return map[string]any{"room_id": w.shared.ID, "roster_entry": e}
}

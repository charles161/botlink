package test

import (
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/appapi" // its init adds account_delete to humancheck.Actions and NoTarget
	"github.com/charles161/botlink/server/internal/humancheck"
	"github.com/charles161/botlink/server/internal/plans"
)

// 0042 rewrote human_checks_action_check without 0040's 'account_delete': every account delete would have failed on a
// migrated database, and only a hand check at the merge caught it. A CHECK constraint that lists allowed values and
// that more than one migration writes is compared here, on a freshly migrated database, with the values the code uses.

// coveredConstraints: every value-list CHECK constraint a migration drops and adds again, and the test that compares it
// with the code. A migration that rewrites a constraint not in this list fails TestRewrittenConstraintsAreCovered.
var coveredConstraints = map[string]string{
	"human_checks_action_check":          "TestHumanCheckConstraintsListEveryAction",
	"human_checks_check":                 "TestHumanCheckConstraintsListEveryAction",
	"account_events_kind_check":          "TestAccountEventKindsAreAllowed",
	"account_deletes_cancelled_by_check": "TestAccountDeleteCancelReasonsAreAllowed",
	"limit_boosts_limit_key_check":       "TestLimitKeysAreAllowed",
	"limit_events_limit_key_check":       "TestLimitKeysAreAllowed",
	"limit_reached_days_limit_key_check": "TestLimitKeysAreAllowed",
}

// rewrittenOnceLongAgo: constraints rewritten by shipped migrations only, with exactly these migrations. Rewriting one
// again changes its list here and fails: then cover it in coveredConstraints instead.
var rewrittenOnceLongAgo = map[string]string{
	"attention_kind_check":           "0004_device_approval_membership.sql",
	"messages_scope_check":           "0006_r2_delivery.sql",
	"messages_check":                 "0006_r2_delivery.sql",
	"join_requests_match_code_check": "0006_r2_delivery.sql",
}

const srcRoot = ".." // server/

func TestRewrittenConstraintsAreCovered(t *testing.T) {
	dir := filepath.Join(srcRoot, "..", "db", "migrations")
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	re := regexp.MustCompile(`(?i)drop\s+constraint\s+(?:if\s+exists\s+)?([a-z0-9_]+)`)
	touched := map[string][]string{}
	for _, e := range ents {
		if !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		sql := regexp.MustCompile(`--.*`).ReplaceAllString(string(b), "")
		for _, m := range re.FindAllStringSubmatch(sql, -1) {
			if name := strings.ToLower(m[1]); !slices.Contains(touched[name], e.Name()) {
				touched[name] = append(touched[name], e.Name())
			}
		}
	}
	for name, files := range touched {
		if coveredConstraints[name] != "" {
			continue
		}
		if strings.Join(files, ",") == rewrittenOnceLongAgo[name] {
			continue
		}
		t.Errorf("%s is rewritten by %s: a migration that rewrites a CHECK constraint must keep every value earlier migrations allowed; compare it with the values the code uses in server/test/constraint_sets_test.go and add it to coveredConstraints",
			name, strings.Join(files, ", "))
	}
}

// catalogValues reads constraint name on table from a freshly migrated database and returns the quoted values in it.
func catalogValues(t *testing.T, conn *pgx.Conn, table, name string) []string {
	t.Helper()
	var def string
	if err := conn.QueryRow(context.Background(), `select pg_get_constraintdef(oid) from pg_constraint
		where conrelid = $1::regclass and conname = $2`, table, name).Scan(&def); err != nil {
		t.Fatalf("constraint %s on %s: %v", name, table, err)
	}
	var out []string
	for _, m := range regexp.MustCompile(`'([a-z0-9_]+)'::text`).FindAllStringSubmatch(def, -1) {
		out = append(out, m[1])
	}
	if len(out) == 0 {
		t.Fatalf("constraint %s lists no values: %s", name, def)
	}
	sort.Strings(out)
	return out
}

func migratedConn(t *testing.T) *pgx.Conn {
	t.Helper()
	conn, err := pgx.Connect(context.Background(), NewDB(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(context.Background()) })
	return conn
}

func missingFrom(allowed []string, used map[string]string) []string {
	var out []string
	for v, at := range used {
		if !slices.Contains(allowed, v) {
			out = append(out, v+" (used at "+at+")")
		}
	}
	sort.Strings(out)
	return out
}

func TestHumanCheckConstraintsListEveryAction(t *testing.T) {
	_ = appapi.AccountDeleteAction
	conn := migratedConn(t)
	// what the code can issue: humancheck.Actions, and every *Action constant (the ones only StartReset, StartAdmin
	// and the like issue are not in Actions on purpose)
	issued := map[string]string{}
	for a := range humancheck.Actions {
		issued[a] = "humancheck.Actions"
	}
	for v, at := range stringConsts(t, func(name string) bool { return strings.HasSuffix(name, "Action") }) {
		issued[v] = at
	}
	allowed := catalogValues(t, conn, "human_checks", "human_checks_action_check")
	for _, m := range missingFrom(allowed, issued) {
		t.Errorf("human_checks_action_check does not allow %s: a migration that rewrites this constraint must list every action in humancheck.Actions (and every *Action constant)", m)
	}
	noTarget := map[string]string{}
	for a := range humancheck.NoTarget {
		noTarget[a] = "humancheck.NoTarget"
	}
	dbNoTarget := catalogValues(t, conn, "human_checks", "human_checks_check")
	for _, m := range missingFrom(dbNoTarget, noTarget) {
		t.Errorf("human_checks_check does not list %s as an action with no target: a migration that rewrites this constraint must list every action in humancheck.NoTarget", m)
	}
	for _, a := range dbNoTarget {
		if !humancheck.NoTarget[a] {
			t.Errorf("human_checks_check lists %s as an action with no target, but humancheck.NoTarget does not: the code would give it a target and every such check would fail", a)
		}
	}
}

func TestAccountEventKindsAreAllowed(t *testing.T) {
	conn := migratedConn(t)
	// store.AccountEvent(ctx, q, account, kind, data) and store.AccountEventBy(ctx, q, account, sessionHash, kind, data)
	kinds := literalArgs(t, map[string]int{"AccountEvent": 3, "AccountEventBy": 4}, "account event kind")
	if len(kinds) < 9 {
		t.Fatalf("read %d account event kinds from the code; the collector is broken", len(kinds))
	}
	allowed := catalogValues(t, conn, "account_events", "account_events_kind_check")
	for _, m := range missingFrom(allowed, kinds) {
		t.Errorf("account_events_kind_check does not allow %s: a migration that rewrites this constraint must list every kind the code writes (store.AccountEvent, store.AccountEventBy)", m)
	}
}

func TestAccountDeleteCancelReasonsAreAllowed(t *testing.T) {
	conn := migratedConn(t)
	// store.CancelDelete(ctx, tx, account, by, …) and appapi's cancelDeleteTx(ctx, tx, s, by), plus 'lapsed' in the SQL
	by := literalArgs(t, map[string]int{"CancelDelete": 3, "cancelDeleteTx": 3}, "account delete cancelled_by")
	for v, at := range sqlLiterals(t, "account_deletes", `cancelled_by\s*=\s*(?:case\s+when\s+[^']*then\s+)?'([a-z_]+)'`) {
		by[v] = at
	}
	if len(by) < 6 {
		t.Fatalf("read %d cancel reasons from the code; the collector is broken: %v", len(by), by)
	}
	allowed := catalogValues(t, conn, "account_deletes", "account_deletes_cancelled_by_check")
	for _, m := range missingFrom(allowed, by) {
		t.Errorf("account_deletes_cancelled_by_check does not allow %s: a migration that rewrites this constraint must list every cancelled_by the code writes", m)
	}
}

func TestLimitKeysAreAllowed(t *testing.T) {
	conn := migratedConn(t)
	keys := map[string]string{}
	for _, k := range plans.Keys {
		keys[k] = "plans.Keys"
	}
	for _, m := range missingFrom(catalogValues(t, conn, "limit_boosts", "limit_boosts_limit_key_check"), keys) {
		t.Errorf("limit_boosts_limit_key_check does not allow %s: a migration that rewrites this constraint must list every key in plans.Keys", m)
	}
	// plans.Enforce(ctx, tx, pool, mode, key, …) records into limit_events and limit_reached_days
	enforced := literalArgs(t, map[string]int{"Enforce": 4}, "limit key")
	if len(enforced) < 4 {
		t.Fatalf("read %d enforced limit keys from the code; the collector is broken: %v", len(enforced), enforced)
	}
	for _, c := range []string{"limit_events", "limit_reached_days"} {
		for _, m := range missingFrom(catalogValues(t, conn, c, c+"_limit_key_check"), enforced) {
			t.Errorf("%s_limit_key_check does not allow %s: a migration that rewrites this constraint must list every key plans.Enforce is called with", c, m)
		}
	}
}

// ── reading the server's source

type goFile struct {
	path string
	f    *ast.File
}

var parsed struct {
	fset  *token.FileSet
	files []goFile
}

func serverSource(t *testing.T) ([]goFile, *token.FileSet) {
	t.Helper()
	if parsed.fset != nil {
		return parsed.files, parsed.fset
	}
	fset := token.NewFileSet()
	var files []goFile
	err := filepath.WalkDir(filepath.Join(srcRoot, "internal"), func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		f, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			return err
		}
		files = append(files, goFile{path, f})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	parsed.fset, parsed.files = fset, files
	return files, fset
}

func strLit(e ast.Expr) (string, bool) {
	bl, ok := e.(*ast.BasicLit)
	if !ok || bl.Kind != token.STRING {
		return "", false
	}
	s, err := strconv.Unquote(bl.Value)
	return s, err == nil
}

// stringConsts: every string constant in the server whose name passes keep, value -> where.
func stringConsts(t *testing.T, keep func(string) bool) map[string]string {
	files, fset := serverSource(t)
	out := map[string]string{}
	for _, gf := range files {
		for _, d := range gf.f.Decls {
			gd, ok := d.(*ast.GenDecl)
			if !ok || gd.Tok != token.CONST {
				continue
			}
			for _, sp := range gd.Specs {
				vs := sp.(*ast.ValueSpec)
				for i, n := range vs.Names {
					if i < len(vs.Values) && keep(n.Name) {
						if s, ok := strLit(vs.Values[i]); ok {
							out[s] = fset.Position(n.Pos()).String()
						}
					}
				}
			}
		}
	}
	return out
}

// literalArgs: the values passed at argument index argAt[callee] of every call to callee (a function or method name).
// An argument must be a string literal, a string constant, or a local variable assigned only string literals in the
// same function; anything else fails, so a value cannot reach the database unseen.
func literalArgs(t *testing.T, argAt map[string]int, what string) map[string]string {
	t.Helper()
	files, fset := serverSource(t)
	consts := stringConstsByName(files)
	out := map[string]string{}
	for _, gf := range files {
		for _, d := range gf.f.Decls {
			fn, ok := d.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				var name string
				switch f := call.Fun.(type) {
				case *ast.Ident:
					name = f.Name
				case *ast.SelectorExpr:
					name = f.Sel.Name
				}
				i, ok := argAt[name]
				if !ok || len(call.Args) <= i {
					return true
				}
				at := fset.Position(call.Args[i].Pos()).String()
				arg := call.Args[i]
				if s, ok := strLit(arg); ok {
					out[s] = at
					return true
				}
				var id string
				switch a := arg.(type) {
				case *ast.SelectorExpr:
					id = a.Sel.Name
				case *ast.Ident:
					id = a.Name
				}
				if v, ok := consts[id]; ok {
					out[v] = at
					return true
				}
				if a, ok := arg.(*ast.Ident); ok {
					if vals := assignedLiterals(fn.Body, a.Name); len(vals) > 0 {
						for _, v := range vals {
							out[v] = at
						}
						return true
					}
				}
				if _, wrapper := argAt[fn.Name.Name]; wrapper && paramOf(fn, arg) {
					return true // a wrapper read here too passes its own parameter on: its callers are read
				}
				t.Errorf("%s: the %s passed to %s is not a string literal, a string constant or a local assigned only literals; this check cannot see it, so write it as one of those", at, what, name)
				return true
			})
		}
	}
	return out
}

func stringConstsByName(files []goFile) map[string]string {
	out := map[string]string{}
	for _, gf := range files {
		for _, d := range gf.f.Decls {
			gd, ok := d.(*ast.GenDecl)
			if !ok || gd.Tok != token.CONST {
				continue
			}
			for _, sp := range gd.Specs {
				vs := sp.(*ast.ValueSpec)
				for i, n := range vs.Names {
					if i < len(vs.Values) {
						if s, ok := strLit(vs.Values[i]); ok {
							out[n.Name] = s
						}
					}
				}
			}
		}
	}
	return out
}

// assignedLiterals: the string literals assigned to the local name in body; nil when any assignment to it is not one.
func assignedLiterals(body *ast.BlockStmt, name string) []string {
	var vals []string
	other := false
	ast.Inspect(body, func(n ast.Node) bool {
		as, ok := n.(*ast.AssignStmt)
		if !ok {
			return true
		}
		for i, l := range as.Lhs {
			if id, ok := l.(*ast.Ident); ok && id.Name == name && i < len(as.Rhs) {
				if s, ok := strLit(as.Rhs[i]); ok {
					vals = append(vals, s)
				} else {
					other = true
				}
			}
		}
		return true
	})
	if other {
		return nil
	}
	return vals
}

// paramOf: arg is a parameter of fn (a wrapper that passes the value on; its callers are read too).
func paramOf(fn *ast.FuncDecl, arg ast.Expr) bool {
	id, ok := arg.(*ast.Ident)
	if !ok {
		return false
	}
	for _, f := range fn.Type.Params.List {
		for _, n := range f.Names {
			if n.Name == id.Name {
				return true
			}
		}
	}
	return false
}

// sqlLiterals: the values the pattern captures in Go string literals of the server that mention table.
func sqlLiterals(t *testing.T, table, pattern string) map[string]string {
	files, fset := serverSource(t)
	re := regexp.MustCompile(`(?is)` + pattern)
	out := map[string]string{}
	for _, gf := range files {
		ast.Inspect(gf.f, func(n ast.Node) bool {
			s, ok := strLit(asExpr(n))
			if !ok || !strings.Contains(s, table) {
				return true
			}
			for _, m := range re.FindAllStringSubmatch(s, -1) {
				out[m[1]] = fset.Position(n.Pos()).String()
			}
			return true
		})
	}
	return out
}

func asExpr(n ast.Node) ast.Expr {
	e, _ := n.(ast.Expr)
	return e
}

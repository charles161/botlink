package test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// A test once set the asking sign-in's created_at = now() after a 72-hour reset wait, so the sign-in looked fresh and
// the test passed, while in a browser the reset could never be finished (the asking sign-in is 72 h old by then).
// Rows of the wait tables only age in a test; a wait passes for the whole account at once.
//
//   rule "younger": no test sets an age column of web_sessions, passkey_resets or account_deletes to now() (or later):
//     that runs one row's clock backwards. A fresh sign-in is a new sign-in: signInHere, reSignIn or signInAgain
//     (recover_test.go).
//   rule "wait end": no test moves ready_at or lapses_at of passkey_resets or account_deletes except moveClock and
//     moveAll (account_wait_test.go, account_guard_test.go), which move every time of the account's sign-ins, resets,
//     delete asks and events together.

var waitTables = regexp.MustCompile(`(?is)\bupdate\s+(?:public\.)?(web_sessions|passkey_resets|account_deletes)\s+set\s+(.*?)(?:\swhere\s|\sreturning\s|$)`)

// set to now, the current time by another name, or a time after it
var younger = regexp.MustCompile(`(?i)\b(created_at|ready_at|lapses_at|uv_at|last_seen_at)\s*=\s*(?:now\(\)|current_timestamp|clock_timestamp\(\)|statement_timestamp\(\)|transaction_timestamp\(\)|localtimestamp)\s*(?:\+[^,]*)?(?:,|$)`)

var waitEnd = regexp.MustCompile(`(?i)\b(ready_at|lapses_at)\s*=`)

var clockHelpers = map[string]bool{"moveClock": true, "moveAll": true}

// a statement on a wait table this check cannot read: a fmt verb in its set clause, or text joined with a variable
var waitTableNamed = regexp.MustCompile(`(?is)\bupdate\s+(?:public\.)?(?:web_sessions|passkey_resets|account_deletes)\b`)
var fmtVerb = regexp.MustCompile(`%[-+# 0-9.]*[a-zA-Z]`)

func TestClockOnlyMovesForward(t *testing.T) {
	files, err := filepath.Glob("*_test.go")
	if err != nil || len(files) < 20 {
		t.Fatalf("test files: %v %v", files, err)
	}
	fset := token.NewFileSet()
	found := map[string][]string{}
	for _, path := range files {
		src, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		f, err := parser.ParseFile(fset, path, src, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, d := range f.Decls {
			fn, ok := d.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				if n == nil {
					return false
				}
				var s string
				at := fset.Position(n.Pos()).String()
				switch e := n.(type) {
				case *ast.BinaryExpr: // "update … " + "set …": the whole sum, when every part is a literal
					v, ok := literalSum(e)
					if !ok {
						if e.Op == token.ADD && mentionsWaitTable(e) {
							found["unreadable"] = append(found["unreadable"], at+": a statement on a wait table joined with a variable")
							return false
						}
						return true
					}
					s = v
				case *ast.BasicLit:
					if e.Kind != token.STRING {
						return true
					}
					v, err := strconv.Unquote(e.Value)
					if err != nil {
						return true
					}
					s = v
				default:
					return true
				}
				for _, m := range waitTables.FindAllStringSubmatch(s, -1) {
					set := strings.Join(strings.Fields(m[2]), " ")
					stmt := at + ": " + strings.TrimSpace(m[0])
					if fmtVerb.MatchString(set) {
						found["unreadable"] = append(found["unreadable"], stmt)
					}
					if younger.MatchString(set) {
						found["younger"] = append(found["younger"], stmt)
					}
					if m[1] != "web_sessions" && waitEnd.MatchString(set) && !clockHelpers[fn.Name.Name] {
						found["wait end"] = append(found["wait end"], stmt)
					}
				}
				return false
			})
		}
	}
	why := map[string]string{
		"younger":    "a test runs one row's clock backwards by setting its age to now(): a fresh sign-in is a new sign-in, use signInHere, reSignIn or signInAgain (recover_test.go); to let a wait pass use moveClock or moveAll",
		"wait end":   "a test ends a wait by moving one table's ready_at or lapses_at: use moveClock or moveAll (account_wait_test.go, account_guard_test.go), which move the account's sign-ins, resets, delete asks and events together",
		"unreadable": "a test builds a statement on web_sessions, passkey_resets or account_deletes that this check cannot read (a fmt verb or a variable in it): write the SQL as one literal with $n parameters",
	}
	for _, rule := range []string{"younger", "wait end", "unreadable"} {
		if sites := found[rule]; len(sites) > 0 {
			t.Errorf("%s:\n  %s", why[rule], strings.Join(sites, "\n  "))
		}
	}
}

// mentionsWaitTable: a string literal inside e names an update of a wait table.
func mentionsWaitTable(e ast.Expr) bool {
	hit := false
	ast.Inspect(e, func(n ast.Node) bool {
		if bl, ok := n.(*ast.BasicLit); ok && bl.Kind == token.STRING {
			if v, err := strconv.Unquote(bl.Value); err == nil && waitTableNamed.MatchString(v) {
				hit = true
			}
		}
		return !hit
	})
	return hit
}

func literalSum(e ast.Expr) (string, bool) {
	switch x := e.(type) {
	case *ast.BasicLit:
		if x.Kind != token.STRING {
			return "", false
		}
		s, err := strconv.Unquote(x.Value)
		return s, err == nil
	case *ast.BinaryExpr:
		if x.Op != token.ADD {
			return "", false
		}
		l, ok := literalSum(x.X)
		if !ok {
			return "", false
		}
		r, ok := literalSum(x.Y)
		return l + r, ok
	case *ast.ParenExpr:
		return literalSum(x.X)
	}
	return "", false
}

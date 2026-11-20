package config

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/charles161/botlink/server/internal/exportomit"
)

// Seven reset and delete settings the server reads were missing from deploy/README.md at a merge: whoever deploys
// cannot set what the runbook does not name. Every BOTLINK_* name the server reads must be in the README, and in
// SELF-HOSTING.md (a self-hoster cannot set what the guide does not name either).

// notInRunbook: names the server reads that the production runbook must not offer, each with why. Keep it short:
// a setting someone can use in production belongs in deploy/README.md instead.
var notInRunbook = map[string]string{
	"BOTLINK_TEST_FAULTS":      "fault hooks for tests (package faults); the server refuses to start with it in prod",
	"BOTLINK_BILLING_FAKE_KEY": "the fake payment gateway's key (BOTLINK_BILLING_GATEWAY=fake), dev only",
}

var envName = regexp.MustCompile(`^BOTLINK_[A-Z0-9_]+$`)

// serverEnvNames parses every non-test Go file of the server and returns each BOTLINK_* name passed to an env reader
// (os.Getenv, os.LookupEnv, this package's getenv), with where it is read.
func serverEnvNames(t *testing.T) map[string]string {
	t.Helper()
	root := filepath.Join("..", "..") // server/
	fset := token.NewFileSet()
	names := map[string]string{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
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
		for _, decl := range f.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil || (fn.Name.Name == "getenv" && fn.Recv == nil) { // the helper itself reads its argument
				continue
			}
			dynamic := token.NoPos // an env reader called with a name that is not a literal
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok || len(call.Args) == 0 || !isEnvReader(call.Fun) {
					return true
				}
				if s, ok := stringLit(call.Args[0]); ok {
					if envName.MatchString(s) {
						names[s] = fset.Position(call.Pos()).String()
					}
				} else {
					dynamic = call.Pos()
				}
				return true
			})
			if dynamic == token.NoPos {
				continue
			}
			// a table of names read in a loop (signup.go, plans.go): the BOTLINK_* literals in the function's composite literals
			found := 0
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				cl, ok := n.(*ast.CompositeLit)
				if !ok {
					return true
				}
				for _, el := range cl.Elts {
					if kv, ok := el.(*ast.KeyValueExpr); ok {
						el = kv.Value
					}
					if s, ok := stringLit(el); ok && envName.MatchString(s) {
						names[s] = fset.Position(el.Pos()).String()
						found++
					}
				}
				return true
			})
			if found == 0 {
				t.Errorf("%s: an env reader is called with a name this check cannot see; pass the BOTLINK_* name as a string literal, or from a table of literals in the same function",
					fset.Position(dynamic))
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return names
}

func isEnvReader(fun ast.Expr) bool {
	switch f := fun.(type) {
	case *ast.Ident:
		return f.Name == "getenv"
	case *ast.SelectorExpr:
		x, ok := f.X.(*ast.Ident)
		return ok && x.Name == "os" && (f.Sel.Name == "Getenv" || f.Sel.Name == "LookupEnv")
	}
	return false
}

func stringLit(e ast.Expr) (string, bool) {
	bl, ok := e.(*ast.BasicLit)
	if !ok || bl.Kind != token.STRING {
		return "", false
	}
	s, err := strconv.Unquote(bl.Value)
	return s, err == nil
}

func TestEverySettingIsInTheDeployRunbook(t *testing.T) {
	names := serverEnvNames(t)
	if len(names) < 40 || names["BOTLINK_DATABASE_URL"] == "" || names["BOTLINK_SIGNUP_PER_IP_DAY"] == "" {
		t.Fatalf("read %d names from the server source; the collector is broken", len(names))
	}
	// The hosted service's runbook and the self-hosting guide both list every setting. The public export leaves the
	// runbook out (.public-export says why); then only the guide is checked, and the skip is said.
	root := filepath.Join("..", "..", "..")
	for _, doc := range []string{"deploy/README.md", "SELF-HOSTING.md"} {
		b, err := os.ReadFile(filepath.Join(root, doc))
		if err != nil {
			if why, ok := exportomit.Reason(root, doc); ok {
				t.Logf("%s: not checked, left out of this public export (%s)", doc, why)
				continue
			}
			t.Fatal(err)
		}
		inDoc := map[string]bool{}
		for _, m := range regexp.MustCompile(`BOTLINK_[A-Z0-9_]+`).FindAllString(string(b), -1) {
			inDoc[m] = true
		}
		var missing []string
		for n, at := range names {
			if !inDoc[n] && notInRunbook[n] == "" {
				missing = append(missing, n+" (read at "+at+")")
			}
		}
		sort.Strings(missing)
		for _, m := range missing {
			t.Errorf("%s is not in %s: add one line there saying what it does and its default", m, doc)
		}
	}
	for n := range notInRunbook {
		if names[n] == "" {
			t.Errorf("notInRunbook lists %s, which the server no longer reads: remove it from the list", n)
		}
	}
}

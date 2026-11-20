package pages

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// fixHint names the exact line to add to HostTable (server/internal/pages/hosts.go).
func fixHint(path string, kind Kind) string {
	k := map[Kind]string{Page: "Page", File: "File", Call: "Call"}[kind]
	return fmt.Sprintf("add it to the host table as site or app: the line {%q, App, %s}, (or Site) in HostTable, server/internal/pages/hosts.go, "+
		"then rows for it in testdata/host-routes.json and BOTLINK_WRITE_HOSTS=1 go test ./server/internal/pages -run TestDashboardHostsFile", path, k)
}

// rowPath: the table path for a registered pattern ("GET /rooms/{id}" → "/rooms/{id}", "{$}" dropped).
func rowPath(pattern string) string {
	if i := strings.IndexByte(pattern, ' '); i >= 0 {
		pattern = pattern[i+1:]
	}
	return strings.ReplaceAll(pattern, "{$}", "")
}

// samplePath: a concrete path a route pattern answers ("GET /rooms/{id}" → "/rooms/x"; "/assets/" → "/assets/x").
func samplePath(pattern string) string {
	if i := strings.IndexByte(pattern, ' '); i >= 0 {
		pattern = pattern[i+1:]
	}
	if i := strings.IndexByte(pattern, '/'); i > 0 { // "host/path" patterns: never used here, and the table is per path
		pattern = pattern[i:]
	}
	pattern = strings.ReplaceAll(pattern, "{$}", "")
	segs := strings.Split(pattern, "/")
	for i, s := range segs {
		if strings.HasPrefix(s, "{") {
			segs[i] = "x"
		}
	}
	p := strings.Join(segs, "/")
	if strings.HasSuffix(p, "/") && p != "/" {
		p += "x"
	}
	return p
}

// Every route any package registers on a mux (a string literal handed to Handle or HandleFunc), and every page route
// of the dashboard, has a row. A row-less route answers 404 on every host, so this test is where you learn it.
func TestHostTableCoversEveryRoute(t *testing.T) {
	type reg struct{ pattern, at string }
	var regs []reg
	fset := token.NewFileSet()
	root := filepath.Join("..")
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return err
		}
		f, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			return err
		}
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || len(call.Args) == 0 {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || (sel.Sel.Name != "Handle" && sel.Sel.Name != "HandleFunc") {
				return true
			}
			if lit, ok := call.Args[0].(*ast.BasicLit); ok && lit.Kind == token.STRING {
				s, _ := strconv.Unquote(lit.Value)
				regs = append(regs, reg{s, fset.Position(lit.Pos()).String()})
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(regs) < 80 {
		t.Fatalf("found only %d registered routes under server/internal: the scan is broken", len(regs))
	}
	for _, rt := range SPARoutes {
		regs = append(regs, reg{rt, "pages.SPARoutes"})
	}
	for _, rt := range FakeBillingRoutes {
		regs = append(regs, reg{rt, "pages.FakeBillingRoutes"})
	}
	for _, g := range regs {
		p := samplePath(g.pattern)
		if p == "/" && !strings.HasSuffix(g.pattern, "{$}") && g.at != "pages.SPARoutes" {
			continue // the catch-all: files at the root of web/public (TestHostTableCoversWebPublic)
		}
		row, ok := LookupHost(p)
		if !ok {
			kind := Call
			if strings.HasPrefix(g.at, "pages.") {
				kind = Page
			}
			t.Errorf("route %q (%s) has no row in the host table, so it answers 404 on every host: %s", g.pattern, g.at, fixHint(rowPath(g.pattern), kind))
			continue
		}
		if strings.HasPrefix(g.at, "pages.") && row.Kind != Page {
			t.Errorf("dashboard page %q is a %s row in the host table (%q), want a page row: %s", g.pattern, row.Kind, row.Path, fixHint(rowPath(g.pattern), Page))
		}
	}
}

// Every file the server can serve from web/public has a row (index.html is the shell of the page rows, never served
// by its own name).
func TestHostTableCoversWebPublic(t *testing.T) {
	root := filepath.Join("..", "..", "..", "web", "public")
	n := 0
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		rel = "/" + filepath.ToSlash(rel)
		n++
		if rel == "/index.html" || strings.Contains(rel, "/.") { // dot files are never served (serveFile)
			return nil
		}
		if _, ok := LookupHost(rel); !ok {
			t.Errorf("web/public%s has no row in the host table, so no host serves it: %s", rel, fixHint(rel, File))
		}
		return nil
	})
	if err != nil || n < 20 {
		t.Fatalf("walked %d files: %v", n, err)
	}
}

// The table is well formed: one row per path, known owners and kinds, and API calls never move.
func TestHostTableRows(t *testing.T) {
	seen := map[string]bool{}
	for _, r := range HostTable {
		if seen[r.Path] {
			t.Errorf("host table: %q twice", r.Path)
		}
		seen[r.Path] = true
		switch r.Owner {
		case Site, App, API, Web, All:
		default:
			t.Errorf("host table: %q has owner %q", r.Path, r.Owner)
		}
		switch r.Kind {
		case Page, File, Call:
		default:
			t.Errorf("host table: %q has kind %q", r.Path, r.Kind)
		}
		if r.Owner == API && r.Kind != Call {
			t.Errorf("host table: %q on the API host must be a call (installed clients refuse redirects)", r.Path)
		}
		if got, ok := LookupHost(samplePath(r.Path)); !ok || got.Path != r.Path {
			t.Errorf("host table: %q is shadowed by %q", r.Path, got.Path)
		}
	}
}

// Every row of the table is tried on all three hosts by testdata/host-routes.json (the routing test's data).
func TestHostRoutesDataCoversTable(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("testdata", "host-routes.json"))
	if err != nil {
		t.Fatal(err)
	}
	var data struct {
		Rows       []map[string]any `json:"rows"`
		SingleRows []map[string]any `json:"single_rows"`
	}
	if err := json.Unmarshal(b, &data); err != nil {
		t.Fatal(err)
	}
	covered := map[string]bool{}
	for _, row := range data.Rows {
		p, _ := row["path"].(string)
		p, _, _ = strings.Cut(p, "?")
		_, s := row["site"]
		_, a := row["app"]
		_, i := row["api"]
		if rt, ok := LookupHost(p); ok && s && a && i {
			covered[rt.Path] = true
		}
	}
	for _, r := range HostTable {
		if !covered[r.Path] {
			t.Errorf("testdata/host-routes.json has no row for %q (owner %s) with an answer for site, app and api: add one", r.Path, r.Owner)
		}
	}
	one := map[string]bool{}
	for _, row := range data.SingleRows {
		p, _ := row["path"].(string)
		p, _, _ = strings.Cut(p, "?")
		if rt, ok := LookupHost(p); ok && row["one"] != nil {
			one[rt.Path] = true
		}
	}
	for _, r := range HostTable {
		if !one[r.Path] {
			t.Errorf("testdata/host-routes.json single_rows has no row for %q with an answer for one: add one", r.Path)
		}
	}
}

// web/public/assets/js/hosts.js is the table, for the dashboard's router.
func TestDashboardHostsFile(t *testing.T) {
	file := filepath.Join("..", "..", "..", "web", "public", "assets", "js", "hosts.js")
	want := DashboardHostsJS()
	if os.Getenv("BOTLINK_WRITE_HOSTS") == "1" {
		if err := os.WriteFile(file, want, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := os.ReadFile(file)
	if err != nil || !bytes.Equal(got, want) {
		t.Fatalf("web/public/assets/js/hosts.js is not the host table (%v): run BOTLINK_WRITE_HOSTS=1 go test ./server/internal/pages -run TestDashboardHostsFile", err)
	}
}

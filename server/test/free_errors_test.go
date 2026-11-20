package test

// Lane FREE: no error a person could read as "pay" is reachable with the paywall off. Every error the server can
// build (httpx.E, BadRequest, Forbidden, RateLimited) is found in the source; one with a payment-flavoured code, a
// 402 status or text naming a plan, credit, upgrade, price or payment must sit in a function listed in paidOnly,
// whose reason names the guard that keeps it unreachable while BOTLINK_PAYWALL is off. The guards themselves are
// proven by free_test.go (routes unregistered, block mode ignored, delete not refused).

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// paidOnly: "<file under server/internal>:<func>" → why it cannot answer while the paywall is off.
var paidOnly = map[string]string{
	"appapi/plans.go:billingOff":         "PlansAPI.Routes is registered only with the paywall on (server.go)",
	"appapi/plans.go:paymentUnavailable": "PlansAPI.Routes is registered only with the paywall on (server.go)",
	"appapi/plans.go:postCheckout":       "PlansAPI.Routes is registered only with the paywall on (server.go)",
	"appapi/plans.go:postPortal":         "PlansAPI.Routes is registered only with the paywall on (server.go)",
	"plans/plans.go:LimitError":          "only Enforce returns it, in block mode; Mode() is off while the paywall is off (config.PlansConfig.Paid)",
	"plans/admin.go:UpdatePlan":          "admin plan routes are registered only with the paywall on (adminapi.API.routes)",
	"plans/credits.go:Grant":             "admin plan routes are registered only with the paywall on (adminapi.API.routes)",
	"plans/admin.go:GetPlan":             "admin plan routes are registered only with the paywall on (adminapi.API.routes)",
	"appapi/account_data.go:planRenews":  "called only when config.PlansConfig.Paywall() is on (deleteChecks)",
}

var errCtor = map[string]bool{"E": true, "BadRequest": true, "Forbidden": true, "RateLimited": true}

type errSite struct {
	where, fn string // "appapi/plans.go:123", "appapi/plans.go:postCheckout"
	status    string
	code      string
	texts     []string
}

func errorSites(t *testing.T) []errSite {
	t.Helper()
	root := filepath.Join("..", "internal")
	fset := token.NewFileSet()
	var out []errSite
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return err
		}
		f, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		inHTTPX := f.Name.Name == "httpx"
		for _, decl := range f.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				name := ""
				switch fx := call.Fun.(type) {
				case *ast.SelectorExpr:
					if id, ok := fx.X.(*ast.Ident); ok && id.Name == "httpx" {
						name = fx.Sel.Name
					}
				case *ast.Ident:
					if inHTTPX {
						name = fx.Name
					}
				}
				if !errCtor[name] {
					return true
				}
				s := errSite{where: rel + ":" + strconv.Itoa(fset.Position(call.Pos()).Line), fn: rel + ":" + fn.Name.Name}
				switch name {
				case "E":
					if len(call.Args) >= 2 {
						if l, ok := call.Args[0].(*ast.BasicLit); ok {
							s.status = l.Value
						}
						if l, ok := call.Args[1].(*ast.BasicLit); ok {
							s.code, _ = strconv.Unquote(l.Value)
						}
					}
				case "BadRequest":
					s.status, s.code = "400", "bad_request"
				case "Forbidden":
					s.status, s.code = "403", "forbidden"
				case "RateLimited":
					s.status = "429"
				}
				ast.Inspect(call, func(m ast.Node) bool {
					if l, ok := m.(*ast.BasicLit); ok && l.Kind == token.STRING {
						v, _ := strconv.Unquote(l.Value)
						s.texts = append(s.texts, v)
					}
					return true
				})
				out = append(out, s)
				return true
			})
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

var paidCodeSet = func() map[string]bool {
	m := map[string]bool{}
	for _, c := range paidCodes {
		m[c] = true
	}
	return m
}()

// The error-code list in api/openapi.yaml, with the codes that only a paid route or block mode can answer.
func TestFreeNoPaidErrorReachable(t *testing.T) {
	spec, err := os.ReadFile(filepath.Join("..", "..", "api", "openapi.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	enum := regexp.MustCompile(`(?m)^        - ([a-z_]+)\s+# (\d{3})`).FindAllStringSubmatch(string(spec), -1)
	if len(enum) < 50 {
		t.Fatalf("found %d codes in the ErrorCode enum of api/openapi.yaml; the pattern is out of date", len(enum))
	}
	for _, e := range enum {
		if e[2] == "402" {
			t.Errorf("api/openapi.yaml ErrorCode %s is a 402: bot-link answers no 402 (lane FREE)", e[1])
		}
	}
	for _, c := range paidCodes {
		if !strings.Contains(string(spec), "        - "+c+" ") {
			t.Errorf("paidCodes names %s but api/openapi.yaml's ErrorCode enum has no such code: drop it from paidCodes", c)
		}
	}
	used := map[string]bool{}
	for _, s := range errorSites(t) {
		var why []string
		if s.status == "402" {
			why = append(why, "status 402")
		}
		if paidCodeSet[s.code] {
			why = append(why, "code "+s.code)
		}
		for _, x := range s.texts {
			if m := paidText.FindString(x); m != "" {
				why = append(why, "text "+strconvQuote(x))
			}
		}
		if len(why) == 0 {
			continue
		}
		if s.status == "402" {
			t.Errorf("%s answers 402: bot-link answers no 402; use 409 with a plain code instead", s.where)
		}
		if _, ok := paidOnly[s.fn]; !ok {
			t.Errorf("%s (%s) can answer %s. Either word it without a plan, credit, upgrade, price or payment, or move it "+
				"into code that exists only with the paywall on and list %q in paidOnly with that guard", s.where, s.fn, strings.Join(why, ", "), s.fn)
		}
		used[s.fn] = true
	}
	for fn := range paidOnly {
		if !used[fn] {
			t.Errorf("paidOnly lists %s, which builds no paid error: drop the entry", fn)
		}
	}
}

func strconvQuote(s string) string {
	if len(s) > 80 {
		s = s[:80] + "…"
	}
	return strconv.Quote(s)
}

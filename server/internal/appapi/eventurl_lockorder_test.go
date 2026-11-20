package appapi

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The approval of an event address (eventurl.go) takes the rooms row, then the member row, then the request row: the
// order of store.LockRoom's comment. A member's removal and a move take the room and then the member; an account's
// delete takes the room before anything else of the member. A function that locks event_url_requests before the
// room or the member deadlocks against them.
var (
	eventURLRequestLock = regexp.MustCompile(`(?is)update\s+event_url_requests\b|from\s+event_url_requests\b[^` + "`" + `]*?\bfor\s+(no\s+key\s+)?update\b`)
	memberRowLock       = regexp.MustCompile(`(?is)from\s+members\b[^` + "`" + `]*?\bfor\s+(no\s+key\s+)?update\b`)
)

func TestEventURLRequestIsLockedAfterRoomAndMember(t *testing.T) {
	root := filepath.Join("..")
	fset := token.NewFileSet()
	checked := 0
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return err
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		f, err := parser.ParseFile(fset, path, src, 0)
		if err != nil {
			return err
		}
		for _, decl := range f.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			body := string(src[fset.Position(fn.Body.Pos()).Offset:fset.Position(fn.Body.End()).Offset])
			req := eventURLRequestLock.FindStringIndex(body)
			if req == nil {
				continue
			}
			room, member := roomLock.FindStringIndex(body), memberRowLock.FindStringIndex(body)
			if room == nil && member == nil {
				continue // a lone update of a request row (reject, withdraw): it holds nothing else
			}
			checked++
			for what, at := range map[string][]int{"the rooms row": room, "the member row": member} {
				if at != nil && req[0] < at[0] {
					t.Errorf("%s: %s locks event_url_requests before %s: take the room (store.LockRoom), then the member, then the request, "+
						"because a removal, a move and an account delete lock the room and then the member", filepath.ToSlash(path), fn.Name.Name, what)
				}
			}
			if room != nil && member != nil && member[0] < room[0] {
				t.Errorf("%s: %s locks the member row before the rooms row: take the room first (store.LockRoom)", filepath.ToSlash(path), fn.Name.Name)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if checked < 1 {
		t.Fatal("no function locks an event address request with the room or member: the approval is not where this check looks")
	}
}

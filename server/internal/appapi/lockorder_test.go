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

// One lock order (store.LockRoom's comment): the rooms row before join requests. Approvals once locked the request
// first and then the room (through admitChat → store.AppendEntry) while removing a person and deleting a room lock the
// room and then the requests: Postgres found a deadlock every time the two met and one side answered 500 (security
// review of fix-next, 17 Nov 2026). Each function that does both must take the room first.
var (
	requestLock = regexp.MustCompile(`(?is)update\s+join_requests\b|from\s+join_requests\b[^` + "`" + `]*?\bfor\s+(no\s+key\s+)?update\b`)
	roomLock    = regexp.MustCompile(`(?is)\bLockRoom\(|\badmitChat\(|\bAppendEntry\(|\blockRoomForLastMessage\(|update\s+rooms\b|from\s+rooms\b[^` + "`" + `]*?\bfor\s+(no\s+key\s+)?update\b`)
)

func TestRoomRowIsLockedBeforeJoinRequests(t *testing.T) {
	root := filepath.Join("..") // server/internal
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
			req, room := requestLock.FindStringIndex(body), roomLock.FindStringIndex(body)
			if req == nil || room == nil {
				continue
			}
			checked++
			if req[0] < room[0] {
				t.Errorf("%s: %s locks join_requests (%q) before the rooms row (%q): take the room first with store.LockRoom(ctx, tx, roomID), "+
					"because removing a person and deleting a room lock the room and then the requests, and the opposite order deadlocks",
					filepath.ToSlash(path), fn.Name.Name, strings.Join(strings.Fields(body[req[0]:req[1]]), " "), strings.Join(strings.Fields(body[room[0]:room[1]]), " "))
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if checked < 3 {
		t.Fatalf("only %d functions lock both; the patterns no longer see the approvals and the room delete", checked)
	}
}

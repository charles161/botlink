package appapi

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// A room is made, and a chat let into a room, in one place each: createRoom (rooms.go) carries every rule of SPEC §6.2
// and admitChat (approve.go) every rule of a join approval. POST /app/v1/rooms, a join approval and a room draft's
// confirm call them (room-drafts lane, 17 Nov 2026: "do not copy their rules"). A second insert would be a second set
// of rules that drifts from the first.
func TestRoomsAndMembersAreMadeInOnePlace(t *testing.T) {
	want := map[string]string{
		`(?i)insert\s+into\s+rooms\s*\(`:   "appapi/rooms.go (createRoom)",
		`(?i)insert\s+into\s+members\s*\(`: "appapi/approve.go (admitChat)",
	}
	found := map[string][]string{}
	root := filepath.Join("..") // server/internal
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return err
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for re := range want {
			for range regexp.MustCompile(re).FindAllIndex(b, -1) {
				found[re] = append(found[re], filepath.ToSlash(strings.TrimPrefix(path, root+string(filepath.Separator))))
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for re, place := range want {
		if len(found[re]) != 1 || found[re][0] != strings.SplitN(place, " ", 2)[0] {
			t.Errorf("%s is written at %v; it must be written only in %s: call that function instead of copying its rules",
				re, found[re], place)
		}
	}
}

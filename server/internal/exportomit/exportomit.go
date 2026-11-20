// Package exportomit tells a test whether a file it reads was left out of the public export of this repository on
// purpose. The export (deploy/public-repo/build-candidate.sh) writes .public-export at the repository root: one line per
// path its allow-list drops, "<path>\t<reason>" (a folder ends in /). In the private repository there is no such file,
// so nothing is ever skipped there: a missing file is a failure, as it should be.
package exportomit

import (
	"os"
	"path/filepath"
	"strings"
)

// Reason returns why the export left rel out ("" and false when it did not, or when this is not an export).
// root is the repository root; rel is a slash path relative to it.
func Reason(root, rel string) (string, bool) {
	b, err := os.ReadFile(filepath.Join(root, ".public-export"))
	if err != nil {
		return "", false
	}
	best, why := "", ""
	for _, line := range strings.Split(string(b), "\n") {
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		p, r, ok := strings.Cut(line, "\t")
		if !ok {
			continue
		}
		if (rel == p || (strings.HasSuffix(p, "/") && strings.HasPrefix(rel, p))) && len(p) > len(best) {
			best, why = p, r
		}
	}
	return why, best != ""
}

package migrate

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 0046 and 0047 were edited after a database had applied them. A database records a migration by name only, so an
// edit never reaches a database that has it: production and a fresh database then differ. SHIPPED.sha256 holds the
// migrations as the commit live in production has them (db/migrations/lock-shipped.sh <commit>).
func TestShippedMigrationsNeverChange(t *testing.T) {
	f, err := os.Open(filepath.Join(migrationsDir, "SHIPPED.sha256"))
	if err != nil {
		t.Fatalf("db/migrations/SHIPPED.sha256: %v (write it with db/migrations/lock-shipped.sh <commit live in production>)", err)
	}
	defer f.Close()
	n := 0
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		want, name, ok := strings.Cut(line, "  ")
		if !ok || len(want) != 64 || !migrationName.MatchString(name) {
			t.Fatalf("db/migrations/SHIPPED.sha256: bad line %q (write it with db/migrations/lock-shipped.sh)", line)
		}
		n++
		b, err := os.ReadFile(filepath.Join(migrationsDir, name))
		if err != nil {
			t.Errorf("db/migrations/%s is gone, but it shipped: a shipped migration must never change: add a new migration (%v)", name, err)
			continue
		}
		sum := sha256.Sum256(b)
		if got := hex.EncodeToString(sum[:]); got != want {
			t.Errorf("db/migrations/%s differs from what shipped (sha256 %s, shipped %s): a shipped migration must never change: add a new migration", name, got[:12], want[:12])
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	if n == 0 {
		t.Fatal("db/migrations/SHIPPED.sha256 lists no migration")
	}
}

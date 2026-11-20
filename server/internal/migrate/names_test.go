package migrate

import (
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// migrationsDir is db/migrations, read from disk (not the embed): a file the embed skips is a mistake too.
const migrationsDir = "../../../db/migrations"

// notMigrations are the files in db/migrations that are not migrations (the lock of shipped migrations, lock-shipped.sh).
var notMigrations = map[string]bool{"SHIPPED.sha256": true, "lock-shipped.sh": true}

var migrationName = regexp.MustCompile(`^(\d{4})_[a-z0-9_]+\.sql$`)

// Two lanes once both added 0051_*; one was renamed to 0052 by hand at the merge. Versions apply in name order and are
// recorded by full name, so two files with one number apply in an order nobody chose.
func TestMigrationNumbersAreUnique(t *testing.T) {
	ents, err := os.ReadDir(migrationsDir)
	if err != nil {
		t.Fatal(err)
	}
	byNum := map[string][]string{}
	for _, e := range ents {
		name := e.Name()
		if e.IsDir() || notMigrations[name] {
			continue
		}
		m := migrationName.FindStringSubmatch(name)
		if m == nil {
			t.Errorf("db/migrations/%s: a migration is named NNNN_name.sql (four digits, an underscore, lower-case letters, digits and underscores)", name)
			continue
		}
		byNum[m[1]] = append(byNum[m[1]], name)
	}
	nums := make([]string, 0, len(byNum))
	for n := range byNum {
		nums = append(nums, n)
	}
	sort.Strings(nums)
	for _, n := range nums {
		if files := byNum[n]; len(files) > 1 {
			t.Errorf("db/migrations: %s share the number %s; give the newer one the next free number (%s)",
				strings.Join(files, " and "), n, nextFree(byNum))
		}
	}
}

func nextFree(byNum map[string][]string) string {
	hi := "0000"
	for n := range byNum {
		if n > hi {
			hi = n
		}
	}
	b := []byte(hi)
	for i := len(b) - 1; i >= 0; i-- {
		if b[i] < '9' {
			b[i]++
			break
		}
		b[i] = '0'
	}
	return string(b)
}

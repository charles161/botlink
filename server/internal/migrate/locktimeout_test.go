package migrate

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// A migration that alters a table waits for that table's lock behind every open transaction that touched it. Without a
// lock_timeout it queues every later query on the table behind itself (security review of fix-next, 17 Nov 2026:
// 0055 had none; 0054 waited 10 s, holding every rooms query that long). With a short lock_timeout a deploy whose
// migration cannot get its lock fails before the switch, and is run again.
const migrationLockTimeout = "3s"

// firstUnderTheRule: the rule holds from this migration on. The ones before it predate it, and most have shipped
// (SHIPPED.sha256 lists only those locked so far; a shipped migration never changes).
const firstUnderTheRule = "0054"

var (
	locksTable  = regexp.MustCompile(`(?im)^\s*(alter|create\s+(unique\s+)?index|drop|lock)\s`)
	lockTimeout = regexp.MustCompile(`(?im)^\s*set\s+local\s+lock_timeout\s*=\s*'([^']*)'\s*;`)
)

func TestMigrationsSetALockTimeout(t *testing.T) {
	ents, err := os.ReadDir(migrationsDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range ents {
		name := e.Name()
		if !migrationName.MatchString(name) || name[:4] < firstUnderTheRule {
			continue
		}
		b, err := os.ReadFile(filepath.Join(migrationsDir, name))
		if err != nil {
			t.Fatal(err)
		}
		sql := regexp.MustCompile(`--.*`).ReplaceAllString(string(b), "")
		first := locksTable.FindStringIndex(sql)
		if first == nil {
			continue
		}
		m := lockTimeout.FindStringSubmatchIndex(sql)
		switch {
		case m == nil || m[0] > first[0]:
			t.Errorf("db/migrations/%s takes a table lock without a lock_timeout: start it with set local lock_timeout = '%s'; (a deploy that cannot get the lock then stops before the switch instead of queueing every query on the table)", name, migrationLockTimeout)
		case sql[m[2]:m[3]] != migrationLockTimeout:
			t.Errorf("db/migrations/%s sets lock_timeout = '%s'; use '%s' (every query on the table waits behind the migration that long)", name, sql[m[2]:m[3]], migrationLockTimeout)
		}
	}
}

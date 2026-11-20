package migrate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/charles161/botlink/server/internal/exportomit"
)

// An older binary on the newer schema is the rollback (deploy/README.md: migrations are not reverted). For state an
// older binary would misread, the runbook names the statements to run before rolling back below the feature. 0056
// (event addresses a person approves): an approval sets verified_at, which a binary before 0056 reads as "the address
// proved itself" (it keeps calling it, lets the chat add other subscriptions on it without the check, has no Stop),
// and its sweeper and account delete never remove the request and refusal rows.
func TestRollbackNoteNamesWhatAnOlderBinaryMisreads(t *testing.T) {
	root := filepath.Join(migrationsDir, "..", "..")
	b, err := os.ReadFile(filepath.Join(root, "deploy", "README.md"))
	if err != nil {
		if why, ok := exportomit.Reason(root, "deploy/README.md"); ok {
			t.Skipf("deploy/README.md: not checked, left out of this public export (%s)", why)
		}
		t.Fatal(err)
	}
	for _, stmt := range []string{
		"delete from event_subscriptions where approved_by is not null;",
		"delete from event_url_requests;",
		"delete from event_url_refusals;",
	} {
		if !strings.Contains(string(b), stmt) {
			t.Errorf("deploy/README.md (Rollback) does not say to run %q before rolling the binary back below migration 0056", stmt)
		}
	}
}

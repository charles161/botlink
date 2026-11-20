package exportomit

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReason(t *testing.T) {
	root := t.TempDir()
	if _, ok := Reason(root, "deploy/README.md"); ok {
		t.Fatal("no .public-export (the private repository): nothing may be skipped")
	}
	if err := os.WriteFile(filepath.Join(root, ".public-export"), []byte("# header\ndeploy/  ops of the hosted service\ndeploy/README.md\tthe operator runbook\nevals/\tprivate runs\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for rel, want := range map[string]string{"deploy/README.md": "the operator runbook", "evals/results/x.json": "private runs", "server/x.go": "", "deploy/x": ""} {
		got, ok := Reason(root, rel)
		if got != want || ok != (want != "") {
			t.Errorf("Reason(%q) = %q, %v; want %q", rel, got, ok, want)
		}
	}
}

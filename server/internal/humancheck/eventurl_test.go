package humancheck

import (
	"testing"

	"github.com/charles161/botlink/server/internal/auth"
)

// Approving an event address (docs/protocol/event-url-approval.md §3) lets bot-link call an address nobody proved:
// a passkey every time, never the 60-minute skip nor the fresh-sign-in fallback, and its own action so its check
// serves no other approval.
func TestApproveEventURLAsksAPasskeyEveryTime(t *testing.T) {
	if !Actions[ApproveEventURLAction] || NoTarget[ApproveEventURLAction] {
		t.Fatalf("%s must be issued by POST /app/v1/human-check with a target", ApproveEventURLAction)
	}
	if !EveryTime[ApproveEventURLAction] {
		t.Fatalf("%s must ask a passkey every time (EveryTime)", ApproveEventURLAction)
	}
	fresh := &auth.Session{UVFresh: true, FreshLogin: true}
	if st := step("real", fresh, true, true, ApproveEventURLAction); st != "assert" {
		t.Fatalf("step with a fresh passkey and a fresh sign-in: %s, want assert", st)
	}
	if st := step("real", fresh, false, false, ApproveEventURLAction); st != "register" {
		t.Fatalf("step with no passkey yet: %s, want register (the first passkey, in this step)", st)
	}
}

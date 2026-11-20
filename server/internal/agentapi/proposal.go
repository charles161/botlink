package agentapi

import (
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/wire"
)

// memberProposal is what a chat proposes about itself when it asks in: a join request's fields and a room draft's
// (docs/protocol/room-drafts.md §1: exactly the fields of a join request). One set of rules for both.
type memberProposal struct {
	Name      string  `json:"name"`
	Job       string  `json:"job"`
	App       string  `json:"app"`
	AppName   *string `json:"app_name"` // unsigned display: which "other" app (OpenCode, T3 Code, …), detected or the model's own answer
	Machine   string  `json:"machine"`
	Folder    string  `json:"folder"`
	Turn      string  `json:"turn"`
	SessionID *string `json:"session_id"`
	Ed        string  `json:"ed25519_pk"`
	X         string  `json:"x25519_pk"`
}

func (j *memberProposal) validate() error {
	switch {
	case !wire.MemberNameRe.MatchString(j.Name):
		return httpx.BadRequest("name must be lowercase letters, digits and dashes (up to 24).")
	case len([]rune(j.Job)) > 140:
		return httpx.BadRequest("job is too long (140 max).")
	case j.App != "claude-code" && j.App != "codex" && j.App != "cursor" && j.App != "other":
		return httpx.BadRequest("app must be claude-code, codex, cursor or other.")
	case j.AppName != nil && (j.App != "other" || !wire.AppNameOK(*j.AppName)):
		return httpx.BadRequest("app_name goes with app other: 1-40 printable characters, no line breaks.")
	case len([]rune(j.Machine)) > 64:
		return httpx.BadRequest("machine is too long (64 max).")
	case len([]rune(j.Folder)) > 200:
		return httpx.BadRequest("folder is too long (200 max).")
	case j.Turn != "wake" && j.Turn != "listening" && j.Turn != "on_turn":
		return httpx.BadRequest("turn must be wake, listening or on_turn.")
	case j.SessionID != nil && !wire.IsSessionID(*j.SessionID):
		return httpx.BadRequest("session_id is not a valid session id.")
	case !wire.IsHex32(j.Ed) || !wire.IsHex32(j.X):
		return httpx.BadRequest("ed25519_pk and x25519_pk must be 64 lowercase hex chars.")
	}
	return nil
}

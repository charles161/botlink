// Package humancheck is the step-up on every approve (SPEC §4.1): a single-use 5-minute challenge, then
// Turnstile every time plus a WebAuthn check: on every join approval (EveryTime), and for other approvals when the
// session's uv_at is older than 60 min (first time: register in the same step). Any authenticator counts: this device's own, a phone (QR/hybrid) or a security key; user presence is
// required, user verification preferred (launch plan #4). "Turnstile + a fresh sign-in within 5 minutes" stays as the
// fallback for people with no authenticator at hand, except for join approvals. BOTLINK_HUMAN_CHECK=stub (dev) accepts {"stub": true}.
//
// Flow: Start → (browser) → Verify before the approve transaction (external calls happen outside any
// DB lock) → Consume inside the approve transaction (a rolled-back approve leaves the check reusable
// until it expires; WebAuthn is then skipped because uv_at was stamped, Turnstile needs a fresh token).
package humancheck

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/auth"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/wire"
)

var Actions = map[string]bool{"approve_join": true, "approve_person": true, "approve_device": true, "webauthn_register": true,
	"passkey_remove": true, DeviceRemoveAction: true, ConfirmRoomAction: true, ApproveJoinsAction: true}

// ApproveJoinsAction (target: the room; targets: the ticked join requests) approves up to MaxTargets waiting chats of
// one room in one step (SPEC §6.4 step 7a). The check stores TargetsDigest of the set and serves only that room and
// exactly that set (VerifySet, ConsumeSet); every other action's check has no set, so the two never stand in for each
// other. It asks a passkey every time, like a single join approval.
const ApproveJoinsAction = "approve_joins"

// MaxTargets: the most join requests one ApproveJoinsAction check (and so one batch) covers.
const MaxTargets = 5

// Targets checks the ticked set of a batch check: 1 to MaxTargets distinct request ids (lower-case UUIDs).
func Targets(ids []string) error {
	if len(ids) == 0 || len(ids) > MaxTargets {
		return httpx.BadRequest(fmt.Sprintf("Tick 1 to %d chats.", MaxTargets))
	}
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if !wire.IsUUID(id) {
			return httpx.BadRequest("Each id must be a uuid.")
		}
		if seen[id] {
			return httpx.BadRequest("Each chat once.")
		}
		seen[id] = true
	}
	return nil
}

// TargetsDigest is what a batch check stores of its set: sha256 over the sorted ids, so the order ticked does not
// matter and no other set has the same digest.
func TargetsDigest(ids []string) []byte {
	s := append([]string(nil), ids...)
	sort.Strings(s)
	h := sha256.Sum256([]byte("botlink-approve-joins-v1\n" + strings.Join(s, "\n")))
	return h[:]
}

// ConfirmRoomAction (target: the room draft) confirms a room a chat asked for (docs/protocol/room-drafts.md §3): it
// makes the room and lets the chat in, so it asks a passkey every time, like a join approval. Its own action, so a
// check issued for a confirm never serves an approval, nor the other way round.
const ConfirmRoomAction = "confirm_room"

// NoTarget lists the actions whose check names no target (the account's own passkeys, the admin area).
var NoTarget = map[string]bool{"webauthn_register": true, "passkey_remove": true, AdminAction: true,
	ResetCancelAction: true, ResetFinishAction: true}

// Lost passkey / lost laptop (prod-readiness blocker 5, migration 0042):
//   - DeviceRemoveAction (target: the device) removes a browser; it asserts a passkey every time, never skips.
//   - ResetCancelAction cancels a waiting passkey reset with any passkey of the account (assert).
//   - ResetFinishAction sets up the new passkey when the reset's wait is over (register, even though the account
//     still has its old passkeys: the caller removes them in the same transaction).
//
// The two reset actions are not in Actions: only StartReset issues them, after appapi checked the reset's state
// (open, ready, asked by this sign-in, a fresh sign-in), so POST /app/v1/human-check never hands one out.
const (
	DeviceRemoveAction = "device_remove"
	ResetCancelAction  = "passkey_reset_cancel"
	ResetFinishAction  = "passkey_reset_finish"
)

// AdminAction unlocks the owner-only admin area for one session (adminapi). It is not in Actions: only
// StartAdmin issues it, behind the admin gate, so POST /app/v1/human-check never reveals the feature.
const AdminAction = "admin"

type Checker struct {
	Mode            string // stub | real
	TurnstileSite   string
	TurnstileSecret string
	TurnstileURL    string
	HTTP            *http.Client
	WA              *webauthn.WebAuthn
}

func New(mode, site, secret, verifyURL, rpID, origin string) (*Checker, error) {
	c := &Checker{Mode: mode, TurnstileSite: site, TurnstileSecret: secret, TurnstileURL: verifyURL,
		HTTP: &http.Client{Timeout: 10 * time.Second}}
	wa, err := webauthn.New(&webauthn.Config{RPDisplayName: "bot-link", RPID: rpID, RPOrigins: []string{origin}})
	if err != nil {
		if mode == "real" {
			return nil, fmt.Errorf("webauthn config: %w", err)
		}
		return c, nil // stub mode never touches WebAuthn
	}
	c.WA = wa
	return c, nil
}

// Proof is HumanCheckProof.
type Proof struct {
	ID             string          `json:"id"`
	TurnstileToken *string         `json:"turnstile_token"`
	WebAuthn       json.RawMessage `json:"webauthn"`
	Stub           *bool           `json:"stub"`
}

func failed(reason string) *httpx.Error {
	return httpx.E(403, "human_check_failed", "The human check didn't pass. Try again.").With("reason", reason)
}

// waUser adapts an account to webauthn.User.
type waUser struct {
	id    []byte
	name  string
	disp  string
	creds []webauthn.Credential
	had   bool // the account has, or once had, a passkey (accounts.had_passkey_at, migration 0043)
}

func (u *waUser) WebAuthnID() []byte                         { return u.id }
func (u *waUser) WebAuthnName() string                       { return u.name }
func (u *waUser) WebAuthnDisplayName() string                { return u.disp }
func (u *waUser) WebAuthnCredentials() []webauthn.Credential { return u.creds }

func loadUser(ctx context.Context, q store.Q, s *auth.Session) (*waUser, error) {
	u := &waUser{id: []byte(s.AccountID), name: s.Email, disp: s.DisplayName}
	rows, err := q.Query(ctx, `select id, public_key, sign_count, coalesce(aaguid, ''::bytea), transports, flags
		from webauthn_credentials where account_id = $1`, s.AccountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var c webauthn.Credential
		var count int64
		var transports []string
		var flags int16
		if err := rows.Scan(&c.ID, &c.PublicKey, &count, &c.Authenticator.AAGUID, &transports, &flags); err != nil {
			return nil, err
		}
		c.Authenticator.SignCount = uint32(count)
		c.Flags = webauthn.NewCredentialFlags(protocol.AuthenticatorFlags(flags))
		for _, t := range transports {
			c.Transport = append(c.Transport, protocol.AuthenticatorTransport(t))
		}
		u.creds = append(u.creds, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if err := q.QueryRow(ctx, `select had_passkey_at is not null from accounts where id = $1`, s.AccountID).Scan(&u.had); err != nil {
		return nil, err
	}
	u.had = u.had || len(u.creds) > 0
	return u, rows.Err()
}

// EveryTime lists the approvals that ask for a fresh WebAuthn answer every time, with no skip window (security review
// 12 Nov 2026: an agent that can drive the browser passed Turnstile alone within the windows below). A join approval
// makes a chat that person's own: it reads what the room says and speaks as their chat. A touch on a security key, a
// fingerprint, or a phone passkey (QR) proves a human is at it; an agent clicking in the browser can't do that.
var EveryTime = map[string]bool{"approve_join": true, ApproveJoinsAction: true, ConfirmRoomAction: true}

// step: register (no credential yet) or assert. Other approvals skip when uv is fresh (< 60 min); a join approval never
// skips. The fresh-sign-in fallback (< 5 min, Turnstile still required) is only for an account that has no passkey yet:
// once it has one, signing in again (one click in a browser still signed in to Google or GitHub, a stolen laptop's
// included) never stands in for it (lost-passkey lane, 16 Nov 2026). The account's passkeys themselves (owner
// follow-up to the review, 12 Nov 2026): adding one asserts an existing one first (register only for the first),
// removing one always asserts. A "register" step anywhere, i.e. the account's FIRST passkey, also needs a sign-in
// within 5 minutes: otherwise a stolen session cookie could enrol its own key and pass every join approval with it.
// Removing a browser and cancelling a reset always assert; finishing a reset registers (its caller checks the sign-in).
// An account that ONCE had a passkey (had) and has none left never registers a "first" one and never falls back to
// the fresh sign-in: its step is "assert", which Start refuses with no_passkey, so the way back is a reset (security
// review of fix-all, finding 6: whoever controls the email account could otherwise enrol their own key).
func step(mode string, s *auth.Session, hasCred, had bool, action string) string {
	switch {
	case mode == "stub":
		return "skip"
	case action == ResetFinishAction:
		return "register"
	case action == "passkey_remove", action == DeviceRemoveAction, action == ResetCancelAction:
		return "assert"
	case !hasCred && had:
		return "assert"
	case action == "webauthn_register":
		if hasCred {
			return "assert"
		}
		return "register"
	case !EveryTime[action] && s.UVFresh:
		return "skip"
	case !EveryTime[action] && s.FreshLogin && !had:
		return "skip"
	case !hasCred:
		return "register"
	}
	return "assert"
}

// Start creates the challenge row and returns HumanCheckChallenge. targets: the ticked set of an ApproveJoinsAction
// check (required there, refused for every other action: nil).
func (c *Checker) Start(ctx context.Context, q store.Q, s *auth.Session, action string, target *string, targets []string) (map[string]any, error) {
	if !Actions[action] {
		return nil, httpx.BadRequest("Unknown action.")
	}
	if NoTarget[action] != (target == nil) {
		return nil, httpx.BadRequest("target_id is required for approvals and not allowed for webauthn_register or passkey_remove.")
	}
	if target != nil && !wire.IsUUID(*target) {
		return nil, httpx.BadRequest("target_id must be a uuid.")
	}
	if action != ApproveJoinsAction {
		if targets != nil {
			return nil, httpx.BadRequest("targets are only for approve_joins.")
		}
		return c.start(ctx, q, s, action, target, nil)
	}
	if err := Targets(targets); err != nil {
		return nil, err
	}
	return c.start(ctx, q, s, action, target, TargetsDigest(targets))
}

// StartReset creates a ResetCancelAction or ResetFinishAction challenge (no target). Callers must have checked the
// reset's state first (appapi/recovery.go).
func (c *Checker) StartReset(ctx context.Context, q store.Q, s *auth.Session, action string) (map[string]any, error) {
	if action != ResetCancelAction && action != ResetFinishAction {
		return nil, httpx.BadRequest("Unknown action.")
	}
	return c.start(ctx, q, s, action, nil, nil)
}

// StartAdmin creates an AdminAction challenge (no target). Callers must have checked the admin gate.
func (c *Checker) StartAdmin(ctx context.Context, q store.Q, s *auth.Session) (map[string]any, error) {
	return c.start(ctx, q, s, AdminAction, nil, nil)
}

func (c *Checker) start(ctx context.Context, q store.Q, s *auth.Session, action string, target *string, digest []byte) (map[string]any, error) {
	id := wire.NewV7().String()
	challenge := wire.RandBytes(32)
	var exp time.Time
	if err := q.QueryRow(ctx, `insert into human_checks (id, session_hash, account_id, action, target_id, targets_digest, challenge, expires_at)
		values ($1,$2,$3,$4,$5,$6,$7, now() + interval '5 minutes') returning expires_at`,
		id, s.Hash, s.AccountID, action, target, digest, challenge).Scan(&exp); err != nil {
		return nil, err
	}
	out := map[string]any{"id": id, "expires_at": exp.UTC(), "mode": c.Mode, "turnstile_site_key": nil}
	if c.Mode == "stub" {
		out["webauthn"] = map[string]any{"step": "skip"}
		return out, nil
	}
	out["turnstile_site_key"] = c.TurnstileSite
	u, err := loadUser(ctx, q, s)
	if err != nil {
		return nil, err
	}
	st := step(c.Mode, s, len(u.creds) > 0, u.had, action)
	if action == "passkey_remove" && len(u.creds) < 2 {
		return nil, httpx.E(409, "last_passkey", "This is your only passkey. Add another one before you remove it.")
	}
	if st == "assert" && len(u.creds) == 0 { // a passkey must exist to answer
		if u.had {
			return nil, httpx.E(409, "no_passkey", "None of your passkeys is left. Reset your passkeys on Your browsers.")
		}
		return nil, httpx.E(409, "no_passkey", "You have no passkey yet. Set one up on Your browsers first.")
	}
	wa := map[string]any{"step": st}
	switch st {
	case "register":
		excl := webauthn.Credentials(u.creds).CredentialDescriptors()
		if action == ResetFinishAction {
			excl = nil // the old passkeys go away in this step: a found-again security key may be set up anew
		}
		creation, _, err := c.WA.BeginRegistration(u,
			// Any authenticator (launch plan #4): this device's own (Face ID, fingerprint, Windows Hello), a phone via
			// QR/hybrid, or a security key. User verification is preferred, not required (a security key without a PIN
			// still proves a human touched it); user presence is always checked (verifyWebAuthn).
			webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
				UserVerification: protocol.VerificationPreferred,
				ResidentKey:      protocol.ResidentKeyRequirementDiscouraged}),
			webauthn.WithConveyancePreference(protocol.PreferNoAttestation),
			webauthn.WithExclusions(excl))
		if err != nil {
			return nil, err
		}
		creation.Response.Challenge = protocol.URLEncodedBase64(challenge)
		wa["options"] = creation.Response
	case "assert":
		assertion, _, err := c.WA.BeginLogin(u, webauthn.WithChallenge(challenge),
			webauthn.WithUserVerification(protocol.VerificationPreferred))
		if err != nil {
			return nil, err
		}
		wa["options"] = assertion.Response
	}
	out["webauthn"] = wa
	if action == "webauthn_register" && st == "assert" {
		// the new passkey, made after the existing one answered; its challenge is derived from this check's
		creation, err := c.creationOptions(u, RegisterChallenge(challenge))
		if err != nil {
			return nil, err
		}
		out["register"] = map[string]any{"options": creation}
	}
	return out, nil
}

// RegisterChallenge: the challenge of the NEW passkey in an "add a passkey" check (the check's own challenge is the
// assertion's). Derived, so it is as unpredictable and single-use as the check, with no second column.
func RegisterChallenge(challenge []byte) []byte {
	h := sha256.Sum256(append([]byte("botlink-passkey-register-v1\n"), challenge...))
	return h[:]
}

func (c *Checker) creationOptions(u *waUser, challenge []byte) (any, error) {
	creation, _, err := c.WA.BeginRegistration(u,
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			UserVerification: protocol.VerificationPreferred,
			ResidentKey:      protocol.ResidentKeyRequirementDiscouraged}),
		webauthn.WithConveyancePreference(protocol.PreferNoAttestation),
		webauthn.WithExclusions(webauthn.Credentials(u.creds).CredentialDescriptors()))
	if err != nil {
		return nil, err
	}
	creation.Response.Challenge = protocol.URLEncodedBase64(challenge)
	return creation.Response, nil
}

// Verify checks the proof against an unused, unexpired check of this session for (action, target).
// It does not consume it (Consume does, inside the approve transaction).
func (c *Checker) Verify(ctx context.Context, q store.Q, s *auth.Session, p *Proof, action, target, remoteIP string) error {
	_, _, err := c.verify(ctx, q, s, p, action, target, nil, remoteIP, true)
	return err
}

// VerifySet is Verify for an ApproveJoinsAction check: issued for this room (target) and exactly this set of ids.
func (c *Checker) VerifySet(ctx context.Context, q store.Q, s *auth.Session, p *Proof, target string, ids []string, remoteIP string) error {
	_, _, err := c.verify(ctx, q, s, p, ApproveJoinsAction, target, TargetsDigest(ids), remoteIP, true)
	return err
}

// VerifyCred is Verify for the account's own passkeys: it never takes the "already passed" shortcut and returns the
// credential that answered the assertion, or the new credential of a registration (nil for the stub), so a removal can
// refuse a passkey that vouches for itself and a reset knows which passkey to keep.
func (c *Checker) VerifyCred(ctx context.Context, q store.Q, s *auth.Session, p *Proof, action, remoteIP string) ([]byte, error) {
	used, _, err := c.verify(ctx, q, s, p, action, "", nil, remoteIP, false)
	return used, err
}

// VerifyAnswered is Verify that also returns the passkey that answered (nil for the stub), also when the same check is
// presented again after a member-list conflict.
func (c *Checker) VerifyAnswered(ctx context.Context, q store.Q, s *auth.Session, p *Proof, action, target, remoteIP string) ([]byte, error) {
	used, _, err := c.verify(ctx, q, s, p, action, target, nil, remoteIP, true)
	return used, err
}

// HeldPasskey is the new passkey of a reset's finish check, checked but not stored yet.
type HeldPasskey struct{ r *waResult }

// ID is the new passkey's credential id.
func (h *HeldPasskey) ID() []byte { return h.r.newCred.ID }

// Store saves the new passkey and stamps the session's uv. Call it inside the transaction that re-checks the reset and
// removes the old passkeys: a reset cancelled in between then adds nothing.
func (h *HeldPasskey) Store(ctx context.Context, q store.Q, s *auth.Session) error {
	return h.r.store(ctx, q, s)
}

// VerifyReset checks a ResetFinishAction proof (a registration plus Turnstile) and holds the new passkey back.
func (c *Checker) VerifyReset(ctx context.Context, q store.Q, s *auth.Session, p *Proof, remoteIP string) (*HeldPasskey, error) {
	_, held, err := c.verify(ctx, q, s, p, ResetFinishAction, "", nil, remoteIP, false)
	if err != nil {
		return nil, err
	}
	if held == nil || held.newCred == nil {
		return nil, failed("webauthn_register")
	}
	return &HeldPasskey{r: held}, nil
}

// verify: digest is the set of an ApproveJoinsAction check (nil for every other action, whose checks have none).
func (c *Checker) verify(ctx context.Context, q store.Q, s *auth.Session, p *Proof, action, target string, digest []byte, remoteIP string, reuse bool) ([]byte, *waResult, error) {
	if p == nil || !wire.IsUUID(p.ID) {
		return nil, nil, failed("missing")
	}
	var challenge, answered []byte
	var verified bool
	err := q.QueryRow(ctx, `select challenge, verified_at is not null, credential_id from human_checks where id = $1 and session_hash = $2 and account_id = $3 and action = $4
		and target_id is not distinct from $5::uuid and targets_digest is not distinct from $6::bytea and used_at is null and expires_at > now()`,
		p.ID, s.Hash, s.AccountID, action, nullable(target), digest).Scan(&challenge, &verified, &answered)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, failed("expired_or_used")
	}
	if err != nil {
		return nil, nil, err
	}
	// F6: this same unused check already passed (the approve lost a roster race and is being re-signed at the new
	// head). Turnstile tokens are single-use and WebAuthn answers can't be replayed, so don't ask them again.
	if verified {
		if !reuse {
			return nil, nil, failed("expired_or_used")
		}
		return answered, nil, nil
	}
	used, held, err := c.verifyOutside(ctx, q, s, p, challenge, action, remoteIP)
	if err != nil {
		return nil, nil, err
	}
	var cred []byte
	if held == nil {
		cred = used // an assertion (a registration's new id is not "the passkey that answered")
	}
	_, err = q.Exec(ctx, `update human_checks set verified_at = now(), credential_id = $2 where id = $1 and used_at is null`, p.ID, cred)
	return used, held, err
}

// verifyOutside: the stub flag, or WebAuthn (per step) + Turnstile. A reset's new passkey is returned held, not stored.
func (c *Checker) verifyOutside(ctx context.Context, q store.Q, s *auth.Session, p *Proof, challenge []byte, action, remoteIP string) ([]byte, *waResult, error) {
	if c.Mode == "stub" {
		if p.Stub == nil || !*p.Stub {
			return nil, nil, failed("stub_expected")
		}
		return nil, nil, nil
	}
	if p.Stub != nil {
		return nil, nil, failed("stub_not_allowed")
	}
	u, err := loadUser(ctx, q, s)
	if err != nil {
		return nil, nil, err
	}
	st := step(c.Mode, s, len(u.creds) > 0, u.had, action)
	hasWA := len(p.WebAuthn) > 0 && string(p.WebAuthn) != "null"
	var done *waResult
	switch {
	case hasWA && st != "skip":
		// the account's first passkey: only from a sign-in made in the last 5 minutes (a stolen session is older); a
		// reset's new passkey: its caller checked the sign-in against the configured age
		if st == "register" && !s.FreshLogin && action != ResetFinishAction {
			return nil, nil, failed("fresh_login_required")
		}
		if done, err = c.verifyWebAuthn(ctx, u, st, challenge, p.WebAuthn); err != nil {
			return nil, nil, err
		}
	case st == "skip": // uv fresh, or fresh sign-in (fallback); a WebAuthn answer is then ignored
	case st == "register" && !s.FreshLogin && action != ResetFinishAction:
		return nil, nil, failed("fresh_login_required")
	default:
		return nil, nil, failed("webauthn_or_fresh_login_required")
	}
	if p.TurnstileToken == nil || *p.TurnstileToken == "" {
		return nil, nil, failed("turnstile_missing")
	}
	if err := c.turnstile(ctx, *p.TurnstileToken, remoteIP); err != nil {
		return nil, nil, err
	}
	// only now, with Turnstile passed too: store a new credential / the counter, stamp uv
	if done == nil {
		return nil, nil, nil
	}
	if action == ResetFinishAction && done.newCred != nil {
		return nil, done, nil // stored by the caller's transaction (HeldPasskey.Store)
	}
	if err := done.store(ctx, q, s); err != nil {
		return nil, nil, err
	}
	if done.newCred != nil {
		return done.newCred.ID, nil, nil
	}
	return done.used, nil, nil
}

// waResult is a WebAuthn answer that checked out, kept until the rest of the check passed.
type waResult struct {
	newCred *webauthn.Credential // a registration
	used    []byte               // an assertion: the credential that answered
	count   uint32
}

func (r *waResult) store(ctx context.Context, q store.Q, s *auth.Session) error {
	if r.newCred != nil {
		if err := storeCredential(ctx, q, s, r.newCred); err != nil {
			return err
		}
	} else if _, err := q.Exec(ctx, `update webauthn_credentials c set sign_count = $2, last_used_at = now(),
			last_used_device_id = w.device_id, last_used_user_agent = w.user_agent
		from web_sessions w where c.id = $1 and w.token_hash = $3`, r.used, int64(r.count), s.Hash); err != nil {
		return err
	}
	_, err := q.Exec(ctx, `update web_sessions set uv_at = now() where token_hash = $1`, s.Hash)
	return err
}

// storeCredential saves a new passkey with where it was made: the browser key this sign-in declared (POST
// /app/v1/me/browser) and its user agent. The account then counts as having had a passkey, for good.
func storeCredential(ctx context.Context, q store.Q, s *auth.Session, cred *webauthn.Credential) error {
	transports := make([]string, 0, len(cred.Transport))
	for _, t := range cred.Transport {
		transports = append(transports, string(t))
	}
	if _, err := q.Exec(ctx, `insert into webauthn_credentials (id, account_id, public_key, sign_count, aaguid, transports, flags, last_used_at,
			created_device_id, created_user_agent)
		select $1,$2,$3,$4,$5,$6,$7, now(), w.device_id, coalesce(w.user_agent, '')
		from (select 1) x left join web_sessions w on w.token_hash = $8
		on conflict (id) do nothing`, cred.ID, s.AccountID, cred.PublicKey,
		int64(cred.Authenticator.SignCount), cred.Authenticator.AAGUID, transports, int16(cred.Flags.ProtocolValue()), s.Hash); err != nil {
		return err
	}
	_, err := q.Exec(ctx, `update accounts set had_passkey_at = coalesce(had_passkey_at, now()) where id = $1`, s.AccountID)
	return err
}

// RegisterNew checks the NEW credential of an "add a passkey" check whose existing-passkey assertion already passed
// (VerifyCred), against the check's derived challenge, and stores it. Call it inside the transaction that consumes
// the check.
func (c *Checker) RegisterNew(ctx context.Context, q store.Q, s *auth.Session, checkID string, raw json.RawMessage) error {
	if c.Mode == "stub" || c.WA == nil {
		return httpx.E(409, "passkeys_unavailable", "This server runs a stand-in human check: there are no passkeys to add.")
	}
	var challenge []byte
	err := q.QueryRow(ctx, `select challenge from human_checks where id = $1 and session_hash = $2 and account_id = $3
		and action = 'webauthn_register' and verified_at is not null and used_at is null and expires_at > now()`, checkID, s.Hash, s.AccountID).Scan(&challenge)
	if errors.Is(err, pgx.ErrNoRows) {
		return failed("expired_or_used")
	}
	if err != nil {
		return err
	}
	u, err := loadUser(ctx, q, s)
	if err != nil {
		return err
	}
	r, err := c.verifyWebAuthn(ctx, u, "register", RegisterChallenge(challenge), raw)
	if err != nil {
		return err
	}
	return storeCredential(ctx, q, s, r.newCred)
}

func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func (c *Checker) verifyWebAuthn(ctx context.Context, u *waUser, st string, challenge []byte, raw json.RawMessage) (*waResult, error) {
	sd := webauthn.SessionData{
		Challenge:        wire.B64URL(challenge),
		RelyingPartyID:   c.WA.Config.RPID,
		UserID:           u.id,
		UserVerification: protocol.VerificationPreferred,         // the library then checks user presence, not verification
		CredParams:       webauthn.CredentialParametersDefault(), // what BeginRegistration offered
		Expires:          time.Now().Add(5 * time.Minute),
	}
	switch st {
	case "register":
		parsed, err := protocol.ParseCredentialCreationResponseBytes(raw)
		if err != nil {
			return nil, failed("webauthn_parse")
		}
		cred, err := c.WA.CreateCredential(u, sd, parsed)
		if err != nil {
			slog.DebugContext(ctx, "webauthn registration refused", "err", err)
			return nil, failed("webauthn_register")
		}
		if !cred.Flags.UserPresent {
			return nil, failed("webauthn_up")
		}
		for _, have := range u.creds {
			if string(have.ID) == string(cred.ID) {
				return nil, failed("webauthn_register")
			}
		}
		return &waResult{newCred: cred}, nil
	case "assert":
		parsed, err := protocol.ParseCredentialRequestResponseBytes(raw)
		if err != nil {
			return nil, failed("webauthn_parse")
		}
		for _, cr := range u.creds {
			sd.AllowedCredentialIDs = append(sd.AllowedCredentialIDs, cr.ID)
		}
		cred, err := c.WA.ValidateLogin(u, sd, parsed)
		if err != nil {
			slog.DebugContext(ctx, "webauthn assertion refused", "err", err)
			return nil, failed("webauthn_assert")
		}
		if !cred.Flags.UserPresent {
			return nil, failed("webauthn_up")
		}
		if cred.Authenticator.CloneWarning {
			return nil, failed("webauthn_clone")
		}
		return &waResult{used: cred.ID, count: cred.Authenticator.SignCount}, nil
	}
	return nil, failed("webauthn_step")
}

func (c *Checker) turnstile(ctx context.Context, token, ip string) error {
	form := url.Values{"secret": {c.TurnstileSecret}, "response": {token}}
	if ip != "" {
		form.Set("remoteip", ip)
	}
	req, err := http.NewRequestWithContext(ctx, "POST", c.TurnstileURL, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return httpx.Unavailable(fmt.Errorf("turnstile: %w", err))
	}
	defer resp.Body.Close()
	var out struct {
		Success bool `json:"success"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 16<<10)).Decode(&out); err != nil || !out.Success {
		return failed("turnstile")
	}
	return nil
}

// ConsumeSet marks an ApproveJoinsAction check used inside the batch's transaction, only for the room and the exact set
// it was issued for (VerifySet already checked that; this keeps the binding in the statement that uses it up).
func ConsumeSet(ctx context.Context, tx pgx.Tx, id string, s *auth.Session, target string, ids []string) error {
	tag, err := tx.Exec(ctx, `update human_checks set used_at = now() where id = $1 and session_hash = $2 and account_id = $3
		and action = $4 and target_id = $5::uuid and targets_digest = $6 and used_at is null and expires_at > now()`,
		id, s.Hash, s.AccountID, ApproveJoinsAction, target, TargetsDigest(ids))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return failed("expired_or_used")
	}
	return nil
}

// Spend uses up a check that approved nothing, in a transaction that commits without the refused approval: an approval
// refused because its target was not the caller's to approve (someone else's join request, a draft held by no one or
// another) must not leave a passed check behind, or a takeover that needs no check (a join request's readdress, a
// draft's claim) would let it approve later with no new passkey answer.
func Spend(ctx context.Context, q store.Q, id string, s *auth.Session) error {
	_, err := q.Exec(ctx, `update human_checks set used_at = now() where id = $1 and session_hash = $2 and used_at is null`, id, s.Hash)
	return err
}

// Consume marks the check used inside the approve transaction.
func Consume(ctx context.Context, tx pgx.Tx, id string, s *auth.Session) error {
	tag, err := tx.Exec(ctx, `update human_checks set used_at = now() where id = $1 and session_hash = $2 and used_at is null and expires_at > now()`,
		id, s.Hash)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return failed("expired_or_used")
	}
	return nil
}

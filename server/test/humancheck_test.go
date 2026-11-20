package test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/fxamacker/cbor/v2"

	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/roster"
)

// softAuthenticator is a platform authenticator in software: ES256, attestation "none", UP+UV set.
type softAuthenticator struct {
	key    *ecdsa.PrivateKey
	credID []byte
	count  uint32
	rpID   string
	origin string
	noUV   bool
	noUP   bool // no user presence (nobody touched it): always refused
	cross  bool // a roaming authenticator (phone via hybrid/QR, security key) instead of a platform one
}

func newSoftAuth(rpID, origin string) *softAuthenticator {
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	id := make([]byte, 16)
	_, _ = rand.Read(id)
	return &softAuthenticator{key: k, credID: id, rpID: rpID, origin: origin}
}

func b64u(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func (a *softAuthenticator) flags(attested bool) byte {
	f := byte(0)
	if !a.noUP {
		f |= 0x01 // UP
	}
	if !a.noUV {
		f |= 0x04 // UV
	}
	if attested {
		f |= 0x40 // AT
	}
	return f
}

func (a *softAuthenticator) authData(attested bool) []byte {
	rp := sha256.Sum256([]byte(a.rpID))
	a.count++
	out := append([]byte{}, rp[:]...)
	out = append(out, a.flags(attested))
	out = binary.BigEndian.AppendUint32(out, a.count)
	if attested {
		out = append(out, make([]byte, 16)...) // AAGUID
		out = binary.BigEndian.AppendUint16(out, uint16(len(a.credID)))
		out = append(out, a.credID...)
		x, y := a.key.PublicKey.X.FillBytes(make([]byte, 32)), a.key.PublicKey.Y.FillBytes(make([]byte, 32))
		cose, _ := cbor.Marshal(map[int]any{1: 2, 3: -7, -1: 1, -2: x, -3: y})
		out = append(out, cose...)
	}
	return out
}

func (a *softAuthenticator) clientData(typ, challenge string) []byte {
	b, _ := json.Marshal(map[string]any{"type": typ, "challenge": challenge, "origin": a.origin, "crossOrigin": false})
	return b
}

func (a *softAuthenticator) attachment() (string, []string) {
	if a.cross {
		return "cross-platform", []string{"hybrid", "usb"}
	}
	return "platform", []string{"internal"}
}

// Register answers PublicKeyCredentialCreationOptions.
func (a *softAuthenticator) Register(options map[string]any) map[string]any {
	att0, tr := a.attachment()
	cd := a.clientData("webauthn.create", options["challenge"].(string))
	att, _ := cbor.Marshal(map[string]any{"fmt": "none", "attStmt": map[string]any{}, "authData": a.authData(true)})
	return map[string]any{"id": b64u(a.credID), "rawId": b64u(a.credID), "type": "public-key",
		"response":                map[string]any{"clientDataJSON": b64u(cd), "attestationObject": b64u(att), "transports": tr},
		"authenticatorAttachment": att0, "clientExtensionResults": map[string]any{}}
}

// Assert answers PublicKeyCredentialRequestOptions.
func (a *softAuthenticator) Assert(options map[string]any, userHandle []byte) map[string]any {
	cd := a.clientData("webauthn.get", options["challenge"].(string))
	ad := a.authData(false)
	h := sha256.Sum256(cd)
	digest := sha256.Sum256(append(append([]byte{}, ad...), h[:]...))
	sig, _ := ecdsa.SignASN1(rand.Reader, a.key, digest[:])
	att0, _ := a.attachment()
	return map[string]any{"id": b64u(a.credID), "rawId": b64u(a.credID), "type": "public-key",
		"response":                map[string]any{"clientDataJSON": b64u(cd), "authenticatorData": b64u(ad), "signature": b64u(sig), "userHandle": b64u(userHandle)},
		"authenticatorAttachment": att0, "clientExtensionResults": map[string]any{}}
}

// Real mode: Turnstile every time; WebAuthn registered on first approve, asserted when uv is stale, skipped while
// fresh, except for join approvals (asked every time); devices without an authenticator fall back to a fresh sign-in
// (≤ 5 min) for approvals other than joins.
func TestRealHumanCheck(t *testing.T) {
	var tsCalls atomic.Int32
	turnstile := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		tsCalls.Add(1)
		ok := r.Form.Get("secret") == "1x0000000000000000000000000000000AA" && r.Form.Get("response") == "XXXX.DUMMY.TOKEN.XXXX"
		_ = json.NewEncoder(w).Encode(map[string]any{"success": ok})
	}))
	defer turnstile.Close()
	c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) {
		cfg.HumanCheck = "real"
		cfg.TurnstileSiteKey = "1x00000000000000000000AA" // Cloudflare's always-pass test keys
		cfg.TurnstileSecret = "1x0000000000000000000000000000000AA"
		cfg.TurnstileVerifyURL = turnstile.URL
	})
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("real")
	auth := newSoftAuth("localhost", c.URL)

	start := func(a *Agent) map[string]any {
		if r := a.Join(c, adam.Invite(room)); r.Status != 201 {
			t.Fatal(r)
		}
		r := adam.Do("POST", "/app/v1/human-check", map[string]any{"action": "approve_join", "target_id": a.ReqID})
		if r.Status != 200 || r.Str("mode") != "real" || r.J["turnstile_site_key"] == nil {
			t.Fatal(r)
		}
		return r.J
	}
	approve := func(a *Agent, proof map[string]any) *Resp {
		adam.Sync(room)
		e := room.Log.Build("member_add", adam.Dev, map[string]any{"member": joinCardMember(t, adam, a.ReqID), "account": adam.AccountID, "name": a.Name,
			"app": "claude-code", "ed": a.Key.Hex(), "x": hexs(a.X)})
		r := adam.Do("POST", "/app/v1/join-requests/"+a.ReqID+"/approve", map[string]any{"human_check": proof, "roster_entry": e})
		if r.Status == 200 {
			room.Log.Push(e)
		}
		return r
	}
	good := "XXXX.DUMMY.TOKEN.XXXX"

	// 1. fresh dev sign-in (< 5 min) and no authenticator: a join approval has no fallback (security review 12 Nov
	// 2026: every join approval needs a fresh passkey answer); stub and a missing Turnstile are refused as before
	a1 := NewAgentKeys(t, "one")
	ch := start(a1)
	if ch["webauthn"].(map[string]any)["step"] != "register" {
		t.Fatalf("fresh sign-in must not skip WebAuthn for a join approval: %v", ch)
	}
	if r := approve(a1, map[string]any{"id": ch["id"], "stub": true}); r.Code() != "human_check_failed" {
		t.Fatalf("stub in real mode: %s", r)
	}
	if r := approve(a1, map[string]any{"id": ch["id"]}); r.Code() != "human_check_failed" {
		t.Fatalf("no turnstile: %s", r)
	}
	if r := approve(a1, map[string]any{"id": ch["id"], "turnstile_token": good}); r.Code() != "human_check_failed" {
		t.Fatalf("fresh-login fallback accepted for a join: %s", r)
	}
	// 2. stale sign-in: fallback refused; register a platform credential in the same step
	exec(t, c, `update web_sessions set created_at = now() - interval '10 minutes'`)
	a2 := NewAgentKeys(t, "two")
	ch = start(a2)
	if ch["webauthn"].(map[string]any)["step"] != "register" {
		t.Fatalf("stale sign-in without a credential should register: %v", ch)
	}
	if r := approve(a2, map[string]any{"id": ch["id"], "turnstile_token": good}); r.Code() != "human_check_failed" {
		t.Fatalf("stale fallback accepted: %s", r)
	}
	opts := ch["webauthn"].(map[string]any)["options"].(map[string]any)
	bad := newSoftAuth("localhost", c.URL)
	bad.noUP = true
	if r := approve(a2, map[string]any{"id": ch["id"], "turnstile_token": good, "webauthn": bad.Register(opts)}); r.Code() != "human_check_failed" {
		t.Fatalf("credential without user presence accepted: %s", r)
	}
	// the account's FIRST passkey only from a sign-in within 5 minutes (a stolen, older session can't enrol its own)
	if r := approve(a2, map[string]any{"id": ch["id"], "turnstile_token": good, "webauthn": auth.Register(opts)}); r.Code() != "human_check_failed" ||
		r.J["error"].(map[string]any)["details"].(map[string]any)["reason"] != "fresh_login_required" {
		t.Fatalf("first passkey from a stale sign-in: %s", r)
	}
	adam = reSignIn(t, adam) // a fresh sign-in is a new sign-in
	ch = newCheck(t, adam, a2.ReqID)
	opts = ch["webauthn"].(map[string]any)["options"].(map[string]any)
	if r := approve(a2, map[string]any{"id": ch["id"], "turnstile_token": "wrong", "webauthn": auth.Register(opts)}); r.Code() != "human_check_failed" ||
		r.J["error"].(map[string]any)["details"].(map[string]any)["reason"] != "turnstile" {
		t.Fatalf("bad turnstile accepted: %s", r)
	}
	if n := count(t, c, `select count(*) from webauthn_credentials where account_id = $1`, adam.AccountID); n != 0 {
		t.Fatalf("a registration whose Turnstile failed was stored: %d", n)
	}
	ch = newCheck(t, adam, a2.ReqID)
	if r := approve(a2, map[string]any{"id": ch["id"], "turnstile_token": good, "webauthn": auth.Register(ch["webauthn"].(map[string]any)["options"].(map[string]any))}); r.Status != 200 {
		t.Fatalf("first passkey from a fresh sign-in: %s", r)
	}
	// uv is fresh now: other approvals skip WebAuthn for 60 min, a join approval asks again
	if r := adam.Do("POST", "/app/v1/human-check", map[string]any{"action": "approve_device", "target_id": adam.DevID}); r.Status != 200 || r.J["webauthn"].(map[string]any)["step"] != "skip" {
		t.Fatalf("after registration + uv a device approval should skip WebAuthn: %s", r)
	}
	ch = start(NewAgentKeys(t, "probe"))
	if step := ch["webauthn"].(map[string]any)["step"]; step != "assert" {
		t.Fatalf("after registration + uv a join approval should assert again, got %v", step)
	}
	a2b := NewAgentKeys(t, "twob")
	start(a2b)
	if r := approve(a2b, map[string]any{"id": mustCheck(t, adam, a2b.ReqID), "turnstile_token": good}); r.Code() != "human_check_failed" {
		t.Fatalf("join approved with fresh uv and no passkey answer: %s", r)
	}
	ch = newCheck(t, adam, a2b.ReqID)
	if r := approve(a2b, map[string]any{"id": ch["id"], "turnstile_token": good, "webauthn": auth.Assert(ch["webauthn"].(map[string]any)["options"].(map[string]any), []byte(adam.AccountID))}); r.Status != 200 {
		t.Fatalf("approve with a fresh assertion: %s", r)
	}
	// 3. uv older than 60 min → assert with the registered credential
	exec(t, c, `update web_sessions set uv_at = now() - interval '61 minutes'`)
	a3 := NewAgentKeys(t, "three")
	ch = start(a3)
	wa := ch["webauthn"].(map[string]any)
	if wa["step"] != "assert" {
		t.Fatalf("stale uv should assert: %v", wa)
	}
	if r := approve(a3, map[string]any{"id": ch["id"], "turnstile_token": good, "webauthn": auth.Assert(wa["options"].(map[string]any), []byte(adam.AccountID))}); r.Status != 200 {
		t.Fatalf("assertion: %s", r)
	}
	if count(t, c, `select count(*) from webauthn_credentials where account_id = $1 and sign_count >= 2`, adam.AccountID) != 1 {
		t.Fatal("sign count not stored")
	}
	if tsCalls.Load() < 3 {
		t.Fatalf("turnstile verified only %d times", tsCalls.Load())
	}
	if me := adam.Do("GET", "/app/v1/me", nil); me.J["webauthn_registered"] != true || me.J["uv_fresh"] != true || me.Str("human_check_mode") != "real" {
		t.Fatal(me)
	}
}

func mustCheck(t *testing.T, p *Person, target string) string {
	return p.Check("approve_join", target)
}

func joinCardMember(t *testing.T, p *Person, reqID string) string {
	for _, j := range p.Do("GET", "/app/v1/needs-you", nil).J["join_requests"].([]any) {
		if j.(map[string]any)["id"] == reqID {
			return j.(map[string]any)["member_id"].(string)
		}
	}
	t.Fatalf("request %s not pending", reqID)
	return ""
}

// FINDINGS F6: two joins approved at once at the same roster head. The loser gets 409 roster_conflict; the dashboard
// re-signs at the new head and retries with the SAME human check. In real mode that must not re-ask Turnstile (its
// tokens are single-use, as here) or WebAuthn: the check passed once and is still unused. Both joins end up in.
func TestApproveRaceRetrySameCheck(t *testing.T) {
	var mu sync.Mutex
	used := map[string]int{}
	turnstile := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		tok := r.Form.Get("response")
		mu.Lock()
		used[tok]++
		n := used[tok]
		mu.Unlock()
		// like Cloudflare: a token verifies once ("timeout-or-duplicate" after that)
		_ = json.NewEncoder(w).Encode(map[string]any{"success": n == 1 && strings.HasPrefix(tok, "tok-")})
	}))
	defer turnstile.Close()
	c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) {
		cfg.HumanCheck = "real"
		cfg.TurnstileSiteKey = "1x00000000000000000000AA"
		cfg.TurnstileSecret = "1x0000000000000000000000000000000AA"
		cfg.TurnstileVerifyURL = turnstile.URL
	})
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("race")
	a1, a2 := NewAgentKeys(t, "first"), NewAgentKeys(t, "second")
	for _, a := range []*Agent{a1, a2} {
		if r := a.Join(c, adam.Invite(room)); r.Status != 201 {
			t.Fatal(r)
		}
	}
	// every join approval answers WebAuthn (both register here: no credential yet when the checks open); Turnstile on
	// every check
	k1 := newSoftAuth("localhost", c.URL)
	c1 := newCheck(t, adam, a1.ReqID)
	p1 := map[string]any{"id": c1["id"], "turnstile_token": "tok-1", "webauthn": k1.Register(c1["webauthn"].(map[string]any)["options"].(map[string]any))}
	var p2 map[string]any // opened after the first approval (a dashboard opens the check when Approve is clicked)
	mids := map[string]string{}
	entry := func(a *Agent) roster.Wire {
		if mids[a.ReqID] == "" {
			mids[a.ReqID] = joinCardMember(t, adam, a.ReqID)
		}
		return room.Log.Build("member_add", adam.Dev, map[string]any{"member": mids[a.ReqID], "account": adam.AccountID, "name": a.Name,
			"app": "claude-code", "ed": a.Key.Hex(), "x": hexs(a.X)})
	}
	approve := func(a *Agent, proof map[string]any, e roster.Wire) *Resp {
		return adam.Do("POST", "/app/v1/join-requests/"+a.ReqID+"/approve", map[string]any{"human_check": proof, "roster_entry": e})
	}
	// both cards signed at the same head (two clicks before either answer came back)
	adam.Sync(room)
	e1, e2 := entry(a1), entry(a2)
	if r := approve(a1, p1, e1); r.Status != 200 {
		t.Fatalf("first approve: %s", r)
	}
	c2 := newCheck(t, adam, a2.ReqID)
	p2 = map[string]any{"id": c2["id"], "turnstile_token": "tok-2", "webauthn": k1.Assert(c2["webauthn"].(map[string]any)["options"].(map[string]any), []byte(adam.AccountID))}
	r := approve(a2, p2, e2)
	if r.Code() != "roster_conflict" {
		t.Fatalf("second approve at the old head should be roster_conflict, got %s", r)
	}
	// the dashboard's automatic retry: re-read the head, re-sign, same check
	adam.Sync(room)
	if r := approve(a2, p2, entry(a2)); r.Status != 200 {
		t.Fatalf("retry with the same check after roster_conflict: %s", r)
	}
	if n := count(t, c, `select count(*) from members where room_id = $1 and removed_at is null`, room.ID); n != 2 {
		t.Fatalf("members after both approvals: %d", n)
	}
	mu.Lock()
	if used["tok-1"] != 1 || used["tok-2"] != 1 {
		t.Fatalf("each Turnstile token must be verified exactly once, got %v", used)
	}
	mu.Unlock()
	// still single use: the same check can't approve anything again
	a3 := NewAgentKeys(t, "third")
	if r := a3.Join(c, adam.Invite(room)); r.Status != 201 {
		t.Fatal(r)
	}
	adam.Sync(room)
	if r := approve(a2, p2, entry(a2)); r.Status == 200 {
		t.Fatalf("a used check approved again: %s", r)
	}
	// and a verified-but-unused check is bound to its target: it can't approve another request
	p3 := map[string]any{"id": mustCheck(t, adam, a3.ReqID), "turnstile_token": "tok-3"}
	other := NewAgentKeys(t, "fourth")
	if r := other.Join(c, adam.Invite(room)); r.Status != 201 {
		t.Fatal(r)
	}
	adam.Sync(room)
	if r := approve(other, p3, entry(other)); r.Code() != "human_check_failed" {
		t.Fatalf("a check for another request was accepted: %s", r)
	}
}

// Launch plan #4: a person whose computer has no fingerprint reader (a Linux desktop) approves with a phone
// (hybrid/QR) or a security key. The options must not demand a platform authenticator, and user verification is
// preferred, not required: a security key without a PIN (user presence only) passes. User presence (a human touched
// it) and Turnstile stay required on every check.
func TestHumanCheckRoamingAuthenticator(t *testing.T) {
	turnstile := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		_ = json.NewEncoder(w).Encode(map[string]any{"success": r.Form.Get("response") == "XXXX.DUMMY.TOKEN.XXXX"})
	}))
	defer turnstile.Close()
	c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) {
		cfg.HumanCheck = "real"
		cfg.TurnstileSiteKey = "1x00000000000000000000AA"
		cfg.TurnstileSecret = "1x0000000000000000000000000000000AA"
		cfg.TurnstileVerifyURL = turnstile.URL
	})
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("roam")
	key := newSoftAuth("localhost", c.URL)
	key.cross, key.noUV = true, true // a security key without a PIN
	good := "XXXX.DUMMY.TOKEN.XXXX"
	start := func(a *Agent) map[string]any {
		if r := a.Join(c, adam.Invite(room)); r.Status != 201 {
			t.Fatal(r)
		}
		r := adam.Do("POST", "/app/v1/human-check", map[string]any{"action": "approve_join", "target_id": a.ReqID})
		if r.Status != 200 {
			t.Fatal(r)
		}
		return r.J["webauthn"].(map[string]any)
	}
	approve := func(a *Agent, proof map[string]any) *Resp {
		adam.Sync(room)
		e := room.Log.Build("member_add", adam.Dev, map[string]any{"member": joinCardMember(t, adam, a.ReqID), "account": adam.AccountID, "name": a.Name,
			"app": "claude-code", "ed": a.Key.Hex(), "x": hexs(a.X)})
		r := adam.Do("POST", "/app/v1/join-requests/"+a.ReqID+"/approve", map[string]any{"human_check": proof, "roster_entry": e})
		if r.Status == 200 {
			room.Log.Push(e)
		}
		return r
	}

	// register: any authenticator (no "platform" attachment), user verification preferred
	exec(t, c, `update web_sessions set created_at = now() - interval '10 minutes'`)
	a1 := NewAgentKeys(t, "one")
	wa := start(a1)
	if wa["step"] != "register" {
		t.Fatalf("want register: %v", wa)
	}
	opts := wa["options"].(map[string]any)
	sel, _ := opts["authenticatorSelection"].(map[string]any)
	if sel == nil || sel["userVerification"] != "preferred" {
		t.Fatalf("registration must prefer (not require) user verification: %v", sel)
	}
	if att, ok := sel["authenticatorAttachment"]; ok && att != "" {
		t.Fatalf("registration must not demand an attachment (got %v): a phone or a security key has to work", att)
	}
	// the account's first passkey needs a sign-in within 5 minutes (passkey follow-up); sign in again
	adam = reSignIn(t, adam) // a fresh sign-in is a new sign-in
	// no user presence: refused even with a good Turnstile token
	nobody := newSoftAuth("localhost", c.URL)
	nobody.cross, nobody.noUP = true, true
	ch := newCheck(t, adam, a1.ReqID)
	if r := approve(a1, map[string]any{"id": ch["id"], "turnstile_token": good, "webauthn": nobody.Register(ch["webauthn"].(map[string]any)["options"].(map[string]any))}); r.Code() != "human_check_failed" {
		t.Fatalf("registration without user presence accepted: %s", r)
	}
	ch = newCheck(t, adam, a1.ReqID)
	if r := approve(a1, map[string]any{"id": ch["id"], "turnstile_token": good, "webauthn": key.Register(ch["webauthn"].(map[string]any)["options"].(map[string]any))}); r.Status != 200 {
		t.Fatalf("security key without PIN refused at registration: %s", r)
	}

	// assert: user verification preferred; a touch (UP) is enough, no touch is refused
	exec(t, c, `update web_sessions set uv_at = now() - interval '61 minutes'`)
	a2 := NewAgentKeys(t, "two")
	wa = start(a2)
	if wa["step"] != "assert" {
		t.Fatalf("want assert: %v", wa)
	}
	ao := wa["options"].(map[string]any)
	if ao["userVerification"] != "preferred" {
		t.Fatalf("assertion must prefer (not require) user verification: %v", ao["userVerification"])
	}
	untouched := *key
	untouched.noUP = true
	ch = newCheck(t, adam, a2.ReqID)
	if r := approve(a2, map[string]any{"id": ch["id"], "turnstile_token": good, "webauthn": untouched.Assert(ch["webauthn"].(map[string]any)["options"].(map[string]any), []byte(adam.AccountID))}); r.Code() != "human_check_failed" {
		t.Fatalf("assertion without user presence accepted: %s", r)
	}
	key.count = untouched.count // the counter moved on the refused try
	ch = newCheck(t, adam, a2.ReqID)
	if r := approve(a2, map[string]any{"id": ch["id"], "turnstile_token": "wrong", "webauthn": key.Assert(ch["webauthn"].(map[string]any)["options"].(map[string]any), []byte(adam.AccountID))}); r.Code() != "human_check_failed" {
		t.Fatalf("bad turnstile accepted: %s", r)
	}
	ch = newCheck(t, adam, a2.ReqID)
	if r := approve(a2, map[string]any{"id": ch["id"], "turnstile_token": good}); r.Code() != "human_check_failed" {
		// the previous try passed WebAuthn before Turnstile failed: a join approval still asks again
		t.Fatalf("join approved on the previous try's WebAuthn: %s", r)
	}
	ch = newCheck(t, adam, a2.ReqID)
	if r := approve(a2, map[string]any{"id": ch["id"], "turnstile_token": good, "webauthn": key.Assert(ch["webauthn"].(map[string]any)["options"].(map[string]any), []byte(adam.AccountID))}); r.Status != 200 {
		t.Fatalf("approve after a security-key assertion: %s", r)
	}
}

// newCheck opens a fresh human check for a join request.
func newCheck(t *testing.T, p *Person, target string) map[string]any {
	r := p.Do("POST", "/app/v1/human-check", map[string]any{"action": "approve_join", "target_id": target})
	if r.Status != 200 {
		t.Fatal(r)
	}
	return r.J
}

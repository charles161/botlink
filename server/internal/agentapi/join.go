package agentapi

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/analytics"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/plans"
	"github.com/charles161/botlink/server/internal/ratelimit"
	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/wake"
	"github.com/charles161/botlink/server/internal/wire"
)

func inviteInvalid() *httpx.Error {
	return httpx.E(404, "invite_invalid", "This invite doesn't work. It may be wrong, expired or turned off.")
}

// Invite is a usable chat invite (kind chat, not off, not expired, room alive, person still in the room).
type Invite struct {
	ID, RoomID, AccountID, Code    string
	ExpiresAt                      time.Time
	RoomName, RoomPurpose, Inviter string
}

// LookupChatInvite finds a usable chat invite by code. forUpdate locks the invite row (use counter).
func LookupChatInvite(ctx context.Context, q store.Q, code string, forUpdate bool) (*Invite, error) {
	lock := ""
	if forUpdate {
		lock = " for update of i"
	}
	inv := &Invite{}
	err := q.QueryRow(ctx, `
		select i.id, i.room_id, i.account_id, i.code, i.expires_at, r.name, r.purpose, a.display_name
		from invites i join rooms r on r.id = i.room_id join accounts a on a.id = i.account_id
		join room_people p on p.room_id = i.room_id and p.account_id = i.account_id and p.removed_at is null
		where i.code = $1 and i.kind = 'chat' and not i.off and i.expires_at > now() and r.deleted_at is null`+lock, code).Scan(
		&inv.ID, &inv.RoomID, &inv.AccountID, &inv.Code, &inv.ExpiresAt, &inv.RoomName, &inv.RoomPurpose, &inv.Inviter)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, inviteInvalid()
	}
	return inv, err
}

// InvitePreview builds the InvitePreview schema; failed lookups count against the caller IP (20/hour).
func InvitePreview(ctx context.Context, q store.Q, ip, raw string) (*Invite, map[string]any, error) {
	if over, retry, err := ratelimit.Over(ctx, q, ratelimit.InviteFailIP, ip); err != nil {
		return nil, nil, err
	} else if over {
		return nil, nil, httpx.RateLimited("", retry)
	}
	code, ok := wire.ParseInviteCode(raw, 10)
	var inv *Invite
	var err error
	if ok {
		inv, err = LookupChatInvite(ctx, q, code, false)
	} else {
		err = inviteInvalid()
	}
	if err != nil {
		var he *httpx.Error
		if errors.As(err, &he) && he.Code == "invite_invalid" {
			if cerr := ratelimit.Count(ctx, q, ratelimit.InviteFailIP, ip); cerr != nil {
				return nil, nil, cerr
			}
		}
		return nil, nil, err
	}
	// Anyone holding the link sees this, and links leak: the room name, how many chats are in it and the expiry. The
	// inviter, the purpose and the roster come only after approval (signed roster call; the dashboard for people).
	var count int
	if err := q.QueryRow(ctx, `select count(*) from members where room_id = $1 and removed_at is null`, inv.RoomID).Scan(&count); err != nil {
		return nil, nil, err
	}
	return inv, map[string]any{
		"room":         map[string]any{"name": inv.RoomName},
		"member_count": count,
		"expires_at":   inv.ExpiresAt.UTC(),
	}, nil
}

func (a *API) getInvite(w http.ResponseWriter, r *http.Request) error {
	_, v, err := InvitePreview(r.Context(), a.St.Pool, httpx.ClientIP(r, a.Cfg.TrustCF), r.PathValue("invite"))
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, v)
	return nil
}

type joinCreate struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Invite string `json:"invite"`
	memberProposal
}

func (j *joinCreate) validate() error {
	switch {
	case !wire.IsUUID(j.ID):
		return httpx.BadRequest("id must be a lowercase uuid.")
	case j.Kind != "join" && j.Kind != "claim":
		return httpx.BadRequest("kind must be join or claim.")
	}
	return j.memberProposal.validate()
}

// JoinRequestView builds the JoinRequestView schema for one request.
func (a *API) joinView(ctx context.Context, q store.Q, id string) (map[string]any, error) {
	var kind, status, code, roomID, roomName, purpose, approver, approverAccount, memberID string
	var moveTo *string
	var ed, x []byte
	var exp time.Time
	err := q.QueryRow(ctx, `
		select j.kind, case when j.status = 'pending' and j.expires_at <= now() then 'expired' else j.status end,
		       j.match_code, j.room_id, r.name, r.purpose, a.display_name, j.for_account_id, j.member_id, j.ed25519_pk, j.x25519_pk, j.expires_at, j.move_to
		from join_requests j join rooms r on r.id = j.room_id join accounts a on a.id = j.for_account_id
		where j.id = $1`, id).Scan(&kind, &status, &code, &roomID, &roomName, &purpose, &approver, &approverAccount, &memberID, &ed, &x, &exp, &moveTo)
	if err != nil {
		return nil, err
	}
	v := map[string]any{
		"id": id, "kind": kind, "status": status, "match_code": code, "fingerprint": wire.MemberFP(ed, x),
		"room":          map[string]any{"id": roomID, "name": roomName, "purpose": purpose},
		"approver_name": approver,
		// ENVELOPE §5.4: the account whose member_add the client's self-check requires (it learns it at create, before
		// anyone can approve; it changes only by the one takeover of a pending join, security review item 11)
		"approver_account": approverAccount,
		"dashboard_url":    a.Cfg.AppOrigin + "/rooms/" + roomID, "expires_at": exp.UTC(),
		// item 9: the approval card itself (request id only; after sign-in only the invite's person sees it)
		"approve_url": a.Cfg.AppOrigin + "/approve/" + id,
	}
	if status == "approved" {
		v["member_id"] = memberID
	} else {
		// security review (Low): anyone holding a leaked invite can file a request; the purpose comes with approval
		v["room"] = map[string]any{"id": roomID, "name": roomName, "purpose": ""}
	}
	if moveTo != nil {
		v["move_to"] = *moveTo // claim: "chat" (another chat on the same computer) or "machine"
	}
	if kind == "join" && status != "pending" && status != "approved" { // blocker 10: does the invite still work (joinend.go)
		inv, err := inviteState(ctx, q, id)
		if err != nil {
			return nil, err
		}
		if inv != nil {
			v["invite"] = inv
		}
	}
	return v, nil
}

func (a *API) postJoinRequest(w http.ResponseWriter, r *http.Request, c *Caller) error {
	ctx := r.Context()
	var j joinCreate
	if err := httpx.DecodeStrict(c.Body, &j); err != nil {
		return err
	}
	if err := j.validate(); err != nil {
		return err
	}
	if j.Ed != c.KeyHex {
		return httpx.E(401, "unknown_key", "Sign this request with the key in its body (ed25519_pk).")
	}
	reqHash := wire.SHA256(c.Body)
	ip := httpx.ClientIP(r, a.Cfg.TrustCF)
	status := 201
	var joined *Invite
	var hit plans.Hit
	err := a.St.Tx(ctx, func(tx pgx.Tx) error {
		var oldHash []byte
		err := tx.QueryRow(ctx, `select request_hash from join_requests where id = $1`, j.ID).Scan(&oldHash)
		if err == nil {
			if hex.EncodeToString(oldHash) == hex.EncodeToString(reqHash) {
				status = 200
				return nil
			}
			return httpx.E(409, "id_conflict", "A different request already used this id.")
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if err := ratelimit.Hit(ctx, tx, ratelimit.JoinPerKey, c.KeyHex); err != nil {
			return err
		}
		code, ok := wire.ParseInviteCode(j.Invite, 10)
		var inv *Invite
		if ok {
			inv, err = LookupChatInvite(ctx, tx, code, true)
		} else {
			err = inviteInvalid()
		}
		if err != nil {
			var he *httpx.Error
			if errors.As(err, &he) && he.Code == "invite_invalid" {
				_ = ratelimit.Count(ctx, a.St.Pool, ratelimit.InviteFailIP, ip) // outside the tx: survives the rollback
			}
			return err
		}
		if err := ratelimit.Hit(ctx, tx, ratelimit.JoinPerInvite, inv.Code); err != nil {
			return err
		}
		// one pending request per room cap
		var pending int
		if err := tx.QueryRow(ctx, `select count(*) from join_requests where room_id = $1 and status = 'pending' and expires_at > now()`,
			inv.RoomID).Scan(&pending); err != nil {
			return err
		}
		if pending >= 10 {
			return httpx.RateLimited("quota_exceeded", 60)
		}
		ed, _ := hex.DecodeString(j.Ed)
		x, _ := hex.DecodeString(j.X)
		// key not in use by an active member or a pending request
		var used bool
		if err := tx.QueryRow(ctx, `select exists(select 1 from members where ed25519_pk = $1 and removed_at is null)
			or exists(select 1 from join_requests where ed25519_pk = $1 and status = 'pending' and expires_at > now())
			or exists(select 1 from room_drafts where ed25519_pk = $1 and status = 'open' and expires_at > now())`, ed).Scan(&used); err != nil {
			return err
		}
		if used {
			return httpx.E(409, "key_in_use", "This key is already in use. Make a new one.")
		}
		// stale pending rows still hold the partial unique indexes: expire them first
		if _, err := tx.Exec(ctx, `update join_requests set status = 'expired', decided_at = now()
			where status = 'pending' and expires_at <= now() and (room_id = $1 or ed25519_pk = $2 or for_account_id = $3)`,
			inv.RoomID, ed, inv.AccountID); err != nil {
			return err
		}
		var memberID string
		switch j.Kind {
		case "join":
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from members where room_id = $1 and removed_at is null`, inv.RoomID).Scan(&count); err != nil {
				return err
			}
			if count >= 20 {
				return httpx.E(409, "room_full", "This room is full (20 members).")
			}
			if a.Cfg.Plans.Mode() == plans.ModeBlock { // count mode records at approve time, not here
				if err := plans.Enforce(ctx, tx, a.St.Pool, plans.ModeBlock, plans.AgentsPerRoom, "", inv.RoomID, count+1, &hit); err != nil {
					return err
				}
			}
			if taken, err := nameTaken(ctx, tx, inv.RoomID, j.Name); err != nil {
				return err
			} else if taken {
				sugg, err := suggestName(ctx, tx, inv.RoomID, j.Name)
				if err != nil {
					return err
				}
				return httpx.E(409, "name_taken", "That name is taken in this room.").With("suggestion", sugg)
			}
			memberID = wire.NewV7().String()
		case "claim":
			err := tx.QueryRow(ctx, `select id from members where room_id = $1 and name = $2 and account_id = $3 and removed_at is null`,
				inv.RoomID, j.Name, inv.AccountID).Scan(&memberID)
			if errors.Is(err, pgx.ErrNoRows) {
				return httpx.E(404, "member_not_found", "There's no member with that name for this person in the room.")
			}
			if err != nil {
				return err
			}
			// newest move request wins: an older pending claim for this member is cancelled
			if _, err := tx.Exec(ctx, `update join_requests set status = 'cancelled', decided_at = now()
				where member_id = $1 and status = 'pending'`, memberID); err != nil {
				return err
			}
		}
		for attempt := 0; ; attempt++ {
			code := wire.RandCode(6) // item 9: 6 characters, shown as K7Q-2MX
			sp, err := tx.Begin(ctx)
			if err != nil {
				return err
			}
			_, err = sp.Exec(ctx, `insert into join_requests (id, kind, room_id, invite_id, for_account_id, member_id, name, job, app,
				machine, folder, turn, session_id, ed25519_pk, x25519_pk, match_code, request_hash, expires_at, app_name, move_to)
				values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now() + make_interval(secs => $19), $18,
				case when $2 = 'claim' then 'machine' end)`,
				j.ID, j.Kind, inv.RoomID, inv.ID, inv.AccountID, memberID, j.Name, j.Job, j.App, j.Machine, j.Folder, j.Turn,
				j.SessionID, ed, x, code, reqHash, j.AppName, a.Cfg.JoinRequestTTL().Seconds())
			if err == nil {
				if err := sp.Commit(ctx); err != nil {
					return err
				}
				break
			}
			_ = sp.Rollback(ctx)
			switch {
			case store.IsUniqueViolation(err, "join_requests_pending_code") && attempt < 20:
				continue
			case store.IsUniqueViolation(err, "join_requests_pending_name"):
				sugg, serr := suggestName(ctx, tx, inv.RoomID, j.Name)
				if serr != nil {
					return serr
				}
				return httpx.E(409, "name_taken", "That name is taken in this room.").With("suggestion", sugg)
			case store.IsUniqueViolation(err, "join_requests_pending_key"):
				return httpx.E(409, "key_in_use", "This key is already in use. Make a new one.")
			case store.IsUniqueViolation(err, "join_requests_pkey"):
				return httpx.E(409, "id_conflict", "A different request already used this id.")
			}
			return err
		}
		joined = inv
		_, err = tx.Exec(ctx, `update invites set use_count = use_count + 1 where id = $1`, inv.ID)
		return err
	})
	hit.Report(a.An, err) // analytics limit_reached: at most once per account, limit and day
	if err != nil {
		return err
	}
	if status == 201 && j.Kind == "join" && joined != nil {
		a.An.Capture(analytics.JoinRequested, a.An.ID(joined.AccountID), analytics.Props{"room": a.An.ID(joined.RoomID), "kind": "chat", "app": j.App})
	}
	v, err := a.joinView(ctx, a.St.Pool, j.ID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, status, v)
	return nil
}

// reservedNames are never member names: bot-link's own notes (wake tests, notices) speak as these (security review).
var reservedNames = map[string]bool{"bot-link": true, "botlink": true, "system": true}

func nameTaken(ctx context.Context, q store.Q, roomID, name string) (bool, error) {
	if reservedNames[name] {
		return true, nil
	}
	var taken bool
	err := q.QueryRow(ctx, `select exists(select 1 from members where room_id = $1 and name = $2 and removed_at is null)
		or exists(select 1 from join_requests where room_id = $1 and name = $2 and kind = 'join' and status = 'pending' and expires_at > now())`,
		roomID, name).Scan(&taken)
	return taken, err
}

func suggestName(ctx context.Context, q store.Q, roomID, name string) (string, error) {
	for i := 2; i < 100; i++ {
		suffix := fmt.Sprintf("-%d", i)
		base := name
		if len(base)+len(suffix) > 24 {
			base = strings.TrimRight(base[:24-len(suffix)], "-")
		}
		cand := base + suffix
		taken, err := nameTaken(ctx, q, roomID, cand)
		if err != nil {
			return "", err
		}
		if !taken {
			return cand, nil
		}
	}
	return name + "-" + strings.ToLower(wire.RandCode(4)), nil
}

func (a *API) postJoinWait(w http.ResponseWriter, r *http.Request, c *Caller) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if !wire.IsUUID(id) {
		return httpx.NotFound()
	}
	waitS, sess, err := parseJoinWait(c.Body)
	if err != nil {
		return err
	}
	var key []byte
	err = a.St.Pool.QueryRow(ctx, `select ed25519_pk from join_requests where id = $1`, id).Scan(&key)
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	if hex.EncodeToString(key) != c.KeyHex {
		return httpx.Forbidden("This isn't your request.")
	}
	// founder report 16 Nov 2026: the asking chat's session id changed since it asked (a resume, its tools and its
	// command line disagreeing). The holder of the request's key moves its still pending join to the session it has
	// now, so the member it becomes is held by the chat that waits (approve copies session_id into holder_session).
	if sess != "" {
		if _, err := a.St.Pool.Exec(ctx, `update join_requests set session_id = $2 where id = $1 and status = 'pending' and kind = 'join'`, id, sess); err != nil {
			return err
		}
	}
	// scale prep: a long wait holds a slot of this copy's cap (after the session move above, so a wait turned away
	// at the cap still leaves the pending request on the chat's current session)
	if waitS > 0 {
		release, err := a.holdSlot(ctx)
		if err != nil {
			return err
		}
		defer release()
	}
	// security review: waits were uncapped per key. A healthy client holds one 50 s wait at a time.
	if err := ratelimit.Hit(ctx, a.St.Pool, ratelimit.JoinWaits, c.KeyHex); err != nil {
		return err
	}
	if !a.holdJoinWait(c.KeyHex) {
		return httpx.RateLimited("", 5)
	}
	defer a.releaseJoinWait(c.KeyHex)
	bell := a.Bus.Hold(wake.Join + ":" + id)
	defer bell.Release()
	deadline := time.NewTimer(time.Duration(waitS) * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()
	for {
		// lazily expire so the caller learns promptly
		if _, err := a.St.Pool.Exec(ctx, `update join_requests set status = 'expired', decided_at = now()
			where id = $1 and status = 'pending' and expires_at <= now()`, id); err != nil {
			return err
		}
		v, err := a.joinView(ctx, a.St.Pool, id)
		if err != nil {
			return err
		}
		if v["status"] != "pending" || waitS == 0 {
			httpx.WriteJSON(w, 200, v)
			return nil
		}
		select {
		case <-bell.C:
		case <-tick.C:
		case <-deadline.C:
			httpx.WriteJSON(w, 200, v)
			return nil
		case <-httpx.Draining(ctx): // this copy is shutting down: still pending; the client asks again
			httpx.WriteJSON(w, 200, v)
			return nil
		case <-ctx.Done():
			return nil
		}
	}
}

// At most this many open join waits per key on one copy (a second wait while one runs is a retry; more is abuse).
const maxJoinWaitsPerKey = 3

func (a *API) holdJoinWait(key string) bool {
	a.joinWaitMu.Lock()
	defer a.joinWaitMu.Unlock()
	if a.joinWaits == nil {
		a.joinWaits = map[string]int{}
	}
	if a.joinWaits[key] >= maxJoinWaitsPerKey {
		return false
	}
	a.joinWaits[key]++
	return true
}

func (a *API) releaseJoinWait(key string) {
	a.joinWaitMu.Lock()
	defer a.joinWaitMu.Unlock()
	if a.joinWaits[key]--; a.joinWaits[key] <= 0 {
		delete(a.joinWaits, key)
	}
}

// parseJoinWait reads {"wait_s": 0..50, "session_id": "<the waiting chat's session id>"} (both optional).
func parseJoinWait(body []byte) (int, string, error) {
	var b struct {
		WaitS     *int    `json:"wait_s"`
		SessionID *string `json:"session_id"`
	}
	if len(strings.TrimSpace(string(body))) > 0 {
		if err := httpx.DecodeStrict(body, &b); err != nil {
			return 0, "", err
		}
	}
	waitS := 50
	if b.WaitS != nil {
		if *b.WaitS < 0 || *b.WaitS > 50 {
			return 0, "", httpx.BadRequest("wait_s must be 0..50.")
		}
		waitS = *b.WaitS
	}
	if b.SessionID == nil {
		return waitS, "", nil
	}
	if !wire.IsSessionID(*b.SessionID) {
		return 0, "", httpx.BadRequest("session_id is not a valid session id.")
	}
	return waitS, *b.SessionID, nil
}

// parseWait reads {"wait_s": 0..50} (empty body = default).
func parseWait(body []byte, def int) (int, error) {
	var b struct {
		WaitS *int `json:"wait_s"`
	}
	if len(strings.TrimSpace(string(body))) > 0 {
		if err := httpx.DecodeStrict(body, &b); err != nil {
			return 0, err
		}
	}
	if b.WaitS == nil {
		return def, nil
	}
	if *b.WaitS < 0 || *b.WaitS > 50 {
		return 0, httpx.BadRequest("wait_s must be 0..50.")
	}
	return *b.WaitS, nil
}

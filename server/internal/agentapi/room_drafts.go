package agentapi

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/charles161/botlink/server/internal/faults"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/ratelimit"
	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/wake"
	"github.com/charles161/botlink/server/internal/wire"
)

// Rooms started by a chat (docs/protocol/room-drafts.md §2): a chat makes a draft, waits for it, or takes it back.
// A draft is one row of room_drafts. Nothing here writes another table, lists a draft anywhere or sends anything to
// anyone: the only way a person learns of a draft is the link in their own chat. The person confirms it on the app
// host (appapi/room_drafts.go).

type draftCreate struct {
	ID          string  `json:"id"`
	RoomName    string  `json:"room_name"`
	RoomPurpose *string `json:"room_purpose"`
	memberProposal
}

func (d *draftCreate) validate() (string, error) {
	purpose := ""
	if d.RoomPurpose != nil {
		purpose = *d.RoomPurpose
	}
	switch {
	case !wire.IsUUID(d.ID):
		return "", httpx.BadRequest("id must be a lowercase uuid.")
	case !wire.RoomNameRe.MatchString(d.RoomName):
		return "", httpx.BadRequest("room_name must be ^[a-z0-9][a-z0-9-]{0,31}$.")
	case utf8.RuneCountInString(purpose) > 140:
		return "", httpx.BadRequest("room_purpose must be ≤ 140 characters.")
	case !wire.OneLineTextOK(purpose): // the confirmed purpose becomes the room's, which every member's chat reads
		return "", httpx.BadRequest("room_purpose must be one line of visible text: no line breaks, tabs, control characters, zero-width or direction-changing characters.")
	}
	return purpose, d.memberProposal.validate()
}

func draftGone() *httpx.Error {
	return httpx.E(404, "draft_gone", "This room request is gone: it expired, was taken back, was closed after wrong codes, or made way for newer ones before anyone opened it. Ask again if your human still wants the room.")
}

// draftCap refuses with 429 too_many_drafts when n open drafts already reach max; Retry-After is when the first of
// them expires.
func draftCap(ctx context.Context, q store.Q, label string, max int, where string, args ...any) error {
	var n int
	var retry float64
	if err := q.QueryRow(ctx, `select count(*), coalesce(extract(epoch from min(expires_at) - now()), 60)::float8
		from room_drafts where status = 'open' and expires_at > now()`+where, args...).Scan(&n, &retry); err != nil {
		return err
	}
	if n >= max {
		httpx.SetRateLimited(ctx, label)
		return httpx.RateLimited("too_many_drafts", int(retry)+1)
	}
	return nil
}

// makeRoomForDraft keeps the server-wide cap without refusing new drafts: at the cap it deletes the oldest open draft
// nobody has claimed (its chat's wait answers draft_gone). A caller whose address changes on every request passes the
// per-caller caps; refusing at the total would let it switch drafts off for everyone, while this only shortens how
// long an unopened draft lives. A claimed draft is never deleted: when every open draft is claimed, 429.
// The count is read without a server-wide lock: creates running at the same moment can each see room, so the total
// may go over by the number of creates in flight (SPEC §9); SKIP LOCKED lets them evict different drafts.
func makeRoomForDraft(ctx context.Context, tx pgx.Tx, max int) error {
	var n int
	if err := tx.QueryRow(ctx, `select count(*) from room_drafts where status = 'open' and expires_at > now()`).Scan(&n); err != nil {
		return err
	}
	if n < max {
		return nil
	}
	var evicted string
	err := tx.QueryRow(ctx, `delete from room_drafts where id = (select id from room_drafts
		where status = 'open' and claimed_by is null and expires_at > now() order by created_at limit 1 for update skip locked)
		returning id`).Scan(&evicted)
	if errors.Is(err, pgx.ErrNoRows) { // every open draft is held by a person
		return draftCap(ctx, tx, "draft:open_total", max, ``)
	}
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `select pg_notify('bl_join', $1::text)`, evicted) // its chat's wait answers draft_gone now
	return err
}

// POST /api/v1/room-drafts: signed by the new key in the body, like a join request; no other credential.
func (a *API) postRoomDraft(w http.ResponseWriter, r *http.Request, c *Caller) error {
	ctx := r.Context()
	var d draftCreate
	if err := httpx.DecodeStrict(c.Body, &d); err != nil {
		return err
	}
	purpose, err := d.validate()
	if err != nil {
		return err
	}
	if d.Ed != c.KeyHex {
		return httpx.E(401, "unknown_key", "Sign this request with the key in its body (ed25519_pk).")
	}
	reqHash := wire.SHA256(c.Body)
	caller := DraftCallerKey(httpx.ClientIP(r, a.Cfg.TrustCF))
	status := 201
	var v map[string]any
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		// one create at a time per caller, so the per-caller caps count exactly; a create that would queue behind its
		// caller's others answers 429 instead of holding a connection (security review: one server-wide lock let
		// creates without any account slow every other request)
		if _, err := tx.Exec(ctx, `set local lock_timeout = '500ms'`); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, DraftCallerLock, caller); err != nil {
			var pe *pgconn.PgError
			if errors.As(err, &pe) && pe.Code == "55P03" { // lock_not_available
				httpx.SetRateLimited(ctx, "draft:busy")
				return httpx.RateLimited("too_many_drafts", 1)
			}
			return err
		}
		if _, err := tx.Exec(ctx, `set local lock_timeout to default`); err != nil {
			return err
		}
		var oldHash []byte
		// for share: a replay's answer is read from this row below; an eviction skips it meanwhile, a delete waits
		err := tx.QueryRow(ctx, `select request_hash from room_drafts where id = $1 for share`, d.ID).Scan(&oldHash)
		if err == nil {
			if bytes.Equal(oldHash, reqHash) {
				status = 200
				v, err = a.draftView(ctx, tx, d.ID)
				return err
			}
			return httpx.E(409, "id_conflict", "A different request already used this id.")
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		ed, _ := hex.DecodeString(d.Ed)
		x, _ := hex.DecodeString(d.X)
		var used bool
		if err := tx.QueryRow(ctx, `select exists(select 1 from members where ed25519_pk = $1 and removed_at is null)
			or exists(select 1 from join_requests where ed25519_pk = $1 and status = 'pending' and expires_at > now())
			or exists(select 1 from room_drafts where ed25519_pk = $1 and status = 'open' and expires_at > now())`, ed).Scan(&used); err != nil {
			return err
		}
		if used {
			return httpx.E(409, "key_in_use", "This key is already in use. Make a new one.")
		}
		if reservedNames[d.Name] {
			return httpx.E(409, "name_taken", "That name is taken.").With("suggestion", strings.TrimRight(d.Name, "-")+"-2")
		}
		if err := draftCap(ctx, tx, "draft:open_ip", a.Cfg.Drafts.OpenPerIPMax(), ` and caller_ip = $1`, caller); err != nil {
			return err
		}
		perHour := ratelimit.DraftsPerIPHour
		perHour.Max = a.Cfg.Drafts.PerIPHourMax()
		if err := ratelimit.Hit(ctx, tx, perHour, caller); err != nil { // counts made drafts only: a refusal rolls it back
			return err
		}
		if err := makeRoomForDraft(ctx, tx, a.Cfg.Drafts.OpenTotalMax()); err != nil {
			return err
		}
		// an expired open draft of this key still holds room_drafts_open_key until the sweeper takes it
		if _, err := tx.Exec(ctx, `delete from room_drafts where ed25519_pk = $1 and status = 'open' and expires_at <= now()`, ed); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `insert into room_drafts (id, room_name, room_purpose, member_id, name, job, app, app_name, machine,
			folder, turn, session_id, ed25519_pk, x25519_pk, match_code, request_hash, caller_ip, expires_at)
			values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now() + make_interval(secs => $18))`,
			d.ID, d.RoomName, purpose, wire.NewV7(), d.Name, d.Job, d.App, d.AppName, d.Machine, d.Folder, d.Turn, d.SessionID,
			ed, x, wire.RandCode(6), reqHash, caller, a.Cfg.JoinRequestTTL().Seconds())
		switch {
		case store.IsUniqueViolation(err, "room_drafts_pkey"): // the same id from another caller at the same moment
			return httpx.E(409, "id_conflict", "A different request already used this id.")
		case store.IsUniqueViolation(err, "room_drafts_open_key"):
			return httpx.E(409, "key_in_use", "This key is already in use. Make a new one.")
		}
		if err != nil {
			return err
		}
		v, err = a.draftView(ctx, tx, d.ID)
		return err
	})
	if err != nil {
		return err
	}
	if err := faults.Point(ctx, "draft_after_create", 0); err != nil {
		return err
	}
	httpx.WriteJSON(w, status, v)
	return nil
}

// draftView builds RoomDraftView (what the chat shows its human: the link and the code).
func (a *API) draftView(ctx context.Context, q store.Q, id string) (map[string]any, error) {
	var status, roomName, purpose, name, memberID, code string
	var exp time.Time
	if err := q.QueryRow(ctx, `select case when status = 'open' and expires_at <= now() then 'expired' else status end,
		room_name, room_purpose, name, member_id, match_code, expires_at from room_drafts where id = $1`, id).Scan(
		&status, &roomName, &purpose, &name, &memberID, &code, &exp); err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "status": status, "room_name": roomName, "room_purpose": purpose, "name": name,
		"member_id": memberID, "match_code": code, "expires_at": exp.UTC(), "confirm_url": a.confirmURL(id)}, nil
}

func (a *API) confirmURL(id string) string { return a.Cfg.AppOrigin + "/create/" + id }

// draftWaitView builds the JoinRequestView of a draft (kind create), as the join wait answers it: pending while open,
// approved with the member and the room once confirmed, rejected, expired. nil when the draft is gone (unknown,
// swept, closed after wrong codes, or its room is gone). Who confirms is not known before the confirm: the approver
// fields come with approved only.
func (a *API) draftWaitView(ctx context.Context, q store.Q, id string) (map[string]any, error) {
	var status, code, roomName, memberID string
	var roomID *string
	var ed, x []byte
	var exp time.Time
	err := q.QueryRow(ctx, `select case when status = 'open' and expires_at <= now() then 'expired' else status end,
		match_code, room_name, member_id, room_id, ed25519_pk, x25519_pk, expires_at from room_drafts where id = $1`, id).Scan(
		&status, &code, &roomName, &memberID, &roomID, &ed, &x, &exp)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	v := map[string]any{"id": id, "kind": "create", "match_code": code, "fingerprint": wire.MemberFP(ed, x),
		"room": map[string]any{"name": roomName, "purpose": ""}, "approver_name": "", "expires_at": exp.UTC(),
		"approve_url": a.confirmURL(id)}
	switch status {
	case "open":
		v["status"] = "pending"
	case "rejected", "expired":
		v["status"] = status
	case "confirmed":
		if roomID == nil {
			return nil, nil
		}
		var name, purpose, owner, ownerName string
		err := q.QueryRow(ctx, `select r.name, r.purpose, r.owner_account_id, a.display_name from rooms r
			join accounts a on a.id = r.owner_account_id where r.id = $1`, *roomID).Scan(&name, &purpose, &owner, &ownerName)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		v["status"], v["member_id"] = "approved", memberID
		v["room"] = map[string]any{"id": *roomID, "name": name, "purpose": purpose}
		// ENVELOPE §5.4: the self-check requires the member_add by a browser of exactly this account (the room's owner)
		v["approver_name"], v["approver_account"] = ownerName, owner
		v["dashboard_url"] = a.Cfg.AppOrigin + "/rooms/" + *roomID
	default: // closed
		return nil, nil
	}
	return v, nil
}

// draftKeyIs: the draft exists and was made with this key. Any other key learns nothing about it.
func (a *API) draftKeyIs(ctx context.Context, id, keyHex string) (bool, error) {
	var key []byte
	err := a.St.Pool.QueryRow(ctx, `select ed25519_pk from room_drafts where id = $1`, id).Scan(&key)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return hex.EncodeToString(key) == keyHex, nil
}

// POST /api/v1/room-drafts/{id}/wait: signed by the draft's key; long poll, ≤ 50 s, the join wait's rules and caps.
func (a *API) postRoomDraftWait(w http.ResponseWriter, r *http.Request, c *Caller) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if !wire.IsUUID(id) {
		return draftGone()
	}
	waitS, sess, err := parseJoinWait(c.Body)
	if err != nil {
		return err
	}
	if mine, err := a.draftKeyIs(ctx, id, c.KeyHex); err != nil {
		return err
	} else if !mine {
		return draftGone()
	}
	// the asking chat's session changed since it asked (a resume): the member it becomes is held by the chat that waits
	if sess != "" {
		if _, err := a.St.Pool.Exec(ctx, `update room_drafts set session_id = $2 where id = $1 and status = 'open'`, id, sess); err != nil {
			return err
		}
	}
	if waitS > 0 {
		release, err := a.holdSlot(ctx)
		if err != nil {
			return err
		}
		defer release()
	}
	if err := ratelimit.Hit(ctx, a.St.Pool, ratelimit.JoinWaits, c.KeyHex); err != nil {
		return err
	}
	if !a.holdJoinWait(c.KeyHex) {
		return httpx.RateLimited("", 5)
	}
	defer a.releaseJoinWait(c.KeyHex)
	bell := a.Bus.Hold(wake.Join + ":" + id) // confirm, reject and close notify bl_join with the draft id
	defer bell.Release()
	deadline := time.NewTimer(time.Duration(waitS) * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()
	for {
		v, err := a.draftWaitView(ctx, a.St.Pool, id)
		if err != nil {
			return err
		}
		if v == nil {
			return draftGone()
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
		case <-httpx.Draining(ctx):
			httpx.WriteJSON(w, 200, v)
			return nil
		case <-ctx.Done():
			return nil
		}
	}
}

// POST /api/v1/room-drafts/{id}/cancel: signed by the draft's key; deletes it (204, also when it is already gone or
// another key asks). A confirmed draft is a member now: 409 already_decided, and the chat leaves with DELETE /api/v1/me.
func (a *API) postRoomDraftCancel(w http.ResponseWriter, r *http.Request, c *Caller) error {
	ctx := r.Context()
	if len(strings.TrimSpace(string(c.Body))) > 0 {
		var b struct{}
		if err := httpx.DecodeStrict(c.Body, &b); err != nil {
			return err
		}
	}
	id := r.PathValue("id")
	if wire.IsUUID(id) {
		var confirmed bool
		err := a.St.Tx(ctx, func(tx pgx.Tx) error {
			var status string
			err := tx.QueryRow(ctx, `select status from room_drafts where id = $1 and ed25519_pk = $2 for update`, id, c.Key).Scan(&status)
			if errors.Is(err, pgx.ErrNoRows) {
				return nil
			}
			if err != nil {
				return err
			}
			if status == "confirmed" {
				confirmed = true
				return nil
			}
			_, err = tx.Exec(ctx, `delete from room_drafts where id = $1`, id)
			if err != nil {
				return err
			}
			_, err = tx.Exec(ctx, `select pg_notify('bl_join', $1::text)`, id)
			return err
		})
		if err != nil {
			return err
		}
		if confirmed {
			return httpx.E(409, "already_decided", "This room was already made with this chat in it. To leave it, leave the room.").With("status", "approved")
		}
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

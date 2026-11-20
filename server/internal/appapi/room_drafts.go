package appapi

import (
	"context"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/analytics"
	"github.com/charles161/botlink/server/internal/auth"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/humancheck"
	"github.com/charles161/botlink/server/internal/plans"
	"github.com/charles161/botlink/server/internal/roster"
	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/wire"
)

// Rooms started by a chat, the person's side (docs/protocol/room-drafts.md §3): claim the draft from its link, then
// confirm it with the code the chat shows and a passkey, or say no. The confirm makes the room with createRoom and
// lets the chat in with admitChat, the same code as POST /app/v1/rooms and a join approval, in one transaction.
// Nothing here lists a draft or tells anyone about one.

// DraftWrongCodesMax: wrong codes before a draft closes.
const DraftWrongCodesMax = 5

type heldDraft struct {
	status, code, roomName, purpose string
	claimedBy, roomID               *string
	expired                         bool
	wrong                           int
	exp                             time.Time
	chat                            joinedChat
}

// readDraft reads a draft (forUpdate: locked for the rest of the transaction); nil when there is none.
func readDraft(ctx context.Context, q store.Q, id string, forUpdate bool) (*heldDraft, error) {
	lock := ""
	if forUpdate {
		lock = " for update"
	}
	d := &heldDraft{}
	c := &d.chat
	err := q.QueryRow(ctx, `select status, match_code, room_name, room_purpose, claimed_by, room_id, expires_at <= now(),
		wrong_codes, expires_at, member_id, name, job, app, app_name, machine, folder, turn, session_id, ed25519_pk, x25519_pk
		from room_drafts where id = $1`+lock, id).Scan(&d.status, &d.code, &d.roomName, &d.purpose, &d.claimedBy, &d.roomID,
		&d.expired, &d.wrong, &d.exp, &c.MemberID, &c.Name, &c.Job, &c.App, &c.AppName, &c.Machine, &c.Folder, &c.Turn,
		&c.Session, &c.Ed, &c.X)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return d, err
}

// heldBy: the draft is open, unexpired and claimed by account.
func (d *heldDraft) heldBy(account string) bool {
	return d != nil && d.status == "open" && !d.expired && d.claimedBy != nil && *d.claimedBy == account
}

// codeMatches compares a typed code with the draft's in constant time; case and a dash between the groups are ignored.
func codeMatches(typed, code string) bool {
	t := strings.ToUpper(strings.TrimSpace(typed))
	if len(t) == 7 && t[3] == '-' {
		t = t[:3] + t[4:]
	}
	return len(t) == len(code) && subtle.ConstantTimeCompare([]byte(t), []byte(code)) == 1
}

func notifyDraft(ctx context.Context, tx pgx.Tx, id string) error {
	_, err := tx.Exec(ctx, `select pg_notify('bl_join', $1::text)`, id) // wakes the chat's wait, nothing else listens
	return err
}

// emptyBody accepts no body or {}.
func emptyBody(r *http.Request) error {
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	if len(strings.TrimSpace(string(body))) > 0 {
		var b struct{}
		return httpx.DecodeStrict(body, &b)
	}
	return nil
}

// POST /app/v1/room-drafts/{id}/claim: binds an open, unexpired, unclaimed draft to the caller, or returns the card
// again to its holder. Every other case is the same 404.
func (a *API) postDraftClaim(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if !wire.IsUUID(id) {
		return httpx.NotFound()
	}
	if err := emptyBody(r); err != nil {
		return err
	}
	var card map[string]any
	err := a.St.Tx(ctx, func(tx pgx.Tx) error {
		// one claim at a time per account: the cap counts rows
		if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended('room_draft_claim:' || $1::text, 0))`, s.AccountID); err != nil {
			return err
		}
		d, err := readDraft(ctx, tx, id, true)
		if err != nil {
			return err
		}
		if d == nil || d.status != "open" || d.expired || (d.claimedBy != nil && *d.claimedBy != s.AccountID) {
			return httpx.NotFound()
		}
		if d.claimedBy == nil {
			var n int
			var retry float64
			if err := tx.QueryRow(ctx, `select count(*), coalesce(extract(epoch from min(expires_at) - now()), 60)::float8
				from room_drafts where claimed_by = $1 and status = 'open' and expires_at > now()`, s.AccountID).Scan(&n, &retry); err != nil {
				return err
			}
			if n >= a.Cfg.Drafts.OpenPerPersonMax() {
				httpx.SetRateLimited(ctx, "draft:person")
				return httpx.RateLimited("too_many_drafts", int(retry)+1)
			}
			if _, err := tx.Exec(ctx, `update room_drafts set claimed_by = $2 where id = $1`, id, s.AccountID); err != nil {
				return err
			}
		}
		var taken bool
		if err := tx.QueryRow(ctx, `select exists(select 1 from rooms where owner_account_id = $1 and name = $2 and deleted_at is null)`,
			s.AccountID, d.roomName).Scan(&taken); err != nil {
			return err
		}
		c := d.chat
		card = map[string]any{"id": id, "room_name": d.roomName, "room_purpose": d.purpose, "name": c.Name, "job": c.Job,
			"app": c.App, "app_name": c.AppName, "machine": c.Machine, "folder": c.Folder, "turn": c.Turn, "member_id": c.MemberID,
			"ed25519_pk": hex.EncodeToString(c.Ed), "x25519_pk": hex.EncodeToString(c.X), "expires_at": d.exp.UTC(), "name_taken": taken}
		return nil
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, card)
	return nil
}

type draftConfirmBody struct {
	Code        string           `json:"code"`
	HumanCheck  humancheck.Proof `json:"human_check"`
	Room        roomCreate       `json:"room"`
	RosterEntry roster.Wire      `json:"roster_entry"`
}

// POST /app/v1/room-drafts/{id}/confirm. One transaction, in the contract's order: the draft is the caller's and open;
// the code (a wrong one is counted and committed, makes nothing and leaves the human check unused); the human check is
// used up; the room is made as POST /app/v1/rooms makes it; the chat is let in as an approval lets it in; the draft
// is confirmed. The same confirm again (a double click, a retry) answers the room it made.
func (a *API) postDraftConfirm(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if !wire.IsUUID(id) {
		return httpx.NotFound()
	}
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b draftConfirmBody
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	if strings.TrimSpace(b.Code) == "" { // not a try: nothing is counted
		return httpx.BadRequest("Type the code your chat shows.")
	}
	// a retry of a confirm that went through: its human check is used up, so answer before asking for it
	if d, err := readDraft(ctx, a.St.Pool, id, false); err != nil {
		return err
	} else if d != nil && d.confirmedAs(s.AccountID, b.Room.ID) {
		return a.writeRoom(ctx, w, 200, b.Room.ID, s.AccountID)
	}
	purpose, g, err := checkRoomCreate(&b.Room, s.AccountID)
	if err != nil {
		return err
	}
	if err := a.verifyHuman(r, s, &b.HumanCheck, humancheck.ConfirmRoomAction, id); err != nil {
		return err
	}
	var mismatch *httpx.Error
	notHeld := false
	replay := false
	var hit plans.Hit
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		d, err := readDraft(ctx, tx, id, true)
		if err != nil {
			return err
		}
		if d != nil && d.confirmedAs(s.AccountID, b.Room.ID) { // the other click of a double click won
			replay = true
			return nil
		}
		if !d.heldBy(s.AccountID) {
			// the passed check is spent (committed): claiming the draft afterwards must not make it confirm
			notHeld = true
			return humancheck.Spend(ctx, tx, b.HumanCheck.ID, s)
		}
		if !codeMatches(b.Code, d.code) {
			left := DraftWrongCodesMax - d.wrong - 1
			if _, err := tx.Exec(ctx, `update room_drafts set wrong_codes = wrong_codes + 1,
				status = case when wrong_codes + 1 >= $2 then 'closed' else status end,
				decided_at = case when wrong_codes + 1 >= $2 then now() else decided_at end where id = $1`, id, DraftWrongCodesMax); err != nil {
				return err
			}
			if left <= 0 {
				if err := notifyDraft(ctx, tx, id); err != nil {
					return err
				}
			}
			mismatch = httpx.E(403, "code_mismatch", "That code doesn't match the one the chat shows.").With("left", left)
			return nil // the count commits; nothing else was written
		}
		if err := consumeApproval(ctx, tx, b.HumanCheck.ID, s); err != nil {
			return err
		}
		created, err := a.createRoom(ctx, tx, s.AccountID, &b.Room, purpose, g, &hit)
		if err != nil {
			return err
		}
		if !created { // an existing room of the caller: a confirm makes a new room only
			return httpx.E(409, "id_conflict", "A different room already used this id.")
		}
		if err := a.admitChat(ctx, tx, s.AccountID, b.Room.ID, b.RosterEntry, d.chat, &hit); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `update room_drafts set status = 'confirmed', room_id = $2, decided_at = now() where id = $1`, id, b.Room.ID); err != nil {
			return err
		}
		return notifyDraft(ctx, tx, id)
	})
	hit.Report(a.An, err)
	if err != nil {
		return err
	}
	if mismatch != nil {
		return mismatch
	}
	if notHeld {
		return httpx.NotFound()
	}
	if replay {
		return a.writeRoom(ctx, w, 200, b.Room.ID, s.AccountID)
	}
	a.An.Capture(analytics.RoomCreated, a.An.ID(s.AccountID), analytics.Props{"room": a.An.ID(b.Room.ID)})
	return a.writeRoom(ctx, w, 201, b.Room.ID, s.AccountID)
}

// confirmedAs: the draft was confirmed by account into roomID.
func (d *heldDraft) confirmedAs(account, roomID string) bool {
	return d.status == "confirmed" && d.claimedBy != nil && *d.claimedBy == account && d.roomID != nil && *d.roomID == roomID
}

func (a *API) writeRoom(ctx context.Context, w http.ResponseWriter, status int, roomID, account string) error {
	d, err := roomDetail(ctx, a.St.Pool, roomID, account, "")
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, status, d)
	return nil
}

// POST /app/v1/room-drafts/{id}/reject: the holder says no; the chat's wait answers rejected.
func (a *API) postDraftReject(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if !wire.IsUUID(id) {
		return httpx.NotFound()
	}
	if err := emptyBody(r); err != nil {
		return err
	}
	err := a.St.Tx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `update room_drafts set status = 'rejected', decided_at = now()
			where id = $1 and status = 'open' and claimed_by = $2 and expires_at > now()`, id, s.AccountID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return httpx.NotFound()
		}
		return notifyDraft(ctx, tx, id)
	})
	if err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

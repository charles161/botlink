package appapi

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/analytics"
	"github.com/charles161/botlink/server/internal/auth"
	"github.com/charles161/botlink/server/internal/faults"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/humancheck"
	"github.com/charles161/botlink/server/internal/plans"
	"github.com/charles161/botlink/server/internal/ratelimit"
	"github.com/charles161/botlink/server/internal/roster"
	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/wake"
	"github.com/charles161/botlink/server/internal/wire"
)

type approveBody struct {
	HumanCheck  humancheck.Proof `json:"human_check"`
	RosterEntry roster.Wire      `json:"roster_entry"`
}

func alreadyDecided(status string) *httpx.Error {
	return httpx.E(409, "already_decided", "This was already decided.").With("status", status)
}

// signerIsMyDevice: the entry's signer must be one of my registered, unrevoked browser keys.
func signerIsMyDevice(ctx context.Context, q store.Q, signerHex, account string) error {
	pk, ok := wire.DecodeHex32(signerHex)
	if !ok {
		return httpx.BadRequest("signer must be 64 lowercase hex chars.")
	}
	var mine bool
	if err := q.QueryRow(ctx, `select exists(select 1 from devices where ed25519_pk = $1 and account_id = $2 and revoked_at is null)`,
		pk, account).Scan(&mine); err != nil {
		return err
	}
	if !mine {
		return httpx.E(403, "not_signer", "Approve from one of your own approved browsers.")
	}
	return nil
}

// POST /app/v1/join-requests/{id}/approve: member_add (join) or member_rekey (claim). One transaction.
func (a *API) postJoinApprove(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if !wire.IsUUID(id) {
		return httpx.NotFound()
	}
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b approveBody
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	if err := a.verifyHuman(r, s, &b.HumanCheck, "approve_join", id); err != nil {
		return err
	}
	var memberID, roomID, approved string
	var hit plans.Hit
	var refused error
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		// the room first, then the request (store.LockRoom: one lock order)
		err := tx.QueryRow(ctx, `select room_id from join_requests where id = $1`, id).Scan(&roomID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if err == nil {
			if err := store.LockRoom(ctx, tx, roomID); err != nil {
				return err
			}
		}
		// CAS pending → approved (the loser of a double click / two copies gets already_decided)
		var kind string
		var c joinedChat
		err = tx.QueryRow(ctx, `update join_requests set status = 'approved', decided_at = now(), decided_by = $2
			where id = $1 and status = 'pending' and for_account_id = $2 and expires_at > now()
			returning kind, room_id, member_id, name, job, app, app_name, machine, folder, turn, session_id, ed25519_pk, x25519_pk`, id, s.AccountID).Scan(
			&kind, &roomID, &memberID, &c.Name, &c.Job, &c.App, &c.AppName, &c.Machine, &c.Folder, &c.Turn, &c.Session, &c.Ed, &c.X)
		if errors.Is(err, pgx.ErrNoRows) {
			// not the caller's to approve (or no longer pending): the passed check is spent, so a takeover (readdress
			// needs no check) cannot make it approve this request later
			refused = a.diagnoseRequest(ctx, tx, id, s.AccountID)
			return humancheck.Spend(ctx, tx, b.HumanCheck.ID, s)
		}
		if err != nil {
			return err
		}
		c.MemberID = memberID
		if err := consumeApproval(ctx, tx, b.HumanCheck.ID, s); err != nil {
			return err
		}
		switch kind {
		case "join":
			if err := a.admitChat(ctx, tx, s.AccountID, roomID, b.RosterEntry, c, &hit); err != nil {
				return err
			}
		case "claim":
			if err := signerIsMyDevice(ctx, tx, b.RosterEntry.Signer, s.AccountID); err != nil {
				return err
			}
			e, _, err := store.AppendEntry(ctx, tx, roomID, b.RosterEntry)
			if err != nil {
				return err
			}
			if e.Op != "member_rekey" || e.Member != memberID || e.Ed != hex.EncodeToString(c.Ed) || e.X != hex.EncodeToString(c.X) {
				return requestMismatch()
			}
			if err := rekey(ctx, tx, memberID, c.Ed, c.X, c.Session, c.Job, c.Machine, c.Folder, c.Turn); err != nil {
				return err
			}
			if err := store.RosterChanged(ctx, tx, roomID); err != nil {
				return err
			}
		}
		approved = kind
		return nil
	})
	hit.Report(a.An, err) // analytics limit_reached: at most once per account, limit and day
	if err != nil {
		return err
	}
	if refused != nil {
		return refused
	}
	if approved == "join" { // a move to a new machine (claim) is not a join
		a.An.Capture(analytics.JoinApproved, a.An.ID(s.AccountID), analytics.Props{"room": a.An.ID(roomID), "kind": "chat"})
	}
	ms, err := store.ActiveMembers(ctx, a.St.Pool, roomID)
	if err != nil {
		return err
	}
	for _, m := range ms {
		if m.ID == memberID {
			httpx.WriteJSON(w, 200, memberJSON(m))
			return nil
		}
	}
	return httpx.Internal(fmt.Errorf("approved member %s not found", memberID))
}

func requestMismatch() *httpx.Error {
	return httpx.E(400, "roster_invalid", "The signed entry doesn't match this request.").With("rule", "request_match")
}

// joinedChat is the chat a member_add lets in: a join request's proposal or a room draft's.
type joinedChat struct {
	MemberID, Name, Job, App, Machine, Folder, Turn string
	AppName, Session                                *string
	Ed, X                                           []byte
}

// consumeApproval uses up the human check and counts the approval (approvals per account per hour), inside the
// approving transaction: a rolled-back approval leaves the check usable.
func consumeApproval(ctx context.Context, tx pgx.Tx, checkID string, s *auth.Session) error {
	if err := humancheck.Consume(ctx, tx, checkID, s); err != nil {
		return err
	}
	return ratelimit.Hit(ctx, tx, ratelimit.Approvals, s.AccountID)
}

// admitChat lets chat c into roomID with the member_add w signed by a browser of account, as a join approval does
// (SPEC §6.4 step 7): the signer is the account's own browser, the append (roster rules: the signer can sign in this
// room), members per room ≤ 20 and the plan limit, the entry matches the chat field for field, the member row
// (holder = the chat's session), the "joined" item for the room's other people, roster_changed notices. It is the one
// implementation behind a join approval and a draft's confirm. The members are counted after the append, under the
// rooms row it locks: counted before, two approvals (the second signed on top of the first) could both see 19.
func (a *API) admitChat(ctx context.Context, tx pgx.Tx, account, roomID string, w roster.Wire, c joinedChat, hit *plans.Hit) error {
	if err := signerIsMyDevice(ctx, tx, w.Signer, account); err != nil {
		return err
	}
	if err := faults.Point(ctx, "admit_before_append", 0); err != nil {
		return err
	}
	e, _, err := store.AppendEntry(ctx, tx, roomID, w)
	if err != nil {
		return err
	}
	var n int
	if err := tx.QueryRow(ctx, `select count(*) from members where room_id = $1 and removed_at is null`, roomID).Scan(&n); err != nil {
		return err
	}
	if n >= 20 {
		return httpx.E(409, "room_full", "This room is full (20 members).")
	}
	if err := plans.Enforce(ctx, tx, a.St.Pool, a.Cfg.Plans.Mode(), plans.AgentsPerRoom, "", roomID, n+1, hit); err != nil {
		return err
	}
	if e.Op != "member_add" || e.Member != c.MemberID || e.Account != account || e.Name != c.Name || e.App != c.App ||
		e.Ed != hex.EncodeToString(c.Ed) || e.X != hex.EncodeToString(c.X) {
		return requestMismatch()
	}
	var holderEpoch int64
	if c.Session != nil {
		holderEpoch = 1
	}
	if _, err := tx.Exec(ctx, `insert into members (id, room_id, account_id, name, app, job, folder, machine, turn,
		ed25519_pk, x25519_pk, holder_session, holder_epoch, app_name) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
		c.MemberID, roomID, account, c.Name, c.App, c.Job, c.Folder, c.Machine, c.Turn, c.Ed, c.X, c.Session, holderEpoch, c.AppName); err != nil {
		if store.IsUniqueViolation(err, "members_room_name_uq") {
			return httpx.E(409, "name_taken", "That name is taken in this room.")
		}
		if store.IsUniqueViolation(err, "members_key_uq") {
			return httpx.E(409, "key_in_use", "This key is already in use.")
		}
		return err
	}
	if err := store.MembershipAttention(ctx, tx, roomID, c.MemberID, "member_joined", "joined", account); err != nil {
		return err
	}
	return store.RosterChanged(ctx, tx, roomID)
}

// rekey moves a member to a new machine: new keys, key_epoch+1, new holder, handover dropped; queued and
// stuck copies sealed to the old key → needs_resend (envelope dropped); one notice per sender.
func rekey(ctx context.Context, tx pgx.Tx, memberID string, ed, x []byte, session *string, job, machine, folder, turn string) error {
	var name string
	var removed bool
	if err := tx.QueryRow(ctx, `select name, removed_at is not null from members where id = $1 for update`, memberID).Scan(&name, &removed); err != nil {
		return err
	}
	if removed {
		return httpx.E(409, "already_decided", "This member was removed.").With("status", "cancelled")
	}
	var epoch int
	if err := tx.QueryRow(ctx, `update members set ed25519_pk = $2, x25519_pk = $3, key_epoch = key_epoch + 1,
			holder_session = $4, holder_epoch = holder_epoch + 1, handover_env = null,
			machine = $5, folder = $6, turn = $7, job = case when $8 = '' then job else $8 end,
			push_url = null, push_secret = null, push_verified_at = null, wake_verified_at = null
		where id = $1 returning key_epoch`, memberID, ed, x, session, machine, folder, turn, job).Scan(&epoch); err != nil {
		if store.IsUniqueViolation(err, "members_key_uq") {
			return httpx.E(409, "key_in_use", "This key is already in use.")
		}
		return err
	}
	rows, err := tx.Query(ctx, `with u as (update deliveries set state = 'needs_resend', envelope = null, lease_until = null, stuck_reason = null
			where member_id = $1 and key_epoch < $2 and state in ('queued','stuck') returning message_id)
		select m.from_member, array_agg(u.message_id::text order by u.message_id) from u join messages m on m.id = u.message_id
		group by m.from_member`, memberID, epoch)
	if err != nil {
		return err
	}
	type grp struct {
		from string
		ids  []string
	}
	var groups []grp
	for rows.Next() {
		var g grp
		if err := rows.Scan(&g.from, &g.ids); err != nil {
			rows.Close()
			return err
		}
		groups = append(groups, g)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, g := range groups {
		if _, err := tx.Exec(ctx, `insert into notices (member_id, kind, data) select $1, 'needs_resend',
			jsonb_build_object('to_member', $2::text, 'to_name', $3::text, 'message_ids', $4::text[])
			from members where id = $1 and removed_at is null`, g.from, memberID, name, g.ids); err != nil {
			return err
		}
	}
	_, err = tx.Exec(ctx, `update attention set resolved_at = now() where subject_id = $1 and kind in ('stuck','cannot_wake') and resolved_at is null`, memberID)
	return err
}

// diagnoseRequest turns a failed CAS into 404 (unknown / not mine) or 409 already_decided.
func (a *API) diagnoseRequest(ctx context.Context, q store.Q, id, account string) error {
	var status, forAcct string
	var expired bool
	err := q.QueryRow(ctx, `select status, for_account_id, expires_at <= now() from join_requests where id = $1`, id).Scan(&status, &forAcct, &expired)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && forAcct != account) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	if status == "pending" && expired {
		status = "expired"
	}
	return alreadyDecided(status)
}

func (a *API) postJoinReject(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if !wire.IsUUID(id) {
		return httpx.NotFound()
	}
	tag, err := a.St.Pool.Exec(ctx, `update join_requests set status = 'rejected', decided_at = now(), decided_by = $2
		where id = $1 and status = 'pending' and for_account_id = $2`, id, s.AccountID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return a.diagnoseRequest(ctx, a.St.Pool, id, s.AccountID)
	}
	a.An.Capture(analytics.JoinRejected, a.An.ID(s.AccountID), analytics.Props{"kind": "chat"})
	httpx.WriteJSON(w, 200, map[string]any{"ok": true})
	return nil
}

// ── person invites + requests

func (a *API) personInviteJSON(ctx context.Context, q store.Q, id string) (map[string]any, error) {
	var room, code string
	var exp time.Time
	var usedBy *string
	if err := q.QueryRow(ctx, `select i.room_id, i.code, i.expires_at, a.display_name from invites i
		left join accounts a on a.id = i.used_by_account_id where i.id = $1 and i.kind = 'person'`, id).Scan(&room, &code, &exp, &usedBy); err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "room_id": room, "url": a.Cfg.AppOrigin + "/p/" + code, "expires_at": exp.UTC(),
		"used": usedBy != nil, "used_by_name": usedBy}, nil
}

func (a *API) getPersonInvites(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if err := requireOwner(ctx, a.St.Pool, id, s.AccountID); err != nil {
		return err
	}
	rows, err := a.St.Pool.Query(ctx, `select id from invites where room_id = $1 and kind = 'person' order by created_at desc`, id)
	if err != nil {
		return err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	out := make([]map[string]any, 0, len(ids))
	for _, iid := range ids {
		v, err := a.personInviteJSON(ctx, a.St.Pool, iid)
		if err != nil {
			return err
		}
		out = append(out, v)
	}
	httpx.WriteJSON(w, 200, map[string]any{"invites": out})
	return nil
}

func (a *API) postPersonInvite(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	roomID := r.PathValue("id")
	if err := requireOwner(ctx, a.St.Pool, roomID, s.AccountID); err != nil {
		return err
	}
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		ID string `json:"id"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	if !wire.IsUUID(b.ID) {
		return httpx.BadRequest("id must be a uuid.")
	}
	status := 201
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		var room, kind, acct string
		err := tx.QueryRow(ctx, `select room_id, kind, account_id from invites where id = $1`, b.ID).Scan(&room, &kind, &acct)
		if err == nil {
			if room == roomID && kind == "person" && acct == s.AccountID {
				status = 200
				return nil
			}
			return httpx.E(409, "id_conflict", "A different invite already used this id.")
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if err := ratelimit.Hit(ctx, tx, ratelimit.PersonInvitesDay, s.AccountID); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `insert into invites (id, room_id, kind, account_id, code, expires_at) values ($1,$2,'person',$3,$4, now() + interval '7 days')`,
			b.ID, roomID, s.AccountID, wire.RandCode(16))
		return err
	})
	if err != nil {
		return err
	}
	if status == 201 {
		a.An.Capture(analytics.InviteMade, a.An.ID(s.AccountID), analytics.Props{"room": a.An.ID(roomID), "kind": "person"})
	}
	v, err := a.personInviteJSON(ctx, a.St.Pool, b.ID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, status, v)
	return nil
}

func inviteInvalid() *httpx.Error {
	return httpx.E(404, "invite_invalid", "This invite doesn't work. It may be wrong, expired, turned off or already used.")
}

// GET /app/v1/person-invites/{code}: preview for a signed-in friend.
func (a *API) getPersonInvitePreview(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	code, ok := wire.ParseInviteCode(r.PathValue("code"), 16)
	if !ok {
		return inviteInvalid()
	}
	var roomID string
	var exp time.Time
	err := a.St.Pool.QueryRow(ctx, `select i.room_id, i.expires_at from invites i join rooms r on r.id = i.room_id
		where i.code = $1 and i.kind = 'person' and not i.off and i.expires_at > now() and i.used_by_account_id is null and r.deleted_at is null`,
		code).Scan(&roomID, &exp)
	if errors.Is(err, pgx.ErrNoRows) {
		return inviteInvalid()
	}
	if err != nil {
		return err
	}
	// Before the owner approves them, a signed-in friend sees the room, who invited them and how many chats are in it
	// (room.member_count), never who those chats are: invite links leak. The roster comes with approval.
	sum, err := roomSummary(ctx, a.St.Pool, roomID, s.AccountID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"room": sum, "owner_name": sum["owner_name"], "expires_at": exp.UTC()})
	return nil
}

func (a *API) personRequestJSON(ctx context.Context, q store.Q, id string) (map[string]any, error) {
	var room, roomName, acct, name, email, status string
	var provider *string
	var pk []byte
	var created time.Time
	if err := q.QueryRow(ctx, `select p.room_id, r.name, p.account_id, a.display_name, a.email,
		(select i.provider from identities i where i.account_id = a.id order by i.created_at desc limit 1),
		p.device_pk, case when p.status = 'pending' and p.expires_at <= now() then 'expired' else p.status end, p.created_at
		from person_requests p join rooms r on r.id = p.room_id join accounts a on a.id = p.account_id where p.id = $1`, id).Scan(
		&room, &roomName, &acct, &name, &email, &provider, &pk, &status, &created); err != nil {
		return nil, err
	}
	prov := "dev"
	if provider != nil {
		prov = *provider
	}
	return map[string]any{"id": id, "room_id": room, "room_name": roomName, "account_id": acct, "display_name": name, "email": email,
		"provider": prov, "device_pk": hex.EncodeToString(pk), "device_fingerprint": wire.DeviceFP(pk), "status": status,
		"created_at": created.UTC()}, nil
}

// POST /app/v1/person-invites/{code}/accept: redeem once, create a person request.
func (a *API) postPersonInviteAccept(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	code, ok := wire.ParseInviteCode(r.PathValue("code"), 16)
	if !ok {
		return inviteInvalid()
	}
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		DeviceID string `json:"device_id"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	if !wire.IsUUID(b.DeviceID) {
		return httpx.BadRequest("device_id must be a uuid.")
	}
	reqID := wire.NewV7().String()
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		pk, err := a.myDevicePK(ctx, tx, s.AccountID, b.DeviceID)
		if err != nil {
			return httpx.BadRequest("Register this browser's device key first.")
		}
		var inviteID, roomID string
		err = tx.QueryRow(ctx, `update invites i set used_by_account_id = $2, used_at = now() from rooms r
			where r.id = i.room_id and i.code = $1 and i.kind = 'person' and not i.off and i.expires_at > now()
			  and i.used_by_account_id is null and r.deleted_at is null
			returning i.id, i.room_id`, code, s.AccountID).Scan(&inviteID, &roomID)
		if errors.Is(err, pgx.ErrNoRows) {
			return inviteInvalid()
		}
		if err != nil {
			return err
		}
		var inRoom bool
		if err := tx.QueryRow(ctx, `select exists(select 1 from room_people where room_id = $1 and account_id = $2 and removed_at is null)`,
			roomID, s.AccountID).Scan(&inRoom); err != nil {
			return err
		}
		if inRoom {
			return httpx.E(409, "already_in_room", "You're already in this room.")
		}
		if _, err := tx.Exec(ctx, `update person_requests set status = 'expired', decided_at = now()
			where room_id = $1 and account_id = $2 and status = 'pending' and expires_at <= now()`, roomID, s.AccountID); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `insert into person_requests (id, room_id, invite_id, account_id, device_pk, expires_at)
			values ($1,$2,$3,$4,$5, now() + interval '7 days')`, reqID, roomID, inviteID, s.AccountID, pk)
		if store.IsUniqueViolation(err, "person_requests_one_pending") {
			return httpx.E(409, "already_in_room", "You already asked to join this room.")
		}
		return err
	})
	if err != nil {
		return err
	}
	a.An.Capture(analytics.JoinRequested, a.An.ID(s.AccountID), analytics.Props{"kind": "person"})
	v, err := a.personRequestJSON(ctx, a.St.Pool, reqID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 201, v)
	return nil
}

// POST /app/v1/person-requests/{id}/approve: person_add signed by an owner device.
func (a *API) postPersonApprove(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if !wire.IsUUID(id) {
		return httpx.NotFound()
	}
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b approveBody
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	if err := a.verifyHuman(r, s, &b.HumanCheck, "approve_person", id); err != nil {
		return err
	}
	var roomID string
	var hit plans.Hit
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		var acct string
		var pk []byte
		err := tx.QueryRow(ctx, `update person_requests p set status = 'approved', decided_at = now(), decided_by = $2 from rooms r
			where p.id = $1 and r.id = p.room_id and r.owner_account_id = $2 and r.deleted_at is null and p.status = 'pending' and p.expires_at > now()
			returning p.room_id, p.account_id, p.device_pk`, id, s.AccountID).Scan(&roomID, &acct, &pk)
		if errors.Is(err, pgx.ErrNoRows) {
			return a.diagnosePerson(ctx, tx, id, s.AccountID)
		}
		if err != nil {
			return err
		}
		if err := humancheck.Consume(ctx, tx, b.HumanCheck.ID, s); err != nil {
			return err
		}
		if err := ratelimit.Hit(ctx, tx, ratelimit.Approvals, s.AccountID); err != nil {
			return err
		}
		if err := signerIsMyDevice(ctx, tx, b.RosterEntry.Signer, s.AccountID); err != nil {
			return err
		}
		var persons int
		if err := tx.QueryRow(ctx, `select count(*) from room_people where room_id = $1 and removed_at is null`, roomID).Scan(&persons); err != nil {
			return err
		}
		if persons >= 10 {
			return httpx.E(409, "room_full", "This room already has 10 people.")
		}
		if err := plans.Enforce(ctx, tx, a.St.Pool, a.Cfg.Plans.Mode(), plans.PeoplePerRoom, s.AccountID, roomID, persons+1, &hit); err != nil {
			return err
		}
		e, _, err := store.AppendEntry(ctx, tx, roomID, b.RosterEntry)
		if err != nil {
			return err
		}
		if e.Op != "person_add" || e.Account != acct || e.Device != hex.EncodeToString(pk) {
			return httpx.E(400, "roster_invalid", "The signed entry doesn't match this request.").With("rule", "request_match")
		}
		if err := store.ApplyDerived(ctx, tx, roomID, e); err != nil {
			return err
		}
		_, err = store.EnsureChatInvite(ctx, tx, roomID, acct)
		return err
	})
	hit.Report(a.An, err) // analytics limit_reached: at most once per account, limit and day
	if err != nil {
		return err
	}
	a.An.Capture(analytics.JoinApproved, a.An.ID(s.AccountID), analytics.Props{"room": a.An.ID(roomID), "kind": "person"})
	d, err := roomDetail(ctx, a.St.Pool, roomID, s.AccountID, "")
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, d)
	return nil
}

func (a *API) diagnosePerson(ctx context.Context, q store.Q, id, account string) error {
	var status, owner string
	var expired bool
	err := q.QueryRow(ctx, `select p.status, r.owner_account_id, p.expires_at <= now() from person_requests p join rooms r on r.id = p.room_id
		where p.id = $1`, id).Scan(&status, &owner, &expired)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && owner != account) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	if status == "pending" && expired {
		status = "expired"
	}
	return alreadyDecided(status)
}

func (a *API) postPersonReject(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if !wire.IsUUID(id) {
		return httpx.NotFound()
	}
	tag, err := a.St.Pool.Exec(ctx, `update person_requests p set status = 'rejected', decided_at = now(), decided_by = $2 from rooms r
		where p.id = $1 and r.id = p.room_id and r.owner_account_id = $2 and p.status = 'pending'`, id, s.AccountID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return a.diagnosePerson(ctx, a.St.Pool, id, s.AccountID)
	}
	a.An.Capture(analytics.JoinRejected, a.An.ID(s.AccountID), analytics.Props{"kind": "person"})
	httpx.WriteJSON(w, 200, map[string]any{"ok": true})
	return nil
}

// ── what needs you

func (a *API) getNeedsYou(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	q := a.St.Pool
	jrs := []map[string]any{}
	rows, err := q.Query(ctx, `select j.id, j.kind, j.room_id, r.name, j.member_id, j.name, j.job, j.app, j.machine, j.folder, j.turn,
			j.match_code, j.ed25519_pk, j.x25519_pk, j.created_at, j.expires_at, j.app_name, j.move_to, fa.display_name
		from join_requests j join rooms r on r.id = j.room_id left join accounts fa on fa.id = j.readdressed_from
		where j.for_account_id = $1 and j.status = 'pending' and j.expires_at > now() and r.deleted_at is null order by j.created_at`, s.AccountID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, kind, room, roomName, member, name, job, app, machine, folder, turn, code string
		var ed, x []byte
		var created, exp time.Time
		var appName_, moveTo, fromName *string
		if err := rows.Scan(&id, &kind, &room, &roomName, &member, &name, &job, &app, &machine, &folder, &turn, &code, &ed, &x, &created, &exp, &appName_, &moveTo, &fromName); err != nil {
			rows.Close()
			return err
		}
		jrs = append(jrs, map[string]any{"id": id, "kind": kind, "room_id": room, "room_name": roomName, "member_id": member, "name": name,
			"job": job, "app": app, "app_name": appName_, "machine": machine, "folder": folder, "turn": turn, "match_code": code,
			"ed25519_pk": hex.EncodeToString(ed), "x25519_pk": hex.EncodeToString(x),
			"invite_label": inviteLabel(roomName, fromName), "created_at": created.UTC(), "expires_at": exp.UTC(),
			"move_to": moveTo, "readdressed_from_name": fromName})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	rows, err = q.Query(ctx, `select p.id from person_requests p join rooms r on r.id = p.room_id
		where r.owner_account_id = $1 and r.deleted_at is null and p.status = 'pending' and p.expires_at > now() order by p.created_at`, s.AccountID)
	if err != nil {
		return err
	}
	pids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	prs := []map[string]any{}
	for _, id := range pids {
		v, err := a.personRequestJSON(ctx, q, id)
		if err != nil {
			return err
		}
		prs = append(prs, v)
	}
	rows, err = q.Query(ctx, `select t.id, t.kind, t.room_id, r.name, t.subject_id, m.name, m.app, m.app_name, t.data, t.created_at
		from attention t left join rooms r on r.id = t.room_id left join members m on m.id = t.subject_id
		where t.account_id = $1 and t.resolved_at is null order by t.created_at`, s.AccountID)
	if err != nil {
		return err
	}
	att := []map[string]any{}
	for rows.Next() {
		var id, kind, subject string
		var room, roomName, mname, app, appName *string
		var data map[string]any
		var created time.Time
		if err := rows.Scan(&id, &kind, &room, &roomName, &subject, &mname, &app, &appName, &data, &created); err != nil {
			rows.Close()
			return err
		}
		if data == nil {
			data = map[string]any{}
		}
		att = append(att, map[string]any{"id": id, "kind": kind, "room_id": room, "room_name": roomName, "subject_id": subject,
			"member_name": mname, "app": app, "app_name": appName, "data": data, "created_at": created.UTC()})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	ended, err := endedJoinRequests(ctx, q, s.AccountID)
	if err != nil {
		return err
	}
	urls, err := eventURLCards(ctx, q, s.AccountID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"join_requests": jrs, "person_requests": prs, "attention": att, "ended_join_requests": ended, "event_urls": urls})
	return nil
}

// inviteLabel: which invite the card came from. A request taken over from another person (item 11) used theirs.
func inviteLabel(room string, from *string) string {
	if from != nil {
		return *from + "'s chat invite for #" + room + " (you made it yours)"
	}
	return "your chat invite for #" + room
}

// POST /app/v1/members/{id}/unstick (the member's person only).
func (a *API) postUnstick(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if !wire.IsUUID(id) {
		return httpx.NotFound()
	}
	var n int
	err := a.St.Tx(ctx, func(tx pgx.Tx) error {
		var acct string
		err := tx.QueryRow(ctx, `select account_id from members where id = $1 and removed_at is null`, id).Scan(&acct)
		if errors.Is(err, pgx.ErrNoRows) {
			return httpx.NotFound()
		}
		if err != nil {
			return err
		}
		if acct != s.AccountID {
			return httpx.Forbidden("Only this member's person can retry its messages.")
		}
		tag, err := tx.Exec(ctx, `update deliveries set state = 'queued', attempts = 0, wakes = 0, stuck_reason = null
			where member_id = $1 and state = 'stuck' and envelope is not null and expires_at > now()`, id)
		if err != nil {
			return err
		}
		n = int(tag.RowsAffected())
		_, err = tx.Exec(ctx, `update attention set resolved_at = now() where subject_id = $1 and account_id = $2 and kind = 'stuck' and resolved_at is null`,
			id, s.AccountID)
		return err
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"requeued": n})
	return nil
}

func (a *API) postDismiss(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	id := r.PathValue("id")
	if !wire.IsUUID(id) {
		return httpx.NotFound()
	}
	if _, err := a.St.Pool.Exec(r.Context(), `update attention set resolved_at = now() where id = $1 and account_id = $2 and resolved_at is null`,
		id, s.AccountID); err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"ok": true})
	return nil
}

// POST /app/v1/devices/{id}/certify: one signed device_add per room, all-or-nothing.
func (a *API) postCertify(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if !wire.IsUUID(id) {
		return httpx.NotFound()
	}
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		HumanCheck humancheck.Proof `json:"human_check"`
		Entries    []struct {
			RoomID      string      `json:"room_id"`
			RosterEntry roster.Wire `json:"roster_entry"`
		} `json:"entries"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	if len(b.Entries) > 40 {
		return httpx.BadRequest("At most 40 entries.")
	}
	pk, err := a.myDevicePK(ctx, a.St.Pool, s.AccountID, id)
	if err != nil {
		return err
	}
	if err := a.verifyHuman(r, s, &b.HumanCheck, "approve_device", id); err != nil {
		return err
	}
	sort.Slice(b.Entries, func(i, j int) bool { return b.Entries[i].RoomID < b.Entries[j].RoomID })
	for i := 1; i < len(b.Entries); i++ {
		if b.Entries[i].RoomID == b.Entries[i-1].RoomID {
			return httpx.BadRequest("One entry per room.")
		}
	}
	pkHex := hex.EncodeToString(pk)
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		if err := humancheck.Consume(ctx, tx, b.HumanCheck.ID, s); err != nil {
			return err
		}
		if err := ratelimit.Hit(ctx, tx, ratelimit.Approvals, s.AccountID); err != nil {
			return err
		}
		var conflicts []string
		for _, en := range b.Entries {
			if _, err := myRole(ctx, tx, en.RoomID, s.AccountID); err != nil {
				return err
			}
			if err := signerIsMyDevice(ctx, tx, en.RosterEntry.Signer, s.AccountID); err != nil {
				return err
			}
			e, _, err := store.AppendEntry(ctx, tx, en.RoomID, en.RosterEntry)
			if err != nil {
				var he *httpx.Error
				if errors.As(err, &he) && he.Code == "roster_conflict" {
					conflicts = append(conflicts, en.RoomID) // keep checking the rest; nothing commits
					continue
				}
				return err
			}
			if e.Op != "device_add" || e.Account != s.AccountID || e.Device != pkHex {
				return httpx.E(400, "roster_invalid", "Each entry must add this device for you.").With("rule", "request_match")
			}
			if err := store.ApplyDerived(ctx, tx, en.RoomID, e); err != nil {
				return err
			}
		}
		if len(conflicts) > 0 {
			return httpx.E(409, "roster_conflict", "The member list changed in some rooms. Refresh and sign again.").With("room_ids", conflicts)
		}
		// a human approved this browser: later rooms include it from the start (SPEC §6.2). Rooms the approving
		// browser couldn't sign for stay pending; the new_device item stays open for a browser that can.
		if _, err := tx.Exec(ctx, `update devices set approved_at = coalesce(approved_at, now()) where id = $1`, id); err != nil {
			return err
		}
		return store.SyncDeviceAttention(ctx, tx, s.AccountID, id)
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"ok": true})
	return nil
}

// GET /app/v1/events: SSE "changed" on any bl_dash for me; heartbeat 20 s; closes after 10 min.
func (a *API) getEvents(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	fl, ok := w.(http.Flusher)
	if !ok {
		return httpx.Internal(errors.New("streaming unsupported"))
	}
	bell := a.Bus.Hold(wake.Dash + ":" + s.AccountID)
	defer bell.Release()
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
	_, _ = w.Write([]byte(": connected\n\n"))
	fl.Flush()
	hb := time.NewTicker(20 * time.Second)
	defer hb.Stop()
	end := time.NewTimer(10 * time.Minute)
	defer end.Stop()
	for {
		select {
		case <-bell.C:
			if _, err := w.Write([]byte("event: changed\ndata: {}\n\n")); err != nil {
				return nil
			}
		case <-hb.C:
			if _, err := w.Write([]byte(": hb\n\n")); err != nil {
				return nil
			}
		case <-end.C:
			return nil
		case <-httpx.Draining(r.Context()): // this copy is shutting down; the browser reconnects to the next one
			return nil
		case <-r.Context().Done():
			return nil
		}
		fl.Flush()
	}
}

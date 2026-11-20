package appapi

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/analytics"
	"github.com/charles161/botlink/server/internal/auth"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/plans"
	"github.com/charles161/botlink/server/internal/ratelimit"
	"github.com/charles161/botlink/server/internal/roster"
	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/wire"
)

// myRole returns owner|person for a current person of a live room, else 404.
func myRole(ctx context.Context, q store.Q, roomID, account string) (string, error) {
	if !wire.IsUUID(roomID) {
		return "", httpx.NotFound()
	}
	var role string
	err := q.QueryRow(ctx, `select p.role from room_people p join rooms r on r.id = p.room_id
		where p.room_id = $1 and p.account_id = $2 and p.removed_at is null and r.deleted_at is null`, roomID, account).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", httpx.NotFound()
	}
	return role, err
}

func requireOwner(ctx context.Context, q store.Q, roomID, account string) error {
	role, err := myRole(ctx, q, roomID, account)
	if err != nil {
		return err
	}
	if role != "owner" {
		return httpx.Forbidden("Only the room's owner can do that.")
	}
	return nil
}

// roomSummary builds RoomSummary for account (role "" → computed; non-members get "person").
func roomSummary(ctx context.Context, q store.Q, roomID, account string) (map[string]any, error) {
	var name, purpose, owner, role string
	var count, needs int
	err := q.QueryRow(ctx, `
		select r.name, r.purpose, a.display_name,
		  coalesce((select p.role from room_people p where p.room_id = r.id and p.account_id = $2 and p.removed_at is null), 'person'),
		  (select count(*) from members m where m.room_id = r.id and m.removed_at is null),
		  (select count(*) from join_requests j where j.room_id = r.id and j.for_account_id = $2 and j.status = 'pending' and j.expires_at > now())
		  + (case when r.owner_account_id = $2 then
		      (select count(*) from person_requests pr where pr.room_id = r.id and pr.status = 'pending' and pr.expires_at > now()) else 0 end)
		  + (select count(*) from attention t where t.room_id = r.id and t.account_id = $2 and t.resolved_at is null)
		from rooms r join accounts a on a.id = r.owner_account_id where r.id = $1`, roomID, account).Scan(
		&name, &purpose, &owner, &role, &count, &needs)
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": roomID, "name": name, "purpose": purpose, "owner_name": owner, "my_role": role,
		"member_count": count, "needs_you": needs}, nil
}

func memberJSON(m store.MemberRow) map[string]any {
	return map[string]any{"id": m.ID, "name": m.Name, "app": m.App, "app_name": m.AppNameOrNil(), "job": m.Job, "folder": m.Folder, "turn": m.Turn,
		"turn_label": m.TurnLabel, "self_label": m.SelfLabel, "person_name": m.PersonName, "account_id": m.AccountID, "fingerprint": m.Fingerprint(),
		"stuck": m.Stuck, "joined_at": m.JoinedAt.UTC()}
}

// roomDetail builds RoomDetail. deviceID (optional) answers my_device_certified.
func roomDetail(ctx context.Context, q store.Q, roomID, account, deviceID string) (map[string]any, error) {
	sum, err := roomSummary(ctx, q, roomID, account)
	if err != nil {
		return nil, err
	}
	var genesis, headHash []byte
	var head int
	if err := q.QueryRow(ctx, `select g.entry, r.roster_head_seq, h.entry_hash from rooms r
		join roster_entries g on g.room_id = r.id and g.seq = 0
		join roster_entries h on h.room_id = r.id and h.seq = r.roster_head_seq where r.id = $1`, roomID).Scan(&genesis, &head, &headHash); err != nil {
		return nil, err
	}
	rows, err := q.Query(ctx, `select p.account_id, a.display_name, p.role from room_people p join accounts a on a.id = p.account_id
		where p.room_id = $1 and p.removed_at is null order by (p.role = 'owner') desc, p.added_at`, roomID)
	if err != nil {
		return nil, err
	}
	people := []map[string]any{}
	for rows.Next() {
		var id, name, role string
		if err := rows.Scan(&id, &name, &role); err != nil {
			rows.Close()
			return nil, err
		}
		people = append(people, map[string]any{"account_id": id, "display_name": name, "role": role})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	ms, err := store.ActiveMembers(ctx, q, roomID)
	if err != nil {
		return nil, err
	}
	muted, err := mutedByMe(ctx, q, roomID, account)
	if err != nil {
		return nil, err
	}
	members := make([]map[string]any, 0, len(ms))
	for _, m := range ms {
		mj := memberJSON(m)
		mj["muted_by_me"] = muted[m.ID]
		members = append(members, mj)
	}
	certified := false
	if deviceID != "" && wire.IsUUID(deviceID) {
		if err := q.QueryRow(ctx, `select exists(select 1 from devices d join room_signers s on s.ed25519_pk = d.ed25519_pk
			where d.id = $1 and d.account_id = $2 and d.revoked_at is null and s.room_id = $3 and s.removed_seq is null)`,
			deviceID, account, roomID).Scan(&certified); err != nil {
			return nil, err
		}
	}
	return map[string]any{"room": sum, "room_fingerprint": wire.FP16(genesis), "people": people, "members": members,
		"my_role": sum["my_role"], "head_seq": head, "head_hash": hex.EncodeToString(headHash), "my_device_certified": certified}, nil
}

func (a *API) getRooms(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	// the rooms home's order: the newest last message first, then rooms with none, newest room first
	rows, err := a.St.Pool.Query(ctx, `select r.id, r.last_message_at from room_people p join rooms r on r.id = p.room_id
		where p.account_id = $1 and p.removed_at is null and r.deleted_at is null
		order by r.last_message_at desc nulls last, r.created_at desc, r.id`, s.AccountID)
	if err != nil {
		return err
	}
	type listed struct {
		ID   string
		Last *time.Time
	}
	list, err := pgx.CollectRows(rows, pgx.RowToStructByPos[listed])
	if err != nil {
		return err
	}
	out := make([]map[string]any, 0, len(list))
	for _, l := range list {
		sum, err := roomSummary(ctx, a.St.Pool, l.ID, s.AccountID)
		if err != nil {
			return err
		}
		// room level only: when the server accepted the room's newest message (migration 0054); nothing about who
		if l.Last != nil {
			sum["last_message_at"] = l.Last.UTC()
		} else {
			sum["last_message_at"] = nil
		}
		out = append(out, sum)
	}
	httpx.WriteJSON(w, 200, map[string]any{"rooms": out})
	return nil
}

// roomCreate is the body of POST /app/v1/rooms, and the room of a draft's confirm (room_drafts.go).
type roomCreate struct {
	ID      string      `json:"id"`
	Name    string      `json:"name"`
	Purpose *string     `json:"purpose"`
	Genesis roster.Wire `json:"genesis"`
	// device_add for each of my other approved browsers, signed by the genesis device (seq 1..n), so every
	// browser a human already approved can sign here from the start (SPEC §6.2).
	Entries []roster.Wire `json:"entries"`
}

// checkRoomCreate applies the rules of a room create that need no database: id, name, purpose, a genesis for this
// room owned by account, at most 20 entries. It returns the purpose and the parsed genesis.
func checkRoomCreate(b *roomCreate, account string) (string, *roster.Entry, error) {
	purpose := ""
	if b.Purpose != nil {
		purpose = *b.Purpose
	}
	if !wire.IsUUID(b.ID) || !wire.RoomNameRe.MatchString(b.Name) || utf8.RuneCountInString(purpose) > 140 {
		return "", nil, httpx.BadRequest("id must be a uuid, name ^[a-z0-9][a-z0-9-]{0,31}$, purpose ≤ 140 characters.")
	}
	st := roster.NewState(b.ID)
	g, err := st.ApplyWire(b.Genesis)
	if err != nil {
		var re *roster.Error
		if errors.As(err, &re) {
			return "", nil, re.HTTPError()
		}
		return "", nil, err
	}
	if g.Op != "genesis" || g.Name != b.Name || g.Owner != account {
		return "", nil, httpx.E(400, "roster_invalid", "The first entry must be this room's genesis, owned by you.").With("rule", "validity")
	}
	if len(b.Entries) > 20 {
		return "", nil, httpx.BadRequest("At most 20 entries.")
	}
	return purpose, g, nil
}

// createRoom makes the room inside the caller's transaction, with every rule of SPEC §6.2: the genesis browser is the
// account's, rooms per owner ≤ 20, new rooms per day, the plan limit (paywall on), a name unique per owner, the extra
// device_add entries, the owner's chat invite. It is the one implementation behind POST /app/v1/rooms and a draft's
// confirm. created is false when this id already holds this owner's room with this genesis (a retry: nothing written).
func (a *API) createRoom(ctx context.Context, tx pgx.Tx, account string, b *roomCreate, purpose string, g *roster.Entry, hit *plans.Hit) (bool, error) {
	devPK, _ := hex.DecodeString(g.Device)
	var owner string
	var gh []byte
	err := tx.QueryRow(ctx, `select owner_account_id, genesis_hash from rooms where id = $1`, b.ID).Scan(&owner, &gh)
	if err == nil {
		if owner == account && bytes.Equal(gh, g.Hash) {
			return false, nil
		}
		return false, httpx.E(409, "id_conflict", "A different room already used this id.")
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	var mine bool
	if err := tx.QueryRow(ctx, `select exists(select 1 from devices where ed25519_pk = $1 and account_id = $2 and revoked_at is null)`,
		devPK, account).Scan(&mine); err != nil {
		return false, err
	}
	if !mine {
		return false, httpx.E(403, "not_signer", "Register this browser's device key first.")
	}
	var n int
	if err := tx.QueryRow(ctx, `select count(*) from rooms where owner_account_id = $1 and deleted_at is null`, account).Scan(&n); err != nil {
		return false, err
	}
	if n >= 20 {
		return false, httpx.RateLimited("quota_exceeded", 3600)
	}
	if err := ratelimit.Hit(ctx, tx, ratelimit.RoomsCreatedDay, account); err != nil { // blocker 8: no create-delete loop
		return false, err
	}
	if err := plans.Enforce(ctx, tx, a.St.Pool, a.Cfg.Plans.Mode(), plans.Rooms, account, "", n+1, hit); err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, `insert into rooms (id, owner_account_id, name, purpose, genesis_hash) values ($1,$2,$3,$4,$5)`,
		b.ID, account, b.Name, purpose, g.Hash); err != nil {
		if store.IsUniqueViolation(err, "rooms_owner_name_uq") {
			return false, httpx.E(409, "name_taken", "You already have a room with that name.")
		}
		if store.IsUniqueViolation(err, "rooms_pkey") {
			return false, httpx.E(409, "id_conflict", "A different room already used this id.")
		}
		return false, err
	}
	if _, err := tx.Exec(ctx, `insert into roster_entries (room_id, seq, op, entry, entry_hash, prev_hash, signer_pk, sig)
		values ($1, 0, 'genesis', $2, $3, null, $4, $5)`, b.ID, g.Raw, g.Hash, g.Signer, g.Sig); err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, `insert into room_people (room_id, account_id, role) values ($1,$2,'owner')`, b.ID, account); err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, `insert into room_signers (room_id, ed25519_pk, account_id, added_seq) values ($1,$2,$3,0)`,
		b.ID, devPK, account); err != nil {
		return false, err
	}
	for i, w := range b.Entries {
		if w.Seq != i+1 || w.Signer != g.Device {
			return false, httpx.E(400, "roster_invalid", "Extra entries follow genesis in order, signed by the genesis browser.").With("rule", "request_match")
		}
		e, _, err := store.AppendEntry(ctx, tx, b.ID, w)
		if err != nil {
			return false, err
		}
		if e.Op != "device_add" || e.Account != account {
			return false, httpx.E(400, "roster_invalid", "Extra entries must add your own browsers.").With("rule", "request_match")
		}
		dpk, _ := hex.DecodeString(e.Device)
		var approved bool
		if err := tx.QueryRow(ctx, `select exists(select 1 from devices where ed25519_pk = $1 and account_id = $2 and revoked_at is null and approved_at is not null)`,
			dpk, account).Scan(&approved); err != nil {
			return false, err
		}
		if !approved {
			return false, httpx.E(400, "roster_invalid", "Only browsers you already approved can be added here.").With("rule", "request_match")
		}
		if err := store.ApplyDerived(ctx, tx, b.ID, e); err != nil {
			return false, err
		}
	}
	if _, err = store.EnsureChatInvite(ctx, tx, b.ID, account); err != nil {
		return false, err
	}
	// browsers left out (never approved, or an older dashboard) show up as "New browser … Approve"
	return true, store.SyncDeviceAttention(ctx, tx, account, "")
}

// POST /app/v1/rooms: create with the signed genesis (idempotent by id + genesis hash).
func (a *API) postRoom(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b roomCreate
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	purpose, g, err := checkRoomCreate(&b, s.AccountID)
	if err != nil {
		return err
	}
	created := false
	var hit plans.Hit
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		var err error
		created, err = a.createRoom(ctx, tx, s.AccountID, &b, purpose, g, &hit)
		return err
	})
	hit.Report(a.An, err) // analytics limit_reached: at most once per account, limit and day
	if err != nil {
		return err
	}
	status := 200
	if created {
		status = 201
		a.An.Capture(analytics.RoomCreated, a.An.ID(s.AccountID), analytics.Props{"room": a.An.ID(b.ID)})
	}
	d, err := roomDetail(ctx, a.St.Pool, b.ID, s.AccountID, "")
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, status, d)
	return nil
}

func (a *API) getRoom(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	if _, err := myRole(ctx, a.St.Pool, r.PathValue("id"), s.AccountID); err != nil {
		return err
	}
	d, err := roomDetail(ctx, a.St.Pool, r.PathValue("id"), s.AccountID, r.URL.Query().Get("device_id"))
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, d)
	return nil
}

func (a *API) patchRoom(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if err := requireOwner(ctx, a.St.Pool, id, s.AccountID); err != nil {
		return err
	}
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		Purpose string `json:"purpose"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	if utf8.RuneCountInString(b.Purpose) > 140 {
		return httpx.BadRequest("purpose must be ≤ 140 characters.")
	}
	if _, err := a.St.Pool.Exec(ctx, `update rooms set purpose = $2 where id = $1`, id, b.Purpose); err != nil {
		return err
	}
	d, err := roomDetail(ctx, a.St.Pool, id, s.AccountID, "")
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, d)
	return nil
}

// DELETE /app/v1/rooms/{id}: owner deletes (members removed, copies dropped, invites off).
func (a *API) deleteRoom(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if err := requireOwner(ctx, a.St.Pool, id, s.AccountID); err != nil {
		return err
	}
	err := a.St.Tx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `update rooms set deleted_at = now() where id = $1 and deleted_at is null`, id)
		if err != nil || tag.RowsAffected() == 0 {
			return err
		}
		rows, err := tx.Query(ctx, `select id from members where room_id = $1 and removed_at is null for update`, id)
		if err != nil {
			return err
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		for _, m := range ids {
			if err := store.RemoveMember(ctx, tx, m); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `update invites set off = true where room_id = $1`, id); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `update join_requests set status = 'cancelled', decided_at = now() where room_id = $1 and status = 'pending'`, id); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `update person_requests set status = 'rejected', decided_at = now(), decided_by = $2
			where room_id = $1 and status = 'pending'`, id, s.AccountID); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `update attention set resolved_at = now() where room_id = $1 and resolved_at is null`, id)
		return err
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"ok": true})
	return nil
}

func (a *API) getRoster(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	if _, err := myRole(ctx, a.St.Pool, r.PathValue("id"), s.AccountID); err != nil {
		return err
	}
	v, err := store.RosterJSON(ctx, a.St.Pool, r.PathValue("id"), true)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, v)
	return nil
}

// POST /app/v1/rooms/{id}/roster: device_remove / person_remove / member_remove (remove, leave).
func (a *API) postRoster(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if _, err := myRole(ctx, a.St.Pool, id, s.AccountID); err != nil {
		return err
	}
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		RosterEntry roster.Wire `json:"roster_entry"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	signer, ok := wire.DecodeHex32(b.RosterEntry.Signer)
	if !ok {
		return httpx.BadRequest("signer must be 64 lowercase hex chars.")
	}
	var op string
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		var mine bool
		if err := tx.QueryRow(ctx, `select exists(select 1 from devices where ed25519_pk = $1 and account_id = $2 and revoked_at is null)`,
			signer, s.AccountID).Scan(&mine); err != nil {
			return err
		}
		if !mine {
			return httpx.E(403, "not_signer", "Sign with one of your own approved browsers.")
		}
		e, _, err := store.AppendEntry(ctx, tx, id, b.RosterEntry)
		if err != nil {
			return err
		}
		switch e.Op {
		case "device_remove", "person_remove", "member_remove":
		default:
			return httpx.BadRequest("Only device_remove, person_remove and member_remove go here.")
		}
		op = e.Op
		return store.ApplyDerived(ctx, tx, id, e)
	})
	if err != nil {
		return err
	}
	if op == "member_remove" {
		a.An.Capture(analytics.MemberRemoved, a.An.ID(s.AccountID), analytics.Props{"room": a.An.ID(id), "left": false})
	}
	d, err := roomDetail(ctx, a.St.Pool, id, s.AccountID, "")
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, d)
	return nil
}

type activity struct {
	At     time.Time
	Kind   string
	From   *string
	To     *string
	Person *string
}

// GET /app/v1/rooms/{id}/activity: metadata only (who → whom, when; joins/leaves/moves).
func (a *API) getActivity(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if _, err := myRole(ctx, a.St.Pool, id, s.AccountID); err != nil {
		return err
	}
	before := time.Now().Add(time.Hour)
	if v := r.URL.Query().Get("before"); v != "" {
		t, err := time.Parse(time.RFC3339Nano, v)
		if err != nil {
			return httpx.BadRequest("before must be a date-time.")
		}
		before = t
	}
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 100 {
			return httpx.BadRequest("limit must be 1..100.")
		}
		limit = n
	}
	var items []activity
	rows, err := a.St.Pool.Query(ctx, `select m.created_at, f.name, t.name from messages m join members f on f.id = m.from_member
		left join members t on t.id = m.to_member where m.room_id = $1 and m.scope <> 'self' and m.created_at < $2 order by m.created_at desc limit $3`, id, before, limit)
	if err != nil {
		return err
	}
	for rows.Next() {
		var it activity
		it.Kind = "message"
		if err := rows.Scan(&it.At, &it.From, &it.To); err != nil {
			rows.Close()
			return err
		}
		items = append(items, it)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	rows, err = a.St.Pool.Query(ctx, `select e.created_at, e.op, e.entry, exists(select 1 from room_signers s where s.room_id = e.room_id and s.ed25519_pk = e.signer_pk)
		from roster_entries e where e.room_id = $1 and e.op in ('member_add','member_rekey','member_remove','person_add','person_remove')
		and e.created_at < $2 order by e.seq desc limit $3`, id, before, limit)
	if err != nil {
		return err
	}
	type rawEv struct {
		at       time.Time
		op       string
		entry    []byte
		byDevice bool
	}
	var evs []rawEv
	for rows.Next() {
		var ev rawEv
		if err := rows.Scan(&ev.at, &ev.op, &ev.entry, &ev.byDevice); err != nil {
			rows.Close()
			return err
		}
		evs = append(evs, ev)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, ev := range evs {
		e, err := roster.Parse(ev.entry, 0)
		if err != nil {
			continue
		}
		it := activity{At: ev.at}
		switch ev.op {
		case "member_add", "member_rekey", "member_remove":
			var name string
			if err := a.St.Pool.QueryRow(ctx, `select name from members where id = $1`, e.Member).Scan(&name); err != nil {
				if e.Name != "" {
					name = e.Name
				} else {
					continue
				}
			}
			it.From = &name
			it.Kind = map[string]string{"member_add": "joined", "member_rekey": "moved", "member_remove": "removed"}[ev.op]
			if ev.op == "member_remove" && !ev.byDevice {
				it.Kind = "left"
			}
		case "person_add", "person_remove":
			var name string
			if err := a.St.Pool.QueryRow(ctx, `select display_name from accounts where id = $1`, e.Account).Scan(&name); err != nil {
				continue
			}
			it.Person = &name
			it.Kind = map[string]string{"person_add": "person_joined", "person_remove": "person_left"}[ev.op]
		}
		items = append(items, it)
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].At.After(items[j].At) })
	if len(items) > limit {
		items = items[:limit]
	}
	out := make([]map[string]any, 0, len(items))
	for _, it := range items {
		out = append(out, map[string]any{"at": it.At.UTC(), "kind": it.Kind, "from_name": it.From, "to_name": it.To, "person_name": it.Person})
	}
	httpx.WriteJSON(w, 200, map[string]any{"items": out})
	return nil
}

// ── chat invites

func (a *API) chatInviteJSON(ctx context.Context, q store.Q, roomID, account string) (map[string]any, error) {
	var code, room string
	var exp time.Time
	var off bool
	var uses int
	if err := q.QueryRow(ctx, `select i.code, i.expires_at, i.off, i.use_count, r.name from invites i join rooms r on r.id = i.room_id
		where i.room_id = $1 and i.account_id = $2 and i.kind = 'chat'`, roomID, account).Scan(&code, &exp, &off, &uses, &room); err != nil {
		return nil, err
	}
	return map[string]any{"room_id": roomID, "url": store.ChatInviteURL(a.Cfg.AppOrigin, room, code), "code": code,
		"expires_at": exp.UTC(), "off": off, "use_count": uses}, nil
}

func (a *API) getChatInvite(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if _, err := myRole(ctx, a.St.Pool, id, s.AccountID); err != nil {
		return err
	}
	if _, err := store.EnsureChatInvite(ctx, a.St.Pool, id, s.AccountID); err != nil {
		return err
	}
	v, err := a.chatInviteJSON(ctx, a.St.Pool, id, s.AccountID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, v)
	return nil
}

func (a *API) postChatInvite(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if _, err := myRole(ctx, a.St.Pool, id, s.AccountID); err != nil {
		return err
	}
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		Action string `json:"action"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	if _, err := store.EnsureChatInvite(ctx, a.St.Pool, id, s.AccountID); err != nil {
		return err
	}
	switch b.Action {
	case "renew":
		for i := 0; ; i++ {
			_, err := a.St.Pool.Exec(ctx, `update invites set code = $3, expires_at = now() + interval '24 hours', use_count = 0, off = false
				where room_id = $1 and account_id = $2 and kind = 'chat'`, id, s.AccountID, wire.RandCode(10))
			if err == nil {
				break
			}
			if !store.IsUniqueViolation(err, "invites_code_key") || i > 20 {
				return err
			}
		}
	case "off", "on":
		if _, err := a.St.Pool.Exec(ctx, `update invites set off = $3 where room_id = $1 and account_id = $2 and kind = 'chat'`,
			id, s.AccountID, b.Action == "off"); err != nil {
			return err
		}
	default:
		return httpx.BadRequest("action must be renew, off or on.")
	}
	v, err := a.chatInviteJSON(ctx, a.St.Pool, id, s.AccountID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, v)
	return nil
}

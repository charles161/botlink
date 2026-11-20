// Package store is the DB logic both surfaces share: roster appends with their derived tables (one
// transaction), removal effects, notices, attention, and the read models (roster view, turn labels).
// Hand-written pgx queries (see CONTRACT-CHANGES.md: why not sqlc).
package store

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/metrics"
	"github.com/charles161/botlink/server/internal/roster"
	"github.com/charles161/botlink/server/internal/wire"
)

// Q is the subset of pgx shared by pools and transactions.
type Q interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type Store struct {
	Pool      *pgxpool.Pool
	Metrics   *metrics.Set
	AppOrigin string
}

// Tx runs fn in one read-committed transaction.
func (s *Store) Tx(ctx context.Context, fn func(tx pgx.Tx) error) error {
	return pgx.BeginTxFunc(ctx, s.Pool, pgx.TxOptions{IsoLevel: pgx.ReadCommitted}, fn)
}

// DBNow returns Postgres now() as unix seconds.
func DBNow(ctx context.Context, q Q) (int64, error) {
	var n int64
	err := q.QueryRow(ctx, `select floor(extract(epoch from now()))::bigint`).Scan(&n)
	return n, err
}

// ── roster

// LoadRoster replays the stored log (signatures were verified on insert).
func LoadRoster(ctx context.Context, q Q, roomID string) (*roster.State, []roster.Wire, error) {
	rows, err := q.Query(ctx, `select seq, entry, sig, signer_pk from roster_entries where room_id = $1 order by seq`, roomID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	st := roster.NewState(roomID)
	var ws []roster.Wire
	for rows.Next() {
		var seq int
		var entry, sig, signer []byte
		if err := rows.Scan(&seq, &entry, &sig, &signer); err != nil {
			return nil, nil, err
		}
		if _, err := st.Apply(seq, entry, sig, signer, false); err != nil {
			return nil, nil, fmt.Errorf("stored roster of %s is invalid: %w", roomID, err)
		}
		ws = append(ws, roster.Wire{Seq: seq, Entry: wire.B64URL(entry), Sig: hex.EncodeToString(sig), Signer: hex.EncodeToString(signer)})
	}
	return st, ws, rows.Err()
}

// ErrRosterConflict is 409 roster_conflict.
func RosterConflict(head int) *httpx.Error {
	return httpx.E(409, "roster_conflict", "The member list changed. Refresh and try again.").With("head_seq", head)
}

// Lock order, for every transaction that locks more than one of these: the rooms row first, then member rows, then
// join requests. AppendEntry takes the rooms row (its roster_head_seq CAS); the member-list changes it carries
// (ApplyDerived: RemovePerson, RemoveMember) and a room delete (DeleteRoom, appapi deleteRoom: update rooms first) then
// write members and join requests; a send takes the rooms row before it locks member rows (agentapi
// lockRoomForLastMessage). So an approval, single or batch, takes the room with LockRoom before it locks the join
// requests it approves; taking them the other way round deadlocks against a person's removal or a room's delete.
// server/internal/appapi/lockorder_test.go fails on a function that locks join_requests before the rooms row.

// LockRoom takes the rooms row in the mode AppendEntry's CAS takes it (FOR NO KEY UPDATE: rows that only reference the
// room, a message or a member, are not blocked).
func LockRoom(ctx context.Context, tx pgx.Tx, roomID string) error {
	_, err := tx.Exec(ctx, `select 1 from rooms where id = $1 for no key update`, roomID)
	return err
}

// AppendEntry validates w against the stored log and inserts it. The rooms row CAS
// (roster_head_seq = seq-1) serialises appends per room and detects conflicts. Derived tables are
// the caller's job (see ApplyDerived), in the same transaction.
func AppendEntry(ctx context.Context, tx pgx.Tx, roomID string, w roster.Wire) (*roster.Entry, *roster.State, error) {
	raw, sig, signer, err := roster.DecodeWire(w)
	if err != nil {
		return nil, nil, err.(*roster.Error).HTTPError()
	}
	if raw == nil {
		return nil, nil, (&roster.Error{Rule: "bad_entry", Seq: w.Seq, Msg: "entry is not base64url without padding"}).HTTPError()
	}
	if w.Seq < 1 {
		return nil, nil, httpx.BadRequest("Only the room's first entry can have seq 0.")
	}
	tag, err := tx.Exec(ctx, `update rooms set roster_head_seq = $2 where id = $1 and roster_head_seq = $2 - 1 and deleted_at is null`, roomID, w.Seq)
	if err != nil {
		return nil, nil, err
	}
	if tag.RowsAffected() == 0 {
		var head int
		var deleted bool
		err := tx.QueryRow(ctx, `select roster_head_seq, deleted_at is not null from rooms where id = $1`, roomID).Scan(&head, &deleted)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, httpx.NotFound()
		}
		if err != nil {
			return nil, nil, err
		}
		if deleted {
			return nil, nil, httpx.E(410, "room_gone", "This room was deleted.")
		}
		return nil, nil, RosterConflict(head)
	}
	st, _, err := LoadRoster(ctx, tx, roomID)
	if err != nil {
		return nil, nil, err
	}
	signerHex := hex.EncodeToString(signer)
	e, err := st.Apply(w.Seq, raw, sig, signer, true)
	if err != nil {
		var re *roster.Error
		if errors.As(err, &re) {
			if re.Rule == "signer" {
				if _, isDevice := st.DeviceOwner[signerHex]; !isDevice && !isMemberKey(st, signerHex) {
					return nil, nil, httpx.E(403, "not_signer", "This browser isn't approved to sign for this room yet.")
				}
			}
			if re.Rule == "seq" { // can't happen after the CAS, but keep the mapping honest
				return nil, nil, RosterConflict(st.HeadSeq)
			}
			return nil, nil, re.HTTPError()
		}
		return nil, nil, err
	}
	var prev []byte
	if w.Seq > 0 {
		prev, _ = hex.DecodeString(e.Prev)
	}
	if _, err := tx.Exec(ctx, `insert into roster_entries (room_id, seq, op, entry, entry_hash, prev_hash, signer_pk, sig)
		values ($1,$2,$3,$4,$5,$6,$7,$8)`, roomID, w.Seq, e.Op, raw, e.Hash, prev, signer, sig); err != nil {
		return nil, nil, err
	}
	return e, st, nil
}

func isMemberKey(st *roster.State, pk string) bool {
	for _, m := range st.Members {
		if m.Active && m.Ed == pk {
			return true
		}
	}
	return false
}

// ApplyDerived updates room_people / room_signers / members for device_*, person_* and member_remove
// entries, then queues roster_changed notices. member_add / member_rekey callers insert/update the
// member row themselves (they need the request's display data) and then call RosterChanged.
func ApplyDerived(ctx context.Context, tx pgx.Tx, roomID string, e *roster.Entry) error {
	actor, err := deviceAccount(ctx, tx, e.By)
	if err != nil {
		return err
	}
	switch e.Op {
	case "device_add":
		pk, _ := hex.DecodeString(e.Device)
		if err := upsertSigner(ctx, tx, roomID, pk, e.Account, e.Seq); err != nil {
			return err
		}
	case "device_remove":
		pk, _ := hex.DecodeString(e.Device)
		if _, err := tx.Exec(ctx, `update room_signers set removed_seq = $3 where room_id = $1 and ed25519_pk = $2 and removed_seq is null`,
			roomID, pk, e.Seq); err != nil {
			return err
		}
	case "person_add":
		if _, err := tx.Exec(ctx, `insert into room_people (room_id, account_id, role) values ($1,$2,'person')
			on conflict (room_id, account_id) do update set removed_at = null, added_at = now()`, roomID, e.Account); err != nil {
			return err
		}
		pk, _ := hex.DecodeString(e.Device)
		if err := upsertSigner(ctx, tx, roomID, pk, e.Account, e.Seq); err != nil {
			return err
		}
	case "person_remove":
		rows, err := tx.Query(ctx, `select id from members where room_id = $1 and account_id = $2 and removed_at is null`, roomID, e.Account)
		if err != nil {
			return err
		}
		gone, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		if err := RemovePerson(ctx, tx, roomID, e.Account, e.Seq); err != nil {
			return err
		}
		for _, id := range gone {
			if err := MembershipAttention(ctx, tx, roomID, id, "member_left", "removed", actor); err != nil {
				return err
			}
		}
	case "member_remove":
		var active bool
		if err := tx.QueryRow(ctx, `select exists(select 1 from members where id = $1 and removed_at is null)`, e.Member).Scan(&active); err != nil {
			return err
		}
		if err := RemoveMember(ctx, tx, e.Member); err != nil {
			return err
		}
		if active {
			how := "removed"
			if actor == "" {
				how = "left" // signed by the member's own key
			}
			if err := MembershipAttention(ctx, tx, roomID, e.Member, "member_left", how, actor); err != nil {
				return err
			}
		}
	}
	switch e.Op {
	case "device_add", "device_remove", "person_add", "person_remove":
		if err := SyncDeviceAttention(ctx, tx, e.Account, ""); err != nil {
			return err
		}
	}
	return RosterChanged(ctx, tx, roomID)
}

func upsertSigner(ctx context.Context, tx pgx.Tx, roomID string, pk []byte, account string, seq int) error {
	_, err := tx.Exec(ctx, `insert into room_signers (room_id, ed25519_pk, account_id, added_seq) values ($1,$2,$3,$4)
		on conflict (room_id, ed25519_pk) do update set account_id = excluded.account_id, added_seq = excluded.added_seq, removed_seq = null`,
		roomID, pk, account, seq)
	return err
}

// RosterChanged queues one open roster_changed notice per active member (deduped by index).
func RosterChanged(ctx context.Context, tx pgx.Tx, roomID string) error {
	_, err := tx.Exec(ctx, `
		insert into notices (member_id, kind, data)
		select m.id, 'roster_changed', jsonb_build_object('head_seq', r.roster_head_seq)
		from members m join rooms r on r.id = m.room_id
		where m.room_id = $1 and m.removed_at is null
		on conflict (member_id) where kind = 'roster_changed' and acked_at is null
		do update set data = excluded.data`, roomID)
	return err
}

// RemoveMember applies SPEC §6.10 effects for one member.
func RemoveMember(ctx context.Context, tx pgx.Tx, memberID string) error {
	tag, err := tx.Exec(ctx, `update members set removed_at = now() where id = $1 and removed_at is null`, memberID)
	if err != nil || tag.RowsAffected() == 0 {
		return err
	}
	if _, err := tx.Exec(ctx, `update deliveries set state = 'expired', envelope = null, lease_until = null, stuck_reason = null
		where member_id = $1 and state in ('queued','stuck','needs_resend')`, memberID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `update join_requests set status = 'cancelled', decided_at = now()
		where member_id = $1 and status = 'pending'`, memberID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `update push_jobs set done = true where member_id = $1 and not done`, memberID); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `update attention set resolved_at = now() where subject_id = $1 and resolved_at is null`, memberID)
	return err
}

// RemovePerson: room_people.removed_at, their signers removed, their members removed, their pending
// requests cancelled, their chat invite off.
func RemovePerson(ctx context.Context, tx pgx.Tx, roomID, account string, seq int) error {
	if _, err := tx.Exec(ctx, `update room_people set removed_at = now() where room_id = $1 and account_id = $2 and role = 'person' and removed_at is null`,
		roomID, account); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `update room_signers set removed_seq = $3 where room_id = $1 and account_id = $2 and removed_seq is null`,
		roomID, account, seq); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `select id from members where room_id = $1 and account_id = $2 and removed_at is null`, roomID, account)
	if err != nil {
		return err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err := RemoveMember(ctx, tx, id); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `update join_requests set status = 'cancelled', decided_at = now()
		where room_id = $1 and for_account_id = $2 and status = 'pending'`, roomID, account); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `update invites set off = true where room_id = $1 and account_id = $2 and kind = 'chat'`, roomID, account); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `update attention set resolved_at = now() where account_id = $2 and room_id = $1 and resolved_at is null`, roomID, account)
	return err
}

// ── attention + notices

// UpsertAttention records an open "What needs you" item (deduped while open).
func UpsertAttention(ctx context.Context, q Q, account string, room *string, kind, subject string, data map[string]any) error {
	if data == nil {
		data = map[string]any{}
	}
	_, err := q.Exec(ctx, `insert into attention (id, account_id, room_id, kind, subject_id, data) values ($1,$2,$3,$4,$5,$6)
		on conflict (account_id, kind, subject_id) where resolved_at is null do update set data = excluded.data
		where attention.data is distinct from excluded.data`,
		wire.NewV7(), account, room, kind, subject, data)
	return err
}

// ── stuck

// MarkStuck turns over-limit, unleased queued copies of a member into stuck and tells its person.
func (s *Store) MarkStuck(ctx context.Context, q Q, memberID string) (int, error) {
	rows, err := q.Query(ctx, `update deliveries set state = 'stuck',
			stuck_reason = case when attempts >= 5 then 'attempts' else 'wakes' end, lease_until = null
		where member_id = $1 and state = 'queued' and (lease_until is null or lease_until < now())
		  and (attempts >= 5 or wakes >= 5)
		returning stuck_reason`, memberID)
	if err != nil {
		return 0, err
	}
	reasons, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil || len(reasons) == 0 {
		return 0, err
	}
	// five wakes went unanswered: whatever was shown before, nothing wakes this chat now. The room must not keep
	// saying "wakes on its own" (SPEC §6.9, 2026-11-11); the next proven wake sets it again.
	for _, r := range reasons {
		if r == "wakes" {
			if _, err := q.Exec(ctx, `update members set wake_verified_at = null where id = $1`, memberID); err != nil {
				return 0, err
			}
			break
		}
	}
	if s.Metrics != nil {
		s.Metrics.Stuck.Add(uint64(len(reasons)))
	}
	return len(reasons), s.stuckAttention(ctx, q, memberID, reasons[0])
}

func (s *Store) stuckAttention(ctx context.Context, q Q, memberID, reason string) error {
	var account, room string
	var count int
	if err := q.QueryRow(ctx, `select m.account_id, m.room_id,
			(select count(*) from deliveries d where d.member_id = m.id and d.state = 'stuck')
		from members m where m.id = $1`, memberID).Scan(&account, &room, &count); err != nil {
		return err
	}
	return UpsertAttention(ctx, q, account, &room, "stuck", memberID, map[string]any{"count": count, "reason": reason})
}

// StuckAttention is used by the reject ack path.
func (s *Store) StuckAttention(ctx context.Context, q Q, memberID, reason string) error {
	return s.stuckAttention(ctx, q, memberID, reason)
}

// ── read models

// PresenceWindowS: a chat that made an inbox / wait / presence call within this many seconds is "seen polling"
// (dashboard presence flip, admin). Polling alone never makes a member look fast (SPEC §6.9 r3).
const PresenceWindowS = 90

// Seen records an inbox / wait / presence call (SPEC §6.9). Only a false → true flip of presence_live NOTIFYs the
// room's people (trigger members_presence_notify), not every call.
func Seen(ctx context.Context, q Q, memberID string) error {
	_, err := q.Exec(ctx, `update members set last_seen_at = now(), presence_live = true where id = $1`, memberID)
	return err
}

// Presence is what the server has seen a member's chat do (SPEC §6.9, computed from real behaviour):
//   - WaitFresh: a listener holds the non-leasing wait (watch, `botlink listen`) within 70 s;
//   - PollFresh: the chat's own wake path polls (Claude Code's idle waiter, its own loop) within 70-90 s;
//   - WakeVerified: an idle wake was observed for the chat holding the member (a copy shown by a woken run, or
//     right after a listener counted a wake for it), and nothing is stuck since.
//   - Active (critical fix L5): the chat itself made a bot-link call within 3 minutes (it is in a turn, or just
//     finished one);
//   - PollPath: the chat's wake path is its own idle waiter (Claude Code's Stop hook), not a listener's wait;
//   - WaitRecent3m / WaitRecent24h / PollRecent24h (critical fix M1): when the wake path last reported.
type Presence struct {
	WaitFresh, PollFresh, WakeVerified                         bool
	Active, PollPath, WaitRecent3m, WaitRecent24h, PollRecent24h bool
}

// PresenceSQL selects Presence's observed columns for members m, in Scan order: WaitFresh, PollFresh, Active,
// PollPath, WaitRecent3m, WaitRecent24h, PollRecent24h (the room page and the admin area use the same rule).
//
// bot-link Events (SPEC §6.13): a subscription that is on (verified, not expired, made by the chat that holds the
// member now) AND whose endpoint is taking events (nothing failing for more than 3 minutes) is a wake path that is
// running: it counts like a listener holding the wait. One whose endpoint has been failing for 3 minutes, or that
// failures turned off, within the last day counts like a listener that went silent ("listener down"): the room must
// not keep saying "wakes on its own" for a chat whose endpoint is gone.
const liveSubSQL = `exists (select 1 from event_subscriptions es where es.member_id = m.id and es.key_epoch = m.key_epoch
		         and es.name = 'message.received' and es.verified_at is not null and es.disabled_at is null and es.expires_at > now()
		         and (es.failed_since is null or es.failed_since > now() - interval '180 seconds'))`

// (also one that simply lapsed within the day: a receiver that crashed stops renewing; a receiver stopped on purpose
// removes its subscription, so that case never shows as down)
const downSubSQL = `exists (select 1 from event_subscriptions es where es.member_id = m.id and es.key_epoch = m.key_epoch
		         and es.name = 'message.received' and es.expires_at > now() - interval '24 hours'
		         and (es.expires_at <= now() or es.disabled_at > now() - interval '24 hours' or es.failed_since > now() - interval '24 hours'))`

const PresenceSQL = `(coalesce(m.last_wait_at > now() - interval '70 seconds', false) or ` + liveSubSQL + `),
		       coalesce((m.last_seen_at > now() - interval '90 seconds' and (m.last_wait_at is null or m.last_seen_at > m.last_wait_at + interval '2 seconds'))
		                or m.last_poll_at > now() - interval '70 seconds', false),
		       coalesce(m.last_seen_at > now() - interval '180 seconds' and (m.last_wait_at is null or m.last_seen_at > m.last_wait_at + interval '2 seconds'), false),
		       (coalesce(m.last_poll_at is not null and (m.last_wait_at is null or m.last_poll_at >= m.last_wait_at), false)
		         and not (` + liveSubSQL + ` or ` + downSubSQL + `)),
		       (coalesce(m.last_wait_at > now() - interval '180 seconds', false) or ` + liveSubSQL + `),
		       (coalesce(m.last_wait_at > now() - interval '24 hours', false) or ` + downSubSQL + `),
		       coalesce(m.last_poll_at > now() - interval '24 hours', false)`

// Labels (SPEC §6.9 r3). The only three a member is ever shown as.
const (
	LabelAlwaysOn = "always on"
	LabelWakes    = "wakes on its own"
	LabelNextTurn = "answers on its next turn"
	// LabelDown (critical fix M1, founder decision 5A): the chat's wake path (a listener, watch, its idle waiter) was
	// working and has gone silent: nothing wakes the chat until its human opens it.
	LabelDown = "listener down"
)

// TurnLabel is SPEC §6.9's roster label, from observed behaviour, never from the app or from what the member claims:
//
//	turn always_on                                                   "always on"
//	an idle wake was observed (WakeVerified) AND its wake path is
//	  running now (a listener holds the wait, or the chat polls)     "wakes on its own"
//	anything else (Codex desktop, Cursor, unknown apps, a chat that
//	  only polls at its own turns, a listener never seen working)    "answers on its next turn"
//
// Polling alone (an inbox / count / presence call) never makes a member "wakes on its own".
func TurnLabel(turn string, p Presence) string {
	switch {
	case turn == "always_on":
		return LabelAlwaysOn
	case p.WakeVerified && (p.WaitFresh || p.PollFresh || (p.Active && (p.PollPath || p.WaitRecent3m))):
		// L5: a chat whose idle wake was proven keeps its label while it works (its idle waiter only runs between
		// turns; a --once listener is re-armed after the turn)
		return LabelWakes
	case !p.PollPath && p.WaitRecent24h && !p.WaitRecent3m:
		// M1: a listener / watch held the wait within a day and has been silent for 3 minutes
		return LabelDown
	case p.PollPath && p.WakeVerified && p.PollRecent24h && !p.PollFresh && !p.Active:
		// M1: the chat's proven idle waiter stopped (the app closed, or the waiter gave up)
		return LabelDown
	}
	return LabelNextTurn
}

// MemberRow is one active member with display data.
type MemberRow struct {
	ID, Name, App, Job, Folder, Machine, Turn string
	AppName                                   *string // unsigned display: which "other" app (opencode)
	SelfLabel                                 *string // unsigned display: the member's own words about its availability
	AccountID, PersonName                     string
	Ed, X                                     []byte
	JoinedAt                                  time.Time
	Stuck                                     bool
	TurnLabel                                 string
}

func (m MemberRow) Fingerprint() string { return wire.MemberFP(m.Ed, m.X) }

// AppNameOrNil is app_name for JSON (null when unset).
func (m MemberRow) AppNameOrNil() any {
	if m.AppName == nil {
		return nil
	}
	return *m.AppName
}

// ActiveMembers lists a room's current members (display data, server's view).
func ActiveMembers(ctx context.Context, q Q, roomID string) ([]MemberRow, error) {
	rows, err := q.Query(ctx, `
		select m.id, m.name, m.app, m.job, m.folder, m.machine, m.turn, m.account_id, a.display_name,
		       m.ed25519_pk, m.x25519_pk, m.joined_at,
		       `+PresenceSQL+`,
		       exists (select 1 from deliveries d where d.member_id = m.id and d.state = 'stuck'), m.app_name,
		       m.wake_verified_at is not null, m.self_label
		from members m join accounts a on a.id = m.account_id
		where m.room_id = $1 and m.removed_at is null
		order by m.joined_at, m.id`, roomID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MemberRow
	for rows.Next() {
		var r MemberRow
		var p Presence
		var verified bool
		if err := rows.Scan(&r.ID, &r.Name, &r.App, &r.Job, &r.Folder, &r.Machine, &r.Turn, &r.AccountID, &r.PersonName,
			&r.Ed, &r.X, &r.JoinedAt, &p.WaitFresh, &p.PollFresh, &p.Active, &p.PollPath, &p.WaitRecent3m, &p.WaitRecent24h, &p.PollRecent24h, &r.Stuck, &r.AppName, &verified, &r.SelfLabel); err != nil {
			return nil, err
		}
		p.WakeVerified = verified && !r.Stuck
		r.TurnLabel = TurnLabel(r.Turn, p)
		out = append(out, r)
	}
	return out, rows.Err()
}

// RosterJSON is the Roster schema. withStuck adds the dashboard-only flag.
func RosterJSON(ctx context.Context, q Q, roomID string, withStuck bool) (map[string]any, error) {
	st, ws, err := LoadRoster(ctx, q, roomID)
	if err != nil {
		return nil, err
	}
	ms, err := ActiveMembers(ctx, q, roomID)
	if err != nil {
		return nil, err
	}
	views := make([]map[string]any, 0, len(ms))
	for _, m := range ms {
		v := map[string]any{"member_id": m.ID, "name": m.Name, "app": m.App, "app_name": m.AppNameOrNil(), "job": m.Job, "folder": m.Folder,
			"turn": m.Turn, "turn_label": m.TurnLabel, "person_name": m.PersonName, "self_label": m.SelfLabel}
		if withStuck {
			v["stuck"] = m.Stuck
		}
		views = append(views, v)
	}
	if ws == nil {
		ws = []roster.Wire{}
	}
	return map[string]any{"room_id": roomID, "head_seq": st.HeadSeq, "entries": ws, "members": views}, nil
}

// RoomBrief is {id, name, purpose}.
func RoomBrief(ctx context.Context, q Q, roomID string) (map[string]any, error) {
	var name, purpose string
	if err := q.QueryRow(ctx, `select name, purpose from rooms where id = $1`, roomID).Scan(&name, &purpose); err != nil {
		return nil, err
	}
	return map[string]any{"id": roomID, "name": name, "purpose": purpose}, nil
}

// IsUniqueViolation reports a 23505 on the named index/constraint (any if name == "").
func IsUniqueViolation(err error, name string) bool {
	return httpx.PgCode(err) == "23505" && (name == "" || httpx.PgConstraint(err) == name)
}

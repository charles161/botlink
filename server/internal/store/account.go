package store

// Self-serve account export and delete (fix-all blocker 3, lane ACCOUNT). The design note is in
// .fixall-account-REPORT.md and SPEC §6.15. In short:
//   - export: one JSON document with every row the server holds about the account. Sealed copies are counted and
//     sized, never included (the server cannot open them; the chats already hold the text). No secrets (session
//     tokens, CSRF tokens, push and event secrets, human-check challenges), no other person's email address.
//   - delete: the person's own browser signs person_remove in every room they are a person in (the server cannot sign
//     a member list); rooms they own are deleted (hard when no one else is in them, soft when someone is, so the
//     other people's chats are told the room is gone); then their rows are deleted or anonymised, in ONE transaction.
//     The accounts row stays as an anonymised tombstone because the signed member lists, room history and payment
//     records reference its id.

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/roster"
)

// ExportCap bounds the message records listed per direction (counts and sizes are always complete).
const ExportCap = 5000

// jsonList runs sql as a subquery and returns its rows as a JSON array (column order kept).
func jsonList(ctx context.Context, q Q, sql string, args ...any) (json.RawMessage, error) {
	var s string
	err := q.QueryRow(ctx, `select coalesce(json_agg(x), '[]'::json)::text from (`+sql+`) x`, args...).Scan(&s)
	return json.RawMessage(s), err
}

// jsonOne returns the single row of sql as a JSON object (null when there is none).
func jsonOne(ctx context.Context, q Q, sql string, args ...any) (json.RawMessage, error) {
	var s *string
	err := q.QueryRow(ctx, `select row_to_json(x)::text from (`+sql+`) x`, args...).Scan(&s)
	if errors.Is(err, pgx.ErrNoRows) || s == nil {
		return json.RawMessage("null"), nil
	}
	return json.RawMessage(*s), err
}

// b64url renders a bytea as base64url without padding (SQL).
func b64url(col string) string {
	return `rtrim(translate(encode(` + col + `, 'base64'), E'+/\n', '-_'), '=')`
}

type exportPart struct {
	key, sql string
	one      bool
}

// ExportAccount returns every row the server holds about account, as JSON sections. sessionHash marks this session.
// $1 is the account id (uuid), $2 the same id as text, $3 this session's token hash. With the paywall off the plan
// section and the plan-limit notes are left out when they hold no row of the account (paidExportPart); a row written
// before the paywall was switched off is still given, because the export gives every row held.
func ExportAccount(ctx context.Context, q Q, account string, sessionHash []byte, paywall bool) (map[string]any, error) {
	myMembers := `(select id from members where account_id = $1)`
	myRooms := `(select room_id from room_people where account_id = $1)`
	parts := []exportPart{
		{key: "account", one: true, sql: `select id, email, display_name, avatar_url, created_at, wakes_paused_at, had_passkey_at,
			sends_refused_at, sends_refused_at is not null as sends_refused from accounts where id = $1`},
		{key: "sign_ins", sql: `select provider, subject, email, created_at from identities where account_id = $1 order by created_at`},
		{key: "sessions", sql: `select created_at, last_seen_at, expires_at, user_agent, uv_at as passkey_used_at, admin_until,
			device_id as browser_id, token_hash = $3 as this_browser from web_sessions where account_id = $1 order by created_at`},
		{key: "browsers", sql: `select id, label, encode(ed25519_pk, 'hex') as ed25519_pk, created_at, approved_at, revoked_at
			from devices where account_id = $1 order by created_at`},
		{key: "passkeys", sql: `select ` + b64url("id") + ` as id, ` + b64url("public_key") + ` as public_key,
			encode(coalesce(aaguid, ''::bytea), 'hex') as aaguid, transports, sign_count, flags, created_at, last_used_at,
			created_device_id as made_in_browser_id, created_user_agent as made_in_browser,
			last_used_device_id as last_used_in_browser_id, last_used_user_agent as last_used_in_browser
			from webauthn_credentials where account_id = $1 order by created_at`},
		{key: "rooms", sql: `select r.id, r.name, r.purpose, p.role, o.display_name as owner_name, r.created_at,
			r.deleted_at as room_deleted_at, p.added_at, p.removed_at, r.roster_head_seq,
			case when p.removed_at is null and r.deleted_at is null then
			  (select coalesce(json_agg(json_build_object('display_name', a2.display_name, 'role', p2.role) order by p2.added_at), '[]'::json)
			   from room_people p2 join accounts a2 on a2.id = p2.account_id where p2.room_id = r.id and p2.removed_at is null)
			end as people_now
			from room_people p join rooms r on r.id = p.room_id join accounts o on o.id = r.owner_account_id
			where p.account_id = $1 order by p.added_at`},
		// signed member-list entries that name this account, its browsers or its chats (decoded; every member of the
		// room holds the same signed entries)
		{key: "member_list_entries", sql: `select e.room_id, e.seq, e.op, convert_from(e.entry, 'UTF8')::json as entry,
			encode(e.signer_pk, 'hex') as signer, e.created_at from roster_entries e
			where e.room_id in ` + myRooms + ` and (
			  e.signer_pk in (select ed25519_pk from devices where account_id = $1)
			  or convert_from(e.entry, 'UTF8')::jsonb ->> 'account' = $2 or convert_from(e.entry, 'UTF8')::jsonb ->> 'owner' = $2
			  or convert_from(e.entry, 'UTF8')::jsonb ->> 'member' in (select id::text from members where account_id = $1))
			order by e.room_id, e.seq`},
		{key: "chats", sql: `select m.id, m.room_id, r.name as room_name, m.name, m.app, m.app_name, m.job, m.folder, m.machine,
			m.turn, m.self_label, encode(m.ed25519_pk, 'hex') as ed25519_pk, encode(m.x25519_pk, 'hex') as x25519_pk, m.key_epoch,
			m.holder_session, m.push_url, m.push_verified_at, m.push_secret is not null as push_key_stored,
			m.handover_env is not null as handover_note_stored, m.joined_at, m.removed_at, m.last_seen_at, m.last_poll_at,
			m.last_wait_at, m.wake_verified_at, m.presence_live
			from members m join rooms r on r.id = m.room_id where m.account_id = $1 order by m.joined_at`},
		{key: "invites", sql: `select i.id, i.room_id, r.name as room_name, i.kind, i.code, i.created_at, i.expires_at, i.off,
			i.use_count, i.used_at from invites i join rooms r on r.id = i.room_id where i.account_id = $1 order by i.created_at`},
		{key: "join_requests", sql: `select j.id, j.kind, j.room_id, r.name as room_name, j.member_id, j.name, j.job, j.app,
			j.app_name, j.machine, j.folder, j.turn, j.session_id, encode(j.ed25519_pk, 'hex') as ed25519_pk, j.match_code,
			j.status, j.move_to, j.readdressed_from is not null as readdressed, j.created_at, j.expires_at, j.decided_at
			from join_requests j join rooms r on r.id = j.room_id where j.for_account_id = $1 order by j.created_at`},
		{key: "person_requests", sql: `select pr.id, pr.room_id, r.name as room_name, 'asked_by_me' as direction,
			null::text as asked_by, pr.status, pr.created_at, pr.expires_at, pr.decided_at
			from person_requests pr join rooms r on r.id = pr.room_id where pr.account_id = $1
			union all
			select pr.id, pr.room_id, r.name, 'to_my_room', a.display_name, pr.status, pr.created_at, pr.expires_at, pr.decided_at
			from person_requests pr join rooms r on r.id = pr.room_id join accounts a on a.id = pr.account_id
			where r.owner_account_id = $1 and pr.account_id <> $1 order by 7`},
		{key: "limit_counters", sql: `select bucket, window_start, count from rate_counters rc
			where position($2 in rc.bucket) > 0
			   or exists (select 1 from members m where m.account_id = $1 and position(m.id::text in rc.bucket) > 0)
			   or exists (select 1 from web_sessions s where s.account_id = $1
			              and rc.bucket like 'dash:s:' || encode(substring(s.token_hash from 1 for 12), 'hex') || ':%')
			order by window_start, bucket`},
		{key: "weekly_activity", sql: `select week, room_id, messages, first_at, last_at from room_week_senders
			where account_id = $1 order by week, room_id`},
	}
	out := map[string]any{}
	all := []any{account, account, sessionHash}
	run := func(p exportPart) (json.RawMessage, error) {
		// Postgres needs a type for every parameter, so pass only the ones a statement uses, renumbered
		var used []int
		sql := paramRe.ReplaceAllStringFunc(p.sql, func(m string) string {
			i := int(m[1] - '1')
			for j, u := range used {
				if u == i {
					return fmt.Sprintf("$%d", j+1)
				}
			}
			used = append(used, i)
			return fmt.Sprintf("$%d", len(used))
		})
		args := make([]any, len(used))
		for j, i := range used {
			args[j] = all[i]
		}
		if p.one {
			return jsonOne(ctx, q, sql, args...)
		}
		return jsonList(ctx, q, sql, args...)
	}
	for _, p := range parts {
		v, err := run(p)
		if err != nil {
			return nil, err
		}
		out[p.key] = v
	}
	sections := []struct {
		group string
		items []exportPart
	}{
		{"wake", []exportPart{
			{key: "mutes", sql: `select mu.member_id, m.name as member_name, m.room_id, mu.created_at from mutes mu
				join members m on m.id = mu.member_id where mu.account_id = $1 order by mu.created_at`},
			{key: "policies", sql: `select w.member_id, w.key_epoch, w.except_members, w.since, w.updated_at from wake_policies w
				where w.member_id in ` + myMembers + ` order by w.member_id`},
			{key: "event_subscriptions", sql: `select s.id, s.member_id, s.url, s.name, s.urgent_only, s.key_epoch, s.created_at,
				s.refreshed_at, s.expires_at, s.verified_at, s.approved_by, s.approved_at, s.last_ok_at, s.last_error, s.failed_since, s.fails, s.disabled_at
				from event_subscriptions s where s.member_id in ` + myMembers + ` order by s.created_at`},
			// addresses a chat asked its person to approve (the secret is left out, as for subscriptions)
			{key: "event_url_requests", sql: `select q.id, q.member_id, q.url, q.name, q.urgent_only, q.key_epoch, q.status, q.subscription_id,
				q.created_at, q.expires_at, q.decided_at from event_url_requests q where q.member_id in ` + myMembers + ` order by q.created_at`},
			// addresses the person stopped or turned down: their chats send them nothing for a day
			{key: "event_url_refusals", sql: `select f.member_id, f.url_key, f.reason, f.created_at, f.until from event_url_refusals f
				where f.member_id in ` + myMembers + ` order by f.created_at`},
		}},
		{"plan", []exportPart{
			{key: "billing", one: true, sql: `select plan_id, paid_until, status, billing_interval, cancel_at_period_end, gateway,
				customer_id, subscription_id, last_event_at, updated_at from account_billing where account_id = $1`},
			{key: "plan_limits", sql: `select plan_id, rooms, agents_per_room, people_per_room, history_days, created_at, updated_at
				from account_plan_limits where account_id = $1 order by plan_id`},
			{key: "raises", one: true, sql: `select rooms, agents_per_room, people_per_room, history_days, updated_at
				from account_raises where account_id = $1`},
			{key: "boosts", sql: `select limit_key, value, starts_at, ends_at, reason, created_at from limit_boosts
				where account_id = $1 order by created_at`},
			{key: "credits_balance", one: true, sql: `select coalesce(sum(amount), 0) as balance from credit_ledger where account_id = $1`},
			{key: "credits", sql: `select at, kind, amount, reason, ref from credit_ledger where account_id = $1 order by id`},
			{key: "checkouts", sql: `select id, gateway, product, created_at, paid_at from billing_checkouts where account_id = $1 order by created_at`},
			{key: "payment_events", sql: `select gateway, event_id, type, event_at, applied, note, received_at from billing_events
				where account_id = $1 order by received_at`},
			{key: "usage_daily", sql: `select day, messages_sent, chats_active, wakes, credits_used, final from usage_daily
				where account_id = $1 order by day`},
		}},
		{"passkey_resets", []exportPart{
			// the hashes of the asking sign-in and browser cookie are secrets' hashes: left out
			{key: "resets", sql: `select id, user_agent as asked_from_browser, created_at, ready_at, cancelled_at, cancelled_by,
				completed_at from passkey_resets where account_id = $1 order by created_at`},
			{key: "delete_requests", sql: `select id, user_agent as asked_from_browser, created_at, ready_at, lapses_at, cancelled_at,
				cancelled_by from account_deletes where account_id = $1 order by created_at`},
			{key: "account_events", sql: `select kind, data, at from account_events where account_id = $1 order by id`},
		}},
		{"storage", []exportPart{
			{key: "stored_bytes", one: true, sql: `select coalesce((select bytes from account_storage where account_id = $1), 0)
				+ coalesce((select sum(delta) from account_storage_log where account_id = $1), 0) as bytes,
				(select count(*) from deliveries where charge_account = $1) as copies_charged`},
		}},
		{"events", []exportPart{
			{key: "needs_you_items", sql: `select id, room_id, kind, subject_id, data, created_at, resolved_at from attention
				where account_id = $1 order by created_at`},
			{key: "human_checks", sql: `select action, target_id, created_at, expires_at, verified_at, used_at,
				` + b64url("credential_id") + ` as answered_with_passkey from human_checks
				where account_id = $1 order by created_at`},
			{key: "limit_events", sql: `select at, day, limit_key, room_id, used, value, refused, attempts from limit_events
				where account_id = $1 order by at`},
			{key: "limit_reached_days", sql: `select limit_key, day from limit_reached_days where account_id = $1 order by day`},
			{key: "limit_changes", sql: `select at, actor_kind, target, plan_id, limit_key, from_value, to_value, reason
				from limit_changes where account_id = $1 order by at`},
			{key: "chat_notices", sql: `select n.member_id, n.kind, n.data, n.created_at, n.acked_at from notices n
				where n.member_id in ` + myMembers + ` order by n.id`},
		}},
		{"messages", []exportPart{
			{key: "per_chat", sql: `select m.id as chat_id, m.name, m.room_id,
				(select count(*) from messages x where x.from_member = m.id) as messages_sent_kept,
				(select count(*) from deliveries d where d.member_id = m.id) as copies_to_this_chat,
				(select count(*) from deliveries d where d.member_id = m.id and d.envelope is not null) as sealed_copies_stored,
				(select coalesce(sum(octet_length(d.envelope)), 0) from deliveries d where d.member_id = m.id and d.envelope is not null) as sealed_bytes_stored
				from members m where m.account_id = $1 order by m.joined_at`},
			{key: "sent", sql: `select x.id, x.room_id, x.from_member, x.scope, x.to_member, x.in_reply_to, x.recipients, x.quiet,
				x.intro, x.created_at, x.expires_at from messages x where x.from_member in ` + myMembers + `
				order by x.created_at desc limit ` + itoa(ExportCap)},
			{key: "received", sql: `select d.message_id, d.member_id, x.from_member, x.scope, x.created_at, d.state, d.key_epoch,
				d.attempts, d.wakes, d.no_wake, d.wake_held, d.shown_at, d.done_at, d.expires_at,
				d.envelope is not null as sealed_copy_stored, coalesce(octet_length(d.envelope), 0) as sealed_bytes
				from deliveries d join messages x on x.id = d.message_id where d.member_id in ` + myMembers + `
				order by x.created_at desc limit ` + itoa(ExportCap)},
			{key: "totals", one: true, sql: `select
				(select count(*) from messages x where x.from_member in ` + myMembers + `) as sent,
				(select count(*) from deliveries d where d.member_id in ` + myMembers + `) as received`},
		}},
	}
	for _, s := range sections {
		g := map[string]any{}
		for _, p := range s.items {
			paid := s.group == "plan" || paidExportPart[s.group+"."+p.key]
			if paid && !paywall && p.key == "credits_balance" { // derived from credits, which is given if it has rows
				continue
			}
			v, err := run(p)
			if err != nil {
				return nil, err
			}
			if paid && !paywall && (string(v) == "null" || string(v) == "[]") {
				continue
			}
			g[p.key] = v
		}
		if len(g) > 0 || paywall || s.group != "plan" {
			out[s.group] = g
		}
	}
	return out, nil
}

// paidExportPart: export parts outside the plan group that only the paywall writes (plan-limit notes).
var paidExportPart = map[string]bool{"events.limit_events": true, "events.limit_reached_days": true}

func itoa(n int) string { return fmt.Sprint(n) }

var paramRe = regexp.MustCompile(`\$[1-3]\b`)

// ── delete

// DeleteRoom (soft) applies SPEC §6.10's room-delete effects: deleted_at, members removed, invites off, pending
// requests closed, open items resolved. Same as DELETE /app/v1/rooms/{id} (appapi/rooms.go), which predates it.
func DeleteRoom(ctx context.Context, tx pgx.Tx, roomID, by string) error {
	tag, err := tx.Exec(ctx, `update rooms set deleted_at = now() where id = $1 and deleted_at is null`, roomID)
	if err != nil || tag.RowsAffected() == 0 {
		return err
	}
	rows, err := tx.Query(ctx, `select id from members where room_id = $1 and removed_at is null for update`, roomID)
	if err != nil {
		return err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	for _, m := range ids {
		if err := RemoveMember(ctx, tx, m); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `update invites set off = true where room_id = $1`, roomID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `update join_requests set status = 'cancelled', decided_at = now() where room_id = $1 and status = 'pending'`, roomID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `update person_requests set status = 'rejected', decided_at = now(), decided_by = $2
		where room_id = $1 and status = 'pending'`, roomID, by); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `update attention set resolved_at = now() where room_id = $1 and resolved_at is null`, roomID)
	return err
}

// PlanRoom is one room in a delete plan.
type PlanRoom struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	OwnerName   string `json:"owner_name,omitempty"`
	OtherPeople int    `json:"other_people"`
	CanSign     *bool  `json:"can_sign,omitempty"`
}

// DeletePlan is what deleting the account would do, as one browser (devicePK, may be nil) sees it.
type DeletePlan struct {
	OwnedRooms  []PlanRoom `json:"owned_rooms"`
	JoinedRooms []PlanRoom `json:"joined_rooms"`
	Chats       int        `json:"chats"`
	PlanRenews  bool       `json:"plan_renews"`
	Passkeys    int        `json:"passkeys"`
}

// PlanRenewsSQL: a paid plan that will charge again (the person cancels it in the payment company's portal first;
// bot-link has no way to stop a subscription itself).
const planRenewsSQL = `exists(select 1 from account_billing where account_id = $1 and status in ('active','on_hold','past_due')
	and not cancel_at_period_end and subscription_id is not null)`

func GetDeletePlan(ctx context.Context, q Q, account string, devicePK []byte) (*DeletePlan, error) {
	p := &DeletePlan{OwnedRooms: []PlanRoom{}, JoinedRooms: []PlanRoom{}}
	rows, err := q.Query(ctx, `select r.id, r.name,
			(select count(*) from room_people o where o.room_id = r.id and o.account_id <> $1 and o.removed_at is null)
		from rooms r where r.owner_account_id = $1 and r.deleted_at is null order by r.created_at`, account)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var r PlanRoom
		if err := rows.Scan(&r.ID, &r.Name, &r.OtherPeople); err != nil {
			rows.Close()
			return nil, err
		}
		p.OwnedRooms = append(p.OwnedRooms, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows, err = q.Query(ctx, `select r.id, r.name, o.display_name,
			(select count(*) from room_people x where x.room_id = r.id and x.account_id <> $1 and x.removed_at is null),
			exists(select 1 from room_signers s where s.room_id = r.id and s.ed25519_pk = $2 and s.removed_seq is null)
		from room_people p join rooms r on r.id = p.room_id join accounts o on o.id = r.owner_account_id
		where p.account_id = $1 and p.role = 'person' and p.removed_at is null and r.deleted_at is null order by r.id`, account, devicePK)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var r PlanRoom
		var can bool
		if err := rows.Scan(&r.ID, &r.Name, &r.OwnerName, &r.OtherPeople, &can); err != nil {
			rows.Close()
			return nil, err
		}
		r.CanSign = &can
		p.JoinedRooms = append(p.JoinedRooms, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	err = q.QueryRow(ctx, `select (select count(*) from members where account_id = $1 and removed_at is null), `+planRenewsSQL+`,
		(select count(*) from webauthn_credentials where account_id = $1)`, account).Scan(&p.Chats, &p.PlanRenews, &p.Passkeys)
	return p, err
}

// PlanRenews reports whether the account has a paid plan that will charge again.
func PlanRenews(ctx context.Context, q Q, account string) (bool, error) {
	var b bool
	err := q.QueryRow(ctx, `select `+planRenewsSQL, account).Scan(&b)
	return b, err
}

// DeleteResult is what a delete did.
type DeleteResult struct {
	RoomsLeft    int `json:"rooms_left"`
	RoomsDeleted int `json:"rooms_deleted"`
	ChatsRemoved int `json:"chats_removed"`
}

// DeleteAccount deletes account inside tx. leaves maps every room the account is a person in (not the owner) to the
// person_remove entry its own browser signed. Any problem rolls everything back:
//   - a room missing from leaves (the person was added somewhere since the plan), or a head that moved: 409
//     roster_conflict (details.room_ids); the browser re-reads the plan, re-signs and retries with the same check;
//   - an entry signed by a browser that is not this account's, or not approved in that room: 403 not_signer.
func DeleteAccount(ctx context.Context, tx pgx.Tx, account string, leaves map[string]roster.Wire) (*DeleteResult, error) {
	res := &DeleteResult{}
	var ok bool
	if err := tx.QueryRow(ctx, `select true from accounts where id = $1 and deleted_at is null for update`, account).Scan(&ok); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, httpx.NotFound()
		}
		return nil, err
	}
	// an owner approving one of my pending person requests right now waits for this transaction, then finds it closed
	// (otherwise I could become a person in a room this delete never saw)
	if _, err := tx.Exec(ctx, `select id from person_requests where account_id = $1 and status = 'pending' for update`, account); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `select count(*) from members where account_id = $1 and removed_at is null`, account).Scan(&res.ChatsRemoved); err != nil {
		return nil, err
	}
	// 1. leave every room I am a person in, with the entries my browser signed
	rows, err := tx.Query(ctx, `select p.room_id from room_people p join rooms r on r.id = p.room_id
		where p.account_id = $1 and p.role = 'person' and p.removed_at is null and r.deleted_at is null order by p.room_id`, account)
	if err != nil {
		return nil, err
	}
	joined, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	want := map[string]bool{}
	var missing []string
	for _, id := range joined {
		want[id] = true
		if _, ok := leaves[id]; !ok {
			missing = append(missing, id)
		}
	}
	for id := range leaves {
		if !want[id] {
			return nil, httpx.BadRequest("entries name a room you are not a person in (or that you own).").With("room_id", id)
		}
	}
	if len(missing) > 0 {
		return nil, httpx.E(409, "roster_conflict", "You were added to a room since this page loaded. Refresh and try again.").With("room_ids", missing)
	}
	sort.Strings(joined)
	for _, roomID := range joined {
		w := leaves[roomID]
		signer, err := hex.DecodeString(w.Signer)
		if err != nil || len(signer) != 32 {
			return nil, httpx.BadRequest("signer must be 64 lowercase hex chars.").With("room_id", roomID)
		}
		var mine bool
		if err := tx.QueryRow(ctx, `select exists(select 1 from devices where ed25519_pk = $1 and account_id = $2 and revoked_at is null)`,
			signer, account).Scan(&mine); err != nil {
			return nil, err
		}
		if !mine {
			return nil, httpx.E(403, "not_signer", "Sign your leave with one of your own approved browsers.").With("room_id", roomID)
		}
		e, _, err := AppendEntry(ctx, tx, roomID, w)
		if err != nil {
			var he *httpx.Error
			if errors.As(err, &he) {
				return nil, he.With("room_id", roomID).With("room_ids", []string{roomID})
			}
			return nil, err
		}
		if e.Op != "person_remove" || e.Account != account {
			return nil, httpx.E(400, "roster_invalid", "Each entry must be your own leave (person_remove of your account).").
				With("rule", "request_match").With("room_id", roomID)
		}
		if err := ApplyDerived(ctx, tx, roomID, e); err != nil {
			return nil, err
		}
		res.RoomsLeft++
	}
	// the person's Stops and noes (no reference to members, so deleting a room below would not take them along)
	if _, err := tx.Exec(ctx, `delete from event_url_refusals where member_id in (select id from members where account_id = $1)`, account); err != nil {
		return nil, err
	}
	// 2. rooms I own: deleted. Kept as a deleted room (so the other people's chats are told "room gone") when anyone
	//    else is in it; removed with everything in it when no one else is.
	rows, err = tx.Query(ctx, `select r.id, r.deleted_at is null,
			exists(select 1 from room_people o where o.room_id = r.id and o.account_id <> $1 and o.removed_at is null)
		from rooms r where r.owner_account_id = $1 order by r.id for update`, account)
	if err != nil {
		return nil, err
	}
	type owned struct {
		id          string
		live, other bool
	}
	var mineRooms []owned
	for rows.Next() {
		var o owned
		if err := rows.Scan(&o.id, &o.live, &o.other); err != nil {
			rows.Close()
			return nil, err
		}
		mineRooms = append(mineRooms, o)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, o := range mineRooms {
		if o.live {
			if err := DeleteRoom(ctx, tx, o.id, account); err != nil {
				return nil, err
			}
			res.RoomsDeleted++
		}
		if !o.other {
			if _, err := tx.Exec(ctx, `delete from rooms where id = $1`, o.id); err != nil {
				return nil, err
			}
		}
	}
	var left int
	if err := tx.QueryRow(ctx, `select count(*) from members where account_id = $1 and removed_at is null`, account).Scan(&left); err != nil {
		return nil, err
	}
	if left > 0 { // can't happen: a member needs its person in the room, and every such room was left or deleted
		return nil, httpx.Internal(errors.New("account delete: chats still active"))
	}
	// 3. my requests: nothing waits on me any more (a waiting chat's join wait ends; its name is free)
	for _, sql := range []string{
		`update join_requests set status = 'cancelled', decided_at = now() where for_account_id = $1 and status = 'pending'`,
		`update person_requests set status = 'expired', decided_at = now() where account_id = $1 and status = 'pending'`,
		// 4. my chats' rows stay (the signed member lists and message records reference them), emptied of what they said
		//    about my computer; their sealed copies, wake addresses, policies and notes go
		`update deliveries set envelope = null where member_id in (select id from members where account_id = $1)
		   and envelope is not null and state not in ('queued','stuck')`,
		`delete from event_subscriptions where member_id in (select id from members where account_id = $1)`,
		`delete from event_url_requests where member_id in (select id from members where account_id = $1)`,
		`delete from wake_policies where member_id in (select id from members where account_id = $1)`,
		`delete from notices where member_id in (select id from members where account_id = $1)`,
		`update push_jobs set done = true where member_id in (select id from members where account_id = $1) and not done`,
		`delete from mutes where account_id = $1 or member_id in (select id from members where account_id = $1)`,
		`update members set job = '', folder = '', machine = '', app_name = null, self_label = null, holder_session = null,
		   handover_env = null, push_url = null, push_secret = null, push_verified_at = null, presence_live = false,
		   turn = case when turn = 'always_on' then 'on_turn' else turn end
		 where account_id = $1`,
		`update join_requests set job = '', machine = '', folder = '', session_id = null, app_name = null where for_account_id = $1`,
		// 5. the account's own rows
		`delete from attention where account_id = $1`,
		`delete from identities where account_id = $1`,
		`delete from web_sessions where account_id = $1`,
		`delete from human_checks where account_id = $1`,
		`delete from room_drafts where claimed_by = $1`, // drafts it held: their chats' waits answer draft_gone
		`delete from devices where account_id = $1`,
		`delete from webauthn_credentials where account_id = $1`,
		// passkey resets (an open one is closed here: it can never finish against the placeholder) and the account's
		// event log (browser names)
		`delete from passkey_resets where account_id = $1`,
		`delete from account_events where account_id = $1`,
		`delete from account_deletes where account_id = $1`,
		`delete from account_plan_limits where account_id = $1`,
		`delete from account_raises where account_id = $1`,
		`delete from limit_boosts where account_id = $1`,
		`delete from limit_events where account_id = $1`,
		`delete from limit_reached_days where account_id = $1`,
		`delete from usage_daily where account_id = $1`,
		// credits given or used are not payments; top-ups and refunds are, and stay with the payment records
		`delete from credit_ledger where account_id = $1 and kind in ('grant','usage')`,
		`delete from rate_counters where position($1::uuid::text in bucket) > 0`,
		// 6. the tombstone: the id stays (member lists, room history and payment records point at it), nothing else
		`update accounts set email = 'deleted-' || id::text || '@deleted.invalid', display_name = 'Deleted account',
		   avatar_url = null, wakes_paused_at = null, had_passkey_at = null, sends_refused_at = null, deleted_at = now()
		 where id = $1`,
		// open dashboards of this account reload and find themselves signed out
		`select pg_notify('bl_dash', $1::uuid::text)`,
	} {
		if _, err := tx.Exec(ctx, sql, account); err != nil {
			return nil, err
		}
	}
	return res, nil
}

// ── what delete and export do with every place that names an account
//
// AccountDeleteFate and AccountExportFate list every column of accounts and every column elsewhere that names an
// account (an account_id, a reference to accounts, or "account" in its name). server/test/account_schema_test.go
// reads the live schema and fails when one is missing from either list, so a lane that adds a table or column with an
// account in it has to decide here what delete and export do with it. A delete entry starts with "removed",
// "anonymised" or "kept"; an export entry with "exported" or "not exported"; both say why when it is not obvious.
var AccountDeleteFate = map[string]string{
	"accounts.id":               "kept: the placeholder's id; member lists, room history and payment rows point at it",
	"accounts.email":            "anonymised: deleted-<id>@deleted.invalid (frees the address for a new account)",
	"accounts.display_name":     "anonymised: 'Deleted account'",
	"accounts.avatar_url":       "anonymised: null",
	"accounts.created_at":       "kept: a date, no person in it",
	"accounts.deleted_at":       "kept: set now; marks the placeholder",
	"accounts.wakes_paused_at":  "anonymised: null",
	"accounts.had_passkey_at":   "anonymised: null",
	"accounts.sends_refused_at": "anonymised: null (nothing can send as the placeholder: every chat is removed)",

	"identities.account_id":           "removed",
	"web_sessions.account_id":         "removed (every sign-in ends; device_id with it)",
	"devices.account_id":              "removed",
	"webauthn_credentials.account_id": "removed (with where each passkey was made and last used)",
	"human_checks.account_id":         "removed",
	"room_drafts.claimed_by":          "removed (drafts it held; their chats' waits answer draft_gone)",
	"passkey_resets.account_id":       "removed (an open reset is closed: it can never finish)",
	"account_events.account_id":       "removed",
	"account_deletes.account_id":      "removed (the asks to delete, with the asking browser's name)",
	"attention.account_id":            "removed",
	"mutes.account_id":                "removed",
	"account_plan_limits.account_id":  "removed",
	"account_raises.account_id":       "removed",
	"limit_boosts.account_id":         "removed",
	"limit_events.account_id":         "removed",
	"limit_reached_days.account_id":   "removed",
	"usage_daily.account_id":          "removed",
	"credit_ledger.account_id":        "removed for grants and usage; kept for top-ups and refunds (payment records)",

	"account_billing.account_id":     "kept: payment record (plan, gateway ids); law and accounting",
	"billing_checkouts.account_id":   "kept: payment record",
	"billing_events.account_id":      "kept: payment record",
	"limit_changes.account_id":       "kept: the admin change log of this account's limits (who changed what, why)",
	"limit_changes.actor_account_id": "kept: an admin's own action on some account; points at the placeholder only",
	"credit_ledger.actor_account_id": "kept: an admin's grant to some account; points at the placeholder only",
	"limit_boosts.created_by":        "kept: an admin's boost of some account; points at the placeholder only",
	"account_storage.account_id":     "kept: lane LIMITS rule, never delete counter rows (exact as copies expire; reaches 0); bytes only",
	"account_storage_log.account_id": "kept: lane LIMITS rule, as account_storage; signed byte deltas only",
	"deliveries.charge_account":      "kept: which account a stored copy is charged to; the copies themselves are other people's or dropped",
	"room_week_senders.account_id":   "kept: weekly counts per room (metrics); uuid and numbers only",

	"rooms.owner_account_id":         "kept: owned rooms are deleted (hard when no one else is in it, else soft); the soft ones point at the placeholder",
	"room_people.account_id":         "kept: removed_at set through the signed leave; mirrors the signed member list",
	"room_signers.account_id":        "kept: removed_seq set; mirrors the signed member list",
	"members.account_id":             "anonymised: removed, job, folder, machine, app name, label, push and handover blanked; name and keys stay (signed)",
	"invites.account_id":             "kept: turned off; rooms the person owned are deleted",
	"invites.used_by_account_id":     "kept: which account used a person invite in someone's room; points at the placeholder",
	"join_requests.for_account_id":   "anonymised: pending ones cancelled; job, machine, folder, session, app name blanked",
	"join_requests.decided_by":       "kept: who decided; points at the placeholder",
	"join_requests.readdressed_from": "kept: a request that left this person; points at the placeholder",
	"person_requests.account_id":     "kept: pending ones expired; status history of someone's room",
	"person_requests.decided_by":     "kept: who decided; points at the placeholder",
}

var AccountExportFate = map[string]string{
	"accounts.id":               "exported: account",
	"accounts.email":            "exported: account",
	"accounts.display_name":     "exported: account",
	"accounts.avatar_url":       "exported: account",
	"accounts.created_at":       "exported: account",
	"accounts.deleted_at":       "not exported: always null for an account that can sign in",
	"accounts.wakes_paused_at":  "exported: account",
	"accounts.had_passkey_at":   "exported: account",
	"accounts.sends_refused_at": "exported: account (sends_refused)",

	"identities.account_id":           "exported: sign_ins",
	"web_sessions.account_id":         "exported: sessions (no token, no CSRF token)",
	"devices.account_id":              "exported: browsers",
	"webauthn_credentials.account_id": "exported: passkeys (public part, where made and last used)",
	"human_checks.account_id":         "exported: events.human_checks (no challenge)",
	"room_drafts.claimed_by":          "not exported: a draft lives 15 minutes, is no room and holds the asking chat's data",
	"passkey_resets.account_id":       "exported: passkey_resets.resets (no session or cookie hash)",
	"account_events.account_id":       "exported: passkey_resets.account_events",
	"account_deletes.account_id":      "exported: passkey_resets.delete_requests (no session hash)",
	"attention.account_id":            "exported: events.needs_you_items",
	"mutes.account_id":                "exported: wake.mutes",
	"account_plan_limits.account_id":  "exported: plan.plan_limits",
	"account_raises.account_id":       "exported: plan.raises",
	"limit_boosts.account_id":         "exported: plan.boosts",
	"limit_events.account_id":         "exported: events.limit_events",
	"limit_reached_days.account_id":   "exported: events.limit_reached_days",
	"usage_daily.account_id":          "exported: plan.usage_daily",
	"credit_ledger.account_id":        "exported: plan.credits",
	"account_billing.account_id":      "exported: plan.billing",
	"billing_checkouts.account_id":    "exported: plan.checkouts",
	"billing_events.account_id":       "exported: plan.payment_events",
	"limit_changes.account_id":        "exported: events.limit_changes",
	"limit_changes.actor_account_id":  "not exported: an admin's id, not about this account",
	"credit_ledger.actor_account_id":  "not exported: an admin's id",
	"limit_boosts.created_by":         "not exported: an admin's id",
	"account_storage.account_id":      "exported: storage.stored_bytes",
	"account_storage_log.account_id":  "exported: storage.stored_bytes (folded into one number)",
	"deliveries.charge_account":       "exported: storage.stored_bytes (copies_charged)",
	"room_week_senders.account_id":    "exported: weekly_activity",
	"rooms.owner_account_id":          "exported: rooms",
	"room_people.account_id":          "exported: rooms",
	"room_signers.account_id":         "exported: member_list_entries (the signed device entries)",
	"members.account_id":              "exported: chats",
	"invites.account_id":              "exported: invites",
	"invites.used_by_account_id":      "exported: person_requests (asked_by_me)",
	"join_requests.for_account_id":    "exported: join_requests",
	"join_requests.decided_by":        "not exported: always this account or the request's own person (in join_requests)",
	"join_requests.readdressed_from":  "not exported: a request that went from this person to another; it is theirs now",
	"person_requests.account_id":      "exported: person_requests",
	"person_requests.decided_by":      "not exported: the room owner's id",
}

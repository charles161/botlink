package appapi

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/auth"
	"github.com/charles161/botlink/server/internal/events"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/humancheck"
	"github.com/charles161/botlink/server/internal/push"
	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/wire"
)

// Event addresses a person approves, the person's side (docs/protocol/event-url-approval.md §2-§4). A chat asked for an
// address it could not prove (agentapi/eventurl.go); its person (the account its member belongs to) sees the request
// under "What needs you", approves it with a passkey, says no, or later stops the subscription the approval made.
// Nobody else sees the request; a chat has no route here (cookie session only).

func (a *API) eventURLRoutes(mux *http.ServeMux) {
	mux.Handle("POST /app/v1/event-urls/{id}/approve", a.sess(a.postEventURLApprove))
	mux.Handle("POST /app/v1/event-urls/{id}/reject", a.sess(a.postEventURLReject))
	mux.Handle("GET /app/v1/members/{id}/event-urls", a.sess(a.getMemberEventURLs))
	mux.Handle("POST /app/v1/members/{id}/event-urls/{sub}/stop", a.sess(a.postEventURLStop))
}

var eventSubIDRe = regexp.MustCompile(`^sub_[0-9a-f]{24}$`)

func notifyDash(ctx context.Context, q store.Q, account string) error {
	_, err := q.Exec(ctx, `select pg_notify('bl_dash', $1::text)`, account)
	return err
}

// refuseSpent commits the spending of a passed check that approved nothing (humancheck.Spend) and returns refusal.
func (a *API) refuseSpent(ctx context.Context, checkID string, s *auth.Session, refusal error) error {
	if err := a.St.Tx(ctx, func(tx pgx.Tx) error { return humancheck.Spend(ctx, tx, checkID, s) }); err != nil {
		return err
	}
	return refusal
}

// POST /app/v1/event-urls/{id}/approve {human_check}. The check is verified first (outside any lock), then the push
// guard runs on the address again (a name lookup, outside any lock: the address may point elsewhere by now). Then one
// transaction, in the lock order of store.LockRoom: the member's room, the member, the request. The request must still
// wait, be unexpired, belong to a member of the caller that has not moved or been removed; else 404 and the check is
// spent. The check is used up, the subscription is made as a verified subscribe makes it (same id, at most 6 per member,
// the catch-up event), marked approved_by person, and the request is marked approved.
func (a *API) postEventURLApprove(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
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
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	if err := a.verifyHuman(r, s, &b.HumanCheck, humancheck.ApproveEventURLAction, id); err != nil {
		return err
	}
	// which room and which address (read without a lock; the transaction reads it all again under the locks)
	var url, roomID, memberID string
	err = a.St.Pool.QueryRow(ctx, `select q.url, m.room_id, m.id from event_url_requests q join members m on m.id = q.member_id
		where q.id = $1 and m.account_id = $2 and q.status = 'waiting'`, id, s.AccountID).Scan(&url, &roomID, &memberID)
	if errors.Is(err, pgx.ErrNoRows) {
		return a.refuseSpent(ctx, b.HumanCheck.ID, s, httpx.NotFound())
	}
	if err != nil {
		return err
	}
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	_, err = a.Pusher.CheckURL(cctx, url)
	cancel()
	if err != nil {
		if errors.Is(err, push.ErrBlocked) {
			return a.refuseSpent(ctx, b.HumanCheck.ID, s, httpx.E(422, "event_url_blocked", "That address isn't allowed (https only, public addresses only). Nothing was approved."))
		}
		return a.refuseSpent(ctx, b.HumanCheck.ID, s, httpx.E(422, "event_verify_failed", "bot-link could not look up that address. Nothing was approved.").With("reason", "connection"))
	}
	var sub *events.Sub
	var refused error
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		// the room first, then the member, then the request (store.LockRoom: one lock order)
		if err := store.LockRoom(ctx, tx, roomID); err != nil {
			return err
		}
		var epoch int
		err := tx.QueryRow(ctx, `select m.key_epoch from members m join rooms rm on rm.id = m.room_id
			where m.id = $1 and m.account_id = $2 and m.removed_at is null and rm.deleted_at is null for update of m`, memberID, s.AccountID).Scan(&epoch)
		if errors.Is(err, pgx.ErrNoRows) {
			refused = httpx.NotFound()
			return humancheck.Spend(ctx, tx, b.HumanCheck.ID, s)
		}
		if err != nil {
			return err
		}
		var qMember, qURL, qName, status string
		var qEpoch, ttl int
		var urgent, live bool
		var secret []byte
		err = tx.QueryRow(ctx, `select member_id::text, key_epoch, url, name, urgent_only, secret, ttl_s, status, expires_at > now()
			from event_url_requests where id = $1 for update`, id).Scan(&qMember, &qEpoch, &qURL, &qName, &urgent, &secret, &ttl, &status, &live)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if errors.Is(err, pgx.ErrNoRows) || status != "waiting" || !live || qMember != memberID || qEpoch != epoch || qURL != url {
			// gone, decided, expired, or made by a chat that no longer holds the member: approves nothing, and the
			// passed check is spent (committed) so it never waits for the request to become approvable
			refused = httpx.NotFound()
			return humancheck.Spend(ctx, tx, b.HumanCheck.ID, s)
		}
		if err := consumeApproval(ctx, tx, b.HumanCheck.ID, s); err != nil {
			return err
		}
		subID := events.SubscriptionID(memberID, url, qName, urgent)
		// subscriptions an earlier chat of this member left behind never come back to life
		if _, err := tx.Exec(ctx, `delete from event_subscriptions where member_id = $1 and key_epoch <> $2`, memberID, epoch); err != nil {
			return err
		}
		var n int
		if err := tx.QueryRow(ctx, `select count(*) from event_subscriptions where member_id = $1 and expires_at > now() and id <> $2`,
			memberID, subID).Scan(&n); err != nil {
			return err
		}
		if n >= events.MaxSubscriptions {
			return httpx.E(409, "too_many_subscriptions", "This chat already has 6 addresses bot-link calls. It has to remove one first.")
		}
		// as a verified subscribe makes it; the person's approval stands in for the check, so it resets the failure
		// state the way a passed check does
		sub, err = events.ScanSub(tx.QueryRow(ctx, `insert into event_subscriptions as s (id, member_id, key_epoch, url, name, urgent_only, secret,
				expires_at, verified_at, approved_by, approved_at)
			values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8), now(), 'person', now())
			on conflict (id) do update set
				prev_secret = case when s.secret <> excluded.secret then s.secret else s.prev_secret end,
				prev_until  = case when s.secret <> excluded.secret then now() + interval '10 minutes' else s.prev_until end,
				secret = excluded.secret, key_epoch = excluded.key_epoch, expires_at = excluded.expires_at, refreshed_at = now(),
				verified_at = coalesce(s.verified_at, now()), approved_by = 'person', approved_at = now(),
				disabled_at = null, fails = 0, failed_since = null, last_error = null
			returning `+events.SubCols, subID, memberID, epoch, url, qName, urgent, secret, ttl))
		if err != nil {
			return err
		}
		if err := events.QueueCatchUp(ctx, tx, subID, memberID, urgent); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `update event_url_requests set status = 'approved', decided_at = now(), subscription_id = $2 where id = $1`, id, subID); err != nil {
			return err
		}
		// the person said yes to this address: an earlier Stop or no of theirs no longer holds it back
		if _, err := tx.Exec(ctx, `delete from event_url_refusals where member_id = $1 and url_key = $2`, memberID, events.URLKey(url)); err != nil {
			return err
		}
		return notifyDash(ctx, tx, s.AccountID)
	})
	if err != nil {
		return err
	}
	if refused != nil {
		return refused
	}
	httpx.WriteJSON(w, 200, map[string]any{"subscription": sub.View(time.Now()), "request": map[string]any{"id": id, "status": "approved"}})
	return nil
}

// POST /app/v1/event-urls/{id}/reject: the member's person says no. 204; anything else (not theirs, decided, expired)
// is the same 404.
func (a *API) postEventURLReject(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if !wire.IsUUID(id) {
		return httpx.NotFound()
	}
	if err := emptyBody(r); err != nil {
		return err
	}
	err := a.St.Tx(ctx, func(tx pgx.Tx) error {
		var member, url string
		err := tx.QueryRow(ctx, `update event_url_requests q set status = 'rejected', decided_at = now() from members m
			where q.id = $1 and m.id = q.member_id and m.account_id = $2 and q.status = 'waiting' and q.expires_at > now()
			returning q.member_id::text, q.url`, id, s.AccountID).Scan(&member, &url)
		if errors.Is(err, pgx.ErrNoRows) {
			return httpx.NotFound()
		}
		if err != nil {
			return err
		}
		if err := refuseAddress(ctx, tx, member, url, "rejected"); err != nil {
			return err
		}
		return notifyDash(ctx, tx, s.AccountID)
	})
	if err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// POST /app/v1/members/{id}/event-urls/{sub}/stop: the member's person removes an address they approved. Events
// stop at once (the worker drops what is still queued for it). 204, also when it is already gone; 404 when the member
// is not the caller's or the subscription is one the address proved itself (the chat manages those).
func (a *API) postEventURLStop(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	member, sub := r.PathValue("id"), r.PathValue("sub")
	if !wire.IsUUID(member) || !eventSubIDRe.MatchString(sub) {
		return httpx.NotFound()
	}
	if err := emptyBody(r); err != nil {
		return err
	}
	err := a.St.Tx(ctx, func(tx pgx.Tx) error {
		var acct string
		err := tx.QueryRow(ctx, `select account_id::text from members where id = $1`, member).Scan(&acct)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && acct != s.AccountID) {
			return httpx.NotFound()
		}
		if err != nil {
			return err
		}
		var proven bool
		if err := tx.QueryRow(ctx, `select exists (select 1 from event_subscriptions where id = $1 and member_id = $2 and approved_by is null)`,
			sub, member).Scan(&proven); err != nil {
			return err
		}
		if proven {
			return httpx.NotFound()
		}
		var url string
		err = tx.QueryRow(ctx, `delete from event_subscriptions where id = $1 and member_id = $2 and approved_by is not null returning url`, sub, member).Scan(&url)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if err := refuseAddress(ctx, tx, member, url, "stopped"); err != nil {
			return err
		}
		return notifyDash(ctx, tx, s.AccountID)
	})
	if err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// refuseAddress records the person's Stop or no: for events.RefusalTime a plain subscribe of this member to this
// address sends it nothing, not even the check (agentapi refusedByPerson).
func refuseAddress(ctx context.Context, tx pgx.Tx, member, url, reason string) error {
	_, err := tx.Exec(ctx, `insert into event_url_refusals (member_id, url_key, reason, until) values ($1, $2, $3, now() + make_interval(secs => $4))
		on conflict (member_id, url_key) do update set reason = excluded.reason, created_at = now(), until = excluded.until`,
		member, events.URLKey(url), reason, int(events.RefusalTime.Seconds()))
	return err
}

// eventURLCards: the requests waiting for this person (needs-you event_urls): from their own members that still hold
// the keys that asked, in rooms that exist, unexpired. Never the secret.
func eventURLCards(ctx context.Context, q store.Q, account string) ([]map[string]any, error) {
	rows, err := q.Query(ctx, `select q.id::text, m.id::text, m.name, rm.id::text, rm.name, q.url, q.name, q.urgent_only, q.created_at, q.expires_at
		from event_url_requests q join members m on m.id = q.member_id join rooms rm on rm.id = m.room_id
		where m.account_id = $1 and q.status = 'waiting' and q.expires_at > now() and q.key_epoch = m.key_epoch
		  and m.removed_at is null and rm.deleted_at is null
		order by q.created_at, q.id`, account)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, mid, mname, rid, rname, url, name string
		var urgent bool
		var created, exp time.Time
		if err := rows.Scan(&id, &mid, &mname, &rid, &rname, &url, &name, &urgent, &created, &exp); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"id": id, "member": map[string]any{"id": mid, "name": mname}, "room": map[string]any{"id": rid, "name": rname},
			"url": url, "host": events.Host(url), "name": name, "urgent_only": urgent, "created_at": created.UTC(), "expires_at": exp.UTC()})
	}
	return out, rows.Err()
}

// GET /app/v1/members/{id}/event-urls: the addresses the member's person approved for it (the chat's current keys),
// where the dashboard shows how the member listens, with Stop. Only the member's own person; anyone else: 404.
func (a *API) getMemberEventURLs(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	member := r.PathValue("id")
	if !wire.IsUUID(member) {
		return httpx.NotFound()
	}
	var mine bool
	if err := a.St.Pool.QueryRow(ctx, `select exists (select 1 from members where id = $1 and account_id = $2)`, member, s.AccountID).Scan(&mine); err != nil {
		return err
	}
	if !mine {
		return httpx.NotFound()
	}
	rows, err := a.St.Pool.Query(ctx, `select s.id, s.url, s.name, s.urgent_only, s.approved_at,
			s.failed_since is not null or s.disabled_at is not null or s.expires_at <= now()
		from event_subscriptions s join members m on m.id = s.member_id
		where m.id = $1 and s.key_epoch = m.key_epoch and s.approved_by is not null order by s.approved_at, s.id`, member)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, url, name string
		var urgent, failing bool
		var at time.Time
		if err := rows.Scan(&id, &url, &name, &urgent, &at, &failing); err != nil {
			return err
		}
		out = append(out, map[string]any{"subscription_id": id, "url": url, "host": events.Host(url), "name": name, "urgent_only": urgent,
			"approved_at": at.UTC(), "failing": failing})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"event_urls": out})
	return nil
}

package agentapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/events"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/push"
	"github.com/charles161/botlink/server/internal/ratelimit"
	"github.com/charles161/botlink/server/internal/wire"
)

// An event address the member's person approves (docs/protocol/event-url-approval.md, SPEC §6.13). An address that
// cannot echo the check (a routine's trigger answers 200 and nothing else) is asked for with approval: person. The
// server runs the push guard on it and keeps one row, the request; it sends nothing to the address and makes no
// subscription and no event job. The member's person approves it on the dashboard with a passkey (appapi/eventurl.go).

type askArgs struct {
	id, url, name string
	urgent, made  bool
	secret        []byte
	ttl           time.Duration
	atCap         bool // the member has 6 live subscriptions and none of them is this one
}

// askPerson makes or reuses the member's request for this address. 202 a new one (with the secret when bot-link made
// it), 200 the one that already waits for the same address, name and urgent_only.
func (a *API) askPerson(w http.ResponseWriter, r *http.Request, c *Caller, q askArgs) error {
	ctx := r.Context()
	// counted first and on its own: a refused ask (the host rule, the guard, the caps below) is still an ask, so a chat
	// cannot probe them for free
	if err := a.St.Tx(ctx, func(tx pgx.Tx) error { return ratelimit.Hit(ctx, tx, ratelimit.EventURLAsks, c.M.ID) }); err != nil {
		return err
	}
	if !events.PlainHost(q.url) {
		return httpx.E(422, "event_url_blocked", "An address your person approves must have a plain host: letters, digits, dots and dashes (no xn-- part, no number a browser reads as an address, no dot at the end), or an IP address written out in full.")
	}
	if q.atCap {
		return httpx.E(409, "too_many_subscriptions", "This member already has 6 event subscriptions. Remove one first.")
	}
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	_, err := a.Pusher.CheckURL(cctx, q.url)
	cancel()
	if err != nil {
		if errors.Is(err, push.ErrBlocked) {
			return verifyFailed("blocked")
		}
		return verifyFailed("connection")
	}
	var view map[string]any
	created := false
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		var epoch int
		var account string
		if err := tx.QueryRow(ctx, `select key_epoch, account_id from members where id = $1 and removed_at is null for update`, c.M.ID).Scan(&epoch, &account); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return gone()
			}
			return err
		}
		if epoch != c.M.KeyEpoch {
			return httpx.E(401, "unknown_key", "This member moved to another chat.")
		}
		// the account's cap counts rows of all its members: one ask at a time per account
		if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended('event_url_ask:' || $1::text, 0))`, account); err != nil {
			return err
		}
		// a request that ran out, or that an earlier chat of this member left, waits for nobody
		if _, err := tx.Exec(ctx, `delete from event_url_requests where member_id = $1 and status = 'waiting' and (expires_at <= now() or key_epoch <> $2)`,
			c.M.ID, epoch); err != nil {
			return err
		}
		row := tx.QueryRow(ctx, `select `+reqCols+` from event_url_requests where member_id = $1 and key_epoch = $2 and url = $3 and name = $4
			and urgent_only = $5 and status = 'waiting'`, c.M.ID, epoch, q.url, q.name, q.urgent)
		if v, err := a.scanRequest(row); err == nil {
			view = v
			return nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		var mine, all int
		if err := tx.QueryRow(ctx, `select count(*) filter (where q.member_id = $1), count(*) from event_url_requests q join members m on m.id = q.member_id
			where m.account_id = $2 and q.status = 'waiting' and q.expires_at > now() and m.removed_at is null`, c.M.ID, account).Scan(&mine, &all); err != nil {
			return err
		}
		if mine >= events.MaxWaitingPerMember {
			return httpx.E(409, "too_many_requests_waiting", "This member already has 2 addresses waiting for its person. Withdraw one, or wait until the person decides.")
		}
		if all >= events.MaxWaitingPerAccount {
			return httpx.E(409, "too_many_requests_waiting", "This person already has 10 addresses waiting from their chats. Wait until the person decides.")
		}
		v, err := a.scanRequest(tx.QueryRow(ctx, `insert into event_url_requests (id, member_id, key_epoch, url, name, urgent_only, secret, ttl_s, expires_at)
			values ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9)) returning `+reqCols,
			wire.NewV7().String(), c.M.ID, epoch, q.url, q.name, q.urgent, q.secret, int(q.ttl.Seconds()), int(events.RequestTTL.Seconds())))
		if err != nil {
			return err
		}
		view, created = v, true
		// the person's open dashboards reload "What needs you"
		_, err = tx.Exec(ctx, `select pg_notify('bl_dash', $1::text)`, account)
		return err
	})
	if err != nil {
		return err
	}
	out := map[string]any{"request": view, "approve_url": view["approve_url"]}
	status := 200
	if created {
		status = 202
		if q.made {
			out["secret"] = events.EncodeSecret(q.secret) // made by bot-link: returned in this answer only
		}
	}
	httpx.WriteJSON(w, status, out)
	return nil
}

const reqCols = `id::text, status, url, name, urgent_only, created_at, expires_at, decided_at, expires_at <= now()`

// scanRequest reads one request as the chat sees it (never its secret). An expired waiting request reads "expired".
func (a *API) scanRequest(row pgx.Row) (map[string]any, error) {
	var id, status, url, name string
	var urgent, expired bool
	var created, exp time.Time
	var decided *time.Time
	if err := row.Scan(&id, &status, &url, &name, &urgent, &created, &exp, &decided, &expired); err != nil {
		return nil, err
	}
	if status == "waiting" && expired {
		status = "expired"
	}
	v := map[string]any{"id": id, "status": status, "url": url, "name": name, "urgent_only": urgent, "created_at": created.UTC(),
		"expires_at": exp.UTC(), "decided_at": nil, "approve_url": nil}
	if decided != nil {
		v["decided_at"] = decided.UTC()
	}
	if status == "waiting" {
		v["approve_url"] = events.ApproveURL(a.Cfg.AppOrigin, id)
	}
	return v, nil
}

// memberRequests: this chat's requests that wait, and the ones its person decided in the last day (so the chat learns
// "approved" or "rejected" from its next list).
func (a *API) memberRequests(ctx context.Context, c *Caller) ([]map[string]any, error) {
	rows, err := a.St.Pool.Query(ctx, `select `+reqCols+` from event_url_requests where member_id = $1 and key_epoch = $2
		and (status = 'waiting' or decided_at > now() - interval '24 hours') order by created_at, id`, c.M.ID, c.M.KeyEpoch)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		v, err := a.scanRequest(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// DELETE /api/v1/me/events/requests/{id}: withdraw a waiting request of this member. Unknown ids answer the same.
func (a *API) deleteEventRequest(w http.ResponseWriter, r *http.Request, c *Caller) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if !wire.IsUUID(id) {
		return httpx.NotFound()
	}
	removed := false
	err := a.St.Tx(ctx, func(tx pgx.Tx) error {
		var account string
		err := tx.QueryRow(ctx, `delete from event_url_requests q using members m where q.id = $1 and q.member_id = $2 and q.status = 'waiting'
			and m.id = q.member_id returning m.account_id::text`, id, c.M.ID).Scan(&account)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		removed = true
		_, err = tx.Exec(ctx, `select pg_notify('bl_dash', $1::text)`, account)
		return err
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"ok": true, "removed": removed})
	return nil
}

// refusedByPerson: 409 stopped_by_person when the member's person stopped this address, or turned a request for it
// down, within events.RefusalTime. Asked before a plain subscribe sends anything to the address.
func (a *API) refusedByPerson(ctx context.Context, member, url string) error {
	var reason string
	var until time.Time
	err := a.St.Pool.QueryRow(ctx, `select reason, until from event_url_refusals where member_id = $1 and url_key = $2 and until > now()`,
		member, events.URLKey(url)).Scan(&reason, &until)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	what := "stopped this address"
	if reason == "rejected" {
		what = "turned this address down"
	}
	return httpx.E(409, "stopped_by_person", "This chat's person "+what+" in the last 24 hours, so bot-link sends it nothing, not even its check. "+
		"To use it, ask the person again: botlink events subscribe --url <the address> --ask-person.").With("reason", reason).With("until", until.UTC())
}

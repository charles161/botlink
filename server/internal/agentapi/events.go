package agentapi

import (
	"context"
	"encoding/hex"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/events"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/push"
	"github.com/charles161/botlink/server/internal/ratelimit"
	"github.com/charles161/botlink/server/internal/wire"
)

// bot-link Events (SPEC §6.13), the webhook mode of MCP Events (SEP-3415): the member's chat subscribes a URL to
// content-free events; bot-link POSTs each one as a Standard Webhooks message. Only the chat that holds the member
// manages its subscriptions (authHeld). The bot-link MCP server maps events/subscribe and events/unsubscribe to
// these routes; the command line (`botlink events …`) uses them directly.

const (
	maxSubscriptions = events.MaxSubscriptions
	defaultSubTTL    = 30 * 24 * time.Hour
	maxSubTTL        = 90 * 24 * time.Hour
	minSubTTL        = 5 * time.Minute
	secretGrace      = 10 * time.Minute // a refresh that replaces the secret: both verify this long
)

var subIDRe = regexp.MustCompile(`^sub_[0-9a-f]{24}$`)

func eventTypes() []map[string]any {
	out := make([]map[string]any, 0, len(events.Catalogue))
	for _, t := range events.Catalogue {
		out = append(out, map[string]any{"name": t.Name, "description": t.Description})
	}
	return out
}

func verifyFailed(reason string) *httpx.Error {
	if reason == "blocked" {
		return httpx.E(422, "event_url_blocked", "That URL isn't allowed (https only, public addresses only).")
	}
	return httpx.E(422, "event_verify_failed", "The URL didn't pass bot-link's check: it must answer the signed verification message with 2xx and {\"challenge\": the same value}.").
		With("reason", reason)
}

// POST /api/v1/me/events/subscriptions {name, url, secret?, urgent_only?, ttl_s?}: subscribe, or refresh the
// subscription with the same (url, name, urgent_only). A new URL must pass the challenge handshake first. `secret`
// is the caller's `whsec_…` (MCP Events: the client makes it); without one bot-link makes it for a new subscription
// and returns it in this answer only. A refresh re-grants the time, turns an "off" subscription on again, keeps the
// secret unless a new one is given (then the old one keeps verifying for 10 minutes), and queues one event when
// messages wait that the endpoint was never told about.
func (a *API) postEventSub(w http.ResponseWriter, r *http.Request, c *Caller) error {
	err := a.subscribe(w, r, c)
	if errors.Is(err, errApprovalEnded) {
		// the person stopped the approved subscription (or it lapsed) while this refresh relied on it: once more, as
		// the address now stands (a plain refresh must pass the check, approval: person asks the person again)
		err = a.subscribe(w, r, c)
	}
	if errors.Is(err, errApprovalEnded) {
		return httpx.E(409, "approval_ended", "The person's approval of this address ended meanwhile. Ask again.")
	}
	return err
}

// errApprovalEnded: a refresh that relied on the person's approval found the subscription gone, lapsed or failing
// under its lock. Nothing was written.
var errApprovalEnded = errors.New("the approved subscription ended meanwhile")

func (a *API) subscribe(w http.ResponseWriter, r *http.Request, c *Caller) error {
	ctx := r.Context()
	var b struct {
		Name       string  `json:"name"`
		URL        string  `json:"url"`
		Secret     *string `json:"secret"`
		UrgentOnly *bool   `json:"urgent_only"`
		TTLS       *int    `json:"ttl_s"`
		Approval   *string `json:"approval"`
	}
	if err := httpx.DecodeStrict(c.Body, &b); err != nil {
		return err
	}
	if b.Approval != nil && *b.Approval != events.ApprovedByPerson {
		return httpx.BadRequest(`approval must be "person": the member's person approves the URL on the dashboard.`)
	}
	if b.Approval != nil && b.Name != events.TypeMessage {
		return httpx.BadRequest("approval: person is only for message.received.")
	}
	if !events.Subscribable(b.Name) {
		return httpx.BadRequest("name must be an event from the catalogue (GET /api/v1/me/events/subscriptions lists it).")
	}
	if b.URL == "" || len(b.URL) > 500 {
		return httpx.BadRequest("url is required (500 chars max).")
	}
	if !strings.HasPrefix(b.URL, "https://") && !strings.HasPrefix(b.URL, "http://") {
		return verifyFailed("blocked") // (also an upper-case scheme: the stored URL is compared byte for byte)
	}
	urgent := b.UrgentOnly != nil && *b.UrgentOnly
	if urgent && b.Name != events.TypeMessage {
		return httpx.BadRequest("urgent_only is only for message.received.")
	}
	ttl := defaultSubTTL
	if b.TTLS != nil {
		ttl = time.Duration(*b.TTLS) * time.Second
		if ttl < minSubTTL || ttl > maxSubTTL {
			return httpx.BadRequest("ttl_s must be between 300 (5 minutes) and 7776000 (90 days).")
		}
	}
	id := events.SubscriptionID(c.M.ID, b.URL, b.Name, urgent)
	var secret []byte
	made := false
	if b.Secret != nil {
		var err error
		if secret, err = events.DecodeSecret(*b.Secret); err != nil {
			return httpx.BadRequest("secret must be whsec_ followed by base64 of 24 to 64 random bytes.")
		}
	} else {
		// no secret given: a refresh keeps the one the endpoint already has (a silent new one would make every event
		// fail its check there); only a new subscription gets a fresh one, returned once
		err := a.St.Pool.QueryRow(ctx, `select secret from event_subscriptions where id = $1 and key_epoch = $2`, id, c.M.KeyEpoch).Scan(&secret)
		switch {
		case err == nil: // keep it
		case errors.Is(err, pgx.ErrNoRows):
			secret, made = wire.RandBytes(32), true
		default:
			return err
		}
	}

	// what is there now: the same subscription (a refresh); whether this chat already proved this URL with the check
	// (an address a person approved proved nothing: it does not let another subscription on that URL skip the check);
	// whether this very subscription is one the person approved and it has not lapsed
	var have, verified, failing, approved bool
	var live int
	if err := a.St.Pool.QueryRow(ctx, `select
			exists (select 1 from event_subscriptions where id = $1 and key_epoch = $3),
			exists (select 1 from event_subscriptions where member_id = $2 and key_epoch = $3 and url = $4 and verified_at is not null and approved_by is null),
			exists (select 1 from event_subscriptions where member_id = $2 and key_epoch = $3 and url = $4 and (failed_since is not null or disabled_at is not null)),
			exists (select 1 from event_subscriptions where id = $1 and key_epoch = $3 and approved_by is not null and expires_at > now()),
			(select count(*) from event_subscriptions where member_id = $2 and key_epoch = $3 and expires_at > now() and id <> $1)`,
		id, c.M.ID, c.M.KeyEpoch, b.URL).Scan(&have, &verified, &failing, &approved, &live); err != nil {
		return err
	}
	// approval: person (docs/protocol/event-url-approval.md): an address that is neither proven nor a healthy approved
	// subscription of this key becomes a request for the member's person; nothing is sent to it (eventurl.go)
	if b.Approval != nil && (failing || !(verified || approved)) {
		return a.askPerson(w, r, c, askArgs{id: id, url: b.URL, name: b.Name, urgent: urgent, secret: secret, made: made, ttl: ttl,
			atCap: !have && live >= maxSubscriptions})
	}
	if !have && live >= maxSubscriptions {
		return httpx.E(409, "too_many_subscriptions", "This member already has 6 event subscriptions. Remove one first.")
	}
	// the member's person stopped this address, or turned it down, in the last 24 hours: a plain subscribe sends it
	// nothing, not even the check (approval: person stays possible: it sends nothing)
	if b.Approval == nil {
		if err := a.refusedByPerson(ctx, c.M.ID, b.URL); err != nil {
			return err
		}
	}
	if err := a.St.Tx(ctx, func(tx pgx.Tx) error { return ratelimit.Hit(ctx, tx, ratelimit.EventSubs, c.M.ID) }); err != nil {
		return err
	}
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	u, err := a.Pusher.CheckURL(cctx, b.URL)
	cancel()
	if err != nil {
		if errors.Is(err, push.ErrBlocked) {
			return verifyFailed("blocked")
		}
		return verifyFailed("connection") // the name doesn't resolve, the lookup timed out: unreachable, not forbidden
	}
	// A subscription whose endpoint is failing (or that failures turned off) is only made healthy again by proof: the
	// refresh must pass the challenge. Otherwise a receiver that is alive behind a dead tunnel would wipe the failure
	// state with every renewal and the room would keep reading "wakes on its own" (second review, 2026-11-10).
	// "Failing" is about the URL, not one subscription of it: the other variant (FYIs on / off, the roster event)
	// on the same dead URL can't come in unchallenged either (third review).
	// A test server's operator can name hosts whose endpoints can only answer 2xx (a cloud agent's routine webhook):
	// BOTLINK_EVENTS_NO_CHALLENGE_HOSTS, dev only, empty by default. There the handshake is skipped and the answer
	// says so; a failing subscription on such a host is never made healthy by a refresh (there is no proof):
	// remove it and subscribe again.
	unchecked := a.Cfg.EventsNoChallenge(u.Hostname())
	challenged := false
	// a healthy subscription the person approved refreshes without the check (its key only; docs/protocol/event-url-approval.md §4)
	if ((!verified && !approved) || failing) && !unchecked {
		challenged = true
		// endpoint verification (SEP-3415 challenge handshake): nothing is delivered to a URL that didn't echo a
		// signed single-use challenge, so a member can't point bot-link at somebody else's endpoint
		nonce := hex.EncodeToString(wire.RandBytes(16))
		if reason, err := events.Challenge(ctx, a.Pusher, b.URL, secret, id, "msg_verification_"+hex.EncodeToString(wire.RandBytes(8)), nonce); err != nil {
			return verifyFailed(reason)
		}
	}
	var s *events.Sub
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		// under the member row lock: the cap can't be raced past, and a member removed or moved meanwhile gets nothing
		var epoch int
		if err := tx.QueryRow(ctx, `select key_epoch from members where id = $1 and removed_at is null for update`, c.M.ID).Scan(&epoch); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return gone()
			}
			return err
		}
		if epoch != c.M.KeyEpoch {
			return httpx.E(401, "unknown_key", "This member moved to another chat.")
		}
		// subscriptions an earlier chat of this member left behind never come back to life
		if _, err := tx.Exec(ctx, `delete from event_subscriptions where member_id = $1 and key_epoch <> $2`, c.M.ID, epoch); err != nil {
			return err
		}
		if approved && !verified && !challenged {
			// nothing proved this address: only the person's approval stands behind this refresh, so it must still be
			// there, unexpired and healthy, under its row lock (a Stop that comes now waits for this transaction)
			var one int
			err := tx.QueryRow(ctx, `select 1 from event_subscriptions where id = $1 and key_epoch = $2 and approved_by is not null
				and expires_at > now() and failed_since is null and disabled_at is null for update`, id, epoch).Scan(&one)
			if errors.Is(err, pgx.ErrNoRows) {
				return errApprovalEnded
			}
			if err != nil {
				return err
			}
		}
		var n int
		if err := tx.QueryRow(ctx, `select count(*) from event_subscriptions where member_id = $1 and expires_at > now() and id <> $2`,
			c.M.ID, id).Scan(&n); err != nil {
			return err
		}
		if n >= maxSubscriptions {
			return httpx.E(409, "too_many_subscriptions", "This member already has 6 event subscriptions. Remove one first.")
		}
		var err error
		s, err = events.ScanSub(tx.QueryRow(ctx, `insert into event_subscriptions as s (id, member_id, key_epoch, url, name, urgent_only, secret,
				expires_at, verified_at)
			values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8), now())
			on conflict (id) do update set
				prev_secret = case when s.secret <> excluded.secret then s.secret else s.prev_secret end,
				prev_until  = case when s.secret <> excluded.secret then now() + make_interval(secs => $9) else s.prev_until end,
				secret = excluded.secret, expires_at = excluded.expires_at, refreshed_at = now(),
				verified_at = coalesce(s.verified_at, now()),
				-- the failure state is reset only by a challenge that passed in THIS call (a failure the worker
				-- recorded a moment ago, after this call looked, is never wiped unproven)
				disabled_at = case when $10::bool then null else s.disabled_at end,
				fails = case when $10::bool then 0 else s.fails end,
				failed_since = case when $10::bool then null else s.failed_since end,
				-- an address that has now echoed the check is proven: no longer one only a person vouched for
				approved_by = case when $10::bool then null else s.approved_by end,
				approved_at = case when $10::bool then null else s.approved_at end
			returning `+events.SubCols, id, c.M.ID, epoch, b.URL, b.Name, urgent, secret, int(ttl.Seconds()), int(secretGrace.Seconds()), challenged))
		if err != nil || b.Name != events.TypeMessage {
			return err
		}
		return events.QueueCatchUp(ctx, tx, id, c.M.ID, urgent)
	})
	if err != nil {
		return err
	}
	out := map[string]any{"subscription": s.View(time.Now()), "refreshed": have}
	status := 201
	if have {
		status = 200
	}
	if made {
		out["secret"] = events.EncodeSecret(secret)
	}
	if unchecked {
		out["unchecked"] = true // this server never asked the URL to prove itself (operator's test switch)
	}
	httpx.WriteJSON(w, status, out)
	return nil
}

// GET /api/v1/me/events/subscriptions: this member's subscriptions (never their secrets), its address requests
// (waiting, and the ones decided in the last day, so the chat learns the outcome) and the event catalogue.
func (a *API) getEventSubs(w http.ResponseWriter, r *http.Request, c *Caller) error {
	ctx := r.Context()
	rows, err := a.St.Pool.Query(ctx, `select `+events.SubCols+` from event_subscriptions s
		where s.member_id = $1 and s.key_epoch = $2 order by s.created_at, s.id`, c.M.ID, c.M.KeyEpoch)
	if err != nil {
		return err
	}
	defer rows.Close()
	now := time.Now()
	out := []map[string]any{}
	for rows.Next() {
		s, err := events.ScanSub(rows)
		if err != nil {
			return err
		}
		out = append(out, s.View(now))
	}
	if err := rows.Err(); err != nil {
		return err
	}
	reqs, err := a.memberRequests(ctx, c)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"subscriptions": out, "requests": reqs, "event_types": eventTypes()})
	return nil
}

// DELETE /api/v1/me/events/subscriptions/{id}: stop sending. Unknown ids answer the same (idempotent).
func (a *API) deleteEventSub(w http.ResponseWriter, r *http.Request, c *Caller) error {
	id := r.PathValue("id")
	if !subIDRe.MatchString(id) {
		return httpx.NotFound()
	}
	tag, err := a.St.Pool.Exec(r.Context(), `delete from event_subscriptions where id = $1 and member_id = $2`, id, c.M.ID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"ok": true, "removed": tag.RowsAffected() > 0})
	return nil
}

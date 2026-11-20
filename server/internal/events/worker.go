package events

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/charles161/botlink/server/internal/metrics"
	"github.com/charles161/botlink/server/internal/push"
	"github.com/charles161/botlink/server/internal/wake"
)

// Backoff after try n (1-based): 5 s, 30 s, 2 min, 10 min; after MaxTries the event fails. Shorter than the push
// worker's on purpose: an event is a wake signal, and the message itself keeps waiting in the inbox either way.
var Backoff = []time.Duration{5 * time.Second, 30 * time.Second, 2 * time.Minute, 10 * time.Minute}

const (
	MaxTries = 5
	// MaxFails: this many events in a row that ran out of tries turn the subscription off ("listener down").
	MaxFails = 3
)

// Worker delivers event_jobs (each copy runs one; jobs are claimed with SKIP LOCKED and a 60 s claim lease).
// Slots is how many events one copy sends at the same time; PersonSlots how many of those one person can hold.
const (
	Slots       = 20
	PersonSlots = 4
	// perClaim: how many of one person's subscriptions a single claim of the running loop may take. A person at
	// PersonSlots-perClaim+1 or more in flight is left out of a claim, so nobody ever holds more than PersonSlots.
	perClaim = 2
)

var _ [PersonSlots - perClaim]struct{} // compile-time: PersonSlots >= perClaim

type Worker struct {
	Pool   *pgxpool.Pool
	Client *push.Client
	Bus    *wake.Bus
	M      *metrics.Set
	Every  time.Duration

	// the running loop's in-flight deliveries (Run only): which subscriptions and how many per person are going
	// out right now, so the next claim leaves them alone
	mu       sync.Mutex
	subs     map[string]struct{}
	accounts map[string]int
	active   int
	freed    chan struct{}
	wg       sync.WaitGroup
}

// Run delivers events until ctx ends. Each delivery takes one of Slots and gives it back when its POST is done:
// the loop never waits for a batch, so an endpoint that takes the full 5 s holds one slot for 5 s and delays nobody
// else (load test 2026-11-10: with batches, one slow endpoint added about 4 s to everyone's wake). In this process
// one event per subscription is going out at a time (the oldest that is due: an event waiting for a retry can be
// overtaken by a newer one, and another server copy may send the next one meanwhile; events are wake signals and
// receivers act once per id), at most PersonSlots per person.
func (w *Worker) Run(ctx context.Context) {
	every := w.Every
	if every == 0 {
		every = 2 * time.Second
	}
	w.mu.Lock()
	w.subs, w.accounts, w.freed = map[string]struct{}{}, map[string]int{}, make(chan struct{}, 1)
	w.mu.Unlock()
	bell := w.Bus.Hold(wake.Push + ":")
	defer bell.Release()
	t := time.NewTicker(every)
	defer t.Stop()
	defer w.wg.Wait() // deliveries in flight end with ctx (their POST is cancelled; the claim lapses and they are retried)
	for {
		for {
			n, err := w.pump(ctx)
			if err != nil {
				if ctx.Err() == nil {
					slog.Warn("events worker", "err", err)
				}
				break
			}
			if n == 0 {
				break
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-bell.C:
		case <-t.C:
		case <-w.freed: // a slot came back: its subscription's next event (or someone waiting for a slot) can go
			// several usually come back together: one claim for all of them, not one query per slot
			select {
			case <-ctx.Done():
				return
			case <-time.After(15 * time.Millisecond):
			}
		}
	}
}

// pump claims as many due jobs as there are free slots (leaving alone subscriptions that have one going out and
// people who hold their share) and starts each in its own goroutine. Returns how many it started.
func (w *Worker) pump(ctx context.Context) (int, error) {
	w.mu.Lock()
	free := Slots - w.active
	busySubs := make([]string, 0, len(w.subs))
	for s := range w.subs {
		busySubs = append(busySubs, s)
	}
	var fullAccounts []string
	for a, n := range w.accounts {
		if n > PersonSlots-perClaim { // a claim adds at most perClaim per person: never more than PersonSlots
			fullAccounts = append(fullAccounts, a)
		}
	}
	w.mu.Unlock()
	if free <= 0 {
		return 0, nil
	}
	jobs, err := w.claim(ctx, free, perClaim, busySubs, fullAccounts)
	if err != nil {
		return 0, err
	}
	w.mu.Lock()
	for _, j := range jobs {
		w.subs[j.sub] = struct{}{}
		w.accounts[j.account]++
		w.active++
	}
	w.mu.Unlock()
	for _, j := range jobs {
		w.wg.Add(1)
		go func(j job) {
			defer w.wg.Done()
			defer func() {
				w.mu.Lock()
				delete(w.subs, j.sub)
				if w.accounts[j.account]--; w.accounts[j.account] <= 0 {
					delete(w.accounts, j.account)
				}
				w.active--
				w.mu.Unlock()
				select {
				case w.freed <- struct{}{}:
				default:
				}
			}()
			w.deliver(ctx, j)
		}(j)
	}
	return len(jobs), nil
}

type job struct {
	id       int64
	eventID  string
	typ      string
	message  *string
	data     []byte
	tries    int
	created  time.Time
	sub      string
	url      string
	secret   []byte
	prev     []byte // the secret a refresh replaced, still inside its grace window
	live     bool   // subscription on, not expired, member active, same key epoch
	account  string // the member's person (slots per person)
	member   string
	name     string
	room     string
	roomName string
}

// Once claims up to Slots due jobs (the oldest per subscription, at most PersonSlots per person), POSTs them
// together outside any transaction, waits for all of them and records the outcomes. Run uses the same claim through
// pump without waiting; Once is the one-shot form (tests, tools).
func (w *Worker) Once(ctx context.Context) (int, error) {
	jobs, err := w.claim(ctx, Slots, PersonSlots, nil, nil)
	if err != nil {
		return 0, err
	}
	var wg sync.WaitGroup
	for _, j := range jobs {
		wg.Add(1)
		go func(j job) {
			defer wg.Done()
			w.deliver(ctx, j)
		}(j)
	}
	wg.Wait()
	return len(jobs), nil
}

// claim takes up to limit due jobs with a 60 s claim (committed): the oldest due job of each subscription (its
// events go out in order of arrival), at most perPerson of one person's subscriptions, never one of busySubs
// (a subscription with an event going out right now) or of fullAccounts (people holding their share of slots).
// A person's dead endpoint never holds up their own healthy members (each subscription has its own slot), and one
// person with many members or subscriptions can't take the slots from everybody else.
func (w *Worker) claim(ctx context.Context, limit, perPerson int, busySubs, fullAccounts []string) ([]job, error) {
	if busySubs == nil {
		busySubs = []string{}
	}
	if fullAccounts == nil {
		fullAccounts = []string{}
	}
	rows, err := w.Pool.Query(ctx, `
		with due as (
			select j.id from event_jobs j
			where not j.done and j.next_attempt_at <= now()
			  and j.id in (select y.id from (
			        -- within one person: subscriptions whose endpoint is taking events first, then the failing ones
			        -- (a person's dead endpoints never outrank their healthy ones for that person's slots)
			        select x.id, row_number() over (partition by x.account_id order by x.failing, x.id) as rn from (
			          select min(q.id) as id, qm.account_id, (qs.failed_since is not null) as failing from event_jobs q
			          join event_subscriptions qs on qs.id = q.subscription_id join members qm on qm.id = qs.member_id
			          where not q.done and q.next_attempt_at <= now()
			            and q.subscription_id <> all($3::text[]) and qm.account_id::text <> all($4::text[])
			          group by q.subscription_id, qm.account_id, (qs.failed_since is not null)) x) y
			      where y.rn <= $2)
			order by j.id limit $1 for update of j skip locked
		), claimed as (
			update event_jobs j set next_attempt_at = now() + interval '60 seconds' from due where j.id = due.id
			returning j.id, j.event_id, j.type, j.message_id, j.data, j.tries, j.created_at, j.subscription_id
		)
		select c.id, c.event_id::text, c.type, c.message_id::text, c.data, c.tries, c.created_at, s.id, s.url, s.secret,
		       case when s.prev_until > now() then s.prev_secret end,
		       s.disabled_at is null and s.expires_at > now() and m.removed_at is null and s.key_epoch = m.key_epoch,
		       m.account_id::text, m.id::text, m.name, r.id::text, r.name
		from claimed c join event_subscriptions s on s.id = c.subscription_id
		     join members m on m.id = s.member_id join rooms r on r.id = m.room_id
		order by c.id`, limit, perPerson, busySubs, fullAccounts)
	if err != nil {
		return nil, err
	}
	var jobs []job
	for rows.Next() {
		var j job
		if err := rows.Scan(&j.id, &j.eventID, &j.typ, &j.message, &j.data, &j.tries, &j.created, &j.sub, &j.url, &j.secret, &j.prev,
			&j.live, &j.account, &j.member, &j.name, &j.room, &j.roomName); err != nil {
			rows.Close()
			return nil, err
		}
		jobs = append(jobs, j)
	}
	rows.Close()
	return jobs, rows.Err()
}

// Body builds one event's webhook body: the MCP Events EventOccurrence {eventId, name, timestamp, data}.
func Body(eventID, name string, at time.Time, data map[string]any) []byte {
	b, _ := json.Marshal(map[string]any{"eventId": eventID, "name": name, "timestamp": at.UTC().Format(time.RFC3339), "data": data})
	return b
}

// Headers are the Standard Webhooks headers (+ X-MCP-Subscription-Id) for one attempt. webhookID is the event's id
// for an event (deployed MCP Events clients require webhook-id == eventId) and "msg_<type>_<random>" for a control
// message; it stays the same on every retry while the timestamp and signature are fresh.
func Headers(secrets [][]byte, webhookID, subscriptionID string, body []byte, now time.Time) map[string]string {
	ts := now.Unix()
	return map[string]string{
		"User-Agent":            "botlink-events/1",
		"webhook-id":            webhookID,
		"webhook-timestamp":     strconv.FormatInt(ts, 10),
		"webhook-signature":     SignAll(secrets, webhookID, ts, body),
		"X-MCP-Subscription-Id": subscriptionID,
	}
}

// Challenge runs the endpoint verification handshake (SEP-3415): POST a signed {"type":"verification","challenge"}
// control message; the endpoint must answer 2xx with {"challenge": <the same nonce>}. Returns a short category
// (connection | http_4xx | http_5xx | challenge_failed | blocked) when it fails.
func Challenge(ctx context.Context, c *push.Client, rawURL string, secret []byte, subscriptionID, webhookID, nonce string) (string, error) {
	body, _ := json.Marshal(map[string]any{"type": "verification", "challenge": nonce})
	res, err := c.PostWith(ctx, rawURL, Headers([][]byte{secret}, webhookID, subscriptionID, body, time.Now()), body)
	if err != nil {
		if errors.Is(err, push.ErrBlocked) {
			return "blocked", err
		}
		return "connection", err
	}
	if res.Status < 200 || res.Status > 299 {
		if res.Status >= 500 {
			return "http_5xx", fmt.Errorf("verification answered %d", res.Status)
		}
		return "http_4xx", fmt.Errorf("verification answered %d", res.Status)
	}
	var got struct {
		Challenge string `json:"challenge"`
	}
	if json.Unmarshal(res.Body, &got) != nil || subtle.ConstantTimeCompare([]byte(got.Challenge), []byte(nonce)) != 1 {
		return "challenge_failed", errors.New("the endpoint didn't echo the challenge")
	}
	return "", nil
}

func (w *Worker) finish(ctx context.Context, id int64, result string) {
	_, _ = w.Pool.Exec(ctx, `update event_jobs set done = true where id = $1`, id)
	w.count(result)
}

func (w *Worker) deliver(ctx context.Context, j job) {
	if !j.live {
		w.finish(ctx, j.id, "skipped")
		return
	}
	data := map[string]any{
		"subscription_id": j.sub,
		"member":          map[string]any{"id": j.member, "name": j.name},
		"room":            map[string]any{"id": j.room, "name": j.roomName},
	}
	switch j.typ {
	case TypeMessage:
		if j.message == nil {
			w.finish(ctx, j.id, "skipped")
			return
		}
		// Only wake for a copy that still waits unread: a chat that already saw the message (its own turn, a retry that
		// arrives late) is never woken for it again.
		var fromID, fromName, scope string
		var quiet bool
		var waiting int
		var leased *time.Time
		err := w.Pool.QueryRow(ctx, `
			select f.id::text, f.name, msg.scope, msg.quiet,
			       (select count(*) from deliveries q where q.member_id = d.member_id and q.state = 'queued'
			          and (q.not_before is null or q.not_before <= now())),
			       case when d.lease_until > now() then d.lease_until end
			from deliveries d join messages msg on msg.id = d.message_id join members f on f.id = msg.from_member
			where d.message_id = $1 and d.member_id = $2 and d.state = 'queued'`, *j.message, j.member).Scan(&fromID, &fromName, &scope, &quiet, &waiting, &leased)
		if err != nil {
			// no such waiting copy (read, expired, stuck): nothing to wake for. A database error: try again later (the
			// claim lapses in 60 s).
			if isNoRows(err) {
				w.finish(ctx, j.id, "skipped")
				// an attempt for this copy failed, then the chat read it itself: one blip, no event ever ran out of
				// tries. Don't leave the subscription marked as failing (the room would show "listener down" on the
				// strength of a single failed attempt); a dead endpoint is marked again by its next event.
				// (only when nothing else of the subscription is mid-retry and no event has run out of tries)
				if j.tries > 0 {
					_, _ = w.Pool.Exec(ctx, `update event_subscriptions s set failed_since = null, last_error = null
						where s.id = $1 and s.fails = 0
						  and not exists (select 1 from event_jobs o where o.subscription_id = s.id and not o.done and o.tries > 0 and o.id <> $2)`,
						j.sub, j.id)
				}
			}
			return
		}
		if leased != nil {
			// the chat is reading it right now (its own turn holds the copy): no wake. If that read never finishes (the
			// app died mid-turn) the copy comes back, so look again right after the hold ends; no try is counted.
			_, _ = w.Pool.Exec(ctx, `update event_jobs set next_attempt_at = $2::timestamptz + interval '1 second' where id = $1`, j.id, *leased)
			w.count("deferred")
			return
		}
		data["message_id"] = *j.message
		if scope == "self" {
			// the wake test: sent by bot-link, not by a member (SPEC §6.4a)
			data["from"] = map[string]any{"id": nil, "name": "bot-link"}
			data["self_test"] = true
		} else {
			data["from"] = map[string]any{"id": fromID, "name": fromName}
		}
		data["scope"] = scope
		data["quiet"] = quiet
		data["waiting"] = waiting
	default:
		var extra map[string]any
		if len(j.data) > 0 && json.Unmarshal(j.data, &extra) == nil {
			for k, v := range extra {
				data[k] = v
			}
		}
	}
	attempt := j.tries + 1
	body := Body(j.eventID, j.typ, j.created, data)
	secrets := [][]byte{j.secret}
	if len(j.prev) > 0 {
		secrets = append(secrets, j.prev)
	}
	res, err := w.Client.PostWith(ctx, j.url, Headers(secrets, j.eventID, j.sub, body, time.Now()), body)
	if err != nil && ctx.Err() != nil {
		return // shutting down: nothing is recorded, the claim lapses and the event goes out again later
	}
	if err == nil && res.Status >= 200 && res.Status < 300 {
		_, _ = w.Pool.Exec(ctx, `update event_jobs set done = true, tries = $2, last_error = null where id = $1`, j.id, attempt)
		_, _ = w.Pool.Exec(ctx, `update event_subscriptions set last_ok_at = now(), fails = 0, last_error = null, failed_since = null where id = $1`, j.sub)
		if j.typ == TypeMessage {
			// a wake was counted for this copy: the ack that shows it within 3 minutes proves the chat wakes while idle
			// (SPEC §6.9 "observed idle wake"), the same rule as a listener's wait. Counted once per copy however many
			// subscriptions the member has: accepted events must never push a healthy copy towards "stuck" (5 wakes).
			_, _ = w.Pool.Exec(ctx, `update deliveries set wakes = 1 where message_id = $1 and member_id = $2 and state = 'queued' and wakes = 0`,
				*j.message, j.member)
		}
		w.count("ok")
		return
	}
	// categories only, never the endpoint's own words (SEP-3415 deliveryStatus.lastError)
	reason, msg := "error", "connection"
	switch {
	case errors.Is(err, push.ErrBlocked):
		reason, msg = "blocked", "blocked"
	case err != nil:
		if errors.Is(err, context.DeadlineExceeded) || os.IsTimeout(err) {
			msg = "timeout"
		}
	case res.Status >= 500:
		msg = "http_5xx"
	case res.Status >= 300 && res.Status < 400:
		msg = "http_3xx" // redirects are never followed
	default:
		msg = "http_4xx"
	}
	w.count(reason)
	// 410 / 413 end the retries for this event; so does a blocked address and running out of tries
	final := attempt >= MaxTries || reason == "blocked" || (err == nil && (res.Status == 410 || res.Status == 413))
	if final {
		_, _ = w.Pool.Exec(ctx, `update event_jobs set tries = $2, done = true, failed = true, last_error = $3 where id = $1`, j.id, attempt, msg)
		_, _ = w.Pool.Exec(ctx, `update event_subscriptions set fails = fails + 1, last_error = $2, failed_since = coalesce(failed_since, now()),
			disabled_at = case when fails + 1 >= $3 then coalesce(disabled_at, now()) else disabled_at end
			where id = $1`, j.sub, msg, MaxFails)
		return
	}
	_, _ = w.Pool.Exec(ctx, `update event_jobs set tries = $2, next_attempt_at = now() + $3::interval, last_error = $4 where id = $1`,
		j.id, attempt, fmt.Sprintf("%d seconds", int(Backoff[attempt-1].Seconds())), msg)
	_, _ = w.Pool.Exec(ctx, `update event_subscriptions set last_error = $2, failed_since = coalesce(failed_since, now()) where id = $1`, j.sub, msg)
}

func isNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }

func (w *Worker) count(result string) {
	if w.M != nil && w.M.Events != nil {
		w.M.Events.Inc(result)
	}
}

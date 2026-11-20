package agentapi

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/analytics"
	"github.com/charles161/botlink/server/internal/envelope"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/plans"
	"github.com/charles161/botlink/server/internal/push"
	"github.com/charles161/botlink/server/internal/ratelimit"
	"github.com/charles161/botlink/server/internal/roster"
	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/wire"
)

// memberSelf builds MemberSelf from a fresh read.
func (a *API) memberSelf(ctx context.Context, q store.Q, id string) (map[string]any, error) {
	var name, app, job, folder, machine, turn, person, roomID, roomName, purpose string
	var holder, handover, selfLabel *string
	var wakeVerified *time.Time
	var hEpoch int64
	var kEpoch int
	var ed, x []byte
	err := q.QueryRow(ctx, `
		select m.name, m.app, m.job, m.folder, m.machine, m.turn, a.display_name, m.room_id, r.name, r.purpose,
		       m.holder_session, m.handover_env, m.holder_epoch, m.key_epoch, m.ed25519_pk, m.x25519_pk, m.self_label, m.wake_verified_at
		from members m join rooms r on r.id = m.room_id join accounts a on a.id = m.account_id where m.id = $1`, id).Scan(
		&name, &app, &job, &folder, &machine, &turn, &person, &roomID, &roomName, &purpose, &holder, &handover, &hEpoch, &kEpoch, &ed, &x,
		&selfLabel, &wakeVerified)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"id": id, "room": map[string]any{"id": roomID, "name": roomName, "purpose": purpose},
		"name": name, "app": app, "job": job, "folder": folder, "machine": machine, "turn": turn, "account_name": person,
		"holder_session": holder, "holder_epoch": hEpoch, "key_epoch": kEpoch, "fingerprint": wire.MemberFP(ed, x),
		"handover": rawOrNil(handover), "self_label": selfLabel, "wake_verified_at": wakeVerified,
	}, nil
}

func rawOrNil(s *string) any {
	if s == nil {
		return nil
	}
	return json.RawMessage(*s)
}

func (a *API) getMe(w http.ResponseWriter, r *http.Request, c *Caller) error {
	v, err := a.memberSelf(r.Context(), a.St.Pool, c.M.ID)
	if err != nil {
		return err
	}
	// the client keeps history_days days of room reports; while the paywall is off: plans.FreeHistoryDays, no plan
	v["paywall"], v["history_days"] = a.Cfg.Plans.Paywall(), plans.FreeHistoryDays
	if a.Cfg.Plans.Paywall() {
		pl, err := plans.ClientPlan(r.Context(), a.St.Pool, c.M.AccountID)
		if err != nil {
			return err
		}
		v["plan"], v["history_days"] = pl, pl[plans.HistoryDays]
	}
	httpx.WriteJSON(w, 200, v)
	return nil
}

func (a *API) getRoster(w http.ResponseWriter, r *http.Request, c *Caller) error {
	v, err := store.RosterJSON(r.Context(), a.St.Pool, c.M.RoomID, false)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, v)
	return nil
}

// DELETE /api/v1/me: leave, with member_remove signed by this member's own key.
func (a *API) deleteMe(w http.ResponseWriter, r *http.Request, c *Caller) error {
	ctx := r.Context()
	var b struct {
		RosterEntry roster.Wire `json:"roster_entry"`
	}
	if err := httpx.DecodeStrict(c.Body, &b); err != nil {
		return err
	}
	if b.RosterEntry.Signer != c.KeyHex {
		return httpx.BadRequest("Sign the leave entry with this member's own key.")
	}
	err := a.St.Tx(ctx, func(tx pgx.Tx) error {
		e, _, err := store.AppendEntry(ctx, tx, c.M.RoomID, b.RosterEntry)
		if err != nil {
			return err
		}
		if e.Op != "member_remove" || e.Member != c.M.ID {
			return httpx.BadRequest("The entry must be member_remove for this member.")
		}
		return store.ApplyDerived(ctx, tx, c.M.RoomID, e)
	})
	if err != nil {
		return err
	}
	a.An.Capture(analytics.MemberRemoved, a.An.ID(c.M.AccountID), analytics.Props{"room": a.An.ID(c.M.RoomID), "left": true})
	httpx.WriteJSON(w, 200, map[string]any{"ok": true})
	return nil
}

// POST /api/v1/me/claim: another chat on this computer wants to continue as this member (SPEC §6.7, critical fix H1).
// The same chat (the session that already holds the member) is a no-op 200. Any other chat never takes the member
// here: with `request` (its own new keys) the server opens a move request (join_requests kind=claim, move_to=chat)
// that only the member's person can approve in the browser (human check + code match + member_rekey), exactly like a
// move to a new computer; without one (an older client) it is refused with 403 claim_needs_approval. Until the person
// approves, the member, its key and its holder stay as they are.
type claimMove struct {
	ID      string  `json:"id"`
	Ed      string  `json:"ed25519_pk"`
	X       string  `json:"x25519_pk"`
	App     string  `json:"app"`
	AppName *string `json:"app_name"`
	Machine string  `json:"machine"`
	Folder  string  `json:"folder"`
	Turn    string  `json:"turn"`
	Job     string  `json:"job"`
}

func (a *API) postClaim(w http.ResponseWriter, r *http.Request, c *Caller) error {
	ctx := r.Context()
	var b struct {
		SessionID string     `json:"session_id"`
		Expected  *int64     `json:"expected_holder_epoch"`
		Request   *claimMove `json:"request"`
	}
	if err := httpx.DecodeStrict(c.Body, &b); err != nil {
		return err
	}
	if !wire.IsSessionID(b.SessionID) {
		return httpx.BadRequest("session_id is not a valid session id.")
	}
	if c.Session != b.SessionID {
		return httpx.BadRequest("X-Botlink-Session must equal session_id.")
	}
	if q := b.Request; q != nil {
		jc := joinCreate{ID: q.ID, Kind: "claim", memberProposal: memberProposal{Name: c.M.Name, Job: q.Job, App: q.App, AppName: q.AppName,
			Machine: q.Machine, Folder: q.Folder, Turn: q.Turn, SessionID: &b.SessionID, Ed: q.Ed, X: q.X}}
		if err := jc.validate(); err != nil {
			return err
		}
		if q.App != c.M.App {
			return httpx.BadRequest("A member moves to another chat of its own app only; another app needs a new member (join).")
		}
	}
	var prev *string
	var epoch int64
	var waiting int
	reqHash := wire.SHA256(c.Body)
	status := 0 // 0: no-op (same chat); 201/200: move request opened (new / same request again)
	err := a.St.Tx(ctx, func(tx pgx.Tx) error {
		var cur *string
		var curEpoch int64
		var removed bool
		if err := tx.QueryRow(ctx, `select holder_session, holder_epoch, removed_at is not null from members where id = $1 for update`,
			c.M.ID).Scan(&cur, &curEpoch, &removed); err != nil {
			return err
		}
		if removed {
			return gone()
		}
		prev = cur
		if cur != nil && *cur == b.SessionID {
			epoch = curEpoch // the same chat (same session id: an app restart or resume): nothing moves
			return tx.QueryRow(ctx, `select count(*) from deliveries where member_id = $1 and state = 'queued'`, c.M.ID).Scan(&waiting)
		}
		if b.Expected != nil && *b.Expected != curEpoch {
			return httpx.E(409, "holder_changed", "Someone else claimed this member first.").With("holder_epoch", curEpoch)
		}
		if b.Request == nil {
			return httpx.E(403, "claim_needs_approval", "Moving this member to another chat needs its person's approval in the browser. Update bot-link and run claim again: it shows the approve link and a code.")
		}
		var err error
		status, err = a.openMoveRequest(ctx, tx, c, b.Request, b.SessionID, reqHash)
		return err
	})
	if err != nil {
		return err
	}
	if status != 0 {
		v, err := a.joinView(ctx, a.St.Pool, b.Request.ID)
		if err != nil {
			return err
		}
		v["pending"] = true
		httpx.WriteJSON(w, status, v)
		return nil
	}
	me, err := a.memberSelf(ctx, a.St.Pool, c.M.ID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"member": me, "holder_epoch": epoch, "previous_session": prev,
		"waiting": waiting, "handover": me["handover"]})
	return nil
}

// openMoveRequest inserts the move request (kind claim, move_to chat) for the calling member: the member's own room and
// person, the new chat's keys and session. Same id + same body -> 200 with the same request.
func (a *API) openMoveRequest(ctx context.Context, tx pgx.Tx, c *Caller, q *claimMove, session string, reqHash []byte) (int, error) {
	var oldHash []byte
	err := tx.QueryRow(ctx, `select request_hash from join_requests where id = $1`, q.ID).Scan(&oldHash)
	if err == nil {
		if hex.EncodeToString(oldHash) == hex.EncodeToString(reqHash) {
			return 200, nil
		}
		return 0, httpx.E(409, "id_conflict", "A different request already used this id.")
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, err
	}
	if err := ratelimit.Hit(ctx, tx, ratelimit.JoinPerKey, c.KeyHex); err != nil {
		return 0, err
	}
	ed, _ := hex.DecodeString(q.Ed)
	x, _ := hex.DecodeString(q.X)
	var used bool
	if err := tx.QueryRow(ctx, `select exists(select 1 from members where ed25519_pk = $1 and removed_at is null)
		or exists(select 1 from join_requests where ed25519_pk = $1 and status = 'pending' and expires_at > now())`, ed).Scan(&used); err != nil {
		return 0, err
	}
	if used {
		return 0, httpx.E(409, "key_in_use", "This key is already in use. Make a new one.")
	}
	if _, err := tx.Exec(ctx, `update join_requests set status = 'expired', decided_at = now()
		where status = 'pending' and expires_at <= now() and (room_id = $1 or ed25519_pk = $2 or for_account_id = $3)`,
		c.M.RoomID, ed, c.M.AccountID); err != nil {
		return 0, err
	}
	// newest move request wins: an older pending move of this member is cancelled
	if _, err := tx.Exec(ctx, `update join_requests set status = 'cancelled', decided_at = now()
		where member_id = $1 and status = 'pending'`, c.M.ID); err != nil {
		return 0, err
	}
	for attempt := 0; ; attempt++ {
		code := wire.RandCode(6)
		sp, err := tx.Begin(ctx)
		if err != nil {
			return 0, err
		}
		_, err = sp.Exec(ctx, `insert into join_requests (id, kind, room_id, invite_id, for_account_id, member_id, name, job, app,
			machine, folder, turn, session_id, ed25519_pk, x25519_pk, match_code, request_hash, expires_at, app_name, move_to)
			values ($1,'claim',$2,null,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now() + interval '15 minutes', $16, 'chat')`,
			q.ID, c.M.RoomID, c.M.AccountID, c.M.ID, c.M.Name, q.Job, q.App, q.Machine, q.Folder, q.Turn, session, ed, x, code, reqHash, q.AppName)
		if err == nil {
			return 201, sp.Commit(ctx)
		}
		_ = sp.Rollback(ctx)
		switch {
		case store.IsUniqueViolation(err, "join_requests_pending_code") && attempt < 20:
			continue
		case store.IsUniqueViolation(err, "join_requests_pending_key"):
			return 0, httpx.E(409, "key_in_use", "This key is already in use. Make a new one.")
		case store.IsUniqueViolation(err, "join_requests_pkey"):
			return 0, httpx.E(409, "id_conflict", "A different request already used this id.")
		}
		return 0, err
	}
}

// PUT /api/v1/me/handover: note sealed to self (scope "self"), ≤ 8 KiB. Holder only.
func (a *API) putHandover(w http.ResponseWriter, r *http.Request, c *Caller) error {
	ctx := r.Context()
	if err := requireHolder(c); err != nil {
		return err
	}
	var b struct {
		Envelope json.RawMessage `json:"envelope"`
	}
	if err := httpx.DecodeStrict(c.Body, &b); err != nil {
		return err
	}
	if len(b.Envelope) > 8192 {
		return httpx.E(413, "too_large", "The handover note is too large (8 KiB max).")
	}
	env, err := envelope.Parse(b.Envelope)
	if err != nil {
		return err
	}
	if err := env.VerifySig(c.M.Ed); err != nil {
		return err
	}
	h := env.Header
	fp := c.M.FP()
	if h.Scope != "self" || h.From != c.M.ID || h.To != c.M.ID || h.Room != c.M.RoomID || h.FromFP != fp || h.ToFP != fp || h.InReplyTo != nil {
		return httpx.BadRequest("A handover note must be sealed to this member itself (scope self, from = to = you).")
	}
	tag, err := a.St.Pool.Exec(ctx, `update members set handover_env = $2 where id = $1 and removed_at is null
		and (holder_session is null or holder_session = $3)`, c.M.ID, string(b.Envelope), c.Session)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return notHolder(c.M.HolderEpoch)
	}
	httpx.WriteJSON(w, 200, map[string]any{"ok": true})
	return nil
}

// PUT /api/v1/me/card: unsigned display fields.
func (a *API) putCard(w http.ResponseWriter, r *http.Request, c *Caller) error {
	ctx := r.Context()
	var b struct {
		Job     *string `json:"job"`
		Folder  *string `json:"folder"`
		Machine *string `json:"machine"`
		// Label: the member's own words about its availability (≤ 60, one line; "" clears it). Shown next to the
		// computed label, never instead of it (SPEC §6.9).
		Label *string `json:"label"`
	}
	if err := httpx.DecodeStrict(c.Body, &b); err != nil {
		return err
	}
	if b.Job == nil && b.Folder == nil && b.Machine == nil && b.Label == nil {
		return httpx.BadRequest("Send at least one of job, folder, machine, label.")
	}
	var label *string
	clearLabel := false
	if b.Label != nil {
		l := strings.TrimSpace(*b.Label)
		switch {
		case l == "":
			clearLabel = true
		case len([]rune(l)) > 60 || strings.ContainsAny(l, "\n\r\t") || strings.ContainsFunc(l, func(r rune) bool { return unicode.IsControl(r) || unicode.Is(unicode.Cf, r) }):
			return httpx.BadRequest("label is one line of at most 60 characters.")
		default:
			label = &l
		}
	}
	if (b.Job != nil && len([]rune(*b.Job)) > 140) || (b.Folder != nil && len([]rune(*b.Folder)) > 200) ||
		(b.Machine != nil && len([]rune(*b.Machine)) > 64) {
		return httpx.BadRequest("A field is too long (job 140, folder 200, machine 64).")
	}
	if _, err := a.St.Pool.Exec(ctx, `update members set job = coalesce($2, job), folder = coalesce($3, folder),
		machine = coalesce($4, machine), self_label = case when $6::bool then null else coalesce($5, self_label) end
		where id = $1`, c.M.ID, b.Job, b.Folder, b.Machine, label, clearLabel); err != nil {
		return err
	}
	v, err := a.memberSelf(ctx, a.St.Pool, c.M.ID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, v)
	return nil
}

// PUT /api/v1/me/turn. always_on verifies the URL synchronously and returns the push secret once.
func (a *API) putTurn(w http.ResponseWriter, r *http.Request, c *Caller) error {
	ctx := r.Context()
	var b struct {
		Turn string  `json:"turn"`
		URL  *string `json:"url"`
	}
	if err := httpx.DecodeStrict(c.Body, &b); err != nil {
		return err
	}
	switch b.Turn {
	case "wake", "listening", "on_turn":
		if b.URL != nil {
			return httpx.BadRequest("url is only for always_on.")
		}
		if _, err := a.St.Pool.Exec(ctx, `update members set turn = $2, push_url = null, push_secret = null, push_verified_at = null
			where id = $1`, c.M.ID, b.Turn); err != nil {
			return err
		}
		httpx.WriteJSON(w, 200, map[string]any{"turn": b.Turn})
		return nil
	case "always_on":
	default:
		return httpx.BadRequest("turn must be always_on, wake, listening or on_turn.")
	}
	if b.URL == nil || len(*b.URL) > 500 {
		return httpx.BadRequest("always_on needs a url (500 chars max).")
	}
	if _, err := a.Pusher.CheckURL(ctx, *b.URL); err != nil {
		if errors.Is(err, push.ErrBlocked) {
			return httpx.E(422, "push_url_blocked", "That URL isn't allowed (https only, public addresses only).")
		}
		return httpx.E(422, "push_verify_failed", "bot-link couldn't reach that URL.")
	}
	secret := wire.RandBytes(32)
	challenge := hex.EncodeToString(wire.RandBytes(16))
	if err := a.Pusher.Verify(ctx, *b.URL, c.M.ID, secret, "verify-"+wire.NewV7().String(), challenge); err != nil {
		if errors.Is(err, push.ErrBlocked) {
			return httpx.E(422, "push_url_blocked", "That URL isn't allowed (https only, public addresses only).")
		}
		return httpx.E(422, "push_verify_failed", "The URL didn't answer the check with the same challenge.")
	}
	if _, err := a.St.Pool.Exec(ctx, `update members set turn = 'always_on', push_url = $2, push_secret = $3, push_verified_at = now()
		where id = $1 and removed_at is null`, c.M.ID, *b.URL, secret); err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"turn": "always_on", "push_secret": hex.EncodeToString(secret)})
	return nil
}

// POST /api/v1/me/ask-human: content-free attention item (10/hour).
func (a *API) postAskHuman(w http.ResponseWriter, r *http.Request, c *Caller) error {
	ctx := r.Context()
	var b struct {
		Reason string `json:"reason"`
	}
	if err := httpx.DecodeStrict(c.Body, &b); err != nil {
		return err
	}
	kind := map[string]string{"needs_ok": "needs_you", "cannot_wake": "cannot_wake"}[b.Reason]
	if kind == "" {
		return httpx.BadRequest("reason must be needs_ok or cannot_wake.")
	}
	err := a.St.Tx(ctx, func(tx pgx.Tx) error {
		if err := ratelimit.Hit(ctx, tx, ratelimit.AskHuman, c.M.ID); err != nil {
			return err
		}
		room := c.M.RoomID
		return store.UpsertAttention(ctx, tx, c.M.AccountID, &room, kind, c.M.ID, map[string]any{"reason": b.Reason})
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"ok": true})
	return nil
}

func itoa(n int) string { return strconv.Itoa(n) }

// POST /api/v1/me/selftest {id, envelope}: a message from this member to itself (scope "self", sealed to its own key,
// SPEC §6.4a). It takes the real path (queued → wait/wake → lease → shown) so the chat can prove it sees messages
// while idle before it promises that to its human. Not a send: no rate limit of sends, never in the room's activity.
// 10 per hour per member. Holder not required (a listener or watch may be the one that sends it).
func (a *API) postSelftest(w http.ResponseWriter, r *http.Request, c *Caller) error {
	ctx := r.Context()
	var b struct {
		ID       string          `json:"id"`
		Envelope json.RawMessage `json:"envelope"`
		// DelayS (r3): the wake test is held back this many seconds (0..120) so the joining chat's turn can end
		// first; until then the copy is invisible to lease, wait and count (deliveries.not_before).
		DelayS *int `json:"delay_s"`
	}
	if err := httpx.DecodeStrict(c.Body, &b); err != nil {
		return err
	}
	if !wire.IsUUID(b.ID) {
		return httpx.BadRequest("id must be a lowercase uuid.")
	}
	delay := 0
	if b.DelayS != nil {
		delay = *b.DelayS
	}
	if delay < 0 || delay > 120 {
		return httpx.BadRequest("delay_s must be 0..120.")
	}
	if len(b.Envelope) > 8192 {
		return httpx.E(413, "too_large", "The self-test is too large (8 KiB max).")
	}
	env, err := envelope.Parse(b.Envelope)
	if err != nil {
		return err
	}
	if err := env.VerifySig(c.M.Ed); err != nil {
		return err
	}
	h := env.Header
	fp := c.M.FP()
	if h.ID != b.ID || h.Scope != "self" || h.From != c.M.ID || h.To != c.M.ID || h.Room != c.M.RoomID || h.FromFP != fp || h.ToFP != fp || h.InReplyTo != nil {
		return httpx.BadRequest("A self-test must be sealed to this member itself (scope self, from = to = you, same id).")
	}
	reqHash := wire.SHA256(c.Body)
	status := 201
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		dup, _, err := checkExisting(ctx, tx, b.ID, c.M.ID, reqHash)
		if err != nil || dup {
			if dup {
				status = 200
			}
			return err
		}
		if err := ratelimit.Hit(ctx, tx, ratelimit.Selftest, c.M.ID); err != nil {
			return err
		}
		var keyEpoch int
		if err := tx.QueryRow(ctx, `select key_epoch from members where id = $1 and removed_at is null for share`, c.M.ID).Scan(&keyEpoch); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return gone()
			}
			return err
		}
		if _, err := tx.Exec(ctx, `insert into messages (id, room_id, from_member, scope, to_member, request_hash, recipients, expires_at)
			values ($1, $2, $3, 'self', $3, $4, 1, now() + interval '1 day')`, b.ID, c.M.RoomID, c.M.ID, reqHash); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `insert into deliveries (message_id, member_id, key_epoch, envelope, expires_at, not_before)
			values ($1, $2, $3, $4, now() + interval '1 day', case when $5::int > 0 then now() + make_interval(secs => $5::int) end)`,
			b.ID, c.M.ID, keyEpoch, string(env.Raw), delay)
		return err
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, status, map[string]any{"id": b.ID, "duplicate": status == 200})
	return nil
}

// GET /api/v1/me/selftest/{id}: where a self-test is (waiting | shown | stuck | expired) and whether this member's
// chat has been seen reading messages a wake brought (SPEC §6.9).
func (a *API) getSelftest(w http.ResponseWriter, r *http.Request, c *Caller) error {
	id := r.PathValue("id")
	if !wire.IsUUID(id) {
		return httpx.NotFound()
	}
	var state string
	var shownAt *time.Time
	var wakes int
	err := a.St.Pool.QueryRow(r.Context(), `select d.state, d.shown_at, d.wakes from deliveries d join messages m on m.id = d.message_id
		where d.member_id = $1 and d.message_id = $2 and m.scope = 'self'`, c.M.ID, id).Scan(&state, &shownAt, &wakes)
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	var verified *time.Time
	if err := a.St.Pool.QueryRow(r.Context(), `select wake_verified_at from members where id = $1`, c.M.ID).Scan(&verified); err != nil {
		return err
	}
	if state == "queued" {
		state = "waiting"
	}
	httpx.WriteJSON(w, 200, map[string]any{"id": id, "state": state, "shown_at": shownAt, "wakes": wakes, "wake_verified_at": verified})
	return nil
}

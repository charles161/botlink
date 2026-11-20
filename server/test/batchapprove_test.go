package test

// Approving several waiting chats of one room in one step (SPEC §6.4 step 7a, docs/protocol/join-and-approval.md §4a).
// The person ticks up to 5 waiting chats on the room's list, each beside its own code; one human check, bound by the
// server to exactly that room and that set of request ids, covers them; the browser signs one member_add per chat as a
// chain at head+1 … head+n. One transaction, all or nothing. The single approval stays as it is.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/roster"
	"github.com/charles161/botlink/server/internal/wire"
)

// waitingChats: n chats join room with p's chat invite and wait.
func waitingChats(t *testing.T, c *Copy, p *Person, room *Room, prefix string, n int) []*Agent {
	t.Helper()
	out := make([]*Agent, n)
	for i := range out {
		a := NewAgentKeys(t, fmt.Sprintf("%s%d", prefix, i+1))
		if r := a.Join(c, p.Invite(room)); r.Status != 201 {
			t.Fatalf("join %s: %s", a.Name, r)
		}
		out[i] = a
	}
	return out
}

func reqIDs(as ...*Agent) []string {
	ids := make([]string, len(as))
	for i, a := range as {
		ids[i] = a.ReqID
	}
	return ids
}

// batchCheck asks for the human check of a batch: action approve_joins, the room, the ticked request ids.
func (p *Person) batchCheck(roomID string, ids ...string) *Resp {
	p.t.Helper()
	return p.Do("POST", "/app/v1/human-check", map[string]any{"action": "approve_joins", "target_id": roomID, "targets": ids})
}

func (p *Person) mustBatchCheck(roomID string, ids ...string) string {
	p.t.Helper()
	r := p.batchCheck(roomID, ids...)
	if r.Status != 200 || !wire.IsUUID(r.Str("id")) {
		p.t.Fatalf("batch human check: %s", r)
	}
	return r.Str("id")
}

// cardOf is the join request reqID as owner's dashboard shows it (needs-you).
func cardOf(t *testing.T, owner *Person, reqID string) map[string]any {
	t.Helper()
	for _, j := range owner.Do("GET", "/app/v1/needs-you", nil).J["join_requests"].([]any) {
		if j.(map[string]any)["id"] == reqID {
			return j.(map[string]any)
		}
	}
	t.Fatalf("request %s not in %s's needs-you", reqID, owner.Name)
	return nil
}

// batchItems: p's browser signs one member_add per card, a chain from the server's head in the order given.
func (p *Person) batchItems(room *Room, cards ...map[string]any) []map[string]any {
	p.t.Helper()
	p.Sync(room)
	items := make([]map[string]any, len(cards))
	for i, card := range cards {
		e := room.Log.Append("member_add", p.Dev, map[string]any{"member": card["member_id"], "account": p.AccountID, "name": card["name"],
			"app": card["app"], "ed": card["ed25519_pk"], "x": card["x25519_pk"]})
		items[i] = map[string]any{"id": card["id"], "roster_entry": e}
	}
	return items
}

func (p *Person) approveBatch(roomID, hc string, items []map[string]any) *Resp {
	p.t.Helper()
	return p.Do("POST", "/app/v1/rooms/"+roomID+"/join-requests/approve", map[string]any{"human_check": map[string]any{"id": hc, "stub": true}, "items": items})
}

// cardsOf: the cards of agents' requests from owner's needs-you.
func cardsOf(t *testing.T, owner *Person, as ...*Agent) []map[string]any {
	t.Helper()
	out := make([]map[string]any, len(as))
	for i, a := range as {
		out[i] = cardOf(t, owner, a.ReqID)
	}
	return out
}

// tickAndApprove: one check for exactly these chats, one request.
func (p *Person) tickAndApprove(t *testing.T, room *Room, as ...*Agent) *Resp {
	t.Helper()
	hc := p.mustBatchCheck(room.ID, reqIDs(as...)...)
	return p.approveBatch(room.ID, hc, p.batchItems(room, cardsOf(t, p, as...)...))
}

func usedChecks(t *testing.T, c *Copy) int {
	return count(t, c, `select count(*) from human_checks where used_at is not null`)
}

func requestStatus(t *testing.T, c *Copy, id string) string {
	t.Helper()
	var s string
	if err := c.Pool.QueryRow(t.Context(), `select status from join_requests where id = $1`, id).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

func activeMembers(t *testing.T, c *Copy, roomID string) int {
	return count(t, c, `select count(*) from members where room_id = $1 and removed_at is null`, roomID)
}

// rosterValid: the room's stored roster replays from genesis, adds each member once, and adds exactly the members made.
func rosterValid(t *testing.T, p *Person, c *Copy, room *Room) {
	t.Helper()
	r := p.Do("GET", "/app/v1/rooms/"+room.ID+"/roster", nil)
	var ws []roster.Wire
	if err := json.Unmarshal(mustJSON(r.J["entries"]), &ws); err != nil {
		t.Fatal(err)
	}
	st, err := roster.Replay(room.ID, ws)
	if err != nil {
		t.Fatalf("the roster no longer verifies: %v", err)
	}
	// every member ever added (the race test retires members with SQL between rounds, outside the roster)
	if got, want := len(st.Members), count(t, c, `select count(*) from members where room_id = $1`, room.ID); got != want {
		t.Fatalf("roster added %d members, members table has %d", got, want)
	}
	if dup := count(t, c, `select count(*) from (select member_id from (select (convert_from(entry, 'UTF8')::jsonb)->>'member' as member_id
		from roster_entries where room_id = $1 and op = 'member_add') x group by member_id having count(*) > 1) d`, room.ID); dup != 0 {
		t.Fatalf("%d member(s) added twice to the roster", dup)
	}
}

func batchItemsOf(r *Resp) map[string]string {
	out := map[string]string{}
	d, _ := r.J["error"].(map[string]any)["details"].(map[string]any)
	items, _ := d["items"].([]any)
	for _, it := range items {
		m := it.(map[string]any)
		out[m["id"].(string)] = m["reason"].(string)
	}
	return out
}

func detailID(r *Resp) string {
	e, _ := r.J["error"].(map[string]any)
	d, _ := e["details"].(map[string]any)
	s, _ := d["id"].(string)
	return s
}

// Three waiting chats approved in one step: all in, in the order ticked, one human check used, three approvals
// counted, each chat's wait says approved (an open wait wakes), the roster verifies.
func TestBatchApproveThree(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("batch")
	as := waitingChats(t, c, adam, room, "chat", 3)
	done := make(chan *Resp, 1)
	go func() {
		done <- as[1].Do(c, "POST", "/api/v1/join-requests/"+as[1].ReqID+"/wait", map[string]any{"wait_s": 20})
	}()
	ids := reqIDs(as[2], as[0], as[1]) // the order ticked, not the order asked
	hc := adam.mustBatchCheck(room.ID, ids...)
	items := adam.batchItems(room, cardsOf(t, adam, as[2], as[0], as[1])...)
	r := adam.approveBatch(room.ID, hc, items)
	if r.Status != 200 {
		t.Fatalf("batch: %s", r)
	}
	got, _ := r.J["approved"].([]any)
	if len(got) != 3 || got[0] != ids[0] || got[1] != ids[1] || got[2] != ids[2] {
		t.Fatalf("approved list: %s", r)
	}
	if w := <-done; w.Str("status") != "approved" {
		t.Fatalf("an open wait was not woken: %s", w)
	}
	for _, a := range as {
		w := a.Do(c, "POST", "/api/v1/join-requests/"+a.ReqID+"/wait", map[string]any{"wait_s": 0})
		if w.Str("status") != "approved" || w.Str("approver_account") != adam.AccountID {
			t.Fatalf("%s wait: %s", a.Name, w)
		}
		a.ID, a.Room = w.Str("member_id"), room.ID
		if me := a.Do(c, "GET", "/api/v1/me", nil); me.Status != 200 || me.Str("holder_session") != a.Session {
			t.Fatalf("%s me: %s", a.Name, me)
		}
	}
	if n := activeMembers(t, c, room.ID); n != 3 {
		t.Fatalf("members: %d", n)
	}
	if n := usedChecks(t, c); n != 1 {
		t.Fatalf("human checks used: %d, want exactly 1", n)
	}
	if n := count(t, c, `select coalesce(sum(count), 0)::int from rate_counters where bucket like 'approve:a:' || $1 || ':%'`, adam.AccountID); n != 3 {
		t.Fatalf("approvals counted: %d, want 3 (a batch counts as n approvals)", n)
	}
	// the chain is in the order ticked: seq 1 = as[2], 2 = as[0], 3 = as[1]
	for i, a := range []*Agent{as[2], as[0], as[1]} {
		if n := count(t, c, `select count(*) from roster_entries where room_id = $1 and seq = $2 and op = 'member_add'
			and (convert_from(entry, 'UTF8')::jsonb)->>'member' = $3`, room.ID, i+1, a.ID); n != 1 {
			t.Fatalf("seq %d is not %s's member_add", i+1, a.Name)
		}
	}
	rosterValid(t, adam, c, room)
	// each chat verifies the roster from genesis and finds its own member_add (what the client's self-check reads)
	for _, a := range as {
		ro := a.Do(c, "GET", "/api/v1/me/roster", nil)
		var ws []roster.Wire
		_ = json.Unmarshal(mustJSON(ro.J["entries"]), &ws)
		st, err := roster.Replay(room.ID, ws)
		if err != nil || st.Members[a.ID] == nil || st.Members[a.ID].Ed != a.Key.Hex() {
			t.Fatalf("%s self-check: %v", a.Name, err)
		}
	}
	if ny := adam.Do("GET", "/app/v1/needs-you", nil); len(ny.J["join_requests"].([]any)) != 0 {
		t.Fatalf("still waiting: %s", ny)
	}
	// the same request again: its check is used up (as for a single approval: 403); with a new check for the same set,
	// every item is already decided and nothing changes
	if r := adam.approveBatch(room.ID, hc, items); r.Status != 403 || r.Code() != "human_check_failed" {
		t.Fatalf("repeat with the used check: %s", r)
	}
	hc2 := adam.mustBatchCheck(room.ID, ids...)
	r = adam.approveBatch(room.ID, hc2, adam.batchItems(room, cardsLike(items)...))
	if r.Status != 409 || r.Code() != "batch_changed" {
		t.Fatalf("repeat with a new check: %s", r)
	}
	for _, id := range ids {
		if batchItemsOf(r)[id] != "already_decided" {
			t.Fatalf("repeat: %s not already_decided: %s", id, r)
		}
	}
	if n := activeMembers(t, c, room.ID); n != 3 {
		t.Fatalf("members after the repeat: %d", n)
	}
}

// cardsLike rebuilds minimal cards from items (for a repeat after the requests left needs-you).
func cardsLike(items []map[string]any) []map[string]any {
	out := make([]map[string]any, len(items))
	for i, it := range items {
		w := it["roster_entry"].(roster.Wire)
		raw, _ := wire.DecodeB64URL(w.Entry)
		var e map[string]any
		_ = json.Unmarshal(raw, &e)
		out[i] = map[string]any{"id": it["id"], "member_id": e["member"], "name": e["name"], "app": e["app"], "ed25519_pk": e["ed"], "x25519_pk": e["x"]}
	}
	return out
}

// Four wait, two are ticked: exactly those two are in; the other two still wait, untouched.
func TestBatchApproveOnlyTheTicked(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("subset")
	as := waitingChats(t, c, adam, room, "chat", 4)
	if r := adam.tickAndApprove(t, room, as[0], as[2]); r.Status != 200 {
		t.Fatalf("batch: %s", r)
	}
	for i, a := range as {
		want := map[bool]string{true: "approved", false: "pending"}[i == 0 || i == 2]
		if s := requestStatus(t, c, a.ReqID); s != want {
			t.Fatalf("%s: %s, want %s", a.Name, s, want)
		}
	}
	if n := activeMembers(t, c, room.ID); n != 2 {
		t.Fatalf("members: %d", n)
	}
	// the two left can still be approved, one by one as before or together
	if r := adam.Approve(room, as[1]); r.Status != 200 {
		t.Fatalf("single approval after a batch: %s", r)
	}
	if r := adam.tickAndApprove(t, room, as[3]); r.Status != 200 {
		t.Fatalf("a batch of one: %s", r)
	}
	rosterValid(t, adam, c, room)
}

// One of the ticked was decided or ran out meanwhile: nothing is approved, the answer names each, the check is not
// used. It stays bound to the set it was issued for: it cannot approve the smaller, corrected set; a new check can.
func TestBatchApproveChangedMeanwhile(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("changed")
	as := waitingChats(t, c, adam, room, "chat", 4)
	cards := cardsOf(t, adam, as...)
	hc := adam.mustBatchCheck(room.ID, reqIDs(as...)...)
	if r := adam.Do("POST", "/app/v1/join-requests/"+as[2].ReqID+"/reject", nil); r.Status != 200 {
		t.Fatal(r)
	}
	exec(t, c, `update join_requests set expires_at = now() - interval '1 second' where id = $1`, as[3].ReqID)
	r := adam.approveBatch(room.ID, hc, adam.batchItems(room, cards...))
	if r.Status != 409 || r.Code() != "batch_changed" {
		t.Fatalf("batch with a rejected and an expired item: %s", r)
	}
	if got := batchItemsOf(r); len(got) != 2 || got[as[2].ReqID] != "already_decided" || got[as[3].ReqID] != "expired" {
		t.Fatalf("details.items: %s", r)
	}
	if n := activeMembers(t, c, room.ID); n != 0 {
		t.Fatalf("members: %d", n)
	}
	for _, a := range as[:2] {
		if s := requestStatus(t, c, a.ReqID); s != "pending" {
			t.Fatalf("%s: %s", a.Name, s)
		}
	}
	if n := usedChecks(t, c); n != 1 {
		t.Fatalf("a batch_changed answer must spend its check (%d used): the page asks a new one, and a passed check must not wait for its set to become approvable", n)
	}
	// the corrected, smaller set with the old check: refused
	if r := adam.approveBatch(room.ID, hc, adam.batchItems(room, cards[:2]...)); r.Status != 403 || r.Code() != "human_check_failed" {
		t.Fatalf("old check for the smaller set: %s", r)
	}
	// an unknown id among the ticked is not_found, and nothing is approved
	ghost := wire.NewV7().String()
	hcg := adam.mustBatchCheck(room.ID, as[0].ReqID, ghost)
	ghostCard := map[string]any{"id": ghost, "member_id": wire.NewV7().String(), "name": "ghost", "app": "claude-code", "ed25519_pk": strings.Repeat("ab", 32), "x25519_pk": strings.Repeat("cd", 32)}
	if r := adam.approveBatch(room.ID, hcg, adam.batchItems(room, cards[0], ghostCard)); r.Code() != "batch_changed" || batchItemsOf(r)[ghost] != "not_found" || len(batchItemsOf(r)) != 1 {
		t.Fatalf("unknown id: %s", r)
	}
	// a new check for the corrected set
	if r := adam.tickAndApprove(t, room, as[0], as[1]); r.Status != 200 {
		t.Fatalf("corrected set with a new check: %s", r)
	}
	if n := activeMembers(t, c, room.ID); n != 2 {
		t.Fatalf("members: %d", n)
	}
}

// A check is bound to its action, its room and its exact set of ids (in any order): not a superset, not a subset,
// not the same ids in another room, not a single approval; a single approval's check does not serve a batch.
func TestBatchCheckBinding(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("bound")
	other := adam.CreateRoom("other")
	as := waitingChats(t, c, adam, room, "chat", 3)
	cards := cardsOf(t, adam, as...)
	hcAB := adam.mustBatchCheck(room.ID, as[0].ReqID, as[1].ReqID)
	refused := func(what string, r *Resp) {
		t.Helper()
		if r.Status != 403 || r.Code() != "human_check_failed" {
			t.Fatalf("%s: %s", what, r)
		}
	}
	refused("{a,b} check for {a,b,c}", adam.approveBatch(room.ID, hcAB, adam.batchItems(room, cards...)))
	refused("{a,b} check for {a}", adam.approveBatch(room.ID, hcAB, adam.batchItems(room, cards[0])))
	hcOther := adam.mustBatchCheck(other.ID, as[0].ReqID, as[1].ReqID)
	refused("{a,b} of another room", adam.approveBatch(room.ID, hcOther, adam.batchItems(room, cards[0], cards[1])))
	refused("{a,b} check sent to another room", adam.approveBatch(other.ID, hcAB, adam.batchItems(room, cards[0], cards[1])))
	single := adam.Check("approve_join", as[0].ReqID)
	refused("a single approval's check for a batch", adam.approveBatch(room.ID, single, adam.batchItems(room, cards[0])))
	hcA := adam.mustBatchCheck(room.ID, as[0].ReqID)
	adam.Sync(room)
	e := room.Log.Build("member_add", adam.Dev, map[string]any{"member": cards[0]["member_id"], "account": adam.AccountID, "name": cards[0]["name"],
		"app": cards[0]["app"], "ed": cards[0]["ed25519_pk"], "x": cards[0]["x25519_pk"]})
	refused("a batch check for a single approval", adam.Do("POST", "/app/v1/join-requests/"+as[0].ReqID+"/approve",
		map[string]any{"human_check": map[string]any{"id": hcA, "stub": true}, "roster_entry": e}))
	confirmCheck := adam.Check("confirm_room", room.ID)
	refused("a room confirm's check for a batch", adam.approveBatch(room.ID, confirmCheck, adam.batchItems(room, cards[0])))
	// another person's check for the same set (the check is bound to the session that asked it)
	bea := NewPerson(t, c, "Bea")
	hcBea := bea.mustBatchCheck(room.ID, as[0].ReqID, as[1].ReqID)
	refused("another person's check", adam.approveBatch(room.ID, hcBea, adam.batchItems(room, cards[0], cards[1])))
	if n := usedChecks(t, c); n != 0 || activeMembers(t, c, room.ID) != 0 {
		t.Fatalf("a refused check was used (%d) or a chat let in", n)
	}
	// the set is a set: {b,a} is {a,b}; the check was never used by the refusals above
	if r := adam.approveBatch(room.ID, hcAB, adam.batchItems(room, cards[1], cards[0])); r.Status != 200 {
		t.Fatalf("{a,b} check for {b,a}: %s", r)
	}
	// once used, never again
	refused("the used check", adam.approveBatch(room.ID, hcAB, adam.batchItems(room, cards[2])))
}

// POST /app/v1/human-check for approve_joins: the room and 1 to 5 distinct request ids, nothing else; the other
// actions take no targets.
func TestBatchCheckRequestRules(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("rules")
	id := func() string { return wire.NewV7().String() }
	a, b := id(), id()
	for what, body := range map[string]map[string]any{
		"no targets":         {"action": "approve_joins", "target_id": room.ID},
		"empty targets":      {"action": "approve_joins", "target_id": room.ID, "targets": []string{}},
		"six targets":        {"action": "approve_joins", "target_id": room.ID, "targets": []string{id(), id(), id(), id(), id(), id()}},
		"duplicate targets":  {"action": "approve_joins", "target_id": room.ID, "targets": []string{a, b, a}},
		"same id, two cases": {"action": "approve_joins", "target_id": room.ID, "targets": []string{a, strings.ToUpper(a)}},
		"a non-uuid target":  {"action": "approve_joins", "target_id": room.ID, "targets": []string{a, "nope"}},
		"no room":            {"action": "approve_joins", "targets": []string{a}},
		"targets elsewhere":  {"action": "approve_join", "target_id": a, "targets": []string{a}},
		"targets on confirm": {"action": "confirm_room", "target_id": a, "targets": []string{a}},
	} {
		if r := adam.Do("POST", "/app/v1/human-check", body); r.Status != 400 {
			t.Errorf("%s: %s", what, r)
		}
	}
	if n := count(t, c, `select count(*) from human_checks`); n != 0 {
		t.Fatalf("%d checks made by refused requests", n)
	}
	five := []string{id(), id(), id(), id(), id()}
	if r := adam.batchCheck(room.ID, five...); r.Status != 200 {
		t.Fatalf("five targets: %s", r)
	}
	if n := count(t, c, `select count(*) from human_checks where action = 'approve_joins' and target_id = $1 and length(targets_digest) = 32`, room.ID); n != 1 {
		t.Fatalf("the set's digest is not stored with the check")
	}
}

// What a batch request must be, before anything is looked up or used: 1 to 5 items, distinct uuids, each a join
// request of this room that waits for the caller. A claim (a move) is not batchable. Another person's request is
// not found, as on the single approval.
func TestBatchApproveRefusals(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("refuse")
	other := adam.CreateRoom("elsewhere")
	as := waitingChats(t, c, adam, room, "chat", 2)
	cards := cardsOf(t, adam, as...)
	bad := func(what string, want int, code string, r *Resp) {
		t.Helper()
		if r.Status != want || (code != "" && r.Code() != code) {
			t.Fatalf("%s: %s", what, r)
		}
	}
	hc := adam.mustBatchCheck(room.ID, reqIDs(as...)...)
	items := adam.batchItems(room, cards...)
	bad("no items", 400, "bad_request", adam.approveBatch(room.ID, hc, []map[string]any{}))
	six := append(append([]map[string]any{}, items...), items[0], items[1], items[0], items[1])
	bad("six items", 400, "bad_request", adam.approveBatch(room.ID, hc, six))
	bad("a duplicate id", 400, "bad_request", adam.approveBatch(room.ID, hc, []map[string]any{items[0], items[0]}))
	bad("a non-uuid id", 400, "bad_request", adam.approveBatch(room.ID, hc, []map[string]any{{"id": "x", "roster_entry": items[0]["roster_entry"]}}))
	bad("no roster entry", 400, "bad_request", adam.approveBatch(room.ID, hc, []map[string]any{{"id": as[0].ReqID}}))
	bad("a non-uuid room", 404, "", adam.Do("POST", "/app/v1/rooms/nope/join-requests/approve", map[string]any{"human_check": map[string]any{"id": hc, "stub": true}, "items": items}))
	// a request of this person in ANOTHER room: refused, nothing used
	far := waitingChats(t, c, adam, other, "far", 1)[0]
	hcFar := adam.mustBatchCheck(room.ID, as[0].ReqID, far.ReqID)
	bad("a request of another room", 400, "bad_request", adam.approveBatch(room.ID, hcFar, adam.batchItems(room, cards[0], cardOf(t, adam, far.ReqID))))
	// a claim (move to a new computer) of a member of this room: not batchable
	mover := adam.Member(c, room, "mover")
	nd := NewAgentKeys(t, "mover")
	nd.ReqID = wire.NewV7().String()
	if r := nd.Do(c, "POST", "/api/v1/join-requests", map[string]any{"id": nd.ReqID, "kind": "claim", "invite": adam.Invite(room), "name": "mover",
		"app": "codex", "machine": "laptop-2", "folder": "~/acme", "turn": "wake", "session_id": nd.Session,
		"ed25519_pk": nd.Key.Hex(), "x25519_pk": hexs(nd.X)}); r.Status != 201 {
		t.Fatal(r)
	}
	hcClaim := adam.mustBatchCheck(room.ID, as[0].ReqID, nd.ReqID)
	adam.Sync(room)
	claimItem := map[string]any{"id": nd.ReqID, "roster_entry": room.Log.Build("member_rekey", adam.Dev, map[string]any{"member": mover.ID, "ed": nd.Key.Hex(), "x": hexs(nd.X)})}
	bad("a claim", 400, "bad_request", adam.approveBatch(room.ID, hcClaim, []map[string]any{adam.batchItems(room, cards[0])[0], claimItem}))
	// a chat of another person's invite in the same room: not the caller's request → not_found, nothing approved
	bea := NewPerson(t, c, "Bea")
	adam.addPerson(room, bea)
	before := usedChecks(t, c) // the mover's single approval and Bea's person approval
	beas := waitingChats(t, c, bea, room, "bea", 1)[0]
	hcBea := adam.mustBatchCheck(room.ID, as[0].ReqID, beas.ReqID)
	r := adam.approveBatch(room.ID, hcBea, adam.batchItems(room, cards[0], cardOf(t, bea, beas.ReqID)))
	bad("another person's request", 409, "batch_changed", r)
	if got := batchItemsOf(r); len(got) != 1 || got[beas.ReqID] != "not_found" {
		t.Fatalf("details: %s", r)
	}
	for _, id := range []string{as[0].ReqID, as[1].ReqID, far.ReqID, nd.ReqID, beas.ReqID} {
		if s := requestStatus(t, c, id); s != "pending" {
			t.Fatalf("%s: %s after refusals", id, s)
		}
	}
	if n := usedChecks(t, c); n != before+1 || before != 2 {
		t.Fatalf("checks used: %d (before %d); only the batch_changed answer spends its check, the 400s do not", n-before, before)
	}
	// the first check was never used: it still approves its set
	if r := adam.approveBatch(room.ID, hc, adam.batchItems(room, cards...)); r.Status != 200 {
		t.Fatalf("the unused check: %s", r)
	}
}

// addPerson: owner p brings q into the room as a person (person invite, accept, approve).
func (p *Person) addPerson(room *Room, q *Person) {
	p.t.Helper()
	pi := p.Do("POST", "/app/v1/rooms/"+room.ID+"/person-invites", map[string]any{"id": wire.NewV7().String()})
	if pi.Status != 201 {
		p.t.Fatal(pi)
	}
	code := pi.Str("url")[strings.LastIndex(pi.Str("url"), "/")+1:]
	acc := q.Do("POST", "/app/v1/person-invites/"+code+"/accept", map[string]any{"device_id": q.DevID})
	if acc.Status != 201 {
		p.t.Fatal(acc)
	}
	p.Sync(room)
	e := room.Log.Build("person_add", p.Dev, map[string]any{"account": q.AccountID, "name": q.Name, "device": q.Dev.Hex()})
	hc := p.Check("approve_person", acc.Str("id"))
	if r := p.Do("POST", "/app/v1/person-requests/"+acc.Str("id")+"/approve", map[string]any{"human_check": map[string]any{"id": hc, "stub": true}, "roster_entry": e}); r.Status != 200 {
		p.t.Fatal(r)
	}
	room.Log.Push(e)
}

// A person of the room who did not invite those chats cannot batch-approve them.
func TestBatchApproveOnlyTheInviter(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("inviter")
	bea := NewPerson(t, c, "Bea")
	adam.addPerson(room, bea)
	as := waitingChats(t, c, adam, room, "chat", 3)
	cards := cardsOf(t, adam, as...)
	hc := bea.mustBatchCheck(room.ID, reqIDs(as...)...)
	beaRoom := &Room{ID: room.ID, Name: room.Name, Log: room.Log}
	r := bea.approveBatch(room.ID, hc, bea.batchItems(beaRoom, cards...))
	if r.Status != 409 || r.Code() != "batch_changed" || len(batchItemsOf(r)) != 3 {
		t.Fatalf("bea approves adam's chats: %s", r)
	}
	for _, a := range as {
		if batchItemsOf(r)[a.ReqID] != "not_found" || requestStatus(t, c, a.ReqID) != "pending" {
			t.Fatalf("%s: %s", a.Name, r)
		}
	}
	if activeMembers(t, c, room.ID) != 0 || usedChecks(t, c) != 2 { // adam's approve_person, and Bea's spent check
		t.Fatal("something was approved, or Bea's check was not spent")
	}
}

// 19 members, three ticked: refused as a whole (room_full, naming the item that would be the 21st), nobody added, the
// check not used, the roster head unchanged.
func TestBatchApproveRoomFull(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("full")
	as := waitingChats(t, c, adam, room, "chat", 3)
	exec(t, c, `insert into members (id, room_id, account_id, name, app, turn, ed25519_pk, x25519_pk)
		select gen_random_uuid(), $1::uuid, $2::uuid, 'filler' || i, 'other', 'on_turn',
			decode(md5('e' || i || $1::text) || md5('f' || i || $1::text), 'hex'), decode(md5('x' || i || $1::text) || md5('y' || i || $1::text), 'hex')
		from generate_series(1, 19) i`, room.ID, adam.AccountID)
	head := count(t, c, `select roster_head_seq from rooms where id = $1`, room.ID)
	r := adam.tickAndApprove(t, room, as...)
	if r.Status != 409 || r.Code() != "room_full" || detailID(r) != as[1].ReqID {
		t.Fatalf("19 members + 3: %s", r)
	}
	if n := activeMembers(t, c, room.ID); n != 19 {
		t.Fatalf("members: %d", n)
	}
	if h := count(t, c, `select roster_head_seq from rooms where id = $1`, room.ID); h != head {
		t.Fatalf("roster head moved %d → %d", head, h)
	}
	for _, a := range as {
		if s := requestStatus(t, c, a.ReqID); s != "pending" {
			t.Fatalf("%s: %s", a.Name, s)
		}
	}
	if usedChecks(t, c) != 0 {
		t.Fatal("check used by a refused batch")
	}
	// two stand-ins leave: the same three fit, and the same check (rolled back with room_full) still approves them
	exec(t, c, `update members set removed_at = now() where room_id = $1 and name in ('filler1', 'filler2')`, room.ID)
	var check string // the one tickAndApprove asked
	if err := c.Pool.QueryRow(t.Context(), `select id::text from human_checks where action = 'approve_joins'`).Scan(&check); err != nil {
		t.Fatal(err)
	}
	if r := adam.approveBatch(room.ID, check, adam.batchItems(room, cardsOf(t, adam, as...)...)); r.Status != 200 {
		t.Fatalf("retry with the same check after room_full: %s", r)
	}
}

// Every rule of the single approval holds for each item (admitChat): an entry that does not match its request, a
// signer that is not the caller's browser, a stale head. Any failure rolls the whole batch back and names the item;
// the check stays usable (with its set) until it expires, so the browser re-signs and sends it again.
func TestBatchApproveItemRules(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("items")
	as := waitingChats(t, c, adam, room, "chat", 3)
	cards := cardsOf(t, adam, as...)
	hc := adam.mustBatchCheck(room.ID, reqIDs(as...)...)
	nothing := func(what string) {
		t.Helper()
		if activeMembers(t, c, room.ID) != 0 || usedChecks(t, c) != 0 || count(t, c, `select roster_head_seq from rooms where id = $1`, room.ID) != 0 {
			t.Fatalf("%s: something was kept", what)
		}
	}
	// item 2 signs the wrong name
	wrong := append([]map[string]any{}, cards...)
	w1 := map[string]any{}
	for k, v := range cards[1] {
		w1[k] = v
	}
	w1["name"] = "someone-else"
	wrong[1] = w1
	r := adam.approveBatch(room.ID, hc, adam.batchItems(room, wrong...))
	if r.Status != 400 || r.Code() != "roster_invalid" || detailID(r) != as[1].ReqID {
		t.Fatalf("mismatch in item 2: %s", r)
	}
	nothing("mismatch")
	// item 3 signed by a key that is not one of adam's browsers
	items := adam.batchItems(room, cards...)
	stranger := NewPerson(t, c, "Stranger")
	adam.Sync(room)
	room.Log.Push(items[0]["roster_entry"].(roster.Wire))
	room.Log.Push(items[1]["roster_entry"].(roster.Wire))
	items[2]["roster_entry"] = room.Log.Build("member_add", stranger.Dev, map[string]any{"member": cards[2]["member_id"], "account": adam.AccountID,
		"name": cards[2]["name"], "app": cards[2]["app"], "ed": cards[2]["ed25519_pk"], "x": cards[2]["x25519_pk"]})
	r = adam.approveBatch(room.ID, hc, items)
	if r.Status != 403 || r.Code() != "not_signer" || detailID(r) != as[2].ReqID {
		t.Fatalf("foreign signer in item 3: %s", r)
	}
	nothing("signer")
	// the chain does not start at the head (another approval landed first)
	stale := adam.batchItems(room, cards...)
	adam.Member(c, room, "first")
	r = adam.approveBatch(room.ID, hc, stale)
	if r.Status != 409 || r.Code() != "roster_conflict" || detailID(r) != as[0].ReqID {
		t.Fatalf("stale chain: %s", r)
	}
	if activeMembers(t, c, room.ID) != 1 || usedChecks(t, c) != 1 {
		t.Fatal("the stale batch kept something")
	}
	// re-signed at the new head, the same check goes through
	if r := adam.approveBatch(room.ID, hc, adam.batchItems(room, cards...)); r.Status != 200 {
		t.Fatalf("re-signed with the same check: %s", r)
	}
	rosterValid(t, adam, c, room)
}

// Rate limit: a batch counts as n approvals (60 an hour); one that would go over is refused whole.
func TestBatchApproveCountsEachApproval(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("rate")
	as := waitingChats(t, c, adam, room, "chat", 3)
	exec(t, c, `insert into rate_counters (bucket, window_start, count) values ('approve:a:' || $1 || ':1h0m0s', date_bin('3600 seconds'::interval, now(), timestamptz 'epoch'), 58)`, adam.AccountID)
	r := adam.tickAndApprove(t, room, as...)
	if r.Status != 429 {
		t.Fatalf("58 + 3 approvals in an hour: %s", r)
	}
	if activeMembers(t, c, room.ID) != 0 || usedChecks(t, c) != 0 {
		t.Fatal("a refused batch kept something")
	}
	if r := adam.tickAndApprove(t, room, as[0], as[1]); r.Status != 200 {
		t.Fatalf("58 + 2: %s", r)
	}
}

// Concurrency. The same batch twice at once (two copies, two checks): one goes through, the other is told every item
// is decided. A batch and a single approval of one of its items: no member twice, the roster stays a chain. Two
// batches with overlapping sets: one goes through.
func TestBatchApproveRaces(t *testing.T) {
	db := NewDB(t)
	ca := StartCopy(t, db, "A")
	cb := StartCopy(t, db, "B")
	adam := NewPerson(t, ca, "Adam")
	adamB := adam.On(cb)
	room := adam.CreateRoom("race")
	rounds := 8
	if testing.Short() {
		rounds = 3
	}
	clear := func() {
		exec(t, ca, `update members set removed_at = now() where room_id = $1 and removed_at is null`, room.ID)
		exec(t, ca, `delete from rate_counters`)
	}
	both := func(f, g func() *Resp) (*Resp, *Resp) {
		var wg sync.WaitGroup
		var x, y *Resp
		wg.Add(2)
		go func() { defer wg.Done(); x = f() }()
		go func() { defer wg.Done(); y = g() }()
		wg.Wait()
		return x, y
	}
	for i := 0; i < rounds; i++ {
		// 1. the same batch twice at once
		clear()
		as := waitingChats(t, ca, adam, room, fmt.Sprintf("s%d-", i), 3)
		cards := cardsOf(t, adam, as...)
		items := adam.batchItems(room, cards...)
		h1, h2 := adam.mustBatchCheck(room.ID, reqIDs(as...)...), adamB.mustBatchCheck(room.ID, reqIDs(as...)...)
		x, y := both(func() *Resp { return adam.approveBatch(room.ID, h1, items) }, func() *Resp { return adamB.approveBatch(room.ID, h2, items) })
		codes := []int{x.Status, y.Status}
		sort.Ints(codes)
		if codes[0] != 200 || codes[1] != 409 {
			t.Fatalf("round %d same batch twice: %s / %s", i, x, y)
		}
		loser := x
		if x.Status == 200 {
			loser = y
		}
		if loser.Code() != "batch_changed" && loser.Code() != "roster_conflict" {
			t.Fatalf("round %d loser: %s", i, loser)
		}
		if activeMembers(t, ca, room.ID) != 3 {
			t.Fatalf("round %d: %d members", i, activeMembers(t, ca, room.ID))
		}
		rosterValid(t, adam, ca, room)

		// 2. a batch {a,b,c} and a single approval of b
		clear()
		as = waitingChats(t, ca, adam, room, fmt.Sprintf("m%d-", i), 3)
		cards = cardsOf(t, adam, as...)
		items = adam.batchItems(room, cards...)
		adam.Sync(room)
		single := room.Log.Build("member_add", adam.Dev, map[string]any{"member": cards[1]["member_id"], "account": adam.AccountID, "name": cards[1]["name"],
			"app": cards[1]["app"], "ed": cards[1]["ed25519_pk"], "x": cards[1]["x25519_pk"]})
		hb, hs := adam.mustBatchCheck(room.ID, reqIDs(as...)...), adamB.Check("approve_join", as[1].ReqID)
		x, y = both(func() *Resp { return adam.approveBatch(room.ID, hb, items) }, func() *Resp {
			return adamB.Do("POST", "/app/v1/join-requests/"+as[1].ReqID+"/approve", map[string]any{"human_check": map[string]any{"id": hs, "stub": true}, "roster_entry": single})
		})
		t.Logf("round %d batch vs single: %d %s / %d %s", i, x.Status, x.Code(), y.Status, y.Code())
		n := activeMembers(t, ca, room.ID)
		switch {
		case x.Status == 200 && y.Status == 409 && (y.Code() == "already_decided" || y.Code() == "roster_conflict"):
			if n != 3 {
				t.Fatalf("round %d batch won, %d members", i, n)
			}
		case y.Status == 200 && x.Status == 409 && (x.Code() == "batch_changed" || x.Code() == "roster_conflict"):
			if n != 1 || requestStatus(t, ca, as[0].ReqID) != "pending" || requestStatus(t, ca, as[2].ReqID) != "pending" {
				t.Fatalf("round %d single won, %d members", i, n)
			}
		default:
			t.Fatalf("round %d batch vs single: %s / %s", i, x, y)
		}
		rosterValid(t, adam, ca, room)

		// 3. two batches with overlapping sets {a,b} and {b,c}
		clear()
		as = waitingChats(t, ca, adam, room, fmt.Sprintf("o%d-", i), 3)
		cards = cardsOf(t, adam, as...)
		i1 := adam.batchItems(room, cards[0], cards[1])
		i2 := adam.batchItems(room, cards[1], cards[2])
		hab, hbc := adam.mustBatchCheck(room.ID, as[0].ReqID, as[1].ReqID), adamB.mustBatchCheck(room.ID, as[1].ReqID, as[2].ReqID)
		x, y = both(func() *Resp { return adam.approveBatch(room.ID, hab, i1) }, func() *Resp { return adamB.approveBatch(room.ID, hbc, i2) })
		codes = []int{x.Status, y.Status}
		sort.Ints(codes)
		if codes[0] != 200 || codes[1] != 409 {
			t.Fatalf("round %d overlapping batches: %s / %s", i, x, y)
		}
		if activeMembers(t, ca, room.ID) != 2 {
			t.Fatalf("round %d overlapping: %d members", i, activeMembers(t, ca, room.ID))
		}
		rosterValid(t, adam, ca, room)
		// drop what still waits so the room stays under 10 pending
		exec(t, ca, `update join_requests set status = 'cancelled', decided_at = now() where room_id = $1 and status = 'pending'`, room.ID)
	}
}

// With the real human check: a batch asks the passkey every time (EveryTime), even right after one was used; Turnstile
// alone never approves a batch. One passkey answer covers the ticked set.
func TestBatchCheckAsksPasskeyEveryTime(t *testing.T) {
	turnstile := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		_ = json.NewEncoder(w).Encode(map[string]any{"success": r.Form.Get("response") == "XXXX.DUMMY.TOKEN.XXXX"})
	}))
	defer turnstile.Close()
	c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) {
		cfg.HumanCheck = "real"
		cfg.TurnstileSiteKey = "1x00000000000000000000AA"
		cfg.TurnstileSecret = "1x0000000000000000000000000000000AA"
		cfg.TurnstileVerifyURL = turnstile.URL
	})
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("uvbatch")
	good := "XXXX.DUMMY.TOKEN.XXXX"
	pass := newSoftAuth("localhost", c.URL)
	as := waitingChats(t, c, adam, room, "chat", 4)
	send := func(proof map[string]any, set ...*Agent) *Resp {
		return adam.Do("POST", "/app/v1/rooms/"+room.ID+"/join-requests/approve", map[string]any{"human_check": proof,
			"items": adam.batchItems(room, cardsOf(t, adam, set...)...)})
	}
	// first: the account's first passkey is set up in this step (a fresh sign-in)
	ch := adam.batchCheck(room.ID, reqIDs(as[0], as[1])...)
	if ch.Status != 200 || ch.J["webauthn"].(map[string]any)["step"] != "register" {
		t.Fatalf("first batch check: %s", ch)
	}
	if r := send(map[string]any{"id": ch.Str("id"), "turnstile_token": good}, as[0], as[1]); r.Code() != "human_check_failed" {
		t.Fatalf("batch on Turnstile and a fresh sign-in alone: %s", r)
	}
	ch = adam.batchCheck(room.ID, reqIDs(as[0], as[1])...)
	opts := ch.J["webauthn"].(map[string]any)["options"].(map[string]any)
	if r := send(map[string]any{"id": ch.Str("id"), "turnstile_token": good, "webauthn": pass.Register(opts)}, as[0], as[1]); r.Status != 200 {
		t.Fatalf("batch with a new passkey: %s", r)
	}
	// right after (uv fresh): the next batch asks the passkey again
	ch = adam.batchCheck(room.ID, reqIDs(as[2], as[3])...)
	if ch.J["webauthn"].(map[string]any)["step"] != "assert" {
		t.Fatalf("a batch right after a passkey answer must ask it again: %s", ch)
	}
	if r := send(map[string]any{"id": ch.Str("id"), "turnstile_token": good}, as[2], as[3]); r.Code() != "human_check_failed" {
		t.Fatalf("batch without a fresh passkey answer: %s", r)
	}
	ch = adam.batchCheck(room.ID, reqIDs(as[2], as[3])...)
	opts = ch.J["webauthn"].(map[string]any)["options"].(map[string]any)
	if r := send(map[string]any{"id": ch.Str("id"), "turnstile_token": good, "webauthn": pass.Assert(opts, []byte(adam.AccountID))}, as[2], as[3]); r.Status != 200 {
		t.Fatalf("batch with the passkey: %s", r)
	}
	if n := activeMembers(t, c, room.ID); n != 4 {
		t.Fatalf("members: %d", n)
	}
}

// A passed batch check is spent when the batch answers batch_changed. Security review of fix-next: a check for {own A,
// someone else's X} answered 409 (X not_found) and stayed passed; the caller took X over (readdress needs no check) and
// sent the same check again: 200, X approved with no new passkey answer.
func TestBatchCheckSpentWhenSetChanged(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("takeover")
	bea := NewPerson(t, c, "Bea")
	adam.addPerson(room, bea)
	a := waitingChats(t, c, adam, room, "own", 1)[0]
	x := waitingChats(t, c, bea, room, "theirs", 1)[0]
	xCard := cardOf(t, bea, x.ReqID)
	hc := adam.mustBatchCheck(room.ID, a.ReqID, x.ReqID)
	r := adam.approveBatch(room.ID, hc, adam.batchItems(room, cardOf(t, adam, a.ReqID), xCard))
	if r.Code() != "batch_changed" || batchItemsOf(r)[x.ReqID] != "not_found" {
		t.Fatalf("someone else's request in the set: %s", r)
	}
	if tk := adam.Do("POST", "/app/v1/join-requests/"+x.ReqID+"/readdress", nil); tk.Status != 200 {
		t.Fatalf("take over: %s", tk)
	}
	r = adam.approveBatch(room.ID, hc, adam.batchItems(room, cardOf(t, adam, a.ReqID), cardOf(t, adam, x.ReqID)))
	if r.Status != 403 || r.Code() != "human_check_failed" {
		t.Fatalf("the same check after the takeover approved: %s", r)
	}
	if activeMembers(t, c, room.ID) != 0 {
		t.Fatal("a chat was let in")
	}
	// a new passkey answer for the set, now Adam's, approves it
	if r := adam.tickAndApprove(t, room, a, x); r.Status != 200 {
		t.Fatalf("a new check: %s", r)
	}
}

// The single approval: a check verified for a request that was not the caller's (404) is spent, so it cannot approve
// the request after a takeover.
func TestSingleCheckSpentWhenNotYours(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("single-takeover")
	bea := NewPerson(t, c, "Bea")
	adam.addPerson(room, bea)
	x := waitingChats(t, c, bea, room, "theirs", 1)[0]
	card := cardOf(t, bea, x.ReqID)
	hc := adam.Check("approve_join", x.ReqID)
	adam.Sync(room)
	e := room.Log.Build("member_add", adam.Dev, map[string]any{"member": card["member_id"], "account": adam.AccountID, "name": card["name"],
		"app": card["app"], "ed": card["ed25519_pk"], "x": card["x25519_pk"]})
	body := map[string]any{"human_check": map[string]any{"id": hc, "stub": true}, "roster_entry": e}
	if r := adam.Do("POST", "/app/v1/join-requests/"+x.ReqID+"/approve", body); r.Status != 404 {
		t.Fatalf("someone else's request: %s", r)
	}
	if tk := adam.Do("POST", "/app/v1/join-requests/"+x.ReqID+"/readdress", nil); tk.Status != 200 {
		t.Fatalf("take over: %s", tk)
	}
	if r := adam.Do("POST", "/app/v1/join-requests/"+x.ReqID+"/approve", body); r.Status != 403 || r.Code() != "human_check_failed" {
		t.Fatalf("the check verified before the takeover approved: %s", r)
	}
	if activeMembers(t, c, room.ID) != 0 {
		t.Fatal("a chat was let in")
	}
	if r := adam.Approve(room, x); r.Status != 200 {
		t.Fatalf("a new check: %s", r)
	}
}

// A room draft's confirm: a check verified while the draft was not held by the caller (404) is spent, so claiming the
// draft afterwards does not make that check confirm it.
func TestDraftCheckSpentWhenNotHeld(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	ann := NewPerson(t, c, "Ann")
	a := NewAgentKeys(t, "builder")
	v := a.Draft(c, "acme")
	if v.Status != 201 {
		t.Fatal(v)
	}
	card := &Resp{J: map[string]any{"id": a.ReqID, "member_id": v.Str("member_id"), "name": "builder", "app": "claude-code",
		"ed25519_pk": a.Key.Hex(), "x25519_pk": hexs(a.X)}}
	dc := ann.buildConfirm(card, v.Str("match_code"), "acme")
	if r := ann.confirmDraft(a.ReqID, dc); r.Status != 404 {
		t.Fatalf("confirm before claiming: %s", r)
	}
	if r := ann.claimDraft(a.ReqID); r.Status != 200 {
		t.Fatalf("claim: %s", r)
	}
	if r := ann.confirmDraft(a.ReqID, dc); r.Status != 403 || r.Code() != "human_check_failed" {
		t.Fatalf("the check verified before the claim confirmed: %s", r)
	}
	if n := count(t, c, `select count(*) from rooms`); n != 0 {
		t.Fatal("a room was made")
	}
}

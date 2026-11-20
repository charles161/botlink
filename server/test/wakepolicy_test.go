package test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/charles161/botlink/server/internal/wire"
)

// Lane F (SPEC §6.9 "Held while away", NEED item 3 of the client lane): a muted or held member's message must not
// wake the recipient's chat. The client already drops a muted member's messages and holds another person's messages
// while no human is with the chat; the server woke the chat for them anyway (one model turn each, on the recipient's
// account). Now the client's mute reaches the server, and a member may declare "other people's chats do not wake me,
// except these members".

type wakeWorld struct {
	c                         *Copy
	adam, eve                 *Person
	room                      *Room
	mine, other, loud, friend *Agent // mine + other: Adam's chats; loud + friend: Eve's chats
}

func newWakeWorld(t *testing.T) *wakeWorld {
	c := StartCopy(t, NewDB(t), "A")
	w := &wakeWorld{c: c, adam: NewPerson(t, c, "Adam"), eve: NewPerson(t, c, "Eve")}
	w.room = w.adam.CreateRoom("heldaway")
	addPerson(t, w.adam, w.eve, w.room)
	w.mine = w.adam.Member(c, w.room, "mine")
	w.other = w.adam.Member(c, w.room, "other")
	w.loud = w.eve.Member(c, w.room, "loud")
	w.friend = w.eve.Member(c, w.room, "friend")
	for _, a := range []*Agent{w.mine, w.other, w.loud, w.friend} {
		a.Drain(c)
	}
	return w
}

// wakes: copies that would wake the member now (the non-leasing wait, peek: what watch / listen / a waiter sees)
func (w *wakeWorld) wakes(t *testing.T, a *Agent) int {
	t.Helper()
	r := a.Do(w.c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0, "peek": true})
	if r.Status != 200 {
		t.Fatalf("wait: %s", r)
	}
	return int(r.J["count"].(float64))
}

func (w *wakeWorld) readable(t *testing.T, a *Agent) int {
	t.Helper()
	return int(a.Do(w.c, "GET", "/api/v1/me/inbox/count", nil).J["available"].(float64))
}

func (w *wakeWorld) send(t *testing.T, from, to *Agent, mod func(map[string]any)) (string, *Resp) {
	t.Helper()
	id := wire.NewV7().String()
	b := from.SendBody(id, false, []*Agent{to}, nil)
	if mod != nil {
		mod(b)
	}
	r := from.Do(w.c, "POST", "/api/v1/messages", b)
	if r.Status != 201 && r.Status != 200 {
		t.Fatalf("send: %s", r)
	}
	return id, r
}

func notWoken(t *testing.T, r *Resp) []string {
	t.Helper()
	raw, ok := r.J["not_woken"].([]any)
	if !ok {
		t.Fatalf("send response has no not_woken list: %s", r)
	}
	out := []string{}
	for _, x := range raw {
		out = append(out, x.(string))
	}
	return out
}

func (w *wakeWorld) declare(t *testing.T, a *Agent, hold bool, except ...string) *Resp {
	t.Helper()
	if except == nil {
		except = []string{}
	}
	r := a.Do(w.c, "PUT", "/api/v1/me/wake-policy", map[string]any{"hold_others": hold, "except": except})
	if r.Status != 200 {
		t.Fatalf("wake-policy: %s", r)
	}
	return r
}

func (w *wakeWorld) needsYou(t *testing.T, p *Person) []map[string]any {
	t.Helper()
	out := []map[string]any{}
	for _, x := range p.Do("GET", "/app/v1/needs-you", nil).J["attention"].([]any) {
		if it := x.(map[string]any); it["kind"] == "needs_you" {
			out = append(out, it)
		}
	}
	return out
}

// A member the chat muted (the client's PUT /me/mutes, its human's "muted" setting) wakes nobody: no wait counts it,
// no push job, no event; the copy still waits for the chat's next turn.
func TestMutedSenderWakesNobody(t *testing.T) {
	w := newWakeWorld(t)
	c := w.c
	// an always-on recipient (push) and an event subscription on the same member
	exec(t, c, `update members set turn = 'always_on', push_url = 'http://127.0.0.1:9/push', push_secret = '\x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'::bytea, push_verified_at = now() where id = $1`, w.mine.ID)
	exec(t, c, `insert into event_subscriptions (id, member_id, key_epoch, url, name, secret, expires_at, verified_at)
		select 'sub_0123456789abcdef01234567', id, key_epoch, 'http://127.0.0.1:9/hook', 'message.received', '\x000102030405060708090a0b0c0d0e0f1011121314151617'::bytea, now() + interval '1 day', now()
		from members where id = $1`, w.mine.ID)
	if r := w.mine.Do(c, "PUT", "/api/v1/me/mutes/"+w.loud.ID, nil); r.Status != 200 {
		t.Fatalf("mute: %s", r)
	}
	id, r := w.send(t, w.loud, w.mine, nil)
	if got := notWoken(t, r); len(got) != 0 {
		t.Fatalf("a mute must never show in the send response: %v", got)
	}
	if n := w.wakes(t, w.mine); n != 0 {
		t.Fatalf("a muted sender's copy is counted by wait: %d", n)
	}
	if n := count(t, c, `select count(*) from push_jobs where message_id = $1`, id); n != 0 {
		t.Fatalf("a muted sender's copy made a push job: %d", n)
	}
	if n := count(t, c, `select count(*) from event_jobs where message_id = $1`, id); n != 0 {
		t.Fatalf("a muted sender's copy made an event: %d", n)
	}
	if n := count(t, c, `select count(*) from deliveries where message_id = $1 and no_wake and not wake_held`, id); n != 1 {
		t.Fatalf("the copy should be no_wake (and not reported as held): %d", n)
	}
	if n := w.readable(t, w.mine); n != 1 {
		t.Fatalf("a muted sender's copy still waits to be read: %d", n)
	}
	if len(w.needsYou(t, w.adam)) != 0 {
		t.Fatal("a muted sender must not put anything on the dashboard")
	}
	// control: an unmuted sender of the same person still makes a push job and an event
	id2, _ := w.send(t, w.friend, w.mine, nil)
	if n := count(t, c, `select count(*) from push_jobs where message_id = $1`, id2); n != 1 {
		t.Fatalf("control: push job %d", n)
	}
	if n := count(t, c, `select count(*) from event_jobs where message_id = $1`, id2); n != 1 {
		t.Fatalf("control: event %d", n)
	}
}

// A declared policy keeps another person's chat from waking the member; an excepted member, the person's own chats
// and an answer to the member's own recent message still wake it. A member that never declared it (an old client) is
// woken as today.
func TestWakePolicyHoldsOtherPeople(t *testing.T) {
	w := newWakeWorld(t)
	c := w.c
	// undeclared (old client): woken as today, nothing reported
	_, r := w.send(t, w.loud, w.mine, nil)
	if got := notWoken(t, r); len(got) != 0 || w.wakes(t, w.mine) != 1 {
		t.Fatalf("an undeclared member is woken as before: %v, %d", got, w.wakes(t, w.mine))
	}
	w.mine.Drain(c)
	exec(t, c, `update deliveries set state = 'done', done_at = now(), envelope = null, lease_until = null, purge_after = null where member_id = $1`, w.mine.ID)

	// declared, friend excepted (its human let it through while away); an id from nowhere is dropped
	stranger := wire.NewV7().String()
	d := w.declare(t, w.mine, true, w.friend.ID, stranger, w.friend.ID)
	if ex, _ := json.Marshal(d.J["except"]); string(ex) != `["`+w.friend.ID+`"]` || d.Str("since") == "" {
		t.Fatalf("declare: %s", d)
	}
	since := d.Str("since")
	if again := w.declare(t, w.mine, true, w.friend.ID); again.Str("since") != since {
		t.Fatalf("declaring again is idempotent (since kept): %s vs %s", again.Str("since"), since)
	}

	held, r := w.send(t, w.loud, w.mine, nil)
	if got := notWoken(t, r); len(got) != 1 || got[0] != w.mine.ID {
		t.Fatalf("the sender is told the recipient was not woken: %v", got)
	}
	if n := w.wakes(t, w.mine); n != 0 {
		t.Fatalf("another person's chat woke a member that holds: %d", n)
	}
	if n := count(t, c, `select count(*) from deliveries where message_id = $1 and no_wake and wake_held`, held); n != 1 {
		t.Fatalf("held copy flags: %d", n)
	}
	if n := w.readable(t, w.mine); n != 1 {
		t.Fatalf("the held copy still waits for the chat's next turn: %d", n)
	}
	// the excepted member wakes it
	if _, r := w.send(t, w.friend, w.mine, nil); len(notWoken(t, r)) != 0 || w.wakes(t, w.mine) != 1 {
		t.Fatalf("an excepted member must wake it: %s %d", r, w.wakes(t, w.mine))
	}
	// the person's own other chat wakes it
	if _, r := w.send(t, w.other, w.mine, nil); len(notWoken(t, r)) != 0 || w.wakes(t, w.mine) != 2 {
		t.Fatalf("the person's own chat must wake it: %s %d", r, w.wakes(t, w.mine))
	}
	// an answer to the member's own message (it may be staying in its turn for it) wakes it
	asked, _ := w.send(t, w.mine, w.loud, nil)
	_, r = w.send(t, w.loud, w.mine, func(b map[string]any) {
		nb := w.loud.SendBody(b["id"].(string), false, []*Agent{w.mine}, &asked)
		for k, v := range nb {
			b[k] = v
		}
	})
	if len(notWoken(t, r)) != 0 || w.wakes(t, w.mine) != 3 {
		t.Fatalf("an answer to its own message must wake it: %s %d", r, w.wakes(t, w.mine))
	}
	// a room-wide message: listed only for the members that hold
	id := wire.NewV7().String()
	rr := w.loud.Do(c, "POST", "/api/v1/messages", w.loud.SendBody(id, true, []*Agent{w.mine, w.other, w.friend}, nil))
	if rr.Status != 201 {
		t.Fatalf("room send: %s", rr)
	}
	if got := notWoken(t, rr); len(got) != 1 || got[0] != w.mine.ID {
		t.Fatalf("room send lists only the member that holds: %v", got)
	}
	// dropping the policy: woken as before
	if r := w.declare(t, w.mine, false); r.J["since"] != nil {
		t.Fatalf("drop: %s", r)
	}
	if _, r := w.send(t, w.loud, w.mine, nil); len(notWoken(t, r)) != 0 {
		t.Fatalf("after dropping the policy nothing is reported: %s", r)
	}
}

// The send response never reveals a mute: a muted sender gets exactly the answer an unmuted one would (listed when the
// recipient holds other people's messages, not listed when it does not). The dashboard item comes without any text,
// once while open, not for a muted sender and not for an fyi.
func TestHeldSendResponseAndDashboard(t *testing.T) {
	w := newWakeWorld(t)
	c := w.c
	w.declare(t, w.mine, true)
	// fyi (quiet): never wakes anyway; not listed, no dashboard item, but no event either
	fyi, r := w.send(t, w.loud, w.mine, func(b map[string]any) { b["quiet"] = true })
	if len(notWoken(t, r)) != 0 || len(w.needsYou(t, w.adam)) != 0 {
		t.Fatalf("an fyi is neither listed nor brought to the dashboard: %s", r)
	}
	if n := count(t, c, `select count(*) from deliveries where message_id = $1 and no_wake`, fyi); n != 1 {
		t.Fatalf("a held fyi is no_wake too (no event): %d", n)
	}
	// a question: listed, one dashboard item without text
	q, r := w.send(t, w.loud, w.mine, nil)
	if got := notWoken(t, r); len(got) != 1 {
		t.Fatalf("held question listed: %v", got)
	}
	items := w.needsYou(t, w.adam)
	if len(items) != 1 || items[0]["subject_id"] != w.mine.ID {
		t.Fatalf("dashboard item for the held message: %v", items)
	}
	body, _ := json.Marshal(items[0])
	if strings.Contains(string(body), q) || strings.Contains(string(body), "text") {
		t.Fatalf("the dashboard item carries nothing of the message: %s", body)
	}
	if dd, _ := json.Marshal(items[0]["data"]); string(dd) != `{"reason":"needs_ok"}` {
		t.Fatalf("same item as ask-human needs_ok: %s", dd)
	}
	w.send(t, w.loud, w.mine, nil)
	if n := len(w.needsYou(t, w.adam)); n != 1 {
		t.Fatalf("deduped while open: %d", n)
	}
	if len(w.needsYou(t, w.eve)) != 0 {
		t.Fatal("the sender's person gets nothing")
	}
	// replay of the same request (same bytes): same list
	id := wire.NewV7().String()
	b := w.friend.SendBody(id, false, []*Agent{w.mine}, nil)
	r1 := w.friend.Do(c, "POST", "/api/v1/messages", b)
	r2 := w.friend.Do(c, "POST", "/api/v1/messages", b)
	if r1.Status != 201 || r2.Status != 200 || strings.Join(notWoken(t, r1), ",") != w.mine.ID || strings.Join(notWoken(t, r2), ",") != w.mine.ID {
		t.Fatalf("replay: %s / %s", r1, r2)
	}

	// muted AND held: the muted sender sees exactly what an unmuted sender sees; nothing reaches the dashboard
	for _, it := range w.needsYou(t, w.adam) {
		w.adam.Do("POST", "/app/v1/attention/"+it["id"].(string)+"/dismiss", nil)
	}
	if r := w.mine.Do(c, "PUT", "/api/v1/me/mutes/"+w.loud.ID, nil); r.Status != 200 {
		t.Fatalf("mute: %s", r)
	}
	if _, r := w.send(t, w.loud, w.mine, nil); strings.Join(notWoken(t, r), ",") != w.mine.ID {
		t.Fatalf("a muted sender must get the same answer as an unmuted one (listed): %s", r)
	}
	if n := len(w.needsYou(t, w.adam)); n != 0 {
		t.Fatalf("a muted sender's message is never brought to the dashboard: %d", n)
	}
	if n := w.wakes(t, w.mine); n != 0 {
		t.Fatalf("muted and held: no wake: %d", n)
	}
	// muted, recipient without a policy (Adam's other chat): not listed, exactly like an unmuted sender that wakes it
	if _, r := w.send(t, w.loud, w.other, nil); len(notWoken(t, r)) != 0 {
		t.Fatalf("a mute alone is never reported: %s", r)
	}
	if n := w.wakes(t, w.other); n != 0 {
		t.Fatalf("but the mute holds: %d", n)
	}
}

// The policy is the declaring key's: after the member is taken over with a new key (key_epoch moves on), the old
// declaration no longer applies until the new chat declares again. Bad input is refused; the route needs the holder.
func TestWakePolicyKeyEpochAndInput(t *testing.T) {
	w := newWakeWorld(t)
	c := w.c
	w.declare(t, w.mine, true)
	exec(t, c, `update members set key_epoch = key_epoch + 1 where id = $1`, w.mine.ID)
	if _, r := w.send(t, w.loud, w.mine, nil); len(notWoken(t, r)) != 0 || w.wakes(t, w.mine) != 1 {
		t.Fatalf("a policy declared under an earlier key must not apply: %s", r)
	}
	for _, bad := range []map[string]any{
		{},
		{"hold_others": true, "except": []string{"not-a-uuid"}},
		{"hold_others": true, "except": []string{}, "extra": 1},
	} {
		if r := w.mine.Do(c, "PUT", "/api/v1/me/wake-policy", bad); r.Status != 400 {
			t.Fatalf("bad body %v: %s", bad, r)
		}
	}
	other := w.mine.Session
	w.mine.Session = "sess-someoneelse"
	if r := w.mine.Do(c, "PUT", "/api/v1/me/wake-policy", map[string]any{"hold_others": true, "except": []string{}}); r.Status == 200 {
		t.Fatalf("another chat's session must not declare for the member: %s", r)
	}
	w.mine.Session = other
}

// The lease says which copies the server held for the recipient's policy (wake_held), so the client knows exactly that
// the sender and the dashboard were already told (no second automatic reply). A copy that woke it says false.
func TestLeaseSaysWakeHeld(t *testing.T) {
	w := newWakeWorld(t)
	w.declare(t, w.mine, true)
	held, _ := w.send(t, w.loud, w.mine, nil)
	woke, _ := w.send(t, w.other, w.mine, nil)
	lr := w.mine.Lease(w.c, 0)
	if lr.Status != 200 {
		t.Fatalf("lease: %s", lr)
	}
	got := map[string]any{}
	for _, d := range deliveries(lr) {
		got[d["message_id"].(string)] = d["wake_held"]
	}
	if got[held] != true || got[woke] != false {
		t.Fatalf("wake_held per leased copy: %v", got)
	}
}

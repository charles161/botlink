package test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/charles161/botlink/server/internal/wire"
)

// The rooms home shows "Last message 5 min ago" per room (lane LASTMSG, 17 Nov 2026). GET /app/v1/rooms carries
// last_message_at: the time the server accepted the newest conversation message of the room (scope member or room,
// not a join hello), the same messages room_week_senders counts (migration 0020). Self-tests and server notices are
// not messages people's chats pass to each other and never set it.

// lastMessageAt returns the room's last_message_at as p's rooms list shows it ("" for null), and whether the room is
// in p's list at all.
func lastMessageAt(t *testing.T, p *Person, roomID string) (string, bool) {
	t.Helper()
	r := p.Do("GET", "/app/v1/rooms", nil)
	if r.Status != 200 {
		t.Fatalf("rooms: %s", r)
	}
	for _, x := range r.J["rooms"].([]any) {
		m := x.(map[string]any)
		if m["id"] != roomID {
			continue
		}
		v, ok := m["last_message_at"]
		if !ok {
			t.Fatalf("rooms list item has no last_message_at (want a time or null): %v", m)
		}
		if v == nil {
			return "", true
		}
		return v.(string), true
	}
	return "", false
}

func requireRecent(t *testing.T, who, got string) time.Time {
	t.Helper()
	if got == "" {
		t.Fatalf("%s: last_message_at is null, want a time within a second of now", who)
	}
	at, err := time.Parse(time.RFC3339Nano, got)
	if err != nil {
		t.Fatalf("%s: last_message_at %q is not RFC 3339: %v", who, got, err)
	}
	if d := time.Since(at); d < -time.Second || d > time.Second {
		t.Fatalf("%s: last_message_at %s is %s from now, want within a second", who, got, d)
	}
	return at
}

func TestRoomsListLastMessage(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	bea := NewPerson(t, c, "Bea")
	cy := NewPerson(t, c, "Cy")
	room := adam.CreateRoom("lastmsg")
	addPerson(t, adam, bea, room)
	a := adam.Member(c, room, "abot")
	b := bea.Member(c, room, "bbot")
	quiet := adam.CreateRoom("lastmsg-quiet")

	// joins, a join hello, self-tests and the notices they make are not messages people's chats pass
	for _, p := range []*Person{adam, bea} {
		if at, in := lastMessageAt(t, p, room.ID); !in || at != "" {
			t.Fatalf("%s after the joins: in list %v, last_message_at %q; want null", p.Name, in, at)
		}
	}
	hid := wire.NewV7().String()
	hello := a.SendBody(hid, true, []*Agent{b}, nil)
	hello["intro"], hello["quiet"] = true, true
	if r := a.Do(c, "POST", "/api/v1/messages", hello); r.Status != 201 {
		t.Fatalf("hello: %s", r)
	}
	for _, m := range []*Agent{a, b} {
		id := wire.NewV7().String()
		if r := m.Do(c, "POST", "/api/v1/me/selftest", map[string]any{"id": id, "envelope": m.Envelope(id, "self", m.ID, m.FP(), nil, time.Now().Unix()+3600)}); r.Status != 201 {
			t.Fatalf("selftest: %s", r)
		}
	}
	if r := a.Do(c, "POST", "/api/v1/me/ask-human", map[string]any{"reason": "cannot_wake"}); r.Status >= 300 {
		t.Fatalf("ask-human: %s", r)
	}
	if n := count(t, c, `select count(*) from notices n join members m on m.id = n.member_id where m.room_id = $1`, room.ID); n == 0 {
		t.Fatal("expected server notices in the room (roster_changed) for this check to mean anything")
	}
	if at, _ := lastMessageAt(t, adam, room.ID); at != "" {
		t.Fatalf("after a hello, two self-tests and notices: last_message_at %q, want null", at)
	}

	// a message one member sends to another: every person in the room sees the time
	if _, r := a.Send(c, b); r.Status != 201 {
		t.Fatalf("send: %s", r)
	}
	at1, _ := lastMessageAt(t, adam, room.ID)
	requireRecent(t, "Adam (owner)", at1)
	atB, _ := lastMessageAt(t, bea, room.ID)
	if atB != at1 {
		t.Fatalf("Bea sees %q, Adam %q: one room-level time", atB, at1)
	}
	if at, in := lastMessageAt(t, adam, quiet.ID); !in || at != "" {
		t.Fatalf("room without messages: in list %v, last_message_at %q; want null", in, at)
	}
	// a person not in the room sees neither the room nor its time
	if _, in := lastMessageAt(t, cy, room.ID); in {
		t.Fatal("Cy, not in the room, has it in the rooms list")
	}
	if r := cy.Do("GET", "/app/v1/rooms/"+room.ID, nil); r.Status != 404 {
		t.Fatalf("Cy reads the room: %s", r)
	}
	// a room message (scope room) counts too, and moves the time forward
	rid := wire.NewV7().String()
	roomMsg := b.SendBody(rid, true, []*Agent{a}, nil)
	if r := b.Do(c, "POST", "/api/v1/messages", roomMsg); r.Status != 201 {
		t.Fatalf("room send: %s", r)
	}
	at2, _ := lastMessageAt(t, bea, room.ID)
	if requireRecent(t, "Bea", at2); at2 <= at1 {
		t.Fatalf("a later message left last_message_at at %q (was %q)", at2, at1)
	}
	// a replayed send (same id, same body) is not a new message
	exec(t, c, `update rooms set last_message_at = last_message_at - interval '1 hour' where id = $1`, room.ID)
	before := count(t, c, `select extract(epoch from last_message_at)::bigint from rooms where id = $1`, room.ID)
	if r := b.Do(c, "POST", "/api/v1/messages", roomMsg); r.Status != 200 {
		t.Fatalf("replay: %s", r)
	}
	if after := count(t, c, `select extract(epoch from last_message_at)::bigint from rooms where id = $1`, room.ID); after != before {
		t.Fatalf("a replayed send moved last_message_at (%d → %d)", before, after)
	}
}

// Two chats sending to one room at once: the stored time is the newest accepted message's, never an older one. A send
// whose transaction started earlier but commits later must not move the time back.
func TestRoomsListLastMessageConcurrent(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("lastmsg-race")
	a := adam.Member(c, room, "abot")
	b := adam.Member(c, room, "bbot")
	var wg sync.WaitGroup
	errs := make(chan string, 20)
	for i := 0; i < 5; i++ {
		for _, pair := range [][2]*Agent{{a, b}, {b, a}} {
			wg.Add(1)
			go func(from, to *Agent) {
				defer wg.Done()
				if _, r := from.Send(c, to); r.Status != 201 {
					errs <- r.String()
				}
			}(pair[0], pair[1])
		}
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Fatalf("concurrent send: %s", e)
	}
	if n := count(t, c, `select count(*) from rooms r where r.id = $1 and r.last_message_at =
		(select max(created_at) from messages where room_id = r.id and scope in ('member','room') and not intro)`, room.ID); n != 1 {
		t.Fatal("after concurrent sends last_message_at is not the newest message's time")
	}
	at, _ := lastMessageAt(t, adam, room.ID)
	requireRecent(t, "Adam", at)

	// a stored time later than this transaction's start (a send that started later and committed first) stays
	exec(t, c, `update rooms set last_message_at = now() + interval '1 hour' where id = $1`, room.ID)
	want := count(t, c, `select extract(epoch from last_message_at)::bigint from rooms where id = $1`, room.ID)
	if _, r := a.Send(c, b); r.Status != 201 {
		t.Fatalf("send: %s", r)
	}
	if got := count(t, c, `select extract(epoch from last_message_at)::bigint from rooms where id = $1`, room.ID); got != want {
		t.Fatalf("a send moved last_message_at back (%d → %d)", want, got)
	}
}

// Lock order. A member-list change locks the rooms row (the roster_head_seq CAS, store.AppendEntry) and then member
// rows (store.RemoveMember). A send must take the rooms row before it takes the member rows FOR SHARE, or the two
// deadlock and Postgres aborts one of them. Here a transaction holds the rooms row like a member-list change; the send
// must queue behind it without holding any member row, so the change can lock a member row and commit.
func TestSendLocksRoomBeforeMembers(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("lastmsg-locks")
	a := adam.Member(c, room, "abot")
	b := adam.Member(c, room, "bbot")
	ctx := context.Background()
	tx, err := c.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `update rooms set roster_head_seq = roster_head_seq where id = $1`, room.ID); err != nil {
		t.Fatal(err)
	}
	done := make(chan *Resp, 1)
	go func() { _, r := a.Send(c, b); done <- r }()
	waiting := false
	for i := 0; i < 100 && !waiting; i++ {
		var n int
		if err := c.Pool.QueryRow(ctx, `select count(*) from pg_stat_activity where datname = current_database()
			and wait_event_type = 'Lock' and query ilike '%rooms%'`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		waiting = n > 0
		if !waiting {
			time.Sleep(50 * time.Millisecond)
		}
	}
	if !waiting {
		r := <-done
		t.Fatalf("the send never waited for the rooms row a member-list change holds (send answered %s); it must lock the room it updates", r)
	}
	if _, err := tx.Exec(ctx, `set local lock_timeout = '3s'`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `select 1 from members where id = $1 for update`, b.ID); err != nil {
		t.Fatalf("a member-list change could not lock a member row while a send waited (the send holds member rows before the room: deadlock): %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if r := <-done; r.Status != 201 {
		t.Fatalf("send after the change committed: %s", r)
	}
}

// The rooms list order: rooms with the newest message first; rooms with none after them, newest room first.
func TestRoomsListOrderByLastMessage(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	oldQuiet := adam.CreateRoom("old-quiet")
	talkA := adam.CreateRoom("talk-a")
	newQuiet := adam.CreateRoom("new-quiet")
	talkB := adam.CreateRoom("talk-b")
	a1, a2 := adam.Member(c, talkA, "a1"), adam.Member(c, talkA, "a2")
	b1, b2 := adam.Member(c, talkB, "b1"), adam.Member(c, talkB, "b2")
	if _, r := b1.Send(c, b2); r.Status != 201 {
		t.Fatalf("send b: %s", r)
	}
	if _, r := a1.Send(c, a2); r.Status != 201 {
		t.Fatalf("send a: %s", r)
	}
	r := adam.Do("GET", "/app/v1/rooms", nil)
	var got []string
	for _, x := range r.J["rooms"].([]any) {
		got = append(got, x.(map[string]any)["id"].(string))
	}
	want := []string{talkA.ID, talkB.ID, newQuiet.ID, oldQuiet.ID}
	if len(got) != len(want) {
		t.Fatalf("rooms: %v", r)
	}
	names := map[string]string{talkA.ID: "talk-a", talkB.ID: "talk-b", newQuiet.ID: "new-quiet", oldQuiet.ID: "old-quiet"}
	for i := range want {
		if got[i] != want[i] {
			gn := []string{}
			for _, id := range got {
				gn = append(gn, names[id])
			}
			t.Fatalf("rooms order %v, want talk-a, talk-b, new-quiet, old-quiet", gn)
		}
	}
}

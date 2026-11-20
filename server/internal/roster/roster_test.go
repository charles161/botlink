package roster_test

import (
	"encoding/hex"
	"strings"
	"testing"

	"github.com/charles161/botlink/server/internal/roster"
	"github.com/charles161/botlink/server/internal/testkit"
	"github.com/charles161/botlink/server/internal/wire"
)

const (
	room   = "01933b6e-0000-7000-8000-000000000001"
	owner  = "01933b6e-0000-7000-8000-0000000000a1"
	friend = "01933b6e-0000-7000-8000-0000000000b2"
	mem1   = "01933b6e-0000-7000-8000-0000000000c1"
	mem2   = "01933b6e-0000-7000-8000-0000000000c2"
)

type fixture struct {
	log                          *testkit.Log
	ownerDev, friendDev, ownerD2 testkit.Key
	m1, m2                       testkit.Key
}

// validLog: genesis, person_add, member_add (owner's chat), member_add (friend's chat),
// member_rekey, device_add, member_remove (self).
func validLog(t *testing.T) *fixture {
	f := &fixture{log: testkit.NewLog(room), ownerDev: testkit.NewKey(), friendDev: testkit.NewKey(), ownerD2: testkit.NewKey(),
		m1: testkit.NewKey(), m2: testkit.NewKey()}
	l := f.log
	l.Append("genesis", f.ownerDev, map[string]any{"name": "acme", "owner": owner, "device": f.ownerDev.Hex()})
	l.Append("person_add", f.ownerDev, map[string]any{"account": friend, "name": "Priya Sharma", "device": f.friendDev.Hex()})
	l.Append("member_add", f.ownerDev, map[string]any{"member": mem1, "account": owner, "name": "bugfix", "app": "claude-code", "ed": f.m1.Hex(), "x": testkit.RandHex32()})
	l.Append("member_add", f.friendDev, map[string]any{"member": mem2, "account": friend, "name": "deployer", "app": "codex", "ed": f.m2.Hex(), "x": testkit.RandHex32()})
	newKey := testkit.NewKey()
	l.Append("member_rekey", f.friendDev, map[string]any{"member": mem2, "ed": newKey.Hex(), "x": testkit.RandHex32()})
	l.Append("device_add", f.ownerDev, map[string]any{"account": owner, "device": f.ownerD2.Hex(), "label": "Firefox on laptop"})
	l.Append("member_remove", f.m1, map[string]any{"member": mem1})
	return f
}

func TestValidLog(t *testing.T) {
	f := validLog(t)
	s, err := roster.Replay(room, f.log.Entries)
	if err != nil {
		t.Fatal(err)
	}
	if s.HeadSeq != 6 || s.Owner != owner || s.Name != "acme" {
		t.Fatalf("bad state: head %d owner %s", s.HeadSeq, s.Owner)
	}
	if s.Members[mem1].Active || !s.Members[mem2].Active {
		t.Fatal("member activity wrong")
	}
	if !s.IsDeviceOf(f.ownerD2.Hex(), owner) || !s.IsOwnerDevice(f.ownerD2.Hex()) {
		t.Fatal("device_add not applied")
	}
	raw, _ := wire.DecodeB64URL(f.log.Entries[0].Entry)
	if s.RoomFP() != wire.FP16(raw) {
		t.Fatal("room fp")
	}
}

func expectRule(t *testing.T, entries []roster.Wire, rule string) {
	t.Helper()
	_, err := roster.Replay(room, entries)
	re, ok := err.(*roster.Error)
	if !ok {
		t.Fatalf("want rule %s, got %v", rule, err)
	}
	if re.Rule != rule {
		t.Fatalf("want rule %s, got %s (%s)", rule, re.Rule, re.Msg)
	}
}

func base(t *testing.T) (*testkit.Log, testkit.Key, testkit.Key) {
	l := testkit.NewLog(room)
	od, fd := testkit.NewKey(), testkit.NewKey()
	l.Append("genesis", od, map[string]any{"name": "acme", "owner": owner, "device": od.Hex()})
	l.Append("person_add", od, map[string]any{"account": friend, "name": "Priya", "device": fd.Hex()})
	return l, od, fd
}

func TestInvalidVariants(t *testing.T) {
	t.Run("bad signature", func(t *testing.T) {
		l, od, _ := base(t)
		w := l.Build("member_add", od, map[string]any{"member": mem1, "account": owner, "name": "a", "app": "codex", "ed": testkit.RandHex32(), "x": testkit.RandHex32()})
		w.Sig = strings.Repeat("0", 128)
		expectRule(t, append(l.Entries, w), "sig")
	})
	t.Run("wrong prev", func(t *testing.T) {
		l, od, _ := base(t)
		w := l.BuildAt(2, make([]byte, 32), "member_add", od, map[string]any{"member": mem1, "account": owner, "name": "a", "app": "codex", "ed": testkit.RandHex32(), "x": testkit.RandHex32()})
		expectRule(t, append(l.Entries, w), "prev")
	})
	t.Run("gap in seq", func(t *testing.T) {
		l, od, _ := base(t)
		w := l.BuildAt(3, l.HeadHash(), "member_add", od, map[string]any{"member": mem1, "account": owner, "name": "a", "app": "codex", "ed": testkit.RandHex32(), "x": testkit.RandHex32()})
		expectRule(t, append(l.Entries, w), "seq")
	})
	t.Run("owner adds a chat for another person", func(t *testing.T) {
		l, od, _ := base(t)
		w := l.Build("member_add", od, map[string]any{"member": mem1, "account": friend, "name": "a", "app": "codex", "ed": testkit.RandHex32(), "x": testkit.RandHex32()})
		expectRule(t, append(l.Entries, w), "signer")
	})
	t.Run("friend adds a person", func(t *testing.T) {
		l, _, fd := base(t)
		w := l.Build("person_add", fd, map[string]any{"account": "01933b6e-0000-7000-8000-0000000000d3", "name": "X", "device": testkit.RandHex32()})
		expectRule(t, append(l.Entries, w), "signer")
	})
	t.Run("duplicate member name", func(t *testing.T) {
		l, od, fd := base(t)
		l.Append("member_add", od, map[string]any{"member": mem1, "account": owner, "name": "dup", "app": "codex", "ed": testkit.RandHex32(), "x": testkit.RandHex32()})
		w := l.Build("member_add", fd, map[string]any{"member": mem2, "account": friend, "name": "dup", "app": "codex", "ed": testkit.RandHex32(), "x": testkit.RandHex32()})
		expectRule(t, append(l.Entries, w), "op")
	})
	t.Run("duplicate member key", func(t *testing.T) {
		l, od, fd := base(t)
		k := testkit.RandHex32()
		l.Append("member_add", od, map[string]any{"member": mem1, "account": owner, "name": "one", "app": "codex", "ed": k, "x": testkit.RandHex32()})
		w := l.Build("member_add", fd, map[string]any{"member": mem2, "account": friend, "name": "two", "app": "codex", "ed": k, "x": testkit.RandHex32()})
		expectRule(t, append(l.Entries, w), "op")
	})
	t.Run("remove the owner", func(t *testing.T) {
		l, od, _ := base(t)
		w := l.Build("person_remove", od, map[string]any{"account": owner})
		expectRule(t, append(l.Entries, w), "op")
	})
	t.Run("removed person's device can't sign", func(t *testing.T) {
		l, od, fd := base(t)
		l.Append("person_remove", od, map[string]any{"account": friend})
		w := l.Build("member_add", fd, map[string]any{"member": mem2, "account": friend, "name": "late", "app": "codex", "ed": testkit.RandHex32(), "x": testkit.RandHex32()})
		expectRule(t, append(l.Entries, w), "signer")
	})
	t.Run("unexpected field", func(t *testing.T) {
		l, od, _ := base(t)
		w := l.Build("member_remove", od, map[string]any{"member": mem1, "job": "x"})
		expectRule(t, append(l.Entries, w), "op")
	})
	t.Run("duplicate key", func(t *testing.T) {
		l, od, _ := base(t)
		raw := []byte(`{"v":1,"room":"` + room + `","seq":2,"prev":"` + hex.EncodeToString(l.HeadHash()) + `","at":1,"op":"member_remove","by":"` + od.Hex() + `","member":"` + mem1 + `","member":"` + mem2 + `"}`)
		expectRule(t, append(l.Entries, testkit.SignEntry(2, raw, od)), "bad_entry")
	})
	t.Run("signer field mismatch", func(t *testing.T) {
		l, od, fd := base(t)
		w := l.Build("member_add", od, map[string]any{"member": mem1, "account": owner, "name": "a", "app": "codex", "ed": testkit.RandHex32(), "x": testkit.RandHex32()})
		raw, _ := wire.DecodeB64URL(w.Entry)
		w2 := testkit.SignEntry(2, raw, fd)
		expectRule(t, append(l.Entries, w2), "by")
	})
	t.Run("genesis not first", func(t *testing.T) {
		l, od, _ := base(t)
		w := l.Build("genesis", od, map[string]any{"name": "acme", "owner": owner, "device": od.Hex()})
		expectRule(t, append(l.Entries, w), "op")
	})
	t.Run("other room", func(t *testing.T) {
		l, od, _ := base(t)
		other := testkit.NewLog("01933b6e-0000-7000-8000-00000000ffff")
		w := other.BuildAt(2, l.HeadHash(), "member_remove", od, map[string]any{"member": mem1})
		expectRule(t, append(l.Entries, w), "room")
	})
}

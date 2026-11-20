// Package testkit plays the other parties in tests: browser device keys signing roster entries, agent
// members signing requests and sealing (fake) envelopes. Never imported by the server binary.
package testkit

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"time"

	"github.com/charles161/botlink/server/internal/roster"
	"github.com/charles161/botlink/server/internal/wire"
)

// Key is an Ed25519 key pair (browser device or member signing key).
type Key struct {
	Pub  ed25519.PublicKey
	Priv ed25519.PrivateKey
}

func NewKey() Key {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		panic(err)
	}
	return Key{Pub: pub, Priv: priv}
}

func (k Key) Hex() string { return hex.EncodeToString(k.Pub) }

// RandHex32 returns 32 random bytes as hex (stands in for an X25519 public key).
func RandHex32() string { return hex.EncodeToString(wire.RandBytes(32)) }

// Log builds a roster log the way the dashboard does.
type Log struct {
	Room    string
	Entries []roster.Wire
	head    []byte
}

func NewLog(room string) *Log { return &Log{Room: room} }

// NextSeq is the seq the next entry will get.
func (l *Log) NextSeq() int { return len(l.Entries) }

// HeadHash is sha256 of the last entry's bytes.
func (l *Log) HeadHash() []byte { return l.head }

// Build makes (without appending) the next entry: op fields plus the common ones.
func (l *Log) Build(op string, by Key, fields map[string]any) roster.Wire {
	return l.BuildAt(len(l.Entries), l.head, op, by, fields)
}

// BuildAt makes an entry with an explicit seq/prev (to build invalid or concurrent entries).
func (l *Log) BuildAt(seq int, prev []byte, op string, by Key, fields map[string]any) roster.Wire {
	m := map[string]any{"v": 1, "room": l.Room, "seq": seq, "at": time.Now().Unix(), "op": op, "by": by.Hex()}
	if prev == nil {
		m["prev"] = nil
	} else {
		m["prev"] = hex.EncodeToString(prev)
	}
	for k, v := range fields {
		m[k] = v
	}
	raw, _ := json.Marshal(m)
	return SignEntry(seq, raw, by)
}

// SignEntry signs exact entry bytes.
func SignEntry(seq int, raw []byte, by Key) roster.Wire {
	sig := wire.Sign(by.Priv, roster.Context, raw)
	return roster.Wire{Seq: seq, Entry: wire.B64URL(raw), Sig: hex.EncodeToString(sig), Signer: by.Hex()}
}

// Append builds the next entry and appends it locally.
func (l *Log) Append(op string, by Key, fields map[string]any) roster.Wire {
	w := l.Build(op, by, fields)
	l.Push(w)
	return w
}

// Push appends an entry that the server accepted.
func (l *Log) Push(w roster.Wire) {
	raw, _ := wire.DecodeB64URL(w.Entry)
	l.Entries = append(l.Entries, w)
	l.head = wire.SHA256(raw)
}

// Reset replaces the local log with the server's.
func (l *Log) Reset(entries []roster.Wire) {
	l.Entries = nil
	l.head = nil
	for _, w := range entries {
		l.Push(w)
	}
}

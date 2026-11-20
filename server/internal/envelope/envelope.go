// Package envelope checks message envelopes v3 (crypto/ENVELOPE.md §4) on the server side: structure,
// header bytes, sender signature and ct_sha256. The server never opens the sealed box.
package envelope

import (
	"bytes"
	"encoding/json"
	"strings"
	"unicode/utf8"

	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/wire"
)

const Context = "botlink-env-v1"

// MaxBytes is the per-envelope cap (64 KiB, as stored text).
const MaxBytes = 65536

type Header struct {
	V         int     `json:"v"`
	ID        string  `json:"id"`
	Room      string  `json:"room"`
	From      string  `json:"from"`
	FromFP    string  `json:"from_fp"`
	To        string  `json:"to"`
	ToFP      string  `json:"to_fp"`
	Scope     string  `json:"scope"`
	InReplyTo *string `json:"in_reply_to"`
	SentAt    int64   `json:"sent_at"`
	ExpiresAt int64   `json:"expires_at"`
	CTSHA256  string  `json:"ct_sha256"`
}

type Envelope struct {
	Raw    []byte // exactly as received
	H      []byte // decoded header bytes (signed)
	Sig    []byte
	Header Header
}

func bad(msg string) *httpx.Error { return httpx.BadRequest("Invalid envelope: " + msg) }

var headerKeys = []string{"v", "id", "room", "from", "from_fp", "to", "to_fp", "scope", "in_reply_to", "sent_at", "expires_at", "ct_sha256"}

// Parse checks structure, header encoding and ct_sha256. It does not verify the signature.
func Parse(raw []byte) (*Envelope, error) {
	if len(raw) > MaxBytes {
		return nil, httpx.E(413, "too_large", "An envelope is too large (64 KiB max).")
	}
	var w struct {
		V   int    `json:"v"`
		H   string `json:"h"`
		CT  string `json:"ct"`
		Sig string `json:"sig"`
	}
	if err := httpx.DecodeStrict(raw, &w); err != nil {
		return nil, bad("not a {v,h,ct,sig} object")
	}
	if w.V != 3 {
		return nil, bad("v must be 3")
	}
	h, err := wire.DecodeB64URL(w.H)
	if err != nil {
		return nil, bad("h must be base64url without padding")
	}
	sig, ok := wire.DecodeSig(w.Sig)
	if !ok {
		return nil, bad("sig must be 128 lowercase hex chars")
	}
	ct, err := wire.DecodeB64Std(w.CT)
	if err != nil || len(ct) == 0 {
		return nil, bad("ct must be standard base64")
	}
	if !utf8.Valid(h) {
		return nil, bad("header is not UTF-8")
	}
	if err := httpx.CheckNoDuplicateKeys(h); err != nil {
		return nil, bad("header JSON: " + err.Error())
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(h, &keys); err != nil {
		return nil, bad("header is not a JSON object")
	}
	for _, k := range headerKeys {
		if _, ok := keys[k]; !ok {
			return nil, bad("header is missing " + k)
		}
	}
	e := &Envelope{Raw: raw, H: h, Sig: sig}
	dec := json.NewDecoder(bytes.NewReader(h))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&e.Header); err != nil {
		return nil, bad("header: " + strings.TrimPrefix(err.Error(), "json: "))
	}
	hd := e.Header
	switch {
	case hd.V != 3:
		return nil, bad("header v must be 3")
	case !wire.IsUUID(hd.ID) || !wire.IsUUID(hd.Room) || !wire.IsUUID(hd.From) || !wire.IsUUID(hd.To):
		return nil, bad("header ids must be lowercase uuids")
	case !wire.IsFingerprint(hd.FromFP) || !wire.IsFingerprint(hd.ToFP):
		return nil, bad("header fingerprints are malformed")
	case hd.Scope != "member" && hd.Scope != "room" && hd.Scope != "self":
		return nil, bad("header scope must be member, room or self")
	case hd.InReplyTo != nil && !wire.IsUUID(*hd.InReplyTo):
		return nil, bad("header in_reply_to must be a uuid or null")
	case !wire.IsHex32(hd.CTSHA256):
		return nil, bad("header ct_sha256 must be 64 lowercase hex chars")
	}
	if wire.SHA256Hex(ct) != hd.CTSHA256 {
		return nil, bad("ct_sha256 does not match ct")
	}
	return e, nil
}

// VerifySig checks sig = Ed25519(sender, "botlink-env-v1\n" || h).
func (e *Envelope) VerifySig(senderEd []byte) error {
	if !wire.Verify(senderEd, Context, e.H, e.Sig) {
		return bad("signature does not verify with the sender's key")
	}
	return nil
}

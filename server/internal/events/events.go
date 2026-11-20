// Package events is bot-link Events (SPEC §6.13), the webhook mode of MCP Events (SEP-3415, draft): content-free event
// notifications a member subscribes a URL to, sent as Standard Webhooks messages (https://www.standardwebhooks.com):
// headers webhook-id, webhook-timestamp, webhook-signature ("v1," + base64 HMAC-SHA256 over "<id>.<timestamp>.<body>"),
// X-MCP-Subscription-Id; body {eventId, name, timestamp, data}. Control messages carry a top-level "type".
// It is the wake path that needs no process on the member's computer. An event never carries message text: it says
// that a sealed copy waits, and the chat reads it through its own bot-link client as always.
package events

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"
)

// Event names (MCP Events: `events/list`). The catalogue is also in GET /api/v1/me/events/subscriptions.
const (
	TypeMessage = "message.received" // a sealed message waits for the member (the wake signal)
	TypeRoster  = "roster.changed"   // the room's member list changed (a join, a leave, a move)
)

// Type describes one subscribable event.
type Type struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// Catalogue lists the subscribable events.
var Catalogue = []Type{
	{TypeMessage, "A sealed message is waiting for this member. Carries ids and names only, never the text: read it with the bot-link inbox."},
	{TypeRoster, "The room's member list changed (someone joined, left, was removed, or moved to a new chat)."},
}

// Subscribable reports whether name can be subscribed to.
func Subscribable(name string) bool {
	for _, c := range Catalogue {
		if c.Name == name {
			return true
		}
	}
	return false
}

// SubscriptionID derives the id from the subscription's key (SEP-3415: deterministic over principal, url, name,
// arguments), so subscribing again with the same key refreshes the same subscription.
func SubscriptionID(memberID, url, name string, urgentOnly bool) string {
	u := "0"
	if urgentOnly {
		u = "1"
	}
	sum := sha256.Sum256([]byte(memberID + "\n" + url + "\n" + name + "\n" + u))
	return "sub_" + hex.EncodeToString(sum[:12])
}

const secretPrefix = "whsec_"

// EncodeSecret renders a signing secret the Standard Webhooks way: "whsec_" + base64.
func EncodeSecret(raw []byte) string { return secretPrefix + base64.StdEncoding.EncodeToString(raw) }

// DecodeSecret parses "whsec_<base64>" (24..64 bytes).
func DecodeSecret(s string) ([]byte, error) {
	if !strings.HasPrefix(s, secretPrefix) {
		return nil, errors.New("secret must start with whsec_")
	}
	b64 := strings.TrimPrefix(s, secretPrefix)
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil { // without padding is fine too (the client's check takes both)
		raw, err = base64.RawStdEncoding.DecodeString(b64)
	}
	if err != nil || len(raw) < 24 || len(raw) > 64 {
		return nil, errors.New("secret must be whsec_ + base64 of 24 to 64 bytes")
	}
	return raw, nil
}

// Sign computes the webhook-signature value for one message.
func Sign(secret []byte, id string, ts int64, body []byte) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(id + "." + strconv.FormatInt(ts, 10) + "."))
	mac.Write(body)
	return "v1," + base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// SignAll signs with every secret (space-separated): after a refresh replaced the secret, the old one stays valid for
// a grace window so a receiver that hasn't switched yet still verifies.
func SignAll(secrets [][]byte, id string, ts int64, body []byte) string {
	parts := make([]string, 0, len(secrets))
	for _, k := range secrets {
		parts = append(parts, Sign(k, id, ts, body))
	}
	return strings.Join(parts, " ")
}

// Tolerance is how far webhook-timestamp may be from the receiver's clock.
const Tolerance = 5 * time.Minute

var (
	ErrBadSignature = errors.New("webhook signature doesn't verify")
	ErrStale        = errors.New("webhook timestamp is too far from now")
)

// Verify checks one received message: timestamp within Tolerance of now, and at least one "v1," signature in the
// space-separated header matches (constant time). It is what a receiver runs; the tests and `botlink events serve`
// (TypeScript twin) use the same rules.
func Verify(secret []byte, id, timestamp, signatureHeader string, body []byte, now time.Time) error {
	ts, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || id == "" {
		return ErrBadSignature
	}
	if d := now.Sub(time.Unix(ts, 0)); d > Tolerance || d < -Tolerance {
		return ErrStale
	}
	want := []byte(Sign(secret, id, ts, body))
	for _, got := range strings.Fields(signatureHeader) {
		if subtle.ConstantTimeCompare([]byte(got), want) == 1 {
			return nil
		}
	}
	return ErrBadSignature
}

// Package billing: the payment gateway behind config (off | fake | dodo), gateway event verification and the event
// rules that move an account's plan and credits (CONTRACT-PLANS.md).
//
// Event signatures follow Standard Webhooks, as Dodo Payments documents it (read 12 Nov 2026):
//
//	https://docs.dodopayments.com/developer-resources/webhooks ("Verifying Signatures", "Idempotency",
//	"Event Ordering") and https://docs.dodopayments.com/developer-resources/integration-guide ("Webhooks"):
//	1. signed content = "{webhook-id}.{webhook-timestamp}.{raw body}" (raw bytes, before any JSON parsing);
//	2. the secret: strip "whsec_", base64-decode the rest = the HMAC key;
//	3. HMAC-SHA256 of the signed content, base64-encoded;
//	4. "webhook-signature" holds one or more space-separated "v1,<base64>"; valid if any v1 matches (constant time);
//	5. reject a "webhook-timestamp" (unix seconds) too far from now; the Standard Webhooks libraries allow 5 minutes.
//
// Replay inside the window is stopped by the event id (billing_events primary key), never in memory.
package billing

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Tolerance is how far the event timestamp may be from now, either way.
const Tolerance = 5 * time.Minute

var (
	ErrBadSignature = errors.New("bad signature")
	ErrStale        = errors.New("stale timestamp")
)

// DecodeKey turns a "whsec_<base64>" secret into the HMAC key.
func DecodeKey(secret string) ([]byte, error) {
	s := strings.TrimPrefix(strings.TrimSpace(secret), "whsec_")
	k, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(k) == 0 {
		return nil, errors.New("the signing secret is not whsec_<base64>")
	}
	return k, nil
}

func mac(key []byte, id string, ts int64, body []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(id))
	h.Write([]byte{'.'})
	h.Write([]byte(strconv.FormatInt(ts, 10)))
	h.Write([]byte{'.'})
	h.Write(body)
	return h.Sum(nil)
}

// Sign returns the "webhook-signature" value for an event ("v1,<base64>").
func Sign(key []byte, id string, ts int64, body []byte) string {
	return "v1," + base64.StdEncoding.EncodeToString(mac(key, id, ts, body))
}

// Headers returns the three signed headers for an event (the fake gateway and tests use it).
func Headers(key []byte, id string, ts int64, body []byte) http.Header {
	h := http.Header{}
	h.Set("webhook-id", id)
	h.Set("webhook-timestamp", strconv.FormatInt(ts, 10))
	h.Set("webhook-signature", Sign(key, id, ts, body))
	h.Set("Content-Type", "application/json")
	return h
}

// Verify checks an event's headers and raw body. It returns the event id. The signature is checked before the
// timestamp, so an unsigned request never learns anything about the window.
func Verify(key []byte, h http.Header, body []byte, now time.Time) (string, error) {
	id, tsS, sigs := h.Get("webhook-id"), h.Get("webhook-timestamp"), h.Get("webhook-signature")
	if id == "" || tsS == "" || sigs == "" || len(id) > 200 {
		return "", ErrBadSignature
	}
	ts, err := strconv.ParseInt(tsS, 10, 64)
	if err != nil {
		return "", ErrBadSignature
	}
	want := mac(key, id, ts, body)
	ok := false
	for _, s := range strings.Fields(sigs) {
		ver, val, found := strings.Cut(s, ",")
		if !found || ver != "v1" {
			continue
		}
		got, err := base64.StdEncoding.DecodeString(val)
		if err != nil {
			continue
		}
		if hmac.Equal(got, want) {
			ok = true
		}
	}
	if !ok {
		return "", ErrBadSignature
	}
	d := now.Sub(time.Unix(ts, 0))
	if d > Tolerance || d < -Tolerance {
		return "", ErrStale
	}
	return id, nil
}

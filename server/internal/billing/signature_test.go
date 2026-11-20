package billing

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"testing"
	"time"
)

// The Standard Webhooks reference example (github.com/standard-webhooks/standard-webhooks, spec README).
func TestSignStandardWebhooksVector(t *testing.T) {
	key, err := DecodeKey("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw")
	if err != nil {
		t.Fatal(err)
	}
	got := Sign(key, "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, []byte(`{"test": 2432232314}`))
	if got != "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=" {
		t.Fatalf("signature %s", got)
	}
}

func newKey(t *testing.T) []byte {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	k, err := DecodeKey("whsec_" + base64.StdEncoding.EncodeToString(b))
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func TestVerify(t *testing.T) {
	key := newKey(t)
	body := []byte(`{"type":"subscription.active"}`)
	now := time.Now()
	ts := now.Unix()
	good := Headers(key, "evt_1", ts, body)
	if id, err := Verify(key, good, body, now); err != nil || id != "evt_1" {
		t.Fatalf("good: %q %v", id, err)
	}
	// several signatures, one valid (key rotation), unknown versions ignored
	multi := good.Clone()
	multi.Set("webhook-signature", "v1a,AAAA v1,"+base64.StdEncoding.EncodeToString(make([]byte, 32))+" "+good.Get("webhook-signature"))
	if _, err := Verify(key, multi, body, now); err != nil {
		t.Fatalf("multi: %v", err)
	}
	cases := map[string]func(h http.Header) ([]byte, []byte){
		"tampered body": func(h http.Header) ([]byte, []byte) { return key, []byte(`{"type":"subscription.expired"}`) },
		"other key":     func(h http.Header) ([]byte, []byte) { return newKey(t), body },
		"no signature":  func(h http.Header) ([]byte, []byte) { h.Del("webhook-signature"); return key, body },
		"other id":      func(h http.Header) ([]byte, []byte) { h.Set("webhook-id", "evt_2"); return key, body },
		"other time":    func(h http.Header) ([]byte, []byte) { h.Set("webhook-timestamp", "1"); return key, body },
		"v2 only": func(h http.Header) ([]byte, []byte) {
			h.Set("webhook-signature", "v2,"+h.Get("webhook-signature")[3:])
			return key, body
		},
	}
	for name, mod := range cases {
		h := good.Clone()
		k, b := mod(h)
		if _, err := Verify(k, h, b, now); !errors.Is(err, ErrBadSignature) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// correctly signed but outside the 5 minute window (both ways)
	for _, off := range []time.Duration{-6 * time.Minute, 6 * time.Minute} {
		ts := now.Add(off).Unix()
		if _, err := Verify(key, Headers(key, "evt_3", ts, body), body, now); !errors.Is(err, ErrStale) {
			t.Errorf("offset %v: %v", off, err)
		}
	}
	if _, err := Verify(key, Headers(key, "evt_4", now.Add(-4*time.Minute).Unix(), body), body, now); err != nil {
		t.Errorf("inside window: %v", err)
	}
}

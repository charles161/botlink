package events

import (
	"strings"
	"testing"
	"time"
)

// The Standard Webhooks reference vector (the same one the client's test checks): both sides must agree byte for byte.
const (
	vecSecret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"
	vecID     = "msg_p5jXN8AQM9LWM0D4loKWxJek"
	vecTS     = int64(1614265330)
	vecBody   = `{"test": 2432232314}`
	vecSig    = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE="
)

func TestSignReferenceVector(t *testing.T) {
	key, err := DecodeSecret(vecSecret)
	if err != nil {
		t.Fatal(err)
	}
	if got := Sign(key, vecID, vecTS, []byte(vecBody)); got != vecSig {
		t.Fatalf("signature %s, want %s", got, vecSig)
	}
	if EncodeSecret(key) != vecSecret {
		t.Fatal("secret round trip")
	}
}

func TestVerify(t *testing.T) {
	key, _ := DecodeSecret(vecSecret)
	other, _ := DecodeSecret("whsec_" + strings.Repeat("QUJD", 8))
	at := time.Unix(vecTS, 0)
	body := []byte(vecBody)
	if err := Verify(key, vecID, "1614265330", vecSig, body, at); err != nil {
		t.Fatal(err)
	}
	// any of several signatures (a secret being replaced)
	if err := Verify(key, vecID, "1614265330", SignAll([][]byte{other, key}, vecID, vecTS, body), body, at); err != nil {
		t.Fatal(err)
	}
	for name, c := range map[string]struct {
		id, ts, sig string
		body        []byte
		now         time.Time
		want        error
	}{
		"other secret":  {vecID, "1614265330", Sign(other, vecID, vecTS, body), body, at, ErrBadSignature},
		"changed body":  {vecID, "1614265330", vecSig, []byte(vecBody + " "), at, ErrBadSignature},
		"changed id":    {vecID + "x", "1614265330", vecSig, body, at, ErrBadSignature},
		"changed time":  {vecID, "1614265331", vecSig, body, at, ErrBadSignature},
		"too old":       {vecID, "1614265330", vecSig, body, at.Add(Tolerance + time.Second), ErrStale},
		"from future":   {vecID, "1614265330", vecSig, body, at.Add(-Tolerance - time.Second), ErrStale},
		"no signature":  {vecID, "1614265330", "", body, at, ErrBadSignature},
		"no id":         {"", "1614265330", vecSig, body, at, ErrBadSignature},
		"bad timestamp": {vecID, "soon", vecSig, body, at, ErrBadSignature},
	} {
		if err := Verify(key, c.id, c.ts, c.sig, c.body, c.now); err != c.want {
			t.Errorf("%s: %v, want %v", name, err, c.want)
		}
	}
}

func TestSecretsAndIDs(t *testing.T) {
	for _, bad := range []string{"", "hunter2", "whsec_", "whsec_c2hvcnQ=", "whsec_!!!!", "sec_" + strings.Repeat("QUJD", 8), "whsec_" + strings.Repeat("QUJD", 30)} {
		if _, err := DecodeSecret(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	a := SubscriptionID("m1", "https://x.example/h", TypeMessage, false)
	if a != SubscriptionID("m1", "https://x.example/h", TypeMessage, false) || len(a) != 28 || !strings.HasPrefix(a, "sub_") {
		t.Fatalf("id %s", a)
	}
	for _, b := range []string{
		SubscriptionID("m2", "https://x.example/h", TypeMessage, false),
		SubscriptionID("m1", "https://x.example/h2", TypeMessage, false),
		SubscriptionID("m1", "https://x.example/h", TypeRoster, false),
		SubscriptionID("m1", "https://x.example/h", TypeMessage, true),
	} {
		if a == b {
			t.Fatal("different keys, same id")
		}
	}
	if !Subscribable(TypeMessage) || !Subscribable(TypeRoster) || Subscribable("message.sent") || Subscribable("") {
		t.Fatal("catalogue")
	}
}

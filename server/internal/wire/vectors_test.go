package wire_test

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/charles161/botlink/server/internal/envelope"
	"github.com/charles161/botlink/server/internal/push"
	"github.com/charles161/botlink/server/internal/wire"
)

func load(t *testing.T, name string, v any) {
	b, err := os.ReadFile("../../../crypto/vectors/" + name)
	if err != nil {
		t.Skipf("crypto/vectors/%s not present yet", name)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatal(err)
	}
}

func unhex(t *testing.T, s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestFingerprintVectors(t *testing.T) {
	var v struct {
		FP16 []struct {
			In string `json:"input_utf8"`
			FP string `json:"fp"`
		} `json:"fp16"`
		Member []struct {
			Ed, X, FP string
		} `json:"member"`
		Device []struct {
			PK string `json:"pk"`
			FP string `json:"fp"`
		} `json:"device"`
		Alphabet string `json:"alphabet"`
	}
	load(t, "fingerprints.json", &v)
	for _, c := range v.FP16 {
		if got := wire.FP16([]byte(c.In)); got != c.FP {
			t.Errorf("fp16(%q) = %s, want %s", c.In, got, c.FP)
		}
	}
	for _, c := range v.Member {
		if got := wire.MemberFP(unhex(t, strings.ToLower(c.Ed)), unhex(t, strings.ToLower(c.X))); got != c.FP {
			t.Errorf("member fp %s", got)
		}
	}
	for _, c := range v.Device {
		if got := wire.DeviceFP(unhex(t, strings.ToLower(c.PK))); got != c.FP {
			t.Errorf("device fp %s", got)
		}
	}
	if v.Alphabet != "" && v.Alphabet != wire.Alphabet {
		t.Errorf("alphabet %s", v.Alphabet)
	}
	if len(v.FP16)+len(v.Member)+len(v.Device) == 0 {
		t.Fatal("no fingerprint cases")
	}
}

func TestReqSignVectors(t *testing.T) {
	var v struct {
		Seed  string `json:"seed"`
		Key   string `json:"key"`
		Cases []struct {
			Name, Method, Host, Target, Body, Nonce, Session string
			Time                                             int64
			BodySHA                                          string `json:"body_sha256"`
			STS                                              string `json:"string_to_sign"`
			Sig                                              string
		} `json:"cases"`
	}
	load(t, "req-sign.json", &v)
	priv := ed25519.NewKeyFromSeed(unhex(t, v.Seed))
	if hex.EncodeToString(priv.Public().(ed25519.PublicKey)) != v.Key {
		t.Fatal("seed does not give key")
	}
	for _, c := range v.Cases {
		if wire.SHA256Hex([]byte(c.Body)) != c.BodySHA {
			t.Errorf("%s: body sha", c.Name)
		}
		sts := wire.ReqStringToSign(c.Method, c.Host, c.Target, c.BodySHA, itoa(c.Time), c.Nonce, v.Key, c.Session)
		if string(sts) != c.STS {
			t.Errorf("%s: string to sign\n got %q\nwant %q", c.Name, sts, c.STS)
		}
		if hex.EncodeToString(ed25519.Sign(priv, sts)) != c.Sig || !ed25519.Verify(priv.Public().(ed25519.PublicKey), sts, unhex(t, c.Sig)) {
			t.Errorf("%s: signature", c.Name)
		}
	}
}

func itoa(n int64) string { b, _ := json.Marshal(n); return string(b) }

func TestPushVectors(t *testing.T) {
	var v struct {
		Secret string `json:"secret"`
		Cases  []struct {
			T      int64  `json:"t"`
			Body   string `json:"body"`
			V1     string `json:"v1"`
			Header string `json:"header"`
		} `json:"cases"`
	}
	load(t, "push.json", &v)
	for _, c := range v.Cases {
		if got := push.Signature(unhex(t, v.Secret), c.T, []byte(c.Body)); got != c.Header {
			t.Errorf("push sig %s, want %s", got, c.Header)
		}
	}
}

func TestEnvelopeVectors(t *testing.T) {
	var v struct {
		Sender struct {
			Ed string `json:"ed"`
		} `json:"sender"`
		Envelope json.RawMessage `json:"envelope"`
		Invalid  []struct {
			Name       string          `json:"name"`
			Envelope   json.RawMessage `json:"envelope"`
			VerifyWith string          `json:"verify_with"`
		} `json:"invalid"`
	}
	load(t, "envelope.json", &v)
	env, err := envelope.Parse(v.Envelope)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if err := env.VerifySig(unhex(t, v.Sender.Ed)); err != nil {
		t.Fatalf("valid envelope: %v", err)
	}
	for _, inv := range v.Invalid {
		key := v.Sender.Ed
		if inv.VerifyWith != "" {
			key = inv.VerifyWith
		}
		e, err := envelope.Parse(inv.Envelope)
		if err == nil {
			err = e.VerifySig(unhex(t, key))
		}
		if err == nil {
			t.Errorf("invalid envelope %s accepted", inv.Name)
		}
	}
	t.Logf("envelope vectors: valid ok, %d invalid rejected", len(v.Invalid))
}

// Package wire holds the byte-level primitives of crypto/ENVELOPE.md that the server needs:
// fingerprints, human codes, hex/base64 rules and request signing.
package wire

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
)

// Alphabet is the base32 alphabet for human codes (no 0/O/1/I).
const Alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

const EmptySHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

var (
	uuidRe       = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	hex32Re      = regexp.MustCompile(`^[0-9a-f]{64}$`)
	sigRe        = regexp.MustCompile(`^[0-9a-f]{128}$`)
	nonceRe      = regexp.MustCompile(`^[0-9a-f]{32}$`)
	sessionRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	fpRe         = regexp.MustCompile(`^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$`)
	b64urlRe     = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	MemberNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,23}$`)
	RoomNameRe   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)
	codeRe       = regexp.MustCompile(`^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]+$`)
)

func IsUUID(s string) bool        { return uuidRe.MatchString(s) }
func IsHex32(s string) bool       { return hex32Re.MatchString(s) }
func IsSig(s string) bool         { return sigRe.MatchString(s) }
func IsNonce(s string) bool       { return nonceRe.MatchString(s) }
func IsSessionID(s string) bool   { return sessionRe.MatchString(s) }
func IsFingerprint(s string) bool { return fpRe.MatchString(s) }

// FP16 = first 16 hex chars of sha256(b), grouped 4-4-4-4.
func FP16(b []byte) string {
	h := sha256.Sum256(b)
	x := hex.EncodeToString(h[:8])
	return x[0:4] + "-" + x[4:8] + "-" + x[8:12] + "-" + x[12:16]
}

// MemberFP = fp16(utf8(lower(ed_hex) + "|" + lower(x_hex))).
func MemberFP(ed, x []byte) string {
	return FP16([]byte(hex.EncodeToString(ed) + "|" + hex.EncodeToString(x)))
}

// DeviceFP = fp16(utf8("botlink-device-v1|" + lower(device_pk_hex))).
func DeviceFP(pk []byte) string { return FP16([]byte("botlink-device-v1|" + hex.EncodeToString(pk))) }

func SHA256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func SHA256(b []byte) []byte {
	h := sha256.Sum256(b)
	return h[:]
}

// RandCode returns n uniformly random characters of Alphabet (32 divides 256, so b&31 is unbiased).
func RandCode(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	for i := range b {
		b[i] = Alphabet[b[i]&31]
	}
	return string(b)
}

func RandBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

// ParseInviteCode extracts the code from a URL, "<slug>-<code>" or a bare code: last path segment, last
// '-'-separated part, uppercased; must be exactly n alphabet chars.
func ParseInviteCode(s string, n int) (string, bool) {
	s = strings.TrimSpace(s)
	if i := strings.IndexAny(s, "?#"); i >= 0 {
		s = s[:i]
	}
	s = strings.TrimRight(s, "/")
	if i := strings.LastIndex(s, "/"); i >= 0 {
		s = s[i+1:]
	}
	if i := strings.LastIndex(s, "-"); i >= 0 {
		s = s[i+1:]
	}
	s = strings.ToUpper(s)
	if len(s) != n || !codeRe.MatchString(s) {
		return "", false
	}
	return s, true
}

// DecodeHex32 decodes 64 lowercase hex chars.
func DecodeHex32(s string) ([]byte, bool) {
	if !IsHex32(s) {
		return nil, false
	}
	b, _ := hex.DecodeString(s)
	return b, true
}

func DecodeSig(s string) ([]byte, bool) {
	if !IsSig(s) {
		return nil, false
	}
	b, _ := hex.DecodeString(s)
	return b, true
}

// DecodeB64URL decodes base64url without padding, strictly (canonical encodings only).
func DecodeB64URL(s string) ([]byte, error) {
	if !b64urlRe.MatchString(s) {
		return nil, errors.New("not base64url")
	}
	b, err := base64.RawURLEncoding.Strict().DecodeString(s)
	if err != nil {
		return nil, err
	}
	return b, nil
}

func B64URL(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// DecodeB64Std decodes standard base64 with padding.
func DecodeB64Std(s string) ([]byte, error) { return base64.StdEncoding.Strict().DecodeString(s) }

// Verify checks Ed25519(pk, context || "\n" || msg).
func Verify(pk []byte, context string, msg, sig []byte) bool {
	if len(pk) != ed25519.PublicKeySize || len(sig) != ed25519.SignatureSize {
		return false
	}
	buf := make([]byte, 0, len(context)+1+len(msg))
	buf = append(buf, context...)
	buf = append(buf, '\n')
	buf = append(buf, msg...)
	return ed25519.Verify(ed25519.PublicKey(pk), buf, sig)
}

// Sign is the counterpart of Verify (used by tests and test kits; the server never signs).
func Sign(sk ed25519.PrivateKey, context string, msg []byte) []byte {
	buf := make([]byte, 0, len(context)+1+len(msg))
	buf = append(buf, context...)
	buf = append(buf, '\n')
	buf = append(buf, msg...)
	return ed25519.Sign(sk, buf)
}

// ReqStringToSign builds the ENVELOPE §3 string (no trailing newline). The context tag is line 1.
func ReqStringToSign(method, host, target, bodySHA, t, nonce, key, session string) []byte {
	return []byte(strings.Join([]string{"botlink-req-v1", strings.ToUpper(method), strings.ToLower(host), target,
		bodySHA, t, nonce, key, session}, "\n"))
}

// NewV7 returns a server-side UUIDv7.
func NewV7() uuid.UUID {
	id, err := uuid.NewV7()
	if err != nil {
		panic(err)
	}
	return id
}

// AppNameOK bounds the unsigned app_name of an "other" chat (display data): 1-40 characters after trimming, no
// control, bidi-override or zero-width characters, no leading/trailing space, no "<<<" / ">>>" fence look-alikes.
func AppNameOK(s string) bool {
	if s == "" || strings.TrimSpace(s) != s || !utf8.ValidString(s) || utf8.RuneCountInString(s) > 40 {
		return false
	}
	if strings.Contains(s, "<<<") || strings.Contains(s, ">>>") {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) || (r >= 0x200b && r <= 0x200f) || (r >= 0x202a && r <= 0x202e) || (r >= 0x2060 && r <= 0x2069) || r == 0xfeff || r == 0x061c {
			return false
		}
	}
	return true
}

// OneLineTextOK: every character is visible text on one line. No control characters (line breaks and tabs
// included), no format characters (zero-width, direction overrides and isolates, the byte-order mark, soft hyphen),
// no line or paragraph separators. For text a chat writes that other chats and people then read (a room draft's
// purpose): what is shown is what is there.
func OneLineTextOK(s string) bool {
	if !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || unicode.Is(unicode.Zl, r) || unicode.Is(unicode.Zp, r) {
			return false
		}
	}
	return true
}

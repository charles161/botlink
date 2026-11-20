// Package clientgate refuses agent API calls from a client whose installed release is older than the server's
// minimum (BOTLINK_MIN_CLIENT_RELEASE, a release number; empty or 0 = off, the default). SPEC §7.6 "Minimum client
// release".
//
// Why a release number and not the version: every build says the same version (1.0.0), so a version cannot tell an old client
// from a new one. Signed releases carry a number that only goes up (`counter` in the signed manifest,
// deploy/release-sign.mjs), and an installed client keeps the number of the release it runs (`.counter` in its
// install folder, client/src/update.ts). The client sends it in X-Botlink-Client-Release, and its version string in
// X-Botlink-Client-Version (for logs only; never compared).
//
// A client with no release number (one from before the header, a checkout, a global npm install, an npx copy before
// its first signed update) sends no X-Botlink-Client-Release. On a dev server (BOTLINK_ENV=dev) it passes, so a
// development build is not locked out; anywhere else "no number" is never taken for new: it is refused like an old
// one, and the update it is told to run gives it a number. A numbered release below the minimum is refused
// everywhere.
//
// A refused call gets 426 client_too_old with a plain sentence: clients that know the code say "too old, run the
// update" and try one signed self-update; older clients show the server's sentence quoted, and they do not retry a
// 4xx. Only /api/v1/ is behind the gate: the download (/dl/), the signed manifest, /healthz and /readyz are outside
// it, so a too-old client can always update. At start, a minimum above the newest published release (the counter in
// the signed manifest next to the served tarball) is refused (no client could ever pass); a newest release it
// cannot read is a loud warning.
package clientgate

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/charles161/botlink/server/internal/httpx"
)

// Header carries the release number of the client copy that sends it (the signed manifest's counter it was
// installed from). VersionHeader carries its package.json version, for logs only.
const (
	Header        = "X-Botlink-Client-Release"
	VersionHeader = "X-Botlink-Client-Version"
)

// Code is the error code of a refused call; Status is its HTTP status (426 Upgrade Required).
const (
	Code   = "client_too_old"
	Status = http.StatusUpgradeRequired
)

// exempt paths under /api/v1/ that are not a client acting (a health probe).
var exempt = map[string]bool{"/api/v1/health": true}

var releaseRE = regexp.MustCompile(`^[1-9][0-9]{0,14}$`)

// ParseRelease reads a release number: a whole number from 1, no sign, no leading zero, at most 15 digits.
func ParseRelease(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if !releaseRE.MatchString(s) {
		return 0, false
	}
	n, err := strconv.ParseInt(s, 10, 64)
	return n, err == nil
}

// NewestRelease is the release number clients can update to from this server: the counter in the signed manifest
// next to the served tarball (what the self-update installs). src is the file it came from. A tarball with no
// signed manifest has no release number (clients refuse to install it anyway).
func NewestRelease(clientTGZ string) (n int64, src string, err error) {
	if clientTGZ == "" {
		return 0, "", errors.New("this server serves no client (BOTLINK_CLIENT_TGZ and BOTLINK_DL_DIR are unset)")
	}
	real, err := filepath.EvalSymlinks(clientTGZ)
	if err != nil {
		return 0, "", fmt.Errorf("the client tarball %s: %w", clientTGZ, err)
	}
	mpath := filepath.Join(filepath.Dir(real), "botlink.manifest.json")
	b, err := readCapped(mpath, 64<<10)
	if err != nil {
		return 0, "", fmt.Errorf("no signed release next to the client tarball (%s): %w", mpath, err)
	}
	var doc struct {
		Manifest string `json:"manifest"`
	}
	var m struct {
		Counter int64 `json:"counter"`
	}
	if json.Unmarshal(b, &doc) != nil || json.Unmarshal([]byte(doc.Manifest), &m) != nil || m.Counter < 1 {
		return 0, "", fmt.Errorf("the signed release %s has no release number", mpath)
	}
	return m.Counter, mpath, nil
}

func readCapped(p string, max int64) ([]byte, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, max))
}

// Gate is the minimum-release check. The zero value (and a nil *Gate) lets everything through.
type Gate struct {
	min    int64
	dev    bool
	reject *httpx.Error
}

// New checks the setting at server start. Empty or 0 = off. dev: a client with no release number passes (a
// development build on a dev server). A value that is not a release number, or one above the newest published
// release, is an error (the server does not start). A newest release it cannot read is a loud warning.
func New(min string, dev bool, clientTGZ string) (*Gate, error) {
	min = strings.TrimSpace(min)
	if min == "" || min == "0" {
		return &Gate{}, nil
	}
	mn, ok := ParseRelease(min)
	if !ok {
		return nil, fmt.Errorf("BOTLINK_MIN_CLIENT_RELEASE: %q is not a release number (a whole number like 12: the counter of a signed release, deploy/release-sign.mjs)", min)
	}
	newest, src, err := NewestRelease(clientTGZ)
	if err != nil {
		slog.Warn("BOTLINK_MIN_CLIENT_RELEASE is set but the newest published release can't be read: clients below the minimum may have nothing to update to",
			"min", mn, "err", err.Error())
	} else if mn > newest {
		return nil, fmt.Errorf("BOTLINK_MIN_CLIENT_RELEASE %d is above the newest published client (release %d, from %s): every client would be refused and none could update to a release this server accepts. Publish that release first, or lower the minimum", mn, newest, src)
	}
	slog.Info("minimum client release on", "min", mn, "published", newest, "no_number_passes", dev)
	msg := fmt.Sprintf("This copy of bot-link is too old for this server (it needs release %d or newer). Run: botlink update. Or run the install command from the invite page again. Then restart the app it runs in.", mn)
	return &Gate{min: mn, dev: dev, reject: httpx.E(Status, Code, msg).With("min_release", mn).With("update", "botlink update")}, nil
}

// On reports whether a minimum is set.
func (g *Gate) On() bool { return g != nil && g.min > 0 }

// Allowed reports whether a client that sent this X-Botlink-Client-Release value may call the agent API.
func (g *Gate) Allowed(release string) bool {
	if !g.On() {
		return true
	}
	n, ok := ParseRelease(release)
	if !ok {
		return g.dev // no release number: a development build passes only on a dev server
	}
	return n >= g.min
}

// Wrap puts the gate in front of the agent API (mount it on /api/v1/ only).
func (g *Gate) Wrap(next http.Handler) http.Handler {
	if !g.On() {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if exempt[r.URL.Path] || g.Allowed(r.Header.Get(Header)) {
			next.ServeHTTP(w, r)
			return
		}
		slog.Debug("client below the minimum release", "release", capped(r.Header.Get(Header)), "version", capped(r.Header.Get(VersionHeader)), "min", g.min)
		e := *g.reject
		httpx.WriteError(w, r, &e)
	})
}

// capped: a header value as a log field (the client chooses it; at most 40 bytes).
func capped(s string) string {
	if len(s) > 40 {
		return s[:40]
	}
	return s
}

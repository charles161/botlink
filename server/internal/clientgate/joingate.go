package clientgate

// The join gate (incident 21 Nov 2026): a chat ran last release's client from npx's cache (npx never fetches a URL
// spec again), joined with the old code, and nothing told it or its human. Old clients cannot be changed; only the
// server reaches them, and they show a server error's message to the model. So:
//
//   - Every agent API answer names the client this server hands out now: CurrentHeader (its version),
//     CurrentURLHeader (its versioned download URL, a spec npx has never cached) and CurrentReleaseHeader (its signed
//     release number). A client from 1.0.1 on compares its own version with it on every call it already makes.
//   - Joining, creating a room and moving a chat are where an old client does damage, so only those three are refused
//     (409 client_outdated, a message with the exact command), never reading or sending:
//       a. a client whose version is below BOTLINK_MIN_JOIN_CLIENT_VERSION (empty = off, the default). Outside dev, a
//          client that sends no version (one from before 16 Nov 2026, when the version header came in) is below
//          every minimum; on a dev server it passes.
//       b. a client that asks for it (StaleHeader: refuse, sent from 1.0.1 on) and is older than the client this
//          server hands out. No setting: from 1.0.1 on, every release protects itself.
//
// Versions can be compared because every client release has its own version (client/scripts/release-version.mjs,
// deploy/lib/build.sh check_client_version).

import (
	"encoding/json"
	"fmt"
	"github.com/charles161/botlink/server/internal/clientcmd"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/charles161/botlink/server/internal/httpx"
)

const (
	// CurrentHeader carries the version of the client this server hands out now; CurrentURLHeader its versioned
	// download URL; CurrentReleaseHeader its signed release number (absent when unknown).
	CurrentHeader        = "X-Botlink-Client-Current"
	CurrentURLHeader     = "X-Botlink-Client-Url"
	CurrentReleaseHeader = "X-Botlink-Client-Current-Release"
	// StaleHeader: "refuse" asks the server to refuse this client's join, room draft and move when it is older than
	// the client the server hands out (sent by clients from 1.0.1 on).
	StaleHeader = "X-Botlink-Client-Stale"
	// OutdatedCode / OutdatedStatus: a refused join, room draft or move. Not 426: clients before 1.0.1 replace a 426's
	// message with their own "too old, update" text; a 409 with an unknown code reaches the model as the server's words.
	OutdatedCode   = "client_outdated"
	OutdatedStatus = http.StatusConflict
)

// Current is the client this server hands out now. Zero value: none (no tarball served).
type Current struct {
	Version string
	URL     string
	Release int64
}

// the agent API calls where an old client does damage: a join, a room started by a chat, a member moved to a chat
var joinGated = map[string]bool{
	"POST /api/v1/join-requests": true,
	"POST /api/v1/room-drafts":   true,
	"POST /api/v1/me/claim":      true,
}

// JoinGate is the join gate. A nil *JoinGate passes everything and sets no header.
type JoinGate struct {
	min     *Version
	dev     bool
	current func() Current
}

// NewJoinGate checks BOTLINK_MIN_JOIN_CLIENT_VERSION at start: empty = off; not a version (x.y.z) = an error; above the
// version of the newest published client (the signed manifest next to clientTGZ) = an error, as no client could join;
// a newest client it cannot read is a loud warning.
func NewJoinGate(min string, dev bool, clientTGZ string) (*JoinGate, error) {
	g := &JoinGate{dev: dev}
	min = strings.TrimSpace(min)
	if min == "" {
		return g, nil
	}
	mv, ok := ParseVersion(min)
	if !ok {
		return nil, fmt.Errorf("BOTLINK_MIN_JOIN_CLIENT_VERSION: %q is not a client version (x.y.z, like 1.0.1: the version in client/package.json of a released client)", min)
	}
	pub, src, err := publishedVersion(clientTGZ)
	if err != nil {
		slog.Warn("BOTLINK_MIN_JOIN_CLIENT_VERSION is set but the newest published client's version can't be read: clients below the minimum may have nothing to update to", "min", min, "err", err.Error())
	} else if pv, ok := ParseVersion(pub); !ok || Compare(mv, pv) > 0 {
		return nil, fmt.Errorf("BOTLINK_MIN_JOIN_CLIENT_VERSION %s is above the newest published client (%s, from %s): no client could join. Publish that client first, or lower the minimum", min, pub, src)
	}
	g.min = &mv
	slog.Info("minimum client version for joins on", "min", min, "published", pub, "no_version_passes", dev)
	return g, nil
}

// WithCurrent returns the gate with the source of the client this server hands out (nil: none).
func (g *JoinGate) WithCurrent(f func() Current) *JoinGate {
	if g == nil {
		g = &JoinGate{}
	}
	c := *g
	c.current = f
	return &c
}

// Outdated reports whether a call to pattern ("METHOD /path") from a client with these headers is refused, and why.
func (g *JoinGate) Outdated(pattern string, h http.Header, cur Current) (bool, string) {
	if g == nil || !joinGated[pattern] {
		return false, ""
	}
	cv, ok := ParseVersion(h.Get(VersionHeader))
	if g.min != nil {
		if !ok && !g.dev {
			return true, "no_version"
		}
		if ok && Compare(cv, *g.min) < 0 {
			return true, "below_minimum"
		}
	}
	if ok && strings.EqualFold(strings.TrimSpace(h.Get(StaleHeader)), "refuse") {
		if pv, pok := ParseVersion(cur.Version); pok && Compare(cv, pv) < 0 {
			return true, "behind_current"
		}
	}
	return false, ""
}

// OutdatedMax: clients before 1.0.1 quote a server's message up to 240 characters.
const OutdatedMax = 240

// OutdatedText is the refusal a weak model cannot misread, within OutdatedMax: the exact command (clientcmd.Npx, as
// every printed command), and not to retry the old one. The client's version is named only while it fits.
func OutdatedText(clientVersion string, cur Current) string {
	tail := " Do not retry the old command: it runs the old copy again."
	body := " is out of date. Run the install command from the invite page again, then the same command." + tail
	if cur.URL != "" {
		body = " is out of date. Run exactly: " + clientcmd.Npx(cur.URL) + " <the same command and arguments>." + tail
	}
	who := "This bot-link client"
	if v, ok := ParseVersion(clientVersion); ok && len(v.String()) <= 20 && len(who)+len(v.String())+3+len(body) <= OutdatedMax {
		who += " (" + v.String() + ")"
	}
	return who + body
}

// Wrap puts the gate in front of the agent API (mount it on /api/v1/ only, outside the minimum-release gate so its
// answers carry the headers too).
func (g *JoinGate) Wrap(next http.Handler) http.Handler {
	if g == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var cur Current
		if g.current != nil {
			cur = g.current()
		}
		if cur.Version != "" {
			hd := w.Header()
			hd.Set(CurrentHeader, cur.Version)
			if cur.URL != "" {
				hd.Set(CurrentURLHeader, cur.URL)
			}
			if cur.Release > 0 {
				hd.Set(CurrentReleaseHeader, strconv.FormatInt(cur.Release, 10))
			}
		}
		if out, why := g.Outdated(r.Method+" "+r.URL.Path, r.Header, cur); out {
			v := capped(r.Header.Get(VersionHeader))
			slog.Info("join from an outdated client refused", "path", r.URL.Path, "client_version", v, "why", why, "current", cur.Version)
			e := httpx.E(OutdatedStatus, OutdatedCode, OutdatedText(r.Header.Get(VersionHeader), cur)).With("reason", why)
			if cur.Version != "" {
				e = e.With("current_version", cur.Version)
			}
			if cur.URL != "" {
				e = e.With("url", cur.URL)
			}
			if g.min != nil {
				e = e.With("min_version", g.min.String())
			}
			httpx.WriteError(w, r, e)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Cached calls f at most once per ttl (the client file is stat'ed and the manifest read once, not per API call).
func Cached(ttl time.Duration, f func() Current) func() Current {
	var mu sync.Mutex
	var at time.Time
	var last Current
	return func() Current {
		mu.Lock()
		defer mu.Unlock()
		if at.IsZero() || time.Since(at) >= ttl {
			last, at = f(), time.Now()
		}
		return last
	}
}

// publishedVersion: the version in the signed manifest next to the served tarball.
func publishedVersion(clientTGZ string) (string, string, error) {
	_, src, err := NewestRelease(clientTGZ)
	if err != nil {
		return "", "", err
	}
	b, err := readCapped(src, 64<<10)
	if err != nil {
		return "", "", err
	}
	var doc struct {
		Manifest string `json:"manifest"`
	}
	var m struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(b, &doc) != nil || json.Unmarshal([]byte(doc.Manifest), &m) != nil || m.Version == "" {
		return "", "", fmt.Errorf("the signed release %s names no version", src)
	}
	return m.Version, src, nil
}

// Version is a client version: x.y.z with an optional pre-release (1.0.0-dev sorts below 1.0.0).
type Version struct {
	Major, Minor, Patch int64
	Pre                 string
}

var versionRE = regexp.MustCompile(`^v?(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(?:-([0-9A-Za-z.-]{1,40}))?(?:\+[0-9A-Za-z.-]{1,40})?$`)

// ParseVersion reads a version as clients send it (X-Botlink-Client-Version).
func ParseVersion(s string) (Version, bool) {
	m := versionRE.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return Version{}, false
	}
	a, _ := strconv.ParseInt(m[1], 10, 64)
	b, _ := strconv.ParseInt(m[2], 10, 64)
	c, _ := strconv.ParseInt(m[3], 10, 64)
	return Version{a, b, c, m[4]}, true
}

func (v Version) String() string {
	s := fmt.Sprintf("%d.%d.%d", v.Major, v.Minor, v.Patch)
	if v.Pre != "" {
		s += "-" + v.Pre
	}
	return s
}

// Compare orders versions as semver does: -1, 0 or 1.
func Compare(a, b Version) int {
	for _, d := range [][2]int64{{a.Major, b.Major}, {a.Minor, b.Minor}, {a.Patch, b.Patch}} {
		if d[0] != d[1] {
			if d[0] < d[1] {
				return -1
			}
			return 1
		}
	}
	switch {
	case a.Pre == b.Pre:
		return 0
	case a.Pre == "":
		return 1
	case b.Pre == "":
		return -1
	}
	x, y := strings.Split(a.Pre, "."), strings.Split(b.Pre, ".")
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] == y[i] {
			continue
		}
		xn, xe := strconv.ParseInt(x[i], 10, 64)
		yn, ye := strconv.ParseInt(y[i], 10, 64)
		switch {
		case xe == nil && ye == nil:
			if xn < yn {
				return -1
			}
			return 1
		case xe == nil:
			return -1
		case ye == nil:
			return 1
		case x[i] < y[i]:
			return -1
		default:
			return 1
		}
	}
	switch {
	case len(x) < len(y):
		return -1
	case len(x) > len(y):
		return 1
	}
	return 0
}

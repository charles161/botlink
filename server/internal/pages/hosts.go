package pages

import (
	"net"
	"net/http"
	"sort"
	"strings"

	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/httpx"
)

// The host table: which host owns each path once the public site (BOTLINK_SITE_HOST, botlink.dev), the app
// (BOTLINK_APP_HOST, app.botlink.dev) and the agent API (BOTLINK_API_HOST, api.botlink.dev) are separate hosts.
// HostSplit serves, redirects and refuses from this table alone, and a path the table does not name answers 404 on
// every host, in every mode. Tests fail for a registered route or a web/public file the table does not name
// (hosts_test.go), and the dashboard's router reads the same rows (web/public/assets/js/hosts.js, generated).

// Owner of a path.
type Owner string

const (
	Site Owner = "site" // the public site: landing page, docs, legal pages
	App  Owner = "app"  // the product: rooms, approvals, account, admin, invite links, /app/v1
	API  Owner = "api"  // the agents' API and the client download
	Web  Owner = "web"  // both browser hosts (site and app): shared files their pages load, and "/"
	All  Owner = "all"  // every host: health checks and the agent docs (agents fetch them from any of the three)
)

// Kind of a path: what happens when it is asked on a host that does not own it.
type Kind string

const (
	Page Kind = "page" // the dashboard's index.html, drawn by its router; moves to its host with a 301
	File Kind = "file" // a file or a document; moves to its host with a 301
	Call Kind = "call" // called by programs: 404 on any other host, never a redirect (the client refuses redirects)
)

// HostRoute is one row. Path: an exact path; ending in "/": every path under it; "{name}": one non-empty segment.
type HostRoute struct {
	Path  string
	Owner Owner
	Kind  Kind
}

// HostTable: every path the server answers. A new route or a new file in web/public goes here first.
var HostTable = []HostRoute{
	{"/", Web, Page}, // site: the landing page; app: the rooms list signed in, the sign-in page signed out

	{"/docs", Site, Page},
	{"/security.html", Site, File},
	{"/privacy.html", Site, File},
	{"/terms.html", Site, File},
	{"/trust.html", Site, File},
	{"/pricing.html", Site, File},
	{"/pages.css", Site, File},
	{"/pricing.css", Site, File},

	{"/favicon.ico", Web, File},
	{"/apple-touch-icon.png", Web, File},
	{"/og-image.png", Web, File},
	{"/manifest.json", Web, File},
	{"/assets/", Web, File},

	{"/agents.md", All, File},
	{"/llms.txt", All, File},
	{"/envelope.md", All, File},
	{"/api/openapi.yaml", All, File},
	{"/healthz", All, Call},
	{"/readyz", All, Call},

	{"/login", App, Page},
	{"/rooms", App, Page},
	{"/rooms/{id}", App, Page},
	{"/new", App, Page},
	{"/p/{code}", App, Page},
	{"/devices", App, Page},
	{"/admin", App, Page},
	{"/approve/{id}", App, Page},
	{"/create/{id}", App, Page},      // a room a chat asked for: the person confirms it (docs/protocol/room-drafts.md §4)
	{"/approve-url/{id}", App, Page}, // an event address a chat asked for: its person approves it (docs/protocol/event-url-approval.md §2)
	{"/usage", App, Page},
	{"/billing", App, Page},
	{"/billing/fake", App, Page},
	{"/billing/fake/portal", App, Page},
	{"/account", App, Page},
	{"/help/lost-passkey", App, Page},
	{"/i/{invite}", App, File}, // invite links: made on the app host (BOTLINK_APP_ORIGIN/i/…), read by people and agents
	{"/app/v1/", App, Call},

	{"/api/v1/", API, Call},
	{"/dl/", API, Call},
}

func (r HostRoute) prefix() bool   { return strings.HasSuffix(r.Path, "/") && r.Path != "/" }
func (r HostRoute) wildcard() bool { return strings.Contains(r.Path, "{") }

func (r HostRoute) match(p string) bool {
	switch {
	case r.prefix():
		return strings.HasPrefix(p, r.Path)
	case r.wildcard():
		want, got := strings.Split(r.Path, "/"), strings.Split(p, "/")
		if len(want) != len(got) {
			return false
		}
		for i := range want {
			if strings.HasPrefix(want[i], "{") {
				if got[i] == "" {
					return false
				}
			} else if want[i] != got[i] {
				return false
			}
		}
		return true
	}
	return r.Path == p
}

// LookupHost: the row for a path (exact rows first, then one-segment patterns, then the longest prefix).
func LookupHost(p string) (HostRoute, bool) {
	var best HostRoute
	found := false
	for _, r := range HostTable {
		if !r.prefix() && !r.wildcard() && r.Path == p {
			return r, true
		}
	}
	for _, r := range HostTable {
		if r.wildcard() && r.match(p) {
			return r, true
		}
	}
	for _, r := range HostTable {
		if r.prefix() && r.match(p) && len(r.Path) > len(best.Path) {
			best, found = r, true
		}
	}
	return best, found
}

// RequestHost is the request's host name, lower-cased, without a port. Only the Host header: no forwarded-host
// header is read (the tunnel passes the visitor's Host through; anything else in front could forge one).
func RequestHost(r *http.Request) string {
	host := strings.ToLower(r.Host)
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return host
}

// hosts is the configured layout. split: BOTLINK_APP_HOST and BOTLINK_API_HOST are set. site: BOTLINK_SITE_HOST too.
type hosts struct {
	split               bool
	app, api, site      string
	appOrigin, siteOrig string
}

func hostsOf(cfg *config.Config) hosts {
	if cfg == nil || cfg.AppHost == "" {
		return hosts{}
	}
	return hosts{split: true, app: strings.ToLower(cfg.AppHost), api: strings.ToLower(cfg.APIHost), site: strings.ToLower(cfg.SiteHost),
		appOrigin: cfg.AppOrigin, siteOrig: cfg.SiteOrigin()}
}

// role of the request's host: Site, App or API; "" for any other host. One host (no split): App.
func (h hosts) role(r *http.Request) Owner {
	if !h.split {
		return App
	}
	switch RequestHost(r) {
	case h.app:
		return App
	case h.api:
		return API
	case h.site:
		if h.site != "" {
			return Site
		}
	}
	return ""
}

// serves: does a host of this role answer a path of this owner itself?
func (h hosts) serves(role Owner, o Owner) bool {
	if !h.split {
		return true
	}
	switch o {
	case All:
		return role != ""
	case Web:
		return role == Site || role == App
	case Site:
		return role == Site || (role == App && h.site == "") // no site host: the app host is the site
	}
	return role == o
}

// moveTo: the origin a page or file asked on the wrong browser host moves to ("" = 404). Never the request's own
// host or a value from the request: only the two configured origins.
func (h hosts) moveTo(role Owner, rt HostRoute) string {
	if rt.Kind == Call || h.site == "" {
		return ""
	}
	switch {
	case role == Site && rt.Owner == App:
		return h.appOrigin
	case role == App && rt.Owner == Site:
		return h.siteOrig
	}
	return ""
}

// HostSplit routes by the host table: serve, move with a 301 to the same path and query on the owning host, or 404.
func HostSplit(cfg *config.Config, next http.Handler) http.Handler {
	h := hostsOf(cfg)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rt, ok := LookupHost(r.URL.Path)
		if !ok {
			httpx.WriteError(w, r, httpx.NotFound())
			return
		}
		role := h.role(r)
		if h.serves(role, rt.Owner) {
			next.ServeHTTP(w, r)
			return
		}
		if to := h.moveTo(role, rt); to != "" && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
			// no-store: a browser asks again next time, so turning the split off (an empty BOTLINK_SITE_HOST) is undone
			// at once instead of living on in every browser that saw a cached 301
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Location", to+r.URL.RequestURI())
			w.WriteHeader(http.StatusMovedPermanently)
			return
		}
		httpx.WriteError(w, r, httpx.NotFound())
	})
}

// Content-Security-Policy per host. The app: the dashboard, with Turnstile (the human check) and the sign-in
// providers' avatars. The site: the landing page and docs fetch only their own files; no Turnstile, no frames, no
// forms. The API host serves JSON, Markdown and downloads: nothing for a page to run.
const (
	CSP = "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; " +
		"style-src 'self' 'unsafe-inline'; img-src 'self' data: https://avatars.githubusercontent.com https://lh3.googleusercontent.com; " +
		"connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
	SiteCSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
		"frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
	APICSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
	// SitePermissions: no page on the site host may start a passkey ceremony (passkeys belong to the app host).
	SitePermissions = "publickey-credentials-get=(), publickey-credentials-create=()"
)

// SecurityHeaders: the CSP of the request's host on every response, HSTS where cookies are Secure, and noindex
// except the open docs and the landing (with a site host: everything on the site, nothing on the app host).
func SecurityHeaders(cfg *config.Config, next http.Handler) http.Handler {
	indexable := map[string]bool{"/": true, "/agents.md": true, "/llms.txt": true, "/envelope.md": true}
	for _, rt := range HostTable {
		if rt.Owner == Site && rt.Kind == File && strings.HasSuffix(rt.Path, ".html") {
			indexable[rt.Path] = true
		}
	}
	h := hostsOf(cfg)
	hsts := cfg != nil && cfg.SecureCookies()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("X-Content-Type-Options", "nosniff")
		hd.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		hd.Set("X-Frame-Options", "DENY")
		if hsts {
			// HTTPS only from the first visit on, for a year (not subdomains: other hosts of the domain are not ours)
			hd.Set("Strict-Transport-Security", "max-age=31536000")
		}
		index := indexable[r.URL.Path]
		switch role := h.role(r); {
		case role == Site:
			hd.Set("Content-Security-Policy", SiteCSP)
			hd.Set("Permissions-Policy", SitePermissions)
			index = true
		case role == App:
			hd.Set("Content-Security-Policy", CSP)
			if h.site != "" {
				index = false
			}
		default: // the API host, or a host that is none of ours
			hd.Set("Content-Security-Policy", APICSP)
		}
		if !index {
			hd.Set("X-Robots-Tag", "noindex")
		}
		next.ServeHTTP(w, r)
	})
}

// DashboardHostsJS: web/public/assets/js/hosts.js, the table for the dashboard's router (hosts_test.go keeps the
// file equal to it).
func DashboardHostsJS() []byte {
	rows := append([]HostRoute(nil), HostTable...)
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].Path < rows[j].Path })
	var b strings.Builder
	b.WriteString(`// The host table (server/internal/pages/hosts.go), for the dashboard's router. Generated; do not edit. After a change
// to the table: BOTLINK_WRITE_HOSTS=1 go test ./server/internal/pages -run TestDashboardHostsFile
export const HOST_TABLE = [
`)
	for _, r := range rows {
		b.WriteString(`  ["` + r.Path + `", "` + string(r.Owner) + `", "` + string(r.Kind) + `"],` + "\n")
	}
	b.WriteString(`];

const isPrefix = (p) => p.endsWith("/") && p !== "/";
const isPattern = (p) => p.includes("{");
function matches(row, path) {
  if (isPrefix(row)) return path.startsWith(row);
  if (!isPattern(row)) return row === path;
  const want = row.split("/"), got = path.split("/");
  return want.length === got.length && want.every((w, i) => (w.startsWith("{") ? got[i] !== "" : w === got[i]));
}

/** The row for a path: {path, owner, kind}, or null when no host serves it. Same order as the server: exact, pattern, longest prefix. */
export function hostRoute(path) {
  const pick = (r) => (r ? { path: r[0], owner: r[1], kind: r[2] } : null);
  const exact = HOST_TABLE.find(([p]) => !isPrefix(p) && !isPattern(p) && p === path);
  if (exact) return pick(exact);
  const pattern = HOST_TABLE.find(([p]) => isPattern(p) && matches(p, path));
  if (pattern) return pick(pattern);
  return pick(HOST_TABLE.filter(([p]) => isPrefix(p) && matches(p, path)).sort((a, b) => b[0].length - a[0].length)[0]);
}
`)
	return []byte(b.String())
}

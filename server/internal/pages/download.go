package pages

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/charles161/botlink/server/internal/httpx"
)

// ClientFile is the client tarball served at /dl/botlink.tgz (deploy/NEEDS.md item 4) and described at
// /dl/botlink.json (the client's self-update check, CONTRACT-CHANGES 2026-11-06). The file is opened per request, so a
// `current` symlink follows deploys and rollbacks; sha256 and version are cached per (size, mtime).
type ClientFile struct {
	path string
	mu   sync.Mutex
	last clientSum
}

type clientSum struct {
	size    int64
	mtime   time.Time
	sha     string // lowercase hex
	version string // package/package.json "version" inside the tarball ("" if unreadable)
}

func NewClientFile(path string) *ClientFile { return &ClientFile{path: path} }

// open returns the file (positioned at 0) and its cached sums; nil file = 404.
func (c *ClientFile) open() (*os.File, os.FileInfo, clientSum, error) {
	f, err := os.Open(c.path)
	if err != nil {
		return nil, nil, clientSum{}, err
	}
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		f.Close()
		return nil, nil, clientSum{}, os.ErrNotExist
	}
	c.mu.Lock()
	cur := c.last
	c.mu.Unlock()
	if cur.sha == "" || cur.size != st.Size() || !cur.mtime.Equal(st.ModTime()) {
		h := sha256.New()
		if _, err := io.Copy(h, f); err != nil {
			f.Close()
			return nil, nil, clientSum{}, err
		}
		cur = clientSum{size: st.Size(), mtime: st.ModTime(), sha: hex.EncodeToString(h.Sum(nil))}
		if _, err := f.Seek(0, io.SeekStart); err == nil {
			cur.version = tarballVersion(f)
		}
		c.mu.Lock()
		c.last = cur
		c.mu.Unlock()
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		f.Close()
		return nil, nil, clientSum{}, err
	}
	return f, st, cur, nil
}

// tarballVersion reads "version" from package/package.json (npm pack layout); "" when it can't.
func tarballVersion(r io.Reader) string {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return ""
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for i := 0; i < 10000; i++ {
		hd, err := tr.Next()
		if err != nil {
			return ""
		}
		if hd.Name != "package/package.json" {
			continue
		}
		var pj struct {
			Version string `json:"version"`
		}
		if err := json.NewDecoder(io.LimitReader(tr, 1<<20)).Decode(&pj); err != nil || len(pj.Version) > 64 {
			return ""
		}
		return pj.Version
	}
	return ""
}

func methodOK(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	return true
}

func notModified(w http.ResponseWriter, r *http.Request, etag string) bool {
	for _, t := range strings.Split(r.Header.Get("If-None-Match"), ",") {
		if t = strings.TrimSpace(t); t == etag || t == "*" {
			w.WriteHeader(http.StatusNotModified)
			return true
		}
	}
	return false
}

// VersionLen: how many hex digits of the tarball's sha256 name a version (/dl/botlink-<16 hex>.tgz).
const VersionLen = 16

var versionedName = regexp.MustCompile(`^/dl/botlink-([0-9a-f]{16})\.tgz$`)

// VersionedURL turns the configured client URL into the one for a tarball with this sha256 (launch plan #3: npx reuses
// the copy it first fetched for a given spec, so every release needs its own spec). "<…>/botlink.tgz" becomes
// "<…>/botlink-<16 hex>.tgz"; any other configured URL gets "?v=<16 hex>". sha "" → base unchanged.
func VersionedURL(base, sha string) string {
	if len(sha) < VersionLen || base == "" {
		return base
	}
	v := sha[:VersionLen]
	if strings.HasSuffix(base, "/botlink.tgz") {
		return strings.TrimSuffix(base, "botlink.tgz") + "botlink-" + v + ".tgz"
	}
	if strings.Contains(base, "?") {
		return base + "&v=" + v
	}
	return base + "?v=" + v
}

// CurrentURL is VersionedURL for the tarball served right now; the configured URL when there is none (nil receiver,
// unconfigured or missing file).
func (c *ClientFile) CurrentURL(base string) string {
	if c == nil {
		return base
	}
	f, _, cur, err := c.open()
	if err != nil {
		return base
	}
	f.Close()
	return VersionedURL(base, cur.sha)
}

// Versioned serves GET|HEAD /dl/botlink-<16 hex>.tgz: the current tarball under its own name, cached for a year
// (immutable). An older version redirects (302, no-store) to the current one: only one tarball is on disk. Anything
// else under /dl/ is 404.
func (c *ClientFile) Versioned() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m := versionedName.FindStringSubmatch(r.URL.Path)
		if m == nil {
			httpx.WriteError(w, r, httpx.NotFound())
			return
		}
		if !methodOK(w, r) {
			return
		}
		f, st, cur, err := c.open()
		if err != nil {
			httpx.WriteError(w, r, httpx.NotFound())
			return
		}
		defer f.Close()
		hd := w.Header()
		hd.Set("X-Robots-Tag", "noindex")
		hd.Set("X-Content-Type-Options", "nosniff")
		if m[1] != cur.sha[:VersionLen] {
			hd.Set("Cache-Control", "no-store")
			http.Redirect(w, r, "/dl/botlink-"+cur.sha[:VersionLen]+".tgz", http.StatusFound)
			return
		}
		etag := `"` + cur.sha + `"`
		hd.Set("Content-Type", "application/gzip")
		hd.Set("Cache-Control", "public, max-age=31536000, immutable")
		hd.Set("ETag", etag)
		hd.Set("Content-Disposition", `attachment; filename="botlink-`+m[1]+`.tgz"`)
		if notModified(w, r, etag) {
			return
		}
		http.ServeContent(w, r, "botlink.tgz", st.ModTime(), f)
	})
}

// Download serves GET|HEAD /dl/botlink.tgz: people and agents run it with `npx -y https://<api host>/dl/botlink.tgz …`.
func (c *ClientFile) Download() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !methodOK(w, r) {
			return
		}
		f, st, cur, err := c.open()
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		defer f.Close()
		etag := `"` + cur.sha + `"`
		hd := w.Header()
		hd.Set("Content-Type", "application/gzip")
		hd.Set("Cache-Control", "no-cache")
		hd.Set("ETag", etag)
		hd.Set("X-Robots-Tag", "noindex")
		hd.Set("X-Content-Type-Options", "nosniff")
		hd.Set("Content-Disposition", `attachment; filename="botlink.tgz"`)
		if notModified(w, r, etag) {
			return
		}
		// ServeContent: Content-Length, Range and HEAD handled; our ETag header is kept
		http.ServeContent(w, r, "botlink.tgz", st.ModTime(), f)
	})
}

// Info serves GET|HEAD /dl/botlink.json: {"v":1,"version","sha256","size","url"} of the tarball /dl/botlink.tgz
// serves right now; url is that tarball's versioned URL (VersionedURL). Unsigned (like the tarball itself; TLS to the API host is the trust), no-cache + ETag.
func (c *ClientFile) Info(url string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !methodOK(w, r) {
			return
		}
		f, _, cur, err := c.open()
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		f.Close()
		body, _ := json.Marshal(map[string]any{"v": 1, "version": cur.version, "sha256": cur.sha, "size": cur.size, "url": VersionedURL(url, cur.sha)})
		etag := `"` + cur.sha + `-info"`
		hd := w.Header()
		hd.Set("Content-Type", "application/json")
		hd.Set("Cache-Control", "no-cache")
		hd.Set("ETag", etag)
		hd.Set("X-Robots-Tag", "noindex")
		hd.Set("X-Content-Type-Options", "nosniff")
		if notModified(w, r, etag) {
			return
		}
		hd.Set("Content-Length", strconv.Itoa(len(body)))
		w.WriteHeader(200)
		if r.Method == http.MethodGet {
			_, _ = w.Write(body)
		}
	})
}

// Manifest serves GET|HEAD /dl/botlink.manifest.json: the release manifest signed offline (deploy/release-sign.mjs)
// and written next to the tarball, byte for byte (it is signed; the client checks it against the key it carries).
// "Next to" is the tarball's real path, so a `current` symlink follows deploys (as deploy/lib/dl-server.py does).
// 404 while no manifest is there: an updated client then keeps its version.
func (c *ClientFile) Manifest() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !methodOK(w, r) {
			return
		}
		real, err := filepath.EvalSymlinks(c.path)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		f, err := os.Open(filepath.Join(filepath.Dir(real), "botlink.manifest.json"))
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		defer f.Close()
		st, err := f.Stat()
		if err != nil || !st.Mode().IsRegular() || st.Size() > 64<<10 {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		body, err := io.ReadAll(io.LimitReader(f, 64<<10))
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		hd := w.Header()
		hd.Set("Content-Type", "application/json")
		hd.Set("Cache-Control", "no-cache")
		hd.Set("X-Robots-Tag", "noindex")
		hd.Set("X-Content-Type-Options", "nosniff")
		hd.Set("Content-Length", strconv.Itoa(len(body)))
		w.WriteHeader(200)
		if r.Method == http.MethodGet {
			_, _ = w.Write(body)
		}
	})
}

// ClientDownload is the old single-handler constructor (kept for callers/tests).
func ClientDownload(path string) http.Handler { return NewClientFile(path).Download() }

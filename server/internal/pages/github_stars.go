package pages

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/charles161/botlink/server/internal/config"
)

// The star count next to the header's GitHub link (web/public/assets/js/github-link.js). The server asks GitHub for
// the repository BOTLINK_SOURCE_URL names and keeps the answer in memory; GET /site/github.json answers from that
// cache at once, {"stars":N} from StarsMin up and {} otherwise (no setting, under StarsMin, not fetched yet, failed).
// The API host is a constant and the path comes only from the setting, so nothing a browser sends reaches the URL.
// Dev never fetches (tests use newStars with a fake on 127.0.0.1).

const (
	githubAPI    = "https://api.github.com"
	StarsMin     = 50
	starsOK      = time.Hour        // a good answer is kept this long
	starsFail    = 10 * time.Minute // a failure too, so an outage cannot become a request storm
	starsTimeout = 3 * time.Second
	starsBodyMax = 64 << 10
)

var githubRepoForm = regexp.MustCompile(`^https://github\.com/([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9._-]{1,100})$`)

// githubRepoPath: "/repos/<owner>/<repo>" for a https://github.com/<owner>/<repo> source URL; false for anything else.
func githubRepoPath(source string) (string, bool) {
	m := githubRepoForm.FindStringSubmatch(source)
	if m == nil || m[2] == "." || m[2] == ".." {
		return "", false
	}
	return "/repos/" + m[1] + "/" + m[2], true
}

// Stars is the cached count. api == "": never fetches, always answers {}.
type Stars struct {
	api, path string
	timeout   time.Duration
	now       func() time.Time

	mu    sync.Mutex
	count int       // -1: none
	next  time.Time // the next fetch is due at or after this
	busy  bool      // a fetch is out (single flight)
	wg    sync.WaitGroup
}

// NewStars: fetching from GitHub's API when the server is not in dev and BOTLINK_SOURCE_URL names a GitHub repository.
func NewStars(cfg *config.Config) *Stars {
	if cfg != nil && cfg.Env != "dev" {
		if s := newStars(githubAPI, cfg.SourceURL); s != nil {
			return s
		}
	}
	return &Stars{count: -1, timeout: starsTimeout, now: time.Now}
}

// newStars: fetching from api for the repository source names; nil when source is not a GitHub repository URL.
func newStars(api, source string) *Stars {
	p, ok := githubRepoPath(source)
	if !ok {
		return nil
	}
	return &Stars{api: api, path: p, count: -1, timeout: starsTimeout, now: time.Now}
}

func (s *Stars) Routes(mux *http.ServeMux) { mux.Handle("GET /site/github.json", s) }

// cached: the count now (-1 for none), starting a background fetch when one is due and none is out.
func (s *Stars) cached() int {
	if s.api == "" {
		return -1
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.busy && !s.now().Before(s.next) {
		s.busy = true
		s.wg.Add(1)
		go s.refresh()
	}
	return s.count
}

func (s *Stars) refresh() {
	defer s.wg.Done()
	n, err := s.fetch()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.busy = false
	if err != nil {
		s.count, s.next = -1, s.now().Add(starsFail)
		slog.Warn("github stars: fetch failed; the link shows no count", "err", err)
		return
	}
	s.count, s.next = n, s.now().Add(starsOK)
}

var noRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

func (s *Stars) fetch() (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.api+s.path, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("User-Agent", "bot-link")
	req.Header.Set("Accept", "application/vnd.github+json")
	client := &http.Client{Timeout: s.timeout, CheckRedirect: noRedirect} // no cookie jar, no token
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("status %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, starsBodyMax+1))
	if err != nil {
		return 0, err
	}
	if len(b) > starsBodyMax {
		return 0, errors.New("body over 64 KiB")
	}
	var v struct {
		Stars *int `json:"stargazers_count"`
	}
	if err := json.NewDecoder(bytes.NewReader(b)).Decode(&v); err != nil {
		return 0, err
	}
	if v.Stars == nil || *v.Stars < 0 {
		return 0, errors.New("no stargazers_count")
	}
	return *v.Stars, nil
}

func (s *Stars) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body := "{}"
	if n := s.cached(); n >= StarsMin {
		body = `{"stars":` + strconv.Itoa(n) + `}`
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=300")
	if r.Method != http.MethodHead {
		_, _ = io.WriteString(w, body)
	}
}

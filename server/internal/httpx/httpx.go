// Package httpx holds the HTTP plumbing shared by both surfaces: the error shape (SPEC §10), JSON
// helpers, request ids and the client IP rule.
package httpx

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
)

// Error is every non-2xx body: {"error": {"code", "message", "retry_after_s"?, "server_time"?, "details"?}}.
type Error struct {
	Status     int
	Code       string
	Message    string
	RetryAfter int
	ServerTime int64
	Details    map[string]any
	Cause      error // logged, never sent
}

func (e *Error) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("%d %s: %s (%v)", e.Status, e.Code, e.Message, e.Cause)
	}
	return fmt.Sprintf("%d %s: %s", e.Status, e.Code, e.Message)
}

func (e *Error) Unwrap() error { return e.Cause }

func E(status int, code, msg string) *Error { return &Error{Status: status, Code: code, Message: msg} }

func (e *Error) With(k string, v any) *Error {
	if e.Details == nil {
		e.Details = map[string]any{}
	}
	e.Details[k] = v
	return e
}

func BadRequest(msg string) *Error { return E(400, "bad_request", msg) }
func NotFound() *Error             { return E(404, "not_found", "Not found.") }
func Forbidden(msg string) *Error  { return E(403, "forbidden", msg) }
func Internal(cause error) *Error {
	return &Error{Status: 500, Code: "internal", Message: "Something went wrong on the server. Try again.", Cause: cause}
}
func Unavailable(cause error) *Error {
	return &Error{Status: 503, Code: "unavailable", Message: "The server is busy or can't reach its database. Try again shortly.", RetryAfter: 2, Cause: cause}
}
func RateLimited(code string, retry int) *Error {
	if code == "" {
		code = "rate_limited"
	}
	msg := "Too many requests. Try again later."
	if code == "mailbox_full" {
		msg = "That member has too many waiting messages. Try again later."
	}
	if code == "quota_exceeded" {
		msg = "You've reached the limit for this."
	}
	if code == "too_many_drafts" {
		msg = "Too many room requests are waiting. Try again later."
	}
	if code == "too_many_polls" {
		msg = "This member is checking for messages too often (a loop?). Wait and try again; bot-link long-polls for you."
	}
	if retry < 1 {
		retry = 1
	}
	return &Error{Status: 429, Code: code, Message: msg, RetryAfter: retry}
}

// AsError maps any error to an *Error (DB unavailability → 503, everything else → 500).
func AsError(err error) *Error {
	var he *Error
	if errors.As(err, &he) {
		return he
	}
	if IsUnavailable(err) {
		return Unavailable(err)
	}
	return Internal(err)
}

// IsUnavailable reports connection-level DB failures (not query errors).
func IsUnavailable(err error) bool {
	if err == nil {
		return false
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		// 57P01 admin_shutdown, 57P03 cannot_connect_now, 53300 too_many_connections, 08xxx connection exceptions
		return pgErr.Code == "57P01" || pgErr.Code == "57P03" || pgErr.Code == "53300" || strings.HasPrefix(pgErr.Code, "08")
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return true
	}
	if pgconn.SafeToRetry(err) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	var ce *pgconn.ConnectError
	return errors.As(err, &ce)
}

// PgCode returns the SQLSTATE of err, or "".
func PgCode(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	return ""
}

// PgConstraint returns the violated constraint/index name, or "".
func PgConstraint(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.ConstraintName
	}
	return ""
}

func WriteJSON(w http.ResponseWriter, status int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		status = 500
		b = []byte(`{"error":{"code":"internal","message":"Something went wrong on the server. Try again."}}`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

func WriteError(w http.ResponseWriter, r *http.Request, err error) {
	e := AsError(err)
	body := map[string]any{"code": e.Code, "message": e.Message}
	if e.RetryAfter > 0 {
		body["retry_after_s"] = e.RetryAfter
		w.Header().Set("Retry-After", strconv.Itoa(e.RetryAfter))
	}
	if e.ServerTime != 0 {
		body["server_time"] = e.ServerTime
	}
	if len(e.Details) > 0 {
		body["details"] = e.Details
	}
	if e.Status >= 500 && e.Code != "high_load" { // high_load: expected at the cap, counted, never an error line each
		lvl := slog.LevelError
		if e.Status == 503 {
			lvl = slog.LevelWarn
		}
		slog.Log(r.Context(), lvl, "request failed", "status", e.Status, "code", e.Code, "err", errString(e.Cause),
			"request_id", RequestID(r.Context()), "path", r.URL.Path)
	}
	WriteJSON(w, e.Status, map[string]any{"error": body})
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// Handler is an http handler that returns an error instead of writing it.
type Handler func(w http.ResponseWriter, r *http.Request) error

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if err := h(w, r); err != nil {
		WriteError(w, r, err)
	}
}

// ── request ids

type ctxKey int

const (
	ridKey ctxKey = iota
	logAttrsKey
	drainKey
)

// WithDrain puts the server's drain signal into a request context (closed when the copy starts shutting down).
func WithDrain(ctx context.Context, ch <-chan struct{}) context.Context {
	return context.WithValue(ctx, drainKey, ch)
}

// Draining is closed when this copy starts shutting down: a long-poll or event stream ends now with its normal answer
// (nothing yet / still pending), so the restart doesn't cut it. nil (never ready) outside a server.
func Draining(ctx context.Context) <-chan struct{} {
	ch, _ := ctx.Value(drainKey).(<-chan struct{})
	return ch
}

var ridRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

func NewRequestID() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// WithRequestID echoes a sane X-Request-Id or makes one.
func WithRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if !ridRe.MatchString(id) {
			id = NewRequestID()
		}
		w.Header().Set("X-Request-Id", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ridKey, id)))
	})
}

// LogInfo carries who made the request, for the request log line (SPEC §12: member/account ids).
type LogInfo struct {
	MemberID  string
	AccountID string
	RateLimit string // name of the quota that turned this request away (metrics: botlink_rate_limited_total)
	HighLoad  bool   // turned away at this copy's cap (503 high_load): expected, not a server error
}

// WithLogInfo attaches an empty LogInfo that auth layers fill in.
func WithLogInfo(r *http.Request) (*http.Request, *LogInfo) {
	li := &LogInfo{}
	return r.WithContext(context.WithValue(r.Context(), logAttrsKey, li)), li
}

// SetMember / SetAccount record the caller (no-ops without WithLogInfo).
func SetMember(ctx context.Context, id string) {
	if li, ok := ctx.Value(logAttrsKey).(*LogInfo); ok {
		li.MemberID = id
	}
}

func SetAccount(ctx context.Context, id string) {
	if li, ok := ctx.Value(logAttrsKey).(*LogInfo); ok {
		li.AccountID = id
	}
}

// SetRateLimited records which quota rejected the request (no-op without WithLogInfo).
func SetRateLimited(ctx context.Context, limit string) {
	if li, ok := ctx.Value(logAttrsKey).(*LogInfo); ok {
		li.RateLimit = limit
	}
}

// SetHighLoad marks a request turned away at the copy's cap (no-op without WithLogInfo).
func SetHighLoad(ctx context.Context) {
	if li, ok := ctx.Value(logAttrsKey).(*LogInfo); ok {
		li.HighLoad = true
	}
}

func RequestID(ctx context.Context) string {
	s, _ := ctx.Value(ridKey).(string)
	return s
}

// ── JSON request bodies

// MaxBody is the request body cap (SPEC §9: request body 2 MiB).
const MaxBody = 2 << 20

// ReadBody reads at most MaxBody bytes; larger → 413 too_large.
func ReadBody(r *http.Request) ([]byte, error) {
	if r.Body == nil {
		return nil, nil
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, MaxBody+1))
	if err != nil {
		return nil, BadRequest("Could not read the request body.")
	}
	if len(b) > MaxBody {
		return nil, E(413, "too_large", "The request body is too large (2 MiB max).")
	}
	return b, nil
}

// DecodeStrict decodes JSON rejecting unknown fields, duplicate keys and trailing data.
func DecodeStrict(b []byte, v any) error {
	if err := CheckNoDuplicateKeys(b); err != nil {
		return BadRequest("Invalid JSON: " + err.Error())
	}
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return BadRequest("Invalid request body: " + err.Error())
	}
	if dec.More() {
		return BadRequest("Invalid request body: trailing data.")
	}
	return nil
}

// CheckNoDuplicateKeys walks a JSON document and rejects any object with a repeated key.
func CheckNoDuplicateKeys(b []byte) error {
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.UseNumber()
	var walk func() error
	walk = func() error {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		d, ok := tok.(json.Delim)
		if !ok {
			return nil
		}
		switch d {
		case '{':
			seen := map[string]bool{}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return err
				}
				k, _ := kt.(string)
				if seen[k] {
					return fmt.Errorf("duplicate key %q", k)
				}
				seen[k] = true
				if err := walk(); err != nil {
					return err
				}
			}
			_, err = dec.Token()
			return err
		case '[':
			for dec.More() {
				if err := walk(); err != nil {
					return err
				}
			}
			_, err = dec.Token()
			return err
		}
		return nil
	}
	if err := walk(); err != nil {
		return err
	}
	if _, err := dec.Token(); err != io.EOF {
		return errors.New("trailing data")
	}
	return nil
}

// ── client IP

// ClientIP is CF-Connecting-IP only when trustCF, else the socket address.
func ClientIP(r *http.Request, trustCF bool) string {
	if trustCF {
		if ip := strings.TrimSpace(r.Header.Get("CF-Connecting-IP")); net.ParseIP(ip) != nil {
			return ip
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// StatusRecorder captures the status code for metrics/logs and passes Flush through (SSE).
type StatusRecorder struct {
	http.ResponseWriter
	Status int
}

func (s *StatusRecorder) WriteHeader(c int) {
	if s.Status == 0 {
		s.Status = c
	}
	s.ResponseWriter.WriteHeader(c)
}

func (s *StatusRecorder) Write(b []byte) (int, error) {
	if s.Status == 0 {
		s.Status = 200
	}
	return s.ResponseWriter.Write(b)
}

func (s *StatusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (s *StatusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

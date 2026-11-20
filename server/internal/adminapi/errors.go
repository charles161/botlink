package adminapi

import (
	"sync"
	"time"
)

// ErrorRing keeps the last N server errors (5xx) of THIS copy in memory: time, method, route pattern,
// status and request id. Nothing else (no paths with ids, no bodies, no causes). Per copy by design: the
// admin page labels it "this copy"; logs have the full picture.
type ErrorRing struct {
	mu    sync.Mutex
	items []ErrorItem
	next  int
	full  bool
	total uint64
}

type ErrorItem struct {
	At        time.Time `json:"at"`
	Method    string    `json:"method"`
	Route     string    `json:"route"`
	Status    int       `json:"status"`
	RequestID string    `json:"request_id"`
}

func NewErrorRing(n int) *ErrorRing { return &ErrorRing{items: make([]ErrorItem, n)} }

// Record adds one error; the oldest falls off when full.
func (e *ErrorRing) Record(method, route string, status int, requestID string) {
	if e == nil || len(e.items) == 0 {
		return
	}
	if len(requestID) > 64 {
		requestID = requestID[:64]
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.items[e.next] = ErrorItem{At: time.Now().UTC(), Method: method, Route: route, Status: status, RequestID: requestID}
	e.next = (e.next + 1) % len(e.items)
	if e.next == 0 {
		e.full = true
	}
	e.total++
}

// Recent returns the kept errors, newest first, and how many this copy has seen since it started.
func (e *ErrorRing) Recent() ([]ErrorItem, uint64) {
	out := []ErrorItem{}
	if e == nil {
		return out, 0
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	n := e.next
	if e.full {
		n = len(e.items)
	}
	for i := 1; i <= n; i++ {
		out = append(out, e.items[(e.next-i+len(e.items))%len(e.items)])
	}
	return out, e.total
}

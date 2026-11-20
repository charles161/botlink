// Package faults provides test-only fault-injection points (BOTLINK_TEST_FAULTS, refused unless
// BOTLINK_ENV=dev). With nothing registered every Point is one atomic load.
//
// Points:
//
//	send_after_delivery  arg = k (1-based): fail the send transaction right after inserting delivery k
//	lease_after_hold     called in a lease/wait poll after the bell is held, before the first DB check
//	lease_after_query    called after an empty check, before the poll waits on its bell
//	admit_before_append  called in appapi.admitChat just before the member_add is appended (a join approval, a batch
//	                     item, a room draft's confirm)
package faults

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

var ErrInjected = errors.New("injected fault")

type Hook func(ctx context.Context, arg int) error

type registry struct {
	mu    sync.RWMutex
	hooks map[string]Hook
}

var (
	enabled atomic.Bool
	reg     = &registry{hooks: map[string]Hook{}}
)

// Set registers (or with nil, removes) a hook. Tests use this directly.
func Set(name string, h Hook) {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if h == nil {
		delete(reg.hooks, name)
	} else {
		reg.hooks[name] = h
	}
	enabled.Store(len(reg.hooks) > 0)
}

// Reset removes every hook.
func Reset() {
	reg.mu.Lock()
	reg.hooks = map[string]Hook{}
	reg.mu.Unlock()
	enabled.Store(false)
}

// Point runs the hook registered under name, if any.
func Point(ctx context.Context, name string, arg int) error {
	if !enabled.Load() {
		return nil
	}
	reg.mu.RLock()
	h := reg.hooks[name]
	reg.mu.RUnlock()
	if h == nil {
		return nil
	}
	return h(ctx, arg)
}

// FromEnv parses "name:arg,name2:arg2". Supported from env: send_after_delivery:k.
func FromEnv(spec string) error {
	if strings.TrimSpace(spec) == "" {
		return nil
	}
	for _, part := range strings.Split(spec, ",") {
		name, arg, _ := strings.Cut(strings.TrimSpace(part), ":")
		switch name {
		case "send_after_delivery":
			k, err := strconv.Atoi(arg)
			if err != nil || k < 1 {
				return errors.New("send_after_delivery needs a positive k")
			}
			Set(name, func(_ context.Context, i int) error {
				if i == k {
					return ErrInjected
				}
				return nil
			})
		default:
			return errors.New("unknown fault " + name)
		}
	}
	return nil
}

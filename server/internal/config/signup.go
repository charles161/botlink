package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// SignupConfig limits how many NEW accounts are made (fix-all blocker 8). Signing in to an existing account is never
// limited. Per address = per source address as the server's other per-IP limits see it (httpx.ClientIP:
// CF-Connecting-IP with BOTLINK_TRUST_CF=1, else the socket address); IPv6 counts per /64. 0 = the default.
type SignupConfig struct {
	PerAddrHour int // BOTLINK_SIGNUP_PER_IP_HOUR, default 10
	PerAddrDay  int // BOTLINK_SIGNUP_PER_IP_DAY, default 30
	GlobalHour  int // BOTLINK_SIGNUP_GLOBAL_HOUR, default 1000
	GlobalDay   int // BOTLINK_SIGNUP_GLOBAL_DAY, default 5000
}

func signupFromEnv() (SignupConfig, error) {
	var s SignupConfig
	for _, f := range []struct {
		env string
		dst *int
	}{
		{"BOTLINK_SIGNUP_PER_IP_HOUR", &s.PerAddrHour},
		{"BOTLINK_SIGNUP_PER_IP_DAY", &s.PerAddrDay},
		{"BOTLINK_SIGNUP_GLOBAL_HOUR", &s.GlobalHour},
		{"BOTLINK_SIGNUP_GLOBAL_DAY", &s.GlobalDay},
	} {
		v := strings.TrimSpace(os.Getenv(f.env))
		if v == "" {
			continue
		}
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 1000000 {
			return s, fmt.Errorf("%s must be a whole number from 1 to 1000000 (got %q)", f.env, v)
		}
		*f.dst = n
	}
	return s, nil
}

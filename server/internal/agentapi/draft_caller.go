package agentapi

import "net"

// DraftCallerKey is how the draft caps count a caller (docs/protocol/room-drafts.md §5): an IPv4 address by itself
// (an IPv4-mapped IPv6 address as its IPv4), an IPv6 address by its /56 prefix ("2001:db8:1:100::/56"), since one
// home or server usually holds a whole /64 or /56. Anything that is not an address is counted as it is.
func DraftCallerKey(ip string) string {
	a := net.ParseIP(ip)
	if a == nil {
		return ip
	}
	if v4 := a.To4(); v4 != nil {
		return v4.String()
	}
	return (&net.IPNet{IP: a.Mask(net.CIDRMask(56, 128)), Mask: net.CIDRMask(56, 128)}).String()
}

// DraftCallerLock serialises the creates of one caller (DraftCallerKey), so its caps count exactly.
const DraftCallerLock = `select pg_advisory_xact_lock(hashtextextended('room_drafts:' || $1::text, 0))`

// Package roster verifies the owner-device-signed member list (crypto/ENVELOPE.md §5). Pure: no DB.
// The server replays the stored log through the same rules the clients and the dashboard use, and
// refuses any append that would make the log invalid.
package roster

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/wire"
)

const Context = "botlink-roster-v1"

const MaxEntryBytes = 4096

// Wire is the JSON form {"seq","entry","sig","signer"}.
type Wire struct {
	Seq    int    `json:"seq"`
	Entry  string `json:"entry"`
	Sig    string `json:"sig"`
	Signer string `json:"signer"`
}

// Entry is a parsed, signature-checked roster entry.
type Entry struct {
	Seq  int
	Room string
	Prev string // hex, "" at seq 0
	At   int64
	Op   string
	By   string // signer pk hex

	// op fields (only those of Op are set)
	Name    string
	Owner   string
	Device  string
	Account string
	Label   string
	Member  string
	App     string
	Ed      string
	X       string

	Raw    []byte // exact signed bytes
	Hash   []byte // sha256(Raw)
	Sig    []byte
	Signer []byte

	opErr error // op field shape problem; reported as rule "op" after the signature check
}

// Error is a roster rule failure. Rule codes are shared with client and web (crypto/vectors/README.md),
// checked in this order per entry: bad_wire → seq (wire) → bad_entry → seq (entry vs wire) → room → by →
// prev → sig → op (field shape) → signer → op (state rules).
type Error struct {
	Rule string
	Seq  int
	Msg  string
}

func (e *Error) Error() string {
	return fmt.Sprintf("roster entry %d fails rule %s: %s", e.Seq, e.Rule, e.Msg)
}

func fail(rule string, seq int, format string, a ...any) *Error {
	return &Error{Rule: rule, Seq: seq, Msg: fmt.Sprintf(format, a...)}
}

// HTTPError maps a roster error to 400 roster_invalid {rule}.
func (e *Error) HTTPError() *httpx.Error {
	return httpx.E(400, "roster_invalid", "This member-list change isn't valid: "+e.Msg).With("rule", e.Rule).With("seq", e.Seq)
}

type Person struct {
	Account string
	Name    string
	Active  bool
	Devices map[string]bool // current device pks
}

type Member struct {
	ID      string
	Account string
	Name    string
	App     string
	Ed      string
	X       string
	Active  bool
}

// State is the replayed roster.
type State struct {
	Room        string
	Name        string // room name (genesis)
	Owner       string
	People      map[string]*Person // every account ever added (Active marks current)
	Members     map[string]*Member // every member ever added (Active marks current)
	DeviceOwner map[string]string  // current device pk → account
	HeadSeq     int                // -1 when empty
	HeadHash    []byte
	GenesisRaw  []byte
}

func NewState(room string) *State {
	return &State{Room: room, People: map[string]*Person{}, Members: map[string]*Member{},
		DeviceOwner: map[string]string{}, HeadSeq: -1}
}

// IsOwnerDevice reports whether pk is a current device of the room owner.
func (s *State) IsOwnerDevice(pk string) bool { return s.Owner != "" && s.DeviceOwner[pk] == s.Owner }

// IsDeviceOf reports whether pk is a current device of account (who must be a current person).
func (s *State) IsDeviceOf(pk, account string) bool {
	p := s.People[account]
	return p != nil && p.Active && s.DeviceOwner[pk] == account
}

func (s *State) ActivePerson(account string) bool {
	p := s.People[account]
	return p != nil && p.Active
}

func (s *State) activeMemberByName(name string) *Member {
	for _, m := range s.Members {
		if m.Active && m.Name == name {
			return m
		}
	}
	return nil
}

func (s *State) activeMemberByEd(ed string) *Member {
	for _, m := range s.Members {
		if m.Active && m.Ed == ed {
			return m
		}
	}
	return nil
}

// ActiveMembers returns current members.
func (s *State) ActiveMembers() []*Member {
	var out []*Member
	for _, m := range s.Members {
		if m.Active {
			out = append(out, m)
		}
	}
	return out
}

// allowed fields per op (common fields are always allowed and required)
var common = []string{"v", "room", "seq", "prev", "at", "op", "by"}
var opFields = map[string][]string{
	"genesis":       {"name", "owner", "device"},
	"device_add":    {"account", "device", "label"},
	"device_remove": {"account", "device"},
	"person_add":    {"account", "name", "device"},
	"person_remove": {"account"},
	"member_add":    {"member", "account", "name", "app", "ed", "x"},
	"member_rekey":  {"member", "ed", "x"},
	"member_remove": {"member"},
}

var apps = map[string]bool{"claude-code": true, "codex": true, "cursor": true, "other": true}

// Parse decodes entry bytes. Common-field problems fail with bad_entry; op-field shape problems are kept
// on the entry and reported as rule "op" by Apply (after the signature check).
func Parse(raw []byte, seqHint int) (*Entry, error) {
	badEntry := func(format string, a ...any) (*Entry, error) { return nil, fail("bad_entry", seqHint, format, a...) }
	if len(raw) == 0 || len(raw) > MaxEntryBytes {
		return badEntry("entry must be 1..%d bytes", MaxEntryBytes)
	}
	if !utf8.Valid(raw) {
		return badEntry("entry is not UTF-8")
	}
	if err := httpx.CheckNoDuplicateKeys(raw); err != nil {
		return badEntry("entry JSON: %v", err)
	}
	var m map[string]json.RawMessage
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&m); err != nil || m == nil {
		return badEntry("entry is not a JSON object")
	}
	e := &Entry{Raw: raw, Hash: wire.SHA256(raw)}
	str := func(k string) (string, bool) {
		v, ok := m[k]
		if !ok {
			return "", false
		}
		var s string
		if json.Unmarshal(v, &s) != nil {
			return "", false
		}
		return s, true
	}
	integer := func(k string) (int64, bool) {
		v, ok := m[k]
		if !ok {
			return 0, false
		}
		n, err := strconv.ParseInt(strings.TrimSpace(string(v)), 10, 64)
		return n, err == nil
	}
	// common fields → bad_entry
	v, ok := integer("v")
	if !ok || v != 1 {
		return badEntry("v must be 1")
	}
	seq, ok := integer("seq")
	if !ok || seq < 0 || seq > 1<<30 {
		return badEntry("seq must be an integer")
	}
	e.Seq = int(seq)
	if e.At, ok = integer("at"); !ok {
		return badEntry("at must be an integer")
	}
	var ok1, ok2, ok3 bool
	e.Room, ok1 = str("room")
	e.Op, ok2 = str("op")
	e.By, ok3 = str("by")
	if !ok1 || !ok2 || !ok3 {
		return badEntry("room, op and by must be strings")
	}
	pv, hasPrev := m["prev"]
	switch {
	case !hasPrev:
		e.Prev = "missing"
	case string(bytes.TrimSpace(pv)) == "null":
	default:
		p, ok := str("prev")
		if !ok {
			e.Prev = "invalid"
		} else {
			e.Prev = p
		}
	}
	// op fields → kept for rule "op"
	fields, known := opFields[e.Op]
	if !known {
		e.opErr = fmt.Errorf("unknown op %q", e.Op)
		return e, nil
	}
	allowed := map[string]bool{}
	for _, f := range common {
		allowed[f] = true
	}
	opBad := func(format string, a ...any) (*Entry, error) { e.opErr = fmt.Errorf(format, a...); return e, nil }
	for _, f := range fields {
		allowed[f] = true
		val, ok := str(f)
		if !ok {
			return opBad("%s must be a string", f)
		}
		switch f {
		case "name":
			e.Name = val
		case "owner":
			e.Owner = val
		case "device":
			e.Device = val
		case "account":
			e.Account = val
		case "label":
			e.Label = val
		case "member":
			e.Member = val
		case "app":
			e.App = val
		case "ed":
			e.Ed = val
		case "x":
			e.X = val
		}
	}
	for k := range m {
		if !allowed[k] {
			return opBad("unexpected field %q for op %s", k, e.Op)
		}
	}
	for _, f := range fields {
		switch f {
		case "owner", "account", "member":
			val := map[string]string{"owner": e.Owner, "account": e.Account, "member": e.Member}[f]
			if !wire.IsUUID(val) {
				return opBad("%s must be a uuid", f)
			}
		case "device", "ed", "x":
			val := map[string]string{"device": e.Device, "ed": e.Ed, "x": e.X}[f]
			if !wire.IsHex32(val) {
				return opBad("%s must be 64 lowercase hex chars", f)
			}
		case "label":
			if n := utf8.RuneCountInString(e.Label); n < 1 || n > 80 {
				return opBad("label must be 1..80 characters")
			}
		case "app":
			if !apps[e.App] {
				return opBad("app must be claude-code, codex, cursor or other")
			}
		case "name":
			switch e.Op {
			case "genesis":
				if !wire.RoomNameRe.MatchString(e.Name) {
					return opBad("room name must match ^[a-z0-9][a-z0-9-]{0,31}$")
				}
			case "member_add":
				if !wire.MemberNameRe.MatchString(e.Name) {
					return opBad("member name must match ^[a-z0-9][a-z0-9-]{0,23}$")
				}
			case "person_add":
				if n := utf8.RuneCountInString(e.Name); n < 1 || n > 80 {
					return opBad("person name must be 1..80 characters")
				}
			}
		}
	}
	return e, nil
}

// DecodeWire turns the JSON wire form into raw parts. Signer format → bad_wire; entry encoding →
// bad_entry; a sig that isn't 128 hex chars can't verify → sig (reported in order by Apply).
func DecodeWire(w Wire) (raw, sig, signer []byte, err error) {
	var ok bool
	if w.Seq < 0 {
		return nil, nil, nil, fail("bad_wire", w.Seq, "seq must be a non-negative integer")
	}
	if signer, ok = wire.DecodeHex32(w.Signer); !ok {
		return nil, nil, nil, fail("bad_wire", w.Seq, "signer must be 64 lowercase hex chars")
	}
	sig, _ = wire.DecodeSig(w.Sig) // nil when malformed: fails the signature check
	raw, derr := wire.DecodeB64URL(w.Entry)
	if derr != nil {
		raw = nil // reported as bad_entry after the seq check
	}
	return raw, sig, signer, nil
}

// ApplyWire checks a wire entry against s and, if valid, applies it.
func (s *State) ApplyWire(w Wire) (*Entry, error) {
	raw, sig, signer, err := DecodeWire(w)
	if err != nil {
		return nil, err
	}
	return s.Apply(w.Seq, raw, sig, signer, true)
}

// Apply checks one entry (ENVELOPE §5.3) against the state before it and applies it, in the shared
// order. verifySig=false is only for replaying entries the server already verified on insert.
func (s *State) Apply(seq int, raw, sig, signer []byte, verifySig bool) (*Entry, error) {
	want := s.HeadSeq + 1 // failures are reported at this position (shared rule codes)
	if seq != want {
		return nil, fail("seq", want, "expected seq %d, got %d", want, seq)
	}
	if raw == nil {
		return nil, fail("bad_entry", seq, "entry is not base64url without padding")
	}
	e, err := Parse(raw, seq)
	if err != nil {
		return nil, err
	}
	e.Sig, e.Signer = sig, signer
	if e.Seq != seq {
		return nil, fail("seq", seq, "entry seq differs from wire seq")
	}
	if e.Room != s.Room {
		return nil, fail("room", seq, "entry is for another room")
	}
	if e.By != hex.EncodeToString(signer) {
		return nil, fail("by", seq, "entry.by differs from the signer")
	}
	if seq == 0 {
		if e.Prev != "" {
			return nil, fail("prev", seq, "genesis prev must be null")
		}
	} else if e.Prev != hex.EncodeToString(s.HeadHash) {
		return nil, fail("prev", seq, "prev does not match the previous entry")
	}
	if verifySig && (sig == nil || !wire.Verify(signer, Context, raw, sig)) {
		return nil, fail("sig", seq, "signature does not verify")
	}
	if err := s.check(e); err != nil {
		return nil, err
	}
	s.mutate(e)
	s.HeadSeq = seq
	s.HeadHash = e.Hash
	if seq == 0 {
		s.GenesisRaw = raw
	}
	return e, nil
}

// check: op field shape → signer rule → remaining op rules (unknown member for rekey/remove is "op"
// before the signer rule, because the rule needs the member's account).
func (s *State) check(e *Entry) error {
	seq := e.Seq
	signer := func(msg string) error { return fail("signer", seq, "%s", msg) }
	op := func(format string, a ...any) error { return fail("op", seq, format, a...) }
	if e.opErr != nil {
		return op("%v", e.opErr)
	}
	if (seq == 0) != (e.Op == "genesis") {
		return op("genesis must be entry 0 and only entry 0")
	}
	switch e.Op {
	case "genesis":
		if e.Device != e.By {
			return signer("genesis must be signed by its own device")
		}
	case "device_add":
		if !s.IsDeviceOf(e.By, e.Account) && !s.IsOwnerDevice(e.By) {
			return signer("device_add must be signed by a device of the account or of the owner")
		}
		if !s.ActivePerson(e.Account) {
			return op("account is not a person in this room")
		}
		if _, used := s.DeviceOwner[e.Device]; used {
			return op("device is already in this room")
		}
	case "device_remove":
		if !s.IsDeviceOf(e.By, e.Account) && !s.IsOwnerDevice(e.By) {
			return signer("device_remove must be signed by a device of the account or of the owner")
		}
		if !s.IsDeviceOf(e.Device, e.Account) {
			return op("device is not a current device of the account")
		}
	case "person_add":
		if !s.IsOwnerDevice(e.By) {
			return signer("person_add must be signed by an owner device")
		}
		if s.ActivePerson(e.Account) {
			return op("person is already in this room")
		}
		if _, used := s.DeviceOwner[e.Device]; used {
			return op("device is already in this room")
		}
	case "person_remove":
		if !s.IsOwnerDevice(e.By) && !s.IsDeviceOf(e.By, e.Account) {
			return signer("person_remove must be signed by an owner device or the person's own device")
		}
		if e.Account == s.Owner {
			return op("the owner can't be removed")
		}
		if !s.ActivePerson(e.Account) {
			return op("person is not in this room")
		}
	case "member_add":
		if !s.IsDeviceOf(e.By, e.Account) {
			return signer("member_add must be signed by a device of the member's person")
		}
		if !s.ActivePerson(e.Account) {
			return op("account is not a person in this room")
		}
		if _, seen := s.Members[e.Member]; seen {
			return op("member id already used")
		}
		if s.activeMemberByName(e.Name) != nil {
			return op("member name already used")
		}
		if s.activeMemberByEd(e.Ed) != nil {
			return op("member key already used")
		}
	case "member_rekey":
		m := s.Members[e.Member]
		if m == nil || !m.Active {
			return op("member is not in this room")
		}
		if !s.IsDeviceOf(e.By, m.Account) {
			return signer("member_rekey must be signed by a device of the member's person")
		}
		if o := s.activeMemberByEd(e.Ed); o != nil && o.ID != m.ID {
			return op("member key already used")
		}
	case "member_remove":
		m := s.Members[e.Member]
		if m == nil || !m.Active {
			return op("member is not in this room")
		}
		if e.By != m.Ed && !s.IsDeviceOf(e.By, m.Account) && !s.IsOwnerDevice(e.By) {
			return signer("member_remove must be signed by the member, a device of its person or an owner device")
		}
	}
	return nil
}

func (s *State) mutate(e *Entry) {
	switch e.Op {
	case "genesis":
		s.Name = e.Name
		s.Owner = e.Owner
		s.People[e.Owner] = &Person{Account: e.Owner, Active: true, Devices: map[string]bool{e.Device: true}}
		s.DeviceOwner[e.Device] = e.Owner
	case "device_add":
		s.People[e.Account].Devices[e.Device] = true
		s.DeviceOwner[e.Device] = e.Account
	case "device_remove":
		delete(s.People[e.Account].Devices, e.Device)
		delete(s.DeviceOwner, e.Device)
	case "person_add":
		p := s.People[e.Account]
		if p == nil {
			p = &Person{Account: e.Account}
			s.People[e.Account] = p
		}
		p.Name, p.Active, p.Devices = e.Name, true, map[string]bool{e.Device: true}
		s.DeviceOwner[e.Device] = e.Account
	case "person_remove":
		p := s.People[e.Account]
		p.Active = false
		for d := range p.Devices {
			delete(s.DeviceOwner, d)
		}
		p.Devices = map[string]bool{}
		for _, m := range s.Members {
			if m.Account == e.Account {
				m.Active = false
			}
		}
	case "member_add":
		s.Members[e.Member] = &Member{ID: e.Member, Account: e.Account, Name: e.Name, App: e.App, Ed: e.Ed, X: e.X, Active: true}
	case "member_rekey":
		m := s.Members[e.Member]
		m.Ed, m.X = e.Ed, e.X
	case "member_remove":
		s.Members[e.Member].Active = false
	}
}

// Replay verifies a whole log from seq 0.
func Replay(room string, entries []Wire) (*State, error) {
	s := NewState(room)
	for _, w := range entries {
		if _, err := s.ApplyWire(w); err != nil {
			return nil, err
		}
	}
	if s.HeadSeq < 0 {
		return nil, fail("seq", 0, "empty roster")
	}
	return s, nil
}

// RoomFP is fp16 of the genesis entry bytes.
func (s *State) RoomFP() string { return wire.FP16(s.GenesisRaw) }

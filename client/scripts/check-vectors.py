"""Independent cross-check of crypto/vectors with PyNaCl + hashlib (not the TS code that generated them)."""
import base64, hashlib, hmac, json, sys
from nacl.signing import SigningKey, VerifyKey
from nacl.public import PrivateKey, SealedBox

D = sys.argv[1]
L = lambda n: json.load(open(f"{D}/{n}"))
fp16 = lambda b: "-".join(hashlib.sha256(b).hexdigest()[:16][i:i+4] for i in range(0, 16, 4))
b64u = lambda s: base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
ok = 0
def chk(c, what):
    global ok
    if not c: sys.exit(f"FAIL {what}")
    ok += 1

f = L("fingerprints.json")
for m in f["member"]: chk(fp16(f"{m['ed'].lower()}|{m['x'].lower()}".encode()) == m["fp"], "member fp")
for d in f["device"]: chk(fp16(f"botlink-device-v1|{d['pk']}".encode()) == d["fp"], "device fp")
for x in f["fp16"]: chk(fp16(x["input_utf8"].encode()) == x["fp"], "fp16")

r = L("req-sign.json")
sk = SigningKey(bytes.fromhex(r["seed"]))
chk(sk.verify_key.encode().hex() == r["key"], "req key")
for c in r["cases"]:
    body = c["body"].encode()
    bh = hashlib.sha256(body).hexdigest()
    sts = "\n".join(["botlink-req-v1", c["method"].upper(), c["host"].lower(), c["target"], bh, str(c["time"]), c["nonce"], r["key"], c["session"]])
    chk(sts == c["string_to_sign"], "sts " + c["name"])
    chk(sk.sign(sts.encode()).signature.hex() == c["sig"], "req sig " + c["name"])

ro = L("roster.json")
for i, w in enumerate(ro["valid"]["entries"]):
    b = b64u(w["entry"])
    chk(b.decode() == ro["valid"]["entry_json"][i], "entry bytes")
    VerifyKey(bytes.fromhex(w["signer"])).verify(b"botlink-roster-v1\n" + b, bytes.fromhex(w["sig"]))
    e = json.loads(b)
    if i: chk(e["prev"] == hashlib.sha256(b64u(ro["valid"]["entries"][i-1]["entry"])).digest().hex(), "prev")
chk(fp16(b64u(ro["valid"]["entries"][0]["entry"])) == ro["valid"]["expect"]["room_fp"], "room fp")
chk(hashlib.sha256(b64u(ro["valid"]["entries"][-1]["entry"])).hexdigest() == ro["valid"]["expect"]["head_hash"], "head hash")
ok += 1

e = L("envelope.json")
env = e["envelope"]
h = b64u(env["h"])
chk(h.decode() == e["header_json"], "header bytes")
VerifyKey(bytes.fromhex(e["sender"]["ed"])).verify(b"botlink-env-v1\n" + h, bytes.fromhex(env["sig"]))
ct = base64.b64decode(env["ct"], validate=True)
chk(hashlib.sha256(ct).hexdigest() == json.loads(h)["ct_sha256"], "ct_sha256")
pt = SealedBox(PrivateKey(bytes.fromhex(e["recipient"]["x_sk"]))).decrypt(ct)
chk(pt.decode() == e["plaintext_json"], "plaintext")
chk(PrivateKey(bytes.fromhex(e["recipient"]["x_sk"])).public_key.encode().hex() == e["recipient"]["x"], "x pk")
try:
    t = e["invalid"][0]["envelope"]
    VerifyKey(bytes.fromhex(e["sender"]["ed"])).verify(b"botlink-env-v1\n" + b64u(t["h"]), bytes.fromhex(t["sig"]))
    sys.exit("FAIL tampered verified")
except Exception: ok += 1

# ------------------------------------------------------------------ the member list rules (ENVELOPE §5), written from the spec
import re, unicodedata
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
HEX32 = re.compile(r"^[0-9a-f]{64}$")
HEXSIG = re.compile(r"^[0-9a-f]{128}$")
MNAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,23}$")
class Bad(Exception):
    def __init__(self, rule, seq=None): self.rule, self.seq = rule, seq
def strict(b):
    def hook(pairs):
        d = {}
        for k, v in pairs:
            if k in d: raise ValueError("duplicate key")
            d[k] = v
        return d
    return json.loads(b.decode("utf-8", errors="strict"), object_pairs_hook=hook)
def sig_ok(ctx, pk, msg, sig):
    try:
        VerifyKey(bytes.fromhex(pk)).verify(ctx.encode() + b"\n" + msg, bytes.fromhex(sig)); return True
    except Exception: return False
def replay(room, entries):
    """-> state {owner, people: acct -> {name, devices}, members: id -> {...}} or raises Bad(rule, seq)."""
    st = {"owner": None, "people": {}, "members": {}}
    prev = None
    for i, w in enumerate(entries):
        if not isinstance(w, dict) or w.get("seq") is None or not isinstance(w.get("entry"), str) or not isinstance(w.get("sig"), str) or not HEX32.match(str(w.get("signer", ""))): raise Bad("bad_wire", i)
        if w["seq"] != i: raise Bad("seq", i)
        try:
            b = b64u(w["entry"]); assert len(b) <= 4096; e = strict(b)
        except Exception: raise Bad("bad_entry", i)
        if not isinstance(e, dict) or e.get("v") != 1 or not isinstance(e.get("op"), str) or not isinstance(e.get("by"), str) or not isinstance(e.get("at"), int): raise Bad("bad_entry", i)
        if e.get("seq") != i: raise Bad("seq", i)
        if e.get("room") != room: raise Bad("room", i)
        if e["by"] != w["signer"]: raise Bad("by", i)
        if e.get("prev", "missing") != (None if i == 0 else prev): raise Bad("prev", i)
        if not sig_ok("botlink-roster-v1", w["signer"], b, w["sig"]): raise Bad("sig", i)
        by, op = e["by"], e["op"]
        dev_of = lambda acct: by in st["people"].get(acct, {}).get("devices", set())
        owner_dev = dev_of(st["owner"]) if st["owner"] else False
        if op == "genesis":
            if i != 0 or by != e.get("device"): raise Bad("op" if i else "signer", i)
            st["owner"] = e["owner"]; st["people"][e["owner"]] = {"name": None, "devices": {e["device"]}}
        elif i == 0: raise Bad("op", i)
        elif op == "person_add":
            if not owner_dev: raise Bad("signer", i)
            if e["account"] in st["people"]: raise Bad("op", i)
            st["people"][e["account"]] = {"name": e["name"], "devices": {e["device"]}}
        elif op == "person_remove":
            if not (owner_dev or dev_of(e["account"])): raise Bad("signer", i)
            if e["account"] == st["owner"] or e["account"] not in st["people"]: raise Bad("op", i)
            del st["people"][e["account"]]
            for k in [k for k, m in st["members"].items() if m["account"] == e["account"]]: del st["members"][k]
        elif op == "device_add":
            if not (dev_of(e["account"]) or owner_dev): raise Bad("signer", i)
            if e["account"] not in st["people"]: raise Bad("op", i)
            st["people"][e["account"]]["devices"].add(e["device"])
        elif op == "device_remove":
            if not (dev_of(e["account"]) or owner_dev): raise Bad("signer", i)
            st["people"][e["account"]]["devices"].discard(e["device"])
        elif op == "member_add":
            if not MNAME.match(str(e.get("name", ""))) or not HEX32.match(str(e.get("ed", ""))) or not HEX32.match(str(e.get("x", ""))): raise Bad("op", i)
            if not dev_of(e["account"]): raise Bad("signer", i)
            if e["member"] in st["members"] or any(m["name"] == e["name"] or m["ed"] == e["ed"] for m in st["members"].values()): raise Bad("op", i)
            st["members"][e["member"]] = {"account": e["account"], "name": e["name"], "ed": e["ed"], "x": e["x"], "fp": fp16(f"{e['ed']}|{e['x']}".encode()), "prev": []}
        elif op == "member_rekey":
            m = st["members"].get(e["member"])
            if not m: raise Bad("op", i)
            if not dev_of(m["account"]): raise Bad("signer", i)
            m["prev"].append({"ed": m["ed"], "fp": m["fp"], "until_at": e["at"]})
            m["ed"], m["x"], m["fp"] = e["ed"], e["x"], fp16(f"{e['ed']}|{e['x']}".encode())
        elif op == "member_remove":
            m = st["members"].get(e["member"])
            if not m: raise Bad("op", i)
            if not (by == m["ed"] or dev_of(m["account"]) or owner_dev): raise Bad("signer", i)
            del st["members"][e["member"]]
        else: raise Bad("op", i)
        prev = hashlib.sha256(b).hexdigest()
    return st

replay(ro["room_id"], ro["valid"]["entries"]); ok += 1
for v in ro["invalid"]:
    try:
        replay(ro["room_id"], v["entries"]); sys.exit(f"FAIL invalid member list accepted: {v['name']}")
    except Bad as x:
        chk((x.rule, x.seq) == (v["expect"]["rule"], v["expect"]["seq"]), f"member list {v['name']}: got {x.rule} at {x.seq}, want {v['expect']['rule']} at {v['expect']['seq']}")

# ------------------------------------------------------------------ the yes note (ENVELOPE §4a), written from the spec
y = L("yes-note.json")
FP = re.compile(r"^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$")
ACTIONS = {"read_files", "run_command", "change_files", "send_outside", "spend_money", "other"}
def line(s, mx):
    return isinstance(s, str) and 0 < len(s) <= mx and s.strip() == s and not any(ord(ch) < 0x20 or 0x7f <= ord(ch) <= 0x9f or ch in "\u2028\u2029" or unicodedata.category(ch) == "Cf" for ch in s)
def keys(o, ks): return isinstance(o, dict) and set(o) == set(ks)
def body_ok(b):
    common = ["v", "kind", "id", "room", "at", "by", "how"]
    if not isinstance(b, dict) or b.get("v") != 1: return False
    if b.get("kind") == "yes": ks = common + ["request", "action", "summary"]
    elif b.get("kind") == "allow": ks = common + ["grant"]
    else: return False
    if not keys(b, ks) or not UUID.match(str(b["id"])) or not UUID.match(str(b["room"])): return False
    if type(b["at"]) is not int or b["at"] <= 0 or b["how"] not in ("chat", "terminal"): return False
    by = b["by"]
    if not keys(by, ["member", "fp", "account", "person"]) or not UUID.match(str(by["member"])) or not FP.match(str(by["fp"])) or not UUID.match(str(by["account"])): return False
    if by["person"] is not None and not line(by["person"], 80): return False
    if b["kind"] == "yes":
        r = b["request"]
        if not keys(r, ["id", "from", "from_fp", "text_sha256"]) or not UUID.match(str(r["id"])) or not UUID.match(str(r["from"])) or not FP.match(str(r["from_fp"])) or not HEX32.match(str(r["text_sha256"])): return False
        return b["action"] in ACTIONS and line(b["summary"], 200)
    g = b["grant"]
    return keys(g, ["member", "fp", "setting", "while_away"]) and UUID.match(str(g["member"])) is not None and FP.match(str(g["fp"])) is not None and type(g["while_away"]) is bool and g["setting"] in ("answer", "files", "tasks")
def note_rule(n, h, st, room, now, resend_of=None):
    """None when the note checks out, else the rule it breaks (in the documented order)."""
    if not isinstance(n, dict) or n.get("v") != 1 or not isinstance(n.get("body"), str) or not HEXSIG.match(str(n.get("sig", ""))) or set(n) - {"v", "body", "sig", "device"}: return "bad_wire"
    try:
        bb = b64u(n["body"]); assert len(bb) <= 2048; b = strict(bb)
    except Exception: return "bad_body"
    if not body_ok(b): return "bad_body"
    if b["room"] != room or (h and h["room"] != b["room"]): return "room"
    m = st["members"].get(b["by"]["member"])
    if not m or m["account"] != b["by"]["account"]: return "signer"
    earlier = None
    if b["by"]["fp"] == m["fp"]: ed = m["ed"]
    else:
        earlier = next((k for k in m["prev"] if k["fp"] == b["by"]["fp"]), None)
        if not earlier: return "signer"
        ed = earlier["ed"]
    if not sig_ok("botlink-yes-v1", ed, bb, n["sig"]): return "sig"
    if earlier and (b["at"] > earlier["until_at"] + 300 or now > earlier["until_at"] + 7 * 86400): return "signer"
    if h and (h["from"] != b["by"]["member"] or h["from_fp"] != b["by"]["fp"]): return "sender"
    if h and b["id"] != h["id"] and not (resend_of and b["id"] == resend_of): return "id"
    signed = st["people"].get(m["account"], {}).get("name")
    if signed is not None and b["by"]["person"] != signed: return "person"
    if b["kind"] == "yes" and b["request"]["from"] == b["by"]["member"]: return "request"
    if b["kind"] == "allow" and b["grant"]["member"] == b["by"]["member"]: return "request"
    return None
yst = replay(y["room_id"], y["roster"])
for v in y["valid"]:
    chk(note_rule(v["note"], v.get("header"), yst, y["room_id"], y["now"], v.get("resend_of")) is None, f"yes note valid: {v['name']}")
    chk(strict(b64u(v["note"]["body"]))["kind"] == v["expect"]["kind"], f"yes note kind: {v['name']}")
for v in y["invalid"]:
    got = note_rule(v["note"], v.get("header"), yst, y["room_id"], y["now"], v.get("resend_of"))
    chk(got == v["expect"]["rule"], f"yes note invalid: {v['name']}: got {got}, want {v['expect']['rule']}")

p = L("push.json")
for c in p["cases"]:
    mac = hmac.new(bytes.fromhex(p["secret"]), f"botlink-push-v1\n{c['t']}\n".encode() + c["body"].encode(), hashlib.sha256).hexdigest()
    chk(mac == c["v1"], "push")
print(f"vectors OK ({ok} checks, PyNaCl {__import__('nacl').__version__})")

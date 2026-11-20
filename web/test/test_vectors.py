"""Cross-language crypto vectors (crypto/vectors/*.json) run against the dashboard's own WebCrypto
code in a real browser (PLAN.md §5.1, W). Also checks that what the browser signs, it verifies.

    python3 web/test/test_vectors.py [--base http://localhost:8829] [--browser chromium|webkit]
"""
import argparse, json, pathlib, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
VEC = ROOT / "crypto" / "vectors"

JS = r"""
async ({ fps, roster }) => {
  const c = await import("/assets/js/crypto.js");
  const out = [];
  const ok = (name, pass, detail = "") => out.push({ name, pass, detail });
  for (const v of fps.fp16) { const got = await c.fp16(c.utf8(v.input_utf8)); ok(`fp16 ${JSON.stringify(v.input_utf8)}`, got === v.fp, got); }
  for (const v of fps.member) { const got = await c.memberFingerprint(v.ed, v.x); ok(`member fp ${v.fp}`, got === v.fp, got); }
  for (const v of fps.device) { const got = await c.deviceFingerprint(v.pk); ok(`device fp ${v.fp}`, got === v.fp, got); }

  // valid roster
  try {
    const st = await c.verifyRoster(roster.room_id, roster.valid.entries);
    const ex = roster.valid.expect;
    ok("roster valid: room fp", st.roomFp === ex.room_fp, st.roomFp);
    ok("roster valid: head", st.headSeq === ex.head_seq && st.headHash === ex.head_hash, `${st.headSeq} ${st.headHash}`);
    ok("roster valid: owner", st.owner === ex.owner, st.owner);
    const people = ex.people.every((p) => st.people.has(p.account) && p.devices.every((d) => st.people.get(p.account).devices.has(d))) && st.people.size === ex.people.length;
    ok("roster valid: people", people);
    const members = ex.members.every((m) => { const g = st.members.get(m.id); return g && g.name === m.name && g.app === m.app && g.ed === m.ed && g.x === m.x && g.account === m.account; }) && st.members.size === ex.members.length;
    ok("roster valid: members", members);
    for (const m of ex.members) ok(`member fp ${m.name}`, (await c.memberFingerprint(m.ed, m.x)) === m.fp);
  } catch (e) { ok("roster valid", false, String(e.message || e)); }

  for (const inv of roster.invalid) {
    try { await c.verifyRoster(roster.room_id, inv.entries); ok(`roster invalid ${inv.name}`, false, "accepted"); }
    catch (e) { ok(`roster invalid ${inv.name}`, e.rule === inv.expect.rule && e.seq === inv.expect.seq, `${e.rule}@${e.seq} want ${inv.expect.rule}@${inv.expect.seq}`); }
  }

  // Round trip: what this browser signs, it verifies; tampering is caught.
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  const pk = c.toHex(await crypto.subtle.exportKey("raw", kp.publicKey));
  const dev = { pk, keyPair: kp };
  const room = c.uuidv7(), owner = c.uuidv7();
  const g = await c.signRosterEntry(dev, { room, seq: 0, prev: null, op: "genesis", name: "acme", owner, device: pk });
  const ed = "11".repeat(32), x = "22".repeat(32);
  const m = await c.signRosterEntry(dev, { room, seq: 1, prev: await c.sha256Hex(g.bytes), op: "member_add", member: c.uuidv7(), account: owner, name: "bugfix", app: "claude-code", ed, x });
  const st = await c.verifyRoster(room, [g.wire, m.wire]);
  ok("round trip: signed log verifies", st.members.size === 1 && st.headSeq === 1);
  const tampered = { ...m.wire, entry: c.b64urlEncode(c.utf8(c.fromUtf8(c.b64urlDecode(m.wire.entry)).replace("bugfix", "evilbot"))) };
  try { await c.verifyRoster(room, [g.wire, tampered]); ok("round trip: tamper caught", false); } catch (e) { ok("round trip: tamper caught", e.rule === "sig", e.rule); }
  const v7 = c.uuidv7();
  ok("uuidv7 shape", /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v7), v7);
  try { c.strictParse('{"a":1,"a":2}'); ok("strict JSON rejects duplicate keys", false); } catch { ok("strict JSON rejects duplicate keys", true); }
  return out;
}
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8829")
    ap.add_argument("--browser", default="chromium")
    a = ap.parse_args()
    fps = json.loads((VEC / "fingerprints.json").read_text())
    roster = json.loads((VEC / "roster.json").read_text())
    with sync_playwright() as p:
        b = getattr(p, a.browser).launch()
        pg = b.new_page()
        pg.goto(a.base + "/docs")
        res = pg.evaluate(JS, {"fps": fps, "roster": roster})
        b.close()
    bad = [r for r in res if not r["pass"]]
    for r in res:
        print(("PASS " if r["pass"] else "FAIL ") + r["name"] + ("" if r["pass"] else f"  ({r['detail']})"))
    print(f"\n{len(res) - len(bad)}/{len(res)} passed")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()

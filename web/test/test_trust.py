"""Trust page check (web/public/trust.html, built by web/scripts/trust-facts.mjs).

1. The page at 390x844 and 1440x900, light and dark: 0 console errors, 0 failed requests, no sideways scroll, no text
   under 13px, >= 44px tap targets, WCAG AA contrast on every visible text run (every <details> opened).
2. Facts on the page against their sources, read here independently of the script: client version, pinned release
   key, the stored member fields (folder and computer name included), the four settings, one row per safety scenario,
   the security address. Plain words only outside code; the page is linked only from the landing's security steps.
3. The three commands on the page really check a signed release: a throwaway key signs a tiny tarball, the commands
   (with that key put in) say OK, and NOT OK once the tarball changes.
4. The drift check fails when a source fact changes: a copy of every file the script reads, one fact changed.
5. Eval results are checked for validity, not freshness: a newer result file keeps the check green (the deploy gate
   records results after the code); a cited result that changes or disappears turns it red.

    python3 web/test/test_trust.py [--port 8951] [--shots <dir>]
"""
import argparse, codecs, functools, http.server, json, pathlib, re, shutil, subprocess, sys, tarfile, tempfile, threading

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "web" / "public"
SCRIPT = ROOT / "web" / "scripts" / "trust-facts.mjs"
VIEWPORTS = {"phone": {"width": 390, "height": 844}, "desktop": {"width": 1440, "height": 900}}
# internal names, rot13-encoded so the names themselves are not spelled in this public file
_INTERNAL = "|".join(codecs.decode(w, "rot13") for w in ("pnera", "rqvgu", "snoyr", "yvtugfyvcf", "zbxh"))
BAD = re.compile(r"\b(receipts?|seen|answered|webhooks?|delivered|delivery|leases?|envelopes?|epoch|chatgpt|" + _INTERNAL +
                 r"|open[ -]source|soc ?2|compliance|compliant|tamper-proof|complete record|independent)\b|—", re.I)

AUDIT_JS = r"""
() => {
  const parse = (c) => {
    let m = c.match(/rgba?\(([\d.]+),?\s*([\d.]+),?\s*([\d.]+)(?:[,\/]\s*([\d.]+))?\)/);
    if (m) return [+m[1] / 255, +m[2] / 255, +m[3] / 255, m[4] === undefined ? 1 : +m[4]];
    m = c.match(/color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)/);
    if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
    return null;
  };
  const lum = ([r, g, b]) => { const f = (v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const over = (top, bot) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + bot[i] * (1 - a)).concat(1); };
  const bgOf = (el) => {
    const layers = [];
    for (let a = el; a; a = a.parentElement) { const c = parse(getComputedStyle(a).backgroundColor); if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; } }
    let bg = [1, 1, 1, 1];
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    return bg;
  };
  const visible = (el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const out = { overflow: document.documentElement.scrollWidth - window.innerWidth, small: [], contrast: [], targets: [] };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const done = new Set();
  while (walker.nextNode()) {
    const el = walker.currentNode.parentElement;
    if (!walker.currentNode.textContent.trim() || !el || done.has(el) || !visible(el)) continue;
    done.add(el);
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    if (size < 13) out.small.push(`${el.tagName} "${walker.currentNode.textContent.trim().slice(0, 30)}" ${size}px`);
    const fg = parse(cs.color), bg = bgOf(el);
    if (!fg) { out.contrast.push(`unparsed colour ${cs.color}`); continue; }
    const f = over(fg, bg), L1 = lum(f), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const need = size >= 24 || (parseInt(cs.fontWeight) >= 700 && size >= 18.66) ? 3 : 4.5;
    if (ratio < need) out.contrast.push(`${ratio.toFixed(2)} < ${need}: "${walker.currentNode.textContent.trim().slice(0, 40)}" (${el.tagName}.${el.className})`);
  }
  for (const el of document.querySelectorAll("a[href], button, summary")) {
    if (!visible(el) || (el.tagName === "A" && el.closest("p, li"))) continue; // inline text links
    const r = el.getBoundingClientRect();
    if (r.height < 43.5 || r.width < 43.5) out.targets.push(`${el.tagName} "${el.textContent.trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  out.bg = getComputedStyle(document.body).backgroundColor;
  return out;
}
"""

# text of <main> outside <code> and <pre>: what must follow the product text rules
PROSE_JS = r"""
() => { const m = document.querySelector("main").cloneNode(true); m.querySelectorAll("code, pre").forEach((e) => e.remove()); return m.textContent; }
"""


def serve(port):
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    handler = functools.partial(Quiet, directory=str(PUBLIC))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def migration_columns(table):
    cols = []
    for f in sorted((ROOT / "db" / "migrations").glob("*.sql")):
        sql = re.sub(r"--[^\n]*", "", f.read_text())
        m = re.search(r"create table (?:if not exists )?%s \(([\s\S]*?)\n\);" % table, sql)
        if m:
            cols += [c.group(1) for c in (re.match(r"\s*([a-z_][a-z0-9_]*)\s+(uuid|text|bytea|int|bigint|bigserial|smallint|boolean|timestamptz|jsonb|date)\b", l) for l in m.group(1).split("\n")) if c]
        cols += re.findall(r"alter table %s add column (?:if not exists )?(\w+)" % table, sql)
    return cols


def check_facts(pg, fails):
    text = pg.inner_text("main")
    pkg = json.loads((ROOT / "client" / "package.json").read_text())
    for want in (pkg["name"], pkg["version"]):
        if want not in text:
            fails.append(f"facts: client/package.json says {want!r}; the page does not")
    rel = (ROOT / "client" / "src" / "release.ts").read_text()
    kid, pk = re.search(r'id: "([0-9a-f]{16})", pk: "([0-9a-f]{64})"', rel).groups()
    if kid not in text or pk not in text:
        fails.append("facts: the pinned release key in client/src/release.ts is not on the page")
    cmds = "\n".join(pg.locator("pre").all_inner_texts())
    if pk not in cmds:
        fails.append("facts: the check commands do not use the pinned key")
    # every stored member field, folder and computer name first
    member_rows = pg.evaluate("""() => [...document.querySelectorAll("details table")].flatMap((t) => [...t.querySelectorAll("tr td:first-child code")].map((c) => c.textContent))""")
    for col in ("folder", "machine", "session_id", "user_agent"):
        if col not in member_rows:
            fails.append(f"facts: stored field {col} is not listed")
    for col in migration_columns("members"):
        if col not in member_rows:
            fails.append(f"facts: members.{col} (db/migrations) is not listed")
    # lane FREE: with the paywall off (copy-check.mjs PAYWALL = false) the payment tables are listed by name in one
    # neutral "Switched off" group, not field by field
    paywall = re.search(r"^export const PAYWALL = (true|false);", (ROOT / "web" / "scripts" / "copy-check.mjs").read_text(), re.M).group(1) == "true"
    for table in ("account_billing", "billing_events", "wake_policies", "room_week_senders"):
        if not paywall and table in ("account_billing", "billing_events"):
            off = pg.evaluate("""() => [...document.querySelectorAll("details")].filter((d) => /^Switched off/.test(d.querySelector("summary")?.textContent || "")).map((d) => d.textContent).join(" ")""")
            if table not in off:
                fails.append(f"facts: {table} is not in the switched-off group")
            continue
        for col in migration_columns(table):
            if col not in member_rows:
                fails.append(f"facts: {table}.{col} (db/migrations) is not listed")
    an = (ROOT / "server" / "internal" / "analytics" / "analytics.go").read_text()
    for ev in re.findall(r'Event = "(\w+)"', an):
        if ev not in text:
            fails.append(f"facts: analytics event {ev} is not listed")
    for want in ("A yes, written down", "evidence of a decision, not enforcement", "botlink report verify <bundle.json>"):
        if want not in text:
            fails.append(f"facts: {want!r} is not on the page")
    perms = (ROOT / "client" / "src" / "perms.ts").read_text()
    says = dict(re.findall(r'^\s+(muted|answer|files|tasks): "([^"]+)",$', perms, re.M))
    table = pg.inner_text("table.perm-table")
    for lvl in ("muted", "answer", "files", "tasks"):
        if says.get(lvl) not in table:
            fails.append(f"facts: setting {lvl} ({says.get(lvl)!r}) is not in the settings table")
    if "Enforced by code" not in table or "The model is told to" not in table:
        fails.append("facts: the settings table does not say what is enforced and what is told")
    n = len(list((ROOT / "evals" / "scenarios" / "safety").glob("*.yaml")))
    rows = pg.locator("#tested ~ .table-wrap").first.locator("tr").count() - 1
    if rows != n:
        fails.append(f"facts: {n} safety scenarios, {rows} rows on the page")
    mail = re.search(r'href="mailto:([^"]+)"', (PUBLIC / "security.html").read_text()).group(1)
    if not pg.locator(f'a[href="mailto:{mail}"]').count():
        fails.append(f"facts: {mail} (security.html) is not the address on the page")
    prose = pg.evaluate(PROSE_JS)
    for m in BAD.finditer(prose):
        fails.append(f"words: {m.group(0)!r} in {prose[max(0, m.start() - 40):m.end() + 20]!r}")


# a link is an href to the page (a host table naming the path, web/public/assets/js/hosts.js, links nothing)
TRUST_LINK = re.compile(r"""href\s*[:=]\s*["'`][^"'`]*trust\.html""")
LINKED_FROM = {"web/public/assets/js/views/landing.js"}  # its "see the actual signed request" link (landing-claims.json)


def check_unlinked(fails):
    """The trust page is linked from the landing's security steps (through the generated claims) and from nowhere else."""
    for f in PUBLIC.rglob("*"):
        rel = str(f.relative_to(ROOT))
        if f.is_file() and f.suffix in (".html", ".js") and f.name != "trust.html" and rel not in LINKED_FROM and TRUST_LINK.search(f.read_text(errors="ignore")):
            fails.append(f"linked: {rel} links the trust page (only the landing's security steps do)")
    claims = json.loads((PUBLIC / "assets" / "landing-claims.json").read_text())
    if not claims["section"]["trust_link"]["href"].startswith("/trust.html#"):
        fails.append("linked: the landing's claims no longer link the trust page")


def check_commands(pg, fails):
    pre = pg.locator("pre").first.inner_text()
    node_cmd = pre[pre.index("node -e '"):].strip()
    rel = (ROOT / "client" / "src" / "release.ts").read_text()
    pinned = re.search(r'pk: "([0-9a-f]{64})"', rel).group(1)
    with tempfile.TemporaryDirectory() as tmp:
        tmp = pathlib.Path(tmp)
        keydir = tmp / "key"
        sign = ["node", str(ROOT / "deploy" / "release-sign.mjs")]
        subprocess.run(sign + ["keygen", "--dir", str(keydir)], check=True, capture_output=True)
        pk = json.loads((keydir / "public.json").read_text())["pk"]
        pkgdir = tmp / "src" / "package"
        pkgdir.mkdir(parents=True)
        (pkgdir / "package.json").write_text(json.dumps({"name": "botlink", "version": "1.0.0-dev"}))
        dl = tmp / "dl"
        dl.mkdir()
        with tarfile.open(dl / "botlink.tgz", "w:gz") as t:
            t.add(pkgdir, arcname="package")
        subprocess.run(sign + ["sign", "--dir", str(keydir), "--tarball", str(dl / "botlink.tgz")], check=True, capture_output=True)
        cmd = node_cmd.replace(pinned, pk)
        r = subprocess.run(["sh", "-c", cmd], cwd=dl, capture_output=True, text=True)
        if r.returncode != 0 or not r.stdout.startswith("OK: release 1, botlink 1.0.0-dev"):
            fails.append(f"commands: a correctly signed release did not check out: {r.returncode} {r.stdout.strip()} {r.stderr.strip()[:200]}")
        r = subprocess.run(["sh", "-c", node_cmd], cwd=dl, capture_output=True, text=True)
        if r.returncode == 0 or "not signed with the pinned key" not in r.stdout:
            fails.append(f"commands: a release signed by another key passed: {r.stdout.strip()}")
        with open(dl / "botlink.tgz", "ab") as f:
            f.write(b"x")
        r = subprocess.run(["sh", "-c", cmd], cwd=dl, capture_output=True, text=True)
        if r.returncode == 0 or "not the one the signed release names" not in r.stdout:
            fails.append(f"commands: a changed file passed: {r.stdout.strip()}")


def check_drift(fails):
    inputs = subprocess.run(["node", str(SCRIPT), "--inputs"], capture_output=True, text=True, check=True).stdout.split()
    with tempfile.TemporaryDirectory() as tmp:
        tmp = pathlib.Path(tmp)
        for f in inputs + ["web/public/assets/trust-facts.json", "web/public/assets/landing-claims.json"]:
            (tmp / f).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / f, tmp / f)
        check = lambda: subprocess.run(["node", str(SCRIPT), "--check", "--root", str(tmp)], capture_output=True, text=True)
        r = check()
        if r.returncode != 0:
            fails.append(f"drift: an unchanged copy fails the check: {r.stderr.strip()[:300]}")
            return
        pj = tmp / "client" / "package.json"
        orig = pj.read_text()
        pj.write_text(orig.replace('"version": "', '"version": "9.', 1))
        r = check()
        if r.returncode == 0:
            fails.append(f"drift: a changed client version passed the check: {r.stdout.strip()}")
        pj.write_text(orig)
        up = tmp / "client" / "src" / "update.ts"
        orig = up.read_text()
        up.write_text(orig.replace(": 6 * 3600) * 1000", ": 12 * 3600) * 1000", 1))
        r = check()
        if r.returncode == 0 or "trust-facts.json: differs" not in r.stderr or "trust.html: differs" not in r.stderr:
            fails.append(f"drift: a changed update interval passed the check: {r.stdout.strip()} {r.stderr.strip()[:200]}")
        up.write_text(orig)
        rel = tmp / "client" / "src" / "release.ts"
        orig = rel.read_text()
        rel.write_text(orig.replace("never set by an install", "set by some installs"))
        r = check()
        if r.returncode == 0 or "no longer found in client/src/release.ts" not in r.stderr:
            fails.append(f"drift: a sentence whose source is gone passed the check: {r.stderr.strip()[:200]}")
        rel.write_text(orig)
        check_results(tmp, check, fails)
        mig = sorted((tmp / "db" / "migrations").glob("*.sql"))[-1]
        mig.write_text(mig.read_text() + "\nalter table members add column home_address text;\n")
        r = check()
        if r.returncode == 0 or "members.home_address is stored but the trust page does not say what it is" not in r.stderr:
            fails.append(f"drift: a new stored field passed the check: {r.stderr.strip()[:200]}")


def check_results(tmp, check, fails):
    facts = json.loads((tmp / "web/public/assets/trust-facts.json").read_text())["facts"]["evals"]
    cited = [c for s in facts["scenarios"] for c in (s["scripted"], s["real"]) if c]
    if not cited:
        fails.append("results: the page cites no eval result")
        return
    res = tmp / "evals" / "results"
    # (1) a newer result, for every safety scenario, with a different outcome: still green
    newer = {"sha": "f" * 40, "tiers": {"det": {"tier": "det", "status": "FAIL", "at": "2099-01-01T00:00:00.000Z", "client": "fffffff",
             "scenarios": [{"id": s["id"], "status": "FAIL", "pass": False, "checks": "0/1", "failed": ["x"]} for s in facts["scenarios"]]}}}
    (res / ("f" * 40 + ".json")).write_text(json.dumps(newer))
    r = check()
    if r.returncode != 0:
        fails.append(f"results: a newer result file turned the check red: {r.stderr.strip()[:300]}")
    (res / ("f" * 40 + ".json")).unlink()
    # (2a) a cited result's outcome changes: red
    c = cited[0]
    f = tmp / c["file"]
    orig = f.read_text()
    d = json.loads(orig)
    for x in d["tiers"][c["tier"]]["scenarios"]:
        if x["id"] == c["ran"]:
            x["status"] = "FAIL" if c["status"] == "PASS" else "PASS"
            x["pass"] = x["status"] == "PASS"
    f.write_text(json.dumps(d))
    r = check()
    if r.returncode == 0 or "no longer recorded so" not in r.stderr:
        fails.append(f"results: a changed cited outcome passed the check: {r.stderr.strip()[:200]}")
    # (2b) a cited result is deleted: red
    f.unlink()
    r = check()
    if r.returncode == 0 or "no longer recorded so" not in r.stderr:
        fails.append(f"results: a deleted cited result passed the check: {r.stderr.strip()[:200]}")
    f.write_text(orig)
    # (2c) a result dated before the page's cut-off appears for a scenario shown with no run: red
    blank = next(((s, k) for s in facts["scenarios"] for k in ("scripted", "real") if not s[k]), None)
    if blank:
        s, k = blank
        tier = "det" if k == "scripted" else "full"
        old = {"sha": "e" * 40, "tiers": {tier: {"tier": tier, "status": "PASS", "at": facts["through"], "client": "eeeeeee",
               "scenarios": [{"id": s["id"], "status": "PASS", "pass": True, "checks": "1/1", "failed": []}]}}}
        (res / ("e" * 40 + ".json")).write_text(json.dumps(old))
        r = check()
        if r.returncode == 0 or "had no" not in r.stderr:
            fails.append(f"results: a run hidden behind 'no run recorded' passed the check: {r.stderr.strip()[:200]}")
        (res / ("e" * 40 + ".json")).unlink()
    if check().returncode != 0:
        fails.append("results: the restored copy fails the check")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8951)
    ap.add_argument("--shots", default="")
    a = ap.parse_args()
    fails = []
    r = subprocess.run(["node", str(SCRIPT), "--check"], capture_output=True, text=True)
    if r.returncode != 0:
        fails.append(f"drift: the committed page differs from the code: {r.stderr.strip()}")
    httpd = serve(a.port)
    base = f"http://127.0.0.1:{a.port}"
    runs = 0
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            bgs = {}
            for vp, size in VIEWPORTS.items():
                for scheme in ("light", "dark"):
                    ctx = browser.new_context(viewport=size, color_scheme=scheme, device_scale_factor=2 if vp == "phone" else 1)
                    pg = ctx.new_page()
                    errors = []
                    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
                    pg.on("pageerror", lambda e: errors.append(str(e)))
                    pg.on("requestfailed", lambda q: errors.append(f"failed {q.url}"))
                    pg.on("response", lambda s: errors.append(f"{s.status} {s.url}") if s.status >= 400 else None)
                    pg.goto(f"{base}/trust.html", wait_until="networkidle")
                    pg.evaluate("() => document.querySelectorAll('details').forEach((d) => d.open = true)")
                    au = pg.evaluate(AUDIT_JS)
                    tag = f"{vp}/{scheme}"
                    fails += [f"{tag}: {e}" for e in errors]
                    if au["overflow"] > 0:
                        fails.append(f"{tag}: page scrolls sideways by {au['overflow']}px")
                    fails += [f"{tag}: small text {s}" for s in au["small"]]
                    fails += [f"{tag}: contrast {s}" for s in au["contrast"]]
                    fails += [f"{tag}: tap target {s}" for s in au["targets"]]
                    bgs[tag] = au["bg"]
                    if a.shots:
                        pathlib.Path(a.shots).mkdir(parents=True, exist_ok=True)
                        pg.screenshot(path=f"{a.shots}/trust-{vp}-{scheme}.png", full_page=True)
                    if tag == "desktop/light":
                        check_facts(pg, fails)
                        check_commands(pg, fails)
                    runs += 1
                    ctx.close()
            for vp in VIEWPORTS:
                if bgs[f"{vp}/light"] == bgs[f"{vp}/dark"]:
                    fails.append(f"{vp}: dark mode does not change the page")
            browser.close()
    finally:
        httpd.shutdown()
    check_unlinked(fails)
    check_drift(fails)
    for f in fails:
        print("FAIL", f)
    print(f"trust page: {runs} renders, {len(fails)} problems")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()

"""The header's GitHub link and star count (web/public/assets/js/github-link.js; server: GET /site/github.json,
server/internal/pages/github_stars.go), in a real browser at 390x844 and 1440x900, light and dark.

With a source URL (the mock's MOCK_SOURCE_URL, like BOTLINK_SOURCE_URL): the landing header (signed out) and the app
header (signed in) each carry one GitHub link to exactly that address, in a new tab, rel="noopener noreferrer", with
the mark (monochrome, the link's own colour) and an accessible name; the label shows on a desktop, the mark alone on
a phone; the header stays on one line; the link takes keyboard focus. The count shows at 50 ("50"), as "1.2k" at 1234,
and not at 49, with no count held, or when the endpoint fails. Without a source URL: no link and no request for the count.
The mock is started here twice, once per setting, on ports from --port (57000-57099). Screenshots: web/shots/github-link/.

    python3 web/test/test_github_link.py [--port 57010]
"""
import argparse, os, pathlib, re, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from test_e2e import Run, sign_in  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
SHOTS = ROOT / "web" / "shots" / "github-link"
URL = "https://github.com/charles161/botlink"

HEADER_JS = r"""() => {
  const nav = document.querySelector(".nav"), side = document.querySelector("#nav-side");
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden"; };
  const links = [...document.querySelectorAll("a[data-github-link]")];
  const a = links[0];
  const nr = nav.getBoundingClientRect();
  const items = [nav.querySelector(".logo"), ...side.children].filter(vis).map((el) => el.getBoundingClientRect());
  const out = { count: links.length, navH: nr.height, overflow: document.documentElement.scrollWidth - innerWidth,
    oneLine: items.every((r) => r.top >= nr.top - 1 && r.bottom <= nr.bottom + 1 && Math.abs((r.top + r.bottom) / 2 - (items[0].top + items[0].bottom) / 2) < 6),
    inNav: !!a && nav.contains(a) };
  if (!a) return out;
  const r = a.getBoundingClientRect(), svg = a.querySelector("svg"), label = a.querySelector(".gh-label"), stars = a.querySelector(".gh-stars");
  return Object.assign(out, { href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel"), name: a.getAttribute("aria-label") || "",
    w: r.width, h: r.height, right: r.right, svg: !!svg && vis(svg), svgFill: svg && getComputedStyle(svg).fill, color: getComputedStyle(a).color,
    svgImg: svg && svg.getAttribute("aria-hidden"), externalImg: a.querySelectorAll("img").length,
    label: !!label && vis(label), stars: stars ? stars.textContent : null, starsVisible: !!stars && vis(stars) });
}"""


def start_mock(port, source):
    env = dict(os.environ, PORT=str(port))
    env.pop("MOCK_SOURCE_URL", None)
    if source:
        env["MOCK_SOURCE_URL"] = source
    log = tempfile.NamedTemporaryFile(prefix=f"mock-github-{port}-", suffix=".log", delete=False)
    proc = subprocess.Popen(["node", str(ROOT / "web" / "test" / "fixtures" / "mock-server.mjs")], env=env, stdout=log, stderr=subprocess.STDOUT)
    base = f"http://localhost:{port}"
    for _ in range(100):
        try:
            urllib.request.urlopen(base + "/healthz", timeout=1)
            return proc, base
        except Exception:
            time.sleep(0.1)
    proc.terminate()
    raise SystemExit(f"mock on {port} did not start")


def set_stars(base, stars=None, status=200):
    import json
    req = urllib.request.Request(base + "/__mock/github", data=json.dumps({"stars": stars, "status": status}).encode(), headers={"Content-Type": "application/json"}, method="POST")
    urllib.request.urlopen(req, timeout=5).read()


class Checks:
    def __init__(self):
        self.fails, self.n = [], 0

    def ok(self, cond, msg):
        self.n += 1
        if not cond:
            self.fails.append(msg)


def header(r, tag, signed_in, ignore_load_errors=False):
    """Open the header (landing signed out, rooms signed in), wait for the count request, read it."""
    asked = []
    r.pg.on("request", lambda q: asked.append(q.url) if "/site/github.json" in q.url else None)
    if signed_in:
        sign_in(r, f"gh-{tag}@example.com", "GH Tester")
        asked.clear()  # count the requests of one page load: the reload below
        r.go("/rooms")
    else:
        r.go("/")
    r.settle(500)
    if ignore_load_errors:
        r.errors = [e for e in r.errors if "Failed to load resource" not in e]
    return r.pg.evaluate(HEADER_JS), asked


def with_source(b, base, c):
    for vp in ("phone", "desktop"):
        for scheme in ("light", "dark"):
            for signed_in in (False, True):
                where = f"{vp} {scheme} {'app' if signed_in else 'landing'}"
                tag = f"{vp}-{scheme}-{'app' if signed_in else 'landing'}"
                set_stars(base, 1234)
                r = Run(b, base, vp, scheme)
                h, asked = header(r, tag, signed_in)
                c.ok(h["count"] == 1 and h["inNav"], f"{where}: want one GitHub link in the header, got {h['count']}")
                if h["count"] != 1:
                    r.close(); continue
                c.ok(h["href"] == URL, f"{where}: href {h['href']!r}, want {URL}")
                c.ok(h["target"] == "_blank" and h["rel"] == "noopener noreferrer", f"{where}: target {h['target']!r} rel {h['rel']!r}")
                c.ok(h["name"].startswith("GitHub"), f"{where}: accessible name {h['name']!r}")
                c.ok(h["svg"] and h["svgImg"] == "true" and h["externalImg"] == 0, f"{where}: want the inline mark (aria-hidden), no image")
                c.ok(h["svgFill"] == h["color"], f"{where}: mark fill {h['svgFill']} != link colour {h['color']} (monochrome, follows the theme)")
                c.ok(h["w"] >= 43.5 and h["h"] >= 43.5, f"{where}: tap target {h['w']:.0f}x{h['h']:.0f}")
                c.ok(h["oneLine"] and h["navH"] <= 68.5, f"{where}: header not on one line (height {h['navH']})")
                c.ok(h["overflow"] <= 0, f"{where}: horizontal overflow {h['overflow']}px")
                c.ok(len(asked) == 1, f"{where}: {len(asked)} requests for the count, want 1")
                c.ok(h["stars"] == "1.2k", f"{where}: count {h['stars']!r}, want 1.2k at 1234")
                c.ok("1.2k stars" in h["name"], f"{where}: the count is not in the accessible name: {h['name']!r}")
                if vp == "desktop":
                    c.ok(h["label"] and h["starsVisible"], f"{where}: desktop should show the label and the count")
                else:
                    c.ok(not h["label"] and not h["starsVisible"], f"{where}: phone should show the mark alone")
                # keyboard: Tab reaches the link and it shows a focus ring
                focused = False
                r.pg.evaluate("() => { document.activeElement?.blur(); window.scrollTo(0, 0); }")
                for _ in range(30):
                    r.pg.keyboard.press("Tab")
                    if r.pg.evaluate("() => document.activeElement?.hasAttribute('data-github-link')"):
                        focused = True
                        break
                ring = r.pg.evaluate("() => getComputedStyle(document.activeElement).outlineStyle") if focused else "none"
                c.ok(focused and ring != "none", f"{where}: keyboard focus did not reach the link with a visible ring (focused={focused}, outline={ring})")
                SHOTS.mkdir(parents=True, exist_ok=True)
                r.pg.screenshot(path=str(SHOTS / f"{tag}-focus.png"), clip={"x": 0, "y": 0, "width": r.pg.viewport_size["width"], "height": 80})
                r.pg.evaluate("() => document.activeElement?.blur()")
                r.pg.screenshot(path=str(SHOTS / f"{tag}.png"))
                c.ok(not r.errors, f"{where}: console errors {r.errors[:3]}")
                r.close()
    # the threshold and the failures (desktop, where the count shows)
    for stars, status, want, name in ((50, 200, "50", "50 stars"), (49, 200, None, "49 stars"), (None, 200, None, "no count held"),
                                      (999, 500, None, "endpoint fails"), (12345, 200, "12.3k", "12345 stars")):
        set_stars(base, stars, status)
        for signed_in in (False, True):
            where = f"desktop {name} {'app' if signed_in else 'landing'}"
            r = Run(b, base, "desktop")
            h, _ = header(r, f"t{stars}-{status}-{int(signed_in)}", signed_in, ignore_load_errors=status != 200)
            c.ok(h["count"] == 1, f"{where}: link missing")
            c.ok(h.get("stars") == want, f"{where}: count {h.get('stars')!r}, want {want!r}")
            c.ok(want is None or h.get("starsVisible"), f"{where}: count not visible")
            c.ok(want is not None or h.get("name") == "GitHub (opens in a new tab)", f"{where}: name {h.get('name')!r}")
            c.ok(not r.errors, f"{where}: console errors {r.errors[:3]}")
            if not signed_in and stars in (49, 50):
                r.pg.screenshot(path=str(SHOTS / f"desktop-light-landing-{stars}.png"), clip={"x": 0, "y": 0, "width": 1440, "height": 80})
            r.close()
    set_stars(base, None)


def without_source(b, base, c):
    set_stars(base, 1234)
    for vp in ("phone", "desktop"):
        for signed_in in (False, True):
            where = f"no source, {vp} {'app' if signed_in else 'landing'}"
            r = Run(b, base, vp)
            h, asked = header(r, f"none-{vp}", signed_in)
            c.ok(h["count"] == 0, f"{where}: {h['count']} GitHub links, want none")
            nav_text = r.pg.evaluate("() => document.querySelector('#nav-side')?.textContent || ''")
            c.ok("null" not in nav_text.lower(), f"{where}: header rendered literal 'null' text: {nav_text!r}")
            c.ok(not asked, f"{where}: asked for the count with no source URL: {asked}")
            c.ok(not r.errors, f"{where}: console errors {r.errors[:3]}")
            r.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=57010)
    a = ap.parse_args()
    c = Checks()
    with sync_playwright() as p:
        b = p.chromium.launch()
        for source, port in ((URL, a.port), ("", a.port + 1)):
            proc, base = start_mock(port, source)
            try:
                (with_source if source else without_source)(b, base, c)
            finally:
                proc.terminate()
                proc.wait(timeout=5)
        b.close()
    for f in c.fails:
        print("FAIL ", f)
    print(f"{c.n - len(c.fails)}/{c.n} checks passed")
    print("OK" if not c.fails else "NOT OK")
    sys.exit(0 if not c.fails else 1)


if __name__ == "__main__":
    main()

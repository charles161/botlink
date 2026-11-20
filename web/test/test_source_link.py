"""The "Self-host it" link (BOTLINK_SOURCE_URL; the mock's MOCK_SOURCE_URL), in a real browser at 390x844 and 1440x900.

Unset: the landing page, the docs and the trust page show no "Self-host it" link and no link to any other repository.
Set: each of the three shows exactly one "Self-host it" link, pointing exactly at the configured address, as a plain
external link (rel="noopener noreferrer"). The mock is started here twice, once per setting, on ports from --port.
Either way the landing page also carries one typed link to the public repository (REPO; test_landing.py checks its
words); it is counted apart from "Self-host it" here.

    python3 web/test/test_source_link.py [--port 9901]
"""
import argparse, os, pathlib, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
VIEWPORTS = {"phone": {"width": 390, "height": 844}, "desktop": {"width": 1440, "height": 900}}
URL = "https://github.com/example-owner/botlink"
REPO = {"href": "https://github.com/charles161/botlink", "rel": "noopener noreferrer", "text": "github.com/charles161/botlink", "target": ""}
# how many typed links to it each page carries: the landing's line only (the trust page names the repository only
# through the setting's footer link: server/internal/pages/source_test.go)
TYPED = {"landing": 1, "docs": 0, "trust": 0}
PAGES = {"landing": "/", "docs": "/docs", "trust": "/trust.html"}
LINKS_JS = r"""() => Array.from(document.querySelectorAll("a")).filter((a) => /github\.com/i.test(a.href) || /self-host/i.test(a.textContent))
  .map((a) => ({ href: a.getAttribute("href"), rel: a.getAttribute("rel") || "", text: a.textContent.trim(), target: a.getAttribute("target") || "" }))"""


def start_mock(port, source):
    env = dict(os.environ, PORT=str(port))
    env.pop("MOCK_SOURCE_URL", None)
    if source:
        env["MOCK_SOURCE_URL"] = source
    log = tempfile.NamedTemporaryFile(prefix=f"mock-source-{port}-", suffix=".log", delete=False)
    proc = subprocess.Popen(["node", str(ROOT / "web" / "test" / "fixtures" / "mock-server.mjs")], env=env, stdout=log, stderr=subprocess.STDOUT)
    base = f"http://localhost:{port}"
    for _ in range(100):
        try:
            urllib.request.urlopen(base + "/healthz", timeout=1)
            return proc, base
        except Exception:
            time.sleep(0.1)
    proc.terminate()
    raise SystemExit("mock did not start")


def links(browser, base, vp, path):
    ctx = browser.new_context(viewport=VIEWPORTS[vp])
    pg = ctx.new_page()
    pg.goto(base + path, wait_until="networkidle")
    pg.wait_for_timeout(300)
    out = pg.evaluate(LINKS_JS)
    ctx.close()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9901)
    a = ap.parse_args()
    fails, checks = [], 0
    with sync_playwright() as p:
        b = p.chromium.launch()
        for i, source in enumerate(["", URL]):
            proc, base = start_mock(a.port + i, source)
            try:
                for vp in VIEWPORTS:
                    for name, path in PAGES.items():
                        got = links(b, base, vp, path)
                        checks += 1
                        repo = [g for g in got if g == REPO]
                        if len(repo) != TYPED[name]:
                            fails.append(f"[{vp}] {name}: want {TYPED[name]} typed link(s) to the public repository {REPO}, got {got}")
                        got = [g for g in got if g != REPO]
                        if not source and got:
                            fails.append(f"[{vp}] {name} with the setting empty links to a repository: {got}")
                        if source:
                            want = {"href": URL, "rel": "noopener noreferrer", "text": "Self-host it", "target": ""}
                            if got != [want]:
                                fails.append(f"[{vp}] {name} with MOCK_SOURCE_URL={URL}: want exactly one {want}, got {got}")
            finally:
                proc.terminate()
                proc.wait(timeout=10)
        b.close()
    for f in fails:
        print("FAIL", f)
    print(f"source link: {checks} page checks, {len(fails)} failed")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()

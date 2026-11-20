#!/usr/bin/env python3
"""Render docs/img/*.svg to PNG at 2x in headless Chromium, with the Inter font.

    python3 docs/architecture/png.py [--font <inter.woff2>] [--measure]

The SVGs name Inter with fallbacks and embed no font. For the PNGs this script loads Inter (SIL Open Font License 1.1)
from --font, or fetches it once from Google Fonts into a temporary folder outside the repository (no font is kept in
the repository). Each PNG carries a tEXt chunk with the sha256 of the SVG it was drawn from; render.mjs --check fails
when a PNG is not the 2x render of the current SVG.

It also checks the layout check's assumption: every text the browser draws is no wider than the width render.mjs
estimated for it (so no label the estimate kept clear can overlap in the real render). --measure prints Inter's advance
widths for the table in render.mjs.
Needs Python 3 with playwright (and its Chromium), as web/test/*.py do.
"""
import argparse, base64, hashlib, json, os, pathlib, struct, subprocess, sys, tempfile, urllib.request, zlib

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
SVGS = ["architecture-light", "architecture-dark", "join-sequence-light", "join-sequence-dark"]
KEY = "botlink-svg-sha256"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


def fetch_inter() -> pathlib.Path:
    d = pathlib.Path(tempfile.gettempdir()) / "botlink-diagram-fonts"
    f = d / "inter-latin.woff2"
    if f.exists():
        return f
    d.mkdir(parents=True, exist_ok=True)
    css = urllib.request.urlopen(urllib.request.Request("https://fonts.googleapis.com/css2?family=Inter:wght@400..700&display=swap", headers={"User-Agent": UA}), timeout=30).read().decode()
    block = [b for b in css.split("/* ") if b.startswith("latin */")][0]
    url = block.split("url(")[1].split(")")[0]
    f.write_bytes(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30).read())
    return f


def with_text(png: bytes, key: str, value: str) -> bytes:
    """The PNG with one tEXt chunk (key, value) right after IHDR; an older chunk with that key is dropped."""
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    out, o = [png[:8]], 8
    while o < len(png):
        n = struct.unpack(">I", png[o:o + 4])[0]
        typ, chunk = png[o + 4:o + 8], png[o:o + 12 + n]
        o += 12 + n
        if typ == b"tEXt" and png[o - 4 - n:o - 4].split(b"\0")[0] == key.encode():
            continue
        out.append(chunk)
        if typ == b"IHDR":
            data = key.encode("latin-1") + b"\0" + value.encode("latin-1")
            out.append(struct.pack(">I", len(data)) + b"tEXt" + data + struct.pack(">I", zlib.crc32(b"tEXt" + data) & 0xFFFFFFFF))
    return b"".join(out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--font")
    ap.add_argument("--measure", action="store_true")
    a = ap.parse_args()
    font = pathlib.Path(a.font) if a.font else fetch_inter()
    face = base64.b64encode(font.read_bytes()).decode()
    css = f"@font-face{{font-family:Inter;src:url(data:font/woff2;base64,{face}) format('woff2');font-weight:100 900}}html,body{{margin:0;padding:0}}"
    est = json.loads(subprocess.run(["node", str(ROOT / "docs/architecture/render.mjs"), "--boxes"], check=True, capture_output=True, text=True).stdout)
    problems = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        if a.measure:
            pg = b.new_page()
            pg.set_content(f"<style>{css}</style><canvas id=c></canvas>")
            pg.evaluate("document.fonts.load('400 100px Inter')")
            chars = "0123456789 !\"#$%&'()*+,-./:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~·…→—–’“”§"
            print(json.dumps(pg.evaluate("""(chars)=>{const c=document.getElementById('c').getContext('2d');const r={};
              for(const w of [400,600,700]){c.font=w+' 1000px Inter';r[w]=[...chars].map(ch=>Math.round(c.measureText(ch).width)).join(',')}return r}""", chars)))
        for name in SVGS:
            svgp = ROOT / "docs/img" / f"{name}.svg"
            svg = svgp.read_bytes()
            text = svg.decode()
            w = int(text.split('width="')[1].split('"')[0])
            h = int(text.split('height="')[1].split('"')[0])
            pg = b.new_page(viewport={"width": w, "height": h}, device_scale_factor=2)
            pg.set_content(f"<!doctype html><html><head><style>{css}</style></head><body>{text}</body></html>")
            pg.evaluate("Promise.all([document.fonts.load('400 16px Inter'), document.fonts.load('700 16px Inter'), document.fonts.load('600 16px Inter')]).then(() => document.fonts.ready)")
            if not pg.evaluate("document.fonts.check('700 16px Inter')"):
                problems.append(f"{name}: Inter did not load")
            real = pg.evaluate("[...document.querySelectorAll('svg text')].map(t => ({s: t.textContent, w: t.getComputedTextLength()}))")
            mine = est[f"docs/img/{name}.svg"]
            if len(real) != len(mine):
                problems.append(f"{name}: the browser drew {len(real)} texts, render.mjs laid out {len(mine)}")
            for r, m in zip(real, mine):
                if r["s"] != m["s"]:
                    problems.append(f"{name}: text order differs ({r['s']!r} vs {m['s']!r})")
                    break
                if r["w"] > m["w"] + 0.5:
                    problems.append(f"{name}: \"{r['s']}\" is {r['w']:.1f} px wide in the browser; render.mjs estimated {m['w']:.1f} px (raise the margin in textWidth)")
            shot = pg.locator("svg").screenshot(type="png", omit_background=False)
            pg.close()
            out = with_text(shot, KEY, hashlib.sha256(svg).hexdigest())
            (ROOT / "docs/img" / f"{name}.png").write_bytes(out)
            print(f"docs/img/{name}.png {len(out)} bytes ({2 * w}x{2 * h})")
        b.close()
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

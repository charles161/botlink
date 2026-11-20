"""Records a web e2e run for the cosmetic deploy gate (evals/gate.sh --cosmetic).

Writes evals/results/web-<sha>.json with {"sha", "<suite>": {"pass", "clean", "at", "base", "runs"}} where suite is
"mock" (test_e2e.py) or "real" (test_real_server.py). "clean" is true only when the worktree had no uncommitted
changes outside evals/results|runs|RESULTS.md and web/shots, so the result describes exactly the commit <sha>.
"""
import json, pathlib, subprocess, time

ROOT = pathlib.Path(__file__).resolve().parents[2]
EXCL = [":(exclude)evals/results", ":(exclude)evals/runs", ":(exclude)evals/RESULTS.md", ":(exclude)web/shots", ":(exclude)web/test/__pycache__"]


def git(*a):
    return subprocess.run(["git", "-C", str(ROOT), *a], capture_output=True, text=True).stdout.strip()


def record(suite, passed, base, runs):
    sha = git("rev-parse", "HEAD")
    if not sha:
        return
    clean = git("status", "--porcelain", "--", ".", *EXCL) == ""
    out = ROOT / "evals" / "results" / f"web-{sha}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        data = json.loads(out.read_text())
    except Exception:
        data = {"sha": sha}
    data[suite] = {"pass": bool(passed), "clean": clean, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "base": base, "runs": runs}
    out.write_text(json.dumps(data, indent=2) + "\n")
    print(f"web result ({suite}, {'PASS' if passed else 'FAIL'}, clean={clean}) -> {out}")

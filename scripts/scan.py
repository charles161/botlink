#!/usr/bin/env python3
"""Secret and internal-material scan of a tree that is (or will be) public.   python3 -I scan.py <dir>

Fails (exit 1) on any finding not on the reviewed allow-list (scan-allow.txt next to this file), one line each:
  <path>:<line>: <rule>: <the match, shortened>
Rules:
  secret:*   private keys, GitHub / AWS / Slack / Telegram / Stripe-like / PostHog-like / OpenAI-like / Google tokens,
             JWTs, password= / secret= / token= assignments with real-looking values, database URLs with a password
  file:*     files that hold secrets by their name: .env (but not .env.example), *.pem, *.key, auth.json, ...
  email      an address on a domain that is not an example, test or public bot-link address
  internal:* a home-directory path of a person's machine, a chat-message id ("TG" and a number), and the names in
             scan-names.txt: those are stored only as SHA-256 hashes (with first letter and length, to keep the
             scan fast), so this public file does not list the private names it looks for
Binary files are skipped except for their path. Paths (file names) are checked for names too.
"""
import hashlib
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SKIP_DIRS = {".git", "node_modules", "dist", "test-results", "playwright-report", "__pycache__"}

SECRETS = [
    ("secret:private-key", re.compile(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----")),
    ("secret:github-token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}")),
    ("secret:aws-access-key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("secret:aws-secret-key", re.compile(r"(?i)aws_secret_access_key\s*[=:]\s*['\"]?[A-Za-z0-9/+=]{40}")),
    ("secret:slack-token", re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}|hooks\.slack\.com/services/T[A-Z0-9]+/[A-Z0-9]+/[A-Za-z0-9]+")),
    ("secret:telegram-bot-token", re.compile(r"\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b")),
    ("secret:stripe-like-key", re.compile(r"\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}")),
    ("secret:webhook-signing-secret", re.compile(r"\bwhsec_[A-Za-z0-9+/=]{20,}")),
    ("secret:posthog-like-key", re.compile(r"\bph[cx]_[A-Za-z0-9]{30,}")),
    ("secret:openai-like-key", re.compile(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}")),
    ("secret:google-api-key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}")),
    ("secret:jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")),
    ("secret:db-url-password", re.compile(r"\bpostgres(?:ql)?://[^:/@\s'\"]+:([^@\s'\"]+)@")),
    ("secret:assignment", re.compile(r"(?i)\b(?:password|passwd|pwd|secret|client_secret|api_?key|access_?token|auth_?token|token)\b['\"]?\s*[=:]\s*['\"]?([A-Za-z0-9+/_\-]{16,})")),
]
PLACEHOLDER = re.compile(r"(?i)example|changeme|change-me|placeholder|dummy|fake|test|xxxx|your|redacted|secret|password|sample|0123456789|abcdef")
BAD_FILE = re.compile(r"(?:^|/)(?:\.env(?:\.(?!example$)[^/]+)?|[^/]+\.(?:pem|key|p12|pfx|kdbx|ppk)|id_(?:rsa|dsa|ecdsa|ed25519)|auth\.json|credentials\.json|\.dbpw|\.netrc|\.pgpass|\.npmrc)$")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b")
EMAIL_OK = re.compile(r"(?i)^(?:(?:[a-z0-9-]+\.)*example\.(?:com|org|net)|[a-z0-9.-]*\.(?:example|test|invalid|localhost)|(?:[a-z0-9-]+\.)?botlink\.dev|users\.noreply\.github\.com|localhost)$")
INTERNAL = [
    ("internal:home-path", re.compile(r"/home/(?!runner/|user/|you/|me/|<)[a-z_][a-z0-9_-]{1,31}/|/Users/(?!<)[A-Za-z][A-Za-z0-9_-]{1,31}/")),
    ("internal:chat-message-id", re.compile(r"\bTG \d{3,}\b")),
]
WORD = re.compile(r"(?<![a-z0-9])[a-z0-9]")  # a name starts and ends at a letter or digit edge (_ . - / are edges)


def entropy(s):
    n = len(s)
    return -sum(c / n * math.log2(c / n) for c in (s.count(ch) for ch in set(s)))


def real_looking(v):
    return (re.search(r"[A-Za-z]", v) and re.search(r"\d", v) and not PLACEHOLDER.search(v)
            and entropy(v) > 3.5)


def load_names(path):
    by_first = {}
    if not os.path.exists(path):
        return by_first
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        c, n, h = line.split()
        by_first.setdefault(c, {}).setdefault(int(n), set()).add(h)
    return by_first


def name_hits(text, names):
    """Positions where a hashed name starts at a word start and ends at a word end (text is lower-cased)."""
    out = []
    if not names:
        return out
    for m in WORD.finditer(text):
        i = m.start()
        lens = names.get(text[i])
        if not lens:
            continue
        for n, hashes in lens.items():
            j = i + n
            if j > len(text) or (j < len(text) and text[j].isascii() and text[j].isalnum()):
                continue
            if hashlib.sha256(text[i:j].encode()).hexdigest() in hashes:
                out.append((i, j))
    return out


def load_allow(path):
    """Lines: <rule> <path, folder/ or *> <exact match text, or @line>   # why (reviewed). email-domain takes a domain."""
    allow = []
    if not os.path.exists(path):
        return allow
    for line in open(path, encoding="utf-8"):
        line = line.split("#", 1)[0].strip()
        if line:
            rule, p, text = line.split(None, 2)
            allow.append((rule, p, text))
    return allow


def allowed(allow, rule, path, text, line=None):
    """text "@<n>" allows line n of that one file (for files whose bytes may never change, like shipped migrations)."""
    for r, p, t in allow:
        if r == rule and (path == p or (p.endswith("/") and path.startswith(p)) or p == "*") and (t == text or (line is not None and t == f"@{line}")):
            return True
    return False


def scan(root, names, allow, skip_bytes=()):
    """skip_bytes: contents of files that only quote what they allow (the allow-list itself)."""
    findings = []

    def add(rel, line, rule, text):
        if not allowed(allow, rule, rel, text, line):
            findings.append(f"{rel}:{line}: {rule}: {text[:80]}")

    for d, dirs, files in os.walk(root):
        dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS)
        for f in sorted(files):
            p = os.path.join(d, f)
            rel = os.path.relpath(p, root).replace(os.sep, "/")
            if BAD_FILE.search(rel):
                add(rel, 0, "file:" + f, rel)
            for i, j in name_hits(rel.lower(), names):
                add(rel, 0, "internal:name-in-path", rel)
            if os.path.islink(p) or not os.path.isfile(p):
                continue
            with open(p, "rb") as fh:
                b = fh.read()
            if b"\0" in b[:8192] or b in skip_bytes:
                continue
            text = b.decode("utf-8", "replace")
            low = text.lower()
            starts = [0] + [m.end() for m in re.finditer("\n", text)]

            def line_of(pos):
                lo, hi = 0, len(starts) - 1
                while lo < hi:
                    mid = (lo + hi + 1) // 2
                    if starts[mid] <= pos:
                        lo = mid
                    else:
                        hi = mid - 1
                return lo + 1

            for rule, rx in SECRETS:
                for m in rx.finditer(text):
                    if rule in ("secret:assignment", "secret:db-url-password") and not real_looking(m.group(1)):
                        continue
                    add(rel, line_of(m.start()), rule, m.group(0))
            for m in EMAIL.finditer(text):
                dom = m.group(1).lower()
                if not EMAIL_OK.match(dom) and not re.search(r"\.(?:png|svg|webp|jpg|woff2?)$", dom) and not allowed(allow, "email-domain", rel, dom):
                    add(rel, line_of(m.start()), "email", m.group(0))
            for rule, rx in INTERNAL:
                for m in rx.finditer(text):
                    add(rel, line_of(m.start()), rule, m.group(0))
            for i, j in name_hits(low, names):
                add(rel, line_of(i), "internal:name", text[max(0, i - 20):j + 20].replace("\n", " "))
    return findings


def hash_names(plain):
    """scan-names.txt lines from a plaintext list (one name per line, # comments): '<first letter> <length> <sha256>'."""
    out = ["# written by: python3 -I scan.py --hash-names <the private list>; one hashed name per line"]
    for line in open(plain, encoding="utf-8"):
        n = line.split("#", 1)[0].strip().lower()
        if n:
            out.append(f"{n[0]} {len(n)} {hashlib.sha256(n.encode()).hexdigest()}")
    return "\n".join(out) + "\n"


def main(argv):
    if len(argv) == 2 and argv[1] == "--clean-lines":
        # stdin lines that spell no internal name (for generated files that go into the public tree)
        names = load_names(os.path.join(HERE, "scan-names.txt"))
        for line in sys.stdin:
            if not name_hits(line.lower(), names) and not any(rx.search(line) for _, rx in INTERNAL):
                sys.stdout.write(line)
        return 0
    if len(argv) == 3 and argv[1] == "--hash-names":
        sys.stdout.write(hash_names(argv[2]))
        return 0
    if len(argv) != 2 or not os.path.isdir(argv[1]):
        print(__doc__, file=sys.stderr)
        return 2
    names = load_names(os.path.join(HERE, "scan-names.txt"))
    if not names:
        print("scan-names.txt is missing or empty next to scan.py: the internal-name check would pass anything", file=sys.stderr)
        return 2
    allow_file = os.path.join(HERE, "scan-allow.txt")
    own = (open(allow_file, "rb").read(),) if os.path.exists(allow_file) else ()
    findings = scan(argv[1], names, load_allow(allow_file), own)
    for f in findings:
        print(f)
    print(f"scan.py: {len(findings)} finding(s)" + (" (review above; allow only after reading, in scan-allow.txt)" if findings else ""))
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

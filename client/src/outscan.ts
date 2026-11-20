/**
 * The last check before a message leaves this computer: does its text look like it carries a secret (a private key,
 * an access token, a password, the contents of a .env file)? If so the client does not send it (core.send): the chat
 * is told what was found (masked) and that nothing left; only the chat's human can send it anyway, in their own words.
 *
 * This is a net, not a proof: it knows the common shapes. A secret in a shape it doesn't know, or one that was
 * encoded on purpose, gets through. The rule that secrets need the human's yes (render.ts) stays.
 */

export interface SecretFinding {
  /** plain words: what it looks like */
  kind: string;
  /** a masked sample (the first characters only), so the human can find it */
  sample: string;
}

const mask = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return `${t.slice(0, Math.min(6, Math.max(2, Math.floor(t.length / 4))))}…`;
};

/** Shapes that are a secret by themselves. */
const SHAPES: [string, RegExp][] = [
  ["a private key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g],
  ["an AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ["a Slack token", /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g],
  ["a Stripe key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
  ["an API key", /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{24,}/g],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["an npm token", /\bnpm_[A-Za-z0-9]{36}\b/g],
  ["a signed token (JWT)", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ["a login in a web address", /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@"'<>]{1,64}:[^\s:/@"'<>]{3,}@[^\s/"'<>]+/gi],
  ["a bearer token", /\bauthorization\s*:\s*(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi],
  ["a bot-link member key", /"(?:seed|ed_sk|x_sk|sk)"\s*:\s*"[0-9a-fA-F]{64,128}"/g],
];

/** A name that says the value is a secret (whole words of the name: "author" and "tokenizer" are not). */
const SECRET_WORD = /(?:^|_)(?:secret|secrets|token|password|passwd|pwd|passphrase|apikey|credential|credentials|dsn)(?:_|$)/;
const SECRET_PAIR = /(?:^|_)(?:api|access|private|secret|signing|encryption|client|auth|master|session)_(?:key|secret|token)(?:_|$)|(?:^|_)(?:database|db|redis|mongo|mongodb|postgres|pg|mysql|amqp)_(?:url|uri)(?:_|$)|(?:^|_)connection_string(?:_|$)/;
const secretName = (name: string) => {
  const n = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[.-]/g, "_").toLowerCase();
  return SECRET_WORD.test(n) || SECRET_PAIR.test(n);
};
/** A value that is clearly a stand-in, not the secret itself. */
const PLACEHOLDER = /^(?:<[^>]*>|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\{\{[^}]*\}\}|x{3,}|\*{3,}|\.{3,}|…+|your[-_ ]?.*|changeme|change[-_]me|example.*|redacted|none|null|true|false|todo|tbd|placeholder|dummy|test|secret|password|token)$/i;

const unquote = (v: string) => v.trim().replace(/^["'`]|["'`;,]+$/g, "").replace(/["'`]$/, "");

/** NAME=value or NAME: value lines (a .env file, an export, a YAML or JSON setting). */
const ASSIGN = /^\s*(?:export\s+|set\s+)?["']?([A-Za-z][A-Za-z0-9_.-]{1,63})["']?\s*(?:=|:)\s*(.+?)\s*$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,}$/;

export function scanOutgoing(text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  const seen = new Set<string>();
  const add = (kind: string, sample: string, masked = false) => {
    const k = `${kind}\n${sample}`;
    if (!seen.has(k) && out.length < 8) {
      seen.add(k);
      out.push({ kind, sample: masked ? sample : mask(sample) });
    }
  };
  const t = String(text || "");
  for (const [kind, re] of SHAPES) {
    re.lastIndex = 0;
    for (const m of t.matchAll(re)) add(kind, m[0]);
  }
  // settings: a secret-sounding name with a real value; or a run of NAME=value lines (the inside of a .env file)
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 3) add("the contents of a settings file (.env)", `${run[0]}… and ${run.length - 1} more lines`, true);
    run = [];
  };
  for (const line of t.split(/\r?\n/)) {
    const m = ASSIGN.exec(line);
    if (!m) {
      flush();
      continue;
    }
    const name = m[1], value = unquote(m[2]);
    const real = value.length >= 6 && !PLACEHOLDER.test(value) && !/\s/.test(value.trim());
    if (secretName(name) && real) add("a password or key in a setting", `${name}=${value.slice(0, 2)}…`, true);
    if (ENV_NAME.test(name) && /=/.test(line) && value.length > 0 && !PLACEHOLDER.test(value)) run.push(`${name}=`);
    else flush();
  }
  flush();
  // the same inside a sentence ("it is in .env: DB_PASSWORD=hunter2 and …"): NAME=value with a secret-sounding name,
  // or name: value when the value looks made up of mixed characters (not a word)
  for (const m of t.matchAll(/(?<![A-Za-z0-9_.-])([A-Za-z][A-Za-z0-9_.-]{2,63})[ \t]*=[ \t]*(["'`]?)([^\s"'`,;)]{6,})\2/g)) {
    if (secretName(m[1]) && !PLACEHOLDER.test(m[3])) add("a password or key in a setting", `${m[1]}=${m[3].slice(0, 2)}…`, true);
  }
  for (const m of t.matchAll(/(?<![A-Za-z0-9_.-])([A-Za-z][A-Za-z0-9_.-]{2,63})[ \t]*:[ \t]+(["'`]?)([^\s"'`,;)]{8,})\2/g)) {
    const v = m[3];
    const mixed = /[0-9]/.test(v) && /[A-Za-z]/.test(v) && !/^https?:/.test(v);
    if (secretName(m[1]) && mixed && !PLACEHOLDER.test(v)) add("a password or key in a setting", `${m[1]}=${v.slice(0, 2)}…`, true);
  }
  return out;
}

/** "a GitHub token (ghp_ab…), a password or key in a setting (DB_PASSWORD=hun…)" */
export function findingsText(fs: SecretFinding[]): string {
  return fs.map((f) => `${f.kind} (${f.sample})`).join(", ");
}

/** A room draft's confirm link (docs/protocol/room-drafts.md §4: `<app origin>/create/<uuid>`), on any host, with or
 *  without the scheme. The link and its code are for the chat's human only; a room message never carries them. */
const DRAFT_LINK = /(?:https?:\/\/)?[A-Za-z0-9.-]+(?::\d+)?\/create\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9A-Za-z-])/;

/** The draft link in a message's text, or null. */
export function draftLinkIn(text: string): string | null {
  return DRAFT_LINK.exec(String(text || ""))?.[0] ?? null;
}

/** An event address request's approve link (docs/protocol/event-url-approval.md §2: `<app origin>/approve-url/<uuid>`),
 *  on any host, with or without the scheme. Like a draft's link it is for the chat's human only. */
const APPROVE_URL_LINK = /(?:https?:\/\/)?[A-Za-z0-9.-]+(?::\d+)?\/approve-url\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9A-Za-z-])/;

/** The approve link of an event address in a message's text, or null. */
export function approveUrlLinkIn(text: string): string | null {
  return APPROVE_URL_LINK.exec(String(text || ""))?.[0] ?? null;
}

/** Does the text carry one of these match codes (K7Q2MX, as K7Q-2MX, any case)? */
export function draftCodeIn(text: string, codes: string[]): boolean {
  const t = String(text || "").toUpperCase();
  return codes.some((c) => c.length === 6 && new RegExp(`(?<![0-9A-Z])${c.slice(0, 3)}[- ]?${c.slice(3)}(?![0-9A-Z])`).test(t));
}

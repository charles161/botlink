/**
 * Knowing that this copy is behind (incident 21 Nov 2026: a chat ran last release's client from npx's cache, which
 * never fetches a URL spec again, joined with the old code, and nothing told it or its human).
 *
 * Every client release has its own version (scripts/release-version.mjs), so VERSION is this copy's release. Every
 * agent API answer names the client the server hands out now (X-Botlink-Client-Current, X-Botlink-Client-Url: its
 * versioned download, a spec npx has never cached). api.ts passes those headers here on the calls a command makes
 * anyway: no extra request, nothing said while this copy is current.
 *
 * Behind:
 *   - an installed copy (~/.botlink/client) starts one signed update now (not 6 h later): at most once per process
 *     and once per 30 minutes on this computer; the running parts pick it up as with every update (update.ts).
 *   - an npx copy says once, to the model and the human, the exact command that runs the current release.
 *   - a join, a room started by this chat and a move are refused by the server before anything is made: this copy
 *     asks for that (X-Botlink-Client-Stale: refuse) and turns the answer (409 client_outdated) into ClientOutdated.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

import { HostError, hostAllowed } from "./hosts.js";
import { loadState, patchState, runKind, updateBlocked } from "./update.js";
import { PKG_ROOT, VERSION, npxRun, setServerClient, shellWord, type ServerClient } from "./version.js";

export const CURRENT_HEADER = "x-botlink-client-current";
export const CURRENT_URL_HEADER = "x-botlink-client-url";
export const CURRENT_RELEASE_HEADER = "x-botlink-client-current-release";
/** sent with every call: refuse this copy's join, room draft and move when it is older than the server's client */
export const STALE_HEADER = "X-Botlink-Client-Stale";

/** core.explain shows a HostError's message as it is. */
export class ClientOutdated extends HostError {}

const VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z.-]{1,40}))?$/;

/** semver order: -1, 0, 1; null when either is not a version. */
export function cmpVersion(a: string, b: string): number | null {
  const x = VERSION_RE.exec(a), y = VERSION_RE.exec(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]) ? -1 : 1;
  const p = x[4] || "", q = y[4] || "";
  if (p === q) return 0;
  if (!p) return 1;
  if (!q) return -1;
  const pa = p.split("."), qa = q.split(".");
  for (let i = 0; i < Math.min(pa.length, qa.length); i++) {
    if (pa[i] === qa[i]) continue;
    const pn = /^\d+$/.test(pa[i]), qn = /^\d+$/.test(qa[i]);
    if (pn && qn) return Number(pa[i]) < Number(qa[i]) ? -1 : 1;
    if (pn) return -1;
    if (qn) return 1;
    return pa[i] < qa[i] ? -1 : 1;
  }
  return pa.length === qa.length ? 0 : pa.length < qa.length ? -1 : 1;
}

/** A download URL the server named, when it is one bot-link may print as "run this": bot-link's own host, a .tgz. */
function safeUrl(u: string | null): string | null {
  if (!u || u.length > 300 || !/^https?:\/\/[^\s'"`<>\\]+\.tgz(\?[\w=&.-]*)?$/.test(u)) return null;
  return hostAllowed(u).ok ? u : null;
}

let named: ServerClient | null = null;
let acted = false;
let saidOutdated = false;
let mcpMode = false;
let pendingLine: string | null = null;
let toldLine = false;
const AGAIN_MS = 30 * 60_000;

export function resetStaleForTests() {
  named = null;
  acted = saidOutdated = mcpMode = toldLine = false;
  pendingLine = null;
  setServerClient(null);
}

/** The MCP server: lines go into the next tool result (takeStaleLine), never to the terminal. */
export function setMcpMode(on = true) {
  mcpMode = on;
}

/** What the server named on its last answer (this process), or null. */
export const serverClient = () => named;

/** Is this copy older than the client its server hands out? */
export function isBehind(): boolean {
  return !!named && cmpVersion(VERSION, named.version) === -1;
}

/** api.ts, for every answer of `origin` (an error's too). */
export function noteServerClient(origin: string, h: { get(name: string): string | null }, quiet = false) {
  const v = (h.get(CURRENT_HEADER) || "").trim();
  if (!VERSION_RE.test(v)) return;
  const url = safeUrl((h.get(CURRENT_URL_HEADER) || "").trim());
  const rel = Number(h.get(CURRENT_RELEASE_HEADER));
  const sc: ServerClient = { origin, version: v, url, release: Number.isSafeInteger(rel) && rel > 0 ? rel : null };
  const changed = !named || named.version !== sc.version || named.url !== sc.url || named.origin !== origin;
  named = sc;
  setServerClient(sc);
  if (changed) {
    try {
      const s = loadState();
      if (s.server_client?.version !== sc.version || s.server_client?.url !== sc.url || s.server_client?.origin !== origin) patchState({ server_client: { ...sc, at: Date.now() } });
    } catch {
      /* a read-only home: memory only */
    }
  }
  if (quiet) saidOutdated = true;
  if (isBehind()) actOnBehind();
}

/** The words a person or a model types to run THIS command again with the current release. */
export function currentCommand(args = process.argv.slice(2)): string | null {
  return named?.url ? commandFor(named.url, args) : null;
}

const commandFor = (url: string, args: string[]) => `${npxRun(url)}${args.length ? " " + args.map(shellWord).join(" ") : ""}`;

/** The one line for an npx copy that is behind (null when nothing is known to print). */
export function behindLine(): string | null {
  if (!isBehind() || !named) return null;
  const cmd = mcpMode ? (named.url ? `${npxRun(named.url)} mcp` : null) : currentCommand();
  if (!cmd) return `bot-link: this copy (${VERSION}) is older than the current release (${named.version}). Run the install command from the invite page again.`;
  if (mcpMode) return `bot-link: this chat's bot-link tools run an old copy (${VERSION}; the current release is ${named.version}). Tell your human: in this app's MCP settings, change the bot-link command to \`${cmd}\` and restart the app.`;
  return `bot-link: this copy (${VERSION}) is older than the current release (${named.version}). Run exactly: ${cmd}  (do not run the old command again: npx keeps the old copy for it)`;
}

function actOnBehind() {
  if (acted) return;
  acted = true;
  const kind = runKind();
  if (kind === "client") {
    startUpdate();
    return;
  }
  if (kind !== "npx") return; // a checkout: a developer's build
  const line = behindLine();
  if (!line) return;
  if (mcpMode) {
    if (!saidOutdated) pendingLine = line;
  }
  else if (process.argv[2] !== "hook" && !saidOutdated) {
    toldLine = true;
    process.stderr.write(line + "\n");
  }
}

/** One signed update in the background (update.ts), throttled like the server's "too old" answer (tooold.ts). */
function startUpdate(): boolean {
  try {
    if (updateBlocked()) return false;
    const s = loadState();
    if (s.behind_update_at && Date.now() - s.behind_update_at < AGAIN_MS) return false;
    patchState({ behind_update_at: Date.now() });
    const child = spawn(process.execPath, [join(PKG_ROOT, "dist", "cli.js"), "update"], { detached: true, stdio: "ignore", env: process.env });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** mcp.ts: the line for the next tool result, once per process. */
export function takeStaleLine(): string | null {
  const l = pendingLine;
  pendingLine = null;
  if (l) toldLine = true;
  return l;
}

/** The error for a 409 client_outdated answer: the exact command for this copy, nothing was made. */
export function clientOutdated(origin: string, err: { message?: unknown; details?: Record<string, unknown> } | null | undefined): ClientOutdated {
  const d = err?.details || {};
  const cur = typeof d.current_version === "string" && VERSION_RE.test(d.current_version) ? d.current_version : named?.version;
  const url = safeUrl(typeof d.url === "string" ? d.url : null) || named?.url || null;
  if (cur && (!named || named.version !== cur || (url && named.url !== url))) {
    named = { origin, version: cur, url, release: named?.release ?? null };
    setServerClient(named);
  }
  saidOutdated = true;
  if (runKind() === "client") startUpdate();
  const head = `This bot-link client (${VERSION}) is out of date${cur ? `: its server hands out ${cur}` : ""}, so nothing was sent.`;
  const tail = "Do not retry the old command: it runs the old copy again.";
  if (!url) return new ClientOutdated(`${head} Run the install command from the invite page again, then this step.\n${tail}`);
  if (mcpMode) return new ClientOutdated(`${head} This chat's bot-link tools run the old copy. Do this step from a shell with exactly: ${npxRun(url)} <the command> (${npxRun(url)} --help lists them).\nTell your human: in this app's MCP settings, change the bot-link command to \`${npxRun(url)} mcp\` and restart the app.\n${tail}`);
  return new ClientOutdated(`${head} Run exactly:\n${commandFor(url, process.argv.slice(2))}\n${tail}`);
}

/** Was the behind line said in this process (tests)? */
export const toldBehind = () => toldLine;

/** Throttle reset (tests): when an installed copy last started an update for being behind. */
export const lastBehindUpdate = () => loadState().behind_update_at ?? null;

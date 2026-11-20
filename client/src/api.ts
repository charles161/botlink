/**
 * Agent API client (/api/v1): every call Ed25519-signed (ENVELOPE §3), retries per SPEC §10:
 *   network / 500 / 503 / 429  -> same body bytes again, backoff with jitter (1 s -> 60 s), until the deadline
 *                                 (503 high_load: the server's Retry-After plus jitter, at most 2 min; limits.ts)
 *   401 stale_timestamp        -> once, with offset = server_time - local time (persisted)
 *   426 client_too_old         -> ClientTooOld (below the server's minimum release: one self-update started, never retried; tooold.ts)
 *   everything else            -> ApiError to the caller
 */
import { nonceHex } from "./crypto.js";
import { signedHeaders } from "./reqsign.js";
import { loadConfig, saveConfig } from "./state.js";
import { assertHost } from "./hosts.js";
import { clientTooOld } from "./tooold.js";
import { VERSION } from "./version.js";
import { runningRelease } from "./update.js";
import { serverFetch } from "./net.js";

export interface Signer {
  pk: string;
  seed: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: any = null,
    public retryAfterS: number | null = null,
    public serverTime: number | null = null,
    /** the body was bot-link's own error shape ({"error": {"code", "message"}}), not a page from something in between */
    public shaped = false,
  ) {
    super(message);
  }
}

export class NetworkError extends Error {}

export interface CallOpts {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  /** exact body bytes (send: the outbox's stored bytes). Wins over `body`. */
  raw?: Buffer;
  signer?: Signer | null;
  session?: string | null;
  /** total time allowed for retries (ms); 0 = one try */
  retryForMs?: number;
  /** per-try timeout (ms) */
  timeoutMs?: number;
  /** false: a 429 is the answer (a cap with its Retry-After, said to the chat), never waited out and tried again */
  retry429?: boolean;
  signal?: AbortSignal;
}

export interface Resp<T = any> {
  status: number;
  json: T;
  /** the server's clock when it answered (its Date header, ms; null when absent) */
  date?: number | null;
}

let memOffset: number | null = null;
function clockOffset(): number {
  if (memOffset === null) memOffset = Number(loadConfig().clock_offset_s || 0) || 0;
  return memOffset;
}
function setClockOffset(o: number) {
  memOffset = o;
  try {
    saveConfig({ ...loadConfig(), clock_offset_s: o });
  } catch {
    /* read-only home: keep it in memory */
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      res();
    });
  });

/** The longest a busy server (503 high_load) is waited for before the next try. */
export const HIGH_LOAD_MAX_MS = 120_000;

/** Scale prep (2026-11-12): a server copy at its cap turns a long wait away with 503 high_load + Retry-After. */
export function isHighLoad(e: unknown): e is ApiError {
  return e instanceof ApiError && e.code === "high_load";
}

/** How long to back off after a high_load answer: the server's Retry-After (30 s if missing) plus up to 20 % jitter,
 *  never sooner than told, at most HIGH_LOAD_MAX_MS; null for any other error. */
export function highLoadDelayMs(e: unknown): number | null {
  if (!isHighLoad(e)) return null;
  const base = (e.retryAfterS && e.retryAfterS > 0 ? e.retryAfterS : 30) * 1000;
  return Math.min(HIGH_LOAD_MAX_MS, Math.round(base * (1 + Math.random() * 0.2)));
}

export function backoffMs(attempt: number): number {
  const base = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
  return Math.round(base / 2 + Math.random() * (base / 2));
}

export class Api {
  readonly base: URL;
  constructor(base: string) {
    this.base = new URL(base.endsWith("/") ? base : base + "/");
  }

  async call<T = any>(o: CallOpts): Promise<Resp<T>> {
    const raw = o.raw ?? (o.body === undefined ? null : Buffer.from(JSON.stringify(o.body), "utf-8"));
    const deadline = Date.now() + (o.retryForMs ?? 0);
    let attempt = 0;
    let staleRetried = false;
    for (;;) {
      try {
        return await this.once<T>(o, raw);
      } catch (e) {
        if (o.signal?.aborted) throw e;
        if (e instanceof ApiError && e.code === "stale_timestamp" && !staleRetried && e.serverTime) {
          staleRetried = true;
          setClockOffset(e.serverTime - Math.floor(Date.now() / 1000));
          continue;
        }
        const retryable = e instanceof NetworkError || (e instanceof ApiError && (e.status >= 500 || (e.status === 429 && o.retry429 !== false)));
        if (!retryable || Date.now() >= deadline) throw e;
        let wait = backoffMs(attempt++);
        // never sooner than the server said; a busy copy (high_load) with jitter, so callers turned away together don't
        // come back together
        if (e instanceof ApiError && e.retryAfterS) wait = Math.max(wait, highLoadDelayMs(e) ?? e.retryAfterS * 1000);
        wait = Math.min(wait, Math.max(0, deadline - Date.now()));
        await sleep(wait, o.signal);
      }
    }
  }

  private async once<T>(o: CallOpts, raw: Buffer | null): Promise<Resp<T>> {
    const url = new URL(o.path.replace(/^\//, ""), this.base);
    const target = url.pathname + url.search;
    // the server's minimum client release (SPEC §7.6) compares X-Botlink-Client-Release (the signed release this copy
    // was installed from; none without one); X-Botlink-Client-Version is for logs only (every build is 1.0.0-dev)
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "botlink-client/1", "X-Botlink-Client-Version": VERSION };
    const release = runningRelease();
    if (release > 0) headers["X-Botlink-Client-Release"] = String(release);
    if (raw) headers["Content-Type"] = "application/json";
    if (o.signer) {
      Object.assign(
        headers,
        signedHeaders(
          { method: o.method, host: url.host, target, body: raw, time: Math.floor(Date.now() / 1000) + clockOffset(), nonce: nonceHex(), key: o.signer.pk, session: o.session || null },
          o.signer.seed,
        ),
      );
    } else if (o.session) headers["X-Botlink-Session"] = o.session;
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    o.signal?.addEventListener("abort", onAbort);
    const t = setTimeout(() => ctl.abort(), o.timeoutMs ?? 30_000);
    let res: Response;
    let text: string;
    try {
      res = await serverFetch(url, { method: o.method, headers, body: raw ?? undefined, signal: ctl.signal });
      text = await res.text();
    } catch (e: any) {
      throw new NetworkError(`can't reach ${this.base.host}: ${e?.cause?.code || e?.message || e}`);
    } finally {
      clearTimeout(t);
      o.signal?.removeEventListener("abort", onAbort);
    }
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    // a 2xx that is not JSON is not bot-link's server answering (a proxy page while the server or the tunnel is
    // unwell): a passing network problem, retried and never read as an answer (fix-all CLIENTGLUE 7)
    if (res.status >= 200 && res.status < 300 && text.trim() && json === null) throw new NetworkError(`${this.base.host} replied with a page that is not bot-link's (status ${res.status})`);
    if (res.status >= 200 && res.status < 300) {
      const date = Date.parse(res.headers.get("date") || "");
      return { status: res.status, json, date: Number.isFinite(date) ? date : null };
    }
    const err = json?.error || {};
    // below the server's minimum: one plain sentence and one background update (tooold.ts); not retried
    if (res.status === 426) throw clientTooOld(this.base.origin, err);
    const ra = Number(res.headers.get("retry-after")) || err.retry_after_s || null;
    const shaped = typeof err.code === "string" && typeof err.message === "string";
    throw new ApiError(res.status, String(err.code || `http_${res.status}`), String(err.message || `the server replied with status ${res.status}`), err.details ?? null, ra, err.server_time ?? null, shaped);
  }
}

/** Where the API is, for an invite: BOTLINK_SERVER wins; app.<x> invite URLs map to api.<x>; else the invite's origin. */
export function serverFor(invite: string | null, saved?: string | null): string {
  if (process.env.BOTLINK_SERVER) return process.env.BOTLINK_SERVER.replace(/\/+$/, "");
  if (invite && /^https?:\/\//i.test(invite)) {
    let u: URL | null = null;
    try {
      u = new URL(invite);
    } catch {
      /* fall through */
    }
    if (u) {
      // an invite link can come from anyone: only bot-link's own hosts (hosts.ts), checked BEFORE anything is sent
      assertHost(invite, "invite");
      if (u.hostname.startsWith("app.")) u.hostname = "api." + u.hostname.slice(4);
      return u.origin;
    }
  }
  const s = (saved || loadConfig().server || "https://api.botlink.dev").replace(/\/+$/, "");
  assertHost(s, "server");
  return s;
}

/** The code part of an invite: URL `/i/<room>-<code>`, `<room>-<code>`, or a bare code. Uppercased. */
export function inviteCode(invite: string): string {
  let s = invite.trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      s = new URL(s).pathname.replace(/^\/i\//, "").replace(/\/+$/, "");
    } catch {
      /* use as is */
    }
  }
  const last = s.split("-").pop() || s;
  return last.toUpperCase();
}

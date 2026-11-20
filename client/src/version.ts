/** Package version, read from package.json next to dist/ at runtime (no build-time JSON import). */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homeDir } from "./config.js";
import { fileURLToPath } from "node:url";
import { hostAllowed } from "./hosts.js";
import { liveMembers } from "./state.js";

export const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The client's package names: "botlink" (the tarball the server hands out at /dl, and every install so far) and
 * "@botlink/cli" (the same package on npm; npm refused the bare name "botlink"). Same code either way.
 */
export const PACKAGE_NAMES = ["botlink", "@botlink/cli"];
export const NPM_NAME = "@botlink/cli";

function readVersion(): string {
  try {
    return JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf-8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

// ---------------------------------------------------------------- how this copy was installed
/**
 * The npx spec this copy came from, e.g. "https://botlink.example/dl/botlink-mcp.tgz":
 *   - run by npx: npx installs into <cache>/_npx/<hash>/node_modules/botlink-mcp and writes the spec into
 *     <cache>/_npx/<hash>/package.json ({"dependencies": {"botlink-mcp": "<spec>"}})
 *   - the durable copy in ~/.botlink-mcp/app (see harnesses.appRoot) records it in .source
 * null for a git checkout or a global install.
 */
export function installSpec(): string | null {
  try {
    const src = join(PKG_ROOT, ".source");
    const s = readFileSync(src, "utf-8").trim();
    if (s) return s;
  } catch {
    /* not the copied app */
  }
  const scoped = /[\\/]_npx[\\/][^\\/]+[\\/]node_modules[\\/]@botlink[\\/]cli$/.test(PKG_ROOT);
  if (!scoped && !/[\\/]_npx[\\/][^\\/]+[\\/]node_modules[\\/](botlink|botlink-mcp)$/.test(PKG_ROOT)) return null;
  try {
    const base = dirname(dirname(scoped ? dirname(PKG_ROOT) : PKG_ROOT));
    const pj = JSON.parse(readFileSync(join(base, "package.json"), "utf-8"));
    const spec = pj?.dependencies?.[NPM_NAME] ?? pj?.dependencies?.["botlink"] ?? pj?.dependencies?.["botlink-mcp"]; // the npm name, or a tarball install
    if (typeof spec !== "string" || !spec) return null;
    // a tarball on this computer (`npx -y ./botlink.tgz`): npx records "file:<path relative to its _npx/<hash> folder>"
    const file = fileOfSpec(spec);
    return file ? `file:${isAbsolute(file) ? file : resolve(base, file)}` : spec;
  } catch {
    return null;
  }
}

/** The path in a local tarball spec ("file:../../x.tgz", "./x.tgz", "/a/x.tgz"), or null for a URL or a package name. */
export function fileOfSpec(spec: string | null): string | null {
  if (!spec) return null;
  if (spec.startsWith("file:")) return spec.slice(5).replace(/^\/\/(?=\/)/, "");
  return /^(\.{1,2}[\\/]|\/)/.test(spec) && /\.tgz$/.test(spec) ? spec : null;
}

/** The server this copy talks to, as far as it can know: BOTLINK_SERVER, the saved server, else the one server its
 *  members talk to. null: none known. */
export function knownServer(): string | null {
  const env = (process.env.BOTLINK_SERVER || "").trim();
  if (env) return env.replace(/\/+$/, "");
  try {
    const s = JSON.parse(readFileSync(join(homeDir(), "config.json"), "utf-8")).server;
    if (typeof s === "string" && /^https?:\/\//.test(s)) return s.replace(/\/+$/, "");
  } catch {
    /* none saved */
  }
  try {
    const all = [...new Set(liveMembers().map((m) => m.server).filter((x) => typeof x === "string" && /^https?:\/\//.test(x)))];
    if (all.length === 1) return all[0].replace(/\/+$/, "");
  } catch {
    /* no members */
  }
  return null;
}

/** Production's API origin (the server DEFAULT_CLIENT_URL belongs to). */
export const PRODUCTION_SERVER = "https://api.botlink.dev";
const isProduction = (server: string) => {
  try {
    return new URL(server).origin === PRODUCTION_SERVER;
  } catch {
    return false;
  }
};

/** What a person types when bot-link can't name its own command (a copy for another server than production, run in a
 *  way it can't repeat): words, never a command for another server. */
export const RUN_AGAIN = "<the command you started bot-link with>";

/**
 * The bot-link server a tarball spec was downloaded from: "<origin>/dl/botlink.tgz" -> "<origin>"; also the versioned
 * name the server hands out, "<origin>/dl/botlink-<16 hex>.tgz" (launch plan #3).
 */
export function originFromSpec(spec: string | null): string | null {
  if (!spec) return null;
  const m = spec.match(/^(https?:\/\/[^/?#]+)\/dl\/botlink(?:-mcp|-[0-9a-f]{16})?\.tgz(?:[?#].*)?$/);
  return m ? m[1] : null;
}

/** Production download of this client (deploy/NEEDS.md): `npx -y <url> …`. bot-link is NOT on the npm registry. */
export const DEFAULT_CLIENT_URL = "https://api.botlink.dev/dl/botlink.tgz";

/** Where this client is downloaded from: BOTLINK_CLIENT_URL, the tarball URL this copy came from, else production, but
 *  production only for production (or no known server): null for a copy that talks to another server. */
export function clientUrl(): string | null {
  // only an address of bot-link's own hosts is ever printed as "run this" (hosts.ts): a copy that came from
  // somewhere else points people back to the real one
  const env = (process.env.BOTLINK_CLIENT_URL || "").trim();
  if (/^https?:\/\//.test(env) && hostAllowed(env).ok) return env;
  const spec = installSpec();
  if (spec && /^https?:\/\//.test(spec) && hostAllowed(spec).ok) return spec;
  // staging tester, 17 Nov 2026: a copy for test.botlink.dev told its chat to run the production client
  const server = knownServer();
  return !server || isProduction(server) ? DEFAULT_CLIENT_URL : null;
}

/** A shell word as typed (a path with spaces or quotes gets single quotes). */
const shellWord = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

/**
 * What a person or a chat types to run this client again. NEVER a bare `npx botlink`: that name isn't ours on npm
 * (E404 today, and whoever registers it would run code on every machine that follows our instructions).
 *   - run from a tarball URL with npx: the same `npx -y <url>`
 *   - run from a tarball file with npx: `npx -y file:<absolute path>` (a bare absolute path is taken for a program)
 *   - a global install of our tarball (`botlink` on PATH): `botlink`
 *   - an install under ~/.botlink/client (self-update, SPEC §7.6): `node ~/.botlink/client/current/dist/cli.js`
 *   - anything else (a checkout): `node <absolute path>/dist/cli.js`
 */
export function selfCmd(): string {
  // the `botlink` launcher setup put on PATH (~/.local/bin/botlink), when it runs this same install
  if (launcherOnPath()) return "botlink";
  // an install under ~/.botlink/client (SPEC §7.6): the stable shim, which follows self-updates
  const cd = join(homeDir(), "client");
  const realOr = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const root = realOr(PKG_ROOT), rcd = realOr(cd);
  if (root.startsWith(rcd + sep)) return `node ${join(cd, "current", "dist", "cli.js")}`;
  const spec = installSpec();
  // run by `npx @botlink/cli`: that package exists (this copy came from it), pinned so npx can't reuse another copy
  if (spec && !/^https?:\/\//.test(spec) && /[\\/]node_modules[\\/]@botlink[\\/]cli$/.test(PKG_ROOT)) return `npx -y ${NPM_NAME}@${VERSION}`;
  if (spec && /^https?:\/\//.test(spec)) return `npx -y ${spec}`;
  // a tarball on this computer: the person ran that file (not an address from someone else), so it is named as it is
  const file = fileOfSpec(spec);
  if (file && isAbsolute(file) && existsSync(file)) return `npx -y ${shellWord(`file:${file}`)}`;
  if (spec) {
    const url = clientUrl();
    return url ? `npx -y ${url}` : RUN_AGAIN;
  }
  const argv1 = process.argv[1] || "";
  if (/[\\/]botlink$/.test(argv1) && !/[\\/]_npx[\\/]/.test(argv1)) return "botlink";
  if (process.env.BOTLINK_CLIENT_URL) {
    const url = clientUrl();
    return url ? `npx -y ${url}` : RUN_AGAIN;
  }
  return `node ${join(PKG_ROOT, "dist", "cli.js")}`;
}

/** Is bot-link's own launcher (~/.local/bin/botlink, written by setup) on PATH? */
export function launcherOnPath(): boolean {
  try {
    const p = join(process.env.HOME || "", ".local", "bin", "botlink");
    if (!readFileSync(p, "utf-8").includes("# bot-link launcher")) return false;
    return (process.env.PATH || "").split(":").some((d) => d && d.replace(/\/+$/, "") === dirname(p));
  } catch {
    return false;
  }
}

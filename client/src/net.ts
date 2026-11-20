/**
 * The one place the client makes an HTTP request to a bot-link server (api.ts calls, update.ts manifest and tarball).
 * A test (cfaccess.test.ts) fails on any other fetch in client/src.
 *
 * Testing against a server behind Cloudflare Access: with BOTH BOTLINK_CF_ACCESS_CLIENT_ID and
 * BOTLINK_CF_ACCESS_CLIENT_SECRET in this process's environment, a request to a configured bot-link server carries
 * CF-Access-Client-Id and CF-Access-Client-Secret, only to the origin of BOTLINK_SERVER (required) and of
 * BOTLINK_UPDATE_ORIGIN when set: the same environment names where the token goes. Never to any other origin, and never through a redirect (every request here refuses redirects). The values are
 * read from the environment for each request and never stored, logged or printed. Only one of the two set: said once
 * on stderr (the names only), and neither is sent.
 */

const ID = "BOTLINK_CF_ACCESS_CLIENT_ID";
const SECRET = "BOTLINK_CF_ACCESS_CLIENT_SECRET";
let saidHalf = false;
let saidNoServer = false;

const originOf = (u: string | null | undefined): string | null => {
  try {
    return u ? new URL(u).origin : null;
  } catch {
    return null;
  }
};

/** The Cloudflare Access headers for a request to url ({} when not set, half set, or another origin). */
export function accessHeaders(url: string | URL): Record<string, string> {
  const id = (process.env[ID] || "").trim();
  const secret = (process.env[SECRET] || "").trim();
  if (!id && !secret) return {};
  if (!id || !secret) {
    if (!saidHalf) {
      saidHalf = true;
      process.stderr.write(`bot-link: ${id ? ID : SECRET} is set but ${id ? SECRET : ID} is not, so neither Cloudflare Access header is sent.\n`);
    }
    return {};
  }
  // only where the same environment says: BOTLINK_SERVER, and BOTLINK_UPDATE_ORIGIN when set (never a saved server,
  // an install address or a member's server: an invite can point anywhere)
  const server = originOf(process.env.BOTLINK_SERVER);
  if (!server) {
    if (!saidNoServer) {
      saidNoServer = true;
      process.stderr.write(`bot-link: ${ID} and ${SECRET} are set but BOTLINK_SERVER is not, so neither Cloudflare Access header is sent. Set BOTLINK_SERVER to the server they are for.\n`);
    }
    return {};
  }
  const o = originOf(String(url));
  if (!o || (o !== server && o !== originOf(process.env.BOTLINK_UPDATE_ORIGIN))) return {};
  return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
}

/** fetch for a bot-link server: never follows a redirect; adds the Access headers when they apply. */
export function serverFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const headers = { ...((init.headers as Record<string, string>) || {}), ...accessHeaders(url) };
  return fetch(url, { ...init, headers, redirect: "error" });
}

/**
 * What a person (and, once, a chat) is told about bot-link's own updates (blocker 9): the last attempt, when it did
 * not end well, in plain words with the one command that fixes it; and the server's "this copy is too old" answer.
 * Texts only: update.ts records the attempts, tooold.ts the server's answer. No imports of update.ts at run time.
 */
import { homedir } from "node:os";
import { sep } from "node:path";

import type { UpdateAttempt, UpdateState } from "./update.js";
import { selfCmd, VERSION } from "./version.js";

const when = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const tilde = (p: string) => {
  const h = homedir();
  return h && (p === h || p.startsWith(h + sep)) ? `~${p.slice(h.length)}` : p;
};
const NETWORK_NEWS_MS = 3 * 86400_000;

/** One sentence (or three) for a failed attempt, ending with the command that fixes it. */
export function attemptText(a: UpdateAttempt, o: { clientDir?: string; cmd?: string } = {}): string {
  const cmd = o.cmd ?? `${selfCmd()} update`;
  const head = `bot-link's last update (${when(a.at)}, from ${a.from}${a.to ? ` to ${a.to}` : ""})`;
  switch (a.reason) {
    case "network":
      return `${head} could not run: bot-link couldn't reach its server. Nothing changed and this copy keeps working. It tries again by itself later; to try now, run \`${cmd}\`.`;
    case "unsigned":
      return `${head} found no signed release on the server, so nothing was installed. This copy keeps working. Run \`${cmd}\` later.`;
    case "signature":
      return `${head} was refused: the download did not match bot-link's release key. Nothing was installed and this copy keeps working. Do not install bot-link by hand from that address. Run \`${cmd}\` later.`;
    case "older":
      return `${head} was refused: the server offered a release older than the one installed here. Nothing changed and this copy keeps working. Run \`${cmd}\` later.`;
    case "disk":
      return `${head} could not finish: the disk is full. Nothing changed. Free some space, then run \`${cmd}\`.`;
    case "permission": {
      const dir = tilde(o.clientDir || "~/.botlink/client");
      return `${head} could not finish: bot-link may not write to ${dir} (it may have been made by another user, for example with sudo). Nothing changed. Make it yours again (\`sudo chown -R "$USER" ${dir}\`), then run \`${cmd}\`.`;
    }
    default:
      return `${head} could not finish (${(a.detail || "unknown reason").slice(0, 160)}). Nothing changed. Run \`${cmd}\` to try again.`;
  }
}

/** The server said this copy is too old (426 client_too_old). need: "release 12"; release: this copy's (0 = none). */
export function tooOldText(o: { need?: string; started: boolean; newerInstalled: boolean; blocked: string | null; cmd?: string; release?: number }): string {
  const cmd = o.cmd ?? `${selfCmd()} update`;
  const rel = o.release === undefined ? "" : o.release > 0 ? `, release ${o.release}` : ", installed without a release number";
  const head = `This copy of bot-link (${VERSION}${rel}) is too old to talk to its server${o.need ? ` (it needs ${o.need} or newer)` : ""}.`;
  if (o.newerInstalled) return `${head} A newer copy is installed already: restart the app this chat runs in to use it. If that does not help, run \`${cmd}\`.`;
  if (o.started) return `${head} bot-link is updating itself now; when that is done, restart the app this chat runs in. If it does not update, run \`${cmd}\`.`;
  if (o.blocked) return `${head} Automatic updates are off here (${o.blocked}). Run \`${cmd}\`, or run the install command from the invite page again, then restart the app this chat runs in.`;
  return `${head} Run \`${cmd}\`, then restart the app this chat runs in.`;
}

/** `botlink status`: the update lines (nothing when updates never ran here). */
export function updateStatusLines(s: UpdateState, o: { clientDir?: string; cmd?: string } = {}): string[] {
  const out: string[] = [];
  if (s.too_old) out.push(tooOldText({ need: s.too_old.need, started: false, newerInstalled: false, blocked: null, cmd: o.cmd }));
  const a = s.last;
  if (a && !a.ok) out.push(attemptText(a, o));
  else if (a?.ok) out.push(`Updates: bot-link ${a.to || a.from} is up to date (checked ${when(a.at)}).`);
  return out;
}

/** The chat's `status` tool: only what needs doing (the server's "too old" answer, a failed update), each with its
 *  fix; nothing when all is well. */
export function chatStatusLines(s: UpdateState, o: { clientDir?: string; cmd?: string } = {}): string[] {
  return updateStatusLines(s, o).filter((l) => !l.startsWith("Updates: "));
}

/**
 * For a chat, once per failed attempt and process (update.ts restartNotice): a failure worth its human's attention.
 * A network failure is news only after 3 days without a good check (a laptop that slept is not).
 */
export function problemNotice(s: UpdateState, now = Date.now(), o: { clientDir?: string } = {}): { key: number; text: string } | null {
  if (s.too_old) return { key: s.too_old.at, text: tooOldText({ need: s.too_old.need, started: false, newerInstalled: false, blocked: null }) };
  const a = s.last;
  if (!a || a.ok) return null;
  if (a.reason === "network" && (!s.last_ok_at || now - s.last_ok_at < NETWORK_NEWS_MS)) return null;
  return { key: a.at, text: `${attemptText(a, o)} Tell your human.` };
}

/**
 * The server's minimum client release (SPEC §7.6): a server answers 426 client_too_old to a client below it. This
 * turns that answer into one plain sentence ("too old to talk to its server; run `… update`") and starts ONE signed
 * self-update in the background (the normal path, update.ts): at most once per process and once per 30 minutes on
 * this computer, so a chat that keeps calling never starts an update loop. api.ts throws what this returns.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

import { HostError } from "./hosts.js";
import { loadState, newerInstalled, patchState, runningRelease, updateBlocked } from "./update.js";
import { tooOldText } from "./updatenote.js";
import { PKG_ROOT } from "./version.js";

/** core.explain shows a HostError's message as it is (the message is for the chat and its human). */
export class ClientTooOld extends HostError {}

const AGAIN_MS = 30 * 60_000;
let triedHere = false;

export function resetTooOldForTests() {
  triedHere = false;
}

function startUpdate(): boolean {
  try {
    // `botlink update` (forced, signed, recorded in update.json), detached: it outlives a short CLI call
    const child = spawn(process.execPath, [join(PKG_ROOT, "dist", "cli.js"), "update"], { detached: true, stdio: "ignore", env: process.env });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** The error to throw for a 426 answer from `server` (its error body: { code, message, details: { min_release } }). */
export function clientTooOld(server: string, body: { details?: { min_release?: unknown } } | null | undefined): ClientTooOld {
  const raw = body?.details?.min_release;
  const need = typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? `release ${raw}` : undefined;
  const now = Date.now();
  const s = loadState();
  const blocked = updateBlocked();
  const newer = newerInstalled();
  const start = !blocked && !newer && !triedHere && !(s.too_old_update_at && now - s.too_old_update_at < AGAIN_MS);
  if (start) triedHere = true;
  // recorded before the update starts: a quick, good update then clears it (update.ts), never the other way round
  patchState({ too_old: { at: now, ...(need ? { need } : {}), server }, ...(start ? { too_old_update_at: now } : {}) });
  const started = start && startUpdate();
  return new ClientTooOld(tooOldText({ need, started, newerInstalled: newer, blocked, release: runningRelease() }));
}

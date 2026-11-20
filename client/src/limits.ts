/**
 * The server's limits, in one plain sentence each (fix-all: the client half of scale prep 2cab158 and of the storage
 * quota). core.explain uses these before any server text:
 *   503 high_load     a server copy at its cap on open waits: a long wait backs off for the time the server says
 *                     (api.ts highLoadDelayMs) and says one calm line at most every 10 minutes, never one per retry
 *   409 storage_full  the account's stored messages are at the server's safety ceiling (details.value MB)
 *   409 server_full   stored messages across all accounts are at the server-wide ceiling
 *   409 plan_limit    over a limit of the plan (details.limit, details.value); storage_mb comes on send
 * A send refused with a 409 is not retried (api.ts retries only 5xx and 429): the chat is told that nothing was sent
 * and what to do, so the message is not lost without a word.
 */
import { ApiError, HIGH_LOAD_MAX_MS } from "./api.js";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** The one calm line for a busy server (503 high_load). retrying: said by a loop that does try again by itself. */
export function busyLine(e?: unknown, retrying = false): string {
  const ra = Math.min(e instanceof ApiError && e.retryAfterS && e.retryAfterS > 0 ? e.retryAfterS : 30, HIGH_LOAD_MAX_MS / 1000);
  return `bot-link is busier than usual; your messages are safe and will arrive. ${retrying ? `Retrying in ${ra} s.` : `Try again in ${ra} s.`}`;
}

let busySaidAt = 0;
/** busyLine at most once per 10 minutes per process (null otherwise): a busy server never becomes a line per retry. */
export function busyNotice(e?: unknown): string | null {
  if (Date.now() - busySaidAt < 10 * 60_000) return null;
  busySaidAt = Date.now();
  return busyLine(e, true);
}

/** A wait that never started because the server stayed busy (the wait tool, `botlink wait`). */
export const BUSY_NO_WAIT = "bot-link is busier than usual; your messages are safe and will arrive. This wait did not start, so nothing is listening yet.";

/** The sentence for a limit answer, or null when e is not one. */
export function limitText(e: ApiError): string | null {
  const v = num(e.details?.value);
  switch (e.code) {
    case "high_load":
      return busyLine(e);
    case "storage_full":
      return `This message was not sent: your human's bot-link account already has ${v !== null ? `${v} MB` : "as many"} of messages stored, the most one account may have. Space comes back as the other members read their messages or the messages expire. Send it again later, and tell your human if this keeps happening.`;
    case "server_full":
      return "This message was not sent: bot-link's server is full for now and stores no new messages. Send it again later, and tell your human if this lasts.";
    case "plan_limit":
      switch (e.details?.limit) {
        case "storage_mb":
          return `This message was not sent: your human's plan allows ${v !== null ? `${v} MB` : "a set amount"} of messages stored on bot-link, and their account has reached it. Tell your human: space comes back as messages are read or expire, or they can upgrade their plan. Then send it again.`;
        case "agents_per_room":
          return `This room already has ${v !== null ? `${v} members` : "as many members as"}, the most its plan allows. Nothing was joined. Tell your human: the room's owner can remove a member or upgrade the plan.`;
        case "people_per_room":
          return `This room already has ${v !== null ? `${v} people` : "as many people as"}, the most its plan allows. Tell your human: the room's owner can remove someone or upgrade the plan.`;
        case "rooms":
          return `Your human has ${v !== null ? `${v} rooms` : "as many rooms as"}, the most their plan allows. Tell your human: they can delete a room or upgrade.`;
        default:
          return "bot-link's server refused this because it is over a limit of your human's plan. Tell your human; the dashboard shows the plan's limits.";
      }
  }
  return null;
}

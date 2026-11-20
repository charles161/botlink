// The rooms home's "Last message 5 min ago" line (lane LASTMSG). Room level only: GET /app/v1/rooms gives
// last_message_at, the time the server accepted the room's newest message. Nothing about who sent it or who read it.
import { ago } from "./dom.js";

/** How often the rooms home recomputes the relative text from the times it already has (no new request). */
export const LAST_MESSAGE_TICK_MS = 60_000;

/** "Last message 5 min ago" for a time; "No messages yet" for null. */
export function lastMessageText(iso, now = Date.now()) {
  return iso ? `Last message ${ago(iso, now)}` : "No messages yet";
}

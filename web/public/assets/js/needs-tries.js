// "What needs you": join requests of one room from the same place (app, computer, folder) as ONE card (rules: tries.js).
// The card is the newest request's join card (needs.js joinCard: the same facts, code, key, tick box and Approve,
// which acts on the newest only), with its own title, a line that counts the different codes, the older tries under a
// collapsed "Older tries" (name, code, when asked, and an Approve of their own), and "Reject all".
import { h, ago, toast } from "./dom.js";
import { post, errorText } from "./api.js";
import { appName } from "./art.js";
import { refreshNeeds } from "./app.js";
import { codesWaiting, triesKey } from "./tries.js";
import { matchCode, groupCode, approveJoin, btn, busyBtn } from "./needs.js";

const openOlder = new Set(); // cards whose Older tries list is open: kept across redraws (live updates)
const drawn = new Set();     // cards drawn before: a redraw updates them in place, without the entrance animation

const listNames = (names) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** What joinCard needs to draw a unit of two or more tries as one card. */
export function triesParts(unit, { onDone } = {}) {
  const key = triesKey(unit);
  const again = drawn.has(key);
  drawn.add(key);
  const n = unit.all.length, k = codesWaiting(unit), c = unit.newest;
  return {
    key, again, count: n,
    title: `${appName(c.app, c.app_name)} on ${c.machine} wants in · ${n} tries`,
    line: `${n} tries, ${k === 1 ? "all with the same code" : `${k} different codes`}. Approve only the one whose code your chat shows. Another chat could copy this computer and folder.`,
    older: (blockReady) => olderTries(unit, key, blockReady, onDone),
    rejectAll: (b) => rejectAll(unit, b, onDone),
  };
}

function olderTries(unit, key, blockReady, onDone) {
  const rows = unit.older.map((c) => {
    const ap = btn("Approve this one", "btn-ghost", () => approveJoin(c, onDone));
    ap.setAttribute("aria-label", `Approve ${c.name}, code ${groupCode(c.match_code)}`);
    blockReady.then((why) => { if (why) ap.disabled = true; });
    return h("li", { class: "tries-row", "data-older-request": c.id },
      h("span", { class: "tries-who" }, h("span", { class: "tries-name" }, c.name), h("span", { class: "tries-when" }, `asked ${ago(c.created_at)}`)),
      matchCode(c.match_code, { size: "sm" }),
      ap);
  });
  const d = h("details", { class: ["more", "tries-more"], open: openOlder.has(key) },
    h("summary", null, `Older tries (${unit.older.length})`),
    h("div", { class: "more-body" },
      h("p", null, "Each try has its own name and code. Approve one only if its code is the one your chat shows."),
      h("ul", { class: "tries-list" }, rows)));
  d.addEventListener("toggle", () => { if (d.open) openOlder.add(key); else openOlder.delete(key); });
  return d;
}

/** Reject every try of the unit with the single reject call; say what happened to each, a failure included. */
async function rejectAll(unit, b, onDone) {
  busyBtn(b, true);
  const res = await Promise.allSettled(unit.all.map((c) => post(`/app/v1/join-requests/${c.id}/reject`)));
  const done = [], decided = [], failed = [];
  res.forEach((r, i) => {
    const c = unit.all[i];
    if (r.status === "fulfilled") done.push(c);
    else if (r.reason?.code === "already_decided") decided.push(c);
    else failed.push([c, r.reason]);
  });
  toast(rejectText(unit.all.length, done, decided, failed), failed.length ? "error" : "success", failed.length ? 9000 : 5200);
  await refreshNeeds();
  onDone?.();
}

/** The one line "Reject all" ends with (exported for the tests). */
export function rejectText(n, done, decided, failed) {
  if (done.length === n) return n === 2 ? "Rejected both tries. Neither comes in." : `Rejected all ${n} tries. None of them comes in.`;
  const out = [done.length ? `Rejected ${done.length} of ${n}: ${listNames(done.map((c) => c.name))}.` : "Nothing was rejected."];
  if (decided.length) out.push(`${listNames(decided.map((c) => c.name))} ${decided.length === 1 ? "was" : "were"} already decided.`);
  if (failed.length) {
    out.push(`${listNames(failed.map(([c]) => c.name))} couldn't be rejected, so ${failed.length === 1 ? "it's" : "they're"} still waiting.`);
    out.push(errorText(failed[0][1]));
  }
  return out.join(" ");
}

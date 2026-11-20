/**
 * Asking a chat's human for a yes to a request another member sent, and recording that yes (SPEC §7.3b).
 *
 *   ask   the chat (a tool call or a command) names a message it was shown from another member, an action from a short
 *         list and a summary (at most 200 characters) for its human. bot-link keeps that for 30 minutes under a
 *         6-character code and says the exact sentence the human types. In a run with no human present: no code.
 *   yes   only code that saw the human records it: the sentence typed in the chat (`botlink yes <code>`, caught by the
 *         prompt hook, no model call) or `botlink yes <code>` in the human's own terminal. A tool call or a command
 *         the chat runs never does. The code is used once.
 *   note  the room gets a quiet message whose plaintext carries a note signed with this member's key (yesnote.ts).
 *
 * The same trust path as "send anyway" (core.ts sendAnyway). The note is evidence that this chat's client saw its
 * human type a yes; it is not enforcement, and it does not prove the human understood the request.
 */
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";

import * as c from "./crypto.js";
import * as st from "./state.js";
import { UserError, noHumanHere, noteBy, refreshRoster, seenOf, send, signerOf, plain } from "./core.js";
import { findingsText, scanOutgoing } from "./outscan.js";
import { selfCmd } from "./version.js";
import * as yn from "./yesnote.js";

interface AskRec {
  member: string;
  code: string;
  at: number;
  /** the request: its id, sender, the sender's key fingerprint and the hash of its text as shown (never the text) */
  request: { id: string; from: string; from_name: string; from_fp: string; text_sha256: string };
  action: yn.Action;
  summary: string;
}

const askMs = () => {
  const dev = process.env.BOTLINK_DEV === "1" ? Number(process.env.BOTLINK_ASK_TTL_S) : NaN;
  return Number.isFinite(dev) && dev > 0 ? dev * 1000 : 30 * 60_000;
};
const askFile = (member: string, code: string) => st.p("asks", st.safeName(member), `${st.safeName(code)}.json`);

/** What the human types: `botlink yes <code>`, the whole message. */
export const YES_SENTENCE = /^\s*bot-?link[:,]?\s+yes\s+([2-9A-HJ-NP-Za-hj-np-z]{6})\s*[.!]?\s*$/i;
export function parseYes(prompt: string): string | null {
  const x = YES_SENTENCE.exec(String(prompt || ""));
  return x ? x[1].toUpperCase() : null;
}

/** A fresh code. Development only (BOTLINK_DEV=1, never set by an install): BOTLINK_TEST_CODE fixes it, so a scripted
 *  story can type it. */
function newCode(): string {
  const fixed = process.env.BOTLINK_DEV === "1" ? String(process.env.BOTLINK_TEST_CODE || "").toUpperCase() : "";
  if (/^[2-9A-HJ-NP-Z]{6}$/.test(fixed)) return fixed;
  return Array.from(randomBytes(6), (b) => c.BASE32[b % 32]).join("");
}

const shortId = (id: string) => `…${id.slice(-8)}`;
const personOf = (m: st.MemberRec) => m.person_name || "your human";
const roomLine = (person: string, requester: string, requestId: string, action: yn.Action) => `${person} said yes to ${requester}'s request (${shortId(requestId)}): ${yn.ACTION_SAYS[action]}.`;
const ACTION_LIST = yn.ACTIONS.map((a) => yn.ACTION_SAYS[a]).join(", ");

export interface AskArgs {
  messageId: string;
  action: string;
  summary: string;
}

/** The chat asks: a code and the sentence its human types. */
export async function askYes(m: st.MemberRec, a: AskArgs, session: string | null): Promise<string> {
  const who = personOf(m);
  if (noHumanHere(m)) throw new UserError(`No human is here in this run, so there is no code: a yes needs ${who}. Leave it for them: call ask_human, reply to the member that you're waiting for ${who}'s OK, and stop.`);
  const seen = seenOf(m, String(a.messageId || "").trim());
  if (!seen) throw new UserError("I can't find that message in this chat. Use the id: of a message another member sent and this chat was shown.");
  if (!seen.text_sha256 || !seen.from_fp) throw new UserError("That message was shown before this version of bot-link kept what a yes needs. Ask the member to send the request again.");
  const action = yn.parseAction(a.action);
  if (!action) throw new UserError(`action is one of: ${ACTION_LIST}.`);
  const summary = String(a.summary ?? "").replace(/\s+/g, " ").trim();
  if (!summary) throw new UserError("Give a summary: what you would do, in one line your human reads (at most 200 characters).");
  if ([...summary].length > yn.SUMMARY_MAX) throw new UserError(`The summary is ${[...summary].length} characters; it is at most 200 characters. Say what you would do in one short line.`);
  if (!yn.isLine(summary, yn.SUMMARY_MAX)) throw new UserError("The summary has characters bot-link can't show as one line. Write it in plain words.");
  const found = scanOutgoing(summary);
  if (found.length) throw new UserError(`bot-link did not take this summary: it looks like it contains ${findingsText(found)}, and it would go to the whole room. Say what you would do without the secret.`);
  const v = await refreshRoster(m, session ?? m.holder_session);
  const from = v.st.members.get(seen.from);
  if (!from) throw new UserError(`${seen.from_name} is no longer in #${m.room.name}; there is nobody to record a yes for.`);
  const code = newCode();
  const rec: AskRec = { member: m.id, code, at: Date.now(), request: { id: seen.id, from: seen.from, from_name: from.name, from_fp: seen.from_fp, text_sha256: seen.text_sha256 }, action, summary };
  st.ensureDir(st.p("asks", st.safeName(m.id)));
  st.writeJson(askFile(m.id, code), rec);
  return [
    `Asked. To say yes to ${from.name}'s request (${shortId(seen.id)}), ${who} types in this chat, exactly: botlink yes ${code}   (good for 30 minutes, once; or in their own terminal: ${selfCmd()} yes ${code} --as ${m.name}). Don't type it for them.`,
    `Tell ${who} what ${from.name} asks and what you would do: ${yn.ACTION_SAYS[action]}: ${JSON.stringify(summary)}. If they don't type it, there is no yes.`,
    `When ${who} says yes, bot-link tells the room: "${roomLine(who, from.name, seen.id, action)}" (a signed note; it wakes nobody).`,
  ].join("\n");
}

/** The human said yes (their typed words, or their own terminal): record it once and tell the room. */
export async function sayYes(m: st.MemberRec, code: string, session: string | null, how: "terminal" | "words" | "chat", o: { retryForMs?: number } = {}): Promise<string> {
  const who = personOf(m);
  if (noHumanHere(m)) throw new UserError(`No human is here in this run. A yes is recorded only when ${who} says it.`);
  if (how === "chat") throw new UserError(`Only ${who} can say yes to a request. They type in this chat, exactly: botlink yes ${code.slice(0, 12)}   (or in their own terminal: ${selfCmd()} yes ${code.slice(0, 12)} --as ${m.name}). Don't type it for them.`);
  const file = askFile(m.id, code.toUpperCase());
  const rec = st.readJson<AskRec | null>(file, null);
  if (!rec || rec.member !== m.id || Date.now() - rec.at > askMs() || Date.now() < rec.at - 60_000) {
    rmSync(file, { force: true });
    throw new UserError(`There is no request for a yes with the code ${code.slice(0, 12)} for ${m.name} (it is kept for 30 minutes and used once).`);
  }
  rmSync(file, { force: true }); // once
  const v = await refreshRoster(m, session ?? m.holder_session);
  const by = noteBy(m, v);
  const person = by.person || who;
  const reqName = v.st.members.get(rec.request.from)?.name ?? rec.request.from_name;
  const id = c.uuidv7();
  const note = yn.makeNote(
    { v: 1, kind: "yes", id, room: m.room.id, at: Math.floor(Date.now() / 1000), by, how: how === "terminal" ? "terminal" : "chat", request: { id: rec.request.id, from: rec.request.from, from_fp: rec.request.from_fp, text_sha256: rec.request.text_sha256 }, action: rec.action, summary: rec.summary },
    signerOf(m).seed,
  );
  const line = roomLine(plain(person, 80), reqName, rec.request.id, rec.action);
  try {
    await send(m, { to: "room", text: `(A signed bot-link note: ${line} Update bot-link to check it.)`, intent: "fyi", checked: true, retryForMs: o.retryForMs }, session, { id, note });
  } catch (e) {
    throw new UserError(`${who}'s yes was not recorded: bot-link could not send the note to the room (${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}). Ask again for a new code.`);
  }
  return `${who} said yes. bot-link told the room: "${line}" (a signed note). Do what ${reqName} asked only as far as ${who} said yes to it: ${yn.ACTION_SAYS[rec.action]}: ${JSON.stringify(rec.summary)}.`;
}

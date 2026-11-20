/**
 * What a member may get from this chat: a setting per member, made by the chat's human, kept on this computer only
 * (`~/.botlink/perms/<this member>.json`) and enforced HERE, before anything reaches the model:
 *
 *   muted    its messages are never shown to this chat
 *   answer   this chat answers from what is already in its conversation; it opens no files and runs nothing for it
 *   files    this chat may also look things up and read files to answer
 *   tasks    this chat may also do work the member asks for (high-stakes actions still need the human's yes)
 *
 * Defaults: the human's own other chats: files. Another person's chats: answer. And another person's chat is never
 * shown to this chat while no human is here (a woken or unattended run): the message is held for the human, unless
 * the human said that member may also be handled while they are away (`while_away`).
 *
 * A setting is keyed by the member's id, not its name: a new member that takes a removed member's name starts at
 * the default.
 */
import * as st from "./state.js";

export type Level = "muted" | "answer" | "files" | "tasks";
export const LEVELS: Level[] = ["muted", "answer", "files", "tasks"];
const RANK: Record<Level, number> = { muted: 0, answer: 1, files: 2, tasks: 3 };

/** The words people and chats type for a level. */
const WORDS: Record<string, Level> = {
  muted: "muted", mute: "muted",
  answer: "answer", "answer-only": "answer", "answer-from-conversation": "answer", conversation: "answer",
  files: "files", "read-files": "files", "may-read-files": "files",
  tasks: "tasks", "give-tasks": "tasks", "may-give-tasks": "tasks",
};
export function parseLevel(s: string): Level | null {
  return WORDS[String(s || "").trim().toLowerCase()] ?? null;
}

/** One line a person understands. */
export const LEVEL_SAYS: Record<Level, string> = {
  muted: "muted (its messages are never shown to this chat)",
  answer: "answer from this conversation only (no files opened, nothing run for it)",
  files: "may have files read to answer it",
  tasks: "may give this chat tasks (never high-stakes ones without your yes)",
};

export interface PermRec {
  level: Level;
  /** another person's member only: its messages may reach this chat while no human is here */
  while_away?: boolean;
  set_at: number;
  /** how the human said it: in a terminal, or typed in the chat (their words kept) */
  how: "terminal" | "words";
  quote?: string;
  /** display only: the name the member had when this was set */
  name?: string;
}

const file = (member: string) => st.p("perms", `${st.safeName(member)}.json`);

export function permsOf(member: string): Record<string, PermRec> {
  const r = st.readJson<Record<string, PermRec>>(file(member), {});
  const out: Record<string, PermRec> = {};
  if (r && typeof r === "object") for (const [k, v] of Object.entries(r)) if (v && LEVELS.includes(v.level)) out[k] = v;
  return out;
}

export interface Effective {
  level: Level;
  whileAway: boolean;
  /** the human set it (else: the default for whose chat it is) */
  set: boolean;
}

/** The setting in force for `sender` as seen by member `me`. */
export function permFor(me: { id: string; account: string }, sender: { id: string; account: string }): Effective {
  const own = sender.account === me.account;
  const rec = permsOf(me.id)[sender.id];
  if (rec) return { level: rec.level, whileAway: own ? true : rec.while_away === true, set: true };
  return { level: own ? "files" : "answer", whileAway: own, set: false };
}

/** Does going from `from` to `to` give the member more than it had? (More needs the human; less never does.) */
export function isMore(from: Effective, to: { level: Level; whileAway: boolean }): boolean {
  return RANK[to.level] > RANK[from.level] || (to.whileAway && !from.whileAway);
}

export function setPerm(me: string, sender: string, rec: PermRec) {
  const all = permsOf(me);
  all[sender] = rec;
  st.ensureDir(st.p("perms"));
  st.writeJson(file(me), all);
}

export function clearPerm(me: string, sender: string) {
  const all = permsOf(me);
  delete all[sender];
  st.writeJson(file(me), all);
}

// ------------------------------------------------------------------ what was kept from the model (for `permissions`)
interface Kept {
  muted: Record<string, number>;
}
const keptFile = (member: string) => st.p("perms", `${st.safeName(member)}.kept.json`);
export function countMuted(me: string, sender: string) {
  const k = st.readJson<Kept>(keptFile(me), { muted: {} });
  k.muted = k.muted || {};
  k.muted[sender] = (k.muted[sender] || 0) + 1;
  st.ensureDir(st.p("perms"));
  st.writeJson(keptFile(me), k);
}
export function mutedCounts(me: string): Record<string, number> {
  return st.readJson<Kept>(keptFile(me), { muted: {} }).muted || {};
}

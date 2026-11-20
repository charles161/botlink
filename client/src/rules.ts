/**
 * Standing rules (SPEC §7.4, P0-6): client-side only, never sent to the server.
 * A rule is stored only when its wording is a WHOLE prompt (>= 12 chars, word for word) the human typed in
 * THIS session within the last 30 minutes, as captured by the UserPromptSubmit hook (member chats only; see state.ts prunePrompts). The model proposes; the
 * human's own words are what is stored.
 */
import { rmSync } from "node:fs";

import * as st from "./state.js";

export const MIN_QUOTE = 12;
export const WINDOW_MS = st.PROMPT_TTL_MS; // prompts older than this are not even kept on disk
export const REFUSED = "I can only save a rule your human typed in this chat.";

export interface Rule {
  quote: string;
  said_by: string;
  session: string;
  at: number;
}

function file(member: string) {
  return st.p("rules", `${st.safeName(member)}.json`);
}

export function rulesOf(member: string): Rule[] {
  const r = st.readJson<Rule[]>(file(member), []);
  return Array.isArray(r) ? r.filter((x) => x && typeof x.quote === "string") : [];
}

const norm = (s: string) => s.replace(/\r\n/g, "\n");

/** -> the stored rule, or null + the refusal sentence. */
export function saveRule(member: string, session: string | null, quote: string, saidBy: string, nowMs = Date.now()): { ok: true; rule: Rule } | { ok: false; why: string } {
  const q = norm(String(quote ?? "")).trim();
  if (!session) return { ok: false, why: `${REFUSED} (This app gives bot-link no way to see what your human typed, so every request needs their yes.)` };
  if (q.length < MIN_QUOTE) return { ok: false, why: `${REFUSED} (The quote must be at least ${MIN_QUOTE} characters of their exact words: a whole message of theirs.)` };
  const recent = st.readPrompts(session, nowMs).filter((p) => nowMs - p.at <= WINDOW_MS);
  // the WHOLE message, word for word: a part of one can mean the opposite ("never let lead deploy…" holds "let lead
  // deploy…"), and words lifted out of a longer message were not said as a rule
  if (!recent.some((p) => norm(p.text).trim() === q)) return { ok: false, why: recent.some((p) => norm(p.text).includes(q)) ? `${REFUSED} (A rule is a whole message of theirs, word for word; part of one is not.)` : REFUSED };
  const rules = rulesOf(member).filter((r) => r.quote !== q);
  const rule: Rule = { quote: q, said_by: saidBy, session, at: nowMs };
  rules.push(rule);
  st.writeJson(file(member), rules);
  return { ok: true, rule };
}

/** Remove the rule with that number (1-based, as `rules` lists them) -> the removed rule, or null. */
export function removeRule(member: string, n: number): Rule | null {
  const rules = rulesOf(member);
  if (!Number.isInteger(n) || n < 1 || n > rules.length) return null;
  const [gone] = rules.splice(n - 1, 1);
  st.writeJson(file(member), rules);
  return gone;
}

export function clearRules(member: string) {
  rmSync(file(member), { force: true });
}

/**
 * Hooks that could not reach bot-link's server (fix-all CLIENTGLUE 7). A hook never fails, blocks or wakes a chat
 * because the server or the network is unwell: it ends quietly. The miss is kept here (the last one only, so a long
 * outage is one line, not one per hook) for `botlink status`, and is cleared by the next hook that reached the server.
 * Nothing is lost by a miss: what waited stays on the server and is shown by the next hook, a listener or the inbox tool.
 */
import * as st from "./state.js";

interface Miss {
  at: number;
  /** "codex stop", "claude-code session-start", … */
  hook: string;
  why: string;
}
const file = () => st.p("hookmiss.json");

export function recordMiss(hook: string, why: string) {
  try {
    st.writeJson(file(), { at: Date.now(), hook, why: why.slice(0, 160) } satisfies Miss);
  } catch {
    /* best effort: a hook never fails over this */
  }
}

/** The server answered a hook: a miss before it is no longer news. */
export function recordReached() {
  try {
    if (st.readJson<Miss | null>(file(), null)) st.writeJson(file(), null);
  } catch {
    /* best effort */
  }
}

/** `botlink status`: one line for the last miss, when nothing reached the server since (and it is under a day old). */
export function missLines(now = Date.now()): string[] {
  const m = st.readJson<Miss | null>(file(), null);
  if (!m || !m.at || now - m.at > 86400_000) return [];
  const t = new Date(m.at).toISOString().slice(11, 16);
  return [`bot-link's server could not be reached at ${t} UTC (by the ${m.hook} hook: ${m.why}). The chat was not woken or held up for it, and nothing was lost: what waited is shown by the next hook, a listener or the inbox tool.`];
}

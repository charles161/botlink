/**
 * The evidence bundle saved next to a room report (docs/protocol/room-report.md): the kept messages exactly as
 * stored (sealed, signed), the signed member list, and the yes notes. It never holds a key. `verifyBundle` checks
 * everything a bundle lets anyone check without a decryption key (the member list chain, each message's signature
 * over its sealed text, each note's own signature through the injected verifier) and, given the owning member's
 * key, opens the text too. No network.
 */
import { readFileSync } from "node:fs";

import type { SignedEntry } from "./roster.js";
import type { ArchRec } from "./archive.js";
import { buildTranscript, checkNote, RosterTimeline, type Counts, type NoteVerifier, type Transcript } from "./transcript.js";
import { peekHeader, type Envelope } from "./envelope.js";

export const BUNDLE_KIND = "botlink-room-report-evidence";

export interface Bundle {
  v: 1;
  kind: typeof BUNDLE_KIND;
  report_id: string;
  made_at: number;
  room: { id: string; name: string; fingerprint: string };
  member: { id: string; name: string; person: string };
  period: { from: number; to: number; days: number };
  kept_since: number | null;
  roster: { room_id: string; entries: SignedEntry[] };
  messages: ArchRec[];
  /** the notes as this chat opened them, with the signed header of the message that carried each and its resend_of */
  notes: { message_id: string; h: string; resend_of?: string | null; note: unknown }[];
  /** what the report's facts block said */
  facts: Counts;
}

/** The signed header of a kept message (a sent one: its first copy). */
function headerB64(r: ArchRec | undefined): string {
  if (!r) return "";
  return r.dir === "in" ? r.envelope.h : r.envelopes[0]?.envelope.h || "";
}

export function makeBundle(reportId: string, t: Transcript, entries: SignedEntry[], records: ArchRec[], madeAtMs = Date.now()): Bundle {
  return {
    v: 1,
    kind: BUNDLE_KIND,
    report_id: reportId,
    made_at: Math.floor(madeAtMs / 1000),
    room: { id: t.room.id, name: t.room.name, fingerprint: t.room.fp },
    member: { id: t.me.id, name: t.me.name, person: t.me.person },
    period: t.period,
    kept_since: t.kept_since,
    roster: { room_id: t.room.id, entries },
    messages: records,
    notes: t.entries.filter((e) => e.note).map((e) => ({ message_id: e.id, h: headerB64(records.find((r) => r.id === e.id)), resend_of: e.note!.resend_of, note: e.note!.raw })),
    facts: t.counts,
  };
}

export function readBundle(path: string): Bundle {
  let b: any;
  try {
    b = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new Error("that file is not a bot-link room report bundle (not readable JSON)");
  }
  if (!b || b.v !== 1 || b.kind !== BUNDLE_KIND || !b.room || !b.member || !b.roster || !Array.isArray(b.roster.entries) || !Array.isArray(b.messages)) {
    throw new Error("that file is not a bot-link room report bundle");
  }
  return b as Bundle;
}

export interface BundleCheck {
  chain: { ok: true; head: number; room_fp: string; fp_matches: boolean } | { ok: false; why: string };
  messages: number;
  signatures_checked: number;
  not_checked: { ref: string; reason: string }[];
  /** yes notes / setting notes that check out, and notes (either kind) that don't */
  notes_checked: number;
  allow_checked: number;
  notes_not_checked: number;
  /** only when the owning member's key was given */
  text?: { opened: number; not_opened: number };
  facts_match: boolean | null;
  differences: string[];
}

/** Check a bundle. `xSk`: the owning member's decryption key (this computer holds that member), else null. */
export function verifyBundle(b: Bundle, verifyNote: NoteVerifier, xSk: string | null = null): BundleCheck {
  let tl: RosterTimeline;
  try {
    if (b.roster.room_id !== b.room.id) throw new Error("the member list is for another room");
    tl = new RosterTimeline(b.room.id, b.roster.entries);
  } catch (e) {
    return { chain: { ok: false, why: (e as Error).message }, messages: b.messages.length, signatures_checked: 0, not_checked: [], notes_checked: 0, allow_checked: 0, notes_not_checked: 0, facts_match: null, differences: [] };
  }
  const recs = b.messages.filter((r) => r && r.member === b.member.id && r.room === b.room.id);
  const sig = buildTranscript({ records: recs, tl, me: b.member, room: b.room, xSk: null, verifyNote, period: b.period, caps: { messages: Infinity, chars: Infinity } });
  // notes: the same check the report made (yesnote.ts through transcript.checkNote), against the member list as it
  // stood when the carrying message was sent; the header is the kept message's own (its signature checked above)
  let nOk = 0, aOk = 0, nBad = 0;
  for (const n of Array.isArray(b.notes) ? b.notes : []) {
    const e = sig.entries.find((x) => x.id === n.message_id);
    const rec = recs.find((r) => r.id === n.message_id);
    let ok: false | "yes" | "allow" = false;
    if (e?.checked && rec && headerB64(rec) === n.h) {
      try {
        const r = checkNote(verifyNote, n.note, peekHeader({ v: 3, h: n.h, ct: "", sig: "" } as Envelope), tl, Math.floor(e.at / 1000), typeof n.resend_of === "string" ? n.resend_of : null);
        if (r.ok) ok = r.kind;
      } catch {
        ok = false;
      }
    }
    if (ok === "yes") nOk++;
    else if (ok === "allow") aOk++;
    else nBad++;
  }
  const out: BundleCheck = {
    chain: { ok: true, head: tl.current.head_seq, room_fp: tl.current.room_fp, fp_matches: tl.current.room_fp === b.room.fingerprint },
    messages: recs.length,
    signatures_checked: sig.counts.checked,
    not_checked: sig.entries.filter((e) => !e.checked).map((e) => ({ ref: e.ref, reason: e.reason || "" })),
    notes_checked: nOk,
    allow_checked: aOk,
    notes_not_checked: nBad,
    facts_match: null,
    differences: [],
  };
  // the notes, with or without the key: the bundle holds them as opened
  if (b.facts) {
    if (b.facts.notes_checked !== nOk) out.differences.push(`the report said yes notes checked: ${b.facts.notes_checked}; checked again now: ${nOk}`);
    if (b.facts.allow_checked !== undefined && b.facts.allow_checked !== aOk) out.differences.push(`the report said setting notes checked: ${b.facts.allow_checked}; checked again now: ${aOk}`);
  }
  if (recs.length !== b.messages.length) out.differences.push(`${b.messages.length - recs.length} stored message(s) belong to another member or room`);
  if (xSk) {
    const full = buildTranscript({ records: recs, tl, me: b.member, room: b.room, xSk, verifyNote, period: b.period, caps: { messages: Infinity, chars: Infinity } });
    out.text = { opened: full.counts.checked, not_opened: full.counts.not_checked };
    const f = b.facts;
    if (f) {
      const pairs: [string, number, number][] = [["messages", f.total, full.counts.total], ["checked", f.checked, full.counts.checked], ["could not be checked", f.not_checked, full.counts.not_checked]];
      for (const [k, said, now] of pairs) if (said !== now) out.differences.push(`the report said ${k}: ${said}; checked again now: ${now}`);
    }
  } else if (b.facts) {
    if (b.facts.total !== recs.length) out.differences.push(`the report said messages: ${b.facts.total}; the bundle holds ${recs.length}`);
    // without the key a message that opened then can't be told from one that would not open now; signatures only
    if (sig.counts.checked < b.facts.checked) out.differences.push(`the report said checked: ${b.facts.checked}; signatures that check now: ${sig.counts.checked}`);
  }
  if (b.facts) out.facts_match = out.differences.length === 0;
  return out;
}

export function bundleCheckText(b: Bundle, r: BundleCheck): string {
  const lines = [`Room report bundle ${b.report_id}: #${b.room.name}, kept by ${b.member.name}, made ${new Date(b.made_at * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC")}. Checked on this computer, with no network.`];
  if (!r.chain.ok) {
    lines.push(`Member list: does NOT verify (${r.chain.why}). Nothing in this bundle can be checked.`);
    return lines.join("\n");
  }
  lines.push(`Member list: the signed chain verifies (${r.chain.head + 1} entries). Room fingerprint ${r.chain.room_fp}${r.chain.fp_matches ? "" : " (the bundle names a different one)"}: compare it with the room page.`);
  lines.push(`Messages: ${r.messages}. Signatures that check against the member list: ${r.signatures_checked}. Could not be checked: ${r.not_checked.length}.`);
  for (const x of r.not_checked.slice(0, 50)) lines.push(`  ref ${x.ref}: ${x.reason}`);
  lines.push(`Signed notes: ${r.notes_checked} yes note${r.notes_checked === 1 ? "" : "s"} and ${r.allow_checked} setting note${r.allow_checked === 1 ? "" : "s"} check out; ${r.notes_not_checked} could not be checked (never counted as a yes).`);
  if (r.text) lines.push(`Text (opened with ${b.member.name}'s key on this computer): ${r.text.opened} opened and checked, ${r.text.not_opened} not.`);
  else lines.push(`Text: not checked (that needs ${b.member.name}'s key; run this on the computer that holds it). A signature covers the sealed text, so without the key this shows who sent what to whom and when, not what it said.`);
  if (r.facts_match === true) lines.push("The counts in the report's facts block match.");
  for (const d of r.differences) lines.push(`Difference: ${d}.`);
  return lines.join("\n");
}

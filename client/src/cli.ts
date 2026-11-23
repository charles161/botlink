#!/usr/bin/env node
/**
 * botlink …   (PLAN §3.2; run as `npxRun(<server>/dl/botlink.tgz) …` (version.ts) or the `botlink` launcher setup puts on PATH)
 * Talk (works in any terminal, no app restart):  roster · send · inbox · reply · status   [--as <name>] [--room <r>] [--session <id>]
 * Join:   join <invite> --name <n> --job <j> [--app-name "<app>"] [--session <id>]  ·  join --wait
 * Rooms:  create-room --room <r> --purpose "<p>" --name <n> --job <j> (a person confirms it) · invite-link [--as <n>]
 * Setup:  setup [<app>…] [--scope project|user] [--dir <folder>] [--remove-old] [--yes]   (preview first; nothing changes without --yes)
 * Ears:   wait [--max-s <n>]  (the signal: blocks until a message waits, then ends; the chat picks what turns that into a turn)
 *         listen --on-message "<cmd>" --detach · listen --tmux [<pane>] · listen --via codex-queue|opencode|t3 … · listen --stop
 * Also:   claim · label · selftest · presence · leave · watch · uninstall · update · hook (internal) · mcp (internal)
 */
import { realpathSync } from "node:fs";

import * as c from "./crypto.js";
import * as st from "./state.js";
import * as core from "./core.js";
import { appRun, chatFolder, chatSession, currentSession, cursorChatOf, cursorChatFromEnv, holderSession, detectApp, headlessRun, machineName, mcpToolsLoaded, setExplicitSession, t3ThreadFromEnv, tildeFolder } from "./session.js";
import { applySetup, configuredHere, localInstallProblem, migrateToShim, previewSetup, serviceInstalledFor, uninstallAll, watchInstall, watchStatus, watchUninstall, reportLines, type SetupApp, SETUP_APPS } from "./setup.js";
import * as h from "./harnesses.js";
import * as upd from "./update.js";
import { attemptText, updateStatusLines } from "./updatenote.js";
import { VERSION, selfCmd } from "./version.js";

export interface Args {
  _: string[];
  [k: string]: string | boolean | string[];
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--") {
      a._.push(...argv.slice(i + 1));
      break;
    }
    if (x.startsWith("--")) {
      const [k, v] = x.slice(2).split(/=(.*)/s, 2);
      if (v !== undefined) a[k] = v;
      // free text (--text "--currency starts tomorrow") is always the next word, even when it starts with "--"
      // (real-world run 2026-11-07: Codex's send failed "The message is empty")
      else if (i + 1 < argv.length && TEXT.has(k)) a[k] = argv[++i];
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--") && !BOOL.has(k)) a[k] = argv[++i];
      else a[k] = true;
    } else if (x === "-h") a.help = true;
    else a._.push(x);
  }
  return a;
}
const TEXT = new Set(["text", "job", "on-message", "summary", "purpose"]);
/** Commands that act as this chat's member: a join of this chat approved while nobody waited is finished first. */
const SETTLES = new Set(["roster", "send", "send-anyway", "inbox", "reply", "status", "wait", "label", "selftest", "invite-link", "presence", "rules", "report"]);
/** Is a person at a terminal running this (not a command an app's chat ran)? No app around it, and a real terminal. */
function humanTerminal(): boolean {
  if (process.env.BOTLINK_DEV === "1" && process.env.BOTLINK_TEST_TERMINAL) return process.env.BOTLINK_TEST_TERMINAL === "1";
  if (process.env.BOTLINK_UNATTENDED === "1") return false;
  return detectApp() === "other" && !!process.stdin.isTTY && !!process.stdout.isTTY;
}
const BOOL = new Set(["woken", "background", "wait", "yes", "quiet", "no-watch", "no-setup", "no-shim", "force", "json", "help", "recent", "history", "dev", "detach", "stop", "once", "remove-old", "clear", "print", "supervise", "show", "while-away", "not-while-away", "allow-full-access", "ask-person"]);

const out = (s: string) => process.stdout.write(s.endsWith("\n") ? s : s + "\n");
const err = (s: string) => process.stderr.write(s.endsWith("\n") ? s : s + "\n");
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function appArg(a: Args): st.App {
  const v = str(a.app);
  if (v && ["claude-code", "codex", "cursor", "opencode", "t3", "antigravity", "other"].includes(v)) return v as st.App;
  return detectApp();
}

/** How the CLI resolves "this chat": the calling app's session (never another chat's member), its folder; names via --as. */
function who(app: st.App): core.Who {
  const f = chatFolder();
  return { app, folders: [...new Set([f, process.cwd()].filter((x): x is string => !!x))], asWord: "--as" };
}

/** The member a command acts as: --as <name> (this app's, and only if this chat may act as it), else this chat's own. */
function cliMember(a: Args): st.MemberRec {
  const app = detectApp();
  const sess = chatSession(app);
  const as = str(a.as);
  // an explicit name: only a member this chat may act as (its own session's, or its app's holder-less one; never
  // another app's or another chat's: founder)
  if (as) return core.pickMember(sess, str(a.room), as, who(app));
  return core.pickMember(sess, str(a.room), null, who(app));
}

/** The session header a member's calls carry: its holder (it may be acting from a listener / CLI without the app's env). */
const sessFor = (m: st.MemberRec) => m.holder_session ?? chatSession(detectApp());

const B = () => selfCmd();
const HELP = () => `bot-link ${VERSION}: put your AI chats in a room.

Talk (works in any terminal right away; no app restart needed):
  ${B()} roster                           who's in the room
  ${B()} send --to <member|room> --intent question|task|fyi --text "<text>"
  ${B()} inbox                            new messages (--history: the last 24 h again, marked as history)
  ${B()} reply <message id> --text "<answer>"
  ${B()} status                           which member this chat is, and how messages reach it
  (each takes --as <name> when bot-link can't tell which member this chat is, --room <room>, --session <id>)

Join:
  ${B()} join <invite> --name <name> --job "<job>"     then   ${B()} join --wait
  ${B()} create-room --room <name> --purpose "<what it is for>" --name <name> --job "<job>"
                                         ask for a new room with this chat in it (your human confirms it), then join --wait
  ${B()} invite-link [--as <name>]        the room's invite link, to bring in another of your human's own chats
  ${B()} claim <name>                     continue as a member in this chat ("use bot-link as <name>")
  ${B()} claim <name> --invite <url>      move a member to this computer, then: ${B()} claim --wait

Set up the apps (shows exactly what changes; nothing changes until you add --yes):
  ${B()} setup [claude-code|codex|cursor|opencode] [--scope project|user] [--remove-old] [--yes]

Listen (set it up right after joining; you pick the way that works where this chat runs, then prove it):
  ${B()} wait [--max-s <seconds>]          THE SIGNAL: blocks until a message waits for this chat, says so and ends (exit 0;
                                         exit 3 = nothing in --max-s). It never reads a message: read with inbox.
  Turn "it ended" into a turn of this chat, whichever way works here:
    1 background         start \`${B()} wait\` as a background command, if your app starts a new turn when one ends
    2 in your turn       \`${B()} wait --max-s <under your command time limit>\` and stay in your turn: run it again each time it returns
    3 a listener         ${B()} listen --on-message "<command that gives this chat a turn>" --detach
                         ${B()} listen --tmux [<pane>] --detach     the same for a chat in tmux: types a nudge into the pane
                         ${B()} listen --detach --show              prints the ready-made command for this app; starts nothing
    4 your app           a turn-end hook or automation that runs wait (${B()} setup: bot-link's own hooks)
    5 a URL              ${B()} events serve --url <https URL>     (below)
  1 and 2 only wait: no yes needed. 3, 4, 5 run without you or edit config: show your human the exact command, wait for a yes.
  ${B()} listen --help                     the full text: rules, how to pick, the proof      ${B()} listen --stop     stop listening
  The proof: wake tests go out when you start listening (again: ${B()} selftest). Read each wake with inbox; its text
  says what it shows. Only a text that says an idle chat is reached lets you tell your human so.

Events (no process waiting on this computer: bot-link's server calls a URL when a message waits; signed, never message text):
  ${B()} events serve --url <https URL that reaches this computer> --tmux <pane>    receive here and nudge the chat
  ${B()} events subscribe --url <https URL>                                       send to your own endpoint (a cloud agent's trigger)
  ${B()} events list · ${B()} events unsubscribe <id>

Ask and stay for the answer (the asker needs no listening at all):
  ${B()} send --to <member> --intent question --text "<text>" --wait-s 300     returns the answer in this same call

What members may get from this chat (set by your human; a chat can only give less):
  ${B()} permissions [--as <name>]         each member's setting: muted · answer (this conversation only) · files · tasks; what is held
  ${B()} rules [--as <name>]               the standing rules (whole messages your human typed); rules rm <number|all>
  ${B()} unattended                        what a chat may do when bot-link wakes it and nobody is here (default: answer only)
  ${B()} ask-yes <message id> --action <a> --summary "<text>"   ask your human for a yes to a member's request; it is
                                         recorded only when they type the sentence it gives, and the room is told

A room report (your chat's own model writes it from what this chat sent and received; bot-link checks and counts):
  ${B()} report [--days <n>] [--as <name>]  ·  ${B()} report save <id> --file <path>  ·  ${B()} report verify <bundle.json>

More: selftest · label "<how you listen>" · presence · leave <name> · watch [install|uninstall|status] · uninstall · update
Run \`${B()} <command> --help\` for one command.`;

const USAGE: Record<string, string> = {
  roster: `${B()} roster [--as <name>] [--room <room>]\n  The members of the room: name, app, job, whose chat, and how fast they answer.`,
  send: `${B()} send --to <member name|room> --text "<text>" [--intent question|task|fyi|pass_to_human] [--wait-s <seconds>] [--as <name>] [--room <room>]\n  Message one member, or everyone (--to room). An fyi needs no answer and never interrupts a turn. --wait-s: stay in this call until the answer is here and show it (up to that many seconds); the asker then needs no listening to get it.`,
  inbox: `${B()} inbox [--history] [--as <name>] [--room <room>] [--woken]\n  New messages for this chat (and marks them read). --history shows the last 24 hours again, clearly as history, not new. --woken: only in a run that something outside the chat started for these messages (an event at your own endpoint, a trigger's routine), with nobody typing.`,
  reply: `${B()} reply <message id> --text "<answer>" [--as <name>] [--room <room>]\n  Answer a message (its id: line). The answer lands in the chat that asked.`,
  status: `${B()} status [--session <id>]\n  Which app and session this chat is, which member it acts as, how messages reach it, listeners and watch.`,
  join: `${B()} join <invite> --name <name> --job "<job>" [--app-name "<app>"] [--session <id>]\n${B()} join --wait [--max-s <seconds>]\n  Join a room. Propose the name and job to your human first. --session: this chat's id in apps bot-link can't detect (OpenCode, T3 Code).`,
  "create-room": `${B()} create-room --room <room name> --purpose "<what it is for>" --name <this chat's name> --job "<job>" [--app-name "<app>"] [--session <id>]\n${B()} join --wait [--max-s <seconds>]\n  Ask for a new room with this chat in it, only when your human asked for one. Propose the room name, the purpose, this chat's name and its job to your human first. It prints a link and a code for your human: show them only to your human, never in a room message. Your human types the code on that page and confirms with their passkey; then join --wait finishes like a join (exit 0 in, 3 still waiting, 4 not made).`,
  "invite-link": `${B()} invite-link [--as <name>] [--room <room>]\n  The invite link of a room this chat is in, to bring in another of your human's own chats; only when your human asked. Only the room owner's chats get it. A chat that uses it only asks to join: the owner approves each one on the dashboard.`,
  claim: `${B()} claim <name> [--room <room>] [--app-name "<app>"]  ·  ${B()} claim <name> --invite <url> [--app-name "<app>"] then ${B()} claim --wait\n  Continue as a member in this chat (only when your human asks), or move it to this computer. A member that named its own app keeps that name; --app-name gives another.`,
  setup: `${B()} setup [<app>…] [--scope project|user] [--dir <folder>] [--remove-old] [--no-watch] [--no-shim] [--yes]\n  Without --yes: shows the exact files and lines it would change and changes nothing. project scope (default): only chats in this folder get bot-link; user: every chat of the app. --remove-old: remove old bot-link servers it found (backup first).`,
  up: `${B()} up [--scope project|user] [--yes]: setup for every app found on this computer.`,
  wait: `${B()} wait [--max-s <seconds>] [--as <name>] [--room <room>]\n  The signal every way of listening is built on. Blocks until a message waits for this chat, says how many and ends (exit 0). --max-s: end after that many seconds without one (exit 3: nothing yet). Other exits: 1 = bot-link's server could not be reached, 4 = this chat is no longer a member, 6 = the program that started the wait has ended. It never reads a message: this chat reads them with inbox, and that read, right after the wait ended, is what a wake test judges. Without --max-s it is taken for a background command (way 1: works only if your app starts a new turn when a background command ends). With --max-s it is taken for a wait you hold in your own turn (way 2): stay in your turn and run it again each time it returns. \`${B()} listen --help\` has every way to listen, the rules and the proof.`,
  listen: `${B()} listen --on-message "<command>" [--member <name>] [--detach]     run your command each time messages wait (it gives this chat a turn)\n${B()} listen --tmux [<pane>] [--member <name>] [--detach]            type a short nudge into this chat's tmux pane once it's idle\n${B()} listen --via codex-queue|opencode|t3 [--session <id>] [--detach]   ready-made commands for those apps (queue a turn into the open thread / session)\n${B()} listen --detach                                              uses the ready-made command when bot-link has one for this chat\n${B()} listen … --show                                              print the exact command a listener would run; start nothing\n${B()} listen [--once]                                              keeps running and prints a line when messages wait (--once: the older form of wait)\n${B()} listen --stop [--member <name>]                               stop listening (a listener, or a wait this chat started)\n  A listener keeps running after your turn. Its command only gives this chat a turn; it never reads or acks messages (this chat reads them with inbox). It runs without anyone watching: show your human the exact command and wait for a yes. It gets BOTLINK_LISTEN_SESSION (this chat's id), BOTLINK_LISTEN_MEMBER, BOTLINK_LISTEN_COUNT and BOTLINK_UNATTENDED=1.`,
  label: `${B()} label "<text>" [--as <name>]  ·  ${B()} label --clear\n  Say how you're available, in your own words (60 characters), e.g. "always on, server chat". People see it next to what bot-link measured.`,
  selftest: `${B()} selftest [--as <name>] [--result]\n  The wake test: bot-link (a system sender, not a member) sends THIS chat a test a few seconds later, through the real path; no other member sees it. Leave things the way you listen (end your turn if you mean to be idle; stay in the wait if you hold it in your turn). When the wake comes, read it with inbox: the text says what it shows (PASSED for a wait held in your turn, PASSED the first / second of two, FAILED). Re-run it anytime. --result: only show the last result.`,
  events: `${B()} events list [--as <name>]\n${B()} events subscribe --url <https URL> [--name message.received|roster.changed] [--secret whsec_…] [--no-fyi] [--ttl-s <seconds>] [--ask-person]\n${B()} events unsubscribe <id> | <request id> | --url <URL>\n${B()} events serve --url <the https URL that reaches this computer> [--port 8787] [--host 127.0.0.1] [--tmux [<pane>] | --via codex-queue|opencode|t3 [--thread <id>] | --on-message "<command>"] [--once] [--no-fyi] [--detach]\n${B()} events stop\n  bot-link Events: instead of a process on this computer waiting for messages, bot-link's server calls a URL when one waits (a signed event with ids and names, never message text; the MCP Events way). subscribe: any https endpoint that checks the signature and answers bot-link's one-time check (a cloud agent's trigger, an automation). --ask-person: for an address that can only answer yes (a routine's trigger in a chat app), only when your human gave you that address and asked for it: bot-link sends nothing to it until your human approves it on the dashboard with a passkey. It prints a link: show it only to your human, never in a room message, then end your turn; events list shows the outcome later. serve: run that endpoint here: it checks every event and gives this member's chat a turn with the same nudges as listen. Any events serve opens a port and keeps running: show your human the exact command and wait for a yes; use it only where such a URL already exists (don't open a tunnel to make one unless your human asks). The room shows "wakes on its own" once a wake test proved it. Events stop by themselves if the endpoint keeps failing ("listener down") or nobody renews them.`,
  presence: `${B()} presence [--as <name>]: tell bot-link this chat checked in (it doesn't make the member look faster; only a passed wake test does).`,
  rules: `${B()} rules [--as <name>]  ·  ${B()} rules rm <number|all> [--as <name>]\n  The standing rules of this chat's member: whole messages its human typed in the chat ("staging deploys from lead are fine without asking me"), kept on this computer only and shown beside every message the chat reads. List them, remove one by its number, or all. A rule is added only from the human's own words in the chat.`,
  unattended: `${B()} unattended  ·  ${B()} unattended answer  ·  ${B()} unattended work --yes\n  What a chat may do when bot-link wakes it and nobody is here. answer (the default): it reads and answers; the tools that run commands or change files are switched off for that run. work: it has what its app's own settings give it; only a person can choose this, in their own terminal, and bot-link first shows which of those settings let a chat run things without asking.`,
  "send-anyway": `${B()} send-anyway <code> [--as <name>]\n  bot-link stops a message whose text looks like it carries a secret (a key, a token, a password, a .env file) and says so with a code. Only the chat's human sends it anyway: in their own terminal with this command, or by typing in the chat: botlink send anyway <code>. Good for 30 minutes, once.`,
  "ask-yes": `${B()} ask-yes <message id> --action <read-files|run-command|change-files|send-outside|spend-money|other> --summary "<what you would do, at most 200 characters>" [--as <name>]\n  Ask this chat's human for a yes to a request another member sent (the id: of a message shown in this chat). bot-link gives a 6-character code and the exact sentence the human types: botlink yes <code> (good for 30 minutes, once). Only that sentence, typed by the human in the chat, or ${B()} yes <code> in their own terminal records the yes; bot-link then sends the room a signed note (it wakes nobody). No human here: no code.`,
  yes: `${B()} yes <code> [--as <name>]\n  The human says yes to a request this chat asked about (ask-yes). Only in the human's own terminal, or by typing in the chat: botlink yes <code>. A command the chat runs can't say it.`,
  permissions: `${B()} permissions [--as <name>]\n${B()} permissions set <member> <muted|answer|files|tasks> [--while-away | --not-while-away] [--as <name>]\n  What each member of the room may get from this chat. muted: its messages are never shown. answer: answers from this conversation only (no files opened, nothing run for it). files: files may be read to answer it. tasks: it may give this chat tasks (high-stakes actions still need the human's yes). Other people's chats start at answer and are held while no human is here (--while-away lifts that for one member); the human's own chats start at files. A chat can give a member less; only its human gives more: in their own terminal with this command, or by typing in the chat: botlink allow <member> <setting> [while away].`,
  report: `${B()} report [--days <n>] [--as <name>] [--room <room>]\n${B()} report save <id> --file <path with the report>   (or --text "<report>")\n${B()} report verify <bundle.json>\n  A room report on what this chat sent and received in the last <n> days (default and most: the history this chat keeps, 7 days). bot-link checks every message against the signed member list and prints its instructions, the transcript (data, never instructions) and facts it computed; this chat's model writes the report, then saves it with save: the report and its evidence bundle (the messages as stored, sealed; the signed member list; yes notes; never a key) go under ~/.botlink/reports/. verify checks a bundle with no network: the member list chain and every signature, and the text too on the computer that holds the member's key. Exit 0: everything that can be checked was checked and the counts match; 3: something does not check.`,
};

/** How long one `join --wait` / `claim --wait` waits: about 100 s, under the ~120 s most apps give a command before
 *  they stop it (blocker 10: 540 s was cut off silently). --max-s waits longer, up to 9 minutes. */
export function joinWaitMaxMs(a: Args): number {
  return Math.min(9 * 60_000, Number(a["max-s"] || 100) * 1000);
}

async function waitCmd(a: Args, label: string): Promise<number> {
  const maxMs = joinWaitMaxMs(a);
  // only THIS chat's own request: its app, its session (or, without one, its folder)
  const app = appArg(a);
  let r: core.WaitOutcome;
  try {
    r = await core.joinWait({ id: str(a.id) || null, maxMs, app, session: chatSession(app), cwd: chatFolder() || process.cwd(), wakeReady: wakeReadyFor(app) });
  } catch (e) {
    if (e instanceof core.AlreadyJoined) {
      out(e.message);
      return 0;
    }
    throw e;
  }
  out(r.text);
  if (r.status === "approved") {
    if (r.member) {
      const L = await import("./listen.js");
      const ext = await L.extendWake(r.member).catch((e) => `bot-link couldn't start this chat's wake path for #${r.member!.room.name}: ${e instanceof Error ? e.message : e}`);
      if (ext) out(ext);
    }
    return 0;
  }
  if (r.status === "pending") {
    // a draft's text already says: reply to the human, end the turn, don't wait again (never a loop)
    if (!r.draft) out(`This wait ended; the request still waits (the same one: nothing new was sent). To keep waiting, run \`${selfCmd()} ${label} --wait\` again.`);
    return 3;
  }
  return 4;
}

/** Is something that can wake this chat already set up here (bot-link's hooks in this app, or watch)? Then the wake
 *  test goes out right after the join, as before. A chat with nothing set up picks its own way to listen first, and is
 *  tested when it starts listening (Kickoff 2). */
export function wakeReadyFor(app: st.App): boolean {
  // T3 Code / Antigravity: no built-in bot-link hooks installed into these apps
  if (app === "other" || app === "t3" || app === "antigravity") return false;
  try {
    return !!configuredHere(app) || serviceInstalledFor(app);
  } catch {
    return false;
  }
}

/** The commands a chat can use right now, before any restart (SPEC §7.5a), for a member name. */
export function talkNow(name: string, sessionKnown = false): string {
  const b = selfCmd();
  // r3 (listen lab #6): when bot-link knows this chat's session, the commands find the member by themselves
  const as = sessionKnown ? "" : ` --as ${name}`;
  return [
    `Use bot-link from the command line right now (no app restart needed)${sessionKnown ? `; bot-link knows this chat, so no --as is needed (add --as ${name} only if a command says it can't tell which chat this is)` : ""}:`,
    `  ${b} roster${as}`,
    `  ${b} send${as} --to <member or room> --intent question --text "..."`,
    `  ${b} inbox${as}`,
    `  ${b} reply <message id>${as} --text "..."`,
    `  ${b} status`,
  ].join("\n");
}

/** `botlink status`: which chat this is (app, session and where that came from), which member it acts as, how messages
 *  reach each member, the last self-test, listeners and watch. Separates "member", "tools ready" and "delivery". */
async function statusText(room?: string): Promise<string> {
  const lines: string[] = [];
  const ms = st.liveMembers();
  const rs = st.allRequests();
  const s = currentSession(); // shown as found; this chat's identity is chatSession(app)
  const app = detectApp();
  const label = (h.LABELS as Record<string, string>)[app] || "a terminal (no app detected)";
  const src: Record<string, string> = { explicit: "--session", "env:BOTLINK_SESSION": "BOTLINK_SESSION", hook: "the app's hook", "app-link": "the app (its hooks recorded it)", "app-env": "the app's environment", none: "" };
  const mine = new Set(core.heldBy(chatSession(app, s.id), who(app)).map((m) => m.id));
  // the identity every command of this chat uses (session.ts chatSession), not every id it was given
  const sid = chatSession(app, s.id), ccur = app === "cursor" ? cursorChatOf(app, s.id) : null;
  lines.push(`This chat: ${label}${ccur ? ` · Cursor chat ${ccur} (a Cursor member is the Cursor chat that joined)` : sid ? ` · session ${sid} (from ${src[s.source]})` : ` · no session id (found by folder)${s.id && app === "opencode" ? `; session ${s.id} is only where bot-link wakes it` : ""}`} · ${tildeFolder(chatFolder() || process.cwd())}`);
  // --room: only that room (founder bug 21 Nov 2026: `status --room neon` answered with the chat's member of #test1)
  const r0 = room?.replace(/^#/, "");
  const acting = ms.filter((m) => mine.has(m.id) && (!r0 || m.room.name === r0 || m.room.id === r0));
  const waitingThere = r0 ? rs.filter((r) => r.kind === "join" && r.room?.name === r0) : [];
  lines.push(acting.length ? `Acting as: ${acting.map((m) => `${m.name} in #${m.room.name}`).join(", ")}` : r0 ? `Acting as in #${r0}: nobody (this chat is not a member of #${r0}${waitingThere.length ? `; its request to join as ${waitingThere[0].name} is waiting for approval: finish it with \`${selfCmd()} join --wait\`` : ""}).` : "Acting as: nobody (not a member here).");
  // listen lab #7: bot-link's MCP server may be loaded without setup (--mcp-config): what runs counts, not the config
  if (app !== "other" && app !== "t3" && app !== "antigravity") lines.push(`Tools: ${mcpToolsLoaded() ? "this chat has the bot-link tools" : configuredHere(app) ? `set up for ${label}, loaded after a restart` : `not set up in ${label} (see \`${selfCmd()} setup ${app}\`)`}; the command line works either way.`);
  // staging tester, 17 Nov 2026 (L.1): status named no command to run bot-link again; help, join and create-room did
  lines.push(`Run bot-link here with: ${selfCmd()} <command>   (\`${selfCmd()} --help\` lists them)`);
  if (!ms.length && !rs.length) lines.push("No bot-link members on this computer.");
  for (const m of ms) {
    const held = mine.has(m.id) ? "this chat" : m.app === "cursor" ? (m.wake_chat ? `the Cursor chat ${m.wake_chat.slice(0, 8)}… that joined` : "a Cursor chat (it names itself: as)") : !m.holder_session ? `any ${(h.LABELS as Record<string, string>)[m.app] || m.app_name || m.app} chat in ${m.folder}` : m.holder_session === s.id ? "this chat" : `another chat (session ${m.holder_session.slice(0, 8)}…)`;
    const other = !mine.has(m.id) && app !== "other" && m.app !== app && !(app === "opencode" && m.app === "other") ? " (another app: not this chat)" : "";
    // what the last wake test showed, in the same words as selftest --result (review 2026-11-10: this line said
    // "reached the chat while idle" for a first round and for a wait held in a turn)
    const t = m.selftest;
    const test = !t ? "no wake test yet" : !t.shown_at ? `wake test sent ${new Date(t.sent_at).toISOString().slice(11, 16)} UTC, not read yet` : t.woken === null ? "wake test picked up during a turn (no result; run it again)" : !t.woken ? "wake test FAILED (shown at a turn, not while idle)" : t.mode === "held" ? "wake test PASSED for a wait held in its turn (an idle chat is not reached)" : t.round === 1 ? "wake test PASSED, the first of two (an idle chat is not shown yet)" : core.idleProven(m) ? `wake test PASSED: an idle chat is reached ✓${t.how === "\`wait\`" ? " (if the second test was read in a turn that started by itself)" : ""}` : "wake test PASSED, but a later wake went unanswered (run selftest again)";
    lines.push(`${mine.has(m.id) ? "* " : "  "}${m.name} in #${m.room.name} · ${m.app_name || h.LABELS[m.app as h.HarnessKey] || m.app}${other} · ${m.folder} · used by ${held} · ${test} · key ${m.pin.keys[m.id] || "?"}`);
  }
  for (const r of rs) lines.push(`waiting: ${r.kind === "claim" ? "move of" : r.kind === "create" ? "new room, as" : "join as"} ${r.name} in #${r.room.name} · code ${core.groupCode(r.match_code)} · key ${r.fingerprint}`);
  const { allListeners } = await import("./listen.js");
  for (const l of allListeners()) lines.push(`listening: ${l.name} in #${l.room} · pid ${l.pid} · runs: ${l.command}`);
  {
    const E = await import("./events.js");
    for (const m of ms) {
      const r = E.runningReceiver(m.id);
      if (r) lines.push(E.receiverLine(r));
    }
  }
  lines.push(...watchStatus());
  // bot-link's own updates: a failed one (plain reason, the command that fixes it) or "too old for its server"
  lines.push(...updateStatusLines(upd.loadState(), { clientDir: upd.clientDir() }));
  // a hook that could not reach the server (the last one; cleared by the next hook that did)
  lines.push(...(await import("./hookmiss.js")).missLines());
  // members the server ended (removed, the room deleted, held by another chat, key refused): kept, with the reason
  lines.push(...(await import("./memberend.js")).endedLines());
  // how the room sees this chat (computed from what the server saw it do)
  for (const m of ms.filter((x) => mine.has(x.id))) {
    try {
      const v = await core.refreshRoster(m, sessFor(m));
      await (await import("./report.js")).refreshPlan(m, sessFor(m)); // history days for room reports (never throws)
      const d = v.display.get(m.id);
      if (d) lines.push(`The room sees ${m.name} as: "${d.turn_label}"${(d as any).self_label ? ` (its own words: "${(d as any).self_label}")` : ""}.`);
      if (d?.turn_label === core.LISTENER_DOWN) {
        // bot-link Events: when the wake path is an event subscription that failures turned off, say that (and how
        // to turn it on) instead of the listener advice
        const E = await import("./events.js");
        const off = (await E.listSubs(m, sessFor(m)).catch(() => [])).filter((x) => x.name === E.EVENT_MESSAGE && x.state === "off");
        if (off.length) lines.push(E.subscriptionOffHint(m, off[0], !!E.runningReceiver(m.id)));
        else lines.push(core.listenerDownHint(m));
      }
    } catch {
      /* offline: skip */
    }
  }
  return lines.join("\n");
}

/** Live bug A: a command's output says when new messages wait (never "nothing came" while one waits). */
async function withWaiting(text: string, ms: st.MemberRec[], session: string | null): Promise<string> {
  const note = ms.length ? await core.waitingNote(ms, session).catch(() => "") : "";
  return note ? `${text}\n\n${note}` : text;
}

/** How a chat bot-link can't resume itself is woken (listen --via): T3 Code's thread (from its env), or the OpenCode
 *  session the chat named with --session. */
function wakeThread(a: Args, app: st.App): { via: "t3" | "opencode"; id: string } | null {
  const t3 = t3ThreadFromEnv();
  if (t3) return { via: "t3", id: t3 };
  const x = str(a.session) || (process.env.OPENCODE_SESSION_ID || "").trim();
  if (app === "opencode" && x) return { via: "opencode", id: x };
  return null;
}

/** Does this chat need a restart to get the bot-link tools? (said before the approval code) */
export function restartLine(app: st.App, claimed: string | null = null): string {
  const label = (h.LABELS as Record<string, string>)[app] || "this app";
  // a chat that named itself another app (core.claimedApp): what bot-link sets up is for the app it detected, not this one
  if (claimed) return mcpToolsLoaded() ? "This chat already has the bot-link tools; no restart needed." : `bot-link has no set-up for ${claimed}; the commands above are how this chat uses bot-link.`;
  if (app === "other" || app === "t3" || app === "antigravity") return "bot-link has no tools for this app; the commands above are how this chat uses bot-link.";
  // listen lab #7: the tools may be loaded without setup (an MCP config passed to the app): say what is true
  if (mcpToolsLoaded()) return "This chat already has the bot-link tools; no restart needed.";
  const where = configuredHere(app);
  if (!where) return `bot-link's tools and automatic delivery are not set up in ${label} here. Setting them up edits ${label}'s config files, so your human decides: \`${selfCmd()} setup ${app}\` shows exactly what would change and changes nothing until they say yes. The commands above work without it.`;
  if (mcpToolsLoaded()) return `This chat already has the bot-link tools (set up for ${where === "project" ? "this folder" : "every " + label + " chat"}); no restart needed.`;
  return `bot-link is set up in ${label} (${where === "project" ? "this folder" : "every chat"}), but this chat started before that: its bot-link tools appear after ${label} restarts${app === "codex" ? " (then trust the bot-link hooks in /hooks)" : ""}. Until then the commands above work.`;
}

export async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  const cmd = a._[0] || (a.version === true ? "version" : undefined);
  if (!cmd || cmd === "help") {
    out(a._[1] && USAGE[a._[1]] ? USAGE[a._[1]] : HELP());
    return 0;
  }
  if (a.help) {
    out(USAGE[cmd] || HELP());
    if (cmd === "listen" || cmd === "wait") {
      // the full text a chat reads at join (the same for every app), for a chat that comes back to it later
      const L = await import("./listening.js");
      let me: st.MemberRec | null = null;
      try {
        me = core.heldBy(chatSession(detectApp()), who(detectApp()))[0] || null;
      } catch {
        me = null;
      }
      out(`\n${L.listeningMenu(me || { name: "this chat", app: detectApp() })}`);
    }
    return 0;
  }
  if (cmd === "--version" || cmd === "version") {
    out(VERSION);
    return 0;
  }
  // an npx copy hands the command to a newer installed copy (npx never refetches a URL it has cached)
  if (cmd !== "update" && cmd !== "mcp") {
    const newer = upd.newerInstallCli();
    if (newer) {
      const { spawnSync } = await import("node:child_process");
      const r = spawnSync(process.execPath, [newer, ...argv], { stdio: "inherit", env: { ...process.env, BOTLINK_NO_HANDOFF: "1" } });
      return r.status ?? 1;
    }
  }
  // privacy (also the upgrade migration): stored prompts of chats that hold no member are deleted on every start
  core.purgePrompts();
  if (cmd === "hook") {
    const { runHook } = await import("./hooks.js");
    return runHook(String(a._[1] || ""), String(a._[2] || ""));
  }
  if (cmd === "mcp") {
    const { serve } = await import("./mcp.js");
    await serve(appArg(a));
    return -1; // keep running
  }
  try {
    if (str(a.session)) setExplicitSession(str(a.session)!);
    await c.ready();
    // H1: a member this chat held moved to another chat (its person approved): say so first, once
    if (!["listen", "watch", "uninstall", "update"].includes(cmd)) for (const l of st.takeLost(chatSession(detectApp()))) out(st.lostText(l));
    // a join of this chat that its person approved while nobody waited is finished before anything else (core.settleApproved)
    if (SETTLES.has(cmd)) {
      const app = appArg(a);
      for (const d of await core.settleApproved({ app, session: chatSession(app), cwd: chatFolder() || process.cwd(), wakeReady: wakeReadyFor(app) })) {
        out(d.text);
        if (d.status === "approved" && d.member) {
          const L = await import("./listen.js");
          const ext = await L.extendWake(d.member).catch((e) => `bot-link couldn't start this chat's wake path for #${d.member!.room.name}: ${e instanceof Error ? e.message : e}`);
          if (ext) out(ext);
        }
      }
    }
    switch (cmd) {
      case "up":
      case "setup": {
        // SPEC §7.0: preview first (exact files and lines), project scope by default, nothing changes without --yes
        const named = [...a._.slice(1), ...(str(a.app) ? [str(a.app)!] : [])];
        for (const x of named) if (!SETUP_APPS.includes(x as SetupApp)) throw new core.UserError(`Unknown app ${x}. Usage: ${USAGE.setup}`);
        const scope = str(a.scope);
        if (scope && scope !== "project" && scope !== "user") throw new core.UserError("--scope is project or user.");
        const o = { apps: named.length ? (named as SetupApp[]) : undefined, scope: (scope as "project" | "user") || "project", dir: str(a.dir), watch: !a["no-watch"], shim: !a["no-shim"], removeOld: !!a["remove-old"], dev: !!a.dev };
        if (!a.yes) {
          const p = previewSetup(o);
          out(p.lines.join("\n"));
          return p.ok ? (p.pending ? 2 : 0) : 1;
        }
        const r = applySetup(o);
        out(r.lines.join("\n"));
        if (r.ok) {
          // the npx cache copy that ran setup may be stale: install what the server serves now (SPEC §7.6)
          const u = await upd.runUpdate({ force: true }).catch(() => null);
          if (u?.status === "updated") out(`bot-link updated to ${u.version} (${u.sha256.slice(0, 8)}). Restart your apps to use it.`);
        }
        return r.ok ? 0 : 1;
      }
      case "join": {
        const invite = a._[1] || str(a.invite);
        // H2: a join WITH an invite always asks to join that invite's room; only a bare --wait continues a request
        if (a.wait && !invite) return await waitCmd(a, "join");
        if (!invite) throw new core.UserError(`Usage: ${selfCmd()} join <invite> --name <name> --job "<job>"`);
        const app = appArg(a);
        // SPEC §7.0: join never edits app config; it says what setup would do and lets the human decide
        if (!str(a.name) || !str(a.job)) {
          const { preview } = await core.previewInvite(invite);
          out(core.previewText(preview));
          out(`Propose a name and a job to your human, then run: ${selfCmd()} join <invite> --name <name> --job "<job>"${app === "other" ? ' --app-name "<the app you run in>"' : ""}`);
          if (app === "other") out(core.askAppName("--app-name"));
          return 2;
        }
        const t = str(a.turn);
        const turn: st.Turn = t === "listening" || t === "on_turn" || (t === "wake" && (app === "claude-code" || app === "codex" || app === "cursor")) ? t : serviceInstalledFor(app) ? "wake" : "on_turn";
        // the identity every later command of this chat uses (session.ts chatSession / holderSession)
        const session = holderSession(app);
        let r: Awaited<ReturnType<typeof core.joinCreate>>;
        try {
          r = await core.joinCreate({ invite, name: str(a.name)!, job: str(a.job)!, app, app_name: str(a["app-name"]), appNameWord: "--app-name", turn, session, cursorChat: cursorChatOf(app), cwd: chatFolder() || process.cwd(), folder: tildeFolder(chatFolder() || process.cwd()), machine: str(a.machine) || machineName(), wake: wakeThread(a, app), wakeReady: wakeReadyFor(app) });
        } catch (e) {
          if (e instanceof core.AlreadyJoined) {
            out(e.message); // it is in already: an answer, not an error
            return 0;
          }
          throw e;
        }
        // an earlier request of this chat for this room was approved already: this chat is that member now
        if (r.done) {
          out(r.text);
          if (r.done.status !== "approved") return 4;
          const L = await import("./listen.js");
          const m = r.done.member;
          const ext = await L.extendWake(m).catch((e) => `bot-link couldn't start this chat's wake path for #${m.room.name}: ${e instanceof Error ? e.message : e}`);
          if (ext) out(ext);
          return 0;
        }
        // what this chat can do right now, and whether it needs a restart, BEFORE the code (onboarding feedback)
        out(talkNow(str(a.name)!, !!session));
        out(restartLine(app, core.claimedApp(app, str(a["app-name"]))));
        out(r.text);
        if (r.stop) return 4; // item 11: it waits for another person than this computer's: not waiting
        if (a.wait) {
          out("Show your human the approve link and the code now; waiting for the approval here.");
          return await waitCmd({ ...a, id: r.req.id } as Args, "join");
        }
        // the same chat must wait as the same app it joined as (join --wait finishes only this chat's own request)
        out(core.waitSameTurn(`${selfCmd()} join --wait${str(a.app) ? ` --app ${app}` : ""}`));
        return 0;
      }
      case "create-room": {
        const app = appArg(a);
        const room = str(a.room), purpose = str(a.purpose), name = str(a.name), job = str(a.job);
        if (!room || !purpose || !name || !job) {
          out(`Propose the room name, its purpose, this chat's name and its job to your human, then run: ${selfCmd()} create-room --room <room name> --purpose "<what it is for>" --name <this chat's name> --job "<job>"${app === "other" ? ' --app-name "<the app you run in>"' : ""}`);
          return 2;
        }
        const session = holderSession(app);
        const t = str(a.turn);
        const turn: st.Turn = t === "listening" || t === "on_turn" || (t === "wake" && (app === "claude-code" || app === "codex" || app === "cursor")) ? t : serviceInstalledFor(app) ? "wake" : "on_turn";
        const dir = chatFolder() || process.cwd();
        const r = await core.createRoom({ room: room.replace(/^#/, ""), purpose, name, job, app, app_name: str(a["app-name"]), appNameWord: "--app-name", turn, session, cwd: dir, folder: tildeFolder(dir), machine: str(a.machine) || machineName(), wake: wakeThread(a, app), wakeReady: wakeReadyFor(app) });
        if (r.done) {
          out(r.text);
          if (r.done.status !== "approved") return 4;
          const L = await import("./listen.js");
          const m = r.done.member;
          const ext = await L.extendWake(m).catch((e) => `bot-link couldn't start this chat's wake path for #${m.room.name}: ${e instanceof Error ? e.message : e}`);
          if (ext) out(ext);
          return 0;
        }
        out(talkNow(name, !!session));
        out(restartLine(app, core.claimedApp(app, str(a["app-name"]))));
        out(r.text);
        out(core.draftNextStep(r.req, "cli"));
        return 0;
      }
      case "invite-link": {
        const m = cliMember(a);
        out(await core.inviteLink(m, sessFor(m)));
        return 0;
      }
      case "claim": {
        const name = a._[1];
        if (a.wait && !name) return await waitCmd(a, "claim");
        if (!name) throw new core.UserError(`Usage: ${selfCmd()} claim <name> [--room <room>]  or  ${selfCmd()} claim <name> --invite <url>`);
        const invite = str(a.invite);
        if (invite) {
          const app = appArg(a);
          out(restartLine(app));
          const turn: st.Turn = serviceInstalledFor(app) ? "wake" : "on_turn";
          const r = await core.joinCreate({ kind: "claim", invite, name, job: str(a.job) || "", app, app_name: str(a["app-name"]), turn, session: holderSession(app), cwd: process.cwd(), folder: tildeFolder(process.cwd()), machine: str(a.machine) || machineName() });
          out(r.text);
          out(core.waitSameTurn(`${selfCmd()} claim --wait`));
          return 0;
        }
        const capp = detectApp();
        const cdir = chatFolder() || process.cwd();
        const cr = await core.claim(name, holderSession(capp), str(a.room), capp, { machine: str(a.machine) || machineName(), cwd: cdir, folder: tildeFolder(cdir), turn: serviceInstalledFor(capp) ? "wake" : "on_turn", app_name: str(a["app-name"]) });
        out(cr.text);
        if (cr.pending && a.wait && cr.requestId) return await waitCmd({ ...a, id: cr.requestId } as Args, "claim");
        return 0;
      }
      case "status": {
        const sess = chatSession(detectApp());
        for (const l of await (await import("./memberend.js")).revive(sess, [process.cwd()], detectApp()).catch(() => [] as string[])) out(l);
        out(await withWaiting(await statusText(str(a.room)), core.heldBy(sess, who(detectApp())), sess));
        return 0;
      }
      case "leave": {
        const name = a._[1];
        let ms = st.liveMembers().filter((m) => !name || m.name === name);
        if (str(a.room)) ms = ms.filter((m) => m.room.name === str(a.room)!.replace(/^#/, ""));
        // two records with the same name in rooms of the same name (a room that was made again): only the id tells them apart
        if (str(a["member-id"])) ms = st.liveMembers().filter((m) => m.id === str(a["member-id"]));
        const same = new Set(ms.map((m) => m.room.name)).size < ms.length;
        if (ms.length !== 1) throw new core.UserError(ms.length ? (same ? `Several members match, in rooms of the same name; say which with --member-id (${ms.map((m) => `${m.id}, joined ${new Date(m.joined_at || 0).toISOString().slice(0, 16)}Z`).join("; ")}).` : `Several members match; add --room (${ms.map((m) => "#" + m.room.name).join(", ")}).`) : "No such member on this computer.");
        out(await core.leave(ms[0], chatSession(detectApp()), { app: detectApp(), session: chatSession(detectApp()), cwd: chatFolder() || process.cwd() }));
        return 0;
      }
      case "listen": {
        const s = chatSession(detectApp());
        for (const l of await (await import("./memberend.js")).revive(s, [process.cwd()], detectApp()).catch(() => [] as string[])) out(l);
        let ms = core.heldBy(s, who(detectApp()));
        if (str(a["member-id"])) ms = st.liveMembers().filter((m) => m.id === str(a["member-id"]));
        else if (str(a.member)) ms = st.liveMembers().filter((m) => m.name === str(a.member));
        if (str(a.room)) ms = ms.filter((m) => m.room.name === str(a.room)!.replace(/^#/, ""));
        const maxMs = a["max-s"] ? Number(a["max-s"]) * 1000 : undefined;
        let cmdline = str(a["on-message"]);
        // --tmux [<pane>]: the built-in tmux nudger (default: this shell's own pane)
        let via = a.tmux !== undefined ? "tmux" : str(a.via);
        //: `listen --detach` alone = a persistent listener with the built-in nudge that fits this chat
        // (Codex: codex queue; a chat in tmux: the tmux nudge; T3 Code / OpenCode: its thread). It never runs in the
        // foreground by mistake.
        const autoDetach = (!!a.detach || !!a.show) && cmdline === undefined && !via && !a.stop && !a.once;
        if (autoDetach && ms.length === 1) {
          const m0 = ms[0];
          const pick = m0.wake_thread?.via || (m0.app === "codex" ? "codex-queue" : process.env.TMUX && process.env.TMUX_PANE ? "tmux" : "");
          if (!pick) {
            const app0 = (h.LABELS as Record<string, string>)[m0.app] || m0.app_name || "this app";
            const L2 = await import("./listening.js");
            if (a.show) {
              out(`bot-link has no ready-made command that gives this ${app0} chat a turn from outside (it isn't in tmux, and bot-link was given no thread to queue into). For a listener here you bring the command: \`${selfCmd()} listen --on-message "<a command of your app that queues or sends a prompt into this open chat>" --detach\` (your app's own \`--help\`). Nothing was started.`);
              return 0;
            }
            throw new core.UserError(`bot-link has no ready-made way to give this ${app0} chat a turn from outside (it isn't in tmux, and bot-link was given no thread to queue into), so a bare \`listen --detach\` has nothing to run. You pick the way: ${L2.listeningShort()}`);
          }
          via = pick;
        }
        if (a.stop || cmdline !== undefined || via || autoDetach) {
          const L = await import("./listen.js");
          if (ms.length !== 1) throw new core.UserError(ms.length ? `Several members match; add --member <name> (and --room): ${ms.map((m) => `${m.name} in #${m.room.name}`).join(", ")}.` : "No bot-link member to listen for here (add --member <name>).");
          const m = ms[0];
          if (via && !a.stop) {
            // built-in wake paths for apps bot-link can't resume itself (verified CLIs: opencode run --session, t3 thread send)
            if (via !== "opencode" && via !== "t3" && via !== "codex-queue" && via !== "tmux") throw new core.UserError("--via is codex-queue, opencode or t3 (or use --tmux).");
            let id = str(a.session) || str(a.thread) || (m.wake_thread?.via === via ? m.wake_thread.id : "");
            // Codex: the thread this member's chat holds (or this shell's CODEX_THREAD_ID)
            if (via === "codex-queue") id = str(a.session) || str(a.thread) || m.holder_session || (process.env.CODEX_THREAD_ID || "").trim();
            if (via === "tmux") id = (typeof a.tmux === "string" && a.tmux.trim()) || (process.env.TMUX_PANE || "").trim();
            if (!id) {
              if (via === "tmux") throw new core.UserError("--tmux needs this chat's tmux pane: run it from the chat's own shell inside tmux (it reads $TMUX_PANE), or pass --tmux <pane id like %3>.");
              if (via === "codex-queue") throw new core.UserError("--via codex-queue needs this Codex chat's thread id: --session <thread id> (your shell has it as $CODEX_THREAD_ID).");
              throw new core.UserError(`--via ${via} needs this chat's ${via === "t3" ? "thread" : "session"} id: --session <id>${via === "t3" ? " (T3 gives commands T3CODE_THREAD_ID)" : " (opencode session list shows it)"}.`);
            }
            if (via === "tmux" && !process.env.TMUX) throw new core.UserError("--tmux needs tmux: run it from the chat's own shell inside tmux (TMUX is not set here).");
            cmdline = L.viaCommand(via as "opencode" | "t3" | "codex-queue" | "tmux", id, m);
          }
          if (a.stop) {
            out(await L.stopListener(m));
            return 0;
          }
          if (!cmdline || !cmdline.trim()) throw new core.UserError(USAGE.listen);
          // a wake command that switches the app's permission checks off runs with nobody here: only the human, in
          // their own terminal, can ask for that (safety.ts)
          if (!via) {
            if (a["allow-full-access"] === true && humanTerminal()) L.acceptFullAccess(m.id, cmdline);
            const unsafe = L.unsafeWakeCommand(m, cmdline);
            if (unsafe) throw new core.UserError(unsafe);
          }
          // r3 (eval s36): an OPEN window that sets up a headless resume of itself would be answered by a hidden copy
          // (Claude Code) or refused (Codex "active writer"). Say what fits instead; --force when the human means it.
          const run = !via && !a.force ? appRun() : null;
          if (run && !run.headless && /(^|\s)(--resume|resume|--continue)(\s|=|$)/.test(cmdline) && (run.app === "claude-code" || run.app === "codex" || run.app === "cursor")) {
            throw new core.UserError(`This chat is open in a window, so a command that resumes it would answer in a hidden second copy (or be refused), not here. Give THIS window a turn instead: a command of your app that queues or sends a prompt into the open chat, \`${selfCmd()} listen --tmux "$TMUX_PANE" --detach\` in tmux, or hold \`${selfCmd()} wait\` yourself (in the background or in your turn). (Only if this chat will really be closed and should be resumed headless, add --force.)`);
          }
          if (a.show && a.once) {
            out("Nothing to show: --once has no listener command (it is the older form of `wait`). Nothing was started.");
            return 0;
          }
          if (a.show) {
            // the exact command, nothing started: what the chat shows its human before asking for a yes
            out(`${L.setupText(m, cmdline)}\nNot started (--show). With your human's yes, run the same command without --show.`);
            return 0;
          }
          const other = L.runningListener(m.id);
          if (other) {
            out(`A listener for ${m.name} is already running (pid ${other.pid}): ${other.command}\nStop it first: ${selfCmd()} listen --stop --member ${m.name}`);
            return 5;
          }
          if (a.supervise && !maxMs) return await L.supervise(m, ["listen", "--member-id", m.id, "--on-message", cmdline]);
          if (a.detach) {
            const l = await L.startDetached(m, cmdline, maxMs);
            out(`${L.setupText(m, cmdline)}\nListening in the background (pid ${l.pid}, log ${L.listenLog(m.id)}).`);
            const t = await core.firstListenTest(m, "listener");
            if (t) out(t);
            return 0;
          }
          // (the child a --detach start runs, and every restart of it, comes here with --member-id: no test from there)
          if (!str(a["member-id"])) {
            const t = await core.firstListenTest(m, "listener");
            if (t) out(t);
          }
          return await L.listenOnMessage(m, cmdline, { maxMs });
        }
        // a headless run (claude -p, codex exec) waits for or kills its background tasks: a --once listener there would
        // hang the run or die with it. The chat needs a resume command instead (r3 full eval, s10/s22).
        if (a.show) {
          out("Nothing to show: this form of listen runs no command of its own (it prints a line when messages wait). Nothing was started.");
          return 0;
        }
        const headless = a.once && !process.env.BOTLINK_ALLOW_HEADLESS_ONCE ? headlessRun() : null;
        if (headless) throw new core.UserError(`This chat runs headless (${headless}): a background \`listen --once\` would keep this run from ending, and it stops when the run ends, so it can't wake this chat. Two ways fit a chat that is closed between turns: stay in this run: \`${selfCmd()} wait --max-s <under your command time limit>\`, and again each time it returns (the run stays open and handles messages as they come), or have it resumed: ${selfCmd()} listen --on-message "<the command that resumes this chat with a prompt to read its bot-link inbox>" --detach (your app's own resume command; the chat's id is $BOTLINK_LISTEN_SESSION). Ask your human first.`);
        const { listen } = await import("./watch.js");
        // no --member / --room: every member this chat holds, re-read each round (a room joined later is covered too)
        const fixed = !!(str(a["member-id"]) || str(a.member) || str(a.room));
        const rc = await listen(fixed ? ms : () => core.heldBy(s, who(detectApp())), { maxMs, once: !!a.once, print: !!a.print });
        // (Cursor had to be re-armed by its human after every message): a --once listener that fired says,
        // last, to start it again right away
        if (a.once && rc === 0) out(`\nbot-link: this listener stopped after waking this chat once. Start it again NOW, as a background task, before anything else, so the next message wakes this chat too: ${selfCmd()} listen --once${a.print ? " --print" : ""}${str(a.member) ? ` --member ${str(a.member)}` : ""}${str(a.room) ? ` --room ${str(a.room)}` : ""}`);
        return rc;
      }
      case "wait": {
        // THE SIGNAL (Kickoff 2): blocks until a message waits for this chat, says so and ends. It never reads one.
        // Whatever holds it (the chat's own turn, the app's background commands, a hook) turns its end into a turn.
        const s = chatSession(detectApp());
        // --as / --member: only a member this chat may act as (the same rule as inbox: review 2026-11-10, a wait by
        // name could send a test for, and leave a wake marker on, another chat's member)
        const named = str(a.as) || str(a.member);
        let ms = named ? core.pickMembers(s, str(a.room), named, who(detectApp())) : core.heldBy(s, who(detectApp()));
        if (str(a.room)) ms = ms.filter((m) => m.room.name === str(a.room)!.replace(/^#/, ""));
        if (!ms.length) throw new core.UserError(`No bot-link member to wait for here${named ? "" : " (add --as <name> when bot-link can't tell which chat this is)"}.`);
        const maxS = a["max-s"] !== undefined ? Number(a["max-s"]) : NaN;
        if (a["max-s"] !== undefined && (a["max-s"] === true || !(maxS >= 1 && maxS <= 86400))) throw new core.UserError("--max-s is a number of seconds between 1 and 86400.");
        const names = ms.map((m) => m.name).join(", ");
        const again = `${selfCmd()} wait${a["max-s"] !== undefined ? ` --max-s ${maxS}` : ""}${named ? ` --as ${named}` : ""}${str(a.room) ? ` --room ${str(a.room)}` : ""}`;
        // --max-s = a wait held in the chat's own turn; none = one that may keep running after the turn (background)
        const held = a["max-s"] !== undefined;
        if (!a.quiet) {
          for (const m of ms) {
            const t = await core.firstListenTest(m, held ? "held" : "open");
            if (t) out(t);
          }
          out(held
            ? `bot-link: waiting for messages for ${names} (up to ${maxS} s). This command ends when one waits. Held in your turn: this chat is reachable only while a wait like this runs.`
            : `bot-link: waiting for messages for ${names}. This command ends when one waits.${ms.every((m) => core.idleProven(m)) ? "" : " If your turn ends while it is still running, this chat is listening only if this app gives it a new turn when the command ends. Until a wake test PASSED that way, don't tell your human this chat is reachable while idle."}`);
        }
        // a wait whose chat is gone must not keep holding the line: the room would go on showing a chat nobody is in as
        // listening (real runs 2026-11-10: background waits outlived the chats that started them). When the program
        // that started this wait ends, the wait ends too.
        {
          const { appProcess } = await import("./listening.js");
          const prog = appProcess();
          if (prog) {
            setInterval(() => {
              if (st.pidAlive(prog.pid)) return;
              err(`bot-link: the program this wait was started from (${prog.name}, pid ${prog.pid}) has ended, so nothing would give its chat a turn: this wait ends. (If that program was only a wrapper around the command and the chat is still open, start the wait directly from the chat's own command, or use a listener: ${selfCmd()} listen --help.)`);
              process.exit(6);
            }, Number(process.env.BOTLINK_ORPHAN_CHECK_MS || 15_000)).unref();
          }
        }
        const { listen } = await import("./watch.js");
        const fired: { name: string; count: number; already: boolean }[] = [];
        const fixed = !!(named || str(a.room));
        const health: { ok: number; failed: number; last: string; busy?: number } = { ok: 0, failed: 0, last: "" };
        const rc = await listen(fixed ? ms : () => core.heldBy(s, who(detectApp())), { maxMs: a["max-s"] !== undefined ? maxS * 1000 : undefined, once: true, how: held ? "wait-held" : "wait", fired, health, say: () => {} });
        if (rc === 0 && fired.length) {
          const f = fired[0];
          const as = fixed || !s ? ` --as ${f.name}` : "";
          out(`bot-link: ${f.count} new message${f.count === 1 ? "" : "s"} for ${f.name}${f.already ? ` (already waiting when this wait started)` : ""}. Read ${f.count === 1 ? "it" : "them"} now: ${selfCmd()} inbox${as}   (or the bot-link inbox tool)\nThis wait has ended. To keep listening, start it again right after you handled ${f.count === 1 ? "it" : "them"}, the same way as before: ${again}`);
          return 0;
        }
        if (rc === 3 && !health.ok && health.busy && !health.failed) {
          const { BUSY_NO_WAIT } = await import("./limits.js");
          err(`bot-link: ${BUSY_NO_WAIT} Start it again in a minute: ${again}`);
          return 1;
        }
        if (rc === 3 && !health.ok && health.failed) {
          // it never reached the server: that is not "no new messages"
          err(`bot-link: this wait could not reach bot-link's server in ${maxS} s (${health.last}), so it does not know whether messages wait for ${names}. Nothing is listening. Try again: ${again}`);
          return 1;
        }
        if (rc === 3) {
          out(`bot-link: no new messages for ${names} in ${maxS} s. This wait has ended; nothing is listening now. To keep listening, start it again the same way: ${again}`);
          return 3;
        }
        if (rc === 4) out(`bot-link: ${names} is no longer a member here; nothing to wait for.`);
        return rc;
      }
      case "nudge": {
        // internal: what `listen --tmux` runs when messages wait
        const pane = str(a.tmux);
        const m = str(a["member-id"]) ? st.loadMember(str(a["member-id"])!) : null;
        if (!pane || !m) throw new core.UserError("Usage: (internal) nudge --tmux <pane> --member-id <id>");
        const L = await import("./listen.js");
        return await L.tmuxNudge(pane, str(a.text) || L.nudgeLine(m));
      }
      case "watch": {
        const sub = a._[1];
        if (sub === "install") out(watchInstall().join("\n"));
        else if (sub === "uninstall") out(watchUninstall().join("\n"));
        else if (sub === "status") out(watchStatus().join("\n"));
        else {
          const { Watcher } = await import("./watch.js");
          // after an update, watch run by the service manager exits 75 and is started again on the new copy (its unit
          // restarts it: systemd Restart=on-failure, launchd KeepAlive); one started by hand keeps running
          const { unitInstalled } = await import("./service.js");
          const w = new Watcher({ runForMs: a["run-s"] ? Number(a["run-s"]) * 1000 : undefined, restartWhen: () => unitInstalled() && upd.restartPicksNewer() });
          const stop = () => w.stop();
          process.on("SIGTERM", stop);
          process.on("SIGINT", stop);
          await w.run();
          if (w.restarting) return upd.RESTART_FOR_UPDATE;
        }
        return 0;
      }
      case "uninstall": {
        const app = a._[1] as SetupApp | undefined;
        if (app && str(a.restore)) {
          const r = h.restore(app, str(a.restore)!, !!a.force);
          out(r.lines.join("\n"));
          return r.ok ? 0 : 1;
        }
        const r = uninstallAll({ apps: app ? [app] : undefined });
        out(r.lines.join("\n"));
        return r.ok ? 0 : 1;
      }
      // ---- talking from the command line (the full fallback when the app has no bot-link tools yet)
      case "send": {
        const m = cliMember(a);
        const intent = (str(a.intent) as any) || "fyi";
        if (!["task", "question", "fyi", "pass_to_human"].includes(intent)) throw new core.UserError("--intent is question, task, fyi (an announcement: no answer needed) or pass_to_human.");
        const waitS = a["wait-s"] !== undefined ? Number(a["wait-s"]) : 0;
        if (a["wait-s"] !== undefined && (a["wait-s"] === true || !(waitS >= 1 && waitS <= 3600))) throw new core.UserError("--wait-s is a number of seconds between 1 and 3600.");
        const r = await core.send(m, { to: str(a.to) || "room", text: str(a.text) || a._.slice(1).join(" "), intent }, sessFor(m));
        if (waitS > 0 && r.noWait) {
          out(`${r.text}\n${r.noWait}`); // lane F: nobody was woken, so no answer can come in this call
          return 3;
        }
        if (waitS > 0) {
          // ask and stay for the answer (Kickoff 2): the asker needs no way to be woken; the answer comes back here
          out(`${r.text}\nWaiting here up to ${waitS} s for the answer…`);
          // (each batch is printed first and acked after: a command the app ends early has lost nothing it didn't show)
          const w = await core.awaitAnswer(m, r.id, waitS * 1000, sessFor(m), { emit: out });
          out(w.answered ? "bot-link: the answer is above." : `bot-link: no answer within ${waitS} s. It will show up on this chat's next turn or when this chat listens (\`${selfCmd()} wait\`); \`${selfCmd()} inbox\` checks now.`);
          return w.answered ? 0 : 3;
        }
        // a question or a task: how to stay in this turn for the answer (real run 2026-11-10: the chat built it from wait + inbox)
        const stay = !a.json && (intent === "question" || intent === "task") && r.notWoken?.length !== r.recipients.length ? `\nTo stay in this turn for the answer: \`${selfCmd()} wait --max-s 120\`, then inbox (next time in one call: send … --wait-s 120; keep it under your command time limit).` : "";
        out(a.json ? JSON.stringify({ id: r.id, recipients: r.recipients }) : await withWaiting(r.text + stay, [m], sessFor(m)));
        return 0;
      }
      case "reply": {
        const id = a._[1];
        const text = str(a.text) || a._.slice(2).join(" ");
        if (!id || !text) throw new core.UserError(`Usage: ${selfCmd()} reply <message id> --text "<answer>" [--as <name>] [--room <room>]`);
        // --as: the same member send / inbox would pick for that name
        const asM = str(a.as) ? cliMember(a) : null;
        const r = await core.reply(asM ? sessFor(asM) : chatSession(detectApp()), id, text, asM ? asM.room.id : str(a.room), asM ? { ...who(detectApp()), as: asM.name } : who(detectApp()));
        out(a.json ? JSON.stringify({ id: r.id }) : r.text);
        return 0;
      }
      case "presence": {
        const m = cliMember(a);
        out(await withWaiting(await core.presence(m, sessFor(m)), [m], sessFor(m)));
        return 0;
      }
      case "inbox": {
        const sess = chatSession(detectApp());
        const app = detectApp();
        for (const l of await (await import("./memberend.js")).revive(sess, [process.cwd()], app).catch(() => [] as string[])) out(l);
        let ms = str(a.as) ? core.pickMembers(sess, str(a.room), str(a.as)!, who(app)) : core.heldBy(sess, who(app));
        if (str(a.room)) ms = ms.filter((m) => m.room.name === str(a.room)!.replace(/^#/, ""));
        if (!ms.length) core.pickMember(sess, str(a.room), null, who(app)); // throws the right sentence
        // live bug A: the waiting messages always first; --history adds the last 24 h after them, labelled as read
        // --woken: said by a run that something outside the chat started for these messages (an event at your own
        // endpoint, a trigger's routine): nobody is present, and the read counts as the wake's own
        if (a.woken) process.env.BOTLINK_UNATTENDED = "1";
        out(await core.inboxText(ms, ms[0]?.holder_session ?? sess, !!(a.history || a.recent), !!a.woken));
        return 0;
      }
      case "roster": {
        const m = cliMember(a);
        out(await withWaiting(await core.rosterText(m, sessFor(m)), [m], sessFor(m)));
        return 0;
      }
      case "permissions": {
        // what each member may get from this chat (perms.ts). Viewing is for anyone; giving a member MORE is the
        // human's: this command gives more only from a person's own terminal (a terminal window, not a command an
        // app ran), else it says how the human does it.
        const m = cliMember(a);
        const sub = String(a._[1] || "");
        if (!sub || sub === "list") {
          out(await core.permissionsText(m, sessFor(m)));
          return 0;
        }
        if (sub !== "set" || !a._[2] || !a._[3]) throw new core.UserError(USAGE.permissions);
        const person = humanTerminal();
        out(await core.setPermission(m, sessFor(m), { member: String(a._[2]), level: String(a._[3]), whileAway: a["while-away"] === true ? true : a["not-while-away"] === true ? false : undefined, how: person ? "terminal" : "chat" }));
        return 0;
      }
      case "report": {
        // a room report (report.ts): built by code from this chat's own copies; the chat's own model writes it
        const R = await import("./report.js");
        const sub = String(a._[1] || "");
        if (sub === "verify") {
          // no network: the bundle, and the owning member's key when this computer holds that member
          const B = await import("./bundle.js");
          if (!a._[2]) throw new core.UserError(USAGE.report);
          let b: import("./bundle.js").Bundle;
          try {
            b = B.readBundle(String(a._[2]));
          } catch (e) {
            throw new core.UserError((e as Error).message);
          }
          const own = st.loadMember(b.member.id);
          let xSk: string | null = null;
          try {
            xSk = own ? core.keysOf(own.key_id, own.key_backend).x_sk : null;
          } catch {
            xSk = null;
          }
          const r = B.verifyBundle(b, R.getNoteVerifier(), xSk);
          out(B.bundleCheckText(b, r));
          return r.chain.ok && !r.differences.length ? 0 : 3;
        }
        const m = cliMember(a);
        if (sub === "save") {
          const file = str(a.file);
          const text = file ? (await import("node:fs")).readFileSync(file, "utf-8") : str(a.text);
          if (!a._[2] || text === undefined) throw new core.UserError(USAGE.report);
          out(R.saveReport(m, String(a._[2]), text).text);
          return 0;
        }
        if (sub) throw new core.UserError(USAGE.report);
        out((await R.buildReport(m, sessFor(m), { days: str(a.days) ? Number(str(a.days)) : undefined })).text);
        return 0;
      }
      case "rules": {
        // standing rules (rules.ts): the human's own messages, kept on this computer. Anyone can list and remove;
        // a rule is ADDED only from a whole message the human typed in the chat (the save_rule tool).
        const R = await import("./rules.js");
        const m = cliMember(a);
        const sub = String(a._[1] || "list");
        const rules = R.rulesOf(m.id);
        if (sub === "list") {
          out(rules.length
            ? [`Standing rules for ${m.name} in #${m.room.name} (said by ${rules[0].said_by || m.person_name || "the human"} in this chat, kept on this computer only):`, ...rules.map((r, i) => `${i + 1}. ${JSON.stringify(r.quote)} · saved ${new Date(r.at).toISOString().slice(0, 10)}`), `Remove one: ${selfCmd()} rules rm <number> --as ${m.name}   ·   all: ${selfCmd()} rules rm all --as ${m.name}`].join("\n")
            : `No standing rules for ${m.name} in #${m.room.name}. A rule is a whole message the human types in the chat; the chat then saves it (save_rule).`);
          return 0;
        }
        if (sub !== "rm" || !a._[2]) throw new core.UserError(USAGE.rules);
        if (core.noHumanHere(m)) throw new core.UserError("No human is here in this run. Standing rules change only when your human says so.");
        if (String(a._[2]) === "all") {
          R.clearRules(m.id);
          out(`Removed all ${rules.length} standing rule${rules.length === 1 ? "" : "s"} of ${m.name}.`);
          return 0;
        }
        const gone = R.removeRule(m.id, Number(a._[2]));
        if (!gone) throw new core.UserError(`There is no rule ${String(a._[2]).slice(0, 12)} for ${m.name}. \`${selfCmd()} rules --as ${m.name}\` lists them with their numbers.`);
        out(`Removed rule ${Number(a._[2])}: ${JSON.stringify(gone.quote)}`);
        return 0;
      }
      case "unattended": {
        // what a run bot-link starts with nobody here may do (safety.ts): answer only (the default), or work
        const S = await import("./safety.js");
        const want = String(a._[1] || "");
        const cur = S.awayChoice();
        const apps = [...new Map(st.liveMembers().map((m) => [`${m.app}\n${m.cwd}`, m])).values()];
        // the settings of every app bot-link wakes on this computer: each member's folder, and the apps' own
        // profile-wide files (also before any chat here is a member)
        const found = [...new Set([...apps.flatMap((m) => S.permissive(m.app, m.cwd || null)), ...(["claude-code", "codex", "cursor"] as const).flatMap((app) => S.permissive(app, process.cwd()))])];
        if (!want) {
          const now = apps.map((m) => `${m.name} in #${m.room.name}: ${S.awayModeFor(m.app, m.cwd || null).mode === "work" ? "work (what the app's own settings allow)" : "answer only (no commands, no file changes)"}`);
          out([
            `When bot-link wakes a chat and nobody is here: ${cur.mode === "work" ? "work" : "answer only"}${cur.mode === "work" ? ` (set ${new Date(cur.at).toISOString().slice(0, 10)})` : " (the default)"}.`,
            ...now,
            ...(found.length ? ["These settings let a chat run things without asking:", ...found.map((x) => `  ${x}`)] : []),
            `Change it (the human, in their own terminal): ${selfCmd()} unattended work --yes   ·   ${selfCmd()} unattended answer`,
          ].join("\n"));
          return 0;
        }
        if (want === "answer") {
          S.setAwayChoice({ mode: "answer", at: Date.now() });
          out("A chat bot-link wakes while nobody is here answers only: it runs no commands and changes no files. (watch picks this up at its next wake.)");
          return 0;
        }
        if (want !== "work") throw new core.UserError(USAGE.unattended);
        if (!humanTerminal()) throw new core.UserError(`Only a person can let woken chats work with nobody here; a chat can't. They run this in their own terminal: ${selfCmd()} unattended work --yes`);
        const risk = [
          "With this, a chat that bot-link wakes while nobody is here can do whatever its app's own settings allow: run commands, change files.",
          "A message from a member your settings let through is then enough to start that. Other people's chats stay held unless you let one through (botlink permissions).",
          ...(found.length ? ["Right now these settings let a chat run things WITHOUT asking, so a woken chat could run anything on this computer:", ...found.map((x) => `  ${x}`)] : []),
        ];
        if (!a.yes) {
          out([...risk, `Nothing was changed. If that is what you want: ${selfCmd()} unattended work --yes`].join("\n"));
          return 2;
        }
        S.setAwayChoice({ mode: "work", at: Date.now(), accepted: found });
        out([...risk, "Set: woken chats may work. If the app's settings later allow more than listed here, wakes go back to answer only until you say yes again.", `Back to the default: ${selfCmd()} unattended answer`].join("\n"));
        return 0;
      }
      case "ask-yes": {
        // ask the human for a yes to another member's request (asks.ts): the chat may ask; only the human says it
        const A = await import("./asks.js");
        const m = cliMember(a);
        if (!a._[1] || !str(a.action) || !str(a.summary)) throw new core.UserError(USAGE["ask-yes"]);
        out(await A.askYes(m, { messageId: String(a._[1]), action: str(a.action)!, summary: str(a.summary)! }, sessFor(m)));
        return 0;
      }
      case "yes": {
        const A = await import("./asks.js");
        if (!a._[1]) throw new core.UserError(USAGE.yes);
        // the person at their own terminal is not one of the chats: they name the member, any member on this computer
        // (a chat's session is not known there); a command a chat runs is resolved as that chat, and refused below
        const person = humanTerminal();
        let m: st.MemberRec;
        if (person && str(a.as)) {
          const ms = st.liveMembers().filter((x) => x.name === str(a.as) && (!str(a.room) || x.room.name === str(a.room)!.replace(/^#/, "")));
          if (ms.length !== 1) throw new core.UserError(ms.length ? core.severalRooms(str(a.as)!, ms, "--room") : `No member named ${str(a.as)} on this computer.`);
          m = ms[0];
        } else m = cliMember(a);
        out(await A.sayYes(m, String(a._[1]), sessFor(m), person ? "terminal" : "chat"));
        return 0;
      }
      case "send-anyway": {
        // a message bot-link stopped because it looks like it carries a secret (outscan.ts): only a person sends it
        const m = cliMember(a);
        if (!a._[1]) throw new core.UserError(USAGE["send-anyway"]);
        out(await core.sendAnyway(m, String(a._[1]), sessFor(m), humanTerminal() ? "terminal" : "chat"));
        return 0;
      }
      case "label": {
        const m = cliMember(a);
        const text = a.clear ? "" : str(a.text) ?? a._.slice(1).join(" ");
        if (!a.clear && !text.trim()) throw new core.UserError(USAGE.label);
        out(await core.setLabel(m, text, sessFor(m)));
        return 0;
      }
      case "events": {
        // bot-link Events (SPEC §6.13): bot-link's server calls a URL when a message waits (signed, no message text)
        const E = await import("./events.js");
        const sub = String(a._[1] || "list");
        const m = cliMember(a);
        const sess = sessFor(m);
        try {
          const C = await import("./events-cmd.js");
          if (sub === "list") {
            out(await C.listText(m, sess));
            return 0;
          }
          if (sub === "subscribe") {
            const url = str(a.url);
            if (!url) throw new core.UserError(USAGE.events);
            const ttl = a["ttl-s"] ? Number(a["ttl-s"]) : null;
            if (ttl !== null && !(ttl >= 300 && ttl <= 7776000)) throw new core.UserError("--ttl-s is between 300 (5 minutes) and 7776000 (90 days).");
            out(await C.subscribeText(m, { name: str(a.name) || E.EVENT_MESSAGE, url, secret: str(a.secret) || null, urgentOnly: !!a["no-fyi"], ttlS: ttl, askPerson: !!a["ask-person"] }, sess));
            return 0;
          }
          if (sub === "unsubscribe") {
            const id = str(a._[2] as unknown);
            if (!id && !str(a.url)) throw new core.UserError(USAGE.events);
            out(await C.unsubscribeText(m, { id, url: str(a.url), name: str(a.name) }, sess));
            return 0;
          }
          if (sub === "serve") {
            const url = str(a.url);
            if (!url) throw new core.UserError(USAGE.events);
            const port = a.port ? Number(a.port) : 8787;
            if (!(port >= 0 && port < 65536)) throw new core.UserError("--port is a port number.");
            const L = await import("./listen.js");
            let command = str(a["on-message"]) || null;
            const via = a.tmux !== undefined ? "tmux" : str(a.via);
            if (via) {
              if (via !== "opencode" && via !== "t3" && via !== "codex-queue" && via !== "tmux") throw new core.UserError("--via is codex-queue, opencode or t3 (or use --tmux).");
              let id = str(a.thread) || (m.wake_thread?.via === via ? m.wake_thread.id : "");
              if (via === "codex-queue") id = str(a.thread) || m.holder_session || (process.env.CODEX_THREAD_ID || "").trim();
              if (via === "tmux") id = (typeof a.tmux === "string" && a.tmux.trim()) || (process.env.TMUX_PANE || "").trim();
              if (!id) throw new core.UserError(via === "tmux" ? "--tmux needs the chat's tmux pane: --tmux <pane id like %3> (or run this inside that pane)." : `--via ${via} needs the chat's id: --thread <id>.`);
              command = L.viaCommand(via, id, m);
            }
            if (a.detach) {
              // its own session, like `listen --detach`: returns once the receiver is subscribed (or says why not)
              const other = E.runningReceiver(m.id);
              if (other) {
                out(`A receiver for ${m.name} is already running (pid ${other.pid}, port ${other.port}). Stop it first: ${selfCmd()} events stop --as ${m.name}`);
                return 5;
              }
              const args = process.argv.slice(2).filter((x) => x !== "--detach");
              if (!args.includes("--as") && !args.includes("--member-id")) args.push("--as", m.name);
              const r = await E.startDetachedReceiver(m, args);
              const tline = await core.firstListenTest(m, "listener");
              // remembered, so the next bot-link call restarts it if it dies (`events stop` forgets it). Not one that
              // is meant to end by itself (--once, --max-s): restarting that would undo what was asked for.
              // (a one-shot start leaves an earlier long-running receiver's record alone: that one is still wanted)
              if (!a.once && !a["max-s"]) L.recordEventsPath(m.id, { args, cwd: process.cwd(), at: Date.now() });
              out(`${E.receiverLine(r)}\nRunning in the background (log ${E.serveLog(m.id)}). Check it end to end: ${selfCmd()} selftest --as ${m.name}, then end your turn. Stop it: ${selfCmd()} events stop --as ${m.name}${tline ? `\n${tline}` : ""}`);
              return 0;
            }
            const rc = await E.serveEvents(m, { url, port, host: str(a.host), command, once: !!a.once, urgentOnly: !!a["no-fyi"], maxMs: a["max-s"] ? Number(a["max-s"]) * 1000 : undefined, say: a.once && !command ? out : undefined });
            return rc;
          }
          if (sub === "stop") {
            const L = await import("./listen.js");
            L.forgetEventsPath(m.id); // stopped on purpose: don't restart it
            const r = E.runningReceiver(m.id);
            if (!r) {
              out(`No receiver is running for ${m.name} on this computer.`);
              return 0;
            }
            process.kill(r.pid, "SIGTERM"); // the PID the receiver recorded for itself
            for (let i = 0; i < 100 && E.runningReceiver(m.id); i++) await new Promise((x) => setTimeout(x, 100));
            out(E.runningReceiver(m.id) ? `Asked the receiver for ${m.name} (pid ${r.pid}) to stop; it is still shutting down.` : `Stopped the receiver for ${m.name} (pid ${r.pid}); bot-link no longer calls ${r.url}.`);
            return 0;
          }
        } catch (e) {
          if (e instanceof core.UserError) throw e;
          throw new core.UserError(E.explainEvents(e));
        }
        throw new core.UserError(USAGE.events);
      }
      case "selftest": {
        const m = cliMember(a);
        out(a.result ? core.selftestResult(m) : await core.runSelftest(m, sessFor(m)));
        return 0;
      }
      case "update": {
        // SPEC §7.6: check the server now; install what it serves when it differs. --background: quiet (spawned by the MCP server / SessionStart)
        const r = await upd.runUpdate({ force: !a.background });
        const moved = r.status === "updated" || r.status === "current" ? migrateToShim() : [];
        if (a.background) return 0;
        if (r.status === "updated") out(`bot-link updated to ${r.version} (${r.sha256.slice(0, 8)}). Restart Claude Code, Codex and Cursor to use it; running chats keep their version until then.`);
        else if (r.status === "current") out(`bot-link is up to date (${r.version}, ${r.sha256.slice(0, 8)}).`);
        else if (r.status === "busy") out("Another bot-link update is running; try again in a minute.");
        else if (r.status === "skipped") out(`Not updating: ${r.why}.`);
        else {
          // offline, refused or failed: the same words `botlink status` shows, plus the technical reason
          const last = upd.loadState().last;
          out(last && !last.ok ? `${attemptText(last, { clientDir: upd.clientDir() })}${last.reason !== "other" ? ` (${r.why})` : ""}` : `Couldn't update (${r.why}). Nothing changed.`);
        }
        if (moved.length) out(["Your apps now launch bot-link from ~/.botlink/client/current:", ...moved].join("\n"));
        return r.status === "refused" || r.status === "failed" ? 1 : 0;
      }
      default:
        err(`Unknown command ${cmd}.\n\n${HELP()}`);
        return 1;
    }
  } catch (e) {
    err(core.explain(e));
    return 1;
  }
}

const isMain = (() => {
  try {
    const self = new URL(import.meta.url).pathname;
    const arg = process.argv[1] ? (process.argv[1].startsWith("/") ? process.argv[1] : `${process.cwd()}/${process.argv[1]}`) : "";
    const real = (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    };
    return real(self) === real(arg);
  } catch {
    return false;
  }
})();

if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code >= 0) process.exit(code);
    },
    (e) => {
      process.stderr.write(`bot-link: ${(e as Error)?.message || e}\n`);
      // a hook must never fail the harness
      process.exit(process.argv[2] === "hook" ? 0 : 1);
    },
  );
}

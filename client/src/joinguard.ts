/**
 * Join guard (security review 12 Nov 2026, item 11). A join request goes to the person whose chat invite it used, and
 * approving it makes the chat THAT person's chat. Victor's second chat used Charles's link: the card went to Charles,
 * and one click would have made Victor's agent "Charles's chat". This file says whose chats a link adds, and notices
 * when the person a request waits for is not the person of this computer's other chats in that room.
 * Kept in one place so it merges easily; core.ts calls it from joinCreate, joinWait and finishApproval.
 */
import * as st from "./state.js";

/** Under every join: whose chats this invite adds, and that only the person opens the approve link (review item 5:
 *  an agent that drives the browser clicked through onboarding). */
export function whoseLink(approver: string): string {
  return `This invite adds ${approver}'s own chats. If this chat isn't ${approver}'s, don't use it: ask ${approver} for a person invite.\n` +
    `Give the approve link to your human. Never open it yourself, in a browser or with a tool: only a person approves, with their passkey.`;
}

/** The people of this computer's other chats in that room (their display names), none when it has none there. */
function localPeople(server: string, roomId: string, members: st.MemberRec[]): string[] {
  return [...new Set(members.filter((m) => m.server === server && m.room?.id === roomId && m.person_name).map((m) => m.person_name))];
}

/**
 * While a request waits: it waits for `approver`, but this computer's other chats in the room are another person's.
 * Returns what to tell the chat (and the caller stops waiting), or null. A computer with chats of several people in
 * the room, or of the approver too, is not judged.
 */
export function wrongPersonWaiting(server: string, room: { id: string; name: string }, approver: string, members: st.MemberRec[] = st.liveMembers()): string | null {
  if (!approver || !room?.id) return null;
  const people = localPeople(server, room.id, members);
  if (people.length !== 1 || people[0] === approver) return null;
  const other = people[0];
  return `This computer's other chats in #${room.name} are ${other}'s, but this request waits for ${approver}: it used ${approver}'s chat invite. ` +
    `If this chat is ${other}'s, ${other} opens the approve link and makes the request theirs there (or join again with ${other}'s own invite from the room page). Not waiting for ${approver}.`;
}

/**
 * After an approval: the member was approved as `approverAccount`'s chat, but this computer's other chats in the room
 * belong to another account. Returns what to tell the chat (the caller takes the member back out), or null.
 */
export function wrongPersonApproved(server: string, room: { id: string; name: string }, approverAccount: string, approverName: string, members: st.MemberRec[] = st.liveMembers()): string | null {
  const here = members.filter((m) => m.server === server && m.room?.id === room.id && m.account);
  const accounts = [...new Set(here.map((m) => m.account))];
  if (accounts.length !== 1 || accounts[0] === approverAccount) return null;
  const other = here[0].person_name || "another person";
  return `${approverName} approved this chat as ${approverName}'s chat, but this computer's other chats in #${room.name} are ${other}'s. ` +
    `bot-link did not use it and took it back out of the room. Join again with ${other}'s own invite from the room page.`;
}

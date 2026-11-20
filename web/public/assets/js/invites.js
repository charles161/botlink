// Who may invite people into a room, and the address of a room's invite panel. One place, used by the room page
// (views/room.js) and the rooms list (views/rooms.js), so the list shows an Invite control exactly where the room
// page lets the person invite.

/** Only the owner invites people (the server refuses person invites from anyone else). */
export const mayInvitePeople = (role) => role === "owner";

/** The id of the room page's invite panel, and the link that opens the room there. */
export const INVITE_PANEL = "invite";
export const roomInviteHref = (roomId) => `/rooms/${roomId}#${INVITE_PANEL}`;

package humancheck

// ApproveEventURLAction (target: the address request) approves an event address its chat could not prove
// (docs/protocol/event-url-approval.md §3): bot-link then calls that address each time a message waits for the chat.
// It asks a passkey every time, like a join approval, and is its own action, so its check serves no other approval
// and no other check serves it.
const ApproveEventURLAction = "approve_event_url"

func init() {
	Actions[ApproveEventURLAction] = true
	EveryTime[ApproveEventURLAction] = true
}

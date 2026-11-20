package appapi

import (
	"context"
	"time"
)

// RecoveryNotice is the mail a person gets when a passkey reset of their account starts, is cancelled or completes.
// The server has no mail sender today: Mail is NoMail unless something sets it, so nothing is ever sent. Without a
// notice, the waiting period protects only a person who opens their dashboard during it (the banner).
type RecoveryNotice struct {
	Kind    string // started | cancelled | completed
	Email   string // the account's verified email
	Name    string
	ReadyAt time.Time // started: when the new passkey can be set up
	How     string    // cancelled: passkey | session
	Agent   string    // the browser (user agent) that did it, as the sign-in recorded it
}

// RecoveryMailer sends recovery notices. Send runs after the change has committed; an error is logged, never shown.
type RecoveryMailer interface {
	Send(ctx context.Context, n RecoveryNotice) error
}

// NoMail is the default: no notice leaves the server.
type NoMail struct{}

func (NoMail) Send(context.Context, RecoveryNotice) error { return nil }

// Package cryptodoc embeds the wire-format doc served at /envelope.md. Contract shim: do not rename.
package cryptodoc

import _ "embed"

//go:embed ENVELOPE.md
var EnvelopeMD []byte

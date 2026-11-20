// Package web embeds the static dashboard (web/public) served by the Go server. Contract shim: do not rename.
// web/public must always contain at least one file (.gitkeep) so the embed compiles.
package web

import "embed"

//go:embed all:public
var Public embed.FS

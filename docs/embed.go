// Package docs embeds the open agent docs served at /agents.md and /llms.txt. Contract shim: do not rename.
package docs

import "embed"

//go:embed agents.md llms.txt
var FS embed.FS

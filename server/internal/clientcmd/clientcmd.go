// Package clientcmd builds the command that runs the client from a download address. Every page and message the
// server prints that runs a client goes through Npx (client/test/npxprefix.test.ts fails on any other way of writing
// `npx -y <url>`; the client's twin is npxRun in client/src/version.ts).
package clientcmd

import "strings"

// URLFlag: npm 12 refuses a tarball URL unless the command allows it (allow-remote defaults to "none", EALLOWREMOTE);
// npm 8 to 11 accept the setting and change nothing (client/scripts/npm-matrix.mjs, 21 Nov 2026). It stands before
// the URL: npx hands everything after the package to the client.
const URLFlag = "--allow-remote=all"

// Npx is the command prefix that runs the client at url: "npx -y --allow-remote=all <url>" for an http(s) address,
// "npx -y <spec>" for anything else (a file or a registry name needs no flag).
func Npx(url string) string {
	if strings.HasPrefix(url, "https://") || strings.HasPrefix(url, "http://") {
		return "npx -y " + URLFlag + " " + url
	}
	return "npx -y " + url
}

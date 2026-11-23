package pages

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"html"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/charles161/botlink/docs"
	"github.com/charles161/botlink/server/internal/clientcmd"
	"github.com/charles161/botlink/server/internal/clientgate"
	"github.com/charles161/botlink/server/internal/config"
)

// PrintedCommand is one command line the server prints or serves that runs the client.
type PrintedCommand struct {
	Source string `json:"source"`
	Line   string `json:"line"`
}

// printedCommands collects every `npx -y …` line of a text, as a person or a model copies it: up to the closing
// backtick or </code>, the end of the line, or the refusal's "<the same command and arguments>".
func printedCommands(source, text string) []PrintedCommand {
	var out []PrintedCommand
	for rest := text; ; {
		i := strings.Index(rest, "npx -y ")
		if i < 0 {
			return out
		}
		rest = rest[i:]
		end := len(rest)
		for _, stop := range []string{"`", "</code>", "\n", " <the same command and arguments>"} {
			if j := strings.Index(rest, stop); j >= 0 && j < end {
				end = j
			}
		}
		out = append(out, PrintedCommand{Source: source, Line: html.UnescapeString(rest[:end])})
		rest = rest[end:]
	}
}

// The pages, the served docs and the join gate's refusal name the client with the one prefix clientcmd.Npx writes
// (npm 12 refuses `npx -y <url>` without --allow-remote=all before the URL, 21 Nov 2026). With BOTLINK_PRINTED_OUT
// set, the lines are written there as JSON for client/scripts/npm-matrix.mjs, which runs each under npm 8 to 12;
// BOTLINK_PRINTED_TGZ and BOTLINK_PRINTED_BASE then name the tarball and the address it is served at.
func TestPrintedCommandsUseOnePrefix(t *testing.T) {
	tgz, base := os.Getenv("BOTLINK_PRINTED_TGZ"), os.Getenv("BOTLINK_PRINTED_BASE")
	if tgz == "" {
		tgz = filepath.Join(t.TempDir(), "botlink.tgz")
		if err := os.WriteFile(tgz, tarball(t, `{"name":"botlink","version":"1.2.3"}`), 0o644); err != nil {
			t.Fatal(err)
		}
		base = "https://api.botlink.dev/dl/botlink.tgz"
	}
	p := &Pages{Cfg: &config.Config{ClientURL: base, AppOrigin: "https://app.botlink.dev"}, Client: NewClientFile(tgz), Docs: docs.FS}
	version, url := p.Client.Current(base)
	if url == base {
		t.Fatalf("no versioned URL for %s", tgz)
	}
	invite := "https://app.botlink.dev/i/room-ABCDEFGHJK"
	var got []PrintedCommand
	got = append(got, printedCommands("invite page (markdown, for agents)", inviteMarkdown("room", "There is 1 AI chat in this room.", invite, clientcmd.Npx(p.clientURL()), "1 Jan 2030 00:00"))...)
	var buf bytes.Buffer
	if err := inviteTmpl.Execute(&buf, map[string]any{"Room": "room", "Count": "", "URL": invite, "Run": clientcmd.Npx(p.clientURL()), "Expires": ""}); err != nil {
		t.Fatal(err)
	}
	got = append(got, printedCommands("invite page (html)", buf.String())...)
	for _, name := range []string{"agents.md", "llms.txt"} {
		b, err := fs.ReadFile(p.Docs, name)
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, printedCommands("/"+name, string(p.withClientURL(b)))...)
	}
	got = append(got, printedCommands("join refusal (clientgate.OutdatedText)", clientgate.OutdatedText("1.0.0", clientgate.Current{Version: version, URL: url}))...)

	want := clientcmd.Npx(url) + " "
	seen := map[string]bool{}
	for _, c := range got {
		seen[c.Source] = true
		if !strings.HasPrefix(c.Line+" ", want) {
			t.Errorf("%s prints %q: every command starts with clientcmd.Npx(<versioned URL>) = %q", c.Source, c.Line, want)
		}
	}
	if len(seen) != 5 || len(got) < 10 {
		t.Fatalf("expected commands from all 5 sources, got %d lines from %v", len(got), seen)
	}
	if out := os.Getenv("BOTLINK_PRINTED_OUT"); out != "" {
		b, _ := json.MarshalIndent(map[string]any{"url": url, "version": version, "at": time.Now().UTC().Format(time.RFC3339), "commands": got}, "", "  ")
		if err := os.WriteFile(out, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// tarball is an npm-pack layout tarball holding only package/package.json.
func tarball(t *testing.T, pkgJSON string) []byte {
	var b bytes.Buffer
	gz := gzip.NewWriter(&b)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: "package/package.json", Mode: 0o644, Size: int64(len(pkgJSON))}); err != nil {
		t.Fatal(err)
	}
	_, _ = tw.Write([]byte(pkgJSON))
	_ = tw.Close()
	_ = gz.Close()
	return b.Bytes()
}

package pages

import (
	"bytes"
	"html/template"
	"io/fs"
	"net/http"
)

// The "Self-host it" link to the public repository (BOTLINK_SOURCE_URL, config/source.go). Empty: no page names a
// repository. Set: the dashboard's index page carries it as a meta tag (the landing page and the docs render the link,
// web/public/assets/js/source-link.js), and the trust page's footer marker becomes the link. A plain external link with
// rel="noopener noreferrer"; the value was checked at start to be https://github.com/<owner>/<repository>.

const sourceMarker = "<!-- source-link -->"

func (p *Pages) sourceMeta() string {
	if p.Cfg == nil || p.Cfg.SourceURL == "" {
		return ""
	}
	return `<meta name="botlink-source-url" content="` + template.HTMLEscapeString(p.Cfg.SourceURL) + `">`
}

// trustPage serves trust.html with the footer marker replaced by the link, or removed when there is none.
func (p *Pages) trustPage(w http.ResponseWriter, r *http.Request) bool {
	b, err := fs.ReadFile(p.Web, "trust.html")
	if err != nil {
		return false
	}
	link := ""
	if p.Cfg != nil && p.Cfg.SourceURL != "" {
		link = `<a href="` + template.HTMLEscapeString(p.Cfg.SourceURL) + `" rel="noopener noreferrer">Self-host it</a>`
	}
	b = bytes.Replace(b, []byte(sourceMarker), []byte(link), 1)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	if r.Method != http.MethodHead {
		_, _ = w.Write(b)
	}
	return true
}

# App icons (self-hosted; never hotlinked)

| File | App | Source | Licence of the file |
|---|---|---|---|
| claude-code.svg | Claude Code | simple-icons 16.36.0 `icons/claudecode.svg` (npm `simple-icons`; fill = its published hex D97757, source code.claude.com) | CC0 1.0 |
| claude.svg | Claude Desktop | simple-icons 16.36.0 `icons/claude.svg` (fill = its published hex D97757) | CC0 1.0 |
| codex.svg | Codex | @lobehub/icons-static-svg 1.102.0 `icons/codex-color.svg` (npm; width/height/style attrs stripped, gradient id renamed) | MIT |
| cursor.svg | Cursor | simple-icons 16.36.0 `icons/cursor.svg` (fill = its published hex 000000) | CC0 1.0 |
| opencode.svg | OpenCode | simple-icons 16.36.0 `icons/opencode.svg` (fill = its published hex 000000) | CC0 1.0 |
| windsurf.svg | Windsurf | simple-icons 16.36.0 `icons/windsurf.svg` (fill = its published hex 0B100F) | CC0 1.0 |
| zed.svg | Zed | simple-icons 16.36.0 `icons/zedindustries.svg` (fill = its published hex 084CCF) | CC0 1.0 |
| gemini-cli.svg | Gemini CLI | @lobehub/icons-static-svg 1.102.0 `icons/geminicli-color.svg` (width/height/style attrs stripped) | MIT |
| antigravity.svg | Antigravity | @lobehub/icons-static-svg 1.102.0 `icons/antigravity-color.svg` (width/height/style attrs stripped) | MIT |
| grok-bot.png | Grok Bot | the app's Google Play icon (botlink-brand/grok-bot-icon.png, 512 px), resized to 192 px | app icon |
| t3-code.png | T3 Code | https://t3.codes/apple-touch-icon.png (180 px, downloaded 2026-11-06) | app icon |
| vscode.png | VS Code / Copilot | https://code.visualstudio.com/assets/apple-touch-icon.png (256 px, downloaded 2026-11-06) | app icon |

The marks themselves are trademarks of their owners (Anthropic, OpenAI, Anysphere, Microsoft, Google, Zed Industries,
Cognition, the OpenCode and T3 Code projects, Grok Bot); we show them only to say which app a chat runs in.
`node web/scripts/app-icons.mjs` reads claude-code.svg, codex.svg and cursor.svg and regenerates `assets/js/app-icons.js`
(path data + colours derived from each icon's dominant colour, for the dashboard's bot badges) and the `app-colors`
block in `assets/app.css`. Commit its output. The landing page shows every file here as an `<img>` on a light tile.

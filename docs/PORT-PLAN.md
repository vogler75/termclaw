# TermClaw: port from Electron/Node to Rust or Go

Status: proposal, nothing started. Written against v0.4.2.

## Short answer

- **It is possible.** Nothing TermClaw does needs Node. The main process spawns PTYs, runs `ssh`, `wsl.exe`, `git`, `docker` and `tar`, keeps a headless terminal per session, serves MCP over HTTP, speaks ACP over stdio, and stores JSON. Rust and Go can both do all of that.
- **Recommendation: Rust with Tauri 2.** Keep the existing HTML/JS/xterm.js renderer and rewrite only the Electron main process (`src/main`, about 7,600 lines) in Rust.
- **Do not rewrite the UI natively,** with egui, iced or gpui in Rust, or Fyne or Gio in Go. That would mean writing our own terminal renderer, selection, links and IME handling instead of using xterm.js, and would roughly triple the work for no user-visible gain.

## What exists today

| Part | Lines | Port effort |
|---|---|---|
| Renderer (`src/renderer`, xterm.js, plain DOM, esbuild) | ~4,800 | Keep almost as-is |
| Main process (`src/main`) | ~7,600 | Rewrite |
| Unit tests (`test/`) and E2E tests (`test-e2e/`, Playwright `_electron`) | ~2,900 | Rewrite, E2E harness included |

Two things make the port much easier than its size suggests:

1. **There is one IPC choke point.** The renderer talks to main only through `window.termclaw.call(method, ...args)` (about 109 methods), `window.termclaw.on(channel, cb)` (events such as `session:data` and `agent:live`), and `pathForFile`. If the new backend offers the same three functions, the renderer does not notice the change.
2. **Most of main is orchestration, not algorithms.** It builds command lines and scripts (`connect.js`, the tmux script, PowerShell `-EncodedCommand`), parses CLI output (`git.js`, `docker.js`), and keeps state. That ports roughly line for line.

## Rust or Go

| Need | Rust | Go |
|---|---|---|
| Desktop shell that keeps the web UI | **Tauri 2**: mature, WebView2/WKWebView, installers, signing | Wails: works, but a smaller ecosystem |
| PTY on Windows (ConPTY), our main platform | **portable-pty** (from WezTerm), proven on Windows | creack/pty has no Windows support; third-party ConPTY wrappers are less proven |
| Headless terminal (replaces `@xterm/headless` and the serialize addon: snapshot on reattach, `lines()` for MCP and the monitor, OSC 7 cwd) | **vt100** crate (screen, scrollback, `contents_formatted()` gives an ANSI snapshot) or alacritty_terminal | Few options (charmbracelet/x/vt, vt10x); expect to patch or write parts ourselves |
| MCP server (streamable HTTP) | rmcp, the official SDK | official go-sdk |
| ACP client (Copilot, Claude, Gemini, OpenCode) | **agent-client-protocol**, the official crate (Zed is written in Rust) | community implementations |
| Spawning and streaming `ssh`/`git`/`docker`, HTTP, OAuth | tokio, reqwest, oauth2: fine | Excellent; this is Go's sweet spot |
| Speed of writing and reading the code | Slower; async Rust has a learning curve | Faster and simpler |

**Why Rust:** the three hardest pieces, ConPTY on Windows, a headless VT emulator and ACP, have the strongest libraries in Rust. Tauri is also the more mature way to keep our web UI. Go would win on development speed and simplicity, but on Windows we would spend that time saved on the PTY and terminal-emulator gaps.

**When Go would be the better pick:** if TermClaw were mostly a macOS/Linux tool, or if being able to maintain the code without Rust experience mattered more than the libraries.

## What we gain and what it costs

**Gains:**
- Installer around 10–20 MB instead of about 100 MB+, and noticeably less RAM, since there is no bundled Chromium or Node.
- No `node-pty` native rebuilds, no `@electron/rebuild`, no `asarUnpack`.
- The MCP stdio bridge (`termclaw-mcp-stdio.js`) becomes a small native binary or a subcommand.
- A single, statically typed backend.

**Costs and risks:**
- The webview is no longer the Chromium we control. WebView2 on Windows is Chromium-based, so the risk there is low. WKWebView on macOS is Safari, so the clipboard API (image paste), keyboard handling, drag-and-drop and xterm.js rendering need re-checking there.
- Electron-specific features need replacements:

  | Electron | Tauri |
  |---|---|
  | `webUtils.getPathForFile` | Tauri's drag-drop event gives the paths |
  | `clipboard.read()` for image paste | `tauri-plugin-clipboard-manager` or the arboard crate |
  | `Notification` | notification plugin |
  | `shell.openExternal`, `openPath`, `showItemInFolder` | opener plugin |
  | `dialog` | dialog plugin |
  | app menu and accelerators | menu API |
  | `safeStorage` | DPAPI directly on Windows, Keychain on macOS (the keyring crate) |

- **Existing encrypted secrets must keep working.** `enc:` values were written by `safeStorage`. On Windows they are DPAPI blobs, which Rust can decrypt. On macOS the key lives in the Keychain item "TermClaw Safe Storage". We need a migration path, with tests on both platforms.
- **The E2E suite must be rebuilt.** Playwright's `_electron` will not drive Tauri. `tauri-driver` (WebDriver) works on Windows and Linux but not macOS. The alternative is to run the renderer in a normal Chromium against a test backend.
- **Effort:** this is a full rewrite of the backend. Expect weeks, not days, even with agents doing most of the typing, plus a period of running both versions in parallel.

## Plan

### Phase 0: spike (decide go/no-go)

Build a Tauri app that loads the current `dist/` renderer unchanged, with one local PowerShell session over portable-pty connected to xterm.js through `call('write')` and the `session:data` event. Check:

- typing, resize, Ctrl+C/V, OSC 52 copy, image paste, drag-drop of files, Ctrl+wheel zoom;
- throughput with a large `cat` or `seq 1000000`, and 16 terminals in the overview without stutter;
- the same on macOS in WKWebView.

**Exit criterion:** no blocker in the webview, and IPC throughput is good enough. Otherwise stop here, having lost little.

### Phase 1: backend skeleton and compatible IPC

- Tauri commands:
  - `call(method, args) -> Value` dispatches to a method table, mirroring `ipcMain.handle('api')` in `main.js`.
  - `on(channel)` is implemented with Tauri events or channels.
  - A tiny `preload` replacement defines `window.termclaw` with the same shape.
- `store`: same `config.json` format and same user-data directory, so a user can switch with existing projects. `TERMCLAW_USER_DATA` stays.
- Version from `version.txt`, window title, `openDataDir`, notifications.

### Phase 2: terminals (the core)

- `sessions`:
  - PTY spawn, write and resize;
  - a raw output ring for `readSince`;
  - a vt100 parser for `lines()`, `serialize()` on reattach, and the OSC 7 cwd;
  - idle/waiting detection with thresholds;
  - reconnect and persistence.
- `connect`: local shells, WSL, SSH and the tmux script (including `mouse on`), ported 1:1 with the existing unit tests translated as golden tests.
- `hosts`, `forwards` (ssh -L), `files` (tar upload/download, image paste to `/tmp`), `secrets` with migration.

**Milestone:** daily use with local, WSL, SSH and tmux sessions works.

### Phase 3: integrations

- `mcp`: an HTTP MCP server with rmcp, plus the stdio bridge binary. `mcp-oauth` and `mcp-oauth-external` come next, ported with their tests.
- `acp`, `agent`, `opencode`, `orchestrators`: ACP over stdio with the agent-client-protocol crate. Watch the Windows `.cmd`/`.ps1` shim handling in `acp.js`.
- `coding-agents/*`: registry, deploy, skills, apm, target.
- `git`, `docker`, `monitor`, `audit`.

### Phase 4: tests, packaging, release

- Port `test/*.test.js` to Rust tests. Most are pure functions: command building, parsing, OAuth.
- E2E: tauri-driver on Windows. For macOS, run the renderer in Chromium against the same backend, or check it by hand.
- Packaging: Tauri bundler (NSIS/MSI and portable on Windows, dmg on macOS), code signing, and the GitHub release workflow adapted to `release.ps1`.
- Auto-update via the updater plugin, if wanted.

### Phase 5: switch over

- Ship the Rust version as a beta next to the Electron build, sharing the same config. Keep Electron releases until the beta has run without regressions for a while.
- Then remove `src/main`, Electron and node-pty. `src/renderer` stays, with a smaller bridge.

## Suggested repository layout

```
src/renderer/          unchanged (esbuild build stays)
src-tauri/
  src/main.rs          app setup, window, menu
  src/ipc.rs           call/on dispatch, method table
  src/store.rs  sessions.rs  connect.rs  files.rs  secrets.rs ...
  src/mcp/  src/acp/  src/agents/
  tauri.conf.json
crates/termclaw-mcp-stdio/   tiny bridge binary
```

## Open questions before starting

1. Is installer size or memory a real pain for users, or is the main motivation maintainability? If neither, staying on Electron is a legitimate choice.
2. How important is macOS? WKWebView is where most surprises would show up.
3. Is everyone who maintains TermClaw comfortable with Rust? If not, Go with Wails is the pragmatic alternative, and the same phases apply.

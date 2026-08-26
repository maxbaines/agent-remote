# Agent Remote

A web-first terminal workspace. Persistent sessions, split panes, and a browser UI — backed by a custom Go Session Owner.

Agent Remote is an upstream-aware fork of muxterm. See [fork provenance](docs/fork-provenance.md) for the pinned source revision, compatibility boundaries, and update policy.

## Install

### macOS — Homebrew
```bash
brew install maxbaines/tap/agent-remote
```

### Linux

```bash
curl -fsSL https://raw.githubusercontent.com/maxbaines/agent-remote/main/install.sh | bash
```

Or review first:
```bash
curl -fsSL https://raw.githubusercontent.com/maxbaines/agent-remote/main/install.sh -o install.sh
less install.sh
bash install.sh
```

**No sudo required.** The binary installs to `~/.local/bin` and PATH is configured automatically.

**To run as a background service** (persists across reboots):
```bash
agent-remote install
# Optionally, to keep running even when logged out:
sudo loginctl enable-linger $USER
```

**To upgrade:**
```bash
curl -fsSL https://raw.githubusercontent.com/maxbaines/agent-remote/main/install.sh | bash
agent-remote install  # restarts the service with the new binary
```

### Windows — Scoop (coming soon)

Pre-built binaries for each platform are attached to every [GitHub Release](https://github.com/maxbaines/agent-remote/releases).

## What is this?

Agent Remote is a terminal workspace where the UI lives in a browser. Open splits, create Workspaces, and resize Panes in HTML and xterm.js, then reconnect from another Remote Client without tying Terminal Session lifetime to the browser.

The session daemon is a standalone Go process that owns your PTYs directly. It survives HTTP server restarts. When you reconnect, it replays a clean screen state — not a raw byte stream — so full-screen apps like vim and htop come back correctly at whatever size your window happens to be.

```
Browser (Lit + xterm.js + dockview)
    ↕ WebSocket (binary-framed protocol)
Go server (HTTP + WS relay)
    ↕ Unix socket
sessiond (PTY daemon)
    ↕ PTY
your shells
```

## Quick start

```bash
# Build
make build

# Run locally (opens browser, connects to local sessiond)
./bin/agent-remote

# Run behind an HTTPS reverse proxy for remote access
./bin/agent-remote serve --addr 127.0.0.1:8080 \
  --behind-reverse-proxy \
  --public-origin https://agent-remote.example.com

# On the host, create the one-time enrollment code
./bin/agent-remote auth init --origin https://agent-remote.example.com

# Install as a system service (survives reboots)
./bin/agent-remote install

# Push to a remote server
./bin/agent-remote deploy user@myserver.com
```

## Features

- **Workspaces** — named groups of panes, switch between them from a bar at the top
- **Split panes** — real DOM layout via dockview; drag to resize, arbitrary nesting
- **Clean reconnects** — server-side VT emulation replays a live cell-grid snapshot, not raw bytes; full-screen apps restore correctly at any window size
- **Browser pane** — embed a running local web app (e.g. a dev server on port 3000) as a mux pane, proxied through the server
- **PWA** — installable as a standalone desktop or mobile app; service worker for offline support
- **Bundled themes** — nine coordinated dark and light palettes update existing terminals and browser chrome immediately
- **Session persistence** — the sessiond daemon detaches from the HTTP server; your shells survive server restarts, deploys, and reboots
- **Single binary** — Go binary with embedded frontend; no external runtime besides a shell
- **Auth** — passkey-first remote login with TOTP-backed one-use recovery codes; no identity service or email provider
- **Service install** — `agent-remote install` sets up systemd (Linux) or launchd (macOS)
- **Push deploy** — `agent-remote deploy user@host` copies the binary and installs remotely
- **Agent integration (MCP)** — connect any MCP-compatible AI agent to drive workspaces, terminals, and browser panes

## Agent integration (MCP)

`agent-remote mcp` exposes a [Model Context Protocol](https://modelcontextprotocol.io) server that lets any MCP-compatible AI agent drive workspaces, terminals, and browser panes. The server speaks JSON-RPC 2.0 over stdio and requires a running `agent-remote` or `agent-remote serve` instance to connect to.

**25 tools** across 6 categories: workspace management, pane layout (with ASCII diagram for spatial awareness), terminal control (OSC 133 shell completion), browser navigation, browser interaction, and browser observation.

### Amplifier

Add to `.amplifier/mcp.json` (project) or `~/.amplifier/mcp.json` (global):

```json
{
  "mcpServers": {
    "agent-remote": {
      "command": "agent-remote",
      "args": ["mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add agent-remote -- agent-remote mcp
```

Or add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "agent-remote": {
      "command": "agent-remote",
      "args": ["mcp"]
    }
  }
}
```

### OpenCode

Add to `opencode.json` in your project root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "agent-remote": {
      "type": "local",
      "command": ["agent-remote", "mcp"]
    }
  }
}
```

## Authentication

Local loopback use keeps the zero-config bypass. Remote access uses a passkey as the normal sign-in method, with a TOTP authenticator plus one saved one-use recovery code as the fallback. Authentication is self-hosted inside the Agent Remote binary; it does not require Better Auth, Resend, an email provider, or an external database.

For a remote deployment, first set the final HTTPS origin in `~/.config/agent-remote/config.toml` (or `$XDG_CONFIG_HOME/agent-remote/config.toml`):

```toml
[server]
behind_reverse_proxy = true
public_origin = "https://agent-remote.example.com"
```

Start or restart Agent Remote behind your TLS reverse proxy, then run this in a shell on the host:

```bash
agent-remote auth init
```

The command prints a single-use setup code and URL valid for ten minutes. Open the URL, enter the code, register a passkey, add the displayed secret to your authenticator app, and confirm a six-digit code. Save the recovery codes shown at the end; they are not displayed again.

```bash
agent-remote auth status       # non-secret enrollment status
agent-remote auth reset --yes  # remove credentials and sessions; restart afterward
```

Changing `public_origin` changes the WebAuthn relying party. Reset and re-enroll authentication if the public hostname changes. See [Authentication](docs/authentication.md) for the complete setup and recovery model.

## Architecture

| Component | Role |
|-----------|------|
| `cmd/agent-remote/` | CLI — serve, install, uninstall, deploy, sessiond, doctor |
| `internal/sessiond/` | PTY daemon — workspace/pane registry, VT emulation, reconnect replay |
| `internal/server/` | HTTP + WebSocket relay, auth, browser-pane proxy |
| `internal/service/` | Cross-platform service install (systemd/launchd) |
| `internal/deploy/` | Push-to-remote via SSH |
| `web/src/` | Lit web components, xterm.js terminal rendering, dockview split layout |

### Session daemon

`sessiond` is a separate Unix socket daemon that manages PTYs independently of the HTTP server. Each pane is a real PTY running `$SHELL`. The daemon auto-starts when the first browser client connects, and keeps running when the server restarts.

For reconnect, `sessiond` runs a headless VT emulator (`charmbracelet/x/vt`) per pane with 2000-line scrollback. On attach, it serializes the live cell grid and sends it as a clean replay — so reconnecting to a vim session doesn't produce garbage at the wrong terminal size.

### Protocol

One WebSocket per browser tab, backed by one Unix socket connection to `sessiond`. Frames are binary-prefixed: `[4-byte length][1-byte kind][payload]`. Pane I/O is raw bytes with a 4-byte pane ID prefix. Control messages are JSON. The protocol is frozen — sessiond and the HTTP relay can be updated independently as long as the frame format is stable.

## Requirements

- **Go** 1.24.2+ (the pinned toolchain is Go 1.24.4)
- **Node.js** 18+

## Development

```bash
# Build everything (frontend + Go binary)
make build

# Run Go tests
make test

# Build frontend only
cd web && npm install && npm run build

# Run frontend tests
cd web && npm test

# Fast frontend checks (lint + types, no build)
cd web && npm run check:fast
```

The macOS desktop-v1 cutover, browser gate, non-root ownership checks, and rollback exercise are
documented in the [desktop v1 development release runbook](docs/releases/desktop-v1-development.md).

## Design

See [docs/design.md](docs/design.md) for architecture details and decision rationale.

## License

MIT

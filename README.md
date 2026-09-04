# [JustTerminal](https://justterminal.com)

Persistent terminal workspaces for your browser.

JustTerminal runs shells and coding agents on a Host, while the UI runs in a browser or installed PWA. Organize work into named Workspaces, arrange terminal Panes as tabs or splits, disconnect, and return without tying a Terminal Session's lifetime to one browser tab.

![JustTerminal workspace with Codex, Markdown and JavaScript viewers, and the project file tree](docs/visual-reference/just-terminal-desktop-v1.png)

## Install

Tagged releases publish checksummed native archives for Linux amd64 and macOS,
and can be installed on Linux with:

```bash
curl -fsSL https://raw.githubusercontent.com/maxbaines/just-terminal/main/install.sh | bash
```

Container deployments should continue to update by pulling and redeploying the
image. The in-app updater deliberately does not rewrite binaries in containers.

JustTerminal is under active development. Release archives are available from
[GitHub Releases](https://github.com/maxbaines/just-terminal/releases); the
Homebrew tap is not yet published.

## Highlights

- **Persistent Terminal Sessions** — the Session Owner keeps PTYs alive when browsers disconnect or the Gateway restarts.
- **Workspaces, tabs, and splits** — group related work, drag to resize, and nest Pane Groups with dockview.
- **Clean reconnects** — server-side VT emulation replays the live screen instead of dumping a stale raw byte stream.
- **Desktop and mobile controls** — configurable Keybindings, touch-safe Pane actions, a mobile modifier-key bar, and voice input where the browser supports it.
- **Terminal file links** — open detected source, text, log, and Markdown paths in read-only in-app viewers.
- **Nine bundled themes** — coordinated terminal palettes and browser chrome, applied immediately to open terminals.
- **Self-hosted authentication** — passkey-first remote sign-in with TOTP and one-use recovery codes; no identity SaaS or external database.
- **Agent integration** — a local MCP server can operate Workspaces, Panes, terminals, tunnels, and configuration.
- **Single application binary** — the Go Gateway embeds the built web client; only the separate Session Owner process stays behind to own PTYs.

## Build and run

### Requirements

- A Unix-like Host: macOS, Linux, or WSL2
- Go 1.24.4 (the version pinned by `go.mod`)
- Node.js 22 and npm

```bash
git clone https://github.com/maxbaines/just-terminal.git
cd just-terminal
make build
./bin/just-terminal
```

Running `just-terminal` without a subcommand starts the local Gateway at `http://127.0.0.1:8311` and opens it in your browser. Loopback access needs no authentication.

## Remote access

Put JustTerminal behind an HTTPS reverse proxy and give it the final public origin:

Hosted instances use `https://{instance}.js.actor`; self-hosted deployments can
use any final HTTPS origin they control.

```bash
./bin/just-terminal serve \
  --addr 127.0.0.1:8080 \
  --behind-reverse-proxy \
  --public-origin https://terminal.example.com \
  --tunnel-origin 'https://{id}.apps.example.com'
```

Then create the single-use owner-enrollment link on the Host:

```bash
./bin/just-terminal auth init --origin https://my-instance.js.actor
```

Open the printed URL, register a passkey, enroll TOTP, and save the recovery codes. Passkeys are scoped to the configured hostname, so choose the final HTTPS origin before enrolling. The reverse proxy must forward both normal HTTP traffic and WebSocket upgrades.

See [Authentication](docs/authentication.md) for setup, recovery, storage, and reset details.

## Docker and Coolify

The repository Dockerfile builds JustTerminal on top of the Codex universal image and includes Codex CLI, Claude Code, zsh, GitHub CLI, Starship, delta, lazygit, and yazi. It listens on container port `8311`.
New terminal panes start in `/workspace` by default.

For a Coolify deployment:

1. Build from the repository `Dockerfile`.
2. Expose port `8311` through an HTTPS domain.
3. Set `JUST_TERMINAL_PUBLIC_ORIGIN` to that exact origin (for example,
   `https://terminal.example.com`).
4. To expose local apps, route a wildcard hostname to the same container and set
   `JUST_TERMINAL_TUNNEL_ORIGIN` (for example,
   `https://{id}.apps.example.com`). See [Local app tunnels](docs/local-app-tunnels.md).
5. Add persistent storage for the paths below.

| Destination | Contents |
|---|---|
| `/var/lib/just-terminal` | JustTerminal auth/config, shell history, Git/GitHub/npm settings, SSH/GnuPG state, and other XDG state |
| `/root/.codex` | Codex configuration, file-backed login, skills/plugins, and resumable sessions |
| `/root/.claude` | Claude Code configuration, login, and sessions |
| `/workspace` | Repositories and working files |

Do not persist `/run/just-terminal`; it contains runtime-only sockets. Treat the persisted volumes as sensitive because they can contain access tokens, private keys, and shell history.

### What persistence means

The Session Owner survives Remote Client disconnects and Gateway restarts, so live shells continue through a web-server restart or binary redeploy that leaves the Session Owner running.

A Host reboot, container replacement, or Session Owner stop still terminates live PTYs and their processes. Persistent volumes preserve files, configuration, resumable agent history, and the workspace names shown in the sidebar. Restored workspaces start with fresh panes; volumes cannot preserve a running shell process.

## Expose a local web app

Web apps running on the JustTerminal Host or inside its container can be reached through the existing JustTerminal URL. Start the app on a local port, for example:

```bash
npm run dev -- --host 127.0.0.1 --port 5173
```

Register that port with JustTerminal:

```bash
curl -sS \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{"port":5173}' \
  http://localhost:8311/api/tunnels
```

The response includes a short tunnel ID and a capability URL on the configured
wildcard origin:

```json
{"id":"a7k2q","port":5173,"url":"https://a7k2q.apps.example.com/_just-terminal/connect#token=…"}
```

Open the returned URL. The app receives its own hostname root, so ordinary
`/assets`, `/api`, cookies, redirects, and WebSockets work without application
changes. No additional container port needs to be published. Tunnel
registrations last until the JustTerminal Gateway restarts.

Wildcard DNS, TLS, and reverse-proxy routing must be configured once by the
operator. See [Local app tunnels](docs/local-app-tunnels.md) for Caddy, Apache,
Traefik, and Coolify recipes.

## Agent integration with MCP

`just-terminal mcp` exposes a [Model Context Protocol](https://modelcontextprotocol.io) server over JSON-RPC 2.0 on stdio. It connects to a running local JustTerminal instance and currently provides 17 tools:

- terminal input, command completion, and screen observation;
- Workspace and Pane lifecycle and layout;
- port-forward tunnel lifecycle; and
- live configuration reads and updates.

It also exposes current terminal screens as `pane://` resources.

### Amplifier

```bash
just-terminal amplifier install
```

### Claude Code

```bash
claude mcp add just-terminal -- just-terminal mcp
```

### OpenCode

Add this server to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "just-terminal": {
      "type": "local",
      "command": ["just-terminal", "mcp"]
    }
  }
}
```

## CLI

| Command | Purpose |
|---|---|
| `just-terminal` | Start locally on `127.0.0.1:8311` and open a browser |
| `just-terminal serve` | Start a Gateway for local or reverse-proxied access |
| `just-terminal install` | Install systemd or launchd services |
| `just-terminal uninstall` | Remove the installed services |
| `just-terminal deploy user@host` | Copy and install the current binary over SSH |
| `just-terminal doctor` | Inspect Gateway, Session Owner, and service health |
| `just-terminal session list\|attach` | List Workspaces or inspect a Workspace's Pane composition |
| `just-terminal pane create\|close\|resize` | Script Pane lifecycle and PTY sizing |
| `just-terminal read-screen <pane>` | Read the live screen or page backward through server-side scrollback |
| `just-terminal layout get` | Print a Workspace's current layout as an ASCII diagram |
| `just-terminal auth ...` | Initialize, inspect, or reset owner authentication |
| `just-terminal mcp` | Start the local stdio MCP server |
| `just-terminal amplifier install` | Install the JustTerminal Amplifier bundle |
| `just-terminal version` | Print version information |

Run `just-terminal <command> --help` for command-specific flags.

## How it works

```text
Remote Client (browser or installed PWA)
    ↕ WebSocket
Gateway (Go HTTP server, auth, configuration, file and tunnel APIs)
    ↕ Unix socket
Session Owner (Workspace registry, PTYs, VT buffers, replay)
    ↕ PTY
shells and coding agents
```

Each Pane is backed by a real PTY. The Session Owner, not the browser, owns terminal state and answers terminal queries. The Gateway can therefore restart independently, and a reconnecting Remote Client receives a fresh serialization of the current VT cell grid plus retained scrollback.

Close controls are also Session Owner-authoritative. Idle Bash and Zsh panes close immediately; panes with running commands require confirmation. Codex/driver panes are treated as busy, while browser panes and panes whose activity cannot be inspected are treated as unknown and fail safe to confirmation.

The browser renders terminals with xterm.js and arranges Pane Groups with dockview. One WebSocket carries binary Pane I/O and JSON control messages between a Remote Client and the Gateway.

## Development and verification

Build and run the isolated local development stack:

```bash
make build
make dev-local
```

Before committing, run the required static checks:

```bash
cd web && npm run check:fast
cd .. && go build ./...
```

JustTerminal does not accept new unit tests. Changes are verified against a real Gateway, Session Owner, shell, and browser. Start every verification pass with a fresh development runtime and a newly created Workspace and Pane, then exercise the behavior with `playwright-cli`:

```bash
playwright-cli open http://127.0.0.1:8313
playwright-cli snapshot
# interact with the real UI and inspect the result
playwright-cli close
```

Read [AGENTS.md](AGENTS.md) before contributing; it contains the full verification policy and fixture-hygiene requirements.

## Documentation

- [Authentication and recovery](docs/authentication.md)
- [Remote Client protocol](docs/just-terminal-client-protocol.md)
- [Current desktop theme and visual design](DESIGN.md)
- [Product terminology](CONTEXT.md)
- [Fork provenance and upstream policy](docs/fork-provenance.md)

JustTerminal is an upstream-aware fork of muxterm. The provenance document records the pinned source revision, compatibility boundaries, and update policy.

## License

[MIT](LICENSE)

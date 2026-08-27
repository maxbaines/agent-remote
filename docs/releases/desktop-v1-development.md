# Desktop v1 development release

**Release source:** issue #7 development cut; record the published commit in the release record

**Prerequisite commits:** `fa0893a`, `fb21c2a`, `40af1b6`, `43b92ab`, `60af447`

This is the clean development cutover for JustTerminal desktop v1. It combines browser-local
Keybindings, explicit tab and directional Split Commands, macOS-style `Cmd+K`, and the fixed
JustTerminal appearance. It runs the Gateway, Session Owner, and Terminal Sessions as the
invoking non-root Host user.

This cut does not migrate root-owned PTYs. Existing development sessions may be stopped, and a
new user-scoped runtime is created. Do not copy a root-owned Session Owner socket or attempt to
adopt its Terminal Sessions.

## Release gate

On macOS, run the complete gate from a clean worktree:

```bash
make verify-desktop-v1
```

The target builds the embedded web client and Go binary; runs the fast frontend checks, Go build,
existing automated tests, and `go vet`; then gives every browser scenario a newly started Gateway,
Session Owner, Workspace, and Pane. The release launcher rejects uid 0 and verifies that the
Gateway process, Session Owner process, Unix socket, and a shell command in the new Terminal
Session all report the invoking uid.

The Chromium cases cover the combined desktop smoke plus detailed create-tab, browser-local
Keybinding, directional Split, clear/reconnect, and fixed-appearance scenarios. The macOS run also
drives installed Safari through `safaridriver` for a serious-regression smoke. Safari parity and
mobile controls are not release blockers, but Safari must load the application, attach an Active
Pane, reach `/api/health`, and resolve the v1 Command and appearance surfaces. Safari automation
must be enabled under **Safari > Develop > Allow Remote Automation**; `safaridriver --enable`
performs the one-time WebDriver setup on a development Mac.

If policy prevents enabling Safari WebDriver, open the same fresh-runtime URL in installed Safari,
confirm the sidebar, Active Pane, prompt, and fixed chrome render without a serious regression,
and capture that observation in the release record. Only then run the automated portion with
`JUST_TERMINAL_SKIP_SAFARI=1 make verify-desktop-v1`. On a non-macOS builder the variable simply
skips an unavailable browser; neither use substitutes for recording the required macOS Safari
observation.

## Install the development cut

Keep the last known-good development binary before replacing it. These paths are intentionally
development-only and do not touch a system service or the stable binary in `~/.local/bin`.

```bash
mkdir -p tmp/desktop-v1-cutover
test ! -x bin/just-terminal || cp bin/just-terminal tmp/desktop-v1-cutover/just-terminal.previous
make build
install -m 0755 bin/just-terminal tmp/desktop-v1-cutover/just-terminal.current
```

Stop the previous development Gateway and Session Owner. Root-owned development sessions are
terminated rather than migrated. Start the cut directly as the intended non-root user with a clean
runtime:

```bash
test "$(id -u)" -ne 0
# Keep this path short: macOS limits Unix-domain socket paths to 104 bytes.
export JUST_TERMINAL_DESKTOP_V1_RUNTIME="$HOME/.just-terminal-desktop-v1-cutover"
mkdir -p "$JUST_TERMINAL_DESKTOP_V1_RUNTIME"
XDG_RUNTIME_DIR="$JUST_TERMINAL_DESKTOP_V1_RUNTIME" \
  tmp/desktop-v1-cutover/just-terminal.current serve \
  --addr 127.0.0.1:8313 --no-auth
```

`--no-auth` is limited to this loopback development cut. It is not a public deployment recipe.

## Health and ownership checks

From a second terminal using the same runtime:

```bash
curl -fsS http://127.0.0.1:8313/api/health
XDG_RUNTIME_DIR="$JUST_TERMINAL_DESKTOP_V1_RUNTIME" \
  tmp/desktop-v1-cutover/just-terminal.current doctor
ps -axo pid,uid,user,command | grep '[a]gent-remote.*\(serve\|sessiond\)'
stat -f '%Su %u %N' "$JUST_TERMINAL_DESKTOP_V1_RUNTIME/just-terminal/sessiond.sock"
```

Create a new Pane in the browser and run `id -u` inside it. The value must match the uid printed by
the process and socket checks and must not be `0`. Exercise create tab, all four Split directions,
the Keybindings editor, `Cmd+K`, and a reload before accepting the cut.

## Rollback exercise

The rollback is a binary replacement plus a fresh development runtime, not a PTY migration:

1. Stop the desktop-v1 Gateway and Session Owner.
2. Confirm `tmp/desktop-v1-cutover/just-terminal.previous` exists and is executable.
3. Start that binary as the same non-root user with a newly created runtime directory and a free
   loopback port.
4. Confirm `/api/health`, `just-terminal doctor`, browser startup, and a new Pane running `id -u`.
5. Stop the rollback processes. Restart `just-terminal.current` with another fresh runtime to return
   to desktop v1.

The release record should include the current and rollback commit hashes, the commands actually
run, and the observed uid. A failed rollback is a release blocker.

## Explicit deferrals

- Control Lease and multi-client focus/resize authority
- Durable device-aware authentication, pairing, revocation, and audit history
- Mobile controls and Safari parity
- Customizable Themes, palettes, typography, density, and custom chrome colours

Desktop v1 deliberately keeps one fixed appearance and browser-local Keybindings. These deferrals
must not be reintroduced as hidden configuration or migration compatibility work in this cut.

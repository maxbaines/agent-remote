# Desktop v1 development release verification

**Date:** 24 August 2026

**Host:** macOS, arm64

**Release source:** issue #7 worktree on `60af4474f7001d39f932ae186dee7e3ab3fbf324`

**Rollback source:** archived `60af4474f7001d39f932ae186dee7e3ab3fbf324` build

**Host user:** `max`, uid `501`

## Automated release gate

`AGENT_REMOTE_SKIP_SAFARI=1 make verify-desktop-v1` passed after the separate installed-Safari
observation below. The target completed:

- production frontend and embedded Go build;
- fast frontend type and lint checks;
- `go build ./...`, `go test ./...`, and `go vet ./...`;
- combined desktop Chromium smoke;
- create-tab Command and reconnect coverage;
- browser-local Keybinding editing, conflicts, persistence, and reset;
- explicit left, right, up, and down Split placement plus reconnect;
- macOS `Cmd+K` normal-screen, observer-client, alternate-screen, and reconnect behavior;
- fixed appearance, contrast, state, Settings, and product-branding checks.

Every Chromium case used a new runtime, Workspace, and Pane. The launcher rejected uid 0 and
confirmed the Gateway process, Session Owner process, Session Owner socket, and a shell command
inside the new Terminal Session all used uid `501`.

## Safari serious-regression smoke

Installed Safari 18.1.1 opened the fresh runtime at `http://127.0.0.1:18437`. Visual inspection
confirmed the Agent Remote sidebar, Workspace, active shell Pane and prompt, tab strip, and fixed
desktop chrome rendered without a serious regression.

The WebDriver attempt correctly reported that **Allow Remote Automation** was disabled. Enabling it
requires administrator authentication on this Host, so the release used the runbook's recorded
installed-Safari visual fallback. Safari parity was not claimed.

## Install and rollback exercise

The working-tree binary was installed as `agent-remote.current`. A previous binary was compiled
from an archive of the rollback source with the already-verified embedded web assets and installed
as `agent-remote.previous`. Their SHA-256 digests differed, confirming the exercise swapped distinct
artifacts:

- current: `9a6bb48b1ca855bba7b13b0eef736e34f2f69a7eb1b402ba92395581d4b214c9`
- previous: `13b68dee84323f743d68d3d3dd2e7134ca04196e62f7a1ebd43267d7a03eabf6`

The sequence was exercised with a fresh runtime at every step:

1. Current install on `127.0.0.1:18501`: `/api/health`, combined Chromium smoke, `doctor`, socket
   ownership, Session Owner ownership, and Terminal Session uid passed.
2. Previous rollback on `127.0.0.1:18502`: the same checks passed.
3. Current restore on `127.0.0.1:18503`: the same checks passed.

No root-owned socket or PTY was adopted. All Gateways, Session Owners, browser automation sessions,
and terminal processes were stopped after verification. Isolated release and rollback fixtures were
moved to Trash.

## Deferred surfaces checked

Control Lease, durable device-aware authentication, mobile controls, and customizable Themes remain
deferred. The release adds no migration framework, root-owned PTY adoption, custom-colour setting,
or Safari-parity claim.

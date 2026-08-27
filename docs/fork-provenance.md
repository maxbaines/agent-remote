# Fork provenance

JustTerminal began from the muxterm v0.10.0 lineage. The pinned source revision for this fork is:

`4e848776816a265ce339132a38a1abea19b81adf`

The previously deployed development baseline was muxterm v0.10.0. JustTerminal keeps the upstream PTY, Session Owner, Gateway framing, WebSocket relay, VT replay, and terminal protocol architecture intact; the initial fork cut changes product identity and namespaces, not terminal semantics.

## Upstream policy

The canonical fork remote is `https://github.com/maxbaines/just-terminal.git`. Maintainers should also configure `https://github.com/kenotron-ms/muxterm.git` as the `upstream` remote.

Upstream changes are reviewed and selectively cherry-picked. Authentication, Session Owner, Gateway, service-install, and protocol changes require explicit compatibility review. JustTerminal does not promise clean rebases onto later muxterm releases.

## Namespaces and compatibility

Supported identities use the `just-terminal` slug: the Go module, binary, release archives, package names, service units, launch agent, configuration directory, runtime directory, browser storage, cookies, OAuth clients, MCP server, and Amplifier bundle. This separate namespace lets JustTerminal coexist with a muxterm installation. Existing muxterm configuration, services, sockets, and sessions are not silently adopted or mutated.

Legacy `muxterm` references remain only in these provenance or compatibility locations:

- Git history, the upstream copyright notice in `LICENSE`, and the pinned upstream remote identify the source project.
- `PRD.md`, `SETUP.md`, `AGENTS.md`, the root `ARCHITECTURE.md`, and upstream architecture, verification, release-note, and dated design records under `docs/` describe the previously deployed muxterm environment or historical decisions. Root `DESIGN.md` is JustTerminal's current visual reference.
- Existing internal `mux-*` web-component names, CSS custom properties, DOM classes and test hooks, logger symbols, and proxy-message identifiers are compatibility names inherited from upstream. They are not installed package, service, configuration, or user-facing product identities; renaming them would add protocol and rendering risk to an identity-only baseline.

The frozen Session Owner control-message values and binary framing are intentionally unchanged. Future upstream imports should preserve those contracts unless a separately reviewed protocol change explicitly versions them.

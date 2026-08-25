# Agent Remote desktop themes

**Status:** Canonical desktop appearance reference
**Scope:** Bundled terminal palettes, theme-derived browser chrome, typography, spacing, and visual states

Agent Remote is terminal-first: terminal content carries the most visual weight and the
surrounding controls stay quiet. Users can choose one of nine bundled themes in Settings;
the Host persists that choice and broadcasts it to connected Remote Clients. Theme changes
apply immediately to existing Terminal Sessions and browser chrome. Arbitrary theme editing and
custom title-bar colours remain out of scope.

The executable source of truth is `web/src/lib/theme.ts`; this document defines its intended
behavior and component treatments. `web/e2e/fixed-appearance.mjs` checks the same behavior in a
real browser against a real Gateway and Session Owner.

## Bundled themes

| Theme ID | Display name | Mode |
|---|---|---|
| `tokyo-night` | Tokyo Night | Dark, default |
| `cmux` | cmux (Apple System Colors) | Dark, opaque background with 0.92 text fade |
| `catppuccin` | Catppuccin | Dark |
| `gruvbox` | Gruvbox | Dark |
| `dracula` | Dracula | Dark |
| `nord` | Nord | Dark |
| `solarized-light` | Solarized Light | Light |
| `one-light` | One Light | Light |
| `github-light` | GitHub Light | Light |

Unknown theme IDs safely resolve to Tokyo Night in the browser. The selected ID is stored as
`[theme].palette` in the Agent Remote configuration and included in `/api/config` and the initial
WebSocket config envelope.

Terminal backgrounds are always fully opaque and xterm transparency is disabled. The cmux palette
uses a subtle `0.92` opacity on xterm's rendered glyph layer instead, preserving the softened look
of a translucent native terminal without exposing browser content behind the terminal.

## Default colour reference

### Terminal palette

| Role | Value |
|---|---:|
| Background / cursor accent | `#1a1b26` |
| Foreground / white | `#a9b1d6` |
| Cursor / bright white | `#c0caf5` |
| Selection | `#283457` |
| Black | `#15161e` |
| Bright black | `#414868` |
| Red / error | `#f7768e` |
| Green / connected | `#9ece6a` |
| Yellow / warning / attention | `#e0af68` |
| Blue / focus accent | `#7aa2f7` |
| Magenta / driver accent | `#bb9af7` |
| Cyan | `#7dcfff` |

### Dark browser chrome

| Token | Value | Use |
|---|---:|---|
| `--chrome-bar` | `#16161e` | Sidebar, tab strip, headers |
| `--chrome-body` | `#1a1b26` | Pane and settings body |
| `--chrome-border` | `#292e42` | Hairline separators and pane dividers |
| `--chrome-text-bright` | `#c0caf5` | Active labels and primary controls |
| `--chrome-text-dim` | `#7f89b3` | Inactive labels and secondary copy |
| `--chrome-accent` | `#7aa2f7` | Active tab edge, focus, selected Workspace |
| `--chrome-driver-accent` | `#bb9af7` | Driver-specific focus |
| `--chrome-hover` | `#1f2335` | Pointer hover surface |
| `--chrome-danger` | `#f7768e` | Destructive hover and errors |

Primary and inactive text both maintain at least 4.5:1 contrast on their intended surfaces.
Accent, connected, warning, and error colours maintain at least 3:1 contrast on the terminal
background. Focus never relies on colour alone: the selected tab also gains a 2px top edge,
and selected Workspace cards retain a border.

Light themes use `#e8e8ed` for bars, `#f2f2f7` for body surfaces, `#1c1c1e` for primary text,
and `#636366` for secondary text. The latter maintains at least 4.5:1 contrast on both light
surfaces. Terminal-derived semantic tokens (`--mux-bg`, `--mux-fg`, `--mux-accent`, warning,
error, and connected states) update with every selected palette.

## Typography and density

| Surface | Family | Size / line height | Weight |
|---|---|---|---|
| Terminal | system `Monaco` with monospace fallback | `13px` / `1.0` | regular; terminal-controlled bold |
| Pane tabs | system UI | `0.875rem` | 400 |
| Workspace and controls | system UI | `13px` | 400–600 |
| Utility labels | system UI | `11–12px` | 400–600 |

Spacing uses a 4px base: 4px for tight icon/label gaps, 8px inside dense chrome, 16px for
standard horizontal padding, and 32px between settings sections. Desktop tabs are 80–180px
wide. Controls shared with touch layouts retain a 44px minimum target; desktop-only icon
buttons may be 26–28px.

## Component states

| Surface/state | Treatment |
|---|---|
| Terminal surface | Selected palette background; no contrasting sliver around xterm rows |
| Active tab in focused group | Body background, bright text, 2px accent top edge |
| Inactive tab | Bar background and dim text; close control appears on hover |
| Visible tab in unfocused split | Body background and terminal foreground; no blue top edge |
| Pane divider | One-pixel chrome border; resize sash uses the accent only while dragging |
| Workspace active | Hover surface plus accent border and active dot |
| Workspace inactive | Transparent bar surface and dim dot; hover surface on pointer hover |
| Keyboard focus | Accent outline or border with at least 2px visible extent |
| Warning / attention | Theme warning token; pane and Workspace attention uses a visible dot prefix |
| Error / disconnected | Theme error token; reconnect overlay remains above transient toasts |
| Connected | Theme success token |
| Destructive hover | Danger foreground, never the normal control state |

Terminal tabs, split dividers, sidebar, title bar, menus, overlays, settings, warning states,
and error states consume semantic CSS tokens. Components must not bypass those tokens with a
second palette or persist ad-hoc colour overrides.

## Representative capture

`docs/visual-reference/agent-remote-desktop-v1.png` is the committed Chromium reference at
1440×900. It shows the sidebar, active and inactive tabs, split groups, terminal surfaces,
pane divider, and desktop controls. Regenerate it only from a fresh runtime with:

```bash
node web/e2e/fixed-appearance.mjs \
  --url http://127.0.0.1:8313 \
  --capture docs/visual-reference/agent-remote-desktop-v1.png
```

The script switches between dark and light themes, checks live xterm and chrome updates, verifies
Host persistence across reload, rejects stale browser-local title-bar colour application, checks
contrast, and rejects inherited product branding.

# Agent Remote desktop appearance

**Status:** Canonical desktop v1 reference
**Scope:** Fixed terminal palette, browser chrome, typography, spacing, and visual states

Agent Remote is terminal-first: terminal content carries the most visual weight and the
surrounding controls stay quiet. Desktop v1 ships one appearance. It has no theme selector,
theme editor, light-mode branch, custom-title-bar colour, or browser/server theme persistence.

The executable source of truth is `web/src/lib/theme.ts`; this document fixes its intended
values and component treatments. `web/e2e/fixed-appearance.mjs` checks the same values in a real
browser against a real Gateway and Session Owner.

## Fixed colour reference

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

### Browser chrome

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

## Typography and density

| Surface | Family | Size / line height | Weight |
|---|---|---|---|
| Terminal | bundled `JetBrainsMonoNerdFont` | `13px` / `1.0` | regular; terminal-controlled bold |
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
| Terminal surface | Fixed terminal background; no contrasting sliver around xterm rows |
| Active tab in focused group | Body background, bright text, 2px blue top edge |
| Inactive tab | Bar background and dim text; close control appears on hover |
| Visible tab in unfocused split | Body background and terminal foreground; no blue top edge |
| Pane divider | One-pixel chrome border; resize sash turns blue only while dragging |
| Workspace active | Hover surface plus blue border and active dot |
| Workspace inactive | Transparent bar surface and dim dot; hover surface on pointer hover |
| Keyboard focus | Blue outline or border with at least 2px visible extent |
| Warning / attention | Yellow; pane and Workspace attention uses a visible dot prefix |
| Error / disconnected | Red text/indicator; reconnect overlay remains above transient toasts |
| Connected | Green status indicator |
| Destructive hover | Red foreground, never the normal control state |

Terminal tabs, split dividers, sidebar, title bar, menus, overlays, settings, warning states,
and error states consume these fixed semantic tokens. Components must not introduce a second
palette or persist colour overrides.

## Representative capture

`docs/visual-reference/agent-remote-desktop-v1.png` is the committed Chromium reference at
1440×900. It shows the sidebar, active and inactive tabs, split groups, terminal surfaces,
pane divider, and desktop controls. Regenerate it only from a fresh runtime with:

```bash
node web/e2e/fixed-appearance.mjs \
  --url http://127.0.0.1:8313 \
  --capture docs/visual-reference/agent-remote-desktop-v1.png
```

The script also rejects a theme field in the live config API, theme/custom-colour controls in
Settings, stale browser-local title-bar colour application, insufficient state contrast, and
inherited product branding.

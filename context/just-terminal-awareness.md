# JustTerminal

JustTerminal is a persistent browser terminal workspace. When this bundle is loaded, you have access
to `mcp_just_terminal_*` tools that control a running JustTerminal instance — create Panes, run shell
commands, manage Workspaces, and automate browser Panes.

**Prerequisite:** JustTerminal must be running before these tools will work.
Start it with `just-terminal` (local mode) or `just-terminal serve` (remote access).

## Available Tool Groups

| Group | Tools |
|-------|-------|
| Workspaces | `mcp_just_terminal_create_workspace`, `list_workspaces`, `switch_workspace`, `close_workspace` |
| Panes | `mcp_just_terminal_create_pane`, `list_panes`, `get_layout`, `rename_pane`, `close_pane` |
| Terminal | `mcp_just_terminal_run_command`, `send_input`, `get_screen` |
| Browser | `mcp_just_terminal_browser_snapshot`, `browser_goto`, `browser_click`, `browser_fill`, and more |

## When to Delegate to just-terminal-expert

For complex JustTerminal workflows — multi-Pane setups, running and observing commands, browser
automation across panes — delegate to `just-terminal:just-terminal-expert`. It carries detailed tool
documentation and workflow patterns.

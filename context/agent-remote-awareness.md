# Agent Remote

Agent Remote is a persistent browser terminal workspace. When this bundle is loaded, you have access
to `mcp_agent_remote_*` tools that control a running Agent Remote instance — create Panes, run shell
commands, manage Workspaces, and automate browser Panes.

**Prerequisite:** Agent Remote must be running before these tools will work.
Start it with `agent-remote` (local mode) or `agent-remote serve` (remote access).

## Available Tool Groups

| Group | Tools |
|-------|-------|
| Workspaces | `mcp_agent_remote_create_workspace`, `list_workspaces`, `switch_workspace`, `close_workspace` |
| Panes | `mcp_agent_remote_create_pane`, `list_panes`, `get_layout`, `rename_pane`, `close_pane` |
| Terminal | `mcp_agent_remote_run_command`, `send_input`, `get_screen` |
| Browser | `mcp_agent_remote_browser_snapshot`, `browser_goto`, `browser_click`, `browser_fill`, and more |

## When to Delegate to agent-remote-expert

For complex Agent Remote workflows — multi-Pane setups, running and observing commands, browser
automation across panes — delegate to `agent-remote:agent-remote-expert`. It carries detailed tool
documentation and workflow patterns.

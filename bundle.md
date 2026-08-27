---
bundle:
  name: just-terminal
  version: 1.0.0
  description: Amplifier bundle for managing JustTerminal — create Panes, run commands, automate browser Panes, manage Workspaces

includes:
  - bundle: git+https://github.com/microsoft/amplifier-foundation@main
  - bundle: just-terminal:behaviors/just-terminal
---

@just-terminal:context/just-terminal-awareness.md

---

@foundation:context/shared/common-system-base.md

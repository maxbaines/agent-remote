---
bundle:
  name: agent-remote
  version: 1.0.0
  description: Amplifier bundle for managing Agent Remote — create Panes, run commands, automate browser Panes, manage Workspaces

includes:
  - bundle: git+https://github.com/microsoft/amplifier-foundation@main
  - bundle: agent-remote:behaviors/agent-remote
---

@agent-remote:context/agent-remote-awareness.md

---

@foundation:context/shared/common-system-base.md

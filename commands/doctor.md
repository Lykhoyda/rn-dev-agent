---
command: doctor
description: Diagnose installation health. Check Node, CDP bridge, agent-device, maestro-runner, simulators, Metro, CDP, injected helpers, ffmpeg, physical devices. Reports what's missing — does NOT modify your project.
argument-hint: 
---

Run the environment-diagnostic checklist from the `rn-setup` skill. Walk all 11 prerequisite checks (Node.js version, CDP bridge dependencies, agent-device CLI, maestro-runner, iOS simulator, Android emulator, Metro dev server, CDP connection, **injected `__RN_AGENT` helpers**, ffmpeg, physical-device prerequisites) and surface install commands for any missing dependencies.

**This command is read-only.** It diagnoses the current environment and recommends fixes. It does NOT modify any files in the user's project, inject documentation, or instrument source code.

Present results as an 11-row table. For any RED rows, give the user the exact install command (with `nvm` / `sudo` / `brew` flag selection based on their environment). For the helpers row specifically, do NOT suggest retrying `cdp_status` — the bridge already auto-retried injection. If MISSING, recommend `device_*` fallbacks or `cdp_reload`.

If the user wants the plugin to also inject project instructions (CLAUDE.md template, nav-ref, store exposure) — point them at `/rn-dev-agent:setup` instead.

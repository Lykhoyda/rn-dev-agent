---
'rn-dev-agent-cdp': minor
'rn-dev-agent-plugin': minor
---

Story 13 (#397) Phases 1–2: maestro-runner engine pinning and a proactive blind-probe. The installer now installs the tested pin (`1.0.9`) exactly, verifies its checksum fail-closed on fresh downloads, and warns on local drift; `cdp_status.replayEngine` + `/doctor` report engine, version-vs-pin, and known quirks; `maestro_run` carries `enginePin` meta and warns once on drift (opt-in hard enforcement: `RN_ENGINE_PIN_STRICT=1`). `cdp_run_action` on at-risk iOS runtimes (>= 26, or a recent device-matched `TRANSPORT_BLIND` with clean-pass reset) probes the CDP tree first and, when the action's anchor is visible, skips the doomed ~40s WDA attempt and replays via CDP/JS directly — `RunRecord` gains additive `deviceId`/`blindProbe`, probe-routed failures classify as `FALLBACK_REPLAY_FAILED` (never false `TRANSPORT_BLIND`), probe-routed passes never auto-promote, and the DB mirror persists the new fields. Opt out with `RN_BLIND_PROBE=0`.

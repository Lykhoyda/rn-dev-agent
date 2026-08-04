---
command: doctor
description: Diagnose installation health. Check Node, CDP bridge, rn-fast-runner (iOS), rn-android-runner (Android), maestro-runner, simulators, Metro, CDP, injected helpers, ffmpeg, physical devices, plugin version, Vercel rules sync. Reports what's missing — does NOT modify your project.
argument-hint: 
---

Run the environment-diagnostic checklist from the `rn-setup` skill. Walk all 17 prerequisite checks (Node.js version, CDP bridge dependencies, **rn-fast-runner build (iOS)**, **rn-android-runner build/install (Android)**, maestro-runner, iOS simulator, Android emulator, Metro dev server, CDP connection, **injected `__RN_AGENT` helpers**, ffmpeg, **idb (screen-mirror fast path)**, physical-device prerequisites, **plugin version freshness**, **Vercel rules sync freshness**, **CDP auto-reconnect mode**, **linked-worktree private context**) and surface install commands for any missing dependencies.

iOS device automation is owned by the in-tree `rn-fast-runner` XCTest project (D1219, PR #164); Android device automation is owned by the in-tree `rn-android-runner` (UiAutomator instrumentation). These in-tree runners are the sole device backend — there is no external CLI to install. Mark `rn-android-runner` as N/A on iOS-only setups and `rn-fast-runner` as N/A on Android-only / non-macOS setups. If a device tool fails with RUNNER_PROTOCOL_MISMATCH, the installed/prebuilt runner artifact predates the plugin's wire protocol: on iOS delete packages/rn-fast-runner/build/DerivedData and re-open the device session (or re-run xcodebuild build-for-testing); on Android re-run ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest and adb install -r both APKs.

**This command is read-only.** It diagnoses the current environment and recommends fixes. It does NOT modify any files in the user's project, inject documentation, or instrument source code.

Present results as a 17-row table. Follow the detailed probes and remediation
rules in `rn-setup`; do not infer runner provenance, helper availability, or
auto-reconnect configuration from passive `cdp_status`.

For the **linked-worktree private context** row, run the packaged
`worktree-inheritance` helper in `plan` mode (check 14 in `rn-setup`). Report a
`refusal` as the row's status when present. Otherwise label every returned
resource separately inside that one row — each with its own regime, app-relative
destination, and state, since they are classified independently. Always run and
append the `hook status` result, including on a refusal: the integration is
diagnosed independently of the plan. Never print an absolute private source path, never read a
private file, and never create or repair a link here — that is
`/rn-dev-agent:setup`'s job.

For **idb**, require both a healthy `idb --help` and `idb_companion`; an active
install PID is INSTALLING, otherwise report MISSING and the documented install
command. This row is YELLOW because mirroring has a screenshot fallback.

For runner provenance, inspect the runner artifact/state metadata documented by
`rn-setup`. For helpers, use a narrow gated CDP read. For CDP auto-reconnect,
resolve `RN_CDP_AUTOCONNECT` over `.rn-agent/config.json`, then the default.

For plugin-version or Vercel-rule drift, report the documented command but do
not execute it. Offline version checks do not fail the plugin.

If the user wants the plugin to also inject project instructions (CLAUDE.md template, nav-ref, store exposure) — point them at `/rn-dev-agent:setup` instead.

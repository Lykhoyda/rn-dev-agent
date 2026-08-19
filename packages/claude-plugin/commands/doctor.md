---
command: doctor
description: Diagnose installation health. Check Node, CDP bridge, rn-fast-runner (iOS), rn-android-runner (Android), maestro-runner, simulators, Metro, CDP, injected helpers, ffmpeg, physical devices, plugin version, Vercel rules sync. Reports what's missing — does NOT modify your project.
argument-hint: 
---

Run the environment-diagnostic checklist from the `rn-setup` skill. Walk all 17 prerequisite checks (Node.js version, CDP bridge dependencies, **rn-fast-runner build (iOS)**, **rn-android-runner build/install (Android)**, maestro-runner, iOS simulator, Android emulator, Metro dev server, CDP connection, **injected `__RN_AGENT` helpers**, ffmpeg, **idb (screen-mirror fast path)**, physical-device prerequisites, **plugin version freshness**, **Vercel rules sync freshness**, **CDP auto-reconnect mode**, **linked-worktree action inheritance**) and surface install commands for any missing dependencies.

iOS device automation is owned by the in-tree `rn-fast-runner` XCTest project (D1219, PR #164); Android device automation is owned by the in-tree `rn-android-runner` (UiAutomator instrumentation). These in-tree runners are the sole device backend — there is no external CLI to install. Mark `rn-android-runner` as N/A on iOS-only setups and `rn-fast-runner` as N/A on Android-only / non-macOS setups. If a device tool fails with RUNNER_PROTOCOL_MISMATCH, the installed/prebuilt runner artifact predates the plugin's wire protocol: on iOS delete packages/rn-fast-runner/build/DerivedData and re-open the device session (or re-run xcodebuild build-for-testing); on Android re-run ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest and adb install -r both APKs.

**This command is read-only.** It diagnoses the current environment and recommends fixes. It does NOT modify any files in the user's project, inject documentation, or instrument source code.

Present results as a 17-row table. Follow the detailed probes and remediation
rules in `rn-setup`; do not infer runner provenance, helper availability, or
auto-reconnect configuration from passive `cdp_status`.

For **linked-worktree action inheritance**, resolve the RN app root and run the packaged `worktree-inheritance.js plan --host claude --app-root <app> --json`. Report `.rn-agent/actions` as tracked, inherited, missing, legacy-migration-needed, unsafe, or refused. Also report `hook status`. Never apply, repair, install a hook, print a private source path, or inspect an action body from doctor.

For **idb**, require both a healthy `idb --help` and `idb_companion`; an active
install PID is INSTALLING. A client on PATH whose `idb --help` fails is BROKEN,
not MISSING — report it as installed but not responding, naming the Python 3.14
interpreter incompatibility as the *probable* cause rather than a certainty (the
probe cannot separate a crash from a timeout or EACCES), and give the pinned
repair command, never a bare `pipx install fb-idb`. On a machine with no
supported interpreter, prefix that command with `brew install python@3.13 &&`.
Otherwise report MISSING and the documented install command. This row is YELLOW
because mirroring has a screenshot fallback.

For runner provenance, inspect the runner artifact/state metadata documented by
`rn-setup`. For helpers, use a narrow gated CDP read. For CDP auto-reconnect,
resolve `RN_CDP_AUTOCONNECT` over `.rn-agent/config.json`, then the default.

For plugin-version or Vercel-rule drift, report the documented command but do
not execute it. Offline version checks do not fail the plugin.

For **session-authority health**, run the packaged read-only probe from the RN app root:
`node "${CLAUDE_PLUGIN_ROOT:-${RN_DEV_AGENT_CODEX_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:?set it to the installed rn-dev-agent plugin root, then re-run}}}/rn-dev-agent-core/dist/session-doctor.js" report --json`. The report is
three-state: GREEN when `sameRootOwner` is `absent` and `wedged` and `repairable` are both
false, YELLOW when `repairable` is true (a proven-dead owner of this exact root, which the
next transport start or the repair command releases on its own) or `sameRootOwner` is
`live` (another session holds this worktree right now — report its `ownerSession` and
`ownerAppRoot` instead of GREEN; it is never released and clears when that session closes),
and RED when `wedged` is true. On RED, name the exact
cause it returns rather than a generic stale-lock story:
`sameRootOwner: unprovable` (the recorded owner's process identity cannot be read, so it is
conservatively treated as live), `startupCleanupBlocked` (the owner is proven dead but an
obligation such as `RUNNER_ADOPTION_REQUIRED` could not be discharged), or `ownerIsThisRoot:
false`, whose `ownerMismatch` says which: `app-root` (a proven-dead owner of a different app
root in this worktree) or `source-identity` (the same app root under different declared
manifests). Also
report `abandonedContenders` when it is non-zero. The supported repair is
`node "${CLAUDE_PLUGIN_ROOT:-${RN_DEV_AGENT_CODEX_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:?set it to the installed rn-dev-agent plugin root, then re-run}}}/rn-dev-agent-core/dist/session-doctor.js" repair`, which runs the
same proven-dead startup cleanup a fresh transport runs; print it, and only run it after the
user confirms. Print it rooted where it can succeed: for `ownerMismatch: app-root` that is the
reported `ownerAppRoot`, because repair from the current root can never release another root's
owner. For `ownerMismatch: source-identity` do not re-root it — the payload's own remedy names
the declared-manifest restore that makes this root's repair work. It never releases a live or unprovable owner and there is no force-steal —
do not suggest deleting or moving files in the authority store. Not every stale lock
self-heals: only a *proven*-dead owner does.

If the user wants the plugin to also inject project instructions (CLAUDE.md template, nav-ref, store exposure) — point them at `/rn-dev-agent:setup` instead.

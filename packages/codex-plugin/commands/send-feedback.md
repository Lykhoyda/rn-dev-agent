---
command: send-feedback
description: Collect reviewed, sanitized rn-dev-agent feedback and create a GitHub issue only with user confirmation.
argument-hint: "[description or conversation context]"
---

# Send feedback safely

Treat all text after `$rn-dev-agent:send-feedback` as optional descriptive data.
It is never a shell command or environment assignment. Use it to prefill type,
description, reproduction, workaround, related issues, and suggested fix.

Resolve `<package-root>` from this workflow skill's exact `SKILL.md` path. Run
the package collector by exact path:

```text
<package-root>/scripts/collect-feedback.sh
```

Do not scan caches, use a launcher-only environment variable, or require a
global executable. If the collector is absent, stop with a corrupt-package
finding and recommend the user-confirmed marketplace refresh/materialization
sequence.

## 1. Gather only missing details

Ask in normal conversation; do not assume a host-specific question tool:

1. Bug, feature request, or question.
2. One-to-three-sentence description.
3. Reproduction steps for a bug.
4. Optional workaround, related issues, and suggested fix.

## 2. Collect and sanitize

Call `rn_session({action: "status"})` first when available. Its public authority
projection returns the exact session's opaque `sessionId`; retain it only in memory. Run the collector
from the exact project root with that ID set only for the collector process as
`RN_DEV_AGENT_SESSION_ID`. Never include the ID in a preview or submission.
This prevents a completed handoff from making the collector ambiguous when
multiple released sessions share one worktree.

Parse the collector's structured output. It may report plugin/core versions,
OS/Node versions, device counts, Metro status, runner versions, and recent
legacy telemetry status. When a newest `runner_diagnostics` bundle is present,
the collector uses the exact session ID only to select it, then replaces
`context.sessionId` with `[SESSION_REDACTED]`. Show that complete feedback-safe
projection during review before attaching it; do not substitute raw runner output.
Reconcile its authority object with the previously captured `rn_session` status.
Compare exact values only in memory. The preview
may show the sanitized authority state, own Metro allocated/bound booleans, and
foreign-session count. If there is no exact session, omit
`RN_DEV_AGENT_SESSION_ID`, show `authority: unknown`, and never select the first
live session.

If active `cdp_status`/`cdp_error_log` tools are available, their high-level
connection/error counts may be added; absence or transport closure is itself
valid feedback and must not block submission. `cdp_status` is passive
diagnostic context and does not replace session authority.

Never include:

- absolute home/project paths;
- secrets/tokens/credentials;
- email, phone, IP, company/app identity, or external bundle IDs; only the owned `com.rndevagent.testapp` bundle ID may remain verbatim;
- tool arguments, store/component/network bodies, console contents, or stacks.
- foreign session paths, PIDs, device IDs, app IDs, ports, or capabilities.

## 3. Mandatory review

Render the exact title/body/environment data that would be sent. Ask in
conversation: **"Does this look correct, and should anything be removed?"**
Wait for explicit confirmation and apply every requested removal.

## 4. Submit without shell interpolation

1. Generate a conservative title from safe characters; never paste raw user
   text into a shell command.
2. Create a collision-safe private temporary body file with mode `0600` (for
   example through Node `mkdtemp`/exclusive create), not a fixed `/tmp` path.
3. Write the reviewed body to that file.
4. Invoke `gh issue create` with a separately constructed argv array:
   `--repo Lykhoyda/rn-dev-agent`, safe title, exact label, and `--body-file`
   path. Do not use `bash -c` or `eval`.
5. Remove the private temp file/directory after success. On authentication
   failure, retain only with the user's consent and report its path.
6. Report the created issue URL.

The body includes description, sanitized environment, current high-level
authority, fresh telemetry status (if any), high-level CDP state, reproduction,
the reviewed newest runner-diagnostics bundle (if any), workaround, suggested fix, and related issues. Omit empty optional sections and
never present stale telemetry as recent.

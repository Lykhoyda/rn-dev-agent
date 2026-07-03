---
"rn-dev-agent-cdp": minor
"rn-dev-agent-plugin": minor
---

Command-surface gate (#418, B235): both native runners enumerate their supported
commands in `/health.commands` (iOS derives it from `CommandType.allCases`, Android
from a sync-tested `SUPPORTED_COMMANDS` list) and the liveness gate classifies a
runner missing any bridge-required verb as stale (`missing-commands`). Remediation
is tiered: `device_snapshot action=open` auto-invalidates the stale artifact and
rebuilds — iOS deletes DerivedData and cold-builds (once per plugin version, behind a
checkout-scoped build lock), Android deletes the runner APKs so self-install
Gradle-rebuilds; mid-flow device tools refuse fast with `RUNNER_COMMANDS_STALE`
instead of silently building. An unknown verb reaching the iOS runner now returns a
typed `UNSUPPORTED_COMMAND` error instead of a raw Swift decode failure. Root cause
of B235 fixed: the explicit iOS keyboard-dismiss path posted `dismissKeyboard`,
which no Swift artifact ever accepted — the wire verb is now `keyboardDismiss`.
`cdp_status` surfaces `deviceSession.runnerProtocol.missingCommands`. Hardening
from per-edit review: the iOS runner validates client-supplied Content-Length
(400 on invalid instead of crash/hang) and Android foregrounds alias verbs
(press/fill/scroll) before dispatch.

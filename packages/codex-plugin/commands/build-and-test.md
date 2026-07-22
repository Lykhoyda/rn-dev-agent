---
command: build-and-test
description: Build the Expo/React Native app (local or EAS), install it, start Metro, then test a requested feature end-to-end.
argument-hint: "[--eas profile] [feature-description]"
---

# Build and test

Treat all text after `$rn-dev-agent:build-and-test` as the conceptual **request**.
Parse an optional leading `--eas <profile>` and preserve the remaining text as
one feature description. Reject an unknown flag-position token or a missing EAS
profile. If the description is empty, ask which flow to verify.

Resolve `<package-root>` from this workflow skill's exact `SKILL.md` path
(`../..` from the skill directory). Never search Codex caches or use a
plugin-root environment variable. Execute helpers by separately quoted argv;
never interpolate the raw request into a shell command.

## Run inline in the current task

MCP tools are not inherited by spawned subagents. Use `rn-device-control` and
`rn-testing` as references and execute this protocol in the current task.

### Phase A — build/install preflight

1. Require active `device_list` and `cdp_status` tools. If they are absent, stop
   and route to the read-only discovery diagnosis.
2. Select exactly one target platform/device. Stop on ambiguity.
3. If `cdp_status` already reports the intended development app connected,
   skip the build and continue to Phase B.
4. Local mode: invoke the package helper with an argv array equivalent to:
   `bash <package-root>/scripts/expo_ensure_running.sh <ios|android>`.
5. EAS mode:
   - validate profile with `[A-Za-z0-9_-]+`;
   - invoke `bash <package-root>/scripts/eas_resolve_artifact.sh <platform> <profile>`;
   - parse its JSON and require `status: ok` plus an absolute artifact path;
   - invoke `bash <package-root>/scripts/expo_ensure_running.sh <platform> --artifact <path>`.
6. Parse helper JSON and surface stable errors. Do not silently fall back from a
   requested EAS build to local build.
7. Call `cdp_status`; require `ok:true` and the intended app/device.

The helpers own local Expo build, artifact install, app launch, and Metro
startup behavior. They are packaged in both host plugins; installed behavior
must never be narrowed to "use the app's own workflow".

### Phase B — test

Follow the package-local `test-feature` workflow and `rn-testing` skill:

1. Inventory reusable actions before any manual device primitive.
2. Replay a full/partial matching action where applicable.
3. Plan the novel test steps and expected results.
4. Execute and verify UI, route/store/network state, screenshots, and errors.
5. Persist or refresh a reusable action for the verified flow.

## Completion gate

- [ ] Intended app/device and platform are unambiguous.
- [ ] `cdp_status` reports the intended app connected after Phase A.
- [ ] Every assertion has concrete evidence.
- [ ] At least one screenshot is saved.
- [ ] A reusable action covers the tested feature.
- [ ] No new app errors are present.

## Examples

```text
$rn-dev-agent:build-and-test shopping cart -- add item and verify badge
$rn-dev-agent:build-and-test --eas development login screen
$rn-dev-agent:build-and-test --eas preview payment flow
```

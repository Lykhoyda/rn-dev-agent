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

1. Require active `rn_session`, `device_list`, and `cdp_status` tools. If they
   are absent, stop and route to the read-only discovery diagnosis.
2. Require `rn_session(action="status")` to name the intended worktree,
   platform, exact UUID/serial, and app ID. `device_list` is diagnostic only.
3. If passive `cdp_status` reports that session's exact signed development app
   connected, skip the build and continue to Phase B.
4. Local mode: preview and confirm session integration, then run literal
   `pnpm ios` or `pnpm android`; the adapter owns exact device, Metro, and
   build/install receipt injection.
5. EAS mode:
   - validate profile with `[A-Za-z0-9_-]+`;
   - enter one shell scope, create one caller-owned artifact directory with
     `artifact_dir=$(mktemp -d)`, retain its exact path, and immediately register
     `trap 'rm -rf -- "$artifact_dir"' EXIT` in that same scope before invoking
     `bash "<package-root>/scripts/eas_resolve_artifact.sh" "<platform>" "<profile>" "<artifact-dir>"`;
   - parse its JSON and require `status: ok` plus an absolute artifact path;
   - invoke
     `bash "<package-root>/scripts/expo_ensure_running.sh" "<platform>" --device-id "<device-id>" --artifact "<artifact-path>"`;
   - keep resolution and installation inside the trapped scope so every success
     or failure path cleans only that exact caller-owned directory after the
     install helper returns.
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

- [ ] Intended app/device and platform are unambiguous and the helper received
      the exact selected UDID/serial.
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

#!/usr/bin/env bash
# Regression test for check-agent-package-sync.sh.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$SCRIPT_DIR/check-agent-package-sync.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

fail=0
check() { # description expected_exit actual_exit
  if [ "$2" = "$3" ]; then
    echo "ok: $1"
  else
    echo "FAIL: $1 — expected exit $2, got $3"
    fail=1
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

write_valid_repo() {
  find "$tmp" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  mkdir -p \
    "$tmp/.claude-plugin" \
    "$tmp/.changeset" \
    "$tmp/.yarn/releases" \
    "$tmp/apps/docs-site" \
    "$tmp/packages/rn-dev-agent-core/dist" \
    "$tmp/packages/claude-plugin/.claude-plugin" \
    "$tmp/packages/claude-plugin/agents" \
    "$tmp/packages/claude-plugin/commands" \
    "$tmp/packages/claude-plugin/hooks" \
    "$tmp/packages/claude-plugin/scripts/rn-fast-runner/RnFastRunner/RnFastRunner.xcodeproj" \
    "$tmp/packages/claude-plugin/scripts/rn-android-runner/app" \
    "$tmp/packages/claude-plugin/rn-dev-agent-core/dist/observability/web-dist" \
    "$tmp/packages/claude-plugin/rn-dev-agent-core/dist/web-dist" \
    "$tmp/packages/claude-plugin/skills" \
    "$tmp/packages/claude-plugin/templates" \
    "$tmp/packages/codex-plugin/agents" \
    "$tmp/packages/codex-plugin/bin" \
    "$tmp/packages/codex-plugin/src" \
    "$tmp/packages/codex-plugin/.codex-plugin" \
    "$tmp/packages/codex-plugin/commands" \
    "$tmp/packages/codex-plugin/scripts/rn-fast-runner/RnFastRunner/RnFastRunner.xcodeproj" \
    "$tmp/packages/codex-plugin/scripts/rn-android-runner/app" \
    "$tmp/packages/codex-plugin/skills" \
    "$tmp/packages/codex-plugin/templates" \
    "$tmp/packages/codex-plugin/rn-dev-agent-core/dist" \
    "$tmp/packages/codex-plugin/rn-dev-agent-core/dist/observability/web-dist" \
    "$tmp/packages/codex-plugin/rn-dev-agent-core/dist/web-dist" \
    "$tmp/packages/rn-fast-runner/RnFastRunner/RnFastRunner.xcodeproj" \
    "$tmp/packages/rn-android-runner/app" \
    "$tmp/packages/shared-agent-knowledge/skills/using-rn-dev-agent" \
    "$tmp/packages/shared-agent-knowledge/commands" \
    "$tmp/packages/shared-agent-knowledge/agents" \
    "$tmp/packages/shared-agent-knowledge/templates/rn-agent"

  printf '%s\n' '{"packageManager":"yarn@4.17.0","type":"module","workspaces":["apps/*","packages/*"]}' > "$tmp/package.json"
  printf '%s\n' '# CLAUDE template fixture' > "$tmp/CLAUDE-MD-TEMPLATE.md"
  mkdir -p "$tmp/scripts"
  printf '%s\n' '#!/usr/bin/env bash' 'echo proof fixture' > "$tmp/scripts/record_proof.sh"
  printf '%s\n' '#!/usr/bin/env bash' 'echo feedback fixture' > "$tmp/scripts/collect-feedback.sh"
  for helper in expo_ensure_running.sh eas_resolve_artifact.sh snapshot_state.sh; do
    printf '%s\n' '#!/usr/bin/env bash' "echo $helper fixture" > "$tmp/scripts/$helper"
  done
  printf '%s\n' '#!/usr/bin/env node' 'console.log("checker fixture")' > "$tmp/scripts/check-vercel-rules.mjs"
  printf '%s\n' '{"ignore":["rn-dev-agent-codex-plugin","rn-dev-agent-android-runner","rn-dev-agent-ios-runner","rn-dev-agent-shared-agent-knowledge","rn-dev-agent-docs"]}' > "$tmp/.changeset/config.json"
  printf '%s\n' 'enableGlobalCache: true' 'nodeLinker: node-modules' 'yarnPath: .yarn/releases/yarn-4.17.0.cjs' > "$tmp/.yarnrc.yml"
  printf '%s\n' 'yarn release fixture' > "$tmp/.yarn/releases/yarn-4.17.0.cjs"
  printf '%s\n' '# lock fixture' > "$tmp/yarn.lock"
  printf '%s\n' '{"version":"1.2.3","assets":{"ios":[],"android":[]}}' > "$tmp/runner-manifest.json"
  /bin/cp "$tmp/runner-manifest.json" "$tmp/packages/codex-plugin/runner-manifest.json"
  /bin/cp "$tmp/runner-manifest.json" "$tmp/packages/claude-plugin/runner-manifest.json"
  printf '%s\n' '{"name":"rn-dev-agent-ios-runner","private":true}' > "$tmp/packages/rn-fast-runner/package.json"
  printf '%s\n' 'fixture ios project' > "$tmp/packages/rn-fast-runner/RnFastRunner/RnFastRunner.xcodeproj/project.pbxproj"
  /bin/cp "$tmp/packages/rn-fast-runner/package.json" "$tmp/packages/codex-plugin/scripts/rn-fast-runner/package.json"
  printf '%s\n' 'fixture ios project' > "$tmp/packages/codex-plugin/scripts/rn-fast-runner/RnFastRunner/RnFastRunner.xcodeproj/project.pbxproj"
  printf '%s\n' '{"name":"rn-dev-agent-android-runner","private":true}' > "$tmp/packages/rn-android-runner/package.json"
  printf '%s\n' '#!/usr/bin/env sh' 'echo gradle fixture' > "$tmp/packages/rn-android-runner/gradlew"
  /bin/chmod +x "$tmp/packages/rn-android-runner/gradlew"
  printf '%s\n' 'plugins {}' > "$tmp/packages/rn-android-runner/app/build.gradle.kts"
  /bin/cp "$tmp/packages/rn-android-runner/package.json" "$tmp/packages/codex-plugin/scripts/rn-android-runner/package.json"
  /bin/cp "$tmp/packages/rn-android-runner/gradlew" "$tmp/packages/codex-plugin/scripts/rn-android-runner/gradlew"
  /bin/chmod +x "$tmp/packages/codex-plugin/scripts/rn-android-runner/gradlew"
  /bin/cp "$tmp/packages/rn-android-runner/app/build.gradle.kts" "$tmp/packages/codex-plugin/scripts/rn-android-runner/app/build.gradle.kts"
  /bin/cp "$tmp/packages/rn-fast-runner/package.json" "$tmp/packages/claude-plugin/scripts/rn-fast-runner/package.json"
  printf '%s\n' 'fixture ios project' > "$tmp/packages/claude-plugin/scripts/rn-fast-runner/RnFastRunner/RnFastRunner.xcodeproj/project.pbxproj"
  /bin/cp "$tmp/packages/rn-android-runner/package.json" "$tmp/packages/claude-plugin/scripts/rn-android-runner/package.json"
  /bin/cp "$tmp/packages/rn-android-runner/gradlew" "$tmp/packages/claude-plugin/scripts/rn-android-runner/gradlew"
  /bin/chmod +x "$tmp/packages/claude-plugin/scripts/rn-android-runner/gradlew"
  /bin/cp "$tmp/packages/rn-android-runner/app/build.gradle.kts" "$tmp/packages/claude-plugin/scripts/rn-android-runner/app/build.gradle.kts"

  printf '%s\n' '{"name":"rn-dev-agent-docs","scripts":{"build":"yarn generate && astro build"}}' > "$tmp/apps/docs-site/package.json"
  printf '%s\n' '{"name":"rn-dev-agent-core","version":"4.5.6","bin":"./dist/supervisor.js"}' > "$tmp/packages/rn-dev-agent-core/package.json"
  printf '%s\n' '{"name":"rn-dev-agent-plugin","version":"1.2.3","dependencies":{"rn-dev-agent-core":"workspace:*","rn-dev-agent-shared-agent-knowledge":"workspace:*"}}' > "$tmp/packages/claude-plugin/package.json"
  /bin/cp "$tmp/CLAUDE-MD-TEMPLATE.md" "$tmp/packages/claude-plugin/CLAUDE-MD-TEMPLATE.md"
  /bin/cp "$tmp/scripts/record_proof.sh" "$tmp/packages/claude-plugin/scripts/record_proof.sh"
  /bin/cp "$tmp/scripts/collect-feedback.sh" "$tmp/packages/claude-plugin/scripts/collect-feedback.sh"
  printf '%s\n' '{"name":"rn-dev-agent","version":"1.2.3","mcpServers":{"cdp":{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/rn-dev-agent-core/dist/supervisor.js"]}}}' > "$tmp/packages/claude-plugin/plugin.json"
  printf '%s\n' '{"name":"rn-dev-agent","version":"1.2.3","mcpServers":{"cdp":{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/rn-dev-agent-core/dist/supervisor.js"]}}}' > "$tmp/packages/claude-plugin/.claude-plugin/plugin.json"
  printf '%s\n' '{"plugins":[{"name":"rn-dev-agent","version":"1.2.3","source":"./packages/claude-plugin"}]}' > "$tmp/.claude-plugin/marketplace.json"
  mkdir -p "$tmp/.agents/plugins"
  printf '%s\n' '{"name":"rn-dev-agent","plugins":[{"name":"rn-dev-agent","source":{"source":"local","path":"./packages/codex-plugin"},"policy":{"installation":"AVAILABLE","authentication":"ON_INSTALL"},"category":"Engineering"}]}' > "$tmp/.agents/plugins/marketplace.json"
  printf '%s\n' '{"plugins":[{"name":"rn-dev-agent","version":"1.2.3","source":"./"}]}' > "$tmp/packages/claude-plugin/marketplace.json"
  printf '%s\n' '{"plugins":[{"name":"rn-dev-agent","version":"1.2.3","source":"./"}]}' > "$tmp/packages/claude-plugin/.claude-plugin/marketplace.json"
  printf '%s\n' '{"hooks":{}}' > "$tmp/packages/claude-plugin/hooks/hooks.json"
  printf '%s\n' '{"name":"rn-dev-agent-codex-plugin","type":"module","dependencies":{"rn-dev-agent-core":"workspace:*","rn-dev-agent-shared-agent-knowledge":"workspace:*"}}' > "$tmp/packages/codex-plugin/package.json"
  /bin/cp "$tmp/CLAUDE-MD-TEMPLATE.md" "$tmp/packages/codex-plugin/CLAUDE-MD-TEMPLATE.md"
  /bin/cp "$tmp/scripts/record_proof.sh" "$tmp/packages/codex-plugin/scripts/record_proof.sh"
  /bin/cp "$tmp/scripts/collect-feedback.sh" "$tmp/packages/codex-plugin/scripts/collect-feedback.sh"
  for helper in expo_ensure_running.sh eas_resolve_artifact.sh check-vercel-rules.mjs snapshot_state.sh; do
    /bin/cp "$tmp/scripts/$helper" "$tmp/packages/codex-plugin/scripts/$helper"
    /bin/cp "$tmp/scripts/$helper" "$tmp/packages/claude-plugin/scripts/$helper"
  done
  printf '%s\n' '# Codex AGENTS fixture' > "$tmp/packages/codex-plugin/src/AGENTS-MD-TEMPLATE.md"
  /bin/cp "$tmp/packages/codex-plugin/src/AGENTS-MD-TEMPLATE.md" "$tmp/packages/codex-plugin/AGENTS-MD-TEMPLATE.md"
  printf '%s\n' 'export const health = true;' > "$tmp/packages/codex-plugin/src/plugin-health.ts"
  printf '%s\n' '// packages/codex-plugin/src/plugin-health.ts' 'console.log("health fixture")' > "$tmp/packages/codex-plugin/bin/plugin-health.js"
  printf '%s\n' '{"name":"rn-dev-agent","version":"1.2.3","skills":"./skills/","commands":[],"mcpServers":"./.mcp.json"}' > "$tmp/packages/codex-plugin/.codex-plugin/plugin.json"
  printf '%s\n' '{"mcpServers":{"cdp":{"command":"node","args":["-e","const V='\''1.2.3'\'';require(\"child_process\").spawn(process.execPath,[\"bin/cdp-supervisor.js\"],{stdio:\"inherit\"})"],"tool_timeout_sec":900}}}' > "$tmp/packages/codex-plugin/.mcp.json"
  /bin/cp "$REPO_ROOT/packages/codex-plugin/bin/cdp-supervisor.js" "$tmp/packages/codex-plugin/bin/cdp-supervisor.js"
  printf '%s\n' '{"name":"rn-dev-agent-core-codex-runtime","version":"4.5.6","private":true,"type":"module"}' > "$tmp/packages/codex-plugin/rn-dev-agent-core/package.json"
  printf '%s\n' 'console.log("worker fixture")' > "$tmp/packages/codex-plugin/rn-dev-agent-core/dist/index.js"
  printf '%s\n' 'console.log("learned-actions fixture")' > "$tmp/packages/codex-plugin/rn-dev-agent-core/dist/learned-actions.js"
  printf '%s\n' '<!doctype html><title>observe fixture</title>' > "$tmp/packages/codex-plugin/rn-dev-agent-core/dist/observability/web-dist/index.html"
  printf '%s\n' '<!doctype html><title>observe fixture</title>' > "$tmp/packages/codex-plugin/rn-dev-agent-core/dist/web-dist/index.html"
  printf '%s\n' 'import { writeFileSync } from "node:fs";' 'writeFileSync(process.env.LAUNCHER_PROBE_FILE, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));' > "$tmp/packages/codex-plugin/rn-dev-agent-core/dist/supervisor.js"
  printf '%s\n' '{"name":"rn-dev-agent-core-claude-runtime","version":"4.5.6","private":true,"type":"module"}' > "$tmp/packages/claude-plugin/rn-dev-agent-core/package.json"
  for runtime_entry in supervisor.js index.js learned-actions.js; do
    /bin/cp "$tmp/packages/codex-plugin/rn-dev-agent-core/dist/$runtime_entry" "$tmp/packages/claude-plugin/rn-dev-agent-core/dist/$runtime_entry"
  done
  printf '%s\n' '<!doctype html><title>observe fixture</title>' > "$tmp/packages/claude-plugin/rn-dev-agent-core/dist/observability/web-dist/index.html"
  printf '%s\n' '<!doctype html><title>observe fixture</title>' > "$tmp/packages/claude-plugin/rn-dev-agent-core/dist/web-dist/index.html"
  for helper in mcp-bridge-probe.mjs ensure-cdp-deps.sh ensure-maestro-runner.sh \
    ensure-idb-companion.sh ensure-idb.sh ensure-ffmpeg.sh \
    ensure-troubleshooting-doc.sh ensure-android-ready.sh \
    check-physical-devices.sh; do
    printf '%s\n' "helper fixture: $helper" > "$tmp/scripts/$helper"
    /bin/cp "$tmp/scripts/$helper" "$tmp/packages/claude-plugin/scripts/$helper"
  done
  printf '%s\n' '{"name":"rn-dev-agent-shared-agent-knowledge"}' > "$tmp/packages/shared-agent-knowledge/package.json"
  /bin/cp "$REPO_ROOT/packages/shared-agent-knowledge/source-map.json" "$tmp/packages/shared-agent-knowledge/source-map.json"
  for skill in capturing-proof creating-actions rn-best-practices rn-debugging rn-device-control rn-feature-development rn-setup rn-testing sending-feedback using-rn-dev-agent; do
    mkdir -p "$tmp/packages/shared-agent-knowledge/skills/$skill"
    printf '%s\n' '---' "name: $skill" '---' > "$tmp/packages/shared-agent-knowledge/skills/$skill/SKILL.md"
  done
  for command in build-and-test check-env check-vercel-rules debug-screen doctor list-learned-actions lock-e2e nav-graph observe proof-capture rn-feature-dev run-action send-feedback setup test-feature; do
    printf '%s\n' "# $command" > "$tmp/packages/shared-agent-knowledge/commands/$command.md"
  done
  printf '%s\n' '# rn tester' > "$tmp/packages/shared-agent-knowledge/agents/rn-tester.md"

  /bin/cp -R "$tmp/packages/shared-agent-knowledge/skills/." "$tmp/packages/claude-plugin/skills/"
  /bin/cp -R "$tmp/packages/shared-agent-knowledge/commands/." "$tmp/packages/claude-plugin/commands/"
  /bin/cp -R "$tmp/packages/shared-agent-knowledge/agents/." "$tmp/packages/claude-plugin/agents/"
  /bin/cp -R "$tmp/packages/shared-agent-knowledge/templates/." "$tmp/packages/claude-plugin/templates/"
  /bin/cp -R "$tmp/packages/shared-agent-knowledge/skills/." "$tmp/packages/codex-plugin/skills/"
  /bin/cp -R "$tmp/packages/shared-agent-knowledge/commands/." "$tmp/packages/codex-plugin/commands/"
  /bin/cp -R "$tmp/packages/shared-agent-knowledge/agents/." "$tmp/packages/codex-plugin/agents/"
  /bin/cp -R "$tmp/packages/shared-agent-knowledge/templates/." "$tmp/packages/codex-plugin/templates/"
  for command in build-and-test check-env check-vercel-rules debug-screen doctor list-learned-actions lock-e2e nav-graph observe proof-capture rn-feature-dev run-action send-feedback setup test-feature; do
    mkdir -p "$tmp/packages/codex-plugin/skills/$command/agents"
    printf '%s\n' '<!-- GENERATED by scripts/build-host-runtimes.ts -->' '---' "name: $command" '---' > "$tmp/packages/codex-plugin/skills/$command/SKILL.md"
    printf '%s\n' '# GENERATED' 'policy:' '  allow_implicit_invocation: false' > "$tmp/packages/codex-plugin/skills/$command/agents/openai.yaml"
  done
}

write_valid_repo
REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "valid package split passes" 0 $?

write_valid_repo
mkdir -p "$tmp/packages/rn-android-runner/app/build/generated" "$tmp/packages/rn-android-runner/.gradle" "$tmp/packages/rn-android-runner/.kotlin" "$tmp/packages/rn-fast-runner/build/DerivedData" "$tmp/packages/rn-fast-runner/RnFastRunner/RnFastRunner.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/configuration"
printf '%s\n' 'local build output' > "$tmp/packages/rn-android-runner/app/build/generated/out.txt"
printf '%s\n' 'gradle local state' > "$tmp/packages/rn-android-runner/.gradle/state"
printf '%s\n' 'kotlin local state' > "$tmp/packages/rn-android-runner/.kotlin/state"
printf '%s\n' 'xcode local state' > "$tmp/packages/rn-fast-runner/build/DerivedData/state"
printf '%s\n' 'swiftpm local state' > "$tmp/packages/rn-fast-runner/RnFastRunner/RnFastRunner.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/configuration/state"
REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "native runner local build outputs are ignored" 0 $?

write_valid_repo
mkdir -p "$tmp/packages/rn-fast-runner/RnFastRunner/RnFastRunner.xcodeproj/xcshareddata/xcschemes"
printf '%s\n' 'shared scheme source asset' > "$tmp/packages/rn-fast-runner/RnFastRunner/RnFastRunner.xcodeproj/xcshareddata/xcschemes/RnFastRunner.xcscheme"
REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "committed Xcode shared scheme drift fails" 1 $?

write_valid_repo
printf '%s\n' '{"packageManager":"yarn@4.17.0","workspaces":["packages/*"]}' > "$tmp/package.json"
REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "missing apps workspace fails" 1 $?

write_valid_repo
printf '%s\n' '{"packageManager":"yarn@4.17.0","workspaces":["apps/*","packages/*","scripts/cdp-bridge"]}' > "$tmp/package.json"
REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "legacy core workspace fails" 1 $?

write_valid_repo
printf '%s\n' '{"name":"rn-dev-agent-cdp","bin":{"rn-dev-agent-core":"./dist/supervisor.js"}}' > "$tmp/packages/rn-dev-agent-core/package.json"
REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "old core package name fails" 1 $?

write_valid_repo
printf '%s\n' '{"mcpServers":{"cdp":{"command":"node","args":["./scripts/cdp-bridge/dist/supervisor.js"],"cwd":"."}}}' > "$tmp/packages/codex-plugin/.mcp.json"
REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "legacy Codex MCP path fails" 1 $?

write_valid_repo
printf '%s\n' '{"name":"rn-dev-agent","version":"9.9.9","skills":"./skills/","mcpServers":"./.mcp.json"}' > "$tmp/packages/codex-plugin/.codex-plugin/plugin.json"
REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "Codex plugin version drift fails" 1 $?

write_valid_repo
printf '%s\n' '{"lockfileVersion":3}' > "$tmp/package-lock.json"
REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "root npm lock fails" 1 $?

write_valid_repo
printf '%s\n' '{"lockfileVersion":3}' > "$tmp/apps/docs-site/package-lock.json"
REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "docs app npm lock fails" 1 $?

write_valid_repo
printf '%s\n' '{"ignore":["rn-dev-agent-codex-plugin","rn-dev-agent-docs"]}' > "$tmp/.changeset/config.json"
REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "missing shared ignore fails" 1 $?

write_valid_repo
printf '%s\n' '{"ignore":["rn-dev-agent-plugin","rn-dev-agent-codex-plugin","rn-dev-agent-shared-agent-knowledge","rn-dev-agent-docs"]}' > "$tmp/.changeset/config.json"
REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "ignored Claude release package fails" 1 $?

write_valid_repo
/bin/rm -rf "$tmp/packages/codex-plugin/skills"
REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "missing Codex skills adapter fails" 1 $?

write_valid_repo
ln -s packages/shared-agent-knowledge/skills "$tmp/skills"
REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "legacy root skills shim fails" 1 $?

write_valid_repo
mkdir -p "$tmp/scripts/rn-fast-runner"
REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "legacy root iOS runner project fails" 1 $?

write_valid_repo
mkdir -p "$tmp/scripts/rn-android-runner"
REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "legacy root Android runner project fails" 1 $?

write_valid_repo
/bin/rm -rf "$tmp/packages/codex-plugin/skills"
ln -s ../shared-agent-knowledge/skills "$tmp/packages/codex-plugin/skills"
REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "symlinked Codex skills adapter fails" 1 $?

write_valid_repo
probe_cwd="$tmp/probe-cwd"
probe_file="$tmp/launcher-probe.json"
mkdir -p "$probe_cwd"
probe_cwd="$(cd "$probe_cwd" && pwd -P)"
( cd "$probe_cwd" && LAUNCHER_PROBE_FILE="$probe_file" node "$tmp/packages/codex-plugin/bin/cdp-supervisor.js" --probe >/dev/null 2>&1 )
launcher_status=$?
actual=1
if [ "$launcher_status" -eq 0 ] && jq -e --arg cwd "$probe_cwd" '.cwd == $cwd and .argv == ["--no-lock", "--probe"]' "$probe_file" >/dev/null; then
  actual=0
fi
check "Codex launcher uses packaged runtime and preserves app cwd/args" 0 $actual

write_valid_repo
/bin/rm -rf "$tmp/packages/codex-plugin/rn-dev-agent-core"
mkdir -p "$tmp/home/.codex/plugins/cache/local/rn-dev-agent-core/9.9.9/dist"
printf '%s\n' 'console.log("must not run")' > "$tmp/home/.codex/plugins/cache/local/rn-dev-agent-core/9.9.9/dist/supervisor.js"
HOME="$tmp/home" LAUNCHER_PROBE_FILE="$tmp/should-not-exist.json" node "$tmp/packages/codex-plugin/bin/cdp-supervisor.js" >/dev/null 2>&1
check "Codex launcher ignores unrelated global core cache" 1 $?

actual_version="$(jq -r '.version' "$REPO_ROOT/packages/codex-plugin/.codex-plugin/plugin.json")"
actual_bootstrap="$(jq -r '.mcpServers.cdp.args[1]' "$REPO_ROOT/packages/codex-plugin/.mcp.json")"
bootstrap_home="$tmp/bootstrap-home"
bootstrap_cwd="$tmp/bootstrap-cwd"
bootstrap_probe="$tmp/bootstrap-probe.json"
mkdir -p \
  "$bootstrap_home/plugins/cache/local/rn-dev-agent/$actual_version/bin" \
  "$bootstrap_home/plugins/cache/local/rn-dev-agent/999.0.0/bin" \
  "$bootstrap_cwd"
bootstrap_cwd="$(cd "$bootstrap_cwd" && pwd -P)"
printf '%s\n' \
  'import { writeFileSync } from "node:fs";' \
  "writeFileSync(process.env.BOOTSTRAP_PROBE_FILE, JSON.stringify({ marker: '$actual_version', cwd: process.cwd(), argv: process.argv.slice(2) }));" \
  > "$bootstrap_home/plugins/cache/local/rn-dev-agent/$actual_version/bin/cdp-supervisor.js"
printf '%s\n' \
  'import { writeFileSync } from "node:fs";' \
  'writeFileSync(process.env.BOOTSTRAP_PROBE_FILE, JSON.stringify({ marker: "wrong-version", cwd: process.cwd(), argv: process.argv.slice(2) }));' \
  > "$bootstrap_home/plugins/cache/local/rn-dev-agent/999.0.0/bin/cdp-supervisor.js"
( cd "$bootstrap_cwd" && CODEX_HOME="$bootstrap_home" BOOTSTRAP_PROBE_FILE="$bootstrap_probe" node -e "$actual_bootstrap" -- --probe >/dev/null 2>&1 )
bootstrap_status=$?
actual=1
if [ "$bootstrap_status" -eq 0 ] && jq -e --arg marker "$actual_version" --arg cwd "$bootstrap_cwd" '.marker == $marker and .cwd == $cwd and .argv == ["--probe"]' "$bootstrap_probe" >/dev/null; then
  actual=0
fi
check "Codex MCP bootstrap chooses only the pinned plugin version and preserves app cwd/args" 0 $actual

if [ "$fail" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; exit 1; fi

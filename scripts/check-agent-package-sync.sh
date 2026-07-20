#!/usr/bin/env bash
# Guard the Yarn workspace split from GH #498: core owns MCP/device behavior,
# host packages own integration, shared-agent-knowledge owns canonical workflow
# guidance, and apps/* owns deliverable apps. Host package outputs are real
# generated/adapted directories; legacy root shims must not exist.
set -euo pipefail

ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXPECTED_YARN_VERSION="4.17.0"
EXPECTED_YARN_PATH=".yarn/releases/yarn-${EXPECTED_YARN_VERSION}.cjs"

failures=0

fail() {
  echo "ERROR: $*" >&2
  failures=$((failures + 1))
}

json() {
  jq -r "$1" "$2"
}

expect_file() {
  local path="$1"
  [ -f "$ROOT/$path" ] || fail "missing required file: $path"
}

expect_no_file() {
  local path="$1"
  [ ! -f "$ROOT/$path" ] || fail "file must not exist: $path"
}

expect_no_path() {
  local path="$1"
  if [ -e "$ROOT/$path" ] || [ -L "$ROOT/$path" ]; then
    fail "legacy root compatibility path must not exist: $path"
  fi
}

expect_dir() {
  local path="$1"
  [ -d "$ROOT/$path" ] || fail "missing required directory: $path"
}

expect_real_dir() {
  local path="$1"
  if [ -L "$ROOT/$path" ]; then
    fail "directory must be real, not a symlink: $path"
    return
  fi
  expect_dir "$path"
}

expect_synced_dir() {
  local source="$1"
  local target="$2"
  local label="$3"
  expect_real_dir "$source"
  expect_real_dir "$target"
  if [ -d "$ROOT/$source" ] && [ -d "$ROOT/$target" ] && ! diff -qr "$ROOT/$source" "$ROOT/$target" >/dev/null; then
    fail "$label must match canonical shared-agent-knowledge output"
  fi
}

expect_synced_native_runner_dir() {
  local source="$1"
  local target="$2"
  local label="$3"
  expect_real_dir "$source"
  expect_real_dir "$target"
  if [ -d "$ROOT/$source" ] && [ -d "$ROOT/$target" ]; then
    local source_files target_files file
    source_files="$(native_runner_file_list "$ROOT/$source")"
    target_files="$(native_runner_file_list "$ROOT/$target")"
    if [ "$source_files" != "$target_files" ]; then
      fail "$label must match the package-owned native runner source, ignoring local build output"
      return
    fi
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      if ! cmp -s "$ROOT/$source/$file" "$ROOT/$target/$file"; then
        fail "$label must match the package-owned native runner source, ignoring local build output"
        return
      fi
    done <<< "$source_files"
  fi
}

native_runner_file_list() {
  local dir="$1"
  (
    cd "$dir"
    find . -type f \
      ! -path './build/*' \
      ! -path '*/build/*' \
      ! -path './.gradle/*' \
      ! -path './.kotlin/*' \
      ! -name local.properties \
      ! -path '*/xcuserdata/*' \
      ! -path '*/DerivedData/*' \
      ! -name '*.xcuserstate' \
      ! -path '*/project.xcworkspace/xcshareddata/*' \
      | sort
  )
}

expect_same_file_set() {
  local source="$1"
  local target="$2"
  local label="$3"
  expect_real_dir "$source"
  expect_real_dir "$target"
  if [ -d "$ROOT/$source" ] && [ -d "$ROOT/$target" ]; then
    local source_files target_files
    source_files="$(cd "$ROOT/$source" && find . -type f | sort)"
    target_files="$(cd "$ROOT/$target" && find . -type f | sort)"
    if [ "$source_files" != "$target_files" ]; then
      fail "$label must expose the same file set as canonical shared-agent-knowledge"
    fi
  fi
}

expect_eq() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  if [ "$actual" != "$expected" ]; then
    fail "$label expected '$expected', got '$actual'"
  fi
}

expect_workspace() {
  local workspace="$1"
  if ! jq -e --arg workspace "$workspace" '.workspaces | index($workspace)' "$ROOT/package.json" >/dev/null; then
    fail "root package.json workspaces must include $workspace"
  fi
}

expect_no_workspace() {
  local workspace="$1"
  if jq -e --arg workspace "$workspace" '.workspaces | index($workspace)' "$ROOT/package.json" >/dev/null; then
    fail "root package.json workspaces must not include legacy workspace $workspace"
  fi
}

expect_dep() {
  local package_json="$1"
  local dep="$2"
  local actual
  actual="$(jq -r --arg dep "$dep" '.dependencies[$dep] // empty' "$ROOT/$package_json")"
  expect_eq "$actual" "workspace:*" "$package_json dependency $dep"
}

expect_ignored() {
  local ignored="$1"
  if ! jq -e --arg ignored "$ignored" '.ignore | index($ignored)' "$ROOT/.changeset/config.json" >/dev/null; then
    fail ".changeset/config.json ignore must include $ignored"
  fi
}

expect_not_ignored() {
  local ignored="$1"
  if jq -e --arg ignored "$ignored" '.ignore | index($ignored)' "$ROOT/.changeset/config.json" >/dev/null; then
    fail ".changeset/config.json ignore must not include releasable package $ignored"
  fi
}

expect_jq() {
  local file="$1"
  local expression="$2"
  local label="$3"
  if ! jq -e "$expression" "$ROOT/$file" >/dev/null; then
    fail "$label"
  fi
}

for path in \
  package.json \
  yarn.lock \
  .claude-plugin/marketplace.json \
  .agents/plugins/marketplace.json \
  .changeset/config.json \
  .yarnrc.yml \
  "$EXPECTED_YARN_PATH" \
  apps/docs-site/package.json \
  packages/rn-dev-agent-core/package.json \
  packages/claude-plugin/package.json \
  packages/claude-plugin/CLAUDE-MD-TEMPLATE.md \
  packages/claude-plugin/plugin.json \
  packages/claude-plugin/.claude-plugin/plugin.json \
  packages/claude-plugin/marketplace.json \
  packages/claude-plugin/.claude-plugin/marketplace.json \
  packages/claude-plugin/hooks/hooks.json \
  packages/claude-plugin/scripts/record_proof.sh \
  packages/claude-plugin/scripts/collect-feedback.sh \
  packages/claude-plugin/runner-manifest.json \
  packages/claude-plugin/rn-dev-agent-core/package.json \
  packages/claude-plugin/rn-dev-agent-core/dist/index.js \
  packages/claude-plugin/rn-dev-agent-core/dist/learned-actions.js \
  packages/claude-plugin/rn-dev-agent-core/dist/observability/web-dist/index.html \
  packages/claude-plugin/rn-dev-agent-core/dist/supervisor.js \
  packages/claude-plugin/rn-dev-agent-core/dist/web-dist/index.html \
  packages/claude-plugin/scripts/rn-fast-runner/package.json \
  packages/claude-plugin/scripts/rn-fast-runner/RnFastRunner/RnFastRunner.xcodeproj/project.pbxproj \
  packages/claude-plugin/scripts/rn-android-runner/package.json \
  packages/claude-plugin/scripts/rn-android-runner/gradlew \
  packages/claude-plugin/scripts/rn-android-runner/app/build.gradle.kts \
  packages/codex-plugin/package.json \
  packages/codex-plugin/CLAUDE-MD-TEMPLATE.md \
  packages/codex-plugin/.codex-plugin/plugin.json \
  packages/codex-plugin/.mcp.json \
  packages/codex-plugin/bin/cdp-supervisor.js \
  packages/codex-plugin/runner-manifest.json \
  packages/codex-plugin/scripts/record_proof.sh \
  packages/codex-plugin/scripts/collect-feedback.sh \
  packages/codex-plugin/rn-dev-agent-core/package.json \
  packages/codex-plugin/rn-dev-agent-core/dist/index.js \
  packages/codex-plugin/rn-dev-agent-core/dist/learned-actions.js \
  packages/codex-plugin/rn-dev-agent-core/dist/observability/web-dist/index.html \
  packages/codex-plugin/rn-dev-agent-core/dist/supervisor.js \
  packages/codex-plugin/rn-dev-agent-core/dist/web-dist/index.html \
  packages/rn-fast-runner/package.json \
  packages/rn-fast-runner/RnFastRunner/RnFastRunner.xcodeproj/project.pbxproj \
  packages/rn-android-runner/package.json \
  packages/rn-android-runner/gradlew \
  packages/rn-android-runner/app/build.gradle.kts \
  packages/codex-plugin/scripts/rn-fast-runner/package.json \
  packages/codex-plugin/scripts/rn-fast-runner/RnFastRunner/RnFastRunner.xcodeproj/project.pbxproj \
  packages/codex-plugin/scripts/rn-android-runner/package.json \
  packages/codex-plugin/scripts/rn-android-runner/gradlew \
  packages/codex-plugin/scripts/rn-android-runner/app/build.gradle.kts \
  packages/shared-agent-knowledge/package.json \
  packages/shared-agent-knowledge/source-map.json \
  packages/shared-agent-knowledge/skills/using-rn-dev-agent/SKILL.md \
  packages/shared-agent-knowledge/commands/test-feature.md \
  packages/shared-agent-knowledge/agents/rn-tester.md
do
  expect_file "$path"
done

for path in \
  apps/docs-site \
  packages/rn-dev-agent-core \
  packages/claude-plugin \
  packages/codex-plugin \
  packages/rn-fast-runner \
  packages/rn-android-runner \
  packages/codex-plugin/scripts/rn-fast-runner \
  packages/codex-plugin/scripts/rn-android-runner \
  packages/claude-plugin/scripts/rn-fast-runner \
  packages/claude-plugin/scripts/rn-android-runner \
  packages/shared-agent-knowledge
do
  expect_real_dir "$path"
done

for path in \
  scripts/cdp-bridge \
  docs-site \
  agents \
  commands \
  skills \
  templates \
  hooks \
  scripts/rn-fast-runner \
  scripts/rn-android-runner \
  .codex-plugin \
  .mcp.json
do
  expect_no_path "$path"
done

expect_synced_dir "packages/shared-agent-knowledge/skills" "packages/claude-plugin/skills" "Claude skills"
expect_synced_dir "packages/shared-agent-knowledge/commands" "packages/claude-plugin/commands" "Claude commands"
expect_synced_dir "packages/shared-agent-knowledge/agents" "packages/claude-plugin/agents" "Claude agents"
expect_synced_dir "packages/shared-agent-knowledge/templates" "packages/claude-plugin/templates" "Claude templates"
expect_same_file_set "packages/shared-agent-knowledge/skills" "packages/codex-plugin/skills" "Codex skills"
expect_same_file_set "packages/shared-agent-knowledge/commands" "packages/codex-plugin/commands" "Codex commands"
expect_same_file_set "packages/shared-agent-knowledge/agents" "packages/codex-plugin/agents" "Codex agents"
expect_same_file_set "packages/shared-agent-knowledge/templates" "packages/codex-plugin/templates" "Codex templates"
expect_synced_native_runner_dir "packages/rn-fast-runner" "packages/codex-plugin/scripts/rn-fast-runner" "Codex iOS runner assets"
expect_synced_native_runner_dir "packages/rn-android-runner" "packages/codex-plugin/scripts/rn-android-runner" "Codex Android runner assets"
expect_synced_native_runner_dir "packages/rn-fast-runner" "packages/claude-plugin/scripts/rn-fast-runner" "Claude iOS runner assets"
expect_synced_native_runner_dir "packages/rn-android-runner" "packages/claude-plugin/scripts/rn-android-runner" "Claude Android runner assets"
if [ -f "$ROOT/runner-manifest.json" ] && [ -f "$ROOT/packages/codex-plugin/runner-manifest.json" ] && ! cmp -s "$ROOT/runner-manifest.json" "$ROOT/packages/codex-plugin/runner-manifest.json"; then
  fail "Codex runner manifest must match runner-manifest.json"
fi
if [ -f "$ROOT/runner-manifest.json" ] && [ -f "$ROOT/packages/claude-plugin/runner-manifest.json" ] && ! cmp -s "$ROOT/runner-manifest.json" "$ROOT/packages/claude-plugin/runner-manifest.json"; then
  fail "Claude runner manifest must match runner-manifest.json"
fi
# The two host runtimes are one esbuild output copied twice
# (scripts/build-host-runtimes.ts) — byte-identical by construction.
for runtime_entry in supervisor.js index.js learned-actions.js; do
  if ! cmp -s "$ROOT/packages/codex-plugin/rn-dev-agent-core/dist/$runtime_entry" "$ROOT/packages/claude-plugin/rn-dev-agent-core/dist/$runtime_entry"; then
    fail "Claude and Codex bundled runtimes must be byte-identical: dist/$runtime_entry"
  fi
done
# Helper scripts the Claude hooks/skills call at runtime ship in the package
# (single writer: build-host-runtimes.ts).
for helper in mcp-bridge-probe.mjs ensure-cdp-deps.sh ensure-maestro-runner.sh \
  ensure-idb-companion.sh ensure-idb.sh ensure-ffmpeg.sh \
  ensure-troubleshooting-doc.sh ensure-android-ready.sh \
  check-physical-devices.sh check-vercel-rules.mjs; do
  if ! cmp -s "$ROOT/scripts/$helper" "$ROOT/packages/claude-plugin/scripts/$helper"; then
    fail "Claude package scripts/$helper must match scripts/$helper"
  fi
done
if ! cmp -s "$ROOT/CLAUDE-MD-TEMPLATE.md" "$ROOT/packages/claude-plugin/CLAUDE-MD-TEMPLATE.md"; then
  fail "Claude package CLAUDE-MD-TEMPLATE.md must match the root template"
fi
if ! cmp -s "$ROOT/CLAUDE-MD-TEMPLATE.md" "$ROOT/packages/codex-plugin/CLAUDE-MD-TEMPLATE.md"; then
  fail "Codex package CLAUDE-MD-TEMPLATE.md must match the root template"
fi
if ! cmp -s "$ROOT/scripts/record_proof.sh" "$ROOT/packages/claude-plugin/scripts/record_proof.sh"; then
  fail "Claude package record_proof.sh must match scripts/record_proof.sh"
fi
if ! cmp -s "$ROOT/scripts/record_proof.sh" "$ROOT/packages/codex-plugin/scripts/record_proof.sh"; then
  fail "Codex package record_proof.sh must match scripts/record_proof.sh"
fi
if ! cmp -s "$ROOT/scripts/collect-feedback.sh" "$ROOT/packages/claude-plugin/scripts/collect-feedback.sh"; then
  fail "Claude package collect-feedback.sh must match scripts/collect-feedback.sh"
fi
if ! cmp -s "$ROOT/scripts/collect-feedback.sh" "$ROOT/packages/codex-plugin/scripts/collect-feedback.sh"; then
  fail "Codex package collect-feedback.sh must match scripts/collect-feedback.sh"
fi

expect_eq "$(json '.packageManager // empty' "$ROOT/package.json")" "yarn@$EXPECTED_YARN_VERSION" "root packageManager"
expect_no_file "package-lock.json"
expect_no_file "apps/docs-site/package-lock.json"
if ! grep -Eq '^nodeLinker:[[:space:]]+node-modules[[:space:]]*$' "$ROOT/.yarnrc.yml"; then
  fail ".yarnrc.yml must use nodeLinker: node-modules"
fi
if ! grep -Eq '^enableGlobalCache:[[:space:]]+true[[:space:]]*$' "$ROOT/.yarnrc.yml"; then
  fail ".yarnrc.yml must use enableGlobalCache: true"
fi
if ! grep -Eq "^yarnPath:[[:space:]]+${EXPECTED_YARN_PATH//./\\.}[[:space:]]*$" "$ROOT/.yarnrc.yml"; then
  fail ".yarnrc.yml must use yarnPath: $EXPECTED_YARN_PATH"
fi

expect_workspace "apps/*"
expect_workspace "packages/*"
expect_no_workspace "scripts/cdp-bridge"
expect_no_workspace ".claude-plugin"

expect_ignored "rn-dev-agent-codex-plugin"
expect_ignored "rn-dev-agent-android-runner"
expect_ignored "rn-dev-agent-ios-runner"
expect_ignored "rn-dev-agent-shared-agent-knowledge"
expect_ignored "rn-dev-agent-docs"
expect_not_ignored "rn-dev-agent-plugin"

expect_eq "$(json '.name' "$ROOT/packages/rn-dev-agent-core/package.json")" "rn-dev-agent-core" "core package name"
expect_eq "$(json '.name' "$ROOT/packages/rn-fast-runner/package.json")" "rn-dev-agent-ios-runner" "iOS runner package name"
expect_eq "$(json '.private' "$ROOT/packages/rn-fast-runner/package.json")" "true" "iOS runner package private flag"
expect_eq "$(json '.name' "$ROOT/packages/rn-android-runner/package.json")" "rn-dev-agent-android-runner" "Android runner package name"
expect_eq "$(json '.private' "$ROOT/packages/rn-android-runner/package.json")" "true" "Android runner package private flag"
core_version="$(json '.version' "$ROOT/packages/rn-dev-agent-core/package.json")"
core_bin="$(jq -r 'if (.bin | type) == "string" then .bin else .bin["rn-dev-agent-core"] // empty end' "$ROOT/packages/rn-dev-agent-core/package.json")"
expect_eq "$core_bin" "./dist/supervisor.js" "core package bin"
synth_version="$(json '.version' "$ROOT/packages/claude-plugin/package.json")"

expect_eq "$(json '.name' "$ROOT/packages/claude-plugin/package.json")" "rn-dev-agent-plugin" "Claude plugin package name"
expect_dep "packages/claude-plugin/package.json" "rn-dev-agent-core"
expect_dep "packages/claude-plugin/package.json" "rn-dev-agent-shared-agent-knowledge"
expect_dep "packages/codex-plugin/package.json" "rn-dev-agent-core"
expect_dep "packages/codex-plugin/package.json" "rn-dev-agent-shared-agent-knowledge"
expect_eq "$(json '.type' "$ROOT/packages/codex-plugin/package.json")" "module" "Codex plugin package type"
expect_eq "$(json '.type' "$ROOT/packages/codex-plugin/rn-dev-agent-core/package.json")" "module" "Codex packaged runtime type"
expect_eq "$(json '.version' "$ROOT/packages/codex-plugin/rn-dev-agent-core/package.json")" "$core_version" "Codex packaged runtime core version"
expect_eq "$(json '.type' "$ROOT/packages/claude-plugin/rn-dev-agent-core/package.json")" "module" "Claude packaged runtime type"
expect_eq "$(json '.version' "$ROOT/packages/claude-plugin/rn-dev-agent-core/package.json")" "$core_version" "Claude packaged runtime core version"
expect_eq "$(json '.name' "$ROOT/apps/docs-site/package.json")" "rn-dev-agent-docs" "docs app package name"

expect_jq "packages/claude-plugin/plugin.json" \
  '.mcpServers.cdp.command == "node" and .mcpServers.cdp.args[0] == "${CLAUDE_PLUGIN_ROOT}/rn-dev-agent-core/dist/supervisor.js"' \
  "Claude plugin must spawn the package-local bundled supervisor (installs copy only the package dir)"
expect_jq "packages/claude-plugin/.claude-plugin/plugin.json" \
  '.mcpServers.cdp.command == "node" and .mcpServers.cdp.args[0] == "${CLAUDE_PLUGIN_ROOT}/rn-dev-agent-core/dist/supervisor.js"' \
  "Claude plugin manifest must spawn the package-local bundled supervisor (installs copy only the package dir)"
expect_jq ".agents/plugins/marketplace.json" \
  '.name == "rn-dev-agent" and (.plugins[] | select(.name == "rn-dev-agent") | .source.source == "local" and .source.path == "./packages/codex-plugin")' \
  "Codex marketplace manifest must resolve the package-owned Codex plugin"
expect_jq ".claude-plugin/marketplace.json" \
  '.plugins[] | select(.name == "rn-dev-agent") | .source == "./packages/claude-plugin"' \
  "root Claude marketplace must point at the package-owned Claude plugin"
expect_jq "packages/claude-plugin/.claude-plugin/marketplace.json" \
  '.plugins[] | select(.name == "rn-dev-agent") | .source == "./"' \
  "package-local Claude marketplace must point at the package root"
expect_jq "packages/codex-plugin/.codex-plugin/plugin.json" \
  '.skills == "./skills/" and .mcpServers == "./.mcp.json"' \
  "Codex plugin must expose package-local shared skills and MCP registration"
expect_jq "packages/codex-plugin/.mcp.json" \
  '.mcpServers.cdp.command == "node" and .mcpServers.cdp.args[0] == "-e" and (.mcpServers.cdp.args[1] | contains("cdp-supervisor.js")) and (.mcpServers.cdp.cwd? | not)' \
  "Codex MCP registration must launch through the cache-safe supervisor wrapper without overriding app cwd"
codex_bootstrap="$(json '.mcpServers.cdp.args[1] // empty' "$ROOT/packages/codex-plugin/.mcp.json")"
case "$codex_bootstrap" in
  *"const V='$synth_version';"*) ;;
  *) fail "Codex MCP bootstrap must pin cache lookup to plugin version $synth_version" ;;
esac
if printf '%s\n' "$codex_bootstrap" | grep -q 'sort('; then
  fail "Codex MCP bootstrap must not choose rn-dev-agent cache entries by mtime"
fi
if printf '%s\n' "$codex_bootstrap" | grep -q "rn-dev-agent-core"; then
  fail "Codex MCP bootstrap must delegate only to the package launcher, not a global core cache"
fi
if grep -Eq 'marketplaceSourceFromConfig|sourcePluginRootFromMarketplace|rn-dev-agent-core.*plugins.*cache|plugins.*cache.*rn-dev-agent-core' "$ROOT/packages/codex-plugin/bin/cdp-supervisor.js"; then
  fail "Codex supervisor wrapper must not depend on marketplace source or global core caches"
fi
expect_jq "packages/shared-agent-knowledge/source-map.json" \
  '.canonicalSources.skills == "./skills" and .canonicalSources.commands == "./commands" and .canonicalSources.agents == "./agents" and .nativeRunners.ios == "../rn-fast-runner" and .nativeRunners.android == "../rn-android-runner" and .hostOutputs.claude.manifest == "../claude-plugin/.claude-plugin/plugin.json" and .hostOutputs.claude.legacyManifest == "../claude-plugin/plugin.json" and .hostOutputs.claude.rootMarketplace == "../../.claude-plugin/marketplace.json" and .hostOutputs.claude.packageMarketplace == "../claude-plugin/.claude-plugin/marketplace.json" and .hostOutputs.claude.runtime == "../claude-plugin/rn-dev-agent-core/dist/supervisor.js" and .hostOutputs.claude.runnerManifest == "../claude-plugin/runner-manifest.json" and .hostOutputs.claude.nativeRunnerScripts == "../claude-plugin/scripts" and .hostOutputs.claude.skills == "../claude-plugin/skills" and .hostOutputs.codex.manifest == "../codex-plugin/.codex-plugin/plugin.json" and .hostOutputs.codex.launcher == "../codex-plugin/bin/cdp-supervisor.js" and .hostOutputs.codex.runtime == "../codex-plugin/rn-dev-agent-core/dist/supervisor.js" and .hostOutputs.codex.runnerManifest == "../codex-plugin/runner-manifest.json" and .hostOutputs.codex.nativeRunnerScripts == "../codex-plugin/scripts" and .hostOutputs.codex.skills == "../codex-plugin/skills" and (.compatibilityOutputs? | not) and .apps.docsSite.path == "../../apps/docs-site" and (.apps.docsSite.compatibilityPath? | not)' \
  "shared-agent-knowledge source map must point at package-owned sources, host outputs, and docs app"

expect_eq "$(json '.version' "$ROOT/packages/claude-plugin/plugin.json")" "$synth_version" "Claude plugin manifest version"
expect_eq "$(json '.version' "$ROOT/packages/claude-plugin/.claude-plugin/plugin.json")" "$synth_version" "Claude plugin .claude-plugin manifest version"
expect_eq "$(json '.version' "$ROOT/packages/codex-plugin/.codex-plugin/plugin.json")" "$synth_version" "Codex plugin manifest version"
marketplace_version="$(jq -r '.plugins[] | select(.name == "rn-dev-agent") | .version' "$ROOT/packages/claude-plugin/marketplace.json")"
expect_eq "$marketplace_version" "$synth_version" "Claude marketplace version"
claude_marketplace_manifest_version="$(jq -r '.plugins[] | select(.name == "rn-dev-agent") | .version' "$ROOT/packages/claude-plugin/.claude-plugin/marketplace.json")"
expect_eq "$claude_marketplace_manifest_version" "$synth_version" "Claude package marketplace manifest version"
root_marketplace_manifest_version="$(jq -r '.plugins[] | select(.name == "rn-dev-agent") | .version' "$ROOT/.claude-plugin/marketplace.json")"
expect_eq "$root_marketplace_manifest_version" "$synth_version" "root Claude marketplace manifest version"

if [ "$failures" -ne 0 ]; then
  echo "check-agent-package-sync: $failures failure(s)" >&2
  exit 1
fi

echo "check-agent-package-sync: package split, app deliverables, and host artifacts are in sync."

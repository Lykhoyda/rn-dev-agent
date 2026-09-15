#!/usr/bin/env bash
# Guard the Yarn workspace split from GH #498 and the single distribution root
# from GH #892: core owns MCP/device behavior, packages/claude-plugin is the one
# directory both marketplaces install (Claude surface + generated Codex
# adapters + one bundled runtime), packages/codex-plugin is Codex authoring
# only, shared-agent-knowledge owns canonical workflow guidance, and apps/*
# owns deliverable apps. Generated outputs are real directories; legacy root
# shims and a second host runtime must not exist.
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
    fail "path must not exist: $path"
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
    fail "$label must match its source directory $source"
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

expect_codex_skill_inventory() {
  local source_map="$ROOT/packages/shared-agent-knowledge/source-map.json"
  local domain command expected actual name files
  domain="$(jq -r '.hostAdaptations.codex.adaptedDomainSkills[]?' "$source_map" | sort)"
  command="$(jq -r '.hostAdaptations.codex.commandSkills[]?' "$source_map" | sort)"
  expected="$(printf '%s\n%s\n' "$domain" "$command" | grep -v '^$' | sort -u)"
  actual="$(find "$ROOT/packages/claude-plugin/codex-skills" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort)"
  authoring="$(find "$ROOT/packages/codex-plugin/skills" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort)"
  if [ "$(printf '%s\n' "$domain" | grep -c .)" -ne 11 ] || \
     [ "$(printf '%s\n' "$command" | grep -c .)" -ne 17 ] || \
     [ "$(printf '%s\n' "$expected" | grep -c .)" -ne 28 ]; then
    fail "Codex source-map inventory must contain 11 domain + 17 non-colliding workflow skills"
  fi
  if [ "$actual" != "$expected" ]; then
    fail "Distributed codex-skills must equal exactly 11 adapted domain + 17 generated workflow skills"
  fi
  if [ "$authoring" != "$domain" ]; then
    fail "packages/codex-plugin/skills must contain exactly the 11 authored domain skills (workflow adapters are generated into packages/claude-plugin/codex-skills)"
  fi
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    expect_same_file_set \
      "packages/shared-agent-knowledge/skills/$name" \
      "packages/codex-plugin/skills/$name" \
      "Codex adapted domain skill $name"
    expect_synced_dir \
      "packages/codex-plugin/skills/$name" \
      "packages/claude-plugin/codex-skills/$name" \
      "Distributed Codex domain skill $name"
  done <<< "$domain"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    for files in SKILL.md agents/openai.yaml; do
      expect_file "packages/claude-plugin/codex-skills/$name/$files"
    done
    if ! grep -q 'GENERATED by scripts/build-host-runtimes.ts' "$ROOT/packages/claude-plugin/codex-skills/$name/SKILL.md"; then
      fail "Codex workflow skill $name must be marker-owned generated output"
    fi
    if ! grep -q "](../../codex-commands/$name.md)" "$ROOT/packages/claude-plugin/codex-skills/$name/SKILL.md"; then
      fail "Codex workflow skill $name must link its packaged codex-commands playbook"
    fi
    if ! grep -Eq 'allow_implicit_invocation:[[:space:]]+false' "$ROOT/packages/claude-plugin/codex-skills/$name/agents/openai.yaml"; then
      fail "Codex workflow skill $name must disable implicit invocation"
    fi
  done <<< "$command"
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
  .cursor-plugin/marketplace.json \
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
  packages/claude-plugin/.cursor-plugin/plugin.json \
  packages/claude-plugin/mcp.json \
  packages/claude-plugin/marketplace.json \
  packages/claude-plugin/.claude-plugin/marketplace.json \
  packages/claude-plugin/hooks/hooks.json \
  packages/claude-plugin/scripts/record_proof.sh \
  packages/claude-plugin/scripts/collect-feedback.sh \
  packages/claude-plugin/scripts/generate_pr_body.sh \
  packages/claude-plugin/runner-manifest.json \
  packages/claude-plugin/AGENTS-MD-TEMPLATE.md \
  packages/claude-plugin/.codex-plugin/plugin.json \
  packages/claude-plugin/codex.mcp.json \
  packages/claude-plugin/bin/cdp-supervisor.js \
  packages/claude-plugin/bin/plugin-health.js \
  packages/claude-plugin/bin/package.json \
  packages/claude-plugin/codex-templates/rn-agent/.scaffold-version \
  packages/claude-plugin/scripts/expo_ensure_running.sh \
  packages/claude-plugin/scripts/eas_resolve_artifact.sh \
  packages/claude-plugin/scripts/check-vercel-rules.mjs \
  packages/claude-plugin/scripts/snapshot_state.sh \
  packages/claude-plugin/rn-dev-agent-core/package.json \
  packages/claude-plugin/rn-dev-agent-core/dist/index.js \
  packages/claude-plugin/rn-dev-agent-core/dist/learned-actions.js \
  packages/claude-plugin/rn-dev-agent-core/dist/workflow-check.js \
  packages/claude-plugin/rn-dev-agent-core/dist/observability/web-dist/index.html \
  packages/claude-plugin/rn-dev-agent-core/dist/supervisor.js \
  packages/claude-plugin/rn-dev-agent-core/dist/web-dist/index.html \
  packages/claude-plugin/scripts/rn-fast-runner/package.json \
  packages/claude-plugin/scripts/rn-fast-runner/RnFastRunner/RnFastRunner.xcodeproj/project.pbxproj \
  packages/claude-plugin/scripts/rn-android-runner/package.json \
  packages/claude-plugin/scripts/rn-android-runner/gradlew \
  packages/claude-plugin/scripts/rn-android-runner/app/build.gradle.kts \
  packages/codex-plugin/package.json \
  packages/codex-plugin/src/AGENTS-MD-TEMPLATE.md \
  packages/codex-plugin/src/plugin-health.ts \
  packages/codex-plugin/.codex-plugin/plugin.json \
  packages/codex-plugin/.mcp.json \
  packages/codex-plugin/bin/cdp-supervisor.js \
  packages/rn-fast-runner/package.json \
  packages/rn-fast-runner/RnFastRunner/RnFastRunner.xcodeproj/project.pbxproj \
  packages/rn-android-runner/package.json \
  packages/rn-android-runner/gradlew \
  packages/rn-android-runner/app/build.gradle.kts \
  packages/shared-agent-knowledge/package.json \
  packages/shared-agent-knowledge/source-map.json \
  packages/shared-agent-knowledge/skills/using-rn-dev-agent/SKILL.md \
  packages/shared-agent-knowledge/commands/test-feature.md \
  packages/shared-agent-knowledge/commands/qa-pr.md \
  packages/shared-agent-knowledge/agents/rn-tester.md \
  packages/shared-agent-knowledge/agents/rn-pr-qa.md
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
  packages/claude-plugin/scripts/rn-fast-runner \
  packages/claude-plugin/scripts/rn-android-runner \
  packages/claude-plugin/bin \
  packages/claude-plugin/.codex-plugin \
  packages/claude-plugin/codex-skills \
  packages/claude-plugin/codex-commands \
  packages/claude-plugin/codex-agents \
  packages/claude-plugin/codex-templates \
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
  .mcp.json \
  packages/claude-plugin/.mcp.json \
  packages/codex-plugin/rn-dev-agent-core \
  packages/codex-plugin/scripts \
  packages/codex-plugin/runner-manifest.json \
  packages/codex-plugin/CLAUDE-MD-TEMPLATE.md \
  packages/codex-plugin/AGENTS-MD-TEMPLATE.md \
  packages/codex-plugin/bin/plugin-health.js \
  packages/codex-plugin/bin/package.json
do
  expect_no_path "$path"
done

expect_synced_dir "packages/shared-agent-knowledge/skills" "packages/claude-plugin/skills" "Claude skills"
expect_synced_dir "packages/shared-agent-knowledge/commands" "packages/claude-plugin/commands" "Claude commands"
expect_synced_dir "packages/shared-agent-knowledge/agents" "packages/claude-plugin/agents" "Claude agents"
expect_synced_dir "packages/shared-agent-knowledge/templates" "packages/claude-plugin/templates" "Claude templates"
# Cursor reuses the Claude command/skill copies and exports CURSOR_PLUGIN_ROOT,
# not CLAUDE_PLUGIN_ROOT. Claude-only path expansions miss the bundled helpers.
shared_workflow_roots=(
  "$ROOT/packages/shared-agent-knowledge/commands"
  "$ROOT/packages/shared-agent-knowledge/skills"
  "$ROOT/packages/shared-agent-knowledge/agents"
)
if grep -REn --include='*.md' '\$\{CLAUDE_PLUGIN_ROOT\}/' "${shared_workflow_roots[@]}" >/dev/null 2>&1; then
  fail "shared workflows must use the host-neutral plugin-root fallback (include CURSOR_PLUGIN_ROOT)"
fi
if grep -REn --include='*.md' '\$CLAUDE_PLUGIN_ROOT/' "${shared_workflow_roots[@]}" >/dev/null 2>&1; then
  fail "shared workflows must use the host-neutral plugin-root fallback (include CURSOR_PLUGIN_ROOT)"
fi
expect_codex_skill_inventory
expect_same_file_set "packages/shared-agent-knowledge/commands" "packages/codex-plugin/commands" "Codex commands"
expect_same_file_set "packages/shared-agent-knowledge/agents" "packages/codex-plugin/agents" "Codex agents"
expect_same_file_set "packages/shared-agent-knowledge/templates" "packages/codex-plugin/templates" "Codex templates"
expect_synced_dir "packages/codex-plugin/commands" "packages/claude-plugin/codex-commands" "Distributed codex-commands"
expect_synced_dir "packages/codex-plugin/agents" "packages/claude-plugin/codex-agents" "Distributed codex-agents"
expect_synced_dir "packages/codex-plugin/templates" "packages/claude-plugin/codex-templates" "Distributed codex-templates"
expect_synced_native_runner_dir "packages/rn-fast-runner" "packages/claude-plugin/scripts/rn-fast-runner" "Packaged iOS runner assets"
expect_synced_native_runner_dir "packages/rn-android-runner" "packages/claude-plugin/scripts/rn-android-runner" "Packaged Android runner assets"
if [ -f "$ROOT/runner-manifest.json" ] && [ -f "$ROOT/packages/claude-plugin/runner-manifest.json" ] && ! cmp -s "$ROOT/runner-manifest.json" "$ROOT/packages/claude-plugin/runner-manifest.json"; then
  fail "Packaged runner manifest must match runner-manifest.json"
fi
# Generated Codex adapters must be byte copies of their authoring sources.
if ! cmp -s "$ROOT/packages/codex-plugin/.codex-plugin/plugin.json" "$ROOT/packages/claude-plugin/.codex-plugin/plugin.json"; then
  fail "packages/claude-plugin/.codex-plugin/plugin.json must match packages/codex-plugin/.codex-plugin/plugin.json"
fi
if ! cmp -s "$ROOT/packages/codex-plugin/.mcp.json" "$ROOT/packages/claude-plugin/codex.mcp.json"; then
  fail "packages/claude-plugin/codex.mcp.json must match packages/codex-plugin/.mcp.json"
fi
if ! cmp -s "$ROOT/packages/codex-plugin/bin/cdp-supervisor.js" "$ROOT/packages/claude-plugin/bin/cdp-supervisor.js"; then
  fail "packages/claude-plugin/bin/cdp-supervisor.js must match packages/codex-plugin/bin/cdp-supervisor.js"
fi
expect_jq "packages/claude-plugin/bin/package.json" '.type == "module" and .private == true' \
  "packages/claude-plugin/bin/package.json must give the ESM launchers a contained module boundary"
# Helper scripts the Claude hooks/skills call at runtime ship in the package
# (single writer: build-host-runtimes.ts).
for helper in mcp-bridge-probe.mjs ensure-cdp-deps.sh ensure-maestro-runner.sh \
  ensure-idb-companion.sh ensure-idb.sh ensure-ffmpeg.sh \
  ensure-troubleshooting-doc.sh ensure-android-ready.sh \
  check-physical-devices.sh; do
  if ! cmp -s "$ROOT/scripts/$helper" "$ROOT/packages/claude-plugin/scripts/$helper"; then
    fail "Claude package scripts/$helper must match scripts/$helper"
  fi
done
if ! cmp -s "$ROOT/CLAUDE-MD-TEMPLATE.md" "$ROOT/packages/claude-plugin/CLAUDE-MD-TEMPLATE.md"; then
  fail "Claude package CLAUDE-MD-TEMPLATE.md must match the root template"
fi
if ! cmp -s "$ROOT/scripts/record_proof.sh" "$ROOT/packages/claude-plugin/scripts/record_proof.sh"; then
  fail "Claude package record_proof.sh must match scripts/record_proof.sh"
fi
if ! cmp -s "$ROOT/scripts/collect-feedback.sh" "$ROOT/packages/claude-plugin/scripts/collect-feedback.sh"; then
  fail "Claude package collect-feedback.sh must match scripts/collect-feedback.sh"
fi
if ! cmp -s "$ROOT/scripts/generate_pr_body.sh" "$ROOT/packages/claude-plugin/scripts/generate_pr_body.sh"; then
  fail "Claude package generate_pr_body.sh must match scripts/generate_pr_body.sh"
fi
for helper in expo_ensure_running.sh eas_resolve_artifact.sh check-vercel-rules.mjs snapshot_state.sh; do
  if ! cmp -s "$ROOT/scripts/$helper" "$ROOT/packages/claude-plugin/scripts/$helper"; then
    fail "Claude package scripts/$helper must match scripts/$helper"
  fi
done
if ! cmp -s "$ROOT/packages/codex-plugin/src/AGENTS-MD-TEMPLATE.md" "$ROOT/packages/claude-plugin/AGENTS-MD-TEMPLATE.md"; then
  fail "packages/claude-plugin/AGENTS-MD-TEMPLATE.md must match packages/codex-plugin/src/AGENTS-MD-TEMPLATE.md"
fi
if ! grep -q 'plugin-health.ts' "$ROOT/packages/claude-plugin/bin/plugin-health.js"; then
  fail "Codex plugin health output must be generated from the TypeScript source"
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
expect_eq "$(json '.name' "$ROOT/packages/claude-plugin/rn-dev-agent-core/package.json")" "rn-dev-agent-core" "packaged runtime name (host-neutral)"
expect_eq "$(json '.type' "$ROOT/packages/claude-plugin/rn-dev-agent-core/package.json")" "module" "packaged runtime type"
expect_eq "$(json '.private' "$ROOT/packages/claude-plugin/rn-dev-agent-core/package.json")" "true" "packaged runtime private flag"
expect_eq "$(json '.version' "$ROOT/packages/claude-plugin/rn-dev-agent-core/package.json")" "$core_version" "packaged runtime core version"
expect_eq "$(json '.name' "$ROOT/apps/docs-site/package.json")" "rn-dev-agent-docs" "docs app package name"

for claude_manifest in packages/claude-plugin/plugin.json packages/claude-plugin/.claude-plugin/plugin.json; do
  expect_jq "$claude_manifest" \
    '.mcpServers.cdp.command == "node" and .mcpServers.cdp.args[0] == "${CLAUDE_PLUGIN_ROOT}/rn-dev-agent-core/dist/supervisor.js"' \
    "$claude_manifest must spawn the package-local bundled supervisor (installs copy only the package dir)"
  expect_jq "$claude_manifest" \
    '.mcpServers.cdp.env.RN_DEV_AGENT_CODEX_PLUGIN_ROOT == "" and .mcpServers.cdp.env.CODEX_PLUGIN_ROOT == ""' \
    "$claude_manifest must clear inherited Codex root hints so the neutral runtime resolves Claude's launching root"
done
expect_jq "packages/claude-plugin/.cursor-plugin/plugin.json" \
  '.mcpServers == "./mcp.json" and .hooks.hooks == {}' \
  "Cursor Plugin manifest must pin package-local mcp.json and skip Claude hooks"
expect_jq "packages/claude-plugin/mcp.json" \
  '.mcpServers.cdp.command == "node" and .mcpServers.cdp.args == ["${CURSOR_PLUGIN_ROOT}/rn-dev-agent-core/dist/supervisor.js"] and (.mcpServers.cdp.cwd? | not)' \
  "Cursor MCP registration must spawn the package-local supervisor with the process lock on and without overriding app cwd"
expect_jq ".cursor-plugin/marketplace.json" \
  '.plugins[] | select(.name == "rn-dev-agent") | .source == "./packages/claude-plugin"' \
  "root Cursor marketplace must point at the Claude package (Cursor Plugin payload)"
expect_jq ".agents/plugins/marketplace.json" \
  '.name == "rn-dev-agent" and (.plugins[] | select(.name == "rn-dev-agent") | .source.source == "local" and .source.path == "./packages/claude-plugin")' \
  "Codex marketplace manifest must resolve the shared distribution directory packages/claude-plugin"
expect_jq ".claude-plugin/marketplace.json" \
  '.plugins[] | select(.name == "rn-dev-agent") | .source == "./packages/claude-plugin"' \
  "root Claude marketplace must point at the package-owned Claude plugin"
expect_jq "packages/claude-plugin/.claude-plugin/marketplace.json" \
  '.plugins[] | select(.name == "rn-dev-agent") | .source == "./"' \
  "package-local Claude marketplace must point at the package root"
for codex_manifest in packages/codex-plugin/.codex-plugin/plugin.json packages/claude-plugin/.codex-plugin/plugin.json; do
  expect_jq "$codex_manifest" \
    '.skills == "./codex-skills/" and .commands == [] and .mcpServers == "./codex.mcp.json" and .hooks == {"hooks": {}}' \
    "$codex_manifest must select codex-skills/ and codex.mcp.json, disable command migration, and declare empty hooks so Claude hooks/ is never discovered"
done
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
for launcher in packages/codex-plugin/bin/cdp-supervisor.js packages/claude-plugin/bin/cdp-supervisor.js; do
  if grep -Eq 'marketplaceSourceFromConfig|sourcePluginRootFromMarketplace|rn-dev-agent-core.*plugins.*cache|plugins.*cache.*rn-dev-agent-core' "$ROOT/$launcher"; then
    fail "$launcher must not depend on marketplace source or global core caches"
  fi
done
expect_jq "packages/shared-agent-knowledge/source-map.json" \
  '.canonicalSources.skills == "./skills" and .canonicalSources.commands == "./commands" and .canonicalSources.agents == "./agents" and .nativeRunners.ios == "../rn-fast-runner" and .nativeRunners.android == "../rn-android-runner" and (.hostAdaptations.codex.adaptedCommands | length) == 17 and (.hostAdaptations.codex.adaptedDomainSkills | length) == 11 and (.hostAdaptations.codex.commandSkills | length) == 17 and .hostAdaptations.codex.liveRefreshFloor == "0.145.0" and .hostAdaptations.codex.healthSource == "../codex-plugin/src/plugin-health.ts" and .hostAdaptations.codex.healthOutput == "../claude-plugin/bin/plugin-health.js" and .hostAdaptations.codex.agentsTemplateSource == "../codex-plugin/src/AGENTS-MD-TEMPLATE.md" and .hostAdaptations.codex.agentsTemplateOutput == "../claude-plugin/AGENTS-MD-TEMPLATE.md" and .hostAdaptations.codex.authoringRoot == "../codex-plugin" and .hostAdaptations.codex.manifestSource == "../codex-plugin/.codex-plugin/plugin.json" and .hostAdaptations.codex.mcpSource == "../codex-plugin/.mcp.json" and .hostAdaptations.codex.launcherSource == "../codex-plugin/bin/cdp-supervisor.js" and .hostAdaptations.codex.skillsSource == "../codex-plugin/skills" and .hostAdaptations.codex.commandsSource == "../codex-plugin/commands" and .hostAdaptations.codex.agentsSource == "../codex-plugin/agents" and .hostAdaptations.codex.templatesSource == "../codex-plugin/templates/rn-agent" and .hostOutputs.claude.manifest == "../claude-plugin/.claude-plugin/plugin.json" and .hostOutputs.claude.legacyManifest == "../claude-plugin/plugin.json" and .hostOutputs.claude.rootMarketplace == "../../.claude-plugin/marketplace.json" and .hostOutputs.claude.packageMarketplace == "../claude-plugin/.claude-plugin/marketplace.json" and .hostOutputs.claude.runtime == "../claude-plugin/rn-dev-agent-core/dist/supervisor.js" and .hostOutputs.claude.runnerManifest == "../claude-plugin/runner-manifest.json" and .hostOutputs.claude.nativeRunnerScripts == "../claude-plugin/scripts" and .hostOutputs.claude.skills == "../claude-plugin/skills" and .hostOutputs.codex.distributionRoot == "../claude-plugin" and .hostOutputs.codex.manifest == "../claude-plugin/.codex-plugin/plugin.json" and .hostOutputs.codex.mcp == "../claude-plugin/codex.mcp.json" and .hostOutputs.codex.launcher == "../claude-plugin/bin/cdp-supervisor.js" and .hostOutputs.codex.launcherPackage == "../claude-plugin/bin/package.json" and .hostOutputs.codex.health == "../claude-plugin/bin/plugin-health.js" and .hostOutputs.codex.agentsTemplate == "../claude-plugin/AGENTS-MD-TEMPLATE.md" and .hostOutputs.codex.runtime == "../claude-plugin/rn-dev-agent-core/dist/supervisor.js" and .hostOutputs.codex.runnerManifest == "../claude-plugin/runner-manifest.json" and .hostOutputs.codex.nativeRunnerScripts == "../claude-plugin/scripts" and .hostOutputs.codex.skills == "../claude-plugin/codex-skills" and .hostOutputs.codex.commands == "../claude-plugin/codex-commands" and .hostOutputs.codex.agents == "../claude-plugin/codex-agents" and .hostOutputs.codex.templates == "../claude-plugin/codex-templates/rn-agent" and (.compatibilityOutputs? | not) and .apps.docsSite.path == "../../apps/docs-site" and (.apps.docsSite.compatibilityPath? | not)' \
  "shared-agent-knowledge source map must point at package-owned sources, Codex authoring inputs, the single distributed outputs, and docs app"
expect_jq "packages/shared-agent-knowledge/source-map.json" \
  '.hostOutputs.claude.cursorManifest == "../claude-plugin/.cursor-plugin/plugin.json" and .hostOutputs.claude.cursorMcp == "../claude-plugin/mcp.json" and .hostOutputs.claude.cursorMarketplace == "../../.cursor-plugin/marketplace.json"' \
  "source map must point at Cursor Plugin manifests on the Claude package"

expect_eq "$(json '.version' "$ROOT/packages/claude-plugin/plugin.json")" "$synth_version" "Claude plugin manifest version"
expect_eq "$(json '.version' "$ROOT/packages/claude-plugin/.claude-plugin/plugin.json")" "$synth_version" "Claude plugin .claude-plugin manifest version"
expect_eq "$(json '.version' "$ROOT/packages/claude-plugin/.cursor-plugin/plugin.json")" "$synth_version" "Cursor Plugin manifest version"
expect_eq "$(json '.version' "$ROOT/packages/codex-plugin/.codex-plugin/plugin.json")" "$synth_version" "Codex plugin manifest version"
expect_eq "$(json '.version' "$ROOT/packages/claude-plugin/.codex-plugin/plugin.json")" "$synth_version" "distributed Codex plugin manifest version"
marketplace_version="$(jq -r '.plugins[] | select(.name == "rn-dev-agent") | .version' "$ROOT/packages/claude-plugin/marketplace.json")"
expect_eq "$marketplace_version" "$synth_version" "Claude marketplace version"
claude_marketplace_manifest_version="$(jq -r '.plugins[] | select(.name == "rn-dev-agent") | .version' "$ROOT/packages/claude-plugin/.claude-plugin/marketplace.json")"
expect_eq "$claude_marketplace_manifest_version" "$synth_version" "Claude package marketplace manifest version"
root_marketplace_manifest_version="$(jq -r '.plugins[] | select(.name == "rn-dev-agent") | .version' "$ROOT/.claude-plugin/marketplace.json")"
expect_eq "$root_marketplace_manifest_version" "$synth_version" "root Claude marketplace manifest version"
cursor_marketplace_version="$(jq -r '.plugins[] | select(.name == "rn-dev-agent") | .version' "$ROOT/.cursor-plugin/marketplace.json")"
expect_eq "$cursor_marketplace_version" "$synth_version" "root Cursor marketplace version"

if [ -e "$ROOT/packages/codex-plugin/.codex-plugin/migrated-command-skills" ]; then
  fail "Codex package must not carry best-effort migrated command skills"
fi
if find "$ROOT/packages/claude-plugin/codex-skills" -mindepth 1 -maxdepth 1 -type d -name 'source-command-*' | grep -q .; then
  fail "Codex native skill inventory must not contain source-command-*"
fi
codex_instruction_paths=(
  "$ROOT/packages/codex-plugin/commands"
  "$ROOT/packages/codex-plugin/skills"
  "$ROOT/packages/codex-plugin/src/AGENTS-MD-TEMPLATE.md"
  "$ROOT/packages/claude-plugin/codex-skills"
)
for pattern in '\$ARGUMENTS|\$\{ARGUMENTS' 'CLAUDE_PLUGIN_ROOT|RN_DEV_AGENT_CODEX_PLUGIN_ROOT|CODEX_PLUGIN_ROOT' '/rn-dev-agent:' 'mcp__plugin_rn-dev-agent_cdp__' '/plugin (install|update)' 'find .*plugins/cache|sort -V.*plugin'; do
  if grep -ERn --include='*.md' --include='*.yaml' --include='*.yml' "$pattern" "${codex_instruction_paths[@]}" >/dev/null 2>&1; then
    fail "Codex runtime instructions contain unsupported host/request/path syntax matching: $pattern"
  fi
done

if [ "$failures" -ne 0 ]; then
  echo "check-agent-package-sync: $failures failure(s)" >&2
  exit 1
fi

echo "check-agent-package-sync: package split, app deliverables, and host artifacts are in sync."

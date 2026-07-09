<claude-mem-context>
# Memory Context

# [claude-react-native-dev-plugin] recent context, 2026-04-29 11:59am GMT+2

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (16,886t read) | 2,682,851t work | 99% savings

### Apr 29, 2026
169 12:36a ✅ Memory Write Rollback: Three Newly Created Feedback Files Deleted
171 12:37a 🔵 doctor.md Documents Command as Read-Only But Doctor Run Modified Project Files
173 9:26a 🟣 rn-dev-agent CDP UI automation initiated to fill tasks form
174 9:28a 🔵 Full 6-task UI automation plan established for task form creation
175 " 🔵 iOS simulator booted (iPhone 17 Pro, iOS 26.3); Metro not running on standard ports
176 " 🔵 .ui-skeleton.yaml maps complete testID schema for test-app including TaskWizardModal
177 " ✅ Metro bundler started as background process for test-app via npx expo start --dev-client
178 " 🔵 Sandbox blocks redirect to /tmp/metro-start.log; Metro restarted with CI=1 flag
179 9:29a 🔵 Metro readiness detected by polling /status endpoint on ports 8081/8082
180 " 🔵 Metro starts but xcrun simctl fails with non-zero exit code during Expo startup
181 " 🔵 Metro process stalled after xcrun simctl error — no port binding on 8081 or 8082
182 " 🔵 Metro via npx expo start abandoned; both background tasks stopped to retry with different approach
183 " 🔵 Metro restarted with dangerouslyDisableSandbox:true to unblock xcrun simctl
184 9:30a 🔵 wizard-create-task.yaml Maestro flow exists in test-app, updated same day as session
185 " 🔵 Test app confirmed installed on iPhone 17 Pro simulator; FastRunner UI test runner also present
186 9:31a 🔵 Test app launched on simulator via xcrun simctl, PID 9983
187 " 🔵 CDP readiness detected via Metro /json/list endpoint polling for Hermes debug target
188 " 🔵 Metro bundler running on port 8081 but /json/list empty — app not yet connected to debugger
189 " 🔵 App visible on simulator (screenshot ok) but still not connected to Metro CDP after 30+ seconds
190 " 🔵 App screen captured; Metro running but /json/list persistently empty — Hermes not connecting after 90+ seconds
197 " 🔵 Tasks Page Navigation and Create Task FAB Identified
198 " 🔵 App State: iOS Simulator CDP Connection Details
202 9:34a 🔵 cdp-bridge HELPERS_NOT_INJECTED path lacks auto-reinject call
203 9:49a 🔴 Added 1-shot auto-reinject in withConnection() helpers-not-injected guard
204 9:51a 🟣 Added 3 unit tests for auto-reinject path in with-connection.test.js
205 " 🔵 All 11 withConnection tests pass; failure-path test takes 69s due to stale-target recovery fallthrough
207 9:53a 🟣 Added resetActiveSessionInMemoryForTest() to agent-device-wrapper.ts for safe test isolation
206 9:54a 🔴 Added clearActiveSession() in beforeEach to prevent tests hitting real MCP session on disk
208 9:55a 🔴 Test suite time cut from 75s to 10.6s by switching to resetActiveSessionInMemoryForTest()
209 " 🟣 Full cdp-bridge test suite passes: 988/988 tests green after HELPERS_NOT_INJECTED fix
S79 Fix HELPERS_NOT_INJECTED — implementation and tests complete, test suite 7× faster, moving to docs/skill/version tasks (Apr 29 at 9:55 AM)
S81 Fix HELPERS_NOT_INJECTED — 988/988 tests green, dist confirmed updated, starting skill documentation update (Apr 29 at 9:56 AM)
S82 User asked why the Maestro E2E test was not executed — primary session responded by actually running it via maestro-runner, and it passed (Apr 29 at 9:59 AM)
210 10:19a 🔵 RN Dev Agent CDP Status: iOS Connected via Hermes/New Architecture
211 10:20a 🔵 App Navigation Structure: Tab-Based with Tasks, Notifications, Home, Profile Tabs
212 " 🔵 Initial Test Screenshot Captured: HomeMain Screen on High-DPI iOS Device
213 10:21a 🔵 rn-dev-agent:test-feature Invoked for Task Creation
214 10:28a 🔵 Task Creation Wizard: 3-Step Modal Flow Confirmed via FAB
215 10:32a 🔵 Task Creation Feature Uses Wizard-Based Multi-Step UI Flow
216 " 🟣 3-Step Task Creation Wizard UI Testing via rn-dev-agent
217 10:37a 🔵 Task Creation Wizard — Multi-Step Navigation and Metadata Selection Verified
218 10:38a 🔵 Task Creation Wizard UI Test via rn-dev-agent CDP
219 10:46a 🔴 maestro-runner -e Flag Invocation Bug: Arguments Parsed as File Paths
220 " 🟣 Task Create V2 Feature Development Started
221 10:49a 🔵 Maestro E2E Wizard Flow Exists But Was Not Executed
S85 Apply Maestro artifact fixes + create new "execute artifacts before manual walks" memory — full retrospective from "create a new task" session (Apr 29 at 10:59 AM)
S86 Apply Codex/Gemini reviewer corrections to 3 artifacts + git commit + ROADMAP update — expanded to include new list-learned-actions command and test-feature Step 0 upgrade (Apr 29 at 11:04 AM)
S83 Creating a new task via CDP/Maestro E2E flow and analyzing why the Maestro flow wasn't used initially — covering Maestro wrapper YAML execution, iOS inputText digraph quirk, and proposed artifact fixes (Apr 29 at 11:04 AM)
S84 Apply Maestro artifact fixes from "create a new task" session — self-bootstrapping YAML + iOS digraph quirk documentation (Apr 29 at 11:04 AM)
S87 Fix factually incorrect Maestro memory files, make wizard-create-task.yaml self-bootstrapping, add list-learned-actions command, upgrade test-feature.md, add Tool Routing section to CLAUDE-MD-TEMPLATE.md, commit all changes, update ROADMAP.md (Apr 29 at 11:10 AM)
S88 Fix Maestro memory factual errors, make wizard-create-task self-bootstrapping, add list-learned-actions command, upgrade test-feature.md, add Tool Routing section to CLAUDE-MD-TEMPLATE.md, create CDP slides, commit all changes, update ROADMAP.md (Apr 29 at 11:20 AM)
S89 CDP presentation slides creation (rn-dev-agent pitch deck), plus ongoing: fix Maestro memory files, add list-learned-actions command, upgrade test-feature.md, add Tool Routing section to CLAUDE-MD-TEMPLATE.md, update ROADMAP.md, git commits (Apr 29 at 11:29 AM)
222 11:55a ⚖️ Brainstorm: reusable actions with cross-session persistence in rn-dev-agent
223 11:56a 🔵 rn-dev-agent plugin full inventory: 5 agents, 15 commands, 7 skills
224 " 🔵 Workspace artifact inventory: 2 Maestro flows + .ui-skeleton.yaml confirmed present
225 " 🔵 Auto-memory corpus: 46 files across feedback_* and project_* namespaces
226 11:57a 🔵 CLAUDE-MD-TEMPLATE.md confirmed at 301 lines with Tool Routing section persisted
227 " 🔵 .ui-skeleton.yaml documents 4 screens with 100+ semantic testID mappings
228 " 🔵 MEMORY.md project state: PR #95 merged, v0.44.3, 967 unit tests, session-state moved to ~/Library
229 " 🔵 using-rn-dev-agent skill has no reference to list-learned-actions command

Access 2683k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>
## Agent surfaces

This repo now supports two host agents without merging their UI concepts:

- Claude Code surface: `packages/claude-plugin/plugin.json`, package-local
  `commands/`, `agents/`, `hooks/`, `skills/`, and the `cdp` MCP server entry.
- Codex surface: `packages/codex-plugin/.codex-plugin/plugin.json`,
  `packages/codex-plugin/.mcp.json`, `AGENTS.md`, package-local `skills/`,
  and a bundled `packages/codex-plugin/rn-dev-agent-core/dist/supervisor.js`
  runtime for the same `cdp` MCP server.
- Core MCP implementation: `packages/rn-dev-agent-core/` owns the CDP bridge,
  device tools, learned-actions runtime, and runnable MCP entrypoint.
- Native runner source projects: `packages/rn-fast-runner/` owns the iOS
  XCTest runner and `packages/rn-android-runner/` owns the Android UiAutomator
  runner. Codex packages generated copies under `packages/codex-plugin/scripts/`
  for installed-plugin runtime delivery.
- Shared workflow knowledge: `packages/shared-agent-knowledge/` owns canonical
  skills, commands, agents, and `templates/rn-agent/`; host packages expose
  real generated/adapted outputs from there.
- Deliverable apps: `apps/docs-site/` owns the documentation site workspace.

Do not rename the MCP server key `cdp`; command docs, troubleshooting notes,
and session state assume it is stable.

### Codex operating notes

- Treat `AGENTS.md` as the durable Codex repo guide and `CLAUDE.md` as the
  local Claude Code guide. Keep shared doctrine in
  `packages/shared-agent-knowledge/` or docs that both hosts can read.
- Claude slash commands do not exist as native Codex commands. When a workflow
  says `/rn-dev-agent:<command>`, read the matching file in
  `packages/codex-plugin/commands/` and execute the steps inline with
  available tools.
- Claude subagents do not map 1:1 to Codex. MCP-bound agents such as
  `rn-tester` and `rn-debugger` are protocol playbooks; execute them in the
  parent session so `cdp_*` and `device_*` tools stay available.
- Before any app/device interaction, run `cdp_status`, inventory reusable
  actions, and prefer `cdp_run_action`/`maestro_run` over recomposing a known
  manual `device_*` walk.

### Repository boundaries

The plugin repo ships user-visible code and docs. The sibling workspace repo
`/Users/anton_personal/GitHub/rn-dev-agent-workspace` holds internal docs,
decisions, bugs, roadmap, proof artifacts, benchmark reports, and the test app.
Do not recreate workspace symlinks in this repo; edit workspace docs by their
real path when a task explicitly requires it.

### Version metadata

`packages/claude-plugin/package.json` is the changesets source of truth for
the agent plugin version. `yarn version-packages` mirrors it into
`packages/claude-plugin/plugin.json`, `packages/codex-plugin/.codex-plugin/plugin.json`, and
the Codex `.mcp.json` bootstrap version pin plus
`packages/claude-plugin/marketplace.json` via `scripts/sync-plugin-manifest.mjs`
and `scripts/sync-versions.sh`. `yarn build:host-runtimes` bundles the core
supervisor into `packages/codex-plugin/rn-dev-agent-core/dist/supervisor.js`
so Codex installs do not depend on sibling workspace state.

## Engineering rules

### TypeScript only (strict — applies to every new file)

All new code in this repo MUST be TypeScript:

- New source modules: `.ts` / `.tsx` — never `.js` / `.mjs` / `.cjs`.
- New tests: `.ts`, run via `node --test` type stripping (Node >= 22.18 strips
  types natively; no build step needed for tests).
- New standalone scripts: `.ts` where runnable (Node scripts); shell scripts
  (`.sh`) remain shell.

Enforced by CI: `scripts/check-typescript-only.sh` fails the Lint & format job
when a `.js`/`.mjs`/`.cjs` file exists outside `scripts/js-migration-baseline.txt`
(the grandfathered pre-rule inventory — mostly node:test suites) and the
generated/vendored exclusions (`packages/rn-dev-agent-core/dist/`,
`packages/codex-plugin/rn-dev-agent-core/dist/`, `**/web-dist/`,
`third_party/`).

Migrating a baseline file to TS: delete the `.js`, add the `.ts` — the check
passes automatically (shrink is free). Growing the baseline requires editing
it in the same PR with justification; treat that as an exception, not a path.

The migration of the ~340 grandfathered files is tracked in a GitHub issue
(search: "migrate JavaScript to TypeScript").

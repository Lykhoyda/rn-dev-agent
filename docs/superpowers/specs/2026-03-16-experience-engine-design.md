# Experience Engine Design Spec

**Date:** 2026-03-16
**Status:** Draft
**Reviewers:** Claude Opus, Codex (GPT-5.4), Gemini 3.1 Pro

## Problem

The `rn-dev-agent` plugin can verify that code works on a live simulator — but it cannot learn from its mistakes. Every session starts from zero. When the agent encounters a RedBox from a missing import, recovers via `cdp_reload`, or wastes 10 fix-retry loops on a known NativeWind quirk, that hard-won knowledge evaporates when the conversation ends.

The existing self-evaluator (see `docs/superpowers/specs/2026-03-12-self-evaluator-design.md`) captures structured reports per run — but those reports are write-only artifacts. Nothing reads them back to prevent the same failure next time.

**The gap:** the plugin has knowledge (skills, references, seed heuristics) but no **experience** — the accumulated intuition that comes from trial and error on real projects.

## Solution

A local-only, self-improving experience system that:

1. **Observes** — captures structured failure/recovery data during `rn-feature-dev` runs (builds on existing evaluator)
2. **Classifies** — normalizes failures by root cause, environment, and failure family
3. **Distills** — extracts actionable heuristics from patterns across multiple runs
4. **Validates** — tests candidate heuristics against a frozen eval suite before promotion
5. **Promotes** — graduates validated heuristics into the agent's active context
6. **Retrieves** — surfaces relevant experience during future runs based on environment + task similarity

All data stays on the user's machine. The plugin team has zero access to or responsibility for experience data.

## Design Principles

1. **Local-only, always** — no telemetry, no cloud sync, no phone-home
2. **Overfitting is a feature** — learning YOUR project's patterns is the goal
3. **Capture everything, promote carefully** — raw traces are cheap; bad heuristics are expensive
4. **Tooling first, prompts last** — improve recovery policies and tool behavior before rewriting prompts
5. **Human-gated promotion (initially)** — only fully automate narrow, machine-verifiable recoveries
6. **Transparent and auditable** — users can read, edit, and delete any experience artifact

## Constraints

- All storage is local filesystem — no database servers, no network dependencies
- Must work within Claude Code's existing `~/.claude/` structure
- Experience files readable by LLMs (Markdown) and machines (JSONL)
- Raw traces auto-pruned — bounded disk usage
- Promoted heuristics kept under 2000 tokens to fit in context window
- Must not slow down normal `rn-feature-dev` execution
- The evaluator report (`docs/reports/`) remains the source of truth for individual runs

## Architecture

### Three-Layer Experience Cascade

Experience resolves with project-local overriding user-global overriding seed, similar to CSS specificity:

```
Priority: Project-Local (highest) > User-Global > Seed (lowest)

┌─────────────────────────────────────────────────────────┐
│ LAYER 1: SEED KNOWLEDGE (read-only, ships with plugin)  │
│                                                         │
│ Location: plugin/seed-experience/                       │
│ Owned by: Plugin team                                   │
│ Contents: Universal RN truths, platform gotchas,        │
│           known failure families, baseline heuristics    │
│ Format: YAML files, versioned with plugin releases      │
│ Examples:                                               │
│   - "Hermes does not support dynamic code execution"    │
│   - "Expo Go cannot use custom native modules"          │
│   - "Metro cache causes stale bundles after config edits"│
│   - "cdp_reload(full=true) fixes most fast-refresh bugs"│
└────────────────────────┬────────────────────────────────┘
                         │ overridden by ▼
┌─────────────────────────────────────────────────────────┐
│ LAYER 2: PROJECT EXPERIENCE (committable to git)        │
│                                                         │
│ Location: <project>/.rn-agent-experience.md             │
│ Owned by: The development team                          │
│ Contents: Project-specific patterns, conventions,       │
│           known quirks of this codebase                 │
│ Format: Markdown (LLM-readable)                         │
│ Examples:                                               │
│   - "We use Zustand for state, not Context providers"   │
│   - "NativeWind v4 needs jsxImportSource in babel"      │
│   - "TasksStackNavigator requires testID on all rows"   │
│   - "FlashList needs clean Metro start to resolve"      │
│ Lifecycle: Agent writes draft → human reviews → commit  │
└────────────────────────┬────────────────────────────────┘
                         │ overridden by ▼
┌─────────────────────────────────────────────────────────┐
│ LAYER 3: USER/MACHINE EXPERIENCE (gitignored, private)  │
│                                                         │
│ Location: ~/.claude/rn-agent/                           │
│ Owned by: Individual developer                          │
│ Contents: Machine-specific quirks, personal patterns,   │
│           raw telemetry, work-in-progress heuristics    │
│ Format: Markdown (active) + JSONL (raw traces)          │
│ Examples:                                               │
│   - "Android emulator takes 30s to boot on this Mac"    │
│   - "Metro port 8081 conflicts with local proxy"        │
│   - "cdp_status sometimes needs 2 retries after wake"   │
└─────────────────────────────────────────────────────────┘
```

### Storage Layout

```
# Shipped with plugin (Layer 1 — read-only)
plugin/seed-experience/
  common-failures.yaml          # Universal RN failure families
  platform-quirks.yaml          # iOS vs Android known differences
  recovery-playbook.yaml        # Standard recovery sequences
  expo-gotchas.yaml             # Expo-specific issues
  version-quirks/
    rn-0.76.yaml                # Version-specific known issues
    rn-0.77.yaml
    expo-sdk-52.yaml

# Per-project (Layer 2 — committable)
<project>/
  .rn-agent-experience.md       # Active project learnings (LLM-readable)
  .gitignore                    # Already includes ~/.claude patterns

# Per-user (Layer 3 — private, gitignored)
~/.claude/rn-agent/
  experience.md                 # Active personal learnings (<2000 tokens)
  config.json                   # Retention settings, redaction prefs
  telemetry/
    YYYY-MM-DD-<slug>.jsonl.gz  # Raw run traces (auto-pruned)
  candidates/
    candidate-<hash>.md         # Heuristics awaiting validation
  exports/                      # Anonymized exports for sharing
```

### Format: Markdown + JSONL Hybrid

**Why not SQLite:** The LLM reads Markdown natively. SQLite requires a query layer the LLM cannot use directly. Claude Code's memory system is already Markdown-based. Users can inspect, edit, and git-commit Markdown. If structured queries are needed later, JSONL imports trivially into SQLite as a v2 migration.

**Active experience files** (`.rn-agent-experience.md`, `experience.md`):
```markdown
# Project Experience — <project-name>
<!-- Auto-generated. Human-reviewed before git commit. -->
<!-- Last compacted: 2026-03-16 | Runs analyzed: 47 -->

## Failure Patterns

### FP-001: NativeWind v4 missing jsxImportSource
- **Symptom:** Styles don't apply, no error thrown
- **Root cause:** babel.config.js missing `jsxImportSource: "nativewind"`
- **Environment:** NativeWind >= 4.0, any RN version
- **Recovery:** Add jsxImportSource to babel config, full reload
- **Confidence:** 95% (seen 3 times, fixed 3 times)
- **First seen:** 2026-03-10 | Last seen: 2026-03-14

### FP-002: Metro stale cache after config change
- **Symptom:** Old bundle served after babel/metro config edit
- **Root cause:** Metro doesn't invalidate cache on config changes
- **Environment:** All RN versions with Metro
- **Recovery:** `cdp_reload(full=true)` or restart Metro with --reset-cache
- **Confidence:** 90% (seen 5 times, fixed 4 times, 1 false positive)
- **First seen:** 2026-03-08 | Last seen: 2026-03-16

## Recovery Shortcuts

### RS-001: RedBox after fast refresh — reload before rewriting code
- **Rule:** If RedBox appears immediately after a file save and the error
  references a module/import, try `cdp_reload(full=true)` BEFORE editing code.
  Fast refresh sometimes fails to pick up new exports.
- **Saves:** ~3 fix-retry loops on average
- **Confidence:** 85%

## Project Conventions

### PC-001: All screen components use testID={screenName}-screen
### PC-002: Redux slices live in src/store/slices/, Zustand in src/store/zustand/
### PC-003: Navigation uses Expo Router with file-based routing
```

**Raw telemetry** (JSONL, one line per event):
```jsonl
{"ts":"2026-03-16T14:32:00Z","run":"s19-reorder","phase":"5.5","event":"tool_call","tool":"cdp_component_tree","params":{"filter":"task-list"},"result":"PASS","latency_ms":340,"env":{"rn":"0.76.9","expo":"52.0.0","platform":"ios","arch":"fabric"}}
{"ts":"2026-03-16T14:33:12Z","run":"s19-reorder","phase":"5.5","event":"failure","tool":"cdp_store_state","error":"timeout","recovery":"cdp_reload(full=true)","recovery_result":"PASS","ttr_ms":4200,"env":{"rn":"0.76.9","expo":"52.0.0","platform":"ios","arch":"fabric"}}
{"ts":"2026-03-16T14:35:00Z","run":"s19-reorder","phase":"5.5","event":"fix_retry","loop":1,"trigger":"missing_import","diff":"+ import { reorderTasks } from '../store/slices/tasksSlice'","outcome":"PASS","ttr_ms":8500}
```

## Capture Protocol

### What to Capture (Per Run)

Builds on the existing evaluator report. The Experience Engine adds:

| Data Point | Source | Purpose |
|------------|--------|---------|
| **Environment fingerprint** | `package.json`, Expo config, Metro config | Match heuristics to compatible environments |
| **Tool call trajectory** | Evaluator CDP table | Identify recurring tool failure patterns |
| **State transitions (before/after)** | CDP snapshots around failures | Capture the exact diff that resolved each failure |
| **Recovery attempts + outcomes** | Evaluator recovery table | Learn which recoveries work for which failures |
| **Time-to-recovery (TTR)** | Timestamps around fix-retry loops | Identify "tar pit" errors vs quick fixes |
| **Fix diffs** | `git diff` at fix-retry boundaries | The exact code change that resolved each failure |
| **Multi-plane disagreements** | Cross-reference CDP + device tools | Categorize failure type (see below) |
| **Screen fingerprint** | Route + visible testIDs + store hash + screenshot perceptual hash | Detect "same screen, different state" situations |

### Environment Fingerprint Schema

Captured once per run, used for heuristic matching:

```yaml
env:
  rn_version: "0.76.9"
  expo_sdk: "52.0.0"           # null if bare RN
  engine: "hermes"             # hermes | jsc
  architecture: "fabric"       # fabric | old
  bridgeless: true
  platform: "ios"              # ios | android
  device: "iPhone 16 Pro"
  metro_port: 8081
  key_deps:
    - "@tanstack/react-query@5.x"
    - "zustand@5.x"
    - "nativewind@4.x"
    - "@react-navigation/native@7.x"
    - "expo-router@4.x"
    - "@shopify/flash-list@1.x"
    - "react-native-reanimated@3.x"
```

### Multi-Plane Disagreement Detection

React Native gives us multiple observation planes. When they disagree, we can classify the failure type automatically:

| Screenshot | Store State | Component Tree | Nav State | Failure Type |
|-----------|-------------|----------------|-----------|--------------|
| Changed | Unchanged | Changed | Same | Render-only update (no state binding) |
| Unchanged | Changed | Changed | Same | Selector/binding bug (state updated, UI didn't) |
| Changed | Changed | Unchanged | Same | Native-only change (Reanimated, native module) |
| Unchanged | Unchanged | Unchanged | Changed | Navigation timing issue (route pushed, screen not mounted) |
| Error/RedBox | N/A | Error overlay | Same | JS crash — check error_log for root cause |
| Unchanged | Unchanged | Unchanged | Same | No-op — the change had no effect |

These disagreement patterns become first-class entries in the failure taxonomy.

### RN Failure Family Ontology

Known failure families are pre-classified in seed knowledge. New families can be discovered at runtime:

```yaml
failure_families:
  - id: FF_STALE_CDP
    name: "Stale CDP target"
    symptoms: ["cdp_status timeout", "WebSocket close 1006", "target not found"]
    recovery: ["cdp_reload(full=true)", "reconnect"]

  - id: FF_REDBOX
    name: "RedBox/LogBox error overlay"
    symptoms: ["error overlay in component tree", "RedBox in screenshot"]
    recovery: ["fix code error", "cdp_reload if fast-refresh stale"]

  - id: FF_FAST_REFRESH_STALE
    name: "Fast refresh did not pick up changes"
    symptoms: ["code changed but UI unchanged", "old exports still used"]
    recovery: ["cdp_reload(full=true) before rewriting code"]

  - id: FF_METRO_CACHE
    name: "Metro serving stale bundle"
    symptoms: ["config change not reflected", "old code running after edit"]
    recovery: ["metro --reset-cache", "cdp_reload(full=true)"]

  - id: FF_EXPO_DIALOG
    name: "Expo Go system dialog blocking"
    symptoms: ["device_find cannot find element", "screenshot shows dialog"]
    recovery: ["dismiss dialog via device_press", "restart Expo Go"]

  - id: FF_KEYBOARD_OVERLAY
    name: "Keyboard obscuring target element"
    symptoms: ["device_press fails", "element behind keyboard"]
    recovery: ["device_back to dismiss keyboard", "scroll to element first"]

  - id: FF_ANIMATION_INVISIBLE
    name: "Reanimated animations invisible to CDP"
    symptoms: ["no animation state in component tree", "visual change only in screenshot"]
    recovery: ["use screenshot timing, not CDP, to verify animations"]

  - id: FF_VIRTUALIZED_OFFSCREEN
    name: "FlashList/FlatList item not rendered"
    symptoms: ["element exists in data but not in component tree"]
    recovery: ["device_swipe to scroll element into viewport first"]
```

## Auto-Redaction Protocol

Even in local storage, sensitive data must be scrubbed before write. This protects users who might share experience files or whose machines are accessed by others.

### Redaction Rules (Applied Before Any Write)

| Data Type | Detection | Action |
|-----------|-----------|--------|
| API keys / tokens | High-entropy regex (trufflehog patterns): `[A-Za-z0-9_\-]{32,}`, `Bearer .*`, `sk-.*`, `pk_.*` | Replace with `[REDACTED_SECRET]` |
| Environment variables | Values from `.env*` files, `process.env.*` references | Replace values with `[ENV:VAR_NAME]` |
| Auth store slices | Redux/Zustand paths matching `auth`, `session`, `token`, `credentials` | Capture shape/types only, not values |
| Network response bodies | All HTTP response body content | Keep method + route template + status + duration; strip body |
| Absolute paths | `/Users/<username>/` patterns | Replace with `~/` |
| Form input values | Values passed to `device_fill` | Replace with `[INPUT:field_ref]` |
| PII patterns | Email regex, phone patterns, SSN patterns | Replace with `[PII_REDACTED]` |
| Screenshot OCR text | Any text extracted from screenshots | Never store OCR text in telemetry |

### Implementation

A `redact(data: Record<string, unknown>): Record<string, unknown>` function in the experience writer that:
1. Deep-traverses all string values
2. Applies regex patterns in priority order
3. Logs redaction count (not content) for auditability
4. Is applied as a mandatory middleware — no write path bypasses it

## Experience Lifecycle

### Phase 1: Observe (During Run)

Runs automatically during `rn-feature-dev`. Extends the existing evaluator:

```
evaluator report (existing)  ──►  raw telemetry JSONL (new)
                                    │
                                    ├── tool call + params + result + latency
                                    ├── failure event + error + recovery attempt
                                    ├── fix-retry loop + trigger + diff + outcome
                                    ├── multi-plane readings at failure point
                                    └── environment fingerprint
```

The evaluator continues to write `docs/reports/` as before. The Experience Engine additionally writes to `~/.claude/rn-agent/telemetry/`.

### Phase 2: Classify (Post-Run)

After Phase 7 (report finalization), the agent runs a classification pass:

1. For each failure in the run, attempt to match against known failure families (seed + promoted)
2. If matched: increment the family's `seen_count` and `success_count` (if recovery worked)
3. If unmatched: create a **candidate failure pattern** with:
   - Symptom signature (tool + error pattern + multi-plane state)
   - Environment fingerprint
   - Recovery that worked (if any)
   - Confidence: LOW (single observation)
4. Check for **multi-plane disagreements** and tag failure type

### Phase 3: Distill (Periodic — The "Compaction" Cycle)

A command `rn-agent-compact` (or auto-triggered after every N runs):

1. Load all telemetry JSONL from the retention window
2. Load current `experience.md` and `.rn-agent-experience.md`
3. Group failures by symptom fingerprint
4. For patterns seen >= 3 times with >= 67% recovery success:
   - Generate a candidate heuristic (Markdown block with the FP/RS format)
   - Assign confidence based on: `(successful_recoveries / total_occurrences) * 100`
5. For existing heuristics not triggered in last 20 runs:
   - Mark as stale, reduce confidence by 20%
   - If confidence drops below 30%, remove
6. Output a new, compacted `experience.md` under 2000 tokens
7. Write candidate heuristics to `candidates/` for human review

**LLM-driven compaction prompt:**
```
You are compacting the rn-dev-agent experience store.

Input:
- Raw telemetry from the last N runs (JSONL)
- Current experience.md
- Current .rn-agent-experience.md

Rules:
1. Consolidate repeated failure patterns into high-level rules
2. Remove rules not triggered in the last 20 runs
3. Update confidence scores based on success rates
4. Keep output under 2000 tokens
5. Preserve the FP-NNN / RS-NNN / PC-NNN numbering scheme
6. Flag any NEW patterns for human review (do not auto-promote)

Output: Updated experience.md content
```

### Phase 4: Validate (Before Promotion)

Before a candidate heuristic is promoted to active experience:

1. **Regression check**: Run the candidate against the frozen eval suite (historical failure cases + happy-path features)
2. **Net improvement**: Candidate must improve outcomes on matching cases WITHOUT degrading non-matching cases
3. **Environment scoping**: Verify the heuristic is scoped to the right environment (do not apply an iOS fix to Android)
4. **Contradiction check**: Ensure the new heuristic does not contradict an existing promoted heuristic

### Phase 5: Promote (Human-Gated Initially)

Promotion paths:

| Destination | Gate | Example |
|-------------|------|---------|
| `~/.claude/rn-agent/experience.md` | Auto (if machine-verifiable recovery) | "cdp_reload fixes fast-refresh stale" |
| `<project>/.rn-agent-experience.md` | Human review + git commit | "This project's ScrollView needs flex:1" |
| `plugin/seed-experience/` | Plugin team review + release | "FlashList needs clean Metro start" |

**Fully automated promotion** (no human gate) is allowed ONLY for:
- Recovery sequences with machine-checkable success criteria (tool call succeeded after recovery)
- Retry policies (e.g., "retry cdp_status once after 2s on timeout")
- Environment-specific timeouts (e.g., "this emulator needs 5s boot wait")

**Everything else requires human review** — especially heuristics that would change code generation patterns or architectural decisions.

### Phase 6: Retrieve (During Future Runs)

At the start of each `rn-feature-dev` run:

1. Parse environment fingerprint from the current project
2. Load experience layers in cascade order: seed → user-global → project-local
3. Filter to heuristics matching the current environment (RN version, Expo SDK, platform, key deps)
4. Inject matching heuristics into the agent's context (max 2000 tokens)
5. During Phase 5.5 (verification), if a failure matches a known pattern:
   - Try the known recovery FIRST before blind fix-retry
   - Log whether the known recovery worked (feedback loop)

### The "Ghost in the Machine" Pattern

Special handling for errors fixable without code changes:

```
IF failure matches a known "no-code-fix" pattern:
  (e.g., Metro cache, fast-refresh stale, CDP target stale)
THEN:
  1. Try recovery action (reload, cache clear, reconnect)
  2. Re-verify
  3. IF fixed: log as "ghost fix" — no code change needed
  4. Do NOT enter fix-retry loop

This alone saves ~3 fix-retry loops per occurrence.
```

## Growth Management

### Retention Tiers

| Tier | Data | Retention | Size Cap |
|------|------|-----------|----------|
| Raw telemetry (JSONL.gz) | Tool calls, failures, traces | 14 days | 250 MB per project |
| Evaluator reports | `docs/reports/*.md` | Indefinite (git-tracked) | N/A |
| Candidate heuristics | `candidates/*.md` | Until reviewed (30 days max) | 50 files |
| Active experience | `experience.md` | Until stale | 2000 tokens |
| Project experience | `.rn-agent-experience.md` | Until removed by team | 3000 tokens |
| Seed knowledge | `seed-experience/*.yaml` | Plugin version lifecycle | N/A |

### Auto-Pruning Rules

1. **Telemetry**: Delete `.jsonl.gz` files older than 14 days or when total exceeds 250MB (oldest first)
2. **Candidates**: Delete unreviewed candidates older than 30 days
3. **Stale heuristics**: Remove from active experience if confidence < 30% or not triggered in 20 runs
4. **Fingerprint dedup**: For repeated identical failures, keep first-seen + last-seen + count, not every instance

## Cold Start Strategy

For new users with no accumulated experience:

### Day 1: Environment-Aware Seed Loading

1. On first run, scan `package.json` + `app.json` + `metro.config.js` + `babel.config.js`
2. Build environment fingerprint
3. Pull matching seed heuristics:
   - Using Expo 52? Load `expo-gotchas.yaml` + `expo-sdk-52.yaml`
   - Using NativeWind? Load NativeWind-specific failure patterns
   - Using Hermes? Load Hermes-specific limitations
4. Inject matched seeds as initial experience context

### Day 5: Passive Capture

- Capture telemetry from runs but do not promote anything yet
- Build baseline understanding of this project's patterns
- Identify first candidate patterns from repeated failures

### Day 20: First Promotions

- Patterns seen >= 3 times with high success rate get promoted
- Human reviews and commits first `.rn-agent-experience.md`
- Team knowledge begins accumulating

### Day 50+: Experienced Instance

- Agent rarely makes environment-specific mistakes
- Known recovery patterns are tried automatically
- TTR drops significantly for known failure classes
- New team members inherit Layer 2 experience via git clone

## Portability and Sharing

### Within a Team (Layer 2 — `.rn-agent-experience.md`)

No special export needed — just `git commit` and `git push`. New team members get team experience on `git clone`. This is the primary sharing mechanism.

### Cross-Project (Anonymized Export)

A command `rn-agent export` produces an anonymized bundle:

1. Strips absolute paths to `~/`
2. Strips project-specific names to generic descriptions
3. Keeps: failure family, symptom fingerprint, environment fingerprint (coarse: `expo 52`, `rn 0.76`), recovery sequence, confidence, success rate
4. Writes to `~/.claude/rn-agent/exports/<timestamp>.yaml`

Users can share these files voluntarily. The plugin team MAY (with explicit opt-in) collect anonymized exports to improve seed knowledge in future releases.

### Import

A command `rn-agent import <file>` loads an exported experience bundle:
1. Validates format
2. Checks for contradictions with existing experience
3. Adds imported heuristics with reduced confidence (70% of original)
4. Marks as "imported" for separate tracking

## Integration with Existing Systems

### Evaluator (Existing)

The evaluator continues unchanged. The Experience Engine consumes evaluator reports as input:

```
rn-feature-dev run
  └── evaluator captures data (existing)
        └── writes docs/reports/<report>.md (existing)
        └── Experience Engine captures telemetry (NEW)
              └── writes ~/.claude/rn-agent/telemetry/<trace>.jsonl.gz (NEW)
              └── runs classification pass (NEW)
```

### Claude Code Memory (Existing)

The Experience Engine does NOT replace Claude Code's `~/.claude/projects/*/memory/` system. They serve different purposes:

| System | Purpose | Scope |
|--------|---------|-------|
| Claude Code Memory | User preferences, project context, feedback | Cross-conversation context |
| Experience Engine | Failure patterns, recovery heuristics, tool reliability | Tool self-improvement |

A projection of key experience insights MAY be mirrored into Claude Code memory as a `rn_dev_agent_experience.md` file for cross-conversation accessibility.

### BUGS.md (Existing)

The evaluator already auto-logs high-confidence bugs to `docs/BUGS.md`. The Experience Engine reads BUGS.md to:
1. Avoid re-learning known bugs as new patterns
2. Cross-reference failure patterns with bug IDs
3. Detect when a bug fix resolves a failure pattern (confidence boost)

## Legal and Liability

### First-Run Consent

On first invocation, display and require explicit `y/N` consent:

```
rn-dev-agent Experience Engine

This plugin will:
- Modify files and run commands in your project (standard Claude Code behavior)
- Interact with the iOS/Android simulator
- Store diagnostic telemetry locally at ~/.claude/rn-agent/
- Learn from your development patterns to improve over time

All data stays on your machine. No telemetry is sent anywhere.
The plugin creators take zero responsibility for data loss,
corrupted environments, or broken builds. Use version control.

Enable Experience Engine? [y/N]
```

### SECURITY.md Guarantees

Publish in the plugin repository:

1. **No network requests** beyond the configured LLM provider (Anthropic API via Claude Code)
2. **No telemetry collection** — all experience data is local-only
3. **No data exfiltration** — experience files never leave the machine unless the user explicitly exports
4. **Auto-redaction** — secrets, tokens, PII are scrubbed before any write
5. **Full auditability** — all experience files are human-readable Markdown/JSONL
6. **User control** — delete `~/.claude/rn-agent/` at any time to reset all experience
7. **Opt-out** — set `"experience_engine": false` in `~/.claude/rn-agent/config.json` to disable

### Code Audit Surface

All experience-related code paths are isolated in:
- `scripts/cdp-bridge/src/experience/` — capture, redaction, write
- `seed-experience/` — read-only shipped knowledge
- `commands/rn-agent-compact.md` — compaction command

Users and security teams can audit these paths to verify no data leaves the machine.

## Implementation Phases

### Phase A — Foundation (Seed + Capture)

1. Create `seed-experience/` directory with initial YAML files derived from existing `docs/BUGS.md` entries and `skills/*/references/` knowledge
2. Create `~/.claude/rn-agent/` directory structure on first run
3. Add telemetry JSONL writer to `rn-feature-dev` Phase 7 (extends evaluator)
4. Implement `redact()` function for all write paths
5. Add environment fingerprint capture from `package.json` + config files
6. First-run consent flow

### Phase B — Classification + Retrieval

1. Post-run classification pass (match failures to known families)
2. Experience retrieval at run start (load cascade, filter by environment)
3. "Ghost in the Machine" pattern — try known recoveries before fix-retry
4. Candidate heuristic generation from repeated failures
5. Auto-pruning for telemetry files

### Phase C — Compaction + Promotion

1. `rn-agent-compact` command (LLM-driven compaction)
2. Stale heuristic decay
3. Human-reviewed promotion to `.rn-agent-experience.md`
4. Automated promotion for machine-verifiable recoveries only
5. Confidence scoring and tracking

### Phase D — Sharing + Polish

1. `rn-agent export` / `rn-agent import` commands
2. Layer 2 project experience workflow (draft, review, commit)
3. Cross-run trend analysis (compare frontmatter across evaluator reports)
4. Dashboard view of experience health (confidence distribution, coverage, staleness)

## Acceptance Criteria

1. All experience data stored under `~/.claude/rn-agent/` or `<project>/` — no network writes
2. `redact()` scrubs secrets/PII before every write (verified by test)
3. Seed knowledge loads correctly based on environment fingerprint
4. Telemetry JSONL captures all tool calls, failures, and recoveries from a run
5. Auto-pruning keeps telemetry under 250MB per project
6. Active experience file stays under 2000 tokens after compaction
7. Known recovery patterns are tried before fix-retry on matching failures
8. First-run consent required before any experience data is written
9. `config.json` opt-out flag completely disables the Experience Engine
10. Deleting `~/.claude/rn-agent/` cleanly resets all user experience

## What This Does NOT Do

- No cloud sync or centralized data collection
- No model fine-tuning (experience is prompt-level, not weight-level)
- No autonomous prompt self-editing (tooling and recovery first)
- No cross-user data sharing without explicit export/import
- No performance benchmarking of the LLM itself (only tool reliability)
- No modification to the CDP bridge protocol or MCP tool surface
- No changes to the evaluator report format (it is an input, not modified)

## Prior Art

| System | Concept Borrowed | Adaptation |
|--------|-----------------|------------|
| **Voyager** (MineDojo) | Executable skill library from environment feedback | Failure patterns + recovery playbooks instead of Minecraft skills |
| **Reflexion** (Shinn et al., 2023) | Episodic memory from trial feedback | Structured telemetry to classified failure cases to promoted heuristics |
| **Self-Refine** (Madaan et al., 2023) | Critique/refine at inference time | "Ghost in the Machine" — try known fix before blind retry |
| **DSPy** (Khattab et al., 2023) | Metric-driven prompt optimization | Confidence scoring + eval suite gating before promotion |
| **SWE-agent** (Princeton) | Trajectory-based evaluation | Raw telemetry traces + benchmark-gated improvement |

## Open Questions

1. **Compaction frequency**: After every run? Every 5 runs? On-demand only?
2. **Cross-platform experience**: If a heuristic is learned on iOS, should it apply to Android with reduced confidence?
3. **Experience versioning**: When the plugin updates seed knowledge, how to handle conflicts with user-promoted heuristics?
4. **Team conflict resolution**: If two developers' Layer 2 experiences contradict, how to merge?
5. **Eval suite bootstrap**: What constitutes the initial frozen eval suite for promotion gating?
// D1206 Tier 2 Sprint D / Phase 129 — ReusableAction load/save.
//
// Combines the YAML header + body (immutable contract) with the sidecar
// JSON (mutable runtime state) into a single ReusableAction in-memory
// composite. Underpins /run-action, self-repair, and auto-emission —
// they all read/write through this single chokepoint so schema
// invariants stay enforced.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ReusableAction,
  type M7Metadata,
  parseM7Header,
  serializeM7Header,
} from './reusable-action.js';
import {
  loadOrInitSidecar,
  markSeen,
  saveSidecar,
  sidecarPathFor,
  yamlEditedSinceLastSeen,
} from './sidecar-io.js';
import { atomicWriter } from './atomic-writer.js';
import { assertValidActionId, assertWithinDir } from './path-safety.js';
import { mirrorToDb } from './action-state-store.js';

/**
 * Resolve the canonical YAML path for an action id under a project root.
 * Mirrors the .rn-agent/actions/ convention (D1208 single-folder doctrine,
 * supersedes D1207).
 *
 * Phase 134.3 (deepsec HIGH path-traversal): the regex check is the
 * primary defense — `actionId` flows from caller args (MCP tool params,
 * project YAML file names) and a `../etc/passwd` slug would otherwise
 * escape `.rn-agent/actions/`. The assertWithinDir check is a
 * defense-in-depth chokepoint that catches any future bypass of the
 * regex (e.g. a new caller that forgets to validate).
 */
export function actionPathFor(projectRoot: string, actionId: string): string {
  assertValidActionId(actionId, 'actionPathFor');
  const actionsDir = join(projectRoot, '.rn-agent', 'actions');
  const fileName = `${actionId}.yaml`;
  assertWithinDir(fileName, actionsDir);
  return join(actionsDir, fileName);
}

/**
 * Split a YAML file into (top-section before `---`, header comments
 * sitting above the first non-`#` content, body that follows). The body
 * is what self-repair patches; the header is what M7 metadata lives in.
 *
 * Format assumption (mirrors workspace test-app convention):
 *   appId: com.foo.app
 *   ---
 *   # id: ...
 *   # intent: ...
 *   # status: ...
 *   - launchApp
 *   - tapOn:
 *       id: "fab-create-task"
 *
 * The split returns `{ topSection, headerLines, bodyLines }` so callers
 * can reassemble the YAML preserving the structure.
 *
 * Pure function — exported for unit tests.
 */
export function splitYaml(text: string): {
  topSection: string; // everything BEFORE the `---` separator (e.g. "appId: ...")
  headerLines: string[]; // M7 comment lines AFTER the separator (above the body)
  bodyLines: string[]; // the actual Maestro steps
} {
  const allLines = text.split('\n');
  let separatorIdx = -1;
  for (let i = 0; i < allLines.length; i++) {
    if (allLines[i].trim() === '---') {
      separatorIdx = i;
      break;
    }
  }
  // No separator → treat the entire text as body, no top section, parse
  // header out of leading `#` lines if present.
  //
  // Issue #102 A1: prior implementation flipped `inBody=true` on the
  // first blank line BEFORE any header had been seen, so a YAML with a
  // leading blank line followed by `# id: foo` would put the header in
  // bodyLines (round-trip then duplicated the header on save). Fix:
  // treat leading blank lines as a "leading-blanks" zone that doesn't
  // flip inBody — the body proper starts at the first non-blank,
  // non-comment line.
  if (separatorIdx === -1) {
    const headerLines: string[] = [];
    const bodyLines: string[] = [];
    let inBody = false;
    let seenAnyContent = false;
    for (const line of allLines) {
      if (!inBody && !seenAnyContent && line.trim() === '') {
        // Leading blank — skip; don't add to either bucket. Preserves
        // exact round-trip for files that start with blank lines.
        continue;
      }
      if (!inBody && line.startsWith('#')) {
        seenAnyContent = true;
        headerLines.push(line);
      } else if (!inBody && line.trim() === '' && headerLines.length > 0) {
        // First blank after the header — flip to body and capture this
        // blank as the header/body separator.
        inBody = true;
        bodyLines.push(line);
      } else {
        seenAnyContent = true;
        inBody = true;
        bodyLines.push(line);
      }
    }
    return { topSection: '', headerLines, bodyLines };
  }
  const topSection = allLines.slice(0, separatorIdx).join('\n');
  const afterSep = allLines.slice(separatorIdx + 1);
  // Header = leading `#` comment block (allowing blank lines within); body
  // = everything from the first non-comment, non-blank line onward.
  const headerLines: string[] = [];
  const bodyLines: string[] = [];
  let stillHeader = true;
  for (const line of afterSep) {
    if (stillHeader && (line.startsWith('#') || line.trim() === '')) {
      headerLines.push(line);
    } else {
      stillHeader = false;
      bodyLines.push(line);
    }
  }
  return { topSection, headerLines, bodyLines };
}

/**
 * Reassemble a YAML file from its parts. Inverse of splitYaml.
 */
export function joinYaml(parts: {
  topSection: string;
  headerLines: string[];
  bodyLines: string[];
}): string {
  const out: string[] = [];
  if (parts.topSection) {
    out.push(parts.topSection);
    out.push('---');
  }
  for (const h of parts.headerLines) out.push(h);
  for (const b of parts.bodyLines) out.push(b);
  return out.join('\n');
}

/**
 * Load a ReusableAction from disk by id, under the given project root.
 * Returns null if the YAML doesn't exist OR if M7 metadata is missing
 * (no id/intent — required fields).
 */
export function loadAction(projectRoot: string, actionId: string): ReusableAction | null {
  const filePath = actionPathFor(projectRoot, actionId);
  if (!existsSync(filePath)) return null;
  const text = readFileSync(filePath, 'utf8');
  const metadata = parseM7Header(text, actionId);
  if (!metadata) return null;
  const { bodyLines } = splitYaml(text);
  const state = loadOrInitSidecar(filePath);
  return {
    metadata,
    body: bodyLines.join('\n'),
    filePath,
    state,
  };
}

/**
 * Discriminated result for `saveActionWithCAS` — see issue #117. When
 * `ok: false, conflict: 'EXTERNAL_WRITE'` the on-disk sidecar's
 * `lastSeenMtimeMs` is greater than the in-memory `action.state.
 * lastSeenMtimeMs`, meaning some other writer (concurrent
 * `cdp_run_action`, `cdp_repair_action`, or external tool) raced and
 * persisted between our load and our save. Caller should reload the
 * action and retry.
 */
export type SaveActionCASResult =
  | { ok: true; filePath: string; sidecarPath: string }
  | { ok: false; conflict: 'EXTERNAL_WRITE'; diskMtimeMs: number; expectedMtimeMs: number };

/**
 * Persist a ReusableAction back to disk. Updates the YAML file, the
 * sidecar JSON, and the lastSeenMtimeMs so subsequent
 * yamlEditedSinceLastSeen() checks don't false-alarm on the agent's own
 * write.
 *
 * Caller is responsible for having computed the new metadata/body —
 * this function does not validate transitions (use the lifecycle helpers
 * from reusable-action.ts).
 *
 * NOTE: this overload does NOT do the CAS check (issue #117). Use
 * `saveActionWithCAS` from `cdp_run_action`'s persistRun to detect
 * read-modify-write races on concurrent writers. `saveAction` is kept
 * for callers that already gate concurrency another way (e.g.
 * `cdp_repair_action`, which checks `actionWasEditedExternally` before
 * patching).
 */
export class SaveActionPreconditionError extends Error {
  constructor(filePath: string) {
    super(
      `saveAction precondition violated: yaml at ${filePath} has been ` +
        `edited externally since the in-memory action was loaded. The caller ` +
        `must invoke actionWasEditedExternally() first and abort on true ` +
        `(or use saveActionWithCAS for atomic detection). GH #113 contract ` +
        `enforcement.`,
    );
    this.name = 'SaveActionPreconditionError';
  }
}

export function saveAction(action: ReusableAction): { filePath: string; sidecarPath: string } {
  // GH #113: soft-assertion contract enforcement. Both current callers
  // (cdp_repair_action, cdp_record_test_save_as_action) gate this check
  // correctly, but a future caller (e.g. the planned issue-#104
  // auto-repair-on-failure wiring) could silently clobber a real human
  // edit if it forgot. One stat() per save is cheap defense.
  //
  // Skip the guard when the file doesn't exist yet (first write — there's
  // no external edit to detect, and actionWasEditedExternally returns
  // false in that case anyway via its statSync catch).
  if (existsSync(action.filePath) && actionWasEditedExternally(action)) {
    throw new SaveActionPreconditionError(action.filePath);
  }

  // Read existing top section so we don't lose the `appId:` line.
  let topSection = '';
  if (existsSync(action.filePath)) {
    const existing = readFileSync(action.filePath, 'utf8');
    topSection = splitYaml(existing).topSection;
  }
  // If the action specifies an appId in metadata but the topSection
  // doesn't have one, inject it. Otherwise preserve whatever the file
  // had.
  if (!topSection && action.metadata.appId) {
    topSection = `appId: ${action.metadata.appId}`;
  }
  const headerLines = serializeM7Header(action.metadata).split('\n');
  const bodyLines = action.body.split('\n');
  const yamlText = joinYaml({ topSection, headerLines, bodyLines });

  // Issue #101: sidecar-first atomic pair-write. The atomicWriter owns
  // `lastSeenMtimeMs` correctness — even on partial failure, the
  // persisted sidecar will have lastSeenMtimeMs ≥ the YAML's actual
  // mtime, so the next yamlEditedSinceLastSeen() check returns false
  // (no false-positive alarm).
  const sidecarPath = sidecarPathFor(action.filePath);
  const result = atomicWriter.pairWrite(action.filePath, yamlText, sidecarPath, action.state);
  const stateToWrite = { ...action.state, lastSeenMtimeMs: result.finalMtimeMs };
  // Reflect in-memory so subsequent calls share the just-written mtime.
  action.state = stateToWrite;

  // Task 5 (A2): best-effort DB mirror, STRICTLY AFTER the authoritative
  // #101 pair-write. mirrorToDb is sidecar-less (it must NOT re-write the
  // sidecar — that would break the atomic pair-write) and NEVER throws, so it
  // can't convert a successful write into a failure. No record is appended
  // here (the record-producing call sites do that); this refreshes the index
  // row + stats only.
  mirrorToDb({
    yamlFilePath: action.filePath,
    state: stateToWrite,
    meta: { appId: action.metadata.appId, status: action.metadata.status, path: action.filePath },
  });

  return { filePath: action.filePath, sidecarPath };
}

/**
 * Convenience: check whether a YAML on disk is newer than the in-memory
 * state's lastSeenMtimeMs. Wraps yamlEditedSinceLastSeen() — repair
 * flows abort early when a human has edited the file since the agent
 * last touched it.
 */
export function actionWasEditedExternally(action: ReusableAction): boolean {
  return yamlEditedSinceLastSeen(action.filePath, action.state);
}

/**
 * GH #173 (sub-issue 3): treat the YAML's current on-disk mtime as the
 * new baseline. Stats the YAML, persists `markSeen(state, currentMtime)`
 * to the sidecar, and returns a new ReusableAction with the refreshed
 * lastSeenMtimeMs. Subsequent `actionWasEditedExternally()` checks
 * return false until something edits the YAML again.
 *
 * Use case: `cdp_run_action` is called while the human is actively
 * composing the YAML. The human's edit IS the intent; the Phase 129
 * guardrail (which exists to protect offline human edits from
 * auto-repair clobber) is over-protective in this loop. The orchestrator
 * acknowledges the edit before running so any downstream repair
 * proceeds without `STALE_TARGET`.
 *
 * No-op when the YAML mtime equals the sidecar's lastSeenMtimeMs (the
 * common case where no external write happened).
 */
export function acknowledgeExternalEdit(action: ReusableAction): ReusableAction {
  let currentMtimeMs: number;
  try {
    currentMtimeMs = statSync(action.filePath).mtimeMs;
  } catch {
    return action;
  }
  if (currentMtimeMs <= action.state.lastSeenMtimeMs) return action;
  const nextState = markSeen(action.state, currentMtimeMs);
  saveSidecar(action.filePath, nextState);
  // Task 5 (A2): mirror the refreshed mtime baseline to the DB (best-effort,
  // never throws). No record append — this is a baseline-only update.
  mirrorToDb({
    yamlFilePath: action.filePath,
    state: nextState,
    meta: { appId: action.metadata.appId, status: action.metadata.status, path: action.filePath },
  });
  return { ...action, state: nextState };
}

/**
 * Issue #117: CAS variant of `saveAction`. Compares the on-disk
 * sidecar's `lastSeenMtimeMs` to the in-memory `action.state.
 * lastSeenMtimeMs` BEFORE writing. If disk has advanced (some other
 * writer raced between the caller's `loadAction` and this save), returns
 * `{ ok: false, conflict: 'EXTERNAL_WRITE' }` instead of writing —
 * caller reloads the action and retries.
 *
 * The two saveAction variants exist because:
 *
 *   - `saveAction` (no CAS): used by `cdp_repair_action` after its
 *     `actionWasEditedExternally` guard runs. The repair handler
 *     already gates concurrency at the entry; CAS would be redundant.
 *
 *   - `saveActionWithCAS` (CAS): used by `cdp_run_action`'s persistRun.
 *     The orchestrator emits multiple RunRecord appends per call (first
 *     attempt + retry) and competing `cdp_run_action` calls on the same
 *     actionId need lost-update protection. CAS + retry-on-conflict
 *     makes the read-modify-write atomic at the orchestrator layer.
 *
 * The CAS check uses `lastSeenMtimeMs` rather than `revision` because:
 * (a) `revision` doesn't bump on RunRecord appends today (only on YAML
 * edits + repair), so it's not a unique-per-write counter; (b)
 * `atomicWriter.pairWrite` already advances `lastSeenMtimeMs` on every
 * successful write, so it's a natural monotonic counter.
 */
export function saveActionWithCAS(action: ReusableAction): SaveActionCASResult {
  const sidecarPath = sidecarPathFor(action.filePath);

  // CAS: re-read the on-disk sidecar's lastSeenMtimeMs and compare
  // against the in-memory snapshot.
  if (existsSync(sidecarPath)) {
    try {
      const onDisk = JSON.parse(readFileSync(sidecarPath, 'utf8')) as {
        lastSeenMtimeMs?: number;
      };
      const diskMtimeMs = onDisk.lastSeenMtimeMs ?? 0;
      const expectedMtimeMs = action.state.lastSeenMtimeMs;
      // CAS skip on first save (action loaded with a placeholder zero
      // mtime — happens when `loadOrInitSidecar` couldn't find an
      // existing sidecar). In that case there's nothing to conflict
      // against — proceed to write.
      if (expectedMtimeMs > 0 && diskMtimeMs > expectedMtimeMs) {
        return { ok: false, conflict: 'EXTERNAL_WRITE', diskMtimeMs, expectedMtimeMs };
      }
    } catch {
      // Corrupted sidecar — treat as no prior state, proceed to write.
    }
  }

  // NOTE on the SaveActionPreconditionError that saveAction can throw here:
  // this throw is LOAD-BEARING, not a contract bug. When forceReload=false and
  // the YAML was edited externally, the throw propagates to cdp_run_action's
  // top-level catch and becomes the correct strict-mode (Phase 129) refusal —
  // see gh-173-run-action-force-reload. Converting it to a structured conflict
  // makes persistRun treat it as a transient CAS race and retry-then-succeed,
  // silently dropping the refusal. The RunRecord can't be persisted in that
  // case anyway (the sidecar is pair-written with the YAML, which strict mode
  // is deliberately refusing to clobber), so there is nothing to recover.
  const { filePath, sidecarPath: writtenSidecarPath } = saveAction(action);
  return { ok: true, filePath, sidecarPath: writtenSidecarPath };
}

/**
 * Update only the M7 metadata of an action without touching the body.
 * Used by lifecycle transitions (status: experimental → active).
 */
export function withMetadata(action: ReusableAction, metadata: M7Metadata): ReusableAction {
  return { ...action, metadata };
}

/**
 * Update only the body of an action (preserves metadata + filePath +
 * state). Used by self-repair to write a patched body.
 */
export function withBody(action: ReusableAction, body: string): ReusableAction {
  return { ...action, body };
}

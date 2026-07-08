// D1206 Tier 2 Sprint D-2 / Phase 130 — L2→L3 auto-emission.
//
// After a successful interactive walk (cdp_record_test_start →
// interactions → cdp_record_test_stop), this tool turns the in-memory
// event buffer into a first-class L3 reusable action: emits Maestro YAML
// with full M7 metadata header at <project>/.rn-agent/actions/<id>.yaml
// AND initialises the sidecar runtime state. Closes the L2 → L3 loop
// from D1206 (interactive walk produces the durable artifact).
//
// Why a dedicated tool vs. a side-effect of cdp_record_test_stop: stop
// doesn't know the agent's intent / tags / mutates classification.
// Those come from the agent's understanding of the user's goal, not the
// recorder. Keeping emission explicit means the agent has to make the
// classification decision (which is the right place for it).

import { existsSync } from 'node:fs';
import { okResult, failResult } from '../utils.js';
import type { ToolResult } from '../utils.js';
import { getStoredEvents, getRecordingStartRoute } from './test-recorder.js';
import { generateMaestro } from './test-recorder-generators.js';
import { type ActionLifecycle, freshRuntimeState } from '../domain/reusable-action.js';
import { actionPathFor } from '../domain/action-store.js';
import { mirrorToDb } from '../domain/action-state-store.js';
import { sidecarPathFor } from '../domain/sidecar-io.js';
import { atomicWriter } from '../domain/atomic-writer.js';

export interface SaveAsActionArgs {
  /**
   * Stable slug; becomes the filename. Required. Used as the M7 `id`
   * header field too. Lower-case kebab-case recommended.
   */
  id: string;
  /**
   * One-line goal — the routing key for /list-learned-actions and the
   * /run-action pre-flight. Required.
   */
  intent: string;
  /** Lower-case kebab-case keywords for filtering. Optional. */
  tags?: string[];
  /**
   * Does this flow leave persistent residue? Required for /run-action's
   * safety pre-flight to know whether confirmation is needed before
   * replay. Defaults to undefined — the saved action will surface as
   * `mutates: ?` in /list-learned-actions until the agent classifies it.
   */
  mutates?: boolean;
  /**
   * M7 lifecycle status. Defaults to 'experimental' — first emission
   * needs a clean replay to promote to 'active'.
   */
  status?: ActionLifecycle;
  /**
   * App bundle ID for the Maestro YAML appId header. Strongly
   * recommended; /run-action's pre-flight uses it to refuse cross-app
   * replays.
   */
  bundleId?: string;
  /**
   * Override the project root. Default: process.cwd(). Useful when
   * cdp-bridge is invoked outside the project directory.
   */
  projectRoot?: string;
  /**
   * If an action with this id already exists, refuse unless
   * overwrite=true. Default false (refuse).
   */
  overwrite?: boolean;
  /**
   * Optional one-line description shown as a comment above the M7
   * header in the YAML. Falls back to `intent` when absent.
   */
  testName?: string;
  /**
   * D1209 — state postconditions this action establishes when it runs
   * cleanly. Flat map of primitive values (string | number | boolean).
   * The agent uses this for hybrid composition: when a downstream task
   * needs a state the current app doesn't satisfy, it scans for an
   * action whose `produces` covers the gap and replays it as a
   * deterministic prologue. Optional. Example:
   * `{ authenticated: true, route: 'home' }`.
   */
  produces?: Record<string, string | number | boolean>;
}

export function createSaveAsActionHandler() {
  return async (args: SaveAsActionArgs): Promise<ToolResult> => {
    if (!args.id || typeof args.id !== 'string') {
      return failResult(
        'cdp_record_test_save_as_action requires id (lower-case kebab-case slug)',
        'BAD_FILENAME',
      );
    }
    if (!args.intent || typeof args.intent !== 'string') {
      return failResult(
        'cdp_record_test_save_as_action requires intent (one-line goal)',
        'BAD_FILENAME',
      );
    }
    // Light validation on id shape — refuse path traversal and
    // weird shells in the filename. Lower-case kebab-case + digits.
    if (!/^[a-z0-9][a-z0-9-]*$/.test(args.id)) {
      return failResult(
        `cdp_record_test_save_as_action: id "${args.id}" must be lower-case kebab-case (a-z, 0-9, hyphen). Slashes, dots, uppercase, and underscores are rejected to prevent path traversal and to keep filenames stable across OSes.`,
        'BAD_FILENAME',
      );
    }
    const events = getStoredEvents();
    if (!events || events.length === 0) {
      return failResult(
        'No recorded events to save — call cdp_record_test_start, interact, then cdp_record_test_stop before save_as_action',
        'NO_EVENTS',
      );
    }

    const projectRoot = args.projectRoot ?? process.cwd();
    const filePath = actionPathFor(projectRoot, args.id);
    // Phase 130 (post-review): capture pre-existence ONCE before any
    // write — `existsSync(filePath)` after `writeFileSync` is always
    // true and inverted the `created`/`overwritten` flags in the
    // success payload (multi-LLM review caught this).
    const preexisted = existsSync(filePath);
    if (preexisted && !args.overwrite) {
      return failResult(
        `cdp_record_test_save_as_action: action "${args.id}" already exists at ${filePath}. Pass overwrite=true to replace, or pick a different id.`,
        'BAD_FILENAME',
        {
          actionId: args.id,
          filePath,
          hint: 'Existing actions should be repaired (cdp_repair_action) or extended in place, not silently overwritten.',
        },
      );
    }

    const status: ActionLifecycle = args.status ?? 'experimental';
    const startRoute = getRecordingStartRoute() ?? undefined;

    // generateMaestro emits the appId top section + M7 header + body
    // when bundleId + M7 fields are supplied. Mirrors what hand-authored
    // .rn-agent/actions/*.yaml files look like.
    const yamlText = generateMaestro(events, {
      testName: args.testName ?? args.intent,
      bundleId: args.bundleId,
      startRoute,
      id: args.id,
      intent: args.intent,
      tags: args.tags,
      mutates: args.mutates,
      status,
      produces: args.produces,
    });

    // Issue #101: sidecar-first atomic pair-write. The atomicWriter
    // owns `lastSeenMtimeMs` correctness (overrides whatever we seed in
    // `freshRuntimeState`) so even partial-write failures can't leave
    // the next yamlEditedSinceLastSeen() check returning a false-
    // positive "human edited" alarm.
    const sidecarPath = sidecarPathFor(filePath);
    const initialState = freshRuntimeState(() => new Date(), 0);
    const writeResult = atomicWriter.pairWrite(filePath, yamlText, sidecarPath, initialState);

    // Task 5 (A2/C): seed the DB index row for the brand-new action, STRICTLY
    // AFTER the authoritative #101 pair-write. Initial state has empty history
    // so no run/repair row is appended — index/stats only. Best-effort, never
    // throws. Mirror the POST-write mtime: pairWrite rewrote the sidecar with
    // its finalMtimeMs, so seeding the DB from the pre-write baseline (0) would
    // make a DB-backed load (Phase 2) treat the just-written YAML as externally
    // edited. Mirrors the same correction saveAction applies.
    mirrorToDb({
      yamlFilePath: filePath,
      state: { ...initialState, lastSeenMtimeMs: writeResult.finalMtimeMs },
      meta: { appId: args.bundleId, status, path: filePath },
      projectRoot,
    });

    return okResult({
      // Phase 130 (post-review): use captured pre-existence, not the
      // post-write existsSync (always true) and not args.overwrite
      // (an authorization, not a state).
      created: !preexisted,
      overwritten: preexisted,
      actionId: args.id,
      filePath,
      sidecarPath,
      eventCount: events.length,
      metadata: {
        id: args.id,
        intent: args.intent,
        tags: args.tags,
        mutates: args.mutates,
        status,
        appId: args.bundleId,
        produces: args.produces,
      },
      hint: `Action emitted as experimental. Run /run-action ${args.id} to validate; on first clean replay it auto-promotes to active.`,
    });
  };
}

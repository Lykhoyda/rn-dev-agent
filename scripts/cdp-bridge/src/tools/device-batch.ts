import { runNative } from '../agent-device-wrapper.js';
import { buildDirectionalScrollCliArgs, buildDirectionalSwipeCliArgs, fetchFindCandidates, pressCandidate } from './device-interact.js';
import { withSession, okResult, failResult } from '../utils.js';
import type { ToolResult } from '../utils.js';
import { captureAndResizeScreenshot } from './device-list.js';

export interface BatchStep {
  action: 'find' | 'press' | 'fill' | 'swipe' | 'scroll' | 'back' | 'wait' | 'hideKeyboard' | 'snapshot' | 'screenshot';
  text?: string;
  ref?: string;
  /**
   * D1206 Tier 2 / Phase 125: testID-keyed steps re-resolve via fiber-tree
   * snapshot at execution time — eliminates the stale-ref-across-step-
   * transitions failure mode (D1206 13:55-experiment failure #4). Slower
   * per-step than `ref` (each call snapshots) but immune to layout-change
   * coordinate drift.
   *
   * Applies to: find, press, fill. When `testID` is set on these actions,
   * the step ignores `text`/`ref` and resolves via snapshot first.
   */
  testID?: string;
  tap?: boolean;
  direction?: 'up' | 'down' | 'left' | 'right';
  ms?: number;
  optional?: boolean;
  /**
   * Per-step timeout override in milliseconds. Default 15000ms (batch-wide
   * STEP_TIMEOUT). Use to give slow steps (large snapshots, animation-gated
   * waits) more headroom or cap fast probes.
   */
  timeoutMs?: number;
}

export interface BatchArgs {
  steps: BatchStep[];
  delayMs?: number;
  screenshotOn?: 'none' | 'failure' | 'end' | 'each';
  /**
   * Phase 125: when true, a failed non-optional step is recorded but the
   * batch continues to subsequent steps. Default false preserves the
   * fail-fast behavior. Use for diagnostic batches where partial results
   * are more valuable than the first-failure abort.
   */
  continueOnError?: boolean;
  // GH #321 (quick win #4): shape of the batch's final UI payload.
  //   salient (default): compact list of only actionable a11y nodes
  //     (Button/TextField/Switch/etc) -- live-loop default, far fewer tokens.
  //   full: the complete node list (legacy shape) -- when every node is needed.
  //   none: skip the implicit trailing snapshot (~1,450 ms saved) for
  //     action-only batches that verify via expect_*/cdp_store_state.
  // An explicit snapshot step or screenshotOn=end still populates the payload;
  // this only governs the IMPLICIT trailing snapshot and its shape.
  finalSnapshot?: 'salient' | 'full' | 'none';
}

// GH #321: a11y node types that represent something the agent can act on. Used
// to compact the batch's final payload to just the actionable surface.
const INTERACTIVE_A11Y_TYPES = new Set<string>([
  'Button', 'TextField', 'SecureTextField', 'TextView', 'Switch', 'Slider',
  'Link', 'Cell', 'MenuItem', 'Tab', 'Stepper', 'SegmentedControl',
  'SearchField', 'Toggle', 'CheckBox', 'RadioButton',
]);

/**
 * GH #321: reduce a device_snapshot payload to only its actionable nodes, each
 * compacted to { ref, type, label, identifier, hittable? }. Non-node payloads
 * (e.g. a screenshot result) and falsy input pass through unchanged. Exported
 * for unit tests; pure.
 */
export function salientizeSnapshotData(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;
  const d = data as { nodes?: Array<Record<string, unknown>> };
  if (!Array.isArray(d.nodes)) return data; // not a node snapshot — leave as-is
  const nodes: Array<Record<string, unknown>> = [];
  for (const n of d.nodes) {
    const type = typeof n.type === 'string' ? n.type : '';
    const identifier = typeof n.identifier === 'string' && n.identifier ? n.identifier : '';
    // Fail-safe: keep a node if it's an interactive type OR carries a testID.
    // A custom Pressable can surface as a11y type "Other" — dropping it on type
    // alone would strand the agent ("nothing to tap here") on a real control.
    if (!INTERACTIVE_A11Y_TYPES.has(type) && !identifier) continue;
    const entry: Record<string, unknown> = {};
    if (n.ref) entry.ref = n.ref;
    if (type) entry.type = type;
    if (typeof n.label === 'string' && n.label) entry.label = n.label;
    if (identifier) entry.identifier = identifier;
    if (n.hittable === false) entry.hittable = false; // surface dead controls
    nodes.push(entry);
  }
  return { nodes, salient: true, fullNodeCount: d.nodes.length };
}

/**
 * Phase 125: snapshot-based testID resolution — single source of truth for
 * testID-keyed batch steps. Each call snapshots, returning the fresh ref so
 * layout-change drift can't invalidate refs across step boundaries.
 *
 * Phase 128 (post-review #3): supports BOTH snapshot shapes.
 *   - Daemon/CLI shape: `{data: {nodes: [{ref, identifier, ...}]}}` (flat)
 *   - iOS fast-runner shape: `{data: {tree: {ref?, identifier?, children?: [...]}}}`
 *     (nested XCUIElement dict). agent-device-wrapper.ts:483 documents this.
 *     Fast-runner snapshots populate AFTER the first daemon snapshot warms
 *     up the ref-map, so subsequent iOS testID lookups hit the tree shape
 *     and used to silently fail.
 *
 * Exported for unit tests; pure once a snapshot envelope is provided.
 */
export function findRefByTestID(snapshotEnvelope: string, testID: string): string | null {
  try {
    const env = JSON.parse(snapshotEnvelope) as {
      ok?: boolean;
      data?: {
        nodes?: Array<{ ref?: string; identifier?: string }>;
        tree?: TreeNode;
      };
    };
    if (env.ok === false) return null;
    // Daemon/CLI shape — flat array.
    const nodes = env.data?.nodes;
    if (Array.isArray(nodes)) {
      const hit = nodes.find((n) => n.identifier === testID);
      return hit?.ref ?? null;
    }
    // Fast-runner shape — nested tree.
    if (env.data?.tree) {
      return findRefInTree(env.data.tree, testID);
    }
    return null;
  } catch {
    return null;
  }
}

interface TreeNode {
  ref?: string;
  identifier?: string;
  label?: string;
  children?: TreeNode[];
}

function findRefInTree(node: TreeNode, testID: string): string | null {
  if (node.identifier === testID && typeof node.ref === 'string') return node.ref;
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const hit = findRefInTree(child, testID);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Phase 128 (post-review #5/#6): peek the agent-device envelope's ok flag
 * BEFORE computing testID resolution / visibility. Distinguishes
 * "snapshot infrastructure failed" from "element not present" so callers
 * can route to SNAPSHOT_FAILED vs TESTID_NOT_FOUND with accurate hints.
 */
export function snapshotEnvelopeFailed(envelope: string | null | undefined): boolean {
  if (!envelope) return true;
  try {
    const env = JSON.parse(envelope) as { ok?: boolean };
    return env.ok === false;
  } catch {
    return true;
  }
}

async function resolveTestIDViaSnapshot(testID: string): Promise<{ ref: string | null; envelope: string | null; snapshotFailed: boolean }> {
  const result = await runNative(['snapshot', '-i']);
  const envelope = result.content?.[0]?.text ?? null;
  const snapshotFailed = snapshotEnvelopeFailed(envelope);
  if (snapshotFailed) return { ref: null, envelope, snapshotFailed: true };
  return { ref: findRefByTestID(envelope!, testID), envelope, snapshotFailed: false };
}

interface StepResult {
  step: number;
  action: string;
  success: boolean;
  durationMs: number;
  error?: string;
  data?: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function executeStep(step: BatchStep): Promise<ToolResult> {
  switch (step.action) {
    case 'find': {
      // Phase 125: testID-keyed find re-resolves via snapshot per call.
      // Phase 128 (post-review #5/#6): distinguish snapshot infrastructure
      // failure from "testID not present" so the user gets the right hint.
      if (step.testID) {
        const { ref, envelope, snapshotFailed } = await resolveTestIDViaSnapshot(step.testID);
        if (snapshotFailed) {
          return failResult(
            `Snapshot failed while resolving testID "${step.testID}" — agent-device unreachable, daemon crashed, or snapshot timed out`,
            'SNAPSHOT_FAILED',
            {
              testID: step.testID,
              envelope: envelope?.slice(0, 500),
              hint: 'Run cdp_status / device_list to verify the device + agent-device session are healthy. This is NOT a "testID missing" condition.',
            },
          );
        }
        if (!ref) {
          return failResult(
            `testID "${step.testID}" not found in current UI snapshot`,
            'TESTID_NOT_FOUND',
            {
              testID: step.testID,
              hint: 'Element may not be on-screen yet (animation? modal not mounted?). Re-snapshot after a short wait, or use device_snapshot directly to inspect the tree.',
            },
          );
        }
        if (step.tap) return runNative(['press', `@${ref}`]);
        return okResult({ resolved: ref, testID: step.testID, snapshotEnvelopePreviewBytes: envelope?.length ?? 0 });
      }
      if (!step.text) return failResult('find requires text or testID');
      const findResult = await fetchFindCandidates(step.text, false);
      if (!findResult.ok) {
        return failResult(`find: snapshot unavailable for "${step.text}"`, { code: 'SNAPSHOT_UNAVAILABLE', query: step.text });
      }
      if (findResult.candidates.length === 0) {
        return failResult(`No element matches "${step.text}"`, { code: 'NOT_FOUND', query: step.text });
      }
      if (step.tap) return pressCandidate(findResult.candidates[0], 'click');
      return okResult({ ref: findResult.candidates[0].ref, label: findResult.candidates[0].label, testID: findResult.candidates[0].testID });
    }
    case 'press': {
      if (step.testID) {
        const { ref, envelope, snapshotFailed } = await resolveTestIDViaSnapshot(step.testID);
        if (snapshotFailed) {
          return failResult(
            `Snapshot failed while resolving testID "${step.testID}" for press — agent-device unreachable`,
            'SNAPSHOT_FAILED',
            { testID: step.testID, envelope: envelope?.slice(0, 500) },
          );
        }
        if (!ref) {
          return failResult(`testID "${step.testID}" not found in current UI snapshot`, 'TESTID_NOT_FOUND', {
            testID: step.testID,
          });
        }
        return runNative(['press', `@${ref}`]);
      }
      if (!step.ref) return failResult('press requires ref or testID');
      const ref = step.ref.startsWith('@') ? step.ref : `@${step.ref}`;
      return runNative(['press', ref]);
    }
    case 'fill': {
      if (!step.text) return failResult('fill requires text');
      if (step.testID) {
        const { ref, envelope, snapshotFailed } = await resolveTestIDViaSnapshot(step.testID);
        if (snapshotFailed) {
          return failResult(
            `Snapshot failed while resolving testID "${step.testID}" for fill — agent-device unreachable`,
            'SNAPSHOT_FAILED',
            { testID: step.testID, envelope: envelope?.slice(0, 500) },
          );
        }
        if (!ref) {
          return failResult(`testID "${step.testID}" not found in current UI snapshot`, 'TESTID_NOT_FOUND', {
            testID: step.testID,
          });
        }
        return runNative(['fill', `@${ref}`, step.text]);
      }
      if (!step.ref) return failResult('fill requires ref or testID. Use a find+tap step first to focus the field, or pass testID for fresh resolution.');
      const ref = step.ref.startsWith('@') ? step.ref : `@${step.ref}`;
      return runNative(['fill', ref, step.text]);
    }
    case 'swipe': {
      if (!step.direction) return failResult('swipe requires direction');
      return runNative(buildDirectionalSwipeCliArgs(step.direction, step.ms));
    }
    case 'scroll': {
      if (!step.direction) return failResult('scroll requires direction');
      // Coordinate form — the raw ['scroll', direction] shape throws in the
      // iOS/Android arg builders and aborted the whole batch.
      return runNative(buildDirectionalScrollCliArgs(step.direction));
    }
    case 'back': {
      return runNative(['back']);
    }
    case 'hideKeyboard': {
      return runNative(['keyboard', 'dismiss']);
    }
    case 'snapshot': {
      return runNative(['snapshot', '-i']);
    }
    case 'screenshot': {
      // B121: route through the resize wrapper (B120 default maxWidth=800)
      // so batch-step screenshots don't pay native-resolution context cost.
      return captureAndResizeScreenshot({});
    }
    case 'wait': {
      await sleep(step.ms ?? 500);
      return okResult({ waited: step.ms ?? 500 });
    }
    default:
      return failResult(`Unknown action: ${step.action}`);
  }
}

function isOk(result: ToolResult): boolean {
  try {
    const parsed = JSON.parse(result.content[0].text) as { ok: boolean };
    return parsed.ok;
  } catch {
    return !result.isError;
  }
}

function extractData(result: ToolResult): unknown {
  try {
    const parsed = JSON.parse(result.content[0].text) as { data?: unknown };
    return parsed.data;
  } catch {
    return null;
  }
}

export function createDeviceBatchHandler(): (args: BatchArgs) => Promise<ToolResult> {
  return withSession(async (args) => {
    const { steps, delayMs = 300, screenshotOn = 'failure', continueOnError = false, finalSnapshot: finalSnapshotMode = 'salient' } = args;

    if (!steps || steps.length === 0) {
      return failResult('steps array is required and must not be empty');
    }

    const batchStart = Date.now();
    const results: StepResult[] = [];
    let finalSnapshot: unknown = null;
    let failedStep: StepResult | null = null;
    const failureRecords: StepResult[] = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepStart = Date.now();

      // Phase 125: per-step timeout override; default 15s.
      // Note: timed-out steps continue executing in background (agent-device CLI
      // calls cannot be cancelled). The timeout prevents the batch from hanging,
      // but the underlying action may complete after the timeout fires.
      const stepTimeout = step.timeoutMs ?? 15_000;
      let stepTimer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        executeStep(step),
        new Promise<ToolResult>((resolve) => {
          stepTimer = setTimeout(() => resolve(failResult(`Step ${i + 1} timed out after ${stepTimeout}ms`)), stepTimeout);
        }),
      ]);
      if (stepTimer) clearTimeout(stepTimer);
      const success = isOk(result);
      const durationMs = Date.now() - stepStart;

      const stepResult: StepResult = {
        step: i + 1,
        action: step.action,
        success,
        durationMs,
      };

      if (!success) {
        try {
          const parsed = JSON.parse(result.content[0].text) as { error?: string };
          stepResult.error = parsed.error;
        } catch { /* ignore */ }
      }

      if (step.action === 'snapshot' && success) {
        finalSnapshot = extractData(result);
      }

      results.push(stepResult);

      if (!success && !step.optional) {
        // Capture failure screenshot regardless of continueOnError so the
        // diagnostic trail isn't lost.
        if (screenshotOn === 'failure' || screenshotOn === 'each') {
          try {
            // B121: route through resize wrapper.
            const ssResult = await captureAndResizeScreenshot({});
            if (isOk(ssResult)) {
              stepResult.data = extractData(ssResult);
            }
          } catch { /* best effort */ }
        }

        if (continueOnError) {
          // Phase 125: record the failure and proceed. failedStep stays null
          // so the batch returns success-shape with failure_count populated.
          failureRecords.push(stepResult);
        } else {
          failedStep = stepResult;
          break;
        }
      }

      if (screenshotOn === 'each' && step.action !== 'screenshot') {
        // B121: route through resize wrapper so per-step captures pay budget.
        try { await captureAndResizeScreenshot({}); } catch { /* ignore */ }
      }

      if (i < steps.length - 1 && step.action !== 'wait' && delayMs > 0) {
        await sleep(delayMs);
      }
    }

    if (!failedStep && screenshotOn === 'end') {
      try {
        // B121: route through resize wrapper.
        const ssResult = await captureAndResizeScreenshot({});
        if (isOk(ssResult)) {
          finalSnapshot = extractData(ssResult);
        }
      } catch { /* best effort */ }
    }

    // GH #321: skip the implicit trailing snapshot when the caller doesn't want
    // it (action-only batches that verify via expect_*/cdp_store_state) — saves a
    // full ~1,450 ms snapshot round-trip.
    if (!finalSnapshot && !failedStep && finalSnapshotMode !== 'none') {
      try {
        const snapResult = await runNative(['snapshot', '-i']);
        if (isOk(snapResult)) {
          finalSnapshot = extractData(snapResult);
        }
      } catch { /* best effort */ }
    }

    // GH #321: by default return only the actionable surface (compact salient
    // digest). 'full' keeps the legacy complete node list. A node-shaped payload
    // is required; a screenshot 'end' payload passes through untouched.
    if (finalSnapshot && finalSnapshotMode === 'salient') {
      finalSnapshot = salientizeSnapshotData(finalSnapshot);
    }

    const totalDuration = Date.now() - batchStart;

    if (failedStep) {
      return failResult(
        `Step ${failedStep.step} failed: ${failedStep.action}${failedStep.error ? ' — ' + failedStep.error : ''}`,
        {
          steps_completed: failedStep.step - 1,
          total_steps: steps.length,
          failed_step: failedStep,
          duration_ms: totalDuration,
          results,
        },
      );
    }

    // Phase 125: under continueOnError, surface partial-failure shape so the
    // caller knows N steps failed but the batch finished. Without continueOnError
    // a non-optional failure already aborted via failedStep above, so we'd never
    // reach here with failureRecords populated under that branch.
    return okResult({
      success: failureRecords.length === 0,
      steps_completed: steps.length,
      total_steps: steps.length,
      failure_count: failureRecords.length,
      failures: failureRecords.length ? failureRecords : undefined,
      duration_ms: totalDuration,
      results,
      final_snapshot: finalSnapshot,
    });
  });
}

// D1206 Tier 2 Sprint D / Phase 129 — Self-repair pure helpers.
//
// L3→L2 self-repair flow when /run-action fails with SELECTOR_NOT_FOUND:
// the LLM (or this engine) introspects the live UI via L2 tools, finds
// the new selector, patches the YAML in place, and retries. This file
// holds the PURE helpers — fuzzy matching, body parsing, surgical
// replacement. The MCP tool that orchestrates them lives in
// tools/repair-action.ts.

import {
  type ReusableAction,
  type RepairRecord,
  appendRepairRecord,
  shouldDemoteAfterRepair,
} from './reusable-action.js';
import { withBody, withMetadata } from './action-store.js';
import { isSafeMaestroScalar } from './maestro-validator.js';

// ─────────────────────────────────────────────────────────────────────────────
// Levenshtein-based fuzzy matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Standard Levenshtein edit distance between two strings. O(n*m).
 * Pure function; exported for unit tests.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Two-row dynamic programming for O(min(n,m)) memory.
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Similarity score in [0, 1] derived from Levenshtein distance.
 * 1.0 means identical; 0 means maximally different.
 */
export function similarityScore(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Default similarity threshold for accepting a repair candidate.
 * Below this, the engine refuses to patch — the candidate is too
 * different to be confident this isn't a different element entirely.
 */
export const DEFAULT_REPAIR_THRESHOLD = 0.6;

/**
 * Find the best fuzzy match for `failed` in `candidates`. Returns null
 * if no candidate scores at or above `threshold`. Ties broken by
 * candidate order (first match wins).
 */
export function findBestMatch(
  failed: string,
  candidates: string[],
  threshold: number = DEFAULT_REPAIR_THRESHOLD,
): { match: string; score: number } | null {
  let best: { match: string; score: number } | null = null;
  for (const candidate of candidates) {
    const score = similarityScore(failed, candidate);
    if (score >= threshold && (!best || score > best.score)) {
      best = { match: candidate, score };
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot-tree → testID list
// ─────────────────────────────────────────────────────────────────────────────

interface SnapshotNodeFlat {
  identifier?: string;
  ref?: string;
}
interface SnapshotNodeTree {
  identifier?: string;
  ref?: string;
  children?: SnapshotNodeTree[];
}

/**
 * Extract every non-empty testID/identifier from a device_snapshot
 * envelope, regardless of shape (daemon `nodes` flat list OR fast-runner
 * `tree` nested). Pure function — safe on malformed input (returns []).
 */
export function extractAllTestIDs(snapshotEnvelope: string): string[] {
  try {
    const env = JSON.parse(snapshotEnvelope) as {
      ok?: boolean;
      data?: { nodes?: SnapshotNodeFlat[]; tree?: SnapshotNodeTree };
    };
    if (env.ok === false) return [];
    const out = new Set<string>();
    const nodes = env.data?.nodes;
    if (Array.isArray(nodes)) {
      for (const n of nodes) {
        if (typeof n.identifier === 'string' && n.identifier.length > 0) out.add(n.identifier);
      }
      return Array.from(out);
    }
    if (env.data?.tree) {
      walkTree(env.data.tree, out);
      return Array.from(out);
    }
    return [];
  } catch {
    return [];
  }
}

function walkTree(node: SnapshotNodeTree, acc: Set<string>): void {
  if (typeof node.identifier === 'string' && node.identifier.length > 0) acc.add(node.identifier);
  if (Array.isArray(node.children)) {
    for (const child of node.children) walkTree(child, acc);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Maestro YAML body — find + replace selectors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Surgical replacement of a Maestro `id: "X"` selector inside a YAML
 * body. Preserves quoting style (single, double, unquoted) and
 * indentation. Returns the new body and the count of replacements.
 *
 * Why surgical: a naive global replace could hit places the agent
 * doesn't intend (a value embedded in `inputText: ${X}` literal, an
 * unrelated comment). This function targets ONLY lines whose stripped
 * content matches `id: "<oldId>"` / `id: '<oldId>'` / `id: <oldId>`.
 *
 * Pure function — exported for unit tests.
 */
export function replaceIdSelector(body: string, oldId: string, newId: string): { body: string; replacements: number } {
  // Phase 134.1 (deepsec HIGH: repair writes unescaped testIDs).
  // testIDs come from the running app's snapshot, attacker-controlled in
  // the prompt-injection threat model. Reject any newId that could break
  // out of the YAML scalar context (newlines, --- separators, control
  // chars, unicode line breaks). replacements: 0 makes the caller treat
  // it as "no match found" — repair refuses gracefully.
  if (!isSafeMaestroScalar(newId)) {
    return { body, replacements: 0 };
  }
  const lines = body.split('\n');
  const out: string[] = [];
  let replacements = 0;
  // Match the line-trimmed `id: <quoted-or-bare><oldId>`, preserving leading
  // whitespace, quote style, and any trailing `# comment`. Three explicit
  // shapes (double / single / bare) keep this in lockstep with
  // extractIdSelectors and the maestro-error-parser matched-quote grammar:
  // a double-quoted value may contain `'` and vice-versa.
  const escapedOld = oldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const dq = new RegExp(`^(\\s*)id:\\s*"${escapedOld}"(\\s*(?:#.*)?)$`);
  const sq = new RegExp(`^(\\s*)id:\\s*'${escapedOld}'(\\s*(?:#.*)?)$`);
  const bare = new RegExp(`^(\\s*)id:\\s*${escapedOld}(\\s*(?:#.*)?)$`);
  for (const line of lines) {
    let m = line.match(dq);
    if (m) { out.push(`${m[1]}id: "${newId}"${m[2]}`); replacements++; continue; }
    m = line.match(sq);
    if (m) { out.push(`${m[1]}id: '${newId}'${m[2]}`); replacements++; continue; }
    m = line.match(bare);
    if (m) { out.push(`${m[1]}id: ${newId}${m[2]}`); replacements++; continue; }
    out.push(line);
  }
  return { body: out.join('\n'), replacements };
}

/**
 * Extract every `id: "X"` selector from a Maestro YAML body, in order
 * of appearance. Useful when we don't yet know which selector failed —
 * the engine can match each against current testIDs and find candidates
 * for repair.
 *
 * Pure function — exported for unit tests.
 */
export function extractIdSelectors(body: string): string[] {
  const out: string[] = [];
  const lines = body.split('\n');
  // Mirror the maestro-error-parser matched-quote grammar (PR #115) so the
  // failure parser and this extractor agree on what a testID is. Previously
  // the char class `[^"'\s]` rejected any testID containing a quote (e.g.
  // `user's-task`), so attemptRepair's gate short-circuited to
  // 'no-stale-selector' and auto-repair silently no-op'd for ids the parser
  // had correctly extracted. Three explicit shapes:
  //   id: "value"   — value may contain '
  //   id: 'value'   — value may contain "
  //   id: value     — bare; strip a trailing ` # comment` (Issue #102 A2)
  const dq = /^\s*id:\s*"([^"\n]*)"\s*(?:#.*)?$/;
  const sq = /^\s*id:\s*'([^'\n]*)'\s*(?:#.*)?$/;
  const bare = /^\s*id:\s*([^"'#\s][^#\n]*?)\s*(?:#.*)?$/;
  for (const line of lines) {
    const m = line.match(dq) ?? line.match(sq);
    if (m) { out.push(m[1]); continue; }
    const b = line.match(bare);
    if (b) { out.push(b[1].trimEnd()); }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// High-level repair attempt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The orchestrator (tools/repair-action.ts) checks budget + external-edit
 * guardrails BEFORE calling attemptRepair, so those failure modes don't
 * appear in this union — they're surfaced as failResult by the caller
 * directly.
 */
export type RepairAttemptResult =
  | { kind: 'patched'; oldSelector: string; newSelector: string; score: number; oldBody: string; newBody: string; replacements: number }
  | { kind: 'no-match'; failedSelector: string; bestScore: number | null; reason: string }
  | { kind: 'no-stale-selector'; reason: string };

/**
 * Attempt to repair a single stale selector. Pure function over
 * (action, failedSelector, candidates) — no I/O. The MCP tool wraps
 * this with disk reads + writes.
 *
 * Algorithm:
 *   1. Verify failedSelector appears in the action body. If not,
 *      kind='no-stale-selector' (caller likely passed a bad hint).
 *   2. Find best fuzzy match for failedSelector in candidates.
 *   3. If best score < threshold, kind='no-match' with the best candidate
 *      surfaced for the caller's debug.
 *   4. Otherwise, replace and return the patched body.
 */
export function attemptRepair(
  action: ReusableAction,
  failedSelector: string,
  candidates: string[],
  threshold: number = DEFAULT_REPAIR_THRESHOLD,
): RepairAttemptResult {
  const inBody = extractIdSelectors(action.body).includes(failedSelector);
  if (!inBody) {
    return {
      kind: 'no-stale-selector',
      reason: `failedSelector "${failedSelector}" was not found in the action body. The selector hint may be wrong, or the body has already been patched.`,
    };
  }
  const filtered = candidates.filter((c) => c !== failedSelector);
  const best = findBestMatch(failedSelector, filtered, threshold);
  if (!best) {
    // Compute the best across-threshold score so the caller can see how
    // close they got.
    const naive = filtered
      .map((c) => similarityScore(failedSelector, c))
      .reduce((m, s) => Math.max(m, s), 0);
    return {
      kind: 'no-match',
      failedSelector,
      bestScore: filtered.length ? naive : null,
      reason: filtered.length
        ? `No candidate scored at or above ${threshold}. Best score: ${naive.toFixed(2)}`
        : `No candidate testIDs available — current snapshot has none, or extraction failed.`,
    };
  }
  const { body: newBody, replacements } = replaceIdSelector(action.body, failedSelector, best.match);
  return {
    kind: 'patched',
    oldSelector: failedSelector,
    newSelector: best.match,
    score: best.score,
    oldBody: action.body,
    newBody,
    replacements,
  };
}

/**
 * Apply a successful RepairAttemptResult to the action: update body,
 * append RepairRecord, demote status if previously active. Returns the
 * new in-memory ReusableAction. Caller persists with saveAction().
 *
 * Pure once `now` is supplied.
 */
export function applyRepair(
  action: ReusableAction,
  result: Extract<RepairAttemptResult, { kind: 'patched' }>,
  now: () => Date = () => new Date(),
  agentReasoning?: string,
): ReusableAction {
  const repaired = withBody(action, result.newBody);
  // Demote status: active → experimental on repair (D1206).
  const newMetadata = shouldDemoteAfterRepair(action.metadata)
    ? { ...action.metadata, status: 'experimental' as const }
    : action.metadata;
  const withNewMeta = withMetadata(repaired, newMetadata);
  const repairRecord: RepairRecord = {
    timestamp: now().toISOString(),
    failureCode: 'SELECTOR_NOT_FOUND',
    diff: {
      selector: { from: result.oldSelector, to: result.newSelector },
    },
    durationMs: 0, // caller fills in if it tracked the repair duration
    agentReasoning,
  };
  return { ...withNewMeta, state: appendRepairRecord(action.state, repairRecord) };
}

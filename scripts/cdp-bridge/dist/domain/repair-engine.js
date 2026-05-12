// D1206 Tier 2 Sprint D / Phase 129 — Self-repair pure helpers.
//
// L3→L2 self-repair flow when /run-action fails with SELECTOR_NOT_FOUND:
// the LLM (or this engine) introspects the live UI via L2 tools, finds
// the new selector, patches the YAML in place, and retries. This file
// holds the PURE helpers — fuzzy matching, body parsing, surgical
// replacement. The MCP tool that orchestrates them lives in
// tools/repair-action.ts.
import { appendRepairRecord, shouldDemoteAfterRepair, } from './reusable-action.js';
import { withBody, withMetadata } from './action-store.js';
import { isSafeMaestroScalar } from './maestro-validator.js';
// ─────────────────────────────────────────────────────────────────────────────
// Levenshtein-based fuzzy matching
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Standard Levenshtein edit distance between two strings. O(n*m).
 * Pure function; exported for unit tests.
 */
export function levenshtein(a, b) {
    if (a === b)
        return 0;
    if (a.length === 0)
        return b.length;
    if (b.length === 0)
        return a.length;
    // Two-row dynamic programming for O(min(n,m)) memory.
    let prev = new Array(b.length + 1);
    let curr = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++)
        prev[j] = j;
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
export function similarityScore(a, b) {
    if (a === b)
        return 1;
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0)
        return 1;
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
export function findBestMatch(failed, candidates, threshold = DEFAULT_REPAIR_THRESHOLD) {
    let best = null;
    for (const candidate of candidates) {
        const score = similarityScore(failed, candidate);
        if (score >= threshold && (!best || score > best.score)) {
            best = { match: candidate, score };
        }
    }
    return best;
}
/**
 * Extract every non-empty testID/identifier from a device_snapshot
 * envelope, regardless of shape (daemon `nodes` flat list OR fast-runner
 * `tree` nested). Pure function — safe on malformed input (returns []).
 */
export function extractAllTestIDs(snapshotEnvelope) {
    try {
        const env = JSON.parse(snapshotEnvelope);
        if (env.ok === false)
            return [];
        const out = new Set();
        const nodes = env.data?.nodes;
        if (Array.isArray(nodes)) {
            for (const n of nodes) {
                if (typeof n.identifier === 'string' && n.identifier.length > 0)
                    out.add(n.identifier);
            }
            return Array.from(out);
        }
        if (env.data?.tree) {
            walkTree(env.data.tree, out);
            return Array.from(out);
        }
        return [];
    }
    catch {
        return [];
    }
}
function walkTree(node, acc) {
    if (typeof node.identifier === 'string' && node.identifier.length > 0)
        acc.add(node.identifier);
    if (Array.isArray(node.children)) {
        for (const child of node.children)
            walkTree(child, acc);
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
export function replaceIdSelector(body, oldId, newId) {
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
    const out = [];
    let replacements = 0;
    // Match the line-trimmed `id: <quoted-or-bare><oldId><quoted-or-bare>`.
    // Capture leading whitespace + quote style so we can preserve them.
    // Allowed quotes: `"X"`, `'X'`, or bare `X` if it has no spaces.
    const escapedOld = oldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^(\\s*)id:\\s*("?)${escapedOld}("?)\\s*$`);
    const reSingle = new RegExp(`^(\\s*)id:\\s*(')${escapedOld}(')\\s*$`);
    for (const line of lines) {
        const m = line.match(re) ?? line.match(reSingle);
        if (m) {
            const indent = m[1];
            const quoteOpen = m[2] ?? '';
            const quoteClose = m[3] ?? '';
            out.push(`${indent}id: ${quoteOpen}${newId}${quoteClose}`);
            replacements++;
        }
        else {
            out.push(line);
        }
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
export function extractIdSelectors(body) {
    const out = [];
    const lines = body.split('\n');
    // Issue #102 A2: previous regex `[^"'\\n]*?` greedily included
    // trailing inline comments — `id: foo-bar  # human note` captured
    // `foo-bar  # human note` as the testID. Hand-authored YAML
    // sometimes has these comments; the bug fails safely (no fuzzy
    // match) but produces a UX issue. Fix: strip trailing
    // `\s+#.*` from the captured group before pushing. Also tighten
    // the bare-form regex to reject `#` directly so quoted forms are
    // unaffected.
    const re = /^\s*id:\s*"?'?([^"'\s][^"'\n]*?)"?'?\s*$/;
    for (const line of lines) {
        const m = line.match(re);
        if (m) {
            // Trim any trailing `<space>#<rest-of-line>` that the lazy
            // capture could not exclude.
            const cleaned = m[1].replace(/\s+#.*$/, '');
            out.push(cleaned);
        }
    }
    return out;
}
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
export function attemptRepair(action, failedSelector, candidates, threshold = DEFAULT_REPAIR_THRESHOLD) {
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
export function applyRepair(action, result, now = () => new Date(), agentReasoning) {
    const repaired = withBody(action, result.newBody);
    // Demote status: active → experimental on repair (D1206).
    const newMetadata = shouldDemoteAfterRepair(action.metadata)
        ? { ...action.metadata, status: 'experimental' }
        : action.metadata;
    const withNewMeta = withMetadata(repaired, newMetadata);
    const repairRecord = {
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

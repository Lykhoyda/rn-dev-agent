// D1206 Tier 2 Sprint C / Phase 127 — ReusableAction domain entity.
//
// Single source of truth for L3 reusable actions: the immutable contract
// (M7 metadata header in the YAML), the mutable runtime state (sidecar
// JSON), and the lifecycle transitions between them.
//
// Storage layout (per D1208 single-folder doctrine, supersedes D1207):
//   <project>/.rn-agent/actions/<id>.yaml          — the YAML body + M7 header
//   <project>/.rn-agent/state/<id>.state.json      — sidecar (this entity's
//                                                     ActionRuntimeState)
//
// This file is the ONLY place that defines the schema. Emitters
// (test-recorder-generators, maestro-generate), parsers (learned-actions),
// and runtime tools (run-action, future self-repair) all import from here.
// Schema drift becomes a compile error.
// ─────────────────────────────────────────────────────────────────────────────
// Bounded constants (single source for repair budgets, history limits)
// ─────────────────────────────────────────────────────────────────────────────
export const REPAIR_BUDGET = {
    /** Max successful self-repairs allowed in a rolling 24h window. */
    ATTEMPTS_PER_24H: 3,
    /** Max repair attempts per run before escalating to user. */
    ATTEMPTS_PER_RUN: 1,
};
export const HISTORY_LIMITS = {
    /** Cap runHistory at this many records; oldest dropped on append. */
    RUN_HISTORY_MAX: 50,
    /** Cap repairHistory at this many records; oldest dropped on append. */
    REPAIR_HISTORY_MAX: 25,
};
// ─────────────────────────────────────────────────────────────────────────────
// Pure constructors + transitions
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Build an empty runtime state for a brand-new action. Caller passes the
 * file's mtime so subsequent edits-vs-self-repair detection works.
 */
export function freshRuntimeState(now = () => new Date(), mtimeMs = 0) {
    const ts = now().toISOString();
    return {
        schemaVersion: 1,
        revision: 1,
        updatedAt: ts,
        lastSeenMtimeMs: mtimeMs,
        runHistory: [],
        repairHistory: [],
        stats: {
            totalRuns: 0,
            successCount: 0,
            failureCount: 0,
            avgDurationMs: 0,
        },
    };
}
/**
 * Append a RunRecord and recompute stats. Bounded by HISTORY_LIMITS.
 * Pure function — caller persists the returned state.
 */
export function appendRunRecord(state, record) {
    const newHistory = [...state.runHistory, record];
    while (newHistory.length > HISTORY_LIMITS.RUN_HISTORY_MAX)
        newHistory.shift();
    const totalRuns = state.stats.totalRuns + 1;
    const successCount = state.stats.successCount + (record.status === 'pass' ? 1 : 0);
    const failureCount = state.stats.failureCount + (record.status === 'fail' ? 1 : 0);
    // Recompute avg over successful records only.
    const successDurations = newHistory.filter((r) => r.status === 'pass').map((r) => r.durationMs);
    const avgDurationMs = successDurations.length
        ? Math.round(successDurations.reduce((s, n) => s + n, 0) / successDurations.length)
        : state.stats.avgDurationMs;
    return {
        ...state,
        updatedAt: record.timestamp,
        runHistory: newHistory,
        stats: {
            totalRuns,
            successCount,
            failureCount,
            avgDurationMs,
            lastSuccessAt: record.status === 'pass' ? record.timestamp : state.stats.lastSuccessAt,
            lastFailureAt: record.status === 'fail' ? record.timestamp : state.stats.lastFailureAt,
        },
    };
}
/**
 * Append a RepairRecord, bump revision. Bounded by HISTORY_LIMITS.
 * Caller is responsible for actually patching the YAML body separately
 * — this only updates the runtime state.
 */
export function appendRepairRecord(state, record) {
    const newHistory = [...state.repairHistory, record];
    while (newHistory.length > HISTORY_LIMITS.REPAIR_HISTORY_MAX)
        newHistory.shift();
    return {
        ...state,
        updatedAt: record.timestamp,
        revision: state.revision + 1,
        repairHistory: newHistory,
    };
}
/**
 * Check whether a self-repair attempt is within the rolling-24h budget.
 * Pure function — `now` is injectable for tests.
 */
export function recentRepairCount(state, now = () => new Date()) {
    const cutoff = now().getTime() - 24 * 60 * 60 * 1000;
    return state.repairHistory.filter((r) => new Date(r.timestamp).getTime() >= cutoff).length;
}
export function repairBudgetAvailable(state, now = () => new Date()) {
    return recentRepairCount(state, now) < REPAIR_BUDGET.ATTEMPTS_PER_24H;
}
/**
 * Promote `experimental → active` after a clean replay.
 * Used by /run-action when an experimental flow passes; also used after
 * a self-repair's verification replay succeeds.
 */
export function shouldAutoPromoteToActive(metadata, lastRun) {
    return metadata.status === 'experimental' && lastRun?.status === 'pass';
}
/**
 * Demote `active → experimental` after a self-repair patches the body.
 * Forces a re-validation pass before treating the flow as production-quality
 * again.
 */
export function shouldDemoteAfterRepair(metadata) {
    return metadata.status === 'active';
}
// ─────────────────────────────────────────────────────────────────────────────
// M7 header parsing/serialization
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Parse the M7 metadata block from a YAML file's header — the comment
 * lines above the body that look like `# key: value`. Robust to extra
 * whitespace and missing fields. Returns null if no `id` or `intent` is
 * found (the two required keys).
 *
 * Pure function — pass the file's text. Mirrors the parsing rules in
 * `scripts/learned-actions.mjs` parseFlowMeta() so they stay in sync.
 */
export function parseM7Header(yamlText, fallbackId) {
    const lines = yamlText.split('\n');
    const meta = {};
    let inComment = false;
    for (const line of lines) {
        if (line.startsWith('#')) {
            inComment = true;
            const stripped = line.replace(/^#\s?/, '').trim();
            if (!stripped)
                continue;
            const kv = stripped.match(/^([a-zA-Z][\w-]*)\s*:\s*(.+)$/);
            if (!kv)
                continue;
            const key = kv[1];
            const raw = kv[2].trim();
            if (key === 'tags') {
                meta.tags = raw
                    .replace(/^\[|\]$/g, '')
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean);
            }
            else if (key === 'mutates') {
                meta.mutates = /^true$/i.test(raw);
            }
            else if (key === 'params') {
                meta.params = raw
                    .replace(/^\[|\]$/g, '')
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean);
            }
            else if (key === 'produces') {
                meta.produces = parseProducesMap(raw);
            }
            else if (key === 'expectedRouteSequence') {
                meta.expectedRouteSequence = raw
                    .replace(/^\[|\]$/g, '')
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean);
            }
            else if (key === 'id' ||
                key === 'intent' ||
                key === 'status' ||
                key === 'appId' ||
                key === 'createdAt' ||
                key === 'author') {
                meta[key] = raw;
            }
        }
        else if (inComment && line.trim() === '') {
            // First blank line after a comment block — stop parsing header.
            if (Object.keys(meta).length > 0)
                break;
        }
        else if (inComment) {
            break;
        }
    }
    const id = meta.id ?? fallbackId;
    const intent = meta.intent;
    if (!id || !intent)
        return null;
    const status = meta.status ?? 'experimental';
    return {
        id,
        intent,
        tags: meta.tags,
        mutates: meta.mutates,
        status,
        params: meta.params,
        appId: meta.appId,
        createdAt: meta.createdAt,
        author: meta.author,
        produces: meta.produces,
        expectedRouteSequence: meta.expectedRouteSequence,
    };
}
/**
 * D1209 — parse the inline `produces` map: `{ key: value, key: value }`.
 * Values are typed as boolean (`true`/`false`), number (digits + optional
 * dot + optional sign), or string (everything else, with surrounding
 * single/double quotes stripped). Returns undefined when the input is
 * empty or unparseable so the caller can omit the field rather than
 * carry a half-parsed object. Single-line only; commas + newlines
 * inside values are not supported in v1.
 */
function parseProducesMap(raw) {
    const inner = raw
        .trim()
        .replace(/^\{|\}$/g, '')
        .trim();
    if (!inner)
        return undefined;
    const result = {};
    for (const part of inner.split(',')) {
        const kv = part.match(/^\s*([a-zA-Z_][\w.-]*)\s*:\s*(.+?)\s*$/);
        if (!kv)
            continue;
        const key = kv[1];
        const valueRaw = kv[2].trim();
        if (/^(true|false)$/i.test(valueRaw)) {
            result[key] = /^true$/i.test(valueRaw);
        }
        else if (/^-?\d+(\.\d+)?$/.test(valueRaw)) {
            result[key] = Number(valueRaw);
        }
        else {
            result[key] = valueRaw.replace(/^['"]|['"]$/g, '');
        }
    }
    return Object.keys(result).length ? result : undefined;
}
/**
 * Serialize an M7Metadata object as YAML comment lines. Output is
 * suitable for prepending to a Maestro YAML body. Stable field order.
 */
export function serializeM7Header(metadata) {
    const lines = [];
    const stripNewlines = (s) => String(s).replace(/[\r\n]+/g, ' ');
    lines.push(`# id: ${stripNewlines(metadata.id)}`);
    lines.push(`# intent: ${stripNewlines(metadata.intent)}`);
    if (metadata.tags && metadata.tags.length) {
        lines.push(`# tags: [${metadata.tags.map(stripNewlines).join(', ')}]`);
    }
    if (typeof metadata.mutates === 'boolean') {
        lines.push(`# mutates: ${metadata.mutates}`);
    }
    lines.push(`# status: ${stripNewlines(metadata.status)}`);
    if (metadata.params && metadata.params.length) {
        lines.push(`# params: [${metadata.params.map(stripNewlines).join(', ')}]`);
    }
    if (metadata.appId)
        lines.push(`# appId: ${stripNewlines(metadata.appId)}`);
    if (metadata.createdAt)
        lines.push(`# createdAt: ${stripNewlines(metadata.createdAt)}`);
    if (metadata.author)
        lines.push(`# author: ${stripNewlines(metadata.author)}`);
    if (metadata.produces && Object.keys(metadata.produces).length > 0) {
        const pairs = Object.keys(metadata.produces)
            .sort()
            .map((k) => {
            const v = metadata.produces[k];
            const formatted = typeof v === 'string' ? stripNewlines(v) : String(v);
            return `${k}: ${formatted}`;
        });
        lines.push(`# produces: { ${pairs.join(', ')} }`);
    }
    if (metadata.expectedRouteSequence && metadata.expectedRouteSequence.length) {
        lines.push(`# expectedRouteSequence: [${metadata.expectedRouteSequence.map(stripNewlines).join(', ')}]`);
    }
    return lines.join('\n');
}

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const AGENT_DIR = join(homedir(), '.claude', 'rn-agent');
const TELEMETRY_DIR = join(AGENT_DIR, 'telemetry');
// Thresholds from the design spec
const MIN_OCCURRENCES = 3;
const MIN_SUCCESS_RATE = 0.67;
const STALE_RUN_THRESHOLD = 20;
const STALE_CONFIDENCE_DECAY = 20;
const REMOVE_CONFIDENCE_THRESHOLD = 30;
/**
 * Scan all telemetry JSONL files within the retention window.
 * Returns parsed events sorted by timestamp.
 */
export function scanTelemetry() {
    if (!existsSync(TELEMETRY_DIR))
        return [];
    const events = [];
    try {
        const files = readdirSync(TELEMETRY_DIR)
            .filter(f => f.endsWith('.jsonl'))
            .sort();
        for (const file of files) {
            try {
                const content = readFileSync(join(TELEMETRY_DIR, file), 'utf-8');
                for (const line of content.split('\n')) {
                    if (!line.trim())
                        continue;
                    try {
                        events.push(JSON.parse(line));
                    }
                    catch { /* skip malformed lines */ }
                }
            }
            catch { /* skip unreadable files */ }
        }
    }
    catch {
        return [];
    }
    return events.sort((a, b) => a.ts.localeCompare(b.ts));
}
/**
 * Group failure events by (tool + normalized_error) and compute stats.
 */
export function groupFailures(events) {
    const groups = new Map();
    for (const event of events) {
        if (event.event !== 'tool_call' && event.event !== 'ghost_attempt')
            continue;
        if (!event.tool)
            continue;
        // Only process failures and ghost recoveries
        const isFail = event.result === 'FAIL' || event.result === 'ERROR';
        const isGhostRecovery = event.event === 'ghost_attempt' && event.ghost_outcome === 'recovered';
        if (!isFail && !isGhostRecovery)
            continue;
        const normalized = event.normalized_error ?? event.error ?? 'unknown';
        const key = `${event.tool}::${normalized.slice(0, 100)}`;
        let stats = groups.get(key);
        if (!stats) {
            stats = {
                tool: event.tool,
                normalized_error: normalized,
                family_id: event.family_id,
                total: 0,
                passed: 0,
                failed: 0,
                ghost_recovered: 0,
                first_seen: event.ts,
                last_seen: event.ts,
                runs: new Set(),
            };
            groups.set(key, stats);
        }
        stats.total++;
        stats.last_seen = event.ts;
        stats.runs.add(event.run);
        if (isGhostRecovery) {
            stats.ghost_recovered++;
        }
        else if (event.result === 'FAIL' || event.result === 'ERROR') {
            stats.failed++;
        }
        else {
            stats.passed++;
        }
        if (event.family_id && !stats.family_id) {
            stats.family_id = event.family_id;
        }
    }
    return [...groups.values()];
}
/**
 * Generate candidate heuristics from failure stats.
 * Only generates for patterns with >= MIN_OCCURRENCES and >= MIN_SUCCESS_RATE.
 */
export function generateCandidates(stats, events) {
    const candidates = [];
    let nextId = 1;
    // Find the highest existing candidate ID
    const candidatesDir = join(AGENT_DIR, 'candidates');
    if (existsSync(candidatesDir)) {
        try {
            const existing = readdirSync(candidatesDir).filter(f => f.startsWith('candidate-'));
            for (const f of existing) {
                const match = f.match(/candidate-(\d+)/);
                if (match)
                    nextId = Math.max(nextId, parseInt(match[1], 10) + 1);
            }
        }
        catch { /* best-effort */ }
    }
    // Extract a representative env fingerprint from events
    const envSample = events.find(e => e.env)?.env;
    for (const group of stats) {
        if (group.total < MIN_OCCURRENCES)
            continue;
        const failureTotal = group.failed + group.ghost_recovered;
        const successRate = failureTotal > 0 ? group.ghost_recovered / failureTotal : 0;
        const isAutoPromotable = group.ghost_recovered >= MIN_OCCURRENCES
            && successRate >= MIN_SUCCESS_RATE;
        // For ghost recoveries, generate recovery shortcuts
        if (group.ghost_recovered > 0 && successRate >= MIN_SUCCESS_RATE) {
            candidates.push({
                id: `RS-C${nextId++}`,
                type: 'recovery_shortcut',
                tool: group.tool,
                symptom: group.normalized_error,
                normalized_error: group.normalized_error,
                family_id: group.family_id,
                recovery: `Ghost auto-recovery (${group.family_id ?? 'unknown'})`,
                confidence: Math.round(successRate * 100),
                seen_count: group.total,
                success_count: group.ghost_recovered,
                first_seen: group.first_seen,
                last_seen: group.last_seen,
                env: envSample ? extractEnvFilter(envSample) : undefined,
                auto_promotable: isAutoPromotable,
            });
            continue;
        }
        // For recurring failures without recovery, generate failure patterns
        if (group.failed >= MIN_OCCURRENCES) {
            candidates.push({
                id: `FP-C${nextId++}`,
                type: 'failure_pattern',
                tool: group.tool,
                symptom: group.normalized_error,
                normalized_error: group.normalized_error,
                family_id: group.family_id,
                confidence: Math.round(Math.min(60, 30 + group.runs.size * 10)),
                seen_count: group.total,
                success_count: 0,
                first_seen: group.first_seen,
                last_seen: group.last_seen,
                env: envSample ? extractEnvFilter(envSample) : undefined,
                auto_promotable: false,
            });
        }
    }
    return candidates;
}
function extractEnvFilter(env) {
    const filter = {};
    if (env.platform)
        filter.platform = env.platform;
    if (env.engine)
        filter.engine = env.engine;
    if (env.rn_version) {
        const [major, minor] = env.rn_version.split('.');
        filter.rn_version = `${major}.${minor}`;
    }
    if (env.expo_sdk) {
        filter.expo_sdk = env.expo_sdk.split('.')[0];
    }
    return filter;
}
/**
 * Compute stale decay for existing heuristics.
 * Compares by checking if any telemetry event references the heuristic
 * (via family_id or normalized_error match).
 */
export function computeDecay(heuristics, events) {
    const allRuns = new Set(events.map(e => e.run));
    const totalRuns = allRuns.size;
    // Track which families and tools had activity
    const activeFamilies = new Set();
    const activeTools = new Set();
    for (const event of events) {
        if (event.family_id)
            activeFamilies.add(event.family_id);
        if (event.tool)
            activeTools.add(event.tool);
    }
    const decayed = [];
    const removed = [];
    const currentConfidence = new Map();
    for (const h of heuristics) {
        // A heuristic is "triggered" if any telemetry references its family or tool
        const wasTriggered = activeFamilies.has(h.id) || activeTools.has(h.id);
        if (!wasTriggered && totalRuns >= STALE_RUN_THRESHOLD) {
            const newConfidence = h.confidence - STALE_CONFIDENCE_DECAY;
            if (newConfidence < REMOVE_CONFIDENCE_THRESHOLD) {
                removed.push(h.id);
            }
            else {
                decayed.push(h.id);
                currentConfidence.set(h.id, newConfidence);
            }
        }
    }
    return { decayed, removed, currentConfidence };
}
/**
 * Run the full compaction cycle.
 * Returns a CompactionResult summary.
 */
export function runCompaction() {
    const events = scanTelemetry();
    const stats = groupFailures(events);
    const candidates = generateCandidates(stats, events);
    const autoPromotable = candidates.filter(c => c.auto_promotable);
    const humanReview = candidates.filter(c => !c.auto_promotable);
    // Count telemetry files
    let telemetryFiles = 0;
    if (existsSync(TELEMETRY_DIR)) {
        try {
            telemetryFiles = readdirSync(TELEMETRY_DIR).filter(f => f.endsWith('.jsonl')).length;
        }
        catch { /* best-effort */ }
    }
    return {
        telemetry_files_scanned: telemetryFiles,
        events_processed: events.length,
        failure_groups: stats.length,
        candidates_generated: candidates.length,
        candidates_auto_promoted: autoPromotable.length,
        heuristics_decayed: 0, // Will be computed by promote.ts
        heuristics_removed: 0,
        experience_tokens: 0,
    };
}
export { scanTelemetry as _scanTelemetry };

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';
import { redact } from './redact.js';
import { captureFingerprint } from './fingerprint.js';
import { loadExperience } from './retrieve.js';
import { scanTelemetry, groupFailures } from './compact.js';
const AGENT_DIR = join(homedir(), '.claude', 'rn-agent');
const EXPORTS_DIR = join(AGENT_DIR, 'exports');
const EXPERIENCE_PATH = join(AGENT_DIR, 'experience.md');
function coarsenEnv(env) {
    const coarse = {};
    if (env.rn_version) {
        const [maj, min] = env.rn_version.split('.');
        coarse.rn_version = `${maj}.${min}`;
    }
    if (env.expo_sdk)
        coarse.expo_sdk = env.expo_sdk.split('.')[0];
    if (env.engine)
        coarse.engine = env.engine;
    if (env.architecture)
        coarse.architecture = env.architecture;
    if (env.platform)
        coarse.platform = env.platform;
    return coarse;
}
function anonymizeHeuristic(h) {
    return {
        id: h.id,
        type: h.type,
        summary: redact({ text: h.summary }).text,
        confidence: h.confidence,
        source: h.source,
        env: h.env_filter,
    };
}
function anonymizeStats(s) {
    return {
        tool: s.tool,
        normalized_error: s.normalized_error,
        family_id: s.family_id,
        total: s.total,
        ghost_recovered: s.ghost_recovered,
        failed: s.failed,
        run_count: s.runs.size,
    };
}
export function exportExperience() {
    if (!existsSync(EXPORTS_DIR)) {
        mkdirSync(EXPORTS_DIR, { recursive: true });
    }
    const env = captureFingerprint();
    const experience = loadExperience(true);
    const events = scanTelemetry();
    const stats = groupFailures(events);
    const bundle = {
        version: 1,
        exported_at: new Date().toISOString(),
        env: coarsenEnv(env),
        heuristics: experience.heuristics.map(anonymizeHeuristic),
        failure_stats: stats.filter(s => s.total >= 2).map(anonymizeStats),
    };
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `export-${timestamp}.yaml`;
    const path = join(EXPORTS_DIR, filename);
    writeFileSync(path, yamlStringify(bundle), 'utf-8');
    return { path, bundle };
}
export function importExperience(filePath) {
    if (!existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }
    const raw = readFileSync(filePath, 'utf-8');
    let bundle;
    try {
        bundle = yamlParse(raw);
    }
    catch {
        throw new Error('Invalid YAML format');
    }
    if (!bundle.version || !bundle.heuristics) {
        throw new Error('Invalid export bundle: missing version or heuristics');
    }
    let content = '';
    try {
        if (existsSync(EXPERIENCE_PATH))
            content = readFileSync(EXPERIENCE_PATH, 'utf-8');
    }
    catch { /* start fresh */ }
    const existingSummaries = new Set();
    const re = /^###\s+(?:FP|RS|PC)-[\w]+:\s*(.+)$/gm;
    let match;
    while ((match = re.exec(content)) !== null) {
        existingSummaries.add(match[1].trim().toLowerCase().slice(0, 60));
    }
    const result = { imported: 0, skipped: 0, contradictions: [] };
    for (const h of bundle.heuristics) {
        const summaryKey = h.summary.toLowerCase().slice(0, 60);
        if (existingSummaries.has(summaryKey)) {
            result.skipped++;
            continue;
        }
        const confidence = Math.round(h.confidence * 0.7);
        if (confidence < 20) {
            result.skipped++;
            continue;
        }
        const prefix = h.type === 'recovery_shortcut' ? 'RS' : h.type === 'failure_pattern' ? 'FP' : 'PC';
        const id = `${prefix}-I${result.imported + 1}`;
        const section = `### ${id}: ${h.summary.slice(0, 100)}
- **Confidence:** ${confidence}% (imported at 70% of original ${h.confidence}%)
- **Source:** imported from ${bundle.exported_at.split('T')[0]}
- **Original env:** ${JSON.stringify(h.env ?? {})}
`;
        const header = h.type === 'recovery_shortcut' ? '## Recovery Shortcuts' : '## Failure Patterns';
        const headerIdx = content.indexOf(header);
        if (headerIdx !== -1) {
            const insertAt = content.indexOf('\n', headerIdx + header.length);
            if (insertAt !== -1) {
                content = content.slice(0, insertAt + 1) + '\n' + section + content.slice(insertAt + 1);
            }
            else {
                content += '\n\n' + section;
            }
        }
        else {
            content += `\n${header}\n\n${section}`;
        }
        result.imported++;
    }
    if (result.imported > 0) {
        try {
            writeFileSync(EXPERIENCE_PATH, content, 'utf-8');
        }
        catch { /* best-effort */ }
    }
    return result;
}
export function getExperienceHealth() {
    const health = {
        telemetry: { file_count: 0, total_size_kb: 0, oldest_file: null, newest_file: null, event_count: 0 },
        heuristics: { total: 0, by_source: {}, by_type: {}, confidence_distribution: { high: 0, medium: 0, low: 0 } },
        candidates: { pending: 0, oldest: null },
        experience_tokens: 0,
        failure_families_loaded: 0,
        recoveries_loaded: 0,
    };
    const telemetryDir = join(AGENT_DIR, 'telemetry');
    if (existsSync(telemetryDir)) {
        try {
            const files = readdirSync(telemetryDir)
                .filter(f => f.endsWith('.jsonl'))
                .map(f => {
                try {
                    const s = statSync(join(telemetryDir, f));
                    return { name: f, size: s.size, mtime: s.mtimeMs };
                }
                catch {
                    return null;
                }
            })
                .filter((f) => f !== null)
                .sort((a, b) => a.mtime - b.mtime);
            health.telemetry.file_count = files.length;
            health.telemetry.total_size_kb = Math.round(files.reduce((s, f) => s + f.size, 0) / 1024);
            if (files.length > 0) {
                health.telemetry.oldest_file = files[0].name;
                health.telemetry.newest_file = files[files.length - 1].name;
            }
        }
        catch { /* best-effort */ }
        const events = scanTelemetry();
        health.telemetry.event_count = events.length;
    }
    try {
        const experience = loadExperience(true);
        health.heuristics.total = experience.heuristics.length;
        health.experience_tokens = experience.token_estimate;
        health.failure_families_loaded = experience.families.length;
        health.recoveries_loaded = experience.recoveries.length;
        for (const h of experience.heuristics) {
            health.heuristics.by_source[h.source] = (health.heuristics.by_source[h.source] ?? 0) + 1;
            health.heuristics.by_type[h.type] = (health.heuristics.by_type[h.type] ?? 0) + 1;
            if (h.confidence >= 80)
                health.heuristics.confidence_distribution.high++;
            else if (h.confidence >= 50)
                health.heuristics.confidence_distribution.medium++;
            else
                health.heuristics.confidence_distribution.low++;
        }
    }
    catch { /* best-effort */ }
    const candidatesDir = join(AGENT_DIR, 'candidates');
    if (existsSync(candidatesDir)) {
        try {
            const files = readdirSync(candidatesDir)
                .filter(f => f.endsWith('.md'))
                .map(f => {
                try {
                    const s = statSync(join(candidatesDir, f));
                    return { name: f, mtime: s.mtimeMs };
                }
                catch {
                    return null;
                }
            })
                .filter((f) => f !== null)
                .sort((a, b) => a.mtime - b.mtime);
            health.candidates.pending = files.length;
            if (files.length > 0)
                health.candidates.oldest = files[0].name;
        }
        catch { /* best-effort */ }
    }
    return health;
}

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { captureFingerprint } from './fingerprint.js';
const AGENT_DIR = join(homedir(), '.claude', 'rn-agent');
let cachedExperience = null;
/**
 * Resolve the plugin root from CLAUDE_PLUGIN_ROOT env or relative to this file.
 */
function getPluginRoot() {
    if (process.env.CLAUDE_PLUGIN_ROOT)
        return process.env.CLAUDE_PLUGIN_ROOT;
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}
function getSeedDir() {
    return join(getPluginRoot(), 'seed-experience');
}
// --- YAML Parsing ---
function loadYaml(path) {
    try {
        if (!existsSync(path))
            return null;
        return parseYaml(readFileSync(path, 'utf-8'));
    }
    catch {
        return null;
    }
}
// Phase B: only FF_STALE_CDP is ghost-eligible (narrow whitelist per review)
const GHOST_ELIGIBLE_IDS = new Set(['FF_STALE_CDP']);
function loadSeedFamilies() {
    const seedDir = getSeedDir();
    const data = loadYaml(join(seedDir, 'common-failures.yaml'));
    if (!data?.failure_families)
        return [];
    return data.failure_families.map(f => ({
        id: f.id,
        name: f.name,
        symptoms: f.symptoms,
        match: f.match,
        recovery: f.recovery,
        recovery_id: f.recovery_id,
        ghost_eligible: GHOST_ELIGIBLE_IDS.has(f.id),
        notes: f.notes,
    }));
}
function parseRecoveryStep(step) {
    const toolMatch = step.match(/^(\w+)\((.+)\)$/);
    if (toolMatch) {
        const args = {};
        for (const pair of toolMatch[2].split(',')) {
            const [k, v] = pair.split('=').map(s => s.trim());
            args[k] = v === 'true' ? true : v === 'false' ? false : v;
        }
        return { kind: 'tool', tool: toolMatch[1], args };
    }
    const waitMatch = step.match(/^wait (\d+)s$/i);
    if (waitMatch)
        return { kind: 'wait', ms: parseInt(waitMatch[1], 10) * 1000 };
    if (/^\w+$/.test(step.trim()))
        return { kind: 'tool', tool: step.trim() };
    return { kind: 'tool', tool: step };
}
function loadSeedRecoveries() {
    const seedDir = getSeedDir();
    const data = loadYaml(join(seedDir, 'recovery-playbook.yaml'));
    if (!data?.recovery_sequences)
        return [];
    return data.recovery_sequences.map(r => ({
        id: r.id,
        name: r.name,
        trigger: r.trigger,
        steps: r.steps.map(parseRecoveryStep),
        confidence: r.confidence,
    }));
}
function loadSeedHeuristics() {
    const seedDir = getSeedDir();
    const heuristics = [];
    const quirks = loadYaml(join(seedDir, 'platform-quirks.yaml'));
    if (quirks?.platform_quirks) {
        for (const [platform, items] of Object.entries(quirks.platform_quirks)) {
            for (const item of items) {
                heuristics.push({
                    id: item.id,
                    source: 'seed',
                    type: 'platform_quirk',
                    summary: `${item.quirk}${item.workaround ? ` — Workaround: ${item.workaround}` : ''}`,
                    env_filter: { platform: platform },
                    confidence: 90,
                });
            }
        }
    }
    const gotchas = loadYaml(join(seedDir, 'expo-gotchas.yaml'));
    if (gotchas?.expo_gotchas) {
        for (const item of gotchas.expo_gotchas) {
            heuristics.push({
                id: item.id,
                source: 'seed',
                type: 'expo_gotcha',
                summary: `${item.name}: ${item.symptom} — Fix: ${item.fix}`,
                confidence: item.severity === 'high' ? 90 : 70,
            });
        }
    }
    return heuristics;
}
// --- Markdown Experience Parsing ---
function parseExperienceMd(path, source) {
    try {
        if (!existsSync(path))
            return [];
        const content = readFileSync(path, 'utf-8');
        const heuristics = [];
        const sectionRe = /^###\s+(FP|RS|PC)-([\w]+):\s*(.+)$/gm;
        let match;
        while ((match = sectionRe.exec(content)) !== null) {
            const prefix = match[1];
            const num = match[2];
            const title = match[3];
            const type = prefix === 'FP' ? 'failure_pattern'
                : prefix === 'RS' ? 'recovery_shortcut'
                    : 'platform_quirk';
            const afterSection = content.slice(match.index + match[0].length, match.index + match[0].length + 500);
            const confMatch = afterSection.match(/Confidence:\s*(\d+)%/i);
            const confidence = confMatch ? parseInt(confMatch[1], 10) : 60;
            heuristics.push({
                id: `${prefix}-${num}`,
                source,
                type: type,
                summary: title,
                confidence,
            });
        }
        return heuristics;
    }
    catch {
        return [];
    }
}
// --- Environment Filtering ---
function matchesEnvironment(filter, env) {
    if (!filter)
        return 1.0;
    let score = 1.0;
    let checks = 0;
    let matches = 0;
    if (filter.platform) {
        checks++;
        if (env.platform === filter.platform)
            matches++;
        else if (env.platform === null) {
            matches += 0.5;
            score *= 0.8;
        }
    }
    if (filter.engine) {
        checks++;
        if (env.engine === filter.engine)
            matches++;
        else if (env.engine === null) {
            matches += 0.5;
            score *= 0.8;
        }
    }
    if (filter.architecture) {
        checks++;
        if (env.architecture === filter.architecture)
            matches++;
        else if (env.architecture === null) {
            matches += 0.5;
            score *= 0.8;
        }
    }
    if (filter.rn_version && env.rn_version) {
        checks++;
        const [fMaj, fMin] = filter.rn_version.split('.');
        const [eMaj, eMin] = env.rn_version.split('.');
        if (fMaj === eMaj && fMin === eMin)
            matches++;
        else if (fMaj === eMaj) {
            matches += 0.7;
            score *= 0.9;
        }
    }
    if (filter.expo_sdk && env.expo_sdk) {
        checks++;
        const fMaj = filter.expo_sdk.split('.')[0];
        const eMaj = env.expo_sdk.split('.')[0];
        if (fMaj === eMaj)
            matches++;
    }
    if (checks === 0)
        return score;
    return score * (matches / checks);
}
// --- Public API ---
export function loadExperience(forceReload = false) {
    if (cachedExperience && !forceReload)
        return cachedExperience;
    const env = captureFingerprint();
    const families = loadSeedFamilies();
    const recoveries = loadSeedRecoveries();
    const seedHeuristics = loadSeedHeuristics();
    let projectRoot = null;
    try {
        let dir = process.cwd();
        for (let i = 0; i < 10; i++) {
            if (existsSync(join(dir, 'package.json'))) {
                projectRoot = dir;
                break;
            }
            const parent = join(dir, '..');
            if (parent === dir)
                break;
            dir = parent;
        }
    }
    catch { /* cwd gone */ }
    const projectHeuristics = projectRoot
        ? parseExperienceMd(join(projectRoot, '.rn-agent-experience.md'), 'project')
        : [];
    const userHeuristics = parseExperienceMd(join(AGENT_DIR, 'experience.md'), 'user');
    // Cascade priority: user > project > seed
    const byId = new Map();
    for (const h of seedHeuristics)
        byId.set(h.id, h);
    for (const h of projectHeuristics)
        byId.set(h.id, h);
    for (const h of userHeuristics)
        byId.set(h.id, h);
    const filtered = [...byId.values()]
        .map(h => ({
        ...h,
        confidence: Math.round(h.confidence * matchesEnvironment(h.env_filter, env)),
    }))
        .filter(h => h.confidence >= 20)
        .sort((a, b) => b.confidence - a.confidence);
    let tokenEstimate = 0;
    const heuristics = [];
    for (const h of filtered) {
        const tokens = Math.ceil(h.summary.length / 4) + 10;
        if (tokenEstimate + tokens > 2000)
            break;
        heuristics.push(h);
        tokenEstimate += tokens;
    }
    cachedExperience = {
        heuristics,
        families,
        recoveries,
        loaded_at: new Date().toISOString(),
        token_estimate: tokenEstimate,
    };
    return cachedExperience;
}
export function getFailureFamilies() {
    return loadExperience().families;
}
export function getRecoverySequence(id) {
    return loadExperience().recoveries.find(r => r.id === id);
}
export function clearExperienceCache() {
    cachedExperience = null;
}

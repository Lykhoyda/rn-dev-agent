import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';
import { redact } from './redact.js';
import { captureFingerprint } from './fingerprint.js';
import { loadExperience } from './retrieve.js';
import { scanTelemetry, groupFailures } from './compact.js';
import type {
  ExperienceHeuristic,
  EnvironmentFingerprint,
  FailureStats,
} from './types.js';
import {
  anonymizeFlowYaml,
  restoreFlowYaml,
  anonymizeSkeleton,
  restoreSkeleton,
  extractActionId,
} from './flow-bundle.js';
import { findProjectRoot } from '../nav-graph/storage.js';
import { readAppId } from '../project-config.js';

const AGENT_DIR = join(homedir(), '.claude', 'rn-agent');
const EXPORTS_DIR = join(AGENT_DIR, 'exports');
const EXPERIENCE_PATH = join(AGENT_DIR, 'experience.md');

// --- Export ---

interface ExportedHeuristic {
  id: string;
  type: string;
  summary: string;
  confidence: number;
  source: string;
  env?: Partial<EnvironmentFingerprint>;
}

interface ExportedFailureGroup {
  tool: string;
  normalized_error: string;
  family_id?: string;
  total: number;
  ghost_recovered: number;
  failed: number;
  run_count: number;
}

/** GH #106: one anonymized flow inside the export bundle. */
interface ExportedFlow {
  id: string;            // M7 `id` from the flow header — used for conflict detection on import
  yaml: string;          // anonymized YAML (appId rewritten, prose truncated, body verbatim)
}

/** GH #106: anonymized skeleton inside the export bundle. */
interface ExportedSkeleton {
  yaml: string;
}

interface ExportBundle {
  version: 1;
  exported_at: string;
  env: Partial<EnvironmentFingerprint>;
  heuristics: ExportedHeuristic[];
  failure_stats: ExportedFailureGroup[];
  flows?: ExportedFlow[];           // GH #106 — present unless --no-flows
  skeleton?: ExportedSkeleton | null; // GH #106 — present unless --no-skeleton
}

export interface ExportOptions {
  /** GH #106: bundle .rn-agent/actions/*.yaml (default true). */
  flows?: boolean;
  /** GH #106: bundle .rn-agent/skeleton.yaml (default true). */
  skeleton?: boolean;
  /**
   * Override project root for tests. Defaults to findProjectRoot() result.
   * When null, flows + skeleton bundling is silently skipped.
   */
  projectRoot?: string | null;
}

export interface ImportOptions {
  /** GH #106: write bundled flows into local .rn-agent/actions/ (default true). */
  flows?: boolean;
  /** GH #106: write bundled skeleton into local .rn-agent/skeleton.yaml (default true). */
  skeleton?: boolean;
  /** Override project root for tests. Defaults to findProjectRoot() result. */
  projectRoot?: string | null;
  /** Override local app platform for appId resolution. Defaults to 'ios'. */
  appPlatform?: 'ios' | 'android';
}

function coarsenEnv(env: EnvironmentFingerprint): Partial<EnvironmentFingerprint> {
  const coarse: Partial<EnvironmentFingerprint> = {};
  if (env.rn_version) {
    const [maj, min] = env.rn_version.split('.');
    coarse.rn_version = `${maj}.${min}`;
  }
  if (env.expo_sdk) coarse.expo_sdk = env.expo_sdk.split('.')[0];
  if (env.engine) coarse.engine = env.engine;
  if (env.architecture) coarse.architecture = env.architecture;
  if (env.platform) coarse.platform = env.platform;
  return coarse;
}

function anonymizeHeuristic(h: ExperienceHeuristic): ExportedHeuristic {
  return {
    id: h.id,
    type: h.type,
    summary: redact({ text: h.summary }).text as string,
    confidence: h.confidence,
    source: h.source,
    env: h.env_filter,
  };
}

function anonymizeStats(s: FailureStats): ExportedFailureGroup {
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

/**
 * GH #106: walk `<projectRoot>/.rn-agent/actions/*.yaml` and return
 * anonymized flow entries. Skips files that throw FlowBundleError
 * (malformed actions) and logs them — one bad file shouldn't kill the
 * whole export. Returns empty array when the dir doesn't exist.
 */
function collectFlows(projectRoot: string): ExportedFlow[] {
  const actionsDir = join(projectRoot, '.rn-agent', 'actions');
  if (!existsSync(actionsDir)) return [];
  let files: string[];
  try {
    files = readdirSync(actionsDir).filter(f => f.endsWith('.yaml'));
  } catch {
    return [];
  }
  const out: ExportedFlow[] = [];
  for (const f of files) {
    try {
      const text = readFileSync(join(actionsDir, f), 'utf-8');
      const anonymized = anonymizeFlowYaml(text);
      const id = extractActionId(anonymized) ?? f.replace(/\.yaml$/, '');
      out.push({ id, yaml: anonymized });
    } catch (e) {
      process.stderr.write(`[export] skipping ${f}: ${(e as Error).message}\n`);
    }
  }
  return out;
}

function collectSkeleton(projectRoot: string): ExportedSkeleton | null {
  const path = join(projectRoot, '.rn-agent', 'skeleton.yaml');
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, 'utf-8');
    return { yaml: anonymizeSkeleton(text) };
  } catch (e) {
    process.stderr.write(`[export] skipping skeleton: ${(e as Error).message}\n`);
    return null;
  }
}

export function exportExperience(opts: ExportOptions = {}): { path: string; bundle: ExportBundle } {
  if (!existsSync(EXPORTS_DIR)) {
    mkdirSync(EXPORTS_DIR, { recursive: true });
  }

  const env = captureFingerprint();
  const experience = loadExperience(true);
  const events = scanTelemetry();
  const stats = groupFailures(events);

  const bundle: ExportBundle = {
    version: 1,
    exported_at: new Date().toISOString(),
    env: coarsenEnv(env),
    heuristics: experience.heuristics.map(anonymizeHeuristic),
    failure_stats: stats.filter(s => s.total >= 2).map(anonymizeStats),
  };

  // GH #106: optionally bundle .rn-agent/actions/ and .rn-agent/skeleton.yaml.
  const includeFlows = opts.flows !== false;
  const includeSkeleton = opts.skeleton !== false;
  const projectRoot = opts.projectRoot !== undefined ? opts.projectRoot : findProjectRoot();
  if (projectRoot && (includeFlows || includeSkeleton)) {
    if (includeFlows) bundle.flows = collectFlows(projectRoot);
    if (includeSkeleton) bundle.skeleton = collectSkeleton(projectRoot);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `export-${timestamp}.yaml`;
  const path = join(EXPORTS_DIR, filename);

  writeFileSync(path, yamlStringify(bundle), 'utf-8');
  return { path, bundle };
}

// --- Import ---

interface ImportResult {
  imported: number;
  skipped: number;
  contradictions: string[];
  /** GH #106 — count of flow YAMLs written into `.rn-agent/actions/`. */
  flows_imported?: number;
  /** GH #106 — flow files written with `.imported.yaml` suffix because their `id` collided. */
  flows_renamed?: string[];
  /** GH #106 — skeleton write outcome. */
  skeleton_imported?: boolean;
}

/**
 * GH #106: write a single bundled flow into <projectRoot>/.rn-agent/actions/.
 * On id collision, write `<id>.imported.yaml` so the user can diff and
 * merge manually. Forces `status: experimental` (handled by
 * restoreFlowYaml) and rewrites the placeholder appId to the local one.
 */
function writeImportedFlow(
  projectRoot: string,
  flow: ExportedFlow,
  localAppId: string,
  renamed: string[],
): boolean {
  const actionsDir = join(projectRoot, '.rn-agent', 'actions');
  if (!existsSync(actionsDir)) mkdirSync(actionsDir, { recursive: true });
  // Defense in depth: id must be a plain slug; reject anything else so we
  // can't be tricked into writing outside the actions dir via a malformed
  // bundle. (extractActionId already enforces this on export but
  // re-validate at the import boundary.)
  if (!/^[A-Za-z0-9_-]+$/.test(flow.id)) {
    process.stderr.write(`[import] skipping flow with invalid id: ${JSON.stringify(flow.id)}\n`);
    return false;
  }
  const targetPath = join(actionsDir, `${flow.id}.yaml`);
  let restored: string;
  try {
    restored = restoreFlowYaml(flow.yaml, localAppId);
  } catch (e) {
    process.stderr.write(`[import] skipping flow ${flow.id}: ${(e as Error).message}\n`);
    return false;
  }
  if (existsSync(targetPath)) {
    // Gemini multi-review (conf 90): the first collision goes to
    // `<id>.imported.yaml`. The SECOND collision must not silently
    // overwrite the first imported variant — the user may be mid-merge
    // on that file. Numbered suffix preserves every prior import for
    // diff-and-merge.
    let altPath = join(actionsDir, `${flow.id}.imported.yaml`);
    let altName = `${flow.id}.imported.yaml`;
    let n = 2;
    while (existsSync(altPath)) {
      altName = `${flow.id}.imported.${n}.yaml`;
      altPath = join(actionsDir, altName);
      n++;
      if (n > 100) {
        // Bound the climb at 100 — at that point the user has bigger
        // problems and we should fail loudly rather than write 1000
        // suffixed files.
        process.stderr.write(`[import] too many imported variants of ${flow.id}; skipping\n`);
        return false;
      }
    }
    writeFileSync(altPath, restored, 'utf-8');
    renamed.push(altName);
    return true;
  }
  writeFileSync(targetPath, restored, 'utf-8');
  return true;
}

function writeImportedSkeleton(
  projectRoot: string,
  skeleton: ExportedSkeleton,
  localAppId: string,
): boolean {
  const rnAgentDir = join(projectRoot, '.rn-agent');
  if (!existsSync(rnAgentDir)) mkdirSync(rnAgentDir, { recursive: true });
  const targetPath = join(rnAgentDir, 'skeleton.yaml');
  // Don't overwrite an existing skeleton silently — write side-by-side.
  // Same numbered-suffix rule as flows so a second import doesn't
  // clobber a first-imported variant that's mid-merge.
  const restored = restoreSkeleton(skeleton.yaml, localAppId);
  if (existsSync(targetPath)) {
    let altPath = join(rnAgentDir, 'skeleton.imported.yaml');
    let n = 2;
    while (existsSync(altPath)) {
      altPath = join(rnAgentDir, `skeleton.imported.${n}.yaml`);
      n++;
      if (n > 100) {
        process.stderr.write('[import] too many imported skeleton variants; skipping\n');
        return false;
      }
    }
    writeFileSync(altPath, restored, 'utf-8');
    return true;
  }
  writeFileSync(targetPath, restored, 'utf-8');
  return true;
}

// Highest existing `-I<n>` imported-heuristic id per prefix, so import counters
// can start past them and never collide across repeat/multi-bundle imports.
export function highestImportedIds(content: string): Record<string, number> {
  const counters: Record<string, number> = { RS: 0, FP: 0, PC: 0 };
  const idRe = /^###\s+(FP|RS|PC)-I(\d+):/gm;
  let m;
  while ((m = idRe.exec(content)) !== null) {
    counters[m[1]] = Math.max(counters[m[1]] ?? 0, parseInt(m[2], 10));
  }
  return counters;
}

export function importExperience(filePath: string, opts: ImportOptions = {}): ImportResult {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const raw = readFileSync(filePath, 'utf-8');
  let bundle: ExportBundle;
  try {
    bundle = yamlParse(raw) as ExportBundle;
  } catch {
    throw new Error('Invalid YAML format');
  }

  if (!bundle.version || !bundle.heuristics) {
    throw new Error('Invalid export bundle: missing version or heuristics');
  }

  let content = '';
  try {
    if (existsSync(EXPERIENCE_PATH)) content = readFileSync(EXPERIENCE_PATH, 'utf-8');
  } catch { /* start fresh */ }

  const existingSummaries = new Set<string>();
  const re = /^###\s+(?:FP|RS|PC)-[\w]+:\s*(.+)$/gm;
  let match;
  while ((match = re.exec(content)) !== null) {
    existingSummaries.add(match[1].trim().toLowerCase().slice(0, 60));
  }

  // Start each imported-id counter past the highest existing `-I<n>` so a
  // repeat or multi-bundle import never re-assigns an id that already exists
  // (a duplicate RS-I1 shadows the first in loadExperience's byId Map and makes
  // applyDecay's non-global regex rewrite the wrong section).
  const importedCounters = highestImportedIds(content);

  const result: ImportResult = { imported: 0, skipped: 0, contradictions: [] };

  for (const h of bundle.heuristics) {
    const summaryKey = h.summary.toLowerCase().slice(0, 60);

    if (existingSummaries.has(summaryKey)) {
      result.skipped++;
      continue;
    }

    const confidence = Math.round(h.confidence * 0.7);
    if (confidence < 20) { result.skipped++; continue; }

    const prefix = h.type === 'recovery_shortcut' ? 'RS' : h.type === 'failure_pattern' ? 'FP' : 'PC';
    const id = `${prefix}-I${++importedCounters[prefix]}`;
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
      } else {
        content += '\n\n' + section;
      }
    } else {
      content += `\n${header}\n\n${section}`;
    }

    result.imported++;
  }

  if (result.imported > 0) {
    try { writeFileSync(EXPERIENCE_PATH, content, 'utf-8'); } catch { /* best-effort */ }
  }

  // GH #106: import flows + skeleton when present in the bundle and not
  // opted out. Resolves the local appId via project-config.readAppId, so
  // the bundle's com.example.<slug> stub gets rewritten to the real
  // bundleId of the receiving test-app.
  const includeFlows = opts.flows !== false;
  const includeSkeleton = opts.skeleton !== false;
  const hasFlows = Array.isArray(bundle.flows) && bundle.flows.length > 0;
  const hasSkeleton = bundle.skeleton != null;
  if ((includeFlows && hasFlows) || (includeSkeleton && hasSkeleton)) {
    const projectRoot = opts.projectRoot !== undefined ? opts.projectRoot : findProjectRoot();
    if (projectRoot) {
      const platform = opts.appPlatform ?? 'ios';
      const localAppId = readAppId(projectRoot, platform) ?? 'com.example.unknownapp';
      const renamed: string[] = [];
      let flowCount = 0;
      if (includeFlows && hasFlows) {
        for (const flow of bundle.flows!) {
          if (writeImportedFlow(projectRoot, flow, localAppId, renamed)) flowCount++;
        }
        result.flows_imported = flowCount;
        if (renamed.length > 0) result.flows_renamed = renamed;
      }
      if (includeSkeleton && hasSkeleton) {
        result.skeleton_imported = writeImportedSkeleton(projectRoot, bundle.skeleton!, localAppId);
      }
    } else {
      process.stderr.write('[import] no project root found — skipping flow/skeleton import\n');
    }
  }

  return result;
}

// --- Health Dashboard ---

export interface ExperienceHealth {
  telemetry: {
    file_count: number;
    total_size_kb: number;
    oldest_file: string | null;
    newest_file: string | null;
    event_count: number;
  };
  heuristics: {
    total: number;
    by_source: Record<string, number>;
    by_type: Record<string, number>;
    confidence_distribution: { high: number; medium: number; low: number };
  };
  candidates: { pending: number; oldest: string | null };
  experience_tokens: number;
  failure_families_loaded: number;
  recoveries_loaded: number;
}

export function getExperienceHealth(): ExperienceHealth {
  const health: ExperienceHealth = {
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
          } catch { return null; }
        })
        .filter((f): f is NonNullable<typeof f> => f !== null)
        .sort((a, b) => a.mtime - b.mtime);

      health.telemetry.file_count = files.length;
      health.telemetry.total_size_kb = Math.round(files.reduce((s, f) => s + f.size, 0) / 1024);
      if (files.length > 0) {
        health.telemetry.oldest_file = files[0].name;
        health.telemetry.newest_file = files[files.length - 1].name;
      }
    } catch { /* best-effort */ }

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
      if (h.confidence >= 80) health.heuristics.confidence_distribution.high++;
      else if (h.confidence >= 50) health.heuristics.confidence_distribution.medium++;
      else health.heuristics.confidence_distribution.low++;
    }
  } catch { /* best-effort */ }

  const candidatesDir = join(AGENT_DIR, 'candidates');
  if (existsSync(candidatesDir)) {
    try {
      const files = readdirSync(candidatesDir)
        .filter(f => f.endsWith('.md'))
        .map(f => {
          try {
            const s = statSync(join(candidatesDir, f));
            return { name: f, mtime: s.mtimeMs };
          } catch { return null; }
        })
        .filter((f): f is NonNullable<typeof f> => f !== null)
        .sort((a, b) => a.mtime - b.mtime);

      health.candidates.pending = files.length;
      if (files.length > 0) health.candidates.oldest = files[0].name;
    } catch { /* best-effort */ }
  }

  return health;
}

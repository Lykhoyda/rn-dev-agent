import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../logger.js';
import type {
  CandidateHeuristic,
  CompactionResult,
  PromotionResult,
} from './types.js';
import { scanTelemetry, groupFailures, generateCandidates, computeDecay } from './compact.js';

const AGENT_DIR = join(homedir(), '.claude', 'rn-agent');
const EXPERIENCE_PATH = join(AGENT_DIR, 'experience.md');
const CANDIDATES_DIR = join(AGENT_DIR, 'candidates');
const TELEMETRY_DIR = join(AGENT_DIR, 'telemetry');
const MAX_EXPERIENCE_TOKENS = 2000;

function writeCandidateFile(candidate: CandidateHeuristic): void {
  if (!existsSync(CANDIDATES_DIR)) {
    try { mkdirSync(CANDIDATES_DIR, { recursive: true }); } catch { return; }
  }

  const filename = `candidate-${candidate.id.toLowerCase()}.md`;
  const content = `# Candidate: ${candidate.id}

**Type:** ${candidate.type}
**Tool:** ${candidate.tool}
**Symptom:** ${candidate.symptom}
**Family:** ${candidate.family_id ?? 'unclassified'}
**Confidence:** ${candidate.confidence}%
**Seen:** ${candidate.seen_count} times (${candidate.success_count} recovered)
**First seen:** ${candidate.first_seen}
**Last seen:** ${candidate.last_seen}
**Auto-promotable:** ${candidate.auto_promotable ? 'yes' : 'no — requires human review'}
${candidate.recovery ? `**Recovery:** ${candidate.recovery}` : ''}
${candidate.env ? `**Environment:** ${JSON.stringify(candidate.env)}` : ''}

## Status

- [ ] Reviewed
- [ ] Promoted to experience.md
- [ ] Rejected (delete this file)
`;

  try {
    writeFileSync(join(CANDIDATES_DIR, filename), content, 'utf-8');
  } catch { /* best-effort */ }
}

function formatHeuristicMd(candidate: CandidateHeuristic): string {
  const prefix = candidate.type === 'recovery_shortcut' ? 'RS' : 'FP';
  const id = candidate.id.startsWith(prefix) ? candidate.id : `${prefix}-${candidate.id}`;

  if (candidate.type === 'recovery_shortcut') {
    return `### ${id}: ${candidate.tool} — auto-recovery for ${candidate.family_id ?? 'transient error'}
- **Rule:** When \`${candidate.tool}\` fails with "${candidate.symptom.slice(0, 80)}", retry after brief wait. Ghost auto-recovery succeeds ${candidate.confidence}% of the time.
- **Saves:** Prevents agent from seeing transient transport errors
- **Confidence:** ${candidate.confidence}%
- **Seen:** ${candidate.seen_count} times, recovered ${candidate.success_count} times
`;
  }

  return `### ${id}: ${candidate.tool} — recurring failure
- **Symptom:** ${candidate.symptom.slice(0, 120)}
- **Family:** ${candidate.family_id ?? 'unclassified'}
- **Confidence:** ${candidate.confidence}%
- **Seen:** ${candidate.seen_count} times across ${candidate.last_seen ? 'multiple sessions' : 'one session'}
`;
}

function readExistingExperience(): { content: string; heuristics: Array<{ id: string; confidence: number }>; summaries: Set<string> } {
  try {
    if (!existsSync(EXPERIENCE_PATH)) return { content: '', heuristics: [], summaries: new Set() };
    const content = readFileSync(EXPERIENCE_PATH, 'utf-8');
    const heuristics: Array<{ id: string; confidence: number }> = [];
    const summaries = new Set<string>();
    const re = /^###\s+((?:FP|RS|PC)-[\w]+):\s*(.+)$/gm;
    let match;
    while ((match = re.exec(content)) !== null) {
      const id = match[1];
      const summary = match[2].trim();
      summaries.add(summary.toLowerCase().slice(0, 80));
      // Extract confidence from section body
      const after = content.slice(match.index + match[0].length, match.index + match[0].length + 500);
      const confMatch = after.match(/Confidence:\s*(\d+)%/i);
      const confidence = confMatch ? parseInt(confMatch[1], 10) : 60;
      heuristics.push({ id, confidence });
    }
    return { content, heuristics, summaries };
  } catch {
    return { content: '', heuristics: [], summaries: new Set() };
  }
}

function applyDecay(
  content: string,
  decayed: string[],
  removed: string[],
  confidenceMap: Map<string, number>,
): { content: string; decayedCount: number; removedCount: number } {
  let result = content;
  let decayedCount = 0;
  let removedCount = 0;

  for (const id of removed) {
    const sectionRe = new RegExp(`### ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^]*?(?=###|$)`, 'g');
    const before = result.length;
    result = result.replace(sectionRe, '');
    if (result.length < before) removedCount++;
  }

  for (const id of decayed) {
    const newConf = confidenceMap.get(id);
    if (newConf !== undefined) {
      const confRe = new RegExp(`(### ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^]*?Confidence:\\s*)\\d+(%)`);
      const before = result;
      result = result.replace(confRe, `$1${newConf}$2`);
      if (result !== before) decayedCount++;
    }
  }

  result = result.replace(/\n{3,}/g, '\n\n');
  return { content: result, decayedCount, removedCount };
}

function appendToSection(content: string, sectionHeader: string, block: string): string {
  const idx = content.indexOf(sectionHeader);
  if (idx !== -1) {
    const insertAt = content.indexOf('\n', idx + sectionHeader.length);
    if (insertAt === -1) {
      // Header at end of file with no trailing newline
      return content + '\n\n' + block;
    }
    return content.slice(0, insertAt + 1) + '\n' + block + content.slice(insertAt + 1);
  }
  return content + `\n${sectionHeader}\n\n${block}`;
}

/**
 * Run the full compaction + promotion cycle.
 */
export function runCompactionCycle(): { result: CompactionResult; promotions: PromotionResult[] } {
  const events = scanTelemetry();
  const stats = groupFailures(events);
  const candidates = generateCandidates(stats, events);

  const autoPromotable = candidates.filter(c => c.auto_promotable);
  const humanReview = candidates.filter(c => !c.auto_promotable);

  const { content: existingContent, heuristics: existingHeuristics, summaries: existingSummaries } = readExistingExperience();
  const { decayed, removed, currentConfidence } = computeDecay(existingHeuristics, events);
  const decay = applyDecay(existingContent, decayed, removed, currentConfidence);
  let updatedContent = decay.content;

  const promotions: PromotionResult[] = [];
  for (const candidate of autoPromotable) {
    // Dedup by normalized_error content, not generated ID
    const dedupKey = `${candidate.tool} — ${candidate.symptom}`.toLowerCase().slice(0, 80);
    if (existingSummaries.has(dedupKey)) continue;

    const section = formatHeuristicMd(candidate);
    const sectionTokens = Math.ceil(section.length / 4);
    const currentTokens = Math.ceil(updatedContent.length / 4);
    if (currentTokens + sectionTokens > MAX_EXPERIENCE_TOKENS) break;

    const header = candidate.type === 'recovery_shortcut'
      ? '## Recovery Shortcuts' : '## Failure Patterns';
    updatedContent = appendToSection(updatedContent, header, section);

    promotions.push({
      promoted_to: 'user',
      heuristic_id: candidate.id,
      auto: true,
      reason: `Ghost recovery success rate: ${candidate.confidence}% (${candidate.success_count}/${candidate.seen_count})`,
    });
  }

  if (updatedContent !== existingContent) {
    try { writeFileSync(EXPERIENCE_PATH, updatedContent, 'utf-8'); } catch { /* best-effort */ }
  }

  for (const candidate of humanReview) {
    writeCandidateFile(candidate);
  }

  let telemetryFiles = 0;
  if (existsSync(TELEMETRY_DIR)) {
    try {
      telemetryFiles = readdirSync(TELEMETRY_DIR).filter(f => f.endsWith('.jsonl')).length;
    } catch { /* best-effort */ }
  }

  return {
    result: {
      telemetry_files_scanned: telemetryFiles,
      events_processed: events.length,
      failure_groups: stats.length,
      candidates_generated: candidates.length,
      candidates_auto_promoted: promotions.length,
      heuristics_decayed: decay.decayedCount,
      heuristics_removed: decay.removedCount,
      experience_tokens: Math.ceil(updatedContent.length / 4),
    },
    promotions,
  };
}

const LAST_COMPACT_PATH = join(AGENT_DIR, 'last-compact.json');
const AUTO_COMPACT_MIN_EVENTS = 200;
const AUTO_COMPACT_MIN_DAYS = 3;

function readLastCompactTime(): number {
  try {
    if (!existsSync(LAST_COMPACT_PATH)) return 0;
    const data = JSON.parse(readFileSync(LAST_COMPACT_PATH, 'utf-8')) as { ts: number };
    return data.ts ?? 0;
  } catch { return 0; }
}

function writeLastCompactTime(): void {
  try {
    if (!existsSync(AGENT_DIR)) mkdirSync(AGENT_DIR, { recursive: true });
    writeFileSync(LAST_COMPACT_PATH, JSON.stringify({ ts: Date.now() }), 'utf-8');
  } catch { /* best-effort */ }
}

function countTelemetryEvents(): number {
  if (!existsSync(TELEMETRY_DIR)) return 0;
  try {
    let total = 0;
    for (const file of readdirSync(TELEMETRY_DIR)) {
      if (!file.endsWith('.jsonl')) continue;
      const stat = statSync(join(TELEMETRY_DIR, file));
      // Rough estimate: ~200 bytes per JSONL line
      total += Math.ceil(stat.size / 200);
    }
    return total;
  } catch { return 0; }
}

function shouldAutoCompact(): boolean {
  const lastCompact = readLastCompactTime();
  const daysSince = (Date.now() - lastCompact) / (1000 * 60 * 60 * 24);
  const eventEstimate = countTelemetryEvents();

  if (eventEstimate < 10) return false;
  if (daysSince >= AUTO_COMPACT_MIN_DAYS && eventEstimate >= AUTO_COMPACT_MIN_EVENTS) return true;
  if (daysSince >= 7) return true;
  return false;
}

export function autoCompactIfNeeded(): void {
  try {
    if (!shouldAutoCompact()) return;

    logger.info('EXP', 'Auto-compaction triggered');
    const { result, promotions } = runCompactionCycle();
    writeLastCompactTime();

    logger.info('EXP', `Compacted: ${result.events_processed} events, ${result.candidates_generated} candidates, ${result.candidates_auto_promoted} auto-promoted, ${result.heuristics_decayed} decayed, ${result.heuristics_removed} removed`);
    if (promotions.length > 0) {
      for (const p of promotions) {
        logger.info('EXP', `Promoted ${p.heuristic_id}: ${p.reason}`);
      }
    }
  } catch (err) {
    logger.warn('EXP', `Auto-compaction failed: ${err instanceof Error ? err.message : err}`);
  }
}

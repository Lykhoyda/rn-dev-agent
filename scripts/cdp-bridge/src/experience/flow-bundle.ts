// GH #106 / D1204 follow-up — flow + skeleton bundling helpers for the
// experience export/import pipeline. The detector / existing exporter in
// sharing.ts already handles heuristics + failure stats; this module adds
// the missing pieces so the bundle actually carries the .rn-agent/actions/
// corpus and the skeleton.yaml lookup table.
//
// Pure functions only — no I/O. Caller (sharing.ts) walks the filesystem
// and feeds raw YAML text in. Returns transformed YAML text. Keeps the
// I/O surface auditable and the helpers testable without temp dirs.
//
// Design calls (Codex pre-implementation review, both HIGH conf):
// - `${VAR}` placeholders → prepend "# placeholders: VAR1, VAR2" comment
//   above the M7 header on restore. Do NOT suffix with .needs-review.yaml
//   — that punishes correctly-authored flows. (Codex A)
// - `appId:` rewrite is line-wise, not whole-string. Preserves multi-line
//   top sections (a human-edited "# shared across envs" comment above
//   appId is legitimate per saveAction's topSection contract). Hard-fail
//   only when zero `appId:` lines exist; warn on multiple. (Codex B)

const APPID_LINE_RE = /^appId:\s*(.+)$/;
const PLACEHOLDER_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
const M7_HEADER_LINE_RE = /^#\s*(id|intent|tags|mutates|status|requires|produces|preconditions|placeholders):/i;
const STATUS_LINE_RE = /^(#\s*status:\s*).+$/;

const MAX_PROSE_LINE_LENGTH = 200; // bytes per prose comment before truncation

/** Anonymize a project's appId into a stable export slug (lowercase, no dots). */
export function sanitizeAppIdSlug(appId: string): string {
  if (!appId || typeof appId !== 'string') return 'app';
  const slug = appId
    .toLowerCase()
    .replace(/^com\./, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'app';
}

interface SplitYaml {
  topSection: string[];
  m7HeaderAndProse: string[];
  body: string[];
  hasSeparator: boolean;
}

function splitFlowYaml(text: string): SplitYaml {
  const lines = text.split('\n');
  const sepIdx = lines.findIndex((l) => l.trim() === '---');
  if (sepIdx < 0) {
    return { topSection: [], m7HeaderAndProse: [], body: lines, hasSeparator: false };
  }
  const topSection = lines.slice(0, sepIdx);
  const afterSep = lines.slice(sepIdx + 1);
  const headerAndProse: string[] = [];
  const body: string[] = [];
  let stillHeader = true;
  for (const line of afterSep) {
    if (stillHeader && (line.startsWith('#') || line.trim() === '')) {
      headerAndProse.push(line);
    } else {
      stillHeader = false;
      body.push(line);
    }
  }
  return { topSection, m7HeaderAndProse: headerAndProse, body, hasSeparator: true };
}

function joinFlowYaml(parts: SplitYaml): string {
  const out: string[] = [];
  if (parts.hasSeparator) {
    for (const l of parts.topSection) out.push(l);
    out.push('---');
  }
  for (const l of parts.m7HeaderAndProse) out.push(l);
  for (const l of parts.body) out.push(l);
  return out.join('\n');
}

function rewriteAppIdLine(topSection: string[], newAppId: string): string[] {
  let foundIdx = -1;
  for (let i = 0; i < topSection.length; i++) {
    if (APPID_LINE_RE.test(topSection[i])) {
      foundIdx = i;
      break;
    }
  }
  if (foundIdx < 0) {
    throw new Error('FlowBundleError: top section missing appId: line');
  }
  // Codex B: replace the first match; if there are duplicates, the second
  // is left alone. Maestro itself honors the first appId, so this matches
  // runtime semantics. A warning here would just spam logs since the
  // export side runs through every project's flows.
  const next = [...topSection];
  next[foundIdx] = `appId: ${newAppId}`;
  return next;
}

/**
 * Anonymize a flow YAML for export:
 *   - rewrite `appId:` to `com.example.<slug>`
 *   - truncate any prose comment line longer than 200 chars in the
 *     header-and-prose section (preserves M7 fields verbatim)
 *   - leave body verbatim (testIDs are semantic; ${VAR} placeholders stay)
 *
 * Throws FlowBundleError when the YAML has no `appId:` line — surfaces
 * malformed input rather than silently producing a broken export.
 */
export function anonymizeFlowYaml(text: string): string {
  const parts = splitFlowYaml(text);
  if (!parts.hasSeparator) {
    throw new Error('FlowBundleError: flow YAML missing --- separator');
  }
  const sourceMatch = parts.topSection
    .map((l) => l.match(APPID_LINE_RE))
    .find((m) => m !== null);
  if (!sourceMatch) {
    throw new Error('FlowBundleError: top section missing appId: line');
  }
  const slug = sanitizeAppIdSlug(sourceMatch[1].trim());
  const newTop = rewriteAppIdLine(parts.topSection, `com.example.${slug}`);
  // Multi-review fix (Codex 92 + Gemini 95): strip any `# placeholders:`
  // line on export so a bundle round-trip (A→B→C) doesn't accumulate
  // copies. The manifest is a local-import-only annotation; the bundle
  // itself should never carry it.
  const newHeader = parts.m7HeaderAndProse
    .filter((line) => !/^#\s*placeholders:/i.test(line))
    .map((line) => {
      if (!line.startsWith('#')) return line;
      if (M7_HEADER_LINE_RE.test(line)) return line; // keep M7 fields verbatim
      if (line.length <= MAX_PROSE_LINE_LENGTH + 2) return line; // 2 == '# ' prefix
      return line.slice(0, MAX_PROSE_LINE_LENGTH + 2 - 3) + '...';
    });
  return joinFlowYaml({ ...parts, topSection: newTop, m7HeaderAndProse: newHeader });
}

/** Read the first uppercase-only `${VAR}` placeholder names in the YAML body. */
export function extractPlaceholders(text: string): string[] {
  const seen = new Set<string>();
  const iter = text.matchAll(PLACEHOLDER_RE);
  for (const m of iter) {
    seen.add(m[1]);
  }
  return [...seen].sort();
}

/** Pull the `id` from a flow's M7 header. Returns null when missing. */
export function extractActionId(text: string): string | null {
  const parts = splitFlowYaml(text);
  for (const line of parts.m7HeaderAndProse) {
    const m = line.match(/^#\s*id:\s*(.+)$/);
    if (m) {
      const id = m[1].trim();
      if (/^[A-Za-z0-9_-]+$/.test(id)) return id;
    }
  }
  return null;
}

/**
 * Restore an anonymized flow YAML for import:
 *   - rewrite `appId:` from `com.example.<slug>` to the local project's
 *     actual appId
 *   - force `# status: <anything>` to `# status: experimental` so the
 *     imported flow can't claim active status before a local replay
 *     proves it works
 *   - if `${VAR}` placeholders exist, prepend a `# placeholders: …`
 *     comment so the user sees what `-e KEY=VAL` args to supply at replay
 */
export function restoreFlowYaml(text: string, localAppId: string): string {
  const parts = splitFlowYaml(text);
  if (!parts.hasSeparator) {
    throw new Error('FlowBundleError: flow YAML missing --- separator');
  }
  const newTop = rewriteAppIdLine(parts.topSection, localAppId);
  // Multi-review fix (Codex 92 + Gemini 95): drop any existing
  // `# placeholders:` line BEFORE we decide to prepend a fresh one, so a
  // file imported multiple times (manual re-import, or a renamed
  // `.imported.yaml` that was promoted to the canonical name) doesn't
  // stack duplicate manifest comments.
  const newHeader = parts.m7HeaderAndProse
    .filter((line) => !/^#\s*placeholders:/i.test(line))
    .map((line) => {
      const m = line.match(STATUS_LINE_RE);
      if (m) return `${m[1]}experimental`;
      return line;
    });
  const placeholders = extractPlaceholders(parts.body.join('\n'));
  let header = newHeader;
  if (placeholders.length > 0) {
    const manifest = `# placeholders: ${placeholders.join(', ')} — supply via -e KEY=VALUE on replay`;
    header = [manifest, ...newHeader];
  }
  return joinFlowYaml({ ...parts, topSection: newTop, m7HeaderAndProse: header });
}

// ── skeleton helpers ────────────────────────────────────────────────────
//
// Skeleton uses a structured YAML where `appId:` lives at top-level (not
// inside a topSection-before-`---` block). Same rewrite logic via a
// line-wise scan over the full document.

function rewriteSkeletonAppId(text: string, newAppId: string): string {
  const lines = text.split('\n');
  let foundIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (APPID_LINE_RE.test(lines[i])) {
      foundIdx = i;
      break;
    }
  }
  if (foundIdx < 0) {
    throw new Error('FlowBundleError: skeleton missing appId: field');
  }
  lines[foundIdx] = `appId: ${newAppId}`;
  return lines.join('\n');
}

export function anonymizeSkeleton(text: string): string {
  const lines = text.split('\n');
  const m = lines.map((l) => l.match(APPID_LINE_RE)).find((x) => x !== null);
  if (!m) throw new Error('FlowBundleError: skeleton missing appId: field');
  const slug = sanitizeAppIdSlug(m[1].trim());
  return rewriteSkeletonAppId(text, `com.example.${slug}`);
}

export function restoreSkeleton(text: string, localAppId: string): string {
  return rewriteSkeletonAppId(text, localAppId);
}

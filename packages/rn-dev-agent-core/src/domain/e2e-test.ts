import { dirname, join } from 'node:path';
import {
  mkdirSync,
  writeFileSync,
  renameSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { assertValidActionId, assertWithinDir } from './path-safety.js';

export interface LockedE2eTest {
  id: string;
  intent: string;
  sourceActionId: string;
  lockedAt: string;
  lockedGitSha: string | null;
  sourceContentHash: string;
  status: 'locked';
  params?: string[];
  appId?: string;
  flow: string;
  filePath: string;
}

const FLOW_SENTINEL = '# e2e-locked-flow-below';

export function e2eDirFor(projectRoot: string): string {
  return join(projectRoot, '.rn-agent', 'e2e');
}

export function e2ePathFor(projectRoot: string, id: string): string {
  assertValidActionId(id, 'e2ePathFor');
  const dir = e2eDirFor(projectRoot);
  const file = join(dir, `${id}.yaml`);
  assertWithinDir(file, dir);
  return file;
}

export function serializeLockedTest(meta: Omit<LockedE2eTest, 'filePath'>): string {
  const header = [
    '# e2e-locked-test: true',
    `# id: ${meta.id}`,
    `# intent: ${meta.intent}`,
    `# sourceActionId: ${meta.sourceActionId}`,
    `# lockedAt: ${meta.lockedAt}`,
    `# lockedGitSha: ${meta.lockedGitSha ?? ''}`,
    `# sourceContentHash: ${meta.sourceContentHash}`,
    '# status: locked',
  ];
  if (meta.appId) header.push(`# appId: ${meta.appId}`);
  if (meta.params?.length) header.push(`# params: ${meta.params.join(', ')}`);
  header.push(FLOW_SENTINEL);
  return `${header.join('\n')}\n${meta.flow}`;
}

export function hashBody(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export interface LockSource {
  id: string;
  intent: string;
  sourceActionId: string;
  flow: string;
  params?: string[];
  appId?: string;
}

export function freezeLockedTest(
  projectRoot: string,
  source: LockSource,
  ctx: { gitSha: string | null; now: () => Date },
): LockedE2eTest {
  const filePath = e2ePathFor(projectRoot, source.id);
  mkdirSync(dirname(filePath), { recursive: true });
  const meta: Omit<LockedE2eTest, 'filePath'> = {
    id: source.id,
    intent: source.intent,
    sourceActionId: source.sourceActionId,
    lockedAt: ctx.now().toISOString(),
    lockedGitSha: ctx.gitSha,
    sourceContentHash: hashBody(source.flow),
    status: 'locked',
    params: source.params,
    appId: source.appId,
    flow: source.flow,
  };
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, serializeLockedTest(meta), 'utf8');
  renameSync(tmp, filePath);
  return { ...meta, filePath };
}

export function loadLockedTest(projectRoot: string, id: string): LockedE2eTest | null {
  const filePath = e2ePathFor(projectRoot, id);
  if (!existsSync(filePath)) return null;
  const locked = parseLockedTest(readFileSync(filePath, 'utf8'), filePath);
  return locked?.id === id ? locked : null;
}

export function lockedTestFileExists(projectRoot: string, id: string): boolean {
  return existsSync(e2ePathFor(projectRoot, id));
}

export function discoverLockedTests(projectRoot: string): string[] {
  const dir = e2eDirFor(projectRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.replace(/\.yaml$/, ''))
    .sort();
}

export function resolveLockedTestIds(
  projectRoot: string,
  pattern?: string,
  discover: (root: string) => string[] = discoverLockedTests,
): string[] {
  const ids = discover(projectRoot);
  if (!pattern || pattern.length > 256) return ids;
  try {
    const matcher = new RegExp(pattern, 'i');
    return ids.filter((id) => matcher.test(id));
  } catch {
    return ids;
  }
}

export interface ResolvedLockedTestSelection {
  ids: string[];
  identitiesValid: boolean;
}

export function resolveLockedTestSelection(
  projectRoot: string,
  pattern?: string,
  discover: (root: string) => string[] = discoverLockedTests,
  load: (root: string, id: string) => LockedE2eTest | null = loadLockedTest,
): ResolvedLockedTestSelection {
  const ids = resolveLockedTestIds(projectRoot, pattern, discover);
  const identitiesValid = ids.every((id) => {
    const locked = load(projectRoot, id);
    return locked?.id === id && locked.sourceActionId === id;
  });
  return { ids, identitiesValid };
}

const resolvedLockedTestIds = Symbol('resolvedLockedTestIds');

type ResolvedLockedTestArgs = Record<string | symbol, unknown> & {
  [resolvedLockedTestIds]?: readonly string[];
};

export function setResolvedLockedTestIds(args: object, ids: readonly string[]): void {
  Object.defineProperty(args, resolvedLockedTestIds, {
    value: Object.freeze([...ids]),
    configurable: true,
  });
}

export function getResolvedLockedTestIds(args: object): readonly string[] | undefined {
  return (args as ResolvedLockedTestArgs)[resolvedLockedTestIds];
}

export function parseLockedTest(text: string, filePath: string): LockedE2eTest | null {
  if (!/^#\s*e2e-locked-test:\s*true\s*$/m.test(text)) return null;
  const sentinelIdx = text.indexOf(FLOW_SENTINEL);
  if (sentinelIdx < 0) return null;
  const headerText = text.slice(0, sentinelIdx);
  const flowStart = text.indexOf('\n', sentinelIdx);
  const flow = flowStart >= 0 ? text.slice(flowStart + 1) : '';
  const field = (k: string): string | undefined => {
    const m = headerText.match(new RegExp(`^#\\s*${k}:\\s*(.*)$`, 'm'));
    const v = m?.[1]?.trim();
    return v ? v : undefined;
  };
  const id = field('id');
  const intent = field('intent');
  if (!id || !intent) return null;
  const paramsRaw = field('params');
  return {
    id,
    intent,
    sourceActionId: field('sourceActionId') ?? id,
    lockedAt: field('lockedAt') ?? '',
    lockedGitSha: field('lockedGitSha') ?? null,
    sourceContentHash: field('sourceContentHash') ?? '',
    status: 'locked',
    params: paramsRaw
      ? paramsRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    appId: field('appId'),
    flow,
    filePath,
  };
}

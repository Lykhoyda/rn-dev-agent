import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync, existsSync, } from 'node:fs';
import { createHash } from 'node:crypto';
import { assertValidActionId, assertWithinDir } from './path-safety.js';
const FLOW_SENTINEL = '# e2e-locked-flow-below';
export function e2eDirFor(projectRoot) {
    return join(projectRoot, '.rn-agent', 'e2e');
}
export function e2ePathFor(projectRoot, id) {
    assertValidActionId(id, 'e2ePathFor');
    const dir = e2eDirFor(projectRoot);
    const file = join(dir, `${id}.yaml`);
    assertWithinDir(file, dir);
    return file;
}
export function serializeLockedTest(meta) {
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
    if (meta.appId)
        header.push(`# appId: ${meta.appId}`);
    if (meta.params?.length)
        header.push(`# params: ${meta.params.join(', ')}`);
    header.push(FLOW_SENTINEL);
    return `${header.join('\n')}\n${meta.flow}`;
}
export function hashBody(s) {
    return createHash('sha256').update(s).digest('hex');
}
export function freezeLockedTest(projectRoot, source, ctx) {
    const filePath = e2ePathFor(projectRoot, source.id);
    mkdirSync(dirname(filePath), { recursive: true });
    const meta = {
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
export function loadLockedTest(projectRoot, id) {
    const filePath = e2ePathFor(projectRoot, id);
    if (!existsSync(filePath))
        return null;
    const locked = parseLockedTest(readFileSync(filePath, 'utf8'), filePath);
    return locked?.id === id ? locked : null;
}
export function discoverLockedTests(projectRoot) {
    const dir = e2eDirFor(projectRoot);
    if (!existsSync(dir))
        return [];
    return readdirSync(dir)
        .filter((f) => f.endsWith('.yaml'))
        .map((f) => f.replace(/\.yaml$/, ''))
        .sort();
}
export function resolveLockedTestIds(projectRoot, pattern, discover = discoverLockedTests) {
    const ids = discover(projectRoot);
    if (!pattern || pattern.length > 256)
        return ids;
    try {
        const matcher = new RegExp(pattern, 'i');
        return ids.filter((id) => matcher.test(id));
    }
    catch {
        return ids;
    }
}
export function resolveLockedTestIdentityIds(projectRoot, pattern, discover = discoverLockedTests, load = loadLockedTest) {
    return resolveLockedTestIds(projectRoot, pattern, discover).filter((id) => {
        const locked = load(projectRoot, id);
        return locked?.id === id && locked.sourceActionId === id;
    });
}
const resolvedLockedTestIds = Symbol('resolvedLockedTestIds');
export function setResolvedLockedTestIds(args, ids) {
    Object.defineProperty(args, resolvedLockedTestIds, {
        value: Object.freeze([...ids]),
        configurable: true,
    });
}
export function getResolvedLockedTestIds(args) {
    return args[resolvedLockedTestIds];
}
export function parseLockedTest(text, filePath) {
    if (!/^#\s*e2e-locked-test:\s*true\s*$/m.test(text))
        return null;
    const sentinelIdx = text.indexOf(FLOW_SENTINEL);
    if (sentinelIdx < 0)
        return null;
    const headerText = text.slice(0, sentinelIdx);
    const flowStart = text.indexOf('\n', sentinelIdx);
    const flow = flowStart >= 0 ? text.slice(flowStart + 1) : '';
    const field = (k) => {
        const m = headerText.match(new RegExp(`^#\\s*${k}:\\s*(.*)$`, 'm'));
        const v = m?.[1]?.trim();
        return v ? v : undefined;
    };
    const id = field('id');
    const intent = field('intent');
    if (!id || !intent)
        return null;
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

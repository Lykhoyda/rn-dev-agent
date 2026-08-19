// The runner trust root (runner-manifest.json) rotted at v0.75.2 while releases
// shipped through v0.76.7: the publish job pushed a [skip ci] commit straight to
// a protected main (GH006, "Build & Test" is expected) and the detect gate keyed
// only on release-asset presence, so the never-landed manifest was never retried
// and every later run reported success. These tests pin both halves of the fix.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  decideRunnerPublication,
  expectedRunnerAssets,
  manifestBranchName,
} from '../../../../scripts/runner-manifest-publication.mts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const workflowPath = join(repoRoot, '.github', 'workflows', 'runner-artifacts.yml');

type WorkflowStep = {
  name?: string;
  id?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
};
type WorkflowJob = {
  if?: string;
  needs?: string[];
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps: WorkflowStep[];
};
type Workflow = { concurrency: string; jobs: Record<string, WorkflowJob> };

const workflow = parse(readFileSync(workflowPath, 'utf8')) as Workflow;

function steps(jobId: string): WorkflowStep[] {
  return workflow.jobs[jobId].steps ?? [];
}

function jobScript(jobId: string): string {
  return steps(jobId)
    .map((s) => s.run ?? '')
    .join('\n');
}

function everyStep(): Array<{ jobId: string; step: WorkflowStep }> {
  return Object.entries(workflow.jobs).flatMap(([jobId, job]) =>
    (job.steps ?? []).map((step) => ({ jobId, step })),
  );
}

const COMPLETE_RELEASE = [
  'rn-fast-runner-0.76.7-sim.zip',
  'rn-android-runner-0.76.7.zip',
  'runner-manifest.json',
];

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
    pluginVersion: '0.76.7',
    releaseAssets: COMPLETE_RELEASE,
    repoManifest: manifestFor('0.75.2'),
    publishedManifest: manifestFor('0.76.7'),
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
  const current = manifestFor('0.76.7');
  const decision = decideRunnerPublication({
    pluginVersion: '0.76.7',
    releaseAssets: COMPLETE_RELEASE,
    repoManifest: current,
    publishedManifest: current,
  });
  assert.equal(decision.publishManifest, false);
  assert.equal(decision.buildRunners, false);
});

test('property order never decides publication', () => {
  const ordered = JSON.stringify({
    version: '0.76.7',
    assets: { ios: [{ name: 'x', sha256: 'y', bytes: 1 }], android: [] },
  });
  const reordered = JSON.stringify({
    assets: { android: [], ios: [{ bytes: 1, sha256: 'y', name: 'x' }] },
    version: '0.76.7',
  });
  const decision = decideRunnerPublication({
    pluginVersion: '0.76.7',
    releaseAssets: COMPLETE_RELEASE,
    repoManifest: ordered,
    publishedManifest: reordered,
  });
  assert.equal(decision.publishManifest, false, 'reordered keys would re-open a PR every sweep');
});

test('same version but drifted digests counts as stale', () => {
  const decision = decideRunnerPublication({
    pluginVersion: '0.76.7',
    releaseAssets: COMPLETE_RELEASE,
    repoManifest: manifestFor('0.76.7', 'b'.repeat(64)),
    publishedManifest: manifestFor('0.76.7', 'c'.repeat(64)),
  });
  assert.equal(decision.publishManifest, true);
});

test('a missing or unparseable in-repo manifest is stale, never assumed current', () => {
  for (const repoManifest of [null, '', 'not json', '[]']) {
    const decision = decideRunnerPublication({
      pluginVersion: '0.76.7',
      releaseAssets: COMPLETE_RELEASE,
      repoManifest,
      publishedManifest: manifestFor('0.76.7'),
    });
    assert.equal(decision.publishManifest, true, `repoManifest=${JSON.stringify(repoManifest)}`);
  }
});

test('a release missing a runner zip rebuilds and republishes', () => {
  const decision = decideRunnerPublication({
    pluginVersion: '0.76.7',
    releaseAssets: ['rn-fast-runner-0.76.7-sim.zip'],
    repoManifest: manifestFor('0.76.7'),
    publishedManifest: manifestFor('0.76.7'),
  });
  assert.equal(decision.buildRunners, true);
  assert.equal(decision.publishManifest, true);
});

test('a release with both zips but no published manifest asset republishes', () => {
  const decision = decideRunnerPublication({
    pluginVersion: '0.76.7',
    releaseAssets: ['rn-fast-runner-0.76.7-sim.zip', 'rn-android-runner-0.76.7.zip'],
    repoManifest: manifestFor('0.76.7'),
    publishedManifest: null,
  });
  assert.equal(decision.buildRunners, false);
  assert.equal(decision.publishManifest, true);
});

// --- the trust root may only ever track the installed plugin version ---

test('force_version re-publishes the current version, skipping the missing-assets check', () => {
  const current = manifestFor('0.76.7');
  const decision = decideRunnerPublication({
    pluginVersion: '0.76.7',
    forceVersion: '0.76.7',
    releaseAssets: COMPLETE_RELEASE,
    repoManifest: current,
    publishedManifest: current,
  });
  assert.equal(decision.version, '0.76.7');
  assert.equal(decision.buildRunners, true);
  assert.equal(decision.publishManifest, true);
});

test('a historical force_version is refused instead of downgrading the trust root', () => {
  const current = manifestFor('0.76.7');
  assert.throws(
    () =>
      decideRunnerPublication({
        pluginVersion: '0.76.7',
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
          pluginVersion: '0.76.7',
          forceVersion: bad,
          releaseAssets: COMPLETE_RELEASE,
          repoManifest: manifestFor('0.76.7'),
        }),
      /not a release version|does not match the current plugin version/,
      `accepted force_version ${JSON.stringify(bad)}`,
    );
  }
  assert.throws(() => manifestBranchName('main; echo'), /not a release version/);
  assert.throws(() => manifestBranchName('1.2.3-alpha..1'), /not a release version/);
});

// --- rerun / idempotency ---

test('the manifest branch is a pure function of the version, so reruns converge', () => {
  assert.equal(manifestBranchName('0.76.7'), 'chore/runner-manifest-v0.76.7');
  assert.equal(manifestBranchName('0.76.7'), manifestBranchName('0.76.7'));
  assert.notEqual(manifestBranchName('0.76.7'), manifestBranchName('0.76.8'));
  const decision = decideRunnerPublication({
    pluginVersion: '0.76.7',
    releaseAssets: COMPLETE_RELEASE,
    repoManifest: manifestFor('0.75.2'),
    publishedManifest: manifestFor('0.76.7'),
  });
  assert.equal(decision.branch, manifestBranchName('0.76.7'));
});

test('expected release asset names stay pinned to the client download contract', () => {
  assert.deepEqual(expectedRunnerAssets('0.76.7'), {
    ios: 'rn-fast-runner-0.76.7-sim.zip',
    android: 'rn-android-runner-0.76.7.zip',
    manifest: 'runner-manifest.json',
  });
});

test('the publish job creates a PR only when no open one exists for the branch', () => {
  const script = jobScript('publish-manifest');
  const listIndex = script.indexOf('gh pr list --head');
  const createIndex = script.indexOf('gh pr create');
  assert.ok(listIndex !== -1, 'must look up an existing PR for the manifest branch');
  assert.ok(createIndex !== -1, 'must be able to open the manifest PR');
  assert.ok(listIndex < createIndex, 'the lookup must precede creation');
  // Order alone would still allow an unconditional create, and so would an `if`
  // that closes before it. Creation must be the ONLY one, and inside the guard.
  assert.equal(
    (script.match(/gh pr create/g) ?? []).length,
    1,
    'exactly one creation path, or a rerun could stack duplicate PRs',
  );
  const guard = script.match(/if \[ -z "\$PR" \]; then\n([\s\S]*?)\n\s*fi\b/);
  assert.ok(guard, 'creation must be guarded by an empty existing-PR result');
  assert.match(guard[1], /gh pr create/, 'the guard must be the block that creates the PR');
  assert.match(
    script,
    /git diff --cached --quiet/,
    'an unchanged manifest must not produce a commit',
  );
});

test('a manifest PR from an earlier version is retired, never left to race this one', () => {
  const script = jobScript('publish-manifest');
  assert.match(
    script,
    /\[ "\$ref" != "\$BRANCH" \]/,
    'the current branch must be excluded in shell, not in a --jq filter that could misfire',
  );
  assert.match(script, /gh pr list --state open --limit \d+/, 'must outrun the 30-PR default page');
  const closes = script
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('gh pr close'));
  assert.equal(closes.length, 1, 'a superseded manifest PR must not stay open');
  // A superseded PR may already have auto-merge armed, so a swallowed close
  // failure would let it land after this one and restore a stale trust root.
  assert.doesNotMatch(closes[0], /\|\|/, 'closing a superseded PR must be fatal, not best-effort');
});

test('every expected release upload is present and clobber-idempotent', () => {
  const expected: Record<string, string[]> = {
    'build-ios': ['gh release upload "v$VERSION" "rn-fast-runner-$VERSION-sim.zip" --clobber'],
    'build-android': ['gh release upload "v$VERSION" "rn-android-runner-$VERSION.zip" --clobber'],
    'publish-manifest': ['gh release upload "v$VERSION" runner-manifest.json --clobber'],
  };
  for (const [jobId, commands] of Object.entries(expected)) {
    const uploads = jobScript(jobId)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes('gh release upload'));
    assert.deepEqual(uploads, commands, `${jobId} must publish exactly its own asset`);
  }
});

// --- protected-branch delivery path ---

test('every push targets the version-derived manifest branch, never a default-branch ref', () => {
  const pushes = everyStep().flatMap(({ jobId, step }) =>
    (step.run ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^git push\b/.test(l))
      .map((line) => ({ jobId, line })),
  );
  assert.ok(pushes.length > 0, 'the manifest has to be pushed somewhere');
  // Allowlist, not blacklist: `git push origin HEAD` while checked out on main
  // writes to the default branch just as surely as naming it. Only two shapes are
  // permitted — writing the manifest branch, and deleting a superseded one.
  const write = /^git push origin "\$BRANCH"$/;
  const del = /^git push origin --delete "\$ref"(?: \|\| .*)?$/;
  for (const { jobId, line } of pushes) {
    assert.ok(write.test(line) || del.test(line), `${jobId} pushes somewhere unexpected: ${line}`);
  }
  assert.ok(
    pushes.some(({ line }) => write.test(line)),
    'the manifest branch must be pushed',
  );
});

test('no executable line carries a CI-skip marker', () => {
  const skip = /\[\s*(?:skip[ -](?:ci|actions)|ci[ -]skip)\s*\]|skip-checks\s*:\s*true/i;
  for (const { jobId, step } of everyStep()) {
    // Prose explaining the rule is fine; a command carrying the marker is not.
    const executable = (step.run ?? '')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    assert.doesNotMatch(
      executable,
      skip,
      `${jobId} / ${step.name}: a commit that skips CI can never produce the required "Build & Test" check`,
    );
  }
});

test('the publish job is permitted to open a pull request', () => {
  const permissions = workflow.jobs['publish-manifest'].permissions ?? {};
  assert.equal(permissions['pull-requests'], 'write');
  assert.equal(permissions.contents, 'write');
});

test('the manifest reaches main through a PR gated by required checks', () => {
  const script = jobScript('publish-manifest');
  assert.match(script, /gh pr create --base main --head "\$BRANCH"/);
  // EVERY merge invocation must defer to auto-merge; a second, unguarded
  // `gh pr merge` alongside it would land the PR without the required check.
  const merges = script
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('gh pr merge'));
  assert.ok(merges.length > 0, 'the manifest PR has to be merged somehow');
  for (const merge of merges) {
    assert.match(merge, /--auto\b/, `merge bypasses the required check: ${merge}`);
    assert.doesNotMatch(merge, /--admin\b/, `merge uses an admin override: ${merge}`);
  }
});

test('the publish job refuses a trust root the installed plugin cannot use', () => {
  const script = jobScript('publish-manifest');
  assert.match(script, /jq -r '\.version' packages\/claude-plugin\/plugin\.json/);
  assert.match(script, /if \[ "\$VERSION" != "\$PLUGIN" \]; then/);
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

test('detect feeds the in-repo trust root into the publication decision', () => {
  const script = jobScript('detect');
  assert.match(script, /scripts\/runner-manifest-publication\.mts/);
  assert.match(script, /--repo-manifest runner-manifest\.json/);
  assert.match(script, /--published-manifest published-manifest\.json/);
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

test('manifest generation and its host-plugin copies are unchanged', () => {
  const script = jobScript('publish-manifest');
  assert.match(script, /scripts\/build-runner-manifest\.mts/);
  assert.match(script, /cp runner-manifest\.json packages\/codex-plugin\/runner-manifest\.json/);
  assert.match(script, /cp runner-manifest\.json packages\/claude-plugin\/runner-manifest\.json/);
});

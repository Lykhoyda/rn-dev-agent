// GH #437 (test-confidence audit P0-B): contract tests over CAPTURED golden
// runner payloads. The escaped-bug cluster this closes — #396 (envelope test
// pinned the buggy `@@` passthrough), #353 (oracle tests fed bare nodes
// instead of the real `.tree`-wrapped payload), #418 (command-enum additions
// invisible to the protocol gate) — was hand-written fixtures encoding the
// WRONG wire shape. These fixtures are captured from live runners by
// test/contract/capture-goldens.ts; the `v`-stamp test below forces a
// re-capture whenever RUNNER_PROTOCOL_VERSION bumps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_IOS_COMMANDS,
  REQUIRED_ANDROID_COMMANDS,
  RUNNER_PROTOCOL_VERSION,
  classifyRunnerCompatibility,
} from '../../dist/runners/protocol.js';
import { findRefByTestID, snapshotEnvelopeFailed } from '../../dist/tools/device-batch.js';
import { updateRefMapFromFlat, buildSnapshotVerdict } from '../../dist/fast-runner-ref-map.js';

const GOLDENS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'goldens');

interface Golden {
  _provenance: {
    capturedAt?: string;
    capturedBy?: string;
    platform?: string;
    runnerVersion?: string;
    protocolVersion?: number;
  };
  payload: any;
}

interface HealthPayload {
  ok?: boolean;
  protocolVersion?: number;
  runnerVersion?: string;
  commands?: string[];
}

function loadGolden(platform: string, name: string): Golden {
  const path = join(GOLDENS_DIR, platform, name);
  return JSON.parse(readFileSync(path, 'utf8')) as Golden;
}

const PLATFORMS = [
  { platform: 'ios', required: REQUIRED_IOS_COMMANDS, source: 'rn-fast-runner' },
  { platform: 'android', required: REQUIRED_ANDROID_COMMANDS, source: 'rn-android-runner' },
] as const;

const GOLDEN_NAMES = [
  'health.json',
  'command-snapshot.json',
  'command-error.json',
  'tool-envelope-snapshot.json',
];

// Anchors the whole suite: identifiers the contract fixture app is REQUIRED
// to expose (test-fixtures/*/README.md golden-set roles).
const FIXTURE_TESTIDS = ['fixture_button', 'fixture_count', 'fixture_input'];

for (const { platform, required, source } of PLATFORMS) {
  test(`gh-437 ${platform}: goldens carry capture provenance, never hand-written`, () => {
    for (const name of GOLDEN_NAMES) {
      const g = loadGolden(platform, name);
      assert.ok(g._provenance, `${name} missing _provenance — goldens must be captured`);
      assert.ok(g._provenance.capturedAt, `${name} missing _provenance.capturedAt`);
      assert.match(
        g._provenance.capturedBy ?? '',
        /capture-goldens/,
        `${name} not stamped by the capture script`,
      );
      assert.equal(g._provenance.platform, platform);
      assert.ok(g.payload !== undefined, `${name} missing payload`);
    }
  });

  test(`gh-437 ${platform}: captured /health classifies as compatible`, () => {
    const health = loadGolden(platform, 'health.json').payload as HealthPayload;
    const verdict = classifyRunnerCompatibility(health, null, required);
    assert.deepEqual(
      verdict,
      { compatible: true },
      `captured ${platform} health must satisfy the liveness gate: ${JSON.stringify(verdict)}`,
    );
  });

  test(`gh-437 ${platform}: captured /health advertises every REQUIRED command`, () => {
    const health = loadGolden(platform, 'health.json').payload as HealthPayload;
    const advertised = new Set(health.commands ?? []);
    const missing = required.filter((c) => !advertised.has(c));
    assert.deepEqual(
      missing,
      [],
      `${platform} runner artifact does not advertise: ${missing.join(', ')}`,
    );
  });

  test(`gh-437 ${platform}: classifier rejections derive correctly from the real payload`, () => {
    const health = loadGolden(platform, 'health.json').payload as HealthPayload;

    const legacy = classifyRunnerCompatibility({ ...health, protocolVersion: undefined }, null);
    assert.deepEqual(legacy, { compatible: false, reason: 'legacy' });

    const newer = classifyRunnerCompatibility(
      { ...health, protocolVersion: RUNNER_PROTOCOL_VERSION + 1 },
      null,
    );
    assert.deepEqual(newer, { compatible: false, reason: 'protocol-newer' });

    const [firstRequired] = required;
    const gutted = classifyRunnerCompatibility(
      { ...health, commands: (health.commands ?? []).filter((c) => c !== firstRequired) },
      null,
      required,
    );
    assert.deepEqual(gutted, {
      compatible: false,
      reason: 'missing-commands',
      missing: [firstRequired],
    });

    assert.ok(health.runnerVersion, `${platform} health golden must carry runnerVersion`);
    const skew = classifyRunnerCompatibility(health, `${health.runnerVersion}-not`);
    assert.deepEqual(skew, { compatible: false, reason: 'version-skew' });
  });

  test(`gh-437 ${platform}: raw snapshot wire stamp matches RUNNER_PROTOCOL_VERSION`, () => {
    const snap = loadGolden(platform, 'command-snapshot.json').payload;
    assert.equal(
      snap.v,
      RUNNER_PROTOCOL_VERSION,
      `golden captured at wire v${snap.v}, bridge now speaks v${RUNNER_PROTOCOL_VERSION} — ` +
        're-capture the goldens against the current runner (see capture-goldens.ts header)',
    );
  });

  test(`gh-437 ${platform}: raw snapshot carries a well-formed node array`, () => {
    const snap = loadGolden(platform, 'command-snapshot.json').payload;
    assert.equal(snap.ok, true);
    assert.ok(Array.isArray(snap.data?.nodes), 'raw snapshot data.nodes must be an array');
    assert.ok(snap.data.nodes.length > 0, 'raw snapshot must not be empty');
    for (const node of snap.data.nodes) {
      if (node.rect === undefined) continue;
      for (const k of ['x', 'y', 'width', 'height']) {
        assert.equal(
          typeof node.rect[k],
          'number',
          `node rect.${k} must be numeric: ${JSON.stringify(node).slice(0, 200)}`,
        );
      }
    }
    const identifiers = new Set(
      snap.data.nodes.map((n: { identifier?: string }) => n.identifier).filter(Boolean),
    );
    for (const id of FIXTURE_TESTIDS) {
      assert.ok(identifiers.has(id), `raw ${platform} snapshot missing fixture testID ${id}`);
    }
  });

  test(`gh-437 ${platform}: captured error envelope keeps the error contract`, () => {
    const err = loadGolden(platform, 'command-error.json').payload;
    assert.equal(err.ok, false, 'unknown verb must produce ok:false');
    assert.equal(typeof err.error?.message, 'string');
    assert.ok(err.error.message.length > 0, 'error.message must be non-empty');
    if (err.v !== undefined) assert.equal(err.v, RUNNER_PROTOCOL_VERSION);
  });

  test(`gh-437 ${platform}: findRefByTestID resolves fixture testIDs from the tool envelope`, () => {
    const envelope = loadGolden(platform, 'tool-envelope-snapshot.json').payload;
    const text = JSON.stringify(envelope);
    assert.equal(snapshotEnvelopeFailed(text), false);
    for (const id of FIXTURE_TESTIDS) {
      const ref = findRefByTestID(text, id);
      assert.ok(ref, `findRefByTestID(${id}) resolved nothing on ${platform}`);
      // GH #396 regression contract: bare id, never a passed-through '@'.
      assert.match(ref, /^e\d+$/, `ref must be bare (no @): got "${ref}"`);
    }
  });

  test(`gh-437 ${platform}: tool-envelope nodes drive the ref-map oracle to an ok verdict`, () => {
    const envelope = loadGolden(platform, 'tool-envelope-snapshot.json').payload;
    const nodes = envelope.data?.nodes;
    assert.ok(Array.isArray(nodes) && nodes.length > 0, 'tool envelope must carry nodes');
    for (const node of nodes) {
      assert.match(node.ref ?? '', /^@e\d+$/, `envelope ref malformed: ${JSON.stringify(node)}`);
    }
    const outcome = updateRefMapFromFlat(nodes);
    assert.equal(outcome.applied, true, `real capture must update the ref map: ${outcome.reason}`);
    const verdict = buildSnapshotVerdict(source, nodes.length, outcome);
    assert.equal(verdict.state, 'ok');
    assert.equal(verdict.refMapUpdated, true);
  });
}

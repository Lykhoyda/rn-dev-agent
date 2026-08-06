// F3: the agent-facing surface had no ownership-recovery vocabulary at all, so the
// entry-point skill's own failure table sent agents into a refusal with no way out.
// This pins the propagation: one canonical wording owner, pointers everywhere else,
// and every replay/readiness instruction reads blocked state before acting.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const TREES = [
  'packages/shared-agent-knowledge',
  'packages/claude-plugin',
  'packages/codex-plugin',
] as const;

// The anchor files the agent hits, in journey order.
const ANCHORS = [
  'skills/using-rn-dev-agent/SKILL.md',
  'skills/creating-actions/SKILL.md',
  'commands/run-action.md',
  'commands/check-env.md',
  'commands/list-learned-actions.md',
] as const;

function read(tree: string, file: string): string {
  return readFileSync(join(root, tree, file), 'utf8');
}

/** Prose is hard-wrapped differently per host; match on the unwrapped text. */
function prose(tree: string, file: string): string {
  return read(tree, file).replace(/\s+/g, ' ');
}

test('F3: every host tree names the recovery surface an agent must read before replay', () => {
  for (const tree of TREES) {
    for (const anchor of ANCHORS) {
      const body = read(tree, anchor);
      assert.match(body, /recoveryRequirement/, `${tree}/${anchor} must name recoveryRequirement`);
      assert.match(
        body,
        /rn_session\(\{?\s*action:?\s*=?\s*"status"/,
        `${tree}/${anchor} must route to the one reachable action`,
      );
    }
  }
});

test('F3: the canonical ownership-recovery wording has exactly one owner per tree', () => {
  for (const tree of TREES) {
    const router = read(tree, 'skills/using-rn-dev-agent/SKILL.md');
    assert.match(router, /## Session ownership recovery — `SESSION_AUTHORITY_REQUIRED`/);
    assert.match(router, /Canonical wording for ownership recovery lives here/);
    // The three measured requirements, and the retained startup-cleanup blocker.
    for (const token of ['transport-restart', 'attach', 'adoption', 'startupCleanupBlocked']) {
      assert.match(router, new RegExp(token), `${tree} router must name ${token}`);
    }
    // The other anchors point at it rather than restating the contract.
    for (const anchor of ANCHORS.slice(1)) {
      const body = prose(tree, anchor);
      assert.match(
        body,
        /Session ownership recovery/,
        `${tree}/${anchor} must defer to the canonical section`,
      );
      assert.doesNotMatch(
        body,
        /Canonical wording for ownership recovery lives here/,
        `${tree}/${anchor} must not duplicate the canonical wording`,
      );
    }
  }
});

test('F3: the artifact-first replay instruction names cdp_run_action, never raw maestro_run', () => {
  for (const tree of TREES) {
    const router = read(tree, 'skills/using-rn-dev-agent/SKILL.md');
    const replayRow = router
      .split('\n')
      .find((line) => line.includes('Manual `device_*` walk for a flow that already exists'));
    assert.ok(replayRow, `${tree} router keeps the artifact-first failure row`);
    assert.match(replayRow, /replay matching flows via `cdp_run_action`/);
    assert.match(replayRow, /not raw `maestro_run`/);

    // G1 ↔ creating-actions no longer contradict each other.
    assert.match(
      read(tree, 'skills/creating-actions/SKILL.md'),
      /Replay through the orchestrator — not raw `maestro_run`/,
    );
    assert.match(prose(tree, 'commands/list-learned-actions.md'), /via `cdp_run_action`/);
  }
});

test('F3: readiness, replay, and setup guidance stop on blocked instead of binding around it', () => {
  for (const tree of TREES) {
    // Readiness reads session ownership before cdp_status.
    const router = read(tree, 'skills/using-rn-dev-agent/SKILL.md');
    const checklist = router.slice(router.indexOf('## Verification — Session Ready When'));
    const boxes = checklist.split('\n').filter((line) => line.startsWith('- [ ]'));
    assert.match(boxes[0], /state: blocked/, `${tree}: ownership is the first readiness check`);
    assert.match(router, /Never bind around a blocker/);
    assert.match(router, /grants no replay authority/);

    // Replay stops before acting.
    assert.match(
      prose(tree, 'commands/run-action.md'),
      /If `state` is `blocked`, stop before replaying/,
      `${tree}: run-action must not replay from a blocked session`,
    );

    // The remedy table no longer prescribes setup/bind for a blocked session.
    const checkEnv = read(tree, 'commands/check-env.md');
    const blockedRow = checkEnv
      .split('\n')
      .find((line) => line.includes('Session `state: blocked`'));
    assert.ok(blockedRow, `${tree}: check-env has a dedicated blocked row`);
    assert.match(blockedRow, /do not run setup, do not bind a device/);

    // Discovery grants nothing.
    assert.match(
      prose(tree, 'commands/list-learned-actions.md'),
      /read-only discovery and grants no replay authority/,
    );

    // An ownership refusal is not a repairable replay failure.
    assert.match(
      prose(tree, 'skills/creating-actions/SKILL.md'),
      /`SESSION_AUTHORITY_REQUIRED` is not UI drift/,
    );
  }
});

test('F3: Codex adaptations stay free of Claude-only syntax', () => {
  for (const anchor of ANCHORS) {
    const body = read('packages/codex-plugin', anchor);
    for (const banned of ['$ARGUMENTS', 'CLAUDE_PLUGIN_ROOT', '/rn-dev-agent:', 'mcp__plugin_']) {
      assert.equal(
        body.includes(banned),
        false,
        `packages/codex-plugin/${anchor} must not contain ${banned}`,
      );
    }
  }
});

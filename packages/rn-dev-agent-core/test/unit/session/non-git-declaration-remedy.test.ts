import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { resolveSourceIdentity } from '../../../dist/session/source-identity.js';
import {
  authorityErrorMeta,
  authorityRemedyNextAction,
  SessionAuthorityError,
} from '../../../dist/session/registry.js';
import { projectPublicAuthorityStatus } from '../../../dist/session/public-status.js';
import { sanitizePublicDiagnostic } from '../../../dist/util/public-diagnostics.js';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function nonGitRoot() {
  const root = mkdtempSync(join(tmpdir(), 'rn-declared-remedy-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}');
  return root;
}

const notGit = () => {
  throw new Error('fatal: not a git repository');
};

function refusal(dependencies) {
  const root = nonGitRoot();
  let captured;
  assert.throws(
    () =>
      resolveSourceIdentity(root, {
        git: notGit,
        canonicalize: (path) => path,
        ...dependencies(root),
      }),
    (error) => {
      captured = error;
      return true;
    },
  );
  return captured.message;
}

test('missing declared root refuses and names the declaration path', () => {
  const message = refusal(() => ({ declaredManifests: ['package.json'] }));

  assert.match(message, /^NON_GIT_MANIFEST_REQUIRED:/);
  assert.match(message, /RN_DEV_AGENT_DECLARED_ROOT is not set/);
  assert.match(message, /exact existing application root/);
  assert.match(message, /RN_DEV_AGENT_DECLARED_MANIFESTS/);
});

test('missing declared manifest list refuses and names the declaration path', () => {
  const message = refusal((root) => ({ declaredRoot: root }));

  assert.match(message, /^NON_GIT_MANIFEST_REQUIRED:/);
  assert.match(message, /RN_DEV_AGENT_DECLARED_MANIFESTS is not set/);
  assert.match(message, /required existing manifest files/);
});

test('a declared manifest that does not exist refuses by name without leaking its path', () => {
  const message = refusal((root) => ({
    declaredRoot: root,
    declaredManifests: ['package.json', 'app.json'],
  }));

  assert.match(message, /^NON_GIT_MANIFEST_REQUIRED:/);
  assert.match(message, /declared manifest "app\.json" does not exist/);
  assert.equal(message.includes(tmpdir()), false);
});

test('a complete declaration still resolves and is never generated for the caller', () => {
  const root = nonGitRoot();
  const identity = resolveSourceIdentity(root, {
    git: notGit,
    canonicalize: (path) => path,
    declaredRoot: root,
    declaredManifests: ['package.json'],
  });

  assert.equal(identity.kind, 'declared-root');
  assert.deepEqual(identity.declaredManifests, ['package.json']);
});

test('authority error metadata names the declaration path instead of another status read', () => {
  const meta = authorityErrorMeta(
    new SessionAuthorityError('NON_GIT_MANIFEST_REQUIRED', 'declaration is incomplete'),
  );

  assert.equal(meta.axis, 'S');
  assert.match(String(meta.nextAction), /RN_DEV_AGENT_DECLARED_ROOT/);
  assert.match(String(meta.nextAction), /RN_DEV_AGENT_DECLARED_MANIFESTS/);
  assert.equal(String(meta.nextAction).includes('action "status"'), false);
});

test('an explicit next action still wins over the code remedy', () => {
  const meta = authorityErrorMeta(
    new SessionAuthorityError('NON_GIT_MANIFEST_REQUIRED', 'declaration is incomplete', undefined, {
      nextAction: 'Do the exact thing this call needs.',
    }),
  );

  assert.equal(meta.nextAction, 'Do the exact thing this call needs.');
});

test('unavailable session status projects the declaration remedy alongside its code', () => {
  const projected = projectPublicAuthorityStatus({
    available: false,
    code: 'NON_GIT_MANIFEST_REQUIRED',
    reason: 'NON_GIT_MANIFEST_REQUIRED: RN_DEV_AGENT_DECLARED_ROOT is not set.',
  });

  assert.equal(projected.available, false);
  assert.equal(projected.code, 'NON_GIT_MANIFEST_REQUIRED');
  assert.equal(projected.nextAction, authorityRemedyNextAction('NON_GIT_MANIFEST_REQUIRED'));
  assert.equal('reason' in projected, false);
});

test('codes without a named remedy keep the bare unavailable projection', () => {
  const projected = projectPublicAuthorityStatus({
    available: false,
    code: 'AUTHORITY_STORE_UNAVAILABLE',
    reason: 'store is unavailable',
  });

  assert.deepEqual(projected, { available: false, code: 'AUTHORITY_STORE_UNAVAILABLE' });
});

test('the declaration remedy survives public-diagnostic redaction intact', () => {
  const remedy = authorityRemedyNextAction('NON_GIT_MANIFEST_REQUIRED');
  const sanitized = sanitizePublicDiagnostic(remedy);

  assert.equal(sanitized, remedy);
  assert.match(sanitized, /RN_DEV_AGENT_DECLARED_ROOT/);
  assert.match(sanitized, /RN_DEV_AGENT_DECLARED_MANIFESTS/);
  assert.equal(sanitized.includes('<local-path>'), false);
});
